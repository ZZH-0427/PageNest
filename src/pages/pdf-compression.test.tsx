import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PdfCompression } from "./pdf-compression";
import type { CompressionMode, CompressionRow, CompressionState, CompressionStatus } from "../compression/types";

const model = vi.hoisted(() => ({
  state: { files: [], busy: false, notice: null, mode: "lossless", availableModes: ["lossless", "high", "balanced", "strong"] } as CompressionState,
  controller: { addFiles: vi.fn(), clear: vi.fn(), removeFile: vi.fn(), dismissNotice: vi.fn(), setMode: vi.fn(),
    startAll: vi.fn(async () => {}), start: vi.fn(async () => {}), cancel: vi.fn(), download: vi.fn() },
}));
vi.mock("../compression/use-compression", () => ({ usePdfCompression: () => model }));

function row(id = "first", ordinal = 1, status: CompressionStatus = "queued"): CompressionRow {
  return { id, ordinal, name: "artificial.pdf", size: 1600, pageCount: null, status, result: null, error: null };
}
function ready(outputBytes = 800): CompressionRow {
  return { ...row("first", 1, outputBytes < 1600 ? "ready" : "no-benefit"), pageCount: 3,
    result: { outputBytes, savedBytes: 1600 - outputBytes, reductionPercent: (1600 - outputBytes) / 1600 * 100,
      fileName: "artificial_optimized.pdf", methods: ["PDF 对象流重新封装"], changedImages: 0, skippedImages: 0,
      validationLabel: "文字、页面与渲染通过独立校验" } };
}
beforeEach(() => {
  model.state = { files: [], busy: false, notice: null, mode: "lossless", availableModes: ["lossless", "high", "balanced", "strong"] };
});

