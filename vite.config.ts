import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { pdfAssets } from "./scripts/pdf-assets";
import { pdfLibDiagnostics } from "./scripts/pdf-lib-diagnostics";

export default defineConfig({
  base: "/PageNest/",
  plugins: [react(), tailwindcss(), pdfAssets(), pdfLibDiagnostics()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    clearMocks: true,
    css: false,
  },
});
