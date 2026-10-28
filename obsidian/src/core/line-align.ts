/**
 * 逐行对齐：PDF 文字层的各行 ↔ 正文里这一页段的字。
 *
 * PDF 文字层（PDF.js 抽出的、叠在页面图像上的那层字）给出每一行在页上的高度；把各行文字与正文页段逐字比对，
 * 得到「PDF 这一行从正文第几个字开始」，即对齐点。跟随时两边按对齐点分段插值（见 line-sync.ts）。
 * 页眉、页码、页下注这类正文页段里没有的行比不上，自然跳过；比对不要求字全对，一行里有一部分字对上就认得出：
 * 拿实书试过，文字层错字率 40% 以内的行全部认对，错到 60%–70% 仍能认对九成上下。
 * 逐字比对是通用问题，用 jsdiff（npm 包 `diff`）；纯函数，不碰 DOM 与 PDF.js。
 */
import { diffChars } from "diff";
import { buildCharOriginMap } from "./collation/compare";

/** PDF 页上的一行：高度用页高的比例（0 页顶、1 页底），与缩放无关 */
export interface PdfLine {
  top: number;
  bottom: number;
  text: string;
}

/** 一页的文字层，各行按内容流顺序（一般就是阅读顺序）。没有文字层时 lines 为空；竖排的页 vertical 为真 */
export interface PdfPageLines {
  page: number;
  lines: PdfLine[];
  vertical?: boolean;
}

/**
 * 对齐点：正文偏移 offset 处的字，落在 PDF 第 page 页、页内高度 fraction 处。
 * 逐行对齐的点取在那一行的「行中线往上半个行距」：行中间的字正落在行中线上，与正文一侧的阅读高度同一个算法（见 cm-sync.ts）。
 */
export interface AlignPoint {
  offset: number;
  page: number;
  fraction: number;
}

/** lines 逐行对上；box 有文字层但对不上（乱码、错字太多、正文没字），只能按文字范围；page 没有文字层或竖排 */
export type AlignQuality = "lines" | "box" | "page";

export interface SegmentAlignment {
  points: AlignPoint[];
  quality: AlignQuality;
  /** 认出的行数 */
  matched: number;
  /** 文字层里有字的行数 */
  total: number;
  /** 有竖排的页 */
  vertical?: boolean;
}

/** 一行至少有这么多比例的字对上才认（短行至少两个字） */
const MIN_LINE_SHARE = 0.15;
/** 认出的行，对上的字在正文里铺开的长度不能超过行长的这么多倍：防零星同字凑出假匹配 */
const MAX_SPREAD = 3;
/** 逐字比对的时间上限（毫秒）：乱码页比不出来，到点作罢，这一页退回按页 */
const DIFF_TIMEOUT_MS = 150;
/** 正文这一段不超过这么多字（归一化后）时，对上一行就算数 */
const SHORT_RANGE = 60;

/** 图片嵌入（`![](…)`、`![[…]]`）不参与比对：路径里的字母数字会被当成正文 */
const EMBED_RE = /!\[\[[^\]\n]*\]\]|!\[[^\]\n]*\]\([^)\n]*\)/g;

function maskEmbeds(text: string): string {
  return text.replace(EMBED_RE, (match) => " ".repeat(match.length));
}

/** 一页的文字范围：首行顶到末行底；没有文字返回 null */
export function textBox(page: PdfPageLines): { top: number; bottom: number } | null {
  let top = Infinity;
  let bottom = -Infinity;
  for (const line of page.lines) {
    if (!line.text.trim()) continue;
    top = Math.min(top, line.top);
    bottom = Math.max(bottom, line.bottom);
  }
  return top < bottom ? { top, bottom } : null;
}

/**
 * 最长递增子序列：保留 key 严格递增的最多那些项（按原顺序）。用来剔除次序乱了的假匹配。
 * 标准的耐心排序法二十来行；npm 上的现成包都是单人小包、多年不更新，不值得为它加依赖。
 */
export function longestIncreasing<T>(items: readonly T[], key: (item: T) => number): T[] {
  const tails: number[] = [];
  const previous = new Int32Array(items.length).fill(-1);
  for (let index = 0; index < items.length; index += 1) {
    const value = key(items[index]);
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (key(items[tails[mid]]) < value) low = mid + 1;
      else high = mid;
    }
    if (low > 0) previous[index] = tails[low - 1];
    tails[low] = index;
  }
  const out: T[] = [];
  for (let index = tails.length ? tails[tails.length - 1] : -1; index !== -1; index = previous[index]) out.push(items[index]);
  return out.reverse();
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/**
 * 把正文 [from, to) 与 pages 各页的文字层逐行对齐。pages 是这一段覆盖的物理页（缺页按约定算进前一页段，
 * 所以可能不止一页），按页序给。返回的对齐点按正文偏移升序，fraction 取那一行的顶。
 */
