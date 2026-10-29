/**
 * 实时预览：两窗格 + 工具条缩影（design/onboarding-settings-approved.html）。
 * 首次引导与外观面板共用；随选项即时变化：PDF 左右、工具条停哪、联动方式、页码标签、当前页标示、阅读线样式与高度、夜间色调；
 * 给了 outline 时在工具条下面画一个小标题菜单（目录树或分栏、级别、页码）。
 * 动效用 Motion 弹簧 420/30，减少动效时瞬切。
 */
import { LayoutGroup, MotionConfig, motion } from "motion/react";
import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { SPRING } from "./motion";
import type { SyncMode } from "./Toolbar";

export type DockChoice = "markdown" | "pdf" | "floating";

export interface PreviewOptions {
  pdfSide: "left" | "right";
  dock: DockChoice;
  mode: SyncMode;
  pageLabels: boolean;
  /** 当前页标示：淡底色 / 左侧竖条 / 不标示 */
  shade: "tint" | "bar" | "off";
  /** 阅读线样式；false 不画（暂停时也不画） */
  baseline?: "band" | "line" | "markers" | false;
  /** 阅读线高度（%），缺省 35 */
  baselinePercent?: number;
  /** 标题菜单缩影；不给不画 */
  outline?: PreviewOutline;
  /** 夜间模式生效时的色调；false 不反色 */
  night?: "neutral" | "warm" | false;
  reducedMotion: boolean;
}

export interface PreviewOutline {
  style: "tree" | "columns";
  pages: "printed" | "pdf" | "both";
  showLevel: boolean;
  showPage: boolean;
}

const OUTLINE_ROWS = [
  { level: 1, title: "第三章", pdf: 98, printed: 95 },
  { level: 2, title: "第二节", pdf: 104, printed: 101 },
  { level: 3, title: "一、……", pdf: 112, printed: 109 }
];

function pageText(pages: PreviewOutline["pages"], pdf: number, printed: number): string {
  if (pages === "pdf") return `PDF ${pdf}`;
  if (pages === "both") return `${printed} · PDF ${pdf}`;
  return `第${printed}页`;
}

function OutlineMini({ outline, left, top }: { outline: PreviewOutline; left: number; top: number }): ReactElement {
  const row = (item: (typeof OUTLINE_ROWS)[number], indent: boolean) => (
    <div key={item.title} className="aps-pv-ol-row" style={indent ? { paddingLeft: (item.level - 1) * 8 } : undefined}>
      {outline.showLevel ? <span className="aps-pv-ol-level">H{item.level}</span> : null}
      <span className="aps-pv-ol-title">{item.title}</span>
      {outline.showPage ? <span className="aps-pv-ol-page">{pageText(outline.pages, item.pdf, item.printed)}</span> : null}
    </div>
  );
  return (
    <motion.div className={`aps-pv-outline is-${outline.style}`} initial={false} animate={{ left, top }} transition={SPRING}>
      {outline.style === "tree" ? OUTLINE_ROWS.map((item) => row(item, true)) : OUTLINE_ROWS.map((item) => <div key={item.title} className="aps-pv-ol-col">{row(item, false)}</div>)}
    </motion.div>
  );
}

const MODE_LABEL: Record<SyncMode, string> = { both: "双向", one: "单向", paused: "暂停" };

function Lines({ widths }: { widths: string[] }): ReactElement {
  return (
    <>
      {widths.map((width, index) => <div key={index} className="aps-pv-line" style={{ width }} />)}
    </>
  );
}

export function Preview({ options, height = 150, className }: { options: PreviewOptions; height?: number; className?: string }): ReactElement {
  const boxRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0, bar: 0 });

  useLayoutEffect(() => {
    const box = boxRef.current;
    const view = box?.ownerDocument.defaultView;
    if (!box || !view?.ResizeObserver) return undefined;
    const measure = () => setSize({ width: box.clientWidth, height: box.clientHeight, bar: barRef.current?.offsetWidth ?? 0 });
    measure();
    const observer = new view.ResizeObserver(measure);
    observer.observe(box);
    if (barRef.current) observer.observe(barRef.current);
    return () => observer.disconnect();
  }, []);

  const half = size.width / 2;
  const mdLeft = options.pdfSide === "left" ? half : 0;
  const pdfLeft = options.pdfSide === "left" ? 0 : half;
  let left = mdLeft + 8;
  let top = 4;
  if (options.dock === "pdf") left = pdfLeft + 8;
  if (options.dock === "floating") {
    left = Math.round(size.width / 2 - size.bar / 2);
    top = Math.round(size.height / 2 - 10);
  }

  const pdfPane = (
    <motion.div key="pdf" layout className={`aps-pv-pane${options.night ? ` is-night is-${options.night}` : ""}`} data-pane="pdf" transition={SPRING}>
      <span className="aps-pv-head">PDF</span>
      <Lines widths={["80%", "100%", "90%", "60%"]} />
    </motion.div>
  );
  const mdPane = (
    <motion.div key="md" layout className="aps-pv-pane" data-pane="markdown" transition={SPRING}>
      <span className="aps-pv-head">正文</span>
      <Lines widths={["100%"]} />
      <div className={`aps-pv-tint is-${options.shade}`}>
        {options.pageLabels ? <span className="aps-pv-chip">37 · p.112</span> : null}
        <Lines widths={["92%", "85%"]} />
      </div>
      <Lines widths={["70%"]} />
    </motion.div>
  );

  return (
    <MotionConfig reducedMotion={options.reducedMotion ? "always" : "user"}>
      <LayoutGroup>
        <div ref={boxRef} className={`aps-preview ${className ?? ""}`} style={{ height }} data-side={options.pdfSide} data-dock={options.dock}>
          {options.pdfSide === "left" ? [pdfPane, mdPane] : [mdPane, pdfPane]}
          {options.baseline && options.mode !== "paused" ? (
            <div className={`aps-pv-baseline is-${options.baseline}`} style={{ top: `${options.baselinePercent ?? 35}%` }} aria-hidden="true">
              {options.baseline === "line" ? <span className="aps-baseline-label">阅读线</span> : null}
            </div>
          ) : null}
          <motion.div
            ref={barRef}
            className="aps-pv-bar"
            initial={false}
            animate={{ left, top }}
            transition={SPRING}
          >
            ⋮⋮ ‹ 37 › <span className="aps-pv-mode">{MODE_LABEL[options.mode]}</span> ⇄
          </motion.div>
          {options.outline ? <OutlineMini outline={options.outline} left={Math.max(4, Math.min(left, size.width - 200))} top={top + 24} /> : null}
        </div>
      </LayoutGroup>
    </MotionConfig>
  );
}
