/**
 * 繁简通搜挂进 Obsidian：查找条（ui/FindBar）挂在 PDF 窗格右上角；入口是工具条按钮、命令，
 * 以及（设置里默认开）PDF 窗格里的 Ctrl/⌘+F。只接管 PDF 窗格里的 Ctrl+F，笔记里的不碰，
 * 免得与 Better Search Result Views 等在笔记里接管 Ctrl+F 的插件冲突。
 * 跳到命中：PDF 翻到那页，再用逐字高亮（core/highlight）标出命中的原文。
 */
import { type TFile, type WorkspaceLeaf } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import { PdfFinder, type PdfHit } from "./core/pdf-search";
import { PdfPane } from "./pdf-view";
import type { PdfSyncSettings } from "./settings";
import { FindBar, type FindResult } from "./ui";
import type { PdfHighlighter } from "./core/highlight";

export interface FindHostOptions {
  settings(): PdfSyncSettings;
  /** 当前要搜的 PDF 窗格：活动窗格是 PDF 就用它，否则用配对的那个 */
  pane(): PdfPane | null;
  highlighter: PdfHighlighter;
}

export class FindHost {
  private root: Root | null = null;
  private mount: HTMLElement | null = null;
  private leaf: WorkspaceLeaf | null = null;
  private readonly finders = new Map<string, { mtime: number; finder: PdfFinder }>();

  constructor(private readonly options: FindHostOptions) {}

  get isOpen(): boolean {
    return this.root !== null;
  }

  /** 打开查找条（已开就把焦点放回输入框）；没有 PDF 窗格返回 false */
  open(): boolean {
    const pane = this.options.pane();
    if (!pane) return false;
    if (this.root && this.leaf === pane.leaf) {
      this.mount?.querySelector<HTMLInputElement>("input")?.focus();
      return true;
    }
    this.close();
    const host = pane.leaf.view.containerEl;
    this.leaf = pane.leaf;
    this.mount = host.createDiv({ cls: "aps-find-mount" });
    this.root = createRoot(this.mount);
    this.root.render(
      <FindBar
        search={(query, onProgress) => this.search(pane, query, onProgress)}
        reveal={(hit) => void this.reveal(pane, hit)}
        onClose={() => this.close()}
      />
    );
    return true;
  }

  close(): void {
    const root = this.root;
    const mount = this.mount;
    this.root = null;
    this.mount = null;
    this.leaf = null;
    if (root) {
      window.setTimeout(() => {
        root.unmount();
        mount?.remove();
      }, 0);
    }
  }

  /** Ctrl/⌘+F：活动窗格是 PDF、且设置里开了接管时，打开查找条并吞掉按键 */
  onKeyDown(event: KeyboardEvent, activeLeaf: WorkspaceLeaf | null): void {
    if (!this.options.settings().findTakeover) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return;
    if (activeLeaf?.view.getViewType() !== "pdf") return;
    if (!this.open()) return;
    event.preventDefault();
    event.stopPropagation();
  }

  private finderFor(pane: PdfPane): PdfFinder | null {
    const file: TFile | null = pane.file;
    if (!file) return null;
    const cached = this.finders.get(file.path);
    if (cached && cached.mtime === file.stat.mtime) return cached.finder;
    const finder = new PdfFinder({ pageCount: () => pane.pageCount, pageText: (page) => pane.pageText(page) });
    this.finders.set(file.path, { mtime: file.stat.mtime, finder });
    return finder;
  }

  private async search(pane: PdfPane, query: string, onProgress: (done: number, total: number) => void): Promise<FindResult> {
    await pane.waitReady();
    const finder = this.finderFor(pane);
    if (!finder) return { hits: [], noTextLayer: false };
    const settings = this.options.settings();
    const variants = { unihanTradSimp: settings.unihanTradSimp, unihanZ: settings.unihanZ, unihanSemantic: settings.unihanSemantic };
    const hits = await finder.search(query, variants, onProgress);
    const pages = await finder.load();
    return { hits, noTextLayer: !hits.length && pages.every((text) => !text.trim()) };
  }

  private async reveal(pane: PdfPane, hit: PdfHit): Promise<void> {
    const baseline = this.options.settings().baseline;
    const shown = await this.options.highlighter.show(pane, { page: hit.page, query: hit.text, context: { before: hit.before, after: hit.after } }, true, baseline);
    // 高亮不出来（文字层还没渲染等）也至少翻到那页
    if (!shown) pane.scrollTo({ page: hit.page, fraction: 0 }, baseline);
  }
}

