/**
 * Obsidian 内置 PDF 视图的内部对象。不是公开接口，全插件只在这里碰它们；
 * 写法与类型照 note1012 的 src/modules/pdf/pdf-leaf.ts、src/shared/mineru/types.ts。
 * 拿不到内部对象时，跳页退回公开的 setEphemeralState({ subpath: "#page=N" })。
 */
import type { TFile, WorkspaceLeaf } from "obsidian";
import type { PdfPageLines } from "./core/line-align";
import { groupTextLines, type TextItemLike, type ViewportLike } from "./core/pdf-lines";
import { baselineY, clamp01, pdfPointAt, scrollDeltaToBaseline, type PageBox, type PagePoint } from "./core/sync-math";

export interface PDFEventBus {
  on: (event: string, callback: (payload: unknown) => void) => void;
  off: (event: string, callback: (payload: unknown) => void) => void;
}

export interface PDFTextContent {
  items: TextItemLike[];
  styles?: Record<string, { vertical?: boolean }>;
}

export interface PDFPageProxy {
  getTextContent: () => Promise<PDFTextContent>;
  getViewport: (options: { scale: number }) => ViewportLike;
}

export interface PDFDocumentProxy {
  numPages: number;
  getPage: (page: number) => Promise<PDFPageProxy>;
}

export interface PDFPageView {
  div: HTMLElement;
}

export interface PDFViewerChild {
  file?: { path: string };
  pdfViewer?: {
    pdfViewer?: {
      currentPageNumber: number;
      pagesCount: number;
      scrollPageIntoView?: (options: { pageNumber: number }) => void;
      eventBus?: PDFEventBus;
      currentScaleValue?: string | number;
      currentScale?: number;
      pdfDocument?: PDFDocumentProxy;
    };
    dom?: { viewerContainerEl?: HTMLElement };
  };
  getPage?: (page: number) => PDFPageView | null;
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export function pdfViewerChild(leaf: WorkspaceLeaf | null | undefined): PDFViewerChild | null {
  const view = leaf?.view as unknown as { viewer?: { child?: PDFViewerChild } } | undefined;
  return view?.viewer?.child ?? null;
}

export function leafPdfFile(leaf: WorkspaceLeaf | null | undefined): TFile | null {
  if (leaf?.view.getViewType() !== "pdf") return null;
  return (leaf.view as unknown as { file?: TFile }).file ?? null;
}

/** 一个打开着的 PDF 窗格，包一层：量位置、滚到某页某处、缩放、取文字层。 */
export class PdfPane {
  constructor(readonly leaf: WorkspaceLeaf) {}

  get child(): PDFViewerChild | null {
    return pdfViewerChild(this.leaf);
  }

  get viewer(): NonNullable<NonNullable<PDFViewerChild["pdfViewer"]>["pdfViewer"]> | null {
    return this.child?.pdfViewer?.pdfViewer ?? null;
  }

  get container(): HTMLElement | null {
    return this.child?.pdfViewer?.dom?.viewerContainerEl ?? null;
  }

  get file(): TFile | null {
    return leafPdfFile(this.leaf);
  }

  get pageCount(): number {
    return this.viewer?.pagesCount ?? 0;
  }

  get currentPage(): number {
    return this.viewer?.currentPageNumber ?? 1;
  }

  /** 内部对象可用（PDF.js 已就绪） */
  get ready(): boolean {
    return !!this.container && this.pageCount > 0;
  }

  async waitReady(tries = 100): Promise<boolean> {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      if (this.ready) return true;
      await delay(50);
    }
    return false;
  }

  pageElement(page: number): HTMLElement | null {
    return this.container?.querySelector<HTMLElement>(`.page[data-page-number="${page}"]`) ?? null;
  }

  pageBoxes(): PageBox[] {
    const container = this.container;
    if (!container) return [];
    const boxes: PageBox[] = [];
    for (const element of Array.from(container.querySelectorAll<HTMLElement>(".page[data-page-number]"))) {
      const rect = element.getBoundingClientRect();
      if (rect.height <= 0) continue;
      boxes.push({ page: Number(element.dataset.pageNumber), top: rect.top, bottom: rect.bottom });
    }
    return boxes;
  }

