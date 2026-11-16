/// <reference lib="webworker" />
import { optimizeJpegPdf } from "./image-codec";
import { optimizeLosslessPdf } from "./lossless-engine";
import { inspectCompressionSource } from "./policy";
import { PdfUserError } from "../pdf/types";
import { COMPRESSION_MODES, MAX_COMPRESSION_FILE_BYTES, type CompressionMode } from "./types";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let active = false;
scope.onmessage = async (event: MessageEvent<{ mode: CompressionMode; bytes: Uint8Array }>) => {
  if (active) return;
  active = true;
  const input = event.data.bytes;
  const scratch: Uint8Array[] = [];
  try {
    if (!(input instanceof Uint8Array) || !COMPRESSION_MODES.includes(event.data.mode)) throw new PdfUserError("无效的压缩任务。");
    const signal = new AbortController().signal;
    const pageCount = await inspectCompressionSource(input, signal);
    scope.postMessage({ type: "stage", stage: "optimizing", pageCount });
    const result = event.data.mode === "lossless" ? await optimizeLosslessPdf(input, signal) : await optimizeJpegPdf(input, event.data.mode, signal);
    scratch.push(result.bytes);
    const masked = "maskedSource" in result ? { maskedSource: result.maskedSource, maskedOutput: result.maskedOutput } : {};
    if (masked.maskedSource) scratch.push(masked.maskedSource);
    if (masked.maskedOutput) scratch.push(masked.maskedOutput);
    if (scratch.some((bytes) => !bytes.byteLength || bytes.byteLength > MAX_COMPRESSION_FILE_BYTES)) throw new PdfUserError("生成或验证文件超过 32 MiB 限制。");
    scope.postMessage({ type: "result", pageCount, bytes: result.bytes, methods: result.methods,
      changedImages: "changedImages" in result ? result.changedImages : 0,
      skippedImages: "skippedImages" in result ? result.skippedImages : 0, ...masked }, scratch.map((bytes) => bytes.buffer as ArrayBuffer));
  } catch (error) {
    scope.postMessage({ type: "error", message: error instanceof PdfUserError ? error.message
      : "压缩组件无法处理此文件或当前资源不足，未提供下载。原始文件保持不变。" });
  } finally {
    if (input?.byteLength) input.fill(0);
    for (const bytes of scratch) if (bytes.byteLength) bytes.fill(0);
    scope.close();
  }
};
