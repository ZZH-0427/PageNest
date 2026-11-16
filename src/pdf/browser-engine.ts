import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { PDFDocumentLoadingTask, PDFPageProxy, PDFWorker, RenderTask } from "pdfjs-dist";
import { readPdfBytes, validatePdfHeader } from "./validation";
import { PdfExportDiagnosticError, type PdfExportDiagnosticItem } from "./export-diagnostics";
import { MAX_PDF_PAGES, PdfUserError, type PdfDocumentHandle, type PdfEngine, type PdfOpenOptions, type PdfPageInfo } from "./types";

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener("abort", cancel, { once: true });
  });
}

/** Cancellation must not wait forever for a worker render acknowledgement. */
async function settleRender(task: RenderTask): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task.promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 3000); }),
    ]);
  } finally { clearTimeout(timer); }
}

type SignatureValue = number | boolean | string | null | SignatureValue[];

/** A bounded graphics subset, excluding document IDs, glyphs, images, patterns and dependency objects. */
function graphicsSignatureData(list: Awaited<ReturnType<PDFPageProxy["getOperatorList"]>>, ops: Record<string, number>): SignatureValue[] {
  const names = ["save", "restore", "transform", "setLineWidth", "setLineCap", "setLineJoin", "setMiterLimit", "setDash", "setFlatness",
    "moveTo", "lineTo", "curveTo", "curveTo2", "curveTo3", "closePath", "rectangle", "stroke", "closeStroke", "fill", "eoFill",
    "fillStroke", "eoFillStroke", "closeFillStroke", "closeEOFillStroke", "endPath", "clip", "eoClip", "constructPath",
    "setStrokeGray", "setFillGray", "setStrokeRGBColor", "setFillRGBColor", "setStrokeCMYKColor", "setFillCMYKColor",
    "setStrokeTransparent", "setFillTransparent"];
  const selected = new Set(names.map((name) => ops[name]).filter(Number.isInteger));
  const rgb = new Set([ops.setStrokeRGBColor, ops.setFillRGBColor]);
  const unavailable = () => new Error("Render signature unavailable");
  if (list.fnArray.length > 50_000 || list.fnArray.length !== list.argsArray.length) throw unavailable();
  let values = 0;
  const normalize = (value: unknown, allowColor: boolean, depth = 0): SignatureValue => {
    if (++values > 100_000 || depth > 12) throw unavailable();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (allowColor && typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) return value;
    if (Array.isArray(value)) {
      if (value.length > 100_000 - values) throw unavailable();
      return value.map((entry) => normalize(entry, allowColor, depth + 1));
    }
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const array = value as unknown as ArrayLike<unknown>;
      if (array.length > 100_000 - values) throw unavailable();
      return [Object.prototype.toString.call(value), Array.from(array, (entry) => normalize(entry, false, depth + 1))];
    }
    throw unavailable();
  };
  const result: SignatureValue[] = [];
  for (let index = 0; index < list.fnArray.length; index++) {
    const operation = list.fnArray[index];
    if (selected.has(operation)) result.push([operation, normalize(list.argsArray[index], rgb.has(operation))]);
  }
  return result;
}

