import type { PDFContext, PDFDict, PDFDocument, PDFObject, PDFRawStream } from "pdf-lib";
import type { PdfEditPage } from "./edit";

export interface PdfPageIntegrityEvidence {
  contentsEqual: boolean;
  resourcesEqual: boolean;
  pageAttributesEqual: boolean;
  annotationsEqual: boolean;
  displayContextEqual: boolean;
  /** All categories and their shared reference graph match, with no unknown or exhausted limit. */
  complete: boolean;
}

type PdfLibrary = typeof import("pdf-lib");
interface IntegrityLimits { nodes: number; depth: number; streamBytes: number; stringBytes: number; milliseconds: number }
const DEFAULT_LIMITS: IntegrityLimits = { nodes: 250_000, depth: 128, streamBytes: 256 * 1024 ** 2, stringBytes: 8 * 1024 ** 2, milliseconds: 15_000 };
const emptyEvidence = (): PdfPageIntegrityEvidence => ({ contentsEqual: false, resourcesEqual: false, pageAttributesEqual: false,
  annotationsEqual: false, displayContextEqual: false, complete: false });
const normalize = (angle: number) => ((angle % 360) + 360) % 360;
const unsupported = () => new Error("PDF structure comparison unavailable");

class Budget {
  nodes = 0;
  streamBytes = 0;
  stringBytes = 0;
  readonly limits: IntegrityLimits;
  readonly end: number;
  readonly hashes = new WeakMap<PDFRawStream, Promise<Uint8Array>>();
  constructor(readonly signal: AbortSignal, lowerLimits: Partial<IntegrityLimits>) {
    this.limits = { ...DEFAULT_LIMITS };
    for (const key of Object.keys(DEFAULT_LIMITS) as (keyof IntegrityLimits)[]) {
      const value = lowerLimits[key];
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value <= 0) throw unsupported();
        this.limits[key] = Math.min(value, DEFAULT_LIMITS[key]);
      }
    }
    this.end = performance.now() + this.limits.milliseconds;
  }
  check() {
    this.signal.throwIfAborted();
    if (performance.now() >= this.end) throw unsupported();
  }
  async visit(depth: number) {
    this.check();
    if (++this.nodes > this.limits.nodes || depth > this.limits.depth) throw unsupported();
    if (this.nodes % 512 === 0) { await new Promise<void>((resolve) => setTimeout(resolve, 0)); this.check(); }
  }
  strings(bytes: number) {
    this.stringBytes += bytes;
    if (this.stringBytes > this.limits.stringBytes) throw unsupported();
  }
  async wait<T>(promise: Promise<T>): Promise<T> {
    this.check();
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(this.signal.reason);
      const timer = setTimeout(() => reject(unsupported()), Math.max(1, this.end - performance.now()));
      this.signal.addEventListener("abort", abort, { once: true });
      promise.then(resolve, reject).finally(() => { clearTimeout(timer); this.signal.removeEventListener("abort", abort); });
      if (this.signal.aborted) abort();
    });
  }
  hash(stream: PDFRawStream): Promise<Uint8Array> {
    const existing = this.hashes.get(stream);
    if (existing) return existing;
    const data = stream.getContents();
    this.streamBytes += data.byteLength;
    if (this.streamBytes > this.limits.streamBytes) throw unsupported();
    // Never zero or mutate the parser's source bytes. Only this temporary copy is owned here.
    const copy = new Uint8Array(data);
    const pending = this.wait(crypto.subtle.digest("SHA-256", copy)).then((hash) => new Uint8Array(hash)).finally(() => copy.fill(0));
    this.hashes.set(stream, pending);
    return pending;
  }
}

interface Side {
  context: PDFContext;
  normalizedPages: Map<PDFDict, PDFDict>;
}
const bytesEqual = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((byte, index) => byte === right[index]);

/** Reference numbers are arbitrary, but aliasing and cycles must have a bijective correspondence. */
class GraphComparison {
  private forward = new Map<string, string>();
  private backward = new Map<string, string>();
  private directAncestors = new Set<PDFObject>();
  constructor(private left: Side, private right: Side, private library: PdfLibrary, private budget: Budget) {}

