/** Real PDF.js parsing/rendering regression tests; no document or canvas mocks. */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  createPdfFixtures,
  makePdf,
  mixedPages,
} from "../src/test/fixtures/synthetic/pdf-fixtures.mjs";

const assets = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
const assetDirectory = (name) => join(assets, name).replaceAll("\\", "/") + "/";

function load(data, extra = {}) {
  return getDocument({
    data,
    verbosity: 0,
    isEvalSupported: false,
    useWorkerFetch: false,
    cMapUrl: assetDirectory("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: assetDirectory("standard_fonts"),
    wasmUrl: assetDirectory("wasm"),
    ...extra,
  });
}

async function withDocument(data, callback, options) {
  const task = load(data, options);
  try {
    return await callback(await task.promise, task);
  } finally {
    await task.destroy();
    assert.equal(task.destroyed, true);
  }
}

async function renderPage(page) {
  const natural = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: 240 / Math.max(natural.width, natural.height) });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  try {
    await page.render({ canvas, viewport }).promise;
    const context = canvas.getContext("2d");
    // The middle of the synthetic vector panel is independent of fonts or DPI.
    return [...context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data];
  } finally {
    canvas.width = 1;
    canvas.height = 1;
    assert.equal(page.cleanup(), true);
  }
}

test("real PDF.js parses a single synthetic page and paints its actual blue artwork", async () => {
  await withDocument(makePdf(), async (document) => {
    assert.equal(document.numPages, 1);
    const page = await document.getPage(1);
    const text = await page.getTextContent();
    assert.ok(text.items.some((item) => item.str === "PAGENEST SYNTHETIC"));
    assert.deepEqual(await renderPage(page), [38, 102, 217, 255]);
  });
});

test("real multipage dimensions respect landscape media boxes and PDF rotation", async () => {
  await withDocument(makePdf({ pages: mixedPages }), async (document) => {
    assert.equal(document.numPages, 3);
    const expected = [[420, 594, 0], [594, 420, 0], [594, 420, 90]];
    for (let index = 0; index < expected.length; index++) {
      const page = await document.getPage(index + 1);
      const view = page.getViewport({ scale: 1 });
      assert.deepEqual([view.width, view.height, page.rotate], expected[index]);
      assert.deepEqual(await renderPage(page), [38, 102, 217, 255]);
    }
  });
});

test("a 100-page PDF yields the real final page without rendering earlier pages", async () => {
  const fixture = createPdfFixtures().find((entry) => entry.path === "many-pages.pdf");
  await withDocument(fixture.data, async (document) => {
    assert.equal(document.numPages, 100);
    const last = await document.getPage(100);
    assert.equal(last.pageNumber, 100);
    const text = await last.getTextContent();
    assert.ok(text.items.some((item) => item.str === "PAGE 100"));
    assert.deepEqual(await renderPage(last), [38, 102, 217, 255]);
  });
});

test("documents sharing a basename retain independent page counts and rendered content", async () => {
  const fixtures = createPdfFixtures().filter((entry) => entry.path.endsWith("shared.pdf"));
  const results = await Promise.all(fixtures.map((fixture) =>
    withDocument(fixture.data, async (document) => ({
      pages: document.numPages,
      pixel: await renderPage(await document.getPage(1)),
    })),
  ));
  assert.deepEqual(results, [
    { pages: 1, pixel: [38, 102, 217, 255] },
    { pages: 3, pixel: [224, 102, 31, 255] },
  ]);
});

for (const name of ["damaged.pdf", "disguised.pdf", "empty.pdf"]) {
  test(`real PDF.js rejects the artificial ${name} fixture`, async () => {
    const fixture = createPdfFixtures().find((entry) => entry.path === name);
    const task = load(fixture.data);
    try {
      await assert.rejects(task.promise, { name: "InvalidPDFException" });
    } finally {
      await task.destroy();
    }
  });
}

test("an encrypted PDF rejects absent credentials with a structured password error", async () => {
  const task = load(makePdf({ encrypted: true }));
  try {
    await assert.rejects(task.promise, { name: "PasswordException", code: 1 });
  } finally {
    await task.destroy();
  }
});

test("the encrypted fixture is a valid PDF, not a fake password marker", async () => {
  // The application deliberately does not implement this password entry flow.
  await withDocument(makePdf({ encrypted: true }), async (document) => {
    assert.equal(document.numPages, 1);
    assert.deepEqual(await renderPage(await document.getPage(1)), [38, 102, 217, 255]);
  }, { password: "demo" });
});

test("a cancelled real render rejects cleanly and allows a later successful render", async () => {
  await withDocument(makePdf(), async (document) => {
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const rendering = page.render({ canvas, viewport });
    const rejected = assert.rejects(rendering.promise, { name: "RenderingCancelledException" });
    rendering.cancel();
    await rejected;
    canvas.width = canvas.height = 1;
    // PDF.js may defer cleanup while the operator list is still arriving.
    // The successful follow-up render and final loadingTask.destroy() settle it.
    page.cleanup();
    assert.deepEqual(await renderPage(page), [38, 102, 217, 255]);
  });
});

test("destroying a loading task aborts parsing and releases the task", async () => {
  const task = load(makePdf({ pages: Array.from({ length: 100 }, () => mixedPages[0]) }));
  const rejected = assert.rejects(task.promise);
  await task.destroy();
  await rejected;
  assert.equal(task.destroyed, true);
});

test("in-memory parsing and rendering never fetch or upload the document", async (context) => {
  const network = context.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected network request during a local PDF test");
  });
  await withDocument(makePdf(), async (document) => {
    assert.deepEqual(await renderPage(await document.getPage(1)), [38, 102, 217, 255]);
  });
  assert.equal(network.mock.callCount(), 0);
});

// Node uses PDF.js's Node execution backend. The browser's real module Worker
// and /PageNest/ resource paths must additionally be verified in a browser.
