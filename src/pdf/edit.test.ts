import { describe, expect, it } from "vitest";
import {
  clearEditSelection, createEditState, deleteEditSelection, getEditedPageInfo,
  isEdited, MAX_EDIT_HISTORY, moveEditPage, redoEdit, rotateEditSelection,
  selectAllEditPages, selectEditPage, undoEdit, type PdfEditState,
} from "./edit";
import type { PdfPageInfo } from "./types";

function originals(count = 5): PdfPageInfo[] {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1, width: 420, height: 594, rotation: 0, orientation: "portrait",
  }));
}
const source = originals();
const initial = () => createEditState("document-a", source);
const id = (number: number) => `document-a:page:${number}`;
const order = (state: PdfEditState) => state.present.pages.map((page) => page.sourcePageNumber);

describe("stable page selection", () => {
  it("starts with the first page selected and uses independent document IDs", () => {
    const state = initial();
    expect(state.present.selectedIds).toEqual([id(1)]);
    expect(state.present.pages[2]).toEqual({ id: id(3), sourceDocumentId: "document-a", sourcePageNumber: 3, originalRotation: 0, rotationDelta: 0 });
    expect(createEditState("document-b", source).present.pages[0].id).not.toBe(id(1));
  });

  it("replaces a selection with a single page and ignores unknown page IDs", () => {
    const state = selectEditPage(selectAllEditPages(initial()), id(3));
    expect(state.present.selectedIds).toEqual([id(3)]);
    expect(state.present.anchorId).toBe(id(3));
    expect(selectEditPage(state, "unknown")).toBe(state);
    expect(state.past).toEqual([]);
  });

  it("toggles individual pages in current order and can leave an empty selection", () => {
    let state = selectEditPage(initial(), id(4), { toggle: true });
    state = selectEditPage(state, id(2), { toggle: true });
    expect(state.present.selectedIds).toEqual([id(1), id(2), id(4)]);
    for (const number of [1, 2, 4]) state = selectEditPage(state, id(number), { toggle: true });
    expect(state.present.selectedIds).toEqual([]);
    expect(state.past).toHaveLength(0);
  });

  it("selects forward and backward ranges from a stable anchor and supports additive ranges", () => {
    let state = selectEditPage(initial(), id(2));
    state = selectEditPage(state, id(4), { range: true });
    expect(state.present.selectedIds).toEqual([id(2), id(3), id(4)]);
    expect(state.present.anchorId).toBe(id(2));
    state = selectEditPage(state, id(1), { range: true });
    expect(state.present.selectedIds).toEqual([id(1), id(2)]);
    state = selectEditPage(state, id(5), { toggle: true, range: true });
    expect(state.present.selectedIds).toEqual([id(1), id(2), id(3), id(4), id(5)]);
  });

  it("selects all or clears without changing history, and starts a range after Escape", () => {
    const edited = rotateEditSelection(initial(), 90);
    const all = selectAllEditPages(edited);
    expect(all.present.selectedIds).toHaveLength(5);
    expect(all.past).toBe(edited.past);
    expect(selectAllEditPages(all)).toBe(all);
    const empty = clearEditSelection(all);
    expect(empty.present.selectedIds).toEqual([]);
    expect(empty.present.anchorId).toBeNull();
    expect(selectEditPage(empty, id(4), { range: true }).present.selectedIds).toEqual([id(4)]);
  });
});

