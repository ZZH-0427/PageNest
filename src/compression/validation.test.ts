import { describe, expect, it, vi } from "vitest";
import type { PdfDocumentHandle, PdfPageInfo } from "../pdf/types";
import { inspectCompressionDocument, validateCompressionPair } from "./validation";

type Inspection = Awaited<ReturnType<NonNullable<PdfDocumentHandle["inspectPage"]>>>;
const signal = () => new AbortController().signal;
const page: PdfPageInfo = { number: 1, width: 420, height: 594, rotation: 0, orientation: "portrait" };
function document(options: { count?: number; pixel?: number; inspection?: Partial<Inspection>; info?: Record<string, unknown>;
  inspect?: (size: 128 | 512) => Partial<Inspection> } = {}) {
  const owned: Uint8Array[] = [];
  const handle: PdfDocumentHandle = {
    pages: Array.from({ length: options.count ?? 1 }, (_, index) => ({ ...page, number: index + 1 })),
    render: vi.fn(async () => {}), destroy: vi.fn(async () => {}),
    inspectDocument: vi.fn(async () => ({ metadataDigest: "synthetic-metadata", outlinesDigest: "synthetic-bookmarks",
      hasForms: false, hasAttachments: false, hasJavaScript: false, encrypted: false, ...options.info })),
    inspectPage: vi.fn(async (_number, currentSignal, _delta, _signature, size = 128) => {
      currentSignal.throwIfAborted();
      const pixels = new Uint8Array(16).fill(options.pixel ?? 100);
      for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
      owned.push(pixels);
      return { textDigest: "synthetic-text", visualDigest: "synthetic-pixels-" + size,
        width: 420, height: 594, rotation: 0, visualSample: { width: 2, height: 2, pixels },
        ...options.inspection, ...options.inspect?.(size) };
    }),
  };
  return { handle, owned };
}
const erased = (arrays: Uint8Array[]) => arrays.every((bytes) => bytes.every((byte) => byte === 0));

