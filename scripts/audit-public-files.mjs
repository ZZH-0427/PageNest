import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const findings = [];
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const forbiddenDirectory =
  /(^|\/)(?:\.codex|\.agents|\.openai|node_modules|dist|build|coverage|local-data|temp|tmp|outputs|logs|\.venv|venv|__pycache__|\.cache|\.vite|test-results|playwright-report)(?:\/|$)/i;
const forbiddenFile =
  /(?:^|\/)(?:AGENTS(?:\.[^/]*)?\.md|\.npmrc|\.env(?:\.(?!example$)[^/]*)?|(?:npm|yarn)-debug\.log[^/]*|Thumbs\.db|Desktop\.ini|\.DS_Store)$|\.(?:pem|key|p12|pfx|crt|db|sqlite\d*|log|tsbuildinfo|pyc|pyo)$/i;
const documentExtension = /\.(?:pdf|docx?|pptx?|xlsx?|odt|odp|ods|rtf)$/i;
const syntheticFixture = /^(?:(?:tests?|src\/test)\/fixtures\/synthetic)\//;
const publicBinaryAsset =
  /^(?:public|src\/assets)\/.*\.(?:png|jpe?g|webp|avif|gif|ico|woff2?)$/i;
const secretPatterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  [
    "GitHub credential",
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  ],
  ["API credential", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  [
    "embedded credential",
    /(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["'][^"'\r\n]{8,}["']/i,
  ],
  ["credential in URL", /https?:\/\/[^/\s:@]+:[^@\s/]+@/i],
  [
    "private local path",
    /(?:[A-Za-z]:\\(?:Users|GoodIdea)\\|\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/)/,
  ],
];

function git(args, encoding = "utf8") {
  return execFileSync("git", ["-C", root, ...args], {
    encoding,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  });
}

function report(source, path, reason) {
  findings.push({ source, path, reason });
}

function isIgnored(path) {
  try {
    git(["check-ignore", "--quiet", "--no-index", "--", path]);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function reviewPath(source, path) {
  if (forbiddenDirectory.test(path) || forbiddenFile.test(path)) {
    report(source, path, "local-only or generated file");
    return false;
  }
  if (documentExtension.test(path) && !syntheticFixture.test(path)) {
    report(source, path, "document outside reviewed synthetic fixtures");
    return false;
  }
  return true;
}

function reviewContent(source, path, content) {
  if (
    content.includes(0) &&
    !publicBinaryAsset.test(path) &&
    !(documentExtension.test(path) && syntheticFixture.test(path))
  ) {
    report(source, path, "unexpected binary file");
  }
  // A permitted asset is not exempt from credential detection in its bytes.
  const text = content.toString("utf8");
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(text)) report(source, path, label);
  }
}

function reviewIndex() {
  // NUL framing preserves spaces, tabs and newlines in repository paths.
  const records = git(["ls-files", "--stage", "-z"])
    .split("\0")
    .filter(Boolean);
  let checked = 0;
  for (const record of records) {
    const entry = /^([0-7]{6}) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(record);
    if (!entry) throw new Error("Invalid Git index metadata");
    const [, mode, oid, stage, path] = entry;
    if (!reviewPath("index", path)) continue;
    if (isIgnored(path)) {
      report("index", path, "ignored file present in Git index");
      continue;
    }
    if (stage !== "0") {
      report("index", path, "unmerged Git index entry");
      continue;
    }
    if (mode !== "100644" && mode !== "100755") {
      report("index", path, "unexpected link or non-file entry");
      continue;
    }
    try {
      const size = Number(git(["cat-file", "-s", oid]).trim());
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error("Invalid Git blob size");
      }
      if (size > MAX_FILE_BYTES) {
        report("index", path, "file exceeds the 5 MiB review limit");
        continue;
      }
      // Read the object selected by the index, never the working-tree version.
      const blob = git(["cat-file", "blob", oid], null);
      if (blob.length !== size) throw new Error("Git blob size mismatch");
      reviewContent("index", path, blob);
      checked += 1;
    } catch {
      // Git stderr can include sensitive paths or object data. Do not echo it.
      report("index", path, "could not read Git index blob");
    }
  }
  return checked;
}

function reviewWorkingTree() {
  const candidates = [
    ...new Set(
      git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter(Boolean),
    ),
  ];
  for (const path of candidates) {
    if (!reviewPath("working tree", path)) continue;
    try {
      // Reject symlinks in every path component, including ancestor folders.
      let absolutePath = root;
      let metadata;
      for (const component of path.split("/")) {
        absolutePath = resolve(absolutePath, component);
        metadata = lstatSync(absolutePath);
        if (metadata.isSymbolicLink()) break;
      }
      if (!metadata?.isFile() || metadata.isSymbolicLink()) {
        report("working tree", path, "unexpected link or non-file candidate");
        continue;
      }
      if (metadata.size > MAX_FILE_BYTES) {
        report("working tree", path, "file exceeds the 5 MiB review limit");
        continue;
      }
      const content = readFileSync(absolutePath);
      if (content.length > MAX_FILE_BYTES) {
        report("working tree", path, "file exceeds the 5 MiB review limit");
        continue;
      }
      reviewContent("working tree", path, content);
    } catch (error) {
      // A missing working file cannot hide its independently checked index blob.
      if (error.code !== "ENOENT") {
        report("working tree", path, "could not read working-tree file");
      }
    }
  }
  return candidates.length;
}

function displayPath(path) {
  let redacted = path;
  for (const [, pattern] of secretPatterns) {
    redacted = redacted.replace(
      new RegExp(pattern.source, `${pattern.flags}g`),
      "[redacted]",
    );
  }
  // Escape control characters to prevent filenames forging extra report lines.
  return JSON.stringify(redacted);
}

try {
  for (const path of ["AGENTS.md", ".codex/audit-probe"]) {
    try {
      git(["check-ignore", "--quiet", "--no-index", path]);
    } catch {
      report("ignore rules", path, "required ignore rule missing");
    }
  }
  const indexCount = reviewIndex();
  const candidateCount = reviewWorkingTree();
  if (findings.length > 0) {
    console.error(
      "Public file review failed. Only sources, redacted paths and categories are reported:",
    );
    for (const { source, path, reason } of findings) {
      console.error(`- [${source}] ${displayPath(path)}: ${reason}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `Public file review passed: ${indexCount} Git index blobs and ${candidateCount} working-tree candidates checked.`,
    );
    console.log(
      "Heuristic scan only; manually review the exact staged diff before any upload.",
    );
  }
} catch {
  console.error(
    "Public file review could not run. Check Git availability and repository/index access.",
  );
  process.exitCode = 1;
}
