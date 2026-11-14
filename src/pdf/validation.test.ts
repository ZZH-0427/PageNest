import { describe, expect, it, vi } from "vitest";
import { readPdfBytes, validatePdfHeader } from "./validation";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("PDF content validation", () => {
  it.each(["%PDF-1.0\n", "%PDF-1.7\r\n", "%PDF-2.0\n", `${" ".repeat(900)}%PDF-1.4\n`])(
    "accepts a supported PDF header within the first 1024 bytes",
    (header) => expect(() => validatePdfHeader(bytes(header))).not.toThrow(),
  );

  it.each(["", "not a PDF", "%PDF-1.8\n", "%PDF-2.1\n", "%PDF-1.7garbage", `${" ".repeat(1024)}%PDF-1.7\n`])(
    "rejects missing, malformed, unsupported or out-of-range headers",
    (header) => expect(() => validatePdfHeader(bytes(header))).toThrow("PDF 标识"),
  );

  it("checks actual bytes regardless of a misleading extension or MIME type", async () => {
    const disguised = new File(["plain text"], "disguised.pdf", { type: "application/pdf" });
    const actual = new File(["%PDF-1.7\n"], "document.bin", { type: "application/octet-stream" });
    expect(() => validatePdfHeader(bytes("plain text"))).toThrow();
    const misleadingBytes = await readPdfBytes(disguised, new AbortController().signal);
    expect(() => validatePdfHeader(misleadingBytes)).toThrow("PDF 标识");
    const actualBytes = await readPdfBytes(actual, new AbortController().signal);
    expect(() => validatePdfHeader(actualBytes)).not.toThrow();
    expect(Array.from(actualBytes)).toEqual(Array.from(bytes("%PDF-1.7\n")));
  });
});

class ControlledReader {
  static current: ControlledReader;
  result: ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  readAsArrayBuffer = vi.fn();
  abort = vi.fn(() => this.onabort?.());
  constructor() { ControlledReader.current = this; }
}

describe("cancellable PDF file reading", () => {
  it("aborts FileReader and removes the abort listener", async () => {
    vi.stubGlobal("FileReader", ControlledReader);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const reading = readPdfBytes(new Blob(["synthetic"]), controller.signal);
    const result = reading.catch((error: Error) => error.name);
    controller.abort();
    await expect(result).resolves.toBe("AbortError");
    expect(ControlledReader.current.abort).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("does not start FileReader for an already cancelled request", async () => {
    const constructor = vi.fn(ControlledReader);
    vi.stubGlobal("FileReader", constructor);
    const controller = new AbortController();
    controller.abort();
    await expect(readPdfBytes(new Blob(), controller.signal)).rejects.toHaveProperty("name", "AbortError");
    expect(constructor).not.toHaveBeenCalled();
  });

  it("cleans up after a read failure and returns a safe user message", async () => {
    vi.stubGlobal("FileReader", ControlledReader);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const reading = readPdfBytes(new Blob(), controller.signal);
    ControlledReader.current.onerror?.();
    await expect(reading).rejects.toThrow("无法读取此文件");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("releases its abort listener if FileReader throws before reading starts", async () => {
    class ThrowingReader extends ControlledReader {
      readAsArrayBuffer = vi.fn(() => { throw new DOMException("Synthetic read failure", "NotReadableError"); });
    }
    vi.stubGlobal("FileReader", ThrowingReader);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await expect(readPdfBytes(new Blob(), controller.signal)).rejects.toBeDefined();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
