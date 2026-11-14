import { useEffect, useRef, useState, type RefObject } from "react";
import { AlertCircle, LoaderCircle } from "lucide-react";
import type { PdfWorkspace } from "../../pdf/workspace";
import { isCancellation, PdfUserError, type PdfPageInfo } from "../../pdf/types";

interface Props {
  workspace: PdfWorkspace;
  documentId: string;
  page: PdfPageInfo;
  selected: boolean;
  onSelect: () => void;
  scrollRoot: RefObject<HTMLDivElement | null>;
}

export function PdfThumbnail({ workspace, documentId, page, selected, onSelect, scrollRoot }: Props) {
  const tile = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState<"waiting" | "ready" | "error">("waiting");
  const [error, setError] = useState("");

  useEffect(() => {
    const element = tile.current;
    if (!element) return;
    const updateVisibility = (next: boolean) => {
      setVisible(next);
      if (!next) setStatus("waiting");
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
      return () => { cancelAnimationFrame(frame); root?.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
    }
    const observer = new IntersectionObserver(([entry]) => updateVisibility(entry.isIntersecting), {
      root: scrollRoot.current, rootMargin: "200px 0px",
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    const target = canvas.current;
    if (!visible || !target) return;
    const controller = new AbortController();
    void workspace.renderPage(documentId, page.number, target, controller.signal).then(() => {
      if (!controller.signal.aborted) setStatus("ready");
    }).catch((failure: unknown) => {
      if (controller.signal.aborted || isCancellation(failure)) return;
      setStatus("error");
      setError(failure instanceof PdfUserError ? failure.message : "此页面无法预览。请尝试其他页面或重新导入文件。");
    });
    return () => {
      controller.abort();
      // Cancel first. Shrinking also discards the browser's backing pixel buffer.
      target.width = 0;
      target.height = 0;
    };
  }, [workspace, documentId, page.number, visible]);

  return (
    <button
      ref={tile} type="button"
      className={`pdf-thumbnail ${selected ? "selected" : ""}`}
      aria-label={`第 ${page.number} 页${status === "error" ? "，预览失败" : ""}`}
      aria-pressed={selected} onClick={onSelect}
    >
      <span className="pdf-thumbnail-paper" style={{ aspectRatio: `${page.width} / ${page.height}`, width: `min(100%, ${page.width / page.height * 280}px)` }}>
        <canvas key={visible ? "active" : "idle"} ref={canvas} width={0} height={0} aria-hidden="true" style={{ opacity: status === "ready" ? 1 : 0 }} />
        {status === "waiting" && <span className="pdf-thumbnail-status"><LoaderCircle size={17} aria-hidden="true" />{visible ? "正在预览" : "等待预览"}</span>}
        {status === "error" && <span className="pdf-thumbnail-error"><AlertCircle size={19} aria-hidden="true" />{error}</span>}
      </span>
      <span className="pdf-thumbnail-caption">第 {page.number} 页 <span>{page.orientation === "landscape" ? "横向" : page.orientation === "portrait" ? "纵向" : "方形"}</span></span>
    </button>
  );
}
