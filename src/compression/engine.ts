import { BrowserPdfEngine } from "../pdf/browser-engine";
import { PdfUserError, type PdfDocumentHandle } from "../pdf/types";
import { readPdfBytes, validatePdfHeader } from "../pdf/validation";
import { MAX_COMPRESSION_FILE_BYTES, MAX_COMPRESSION_PAGES, type CompressionRunner } from "./types";
import { validateCompressionPair } from "./validation";
import { optimizeInWorker, type CompressionWorkerResult } from "./worker-client";

/** Source File is never written; every parser and temporary buffer has one task owner. */
export const runCompression: CompressionRunner = async (file, mode, signal, onStage) => {
  signal.throwIfAborted();
  if (!file.size || file.size > MAX_COMPRESSION_FILE_BYTES) throw new PdfUserError("压缩输入必须为不超过 32 MiB 的 PDF。");
  const parser = new BrowserPdfEngine();
  const handles = new Set<PdfDocumentHandle>();
  let sourceBytes: Uint8Array | undefined;
  let result: CompressionWorkerResult | undefined;
  let accepted = false;
  let primaryFailure = false;
  const open = async (input: File) => {
    const handle = await parser.open(input, signal, () => {});
    handles.add(handle);
    signal.throwIfAborted();
    return handle;
  };
  const asFile = (bytes: Uint8Array) => new File([bytes as Uint8Array<ArrayBuffer>], "validation.pdf", { type: "application/pdf" });
  const releaseHandles = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const released = await Promise.race([
        Promise.allSettled([...handles].map((handle) => handle.destroy())),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 3000); }),
      ]);
      handles.clear();
      if (!released || released.some((item) => item.status === "rejected")) throw new PdfUserError("验证资源未能完整清理，未提供下载。请清空工作区后重试。");
    } finally { clearTimeout(timer); }
  };
  const finalCleanup = async () => {
    let cleanupFailure: unknown;
    try { await releaseHandles(); } catch (error) { cleanupFailure = error; }
    try { await parser.destroy(); } catch (error) { cleanupFailure ??= error; }
    if (cleanupFailure && !primaryFailure) {
      result?.bytes.fill(0);
      throw cleanupFailure;
    }
  };
  try {
    onStage("reading");
    sourceBytes = await readPdfBytes(file, signal);
    validatePdfHeader(sourceBytes);
    result = await optimizeInWorker(sourceBytes, mode, signal, onStage);
    sourceBytes = undefined;
    signal.throwIfAborted();
    if (!(result.bytes instanceof Uint8Array) || !result.bytes.length || result.bytes.length > MAX_COMPRESSION_FILE_BYTES ||
      result.pageCount < 1 || result.pageCount > MAX_COMPRESSION_PAGES) throw new PdfUserError("压缩结果超出安全范围，未提供下载。");
    validatePdfHeader(result.bytes);
    onStage("validating", result.pageCount);
    const source = await open(file);
    const output = await open(asFile(result.bytes));
    if (result.pageCount !== source.pages.length) throw new PdfUserError("压缩组件与独立解析器的页数不一致，未提供下载。");
    await validateCompressionPair(source, output, mode, signal, mode === "lossless" || result.changedImages === 0);
    await releaseHandles();
    if (mode !== "lossless" && result.changedImages > 0) {
      if (!(result.maskedSource instanceof Uint8Array) || !(result.maskedOutput instanceof Uint8Array) ||
        !result.maskedSource.length || !result.maskedOutput.length || result.maskedSource.length > MAX_COMPRESSION_FILE_BYTES ||
        result.maskedOutput.length > MAX_COMPRESSION_FILE_BYTES) throw new PdfUserError("缺少安全范围内非图像内容的独立验证数据，未提供下载。");
      const maskedSource = await open(asFile(result.maskedSource));
      const maskedOutput = await open(asFile(result.maskedOutput));
      await validateCompressionPair(maskedSource, maskedOutput, "lossless", signal, true);
      await releaseHandles();
    }
    await parser.destroy();
    signal.throwIfAborted();
    accepted = true;
    const methods = mode !== "lossless" && result.changedImages === 0 && result.methods.length === 0
      ? ["图像安全与收益检查：未重编码图像，保留原始字节"] : result.methods;
    return { bytes: result.bytes, pageCount: result.pageCount, methods,
      changedImages: result.changedImages, skippedImages: result.skippedImages,
      validationLabel: mode === "lossless" || result.changedImages === 0 ? "128/512 渲染、文字、几何与元数据严格校验通过"
        : "文字/结构/非图像严格校验及 128/512 图像质量检查通过" };
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    if (sourceBytes?.byteLength) sourceBytes.fill(0);
    if (!accepted) result?.bytes.fill(0);
    result?.maskedSource?.fill(0);
    result?.maskedOutput?.fill(0);
    await finalCleanup();
  }
};
