import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfFileEntry, PdfPageInfo } from "../pdf/types";
import { PdfEditor } from "./pdf-editor";

const model = vi.hoisted(() => ({
  state: {
    files: [] as PdfFileEntry[],
    selectedId: null as string | null,
    notice: null as string | null,
  },
  workspace: {
    addFiles: vi.fn(),
    selectFile: vi.fn(),
    selectPage: vi.fn(),
    removeFile: vi.fn(),
    clear: vi.fn(),
    dismissNotice: vi.fn(),
  },
}));

vi.mock("../pdf/use-pdf-workspace", () => ({
  usePdfWorkspace: () => model,
}));

vi.mock("../components/pdf/thumbnail", () => ({
  PdfThumbnail: ({ page, selected, onSelect }: {
    page: PdfPageInfo;
    selected: boolean;
    onSelect: () => void;
  }) => (
    <button type="button" onClick={onSelect} aria-pressed={selected}>
      第 {page.number} 页
    </button>
  ),
}));

const portrait: PdfPageInfo = {
  number: 1, width: 595, height: 842, rotation: 0, orientation: "portrait",
};
const landscape: PdfPageInfo = {
  number: 2, width: 842, height: 595, rotation: 0, orientation: "landscape",
};

function documentEntry(id: string, ordinal: number, pages = [portrait]): PdfFileEntry {
  return {
    id, ordinal, name: "synthetic.pdf", size: 2048,
    status: "ready", pages, selectedPage: 1, error: null,
  };
}

beforeEach(() => {
  model.state = { files: [], selectedId: null, notice: null };
});

