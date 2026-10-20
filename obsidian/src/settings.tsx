/**
 * 设置与设置页（design/onboarding-settings-approved.html 的「设置页」）：
 * 顶部插件名 +「重新打开引导」+ 实时预览；分组 布局 / 联动 / 外观 / 上手；其余放「高级」子页。
 * 普通开关、选择项用 Obsidian 的声明式设置接口（设置搜索能搜到）；顶部与「上手」两块用 React 自绘嵌入。
 */
import { App, PluginSettingTab, type SettingDefinitionItem } from "obsidian";
import type AIhistoryPdfSync from "./main";
import { mountReact } from "./react-mount";
import { DEFAULT_VARIANT_OPTIONS } from "./core/pdf-search";
import { GettingStarted, SettingsHeader, type DockChoice, type PreviewOptions, type SyncMode } from "./ui";

export type ToolbarMode = "docked" | "floating";
export type DockTarget = "markdown" | "pdf";
export type PracticeId = "highlight" | "pageEdit";

export interface ToolbarState {
  mode: ToolbarMode;
  /** 停靠在哪个窗格顶部 */
  dock: DockTarget;
  /** 悬浮时的位置（窗口坐标） */
  x: number;
  y: number;
  collapsed: boolean;
}

export interface PdfSyncSettings {
  /** 基准线在视口距顶的比例（设置页按 20–50% 调） */
  baseline: number;
  /** 程序滚动后对侧静默的毫秒数 */
  quietMs: number;
  /** 双向联动（关掉 = 单向：只有正文带 PDF） */
  bidirectional: boolean;
  /** 暂停跟随（工具条「暂停」，记住） */
  paused: boolean;
  /** 打开配对的笔记时自动在旁边打开 PDF（默认开，记住上次的选择） */
  autoOpen: boolean;
  /** 页内按比例跟随；关掉则只对齐到页首 */
  proportional: boolean;
  pdfSide: "left" | "right";
  shadeCurrentPage: boolean;
  pageLabels: boolean;
  wordHighlight: boolean;
  /** 繁简通搜：PDF 窗格里的 Ctrl/⌘+F 改开繁简通搜（默认开；原生查找只认字面） */
  findTakeover: boolean;
  /** 繁简通搜用的三档 Unihan 对照表（默认值照 Better Search Result Views） */
  unihanTradSimp: boolean;
  unihanZ: boolean;
  unihanSemantic: boolean;
  /** 减少动效（另外自动尊重系统的「减少动态效果」） */
  reducedMotion: boolean;
  toolbar: ToolbarState;
  /** 首次引导弹过了 */
  onboarded: boolean;
  /** 「上手」里做到了的练习 */
  practice: Record<PracticeId, boolean>;
}

export const DEFAULT_SETTINGS: PdfSyncSettings = {
  baseline: 0.35,
  quietMs: 200,
  bidirectional: true,
  paused: false,
  autoOpen: true,
  proportional: true,
  pdfSide: "left",
  shadeCurrentPage: true,
  pageLabels: true,
  wordHighlight: true,
  reducedMotion: false,
  findTakeover: true,
  unihanTradSimp: DEFAULT_VARIANT_OPTIONS.unihanTradSimp,
  unihanZ: DEFAULT_VARIANT_OPTIONS.unihanZ,
  unihanSemantic: DEFAULT_VARIANT_OPTIONS.unihanSemantic,
  toolbar: { mode: "docked", dock: "markdown", x: 120, y: 120, collapsed: false },
  onboarded: false,
  practice: { highlight: false, pageEdit: false }
};

export function mergeSettings(raw: unknown): PdfSyncSettings {
  const data = (raw && typeof raw === "object" ? raw : {}) as Partial<PdfSyncSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...data,
    toolbar: { ...DEFAULT_SETTINGS.toolbar, ...(data.toolbar ?? {}) },
    practice: { ...DEFAULT_SETTINGS.practice, ...(data.practice ?? {}) }
  };
}

/** 工具条默认位置（三选一）↔ 工具条状态 */
export function dockChoiceOf(state: ToolbarState): DockChoice {
  return state.mode === "floating" ? "floating" : state.dock;
}

export function withDockChoice(state: ToolbarState, choice: DockChoice): ToolbarState {
  return choice === "floating" ? { ...state, mode: "floating" } : { ...state, mode: "docked", dock: choice };
}

export function syncModeOf(settings: PdfSyncSettings): SyncMode {
  if (settings.paused) return "paused";
  return settings.bidirectional ? "both" : "one";
}

export function applySyncMode(settings: PdfSyncSettings, mode: SyncMode): void {
  settings.paused = mode === "paused";
  if (mode !== "paused") settings.bidirectional = mode === "both";
}

