"use client";
/**
 * 正文一侧：CodeMirror 6 编辑器。对外是命令式句柄：换文档、量基准线、滚到某页、选中某段、设当前页底色。
 */
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { markdownPointAt, parsedDoc, scrollMarkdownTo, scrollOffsetToBaseline, type MarkdownPoint } from "@/s3/core";
import { currentPageExtension, pageLabels as labelExtension, setCurrentPage, suspectLinks } from "./extensions";
import type { PagePoint } from "@/s3/core";

export interface EditorSelectionInfo {
  from: number;
  to: number;
  text: string;
  doc: string;
}

export interface EditorHandle {
  readonly view: EditorView | null;
  /** 换成另一份文档（换文件时用）：滚动与光标重置 */
  reset(text: string): void;
  /** 磁盘上改了：只替换不同的那一段，尽量保住滚动位置与光标 */
  merge(text: string): void;
  getText(): string;
  pointAtBaseline(): MarkdownPoint | null;
  scrollToPoint(point: PagePoint): boolean;
  setCurrentPage(page: number | null): void;
  select(from: number, to: number, reveal: boolean): void;
  scrollOffsetToBaseline(offset: number): void;
}

interface Props {
  ratio: number;
  /** 锚点显示成页码小标签 */
  pageLabels: boolean;
  /** 当前页加浅底色 */
  shade: boolean;
  onDocChange: (text: string) => void;
  onScroll: () => void;
  onUserInput: () => void;
  onSelection: (selection: EditorSelectionInfo | null) => void;
  onPageLabel: (page: number) => void;
  onSuspectLink: (uri: string) => void;
}

/** 设置里能开关的两样，各占一个可替换的槽 */
const shadeSlot = new Compartment();
const labelSlot = new Compartment();

const markdownStyle = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.45em", fontWeight: "700" },
  { tag: tags.heading2, fontSize: "1.25em", fontWeight: "700" },
  { tag: tags.heading3, fontSize: "1.1em", fontWeight: "700" },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: [tags.link, tags.url], color: "var(--accent)" },
  { tag: [tags.processingInstruction, tags.meta, tags.comment], color: "var(--muted)" },
  { tag: tags.monospace, fontFamily: "var(--font-mono)" },
]);

/** 公共前后缀以外的部分作为一次改动 */
function minimalChange(oldText: string, newText: string): { from: number; to: number; insert: string } | null {
  if (oldText === newText) return null;
  let start = 0;
  const max = Math.min(oldText.length, newText.length);
  while (start < max && oldText.charCodeAt(start) === newText.charCodeAt(start)) start += 1;
  let endOld = oldText.length;
  let endNew = newText.length;
  while (endOld > start && endNew > start && oldText.charCodeAt(endOld - 1) === newText.charCodeAt(endNew - 1)) {
    endOld -= 1;
    endNew -= 1;
  }
  return { from: start, to: endOld, insert: newText.slice(start, endNew) };
}

export const EditorPane = forwardRef<EditorHandle, Props>(function EditorPane(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  /** 程序改文档时不算用户编辑 */
  const silent = useRef(false);
  /** 编辑器还没建好时交来的文档，建好时用它 */
  const pending = useRef<string | null>(null);

  const extensions = useRef<Extension[]>([
    history(),
    drawSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    // frontmatter 按 YAML 认，免得结尾的 --- 被当成 Setext 标题把整块加粗
    yamlFrontmatter({ content: markdown() }),
    syntaxHighlighting(markdownStyle),
    EditorView.lineWrapping,
    shadeSlot.of(currentPageExtension()),
    labelSlot.of(labelExtension((page) => callbacks.current.onPageLabel(page))),
    suspectLinks((uri) => callbacks.current.onSuspectLink(uri)),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !silent.current) callbacks.current.onDocChange(update.state.doc.toString());
      if (update.selectionSet || update.docChanged) {
        const range = update.state.selection.main;
        callbacks.current.onSelection(
          range.empty ? null : { from: range.from, to: range.to, text: update.state.sliceDoc(range.from, range.to), doc: update.state.doc.toString() }
        );
      }
    }),
    EditorView.contentAttributes.of({ "aria-label": "正文", spellcheck: "false" }),
  ]);

  useEffect(() => {
    const view = new EditorView({ parent: host.current!, state: EditorState.create({ doc: pending.current ?? "", extensions: extensions.current }) });
    pending.current = null;
    applySlots(view);
    viewRef.current = view;
    // 端到端测试读编辑器状态用（只在本机页面里，无害）
    (window as unknown as { __aihEditor?: EditorView }).__aihEditor = view;
    const scroller = view.scrollDOM;
    const input = () => callbacks.current.onUserInput();
    const scroll = () => callbacks.current.onScroll();
    scroller.addEventListener("wheel", input, { passive: true });
    scroller.addEventListener("pointerdown", input);
    view.contentDOM.addEventListener("keydown", input);
    scroller.addEventListener("scroll", scroll, { passive: true });
    return () => {
      scroller.removeEventListener("wheel", input);
      scroller.removeEventListener("pointerdown", input);
      scroller.removeEventListener("scroll", scroll);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // 设置改了：换掉对应槽里的扩展（当前页底色关掉时页码仍照常跟随，只是不画）。换文档后也要重新套一次
  const applySlots = (view: EditorView) =>
    view.dispatch({
      effects: [
        shadeSlot.reconfigure(callbacks.current.shade ? currentPageExtension() : []),
        labelSlot.reconfigure(callbacks.current.pageLabels ? labelExtension((page) => callbacks.current.onPageLabel(page)) : []),
      ],
    });
  useEffect(() => {
    if (viewRef.current) applySlots(viewRef.current);
  }, [props.shade, props.pageLabels]);

  useImperativeHandle(
    ref,
    (): EditorHandle => ({
      get view() {
        return viewRef.current;
      },
      reset(text) {
        const view = viewRef.current;
        if (!view) {
          pending.current = text;
          return;
        }
        silent.current = true;
        view.setState(EditorState.create({ doc: text, extensions: extensions.current }));
        applySlots(view);
        silent.current = false;
        view.scrollDOM.scrollTop = 0;
      },
      merge(text) {
        const view = viewRef.current;
        if (!view) return;
        const change = minimalChange(view.state.doc.toString(), text);
        if (!change) return;
        silent.current = true;
        view.dispatch({ changes: change, userEvent: "external" });
        silent.current = false;
      },
      getText() {
        return viewRef.current?.state.doc.toString() ?? "";
      },
      pointAtBaseline() {
        const view = viewRef.current;
        return view ? markdownPointAt(view, callbacks.current.ratio) : null;
      },
      scrollToPoint(point) {
        const view = viewRef.current;
        return view ? scrollMarkdownTo(view, point, callbacks.current.ratio) : false;
      },
      setCurrentPage(page) {
        viewRef.current?.dispatch({ effects: setCurrentPage.of(page) });
      },
      select(from, to, reveal) {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ selection: EditorSelection.single(from, to) });
        if (reveal) scrollOffsetToBaseline(view, from, callbacks.current.ratio);
      },
      scrollOffsetToBaseline(offset) {
        const view = viewRef.current;
        if (view) scrollOffsetToBaseline(view, offset, callbacks.current.ratio);
      },
    }),
    []
  );

  return <div ref={host} className="aih-editor h-full w-full" data-testid="editor-pane" />;
});

export { parsedDoc };
