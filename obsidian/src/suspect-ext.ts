/**
 * CodeMirror 6 扩展：正文里标出没判的疑字（波浪下划线；正文漏字处是一个小「∅」记号），
 * 悬停弹出判字卡片（CodeMirror 自带的 hoverTooltip）。标记的位置由宿主算好经 setSuspectMarks 送进来，
 * 之后随编辑自动挪；用户直接改了那个字，标记就撤掉。
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { closeHoverTooltips, Decoration, EditorView, hoverTooltip, showTooltip, WidgetType, type DecorationSet, type TooltipView } from "@codemirror/view";

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

/**
 * 钉住的卡片：悬停卡片随鼠标进出开关，点进自填框打字时，鼠标一挪或输入法候选窗盖住鼠标，
 * 卡片就被当成「鼠标离开」收起，打到一半的字也没了。用户一在卡片里点输入框、拖原图条，
 * 就把同一张卡片（同一个 DOM，字和焦点都留着）转成钉住的提示，只在按 Esc、点卡片外、定了字时关。
 */
interface PinnedCard {
  from: number;
  to: number;
  key: string;
  dom: HTMLElement;
  /** 钉住时正在用（或正要点进）的输入框：挪进新浮层会丢焦点，挂好后放回去 */
  input: HTMLInputElement | null;
}

const pinCard = StateEffect.define<PinnedCard | null>();

const pinnedField = StateField.define<PinnedCard | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(pinCard)) return effect.value;
    if (value && transaction.docChanged) return { ...value, from: transaction.changes.mapPos(value.from), to: transaction.changes.mapPos(value.to) };
    return value;
  },
  provide: (field) => showTooltip.from(field, (pinned) => (pinned ? {
    pos: pinned.from,
    end: pinned.to,
    above: true,
    create: (view) => pinnedView(view, pinned.dom, pinned.input)
  } : null))
});

/** 外层浮层的边框、圆角由样式按这个类给（社区目录不收 :has 选择器） */
function markShell(dom: HTMLElement): void {
  dom.closest(".cm-tooltip")?.addClass("aps-suspect-tooltip");
}

function pinnedView(view: EditorView, dom: HTMLElement, input: HTMLInputElement | null): TooltipView {
  const unpin = () => view.dispatch({ effects: pinCard.of(null) });
  const onOutside = (event: PointerEvent) => {
    if (!dom.contains(event.target as Node)) unpin();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    unpin();
    view.focus();
  };
  return {
    dom,
    mount: () => {
      markShell(dom);
      // 点输入框那一下的默认聚焦可能落在挪动之前：等这一轮事件过完再看一眼
      if (input) window.setTimeout(() => {
        if (input.isConnected && dom.ownerDocument.activeElement !== input) input.focus();
      }, 0);
      dom.ownerDocument.addEventListener("pointerdown", onOutside, true);
      dom.addEventListener("keydown", onKey);
    },
    destroy: () => {
      dom.ownerDocument.removeEventListener("pointerdown", onOutside, true);
      dom.removeEventListener("keydown", onKey);
    }
  };
}

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
    // 这一条已经钉着一张卡片了，不再叠一张悬停的
    if (!mark || view.state.field(pinnedField)?.key === mark.key) return null;
    return {
      pos: mark.from,
      end: mark.to,
      above: true,
      create: () => {
        const close = () => view.dispatch({ effects: [closeHoverTooltips, pinCard.of(null)] });
        const dom = options.card(mark.key, close) ?? createDiv({ text: "这一条已不在清单里" });
        const pin = (event: Event) => {
          const target = event.target as HTMLElement;
          // 按钮点了就生效、卡片随之关，不用钉；点输入框、拖原图条要钉住
          if (target.closest("button") || view.state.field(pinnedField)?.dom === dom) return;
          if (event.type === "pointerdown" && !target.closest("input, .aps-suspect-strip")) return;
          const input = target.closest("input");
          view.dispatch({ effects: [pinCard.of({ from: mark.from, to: mark.to, key: mark.key, dom, input }), closeHoverTooltips] });
        };
        dom.addEventListener("pointerdown", pin);
        dom.addEventListener("focusin", pin);
        return { dom, mount: () => markShell(dom) };
      }
    };
  }, { hoverTime: 350 });
  return [markField, pinnedField, tooltip];
}

/** 送进一组标记（换书、清单改了、开了新文件时由宿主调用） */
export function pushSuspectMarks(view: EditorView, marks: SuspectMark[]): void {
  view.dispatch({ effects: setSuspectMarks.of(marks) });
}
