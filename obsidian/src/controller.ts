/**
 * 联动控制器：当前这本书、正文窗格、PDF 窗格三者的会话。
 *
 * 跟随：正文 → PDF 按页、页内按比例，基准线在视口距顶 35%；双向联动时 PDF → 正文（可跨文件）。
 * 防回环：领跑方取最近有输入（滚轮、按键、指针）的窗格；程序滚动后对侧静默约 200 毫秒。
 * 手动翻 PDF 时 PDF 领跑，正文不再带动它（跟随暂停）；回到正文一有输入就恢复。
 */
import { EditorView } from "@codemirror/view";
import { FileSystemAdapter, MarkdownView, Notice, TFile, type App, type WorkspaceLeaf } from "obsidian";
import { pageAtOffset, segmentForPage, segmentForPageOrGap } from "./core/anchors";
import { fileForPage, printedLabel, suggestedPageRange } from "./core/book-index";
import { setCurrentPage } from "./editor-ext";
import { PdfHighlighter, locateInSegment, selectionContext } from "./highlight";
import { locateSuspect, type SuspectLink } from "./core/link";
import { editorViewOf, markdownPointAt, modeOf, parsedText, scrollMarkdownTo, scrollerOf, setLegacyOffset } from "./markdown-pane";
import { PdfSuggestModal } from "./modals";
import { openBindDialog, openPagemarkDialog } from "./react-mount";
import { applyPagemarks, planPagemarks } from "./core/pagemarks";
import { Pairer, type Book } from "./pairing";
import { delay, leafPdfFile, PdfPane } from "./pdf-view";
import { buildRevisionRequest } from "./core/revision";
import { applySyncMode, syncModeOf, type PdfSyncSettings, type PracticeId, type ToolbarState } from "./settings";
import { LeaderTracker, QuietWindow, type PagePoint, type Side } from "./core/sync-math";
import { ToolbarHost } from "./toolbar-host";
import type { SyncMode, ToolbarStatus } from "./ui";
import { headingBefore, headings, type Heading } from "./core/headings";

export interface ControllerHost {
  app: App;
  settings: PdfSyncSettings;
  saveSettings(): Promise<void>;
  statusBar: HTMLElement;
}

type Disposer = () => void;

export class SyncController {
  readonly pairer: Pairer;
  readonly highlighter = new PdfHighlighter({ createDiv: (parent, cls) => parent.createDiv({ cls }) });
  readonly leader = new LeaderTracker();
  private readonly quiet: Record<Side, QuietWindow> = { markdown: new QuietWindow(), pdf: new QuietWindow() };
  book: Book | null = null;
  markdownLeaf: WorkspaceLeaf | null = null;
  pdf: PdfPane | null = null;
  /** 首次挂上一本书时（首次引导据此弹出） */
  onBookAttached: (() => void) | null = null;
  /** 「上手」练习做到了（逐字高亮成功、两边一起翻页） */
  onPractice: ((id: PracticeId) => void) | null = null;
  currentPage = 1;
  private currentPrinted: string | null = null;
  private currentChapter: string | null = null;
  private headingCache: { text: string; list: Heading[] } | null = null;
  readonly toolbar: ToolbarHost;
  private markdownDisposers: Disposer[] = [];
  private pdfDisposers: Disposer[] = [];
  private generation = 0;
  private markdownFrame: number | null = null;
  private pdfFrame: number | null = null;
  private selectionTimer: number | null = null;
  private suppressSelectionUntil = 0;
  private opening: Promise<PdfPane | null> | null = null;

  constructor(private readonly host: ControllerHost) {
    this.pairer = new Pairer(host.app);
    this.toolbar = new ToolbarHost({
      state: () => host.settings.toolbar,
      saveState: (state: ToolbarState) => {
        host.settings.toolbar = state;
        void host.saveSettings();
      },
      leafFor: (dock) => (dock === "pdf" ? this.pdf?.leaf ?? null : this.markdownLeaf),
      reducedMotion: () => host.settings.reducedMotion,
      jump: (page) => void this.jumpToPage(page),
      step: (delta) => void this.step(delta),
      zoom: (delta) => this.zoom(delta),
      setMode: (mode) => this.setMode(mode),
      setAutoOpen: (value) => {
        host.settings.autoOpen = value;
        void host.saveSettings();
        this.refreshStatus();
      },
      swapSide: () => void this.swapSide(),
      rebind: () => this.chooseAndBind(),
      find: () => this.onFind?.()
    });
  }

