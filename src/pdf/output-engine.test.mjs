// @vitest-environment node
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import * as library from "pdf-lib";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeOutputPdf } from "../test/fixtures/synthetic/output-fixtures.mjs";
import { makeCrossRefSelectionPdf } from "../test/fixtures/synthetic/copy-compatibility-fixtures.mjs";
import { createEditState, deleteEditSelection, moveEditPage, redoEdit, rotateEditSelection, selectEditPage, undoEdit } from "./edit";
import { generatePlannedPdf, validatePlannedPdf } from "./output-engine";

const assetRoot = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
const asset = (name) => join(assetRoot, name).replaceAll("\\", "/") + "/";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const signal = () => new AbortController().signal;
const tasks = new Set();
async function open(bytes) {
  const task = getDocument({ data: bytes.slice(), verbosity: 0, stopAtErrors: true, enableXfa: false,
    useWorkerFetch: false, standardFontDataUrl: asset("standard_fonts"), cMapUrl: asset("cmaps"), cMapPacked: true,
    wasmUrl: asset("wasm"), iccUrl: asset("iccs") });
  tasks.add(task);
  const pdf = await task.promise;
  const pages = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number), view = page.getViewport({ scale: 1 });
    pages.push({ number, width: view.width, height: view.height, rotation: view.rotation,
      orientation: view.width === view.height ? "square" : view.width > view.height ? "landscape" : "portrait" });
    page.cleanup();
  }
  return { pages,
    async inspectPage(number, currentSignal, delta = 0) {
      currentSignal.throwIfAborted();
      const page = await pdf.getPage(number);
      let canvas;
      try {
        const rotation = ((page.rotate + delta) % 360 + 360) % 360;
        const geometry = page.getViewport({ scale: 1, rotation });
        const text = (await page.getTextContent()).items.filter((item) => "str" in item).map((item) => item.str);
        const viewport = page.getViewport({ scale: Math.min(128 / geometry.width, 128 / geometry.height), rotation });
        canvas = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
        const render = page.render({ canvas, viewport, background: "#ffffff" });
        const cancel = () => render.cancel();
        currentSignal.addEventListener("abort", cancel, { once: true });
        try { await render.promise; } finally { currentSignal.removeEventListener("abort", cancel); }
        currentSignal.throwIfAborted();
        const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        return { width: geometry.width, height: geometry.height, rotation, textDigest: sha(JSON.stringify(text)), visualDigest: sha(pixels) };
      } finally { if (canvas) canvas.width = canvas.height = 1; page.cleanup(); }
    },
    async content(number) {
      const page = await pdf.getPage(number);
      try {
        const text = (await page.getTextContent()).items.filter((item) => "str" in item).map((item) => item.str).join(" ");
        const operators = await page.getOperatorList();
        return { text, image: operators.fnArray.includes(OPS.paintImageXObject), vector: operators.fnArray.includes(OPS.constructPath) };
      } finally { page.cleanup(); }
    },
    async render() { throw new Error("Real validation must use inspectPage"); },
    async destroy() { tasks.delete(task); await task.destroy(); },
  };
}
afterEach(async () => { await Promise.all([...tasks].map((task) => task.destroy())); tasks.clear(); });

async function source(documentId, options = {}) {
  const bytes = await makeOutputPdf(options), handle = await open(bytes);
  const state = createEditState(documentId, handle.pages);
  return { input: { documentId, bytes, originalPages: handle.pages }, handle, pages: state.present.pages, state };
}
const definition = (pages) => ({ id: "synthetic-output", fileName: "same-name.pdf", rangeLabel: "人工计划", pages });
async function generate(sources, pages) {
  const bytes = await generatePlannedPdf(sources.map((item) => item.input), definition(pages), signal());
  const output = await open(bytes);
  await validatePlannedPdf(new Map(sources.map((item) => [item.input.documentId, item.handle])), output, pages, signal());
  for (const [index, page] of pages.entries()) {
    const original = sources.find((item) => item.input.documentId === page.sourceDocumentId);
    expect(await output.inspectPage(index + 1, signal())).toEqual(await original.handle.inspectPage(page.sourcePageNumber, signal(), page.rotationDelta));
  }
  return { bytes, output };
}

