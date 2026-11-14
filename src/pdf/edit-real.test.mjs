// @vitest-environment node
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it, vi } from "vitest";
import { makePdf, mixedPages } from "../test/fixtures/synthetic/pdf-fixtures.mjs";
import {
  createEditState, deleteEditSelection, getEditedPageInfo, moveEditPage,
  redoEdit, rotateEditSelection, selectEditPage, undoEdit,
} from "./edit";

const assetRoot = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
const asset = (name) => join(assetRoot, name).replaceAll("\\", "/") + "/";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Exercise the actual edit model against PDF.js page proxies and native canvas pixels. */
describe("real PDF editing preserves source mapping and bytes", () => {
  it.each([
    ["three ordinary pages", Array.from({ length: 3 }, () => ({ width: 420, height: 594 }))],
    ["mixed orientations and original rotation", mixedPages],
    ["twenty-four pages", Array.from({ length: 24 }, (_, index) => mixedPages[index % 3])],
    ["one hundred pages", Array.from({ length: 100 }, (_, index) => mixedPages[index % 3])],
  ])("edits and restores %s using real source content", async (_name, pages) => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Unexpected network request during synthetic PDF editing");
    });
    const file = new File([makePdf({ pages })], "synthetic-edit.pdf", { type: "application/pdf" });
    const before = digest(new Uint8Array(await file.arrayBuffer()));
    // As in the browser adapter, PDF.js owns a fresh read of the immutable File.
    const task = getDocument({
      data: new Uint8Array(await file.arrayBuffer()), verbosity: 0, useWorkerFetch: false,
      cMapUrl: asset("cmaps"), cMapPacked: true,
      standardFontDataUrl: asset("standard_fonts"), wasmUrl: asset("wasm"),
    });
    try {
      const source = await task.promise;
      const metadata = [];
      for (let number = 1; number <= source.numPages; number++) {
        const page = await source.getPage(number);
        const view = page.getViewport({ scale: 1 });
        metadata.push({ number, width: view.width, height: view.height, rotation: view.rotation,
          orientation: view.width === view.height ? "square" : view.width > view.height ? "landscape" : "portrait" });
        page.cleanup();
      }
      const initial = createEditState("source-a", metadata);
      const originalMetadata = structuredClone(metadata);
      let state = selectEditPage(initial, initial.present.pages[1].id);
      state = deleteEditSelection(state);
      expect(state.present.pages.map((page) => page.sourcePageNumber)).not.toContain(2);
      state = moveEditPage(state, state.present.pages.at(-1).id, 0);
      const movedOrder = state.present.pages.map((page) => page.sourcePageNumber);
      expect(movedOrder[0]).toBe(pages.length);
      state = selectEditPage(state, state.present.pages[0].id);
      state = selectEditPage(state, state.present.pages[1].id, { toggle: true });
      state = rotateEditSelection(state, 90);
      const edited = state.present;
      expect(edited.pages.filter((page) => page.rotationDelta === 90)).toHaveLength(2);

      // This validates actual text and rendered pixels in edited order, not just metadata.
      for (const [index, editPage] of edited.pages.entries()) {
        const original = await source.getPage(editPage.sourcePageNumber);
        const content = await original.getTextContent();
        expect(content.items.some((item) => item.str === `PAGE ${editPage.sourcePageNumber}`)).toBe(true);
        const display = getEditedPageInfo(editPage, metadata[editPage.sourcePageNumber - 1], index + 1);
        const view = original.getViewport({ scale: 1, rotation: display.rotation });
        expect([view.width, view.height]).toEqual([display.width, display.height]);
        expect(original.rotate).toBe(editPage.originalRotation);
        // Render representative edited pages, including the final original page of a 100-page source.
        if (index < 2) {
          const viewport = original.getViewport({ scale: 120 / Math.max(view.width, view.height), rotation: display.rotation });
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          try {
            await original.render({ canvas, viewport }).promise;
            const pixel = canvas.getContext("2d").getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
            expect([...pixel]).toEqual([38, 102, 217, 255]);
          } finally {
            canvas.width = canvas.height = 1;
          }
        }
        original.cleanup();
      }

      state = undoEdit(state);
      expect(state.present.pages.every((page) => page.rotationDelta === 0)).toBe(true);
      state = undoEdit(state);
      expect(state.present.pages.map((page) => page.sourcePageNumber)).toEqual(initial.present.pages.map((page) => page.sourcePageNumber).filter((number) => number !== 2));
      state = undoEdit(state);
      expect(state.present.pages).toEqual(initial.present.pages);
      const restored = await source.getPage(2);
      expect((await restored.getTextContent()).items.some((item) => item.str === "PAGE 2")).toBe(true);
      restored.cleanup();
      state = redoEdit(redoEdit(redoEdit(state)));
      expect(state.present).toEqual(edited);
      expect(metadata).toEqual(originalMetadata);
      expect(source.numPages).toBe(pages.length);
      expect(digest(new Uint8Array(await file.arrayBuffer()))).toBe(before);
      expect(network).not.toHaveBeenCalled();
    } finally {
      await task.destroy();
      expect(task.destroyed).toBe(true);
    }
  });
});
