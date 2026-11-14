import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { PDFDocumentLoadingTask, PDFWorker, RenderTask } from "pdfjs-dist";
import { readPdfBytes, validatePdfHeader } from "./validation";
import { MAX_PDF_PAGES, PdfUserError, type PdfDocumentHandle, type PdfEngine, type PdfPageInfo } from "./types";

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener("abort", cancel, { once: true });
  });
}

function deadline(signal: AbortSignal, milliseconds: number, message: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new PdfUserError(message)), milliseconds);
  return { signal: AbortSignal.any([signal, controller.signal]), clear: () => clearTimeout(timer) };
}

/** One real, explicitly owned parsing worker per mounted workspace; no fake-worker fallback. */
export class BrowserPdfEngine implements PdfEngine {
  private lifetime = new AbortController();
  private nativeWorker: Worker | null = null;
  private pdfWorker: PDFWorker | null = null;
  private client: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | null = null;
  private tasks = new Set<PDFDocumentLoadingTask>();
  private cleanups = new Map<PDFDocumentLoadingTask, Promise<void>>();
  private destruction: Promise<void> | null = null;

  private destroyTask(task: PDFDocumentLoadingTask): Promise<void> {
    const existing = this.cleanups.get(task);
    if (existing) return existing;
    const cleanup = Promise.resolve().then(() => task.destroy()).finally(() => {
      this.tasks.delete(task);
      this.cleanups.delete(task);
    });
    this.cleanups.set(task, cleanup);
    return cleanup;
  }

  private async initialize() {
    this.client ??= import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdfjs = await this.client;
    this.lifetime.signal.throwIfAborted();
    if (!this.nativeWorker) {
      try {
        this.nativeWorker = new Worker(workerUrl, { type: "module", name: "PageNest PDF parser" });
        this.nativeWorker.addEventListener("error", (event) => {
          event.preventDefault();
          this.lifetime.abort(new PdfUserError("PDF 解析组件加载失败或已停止。请清空工作区并刷新后重试。"));
        });
        this.nativeWorker.addEventListener("messageerror", () => {
          this.lifetime.abort(new PdfUserError("PDF 解析组件通信失败。请清空工作区并重试。"));
        });
        this.pdfWorker = pdfjs.PDFWorker.create({ port: this.nativeWorker, verbosity: 0 });
      } catch {
        this.pdfWorker?.destroy();
        this.nativeWorker?.terminate();
        this.pdfWorker = null;
        this.nativeWorker = null;
        throw new PdfUserError("无法启动 PDF 解析组件，请使用支持 Web Worker 的现代浏览器并刷新重试。");
      }
    }
    return pdfjs;
  }

