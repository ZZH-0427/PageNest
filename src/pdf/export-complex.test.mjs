// @vitest-environment node
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, PDFName } from "pdf-lib";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterEach, describe, expect, it } from "vitest";
import { COMPLEX_CHINESE_TEXT, makeComplexPdf } from "../test/fixtures/synthetic/complex-pdf-fixtures.mjs";
import { createEditState, deleteEditSelection, moveEditPage, rotateEditSelection, selectAllEditPages, selectEditPage } from "./edit";
import { generateEditedPdf } from "./export";
import { validateEditedPdf } from "./export-validation";

const assets = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
const asset = (name) => join(assets, name).replaceAll("\\", "/") + "/";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalize = (value) => ((value % 360) + 360) % 360;
const signal = () => new AbortController().signal;
const openHandles = new Set();

/** Mirrors browser text/pixel hashing. Native Canvas and Node font policy are not browser equivalence. */
async function openPdf(bytes) {
  const task = getDocument({
    data: bytes.slice(), verbosity: 0, stopAtErrors: true, enableXfa: false,
    useWorkerFetch: false, disableFontFace: true, useSystemFonts: false,
    cMapUrl: asset("cmaps"), cMapPacked: true, standardFontDataUrl: asset("standard_fonts"),
    wasmUrl: asset("wasm"), iccUrl: asset("iccs"), canvasMaxAreaInBytes: 16 * 1024 ** 2,
  });
  try {
    const pdf = await task.promise;
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const view = page.getViewport({ scale: 1 });
      pages.push({ number, width: view.width, height: view.height, rotation: normalize(view.rotation),
        orientation: view.width === view.height ? "square" : view.width > view.height ? "landscape" : "portrait" });
      page.cleanup();
    }
    const handle = {
      pages,
      async inspectPage(number, currentSignal, rotationDelta = 0) {
        currentSignal.throwIfAborted();
        const page = await pdf.getPage(number);
        let canvas;
        try {
          const rotation = normalize(page.rotate + rotationDelta);
          const geometry = page.getViewport({ scale: 1, rotation });
          const text = JSON.stringify((await page.getTextContent()).items.filter((item) => "str" in item).map((item) => item.str));
          const viewport = page.getViewport({ scale: Math.min(128 / geometry.width, 128 / geometry.height), rotation });
          canvas = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
          const render = page.render({ canvas, viewport, background: "#ffffff" });
          const cancel = () => render.cancel();
          currentSignal.addEventListener("abort", cancel, { once: true });
          try { await render.promise; } finally { currentSignal.removeEventListener("abort", cancel); }
          currentSignal.throwIfAborted();
          const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
          return { textDigest: sha(text), visualDigest: sha(new Uint8Array(pixels)),
            width: geometry.width, height: geometry.height, rotation };
        } finally { if (canvas) canvas.width = canvas.height = 1; page.cleanup(); }
      },
      async content(number) {
        const page = await pdf.getPage(number);
        try {
          const text = (await page.getTextContent()).items.filter((item) => "str" in item).map((item) => item.str);
          const operations = await page.getOperatorList();
          return { text, view: [...page.view], hasImage: operations.fnArray.includes(OPS.paintImageXObject),
            hasVector: operations.fnArray.includes(OPS.constructPath) };
        } finally { page.cleanup(); }
      },
      async destroy() { openHandles.delete(handle); await task.destroy(); },
    };
    openHandles.add(handle);
    return handle;
  } catch (error) { await task.destroy(); throw error; }
}

afterEach(async () => { await Promise.all([...openHandles].map((handle) => handle.destroy())); });

async function exportSnapshot(bytes, source, state) {
  const before = structuredClone(state);
  const sourceHash = sha(bytes);
  const outputBytes = await generateEditedPdf(bytes, { documentId: "complex", pages: state.present.pages, originalPages: source.pages }, signal());
  const output = await openPdf(outputBytes);
  expect(output.pages).toHaveLength(state.present.pages.length);
  for (const [position, page] of state.present.pages.entries()) {
    const expected = await source.inspectPage(page.sourcePageNumber, signal(), page.rotationDelta);
    const actual = await output.inspectPage(position + 1, signal());
    // Keep independent exact text and native pixel assertions even if production validation evolves.
    expect(actual.textDigest, `Artificial source page ${page.sourcePageNumber} text`).toBe(expected.textDigest);
    expect(actual.visualDigest, `Artificial source page ${page.sourcePageNumber} pixels`).toBe(expected.visualDigest);
    expect(actual.width).toBe(expected.width);
    expect(actual.height).toBe(expected.height);
    expect(actual.rotation).toBe(expected.rotation);
    const content = await output.content(position + 1);
    expect(content.text.join("")).toContain(COMPLEX_CHINESE_TEXT);
    expect(content.text.join("")).toContain(`PAGE ${page.sourcePageNumber}`);
    expect(content.hasImage).toBe(true);
    expect(content.hasVector).toBe(true);
  }
  await validateEditedPdf(source, output, state.present.pages, signal());
  expect(state).toEqual(before);
  expect(sha(bytes)).toBe(sourceHash);
  return output;
}

