// @vitest-environment node
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import * as L from "pdf-lib";
import { makeComplexPdf } from "../test/fixtures/synthetic/complex-pdf-fixtures.mjs";
import { makeArtificialJpeg } from "../test/fixtures/synthetic/compression-image-fixtures.mjs";
import { inspectCompressionSource } from "./policy";

const signal = () => new AbortController().signal;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function base() { const doc = await L.PDFDocument.create({ updateMetadata: false }); doc.addPage([420, 594]); return doc; }
const save = (doc) => doc.save({ useObjectStreams: false, updateFieldAppearances: false });
async function streamPdf(data, filter, count = 1) {
  const doc = await base();
  for (let i = 0; i < count; i++) doc.context.register(doc.context.stream(data, filter === undefined ? {} : { Filter: filter }));
  return save(doc);
}
async function imageHeaders(dimensions) {
  const doc = await base();
  for (const [width, height] of dimensions) doc.context.register(doc.context.stream(new Uint8Array([0, 0, 0]),
    { Type: "XObject", Subtype: "Image", Width: width, Height: height, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }));
  return save(doc);
}

async function imageObjectPdf(data, dictionary = {}) {
  const doc = await base(), page = doc.getPage(0);
  const object = doc.context.register(doc.context.stream(data, {
    Type: "XObject", Subtype: "Image", Width: 64, Height: 80, ColorSpace: "DeviceRGB", BitsPerComponent: 8,
    Filter: "DCTDecode", ...dictionary,
  }));
  const image = page.node.newXObject("ArtificialPolicyImage", object);
  page.pushOperators(L.pushGraphicsState(), L.concatTransformationMatrix(100, 0, 0, 100, 30, 30), L.drawObject(image), L.popGraphicsState());
  return save(doc);
}

/** Inspect the generator's JPEG framing; mutated adversarial headers are never decoded. */
function jpegFrames(bytes) {
  const segments = []; let position = 2;
  while (position + 4 < bytes.length) {
    if (bytes[position] !== 255) throw new Error("Invalid generated JPEG frame");
    const marker = bytes[position + 1];
    if (marker === 218) return { segments, scan: position };
    const length = bytes[position + 2] * 256 + bytes[position + 3];
    if (length < 2 || position + length + 2 > bytes.length) throw new Error("Invalid generated JPEG segment");
    segments.push({ position, marker, length: length + 2 }); position += length + 2;
  }
  throw new Error("Missing generated JPEG scan");
}

async function predictorPdf(parameters, array = false) {
  const doc = await base(), value = doc.context.obj(parameters);
  const reference = doc.context.register(value);
  doc.context.register(doc.context.stream(deflateSync(new Uint8Array(131072)), {
    Filter: "FlateDecode", DecodeParms: array ? [reference] : reference,
  }));
  return save(doc);
}

async function componentPdf(kind, count) {
  const doc = await base();
  let colorSpace;
  if (kind === "ICC") {
    const profile = doc.context.register(doc.context.stream(new Uint8Array(128), { N: count }));
    colorSpace = ["ICCBased", profile];
  } else {
    const names = Array.from({ length: count }, (_, index) => `ArtificialColor${index + 1}`);
    const tint = doc.context.register(doc.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [1, 1, 1, 1], N: 1 }));
    colorSpace = ["DeviceN", names, "DeviceCMYK", tint];
  }
  doc.context.register(doc.context.stream(new Uint8Array(Math.max(1, count)), {
    Type: "XObject", Subtype: "Image", Width: 1, Height: 1, BitsPerComponent: 8, ColorSpace: colorSpace,
  }));
  return save(doc);
}

async function colorSpacePdf(create) {
  const doc = await base();
  const space = create(doc);
  doc.context.register(doc.context.stream(new Uint8Array([0, 0, 0, 0]), {
    Type: "XObject", Subtype: "Image", Width: 1, Height: 1, BitsPerComponent: 8, ColorSpace: space,
  }));
  return save(doc);
}
const tintFunction = (doc) => doc.context.register(doc.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0], C1: [1, 1, 1], N: 1 }));

