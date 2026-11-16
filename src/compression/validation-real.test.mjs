// @vitest-environment node
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import * as L from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterEach, describe, expect, it } from "vitest";
import { makeChineseCompressionImagePdf, makeCompressionImagePdf, nodeJpegCodec } from "../test/fixtures/synthetic/compression-image-fixtures.mjs";
import { optimizeJpegPdf } from "./image-codec";
import { normalizeEncodedJpeg } from "./image-types";
import { optimizeLosslessPdf } from "./lossless-engine";
import { inspectCompressionSource } from "./policy";
import { inspectCompressionDocument, validateCompressionPair } from "./validation";

const root = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
const asset = (name) => join(root, name).replaceAll("\\", "/") + "/";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const signal = () => new AbortController().signal;
const handles = new Set();
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
async function open(bytes) {
  const task = getDocument({ data: bytes.slice(), verbosity: 0, stopAtErrors: true, useWorkerFetch: false,
    standardFontDataUrl: asset("standard_fonts"), cMapUrl: asset("cmaps"), cMapPacked: true,
    wasmUrl: asset("wasm"), iccUrl: asset("iccs") });
  const pdf = await task.promise, pages = [], scratch = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number), geometry = page.getViewport({ scale: 1 });
    pages.push({ number, width: geometry.width, height: geometry.height, rotation: geometry.rotation,
      orientation: geometry.width === geometry.height ? "square" : geometry.width > geometry.height ? "landscape" : "portrait" });
    page.cleanup();
  }
  const handle = { pages, scratch,
    async inspectDocument(currentSignal) {
      currentSignal.throwIfAborted();
      const metadata = await pdf.getMetadata(), info = Object.fromEntries(Object.entries(metadata.info).filter(([key]) => !["PDFFormatVersion", "IsLinearized"].includes(key)));
      const outline = await pdf.getOutline();
      // These artificial inputs have no outlines; preserve actual nonempty outline data if introduced.
      const normalizeOutline = async (items) => Promise.all(items.map(async (item) => {
        let destination = item.dest ?? null;
        if (typeof destination === "string") destination = await pdf.getDestination(destination);
        if (Array.isArray(destination) && destination[0] && typeof destination[0] === "object" && "num" in destination[0]) destination = [await pdf.getPageIndex(destination[0]), ...destination.slice(1)];
        return canonical({ title: item.title, bold: item.bold, italic: item.italic, color: Array.from(item.color), count: item.count ?? null,
          url: item.url ?? null, unsafeUrl: item.unsafeUrl ?? null, newWindow: item.newWindow ?? null, dest: destination, children: await normalizeOutline(item.items) });
      }));
      const attachments = await pdf.getAttachments(), actions = await pdf.getJSActions(), permissions = await pdf.getPermissions();
      return { metadataDigest: sha(JSON.stringify(canonical({ info, xml: metadata.metadata?.getRaw() ?? null }))),
        outlinesDigest: sha(JSON.stringify(await normalizeOutline(outline ?? []))),
        hasForms: !!metadata.info.IsAcroFormPresent || !!metadata.info.IsXFAPresent, hasSignatures: !!metadata.info.IsSignaturesPresent,
        hasAttachments: !!attachments && Object.keys(attachments).length > 0,
        hasJavaScript: !!actions && Object.keys(actions).length > 0, encrypted: permissions !== null };
    },
    async inspectPage(number, currentSignal, delta = 0, _signature = false, size = 128) {
      currentSignal.throwIfAborted();
      if (_signature) throw new Error("Synthetic adapter does not supply optional render signatures");
      const page = await pdf.getPage(number), rotation = ((page.rotate + delta) % 360 + 360) % 360;
      const geometry = page.getViewport({ scale: 1, rotation }), viewport = page.getViewport({ scale: size / Math.max(geometry.width, geometry.height), rotation });
      const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
      try {
        await page.render({ canvas, viewport, background: "#ffffff" }).promise;
        const text = (await page.getTextContent()).items.filter((item) => "str" in item).map((item) => item.str);
        const pixels = new Uint8Array(canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data);
        scratch.push(pixels);
        return { width: geometry.width, height: geometry.height, rotation, textDigest: sha(JSON.stringify(text)), visualDigest: sha(pixels),
          visualSample: { width: canvas.width, height: canvas.height, pixels } };
      } finally { canvas.width = canvas.height = 1; page.cleanup(); }
    },
    async render() { throw new Error("Independent validation uses inspection"); },
    async destroy() { handles.delete(handle); await task.destroy(); },
  };
  handles.add(handle); return handle;
}
afterEach(async () => { await Promise.all([...handles].map((handle) => handle.destroy())); handles.clear(); });

