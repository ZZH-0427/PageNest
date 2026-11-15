/** Synthetic source markers, vector artwork, raster objects and authored layer states only. */
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { makeExportPdf } from "./pdf-export-fixtures.mjs";

export async function makeOutputPdf({ label = "SOURCE A", count = 3, rotation = 0, wide = false,
  inherited = false, crop = false, layer = "none", images = true, text = true, vectors = true, palette = "blue" } = {}) {
  const bytes = makeExportPdf({ label, images, text, vectors, palette,
    pages: Array.from({ length: count }, (_, index) => ({ width: wide ? 640 : 420, height: wide ? 420 : 594, rotate: (rotation + index * 90) % 360 })) });
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const name = (key) => PDFName.of(key);
  const group = layer === "none" ? undefined : pdf.context.register(pdf.context.obj({
    Type: "OCG", Name: PDFString.of("Artificial identical layer name"), Intent: "View",
  }));
  for (const [index, page] of pdf.getPages().entries()) {
    const resources = page.node.Resources();
    if (inherited) {
      page.node.Parent().set(name("Resources"), pdf.context.obj({ Font: resources.get(name("Font")) }));
      resources.delete(name("Font"));
    }
    if (crop) {
      const { width, height } = page.getSize();
      page.node.set(name("CropBox"), pdf.context.obj([10, 20, width - 15, height - 25]));
    }
    if (group) {
      resources.set(name("Properties"), pdf.context.obj({ SyntheticLayer: group }));
      const overlay = pdf.context.register(pdf.context.flateStream(`/OC /SyntheticLayer BDC q 0.9 0.05 0.1 rg ${70 + index * 10} 230 110 55 re f Q EMC`));
      page.node.set(name("Contents"), pdf.context.obj([page.node.get(name("Contents")), overlay]));
    }
  }
  if (group) {
    pdf.catalog.set(name("OCProperties"), pdf.context.obj({ OCGs: [group], D: {
      BaseState: layer === "base-off-on" ? "OFF" : "ON",
      ON: layer === "base-off-on" ? [group] : [], OFF: layer === "off" ? [group] : [],
      Order: [[PDFString.of("Artificial source group"), group]],
    } }));
  }
  return pdf.save({ updateFieldAppearances: false });
}
