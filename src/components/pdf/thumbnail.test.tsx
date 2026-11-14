import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
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
    this.emitBatch([{ isIntersecting, time: 0 }]);
  }

  emitBatch(entries: Array<{ isIntersecting: boolean; time: number; target?: Element }>) {
    this.callback(
      entries.map((entry) => ({ target: this.observed, ...entry } as IntersectionObserverEntry)),
      this as unknown as IntersectionObserver,
    );
  }
}

interface PendingRender {
  documentId: string;
  pageNumber: number;
  rotationDelta: number;
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
    (documentId, pageNumber, canvas, signal, rotationDelta = 0) => new Promise<void>((resolve, reject) => {
      canvas.width = 240;
      canvas.height = 170;
      pending.push({ documentId, pageNumber, rotationDelta, canvas, signal, resolve, reject });
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

test("display numbering and selection changes keep the original page canvas and source mapping", async () => {
  const { pending, props, rerender, renderPage } = setup();
  rerender(<PdfThumbnail key="document-a" {...props} sourcePageNumber={2} />);
  act(() => observers[0].emit(true));
  await act(async () => pending[0].resolve());
  const canvas = pending[0].canvas;
  rerender(<PdfThumbnail key="document-a" {...props} page={{ ...page, number: 1 }} sourcePageNumber={2} selected />);
  expect(screen.getByRole("button", { name: "第 1 页" })).toHaveAttribute("aria-pressed", "true");
  expect(renderPage).toHaveBeenCalledOnce();
  expect(pending[0].pageNumber).toBe(2);
  expect(pending[0].signal.aborted).toBe(false);
  expect(canvas).toHaveStyle({ opacity: "1" });
  expect(document.querySelector("canvas")).toBe(canvas);
});

test("rotation invalidates only the current canvas and ignores stale completions during rapid editing", async () => {
  const { pending, props, rerender, container } = setup();
  act(() => observers[0].emit(true));
  await act(async () => pending[0].resolve());
  expect(pending[0].canvas).toHaveStyle({ opacity: "1" });
  const rotated = { ...page, width: page.height, height: page.width, rotation: 90, orientation: "portrait" as const };
  rerender(<PdfThumbnail key="document-a" {...props} page={rotated} sourcePageNumber={2} rotationDelta={90} />);
  expect(pending[0].signal.aborted).toBe(true);
  expect([pending[0].canvas.width, pending[0].canvas.height]).toEqual([0, 0]);
  expect(pending[1].rotationDelta).toBe(90);
  expect(container.querySelector("canvas")).toBe(pending[1].canvas);
  expect(pending[1].canvas).toHaveStyle({ opacity: "0" });
  expect(screen.getByText("正在预览")).toBeVisible();
  expect(screen.getByText("纵向")).toBeVisible();
  expect(container.querySelector(".pdf-thumbnail-paper")).toHaveStyle({ aspectRatio: "420 / 594" });

  rerender(<PdfThumbnail key="document-a" {...props} sourcePageNumber={2} rotationDelta={180} />);
  expect(pending[1].signal.aborted).toBe(true);
  expect(pending[2].rotationDelta).toBe(180);
  await act(async () => pending[1].resolve());
  expect(pending[2].canvas).toHaveStyle({ opacity: "0" });
  expect(screen.getByText("正在预览")).toBeVisible();
  await act(async () => pending[2].resolve());
  expect(pending[2].canvas).toHaveStyle({ opacity: "1" });

  rerender(<PdfThumbnail key="document-a" {...props} sourcePageNumber={2} rotationDelta={270} />);
  rerender(<PdfThumbnail key="document-a" {...props} sourcePageNumber={2} rotationDelta={360} />);
  expect(pending[3].signal.aborted).toBe(true);
  expect(pending[4].rotationDelta).toBe(0);
  await act(async () => pending[3].reject(new Error("Synthetic stale render failure")));
  expect(screen.queryByRole("button", { name: /预览失败/ })).not.toBeInTheDocument();
  await act(async () => pending[4].resolve());
  expect(pending[4].canvas).toHaveStyle({ opacity: "1" });
});

test("forwards selection modifiers and drag attributes without overriding tile semantics", () => {
  const { onSelect, props, rerender } = setup();
  const dragStart = vi.fn();
  const overrideClick = vi.fn();
  rerender(<PdfThumbnail key="document-a" {...props} tileProps={{ draggable: true, onDragStart: dragStart, onClick: overrideClick, className: "drag-target", "aria-label": "wrong label" }} />);
  const tile = screen.getByRole("button", { name: "第 2 页" });
  expect(tile).toHaveAttribute("draggable", "true");
  expect(tile).toHaveClass("pdf-thumbnail", "drag-target");
  fireEvent.click(tile, { ctrlKey: true, metaKey: true, shiftKey: true });
  expect(onSelect.mock.calls[0][0]).toMatchObject({ ctrlKey: true, metaKey: true, shiftKey: true });
  expect(overrideClick).not.toHaveBeenCalled();
  fireEvent.dragStart(tile);
  expect(dragStart).toHaveBeenCalledOnce();
});

test("rotating one visible page does not redraw a sibling canvas", async () => {
  const workspace = new PdfWorkspace();
  const renderPage = vi.spyOn(workspace, "renderPage").mockResolvedValue();
  const scrollRoot = createRef<HTMLDivElement>();
  const onSelect = vi.fn();
  const props = { workspace, documentId: "document-a", selected: false, onSelect, scrollRoot };
  const tiles = (delta: number) => <>
    <PdfThumbnail key="stable-page-2" {...props} page={page} sourcePageNumber={2} rotationDelta={delta} />
    <PdfThumbnail key="stable-page-3" {...props} page={{ ...page, number: 3 }} sourcePageNumber={3} />
  </>;
  const { rerender, container } = render(tiles(0));
  await act(async () => { observers[0].emit(true); observers[1].emit(true); });
  expect(renderPage).toHaveBeenCalledTimes(2);
  const siblingCanvas = container.querySelectorAll("canvas")[1];
  await act(async () => rerender(tiles(90)));
  expect(renderPage).toHaveBeenCalledTimes(3);
  expect(renderPage.mock.calls.at(-1)?.[1]).toBe(2);
  expect(container.querySelectorAll("canvas")[1]).toBe(siblingCanvas);
  expect(renderPage.mock.calls[1][3].aborted).toBe(false);
});

test.each(["ready", "error"])("returning to an earlier angle starts waiting instead of reusing its old %s state", async (priorState) => {
  const { pending, props, rerender, container } = setup();
  act(() => observers[0].emit(true));
  await act(async () => {
    if (priorState === "ready") pending[0].resolve();
    else pending[0].reject(new PdfUserError("先前角度预览失败。"));
  });
  const tile = screen.getByRole("button", { name: /第 2 页/ });
  tile.focus();
  rerender(<PdfThumbnail key="document-a" {...props} sourcePageNumber={2} rotationDelta={90} />);
  expect(pending[1].canvas).toHaveStyle({ opacity: "0" });
  rerender(<PdfThumbnail key="document-a" {...props} sourcePageNumber={2} rotationDelta={0} />);
  const current = pending[2];
  expect(current.canvas).not.toBe(pending[0].canvas);
  expect(current.canvas).not.toBe(pending[1].canvas);
  expect(container.querySelector("canvas")).toBe(current.canvas);
  expect(current.canvas).toHaveStyle({ opacity: "0" });
  expect(screen.getByText("正在预览")).toBeVisible();
  expect(screen.queryByText("先前角度预览失败。")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /预览失败/ })).not.toBeInTheDocument();
  expect(tile).toHaveFocus();
  expect(pending[1].signal.aborted).toBe(true);
  await act(async () => pending[1].resolve());
  expect(current.canvas).toHaveStyle({ opacity: "0" });
  expect(screen.getByText("正在预览")).toBeVisible();
  await act(async () => current.resolve());
  expect(current.canvas).toHaveStyle({ opacity: "1" });
  expect(screen.queryByText("正在预览")).not.toBeInTheDocument();
});

test("the visibility fallback remeasures reordered tiles without redrawing those still visible", async () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  let bounds = { top: 100, bottom: 240 };
  vi.spyOn(HTMLButtonElement.prototype, "getBoundingClientRect").mockImplementation(() => bounds as DOMRect);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const flushFrame = () => act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(0));
  });
  const { pending, props, rerender, renderPage } = setup();
  vi.spyOn(props.scrollRoot.current!, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 600 } as DOMRect);
  flushFrame();
  await act(async () => pending[0].resolve());
  const first = pending[0];
  rerender(<PdfThumbnail key="document-a" {...props} page={{ ...page, number: 1 }} sourcePageNumber={2} />);
  flushFrame();
  expect(renderPage).toHaveBeenCalledOnce();
  expect(first.signal.aborted).toBe(false);

  bounds = { top: 1200, bottom: 1340 };
  rerender(<PdfThumbnail key="document-a" {...props} page={{ ...page, number: 20 }} sourcePageNumber={2} />);
  flushFrame();
  expect(first.signal.aborted).toBe(true);
  expect([first.canvas.width, first.canvas.height]).toEqual([0, 0]);
  expect(screen.getByText("等待预览")).toBeVisible();
  bounds = { top: 100, bottom: 240 };
  rerender(<PdfThumbnail key="document-a" {...props} page={{ ...page, number: 1 }} sourcePageNumber={2} />);
  flushFrame();
  expect(renderPage).toHaveBeenCalledTimes(2);
  expect(pending[1].canvas).not.toBe(first.canvas);
  expect(screen.getByText("正在预览")).toBeVisible();
});

