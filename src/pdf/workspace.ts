import { BrowserPdfEngine } from "./browser-engine";
import { TaskQueue } from "./task-queue";
import { PdfExportController, type PdfExportSource } from "./export-controller";
import { generateEditedPdf } from "./export";
import { validateEditedPdf } from "./export-validation";
import { readPdfBytes } from "./validation";
import {
  clearEditSelection, createEditState, deleteEditSelection, moveEditPage, redoEdit,
  rotateEditSelection, selectAllEditPages, selectEditPage, undoEdit,
  type PageSelectionModifiers, type PdfEditState,
} from "./edit";
import {
  abortError, isCancellation, pdfErrorMessage, PdfUserError, MAX_PDF_FILES,
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
  source?: File;
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
  readonly exporter = new PdfExportController((id) => this.captureExportSource(id));

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
        ordinal: ++this.ordinal, status: "queued", pages: [], selectedPage: 1, edit: null, error: null,
      };
      const resource: Resource = { controller: new AbortController(), source: file };
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
        this.update(entry.id, { status: "ready", pages: document.pages, edit: createEditState(entry.id, document.pages) });
      }, resource.controller.signal).catch((error: unknown) => {
        if (!isCancellation(error) && !resource.controller.signal.aborted) {
          resource.source = undefined;
          this.update(entry.id, { status: "error", error: pdfErrorMessage(error), pages: [] });
        }
      });
    }
  }

  selectFile(id: string) {
    if (this.resources.has(id)) this.publish({ ...this.state, selectedId: id });
  }

  private edit(id: string, operation: (state: PdfEditState) => PdfEditState) {
    const entry = this.state.files.find((file) => file.id === id);
    if (entry?.status !== "ready" || !entry.edit) return;
    const edit = operation(entry.edit);
    if (edit === entry.edit) return;
    const selectedPage = edit.present.pages.findIndex((page) => edit.present.selectedIds.includes(page.id)) + 1;
    this.update(id, { edit, selectedPage });
  }

  selectPage(id: string, number: number, modifiers: PageSelectionModifiers = {}) {
    if (!Number.isInteger(number)) return;
    this.edit(id, (edit) => {
      const page = edit.present.pages[number - 1];
      return page ? selectEditPage(edit, page.id, modifiers) : edit;
    });
  }

  selectAllPages(id: string) { this.edit(id, selectAllEditPages); }
  clearPageSelection(id: string) { this.edit(id, clearEditSelection); }

  deleteSelectedPages(id: string) {
    const entry = this.state.files.find((file) => file.id === id);
    if (entry?.status !== "ready" || !entry.edit) return;
    const { pages, selectedIds } = entry.edit.present;
    if (pages.length && pages.every((page) => selectedIds.includes(page.id))) {
      this.publish({ ...this.state, notice: "至少需要保留一页，不能删除当前文档的全部页面。" });
      return;
    }
    this.edit(id, deleteEditSelection);
  }

  rotateSelectedPages(id: string, delta: 90 | -90) {
    this.edit(id, (edit) => rotateEditSelection(edit, delta));
  }

  movePage(id: string, pageId: string, targetIndex: number) {
    this.edit(id, (edit) => moveEditPage(edit, pageId, targetIndex));
  }

  moveSelectedPage(id: string, direction: -1 | 1) {
    if (direction !== -1 && direction !== 1) return;
    this.edit(id, (edit) => {
      if (edit.present.selectedIds.length !== 1) return edit;
      const pageId = edit.present.selectedIds[0];
      const index = edit.present.pages.findIndex((page) => page.id === pageId);
      return moveEditPage(edit, pageId, index + direction);
    });
  }

  undo(id: string) { this.edit(id, undoEdit); }
  redo(id: string) { this.edit(id, redoEdit); }

  /** Only this capability can reread the retained File; no public byte getter survives removal. */
  private captureExportSource(id: string): PdfExportSource {
    const entry = this.state.files.find((file) => file.id === id);
    const resource = this.resources.get(id);
    const engine = this.engine;
    if (!this.active || entry?.status !== "ready" || !entry.edit?.present.pages.length || !resource?.source || !resource.document || !engine) {
      throw new PdfUserError("当前 PDF 不可导出，请先导入并等待解析完成。");
    }
    const request = {
      documentId: id,
      pages: entry.edit.present.pages.map((page) => ({ ...page })),
      originalPages: entry.pages.map((page) => ({ ...page })),
    };
    const assertCurrent = (signal: AbortSignal) => {
      signal.throwIfAborted();
      if (!this.active || this.resources.get(id) !== resource || !resource.source || !resource.document) throw abortError();
    };
    return {
      documentId: id, sourceName: entry.name, pageCount: request.pages.length,
      signal: resource.controller.signal,
      generate: async (signal, onStage) => {
        assertCurrent(signal);
        // This single read is temporary. PDF.js already owns its independent preview data.
        let sourceBytes: Uint8Array<ArrayBuffer> | null = await readPdfBytes(resource.source!, signal);
        let bytes: Uint8Array;
        try {
          assertCurrent(signal);
          onStage("generating");
          bytes = await generateEditedPdf(sourceBytes, request, signal);
        } finally {
          // Erase the temporary reread even if generation fails or is cancelled.
          sourceBytes.fill(0);
          sourceBytes = null;
        }
        assertCurrent(signal);
        if (bytes.byteLength > MAX_PDF_FILE_BYTES) throw new PdfUserError("生成结果超过 100 MiB，未创建下载。请减少页面或使用更小的文件。");
        onStage("validating");
        let output: PdfDocumentHandle | undefined;
        try {
          const file = new File([bytes as Uint8Array<ArrayBuffer>], "validation.pdf", { type: "application/pdf" });
          output = await engine.open(file, signal, () => {});
          assertCurrent(signal);
          const validatedOutput = output;
          await this.renders.run(() => validateEditedPdf(resource.document!, validatedOutput, request.pages, signal), signal);
          assertCurrent(signal);
          return bytes;
        } finally {
          if (output) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                output.destroy(),
                new Promise<never>((_resolve, reject) => {
                  timer = setTimeout(() => reject(new PdfUserError("PDF 验证资源未能及时释放。请清空工作区并刷新后重试。")), 3000);
                }),
              ]);
            } finally { clearTimeout(timer); }
          }
        }
      },
    };
  }

  async renderPage(id: string, number: number, canvas: HTMLCanvasElement, signal: AbortSignal, rotationDelta = 0) {
    const resource = this.resources.get(id);
    if (!resource?.document) throw abortError();
    const combined = AbortSignal.any([signal, resource.controller.signal]);
    return this.renders.run(() => resource.document!.render(number, canvas, combined, rotationDelta), combined);
  }

  removeFile(id: string) {
    const resource = this.resources.get(id);
    if (!resource) return;
    this.resources.delete(id);
    resource.controller.abort();
    resource.source = undefined;
    void resource.document?.destroy().catch(() => {});
    const files = this.state.files.filter((file) => file.id !== id);
    this.publish({ files, selectedId: this.state.selectedId === id ? files[0]?.id ?? null : this.state.selectedId, notice: null });
    if (!files.length) this.releaseEngine();
  }

  clear() {
    this.exporter.cancel();
    for (const resource of this.resources.values()) {
      resource.controller.abort();
      resource.source = undefined;
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
