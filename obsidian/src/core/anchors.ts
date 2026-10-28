/**
 * 物理页锚点的解析：插件与 book2md1012 skill 之间唯一的接口（见仓库 docs/anchors.md）。
 *
 *   <!--pdf-page.N-->   PDF 第 N 页（从 1 起）内容的起点，每页一个；段落跨页时插在接缝处（可在行中）
 *   <!--p.M-->          印刷页，紧跟在物理页锚点后
 *   [^n]: <!--pdf-page.N--><!--p.M--> 注文   脚注定义自带它所在的页
 *
 * 这里只做字符串层面的事：找锚点、把正文切成按页的段、按偏移查页。不碰 Obsidian。
 */

export const PAGE_ANCHOR_RE = /<!--\s*pdf-page\.(\d+)\s*-->/g;
export const PRINTED_ANCHOR_RE = /<!--\s*p\.([^\s>-][^\s>]*?)\s*-->/g;
/** 物理页锚点后紧跟（只隔空白）的印刷页锚点 */
const FOLLOWING_PRINTED_RE = /^[ \t]*<!--\s*p\.([^\s>-][^\s>]*?)\s*-->/;
/** 脚注定义行：行首 `[^标号]:` */
const FOOTNOTE_DEF_RE = /^\[\^[^\]\s]+\]:/;

export interface Anchor {
  /** PDF 物理页，从 1 起 */
  page: number;
  /** 本页的印刷页（原样字符串，可能是罗马数字）：紧跟的，或本页段里第一个印刷页锚点 */
  printed: string | null;
  /** 锚点注释在全文中的起止偏移；`end` 含紧跟的印刷页锚点（分开写的不含） */
  from: number;
  end: number;
  /** 是否在脚注定义里 */
  footnote: boolean;
  /** 旧格式：文件里只有印刷页锚点，物理页是按 printedPageOffset 换算出来的 */
  legacy?: boolean;
}

/** 一页正文在文件中的区间 [from, to)。`from` 是锚点起点；`lead` 表示第一个锚点之前的引子部分。 */
export interface PageSegment {
  page: number;
  printed: string | null;
  from: number;
  to: number;
  lead?: boolean;
}

/** frontmatter 的长度（含结尾的 `---` 行与换行）；没有 frontmatter 时为 0。 */
export function frontmatterLength(text: string): number {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? match[0].length : 0;
}

/** 行首偏移表 */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/**
 * 脚注定义所占的区间：定义行本身，加上其后缩进的续行（Markdown 的脚注多段写法）。
 * 返回按起点排序、互不重叠的 [from, to)。
 */
export function footnoteRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const starts = lineStarts(text);
  let open: [number, number] | null = null;
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index];
    const to = index + 1 < starts.length ? starts[index + 1] : text.length;
    const line = text.slice(from, to).replace(/\r?\n$/, "");
    if (FOOTNOTE_DEF_RE.test(line)) {
      if (open) out.push(open);
      open = [from, to];
    } else if (open && (/^( {2,}|\t)\S/.test(line) || (line.trim() === "" && /^( {2,}|\t)\S/.test(nextLine(text, starts, index))))) {
      open[1] = to;
    } else if (open) {
      out.push(open);
      open = null;
    }
  }
  if (open) out.push(open);
  return out;
}

function nextLine(text: string, starts: number[], index: number): string {
  if (index + 1 >= starts.length) return "";
  const from = starts[index + 1];
  const to = index + 2 < starts.length ? starts[index + 2] : text.length;
  return text.slice(from, to).replace(/\r?\n$/, "");
}

function inRanges(ranges: Array<[number, number]>, offset: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [from, to] = ranges[mid];
    if (offset < from) high = mid - 1;
    else if (offset >= to) low = mid + 1;
    else return true;
  }
  return false;
}

/**
 * 旧格式（md1012 时期）：只有 `<!--p.M-->`、没有物理页锚点。按 book.json 的 printedPageOffset
 * 换算（物理页 = 印刷页 + 偏移）；只认阿拉伯数字的印刷页，换算出的页小于 1 的不要。
 */
