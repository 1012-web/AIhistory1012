/**
 * 补页码锚点：给没有（或缺）物理页锚点的笔记，按 PDF 文字层找每页开头的字，算出插 `<!--pdf-page.N-->` 的位置。
 * 只出方案（含把握），写入由调用方在用户确认后做；已有的锚点一律不动。
 *
 * 思路参考 HongdongLee/obsidian-pdf-collation 的 autoInsertPagemarks（MIT，见 THIRD_PARTY_NOTICES.md），
 * 找页首用移植来的 findPageStartNormIndex；放置规则、脚注区跳过、单调约束、把握分级是本插件的。
 */
import { bodyAnchors, footnoteRanges, formatPageAnchor, frontmatterLength, parseAnchors } from "./anchors";
import { buildCharOriginMap, findPageStartNormIndex, normalizeText } from "./collation/compare";

export type Placement = "mid" | "line" | "paragraph";
export type Confidence = "high" | "medium" | "low";

export interface PagemarkProposal {
  page: number;
  /** 插入点（全文偏移） */
  pos: number;
  placement: Placement;
  similarity: number;
  confidence: Confidence;
  /** 插入点前后的原文片段，预览用 */
  before: string;
  after: string;
}

export interface PagemarkPlan {
  proposals: PagemarkProposal[];
  /** 已有锚点、跳过的页 */
  existing: number[];
  /** 文字层太少（扫描件无文字层、空白页）的页 */
  empty: number[];
  /** 找不到或位置与前后页冲突的页 */
  missing: number[];
}

const BLOCK_SYNTAX_RE = /^[ \t]*(?:#{1,6}[ \t]|>[ \t]?|\||(?:[-*+]|\d+\.)[ \t])/;
const OPENING_PUNCT_RE = /[“‘「『《〈（([【［*"']/;
/** 段中插入要求的最低相似度；够不上就退到段首 */
const MID_THRESHOLD = 0.85;

function blank(text: string, from: number, to: number): string {
  return text.slice(0, from) + text.slice(from, to).replace(/[^\n]/g, " ") + text.slice(to);
}

/** 不参与匹配的区间换成空格（保持偏移不变）：frontmatter、代码块、脚注定义、HTML 注释 */
export function maskForMatching(text: string): string {
  let masked = blank(text, 0, frontmatterLength(text));
  masked = masked.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, (block) => block.replace(/[^\n]/g, " "));
  for (const [from, to] of footnoteRanges(text)) masked = blank(masked, from, to);
  masked = masked.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));
  return masked;
}

/** 有序公共子序列长度 */
function lcsLength(a: string, b: string): number {
  const row = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = row[j];
      row[j] = a[i - 1] === b[j - 1] ? previous + 1 : Math.max(row[j], row[j - 1]);
      previous = saved;
    }
  }
  return row[b.length];
}

/**
 * 把握用的相似度：PDF 本页（跳过页眉后）的前 40 字，有多少按顺序出现在插入点之后的正文里。
 * 移植来的 findPageStartNormIndex 的相似度以较长一方为分母，满分只有 0.8，不便分级，这里另算。
 */
export function startSimilarity(pdfHead: string, markdownHead: string): number {
  if (!pdfHead.length) return 0;
  return lcsLength(pdfHead, markdownHead) / pdfHead.length;
}

/** 只剩页码、页眉这类零星字符的页算空页 */
function isEmptyPage(pNorm: string): boolean {
  return pNorm.replace(/[0-9]/g, "").length < 4;
}

function confidenceOf(similarity: number, placement: Placement): Confidence {
  if (similarity >= 0.85 && placement !== "paragraph") return "high";
  if (similarity >= 0.65) return "medium";
  return "low";
}

function snippet(text: string, from: number, to: number): string {
  return text.slice(Math.max(0, from), Math.max(0, to)).replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");
}

/**
 * 出方案。pageTexts 是 [页码, 文字层文字] 列表（按页码升序，只给要找的范围）。
 */
