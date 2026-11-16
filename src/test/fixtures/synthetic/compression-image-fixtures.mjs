/** Artificial source generators and Node-only codecs; no user files are read. */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFDocument, PDFDict, PDFArray, PDFRawStream, PDFRef, PDFName, PDFNumber, StandardFonts, rgb, degrees, setTextRenderingMode } from "pdf-lib";
import { makeComplexPdf } from "./complex-pdf-fixtures.mjs";

/** Remove only metadata emitted while generating this artificial JPEG. */
export function stripGeneratedJpegMetadata(bytes) {
  const parts = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 < bytes.length) {
    const start = offset, marker = bytes[offset + 1];
    if (marker === 218) { parts.push(bytes.subarray(start)); break; }
    const length = bytes[offset + 2] * 256 + bytes[offset + 3];
    if (length < 2 || offset + length + 2 > bytes.length) throw new Error("Invalid artificial JPEG");
    if (!(marker >= 225 && marker <= 239 || marker === 254)) parts.push(bytes.subarray(start, offset + length + 2));
    offset += length + 2;
  }
  return new Uint8Array(Buffer.concat(parts));
}
export function makeArtificialJpeg({ width = 640, height = 880, quality = 98, icc = false } = {}) {
  const canvas = createCanvas(width, height), context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  let seed = 7;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const noise = (seed = (seed * 1664525 + 1013904223) >>> 0) % 17 - 8, position = (y * width + x) * 4;
    image.data[position] = Math.max(0, Math.min(255, 180 + 50 * Math.sin(x / 90) + noise));
    image.data[position + 1] = Math.max(0, Math.min(255, 180 + 50 * Math.cos(y / 130) + noise));
    image.data[position + 2] = Math.max(0, Math.min(255, 160 + 50 * Math.cos((x + y) / 160) + noise));
    image.data[position + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  context.fillStyle = "#ffffff"; context.fillRect(30, 30, width - 60, 100);
  context.fillStyle = "#17243d"; context.font = "22px sans-serif";
  context.fillText("ARTIFICIAL JPEG — NO PRIVATE DATA", 40, 70);
  context.fillText("PageNest compression fixture", 40, 105);
  const jpeg = canvas.encodeSync("jpeg", quality);
  canvas.width = canvas.height = 1; image.data.fill(0);
  return icc ? new Uint8Array(jpeg) : stripGeneratedJpegMetadata(jpeg);
}
export async function makeCompressionImagePdf({ count = 2, quality = 98, images = true, text = true,
  vectors = true, crop = true, ocr = false, icc = false, transparentPng = false, opacity = false } = {}) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle("Artificial compression document"); pdf.setAuthor("PageNest synthetic fixture");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const jpeg = images ? await pdf.embedJpg(makeArtificialJpeg({ quality, icc })) : null;
  let png;
  if (transparentPng) {
    const canvas = createCanvas(64, 64), context = canvas.getContext("2d");
    context.fillStyle = "rgba(0,0,255,0.4)"; context.fillRect(8, 8, 48, 48);
    png = await pdf.embedPng(canvas.toBuffer("image/png")); canvas.width = canvas.height = 1;
  }
  for (let i = 0; i < count; i++) {
    const page = pdf.addPage([500, 700]);
    if (jpeg) page.drawImage(jpeg, { x: 0, y: 0, width: 500, height: 700 });
    if (text) {
      if (ocr) page.pushOperators(setTextRenderingMode(3));
      page.drawText("SELECTABLE OCR PAGE " + (i + 1), { x: 100, y: 325, size: 16, font, color: rgb(0.1, 0.1, 0.1) });
      if (ocr) page.pushOperators(setTextRenderingMode(0));
    }
    if (vectors) page.drawRectangle({ x: 90, y: 310, width: 300, height: 40, borderWidth: 3,
      borderColor: rgb(0.9, 0, 0.2), ...(opacity ? { opacity: 0.5, borderOpacity: 0.5 } : {}) });
    if (png) page.drawImage(png, { x: 50, y: 500, width: 120, height: 120 });
    page.setRotation(degrees(i % 4 * 90));
    if (crop) page.setCropBox(12, 17, 472, 661);
  }
  return pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
}
/** Explicitly opaque Chinese Type3/table input; transparent-context cases are separate. */
export async function makeChineseCompressionImagePdf() {
  const pdf = await PDFDocument.load(makeComplexPdf({ pageCount: 2 }), { updateMetadata: false });
  const seen = new Set();
  const opaque = (raw) => {
    if (!raw || seen.has(raw)) return;
    seen.add(raw);
    const object = raw instanceof PDFRef ? pdf.context.lookup(raw) : raw;
    if (object instanceof PDFRawStream) opaque(object.dict);
    else if (object instanceof PDFDict) {
      for (const key of ["ca", "CA"]) if (object.has(PDFName.of(key))) object.set(PDFName.of(key), PDFNumber.of(1));
      for (const [, value] of object.entries()) opaque(value);
    } else if (object instanceof PDFArray) for (const item of object.asArray()) opaque(item);
  };
  for (const [, object] of pdf.context.enumerateIndirectObjects()) opaque(object);
  const jpeg = await pdf.embedJpg(makeArtificialJpeg());
  for (const page of pdf.getPages()) page.drawImage(jpeg, { x: 300, y: 100, width: 150, height: 210 });
  return pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
}
export const nodeJpegCodec = {
  async encode(jpeg, width, height, quality, signal) {
    signal.throwIfAborted();
    const image = await loadImage(Buffer.from(jpeg)), canvas = createCanvas(width, height);
    try { canvas.getContext("2d").drawImage(image, 0, 0); return new Uint8Array(canvas.encodeSync("jpeg", Math.round(quality * 100))); }
    finally { canvas.width = canvas.height = 1; }
  },
  async compare(source, output, width, height, signal) {
    const pixels = async (bytes) => {
      const image = await loadImage(Buffer.from(bytes)), canvas = createCanvas(width, height);
      try { canvas.getContext("2d").drawImage(image, 0, 0); return canvas.getContext("2d").getImageData(0, 0, width, height).data; }
      finally { canvas.width = canvas.height = 1; }
    };
    let first, second;
    try {
      first = await pixels(source); second = await pixels(output);
      let squares = 0, absolute = 0;
      for (let i = 0; i < first.length; i++) if (i % 4 !== 3) { const delta = first[i] - second[i]; squares += delta * delta; absolute += Math.abs(delta); }
      signal.throwIfAborted();
      const samples = width * height * 3;
      return { psnr: squares === 0 ? Infinity : 10 * Math.log10(255 ** 2 / (squares / samples)), meanAbsoluteDelta: absolute / samples };
    } finally { first?.fill(0); second?.fill(0); }
  },
};
