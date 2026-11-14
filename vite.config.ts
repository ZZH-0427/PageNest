import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { pdfAssets } from "./scripts/pdf-assets";

export default defineConfig({
  base: "/PageNest/",
  plugins: [react(), tailwindcss(), pdfAssets()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    clearMocks: true,
    css: false,
  },
});
