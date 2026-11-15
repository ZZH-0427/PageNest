import { BrowserPdfEngine } from "./browser-engine";
import { TaskQueue } from "./task-queue";
import { PdfExportController, type PdfExportSource } from "./export-controller";
import { generateEditedPdf } from "./export";
import { validateEditedPdf } from "./export-validation";
import { PdfExportDiagnosticError, type PdfExportDiagnostic, type PdfRendererProbeStatus } from "./export-diagnostics";
import type { PdfPageIntegrityEvidence } from "./export-integrity";
import { readPdfBytes } from "./validation";
import { PdfOperationController, type PdfOperationSource } from "./operation-controller";
import { buildSelectionPlan, validateOutputPlan, type PdfOutputPlan } from "./output-plan";
import { generatePlannedPdf, validatePlannedPdf } from "./output-engine";
import {
  clearEditSelection, createEditState, deleteEditSelection, moveEditPage, redoEdit,
  rotateEditSelection, selectAllEditPages, selectEditPage, undoEdit,
  type PageSelectionModifiers, type PdfEditPage, type PdfEditState,
} from "./edit";
import {
  abortError, isCancellation, pdfErrorMessage, PdfUserError, MAX_PDF_FILES,
  MAX_PDF_FILE_BYTES, MAX_WORKSPACE_BYTES, MAX_RENDER_TASKS,
  type PdfDocumentHandle, type PdfEngine, type PdfFileEntry, type PdfPageInfo,
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

type RendererProbeResult = Partial<Pick<PdfExportDiagnostic, "code" | "outputPage" | "sourcePage" | "item" | "visualDifference">>
  & { status: PdfRendererProbeStatus };

async function releaseValidationHandle(handle: PdfDocumentHandle | undefined): Promise<PdfExportDiagnosticError | undefined> {
  if (!handle) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      handle.destroy(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new PdfExportDiagnosticError("VALIDATION_TIMEOUT", {
        stage: "cleanup", item: "resources",
      })), 3000); }),
    ]);
    return undefined;
  } catch (error) {
    return error instanceof PdfExportDiagnosticError ? error
      : new PdfExportDiagnosticError("INSPECTION_FAILURE", { stage: "cleanup", item: "resources" });
  }
  finally { clearTimeout(timer); }
}

