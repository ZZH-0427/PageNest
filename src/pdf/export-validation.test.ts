import { createEditState } from "./edit";
import { PdfExportDiagnosticError, type PdfExportDiagnosticCode, type PdfExportDiagnosticContext } from "./export-diagnostics";
import { validateEditedPdf } from "./export-validation";
import type { PdfDocumentHandle } from "./types";

const info = (number: number) => ({ number, width: 420, height: 594, rotation: 0, orientation: "portrait" as const });
function documentHandle(markers: string[]): PdfDocumentHandle {
  return {
    pages: markers.map((_, index) => info(index + 1)), render: vi.fn(), destroy: vi.fn(),
    inspectPage: vi.fn(async (number) => ({ textDigest: `text-${markers[number - 1]}`, visualDigest: `pixels-${markers[number - 1]}`, width: 420, height: 594, rotation: 0 })),
  };
}

test("compares mapped source content to every output position", async () => {
  const source = documentHandle(["a", "b", "c"]);
  const output = documentHandle(["c", "a"]);
  const all = createEditState("source", source.pages).present.pages;
  await validateEditedPdf(source, output, [all[2], all[0]], new AbortController().signal);
  expect(source.inspectPage).toHaveBeenNthCalledWith(1, 3, expect.any(AbortSignal), 0);
  expect(source.inspectPage).toHaveBeenNthCalledWith(2, 1, expect.any(AbortSignal), 0);
  expect(output.inspectPage).toHaveBeenCalledTimes(2);
});

test.each(["order", "pixels", "rotation", "dimensions", "missing-inspection"])("rejects incorrect %s despite a matching page count", async (change) => {
  const source = documentHandle(["a", "b"]);
  const output = documentHandle(change === "order" ? ["b", "a"] : ["a", "b"]);
  if (change === "pixels") vi.mocked(output.inspectPage!).mockResolvedValue({ textDigest: "text-a", visualDigest: "missing-image", width: 420, height: 594, rotation: 0 });
  if (change === "rotation") output.pages[0].rotation = 180;
  if (change === "dimensions") output.pages[0].width = 400;
  if (change === "missing-inspection") output.inspectPage = undefined;
  await expect(validateEditedPdf(source, output, createEditState("source", source.pages).present.pages, new AbortController().signal)).rejects.toThrow("未提供下载");
});

test("cancellation prevents inspecting subsequent pages and hides stale outcomes", async () => {
  const source = documentHandle(["a", "b"]);
  const output = documentHandle(["a", "b"]);
  const controller = new AbortController();
  vi.mocked(source.inspectPage!).mockImplementation(async () => { controller.abort(); return { textDigest: "a", visualDigest: "a", width: 420, height: 594, rotation: 0 }; });
  await expect(validateEditedPdf(source, output, createEditState("source", source.pages).present.pages, controller.signal)).rejects.toHaveProperty("name", "AbortError");
  expect(output.inspectPage).not.toHaveBeenCalled();
});

