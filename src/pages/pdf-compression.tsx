import { useRef, useState } from "react";
import { AlertCircle, Check, Download, FileArchive, FileText, FolderOpen, LoaderCircle, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { usePdfCompression } from "../compression/use-compression";
import { COMPRESSION_MODES, MAX_COMPRESSION_FILES, type CompressionMode, type CompressionRow, type CompressionStatus } from "../compression/types";
import { formatPdfBytes } from "../pdf/types";
import "./pdf-compression.css";

const modes: Record<CompressionMode, { name: string; description: string; detail: string }> = {
  lossless: { name: "无损优化", description: "优化 PDF 结构与 Flate 流，不降低图片质量。", detail: "内容保持型优化，不等于字节级无损。不主动删除作者、书签或元数据；重写文档仍可能影响特殊结构。" },
  high: { name: "高质量", description: "JPEG 质量参数 0.88，优先保留细节。", detail: "有损图像优化，仅重编码支持的嵌入 JPEG，不降低像素尺寸。文字、OCR 文字层和非目标矢量仍需严格验证。" },
  balanced: { name: "均衡压缩", description: "JPEG 质量参数 0.72，平衡清晰度与体积。", detail: "有损图像优化，仅重编码支持的嵌入 JPEG，不降低像素尺寸。文字、OCR 文字层和非目标矢量仍需严格验证。" },
  strong: { name: "较强压缩", description: "JPEG 质量参数 0.50，图像细节损失更明显。", detail: "有损图像优化，仅重编码支持的嵌入 JPEG，不降低像素尺寸。请保留原件，并重点复核小字、细线与图片细节。" },
};
const statusLabels: Record<CompressionStatus, string> = {
  queued: "等待处理", reading: "读取中", optimizing: "优化中", validating: "验证中", ready: "下载就绪",
  "no-benefit": "无压缩收益", error: "处理失败", cancelled: "已取消",
};
const processing = (row: CompressionRow) => ["reading", "optimizing", "validating"].includes(row.status);
const percent = (value: number) => `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value)}%`;

export function PdfCompression() {
  const { controller, state } = usePdfCompression();
  const input = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const activeRow = state.files.find(processing);
  const sourceBytes = state.files.reduce((total, row) => total + row.size, 0);
  const canStart = state.files.length > 0 && !state.busy && state.availableModes.includes(state.mode);
  const addDisabled = state.files.length >= MAX_COMPRESSION_FILES;

  return (
    <div className="page compression-page">
      <header className="compression-header">
        <div>
          <div className="eyebrow">YOUR DOCUMENT WORKSPACE / COMPRESSION</div>
          <div className="compression-title"><h1>文件压缩</h1><span>PDF 本地处理</span></div>
          <p>让 PDF 轻一点。保留原件，按需要选择内容保持优化或有损图像压缩。</p>
        </div>
        <div className="compression-header-actions">
          <Button variant="outline" disabled={!state.files.length} onClick={() => controller.clear()}><Trash2 size={15} />清空列表</Button>
          <Button disabled={addDisabled} onClick={() => input.current?.click()}><FolderOpen size={15} />添加 PDF</Button>
        </div>
      </header>

      {state.notice && <div className="compression-notice" role="status"><AlertCircle size={17} /><p>{state.notice}</p>
        <Button variant="ghost" size="icon" aria-label="关闭压缩提示" onClick={() => controller.dismissNotice()}><X size={15} /></Button>
      </div>}

      <div className="compression-grid">
        <div className="compression-main">
          <section className={`compression-import ${dragging ? "is-dragging" : ""}`} aria-label="PDF 压缩文件输入"
            onDragEnter={(event) => { if (!Array.from(event.dataTransfer.types).includes("Files")) return; event.preventDefault(); depth.current++; setDragging(true); }}
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
            onDragLeave={(event) => { event.preventDefault(); depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false); }}
            onDrop={(event) => { event.preventDefault(); depth.current = 0; setDragging(false); controller.addFiles(Array.from(event.dataTransfer.files)); }}>
            <span className="compression-upload-symbol"><Upload size={23} strokeWidth={1.5} /></span>
            <div><h2>{dragging ? "松开鼠标，添加 PDF" : "放入 PDF，看看还能轻多少。"}</h2><p>拖放文件到此处，或从电脑中选择。</p></div>
            <Button variant="outline" disabled={addDisabled} onClick={() => input.current?.click()}>选择 PDF</Button>
            <input ref={input} type="file" accept="application/pdf,.pdf" multiple className="sr-only" tabIndex={-1} aria-label="选择压缩 PDF 文件"
              onChange={(event) => { controller.addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
            <p className="compression-input-limits">单份 ≤ 32 MiB · 最多 5 份 · 累计 ≤ 96 MiB · 每份 ≤ 200 页</p>
          </section>

          <section className="compression-files" aria-label="压缩文件列表">
            <div className="compression-section-heading"><h2>文件与结果 <span>{state.files.length}</span></h2><span>{formatPdfBytes(sourceBytes)} / 96 MiB</span></div>
            {!state.files.length ? <div className="compression-empty"><FileArchive size={33} strokeWidth={1.2} /><h3>从一份 PDF 开始。</h3><p>处理后会在这里显示真实大小、内容验证结果与下载入口。<br />不是每份 PDF 都能变得更小。</p></div> :
              <ol className="compression-file-list">{state.files.map((row) => <li key={row.id} className="compression-file-card" data-status={row.status} aria-label={`${row.name}（文件 ${row.ordinal}）`}>
                <div className="compression-file-heading"><FileText size={21} strokeWidth={1.5} /><div><h3 title={row.name}>{row.name}</h3><p>#{String(row.ordinal).padStart(2, "0")} · {row.pageCount === null ? "页数待读取" : `${row.pageCount} 页`}</p></div>
                  <span className="compression-status" role="status">{processing(row) ? <LoaderCircle size={13} className="compression-spinner" /> : row.status === "ready" ? <Check size={13} /> : null}{statusLabels[row.status]}</span>
                  <Button variant="ghost" size="icon" aria-label={`移除 ${row.name}（文件 ${row.ordinal}）`} onClick={() => controller.removeFile(row.id)}><X size={15} /></Button>
                </div>
                <dl className="compression-statistics">
                  <div><dt>原始大小</dt><dd>{formatPdfBytes(row.size)}</dd></div>
                  <div><dt>输出大小</dt><dd>{row.result ? formatPdfBytes(row.result.outputBytes) : "—"}</dd></div>
                  <div><dt>{row.result && row.result.savedBytes < 0 ? "增加空间" : "节省空间"}</dt><dd>{row.result ? formatPdfBytes(Math.abs(row.result.savedBytes)) : "—"}</dd></div>
                  <div><dt>压缩比例</dt><dd className={row.status === "ready" ? "has-savings" : ""}>{row.result ? percent(row.result.reductionPercent) : "—"}</dd></div>
                </dl>
                {row.status === "no-benefit" && <p className="compression-no-benefit">此 PDF 已较为紧凑，本次优化未获得更小的文件。</p>}
                {row.error && <p className="compression-file-error" role="alert"><AlertCircle size={14} />{row.error}</p>}
                {row.result && <div className="compression-result-details"><p><ShieldCheck size={13} />{row.result.validationLabel}</p><ul aria-label={`${row.name}（文件 ${row.ordinal}）实际执行方法`}>{row.result.methods.map((method) => <li key={method}>{method}</li>)}</ul>
                  {(state.mode !== "lossless" || row.result.changedImages > 0 || row.result.skippedImages > 0) && <p>已优化图像 {row.result.changedImages} 个 · 跳过图像 {row.result.skippedImages} 个</p>}</div>}
                <div className="compression-row-actions">
                  {processing(row) && <Button variant="outline" size="sm" aria-label={`取消 ${row.name}（文件 ${row.ordinal}）`} onClick={() => controller.cancel(row.id)}>取消此文件</Button>}
                  {!state.busy && row.status !== "queued" && <Button variant="ghost" size="sm" aria-label={`重新处理 ${row.name}（文件 ${row.ordinal}）`} onClick={() => { void controller.start(row.id); }}>重新处理</Button>}
                  {row.status === "ready" && row.result && <Button size="sm" aria-label={`下载 ${row.result.fileName}（文件 ${row.ordinal}）`} onClick={() => controller.download(row.id)}><Download size={14} />下载 PDF</Button>}
                </div>
              </li>)}</ol>}
          </section>
        </div>

        <aside className="compression-settings" aria-label="PDF 压缩设置">
          <div className="compression-settings-heading"><h2>压缩设置</h2><FileArchive size={17} /></div>
          <fieldset disabled={state.busy}><legend>选择处理方式</legend>
            {COMPRESSION_MODES.map((mode) => <label className={`compression-mode ${state.mode === mode ? "is-selected" : ""}`} key={mode}>
              <input type="radio" name="compression-mode" value={mode} checked={state.mode === mode} disabled={!state.availableModes.includes(mode)} onChange={() => controller.setMode(mode)} />
              <span><strong>{modes[mode].name}<small>{mode === "lossless" ? "内容保持" : "图像有损"}</small></strong><span>{modes[mode].description}</span>{!state.availableModes.includes(mode) && <em>此浏览器不可用</em>}</span>
            </label>)}
          </fieldset>
          <p className="compression-mode-detail">{modes[state.mode].detail}</p>
          {!state.availableModes.length && <p className="compression-support-error" role="alert">当前浏览器缺少本地 Worker 或压缩流 API，请使用支持这些能力的现代浏览器。</p>}
          <div className="compression-task-status" role="status" aria-live="polite">{state.busy ? <><LoaderCircle size={15} className="compression-spinner" /><span>{activeRow ? `正在逐份处理 · #${String(activeRow.ordinal).padStart(2, "0")} ${statusLabels[activeRow.status]}` : "正在停止处理，等待底层任务释放。"}</span></> : <><ShieldCheck size={15} /><span>原生浏览器 API · 本地 Worker</span></>}</div>
          <Button className="compression-start" disabled={!canStart} onClick={() => { void controller.startAll(); }}>开始压缩</Button>
          {state.busy && <Button className="compression-stop" variant="outline" onClick={() => controller.cancel()}>停止本批</Button>}
          {state.busy && <p className="compression-small-note">停止会丢弃本页待下载结果。任务结束或安全停止前不能再次开始。</p>}
          <div className="compression-compatibility"><h3>兼容性与限制</h3><p>仅处理支持范围内的 PDF。检测到加密、数字签名、表单、附件或活动内容时会拒绝处理；其他复杂文档级结构不保证完全保留。</p><p>图像模式仅重编码安全的基线 RGB JPEG。特殊色彩、透明度或复杂图层可能跳过或拒绝；不将整页转为截图，不降低像素尺寸。</p><p>保留结果累计 ≤ 64 MiB。解码还受像素与流展开预算限制；较小的文件也可能因复杂度而被拒绝。</p><p>PPTX 压缩与 ZIP 批量下载尚未提供。</p></div>
        </aside>
      </div>
      <div className="compression-privacy"><ShieldCheck size={15} /><p>所有文件都在当前浏览器内处理，不会自动上传。原始文件保持不变。移除、清空、离开此页或刷新会释放本页文件与结果，请先下载需要保留的文件。</p></div>
    </div>
  );
}
