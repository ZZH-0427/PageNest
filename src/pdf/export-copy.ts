import type { PDFDict, PDFDocument, PDFObject, PDFPage } from "pdf-lib";

type PdfLibrary = typeof import("pdf-lib");
const MAX_PARENT_DEPTH = 64;

/** Read the source hierarchy without normalizing or mutating its page dictionaries. */
function pageAncestors(page: PDFPage, library: PdfLibrary, signal: AbortSignal): PDFDict[] {
  const { PDFDict, PDFName, PDFNull } = library;
  const ancestors: PDFDict[] = [];
  const seen = new Set<PDFDict>();
  let current: PDFDict | undefined = page.node;
  while (current) {
    signal.throwIfAborted();
    if (seen.has(current) || ancestors.length >= MAX_PARENT_DEPTH) throw new Error("Unsupported PDF page ancestry");
    seen.add(current);
    ancestors.push(current);
    const parent: PDFObject | undefined = current.context.lookup(current.get(PDFName.Parent, true));
    if (parent === undefined || parent === PDFNull) break;
    if (!(parent instanceof PDFDict)) throw new Error("Unsupported PDF page ancestry");
    current = parent;
  }
  return ancestors;
}

/**
 * PDF.js 6.5 Page.resources merges inherited dictionaries by resource category,
 * nearest first. It does not merge a child's Font/XObject category with its
 * parent's category; stream-local resources are handled separately by PDF.js.
 */
function mergedResources(ancestors: PDFDict[], source: PDFDocument, library: PdfLibrary): PDFDict {
  const { PDFDict, PDFName } = library;
  const merged = PDFDict.withContext(source.context);
  const seen = new Set<string>();
  let found = false;
  for (const ancestor of ancestors) {
    const raw = ancestor.get(PDFName.Resources, true);
    if (raw === undefined) continue;
    const resources = source.context.lookup(raw);
    if (!(resources instanceof PDFDict)) {
      if (!found) throw new Error("Unsupported PDF page resources");
      continue;
    }
    found = true;
    for (const [name, value] of resources.entries()) {
      const key = name.asString();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.set(name, value);
    }
  }
  return merged;
}

/** Copy only selected pages and the catalog configuration needed to display layers. */
export async function copyEditedPages(source: PDFDocument, output: PDFDocument, indices: readonly number[], library: PdfLibrary, signal: AbortSignal): Promise<PDFPage[]> {
  const { PDFName, PDFDict, PDFObjectCopier, PDFPage } = library;
  signal.throwIfAborted();
  await source.flush();
  signal.throwIfAborted();
  // One copier is essential: page OCG references must match OCProperties OCGs.
  const copier = PDFObjectCopier.for(source.context, output.context);
  const pages = indices.map((index) => {
    signal.throwIfAborted();
    const original = source.getPage(index);
    const ancestors = pageAncestors(original, library, signal);
    const leaf = original.node.clone();
    leaf.set(PDFName.Resources, mergedResources(ancestors, source, library));
    for (const name of [PDFName.MediaBox, PDFName.CropBox, PDFName.Rotate]) {
      const owner = ancestors.find((ancestor) => ancestor.get(name) !== undefined);
      if (owner) leaf.set(name, owner.get(name)!);
    }
    // Flatten before copying, so inherited values cannot pull in the source tree.
    leaf.delete(PDFName.Parent);
    const copied = copier.copy(leaf);
    return PDFPage.of(copied, output.context.register(copied), output);
  });
  const layers = source.catalog.get(PDFName.of("OCProperties"));
  if (layers !== undefined) {
    if (!(source.context.lookup(layers) instanceof PDFDict)) throw new Error("Unsupported PDF optional content configuration");
    output.catalog.set(PDFName.of("OCProperties"), copier.copy(layers));
  }
  signal.throwIfAborted();
  return pages;
}
