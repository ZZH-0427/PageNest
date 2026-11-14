import { describe, expect, it } from "vitest";
import {
  fileToMetadata,
  formatBytes,
  MAX_FILES,
  MAX_FILE_SIZE,
  mergeFiles,
} from "./files";
import type { LocalFile } from "../types";

const metadata = (
  name: string,
  overrides: Partial<LocalFile> = {},
): LocalFile => ({
  id: name,
  name,
  size: 1024,
  type: "application/pdf",
  lastModified: 1,
  ...overrides,
});

describe("local file metadata", () => {
  it("extracts metadata without retaining the file or its bytes", () => {
    const file = new File(["private document text"], "example.pdf", {
      type: "application/pdf",
      lastModified: 123,
    });
    const result = fileToMetadata(file);
    expect(result).toEqual({
      id: expect.any(String),
      name: "example.pdf",
      size: file.size,
      type: "application/pdf",
      lastModified: 123,
    });
    expect(Object.values(result)).not.toContain(file);
  });

  it("accepts supported file extensions case-insensitively", () => {
    const result = mergeFiles(
      [],
      ["report.PDF", "slides.pptx", "table.xlsx", "scan.TIFF"].map((name) =>
        metadata(name),
      ),
    );
    expect(result.files).toHaveLength(4);
    expect(result.error).toBeNull();
  });

  it("rejects unsupported and oversized files with explicit feedback", () => {
    const result = mergeFiles(
      [],
      [
        metadata("program.exe"),
        metadata("large.pdf", { size: MAX_FILE_SIZE + 1 }),
      ],
    );
    expect(result.files).toHaveLength(0);
    expect(result.error).toContain("格式暂不支持");
    expect(result.error).toContain("100 MB");
  });

  it("accepts exactly 100 MB and deduplicates by name, size and modified date", () => {
    const file = metadata("report.pdf", { size: MAX_FILE_SIZE });
    const result = mergeFiles(
      [file],
      [file, metadata("report.pdf", { lastModified: 2 })],
    );
    expect(result.files).toHaveLength(2);
    expect(result.error).toContain("重复文件");
  });

  it("retains at most 20 files and reports skipped extras", () => {
    const result = mergeFiles(
      [],
      Array.from({ length: MAX_FILES + 2 }, (_, index) =>
        metadata(`${index}.pdf`),
      ),
    );
    expect(result.files).toHaveLength(MAX_FILES);
    expect(result.error).toContain("另有 2 个文件未添加");
  });

  it("formats file sizes consistently", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1.5 * 1024 ** 2)).toBe("1.5 MB");
  });
});
