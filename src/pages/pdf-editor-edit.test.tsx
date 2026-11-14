import type { HTMLAttributes, MouseEvent } from "react";
import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfDocumentHandle, PdfEngine, PdfPageInfo } from "../pdf/types";
import { PdfEditor } from "./pdf-editor";

const engine = vi.hoisted(() => ({
  open: vi.fn<PdfEngine["open"]>(),
  destroy: vi.fn<PdfEngine["destroy"]>(),
  documents: [] as PdfDocumentHandle[],
}));

vi.mock("../pdf/browser-engine", () => ({
  BrowserPdfEngine: class {
    open = engine.open;
    destroy = engine.destroy;
  },
}));

// Exercise the real workspace, hook and editor together. Canvas lifecycle is
// covered separately; this tile preserves actual mouse/drag events and mapping.
vi.mock("../components/pdf/thumbnail", () => ({
  PdfThumbnail: ({ page, selected, onSelect, sourcePageNumber, rotationDelta, tileProps }: {
    page: PdfPageInfo;
    selected: boolean;
    onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
    sourcePageNumber: number;
    rotationDelta: number;
    tileProps?: HTMLAttributes<HTMLButtonElement>;
  }) => (
    <button
      {...tileProps}
      type="button"
      aria-label={`第 ${page.number} 页`}
      aria-pressed={selected}
      data-source-page={sourcePageNumber}
      data-rotation={rotationDelta}
      onClick={onSelect}
    >第 {page.number} 页</button>
  ),
}));

const originalPages: PdfPageInfo[] = [
  { number: 1, width: 420, height: 594, rotation: 0, orientation: "portrait" },
  { number: 2, width: 594, height: 420, rotation: 0, orientation: "landscape" },
  { number: 3, width: 594, height: 420, rotation: 90, orientation: "landscape" },
];

beforeEach(() => {
  engine.documents = [];
  engine.open.mockReset();
  engine.destroy.mockReset().mockResolvedValue();
  engine.open.mockImplementation(async (_file, signal, onStatus) => {
    signal.throwIfAborted();
    onStatus("reading");
    onStatus("parsing");
    const document: PdfDocumentHandle = {
      pages: originalPages.map((page) => ({ ...page })),
      render: vi.fn(async () => {}),
      destroy: vi.fn(async () => {}),
    };
    engine.documents.push(document);
    return document;
  });
});

function tiles() {
  return within(screen.getByLabelText("页面缩略图滚动区域")).queryAllByRole("button", { name: /^第 \d+ 页$/ });
}

function selectedNumbers() {
  return tiles().filter((tile) => tile.getAttribute("aria-pressed") === "true")
    .map((tile) => Number(tile.getAttribute("aria-label")!.match(/\d+/)![0]));
}

function sourceOrder() {
  return tiles().map((tile) => Number(tile.getAttribute("data-source-page")));
}

function page(number: number) {
  return screen.getByRole("button", { name: `第 ${number} 页` });
}

function button(name: string) {
  return screen.getByRole("button", { name });
}

async function setup(names = ["first.pdf"]) {
  const user = userEvent.setup();
  const view = render(<><input aria-label="其他输入框" /><PdfEditor /></>);
  const files = names.map((name) => new File(["artificial test input"], name, { type: "application/pdf" }));
  await user.upload(screen.getByLabelText("导入 PDF 文件"), files);
  await waitFor(() => expect(engine.open).toHaveBeenCalledTimes(names.length));
  await screen.findByRole("button", { name: "第 3 页" });
  return { user, files, ...view };
}

function transfer() {
  return { types: ["application/x-pagenest-page"], files: [], setData: vi.fn(), effectAllowed: "none", dropEffect: "none" };
}

function dragOver(target: HTMLElement, dataTransfer: ReturnType<typeof transfer>, after: boolean) {
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ left: 0, width: 100 } as DOMRect);
  const event = createEvent.dragOver(target, { dataTransfer });
  Object.defineProperty(event, "clientX", { value: after ? 90 : 10 });
  fireEvent(target, event);
}