  async equal(left: PDFObject | undefined, right: PDFObject | undefined, depth = 0): Promise<boolean> {
    await this.budget.visit(depth);
    const { PDFRef, PDFRawStream, PDFDict, PDFArray, PDFName, PDFString, PDFHexString, PDFBool, PDFNumber, PDFNull } = this.library;
    if (left === undefined || right === undefined) return left === right;
    if (left instanceof PDFRef || right instanceof PDFRef) {
      if (!(left instanceof PDFRef && right instanceof PDFRef)) return false;
      const first = String(left), second = String(right);
      if (this.forward.has(first)) return this.forward.get(first) === second;
      if (this.backward.has(second)) return false;
      this.forward.set(first, second); this.backward.set(second, first);
      const source = this.left.context.lookup(left), output = this.right.context.lookup(right);
      if (!source || !output) throw unsupported();
      return this.equal(source, output, depth + 1);
    }
    if (left === PDFNull || right === PDFNull) return left === right;
    if (left instanceof PDFNumber || right instanceof PDFNumber) {
      if (!(left instanceof PDFNumber && right instanceof PDFNumber)) return false;
      const first = left.asNumber(), second = right.asNumber();
      if (!Number.isFinite(first) || !Number.isFinite(second)) throw unsupported();
      return first === second;
    }
    if (left instanceof PDFBool || right instanceof PDFBool) return left instanceof PDFBool && right instanceof PDFBool && left.asBoolean() === right.asBoolean();
    if (left instanceof PDFName || right instanceof PDFName) {
      if (!(left instanceof PDFName && right instanceof PDFName)) return false;
      this.budget.strings(left.asString().length + right.asString().length);
      return left.asString() === right.asString();
    }
    if (left instanceof PDFString || left instanceof PDFHexString || right instanceof PDFString || right instanceof PDFHexString) {
      if (!((left instanceof PDFString || left instanceof PDFHexString) && (right instanceof PDFString || right instanceof PDFHexString))) return false;
      const first = left.asBytes(), second = right.asBytes();
      this.budget.strings(first.length + second.length);
      return bytesEqual(first, second);
    }
    if (left instanceof PDFRawStream || right instanceof PDFRawStream) {
      if (!(left instanceof PDFRawStream && right instanceof PDFRawStream)) return false;
      if (left.getContentsSize() !== right.getContentsSize()) return false;
      const first = await this.budget.hash(left), second = await this.budget.hash(right);
      return bytesEqual(first, second) && this.dict(left.dict, right.dict, depth + 1, true);
    }
    if (this.directAncestors.has(left) || this.directAncestors.has(right)) throw unsupported();
    this.directAncestors.add(left); this.directAncestors.add(right);
    try {
      if (left instanceof PDFArray || right instanceof PDFArray) {
        if (!(left instanceof PDFArray && right instanceof PDFArray) || left.size() !== right.size()) return false;
        for (let index = 0; index < left.size(); index++) if (!await this.equal(left.get(index), right.get(index), depth + 1)) return false;
        return true;
      }
      if (left instanceof PDFDict || right instanceof PDFDict) {
        if (!(left instanceof PDFDict && right instanceof PDFDict)) return false;
        return await this.dict(this.left.normalizedPages.get(left) ?? left, this.right.normalizedPages.get(right) ?? right, depth + 1);
      }
      throw unsupported();
    } finally { this.directAncestors.delete(left); this.directAncestors.delete(right); }
  }
  private async dict(left: PDFDict, right: PDFDict, depth: number, stream = false): Promise<boolean> {
    const keys = (dict: PDFDict) => dict.keys().filter((key) => !stream || key !== this.library.PDFName.Length)
      .sort((first, second) => first.asString() < second.asString() ? -1 : first.asString() > second.asString() ? 1 : 0);
    const first = keys(left), second = keys(right);
    if (first.length !== second.length) return false;
    for (let index = 0; index < first.length; index++) {
      if (first[index].asString() !== second[index].asString()) return false;
      this.budget.strings(first[index].asString().length * 2);
      if (!await this.equal(left.get(first[index], true), right.get(second[index], true), depth + 1)) return false;
    }
    return true;
  }
}

function normalizedPage(document: PDFDocument, index: number, delta: number, library: PdfLibrary, budget: Budget): PDFDict {
  const { PDFDict, PDFName, PDFNumber, PDFNull } = library;
  const original = document.getPage(index).node;
  const chain: PDFDict[] = [];
  let current: PDFDict | undefined = original;
  while (current) {
    budget.check();
    if (chain.length >= 64 || chain.includes(current)) throw unsupported();
    chain.push(current);
    const parent: PDFObject | undefined = document.context.lookup(current.get(PDFName.Parent, true));
    if (parent === undefined || parent === PDFNull) break;
    if (!(parent instanceof PDFDict)) throw unsupported();
    current = parent;
  }
  const result = original.clone();
  result.delete(PDFName.Parent);
  for (const key of [PDFName.MediaBox, PDFName.CropBox, PDFName.Rotate]) {
    const owner = chain.find((node) => node.get(key, true) !== undefined);
    if (owner) result.set(key, owner.get(key, true)!);
  }
  const resources = PDFDict.withContext(document.context);
  const categories = new Set<string>();
  for (const node of chain) {
    const raw = node.get(PDFName.Resources, true);
    if (raw === undefined) continue;
    const dictionary = document.context.lookup(raw);
    if (!(dictionary instanceof PDFDict)) throw unsupported();
    for (const [key, value] of dictionary.entries()) {
      if (!categories.has(key.asString())) { categories.add(key.asString()); resources.set(key, value); }
    }
  }
  result.set(PDFName.Resources, resources);
  const rotation = document.context.lookup(result.get(PDFName.Rotate));
  const angle = rotation === undefined ? 0 : rotation instanceof PDFNumber ? rotation.asNumber() : NaN;
  if (!Number.isSafeInteger(angle) || angle % 90 !== 0 || !Number.isSafeInteger(delta) || delta % 90 !== 0) throw unsupported();
  result.set(PDFName.Rotate, PDFNumber.of(normalize(angle + delta)));
  return result;
}

