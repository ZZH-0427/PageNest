import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfWorkspace } from "./workspace";
import { MAX_PDF_FILE_BYTES, MAX_WORKSPACE_BYTES, PdfUserError, type PdfDocumentHandle, type PdfEngine, type PdfPageInfo } from "./types";

vi.mock("./browser-engine", () => ({ BrowserPdfEngine: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function file(name = "synthetic.pdf", content = "%PDF-1.7\n", size?: number) {
  const result = new File([content], name, { type: "application/pdf" });
  if (size !== undefined) Object.defineProperty(result, "size", { value: size });
  return result;
}

function document(pages = 3): PdfDocumentHandle {
  return {
    pages: Array.from({ length: pages }, (_, i): PdfPageInfo => ({ number: i + 1, width: 612, height: 792, rotation: 0, orientation: "portrait" })),
    render: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  };
}

function engine(open: PdfEngine["open"] = async () => document()) {
  return { open: vi.fn(open), destroy: vi.fn(async () => {}) };
}

const workspaces: PdfWorkspace[] = [];
function workspace(pdfEngine: PdfEngine) {
  const instance = new PdfWorkspace(() => pdfEngine);
  workspaces.push(instance);
  return instance;
}

afterEach(() => {
  workspaces.splice(0).forEach((instance) => instance.dispose());
});

async function ready(instance: PdfWorkspace, count: number) {
  await vi.waitFor(() => expect(instance.getSnapshot().files.filter((entry) => entry.status === "ready")).toHaveLength(count));
}

describe("PDF workspace state", () => {
  it("imports independent same-name documents and preserves page selection when switching", async () => {
    const documents = [document(2), document(5)];
    const pdfEngine = engine(async () => documents.shift()!);
    const instance = workspace(pdfEngine);
    instance.addFiles([file("same.pdf", "first PDF"), file("same.pdf", "second PDF")]);
    await ready(instance, 2);
    const [first, second] = instance.getSnapshot().files;
    expect(first.id).not.toBe(second.id);
    expect([first.ordinal, second.ordinal]).toEqual([1, 2]);
    expect([first.pages.length, second.pages.length]).toEqual([2, 5]);
    expect(instance.getSnapshot().selectedId).toBe(first.id);
    instance.selectPage(first.id, 2);
    instance.selectFile(second.id);
    instance.selectPage(second.id, 4);
    instance.selectFile(first.id);
    expect(instance.getSnapshot().files.map((entry) => entry.selectedPage)).toEqual([2, 4]);
    instance.selectPage(first.id, 3);
    instance.selectPage(first.id, 0);
    instance.selectPage(first.id, 1.5);
    instance.selectFile("missing-file");
    expect(instance.getSnapshot().selectedId).toBe(first.id);
    expect(instance.getSnapshot().files[0].selectedPage).toBe(2);
  });

  it("continues a batch after failures, maps password errors, and hides internal diagnostics", async () => {
    const pdfEngine = engine(async (input, _signal, onStatus) => {
      onStatus("reading");
      onStatus("parsing");
      if (input.name === "locked.pdf") {
        const error = new Error("Synthetic internal diagnostic");
        error.name = "PasswordException";
        throw error;
      }
      if (input.name === "broken.pdf") throw new Error("Synthetic internal diagnostic");
      if (input.name === "invalid.pdf") throw new PdfUserError("文件不包含有效的 PDF 标识。");
      return document(7);
    });
    const instance = workspace(pdfEngine);
    instance.addFiles([file("locked.pdf"), file("broken.pdf"), file("invalid.pdf"), file("valid.pdf")]);
    await ready(instance, 1);
    const files = instance.getSnapshot().files;
    expect(files.map((entry) => entry.status)).toEqual(["error", "error", "error", "ready"]);
    expect(files[0].error).toContain("暂不支持密码保护");
    expect(files[1].error).toContain("可能已损坏");
    expect(files[2].error).toContain("PDF 标识");
    expect(files[3].pages).toHaveLength(7);
    expect(JSON.stringify(instance.getSnapshot())).not.toContain("Synthetic internal diagnostic");
  });

  it("rejects empty and oversized files before the engine reads them", async () => {
    const pdfEngine = engine();
    const instance = workspace(pdfEngine);
    instance.addFiles([file("empty.pdf", ""), file("oversized.pdf", "x", MAX_PDF_FILE_BYTES + 1), file("limit.pdf", "x", MAX_PDF_FILE_BYTES)]);
    await ready(instance, 1);
    expect(pdfEngine.open).toHaveBeenCalledOnce();
    expect(instance.getSnapshot().files[0].name).toBe("limit.pdf");
    expect(instance.getSnapshot().notice).toContain("空文件");
    expect(instance.getSnapshot().notice).toContain("100 MiB");
    instance.dismissNotice();
    expect(instance.getSnapshot().notice).toBeNull();
  });

  it("limits the workspace to 20 files across successive batches", async () => {
    const pdfEngine = engine();
    const instance = workspace(pdfEngine);
    instance.addFiles(Array.from({ length: 19 }, (_, i) => file(`${i}.pdf`)));
    instance.addFiles([file("twentieth.pdf"), file("overflow.pdf")]);
    await ready(instance, 20);
    expect(pdfEngine.open).toHaveBeenCalledTimes(20);
    expect(instance.getSnapshot().files.some((entry) => entry.name === "overflow.pdf")).toBe(false);
    expect(instance.getSnapshot().notice).toContain("20 个文件");
  });

  it("enforces cumulative bytes including queued files and recovers capacity after removal", async () => {
    const pdfEngine = engine();
    const instance = workspace(pdfEngine);
    instance.addFiles([
      file("one.pdf", "x", MAX_PDF_FILE_BYTES),
      file("two.pdf", "x", MAX_PDF_FILE_BYTES),
      file("three.pdf", "x", MAX_WORKSPACE_BYTES - 2 * MAX_PDF_FILE_BYTES),
      file("overflow.pdf", "x", 1),
    ]);
    expect(instance.getSnapshot().files).toHaveLength(3);
    expect(instance.getSnapshot().notice).toContain("256 MiB");
    await ready(instance, 3);
    instance.removeFile(instance.getSnapshot().files[0].id);
    instance.addFiles([file("replacement.pdf", "x", MAX_PDF_FILE_BYTES)]);
    await ready(instance, 3);
    expect(instance.getSnapshot().notice).toBeNull();
    expect(instance.getSnapshot().files.reduce((sum, entry) => sum + entry.size, 0)).toBe(MAX_WORKSPACE_BYTES);
  });

  it("serializes document imports and reports real intermediate loading states", async () => {
    const opening = deferred<PdfDocumentHandle>();
    const pdfEngine = engine(async (_file, _signal, onStatus) => { onStatus("reading"); return opening.promise; });
    const instance = workspace(pdfEngine);
    instance.addFiles([file("first.pdf"), file("second.pdf")]);
    expect(pdfEngine.open).toHaveBeenCalledOnce();
    expect(instance.getSnapshot().files.map((entry) => entry.status)).toEqual(["reading", "queued"]);
    opening.resolve(document());
    await ready(instance, 2);
    expect(pdfEngine.open).toHaveBeenCalledTimes(2);
  });
});

describe("PDF workspace cancellation and cleanup", () => {
  it("removes a loading file, cancels its signal, and disposes a late result without reviving it", async () => {
    const opening = deferred<PdfDocumentHandle>();
    let signal!: AbortSignal;
    let update!: (status: "reading" | "parsing") => void;
    const pdfEngine = engine((_file, inputSignal, onStatus) => { signal = inputSignal; update = onStatus; return opening.promise; });
    const instance = workspace(pdfEngine);
    instance.addFiles([file()]);
    const id = instance.getSnapshot().files[0].id;
    instance.removeFile(id);
    expect(signal.aborted).toBe(true);
    const late = document();
    update("parsing");
    opening.resolve(late);
    await vi.waitFor(() => expect(late.destroy).toHaveBeenCalledOnce());
    expect(instance.getSnapshot()).toEqual({ files: [], selectedId: null, notice: null });
    expect(pdfEngine.destroy).toHaveBeenCalledOnce();
  });

  it("cancels a queued import before it starts and chooses a remaining file on removal", async () => {
    const opening = deferred<PdfDocumentHandle>();
    const pdfEngine = engine(() => opening.promise);
    const instance = workspace(pdfEngine);
    instance.addFiles([file("one.pdf"), file("two.pdf"), file("three.pdf")]);
    const [first, second, third] = instance.getSnapshot().files;
    instance.removeFile(second.id);
    instance.removeFile(first.id);
    expect(instance.getSnapshot().selectedId).toBe(third.id);
    opening.resolve(document());
    await ready(instance, 1);
    expect(pdfEngine.open.mock.calls.map(([input]) => input.name)).toEqual(["one.pdf", "three.pdf"]);
  });

  it.each(["remove", "clear", "dispose"] as const)("limits rendering to two jobs and cancels running and queued renders on %s", async (action) => {
    const renderSignals: AbortSignal[] = [];
    const pdf = document();
    pdf.render = vi.fn((_page, _canvas, signal) => new Promise<void>((_resolve, reject) => {
      renderSignals.push(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const pdfEngine = engine(async () => pdf);
    const instance = workspace(pdfEngine);
    instance.addFiles([file()]);
    await ready(instance, 1);
    const id = instance.getSnapshot().files[0].id;
    const promises = [1, 2, 3].map((number) => instance.renderPage(id, number, globalThis.document.createElement("canvas"), new AbortController().signal).catch((error: Error) => error.name));
    expect(pdf.render).toHaveBeenCalledTimes(2);
    if (action === "remove") instance.removeFile(id);
    else if (action === "clear") instance.clear();
    else instance.dispose();
    expect(renderSignals.every((signal) => signal.aborted)).toBe(true);
    await expect(Promise.all(promises)).resolves.toEqual(["AbortError", "AbortError", "AbortError"]);
    expect(pdf.render).toHaveBeenCalledTimes(2);
    expect(pdf.destroy).toHaveBeenCalledOnce();
    expect(pdfEngine.destroy).toHaveBeenCalledOnce();
  });

  it("does not let a late render completion overwrite selection after fast file switches", async () => {
    const rendered = deferred<void>();
    const first = document();
    first.render = vi.fn(() => rendered.promise);
    const second = document(4);
    const docs = [first, second];
    const instance = workspace(engine(async () => docs.shift()!));
    instance.addFiles([file("one.pdf"), file("two.pdf")]);
    await ready(instance, 2);
    const [one, two] = instance.getSnapshot().files;
    const rendering = instance.renderPage(one.id, 2, globalThis.document.createElement("canvas"), new AbortController().signal);
    instance.selectFile(two.id);
    instance.selectPage(two.id, 4);
    instance.selectFile(one.id);
    instance.selectFile(two.id);
    rendered.resolve();
    await rendering;
    expect(instance.getSnapshot().selectedId).toBe(two.id);
    expect(instance.getSnapshot().files[1].selectedPage).toBe(4);
  });

  it("clears ready documents and aborts both active and queued imports", async () => {
    const pending = deferred<PdfDocumentHandle>();
    const complete = document();
    let loadingSignal!: AbortSignal;
    const pdfEngine = engine(async (input, signal) => {
      if (input.name === "ready.pdf") return complete;
      loadingSignal = signal;
      return pending.promise;
    });
    const instance = workspace(pdfEngine);
    instance.addFiles([file("ready.pdf")]);
    await ready(instance, 1);
    instance.addFiles([file("loading.pdf"), file("queued.pdf")]);
    await vi.waitFor(() => expect(pdfEngine.open).toHaveBeenCalledTimes(2));
    instance.clear();
    expect(loadingSignal.aborted).toBe(true);
    expect(complete.destroy).toHaveBeenCalledOnce();
    expect(pdfEngine.destroy).toHaveBeenCalledOnce();
    const late = document();
    pending.resolve(late);
    await vi.waitFor(() => expect(late.destroy).toHaveBeenCalledOnce());
    expect(pdfEngine.open).toHaveBeenCalledTimes(2);
    expect(instance.getSnapshot().files).toEqual([]);
  });

  it("survives activate/dispose/activate cycles without resurrecting stale documents", async () => {
    const oldOpening = deferred<PdfDocumentHandle>();
    const oldEngine = engine(() => oldOpening.promise);
    const newEngine = engine();
    const factory = vi.fn<() => PdfEngine>().mockReturnValueOnce(oldEngine).mockReturnValue(newEngine);
    const instance = new PdfWorkspace(factory);
    workspaces.push(instance);
    instance.activate();
    instance.addFiles([file("old.pdf")]);
    instance.dispose();
    instance.addFiles([file("ignored.pdf")]);
    expect(instance.getSnapshot().files).toEqual([]);
    instance.activate();
    instance.addFiles([file("new.pdf")]);
    const stale = document();
    oldOpening.resolve(stale);
    await ready(instance, 1);
    expect(stale.destroy).toHaveBeenCalledOnce();
    expect(instance.getSnapshot().files.map((entry) => entry.name)).toEqual(["new.pdf"]);
    expect(oldEngine.destroy).toHaveBeenCalledOnce();
    expect(newEngine.open).toHaveBeenCalledOnce();
    instance.dispose();
    expect(newEngine.destroy).toHaveBeenCalledOnce();
    expect(instance.getSnapshot().files).toEqual([]);
  });

  it("unsubscribes listeners and rejects rendering after disposal", async () => {
    const instance = workspace(engine());
    const listener = vi.fn();
    const unsubscribe = instance.subscribe(listener);
    instance.addFiles([file()]);
    await ready(instance, 1);
    const id = instance.getSnapshot().files[0].id;
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    instance.dispose();
    expect(listener).not.toHaveBeenCalled();
    await expect(instance.renderPage(id, 1, globalThis.document.createElement("canvas"), new AbortController().signal)).rejects.toHaveProperty("name", "AbortError");
  });
});
