import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPdfEngine } from "./browser-engine";
import { PdfUserError } from "./types";

const adapter = vi.hoisted(() => ({
  createWorker: vi.fn(),
  getDocument: vi.fn(),
  readPdfBytes: vi.fn(),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({
  default: "/PageNest/assets/pdf.worker.min-synthetic.mjs",
}));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  version: "6.5.438",
  PDFWorker: { create: adapter.createWorker },
  getDocument: adapter.getDocument,
}));
vi.mock("./validation", async (importOriginal) => ({
  ...await importOriginal<typeof import("./validation")>(),
  readPdfBytes: adapter.readPdfBytes,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class ParserWorker extends EventTarget {
  static instances: ParserWorker[] = [];
  terminate = vi.fn();

  constructor(readonly url: string, readonly options: WorkerOptions) {
    super();
    ParserWorker.instances.push(this);
  }
}

function syntheticDocument(width = 612, height = 792) {
  const page = {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: width * scale, height: height * scale, rotation: 0 })),
    cleanup: vi.fn(),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
  };
  const document = { numPages: 1, getPage: vi.fn(async () => page) };
  const task = { promise: Promise.resolve(document), destroy: vi.fn(async () => {}), onPassword: null };
  return { page, document, task };
}

function pendingRender() {
  const completion = deferred<void>();
  const task = {
    promise: completion.promise,
    cancel: vi.fn(() => completion.reject(new DOMException("Synthetic cancellation", "RenderingCancelledException"))),
  };
  return { completion, task };
}

const file = () => new File(["%PDF-1.7\n"], "synthetic.pdf", { type: "application/pdf" });
const signal = () => new AbortController().signal;
const engines: BrowserPdfEngine[] = [];
let sharedWorker: { destroy: ReturnType<typeof vi.fn> };
let bytes: Uint8Array<ArrayBuffer>;

function engine() {
  const result = new BrowserPdfEngine();
  engines.push(result);
  return result;
}

beforeEach(() => {
  adapter.createWorker.mockReset();
  adapter.getDocument.mockReset();
  adapter.readPdfBytes.mockReset();
  ParserWorker.instances = [];
  sharedWorker = { destroy: vi.fn() };
  bytes = new TextEncoder().encode("%PDF-1.7\nsynthetic adapter data");
  adapter.createWorker.mockReturnValue(sharedWorker);
  adapter.readPdfBytes.mockImplementation(async (_blob: Blob, abort: AbortSignal) => {
    abort.throwIfAborted();
    return bytes;
  });
  vi.stubGlobal("Worker", ParserWorker);
  vi.stubEnv("BASE_URL", "/PageNest/");
});

