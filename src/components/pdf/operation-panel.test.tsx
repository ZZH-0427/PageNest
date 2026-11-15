import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PdfOperationController } from "../../pdf/operation-controller";
import type { PdfDownloadEnvironment } from "../../pdf/export-controller";
import { createEditState } from "../../pdf/edit";
import type { PdfOutputPlan } from "../../pdf/output-plan";
import type { PdfFileEntry, PdfPageInfo } from "../../pdf/types";
import { PdfOperationPanel } from "./operation-panel";

function entry(id: string, count: number, ordinal: number, name = "same.pdf"): PdfFileEntry {
  const pages = Array.from({ length: count }, (_, index): PdfPageInfo => ({ number: index + 1, width: 420, height: 594, rotation: 0, orientation: "portrait" }));
  return { id, name, ordinal, size: 2048, status: "ready", pages, selectedPage: 1, edit: createEditState(id, pages), error: null };
}
function task() {
  const generate = vi.fn(async (_output: PdfOutputPlan["outputs"][number], _signal: AbortSignal, onStage: (stage: "generating" | "validating") => void) => {
    onStage("validating");
    return new Uint8Array([37, 80, 68, 70]);
  });
  const capture = vi.fn<(plan: PdfOutputPlan) => { signal: AbortSignal; generate: typeof generate }>(() => ({ signal: new AbortController().signal, generate }));
  const downloads: PdfDownloadEnvironment = { createUrl: vi.fn(() => "blob:synthetic-operation"), revokeUrl: vi.fn(), trigger: vi.fn() };
  const controller = new PdfOperationController(capture, downloads);
  return { controller, capture, generate, downloads, start: vi.spyOn(controller, "start"), cancel: vi.spyOn(controller, "cancel") };
}

