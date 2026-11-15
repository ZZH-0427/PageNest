// @vitest-environment node
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import * as library from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterEach, describe, expect, it } from "vitest";
import { makeCopyCompatibilityPdf, makeCrossRefSelectionPdf } from "../test/fixtures/synthetic/copy-compatibility-fixtures.mjs";
import { createEditState } from "./edit";
import { generateEditedPdf } from "./export";
import { copyEditedPages } from "./export-copy";
import { validateEditedPdf } from "./export-validation";

const assetRoot = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
const asset = (name) => join(assetRoot, name).replaceAll("\\", "/") + "/";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const signal = () => new AbortController().signal;
const tasks = new Set();
async function open(bytes, keepSample = false) {
  const task = getDocument({ data: bytes.slice(), verbosity: 0, stopAtErrors: true, useWorkerFetch: false,
    cMapUrl: asset("cmaps"), cMapPacked: true, standardFontDataUrl: asset("standard_fonts"), wasmUrl: asset("wasm") });
  tasks.add(task);
  const pdf = await task.promise;
  const pages = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number);
    const { width, height, rotation } = page.getViewport({ scale: 1 });
    pages.push({ number, width, height, rotation, orientation: width === height ? "square" : width > height ? "landscape" : "portrait" });
    page.cleanup();
  }
  return { pages, async inspectPage(number, inspectSignal, delta = 0) {
    inspectSignal.throwIfAborted();
    const page = await pdf.getPage(number);
    let canvas;
    try {
      const rotation = ((page.rotate + delta) % 360 + 360) % 360;
      const geometry = page.getViewport({ scale: 1, rotation });
      const text = (await page.getTextContent()).items.filter((item) => "str" in item).map((item) => item.str);
      const viewport = page.getViewport({ scale: Math.min(128 / geometry.width, 128 / geometry.height), rotation });
      canvas = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
      await page.render({ canvas, viewport, background: "#ffffff" }).promise;
      inspectSignal.throwIfAborted();
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      return { width: geometry.width, height: geometry.height, rotation, textDigest: digest(JSON.stringify(text)),
        visualDigest: digest(pixels), ...(keepSample ? { visualSample: { width: canvas.width, height: canvas.height, pixels: new Uint8Array(pixels) } } : {}) };
    } finally { if (canvas) canvas.width = canvas.height = 1; page.cleanup(); }
  } };
}
afterEach(async () => { await Promise.all([...tasks].map((task) => task.destroy())); tasks.clear(); });
async function exported(kind) {
  const bytes = await makeCopyCompatibilityPdf(kind);
  const beforeHash = digest(bytes);
  const source = await open(bytes);
  const initial = createEditState("artificial", source.pages);
  // Delete the middle page, reverse the remaining pages, then rotate both.
  const pages = [initial.present.pages[2], initial.present.pages[0]].map((page) => ({ ...page, rotationDelta: 90 }));
  const result = await generateEditedPdf(bytes, { documentId: "artificial", originalPages: source.pages, pages }, signal());
  expect(digest(bytes)).toBe(beforeHash);
  const output = await open(result);
  expect(output.pages).toHaveLength(2);
  await validateEditedPdf(source, output, pages, signal());
  return { source, output, pages, result };
}

