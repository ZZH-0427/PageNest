import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfWorkspace } from "./workspace";
import { generateEditedPdf } from "./export";
import { validateEditedPdf } from "./export-validation";
import type { PdfDocumentHandle, PdfEngine, PdfPageInfo } from "./types";

vi.mock("./browser-engine", () => ({ BrowserPdfEngine: vi.fn() }));
vi.mock("./export", () => ({
  sanitizePdfFilename: (name: string) => name,
  generateEditedPdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
}));
vi.mock("./export-validation", () => ({ validateEditedPdf: vi.fn(async () => {}) }));

const instances: PdfWorkspace[] = [];
afterEach(() => {
  instances.splice(0).forEach((instance) => instance.dispose());
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function doc(): PdfDocumentHandle {
  return {
    pages: Array.from({ length: 3 }, (_, i): PdfPageInfo => ({ number: i + 1, width: 420, height: 594, rotation: 0, orientation: "portrait" })),
    render: vi.fn(async () => {}), destroy: vi.fn(async () => {}),
  };
}
async function setup() {
  const original = doc();
  const output = doc();
  const engine: PdfEngine = { open: vi.fn(async (file) => file.name === "validation.pdf" ? output : original), destroy: vi.fn(async () => {}) };
  const workspace = new PdfWorkspace(() => engine);
  instances.push(workspace);
  workspace.addFiles([new File(["%PDF-1.7\nSynthetic"], "first.pdf", { type: "application/pdf" })]);
  await vi.waitFor(() => expect(workspace.getSnapshot().files[0].status).toBe("ready"));
  return { workspace, id: workspace.getSnapshot().files[0].id, original, output, engine };
}

describe("workspace export capabilities", () => {
  it("does not upload documents or write persistent storage through the workspace lifecycle", async () => {
    const upload = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected upload"));
    const xhr = vi.spyOn(XMLHttpRequest.prototype, "send");
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const database = vi.fn();
    const socket = vi.fn();
    vi.stubGlobal("indexedDB", { open: database });
    vi.stubGlobal("WebSocket", socket);
    const { workspace, id } = await setup();
    workspace.rotateSelectedPages(id, 90);
    await workspace.exporter.start(id, "edited.pdf");
    workspace.clear();
    expect(upload).not.toHaveBeenCalled();
    expect(xhr).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    expect(database).not.toHaveBeenCalled();
    expect(socket).not.toHaveBeenCalled();
  });

  it("exports all retained pages in edited order, independent of selection, without changing history", async () => {
    const { workspace, id, original, output } = await setup();
    workspace.selectPage(id, 2);
    workspace.deleteSelectedPages(id);
    workspace.selectPage(id, 2);
    workspace.rotateSelectedPages(id, -90);
    workspace.moveSelectedPage(id, -1);
    const before = workspace.getSnapshot();
    await workspace.exporter.start(id, "edited.pdf");
    const request = vi.mocked(generateEditedPdf).mock.calls[0][1];
    expect(request.pages.map((page) => page.sourcePageNumber)).toEqual([3, 1]);
    expect(request.pages.map((page) => page.rotationDelta)).toEqual([270, 0]);
    expect(workspace.getSnapshot()).toBe(before);
    expect(validateEditedPdf).toHaveBeenCalledWith(original, output, request.pages, expect.any(AbortSignal));
    expect(output.destroy).toHaveBeenCalledTimes(1);
    expect(original.destroy).not.toHaveBeenCalled();
    expect(workspace.exporter.getSnapshot().stage).toBe("ready");
  });

  it("keeps the captured snapshot while subsequent edits and file switching remain isolated", async () => {
    const { workspace, id } = await setup();
    workspace.addFiles([new File(["%PDF-1.7\nOther"], "second.pdf")]);
    await vi.waitFor(() => expect(workspace.getSnapshot().files[1].status).toBe("ready"));
    const secondId = workspace.getSnapshot().files[1].id;
    const second = workspace.getSnapshot().files[1];
    const run = workspace.exporter.start(id, "edited.pdf");
    workspace.selectPage(id, 2);
    workspace.deleteSelectedPages(id);
    workspace.selectFile(secondId);
    await run;
    expect(vi.mocked(generateEditedPdf).mock.calls[0][1].pages).toHaveLength(3);
    expect(workspace.getSnapshot().files[0].edit?.present.pages).toHaveLength(2);
    expect(workspace.getSnapshot().files[1]).toBe(second);
    expect(workspace.exporter.getSnapshot().documentId).toBe(id);
  });

  it.each(["remove", "clear", "dispose"])("%s makes a pending generation unusable", async (operation) => {
    const { workspace, id, engine } = await setup();
    let resolve!: (value: Uint8Array) => void;
    vi.mocked(generateEditedPdf).mockImplementationOnce(() => new Promise((yes) => { resolve = yes; }));
    const run = workspace.exporter.start(id, "edited.pdf");
    await vi.waitFor(() => expect(generateEditedPdf).toHaveBeenCalled());
    if (operation === "remove") workspace.removeFile(id);
    if (operation === "clear") workspace.clear();
    if (operation === "dispose") workspace.dispose();
    resolve(new Uint8Array([1]));
    await run;
    expect(workspace.exporter.getSnapshot().stage).toBe("idle");
    expect(engine.open).toHaveBeenCalledTimes(1);
    expect(validateEditedPdf).not.toHaveBeenCalled();
    await workspace.exporter.start(id, "again.pdf");
    expect(workspace.exporter.getSnapshot().stage).toBe("error");
  });

  it("cleans up the output handle when independent validation rejects", async () => {
    const { workspace, id, output, original } = await setup();
    vi.mocked(validateEditedPdf).mockRejectedValueOnce(new Error("Synthetic validation failure"));
    await workspace.exporter.start(id, "edited.pdf");
    expect(output.destroy).toHaveBeenCalledTimes(1);
    expect(original.destroy).not.toHaveBeenCalled();
    expect(workspace.exporter.getSnapshot().stage).toBe("error");
  });

  it("erases its temporary byte reread even after generation fails", async () => {
    const { workspace, id } = await setup();
    vi.mocked(generateEditedPdf).mockRejectedValueOnce(new Error("Synthetic generation failure"));
    await workspace.exporter.start(id, "edited.pdf");
    const bytes = vi.mocked(generateEditedPdf).mock.calls[0][0];
    expect(bytes.every((value) => value === 0)).toBe(true);
    expect(validateEditedPdf).not.toHaveBeenCalled();
    expect(workspace.getSnapshot().files[0].status).toBe("ready");
  });

  it("handles output parsing failure without altering imported files", async () => {
    const { workspace, id, engine, original } = await setup();
    vi.mocked(engine.open).mockRejectedValueOnce(new Error("Synthetic parse failure"));
    const before = workspace.getSnapshot();
    await workspace.exporter.start(id, "edited.pdf");
    expect(workspace.exporter.getSnapshot().stage).toBe("error");
    expect(workspace.getSnapshot()).toBe(before);
    expect(original.destroy).not.toHaveBeenCalled();
  });

  it("bounds an unresponsive output cleanup and releases the export slot", async () => {
    const { workspace, id, output } = await setup();
    vi.mocked(output.destroy).mockImplementationOnce(() => new Promise(() => {}));
    const run = workspace.exporter.start(id, "edited.pdf");
    await vi.waitFor(() => expect(output.destroy).toHaveBeenCalled());
    workspace.exporter.cancel();
    await run;
    expect(workspace.exporter.getSnapshot()).toMatchObject({ stage: "idle", busy: false });
    await workspace.exporter.start(id, "retry.pdf");
    expect(workspace.exporter.getSnapshot().stage).toBe("ready");
  });
});
