/**
 * 常驻工具条（React + Base UI + Motion），外观照用户认可的参考页
 * （定稿的设计稿，不在仓库里）。不碰 Obsidian：翻页、读当前页、切换联动、
 * 停靠判断都由宿主经 props 注入。颜色只引用 `--aps-*` 设计变量（见 styles.css 开头）。
 *
 *   ⋮⋮  [‹ 37 /919 p.112 ›]  第三章 › 第二节 › 一、……  [双向|单向|暂停]  [⇄ PDF 左]  ⋯  –
 *   底边 2px 全书进度线；收起后只剩「37 · p.112」，宽度弹簧渐变。
 *   PDF 关着时「⇄ PDF 左」换成强调色的「打开 PDF」；书有疑字清单时多一个「判字 N」开判字面板。
 *
 * 多级标题：阅读线处所在标题连同各级上级排成一行（面包屑），只占一行、不把工具条撑高；
 * 放不下时上级先缩成省略号，当前这一级留得最多。点任一级弹出标题菜单（目录树或分栏，见 Outline.tsx）。
 * 停靠时卡片撑满停靠框宽度，标题随阅读位置变长变短时其余按钮不左右跳。
 * 悬浮时，或停靠时完整路径放不下，只显示最末一级标题（上级仍在悬停提示和标题菜单里）。
 *
 * 定位：始终是 position: fixed 的一张卡片。停靠时宿主给出停靠框（窗格内容区顶部的位置与宽度），
 * 卡片放在框内左上并留白，宿主在窗格里垫等高空白；悬浮时按保存的坐标。
 * 动效：弹簧 stiffness 420、damping 30；「减少动效」或系统 prefers-reduced-motion 时一律瞬切。
 */