export function planPagemarks(text: string, pageTexts: Array<[number, string]>): PagemarkPlan {
  const plan: PagemarkPlan = { proposals: [], existing: [], empty: [], missing: [] };
  const anchors = bodyAnchors(parseAnchors(text));
  const existingAt = new Map(anchors.map((anchor) => [anchor.page, anchor.from]));
  const masked = maskForMatching(text);
  const { norm, origins } = buildCharOriginMap([masked]);
  if (!norm.length) {
    plan.missing.push(...pageTexts.filter(([page]) => !existingAt.has(page)).map(([page]) => page));
    return plan;
  }
  // 归一化下标 → 原文偏移；找第一个原文偏移 >= offset 的归一化下标
  const normIndexAtOrAfter = (offset: number): number => {
    let low = 0;
    let high = origins.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (origins[mid].charIdx < offset) low = mid + 1;
      else high = mid;
    }
    return low;
  };

  let searchStart = 0;
  let lastPos = -1;
  for (const [page, pageText] of pageTexts) {
    const existing = existingAt.get(page);
    if (existing !== undefined) {
      plan.existing.push(page);
      searchStart = Math.max(searchStart, normIndexAtOrAfter(existing));
      lastPos = Math.max(lastPos, existing);
      continue;
    }
    const pNorm = normalizeText(pageText);
    if (isEmptyPage(pNorm)) {
      plan.empty.push(page);
      continue;
    }
    // 单调：不能越过页码更大的已有锚点
    const upper = anchors.filter((anchor) => anchor.page > page).reduce((min, anchor) => Math.min(min, anchor.from), text.length);
    const found = findPageStartNormIndex(norm, pNorm, searchStart);
    if (!found) {
      plan.missing.push(page);
      continue;
    }
    const head = pNorm.slice(found.matchedOffset, found.matchedOffset + 40);
    const similarity = startSimilarity(head, norm.slice(found.normIdx, found.normIdx + Math.ceil(head.length * 1.25)));
    let pos = origins[found.normIdx].charIdx;
    const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
    while (pos > lineStart && OPENING_PUNCT_RE.test(text[pos - 1])) pos -= 1;
    const lineEndIndex = text.indexOf("\n", pos);
    const line = text.slice(lineStart, lineEndIndex === -1 ? text.length : lineEndIndex);
    const beforeInLine = normalizeText(text.slice(lineStart, pos));
    let placement: Placement;
    if (!beforeInLine.length) {
      placement = "line";
      pos = lineStart;
    } else if (similarity >= MID_THRESHOLD && !BLOCK_SYNTAX_RE.test(line)) {
      placement = "mid";
    } else {
      placement = "paragraph";
      pos = lineStart;
    }
    if (pos <= lastPos || pos >= upper) {
      plan.missing.push(page);
      continue;
    }
    plan.proposals.push({
      page,
      pos,
      placement,
      similarity: Math.round(similarity * 100) / 100,
      confidence: confidenceOf(similarity, placement),
      before: snippet(text, pos - 14, pos),
      after: snippet(text, pos, pos + 14)
    });
    lastPos = pos;
    const consumed = Math.max(1, Math.min(16, Math.floor((pNorm.length - found.matchedOffset) * 0.25)));
    searchStart = Math.min(norm.length, found.normIdx + consumed);
  }
  return plan;
}

/**
 * 按方案写入。行首插入时：前面是空行（或文件开头）就自成一行再空一行，免得把标题、列表的语法顶开；
 * 前面还是同一段的上一行就直接贴在行首。
 */
export function applyPagemarks(text: string, proposals: PagemarkProposal[]): string {
  let out = text;
  for (const proposal of [...proposals].sort((a, b) => b.pos - a.pos)) {
    const anchor = formatPageAnchor(proposal.page);
    const { pos } = proposal;
    let insertion = anchor;
    if (proposal.placement !== "mid") {
      const before = out.slice(0, pos);
      const paragraphStart = pos === frontmatterLength(out) || /(^|\n)[ \t]*\n$/.test(before) || pos === 0;
      if (paragraphStart || BLOCK_SYNTAX_RE.test(out.slice(pos, out.indexOf("\n", pos) === -1 ? out.length : out.indexOf("\n", pos)))) {
        insertion = `${anchor}\n\n`;
      }
    }
    out = out.slice(0, pos) + insertion + out.slice(pos);
  }
  return out;
}
