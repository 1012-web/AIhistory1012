/**
 * 外观与布局：不挡界面的浮动面板（没有遮罩，按住标题栏拖动，✕ 或 Esc 关）。
 * 顶上一块缩略预览，下面按组排分段选择；每点一项由宿主立刻保存、立刻生效，背后的书当场变样。
 * 「撤回本次改动」回到这次打开面板之前；「全部恢复默认」先在原地确认一次。
 * 不碰 Obsidian：取值、保存、位置记忆都由宿主注入。
 */
import { MotionConfig, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { CheckRow, ChoiceRow } from "./controls";
import { SPRING } from "./motion";
import { Preview, type DockChoice } from "./Preview";
import type { OutlineStyle } from "./Outline";
import type { SyncMode } from "./Toolbar";

export interface LookValues {
  pdfSide: "left" | "right";
  dock: DockChoice;
  showBaseline: boolean;
  baselineStyle: "band" | "line" | "markers";
  /** 阅读线高度，视口从顶往下的百分比（20–50） */
  baselinePercent: number;
  shade: "tint" | "bar" | "off";
  pageLabels: boolean;
  night: "auto" | "on" | "off";
  nightTone: "neutral" | "warm";
  reducedMotion: boolean;
  outlineStyle: OutlineStyle;
  outlinePages: "printed" | "pdf" | "both";
  outlineShowLevel: boolean;
  outlineShowPage: boolean;
}

export interface LookPanelProps {
  values: LookValues;
  /** 这次打开以来改过（「撤回本次改动」可点） */
  dirty: boolean;
  /** 眼下的联动方式（只给预览用：暂停时预览也不画阅读线） */
  mode: SyncMode;
  /** 眼下 Obsidian 是不是深色主题（夜间模式「跟随主题」时预览用） */
  darkTheme: boolean;
  /** 面板左上角（窗口坐标）；宿主负责记忆 */
  position: { x: number; y: number };
  onChange: (patch: Partial<LookValues>) => void;
  onUndo: () => void;
  onReset: () => void;
  /** 拖完：新位置 */
  onMove: (position: { x: number; y: number }) => void;
  onClose: () => void;
}

/** 至少留这么多在窗口里，拖出去也能拖回来 */
const MARGIN = 8;

function clampTo(win: Window, panel: HTMLElement | null, x: number, y: number): { x: number; y: number } {
  const width = panel?.offsetWidth ?? 360;
  const height = Math.min(panel?.offsetHeight ?? 200, 48);
  return {
    x: Math.round(Math.min(Math.max(MARGIN, x), Math.max(MARGIN, win.innerWidth - width - MARGIN))),
    y: Math.round(Math.min(Math.max(MARGIN, y), Math.max(MARGIN, win.innerHeight - height - MARGIN)))
  };
}

export function LookPanel(props: LookPanelProps): ReactElement {
  const { values, onChange } = props;
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPositionState] = useState(props.position);
  // 松手时要存最新位置：同一轮事件里 state 还没更新，另记一份
  const latest = useRef(props.position);
  const setPosition = (next: { x: number; y: number } | ((old: { x: number; y: number }) => { x: number; y: number })) => {
    const value = typeof next === "function" ? next(latest.current) : next;
    latest.current = value;
    setPositionState(value);
  };
  const [confirming, setConfirming] = useState(false);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  // 窗口变小时夹回来
  useLayoutEffect(() => {
    const win = panelRef.current?.ownerDocument.defaultView;
    if (!win) return undefined;
    const fit = () => setPosition((old) => clampTo(win, panelRef.current, old.x, old.y));
    fit();
    win.addEventListener("resize", fit);
    return () => win.removeEventListener("resize", fit);
  }, []);

  // 打开时把焦点放进面板，Esc 才关得掉
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    drag.current = { dx: event.clientX - position.x, dy: event.clientY - position.y };
    if (event.isTrusted) event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const win = panelRef.current?.ownerDocument.defaultView;
    if (!drag.current || !win) return;
    setPosition(clampTo(win, panelRef.current, event.clientX - drag.current.dx, event.clientY - drag.current.dy));
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    props.onMove(latest.current);
  };

  const night = values.night === "on" || (values.night === "auto" && props.darkTheme) ? values.nightTone : false;

  return (
    <MotionConfig reducedMotion={values.reducedMotion ? "always" : "user"}>
      <motion.div
        ref={panelRef}
        className="aps-look"
        role="dialog"
        aria-label="外观与布局"
        tabIndex={-1}
        style={{ left: position.x, top: position.y }}
        initial={{ opacity: 0, y: 6, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={SPRING}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          props.onClose();
        }}
      >
        <div className="aps-look-head" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
          <span className="aps-look-grip" aria-hidden="true">⋮⋮</span>
          <span className="aps-look-title">外观与布局</span>
          <span className="aps-spacer" />
          <button type="button" className="aps-look-close" aria-label="关闭" onClick={() => props.onClose()}>✕</button>
        </div>
        <div className="aps-look-preview">
          <Preview
            height={130}
            options={{
              pdfSide: values.pdfSide,
              dock: values.dock,
              mode: props.mode,
              pageLabels: values.pageLabels,
              shade: values.shade,
              baseline: values.showBaseline ? values.baselineStyle : false,
              baselinePercent: values.baselinePercent,
              night,
              reducedMotion: values.reducedMotion,
              outline: { style: values.outlineStyle, pages: values.outlinePages, showLevel: values.outlineShowLevel, showPage: values.outlineShowPage }
            }}
          />
          <span className="aps-hint">改哪一项，背后打开的书和这里的预览一起变</span>
        </div>
        <div className="aps-look-body">
          <section className="aps-look-group" data-group="layout">
            <h4>布局</h4>
            <ChoiceRow title="PDF 放哪边" value={values.pdfSide} onChange={(value) => onChange({ pdfSide: value })} options={[{ value: "left", label: "左边" }, { value: "right", label: "右边" }]} />
            <ChoiceRow
              title="工具条位置"
              value={values.dock}
              onChange={(value) => onChange({ dock: value })}
              options={[{ value: "markdown", label: "正文顶部" }, { value: "pdf", label: "PDF 顶部" }, { value: "floating", label: "悬浮" }]}
            />
          </section>
          <section className="aps-look-group" data-group="baseline">
            <h4>阅读线</h4>
            <CheckRow label="显示阅读线" hint="线上就是两边对齐的地方" checked={values.showBaseline} onChange={(value) => onChange({ showBaseline: value })} />
            {values.showBaseline ? (
              <ChoiceRow
                title="样式"
                value={values.baselineStyle}
                onChange={(value) => onChange({ baselineStyle: value })}
                options={[{ value: "band", label: "淡色带" }, { value: "line", label: "细线" }, { value: "markers", label: "端点" }]}
              />
            ) : null}
            <label className="aps-row aps-look-range">
              <span>高度：视口从顶往下 {values.baselinePercent}%</span>
              <input
                type="range"
                min={20}
                max={50}
                step={1}
                value={values.baselinePercent}
                aria-label="阅读线高度"
                onChange={(event) => onChange({ baselinePercent: Number(event.target.value) })}
              />
            </label>
          </section>
          <section className="aps-look-group" data-group="look">
            <h4>外观</h4>
            <ChoiceRow
              title="当前页标示"
              value={values.shade}
              onChange={(value) => onChange({ shade: value })}
              options={[{ value: "tint", label: "淡底色" }, { value: "bar", label: "左侧竖条" }, { value: "off", label: "不标示" }]}
            />
            <CheckRow label="实时预览里显示页码标签" hint="点标签跳到 PDF 该页" checked={values.pageLabels} onChange={(value) => onChange({ pageLabels: value })} />
            <ChoiceRow
              title="夜间模式（PDF 反色）"
              value={values.night}
              onChange={(value) => onChange({ night: value })}
              options={[{ value: "auto", label: "跟随主题" }, { value: "on", label: "开" }, { value: "off", label: "关" }]}
            />
            <ChoiceRow title="PDF 夜间色调" value={values.nightTone} onChange={(value) => onChange({ nightTone: value })} options={[{ value: "neutral", label: "中性" }, { value: "warm", label: "暖调" }]} />
            <CheckRow label="动效" hint="关掉即减少动效" checked={!values.reducedMotion} onChange={(value) => onChange({ reducedMotion: !value })} />
          </section>
          <section className="aps-look-group" data-group="outline">
            <h4>标题菜单</h4>
            <ChoiceRow title="样式" value={values.outlineStyle} onChange={(value) => onChange({ outlineStyle: value })} options={[{ value: "tree", label: "目录树" }, { value: "columns", label: "分栏" }]} />
            <ChoiceRow
              title="页码"
              value={values.outlinePages}
              onChange={(value) => onChange({ outlinePages: value })}
              options={[{ value: "printed", label: "印刷页" }, { value: "pdf", label: "PDF 页" }, { value: "both", label: "两个都标" }]}
            />
            <CheckRow label="标出级别（H1–H5）" checked={values.outlineShowLevel} onChange={(value) => onChange({ outlineShowLevel: value })} />
            <CheckRow label="标出页码" checked={values.outlineShowPage} onChange={(value) => onChange({ outlineShowPage: value })} />
          </section>
        </div>
        <div className="aps-look-foot">
          {confirming ? (
            <>
              <span className="aps-look-ask">把这里的各项都恢复成默认？</span>
              <span className="aps-spacer" />
              <button type="button" className="aps-button" onClick={() => setConfirming(false)}>取消</button>
              <button
                type="button"
                className="aps-button mod-cta aps-look-reset-yes"
                onClick={() => {
                  setConfirming(false);
                  props.onReset();
                }}
              >
                恢复默认
              </button>
            </>
          ) : (
            <>
              <button type="button" className="aps-button aps-look-undo" disabled={!props.dirty} onClick={() => props.onUndo()}>撤回本次改动</button>
              <span className="aps-spacer" />
              <button type="button" className="aps-button aps-look-reset" onClick={() => setConfirming(true)}>全部恢复默认</button>
            </>
          )}
        </div>
      </motion.div>
    </MotionConfig>
  );
}
