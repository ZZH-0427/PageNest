// @vitest-environment node
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExportFixtures, exportMixedPages, makeExportPdf } from "../test/fixtures/synthetic/pdf-export-fixtures.mjs";
import {
  createEditState, deleteEditSelection, moveEditPage, redoEdit, rotateEditSelection,
  selectAllEditPages, selectEditPage, undoEdit,
} from "./edit";
import { generateEditedPdf } from "./export";
import { validateEditedPdf } from "./export-validation";

const assetRoot = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
const asset = (name) => join(assetRoot, name).replaceAll("\\", "/") + "/";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalize = (rotation) => ((rotation % 360) + 360) % 360;
const liveHandles = new Set();
const signal = () => new AbortController().signal;

/** An independent Node PDF.js adapter: real page proxies, text and native canvas. */
async function openPdf(bytes) {
  const task = getDocument({
    data: bytes.slice(), verbosity: 0, useWorkerFetch: false,
    cMapUrl: asset("cmaps"), cMapPacked: true,
    standardFontDataUrl: asset("standard_fonts"), wasmUrl: asset("wasm"),
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
      inspections: [],
      async inspectPage(number, abortSignal, rotationDelta = 0) {
        abortSignal.throwIfAborted();
        const page = await pdf.getPage(number);
        let canvas;
        let render;
        const cancel = () => render?.cancel();
        abortSignal.addEventListener("abort", cancel, { once: true });
        try {
          abortSignal.throwIfAborted();
          const rotation = normalize(page.rotate + rotationDelta);
          const geometry = page.getViewport({ scale: 1, rotation });
          const content = await page.getTextContent();
          const text = content.items.filter((item) => "str" in item).map((item) => item.str);
          const viewport = page.getViewport({ scale: Math.min(128 / geometry.width, 128 / geometry.height), rotation });
          canvas = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
          abortSignal.throwIfAborted();
          render = page.render({ canvas, viewport, background: "#ffffff" });
          await render.promise;
          abortSignal.throwIfAborted();
          handle.inspections.push({ number, rotationDelta });
          return { textDigest: digest(JSON.stringify(text)),
            visualDigest: digest(canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data),
            width: geometry.width, height: geometry.height, rotation };
        } finally {
          abortSignal.removeEventListener("abort", cancel);
          if (canvas) canvas.width = canvas.height = 1;
          page.cleanup();
        }
      },
      async content(number) {
        const page = await pdf.getPage(number);
        try {
          const text = (await page.getTextContent()).items.filter((item) => "str" in item).map((item) => item.str);
          const operations = await page.getOperatorList();
          return { text, hasImage: operations.fnArray.includes(OPS.paintImageXObject),
            hasVector: operations.fnArray.includes(OPS.constructPath) };
        } finally { page.cleanup(); }
      },
      async destroy() {
        liveHandles.delete(handle);
        await task.destroy();
        expect(task.destroyed).toBe(true);
      },
    };
    liveHandles.add(handle);
    return handle;
  } catch (error) {
    await task.destroy();
    throw error;
  }
}

afterEach(async () => {
  await Promise.all([...liveHandles].map((handle) => handle.destroy()));
});

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

async function exportAndValidate(bytes, source, state, documentId = "document-a", options = {}) {
  const sourceHash = digest(bytes);
  const preservedState = structuredClone(state);
  const preservedMetadata = structuredClone(source.pages);
  freeze(state);
  const outputBytes = await generateEditedPdf(bytes, {
    documentId, pages: state.present.pages, originalPages: source.pages,
  }, signal());
  expect(new TextDecoder().decode(outputBytes.subarray(0, 5))).toBe("%PDF-");
  const output = await openPdf(outputBytes);
  try {
    expect(output.pages).toHaveLength(state.present.pages.length);
    const observationsBefore = source.inspections.length;
    await validateEditedPdf(source, output, state.present.pages, signal());
    // Every surviving source/output page is actually rendered; no metadata-only fast path.
    expect(source.inspections.length - observationsBefore).toBe(state.present.pages.length);
    expect(output.inspections).toHaveLength(state.present.pages.length);
    for (const [index, editedPage] of state.present.pages.entries()) {
      const content = await output.content(index + 1);
      if (options.text !== false) expect(content.text).toContain(`PAGE ${editedPage.sourcePageNumber}`);
      if (options.images !== false) expect(content.hasImage).toBe(true);
      if (options.vectors !== false) expect(content.hasVector).toBe(true);
      const sourcePage = source.pages[editedPage.sourcePageNumber - 1];
      const swap = normalize(editedPage.rotationDelta) % 180 !== 0;
      expect(output.pages[index]).toMatchObject({
        width: swap ? sourcePage.height : sourcePage.width,
        height: swap ? sourcePage.width : sourcePage.height,
        rotation: normalize(sourcePage.rotation + editedPage.rotationDelta),
      });
    }
    expect(digest(bytes)).toBe(sourceHash);
    expect(state).toEqual(preservedState);
    expect(source.pages).toEqual(preservedMetadata);
    return outputBytes;
  } finally { await output.destroy(); }
}