import { Menu } from "@base-ui/react/menu";
import { NumberField } from "@base-ui/react/number-field";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { LayoutGroup, MotionConfig, animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import { SPRING } from "./motion";
import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { HeadingCrumbs, type OutlineActions, type OutlineStatus } from "./Outline";
import { PdfIcon } from "./icons";

export type SyncMode = "both" | "one" | "paused";

export interface ToolbarStatus {
  page: number;
  pageCount: number;
  printed: string | null;
  /** 多级标题与标题菜单要的东西 */
  outline: OutlineStatus;
  /** PDF 缩放比例，1 = 100% */
  scale: number;
  mode: SyncMode;
  /** PDF 窗格开着没有；关着时「⇄ PDF 左右」换成「打开 PDF」 */
  pdfOpen: boolean;
  /** 这本书疑字清单里还没判的条数；书没有清单时为 null，不显示判字按钮 */
  suspects: number | null;
  pdfName: string;
  pdfSide: "left" | "right";
  /** 打开配对的笔记时自动在旁边开 PDF（默认开，记住上次的选择） */
  autoOpen: boolean;
}

export interface ToolbarPlacement {
  mode: "docked" | "floating";
  x: number;
  y: number;
  collapsed: boolean;
}

/** 停靠框：窗格内容区顶部（窗口坐标） */
export interface DockFrame {
  left: number;
  top: number;
  width: number;
}

export interface ToolbarActions extends OutlineActions {
  jump: (page: number) => void;
  step: (delta: number) => void;
  setMode: (mode: SyncMode) => void;
  setAutoOpen: (value: boolean) => void;
  swapSide: () => void;
  /** 在正文旁边打开配对的 PDF（按设置放左或右） */
  openPdf: () => void;
  /** 打开（或翻到）右侧栏的判字面板 */
  openSuspects: () => void;
  /** delta 为 null 表示适合页宽 */
  zoom: (delta: number | null) => void;
  rebind: () => void;
  /** 打开插件设置页 */
  openSettings: () => void;
  /** 打开外观与布局面板 */
  openLook: () => void;
  setCollapsed: (collapsed: boolean) => void;
  /** 开始拖：宿主显示各窗格顶部的虚线停靠区 */
  dragStart: () => void;
  /** 拖动中：返回是否进入某个停靠区（宿主把它变实线） */
  dragMove: (pointerX: number, pointerY: number, barTop: number) => boolean;
  /** 松手：宿主决定吸附还是悬浮在 (x, y)，收起停靠区并保存 */
  dragEnd: (pointerX: number, pointerY: number, x: number, y: number) => void;
  /** 卡片尺寸变了（宿主据此垫空白） */
  resize?: (width: number, height: number) => void;
}

export interface ToolbarProps {
  status: ToolbarStatus;
  placement: ToolbarPlacement;
  dock: DockFrame | null;
  /** 设置里的「减少动效」；系统的 prefers-reduced-motion 另外自动尊重 */
  reducedMotion: boolean;
  /** Base UI 弹出层挂在哪（Obsidian 弹出窗口里要用那个窗口的 body） */
  portalContainer: HTMLElement | null;
  actions: ToolbarActions;
  /** 溢出菜单里那个开关的文字；缺省「打开笔记时自动开 PDF」 */
  autoOpenLabel?: string;
}

/** 停靠时卡片离窗格内容区左边、上边的留白 */
export const DOCK_INSET = { left: 12, top: 6 } as const;

const MODES: Array<{ value: SyncMode; label: string; hint: string }> = [
  { value: "both", label: "双向", hint: "双向联动：正文与 PDF 互相带动" },
  { value: "one", label: "单向", hint: "单向：只有正文带动 PDF" },
  { value: "paused", label: "暂停", hint: "暂停跟随" }
];

export function Toolbar(props: ToolbarProps): ReactElement {
  return (
    <MotionConfig reducedMotion={props.reducedMotion ? "always" : "user"}>
      <ToolbarCard {...props} />
    </MotionConfig>
  );
}

function ToolbarCard({ status, placement, dock, reducedMotion, portalContainer, actions, autoOpenLabel }: ToolbarProps): ReactElement {
  const systemReduced = useReducedMotion();
  const still = reducedMotion || !!systemReduced;
  const groupId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(placement.x);
  const y = useMotionValue(placement.y);
  const dragging = useRef(false);
  const placed = useRef(false);
  const lastWidth = useRef(0);
  const [isDragging, setDragging] = useState(false);
  const docked = placement.mode === "docked" && !!dock;
  const collapsed = placement.collapsed;

  // 量尺寸：告诉宿主（垫空白）
  useLayoutEffect(() => {
    const element = cardRef.current;
    const view = element?.ownerDocument.defaultView;
    if (!element || !view?.ResizeObserver) return undefined;
    const observer = new view.ResizeObserver(() => {
      const rect = element.getBoundingClientRect();
      if (!element.style.width) lastWidth.current = rect.width;
      actions.resize?.(rect.width, rect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [actions]);

  // 收起、展开：宽度从旧值弹簧过渡到新内容的自然宽度
  useLayoutEffect(() => {
    const element = cardRef.current;
    if (!element) return undefined;
    const from = lastWidth.current;
    element.style.removeProperty("width");
    const to = element.getBoundingClientRect().width;
    if (still || !from || Math.abs(from - to) < 1) {
      lastWidth.current = to;
      return undefined;
    }
    const controls = animate(element, { width: [`${from}px`, `${to}px`] }, SPRING);
    void controls.finished.then(() => {
      element.style.removeProperty("width");
      lastWidth.current = element.getBoundingClientRect().width;
    });
    return () => controls.stop();
    // 只在收起状态切换时做
  }, [collapsed]);

  const targetX = docked && dock ? dock.left + DOCK_INSET.left : placement.x;
  const targetY = docked && dock ? dock.top + DOCK_INSET.top : placement.y;

  useEffect(() => {
    if (dragging.current) return undefined;
    if (!placed.current || still) {
      x.set(targetX);
      y.set(targetY);
      placed.current = true;
      return undefined;
    }
    const ax = animate(x, targetX, SPRING);
    const ay = animate(y, targetY, SPRING);
    return () => {
      ax.stop();
      ay.stop();
    };
  }, [targetX, targetY, still, x, y]);

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const element = cardRef.current;
    if (!element) return;
    const doc = element.ownerDocument;
    const startX = event.clientX;
    const startY = event.clientY;
    const offsetX = startX - x.get();
    const offsetY = startY - y.get();
    let moved = false;
    const move = (moveEvent: PointerEvent) => {
      if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 4) return;
      if (!moved) {
        moved = true;
        dragging.current = true;
        setDragging(true);
        actions.dragStart();
      }
      x.set(moveEvent.clientX - offsetX);
      y.set(moveEvent.clientY - offsetY);
      actions.dragMove(moveEvent.clientX, moveEvent.clientY, moveEvent.clientY - offsetY);
    };
    const up = (upEvent: PointerEvent) => {
      doc.removeEventListener("pointermove", move);
      doc.removeEventListener("pointerup", up);
      if (!moved) return;
      dragging.current = false;
      setDragging(false);
      actions.dragEnd(upEvent.clientX, upEvent.clientY, upEvent.clientX - offsetX, upEvent.clientY - offsetY);
    };
    doc.addEventListener("pointermove", move);
    doc.addEventListener("pointerup", up);
  };

  const classes = [
    "aps-toolbar",
    docked ? "aps-docked" : "aps-floating",
    collapsed ? "aps-collapsed" : "",
    isDragging ? "aps-dragging" : "",
    status.mode === "paused" ? "aps-paused" : ""
  ].filter(Boolean).join(" ");
  const progress = status.pageCount > 0 ? Math.min(100, Math.max(1, (status.page / status.pageCount) * 100)) : 0;
  const mini = `${status.page}${status.printed ? ` · p.${status.printed}` : ""}`;

  return (
    <motion.div
      ref={cardRef}
      className={classes}
      style={{
        x,
        y,
        maxWidth: docked && dock ? dock.width - DOCK_INSET.left * 2 : undefined,
        minWidth: docked && dock && !collapsed ? dock.width - DOCK_INSET.left * 2 : undefined
      }}
      data-page={status.page}
    >
      <span className="aps-grip" aria-label="拖动工具条" onPointerDown={startDrag}>⋮⋮</span>
      {collapsed ? (
        <span className="aps-chip">{mini}</span>
      ) : (
        <>
          <PageStepper status={status} actions={actions} />
          <HeadingCrumbs outline={status.outline} actions={actions} container={portalContainer} leafOnly={!docked} />
          <LayoutGroup id={groupId}>
            <ToggleGroup
              className="aps-seg"
              aria-label="联动方式"
              value={[status.mode]}
              onValueChange={(value) => {
                const next = value[0] as SyncMode | undefined;
                if (next) actions.setMode(next);
              }}
            >
              {MODES.map((mode) => {
                const hint = !status.pdfOpen && mode.value !== "paused" ? `${mode.hint}（会先打开 PDF）` : mode.hint;
                return (
                  <Toggle key={mode.value} value={mode.value} className="aps-segment" aria-label={hint} title={hint}>
                    {status.mode === mode.value ? <motion.span layoutId="aps-seg-ind" className="aps-seg-ind" transition={SPRING} /> : null}
                    <span className="aps-segment-label">{mode.label}</span>
                  </Toggle>
                );
              })}
            </ToggleGroup>
          </LayoutGroup>
          {status.pdfOpen ? (
            <button
              type="button"
              className="aps-grp aps-swap aps-ib"
              aria-label={status.pdfSide === "left" ? "PDF 在左，点击换到右边" : "PDF 在右，点击换到左边"}
              onClick={() => actions.swapSide()}
            >
              <span className="aps-ico">⇄</span>
              <span>{status.pdfSide === "left" ? "PDF 左" : "PDF 右"}</span>
            </button>
          ) : (
            <button
              type="button"
              className="aps-grp aps-open-pdf aps-ib"
              aria-label={`在${status.pdfSide === "left" ? "左" : "右"}边打开配对的 PDF`}
              title={`在${status.pdfSide === "left" ? "左" : "右"}边打开 ${status.pdfName}`}
              onClick={() => actions.openPdf()}
            >
              <PdfIcon />
              <span>打开 PDF</span>
            </button>
          )}
          {status.suspects !== null ? (
            <button
              type="button"
              className="aps-grp aps-open-suspects aps-ib"
              aria-label={status.suspects ? `打开判字面板（还有 ${status.suspects} 条没判）` : "打开判字面板（都判完了）"}
              title={status.suspects ? `判字面板：还有 ${status.suspects} 条没判` : "判字面板：都判完了"}
              onClick={() => actions.openSuspects()}
            >
              <span>判字</span>
              {status.suspects ? <span className="aps-badge">{status.suspects}</span> : null}
            </button>
          ) : null}
          <OverflowMenu status={status} actions={actions} container={portalContainer} autoOpenLabel={autoOpenLabel} />
        </>
      )}
      <button
        type="button"
        className="aps-ib aps-collapse"
        aria-label={collapsed ? "展开工具条" : "收起成小标"}
        onClick={() => actions.setCollapsed(!collapsed)}
      >
        <span className="aps-ico">{collapsed ? "+" : "–"}</span>
      </button>
      <motion.span className="aps-prog" aria-hidden="true" initial={false} animate={{ width: `${progress}%` }} transition={SPRING} />
    </motion.div>
  );
}

function PageStepper({ status, actions }: { status: ToolbarStatus; actions: ToolbarActions }): ReactElement {
  const [draft, setDraft] = useState<number | null>(null);
  const commit = (value: number | null) => {
    setDraft(null);
    if (value !== null && Number.isFinite(value) && value !== status.page) actions.jump(Math.round(value));
  };
  return (
    <span className="aps-grp aps-stepper">
      <button type="button" className="aps-ib aps-step" aria-label="上一页（两边一起翻）" onClick={() => actions.step(-1)}>
        <span className="aps-ico">‹</span>
      </button>
      <span className="aps-page">
        <NumberField.Root
          className="aps-page-field"
          value={draft ?? status.page}
          min={1}
          max={status.pageCount || undefined}
          format={{ useGrouping: false }}
          onValueChange={(value) => setDraft(value)}
          onValueCommitted={(value) => commit(value)}
        >
          <NumberField.Input
            className="aps-page-input"
            aria-label="跳到 PDF 第几页"
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setDraft(null);
                event.currentTarget.blur();
              }
            }}
          />
        </NumberField.Root>
        <span className="aps-total">/{status.pageCount || "?"}</span>
        {status.printed ? <span className="aps-printed">p.{status.printed}</span> : null}
      </span>
      <button type="button" className="aps-ib aps-step" aria-label="下一页（两边一起翻）" onClick={() => actions.step(1)}>
        <span className="aps-ico">›</span>
      </button>
    </span>
  );
}

