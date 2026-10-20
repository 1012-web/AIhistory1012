/**
 * 逐字高亮：选中正文 → 在 PDF 文字层里找到这些字、画高亮框；在 PDF 上选字 → 交给调用方在正文里选中。
 * 匹配与量框用移植自 PDF Collation 的代码（collation/ 目录，MIT）。
 * 只依赖浏览器 DOM：PDF 窗格的能力由宿主经 HighlightHost 注入（插件是 PdfPane，网页是 pdf.js 查看器）。
 */
import { matchSegmentSlices, type SelectionContext } from "./collation/compare";
import { computeSliceHighlightBoxes, type HighlightBox } from "./collation/pdf-dom";
import { baselineY, type PagePoint } from "./sync-math";

export interface HighlightRequest {
  page: number;
  query: string;
  context: SelectionContext;
}

/** 宿主提供的 PDF 窗格能力 */
export interface HighlightHost {
  /** 某页的页元素（PDF.js 的 .page） */
  pageElement(page: number): HTMLElement | null;
  /** 该页已渲染的文字层 span；没渲染出来时等至多 tries 次（每次约 50 毫秒） */
  textSpans(page: number, tries?: number): Promise<HTMLElement[]>;
  /** 把某页某处滚到基准线 */
  scrollTo(point: PagePoint, ratio: number): unknown;
  /** PDF 的滚动容器 */
  readonly container: HTMLElement | null;
}

export interface HighlighterOptions {
  /** 在 parent 里建一个带 cls 类名的 div 并返回（插件用 Obsidian 的 createDiv，网页用 document.createElement） */
  createDiv: (parent: HTMLElement, cls: string) => HTMLElement;
  layerClass?: string;
  boxClass?: string;
}

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** 页元素里已渲染的文字层 span（叶子、非空）；没有返回空数组 */
export function textLayerSpans(page: HTMLElement | null): HTMLElement[] {
  const layer = page?.querySelector<HTMLElement>(".textLayer");
  if (!layer) return [];
  return Array.from(layer.querySelectorAll<HTMLElement>("span")).filter((span) => !span.querySelector("span") && (span.textContent ?? "").length > 0);
}

/** textSpans 的通用实现：按 pageElement 轮询文字层 */
export async function waitTextSpans(pageElement: (page: number) => HTMLElement | null, page: number, tries = 60): Promise<HTMLElement[]> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const spans = textLayerSpans(pageElement(page));
    if (spans.length) return spans;
    await delay(50);
  }
  return [];
}

/**
 * 从原生选区和所属容器中取前后文与垂直位置比例，用于短词和多处重名的消歧。
 * 移植自 PDF Collation 的 extractSelectionContext（src/compare.ts，MIT），只保留 Range 一种入参。
 */
export function selectionContext(range: Range, container: HTMLElement | null): SelectionContext {
  let before = "";
  let after = "";
  let progress: number | undefined;
  if (container && container.contains(range.startContainer) && container.contains(range.endContainer)) {
    const doc = container.ownerDocument;
    try {
      const beforeRange = doc.createRange();
      beforeRange.selectNodeContents(container);
      beforeRange.setEnd(range.startContainer, range.startOffset);
      before = beforeRange.toString().slice(-60);
    } catch {
      // 跨节点异常忽略
    }
    try {
      const afterRange = doc.createRange();
      afterRange.selectNodeContents(container);
      afterRange.setStart(range.endContainer, range.endOffset);
      after = afterRange.toString().slice(0, 60);
    } catch {
      // 跨节点异常忽略
    }
    const selRect = range.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (containerRect.height > 0) progress = Math.max(0, Math.min(1, (selRect.top - containerRect.top) / containerRect.height));
  }
  return { before, after, progress };
}

/** 正文页段里找 PDF 上选中的字：返回相对段的 [from, to) */
export function locateInSegment(segment: string, query: string, context: SelectionContext): [number, number] | null {
  const match = matchSegmentSlices([segment], query, context);
  const slice = match?.slices[0];
  return slice ? [slice.startOffset, slice.endOffset] : null;
}

