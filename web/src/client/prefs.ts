/**
 * 网页的界面设置：存在本机服务的用户配置文件里（server/config.ts 的 prefs），换浏览器、重启都照用。
 * 分组照设计稿 onboarding-settings-approved.html：布局 / 联动 / 外观 / 上手，另加网页特有的「本机服务」（端口）。
 */
import type { DockChoice, SyncMode, ToolbarPlacement } from "@/s3/ui";
import { DEFAULT_VARIANT_OPTIONS } from "@/s3/core";

export interface WebPrefs {
  pdfSide: "left" | "right";
  /** 工具条位置（停靠在哪个窗格或悬浮）；拖动后记住新位置 */
  toolbar: ToolbarPlacement & { dock: "markdown" | "pdf" };
  mode: SyncMode;
  /** 显示 PDF 栏 */
  showPdf: boolean;
  /** 页内按比例跟随；关掉则只在换页时对齐到页首 */
  proportional: boolean;
  /** 跟随基准线：视口从顶往下的比例，0.2–0.5 */
  baseline: number;
  pageLabels: boolean;
  shade: boolean;
  reducedMotion: boolean;
  /** 繁简通搜：PDF 栏里的 Ctrl/⌘+F 改开繁简通搜（默认开；浏览器自带查找只认字面） */
  findTakeover: boolean;
  /** 繁简通搜用的三档 Unihan 对照表（默认值照 Better Search Result Views，与插件一致） */
  unihanTradSimp: boolean;
  unihanZ: boolean;
  unihanSemantic: boolean;
  onboarded: boolean;
  practice: { highlight: boolean; pageEdit: boolean };
}

export const DEFAULT_PREFS: WebPrefs = {
  pdfSide: "left",
  toolbar: { mode: "docked", x: 80, y: 80, collapsed: false, dock: "markdown" },
  mode: "both",
  showPdf: true,
  proportional: true,
  baseline: 0.35,
  pageLabels: true,
  shade: true,
  reducedMotion: false,
  findTakeover: true,
  unihanTradSimp: DEFAULT_VARIANT_OPTIONS.unihanTradSimp,
  unihanZ: DEFAULT_VARIANT_OPTIONS.unihanZ,
  unihanSemantic: DEFAULT_VARIANT_OPTIONS.unihanSemantic,
  onboarded: false,
  practice: { highlight: false, pageEdit: false },
};

/** 配置文件里存的值逐项核对，认不得的用默认值 */
export function normalizePrefs(raw: Record<string, unknown> | null | undefined): WebPrefs {
  const value = (raw ?? {}) as Partial<WebPrefs>;
  const pick = <K extends keyof WebPrefs>(key: K, ok: (v: unknown) => boolean): WebPrefs[K] => (ok(value[key]) ? (value[key] as WebPrefs[K]) : DEFAULT_PREFS[key]);
  const bool = (v: unknown) => typeof v === "boolean";
  const toolbar = value.toolbar && typeof value.toolbar === "object" ? { ...DEFAULT_PREFS.toolbar, ...value.toolbar } : DEFAULT_PREFS.toolbar;
  return {
    pdfSide: pick("pdfSide", (v) => v === "left" || v === "right"),
    toolbar,
    mode: pick("mode", (v) => v === "both" || v === "one" || v === "paused"),
    showPdf: pick("showPdf", bool),
    proportional: pick("proportional", bool),
    baseline: pick("baseline", (v) => typeof v === "number" && v >= 0.2 && v <= 0.5),
    pageLabels: pick("pageLabels", bool),
    shade: pick("shade", bool),
    reducedMotion: pick("reducedMotion", bool),
    findTakeover: pick("findTakeover", bool),
    unihanTradSimp: pick("unihanTradSimp", bool),
    unihanZ: pick("unihanZ", bool),
    unihanSemantic: pick("unihanSemantic", bool),
    onboarded: pick("onboarded", bool),
    practice: { ...DEFAULT_PREFS.practice, ...(value.practice && typeof value.practice === "object" ? value.practice : {}) },
  };
}

export function dockChoiceOf(toolbar: WebPrefs["toolbar"]): DockChoice {
  return toolbar.mode === "floating" ? "floating" : toolbar.dock;
}

export function withDockChoice(toolbar: WebPrefs["toolbar"], choice: DockChoice): WebPrefs["toolbar"] {
  if (choice === "floating") return { ...toolbar, mode: "floating" };
  return { ...toolbar, mode: "docked", dock: choice };
}