  /** 工具条「搜」：由插件主体接到繁简通搜 */
  onFind: (() => void) | null = null;

  /** 暂停跟随：记在设置里，重启后照旧 */
  get paused(): boolean {
    return this.settings.paused;
  }

  set paused(value: boolean) {
    this.settings.paused = value;
    void this.host.saveSettings();
  }

  /** 联动方式：双向 / 单向（只有正文带 PDF）/ 暂停 */
  get mode(): SyncMode {
    return syncModeOf(this.settings);
  }

  setMode(mode: SyncMode): void {
    const wasPaused = this.paused;
    applySyncMode(this.settings, mode);
    void this.host.saveSettings();
    this.refreshStatus();
    if (wasPaused && !this.paused) this.syncFromMarkdown(true);
  }

  get app(): App {
    return this.host.app;
  }

  get settings(): PdfSyncSettings {
    return this.host.settings;
  }

  get markdownView(): MarkdownView | null {
    const view = this.markdownLeaf?.view;
    return view instanceof MarkdownView ? view : null;
  }

  // ---------- 会话 ----------

  /** 活动窗格变了：正文窗格配到书就接管；PDF 窗格是本书的就接上 */
  async onActiveLeaf(leaf: WorkspaceLeaf | null): Promise<void> {
    if (!leaf) return;
    const generation = ++this.generation;
    if (leaf.view instanceof MarkdownView && leaf.view.file) {
      const book = await this.pairer.book(leaf.view.file);
      if (generation !== this.generation) return;
      if (!book) {
        if (leaf === this.markdownLeaf) this.detachMarkdown();
        return;
      }
      await this.attachMarkdown(leaf, book);
      return;
    }
    const pdfFile = leafPdfFile(leaf);
    if (pdfFile && this.book && pdfFile.path === this.book.pdf.path && leaf !== this.pdf?.leaf) this.attachPdf(leaf);
  }

  private async attachMarkdown(leaf: WorkspaceLeaf, book: Book): Promise<void> {
    const sameLeaf = leaf === this.markdownLeaf;
    this.book = book;
    setLegacyOffset(book.index.printedPageOffset);
    this.markdownLeaf = leaf;
    if (!sameLeaf || !this.markdownDisposers.length) this.bindMarkdown();
    const sameBook = this.app.workspace.getLeavesOfType("pdf").filter((candidate) => leafPdfFile(candidate)?.path === book.pdf.path);
    // 与正文同一组标签的 PDF 会被正文挡住，不能用（但也不关它：那是用户的标签）
    const usable = sameBook.filter((candidate) => candidate.parent !== leaf.parent);
    const existing = usable.find((candidate) => candidate.view.containerEl.isShown()) ?? usable[0];
    const reopen = !existing && sameBook.length > 0;
    if (existing && !existing.view.containerEl.isShown()) {
      // 在别的组里但不是当前标签：翻到前面（不抢焦点）
      await this.app.workspace.revealLeaf(existing);
      this.app.workspace.setActiveLeaf(leaf, { focus: false });
    }
    if (existing && existing !== this.pdf?.leaf) this.attachPdf(existing);
    if (!existing && this.pdf) this.detachPdf();
    this.toolbar.place();
    this.updateCurrentFromMarkdown();
    if (!this.pdf && (this.settings.autoOpen || reopen)) await this.ensurePdf();
    this.refreshStatus();
    this.onBookAttached?.();
  }