/** Fresh validation documents never borrow the preview handle or its rendering state. */
async function openValidationDocument(engine: PdfEngine, file: File, signal: AbortSignal, stage: "source-open" | "output-open"): Promise<PdfDocumentHandle> {
  const parsing = new AbortController();
  const parsingSignal = AbortSignal.any([signal, parsing.signal]);
  const timer = setTimeout(() => parsing.abort(new PdfExportDiagnosticError("VALIDATION_TIMEOUT", { stage, item: "deadline" })), 60_000);
  let opening: Promise<PdfDocumentHandle> | undefined;
  let acquired: PdfDocumentHandle | undefined;
  let detach: (() => void) | undefined;
  try {
    parsingSignal.throwIfAborted();
    opening = engine.open(file, parsingSignal, () => {});
    const cancelled = new Promise<never>((_resolve, reject) => {
      const abort = () => reject(parsingSignal.reason);
      parsingSignal.addEventListener("abort", abort, { once: true });
      detach = () => parsingSignal.removeEventListener("abort", abort);
      if (parsingSignal.aborted) abort();
    });
    acquired = await Promise.race([opening, cancelled]);
    parsingSignal.throwIfAborted();
    return acquired;
  } catch (error) {
    if (acquired) await releaseValidationHandle(acquired);
    else if (opening) void opening.then((late) => releaseValidationHandle(late)).catch(() => {});
    if (parsingSignal.aborted) throw parsingSignal.reason;
    if (isCancellation(error) || error instanceof PdfExportDiagnosticError) throw error;
    throw new PdfExportDiagnosticError("INSPECTION_FAILURE", { stage, item: "parser" });
  } finally {
    detach?.();
    clearTimeout(timer);
  }
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
  readonly exporter = new PdfExportController((id, scope) => this.captureExportSource(id, scope));
  readonly operations = new PdfOperationController((plan) => this.captureOperationSources(plan));

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

  /** Diagnostic comparison only: a matching alternate renderer never grants download. */
  private async probeRenderer(engine: PdfEngine, sourceFile: File, outputFile: File, pages: readonly PdfEditPage[], signal: AbortSignal, fontPaths: boolean): Promise<RendererProbeResult> {
    let source: PdfDocumentHandle | undefined;
    let output: PdfDocumentHandle | undefined;
    const result: RendererProbeResult = { status: "unavailable" };
    const open = (file: File) => fontPaths
      ? engine.open(file, signal, () => {}, { fontMode: "paths" })
      : engine.open(file, signal, () => {});
    try {
      signal.throwIfAborted();
      source = await open(sourceFile);
      signal.throwIfAborted();
      output = await open(outputFile);
      signal.throwIfAborted();
      const probeSource = source;
      const probeOutput = output;
      await this.renders.run(() => validateEditedPdf(probeSource, probeOutput, pages, signal), signal);
      signal.throwIfAborted();
      result.status = "match";
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (isCancellation(error)) throw error;
      if (error instanceof PdfExportDiagnosticError) {
        if (["PAGE_COUNT_MISMATCH", "PAGE_GEOMETRY_MISMATCH", "PAGE_ROTATION_MISMATCH", "TEXT_CONTENT_MISMATCH", "VISUAL_CONTENT_MISMATCH"].includes(error.code)) {
          result.status = "mismatch";
        }
        const failure = error.diagnostic;
        result.code = failure.code;
        result.outputPage = failure.outputPage;
        result.sourcePage = failure.sourcePage;
        result.item = failure.item;
        result.visualDifference = failure.visualDifference;
      }
    } finally {
      const released = await Promise.all([releaseValidationHandle(source), releaseValidationHandle(output)]);
      if (released.some((error) => error !== undefined)) result.status = "unavailable";
    }
    signal.throwIfAborted();
    return result;
  }

  /** Only this capability can reread the retained File; no public byte getter survives removal. */
  private captureExportSource(id: string, scope?: "selection"): PdfExportSource {
    if (this.operations.getSnapshot().busy) throw new PdfUserError("另一项 PDF 处理仍在进行，请等待其结束。");
    const entry = this.state.files.find((file) => file.id === id);
    const resource = this.resources.get(id);
    const engine = this.engine;
    if (!this.active || entry?.status !== "ready" || !entry.edit?.present.pages.length || !resource?.source || !resource.document || !engine) {
      throw new PdfUserError("当前 PDF 不可导出，请先导入并等待解析完成。");
    }
    const exportedPages = scope === "selection" ? buildSelectionPlan(entry, "selection.pdf").outputs[0].pages : entry.edit.present.pages;
    if (!exportedPages.length) throw new PdfUserError("请先选择至少一页，再导出选中页面。");
    this.operations.cancel();
    const request = {
      documentId: id,
      pages: exportedPages.map((page) => ({ ...page })),
      originalPages: entry.pages.map((page) => ({ ...page })),
    };
    request.pages.forEach(Object.freeze);
    request.originalPages.forEach(Object.freeze);
    Object.freeze(request.pages);
    Object.freeze(request.originalPages);
    Object.freeze(request);
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
        let integrity: readonly PdfPageIntegrityEvidence[] | undefined;
        try {
          assertCurrent(signal);
          onStage("generating");
          bytes = await generateEditedPdf(sourceBytes, request, signal, (observed) => { integrity = observed; });
        } finally {
          // Erase the temporary reread even if generation fails or is cancelled.
          sourceBytes.fill(0);
          sourceBytes = null;
        }
        assertCurrent(signal);
        if (bytes.byteLength > MAX_PDF_FILE_BYTES) throw new PdfUserError("生成结果超过 100 MiB，未创建下载。请减少页面或使用更小的文件。");
        onStage("validating");
        let validationSource: PdfDocumentHandle | undefined;
        let output: PdfDocumentHandle | undefined;
        let cleanupFailure: PdfExportDiagnosticError | undefined;
        try {
          const file = new File([bytes as Uint8Array<ArrayBuffer>], "validation.pdf", { type: "application/pdf" });
          validationSource = await openValidationDocument(engine, resource.source!, signal, "source-open");
          assertCurrent(signal);
          output = await openValidationDocument(engine, file, signal, "output-open");
          assertCurrent(signal);
          const validatedSource = validationSource;
          const validatedOutput = output;
          try {
            await this.renders.run(() => integrity
              ? validateEditedPdf(validatedSource, validatedOutput, request.pages, signal, integrity)
              : validateEditedPdf(validatedSource, validatedOutput, request.pages, signal), signal);
          } catch (error) {
            assertCurrent(signal);
            if (!(error instanceof PdfExportDiagnosticError) || error.code !== "VISUAL_CONTENT_MISMATCH") throw error;
            const baseline = await this.probeRenderer(engine, resource.source!, file, request.pages, signal, false);
            assertCurrent(signal);
            const probe = await this.probeRenderer(engine, resource.source!, file, request.pages, signal, true);
            assertCurrent(signal);
            throw error.withContext({
              nativeProbe: baseline.status, nativeProbeCode: baseline.code,
              nativeProbeOutputPage: baseline.outputPage, nativeProbeSourcePage: baseline.sourcePage,
              nativeProbeItem: baseline.item, nativeProbeVisualDifference: baseline.visualDifference,
              rendererProbe: `font-paths-${probe.status}`, probeCode: probe.code,
              probeOutputPage: probe.outputPage, probeSourcePage: probe.sourcePage,
              probeItem: probe.item, probeVisualDifference: probe.visualDifference,
            });
          }
          assertCurrent(signal);
        } finally {
          // Parallel bounded disposal preserves the first validation error.
          const released = await Promise.all([releaseValidationHandle(validationSource), releaseValidationHandle(output)]);
          cleanupFailure = released.find((error) => error !== undefined);
        }
        assertCurrent(signal);
        if (cleanupFailure) throw cleanupFailure;
        return bytes;
      },
    };
  }

  /** A frozen plan holds only metadata; private File capabilities are captured here. */
  private captureOperationSources(plan: PdfOutputPlan): PdfOperationSource {
    validateOutputPlan(plan);
    if (this.exporter.getSnapshot().busy) throw new PdfUserError("另一项 PDF 导出仍在进行，请等待其结束。");
    const engine = this.engine;
    if (!this.active || !engine) throw new PdfUserError("请先导入 PDF 并等待解析完成。");
    const bindings = new Map<string, { resource: Resource; file: File }>();
    for (const source of plan.sources) {
      const entry = this.state.files.find((file) => file.id === source.documentId);
      const resource = this.resources.get(source.documentId);
      if (entry?.status !== "ready" || !entry.edit || !resource?.source || !resource.document || entry.size !== source.size ||
        entry.pages.length !== source.originalPages.length || entry.pages.some((page, index) => {
          const metadata = source.originalPages[index];
          return page.number !== metadata.number || page.width !== metadata.width || page.height !== metadata.height ||
            page.rotation !== metadata.rotation || page.orientation !== metadata.orientation;
        })) throw new PdfUserError("来源 PDF 已失效或与输出计划不一致，请重新建立计划。");
      const available = new Map(entry.edit.present.pages.map((page) => [page.id, page]));
      for (const page of plan.outputs.flatMap((output) => output.pages).filter((page) => page.sourceDocumentId === source.documentId)) {
        const current = available.get(page.id);
        if (!current || current.sourcePageNumber !== page.sourcePageNumber || current.originalRotation !== page.originalRotation ||
          current.rotationDelta !== page.rotationDelta) throw new PdfUserError("页面已在计划确认后发生变化，请重新建立输出计划。");
      }
      bindings.set(source.documentId, { resource, file: resource.source });
    }
    this.exporter.cancel();
    const sourceSignal = AbortSignal.any([...bindings.values()].map(({ resource }) => resource.controller.signal));
    const assertCurrent = (signal: AbortSignal) => {
      signal.throwIfAborted();
      sourceSignal.throwIfAborted();
      if (!this.active || [...bindings].some(([id, { resource, file }]) => this.resources.get(id) !== resource || resource.source !== file)) throw abortError();
    };
    return {
      signal: sourceSignal,
      generate: async (output, signal, onStage) => {
        assertCurrent(signal);
        const ids = new Set(output.pages.map((page) => page.sourceDocumentId));
        const inputs: { documentId: string; bytes: Uint8Array; originalPages: readonly PdfPageInfo[] }[] = [];
        let bytes: Uint8Array | undefined;
        let accepted = false;
        const handles = new Map<string, PdfDocumentHandle>();
        let resultHandle: PdfDocumentHandle | undefined;
        try {
          try {
            for (const source of plan.sources.filter((source) => ids.has(source.documentId))) {
              assertCurrent(signal);
              const input = await readPdfBytes(bindings.get(source.documentId)!.file, signal);
              inputs.push({ documentId: source.documentId, bytes: input, originalPages: source.originalPages });
            }
            assertCurrent(signal);
            onStage("generating");
            bytes = await generatePlannedPdf([...inputs], output, signal);
          } finally {
            for (const input of inputs) input.bytes.fill(0);
            inputs.length = 0;
          }
          assertCurrent(signal);
          if (!bytes.byteLength || bytes.byteLength > MAX_PDF_FILE_BYTES) throw new PdfUserError("生成结果为空或超过 100 MiB，未提供下载。");
          onStage("validating");
          let validationFailed = false;
          let validationFailure: unknown;
          let cleanupFailure: PdfExportDiagnosticError | undefined;
          try {
            for (const id of ids) {
              handles.set(id, await openValidationDocument(engine, bindings.get(id)!.file, signal, "source-open"));
              assertCurrent(signal);
            }
            resultHandle = await openValidationDocument(engine,
              new File([bytes as Uint8Array<ArrayBuffer>], "validation.pdf", { type: "application/pdf" }), signal, "output-open");
            assertCurrent(signal);
            const checkedOutput = resultHandle;
            await this.renders.run(() => validatePlannedPdf(handles, checkedOutput, output.pages, signal), signal);
          } catch (error) {
            validationFailed = true;
            validationFailure = error;
          } finally {
            const released = await Promise.all([...handles.values(), ...(resultHandle ? [resultHandle] : [])].map(releaseValidationHandle));
            // A validation error remains primary; successful validation also requires successful cleanup.
            cleanupFailure = released.find((error) => error !== undefined);
          }
          assertCurrent(signal);
          if (validationFailed) throw validationFailure;
          if (cleanupFailure) throw cleanupFailure;
          accepted = true;
          return bytes;
        } finally { if (!accepted) bytes?.fill(0); }
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
    this.operations.cancel();
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
