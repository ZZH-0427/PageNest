import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfWorkspace } from "./workspace";
import type { PdfDocumentHandle, PdfEngine, PdfFileEntry, PdfPageInfo } from "./types";

vi.mock("./browser-engine", () => ({ BrowserPdfEngine: vi.fn() }));

const workspaces: PdfWorkspace[] = [];
afterEach(() => workspaces.splice(0).forEach((workspace) => workspace.dispose()));

async function setup(count = 1) {
  const sourcePages: PdfPageInfo[] = Array.from({ length: 5 }, (_, index) => ({
    number: index + 1, width: 420, height: 594, rotation: 0, orientation: "portrait",
  }));
  const handles: PdfDocumentHandle[] = [];
  const engine: PdfEngine = {
    open: vi.fn(async () => {
      const handle = { pages: sourcePages, render: vi.fn(async () => {}), destroy: vi.fn(async () => {}) };
      handles.push(handle);
      return handle;
    }),
    destroy: vi.fn(async () => {}),
  };
  const workspace = new PdfWorkspace(() => engine);
  workspaces.push(workspace);
  const files = Array.from({ length: count }, (_, index) => new File([`%PDF-synthetic-${index}`], `synthetic-${index}.pdf`, { type: "application/pdf" }));
  workspace.addFiles(files);
  await vi.waitFor(() => expect(workspace.getSnapshot().files.every((entry) => entry.status === "ready")).toBe(true));
  return { workspace, engine, handles, sourcePages, files };
}

function current(workspace: PdfWorkspace, index = 0): PdfFileEntry {
  return workspace.getSnapshot().files[index];
}

