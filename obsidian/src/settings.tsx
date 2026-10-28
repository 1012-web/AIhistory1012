/**
 * 设置与设置页（design/onboarding-settings-approved.html 的「设置页」）：
 * 顶部插件名 +「重新打开引导」+ 实时预览；分组 布局 / 联动 / 外观 / 上手；其余放「高级」子页。
 * 普通开关、选择项用 Obsidian 的声明式设置接口（设置搜索能搜到）；顶部与「上手」两块用 React 自绘嵌入。
 */
import { App, PluginSettingTab, type SettingDefinitionItem } from "obsidian";
import type AIhistoryPdfSync from "./main";
import { mountReact } from "./react-mount";
import type { OutlineBookState, OutlinePages } from "./core/outline-view";
import { GettingStarted, SettingsHeader, type DockChoice, type OutlineStyle, type PreviewOptions, type SyncMode } from "./ui";

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

export type NightMode = "auto" | "on" | "off";
/** PDF 夜间色调：neutral 中性反色；warm 反色后略偏暖 */
export type NightTone = "neutral" | "warm";
/** 阅读线样式：band 淡色带；line 细线加小标签；markers 只在两端各标一对小三角 */
export type BaselineStyle = "band" | "line" | "markers";
/** 当前页标示：tint 极淡底色；bar 左侧竖条；off 不标示 */
export type ShadeStyle = "tint" | "bar" | "off";

/** 夜间模式此刻是否生效（auto 时看 Obsidian 当前是不是深色主题） */
export function nightActive(mode: NightMode, darkTheme: boolean): boolean {
  return mode === "on" || (mode === "auto" && darkTheme);
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
  /** 在正文与 PDF 两个窗格里画出阅读线（两边按这条线对齐；只显示、不拦鼠标） */
  showBaseline: boolean;
  baselineStyle: BaselineStyle;
  pdfSide: "left" | "right";
  /** 当前页在正文里怎么标示（实时预览与源码模式） */
  shadeStyle: ShadeStyle;
  pageLabels: boolean;
  wordHighlight: boolean;
  /** 夜间模式：auto 跟随 Obsidian 的深色主题；on 总是开；off 总是关。开着时 PDF 页面反色、插件元素用深色 */
  nightMode: NightMode;
  nightTone: NightTone;
  /** 减少动效（另外自动尊重系统的「减少动态效果」） */
  reducedMotion: boolean;
  toolbar: ToolbarState;
  /** 点工具条上的标题弹出的菜单：tree 目录树（默认）；columns 分栏 */
  outlineStyle: OutlineStyle;
  /** 菜单每行右边的页码：印刷页（默认）/ PDF 页 / 两个都标 */
  outlinePages: OutlinePages;
  /** 菜单里每行左边标 H1–H5 */
  outlineShowLevel: boolean;
  /** 菜单里每行右边标页码 */
  outlineShowPage: boolean;
  /** 菜单里显示「钉住」按钮（设置页可关） */
  outlinePinButton: boolean;
  /** 钉住：跳转后菜单不关，跟着阅读位置高亮 */
  outlinePinned: boolean;
  /** 各本书的目录展开记忆，键是书的 PDF 路径 */
  outlineBooks: Record<string, OutlineBookState>;
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
  showBaseline: true,
  baselineStyle: "band",
  pdfSide: "left",
  // 这两项会改动 Obsidian 原生编辑区的样子：默认开，引导第 3 步写明效果，用户可在那里或设置里关掉
  shadeStyle: "tint",
  pageLabels: true,
  wordHighlight: true,
  nightMode: "auto",
  nightTone: "neutral",
  reducedMotion: false,
  toolbar: { mode: "docked", dock: "markdown", x: 120, y: 120, collapsed: false },
  outlineStyle: "tree",
  outlinePages: "printed",
  outlineShowLevel: true,
  outlineShowPage: true,
  outlinePinButton: true,
  outlinePinned: false,
  outlineBooks: {},
  onboarded: false,
  practice: { highlight: false, pageEdit: false }
};

