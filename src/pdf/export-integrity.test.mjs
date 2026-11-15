// @vitest-environment node
import { createHash } from "node:crypto";
import * as library from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { makeCopyCompatibilityPdf } from "../test/fixtures/synthetic/copy-compatibility-fixtures.mjs";
import { makeExportPdf } from "../test/fixtures/synthetic/pdf-export-fixtures.mjs";
import { createEditState } from "./edit";
import { generateEditedPdf } from "./export";
import { inspectExportIntegrity } from "./export-integrity";

const signal = () => new AbortController().signal;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const N = (value) => library.PDFName.of(value);
const allTrue = { contentsEqual: true, resourcesEqual: true, pageAttributesEqual: true,
  annotationsEqual: true, displayContextEqual: true, complete: true };

async function prepare(bytes, indices, rotationDelta = 0) {
  const source = await library.PDFDocument.load(bytes, { updateMetadata: false });
  const originalPages = source.getPages().map((page, index) => {
    const { width, height } = page.getSize();
    return { number: index + 1, width, height, rotation: ((page.getRotation().angle % 360) + 360) % 360,
      orientation: width === height ? "square" : width > height ? "landscape" : "portrait" };
  });
  const state = createEditState("artificial", originalPages);
  const edits = (indices ?? source.getPageIndices()).map((index) => ({ ...state.present.pages[index], rotationDelta }));
  const outputBytes = await generateEditedPdf(bytes, { documentId: "artificial", originalPages, pages: edits }, signal());
  return { source, edits, outputBytes };
}
const inspect = (input, options = {}) => inspectExportIntegrity(input.source, input.outputBytes, input.edits, library, signal(), options);
async function damage(input, change) {
  const document = await library.PDFDocument.load(input.outputBytes, { updateMetadata: false });
  change(document);
  return { ...input, outputBytes: await document.save({ updateFieldAppearances: false }) };
}

