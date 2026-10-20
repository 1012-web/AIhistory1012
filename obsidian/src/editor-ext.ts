/**
 * CodeMirror 6 扩展：当前页浅底色（按页校改 A 式）；实时预览里把锚点显示成小页码标签。
 */
import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import { segmentForPage } from "./core/anchors";
import { parsedDoc } from "./markdown-pane";

export const setCurrentPage = StateEffect.define<number | null>();
/** 设置改了（标签开关）：让标签重画 */
export const refreshLabels = StateEffect.define<null>();

const shadeLine = Decoration.line({ class: "aps-current-page" });

function shadeDecorations(doc: EditorView["state"]["doc"], page: number | null): DecorationSet {
  if (page === null) return Decoration.none;
  const segment = segmentForPage(parsedDoc(doc).segments, page);
  if (!segment || segment.to <= segment.from) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const first = doc.lineAt(segment.from).number;
  const last = doc.lineAt(Math.max(segment.from, segment.to - 1)).number;
  for (let number = first; number <= last; number += 1) {
    const line = doc.line(number);
    builder.add(line.from, line.from, shadeLine);
  }
  return builder.finish();
}

interface ShadeState {
  page: number | null;
  decorations: DecorationSet;
}

const shadeField = StateField.define<ShadeState>({
  create: () => ({ page: null, decorations: Decoration.none }),
  update(value, transaction) {
    let page = value.page;
    let changed = transaction.docChanged;
    for (const effect of transaction.effects) {
      if (effect.is(setCurrentPage) && effect.value !== page) {
        page = effect.value;
        changed = true;
      }
    }
    if (!changed) return value;
    return { page, decorations: shadeDecorations(transaction.state.doc, page) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
});

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

export interface EditorExtensionOptions {
  labels: () => boolean;
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
      if (update.docChanged || update.viewportChanged || update.selectionSet || livePreviewChanged || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshLabels)))) {
        this.decorations = options.labels() ? labelDecorations(update.view, options.onLabelClick) : Decoration.none;
      }
    }
  }, { decorations: (plugin) => plugin.decorations });
  return [shadeField, labels];
}
