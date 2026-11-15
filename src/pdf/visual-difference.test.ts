import { expect, test, vi } from "vitest";
import { createEditState } from "./edit";
import { validateEditedPdf } from "./export-validation";
import { visualDifference } from "./visual-difference";
import type { PdfDocumentHandle } from "./types";

const page = { number: 1, width: 420, height: 594, rotation: 0, orientation: "portrait" as const };
const observation = (value = 255, digest = "source-private-marker") => ({
  textDigest: "private-text-marker", visualDigest: digest, width: 420, height: 594, rotation: 0,
  visualSample: { width: 2, height: 1, pixels: new Uint8Array([value, 255, 255, 255, 255, 255, 255, 255]) },
});
function handle(inspectPage: NonNullable<PdfDocumentHandle["inspectPage"]>): PdfDocumentHandle {
  return { pages: [page], render: vi.fn(), inspectPage, destroy: vi.fn() };
}

test("reports aggregate channel differences without returning pixels or content digests", () => {
  const metrics = visualDifference(observation(), observation(254));
  expect(metrics).toEqual({ sourceRasterWidth: 2, sourceRasterHeight: 1, outputRasterWidth: 2, outputRasterHeight: 1,
    totalPixels: 2, changedPixels: 1, maxChannelDelta: 1, meanAbsoluteDelta: 0.125 });
  expect(JSON.stringify(metrics)).not.toContain("private");
});

test("does not invent pixel differences when raster dimensions differ", () => {
  const after = observation();
  after.visualSample.width = 1;
  after.visualSample.height = 2;
  expect(visualDifference(observation(), after)).toEqual({ sourceRasterWidth: 2, sourceRasterHeight: 1,
    outputRasterWidth: 1, outputRasterHeight: 2 });
});

test("omits diagnostic metrics when bounded raster data is absent or invalid", () => {
  const before = observation();
  before.visualSample.width = 129;
  expect(visualDifference(before, observation())).toBeUndefined();
  expect(visualDifference({ ...observation(), visualSample: undefined }, observation())).toBeUndefined();
});

test("exposes only equality booleans for exact viewport and selected graphics signatures", () => {
  const before = { ...observation(), renderSignature: { viewport: "a".repeat(64), graphics: "b".repeat(64) } };
  const after = { ...observation(254), renderSignature: { viewport: "a".repeat(64), graphics: "c".repeat(64) } };
  const difference = visualDifference(before, after);
  expect(difference).toMatchObject({ viewportEqual: true, graphicsEqual: false, changedPixels: 1 });
  expect(JSON.stringify(difference)).not.toMatch(/[a-f0-9]{64}/);
  expect(visualDifference({ ...before, visualSample: undefined }, { ...after, visualSample: undefined }))
    .toEqual({ viewportEqual: true, graphicsEqual: false });
});

test("omits unavailable or invalid graphics signatures without inventing agreement", () => {
  expect(visualDifference(
    { ...observation(), visualSample: undefined, renderSignature: { viewport: "", graphics: "private" } },
    { ...observation(), visualSample: undefined, renderSignature: { viewport: "", graphics: "private" } },
  )).toBeUndefined();
});

test("still rejects a one-channel one-level mismatch and erases all initial/repeated samples", async () => {
  const samples: ReturnType<typeof observation>[] = [];
  const source = handle(vi.fn(async () => { const result = observation(); samples.push(result); return result; }));
  const output = handle(vi.fn(async () => { const result = observation(254, "output-private-marker"); samples.push(result); return result; }));
  const error = await validateEditedPdf(source, output, createEditState("source", source.pages).present.pages,
    new AbortController().signal).catch((value: unknown) => value);
  expect(error).toMatchObject({ code: "VISUAL_CONTENT_MISMATCH", diagnostic: { visualDifference: {
    changedPixels: 1, maxChannelDelta: 1, sourceStable: true, outputStable: true,
  } } });
  expect(samples).toHaveLength(4);
  expect(samples.every((item) => item.visualSample.pixels.every((value) => value === 0))).toBe(true);
  expect(JSON.stringify(error)).not.toContain("private-marker");
  expect(JSON.stringify(error)).not.toContain("private-text-marker");
});

test("a matching repeated render only diagnoses instability and never bypasses the first mismatch", async () => {
  const source = handle(vi.fn(async () => observation()));
  const outputInspect = vi.fn().mockResolvedValueOnce(observation(254, "different"))
    .mockResolvedValueOnce(observation());
  const output = handle(outputInspect);
  await expect(validateEditedPdf(source, output, createEditState("source", source.pages).present.pages,
    new AbortController().signal)).rejects.toMatchObject({ code: "VISUAL_CONTENT_MISMATCH",
    diagnostic: { visualDifference: { sourceStable: true, outputStable: false } } });
});

test("erases a source sample when output inspection fails before comparison", async () => {
  const before = observation();
  const source = handle(async () => before);
  const output = handle(async () => { throw new Error("private-content"); });
  await expect(validateEditedPdf(source, output, createEditState("source", source.pages).present.pages,
    new AbortController().signal)).rejects.toHaveProperty("code", "INSPECTION_FAILURE");
  expect(before.visualSample.pixels.every((value) => value === 0)).toBe(true);
});

test("erases matched samples without performing diagnostic repeat renders", async () => {
  const before = observation();
  const after = observation();
  const source = handle(vi.fn(async () => before));
  const output = handle(vi.fn(async () => after));
  await validateEditedPdf(source, output, createEditState("source", source.pages).present.pages, new AbortController().signal);
  expect(source.inspectPage).toHaveBeenCalledTimes(1);
  expect(output.inspectPage).toHaveBeenCalledTimes(1);
  expect([...before.visualSample.pixels, ...after.visualSample.pixels].every((value) => value === 0)).toBe(true);
});

test("erases an observation returned at the cancellation boundary", async () => {
  const controller = new AbortController();
  const sample = observation();
  const source = handle(async () => { controller.abort(); return sample; });
  const output = handle(vi.fn(async () => observation()));
  await expect(validateEditedPdf(source, output, createEditState("source", source.pages).present.pages,
    controller.signal)).rejects.toHaveProperty("name", "AbortError");
  expect(sample.visualSample.pixels.every((value) => value === 0)).toBe(true);
  expect(output.inspectPage).not.toHaveBeenCalled();
});
