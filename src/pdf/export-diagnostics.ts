import { MAX_PDF_PAGES, PdfUserError } from "./types";

const codes = [
  "PAGE_COUNT_MISMATCH", "PAGE_GEOMETRY_MISMATCH", "PAGE_ROTATION_MISMATCH",
  "TEXT_CONTENT_MISMATCH", "VISUAL_CONTENT_MISMATCH", "INSPECTION_FAILURE", "VALIDATION_TIMEOUT",
] as const;
const stages = [
  "preparing", "generating", "validating", "inspection", "source-inspection", "output-inspection", "source-open", "output-open", "cleanup",
] as const;
const items = ["page-count", "source-page", "dimensions", "orientation", "rotation", "text", "visual", "page", "deadline", "parser", "resources"] as const;
const rendererProbes = ["font-paths-match", "font-paths-mismatch", "font-paths-unavailable"] as const;
const nativeProbes = ["match", "mismatch", "unavailable"] as const;

export type PdfExportDiagnosticCode = typeof codes[number];
export type PdfExportDiagnosticStage = typeof stages[number];
export type PdfExportDiagnosticItem = typeof items[number];
export type PdfRendererProbe = typeof rendererProbes[number];
export type PdfRendererProbeStatus = typeof nativeProbes[number];
export interface PdfVisualDifference {
  sourceRasterWidth?: number;
  sourceRasterHeight?: number;
  outputRasterWidth?: number;
  outputRasterHeight?: number;
  totalPixels?: number;
  changedPixels?: number;
  maxChannelDelta?: number;
  meanAbsoluteDelta?: number;
  sourceStable?: boolean;
  outputStable?: boolean;
  viewportEqual?: boolean;
  graphicsEqual?: boolean;
}
export interface PdfContentIntegrity {
  contentsEqual?: boolean;
  resourcesEqual?: boolean;
  pageAttributesEqual?: boolean;
  annotationsEqual?: boolean;
  displayContextEqual?: boolean;
  complete?: boolean;
}
export interface PdfExportDiagnosticContext {
  stage: PdfExportDiagnosticStage;
  item: PdfExportDiagnosticItem;
  outputPage?: number;
  sourcePage?: number;
  visualDifference?: Readonly<PdfVisualDifference>;
  contentIntegrity?: Readonly<PdfContentIntegrity>;
  rendererProbe?: PdfRendererProbe;
  probeCode?: PdfExportDiagnosticCode;
  probeOutputPage?: number;
  probeSourcePage?: number;
  probeItem?: PdfExportDiagnosticItem;
  probeVisualDifference?: Readonly<PdfVisualDifference>;
  nativeProbe?: PdfRendererProbeStatus;
  nativeProbeCode?: PdfExportDiagnosticCode;
  nativeProbeOutputPage?: number;
  nativeProbeSourcePage?: number;
  nativeProbeItem?: PdfExportDiagnosticItem;
  nativeProbeVisualDifference?: Readonly<PdfVisualDifference>;
}
export interface PdfExportDiagnostic extends PdfExportDiagnosticContext {
  code: PdfExportDiagnosticCode;
}

const pageNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_PDF_PAGES ? value : undefined;

const visualNumberBounds = {
  sourceRasterWidth: [1, 128, true], sourceRasterHeight: [1, 128, true],
  outputRasterWidth: [1, 128, true], outputRasterHeight: [1, 128, true],
  totalPixels: [0, 16_384, true], changedPixels: [0, 16_384, true],
  maxChannelDelta: [0, 255, true], meanAbsoluteDelta: [0, 255, false],
} as const;

/** Ignore accessors/inherited fields; never keep the caller's diagnostic payload. */
function ownValue(value: object, key: string): unknown {
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; }
  catch { return undefined; }
}

function visualDifference(value: unknown): Readonly<PdfVisualDifference> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const safe: PdfVisualDifference = {};
  for (const key of Object.keys(visualNumberBounds) as (keyof typeof visualNumberBounds)[]) {
    const number = ownValue(value, key);
    const [minimum, maximum, integer] = visualNumberBounds[key];
    if (typeof number === "number" && Number.isFinite(number) && number >= minimum && number <= maximum &&
      (!integer || Number.isSafeInteger(number))) safe[key] = number;
  }
  for (const key of ["sourceStable", "outputStable", "viewportEqual", "graphicsEqual"] as const) {
    const boolean = ownValue(value, key);
    if (typeof boolean === "boolean") safe[key] = boolean;
  }
  return Object.keys(safe).length ? Object.freeze(safe) : undefined;
}

function contentIntegrity(value: unknown): Readonly<PdfContentIntegrity> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const safe: PdfContentIntegrity = {};
  for (const key of ["contentsEqual", "resourcesEqual", "pageAttributesEqual", "annotationsEqual", "displayContextEqual", "complete"] as const) {
    const boolean = ownValue(value, key);
    if (typeof boolean === "boolean") safe[key] = boolean;
  }
  return Object.keys(safe).length ? Object.freeze(safe) : undefined;
}

/** Only fixed enums, bounded numbers and booleans may enter user-visible diagnostics. */
export class PdfExportDiagnosticError extends PdfUserError {
  readonly diagnostic: Readonly<PdfExportDiagnostic>;