  private bindMarkdown(): void {
    this.disposeMarkdown();
    const view = this.markdownView;
    if (!view) return;
    const root = view.contentEl;
    const onScroll = () => {
      if (this.markdownFrame !== null) return;
      this.markdownFrame = window.requestAnimationFrame(() => {
        this.markdownFrame = null;
        this.onMarkdownScroll();
      });
    };
    const onInput = () => this.leader.input("markdown");
    // 滚动事件不冒泡，但在祖先上用捕获能收到：源码、实时预览、阅读三种视图切换时不用重挂
    this.listen(this.markdownDisposers, root, "scroll", onScroll, true);
    for (const type of ["wheel", "pointerdown", "keydown", "touchstart"]) this.listen(this.markdownDisposers, root, type, onInput, true);
    this.listen(this.markdownDisposers, root, "mouseup", () => this.scheduleSelection(), false);
    this.listen(this.markdownDisposers, root, "keyup", (event) => {
      if ((event as KeyboardEvent).shiftKey) this.scheduleSelection();
    }, false);
  }

  private attachPdf(leaf: WorkspaceLeaf): void {
    this.disposePdf();
    const pane = new PdfPane(leaf);
    this.pdf = pane;
    const root = leaf.view.containerEl;
    const onScroll = () => {
      if (this.pdfFrame !== null) return;
      this.pdfFrame = window.requestAnimationFrame(() => {
        this.pdfFrame = null;
        this.onPdfScroll();
      });
    };
    const onInput = () => this.leader.input("pdf");
    this.listen(this.pdfDisposers, root, "scroll", onScroll, true);
    for (const type of ["wheel", "pointerdown", "keydown", "touchstart"]) this.listen(this.pdfDisposers, root, type, onInput, true);
    this.listen(this.pdfDisposers, root, "mouseup", () => window.setTimeout(() => void this.onPdfSelection(), 10), false);
    void pane.waitReady().then((ready) => {
      if (!ready || this.pdf !== pane) return;
      const bus = pane.viewer?.eventBus;
      if (bus) {
        const redraw = () => void this.highlighter.redraw();
        const status = () => this.refreshStatus();
        bus.on("textlayerrendered", redraw);
        bus.on("scalechanging", status);
        this.pdfDisposers.push(() => {
          bus.off("textlayerrendered", redraw);
          bus.off("scalechanging", status);
        });
      }
      this.refreshStatus();
    });
    this.toolbar.place();
  }

  private listen(list: Disposer[], target: EventTarget, type: string, handler: (event: Event) => void, capture: boolean): void {
    target.addEventListener(type, handler, { capture, passive: true });
    list.push(() => target.removeEventListener(type, handler, { capture }));
  }

  private disposeMarkdown(): void {
    for (const dispose of this.markdownDisposers.splice(0)) dispose();
  }

  private disposePdf(): void {
    for (const dispose of this.pdfDisposers.splice(0)) dispose();
  }

  private detachMarkdown(): void {
    this.disposeMarkdown();
    this.setShade(null);
    this.markdownLeaf = null;
    this.book = null;
    this.toolbar.hide();
    this.host.statusBar.hide();
  }

  private detachPdf(): void {
    this.disposePdf();
    this.highlighter.clear();
    this.pdf = null;
  }

  /** 窗格关了、布局变了：检查两边是否还在 */
  onLayoutChange(): void {
    if (this.pdf && !this.leafAlive(this.pdf.leaf)) this.detachPdf();
    if (this.markdownLeaf && !this.leafAlive(this.markdownLeaf)) this.detachMarkdown();
    else if (this.markdownLeaf && this.book) this.toolbar.place();
  }

  private leafAlive(leaf: WorkspaceLeaf): boolean {
    let alive = false;
    this.app.workspace.iterateAllLeaves((candidate) => {
      if (candidate === leaf) alive = true;
    });
    return alive;
  }

  /** 书的文件改了：重读索引（锚点可能变了） */
  async onFileChanged(file: TFile): Promise<void> {
    if (!this.book || !this.markdownView?.file) return;
    if (file.path === this.book.pdf.path || this.book.members.some((member) => member.path === file.path) || file.path.endsWith("book.json")) {
      const book = await this.pairer.book(this.markdownView.file);
      if (book) {
        this.book = book;
        setLegacyOffset(book.index.printedPageOffset);
      }
      this.refreshStatus();
    }
  }

  dispose(): void {
    this.disposeMarkdown();
    this.disposePdf();
    this.setShade(null);
    this.highlighter.clear();
    this.toolbar.detach();
  }

