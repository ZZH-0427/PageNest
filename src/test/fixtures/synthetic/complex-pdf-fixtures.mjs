/** Entirely artificial PDFs. Embedded Chinese Type3 outlines are authored here, not copied fonts. */
import { deflateSync } from "node:zlib";

const glyphs = [
  ["4E2D", "220 240 560 480 re S 500 80 m 500 920 l S"],
  ["65E5", "220 120 560 760 re S 220 500 m 780 500 l S"],
  ["53E3", "220 180 560 640 re S"],
  ["7530", "180 140 640 720 re S 180 500 m 820 500 l S 500 140 m 500 860 l S"],
  ["5341", "120 520 m 880 520 l S 500 100 m 500 900 l S"],
  ["5C71", "180 680 m 180 160 l 820 160 l 820 680 l S 500 160 m 500 900 l S"],
  ["5DDD", "220 850 m 220 500 l 180 150 l S 500 820 m 500 180 l S 800 860 m 800 120 l S"],
  ["6728", "100 650 m 900 650 l S 500 120 m 500 900 l S 500 650 m 120 180 l S 500 650 m 880 180 l S"],
];

export const COMPLEX_CHINESE_TEXT = "中日口田十山川木";

function stream(content, dictionary = "") {
  const data = deflateSync(Buffer.isBuffer(content) ? content : Buffer.from(content, "ascii"));
  return Buffer.concat([Buffer.from(`<< ${dictionary} /Filter /FlateDecode /Length ${data.length} >>\nstream\n`), data, Buffer.from("\nendstream")]);
}

