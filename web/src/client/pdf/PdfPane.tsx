"use client";
/**
 * PDF 一侧：pdf.js 官方查看器组件（PDFViewer，带文字层与查找）。
 * 对外是一个命令式句柄：量基准线处的页与页内比例、滚到某页某处、缩放、逐字高亮、取某页文字层文字。
 * 量法与 S3 的 pdf-view.ts 相同（页方框 → pdfPointAt），只是查看器是自己建的，不用钻 Obsidian 的内部对象。
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { pdfSource } from "../api";
import { asset } from "../demo";
import { baselineY, pdfPointAt, scrollDeltaToBaseline, type PageBox, type PagePoint, type SelectionContext } from "@/s3/core";
import { PdfHighlighter, selectionContext, waitTextSpans, type HighlightRequest } from "@/s3/core";

/** 高亮层用普通 DOM 建（core 的高亮器由宿主注入建元素的办法） */
function domDiv(parent: HTMLElement, cls: string): HTMLElement {
  const div = parent.ownerDocument.createElement("div");
  div.className = cls;
  parent.appendChild(div);
  return div;
}

type PdfjsModule = typeof import("pdfjs-dist");
type ViewerModule = typeof import("pdfjs-dist/web/pdf_viewer.mjs");
type PDFViewerInstance = InstanceType<ViewerModule["PDFViewer"]>;
type PDFDocumentProxy = Awaited<ReturnType<PdfjsModule["getDocument"]>["promise"]>;

let loader: Promise<{ pdfjs: PdfjsModule; viewer: ViewerModule }> | null = null;

/** pdf_viewer.mjs 从 globalThis.pdfjsLib 取核心库：先载核心、挂上，再载查看器 */
function loadPdfjs() {
  loader ??= (async () => {
    const pdfjs = await import("pdfjs-dist");
    (globalThis as unknown as { pdfjsLib: PdfjsModule }).pdfjsLib = pdfjs;
    pdfjs.GlobalWorkerOptions.workerSrc = asset("/pdfjs/pdf.worker.min.mjs");
    const viewer = await import("pdfjs-dist/web/pdf_viewer.mjs");
    return { pdfjs, viewer };
  })();
  return loader;
}

export interface PdfTextSelection {
  page: number;
  query: string;
  context: SelectionContext;
}

export interface PdfHandle {
  readonly ready: boolean;
  readonly pageCount: number;
  readonly currentPage: number;
  readonly container: HTMLElement | null;
  pointAtBaseline(): PagePoint | null;
  scrollToPoint(point: PagePoint): void;
  scale: number;
  setScale(scale: number | "page-width"): void;
  highlight(request: HighlightRequest, scroll: boolean): Promise<boolean>;
  clearHighlight(): void;
  pageText(page: number): Promise<string>;
}

interface Props {
  path: string | null;
  /** 磁盘上的 PDF 换了时加一，重新载入 */
  reloadKey: number;
  ratio: number;
  onScroll: () => void;
  onUserInput: () => void;
  onReady: (pageCount: number) => void;
  onScaleChange: (scale: number) => void;
  onTextSelect: (selection: PdfTextSelection) => void;
  onError: (message: string) => void;
}

