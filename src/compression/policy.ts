import { loadPdfLibrary } from "../pdf/pdf-library";
import { PdfUserError } from "../pdf/types";
import { validatePdfHeader } from "../pdf/validation";
import { MAX_COMPRESSION_FILE_BYTES, MAX_COMPRESSION_PAGES } from "./types";

export const SOURCE_LIMITS = { objects: 50_000, nodes: 100_000, depth: 96,
  imagePixels: 8_000_000, totalImagePixels: 32_000_000, images: 100,
  imageDecodedBytes: 64 * 1024 ** 2, totalImageDecodedBytes: 128 * 1024 ** 2,
  decodedStream: 16 * 1024 ** 2, decodedTotal: 64 * 1024 ** 2 } as const;

/** Inline images have their own decoder dictionaries; Phase 3A supports bounded XObjects. */
function contentGuard() {
  let literal = 0, escaped = false, comment = false, hex = false, less = false, name = false, token = "";
  const flush = () => { if (!name && token === "BI") throw new PdfUserError("发现内联图像操作，当前压缩仅支持可完整预检的图像 XObject。未处理文件。"); token = ""; name = false; };
  return {
    read(bytes: Uint8Array) {
      for (const byte of bytes) {
        if (comment) { if (byte === 10 || byte === 13) comment = false; continue; }
        if (literal) {
          if (escaped) { escaped = false; continue; }
          if (byte === 92) escaped = true;
          else if (byte === 40) literal++;
          else if (byte === 41) literal--;
          continue;
        }
        if (less) { less = false; if (byte === 60) continue; hex = byte !== 62; continue; }
        if (hex) { if (byte === 62) hex = false; continue; }
        if ([0, 9, 10, 12, 13, 32, 40, 41, 60, 62, 91, 93, 123, 125, 47, 37].includes(byte)) {
          flush();
          if (byte === 40) literal = 1;
          else if (byte === 37) comment = true;
          else if (byte === 60) less = true;
          else if (byte === 47) name = true;
        } else token = token.length < 3 ? token + String.fromCharCode(byte) : "...";
      }
    },
    finish: flush,
  };
}

/** Decode dimensions must be checked in the JPEG itself, not only in its PDF dictionary. */
function jpegGeometry(bytes: Uint8Array) {
  if (bytes[0] !== 255 || bytes[1] !== 216) return null;
  let offset = 2;
  let geometry: { width: number; height: number } | null = null;
  let scanning = false;
  let scanSeen = false;
  const componentIds = new Set<number>();
  while (offset < bytes.length) {
    if (scanning) {
      while (offset < bytes.length && bytes[offset] !== 255) offset++;
      if (offset >= bytes.length) return null;
    }
    if (bytes[offset++] !== 255) return null;
    while (bytes[offset] === 255) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (scanning && (marker === 0 || marker >= 208 && marker <= 215)) continue;
    scanning = false;
    if (marker === 220 || marker === 216) return null; // DNL and nested images can change intrinsic dimensions.
    if (marker === 217) return scanSeen ? geometry : null;
    if (marker === 218) {
      if (offset + 3 > bytes.length) return null;
      const scanLength = bytes[offset] * 256 + bytes[offset + 1];
      const count = bytes[offset + 2];
      if (!geometry || count < 1 || count > 4 || scanLength !== 6 + count * 2 || offset + scanLength > bytes.length) return null;
      for (let component = 0; component < count; component++) if (!componentIds.has(bytes[offset + 3 + component * 2])) return null;
      offset += scanLength;
      scanning = true;
      scanSeen = true;
      continue;
    }
    if (marker === 1 || marker >= 208 && marker <= 215) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      const height = bytes[offset + 3] * 256 + bytes[offset + 4], width = bytes[offset + 5] * 256 + bytes[offset + 6];
      const components = bytes[offset + 7];
      if (![192, 193, 194].includes(marker) || geometry || bytes[offset + 2] !== 8 || ![1, 3, 4].includes(components) || length !== 8 + components * 3) return null;
      for (let component = 0; component < components; component++) {
        const id = bytes[offset + 8 + component * 3], sampling = bytes[offset + 9 + component * 3];
        const horizontal = sampling >> 4, vertical = sampling & 15;
        if (componentIds.has(id) || horizontal < 1 || horizontal > 4 || vertical < 1 || vertical > 4) return null;
        componentIds.add(id);
      }
      geometry = { width, height };
    }
    offset += length;
  }
  return null;
}