function OverflowMenu({ status, actions, container, autoOpenLabel }: { status: ToolbarStatus; actions: ToolbarActions; container: HTMLElement | null; autoOpenLabel?: string }): ReactElement {
  return (
    <Menu.Root>
      <Menu.Trigger className="aps-ib aps-more" aria-label="更多：缩放、配对 PDF">
        <span className="aps-ico">⋯</span>
      </Menu.Trigger>
      <Menu.Portal container={container}>
        <Menu.Positioner className="aps-menu-positioner" sideOffset={6} align="end">
          <Menu.Popup className="aps-menu">
            <div className="aps-grp aps-menu-zoom">
              <Menu.Item className="aps-ib aps-zoom-button" closeOnClick={false} aria-label="缩小 PDF" onClick={() => actions.zoom(-0.1)}>−</Menu.Item>
              <Menu.Item className="aps-ib aps-zoom-value" closeOnClick={false} aria-label="适合页宽" onClick={() => actions.zoom(null)}>
                {Math.round(status.scale * 100)}%
              </Menu.Item>
              <Menu.Item className="aps-ib aps-zoom-button" closeOnClick={false} aria-label="放大 PDF" onClick={() => actions.zoom(0.1)}>+</Menu.Item>
            </div>
            <Menu.Separator className="aps-menu-separator" />
            <Menu.CheckboxItem
              className="aps-menu-item aps-menu-check"
              checked={status.autoOpen}
              closeOnClick={false}
              onCheckedChange={(value) => actions.setAutoOpen(value)}
            >
              <span className="aps-menu-check-box" aria-hidden="true">
                <Menu.CheckboxItemIndicator className="aps-menu-check-mark">✓</Menu.CheckboxItemIndicator>
              </span>
              {autoOpenLabel ?? "打开笔记时自动开 PDF"}
            </Menu.CheckboxItem>
            <Menu.Item className="aps-menu-item aps-pdf-name" onClick={() => actions.rebind()}>
              <span className="aps-secondary">配对：</span>
              {status.pdfName}
              <span className="aps-muted">（点击改绑）</span>
            </Menu.Item>
            <Menu.Separator className="aps-menu-separator" />
            <Menu.Item className="aps-menu-item aps-open-look" onClick={() => actions.openLook()}>
              外观与布局…
            </Menu.Item>
            <Menu.Item className="aps-menu-item aps-open-settings" onClick={() => actions.openSettings()}>
              插件设置…
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
