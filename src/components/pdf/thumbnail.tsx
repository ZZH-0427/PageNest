import { useEffect, useRef, useState, type HTMLAttributes, type MouseEvent, type RefObject } from "react";
import { AlertCircle, LoaderCircle } from "lucide-react";
import type { PdfWorkspace } from "../../pdf/workspace";
import { isCancellation, PdfUserError, type PdfPageInfo } from "../../pdf/types";

interface Props {
  workspace: PdfWorkspace;
  documentId: string;
  page: PdfPageInfo;
  sourcePageNumber?: number;
  rotationDelta?: number;
  selected: boolean;
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
  scrollRoot: RefObject<HTMLDivElement | null>;
  tileProps?: HTMLAttributes<HTMLButtonElement>;
}

export function PdfThumbnail({ workspace, documentId, page, sourcePageNumber = page.number, rotationDelta = 0, selected, onSelect, scrollRoot, tileProps }: Props) {
  const tile = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visibility, setVisibility] = useState({ visible: false, generation: 0 });
  const { visible } = visibility;
  const delta = ((rotationDelta % 360) + 360) % 360;
  // Display order and selection do not invalidate a source page's canvas.
  const renderIdentity = `${documentId}:${sourcePageNumber}:${delta}:${visibility.generation}`;
  const [cycle, setCycle] = useState<{
    identity: string; generation: number; status: "waiting" | "ready" | "error"; error: string;
  }>({ identity: renderIdentity, generation: 0, status: "waiting", error: "" });
  if (cycle.identity !== renderIdentity) {
    // Reset before committing a new canvas, including Undo back to an old angle.
    setCycle({ identity: renderIdentity, generation: cycle.generation + 1, status: "waiting", error: "" });
  }
  const { generation, status, error } = cycle;
  const { className: tileClassName, ...tileAttributes } = tileProps ?? {};

  useEffect(() => {
    const element = tile.current;
    if (!element) return;
    let active = true;
    const updateVisibility = (next: boolean) => {
      if (!active) return;
      setVisibility((current) => current.visible === next ? current : { visible: next, generation: current.generation + 1 });
    };
    if (typeof IntersectionObserver === "undefined") {
      // Older browsers still load a bounded queue, with only near-viewport canvases retained.
      const root = scrollRoot.current;
      const update = () => {
        const bounds = element.getBoundingClientRect();
        const frame = root?.getBoundingClientRect();
        updateVisibility(bounds.bottom >= (frame?.top ?? 0) - 200 && bounds.top <= (frame?.bottom ?? innerHeight) + 200);
      };
      const frame = requestAnimationFrame(update);
      root?.addEventListener("scroll", update, { passive: true });
      window.addEventListener("resize", update);
      return () => { active = false; cancelAnimationFrame(frame); root?.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
    }
    const observer = new IntersectionObserver((entries) => {
      // A viewport change can queue several observations before one callback.
      // Apply the newest state for this tile, not an earlier out-of-view record.
      let latest: IntersectionObserverEntry | undefined;
      for (const entry of entries) {
        if (entry.target === element && (!latest || entry.time >= latest.time)) latest = entry;
      }
      if (latest) updateVisibility(latest.isIntersecting);
    }, {
      root: scrollRoot.current, rootMargin: "200px 0px",
    });
    observer.observe(element);
    return () => { active = false; observer.disconnect(); };
  }, [scrollRoot, page.number]);

  useEffect(() => {
    const target = canvas.current;
    if (!visible || !target) return;
    const controller = new AbortController();
    void workspace.renderPage(documentId, sourcePageNumber, target, controller.signal, delta).then(() => {
      if (!controller.signal.aborted) setCycle((current) => current.generation === generation
        ? { ...current, status: "ready", error: "" } : current);
    }).catch((failure: unknown) => {
      if (controller.signal.aborted || isCancellation(failure)) return;
      setCycle((current) => current.generation === generation
        ? { ...current, status: "error", error: failure instanceof PdfUserError ? failure.message : "此页面无法预览。请尝试其他页面或重新导入文件。" } : current);
    });
    return () => {
      controller.abort();
      // Cancel first. Shrinking also discards the browser's backing pixel buffer.
      target.width = 0;
      target.height = 0;
    };
  }, [workspace, documentId, sourcePageNumber, delta, generation, visible]);

  return (
    <button
      {...tileAttributes}
      ref={tile} type="button"
      className={`pdf-thumbnail ${selected ? "selected" : ""} ${tileClassName ?? ""}`}
      aria-label={`第 ${page.number} 页${status === "error" ? "，预览失败" : ""}`}
      aria-pressed={selected} onClick={onSelect}
    >
      <span className="pdf-thumbnail-paper" style={{ aspectRatio: `${page.width} / ${page.height}`, width: `min(100%, ${page.width / page.height * 280}px)` }}>
        <canvas key={generation} ref={canvas} width={0} height={0} aria-hidden="true" style={{ opacity: status === "ready" ? 1 : 0 }} />
        {status === "waiting" && <span className="pdf-thumbnail-status"><LoaderCircle size={17} aria-hidden="true" />{visible ? "正在预览" : "等待预览"}</span>}
        {status === "error" && <span className="pdf-thumbnail-error"><AlertCircle size={19} aria-hidden="true" />{error}</span>}
      </span>
      <span className="pdf-thumbnail-caption">第 {page.number} 页 <span>{page.orientation === "landscape" ? "横向" : page.orientation === "portrait" ? "纵向" : "方形"}</span></span>
    </button>
  );
}