describe("compression independent document and page gates", () => {
  it("checks both actual resolutions for every page and erases borrowed pixel scratch", async () => {
    const source = document({ count: 2 }), output = document({ count: 2 });
    await validateCompressionPair(source.handle, output.handle, "lossless", signal());
    expect(vi.mocked(source.handle.inspectPage!).mock.calls.map((args) => [args[0], args[4]])).toEqual([[1, 128], [1, 512], [2, 128], [2, 512]]);
    expect(erased([...source.owned, ...output.owned])).toBe(true);
    expect(source.handle.destroy).not.toHaveBeenCalled(); expect(output.handle.destroy).not.toHaveBeenCalled();
  });
  it.each(["hasForms", "hasSignatures", "hasAttachments", "hasJavaScript", "encrypted"])("rejects unsupported %s from independent inspection", async (key) => {
    const source = document({ info: { [key]: true } }), output = document();
    await expect(validateCompressionPair(source.handle, output.handle, "lossless", signal())).rejects.toThrow("当前压缩不支持");
    expect(source.handle.inspectPage).not.toHaveBeenCalled();
  });
  it("rejects a signature-only flag on the output even if the parser reports no form", async () => {
    const source = document(), output = document({ info: { hasForms: false, hasSignatures: true } });
    await expect(validateCompressionPair(source.handle, output.handle, "lossless", signal())).rejects.toThrow("签名");
    expect(source.handle.inspectPage).not.toHaveBeenCalled();
  });
  it.each([["metadataDigest", "metadata"], ["outlinesDigest", "bookmarks"]])("rejects changed %s", async (key, item) => {
    const source = document(), output = document({ info: { [key]: "different-artificial-evidence" } });
    await expect(validateCompressionPair(source.handle, output.handle, "lossless", signal())).rejects.toThrow("item=" + item);
  });
  it("requires an available independent document inspector and nonempty evidence", async () => {
    const absent = document().handle; delete absent.inspectDocument;
    await expect(inspectCompressionDocument(absent, signal())).rejects.toThrow("document-inspection");
    await expect(inspectCompressionDocument(document({ info: { metadataDigest: "" } }).handle, signal())).rejects.toThrow("document-inspection");
  });
  it.each([0, 201])("rejects source page count %s outside the bounded validation range", async (count) => {
    await expect(validateCompressionPair(document({ count }).handle, document({ count }).handle, "lossless", signal())).rejects.toThrow("page-count");
  });
  it("rejects differing actual page counts and changed source/output geometry", async () => {
    await expect(validateCompressionPair(document().handle, document({ count: 2 }).handle, "lossless", signal())).rejects.toThrow("page-count");
    const output = document(); output.handle.pages[0].rotation = 90;
    await expect(validateCompressionPair(document().handle, output.handle, "high", signal())).rejects.toThrow("geometry");
  });
  it.each(["textDigest", "visualDigest", "width", "rotation"])("rejects a changed page %s and erases captured pixels", async (key) => {
    const original = document(), output = document({ inspection: { [key]: key.endsWith("Digest") ? "different-evidence" : 90 } });
    await expect(validateCompressionPair(original.handle, output.handle, "lossless", signal())).rejects.toThrow();
    expect(erased([...original.owned, ...output.owned])).toBe(true);
  });
  it("does not skip a mismatch that appears only in the 512-pixel render", async () => {
    const original = document(), output = document({ inspect: (size) => size === 512 ? { visualDigest: "different-512-evidence" } : {} });
    await expect(validateCompressionPair(original.handle, output.handle, "lossless", signal())).rejects.toThrow("resolution=512");
    expect(erased([...original.owned, ...output.owned])).toBe(true);
  });
  it("requires real raster samples for lossy quality checks", async () => {
    const original = document(), output = document({ inspection: { visualSample: undefined } });
    await expect(validateCompressionPair(original.handle, output.handle, "balanced", signal())).rejects.toThrow("raster-geometry");
    expect(erased(original.owned)).toBe(true);
  });
  it("rejects changed alpha and erases both samples", async () => {
    const original = document(), output = document({ inspect: () => ({ visualSample: { width: 2, height: 2, pixels: new Uint8Array(16) } }) });
    await expect(validateCompressionPair(original.handle, output.handle, "strong", signal())).rejects.toThrow("alpha");
    expect(erased(original.owned)).toBe(true);
  });
  it.each(["high", "balanced", "strong"] as const)("rejects gross corruption in %s rather than accepting any changed image", async (mode) => {
    const source = document({ pixel: 20 }), output = document({ pixel: 180 });
    await expect(validateCompressionPair(source.handle, output.handle, mode, signal())).rejects.toThrow("image-quality");
    expect(erased([...source.owned, ...output.owned])).toBe(true);
  });
  it("uses distinct documented quality floors and keeps masked controls exact", async () => {
    await expect(validateCompressionPair(document({ pixel: 100 }).handle, document({ pixel: 106 }).handle, "high", signal())).rejects.toThrow("image-quality");
    await expect(validateCompressionPair(document({ pixel: 100 }).handle, document({ pixel: 106 }).handle, "balanced", signal())).resolves.toBeUndefined();
    await expect(validateCompressionPair(document().handle, document({ inspection: { visualDigest: "changed-mask" } }).handle, "balanced", signal(), true)).rejects.toThrow("exact-render");
  });
  it("rejects unavailable page inspections and aborts before starting inspection", async () => {
    const absent = document().handle; delete absent.inspectPage;
    await expect(validateCompressionPair(document().handle, absent, "lossless", signal())).rejects.toThrow("page-inspection");
    const controller = new AbortController(); controller.abort(); const source = document();
    await expect(validateCompressionPair(source.handle, document().handle, "lossless", controller.signal)).rejects.toThrow();
    expect(source.handle.inspectDocument).not.toHaveBeenCalled();
  });
  it("erases source pixels if cancellation interrupts the second inspection", async () => {
    const controller = new AbortController(), source = document(), output = document();
    const inspect = source.handle.inspectPage!;
    source.handle.inspectPage = vi.fn(async (...args: Parameters<NonNullable<PdfDocumentHandle["inspectPage"]>>) => { const result = await inspect(...args); controller.abort(); return result; });
    await expect(validateCompressionPair(source.handle, output.handle, "high", controller.signal)).rejects.toThrow();
    expect(erased(source.owned)).toBe(true);
  });
});
