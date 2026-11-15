import { createEditState, deleteEditSelection, moveEditPage, redoEdit, rotateEditSelection, selectEditPage, undoEdit } from "./edit";
import { sanitizePdfFilename } from "./export";
import { buildCurrentPlan, buildSelectionPlan, buildMergePlan, buildSplitPlan, snapshotOutputPlan, validateOutputPlan,
  MAX_PLAN_INPUT_BYTES, MAX_PLAN_OUTPUT_BYTES, type PdfOutputPlan } from "./output-plan";
import { MAX_PDF_FILE_BYTES, PdfUserError, type PdfFileEntry, type PdfPageInfo } from "./types";

function entry(id = "document-a", count = 5, name = "same.pdf"): PdfFileEntry {
  const pages: PdfPageInfo[] = Array.from({ length: count }, (_, index) => ({ number: index + 1,
    width: 420, height: 594, rotation: 0, orientation: "portrait" }));
  return { id, name, size: 1024, ordinal: 1, status: "ready", pages, edit: createEditState(id, pages), selectedPage: 1, error: null };
}
const order = (file: PdfFileEntry, numbers: number[]) => {
  file.edit!.present.pages = numbers.map((number) => file.edit!.present.pages.find((page) => page.sourcePageNumber === number)!);
  file.edit!.present.selectedIds = [file.edit!.present.pages[0].id];
  return file;
};
function assertFrozen(value: unknown) {
  if (value && typeof value === "object") {
    expect(Object.isFrozen(value)).toBe(true);
    Object.values(value).forEach(assertFrozen);
  }
}

test.each([[3], [2, 3, 4], [5, 1, 3], [5, 4, 3, 2, 1]].map((selected) => ({ selected })))("exports selected source pages in current order, independent of click order: $selected", ({ selected }) => {
  const file = entry();
  file.edit!.present.selectedIds = selected.map((number) => file.edit!.present.pages[number - 1].id);
  expect(buildSelectionPlan(file).outputs[0].pages.map((page) => page.sourcePageNumber)).toEqual([...selected].sort((a, b) => a - b));
});

test("selection after delete/reorder/rotate and undo/redo captures exactly the current stable pages", () => {
  const file = entry();
  let edit = selectEditPage(file.edit!, file.edit!.present.pages[1].id);
  edit = deleteEditSelection(edit);
  edit = moveEditPage(edit, edit.present.pages.at(-1)!.id, 0);
  expect(edit.present.pages.map((page) => page.sourcePageNumber)).toEqual([5, 1, 3, 4]);
  edit = selectEditPage(edit, edit.present.pages[2].id);
  edit = selectEditPage(edit, edit.present.pages[0].id, { toggle: true });
  edit = rotateEditSelection(edit, 90);
  file.edit = edit;
  const before = structuredClone(file);
  const planned = buildSelectionPlan(file);
  expect(planned.outputs[0].pages.map((page) => [page.sourcePageNumber, page.rotationDelta])).toEqual([[5, 90], [3, 90]]);
  expect(planned.outputs[0].rangeLabel).toBe("1, 3");
  expect(file).toEqual(before);
  file.edit = undoEdit(edit);
  expect(buildSelectionPlan(file).outputs[0].pages.every((page) => page.rotationDelta === 0)).toBe(true);
  file.edit = redoEdit(file.edit);
  expect(buildSelectionPlan(file)).toEqual(planned);
});

test("current export ignores selection and preserves current edited order", () => {
  const file = order(entry(), [5, 1, 3, 4]);
  file.edit!.present.selectedIds = [];
  const plan = buildCurrentPlan(file);
  expect(plan.mode).toBe("current");
  expect(plan.outputs[0].pages.map((page) => page.sourcePageNumber)).toEqual([5, 1, 3, 4]);
  expect(plan.outputs[0].rangeLabel).toBe("1-4");
});

test("merge binds same-name sources by ID and follows both document order and edited page order", () => {
  const first = order(entry("a", 3), [3, 1, 2]);
  const second = order(entry("b", 2), [2, 1]);
  const third = entry("c", 1);
  second.pages[1] = { number: 2, width: 594, height: 420, rotation: 90, orientation: "landscape" };
  second.edit!.present.pages[0].originalRotation = 90;
  second.edit!.present.pages[0].rotationDelta = 270;
  const before = structuredClone([first, second, third]);
  const plan = buildMergePlan([first, second, third], ["b", "a", "c"], "../merged:review.pdf");
  expect(plan.sources.map((source) => source.documentId)).toEqual(["b", "a", "c"]);
  expect(plan.outputs[0].pages.map((page) => `${page.sourceDocumentId}${page.sourcePageNumber}`)).toEqual(["b2", "b1", "a3", "a1", "a2", "c1"]);
  expect(plan.outputs[0].pages[0]).toMatchObject({ originalRotation: 90, rotationDelta: 270 });
  expect(plan.outputs[0].fileName).toBe(sanitizePdfFilename("../merged:review.pdf"));
  expect([first, second, third]).toEqual(before);
});

