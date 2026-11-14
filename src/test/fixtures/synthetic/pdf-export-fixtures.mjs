/** Artificial text, vector and raster PDF fixtures; never reads a user document. */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function pdfStream(content, dictionary = "") {
  const bytes = Buffer.from(content, "ascii");
  return Buffer.concat([
    Buffer.from(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`),
    bytes, Buffer.from("\nendstream"),
  ]);
}

/**
 * Each page has selectable PAGE n text, asymmetric vector artwork and a real
 * RGB image XObject. The image-free option is only for negative validation tests.
 */
export function makeExportPdf({
  pages = [{ width: 420, height: 594, rotate: 0 }],
  label = "PAGENEST EXPORT FIXTURE",
  images = true,
  text = true,
  vectors = true,
  palette = "blue",
} = {}) {
  if (!pages.length || !/^[A-Z0-9 -]+$/.test(label) || !["blue", "orange"].includes(palette)) {
    throw new Error("Invalid artificial export fixture parameters");
  }
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${4 + index * 3} 0 R`).join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, { width, height, rotate = 0 }] of pages.entries()) {
    if (![width, height].every((value) => Number.isFinite(value) && value >= 300) || ![0, 90, 180, 270].includes(rotate)) {
      throw new Error("Invalid artificial page geometry");
    }
    const pageObject = 4 + index * 3;
    const imageObject = pageObject + 2;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Rotate ${rotate} /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 ${imageObject} 0 R >> >> /Contents ${pageObject + 1} 0 R >>`);
    const commands = ["q", "1 1 1 rg", `0 0 ${width} ${height} re f`];
    if (vectors) commands.push(
      palette === "blue" ? "0.15 0.4 0.85 rg" : "0.88 0.4 0.12 rg",
      `28 28 ${width - 56} ${height - 56} re f`,
      "0.9 0.1 0.5 rg", `40 100 m 105 100 l 40 170 l h f`,
      "0.1 0.7 0.3 RG", "5 w", `35 35 m ${width - 70} 90 l S`,
    );
    if (images) commands.push("q", `140 0 0 140 ${width - 190} 125 cm`, "/Im1 Do", "Q");
    if (text) commands.push(
      "0.05 0.1 0.2 rg", "1 1 1 rg", `42 ${height - 111} ${width - 84} 62 re f`,
      "0.05 0.1 0.2 rg", `BT /F1 12 Tf 49 ${height - 75} Td (${label}) Tj ET`,
      `BT /F1 19 Tf 49 ${height - 99} Td (PAGE ${index + 1}) Tj ET`,
    );
    commands.push("Q");
    objects.push(pdfStream(commands.join("\n")));
    const pixels = Buffer.alloc(16 * 16 * 3);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const offset = (y * 16 + x) * 3;
      const first = (x < 8) === (y < 8);
      pixels[offset] = first ? 235 : 15 + index % 100;
      pixels[offset + 1] = first ? 30 + index % 100 : 210;
      pixels[offset + 2] = first ? 25 : 70;
    }
    objects.push(pdfStream(pixels.toString("hex") + ">", "/Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode"));
  }
  const chunks = [Buffer.from("%PDF-1.4\n% Artificial PageNest export fixture\n")];
  const offsets = [];
  let length = chunks[0].length;
  for (const [index, object] of objects.entries()) {
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(object) ? object : Buffer.from(object), Buffer.from("\nendobj\n")]);
    offsets.push(length);
    chunks.push(chunk);
    length += chunk.length;
  }
  chunks.push(Buffer.from([
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f `,
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    `startxref\n${length}\n%%EOF\n`,
  ].join("\n")));
  return new Uint8Array(Buffer.concat(chunks));
}

export const exportMixedPages = [
  { width: 420, height: 594, rotate: 0 },
  { width: 594, height: 420, rotate: 0 },
  { width: 420, height: 594, rotate: 90 },
];

export function createExportFixtures() {
  return [
    { name: "export-single.pdf", pages: 1, bytes: makeExportPdf() },
    { name: "export-three.pdf", pages: 3, bytes: makeExportPdf({ pages: Array.from({ length: 3 }, () => exportMixedPages[0]) }) },
    { name: "export-mixed.pdf", pages: 3, bytes: makeExportPdf({ pages: exportMixedPages }) },
    { name: "export-rotations.pdf", pages: 4, bytes: makeExportPdf({ pages: [0, 90, 180, 270].map((rotate) => ({ width: 420, height: 594, rotate })) }) },
    { name: "export-24.pdf", pages: 24, bytes: makeExportPdf({ pages: Array.from({ length: 24 }, (_, index) => exportMixedPages[index % 3]) }) },
    { name: "export-100.pdf", pages: 100, bytes: makeExportPdf({ pages: Array.from({ length: 100 }, (_, index) => exportMixedPages[index % 3]) }) },
    { name: "export-orange.pdf", pages: 3, bytes: makeExportPdf({ label: "ORANGE EXPORT DOCUMENT", palette: "orange", pages: exportMixedPages }) },
  ];
}

/** Writes generated binaries only to the caller's local test directory. */
export async function writeExportFixtures(directory) {
  await mkdir(directory, { recursive: true });
  const records = [];
  for (const fixture of createExportFixtures()) {
    await writeFile(resolve(directory, fixture.name), fixture.bytes);
    records.push({ name: fixture.name, pages: fixture.pages, bytes: fixture.bytes.length, sha256: createHash("sha256").update(fixture.bytes).digest("hex") });
  }
  return records;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Pass a local ignored fixture directory");
  console.log(JSON.stringify(await writeExportFixtures(process.argv[2]), null, 2));
}
