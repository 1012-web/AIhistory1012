/**
 * 首次引导（A）与导览、「上手」练习在 Obsidian 里的接线：
 * - 首次启用后第一次打开配有 PDF 的笔记时弹引导；库里没有这样的笔记就在首次启用时弹。只弹一次。
 * - 引导第 4 步列出库里的书：已配 PDF 的「开始导览」——关掉引导窗，在真界面上走三步气泡；
 *   未配的先弹「绑定 PDF」清单，绑好再导览。
 * - 设置页「上手」的「带我做」：关掉设置窗，在当前打开的书上弹提示，做到了打勾并记下。
 */
import { Notice, TFile, TFolder } from "obsidian";
import { useEffect, useState, type ReactElement } from "react";
import type AIhistoryPdfSync from "./main";
import { DATA_DIR, linkpathOf } from "./pairing";
import { mountDialog } from "./react-mount";
import { applySyncMode, dockChoiceOf, syncModeOf, withDockChoice, type PracticeId } from "./settings";
import { Coachmark, Onboarding, type CoachStep, type OnboardingBook, type OnboardingValues } from "./ui";
import { delay } from "./pdf-view";

const TOUR_TEXT = [
  "这是工具条：按住左端把手能拖开，拖近正文或 PDF 窗格顶部就停靠过去",
  "点页码数字可以直接输入页数，回车后两边一起跳",
  "这里切换联动方式：双向、单向、暂停"
];

const PRACTICE_TEXT: Record<PracticeId, string> = {
  highlight: "在正文里选中几个字，PDF 上同样的字会高亮",
  pageEdit: "点工具条上的 ‹ › 两边一起翻一页；当前页正文有浅底色，直接在里面改字"
};

export class OnboardingHost {
  private closeCoach: (() => void) | null = null;
  private practiceWaiting: { id: PracticeId; rerender: (completed: boolean) => void } | null = null;
  private showing = false;

  constructor(private readonly plugin: AIhistoryPdfSync) {}

  private get app() {
    return this.plugin.app;
  }

  private get settings() {
    return this.plugin.settings;
  }

  /** 插件加载完：没弹过、且库里没有配了 PDF 的笔记，就现在弹 */
  maybeShowOnLoad(): void {
    if (this.settings.onboarded || this.vaultHasPairedNotes()) return;
    this.show();
  }

  /** 控制器挂上一本书时：没弹过就弹 */
  onBookAttached(): void {
    if (!this.settings.onboarded) this.show();
  }

  private vaultHasPairedNotes(): boolean {
    if (this.app.vault.getFiles().some((file) => file.path.endsWith(`${DATA_DIR}/book.json`))) return true;
    return this.app.vault.getMarkdownFiles().some((file) => !!linkpathOf(this.app.metadataCache.getFileCache(file)?.frontmatter?.pdf));
  }

  private values(): OnboardingValues {
    const settings = this.settings;
    return {
      pdfSide: settings.pdfSide,
      dock: dockChoiceOf(settings.toolbar),
      mode: syncModeOf(settings),
      autoOpen: settings.autoOpen,
      proportional: settings.proportional,
      showBaseline: settings.showBaseline,
      baselineStyle: settings.baselineStyle,
      night: settings.nightMode,
      nightTone: settings.nightTone,
      pageLabels: settings.pageLabels,
      shade: settings.shadeStyle,
      reducedMotion: settings.reducedMotion,
      outlineStyle: settings.outlineStyle,
      outlinePages: settings.outlinePages
    };
  }

