import { loadPdfLibrary } from "./pdf-library";
import { normalizeRotation, type PdfEditPage } from "./edit";
import { copyEditedPages } from "./export-copy";
import { isCancellation, MAX_PDF_FILE_BYTES, MAX_PDF_PAGES, PdfUserError, type PdfPageInfo } from "./types";
import { validatePdfHeader } from "./validation";
import { inspectExportIntegrity, type PdfPageIntegrityEvidence } from "./export-integrity";

export const PDF_EXPORT_COMPATIBILITY_NOTICE = "PageNest 将尽量保留页面的视觉内容，但重新生成 PDF 可能影响签名、表单、书签和其他特殊结构。当前无法可靠识别全部特殊结构，不承诺严格无损导出。";

export interface PdfExportRequest {
  documentId: string;
  pages: PdfEditPage[];
  originalPages: PdfPageInfo[];
}

/** Produce a filename, never a filesystem path. */
export function sanitizePdfFilename(name: string): string {
  let stem = name.normalize("NFC").replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/[<>:"/\\|?*]/g, "_").trim().replace(/[. ]+$/g, "")
    .replace(/(?:\.pdf[. ]*)+$/i, "").replace(/^[. ]+|[. ]+$/g, "");
  stem = Array.from(stem).slice(0, 120).join("").replace(/[. ]+$/g, "") || "document";
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  return `${stem}.pdf`;
}

export function defaultExportFilename(sourceName: string): string {
  const stem = Array.from(sanitizePdfFilename(sourceName).slice(0, -4)).slice(0, 113).join("");
  return sanitizePdfFilename(`${stem}_edited.pdf`);
}

function validQuarterTurn(value: number): boolean {
  return Number.isSafeInteger(value) && value % 90 === 0;
}

function validateRequest(request: PdfExportRequest) {
  const fail = () => { throw new PdfUserError("当前编辑状态无效，无法导出。请重新导入文件后重试。"); };
  if (!request.documentId || !request.pages.length || request.pages.length > MAX_PDF_PAGES ||
    !request.originalPages.length || request.originalPages.length > MAX_PDF_PAGES) fail();
  const ids = new Set<string>();
  const sources = new Set<number>();
  for (const [index, original] of request.originalPages.entries()) {
    if (original.number !== index + 1 || !validQuarterTurn(original.rotation) ||
      ![original.width, original.height].every((value) => Number.isFinite(value) && value > 0 && value <= 144_000) ||
      original.orientation !== (original.width === original.height ? "square" : original.width > original.height ? "landscape" : "portrait")) fail();
  }
  for (const page of request.pages) {
    const original = request.originalPages[page.sourcePageNumber - 1];
    if (!page.id || ids.has(page.id) || page.sourceDocumentId !== request.documentId ||
      !Number.isInteger(page.sourcePageNumber) || !original || sources.has(page.sourcePageNumber) ||
      !validQuarterTurn(page.originalRotation) || !validQuarterTurn(page.rotationDelta) ||
      normalizeRotation(page.originalRotation) !== normalizeRotation(original?.rotation ?? NaN)) fail();
    ids.add(page.id);
    sources.add(page.sourcePageNumber);
  }
}

/** Generates bytes only. Ownership, independent validation and download belong to the caller. */
export async function generateEditedPdf(sourceBytes: Uint8Array, request: PdfExportRequest, signal: AbortSignal,
  onIntegrity?: (evidence: readonly PdfPageIntegrityEvidence[]) => void): Promise<Uint8Array> {
  try {
    signal.throwIfAborted();
    validateRequest(request);
    if (!sourceBytes.byteLength || sourceBytes.byteLength > MAX_PDF_FILE_BYTES) {
      throw new PdfUserError("原始 PDF 数据不可用或超出容量限制，无法导出。");
    }
    validatePdfHeader(sourceBytes.subarray(0, 1024));
    const library = await loadPdfLibrary();
    const { PDFDocument, degrees } = library;
    signal.throwIfAborted();
    const source = await PDFDocument.load(sourceBytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: true });
    signal.throwIfAborted();
    if (source.getPageCount() !== request.originalPages.length) throw new PdfUserError("原始 PDF 与当前工作区不一致，无法导出。");
    const output = await PDFDocument.create({ updateMetadata: false });
    const copied = await copyEditedPages(source, output, request.pages.map((page) => page.sourcePageNumber - 1), library, signal);
    signal.throwIfAborted();
    copied.forEach((page, index) => {
      const edit = request.pages[index];
      if (normalizeRotation(page.getRotation().angle) !== normalizeRotation(edit.originalRotation)) {
        throw new PdfUserError("原始页面旋转与当前工作区不一致，无法导出。");
      }
      page.setRotation(degrees(normalizeRotation(edit.originalRotation + edit.rotationDelta)));
      output.addPage(page);
    });
    const bytes = await output.save({ addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: 50 });
    signal.throwIfAborted();
    validatePdfHeader(bytes.subarray(0, 1024));
    if (onIntegrity) {
      const evidence = await inspectExportIntegrity(source, bytes, request.pages, library, signal);
      signal.throwIfAborted();
      onIntegrity(evidence);
    }
    return bytes;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (isCancellation(error) || error instanceof PdfUserError) throw error;
    throw new PdfUserError("无法生成新的 PDF，文件可能包含不兼容结构或浏览器内存不足。请尝试较小的文件。");
  }
}
