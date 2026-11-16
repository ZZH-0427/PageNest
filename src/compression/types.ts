export const MAX_COMPRESSION_FILES = 5;
export const MAX_COMPRESSION_FILE_BYTES = 32 * 1024 ** 2;
export const MAX_COMPRESSION_WORKSPACE_BYTES = 96 * 1024 ** 2;
export const MAX_COMPRESSION_PAGES = 200;
export const MAX_COMPRESSION_RESULT_BYTES = 64 * 1024 ** 2;
export const COMPRESSION_TASK_TIMEOUT_MS = 180_000;
export const COMPRESSION_URL_LIFETIME_MS = 60_000;

export const COMPRESSION_MODES = ["lossless", "high", "balanced", "strong"] as const;
export type CompressionMode = (typeof COMPRESSION_MODES)[number];
export type CompressionStage = "reading" | "optimizing" | "validating";
export type CompressionStatus = "queued" | CompressionStage | "ready" | "no-benefit" | "error" | "cancelled";

export interface CompressionResult {
  readonly outputBytes: number;
  readonly savedBytes: number;
  readonly reductionPercent: number;
  readonly fileName: string;
  readonly methods: readonly string[];
  readonly validationLabel: string;
  readonly changedImages: number;
  readonly skippedImages: number;
}

/** Only metadata reaches React. File capabilities, bytes and URLs remain private. */
export interface CompressionRow {
  readonly id: string;
  readonly ordinal: number;
  readonly name: string;
  readonly size: number;
  readonly pageCount: number | null;
  readonly status: CompressionStatus;
  readonly result: CompressionResult | null;
  readonly error: string | null;
}

export interface CompressionState {
  readonly files: readonly CompressionRow[];
  readonly busy: boolean;
  readonly notice: string | null;
  readonly mode: CompressionMode;
  readonly availableModes: readonly CompressionMode[];
}

/** A successful runner has independently validated these transient PDF bytes. */
export interface CompressionRunResult {
  bytes: Uint8Array;
  pageCount: number;
  methods: readonly string[];
  changedImages: number;
  skippedImages: number;
  validationLabel: string;
}

export type CompressionRunner = (
  file: File,
  mode: CompressionMode,
  signal: AbortSignal,
  onStage: (stage: CompressionStage, pageCount?: number) => void,
) => Promise<CompressionRunResult>;

export interface CompressionDownloadEnvironment {
  createUrl(blob: Blob): string;
  revokeUrl(url: string): void;
  trigger(url: string, filename: string): void;
}