  async open(file: File, signal: AbortSignal, onStatus: (status: "reading" | "parsing") => void): Promise<PdfDocumentHandle> {
    const timed = deadline(AbortSignal.any([signal, this.lifetime.signal]), 60_000, "此 PDF 读取或解析耗时过长，已停止。请尝试更小或更简单的文档。");
    const currentSignal = timed.signal;
    let task: PDFDocumentLoadingTask | undefined;
    try {
      onStatus("reading");
      validatePdfHeader(await readPdfBytes(file.slice(0, 1024), currentSignal));
      const data = await readPdfBytes(file, currentSignal);
      onStatus("parsing");
      const pdfjs = await abortable(this.initialize(), currentSignal);
      const assets = `${import.meta.env.BASE_URL}pdfjs/${pdfjs.version}/`;
      task = pdfjs.getDocument({
        data, worker: this.pdfWorker!, verbosity: 0, stopAtErrors: true,
        enableXfa: false, useWorkerFetch: true,
        cMapUrl: `${assets}cmaps/`, cMapPacked: true,
        standardFontDataUrl: `${assets}standard_fonts/`,
        wasmUrl: `${assets}wasm/`, iccUrl: `${assets}iccs/`,
        canvasMaxAreaInBytes: 16 * 1024 ** 2,
      });
      this.tasks.add(task);
      // No onPassword callback: PDF.js rejects with PasswordException instead of waiting for input.
      const document = await abortable(task.promise, currentSignal);
      if (document.numPages < 1 || document.numPages > MAX_PDF_PAGES) {
        throw new PdfUserError(`单个 PDF 最多支持 ${MAX_PDF_PAGES} 页，此文件未导入。`);
      }
      const pages: PdfPageInfo[] = [];
      for (let number = 1; number <= document.numPages; number++) {
        currentSignal.throwIfAborted();
        const page = await abortable(document.getPage(number), currentSignal);
        const viewport = page.getViewport({ scale: 1 });
        const { width, height, rotation } = viewport;
        if (![width, height].every((value) => Number.isFinite(value) && value > 0 && value <= 144_000)) {
          throw new PdfUserError("此 PDF 包含不支持的页面尺寸，已停止导入。");
        }
        pages.push({ number, width, height, rotation, orientation: width === height ? "square" : width > height ? "landscape" : "portrait" });
        page.cleanup();
      }
      currentSignal.throwIfAborted();
      const loadingTask = task;
      const renderTasks = new Set<RenderTask>();
      const disposed = new AbortController();
      let destruction: Promise<void> | undefined;
      return {
        pages,
        render: async (number, canvas, renderSignal) => {
          const time = deadline(AbortSignal.any([renderSignal, disposed.signal, this.lifetime.signal]), 20_000, "此页面渲染耗时过长，已停止预览。");
          let renderTask: RenderTask | undefined;
          let cancel: (() => void) | undefined;
          let page;
          try {
            time.signal.throwIfAborted();
            page = await abortable(document.getPage(number), time.signal);
            time.signal.throwIfAborted();
            const original = page.getViewport({ scale: 1 });
            const scale = Math.min(320 / original.width, 440 / original.height);
            const viewport = page.getViewport({ scale });
            canvas.width = Math.max(1, Math.floor(viewport.width));
            canvas.height = Math.max(1, Math.floor(viewport.height));
            renderTask = page.render({ canvas, viewport, background: "#ffffff" });
            renderTasks.add(renderTask);
            cancel = () => renderTask?.cancel();
            time.signal.addEventListener("abort", cancel, { once: true });
            await abortable(renderTask.promise, time.signal);
          } finally {
            if (cancel) time.signal.removeEventListener("abort", cancel);
            if (renderTask) {
              if (time.signal.aborted) renderTask.cancel();
              await renderTask.promise.catch(() => {});
              renderTasks.delete(renderTask);
            }
            page?.cleanup();
            if (time.signal.aborted) { canvas.width = 0; canvas.height = 0; }
            time.clear();
          }
        },
        destroy: () => {
          if (destruction) return destruction;
          disposed.abort();
          for (const render of renderTasks) render.cancel();
          destruction = this.destroyTask(loadingTask);
          return destruction;
        },
      };
    } catch (error) {
      if (task) {
        void this.destroyTask(task).catch(() => {});
      }
      if (currentSignal.aborted) throw currentSignal.reason;
      throw error;
    } finally {
      timed.clear();
    }
  }

  async destroy() {
    if (this.destruction) return this.destruction;
    this.lifetime.abort();
    this.destruction = (async () => {
      // PDF.js clears fonts and shared objects only after the worker's Terminate acknowledgement.
      // Keep already-started handle cleanups in this wait, too. A dead worker cannot block exit forever.
      const pending = [...this.tasks].map((task) => this.destroyTask(task));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(pending),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, 3000); }),
        ]);
      } finally {
        clearTimeout(timer);
        this.tasks.clear();
        this.cleanups.clear();
        this.pdfWorker?.destroy();
        this.nativeWorker?.terminate();
        this.pdfWorker = null;
        this.nativeWorker = null;
      }
    })();
    return this.destruction;
  }
}