describe("independent serialized PDF structure evidence", () => {
  it.each(["standard", "hidden-layer", "partial-resources", "closest-resources", "inherited-geometry"])(
    "proves all categories for %s after deletion, order and absolute rotation edits", async (kind) => {
      const input = await prepare(await makeCopyCompatibilityPdf(kind), [2, 0], 90);
      expect(await inspect(input)).toEqual([allTrue, allTrue]);
    });

  it("proves preserved real image, text and vector resources without modifying any bytes or dictionaries", async () => {
    const bytes = makeExportPdf();
    const input = await prepare(bytes);
    const sourceSnapshot = input.source.context.enumerateIndirectObjects().map(([ref, obj]) => [String(ref), String(obj)]);
    const hashes = [sha(bytes), sha(input.outputBytes)];
    const result = await inspect(input);
    expect(result.every((page) => page.complete)).toBe(true);
    expect(input.source.context.enumerateIndirectObjects().map(([ref, obj]) => [String(ref), String(obj)])).toEqual(sourceSnapshot);
    expect([sha(bytes), sha(input.outputBytes)]).toEqual(hashes);
    expect(Object.isFrozen(result)).toBe(true);
    for (const page of result) {
      expect(Object.keys(page).sort()).toEqual(Object.keys(allTrue).sort());
      expect(Object.values(page).every((value) => typeof value === "boolean")).toBe(true);
    }
  });

  it("compares actual serialized content stream bytes, not only page counts or resources", async () => {
    const input = await prepare(await makeCopyCompatibilityPdf("standard", 1));
    const damaged = await damage(input, (doc) => doc.getPage(0).node.set(N("Contents"), doc.context.register(doc.context.flateStream("q 0 0 0 rg 0 0 420 594 re f Q"))));
    expect((await inspect(damaged))[0]).toMatchObject({ contentsEqual: false, resourcesEqual: true, pageAttributesEqual: true, complete: false });
  });

  it("rejects a changed font descriptor even when content stream bytes are unchanged", async () => {
    const input = await prepare(await makeCopyCompatibilityPdf("standard", 1));
    const damaged = await damage(input, (doc) => {
      const fonts = doc.getPage(0).node.Resources().lookup(N("Font"), library.PDFDict);
      fonts.lookup(N("F1"), library.PDFDict).set(N("BaseFont"), N("Courier"));
    });
    expect((await inspect(damaged))[0]).toMatchObject({ contentsEqual: true, resourcesEqual: false, complete: false });
  });

  it.each(["bytes", "decode"])("detects image %s damage inside nested resources", async (kind) => {
    const input = await prepare(makeExportPdf());
    const damaged = await damage(input, (doc) => {
      const images = doc.getPage(0).node.Resources().lookup(N("XObject"), library.PDFDict);
      const image = images.lookup(images.keys()[0], library.PDFRawStream);
      if (kind === "bytes") image.getContents()[0] ^= 1;
      else image.dict.set(N("Decode"), doc.context.obj([1, 0, 1, 0, 1, 0]));
    });
    expect((await inspect(damaged))[0]).toMatchObject({ contentsEqual: true, resourcesEqual: false, complete: false });
  });

  it.each(["CropBox", "UserUnit", "Group", "Rotate"])("does not ignore the rendered page attribute %s", async (key) => {
    const input = await prepare(await makeCopyCompatibilityPdf("standard", 1));
    const damaged = await damage(input, (doc) => {
      const value = key === "CropBox" ? [0, 0, 400, 590] : key === "Group" ? { S: "Transparency", I: true } : 90;
      doc.getPage(0).node.set(N(key), doc.context.obj(value));
    });
    expect((await inspect(damaged))[0]).toMatchObject({ contentsEqual: true, pageAttributesEqual: false, complete: false });
  });

  it("compares annotations and their appearance streams", async () => {
    const doc = await library.PDFDocument.load(await makeCopyCompatibilityPdf("standard", 1));
    const appearance = doc.context.register(doc.context.flateStream("1 0 0 rg 0 0 40 40 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 40, 40], Resources: {} }));
    doc.getPage(0).node.set(N("Annots"), doc.context.obj([doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Stamp", Rect: [10, 10, 50, 50], AP: { N: appearance } }))]));
    const input = await prepare(await doc.save({ updateFieldAppearances: false }));
    expect(await inspect(input)).toEqual([allTrue]);
    const damaged = await damage(input, (output) => output.getPage(0).node.delete(N("Annots")));
    expect((await inspect(damaged))[0]).toMatchObject({ contentsEqual: true, annotationsEqual: false, complete: false });
  });

  it("requires page and catalog OCG references to preserve identity, even with identical group dictionaries", async () => {
    const input = await prepare(await makeCopyCompatibilityPdf("hidden-layer", 1));
    const damaged = await damage(input, (doc) => {
      const properties = doc.getPage(0).node.Resources().lookup(N("Properties"), library.PDFDict);
      const group = properties.lookup(N("Hidden"), library.PDFDict);
      properties.set(N("Hidden"), doc.context.register(group.clone()));
    });
    expect(await inspect(damaged)).toEqual([{ ...allTrue, complete: false }]);
  });

  it("requires shared font identity across all selected pages, not only within each page", async () => {
    const input = await prepare(await makeCopyCompatibilityPdf("standard", 3));
    expect(await inspect(input)).toEqual([allTrue, allTrue, allTrue]);
    const damaged = await damage(input, (doc) => {
      const fonts = doc.getPage(1).node.Resources().lookup(N("Font"), library.PDFDict);
      const originalFont = fonts.lookup(N("F1"), library.PDFDict);
      fonts.set(N("F1"), doc.context.register(originalFont.clone()));
    });
    // Each font's bytes and fields remain identical. Only the inter-page alias broke.
    expect(await inspect(damaged)).toEqual(Array.from({ length: 3 }, () => ({ ...allTrue, complete: false })));
  });
  it.each(["AcroForm", "OutputIntents"])("cannot prove omitted catalog %s dependencies", async (key) => {
    const doc = await library.PDFDocument.load(await makeCopyCompatibilityPdf("standard", 1));
    doc.catalog.set(N(key), doc.context.obj(key === "AcroForm" ? { Fields: [], NeedAppearances: true, DA: library.PDFString.of("/Artificial 12 Tf 0 g") } : [{ Type: "OutputIntent", S: "GTS_PDFX", OutputConditionIdentifier: library.PDFString.of("Artificial") }]));
    const input = await prepare(await doc.save({ updateFieldAppearances: false }));
    expect((await inspect(input))[0]).toMatchObject({ contentsEqual: true, resourcesEqual: true, displayContextEqual: false, complete: false });
  });

  it.each([{ nodes: 1 }, { depth: 1 }, { streamBytes: 1 }, { stringBytes: 1 }])("fails closed at the lowered limit %j", async (limits) => {
    const input = await prepare(makeExportPdf());
    expect((await inspect(input, limits)).every((page) => !page.complete)).toBe(true);
  });

  it("fails closed for an expired deadline or unsupported page objects without exposing object data", async () => {
    const input = await prepare(await makeCopyCompatibilityPdf("standard", 1));
    let clock = 0;
    const time = vi.spyOn(performance, "now").mockImplementation(() => (clock += 100));
    try { expect(await inspect(input, { milliseconds: 1 })).toEqual([Object.fromEntries(Object.keys(allTrue).map((key) => [key, false]))]); }
    finally { time.mockRestore(); }
    input.source.getPage(0).node.set(N("ArtificialUnknown"), library.PDFInvalidObject.of(new Uint8Array([65, 66, 67])));
    const result = await inspect(input);
    expect(result[0].complete).toBe(false);
    expect(JSON.stringify(result)).not.toContain("ABC");
  });

  it("returns only incomplete booleans for invalid serialized output and count mismatches", async () => {
    const input = await prepare(await makeCopyCompatibilityPdf("standard", 1));
    expect((await inspect({ ...input, outputBytes: new Uint8Array() }))[0].complete).toBe(false);
    expect((await inspect({ ...input, edits: [...input.edits, { ...input.edits[0], id: "extra" }] })).every((page) => !page.complete)).toBe(true);
  });

  it("propagates cancellation before parsing and during hashing", async () => {
    const input = await prepare(await makeCopyCompatibilityPdf("standard", 1));
    const before = new AbortController(); before.abort();
    await expect(inspectExportIntegrity(input.source, input.outputBytes, input.edits, library, before.signal)).rejects.toHaveProperty("name", "AbortError");
    const during = new AbortController();
    const hashing = vi.spyOn(crypto.subtle, "digest").mockImplementation(async () => { during.abort(); return new ArrayBuffer(32); });
    try { await expect(inspectExportIntegrity(input.source, input.outputBytes, input.edits, library, during.signal)).rejects.toHaveProperty("name", "AbortError"); }
    finally { hashing.mockRestore(); }
  });
});