async function imageEstimatePdf(specifications) {
  const doc = await base();
  for (const { data = new Uint8Array([0]), omitBits = false, ...dictionary } of specifications) {
    const stream = doc.context.stream(data, { Type: "XObject", Subtype: "Image", Width: 1, Height: 1,
      ColorSpace: "DeviceRGB", BitsPerComponent: 8, ...dictionary });
    if (omitBits) stream.dict.delete(L.PDFName.of("BitsPerComponent"));
    doc.context.register(stream);
  }
  return save(doc);
}

const inlineImageBody = Buffer.from("q 30 0 0 30 0 0 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID \0\0\0 EI Q");
async function contentPdf(kind, data, filter, indirectTag = false) {
  const doc = await base(), page = doc.getPage(0);
  const dictionary = filter === undefined ? {} : { Filter: filter };
  if (kind === "Form") Object.assign(dictionary, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 100], Resources: {} });
  if (kind === "Pattern" || kind === "PatternNoType") Object.assign(dictionary, { Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1,
    BBox: [0, 0, 100, 100], XStep: 100, YStep: 100, Resources: {} });
  const stream = doc.context.stream(data, dictionary);
  if (kind === "PatternNoType") stream.dict.delete(L.PDFName.of("Type"));
  if (indirectTag) {
    const key = L.PDFName.of(kind === "Form" ? "Subtype" : "Type");
    stream.dict.set(key, doc.context.register(stream.dict.get(key)));
  }
  const reference = doc.context.register(stream);
  if (kind === "Page") page.node.set(L.PDFName.Contents, reference);
  else if (kind === "PageArray") page.node.set(L.PDFName.Contents,
    doc.context.obj([doc.context.register(doc.context.stream(Buffer.from("q Q\n"))), reference]));
  else if (kind === "Type3") doc.context.register(doc.context.obj({ Type: "Font", Subtype: "Type3",
    FontBBox: [0, 0, 100, 100], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], CharProcs: { SyntheticGlyph: reference } }));
  return save(doc);
}

