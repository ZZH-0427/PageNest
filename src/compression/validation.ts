import { PdfUserError, type PdfDocumentHandle } from "../pdf/types";
import { IMAGE_PROFILES } from "./image-types";
import type { CompressionMode } from "./types";

type Inspection = Awaited<ReturnType<NonNullable<PdfDocumentHandle["inspectPage"]>>>;
const close = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.01;
const clear = (page: Inspection | undefined) => page?.visualSample?.pixels.fill(0);
const fail = (item: string, page?: number, resolution?: number): never => {
  throw new PdfUserError(`压缩结果未通过独立检查，未提供下载。[COMPRESSION_VALIDATION_FAILURE; item=${item}${page ? `; page=${page}` : ""}${resolution ? `; resolution=${resolution}` : ""}]`);
};

export async function inspectCompressionDocument(handle: PdfDocumentHandle, signal: AbortSignal) {
  if (!handle.inspectDocument) return fail("document-inspection");
  const info = await handle.inspectDocument(signal);
  signal.throwIfAborted();
  if (info.hasForms || info.hasSignatures || info.hasAttachments || info.hasJavaScript || info.encrypted) {
    throw new PdfUserError("此 PDF 含加密、签名、表单、附件或活动内容，当前压缩不支持这些结构。请保留原件。");
  }
  if (!info.metadataDigest || !info.outlinesDigest) return fail("document-inspection");
  return info;
}

/** Lossless and masked control renders are exact; only intended JPEG changes use PSNR. */
export async function validateCompressionPair(source: PdfDocumentHandle, output: PdfDocumentHandle, mode: CompressionMode,
  signal: AbortSignal, exact = mode === "lossless"): Promise<void> {
  signal.throwIfAborted();
  if (!source.pages.length || source.pages.length !== output.pages.length || source.pages.length > 200) return fail("page-count");
  const beforeInfo = await inspectCompressionDocument(source, signal);
  const afterInfo = await inspectCompressionDocument(output, signal);
  if (beforeInfo.metadataDigest !== afterInfo.metadataDigest) return fail("metadata");
  if (beforeInfo.outlinesDigest !== afterInfo.outlinesDigest) return fail("bookmarks");
  if (!source.inspectPage || !output.inspectPage) return fail("page-inspection");
  for (let index = 0; index < source.pages.length; index++) {
    const a = source.pages[index], b = output.pages[index];
    if (a.rotation !== b.rotation || !close(a.width, b.width) || !close(a.height, b.height) || a.orientation !== b.orientation) return fail("geometry", index + 1);
    for (const resolution of [128, 512] as const) {
      let before: Inspection | undefined, after: Inspection | undefined;
      try {
        signal.throwIfAborted();
        before = await source.inspectPage(index + 1, signal, 0, false, resolution);
        after = await output.inspectPage(index + 1, signal, 0, false, resolution);
        signal.throwIfAborted();
        if (!before.textDigest || before.textDigest !== after.textDigest) return fail("text", index + 1, resolution);
        if (before.rotation !== a.rotation || after.rotation !== a.rotation || !close(before.width, a.width) || !close(after.width, a.width) ||
          !close(before.height, a.height) || !close(after.height, a.height)) return fail("geometry", index + 1, resolution);
        if (!before.visualDigest || !after.visualDigest) return fail("visual-inspection", index + 1, resolution);
        if (exact) {
          if (before.visualDigest !== after.visualDigest) return fail("exact-render", index + 1, resolution);
        } else {
          const original = before.visualSample, result = after.visualSample;
          if (!original || !result || original.width !== result.width || original.height !== result.height ||
            original.pixels.length !== result.pixels.length || original.pixels.length !== original.width * original.height * 4 ||
            !original.pixels.length || original.width > resolution || original.height > resolution) return fail("raster-geometry", index + 1, resolution);
          let squared = 0;
          for (let pixel = 0; pixel < original.pixels.length; pixel += 4) {
            if (original.pixels[pixel + 3] !== result.pixels[pixel + 3]) return fail("alpha", index + 1, resolution);
            for (let channel = 0; channel < 3; channel++) squared += (original.pixels[pixel + channel] - result.pixels[pixel + channel]) ** 2;
          }
          const mse = squared / (original.pixels.length / 4 * 3);
          const psnr = mse === 0 ? Infinity : 10 * Math.log10(255 ** 2 / mse);
          if (mode === "lossless" || psnr < IMAGE_PROFILES[mode].minimumPagePsnr) return fail("image-quality", index + 1, resolution);
        }
      } finally { clear(before); clear(after); }
    }
  }
}
