import { parsePageRanges, splitEveryPages } from "./page-ranges";
import { PdfUserError } from "./types";

test("commas define independent outputs, with explicit range order and ascending pages inside each range", () => {
  expect(parsePageRanges(" 8 - 10, 01-3 , 5 ", 12)).toEqual([
    { start: 8, end: 10, label: "8-10" }, { start: 1, end: 3, label: "1-3" }, { start: 5, end: 5, label: "5" },
  ]);
});

test.each(["", " ", ",", "1,", ",1", "1,,2", "0", "-1", "1.5", "1e2", "+1", "NaN", "Infinity", "1/3", "1--3", "1-2-3", "2 3", "1，2", "3-1", "1-13", "13", "9007199254740993"])("rejects malformed or out-of-bounds range %s", (input) => {
  expect(() => parsePageRanges(input, 12)).toThrow(PdfUserError);
});

test.each(["1,1", "1-3,3-5", "8-10,9", "5,1-8", "01,1"])("rejects duplicate/overlapping ranges in either order: %s", (input) => {
  expect(() => parsePageRanges(input, 12)).toThrow("重复或重叠");
});

test.each([0, -1, 1.5, 1001, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid document length %s", (count) => {
  expect(() => parsePageRanges("1", count)).toThrow(PdfUserError);
  expect(() => splitEveryPages(count, 1)).toThrow(PdfUserError);
});

test("splits every N pages with an exact short final group and no truncation", () => {
  expect(splitEveryPages(10, 3)).toEqual([
    { start: 1, end: 3, label: "1-3" }, { start: 4, end: 6, label: "4-6" },
    { start: 7, end: 9, label: "7-9" }, { start: 10, end: 10, label: "10" },
  ]);
  expect(splitEveryPages(3, 100)).toEqual([{ start: 1, end: 3, label: "1-3" }]);
});

test.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects invalid every-N value %s", (every) => {
  expect(() => splitEveryPages(12, every)).toThrow(PdfUserError);
});

test("accepts exactly 50 outputs and rejects the 51st before constructing an oversized result", () => {
  expect(splitEveryPages(1000, 20)).toHaveLength(50);
  expect(() => splitEveryPages(1000, 19)).toThrow("50");
  expect(parsePageRanges(Array.from({ length: 50 }, (_, index) => index + 1).join(","), 100)).toHaveLength(50);
  expect(() => parsePageRanges(Array.from({ length: 51 }, (_, index) => index + 1).join(","), 100)).toThrow("50");
});

test("returns frozen metadata without echoing an invalid range into errors", () => {
  const ranges = parsePageRanges("1-3,5", 5);
  expect(Object.isFrozen(ranges)).toBe(true);
  expect(ranges.every(Object.isFrozen)).toBe(true);
  try { parsePageRanges("SYNTHETIC_PRIVATE_INPUT", 5); }
  catch (error) { expect(String(error)).not.toContain("SYNTHETIC_PRIVATE_INPUT"); }
});