describe("real-PDF compression preflight", () => {
  it("accepts authored Chinese, CropBox, mixed vectors/images and basic optional layers without touching source bytes", async () => {
    const bytes = makeComplexPdf({ pageCount: 4, hiddenLayer: true }), before = sha(bytes);
    expect(await inspectCompressionSource(bytes, signal())).toBe(4); expect(sha(bytes)).toBe(before);
  });
  it.each(["FlateDecode", "Fl"])("accepts native bounded %s streams", async (filter) => {
    expect(await inspectCompressionSource(await streamPdf(deflateSync(Buffer.from("ARTIFICIAL STREAM")), filter), signal())).toBe(1);
  });
  it("accepts a single-Flate filter array without confusing it with a multi-filter chain", async () => {
    expect(await inspectCompressionSource(await streamPdf(deflateSync(Buffer.from("ARTIFICIAL STREAM")), ["FlateDecode"]), signal())).toBe(1);
  });
  it.each(["ASCIIHexDecode", "AHx", "ASCII85Decode", "A85"])("allows bounded %s envelopes", async (filter) => {
    const data = Buffer.from(filter.includes("85") || filter === "A85" ? "z~>" : "414243>");
    expect(await inspectCompressionSource(await streamPdf(data, filter), signal())).toBe(1);
  });
  it("rejects an otherwise readable multi-filter chain before allocation-heavy optimization", async () => {
    const data = Buffer.from(deflateSync(Buffer.from("ARTIFICIAL STREAM")).toString("hex") + ">");
    await expect(inspectCompressionSource(await streamPdf(data, ["ASCIIHexDecode", "FlateDecode"]), signal())).rejects.toThrow("多重或特殊流编码");
  });
  it("rejects an unsupported LZW stream without guessing decoded size", async () => {
    await expect(inspectCompressionSource(await streamPdf(new Uint8Array([0]), "LZWDecode"), signal())).rejects.toThrow("多重或特殊流编码");
  });
  it.each(["AcroForm", "ByteRange", "EmbeddedFiles", "JavaScript", "OpenAction", "AF"])("rejects unsupported %s structures even when not on a visible page", async (name) => {
    const doc = await base(); doc.context.register(doc.context.obj({ [name]: [] }));
    await expect(inspectCompressionSource(await save(doc), signal())).rejects.toThrow("加密、签名、表单、附件或活动内容");
  });
  it("rejects a signature dictionary by type", async () => {
    const doc = await base(); doc.context.register(doc.context.obj({ Type: "Sig" }));
    await expect(inspectCompressionSource(await save(doc), signal())).rejects.toThrow("签名");
  });
  it("rejects file-attachment annotations", async () => {
    const doc = await base(); doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "FileAttachment" }));
    await expect(inspectCompressionSource(await save(doc), signal())).rejects.toThrow("附件");
  });
  it("rejects launch actions", async () => {
    const doc = await base(); doc.context.register(doc.context.obj({ S: "Launch" }));
    await expect(inspectCompressionSource(await save(doc), signal())).rejects.toThrow("活动内容");
  });
  it("rejects an encryption trailer rather than automatically decrypting it", async () => {
    const doc = await base();
    doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: "Standard", V: 1, R: 2, Length: 40,
      O: L.PDFHexString.of("00".repeat(32)), U: L.PDFHexString.of("00".repeat(32)), P: -4 }));
    await expect(inspectCompressionSource(await save(doc), signal())).rejects.toThrow();
  });
  it("rejects an image's oversized declared decode dimensions without allocating pixels", async () => {
    await expect(inspectCompressionSource(await imageHeaders([[4000, 3000]]), signal())).rejects.toThrow("图像解码预算");
  });
  it("rejects too many individually small image objects", async () => {
    await expect(inspectCompressionSource(await imageHeaders(Array.from({ length: 101 }, () => [1, 1])), signal())).rejects.toThrow("图像解码预算");
  });
  it("rejects cumulative image pixels even when every individual image is within budget", async () => {
    await expect(inspectCompressionSource(await imageHeaders(Array.from({ length: 5 }, () => [3000, 2500])), signal())).rejects.toThrow("图像解码预算");
  });
  it("rejects an actual Flate expansion above 16 MiB", async () => {
    const bytes = await streamPdf(deflateSync(new Uint8Array(16 * 1024 ** 2 + 1), { level: 1 }), "FlateDecode"), original = sha(bytes);
    await expect(inspectCompressionSource(bytes, signal())).rejects.toThrow("流展开后超出预算"); expect(sha(bytes)).toBe(original);
  });
  it("rejects cumulative Flate expansion above 64 MiB", async () => {
    const bytes = await streamPdf(deflateSync(new Uint8Array(13 * 1024 ** 2), { level: 1 }), "FlateDecode", 5);
    await expect(inspectCompressionSource(bytes, signal())).rejects.toThrow("流展开后超出预算");
  });
  it("applies the single-stream budget to already-uncompressed streams too", async () => {
    await expect(inspectCompressionSource(await streamPdf(new Uint8Array(16 * 1024 ** 2 + 1)), signal())).rejects.toThrow("16 MiB");
  });
  it("bounds ASCII85 expansion rather than treating its compressed bytes as decoded bytes", async () => {
    await expect(inspectCompressionSource(await streamPdf(new Uint8Array(4 * 1024 ** 2 + 1).fill(122), "ASCII85Decode"), signal())).rejects.toThrow("单流 16 MiB");
  });
  it("rejects excessive direct-object nesting", async () => {
    const doc = await base(); let value = doc.context.obj({ End: true });
    for (let i = 0; i < 100; i++) value = doc.context.obj({ Nested: value });
    doc.context.register(value);
    await expect(inspectCompressionSource(await save(doc), signal())).rejects.toThrow("结构超出安全检查范围");
  });
  it("respects cancellation without reading PDF document content", async () => {
    const controller = new AbortController(); controller.abort(new DOMException("Cancelled", "AbortError"));
    await expect(inspectCompressionSource(new Uint8Array([1]), controller.signal)).rejects.toHaveProperty("name", "AbortError");
  });
});

