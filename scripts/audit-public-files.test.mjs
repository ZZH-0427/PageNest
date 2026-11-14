import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const auditScript = fileURLToPath(
  new URL("./audit-public-files.mjs", import.meta.url),
);
const temporaryBase = realpathSync(tmpdir());
const ignoreRules =
  [
    "AGENTS.md",
    "AGENTS.*.md",
    ".codex/",
    ".env",
    ".env.*",
    "!.env.example",
    "local-data/",
    "temp/",
    "outputs/",
    "logs/",
    "node_modules/",
    "dist/",
  ].join("\n") + "\n";

// Synthetic, assembled only at runtime so no complete credential is committed.
function syntheticCredential() {
  return ["gh", "p_", "S".repeat(40)].join("");
}

function isolatedEnvironment(repo) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_")) delete env[name];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(repo, ".git", "unused-global-config"),
    GIT_ATTR_NOSYSTEM: "1",
  };
}

function withRepository(run) {
  const repo = realpathSync(
    mkdtempSync(join(temporaryBase, "pagenest-audit-test-")),
  );
  const env = isolatedEnvironment(repo);

  function git(args, input) {
    const result = spawnSync("git", ["-C", repo, ...args], {
      input,
      env,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `isolated Git ${args[0]} failed`);
    return result.stdout;
  }

  function write(path, content) {
    const absolutePath = join(repo, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  }

  function scan() {
    const result = spawnSync(
      process.execPath,
      [join(repo, "scripts", "audit-public-files.mjs")],
      {
        cwd: repo,
        env,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    assert.equal(result.error, undefined, "scanner process should launch");
    return { status: result.status, output: result.stdout + result.stderr };
  }

  function stageBlob(path, content, mode = "100644") {
    const oid = git(["hash-object", "-w", "--stdin"], content).trim();
    git(["update-index", "-z", "--index-info"], `${mode} ${oid} 0\t${path}\0`);
    return oid;
  }

  try {
    git(["init", "--quiet", "--initial-branch=main", "--template="]);
    git(["config", "--local", "core.autocrlf", "false"]);
    write(".gitignore", ignoreRules);
    mkdirSync(join(repo, "scripts"), { recursive: true });
    copyFileSync(auditScript, join(repo, "scripts", "audit-public-files.mjs"));
    return run({ repo, git, write, scan, stageBlob });
  } finally {
    // Never recursively remove a computed path without checking its ownership.
    const ownedPath = resolve(repo);
    const ownedRelativePath = relative(temporaryBase, ownedPath);
    assert.ok(
      dirname(ownedPath) === temporaryBase &&
        !ownedRelativePath.startsWith("..") &&
        /^pagenest-audit-test-/.test(basename(ownedPath)),
      "cleanup target must be an owned temporary repository",
    );
    rmSync(ownedPath, { recursive: true, force: true });
  }
}

function expectFailure(result, source, category) {
  assert.equal(result.status, 1, "safety review must reject this candidate");
  if (source) {
    assert.ok(
      result.output.includes(`[${source}]`),
      "report should identify the failing source",
    );
  }
  if (category) {
    assert.ok(
      result.output.includes(category),
      "report should identify the problem category",
    );
  }
}

function expectRedacted(result, value) {
  // Assert a boolean instead of printing captured output in an assertion diff.
  assert.equal(
    result.output.includes(value),
    false,
    "report must not print matching values",
  );
}

test("accepts clean index blobs and untracked public source", () => {
  withRepository(({ git, write, scan }) => {
    write("src/staged.ts", "export const ready = true;\n");
    git([
      "add",
      "--",
      ".gitignore",
      "scripts/audit-public-files.mjs",
      "src/staged.ts",
    ]);
    write("src/untracked.ts", "export const label = 'PageNest';\n");
    const result = scan();
    assert.equal(result.status, 0, "clean source should pass");
    assert.ok(
      result.output.includes("Git index blobs"),
      "success should cover index blobs",
    );
    assert.ok(
      result.output.includes("working-tree candidates"),
      "success should cover working tree",
    );
  });
});

test("rejects a staged credential after the working copy has been cleaned", () => {
  withRepository(({ git, write, scan }) => {
    const credential = syntheticCredential();
    write(
      "src/config.ts",
      `export const token = ${JSON.stringify(credential)};\n`,
    );
    git(["add", "--", "src/config.ts"]);
    write("src/config.ts", "export const token = undefined;\n");
    const result = scan();
    expectFailure(result, "index", "GitHub credential");
    expectRedacted(result, credential);
  });
});

test("rejects a staged credential even when its working file is missing", () => {
  withRepository(({ repo, git, write, scan }) => {
    const credential = syntheticCredential();
    write("src/config.ts", credential);
    git(["add", "--", "src/config.ts"]);
    rmSync(join(repo, "src", "config.ts"));
    const result = scan();
    expectFailure(result, "index", "GitHub credential");
    expectRedacted(result, credential);
  });
});

test("continues to reject working-tree credentials when the index is clean", () => {
  withRepository(({ git, write, scan }) => {
    const credential = syntheticCredential();
    write("src/config.ts", "export const token = undefined;\n");
    git(["add", "--", "src/config.ts"]);
    write("src/config.ts", credential);
    const result = scan();
    expectFailure(result, "working tree", "GitHub credential");
    expectRedacted(result, credential);
  });
});

test("continues to review untracked source candidates", () => {
  withRepository(({ write, scan }) => {
    const credential = syntheticCredential();
    write("src/untracked.ts", credential);
    const result = scan();
    expectFailure(result, "working tree", "GitHub credential");
    expectRedacted(result, credential);
  });
});

test("does not treat an obsolete unreferenced blob as part of the upload", () => {
  withRepository(({ git, write, scan }) => {
    write("src/config.ts", syntheticCredential());
    git(["add", "--", "src/config.ts"]);
    write("src/config.ts", "export const token = undefined;\n");
    git(["add", "--", "src/config.ts"]);
    assert.equal(
      scan().status,
      0,
      "only current index content should be reviewed",
    );
  });
});

test("does not scan ignored local-only files that are absent from the index", () => {
  withRepository(({ write, scan }) => {
    for (const path of [
      "AGENTS.md",
      ".codex/notes.txt",
      ".env",
      "local-data/private.txt",
    ]) {
      write(path, syntheticCredential());
    }
    assert.equal(
      scan().status,
      0,
      "ignored private working files must remain outside the candidates",
    );
  });
});

for (const path of [
  "AGENTS.md",
  ".codex/notes.txt",
  ".env",
  "local-data/private.txt",
  "dist/index.html",
]) {
  test(`rejects force-staged local-only path ${path}`, () => {
    withRepository(({ git, write, scan }) => {
      write(path, "synthetic local-only data\n");
      // Intentionally forced only inside this disposable regression repository.
      git(["add", "--force", "--", path]);
      expectFailure(scan(), "index", "local-only or generated file");
    });
  });
}

test("rejects force-staged custom ignored paths after their working copy is cleaned", () => {
  withRepository(({ repo, git, write, scan }) => {
    write(".gitignore", ignoreRules + "private-cache.txt\n");
    write("private-cache.txt", "synthetic ignored cache\n");
    git(["add", "--force", "--", "private-cache.txt"]);
    rmSync(join(repo, "private-cache.txt"));
    expectFailure(scan(), "index", "ignored");
  });
});

for (const [path, category] of [
  ["certificates/server.key", "local-only or generated file"],
  ["notes/state.sqlite", "local-only or generated file"],
  ["unreviewed.pdf", "document outside reviewed synthetic fixtures"],
]) {
  test(`rejects ordinary staged blacklisted path ${path}`, () => {
    withRepository(({ git, write, scan }) => {
      write(path, "synthetic non-private content\n");
      git(["add", "--", path]);
      expectFailure(scan(), "index", category);
    });
  });
}

test("rejects index symlinks even if their working copy is a regular file", () => {
  withRepository(({ write, scan, stageBlob }) => {
    stageBlob("src/link.ts", "../local-data/example.txt", "120000");
    write("src/link.ts", "export const safe = true;\n");
    expectFailure(scan(), "index", "unexpected link or non-file entry");
  });
});

test("rejects unresolved merge entries instead of silently choosing a blob", () => {
  withRepository(({ git, write, scan }) => {
    const oid = git(
      ["hash-object", "-w", "--stdin"],
      "synthetic safe content\n",
    ).trim();
    const entries = [1, 2, 3]
      .map((stage) => `100644 ${oid} ${stage}\tsrc/conflict.ts\0`)
      .join("");
    git(["update-index", "-z", "--index-info"], entries);
    write("src/conflict.ts", "export const safe = true;\n");
    expectFailure(scan(), "index", "unmerged Git index entry");
  });
});

test("checks staged blob size independently from a smaller working file", () => {
  withRepository(({ git, write, scan }) => {
    write("src/large.txt", Buffer.alloc(5 * 1024 * 1024 + 1, "x"));
    git(["add", "--", "src/large.txt"]);
    write("src/large.txt", "small working copy\n");
    expectFailure(scan(), "index", "5 MiB");
  });
});

test("rejects unexpected binary index content independently from the working copy", () => {
  withRepository(({ git, write, scan }) => {
    write("src/unexpected.bin", Buffer.from([0, 1, 2, 3]));
    git(["add", "--", "src/unexpected.bin"]);
    write("src/unexpected.bin", "safe working copy\n");
    expectFailure(scan(), "index", "unexpected binary file");
  });
});

test("accepts clean public binary assets", () => {
  withRepository(({ git, write, scan }) => {
    const tinyImage = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ9kAAAAASUVORK5CYII=",
      "base64",
    );
    write("public/pixel.png", tinyImage);
    git(["add", "--", "public/pixel.png"]);
    assert.equal(
      scan().status,
      0,
      "reviewed asset paths should allow binary bytes",
    );
  });
});

test("does not exempt allowed binary assets from staged credential scanning", () => {
  withRepository(({ git, write, scan }) => {
    const credential = syntheticCredential();
    write(
      "public/pixel.png",
      Buffer.concat([Buffer.from([0, 1]), Buffer.from(credential)]),
    );
    git(["add", "--", "public/pixel.png"]);
    write("public/pixel.png", Buffer.from([0, 1, 2]));
    const result = scan();
    expectFailure(result, "index", "GitHub credential");
    expectRedacted(result, credential);
  });
});

test("redacts a credential embedded in a reported index path", () => {
  withRepository(({ scan, stageBlob }) => {
    const credential = syntheticCredential();
    stageBlob(`src/${credential}.bin`, Buffer.from([0, 1]));
    const result = scan();
    expectFailure(result, "index", "unexpected binary file");
    expectRedacted(result, credential);
    assert.ok(
      result.output.includes("[redacted]"),
      "sensitive filename segments must be redacted",
    );
  });
});

test("preserves tab and newline index paths while escaping report control characters", () => {
  withRepository(({ git, scan, stageBlob }) => {
    // Index-only creation does not depend on Windows accepting these filenames.
    git(["config", "--local", "core.protectNTFS", "false"]);
    const path = "src/tab\tand\nnewline.bin";
    stageBlob(path, Buffer.from([0, 1]));
    const result = scan();
    expectFailure(result, "index", "unexpected binary file");
    assert.ok(
      result.output.includes(JSON.stringify(path)),
      "reported paths must retain escaped tabs/newlines",
    );
    assert.equal(
      result.output.includes(path),
      false,
      "raw filename control characters must not forge report lines",
    );
  });
});

test("fails closed when the staged blob cannot be read", () => {
  withRepository(({ repo, scan, stageBlob }) => {
    const oid = stageBlob("src/missing.txt", "synthetic safe content\n");
    rmSync(join(repo, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
    const result = scan();
    expectFailure(result, "index", "could not read Git index blob");
    assert.equal(
      result.output.includes("fatal:"),
      false,
      "raw Git errors must not be echoed",
    );
  });
});

test("rejects missing required local-only ignore rules", () => {
  withRepository(({ write, scan }) => {
    write(".gitignore", "node_modules/\n");
    expectFailure(scan(), "ignore rules", "required ignore rule missing");
  });
});

test("the regression source itself contains no complete synthetic credential", () => {
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.equal(
    source.includes(syntheticCredential()),
    false,
    "test fixtures must be assembled at runtime",
  );
});
