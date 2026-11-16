import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPdfEngine } from "./browser-engine";
import { PdfUserError, type PdfEngine, type PdfOpenOptions } from "./types";
import { webcrypto } from "node:crypto";

const adapter = vi.hoisted(() => ({
  createWorker: vi.fn(),
  getDocument: vi.fn(),
  readPdfBytes: vi.fn(),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({
  default: "/PageNest/assets/pdf.worker.min-synthetic.mjs",
}));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  version: "6.5.438",
  PDFWorker: { create: adapter.createWorker },
  getDocument: adapter.getDocument,
  OPS: { save: 10, restore: 11, transform: 12, constructPath: 91, setFillRGBColor: 59, setStrokeRGBColor: 58, setLineWidth: 2 },
}));
vi.mock("./validation", async (importOriginal) => ({
  ...await importOriginal<typeof import("./validation")>(),
  readPdfBytes: adapter.readPdfBytes,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class ParserWorker extends EventTarget {
  static instances: ParserWorker[] = [];
  terminate = vi.fn();

  constructor(readonly url: string, readonly options: WorkerOptions) {
    super();
    ParserWorker.instances.push(this);
  }
}

function syntheticDocument(width = 612, height = 792, originalRotation = 0) {
  const page = {
    rotate: originalRotation,
    getOperatorList: vi.fn(async (): Promise<{ fnArray: number[]; argsArray: unknown[]; lastChunk: boolean }> => ({ fnArray: [], argsArray: [], lastChunk: true })),
    getTextContent: vi.fn(async () => ({ items: [{ str: "SYNTHETIC PAGE" }] })),
    getViewport: vi.fn(({ scale, rotation = originalRotation }: { scale: number; rotation?: number }) => ({
      width: (rotation % 180 === 0 ? width : height) * scale,
      height: (rotation % 180 === 0 ? height : width) * scale,
      rotation, viewBox: [0, 0, width, height], userUnit: 1, transform: [scale, 0, 0, -scale, 0, height * scale],
    })),
    cleanup: vi.fn(),
    render: vi.fn<(options: { canvas: HTMLCanvasElement; viewport: { width: number; height: number; rotation: number }; background: string }) => { promise: Promise<void>; cancel: ReturnType<typeof vi.fn> }>(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
  };
  const document = { numPages: 1, getPage: vi.fn(async () => page) };
  const task = { promise: Promise.resolve(document), destroy: vi.fn(async () => {}), onPassword: null };
  return { page, document, task };
}

function documentEvidenceFixture() {
  const fixture = syntheticDocument();
  const info: Record<string, unknown> = { Title: "SYNTHETIC TITLE", Author: "SYNTHETIC AUTHOR", PDFFormatVersion: "1.4", IsLinearized: false };
  const metadata = vi.fn(async () => ({ info, metadata: { getRaw: () => "<synthetic-metadata />" } }));
  const outline = vi.fn(async () => [{ title: "SYNTHETIC BOOKMARK", bold: false, italic: false,
    color: new Uint8ClampedArray([0, 0, 0]), dest: [{ num: 12, gen: 0 }, { name: "Fit" }], items: [] }]);
  const document = { ...fixture.document, getMetadata: metadata, getOutline: outline,
    getPageIndex: vi.fn(async () => 0), getDestination: vi.fn(async () => null),
    getAttachments: vi.fn(async (): Promise<null | Record<string, unknown>> => null),
    getJSActions: vi.fn(async (): Promise<null | Record<string, unknown>> => null),
    getPermissions: vi.fn(async (): Promise<null | number[]> => null) };
  fixture.task.promise = Promise.resolve(document);
  return { ...fixture, evidence: document, info, outline };
}

describe("compression document inspection remains separate from ordinary previews", () => {
  it("retains exact default 128 rendering and supports a bounded explicit 512 render", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const fixture = syntheticDocument();
    adapter.getDocument.mockReturnValue(fixture.task);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, 255]) }) } as unknown as CanvasRenderingContext2D);
    const handle = await engine().open(file(), signal(), vi.fn());
    await handle.inspectPage!(1, signal());
    await handle.inspectPage!(1, signal(), 0, false, 512);
    expect(fixture.page.render.mock.calls.map(([call]) => Math.max(call.viewport.width, call.viewport.height))).toEqual([128, 512]);
    await expect(handle.inspectPage!(1, signal(), 0, false, 4096 as 512)).rejects.toMatchObject({ code: "INSPECTION_FAILURE" });
    expect(fixture.page.render).toHaveBeenCalledTimes(2);
  });

  it("compares metadata and semantic bookmark destinations without exposing authored values", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const fixture = documentEvidenceFixture();
    adapter.getDocument.mockReturnValue(fixture.task);
    const handle = await engine().open(file(), signal(), vi.fn());
    const first = await handle.inspectDocument!(signal());
    fixture.info.PDFFormatVersion = "1.7";
    fixture.info.IsLinearized = true;
    fixture.outline.mockResolvedValue([{ title: "SYNTHETIC BOOKMARK", bold: false, italic: false, color: new Uint8ClampedArray([0, 0, 0]),
      dest: [{ num: 77, gen: 0 }, { name: "Fit" }], items: [] }]);
    const rewritten = await handle.inspectDocument!(signal());
    expect(rewritten).toEqual(first);
    fixture.info.Author = "CHANGED SYNTHETIC AUTHOR";
    expect((await handle.inspectDocument!(signal())).metadataDigest).not.toBe(first.metadataDigest);
    fixture.evidence.getPageIndex.mockResolvedValue(1);
    expect((await handle.inspectDocument!(signal())).outlinesDigest).not.toBe(first.outlinesDigest);
    expect(JSON.stringify(first)).not.toContain("SYNTHETIC");
    expect(first).toMatchObject({ hasForms: false, hasSignatures: false, hasAttachments: false, hasJavaScript: false, encrypted: false });
  });

  it("reports unsupported document capabilities as booleans and hides raw parser failures", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const fixture = documentEvidenceFixture();
    fixture.info.IsSignaturesPresent = true;
    fixture.info.IsAcroFormPresent = true;
    fixture.evidence.getAttachments.mockResolvedValue({ synthetic: { content: "SYNTHETIC PRIVATE ATTACHMENT" } });
    fixture.evidence.getJSActions.mockResolvedValue({ synthetic: "SYNTHETIC SCRIPT" });
    fixture.evidence.getPermissions.mockResolvedValue([]);
    adapter.getDocument.mockReturnValue(fixture.task);
    const handle = await engine().open(file(), signal(), vi.fn());
    const result = await handle.inspectDocument!(signal());
    expect(result).toMatchObject({ hasForms: true, hasSignatures: true, hasAttachments: true, hasJavaScript: true, encrypted: true });
    expect(JSON.stringify(result)).not.toMatch(/ATTACHMENT|SCRIPT/);
    fixture.evidence.getMetadata.mockRejectedValue(new Error("SYNTHETIC PRIVATE PARSER DETAIL"));
    const failure = await handle.inspectDocument!(signal()).catch((error) => error);
    expect(failure).toBeInstanceOf(PdfUserError);
    expect(String(failure)).not.toContain("SYNTHETIC PRIVATE");
  });
});