function legacyAnchors(text: string, offset: number, skip: number, notes: Array<[number, number]>): Anchor[] {
  const out: Anchor[] = [];
  for (const match of text.matchAll(PRINTED_ANCHOR_RE)) {
    const from = match.index;
    if (from < skip || !/^\d+$/.test(match[1])) continue;
    const page = Number(match[1]) + offset;
    if (page < 1) continue;
    out.push({ page, printed: match[1], from, end: from + match[0].length, footnote: inRanges(notes, from), legacy: true });
  }
  return out;
}

/**
 * 文中全部物理页锚点，按出现顺序。frontmatter 里的不算。
 * 文件里一个物理页锚点都没有、又给了 legacyOffset（book.json 的 printedPageOffset）时，按旧格式从印刷页锚点换算。
 */
export function parseAnchors(text: string, legacyOffset: number | null = null): Anchor[] {
  const skip = frontmatterLength(text);
  const notes = footnoteRanges(text);
  const out: Anchor[] = [];
  for (const match of text.matchAll(PAGE_ANCHOR_RE)) {
    const from = match.index;
    if (from < skip) continue;
    let end = from + match[0].length;
    const tail = FOLLOWING_PRINTED_RE.exec(text.slice(end, end + 40));
    let printed: string | null = null;
    if (tail) {
      printed = tail[1];
      end += tail[0].length;
    }
    out.push({ page: Number(match[1]), printed, from, end, footnote: inRanges(notes, from) });
  }
  // 章首页：物理页锚点在章标题前，印刷页锚点可以分开写在标题后。取本锚点到下一个物理页锚点之间的第一个印刷页锚点
  for (let index = 0; index < out.length; index += 1) {
    const anchor = out[index];
    if (anchor.printed !== null) continue;
    const limit = index + 1 < out.length ? out[index + 1].from : text.length;
    const region = text.slice(anchor.end, limit);
    const match = new RegExp(PRINTED_ANCHOR_RE.source).exec(region);
    if (match) anchor.printed = match[1];
  }
  if (!out.length && legacyOffset !== null) return legacyAnchors(text, legacyOffset, skip, notes);
  return out;
}

/** 正文（脚注定义以外）的锚点 */
export function bodyAnchors(anchors: Anchor[]): Anchor[] {
  return anchors.filter((anchor) => !anchor.footnote);
}

/**
 * 把正文切成按页的段。脚注定义区不参与切分：页的终点是下一个正文锚点或第一个脚注定义。
 * 第一个锚点之前若有正文，作为引子（`lead`），算第一个锚点的前一页（多文件书里是上个文件末页的延续）。没有锚点返回空数组。
 */
export function pageSegments(text: string, anchors: Anchor[] = parseAnchors(text)): PageSegment[] {
  const body = bodyAnchors(anchors);
  if (!body.length) return [];
  const notes = footnoteRanges(text);
  const segments: PageSegment[] = [];
  const skip = frontmatterLength(text);
  if (body[0].from > skip && text.slice(skip, body[0].from).trim()) {
    // 多文件书里，文件开头常是上一个文件末页的延续（跨文件的那一页只在前一个文件里有锚点），算前一页
    const page = Math.max(1, body[0].page - 1);
    segments.push({ page, printed: null, from: skip, to: body[0].from, lead: true });
  }
  for (let index = 0; index < body.length; index += 1) {
    const anchor = body[index];
    let to = index + 1 < body.length ? body[index + 1].from : text.length;
    // 正文最后一页截到脚注区开头
    const firstNote = notes.find(([from]) => from > anchor.from);
    if (firstNote && firstNote[0] < to) to = firstNote[0];
    segments.push({ page: anchor.page, printed: anchor.printed, from: anchor.from, to });
  }
  return segments;
}