test("custom split addresses current numbers, keeps explicit chunk order and maps back to sources", () => {
  const file = order(entry(), [5, 1, 3, 4]);
  file.edit!.present.pages[0].rotationDelta = 90;
  const plan = buildSplitPlan(file, { kind: "ranges", ranges: "3-4,1" }, "review.pdf");
  expect(plan.outputs.map((output) => output.pages.map((page) => page.sourcePageNumber))).toEqual([[3, 4], [5]]);
  expect(plan.outputs.map((output) => output.rangeLabel)).toEqual(["3-4", "1"]);
  expect(plan.outputs.map((output) => output.fileName)).toEqual(["review_part-01.pdf", "review_part-02.pdf"]);
  expect(plan.outputs[1].pages[0].rotationDelta).toBe(90);
  expect(() => buildSplitPlan(file, { kind: "ranges", ranges: "1-3,3" })).toThrow("重复或重叠");
});

test("every-N split of 24 pages creates complete 5/5/5/5/4 chunks with unique sanitized names", () => {
  const file = entry("a", 24);
  const plan = buildSplitPlan(file, { kind: "every", every: 5 }, "😀".repeat(200) + "../name.pdf");
  expect(plan.outputs.map((output) => output.pages.length)).toEqual([5, 5, 5, 5, 4]);
  expect(plan.outputs.map((output) => output.rangeLabel)).toEqual(["1-5", "6-10", "11-15", "16-20", "21-24"]);
  expect(plan.outputs.flatMap((output) => output.pages.map((page) => page.sourcePageNumber))).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
  expect(new Set(plan.outputs.map((output) => output.fileName)).size).toBe(5);
  plan.outputs.forEach((output, index) => {
    expect(output.fileName).toBe(sanitizePdfFilename(output.fileName));
    expect(output.fileName).toContain(`_part-0${index + 1}.pdf`);
    expect(Array.from(output.fileName.slice(0, -4)).length).toBeLessThanOrEqual(120);
  });
});

test("freezes detached copies of every nested item and never retains the File, bytes or history", () => {
  const file = entry();
  Object.assign(file, { sourceFile: new File(["Synthetic"], "private.pdf"), bytes: new Uint8Array([1, 2, 3]) });
  const plan = buildCurrentPlan(file);
  assertFrozen(plan);
  expect(Object.keys(plan.sources[0]).sort()).toEqual(["documentId", "name", "originalPages", "size"]);
  expect(Object.keys(plan.outputs[0].pages[0]).sort()).toEqual(["id", "originalRotation", "rotationDelta", "sourceDocumentId", "sourcePageNumber"]);
  expect(plan.sources[0].originalPages[0]).not.toBe(file.pages[0]);
  expect(plan.outputs[0].pages[0]).not.toBe(file.edit!.present.pages[0]);
  file.pages[0].width = 999;
  file.edit!.present.pages[0].rotationDelta = 180;
  file.edit!.present.pages.reverse();
  file.name = "changed.pdf";
  expect(plan.sources[0].name).toBe("same.pdf");
  expect(plan.sources[0].originalPages[0].width).toBe(420);
  expect(plan.outputs[0].pages[0]).toMatchObject({ sourcePageNumber: 1, rotationDelta: 0 });
  const recaptured = snapshotOutputPlan(plan);
  expect(recaptured).toEqual(plan);
  expect(recaptured).not.toBe(plan);
  expect(recaptured.outputs[0].pages[0]).not.toBe(plan.outputs[0].pages[0]);
  assertFrozen(recaptured);
});

test("enforces exact input budget, total pages, per-source capacity and output count", () => {
  const a = entry("a", 500); a.size = 64 * 1024 ** 2;
  const b = entry("b", 500); b.size = 64 * 1024 ** 2;
  expect(buildMergePlan([a, b], ["a", "b"]).outputs[0].pages).toHaveLength(1000);
  expect(a.size + b.size).toBe(MAX_PLAN_INPUT_BYTES);
  b.size++;
  expect(() => buildMergePlan([a, b], ["a", "b"])).toThrow("128 MiB");
  b.size--;
  expect(() => buildMergePlan([a, entry("c", 501)], ["a", "c"])).toThrow("1000");
  a.size = MAX_PDF_FILE_BYTES + 1;
  expect(() => buildCurrentPlan(a)).toThrow(PdfUserError);
  expect(buildSplitPlan(entry("c", 1000), { kind: "every", every: 20 }).outputs).toHaveLength(50);
  expect(() => buildSplitPlan(entry("c", 1000), { kind: "every", every: 19 })).toThrow("50");
  expect(MAX_PLAN_OUTPUT_BYTES).toBe(100 * 1024 ** 2);
});

