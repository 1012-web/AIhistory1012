/**
 * 正文一侧的跟随（CodeMirror 6）：量基准线落在哪页、页内多少；把某页某处滚到基准线。
 * 入参是 CodeMirror 6 的 EditorView（这里只按用到的几样写成结构类型，core 不依赖 CodeMirror 包，免得插件与网页各装一份时类型对不上）；网页工作台直接用。插件（markdown-pane.ts）与网页工作台共用。
 * 旧格式文件（只有印刷页锚点 <!--p.M-->）按 setLegacyOffset 给的 printedPageOffset 换算物理页；缺页停在前一页段末尾。
 */
import { pageAtOffset, pageSegments, parseAnchors, segmentForPageOrGap, type Anchor, type PageSegment } from "./anchors";
import { baselineY, fractionWithin, heightInBlock, posInBlock, type PagePoint } from "./sync-math";

/** EditorView 里用到的部分 */
interface LineBlock {
  from: number;
  to: number;
  top: number;
  height: number;
}

export interface CmDoc {
  readonly length: number;
  toString(): string;
}

export interface EditorView {
  readonly state: { readonly doc: CmDoc };
  readonly scrollDOM: HTMLElement;
  readonly documentTop: number;
  lineBlockAt(pos: number): LineBlock;
  lineBlockAtHeight(height: number): LineBlock;
}

export interface Parsed {
  text: string;
  anchors: Anchor[];
  segments: PageSegment[];
  lineStarts: number[];
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
  return { text, anchors, segments: pageSegments(text, anchors), lineStarts: lineStartsOf(text) };
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

function heightOf(cm: EditorView, pos: number): number {
  const block = cm.lineBlockAt(Math.min(pos, cm.state.doc.length));
  return heightInBlock(pos, block.from, block.to, block.top, block.height);
}

/** 基准线处在哪一页、页内多少 */
export function markdownPointAt(cm: EditorView, ratio: number): MarkdownPoint | null {
  const parsed = parsedDoc(cm.state.doc);
  if (!parsed.segments.length) return null;
  const rect = cm.scrollDOM.getBoundingClientRect();
  const docHeight = baselineY(rect.top, rect.height, ratio) - cm.documentTop;
  const block = cm.lineBlockAtHeight(docHeight);
  const offset = posInBlock(docHeight, block.from, block.to, block.top, block.height);
  const at = pageAtOffset(parsed.text, offset, parsed.anchors, parsed.segments);
  if (!at) return null;
  const fraction = fractionWithin(docHeight, heightOf(cm, at.from), heightOf(cm, at.to));
  return { page: at.page, fraction, offset, printed: at.printed };
}

/** 把第 page 页的 fraction 处滚到基准线；本文件没有这一页返回 false */
export function scrollMarkdownTo(cm: EditorView, point: PagePoint, ratio: number): boolean {
  const parsed = parsedDoc(cm.state.doc);
  const found = segmentForPageOrGap(parsed.segments, point.page);
  if (!found) return false;
  const { segment } = found;
  // 缺页（约定：两个锚点之间缺的页算前一页）：停在前一页段的末尾
  const fraction = found.gap ? 1 : point.fraction;
  const top = heightOf(cm, segment.from);
  const target = top + (heightOf(cm, segment.to) - top) * fraction;
  const rect = cm.scrollDOM.getBoundingClientRect();
  const delta = target + cm.documentTop - baselineY(rect.top, rect.height, ratio);
  if (Math.abs(delta) >= 1) cm.scrollDOM.scrollTop += delta;
  return true;
}

/** 把文档里某个偏移滚到基准线 */
export function scrollOffsetToBaseline(cm: EditorView, offset: number, ratio: number): void {
  const rect = cm.scrollDOM.getBoundingClientRect();
  const delta = heightOf(cm, offset) + cm.documentTop - baselineY(rect.top, rect.height, ratio);
  if (Math.abs(delta) >= 1) cm.scrollDOM.scrollTop += delta;
}