function pendingRender() {
  const completion = deferred<void>();
  const task = {
    promise: completion.promise,
    cancel: vi.fn(() => completion.reject(new DOMException("Synthetic cancellation", "RenderingCancelledException"))),
  };
  return { completion, task };
}

const file = () => new File(["%PDF-1.7\n"], "synthetic.pdf", { type: "application/pdf" });
const signal = () => new AbortController().signal;
const engines: BrowserPdfEngine[] = [];
let sharedWorker: { destroy: ReturnType<typeof vi.fn> };
let bytes: Uint8Array<ArrayBuffer>;

function engine() {
  const result = new BrowserPdfEngine();
  engines.push(result);
  return result;
}

beforeEach(() => {
  adapter.createWorker.mockReset();
  adapter.getDocument.mockReset();
  adapter.readPdfBytes.mockReset();
  ParserWorker.instances = [];
  sharedWorker = { destroy: vi.fn() };
  bytes = new TextEncoder().encode("%PDF-1.7\nsynthetic adapter data");
  adapter.createWorker.mockReturnValue(sharedWorker);
  adapter.readPdfBytes.mockImplementation(async (_blob: Blob, abort: AbortSignal) => {
    abort.throwIfAborted();
    return bytes;
  });
  vi.stubGlobal("Worker", ParserWorker);
  vi.stubEnv("BASE_URL", "/PageNest/");
});

