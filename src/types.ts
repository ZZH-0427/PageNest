export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = Exclude<Theme, "system">;

/** File metadata lives in memory only. Document bytes and File handles are never retained. */
export interface LocalFile {
  id: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

export type ToolId = "converter" | "compression" | "pdf-editor" | "ocr";
export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Reserved for a real engine. Phase 1 creates no processing tasks. */
export interface ProcessingTask {
  id: string;
  tool: ToolId;
  status: TaskStatus;
  createdAt: string;
  inputFileIds: string[];
  progress?: number;
  error?: string;
}
