/**
 * 正文一侧的跟随（CodeMirror 6）：量基准线落在哪页、哪个字；偏移 ↔「阅读高度」；把某页某处滚到基准线。
 * 入参是 CodeMirror 6 的 EditorView（这里只按用到的几样写成结构类型，core 不依赖 CodeMirror 包）；插件的 markdown-pane.ts 调用它。
 * 旧格式文件（只有印刷页锚点 <!--p.M-->）按 setLegacyOffset 给的 printedPageOffset 换算物理页；缺页停在前一页段末尾。
 */
import { footnoteRanges, pageAtOffset, pageSegments, parseAnchors, segmentForPageOrGap, type Anchor, type PageSegment } from "./anchors";
import { baselineY, clamp01, fractionWithin, heightInBlock, type PagePoint } from "./sync-math";

/** EditorView 里用到的部分 */
interface LineBlock {
  from: number;
  to: number;
  top: number;
  height: number;
}

interface Coords {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface CmDoc {
  readonly length: number;
  toString(): string;
}

export interface EditorView {
  readonly state: { readonly doc: CmDoc };
  readonly scrollDOM: HTMLElement;
  readonly contentDOM: HTMLElement;
  readonly documentTop: number;
  /** 正文一行的行距（像素） */
  readonly defaultLineHeight: number;
  readonly viewport: { readonly from: number; readonly to: number };
  lineBlockAt(pos: number): LineBlock;
  lineBlockAtHeight(height: number): LineBlock;
  coordsAtPos(pos: number, side?: -1 | 1): Coords | null;
}

export interface Parsed {
  text: string;
  anchors: Anchor[];
  segments: PageSegment[];
  lineStarts: number[];
  /** 脚注定义的区间（章末注释），按起点排序 */
  notes: Array<[number, number]>;
}

/**
 * 正文窗格一侧的度量，逐行跟随用（见 core/line-sync.ts）。高度都是文档坐标（像素，文档顶为 0），不随滚动变。
 * 一次跟随建一个、用完即弃：里面记着这一刻量到的版面。
 */
export interface MarkdownGeometry {
  /** 偏移处的阅读高度：所在显示行的顶 + 行高 × 该字在行内的横向位置；量不到（阅读视图里还没渲染）返回 null */
  heightAt(offset: number): number | null;
  /** 基准线的文档高度 */
  baseline(ratio: number): number;
  /** 阅读高度 height 处的偏移；量不到返回 null */
  offsetAt(height: number): number | null;
  /** 把阅读高度 height 滚到基准线 */
  scrollTo(height: number, ratio: number): void;
}

let parsedByDoc = new WeakMap<CmDoc, Parsed>();
const parsedByString = new Map<string, Parsed>();
/** 当前这本书的 printedPageOffset：旧格式文件（只有印刷页锚点）据此换算物理页 */
let legacyOffset: number | null = null;

/** 换书时设；书没有 printedPageOffset 给 null。变了就清缓存 */
export function setLegacyOffset(offset: number | null): void {
  if (offset === legacyOffset) return;
  legacyOffset = offset;
  parsedByDoc = new WeakMap();
  parsedByString.clear();
}

function lineStartsOf(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

function parse(text: string): Parsed {
  const anchors = parseAnchors(text, legacyOffset);
  return { text, anchors, segments: pageSegments(text, anchors), lineStarts: lineStartsOf(text), notes: footnoteRanges(text) };
}

/** 按 CodeMirror 的 doc 对象缓存（每次编辑换新对象） */
export function parsedDoc(doc: CmDoc): Parsed {
  let parsed = parsedByDoc.get(doc);
  if (!parsed) {
    parsed = parse(doc.toString());
    parsedByDoc.set(doc, parsed);
  }
  return parsed;
}

/** 按全文缓存（只留最近一份） */
export function parsedText(text: string): Parsed {
  let parsed = parsedByString.get(text);
  if (!parsed) {
    parsed = parse(text);
    parsedByString.clear();
    parsedByString.set(text, parsed);
  }
  return parsed;
}

export interface MarkdownPoint extends PagePoint {
  offset: number;
  printed: string | null;
}

/**
 * 阅读高度：以偏移所在显示行（折行后的一行）的正中为准，按该字在行内的横向位置在一个行距里摊开：
 * 行首的字在正中往上半个行距，行中间的字正在正中，行尾接上下一行的行首。阅读线压在一行正中，就是读到这行中间。
 * 行距取正文行距与这一行字高的大者（标题字大）。视口外没渲染的行量不到字的位置，按段内字数比例估。
 */
function readingHeightIn(cm: EditorView, pos: number, content: DOMRect): number {
  const at = Math.max(0, Math.min(pos, cm.state.doc.length));
  if (at >= cm.viewport.from && at <= cm.viewport.to) {
    const coords = cm.coordsAtPos(at, 1) ?? cm.coordsAtPos(at, -1);
    if (coords) {
      const across = content.width > 0 ? clamp01((coords.left - content.left) / content.width) : 0;
      const pitch = Math.max(coords.bottom - coords.top, cm.defaultLineHeight);
      return (coords.top + coords.bottom) / 2 - cm.documentTop + pitch * (across - 0.5);
    }
  }
  const block = cm.lineBlockAt(at);
  return heightInBlock(at, block.from, block.to, block.top, block.height);
}

/** 阅读高度 height 处的偏移：在所在文档行里二分，找最后一个阅读高度不超过它的字 */
function offsetAtHeightIn(cm: EditorView, height: number, content: DOMRect): number {
  const block = cm.lineBlockAtHeight(height);
  let low = block.from;
  let high = block.to;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (readingHeightIn(cm, mid, content) <= height) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** 编辑视图（源码、实时预览）的度量 */
export function cmGeometry(cm: EditorView): MarkdownGeometry {
  const content = cm.contentDOM.getBoundingClientRect();
  const rect = cm.scrollDOM.getBoundingClientRect();
  return {
    heightAt: (offset) => readingHeightIn(cm, offset, content),
    baseline: (ratio) => baselineY(rect.top, rect.height, ratio) - cm.documentTop,
    offsetAt: (height) => offsetAtHeightIn(cm, height, content),
    scrollTo: (height, ratio) => {
      const delta = height + cm.documentTop - baselineY(rect.top, rect.height, ratio);
      if (Math.abs(delta) >= 1) cm.scrollDOM.scrollTop += delta;
    }
  };
}

/** 基准线处在哪一页、哪个字（offset）、页内多少 */
export function markdownPointAt(cm: EditorView, ratio: number): MarkdownPoint | null {
  const parsed = parsedDoc(cm.state.doc);
  if (!parsed.segments.length) return null;
  const geometry = cmGeometry(cm);
  const height = geometry.baseline(ratio);
  const offset = geometry.offsetAt(height) ?? 0;
  const at = pageAtOffset(parsed.text, offset, parsed.anchors, parsed.segments, parsed.notes);
  if (!at) return null;
  const fraction = fractionWithin(height, geometry.heightAt(at.from) ?? 0, geometry.heightAt(at.to) ?? 0);
  return { page: at.page, fraction, offset, printed: at.printed };
}

/** 把第 page 页的 fraction 处（按页段的阅读高度比例）滚到基准线；本文件没有这一页返回 false */
export function scrollMarkdownTo(cm: EditorView, point: PagePoint, ratio: number): boolean {
  const parsed = parsedDoc(cm.state.doc);
  const found = segmentForPageOrGap(parsed.segments, point.page);
  if (!found) return false;
  const { segment } = found;
  // 缺页（约定：两个锚点之间缺的页算前一页）：停在前一页段的末尾
  const fraction = found.gap ? 1 : point.fraction;
  const geometry = cmGeometry(cm);
  const top = geometry.heightAt(segment.from) ?? 0;
  const bottom = geometry.heightAt(segment.to) ?? top;
  geometry.scrollTo(top + (bottom - top) * fraction, ratio);
  return true;
}

/** 把文档里某个偏移滚到基准线 */
export function scrollOffsetToBaseline(cm: EditorView, offset: number, ratio: number): void {
  const geometry = cmGeometry(cm);
  geometry.scrollTo(geometry.heightAt(offset) ?? 0, ratio);
}
