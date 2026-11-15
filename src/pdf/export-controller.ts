import { sanitizePdfFilename } from "./export";
import { PdfExportDiagnosticError } from "./export-diagnostics";
import { isCancellation, MAX_PDF_FILE_BYTES, PdfUserError } from "./types";

export type PdfExportStage = "idle" | "preparing" | "generating" | "validating" | "ready" | "error" | "cancelling" | "downloaded";
export interface PdfExportState {
  stage: PdfExportStage;
  busy: boolean;
  documentId: string | null;
  sourceName: string;
  fileName: string;
  pageCount: number;
  error: string | null;
}

/** A short-lived capability for one immutable edit snapshot, never React state. */
export interface PdfExportSource {
  documentId: string;
  sourceName: string;
  pageCount: number;
  signal: AbortSignal;
  generate(signal: AbortSignal, onStage: (stage: "generating" | "validating") => void): Promise<Uint8Array>;
}

export interface PdfDownloadEnvironment {
  createUrl(blob: Blob): string;
  revokeUrl(url: string): void;
  trigger(url: string, filename: string): void;
}

const browserDownload: PdfDownloadEnvironment = {
  createUrl: (blob) => URL.createObjectURL(blob),
  revokeUrl: (url) => URL.revokeObjectURL(url),
  trigger: (url, filename) => {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.append(anchor);
    try { anchor.click(); } finally { anchor.remove(); }
  },
};

const emptyState = (): PdfExportState => ({
  stage: "idle", busy: false, documentId: null, sourceName: "", fileName: "", pageCount: 0, error: null,
});

/** Owns one export job and its transient download bytes/URL. Never persists document data. */
export class PdfExportController {
  private state = emptyState();
  private listeners = new Set<() => void>();
  private running: AbortController | null = null;
  private result: Blob | null = null;
  private url: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private detachSource: (() => void) | null = null;

  constructor(
    private readonly capture: (documentId: string) => PdfExportSource,
    private readonly downloadEnvironment: PdfDownloadEnvironment = browserDownload,
  ) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(patch: Partial<PdfExportState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private releaseResult() {
    this.result = null;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.url) this.downloadEnvironment.revokeUrl(this.url);
    this.url = null;
  }

  async start(documentId: string, filename: string) {
    // An aborted non-interruptible save must finish before another job may allocate memory.
    if (this.running) return;
    this.releaseResult();
    this.detachSource?.();
    this.detachSource = null;
    const controller = new AbortController();
    this.running = controller;
    this.publish({ ...emptyState(), stage: "preparing", busy: true, documentId, fileName: sanitizePdfFilename(filename) });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const source = this.capture(documentId);
      source.signal.throwIfAborted();
      const cancel = () => this.cancel();
      source.signal.addEventListener("abort", cancel, { once: true });
      this.detachSource = () => source.signal.removeEventListener("abort", cancel);
      this.publish({ sourceName: source.sourceName, pageCount: source.pageCount });
      timeout = setTimeout(() => controller.abort(this.state.stage === "validating"
        ? new PdfExportDiagnosticError("VALIDATION_TIMEOUT", { stage: "validating", item: "deadline" })
        : new PdfUserError("导出耗时过长。请尝试更小或更简单的 PDF。")), 300_000);
      const signal = AbortSignal.any([controller.signal, source.signal]);
      const bytes = await source.generate(signal, (stage) => {
        signal.throwIfAborted();
        this.publish({ stage });
      });
      signal.throwIfAborted();
      if (!bytes.byteLength || bytes.byteLength > MAX_PDF_FILE_BYTES) {
        throw new PdfUserError("生成结果为空或超过 100 MiB，未创建下载。请减少页面或使用更小的文件。");
      }
      // Blob makes the sole retained result independent of the generator's temporary buffer.
      this.result = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
      this.publish({ stage: "ready", busy: false });
    } catch (error) {
      const failure = controller.signal.aborted ? controller.signal.reason : error;
      this.releaseResult();
      this.detachSource?.();
      this.detachSource = null;
      if (isCancellation(failure)) this.publish(emptyState());
      else this.publish({
        stage: "error", busy: false,
        error: failure instanceof PdfUserError ? failure.message : failure instanceof RangeError
          ? "浏览器可用内存不足，未生成下载。请减少页面或使用更小的文件。"
          : "无法完成 PDF 导出。原始文件与编辑历史未更改，请重试或使用更简单的 PDF。",
      });
    } finally {
      clearTimeout(timeout);
      this.running = null;
      if (this.state.stage === "cancelling") this.publish(emptyState());
    }
  }

  /** User gesture only. Browsers cannot confirm a successful disk save. */
  download() {
    if (!this.result || this.running || this.state.stage !== "ready") return;
    try {
      this.url ??= this.downloadEnvironment.createUrl(this.result);
      this.downloadEnvironment.trigger(this.url, this.state.fileName);
      this.result = null;
      this.publish({ stage: "downloaded", error: null });
      // Immediate revocation can race the browser download. Source removal still revokes early.
      this.timer = setTimeout(() => this.releaseResult(), 60_000);
    } catch {
      if (this.url) this.downloadEnvironment.revokeUrl(this.url);
      this.url = null;
      this.publish({ error: "未能触发下载。请检查浏览器下载权限后重试；应用无法确认文件是否保存到磁盘。" });
    }
  }

  cancel() {
    this.releaseResult();
    this.detachSource?.();
    this.detachSource = null;
    if (this.running) {
      this.running.abort();
      this.publish({ stage: "cancelling", busy: true, error: null });
    } else this.publish(emptyState());
  }
}
