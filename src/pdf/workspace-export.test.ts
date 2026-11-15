import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfWorkspace } from "./workspace";
import { generateEditedPdf } from "./export";
import { validateEditedPdf } from "./export-validation";
import { PdfExportDiagnosticError } from "./export-diagnostics";
import type { PdfDocumentHandle, PdfEngine, PdfPageInfo } from "./types";

vi.mock("./browser-engine", () => ({ BrowserPdfEngine: vi.fn() }));
vi.mock("./export", () => ({
  sanitizePdfFilename: (name: string) => name,
  generateEditedPdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
}));
vi.mock("./export-validation", () => ({ validateEditedPdf: vi.fn(async () => {}) }));

const instances: PdfWorkspace[] = [];
afterEach(() => {
  instances.splice(0).forEach((instance) => instance.dispose());
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function doc(): PdfDocumentHandle {
  return {
    pages: Array.from({ length: 3 }, (_, i): PdfPageInfo => ({ number: i + 1, width: 420, height: 594, rotation: 0, orientation: "portrait" })),
    render: vi.fn(async () => {}), destroy: vi.fn(async () => {}),
  };
}
async function setup() {
  const original = doc();
  const validationSource = doc();
  const output = doc();
  const nativeProbeSource = doc();
  const nativeProbeOutput = doc();
  const probeSource = doc();
  const probeOutput = doc();
  let sourceOpens = 0;
  let outputOpens = 0;
  const sourceFile = new File(["%PDF-1.7\nSynthetic"], "first.pdf", { type: "application/pdf" });
  const engine: PdfEngine = { open: vi.fn(async (file, _signal, _status, options) => {
    if (options?.fontMode === "paths") return file === sourceFile ? probeSource : probeOutput;
    if (file === sourceFile) {
      const index = sourceOpens++;
      return index === 0 ? original : index === 1 ? validationSource : nativeProbeSource;
    }
    if (file.name === "validation.pdf") return outputOpens++ === 0 ? output : nativeProbeOutput;
    return doc();
  }), destroy: vi.fn(async () => {}) };
  const workspace = new PdfWorkspace(() => engine);
  instances.push(workspace);
  workspace.addFiles([sourceFile]);
  await vi.waitFor(() => expect(workspace.getSnapshot().files[0].status).toBe("ready"));
  return { workspace, id: workspace.getSnapshot().files[0].id, original, validationSource, output, engine, nativeProbeSource, nativeProbeOutput, probeSource, probeOutput, sourceFile };
}

describe("workspace export capabilities", () => {
  it("does not upload documents or write persistent storage through the workspace lifecycle", async () => {
    const upload = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected upload"));
    const xhr = vi.spyOn(XMLHttpRequest.prototype, "send");
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const database = vi.fn();
    const socket = vi.fn();
    vi.stubGlobal("indexedDB", { open: database });
    vi.stubGlobal("WebSocket", socket);
    const { workspace, id } = await setup();
    workspace.rotateSelectedPages(id, 90);
    await workspace.exporter.start(id, "edited.pdf");
    workspace.clear();
    expect(upload).not.toHaveBeenCalled();
    expect(xhr).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    expect(database).not.toHaveBeenCalled();
    expect(socket).not.toHaveBeenCalled();
  });

  it("exports all retained pages in edited order, independent of selection, without changing history", async () => {
    const { workspace, id, original, validationSource, output } = await setup();
    workspace.selectPage(id, 2);
    workspace.deleteSelectedPages(id);
    workspace.selectPage(id, 2);
    workspace.rotateSelectedPages(id, -90);
    workspace.moveSelectedPage(id, -1);
    const before = workspace.getSnapshot();
    await workspace.exporter.start(id, "edited.pdf");
    const request = vi.mocked(generateEditedPdf).mock.calls[0][1];
    expect(request.pages.map((page) => page.sourcePageNumber)).toEqual([3, 1]);
    expect(request.pages.map((page) => page.rotationDelta)).toEqual([270, 0]);
    expect(workspace.getSnapshot()).toBe(before);
    expect(validateEditedPdf).toHaveBeenCalledWith(validationSource, output, request.pages, expect.any(AbortSignal));
    expect(validationSource.destroy).toHaveBeenCalledTimes(1);
    expect(output.destroy).toHaveBeenCalledTimes(1);
    expect(original.destroy).not.toHaveBeenCalled();
    expect(workspace.exporter.getSnapshot().stage).toBe("ready");
  });

  it("strictly validates all fresh pages without inspecting a previously touched preview handle", async () => {
    const { workspace, id, engine, original, validationSource, output, sourceFile } = await setup();
    const actual = await vi.importActual<typeof import("./export-validation")>("./export-validation");
    const observe = async (number: number) => ({ textDigest: `text-${number}`, visualDigest: `pixels-${number}`, width: 420, height: 594, rotation: 0 });
    original.inspectPage = vi.fn(async () => { throw new Error("Synthetic cached preview rendering state"); });
    validationSource.inspectPage = vi.fn(observe);
    output.inspectPage = vi.fn(observe);
    await original.render(1, document.createElement("canvas"), new AbortController().signal);
    const before = workspace.getSnapshot();
    vi.mocked(validateEditedPdf).mockImplementationOnce(actual.validateEditedPdf);
    await workspace.exporter.start(id, "edited.pdf");
    expect(workspace.exporter.getSnapshot().stage).toBe("ready");
    expect(original.inspectPage).not.toHaveBeenCalled();
    expect(original.destroy).not.toHaveBeenCalled();
    expect(validationSource.inspectPage).toHaveBeenCalledTimes(3);
    expect(output.inspectPage).toHaveBeenCalledTimes(3);
    expect(validationSource.destroy).toHaveBeenCalledTimes(1);
    expect(output.destroy).toHaveBeenCalledTimes(1);
    expect(engine.open).toHaveBeenCalledTimes(3);
    expect(vi.mocked(engine.open).mock.calls[1]).toEqual([sourceFile, expect.any(AbortSignal), expect.any(Function)]);
    expect(vi.mocked(engine.open).mock.calls[2]).toEqual([expect.any(File), expect.any(AbortSignal), expect.any(Function)]);
    expect(workspace.getSnapshot()).toBe(before);
  });

  it.each([["source", "text"], ["output", "text"], ["source", "pixels"], ["output", "pixels"]] as const)(
    "rejects real strict-validation %s %s differences even when the cached preview would match", async (side, changed) => {
      const { workspace, id, original, validationSource, output } = await setup();
      const actual = await vi.importActual<typeof import("./export-validation")>("./export-validation");
      const observe = async (number: number) => ({ textDigest: `text-${number}`, visualDigest: `pixels-${number}`, width: 420, height: 594, rotation: 0 });
      original.inspectPage = vi.fn(observe);
      validationSource.inspectPage = vi.fn(observe);
      output.inspectPage = vi.fn(observe);
      const broken = side === "source" ? validationSource : output;
      vi.mocked(broken.inspectPage!).mockImplementation(async (number) => ({ ...(await observe(number)),
        ...(changed === "text" ? { textDigest: "Synthetic changed text" } : { visualDigest: "Synthetic changed pixels" }),
      }));
      vi.mocked(validateEditedPdf).mockImplementationOnce(actual.validateEditedPdf);
      const before = workspace.getSnapshot();
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
      await workspace.exporter.start(id, "edited.pdf");
      expect(workspace.exporter.getSnapshot().stage).toBe("error");
      expect(workspace.exporter.getSnapshot().error).toContain(changed === "text" ? "TEXT_CONTENT_MISMATCH" : "VISUAL_CONTENT_MISMATCH");
      expect(original.inspectPage).not.toHaveBeenCalled();
      expect(original.destroy).not.toHaveBeenCalled();
      expect(validationSource.destroy).toHaveBeenCalledTimes(1);
      expect(output.destroy).toHaveBeenCalledTimes(1);
      expect(workspace.getSnapshot()).toBe(before);
      workspace.exporter.download();
      expect(click).not.toHaveBeenCalled();
    },
  );

  it("keeps the captured snapshot while subsequent edits and file switching remain isolated", async () => {
    const { workspace, id } = await setup();
    workspace.addFiles([new File(["%PDF-1.7\nOther"], "second.pdf")]);
    await vi.waitFor(() => expect(workspace.getSnapshot().files[1].status).toBe("ready"));
    const secondId = workspace.getSnapshot().files[1].id;
    const second = workspace.getSnapshot().files[1];
    const run = workspace.exporter.start(id, "edited.pdf");
    workspace.selectPage(id, 2);
    workspace.deleteSelectedPages(id);
    workspace.selectFile(secondId);
    await run;
    expect(vi.mocked(generateEditedPdf).mock.calls[0][1].pages).toHaveLength(3);
    expect(workspace.getSnapshot().files[0].edit?.present.pages).toHaveLength(2);
    expect(workspace.getSnapshot().files[1]).toBe(second);
    expect(workspace.exporter.getSnapshot().documentId).toBe(id);
  });

  it.each(["remove", "clear", "dispose"])("%s makes a pending generation unusable", async (operation) => {
    const { workspace, id, engine } = await setup();
    let resolve!: (value: Uint8Array) => void;
    vi.mocked(generateEditedPdf).mockImplementationOnce(() => new Promise((yes) => { resolve = yes; }));
    const run = workspace.exporter.start(id, "edited.pdf");
    await vi.waitFor(() => expect(generateEditedPdf).toHaveBeenCalled());
    if (operation === "remove") workspace.removeFile(id);
    if (operation === "clear") workspace.clear();
    if (operation === "dispose") workspace.dispose();
    resolve(new Uint8Array([1]));
    await run;
    expect(workspace.exporter.getSnapshot().stage).toBe("idle");
    expect(engine.open).toHaveBeenCalledTimes(1);
    expect(validateEditedPdf).not.toHaveBeenCalled();
    await workspace.exporter.start(id, "again.pdf");
    expect(workspace.exporter.getSnapshot().stage).toBe("error");
  });

  it("cleans up the output handle when independent validation rejects", async () => {
    const { workspace, id, output, original } = await setup();
    vi.mocked(validateEditedPdf).mockRejectedValueOnce(new Error("Synthetic validation failure"));
    await workspace.exporter.start(id, "edited.pdf");
    expect(output.destroy).toHaveBeenCalledTimes(1);
    expect(original.destroy).not.toHaveBeenCalled();
    expect(workspace.exporter.getSnapshot().stage).toBe("error");
  });

  it("erases its temporary byte reread even after generation fails", async () => {
    const { workspace, id } = await setup();
    vi.mocked(generateEditedPdf).mockRejectedValueOnce(new Error("Synthetic generation failure"));
    await workspace.exporter.start(id, "edited.pdf");
    const bytes = vi.mocked(generateEditedPdf).mock.calls[0][0];
    expect(bytes.every((value) => value === 0)).toBe(true);
    expect(validateEditedPdf).not.toHaveBeenCalled();
    expect(workspace.getSnapshot().files[0].status).toBe("ready");
  });

  it("handles output parsing failure without altering imported files", async () => {
    const { workspace, id, engine, original, validationSource } = await setup();
    vi.mocked(engine.open).mockResolvedValueOnce(validationSource).mockRejectedValueOnce(new Error("Synthetic parse failure"));
    const before = workspace.getSnapshot();
    await workspace.exporter.start(id, "edited.pdf");
    expect(workspace.exporter.getSnapshot().stage).toBe("error");
    expect(workspace.getSnapshot()).toBe(before);
    expect(original.destroy).not.toHaveBeenCalled();
    expect(validationSource.destroy).toHaveBeenCalledTimes(1);
  });

  it("reports a safe output-parser diagnostic without exposing parser text", async () => {
    const { workspace, id, engine, validationSource } = await setup();
    vi.mocked(engine.open).mockResolvedValueOnce(validationSource).mockRejectedValueOnce(new Error("SYNTHETIC_PRIVATE_PARSER_TEXT"));
    await workspace.exporter.start(id, "edited.pdf");
    expect(workspace.exporter.getSnapshot().error).toContain("INSPECTION_FAILURE");
    expect(workspace.exporter.getSnapshot().error).toContain("output-open");
    expect(workspace.exporter.getSnapshot().error).not.toContain("SYNTHETIC_PRIVATE_PARSER_TEXT");
    expect(workspace.exporter.getSnapshot().stage).toBe("error");
  });

  it("reports a safe fresh-source parser diagnostic without consulting the preview", async () => {
    const { workspace, id, engine, original } = await setup();
    vi.mocked(engine.open).mockRejectedValueOnce(new Error("SYNTHETIC_PRIVATE_SOURCE_PARSER"));
    await workspace.exporter.start(id, "edited.pdf");
    expect(workspace.exporter.getSnapshot().error).toContain("INSPECTION_FAILURE");
    expect(workspace.exporter.getSnapshot().error).toContain("source-open");
    expect(workspace.exporter.getSnapshot().error).not.toContain("SYNTHETIC_PRIVATE_SOURCE_PARSER");
    expect(validateEditedPdf).not.toHaveBeenCalled();
    expect(original.destroy).not.toHaveBeenCalled();
  });

  it.each(["source", "output"])("cancels a pending primary %s open and disposes a late handle", async (side) => {
    const { workspace, id, engine, original, validationSource, output } = await setup();
    let finish!: (handle: PdfDocumentHandle) => void;
    if (side === "output") vi.mocked(engine.open).mockResolvedValueOnce(validationSource);
    vi.mocked(engine.open).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const run = workspace.exporter.start(id, "edited.pdf");
    await vi.waitFor(() => expect(engine.open).toHaveBeenCalledTimes(side === "source" ? 2 : 3));
    workspace.exporter.cancel();
    await run;
    expect(workspace.exporter.getSnapshot()).toMatchObject({ stage: "idle", busy: false, error: null });
    const late = side === "source" ? validationSource : output;
    finish(late);
    await vi.waitFor(() => expect(late.destroy).toHaveBeenCalledTimes(1));
    expect(validateEditedPdf).not.toHaveBeenCalled();
    expect(original.destroy).not.toHaveBeenCalled();
    if (side === "output") expect(validationSource.destroy).toHaveBeenCalledTimes(1);
  });

  it.each(["source", "output"])("bounds primary %s opening at sixty seconds with a safe diagnostic", async (side) => {
    const { workspace, id, engine, original, validationSource } = await setup();
    vi.useFakeTimers();
    if (side === "output") vi.mocked(engine.open).mockResolvedValueOnce(validationSource);
    vi.mocked(engine.open).mockImplementationOnce(() => new Promise(() => {}));
    const run = workspace.exporter.start(id, "edited.pdf");
    await vi.waitFor(() => expect(engine.open).toHaveBeenCalledTimes(side === "source" ? 2 : 3));
    await vi.advanceTimersByTimeAsync(60_000);
    await run;
    expect(workspace.exporter.getSnapshot().error).toContain("VALIDATION_TIMEOUT");
    expect(workspace.exporter.getSnapshot().error).toContain(`phase=${side}-open`);
    expect(workspace.exporter.getSnapshot().stage).toBe("error");
    expect(original.destroy).not.toHaveBeenCalled();
    if (side === "output") expect(validationSource.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds both main validation cleanups in parallel and blocks download on cleanup failure", async () => {
    const { workspace, id, validationSource, output, original } = await setup();
    vi.useFakeTimers();
    vi.mocked(validationSource.destroy).mockImplementationOnce(() => new Promise(() => {}));
    vi.mocked(output.destroy).mockImplementationOnce(() => new Promise(() => {}));
    const run = workspace.exporter.start(id, "edited.pdf");
    await vi.waitFor(() => expect(output.destroy).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(3000);
    await run;
    expect(workspace.exporter.getSnapshot()).toMatchObject({ stage: "error", busy: false });
    expect(workspace.exporter.getSnapshot().error).toContain("VALIDATION_TIMEOUT");
    expect(workspace.exporter.getSnapshot().error).toContain("phase=cleanup");
    expect(original.destroy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the failing page diagnostic when output cleanup also fails", async () => {
    const { workspace, id, output } = await setup();
    const failure = new PdfExportDiagnosticError("VISUAL_CONTENT_MISMATCH", {
      stage: "validating", item: "visual", outputPage: 2, sourcePage: 3,
    });
    vi.mocked(validateEditedPdf).mockRejectedValueOnce(failure);
    vi.mocked(output.destroy).mockRejectedValueOnce(new Error("SYNTHETIC_PRIVATE_CLEANUP_TEXT"));
    await workspace.exporter.start(id, "edited.pdf");
    expect(workspace.exporter.getSnapshot().error).toBe(failure.withContext({ nativeProbe: "match", rendererProbe: "font-paths-match" }).message);
    expect(workspace.exporter.getSnapshot().stage).toBe("error");
  });

  it("blocks a result with a safe cleanup diagnostic when disposal fails", async () => {
    const { workspace, id, output } = await setup();
    vi.mocked(output.destroy).mockRejectedValueOnce(new Error("SYNTHETIC_PRIVATE_CLEANUP_TEXT"));
    await workspace.exporter.start(id, "edited.pdf");
    expect(workspace.exporter.getSnapshot().error).toContain("INSPECTION_FAILURE");
    expect(workspace.exporter.getSnapshot().error).toContain("cleanup");
    expect(workspace.exporter.getSnapshot().error).not.toContain("SYNTHETIC_PRIVATE_CLEANUP_TEXT");
    expect(workspace.exporter.getSnapshot().stage).toBe("error");
  });

  it("bounds an unresponsive output cleanup and releases the export slot", async () => {
    const { workspace, id, output } = await setup();
    vi.mocked(output.destroy).mockImplementationOnce(() => new Promise(() => {}));
    const run = workspace.exporter.start(id, "edited.pdf");
    await vi.waitFor(() => expect(output.destroy).toHaveBeenCalled());
    workspace.exporter.cancel();
    await run;
    expect(workspace.exporter.getSnapshot()).toMatchObject({ stage: "idle", busy: false });
    await workspace.exporter.start(id, "retry.pdf");
    expect(workspace.exporter.getSnapshot().stage).toBe("ready");
  });

  it("uses the same font-path options for both diagnostic documents but still rejects a matching probe", async () => {
    const { workspace, id, engine, sourceFile, original, validationSource, output, nativeProbeSource, nativeProbeOutput, probeSource, probeOutput } = await setup();
    workspace.selectPage(id, 2);
    workspace.deleteSelectedPages(id);
    workspace.selectPage(id, 2);
    workspace.rotateSelectedPages(id, 90);
    workspace.moveSelectedPage(id, -1);
    const before = workspace.getSnapshot();
    const failure = new PdfExportDiagnosticError("VISUAL_CONTENT_MISMATCH", {
      stage: "validating", item: "visual", sourcePage: 3, outputPage: 1,
      visualDifference: { changedPixels: 2, sourceStable: true, outputStable: true },
    });
    vi.mocked(validateEditedPdf).mockRejectedValueOnce(failure);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
    await workspace.exporter.start(id, "edited.pdf");
    const calls = vi.mocked(engine.open).mock.calls;
    expect(calls).toHaveLength(7);
    for (let index = 0; index < 5; index++) expect(calls[index][3]).toBeUndefined();
    expect(calls[1]).toEqual([sourceFile, expect.any(AbortSignal), expect.any(Function)]);
    expect(calls[3]).toEqual([sourceFile, expect.any(AbortSignal), expect.any(Function)]);
    expect(calls[4]).toEqual([calls[2][0], calls[3][1], expect.any(Function)]);
    expect(calls[5]).toEqual([sourceFile, expect.any(AbortSignal), expect.any(Function), { fontMode: "paths" }]);
    expect(calls[6]).toEqual([calls[2][0], calls[5][1], expect.any(Function), { fontMode: "paths" }]);
    const request = vi.mocked(generateEditedPdf).mock.calls[0][1];
    expect(validateEditedPdf).toHaveBeenNthCalledWith(2, nativeProbeSource, nativeProbeOutput, request.pages, calls[3][1]);
    expect(validateEditedPdf).toHaveBeenNthCalledWith(3, probeSource, probeOutput, request.pages, calls[5][1]);
    expect(request.pages.map((page) => page.sourcePageNumber)).toEqual([3, 1]);
    expect(workspace.exporter.getSnapshot().error).toBe(failure.withContext({ nativeProbe: "match", rendererProbe: "font-paths-match" }).message);
    expect(workspace.exporter.getSnapshot().stage).toBe("error");
    expect(workspace.getSnapshot()).toBe(before);
    expect(original.destroy).not.toHaveBeenCalled();
    for (const handle of [validationSource, output, nativeProbeSource, nativeProbeOutput, probeSource, probeOutput]) expect(handle.destroy).toHaveBeenCalledTimes(1);
    workspace.exporter.download();
    expect(click).not.toHaveBeenCalled();
  });

  it.each(["VISUAL_CONTENT_MISMATCH", "TEXT_CONTENT_MISMATCH", "PAGE_GEOMETRY_MISMATCH"] as const)("keeps the native diagnostic when the font-path probe has %s", async (code) => {
    const { workspace, id, engine, probeSource, probeOutput } = await setup();
    const native = new PdfExportDiagnosticError("VISUAL_CONTENT_MISMATCH", { stage: "validating", item: "visual", outputPage: 2, sourcePage: 3 });
    vi.mocked(validateEditedPdf).mockRejectedValueOnce(native).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new PdfExportDiagnosticError(code, {
      stage: "validating", item: "text", outputPage: 1, sourcePage: 1,
    }));
    await workspace.exporter.start(id, "edited.pdf");
    expect(workspace.exporter.getSnapshot().error).toBe(native.withContext({ nativeProbe: "match", rendererProbe: "font-paths-mismatch",
      probeCode: code, probeOutputPage: 1, probeSourcePage: 1, probeItem: "text" }).message);
    expect(engine.open).toHaveBeenCalledTimes(7);
    expect(validateEditedPdf).toHaveBeenCalledTimes(3);
    expect(probeSource.destroy).toHaveBeenCalledTimes(1);
    expect(probeOutput.destroy).toHaveBeenCalledTimes(1);
  });

  it.each(["source-open", "output-open", "inspection", "cleanup"])("reports only unavailable for a private %s probe failure", async (phase) => {
    const { workspace, id, engine, validationSource, output, nativeProbeSource, nativeProbeOutput, probeSource, probeOutput } = await setup();
    const native = new PdfExportDiagnosticError("VISUAL_CONTENT_MISMATCH", { stage: "validating", item: "visual", outputPage: 1, sourcePage: 1 });
    const privateFailure = new Error("SYNTHETIC_PRIVATE_PROBE_DETAILS");
    vi.mocked(validateEditedPdf).mockRejectedValueOnce(native).mockResolvedValueOnce(undefined);
    if (phase === "source-open" || phase === "output-open") {
      vi.mocked(engine.open).mockResolvedValueOnce(validationSource).mockResolvedValueOnce(output).mockResolvedValueOnce(nativeProbeSource).mockResolvedValueOnce(nativeProbeOutput);
    }
    if (phase === "source-open") vi.mocked(engine.open).mockRejectedValueOnce(privateFailure);
    if (phase === "output-open") vi.mocked(engine.open).mockResolvedValueOnce(probeSource).mockRejectedValueOnce(privateFailure);
    if (phase === "inspection") vi.mocked(validateEditedPdf).mockRejectedValueOnce(privateFailure);
    if (phase === "cleanup") vi.mocked(probeSource.destroy).mockRejectedValueOnce(privateFailure);
    await workspace.exporter.start(id, "edited.pdf");
    expect(workspace.exporter.getSnapshot().error).toBe(native.withContext({ nativeProbe: "match", rendererProbe: "font-paths-unavailable" }).message);
    expect(workspace.exporter.getSnapshot().error).not.toContain("SYNTHETIC_PRIVATE_PROBE_DETAILS");
    expect(workspace.exporter.getSnapshot().error).not.toContain("probeCode");
    expect(output.destroy).toHaveBeenCalledTimes(1);
    if (phase !== "source-open") expect(probeSource.destroy).toHaveBeenCalledTimes(1);
    if (phase === "inspection" || phase === "cleanup") expect(probeOutput.destroy).toHaveBeenCalledTimes(1);
  });

  it("reports a later probe page and its safe visual metrics without replacing the native page diagnostic", async () => {
    const { workspace, id, probeSource, probeOutput } = await setup();
    const native = new PdfExportDiagnosticError("VISUAL_CONTENT_MISMATCH", {
      stage: "validating", item: "visual", outputPage: 1, sourcePage: 1,
      visualDifference: { changedPixels: 2, maxChannelDelta: 1, sourceStable: true, outputStable: true },
    });
    const probeDifference = { totalPixels: 11520, changedPixels: 9, maxChannelDelta: 6, meanAbsoluteDelta: 0.001,
      sourceStable: true, outputStable: false };
    const probeFailure = new PdfExportDiagnosticError("VISUAL_CONTENT_MISMATCH", {
      stage: "validating", item: "visual", outputPage: 3, sourcePage: 3, visualDifference: probeDifference,
    });
    vi.mocked(validateEditedPdf).mockRejectedValueOnce(native).mockResolvedValueOnce(undefined).mockRejectedValueOnce(probeFailure);
    await workspace.exporter.start(id, "edited.pdf");
    expect(workspace.exporter.getSnapshot().error).toBe(native.withContext({ nativeProbe: "match", rendererProbe: "font-paths-mismatch",
      probeCode: "VISUAL_CONTENT_MISMATCH", probeOutputPage: 3, probeSourcePage: 3, probeItem: "visual", probeVisualDifference: probeDifference }).message);
    expect(workspace.exporter.getSnapshot().stage).toBe("error");
    expect(probeSource.destroy).toHaveBeenCalledTimes(1);
    expect(probeOutput.destroy).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a typed probe timeout from a content mismatch while retaining the native failure", async () => {
    const { workspace, id } = await setup();
    const native = new PdfExportDiagnosticError("VISUAL_CONTENT_MISMATCH", { stage: "validating", item: "visual", outputPage: 1, sourcePage: 1 });
    vi.mocked(validateEditedPdf).mockRejectedValueOnce(native).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new PdfExportDiagnosticError("VALIDATION_TIMEOUT", {
      stage: "source-inspection", item: "deadline", outputPage: 2, sourcePage: 2,
    }));
    await workspace.exporter.start(id, "edited.pdf");
    expect(workspace.exporter.getSnapshot().error).toBe(native.withContext({ nativeProbe: "match", rendererProbe: "font-paths-unavailable",
      probeCode: "VALIDATION_TIMEOUT", probeOutputPage: 2, probeSourcePage: 2, probeItem: "deadline" }).message);
    expect(workspace.exporter.getSnapshot().stage).toBe("error");
  });

  it("does not launch a renderer probe for a native text mismatch", async () => {
    const { workspace, id, engine } = await setup();
    const failure = new PdfExportDiagnosticError("TEXT_CONTENT_MISMATCH", { stage: "validating", item: "text", outputPage: 1, sourcePage: 1 });
    vi.mocked(validateEditedPdf).mockRejectedValueOnce(failure);
    await workspace.exporter.start(id, "edited.pdf");
    expect(workspace.exporter.getSnapshot().error).toBe(failure.message);
    expect(engine.open).toHaveBeenCalledTimes(3);
    expect(validateEditedPdf).toHaveBeenCalledTimes(1);
  });

  it("preserves cancellation during probe validation and releases both temporary handles", async () => {
    const { workspace, id, original, output, nativeProbeSource, nativeProbeOutput, probeSource, probeOutput } = await setup();
    const failure = new PdfExportDiagnosticError("VISUAL_CONTENT_MISMATCH", { stage: "validating", item: "visual" });
    vi.mocked(validateEditedPdf).mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined).mockImplementationOnce(async (_source, _output, _pages, currentSignal) => {
      await new Promise<void>((_resolve, reject) => {
        currentSignal.addEventListener("abort", () => reject(currentSignal.reason), { once: true });
      });
    });
    const run = workspace.exporter.start(id, "edited.pdf");
    await vi.waitFor(() => expect(validateEditedPdf).toHaveBeenCalledTimes(3));
    workspace.exporter.cancel();
    await run;
    expect(workspace.exporter.getSnapshot()).toMatchObject({ stage: "idle", busy: false, error: null });
    expect(original.destroy).not.toHaveBeenCalled();
    for (const handle of [output, nativeProbeSource, nativeProbeOutput, probeSource, probeOutput]) expect(handle.destroy).toHaveBeenCalledTimes(1);
  });

  it.each(["source", "output"])("cleans a late baseline %s after cancellation without opening any further diagnostic documents", async (side) => {
    const { workspace, id, engine, validationSource, output, nativeProbeSource, nativeProbeOutput, probeSource, probeOutput } = await setup();
    const failure = new PdfExportDiagnosticError("VISUAL_CONTENT_MISMATCH", { stage: "validating", item: "visual" });
    let finish!: (value: PdfDocumentHandle) => void;
    vi.mocked(validateEditedPdf).mockRejectedValueOnce(failure);
    vi.mocked(engine.open).mockResolvedValueOnce(validationSource).mockResolvedValueOnce(output);
    if (side === "output") vi.mocked(engine.open).mockResolvedValueOnce(nativeProbeSource);
    vi.mocked(engine.open).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const run = workspace.exporter.start(id, "edited.pdf");
    const openCount = side === "source" ? 4 : 5;
    await vi.waitFor(() => expect(engine.open).toHaveBeenCalledTimes(openCount));
    workspace.exporter.cancel();
    finish(side === "source" ? nativeProbeSource : nativeProbeOutput);
    await run;
    expect(engine.open).toHaveBeenCalledTimes(openCount);
    expect(nativeProbeSource.destroy).toHaveBeenCalledTimes(1);
    expect(nativeProbeOutput.destroy).toHaveBeenCalledTimes(side === "source" ? 0 : 1);
    expect(probeSource.destroy).not.toHaveBeenCalled();
    expect(probeOutput.destroy).not.toHaveBeenCalled();
    expect(workspace.exporter.getSnapshot()).toMatchObject({ stage: "idle", busy: false, error: null });
  });

  it("bounds both stalled probe cleanups together without replacing the native failure", async () => {
    const { workspace, id, probeSource, probeOutput } = await setup();
    vi.useFakeTimers();
    const failure = new PdfExportDiagnosticError("VISUAL_CONTENT_MISMATCH", { stage: "validating", item: "visual" });
    vi.mocked(validateEditedPdf).mockRejectedValueOnce(failure);
    vi.mocked(probeSource.destroy).mockImplementationOnce(() => new Promise(() => {}));
    vi.mocked(probeOutput.destroy).mockImplementationOnce(() => new Promise(() => {}));
    const run = workspace.exporter.start(id, "edited.pdf");
    await vi.waitFor(() => expect(probeOutput.destroy).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(3000);
    await run;
    expect(workspace.exporter.getSnapshot().error).toBe(failure.withContext({ nativeProbe: "match", rendererProbe: "font-paths-unavailable" }).message);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a fresh-native text failure distinct even when font paths subsequently match", async () => {
    const { workspace, id, nativeProbeSource, nativeProbeOutput, probeSource, probeOutput } = await setup();
    const originalFailure = new PdfExportDiagnosticError("VISUAL_CONTENT_MISMATCH", { stage: "validating", item: "visual", outputPage: 1, sourcePage: 1 });
    const baselineFailure = new PdfExportDiagnosticError("TEXT_CONTENT_MISMATCH", { stage: "validating", item: "text", outputPage: 2, sourcePage: 2 });
    vi.mocked(validateEditedPdf).mockRejectedValueOnce(originalFailure).mockRejectedValueOnce(baselineFailure);
    await workspace.exporter.start(id, "edited.pdf");
    expect(workspace.exporter.getSnapshot().error).toBe(originalFailure.withContext({ nativeProbe: "mismatch",
      nativeProbeCode: "TEXT_CONTENT_MISMATCH", nativeProbeOutputPage: 2, nativeProbeSourcePage: 2, nativeProbeItem: "text", rendererProbe: "font-paths-match" }).message);
    expect(workspace.exporter.getSnapshot().stage).toBe("error");
    expect(validateEditedPdf).toHaveBeenCalledTimes(3);
    for (const handle of [nativeProbeSource, nativeProbeOutput, probeSource, probeOutput]) expect(handle.destroy).toHaveBeenCalledTimes(1);
  });

  it("does not let an unavailable fresh-native probe skip the independent font-path diagnostic", async () => {
    const { workspace, id, engine, validationSource, output, probeSource, probeOutput } = await setup();
    const originalFailure = new PdfExportDiagnosticError("VISUAL_CONTENT_MISMATCH", { stage: "validating", item: "visual", outputPage: 1, sourcePage: 1 });
    vi.mocked(validateEditedPdf).mockRejectedValueOnce(originalFailure);
    vi.mocked(engine.open).mockResolvedValueOnce(validationSource).mockResolvedValueOnce(output).mockRejectedValueOnce(new Error("SYNTHETIC_PRIVATE_NATIVE_PARSER"));
    await workspace.exporter.start(id, "edited.pdf");
    expect(workspace.exporter.getSnapshot().error).toBe(originalFailure.withContext({ nativeProbe: "unavailable", rendererProbe: "font-paths-match" }).message);
    expect(workspace.exporter.getSnapshot().error).not.toContain("SYNTHETIC_PRIVATE_NATIVE_PARSER");
    expect(engine.open).toHaveBeenCalledTimes(6);
    expect(probeSource.destroy).toHaveBeenCalledTimes(1);
    expect(probeOutput.destroy).toHaveBeenCalledTimes(1);
  });

  it("honors cancellation while the fresh-native documents are being released", async () => {
    const { workspace, id, engine, nativeProbeSource, nativeProbeOutput, probeSource } = await setup();
    vi.useFakeTimers();
    vi.mocked(validateEditedPdf).mockRejectedValueOnce(new PdfExportDiagnosticError("VISUAL_CONTENT_MISMATCH", { stage: "validating", item: "visual" }));
    vi.mocked(nativeProbeSource.destroy).mockImplementationOnce(() => new Promise(() => {}));
    vi.mocked(nativeProbeOutput.destroy).mockImplementationOnce(() => new Promise(() => {}));
    const run = workspace.exporter.start(id, "edited.pdf");
    await vi.waitFor(() => expect(nativeProbeOutput.destroy).toHaveBeenCalled());
    workspace.exporter.cancel();
    await vi.advanceTimersByTimeAsync(3000);
    await run;
    expect(workspace.exporter.getSnapshot()).toMatchObject({ stage: "idle", busy: false, error: null });
    expect(engine.open).toHaveBeenCalledTimes(5);
    expect(probeSource.destroy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