function drop(target: HTMLElement, dataTransfer: ReturnType<typeof transfer>, after: boolean) {
  const event = createEvent.drop(target, { dataTransfer });
  Object.defineProperty(event, "clientX", { value: after ? 90 : 10 });
  fireEvent(target, event);
}

describe("PDF editing integration", () => {
  it("supports single, Ctrl, Command and anchored Shift selection without adding history", async () => {
    const { user } = await setup();
    expect(selectedNumbers()).toEqual([1]);
    await user.click(page(2));
    expect(selectedNumbers()).toEqual([2]);
    fireEvent.click(page(3), { ctrlKey: true });
    expect(selectedNumbers()).toEqual([2, 3]);
    expect(screen.getByRole("heading", { name: "多页选择" })).toBeVisible();
    fireEvent.click(page(2), { metaKey: true });
    expect(selectedNumbers()).toEqual([3]);
    await user.click(page(1));
    fireEvent.click(page(3), { shiftKey: true });
    expect(selectedNumbers()).toEqual([1, 2, 3]);
    expect(button("撤销")).toBeDisabled();
    expect(tiles().every((tile) => tile.getAttribute("draggable") === "false")).toBe(true);
    expect(screen.getByText(/仅支持单页拖拽排序/)).toBeVisible();
  });

  it("limits select-all, Escape and Delete to the page grid and leaves input shortcuts alone", async () => {
    const { user } = await setup();
    const fileButton = button("查看 first.pdf（文件 1）");
    fileButton.focus();
    await user.keyboard("{Control>}a{/Control}{Delete}");
    expect(selectedNumbers()).toEqual([1]);
    expect(sourceOrder()).toEqual([1, 2, 3]);
    const grid = screen.getByLabelText("页面缩略图滚动区域");
    grid.focus();
    await user.keyboard("{Control>}a{/Control}");
    expect(selectedNumbers()).toEqual([1, 2, 3]);
    await user.keyboard("{Escape}");
    expect(selectedNumbers()).toEqual([]);
    expect(button("删除选中页面")).toBeDisabled();
    expect(button("顺时针旋转 90°")).toBeDisabled();
    fireEvent.keyDown(grid, { key: "a", metaKey: true });
    expect(selectedNumbers()).toEqual([1, 2, 3]);
    fireEvent.keyDown(grid, { key: "Escape" });
    const inlineInput = document.createElement("input");
    grid.append(inlineInput);
    inlineInput.focus();
    const inputShortcut = createEvent.keyDown(inlineInput, { key: "a", ctrlKey: true, cancelable: true });
    fireEvent(inlineInput, inputShortcut);
    expect(inputShortcut.defaultPrevented).toBe(false);
    expect(selectedNumbers()).toEqual([]);
    inlineInput.remove();
    await user.click(screen.getByLabelText("其他输入框"));
    await user.keyboard("{Control>}a{/Control}{Delete}");
    expect(sourceOrder()).toEqual([1, 2, 3]);
  });

  it("deletes a batch in one undo step, restores it with redo, and protects the last page", async () => {
    const { user } = await setup();
    await user.click(page(2));
    fireEvent.click(page(3), { ctrlKey: true });
    await user.click(button("删除选中页面"));
    expect(sourceOrder()).toEqual([1]);
    expect(screen.getByText(/当前修改仅保存在浏览器工作区/)).toBeVisible();
    await user.click(button("撤销"));
    expect(sourceOrder()).toEqual([1, 2, 3]);
    expect(selectedNumbers()).toEqual([2, 3]);
    expect(button("撤销")).toBeDisabled();
    await user.click(button("重做"));
    expect(sourceOrder()).toEqual([1]);
    await user.click(page(1));
    await user.click(button("删除选中页面"));
    expect(screen.getByRole("alert")).toHaveTextContent(/至少|最后|全部/);
    expect(sourceOrder()).toEqual([1]);
    expect(engine.open).toHaveBeenCalledOnce();
    expect(engine.documents[0].destroy).not.toHaveBeenCalled();
    await user.click(button("撤销"));
    expect(sourceOrder()).toEqual([1, 2, 3]);
  });

  it("preserves composition and contenteditable keyboard handling inside the editing region", async () => {
    const { user } = await setup();
    await user.click(button("顺时针旋转 90°"));
    const grid = screen.getByLabelText("页面缩略图滚动区域");
    for (const key of ["a", "z", "Delete", "Escape"]) {
      const event = createEvent.keyDown(grid, {
        key, ctrlKey: key === "a" || key === "z", isComposing: true, cancelable: true,
      });
      fireEvent(grid, event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(selectedNumbers()).toEqual([1]);
    expect(sourceOrder()).toEqual([1, 2, 3]);
    expect(page(1)).toHaveAttribute("data-rotation", "90");
    for (const mode of ["", "true", "plaintext-only"]) {
      const editable = document.createElement("div");
      editable.setAttribute("contenteditable", mode);
      const inner = document.createElement("span");
      editable.append(inner);
      grid.append(editable);
      for (const key of ["a", "z", "Delete", "Escape"]) {
        const event = createEvent.keyDown(inner, {
          key, ctrlKey: key === "a" || key === "z", cancelable: true,
        });
        fireEvent(inner, event);
        expect(event.defaultPrevented).toBe(false);
      }
      editable.remove();
    }
    expect(selectedNumbers()).toEqual([1]);
    expect(sourceOrder()).toEqual([1, 2, 3]);
    expect(page(1)).toHaveAttribute("data-rotation", "90");
  });

  it("rejects deletion of all selected pages without creating history", async () => {
    await setup();
    const grid = screen.getByLabelText("页面缩略图滚动区域");
    fireEvent.keyDown(grid, { key: "a", ctrlKey: true });
    fireEvent.keyDown(grid, { key: "Delete" });
    expect(sourceOrder()).toEqual([1, 2, 3]);
    expect(selectedNumbers()).toEqual([1, 2, 3]);
    expect(screen.getByRole("alert")).toHaveTextContent(/至少|最后|全部/);
    expect(button("撤销")).toBeDisabled();
  });

  it("keeps keyboard focus in the grid after deleting the focused tile so undo works immediately", async () => {
    const { user } = await setup();
    await user.click(page(2));
    expect(page(2)).toHaveFocus();
    await user.keyboard("{Delete}");
    expect(sourceOrder()).toEqual([1, 3]);
    expect(screen.getByLabelText("页面缩略图滚动区域")).toHaveFocus();
    await user.keyboard("{Control>}z{/Control}");
    expect(sourceOrder()).toEqual([1, 2, 3]);
    expect(selectedNumbers()).toEqual([2]);
    expect(button("撤销")).toBeDisabled();
  });

  it("combines original rotation, updates dimensions, and applies one batch rotation history entry", async () => {
    const { user } = await setup();
    const info = within(screen.getByRole("complementary", { name: "文档与页面信息" }));
    await user.click(page(3));
    expect(info.getByText("90°")).toBeVisible();
    await user.click(button("顺时针旋转 90°"));
    expect(info.getByText("180°")).toBeVisible();
    expect(info.getByText("纵向")).toBeVisible();
    expect(page(3)).toHaveAttribute("data-rotation", "90");
    await user.click(button("撤销"));
    expect(info.getByText("90°")).toBeVisible();
    fireEvent.click(page(1), { ctrlKey: true });
    await user.click(button("批量顺时针旋转 90°"));
    expect(tiles().map((tile) => tile.getAttribute("data-rotation"))).toEqual(["90", "0", "90"]);
    await user.click(button("撤销"));
    expect(tiles().map((tile) => tile.getAttribute("data-rotation"))).toEqual(["0", "0", "0"]);
    expect(button("撤销")).toBeDisabled();
    expect(engine.documents[0].pages).toEqual(originalPages);
  });

  it("moves a single page with boundary-aware buttons while preserving source mapping", async () => {
    const { user } = await setup();
    expect(button("向前移动一页")).toBeDisabled();
    await user.click(button("向后移动一页"));
    expect(sourceOrder()).toEqual([2, 1, 3]);
    expect(selectedNumbers()).toEqual([2]);
    expect(screen.getByText("原第 1 页")).toBeVisible();
    await user.click(button("向后移动一页"));
    expect(sourceOrder()).toEqual([2, 3, 1]);
    expect(button("向后移动一页")).toBeDisabled();
    await user.click(button("撤销"));
    expect(sourceOrder()).toEqual([2, 1, 3]);
    await user.click(button("重做"));
    expect(sourceOrder()).toEqual([2, 3, 1]);
    expect(engine.open).toHaveBeenCalledOnce();
  });

  it("shows a drag insertion marker, reorders only on drop, and supports undo and redo", async () => {
    const { user } = await setup();
    const dataTransfer = transfer();
    fireEvent.dragStart(page(1), { dataTransfer });
    const target = page(3);
    dragOver(target, dataTransfer, true);
    expect(target).toHaveClass("drop-after");
    expect(sourceOrder()).toEqual([1, 2, 3]);
    expect(button("撤销")).toBeDisabled();
    drop(target, dataTransfer, true);
    expect(sourceOrder()).toEqual([2, 3, 1]);
    expect(selectedNumbers()).toEqual([3]);
    expect(screen.queryByText("松开鼠标，添加 PDF")).not.toBeInTheDocument();
    expect(engine.open).toHaveBeenCalledOnce();
    await user.click(button("撤销"));
    expect(sourceOrder()).toEqual([1, 2, 3]);
    await user.click(button("重做"));
    expect(sourceOrder()).toEqual([2, 3, 1]);
  });

  it("cancels drag without editing and rejects dragging a multi-selection", async () => {
    await setup();
    const dataTransfer = transfer();
    fireEvent.dragStart(page(1), { dataTransfer });
    dragOver(page(3), dataTransfer, false);
    expect(page(3)).toHaveClass("drop-before");
    fireEvent.dragEnd(page(1), { dataTransfer });
    expect(page(3)).not.toHaveClass("drop-before");
    expect(sourceOrder()).toEqual([1, 2, 3]);
    expect(button("撤销")).toBeDisabled();
    fireEvent.click(page(2), { ctrlKey: true });
    const start = createEvent.dragStart(page(1), { dataTransfer, cancelable: true });
    fireEvent(page(1), start);
    expect(start.defaultPrevented).toBe(true);
    drop(page(3), dataTransfer, true);
    expect(sourceOrder()).toEqual([1, 2, 3]);
    expect(selectedNumbers()).toEqual([1, 2]);
    expect(button("撤销")).toBeDisabled();
  });

  it("cancels a pending single-page drop if selection changes to multiple pages during the drag", async () => {
    await setup();
    const dataTransfer = transfer();
    fireEvent.dragStart(page(1), { dataTransfer });
    dragOver(page(3), dataTransfer, true);
    expect(page(3)).toHaveClass("drop-after");
    fireEvent.keyDown(screen.getByLabelText("页面缩略图滚动区域"), { key: "a", ctrlKey: true });
    expect(selectedNumbers()).toEqual([1, 2, 3]);
    drop(page(3), dataTransfer, true);
    expect(sourceOrder()).toEqual([1, 2, 3]);
    expect(selectedNumbers()).toEqual([1, 2, 3]);
    expect(page(3)).not.toHaveClass("drop-after");
    expect(button("撤销")).toBeDisabled();
    expect(engine.open).toHaveBeenCalledOnce();
  });

  it("handles editing shortcuts only in editing contexts and clears redo after a new operation", async () => {
    const { user } = await setup();
    await user.click(button("顺时针旋转 90°"));
    const fileButton = button("查看 first.pdf（文件 1）");
    fireEvent.keyDown(fileButton, { key: "z", ctrlKey: true });
    expect(page(1)).toHaveAttribute("data-rotation", "90");
    fireEvent.keyDown(button("向后移动一页"), { key: "z", metaKey: true });
    expect(page(1)).toHaveAttribute("data-rotation", "0");
    const grid = screen.getByLabelText("页面缩略图滚动区域");
    fireEvent.keyDown(grid, { key: "z", metaKey: true, shiftKey: true });
    expect(page(1)).toHaveAttribute("data-rotation", "90");
    fireEvent.keyDown(grid, { key: "z", ctrlKey: true });
    fireEvent.keyDown(grid, { key: "y", ctrlKey: true });
    expect(page(1)).toHaveAttribute("data-rotation", "90");
    fireEvent.keyDown(grid, { key: "z", ctrlKey: true });
    await user.click(button("向后移动一页"));
    expect(button("重做")).toBeDisabled();
    expect(sourceOrder()).toEqual([2, 1, 3]);
  });

  it("retains independent selection and history per file and releases them on removal and clear", async () => {
    const { user } = await setup(["first.pdf", "second.pdf"]);
    await user.click(page(2));
    await user.click(button("删除选中页面"));
    expect(sourceOrder()).toEqual([1, 3]);
    await user.click(button("查看 second.pdf（文件 2）"));
    expect(sourceOrder()).toEqual([1, 2, 3]);
    expect(button("撤销")).toBeDisabled();
    await user.click(page(3));
    await user.click(button("逆时针旋转 90°"));
    await user.click(button("查看 first.pdf（文件 1）"));
    expect(sourceOrder()).toEqual([1, 3]);
    await user.click(button("撤销"));
    expect(sourceOrder()).toEqual([1, 2, 3]);
    expect(selectedNumbers()).toEqual([2]);
    await user.click(button("移除 first.pdf（文件 1）"));
    expect(engine.documents[0].destroy).toHaveBeenCalledOnce();
    expect(page(3)).toHaveAttribute("data-rotation", "270");
    expect(selectedNumbers()).toEqual([3]);
    await user.click(button("撤销"));
    expect(page(3)).toHaveAttribute("data-rotation", "0");
    await user.click(button("清空工作区"));
    expect(tiles()).toHaveLength(0);
    expect(engine.documents[1].destroy).toHaveBeenCalledOnce();
    expect(engine.destroy).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "撤销" })).not.toBeInTheDocument();
  });

  it("warns on refresh only while edits differ from the source and removes listeners on cleanup", async () => {
    const { user, unmount } = await setup();
    const beforeUnload = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(beforeUnload()).toBe(false);
    await user.click(button("顺时针旋转 90°"));
    expect(beforeUnload()).toBe(true);
    await user.click(button("撤销"));
    expect(beforeUnload()).toBe(false);
    await user.click(button("重做"));
    expect(beforeUnload()).toBe(true);
    await user.click(button("清空工作区"));
    expect(beforeUnload()).toBe(false);
    unmount();
    expect(beforeUnload()).toBe(false);
  });

  it("applies rapid edits in order without reparsing, mutating source metadata or network requests", async () => {
    await setup();
    const network = vi.fn(() => { throw new Error("Unexpected document network request"); });
    vi.stubGlobal("fetch", network);
    const rotate = button("顺时针旋转 90°");
    for (let count = 0; count < 4; count++) fireEvent.click(rotate);
    expect(page(1)).toHaveAttribute("data-rotation", "0");
    expect(screen.queryByText(/当前修改仅保存在浏览器工作区/)).not.toBeInTheDocument();
    fireEvent.click(button("向后移动一页"));
    fireEvent.keyDown(screen.getByLabelText("页面缩略图滚动区域"), { key: "Delete" });
    expect(sourceOrder()).toEqual([2, 3]);
    for (let count = 0; count < 6; count++) fireEvent.click(button("撤销"));
    expect(sourceOrder()).toEqual([1, 2, 3]);
    expect(tiles().map((tile) => tile.getAttribute("data-rotation"))).toEqual(["0", "0", "0"]);
    expect(button("撤销")).toBeDisabled();
    expect(engine.documents[0].pages).toEqual(originalPages);
    expect(engine.open).toHaveBeenCalledOnce();
    expect(network).not.toHaveBeenCalled();
  });
});