export function previewOf(settings: PdfSyncSettings): PreviewOptions {
  return {
    pdfSide: settings.pdfSide,
    dock: dockChoiceOf(settings.toolbar),
    mode: syncModeOf(settings),
    pageLabels: settings.pageLabels,
    shade: settings.shadeCurrentPage,
    reducedMotion: settings.reducedMotion
  };
}

export const PRACTICE: Array<{ id: PracticeId; label: string; hint: string }> = [
  { id: "highlight", label: "试一次逐字高亮", hint: "点了会关掉设置窗，在你打开的书上提示" },
  { id: "pageEdit", label: "试一次按页校改", hint: "两边一起翻一页，在当前页的浅底色里改字" }
];

/** 声明式设置的键：设置里的字段，加几个换算出来的虚拟键 */
type ControlKey =
  | "pdfSide"
  | "findTakeover"
  | "unihanTradSimp"
  | "unihanZ"
  | "unihanSemantic"
  | "dockChoice"
  | "syncMode"
  | "autoOpen"
  | "proportional"
  | "baselinePercent"
  | "pageLabels"
  | "shadeCurrentPage"
  | "reducedMotion"
  | "wordHighlight";

export class PdfSyncSettingTab extends PluginSettingTab {
  private rerenderHeader: (() => void) | null = null;
  private rerenderPractice: (() => void) | null = null;
  private message: string | undefined;

  constructor(app: App, private readonly plugin: AIhistoryPdfSync) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem<ControlKey>[] {
    return [
      {
        name: "AIhistory PDF Sync",
        searchable: false,
        render: (setting) => {
          setting.settingEl.empty();
          setting.settingEl.addClass("aps-settings-react");
          const mount = setting.settingEl.createDiv();
          const handle = mountReact(mount);
          this.rerenderHeader = () => handle.render(
            <SettingsHeader
              title="AIhistory PDF Sync"
              preview={previewOf(this.plugin.settings)}
              message={this.message}
              onReopen={() => {
                this.closeSettings();
                this.plugin.onboarding.show();
              }}
            />
          );
          this.rerenderHeader();
          return () => {
            this.rerenderHeader = null;
            handle.unmount();
          };
        }
      },
      {
        type: "group",
        heading: "布局",
        items: [
          {
            name: "PDF 放哪边",
            control: { type: "dropdown", key: "pdfSide", options: { left: "左", right: "右" }, defaultValue: DEFAULT_SETTINGS.pdfSide }
          },
          {
            name: "工具条默认位置",
            desc: "拖动后会记住新位置",
            control: { type: "dropdown", key: "dockChoice", options: { markdown: "正文顶部", pdf: "PDF 顶部", floating: "悬浮" }, defaultValue: "markdown" }
          }
        ]
      },
      {
        type: "group",
        heading: "联动",
        items: [
          {
            name: "联动方式",
            desc: "双向：两边互相带动；单向：只有正文带 PDF；暂停：都不动",
            control: { type: "dropdown", key: "syncMode", options: { both: "双向", one: "单向", paused: "暂停" }, defaultValue: "both" }
          },
          {
            name: "打开笔记时自动开 PDF",
            desc: "默认开，记住你上次的选择",
            control: { type: "toggle", key: "autoOpen", defaultValue: DEFAULT_SETTINGS.autoOpen }
          },
          {
            name: "页内按比例跟随",
            desc: "关掉则只对齐到页首",
            control: { type: "toggle", key: "proportional", defaultValue: DEFAULT_SETTINGS.proportional }
          },
          {
            name: "跟随基准线",
            desc: "正文视口从顶往下的位置（%），两边按这条线对齐",
            control: { type: "slider", key: "baselinePercent", min: 20, max: 50, step: 1, defaultValue: 35, displayFormat: (value) => `${value}%` }
          }
        ]
      },
      {
        type: "group",
        heading: "外观",
        items: [
          {
            name: "实时预览里显示页码标签",
            desc: "点标签跳到 PDF 该页",
            control: { type: "toggle", key: "pageLabels", defaultValue: DEFAULT_SETTINGS.pageLabels }
          },
          {
            name: "当前页加浅底色",
            control: { type: "toggle", key: "shadeCurrentPage", defaultValue: DEFAULT_SETTINGS.shadeCurrentPage }
          },
          {
            name: "减少动效",
            desc: "系统开了「减少动态效果」时自动打开",
            control: { type: "toggle", key: "reducedMotion", defaultValue: DEFAULT_SETTINGS.reducedMotion }
          }
        ]
      },
      {
        type: "group",
        heading: "繁简通搜",
        items: [
          {
            name: "PDF 里的 Ctrl+F 用繁简通搜",
            desc: "在 PDF 窗格里按 Ctrl+F 打开繁简通搜，繁体、简体、异体都算同一个字，跨行也找得到；关掉则用 Obsidian 自带的查找（只认字面）。笔记里的 Ctrl+F 不受影响",
            control: { type: "toggle", key: "findTakeover", defaultValue: DEFAULT_SETTINGS.findTakeover }
          },
          {
            name: "繁简对应",
            desc: "如 鄴／邺、於／于、後／后（Unihan 繁简对照）",
            control: { type: "toggle", key: "unihanTradSimp", defaultValue: DEFAULT_SETTINGS.unihanTradSimp }
          },
          {
            name: "同字异写",
            desc: "同一个字的不同写法（Unihan 同字异写）",
            control: { type: "toggle", key: "unihanZ", defaultValue: DEFAULT_SETTINGS.unihanZ }
          },
          {
            name: "语义异体",
            desc: "意思相通的异体，范围宽、误中多，默认关（Unihan 语义异体）",
            control: { type: "toggle", key: "unihanSemantic", defaultValue: DEFAULT_SETTINGS.unihanSemantic }
          }
        ]
      },
      {
        type: "group",
        heading: "上手",
        items: [
          {
            name: "上手练习",
            searchable: false,
            render: (setting) => {
              setting.settingEl.empty();
              setting.settingEl.addClass("aps-settings-react");
              const handle = mountReact(setting.settingEl.createDiv());
              this.rerenderPractice = () => handle.render(
                <GettingStarted
                  tasks={PRACTICE.map((task) => ({ ...task, done: this.plugin.settings.practice[task.id] }))}
                  onDo={(id) => {
                    this.closeSettings();
                    this.plugin.onboarding.practice(id as PracticeId);
                  }}
                />
              );
              this.rerenderPractice();
              return () => {
                this.rerenderPractice = null;
                handle.unmount();
              };
            }
          }
        ]
      },
      {
        type: "page",
        name: "高级",
        desc: "逐字高亮开关、手动绑定 PDF、工具条复位",
        items: [
          {
            name: "逐字高亮",
            desc: "选中正文时在 PDF 上高亮对应的字；在 PDF 上选字时选中正文对应的字",
            control: { type: "toggle", key: "wordHighlight", defaultValue: DEFAULT_SETTINGS.wordHighlight }
          },
          {
            name: "给当前这本书配对 PDF",
            desc: "写进全书笔记的 frontmatter，写前先列清单确认",
            action: () => {
              this.closeSettings();
              this.plugin.controller.chooseAndBind();
            }
          },
          {
            name: "工具条放回默认位置",
            desc: "放回正文窗格顶部、展开",
            action: () => {
              this.plugin.settings.toolbar = { ...DEFAULT_SETTINGS.toolbar };
              void this.plugin.saveSettings().then(() => this.plugin.settingsChanged());
            }
          }
        ]
      }
    ];
  }

