/**
 * 正文一侧：量基准线落在哪页、哪个字，偏移 ↔ 阅读高度（逐行跟随用），以及把某页某处滚到基准线。
 * 编辑（源码、实时预览）走 CodeMirror 6 的公开接口；阅读视图靠后处理器给各段落记下行号（getSectionInfo）。
 */
import { EditorView } from "@codemirror/view";
import { MarkdownView } from "obsidian";
import { pageAtOffset, segmentForPage, segmentForPageOrGap, type PageSegment } from "./core/anchors";
import { baselineY, clamp01, fractionWithin, type PagePoint } from "./core/sync-math";
import {
  cmGeometry,
  markdownPointAt as cmPointAt,
  parsedDoc,
  parsedText,
  scrollMarkdownTo as cmScrollTo,
  setLegacyOffset,
  type MarkdownGeometry,
  type MarkdownPoint,
  type Parsed
} from "./core/cm-sync";

export { parsedDoc, parsedText, setLegacyOffset, type MarkdownGeometry, type MarkdownPoint };

export const SECTION_ATTR = "apsLineStart";

export type MarkdownMode = "source" | "live" | "preview";

export function editorViewOf(view: MarkdownView): EditorView | null {
  const element = view.contentEl.querySelector<HTMLElement>(".cm-editor");
  return element ? EditorView.findFromDOM(element) : null;
}

export function modeOf(view: MarkdownView): MarkdownMode {
  if (view.getMode() === "preview") return "preview";
  const state = view.getState() as { source?: boolean };
  return state.source ? "source" : "live";
}


/** 正文窗格的滚动容器 */
export function scrollerOf(view: MarkdownView): HTMLElement | null {
  if (modeOf(view) === "preview") return view.contentEl.querySelector<HTMLElement>(".markdown-preview-view");
  return editorViewOf(view)?.scrollDOM ?? null;
}

/** 当前视图的全文解析：编辑视图按 CodeMirror 的 doc 缓存，阅读视图按全文缓存 */
export function parsedOf(view: MarkdownView): Parsed {
  if (modeOf(view) !== "preview") {
    const cm = editorViewOf(view);
    if (cm) return parsedDoc(cm.state.doc);
  }
  return parsedText(view.data);
}

/** 逐行跟随用的正文度量；一次跟随建一个，用完即弃 */
export function markdownGeometry(view: MarkdownView): MarkdownGeometry | null {
  if (modeOf(view) === "preview") return previewGeometry(view);
  const cm = editorViewOf(view);
  return cm ? cmGeometry(cm) : null;
}

/** 当前视图里基准线处在哪一页、哪个字 */
export function markdownPointAt(view: MarkdownView, ratio: number): MarkdownPoint | null {
  if (modeOf(view) === "preview") return previewPointAt(view, ratio);
  const cm = editorViewOf(view);
  return cm ? cmPointAt(cm, ratio) : null;
}

/** 把第 page 页的 fraction 处滚到基准线；本文件没有这一页返回 false */
export function scrollMarkdownTo(view: MarkdownView, point: PagePoint, ratio: number): boolean {
  if (modeOf(view) === "preview") return scrollPreviewTo(view, point, ratio);
  const cm = editorViewOf(view);
  return cm ? cmScrollTo(cm, point, ratio) : false;
}

/** 某页段在文档中的区间（编辑视图） */
export function segmentInEditor(view: MarkdownView, page: number): PageSegment | null {
  const cm = editorViewOf(view);
  if (!cm) return null;
  return segmentForPage(parsedDoc(cm.state.doc).segments, page);
}

// ---- 阅读视图 ----

interface SectionBox {
  element: HTMLElement;
  lineStart: number;
  lineEnd: number;
  top: number;
  bottom: number;
}

function sectionBoxes(view: MarkdownView): SectionBox[] {
  const out: SectionBox[] = [];
  for (const element of Array.from(view.contentEl.querySelectorAll<HTMLElement>(".markdown-preview-section [data-aps-line-start]"))) {
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0 && rect.width <= 0) continue;
    out.push({
      element,
      lineStart: Number(element.dataset.apsLineStart),
      lineEnd: Number(element.dataset.apsLineEnd),
      top: rect.top,
      bottom: rect.bottom
    });
  }
  return out.sort((a, b) => a.top - b.top);
}

function previewText(view: MarkdownView): Parsed {
  return parsedText(view.data);
}