describe("PDF merge and split operation panel", () => {
  it("previews selected same-name documents in user-defined order and keeps each current edit mapping", async () => {
    const user = userEvent.setup(), state = task();
    const first = entry("a", 3, 1), second = entry("b", 2, 2), third = entry("c", 1, 3);
    const pages = first.edit!.present.pages;
    first.edit = { ...first.edit!, present: { ...first.edit!.present, pages: [{ ...pages[2], rotationDelta: 90 }, pages[0]] } };
    render(<PdfOperationPanel files={[first, second, third]} selectedId="a" mode="merge" controller={state.controller} onClose={vi.fn()} />);
    await user.click(screen.getByRole("checkbox", { name: "合并 same.pdf（文件 3）" }));
    await user.click(screen.getByRole("button", { name: "same.pdf（文件 2）上移" }));
    const list = within(screen.getByRole("list", { name: "合并文档顺序" })).getAllByRole("checkbox");
    expect(list[0]).toHaveAccessibleName("合并 same.pdf（文件 2）");
    expect(screen.getByText("输出计划 · 1 份 / 4 页")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "导出文件名" }), { target: { value: "merged/new?.pdf" } });
    expect(within(screen.getByRole("list", { name: "输出计划预览" })).getByText("merged_new_.pdf")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "生成合并 PDF" }));
    await waitFor(() => expect(state.controller.getSnapshot().stage).toBe("ready"));
    const plan = state.capture.mock.calls[0][0];
    expect(plan.outputs[0].pages.map((page) => [page.sourceDocumentId, page.sourcePageNumber, page.rotationDelta])).toEqual([["b", 1, 0], ["b", 2, 0], ["a", 3, 90], ["a", 1, 0]]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(state.downloads.trigger).not.toHaveBeenCalled();
  });

  it("rejects overlapping ranges before generation and makes comma-separated outputs explicit", async () => {
    const state = task();
    render(<PdfOperationPanel files={[entry("a", 12, 1)]} selectedId="a" mode="split" controller={state.controller} onClose={vi.fn()} />);
    expect(screen.getByText(/逗号分隔独立 PDF/)).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "拆分页码范围" }), { target: { value: "1-3,3-7" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/重复|重叠/);
    expect(screen.getByRole("button", { name: "生成拆分 PDF" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", { name: "生成拆分 PDF" }).closest("form")!);
    expect(state.start).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "拆分页码范围" }), { target: { value: "1-3,5,8-10" } });
    expect(within(screen.getByRole("list", { name: "输出计划预览" })).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("输出计划 · 3 份 / 7 页")).toBeVisible();
  });

  it("previews every-N remainder outputs and downloads verified results only by individual clicks", async () => {
    const user = userEvent.setup(), state = task();
    render(<PdfOperationPanel files={[entry("a", 12, 1)]} selectedId="a" mode="split" controller={state.controller} onClose={vi.fn()} />);
    await user.click(screen.getByRole("radio", { name: "每 N 页" }));
    fireEvent.change(screen.getByRole("textbox", { name: "输出文件名前缀" }), { target: { value: "报告/新版" } });
    const preview = within(screen.getByRole("list", { name: "输出计划预览" }));
    expect(preview.getAllByRole("listitem")).toHaveLength(3);
    expect(preview.getByText("报告_新版_part-03.pdf")).toBeVisible();
    expect(preview.getByText(/11.*12.*2 页/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "生成拆分 PDF" }));
    const results = await screen.findByRole("list", { name: "已验证输出结果" });
    expect(within(results).getAllByRole("listitem")).toHaveLength(3);
    expect(state.downloads.trigger).not.toHaveBeenCalled();
    await user.click(within(results).getByRole("button", { name: "下载 报告_新版_part-02.pdf" }));
    expect(state.downloads.trigger).toHaveBeenCalledExactlyOnceWith("blob:synthetic-operation", "报告_新版_part-02.pdf");
    expect(screen.getByText(/无法确认文件已保存到磁盘/)).toBeVisible();
    expect(state.controller.getSnapshot().results.filter((result) => result.downloaded)).toHaveLength(1);
  });

  it("blocks duplicate starts and keeps cancellation busy until the running output settles", async () => {
    const state = task();
    let finish!: (bytes: Uint8Array<ArrayBuffer>) => void;
    state.generate.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<PdfOperationPanel files={[entry("a", 2, 1), entry("b", 2, 2)]} selectedId="a" mode="merge" controller={state.controller} onClose={vi.fn()} />);
    const generate = screen.getByRole("button", { name: "生成合并 PDF" });
    fireEvent.click(generate); fireEvent.click(generate);
    expect(state.start).toHaveBeenCalledOnce();
    expect(generate).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "导出文件名" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("生成中");
    fireEvent.click(screen.getByRole("button", { name: "停止等待" }));
    expect(screen.getByRole("status")).toHaveTextContent("正在停止等待");
    expect(screen.getByRole("button", { name: "停止等待" })).toBeDisabled();
    await act(async () => { finish(new Uint8Array([37, 80, 68, 70])); });
    await waitFor(() => expect(generate).toBeEnabled());
    expect(screen.queryByRole("list", { name: "已验证输出结果" })).not.toBeInTheDocument();
    expect(state.downloads.trigger).not.toHaveBeenCalled();
  });

  it("keeps the submitted plan and merge task when current source edits and selection change", async () => {
    const state = task(), first = entry("a", 3, 1), second = entry("b", 2, 2);
    let finish!: (bytes: Uint8Array<ArrayBuffer>) => void;
    state.generate.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<PdfOperationPanel files={[first, second]} selectedId="a" mode="merge" controller={state.controller} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "生成合并 PDF" }));
    const changed = { ...first, edit: { ...first.edit!, present: { ...first.edit!.present, pages: first.edit!.present.pages.slice(0, 1) } } };
    view.rerender(<PdfOperationPanel files={[changed, second]} selectedId="b" mode="merge" controller={state.controller} onClose={vi.fn()} />);
    expect(state.cancel).not.toHaveBeenCalled();
    expect(screen.getByText("本次计划 · 1 份 / 5 页")).toBeVisible();
    await act(async () => { finish(new Uint8Array([37, 80, 68, 70])); });
    await screen.findByRole("list", { name: "已验证输出结果" });
    expect(screen.getByText("本次计划 · 1 份 / 5 页")).toBeVisible();
    expect(state.controller.getSnapshot().results[0].pageCount).toBe(5);
    expect(screen.queryByText("输出计划 · 1 份 / 3 页")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "导出文件名" }), { target: { value: "next.pdf" } });
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(screen.queryByRole("list", { name: "已验证输出结果" })).not.toBeInTheDocument();
    expect(screen.getByText("输出计划 · 1 份 / 3 页")).toBeVisible();
  });

  it("cancels results when the mode or source changes and when the panel unmounts", async () => {
    const state = task(), files = [entry("a", 3, 1), entry("b", 2, 2)];
    const view = render(<PdfOperationPanel files={files} selectedId="a" mode="merge" controller={state.controller} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "生成合并 PDF" }));
    await screen.findByRole("list", { name: "已验证输出结果" });
    view.rerender(<PdfOperationPanel files={files} selectedId="a" mode="split" controller={state.controller} onClose={vi.fn()} />);
    expect(state.cancel).toHaveBeenCalledOnce();
    expect(state.controller.getSnapshot().stage).toBe("idle");
    view.rerender(<PdfOperationPanel files={files} selectedId="b" mode="split" controller={state.controller} onClose={vi.fn()} />);
    expect(state.cancel).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(state.cancel).toHaveBeenCalledTimes(3);
  });

  it("disables generation during another output task and hides private backend failures", async () => {
    const state = task(), files = [entry("a", 2, 1), entry("b", 2, 2)];
    const view = render(<PdfOperationPanel files={files} selectedId="a" mode="merge" externalBusy controller={state.controller} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "生成合并 PDF" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("另一项 PDF 输出任务正在运行");
    view.rerender(<PdfOperationPanel files={files} selectedId="a" mode="merge" controller={state.controller} onClose={vi.fn()} />);
    state.generate.mockRejectedValueOnce(new Error("SYNTHETIC_PRIVATE_OUTPUT_FAILURE"));
    fireEvent.click(screen.getByRole("button", { name: "生成合并 PDF" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("处理失败"));
    expect(screen.getByRole("alert")).not.toHaveTextContent("SYNTHETIC_PRIVATE_OUTPUT_FAILURE");
    expect(screen.queryByRole("list", { name: "已验证输出结果" })).not.toBeInTheDocument();
  });
});
