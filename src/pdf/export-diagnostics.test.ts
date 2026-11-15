import { PdfExportDiagnosticError, type PdfContentIntegrity, type PdfExportDiagnosticContext, type PdfRendererProbe, type PdfVisualDifference } from "./export-diagnostics";

function diagnostic(visualDifference: unknown) {
  return new PdfExportDiagnosticError("VISUAL_CONTENT_MISMATCH", {
    stage: "validating", item: "visual", outputPage: 1, sourcePage: 3,
    visualDifference: visualDifference as PdfVisualDifference,
  });
}

test("copies only bounded visual metrics and stability flags into a frozen diagnostic", () => {
  const metrics = {
    sourceRasterWidth: 90, sourceRasterHeight: 128, outputRasterWidth: 90, outputRasterHeight: 128,
    totalPixels: 11_520, changedPixels: 7, maxChannelDelta: 3, meanAbsoluteDelta: 0.0005,
    sourceStable: true, outputStable: false, viewportEqual: true, graphicsEqual: false,
  };
  const error = diagnostic(metrics);
  expect(error.code).toBe("VISUAL_CONTENT_MISMATCH");
  expect(error.message).toContain("未提供下载");
  expect(error.diagnostic.visualDifference).toEqual(metrics);
  expect(error.diagnostic.visualDifference).not.toBe(metrics);
  expect(Object.isFrozen(error.diagnostic.visualDifference)).toBe(true);
  for (const [key, value] of Object.entries(metrics)) expect(error.message).toContain(`${key}=${value}`);
  metrics.changedPixels = 999;
  metrics.sourceStable = false;
  expect(error.diagnostic.visualDifference).toMatchObject({ changedPixels: 7, sourceStable: true });
});

