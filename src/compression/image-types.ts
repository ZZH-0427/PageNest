import type { PDFRawStream } from "pdf-lib";

export type ImageProfile = "high" | "balanced" | "strong";
export interface ImageQualityMetrics { psnr: number; meanAbsoluteDelta: number }
export interface JpegCodec {
  encode(jpeg: Uint8Array, width: number, height: number, quality: number, signal: AbortSignal): Promise<Uint8Array>;
  compare(source: Uint8Array, output: Uint8Array, width: number, height: number, signal: AbortSignal): Promise<ImageQualityMetrics>;
}
export const IMAGE_PROFILES = {
  high: { quality: 0.88, minimumImagePsnr: 32, maximumImageMae: 5, minimumPagePsnr: 35 },
  balanced: { quality: 0.72, minimumImagePsnr: 28, maximumImageMae: 8, minimumPagePsnr: 30 },
  strong: { quality: 0.50, minimumImagePsnr: 25, maximumImageMae: 11, minimumPagePsnr: 27 },
} as const;
export const IMAGE_LIMITS = {
  maximumDimension: 4096, maximumPixels: 4_000_000, maximumTotalPixels: 32_000_000,
  maximumImages: 100, maximumJpegBytes: 16 * 1024 ** 2,
} as const;
export interface JpegImageDescriptor { width: number; height: number; pixels: number }

/** Only a narrow, predictable DeviceRGB baseline JFIF JPEG is eligible. */
export function inspectJpegImage(stream: PDFRawStream): JpegImageDescriptor | null {
  const dict = stream.dict;
  const allowed = new Set(["/Type", "/Subtype", "/Width", "/Height", "/ColorSpace", "/BitsPerComponent", "/Filter", "/Length", "/Interpolate"]);
  if (dict.keys().some((key) => !allowed.has(key.asString())) ||
    String(dict.get(dict.keys().find((key) => key.asString() === "/Subtype")!)) !== "/Image") return null;
  const value = (key: string) => { const name = dict.keys().find((item) => item.asString() === key); return name ? dict.get(name) : undefined; };
  if (String(value("/Type")) !== "/XObject" || String(value("/Filter")) !== "/DCTDecode" ||
    String(value("/ColorSpace")) !== "/DeviceRGB" || String(value("/BitsPerComponent")) !== "8") return null;
  if (value("/Interpolate") !== undefined && !["true", "false"].includes(String(value("/Interpolate")))) return null;
  const width = Number(String(value("/Width"))), height = Number(String(value("/Height")));
  if (![width, height].every((size) => Number.isSafeInteger(size) && size > 0 && size <= IMAGE_LIMITS.maximumDimension) || width * height > IMAGE_LIMITS.maximumPixels) return null;
  return inspectJpegBytes(stream.getContents(), width, height) ? { width, height, pixels: width * height } : null;
}

export function inspectJpegBytes(bytes: Uint8Array, width: number, height: number): boolean {
  if (bytes.length < 16 || bytes.length > IMAGE_LIMITS.maximumJpegBytes || bytes[0] !== 255 || bytes[1] !== 216 ||
    bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) return false;
  let offset = 2, jfif = false, frame = false;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 255) return false;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 218) {
      const length = bytes[offset] * 256 + bytes[offset + 1];
      if (!frame || !jfif || length < 6 || offset + length > bytes.length) return false;
      // A single baseline scan only; metadata or additional scans after entropy are unsupported.
      for (let index = offset + length; index < bytes.length - 1; index++) {
        if (bytes[index] !== 255) continue;
        while (bytes[index + 1] === 255) index++;
        const next = bytes[++index];
        if (next === 0 || next >= 208 && next <= 215) continue;
        return next === 217 && index === bytes.length - 1;
      }
      return false;
    }
    if (marker === 217 || marker === 216 || marker === 0 || marker >= 208 && marker <= 215 || offset + 2 > bytes.length) return false;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return false;
    if (marker >= 224 && marker <= 239 || marker === 254) {
      if (marker !== 224 || length < 16 || String.fromCharCode(...bytes.subarray(offset + 2, offset + 7)) !== "JFIF\0") return false;
      jfif = true;
    }
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (marker !== 192 || frame || length !== 17 || bytes[offset + 2] !== 8 || bytes[offset + 7] !== 3 ||
        bytes[offset + 3] * 256 + bytes[offset + 4] !== height || bytes[offset + 5] * 256 + bytes[offset + 6] !== width ||
        [0, 1, 2].some((index) => bytes[offset + 8 + index * 3] !== index + 1)) return false;
      frame = true;
    }
    offset += length;
  }
  return false;
}

/** Only for newly encoded bytes owned by the encoder, never for user input. */
export function normalizeEncodedJpeg(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 255 || bytes[1] !== 216) return bytes.slice();
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    const start = offset;
    if (bytes[offset++] !== 255) return bytes.slice();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 218) { parts.push(bytes.subarray(start)); break; }
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return bytes.slice();
    if (!(marker >= 225 && marker <= 239 || marker === 254)) parts.push(bytes.subarray(start, offset + length));
    offset += length;
  }
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of parts) { output.set(part, position); position += part.length; }
  return output;
}

export function acceptableImageQuality(metrics: ImageQualityMetrics, profile: ImageProfile): boolean {
  const settings = IMAGE_PROFILES[profile];
  return (Number.isFinite(metrics.psnr) || metrics.psnr === Infinity) && metrics.psnr >= settings.minimumImagePsnr &&
    Number.isFinite(metrics.meanAbsoluteDelta) && metrics.meanAbsoluteDelta >= 0 && metrics.meanAbsoluteDelta <= settings.maximumImageMae;
}
