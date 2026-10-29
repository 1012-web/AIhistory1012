/**
 * 外观与布局面板在 Obsidian 里的接线：
 * - 入口：设置页顶部按钮、工具条 ⋯ 菜单、命令「外观与布局」。已开着就只把它调到前面，不开第二个。
 * - 从设置窗打开时先关掉设置窗，面板挂在工作区主窗口，看得见背后的书。
 * - 每点一项立刻写进设置、保存、让各处重画；打开时记一份快照，「撤回本次改动」回到它。
 * - 面板位置记在设置里，下次在原处打开。
 */
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type AIhistoryPdfSync from "./main";
import { DEFAULT_SETTINGS, dockChoiceOf, syncModeOf, withDockChoice, type PdfSyncSettings } from "./settings";
import { LookPanel, type LookValues } from "./ui";

/** 面板管的那几项设置（撤回、恢复默认都只动这些） */
const LOOK_KEYS = [
  "pdfSide",
  "toolbar",
  "showBaseline",
  "baselineStyle",
  "baseline",
  "shadeStyle",
  "pageLabels",
  "nightMode",
  "nightTone",
  "reducedMotion",
  "outlineStyle",
  "outlinePages",
  "outlineShowLevel",
  "outlineShowPage"
] as const satisfies ReadonlyArray<keyof PdfSyncSettings>;

type LookSnapshot = Pick<PdfSyncSettings, (typeof LOOK_KEYS)[number]>;

/** 面板缺省停在窗口右上，离边这么远 */
const DEFAULT_INSET = 24;
const PANEL_WIDTH = 360;

export function lookValuesOf(settings: PdfSyncSettings): LookValues {
  return {
    pdfSide: settings.pdfSide,
    dock: dockChoiceOf(settings.toolbar),
    showBaseline: settings.showBaseline,
    baselineStyle: settings.baselineStyle,
    baselinePercent: Math.round(settings.baseline * 100),
    shade: settings.shadeStyle,
    pageLabels: settings.pageLabels,
    night: settings.nightMode,
    nightTone: settings.nightTone,
    reducedMotion: settings.reducedMotion,
    outlineStyle: settings.outlineStyle,
    outlinePages: settings.outlinePages,
    outlineShowLevel: settings.outlineShowLevel,
    outlineShowPage: settings.outlineShowPage
  };
}

function snapshotOf(settings: PdfSyncSettings): LookSnapshot {
  const copy = {} as Record<string, unknown>;
  for (const key of LOOK_KEYS) copy[key] = structuredClone(settings[key]);
  return copy as LookSnapshot;
}

/** 比较时工具条只看停靠选择：拖动悬浮条改了坐标不算「改过外观」 */
function sameLook(a: LookSnapshot, b: LookSnapshot): boolean {
  return LOOK_KEYS.every((key) => (key === "toolbar" ? dockChoiceOf(a.toolbar) === dockChoiceOf(b.toolbar) : a[key] === b[key]));
}

export class LookPanelHost {
  private root: Root | null = null;
  private mount: HTMLElement | null = null;
  private snapshot: LookSnapshot | null = null;

  constructor(private readonly plugin: AIhistoryPdfSync) {}

  get isOpen(): boolean {
    return !!this.root;
  }

  private get settings(): PdfSyncSettings {
    return this.plugin.settings;
  }

  open(): void {
    // 设置窗（1.13 起是单独的弹出窗口）开着就关掉，面板要和书在同一个窗口
    (this.plugin.app as unknown as { setting?: { close: () => void } }).setting?.close();
    if (this.root && this.mount) {
      this.mount.querySelector<HTMLElement>(".aps-look")?.focus({ preventScroll: true });
      return;
    }
    const doc = this.plugin.controller.markdownView?.containerEl.doc ?? this.plugin.app.workspace.containerEl.doc;
    this.snapshot = snapshotOf(this.settings);
    this.mount = doc.body.createDiv({ cls: "aps-look-mount" });
    this.root = createRoot(this.mount);
    this.render();
  }

