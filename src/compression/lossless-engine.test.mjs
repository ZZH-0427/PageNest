// @vitest-environment node
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import * as L from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeComplexPdf } from "../test/fixtures/synthetic/complex-pdf-fixtures.mjs";
import { makeExportPdf } from "../test/fixtures/synthetic/pdf-export-fixtures.mjs";
import { makeOutputPdf } from "../test/fixtures/synthetic/output-fixtures.mjs";
import { optimizeLosslessPdf, LOSSLESS_MAX_INPUT_BYTES, LOSSLESS_MAX_STREAM_BYTES } from "./lossless-engine";
import { validateCompressionPair } from "./validation";

const assetRoot = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
const asset = (name) => join(assetRoot, name).replaceAll("\\", "/") + "/";
const sha = (data) => createHash("sha256").update(data).digest("hex");
const signal = () => new AbortController().signal;
const tasks = new Set();
const key = (name) => L.PDFName.of(name);

async function open(bytes) {
  const task = getDocument({ data: bytes.slice(), verbosity: 0, stopAtErrors: true, enableXfa: false,
    disableFontFace: true, useSystemFonts: false, useWorkerFetch: false,
    standardFontDataUrl: asset("standard_fonts"), cMapUrl: asset("cmaps"), cMapPacked: true,
    wasmUrl: asset("wasm"), iccUrl: asset("iccs") });
  tasks.add(task);
  const pdf = await task.promise, pages = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1 });
    pages.push({ number, width: viewport.width, height: viewport.height, rotation: viewport.rotation,
      orientation: viewport.width === viewport.height ? "square" : viewport.width > viewport.height ? "landscape" : "portrait" });
    page.cleanup();
  }
  return { pages,
    async inspectDocument(currentSignal) {
      currentSignal.throwIfAborted();
      const { info, metadata } = await pdf.getMetadata();
      const normalize = async (rows) => Promise.all((rows ?? []).map(async (row) => {
        const dest = typeof row.dest === "string" ? await pdf.getDestination(row.dest) : row.dest;
        return { title: row.title, dest: dest ? [typeof dest[0] === "number" ? dest[0] : await pdf.getPageIndex(dest[0]),
          ...dest.slice(1).map((item) => item && typeof item === "object" && "name" in item ? item.name : item)] : null,
        children: await normalize(row.items) };
      }));
      const stableInfo = Object.fromEntries(Object.entries(info).filter(([name]) => !["PDFFormatVersion", "IsLinearized"].includes(name)).sort(([a], [b]) => a.localeCompare(b)));
      return { metadataDigest: sha(JSON.stringify({ info: stableInfo, xml: metadata?.getRaw() ?? null })),
        outlinesDigest: sha(JSON.stringify(await normalize(await pdf.getOutline()))),
        hasForms: info.IsAcroFormPresent || info.IsXFAPresent, hasAttachments: !!(await pdf.getAttachments()),
        hasJavaScript: !!(await pdf.getJSActions()), encrypted: !!info.EncryptFilterName };
    },
    async inspectPage(number, currentSignal, delta = 0, _signature = false, size = 128) {
      void _signature;
      currentSignal.throwIfAborted();
      const page = await pdf.getPage(number), rotation = ((page.rotate + delta) % 360 + 360) % 360;
      let canvas;
      try {
        const geometry = page.getViewport({ scale: 1, rotation });
        const viewport = page.getViewport({ scale: Math.min(size / geometry.width, size / geometry.height), rotation });
        canvas = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
        await page.render({ canvas, viewport, background: "#ffffff" }).promise;
        const text = (await page.getTextContent()).items.filter((item) => "str" in item).map((item) => item.str);
        currentSignal.throwIfAborted();
        return { width: geometry.width, height: geometry.height, rotation, textDigest: sha(JSON.stringify(text)),
          visualDigest: sha(canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data) };
      } finally { if (canvas) canvas.width = canvas.height = 1; page.cleanup(); }
    },
    async render() { throw new Error("Real validation uses independent inspectPage"); },
    async destroy() { tasks.delete(task); await task.destroy(); },
  };
}

