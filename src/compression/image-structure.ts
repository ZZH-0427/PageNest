import type { PDFContext, PDFDocument, PDFObject, PDFRef } from "pdf-lib";
import { loadPdfLibrary } from "../pdf/pdf-library";
import { PdfUserError } from "../pdf/types";
import { acceptableImageQuality, IMAGE_LIMITS, IMAGE_PROFILES, inspectJpegImage, type ImageProfile, type ImageQualityMetrics, type JpegCodec } from "./image-types";

type Library = typeof import("pdf-lib");
const failure = () => new PdfUserError("图像压缩结果未通过非目标内容或图像质量检查，未提供下载。");
export interface ImageStructureResult {
  changedImages: number;
  maskedSource?: Uint8Array;
  maskedOutput?: Uint8Array;
  qualityMetrics: readonly ImageQualityMetrics[];
}
interface Changed { source: PDFRef; output: PDFRef; metrics: ImageQualityMetrics }

/** Direct references, aliasing, cycles and all non-target object data must correspond. */
class Comparison {
  forward = new Map<string, string>();
  backward = new Map<string, string>();
  changed: Changed[] = [];
  nodes = 0;
  bytes = 0;
  direct = new Set<PDFObject>();
  end = performance.now() + 30_000;
  constructor(private source: PDFContext, private output: PDFContext, private library: Library,
    private signal: AbortSignal, private codec: JpegCodec, private profile: ImageProfile) {}
  check(depth = 0) {
    this.signal.throwIfAborted();
    if (++this.nodes > 100_000 || depth > 128 || performance.now() > this.end) throw failure();
  }
  async equal(a: PDFObject | undefined, b: PDFObject | undefined, depth = 0, refs?: [PDFRef, PDFRef]): Promise<boolean> {
    this.check(depth);
    const L = this.library;
    if (a === undefined || b === undefined) return a === b;
    if (a instanceof L.PDFRef || b instanceof L.PDFRef) {
      if (!(a instanceof L.PDFRef && b instanceof L.PDFRef)) return false;
      const first = String(a), second = String(b);
      if (this.forward.has(first)) return this.forward.get(first) === second;
      if (this.backward.has(second)) return false;
      this.forward.set(first, second); this.backward.set(second, first);
      const left = this.source.lookup(a), right = this.output.lookup(b);
      if (!left || !right) throw failure();
      return this.equal(left, right, depth + 1, [a, b]);
    }
    if (a === L.PDFNull || b === L.PDFNull) return a === b;
    if (a instanceof L.PDFNumber || b instanceof L.PDFNumber) return a instanceof L.PDFNumber && b instanceof L.PDFNumber && Number.isFinite(a.asNumber()) && a.asNumber() === b.asNumber();
    if (a instanceof L.PDFBool || b instanceof L.PDFBool) return a instanceof L.PDFBool && b instanceof L.PDFBool && a.asBoolean() === b.asBoolean();
    if (a instanceof L.PDFName || b instanceof L.PDFName) return a instanceof L.PDFName && b instanceof L.PDFName && a.asString() === b.asString();
    if (a instanceof L.PDFString || a instanceof L.PDFHexString || b instanceof L.PDFString || b instanceof L.PDFHexString) {
      return (a instanceof L.PDFString || a instanceof L.PDFHexString) && (b instanceof L.PDFString || b instanceof L.PDFHexString) && await this.sameBytes(a.asBytes(), b.asBytes());
    }
    if (a instanceof L.PDFRawStream || b instanceof L.PDFRawStream) {
      if (!(a instanceof L.PDFRawStream && b instanceof L.PDFRawStream)) return false;
      if (!await this.dict(a.dict, b.dict, depth + 1, true)) return false;
      if (await this.sameBytes(a.getContents(), b.getContents())) return true;
      // Actual reparsed JPEG streams, not the generator's claimed target list.
      const original = inspectJpegImage(a), result = inspectJpegImage(b);
      if (!refs || !original || !result || original.width !== result.width || original.height !== result.height ||
        this.changed.length >= IMAGE_LIMITS.maximumImages || b.getContentsSize() >= a.getContentsSize()) return false;
      const leftBytes = a.getContents().slice(), rightBytes = b.getContents().slice();
      let metrics: ImageQualityMetrics;
      try { metrics = await this.codec.compare(leftBytes, rightBytes, original.width, original.height, this.signal); }
      finally { leftBytes.fill(0); rightBytes.fill(0); }
      this.check(depth);
      if (!acceptableImageQuality(metrics, this.profile)) return false;
      this.changed.push({ source: refs[0], output: refs[1], metrics });
      return true;
    }
    if (this.direct.has(a) || this.direct.has(b)) throw failure();
    this.direct.add(a); this.direct.add(b);
    try {
      if (a instanceof L.PDFArray || b instanceof L.PDFArray) {
        if (!(a instanceof L.PDFArray && b instanceof L.PDFArray) || a.size() !== b.size()) return false;
        for (let i = 0; i < a.size(); i++) if (!await this.equal(a.get(i), b.get(i), depth + 1)) return false;
        return true;
      }
      return a instanceof L.PDFDict && b instanceof L.PDFDict && await this.dict(a, b, depth + 1);
    } finally { this.direct.delete(a); this.direct.delete(b); }
  }
  private async sameBytes(a: Uint8Array, b: Uint8Array) {
    this.bytes += a.byteLength + b.byteLength;
    if (this.bytes > 256 * 1024 ** 2) throw failure();
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) { mismatch |= a[i] ^ b[i]; if (i % 65536 === 0) this.signal.throwIfAborted(); }
    return mismatch === 0;
  }
  private async dict(a: import("pdf-lib").PDFDict, b: import("pdf-lib").PDFDict, depth: number, stream = false) {
    const keys = (d: import("pdf-lib").PDFDict) => d.keys().filter((key) => !stream || key.asString() !== "/Length").sort((x, y) => x.asString().localeCompare(y.asString()));
    const left = keys(a), right = keys(b);
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) if (left[i].asString() !== right[i].asString() || !await this.equal(a.get(left[i], true), b.get(right[i], true), depth + 1)) return false;
    return true;
  }
}

