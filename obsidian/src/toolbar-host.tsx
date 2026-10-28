/**
 * 把 React 工具条（ui/Toolbar）挂进 Obsidian：
 * - 挂点在目标窗格所在窗口的 body 里（Obsidian 有弹出窗口，那里的 document 不是主窗口的）；
 * - 停靠时在窗格的标题栏与内容区之间垫一块与工具条等高的空白，工具条按这块空白的位置浮在上面；
 * - 拖动时判断是否靠近正文或 PDF 窗格的顶部，松手吸附或悬浮，并把位置存进插件数据（每个库一份）。
 */
import type { WorkspaceLeaf } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import type { DockTarget, ToolbarState } from "./settings";
import type { OutlineBookState } from "./core/outline-view";
import { DOCK_INSET, Toolbar, type DockFrame, type OutlinePrefs, type SyncMode, type ToolbarActions, type ToolbarStatus } from "./ui";

export interface ToolbarHostOptions {
  state(): ToolbarState;
  saveState(state: ToolbarState): void;
  leafFor(dock: DockTarget): WorkspaceLeaf | null;
  reducedMotion(): boolean;
  jump(page: number): void;
  jumpToHeading(offset: number): void;
  step(delta: number): void;
  setMode(mode: SyncMode): void;
  setAutoOpen(value: boolean): void;
  swapSide(): void;
  zoom(delta: number | null): void;
  rebind(): void;
  setOutline(prefs: OutlinePrefs): void;
  setOutlineBook(state: OutlineBookState): void;
}

const SNAP_DISTANCE = 36;
/** 拖动时各窗格顶部显示的停靠区高度 */
const ZONE_HEIGHT = 48;

function contentOf(leaf: WorkspaceLeaf | null): HTMLElement | null {
  return leaf?.view.containerEl.querySelector<HTMLElement>(":scope > .view-content") ?? null;
}

export class ToolbarHost {
  private root: Root | null = null;
  private mount: HTMLElement | null = null;
  private spacer: HTMLElement | null = null;
  private status: ToolbarStatus | null = null;
  private height = 0;
  private width = 0;
  private snap: DockTarget | null = null;
  private zones: Array<{ dock: DockTarget; element: HTMLElement }> = [];
  private observer: ResizeObserver | null = null;
  private observed: HTMLElement | null = null;
  private windowListener: { win: Window; handler: () => void } | null = null;
  private readonly actions: ToolbarActions;

  constructor(private readonly options: ToolbarHostOptions) {
    this.actions = {
      jump: (page) => options.jump(page),
      jumpToHeading: (offset) => options.jumpToHeading(offset),
      step: (delta) => options.step(delta),
      setMode: (mode) => options.setMode(mode),
      setAutoOpen: (value) => options.setAutoOpen(value),
      swapSide: () => options.swapSide(),
      zoom: (delta) => options.zoom(delta),
      rebind: () => options.rebind(),
      setOutline: (prefs) => options.setOutline(prefs),
      setOutlineBook: (state) => options.setOutlineBook(state),
      setCollapsed: (collapsed) => {
        options.saveState({ ...options.state(), collapsed });
        this.place();
      },
      dragStart: () => this.showZones(),
      dragMove: (pointerX, _pointerY, barTop) => this.dragMove(pointerX, barTop),
      dragEnd: (_pointerX, _pointerY, x, y) => this.dragEnd(x, y),
      resize: (width, height) => {
        if (Math.abs(height - this.height) < 0.5 && Math.abs(width - this.width) < 0.5) return;
        this.height = height;
        this.width = width;
        this.syncSpacer();
      }
    };
  }

  /** 工具条根元素（测试、截图用） */
  get element(): HTMLElement | null {
    return this.mount?.querySelector<HTMLElement>(".aps-toolbar") ?? null;
  }

  update(status: ToolbarStatus): void {
    this.status = status;
    this.render();
  }

  /** 按保存的状态放到该放的地方（窗格变了、设置改了都调） */
  place(): void {
    const state = this.options.state();
    const dockLeaf = state.mode === "docked" ? this.options.leafFor(state.dock) ?? this.options.leafFor("markdown") : this.options.leafFor("markdown");
    const content = contentOf(dockLeaf);
    const doc = content?.ownerDocument ?? activeDocument;
    this.ensureMount(doc);
    this.observe(state.mode === "docked" ? content : null);
    if (state.mode === "docked" && content && !state.collapsed) {
      if (!this.spacer || this.spacer.ownerDocument !== doc) {
        this.spacer?.remove();
        this.spacer = doc.body.createDiv({ cls: "aps-toolbar-spacer" });
      }
      if (this.spacer.nextElementSibling !== content) content.before(this.spacer);
    } else {
      this.spacer?.remove();
    }
    this.syncSpacer();
    this.render();
  }

