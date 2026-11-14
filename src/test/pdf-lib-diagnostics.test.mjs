// @vitest-environment node
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { build as bundle } from "esbuild";
import { build as viteBuild } from "vite";
import { describe, expect, it, vi } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { makePdf } from "./fixtures/synthetic/pdf-fixtures.mjs";
import { isPdfLibDiagnosticModule, pdfLibDiagnostics, pdfLibDiagnosticsOptimizer, stripPdfLibDiagnostics } from "../../scripts/pdf-lib-diagnostics";

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("pdf-lib/package.json"));
const entry = join(root, "es/index.js");
const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
const marker = "12345678901234567890123456789";

function libraryFrom(code) {
  const module = { exports: {} };
  const console = { warn: vi.fn(), log: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  runInNewContext(code, { module, exports: module.exports, console, setTimeout, clearTimeout, Uint8Array, ArrayBuffer }, { timeout: 10_000 });
  return { library: module.exports, console };
}

async function exercise(library) {
  const original = Buffer.from(makePdf());
  // Insert a real unused PDF number object; replace its rounded value without moving xrefs.
  const source = await library.PDFDocument.load(original, { updateMetadata: false });
  source.context.assign(library.PDFRef.of(50), library.PDFNumber.of(Number(marker)));
  const bytes = await source.save({ useObjectStreams: false, updateFieldAppearances: false });
  const data = Buffer.from(bytes).toString("latin1");
  const numeric = data.replace(/50 0 obj\s+[\d.e+]+\s+endobj/, `50 0 obj\n${marker}\nendobj`);
  expect(numeric.length).toBe(data.length);
  expect(numeric).toContain(marker);
  const parsed = await library.PDFDocument.load(new Uint8Array(Buffer.from(numeric, "latin1")), { updateMetadata: false, throwOnInvalidObject: true });
  const output = await library.PDFDocument.create({ updateMetadata: false });
  const [page] = await output.copyPages(parsed, parsed.getPageIndices().slice(0, 1));
  page.setRotation(library.degrees(90)); output.addPage(page);
  const result = await output.save({ updateFieldAppearances: false });
  const task = getDocument({ data: result.slice(), verbosity: 0, useWorkerFetch: false,
    standardFontDataUrl: join(pdfjsRoot, "standard_fonts").replaceAll("\\", "/") + "/" });
  try {
    const doc = await task.promise;
    expect(doc.numPages).toBe(1);
    const actual = await doc.getPage(1);
    expect(actual.rotate).toBe(90);
    expect((await actual.getTextContent()).items.some((item) => item.str === "PAGENEST SYNTHETIC")).toBe(true);
    const viewport = actual.getViewport({ scale: 0.25 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    try {
      await actual.render({ canvas, viewport }).promise;
      const pixel = canvas.getContext("2d").getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
      expect([...pixel]).toEqual([38, 102, 217, 255]);
    } finally { canvas.width = canvas.height = 1; }
  } finally { await task.destroy(); }
}

describe("pdf-lib private diagnostics transforms", () => {
  it("matches only audited installed package files, including Windows and POSIX separators", async () => {
    const path = join(root, "es/core/parser/BaseParser.js");
    expect(isPdfLibDiagnosticModule(path.replaceAll("\\", "/"))).toBe(true);
    expect(isPdfLibDiagnosticModule(path.replaceAll("/", "\\") + "?v=test")).toBe(true);
    expect(isPdfLibDiagnosticModule(join(root, "es/core/parser/PDFObjectParser.js"))).toBe(false);
    expect(isPdfLibDiagnosticModule("/unrelated/node_modules/pdf-lib/es/core/parser/BaseParser.js")).toBe(false);
    const appCode = "console.warn('application diagnostic');";
    expect(await stripPdfLibDiagnostics(appCode, "/src/app.js")).toBeNull();
    const transformed = await stripPdfLibDiagnostics("let result = 0; console.warn('private'); result += 1; export { result };", path);
    expect(transformed.code).not.toContain("console");
    expect(transformed.code).toContain("result += 1");
  });

  it("covers every executable console call in the locked ES/CJS package", async () => {
    async function inspect(directory) {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isDirectory()) await inspect(path);
        else if (item.name.endsWith(".js") && /^\s*console\.[a-z]+\(/m.test(await readFile(path, "utf8"))) {
          expect(isPdfLibDiagnosticModule(path), path).toBe(true);
        }
      }
    }
    await inspect(join(root, "es")); await inspect(join(root, "cjs"));
  });

  it("leaves application console calls intact in the configured development optimizer", async () => {
    const config = pdfLibDiagnostics().config();
    const built = await bundle({ stdin: { contents: "console.warn('APPLICATION ONLY'); module.exports = {};", resolveDir: root },
      bundle: true, write: false, format: "cjs", platform: "browser", plugins: config.optimizeDeps.esbuildOptions.plugins });
    const { console } = libraryFrom(built.outputFiles[0].text);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith("APPLICATION ONLY");
  });

  it.each(["development optimizer", "production transform"])("exports a real numeric-marker PDF without private diagnostics through %s", async (mode) => {
    let code;
    if (mode === "development optimizer") {
      const built = await bundle({ entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "browser", plugins: [pdfLibDiagnosticsOptimizer()] });
      code = built.outputFiles[0].text;
    } else {
      const built = await viteBuild({ configFile: false, logLevel: "silent", plugins: [pdfLibDiagnostics()], build: { write: false, minify: false, lib: { entry, formats: ["cjs"], fileName: "synthetic" } } });
      const outputs = Array.isArray(built) ? built.flatMap((item) => item.output) : built.output;
      code = outputs.find((item) => item.type === "chunk" && item.isEntry).code;
    }
    const { library, console } = libraryFrom(code);
    await exercise(library);
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("the synthetic marker reaches the upstream diagnostic without the scoped transform", async () => {
    const built = await bundle({ entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "browser" });
    const { library, console } = libraryFrom(built.outputFiles[0].text);
    await exercise(library);
    expect(console.warn.mock.calls.flat().join(" ")).toContain(marker);
  });
});