describe("copying independently verified PDF page display dependencies", () => {
  it.each(["hidden-layer", "partial-resources", "closest-resources", "inherited-geometry"])(
    "preserves exact text, pixels and geometry after edits for %s", async (kind) => { await exported(kind); });

  it("shares OCG identities and fonts across the copied pages and the catalog", async () => {
    const { result } = await exported("hidden-layer");
    const output = await library.PDFDocument.load(result);
    const props = output.catalog.lookup(library.PDFName.of("OCProperties"), library.PDFDict);
    const group = props.lookup(library.PDFName.of("OCGs"), library.PDFArray).get(0);
    const refs = output.getPages().map((page) => page.node.Resources().lookup(library.PDFName.of("Properties"), library.PDFDict).get(library.PDFName.of("Hidden")));
    expect(refs.map(String)).toEqual([String(group), String(group)]);
    const fonts = output.getPages().map((page) => page.node.Resources().lookup(library.PDFName.Font, library.PDFDict).get(library.PDFName.of("F1")));
    expect(String(fonts[0])).toBe(String(fonts[1]));
    expect(output.catalog.has(library.PDFName.of("AcroForm"))).toBe(false);
  });

  it("does not merge a parent's missing font entries into an existing nearest Font category", async () => {
    const { result } = await exported("closest-resources");
    const output = await library.PDFDocument.load(result);
    for (const page of output.getPages()) {
      const fonts = page.node.Resources().lookup(library.PDFName.Font, library.PDFDict);
      expect(fonts.has(library.PDFName.of("UnusedParentFont"))).toBe(false);
    }
  });

  it("still rejects missing hidden-layer configuration although text and page geometry match", async () => {
    const { source, output, pages, result } = await exported("hidden-layer");
    const damaged = await library.PDFDocument.load(result);
    damaged.catalog.delete(library.PDFName.of("OCProperties"));
    const broken = await open(await damaged.save());
    expect(broken.pages).toEqual(output.pages);
    const expected = await source.inspectPage(3, signal(), 90);
    const actual = await broken.inspectPage(1, signal());
    expect(actual.textDigest).toBe(expected.textDigest);
    expect(actual.visualDigest).not.toBe(expected.visualDigest);
    await expect(validateEditedPdf(source, broken, pages, signal())).rejects.toThrow();
  });

  it("still rejects removed inherited fonts, without treating it as rasterization tolerance", async () => {
    const { source, output, pages, result } = await exported("partial-resources");
    const damaged = await library.PDFDocument.load(result);
    for (const page of damaged.getPages()) page.node.Resources().delete(library.PDFName.Font);
    const broken = await open(await damaged.save());
    expect(broken.pages).toEqual(output.pages);
    const expected = await source.inspectPage(3, signal(), 90);
    const actual = await broken.inspectPage(1, signal());
    expect(actual.textDigest).not.toBe(expected.textDigest);
    expect(actual.visualDigest).not.toBe(expected.visualDigest);
    await expect(validateEditedPdf(source, broken, pages, signal())).rejects.toThrow();
  });

  it("keeps the source dictionaries immutable and copies only the OCProperties catalog key", async () => {
    const source = await library.PDFDocument.load(await makeCopyCompatibilityPdf("partial-resources"));
    source.catalog.set(library.PDFName.of("PageNestPrivateTest"), library.PDFString.of("Artificial discarded catalog value"));
    const before = source.context.enumerateIndirectObjects().map(([ref, value]) => [String(ref), String(value)]);
    const output = await library.PDFDocument.create({ updateMetadata: false });
    const copied = await copyEditedPages(source, output, [2, 0], library, signal());
    copied.forEach((page) => output.addPage(page));
    expect(source.context.enumerateIndirectObjects().map(([ref, value]) => [String(ref), String(value)])).toEqual(before);
    expect(output.getPageCount()).toBe(2);
    expect(output.catalog.has(library.PDFName.of("PageNestPrivateTest"))).toBe(false);
  });

  it("rejects subtle cross-parser xref content loss even when all pdf-lib graph evidence is true", async () => {
    const bytes = makeCrossRefSelectionPdf();
    const source = await open(bytes, true);
    const state = createEditState("artificial", source.pages);
    let integrity;
    const outputBytes = await generateEditedPdf(bytes, {
      documentId: "artificial", originalPages: source.pages, pages: state.present.pages,
    }, signal(), (evidence) => { integrity = evidence; });
    expect(integrity).toEqual([{ contentsEqual: true, resourcesEqual: true, pageAttributesEqual: true,
      annotationsEqual: true, displayContextEqual: true, complete: true }]);
    const output = await open(outputBytes, true);
    expect(output.pages).toEqual(source.pages);
    const before = await source.inspectPage(1, signal());
    const after = await output.inspectPage(1, signal());
    try {
      expect(before.textDigest).toBe(after.textDigest);
      expect(before.visualDigest).not.toBe(after.visualDigest);
      let maximumChannelDelta = 0, changedChannels = 0;
      for (const [index, value] of before.visualSample.pixels.entries()) {
        const difference = Math.abs(value - after.visualSample.pixels[index]);
        if (difference) changedChannels++;
        maximumChannelDelta = Math.max(maximumChannelDelta, difference);
      }
      expect(changedChannels).toBeGreaterThan(0);
      expect(maximumChannelDelta).toBe(5);
    } finally { before.visualSample.pixels.fill(0); after.visualSample.pixels.fill(0); }
    // Graph evidence alone is not equivalent to the original PDF.js interpretation.
    await expect(validateEditedPdf(source, output, state.present.pages, signal(), integrity))
      .rejects.toMatchObject({ code: "VISUAL_CONTENT_MISMATCH" });
  });
  it.each(["cycle", "depth"])("fails closed on %s in the page parent hierarchy", async (kind) => {
    const source = await library.PDFDocument.create();
    const page = source.addPage();
    if (kind === "cycle") page.node.set(library.PDFName.Parent, page.node);
    else {
      let parent = page.node;
      for (let count = 0; count < 65; count++) {
        const next = library.PDFDict.withContext(source.context);
        parent.set(library.PDFName.Parent, next);
        parent = next;
      }
    }
    const output = await library.PDFDocument.create();
    await expect(copyEditedPages(source, output, [0], library, signal())).rejects.toThrow("Unsupported PDF page ancestry");
  });
});
