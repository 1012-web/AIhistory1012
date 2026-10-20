/**
 * 书内索引：一本书 = 一个 PDF + 多个 Markdown。记下每个文件管的物理页，
 * 跳页、PDF → 正文反向联动时据此找到该打开哪个文件。纯数据，不碰 Obsidian。
 */
import { bodyAnchors, parseAnchors } from "./anchors";

export interface BookFileEntry {
  path: string;
  /** 正文锚点的页码，按出现顺序 */
  pages: number[];
  minPage: number | null;
  maxPage: number | null;
}

export interface BookIndex {
  pdfPath: string;
  /** 书文件夹（库内路径，库根为空串） */
  root: string;
  /** 按书内顺序：book.json 的文件列表优先，否则按文件名 */
  files: BookFileEntry[];
  /** 印刷页 = 物理页 - 偏移；不知道时为 null */
  printedPageOffset: number | null;
}

/** legacyOffset：book.json 的 printedPageOffset，旧格式（只有印刷页锚点）的文件据此换算物理页 */
export function indexEntry(path: string, text: string, legacyOffset: number | null = null): BookFileEntry {
  const pages = bodyAnchors(parseAnchors(text, legacyOffset)).map((anchor) => anchor.page);
  return {
    path,
    pages,
    minPage: pages.length ? Math.min(...pages) : null,
    maxPage: pages.length ? Math.max(...pages) : null
  };
}

/** 文件名排序：数字前缀按数值（`2-` 排在 `10-` 前），其余按中文习惯比较。 */
export function compareBookPaths(a: string, b: string): number {
  return a.localeCompare(b, "zh-Hans-CN", { numeric: true });
}

export function buildBookIndex(
  pdfPath: string,
  root: string,
  entries: BookFileEntry[],
  order: string[] | null = null,
  printedPageOffset: number | null = null
): BookIndex {
  const files = [...entries];
  if (order?.length) {
    const rank = new Map(order.map((path, index) => [path, index]));
    files.sort((a, b) => (rank.get(a.path) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.path) ?? Number.MAX_SAFE_INTEGER) || compareBookPaths(a.path, b.path));
  } else {
    files.sort((a, b) => compareBookPaths(a.path, b.path));
  }
  return { pdfPath, root, files, printedPageOffset };
}

/**
 * 某物理页在哪个文件：先找正文锚点里正好有这一页的；没有就找页码范围盖住它的
 * （锚点缺页）；再没有就取最大页码小于它的那个文件（落在两文件之间的空页算前一个文件）。
 * 一页跨两个文件、后一个文件开头写了续页锚点时，两个文件都有这一页：给了 prefer（当前文件）
 * 且它也有这一页就留在它，免得 PDF 带正文时在两个文件之间来回换；否则取前一个文件（这一页从那里开始）。
 */
export function fileForPage(index: BookIndex, page: number, prefer: string | null = null): BookFileEntry | null {
  const anchored = index.files.filter((file) => file.pages.length);
  const preferred = prefer ? anchored.find((file) => file.path === prefer && file.pages.includes(page)) : undefined;
  if (preferred) return preferred;
  const exact = anchored.find((file) => file.pages.includes(page));
  if (exact) return exact;
  const covering = anchored.find((file) => file.minPage !== null && file.maxPage !== null && file.minPage <= page && page <= file.maxPage);
  if (covering) return covering;
  let best: BookFileEntry | null = null;
  for (const file of anchored) {
    if (file.maxPage !== null && file.maxPage < page && (!best || (best.maxPage ?? 0) < file.maxPage)) best = file;
  }
  return best ?? anchored[0] ?? null;
}

/** 书里出现过的全部物理页，升序去重 */
export function bookPages(index: BookIndex): number[] {
  return [...new Set(index.files.flatMap((file) => file.pages))].sort((a, b) => a - b);
}

/**
 * 补锚点时给一个没有锚点的文件定默认搜索范围：前一个有锚点文件的最大页 … 后一个有锚点文件的最小页；
 * 两头没有就到 1 和 pageCount。
 */
export function suggestedPageRange(index: BookIndex, path: string, pageCount: number): [number, number] {
  const position = index.files.findIndex((file) => file.path === path);
  let from = 1;
  let to = pageCount;
  for (let i = position - 1; i >= 0; i -= 1) {
    const maxPage = index.files[i].maxPage;
    if (maxPage !== null) {
      from = maxPage;
      break;
    }
  }
  for (let i = position + 1; i < index.files.length; i += 1) {
    const minPage = index.files[i].minPage;
    if (minPage !== null) {
      to = minPage;
      break;
    }
  }
  return [Math.max(1, from), Math.max(Math.max(1, from), Math.min(pageCount, to))];
}

/** 印刷页的显示：锚点里有就用锚点的，否则按偏移推算 */
export function printedLabel(index: BookIndex | null, page: number, fromAnchor: string | null): string | null {
  if (fromAnchor) return fromAnchor;
  if (index?.printedPageOffset === null || index?.printedPageOffset === undefined) return null;
  const printed = page - index.printedPageOffset;
  return printed >= 1 ? String(printed) : null;
}
