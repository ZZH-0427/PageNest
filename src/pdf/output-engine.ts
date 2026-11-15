import { loadPdfLibrary } from "./pdf-library";
import type { PDFDict, PDFDocument, PDFObject, PDFRef } from "pdf-lib";
import { normalizeRotation, type PdfEditPage } from "./edit";
import { copyEditedPages } from "./export-copy";
import { generateEditedPdf } from "./export";
import { PdfExportDiagnosticError } from "./export-diagnostics";
import { validateEditedPdf } from "./export-validation";
import { MAX_PLAN_INPUT_BYTES, MAX_PLAN_OUTPUT_BYTES, MAX_PLAN_OUTPUT_PAGES, type PdfOutputDefinition } from "./output-plan";
import { isCancellation, MAX_PDF_FILES, MAX_PDF_FILE_BYTES, MAX_PDF_PAGES, PdfUserError, type PdfDocumentHandle, type PdfPageInfo } from "./types";
import { validatePdfHeader } from "./validation";

export interface PdfOutputSource {
  documentId: string;
  bytes: Uint8Array;
  originalPages: readonly PdfPageInfo[];
}

type PdfLibrary = typeof import("pdf-lib");
const MAX_LAYER_GROUPS = 1000;
const MAX_LAYER_ORDER_ITEMS = 10_000;
const invalidPlan = () => new PdfUserError("输出计划或来源页面无效，未生成文件。请重新选择文档和页面。");
const unsupportedLayers = () => new PdfUserError("合并来源包含暂不支持的复杂 PDF 图层配置，未生成文件。请分别导出，或使用支持该结构的 PDF 工具。");
const quarterTurn = (value: number) => Number.isSafeInteger(value) && value % 90 === 0;
const nonempty = (value: unknown) => typeof value === "string" && !!value.trim();

function validateSources(sources: readonly PdfOutputSource[], pages: readonly PdfEditPage[]): Map<string, PdfOutputSource> {
  if (!sources.length || sources.length > MAX_PDF_FILES || !pages.length || pages.length > MAX_PLAN_OUTPUT_PAGES) throw invalidPlan();
  const byId = new Map<string, PdfOutputSource>();
  let bytes = 0;
  for (const source of sources) {
    if (!nonempty(source.documentId) || byId.has(source.documentId) || !(source.bytes instanceof Uint8Array) ||
      !source.bytes.byteLength || source.bytes.byteLength > MAX_PDF_FILE_BYTES ||
      !source.originalPages.length || source.originalPages.length > MAX_PDF_PAGES) throw invalidPlan();
    bytes += source.bytes.byteLength;
    if (bytes > MAX_PLAN_INPUT_BYTES) throw new PdfUserError("合并来源总容量超过 128 MiB，未生成文件。请减少参与文档。");
    validatePdfHeader(source.bytes.subarray(0, 1024));
    for (const [index, page] of source.originalPages.entries()) {
      if (page.number !== index + 1 || !quarterTurn(page.rotation) ||
        ![page.width, page.height].every((value) => Number.isFinite(value) && value > 0 && value <= 144_000) ||
        page.orientation !== (page.width === page.height ? "square" : page.width > page.height ? "landscape" : "portrait")) throw invalidPlan();
    }
    byId.set(source.documentId, source);
  }
  const ids = new Set<string>();
  const used = new Map<string, Set<number>>();
  for (const page of pages) {
    const source = byId.get(page.sourceDocumentId);
    const original = source?.originalPages[page.sourcePageNumber - 1];
    const numbers = used.get(page.sourceDocumentId) ?? new Set<number>();
    if (!nonempty(page.id) || !nonempty(page.sourceDocumentId) || ids.has(page.id) || !Number.isInteger(page.sourcePageNumber) || !original ||
      numbers.has(page.sourcePageNumber) || !quarterTurn(page.originalRotation) || !quarterTurn(page.rotationDelta) ||
      normalizeRotation(page.originalRotation) !== normalizeRotation(original.rotation)) throw invalidPlan();
    ids.add(page.id); numbers.add(page.sourcePageNumber); used.set(page.sourceDocumentId, numbers);
  }
  if (used.size !== byId.size) throw invalidPlan();
  return byId;
}

interface LayerState { groups: PDFRef[]; on: PDFRef[]; off: PDFRef[]; order: PDFObject[] }

