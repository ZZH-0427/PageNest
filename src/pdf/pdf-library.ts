import { PdfUserError } from "./types";

/** Keep the engine lazy-loaded and distinguish missing assets from document failures. */
export async function loadPdfLibrary(): Promise<typeof import("pdf-lib")> {
  try {
    return await import("pdf-lib");
  } catch {
    throw new PdfUserError("PDF 处理组件加载失败（PDF_LIBRARY_LOAD_FAILURE）。请保留原文件并记下所需编辑，清空工作区后刷新页面重试；刷新会丢弃当前编辑。");
  }
}
