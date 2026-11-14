import type { ProcessingTask, ToolId } from "../types";

export type EngineStatus =
  | "not-configured"
  | "connecting"
  | "ready"
  | "unavailable";

/** Integration contract only. GitHub Pages cannot run the optional local engine. */
export interface LocalEngine {
  getStatus: () => Promise<EngineStatus>;
  getCapabilities: () => Promise<ToolId[]>;
  cancelTask: (id: ProcessingTask["id"]) => Promise<void>;
}

export const localEngineStatus: EngineStatus = "not-configured";

export const engineAvailability = {
  browser: { available: false, label: "浏览器处理能力尚未接入" },
  local: { available: false, label: "Windows 本地引擎尚未接入" },
} as const;
