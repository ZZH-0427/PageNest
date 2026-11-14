import { createRequire } from "node:module";
import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { transformWithEsbuild, type Plugin } from "vite";
import type { Plugin as EsbuildPlugin } from "esbuild";

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("pdf-lib/package.json")).replaceAll("\\", "/");
// Audited pdf-lib 1.17.1 diagnostic sites. Their console arguments have no side effects.
// Keep errors/validation logic and every application/other-dependency console intact.
const diagnosticModules = new Set(["es", "cjs"].flatMap((format) => [
  "core/parser/BaseParser.js", "core/parser/PDFParser.js", "core/streams/FlateStream.js",
  "api/PDFDocument.js", "api/form/PDFTextField.js",
].map((file) => `${packageRoot}/${format}/${file}`)));

export function isPdfLibDiagnosticModule(id: string): boolean {
  return diagnosticModules.has(id.replaceAll("\\", "/").split(/[?#]/, 1)[0]);
}

export async function stripPdfLibDiagnostics(code: string, id: string) {
  if (!isPdfLibDiagnosticModule(id)) return null;
  return transformWithEsbuild(code, id, { loader: "js", target: "esnext", drop: ["console"], sourcemap: false });
}

/** Dependency prebundling has its own pipeline and does not use Vite transform hooks. */
export function pdfLibDiagnosticsOptimizer(): EsbuildPlugin {
  return {
    name: "pagenest-pdf-lib-private-diagnostics",
    setup(build) {
      build.onLoad({ filter: /[\\/]pdf-lib[\\/](es|cjs)[\\/].*\.js$/ }, async ({ path }) => {
        if (!isPdfLibDiagnosticModule(path)) return;
        const transformed = await stripPdfLibDiagnostics(await readFile(path, "utf8"), path);
        return { contents: transformed!.code, loader: "js", resolveDir: dirname(path) };
      });
    },
  };
}

/** Remove source-value diagnostics at build time, never by changing global console methods. */
export function pdfLibDiagnostics(): Plugin {
  return {
    name: "pagenest-pdf-lib-private-diagnostics",
    enforce: "pre",
    config: () => ({ optimizeDeps: { esbuildOptions: { plugins: [pdfLibDiagnosticsOptimizer()] } } }),
    transform: stripPdfLibDiagnostics,
  };
}