async function diagnostic(source: PdfDocumentHandle, output: PdfDocumentHandle, pages = createEditState("source", source.pages).present.pages) {
  try {
    await validateEditedPdf(source, output, pages, new AbortController().signal);
    throw new Error("Expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PdfExportDiagnosticError);
    return error as PdfExportDiagnosticError;
  }
}

test("identifies page count failures before any page inspection", async () => {
  const source = documentHandle(["a", "b"]);
  const output = documentHandle(["a"]);
  const error = await diagnostic(source, output);
  expect(error.diagnostic).toEqual({ code: "PAGE_COUNT_MISMATCH", stage: "validating", item: "page-count" });
  expect(source.inspectPage).not.toHaveBeenCalled();
  expect(output.inspectPage).not.toHaveBeenCalled();
});

test.each([
  ["dimensions", "PAGE_GEOMETRY_MISMATCH", "dimensions"],
  ["orientation", "PAGE_GEOMETRY_MISMATCH", "orientation"],
  ["rotation", "PAGE_ROTATION_MISMATCH", "rotation"],
  ["text", "TEXT_CONTENT_MISMATCH", "text"],
  ["visual", "VISUAL_CONTENT_MISMATCH", "visual"],
] as const)("reports %s mismatch at the mapped output/source pages without values", async (change, code, item) => {
  const source = documentHandle(["a", "b", "c"]);
  const output = documentHandle(["c", "a"]);
  const pages = createEditState("source", source.pages).present.pages;
  if (change === "dimensions") output.pages[0].width = 401;
  if (change === "orientation") output.pages[0].orientation = "landscape";
  if (change === "rotation") output.pages[0].rotation = 180;
  if (change === "text" || change === "visual") {
    vi.mocked(output.inspectPage!).mockResolvedValue({
      width: 420, height: 594, rotation: 0,
      textDigest: change === "text" ? "SYNTHETIC_DOCUMENT_TEXT_DIGEST" : "text-c",
      visualDigest: change === "visual" ? "SYNTHETIC_DOCUMENT_PIXEL_DIGEST" : "pixels-c",
    });
  }
  const error = await diagnostic(source, output, [pages[2], pages[0]]);
  expect(error.diagnostic).toEqual({ code, stage: "validating", item, outputPage: 1, sourcePage: 3 });
  expect(error.message).toContain(code);
  expect(error.message).toContain("outputPage=1");
  expect(error.message).toContain("sourcePage=3");
  expect(error.message).not.toContain("SYNTHETIC_DOCUMENT");
  expect(JSON.stringify(error)).not.toContain("401");
});

test.each(["source", "output"] as const)("safely wraps an unknown %s inspection failure and preserves page context", async (side) => {
  const source = documentHandle(["a", "b", "c"]);
  const output = documentHandle(["c"]);
  const pages = createEditState("source", source.pages).present.pages;
  const handle = side === "source" ? source : output;
  const privateDetail = "SYNTHETIC_DOCUMENT_TEXT_AND_PIXEL_DIAGNOSTIC";
  vi.mocked(handle.inspectPage!).mockRejectedValue(new Error(privateDetail));
  const error = await diagnostic(source, output, [pages[2]]);
  expect(error.diagnostic).toEqual({ code: "INSPECTION_FAILURE", stage: `${side}-inspection`, item: "page", outputPage: 1, sourcePage: 3 });
  expect(error.message).not.toContain(privateDetail);
  expect(JSON.stringify(error)).not.toContain(privateDetail);
  expect(error).not.toHaveProperty("cause");
});

test.each(["source", "output"] as const)("retains a typed %s timeout code/item while supplying actual mapping", async (side) => {
  const source = documentHandle(["a", "b", "c"]);
  const output = documentHandle(["c"]);
  const pages = createEditState("source", source.pages).present.pages;
  const typed = new PdfExportDiagnosticError("VALIDATION_TIMEOUT", { stage: "inspection", item: "deadline" });
  vi.mocked((side === "source" ? source : output).inspectPage!).mockRejectedValue(typed);
  const error = await diagnostic(source, output, [pages[2]]);
  expect(error.diagnostic).toEqual({ code: "VALIDATION_TIMEOUT", stage: `${side}-inspection`, item: "deadline", outputPage: 1, sourcePage: 3 });
  expect(error.message).toContain("验证耗时过长");
});

test.each(["source", "output"] as const)("attributes inspected %s geometry failures to that phase", async (side) => {
  const source = documentHandle(["a"]);
  const output = documentHandle(["a"]);
  vi.mocked((side === "source" ? source : output).inspectPage!).mockResolvedValue({ textDigest: "text-a", visualDigest: "pixels-a", width: 410, height: 594, rotation: 0 });
  const error = await diagnostic(source, output);
  expect(error.diagnostic).toEqual({ code: "PAGE_GEOMETRY_MISMATCH", stage: `${side}-inspection`, item: "dimensions", outputPage: 1, sourcePage: 1 });
});

test.each(["textDigest", "visualDigest"] as const)("continues rejecting missing %s rather than skipping content checks", async (field) => {
  const source = documentHandle(["a"]);
  const output = documentHandle(["a"]);
  vi.mocked(source.inspectPage!).mockResolvedValue({ textDigest: "text-a", visualDigest: "pixels-a", width: 420, height: 594, rotation: 0, [field]: "" });
  const error = await diagnostic(source, output);
  expect(error.code).toBe(field === "textDigest" ? "TEXT_CONTENT_MISMATCH" : "VISUAL_CONTENT_MISMATCH");
});

test("rejects duplicate source mappings with safe source-page diagnostics", async () => {
  const source = documentHandle(["a"]);
  const output = documentHandle(["a", "a"]);
  const page = createEditState("source", source.pages).present.pages[0];
  const error = await diagnostic(source, output, [page, page]);
  expect(error.diagnostic).toEqual({ code: "INSPECTION_FAILURE", stage: "validating", item: "source-page", outputPage: 2, sourcePage: 1 });
});

test("allows only bounded numeric page references and known enums in a diagnostic", () => {
  const privateValue = "SYNTHETIC_DOCUMENT_DIAGNOSTIC";
  const error = new PdfExportDiagnosticError(privateValue as PdfExportDiagnosticCode, {
    stage: privateValue, item: privateValue, outputPage: privateValue, sourcePage: Number.POSITIVE_INFINITY,
    text: privateValue, pixelData: privateValue, path: privateValue, digest: privateValue,
  } as unknown as PdfExportDiagnosticContext);
  expect(error.diagnostic).toEqual({ code: "INSPECTION_FAILURE", stage: "validating", item: "page" });
  expect(error.message).not.toContain(privateValue);
  expect(JSON.stringify(error)).not.toContain(privateValue);
  expect(Object.isFrozen(error.diagnostic)).toBe(true);
  expect(error.withContext({ outputPage: 0, sourcePage: 1001 }).diagnostic).toEqual(error.diagnostic);
  expect(error.withContext({ stage: "cleanup", item: "resources", outputPage: 1000, sourcePage: 1 }).diagnostic)
    .toEqual({ code: "INSPECTION_FAILURE", stage: "cleanup", item: "resources", outputPage: 1000, sourcePage: 1 });
});

test("preserves explicit cancellation exceptions without converting them to inspection errors", async () => {
  const source = documentHandle(["a"]);
  const output = documentHandle(["a"]);
  const cancellation = new DOMException("Cancelled", "AbortError");
  vi.mocked(source.inspectPage!).mockRejectedValue(cancellation);
  await expect(validateEditedPdf(source, output, createEditState("source", source.pages).present.pages, new AbortController().signal)).rejects.toBe(cancellation);
});
