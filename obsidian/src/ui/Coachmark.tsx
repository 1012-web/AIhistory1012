/**
 * 导览气泡：在真界面上指着某个元素说一句话（首次引导的三步导览、设置页「带我做」的提示）。
 * 不碰 Obsidian：要指的元素由宿主用函数给出（每帧重新量，元素挪了气泡跟着走）。
 */
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useState, type ReactElement } from "react";
import { SPRING } from "./motion";

export interface CoachStep {
  /** 要指的元素；找不到时气泡停在窗口上方居中 */
  target: () => HTMLElement | null;
  text: string;
}

export interface CoachmarkProps {
  steps: CoachStep[];
  reducedMotion: boolean;
  /** 「带我做」：宿主检测到用户做到了就传 true，气泡显示「做到了」 */
  completed?: boolean;
  /** 「带我做」没有下一步按钮，只有「知道了」 */
  waitForAction?: boolean;
  onDone: () => void;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const BUBBLE_WIDTH = 240;

function measure(element: HTMLElement | null): Box | null {
  if (!element?.isConnected) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return null;
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

export function Coachmark({ steps, reducedMotion, completed, waitForAction, onDone }: CoachmarkProps): ReactElement {
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [viewport, setViewport] = useState({ width: 1200, height: 800 });
  const step = steps[Math.min(index, steps.length - 1)];

  // 每帧量一次目标（工具条在弹簧动画里、窗格在改尺寸时，气泡要跟上）
  useEffect(() => {
    let frame = 0;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const element = step.target();
      const next = measure(element);
      const win = element?.ownerDocument.defaultView ?? window;
      setViewport((old) => (old.width === win.innerWidth && old.height === win.innerHeight ? old : { width: win.innerWidth, height: win.innerHeight }));
      setBox((old) => (old && next && Math.abs(old.left - next.left) < 0.5 && Math.abs(old.top - next.top) < 0.5 && Math.abs(old.width - next.width) < 0.5 && Math.abs(old.height - next.height) < 0.5 ? old : next));
      frame = win.requestAnimationFrame(tick);
    };
    tick();
    return () => {
      stopped = true;
      window.cancelAnimationFrame(frame);
    };
  }, [step]);

  const left = box ? Math.max(8, Math.min(box.left, viewport.width - BUBBLE_WIDTH - 8)) : viewport.width / 2 - BUBBLE_WIDTH / 2;
  const below = box ? box.top + box.height + 10 : 80;
  const top = box && below > viewport.height - 120 ? Math.max(8, box.top - 110) : below;
  const last = index >= steps.length - 1;

  return (
    <MotionConfig reducedMotion={reducedMotion ? "always" : "user"}>
      <div className="aps-coach" data-step={index}>
        {box ? (
          <motion.div
            className="aps-coach-ring"
            initial={false}
            animate={{ left: box.left - 4, top: box.top - 4, width: box.width + 8, height: box.height + 8 }}
            transition={SPRING}
          />
        ) : null}
        <motion.div className="aps-coach-bubble" role="dialog" aria-live="polite" initial={false} animate={{ left, top }} transition={SPRING} style={{ width: BUBBLE_WIDTH }}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={`${index}-${completed ? "done" : "todo"}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={SPRING}>
              {completed ? <p className="aps-coach-text aps-coach-done">✓ 做到了</p> : <p className="aps-coach-text">{step.text}</p>}
            </motion.div>
          </AnimatePresence>
          <div className="aps-coach-foot">
            {steps.length > 1 ? <span className="aps-hint">{index + 1}/{steps.length}</span> : null}
            <span className="aps-spacer" />
            {waitForAction || completed ? (
              <button type="button" className="aps-button" onClick={onDone}>{completed ? "好" : "知道了"}</button>
            ) : (
              <button type="button" className="aps-button mod-cta" onClick={() => (last ? onDone() : setIndex(index + 1))}>
                {last ? "完成" : "下一个"}
              </button>
            )}
          </div>
        </motion.div>
      </div>
    </MotionConfig>
  );
}