describe("real edited PDF export and independent content validation", () => {
  it.each(createExportFixtures().filter((fixture) => !["export-rotations.pdf", "export-orange.pdf"].includes(fixture.name)))(
    "exports every text, image and vector page in $name ($pages pages)", async ({ bytes, pages }) => {
      const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        throw new Error("Unexpected document network request during PDF export");
      });
      const source = await openPdf(bytes);
      const state = createEditState("document-a", source.pages);
      expect(source.pages).toHaveLength(pages);
      await exportAndValidate(bytes, source, state);
      expect(network).not.toHaveBeenCalled();
    }, 30_000);

  it.each([-90, 90, 180, 270])("composes original 0/90/180/270 rotations with delta %i", async (delta) => {
    const bytes = makeExportPdf({ pages: [0, 90, 180, 270].map((rotate) => ({ width: 420, height: 594, rotate })) });
    const source = await openPdf(bytes);
    let state = selectAllEditPages(createEditState("document-a", source.pages));
    for (let step = 0; step < Math.abs(delta) / 90; step++) state = rotateEditSelection(state, delta < 0 ? -90 : 90);
    await exportAndValidate(bytes, source, state);
  });

  it("exports repeated rotations, wraparound and another edit after successful export", async () => {
    const bytes = makeExportPdf({ pages: exportMixedPages });
    const source = await openPdf(bytes);
    let state = createEditState("document-a", source.pages);
    state = selectEditPage(state, state.present.pages[2].id);
    for (let turn = 0; turn < 3; turn++) state = rotateEditSelection(state, -90);
    expect(state.present.pages[2].rotationDelta).toBe(90);
    await exportAndValidate(bytes, source, state);
    state = rotateEditSelection(state, -90);
    expect(state.present.pages[2].rotationDelta).toBe(0);
    state = moveEditPage(state, state.present.pages[2].id, 0);
    await exportAndValidate(bytes, source, state);
  });

  it("exports deletion, reorder and rotation snapshots before and after undo/redo", async () => {
    const bytes = makeExportPdf({ pages: Array.from({ length: 5 }, (_, index) => exportMixedPages[index % 3]) });
    const source = await openPdf(bytes);
    const original = createEditState("document-a", source.pages);
    let state = selectEditPage(original, original.present.pages[1].id);
    state = selectEditPage(state, original.present.pages[3].id, { toggle: true });
    state = deleteEditSelection(state);
    expect(state.present.pages.map((page) => page.sourcePageNumber)).toEqual([1, 3, 5]);
    await exportAndValidate(bytes, source, state);
    state = moveEditPage(state, state.present.pages[2].id, 0);
    expect(state.present.pages.map((page) => page.sourcePageNumber)).toEqual([5, 1, 3]);
    await exportAndValidate(bytes, source, state);
    state = selectAllEditPages(state);
    state = rotateEditSelection(state, 90);
    const edited = structuredClone(state.present);
    await exportAndValidate(bytes, source, state);
    state = undoEdit(undoEdit(undoEdit(state)));
    expect(state.present.pages).toEqual(original.present.pages);
    expect(state.future).toHaveLength(3);
    await exportAndValidate(bytes, source, state);
    state = redoEdit(redoEdit(redoEdit(state)));
    expect(state.present).toEqual(edited);
    expect(state.past).toHaveLength(3);
    await exportAndValidate(bytes, source, state);
  });

  it("rejects equal-count output with a wrong order even when all page sizes/rotations match", async () => {
    const bytes = makeExportPdf({ pages: Array.from({ length: 3 }, () => exportMixedPages[0]) });
    const source = await openPdf(bytes);
    const expected = createEditState("document-a", source.pages);
    const wrongOrder = moveEditPage(expected, expected.present.pages[2].id, 0);
    const output = await openPdf(await generateEditedPdf(bytes, {
      documentId: "document-a", originalPages: source.pages, pages: wrongOrder.present.pages,
    }, signal()));
    expect(output.pages).toEqual(source.pages);
    expect((await output.content(1)).text).toContain("PAGE 3");
    await expect(validateEditedPdf(source, output, expected.present.pages, signal())).rejects.toThrow();
  });

  it.each(["images", "vectors", "text"])("rejects a same-size, same-count PDF that lost %s", async (missing) => {
    const bytes = makeExportPdf();
    const source = await openPdf(bytes);
    const state = createEditState("document-a", source.pages);
    const damaged = await openPdf(makeExportPdf({ [missing]: false }));
    expect(damaged.pages).toEqual(source.pages);
    if (missing !== "text") expect((await damaged.content(1)).text).toEqual((await source.content(1)).text);
    await expect(validateEditedPdf(source, damaged, state.present.pages, signal())).rejects.toThrow();
  });

  it("preserves image-only pages and rejects their equal-count wrong order using actual pixels", async () => {
    const bytes = makeExportPdf({ pages: Array.from({ length: 3 }, () => exportMixedPages[0]), text: false, vectors: false });
    const source = await openPdf(bytes);
    const initial = createEditState("document-a", source.pages);
    const reordered = moveEditPage(initial, initial.present.pages[2].id, 0);
    const outputBytes = await exportAndValidate(bytes, source, reordered, "document-a", { text: false, vectors: false });
    const output = await openPdf(outputBytes);
    expect((await source.content(1)).text).toEqual([]);
    expect((await output.content(1)).text).toEqual([]);
    await expect(validateEditedPdf(source, output, initial.present.pages, signal())).rejects.toThrow();
  });

  it("keeps two documents' original bytes, selection and history isolated", async () => {
    const firstBytes = makeExportPdf({ pages: exportMixedPages });
    const secondBytes = makeExportPdf({ pages: exportMixedPages, label: "ORANGE EXPORT DOCUMENT", palette: "orange" });
    const hashes = [digest(firstBytes), digest(secondBytes)];
    const first = await openPdf(firstBytes);
    const second = await openPdf(secondBytes);
    let firstState = createEditState("document-a", first.pages);
    let secondState = createEditState("document-b", second.pages);
    firstState = rotateEditSelection(selectAllEditPages(firstState), 90);
    secondState = moveEditPage(secondState, secondState.present.pages[2].id, 0);
    secondState = undoEdit(secondState);
    const states = structuredClone([firstState, secondState]);
    const output = await openPdf(await exportAndValidate(firstBytes, first, firstState));
    expect([firstState, secondState]).toEqual(states);
    await exportAndValidate(secondBytes, second, secondState, "document-b");
    expect([firstState, secondState]).toEqual(states);
    expect([digest(firstBytes), digest(secondBytes)]).toEqual(hashes);
    const secondRotated = rotateEditSelection(selectAllEditPages(secondState), 90);
    await expect(validateEditedPdf(second, output, secondRotated.present.pages, signal())).rejects.toThrow();
  });

  it("keeps saved output independent when the temporary source read is zeroed", async () => {
    const file = new File([makeExportPdf({ pages: exportMixedPages })], "artificial-source.pdf", { type: "application/pdf" });
    const sourceBytes = new Uint8Array(await file.arrayBuffer());
    const fileHash = digest(sourceBytes);
    const source = await openPdf(sourceBytes);
    const state = freeze(rotateEditSelection(selectAllEditPages(createEditState("document-a", source.pages)), 90));
    const before = structuredClone(state);
    const outputBytes = await generateEditedPdf(sourceBytes, {
      documentId: "document-a", originalPages: source.pages, pages: state.present.pages,
    }, signal());
    const outputHash = digest(outputBytes);
    // The workspace releases its temporary File read after the generator finishes.
    sourceBytes.fill(0);
    expect(sourceBytes.every((byte) => byte === 0)).toBe(true);
    expect(digest(outputBytes)).toBe(outputHash);
    expect(digest(new Uint8Array(await file.arrayBuffer()))).toBe(fileHash);
    const output = await openPdf(outputBytes);
    await validateEditedPdf(source, output, state.present.pages, signal());
    for (let number = 1; number <= output.pages.length; number++) {
      expect(await output.content(number)).toMatchObject({
        text: expect.arrayContaining([`PAGE ${number}`]), hasImage: true, hasVector: true,
      });
    }
    expect(state).toEqual(before);
  });

  it("rejects damaged source bytes without altering edit state", async () => {
    const source = await openPdf(makeExportPdf());
    const state = freeze(createEditState("document-a", source.pages));
    const before = structuredClone(state);
    await expect(generateEditedPdf(new TextEncoder().encode("%PDF-1.7\nnot a PDF"), {
      documentId: "document-a", originalPages: source.pages, pages: state.present.pages,
    }, signal())).rejects.toThrow();
    expect(state).toEqual(before);
  });

  it("honors an already canceled generation/validation without changing bytes or history", async () => {
    const bytes = makeExportPdf();
    const source = await openPdf(bytes);
    const state = freeze(createEditState("document-a", source.pages));
    const before = { hash: digest(bytes), state: structuredClone(state) };
    const controller = new AbortController();
    controller.abort(new DOMException("Artificial test cancellation", "AbortError"));
    await expect(generateEditedPdf(bytes, {
      documentId: "document-a", originalPages: source.pages, pages: state.present.pages,
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(validateEditedPdf(source, source, state.present.pages, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(source.inspections).toHaveLength(0);
    expect({ hash: digest(bytes), state }).toEqual(before);
  });
});