describe("non-destructive edits", () => {
  it("deletes one page, picks its surviving neighbor, and restores selection on undo", () => {
    const selected = selectEditPage(initial(), id(3));
    const deleted = deleteEditSelection(selected);
    expect(order(deleted)).toEqual([1, 2, 4, 5]);
    expect(deleted.present.selectedIds).toEqual([id(4)]);
    expect(deleted.past).toHaveLength(1);
    expect(undoEdit(deleted).present).toEqual(selected.present);
    expect(redoEdit(undoEdit(deleted)).present).toEqual(deleted.present);
  });

  it("treats a batch delete as one step and handles removal from the tail", () => {
    let selected = selectEditPage(initial(), id(4));
    selected = selectEditPage(selected, id(5), { range: true });
    const deleted = deleteEditSelection(selected);
    expect(order(deleted)).toEqual([1, 2, 3]);
    expect(deleted.present.selectedIds).toEqual([id(3)]);
    expect(deleted.past).toHaveLength(1);
    expect(order(undoEdit(deleted))).toEqual([1, 2, 3, 4, 5]);
  });

  it("protects the last page and rejects deleting every page without adding history", () => {
    const single = createEditState("only", originals(1));
    expect(deleteEditSelection(single)).toBe(single);
    const all = selectAllEditPages(initial());
    expect(deleteEditSelection(all)).toBe(all);
    const none = clearEditSelection(initial());
    expect(deleteEditSelection(none)).toBe(none);
  });

  it("reorders by final index while keeping stable IDs and source mapping", () => {
    const state = initial();
    const moved = moveEditPage(state, id(1), 3);
    expect(order(moved)).toEqual([2, 3, 4, 1, 5]);
    expect(moved.present.pages[3]).toBe(state.present.pages[0]);
    expect(moved.present.selectedIds).toEqual([id(1)]);
    expect(undoEdit(moved).present).toEqual(state.present);
    expect(redoEdit(undoEdit(moved)).present).toEqual(moved.present);
    expect(order(moveEditPage(moved, id(5), 0))).toEqual([5, 2, 3, 4, 1]);
  });

  it("does not add history for a cancelled/no-op move or invalid index", () => {
    const state = initial();
    for (const index of [-1, 5, 1.5, NaN]) expect(moveEditPage(state, id(1), index)).toBe(state);
    expect(moveEditPage(state, "missing", 1)).toBe(state);
    expect(moveEditPage(state, id(1), 0)).toBe(state);
    expect(state.past).toHaveLength(0);
  });

  it("range selection follows the new order without losing the original anchor", () => {
    const moved = moveEditPage(initial(), id(1), 3);
    const selected = selectEditPage(moved, id(3), { range: true });
    expect(selected.present.selectedIds).toEqual([id(3), id(4), id(1)]);
  });

  it.each([0, 90, 180, 270])("combines original rotation %i with both directions", (originalRotation) => {
    const original: PdfPageInfo = { number: 1, width: 594, height: 420, rotation: originalRotation, orientation: "landscape" };
    const state = createEditState("rotated", [original]);
    const right = rotateEditSelection(state, 90);
    expect(getEditedPageInfo(right.present.pages[0], original, 7)).toEqual({
      number: 7, width: 420, height: 594, rotation: (originalRotation + 90) % 360, orientation: "portrait",
    });
    const left = rotateEditSelection(state, -90);
    expect(getEditedPageInfo(left.present.pages[0], original, 1).rotation).toBe((originalRotation + 270) % 360);
    expect(original.rotation).toBe(originalRotation);
    expect(original.width).toBe(594);
  });

  it("rotates a batch once and structurally shares every unchanged page", () => {
    const selected = selectEditPage(initial(), id(3), { toggle: true });
    const rotated = rotateEditSelection(selected, -90);
    expect(rotated.present.pages.map((page) => page.rotationDelta)).toEqual([270, 0, 270, 0, 0]);
    expect(rotated.present.pages[1]).toBe(selected.present.pages[1]);
    expect(rotated.past).toHaveLength(1);
    expect(undoEdit(rotated).present).toEqual(selected.present);
    expect(redoEdit(undoEdit(rotated)).present).toEqual(rotated.present);
    expect(rotateEditSelection(clearEditSelection(selected), 90).past).toHaveLength(0);
  });
});

describe("history and source integrity", () => {
  it("replays mixed edits with exact order, selection, and rotations", () => {
    const before = initial();
    const deleted = deleteEditSelection(selectEditPage(before, id(2)));
    const moved = moveEditPage(deleted, id(5), 0);
    const rotated = rotateEditSelection(moved, 90);
    let state = rotated;
    for (let index = 0; index < 3; index++) state = undoEdit(state);
    expect(order(state)).toEqual([1, 2, 3, 4, 5]);
    expect(state.present.pages.every((page) => page.rotationDelta === 0)).toBe(true);
    for (let index = 0; index < 3; index++) state = redoEdit(state);
    expect(state.present).toEqual(rotated.present);
  });

  it("keeps redo through selection changes, then discards it on a real new edit", () => {
    const rotated = rotateEditSelection(initial(), 90);
    const undone = undoEdit(rotated);
    const selected = selectEditPage(undone, id(4));
    expect(selected.future).toHaveLength(1);
    const changed = deleteEditSelection(selected);
    expect(changed.future).toHaveLength(0);
    expect(redoEdit(changed)).toBe(changed);
    expect(undoEdit(initial())).toEqual(initial());
    expect(redoEdit(initial())).toEqual(initial());
  });

  it("limits a 1000-page document to 50 lightweight snapshots without binary copies", () => {
    const pages = originals(1000);
    const snapshot = JSON.stringify(pages);
    let state = createEditState("large", pages);
    const unchangedPage = state.present.pages[999];
    for (let index = 0; index < 75; index++) state = rotateEditSelection(state, 90);
    expect(state.past).toHaveLength(MAX_EDIT_HISTORY);
    expect(state.present.pages).toHaveLength(1000);
    expect(state.past.every((entry) => entry.pages[999] === unchangedPage)).toBe(true);
    expect(state.present.pages[999]).toBe(unchangedPage);
    expect(Object.keys(state.present.pages[0]).sort()).toEqual(["id", "originalRotation", "rotationDelta", "sourceDocumentId", "sourcePageNumber"]);
    for (let index = 0; index < 60; index++) state = undoEdit(state);
    expect(state.past).toHaveLength(0);
    expect(state.future).toHaveLength(50);
    expect(JSON.stringify(pages)).toBe(snapshot);
  });

  it("detects actual content changes rather than selections or history length", () => {
    let state = initial();
    expect(isEdited(selectAllEditPages(state), source)).toBe(false);
    state = rotateEditSelection(state, 90);
    expect(isEdited(state, source)).toBe(true);
    for (let index = 0; index < 3; index++) state = rotateEditSelection(state, 90);
    expect(isEdited(state, source)).toBe(false);
    expect(isEdited(moveEditPage(state, id(1), 4), source)).toBe(true);
    expect(isEdited(deleteEditSelection(state), source)).toBe(true);
  });
});
