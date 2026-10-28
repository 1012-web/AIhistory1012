/**
 * CodeMirror 6 扩展：当前页标示（按页校改 A 式）；实时预览里把锚点显示成小页码标签。
 *
 * 当前页标示用 CodeMirror 自带的图层（layer）和 RectangleMarker 画，画法与选区相同：从本页锚点那个字起、
 * 到下一页锚点止，锚点夹在段中也从段中起止，中间整行涂满。以前按编辑器的行涂，一个自然段就是一行，会把前后页的半段一起涂上。
 */
import { EditorSelection, RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, layer, RectangleMarker, ViewPlugin, WidgetType, type DecorationSet, type LayerMarker, type ViewUpdate } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import { segmentForPage } from "./core/anchors";
import { parsedDoc } from "./markdown-pane";
import type { ShadeStyle } from "./settings";

export const setCurrentPage = StateEffect.define<number | null>();
/** 设置改了（标签开关、标示样式）：让标签与标示重画 */
export const refreshLabels = StateEffect.define<null>();

/** 当前页：控制器经 setCurrentPage 设 */
const currentPage = StateField.define<number | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setCurrentPage)) value = effect.value;
    return value;
  }
});

/** 本页在文档里的区间：从本页锚点起，到下一页锚点止，去掉页末的空行 */
export function pageRange(doc: Text, page: number): { from: number; to: number } | null {
  const segment = segmentForPage(parsedDoc(doc).segments, page);
  if (!segment) return null;
  const to = segment.from + doc.sliceString(segment.from, segment.to).trimEnd().length;
  return to > segment.from ? { from: segment.from, to } : null;
}

/** 左侧竖条：离正文左缘多远、多宽（像素） */
const BAR_GAP = 8;
const BAR_WIDTH = 2;

function shadeMarkers(view: EditorView, style: ShadeStyle): readonly LayerMarker[] {
  const page = view.state.field(currentPage, false);
  if (page === null || page === undefined || style === "off") return [];
  const range = pageRange(view.state.doc, page);
  if (!range) return [];
  const rects = RectangleMarker.forRange(view, "aps-current-page", EditorSelection.range(range.from, range.to));
  if (style !== "bar" || !rects.length) return rects;
  const top = Math.min(...rects.map((rect) => rect.top));
  const bottom = Math.max(...rects.map((rect) => rect.top + rect.height));
  const left = Math.min(...rects.map((rect) => rect.left));
  return [new RectangleMarker("aps-current-page-bar", left - BAR_GAP, top, BAR_WIDTH, bottom - top)];
}

class PageLabelWidget extends WidgetType {
  constructor(private readonly page: number, private readonly printed: string | null, private readonly onClick: (page: number) => void) {
    super();
  }

  eq(other: PageLabelWidget): boolean {
    return other.page === this.page && other.printed === this.printed;
  }

  toDOM(): HTMLElement {
    const label = createSpan({ cls: "aps-page-label", attr: { "data-page": String(this.page), "aria-label": `PDF 第 ${this.page} 页` } });
    label.setText(this.printed ? `${this.page} · p.${this.printed}` : `${this.page}`);
    label.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onClick(this.page);
    });
    return label;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const LABEL_RE = /<!--\s*pdf-page\.(\d+)\s*-->(?:[ \t]*<!--\s*p\.([^\s>-][^\s>]*?)\s*-->)?/g;

function labelDecorations(view: EditorView, onClick: (page: number) => void): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  if (!view.state.field(editorLivePreviewField, false)) return builder.finish();
  const selection = view.state.selection;
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    for (const match of text.matchAll(LABEL_RE)) {
      const start = from + match.index;
      const end = start + match[0].length;
      // 光标碰到锚点时显示源码，便于修改
      if (selection.ranges.some((range) => range.from <= end && range.to >= start)) continue;
      builder.add(start, end, Decoration.replace({ widget: new PageLabelWidget(Number(match[1]), match[2] ?? null, onClick) }));
    }
  }
  return builder.finish();
}

function refreshed(update: ViewUpdate): boolean {
  return update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshLabels)));
}

export interface EditorExtensionOptions {
  labels: () => boolean;
  shade: () => ShadeStyle;
  onLabelClick: (page: number) => void;
}

export function editorExtensions(options: EditorExtensionOptions): Extension[] {
  const labels = ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = options.labels() ? labelDecorations(view, options.onLabelClick) : Decoration.none;
    }

    update(update: ViewUpdate): void {
      const livePreviewChanged = update.startState.field(editorLivePreviewField, false) !== update.state.field(editorLivePreviewField, false);
      if (update.docChanged || update.viewportChanged || update.selectionSet || livePreviewChanged || refreshed(update)) {
        this.decorations = options.labels() ? labelDecorations(update.view, options.onLabelClick) : Decoration.none;
      }
    }
  }, { decorations: (plugin) => plugin.decorations });
  const shade = layer({
    above: false,
    class: "aps-page-shade",
    markers: (view) => shadeMarkers(view, options.shade()),
    update: (update) => update.docChanged || update.viewportChanged || update.geometryChanged || update.selectionSet || refreshed(update) || update.startState.field(currentPage, false) !== update.state.field(currentPage, false)
  });
  return [currentPage, shade, labels];
}