describe("actual JPEG header and decoder allocation guards", () => {
  it.each(["DCTDecode", "DCT"])("accepts a real generated JPEG with matching %s dictionary dimensions", async (filter) => {
    const jpeg = makeArtificialJpeg({ width: 64, height: 80 });
    expect(await inspectCompressionSource(await imageObjectPdf(jpeg, { Filter: filter }), signal())).toBe(1);
  });
  it("accepts a single-entry DCT filter array for the same real JPEG", async () => {
    const jpeg = makeArtificialJpeg({ width: 64, height: 80 });
    expect(await inspectCompressionSource(await imageObjectPdf(jpeg, { Filter: ["DCTDecode"] }), signal())).toBe(1);
  });
  it("rejects a real JPEG whose intrinsic dimensions are hidden behind a tiny PDF dictionary", async () => {
    const jpeg = makeArtificialJpeg({ width: 64, height: 80 }), bytes = await imageObjectPdf(jpeg, { Width: 1, Height: 1 });
    const original = sha(bytes);
    await expect(inspectCompressionSource(bytes, signal())).rejects.toThrow("JPEG 内部尺寸与 PDF 声明不一致");
    expect(sha(bytes)).toBe(original);
  });
  it("rejects an oversized intrinsic SOF header before attempting to decode its pixels", async () => {
    const jpeg = makeArtificialJpeg({ width: 64, height: 80 }), changed = jpeg.slice();
    const frame = jpegFrames(jpeg).segments.find((segment) => segment.marker === 192);
    expect(frame).toBeDefined();
    // The actual compressed pixels remain a tiny generated image. Only the adversarial header claims 32768 x 32768.
    changed[frame.position + 5] = changed[frame.position + 7] = 128;
    changed[frame.position + 6] = changed[frame.position + 8] = 0;
    await expect(inspectCompressionSource(await imageObjectPdf(changed, { Width: 1, Height: 1 }), signal())).rejects.toThrow("JPEG 内部尺寸");
    expect(sha(jpeg)).not.toBe(sha(changed));
  });
  it("rejects duplicate SOF frames rather than trusting the first dimension declaration", async () => {
    const jpeg = makeArtificialJpeg({ width: 64, height: 80 }), { segments, scan } = jpegFrames(jpeg);
    const frame = segments.find((segment) => segment.marker === 192);
    expect(frame).toBeDefined();
    const changed = new Uint8Array(Buffer.concat([jpeg.subarray(0, scan), jpeg.subarray(frame.position, frame.position + frame.length), jpeg.subarray(scan)]));
    await expect(inspectCompressionSource(await imageObjectPdf(changed), signal())).rejects.toThrow("JPEG 内部尺寸");
  });
  it("rejects an entropy DNL marker that would override a small SOF height before pixel allocation", async () => {
    const jpeg = makeArtificialJpeg({ width: 1000, height: 64 });
    // 65535 lines would require over 65 million pixels, but no decoder is invoked in this regression.
    const dnl = new Uint8Array([255, 220, 0, 4, 255, 255]);
    const changed = new Uint8Array(Buffer.concat([jpeg.subarray(0, -2), dnl, jpeg.subarray(-2)]));
    await expect(inspectCompressionSource(await imageObjectPdf(changed, { Width: 1000, Height: 64 }), signal())).rejects.toThrow("JPEG 内部尺寸");
  });
  it("continues validating markers after SOS and rejects a later second frame", async () => {
    const jpeg = makeArtificialJpeg({ width: 64, height: 80 }), { segments } = jpegFrames(jpeg);
    const frame = segments.find((segment) => segment.marker === 192);
    const changed = new Uint8Array(Buffer.concat([jpeg.subarray(0, -2), jpeg.subarray(frame.position, frame.position + frame.length), jpeg.subarray(-2)]));
    await expect(inspectCompressionSource(await imageObjectPdf(changed), signal())).rejects.toThrow("JPEG 内部尺寸");
  });
  it("rejects an unexpected nested SOI inside the entropy region", async () => {
    const jpeg = makeArtificialJpeg({ width: 64, height: 80 });
    const changed = new Uint8Array(Buffer.concat([jpeg.subarray(0, -2), new Uint8Array([255, 216]), jpeg.subarray(-2)]));
    await expect(inspectCompressionSource(await imageObjectPdf(changed), signal())).rejects.toThrow("JPEG 内部尺寸");
  });
  it.each([15, 240])("rejects invalid sampling factors 0x%s before invoking a JPEG decoder", async (sampling) => {
    const jpeg = makeArtificialJpeg({ width: 64, height: 80 }), changed = jpeg.slice();
    const frame = jpegFrames(jpeg).segments.find((segment) => segment.marker === 192);
    changed[frame.position + 11] = sampling;
    await expect(inspectCompressionSource(await imageObjectPdf(changed), signal())).rejects.toThrow("JPEG 内部尺寸");
  });
  it("rejects duplicate JPEG component identifiers", async () => {
    const jpeg = makeArtificialJpeg({ width: 64, height: 80 }), changed = jpeg.slice();
    const frame = jpegFrames(jpeg).segments.find((segment) => segment.marker === 192);
    changed[frame.position + 13] = changed[frame.position + 10];
    await expect(inspectCompressionSource(await imageObjectPdf(changed), signal())).rejects.toThrow("JPEG 内部尺寸");
  });
  it("requires a final EOI rather than accepting only the initial SOF dimensions", async () => {
    const jpeg = makeArtificialJpeg({ width: 64, height: 80 });
    await expect(inspectCompressionSource(await imageObjectPdf(jpeg.subarray(0, -2)), signal())).rejects.toThrow("JPEG 内部尺寸");
  });
  it("rejects a truncated real JPEG header instead of reading an unbounded or absent SOF", async () => {
    const jpeg = makeArtificialJpeg({ width: 64, height: 80 });
    await expect(inspectCompressionSource(await imageObjectPdf(jpeg.subarray(0, 24)), signal())).rejects.toThrow("JPEG 内部尺寸");
  });
  it.each(["JPXDecode", "JBIG2Decode", "CCITTFaxDecode", "CCF"])("rejects declared unsupported %s before decoding", async (filter) => {
    // These are adversarial encoded-image declarations, not claimed complete implementations of the unsupported codecs.
    await expect(inspectCompressionSource(await imageObjectPdf(new Uint8Array([0, 1, 2]), { Filter: filter }), signal())).rejects.toThrow("JPEG2000、JBIG2 或 CCITT");
  });
});

