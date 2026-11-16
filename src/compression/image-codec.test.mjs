// @vitest-environment node
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import * as L from "pdf-lib";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it, vi } from "vitest";
import { makeChineseCompressionImagePdf, makeCompressionImagePdf, nodeJpegCodec } from "../test/fixtures/synthetic/compression-image-fixtures.mjs";
import { COMPLEX_CHINESE_TEXT } from "../test/fixtures/synthetic/complex-pdf-fixtures.mjs";
import { IMAGE_PROFILES, optimizeJpegPdf } from "./image-codec";
import { inspectJpegImage, normalizeEncodedJpeg } from "./image-types";
import { verifyJpegPdfStructure } from "./image-structure";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const signal = () => new AbortController().signal;
const assetRoot = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
const asset = (name) => join(assetRoot, name).replaceAll("\\", "/") + "/";
async function render(bytes, resolution) {
  const task = getDocument({ data: bytes.slice(), verbosity: 0, stopAtErrors: true, useWorkerFetch: false,
    standardFontDataUrl: asset("standard_fonts"), cMapUrl: asset("cmaps"), cMapPacked: true,
    wasmUrl: asset("wasm"), iccUrl: asset("iccs") });
  try {
    const pdf = await task.promise, pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i), geometry = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: resolution / Math.max(geometry.width, geometry.height) });
      const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
      try {
        await page.render({ canvas, viewport, background: "#ffffff" }).promise;
        const text = (await page.getTextContent()).items.filter((item) => "str" in item).map((item) => item.str);
        const operators = await page.getOperatorList();
        pages.push({ pixels: new Uint8Array(canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data),
          width: geometry.width, height: geometry.height, rotation: geometry.rotation, text,
          imageOps: operators.fnArray.filter((op) => op === OPS.paintImageXObject).length,
          vectorOps: operators.fnArray.filter((op) => op === OPS.constructPath).length });
      } finally { canvas.width = canvas.height = 1; page.cleanup(); }
    }
    return pages;
  } finally { await task.destroy(); }
}
function psnr(a, b) { let square = 0; for (let i = 0; i < a.length; i++) square += (a[i] - b[i]) ** 2; return square ? 10 * Math.log10(255 ** 2 / (square / a.length)) : Infinity; }
async function mutate(bytes, change) {
  const pdf = await L.PDFDocument.load(bytes, { updateMetadata: false }); await change(pdf);
  return pdf.save({ useObjectStreams: true, updateFieldAppearances: false });
}
const images = (pdf) => pdf.context.enumerateIndirectObjects().filter(([, object]) => object instanceof L.PDFRawStream && object.dict.get(L.PDFName.of("Subtype")) === L.PDFName.of("Image"));
async function checkRendered(source, result, profile) {
  for (const resolution of [128, 512]) {
    const first = await render(source, resolution), second = await render(result.bytes, resolution);
    const maskedFirst = await render(result.maskedSource, resolution), maskedSecond = await render(result.maskedOutput, resolution);
    expect(second).toHaveLength(first.length);
    for (let page = 0; page < first.length; page++) {
      const a = first[page], b = second[page];
      for (const key of ["width", "height", "rotation", "text", "imageOps", "vectorOps"]) expect(b[key]).toEqual(a[key]);
      expect(sha(maskedFirst[page].pixels)).toBe(sha(maskedSecond[page].pixels));
      expect(psnr(a.pixels, b.pixels)).toBeGreaterThanOrEqual(IMAGE_PROFILES[profile].minimumPagePsnr);
      expect(a.text.join(" ")).toContain("SELECTABLE OCR PAGE " + (page + 1));
    }
  }
}

