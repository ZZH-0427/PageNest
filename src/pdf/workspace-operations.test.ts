import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfWorkspace } from "./workspace";
import { generatePlannedPdf, validatePlannedPdf } from "./output-engine";
import { generateEditedPdf } from "./export";
import { validateEditedPdf } from "./export-validation";
import { buildMergePlan, buildSplitPlan } from "./output-plan";
import { PdfExportDiagnosticError } from "./export-diagnostics";
import type { PdfDocumentHandle, PdfEngine, PdfPageInfo } from "./types";

vi.mock("./browser-engine", () => ({ BrowserPdfEngine: vi.fn() }));
vi.mock("./output-engine", () => ({ generatePlannedPdf: vi.fn(), validatePlannedPdf: vi.fn() }));
vi.mock("./export", async (original) => ({ ...await original<typeof import("./export")>(), generateEditedPdf: vi.fn() }));
vi.mock("./export-validation", () => ({ validateEditedPdf: vi.fn(async () => {}) }));

const instances: PdfWorkspace[] = [];
const meta: PdfPageInfo[] = [1, 2, 3].map((number) => ({ number, width: 420, height: 594, rotation: 0, orientation: "portrait" }));
const doc = (): PdfDocumentHandle => ({ pages: meta.map((p) => ({ ...p })), inspectPage: vi.fn(), render: vi.fn(async () => {}), destroy: vi.fn(async () => {}) });
afterEach(() => { instances.splice(0).forEach((item) => item.dispose()); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function setup() {
  vi.mocked(generatePlannedPdf).mockReset().mockImplementation(async () => new Uint8Array([37, 80, 68, 70]));
  vi.mocked(validatePlannedPdf).mockReset().mockResolvedValue(undefined);
  vi.mocked(generateEditedPdf).mockReset().mockImplementation(async () => new Uint8Array([37, 80, 68, 70]));
  const files = [new File(["%PDF-1.7\nArtificial A"], "same.pdf"), new File(["%PDF-1.7\nArtificial B"], "same.pdf")];
  const preview = [doc(), doc()];
  const opened: { file: File; handle: PdfDocumentHandle; options: unknown }[] = [];
  const engine: PdfEngine = { open: vi.fn(async (file, signal, _status, options) => {
    signal.throwIfAborted();
    const existing = files.indexOf(file);
    const handle = opened.length < 2 && existing >= 0 ? preview[existing] : doc();
    opened.push({ file, handle, options });
    return handle;
  }), destroy: vi.fn(async () => {}) };
  const workspace = new PdfWorkspace(() => engine); instances.push(workspace);
  workspace.addFiles(files);
  await vi.waitFor(() => expect(workspace.getSnapshot().files.every((f) => f.status === "ready")).toBe(true));
  return { workspace, files, preview, opened, engine, ids: workspace.getSnapshot().files.map((f) => f.id) };
}

describe("workspace immutable output capabilities", () => {
  it("exports selected pages in edited order and freezes the mapping without altering selection or history", async () => {
    const { workspace, ids } = await setup();
    const id = ids[0];
    workspace.selectPage(id, 3); workspace.moveSelectedPage(id, -1); workspace.moveSelectedPage(id, -1);
    workspace.selectPage(id, 3); workspace.selectPage(id, 1, { toggle: true }); workspace.rotateSelectedPages(id, 90);
    const before = workspace.getSnapshot();
    await workspace.exporter.start(id, "selected.pdf", "selection");
    expect(workspace.exporter.getSnapshot().stage).toBe("ready");
    const request = vi.mocked(generateEditedPdf).mock.calls[0][1];
    expect(request.pages.map((p) => p.sourcePageNumber)).toEqual([3, 2]);
    expect(request.pages.every((p) => p.rotationDelta === 90)).toBe(true);
    expect(Object.isFrozen(request.pages)).toBe(true);
    expect(Object.isFrozen(request.pages[0])).toBe(true);
    expect(validateEditedPdf).toHaveBeenCalled();
    expect(workspace.getSnapshot()).toBe(before);
  });

  it("rejects empty selection without generating or modifying any document", async () => {
    const { workspace, ids } = await setup();
    workspace.clearPageSelection(ids[0]);
    const before = workspace.getSnapshot();
    await workspace.exporter.start(ids[0], "selected.pdf", "selection");
    expect(workspace.exporter.getSnapshot()).toMatchObject({ stage: "error", error: expect.stringContaining("至少一页") });
    expect(generateEditedPdf).not.toHaveBeenCalled();
    expect(workspace.getSnapshot()).toBe(before);
  });

  it("binds same-name inputs by ID and opens independent original/output documents with default settings", async () => {
    const { workspace, files, opened, preview, ids } = await setup();
    const plan = buildMergePlan(workspace.getSnapshot().files, [...ids].reverse(), "merged.pdf");
    const before = workspace.getSnapshot();
    await workspace.operations.start(plan);
    expect(workspace.operations.getSnapshot()).toMatchObject({ stage: "ready", totalOutputs: 1 });
    const input = vi.mocked(generatePlannedPdf).mock.calls[0][0];
    expect(input.map((s) => s.documentId)).toEqual([...ids].reverse());
    expect(input.every((s) => s.bytes.every((value) => value === 0))).toBe(true);
    const temporary = opened.slice(2);
    expect(temporary).toHaveLength(3);
    expect(temporary.slice(0, 2).map((e) => e.file)).toEqual([...files].reverse());
    expect(temporary.every((e) => e.options === undefined)).toBe(true);
    for (const entry of temporary) expect(entry.handle.destroy).toHaveBeenCalledTimes(1);
    for (const handle of preview) expect(handle.destroy).not.toHaveBeenCalled();
    const [sources, result] = vi.mocked(validatePlannedPdf).mock.calls[0];
    expect([...sources.keys()]).toEqual([...ids].reverse());
    expect(result).toBe(temporary[2].handle);
    expect(workspace.getSnapshot()).toBe(before);
  });

  it("holds the captured edit snapshot while later edits and document selection change", async () => {
    const { workspace, ids } = await setup();
    const input = buildMergePlan(workspace.getSnapshot().files, ids, "merged.pdf");
    let finish!: (bytes: Uint8Array) => void;
    vi.mocked(generatePlannedPdf).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const running = workspace.operations.start(input);
    await vi.waitFor(() => expect(generatePlannedPdf).toHaveBeenCalled());
    workspace.selectPage(ids[0], 2); workspace.deleteSelectedPages(ids[0]); workspace.selectFile(ids[1]);
    finish(new Uint8Array([37, 80, 68, 70]));
    await running;
    expect(vi.mocked(validatePlannedPdf).mock.calls[0][2]).toHaveLength(6);
    expect(workspace.getSnapshot().files[0].edit?.present.pages).toHaveLength(2);
    expect(workspace.operations.getSnapshot().stage).toBe("ready");
  });

  it("rejects a stale output plan before reading source bytes", async () => {
    const { workspace, ids } = await setup();
    const stale = buildMergePlan(workspace.getSnapshot().files, ids);
    workspace.rotateSelectedPages(ids[1], 90);
    await workspace.operations.start(stale);
    expect(workspace.operations.getSnapshot().stage).toBe("error");
    expect(generatePlannedPdf).not.toHaveBeenCalled();
  });

  it.each(["remove", "clear", "dispose"])("%s invalidates a non-interruptible merge and erases its late output", async (action) => {
    const { workspace, ids, opened } = await setup();
    let finish!: (bytes: Uint8Array) => void;
    vi.mocked(generatePlannedPdf).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const running = workspace.operations.start(buildMergePlan(workspace.getSnapshot().files, ids));
    await vi.waitFor(() => expect(generatePlannedPdf).toHaveBeenCalled());
    if (action === "remove") workspace.removeFile(ids[1]);
    if (action === "clear") workspace.clear();
    if (action === "dispose") workspace.dispose();
    const bytes = new Uint8Array([1, 2, 3]); finish(bytes); await running;
    expect(bytes.every((v) => v === 0)).toBe(true);
    expect(workspace.operations.getSnapshot()).toMatchObject({ stage: "idle", results: [] });
    expect(opened).toHaveLength(2);
    expect(validatePlannedPdf).not.toHaveBeenCalled();
  });

  it("enforces a global busy gate between the old exporter and planned operations", async () => {
    const { workspace, ids } = await setup();
    let finish!: (bytes: Uint8Array) => void;
    vi.mocked(generatePlannedPdf).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const running = workspace.operations.start(buildMergePlan(workspace.getSnapshot().files, ids));
    await vi.waitFor(() => expect(generatePlannedPdf).toHaveBeenCalled());
    await workspace.exporter.start(ids[0], "other.pdf");
    expect(workspace.exporter.getSnapshot().stage).toBe("error");
    expect(generateEditedPdf).not.toHaveBeenCalled();
    finish(new Uint8Array([37, 80, 68, 70])); await running;
    vi.mocked(generateEditedPdf).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const oldRun = workspace.exporter.start(ids[0], "old.pdf");
    await vi.waitFor(() => expect(generateEditedPdf).toHaveBeenCalled());
    await workspace.operations.start(buildMergePlan(workspace.getSnapshot().files, ids));
    expect(workspace.operations.getSnapshot().stage).toBe("error");
    expect(generatePlannedPdf).toHaveBeenCalledTimes(1);
    finish(new Uint8Array([37, 80, 68, 70])); await oldRun;
    expect(workspace.exporter.getSnapshot().stage).toBe("ready");
  });

  it("independently validates each split result and discards all results on a later failure", async () => {
    const { workspace, opened } = await setup();
    const plan = buildSplitPlan(workspace.getSnapshot().files[0], { kind: "every", every: 1 });
    vi.mocked(validatePlannedPdf).mockResolvedValueOnce(undefined).mockRejectedValueOnce(
      new PdfExportDiagnosticError("TEXT_CONTENT_MISMATCH", { stage: "validating", item: "text", outputPage: 1, sourcePage: 2 }));
    await workspace.operations.start(plan);
    expect(workspace.operations.getSnapshot()).toMatchObject({ stage: "error", results: [], error: expect.stringContaining("TEXT_CONTENT_MISMATCH") });
    expect(generatePlannedPdf).toHaveBeenCalledTimes(2);
    expect(validatePlannedPdf).toHaveBeenCalledTimes(2);
    for (const openedHandle of opened.slice(2)) expect(openedHandle.handle.destroy).toHaveBeenCalledTimes(1);
  });

  it("reports source parsing errors without leaking parser details or destroying the preview", async () => {
    const { workspace, ids, engine, preview } = await setup();
    vi.mocked(engine.open).mockRejectedValueOnce(new Error("SYNTHETIC_PRIVATE_SOURCE_PARSER_DETAILS"));
    await workspace.operations.start(buildMergePlan(workspace.getSnapshot().files, ids));
    expect(workspace.operations.getSnapshot()).toMatchObject({ stage: "error", results: [], error: expect.stringContaining("source-open") });
    expect(workspace.operations.getSnapshot().error).not.toContain("PRIVATE");
    expect(validatePlannedPdf).not.toHaveBeenCalled();
    for (const handle of preview) expect(handle.destroy).not.toHaveBeenCalled();
  });

  it("blocks a successful validation whose temporary handle cleanup fails", async () => {
    const { workspace, engine, preview } = await setup();
    const freshSource = doc(), output = doc();
    vi.mocked(freshSource.destroy).mockRejectedValueOnce(new Error("SYNTHETIC_PRIVATE_CLEANUP_DETAILS"));
    vi.mocked(engine.open).mockResolvedValueOnce(freshSource).mockResolvedValueOnce(output);
    const plan = buildSplitPlan(workspace.getSnapshot().files[0], { kind: "every", every: 3 });
    await workspace.operations.start(plan);
    expect(workspace.operations.getSnapshot()).toMatchObject({ stage: "error", results: [], error: expect.stringContaining("cleanup") });
    expect(output.destroy).toHaveBeenCalledTimes(1);
    expect(workspace.operations.getSnapshot().error).not.toContain("PRIVATE");
    for (const handle of preview) expect(handle.destroy).not.toHaveBeenCalled();
  });

  it("preserves the first failing-page diagnostic even if cleanup also fails", async () => {
    const { workspace, engine } = await setup();
    const freshSource = doc(), output = doc();
    vi.mocked(freshSource.destroy).mockRejectedValueOnce(new Error("SYNTHETIC_PRIVATE_CLEANUP_DETAILS"));
    vi.mocked(engine.open).mockResolvedValueOnce(freshSource).mockResolvedValueOnce(output);
    const failure = new PdfExportDiagnosticError("TEXT_CONTENT_MISMATCH", { stage: "validating", item: "text", outputPage: 2, sourcePage: 3 });
    vi.mocked(validatePlannedPdf).mockRejectedValueOnce(failure);
    await workspace.operations.start(buildSplitPlan(workspace.getSnapshot().files[0], { kind: "every", every: 3 }));
    expect(workspace.operations.getSnapshot().error).toBe(failure.message);
    expect(output.destroy).toHaveBeenCalledTimes(1);
  });

  it("cancels a source open immediately and destroys a handle that arrives late", async () => {
    const { workspace, ids, engine } = await setup();
    let finish!: (handle: PdfDocumentHandle) => void;
    vi.mocked(engine.open).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const running = workspace.operations.start(buildMergePlan(workspace.getSnapshot().files, ids));
    await vi.waitFor(() => expect(engine.open).toHaveBeenCalledTimes(3));
    workspace.removeFile(ids[1]);
    await running;
    expect(workspace.operations.getSnapshot()).toMatchObject({ stage: "idle", busy: false, results: [] });
    const late = doc(); finish(late);
    await vi.waitFor(() => expect(late.destroy).toHaveBeenCalledTimes(1));
    expect(validatePlannedPdf).not.toHaveBeenCalled();
  });

  it("releases an opened source when a later source fails to open", async () => {
    const { workspace, ids, engine, preview } = await setup();
    const firstSource = doc();
    const bytes = new Uint8Array([37, 80, 68, 70]);
    vi.mocked(generatePlannedPdf).mockResolvedValueOnce(bytes);
    vi.mocked(engine.open).mockResolvedValueOnce(firstSource)
      .mockRejectedValueOnce(new Error("SYNTHETIC_PRIVATE_SECOND_SOURCE_DETAILS"));

    await workspace.operations.start(buildMergePlan(workspace.getSnapshot().files, ids));

    expect(workspace.operations.getSnapshot()).toMatchObject({ stage: "error", busy: false, results: [], error: expect.stringContaining("source-open") });
    expect(workspace.operations.getSnapshot().error).not.toContain("PRIVATE");
    expect(firstSource.destroy).toHaveBeenCalledTimes(1);
    expect(engine.open).toHaveBeenCalledTimes(4);
    expect(validatePlannedPdf).not.toHaveBeenCalled();
    expect(bytes.every((value) => value === 0)).toBe(true);
    for (const handle of preview) expect(handle.destroy).not.toHaveBeenCalled();
  });

  it("discards output and releases every fresh handle when a source is removed during validation", async () => {
    const { workspace, ids, opened, preview } = await setup();
    const bytes = new Uint8Array([37, 80, 68, 70]);
    vi.mocked(generatePlannedPdf).mockResolvedValueOnce(bytes);
    let finish!: () => void;
    vi.mocked(validatePlannedPdf).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const running = workspace.operations.start(buildMergePlan(workspace.getSnapshot().files, ids));
    await vi.waitFor(() => expect(validatePlannedPdf).toHaveBeenCalledTimes(1));
    const temporary = opened.slice(2);
    expect(temporary).toHaveLength(3);

    workspace.removeFile(ids[1]);
    expect(workspace.operations.getSnapshot()).toMatchObject({ stage: "cancelling", busy: true, results: [] });
    finish();
    await running;

    expect(workspace.operations.getSnapshot()).toMatchObject({ stage: "idle", busy: false, results: [], error: null });
    for (const entry of temporary) expect(entry.handle.destroy).toHaveBeenCalledTimes(1);
    expect(bytes.every((value) => value === 0)).toBe(true);
    expect(preview[0].destroy).not.toHaveBeenCalled();
    expect(preview[1].destroy).toHaveBeenCalledTimes(1);
  });

  it("keeps cancellation authoritative while successful validation waits for handle cleanup", async () => {
    const { workspace, ids, engine, preview } = await setup();
    const freshSource = doc(), otherSource = doc(), output = doc();
    let finish!: () => void;
    vi.mocked(freshSource.destroy).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    vi.mocked(engine.open).mockResolvedValueOnce(freshSource).mockResolvedValueOnce(otherSource).mockResolvedValueOnce(output);
    const bytes = new Uint8Array([37, 80, 68, 70]);
    vi.mocked(generatePlannedPdf).mockResolvedValueOnce(bytes);
    const running = workspace.operations.start(buildMergePlan(workspace.getSnapshot().files, ids));
    await vi.waitFor(() => expect(freshSource.destroy).toHaveBeenCalledTimes(1));
    expect(validatePlannedPdf).toHaveBeenCalledTimes(1);
    expect(otherSource.destroy).toHaveBeenCalledTimes(1);
    expect(output.destroy).toHaveBeenCalledTimes(1);

    workspace.removeFile(ids[1]);
    expect(workspace.operations.getSnapshot()).toMatchObject({ stage: "cancelling", busy: true, results: [] });
    finish();
    await running;

    expect(workspace.operations.getSnapshot()).toMatchObject({ stage: "idle", busy: false, results: [], error: null });
    expect(bytes.every((value) => value === 0)).toBe(true);
    expect(freshSource.destroy).toHaveBeenCalledTimes(1);
    expect(preview[0].destroy).not.toHaveBeenCalled();
  });

  it("keeps the global gate closed until a cancelled old export finishes its non-interruptible save", async () => {
    const { workspace, ids } = await setup();
    let finish!: (bytes: Uint8Array) => void;
    vi.mocked(generateEditedPdf).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const running = workspace.exporter.start(ids[0], "old.pdf");
    await vi.waitFor(() => expect(generateEditedPdf).toHaveBeenCalledTimes(1));
    workspace.exporter.cancel();
    expect(workspace.exporter.getSnapshot()).toMatchObject({ stage: "cancelling", busy: true });

    const plan = buildMergePlan(workspace.getSnapshot().files, ids);
    await workspace.operations.start(plan);
    expect(workspace.operations.getSnapshot()).toMatchObject({ stage: "error", busy: false, results: [], error: expect.stringContaining("另一项") });
    expect(generatePlannedPdf).not.toHaveBeenCalled();
    finish(new Uint8Array([37, 80, 68, 70]));
    await running;
    expect(workspace.exporter.getSnapshot()).toMatchObject({ stage: "idle", busy: false });

    await workspace.operations.start(plan);
    expect(workspace.operations.getSnapshot().stage).toBe("ready");
    expect(generatePlannedPdf).toHaveBeenCalledTimes(1);
  });

  it("does not upload or persist documents during merge, split and clear", async () => {
    const upload = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected upload"));
    const xhr = vi.spyOn(XMLHttpRequest.prototype, "send");
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const database = vi.fn(), socket = vi.fn();
    vi.stubGlobal("indexedDB", { open: database }); vi.stubGlobal("WebSocket", socket);
    const { workspace, ids } = await setup();
    await workspace.operations.start(buildMergePlan(workspace.getSnapshot().files, ids));
    await workspace.operations.start(buildSplitPlan(workspace.getSnapshot().files[0], { kind: "every", every: 1 }));
    workspace.clear();
    for (const forbidden of [upload, xhr, storage, database, socket]) expect(forbidden).not.toHaveBeenCalled();
  });
});
