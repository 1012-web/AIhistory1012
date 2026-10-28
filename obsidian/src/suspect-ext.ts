/**
 * CodeMirror 6 扩展：正文里标出没判的疑字（波浪下划线；正文漏字处是一个小「∅」记号），
 * 悬停弹出判字卡片（CodeMirror 自带的 hoverTooltip）。标记的位置由宿主算好经 setSuspectMarks 送进来，
 * 之后随编辑自动挪；用户直接改了那个字，标记就撤掉。
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { closeHoverTooltips, Decoration, EditorView, hoverTooltip, WidgetType, type DecorationSet } from "@codemirror/view";

export interface SuspectMark {
  from: number;
  to: number;
  key: string;
  doubt: boolean;
}

export const setSuspectMarks = StateEffect.define<SuspectMark[]>();

class GapWidget extends WidgetType {
  constructor(private readonly key: string, private readonly doubt: boolean) {
    super();
  }

  eq(other: GapWidget): boolean {
    return other.key === this.key && other.doubt === this.doubt;
  }

  toDOM(): HTMLElement {
    return createSpan({ cls: `aps-suspect-gap${this.doubt ? " is-doubt" : ""}`, text: "∅", attr: { "data-aps-suspect": this.key, "aria-label": "这里可能漏了字" } });
  }
}

function decorationsOf(marks: SuspectMark[]): DecorationSet {
  const ranges = marks
    .slice()
    .sort((a, b) => a.from - b.from || a.to - b.to)
    .map((mark) => (mark.from === mark.to
      ? Decoration.widget({ widget: new GapWidget(mark.key, mark.doubt), side: 1 }).range(mark.from)
      : Decoration.mark({ class: `aps-suspect${mark.doubt ? " is-doubt" : ""}`, attributes: { "data-aps-suspect": mark.key } }).range(mark.from, mark.to)));
  return Decoration.set(ranges, true);
}

interface MarkState {
  marks: SuspectMark[];
  decorations: DecorationSet;
}

const markField = StateField.define<MarkState>({
  create: () => ({ marks: [], decorations: Decoration.none }),
  update(value, transaction) {
    let marks = value.marks;
    let changed = false;
    if (transaction.docChanged && marks.length) {
      const changes = transaction.changes;
      marks = marks
        .filter((mark) => !changes.touchesRange(mark.from, mark.to) || mark.from === mark.to)
        .map((mark) => ({ ...mark, from: changes.mapPos(mark.from, 1), to: changes.mapPos(mark.to, mark.from === mark.to ? 1 : -1) }));
      changed = true;
    }
    for (const effect of transaction.effects) {
      if (effect.is(setSuspectMarks)) {
        marks = effect.value;
        changed = true;
      }
    }
    return changed ? { marks, decorations: decorationsOf(marks) } : value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
});

export interface SuspectExtensionOptions {
  enabled: () => boolean;
  /** 悬停卡片；close 关掉卡片 */
  card: (key: string, close: () => void) => HTMLElement | null;
}

export function suspectExtensions(options: SuspectExtensionOptions): Extension[] {
  const tooltip = hoverTooltip((view, pos) => {
    if (!options.enabled()) return null;
    const mark = view.state.field(markField).marks.find((candidate) => (candidate.from === candidate.to
      ? Math.abs(candidate.from - pos) <= 1
      : candidate.from <= pos && pos <= candidate.to));
    if (!mark) return null;
    return {
      pos: mark.from,
      end: mark.to,
      above: true,
      create: () => {
        const dom = options.card(mark.key, () => view.dispatch({ effects: closeHoverTooltips })) ?? createDiv({ text: "这一条已不在清单里" });
        return { dom };
      }
    };
  }, { hoverTime: 350 });
  return [markField, tooltip];
}

/** 送进一组标记（换书、清单改了、开了新文件时由宿主调用） */
export function pushSuspectMarks(view: EditorView, marks: SuspectMark[]): void {
  view.dispatch({ effects: setSuspectMarks.of(marks) });
}