  private ensureMount(doc: Document): void {
    if (this.mount && this.mount.ownerDocument === doc && this.mount.isConnected) return;
    this.root?.unmount();
    this.mount?.remove();
    this.mount = doc.body.createDiv({ cls: "aps-toolbar-mount" });
    this.root = createRoot(this.mount);
    const win = doc.defaultView;
    if (this.windowListener) this.windowListener.win.removeEventListener("resize", this.windowListener.handler);
    if (win) {
      const handler = () => this.render();
      win.addEventListener("resize", handler);
      this.windowListener = { win, handler };
    }
  }

  private observe(element: HTMLElement | null): void {
    if (element === this.observed) return;
    this.observer?.disconnect();
    this.observed = element;
    const view = element?.ownerDocument.defaultView;
    if (!element || !view) return;
    this.observer = new view.ResizeObserver(() => this.render());
    this.observer.observe(element);
  }

  private syncSpacer(): void {
    if (this.spacer) this.spacer.style.height = `${Math.round(this.height + DOCK_INSET.top * 2)}px`;
  }

  /** 停靠框：垫的空白所在位置；收起时贴着内容区顶部 */
  private dockFrame(): DockFrame | null {
    const state = this.options.state();
    if (state.mode !== "docked") return null;
    const content = contentOf(this.options.leafFor(state.dock) ?? this.options.leafFor("markdown"));
    if (!content) return null;
    const anchor = this.spacer?.isConnected ? this.spacer : content;
    const rect = anchor.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    if (contentRect.width <= 0) return null;
    return { left: contentRect.left, top: rect.top, width: contentRect.width };
  }

  private render(): void {
    if (!this.root || !this.status || !this.mount) return;
    const state = this.options.state();
    this.root.render(
      <Toolbar
        status={this.status}
        placement={{ mode: state.mode, x: state.x, y: state.y, collapsed: state.collapsed }}
        dock={this.dockFrame()}
        reducedMotion={this.options.reducedMotion()}
        portalContainer={this.mount.ownerDocument.body}
        actions={this.actions}
      />
    );
  }

  /** 某窗格顶部（自己垫的空白也算在里面） */
  private paneTop(content: HTMLElement): number {
    const spacer = this.spacer?.isConnected && this.spacer.nextElementSibling === content ? this.spacer : null;
    return (spacer ?? content).getBoundingClientRect().top;
  }

  /** 拖动开始：在正文、PDF 两个窗格顶部画虚线停靠区 */
  private showZones(): void {
    this.hideZones();
    const doc = this.mount?.ownerDocument;
    if (!doc) return;
    for (const dock of ["markdown", "pdf"] as DockTarget[]) {
      const content = contentOf(this.options.leafFor(dock));
      if (!content || content.ownerDocument !== doc) continue;
      const rect = content.getBoundingClientRect();
      if (rect.width <= 0) continue;
      const element = doc.body.createDiv({ cls: "aps-dock-zone", attr: { "data-dock": dock } });
      element.setCssStyles({ left: `${rect.left + 6}px`, top: `${this.paneTop(content)}px`, width: `${rect.width - 12}px`, height: `${ZONE_HEIGHT}px` });
      this.zones.push({ dock, element });
    }
  }

  private hideZones(): void {
    for (const zone of this.zones) zone.element.remove();
    this.zones = [];
  }

  private dragMove(pointerX: number, barTop: number): boolean {
    this.snap = null;
    for (const dock of ["markdown", "pdf"] as DockTarget[]) {
      const content = contentOf(this.options.leafFor(dock));
      if (!content) continue;
      const rect = content.getBoundingClientRect();
      if (!this.snap && pointerX >= rect.left && pointerX <= rect.right && Math.abs(barTop - this.paneTop(content)) <= SNAP_DISTANCE) this.snap = dock;
    }
    for (const zone of this.zones) zone.element.toggleClass("is-active", zone.dock === this.snap);
    return this.snap !== null;
  }

  private dragEnd(x: number, y: number): void {
    this.hideZones();
    const state = this.options.state();
    if (this.snap) this.options.saveState({ ...state, mode: "docked", dock: this.snap });
    else this.options.saveState({ ...state, mode: "floating", x: Math.round(x), y: Math.round(y) });
    this.snap = null;
    this.place();
  }

  hide(): void {
    this.spacer?.remove();
    this.status = null;
    this.root?.render(null);
  }

  detach(): void {
    this.hideZones();
    this.observer?.disconnect();
    this.observer = null;
    this.observed = null;
    if (this.windowListener) this.windowListener.win.removeEventListener("resize", this.windowListener.handler);
    this.windowListener = null;
    this.root?.unmount();
    this.root = null;
    this.mount?.remove();
    this.mount = null;
    this.spacer?.remove();
    this.spacer = null;
  }
}
