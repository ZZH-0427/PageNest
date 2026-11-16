import { sanitizePdfFilename } from "../pdf/export";
import { abortError, isCancellation, PdfUserError } from "../pdf/types";
import { validatePdfHeader } from "../pdf/validation";
import {
  COMPRESSION_MODES, COMPRESSION_TASK_TIMEOUT_MS, COMPRESSION_URL_LIFETIME_MS,
  MAX_COMPRESSION_FILES, MAX_COMPRESSION_FILE_BYTES, MAX_COMPRESSION_PAGES,
  MAX_COMPRESSION_RESULT_BYTES, MAX_COMPRESSION_WORKSPACE_BYTES,
  type CompressionDownloadEnvironment, type CompressionMode, type CompressionResult,
  type CompressionRow, type CompressionRunner, type CompressionRunResult, type CompressionState,
} from "./types";

const browserDownloads: CompressionDownloadEnvironment = {
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
const safeError = (error: unknown) => error instanceof PdfUserError ? error.message
  : error instanceof RangeError ? "浏览器可用内存不足，未保留结果。请使用更小或更简单的 PDF。"
    : "无法完成此 PDF 的压缩或内容验证，未提供下载。原始文件保持不变。";
const pageCountValid = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= MAX_COMPRESSION_PAGES;

function outputName(name: string, mode: CompressionMode): string {
  const base = name.replace(/\.pdf$/i, "");
  return sanitizePdfFilename(`${base}_${mode === "lossless" ? "optimized" : mode}.pdf`);
}

/** Bounded serial tasks; cancelling an uninterruptible runner never opens another slot. */
export class PdfCompressionController {
  private state: CompressionState;
  private listeners = new Set<() => void>();
  private sources = new Map<string, File>();
  private blobs = new Map<string, Blob>();
  private urls = new Map<string, { url: string; timer: ReturnType<typeof setTimeout> }>();
  private ordinal = 0;
  private active = true;
  private batch: { controller: AbortController; cancelled: Set<string> } | null = null;
  private job: { id: string; controller: AbortController } | null = null;

  constructor(
    private readonly runner: CompressionRunner,
    private readonly downloads: CompressionDownloadEnvironment = browserDownloads,
    availableModes: readonly CompressionMode[] = COMPRESSION_MODES,
  ) {
    const modes = Object.freeze([...new Set(availableModes.filter((mode) => COMPRESSION_MODES.includes(mode)))]);
    this.state = Object.freeze({ files: Object.freeze([]), busy: false, notice: null,
      mode: modes[0] ?? "lossless", availableModes: modes });
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(patch: Partial<CompressionState>) {
    this.state = Object.freeze({ ...this.state, ...patch,
      files: Object.freeze([...(patch.files ?? this.state.files)].map((row) => Object.freeze(row))) });
    for (const listener of this.listeners) listener();
  }
  private update(id: string, patch: Partial<CompressionRow>) {
    if (this.state.files.some((row) => row.id === id)) this.publish({ files: this.state.files.map((row) => row.id === id ? { ...row, ...patch } : row) });
  }
  private revoke(id: string) {
    const owned = this.urls.get(id);
    if (owned) {
      clearTimeout(owned.timer);
      this.urls.delete(id);
      try { this.downloads.revokeUrl(owned.url); } catch { /* Drop ownership even if the browser has already revoked it. */ }
    }
  }
  private release(id: string) { this.revoke(id); this.blobs.delete(id); }
  private releaseAll() {
    for (const id of this.urls.keys()) this.revoke(id);
    this.blobs.clear();
  }

  addFiles(files: readonly File[]) {
    if (!this.active) return;
    const accepted: CompressionRow[] = [];
    const messages = new Set<string>();
    let bytes = this.state.files.reduce((total, row) => total + row.size, 0);
    for (const file of files) {
      if (!(file instanceof File) || !/\.pdf$/i.test(file.name)) {
        messages.add("请选择 PDF 文件；其他文档格式尚未开放。"); continue;
      }
      if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_COMPRESSION_FILE_BYTES) {
        messages.add("单份 PDF 必须大于 0 B，且不能超过 32 MiB。"); continue;
      }
      if (this.state.files.length + accepted.length >= MAX_COMPRESSION_FILES) {
        messages.add("最多保留 5 份 PDF，请先移除部分文件。"); continue;
      }
      if (bytes + file.size > MAX_COMPRESSION_WORKSPACE_BYTES) {
        messages.add("压缩工作区的来源文件累计不能超过 96 MiB，请分批处理。"); continue;
      }
      const ordinal = ++this.ordinal, id = `compression-${ordinal}`;
      this.sources.set(id, file);
      accepted.push({ id, ordinal, name: file.name, size: file.size, pageCount: null, status: "queued", result: null, error: null });
      bytes += file.size;
    }
    this.publish({ files: [...this.state.files, ...accepted], notice: messages.size ? [...messages].join(" ") : null });
  }

  setMode(mode: CompressionMode) {
    if (!this.active || this.batch || !this.state.availableModes.includes(mode) || mode === this.state.mode) return;
    this.releaseAll();
    this.publish({ mode, notice: null, files: this.state.files.map((row) => ({ ...row, status: "queued", result: null, error: null })) });
  }

  startAll = () => this.start();
  async start(id?: string): Promise<void> {
    if (!this.active || this.batch || !this.state.availableModes.includes(this.state.mode)) return;
    const ids = this.state.files.filter((row) => id === undefined || row.id === id).map((row) => row.id);
    if (!ids.length) return;
    const mode = this.state.mode;
    const batch = { controller: new AbortController(), cancelled: new Set<string>() };
    this.batch = batch;
    this.publish({ busy: true, notice: null });
    try {
      for (const nextId of ids) {
        if (!this.active || batch.controller.signal.aborted) break;
        if (batch.cancelled.has(nextId)) continue;
        const file = this.sources.get(nextId);
        if (!file) continue;
        this.release(nextId);
        const job = { id: nextId, controller: new AbortController() };
        this.job = job;
        const signal = AbortSignal.any([batch.controller.signal, job.controller.signal]);
        let bytes: Uint8Array | undefined;
        let acceptingStages = true;
        this.update(nextId, { status: "reading", result: null, error: null });
        const timeout = setTimeout(() => {
          job.controller.abort(new PdfUserError("处理超过 3 分钟，未保留结果。请尝试更小或更简单的 PDF。"));
        }, COMPRESSION_TASK_TIMEOUT_MS);
        try {
          const generated = await this.runner(file, mode, signal, (stage, pageCount) => {
            if (!acceptingStages || this.job !== job || signal.aborted || !this.sources.has(nextId) || !this.active) return;
            if (pageCount !== undefined && !pageCountValid(pageCount)) throw new PdfUserError("此 PDF 超过压缩页数限制或页数无效，最多支持 200 页。");
            this.update(nextId, { status: stage, ...(pageCount === undefined ? {} : { pageCount }) });
          });
          bytes = generated.bytes;
          signal.throwIfAborted();
          if (!this.active || this.sources.get(nextId) !== file || batch.cancelled.has(nextId)) throw abortError();
          this.validateGenerated(generated);
          const savedBytes = file.size - bytes.byteLength;
          const result: CompressionResult = Object.freeze({ outputBytes: bytes.byteLength, savedBytes,
            reductionPercent: savedBytes / file.size * 100, fileName: outputName(file.name, mode),
            methods: Object.freeze([...generated.methods]), validationLabel: generated.validationLabel,
            changedImages: generated.changedImages, skippedImages: generated.skippedImages });
          if (savedBytes > 0) {
            const retained = [...this.blobs.values()].reduce((total, blob) => total + blob.size, 0);
            if (retained + bytes.byteLength > MAX_COMPRESSION_RESULT_BYTES) throw new PdfUserError("保留的压缩结果累计超过 64 MiB，请先下载并移除部分文件。");
            this.blobs.set(nextId, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }));
          }
          this.update(nextId, { status: savedBytes > 0 ? "ready" : "no-benefit", result, pageCount: generated.pageCount, error: null });
        } catch (error) {
          this.release(nextId);
          const failure = job.controller.signal.aborted ? job.controller.signal.reason : error;
          const cancelled = !this.active || batch.controller.signal.aborted || batch.cancelled.has(nextId) || !this.sources.has(nextId) || isCancellation(failure);
          this.update(nextId, { status: cancelled ? "cancelled" : "error", result: null, error: cancelled ? null : safeError(failure) });
        } finally {
          acceptingStages = false;
          clearTimeout(timeout);
          if (bytes instanceof Uint8Array) bytes.fill(0);
          this.job = null;
        }
      }
    } finally {
      if (this.batch === batch) { this.batch = null; this.publish({ busy: false }); }
    }
  }

  private validateGenerated(generated: CompressionRunResult) {
    if (!(generated.bytes instanceof Uint8Array) || generated.bytes.byteLength < 1 || generated.bytes.byteLength > MAX_COMPRESSION_RESULT_BYTES ||
      !pageCountValid(generated.pageCount) || !Array.isArray(generated.methods) || !generated.methods.length || generated.methods.length > 12 ||
      generated.methods.some((method) => typeof method !== "string" || !method.trim() || method.length > 240) ||
      typeof generated.validationLabel !== "string" || !generated.validationLabel.trim() || generated.validationLabel.length > 240 ||
      ![generated.changedImages, generated.skippedImages].every((count) => Number.isSafeInteger(count) && count >= 0)) {
      throw new PdfUserError("压缩结果为空、超出限制或验证记录无效，未提供下载。");
    }
    validatePdfHeader(generated.bytes.subarray(0, 1024));
  }

  download(id: string) {
    const row = this.state.files.find((item) => item.id === id), blob = this.blobs.get(id);
    if (!this.active || !this.sources.has(id) || row?.status !== "ready" || !row.result || !blob) return;
    this.revoke(id);
    let url: string | undefined;
    try {
      url = this.downloads.createUrl(blob);
      const retainedUrl = url;
      this.urls.set(id, { url, timer: setTimeout(() => this.revoke(id), COMPRESSION_URL_LIFETIME_MS) });
      this.downloads.trigger(retainedUrl, row.result.fileName);
      this.publish({ notice: "已触发下载，请检查浏览器下载列表；应用无法确认文件已保存到磁盘。" });
    } catch {
      this.revoke(id);
      this.publish({ notice: "未能触发下载，请检查浏览器下载权限后重试。" });
    }
  }

  cancel(id?: string) {
    if (id !== undefined) {
      this.batch?.cancelled.add(id);
      if (this.job?.id === id) this.job.controller.abort();
      this.release(id);
      this.update(id, { status: "cancelled", result: null, error: null });
    } else {
      this.batch?.controller.abort();
      this.job?.controller.abort();
      this.releaseAll();
      this.publish({ files: this.state.files.map((row) => ({ ...row, status: "cancelled", result: null, error: null })), notice: null });
    }
  }
  removeFile(id: string) {
    this.batch?.cancelled.add(id);
    if (this.job?.id === id) this.job.controller.abort();
    this.release(id);
    this.sources.delete(id);
    this.publish({ files: this.state.files.filter((row) => row.id !== id), notice: null });
  }
  clear() {
    this.cancel();
    this.sources.clear();
    this.publish({ files: [], notice: null });
  }
  dismissNotice() { this.publish({ notice: null }); }
  activate() { this.active = true; }
  dispose() { this.active = false; this.clear(); }
}
