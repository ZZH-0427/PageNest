import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createEditState } from "../../pdf/edit";
import { PdfExportController, type PdfDownloadEnvironment } from "../../pdf/export-controller";
import { PDF_EXPORT_COMPATIBILITY_NOTICE } from "../../pdf/export";
import type { PdfFileEntry, PdfPageInfo } from "../../pdf/types";
import { PdfExportPanel } from "./export-panel";

function documentEntry(id = "first", name = "sample.pdf"): PdfFileEntry {
  const pages: PdfPageInfo[] = Array.from({ length: 3 }, (_, index) => ({
    number: index + 1, width: 420, height: 594, rotation: 0, orientation: "portrait",
  }));
  return { id, name, size: 2048, ordinal: 1, status: "ready", pages, selectedPage: 1, edit: createEditState(id, pages), error: null };
}

/** The real controller owns state, cancellation and download; only byte generation is artificial. */
function setupController() {
  let resolve!: (bytes: Uint8Array) => void;
  let reject!: (error: Error) => void;
  let advance!: (stage: "generating" | "validating") => void;
  const pending = new Promise<Uint8Array>((complete, fail) => { resolve = complete; reject = fail; });
  const sourceSignal = new AbortController().signal;
  const capture = vi.fn((documentId: string) => ({
    documentId, sourceName: "sample.pdf", pageCount: 3, signal: sourceSignal,
    generate: vi.fn((_signal: AbortSignal, onStage: typeof advance) => { advance = onStage; return pending; }),
  }));
  const downloadEnvironment: PdfDownloadEnvironment = {
    createUrl: vi.fn(() => "blob:artificial-export"), revokeUrl: vi.fn(), trigger: vi.fn(),
  };
  const controller = new PdfExportController(capture, downloadEnvironment);
  const start = vi.spyOn(controller, "start");
  const cancel = vi.spyOn(controller, "cancel");
  return {
    controller, capture, start, cancel, downloadEnvironment,
    advance: (stage: "generating" | "validating") => act(() => advance(stage)),
    complete: () => act(async () => { resolve(new Uint8Array([37, 80, 68, 70])); await pending; }),
    fail: () => act(async () => { reject(new Error("artificial internal exception")); await pending.catch(() => {}); }),
  };
}

function renderPanel(task: ReturnType<typeof setupController>, file = documentEntry()) {
  return render(<PdfExportPanel file={file} controller={task.controller} onClose={vi.fn()} />);
}