export function assertImageDocumentPolicy(document: PDFDocument, library: Library) {
  if (document.context.trailerInfo.Encrypt || ["AcroForm", "Perms", "Collection", "NeedsRendering", "OpenAction", "AA"].some((name) => document.catalog.has(library.PDFName.of(name)))) {
    throw new PdfUserError("此 PDF 含加密、表单、签名或交互结构，当前图像压缩不支持；请保留原文件。");
  }
  const names = document.catalog.lookupMaybe(library.PDFName.of("Names"), library.PDFDict);
  if (names && ["EmbeddedFiles", "JavaScript"].some((name) => names.has(library.PDFName.of(name)))) {
    throw new PdfUserError("此 PDF 含附件或脚本，当前图像压缩不支持；请保留原文件。");
  }
  const contextFailure = () => new PdfUserError("此 PDF 含图层或透明混合上下文，当前图像优化无法安全验证；可尝试无损优化。");
  if (document.catalog.has(library.PDFName.of("OCProperties"))) throw contextFailure();
  const visited = new Set<PDFObject>();
  let nodes = 0;
  const walk = (raw: PDFObject | undefined, depth = 0) => {
    if (!raw || visited.has(raw)) return;
    visited.add(raw);
    if (++nodes > 100_000 || depth > 128) throw contextFailure();
    const object = raw instanceof library.PDFRef ? document.context.lookup(raw) : raw;
    if (!object) throw contextFailure();
    if (object instanceof library.PDFRawStream) { walk(object.dict, depth + 1); return; }
    if (object instanceof library.PDFArray) { for (const item of object.asArray()) walk(item, depth + 1); return; }
    if (!(object instanceof library.PDFDict)) return;
    if (String(object.get(library.PDFName.of("S"))) === "/Transparency") throw contextFailure();
    const states = object.get(library.PDFName.of("ExtGState"));
    if (states) {
      const dictionary = document.context.lookup(states);
      if (!(dictionary instanceof library.PDFDict)) throw contextFailure();
      for (const [, value] of dictionary.entries()) {
        const state = document.context.lookup(value);
        if (!(state instanceof library.PDFDict)) throw contextFailure();
        for (const alpha of ["ca", "CA"]) {
          const opacity = document.context.lookup(state.get(library.PDFName.of(alpha)));
          if (opacity !== undefined && (!(opacity instanceof library.PDFNumber) || opacity.asNumber() !== 1)) throw contextFailure();
        }
        const blend = state.get(library.PDFName.of("BM")), mask = state.get(library.PDFName.of("SMask"));
        if (blend && !["/Normal", "/Compatible"].includes(String(blend)) || mask && String(mask) !== "/None") throw contextFailure();
        if (["TR", "TR2", "BG", "BG2", "UCR", "UCR2"].some((key) => state.has(library.PDFName.of(key)))) throw contextFailure();
      }
    }
    for (const [, value] of object.entries()) walk(value, depth + 1);
  };
  for (const [, object] of document.context.enumerateIndirectObjects()) walk(object);
}