  constructor(code: PdfExportDiagnosticCode, context: PdfExportDiagnosticContext) {
    const safeCode = codes.includes(code) ? code : "INSPECTION_FAILURE";
    const stage = stages.includes(context.stage) ? context.stage : "validating";
    const item = items.includes(context.item) ? context.item : "page";
    const outputPage = pageNumber(context.outputPage);
    const sourcePage = pageNumber(context.sourcePage);
    const visual = visualDifference(context.visualDifference);
    const visualMessage = visual ? `; visualDifference={${Object.entries(visual).map(([key, value]) => `${key}=${value}`).join(",")}}` : "";
    const integrity = contentIntegrity(context.contentIntegrity);
    const integrityMessage = integrity ? `; contentIntegrity={${Object.entries(integrity).map(([key, value]) => `${key}=${value}`).join(",")}}` : "";
    const rendererProbe = context.rendererProbe && rendererProbes.includes(context.rendererProbe) ? context.rendererProbe : undefined;
    const rendererMessage = rendererProbe ? `; rendererProbe=${rendererProbe}` : "";
    const probeCode = context.probeCode && codes.includes(context.probeCode) ? context.probeCode : undefined;
    const probeOutputPage = pageNumber(context.probeOutputPage);
    const probeSourcePage = pageNumber(context.probeSourcePage);
    const probeItem = context.probeItem && items.includes(context.probeItem) ? context.probeItem : undefined;
    const probeVisual = visualDifference(context.probeVisualDifference);
    const probeMessage = (probeCode ? `; probeCode=${probeCode}` : "")
      + (probeOutputPage === undefined ? "" : `; probeOutputPage=${probeOutputPage}`)
      + (probeSourcePage === undefined ? "" : `; probeSourcePage=${probeSourcePage}`)
      + (probeItem ? `; probeItem=${probeItem}` : "")
      + (probeVisual ? `; probeVisualDifference={${Object.entries(probeVisual).map(([key, value]) => `${key}=${value}`).join(",")}}` : "");
    const nativeProbe = context.nativeProbe && nativeProbes.includes(context.nativeProbe) ? context.nativeProbe : undefined;
    const nativeProbeCode = context.nativeProbeCode && codes.includes(context.nativeProbeCode) ? context.nativeProbeCode : undefined;
    const nativeProbeOutputPage = pageNumber(context.nativeProbeOutputPage);
    const nativeProbeSourcePage = pageNumber(context.nativeProbeSourcePage);
    const nativeProbeItem = context.nativeProbeItem && items.includes(context.nativeProbeItem) ? context.nativeProbeItem : undefined;
    const nativeVisual = visualDifference(context.nativeProbeVisualDifference);
    const nativeMessage = (nativeProbe ? `; nativeProbe=${nativeProbe}` : "")
      + (nativeProbeCode ? `; nativeProbeCode=${nativeProbeCode}` : "")
      + (nativeProbeOutputPage === undefined ? "" : `; nativeProbeOutputPage=${nativeProbeOutputPage}`)
      + (nativeProbeSourcePage === undefined ? "" : `; nativeProbeSourcePage=${nativeProbeSourcePage}`)
      + (nativeProbeItem ? `; nativeProbeItem=${nativeProbeItem}` : "")
      + (nativeVisual ? `; nativeProbeVisualDifference={${Object.entries(nativeVisual).map(([key, value]) => `${key}=${value}`).join(",")}}` : "");
    const prefix = safeCode === "VALIDATION_TIMEOUT" ? "页面验证耗时过长，未提供下载。"
      : safeCode === "INSPECTION_FAILURE" ? "无法验证页面内容，未提供下载。" : "导出结果未通过检查，未提供下载。";
    super(`${prefix} [${safeCode}; phase=${stage}; outputPage=${outputPage ?? "-"}; sourcePage=${sourcePage ?? "-"}; item=${item}${visualMessage}${integrityMessage}${nativeMessage}${rendererMessage}${probeMessage}]`);
    this.name = "PdfExportDiagnosticError";
    this.diagnostic = Object.freeze({ code: safeCode, stage, item,
      ...(outputPage === undefined ? {} : { outputPage }),
      ...(sourcePage === undefined ? {} : { sourcePage }),
      ...(visual === undefined ? {} : { visualDifference: visual }),
      ...(integrity === undefined ? {} : { contentIntegrity: integrity }),
      ...(rendererProbe === undefined ? {} : { rendererProbe }),
      ...(probeCode === undefined ? {} : { probeCode }),
      ...(probeOutputPage === undefined ? {} : { probeOutputPage }),
      ...(probeSourcePage === undefined ? {} : { probeSourcePage }),
      ...(probeItem === undefined ? {} : { probeItem }),
      ...(probeVisual === undefined ? {} : { probeVisualDifference: probeVisual }),
      ...(nativeProbe === undefined ? {} : { nativeProbe }),
      ...(nativeProbeCode === undefined ? {} : { nativeProbeCode }),
      ...(nativeProbeOutputPage === undefined ? {} : { nativeProbeOutputPage }),
      ...(nativeProbeSourcePage === undefined ? {} : { nativeProbeSourcePage }),
      ...(nativeProbeItem === undefined ? {} : { nativeProbeItem }),
      ...(nativeVisual === undefined ? {} : { nativeProbeVisualDifference: nativeVisual }),
    });
  }

  get code(): PdfExportDiagnosticCode { return this.diagnostic.code; }

  /** Adds caller-owned location without retaining the caught error or its payload. */
  withContext(context: Partial<PdfExportDiagnosticContext>): PdfExportDiagnosticError {
    return new PdfExportDiagnosticError(this.code, { ...this.diagnostic, ...context });
  }
}
