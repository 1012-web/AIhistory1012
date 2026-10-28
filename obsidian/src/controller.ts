/**
 * 联动控制器：当前这本书、正文窗格、PDF 窗格三者的会话。
 *
 * 跟随：正文 → PDF 按页、页内逐行对齐（PDF 文字层的各行与正文逐字比对，见 core/line-align.ts；没有可用文字层的页按比例），
 * 基准线在视口距顶 35%（可调，并可在两窗格画出来）；双向联动时 PDF → 正文（可跨文件）。
 * 防回环：领跑方取最近有输入（滚轮、按键、指针）的窗格；程序滚动后对侧静默约 200 毫秒。
 * 手动翻 PDF 时 PDF 领跑，正文不再带动它（跟随暂停）；回到正文一有输入就恢复。
 */
import { EditorView } from "@codemirror/view";
import { FileSystemAdapter, MarkdownView, Notice, TFile, getLanguage, type App, type WorkspaceLeaf } from "obsidian";
import { BaselineLine } from "./baseline-line";
import { pageAtOffset, segmentForPage, segmentForPageOrGap } from "./core/anchors";
import { fileForPage, printedLabel, suggestedPageRange } from "./core/book-index";
import { LineMap, type TextLayerProblem } from "./core/line-map";
import { markdownTargetForPdf, pdfTargetForMarkdown } from "./core/line-sync";
import { setCurrentPage } from "./editor-ext";
import { PdfHighlighter, locateInSegment, selectionContext } from "./highlight";
import { locateSuspect, type SuspectLink } from "./core/link";
import { locateLink } from "./core/suspects";
import { editorViewOf, markdownGeometry, markdownPointAt, modeOf, parsedOf, parsedText, scrollMarkdownTo, scrollerOf, setLegacyOffset } from "./markdown-pane";
import { PdfSuggestModal } from "./modals";
import { openBindDialog, openPagemarkDialog } from "./react-mount";
import { applyPagemarks, planPagemarks } from "./core/pagemarks";
import { findNote, Pairer, type Book, type BrokenLink } from "./pairing";
import { PdfMoveDetector } from "./core/pairing";
import { delay, leafPdfFile, PdfPane } from "./pdf-view";
import { buildRevisionRequest } from "./core/revision";
import { applySyncMode, syncModeOf, type PdfSyncSettings, type PracticeId, type ToolbarState } from "./settings";
import { LeaderTracker, QuietWindow, type PagePoint, type Side } from "./core/sync-math";
import { ToolbarHost } from "./toolbar-host";
import type { OutlineStatus, SyncMode, ToolbarStatus } from "./ui";
import { headingIndexBefore, headings, type Heading } from "./core/headings";
import { EMPTY_BOOK_STATE, headingPages, type HeadingPage } from "./core/outline-view";
import { scrollOffsetToBaseline } from "./core/cm-sync";

export interface ControllerHost {
  app: App;
  settings: PdfSyncSettings;
  saveSettings(): Promise<void>;
  /** 打开本插件的设置页 */
  openSettings(): void;
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
  /** 阅读线处的标题在 headingCache.list 里的序号，-1 = 还没到第一个标题 */
  private currentHeading = -1;
  /** 本文件的标题表；pages（各标题所在页）到要显示时才算 */
  private headingCache: { text: string; list: Heading[]; pages: HeadingPage[] | null } | null = null;
  readonly toolbar: ToolbarHost;
  private markdownDisposers: Disposer[] = [];
  /** 本次会话里提示过的配对问题，同一件事只提示一次 */
  private readonly offered = new Set<string>();
  private readonly moves = new PdfMoveDetector();
  private pdfDisposers: Disposer[] = [];
  /** 两个窗格各一条阅读线（设置「显示阅读线」） */
  private markdownLine: BaselineLine | null = null;
  private pdfLine: BaselineLine | null = null;
  private generation = 0;
  private markdownFrame: number | null = null;
  private pdfFrame: number | null = null;
  private selectionTimer: number | null = null;
  private suppressSelectionUntil = 0;
  private opening: Promise<PdfPane | null> | null = null;
  /** 逐行对齐：PDF 各页文字层与正文各页段的对齐点（缓存） */
  readonly lines = new LineMap((page) => this.pdf?.pageLines(page) ?? Promise.resolve(null));
  private linesFrame: number | null = null;