function deadline(signal: AbortSignal, milliseconds: number, failure: string | PdfUserError) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(typeof failure === "string" ? new PdfUserError(failure) : failure), milliseconds);
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

  async open(file: File, signal: AbortSignal, onStatus: (status: "reading" | "parsing") => void, options?: PdfOpenOptions): Promise<PdfDocumentHandle> {
    const fontPaths = options?.fontMode === "paths";
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
        ...(fontPaths ? { disableFontFace: true, useSystemFonts: false } : {}),
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
      const renderPage = async (number: number, canvas: HTMLCanvasElement, renderSignal: AbortSignal, rotationDelta = 0, maxWidth = 320, maxHeight = 440, inspectRender?: (page: PDFPageProxy, viewport: ReturnType<PDFPageProxy["getViewport"]>, signal: AbortSignal) => Promise<void>) => {
          const time = deadline(AbortSignal.any([renderSignal, disposed.signal, this.lifetime.signal]), 20_000, "此页面渲染耗时过长，已停止预览。");
          let renderTask: RenderTask | undefined;
          let cancel: (() => void) | undefined;
          let page;
          let cleanupFailed = false;
          try {
            time.signal.throwIfAborted();
            page = await abortable(document.getPage(number), time.signal);
            time.signal.throwIfAborted();
            // PDF.js expects an absolute angle. Keep the source /Rotate intact.
            const rotation = ((page.rotate + rotationDelta) % 360 + 360) % 360;
            const original = page.getViewport({ scale: 1, rotation });
            const scale = Math.min(maxWidth / original.width, maxHeight / original.height);
            const viewport = page.getViewport({ scale, rotation });
            canvas.width = Math.max(1, Math.floor(viewport.width));
            canvas.height = Math.max(1, Math.floor(viewport.height));
            renderTask = page.render({ canvas, viewport, background: "#ffffff" });
            renderTasks.add(renderTask);
            cancel = () => renderTask?.cancel();
            time.signal.addEventListener("abort", cancel, { once: true });
            await abortable(renderTask.promise, time.signal);
            if (inspectRender) await inspectRender(page, viewport, time.signal);
          } finally {
            try {
              if (cancel) time.signal.removeEventListener("abort", cancel);
              if (renderTask) {
                try {
                  if (time.signal.aborted) {
                    canvas.width = canvas.height = 0;
                    renderTask.cancel();
                  }
                  if (!await settleRender(renderTask)) cleanupFailed = true;
                } finally { renderTasks.delete(renderTask); }
              }
              page?.cleanup();
            } catch {
              cleanupFailed = true;
            } finally {
              if (time.signal.aborted || cleanupFailed) { canvas.width = 0; canvas.height = 0; }
              time.clear();
            }
          }
          if (cleanupFailed) {
            time.signal.throwIfAborted();
            throw new PdfExportDiagnosticError("INSPECTION_FAILURE", { stage: "cleanup", item: "resources" });
          }
      };
      return {
        pages,
        render: renderPage,
        inspectPage: async (number, inspectSignal, rotationDelta = 0, includeRenderSignature = false, renderSize = 128) => {
          const time = deadline(AbortSignal.any([inspectSignal, disposed.signal, this.lifetime.signal]), 20_000,
            new PdfExportDiagnosticError("VALIDATION_TIMEOUT", { stage: "inspection", item: "deadline" }));
          const canvas = globalThis.document.createElement("canvas");
          let page;
          let item: PdfExportDiagnosticItem = "page";
          let cleanupFailed = false;
          let result: Awaited<ReturnType<NonNullable<PdfDocumentHandle["inspectPage"]>>>;
          let scratch: Uint8Array<ArrayBuffer> | undefined;
          try {
            time.signal.throwIfAborted();
            if (renderSize !== 128 && renderSize !== 512) throw new PdfUserError("不支持的验证分辨率。");
            page = await abortable(document.getPage(number), time.signal);
            const rotation = ((page.rotate + rotationDelta) % 360 + 360) % 360;
            const viewport = page.getViewport({ scale: 1, rotation });
            item = "text";
            const content = await abortable(page.getTextContent(), time.signal);
            const text = JSON.stringify(content.items.filter((item) => "str" in item).map((item) => "str" in item ? item.str : ""));
            const digest = async (bytes: Uint8Array<ArrayBuffer>) => {
              const hash = await abortable(crypto.subtle.digest("SHA-256", bytes), time.signal);
              return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
            };
            const textDigest = await digest(new TextEncoder().encode(text));
            item = "visual";
            let renderSignature: { viewport: string; graphics: string } | undefined;
            const inspectRender = includeRenderSignature ? async (rendered: PDFPageProxy, renderedViewport: ReturnType<PDFPageProxy["getViewport"]>, renderSignal: AbortSignal) => {
              try {
                const { viewBox, transform, userUnit } = renderedViewport;
                if (viewBox.length !== 4 || transform.length !== 6 || ![...viewBox, ...transform, userUnit].every(Number.isFinite)) return;
                const operators = await abortable(rendered.getOperatorList(), renderSignal);
                const graphics = graphicsSignatureData(operators, pdfjs.OPS);
                const hashJson = async (value: unknown) => {
                  const encoded = new TextEncoder().encode(JSON.stringify(value));
                  try {
                    if (encoded.byteLength > 2 * 1024 ** 2) throw new Error("Render signature unavailable");
                    return await digest(encoded);
                  } finally { encoded.fill(0); }
                };
                renderSignature = { viewport: await hashJson({ viewBox, transform, userUnit }), graphics: await hashJson(graphics) };
              } catch {
                if (renderSignal.aborted) throw renderSignal.reason;
                // Optional diagnosis never substitutes for the exact text and pixel checks.
              }
            } : undefined;
            await renderPage(number, canvas, time.signal, rotationDelta, renderSize, renderSize, inspectRender);
            time.signal.throwIfAborted();
            const context = canvas.getContext("2d");
            if (!context) throw new PdfUserError("浏览器无法验证页面内容，未提供下载。");
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            scratch = new Uint8Array(pixels);
            const visualDigest = await digest(scratch);
            time.signal.throwIfAborted();
            result = { textDigest, visualDigest, width: viewport.width, height: viewport.height, rotation,
              visualSample: { width: canvas.width, height: canvas.height, pixels: scratch },
              ...(renderSignature ? { renderSignature } : {}) };
          } catch (error) {
            scratch?.fill(0);
            if (time.signal.aborted) throw time.signal.reason;
            if (error instanceof PdfExportDiagnosticError) throw error;
            throw new PdfExportDiagnosticError("INSPECTION_FAILURE", { stage: "inspection", item });
          } finally {
            canvas.width = canvas.height = 0;
            try { page?.cleanup(); }
            catch { cleanupFailed = true; }
            finally { time.clear(); }
          }
          if (cleanupFailed) {
            scratch?.fill(0);
            time.signal.throwIfAborted();
            throw new PdfExportDiagnosticError("INSPECTION_FAILURE", { stage: "cleanup", item: "resources" });
          }
          return result;
        },
        inspectDocument: async (inspectSignal) => {
          const time = deadline(AbortSignal.any([inspectSignal, disposed.signal, this.lifetime.signal]), 60_000,
            new PdfUserError("文档结构验证超时，未提供结果。"));
          const hash = async (value: unknown) => {
            const data = new TextEncoder().encode(JSON.stringify(value));
            try {
              if (data.length > 2 * 1024 ** 2) throw new PdfUserError("文档元数据超出安全检查范围。");
              const digest = await abortable(crypto.subtle.digest("SHA-256", data), time.signal);
              return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
            } finally { data.fill(0); }
          };
          try {
            const metadata = await abortable(document.getMetadata(), time.signal);
            const info = metadata.info as Record<string, unknown>;
            const canonical = (value: unknown, depth = 0): unknown => {
              if (depth > 16) throw new PdfUserError("文档元数据层级过深。");
              if (value === null || typeof value === "string" || typeof value === "boolean") return value;
              if (typeof value === "number" && Number.isFinite(value)) return value;
              if (Array.isArray(value)) return value.map((entry) => canonical(entry, depth + 1));
              if (typeof value === "object" && value !== null) {
                return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
                  .map(([key, entry]) => [key, canonical(entry, depth + 1)]));
              }
              throw new PdfUserError("无法安全验证文档元数据。");
            };
            // Version and linearization describe the rewritten container, not authored metadata.
            const authoredInfo = Object.fromEntries(Object.entries(info).filter(([key]) => !["PDFFormatVersion", "IsLinearized"].includes(key)));
            const outline = await abortable(document.getOutline(), time.signal);
            let outlineItems = 0;
            type Outline = NonNullable<typeof outline>[number];
            const normalizeOutline = async (items: Outline[], depth = 0): Promise<unknown[]> => {
              if (depth > 16 || items.length > 1000) throw new PdfUserError("书签结构超出安全检查范围。");
              const values: unknown[] = [];
              for (const entry of items) {
                time.signal.throwIfAborted();
                if (++outlineItems > 1000) throw new PdfUserError("书签数量超出安全检查范围。");
                let destination: unknown = entry.dest ?? null;
                if (typeof destination === "string") destination = await abortable(document.getDestination(destination), time.signal);
                if (Array.isArray(destination) && destination.length) {
                  const target = destination[0] as unknown;
                  if (typeof target === "object" && target !== null && "num" in target && "gen" in target) {
                    destination = [await abortable(document.getPageIndex(target as { num: number; gen: number }), time.signal), ...destination.slice(1)];
                  }
                }
                values.push(canonical({ title: entry.title, bold: entry.bold, italic: entry.italic,
                  color: Array.from(entry.color), count: entry.count ?? null, url: entry.url ?? null,
                  unsafeUrl: entry.unsafeUrl ?? null, newWindow: entry.newWindow ?? null, dest: destination,
                  children: await normalizeOutline(entry.items, depth + 1) }));
              }
              return values;
            };
            const outlines = await normalizeOutline(outline ?? []);
            const attachments = await abortable(document.getAttachments(), time.signal);
            const actions = await abortable(document.getJSActions(), time.signal);
            const permissions = await abortable(document.getPermissions(), time.signal);
            return { metadataDigest: await hash(canonical({ info: authoredInfo, xml: metadata.metadata?.getRaw() ?? null })),
              outlinesDigest: await hash(outlines), hasForms: !!info.IsAcroFormPresent || !!info.IsXFAPresent,
              hasSignatures: !!info.IsSignaturesPresent,
              hasAttachments: attachments !== null && Object.keys(attachments).length > 0,
              hasJavaScript: actions !== null && Object.keys(actions).length > 0, encrypted: permissions !== null };
          } catch (error) {
            if (time.signal.aborted) throw time.signal.reason;
            if (error instanceof PdfUserError) throw error;
            throw new PdfUserError("无法独立验证文档元数据或书签，未提供结果。");
          } finally { time.clear(); }
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