  private async apply(values: OnboardingValues): Promise<void> {
    const settings = this.settings;
    settings.toolbar = withDockChoice(settings.toolbar, values.dock);
    applySyncMode(settings, values.mode);
    settings.autoOpen = values.autoOpen;
    settings.proportional = values.proportional;
    settings.showBaseline = values.showBaseline;
    settings.baselineStyle = values.baselineStyle;
    settings.nightMode = values.night;
    settings.nightTone = values.nightTone;
    settings.pageLabels = values.pageLabels;
    settings.shadeStyle = values.shade;
    settings.reducedMotion = values.reducedMotion;
    settings.outlineStyle = values.outlineStyle;
    settings.outlinePages = values.outlinePages;
    // 换边要把已开的 PDF 挪过去：交给控制器（它自己改设置并保存）
    if (values.pdfSide !== settings.pdfSide) await this.plugin.controller.swapSide();
    await this.plugin.saveSettings();
    this.plugin.settingsChanged();
  }

  /** 弹引导（首次自动弹，或设置页「重新打开引导」、命令） */
  show(): void {
    if (this.showing) return;
    this.showing = true;
    if (!this.settings.onboarded) {
      this.settings.onboarded = true;
      void this.plugin.saveSettings();
    }
    // 挂到工作区主窗口：从设置窗（Obsidian 1.13 起是单独的弹出窗口）点「重新打开引导」时，活动窗口是设置窗
    const doc = this.plugin.controller.markdownView?.containerEl.doc ?? this.app.workspace.containerEl.doc;
    void this.listBooks().then((books) => {
      mountDialog(doc, (close) => (
        <Onboarding
          initial={this.values()}
          books={books}
          container={doc.body}
          onSkip={() => this.done(close)}
          onFinish={(values) => {
            this.done(close);
            void this.apply(values).then(() => new Notice("设置已保存；引导可在设置里重开"));
          }}
          onStartTour={(values, book) => {
            this.done(close);
            void this.apply(values).then(() => this.startTour(book));
          }}
          onBind={(values, book) => {
            this.done(close);
            void this.apply(values).then(() => this.bindThenTour(book));
          }}
        />
      ));
    });
  }

  private done(close: () => void): void {
    this.showing = false;
    close();
  }

