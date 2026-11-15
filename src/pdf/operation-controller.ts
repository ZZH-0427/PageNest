import { sanitizePdfFilename } from "./export";
import { PdfExportDiagnosticError } from "./export-diagnostics";
import { MAX_PLAN_OUTPUT_BYTES, snapshotOutputPlan, type PdfOutputDefinition, type PdfOutputPlan } from "./output-plan";
import type { PdfDownloadEnvironment } from "./export-controller";
import { isCancellation, MAX_PDF_FILE_BYTES, PdfUserError } from "./types";

export type PdfOperationStage = "idle" | "preparing" | "generating" | "validating" | "ready" | "error" | "cancelling";
export interface PdfOperationResult {
  id: string;
  fileName: string;
  rangeLabel: string;
  pageCount: number;
  size: number;
  downloaded: boolean;
}
export interface PdfOperationState {
  stage: PdfOperationStage;
  busy: boolean;
  error: string | null;
  outputIndex: number;
  totalOutputs: number;
  results: readonly PdfOperationResult[];
}
export interface PdfOperationSource {
  signal: AbortSignal;
  generate(output: PdfOutputDefinition, signal: AbortSignal, onStage: (stage: "generating" | "validating") => void): Promise<Uint8Array>;
}

const empty = (): PdfOperationState => ({ stage: "idle", busy: false, error: null, outputIndex: 0, totalOutputs: 0, results: [] });
const downloadEnvironment: PdfDownloadEnvironment = {
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

/** Serial, all-or-nothing output batch. Only lightweight metadata reaches React. */
export class PdfOperationController {
  private state = empty();
  private listeners = new Set<() => void>();
  private running: AbortController | null = null;
  private blobs = new Map<string, Blob>();
  private urls = new Map<string, { url: string; timer: ReturnType<typeof setTimeout> }>();
  private detachSource: (() => void) | null = null;

  constructor(private readonly capture: (plan: PdfOutputPlan) => PdfOperationSource,
    private readonly downloads: PdfDownloadEnvironment = downloadEnvironment) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(patch: Partial<PdfOperationState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private release() {
    this.blobs.clear();
    for (const { url, timer } of this.urls.values()) { clearTimeout(timer); this.downloads.revokeUrl(url); }
    this.urls.clear();
  }

  async start(input: PdfOutputPlan): Promise<void> {
    if (this.running) return;
    this.release();
    this.detachSource?.();
    this.detachSource = null;
    const controller = new AbortController();
    this.running = controller;
    this.publish({ ...empty(), stage: "preparing", busy: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const plan = snapshotOutputPlan(input);
      const source = this.capture(plan);
      source.signal.throwIfAborted();
      const cancel = () => this.cancel();
      source.signal.addEventListener("abort", cancel, { once: true });
      this.detachSource = () => source.signal.removeEventListener("abort", cancel);
      const signal = AbortSignal.any([controller.signal, source.signal]);
      this.publish({ totalOutputs: plan.outputs.length });
      timeout = setTimeout(() => controller.abort(this.state.stage === "validating"
        ? new PdfExportDiagnosticError("VALIDATION_TIMEOUT", { stage: "validating", item: "deadline" })
        : new PdfUserError("处理耗时过长，未提供结果。请减少页面或使用更简单的 PDF。")), 300_000);
      let totalBytes = 0;
      const results: PdfOperationResult[] = [];
      for (const [index, output] of plan.outputs.entries()) {
        signal.throwIfAborted();
        this.publish({ outputIndex: index + 1, stage: "generating" });
        let bytes: Uint8Array | undefined;
        try {
          bytes = await source.generate(output, signal, (stage) => { signal.throwIfAborted(); this.publish({ stage }); });
          signal.throwIfAborted();
          totalBytes += bytes.byteLength;
          if (!bytes.byteLength || bytes.byteLength > MAX_PDF_FILE_BYTES || totalBytes > MAX_PLAN_OUTPUT_BYTES) {
            throw new PdfUserError("结果为空或多份结果累计超过 100 MiB，未提供下载。请减少输出页面或分批处理。");
          }
          this.blobs.set(output.id, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }));
          results.push({ id: output.id, fileName: sanitizePdfFilename(output.fileName), rangeLabel: output.rangeLabel,
            pageCount: output.pages.length, size: bytes.byteLength, downloaded: false });
        } finally { bytes?.fill(0); }
      }
      signal.throwIfAborted();
      this.publish({ stage: "ready", busy: false, results });
    } catch (error) {
      const failure = controller.signal.aborted ? controller.signal.reason : error;
      this.release();
      this.detachSource?.();
      this.detachSource = null;
      if (isCancellation(failure)) this.publish(empty());
      else this.publish({ stage: "error", busy: false, results: [], error: failure instanceof PdfUserError ? failure.message
        : failure instanceof RangeError ? "浏览器可用内存不足，未保留结果。请减少页面或分批处理。"
          : "无法完成 PDF 处理，未提供下载。原始文件和编辑历史未更改。" });
    } finally {
      clearTimeout(timeout);
      this.running = null;
      if (this.state.stage === "cancelling") this.publish(empty());
    }
  }

  download(id: string): void {
    const blob = this.blobs.get(id), result = this.state.results.find((item) => item.id === id);
    if (!blob || !result || this.running || this.state.stage !== "ready") return;
    let url: string | undefined;
    try {
      const existing = this.urls.get(id);
      url = existing?.url ?? this.downloads.createUrl(blob);
      this.downloads.trigger(url, result.fileName);
      const retainedUrl = url;
      if (!existing) this.urls.set(id, { url, timer: setTimeout(() => { this.downloads.revokeUrl(retainedUrl); this.urls.delete(id); }, 60_000) });
      this.publish({ error: null, results: this.state.results.map((item) => item.id === id ? { ...item, downloaded: true } : item) });
    } catch {
      if (url) this.downloads.revokeUrl(url);
      const previous = this.urls.get(id);
      if (previous) clearTimeout(previous.timer);
      this.urls.delete(id);
      this.publish({ error: "未能触发下载，请检查浏览器下载设置后重试。应用无法确认文件已保存到磁盘。" });
    }
  }

  cancel(): void {
    this.release();
    this.detachSource?.();
    this.detachSource = null;
    if (this.running) {
      this.running.abort();
      this.publish({ stage: "cancelling", busy: true, error: null, results: [] });
    } else this.publish(empty());
  }
}