afterEach(async () => { vi.unstubAllGlobals(); await Promise.all([...tasks].map((task) => task.destroy())); tasks.clear(); });

async function tagged(type = "text") {
  const doc = await L.PDFDocument.create();
  doc.setTitle("ARTIFICIAL COMPRESSION " + type); doc.setAuthor("PageNest synthetic fixture");
  doc.setSubject("Synthetic metadata remains present");
  const font = await doc.embedFont(L.StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) {
    const page = doc.addPage([420, 594]);
    for (let row = 0; row < 15; row++) page.drawText(`SYNTHETIC ${type} ${i + 1} ${row}`, { x: 25, y: 560 - row * 17, size: 10, font });
    if (type === "image") {
      const pixels = new Uint8Array(128 * 128 * 3);
      for (let at = 0; at < pixels.length; at++) pixels[at] = Math.floor(at / 32) % 256;
      const ref = doc.context.register(doc.context.stream(deflateSync(pixels, { level: 0 }),
        { Type: "XObject", Subtype: "Image", Width: 128, Height: 128, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "FlateDecode" }));
      const image = page.node.newXObject("Artificial", ref);
      page.pushOperators(L.pushGraphicsState(), L.concatTransformationMatrix(100, 0, 0, 100, 30, 30), L.drawObject(image), L.popGraphicsState());
    }
  }
  const outlines = doc.context.obj({ Type: "Outlines", Count: 1 }), root = doc.context.register(outlines);
  const first = doc.context.register(doc.context.obj({ Title: L.PDFString.of("Synthetic bookmark"), Parent: root, Dest: [doc.getPage(0).ref, "Fit"] }));
  outlines.set(key("First"), first); outlines.set(key("Last"), first); doc.catalog.set(key("Outlines"), root);
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

async function verify(input) {
  const original = sha(input), before = await open(input), result = await optimizeLosslessPdf(input, signal()), after = await open(result.bytes);
  await validateCompressionPair(before, after, "lossless", signal());
  expect(sha(input)).toBe(original);
  expect(result.methods).toContain("PDF 对象流重新封装");
  expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  return result;
}

async function rawStreamPdf(size, count = 1, raw = undefined) {
  const doc = await L.PDFDocument.create({ updateMetadata: false }); doc.addPage();
  const data = raw ?? deflateSync(new Uint8Array(size), { level: 1 });
  for (let i = 0; i < count; i++) doc.context.register(doc.context.stream(data, { Filter: "FlateDecode" }));
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

describe("native lossless optimization against independent real PDF.js parsing", () => {
  it("optimizes actual text PDF and preserves selectable text, metadata and bookmark destination", async () => {
    const input = await tagged(), result = await verify(input);
    expect(result.bytes.length).toBeLessThan(input.length);
  });
  it("losslessly recompresses artificial raw raster Flate data without reducing image pixels", async () => {
    const input = await tagged("image"), result = await verify(input);
    expect(result.recompressedStreams).toBeGreaterThanOrEqual(3);
    expect(result.bytes.length).toBeLessThan(input.length);
  });
  it("preserves mixed text, raster and complex vectors in the same PDF", async () => {
    await verify(makeComplexPdf({ pageCount: 3, crop: false, chinese: false }));
  });
  it("preserves authored Chinese glyphs, CropBox/MediaBox, rotations and hidden optional layers", async () => {
    await verify(makeComplexPdf({ pageCount: 4, crop: true, chinese: true, hiddenLayer: true }));
  });
  it("does not invent savings for an already optimized file", async () => {
    const initial = await optimizeLosslessPdf(await tagged(), signal()), next = await verify(initial.bytes);
    expect(next.bytes.length).toBe(initial.bytes.length);
  });
  it("can produce a larger but valid candidate, leaving no-benefit classification to the controller", async () => {
    const objects = ["<</Type/Catalog/Pages 2 0 R>>", "<</Type/Pages/Kids[3 0 R]/Count 1>>", "<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]/Contents 4 0 R>>", "<</Length 3>>stream\nq Q\nendstream"];
    let text = "%PDF-1.4\n", offsets = [0];
    for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj${object}endobj\n`; }
    const xref = Buffer.byteLength(text);
    text += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map((n) => String(n).padStart(10, "0") + " 00000 n \n").join("")}trailer<</Size 5/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
    const input = new Uint8Array(Buffer.from(text)), result = await verify(input);
    expect(result.bytes.length).toBeGreaterThan(input.length);
  });
  it("retains single-Flate array filters and their predictor DecodeParms while recompressing", async () => {
    const doc = await L.PDFDocument.load(await tagged("image"), { updateMetadata: false });
    for (const [, object] of doc.context.enumerateIndirectObjects()) if (object instanceof L.PDFRawStream && String(object.dict.get(key("Subtype"))) === "/Image") {
      object.dict.set(key("Filter"), doc.context.obj(["FlateDecode"]));
      object.dict.set(key("DecodeParms"), doc.context.obj([{ Predictor: 1, Columns: 128, Colors: 3, BitsPerComponent: 8 }]));
    }
    const input = await doc.save({ useObjectStreams: false }), result = await verify(input), output = await L.PDFDocument.load(result.bytes, { updateMetadata: false });
    const images = output.context.enumerateIndirectObjects().map(([, value]) => value).filter((value) => value instanceof L.PDFRawStream && String(value.dict.get(key("Subtype"))) === "/Image");
    expect(images).toHaveLength(3);
    for (const image of images) { expect(String(image.dict.get(key("Filter")))).toContain("FlateDecode"); expect(String(image.dict.get(key("DecodeParms")))).toContain("Predictor 1"); }
  });
  it("skips unsupported multi-filter envelopes without changing their bytes", async () => {
    const doc = await L.PDFDocument.create({ updateMetadata: false }); doc.addPage();
    const data = new Uint8Array(Buffer.from(deflateSync(Buffer.from("ARTIFICIAL MULTI FILTER")).toString("hex") + ">"));
    doc.context.register(doc.context.stream(data, { Filter: ["ASCIIHexDecode", "FlateDecode"] }));
    const input = await doc.save({ useObjectStreams: false }), result = await verify(input);
    expect(result.skippedStreams).toBeGreaterThanOrEqual(1);
    const output = await L.PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(output.context.enumerateIndirectObjects().some(([, object]) => object instanceof L.PDFRawStream &&
      String(object.dict.get(key("Filter"))).includes("ASCIIHexDecode") && sha(object.getContents()) === sha(data))).toBe(true);
  });
});

describe("strict real-PDF negative controls remain effective after optimization", () => {
  it.each([{ label: "text", options: { text: false }, item: "text" },
    { label: "image", options: { images: false }, item: "exact-render" },
    { label: "vector", options: { vectors: false }, item: "exact-render" }])("rejects missing $label", async ({ options, item }) => {
    const source = await open(makeExportPdf()), damaged = await optimizeLosslessPdf(makeExportPdf(options), signal());
    await expect(validateCompressionPair(source, await open(damaged.bytes), "lossless", signal())).rejects.toThrow(`item=${item}`);
  });
  it("rejects wrong page order with identical geometry", async () => {
    const bytes = makeExportPdf({ pages: [0, 1, 2].map(() => ({ width: 420, height: 594, rotate: 0 })) });
    const source = await L.PDFDocument.load(bytes, { updateMetadata: false }), wrong = await L.PDFDocument.create({ updateMetadata: false });
    for (const page of await wrong.copyPages(source, [2, 1, 0])) wrong.addPage(page);
    const damaged = await optimizeLosslessPdf(await wrong.save(), signal());
    await expect(validateCompressionPair(await open(bytes), await open(damaged.bytes), "lossless", signal())).rejects.toThrow("item=text");
  });
  it("rejects wrong rotation", async () => {
    const bytes = await tagged(), source = await L.PDFDocument.load(bytes, { updateMetadata: false });
    source.getPage(0).setRotation(L.degrees(90));
    await expect(validateCompressionPair(await open(bytes), await open((await optimizeLosslessPdf(await source.save(), signal())).bytes), "lossless", signal())).rejects.toThrow("item=geometry");
  });
  it("rejects wrong layer display state", async () => {
    const original = await makeOutputPdf({ count: 1, layer: "off" }), wrong = await makeOutputPdf({ count: 1, layer: "base-off-on" });
    await expect(validateCompressionPair(await open(original), await open((await optimizeLosslessPdf(wrong, signal())).bytes), "lossless", signal())).rejects.toThrow("item=exact-render");
  });
});

describe("lossless safety budgets, cancellation and safe failures", () => {
  it("rejects empty and oversized input without altering caller bytes", async () => {
    for (const input of [new Uint8Array(), new Uint8Array(LOSSLESS_MAX_INPUT_BYTES + 1)]) await expect(optimizeLosslessPdf(input, signal())).rejects.toThrow("32 MiB");
  });
  it("rejects more than 200 pages", async () => {
    const doc = await L.PDFDocument.create({ updateMetadata: false }); for (let i = 0; i < 201; i++) doc.addPage();
    await expect(optimizeLosslessPdf(await doc.save(), signal())).rejects.toThrow("200");
  });
  it("rejects an empty page tree without adding a page", async () => {
    const doc = await L.PDFDocument.create({ updateMetadata: false });
    await expect(optimizeLosslessPdf(await doc.save({ addDefaultPage: false }), signal())).rejects.toThrow("200");
  });
  it("enforces the actual decoded single-stream budget", async () => {
    const input = await rawStreamPdf(LOSSLESS_MAX_STREAM_BYTES + 1), original = sha(input);
    await expect(optimizeLosslessPdf(input, signal())).rejects.toThrow("解压数据超过安全预算"); expect(sha(input)).toBe(original);
  });
  it("enforces cumulative decoded bytes even when each stream is below 16 MiB", async () => {
    await expect(optimizeLosslessPdf(await rawStreamPdf(13 * 1024 ** 2, 5), signal())).rejects.toThrow("解压数据超过安全预算");
  });
  it("supports cancellation before parsing", async () => {
    const controller = new AbortController(); controller.abort(new DOMException("Cancelled", "AbortError"));
    await expect(optimizeLosslessPdf(await tagged(), controller.signal)).rejects.toHaveProperty("name", "AbortError");
  });
  it("cancels while processing native stream chunks without altering the original", async () => {
    const input = await rawStreamPdf(15 * 1024 ** 2), original = sha(input), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Cancelled", "AbortError")), 0);
    try { await expect(optimizeLosslessPdf(input, controller.signal)).rejects.toHaveProperty("name", "AbortError"); }
    finally { clearTimeout(timer); }
    expect(sha(input)).toBe(original);
  });
  it("does not expose corrupt stream bytes in its safe diagnostic", async () => {
    const marker = "ARTIFICIAL_PRIVATE_DOCUMENT_MARKER", input = await rawStreamPdf(0, 1, new TextEncoder().encode(marker));
    const error = await optimizeLosslessPdf(input, signal()).catch((value) => value);
    expect(error).toBeInstanceOf(Error); expect(error.message).toContain("无法可靠完成"); expect(error.message).not.toContain(marker);
  });
  it("rejects invalid PDF headers", async () => {
    await expect(optimizeLosslessPdf(new TextEncoder().encode("ARTIFICIAL INVALID"), signal())).rejects.toThrow();
  });
  it("gives a fixed error when native compression streams are unavailable", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    await expect(optimizeLosslessPdf(await tagged(), signal())).rejects.toThrow("本地压缩流 API");
  });
});
