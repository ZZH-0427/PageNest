import type { LocalFile } from "../types";

export const MAX_FILES = 20;
export const MAX_FILE_SIZE = 100 * 1024 * 1024;
export const FILE_ACCEPT =
  ".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.png,.jpg,.jpeg,.webp,.tif,.tiff";
const allowedExtensions = new Set(
  FILE_ACCEPT.split(",").map((extension) => extension.slice(1)),
);

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(bytes / 1024 ** index)} ${units[index]}`;
}

export function fileToMetadata(file: File): LocalFile {
  return {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
  };
}

function fileKey(file: LocalFile): string {
  return JSON.stringify([file.name, file.size, file.lastModified]);
}

/** Validates metadata only; content format validation belongs to a future engine. */
export function mergeFiles(current: LocalFile[], incoming: LocalFile[]) {
  const files = [...current];
  const keys = new Set(current.map(fileKey));
  let unsupported = 0;
  let oversized = 0;
  let duplicate = 0;
  let overflow = 0;

  for (const file of incoming) {
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!file.name.includes(".") || !allowedExtensions.has(extension)) {
      unsupported += 1;
      continue;
    }
    if (file.size > MAX_FILE_SIZE) {
      oversized += 1;
      continue;
    }
    const key = fileKey(file);
    if (keys.has(key)) {
      duplicate += 1;
      continue;
    }
    if (files.length >= MAX_FILES) {
      overflow += 1;
      continue;
    }
    keys.add(key);
    files.push(file);
  }

  const messages = [
    unsupported
      ? `${unsupported} 个文件格式暂不支持，请选择 PDF、Office 文档或常见图片。`
      : "",
    oversized ? `${oversized} 个文件超过单文件 100 MB 限制，未添加。` : "",
    duplicate ? `${duplicate} 个重复文件已跳过。` : "",
    overflow
      ? `最多保留 ${MAX_FILES} 个文件，另有 ${overflow} 个文件未添加。`
      : "",
  ].filter(Boolean);

  return { files, error: messages.length ? messages.join(" ") : null };
}
