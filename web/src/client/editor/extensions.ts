/**
 * CodeMirror 扩展：
 *   - 当前页正文加浅底色（按页校改 A 式，计划「插件」第 4 条）；
 *   - 物理页锚点显示成小页码标签，点击跳 PDF（第 6 条）；光标进到锚点里时露出原文，便于改；
 *   - Ctrl/⌘ + 点击疑字清单里的 obsidian://aihistory-pdf-sync 链接，在网页里打开（第 8 条）。
 * 插件里对应的是 S3 的 editor-ext.ts（它连着 Obsidian 的实时预览），这里按网页的需要另写。
 */
import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { segmentForPage } from "@/s3/core";
import { parsedDoc } from "@/s3/core";

export const setCurrentPage = StateEffect.define<number | null>();

const currentPageField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setCurrentPage)) return effect.value;
    return value;
  },
});

const pageLine = Decoration.line({ class: "aih-current-page" });
const pageMark = Decoration.mark({ class: "aih-current-page-text" });

/** 当前页：页段覆盖的整行加底色；首尾不满一行的部分（锚点在段中）只给文字加底色 */
const currentPageDecorations = EditorView.decorations.compute([currentPageField, "doc"], (state) => {
  const page = state.field(currentPageField);
  if (page === null) return Decoration.none;
  const segment = segmentForPage(parsedDoc(state.doc).segments, page);
  if (!segment || segment.to <= segment.from) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const first = state.doc.lineAt(segment.from);
  const last = state.doc.lineAt(Math.max(segment.from, segment.to - 1));
  for (let n = first.number; n <= last.number; n += 1) {
    const line = state.doc.line(n);
    const whole = line.from >= segment.from && line.to <= segment.to;
    if (whole) builder.add(line.from, line.from, pageLine);
    else {
      const from = Math.max(line.from, segment.from);
      const to = Math.min(line.to, segment.to);
      if (to > from) builder.add(from, to, pageMark);
    }
  }
  return builder.finish();
});

class PageLabel extends WidgetType {
  constructor(readonly page: number, readonly printed: string | null) {
    super();
  }
  override eq(other: PageLabel): boolean {
    return other.page === this.page && other.printed === this.printed;
  }
  toDOM(): HTMLElement {
    const label = document.createElement("span");
    label.className = "aih-page-label";
    label.dataset.page = String(this.page);
    label.title = `PDF 第 ${this.page} 页${this.printed ? `（原书 p.${this.printed}）` : ""}；点击让 PDF 翻到这页，光标移进来可改锚点`;
    label.textContent = this.printed ? `${this.page} · p.${this.printed}` : `${this.page}`;
    return label;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

function labelDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { anchors } = parsedDoc(view.state.doc);
  const selection = view.state.selection.main;
  for (const anchor of anchors) {
    // 光标或选区碰到锚点时露出原文
    if (selection.from <= anchor.end && selection.to >= anchor.from) continue;
    builder.add(anchor.from, anchor.end, Decoration.replace({ widget: new PageLabel(anchor.page, anchor.printed) }));
  }
  return builder.finish();
}

export function pageLabels(onClick: (page: number) => void): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = labelDecorations(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) this.decorations = labelDecorations(update.view);
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
      eventHandlers: {
        mousedown(event) {
          const target = event.target as HTMLElement;
          if (!target.classList.contains("aih-page-label")) return false;
          event.preventDefault();
          onClick(Number(target.dataset.page));
          return true;
        },
      },
    }
  );
}

const SUSPECT_LINK_RE = /obsidian:\/\/aihistory-pdf-sync\?[^\s)\]>"']+/g;

/** Ctrl/⌘ + 点击疑字清单链接 */
export function suspectLinks(onOpen: (uri: string) => void): Extension {
  const mark = Decoration.mark({ class: "aih-suspect-link", attributes: { title: "Ctrl/⌘ + 点击：在工作台里跳到这页这个字" } });
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = this.build(view);
        }
        update(update: ViewUpdate) {
          if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view);
        }
        build(view: EditorView): DecorationSet {
          const builder = new RangeSetBuilder<Decoration>();
          for (const { from, to } of view.visibleRanges) {
            const text = view.state.doc.sliceString(from, to);
            for (const match of text.matchAll(SUSPECT_LINK_RE)) builder.add(from + match.index, from + match.index + match[0].length, mark);
          }
          return builder.finish();
        }
      },
      { decorations: (plugin) => plugin.decorations }
    ),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!(event.ctrlKey || event.metaKey)) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        const line = view.state.doc.lineAt(pos);
        for (const match of line.text.matchAll(SUSPECT_LINK_RE)) {
          const from = line.from + match.index;
          if (pos >= from && pos <= from + match[0].length) {
            event.preventDefault();
            onOpen(match[0]);
            return true;
          }
        }
        return false;
      },
    }),
  ];
}

export function currentPageExtension(): Extension {
  return [currentPageField, currentPageDecorations];
}
