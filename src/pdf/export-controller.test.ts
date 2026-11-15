import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfExportController, type PdfDownloadEnvironment, type PdfExportSource } from "./export-controller";
import { PdfExportDiagnosticError } from "./export-diagnostics";
import { PdfUserError } from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const controllers: PdfExportController[] = [];
afterEach(() => { controllers.splice(0).forEach((controller) => controller.cancel()); vi.useRealTimers(); });

function setup(generate?: PdfExportSource["generate"]) {
  const lifetime = new AbortController();
  const source: PdfExportSource = {
    documentId: "synthetic", sourceName: "synthetic.pdf", pageCount: 3, signal: lifetime.signal,
    generate: vi.fn(generate ?? (async (_signal, stage) => { stage("generating"); stage("validating"); return new Uint8Array([37, 80, 68, 70]); })),
  };
  const download: PdfDownloadEnvironment = { createUrl: vi.fn(() => "blob:synthetic"), revokeUrl: vi.fn(), trigger: vi.fn() };
  const capture = vi.fn(() => source);
  const controller = new PdfExportController(capture, download);
  controllers.push(controller);
  return { controller, source, lifetime, download, capture };
}

describe("export lifecycle and download ownership", () => {
  it("publishes real stages, retains only metadata in snapshots, and requires a separate download gesture", async () => {
    const { controller, download } = setup();
    const stages: string[] = [];
    controller.subscribe(() => stages.push(controller.getSnapshot().stage));
    await controller.start("synthetic", "edited.pdf");
    expect(stages).toEqual(["preparing", "preparing", "generating", "validating", "ready"]);
    expect(download.createUrl).not.toHaveBeenCalled();
    expect(Object.keys(controller.getSnapshot()).sort()).toEqual(["busy", "documentId", "error", "fileName", "pageCount", "sourceName", "stage"].sort());
    controller.download();
    expect(download.trigger).toHaveBeenCalledWith("blob:synthetic", "edited.pdf");
    expect(controller.getSnapshot().stage).toBe("downloaded");
    controller.download();
    expect(download.trigger).toHaveBeenCalledTimes(1);
  });

  it("rejects concurrent starts without capturing another document", async () => {
    const pending = deferred<Uint8Array>();
    const { controller, capture } = setup(async () => pending.promise);
    const first = controller.start("synthetic", "one.pdf");
    await controller.start("other", "two.pdf");
    controller.download();
    expect(capture).toHaveBeenCalledTimes(1);
    pending.resolve(new Uint8Array([1]));
    await first;
    expect(controller.getSnapshot().fileName).toBe("one.pdf");
  });

  it.each(["cancel", "remove"])("%s invalidates a late save while holding the concurrency slot", async (action) => {
    const pending = deferred<Uint8Array>();
    const { controller, lifetime, capture, download } = setup(async () => pending.promise);
    const run = controller.start("synthetic", "one.pdf");
    if (action === "cancel") controller.cancel(); else lifetime.abort();
    expect(controller.getSnapshot()).toMatchObject({ stage: "cancelling", busy: true });
    await controller.start("other", "two.pdf");
    expect(capture).toHaveBeenCalledTimes(1);
    pending.resolve(new Uint8Array([1]));
    await run;
    expect(controller.getSnapshot()).toMatchObject({ stage: "idle", busy: false });
    controller.download();
    expect(download.trigger).not.toHaveBeenCalled();
  });

  it("releases a ready result on source removal without creating a URL", async () => {
    const { controller, lifetime, download } = setup();
    await controller.start("synthetic", "test.pdf");
    lifetime.abort();
    controller.download();
    expect(controller.getSnapshot().stage).toBe("idle");
    expect(download.createUrl).not.toHaveBeenCalled();
  });

  it.each(["cancel", "source", "timeout", "replacement"])("revokes download URLs after %s", async (mode) => {
    vi.useFakeTimers();
    const { controller, lifetime, download } = setup();
    await controller.start("synthetic", "test.pdf");
    controller.download();
    expect(download.revokeUrl).not.toHaveBeenCalled();
    if (mode === "cancel") controller.cancel();
    if (mode === "source") lifetime.abort();
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(60_000);
    if (mode === "replacement") await controller.start("synthetic", "next.pdf");
    expect(download.revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:synthetic");
  });

  it("retains the validated result for retry when download triggering throws", async () => {
    const { controller, download } = setup();
    vi.mocked(download.trigger).mockImplementationOnce(() => { throw new Error("Synthetic private diagnostic"); });
    await controller.start("synthetic", "test.pdf");
    controller.download();
    expect(controller.getSnapshot().stage).toBe("ready");
    expect(controller.getSnapshot().error).toContain("无法确认");
    expect(controller.getSnapshot().error).not.toContain("private");
    expect(download.revokeUrl).toHaveBeenCalledTimes(1);
    controller.download();
    expect(controller.getSnapshot().stage).toBe("downloaded");
    expect(download.createUrl).toHaveBeenCalledTimes(2);
  });

  it.each([
    [new Error("Synthetic document text"), "无法完成"],
    [new RangeError("allocation diagnostic"), "内存不足"],
    [new PdfUserError("验证失败，未创建下载。"), "验证失败"],
  ])("reports safe generation failures without download", async (error, message) => {
    const { controller, download } = setup(async () => { throw error; });
    await controller.start("synthetic", "test.pdf");
    expect(controller.getSnapshot()).toMatchObject({ stage: "error", busy: false });
    expect(controller.getSnapshot().error).toContain(message);
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("diagnostic");
    expect(download.createUrl).not.toHaveBeenCalled();
  });

  it("handles a missing or already released source", async () => {
    const { controller, capture, download } = setup();
    capture.mockImplementation(() => { throw new PdfUserError("当前 PDF 不可导出。"); });
    await controller.start("missing", "test.pdf");
    expect(controller.getSnapshot().error).toContain("不可导出");
    expect(download.createUrl).not.toHaveBeenCalled();
  });

  it("rejects an empty result", async () => {
    const { controller } = setup(async () => new Uint8Array());
    await controller.start("synthetic", "test.pdf");
    expect(controller.getSnapshot().stage).toBe("error");
  });

  it("does not accept a result after the export deadline", async () => {
    vi.useFakeTimers();
    const pending = deferred<Uint8Array>();
    const { controller, download } = setup(async () => pending.promise);
    const run = controller.start("synthetic", "test.pdf");
    await vi.advanceTimersByTimeAsync(300_000);
    pending.resolve(new Uint8Array([1]));
    await run;
    expect(controller.getSnapshot().error).toContain("耗时过长");
    expect(download.createUrl).not.toHaveBeenCalled();
  });

  it("reports a safe validation deadline code without accepting a late result", async () => {
    vi.useFakeTimers();
    const pending = deferred<Uint8Array>();
    const { controller, download } = setup(async (_signal, stage) => {
      stage("generating");
      stage("validating");
      return pending.promise;
    });
    const run = controller.start("synthetic", "test.pdf");
    await vi.advanceTimersByTimeAsync(300_000);
    pending.resolve(new Uint8Array([1]));
    await run;
    expect(controller.getSnapshot()).toMatchObject({ stage: "error", busy: false });
    expect(controller.getSnapshot().error).toContain("VALIDATION_TIMEOUT");
    expect(controller.getSnapshot().error).toContain("phase=validating");
    expect(controller.getSnapshot().error).toContain("item=deadline");
    controller.download();
    expect(download.createUrl).not.toHaveBeenCalled();
    expect(download.trigger).not.toHaveBeenCalled();
  });

  it("passes typed safe content diagnostics through the existing error field", async () => {
    const diagnostic = new PdfExportDiagnosticError("VISUAL_CONTENT_MISMATCH", {
      stage: "validating", item: "visual", outputPage: 2, sourcePage: 3,
    });
    const { controller, download } = setup(async () => { throw diagnostic; });
    await controller.start("synthetic", "test.pdf");
    expect(controller.getSnapshot().error).toBe(diagnostic.message);
    expect(controller.getSnapshot().error).toContain("outputPage=2");
    expect(controller.getSnapshot().error).toContain("sourcePage=3");
    controller.download();
    expect(download.trigger).not.toHaveBeenCalled();
  });

  it("unsubscribes listeners", async () => {
    const { controller } = setup();
    const listener = vi.fn();
    controller.subscribe(listener)();
    await controller.start("synthetic", "test.pdf");
    expect(listener).not.toHaveBeenCalled();
  });
});