/** Accept only explicit, bounded default layer states; never guess at usage or alternate configurations. */
function basicLayerState(document: PDFDocument, library: PdfLibrary, signal: AbortSignal): LayerState | undefined {
  const { PDFName, PDFDict, PDFArray, PDFRef, PDFString, PDFHexString } = library;
  const key = (name: string) => PDFName.of(name);
  const raw = document.catalog.get(key("OCProperties"), true);
  if (raw === undefined) return undefined;
  const lookup = (object: PDFObject | undefined) => document.context.lookup(object);
  const properties = lookup(raw);
  const onlyKeys = (dictionary: PDFDict, allowed: readonly string[]) => {
    if (dictionary.keys().some((name) => !allowed.includes(name.decodeText()))) throw unsupportedLayers();
  };
  if (!(properties instanceof PDFDict)) throw unsupportedLayers();
  onlyKeys(properties, ["OCGs", "D"]);
  const list = lookup(properties.get(key("OCGs"), true));
  if (!(list instanceof PDFArray) || list.size() > MAX_LAYER_GROUPS) throw unsupportedLayers();
  const groups: PDFRef[] = [];
  const groupIds = new Set<string>();
  for (let index = 0; index < list.size(); index++) {
    signal.throwIfAborted();
    const ref = list.get(index);
    const group = lookup(ref);
    if (!(ref instanceof PDFRef) || !(group instanceof PDFDict) || groupIds.has(String(ref))) throw unsupportedLayers();
    onlyKeys(group, ["Type", "Name", "Intent"]);
    if (lookup(group.get(key("Type"))) !== key("OCG")) throw unsupportedLayers();
    const name = lookup(group.get(key("Name"), true));
    if (!(name instanceof PDFString || name instanceof PDFHexString)) throw unsupportedLayers();
    const intent = lookup(group.get(key("Intent"), true));
    if (intent !== undefined && intent !== key("View") && !(intent instanceof PDFArray && intent.size() === 1 && lookup(intent.get(0)) === key("View"))) throw unsupportedLayers();
    groups.push(ref); groupIds.add(String(ref));
  }
  const defaultRaw = properties.get(key("D"), true);
  const config = lookup(defaultRaw);
  if (defaultRaw !== undefined && !(config instanceof PDFDict)) throw unsupportedLayers();
  if (config instanceof PDFDict) onlyKeys(config, ["Name", "Creator", "BaseState", "ON", "OFF", "Order"]);
  const get = (name: string) => config instanceof PDFDict ? lookup(config.get(key(name), true)) : undefined;
  for (const name of ["Name", "Creator"]) {
    const value = get(name);
    if (value !== undefined && !(value instanceof PDFString || value instanceof PDFHexString)) throw unsupportedLayers();
  }
  const base = get("BaseState");
  if (base !== undefined && base !== key("ON") && base !== key("OFF")) throw unsupportedLayers();
  const visible = new Set(base === key("OFF") ? [] : groupIds);
  const states = new Set<string>();
  for (const name of ["ON", "OFF"]) {
    const values = get(name);
    if (values === undefined) continue;
    if (!(values instanceof PDFArray) || values.size() > MAX_LAYER_GROUPS) throw unsupportedLayers();
    for (let index = 0; index < values.size(); index++) {
      const ref = values.get(index), id = String(ref);
      if (!(ref instanceof PDFRef) || !groupIds.has(id) || states.has(id)) throw unsupportedLayers();
      states.add(id);
      if (name === "ON") visible.add(id); else visible.delete(id);
    }
  }
  const ordering = get("Order");
  let count = 0;
  const ancestors = new Set<PDFObject>();
  const inspectOrder = (value: PDFObject, depth: number) => {
    signal.throwIfAborted();
    if (++count > MAX_LAYER_ORDER_ITEMS || depth > 16) throw unsupportedLayers();
    if (value instanceof PDFRef && groupIds.has(String(value))) return;
    const object = lookup(value);
    if (object instanceof PDFString || object instanceof PDFHexString) return;
    if (!(object instanceof PDFArray) || ancestors.has(object)) throw unsupportedLayers();
    ancestors.add(object);
    for (let index = 0; index < object.size(); index++) inspectOrder(object.get(index), depth + 1);
    ancestors.delete(object);
  };
  if (ordering !== undefined) {
    if (!(ordering instanceof PDFArray)) throw unsupportedLayers();
    inspectOrder(ordering, 0);
  }
  return { groups, on: groups.filter((ref) => visible.has(String(ref))), off: groups.filter((ref) => !visible.has(String(ref))),
    order: ordering instanceof PDFArray ? ordering.asArray() : groups };
}

function mergeLayerStates(output: PDFDocument, states: readonly LayerState[], library: PdfLibrary) {
  if (!states.length) return;
  const groups = states.flatMap((state) => state.groups);
  if (groups.length > MAX_LAYER_GROUPS) throw unsupportedLayers();
  output.catalog.set(library.PDFName.of("OCProperties"), output.context.obj({
    OCGs: groups,
    D: { BaseState: "ON", ON: states.flatMap((state) => state.on), OFF: states.flatMap((state) => state.off),
      Order: states.flatMap((state) => state.order) },
  }));
}

