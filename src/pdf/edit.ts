import type { PdfPageInfo } from "./types";

export const MAX_EDIT_HISTORY = 50;

/** A stable source reference. No File, PDF bytes, canvas or PDF.js proxy enters history. */
export interface PdfEditPage {
  id: string;
  sourceDocumentId: string;
  sourcePageNumber: number;
  originalRotation: number;
  rotationDelta: number;
}

export interface PdfEditSnapshot {
  pages: PdfEditPage[];
  selectedIds: string[];
  anchorId: string | null;
}

export interface PdfEditState {
  present: PdfEditSnapshot;
  past: PdfEditSnapshot[];
  future: PdfEditSnapshot[];
}

export interface PageSelectionModifiers {
  toggle?: boolean;
  range?: boolean;
}

export function normalizeRotation(rotation: number): number {
  return ((rotation % 360) + 360) % 360;
}

export function createEditState(documentId: string, originalPages: PdfPageInfo[]): PdfEditState {
  const pages = originalPages.map((page) => ({
    id: `${documentId}:page:${page.number}`,
    sourceDocumentId: documentId,
    sourcePageNumber: page.number,
    originalRotation: page.rotation,
    rotationDelta: 0,
  }));
  return {
    present: { pages, selectedIds: pages[0] ? [pages[0].id] : [], anchorId: pages[0]?.id ?? null },
    past: [], future: [],
  };
}

export function getEditedPageInfo(page: PdfEditPage, original: PdfPageInfo, currentNumber: number): PdfPageInfo {
  // Original dimensions already include the PDF's own rotation.
  const swap = normalizeRotation(page.rotationDelta) % 180 !== 0;
  const width = swap ? original.height : original.width;
  const height = swap ? original.width : original.height;
  return {
    number: currentNumber, width, height,
    rotation: normalizeRotation(page.originalRotation + page.rotationDelta),
    orientation: width === height ? "square" : width > height ? "landscape" : "portrait",
  };
}

export function isEdited(state: PdfEditState, originalPages: PdfPageInfo[]): boolean {
  return state.present.pages.length !== originalPages.length || state.present.pages.some((page, index) =>
    page.sourcePageNumber !== originalPages[index]?.number || normalizeRotation(page.rotationDelta) !== 0,
  );
}

function selection(state: PdfEditState, selectedIds: string[], anchorId: string | null): PdfEditState {
  const current = state.present;
  if (anchorId === current.anchorId && selectedIds.length === current.selectedIds.length &&
    selectedIds.every((id, index) => id === current.selectedIds[index])) return state;
  return { ...state, present: { ...current, selectedIds, anchorId } };
}

export function selectEditPage(state: PdfEditState, pageId: string, modifiers: PageSelectionModifiers = {}): PdfEditState {
  const { pages, selectedIds, anchorId } = state.present;
  const index = pages.findIndex((page) => page.id === pageId);
  if (index < 0) return state;
  if (modifiers.range) {
    const anchor = pages.findIndex((page) => page.id === anchorId);
    const start = anchor < 0 ? index : anchor;
    const range = pages.slice(Math.min(start, index), Math.max(start, index) + 1).map((page) => page.id);
    const included = new Set(modifiers.toggle ? [...selectedIds, ...range] : range);
    return selection(state, pages.filter((page) => included.has(page.id)).map((page) => page.id), anchor < 0 ? pageId : anchorId);
  }
  if (modifiers.toggle) {
    const included = new Set(selectedIds);
    if (included.has(pageId)) included.delete(pageId);
    else included.add(pageId);
    return selection(state, pages.filter((page) => included.has(page.id)).map((page) => page.id), pageId);
  }
  return selection(state, [pageId], pageId);
}

export function selectAllEditPages(state: PdfEditState): PdfEditState {
  return selection(state, state.present.pages.map((page) => page.id), state.present.anchorId ?? state.present.pages[0]?.id ?? null);
}

export function clearEditSelection(state: PdfEditState): PdfEditState {
  return selection(state, [], null);
}

function record(state: PdfEditState, present: PdfEditSnapshot): PdfEditState {
  return { present, past: [...state.past, state.present].slice(-MAX_EDIT_HISTORY), future: [] };
}

export function deleteEditSelection(state: PdfEditState): PdfEditState {
  const included = new Set(state.present.selectedIds);
  const pages = state.present.pages.filter((page) => !included.has(page.id));
  if (!pages.length || pages.length === state.present.pages.length) return state;
  const firstRemoved = state.present.pages.findIndex((page) => included.has(page.id));
  const nextId = pages[Math.min(firstRemoved, pages.length - 1)].id;
  return record(state, { pages, selectedIds: [nextId], anchorId: nextId });
}

export function rotateEditSelection(state: PdfEditState, delta: 90 | -90): PdfEditState {
  if (delta !== 90 && delta !== -90) return state;
  const included = new Set(state.present.selectedIds);
  if (!state.present.pages.some((page) => included.has(page.id))) return state;
  const pages = state.present.pages.map((page) => included.has(page.id)
    ? { ...page, rotationDelta: normalizeRotation(page.rotationDelta + delta) } : page);
  return record(state, { ...state.present, pages });
}

/** targetIndex is the final zero-based position after removing the moved page. */
export function moveEditPage(state: PdfEditState, pageId: string, targetIndex: number): PdfEditState {
  const sourceIndex = state.present.pages.findIndex((page) => page.id === pageId);
  if (sourceIndex < 0 || !Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= state.present.pages.length || sourceIndex === targetIndex) return state;
  const pages = [...state.present.pages];
  const [moved] = pages.splice(sourceIndex, 1);
  pages.splice(targetIndex, 0, moved);
  const included = new Set(state.present.selectedIds);
  return record(state, { ...state.present, pages, selectedIds: pages.filter((page) => included.has(page.id)).map((page) => page.id) });
}

export function undoEdit(state: PdfEditState): PdfEditState {
  const previous = state.past.at(-1);
  if (!previous) return state;
  return { present: previous, past: state.past.slice(0, -1), future: [state.present, ...state.future] };
}

export function redoEdit(state: PdfEditState): PdfEditState {
  const next = state.future[0];
  if (!next) return state;
  return { present: next, past: [...state.past, state.present].slice(-MAX_EDIT_HISTORY), future: state.future.slice(1) };
}
