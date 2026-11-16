import { loadPdfLibrary } from "../pdf/pdf-library";
import { PdfUserError } from "../pdf/types";
import { assertImageDocumentPolicy, verifyJpegPdfStructure } from "./image-structure";
import { acceptableImageQuality, IMAGE_LIMITS, IMAGE_PROFILES, inspectJpegImage, normalizeEncodedJpeg,
  type ImageProfile, type ImageQualityMetrics, type JpegCodec } from "./image-types";

export type { ImageProfile, ImageQualityMetrics, JpegCodec } from "./image-types";
export { IMAGE_PROFILES, IMAGE_LIMITS } from "./image-types";
export interface JpegOptimizationResult {
  bytes: Uint8Array;
  maskedSource?: Uint8Array;
  maskedOutput?: Uint8Array;
  changedImages: number;
  eligibleImages: number;
  skippedImages: number;
  skippedReasons: Readonly<Record<string, number>>;
  methods: readonly string[];
  qualityMetrics: readonly ImageQualityMetrics[];
}
const unavailable = () => new PdfUserError("当前浏览器无法安全解码或重编码此 JPEG；未提供图像压缩结果。");

async function bitmap(bytes: Uint8Array, width: number, height: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") throw unavailable();
  const image = await createImageBitmap(new Blob([new Uint8Array(bytes).buffer], { type: "image/jpeg" }), {
    imageOrientation: "none", premultiplyAlpha: "none", colorSpaceConversion: "none",
  });
  if (signal.aborted || image.width !== width || image.height !== height) { image.close(); signal.throwIfAborted(); throw unavailable(); }
  return image;
}
async function decoded(bytes: Uint8Array, width: number, height: number, signal: AbortSignal) {
  const image = await bitmap(bytes, width, height, signal);
  let canvas: OffscreenCanvas | undefined;
  try {
    canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false, colorSpace: "srgb", willReadFrequently: true });
    if (!context) throw unavailable();
    context.drawImage(image, 0, 0);
    signal.throwIfAborted();
    return context.getImageData(0, 0, width, height).data;
  } finally { image.close(); if (canvas) canvas.width = canvas.height = 1; }
}

