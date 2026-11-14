/**
 * Artificial PDF fixtures generated from objects, never from user files.
 * R2 encryption exists solely to exercise password rejection and must not be
 * used to protect real data. All page text and vector artwork are synthetic.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const padding = Buffer.from(
  "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a",
  "hex",
);
const md5 = (bytes) => createHash("md5").update(bytes).digest();
const padded = (value) =>
  Buffer.concat([Buffer.from(value, "ascii"), padding]).subarray(0, 32);

function rc4(key, bytes) {
  const table = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + table[i] + key[i % key.length]) & 255;
    [table[i], table[j]] = [table[j], table[i]];
  }
  let i = 0;
  j = 0;
  return Buffer.from(bytes.map((byte) => {
    i = (i + 1) & 255;
    j = (j + table[i]) & 255;
    [table[i], table[j]] = [table[j], table[i]];
    return byte ^ table[(table[i] + table[j]) & 255];
  }));
}

// PDF 32000-1:2008, 7.6.2 / 7.6.3.3 / 7.6.3.4, revision 2.
function fixtureEncryption() {
  const user = padded("demo");
  const owner = rc4(md5(padded("owner")).subarray(0, 5), user);
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-4);
  const id = md5(Buffer.from("PageNest synthetic encrypted fixture"));
  const key = md5(Buffer.concat([user, owner, permissions, id])).subarray(0, 5);
  return {
    id: id.toString("hex"),
    dictionary: `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${owner.toString("hex")}> /U <${rc4(key, padding).toString("hex")}> >>`,
    encrypt(bytes, objectNumber) {
      const suffix = Buffer.from([
        objectNumber & 255,
        (objectNumber >> 8) & 255,
        (objectNumber >> 16) & 255,
        0,
        0,
      ]);
      return rc4(md5(Buffer.concat([key, suffix])).subarray(0, 10), bytes);
    },
  };
}

/** @param {{ pages?: Array<{width:number,height:number,rotate?:number}>, label?:string, color?:number[], encrypted?:boolean }} options */
export function makePdf({
  pages = [{ width: 420, height: 594 }],
  label = "PAGENEST SYNTHETIC",
  color = [0.15, 0.4, 0.85],
  encrypted = false,
} = {}) {
  if (!pages.length || !/^[A-Z0-9 -]+$/.test(label)) {
    throw new Error("Invalid synthetic fixture parameters");
  }
  const encryption = encrypted ? fixtureEncryption() : null;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, { width, height, rotate = 0 }] of pages.entries()) {
    const pageObject = 4 + index * 2;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Rotate ${rotate} /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObject + 1} 0 R >>`);
    let content = Buffer.from([
      "q",
      "0.97 0.98 1 rg",
      `0 0 ${width} ${height} re f`,
      `${color.join(" ")} rg`,
      `28 28 ${width - 56} ${height - 56} re f`,
      "1 1 1 rg",
      `42 ${height - 122} ${width - 84} 54 re f`,
      "0.1 0.15 0.25 rg",
      `BT /F1 14 Tf 49 ${height - 91} Td (${label}) Tj ET`,
      "1 1 1 rg",
      `BT /F1 24 Tf 45 55 Td (PAGE ${index + 1}) Tj ET`,
      "Q",
    ].join("\n"), "ascii");
    if (encryption) content = encryption.encrypt(content, pageObject + 1);
    objects.push(Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
      content,
      Buffer.from("\nendstream"),
    ]));
  }
  if (encryption) objects.push(encryption.dictionary);
  const chunks = [Buffer.from("%PDF-1.4\n% Synthetic PageNest fixture\n")];
  const offsets = [0];
  let length = chunks[0].length;
  for (const [index, object] of objects.entries()) {
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      Buffer.isBuffer(object) ? object : Buffer.from(object),
      Buffer.from("\nendobj\n"),
    ]);
    offsets.push(length);
    chunks.push(chunk);
    length += chunk.length;
  }
  const trailer = encryption
    ? ` /Encrypt ${objects.length} 0 R /ID [<${encryption.id}><${encryption.id}>]`
    : "";
  chunks.push(Buffer.from([
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f `,
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailer} >>`,
    `startxref\n${length}\n%%EOF\n`,
  ].join("\n")));
  return new Uint8Array(Buffer.concat(chunks));
}

export const mixedPages = [
  { width: 420, height: 594 },
  { width: 594, height: 420 },
  { width: 420, height: 594, rotate: 90 },
];

export function createPdfFixtures() {
  return [
    { path: "single.pdf", data: makePdf(), pages: 1 },
    { path: "mixed-orientation.pdf", data: makePdf({ pages: mixedPages }), pages: 3 },
    {
      path: "many-pages.pdf",
      data: makePdf({ pages: Array.from({ length: 100 }, (_, i) => mixedPages[i % 3]) }),
      pages: 100,
    },
    { path: "same-name-a/shared.pdf", data: makePdf({ label: "BLUE DOCUMENT" }), pages: 1 },
    {
      path: "same-name-b/shared.pdf",
      data: makePdf({ label: "ORANGE DOCUMENT", color: [0.88, 0.4, 0.12], pages: mixedPages }),
      pages: 3,
    },
    { path: "encrypted.pdf", data: makePdf({ encrypted: true }), pages: 1 },
    { path: "damaged.pdf", data: new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 99 0 R >>\nendobj\n%%EOF") },
    { path: "disguised.pdf", data: new TextEncoder().encode("This is artificial plain text, not a PDF.") },
    { path: "empty.pdf", data: new Uint8Array() },
  ];
}

/** Write only artificial data to a caller-selected local test directory. */
export async function writePdfFixtures(directory) {
  const fixtures = createPdfFixtures();
  for (const fixture of fixtures) {
    const destination = resolve(directory, fixture.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, fixture.data);
  }
  return fixtures.map(({ path, pages }) => ({ path, pages }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Pass a local ignored fixture output directory");
  await writePdfFixtures(process.argv[2]);
  console.log("Created artificial PDF fixtures for local testing.");
}
