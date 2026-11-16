// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { optimizeInWorker, type CompressionWorkerResult } from "./worker-client";
import { MAX_COMPRESSION_FILE_BYTES, type CompressionMode } from "./types";

class WorkerDouble {
  static instances: WorkerDouble[] = [];
  static throws = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  transferred: unknown;
  terminate = vi.fn();
  postMessage = vi.fn((data: unknown, transfer: Transferable[]) => {
    this.transferred = structuredClone(data, { transfer });
  });
  constructor(readonly url: URL, readonly options: WorkerOptions) {
    if (WorkerDouble.throws) throw new Error("ARTIFICIAL_PRIVATE_ENGINE_LOCATION");
    WorkerDouble.instances.push(this);
  }
  message(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}
const valid = (patch: Record<string, unknown> = {}) => ({ type: "result", bytes: new Uint8Array([37, 80, 68, 70]),
  pageCount: 1, methods: ["PDF 对象流重新封装"], changedImages: 0, skippedImages: 0, ...patch });
const latest = () => WorkerDouble.instances.at(-1)!;
function start(mode: CompressionMode = "lossless", controller = new AbortController(), onStage = vi.fn()) {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const promise = optimizeInWorker(bytes, mode, controller.signal, onStage);
  return { bytes, promise, worker: latest(), controller, onStage };
}
beforeEach(() => { WorkerDouble.instances = []; WorkerDouble.throws = false; vi.stubGlobal("Worker", WorkerDouble); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("compression Worker transfer and lifecycle", () => {
  it("transfers owned input, accepts valid output and terminates the one-file Worker", async () => {
    const task = start(); expect(task.bytes.byteLength).toBe(0);
    expect(task.worker.options.type).toBe("module"); expect(task.worker.url.href).toContain("worker.ts");
    expect(task.worker.postMessage).toHaveBeenCalledOnce();
    task.worker.message({ type: "stage", stage: "optimizing", pageCount: 1 });
    expect(task.onStage).toHaveBeenCalledWith("optimizing", 1);
    const result = valid(); task.worker.message(result);
    expect(await task.promise).toBe(result as unknown as CompressionWorkerResult);
    expect(task.worker.terminate).toHaveBeenCalledOnce(); expect(task.worker.onmessage).toBeNull();
  });
  it("never starts a Worker for an already cancelled task", async () => {
    const controller = new AbortController(); controller.abort(new DOMException("Cancelled", "AbortError"));
    await expect(Promise.resolve().then(() => optimizeInWorker(new Uint8Array([1]), "lossless", controller.signal, vi.fn())))
      .rejects.toHaveProperty("name", "AbortError");
    expect(WorkerDouble.instances).toHaveLength(0);
  });
  it("cancels a running Worker promptly and ignores detached listeners", async () => {
    const task = start(); const failure = expect(task.promise).rejects.toHaveProperty("name", "AbortError");
    task.controller.abort(new DOMException("Cancelled", "AbortError")); await failure;
    expect(task.worker.terminate).toHaveBeenCalledOnce(); expect(task.worker.onmessage).toBeNull();
  });
  it("terminates a stalled Worker at the bounded deadline", async () => {
    vi.useFakeTimers(); const task = start(), failure = expect(task.promise).rejects.toThrow("压缩计算超时");
    await vi.advanceTimersByTimeAsync(150_001); await failure;
    expect(task.worker.terminate).toHaveBeenCalledOnce();
  });
  it("does not leak raw constructor errors and wipes untransferred input", async () => {
    WorkerDouble.throws = true; const bytes = new Uint8Array([1, 2, 3]);
    const error = await optimizeInWorker(bytes, "lossless", new AbortController().signal, vi.fn()).catch((value: unknown) => value) as Error;
    expect(error.message).toContain("无法启动本地压缩 Worker"); expect(error.message).not.toContain("ARTIFICIAL_PRIVATE");
    expect(Array.from(bytes)).toEqual([0, 0, 0]);
  });
  it("replaces a raw resource-loading error with the fixed safe message", async () => {
    const task = start(), failure = expect(task.promise).rejects.toThrow("动态资源加载失败"), preventDefault = vi.fn();
    task.worker.onerror?.({ message: "ARTIFICIAL_PRIVATE_DOCUMENT_MARKER", error: new Error("ARTIFICIAL_PRIVATE_DOCUMENT_MARKER"), preventDefault } as unknown as ErrorEvent);
    await failure; expect(preventDefault).toHaveBeenCalledOnce(); expect(task.worker.terminate).toHaveBeenCalledOnce();
  });
  it("fails closed on message decoding errors", async () => {
    const task = start(), failure = expect(task.promise).rejects.toThrow("通信失败");
    task.worker.onmessageerror?.(); await failure; expect(task.worker.terminate).toHaveBeenCalledOnce();
  });
  it("terminates if the task's stage observer has become invalid", async () => {
    const task = start("lossless", new AbortController(), vi.fn(() => { throw new Error("ARTIFICIAL_PRIVATE_OBSERVER"); }));
    const failure = expect(task.promise).rejects.toThrow("任务状态已失效");
    task.worker.message({ type: "stage", stage: "optimizing", pageCount: 1 }); await failure;
    expect(task.worker.terminate).toHaveBeenCalledOnce();
  });
  it("does not send document bytes through fetch or browser storage", async () => {
    const fetch = vi.fn(() => { throw new Error("Unexpected fetch"); }), storage = { setItem: vi.fn(), getItem: vi.fn() };
    vi.stubGlobal("fetch", fetch); vi.stubGlobal("localStorage", storage); vi.stubGlobal("indexedDB", { open: vi.fn() });
    const task = start(); task.worker.message(valid()); await task.promise;
    expect(fetch).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled();
    expect(indexedDB.open).not.toHaveBeenCalled();
  });
});

describe("compression Worker result protocol fails closed", () => {
  it.each([
    { label: "negative image count", mode: "balanced", patch: { changedImages: -1 } },
    { label: "fractional page count", mode: "lossless", patch: { pageCount: 1.5 } },
    { label: "zero pages", mode: "lossless", patch: { pageCount: 0 } },
    { label: "over 200 pages", mode: "lossless", patch: { pageCount: 201 } },
    { label: "over 100 image objects", mode: "balanced", patch: { skippedImages: 101 } },
    { label: "combined image budget", mode: "balanced", patch: { changedImages: 1, skippedImages: 100 } },
    { label: "changed images in lossless mode", mode: "lossless", patch: { changedImages: 1 } },
    { label: "lossy without masked controls", mode: "balanced", patch: { changedImages: 1 } },
    { label: "masked control wrong type", mode: "balanced", patch: { changedImages: 1, maskedSource: "bytes", maskedOutput: new Uint8Array([1]) } },
    { label: "empty output", mode: "lossless", patch: { bytes: new Uint8Array() } },
    { label: "oversized method text", mode: "lossless", patch: { methods: ["x".repeat(240)] } },
    { label: "too many method records", mode: "lossless", patch: { methods: Array.from({ length: 9 }, () => "method") } },
    { label: "missing method list", mode: "lossless", patch: { methods: undefined } },
    { label: "lossy change without method evidence", mode: "high", patch: { methods: [], changedImages: 1, maskedSource: new Uint8Array([1]), maskedOutput: new Uint8Array([1]) } },
  ] as const)("rejects $label and wipes received output", async ({ mode, patch }) => {
    const task = start(mode), result = valid(patch), failure = expect(task.promise).rejects.toThrow("无法验证的结果");
    task.worker.message(result); await failure;
    if (result.bytes instanceof Uint8Array) expect(result.bytes.every((value) => value === 0)).toBe(true);
    expect(task.worker.terminate).toHaveBeenCalledOnce();
  });
  it("rejects oversized output even if all other metadata is valid", async () => {
    const task = start(), result = valid({ bytes: new Uint8Array(MAX_COMPRESSION_FILE_BYTES + 1) });
    const failure = expect(task.promise).rejects.toThrow("无法验证的结果"); task.worker.message(result); await failure;
    expect(result.bytes.every((value) => value === 0)).toBe(true);
  });
  it("accepts bounded lossy output only with both masked validation candidates", async () => {
    const task = start("balanced"), result = valid({ changedImages: 1, skippedImages: 2,
      maskedSource: new Uint8Array([1, 2]), maskedOutput: new Uint8Array([3, 4]) });
    task.worker.message(result); expect(await task.promise).toBe(result as unknown as CompressionWorkerResult);
    expect(task.worker.terminate).toHaveBeenCalledOnce();
  });
  it("rejects a wholly unknown message", async () => {
    const task = start(), failure = expect(task.promise).rejects.toThrow("无法验证的结果"); task.worker.message({ type: "unknown" }); await failure;
  });
});
