import { createRef } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PdfWorkspace } from "../../pdf/workspace";
import { abortError, PdfUserError, type PdfPageInfo } from "../../pdf/types";
import { PdfThumbnail } from "./thumbnail";

const observers: TestIntersectionObserver[] = [];

class TestIntersectionObserver {
  observed: Element | null = null;
  disconnect = vi.fn();
  observe = vi.fn((target: Element) => { this.observed = target; });

  constructor(
    private callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    observers.push(this);
  }

  emit(isIntersecting: boolean) {
    this.callback(
      [{ isIntersecting, target: this.observed } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

interface PendingRender {
  documentId: string;
  pageNumber: number;
  canvas: HTMLCanvasElement;
  signal: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
}

const page: PdfPageInfo = {
  number: 2,
  width: 594,
  height: 420,
  rotation: 0,
  orientation: "landscape",
};

function setup() {
  const workspace = new PdfWorkspace();
  const pending: PendingRender[] = [];
  const renderPage = vi.spyOn(workspace, "renderPage").mockImplementation(
    (documentId, pageNumber, canvas, signal) => new Promise<void>((resolve, reject) => {
      canvas.width = 240;
      canvas.height = 170;
      pending.push({ documentId, pageNumber, canvas, signal, resolve, reject });
    }),
  );
  const onSelect = vi.fn();
  const scrollRoot = createRef<HTMLDivElement>();
  scrollRoot.current = document.createElement("div");
  const props = { workspace, documentId: "document-a", page, selected: false, onSelect, scrollRoot };
  const view = render(<PdfThumbnail key="document-a" {...props} />);
  return { ...view, pending, renderPage, onSelect, props };
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
});

test("defers rendering until near the scroll viewport and preserves page proportions", async () => {
  const { renderPage, pending, props, container } = setup();
  expect(renderPage).not.toHaveBeenCalled();
  expect(screen.getByText("等待预览")).toBeVisible();
  expect(observers[0].observe).toHaveBeenCalledWith(screen.getByRole("button", { name: "第 2 页" }));
  expect(observers[0].options).toEqual({ root: props.scrollRoot.current, rootMargin: "200px 0px" });
  expect(container.querySelector(".pdf-thumbnail-paper")).toHaveStyle({ aspectRatio: "594 / 420" });
  expect(screen.getByText("横向")).toBeVisible();

  act(() => observers[0].emit(true));
  expect(renderPage).toHaveBeenCalledTimes(1);
  expect(pending[0].documentId).toBe("document-a");
  expect(pending[0].pageNumber).toBe(2);
  expect(screen.getByText("正在预览")).toBeVisible();
  expect(pending[0].canvas).toHaveStyle({ opacity: "0" });

  await act(async () => pending[0].resolve());
  expect(pending[0].canvas).toHaveStyle({ opacity: "1" });
  expect(screen.queryByText("正在预览")).not.toBeInTheDocument();
});

test("leaving the viewport aborts unfinished rendering and releases canvas pixels", async () => {
  const { pending, renderPage, container } = setup();
  act(() => observers[0].emit(true));
  const first = pending[0];
  act(() => observers[0].emit(false));

  expect(first.signal.aborted).toBe(true);
  expect([first.canvas.width, first.canvas.height]).toEqual([0, 0]);
  expect(screen.getByText("等待预览")).toBeVisible();
  expect(container.querySelector("canvas")).not.toBe(first.canvas);
  await act(async () => first.resolve());
  expect(container.querySelector("canvas")).toHaveStyle({ opacity: "0" });
  expect(screen.getByText("等待预览")).toBeVisible();
  expect(renderPage).toHaveBeenCalledTimes(1);
});

test("rapid exit and re-entry uses a fresh canvas and ignores the previous render result", async () => {
  const { pending, container } = setup();
  act(() => observers[0].emit(true));
  act(() => observers[0].emit(false));
  act(() => observers[0].emit(true));
  expect(pending).toHaveLength(2);
  expect(pending[0].signal.aborted).toBe(true);
  expect(pending[1].signal.aborted).toBe(false);
  expect(pending[1].canvas).not.toBe(pending[0].canvas);
  expect(container.querySelector("canvas")).toBe(pending[1].canvas);

  await act(async () => pending[0].resolve());
  expect(screen.getByText("正在预览")).toBeVisible();
  expect(pending[1].canvas).toHaveStyle({ opacity: "0" });
  await act(async () => pending[1].resolve());
  expect(pending[1].canvas).toHaveStyle({ opacity: "1" });
});

test("switching keyed documents cancels old work and cannot paint its completion into the new file", async () => {
  const { pending, props, rerender, unmount } = setup();
  act(() => observers[0].emit(true));
  const firstObserver = observers[0];
  const first = pending[0];
  rerender(<PdfThumbnail key="document-b" {...props} documentId="document-b" />);
  expect(firstObserver.disconnect).toHaveBeenCalledTimes(1);
  expect(first.signal.aborted).toBe(true);
  expect([first.canvas.width, first.canvas.height]).toEqual([0, 0]);
  expect(screen.getByText("等待预览")).toBeVisible();

  act(() => observers[1].emit(true));
  expect(pending[1].documentId).toBe("document-b");
  expect(pending[1].canvas).not.toBe(first.canvas);
  await act(async () => first.reject(new Error("Artificial old-file failure")));
  expect(screen.getByText("正在预览")).toBeVisible();
  expect(screen.queryByRole("button", { name: /预览失败/ })).not.toBeInTheDocument();
  await act(async () => pending[1].resolve());
  expect(pending[1].canvas).toHaveStyle({ opacity: "1" });

  unmount();
  expect(observers[1].disconnect).toHaveBeenCalledTimes(1);
  expect(pending[1].signal.aborted).toBe(true);
  expect([pending[1].canvas.width, pending[1].canvas.height]).toEqual([0, 0]);
});

test("unexpected render errors display a safe message instead of internal document details", async () => {
  const { pending } = setup();
  act(() => observers[0].emit(true));
  await act(async () => pending[0].reject(new Error("SYNTHETIC INTERNAL DOCUMENT TEXT")));
  expect(screen.getByRole("button", { name: "第 2 页，预览失败" })).toBeVisible();
  expect(screen.getByText("此页面无法预览。请尝试其他页面或重新导入文件。")).toBeVisible();
  expect(screen.queryByText(/SYNTHETIC INTERNAL/)).not.toBeInTheDocument();
  expect(pending[0].canvas).toHaveStyle({ opacity: "0" });
});

test("known user-facing errors are shown and a later visibility cycle retries rendering", async () => {
  const { pending } = setup();
  act(() => observers[0].emit(true));
  await act(async () => pending[0].reject(new PdfUserError("页面预览超时，请重试。")));
  expect(screen.getByText("页面预览超时，请重试。")).toBeVisible();
  act(() => observers[0].emit(false));
  act(() => observers[0].emit(true));
  expect(screen.queryByRole("button", { name: /预览失败/ })).not.toBeInTheDocument();
  expect(screen.getByText("正在预览")).toBeVisible();
  await act(async () => pending[1].resolve());
  expect(pending[1].canvas).toHaveStyle({ opacity: "1" });
});

test.each([abortError(), Object.assign(new Error("cancelled"), { name: "RenderingCancelledException" })])(
  "cancellation never becomes a user-facing preview failure: %s",
  async (reason) => {
    const { pending } = setup();
    act(() => observers[0].emit(true));
    await act(async () => pending[0].reject(reason));
    expect(screen.queryByRole("button", { name: /预览失败/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/此页面无法预览/)).not.toBeInTheDocument();
  },
);

test("the page tile supports Enter, Space and an accessible selected state", async () => {
  const { onSelect, props, rerender } = setup();
  const user = userEvent.setup();
  const tile = screen.getByRole("button", { name: "第 2 页" });
  await user.tab();
  expect(tile).toHaveFocus();
  await user.keyboard("{Enter}");
  await user.keyboard(" ");
  expect(onSelect).toHaveBeenCalledTimes(2);
  expect(tile).toHaveAttribute("aria-pressed", "false");
  rerender(<PdfThumbnail key="document-a" {...props} selected />);
  expect(tile).toHaveAttribute("aria-pressed", "true");
  expect(tile).toHaveClass("selected");
});
