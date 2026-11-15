import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfOperationController, type PdfOperationSource } from "./operation-controller";
import { buildSplitPlan, type PdfOutputPlan } from "./output-plan";
import { createEditState, type PdfEditPage } from "./edit";
import type { PdfFileEntry } from "./types";
import { PdfExportDiagnosticError } from "./export-diagnostics";

// Exercise accounting at a small deterministic budget; production constants remain 100 MiB.
vi.mock("./output-plan", async (original) => ({ ...await original<typeof import("./output-plan")>(), MAX_PLAN_OUTPUT_BYTES: 64 }));

const pages = [1, 2, 3].map((number) => ({ number, width: 420, height: 594, rotation: 0, orientation: "portrait" as const }));
function plan(): PdfOutputPlan {
  const file: PdfFileEntry = { id: "source", name: "artificial.pdf", size: 100, ordinal: 1, status: "ready",
    pages, selectedPage: 1, edit: createEditState("source", pages), error: null };
  return buildSplitPlan(file, { kind: "every", every: 1 }, "parts");
}
const controllers = new Set<PdfOperationController>();
function setup(generate: PdfOperationSource["generate"] = vi.fn(async () => new Uint8Array([1, 2, 3]))) {
  const sourceController = new AbortController();
  const source: PdfOperationSource = { signal: sourceController.signal, generate };
  const capture = vi.fn<(plan: PdfOutputPlan) => PdfOperationSource>(() => source);
  let ordinal = 0;
  const environment = { createUrl: vi.fn(() => `blob:artificial-${++ordinal}`), revokeUrl: vi.fn(), trigger: vi.fn() };
  const controller = new PdfOperationController(capture, environment);
  controllers.add(controller);
  return { controller, capture, environment, sourceController, source };
}
beforeEach(() => vi.useRealTimers());
afterEach(() => { for (const controller of controllers) controller.cancel(); controllers.clear(); vi.useRealTimers(); });

