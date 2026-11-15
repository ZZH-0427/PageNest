import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("pdf-lib");
  vi.resetModules();
});

it("loads the actual PDF library interface without changing its exports", async () => {
  const { loadPdfLibrary } = await import("./pdf-library");
  const library = await loadPdfLibrary();
  expect(library).toBe(await import("pdf-lib"));
  expect(library.PDFDocument.load).toBeTypeOf("function");
  expect(library.PDFDocument.create).toBeTypeOf("function");
  expect(library.PDFObjectCopier.for).toBeTypeOf("function");
  expect(library.degrees(90).angle).toBe(90);
});

it("replaces a failed dynamic import with a fixed safe recovery message", async () => {
  vi.doMock("pdf-lib", () => {
    throw Object.assign(new Error("https://artificial.invalid/private-file.pdf?token=ARTIFICIAL_PRIVATE_VALUE"), {
      documentBody: "ARTIFICIAL_PRIVATE_DOCUMENT", cause: new Error("ARTIFICIAL_PRIVATE_CAUSE"),
    });
  });
  const { loadPdfLibrary } = await import("./pdf-library");
  const { PdfUserError } = await import("./types");
  const failure: unknown = await loadPdfLibrary().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(PdfUserError);
  expect((failure as Error).message).toBe("PDF 处理组件加载失败（PDF_LIBRARY_LOAD_FAILURE）。请保留原文件并记下所需编辑，清空工作区后刷新页面重试；刷新会丢弃当前编辑。");
  expect((failure as Error).message).not.toMatch(/https?:|private-file|ARTIFICIAL_PRIVATE/);
  expect(failure).not.toHaveProperty("cause");
  expect(failure).not.toHaveProperty("documentBody");
  expect(JSON.stringify(failure)).not.toContain("ARTIFICIAL_PRIVATE");
});