  /** 基准线落在哪页、页内多少 */
  pointAtBaseline(ratio: number): PagePoint | null {
    const container = this.container;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    return pdfPointAt(this.pageBoxes(), baselineY(rect.top, rect.height, ratio));
  }

  /** 把第 page 页的 fraction 处滚到基准线。返回是否真的滚了（量不到时退回公开接口跳页）。 */
  scrollTo(point: PagePoint, ratio: number): boolean {
    const container = this.container;
    const element = this.pageElement(point.page);
    if (!container || !element) {
      this.fallbackJump(point.page);
      return true;
    }
    const pageRect = element.getBoundingClientRect();
    const rect = container.getBoundingClientRect();
    const delta = scrollDeltaToBaseline(pageRect.top + pageRect.height * point.fraction, rect.top, rect.height, ratio);
    if (Math.abs(delta) < 1) return false;
    container.scrollTop += delta;
    return true;
  }

  /**
   * 逐行跟随用的量法：（页，页内比例）→ 滚动容器里的文档高度（像素，不随滚动变）。
   * 返回的函数记着这一刻各页的位置，一次跟随用完即弃；该页没有页元素时给 null。
   */
  heights(): (page: number, fraction: number) => number | null {
    const container = this.container;
    if (!container) return () => null;
    const origin = container.getBoundingClientRect().top - container.scrollTop;
    const boxes = new Map<number, DOMRect | null>();
    return (page, fraction) => {
      let box = boxes.get(page);
      if (box === undefined) {
        box = this.pageElement(page)?.getBoundingClientRect() ?? null;
        boxes.set(page, box);
      }
      return box && box.height > 0 ? box.top + box.height * fraction - origin : null;
    };
  }

  /** 基准线在滚动容器里的文档高度 */
  baselineHeight(ratio: number): number | null {
    const container = this.container;
    return container ? container.scrollTop + container.getBoundingClientRect().height * clamp01(ratio) : null;
  }

  /** 把文档高度 height 滚到基准线；返回是否真的滚了 */
  scrollToHeight(height: number, ratio: number): boolean {
    const container = this.container;
    const now = this.baselineHeight(ratio);
    if (!container || now === null || Math.abs(height - now) < 1) return false;
    container.scrollTop += height - now;
    return true;
  }

  /** 第 page 页文字层的各行（PDF.js 抽取，不依赖是否渲染过）；读不到返回 null */
  async pageLines(page: number): Promise<PdfPageLines | null> {
    const doc = this.viewer?.pdfDocument;
    if (!doc || page < 1 || page > doc.numPages) return null;
    const proxy = await doc.getPage(page);
    const content = await proxy.getTextContent();
    return { page, ...groupTextLines(content.items, content.styles, proxy.getViewport({ scale: 1 })) };
  }

  /** 公开接口跳页：内部对象不可用时的退路 */
  fallbackJump(page: number): void {
    const view = this.leaf.view as unknown as { setEphemeralState?: (state: unknown) => void };
    view.setEphemeralState?.({ subpath: `#page=${page}` });
  }

  get scale(): number {
    return this.viewer?.currentScale ?? 1;
  }

  setScale(scale: number): void {
    const viewer = this.viewer;
    if (!viewer) return;
    viewer.currentScaleValue = String(Math.min(4, Math.max(0.25, Math.round(scale * 100) / 100)));
  }

  /** 第 page 页的文字层文字（PDF.js 抽取，不依赖是否渲染过） */
  async pageText(page: number): Promise<string> {
    const doc = this.viewer?.pdfDocument;
    if (!doc) return "";
    const content = await (await doc.getPage(page)).getTextContent();
    return content.items.map((item) => (item.str ?? "") + (item.hasEOL ? "\n" : "")).join("");
  }

  /** 已渲染的文字层 span；没渲染出来时等一会儿 */
  async textSpans(page: number, tries = 60): Promise<HTMLElement[]> {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      const layer = this.pageElement(page)?.querySelector<HTMLElement>(".textLayer");
      const spans = layer ? Array.from(layer.querySelectorAll<HTMLElement>("span")).filter((span) => !span.querySelector("span") && (span.textContent ?? "").length > 0) : [];
      if (spans.length) return spans;
      await delay(50);
    }
    return [];
  }
}
