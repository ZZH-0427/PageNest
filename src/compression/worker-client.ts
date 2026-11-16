import { PdfUserError } from "../pdf/types";
import { MAX_COMPRESSION_FILE_BYTES, MAX_COMPRESSION_PAGES, type CompressionMode, type CompressionStage } from "./types";

export interface CompressionWorkerResult {
  bytes: Uint8Array; pageCount: number; methods: string[]; changedImages: number; skippedImages: number;
  maskedSource?: Uint8Array; maskedOutput?: Uint8Array;
}

/** Each file owns one short-lived Worker; termination also cancels native codec work. */
export function optimizeInWorker(bytes: Uint8Array, mode: CompressionMode, signal: AbortSignal,
  onStage: (stage: CompressionStage, pageCount?: number) => void): Promise<CompressionWorkerResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try { worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "PageNest PDF compression" }); }
    catch { bytes.fill(0); reject(new PdfUserError("无法启动本地压缩 Worker，请使用支持 Web Worker 的现代浏览器。")); return; }
    let settled = false;
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
    };
    const failure = (error: unknown) => { if (!settled) { settled = true; finish(); reject(error); } };
    const cancel = () => failure(signal.reason);
    const timer = setTimeout(() => failure(new PdfUserError("压缩计算超时，已停止并释放 Worker。请使用更小或更简单的 PDF。")), 150_000);
    signal.addEventListener("abort", cancel, { once: true });
    worker.onerror = (event) => { event.preventDefault(); failure(new PdfUserError("压缩 Worker 或动态资源加载失败，请保留原件并刷新后重试。")); };
    worker.onmessageerror = () => failure(new PdfUserError("压缩组件通信失败，未提供下载。"));
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data;
      const erase = () => { for (const value of [data?.bytes, data?.maskedSource, data?.maskedOutput]) if (value instanceof Uint8Array && value.byteLength) value.fill(0); };
      const validBytes = (value: unknown) => value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= MAX_COMPRESSION_FILE_BYTES;
      const count = (value: unknown, limit: number, minimum = 0) => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= limit;
      if (data?.type === "stage" && data.stage === "optimizing" && count(data.pageCount, MAX_COMPRESSION_PAGES, 1)) {
        try { onStage("optimizing", data.pageCount); } catch { failure(new PdfUserError("任务状态已失效，已停止压缩。")); }
        return;
      }
      if (data?.type === "error") { failure(new PdfUserError(typeof data.message === "string" && data.message.length <= 500 ? data.message : "压缩失败，未提供下载。")); return; }
      if (data?.type !== "result" || !validBytes(data.bytes) || !Array.isArray(data.methods) || data.methods.length > 8 ||
        !data.methods.every((value: unknown) => typeof value === "string" && value.length < 240) ||
        !count(data.pageCount, MAX_COMPRESSION_PAGES, 1) || !count(data.changedImages, 100) || !count(data.skippedImages, 100) ||
        data.changedImages + data.skippedImages > 100 || mode === "lossless" && data.changedImages !== 0 ||
        data.changedImages > 0 && (!validBytes(data.maskedSource) || !validBytes(data.maskedOutput) || data.methods.length === 0) ||
        data.maskedSource !== undefined && !validBytes(data.maskedSource) || data.maskedOutput !== undefined && !validBytes(data.maskedOutput)) {
        erase();
        failure(new PdfUserError("压缩组件返回了无法验证的结果，未提供下载。")); return;
      }
      if (settled) { erase(); return; }
      settled = true; finish(); resolve(data as CompressionWorkerResult);
    };
    try { worker.postMessage({ mode, bytes }, [bytes.buffer as ArrayBuffer]); }
    catch { if (bytes.byteLength) bytes.fill(0); failure(new PdfUserError("无法向本地压缩 Worker 传递文件，未提供下载。")); }
    if (signal.aborted) cancel();
  });
}