  close(): void {
    const root = this.root;
    const mount = this.mount;
    this.root = null;
    this.mount = null;
    this.snapshot = null;
    // 等 React 收尾后再卸载
    window.setTimeout(() => {
      root?.unmount();
      mount?.remove();
    }, 0);
  }

  /** 设置在别处改了（工具条、设置页）：开着就重画 */
  refresh(): void {
    if (this.root) this.render();
  }

  dispose(): void {
    this.root?.unmount();
    this.mount?.remove();
    this.root = null;
    this.mount = null;
  }

  private render(): void {
    if (!this.root || !this.mount) return;
    const win = this.mount.win;
    const position = this.settings.lookPanel ?? { x: Math.max(8, win.innerWidth - PANEL_WIDTH - DEFAULT_INSET), y: 72 };
    this.root.render(
      <LookPanel
        values={lookValuesOf(this.settings)}
        dirty={!!this.snapshot && !sameLook(this.snapshot, snapshotOf(this.settings))}
        mode={syncModeOf(this.settings)}
        darkTheme={this.mount.doc.body.hasClass("theme-dark")}
        position={position}
        onChange={(patch) => void this.change(patch)}
        onUndo={() => this.snapshot && void this.restore(this.snapshot)}
        onReset={() => void this.restore(snapshotOf(DEFAULT_SETTINGS))}
        onMove={(next) => {
          this.settings.lookPanel = next;
          void this.plugin.saveSettings();
        }}
        onClose={() => this.close()}
      />
    );
  }

  private async change(patch: Partial<LookValues>): Promise<void> {
    const settings = this.settings;
    const next: Partial<LookSnapshot> = {};
    if (patch.dock !== undefined) next.toolbar = withDockChoice(settings.toolbar, patch.dock);
    if (patch.pdfSide !== undefined) next.pdfSide = patch.pdfSide;
    if (patch.showBaseline !== undefined) next.showBaseline = patch.showBaseline;
    if (patch.baselineStyle !== undefined) next.baselineStyle = patch.baselineStyle;
    if (patch.baselinePercent !== undefined) next.baseline = Math.min(50, Math.max(20, patch.baselinePercent)) / 100;
    if (patch.shade !== undefined) next.shadeStyle = patch.shade;
    if (patch.pageLabels !== undefined) next.pageLabels = patch.pageLabels;
    if (patch.night !== undefined) next.nightMode = patch.night;
    if (patch.nightTone !== undefined) next.nightTone = patch.nightTone;
    if (patch.reducedMotion !== undefined) next.reducedMotion = patch.reducedMotion;
    if (patch.outlineStyle !== undefined) next.outlineStyle = patch.outlineStyle;
    if (patch.outlinePages !== undefined) next.outlinePages = patch.outlinePages;
    if (patch.outlineShowLevel !== undefined) next.outlineShowLevel = patch.outlineShowLevel;
    if (patch.outlineShowPage !== undefined) next.outlineShowPage = patch.outlineShowPage;
    await this.write(next);
  }

  /** 撤回、恢复默认：工具条只换停靠选择，悬浮坐标保留 */
  private async restore(target: LookSnapshot): Promise<void> {
    const copy = { ...structuredClone(target), toolbar: withDockChoice(this.settings.toolbar, dockChoiceOf(target.toolbar)) };
    await this.write(copy);
  }

  private async write(next: Partial<LookSnapshot>): Promise<void> {
    const settings = this.settings;
    const side = next.pdfSide;
    delete next.pdfSide;
    Object.assign(settings, next);
    // 先按新值重画（滑块是受控的，等保存完再画会弹回旧值）
    this.render();
    // 换边要把已开的 PDF 挪过去：交给控制器（它自己改设置并保存）
    if (side !== undefined && side !== settings.pdfSide) await this.plugin.controller.swapSide();
    await this.plugin.saveSettings();
    this.plugin.settingsChanged();
  }
}
