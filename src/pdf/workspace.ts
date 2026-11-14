import { BrowserPdfEngine } from "./browser-engine";
import { TaskQueue } from "./task-queue";
import {
  abortError, isCancellation, pdfErrorMessage, MAX_PDF_FILES,
  MAX_PDF_FILE_BYTES, MAX_WORKSPACE_BYTES, MAX_RENDER_TASKS,
  type PdfDocumentHandle, type PdfEngine, type PdfFileEntry,
} from "./types";

export interface PdfWorkspaceState {
  files: PdfFileEntry[];
  selectedId: string | null;
  notice: string | null;
}

interface Resource {
  controller: AbortController;
  document?: PdfDocumentHandle;
}

/** Owns PDF data only while the PDF page is mounted. No global file state or storage. */
export class PdfWorkspace {
  private state: PdfWorkspaceState = { files: [], selectedId: null, notice: null };
  private listeners = new Set<() => void>();
  private resources = new Map<string, Resource>();
  private imports = new TaskQueue(1);
  private renders = new TaskQueue(MAX_RENDER_TASKS);
  private engine: PdfEngine | null = null;
  private ordinal = 0;
  private active = true;

  constructor(private readonly engineFactory: () => PdfEngine = () => new BrowserPdfEngine()) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  activate() { this.active = true; }

  private publish(state: PdfWorkspaceState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private update(id: string, patch: Partial<PdfFileEntry>) {
    if (!this.active || !this.resources.has(id)) return;
    this.publish({ ...this.state, files: this.state.files.map((entry) => entry.id === id ? { ...entry, ...patch } : entry) });
  }

  addFiles(files: File[]) {
    if (!this.active) return;
    let bytes = this.state.files.reduce((sum, file) => sum + file.size, 0);
    const entries = [...this.state.files];
    const accepted: { file: File; entry: PdfFileEntry; resource: Resource }[] = [];
    const rejections = new Set<string>();
    for (const file of files) {
      if (!file.size) { rejections.add("空文件未添加。"); continue; }
      if (file.size > MAX_PDF_FILE_BYTES) { rejections.add("单个 PDF 不能超过 100 MiB。"); continue; }
      if (entries.length >= MAX_PDF_FILES) { rejections.add("工作区最多保留 20 个文件，请先移除部分文件。"); continue; }
      if (bytes + file.size > MAX_WORKSPACE_BYTES) { rejections.add("工作区累计容量不能超过 256 MiB，请先移除部分文件。"); continue; }
      const entry: PdfFileEntry = {
        id: crypto.randomUUID(), name: file.name, size: file.size,
        ordinal: ++this.ordinal, status: "queued", pages: [], selectedPage: 1, error: null,
      };
      const resource = { controller: new AbortController() };
      this.resources.set(entry.id, resource);
      bytes += file.size;
      entries.push(entry);
      accepted.push({ file, entry, resource });
    }
    this.publish({ files: entries, selectedId: this.state.selectedId ?? accepted[0]?.entry.id ?? null, notice: [...rejections].join(" ") || null });
    for (const { file, entry, resource } of accepted) {
      void this.imports.run(async () => {
        this.engine ??= this.engineFactory();
        const document = await this.engine.open(file, resource.controller.signal, (status) => this.update(entry.id, { status }));
        if (!this.active || resource.controller.signal.aborted || !this.resources.has(entry.id)) {
          await document.destroy();
          return;
        }
        resource.document = document;
        this.update(entry.id, { status: "ready", pages: document.pages });
      }, resource.controller.signal).catch((error: unknown) => {
        if (!isCancellation(error) && !resource.controller.signal.aborted) {
          this.update(entry.id, { status: "error", error: pdfErrorMessage(error), pages: [] });
        }
      });
    }
  }

  selectFile(id: string) {
    if (this.resources.has(id)) this.publish({ ...this.state, selectedId: id });
  }

  selectPage(id: string, number: number) {
    const entry = this.state.files.find((file) => file.id === id);
    if (entry?.status === "ready" && Number.isInteger(number) && number >= 1 && number <= entry.pages.length) {
      this.update(id, { selectedPage: number });
    }
  }

  async renderPage(id: string, number: number, canvas: HTMLCanvasElement, signal: AbortSignal) {
    const resource = this.resources.get(id);
    if (!resource?.document) throw abortError();
    const combined = AbortSignal.any([signal, resource.controller.signal]);
    return this.renders.run(() => resource.document!.render(number, canvas, combined), combined);
  }

  removeFile(id: string) {
    const resource = this.resources.get(id);
    if (!resource) return;
    this.resources.delete(id);
    resource.controller.abort();
    void resource.document?.destroy().catch(() => {});
    const files = this.state.files.filter((file) => file.id !== id);
    this.publish({ files, selectedId: this.state.selectedId === id ? files[0]?.id ?? null : this.state.selectedId, notice: null });
    if (!files.length) this.releaseEngine();
  }

  clear() {
    for (const resource of this.resources.values()) {
      resource.controller.abort();
      void resource.document?.destroy().catch(() => {});
    }
    this.resources.clear();
    this.publish({ files: [], selectedId: null, notice: null });
    this.releaseEngine();
  }

  dismissNotice() { this.publish({ ...this.state, notice: null }); }

  private releaseEngine() {
    const engine = this.engine;
    this.engine = null;
    void engine?.destroy().catch(() => {});
  }

  dispose() {
    this.active = false;
    this.clear();
  }
}