function displayContext(document: PDFDocument, library: PdfLibrary): PDFDict {
  const result = library.PDFDict.withContext(document.context);
  // Full AcroForm is intentionally conservative: unknown field/XFA dependencies cannot be proven away.
  for (const name of ["OCProperties", "AcroForm", "OutputIntents", "NeedsRendering"]) {
    const key = library.PDFName.of(name), value = document.catalog.get(key, true);
    if (value !== undefined) result.set(key, value);
  }
  return result;
}

/**
 * Independent, bounded evidence from reparsing the serialized output. No digests,
 * document objects, values or byte arrays leave this function. This is diagnostic
 * evidence only: it never permits a failed visual validation to download a file.
 * Optional limits may only tighten the defaults (useful for deterministic tests).
 */
export async function inspectExportIntegrity(source: PDFDocument, serializedOutput: Uint8Array, edits: readonly PdfEditPage[], library: PdfLibrary, signal: AbortSignal, lowerLimits: Partial<IntegrityLimits> = {}): Promise<readonly PdfPageIntegrityEvidence[]> {
  signal.throwIfAborted();
  const evidence = edits.map(emptyEvidence);
  try {
    if (!edits.length || edits.length > 1000 || serializedOutput.length > 100 * 1024 ** 2) throw unsupported();
    const budget = new Budget(signal, lowerLimits);
    const output = await budget.wait(library.PDFDocument.load(serializedOutput, { updateMetadata: false, ignoreEncryption: false, throwOnInvalidObject: true }));
    if (output.getPageCount() !== edits.length) throw unsupported();
    const seen = new Set<number>();
    const left: Side = { context: source.context, normalizedPages: new Map() };
    const right: Side = { context: output.context, normalizedPages: new Map() };
    for (const [index, edit] of edits.entries()) {
      if (!Number.isInteger(edit.sourcePageNumber) || edit.sourcePageNumber < 1 || edit.sourcePageNumber > source.getPageCount() || seen.has(edit.sourcePageNumber)) throw unsupported();
      seen.add(edit.sourcePageNumber);
      left.normalizedPages.set(source.getPage(edit.sourcePageNumber - 1).node, normalizedPage(source, edit.sourcePageNumber - 1, edit.rotationDelta, library, budget));
      right.normalizedPages.set(output.getPage(index).node, normalizedPage(output, index, 0, library, budget));
    }
    const contexts = [displayContext(source, library), displayContext(output, library)];
    const { PDFName } = library;
    for (const [index, edit] of edits.entries()) {
      budget.check();
      const original = source.getPage(edit.sourcePageNumber - 1), written = output.getPage(index);
      const expected = left.normalizedPages.get(original.node)!, actual = right.normalizedPages.get(written.node)!;
      const compare = (first: PDFObject | undefined, second: PDFObject | undefined) => new GraphComparison(left, right, library, budget).equal(first, second);
      const attributes = (page: PDFDict) => {
        const dictionary = page.clone();
        for (const key of [PDFName.Contents, PDFName.Resources, PDFName.Annots]) dictionary.delete(key);
        return dictionary;
      };
      const row = evidence[index];
      row.contentsEqual = await compare(expected.get(PDFName.Contents, true), actual.get(PDFName.Contents, true));
      row.resourcesEqual = await compare(expected.get(PDFName.Resources, true), actual.get(PDFName.Resources, true));
      row.pageAttributesEqual = await compare(attributes(expected), attributes(actual));
      row.annotationsEqual = await compare(expected.get(PDFName.Annots, true), actual.get(PDFName.Annots, true));
      row.displayContextEqual = await compare(contexts[0], contexts[1]);
      row.complete = row.contentsEqual && row.resourcesEqual && row.pageAttributesEqual && row.annotationsEqual && row.displayContextEqual;
    }
    // One bijection spans every selected page and the catalog. Independent page
    // comparisons cannot prove that fonts/images/OCGs still share their identity.
    const graph = new GraphComparison(left, right, library, budget);
    let globalGraphEqual = true;
    for (const [index, edit] of edits.entries()) {
      if (!await graph.equal(source.getPage(edit.sourcePageNumber - 1).ref, output.getPage(index).ref)) {
        globalGraphEqual = false;
        break;
      }
    }
    if (globalGraphEqual) globalGraphEqual = await graph.equal(contexts[0], contexts[1]);
    if (!globalGraphEqual) for (const row of evidence) row.complete = false;
    budget.check();
  } catch {
    if (signal.aborted) throw signal.reason;
    // Partial observations may help diagnosis, but incomplete traversal never proves eligibility.
    for (const row of evidence) row.complete = false;
  }
  return Object.freeze(evidence.map((row) => Object.freeze(row)));
}