export class PdfHighlighter {
  private last: { host: HighlightHost; request: HighlightRequest; ratio: number } | null = null;
  /** 代次：每次新的高亮请求加一，进行中的旧请求等完异步后发现代次变了就作废 */
  private generation = 0;
  private redrawing = false;
  /** 上次画高亮的文档（清高亮时用；插件可能在弹出窗口里） */
  private lastDoc: Document | null = null;
  private readonly layerClass: string;
  private readonly boxClass: string;
  private readonly createDiv: HighlighterOptions["createDiv"];

  constructor(options: HighlighterOptions) {
    this.createDiv = options.createDiv;
    this.layerClass = options.layerClass ?? "aps-hl-layer";
    this.boxClass = options.boxClass ?? "aps-hl";
  }

  /** 在 PDF 上高亮；找不到返回 false。scroll 为真时，高亮不在视野里就把它滚到基准线。 */
  async show(host: HighlightHost, request: HighlightRequest, scroll: boolean, ratio: number): Promise<boolean> {
    this.clear();
    const generation = this.generation;
    if (!request.query.trim()) return false;
    this.last = { host, request, ratio };
    return this.paint(host, request, scroll, ratio, generation);
  }

  private async paint(host: HighlightHost, request: HighlightRequest, scroll: boolean, ratio: number, generation: number): Promise<boolean> {
    let spans = await host.textSpans(request.page, 2);
    if (!spans.length && generation === this.generation) {
      // 文字层只在页面进入视野附近时才渲染：先翻到那页再等
      host.scrollTo({ page: request.page, fraction: request.context.progress ?? 0 }, ratio);
      spans = await host.textSpans(request.page);
    }
    if (generation !== this.generation) return false;
    const pageElement = host.pageElement(request.page);
    if (!spans.length || !pageElement) return false;
    const match = matchSegmentSlices(spans.map((span) => span.textContent ?? ""), request.query, request.context);
    if (!match) return false;
    const boxes = computeSliceHighlightBoxes(
      match.slices.map((slice) => ({ spanIndex: slice.segIdx, startOffset: slice.startOffset, endOffset: slice.endOffset })),
      spans,
      pageElement
    );
    if (!boxes.length) return false;
    for (const layer of Array.from(pageElement.querySelectorAll(`.${this.layerClass}`))) layer.remove();
    this.lastDoc = pageElement.ownerDocument;
    this.draw(pageElement, boxes);
    if (scroll) this.reveal(host, pageElement, boxes[0], ratio);
    return true;
  }

  /** PDF.js 重画了页面（缩放等）把层清掉时，按上次的请求补画；给了页码则只在该页时补；不打断进行中的新请求 */
  async redraw(pageNumber?: number): Promise<void> {
    const last = this.last;
    if (!last || this.redrawing) return;
    if (pageNumber !== undefined && pageNumber !== last.request.page) return;
    const page = last.host.pageElement(last.request.page);
    if (!page || page.querySelector(`.${this.layerClass}`)) return;
    this.redrawing = true;
    try {
      await this.paint(last.host, last.request, false, last.ratio, this.generation);
    } finally {
      this.redrawing = false;
    }
  }

  private draw(pageElement: HTMLElement, boxes: HighlightBox[]): void {
    const rect = pageElement.getBoundingClientRect();
    const layer = this.createDiv(pageElement, this.layerClass);
    for (const box of boxes) {
      const element = this.createDiv(layer, this.boxClass);
      // 用页面比例定位：缩放后 PDF.js 若保留了这层，位置仍然对
      element.style.left = `${(box.left / rect.width) * 100}%`;
      element.style.top = `${(box.top / rect.height) * 100}%`;
      element.style.width = `${(box.width / rect.width) * 100}%`;
      element.style.height = `${(box.height / rect.height) * 100}%`;
    }
  }

  private reveal(host: HighlightHost, pageElement: HTMLElement, box: HighlightBox, ratio: number): void {
    const container = host.container;
    if (!container) return;
    const view = container.getBoundingClientRect();
    const top = pageElement.getBoundingClientRect().top + box.top;
    if (top >= view.top + 8 && top + box.height <= view.bottom - 8) return;
    container.scrollTop += top - baselineY(view.top, view.height, ratio);
  }

  clear(): void {
    this.generation += 1;
    const doc = this.last?.host.container?.ownerDocument ?? this.lastDoc;
    this.last = null;
    if (!doc) return;
    for (const layer of Array.from(doc.querySelectorAll(`.${this.layerClass}`))) layer.remove();
  }

  get active(): boolean {
    return this.last !== null;
  }
}
