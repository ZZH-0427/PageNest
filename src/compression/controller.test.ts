import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfUserError } from "../pdf/types";
import { readPdfBytes } from "../pdf/validation";
import { PdfCompressionController } from "./controller";
import type { CompressionMode, CompressionRunner, CompressionRunResult } from "./types";

// Exercise retained-memory accounting without allocating production-sized buffers.
vi.mock("./types", async (original) => ({ ...await original<typeof import("./types")>(),
  MAX_COMPRESSION_FILE_BYTES: 512, MAX_COMPRESSION_WORKSPACE_BYTES: 1200, MAX_COMPRESSION_RESULT_BYTES: 256 }));

const controllers = new Set<PdfCompressionController>();
function pdfBytes(length = 80) {
  const bytes = new Uint8Array(length).fill(65);
  bytes.set(new TextEncoder().encode("%PDF-1.7\n").subarray(0, length));
  return bytes;
}
function file(length = 160, name = "artificial.pdf") {
  return new File([pdfBytes(length)], name, { type: "application/pdf" });
}
function result(length = 80): CompressionRunResult {
  return { bytes: pdfBytes(length), pageCount: 2, methods: ["对象流和内容流优化"], changedImages: 0,
    skippedImages: 0, validationLabel: "文字、几何与渲染通过独立校验" };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(runner: CompressionRunner = vi.fn(async () => result()), modes?: readonly CompressionMode[]) {
  let ordinal = 0;
  const downloads = { createUrl: vi.fn<(blob: Blob) => string>(() => `blob:artificial-${++ordinal}`),
    revokeUrl: vi.fn<(url: string) => void>(), trigger: vi.fn<(url: string, filename: string) => void>() };
  const controller = new PdfCompressionController(runner, downloads, modes);
  controllers.add(controller);
  return { controller, runner, downloads };
}
afterEach(() => { for (const c of controllers) c.dispose(); controllers.clear(); vi.useRealTimers(); });

describe("compression controller boundaries and metadata", () => {
  it("keeps the documented production safety limits separate from small test budgets", async () => {
    const actual = await vi.importActual<typeof import("./types")>("./types");
    expect([actual.MAX_COMPRESSION_FILES, actual.MAX_COMPRESSION_FILE_BYTES, actual.MAX_COMPRESSION_WORKSPACE_BYTES,
      actual.MAX_COMPRESSION_PAGES, actual.MAX_COMPRESSION_RESULT_BYTES, actual.COMPRESSION_TASK_TIMEOUT_MS,
      actual.COMPRESSION_URL_LIFETIME_MS]).toEqual([5, 32 * 1024 ** 2, 96 * 1024 ** 2, 200, 64 * 1024 ** 2, 180_000, 60_000]);
  });

  it("accepts original File capabilities, distinguishes same-name rows and does not run automatically", () => {
    const task = setup();
    task.controller.addFiles([file(), file()]);
    const rows = task.controller.getSnapshot().files;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.ordinal, row.name, row.status, row.pageCount])).toEqual([
      [1, "artificial.pdf", "queued", null], [2, "artificial.pdf", "queued", null],
    ]);
    expect(rows[0].id).not.toBe(rows[1].id);
    expect(task.runner).not.toHaveBeenCalled();
    expect(task.downloads.trigger).not.toHaveBeenCalled();
  });

  it.each([0, 513])("rejects invalid source size %s and keeps a valid neighbour", (size) => {
    const task = setup();
    task.controller.addFiles([file(size), file()]);
    expect(task.controller.getSnapshot().files).toHaveLength(1);
    expect(task.controller.getSnapshot().notice).toContain("32 MiB");
  });

  it("rejects non-PDF names before reading and enforces the five-file limit", () => {
    const task = setup();
    task.controller.addFiles([file(80, "artificial.txt"), ...Array.from({ length: 6 }, () => file(80))]);
    expect(task.controller.getSnapshot().files).toHaveLength(5);
    expect(task.controller.getSnapshot().notice).toContain("PDF 文件");
    expect(task.controller.getSnapshot().notice).toContain("5 份");
    expect(task.runner).not.toHaveBeenCalled();
  });

  it("enforces cumulative source bytes across separate imports and releases capacity on removal", () => {
    const task = setup();
    task.controller.addFiles([file(500), file(500)]);
    task.controller.addFiles([file(201), file(200)]);
    expect(task.controller.getSnapshot().files.map((row) => row.size)).toEqual([500, 500, 200]);
    expect(task.controller.getSnapshot().notice).toContain("96 MiB");
    task.controller.removeFile(task.controller.getSnapshot().files[0].id);
    task.controller.addFiles([file(500)]);
    expect(task.controller.getSnapshot().files).toHaveLength(3);
  });

  it("only enables known available modes and freezes every published metadata snapshot", () => {
    const task = setup(undefined, ["lossless", "balanced", "lossless"]);
    task.controller.addFiles([file()]);
    task.controller.setMode("high");
    expect(task.controller.getSnapshot().mode).toBe("lossless");
    expect(task.controller.getSnapshot().availableModes).toEqual(["lossless", "balanced"]);
    const snapshot = task.controller.getSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.files)).toBe(true);
    expect(Object.isFrozen(snapshot.files[0])).toBe(true);
  });

  it("does not start empty, unavailable, removed or unknown selections", async () => {
    const task = setup(undefined, []);
    task.controller.addFiles([file()]);
    await task.controller.startAll();
    expect(task.runner).not.toHaveBeenCalled();
    const empty = setup();
    await empty.controller.startAll();
    empty.controller.addFiles([file()]);
    await empty.controller.start("missing");
    expect(empty.runner).not.toHaveBeenCalled();
  });
});

