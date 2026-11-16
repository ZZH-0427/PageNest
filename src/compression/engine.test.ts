import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfUserError, type PdfDocumentHandle } from "../pdf/types";
import { runCompression } from "./engine";
import type { CompressionWorkerResult } from "./worker-client";
import { PdfCompressionController } from "./controller";

const mocks = vi.hoisted(() => ({ open: vi.fn(), destroy: vi.fn(), optimize: vi.fn(), validate: vi.fn(), read: vi.fn() }));
vi.mock("../pdf/browser-engine", () => ({ BrowserPdfEngine: class {
  open(...args: unknown[]) { return mocks.open(...args); }
  destroy() { return mocks.destroy(); }
} }));
vi.mock("./worker-client", () => ({ optimizeInWorker: mocks.optimize }));
vi.mock("./validation", () => ({ validateCompressionPair: mocks.validate }));
vi.mock("../pdf/validation", async (original) => ({ ...await original<typeof import("../pdf/validation")>(), readPdfBytes: mocks.read }));

function bytes(size = 80) { const result = new Uint8Array(size).fill(65); result.set(new TextEncoder().encode("%PDF-1.7\n")); return result; }
function source() { return new File([bytes(160)], "artificial-source.pdf", { type: "application/pdf" }); }
function document(): PdfDocumentHandle {
  return { pages: [{ number: 1, width: 420, height: 594, rotation: 0, orientation: "portrait" }],
    render: vi.fn(async () => {}), destroy: vi.fn(async () => {}) };
}
function setup(changedImages = 0) {
  const handles = [document(), document(), document(), document()]; let opened = 0;
  mocks.open.mockImplementation(async () => handles[opened++]);
  const result: CompressionWorkerResult = { bytes: bytes(), pageCount: 1, methods: ["人工优化测试"], changedImages, skippedImages: 0,
    ...(changedImages ? { maskedSource: bytes(64), maskedOutput: bytes(64) } : {}) };
  mocks.optimize.mockImplementation(async (input: Uint8Array) => {
    // Mimic the Worker transfer capability rather than retaining a live source buffer in a mock.
    const transferred = structuredClone(input, { transfer: [input.buffer] }); transferred.fill(0); return result;
  });
  return { handles, result, file: source() };
}
beforeEach(() => { vi.clearAllMocks(); mocks.read.mockImplementation(async () => bytes(160)); mocks.destroy.mockResolvedValue(undefined); mocks.validate.mockResolvedValue(undefined); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const cleared = (value?: Uint8Array) => !value || value.every((byte) => byte === 0);

describe("compression runner independent validation ownership", () => {
  it("opens fresh source/output handles and retains output only after exact validation and cleanup", async () => {
    const task = setup(); const stages = vi.fn();
    const result = await runCompression(task.file, "lossless", new AbortController().signal, stages);
    expect(result.bytes).toBe(task.result.bytes); expect(cleared(result.bytes)).toBe(false);
    expect(mocks.open.mock.calls[0][0]).toBe(task.file); expect(mocks.open.mock.calls[1][0]).not.toBe(task.file);
    expect(mocks.validate).toHaveBeenCalledWith(task.handles[0], task.handles[1], "lossless", expect.any(AbortSignal), true);
    expect(task.handles[0].destroy).toHaveBeenCalled(); expect(task.handles[1].destroy).toHaveBeenCalled(); expect(mocks.destroy).toHaveBeenCalled();
    expect(stages.mock.calls.map((call) => call[0])).toEqual(["reading", "validating"]);
  });
  it("requires normal quality validation and a separate exact masked control pair for lossy output", async () => {
    const task = setup(1), currentSignal = new AbortController().signal;
    await runCompression(task.file, "balanced", currentSignal, vi.fn());
    expect(mocks.open).toHaveBeenCalledTimes(4);
    expect(mocks.validate.mock.calls).toEqual([
      [task.handles[0], task.handles[1], "balanced", currentSignal, false],
      [task.handles[2], task.handles[3], "lossless", currentSignal, true],
    ]);
    expect(cleared(task.result.bytes)).toBe(false); expect(cleared(task.result.maskedSource)).toBe(true); expect(cleared(task.result.maskedOutput)).toBe(true);
    expect(task.handles.every((handle) => vi.mocked(handle.destroy).mock.calls.length > 0)).toBe(true);
  });
  it("uses exact rendering if an image mode changes no admitted JPEG", async () => {
    const task = setup(); await runCompression(task.file, "strong", new AbortController().signal, vi.fn());
    expect(mocks.validate.mock.calls[0][4]).toBe(true); expect(mocks.open).toHaveBeenCalledTimes(2);
  });
  it("classifies a validated unchanged image-mode result as no benefit through the real controller", async () => {
    const task = setup(); task.result.bytes = bytes(160); task.result.methods = []; task.result.skippedImages = 1;
    const downloads = { createUrl: vi.fn(() => "blob:artificial"), revokeUrl: vi.fn(), trigger: vi.fn() };
    const controller = new PdfCompressionController(runCompression, downloads, ["high"]);
    try {
      controller.addFiles([task.file]);
      await controller.startAll();
      const row = controller.getSnapshot().files[0];
      expect(row.status).toBe("no-benefit");
      expect(row.error).toBeNull();
      expect(row.result).toMatchObject({ outputBytes: 160, savedBytes: 0, reductionPercent: 0, skippedImages: 1,
        methods: ["图像安全与收益检查：未重编码图像，保留原始字节"] });
      expect(mocks.validate.mock.calls[0][4]).toBe(true);
      expect(cleared(task.result.bytes)).toBe(true);
      controller.download(row.id);
      expect(downloads.createUrl).not.toHaveBeenCalled(); expect(downloads.trigger).not.toHaveBeenCalled();
    } finally { controller.dispose(); }
  });
  it("rejects missing masked output and erases all generated bytes", async () => {
    const task = setup(1); task.result.maskedOutput = undefined;
    await expect(runCompression(task.file, "high", new AbortController().signal, vi.fn())).rejects.toThrow("非图像内容");
    expect(cleared(task.result.bytes)).toBe(true); expect(cleared(task.result.maskedSource)).toBe(true); expect(mocks.open).toHaveBeenCalledTimes(2);
  });
  it("does not accept a worker-reported count differing from independent parsed pages", async () => {
    const task = setup(); task.result.pageCount = 2;
    await expect(runCompression(task.file, "lossless", new AbortController().signal, vi.fn())).rejects.toThrow();
    expect(cleared(task.result.bytes)).toBe(true);
  });
  it.each(["normal", "masked"])("erases output if %s validation fails", async (phase) => {
    const task = setup(1), failure = new PdfUserError("ARTIFICIAL_VALIDATION_FAILURE");
    if (phase === "masked") mocks.validate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
    else mocks.validate.mockRejectedValueOnce(failure);
    await expect(runCompression(task.file, "balanced", new AbortController().signal, vi.fn())).rejects.toBe(failure);
    expect(cleared(task.result.bytes)).toBe(true); expect(cleared(task.result.maskedSource)).toBe(true); expect(cleared(task.result.maskedOutput)).toBe(true);
    expect(mocks.destroy).toHaveBeenCalled();
  });
  it("preserves the original validation error if handle cleanup also rejects", async () => {
    const task = setup(), failure = new PdfUserError("ARTIFICIAL_PRIMARY_VALIDATION_FAILURE");
    mocks.validate.mockRejectedValueOnce(failure); vi.mocked(task.handles[0].destroy).mockRejectedValue(new Error("artificial cleanup failure"));
    await expect(runCompression(task.file, "lossless", new AbortController().signal, vi.fn())).rejects.toBe(failure);
    expect(cleared(task.result.bytes)).toBe(true); expect(mocks.destroy).toHaveBeenCalled();
  });
  it("refuses successful content if resource cleanup fails", async () => {
    const task = setup(); vi.mocked(task.handles[0].destroy).mockRejectedValue(new Error("artificial cleanup failure"));
    await expect(runCompression(task.file, "lossless", new AbortController().signal, vi.fn())).rejects.toThrow("清理");
    expect(cleared(task.result.bytes)).toBe(true); expect(mocks.destroy).toHaveBeenCalled();
  });
  it("bounds an unresponsive validation handle cleanup and terminates the parser", async () => {
    vi.useFakeTimers(); const task = setup(); vi.mocked(task.handles[0].destroy).mockImplementation(() => new Promise(() => {}));
    const completion = runCompression(task.file, "lossless", new AbortController().signal, vi.fn()).then(() => null, (error: unknown) => error);
    await vi.waitFor(() => expect(mocks.validate).toHaveBeenCalled()); await vi.advanceTimersByTimeAsync(3100);
    expect(await completion).toBeInstanceOf(PdfUserError); expect(cleared(task.result.bytes)).toBe(true); expect(mocks.destroy).toHaveBeenCalled();
  });
  it("cleans a late-opened handle when cancellation occurs before it is accepted", async () => {
    const task = setup(1), controller = new AbortController(); let opened = 0;
    mocks.open.mockImplementation(async () => { const handle = task.handles[opened++]; if (opened === 4) controller.abort(); return handle; });
    await expect(runCompression(task.file, "balanced", controller.signal, vi.fn())).rejects.toThrow();
    expect(task.handles[3].destroy).toHaveBeenCalled(); expect(cleared(task.result.bytes)).toBe(true); expect(cleared(task.result.maskedOutput)).toBe(true);
  });
  it("rejects worker errors or invalid output headers without opening parsers", async () => {
    const task = setup(); task.result.bytes.fill(0);
    await expect(runCompression(task.file, "lossless", new AbortController().signal, vi.fn())).rejects.toThrow();
    expect(mocks.open).not.toHaveBeenCalled(); expect(mocks.destroy).toHaveBeenCalled();
    mocks.optimize.mockRejectedValueOnce(new PdfUserError("ARTIFICIAL_WORKER_FAILURE"));
    await expect(runCompression(task.file, "lossless", new AbortController().signal, vi.fn())).rejects.toThrow("ARTIFICIAL_WORKER_FAILURE");
  });
  it("does not transmit documents or persist content through the runner lifecycle", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected transfer"));
    const xhr = vi.spyOn(XMLHttpRequest.prototype, "send"), storage = vi.spyOn(Storage.prototype, "setItem");
    const database = vi.fn(), socket = vi.fn(), beacon = vi.fn();
    vi.stubGlobal("indexedDB", { open: database }); vi.stubGlobal("WebSocket", socket); vi.stubGlobal("navigator", { sendBeacon: beacon });
    const task = setup(); await runCompression(task.file, "lossless", new AbortController().signal, vi.fn());
    for (const operation of [fetch, xhr, storage, database, socket, beacon]) expect(operation).not.toHaveBeenCalled();
  });
});
