import { getEditedPageInfo, normalizeRotation, type PdfEditPage } from "./edit";
import { isCancellation, PdfUserError, type PdfDocumentHandle } from "./types";

const failure = () => new PdfUserError("导出结果未通过页面顺序、内容或方向检查，未提供下载。请重新导入文件后重试。");
const close = (left: number, right: number) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.01;

/** Compare independent PDF.js source/output observations, including image-only pages. */
export async function validateEditedPdf(source: PdfDocumentHandle, output: PdfDocumentHandle, pages: readonly PdfEditPage[], signal: AbortSignal): Promise<void> {
  try {
    signal.throwIfAborted();
    if (!pages.length || pages.length !== output.pages.length || !source.inspectPage || !output.inspectPage) throw failure();
    const seen = new Set<number>();
    for (const [index, page] of pages.entries()) {
      signal.throwIfAborted();
      const original = source.pages[page.sourcePageNumber - 1];
      const written = output.pages[index];
      if (!original || !Number.isInteger(page.sourcePageNumber) || seen.has(page.sourcePageNumber) ||
        !Number.isSafeInteger(page.rotationDelta) || page.rotationDelta % 90 !== 0 ||
        normalizeRotation(original.rotation) !== normalizeRotation(page.originalRotation)) throw failure();
      seen.add(page.sourcePageNumber);
      const expected = getEditedPageInfo(page, original, index + 1);
      if (!close(expected.width, written.width) || !close(expected.height, written.height) ||
        expected.rotation !== normalizeRotation(written.rotation) || expected.orientation !== written.orientation) throw failure();
      // Serial bounded renders use temporary canvases; no raw text/pixels survive inspection.
      const before = await source.inspectPage(page.sourcePageNumber, signal, page.rotationDelta);
      signal.throwIfAborted();
      const after = await output.inspectPage(index + 1, signal);
      signal.throwIfAborted();
      if (!before.textDigest || !before.visualDigest || before.textDigest !== after.textDigest || before.visualDigest !== after.visualDigest ||
        !close(before.width, expected.width) || !close(before.height, expected.height) || before.rotation !== expected.rotation ||
        !close(after.width, expected.width) || !close(after.height, expected.height) || after.rotation !== expected.rotation) throw failure();
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (isCancellation(error)) throw error;
    throw failure();
  }
}