describe("real narrow JPEG optimization and independent output evidence", () => {
  it.each(["high", "balanced", "strong"])("executes %s JPEG parameters without rasterizing text or vectors", async (profile) => {
    const input = await makeCompressionImagePdf(), sourceSha = sha(input);
    const result = await optimizeJpegPdf(input, profile, signal(), nodeJpegCodec);
    expect(result.changedImages).toBe(1); expect(result.eligibleImages).toBe(1); expect(result.skippedImages).toBe(0);
    expect(result.bytes.length).toBeLessThan(input.length); expect(result.qualityMetrics).toHaveLength(1);
    expect(result.qualityMetrics[0].psnr).toBeGreaterThanOrEqual(IMAGE_PROFILES[profile].minimumImagePsnr);
    await checkRendered(input, result, profile);
    expect(sha(input)).toBe(sourceSha);
  });
  it("uses genuinely distinct three-level output parameters and sizes", async () => {
    const input = await makeCompressionImagePdf({ count: 1 });
    const results = [];
    for (const profile of ["high", "balanced", "strong"]) results.push(await optimizeJpegPdf(input, profile, signal(), nodeJpegCodec));
    expect(new Set(results.map((result) => sha(result.bytes))).size).toBe(3);
    expect(results[0].bytes.length).toBeGreaterThan(results[1].bytes.length);
    expect(results[1].bytes.length).toBeGreaterThan(results[2].bytes.length);
  });
  it("preserves an invisible OCR layer, rotation and crop geometry", async () => {
    const input = await makeCompressionImagePdf({ count: 1, ocr: true });
    const result = await optimizeJpegPdf(input, "balanced", signal(), nodeJpegCodec);
    await checkRendered(input, result, "balanced");
  });
  it("retains embedded Chinese Type3 glyphs and table vectors while recompressing a JPEG", async () => {
    const input = await makeChineseCompressionImagePdf(), sourceSha = sha(input);
    const result = await optimizeJpegPdf(input, "balanced", signal(), nodeJpegCodec);
    expect(result.changedImages).toBe(1);
    for (const size of [128, 512]) {
      const original = await render(input, size), output = await render(result.bytes, size);
      const maskedOriginal = await render(result.maskedSource, size), maskedOutput = await render(result.maskedOutput, size);
      for (let page = 0; page < original.length; page++) {
        expect(original[page].text.join("")).toContain(COMPLEX_CHINESE_TEXT);
        expect(output[page].text).toEqual(original[page].text);
        expect(output[page].vectorOps).toEqual(original[page].vectorOps);
        expect(sha(maskedOriginal[page].pixels)).toBe(sha(maskedOutput[page].pixels));
        expect(psnr(original[page].pixels, output[page].pixels)).toBeGreaterThanOrEqual(30);
      }
    }
    expect(sha(input)).toBe(sourceSha);
  });
  it("skips transparent PNG and soft-mask images while retaining their exact bytes", async () => {
    const input = await makeCompressionImagePdf({ count: 1, transparentPng: true });
    const before = await L.PDFDocument.load(input, { updateMetadata: false });
    const untouched = images(before).filter(([, stream]) => !inspectJpegImage(stream)).map(([, stream]) => sha(stream.getContents()));
    const result = await optimizeJpegPdf(input, "balanced", signal(), nodeJpegCodec);
    const after = await L.PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(result.changedImages).toBe(1); expect(result.skippedImages).toBeGreaterThanOrEqual(2);
    expect(images(after).filter(([, stream]) => !inspectJpegImage(stream)).map(([, stream]) => sha(stream.getContents()))).toEqual(untouched);
    await checkRendered(input, result, "balanced");
  });
  it("returns original bytes when an already compressed JPEG has no benefit", async () => {
    const input = await makeCompressionImagePdf({ count: 1, quality: 25 });
    const result = await optimizeJpegPdf(input, "high", signal(), nodeJpegCodec);
    expect(result.changedImages).toBe(0); expect(result.bytes).toEqual(input); expect(result.methods).toEqual([]);
    expect(result.skippedReasons["image-no-gain"]).toBe(1); expect(result.maskedOutput).toBeUndefined();
  });
  it("keeps a text-only PDF byte-identical and does not invent image optimization", async () => {
    const input = await makeCompressionImagePdf({ count: 1, images: false });
    const codec = { encode: vi.fn(), compare: vi.fn() };
    const result = await optimizeJpegPdf(input, "strong", signal(), codec);
    expect(result.bytes).toEqual(input); expect(result.changedImages).toBe(0); expect(codec.encode).not.toHaveBeenCalled();
  });
  it("does not strip an ICC profile from user JPEG input", async () => {
    const input = await makeCompressionImagePdf({ count: 1, icc: true });
    const codec = { encode: vi.fn(), compare: vi.fn() };
    const result = await optimizeJpegPdf(input, "high", signal(), codec);
    expect(result.bytes).toEqual(input); expect(result.skippedImages).toBe(1); expect(codec.encode).not.toHaveBeenCalled();
  });
  it.each(["header-exif", "after-scan-profile"])("does not admit %s markers outside the narrow JPEG scope", async (kind) => {
    const input = await mutate(await makeCompressionImagePdf({ count: 1 }), (pdf) => {
      const [ref, stream] = images(pdf)[0], bytes = stream.getContents();
      const marker = kind === "header-exif" ? new Uint8Array([255, 225, 0, 8, 69, 120, 105, 102, 0, 0]) : new Uint8Array([255, 226, 0, 4, 0, 0]);
      const at = kind === "header-exif" ? 2 : bytes.length - 2;
      const altered = new Uint8Array(bytes.length + marker.length);
      altered.set(bytes.subarray(0, at)); altered.set(marker, at); altered.set(bytes.subarray(at), at + marker.length);
      pdf.context.assign(ref, L.PDFRawStream.of(stream.dict.clone(), altered));
    });
    const codec = { encode: vi.fn(), compare: vi.fn() };
    const result = await optimizeJpegPdf(input, "high", signal(), codec);
    expect(result.bytes).toEqual(input); expect(codec.encode).not.toHaveBeenCalled();
  });
  it("leaves unreachable JPEG objects untouched rather than changing an unbound target", async () => {
    const input = await mutate(await makeCompressionImagePdf({ count: 1 }), (pdf) => pdf.context.register(images(pdf)[0][1].clone()));
    const result = await optimizeJpegPdf(input, "high", signal(), nodeJpegCodec);
    expect(result.changedImages).toBe(1); expect(result.skippedReasons["unreferenced-image"]).toBe(1);
  });
  it("enforces the total decoded-pixel budget before launching further decoders", async () => {
    const input = await mutate(await makeCompressionImagePdf({ count: 1 }), (pdf) => {
      const stream = images(pdf)[0][1], resources = pdf.getPage(0).node.Resources().lookup(L.PDFName.of("XObject"), L.PDFDict);
      for (let i = 0; i < 57; i++) resources.set(L.PDFName.of("SyntheticExtra" + i), pdf.context.register(stream.clone()));
    });
    const codec = { encode: vi.fn(async (bytes) => bytes.slice()), compare: vi.fn() };
    const result = await optimizeJpegPdf(input, "high", signal(), codec);
    expect(result.changedImages).toBe(0); expect(result.skippedReasons["total-decode-limit"]).toBe(2);
    expect(codec.encode).toHaveBeenCalledTimes(56); expect(codec.compare).not.toHaveBeenCalled(); expect(sha(result.bytes)).toBe(sha(input));
  });
  it("rejects over 100 image objects before starting encoding", async () => {
    const input = await mutate(await makeCompressionImagePdf({ count: 1 }), (pdf) => {
      const stream = images(pdf)[0][1]; for (let i = 0; i < 100; i++) pdf.context.register(stream.clone());
    });
    const codec = { encode: vi.fn(), compare: vi.fn() };
    await expect(optimizeJpegPdf(input, "high", signal(), codec)).rejects.toThrow("100 个");
    expect(codec.encode).not.toHaveBeenCalled();
  });
  it.each(["Decode", "SMask", "OC", "DeviceCMYK", "filter-array", "large-dimensions"])("skips unsupported %s images before decoding", async (kind) => {
    const input = await mutate(await makeCompressionImagePdf({ count: 1 }), (pdf) => {
      const stream = images(pdf)[0][1];
      if (kind === "DeviceCMYK") stream.dict.set(L.PDFName.of("ColorSpace"), L.PDFName.of("DeviceCMYK"));
      else if (kind === "filter-array") stream.dict.set(L.PDFName.of("Filter"), pdf.context.obj(["DCTDecode"]));
      else if (kind === "large-dimensions") stream.dict.set(L.PDFName.of("Width"), L.PDFNumber.of(100_000));
      else stream.dict.set(L.PDFName.of(kind), L.PDFNull);
    });
    const codec = { encode: vi.fn(), compare: vi.fn() };
    const result = await optimizeJpegPdf(input, "balanced", signal(), codec);
    expect(result.bytes).toEqual(input); expect(result.skippedImages).toBe(1); expect(codec.encode).not.toHaveBeenCalled();
  });
  it.each(["OCProperties", "AcroForm", "Perms", "OpenAction"])("rejects the unsupported %s document context", async (name) => {
    const input = await mutate(await makeCompressionImagePdf({ count: 1 }), (pdf) => pdf.catalog.set(L.PDFName.of(name), pdf.context.obj({})));
    await expect(optimizeJpegPdf(input, "high", signal(), nodeJpegCodec)).rejects.toThrow(/不支持|无法安全验证/);
  });
  it("rejects non-opaque ExtGState blending contexts", async () => {
    await expect(optimizeJpegPdf(await makeCompressionImagePdf({ count: 1, opacity: true }), "high", signal(), nodeJpegCodec)).rejects.toThrow("透明混合");
  });
  it("rejects transparency groups even if the target JPEG has no SMask", async () => {
    const input = await mutate(await makeCompressionImagePdf({ count: 1 }), (pdf) => pdf.getPage(0).node.set(L.PDFName.of("Group"), pdf.context.obj({ S: "Transparency" })));
    await expect(optimizeJpegPdf(input, "high", signal(), nodeJpegCodec)).rejects.toThrow("透明混合");
  });
  it("keeps below-floor candidate images out of the result", async () => {
    const input = await makeCompressionImagePdf({ count: 1 });
    const result = await optimizeJpegPdf(input, "strong", signal(), { ...nodeJpegCodec, compare: async () => ({ psnr: 0, meanAbsoluteDelta: 200 }) });
    expect(result.bytes).toEqual(input); expect(result.changedImages).toBe(0); expect(result.skippedReasons["quality-floor"]).toBe(1);
  });
  it("cancels after native encoding without retaining output bytes or changing the source", async () => {
    const input = await makeCompressionImagePdf({ count: 1 }), before = sha(input), controller = new AbortController();
    let owned;
    const codec = { ...nodeJpegCodec, encode: async (...args) => { owned = await nodeJpegCodec.encode(...args); controller.abort(); return owned; } };
    await expect(optimizeJpegPdf(input, "balanced", controller.signal, codec)).rejects.toThrow();
    expect(owned.every((value) => value === 0)).toBe(true); expect(sha(input)).toBe(before);
  });
  it("does not start an aborted task", async () => {
    const controller = new AbortController(); controller.abort(); const codec = { encode: vi.fn(), compare: vi.fn() };
    await expect(optimizeJpegPdf(new Uint8Array([1]), "high", controller.signal, codec)).rejects.toThrow();
    expect(codec.encode).not.toHaveBeenCalled();
  });
  it("sanitizes encoder failures and rejects invalid profiles", async () => {
    const input = await makeCompressionImagePdf({ count: 1 });
    await expect(optimizeJpegPdf(input, "unknown", signal(), nodeJpegCodec)).rejects.toThrow("参数无效");
    const error = await optimizeJpegPdf(input, "high", signal(), { encode: async () => { throw new Error("ARTIFICIAL_PRIVATE_SENTINEL"); } }).catch((value) => value);
    expect(error.message).not.toContain("SENTINEL"); expect(error.message).toContain("无法完成安全图像优化");
  });
});