describe("serial real-byte result accounting", () => {
  it("publishes actual stages, exact savings and independently retained PDF blobs without auto-downloading", async () => {
    const output = result();
    const source = file();
    const observations: string[] = [];
    const task = setup(vi.fn(async (captured, mode, signal, onStage) => {
      expect(captured).toBe(source);
      expect(mode).toBe("lossless");
      expect(signal.aborted).toBe(false);
      onStage("reading", 2); onStage("optimizing"); onStage("validating");
      return output;
    }));
    task.controller.subscribe(() => observations.push(task.controller.getSnapshot().files[0]?.status ?? "empty"));
    task.controller.addFiles([source]);
    await task.controller.startAll();
    const row = task.controller.getSnapshot().files[0];
    expect(observations).toEqual(expect.arrayContaining(["reading", "optimizing", "validating", "ready"]));
    expect(row).toMatchObject({ status: "ready", pageCount: 2, result: { outputBytes: 80, savedBytes: 80,
      reductionPercent: 50, fileName: "artificial_optimized.pdf", changedImages: 0, skippedImages: 0 } });
    expect(output.bytes.every((byte) => byte === 0)).toBe(true);
    expect(Object.isFrozen(row.result)).toBe(true);
    expect(Object.isFrozen(row.result?.methods)).toBe(true);
    expect(task.downloads.trigger).not.toHaveBeenCalled();
    task.controller.download(row.id);
    const blob = task.downloads.createUrl.mock.calls[0][0];
    expect(blob.size).toBe(80);
    expect([...await readPdfBytes(blob, new AbortController().signal)]).toEqual([...pdfBytes()]);
  });

  it.each([160, 200])("reports %s-byte non-smaller results without success or downloadable Blob", async (outputSize) => {
    const output = result(outputSize), task = setup(vi.fn(async () => output));
    task.controller.addFiles([file()]);
    await task.controller.startAll();
    const row = task.controller.getSnapshot().files[0];
    expect(row.status).toBe("no-benefit");
    expect(row.result).toMatchObject({ outputBytes: outputSize, savedBytes: 160 - outputSize,
      reductionPercent: (160 - outputSize) / 160 * 100 });
    task.controller.download(row.id);
    expect(task.downloads.createUrl).not.toHaveBeenCalled();
    expect(task.downloads.trigger).not.toHaveBeenCalled();
    expect(output.bytes.every((byte) => byte === 0)).toBe(true);
  });

  it("runs one file at a time and continues a later file after an isolated failure", async () => {
    const pending = deferred<CompressionRunResult>();
    const runner = vi.fn<CompressionRunner>().mockImplementationOnce(() => pending.promise)
      .mockRejectedValueOnce(new Error("synthetic text that must not escape"))
      .mockResolvedValueOnce(result());
    const task = setup(runner);
    task.controller.addFiles([file(), file(), file()]);
    const running = task.controller.startAll();
    expect(runner).toHaveBeenCalledTimes(1);
    pending.resolve(result());
    await running;
    expect(runner).toHaveBeenCalledTimes(3);
    expect(task.controller.getSnapshot().files.map((row) => row.status)).toEqual(["ready", "error", "ready"]);
    expect(task.controller.getSnapshot().files[1].error).not.toContain("synthetic text");
    expect(task.controller.getSnapshot().busy).toBe(false);
  });

  it("does not include a file added after the batch snapshot until a later explicit task", async () => {
    const pending = deferred<CompressionRunResult>();
    const runner = vi.fn<CompressionRunner>().mockImplementationOnce(() => pending.promise).mockResolvedValue(result());
    const task = setup(runner);
    task.controller.addFiles([file()]);
    const running = task.controller.startAll();
    task.controller.addFiles([file()]);
    pending.resolve(result()); await running;
    expect(runner).toHaveBeenCalledTimes(1);
    expect(task.controller.getSnapshot().files[1].status).toBe("queued");
    await task.controller.start(task.controller.getSnapshot().files[1].id);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("rejects cumulative retained output bytes while keeping other independently verified results", async () => {
    const task = setup(vi.fn(async () => result(90)));
    task.controller.addFiles([file(200), file(200), file(200)]);
    await task.controller.startAll();
    expect(task.controller.getSnapshot().files.map((row) => row.status)).toEqual(["ready", "ready", "error"]);
    expect(task.controller.getSnapshot().files[2].error).toContain("64 MiB");
    task.controller.removeFile(task.controller.getSnapshot().files[0].id);
    await task.controller.start(task.controller.getSnapshot().files[1].id);
    expect(task.controller.getSnapshot().files.map((row) => row.status)).toEqual(["ready", "ready"]);
  });

  it.each([0, 257])("rejects empty or oversized returned bytes (%s) and erases temporary output", async (length) => {
    const output = result(length), task = setup(vi.fn(async () => output));
    task.controller.addFiles([file(500)]); await task.controller.startAll();
    const row = task.controller.getSnapshot().files[0];
    expect(row.status).toBe("error"); expect(row.result).toBeNull();
    task.controller.download(row.id); expect(task.downloads.trigger).not.toHaveBeenCalled();
    expect(output.bytes.every((byte) => byte === 0)).toBe(true);
  });

  it.each([0, 201, Number.NaN, Infinity])("rejects invalid returned page counts (%s)", async (count) => {
    const output = { ...result(), pageCount: count }, task = setup(vi.fn(async () => output));
    task.controller.addFiles([file()]); await task.controller.startAll();
    expect(task.controller.getSnapshot().files[0].status).toBe("error");
    expect(output.bytes.every((byte) => byte === 0)).toBe(true);
  });

  it("enforces page count during inspection and rejects malformed validation metadata or PDF output", async () => {
    const runner = vi.fn<CompressionRunner>().mockImplementationOnce(async (_file, _mode, _signal, onStage) => {
      onStage("reading", 201); return result();
    }).mockResolvedValueOnce({ ...result(), methods: [] }).mockResolvedValueOnce({ ...result(), bytes: new Uint8Array(40) });
    const task = setup(runner);
    task.controller.addFiles([file(), file(), file()]); await task.controller.startAll();
    expect(task.controller.getSnapshot().files.map((row) => row.status)).toEqual(["error", "error", "error"]);
    expect(task.controller.getSnapshot().files[0].error).toContain("200 页");
  });

  it("preserves safe engine errors and replaces unknown or memory errors without raw details", async () => {
    const runner = vi.fn<CompressionRunner>().mockRejectedValueOnce(new PdfUserError("此结构暂不支持压缩。"))
      .mockRejectedValueOnce(new RangeError("private synthetic allocation details"));
    const task = setup(runner); task.controller.addFiles([file(), file()]); await task.controller.startAll();
    expect(task.controller.getSnapshot().files.map((row) => row.error)).toEqual([
      "此结构暂不支持压缩。", "浏览器可用内存不足，未保留结果。请使用更小或更简单的 PDF。",
    ]);
  });
});

describe("cancellation and stale result invalidation", () => {
  it("guards duplicate starts and freezes the active mode until the noninterruptible runner settles", async () => {
    const pending = deferred<CompressionRunResult>(), runner = vi.fn<CompressionRunner>(() => pending.promise);
    const task = setup(runner); task.controller.addFiles([file()]);
    const running = task.controller.startAll();
    task.controller.setMode("strong"); await task.controller.startAll();
    expect(task.controller.getSnapshot().mode).toBe("lossless");
    task.controller.cancel();
    expect(task.controller.getSnapshot().busy).toBe(true);
    await task.controller.startAll(); expect(runner).toHaveBeenCalledTimes(1);
    const output = result(); pending.resolve(output); await running;
    expect(task.controller.getSnapshot().files[0].status).toBe("cancelled");
    expect(task.controller.getSnapshot().busy).toBe(false);
    expect(output.bytes.every((byte) => byte === 0)).toBe(true);
  });

  it("cancels only one active file and continues the remaining selected batch", async () => {
    const pending = deferred<CompressionRunResult>();
    const runner = vi.fn<CompressionRunner>().mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(result());
    const task = setup(runner); task.controller.addFiles([file(), file()]);
    const running = task.controller.startAll(); task.controller.cancel(task.controller.getSnapshot().files[0].id);
    expect(runner.mock.calls[0][2].aborted).toBe(true);
    expect(task.controller.getSnapshot().busy).toBe(true);
    pending.resolve(result()); await running;
    expect(task.controller.getSnapshot().files.map((row) => row.status)).toEqual(["cancelled", "ready"]);
  });

  it("skips a cancelled pending file and never resurrects a removed active file", async () => {
    const pending = deferred<CompressionRunResult>(), runner = vi.fn<CompressionRunner>(() => pending.promise);
    const task = setup(runner); task.controller.addFiles([file(), file()]);
    const [first, second] = task.controller.getSnapshot().files;
    const running = task.controller.startAll(); task.controller.cancel(second.id); task.controller.removeFile(first.id);
    pending.resolve(result()); await running;
    expect(runner).toHaveBeenCalledTimes(1);
    expect(task.controller.getSnapshot().files).toHaveLength(1);
    expect(task.controller.getSnapshot().files[0]).toMatchObject({ id: second.id, status: "cancelled", result: null });
  });

  it("clear immediately releases sources/results but keeps the slot busy until late work finishes", async () => {
    const pending = deferred<CompressionRunResult>(), runner = vi.fn<CompressionRunner>(() => pending.promise);
    const task = setup(runner); task.controller.addFiles([file()]);
    const running = task.controller.startAll(); task.controller.clear();
    expect(task.controller.getSnapshot()).toMatchObject({ files: [], busy: true });
    task.controller.addFiles([file()]); await task.controller.startAll(); expect(runner).toHaveBeenCalledTimes(1);
    pending.resolve(result()); await running;
    expect(task.controller.getSnapshot()).toMatchObject({ busy: false, files: [{ status: "queued", result: null }] });
  });

  it("requests deadline cancellation but cannot claim an uninterruptible computation has stopped", async () => {
    vi.useFakeTimers();
    const pending = deferred<CompressionRunResult>(), runner = vi.fn<CompressionRunner>(() => pending.promise);
    const task = setup(runner); task.controller.addFiles([file()]);
    const running = task.controller.startAll(); await vi.advanceTimersByTimeAsync(180_000);
    expect(runner.mock.calls[0][2].aborted).toBe(true);
    expect(task.controller.getSnapshot().busy).toBe(true);
    pending.resolve(result()); await running;
    expect(task.controller.getSnapshot().files[0]).toMatchObject({ status: "error", error: expect.stringContaining("3 分钟"), result: null });
  });

  it("ignores late status callbacks and empties a disposed session without reopening a slot", async () => {
    const pending = deferred<CompressionRunResult>();
    let report!: Parameters<CompressionRunner>[3];
    const task = setup(vi.fn<CompressionRunner>((_file, _mode, _signal, onStage) => { report = onStage; return pending.promise; }));
    task.controller.addFiles([file()]); const running = task.controller.startAll(); task.controller.dispose();
    report("validating", 10); task.controller.addFiles([file()]); await task.controller.startAll();
    expect(task.controller.getSnapshot()).toMatchObject({ files: [], busy: true });
    pending.resolve(result()); await running; report("validating", 4);
    expect(task.controller.getSnapshot()).toMatchObject({ files: [], busy: false });
    task.controller.activate(); task.controller.addFiles([file()]);
    expect(task.controller.getSnapshot().files[0].status).toBe("queued");
  });

  it("releases every old result when an idle mode changes and refuses stale downloads", async () => {
    const task = setup(); task.controller.addFiles([file()]); await task.controller.startAll();
    const id = task.controller.getSnapshot().files[0].id;
    task.controller.download(id); task.controller.setMode("balanced"); task.controller.download(id);
    expect(task.downloads.revokeUrl).toHaveBeenCalledWith("blob:artificial-1");
    expect(task.downloads.trigger).toHaveBeenCalledTimes(1);
    expect(task.controller.getSnapshot()).toMatchObject({ mode: "balanced", files: [{ status: "queued", result: null }] });
  });
});

describe("download ownership and privacy", () => {
  it("replaces repeated download URLs, revokes them at 60 seconds and recreates only on user action", async () => {
    vi.useFakeTimers(); const task = setup(); task.controller.addFiles([file()]); await task.controller.startAll();
    const id = task.controller.getSnapshot().files[0].id;
    task.controller.download(id); task.controller.download(id);
    expect(task.downloads.revokeUrl).toHaveBeenCalledWith("blob:artificial-1");
    expect(task.downloads.createUrl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task.downloads.revokeUrl).toHaveBeenCalledWith("blob:artificial-2");
    task.controller.download(id); expect(task.downloads.createUrl).toHaveBeenCalledTimes(3);
    expect(task.controller.getSnapshot().notice).toContain("无法确认文件已保存");
  });

  it.each(["remove", "clear", "cancel", "dispose"])("invalidates result and live URL on %s", async (action) => {
    const task = setup(); task.controller.addFiles([file()]); await task.controller.startAll();
    const id = task.controller.getSnapshot().files[0].id; task.controller.download(id);
    if (action === "remove") task.controller.removeFile(id);
    else if (action === "clear") task.controller.clear();
    else if (action === "cancel") task.controller.cancel(id);
    else task.controller.dispose();
    task.controller.download(id);
    expect(task.downloads.revokeUrl).toHaveBeenCalledWith("blob:artificial-1");
    expect(task.downloads.trigger).toHaveBeenCalledTimes(1);
  });

  it("keeps a verified result retryable after a browser download failure without exposing raw errors", async () => {
    const task = setup(); task.controller.addFiles([file()]); await task.controller.startAll();
    task.downloads.trigger.mockImplementationOnce(() => { throw new Error("private synthetic browser details"); });
    const id = task.controller.getSnapshot().files[0].id; task.controller.download(id);
    expect(task.downloads.revokeUrl).toHaveBeenCalledWith("blob:artificial-1");
    expect(task.controller.getSnapshot().notice).toBe("未能触发下载，请检查浏览器下载权限后重试。");
    task.controller.download(id); expect(task.downloads.trigger).toHaveBeenCalledTimes(2);
    task.controller.dismissNotice(); expect(task.controller.getSnapshot().notice).toBeNull();
  });

  it("never mutates original File bytes, publishes document buffers or writes network/storage", async () => {
    const source = file();
    const original = await readPdfBytes(source, new AbortController().signal);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const xhr = vi.spyOn(XMLHttpRequest.prototype, "send");
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const database = { open: vi.fn() }; vi.stubGlobal("indexedDB", database);
    const task = setup(); task.controller.addFiles([source]); await task.controller.startAll();
    task.controller.download(task.controller.getSnapshot().files[0].id);
    const after = await readPdfBytes(source, new AbortController().signal);
    expect(after).toEqual(original);
    const values = (value: unknown): unknown[] => typeof value === "object" && value !== null
      ? [value, ...Object.values(value).flatMap(values)] : [value];
    expect(values(task.controller.getSnapshot()).some((value) => value instanceof File || value instanceof Blob || value instanceof Uint8Array || value instanceof ArrayBuffer)).toBe(false);
    expect(fetch).not.toHaveBeenCalled(); expect(xhr).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled(); expect(database.open).not.toHaveBeenCalled();
  });
});