/** Independent serialized graph verification plus masked payloads for PDF.js validation. */
async function verifyStructure(sourceBytes: Uint8Array, outputBytes: Uint8Array, profile: ImageProfile,
  signal: AbortSignal, codec: JpegCodec): Promise<ImageStructureResult> {
  signal.throwIfAborted();
  if (!Object.hasOwn(IMAGE_PROFILES, profile)) throw failure();
  const L = await loadPdfLibrary();
  const options = { updateMetadata: false, ignoreEncryption: false, throwOnInvalidObject: true };
  const source = await L.PDFDocument.load(sourceBytes, options), output = await L.PDFDocument.load(outputBytes, options);
  assertImageDocumentPolicy(source, L); assertImageDocumentPolicy(output, L);
  const graph = new Comparison(source.context, output.context, L, signal, codec, profile);
  for (const key of ["Root", "Info", "ID"] as const) {
    if (!await graph.equal(source.context.trailerInfo[key], output.context.trailerInfo[key])) throw failure();
  }
  signal.throwIfAborted();
  if (!graph.changed.length) return { changedImages: 0, qualityMetrics: [] };
  const mask = (document: PDFDocument, ref: PDFRef) => document.context.assign(ref,
    document.context.flateStream(new Uint8Array([128, 128, 128]), {
      Type: "XObject", Subtype: "Image", Width: 1, Height: 1, ColorSpace: "DeviceRGB", BitsPerComponent: 8,
    }));
  for (const item of graph.changed) { mask(source, item.source); mask(output, item.output); }
  let maskedSource: Uint8Array | undefined, maskedOutput: Uint8Array | undefined;
  try {
    maskedSource = await source.save({ useObjectStreams: true, updateFieldAppearances: false });
    signal.throwIfAborted();
    maskedOutput = await output.save({ useObjectStreams: true, updateFieldAppearances: false });
    signal.throwIfAborted();
    return { changedImages: graph.changed.length, maskedSource, maskedOutput, qualityMetrics: graph.changed.map(({ metrics }) => metrics) };
  } catch (error) { maskedSource?.fill(0); maskedOutput?.fill(0); throw error; }
}

export async function verifyJpegPdfStructure(sourceBytes: Uint8Array, outputBytes: Uint8Array, profile: ImageProfile,
  signal: AbortSignal, codec: JpegCodec): Promise<ImageStructureResult> {
  try { return await verifyStructure(sourceBytes, outputBytes, profile, signal, codec); }
  catch (error) {
    signal.throwIfAborted();
    if (error instanceof PdfUserError) throw error;
    throw failure();
  }
}