describe("real compression page controls", () => {
  it("explains local processing, limits and structural compatibility without a fake result", () => {
    render(<PdfCompression />);
    expect(screen.getByRole("heading", { level: 1, name: "文件压缩" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "从一份 PDF 开始。" })).toBeInTheDocument();
    expect(screen.getByText("单份 ≤ 32 MiB · 最多 5 份 · 累计 ≤ 96 MiB · 每份 ≤ 200 页")).toBeInTheDocument();
    expect(screen.getByText(/所有文件都在当前浏览器内处理，不会自动上传/)).toBeInTheDocument();
    expect(screen.getByText(/不等于字节级无损/)).toBeInTheDocument();
    expect(screen.getByText(/检测到加密、数字签名、表单、附件或活动内容时会拒绝/)).toBeInTheDocument();
    expect(screen.getByText(/PPTX 压缩与 ZIP 批量下载尚未提供/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始压缩" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "清空列表" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /下载/ })).not.toBeInTheDocument();
    expect(screen.getByText("原生浏览器 API · 本地 Worker")).toBeInTheDocument();
  });

  it("forwards original File batches and resets the input so the same file can be selected again", async () => {
    const user = userEvent.setup(); render(<PdfCompression />);
    const files = [new File(["artificial one"], "same.pdf", { type: "application/pdf" }),
      new File(["artificial two"], "same.pdf", { type: "application/pdf" })];
    const input = screen.getByLabelText("选择压缩 PDF 文件");
    expect(input).toHaveAttribute("multiple"); expect(input).toHaveAttribute("accept", "application/pdf,.pdf");
    await user.upload(input, files); expect(model.controller.addFiles).toHaveBeenLastCalledWith(files); expect(input).toHaveValue("");
    await user.upload(input, files); expect(model.controller.addFiles).toHaveBeenCalledTimes(2);
  });

  it("retains nested drag feedback and forwards dropped local files with a copy effect", () => {
    render(<PdfCompression />);
    const target = screen.getByRole("region", { name: "PDF 压缩文件输入" }), child = screen.getByRole("button", { name: "选择 PDF" });
    const file = new File(["artificial"], "drop.pdf", { type: "application/pdf" });
    const dataTransfer = { files: [file], types: ["Files"], dropEffect: "none" };
    fireEvent.dragEnter(target, { dataTransfer }); fireEvent.dragEnter(child, { dataTransfer }); fireEvent.dragLeave(child, { dataTransfer });
    expect(screen.getByText("松开鼠标，添加 PDF")).toBeInTheDocument();
    fireEvent.dragOver(target, { dataTransfer }); expect(dataTransfer.dropEffect).toBe("copy");
    fireEvent.drop(target, { dataTransfer }); expect(model.controller.addFiles).toHaveBeenCalledWith([file]);
    expect(screen.queryByText("松开鼠标，添加 PDF")).not.toBeInTheDocument();
  });

  it("does not show a file drop state for dragged text or a URL", () => {
    render(<PdfCompression />);
    fireEvent.dragEnter(screen.getByRole("region", { name: "PDF 压缩文件输入" }), { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(screen.queryByText("松开鼠标，添加 PDF")).not.toBeInTheDocument();
    expect(model.controller.addFiles).not.toHaveBeenCalled();
  });

  it.each(["lossless", "high", "balanced", "strong"] as const)("offers the verified %s mode with its real policy", async (mode) => {
    const user = userEvent.setup(); model.state = { ...model.state, mode: mode === "lossless" ? "high" : "lossless" }; render(<PdfCompression />);
    const name: Record<CompressionMode, RegExp> = { lossless: /无损优化/, high: /高质量/, balanced: /均衡压缩/, strong: /较强压缩/ };
    await user.click(screen.getByRole("radio", { name: name[mode] }));
    expect(model.controller.setMode).toHaveBeenCalledWith(mode);
    expect(screen.getByText(/JPEG 质量参数 0.88/)).toBeInTheDocument();
    expect(screen.getByText(/JPEG 质量参数 0.72/)).toBeInTheDocument();
    expect(screen.getByText(/JPEG 质量参数 0.50/)).toBeInTheDocument();
  });

  it("gates unsupported browser modes and cannot start an unavailable engine", async () => {
    const user = userEvent.setup(); model.state = { ...model.state, files: [row()], availableModes: [] };
    render(<PdfCompression />);
    expect(screen.getAllByRole("radio").every((radio) => radio.hasAttribute("disabled"))).toBe(true);
    expect(screen.getByRole("button", { name: "开始压缩" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("当前浏览器缺少本地 Worker 或压缩流 API");
    await user.click(screen.getByRole("radio", { name: /高质量/ })); expect(model.controller.setMode).not.toHaveBeenCalled();
  });

  it("starts only on a user action, distinguishes same names and forwards clear/remove independently", async () => {
    const user = userEvent.setup(); model.state = { ...model.state, files: [row(), row("second", 2)] };
    render(<PdfCompression />);
    expect(model.controller.startAll).not.toHaveBeenCalled();
    expect(screen.getByRole("listitem", { name: "artificial.pdf（文件 1）" })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "artificial.pdf（文件 2）" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始压缩" })); expect(model.controller.startAll).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "移除 artificial.pdf（文件 2）" })); expect(model.controller.removeFile).toHaveBeenCalledWith("second");
    await user.click(screen.getByRole("button", { name: "清空列表" })); expect(model.controller.clear).toHaveBeenCalledTimes(1);
  });

  it("shows actual byte statistics and validation methods and downloads one verified file at a time", async () => {
    const user = userEvent.setup(); model.state = { ...model.state, files: [ready()] }; render(<PdfCompression />);
    const card = screen.getByRole("listitem", { name: "artificial.pdf（文件 1）" });
    expect(within(card).getByText("3 页", { exact: false })).toBeInTheDocument();
    expect(within(card).getAllByText("800 B")).toHaveLength(2);
    expect(within(card).getByText("50%")).toBeInTheDocument();
    expect(within(card).getByText("文字、页面与渲染通过独立校验")).toBeInTheDocument();
    expect(within(card).getByText("PDF 对象流重新封装")).toBeInTheDocument();
    expect(within(card).getByText("下载就绪")).toBeInTheDocument();
    expect(model.controller.download).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "下载 artificial_optimized.pdf（文件 1）" }));
    expect(model.controller.download).toHaveBeenCalledWith("first");
    await user.click(screen.getByRole("button", { name: "重新处理 artificial.pdf（文件 1）" }));
    expect(model.controller.start).toHaveBeenCalledWith("first");
  });

  it.each([1600, 2000])("does not call a non-smaller %s-byte result compression success or offer its download", (size) => {
    model.state = { ...model.state, files: [ready(size)] }; render(<PdfCompression />);
    expect(screen.getByText("此 PDF 已较为紧凑，本次优化未获得更小的文件。")).toBeInTheDocument();
    expect(screen.getByText("无压缩收益")).toBeInTheDocument();
    expect(screen.getByText(size === 1600 ? "0%" : "-25%")).toBeInTheDocument();
    if (size > 1600) expect(screen.getByText("增加空间")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /下载/ })).not.toBeInTheDocument();
    expect(screen.queryByText("下载就绪")).not.toBeInTheDocument();
  });

  it("shows image change/skip counts without promising that every image can be compressed", () => {
    const image = ready();
    model.state = { ...model.state, mode: "balanced", files: [{ ...image, result: { ...image.result!, changedImages: 2, skippedImages: 1 } }] };
    render(<PdfCompression />);
    expect(screen.getByText("已优化图像 2 个 · 跳过图像 1 个")).toBeInTheDocument();
    expect(screen.getByText(/不将整页转为截图，不降低像素尺寸/)).toBeInTheDocument();
  });

  it.each(["reading", "optimizing", "validating"] as const)("announces %s, disables duplicate starts and leaves cancellation/removal available", async (stage) => {
    const user = userEvent.setup(); model.state = { ...model.state, busy: true, files: [row("first", 1, stage)] };
    render(<PdfCompression />);
    expect(screen.getByRole("button", { name: "开始压缩" })).toBeDisabled();
    expect(screen.getAllByRole("radio").every((radio) => (radio as HTMLInputElement).disabled || radio.closest("fieldset")?.disabled)).toBe(true);
    expect(screen.getByText(/正在逐份处理/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "取消 artificial.pdf（文件 1）" })); expect(model.controller.cancel).toHaveBeenCalledWith("first");
    await user.click(screen.getByRole("button", { name: "停止本批" })); expect(model.controller.cancel).toHaveBeenLastCalledWith();
    await user.click(screen.getByRole("button", { name: "移除 artificial.pdf（文件 1）" })); expect(model.controller.removeFile).toHaveBeenCalledWith("first");
  });

  it("honestly keeps the workspace busy after clearing a noninterruptible task", () => {
    model.state = { ...model.state, busy: true }; render(<PdfCompression />);
    expect(screen.getByText("正在停止处理，等待底层任务释放。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始压缩" })).toBeDisabled();
  });

  it("shows per-file errors and safe notices without a downloadable failed result", async () => {
    const user = userEvent.setup();
    model.state = { ...model.state, files: [{ ...row("first", 1, "error"), error: "此结构暂不支持压缩，请保留原件。" }],
      notice: "已触发下载，请检查浏览器下载列表；应用无法确认文件已保存到磁盘。" };
    render(<PdfCompression />);
    expect(screen.getByRole("alert")).toHaveTextContent("此结构暂不支持压缩");
    expect(screen.getByText(/无法确认文件已保存到磁盘/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /下载/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭压缩提示" })); expect(model.controller.dismissNotice).toHaveBeenCalledTimes(1);
  });

  it("limits the picker at five retained files and removes stale results after a cleared snapshot", () => {
    model.state = { ...model.state, files: Array.from({ length: 5 }, (_, index) => ({ ...ready(), id: `file-${index}`, ordinal: index + 1 })) };
    const view = render(<PdfCompression />);
    expect(screen.getByRole("button", { name: "添加 PDF" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "选择 PDF" })).toBeDisabled();
    model.state = { ...model.state, files: [] }; view.rerender(<PdfCompression />);
    expect(screen.queryByRole("button", { name: /下载/ })).not.toBeInTheDocument();
    expect(screen.getByText("从一份 PDF 开始。")).toBeInTheDocument();
  });
});