/** Twelve pages combine inherited resources, embedded glyphs, split content streams and clipped media. */
export function makeComplexPdf({ pageCount = 12, crop = true, chinese = true, images = true, table = true, hiddenLayer = false } = {}) {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 100) throw new Error("Invalid artificial page count");
  const objects = ["", ""];
  const add = (value) => { objects.push(value); return objects.length; };
  const latin = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const charProcs = glyphs.map(([, outline]) => add(stream(`1000 0 0 0 1000 1000 d1\n65 w 1 J 1 j\n${outline}`)));
  const unicode = add(stream([
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "/CIDSystemInfo << /Registry (Artificial) /Ordering (Chinese) /Supplement 0 >> def",
    "/CMapName /ArtificialChinese def /CMapType 2 def",
    "1 begincodespacerange <00> <FF> endcodespacerange",
    `${glyphs.length} beginbfchar`,
    ...glyphs.map(([code], index) => `<${(65 + index).toString(16)}> <${code}>`),
    "endbfchar endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n")));
  const chineseFont = add(`<< /Type /Font /Subtype /Type3 /Name /ArtificialChinese /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /FirstChar 65 /LastChar 72 /Widths [${glyphs.map(() => 1000).join(" ")}] /Encoding << /Type /Encoding /Differences [65 ${glyphs.map((_, index) => `/g${index}`).join(" ")}] >> /CharProcs << ${charProcs.map((ref, index) => `/g${index} ${ref} 0 R`).join(" ")} >> /Resources << >> /ToUnicode ${unicode} 0 R >>`);
  const pixels = Buffer.alloc(24 * 24 * 3);
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
    const offset = (y * 24 + x) * 3;
    pixels[offset] = x < 12 ? 225 : 30;
    pixels[offset + 1] = y < 12 ? 60 : 205;
    pixels[offset + 2] = (x + y) % 3 ? 120 : 245;
  }
  const image = add(stream(pixels, "/Type /XObject /Subtype /Image /Width 24 /Height 24 /ColorSpace /DeviceRGB /BitsPerComponent 8"));
  const optionalGroup = hiddenLayer ? add("<< /Type /OCG /Name (Artificial hidden layer) >>") : null;
  const resources = add(`<< /Font << /Fl ${latin} 0 R /Fc ${chineseFont} 0 R >> /XObject << /Im ${image} 0 R >> /ExtGState << /Ghalf << /Type /ExtGState /ca 0.45 /CA 0.45 >> >> ${hiddenLayer ? `/Properties << /Hidden ${optionalGroup} 0 R >>` : ""} >>`);
  const kids = [];
  for (let index = 0; index < pageCount; index++) {
    const landscape = index % 3 === 1;
    const width = landscape ? 842 : 595;
    const height = landscape ? 595 : 842;
    const margin = crop ? 30 : 0;
    const cropBox = [margin, margin + 5, width - margin - 10, height - margin - 15];
    const top = cropBox[3] - 30;
    const header = ["q 1 1 1 rg", `0 0 ${width} ${height} re f`, "0.1 0.2 0.4 rg", `BT /Fl 14 Tf 48 ${top} Td (PAGENEST COMPLEX FIXTURE - PAGE ${index + 1}) Tj ET`];
    if (chinese) header.push(`BT /Fc 19 Tf 48 ${top - 35} Td <4142434445464748> Tj ET`);
    header.push("Q");
    const body = ["q", "0.1 0.25 0.45 RG 0.65 w"];
    const left = 48; const right = width - 58; const rowTop = top - 66; const rows = 13;
    if (table) {
      body.push("0.88 0.93 0.98 rg", `${left} ${rowTop - 27} ${right - left} 27 re f`);
      for (let row = 0; row <= rows; row++) body.push(`${left} ${rowTop - row * 23} m ${right} ${rowTop - row * 23} l S`);
      for (let column = 0; column <= 5; column++) {
        const x = left + (right - left) * column / 5;
        body.push(`${x.toFixed(4)} ${rowTop} m ${x.toFixed(4)} ${rowTop - rows * 23} l S`);
      }
      for (let row = 0; row < rows; row++) for (let column = 0; column < 5; column++) {
        const x = left + 5 + (right - left) * column / 5;
        const y = rowTop - row * 23 - 16;
        body.push(`0.1 0.2 0.3 rg BT /Fl 8 Tf ${x.toFixed(4)} ${y} Td (${index + 1}.${row + 1}.${column + 1}) Tj ET`);
        if (chinese && column === 0) body.push(`BT /Fc 8 Tf ${(x + 34).toFixed(4)} ${y} Td <4144> Tj ET`);
      }
    }
    const pictureY = Math.max(cropBox[1] + 30, rowTop - rows * 23 - 108);
    if (images) body.push(`q 85 0 0 85 58 ${pictureY} cm /Im Do Q`);
    body.push("q /Ghalf gs 0.85 0.15 0.3 rg", `180 ${pictureY} m 250 ${pictureY} l 180 ${pictureY + 80} l h f Q`, "Q");
    if (hiddenLayer) body.push(`/OC /Hidden BDC q 1 0 0 rg 45 45 ${width - 90} ${height - 90} re f Q EMC`);
    const footer = `q 0.2 0.3 0.4 rg BT /Fl 9 Tf 48 ${cropBox[1] + 12} Td (ARTIFICIAL DATA ONLY - ${index + 1}/${pageCount}) Tj ET Q`;
    const streams = [header.join("\n"), body.join("\n"), footer].map((content) => add(stream(content)));
    const contentArray = add(`[${streams.map((ref) => `${ref} 0 R`).join(" ")}]`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ${crop ? `/CropBox [${cropBox.join(" ")}]` : ""} /Rotate ${(index % 4) * 90} /Contents ${contentArray} 0 R >>`));
  }
  objects[0] = `<< /Type /Catalog /Pages 2 0 R ${hiddenLayer ? `/OCProperties << /OCGs [${optionalGroup} 0 R] /D << /BaseState /ON /OFF [${optionalGroup} 0 R] /Order [${optionalGroup} 0 R] >> >>` : ""} >>`;
  objects[1] = `<< /Type /Pages /Count ${pageCount} /Kids [${kids.map((ref) => `${ref} 0 R`).join(" ")}] /Resources ${resources} 0 R >>`;
  const chunks = [Buffer.from("%PDF-1.7\n% Artificial complex Chinese table fixture\n")];
  const offsets = []; let length = chunks[0].length;
  for (const [index, object] of objects.entries()) {
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(object) ? object : Buffer.from(object), Buffer.from("\nendobj\n")]);
    offsets.push(length); chunks.push(chunk); length += chunk.length;
  }
  chunks.push(Buffer.from([`xref\n0 ${objects.length + 1}\n0000000000 65535 f `, ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `), `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`].join("\n")));
  return new Uint8Array(Buffer.concat(chunks));
}