describe("serial multi-output task ownership", () => {
  it("generates outputs serially and exposes only verified metadata without automatic downloads", async () => {
    const buffers: Uint8Array[] = [];
    let active = 0;
    const task = setup(vi.fn(async (_output, signal, onStage) => {
      expect(++active).toBe(1);
      expect(signal.aborted).toBe(false);
      onStage("generating");
      await Promise.resolve();
      onStage("validating");
      const bytes = new Uint8Array([1, 2, 3]); buffers.push(bytes);
      active--;
      return bytes;
    }));
    const input = plan();
    await task.controller.start(input);
    expect(task.source.generate).toHaveBeenCalledTimes(3);
    expect(task.controller.getSnapshot()).toMatchObject({ stage: "ready", busy: false, totalOutputs: 3, outputIndex: 3 });
    expect(task.controller.getSnapshot().results.map((r) => [r.fileName, r.pageCount, r.size])).toEqual(input.outputs.map((r) => [r.fileName, r.pages.length, 3]));
    expect(buffers.every((b) => b.every((value) => value === 0))).toBe(true);
    expect(task.environment.trigger).not.toHaveBeenCalled();
    expect(JSON.stringify(task.controller.getSnapshot())).not.toContain("bytes");
  });

  it("takes a frozen independent plan before asynchronous generation and ignores repeated starts", async () => {
    let resolve!: (value: Uint8Array) => void;
    const task = setup(vi.fn().mockImplementationOnce(() => new Promise((yes) => { resolve = yes; })).mockResolvedValue(new Uint8Array([4])));
    const mutable = structuredClone(plan()) as { mode: PdfOutputPlan["mode"]; sources: PdfOutputPlan["sources"];
      outputs: { id: string; fileName: string; rangeLabel: string; pages: PdfEditPage[] }[] };
    const running = task.controller.start(mutable);
    mutable.outputs.reverse();
    mutable.outputs[0].fileName = "different.pdf";
    await task.controller.start(plan());
    expect(task.capture).toHaveBeenCalledTimes(1);
    const captured = task.capture.mock.calls[0][0];
    expect(Object.isFrozen(captured.outputs[0].pages[0])).toBe(true);
    expect(captured.outputs.map((output) => output.fileName)).not.toContain("different.pdf");
    resolve(new Uint8Array([3]));
    await running;
    expect(task.controller.getSnapshot().stage).toBe("ready");
  });

  it("discards every prior result if a later PDF fails strict validation", async () => {
    const task = setup(vi.fn().mockResolvedValueOnce(new Uint8Array([1])).mockRejectedValueOnce(
      new PdfExportDiagnosticError("VISUAL_CONTENT_MISMATCH", { stage: "validating", item: "visual", outputPage: 1, sourcePage: 2 })));
    await task.controller.start(plan());
    expect(task.controller.getSnapshot()).toMatchObject({ stage: "error", busy: false, results: [], error: expect.stringContaining("VISUAL_CONTENT_MISMATCH") });
    task.controller.download(plan().outputs[0].id);
    expect(task.environment.trigger).not.toHaveBeenCalled();
  });

  it("rejects cumulative retained output bytes above budget and erases the failing temporary bytes", async () => {
    const buffers = [new Uint8Array(33), new Uint8Array(33)];
    buffers.forEach((b) => b.fill(9));
    const task = setup(vi.fn().mockResolvedValueOnce(buffers[0]).mockResolvedValueOnce(buffers[1]));
    await task.controller.start(plan());
    expect(task.controller.getSnapshot()).toMatchObject({ stage: "error", results: [], error: expect.stringContaining("累计超过") });
    expect(buffers.every((b) => b.every((v) => v === 0))).toBe(true);
    expect(task.source.generate).toHaveBeenCalledTimes(2);
  });

  it("does not let cancellation start another save until a non-interruptible generation settles", async () => {
    let finish!: (value: Uint8Array) => void;
    const task = setup(vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })));
    const pending = task.controller.start(plan());
    task.controller.cancel();
    expect(task.controller.getSnapshot()).toMatchObject({ stage: "cancelling", busy: true, results: [] });
    await task.controller.start(plan());
    expect(task.capture).toHaveBeenCalledTimes(1);
    const bytes = new Uint8Array([2]);
    finish(bytes);
    await pending;
    expect(bytes[0]).toBe(0);
    expect(task.controller.getSnapshot()).toMatchObject({ stage: "idle", busy: false, results: [] });
  });

  it("invalidates ready results and URLs as soon as a source file is removed", async () => {
    const task = setup();
    await task.controller.start(plan());
    task.controller.download(plan().outputs[0].id);
    expect(task.environment.trigger).toHaveBeenCalledTimes(1);
    task.sourceController.abort();
    expect(task.controller.getSnapshot()).toMatchObject({ stage: "idle", results: [] });
    expect(task.environment.revokeUrl).toHaveBeenCalledWith("blob:artificial-1");
    task.controller.download(plan().outputs[1].id);
    expect(task.environment.trigger).toHaveBeenCalledTimes(1);
  });

  it("uses bounded URL ownership and handles explicit downloads independently", async () => {
    vi.useFakeTimers();
    const task = setup();
    await task.controller.start(plan());
    const [first, second] = task.controller.getSnapshot().results;
    task.controller.download(first.id);
    task.controller.download(first.id);
    task.controller.download(second.id);
    expect(task.environment.createUrl).toHaveBeenCalledTimes(2);
    expect(task.environment.trigger).toHaveBeenCalledTimes(3);
    expect(task.controller.getSnapshot().results.map((r) => r.downloaded)).toEqual([true, true, false]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task.environment.revokeUrl).toHaveBeenCalledTimes(2);
    task.controller.cancel();
    expect(task.environment.revokeUrl).toHaveBeenCalledTimes(2);
  });

  it("revokes a failed download URL and permits a later user retry", async () => {
    const task = setup();
    await task.controller.start(plan());
    task.environment.trigger.mockImplementationOnce(() => { throw new Error("SYNTHETIC_PRIVATE_BROWSER_DETAILS"); });
    task.controller.download(plan().outputs[0].id);
    expect(task.controller.getSnapshot().error).not.toContain("PRIVATE");
    expect(task.environment.revokeUrl).toHaveBeenCalledWith("blob:artificial-1");
    task.controller.download(plan().outputs[0].id);
    expect(task.controller.getSnapshot().results[0].downloaded).toBe(true);
  });

  it("sanitizes unknown errors without logging content or exposing a failed result", async () => {
    const task = setup(async () => { throw new Error("SYNTHETIC_PRIVATE_DOCUMENT_BODY"); });
    await task.controller.start(plan());
    expect(task.controller.getSnapshot()).toMatchObject({ stage: "error", results: [] });
    expect(task.controller.getSnapshot().error).not.toContain("PRIVATE");
  });

  it("turns a validation deadline into a safe failure and releases the batch slot", async () => {
    vi.useFakeTimers();
    const task = setup(async (_output, signal, stage) => {
      stage("validating");
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const run = task.controller.start(plan());
    await vi.advanceTimersByTimeAsync(300_000);
    await run;
    expect(task.controller.getSnapshot()).toMatchObject({ stage: "error", busy: false, error: expect.stringContaining("VALIDATION_TIMEOUT") });
  });
});