describe("real PDF output through production compression validation", () => {
  it("accepts real lossless output only after independent metadata and two-resolution exact checks", async () => {
    const input = await makeCompressionImagePdf({ images: false }), originalSha = sha(input);
    expect(await inspectCompressionSource(input, signal())).toBe(2);
    const result = await optimizeLosslessPdf(input, signal());
    const source = await open(input), output = await open(result.bytes);
    expect((await inspectCompressionDocument(source, signal())).metadataDigest).toBe((await inspectCompressionDocument(output, signal())).metadataDigest);
    await validateCompressionPair(source, output, "lossless", signal());
    expect([...source.scratch, ...output.scratch].every((sample) => sample.every((byte) => byte === 0))).toBe(true);
    expect(sha(input)).toBe(originalSha);
  });
  it("accepts actual Chinese table/JPEG output through normal and masked production gates", async () => {
    const input = await makeChineseCompressionImagePdf(), originalSha = sha(input);
    expect(await inspectCompressionSource(input, signal())).toBe(2);
    const result = await optimizeJpegPdf(input, "balanced", signal(), nodeJpegCodec);
    await validateCompressionPair(await open(input), await open(result.bytes), "balanced", signal());
    await validateCompressionPair(await open(result.maskedSource), await open(result.maskedOutput), "lossless", signal(), true);
    expect(sha(input)).toBe(originalSha);
  });
  it("rejects actual unrelated image replacement even if text, metadata and geometry remain intact", async () => {
    const input = await makeCompressionImagePdf({ count: 1 }), pdf = await L.PDFDocument.load(input, { updateMetadata: false });
    const [ref, stream] = pdf.context.enumerateIndirectObjects().find(([, object]) => object instanceof L.PDFRawStream && object.dict.get(L.PDFName.of("Subtype")) === L.PDFName.of("Image"));
    const canvas = createCanvas(640, 880), context = canvas.getContext("2d"); context.fillStyle = "#ff0000"; context.fillRect(0, 0, 640, 880);
    pdf.context.assign(ref, L.PDFRawStream.of(stream.dict.clone(), normalizeEncodedJpeg(canvas.encodeSync("jpeg", 70)))); canvas.width = canvas.height = 1;
    const corrupt = await pdf.save({ updateFieldAppearances: false });
    await expect(validateCompressionPair(await open(input), await open(corrupt), "strong", signal())).rejects.toThrow("image-quality");
  });
  it("rejects real lost text in a masked control instead of allowing JPEG differences to conceal it", async () => {
    const input = await makeCompressionImagePdf({ count: 1 }), result = await optimizeJpegPdf(input, "balanced", signal(), nodeJpegCodec);
    await validateCompressionPair(await open(input), await open(result.bytes), "balanced", signal());
    const pdf = await L.PDFDocument.load(result.maskedOutput, { updateMetadata: false });
    const ref = pdf.getPage(0).node.Contents().get(0), content = pdf.context.lookup(ref);
    const original = Buffer.from(L.decodePDFRawStream(content).decode()).toString("latin1");
    const altered = original.replace(/<[A-F0-9]+>\s*Tj/g, "<> Tj"); expect(altered).not.toBe(original);
    pdf.context.assign(ref, pdf.context.flateStream(new Uint8Array(Buffer.from(altered, "latin1"))));
    await expect(validateCompressionPair(await open(result.maskedSource), await open(await pdf.save({ updateFieldAppearances: false })), "lossless", signal(), true)).rejects.toThrow("text");
  });
});