describe("predictor and color component budgets", () => {
  it("accepts the exact maximum supported row size with indirect DecodeParms", async () => {
    expect(await inspectCompressionSource(await predictorPdf({ Predictor: 1, Columns: 16384, Colors: 4, BitsPerComponent: 16 }), signal())).toBe(1);
  });
  it("accepts an array-wrapped indirect DecodeParms dictionary", async () => {
    expect(await inspectCompressionSource(await predictorPdf({ Predictor: 1, Columns: 1, Colors: 1, BitsPerComponent: 8 }, true), signal())).toBe(1);
  });
  it.each([
    { label: "invalid predictor", parameters: { Predictor: 9 } },
    { label: "zero columns", parameters: { Columns: 0 } },
    { label: "too many columns", parameters: { Columns: 16385 } },
    { label: "fractional columns", parameters: { Columns: 1.5 } },
    { label: "zero components", parameters: { Colors: 0 } },
    { label: "too many components", parameters: { Colors: 5 } },
    { label: "fractional components", parameters: { Colors: 1.5 } },
    { label: "unsupported sample precision", parameters: { BitsPerComponent: 3 } },
    { label: "excessive sample precision", parameters: { BitsPerComponent: 32 } },
  ])("rejects $label", async ({ parameters }) => {
    await expect(inspectCompressionSource(await predictorPdf(parameters), signal())).rejects.toThrow("预测器行宽或色彩参数");
  });
  it("rejects unknown DecodeParms instead of ignoring possible allocation controls", async () => {
    await expect(inspectCompressionSource(await predictorPdf({ UnrecognizedParameter: 1 }), signal())).rejects.toThrow("解码参数暂不支持安全预检");
  });
  it.each([0, 5])("rejects ICC declared N=%s outside the supported component budget", async (count) => {
    await expect(inspectCompressionSource(await componentPdf("ICC", count), signal())).rejects.toThrow("ICC 色彩分量");
  });
  it("rejects DeviceN with more than four declared components", async () => {
    await expect(inspectCompressionSource(await componentPdf("DeviceN", 5), signal())).rejects.toThrow(/色彩|DeviceN/);
  });
  it("rejects DeviceN even with few components because the family is explicitly unsupported", async () => {
    await expect(inspectCompressionSource(await componentPdf("DeviceN", 1), signal())).rejects.toThrow(/色彩|DeviceN/);
  });
  it("rejects a Separation image rather than guessing its tint-transform allocation", async () => {
    const bytes = await colorSpacePdf((doc) => ["Separation", "ArtificialSpot", "DeviceRGB", tintFunction(doc)]);
    await expect(inspectCompressionSource(bytes, signal())).rejects.toThrow(/色彩|Separation/);
  });
  it("rejects a forbidden DeviceN hidden as an Indexed base color space", async () => {
    const bytes = await colorSpacePdf((doc) => ["Indexed", ["DeviceN", ["ArtificialSpot"], "DeviceRGB", tintFunction(doc)], 0, L.PDFHexString.of("000000")]);
    await expect(inspectCompressionSource(bytes, signal())).rejects.toThrow(/色彩|DeviceN/);
  });
  it("rejects a forbidden Separation hidden as an ICC alternate space", async () => {
    const bytes = await colorSpacePdf((doc) => {
      const profile = doc.context.register(doc.context.stream(new Uint8Array(128), {
        N: 3, Alternate: ["Separation", "ArtificialSpot", "DeviceRGB", tintFunction(doc)],
      }));
      return ["ICCBased", profile];
    });
    await expect(inspectCompressionSource(bytes, signal())).rejects.toThrow(/色彩|Separation/);
  });
  it("bounds recursively nested color-space descriptors before a decoder can allocate them", async () => {
    const bytes = await colorSpacePdf(() => {
      let space = "DeviceRGB";
      for (let i = 0; i < 10; i++) space = ["Indexed", space, 0, L.PDFHexString.of("000000")];
      return space;
    });
    await expect(inspectCompressionSource(bytes, signal())).rejects.toThrow(/色彩|层级|深/);
  });
  it("allows an ordinary bounded calibrated RGB descriptor", async () => {
    const bytes = await colorSpacePdf(() => ["CalRGB", { WhitePoint: [0.9505, 1, 1.089], Gamma: [1, 1, 1] }]);
    expect(await inspectCompressionSource(bytes, signal())).toBe(1);
  });
  it("replaces raw parser failures without exposing synthetic document body markers", async () => {
    const marker = "ARTIFICIAL_PRIVATE_DOCUMENT_MARKER";
    const failure = await inspectCompressionSource(new Uint8Array(Buffer.from(`%PDF-1.7\n${marker}`)), signal()).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("无法安全检查此 PDF"); expect(failure.message).not.toContain(marker);
  });
});