describe("real selected-page and split output generation", () => {
  it.each([[0], [0, 1], [0, 2], [0, 1, 2]].map((indices) => ({ indices })))("exports retained selection $indices through the stable single-source path", async ({ indices }) => {
    const a = await source("a", { label: "SOURCE A" });
    const hash = sha(a.input.bytes), before = structuredClone(a.state);
    await generate([a], indices.map((index) => a.pages[index]));
    expect(sha(a.input.bytes)).toBe(hash); expect(a.state).toEqual(before);
  });

  it("follows deleted/reordered/rotated undo-redo state rather than source number", async () => {
    const a = await source("a", { count: 5 });
    let state = moveEditPage(a.state, a.pages[4].id, 0);
    state = selectEditPage(state, a.pages[1].id);
    state = deleteEditSelection(state);
    state = selectEditPage(state, a.pages[4].id);
    state = rotateEditSelection(state, 90);
    state = redoEdit(undoEdit(state));
    const selected = state.present.pages.filter((page) => [a.pages[4].id, a.pages[2].id].includes(page.id));
    expect(selected.map((page) => page.sourcePageNumber)).toEqual([5, 3]);
    const before = structuredClone(state);
    await generate([a], selected);
    expect(state).toEqual(before);
  });

  it("independently reopens all split results from a reordered twelve-page source", async () => {
    const a = await source("a", { count: 12 });
    const pages = [...a.pages].reverse().map((page, index) => ({ ...page, rotationDelta: index % 2 ? 90 : 0 }));
    const ranges = [pages.slice(0, 3), pages.slice(3, 7), pages.slice(7)];
    for (const range of ranges) await generate([a], range);
    expect(ranges.map((range) => range.length)).toEqual([3, 4, 5]);
  });

  it("independently reopens every five-page chunk and the final four pages of a 24-page PDF", async () => {
    const a = await source("a", { count: 24 });
    const sizes = [];
    for (let index = 0; index < a.pages.length; index += 5) {
      const pages = a.pages.slice(index, index + 5);
      sizes.push(pages.length); await generate([a], pages);
    }
    expect(sizes).toEqual([5, 5, 5, 5, 4]);
  });
});

