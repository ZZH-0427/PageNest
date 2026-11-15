import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEditState } from "./edit";
import { defaultExportFilename, generateEditedPdf, sanitizePdfFilename, type PdfExportRequest } from "./export";
import { PdfUserError } from "./types";

const library = vi.hoisted(() => ({ load: vi.fn(), create: vi.fn(), degrees: vi.fn((angle: number) => ({ angle })), copyPages: vi.fn() }));
vi.mock("./export-copy", () => ({ copyEditedPages: library.copyPages }));
vi.mock("pdf-lib", () => ({ PDFDocument: { load: library.load, create: library.create }, degrees: library.degrees }));
const bytes = new TextEncoder().encode("%PDF-1.7\nSYNTHETIC INPUT");
const originalPages = [{ number: 1, width: 594, height: 420, rotation: 90, orientation: "landscape" as const }];
const request = (): PdfExportRequest => ({ documentId: "source", pages: createEditState("source", originalPages).present.pages, originalPages });
let copied: { getRotation: () => { angle: number }; setRotation: ReturnType<typeof vi.fn> };
let output: { copyPages: ReturnType<typeof vi.fn>; addPage: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> };

beforeEach(() => {
  library.load.mockReset(); library.create.mockReset(); library.degrees.mockClear(); library.copyPages.mockReset();
  copied = { getRotation: () => ({ angle: 90 }), setRotation: vi.fn() };
  output = { copyPages: vi.fn(async () => [copied]), addPage: vi.fn(), save: vi.fn(async () => new TextEncoder().encode("%PDF-1.7\nSYNTHETIC OUTPUT")) };
  library.load.mockResolvedValue({ getPageCount: () => 1, getPage: () => ({ getRotation: () => ({ angle: 90 }) }) });
  library.create.mockResolvedValue(output);
  library.copyPages.mockImplementation(async (_source, destination, indices) => destination.copyPages(_source, indices));
});

describe("safe PDF filenames", () => {
  it.each([
    ["报告.pdf.PDF", "报告.pdf"], ["report.pdf .PDF", "report.pdf"], ["", "document.pdf"], [" ... ", "document.pdf"],
    ["CON.pdf", "_CON.pdf"], ["com1.txt", "_com1.txt.pdf"], ["LPT²", "_LPT².pdf"],
    ["../bad\\name:<x>?*.pdf", "_bad_name__x___.pdf"],
    ["report\u0000\n\u202efile.pdf", "reportfile.pdf"],
  ])("normalizes %s to a filename only", (input, expected) => expect(sanitizePdfFilename(input)).toBe(expected));
  it("uses an edited suffix and bounds Unicode names without splitting a code point", () => {
    expect(defaultExportFilename("报告.PDF")).toBe("报告_edited.pdf");
    expect(defaultExportFilename("x".repeat(200) + ".pdf")).toBe("x".repeat(113) + "_edited.pdf");
    expect(Array.from(sanitizePdfFilename("😀".repeat(300))).length).toBe(124);
  });
});

describe("export generation boundaries", () => {
  it("uses immutable source mapping and sets the absolute combined rotation", async () => {
    const input = request(); input.pages[0].rotationDelta = 90;
    const snapshot = structuredClone(input);
    await generateEditedPdf(bytes, input, new AbortController().signal);
    expect(output.copyPages).toHaveBeenCalledWith(expect.anything(), [0]);
    expect(copied.setRotation).toHaveBeenCalledWith({ angle: 180 });
    expect(output.addPage).toHaveBeenCalledWith(copied);
    expect(library.load).toHaveBeenCalledWith(bytes, expect.objectContaining({ ignoreEncryption: false, updateMetadata: false }));
    expect(output.save).toHaveBeenCalledWith(expect.objectContaining({ addDefaultPage: false, updateFieldAppearances: false }));
    expect(input).toEqual(snapshot);
  });
  it.each([
    (input: PdfExportRequest) => { input.pages = []; },
    (input: PdfExportRequest) => { input.pages[0].sourceDocumentId = "other"; },
    (input: PdfExportRequest) => { input.pages[0].sourcePageNumber = 0; },
    (input: PdfExportRequest) => { input.pages[0].sourcePageNumber = 1.5; },
    (input: PdfExportRequest) => { input.pages[0].rotationDelta = 45; },
    (input: PdfExportRequest) => { input.pages[0].originalRotation = 0; },
    (input: PdfExportRequest) => { input.pages.push({ ...input.pages[0] }); },
    (input: PdfExportRequest) => { input.originalPages = [{ ...input.originalPages[0], width: NaN }]; },
  ])("rejects invalid mappings before loading PDF bytes", async (mutate) => {
    const input = request(); mutate(input);
    await expect(generateEditedPdf(bytes, input, new AbortController().signal)).rejects.toBeInstanceOf(PdfUserError);
    expect(library.load).not.toHaveBeenCalled();
  });
  it("checks cancellation after a non-cancellable save and never returns stale bytes", async () => {
    const controller = new AbortController();
    output.save.mockImplementation(async () => { controller.abort(); return bytes; });
    await expect(generateEditedPdf(bytes, request(), controller.signal)).rejects.toHaveProperty("name", "AbortError");
  });
  it.each(["load", "copy", "save"])("hides internal %s errors", async (stage) => {
    const failure = new Error("SYNTHETIC PRIVATE DOCUMENT CONTENT");
    if (stage === "load") library.load.mockRejectedValue(failure);
    if (stage === "copy") output.copyPages.mockRejectedValue(failure);
    if (stage === "save") output.save.mockRejectedValue(failure);
    await expect(generateEditedPdf(bytes, request(), new AbortController().signal)).rejects.toThrow("无法生成新的 PDF");
  });
});