test("unselected documents do not consume the task's input budget or require ready status", () => {
  const other = entry("other"); other.size = MAX_PDF_FILE_BYTES; other.status = "parsing";
  expect(buildMergePlan([entry("a"), other, entry("b")], ["a", "b"]).sources).toHaveLength(2);
  expect(() => buildMergePlan([entry("a"), other], ["a", "other"])).toThrow(PdfUserError);
});

test("rejects empty selection, stale/duplicate IDs and ambiguous merge sources", () => {
  const file = entry();
  file.edit!.present.selectedIds = [];
  expect(() => buildSelectionPlan(file)).toThrow("至少一页");
  file.edit!.present.selectedIds = ["missing"];
  expect(() => buildSelectionPlan(file)).toThrow(PdfUserError);
  file.edit!.present.selectedIds = [file.edit!.present.pages[0].id, file.edit!.present.pages[0].id];
  expect(() => buildSelectionPlan(file)).toThrow(PdfUserError);
  expect(() => buildMergePlan([file], [file.id])).toThrow("至少");
  expect(() => buildMergePlan([file], [file.id, file.id])).toThrow(PdfUserError);
  expect(() => buildMergePlan([entry("a"), entry("a"), entry("b")], ["a", "b"])).toThrow(PdfUserError);
});

test.each(["queued", "reading", "parsing", "error"] as const)("rejects a %s source before deriving an output plan", (status) => {
  const file = entry(); file.status = status;
  expect(() => buildCurrentPlan(file)).toThrow(PdfUserError);
  expect(() => buildSelectionPlan(file)).toThrow(PdfUserError);
  expect(() => buildSplitPlan(file, { kind: "every", every: 1 })).toThrow(PdfUserError);
});

test("never returns parser object payloads or their exception text for malformed editor metadata", () => {
  const file = entry();
  Object.defineProperty(file.pages[0], "width", { get() { throw new Error("SYNTHETIC_PRIVATE_METADATA_TEXT"); } });
  try { buildCurrentPlan(file); throw new Error("Expected a rejected plan"); }
  catch (error) {
    expect(error).toBeInstanceOf(PdfUserError);
    expect(String(error)).not.toContain("SYNTHETIC_PRIVATE_METADATA_TEXT");
  }
});

test.each(["empty-output", "wrong-source", "wrong-page", "duplicate-id", "duplicate-page", "wrong-rotation", "bad-geometry", "private-payload", "extra-source", "unsafe-name", "duplicate-name"])("rejects a forged %s plan before snapshotting", (change) => {
  const plan = structuredClone(buildSplitPlan(entry(), { kind: "ranges", ranges: "1,2" })) as {
    mode: PdfOutputPlan["mode"]; sources: { documentId: string; name: string; size: number; originalPages: PdfPageInfo[] }[];
    outputs: { id: string; fileName: string; rangeLabel: string; pages: { id: string; sourceDocumentId: string; sourcePageNumber: number; originalRotation: number; rotationDelta: number }[] }[];
  };
  const first = plan.outputs[0].pages[0];
  if (change === "empty-output") plan.outputs[0].pages = [];
  if (change === "wrong-source") first.sourceDocumentId = "unknown";
  if (change === "wrong-page") first.sourcePageNumber = 99;
  if (change === "duplicate-id") plan.outputs[1].pages[0].id = first.id;
  if (change === "duplicate-page") plan.outputs[1].pages[0].sourcePageNumber = first.sourcePageNumber;
  if (change === "wrong-rotation") first.originalRotation = 90;
  if (change === "bad-geometry") plan.sources[0].originalPages[0].width = Number.NaN;
  if (change === "private-payload") Object.assign(first, { bytes: new Uint8Array([1, 2]) });
  if (change === "extra-source") { plan.mode = "merge"; plan.outputs.length = 1; plan.sources.push({ ...plan.sources[0], documentId: "unused" }); }
  if (change === "unsafe-name") plan.outputs[0].fileName = "../unsafe.pdf";
  if (change === "duplicate-name") plan.outputs[1].fileName = plan.outputs[0].fileName.toUpperCase().replace(".PDF", ".pdf");
  expect(() => validateOutputPlan(plan)).toThrow(PdfUserError);
  expect(() => snapshotOutputPlan(plan)).toThrow(PdfUserError);
});