export function mergeSettings(raw: unknown): PdfSyncSettings {
  const data = (raw && typeof raw === "object" ? raw : {}) as Partial<PdfSyncSettings> & { shadeCurrentPage?: boolean };
  // 0.1.1 以前是开关 shadeCurrentPage：关着的换成「不标示」，开着的用新默认
  const { shadeCurrentPage, ...rest } = data;
  const shadeStyle: ShadeStyle = rest.shadeStyle ?? (shadeCurrentPage === false ? "off" : DEFAULT_SETTINGS.shadeStyle);
  return {
    ...DEFAULT_SETTINGS,
    ...rest,
    shadeStyle,
    toolbar: { ...DEFAULT_SETTINGS.toolbar, ...(data.toolbar ?? {}) },
    outlineBooks: { ...(data.outlineBooks ?? {}) },
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
    shade: settings.shadeStyle,
    baseline: settings.showBaseline ? settings.baselineStyle : false,
    night: nightActive(settings.nightMode, document.body.hasClass("theme-dark")) ? settings.nightTone : false,
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
  | "dockChoice"
  | "syncMode"
  | "autoOpen"
  | "proportional"
  | "baselinePercent"
  | "showBaseline"
  | "baselineStyle"
  | "nightMode"
  | "pageLabels"
  | "shadeStyle"
  | "nightTone"
  | "reducedMotion"
  | "wordHighlight"
  | "outlineStyle"
  | "outlinePages"
  | "outlineShowLevel"
  | "outlineShowPage"
  | "outlinePinButton";

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
        name: "PDF Sync Markdown",
        searchable: false,
        render: (setting) => {
          setting.settingEl.empty();
          setting.settingEl.addClass("aps-settings-react");
          const mount = setting.settingEl.createDiv();
          const handle = mountReact(mount);
          this.rerenderHeader = () => handle.render(
            <SettingsHeader
              title="PDF Sync Markdown"
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
          },
          {
            name: "显示阅读线",
            desc: "在正文与 PDF 两边同一高度标出阅读线，线上的内容就是两边对齐的地方。默认开",
            control: { type: "toggle", key: "showBaseline", defaultValue: DEFAULT_SETTINGS.showBaseline }
          },
          {
            name: "阅读线样式",
            desc: "淡色带：一条很淡的横带（默认）；细线：一根细线加「阅读线」小标签；端点：只在两边各标一对小三角",
            control: { type: "dropdown", key: "baselineStyle", options: { band: "淡色带", line: "细线", markers: "端点" }, defaultValue: DEFAULT_SETTINGS.baselineStyle }
          }
        ]
      },
      {
        type: "group",
        heading: "外观",
        items: [
          {
            name: "实时预览里显示页码标签",
            desc: "把正文里看不见的页码标记显示成小标签，点标签跳到 PDF 该页；源码模式、阅读视图不变。默认开",
            control: { type: "toggle", key: "pageLabels", defaultValue: DEFAULT_SETTINGS.pageLabels }
          },
          {
            name: "夜间模式",
            desc: "开着时 PDF 页面反色成深底浅字（图片颜色也会反过来）。默认跟随 Obsidian 的亮暗主题自动切换",
            control: { type: "dropdown", key: "nightMode", options: { auto: "跟随主题", on: "开", off: "关" }, defaultValue: DEFAULT_SETTINGS.nightMode }
          },
          {
            name: "PDF 夜间色调",
            desc: "中性：纯反色（默认）；暖调：反色后略偏暖黄，不那么刺眼",
            control: { type: "dropdown", key: "nightTone", options: { neutral: "中性", warm: "暖调" }, defaultValue: DEFAULT_SETTINGS.nightTone }
          },
          {
            name: "当前页标示",
            desc: "正在读的那一页在正文里怎么标出来（实时预览与源码模式）：淡底色（默认）、左侧竖条，或不标示",
            control: { type: "dropdown", key: "shadeStyle", options: { tint: "淡底色", bar: "左侧竖条", off: "不标示" }, defaultValue: DEFAULT_SETTINGS.shadeStyle }
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
        heading: "标题菜单",
        items: [
          {
            name: "标题菜单样式",
            desc: "点工具条上的标题弹出的菜单。目录树：各级标题缩进成一棵树（默认）；分栏：当前位置的每一级并排一栏",
            control: { type: "dropdown", key: "outlineStyle", options: { tree: "目录树", columns: "分栏" }, defaultValue: DEFAULT_SETTINGS.outlineStyle }
          },
          {
            name: "标题菜单里的页码",
            desc: "印刷页：书上印的页码（默认）；PDF 页：PDF 文件的第几页；两个都标。Obsidian 界面是中文时写「第50页」，其他语言写「p.50」",
            control: { type: "dropdown", key: "outlinePages", options: { printed: "印刷页", pdf: "PDF 页", both: "两个都标" }, defaultValue: DEFAULT_SETTINGS.outlinePages }
          },
          {
            name: "标题菜单里标出级别",
            desc: "每行左边标 H1–H5。菜单里也能直接切换",
            control: { type: "toggle", key: "outlineShowLevel", defaultValue: DEFAULT_SETTINGS.outlineShowLevel }
          },
          {
            name: "标题菜单里标出页码",
            desc: "每行右边标页码。菜单里也能直接切换",
            control: { type: "toggle", key: "outlineShowPage", defaultValue: DEFAULT_SETTINGS.outlineShowPage }
          },
          {
            name: "标题菜单里显示「钉住」按钮",
            desc: "钉住后点了标题菜单不关，跟着阅读位置高亮当前标题。默认显示",
            control: { type: "toggle", key: "outlinePinButton", defaultValue: DEFAULT_SETTINGS.outlinePinButton }
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
