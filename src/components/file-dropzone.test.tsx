import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FilesProvider } from "../context/files";
import { FileDropzone } from "./file-dropzone";

function renderDropzone() {
  const view = render(
    <FilesProvider>
      <FileDropzone />
    </FilesProvider>,
  );
  const region = screen.getByRole("region", { name: "本地文件选择" });
  const target = region.querySelector(".dropzone")!;
  return { ...view, target };
}

describe("local file interactions", () => {
  it("accepts a dropped file as metadata without uploading or persisting it", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { target } = renderDropzone();
    const file = new File(["synthetic fixture"], "dropped.pdf", {
      type: "application/pdf",
    });
    const dataTransfer = {
      files: [file],
      types: ["Files"],
      dropEffect: "none",
    };

    fireEvent.dragEnter(target, { dataTransfer });
    expect(
      screen.getByRole("heading", { name: "松开鼠标，添加文件" }),
    ).toBeInTheDocument();
    fireEvent.dragOver(target, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("copy");
    fireEvent.drop(target, { dataTransfer });

    expect(
      screen.getByRole("heading", { name: "把文件放在这里，开始整理" }),
    ).toBeInTheDocument();
    expect(screen.getByText("dropped.pdf")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "已读取 1 个文件的基本信息",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it("reports an unsupported dropped file and lets the user dismiss the feedback", async () => {
    const user = userEvent.setup();
    const { target } = renderDropzone();
    fireEvent.drop(target, {
      dataTransfer: { files: [new File(["fixture"], "unsupported.exe")] },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("1 个文件格式暂不支持");
    expect(screen.queryByText("unsupported.exe")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "清空列表" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭文件提示" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps drag feedback active while moving across nested content", () => {
    const { target } = renderDropzone();
    const child = screen.getByRole("button", { name: "选择文件" });
    fireEvent.dragEnter(target);
    fireEvent.dragEnter(child);
    fireEvent.dragLeave(child);
    expect(
      screen.getByRole("heading", { name: "松开鼠标，添加文件" }),
    ).toBeInTheDocument();
    fireEvent.dragLeave(target);
    expect(
      screen.getByRole("heading", { name: "把文件放在这里，开始整理" }),
    ).toBeInTheDocument();
  });

  it("clears all selected metadata and permits selecting the same files again", async () => {
    const user = userEvent.setup();
    renderDropzone();
    const input = screen.getByLabelText("选择本地文件");
    const files = [
      new File(["one"], "one.pdf", { type: "application/pdf" }),
      new File(["two"], "two.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ];
    await user.upload(input, files);
    expect(screen.getByText("one.pdf")).toBeInTheDocument();
    expect(screen.getByText("two.docx")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清空列表" }));
    expect(screen.queryByText("one.pdf")).not.toBeInTheDocument();
    expect(screen.queryByText("two.docx")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await user.upload(input, files);
    expect(screen.getByRole("status")).toHaveTextContent(
      "已读取 2 个文件的基本信息",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
