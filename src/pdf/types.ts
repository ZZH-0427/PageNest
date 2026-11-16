import type { PdfEditState } from "./edit";

export const MAX_PDF_FILES = 20;
export const MAX_PDF_FILE_BYTES = 100 * 1024 ** 2;
export const MAX_WORKSPACE_BYTES = 256 * 1024 ** 2;
export const MAX_PDF_PAGES = 1000;
export const MAX_RENDER_TASKS = 2;
export const MAX_THUMBNAIL_PIXELS = 320 * 440;

export interface PdfPageInfo {
  number: number;
  width: number;
  height: number;
  rotation: number;
  orientation: "portrait" | "landscape" | "square";
}

export type PdfStatus = "queued" | "reading" | "parsing" | "ready" | "error";

export interface PdfFileEntry {
  id: string;
  name: string;
  size: number;
  ordinal: number;
  status: PdfStatus;
  pages: PdfPageInfo[];
  selectedPage: number;
  edit: PdfEditState | null;
  error: string | null;
}

export interface PdfDocumentHandle {
  pages: PdfPageInfo[];
  render(page: number, canvas: HTMLCanvasElement, signal: AbortSignal, rotationDelta?: number): Promise<void>;
  inspectPage?(page: number, signal: AbortSignal, rotationDelta?: number, includeRenderSignature?: boolean, renderSize?: 128 | 512): Promise<{
    textDigest: string; visualDigest: string; width: number; height: number; rotation: number;
    /** Bounded transient comparison scratch, never UI state, storage or diagnostics. Caller erases it. */
    visualSample?: { width: number; height: number; pixels: Uint8Array };
    /** Optional in-memory subset hashes; diagnostics may expose equality booleans only. */
    renderSignature?: { viewport: string; graphics: string };
  }>;
  /** Private compression validation evidence; document values never enter UI state. */
  inspectDocument?(signal: AbortSignal): Promise<{
    metadataDigest: string; outlinesDigest: string;
    hasForms: boolean; hasSignatures?: boolean; hasAttachments: boolean; hasJavaScript: boolean; encrypted: boolean;
  }>;
  destroy(): Promise<void>;
}

export interface PdfOpenOptions {
  /** Diagnostic-only font rendering override; normal preview keeps PDF.js defaults. */
  fontMode?: "paths";
}

export interface PdfEngine {
  open(file: File, signal: AbortSignal, onStatus: (status: "reading" | "parsing") => void, options?: PdfOpenOptions): Promise<PdfDocumentHandle>;
  destroy(): Promise<void>;
}

export function formatPdfBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes < 1024 ** 2 ? "KiB" : "MiB";
  const divisor = unit === "KiB" ? 1024 : 1024 ** 2;
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(bytes / divisor)} ${unit}`;
}

export function abortError(): DOMException {
  return new DOMException("Cancelled", "AbortError");
}

export function isCancellation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error &&
    (error.name === "AbortError" || error.name === "RenderingCancelledException");
}

export class PdfUserError extends Error {}

/** Never expose PDF.js exception messages, which may contain document data. */
export function pdfErrorMessage(error: unknown): string {
  if (error instanceof PdfUserError) return error.message;
  if (error instanceof Error && error.name === "PasswordException") {
    return "此 PDF 需要密码。当前版本暂不支持密码保护的文档。";
  }
  return "无法解析此 PDF，文件可能已损坏或包含不支持的内容。请尝试其他文件。";
}