describe("PDF workspace user interface", () => {
  it("explains the independent memory-only workspace and all import limits", () => {
    render(<PdfEditor />);
    expect(screen.getByRole("heading", { name: "PDF 页面管理" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "放入 PDF，让页面呈现。" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清空工作区" })).toBeDisabled();
    expect(screen.getByText("最多 20 个 · 累计 ≤ 256 MiB")).toBeInTheDocument();
    expect(screen.getByText("每份文档最多 1,000 页")).toBeInTheDocument();
    expect(screen.getByText(/离开此页或刷新后，PDF 工作区将清空/)).toBeInTheDocument();
    expect(screen.getByLabelText("导入 PDF 文件")).toHaveAttribute("multiple");
  });

  it("forwards a batch of original File objects and permits selecting the same batch again", async () => {
    const user = userEvent.setup();
    render(<PdfEditor />);
    const files = [
      new File(["synthetic one"], "same.pdf", { type: "application/pdf" }),
      new File(["synthetic two"], "same.pdf", { type: "application/pdf" }),
    ];
    const input = screen.getByLabelText("导入 PDF 文件");
    await user.upload(input, files);
    expect(model.workspace.addFiles).toHaveBeenLastCalledWith(files);
    expect(input).toHaveValue("");
    await user.upload(input, files);
    expect(model.workspace.addFiles).toHaveBeenCalledTimes(2);
  });

  it("accepts dropped batches and preserves drag feedback across nested elements", () => {
    const { container } = render(<PdfEditor />);
    const target = container.querySelector(".pdf-workbench")!;
    const child = screen.getByRole("button", { name: "选择 PDF" });
    const file = new File(["synthetic"], "drop.pdf", { type: "application/pdf" });
    const dataTransfer = { files: [file], types: ["Files"], dropEffect: "none" };
    fireEvent.dragEnter(target, { dataTransfer });
    fireEvent.dragEnter(child, { dataTransfer });
    fireEvent.dragLeave(child, { dataTransfer });
    expect(screen.getByText("松开鼠标，添加 PDF")).toBeInTheDocument();
    fireEvent.dragOver(target, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("copy");
    fireEvent.drop(target, { dataTransfer });
    expect(model.workspace.addFiles).toHaveBeenCalledWith([file]);
    expect(screen.queryByText("松开鼠标，添加 PDF")).not.toBeInTheDocument();
  });

  it("distinguishes same-name documents and reflects the selected document's actual page list", async () => {
    const user = userEvent.setup();
    const first = documentEntry("first", 1, [portrait, landscape]);
    const second = documentEntry("second", 2);
    model.state = { files: [first, second], selectedId: "first", notice: null };
    const view = render(<PdfEditor />);
    const firstButton = screen.getByRole("button", { name: "查看 synthetic.pdf（文件 1）" });
    const secondButton = screen.getByRole("button", { name: "查看 synthetic.pdf（文件 2）" });
    expect(firstButton).toHaveAttribute("aria-pressed", "true");
    expect(secondButton).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "第 2 页" })).toBeInTheDocument();
    await user.click(secondButton);
    expect(model.workspace.selectFile).toHaveBeenCalledWith("second");
    model.state = { ...model.state, selectedId: "second" };
    view.rerender(<PdfEditor />);
    expect(screen.queryByRole("button", { name: "第 2 页" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("complementary", { name: "文档与页面信息" })).getByText("1 页")).toBeInTheDocument();
    expect(secondButton).toHaveAttribute("aria-pressed", "true");
  });

  it("selects a page and displays its own dimensions, direction and selected feedback", async () => {
    const user = userEvent.setup();
    const file = documentEntry("first", 1, [portrait, landscape]);
    model.state = { files: [file], selectedId: "first", notice: null };
    const view = render(<PdfEditor />);
    await user.click(screen.getByRole("button", { name: "第 2 页" }));
    expect(model.workspace.selectPage).toHaveBeenCalledWith("first", 2);
    model.state = { ...model.state, files: [{ ...file, selectedPage: 2 }] };
    view.rerender(<PdfEditor />);
    expect(screen.getByRole("button", { name: "第 2 页" })).toHaveAttribute("aria-pressed", "true");
    const info = within(screen.getByRole("complementary", { name: "文档与页面信息" }));
    expect(info.getByText("842 pt")).toBeInTheDocument();
    expect(info.getByText("595 pt")).toBeInTheDocument();
    expect(info.getByText("横向")).toBeInTheDocument();
    expect(screen.getByText("已选择第 2 页")).toBeInTheDocument();
  });

  it("provides independent file removal and workspace clearing controls", async () => {
    const user = userEvent.setup();
    model.state = { files: [documentEntry("one", 1), documentEntry("two", 2)], selectedId: "one", notice: null };
    render(<PdfEditor />);
    await user.click(screen.getByRole("button", { name: "移除 synthetic.pdf（文件 2）" }));
    expect(model.workspace.removeFile).toHaveBeenCalledWith("two");
    expect(model.workspace.selectFile).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "清空工作区" }));
    expect(model.workspace.clear).toHaveBeenCalledOnce();
  });

  it("shows errors for the failed document without losing the successful document", async () => {
    const user = userEvent.setup();
    const broken = { ...documentEntry("broken", 2), status: "error" as const, pages: [], error: "此 PDF 需要密码。当前版本暂不支持密码保护的文档。" };
    model.state = { files: [documentEntry("ok", 1), broken], selectedId: "broken", notice: "超过工作区累计容量限制。" };
    render(<PdfEditor />);
    expect(screen.getByText(broken.error)).toBeInTheDocument();
    expect(screen.getByText("其他已导入的文档不受影响。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看 synthetic.pdf（文件 1）" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "第 1 页" })).not.toBeInTheDocument();
    expect(screen.getByText("超过工作区累计容量限制。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭 PDF 导入提示" }));
    expect(model.workspace.dismissNotice).toHaveBeenCalledOnce();
  });

  it.each(["queued", "reading", "parsing"] as const)("shows the real %s stage and exposes cancellation by removal", async (status) => {
    const user = userEvent.setup();
    model.state = { files: [{ ...documentEntry("pending", 1), status, pages: [] }], selectedId: "pending", notice: null };
    render(<PdfEditor />);
    expect(screen.getByRole("status")).toHaveTextContent("你可以切换文档，或移除文件来取消。");
    expect(screen.queryByRole("button", { name: "第 1 页" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "移除 synthetic.pdf（文件 1）" }));
    expect(model.workspace.removeFile).toHaveBeenCalledWith("pending");
  });

  it("keeps all future editing operations disabled and exposes keyboard-operable file selection", async () => {
    const user = userEvent.setup();
    model.state = { files: [documentEntry("one", 1)], selectedId: "one", notice: null };
    render(<PdfEditor />);
    for (const name of ["拆分", "合并", "删除页面", "排序", "旋转"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    expect(screen.getByText(/编辑功能尚未实现/)).toBeInTheDocument();
    const fileButton = screen.getByRole("button", { name: "查看 synthetic.pdf（文件 1）" });
    fileButton.focus();
    expect(fileButton).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(model.workspace.selectFile).toHaveBeenCalledWith("one");
    expect(screen.getByLabelText("页面缩略图滚动区域")).toHaveAttribute("tabindex", "0");
  });
});