  // ---------- 打开 PDF ----------

  /** 本书的 PDF 窗格：没开就在正文旁边开（按设置放左或右） */
  async ensurePdf(): Promise<PdfPane | null> {
    if (this.pdf && this.leafAlive(this.pdf.leaf)) return this.pdf;
    if (this.opening) return this.opening;
    this.opening = this.openPdf().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async openPdf(): Promise<PdfPane | null> {
    const book = this.book;
    const markdownLeaf = this.markdownLeaf;
    if (!book || !markdownLeaf) return null;
    const existing = this.app.workspace.getLeavesOfType("pdf")
      .find((candidate) => leafPdfFile(candidate)?.path === book.pdf.path && candidate.parent !== markdownLeaf.parent);
    const leaf = existing ?? this.app.workspace.createLeafBySplit(markdownLeaf, "vertical", this.settings.pdfSide === "left");
    if (!existing) await leaf.openFile(book.pdf, { active: false });
    this.attachPdf(leaf);
    const pane = this.pdf;
    if (!pane || !(await pane.waitReady())) return pane;
    // 刚打开：按正文当前位置对齐一次
    this.syncFromMarkdown(true);
    return pane;
  }

  async swapSide(): Promise<void> {
    this.settings.pdfSide = this.settings.pdfSide === "left" ? "right" : "left";
    await this.host.saveSettings();
    const pane = this.pdf;
    if (!pane || !this.markdownLeaf) {
      this.refreshStatus();
      return;
    }
    const point = pane.pointAtBaseline(this.settings.baseline);
    this.detachPdf();
    pane.leaf.detach();
    const fresh = await this.ensurePdf();
    if (fresh && point) {
      await fresh.waitReady();
      await delay(100);
      this.quiet.pdf.hold(this.settings.quietMs);
      fresh.scrollTo(point, this.settings.baseline);
    }
    this.refreshStatus();
  }

  // ---------- 跟随 ----------

  private onMarkdownScroll(): void {
    // 程序滚动（跳页、翻页、PDF 带正文）期间不改当前页：跳到的那一页可能不在基准线上（页段很短、贴着文件末尾）
    if (this.quiet.markdown.quiet) return;
    this.updateCurrentFromMarkdown();
    if (this.paused || this.leader.leader !== "markdown") return;
    this.syncFromMarkdown(false);
  }

  /** 正文 → PDF */
  syncFromMarkdown(force: boolean): void {
    const view = this.markdownView;
    const pane = this.pdf;
    if (!view || !pane?.ready || (this.paused && !force)) return;
    const point = markdownPointAt(view, this.settings.baseline);
    if (!point) return;
    this.quiet.pdf.hold(this.settings.quietMs);
    pane.scrollTo({ page: point.page, fraction: this.settings.proportional ? point.fraction : 0 }, this.settings.baseline);
  }

  private onPdfScroll(): void {
    const pane = this.pdf;
    if (!pane) return;
    const point = pane.pointAtBaseline(this.settings.baseline);
    this.refreshStatus(point?.page);
    if (!point || this.quiet.pdf.quiet || this.paused || this.leader.leader !== "pdf" || !this.settings.bidirectional) return;
    void this.followPdf(this.settings.proportional ? point : { page: point.page, fraction: 0 });
  }

  /** PDF → 正文：该页在别的文件就先打开那个文件 */
  private async followPdf(point: PagePoint): Promise<void> {
    const book = this.book;
    const leaf = this.markdownLeaf;
    if (!book || !leaf) return;
    const target = fileForPage(book.index, point.page, this.markdownView?.file?.path ?? null);
    const view = this.markdownView;
    if (target && view?.file && target.path !== view.file.path) {
      const file = this.app.vault.getAbstractFileByPath(target.path);
      if (!(file instanceof TFile)) return;
      this.quiet.markdown.hold(this.settings.quietMs * 3);
      await leaf.openFile(file, { active: false });
      await delay(60);
    }
    const current = this.markdownView;
    if (!current) return;
    this.quiet.markdown.hold(this.settings.quietMs);
    if (scrollMarkdownTo(current, point, this.settings.baseline)) {
      // CodeMirror 对没量过的行用估计高度，滚过去后再校一次
      window.requestAnimationFrame(() => {
        this.quiet.markdown.hold(this.settings.quietMs);
        const latest = this.markdownView;
        if (latest) scrollMarkdownTo(latest, point, this.settings.baseline);
        this.updateCurrentFromMarkdown();
      });
    }
  }

  /** 正文基准线处的页 → 当前页、底色、状态 */
  private updateCurrentFromMarkdown(): void {
    const view = this.markdownView;
    if (!view) return;
    const point = markdownPointAt(view, this.settings.baseline);
    if (point) {
      this.currentPage = point.page;
      this.currentPrinted = point.printed;
      this.currentChapter = this.chapterAt(view, point.offset);
    }
    this.setShade(this.settings.shadeCurrentPage && point ? point.page : null);
    this.refreshStatus();
  }

  private chapterAt(view: MarkdownView, offset: number): string | null {
    const text = modeOf(view) === "preview" ? view.data : view.editor.getValue();
    if (this.headingCache?.text !== text) this.headingCache = { text, list: headings(text) };
    return headingBefore(text, offset, this.headingCache.list)?.text ?? null;
  }

  private setShade(page: number | null): void {
    const view = this.markdownView;
    if (!view || modeOf(view) === "preview") return;
    const cm = editorViewOf(view);
    cm?.dispatch({ effects: setCurrentPage.of(page) });
  }

  // ---------- 跳页、翻页 ----------

  async jumpToPage(page: number, fraction = 0): Promise<void> {
    const book = this.book;
    if (!book) return;
    const pane = await this.ensurePdf();
    const count = pane?.pageCount || Number.MAX_SAFE_INTEGER;
    const target = Math.min(Math.max(1, page), count);
    const point = { page: target, fraction };
    const ratio = fraction === 0 ? 0.02 : this.settings.baseline;
    this.quiet.pdf.hold(this.settings.quietMs * 2);
    this.quiet.markdown.hold(this.settings.quietMs * 2);
    pane?.scrollTo(point, ratio);
    const entry = fileForPage(book.index, target, this.markdownView?.file?.path ?? null);
    const leaf = this.markdownLeaf;
    if (entry && leaf && this.markdownView?.file?.path !== entry.path) {
      const file = this.app.vault.getAbstractFileByPath(entry.path);
      if (file instanceof TFile) {
        await leaf.openFile(file, { active: false });
        await delay(60);
      }
    }
    const view = this.markdownView;
    if (view) {
      scrollMarkdownTo(view, point, ratio);
      window.requestAnimationFrame(() => {
        this.quiet.markdown.hold(this.settings.quietMs);
        const latest = this.markdownView;
        if (latest) scrollMarkdownTo(latest, point, ratio);
      });
    }
    this.setCurrent(target);
    this.setShade(this.settings.shadeCurrentPage ? target : null);
    this.refreshStatus(target);
  }

  /** 程序跳到某页后：当前页、印刷页、章名按这一页的段算（不等正文滚动事件） */
  private setCurrent(page: number): void {
    this.currentPage = page;
    const view = this.markdownView;
    if (!view) return;
    const text = modeOf(view) === "preview" ? view.data : view.editor.getValue();
    const parsed = parsedText(text);
    const found = segmentForPageOrGap(parsed.segments, page);
    this.currentPrinted = found && !found.gap ? found.segment.printed : null;
    this.currentChapter = this.chapterAt(view, found ? (found.gap ? found.segment.to : found.segment.from) : 0);
  }

  async step(delta: number): Promise<void> {
    await this.jumpToPage(this.currentPage + delta, 0);
    this.onPractice?.("pageEdit");
  }

  zoom(delta: number | null): void {
    const pane = this.pdf;
    if (!pane?.viewer) return;
    if (delta === null) pane.viewer.currentScaleValue = "page-width";
    else pane.setScale(pane.scale + delta);
    window.setTimeout(() => this.refreshStatus(), 50);
  }

  // ---------- 状态 ----------

  private refreshStatus(pdfPage?: number): void {
    if (!this.book || !this.markdownLeaf) return;
    const page = pdfPage ?? this.currentPage;
    const printed = printedLabel(this.book.index, page, page === this.currentPage ? this.currentPrinted : null);
    const status: ToolbarStatus = {
      page,
      pageCount: this.pdf?.pageCount ?? 0,
      printed,
      scale: this.pdf?.scale ?? 1,
      chapter: this.currentChapter,
      autoOpen: this.settings.autoOpen,
      mode: this.mode,
      pdfName: this.book.pdf.name,
      pdfSide: this.settings.pdfSide
    };
    this.toolbar.update(status);
    this.host.statusBar.show();
    this.host.statusBar.setText(`PDF ${page}/${status.pageCount || "?"}${printed ? ` · p.${printed}` : ""}${this.paused ? " ⏸" : ""}`);
  }

  settingsChanged(): void {
    this.toolbar.place();
    this.updateCurrentFromMarkdown();
  }

  // ---------- 逐字高亮 ----------

  private scheduleSelection(): void {
    if (!this.settings.wordHighlight) return;
    if (this.selectionTimer !== null) window.clearTimeout(this.selectionTimer);
    this.selectionTimer = window.setTimeout(() => {
      this.selectionTimer = null;
      void this.onMarkdownSelection();
    }, 120);
  }

  /** 正文选中 → PDF 高亮 */
  async onMarkdownSelection(): Promise<boolean> {
    if (Date.now() < this.suppressSelectionUntil) return false;
    const view = this.markdownView;
    if (!view || !this.book) return false;
    let text: string;
    let from: number;
    let to: number;
    if (modeOf(view) === "preview") {
      const selection = activeWindow.getSelection();
      const query = selection?.toString() ?? "";
      if (!selection || !query.trim() || !selection.rangeCount) {
        this.highlighter.clear();
        return false;
      }
      text = view.data;
      const section = (selection.anchorNode?.instanceOf(HTMLElement) ? selection.anchorNode : selection.anchorNode?.parentElement)?.closest<HTMLElement>("[data-aps-line-start]");
      const parsed = parsedText(text);
      const line = Number(section?.dataset.apsLineStart ?? 0);
      const lineFrom = parsed.lineStarts[Math.min(line, parsed.lineStarts.length - 1)] ?? 0;
      from = text.indexOf(query, lineFrom);
      if (from === -1) from = lineFrom;
      to = from + query.length;
    } else {
      const editor = view.editor;
      text = editor.getValue();
      from = editor.posToOffset(editor.getCursor("from"));
      to = editor.posToOffset(editor.getCursor("to"));
    }
    if (to <= from) {
      this.highlighter.clear();
      return false;
    }
    const parsed = parsedText(text);
    const at = pageAtOffset(text, from, parsed.anchors, parsed.segments);
    if (!at) return false;
    const pane = await this.ensurePdf();
    if (!pane) return false;
    const progress = at.to > at.from ? (from - at.from) / (at.to - at.from) : 0;
    const shown = await this.highlighter.show(pane, {
      page: at.page,
      query: text.slice(from, to),
      context: { before: text.slice(Math.max(0, from - 40), from), after: text.slice(to, to + 40), progress }
    }, true, this.settings.baseline);
    if (shown) this.onPractice?.("highlight");
    return shown;
  }

  /** PDF 上选字 → 正文选中 */
  async onPdfSelection(): Promise<boolean> {
    if (!this.settings.wordHighlight) return false;
    const pane = this.pdf;
    const selection = activeWindow.getSelection();
    if (!pane || !selection || selection.isCollapsed || !selection.rangeCount) return false;
    const range = selection.getRangeAt(0);
    const node = range.startContainer.instanceOf(HTMLElement) ? range.startContainer : range.startContainer.parentElement;
    const layer = node?.closest<HTMLElement>(".textLayer");
    const pageElement = node?.closest<HTMLElement>(".page[data-page-number]");
    if (!layer || !pageElement || !pane.container?.contains(layer)) return false;
    const query = selection.toString();
    if (!query.trim()) return false;
    const page = Number(pageElement.dataset.pageNumber);
    return this.selectInMarkdown(page, query, selectionContext(range, layer));
  }

  /** 在第 page 页的锚点段里找 query，选中并滚到基准线（必要时先打开所在文件） */
  async selectInMarkdown(page: number, query: string, context: { before?: string; after?: string; progress?: number }, exact?: (segment: string) => [number, number] | null): Promise<boolean> {
    const book = this.book;
    const leaf = this.markdownLeaf;
    if (!book || !leaf) return false;
    const entry = fileForPage(book.index, page, this.markdownView?.file?.path ?? null);
    if (entry && this.markdownView?.file?.path !== entry.path) {
      const file = this.app.vault.getAbstractFileByPath(entry.path);
      if (file instanceof TFile) {
        await leaf.openFile(file, { active: false });
        await delay(60);
      }
    }
    const view = this.markdownView;
    if (!view) return false;
    const text = modeOf(view) === "preview" ? view.data : view.editor.getValue();
    const parsed = parsedText(text);
    const segment = segmentForPage(parsed.segments, page);
    const base = segment?.from ?? 0;
    const slice = segment ? text.slice(segment.from, segment.to) : text;
    const found = exact ? exact(slice) : locateInSegment(slice, query, context);
    if (!found) return false;
    const from = base + found[0];
    const to = base + found[1];
    this.suppressSelectionUntil = Date.now() + 400;
    this.quiet.markdown.hold(this.settings.quietMs * 2);
    if (modeOf(view) === "preview") {
      const fraction = segment && segment.to > segment.from ? (from - segment.from) / (segment.to - segment.from) : 0;
      scrollMarkdownTo(view, { page, fraction }, this.settings.baseline);
      return true;
    }
    const editor = view.editor;
    editor.setSelection(editor.offsetToPos(from), editor.offsetToPos(to));
    const cm = editorViewOf(view);
    if (cm) {
      const height = cm.scrollDOM.clientHeight;
      cm.dispatch({ effects: EditorView.scrollIntoView(from, { y: "start", yMargin: height * this.settings.baseline }) });
    }
    this.setCurrent(page);
    this.setShade(this.settings.shadeCurrentPage ? page : null);
    this.refreshStatus(page);
    return true;
  }

  // ---------- 疑字链接 ----------

  async openSuspectLink(link: SuspectLink): Promise<boolean> {
    const vault = this.app.vault;
    const found = vault.getAbstractFileByPath(link.file) ?? vault.getAbstractFileByPath(`${link.file}.md`);
    if (!(found instanceof TFile)) {
      new Notice(`找不到笔记：${link.file}`);
      return false;
    }
    let leaf = this.markdownLeaf;
    if (!leaf || !this.leafAlive(leaf)) leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(found, { active: true });
    const book = await this.pairer.book(found);
    if (!book) {
      new Notice("这篇笔记没有配对的 PDF");
      return false;
    }
    await this.attachMarkdown(leaf, book);
    const text = await this.app.vault.cachedRead(found);
    let page = link.page;
    if (page === null) {
      const at = locateSuspect(text, link.text, link.ctx);
      const parsed = parsedText(text);
      page = at ? pageAtOffset(text, at[0], parsed.anchors, parsed.segments)?.page ?? 1 : 1;
    }
    const target = page;
    const selected = await this.selectInMarkdown(target, link.text, {}, (segment) => locateSuspect(segment, link.text, link.ctx));
    const pane = await this.ensurePdf();
    if (pane && link.text) {
      const inner = link.ctx.indexOf(link.text);
      const context = inner === -1 ? { before: link.ctx, after: link.ctx } : { before: link.ctx.slice(0, inner), after: link.ctx.slice(inner + link.text.length) };
      this.quiet.pdf.hold(this.settings.quietMs * 2);
      pane.scrollTo({ page: target, fraction: 0 }, 0.02);
      await this.highlighter.show(pane, { page: target, query: link.text, context }, true, this.settings.baseline);
    }
    if (!selected) new Notice(`第 ${target} 页里没找到「${link.text}」`);
    return selected;
  }

  // ---------- 修订请求 ----------

  async copyRevisionRequest(): Promise<string | null> {
    const view = this.markdownView;
    const book = this.book;
    if (!view?.file || !book) {
      new Notice("当前笔记没有配对的 PDF");
      return null;
    }
    const text = modeOf(view) === "preview" ? view.data : view.editor.getValue();
    const parsed = parsedText(text);
    const segment = segmentForPage(parsed.segments, this.currentPage);
    if (!segment) {
      new Notice("这篇笔记里没有当前页的锚点");
      return null;
    }
    const adapter = this.app.vault.adapter;
    const full = (path: string) => (adapter instanceof FileSystemAdapter ? adapter.getFullPath(path) : path);
    const selection = modeOf(view) === "preview" ? "" : view.editor.getSelection();
    const request = buildRevisionRequest({
      notePath: full(view.file.path),
      pdfPath: full(book.pdf.path),
      page: this.currentPage,
      printed: printedLabel(book.index, this.currentPage, segment.printed),
      segment: text.slice(segment.from, segment.to),
      selection
    });
    await navigator.clipboard.writeText(request);
    new Notice(`已复制第 ${this.currentPage} 页的修订请求`);
    return request;
  }

  // ---------- 补页码锚点 ----------

  async openPagemarkPreview(): Promise<boolean> {
    const view = this.markdownView;
    const book = this.book;
    const file = view?.file;
    if (!view || !book || !file) {
      new Notice("当前笔记没有配对的 PDF");
      return false;
    }
    const pane = await this.ensurePdf();
    if (!pane || !(await pane.waitReady())) {
      new Notice("PDF 还没打开好");
      return false;
    }
    const count = pane.pageCount;
    const original = view.editor.getValue();
    openPagemarkDialog(view.containerEl.doc, {
      filePath: file.path,
      reducedMotion: this.settings.reducedMotion,
      pageCount: count,
      range: suggestedPageRange(book.index, file.path, count),
      plan: async (from, to) => {
        const pages: Array<[number, string]> = [];
        for (let page = from; page <= to; page += 1) pages.push([page, await pane.pageText(page)]);
        return planPagemarks(original, pages);
      },
      write: async (proposals) => {
        let changed = false;
        await this.app.vault.process(file, (current) => {
          if (current !== original) {
            changed = true;
            return current;
          }
          return applyPagemarks(current, proposals);
        });
        if (changed) new Notice("笔记在预览之后改过，没有写入；请重新预览");
        else new Notice(`已插入 ${proposals.length} 个页码锚点`);
        await this.onFileChanged(file);
      }
    });
    return true;
  }

  // ---------- 手动绑定 ----------

  chooseAndBind(target: TFile | null = null, onBound: (() => void) | null = null): void {
    const file = target ?? this.markdownView?.file ?? this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("先打开这本书的一篇笔记");
      return;
    }
    new PdfSuggestModal(this.app, (pdf) => {
      const candidates = this.pairer.bindCandidates(file);
      openBindDialog(this.markdownView?.containerEl.doc ?? this.app.workspace.containerEl.doc, {
        pdfPath: pdf.path,
        files: candidates.map((candidate) => candidate.path),
        reducedMotion: this.settings.reducedMotion,
        onConfirm: (paths) => {
          const files = candidates.filter((candidate) => paths.includes(candidate.path));
          void this.pairer.bind(files, pdf).then(async () => {
            new Notice(`已把 ${files.length} 篇笔记配到 ${pdf.name}`);
            await delay(200);
            const leaf = this.markdownLeaf ?? this.app.workspace.getMostRecentLeaf();
            if (leaf) await this.onActiveLeaf(leaf);
            onBound?.();
          });
        }
      });
    }).open();
  }

  /** 正文基准线处的页与页内比例（状态显示、测试用） */
  markdownPoint(): PagePoint | null {
    const view = this.markdownView;
    return view ? markdownPointAt(view, this.settings.baseline) : null;
  }

  /** PDF 基准线处的页与页内比例 */
  pdfPoint(): PagePoint | null {
    return this.pdf?.pointAtBaseline(this.settings.baseline) ?? null;
  }

  get scroller(): HTMLElement | null {
    const view = this.markdownView;
    return view ? scrollerOf(view) : null;
  }
}
