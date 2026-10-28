/**
 * 标题菜单（目录树、分栏）的纯逻辑：标题的稳定编号、打开时哪些展开、搜索筛选、页码写法。
 *
 * 展开分两种：用户自己点的（展开、收起，「展开到第几级」）记在每本书的设置里；
 * 为了让当前位置看得见而展开的上级只是临时的，读到别处就跟着换，不记。
 */
import { segmentIndexAt, type PageSegment } from "./anchors";
import { headingPath, type Heading, type Outline } from "./headings";

/** 标题所在页：PDF 页与印刷页 */
export interface HeadingPage {
  page: number;
  printed: string | null;
}

/** 每行右边的页码：印刷页 / PDF 页 / 两个都标 */
export type OutlinePages = "printed" | "pdf" | "both";

/** 一本书的目录展开记忆 */
export interface OutlineBookState {
  /** 「展开到第几级」：2 = H1、H2 看得见（H1 展开）；0 = 全部收起；ALL_LEVELS = 全部展开 */
  depth: number;
  /** 用户手动展开（true）或收起（false）过的标题，键是 headingIds 给的编号 */
  manual: Record<string, boolean>;
}

export const ALL_LEVELS = 9;
export const EMPTY_BOOK_STATE: OutlineBookState = { depth: 0, manual: {} };

const SEP = "\u001f";

/**
 * 标题的稳定编号：文件路径 + 各级上级标题文字 + 自己；同一上级下重名的加序号。
 * 改正文字、在别处增删标题都不变，所以记住的展开状态不会错位。
 */
export function headingIds(list: Heading[], tree: Outline, scope: string): string[] {
  const ids: string[] = [];
  const seen = new Map<string, number>();
  list.forEach((heading, index) => {
    const parent = tree.parents[index];
    const base = `${parent >= 0 ? ids[parent] : scope}${SEP}${heading.text}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    ids.push(count > 1 ? `${base}${SEP}${count}` : base);
  });
  return ids;
}

/**
 * 各标题所在页（标题行起点落在哪个页段）。一千多个标题一次算完，所以不逐个走 pageAtOffset（那个每次都要扫脚注区）。
 * printed 由调用方按书的页码偏移补全；标题在第一个页码锚点之前的，算第一段那一页。
 */
export function headingPages(list: Heading[], segments: PageSegment[], printed: (page: number, fromAnchor: string | null) => string | null): HeadingPage[] {
  if (!segments.length) return list.map(() => ({ page: 0, printed: null }));
  return list.map((heading) => {
    const segment = segments[Math.max(0, segmentIndexAt(segments, heading.offset))];
    return { page: segment.page, printed: printed(segment.page, segment.printed) };
  });
}

/** 打开菜单（或钉住时阅读位置变了）时展开哪些：先按层级，再套手动记录，最后临时展开当前位置的各级上级 */
export function expandedIds(list: Heading[], tree: Outline, ids: string[], state: OutlineBookState, current: number): string[] {
  const open = new Set<string>();
  list.forEach((heading, index) => {
    if (!tree.children[index].length) return;
    if (state.manual[ids[index]] ?? heading.level < state.depth) open.add(ids[index]);
  });
  for (const index of headingPath(tree, current).slice(0, -1)) open.add(ids[index]);
  return [...open];
}

/** 展开集合从 before 变成 after：把差别记成手动展开、收起 */
export function withToggles(state: OutlineBookState, before: string[], after: string[]): OutlineBookState {
  const was = new Set(before);
  const now = new Set(after);
  const manual = { ...state.manual };
  let changed = false;
  for (const id of now) if (!was.has(id)) {
    manual[id] = true;
    changed = true;
  }
  for (const id of was) if (!now.has(id)) {
    manual[id] = false;
    changed = true;
  }
  return changed ? { ...state, manual } : state;
}

/** 搜索：标题里含 query（不分大小写）的，连同它们的各级上级；query 为空返回 null（不筛） */
export function searchKeep(list: Heading[], tree: Outline, query: string): { keep: Set<number>; hits: number[] } | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const keep = new Set<number>();
  const hits: number[] = [];
  list.forEach((heading, index) => {
    if (!heading.text.toLowerCase().includes(needle)) return;
    hits.push(index);
    for (const at of headingPath(tree, index)) keep.add(at);
  });
  return { keep, hits };
}

/** 页码写法：中文界面「第50页」，其他语言「p.50」；PDF 页写「PDF 65」；没有印刷页时只写 PDF 页 */
export function pageLabel(page: HeadingPage, mode: OutlinePages, zh: boolean): string {
  const pdf = `PDF ${page.page}`;
  if (mode === "pdf" || !page.printed) return pdf;
  const printed = zh ? `第${page.printed}页` : `p.${page.printed}`;
  return mode === "both" ? `${printed} · ${pdf}` : printed;
}

/** 标题文字按 query 切成几段，好把匹配的字标出来 */
export function splitMatch(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [{ text, hit: false }];
  const out: Array<{ text: string; hit: boolean }> = [];
  const lower = text.toLowerCase();
  let at = 0;
  for (let found = lower.indexOf(needle); found !== -1; found = lower.indexOf(needle, at)) {
    if (found > at) out.push({ text: text.slice(at, found), hit: false });
    out.push({ text: text.slice(found, found + needle.length), hit: true });
    at = found + needle.length;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}
