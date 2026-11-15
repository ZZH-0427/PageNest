import { getEditedPageInfo, normalizeRotation, type PdfEditPage } from "./edit";
import { PdfExportDiagnosticError, type PdfExportDiagnosticCode, type PdfExportDiagnosticContext } from "./export-diagnostics";
import { isCancellation, type PdfDocumentHandle, type PdfPageInfo } from "./types";
import { eraseVisualSample, renderSignatureDifference, visualDifference } from "./visual-difference";
import type { PdfPageIntegrityEvidence } from "./export-integrity";

const close = (left: number, right: number) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.01;
const quarterTurn = (value: number) => Number.isSafeInteger(value) && value % 90 === 0;
type Inspection = Awaited<ReturnType<NonNullable<PdfDocumentHandle["inspectPage"]>>>;

function failure(code: PdfExportDiagnosticCode, context: PdfExportDiagnosticContext): never {
  throw new PdfExportDiagnosticError(code, context);
}

function inspectGeometry(observed: Inspection, expected: PdfPageInfo, context: PdfExportDiagnosticContext) {
  if (observed.rotation !== expected.rotation) failure("PAGE_ROTATION_MISMATCH", { ...context, item: "rotation" });
  if (!close(observed.width, expected.width) || !close(observed.height, expected.height)) {
    failure("PAGE_GEOMETRY_MISMATCH", { ...context, item: "dimensions" });
  }
}

async function inspect(handle: PdfDocumentHandle, number: number, signal: AbortSignal, context: PdfExportDiagnosticContext, delta = 0, includeRenderSignature = false): Promise<Inspection> {
  let result: Inspection | undefined;
  try {
    signal.throwIfAborted();
    if (!handle.inspectPage) failure("INSPECTION_FAILURE", context);
    result = includeRenderSignature ? await handle.inspectPage(number, signal, delta, true)
      : await handle.inspectPage(number, signal, delta);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    eraseVisualSample(result);
    if (signal.aborted) throw signal.reason;
    if (isCancellation(error)) throw error;
    if (error instanceof PdfExportDiagnosticError) {
      // The adapter knows which operation failed; the validator knows the mapping.
      throw error.withContext({ stage: context.stage, outputPage: context.outputPage, sourcePage: context.sourcePage });
    }
    failure("INSPECTION_FAILURE", context);
  }
}

/** Compare independent PDF.js source/output observations, including image-only pages. */
export async function validateEditedPdf(source: PdfDocumentHandle, output: PdfDocumentHandle, pages: readonly PdfEditPage[], signal: AbortSignal,
  integrity?: readonly PdfPageIntegrityEvidence[]): Promise<void> {
  let context: PdfExportDiagnosticContext = { stage: "validating", item: "page-count" };
  try {
    signal.throwIfAborted();
    if (!pages.length || pages.length !== output.pages.length) failure("PAGE_COUNT_MISMATCH", context);
    const seen = new Set<number>();
    for (const [index, page] of pages.entries()) {
      signal.throwIfAborted();
      context = { stage: "validating", item: "source-page", outputPage: index + 1, sourcePage: page.sourcePageNumber };
      const original = source.pages[page.sourcePageNumber - 1];
      const written = output.pages[index];
      if (!original || !Number.isInteger(page.sourcePageNumber) || seen.has(page.sourcePageNumber)) failure("INSPECTION_FAILURE", context);
      if (!quarterTurn(page.rotationDelta) || !quarterTurn(page.originalRotation) || !quarterTurn(original.rotation) ||
        normalizeRotation(original.rotation) !== normalizeRotation(page.originalRotation)) {
        failure("PAGE_ROTATION_MISMATCH", { ...context, item: "rotation" });
      }
      seen.add(page.sourcePageNumber);
      const expected = getEditedPageInfo(page, original, index + 1);
      if (expected.rotation !== normalizeRotation(written.rotation)) failure("PAGE_ROTATION_MISMATCH", { ...context, item: "rotation" });
      if (!close(expected.width, written.width) || !close(expected.height, written.height)) {
        failure("PAGE_GEOMETRY_MISMATCH", { ...context, item: "dimensions" });
      }
      if (expected.orientation !== written.orientation) failure("PAGE_GEOMETRY_MISMATCH", { ...context, item: "orientation" });
      // Samples are bounded scratch for diagnostics and erased after this pair.
      let before: Inspection | undefined;
      let after: Inspection | undefined;
      try {
        context = { ...context, stage: "source-inspection", item: "page" };
        before = await inspect(source, page.sourcePageNumber, signal, context, page.rotationDelta);
        inspectGeometry(before, expected, context);
        context = { ...context, stage: "output-inspection" };
        after = await inspect(output, index + 1, signal, context);
        inspectGeometry(after, expected, context);
        context = { ...context, stage: "validating" };
        if (typeof before.textDigest !== "string" || !before.textDigest || before.textDigest !== after.textDigest) {
          failure("TEXT_CONTENT_MISMATCH", { ...context, item: "text" });
        }
        if (typeof before.visualDigest !== "string" || !before.visualDigest || before.visualDigest !== after.visualDigest) {
          const difference = visualDifference(before, after);
          // One repeat diagnoses render stability; it never turns a mismatch into success.
          if (difference) {
            let repeatedSource: Inspection | undefined;
            let repeatedOutput: Inspection | undefined;
            try {
              repeatedSource = await inspect(source, page.sourcePageNumber, signal,
                { ...context, stage: "source-inspection" }, page.rotationDelta, true);
              difference.sourceStable = repeatedSource.visualDigest === before.visualDigest;
              eraseVisualSample(repeatedSource);
              repeatedOutput = await inspect(output, index + 1, signal, { ...context, stage: "output-inspection" }, 0, true);
              difference.outputStable = repeatedOutput.visualDigest === after.visualDigest;
              Object.assign(difference, renderSignatureDifference(repeatedSource, repeatedOutput));
            } catch (error) {
              if (signal.aborted) throw signal.reason;
              if (isCancellation(error)) throw error;
              // Keep the original mismatch if additional diagnostics are unavailable.
            } finally {
              eraseVisualSample(repeatedSource);
              eraseVisualSample(repeatedOutput);
            }
          }
          failure("VISUAL_CONTENT_MISMATCH", { ...context, item: "visual", visualDifference: difference,
            contentIntegrity: integrity?.[index] });
        }
      } finally {
        eraseVisualSample(before);
        eraseVisualSample(after);
      }
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (isCancellation(error) || error instanceof PdfExportDiagnosticError) throw error;
    failure("INSPECTION_FAILURE", context);
  }
}