  /** 库里的书：有 _数据/book.json 的书文件夹，加上 frontmatter 写了 pdf 的笔记所在的文件夹 */
  private async listBooks(): Promise<OnboardingBook[]> {
    const folders = new Map<string, string | null>();
    for (const file of this.app.vault.getFiles()) {
      if (!file.path.endsWith(`${DATA_DIR}/book.json`)) continue;
      const root = file.parent?.parent;
      if (!root) continue;
      let title: string | null = null;
      try {
        const parsed: unknown = JSON.parse(await this.app.vault.cachedRead(file));
        if (parsed && typeof parsed === "object" && typeof (parsed as { title?: unknown }).title === "string") title = (parsed as { title: string }).title;
      } catch {
        title = null;
      }
      folders.set(root.path, title);
    }
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (linkpathOf(this.app.metadataCache.getFileCache(file)?.frontmatter?.pdf) && file.parent && !folders.has(file.parent.path)) folders.set(file.parent.path, null);
    }
    const books: OnboardingBook[] = [];
    for (const [folderPath, title] of folders) {
      const folder = folderPath === "/" ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(folderPath);
      if (!(folder instanceof TFolder)) continue;
      const notes = folder.children
        .filter((child): child is TFile => child instanceof TFile && child.extension === "md")
        .sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN", { numeric: true }));
      const first = notes[0];
      if (!first) continue;
      const pairing = await this.plugin.controller.pairer.resolve(first);
      books.push({ key: first.path, title: title ?? folder.name ?? first.basename, folder: folder.path, paired: !!pairing });
    }
    return books.sort((a, b) => Number(b.paired) - Number(a.paired) || a.title.localeCompare(b.title, "zh-Hans-CN"));
  }

  private async openNote(path: string): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    const controller = this.plugin.controller;
    const leaf = controller.markdownLeaf ?? this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { active: true });
    return true;
  }

  private async bindThenTour(book: OnboardingBook): Promise<void> {
    if (!(await this.openNote(book.key))) return;
    const file = this.app.vault.getAbstractFileByPath(book.key);
    this.plugin.controller.chooseAndBind(file instanceof TFile ? file : null, () => void this.startTour(book));
  }

  /** 等工具条出来（插件接管这本书、工具条展开） */
  private async waitForToolbar(): Promise<HTMLElement | null> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const element = this.plugin.controller.toolbar.element;
      if (element && this.plugin.controller.book) return element;
      await delay(100);
    }
    return null;
  }

  async startTour(book: OnboardingBook | null): Promise<void> {
    if (book && !(await this.openNote(book.key))) return;
    const toolbar = await this.waitForToolbar();
    if (!toolbar) {
      new Notice("没等到工具条：先打开一本配了 PDF 的书");
      return;
    }
    if (this.settings.toolbar.collapsed) {
      this.settings.toolbar = { ...this.settings.toolbar, collapsed: false };
      await this.plugin.saveSettings();
      this.plugin.settingsChanged();
    }
    await delay(500);
    const doc = toolbar.ownerDocument;
    const find = (selector: string) => () => doc.querySelector<HTMLElement>(`.aps-toolbar ${selector}`);
    const steps: CoachStep[] = [
      { target: find(".aps-grip"), text: TOUR_TEXT[0] },
      { target: find(".aps-page-input"), text: TOUR_TEXT[1] },
      { target: find(".aps-seg"), text: TOUR_TEXT[2] }
    ];
    this.closeCoach?.();
    const close = mountDialog(doc, (done) => (
      <Coachmark
        steps={steps}
        reducedMotion={this.settings.reducedMotion}
        onDone={() => {
          this.closeCoach = null;
          done();
        }}
      />
    ));
    this.closeCoach = close;
  }

  /** 设置页「带我做」 */
  practice(id: PracticeId): void {
    const controller = this.plugin.controller;
    const view = controller.markdownView;
    if (!controller.book || !view) {
      new Notice("先打开一本配了 PDF 的书，再点「带我做」");
      return;
    }
    const doc = view.containerEl.doc;
    const target = id === "highlight"
      ? () => view.contentEl.querySelector<HTMLElement>(".cm-content, .markdown-preview-sizer") ?? view.contentEl
      : () => doc.querySelector<HTMLElement>(".aps-toolbar .aps-stepper");
    this.closeCoach?.();
    let rerender: ((completed: boolean) => void) | null = null;
    const close = mountDialog(doc, (done) => {
      const finish = () => {
        this.closeCoach = null;
        this.practiceWaiting = null;
        done();
      };
      return (
        <PracticeCoach
          id={id}
          target={target}
          reducedMotion={this.settings.reducedMotion}
          onDone={finish}
          register={(fn) => {
            rerender = fn;
          }}
        />
      );
    });
    this.closeCoach = close;
    this.practiceWaiting = { id, rerender: (completed) => rerender?.(completed) };
  }

  /** 控制器报告：用户做到了某个练习 */
  practiced(id: PracticeId): void {
    const waiting = this.practiceWaiting;
    if (!waiting || waiting.id !== id) return;
    if (!this.settings.practice[id]) {
      this.settings.practice = { ...this.settings.practice, [id]: true };
      void this.plugin.saveSettings().then(() => this.plugin.settingsChanged());
    }
    waiting.rerender(true);
  }

  dispose(): void {
    this.closeCoach?.();
    this.closeCoach = null;
  }
}

/** 「带我做」的气泡：等宿主报告做到了，再显示「做到了」 */
function PracticeCoach({ id, target, reducedMotion, onDone, register }: {
  id: PracticeId;
  target: () => HTMLElement | null;
  reducedMotion: boolean;
  onDone: () => void;
  register: (fn: (completed: boolean) => void) => void;
}): ReactElement {
  const [completed, setCompleted] = useState(false);
  useEffect(() => register(setCompleted), [register]);
  return <Coachmark steps={[{ target, text: PRACTICE_TEXT[id] }]} reducedMotion={reducedMotion} waitForAction completed={completed} onDone={onDone} />;
}