describe("stream aliases, image precision and bounded component estimates", () => {
  it.each(["F", "DP"])("rejects a conflicting stream short key %s even beside long filter keys", async (alias) => {
    const doc = await base();
    doc.context.register(doc.context.stream(deflateSync(Buffer.from("ARTIFICIAL")), {
      Filter: "FlateDecode", DecodeParms: { Predictor: 1 }, [alias]: alias === "F" ? "FlateDecode" : { Predictor: 1 },
    }));
    await expect(inspectCompressionSource(await save(doc), signal())).rejects.toThrow("短键过滤器或外部数据引用");
  });
  it.each(["W", "H", "CS", "BPC", "IM", "D", "I"])("rejects conflicting image short key %s instead of trusting only long declarations", async (alias) => {
    const aliases = { W: 1, H: 1, CS: "DeviceGray", BPC: 1, IM: true, D: [0, 1], I: true };
    const jpeg = makeArtificialJpeg({ width: 64, height: 80 });
    await expect(inspectCompressionSource(await imageObjectPdf(jpeg, { [alias]: aliases[alias] }), signal())).rejects.toThrow("短键或冲突声明");
  });
  it("accepts an ImageMask's implicit one-bit sample precision", async () => {
    expect(await inspectCompressionSource(await imageEstimatePdf([{ ImageMask: true, omitBits: true }]), signal())).toBe(1);
  });
  it("accepts an explicitly one-bit ImageMask", async () => {
    expect(await inspectCompressionSource(await imageEstimatePdf([{ ImageMask: true, BitsPerComponent: 1 }]), signal())).toBe(1);
  });
  it("rejects ImageMask with conflicting eight-bit precision", async () => {
    await expect(inspectCompressionSource(await imageEstimatePdf([{ ImageMask: true, BitsPerComponent: 8 }]), signal())).rejects.toThrow("图像位深");
  });
  it("rejects a real eight-bit JPEG whose PDF dictionary claims sixteen-bit samples", async () => {
    const jpeg = makeArtificialJpeg({ width: 64, height: 80 });
    await expect(inspectCompressionSource(await imageObjectPdf(jpeg, { BitsPerComponent: 16 }), signal())).rejects.toThrow("图像位深");
  });
  it("accepts the bounded sixteen-bit CMYK estimate without allocating its declared pixel plane", async () => {
    // This header-only preflight estimate is not a successful giant-image decode or peak-memory test.
    const bytes = await imageEstimatePdf([{ Width: 4000, Height: 2000, ColorSpace: "DeviceCMYK", BitsPerComponent: 16 }]);
    expect(4000 * 2000 * 4 * 2).toBeLessThan(64 * 1024 ** 2);
    expect(await inspectCompressionSource(bytes, signal())).toBe(1);
  });
  it("rejects cumulative sixteen-bit components beyond 128 MiB while total pixels remain below 32 million", async () => {
    const specifications = Array.from({ length: 3 }, () => ({ Width: 3000, Height: 2000, ColorSpace: "DeviceCMYK", BitsPerComponent: 16 }));
    expect(3 * 3000 * 2000).toBeLessThan(32_000_000);
    await expect(inspectCompressionSource(await imageEstimatePdf(specifications), signal())).rejects.toThrow("图像分量数据预算");
  });
});