export const PdfPane = forwardRef<PdfHandle, Props>(function PdfPane(props, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PDFViewerInstance | null>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const highlighter = useRef(new PdfHighlighter({ createDiv: domDiv, layerClass: "aih-hl-layer", boxClass: "aih-hl" }));
  /** 「适合页宽」模式：窗格宽度一变就重算（拖分栏、换边、窗口缩放） */
  const fitWidth = useRef(true);
  const callbacks = useRef(props);
  callbacks.current = props;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !props.path) return;
    let cancelled = false;
    let task: ReturnType<PdfjsModule["getDocument"]> | null = null;
    const viewerEl = container.querySelector<HTMLDivElement>(".pdfViewer")!;
    viewerEl.replaceChildren();
    void (async () => {
      try {
        const { pdfjs, viewer: lib } = await loadPdfjs();
        if (cancelled) return;
        const eventBus = new lib.EventBus();
        const linkService = new lib.PDFLinkService({ eventBus });
        const findController = new lib.PDFFindController({ eventBus, linkService });
        const viewer = new lib.PDFViewer({ container, viewer: viewerEl, eventBus, linkService, findController, textLayerMode: 1 });
        linkService.setViewer(viewer);
        viewerRef.current = viewer;
        eventBus.on("pagesinit", () => {
          fitWidth.current = true;
          // 分栏刚挂上时宽度可能还是 0：等到有宽度再按页宽排
          const fit = (tries: number) => {
            if (cancelled || viewerRef.current !== viewer) return;
            if (container.clientWidth > 0 || tries <= 0) {
              viewer.currentScaleValue = "page-width";
              callbacks.current.onReady(viewer.pagesCount);
            } else requestAnimationFrame(() => fit(tries - 1));
          };
          fit(120);
        });
        eventBus.on("scalechanging", (event: { scale: number }) => callbacks.current.onScaleChange(event.scale));
        eventBus.on("textlayerrendered", (event: { pageNumber: number }) => void highlighter.current.redraw(event.pageNumber));
        const source = pdfSource(props.path!);
        task = pdfjs.getDocument({
          ...source,
          cMapUrl: asset("/pdfjs/cmaps/"),
          cMapPacked: true,
          standardFontDataUrl: asset("/pdfjs/standard_fonts/"),
        });
        const doc = await task.promise;
        if (cancelled) return;
        docRef.current = doc;
        viewer.setDocument(doc);
        linkService.setDocument(doc);
      } catch (error) {
        if (!cancelled) callbacks.current.onError(`PDF 载入失败：${(error as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
      highlighter.current.clear();
      viewerRef.current?.setDocument(null as never);
      viewerRef.current = null;
      docRef.current = null;
      void task?.destroy();
    };
  }, [props.path, props.reloadKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let last = -1;
    const observer = new ResizeObserver(() => {
      const width = container.clientWidth;
      if (Math.abs(width - last) < 1) return;
      last = width;
      const viewer = viewerRef.current;
      if (viewer && fitWidth.current && width > 0 && viewer.pagesCount) {
        const keep = viewer.currentPageNumber;
        viewer.currentScaleValue = "page-width";
        viewer.currentPageNumber = keep;
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // 用户输入：滚轮、按键、指针都算（领跑方判定）；滚动事件交给上层判断要不要带动正文
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // 只处理在本栏里按下的那次选字（点别处的按钮时 PDF 上残留的选区不算）
    let downInside = false;
    const input = (event?: Event) => {
      if (event?.type === "pointerdown") downInside = true;
      callbacks.current.onUserInput();
    };
    const scroll = () => callbacks.current.onScroll();
    const mouseup = () => {
      if (!downInside) return;
      downInside = false;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;
      const range = selection.getRangeAt(0);
      const layer = (range.startContainer.parentElement ?? null)?.closest<HTMLElement>(".textLayer");
      if (!layer || !container.contains(layer)) return;
      const page = layer?.closest<HTMLElement>(".page[data-page-number]");
      const query = selection.toString().trim();
      if (!layer || !page || !query) return;
      callbacks.current.onTextSelect({ page: Number(page.dataset.pageNumber), query, context: selectionContext(range, layer) });
    };
    container.addEventListener("wheel", input, { passive: true });
    container.addEventListener("pointerdown", input);
    container.addEventListener("keydown", input);
    container.addEventListener("scroll", scroll, { passive: true });
    // 选字松手可能落在 PDF 栏外（拖过了头），所以听整页的 pointerup，再看选区是否起于本栏文字层
    document.addEventListener("pointerup", mouseup);
    return () => {
      container.removeEventListener("wheel", input);
      container.removeEventListener("pointerdown", input);
      container.removeEventListener("keydown", input);
      container.removeEventListener("scroll", scroll);
      document.removeEventListener("pointerup", mouseup);
    };
  }, []);

  useImperativeHandle(
    ref,
    (): PdfHandle => {
      const pageElement = (page: number) => containerRef.current?.querySelector<HTMLElement>(`.page[data-page-number="${page}"]`) ?? null;
      const pageBoxes = (): PageBox[] => {
        const out: PageBox[] = [];
        for (const element of Array.from(containerRef.current?.querySelectorAll<HTMLElement>(".page[data-page-number]") ?? [])) {
          const rect = element.getBoundingClientRect();
          if (rect.height > 0) out.push({ page: Number(element.dataset.pageNumber), top: rect.top, bottom: rect.bottom });
        }
        return out;
      };
      const handle: PdfHandle = {
        get ready() {
          return !!viewerRef.current && (viewerRef.current.pagesCount ?? 0) > 0;
        },
        get pageCount() {
          return viewerRef.current?.pagesCount ?? 0;
        },
        get currentPage() {
          return viewerRef.current?.currentPageNumber ?? 1;
        },
        get container() {
          return containerRef.current;
        },
        pointAtBaseline() {
          const container = containerRef.current;
          if (!container || !handle.ready) return null;
          const rect = container.getBoundingClientRect();
          return pdfPointAt(pageBoxes(), baselineY(rect.top, rect.height, callbacks.current.ratio));
        },
        scrollToPoint(point) {
          const container = containerRef.current;
          const element = pageElement(point.page);
          if (!container || !element) return;
          const pageRect = element.getBoundingClientRect();
          const rect = container.getBoundingClientRect();
          const delta = scrollDeltaToBaseline(pageRect.top + pageRect.height * point.fraction, rect.top, rect.height, callbacks.current.ratio);
          if (Math.abs(delta) >= 1) container.scrollTop += delta;
        },
        get scale() {
          return viewerRef.current?.currentScale ?? 1;
        },
        set scale(value: number) {
          handle.setScale(value);
        },
        setScale(scale) {
          const viewer = viewerRef.current;
          if (!viewer) return;
          fitWidth.current = scale === "page-width";
          viewer.currentScaleValue = scale === "page-width" ? scale : String(Math.min(4, Math.max(0.25, Math.round(scale * 100) / 100)));
        },
        highlight(request, scroll) {
          return highlighter.current.show(
            {
              pageElement,
              textSpans: (page, tries) => waitTextSpans(pageElement, page, tries),
              scrollTo: (point) => handle.scrollToPoint(point),
              container: containerRef.current,
            },
            request,
            scroll,
            callbacks.current.ratio
          );
        },
        clearHighlight() {
          highlighter.current.clear();
        },
        async pageText(page) {
          const doc = docRef.current;
          if (!doc || page < 1 || page > doc.numPages) return "";
          const content = await (await doc.getPage(page)).getTextContent();
          return content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join("");
        },
      };
      return handle;
    },
    []
  );

  return (
    <div className="aih-pdf-pane relative h-full w-full bg-[var(--pdf-bg)]" data-testid="pdf-pane">
      {!props.path && <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">这本书没有配上 PDF</div>}
      <div ref={containerRef} className="aih-pdf-container absolute inset-0 overflow-auto" tabIndex={0}>
        <div className="pdfViewer" />
      </div>
    </div>
  );
});
