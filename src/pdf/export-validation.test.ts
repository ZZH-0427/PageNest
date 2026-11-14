import { createEditState } from "./edit";
import { validateEditedPdf } from "./export-validation";
import type { PdfDocumentHandle } from "./types";

const info = (number: number) => ({ number, width: 420, height: 594, rotation: 0, orientation: "portrait" as const });
function documentHandle(markers: string[]): PdfDocumentHandle {
  return {
    pages: markers.map((_, index) => info(index + 1)), render: vi.fn(), destroy: vi.fn(),
    inspectPage: vi.fn(async (number) => ({ textDigest: `text-${markers[number - 1]}`, visualDigest: `pixels-${markers[number - 1]}`, width: 420, height: 594, rotation: 0 })),
  };
}

test("compares mapped source content to every output position", async () => {
  const source = documentHandle(["a", "b", "c"]);
  const output = documentHandle(["c", "a"]);
  const all = createEditState("source", source.pages).present.pages;
  await validateEditedPdf(source, output, [all[2], all[0]], new AbortController().signal);
  expect(source.inspectPage).toHaveBeenNthCalledWith(1, 3, expect.any(AbortSignal), 0);
  expect(source.inspectPage).toHaveBeenNthCalledWith(2, 1, expect.any(AbortSignal), 0);
  expect(output.inspectPage).toHaveBeenCalledTimes(2);
});

test.each(["order", "pixels", "rotation", "dimensions", "missing-inspection"])("rejects incorrect %s despite a matching page count", async (change) => {
  const source = documentHandle(["a", "b"]);
  const output = documentHandle(change === "order" ? ["b", "a"] : ["a", "b"]);
  if (change === "pixels") vi.mocked(output.inspectPage!).mockResolvedValue({ textDigest: "text-a", visualDigest: "missing-image", width: 420, height: 594, rotation: 0 });
  if (change === "rotation") output.pages[0].rotation = 180;
  if (change === "dimensions") output.pages[0].width = 400;
  if (change === "missing-inspection") output.inspectPage = undefined;
  await expect(validateEditedPdf(source, output, createEditState("source", source.pages).present.pages, new AbortController().signal)).rejects.toThrow("未提供下载");
});

test("cancellation prevents inspecting subsequent pages and hides stale outcomes", async () => {
  const source = documentHandle(["a", "b"]);
  const output = documentHandle(["a", "b"]);
  const controller = new AbortController();
  vi.mocked(source.inspectPage!).mockImplementation(async () => { controller.abort(); return { textDigest: "a", visualDigest: "a", width: 420, height: 594, rotation: 0 }; });
  await expect(validateEditedPdf(source, output, createEditState("source", source.pages).present.pages, controller.signal)).rejects.toHaveProperty("name", "AbortError");
  expect(output.inspectPage).not.toHaveBeenCalled();
});
