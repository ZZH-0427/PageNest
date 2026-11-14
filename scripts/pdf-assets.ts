import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import type { Plugin } from "vite";

/** Serve and emit the assets from the same installed package as the parser/worker. */
export function pdfAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("pdfjs-dist/package.json"));
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const assets = new Map<string, Buffer>();
  for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.isFile()) assets.set(`pdfjs/${version}/${directory}/${entry.name}`, readFileSync(join(root, directory, entry.name)));
    }
  }
  assets.set(`pdfjs/${version}/LICENSE`, readFileSync(join(root, "LICENSE")));
  return {
    name: "pagenest-local-pdf-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url?.split("?")[0] ?? "";
        const base = server.config.base;
        const path = url.startsWith(base) ? url.slice(base.length) : url.replace(/^\//, "");
        const content = assets.get(path);
        if (!content) { next(); return; }
        const type = path.endsWith(".wasm") ? "application/wasm" : path.endsWith(".js") ? "text/javascript" : "application/octet-stream";
        response.setHeader("Content-Type", type);
        response.end(content);
      });
    },
    generateBundle() {
      for (const [fileName, source] of assets) this.emitFile({ type: "asset", fileName, source });
    },
  };
}
