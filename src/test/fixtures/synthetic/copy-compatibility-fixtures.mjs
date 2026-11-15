import { PDFDocument, PDFName, PDFNumber, PDFString } from "pdf-lib";

/** Artificial content only: no downloaded PDFs, documents or embedded font binaries. */
export async function makeCopyCompatibilityPdf(kind, pageCount = 3) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const name = (value) => PDFName.of(value);
  const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" }));
  const nearbyFont = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Courier" }));
  const layer = ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of("Artificial hidden layer") }));
  if (kind === "hidden-layer") {
    doc.catalog.set(name("OCProperties"), ctx.obj({
      OCGs: [layer], D: { Name: PDFString.of("Artificial default"), BaseState: "ON", OFF: [layer], Order: [layer] },
    }));
  }
  for (let number = 1; number <= pageCount; number++) {
    const page = doc.addPage([420, 594]);
    const parent = page.node.Parent();
    parent.set(name("Resources"), ctx.obj({ Font: { F1: font, UnusedParentFont: font } }));
    page.node.set(name("Resources"), ctx.obj({ Font: { F1: font } }));
    if (kind === "partial-resources") page.node.set(name("Resources"), ctx.obj({ ProcSet: ["PDF", "Text"] }));
    if (kind === "closest-resources") page.node.set(name("Resources"), ctx.obj({ Font: { F1: nearbyFont } }));
    if (kind === "inherited-geometry") {
      parent.set(name("MediaBox"), ctx.obj([-10, -20, 410, 574]));
      parent.set(name("CropBox"), ctx.obj([10, 20, 390, 550]));
      parent.set(name("Rotate"), PDFNumber.of(90));
      for (const key of ["Resources", "MediaBox", "CropBox", "Rotate"]) page.node.delete(name(key));
      page.node.set(name("UserUnit"), PDFNumber.of(2.5));
    }
    let content = `q 0.1 0.4 0.8 rg ${30 + number * 15} 100 100 150 re f Q BT /F1 19 Tf 45 420 Td (ARTIFICIAL PAGE ${number}) Tj ET`;
    if (kind === "hidden-layer") {
      page.node.Resources().set(name("Properties"), ctx.obj({ Hidden: layer }));
      content += " /OC /Hidden BDC q 1 0 0 rg 10 10 390 350 re f Q EMC";
    }
    page.node.set(name("Contents"), ctx.register(ctx.flateStream(content)));
  }
  return doc.save({ useObjectStreams: false });
}

/**
 * Artificial incremental update: the final xref deliberately keeps the original
 * content object active. A later same-number object is present but not selected.
 * A sequential object parser can choose that inactive stream and change colors.
 */
export function makeCrossRefSelectionPdf() {
  const content = (color) => `q ${color} rg 40 60 330 300 re f Q BT /F1 19 Tf 45 420 Td (ARTIFICIAL SAME TEXT) Tj ET`;
  const stream = (text) => `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 594] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    stream(content("0.2 0.4 0.8")),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let data = "%PDF-1.7\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(data.length);
    data += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const originalXref = data.length;
  data += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${originalXref}\n%%EOF\n`;
  data += `4 0 obj\n${stream(content("0.22 0.42 0.82"))}\nendobj\n`;
  const currentXref = data.length;
  data += `xref\n4 1\n${String(offsets[4]).padStart(10, "0")} 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R /Prev ${originalXref} >>\nstartxref\n${currentXref}\n%%EOF\n`;
  return new TextEncoder().encode(data);
}
