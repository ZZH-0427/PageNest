import { useEffect, useState, useSyncExternalStore } from "react";
import { PdfCompressionController } from "./controller";
import { runCompression } from "./engine";
import { COMPRESSION_MODES, type CompressionMode } from "./types";

function availableModes(): readonly CompressionMode[] {
  if (typeof Worker !== "function" || typeof CompressionStream !== "function" || typeof DecompressionStream !== "function") return [];
  return typeof OffscreenCanvas === "function" && typeof createImageBitmap === "function" ? COMPRESSION_MODES : ["lossless"];
}

export function usePdfCompression() {
  const [controller] = useState(() => new PdfCompressionController(runCompression, undefined, availableModes()));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller]);
  return { controller, state };
}