describe("independent JPEG output graph counterexamples", () => {
  it.each(["text", "vector", "metadata", "rotation", "page-order", "jpeg-pixels", "image-dimensions", "shared-reference"])("rejects changed %s rather than trusting image-only claims", async (kind) => {
    const source = await makeCompressionImagePdf();
    const result = await optimizeJpegPdf(source, "balanced", signal(), nodeJpegCodec);
    const broken = await mutate(result.bytes, (pdf) => {
      if (kind === "metadata") { pdf.setTitle("CHANGED ARTIFICIAL TITLE"); return; }
      if (kind === "rotation") { pdf.getPage(0).setRotation(L.degrees(180)); return; }
      if (kind === "page-order") { const pages = pdf.catalog.Pages().Kids(); const a = pages.get(0); pages.set(0, pages.get(1)); pages.set(1, a); return; }
      const [ref, stream] = images(pdf)[0];
      if (kind === "image-dimensions") { stream.dict.set(L.PDFName.of("Width"), L.PDFNumber.of(320)); return; }
      if (kind === "jpeg-pixels") {
        const canvas = createCanvas(640, 880); canvas.getContext("2d").fillStyle = "#ff0000"; canvas.getContext("2d").fillRect(0, 0, 640, 880);
        pdf.context.assign(ref, L.PDFRawStream.of(stream.dict.clone(), normalizeEncodedJpeg(canvas.encodeSync("jpeg", 70)))); return;
      }
      if (kind === "shared-reference") {
        const copyRef = pdf.context.register(stream.clone()), resources = pdf.getPage(1).node.Resources().lookup(L.PDFName.of("XObject"), L.PDFDict);
        resources.set(resources.keys()[0], copyRef); return;
      }
      const contents = pdf.getPage(0).node.Contents(), contentRef = contents.get(0), old = pdf.context.lookup(contentRef);
      const decoded = Buffer.from(L.decodePDFRawStream(old).decode()).toString("latin1");
      const altered = kind === "text" ? decoded.replace(/<[A-F0-9]+>\s*Tj/g, "<> Tj") : decoded.replace(/\nS\n/g, "\nn\n");
      expect(altered).not.toBe(decoded);
      pdf.context.assign(contentRef, pdf.context.flateStream(new Uint8Array(Buffer.from(altered, "latin1"))));
    });
    await expect(verifyJpegPdfStructure(source, broken, "balanced", signal(), nodeJpegCodec)).rejects.toThrow();
  });
});