/** Incremental extension: one-source outputs keep the existing generation path. */
export async function generatePlannedPdf(inputs: readonly PdfOutputSource[], definition: PdfOutputDefinition, signal: AbortSignal): Promise<Uint8Array> {
  let generated: Uint8Array | undefined;
  try {
    signal.throwIfAborted();
    const pages = definition.pages.map((page) => ({ ...page }));
    const sources = inputs.map((source) => ({ ...source, originalPages: source.originalPages.map((page) => ({ ...page })) }));
    const byId = validateSources(sources, pages);
    if (byId.size === 1) {
      const source = sources[0];
      generated = await generateEditedPdf(source.bytes, { documentId: source.documentId, pages, originalPages: source.originalPages }, signal);
      signal.throwIfAborted();
      if (generated.byteLength > MAX_PLAN_OUTPUT_BYTES) throw new PdfUserError("生成结果超过 100 MiB，未提供下载。");
      return generated;
    }
    const library = await loadPdfLibrary();
    signal.throwIfAborted();
    const output = await library.PDFDocument.create({ updateMetadata: false });
    const copiedByPage = new Map<string, Map<number, Awaited<ReturnType<typeof copyEditedPages>>[number]>>();
    const layers: LayerState[] = [];
    for (const source of sources) {
      signal.throwIfAborted();
      const document = await library.PDFDocument.load(source.bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: true });
      signal.throwIfAborted();
      if (document.getPageCount() !== source.originalPages.length) throw invalidPlan();
      basicLayerState(document, library, signal);
      const selected = pages.filter((page) => page.sourceDocumentId === source.documentId);
      // Each source gets one shared copier; references never cross source contexts.
      output.catalog.delete(library.PDFName.of("OCProperties"));
      const copied = await copyEditedPages(document, output, selected.map((page) => page.sourcePageNumber - 1), library, signal);
      const state = basicLayerState(output, library, signal);
      if (state) layers.push(state);
      const mapped = new Map<number, typeof copied[number]>();
      for (const [index, page] of copied.entries()) {
        const edit = selected[index];
        if (normalizeRotation(page.getRotation().angle) !== normalizeRotation(edit.originalRotation)) throw invalidPlan();
        page.setRotation(library.degrees(normalizeRotation(edit.originalRotation + edit.rotationDelta)));
        mapped.set(edit.sourcePageNumber, page);
      }
      copiedByPage.set(source.documentId, mapped);
    }
    output.catalog.delete(library.PDFName.of("OCProperties"));
    mergeLayerStates(output, layers, library);
    for (const page of pages) {
      signal.throwIfAborted();
      const copied = copiedByPage.get(page.sourceDocumentId)?.get(page.sourcePageNumber);
      if (!copied) throw invalidPlan();
      output.addPage(copied);
    }
    generated = await output.save({ addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: 50 });
    signal.throwIfAborted();
    if (generated.byteLength > MAX_PLAN_OUTPUT_BYTES) throw new PdfUserError("生成结果超过 100 MiB，未提供下载。");
    validatePdfHeader(generated.subarray(0, 1024));
    return generated;
  } catch (error) {
    generated?.fill(0);
    if (signal.aborted) throw signal.reason;
    if (isCancellation(error) || error instanceof PdfUserError) throw error;
    throw new PdfUserError("无法生成输出 PDF，文件可能包含不兼容结构或浏览器内存不足。未提供下载。");
  }
}

/** Bind each output position to its fresh source handle and retain every existing strict check. */
export async function validatePlannedPdf(sources: ReadonlyMap<string, PdfDocumentHandle>, output: PdfDocumentHandle,
  pages: readonly PdfEditPage[], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!pages.length || pages.length > MAX_PLAN_OUTPUT_PAGES || output.pages.length !== pages.length) {
    throw new PdfExportDiagnosticError("PAGE_COUNT_MISMATCH", { stage: "validating", item: "page-count" });
  }
  const ids = new Set<string>();
  const used = new Map<string, Set<number>>();
  for (const [index, page] of pages.entries()) {
    signal.throwIfAborted();
    const context = { stage: "validating" as const, item: "source-page" as const, outputPage: index + 1, sourcePage: page.sourcePageNumber };
    try {
      const source = sources.get(page.sourceDocumentId);
      const numbers = used.get(page.sourceDocumentId) ?? new Set<number>();
      if (!source || !nonempty(page.id) || !nonempty(page.sourceDocumentId) || ids.has(page.id) || numbers.has(page.sourcePageNumber)) {
        throw new PdfExportDiagnosticError("INSPECTION_FAILURE", context);
      }
      ids.add(page.id); numbers.add(page.sourcePageNumber); used.set(page.sourceDocumentId, numbers);
      const isolatedOutput: PdfDocumentHandle = {
        pages: [output.pages[index]],
        render: (_number, canvas, currentSignal, delta) => output.render(index + 1, canvas, currentSignal, delta),
        ...(output.inspectPage ? { inspectPage: (_number: number, currentSignal: AbortSignal, delta?: number, signatures?: boolean) =>
          output.inspectPage!(index + 1, currentSignal, delta, signatures) } : {}),
        // This borrowed position view never owns or destroys the shared handle.
        destroy: async () => {},
      };
      await validateEditedPdf(source, isolatedOutput, [page], signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (isCancellation(error)) throw error;
      if (error instanceof PdfExportDiagnosticError) throw error.withContext({ outputPage: index + 1, sourcePage: page.sourcePageNumber });
      throw new PdfExportDiagnosticError("INSPECTION_FAILURE", context);
    }
  }
}