describe("content-stream inline-image preflight", () => {
  it.each(["Page", "PageArray", "Form", "Pattern", "PatternNoType", "Type3"])("rejects a real BI operator in %s content", async (kind) => {
    const bytes = await contentPdf(kind, inlineImageBody), original = sha(bytes);
    await expect(inspectCompressionSource(bytes, signal())).rejects.toThrow("内联图像操作");
    expect(sha(bytes)).toBe(original);
  });
  it.each(["Form", "Pattern"])("resolves an indirect %s type before guarding its contents", async (kind) => {
    await expect(inspectCompressionSource(await contentPdf(kind, inlineImageBody, undefined, true), signal())).rejects.toThrow("内联图像操作");
  });
  it.each([
    { label: "literal text", body: "BT /F1 12 Tf (BI) Tj ET" },
    { label: "hex text", body: "BT /F1 12 Tf <4249> Tj ET" },
    { label: "a comment", body: "q % BI is an artificial comment\n Q" },
    { label: "a PDF name", body: "/BI BMC EMC" },
    { label: "nested and escaped literal text", body: "BT (prefix (BI) \\(BI\\) suffix) Tj ET" },
  ])("does not confuse BI in $label with an image operator", async ({ body }) => {
    expect(await inspectCompressionSource(await contentPdf("Page", Buffer.from(body)), signal())).toBe(1);
  });
  it("retains the token across native Flate decoder chunk boundaries", async () => {
    // Use an explicit B/I split at the usual 16 KiB native decoder boundary.
    const split = Buffer.concat([Buffer.alloc(16383, 32), Buffer.from("BI /W 1 /H 1 /CS /RGB /BPC 8 ID \0\0\0 EI")]);
    expect(split[16383]).toBe(66); expect(split[16384]).toBe(73);
    await expect(inspectCompressionSource(await contentPdf("Page", deflateSync(split), "FlateDecode"), signal())).rejects.toThrow("内联图像操作");
  });
  it.each(["ASCIIHexDecode", "AHx", "ASCII85Decode", "A85"])("explicitly rejects %s page contents that cannot be checked for inline images", async (filter) => {
    const data = Buffer.from(filter.includes("85") || filter === "A85" ? "!!!!!~>" : "712051>");
    await expect(inspectCompressionSource(await contentPdf("PageArray", data, filter), signal())).rejects.toThrow("无法完整预检内联图像");
  });
  it.each(["ASCIIHexDecode", "AHx", "ASCII85Decode", "A85"])("keeps bounded %s image XObjects supported", async (filter) => {
    const ascii85 = filter.includes("85") || filter === "A85";
    const bytes = await imageEstimatePdf([{ Filter: filter, data: Buffer.from(ascii85 ? "!!!!!~>" : "000000>"),
      ColorSpace: ascii85 ? "DeviceCMYK" : "DeviceRGB" }]);
    expect(await inspectCompressionSource(bytes, signal())).toBe(1);
  });
});