describe("PDF export panel", () => {
  it("explains scope and compatibility, focuses the filename and submits a sanitized PDF filename", async () => {
    const user = userEvent.setup();
    const task = setupController();
    renderPanel(task);
    expect(screen.getByText("sample.pdf")).toBeVisible();
    expect(screen.getByText("2 KiB")).toBeVisible();
    expect(screen.getByText("3 页")).toBeVisible();
    expect(screen.getByText(PDF_EXPORT_COMPATIBILITY_NOTICE)).toBeVisible();
    expect(screen.getByText(/特殊结构未逐项检测/)).toBeVisible();
    expect(screen.getByText(/全部保留页面，不按页面选区裁剪/)).toBeVisible();
    expect(screen.getByText(/点击生成时的编辑结果/)).toBeVisible();
    const input = screen.getByRole("textbox", { name: "导出文件名" });
    expect(input).toHaveValue("sample_edited.pdf");
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "报告/新版?.pdf.pdf" } });
    expect(screen.getByText("报告_新版_.pdf")).toBeVisible();
    await user.keyboard("{Enter}");
    expect(task.start).toHaveBeenCalledExactlyOnceWith("first", "报告_新版_.pdf");
    expect(task.capture).toHaveBeenCalledExactlyOnceWith("first");
    await task.complete();
  });

  it("shows real stages and the captured page count while preventing duplicate generation", async () => {
    const task = setupController();
    const file = documentEntry();
    const view = renderPanel(task, file);
    const generate = screen.getByRole("button", { name: "生成 PDF" });
    fireEvent.click(generate);
    fireEvent.click(generate);
    expect(task.start).toHaveBeenCalledOnce();
    expect(generate).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "导出文件名" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("准备中");
    task.advance("generating");
    expect(screen.getByRole("status")).toHaveTextContent("生成中");
    const edit = file.edit!;
    const changed = { ...file, edit: { ...edit, present: { ...edit.present, pages: edit.present.pages.slice(0, 2) } } };
    view.rerender(<PdfExportPanel file={changed} controller={task.controller} onClose={vi.fn()} />);
    expect(screen.getByText("2 页")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("本次生成 3 页");
    task.advance("validating");
    expect(screen.getByRole("status")).toHaveTextContent("验证中");
    expect(screen.queryByRole("button", { name: "下载 PDF" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).not.toHaveTextContent(/\d+%/);
    await task.complete();
    expect(screen.getByRole("status")).toHaveTextContent("下载就绪");
  });

  it("requires an explicit download gesture and accurately describes only a triggered download", async () => {
    const user = userEvent.setup();
    const task = setupController();
    renderPanel(task);
    await user.click(screen.getByRole("button", { name: "生成 PDF" }));
    await task.complete();
    expect(task.downloadEnvironment.createUrl).not.toHaveBeenCalled();
    expect(task.downloadEnvironment.trigger).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("验证已完成。点击下载");
    await user.click(screen.getByRole("button", { name: "下载 PDF" }));
    expect(task.downloadEnvironment.trigger).toHaveBeenCalledExactlyOnceWith("blob:artificial-export", "sample_edited.pdf");
    expect(screen.getByRole("status")).toHaveTextContent("已生成 PDF 并触发下载");
    expect(screen.getByRole("status")).toHaveTextContent("无法确认文件已保存到磁盘");
    expect(screen.queryByRole("button", { name: "下载 PDF" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新生成 PDF" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "导出文件名" })).toBeEnabled();
  });

  it("keeps cancellation visibly busy until generation reaches a safe boundary", async () => {
    const user = userEvent.setup();
    const task = setupController();
    renderPanel(task);
    await user.click(screen.getByRole("button", { name: "生成 PDF" }));
    task.advance("generating");
    await user.click(screen.getByRole("button", { name: "停止等待" }));
    expect(task.cancel).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("正在停止等待");
    expect(screen.getByRole("status")).toHaveTextContent("结束前不能开始另一项导出");
    expect(screen.getByRole("button", { name: "生成 PDF" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "停止等待" })).toBeDisabled();
    await task.complete();
    expect(screen.getByRole("button", { name: "生成 PDF" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "下载 PDF" })).not.toBeInTheDocument();
    expect(task.downloadEnvironment.trigger).not.toHaveBeenCalled();
  });

  it("reports generation failure without exposing underlying exception contents", async () => {
    const task = setupController();
    renderPanel(task);
    fireEvent.click(screen.getByRole("button", { name: "生成 PDF" }));
    await task.fail();
    expect(screen.getByRole("status")).toHaveTextContent("导出失败");
    expect(screen.getByRole("alert")).toHaveTextContent("原始文件与编辑历史未更改");
    expect(screen.queryByText(/artificial internal exception/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成 PDF" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "下载 PDF" })).not.toBeInTheDocument();
  });

  it("preserves a ready result for download retry and does not claim success after a browser error", async () => {
    const user = userEvent.setup();
    const task = setupController();
    vi.mocked(task.downloadEnvironment.trigger).mockImplementationOnce(() => { throw new Error("artificial browser error"); });
    renderPanel(task);
    await user.click(screen.getByRole("button", { name: "生成 PDF" }));
    await task.complete();
    await user.click(screen.getByRole("button", { name: "下载 PDF" }));
    expect(screen.getByRole("alert")).toHaveTextContent("未能触发下载");
    expect(screen.queryByText(/artificial browser error/)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).not.toHaveTextContent("已生成 PDF 并触发下载");
    expect(screen.getByRole("button", { name: "下载 PDF" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "下载 PDF" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(task.downloadEnvironment.trigger).toHaveBeenCalledTimes(2);
  });

  it("discards a ready result when closed and cancels a running task when unmounted", async () => {
    const user = userEvent.setup();
    const readyTask = setupController();
    function ClosablePanel() {
      const [open, setOpen] = useState(true);
      return open ? <PdfExportPanel file={documentEntry()} controller={readyTask.controller} onClose={() => setOpen(false)} /> : null;
    }
    const first = render(<ClosablePanel />);
    await user.click(screen.getByRole("button", { name: "生成 PDF" }));
    await readyTask.complete();
    await user.click(screen.getByRole("button", { name: "关闭导出设置" }));
    expect(screen.queryByRole("region", { name: "PDF 导出设置" })).not.toBeInTheDocument();
    expect(readyTask.cancel).toHaveBeenCalledOnce();
    expect(readyTask.controller.getSnapshot().stage).toBe("idle");
    expect(readyTask.downloadEnvironment.trigger).not.toHaveBeenCalled();
    first.unmount();
    const runningTask = setupController();
    const second = renderPanel(runningTask);
    await user.click(screen.getByRole("button", { name: "生成 PDF" }));
    second.unmount();
    expect(runningTask.cancel).toHaveBeenCalledOnce();
    expect(runningTask.controller.getSnapshot().busy).toBe(true);
    await runningTask.complete();
    expect(runningTask.controller.getSnapshot().stage).toBe("idle");
    expect(runningTask.downloadEnvironment.trigger).not.toHaveBeenCalled();
  });

  it("reinitializes the filename and discards the old result when the selected document changes", async () => {
    const user = userEvent.setup();
    const task = setupController();
    const first = documentEntry();
    const second = documentEntry("second", "second.pdf");
    const view = render(<PdfExportPanel key={first.id} file={first} controller={task.controller} onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "生成 PDF" }));
    await task.complete();
    view.rerender(<PdfExportPanel key={second.id} file={second} controller={task.controller} onClose={vi.fn()} />);
    expect(task.cancel).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "导出文件名" })).toHaveValue("second_edited.pdf");
    expect(screen.getByRole("status")).not.toHaveTextContent("本次生成");
    expect(screen.queryByRole("button", { name: "下载 PDF" })).not.toBeInTheDocument();
    expect(task.downloadEnvironment.trigger).not.toHaveBeenCalled();
  });

  it("keeps a newly selected document blocked while a cancelled previous task is still running", async () => {
    const task = setupController();
    const view = render(<PdfExportPanel key="first" file={documentEntry()} controller={task.controller} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "生成 PDF" }));
    view.rerender(<PdfExportPanel key="second" file={documentEntry("second", "second.pdf")} controller={task.controller} onClose={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在停止等待");
    expect(screen.getByRole("status")).not.toHaveTextContent("sample_edited.pdf");
    expect(screen.getByRole("button", { name: "生成 PDF" })).toBeDisabled();
    await task.complete();
    await waitFor(() => expect(screen.getByRole("button", { name: "生成 PDF" })).toBeEnabled());
    expect(task.start).toHaveBeenCalledOnce();
  });

  it.each(["parsing", "empty"] as const)("prevents generation for a %s document", (condition) => {
    const task = setupController();
    const file = documentEntry();
    if (condition === "parsing") file.status = "parsing";
    else file.edit = null;
    renderPanel(task, file);
    const panel = within(screen.getByRole("region", { name: "PDF 导出设置" }));
    expect(panel.getByRole("button", { name: "生成 PDF" })).toBeDisabled();
    fireEvent.submit(panel.getByRole("button", { name: "生成 PDF" }).closest("form")!);
    expect(task.start).not.toHaveBeenCalled();
  });
});