/** Checked inside the disposable optimization Worker before expensive image processing. */
async function inspectSource(bytes: Uint8Array, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  if (!bytes.length || bytes.length > MAX_COMPRESSION_FILE_BYTES) throw new PdfUserError("压缩输入超过 32 MiB 限制。");
  validatePdfHeader(bytes);
  const L = await loadPdfLibrary();
  const document = await L.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: false, throwOnInvalidObject: true });
  signal.throwIfAborted();
  const pageCount = document.getPageCount();
  if (!pageCount || pageCount > MAX_COMPRESSION_PAGES) throw new PdfUserError("压缩模块每份 PDF 最多支持 200 页。");
  const objects = document.context.enumerateIndirectObjects();
  if (objects.length > SOURCE_LIMITS.objects) throw new PdfUserError("PDF 对象过多，已停止以限制内存占用。");
  const visited = new Set<import("pdf-lib").PDFObject>();
  const streams: import("pdf-lib").PDFRawStream[] = [];
  const contentStreams = new Set<import("pdf-lib").PDFRawStream>();
  const markContent = (raw: import("pdf-lib").PDFObject | undefined) => {
    const value = document.context.lookup(raw);
    if (value instanceof L.PDFRawStream) contentStreams.add(value);
    else if (value instanceof L.PDFArray) for (const entry of value.asArray()) {
      const content = document.context.lookup(entry);
      if (content instanceof L.PDFRawStream) contentStreams.add(content);
    }
  };
  for (const page of document.getPages()) markContent(page.node.get(L.PDFName.Contents));
  let nodes = 0, images = 0, imagePixels = 0, decodedImageBytes = 0;
  const unsupported = () => new PdfUserError("此 PDF 含加密、签名、表单、附件或活动内容，当前压缩不支持这些结构。请保留原件。");
  const forbiddenKeys = new Set(["/AcroForm", "/XFA", "/Perms", "/ByteRange", "/EmbeddedFiles", "/AF", "/Collection", "/JavaScript", "/JS", "/OpenAction", "/AA"]);
  const colorComponents = (raw: import("pdf-lib").PDFObject | undefined, depth = 0): number => {
    if (depth > 8) throw new PdfUserError("图像色彩空间嵌套超出当前检查范围。");
    const space = document.context.lookup(raw);
    const name = space instanceof L.PDFArray ? String(document.context.lookup(space.get(0))) : String(space);
    if (["/DeviceGray", "/G", "/CalGray"].includes(name)) return 1;
    if (["/DeviceRGB", "/RGB", "/CalRGB", "/Lab"].includes(name)) return 3;
    if (["/DeviceCMYK", "/CMYK"].includes(name)) return 4;
    if (name === "/ICCBased" && space instanceof L.PDFArray) {
      const profile = document.context.lookup(space.get(1));
      const count = profile instanceof L.PDFRawStream ? Number(String(document.context.lookup(profile.dict.get(L.PDFName.of("N"))))) : NaN;
      if (![1, 3, 4].includes(count) || !(profile instanceof L.PDFRawStream)) throw new PdfUserError("ICC 色彩分量超出当前解码预算。");
      const alternate = profile.dict.get(L.PDFName.of("Alternate"));
      if (alternate !== undefined) colorComponents(alternate, depth + 1);
      return count;
    }
    if (["/Indexed", "/I"].includes(name) && space instanceof L.PDFArray) return colorComponents(space.get(1), depth + 1);
    throw new PdfUserError("图像使用当前压缩无法安全预检的色彩空间（包括 Separation、DeviceN 或未知嵌套空间）。");
  };
  const visit = (raw: import("pdf-lib").PDFObject | undefined, depth = 0) => {
    signal.throwIfAborted();
    if (!raw || visited.has(raw)) return;
    if (++nodes > SOURCE_LIMITS.nodes || depth > SOURCE_LIMITS.depth) throw new PdfUserError("PDF 结构超出安全检查范围。");
    visited.add(raw);
    if (raw instanceof L.PDFRef) return visit(document.context.lookup(raw), depth + 1);
    if (raw instanceof L.PDFRawStream) {
      if (["F", "DP"].some((key) => raw.dict.has(L.PDFName.of(key)))) throw new PdfUserError("当前压缩不支持含短键过滤器或外部数据引用的流。");
      if (String(document.context.lookup(raw.dict.get(L.PDFName.of("Subtype")))) === "/Form" ||
        String(document.context.lookup(raw.dict.get(L.PDFName.of("Type")))) === "/Pattern" ||
        String(document.context.lookup(raw.dict.get(L.PDFName.of("PatternType")))) === "1") contentStreams.add(raw);
      streams.push(raw); visit(raw.dict, depth + 1); return;
    }
    if (raw instanceof L.PDFArray) { for (const value of raw.asArray()) visit(value, depth + 1); return; }
    if (!(raw instanceof L.PDFDict)) return;
    if (raw.keys().some((key) => forbiddenKeys.has(key.asString()))) throw unsupported();
    const value = (key: string) => document.context.lookup(raw.get(L.PDFName.of(key)));
    const procedures = value("CharProcs");
    if (procedures instanceof L.PDFDict) for (const [, content] of procedures.entries()) markContent(content);
    if (["/Sig", "/RichMedia", "/Movie", "/Screen", "/3D", "/Widget", "/FileAttachment"].includes(String(value("Subtype"))) ||
      String(value("Type")) === "/Sig" || String(value("FT")) === "/Sig" ||
      ["/JavaScript", "/Launch", "/SubmitForm", "/ImportData", "/Rendition"].includes(String(value("S")))) throw unsupported();
    if (String(value("Subtype")) === "/Image") {
      if (["W", "H", "CS", "BPC", "IM", "D", "I"].some((key) => raw.has(L.PDFName.of(key)))) throw new PdfUserError("当前压缩不支持含短键或冲突声明的图像字典。");
      const width = Number(String(value("Width"))), height = Number(String(value("Height")));
      if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 16384) || width * height > SOURCE_LIMITS.imagePixels ||
        ++images > SOURCE_LIMITS.images || (imagePixels += width * height) > SOURCE_LIMITS.totalImagePixels) {
        throw new PdfUserError("图像解码预算超限：每图最多 800 万像素、累计 3200 万像素、最多 100 个图像对象。");
      }
      const filter = value("Filter");
      const imageFilter = filter instanceof L.PDFArray && filter.size() === 1 ? String(document.context.lookup(filter.get(0))) : String(filter);
      if (["/JPXDecode", "/JBIG2Decode", "/CCITTFaxDecode", "/CCF"].includes(imageFilter)) {
        throw new PdfUserError("当前压缩暂不支持无法完整预检解码尺寸的 JPEG2000、JBIG2 或 CCITT 图像。");
      }
      if (["/DCTDecode", "/DCT"].includes(imageFilter)) {
        const stream = objects.find(([, object]) => object instanceof L.PDFRawStream && object.dict === raw)?.[1];
        const geometry = stream instanceof L.PDFRawStream ? jpegGeometry(stream.getContents()) : null;
        if (!geometry || geometry.width !== width || geometry.height !== height) throw new PdfUserError("JPEG 内部尺寸与 PDF 声明不一致或编码暂不支持，已停止以限制解码风险。");
      }
      const mask = String(value("ImageMask")) === "true";
      const rawBits = value("BitsPerComponent"), bits = rawBits === undefined && mask ? 1 : Number(String(rawBits));
      if (![1, 2, 4, 8, 16].includes(bits) || mask && bits !== 1 || ["/DCTDecode", "/DCT"].includes(imageFilter) && bits !== 8) {
        throw new PdfUserError("图像位深超出当前安全解码支持范围。");
      }
      const components = mask ? 1 : colorComponents(raw.get(L.PDFName.of("ColorSpace")));
      const expanded = Math.ceil(width * height * components * bits / 8);
      decodedImageBytes += expanded;
      if (expanded > SOURCE_LIMITS.imageDecodedBytes || decodedImageBytes > SOURCE_LIMITS.totalImageDecodedBytes) throw new PdfUserError("图像分量数据预算超限：单图 64 MiB、累计 128 MiB（不代表完整浏览器堆上限）。");
    }
    for (const [, entry] of raw.entries()) visit(entry, depth + 1);
  };
  for (const [, object] of objects) visit(object);
  let decodedTotal = 0;
  for (const stream of streams) {
    signal.throwIfAborted();
    let filter = document.context.lookup(stream.dict.get(L.PDFName.of("Filter")));
    if (filter instanceof L.PDFArray && filter.size() === 1) filter = document.context.lookup(filter.get(0));
    const guard = contentStreams.has(stream) ? contentGuard() : null;
    if (guard && filter && !["/FlateDecode", "/Fl"].includes(String(filter))) {
      throw new PdfUserError("此内容流使用当前无法完整预检内联图像的编码，未处理文件。");
    }
    let parameters = document.context.lookup(stream.dict.get(L.PDFName.of("DecodeParms")));
    if (parameters instanceof L.PDFArray && parameters.size() === 1) parameters = document.context.lookup(parameters.get(0));
    if (parameters && parameters !== L.PDFNull) {
      if (!(parameters instanceof L.PDFDict) || parameters.keys().some((key) => !["/Predictor", "/Columns", "/Colors", "/BitsPerComponent"].includes(key.asString()))) {
        throw new PdfUserError("图像或内容流的解码参数暂不支持安全预检。");
      }
      const parameter = (key: string, fallback: number) => { const value = parameters.get(L.PDFName.of(key)); return value === undefined ? fallback : Number(String(document.context.lookup(value))); };
      const predictor = parameter("Predictor", 1), columns = parameter("Columns", 1), colors = parameter("Colors", 1), bits = parameter("BitsPerComponent", 8);
      if (guard && predictor !== 1) throw new PdfUserError("内容流使用了图像预测器，当前无法可靠预检内联图像，未处理文件。");
      if (![1, 2, 10, 11, 12, 13, 14, 15].includes(predictor) || !Number.isSafeInteger(columns) || columns < 1 || columns > 16384 ||
        !Number.isSafeInteger(colors) || colors < 1 || colors > 4 || ![1, 2, 4, 8, 16].includes(bits) || columns * colors * bits / 8 > 131072) {
        throw new PdfUserError("PDF 图像预测器行宽或色彩参数超出当前解码预算。");
      }
    }
    if (!filter) {
      if (stream.getContentsSize() > SOURCE_LIMITS.decodedStream) throw new PdfUserError("未压缩的 PDF 单流超过 16 MiB 预算。");
      decodedTotal += stream.getContentsSize();
      guard?.read(stream.getContents());
    }
    else if (["/ASCIIHexDecode", "/AHx", "/ASCII85Decode", "/A85"].includes(String(filter))) {
      if (guard) throw new PdfUserError("此内容流使用当前无法完整预检内联图像的文本编码，未处理文件。");
      // Hex never expands; each ASCII85 'z' can expand to four bytes.
      const bound = stream.getContentsSize() * (["/A85", "/ASCII85Decode"].includes(String(filter)) ? 4 : 1);
      if (bound > SOURCE_LIMITS.decodedStream) throw new PdfUserError("PDF 编码流展开后可能超过单流 16 MiB 预算。");
      decodedTotal += bound;
    }
    else if (["/FlateDecode", "/Fl"].includes(String(filter))) {
      const owned = stream.getContents().slice();
      const reader = new Blob([owned]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
      let decoded = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          try {
            decoded += chunk.value.byteLength;
            decodedTotal += chunk.value.byteLength;
            if (decoded > SOURCE_LIMITS.decodedStream || decodedTotal > SOURCE_LIMITS.decodedTotal) {
              throw new PdfUserError("PDF 流展开后超出预算：单流 16 MiB、累计 64 MiB。");
            }
            guard?.read(chunk.value);
          } finally { chunk.value.fill(0); }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); owned.fill(0); }
    } else if (!["/DCTDecode", "/DCT"].includes(String(filter))) {
      throw new PdfUserError("此 PDF 使用当前压缩无法安全预检的多重或特殊流编码，未处理文件。");
    }
    if (decodedTotal > SOURCE_LIMITS.decodedTotal) throw new PdfUserError("PDF 流展开后的累计体积超过 64 MiB 预算。");
    guard?.finish();
  }
  return pageCount;
}

export async function inspectCompressionSource(bytes: Uint8Array, signal: AbortSignal): Promise<number> {
  try { return await inspectSource(bytes, signal); }
  catch (error) {
    signal.throwIfAborted();
    if (error instanceof PdfUserError) throw error;
    throw new PdfUserError("无法安全检查此 PDF；它可能已损坏、受密码保护或含不支持的结构。未处理文件。");
  }
}
