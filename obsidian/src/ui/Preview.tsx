/**
 * 实时预览：两窗格 + 工具条缩影（design/onboarding-settings-approved.html）。
 * 首次引导与设置页共用；随选项即时变化：PDF 左右、工具条停哪、联动方式、页码标签、当前页底色。
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
  shade: boolean;
  reducedMotion: boolean;
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
    <motion.div key="pdf" layout className="aps-pv-pane" data-pane="pdf" transition={SPRING}>
      <span className="aps-pv-head">PDF</span>
      <Lines widths={["80%", "100%", "90%", "60%"]} />
    </motion.div>
  );
  const mdPane = (
    <motion.div key="md" layout className="aps-pv-pane" data-pane="markdown" transition={SPRING}>
      <span className="aps-pv-head">正文</span>
      <Lines widths={["100%"]} />
      <div className={`aps-pv-tint${options.shade ? " is-on" : ""}`}>
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
          <motion.div
            ref={barRef}
            className="aps-pv-bar"
            initial={false}
            animate={{ left, top }}
            transition={SPRING}
          >
            ⋮⋮ ‹ 37 › <span className="aps-pv-mode">{MODE_LABEL[options.mode]}</span> ⇄
          </motion.div>
        </div>
      </LayoutGroup>
    </MotionConfig>
  );
}
