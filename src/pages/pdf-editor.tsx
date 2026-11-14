import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowDownUp,
  Check,
  FilePlus2,
  FileText,
  Files,
  LayoutGrid,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RotateCw,
  Scissors,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { PdfThumbnail } from "../components/pdf/thumbnail";
import { usePdfWorkspace } from "../pdf/use-pdf-workspace";
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

const futureActions = [
  { name: "拆分", icon: Scissors },
  { name: "合并", icon: Files },
  { name: "删除页面", icon: Trash2 },
  { name: "排序", icon: ArrowDownUp },
  { name: "旋转", icon: RotateCw },
];

const numberFormat = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 1,
});

export function PdfEditor() {
  const { state, workspace } = usePdfWorkspace();
  const input = useRef<HTMLInputElement>(null);
  const scrollRoot = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const selected = state.files.find((file) => file.id === state.selectedId);
  const selectedPage = selected?.pages.find(
    (page) => page.number === selected.selectedPage,
  );
  const readyCount = state.files.filter((file) => file.status === "ready").length;
  const pendingCount = state.files.filter(
    (file) => file.status !== "ready" && file.status !== "error",
  ).length;
  const workspaceBytes = state.files.reduce((sum, file) => sum + file.size, 0);

  useEffect(() => {
    if (scrollRoot.current) scrollRoot.current.scrollTop = 0;
  }, [state.selectedId]);

  const openFilePicker = () => input.current?.click();

  return (
    <div className="page pdf-editor-page">
      <header className="pdf-editor-header">
        <div>
          <div className="eyebrow">YOUR DOCUMENT WORKSPACE / PDF EDITOR</div>
          <div className="pdf-editor-title">
            <h1>PDF 页面管理</h1>
            <span className="pdf-preview-badge">本地预览</span>
          </div>
          <p>把每一页，看得清楚。导入 PDF，在这里浏览与选择。</p>
        </div>
        <div className="pdf-header-actions">
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
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(event) => {
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
                          {file.status === "ready" && <> · {file.pages.length} 页</>}
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

        <section className="pdf-preview-panel" aria-label="PDF 页面预览">
          <div className="pdf-panel-heading pdf-preview-heading">
            <div>
              <LayoutGrid size={15} />
              <h2>{selected ? "页面预览" : "预览工作区"}</h2>
              {selected?.status === "ready" && <span className="pdf-page-total">{selected.pages.length} 页</span>}
            </div>
            <span className="pdf-preview-hint">{selected?.status === "ready" ? "点击页面查看信息" : "本地浏览器处理"}</span>
          </div>
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
                {selected.pages.map((page) => (
                  <PdfThumbnail
                    key={`${selected.id}-${page.number}`}
                    workspace={workspace}
                    documentId={selected.id}
                    page={page}
                    selected={selected.selectedPage === page.number}
                    onSelect={() => workspace.selectPage(selected.id, page.number)}
                    scrollRoot={scrollRoot}
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
            <span>{selected?.status === "ready" ? `已选择第 ${selected.selectedPage} 页` : "按需加载页面预览"}</span>
          </div>
        </section>

        <aside className="pdf-info-panel" aria-label="文档与页面信息">
          <div className="pdf-panel-heading"><h2>检查器</h2><FileText size={16} /></div>
          <div className="pdf-info-scroll">
            <section className="pdf-info-section">
              <h3>文档信息</h3>
              {selected ? (
                <>
                  <div className="pdf-info-filename"><FileText size={19} /><strong>{selected.name}</strong></div>
                  <dl>
                    <div><dt>文档编号</dt><dd>#{String(selected.ordinal).padStart(2, "0")}</dd></div>
                    <div><dt>文件大小</dt><dd>{formatPdfBytes(selected.size)}</dd></div>
                    <div><dt>总页数</dt><dd>{selected.status === "ready" ? `${selected.pages.length} 页` : "—"}</dd></div>
                    <div><dt>解析状态</dt><dd className={`state-${selected.status}`}>{statusLabels[selected.status]}</dd></div>
                  </dl>
                </>
              ) : <p className="pdf-info-placeholder">导入 PDF 后，在这里查看文档详情。</p>}
            </section>

            <section className="pdf-info-section">
              <h3>页面信息</h3>
              {selectedPage ? (
                <>
                  <div className="pdf-selected-page-number">{String(selectedPage.number).padStart(2, "0")}<span>当前页面</span></div>
                  <dl>
                    <div><dt>页面宽度</dt><dd>{numberFormat.format(selectedPage.width)} pt</dd></div>
                    <div><dt>页面高度</dt><dd>{numberFormat.format(selectedPage.height)} pt</dd></div>
                    <div><dt>页面方向</dt><dd>{{ portrait: "纵向", landscape: "横向", square: "方形" }[selectedPage.orientation]}</dd></div>
                  </dl>
                  <p className="pdf-dimension-note">约 {numberFormat.format(selectedPage.width * 25.4 / 72)} × {numberFormat.format(selectedPage.height * 25.4 / 72)} mm</p>
                </>
              ) : <p className="pdf-info-placeholder">选择页面，查看尺寸与方向。</p>}
            </section>

            <section className="pdf-info-section pdf-future-section" aria-label="后续编辑功能">
              <h3>页面编辑 <LockKeyhole size={12} /></h3>
              <div className="pdf-future-actions">
                {futureActions.map((action) => (
                  <Button key={action.name} variant="outline" size="sm" disabled title="尚未实现" aria-describedby="pdf-editing-unavailable">
                    <action.icon size={14} />{action.name}
                  </Button>
                ))}
              </div>
              <p id="pdf-editing-unavailable">编辑功能尚未实现。当前仅支持导入、浏览和页面选择，不会修改或导出文件。</p>
            </section>
          </div>
        </aside>
      </div>

      <footer className="pdf-local-note">
        <ShieldCheck size={14} />
        <p>文件只在当前浏览器内读取、解析与渲染，不上传、不持久化。离开此页或刷新后，PDF 工作区将清空。</p>
        <span>单文件 ≤ {formatPdfBytes(MAX_PDF_FILE_BYTES)} · 每份文档 ≤ {MAX_PDF_PAGES.toLocaleString("zh-CN")} 页</span>
      </footer>
    </div>
  );
}
