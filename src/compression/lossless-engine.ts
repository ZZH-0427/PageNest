import { loadPdfLibrary } from "../pdf/pdf-library";
import { isCancellation, PdfUserError } from "../pdf/types";
import { validatePdfHeader } from "../pdf/validation";

export const LOSSLESS_MAX_INPUT_BYTES = 32 * 1024 ** 2;
export const LOSSLESS_MAX_OUTPUT_BYTES = 32 * 1024 ** 2;
export const LOSSLESS_MAX_PAGES = 200;
export const LOSSLESS_MAX_STREAM_BYTES = 16 * 1024 ** 2;
export const LOSSLESS_MAX_TOTAL_STREAM_BYTES = 64 * 1024 ** 2;

export interface LosslessOptimizationResult {
  bytes: Uint8Array;
  methods: string[];
  recompressedStreams: number;
  decodedStreamBytes: number;
  skippedStreams: number;
  elapsedMs: number;
}

/** Reads transformed chunks within the budget; partial private buffers never escape on error. */
async function transform(input: Uint8Array, mode: "encode" | "decode", limit: number, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  const codec = mode === "decode" ? new DecompressionStream("deflate") : new CompressionStream("deflate");
  const reader = new Blob([input as Uint8Array<ArrayBuffer>]).stream().pipeThrough(codec).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let completed = false;
  let pending: Uint8Array | undefined;
  let output: Uint8Array | undefined;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      pending = value;
      signal.throwIfAborted();
      if (done) break;
      if (value.byteLength > limit - length) {
        value.fill(0);
        throw new PdfUserError("PDF 解压数据超过安全预算，未提供优化结果（单条最多 16 MiB，累计最多 64 MiB）。");
      }
      length += value.byteLength;
      chunks.push(value);
      pending = undefined;
    }
    output = new Uint8Array(length);
    let position = 0;
    for (const chunk of chunks) { output.set(chunk, position); position += chunk.byteLength; }
    signal.throwIfAborted();
    completed = true;
    return output;
  } finally {
    signal.removeEventListener("abort", abort);
    pending?.fill(0);
    if (!completed) output?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
    if (!completed) { try { await reader.cancel(); } catch { /* retain the original safe failure */ } }
    reader.releaseLock();
  }
}

/** Generate a candidate only. Independent source/output validation and download belong to the caller. */
export async function optimizeLosslessPdf(input: Uint8Array, signal: AbortSignal): Promise<LosslessOptimizationResult> {
  const started = performance.now();
  let result: Uint8Array | undefined;
  let accepted = false;
  const retainedReplacements: Uint8Array[] = [];
  try {
    signal.throwIfAborted();
    if (!(input instanceof Uint8Array) || !input.byteLength || input.byteLength > LOSSLESS_MAX_INPUT_BYTES) {
      throw new PdfUserError("优化输入不可用或超过 32 MiB，请选择较小的 PDF。");
    }
    if (typeof CompressionStream !== "function" || typeof DecompressionStream !== "function") {
      throw new PdfUserError("当前浏览器缺少本地压缩流 API，无法执行无损优化。");
    }
    validatePdfHeader(input.subarray(0, 1024));
    const library = await loadPdfLibrary();
    signal.throwIfAborted();
    const { PDFDocument, PDFName, PDFArray, PDFRawStream } = library;
    const document = await PDFDocument.load(input, { updateMetadata: false, ignoreEncryption: false, throwOnInvalidObject: true });
    signal.throwIfAborted();
    if (document.getPageCount() < 1 || document.getPageCount() > LOSSLESS_MAX_PAGES) {
      throw new PdfUserError("无损优化支持 1 至 200 页 PDF，请减少页数后重试。");
    }
    let recompressedStreams = 0;
    let decodedStreamBytes = 0;
    let skippedStreams = 0;
    const filterKey = PDFName.of("Filter");
    const flate = PDFName.of("FlateDecode");
    const shortFlate = PDFName.of("Fl");
    for (const [reference, object] of document.context.enumerateIndirectObjects()) {
      signal.throwIfAborted();
      if (!(object instanceof PDFRawStream)) continue;
      let filter = document.context.lookup(object.dict.get(filterKey));
      if (filter instanceof PDFArray && filter.size() === 1) filter = document.context.lookup(filter.get(0));
      if (filter !== flate && filter !== shortFlate) { skippedStreams++; continue; }
      // Decompress only the Flate envelope. Predictor bytes and DecodeParms stay unchanged.
      const decoded = await transform(object.getContents(), "decode",
        Math.min(LOSSLESS_MAX_STREAM_BYTES, LOSSLESS_MAX_TOTAL_STREAM_BYTES - decodedStreamBytes), signal);
      decodedStreamBytes += decoded.byteLength;
      let encoded: Uint8Array | undefined;
      try {
        signal.throwIfAborted();
        encoded = await transform(decoded, "encode", LOSSLESS_MAX_OUTPUT_BYTES, signal);
        signal.throwIfAborted();
        if (encoded.byteLength < object.getContents().byteLength) {
          document.context.assign(reference, PDFRawStream.of(object.dict.clone(document.context), encoded));
          retainedReplacements.push(encoded);
          encoded = undefined;
          recompressedStreams++;
        }
      } finally { decoded.fill(0); encoded?.fill(0); }
    }
    signal.throwIfAborted();
    result = await document.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: 20 });
    signal.throwIfAborted();
    if (!result.byteLength || result.byteLength > LOSSLESS_MAX_OUTPUT_BYTES) {
      throw new PdfUserError("优化结果为空或超过 32 MiB，未提供下载。");
    }
    validatePdfHeader(result.subarray(0, 1024));
    const methods = ["PDF 对象流重新封装"];
    if (recompressedStreams) methods.push(`Flate 流重新压缩（${recompressedStreams} 条更小流）`);
    accepted = true;
    return { bytes: result, methods, recompressedStreams, decodedStreamBytes, skippedStreams, elapsedMs: performance.now() - started };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (isCancellation(error) || error instanceof PdfUserError) throw error;
    throw new PdfUserError("无法可靠完成 PDF 流与结构优化，文件可能损坏或包含不支持的压缩流。未提供下载。");
  } finally {
    for (const bytes of retainedReplacements) bytes.fill(0);
    if (!accepted) result?.fill(0);
  }
}
