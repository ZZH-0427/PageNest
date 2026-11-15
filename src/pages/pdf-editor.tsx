import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  FilePlus2,
  FileText,
  Files,
  LayoutGrid,
  LoaderCircle,
  Plus,
  Download,
  Redo2,
  RotateCcw,
  RotateCw,
  Scissors,
  ShieldCheck,
  Trash2,
  Upload,
  Undo2,
  X,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { PdfThumbnail } from "../components/pdf/thumbnail";
import { PdfExportPanel } from "../components/pdf/export-panel";
import { PdfOperationPanel } from "../components/pdf/operation-panel";
import { usePdfWorkspace } from "../pdf/use-pdf-workspace";
import { getEditedPageInfo, isEdited } from "../pdf/edit";
import {
  formatPdfBytes,
  MAX_PDF_FILES,
  MAX_PDF_FILE_BYTES,
  MAX_PDF_PAGES,
  MAX_WORKSPACE_BYTES,
} from "../pdf/types";
import "./pdf-editor.css";

const statusLabels = {
  queued: "等待解析",
  reading: "读取中",
  parsing: "解析中",
  ready: "已就绪",
  error: "导入失败",
} as const;

const numberFormat = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 1,
});

export function PdfEditor() {
  const { state, workspace } = usePdfWorkspace();
  const input = useRef<HTMLInputElement>(null);
  const scrollRoot = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [panel, setPanel] = useState<"current" | "selection" | "merge" | "split" | null>(null);
  const exportTask = useSyncExternalStore(workspace.exporter.subscribe, workspace.exporter.getSnapshot);
  const operationTask = useSyncExternalStore(workspace.operations.subscribe, workspace.operations.getSnapshot);
  const outputBusy = exportTask.busy || operationTask.busy;
  const exportOpen = panel === "current";
  const pageDrag = useRef<{ documentId: string; pageId: string } | null>(null);
  const [dragPageId, setDragPageId] = useState<string | null>(null);
  const [dropMarker, setDropMarker] = useState<{ pageId: string; after: boolean } | null>(null);
  const selected = state.files.find((file) => file.id === state.selectedId);
  const edit = selected?.status === "ready" ? selected.edit : null;
  const pages = edit?.present.pages ?? [];
  const selectedIds = edit?.present.selectedIds ?? [];
  const selectedCount = selectedIds.length;
  const singlePageIndex = selectedCount === 1 ? pages.findIndex((page) => page.id === selectedIds[0]) : -1;
  const singleEditPage = pages[singlePageIndex];
  const selectedPage = singleEditPage && selected
    ? getEditedPageInfo(singleEditPage, selected.pages[singleEditPage.sourcePageNumber - 1], singlePageIndex + 1)
    : undefined;
  const hasChanges = state.files.some((file) => file.status === "ready" && file.edit && isEdited(file.edit, file.pages));
  const selectedChanged = Boolean(edit && selected && isEdited(edit, selected.pages));
  const readyCount = state.files.filter((file) => file.status === "ready").length;
  const pendingCount = state.files.filter(
    (file) => file.status !== "ready" && file.status !== "error",
  ).length;
  const workspaceBytes = state.files.reduce((sum, file) => sum + file.size, 0);

  useEffect(() => {
    if (scrollRoot.current) scrollRoot.current.scrollTop = 0;
  }, [state.selectedId]);

  useEffect(() => {
    if (!hasChanges) return;
    const warnBeforeClosing = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeClosing);
    return () => window.removeEventListener("beforeunload", warnBeforeClosing);
  }, [hasChanges]);

  const cancelPageDrag = () => {
    pageDrag.current = null;
    setDragPageId(null);
    setDropMarker(null);
  };

  const handleEditingKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!selected || selected.status !== "ready" || event.altKey || event.defaultPrevented || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') || !target.closest("[data-pdf-edit-context]")) return;
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (modifier && key === "z") {
      event.preventDefault();
      if (event.shiftKey) workspace.redo(selected.id);
      else workspace.undo(selected.id);
    } else if (modifier && key === "y" && !event.shiftKey) {
      event.preventDefault();
      workspace.redo(selected.id);
    } else if (target.closest(".pdf-pages-scroll")) {
      if (modifier && key === "a") {
        event.preventDefault();
        workspace.selectAllPages(selected.id);
      } else if (!modifier && key === "escape") {
        event.preventDefault();
        cancelPageDrag();
        workspace.clearPageSelection(selected.id);
      } else if (!modifier && key === "delete") {
        event.preventDefault();
        // The focused tile may be removed. Keep subsequent Undo inside the editor.
        scrollRoot.current?.focus();
        workspace.deleteSelectedPages(selected.id);
      }
    }
  };

  const pageDropPosition = (event: DragEvent<HTMLButtonElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientX >= bounds.left + bounds.width / 2;
  };

  const openFilePicker = () => input.current?.click();

  return (
    <div className="page pdf-editor-page">
      <header className="pdf-editor-header">
        <div>
          <div className="eyebrow">YOUR DOCUMENT WORKSPACE / PDF EDITOR</div>
          <div className="pdf-editor-title">
            <h1>PDF 页面管理</h1>
            <span className="pdf-preview-badge">本地编辑</span>
          </div>
          <p>把每一页，安排妥当。选择、排序与旋转，原始文件保持不变。</p>
        </div>
        <div className="pdf-header-actions">
          <Button
            variant="outline"
            disabled={selected?.status !== "ready" || pages.length === 0 || outputBusy}
            aria-expanded={exportOpen && selected?.status === "ready"}
            onClick={() => setPanel("current")}
          >
            <Download size={15} />导出 PDF
          </Button>
          <Button
            variant="outline"
            disabled={state.files.length === 0}
            onClick={() => workspace.clear()}
          >
            <Trash2 size={15} />
            清空工作区
          </Button>
          <Button onClick={openFilePicker}>
            <Plus size={17} />
            添加 PDF
          </Button>
        </div>
      </header>

      <input
        ref={input}
        className="sr-only"
        type="file"
        multiple
        accept=".pdf,application/pdf"
        tabIndex={-1}
        aria-label="导入 PDF 文件"
        onChange={(event) => {
          workspace.addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />

      {state.notice && (
        <div className="pdf-import-notice" role="alert">
          <AlertCircle size={17} />
          <p>{state.notice}</p>
          <Button
            variant="ghost"
            size="icon"
            aria-label="关闭 PDF 导入提示"
            onClick={() => workspace.dismissNotice()}
          >
            <X size={15} />
          </Button>
        </div>
      )}

      <div
        className={`pdf-workbench ${dragging ? "is-dragging" : ""}`}
        onKeyDown={handleEditingKeys}
        onDragEnter={(event) => {
          if (!Array.from(event.dataTransfer.types).includes("Files")) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => {
          if (!Array.from(event.dataTransfer.types).includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          if (!Array.from(event.dataTransfer.types).includes("Files")) return;
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(event) => {
          if (!Array.from(event.dataTransfer.types).includes("Files")) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          workspace.addFiles(Array.from(event.dataTransfer.files));
        }}
      >
        {dragging && (
          <div className="pdf-drop-overlay">
            <Upload size={30} />
            <strong>松开鼠标，添加 PDF</strong>
            <span>文件仅在当前浏览器中读取与预览</span>
          </div>
        )}

        <section className="pdf-files-panel" aria-label="PDF 文件列表">
          <div className="pdf-panel-heading">
            <h2>文档 <span>{state.files.length}</span></h2>
            <Button
              variant="ghost"
              size="icon"
              aria-label="添加更多 PDF"
              title="添加更多 PDF"
              onClick={openFilePicker}
            >
              <FilePlus2 size={17} />
            </Button>
          </div>
          <div className="pdf-files-scroll">
            {state.files.length === 0 ? (
              <div className="pdf-list-empty">
                <Files size={27} strokeWidth={1.4} />
                <strong>从一份文档开始</strong>
                <p>导入的 PDF 会出现在这里。<br />可以同时管理多个文件。</p>
              </div>
            ) : (
              <ul className="pdf-file-list">
                {state.files.map((file) => (
                  <li
                    key={file.id}
                    className={`pdf-file-row ${file.id === state.selectedId ? "is-selected" : ""} ${file.status === "error" ? "has-error" : ""}`}
                  >
                    <button
                      type="button"
                      className="pdf-file-select"
                      aria-pressed={file.id === state.selectedId}
                      aria-label={`查看 ${file.name}（文件 ${file.ordinal}）`}
                      onClick={() => workspace.selectFile(file.id)}
                    >
                      <span className="pdf-file-symbol"><FileText size={21} strokeWidth={1.6} /></span>
                      <span className="pdf-file-copy">
                        <strong title={file.name}>{file.name}</strong>
                        <span className="pdf-file-meta">
                          {formatPdfBytes(file.size)}
                          {file.status === "ready" && <> · {file.edit?.present.pages.length ?? file.pages.length} 页</>}
                        </span>
                        <span className={`pdf-file-state state-${file.status}`}>
                          {file.status === "ready" ? <Check size={11} /> : file.status === "error" ? <AlertCircle size={11} /> : <LoaderCircle size={11} className="pdf-spinner" />}
                          {statusLabels[file.status]}
                          <span className="pdf-document-number">#{String(file.ordinal).padStart(2, "0")}</span>
                        </span>
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="pdf-remove-file"
                      aria-label={`移除 ${file.name}（文件 ${file.ordinal}）`}
                      title="移除文件"
                      onClick={() => workspace.removeFile(file.id)}
                    >
                      <X size={14} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="pdf-files-footer">
            <div><span>已添加容量</span><strong>{formatPdfBytes(workspaceBytes)}</strong></div>
            <p>最多 {MAX_PDF_FILES} 个文件 · 累计 {formatPdfBytes(MAX_WORKSPACE_BYTES)}</p>
          </div>
        </section>

        <section className="pdf-preview-panel" aria-label="PDF 页面预览" data-pdf-edit-context>
          <div className="pdf-panel-heading pdf-preview-heading">
            <div>
              <LayoutGrid size={15} />
              <h2>{selected ? "页面编辑" : "预览工作区"}</h2>
              {selected?.status === "ready" && <span className="pdf-page-total">{pages.length} 页 · 已选 {selectedCount} 页</span>}
            </div>
            <span className="pdf-preview-hint">本地浏览器处理</span>
          </div>
          {selected?.status === "ready" && (
            <div className="pdf-edit-toolbar" role="toolbar" aria-label="页面编辑工具栏">
              <Button variant="ghost" size="icon" aria-label="撤销" title="撤销 (Ctrl / ⌘ Z)" disabled={!edit?.past.length} onClick={() => workspace.undo(selected.id)}><Undo2 size={16} /></Button>
              <Button variant="ghost" size="icon" aria-label="重做" title="重做 (Ctrl Y / ⌘ ⇧ Z)" disabled={!edit?.future.length} onClick={() => workspace.redo(selected.id)}><Redo2 size={16} /></Button>
              <span className="pdf-toolbar-divider" />
              <Button variant="ghost" size="icon" aria-label="顺时针旋转 90°" title="顺时针旋转 90°" disabled={!selectedCount} onClick={() => workspace.rotateSelectedPages(selected.id, 90)}><RotateCw size={16} /></Button>
              <Button variant="ghost" size="icon" aria-label="删除选中页面" title="删除选中页面 (Delete)" disabled={!selectedCount} onClick={() => workspace.deleteSelectedPages(selected.id)}><Trash2 size={16} /></Button>
              <span className="pdf-selection-hint" id="pdf-selection-help">Ctrl / ⌘ 多选 · Shift 连选</span>
            </div>
          )}
          <div ref={scrollRoot} className="pdf-pages-scroll" tabIndex={0} aria-label="页面缩略图滚动区域">
            {!selected ? (
              <div className="pdf-workspace-empty">
                <div className="pdf-empty-symbol"><Upload size={30} strokeWidth={1.4} /></div>
                <h2>放入 PDF，让页面呈现。</h2>
                <p>拖放文件到工作区，或从电脑中选择。<br />支持同时导入多个 PDF。</p>
                <Button onClick={openFilePicker}><Plus size={16} />选择 PDF</Button>
                <div className="pdf-empty-limits">
                  <span>单文件 ≤ {formatPdfBytes(MAX_PDF_FILE_BYTES)}</span>
                  <span>最多 {MAX_PDF_FILES} 个 · 累计 ≤ {formatPdfBytes(MAX_WORKSPACE_BYTES)}</span>
                  <span>每份文档最多 {MAX_PDF_PAGES.toLocaleString("zh-CN")} 页</span>
                </div>
              </div>
            ) : selected.status === "ready" ? (
              <div className="pdf-thumbnail-grid" key={selected.id}>
                {pages.map((editPage, index) => (
                  <PdfThumbnail
                    key={editPage.id}
                    workspace={workspace}
                    documentId={selected.id}
                    page={getEditedPageInfo(editPage, selected.pages[editPage.sourcePageNumber - 1], index + 1)}
                    sourcePageNumber={editPage.sourcePageNumber}
                    rotationDelta={editPage.rotationDelta}
                    selected={selectedIds.includes(editPage.id)}
                    onSelect={(event) => workspace.selectPage(selected.id, index + 1, {
                      toggle: event.ctrlKey || event.metaKey, range: event.shiftKey,
                    })}
                    scrollRoot={scrollRoot}
                    tileProps={{
                      draggable: selectedCount <= 1,
                      "aria-describedby": "pdf-selection-help",
                      className: `${dragPageId === editPage.id ? "is-page-dragging" : ""} ${dropMarker?.pageId === editPage.id ? dropMarker.after ? "drop-after" : "drop-before" : ""}`,
                      onDragStart: (event) => {
                        if (selectedCount > 1) { event.preventDefault(); return; }
                        pageDrag.current = { documentId: selected.id, pageId: editPage.id };
                        setDragPageId(editPage.id);
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("application/x-pagenest-page", editPage.id);
                        workspace.selectPage(selected.id, index + 1);
                      },
                      onDragOver: (event) => {
                        if (pageDrag.current?.documentId !== selected.id || selectedCount > 1) return;
                        event.preventDefault();
                        event.stopPropagation();
                        event.dataTransfer.dropEffect = "move";
                        setDropMarker({ pageId: editPage.id, after: pageDropPosition(event) });
                      },
                      onDragLeave: (event) => {
                        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropMarker(null);
                      },
                      onDrop: (event) => {
                        const drag = pageDrag.current;
                        if (!drag || drag.documentId !== selected.id) return;
                        event.preventDefault();
                        event.stopPropagation();
                        const from = pages.findIndex((page) => page.id === drag.pageId);
                        if (from < 0 || selectedCount !== 1 || selectedIds[0] !== drag.pageId) {
                          cancelPageDrag();
                          return;
                        }
                        const insertion = index + (pageDropPosition(event) ? 1 : 0);
                        workspace.movePage(selected.id, drag.pageId, insertion > from ? insertion - 1 : insertion);
                        cancelPageDrag();
                      },
                      onDragEnd: cancelPageDrag,
                    }}
                  />
                ))}
              </div>
            ) : selected.status === "error" ? (
              <div className="pdf-workspace-message pdf-workspace-error" role="alert">
                <span className="pdf-message-symbol"><AlertCircle size={27} /></span>
                <h2>这份 PDF 暂时无法预览</h2>
                <p>{selected.error ?? "文件未能完成解析，请移除后重新选择。"}</p>
                <span className="pdf-message-note">其他已导入的文档不受影响。</span>
                <Button variant="outline" onClick={() => workspace.removeFile(selected.id)}>移除此文件</Button>
              </div>
            ) : (
              <div className="pdf-workspace-message" role="status">
                <span className="pdf-message-symbol"><LoaderCircle size={27} className="pdf-spinner" /></span>
                <h2>{statusLabels[selected.status]}</h2>
                <p>{selected.status === "queued" ? "正在等待前面的文档完成解析。" : "正在读取页面信息，请稍候。"}</p>
                <span className="pdf-message-note">你可以切换文档，或移除文件来取消。</span>
              </div>
            )}
          </div>
          <div className="pdf-preview-footer" aria-live="polite">
            <span>{readyCount} 份文档已就绪{pendingCount > 0 ? ` · ${pendingCount} 份正在导入` : ""}</span>
            <span>{selected?.status === "ready" ? selectedCount === 1 ? `已选择第 ${singlePageIndex + 1} 页` : `已选择 ${selectedCount} 页` : "按需加载页面预览"}</span>
          </div>
        </section>

        <aside className="pdf-info-panel" aria-label="文档与页面信息" data-pdf-edit-context>
          <div className="pdf-panel-heading"><h2>检查器</h2><FileText size={16} /></div>
          <div className="pdf-info-scroll">
            {(panel === "current" || panel === "selection") && selected?.status === "ready" && (
              <PdfExportPanel key={`${selected.id}:${panel}`} file={selected} scope={panel} controller={workspace.exporter} externalBusy={operationTask.busy} onClose={() => setPanel(null)} />
            )}
            {(panel === "merge" && readyCount > 0 || panel === "split" && selected?.status === "ready") && (
              <PdfOperationPanel key={panel === "merge" ? "merge" : `${state.selectedId}:${panel}`} files={state.files} selectedId={state.selectedId} mode={panel as "merge" | "split"} controller={workspace.operations} externalBusy={exportTask.busy} onClose={() => setPanel(null)} />
            )}
            <section className="pdf-info-section">
              <h3>文档信息</h3>
              {selected ? (
                <>
                  <div className="pdf-info-filename"><FileText size={19} /><strong>{selected.name}</strong></div>
                  <dl>
                    <div><dt>文档编号</dt><dd>#{String(selected.ordinal).padStart(2, "0")}</dd></div>
                    <div><dt>文件大小</dt><dd>{formatPdfBytes(selected.size)}</dd></div>
                    <div><dt>当前页数</dt><dd>{selected.status === "ready" ? `${pages.length} 页` : "—"}</dd></div>
                    {selectedChanged && <div><dt>原始页数</dt><dd>{selected.pages.length} 页</dd></div>}
                    <div><dt>解析状态</dt><dd className={`state-${selected.status}`}>{statusLabels[selected.status]}</dd></div>
                  </dl>
                </>
              ) : <p className="pdf-info-placeholder">导入 PDF 后，在这里查看文档详情。</p>}
            </section>

            <section className="pdf-info-section">
              <h3>{selectedCount > 1 ? "多页选择" : "页面信息"}</h3>
              {selectedPage ? (
                <>
                  <div className="pdf-selected-page-number">{String(selectedPage.number).padStart(2, "0")}<span>当前页面</span></div>
                  <dl>
                    <div><dt>页面宽度</dt><dd>{numberFormat.format(selectedPage.width)} pt</dd></div>
                    <div><dt>页面高度</dt><dd>{numberFormat.format(selectedPage.height)} pt</dd></div>
                    <div><dt>页面方向</dt><dd>{{ portrait: "纵向", landscape: "横向", square: "方形" }[selectedPage.orientation]}</dd></div>
                    <div><dt>来源页码</dt><dd>原第 {singleEditPage.sourcePageNumber} 页</dd></div>
                    <div><dt>显示旋转</dt><dd>{selectedPage.rotation}°</dd></div>
                  </dl>
                  <p className="pdf-dimension-note">约 {numberFormat.format(selectedPage.width * 25.4 / 72)} × {numberFormat.format(selectedPage.height * 25.4 / 72)} mm</p>
                </>
              ) : selectedCount > 1 ? <p className="pdf-multi-selection">已选中 <strong>{selectedCount}</strong> 页，可批量删除或旋转。</p> : <p className="pdf-info-placeholder">选择页面，查看尺寸与方向。</p>}
              {selected?.status === "ready" && (
                <div className="pdf-edit-actions" role="group" aria-label="选中页面操作">
                  <Button variant="outline" size="sm" disabled={!selectedCount} aria-label="逆时针旋转 90°" onClick={() => workspace.rotateSelectedPages(selected.id, -90)}><RotateCcw size={14} />左转 90°</Button>
                  <Button variant="outline" size="sm" disabled={!selectedCount} aria-label="批量顺时针旋转 90°" onClick={() => workspace.rotateSelectedPages(selected.id, 90)}><RotateCw size={14} />右转 90°</Button>
                  <Button variant="outline" size="sm" disabled={singlePageIndex <= 0} aria-label="向前移动一页" onClick={() => workspace.moveSelectedPage(selected.id, -1)}><ArrowLeft size={14} />向前移</Button>
                  <Button variant="outline" size="sm" disabled={singlePageIndex < 0 || singlePageIndex === pages.length - 1} aria-label="向后移动一页" onClick={() => workspace.moveSelectedPage(selected.id, 1)}><ArrowRight size={14} />向后移</Button>
                  <Button variant="outline" size="sm" className="pdf-delete-action" disabled={!selectedCount} aria-label="批量删除选中页面" onClick={() => workspace.deleteSelectedPages(selected.id)}><Trash2 size={14} />删除所选</Button>
                  <Button variant="outline" size="sm" className="pdf-selection-export-action" disabled={!selectedCount || outputBusy} aria-expanded={panel === "selection"} onClick={() => setPanel("selection")}><Download size={14} />导出选中页面</Button>
                  <p>仅支持单页拖拽排序。多选时请先单击一页；也可使用向前移、向后移。</p>
                </div>
              )}
            </section>

            <section className="pdf-info-section pdf-output-section" aria-label="PDF 输出操作">
              <h3>合并与拆分</h3>
              <div className="pdf-output-actions">
                <Button variant="outline" size="sm" disabled={selected?.status !== "ready" || !pages.length || outputBusy} aria-expanded={panel === "split"} onClick={() => setPanel("split")}><Scissors size={14} />拆分</Button>
                <Button variant="outline" size="sm" disabled={readyCount < 2 || outputBusy} aria-expanded={panel === "merge"} onClick={() => setPanel("merge")}><Files size={14} />合并</Button>
              </div>
              <p>按当前编辑后的页面顺序处理。合并至少需要两份已就绪文档；拆分会先预览输出计划。</p>
            </section>
          </div>
        </aside>
      </div>

      {hasChanges && <p className="pdf-unsaved-note" role="status">当前修改仅保存在浏览器工作区。请导出 PDF 以保留当前结果，后续修改需再次导出。离开此页、移除文档或清空工作区后，会话修改将丢失。</p>}

      <footer className="pdf-local-note">
        <ShieldCheck size={14} />
        <p>文件只在当前浏览器内读取、解析与渲染，不上传、不持久化。离开此页或刷新后，PDF 工作区将清空。</p>
        <span>单文件 ≤ {formatPdfBytes(MAX_PDF_FILE_BYTES)} · 每份文档 ≤ {MAX_PDF_PAGES.toLocaleString("zh-CN")} 页</span>
      </footer>
    </div>
  );
}