describe("real complex artificial Chinese table PDF export", () => {
  it("has twelve valid pages, embedded Chinese outlines, images, tables, crop offsets and original rotations", async () => {
    const bytes = makeComplexPdf();
    expect(Buffer.from(bytes).toString("latin1")).toContain("/Subtype /Type3");
    expect(Buffer.from(bytes).toString("latin1")).toContain("/ToUnicode");
    const source = await openPdf(bytes);
    expect(source.pages).toHaveLength(12);
    expect(new Set(source.pages.map((page) => page.rotation))).toEqual(new Set([0, 90, 180, 270]));
    expect(new Set(source.pages.map((page) => page.orientation))).toEqual(new Set(["portrait", "landscape"]));
    for (let page = 1; page <= 12; page++) {
      const content = await source.content(page);
      expect(content.text.join("")).toContain(COMPLEX_CHINESE_TEXT);
      expect(content.text.join("")).toContain(`PAGE ${page}`);
      expect(content.hasImage).toBe(true);
      expect(content.hasVector).toBe(true);
      expect(content.view.slice(0, 2)).toEqual([30, 35]);
      expect((await source.inspectPage(page, signal())).visualDigest).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it.each([false, true])("directly exports every complex page with CropBox enabled=%s", async (crop) => {
    const bytes = makeComplexPdf({ crop });
    const source = await openPdf(bytes);
    await exportSnapshot(bytes, source, createEditState("complex", source.pages));
  });

  it.each([false, true])("exports deleted, reordered and rotated complex pages with CropBox enabled=%s", async (crop) => {
    const bytes = makeComplexPdf({ crop });
    const source = await openPdf(bytes);
    let state = createEditState("complex", source.pages);
    state = selectEditPage(state, state.present.pages[1].id);
    state = selectEditPage(state, state.present.pages[7].id, { toggle: true });
    state = deleteEditSelection(state);
    state = moveEditPage(state, state.present.pages.at(-1).id, 0);
    state = rotateEditSelection(selectAllEditPages(state), 90);
    expect(state.present.pages.map((page) => page.sourcePageNumber)).toEqual([12, 1, 3, 4, 5, 6, 7, 9, 10, 11]);
    await exportSnapshot(bytes, source, state);
  });

  it.each(["chinese", "images", "table"])("rejects an equal-count complex file with missing %s content", async (missing) => {
    const source = await openPdf(makeComplexPdf());
    const damaged = await openPdf(makeComplexPdf({ [missing]: false }));
    expect(damaged.pages).toEqual(source.pages);
    await expect(validateEditedPdf(source, damaged, createEditState("complex", source.pages).present.pages, signal())).rejects.toThrow();
  });

  it("rejects an incorrect order even when page geometry and original rotation match", async () => {
    const bytes = makeComplexPdf();
    const source = await openPdf(bytes);
    const initial = createEditState("complex", source.pages);
    const swapped = [...initial.present.pages];
    [swapped[0], swapped[8]] = [swapped[8], swapped[0]];
    const output = await openPdf(await generateEditedPdf(bytes, { documentId: "complex", pages: swapped, originalPages: source.pages }, signal()));
    expect(output.pages).toEqual(source.pages);
    await expect(validateEditedPdf(source, output, initial.present.pages, signal())).rejects.toThrow();
  });

  it("preserves hidden optional-content layers when exporting the complex document", async () => {
    const bytes = makeComplexPdf({ hiddenLayer: true });
    const source = await openPdf(bytes);
    await exportSnapshot(bytes, source, createEditState("complex", source.pages));
  });

  it("rejects a document whose deliberately removed optional-content configuration changes actual pixels", async () => {
    const bytes = makeComplexPdf({ hiddenLayer: true });
    const source = await openPdf(bytes);
    const state = createEditState("complex", source.pages);
    const generated = await generateEditedPdf(bytes, { documentId: "complex", pages: state.present.pages, originalPages: source.pages }, signal());
    const altered = await PDFDocument.load(generated, { updateMetadata: false });
    altered.catalog.delete(PDFName.of("OCProperties"));
    const output = await openPdf(await altered.save({ updateFieldAppearances: false }));
    expect(output.pages).toEqual(source.pages);
    const before = await source.inspectPage(1, signal());
    const after = await output.inspectPage(1, signal());
    expect(after.textDigest).toBe(before.textDigest);
    expect(after.visualDigest).not.toBe(before.visualDigest);
    await expect(validateEditedPdf(source, output, state.present.pages, signal())).rejects.toThrow();
  });
});