test.each([
  ["sourceRasterWidth", 1, 128, true], ["sourceRasterHeight", 1, 128, true],
  ["outputRasterWidth", 1, 128, true], ["outputRasterHeight", 1, 128, true],
  ["totalPixels", 0, 16_384, true], ["changedPixels", 0, 16_384, true],
  ["maxChannelDelta", 0, 255, true], ["meanAbsoluteDelta", 0, 255, false],
] as const)("enforces the %s numerical bounds without coercion", (key, minimum, maximum, integer) => {
  for (const value of [minimum, maximum]) expect(diagnostic({ [key]: value }).diagnostic.visualDifference).toEqual({ [key]: value });
  const invalid = [minimum - 1, maximum + 1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1", true, null];
  if (integer) invalid.push(1.5);
  for (const value of invalid) {
    const error = diagnostic({ [key]: value });
    expect(error.diagnostic).not.toHaveProperty("visualDifference");
    expect(error.message).not.toContain("visualDifference");
  }
  if (!integer) expect(diagnostic({ [key]: 0.5 }).diagnostic.visualDifference).toEqual({ [key]: 0.5 });
});

test.each(["sourceStable", "outputStable", "viewportEqual", "graphicsEqual"] as const)("accepts only primitive boolean %s values", (key) => {
  for (const value of [true, false]) expect(diagnostic({ [key]: value }).diagnostic.visualDifference).toEqual({ [key]: value });
  for (const value of ["true", "false", 0, 1, null, undefined, {}, []]) {
    expect(diagnostic({ [key]: value }).diagnostic).not.toHaveProperty("visualDifference");
  }
});

test("drops raw text, pixels, digests, paths and unknown fields without retaining their container", () => {
  const privateValue = "SYNTHETIC_PRIVATE_DOCUMENT_DATA";
  const unsafe = {
    changedPixels: 2, sourceStable: false,
    text: privateValue, pixels: new Uint8Array([1, 2, 3, 4]), digest: privateValue,
    path: privateValue, unknown: privateValue, outputStable: privateValue,
    toJSON: () => privateValue,
  };
  const error = diagnostic(unsafe);
  expect(error.diagnostic.visualDifference).toEqual({ changedPixels: 2, sourceStable: false });
  expect(error.message).not.toContain(privateValue);
  expect(JSON.stringify(error)).not.toContain(privateValue);
  expect(JSON.stringify(error)).not.toMatch(/pixels|digest|path|unknown|toJSON/);
  expect(error).not.toHaveProperty("cause");
  const moved = error.withContext({ outputPage: 2, sourcePage: 4 });
  expect(moved.diagnostic.visualDifference).toEqual(error.diagnostic.visualDifference);
  expect(moved.diagnostic.visualDifference).not.toBe(error.diagnostic.visualDifference);
});

test("ignores inherited and accessor properties rather than executing document-provided conversion code", () => {
  const accessor = vi.fn(() => { throw new Error("SYNTHETIC_PRIVATE_ACCESSOR"); });
  const unsafe = Object.create({ sourceStable: true, changedPixels: 10 }) as object;
  Object.defineProperty(unsafe, "totalPixels", { get: accessor, enumerable: true });
  Object.defineProperty(unsafe, "outputStable", { value: false, enumerable: true });
  expect(diagnostic(unsafe).diagnostic.visualDifference).toEqual({ outputStable: false });
  expect(accessor).not.toHaveBeenCalled();
});

test.each([undefined, null, "SYNTHETIC_PRIVATE_STRING", [], new Uint8Array([1, 2, 3])])("ignores non-metric containers", (value) => {
  const error = diagnostic(value);
  expect(error.diagnostic).not.toHaveProperty("visualDifference");
  expect(error.message).not.toContain("SYNTHETIC_PRIVATE_STRING");
});

function contentDiagnostic(contentIntegrity: unknown) {
  return new PdfExportDiagnosticError("VISUAL_CONTENT_MISMATCH", {
    stage: "validating", item: "visual", outputPage: 1, sourcePage: 3,
    contentIntegrity: contentIntegrity as PdfContentIntegrity,
  });
}

test("copies and freezes the six structural booleans while keeping the visual failure", () => {
  const evidence = {
    contentsEqual: true, resourcesEqual: false, pageAttributesEqual: true,
    annotationsEqual: false, displayContextEqual: true, complete: false,
  };
  const error = contentDiagnostic(evidence);
  expect(error.code).toBe("VISUAL_CONTENT_MISMATCH");
  expect(error.message).toContain("未提供下载");
  expect(error.message).toContain("contentIntegrity={");
  expect(error.diagnostic.contentIntegrity).toEqual(evidence);
  expect(error.diagnostic.contentIntegrity).not.toBe(evidence);
  expect(Object.isFrozen(error.diagnostic.contentIntegrity)).toBe(true);
  for (const [key, value] of Object.entries(evidence)) expect(error.message).toContain(`${key}=${value}`);
  evidence.complete = true;
  evidence.contentsEqual = false;
  expect(error.diagnostic.contentIntegrity).toMatchObject({ contentsEqual: true, complete: false });
  const moved = error.withContext({ sourcePage: 4 });
  expect(moved.diagnostic.contentIntegrity).toEqual(error.diagnostic.contentIntegrity);
  expect(moved.diagnostic.contentIntegrity).not.toBe(error.diagnostic.contentIntegrity);
});

test.each(["contentsEqual", "resourcesEqual", "pageAttributesEqual", "annotationsEqual", "displayContextEqual", "complete"] as const)(
  "accepts only an own primitive boolean for contentIntegrity.%s", (key) => {
    for (const value of [true, false]) expect(contentDiagnostic({ [key]: value }).diagnostic.contentIntegrity).toEqual({ [key]: value });
    for (const value of ["true", "false", 0, 1, null, undefined, Number.NaN, {}, []]) {
      const error = contentDiagnostic({ [key]: value });
      expect(error.diagnostic).not.toHaveProperty("contentIntegrity");
      expect(error.message).not.toContain("contentIntegrity");
    }
  },
);

test("never retains raw structural payloads, hashes, text or paths", () => {
  const privateValue = "SYNTHETIC_PRIVATE_CONTENT_INTEGRITY";
  const raw = { complete: true, contentsEqual: false, digest: privateValue, text: privateValue,
    pixels: new Uint8Array([1, 2, 3]), path: privateValue, raw: privateValue, resources: { privateValue },
    toJSON: () => privateValue };
  const error = contentDiagnostic(raw);
  expect(error.diagnostic.contentIntegrity).toEqual({ contentsEqual: false, complete: true });
  expect(error.message).not.toContain(privateValue);
  expect(JSON.stringify(error)).not.toContain(privateValue);
  expect(JSON.stringify(error)).not.toMatch(/digest|text|pixels|path|raw|resources"|toJSON/);
  expect(error).not.toHaveProperty("cause");
});

test("ignores inherited structural flags and does not execute structural accessors", () => {
  const accessor = vi.fn(() => { throw new Error("SYNTHETIC_PRIVATE_STRUCTURE_ACCESSOR"); });
  const raw = Object.create({ contentsEqual: true, complete: true }) as object;
  Object.defineProperty(raw, "resourcesEqual", { get: accessor, enumerable: true });
  Object.defineProperty(raw, "annotationsEqual", { value: false, enumerable: true });
  expect(contentDiagnostic(raw).diagnostic.contentIntegrity).toEqual({ annotationsEqual: false });
  expect(accessor).not.toHaveBeenCalled();
});

test.each([undefined, null, "SYNTHETIC_PRIVATE_STRUCTURE", [], new Uint8Array([1, 2, 3])])("ignores non-structural containers", (value) => {
  const error = contentDiagnostic(value);
  expect(error.diagnostic).not.toHaveProperty("contentIntegrity");
  expect(error.message).not.toContain("SYNTHETIC_PRIVATE_STRUCTURE");
});

test.each(["font-paths-match", "font-paths-mismatch", "font-paths-unavailable"] as const)("allows only the fixed renderer probe result %s", (rendererProbe) => {
  const error = diagnostic({ changedPixels: 2 }).withContext({ rendererProbe });
  expect(error.code).toBe("VISUAL_CONTENT_MISMATCH");
  expect(error.diagnostic.rendererProbe).toBe(rendererProbe);
  expect(error.message).toContain(`rendererProbe=${rendererProbe}`);
  expect(error.message).toContain("未提供下载");
});

test.each(["SYNTHETIC_PRIVATE_RENDERER_TEXT", "font-paths-match;PRIVATE", true, 1, null, {}, []])("drops unknown renderer-probe payloads", (value) => {
  const error = diagnostic(undefined).withContext({ rendererProbe: value as PdfRendererProbe });
  expect(error.diagnostic).not.toHaveProperty("rendererProbe");
  expect(error.message).not.toContain("rendererProbe");
  expect(error.message).not.toContain("PRIVATE");
  expect(JSON.stringify(error)).not.toContain("PRIVATE");
});

test("keeps safe probe failure fields distinct from the original failure and copies visual metrics", () => {
  const probeVisualDifference = { changedPixels: 4, maxChannelDelta: 2, sourceStable: true, outputStable: false };
  const error = diagnostic({ changedPixels: 1 }).withContext({ rendererProbe: "font-paths-mismatch",
    probeCode: "VISUAL_CONTENT_MISMATCH", probeOutputPage: 2, probeSourcePage: 9, probeItem: "visual", probeVisualDifference });
  expect(error.diagnostic).toMatchObject({ code: "VISUAL_CONTENT_MISMATCH", outputPage: 1, sourcePage: 3,
    probeCode: "VISUAL_CONTENT_MISMATCH", probeOutputPage: 2, probeSourcePage: 9, probeItem: "visual", probeVisualDifference });
  expect(error.message).toContain("outputPage=1; sourcePage=3");
  expect(error.message).toContain("probeOutputPage=2; probeSourcePage=9");
  expect(error.message).toContain("probeVisualDifference={changedPixels=4,maxChannelDelta=2,sourceStable=true,outputStable=false}");
  expect(Object.isFrozen(error.diagnostic.probeVisualDifference)).toBe(true);
  expect(error.diagnostic.probeVisualDifference).not.toBe(probeVisualDifference);
  probeVisualDifference.changedPixels = 10;
  expect(error.diagnostic.probeVisualDifference?.changedPixels).toBe(4);
});

test("ignores non-enum probe details, invalid pages and all raw or recursive probe payloads", () => {
  const privateValue = "SYNTHETIC_PRIVATE_PROBE_PAYLOAD";
  const error = diagnostic(undefined).withContext({
    probeCode: privateValue, probeItem: privateValue, probeOutputPage: privateValue, probeSourcePage: Number.POSITIVE_INFINITY,
    probeVisualDifference: { changedPixels: 2, maxChannelDelta: 256, meanAbsoluteDelta: Number.NaN,
      sourceStable: privateValue, pixels: privateValue, digest: privateValue, path: privateValue, text: privateValue },
    rendererProbeFailure: { rendererProbeFailure: privateValue, error: privateValue },
  } as unknown as PdfExportDiagnosticContext);
  expect(error.diagnostic.probeVisualDifference).toEqual({ changedPixels: 2 });
  for (const key of ["probeCode", "probeItem", "probeOutputPage", "probeSourcePage", "rendererProbeFailure"]) expect(error.diagnostic).not.toHaveProperty(key);
  expect(error.message).not.toContain(privateValue);
  expect(JSON.stringify(error)).not.toMatch(/PRIVATE|pixels|digest|path|text|rendererProbeFailure/);
});

test("applies the same bounded page rules and visual whitelist to probe failure metadata", () => {
  const valid = diagnostic(undefined).withContext({ probeOutputPage: 1000, probeSourcePage: 1, probeCode: "TEXT_CONTENT_MISMATCH", probeItem: "text" });
  expect(valid.diagnostic).toMatchObject({ probeOutputPage: 1000, probeSourcePage: 1, probeCode: "TEXT_CONTENT_MISMATCH", probeItem: "text" });
  const invalid = valid.withContext({ probeOutputPage: 1001, probeSourcePage: 0.5, probeVisualDifference: { changedPixels: -1 } });
  expect(invalid.diagnostic).not.toHaveProperty("probeOutputPage");
  expect(invalid.diagnostic).not.toHaveProperty("probeSourcePage");
  expect(invalid.diagnostic).not.toHaveProperty("probeVisualDifference");
});

test.each(["match", "mismatch", "unavailable"] as const)("records a fresh-native %s result independently of font paths", (nativeProbe) => {
  const error = diagnostic(undefined).withContext({ nativeProbe, rendererProbe: "font-paths-mismatch" });
  expect(error.code).toBe("VISUAL_CONTENT_MISMATCH");
  expect(error.diagnostic.nativeProbe).toBe(nativeProbe);
  expect(error.message).toContain(`nativeProbe=${nativeProbe}`);
  expect(error.message).toContain("rendererProbe=font-paths-mismatch");
});

test("applies identical privacy rules to fresh-native failure details and signature equality booleans", () => {
  const privateValue = "SYNTHETIC_PRIVATE_NATIVE_PROBE";
  const error = diagnostic(undefined).withContext({ nativeProbe: privateValue, nativeProbeCode: privateValue,
    nativeProbeOutputPage: -1, nativeProbeSourcePage: 1001, nativeProbeItem: privateValue,
    nativeProbeVisualDifference: { changedPixels: 1, viewportEqual: true, graphicsEqual: false,
      viewport: privateValue, graphics: privateValue, digest: privateValue, pixels: privateValue, path: privateValue },
  } as unknown as PdfExportDiagnosticContext);
  for (const key of ["nativeProbe", "nativeProbeCode", "nativeProbeOutputPage", "nativeProbeSourcePage", "nativeProbeItem"]) {
    expect(error.diagnostic).not.toHaveProperty(key);
  }
  expect(error.diagnostic.nativeProbeVisualDifference).toEqual({ changedPixels: 1, viewportEqual: true, graphicsEqual: false });
  expect(Object.isFrozen(error.diagnostic.nativeProbeVisualDifference)).toBe(true);
  expect(error.message).not.toContain(privateValue);
  expect(JSON.stringify(error)).not.toMatch(/PRIVATE|digest|pixels|path|viewport"|graphics"/);
  const valid = error.withContext({ nativeProbe: "mismatch", nativeProbeCode: "TEXT_CONTENT_MISMATCH", nativeProbeOutputPage: 2, nativeProbeSourcePage: 3, nativeProbeItem: "text" });
  expect(valid.diagnostic).toMatchObject({ nativeProbe: "mismatch", nativeProbeCode: "TEXT_CONTENT_MISMATCH", nativeProbeOutputPage: 2, nativeProbeSourcePage: 3, nativeProbeItem: "text" });
});

test("reports a fresh-source opening failure as a fixed safe stage", () => {
  const error = new PdfExportDiagnosticError("INSPECTION_FAILURE", { stage: "source-open", item: "parser" });
  expect(error.diagnostic).toEqual({ code: "INSPECTION_FAILURE", stage: "source-open", item: "parser" });
  expect(error.message).toContain("phase=source-open");
});
