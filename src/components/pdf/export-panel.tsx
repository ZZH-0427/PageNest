import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertCircle, Check, Download, LoaderCircle, X } from "lucide-react";
import { Button } from "../ui/button";
import {
  defaultExportFilename,
  PDF_EXPORT_COMPATIBILITY_NOTICE,
  sanitizePdfFilename,
} from "../../pdf/export";
import type { PdfExportController } from "../../pdf/export-controller";
import { formatPdfBytes, type PdfFileEntry } from "../../pdf/types";

interface Props {
  file: PdfFileEntry;
  controller: PdfExportController;
  onClose: () => void;
}

const stageLabels = {
  idle: "导出设置",
  preparing: "准备中",
  generating: "生成中",
  validating: "验证中",
  ready: "下载就绪",
  error: "导出失败",
  cancelling: "正在停止等待",
  downloaded: "已触发下载",
} as const;

/** Only lightweight task metadata enters this component; bytes and URLs stay in the controller. */
export function PdfExportPanel({ file, controller, onClose }: Props) {
  const task = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [filename, setFilename] = useState(() => defaultExportFilename(file.name));
  const [actionError, setActionError] = useState<string | null>(null);
  const filenameInput = useRef<HTMLInputElement>(null);
  const alive = useRef(false);
  const submitting = useRef(false);
  const belongsToFile = task.documentId === file.id;
  const stage = belongsToFile ? task.stage : task.busy ? "cancelling" : "idle";
  const pageCount = file.edit?.present.pages.length ?? 0;
  const safeFilename = sanitizePdfFilename(filename);
  const canGenerate = file.status === "ready" && pageCount > 0 && !task.busy;
  const error = actionError ?? (belongsToFile ? task.error : null);

  useEffect(() => {
    alive.current = true;
    filenameInput.current?.focus();
    return () => {
      alive.current = false;
      controller.cancel();
    };
  }, [controller]);

  const generate = () => {
    if (!canGenerate || submitting.current || controller.getSnapshot().busy) return;
    submitting.current = true;
    setActionError(null);
    void controller.start(file.id, safeFilename).catch(() => {
      if (alive.current) setActionError("无法完成导出，请重新生成或尝试较小的文档。");
    }).finally(() => { submitting.current = false; });
  };

  const download = () => {
    setActionError(null);
    try {
      controller.download();
    } catch {
      setActionError("未能触发下载，请检查浏览器下载设置后重试。");
    }
  };

  return (
    <section className="pdf-info-section pdf-export-panel" aria-label="PDF 导出设置">
      <h3>导出 PDF
        <Button type="button" variant="ghost" size="icon" aria-label="关闭导出设置" onClick={onClose}><X size={14} /></Button>
      </h3>
      <p className="pdf-export-source" title={file.name}>{file.name}</p>
      <dl>
        <div><dt>原文件大小</dt><dd>{formatPdfBytes(file.size)}</dd></div>
        <div><dt>当前保留页数</dt><dd>{pageCount} 页</dd></div>
        <div><dt>格式</dt><dd>PDF</dd></div>
      </dl>
      <form onSubmit={(event) => { event.preventDefault(); generate(); }}>
        <label htmlFor="pdf-export-filename">导出文件名</label>
        <input
          ref={filenameInput}
          id="pdf-export-filename"
          type="text"
          value={filename}
          maxLength={240}
          autoComplete="off"
          spellCheck={false}
          disabled={task.busy || stage === "ready"}
          aria-describedby="pdf-export-name-note"
          onChange={(event) => setFilename(event.target.value)}
        />
        <p className="pdf-export-name-note" id="pdf-export-name-note">下载名称：<span>{safeFilename}</span></p>
        <p className="pdf-export-note">导出当前文档的全部保留页面，不按页面选区裁剪。工作区修改仍在本次会话内；生成文件采用点击生成时的编辑结果，后续修改需重新生成。</p>
        <div className="pdf-export-compatibility">
          <strong>兼容性说明</strong>
          <p>{PDF_EXPORT_COMPATIBILITY_NOTICE}</p>
          <p>特殊结构未逐项检测，请核验导出文件。不要将导出结果视为严格无损副本。</p>
        </div>
        <div className="pdf-export-status" role="status" aria-live="polite" aria-atomic="true">
          {task.busy ? <LoaderCircle size={15} className="pdf-spinner" /> : stage === "ready" || stage === "downloaded" ? <Check size={15} /> : null}
          <strong>{error ? "导出失败" : stageLabels[stage]}</strong>
          {belongsToFile && task.stage !== "idle" && <span>本次生成 {task.pageCount} 页 · {task.fileName}</span>}
          {stage === "ready" && <p>验证已完成。点击下载，由浏览器处理保存。</p>}
          {stage === "downloaded" && <p>已生成 PDF 并触发下载。请检查浏览器下载列表；无法确认文件已保存到磁盘。</p>}
          {stage === "cancelling" && <p>已请求丢弃结果，等待当前处理阶段结束。结束前不能开始另一项导出。</p>}
        </div>
        {error && <p className="pdf-export-error" role="alert"><AlertCircle size={14} />{error}</p>}
        <div className="pdf-export-actions">
          <Button type="submit" size="sm" disabled={!canGenerate}>
            {stage === "ready" || stage === "downloaded" ? "重新生成 PDF" : "生成 PDF"}
          </Button>
          {stage === "ready" && <Button type="button" size="sm" onClick={download}><Download size={14} />下载 PDF</Button>}
          {task.busy && <Button type="button" size="sm" variant="outline" disabled={stage === "cancelling"} onClick={() => controller.cancel()}>停止等待</Button>}
        </div>
      </form>
      <p className="pdf-export-note">关闭面板、切换文档或清空工作区会丢弃待下载结果。停止等待不会立即中断底层保存计算；任务会在可安全停止的阶段释放临时数据。</p>
    </section>
  );
}
