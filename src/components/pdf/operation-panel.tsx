import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertCircle, ArrowDown, ArrowUp, Check, Download, LoaderCircle, X } from "lucide-react";
import { Button } from "../ui/button";
import { PDF_EXPORT_COMPATIBILITY_NOTICE } from "../../pdf/export";
import { buildMergePlan, buildSplitPlan, type PdfOutputPlan } from "../../pdf/output-plan";
import type { PdfOperationController } from "../../pdf/operation-controller";
import { formatPdfBytes, PdfUserError, type PdfFileEntry } from "../../pdf/types";

interface Props {
  files: PdfFileEntry[];
  selectedId: string | null;
  controller: PdfOperationController;
  mode: "merge" | "split";
  externalBusy?: boolean;
  onClose: () => void;
}

const stages = { idle: "输出设置", preparing: "准备中", generating: "生成中", validating: "校验中", ready: "下载就绪", error: "处理失败", cancelling: "正在停止等待" } as const;

/** React holds plans and result metadata only; bytes and Blob URLs belong to the controller. */
export function PdfOperationPanel({ files, selectedId, controller, mode, externalBusy = false, onClose }: Props) {
  const task = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const current = files.find((file) => file.id === selectedId);
  const [chosenIds, setChosenIds] = useState(() => files.filter((file) => file.status === "ready").map((file) => file.id));
  const [filename, setFilename] = useState(() => mode === "merge" ? "merged.pdf" : (current?.name.replace(/\.pdf$/i, "") || "document"));
  const [splitKind, setSplitKind] = useState<"ranges" | "every">("ranges");
  const [ranges, setRanges] = useState(() => `1-${current?.edit?.present.pages.length ?? 1}`);
  const [every, setEvery] = useState("5");
  const [actionError, setActionError] = useState<string | null>(null);
  const [submittedPlan, setSubmittedPlan] = useState<PdfOutputPlan | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(false);
  const submitting = useRef(false);
  const blocked = task.busy || externalBusy;
  const selectedIds = chosenIds.filter((id) => files.some((file) => file.id === id && file.status === "ready"));
  const orderedFiles = [...selectedIds.map((id) => files.find((file) => file.id === id)!), ...files.filter((file) => !selectedIds.includes(file.id))];
  let plan: PdfOutputPlan | null = null;
  let planError: string | null = null;
  try {
    if (mode === "merge") plan = buildMergePlan(files, selectedIds, filename);
    else if (current) plan = buildSplitPlan(current, splitKind === "ranges" ? { kind: "ranges", ranges } : { kind: "every", every: Number(every) }, filename);
    else planError = "请先选择一份已就绪的 PDF。";
  } catch (error) { planError = error instanceof PdfUserError ? error.message : "无法建立输出计划，请检查文档与页码范围。"; }
  const showingSubmitted = task.busy || task.stage === "ready";
  const preview = showingSubmitted ? submittedPlan : plan;
  const sourceKey = mode === "merge" ? "merge" : selectedId;
  const error = actionError ?? task.error;

  useEffect(() => {
    alive.current = true;
    input.current?.focus();
    return () => { alive.current = false; controller.cancel(); };
  }, [controller, mode, sourceKey]);

  const change = (update: () => void) => {
    if (blocked) return;
    controller.cancel();
    setActionError(null);
    setSubmittedPlan(null);
    update();
  };
  const move = (id: string, direction: -1 | 1) => change(() => {
    const index = selectedIds.indexOf(id), next = index + direction;
    if (index < 0 || next < 0 || next >= selectedIds.length) return;
    const order = [...selectedIds];
    [order[index], order[next]] = [order[next], order[index]];
    setChosenIds(order);
  });
  const generate = () => {
    if (!plan || blocked || submitting.current || controller.getSnapshot().busy) return;
    submitting.current = true;
    setActionError(null);
    setSubmittedPlan(plan);
    void controller.start(plan).catch(() => {
      if (alive.current) setActionError("无法完成 PDF 处理，请检查设置后重试。");
    }).finally(() => { submitting.current = false; });
  };
  const download = (id: string) => {
    setActionError(null);
    try { controller.download(id); }
    catch { setActionError("未能触发下载，请检查浏览器下载设置后重试。"); }
  };

  return (
    <section className="pdf-info-section pdf-export-panel pdf-operation-panel" aria-label={mode === "merge" ? "PDF 合并设置" : "PDF 拆分设置"}>
      <h3>{mode === "merge" ? "合并 PDF" : "拆分 PDF"}<Button type="button" variant="ghost" size="icon" aria-label="关闭 PDF 处理设置" onClick={onClose}><X size={14} /></Button></h3>
      <form onSubmit={(event) => { event.preventDefault(); generate(); }}>
        {mode === "merge" ? <>
          <p className="pdf-export-note">勾选至少两份文档。按下方文档顺序合并，保留各文档当前的删页、排序与旋转。</p>
          <ol className="pdf-operation-documents" aria-label="合并文档顺序">
            {orderedFiles.map((file) => {
              const index = selectedIds.indexOf(file.id);
              const label = `${file.name}（文件 ${file.ordinal}）`;
              return <li key={file.id}>
                <label><input type="checkbox" checked={index >= 0} disabled={blocked || file.status !== "ready"} aria-label={`合并 ${label}`}
                  onChange={(event) => change(() => setChosenIds(event.target.checked ? [...selectedIds, file.id] : selectedIds.filter((id) => id !== file.id)))} />
                  <span><strong title={file.name}>{file.name}</strong><small>#{file.ordinal} · {file.status === "ready" ? `${file.edit?.present.pages.length ?? 0} 页` : "未就绪"}</small></span></label>
                <div><Button type="button" variant="ghost" size="icon" aria-label={`${label}上移`} disabled={blocked || index <= 0} onClick={() => move(file.id, -1)}><ArrowUp size={13} /></Button>
                  <Button type="button" variant="ghost" size="icon" aria-label={`${label}下移`} disabled={blocked || index < 0 || index >= selectedIds.length - 1} onClick={() => move(file.id, 1)}><ArrowDown size={13} /></Button></div>
              </li>;
            })}
          </ol>
        </> : <>
          <p className="pdf-export-source">{current?.name ?? "未选择文档"}</p>
          <p className="pdf-export-note">页码指当前编辑后的顺序。逗号分隔独立 PDF；如 1-3,5,8-10 会生成三份文件。重复或重叠范围不允许。</p>
          <fieldset className="pdf-split-modes" disabled={blocked}><legend>拆分方式</legend>
            <label><input type="radio" name="pdf-split-mode" checked={splitKind === "ranges"} onChange={() => change(() => setSplitKind("ranges"))} />自定义范围</label>
            <label><input type="radio" name="pdf-split-mode" checked={splitKind === "every"} onChange={() => change(() => setSplitKind("every"))} />每 N 页</label>
          </fieldset>
          {splitKind === "ranges" ? <><label htmlFor="pdf-split-ranges">拆分页码范围</label><input id="pdf-split-ranges" value={ranges} disabled={blocked} maxLength={2000} autoComplete="off" placeholder="1-3, 4-7, 8-12" onChange={(event) => change(() => setRanges(event.target.value))} /></>
            : <><label htmlFor="pdf-split-every">每份页数</label><input id="pdf-split-every" type="number" min="1" max="1000" step="1" value={every} disabled={blocked} onChange={(event) => change(() => setEvery(event.target.value))} /></>}
        </>}
        <label htmlFor="pdf-operation-filename">{mode === "merge" ? "导出文件名" : "输出文件名前缀"}</label>
        <input ref={input} id="pdf-operation-filename" value={filename} disabled={blocked} maxLength={240} autoComplete="off" spellCheck={false} onChange={(event) => change(() => setFilename(event.target.value))} />
        {planError && !showingSubmitted && <p className="pdf-export-error" role="alert"><AlertCircle size={14} />{planError}</p>}
        {preview && <div className="pdf-operation-preview"><h4>{showingSubmitted ? "本次计划" : "输出计划"} · {preview.outputs.length} 份 / {preview.outputs.reduce((count, output) => count + output.pages.length, 0)} 页</h4>
          <ol aria-label="输出计划预览">{preview.outputs.map((output) => <li key={output.id}><strong>{output.fileName}</strong><span>{output.rangeLabel} · {output.pages.length} 页</span></li>)}</ol></div>}
        <p className="pdf-export-note">计划在点击生成时冻结。后续编辑不会改变本次结果，也不会修改原始文档或撤销历史。</p>
        <div className="pdf-export-status" role="status" aria-live="polite" aria-atomic="true">
          {task.busy ? <LoaderCircle size={15} className="pdf-spinner" /> : task.stage === "ready" ? <Check size={15} /> : null}<strong>{stages[task.stage]}</strong>
          {task.busy && task.totalOutputs > 0 && <span>正在处理第 {task.outputIndex || 1} / {task.totalOutputs} 份</span>}
          {task.stage === "cancelling" && <p>已请求丢弃结果，等待当前阶段结束。底层保存计算不能立即中断。</p>}
          {externalBusy && <p>另一项 PDF 输出任务正在运行，结束后可开始。</p>}
          {task.stage === "ready" && <p>全部结果已独立校验。请逐份点击下载；应用不会自动连续下载。</p>}
        </div>
        {error && <p className="pdf-export-error" role="alert"><AlertCircle size={14} />{error}</p>}
        <div className="pdf-export-actions"><Button type="submit" size="sm" disabled={!plan || blocked}>{task.stage === "ready" ? "重新生成" : mode === "merge" ? "生成合并 PDF" : "生成拆分 PDF"}</Button>
          {task.busy && <Button type="button" variant="outline" size="sm" disabled={task.stage === "cancelling"} onClick={() => controller.cancel()}>停止等待</Button>}</div>
      </form>
      {task.results.length > 0 && <ol className="pdf-operation-results" aria-label="已验证输出结果">{task.results.map((result) => <li key={result.id}>
        <strong>{result.fileName}</strong><span>{result.rangeLabel} · {result.pageCount} 页 · {formatPdfBytes(result.size)}</span><span>已验证{result.downloaded ? " · 已触发下载" : ""}</span>
        <Button type="button" size="sm" variant="outline" aria-label={`下载 ${result.fileName}`} disabled={blocked || task.stage !== "ready"} onClick={() => download(result.id)}><Download size={13} />{result.downloaded ? "再次下载" : "下载 PDF"}</Button>
      </li>)}</ol>}
      {task.results.some((result) => result.downloaded) && <p className="pdf-export-note">已触发下载，请检查浏览器下载列表；无法确认文件已保存到磁盘。</p>}
      <div className="pdf-export-compatibility"><strong>兼容性与限制</strong><p>{PDF_EXPORT_COMPATIBILITY_NOTICE}</p><p>复杂图层配置不受支持时会拒绝输出；其他特殊文档结构不保证保留，请核验每份结果。</p><p>最多 50 份输出、累计 1,000 页；来源总量 ≤ 128 MiB，结果累计 ≤ 100 MiB。</p></div>
      <p className="pdf-export-note">所有文件都在当前浏览器内处理，不会自动上传。关闭面板或清空工作区会丢弃待下载结果。{mode === "merge" ? "切换当前查看的来源不会取消本次合并。" : "切换文档会丢弃本次拆分结果。"}跨文档交错页面排序与 ZIP 批量下载暂未提供。</p>
    </section>
  );
}