describe("real multi-source PDF generation and strict independent validation", () => {
  it.each([2, 3])("merges %i sources by source IDs, edited order and absolute rotations", async (count) => {
    const sources = await Promise.all(Array.from({ length: count }, (_, index) => source(`doc-${index}`, {
      label: `SOURCE ${index + 1}`, count: index + 2, rotation: index * 90, wide: index === 1, palette: index === 1 ? "orange" : "blue",
      inherited: true, crop: true,
    })));
    const originalHashes = sources.map((item) => sha(item.input.bytes));
    const pages = sources.toReversed().flatMap((item) => item.pages.toReversed().slice(0, -1).map((page) => ({ ...page, rotationDelta: 90 })));
    const result = await generate(sources, pages);
    expect(sources.map((item) => sha(item.input.bytes))).toEqual(originalHashes);
    for (const [index, page] of pages.entries()) {
      const content = await result.output.content(index + 1);
      expect(content.text).toContain(`SOURCE ${Number(page.sourceDocumentId.slice(4)) + 1}`);
      expect(content.text).toContain(`PAGE ${page.sourcePageNumber}`);
      expect(content.image).toBe(true); expect(content.vector).toBe(true);
    }
  });

  it("supports interleaved same-named sources without confusing page one or shared font names", async () => {
    const a = await source("different-id-a", { label: "SOURCE A", count: 3 });
    const b = await source("different-id-b", { label: "SOURCE B", count: 2, palette: "orange" });
    a.input.fileName = b.input.fileName = "same-name.pdf";
    await generate([a, b], [a.pages[2], b.pages[1], a.pages[0], b.pages[0]]);
  });

  it.each([["off", "on"], ["base-off-on", "off"], ["off", "none"]].map((modes) => ({ modes })))("preserves distinct same-named OCG refs and default state $modes", async ({ modes }) => {
    const a = await source("a", { label: "SOURCE A", layer: modes[0], inherited: true });
    const b = await source("b", { label: "SOURCE B", layer: modes[1], inherited: true });
    const { bytes } = await generate([a, b], [b.pages[1], a.pages[2], a.pages[0], b.pages[0]]);
    const output = await library.PDFDocument.load(bytes, { updateMetadata: false });
    const properties = output.catalog.lookup(library.PDFName.of("OCProperties"), library.PDFDict);
    const groups = properties.lookup(library.PDFName.of("OCGs"), library.PDFArray).asArray();
    expect(groups.length).toBe(modes.filter((mode) => mode !== "none").length);
    expect(new Set(groups.map(String)).size).toBe(groups.length);
  });

  it.each(["wrong-source", "wrong-order", "text", "images", "vectors", "geometry", "rotation", "layers"])("rejects real %s damage at its global output position", async (kind) => {
    const a = await source("a", { label: "SOURCE A", layer: "off" });
    const b = await source("b", { label: "SOURCE B", layer: "off", palette: "orange" });
    const pages = [a.pages[0], b.pages[0]];
    let bytes;
    if (["text", "images", "vectors"].includes(kind)) {
      const damagedB = await source("b", { label: "SOURCE B", layer: "off", palette: "orange", [kind]: false });
      bytes = await generatePlannedPdf([a.input, damagedB.input], definition(pages), signal());
    } else if (kind === "wrong-source") {
      const c = await source("c", { label: "SOURCE C", layer: "off", count: 1 });
      expect(c.handle.pages[0]).toEqual(b.handle.pages[0]);
      bytes = await generatePlannedPdf([a.input, c.input], definition([a.pages[0], c.pages[0]]), signal());
    } else if (kind === "wrong-order") {
      bytes = await generatePlannedPdf([a.input, b.input], definition([b.pages[0], a.pages[0]]), signal());
    } else {
      bytes = await generatePlannedPdf([a.input, b.input], definition(pages), signal());
      const altered = await library.PDFDocument.load(bytes, { updateMetadata: false });
      if (kind === "geometry") altered.getPage(1).setCropBox(0, 0, 350, 400);
      if (kind === "rotation") altered.getPage(1).setRotation(library.degrees(90));
      if (kind === "layers") altered.catalog.delete(library.PDFName.of("OCProperties"));
      bytes = await altered.save({ updateFieldAppearances: false });
    }
    const output = await open(bytes);
    await expect(validatePlannedPdf(new Map([["a", a.handle], ["b", b.handle]]), output, pages, signal())).rejects.toMatchObject({
      code: ["wrong-source", "wrong-order", "text"].includes(kind) ? "TEXT_CONTENT_MISMATCH"
        : kind === "geometry" ? "PAGE_GEOMETRY_MISMATCH" : kind === "rotation" ? "PAGE_ROTATION_MISMATCH" : "VISUAL_CONTENT_MISMATCH",
      diagnostic: { outputPage: ["wrong-order", "layers"].includes(kind) ? 1 : 2 },
    });
  });

  it("keeps the cross-parser subtle-color negative strict in a multi-source output", async () => {
    const badBytes = makeCrossRefSelectionPdf(), badHandle = await open(badBytes);
    const bad = { input: { documentId: "xref", bytes: badBytes, originalPages: badHandle.pages }, handle: badHandle,
      pages: createEditState("xref", badHandle.pages).present.pages };
    const good = await source("good", { count: 1 });
    const pages = [good.pages[0], bad.pages[0]];
    const bytes = await generatePlannedPdf([good.input, bad.input], definition(pages), signal());
    await expect(validatePlannedPdf(new Map([["good", good.handle], ["xref", bad.handle]]), await open(bytes), pages, signal()))
      .rejects.toMatchObject({ code: "VISUAL_CONTENT_MISMATCH", diagnostic: { outputPage: 2, sourcePage: 1 } });
  });

  it.each(["Configs", "AS", "Usage", "RBGroups", "Intent", "cycle", "unknown-group"])("rejects unsupported layer configuration %s explicitly", async (kind) => {
    const a = await source("a", { layer: "off", count: 1 }), b = await source("b", { count: 1 });
    const doc = await library.PDFDocument.load(a.input.bytes, { updateMetadata: false });
    const name = library.PDFName.of;
    const properties = doc.catalog.lookup(name("OCProperties"), library.PDFDict);
    const config = properties.lookup(name("D"), library.PDFDict);
    if (kind === "Configs") properties.set(name(kind), doc.context.obj([]));
    else if (kind === "Usage" || kind === "Intent") {
      const group = properties.lookup(name("OCGs"), library.PDFArray).lookup(0, library.PDFDict);
      group.set(name(kind), doc.context.obj(kind === "Usage" ? { View: { ViewState: "OFF" } } : "Design"));
    } else if (kind === "cycle") {
      const array = doc.context.obj([]), ref = doc.context.register(array);
      array.push(ref); config.set(name("Order"), ref);
    } else if (kind === "unknown-group") config.set(name("OFF"), doc.context.obj([doc.context.register(doc.context.obj({ Type: "OCG", Name: library.PDFString.of("Artificial unknown") }))]));
    else config.set(name(kind), doc.context.obj([]));
    a.input.bytes = await doc.save({ updateFieldAppearances: false });
    await expect(generatePlannedPdf([a.input, b.input], definition([a.pages[0], b.pages[0]]), signal())).rejects.toThrow("复杂 PDF 图层配置");
  });

  it.each(["empty", "source-id", "duplicate-page", "duplicate-id", "source-number", "rotation", "duplicate-source", "unused-source"])("rejects invalid plan %s before a successful result", async (kind) => {
    const a = await source("a", { count: 1 }), b = await source("b", { count: 1 });
    let inputs = [a.input, b.input], pages = [a.pages[0], b.pages[0]];
    if (kind === "empty") pages = [];
    if (kind === "source-id") pages[1] = { ...pages[1], sourceDocumentId: "absent" };
    if (kind === "duplicate-page") pages.push({ ...pages[0], id: "another" });
    if (kind === "duplicate-id") pages[1] = { ...pages[1], id: pages[0].id };
    if (kind === "source-number") pages[1] = { ...pages[1], sourcePageNumber: 2 };
    if (kind === "rotation") pages[1] = { ...pages[1], rotationDelta: 45 };
    if (kind === "duplicate-source") inputs = [a.input, a.input];
    if (kind === "unused-source") pages = [a.pages[0]];
    await expect(generatePlannedPdf(inputs, definition(pages), signal())).rejects.toThrow();
  });

  it("does not convert cancellation or inspector failure into successful validation", async () => {
    const a = await source("a", { count: 1 }), b = await source("b", { count: 1 });
    const pages = [a.pages[0], b.pages[0]], { output } = await generate([a, b], pages);
    const cancelled = new AbortController(); cancelled.abort();
    await expect(generatePlannedPdf([a.input, b.input], definition(pages), cancelled.signal)).rejects.toHaveProperty("name", "AbortError");
    await expect(validatePlannedPdf(new Map([["a", a.handle], ["b", b.handle]]), output, pages, cancelled.signal)).rejects.toHaveProperty("name", "AbortError");
    const failed = { ...b.handle, inspectPage: async () => { throw new Error("ARTIFICIAL PRIVATE MARKER"); } };
    await expect(validatePlannedPdf(new Map([["a", a.handle], ["b", failed]]), output, pages, signal())).rejects.toMatchObject({
      code: "INSPECTION_FAILURE", diagnostic: { outputPage: 2, sourcePage: 1 },
    });
    try { await validatePlannedPdf(new Map([["a", a.handle], ["b", failed]]), output, pages, signal()); }
    catch (error) { expect(error.message).not.toContain("ARTIFICIAL PRIVATE MARKER"); }
  });

  it("erases owned serialized bytes when cancellation arrives as real multi-source saving finishes", async () => {
    const a = await source("a", { count: 1 }), b = await source("b", { count: 1 });
    const originals = [sha(a.input.bytes), sha(b.input.bytes)];
    const controller = new AbortController();
    const save = library.PDFDocument.prototype.save;
    let saved;
    const spy = vi.spyOn(library.PDFDocument.prototype, "save").mockImplementation(async function (options) {
      saved = await save.call(this, options);
      controller.abort();
      return saved;
    });
    try {
      await expect(generatePlannedPdf([a.input, b.input], definition([a.pages[0], b.pages[0]]), controller.signal))
        .rejects.toHaveProperty("name", "AbortError");
      expect(saved.byteLength).toBeGreaterThan(0);
      expect(saved.every((value) => value === 0)).toBe(true);
      expect([sha(a.input.bytes), sha(b.input.bytes)]).toEqual(originals);
    } finally { spy.mockRestore(); }
  });

  it("uses its captured plan if caller-owned page records change while source parsing awaits", async () => {
    const a = await source("a", { count: 1 }), b = await source("b", { count: 1 });
    const pages = [a.pages[0], b.pages[0]].map((page) => ({ ...page }));
    const expected = structuredClone(pages);
    const load = library.PDFDocument.load;
    let changed = false;
    const spy = vi.spyOn(library.PDFDocument, "load").mockImplementation(async function (...args) {
      const result = await load.apply(this, args);
      if (!changed) { pages.reverse(); pages[0].rotationDelta = 180; changed = true; }
      return result;
    });
    let bytes;
    try { bytes = await generatePlannedPdf([a.input, b.input], definition(pages), signal()); }
    finally { spy.mockRestore(); }
    expect(changed).toBe(true);
    await validatePlannedPdf(new Map([["a", a.handle], ["b", b.handle]]), await open(bytes), expected, signal());
  });

  it("rejects an actual output with the wrong page count before per-page inspection", async () => {
    const a = await source("a", { count: 1 }), b = await source("b", { count: 1 });
    const bytes = await generatePlannedPdf([a.input], definition(a.pages), signal());
    await expect(validatePlannedPdf(new Map([["a", a.handle], ["b", b.handle]]), await open(bytes), [...a.pages, ...b.pages], signal()))
      .rejects.toMatchObject({ code: "PAGE_COUNT_MISMATCH" });
  });
});
