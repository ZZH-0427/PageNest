import { MAX_PDF_PAGES, PdfUserError } from "./types";

export const MAX_PAGE_RANGES = 50;
export interface PdfPageRange { readonly start: number; readonly end: number; readonly label: string }

function checkPageCount(pageCount: number) {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_PDF_PAGES) {
    throw new PdfUserError("当前文档页数无效，无法建立拆分范围。");
  }
}

function range(start: number, end: number): PdfPageRange {
  return Object.freeze({ start, end, label: start === end ? `${start}` : `${start}-${end}` });
}

/** Each comma starts a separate output; explicit range order is retained. */
export function parsePageRanges(input: string, pageCount: number): readonly PdfPageRange[] {
  checkPageCount(pageCount);
  if (typeof input !== "string" || !input.trim()) throw new PdfUserError("请输入拆分页码范围；每个逗号分隔的范围生成一份 PDF。");
  const tokens = input.split(",");
  if (tokens.length > MAX_PAGE_RANGES) throw new PdfUserError("一次最多生成 50 份 PDF，请减少拆分范围。");
  const used = new Set<number>();
  const ranges = tokens.map((token) => {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token.trim());
    if (!match) throw new PdfUserError("页码格式无效。请使用整数页码或起止范围，例如 1-3,5,8-10。");
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > pageCount) {
      throw new PdfUserError("拆分范围必须从第 1 页开始计数，起始页不得大于结束页，且不能超过当前文档页数。");
    }
    for (let page = start; page <= end; page++) {
      if (used.has(page)) throw new PdfUserError("拆分范围不能重复或重叠；每页只能出现在一份拆分结果中。");
      used.add(page);
    }
    return range(start, end);
  });
  return Object.freeze(ranges);
}

export function splitEveryPages(pageCount: number, every: number): readonly PdfPageRange[] {
  checkPageCount(pageCount);
  if (!Number.isSafeInteger(every) || every < 1) throw new PdfUserError("每份页数必须是大于 0 的整数。");
  const count = Math.ceil(pageCount / every);
  if (count > MAX_PAGE_RANGES) throw new PdfUserError("一次最多生成 50 份 PDF，请增加每份页数。");
  return Object.freeze(Array.from({ length: count }, (_, index) => range(index * every + 1, Math.min((index + 1) * every, pageCount))));
}