afterEach(async () => {
  await Promise.all(engines.splice(0).map((item) => item.destroy()));
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("browser PDF adapter ownership and local inputs", () => {
  it("passes only local data and same-version assets, sharing one worker without destroying sibling documents", async () => {
    const first = syntheticDocument();
    const second = syntheticDocument(792, 612);
    adapter.getDocument.mockReturnValueOnce(first.task).mockReturnValueOnce(second.task);
    const parser = engine();
    const progress = vi.fn();
    const firstHandle = await parser.open(file(), signal(), progress);
    const secondHandle = await parser.open(file(), signal(), vi.fn());

    expect(progress.mock.calls).toEqual([["reading"], ["parsing"]]);
    expect(ParserWorker.instances).toHaveLength(1);
    expect(ParserWorker.instances[0]).toMatchObject({
      url: "/PageNest/assets/pdf.worker.min-synthetic.mjs",
      options: { type: "module", name: "PageNest PDF parser" },
    });
    expect(adapter.createWorker).toHaveBeenCalledExactlyOnceWith({ port: ParserWorker.instances[0], verbosity: 0 });
    expect(adapter.getDocument).toHaveBeenCalledTimes(2);
    for (const [options] of adapter.getDocument.mock.calls) {
      expect(options).toEqual({
        data: bytes, worker: sharedWorker, verbosity: 0, stopAtErrors: true,
        enableXfa: false, useWorkerFetch: true, cMapPacked: true,
        cMapUrl: "/PageNest/pdfjs/6.5.438/cmaps/",
        standardFontDataUrl: "/PageNest/pdfjs/6.5.438/standard_fonts/",
        wasmUrl: "/PageNest/pdfjs/6.5.438/wasm/",
        iccUrl: "/PageNest/pdfjs/6.5.438/iccs/",
        canvasMaxAreaInBytes: 16 * 1024 ** 2,
      });
      expect(options.data).toBe(bytes);
    }
    expect(firstHandle.pages).toEqual([{ number: 1, width: 612, height: 792, rotation: 0, orientation: "portrait" }]);
    expect(secondHandle.pages[0].orientation).toBe("landscape");
    await firstHandle.destroy();
    await firstHandle.destroy();
    expect(first.task.destroy).toHaveBeenCalledOnce();
    expect(second.task.destroy).not.toHaveBeenCalled();
    expect(sharedWorker.destroy).not.toHaveBeenCalled();
    expect(ParserWorker.instances[0].terminate).not.toHaveBeenCalled();

    const canvas = document.createElement("canvas");
    await secondHandle.render(1, canvas, signal());
    expect(second.page.render).toHaveBeenCalledWith({ canvas, viewport: expect.objectContaining({ width: 320 }), background: "#ffffff" });
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(320 * 440);
    await parser.destroy();
    expect(second.task.destroy).toHaveBeenCalledOnce();
    expect(sharedWorker.destroy).toHaveBeenCalledOnce();
    expect(ParserWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it("releases a failed worker wrapper before retrying, never passing a missing worker to PDF.js", async () => {
    adapter.createWorker.mockImplementationOnce(() => { throw new Error("Synthetic worker startup failure"); });
    adapter.getDocument.mockReturnValue(syntheticDocument().task);
    const parser = engine();
    await expect(parser.open(file(), signal(), vi.fn())).rejects.toThrow("无法启动 PDF 解析组件");
    expect(ParserWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(adapter.getDocument).not.toHaveBeenCalled();

    await parser.open(file(), signal(), vi.fn());
    expect(ParserWorker.instances).toHaveLength(2);
    expect(adapter.createWorker).toHaveBeenCalledTimes(2);
    expect(adapter.getDocument.mock.calls[0][0].worker).toBe(sharedWorker);
  });

  it("waits for document cleanup already in progress before terminating the shared worker", async () => {
    const first = syntheticDocument();
    const second = syntheticDocument();
    const firstCleanup = deferred<void>();
    const secondCleanup = deferred<void>();
    first.task.destroy.mockImplementation(() => firstCleanup.promise);
    second.task.destroy.mockImplementation(() => secondCleanup.promise);
    adapter.getDocument.mockReturnValueOnce(first.task).mockReturnValueOnce(second.task);
    const parser = engine();
    const firstHandle = await parser.open(file(), signal(), vi.fn());
    await parser.open(file(), signal(), vi.fn());
    const removingFirst = firstHandle.destroy();
    const closing = parser.destroy();

    try {
      await Promise.resolve();
      expect(first.task.destroy).toHaveBeenCalledOnce();
      expect(second.task.destroy).toHaveBeenCalledOnce();
      expect(sharedWorker.destroy).not.toHaveBeenCalled();
      expect(ParserWorker.instances[0].terminate).not.toHaveBeenCalled();
      secondCleanup.resolve();
      await Promise.resolve();
      expect(ParserWorker.instances[0].terminate).not.toHaveBeenCalled();
      firstCleanup.resolve();
      await Promise.all([removingFirst, closing]);
      expect(sharedWorker.destroy).toHaveBeenCalledOnce();
      expect(ParserWorker.instances[0].terminate).toHaveBeenCalledOnce();
    } finally {
      firstCleanup.resolve();
      secondCleanup.resolve();
      await Promise.all([removingFirst, closing]);
    }
  });

  it("terminates an unresponsive worker only after the 3-second cleanup deadline", async () => {
    vi.useFakeTimers();
    const fixture = syntheticDocument();
    fixture.task.destroy.mockImplementation(() => new Promise<void>(() => {}));
    adapter.getDocument.mockReturnValue(fixture.task);
    // This test owns shutdown so a regression cannot strand the shared afterEach cleanup.
    const parser = new BrowserPdfEngine();
    await parser.open(file(), signal(), vi.fn());
    ParserWorker.instances[0].dispatchEvent(new Event("messageerror"));
    const settled = vi.fn();
    const closing = parser.destroy().then(settled);
    const closingAgain = parser.destroy();

    try {
      await vi.advanceTimersByTimeAsync(2999);
      expect(fixture.task.destroy).toHaveBeenCalledOnce();
      expect(settled).not.toHaveBeenCalled();
      expect(sharedWorker.destroy).not.toHaveBeenCalled();
      expect(ParserWorker.instances[0].terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all([closing, closingAgain]);
      expect(settled).toHaveBeenCalledOnce();
      expect(fixture.task.destroy).toHaveBeenCalledOnce();
      expect(sharedWorker.destroy).toHaveBeenCalledOnce();
      expect(ParserWorker.instances[0].terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.advanceTimersByTimeAsync(3000);
    }
  });

  it("consumes initialization rejection when disposed synchronously during a progress notification", async () => {
    const parser = engine();
    await expect(parser.open(file(), signal(), (status) => {
      if (status === "parsing") void parser.destroy();
    })).rejects.toHaveProperty("name", "AbortError");
    await vi.dynamicImportSettled();
    expect(ParserWorker.instances).toHaveLength(0);
    expect(adapter.getDocument).not.toHaveBeenCalled();
  });
});

describe("browser PDF adapter diagnostic font configuration", () => {
  it("changes only the font rendering flags when paths are explicitly requested", async () => {
    const preview = syntheticDocument();
    const diagnostic = syntheticDocument();
    adapter.getDocument.mockReturnValueOnce(preview.task).mockReturnValueOnce(diagnostic.task);
    const parser: PdfEngine = engine();
    const progress = vi.fn();
    const previewHandle = await parser.open(file(), signal(), vi.fn());
    const options: PdfOpenOptions = { fontMode: "paths" };
    const diagnosticHandle = await parser.open(file(), signal(), progress, options);

    const previewOptions = adapter.getDocument.mock.calls[0][0];
    const diagnosticOptions = adapter.getDocument.mock.calls[1][0];
    expect(diagnosticOptions).toEqual({ ...previewOptions, disableFontFace: true, useSystemFonts: false });
    expect(diagnosticOptions).not.toHaveProperty("fontMode");
    expect(diagnosticOptions.data).toBe(bytes);
    expect(diagnosticOptions.worker).toBe(previewOptions.worker);
    expect(options).toEqual({ fontMode: "paths" });
    expect(progress.mock.calls).toEqual([["reading"], ["parsing"]]);
    expect(diagnosticHandle.pages).toEqual(previewHandle.pages);
    expect(ParserWorker.instances).toHaveLength(1);

    await diagnosticHandle.destroy();
    expect(preview.task.destroy).not.toHaveBeenCalled();
    const canvas = document.createElement("canvas");
    await previewHandle.render(1, canvas, signal());
    expect(preview.page.render).toHaveBeenCalledWith({ canvas, viewport: expect.objectContaining({ width: 320 }), background: "#ffffff" });
    expect(sharedWorker.destroy).not.toHaveBeenCalled();
  });

  it("does not retain diagnostic options for later default or empty-option previews", async () => {
    adapter.getDocument.mockImplementation(() => syntheticDocument().task);
    const parser = engine();
    await parser.open(file(), signal(), vi.fn(), { fontMode: "paths" });
    await parser.open(file(), signal(), vi.fn());
    await parser.open(file(), signal(), vi.fn(), {});

    const diagnosticOptions = adapter.getDocument.mock.calls[0][0];
    const defaultOptions = adapter.getDocument.mock.calls[1][0];
    const emptyOptions = adapter.getDocument.mock.calls[2][0];
    expect(diagnosticOptions).toEqual({ ...defaultOptions, disableFontFace: true, useSystemFonts: false });
    expect(emptyOptions).toEqual(defaultOptions);
    for (const options of [defaultOptions, emptyOptions]) {
      expect(options).not.toHaveProperty("disableFontFace");
      expect(options).not.toHaveProperty("useSystemFonts");
      expect(options).not.toHaveProperty("isImageDecoderSupported");
      expect(options).not.toHaveProperty("isOffscreenCanvasSupported");
    }
  });
});

describe("browser PDF adapter loading failures", () => {
  it.each(["error", "messageerror"])("rejects a pending document on worker %s and destroys its loading task", async (eventName) => {
    const task = { promise: deferred<never>().promise, destroy: vi.fn(async () => {}) };
    adapter.getDocument.mockReturnValue(task);
    const parser = engine();
    const opening = parser.open(file(), signal(), vi.fn());
    const rejection = expect(opening).rejects.toBeInstanceOf(PdfUserError);
    await vi.waitFor(() => expect(adapter.getDocument).toHaveBeenCalledOnce());
    const event = new Event(eventName, { cancelable: true });
    ParserWorker.instances[0].dispatchEvent(event);
    await rejection;
    expect(task.destroy).toHaveBeenCalledOnce();
    if (eventName === "error") expect(event.defaultPrevented).toBe(true);
    await expect(parser.open(file(), signal(), vi.fn())).rejects.toBeInstanceOf(PdfUserError);
    expect(adapter.getDocument).toHaveBeenCalledOnce();
  });

  it("destroys only the loading task when a pending import is cancelled", async () => {
    const task = { promise: deferred<never>().promise, destroy: vi.fn(async () => {}) };
    adapter.getDocument.mockReturnValue(task);
    const controller = new AbortController();
    const opening = engine().open(file(), controller.signal, vi.fn());
    const rejection = expect(opening).rejects.toHaveProperty("name", "AbortError");
    await vi.waitFor(() => expect(adapter.getDocument).toHaveBeenCalledOnce());
    controller.abort();
    await rejection;
    expect(task.destroy).toHaveBeenCalledOnce();
    expect(sharedWorker.destroy).not.toHaveBeenCalled();
    expect(ParserWorker.instances[0].terminate).not.toHaveBeenCalled();
  });

  it("bounds pending parsing at 60 seconds and destroys its loading task", async () => {
    vi.useFakeTimers();
    const task = { promise: deferred<never>().promise, destroy: vi.fn(async () => {}) };
    adapter.getDocument.mockReturnValue(task);
    const opening = engine().open(file(), signal(), vi.fn());
    const rejection = expect(opening).rejects.toThrow("读取或解析耗时过长");
    await vi.waitFor(() => expect(adapter.getDocument).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    expect(task.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["PasswordException", "InvalidPDFException"])("cleans up rejected %s tasks without installing a password prompt", async (name) => {
    const completion = deferred<never>();
    const failure = Object.assign(new Error("Synthetic document error"), { name });
    const task = { promise: completion.promise, destroy: vi.fn(async () => {}), onPassword: null };
    adapter.getDocument.mockReturnValue(task);
    const opening = engine().open(file(), signal(), vi.fn());
    const rejection = expect(opening).rejects.toBe(failure);
    await vi.waitFor(() => expect(adapter.getDocument).toHaveBeenCalledOnce());
    completion.reject(failure);
    await rejection;
    expect(task.destroy).toHaveBeenCalledOnce();
    expect(task.onPassword).toBeNull();
  });

  it.each([0, 1001])("rejects a document with %i pages before asking for page proxies", async (count) => {
    const fixture = syntheticDocument();
    fixture.document.numPages = count;
    adapter.getDocument.mockReturnValue(fixture.task);
    await expect(engine().open(file(), signal(), vi.fn())).rejects.toThrow("最多支持 1000 页");
    expect(fixture.document.getPage).not.toHaveBeenCalled();
    expect(fixture.task.destroy).toHaveBeenCalledOnce();
  });
});

describe("browser PDF adapter render cleanup", () => {
  it("inspects real rendering geometry and content digests with bounded temporary pixels", async () => {
    const fixture = syntheticDocument(420, 594, 90);
    adapter.getDocument.mockReturnValue(fixture.task);
    const pixelReads: HTMLCanvasElement[] = [];
    vi.stubGlobal("crypto", webcrypto);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      return { getImageData: () => { pixelReads.push(this); return { data: new Uint8ClampedArray([38, 102, 217, 255]) }; } } as unknown as CanvasRenderingContext2D;
    });
    const handle = await engine().open(file(), signal(), vi.fn());
    const result = await handle.inspectPage!(1, signal(), 90);
    expect(result).toMatchObject({ width: 420, height: 594, rotation: 180 });
    expect(result.textDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.visualDigest).toMatch(/^[a-f0-9]{64}$/);
    const viewport = fixture.page.render.mock.calls[0][0].viewport;
    expect(Math.max(viewport.width, viewport.height)).toBe(128);
    expect(pixelReads).toHaveLength(1);
    expect([pixelReads[0].width, pixelReads[0].height]).toEqual([0, 0]);
    expect(adapter.getDocument).toHaveBeenCalledOnce();
    fixture.page.getTextContent.mockResolvedValue({ items: [{ str: "DIFFERENT SYNTHETIC PAGE" }] });
    const changed = await handle.inspectPage!(1, signal(), 90);
    expect(changed.textDigest).not.toBe(result.textDigest);
    expect(changed.visualDigest).toBe(result.visualDigest);
  });

  it("collects only requested render subset hashes and ignores document-specific IDs", async () => {
    vi.stubGlobal("crypto", webcrypto);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, 255]) }) } as unknown as CanvasRenderingContext2D);
    const fixture = syntheticDocument();
    const operations = { fnArray: [1, 12, 59, 91, 37, 85], argsArray: [
      ["synthetic_doc_font"], [1, 0, 0, 1, 10, 20], ["#123456"], [22, [new Float32Array([0, 10, 20])], new Float32Array([0, 0, 30, 40])],
      ["synthetic_doc_font", 10], ["synthetic_doc_image", 24, 24],
    ] as unknown[], lastChunk: true };
    fixture.page.getOperatorList.mockResolvedValue(operations);
    adapter.getDocument.mockReturnValue(fixture.task);
    const handle = await engine().open(file(), signal(), vi.fn());
    const normal = await handle.inspectPage!(1, signal());
    expect(normal).not.toHaveProperty("renderSignature");
    expect(fixture.page.getOperatorList).not.toHaveBeenCalled();
    const first = await handle.inspectPage!(1, signal(), 0, true);
    expect(first.renderSignature?.viewport).toMatch(/^[a-f0-9]{64}$/);
    expect(first.renderSignature?.graphics).toMatch(/^[a-f0-9]{64}$/);
    operations.argsArray[0] = ["another_doc_font"];
    operations.argsArray[4] = ["another_doc_font", 10];
    operations.argsArray[5] = ["another_doc_image", 24, 24];
    const renamed = await handle.inspectPage!(1, signal(), 0, true);
    expect(renamed.renderSignature).toEqual(first.renderSignature);
    operations.argsArray[2] = ["#123457"];
    const recolored = await handle.inspectPage!(1, signal(), 0, true);
    expect(recolored.renderSignature?.viewport).toBe(first.renderSignature?.viewport);
    expect(recolored.renderSignature?.graphics).not.toBe(first.renderSignature?.graphics);
    expect(recolored.textDigest).toBe(first.textDigest);
    expect(recolored.visualDigest).toBe(first.visualDigest);
    const originalViewport = fixture.page.getViewport.getMockImplementation()!;
    fixture.page.getViewport.mockImplementation((options) => ({ ...originalViewport(options), userUnit: 2 }));
    const resized = await handle.inspectPage!(1, signal(), 0, true);
    expect(resized.renderSignature?.viewport).not.toBe(recolored.renderSignature?.viewport);
    expect(resized.renderSignature?.graphics).toBe(recolored.renderSignature?.graphics);
    expect(JSON.stringify(resized.renderSignature)).not.toContain("synthetic");
  });

  it.each(["unsupported", "failure", "limit"])("omits optional signatures after %s without weakening normal inspection", async (kind) => {
    vi.stubGlobal("crypto", webcrypto);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, 255]) }) } as unknown as CanvasRenderingContext2D);
    const fixture = syntheticDocument();
    if (kind === "failure") fixture.page.getOperatorList.mockRejectedValue(new Error("SYNTHETIC_PRIVATE_OPERATOR_ERROR"));
    else fixture.page.getOperatorList.mockResolvedValue({ fnArray: [12], argsArray: [kind === "limit" ? Array(100_001).fill(1) : { privateData: "SYNTHETIC_PRIVATE_OPERATOR_ERROR" }], lastChunk: true });
    adapter.getDocument.mockReturnValue(fixture.task);
    const handle = await engine().open(file(), signal(), vi.fn());
    const result = await handle.inspectPage!(1, signal(), 0, true);
    expect(result).not.toHaveProperty("renderSignature");
    expect(result.textDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.visualDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_OPERATOR_ERROR");
  });

  it("inspection failures never reveal extracted document text", async () => {
    const fixture = syntheticDocument();
    fixture.page.getTextContent.mockRejectedValue(new Error("SYNTHETIC DOCUMENT CONTENT"));
    adapter.getDocument.mockReturnValue(fixture.task);
    const handle = await engine().open(file(), signal(), vi.fn());
    await expect(handle.inspectPage!(1, signal())).rejects.toThrow("无法验证页面内容");
    expect(fixture.page.render).not.toHaveBeenCalled();
  });

  it.each(["text", "visual"])("classifies %s inspection failures without retaining private exception content", async (item) => {
    vi.stubGlobal("crypto", webcrypto);
    const fixture = syntheticDocument();
    const privateFailure = new Error("SYNTHETIC_PRIVATE_FAILURE_CONTENT");
    if (item === "text") fixture.page.getTextContent.mockRejectedValue(privateFailure);
    else fixture.page.render.mockImplementation(() => { throw privateFailure; });
    adapter.getDocument.mockReturnValue(fixture.task);
    const handle = await engine().open(file(), signal(), vi.fn());
    const error = await handle.inspectPage!(1, signal()).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "INSPECTION_FAILURE", diagnostic: { stage: "inspection", item } });
    expect(String(error)).not.toContain(privateFailure.message);
    expect(JSON.stringify(error)).not.toContain(privateFailure.message);
    expect(error).not.toHaveProperty("cause");
  });

  it("identifies an inspection deadline and releases its render instead of reporting corruption", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", { subtle: { digest: vi.fn(async () => new ArrayBuffer(32)) } });
    const fixture = syntheticDocument();
    const rendering = pendingRender();
    fixture.page.render.mockReturnValue(rendering.task);
    adapter.getDocument.mockReturnValue(fixture.task);
    const handle = await engine().open(file(), signal(), vi.fn());
    const inspected = handle.inspectPage!(1, signal());
    const rejected = expect(inspected).rejects.toMatchObject({
      code: "VALIDATION_TIMEOUT", diagnostic: { stage: "inspection", item: "deadline" },
    });
    await vi.waitFor(() => expect(fixture.page.render).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(rendering.task.cancel).toHaveBeenCalled();
  });

  it.each(["abort", "timeout", "destroy"])("bounds an unresponsive render settlement after %s without replacing the primary failure", async (reason) => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", { subtle: { digest: vi.fn(async () => new ArrayBuffer(32)) } });
    const fixture = syntheticDocument();
    const stuck = { promise: new Promise<void>(() => {}), cancel: vi.fn() };
    fixture.page.render.mockReturnValue(stuck);
    adapter.getDocument.mockReturnValue(fixture.task);
    const handle = await engine().open(file(), signal(), vi.fn());
    const controller = new AbortController();
    const settled = vi.fn();
    const started = Date.now();
    const outcome = handle.inspectPage!(1, controller.signal).then(
      (value) => { settled(); return value; },
      (error: unknown) => { settled(); return error; },
    );
    await vi.waitFor(() => expect(fixture.page.render).toHaveBeenCalledOnce());
    const canvas = fixture.page.render.mock.calls[0][0].canvas;
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(20_000 - (Date.now() - started));
    else if (reason === "destroy") await handle.destroy();
    else controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(stuck.cancel).toHaveBeenCalled();
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(settled).toHaveBeenCalledOnce();
    if (reason === "timeout") expect(error).toMatchObject({ code: "VALIDATION_TIMEOUT", diagnostic: { stage: "inspection", item: "deadline" } });
    else if (reason === "abort") expect(error).toBe(controller.signal.reason);
    else expect(error).toHaveProperty("name", "AbortError");
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a safe cleanup diagnostic when rendering succeeds but page cleanup fails", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", { subtle: { digest: vi.fn(async () => new ArrayBuffer(32)) } });
    const fixture = syntheticDocument();
    adapter.getDocument.mockReturnValue(fixture.task);
    const handle = await engine().open(file(), signal(), vi.fn());
    fixture.page.cleanup.mockImplementation(() => { throw new Error("SYNTHETIC_PRIVATE_CLEANUP_ERROR"); });
    const error = await handle.inspectPage!(1, signal()).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "INSPECTION_FAILURE", diagnostic: { stage: "cleanup", item: "resources" } });
    expect(String(error)).not.toContain("SYNTHETIC_PRIVATE_CLEANUP_ERROR");
    expect(error).not.toHaveProperty("cause");
    const canvas = fixture.page.render.mock.calls[0][0].canvas;
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves an inspection failure and clears the deadline when cleanup also throws", async () => {
    vi.useFakeTimers();
    const fixture = syntheticDocument();
    adapter.getDocument.mockReturnValue(fixture.task);
    const handle = await engine().open(file(), signal(), vi.fn());
    fixture.page.getTextContent.mockRejectedValue(new Error("SYNTHETIC_PRIVATE_TEXT_ERROR"));
    fixture.page.cleanup.mockImplementation(() => { throw new Error("SYNTHETIC_PRIVATE_CLEANUP_ERROR"); });
    await expect(handle.inspectPage!(1, signal())).rejects.toMatchObject({
      code: "INSPECTION_FAILURE", diagnostic: { item: "text", stage: "inspection" },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["abort", "timeout"])("keeps %s semantics and clears deadlines when page cleanup fails", async (reason) => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", { subtle: { digest: vi.fn(async () => new ArrayBuffer(32)) } });
    const fixture = syntheticDocument();
    const rendering = pendingRender();
    fixture.page.render.mockReturnValue(rendering.task);
    adapter.getDocument.mockReturnValue(fixture.task);
    const handle = await engine().open(file(), signal(), vi.fn());
    fixture.page.cleanup.mockImplementation(() => { throw new Error("SYNTHETIC_PRIVATE_CLEANUP_ERROR"); });
    const controller = new AbortController();
    const inspected = handle.inspectPage!(1, controller.signal);
    const rejected = reason === "timeout" ? expect(inspected).rejects.toHaveProperty("code", "VALIDATION_TIMEOUT")
      : expect(inspected).rejects.toHaveProperty("name", "AbortError");
    await vi.waitFor(() => expect(fixture.page.render).toHaveBeenCalledOnce());
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(20_000);
    else controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    const canvas = fixture.page.render.mock.calls[0][0].canvas;
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
  });

  it.each(["abort", "timeout", "destroy"])("cancels inspection and releases its temporary canvas after %s", async (reason) => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", { subtle: { digest: vi.fn(async () => new ArrayBuffer(32)) } });
    const fixture = syntheticDocument();
    const rendering = pendingRender();
    fixture.page.render.mockReturnValue(rendering.task);
    adapter.getDocument.mockReturnValue(fixture.task);
    const handle = await engine().open(file(), signal(), vi.fn());
    const controller = new AbortController();
    const inspected = handle.inspectPage!(1, controller.signal);
    const rejected = reason === "timeout" ? expect(inspected).rejects.toThrow("验证耗时过长")
      : expect(inspected).rejects.toHaveProperty("name", "AbortError");
    await vi.waitFor(() => expect(fixture.page.render).toHaveBeenCalledOnce());
    const canvas = fixture.page.render.mock.calls[0][0].canvas;
    expect(Math.max(canvas.width, canvas.height)).toBeLessThanOrEqual(128);
    if (reason === "abort") controller.abort();
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(20_000);
    if (reason === "destroy") await handle.destroy();
    await rejected;
    expect(rendering.task.cancel).toHaveBeenCalled();
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 90, 180, 270])("combines the source rotation %i with editing deltas without reparsing or changing source data", async (originalRotation) => {
    const fixture = syntheticDocument(420, 594, originalRotation);
    adapter.getDocument.mockReturnValue(fixture.task);
    const parser = engine();
    const input = file();
    const originalBytes = bytes.slice();
    const handle = await parser.open(input, signal(), vi.fn());
    const originalInfo = structuredClone(handle.pages);
    const canvas = document.createElement("canvas");

    for (const delta of [90, 180, 270, 360, -90]) {
      await handle.render(1, canvas, signal(), delta);
      const expectedRotation = ((originalRotation + delta) % 360 + 360) % 360;
      const viewport = fixture.page.render.mock.calls.at(-1)![0].viewport;
      expect(viewport).toMatchObject({ rotation: expectedRotation });
      expect(viewport.width > viewport.height).toBe(expectedRotation % 180 !== 0);
      expect(canvas.width * canvas.height).toBeLessThanOrEqual(320 * 440);
      expect(fixture.page.rotate).toBe(originalRotation);
      expect(handle.pages).toEqual(originalInfo);
      expect(bytes).toEqual(originalBytes);
    }
    expect(adapter.getDocument).toHaveBeenCalledOnce();
    expect(adapter.readPdfBytes).toHaveBeenCalledTimes(2);
    expect(fixture.task.destroy).not.toHaveBeenCalled();
  });

  it.each(["abort", "timeout", "destroy"])("cancels and releases an active render after %s", async (reason) => {
    vi.useFakeTimers();
    const fixture = syntheticDocument();
    const rendering = pendingRender();
    fixture.page.render.mockReturnValue(rendering.task);
    adapter.getDocument.mockReturnValue(fixture.task);
    const handle = await engine().open(file(), signal(), vi.fn());
    const controller = new AbortController();
    const canvas = document.createElement("canvas");
    const result = handle.render(1, canvas, controller.signal);
    const rejection = reason === "timeout"
      ? expect(result).rejects.toThrow("渲染耗时过长")
      : expect(result).rejects.toHaveProperty("name", "AbortError");
    await vi.waitFor(() => expect(fixture.page.render).toHaveBeenCalledOnce());
    if (reason === "abort") controller.abort();
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(20_000);
    if (reason === "destroy") await handle.destroy();
    await rejection;
    expect(rendering.task.cancel).toHaveBeenCalled();
    expect(fixture.page.cleanup).toHaveBeenCalledTimes(2);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(fixture.task.destroy).toHaveBeenCalledTimes(reason === "destroy" ? 1 : 0);
  });

  it("cleans up a failed render and allows another page render on the same document", async () => {
    const fixture = syntheticDocument();
    const rendering = pendingRender();
    fixture.page.render.mockReturnValueOnce(rendering.task);
    adapter.getDocument.mockReturnValue(fixture.task);
    const handle = await engine().open(file(), signal(), vi.fn());
    const failure = new Error("Synthetic rendering failure");
    const result = handle.render(1, document.createElement("canvas"), signal());
    const rejection = expect(result).rejects.toBe(failure);
    await vi.waitFor(() => expect(fixture.page.render).toHaveBeenCalledOnce());
    rendering.completion.reject(failure);
    await rejection;
    expect(fixture.page.cleanup).toHaveBeenCalledTimes(2);
    expect(rendering.task.cancel).not.toHaveBeenCalled();
    expect(fixture.task.destroy).not.toHaveBeenCalled();
    await handle.render(1, document.createElement("canvas"), signal());
    expect(fixture.page.render).toHaveBeenCalledTimes(2);
    expect(fixture.page.cleanup).toHaveBeenCalledTimes(3);
  });
});