describe("PDF editing integration", () => {
  it("keeps current-order page selection compatible and stores independent file histories", async () => {
    const { workspace } = await setup(2);
    const [one, two] = workspace.getSnapshot().files;
    workspace.selectPage(one.id, 2);
    workspace.rotateSelectedPages(one.id, 90);
    workspace.selectFile(two.id);
    workspace.selectPage(two.id, 4);
    workspace.deleteSelectedPages(two.id);
    workspace.undo(one.id);
    expect(current(workspace).edit?.present.pages[1].rotationDelta).toBe(0);
    expect(current(workspace).edit?.future).toHaveLength(1);
    expect(current(workspace, 1).edit?.present.pages.map((page) => page.sourcePageNumber)).toEqual([1, 2, 3, 5]);
    workspace.selectFile(one.id);
    workspace.redo(one.id);
    expect(current(workspace).selectedPage).toBe(2);
    expect(current(workspace).edit?.present.pages[1].rotationDelta).toBe(90);
    expect(current(workspace, 1).selectedPage).toBe(4);
    expect(current(workspace, 1).edit?.past).toHaveLength(1);
  });

  it("supports range selection, Ctrl toggles, all and Escape without adding history", async () => {
    const { workspace } = await setup();
    const id = current(workspace).id;
    workspace.selectPage(id, 2);
    workspace.selectPage(id, 4, { range: true });
    expect(current(workspace).edit?.present.selectedIds).toHaveLength(3);
    workspace.selectPage(id, 3, { toggle: true });
    expect(current(workspace).edit?.present.selectedIds).toHaveLength(2);
    workspace.selectAllPages(id);
    expect(current(workspace).edit?.present.selectedIds).toHaveLength(5);
    workspace.clearPageSelection(id);
    expect(current(workspace).selectedPage).toBe(0);
    expect(current(workspace).edit?.present.selectedIds).toEqual([]);
    expect(current(workspace).edit?.past).toHaveLength(0);
  });

  it("protects all pages with a clear notice and restores a batch deletion in one undo", async () => {
    const { workspace } = await setup();
    const id = current(workspace).id;
    workspace.selectAllPages(id);
    workspace.deleteSelectedPages(id);
    expect(workspace.getSnapshot().notice).toContain("至少需要保留一页");
    expect(current(workspace).edit?.present.pages).toHaveLength(5);
    expect(current(workspace).edit?.past).toHaveLength(0);
    workspace.dismissNotice();
    workspace.selectPage(id, 2);
    workspace.selectPage(id, 4, { range: true });
    workspace.deleteSelectedPages(id);
    expect(current(workspace).edit?.present.pages.map((page) => page.sourcePageNumber)).toEqual([1, 5]);
    expect(current(workspace).selectedPage).toBe(2);
    expect(current(workspace).edit?.past).toHaveLength(1);
    workspace.undo(id);
    expect(current(workspace).edit?.present.pages).toHaveLength(5);
    expect(current(workspace).edit?.present.selectedIds).toHaveLength(3);
    workspace.redo(id);
    expect(current(workspace).edit?.present.pages).toHaveLength(2);
  });

  it("moves a single selected page one position and ignores boundaries or multiple selection", async () => {
    const { workspace } = await setup();
    const entry = current(workspace);
    workspace.moveSelectedPage(entry.id, -1);
    expect(current(workspace).edit?.past).toHaveLength(0);
    workspace.moveSelectedPage(entry.id, 1);
    expect(current(workspace).edit?.present.pages.map((page) => page.sourcePageNumber)).toEqual([2, 1, 3, 4, 5]);
    expect(current(workspace).selectedPage).toBe(2);
    workspace.movePage(entry.id, entry.edit!.present.pages[0].id, 4);
    expect(current(workspace).selectedPage).toBe(5);
    workspace.moveSelectedPage(entry.id, 1);
    expect(current(workspace).edit?.past).toHaveLength(2);
    workspace.selectPage(entry.id, 1, { toggle: true });
    workspace.moveSelectedPage(entry.id, -1);
    expect(current(workspace).edit?.past).toHaveLength(2);
  });

  it("handles rapid edit/undo/branching synchronously without parsing or changing originals", async () => {
    const { workspace, engine, handles, sourcePages, files } = await setup();
    const id = current(workspace).id;
    const originalMetadata = JSON.stringify(sourcePages);
    const fileSize = files[0].size;
    for (let index = 0; index < 61; index++) workspace.rotateSelectedPages(id, 90);
    expect(current(workspace).edit?.present.pages[0].rotationDelta).toBe(90);
    expect(current(workspace).edit?.past).toHaveLength(50);
    workspace.undo(id);
    workspace.undo(id);
    workspace.redo(id);
    workspace.moveSelectedPage(id, 1);
    expect(current(workspace).edit?.future).toHaveLength(0);
    expect(engine.open).toHaveBeenCalledOnce();
    expect(engine.open).toHaveBeenCalledWith(files[0], expect.any(AbortSignal), expect.any(Function));
    expect(current(workspace).pages).toBe(sourcePages);
    expect(JSON.stringify(sourcePages)).toBe(originalMetadata);
    expect(files[0].size).toBe(fileSize);
    expect(handles[0].destroy).not.toHaveBeenCalled();
    expect(handles[0].render).not.toHaveBeenCalled();
  });

  it("forwards original page numbers and rotation separately without changing the source handle", async () => {
    const { workspace, handles } = await setup();
    const entry = current(workspace);
    workspace.movePage(entry.id, entry.edit!.present.pages[0].id, 4);
    workspace.rotateSelectedPages(entry.id, -90);
    const edited = current(workspace).edit!.present.pages[4];
    const canvas = document.createElement("canvas");
    await workspace.renderPage(edited.sourceDocumentId, edited.sourcePageNumber, canvas, new AbortController().signal, edited.rotationDelta);
    expect(handles[0].render).toHaveBeenCalledWith(1, canvas, expect.any(AbortSignal), 270);
    expect(handles[0].pages[0].rotation).toBe(0);
  });

  it("does not dispose page sources on deletion and releases all histories when files are removed or cleared", async () => {
    const { workspace, handles, engine } = await setup(2);
    const [one, two] = workspace.getSnapshot().files;
    workspace.deleteSelectedPages(one.id);
    workspace.rotateSelectedPages(two.id, 90);
    expect(handles[0].destroy).not.toHaveBeenCalled();
    workspace.removeFile(one.id);
    expect(handles[0].destroy).toHaveBeenCalledOnce();
    expect(workspace.getSnapshot().files.map((entry) => entry.id)).toEqual([two.id]);
    workspace.undo(one.id);
    workspace.redo(one.id);
    expect(workspace.getSnapshot().files).toHaveLength(1);
    workspace.clear();
    expect(handles[1].destroy).toHaveBeenCalledOnce();
    expect(engine.destroy).toHaveBeenCalledOnce();
    expect(workspace.getSnapshot()).toEqual({ files: [], selectedId: null, notice: null });
  });

  it("ignores stale commands after disposal and invalid current page positions", async () => {
    const { workspace } = await setup();
    const entry = current(workspace);
    for (const number of [0, -1, 6, 1.1, NaN]) workspace.selectPage(entry.id, number);
    expect(current(workspace).selectedPage).toBe(1);
    workspace.dispose();
    workspace.selectPage(entry.id, 2);
    workspace.selectAllPages(entry.id);
    workspace.deleteSelectedPages(entry.id);
    workspace.rotateSelectedPages(entry.id, 90);
    workspace.moveSelectedPage(entry.id, 1);
    workspace.undo(entry.id);
    workspace.redo(entry.id);
    expect(workspace.getSnapshot().files).toEqual([]);
  });
});