  constructor(private readonly host: ControllerHost) {
    this.pairer = new Pairer(host.app);
    // 新读到一页文字层：先前用的是按页兜底，下一帧按逐行再对一次
    this.lines.onLoaded = () => {
      if (this.linesFrame !== null) return;
      this.linesFrame = window.requestAnimationFrame(() => {
        this.linesFrame = null;
        this.realign();
      });
    };
    this.lines.onProblem = (problem) => this.textLayerNotice(problem);
    this.toolbar = new ToolbarHost({
      state: () => host.settings.toolbar,
      saveState: (state: ToolbarState) => {
        host.settings.toolbar = state;
        void host.saveSettings();
      },
      leafFor: (dock) => (dock === "pdf" ? this.pdf?.leaf ?? null : this.markdownLeaf),
      reducedMotion: () => host.settings.reducedMotion,
      jump: (page) => void this.jumpToPage(page),
      jumpToHeading: (offset) => void this.jumpToHeading(offset),
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
      openSettings: () => host.openSettings(),
      setOutline: (prefs) => {
        const settings = this.settings;
        if (prefs.showLevel !== undefined) settings.outlineShowLevel = prefs.showLevel;
        if (prefs.showPage !== undefined) settings.outlineShowPage = prefs.showPage;
        if (prefs.pinned !== undefined) settings.outlinePinned = prefs.pinned;
        void host.saveSettings();
        this.refreshStatus();
      },
      setOutlineBook: (state) => {
        if (!this.book) return;
        this.settings.outlineBooks[this.book.pdf.path] = state;
        void host.saveSettings();
        this.refreshStatus();
      }
    });
  }

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
      const file = leaf.view.file;
      const book = await this.pairer.book(file);
      if (generation !== this.generation) return;
      if (!book) {
        if (leaf === this.markdownLeaf) this.detachMarkdown();
        const { broken } = await this.pairer.diagnose(file);
        if (broken) this.offerMissing(file, broken);
        return;
      }
      await this.attachMarkdown(leaf, book);
      if (book.broken) this.offerFallback(file, book);
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
    this.markdownLine = new BaselineLine(view.containerEl, () => scrollerOf(view), () => this.ratioFor("markdown"), () => this.settings.baselineStyle, () => this.positionBaselines());
    this.refreshBaselines();
  }

  /** 按设置显示或收起两条阅读线，并按当前布局与样式重算 */
  private refreshBaselines(): void {
    const show = this.settings.showBaseline && !!this.book;
    for (const line of [this.markdownLine, this.pdfLine]) {
      if (!line) continue;
      if (show) line.show();
      else line.hide();
    }
  }

  /** 任一窗格尺寸变了：两条线一起按新的重叠区间重算（只重算一边会错开） */
  private positionBaselines(): void {
    this.markdownLine?.position();
    this.pdfLine?.position();
  }

  /**
   * 某一侧实际用的基准线比例。两窗格上下有重叠时，取重叠区间里「设置的比例」处的同一屏幕高度，
   * 再折回各自滚动容器的比例：两边按同一条水平线对齐，画出的线也连成一条（两窗格顶部常常不齐，
   * 比如工具条停在正文顶部）。没有重叠（上下分栏）或量不到时，用设置值。
   */
  ratioFor(side: Side): number {
    const base = this.settings.baseline;
    const view = this.markdownView;
    const markdown = view ? scrollerOf(view) : null;
    const pdf = this.pdf?.container ?? null;
    if (!markdown || !pdf) return base;
    const a = markdown.getBoundingClientRect();
    const b = pdf.getBoundingClientRect();
    const top = Math.max(a.top, b.top);
    const bottom = Math.min(a.bottom, b.bottom);
    if (bottom - top < 40) return base;
    const own = side === "markdown" ? a : b;
    if (own.height <= 0) return base;
    const y = top + (bottom - top) * base;
    return Math.min(0.95, Math.max(0.05, (y - own.top) / own.height));
  }

  private attachPdf(leaf: WorkspaceLeaf): void {
    this.disposePdf();
    const pane = new PdfPane(leaf);
    this.pdf = pane;
    this.lines.reset(pane.file?.path ?? null);
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
      // viewer 容器要等 PDF 加载好才量得到
      this.refreshBaselines();
      this.refreshStatus();
      this.prefetchLines(this.currentPage);
    });
    this.pdfLine = new BaselineLine(root, () => pane.container, () => this.ratioFor("pdf"), () => this.settings.baselineStyle, () => this.positionBaselines());
    this.refreshBaselines();
    this.toolbar.place();
  }

  private listen(list: Disposer[], target: EventTarget, type: string, handler: (event: Event) => void, capture: boolean): void {
    target.addEventListener(type, handler, { capture, passive: true });
    list.push(() => target.removeEventListener(type, handler, { capture }));
  }

  private disposeMarkdown(): void {
    for (const dispose of this.markdownDisposers.splice(0)) dispose();
    this.markdownLine?.hide();
    this.markdownLine = null;
  }

  private disposePdf(): void {
    for (const dispose of this.pdfDisposers.splice(0)) dispose();
    this.pdfLine?.hide();
    this.pdfLine = null;
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
    // 切换阅读 / 编辑视图、拖动分栏都会触发：滚动容器可能换了，线要重量
    this.refreshBaselines();
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
    // PDF 本身换了（比如覆盖成文字层副本）：文字层重读
    if (file.path === this.book.pdf.path && file.path === this.pdf?.file?.path) this.lines.clear();
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
    const point = pane.pointAtBaseline(this.ratioFor("pdf"));
    this.detachPdf();
    pane.leaf.detach();
    const fresh = await this.ensurePdf();
    if (fresh && point) {
      await fresh.waitReady();
      await delay(100);
      this.quiet.pdf.hold(this.settings.quietMs);
      fresh.scrollTo(point, this.ratioFor("pdf"));
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

  /** 正文 → PDF：逐行对齐得出 PDF 该滚到的高度；对不上（或关了页内对齐）就按页 */
  syncFromMarkdown(force: boolean): void {
    const view = this.markdownView;
    const pane = this.pdf;
    if (!view || !pane?.ready || (this.paused && !force)) return;
    const ratio = this.ratioFor("markdown");
    const point = markdownPointAt(view, ratio);
    if (!point) return;
    this.quiet.pdf.hold(this.settings.quietMs);
    if (this.settings.proportional) {
      const geometry = markdownGeometry(view);
      const target = geometry ? pdfTargetForMarkdown(this.lines.pointsNearOffset(parsedOf(view), point.offset), geometry.baseline(ratio), (offset) => geometry.heightAt(offset), pane.heights()) : null;
      if (target !== null) {
        pane.scrollToHeight(target, this.ratioFor("pdf"));
        return;
      }
    }
    pane.scrollTo({ page: point.page, fraction: this.settings.proportional ? point.fraction : 0 }, this.ratioFor("pdf"));
  }

  private onPdfScroll(): void {
    const pane = this.pdf;
    if (!pane) return;
    const point = pane.pointAtBaseline(this.ratioFor("pdf"));
    this.refreshStatus(point?.page);
    if (point) this.prefetchLines(point.page);
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
    if (this.followPdfByLines(current, point.page) || scrollMarkdownTo(current, point, this.ratioFor("markdown"))) {
      // CodeMirror 对没量过的行用估计高度，滚过去后再校一次
      window.requestAnimationFrame(() => {
        this.quiet.markdown.hold(this.settings.quietMs);
        const latest = this.markdownView;
        if (latest && !this.followPdfByLines(latest, point.page)) scrollMarkdownTo(latest, point, this.ratioFor("markdown"));
        this.updateCurrentFromMarkdown();
      });
    }
  }

  /** PDF → 正文的逐行对齐：PDF 基准线处的高度换成正文的阅读高度并滚过去；对不上或关了页内对齐返回 false */
  private followPdfByLines(view: MarkdownView, page: number): boolean {
    const pane = this.pdf;
    if (!this.settings.proportional || !pane) return false;
    const geometry = markdownGeometry(view);
    const height = pane.baselineHeight(this.ratioFor("pdf"));
    if (!geometry || height === null) return false;
    const target = markdownTargetForPdf(this.lines.pointsNearPage(parsedOf(view), page), height, (offset) => geometry.heightAt(offset), pane.heights());
    if (target === null) return false;
    geometry.scrollTo(target, this.ratioFor("markdown"));
    return true;
  }

  /** 新读到文字层后再对一次：谁领跑就按谁对（用户正在滚的那边不动） */
  private realign(): void {
    if (this.paused || !this.settings.proportional || !this.pdf?.ready || !this.markdownView) return;
    if (this.leader.leader === "markdown") {
      if (!this.quiet.markdown.quiet) this.syncFromMarkdown(false);
      return;
    }
    if (!this.settings.bidirectional || this.quiet.pdf.quiet) return;
    const point = this.pdf.pointAtBaseline(this.ratioFor("pdf"));
    if (!point) return;
    this.quiet.markdown.hold(this.settings.quietMs);
    this.followPdfByLines(this.markdownView, point.page);
  }

  /** 预读当前页前后几页的文字层 */
  private prefetchLines(page: number): void {
    if (!this.pdf?.ready || !this.settings.proportional) return;
    this.lines.prefetch([page, page + 1, page - 1, page + 2, page - 2]);
  }

  /** 这份 PDF 没有可用的文字层：只能按页跟随。每份 PDF 只提示一次（记进设置） */
  private textLayerNotice(problem: TextLayerProblem): void {
    const path = this.pdf?.file?.path;
    if (!path || this.settings.textLayerNoticed.includes(path)) return;
    this.settings.textLayerNoticed = [...this.settings.textLayerNoticed, path];
    void this.host.saveSettings();
    const name = this.pdf?.file?.name ?? path;
    if (problem === "vertical") {
      new Notice(`「${name}」是竖排，页内不能逐行对齐，只能按页跟随。`, 12000);
      return;
    }
    const why = problem === "none" ? "没有文字层" : "的文字层与正文对不上（可能是乱码）";
    new Notice(`「${name}」${why}，只能按页跟随。用 book2md1012 做一份文字层副本后，就能逐行对齐。`, 12000);
  }

  /** 正文基准线处的页 → 当前页、底色、状态 */
  private updateCurrentFromMarkdown(): void {
    const view = this.markdownView;
    if (!view) return;
    const point = markdownPointAt(view, this.ratioFor("markdown"));
    if (point) {
      if (point.page !== this.currentPage) this.prefetchLines(point.page);
      this.currentPage = point.page;
      this.currentPrinted = point.printed;
      this.currentHeading = this.headingAt(view, point.offset);
    }
    this.setShade(this.settings.shadeStyle !== "off" && point ? point.page : null);
    this.refreshStatus();
  }

  /** offset 所在的标题（之前最近的一个）在本文件标题表里的序号；顺手刷新标题表 */
  private headingAt(view: MarkdownView, offset: number): number {
    const text = modeOf(view) === "preview" ? view.data : view.editor.getValue();
    if (this.headingCache?.text !== text) this.headingCache = { text, list: headings(text), pages: null };
    return headingIndexBefore(this.headingCache.list, offset);
  }

  private setShade(page: number | null): void {
    const view = this.markdownView;
    if (!view || modeOf(view) === "preview") return;
    const cm = editorViewOf(view);
    cm?.dispatch({ effects: setCurrentPage.of(page) });
  }

  // ---------- 跳页、翻页 ----------

  async jumpToPage(page: number, fraction = 0, atBaseline = fraction !== 0): Promise<void> {
    const book = this.book;
    if (!book) return;
    const pane = await this.ensurePdf();
    const count = pane?.pageCount || Number.MAX_SAFE_INTEGER;
    const target = Math.min(Math.max(1, page), count);
    const point = { page: target, fraction };
    // 跳到页首时贴顶（0.02），否则停在两边共用的基准线上
    const pdfRatio = atBaseline ? this.ratioFor("pdf") : 0.02;
    const markdownRatio = atBaseline ? this.ratioFor("markdown") : 0.02;
    this.quiet.pdf.hold(this.settings.quietMs * 2);
    this.quiet.markdown.hold(this.settings.quietMs * 2);
    pane?.scrollTo(point, pdfRatio);
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
      // 跳到页首：PDF 页顶贴顶，正文按阅读线上的那一行跟过去（阅读线上两边始终是同一行）；对不上时正文也按页首贴顶
      const place = (current: MarkdownView) => {
        if (fraction !== 0 || !this.followPdfByLines(current, target)) scrollMarkdownTo(current, point, markdownRatio);
      };
      place(view);
      window.requestAnimationFrame(() => {
        this.quiet.markdown.hold(this.settings.quietMs);
        const latest = this.markdownView;
        if (latest) place(latest);
      });
    }
    this.prefetchLines(target);
    this.setCurrent(target);
    this.setShade(this.settings.shadeStyle !== "off" ? target : null);
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
    this.currentHeading = this.headingAt(view, found ? (found.gap ? found.segment.to : found.segment.from) : 0);
  }

  /**
   * 工具条标题菜单里点了某个标题：把它放到两边的阅读线上（PDF 按标题所在页、页内比例跟过去）。
   * 放在阅读线而不贴顶，是因为工具条上的当前标题按阅读线算，贴顶时短小节会马上显示成下一节。
   */
  async jumpToHeading(offset: number): Promise<void> {
    const view = this.markdownView;
    if (!view || !this.book) return;
    const parsed = parsedText(modeOf(view) === "preview" ? view.data : view.editor.getValue());
    const at = pageAtOffset(parsed.text, offset, parsed.anchors, parsed.segments);
    if (!at) return;
    const fraction = at.to > at.from ? Math.min(1, Math.max(0, (offset - at.from) / (at.to - at.from))) : 0;
    // 标题跳转由正文领跑：标题放在阅读线上，PDF 按逐行对齐跟过来（文字层读到后再对时也按正文对，不把正文拽走）
    this.leader.input("markdown");
    await this.jumpToPage(at.page, fraction, true);
    // 编辑视图按页内比例只是估计（行高不均），再按偏移精确对一次，然后让 PDF 跟正文对齐
    const latest = this.markdownView;
    const cm = latest && modeOf(latest) !== "preview" ? editorViewOf(latest) : null;
    const ratio = this.ratioFor("markdown");
    if (cm) scrollOffsetToBaseline(cm, offset, ratio);
    window.requestAnimationFrame(() => {
      this.quiet.markdown.hold(this.settings.quietMs);
      if (cm) scrollOffsetToBaseline(cm, offset, ratio);
      this.syncFromMarkdown(true);
    });
    if (latest) this.currentHeading = this.headingAt(latest, offset);
    this.refreshStatus();
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
      outline: this.outlineStatus(),
      autoOpen: this.settings.autoOpen,
      mode: this.mode,
      pdfName: this.book.pdf.name,
      pdfSide: this.settings.pdfSide
    };
    this.toolbar.update(status);
    this.host.statusBar.show();
    this.host.statusBar.setText(`PDF ${page}/${status.pageCount || "?"}${printed ? ` · p.${printed}` : ""}${this.paused ? " ⏸" : ""}`);
  }

  /** 工具条标题菜单要的东西：本文件标题、各自所在页、当前位置、显示偏好、这本书的展开记忆 */
  private outlineStatus(): OutlineStatus {
    const book = this.book;
    const cache = this.headingCache;
    if (cache && !cache.pages) {
      const index = book?.index ?? null;
      cache.pages = headingPages(cache.list, parsedText(cache.text).segments, (page, fromAnchor) => printedLabel(index, page, fromAnchor));
    }
    const settings = this.settings;
    return {
      headings: cache?.list ?? [],
      pages: cache?.pages ?? [],
      file: this.markdownView?.file?.path ?? "",
      current: this.currentHeading,
      zh: getLanguage().toLowerCase().startsWith("zh"),
      style: settings.outlineStyle,
      pageMode: settings.outlinePages,
      showLevel: settings.outlineShowLevel,
      showPage: settings.outlineShowPage,
      pinButton: settings.outlinePinButton,
      pinned: settings.outlinePinButton && settings.outlinePinned,
      book: (book && settings.outlineBooks[book.pdf.path]) || EMPTY_BOOK_STATE
    };
  }

  settingsChanged(): void {
    this.toolbar.place();
    this.updateCurrentFromMarkdown();
    this.refreshBaselines();
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
    }, true, this.ratioFor("pdf"));
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

  /**
   * 在第 page 页的锚点段里找 query，选中并滚到基准线（必要时先打开所在文件）。
   * whole 给了就改由它在全文里定位（返回全文偏移），疑字链接用：这一页段里没有时还要找本页的脚注。
   */
  async selectInMarkdown(page: number, query: string, context: { before?: string; after?: string; progress?: number }, whole?: (text: string) => [number, number] | null): Promise<boolean> {
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
    const local = whole ? null : locateInSegment(segment ? text.slice(segment.from, segment.to) : text, query, context);
    const found = whole ? whole(text) : local && ([base + local[0], base + local[1]] as [number, number]);
    if (!found) return false;
    const [from, to] = found;
    this.suppressSelectionUntil = Date.now() + 400;
    this.quiet.markdown.hold(this.settings.quietMs * 2);
    if (modeOf(view) === "preview") {
      // 落在注释区（不在本页段里）时比例会超出 0–1，夹住
      const fraction = segment && segment.to > segment.from ? Math.min(1, Math.max(0, (from - segment.from) / (segment.to - segment.from))) : 0;
      scrollMarkdownTo(view, { page, fraction }, this.ratioFor("markdown"));
      return true;
    }
    const editor = view.editor;
    editor.setSelection(editor.offsetToPos(from), editor.offsetToPos(to));
    const cm = editorViewOf(view);
    if (cm) {
      const height = cm.scrollDOM.clientHeight;
      cm.dispatch({ effects: EditorView.scrollIntoView(from, { y: "start", yMargin: height * this.ratioFor("markdown") }) });
    }
    this.setCurrent(page);
    this.setShade(this.settings.shadeStyle !== "off" ? page : null);
    this.refreshStatus(page);
    return true;
  }

  // ---------- 疑字链接 ----------

  /** focus: false 时不抢焦点（判字面板里换条，按键要留在面板） */
  async openSuspectLink(link: SuspectLink, options: { focus?: boolean } = {}): Promise<boolean> {
    const found = findNote(this.app, link.file);
    if (!found) {
      new Notice(`找不到笔记：${link.file}`);
      return false;
    }
    let leaf = this.markdownLeaf;
    if (!leaf || !this.leafAlive(leaf)) leaf = this.app.workspace.getLeaf(false);
    // 不抢焦点且已经开着这篇时不重开（重开会把焦点抢过去）
    const alreadyOpen = leaf.view instanceof MarkdownView && leaf.view.file?.path === found.path;
    if (options.focus !== false || !alreadyOpen) await leaf.openFile(found, { active: options.focus !== false });
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
    const selected = await this.selectInMarkdown(target, link.text, {}, (whole) => {
      const hit = locateLink(whole, parsedText(whole), link);
      return hit ? [hit.from, hit.to] : null;
    });
    const pane = await this.ensurePdf();
    if (pane && link.text) {
      const inner = link.ctx.indexOf(link.text);
      const context = inner === -1 ? { before: link.ctx, after: link.ctx } : { before: link.ctx.slice(0, inner), after: link.ctx.slice(inner + link.text.length) };
      this.quiet.pdf.hold(this.settings.quietMs * 2);
      pane.scrollTo({ page: target, fraction: 0 }, 0.02);
      await this.highlighter.show(pane, { page: target, query: link.text, context }, true, this.ratioFor("pdf"));
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
    new PdfSuggestModal(this.app, (pdf) => this.confirmBind(pdf, this.pairer.bindCandidates(file), onBound)).open();
  }

  /** 列出要写的笔记、用户勾选确认后，把 pdf 写进它们的 frontmatter */
  private confirmBind(pdf: TFile, candidates: TFile[], onBound: (() => void) | null = null): void {
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
  }

  // ---------- 配对失效的提示 ----------

  /** 写的 PDF 找不到、别的办法也找不到：提示并给「重新配对」 */
  private offerMissing(file: TFile, broken: BrokenLink): void {
    this.offer(`missing|${broken.root}|${broken.link}`,
      `找不到这本书的 PDF：${describeBroken(broken)}，库里没有这个文件。可能在 Obsidian 外改了名或挪了地方。`,
      "重新配对",
      () => this.chooseAndBind(file));
  }

  /** 写的 PDF 找不到、但按文件夹或同名找到了一份：提示并给「写回笔记」 */
  private offerFallback(file: TFile, book: Book): void {
    const broken = book.broken;
    if (!broken) return;
    this.offer(`fallback|${broken.root}|${broken.link}|${book.pdf.path}`,
      `${describeBroken(broken)}，库里找不到；先按「${book.pdf.path}」打开了。核对没错的话，把新位置写回笔记，下次就不再靠猜。`,
      "写回笔记",
      () => this.confirmBind(book.pdf, this.pairer.bindCandidates(file)));
  }

  /** 库里看到删了一份 PDF（Obsidian 外改名、移动时只报删和建） */
  pdfDeleted(file: TFile): void {
    const move = this.moves.deletedPdf({ path: file.path, size: file.stat.size, at: Date.now() });
    if (move) void this.pdfMoved(move.from, move.to);
  }

  pdfCreated(file: TFile): void {
    const move = this.moves.createdPdf({ path: file.path, size: file.stat.size, at: Date.now() });
    if (move) void this.pdfMoved(move.from, move.to);
  }

  /** PDF 从 from 挪到了 to（改名、移动）：还有笔记指着旧名的，提示并给「重新配对」 */
  async pdfMoved(from: string, to: string): Promise<void> {
    // Obsidian 里改名时，设置开了「自动更新内部链接」会顺手改 frontmatter；等它改完再看还剩哪些
    await delay(800);
    const pdf = this.app.vault.getAbstractFileByPath(to);
    if (!(pdf instanceof TFile)) return;
    const notes = this.pairer.notesPointingTo(from);
    if (!notes.length) return;
    this.offer(`moved|${from}|${to}`,
      `「${from}」像是改名或挪到了「${to}」，还有 ${notes.length} 篇笔记指着旧名。`,
      "重新配对",
      () => this.confirmBind(pdf, notes));
  }

  /** 右上角提示，带一个按钮；同一件事一次会话只提示一次 */
  private offer(key: string, message: string, action: string, run: () => void): void {
    if (this.offered.has(key)) return;
    this.offered.add(key);
    const notice = new Notice(createFragment((fragment) => {
      fragment.createDiv({ text: message });
      const button = fragment.createEl("button", { text: action, cls: "mod-cta aps-notice-action" });
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        notice.hide();
        run();
      });
    }), 30000);
  }

  /** 正文基准线处的页与页内比例（状态显示、测试用） */
  markdownPoint(): PagePoint | null {
    const view = this.markdownView;
    return view ? markdownPointAt(view, this.ratioFor("markdown")) : null;
  }

  /** PDF 基准线处的页与页内比例 */
  pdfPoint(): PagePoint | null {
    return this.pdf?.pointAtBaseline(this.ratioFor("pdf")) ?? null;
  }

  /** 逐行对齐排查用：正文基准线附近的对齐点、各点在两边的高度，以及正文 → PDF 算出的目标高度 */
  alignmentProbe(): { baseline: number; target: number | null; points: Array<{ offset: number; page: number; fraction: number; markdown: number | null; pdf: number | null }> } | null {
    const view = this.markdownView;
    const pane = this.pdf;
    const ratio = this.ratioFor("markdown");
    const point = view ? markdownPointAt(view, ratio) : null;
    const geometry = view ? markdownGeometry(view) : null;
    if (!view || !pane || !point || !geometry) return null;
    const points = this.lines.pointsNearOffset(parsedOf(view), point.offset);
    const heights = pane.heights();
    const baseline = geometry.baseline(ratio);
    return {
      baseline,
      target: pdfTargetForMarkdown(points, baseline, (offset) => geometry.heightAt(offset), heights),
      points: points.map((item) => ({ ...item, markdown: geometry.heightAt(item.offset), pdf: heights(item.page, item.fraction) }))
    };
  }

  get scroller(): HTMLElement | null {
    const view = this.markdownView;
    return view ? scrollerOf(view) : null;
  }
}

function describeBroken(broken: BrokenLink): string {
  return broken.from === "frontmatter" ? `笔记 frontmatter 写的「${broken.link}」` : `book.json 写的「${broken.link}」`;
}
