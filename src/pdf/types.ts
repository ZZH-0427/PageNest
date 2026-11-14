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
  error: string | null;
}

export interface PdfDocumentHandle {
  pages: PdfPageInfo[];
  render(page: number, canvas: HTMLCanvasElement, signal: AbortSignal): Promise<void>;
  destroy(): Promise<void>;
}

export interface PdfEngine {
  open(file: File, signal: AbortSignal, onStatus: (status: "reading" | "parsing") => void): Promise<PdfDocumentHandle>;
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
