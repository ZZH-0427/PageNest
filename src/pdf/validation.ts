import { PdfUserError } from "./types";

/** PDF headers may occur within the first 1024 bytes; extensions and MIME are not proof. */
export function validatePdfHeader(bytes: Uint8Array): void {
  const header = String.fromCharCode(...bytes.subarray(0, 1024));
  if (!/%PDF-(?:1\.[0-7]|2\.0)(?:\s|$)/.test(header)) {
    throw new PdfUserError("文件不包含有效的 PDF 标识。请确认选择的是 PDF 文档。");
  }
}

/** FileReader can be aborted; File.arrayBuffer() cannot cancel a pending read. */
export function readPdfBytes(blob: Blob, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const reader = new FileReader();
    const cleanup = () => signal.removeEventListener("abort", cancel);
    const cancel = () => reader.abort();
    reader.onload = () => {
      cleanup();
      resolve(new Uint8Array(reader.result as ArrayBuffer));
    };
    reader.onerror = () => { cleanup(); reject(new PdfUserError("无法读取此文件，请重新选择本机可访问的 PDF。")); };
    reader.onabort = () => { cleanup(); reject(new DOMException("Cancelled", "AbortError")); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      reader.readAsArrayBuffer(blob);
    } catch {
      cleanup();
      reject(new PdfUserError("无法读取此文件，请重新选择本机可访问的 PDF。"));
    }
  });
}