export function alignSegment(text: string, from: number, to: number, pages: readonly PdfPageLines[]): SegmentAlignment {
  const flat: Array<{ page: number; line: PdfLine }> = [];
  for (const page of pages) for (const line of page.lines) flat.push({ page: page.page, line });
  const pdf = buildCharOriginMap(flat.map((item) => item.line.text));
  // 每行在归一化文字里的区间 [start, end)
  const start = new Int32Array(flat.length).fill(-1);
  const end = new Int32Array(flat.length).fill(-1);
  pdf.origins.forEach((origin, index) => {
    if (start[origin.segIdx] === -1) start[origin.segIdx] = index;
    end[origin.segIdx] = index + 1;
  });
  const total = Array.from(start).filter((value) => value !== -1).length;
  const none = (quality: AlignQuality): SegmentAlignment => ({ points: [], quality, matched: 0, total });
  if (pages.some((page) => page.vertical)) return { ...none("page"), vertical: true };
  if (!pdf.norm.length) return none("page");
  const markdown = buildCharOriginMap([maskEmbeds(text.slice(from, to))]);
  if (!markdown.norm.length) return none("box");
  const changes = diffChars(pdf.norm, markdown.norm, { timeout: DIFF_TIMEOUT_MS, maxEditLength: pdf.norm.length + markdown.norm.length });
  if (!changes) return none("box");
  // PDF 归一化文字的第 i 个字对上了正文归一化文字的第几个字（-1 没对上）
  const mapped = new Int32Array(pdf.norm.length).fill(-1);
  let i = 0;
  let j = 0;
  for (const change of changes) {
    const length = change.value.length;
    if (change.added) j += length;
    else if (change.removed) i += length;
    else {
      for (let k = 0; k < length; k += 1) mapped[i + k] = j + k;
      i += length;
      j += length;
    }
  }
  const candidates: Array<{ index: number; at: number }> = [];
  for (let index = 0; index < flat.length; index += 1) {
    if (start[index] === -1) continue;
    const length = end[index] - start[index];
    const estimates: number[] = [];
    let low = Infinity;
    let high = -Infinity;
    for (let k = start[index]; k < end[index]; k += 1) {
      if (mapped[k] < 0) continue;
      // 由这个字推算本行行首在正文里的位置：行首的字认错了也不影响
      estimates.push(mapped[k] - (k - start[index]));
      low = Math.min(low, mapped[k]);
      high = Math.max(high, mapped[k]);
    }
    if (estimates.length < Math.max(2, Math.ceil(length * MIN_LINE_SHARE))) continue;
    if (high - low > length * MAX_SPREAD + 8) continue;
    candidates.push({ index, at: Math.min(markdown.norm.length - 1, Math.max(0, median(estimates))) });
  }
  const kept = longestIncreasing(candidates, (candidate) => candidate.at);
  // 一般要两行以上对上才算数；很短的一段（一条注、一两行字）对上一行就够
  if (kept.length < (markdown.norm.length <= SHORT_RANGE ? 1 : 2)) return { points: [], quality: "box", matched: kept.length, total };
  const points = kept.map((candidate) => ({
    offset: from + markdown.origins[candidate.at].charIdx,
    page: flat[candidate.index].page,
    fraction: lineBoxTop(flat, candidate.index)
  }));
  return { points, quality: "lines", matched: kept.length, total };
}

/** 行距：到同一页下一行顶的距离，限在字高的 1.2–2.5 倍之间；本页最后一行取字高的 1.6 倍 */
function pitchOf(flat: ReadonlyArray<{ page: number; line: PdfLine }>, index: number): number {
  const { page, line } = flat[index];
  const height = Math.max(1e-4, line.bottom - line.top);
  const next = flat.slice(index + 1).find((item) => item.page === page && item.line.top > line.top + height * 0.5);
  const pitch = next ? next.line.top - line.top : height * 1.6;
  return Math.min(height * 2.5, Math.max(height * 1.2, pitch));
}

/** 一行的对齐高度：行中线往上半个行距 */
function lineBoxTop(flat: ReadonlyArray<{ page: number; line: PdfLine }>, index: number): number {
  const { line } = flat[index];
  return (line.top + line.bottom) / 2 - pitchOf(flat, index) / 2;
}

/**
 * 对不上时的兜底：把正文 [from, to) 按页均分给 pages，每页从文字范围顶对到底（没有文字层的页取整页）。
 * 只扣掉页边，页内仍按比例。
 */
export function fallbackPoints(from: number, to: number, pages: readonly PdfPageLines[]): AlignPoint[] {
  const out: AlignPoint[] = [];
  pages.forEach((page, index) => {
    const box = textBox(page) ?? { top: 0, bottom: 1 };
    out.push({ offset: from + Math.round(((to - from) * index) / pages.length), page: page.page, fraction: box.top });
    out.push({ offset: from + Math.round(((to - from) * (index + 1)) / pages.length), page: page.page, fraction: box.bottom });
  });
  return out;
}
