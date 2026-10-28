import { MarkdownView, Plugin, TFile, type WorkspaceLeaf } from "obsidian";
import { SyncController } from "./controller";
import { editorExtensions, refreshLabels } from "./editor-ext";
import { parseSuspectLink, PROTOCOL_ACTION } from "./core/link";
import { editorViewOf } from "./markdown-pane";
import { OnboardingHost } from "./onboarding-host";
import { mergeSettings, nightActive, PdfSyncSettingTab, type PdfSyncSettings } from "./settings";
import { SuspectDesk } from "./suspect-desk";
import { suspectExtensions } from "./suspect-ext";
import { SUSPECT_VIEW, SuspectView } from "./suspect-view";

export default class AIhistoryPdfSync extends Plugin {
  declare settings: PdfSyncSettings;
  controller!: SyncController;
  onboarding!: OnboardingHost;
  suspects!: SuspectDesk;
  private settingTab: PdfSyncSettingTab | null = null;

  async onload(): Promise<void> {
    this.settings = mergeSettings(await this.loadData());
    const statusBar = this.addStatusBarItem();
    statusBar.addClass("aps-status");
    statusBar.hide();
    this.controller = new SyncController({
      app: this.app,
      settings: this.settings,
      saveSettings: () => this.saveSettings(),
      statusBar
    });
    this.onboarding = new OnboardingHost(this);
    this.suspects = new SuspectDesk({ app: this.app, controller: this.controller, marksEnabled: () => this.settings.suspectMarks });
    this.suspects.onShowInPanel = () => void this.openSuspects();
    this.controller.onBookAttached = () => {
      this.onboarding.onBookAttached();
      void this.suspects.follow();
    };
    this.controller.onPractice = (id) => this.onboarding.practiced(id);
    this.settingTab = new PdfSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    // 夜间模式：跟随主题时，Obsidian 换亮暗主题会触发 css-change
    this.applyLook();
    this.registerEvent(this.app.workspace.on("css-change", () => this.applyLook()));

    this.registerEditorExtension(editorExtensions({
      labels: () => this.settings.pageLabels,
      onLabelClick: (page) => void this.controller.jumpToPage(page)
    }));

    // 判字：右侧栏的面板（A），正文里的标记与悬停卡片（B）
    this.registerView(SUSPECT_VIEW, (leaf) => new SuspectView(leaf, this.suspects, () => this.settings.reducedMotion));
    this.registerEditorExtension(suspectExtensions({
      enabled: () => this.settings.suspectMarks,
      card: (key, close) => this.suspects.card(key, close)
    }));
    this.registerEvent(this.app.workspace.on("file-open", () => this.suspects.refreshMarks()));

    // 阅读视图：给每个段落记下源码行号，跟随时据此换算位置
    this.registerMarkdownPostProcessor((element, context) => {
      const info = context.getSectionInfo(element);
      if (!info) return;
      element.dataset.apsLineStart = String(info.lineStart);
      element.dataset.apsLineEnd = String(info.lineEnd);
    });

    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => void this.controller.onActiveLeaf(leaf)));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.controller.onLayoutChange()));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (!(file instanceof TFile)) return;
      void this.controller.onFileChanged(file);
      this.suspects.onFileChanged(file);
    }));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => void this.controller.onFileChanged(file)));
    this.registerEvent(this.app.vault.on("rename", (file) => {
      if (file instanceof TFile) void this.controller.onFileChanged(file);
    }));

    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => {
      const link = parseSuspectLink(params);
      if (link) void this.controller.openSuspectLink(link);
    });

    this.addRibbonIcon("book-open", "在旁边打开配对的 PDF", () => void this.openPdf());

    this.addCommand({
      id: "open-pdf",
      name: "在旁边打开配对的 PDF",
      checkCallback: (checking) => this.withMarkdown(checking, () => void this.openPdf())
    });
    this.addCommand({
      id: "previous-page",
      name: "上一页（正文与 PDF 一起翻）",
      checkCallback: (checking) => this.withBook(checking, () => void this.controller.step(-1))
    });
    this.addCommand({
      id: "next-page",
      name: "下一页（正文与 PDF 一起翻）",
      checkCallback: (checking) => this.withBook(checking, () => void this.controller.step(1))
    });
    this.addCommand({
      id: "toggle-pause",
      name: "暂停或恢复跟随",
      checkCallback: (checking) => this.withBook(checking, () => {
        this.controller.setMode(this.controller.paused ? (this.settings.bidirectional ? "both" : "one") : "paused");
      })
    });
    this.addCommand({
      id: "copy-revision-request",
      name: "复制本页修订请求",
      checkCallback: (checking) => this.withBook(checking, () => void this.controller.copyRevisionRequest())
    });
    this.addCommand({
      id: "insert-page-anchors",
      name: "补页码锚点（预览后写入）",
      checkCallback: (checking) => this.withBook(checking, () => void this.controller.openPagemarkPreview())
    });
    this.addCommand({
      id: "open-suspects",
      name: "打开判字面板（逐条判定疑字清单）",
      callback: () => void this.openSuspects()
    });
    this.addCommand({
      id: "open-onboarding",
      name: "重新打开引导",
      callback: () => this.onboarding.show()
    });
    this.addCommand({
      id: "bind-pdf",
      name: "给这本书配对 PDF（写进全书笔记）",
      checkCallback: (checking) => this.withMarkdown(checking, () => this.controller.chooseAndBind())
    });

    this.app.workspace.onLayoutReady(() => {
      void this.controller.onActiveLeaf(this.app.workspace.getMostRecentLeaf());
      // 首次启用：库里没有配了 PDF 的笔记就现在弹引导；有的话等第一次打开那样的笔记时弹
      this.onboarding.maybeShowOnLoad();
    });
  }

  onunload(): void {
    document.body.removeClass("aps-night", "aps-night-warm", "aps-shade-tint", "aps-shade-bar");
    this.onboarding?.dispose();
    this.controller?.dispose();
    this.suspects?.dispose();
  }

  /** 判字面板：已开就翻到前面，没开就开在右侧栏 */
  async openSuspects(): Promise<void> {
    const workspace = this.app.workspace;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(SUSPECT_VIEW)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: SUSPECT_VIEW, active: true });
    }
    await workspace.revealLeaf(leaf);
    await this.suspects.follow();
  }

  private withMarkdown(checking: boolean, run: () => void): boolean {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) return false;
    if (!checking) run();
    return true;
  }

  private withBook(checking: boolean, run: () => void): boolean {
    if (!this.controller.book || !this.controller.markdownView) return false;
    if (!checking) run();
    return true;
  }

  private async openPdf(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view) await this.controller.onActiveLeaf(view.leaf);
    await this.controller.ensurePdf();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * 外观挂到 body 的类名上，样式见 styles/plugin.css：
   * aps-night（夜间模式生效，PDF 页面反色）、aps-night-warm（暖调）、aps-shade-tint / aps-shade-bar（当前页标示）
   */
  applyLook(): void {
    const body = document.body;
    const night = nightActive(this.settings.nightMode, body.hasClass("theme-dark"));
    body.toggleClass("aps-night", night);
    body.toggleClass("aps-night-warm", night && this.settings.nightTone === "warm");
    body.toggleClass("aps-shade-tint", this.settings.shadeStyle === "tint");
    body.toggleClass("aps-shade-bar", this.settings.shadeStyle === "bar");
  }

  settingsChanged(): void {
    this.applyLook();
    this.controller.settingsChanged();
    this.suspects.refreshMarks();
    this.settingTab?.refresh();
    // 标签开关：让各编辑器重画
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView) editorViewOf(leaf.view)?.dispatch({ effects: refreshLabels.of(null) });
    });
  }
}