/** 二分：最后一个 from <= offset 的段的下标；在第一个段之前返回 -1 */
export function segmentIndexAt(segments: PageSegment[], offset: number): number {
  let low = 0;
  let high = segments.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (segments[mid].from <= offset) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

export interface PagePosition {
  page: number;
  printed: string | null;
  /** 所在页段（脚注里的位置给的是那条脚注的区间） */
  from: number;
  to: number;
  footnote: boolean;
}

/**
 * 偏移 offset 落在哪一页。脚注定义里带了锚点的按那条脚注的页算；
 * 其余按它前面最近的正文锚点。没有锚点返回 null。
 */
export function pageAtOffset(text: string, offset: number, anchors: Anchor[] = parseAnchors(text), segments: PageSegment[] = pageSegments(text, anchors)): PagePosition | null {
  if (!segments.length) return null;
  const notes = footnoteRanges(text);
  for (const [from, to] of notes) {
    if (offset < from || offset >= to) continue;
    // 脚注跨页时注文中间可以再有锚点：取位置之前最近的那个，没有就取这条脚注的第一个
    const inside = anchors.filter((item) => item.footnote && item.from >= from && item.from < to);
    const anchor = [...inside].reverse().find((item) => item.from <= offset) ?? inside[0];
    if (anchor) return { page: anchor.page, printed: anchor.printed, from, to, footnote: true };
  }
  const index = segmentIndexAt(segments, offset);
  const segment = segments[Math.max(0, index)];
  // 越过最后一个段的终点（脚注区里没有自带锚点的定义）：算最后一页
  return { page: segment.page, printed: segment.printed, from: segment.from, to: segment.to, footnote: false };
}

/** 某页的正文段；同一页有多段（不应出现，出现就取第一段）时取第一段，没有返回 null。 */
export function segmentForPage(segments: PageSegment[], page: number): PageSegment | null {
  return segments.find((segment) => segment.page === page && !segment.lead) ?? null;
}

/**
 * 跳到某页时用：有这一页的段就是它；缺页（两个锚点之间缺了几页）按约定算在前一页里，
 * 返回前一页的段并标 `gap`，调用方滚到该段末尾。比本文件最小页还小、比最大页还大（该去别的文件）、
 * 或一个段都没有时返回 null。
 */
export function segmentForPageOrGap(segments: PageSegment[], page: number): { segment: PageSegment; gap: boolean } | null {
  const exact = segmentForPage(segments, page);
  if (exact) return { segment: exact, gap: false };
  let best: PageSegment | null = null;
  for (const segment of segments) {
    if (segment.lead || segment.page >= page) continue;
    if (!best || segment.page > best.page) best = segment;
  }
  // 只认「两个锚点之间」缺的页：后面没有更大的页，说明这一页在别的文件里
  const later = segments.some((segment) => !segment.lead && segment.page > page);
  return best && later ? { segment: best, gap: true } : null;
}

/** 挂在某页的脚注定义（定义里带该页锚点）的区间 */
export function footnotesForPage(text: string, page: number, anchors: Anchor[] = parseAnchors(text)): Array<[number, number]> {
  const notes = footnoteRanges(text);
  return notes.filter(([from, to]) => anchors.some((anchor) => anchor.footnote && anchor.page === page && anchor.from >= from && anchor.from < to));
}

/** 去掉锚点注释的纯文字（预览片段、修订请求里用） */
export function stripAnchors(text: string): string {
  return text.replace(PAGE_ANCHOR_RE, "").replace(PRINTED_ANCHOR_RE, "");
}

/**
 * 检查锚点：正文锚点是否单调递增、有无重复。返回问题描述列表（空表示没问题）。
 * 约定允许扫描页序乱时局部倒序：这里只列出来供提示，插件不因此拒绝工作。
 */
export function anchorProblems(anchors: Anchor[]): string[] {
  const problems: string[] = [];
  const body = bodyAnchors(anchors);
  const seen = new Set<number>();
  for (let index = 0; index < body.length; index += 1) {
    const { page } = body[index];
    if (seen.has(page)) problems.push(`第 ${page} 页的锚点重复`);
    seen.add(page);
    if (index > 0 && page < body[index - 1].page) problems.push(`第 ${page} 页的锚点排在第 ${body[index - 1].page} 页之后`);
  }
  return problems;
}

export function formatPageAnchor(page: number): string {
  return `<!--pdf-page.${page}-->`;
}