function offsetOfLine(parsed: Parsed, line: number): number {
  const whole = Math.max(0, Math.min(parsed.lineStarts.length - 1, Math.floor(line)));
  const from = parsed.lineStarts[whole];
  const to = whole + 1 < parsed.lineStarts.length ? parsed.lineStarts[whole + 1] : parsed.text.length;
  return Math.round(from + (to - from) * (line - whole));
}

function lineOfOffset(parsed: Parsed, offset: number): number {
  let low = 0;
  let high = parsed.lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (parsed.lineStarts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  const from = parsed.lineStarts[low];
  const to = low + 1 < parsed.lineStarts.length ? parsed.lineStarts[low + 1] : parsed.text.length;
  return low + (to > from ? (offset - from) / (to - from) : 0);
}

/**
 * 阅读视图的度量：段落元素记着源码行号，段内按字数比例插值（一个自然段是源码里的一行）。
 * 阅读视图按需渲染，没渲染出来的段量不到，heightAt 给 null。
 */
function previewGeometry(view: MarkdownView): MarkdownGeometry | null {
  const scroller = scrollerOf(view);
  if (!scroller) return null;
  const parsed = previewText(view);
  const rect = scroller.getBoundingClientRect();
  const origin = rect.top - scroller.scrollTop;
  const boxes = sectionBoxes(view);
  return {
    heightAt(offset) {
      const line = lineOfOffset(parsed, offset);
      const box = boxes.find((item) => item.lineStart <= line && line < item.lineEnd + 1);
      if (!box) return null;
      const span = box.lineEnd + 1 - box.lineStart;
      return box.top + (box.bottom - box.top) * clamp01((line - box.lineStart) / span) - origin;
    },
    baseline: (ratio) => baselineY(rect.top, rect.height, ratio) - origin,
    offsetAt(height) {
      const y = height + origin;
      let box = boxes.find((item) => item.top <= y && y < item.bottom);
      box ??= [...boxes].reverse().find((item) => item.top <= y) ?? boxes[0];
      if (!box) return null;
      const span = box.lineEnd + 1 - box.lineStart;
      return offsetOfLine(parsed, box.lineStart + span * fractionWithin(y, box.top, box.bottom));
    },
    scrollTo(height, ratio) {
      const now = baselineY(rect.top, rect.height, ratio) - rect.top + scroller.scrollTop;
      if (Math.abs(height - now) >= 1) scroller.scrollTop += height - now;
    }
  };
}

function previewPointAt(view: MarkdownView, ratio: number): MarkdownPoint | null {
  const geometry = previewGeometry(view);
  const parsed = previewText(view);
  if (!geometry || !parsed.segments.length) return null;
  const offset = geometry.offsetAt(geometry.baseline(ratio));
  if (offset === null) return null;
  const at = pageAtOffset(parsed.text, offset, parsed.anchors, parsed.segments, parsed.notes);
  if (!at) return null;
  const fraction = at.to > at.from ? clamp01((offset - at.from) / (at.to - at.from)) : 0;
  return { page: at.page, fraction, offset, printed: at.printed };
}

function scrollPreviewTo(view: MarkdownView, point: PagePoint, ratio: number): boolean {
  const parsed = previewText(view);
  const found = segmentForPageOrGap(parsed.segments, point.page);
  const scroller = scrollerOf(view);
  if (!found || !scroller) return false;
  const { segment } = found;
  const offset = segment.from + (segment.to - segment.from) * (found.gap ? 1 : point.fraction);
  const line = lineOfOffset(parsed, offset);
  const box = sectionBoxes(view).find((item) => item.lineStart <= line && line < item.lineEnd + 1);
  if (!box) {
    // 目标段落还没渲染（阅读视图按需渲染）：先用公开接口滚到那一行附近，下一帧再精调
    view.previewMode.applyScroll(Math.max(0, line - 3));
    return true;
  }
  const rect = scroller.getBoundingClientRect();
  const span = box.lineEnd + 1 - box.lineStart;
  const y = box.top + (box.bottom - box.top) * Math.min(1, Math.max(0, (line - box.lineStart) / span));
  const delta = y - baselineY(rect.top, rect.height, ratio);
  if (Math.abs(delta) >= 1) scroller.scrollTop += delta;
  return true;
}

export function isMarkdownView(view: unknown): view is MarkdownView {
  return view instanceof MarkdownView;
}