afterEach(async () => {
  await Promise.all(engines.splice(0).map((item) => item.destroy()));
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("browser PDF adapter ownership and local inputs", () => {
  it("passes only local data and same-version assets, sharing one worker without destroying sibling documents", async () => {
    const first = syntheticDocument();
    const second = syntheticDocument(792, 612);
    adapter.getDocument.mockReturnValueOnce(first.task).mockReturnValueOnce(second.task);
    const parser = engine();
    const progress = vi.fn();
    const firstHandle = await parser.open(file(), signal(), progress);
    const secondHandle = await parser.open(file(), signal(), vi.fn());

    expect(progress.mock.calls).toEqual([["reading"], ["parsing"]]);
    expect(ParserWorker.instances).toHaveLength(1);
    expect(ParserWorker.instances[0]).toMatchObject({
      url: "/PageNest/assets/pdf.worker.min-synthetic.mjs",
      options: { type: "module", name: "PageNest PDF parser" },
    });
    expect(adapter.createWorker).toHaveBeenCalledExactlyOnceWith({ port: ParserWorker.instances[0], verbosity: 0 });
    expect(adapter.getDocument).toHaveBeenCalledTimes(2);
    for (const [options] of adapter.getDocument.mock.calls) {
      expect(options).toEqual({
        data: bytes, worker: sharedWorker, verbosity: 0, stopAtErrors: true,
        enableXfa: false, useWorkerFetch: true, cMapPacked: true,
        cMapUrl: "/PageNest/pdfjs/6.5.438/cmaps/",
        standardFontDataUrl: "/PageNest/pdfjs/6.5.438/standard_fonts/",
        wasmUrl: "/PageNest/pdfjs/6.5.438/wasm/",
        iccUrl: "/PageNest/pdfjs/6.5.438/iccs/",
        canvasMaxAreaInBytes: 16 * 1024 ** 2,
      });
      expect(options.data).toBe(bytes);
    }
    expect(firstHandle.pages).toEqual([{ number: 1, width: 612, height: 792, rotation: 0, orientation: "portrait" }]);
    expect(secondHandle.pages[0].orientation).toBe("landscape");
    await firstHandle.destroy();
    await firstHandle.destroy();
    expect(first.task.destroy).toHaveBeenCalledOnce();
    expect(second.task.destroy).not.toHaveBeenCalled();
    expect(sharedWorker.destroy).not.toHaveBeenCalled();
    expect(ParserWorker.instances[0].terminate).not.toHaveBeenCalled();

    const canvas = document.createElement("canvas");
    await secondHandle.render(1, canvas, signal());
    expect(second.page.render).toHaveBeenCalledWith({ canvas, viewport: expect.objectContaining({ width: 320 }), background: "#ffffff" });
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(320 * 440);
    await parser.destroy();
    expect(second.task.destroy).toHaveBeenCalledOnce();
    expect(sharedWorker.destroy).toHaveBeenCalledOnce();
    expect(ParserWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it("releases a failed worker wrapper before retrying, never passing a missing worker to PDF.js", async () => {
    adapter.createWorker.mockImplementationOnce(() => { throw new Error("Synthetic worker startup failure"); });
    adapter.getDocument.mockReturnValue(syntheticDocument().task);
    const parser = engine();
    await expect(parser.open(file(), signal(), vi.fn())).rejects.toThrow("无法启动 PDF 解析组件");
    expect(ParserWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(adapter.getDocument).not.toHaveBeenCalled();

    await parser.open(file(), signal(), vi.fn());
    expect(ParserWorker.instances).toHaveLength(2);
    expect(adapter.createWorker).toHaveBeenCalledTimes(2);
    expect(adapter.getDocument.mock.calls[0][0].worker).toBe(sharedWorker);
  });

  it("waits for document cleanup already in progress before terminating the shared worker", async () => {
    const first = syntheticDocument();
    const second = syntheticDocument();
    const firstCleanup = deferred<void>();
    const secondCleanup = deferred<void>();
    first.task.destroy.mockImplementation(() => firstCleanup.promise);
    second.task.destroy.mockImplementation(() => secondCleanup.promise);
    adapter.getDocument.mockReturnValueOnce(first.task).mockReturnValueOnce(second.task);
    const parser = engine();
    const firstHandle = await parser.open(file(), signal(), vi.fn());
    await parser.open(file(), signal(), vi.fn());
    const removingFirst = firstHandle.destroy();
    const closing = parser.destroy();

    try {
      await Promise.resolve();
      expect(first.task.destroy).toHaveBeenCalledOnce();
      expect(second.task.destroy).toHaveBeenCalledOnce();
      expect(sharedWorker.destroy).not.toHaveBeenCalled();
      expect(ParserWorker.instances[0].terminate).not.toHaveBeenCalled();
      secondCleanup.resolve();
      await Promise.resolve();
      expect(ParserWorker.instances[0].terminate).not.toHaveBeenCalled();
      firstCleanup.resolve();
      await Promise.all([removingFirst, closing]);
      expect(sharedWorker.destroy).toHaveBeenCalledOnce();
      expect(ParserWorker.instances[0].terminate).toHaveBeenCalledOnce();
    } finally {
      firstCleanup.resolve();
      secondCleanup.resolve();
      await Promise.all([removingFirst, closing]);
    }
  });

  it("terminates an unresponsive worker only after the 3-second cleanup deadline", async () => {
    vi.useFakeTimers();
    const fixture = syntheticDocument();
    fixture.task.destroy.mockImplementation(() => new Promise<void>(() => {}));
    adapter.getDocument.mockReturnValue(fixture.task);
    // This test owns shutdown so a regression cannot strand the shared afterEach cleanup.
    const parser = new BrowserPdfEngine();
    await parser.open(file(), signal(), vi.fn());
    ParserWorker.instances[0].dispatchEvent(new Event("messageerror"));
    const settled = vi.fn();
    const closing = parser.destroy().then(settled);
    const closingAgain = parser.destroy();

    try {
      await vi.advanceTimersByTimeAsync(2999);
      expect(fixture.task.destroy).toHaveBeenCalledOnce();
      expect(settled).not.toHaveBeenCalled();
      expect(sharedWorker.destroy).not.toHaveBeenCalled();
      expect(ParserWorker.instances[0].terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all([closing, closingAgain]);
      expect(settled).toHaveBeenCalledOnce();
      expect(fixture.task.destroy).toHaveBeenCalledOnce();
      expect(sharedWorker.destroy).toHaveBeenCalledOnce();
      expect(ParserWorker.instances[0].terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.advanceTimersByTimeAsync(3000);
    }
  });

  it("consumes initialization rejection when disposed synchronously during a progress notification", async () => {
    const parser = engine();
    await expect(parser.open(file(), signal(), (status) => {
      if (status === "parsing") void parser.destroy();
    })).rejects.toHaveProperty("name", "AbortError");
    await vi.dynamicImportSettled();
    expect(ParserWorker.instances).toHaveLength(0);
    expect(adapter.getDocument).not.toHaveBeenCalled();
  });
});

describe("browser PDF adapter loading failures", () => {
  it.each(["error", "messageerror"])("rejects a pending document on worker %s and destroys its loading task", async (eventName) => {
    const task = { promise: deferred<never>().promise, destroy: vi.fn(async () => {}) };
    adapter.getDocument.mockReturnValue(task);
    const parser = engine();
    const opening = parser.open(file(), signal(), vi.fn());
    const rejection = expect(opening).rejects.toBeInstanceOf(PdfUserError);
    await vi.waitFor(() => expect(adapter.getDocument).toHaveBeenCalledOnce());
    const event = new Event(eventName, { cancelable: true });
    ParserWorker.instances[0].dispatchEvent(event);
    await rejection;
    expect(task.destroy).toHaveBeenCalledOnce();
    if (eventName === "error") expect(event.defaultPrevented).toBe(true);
    await expect(parser.open(file(), signal(), vi.fn())).rejects.toBeInstanceOf(PdfUserError);
    expect(adapter.getDocument).toHaveBeenCalledOnce();
  });

  it("destroys only the loading task when a pending import is cancelled", async () => {
    const task = { promise: deferred<never>().promise, destroy: vi.fn(async () => {}) };
    adapter.getDocument.mockReturnValue(task);
    const controller = new AbortController();
    const opening = engine().open(file(), controller.signal, vi.fn());
    const rejection = expect(opening).rejects.toHaveProperty("name", "AbortError");
    await vi.waitFor(() => expect(adapter.getDocument).toHaveBeenCalledOnce());
    controller.abort();
    await rejection;
    expect(task.destroy).toHaveBeenCalledOnce();
    expect(sharedWorker.destroy).not.toHaveBeenCalled();
    expect(ParserWorker.instances[0].terminate).not.toHaveBeenCalled();
  });

  it("bounds pending parsing at 60 seconds and destroys its loading task", async () => {
    vi.useFakeTimers();
    const task = { promise: deferred<never>().promise, destroy: vi.fn(async () => {}) };
    adapter.getDocument.mockReturnValue(task);
    const opening = engine().open(file(), signal(), vi.fn());
    const rejection = expect(opening).rejects.toThrow("读取或解析耗时过长");
    await vi.waitFor(() => expect(adapter.getDocument).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    expect(task.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["PasswordException", "InvalidPDFException"])("cleans up rejected %s tasks without installing a password prompt", async (name) => {
    const completion = deferred<never>();
    const failure = Object.assign(new Error("Synthetic document error"), { name });
    const task = { promise: completion.promise, destroy: vi.fn(async () => {}), onPassword: null };
    adapter.getDocument.mockReturnValue(task);
    const opening = engine().open(file(), signal(), vi.fn());
    const rejection = expect(opening).rejects.toBe(failure);
    await vi.waitFor(() => expect(adapter.getDocument).toHaveBeenCalledOnce());
    completion.reject(failure);
    await rejection;
    expect(task.destroy).toHaveBeenCalledOnce();
    expect(task.onPassword).toBeNull();
  });

  it.each([0, 1001])("rejects a document with %i pages before asking for page proxies", async (count) => {
    const fixture = syntheticDocument();
    fixture.document.numPages = count;
    adapter.getDocument.mockReturnValue(fixture.task);
    await expect(engine().open(file(), signal(), vi.fn())).rejects.toThrow("最多支持 1000 页");
    expect(fixture.document.getPage).not.toHaveBeenCalled();
    expect(fixture.task.destroy).toHaveBeenCalledOnce();
  });
});

describe("browser PDF adapter render cleanup", () => {
  it.each(["abort", "timeout", "destroy"])("cancels and releases an active render after %s", async (reason) => {
    vi.useFakeTimers();
    const fixture = syntheticDocument();
    const rendering = pendingRender();
    fixture.page.render.mockReturnValue(rendering.task);
    adapter.getDocument.mockReturnValue(fixture.task);
    const handle = await engine().open(file(), signal(), vi.fn());
    const controller = new AbortController();
    const canvas = document.createElement("canvas");
    const result = handle.render(1, canvas, controller.signal);
    const rejection = reason === "timeout"
      ? expect(result).rejects.toThrow("渲染耗时过长")
      : expect(result).rejects.toHaveProperty("name", "AbortError");
    await vi.waitFor(() => expect(fixture.page.render).toHaveBeenCalledOnce());
    if (reason === "abort") controller.abort();
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(20_000);
    if (reason === "destroy") await handle.destroy();
    await rejection;
    expect(rendering.task.cancel).toHaveBeenCalled();
    expect(fixture.page.cleanup).toHaveBeenCalledTimes(2);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(fixture.task.destroy).toHaveBeenCalledTimes(reason === "destroy" ? 1 : 0);
  });

  it("cleans up a failed render and allows another page render on the same document", async () => {
    const fixture = syntheticDocument();
    const rendering = pendingRender();
    fixture.page.render.mockReturnValueOnce(rendering.task);
    adapter.getDocument.mockReturnValue(fixture.task);
    const handle = await engine().open(file(), signal(), vi.fn());
    const failure = new Error("Synthetic rendering failure");
    const result = handle.render(1, document.createElement("canvas"), signal());
    const rejection = expect(result).rejects.toBe(failure);
    await vi.waitFor(() => expect(fixture.page.render).toHaveBeenCalledOnce());
    rendering.completion.reject(failure);
    await rejection;
    expect(fixture.page.cleanup).toHaveBeenCalledTimes(2);
    expect(rendering.task.cancel).not.toHaveBeenCalled();
    expect(fixture.task.destroy).not.toHaveBeenCalled();
    await handle.render(1, document.createElement("canvas"), signal());
    expect(fixture.page.render).toHaveBeenCalledTimes(2);
    expect(fixture.page.cleanup).toHaveBeenCalledTimes(3);
  });
});