test("batched visibility records use the latest observation for the current tile", async () => {
  const { pending, renderPage } = setup();
  act(() => observers[0].emitBatch([
    { isIntersecting: false, time: 1 },
    { isIntersecting: true, time: 2 },
  ]));
  expect(renderPage).toHaveBeenCalledOnce();
  await act(async () => pending[0].resolve());
  expect(pending[0].canvas).toHaveStyle({ opacity: "1" });
  act(() => observers[0].emitBatch([
    { isIntersecting: true, time: 5 },
    { isIntersecting: false, time: 4 },
    { isIntersecting: false, time: 6, target: document.createElement("button") },
  ]));
  expect(pending[0].signal.aborted).toBe(false);
  expect(pending[0].canvas).toHaveStyle({ opacity: "1" });
  expect(renderPage).toHaveBeenCalledOnce();
});

test("late callbacks from a disconnected observer cannot hide a reordered tile", async () => {
  const { pending, props, rerender, renderPage } = setup();
  const oldObserver = observers[0];
  act(() => oldObserver.emit(true));
  await act(async () => pending[0].resolve());
  rerender(<PdfThumbnail key="document-a" {...props} page={{ ...page, number: 1 }} sourcePageNumber={2} />);
  expect(oldObserver.disconnect).toHaveBeenCalledOnce();
  const currentObserver = observers[1];
  act(() => currentObserver.emit(true));
  act(() => oldObserver.emit(false));
  expect(renderPage).toHaveBeenCalledOnce();
  expect(pending[0].signal.aborted).toBe(false);
  expect(pending[0].canvas).toHaveStyle({ opacity: "1" });
  expect(screen.queryByText("等待预览")).not.toBeInTheDocument();
  // The active observer still controls cancellation normally.
  act(() => currentObserver.emit(false));
  expect(pending[0].signal.aborted).toBe(true);
  expect(screen.getByText("等待预览")).toBeVisible();
});