  getControlValue(key: string): unknown {
    const settings = this.plugin.settings;
    switch (key) {
      case "dockChoice":
        return dockChoiceOf(settings.toolbar);
      case "syncMode":
        return syncModeOf(settings);
      case "baselinePercent":
        return Math.round(settings.baseline * 100);
      default:
        return (settings as unknown as Record<string, unknown>)[key];
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;
    const oldSide = settings.pdfSide;
    switch (key) {
      case "dockChoice":
        settings.toolbar = withDockChoice(settings.toolbar, value as DockChoice);
        break;
      case "syncMode":
        applySyncMode(settings, value as SyncMode);
        break;
      case "baselinePercent":
        settings.baseline = Math.min(50, Math.max(20, Number(value))) / 100;
        break;
      case "pdfSide":
        // 换边要把已开的 PDF 挪过去：交给控制器（它自己改设置并保存）
        settings.pdfSide = oldSide;
        if (value !== oldSide) await this.plugin.controller.swapSide();
        break;
      default:
        (settings as unknown as Record<string, unknown>)[key] = value;
    }
    if (key === "autoOpen") this.message = `已记下：以后打开配好 PDF 的笔记${value ? "会" : "不会"}自动开 PDF`;
    await this.plugin.saveSettings();
    this.plugin.settingsChanged();
    this.refresh();
  }

  /** 设置在别处改了（工具条、引导）：刷新预览与「上手」 */
  refresh(): void {
    this.rerenderHeader?.();
    this.rerenderPractice?.();
  }

  private closeSettings(): void {
    (this.app as unknown as { setting?: { close: () => void } }).setting?.close();
  }
}