/** Called only in the task Worker; codecs never receive a file path or network capability. */
export const browserJpegCodec: JpegCodec = {
  async encode(jpeg, width, height, quality, signal) {
    const image = await bitmap(jpeg, width, height, signal);
    let canvas: OffscreenCanvas | undefined;
    try {
      canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d", { alpha: false, colorSpace: "srgb" });
      if (!context) throw unavailable();
      context.drawImage(image, 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
      signal.throwIfAborted();
      if (blob.type !== "image/jpeg" || blob.size > IMAGE_LIMITS.maximumJpegBytes) throw unavailable();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (signal.aborted) { bytes.fill(0); signal.throwIfAborted(); }
      return bytes;
    } finally { image.close(); if (canvas) canvas.width = canvas.height = 1; }
  },
  async compare(source, output, width, height, signal) {
    let first: Uint8ClampedArray | undefined, second: Uint8ClampedArray | undefined;
    try {
      first = await decoded(source, width, height, signal);
      second = await decoded(output, width, height, signal);
      let squares = 0, absolute = 0;
      for (let i = 0; i < first.length; i += 4) {
        if (i % 65536 === 0) signal.throwIfAborted();
        if (first[i + 3] !== 255 || second[i + 3] !== 255) throw unavailable();
        for (let channel = 0; channel < 3; channel++) { const delta = first[i + channel] - second[i + channel]; squares += delta * delta; absolute += Math.abs(delta); }
      }
      const samples = width * height * 3;
      return { psnr: squares === 0 ? Infinity : 10 * Math.log10(255 ** 2 / (squares / samples)), meanAbsoluteDelta: absolute / samples };
    } finally { first?.fill(0); second?.fill(0); }
  },
};

/** Re-encode only admitted JPEG objects; all other document objects stay untouched. */
export async function optimizeJpegPdf(sourceBytes: Uint8Array, profile: ImageProfile, signal: AbortSignal,
  codec: JpegCodec = browserJpegCodec): Promise<JpegOptimizationResult> {
  let bytes: Uint8Array | undefined;
  const encoded: Uint8Array[] = [];
  try {
    signal.throwIfAborted();
    if (!Object.hasOwn(IMAGE_PROFILES, profile) || !sourceBytes.byteLength || sourceBytes.byteLength > 32 * 1024 ** 2) {
      throw new PdfUserError("图像优化参数无效或 PDF 超过 32 MiB 的安全限制。");
    }
    const L = await loadPdfLibrary();
    let document: import("pdf-lib").PDFDocument | undefined = await L.PDFDocument.load(sourceBytes, { updateMetadata: false, ignoreEncryption: false, throwOnInvalidObject: true });
    assertImageDocumentPolicy(document, L);
    signal.throwIfAborted();
    let eligibleImages = 0, skippedImages = 0, changedImages = 0, totalPixels = 0;
    const skippedReasons: Record<string, number> = {};
    const skip = (reason: string) => { skippedImages++; skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1; };
    const imageObjects = document.context.enumerateIndirectObjects().filter((entry): entry is [import("pdf-lib").PDFRef, import("pdf-lib").PDFRawStream] =>
      entry[1] instanceof L.PDFRawStream && entry[1].dict.get(L.PDFName.of("Subtype")) === L.PDFName.of("Image"));
    if (imageObjects.length > IMAGE_LIMITS.maximumImages) throw new PdfUserError("PDF 图像对象超过 100 个，当前图像优化已停止以限制内存占用。");
    const reachable = new Set<string>(), visited = new Set<import("pdf-lib").PDFObject>();
    let nodes = 0;
    const visit = (raw: import("pdf-lib").PDFObject | undefined, depth = 0) => {
      signal.throwIfAborted();
      if (!raw || visited.has(raw)) return;
      visited.add(raw);
      if (++nodes > 100_000 || depth > 128) throw new PdfUserError("PDF 引用图过于复杂，当前图像优化已停止。");
      if (raw instanceof L.PDFRef) { reachable.add(String(raw)); visit(document!.context.lookup(raw), depth + 1); }
      else if (raw instanceof L.PDFRawStream) visit(raw.dict, depth + 1);
      else if (raw instanceof L.PDFDict) for (const [, value] of raw.entries()) visit(value, depth + 1);
      else if (raw instanceof L.PDFArray) for (const value of raw.asArray()) visit(value, depth + 1);
    };
    for (const key of ["Root", "Info", "ID"] as const) visit(document.context.trailerInfo[key]);
    for (const [ref, object] of imageObjects) {
      signal.throwIfAborted();
      if (!reachable.has(String(ref))) { skip("unreferenced-image"); continue; }
      const descriptor = inspectJpegImage(object);
      if (!descriptor) { skip("unsupported-or-decode-limit"); continue; }
      eligibleImages++;
      if (totalPixels + descriptor.pixels > IMAGE_LIMITS.maximumTotalPixels) { skip("total-decode-limit"); continue; }
      totalPixels += descriptor.pixels;
      let candidate: Uint8Array | undefined, raw: Uint8Array | undefined;
      const originalJpeg = object.getContents().slice();
      try {
        raw = await codec.encode(originalJpeg, descriptor.width, descriptor.height, IMAGE_PROFILES[profile].quality, signal);
        signal.throwIfAborted();
        candidate = normalizeEncodedJpeg(raw);
        raw.fill(0); raw = undefined;
        const replacement = L.PDFRawStream.of(object.dict.clone(), candidate);
        if (!inspectJpegImage(replacement)) throw unavailable();
        if (candidate.byteLength >= object.getContentsSize()) { skip("image-no-gain"); continue; }
        const metrics = await codec.compare(originalJpeg, candidate, descriptor.width, descriptor.height, signal);
        signal.throwIfAborted();
        if (!acceptableImageQuality(metrics, profile)) { skip("quality-floor"); continue; }
        document.context.assign(ref, replacement);
        encoded.push(candidate); candidate = undefined; changedImages++;
      } finally { originalJpeg.fill(0); raw?.fill(0); candidate?.fill(0); }
    }
    if (!changedImages) return { bytes: sourceBytes.slice(), changedImages: 0, eligibleImages, skippedImages, skippedReasons,
      methods: [], qualityMetrics: [] };
    bytes = await document.save({ useObjectStreams: true, updateFieldAppearances: false });
    document = undefined;
    for (const image of encoded) image.fill(0);
    encoded.length = 0;
    signal.throwIfAborted();
    const verified = await verifyJpegPdfStructure(sourceBytes, bytes, profile, signal, codec);
    if (verified.changedImages !== changedImages) {
      verified.maskedSource?.fill(0); verified.maskedOutput?.fill(0);
      throw new PdfUserError("实际图像变化与优化计划不一致，未提供下载。");
    }
    const accepted = bytes; bytes = undefined;
    return { ...verified, bytes: accepted, eligibleImages, skippedImages, skippedReasons,
      methods: ["保留原像素尺寸的 DeviceRGB JPEG 重编码", "PDF 对象流重写；未主动删除文档元数据"] };
  } catch (error) {
    bytes?.fill(0);
    signal.throwIfAborted();
    if (error instanceof PdfUserError) throw error;
    throw new PdfUserError("无法完成安全图像优化；文件可能含不支持的结构或当前浏览器资源不足，未提供下载。");
  } finally { for (const image of encoded) image.fill(0); }
}
