/**
 * 首次引导（A）：四步——布局、联动、外观、开始（design/onboarding-settings-approved.html）。
 * 左边选项，右边实时预览。不碰 Obsidian：选项值、书单、保存与导览动作由宿主注入。
 * 「跳过」不改设置（第一次打开时就是默认设置）。
 */
import { Dialog } from "@base-ui/react/dialog";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useState, type ReactElement } from "react";
import { CheckRow, ChoiceRow } from "./controls";
import { SPRING } from "./motion";
import { Preview, type DockChoice } from "./Preview";
import type { SyncMode } from "./Toolbar";

export interface OnboardingValues {
  pdfSide: "left" | "right";
  dock: DockChoice;
  mode: SyncMode;
  autoOpen: boolean;
  /** 页内按比例跟随（关掉则只对齐到页首） */
  proportional: boolean;
  /** 显示阅读线 */
  showBaseline: boolean;
  baselineStyle: "band" | "line" | "markers";
  /** 夜间模式：跟随主题 / 开 / 关 */
  night: "auto" | "on" | "off";
  nightTone: "neutral" | "warm";
  pageLabels: boolean;
  /** 当前页标示 */
  shade: "tint" | "bar" | "off";
  reducedMotion: boolean;
  /** 点工具条上的标题弹出的菜单：目录树 / 分栏 */
  outlineStyle: "tree" | "columns";
  /** 标题菜单每行右边的页码 */
  outlinePages: "printed" | "pdf" | "both";
}

export interface OnboardingBook {
  /** 宿主用来认书的键（书里第一篇笔记的路径等） */
  key: string;
  title: string;
  /** 所在文件夹，显示用 */
  folder: string;
  paired: boolean;
}

export interface OnboardingProps {
  initial: OnboardingValues;
  books: OnboardingBook[];
  container: HTMLElement | null;
  /** 第 2 步那个开关的文字，缺省「打开笔记时自动开 PDF」 */
  autoOpenLabel?: { label: string; hint: string };
  /** 点「完成」：保存选项 */
  onFinish: (values: OnboardingValues) => void;
  /** 点「跳过」或关掉：不改设置 */
  onSkip: () => void;
  /** 第 4 步：已配 PDF 的书「开始导览」（先保存选项） */
  onStartTour: (values: OnboardingValues, book: OnboardingBook) => void;
  /** 第 4 步：未配 PDF 的书「先绑定 PDF」（先保存选项） */
  onBind: (values: OnboardingValues, book: OnboardingBook) => void;
}

export const AUTO_OPEN_LABEL = { label: "打开笔记时自动开 PDF", hint: "记住你上次的选择" };

const STEPS = ["布局", "联动", "外观", "开始"];

export function Onboarding(props: OnboardingProps): ReactElement {
  const [open, setOpen] = useState(true);
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  const [values, setValues] = useState<OnboardingValues>(props.initial);
  const set = <K extends keyof OnboardingValues>(key: K, value: OnboardingValues[K]) => setValues((old) => ({ ...old, [key]: value }));
  const close = (then: () => void) => {
    setOpen(false);
    then();
  };
  const go = (delta: number) => {
    setDirection(delta);
    setStep((old) => Math.min(STEPS.length - 1, Math.max(0, old + delta)));
  };

  const body = [
    <div key="layout" className="aps-ob-step">
      <ChoiceRow title="PDF 放哪边" value={values.pdfSide} onChange={(value) => set("pdfSide", value)} options={[{ value: "left", label: "左边" }, { value: "right", label: "右边" }]} />
      <ChoiceRow
        title="工具条默认放哪"
        value={values.dock}
        onChange={(value) => set("dock", value)}
        options={[{ value: "markdown", label: "正文顶部" }, { value: "pdf", label: "PDF 顶部" }, { value: "floating", label: "悬浮" }]}
      />
    </div>,
    <div key="sync" className="aps-ob-step">
      <ChoiceRow title="联动方式" value={values.mode} onChange={(value) => set("mode", value)} options={[{ value: "both", label: "双向" }, { value: "one", label: "单向" }, { value: "paused", label: "暂停" }]} />
      <CheckRow label={props.autoOpenLabel?.label ?? AUTO_OPEN_LABEL.label} hint={props.autoOpenLabel?.hint ?? AUTO_OPEN_LABEL.hint} checked={values.autoOpen} onChange={(value) => set("autoOpen", value)} />
      <CheckRow label="页内按比例跟随" hint="关掉则只对齐到页首" checked={values.proportional} onChange={(value) => set("proportional", value)} />
      <CheckRow
        label="显示阅读线"
        hint="两边同一高度标出阅读线，线上的内容就是对齐的地方；高度在设置里调（20–50%）"
        checked={values.showBaseline}
        onChange={(value) => set("showBaseline", value)}
      />
      {values.showBaseline ? (
        <ChoiceRow
          title="阅读线样式"
          value={values.baselineStyle}
          onChange={(value) => set("baselineStyle", value)}
          options={[{ value: "band", label: "淡色带" }, { value: "line", label: "细线" }, { value: "markers", label: "端点" }]}
        />
      ) : null}
    </div>,
    <div key="look" className="aps-ob-step">
      <p className="aps-hint">下面两项会改变正文编辑区的样子，默认打开；不需要就取消勾选，以后也能在设置里改。</p>
      <CheckRow
        label="实时预览里显示页码标签"
        hint="页码标记显示成小标签，点它跳到 PDF 该页；源码模式、阅读视图不变"
        checked={values.pageLabels}
        onChange={(value) => set("pageLabels", value)}
      />
      <ChoiceRow
        title="当前页标示"
        value={values.shade}
        onChange={(value) => set("shade", value)}
        options={[{ value: "tint", label: "淡底色" }, { value: "bar", label: "左侧竖条" }, { value: "off", label: "不标示" }]}
      />
      <ChoiceRow
        title="夜间模式"
        value={values.night}
        onChange={(value) => set("night", value)}
        options={[{ value: "auto", label: "跟随主题" }, { value: "on", label: "开" }, { value: "off", label: "关" }]}
      />
      <ChoiceRow
        title="PDF 夜间色调"
        value={values.nightTone}
        onChange={(value) => set("nightTone", value)}
        options={[{ value: "neutral", label: "中性" }, { value: "warm", label: "暖调" }]}
      />
      <p className="aps-hint">夜间模式把 PDF 页面反色成深底浅字（图片颜色也会反过来）；跟随主题时随 Obsidian 亮暗自动切换。</p>
      <CheckRow label="动效" hint="关掉即减少动效" checked={!values.reducedMotion} onChange={(value) => set("reducedMotion", !value)} />
      <ChoiceRow
        title="标题菜单样式"
        value={values.outlineStyle}
        onChange={(value) => set("outlineStyle", value)}
        options={[{ value: "tree", label: "目录树" }, { value: "columns", label: "分栏" }]}
      />
      <ChoiceRow
        title="标题菜单里的页码"
        value={values.outlinePages}
        onChange={(value) => set("outlinePages", value)}
        options={[{ value: "printed", label: "印刷页" }, { value: "pdf", label: "PDF 页" }, { value: "both", label: "两个都标" }]}
      />
      <p className="aps-hint">点工具条上的标题会弹出标题菜单。目录树：H1–H5 缩进成一棵树；分栏：当前位置的每一级并排一栏。页码在中文界面写「第50页」，其他语言写「p.50」。</p>
    </div>,
    <div key="start" className="aps-ob-step">
      <div className="aps-row">选一本你自己的书，走三步导览</div>
      {props.books.length ? (
        <div className="aps-ob-books">
          {props.books.map((book) => (
            <div key={book.key} className="aps-ob-book">
              <span className="aps-ob-book-title" title={book.folder}>{book.title}</span>
              <span className="aps-hint">{book.paired ? "已配 PDF" : "还没配 PDF"}</span>
              <button
                type="button"
                className="aps-button"
                onClick={() => close(() => (book.paired ? props.onStartTour(values, book) : props.onBind(values, book)))}
              >
                {book.paired ? "开始导览" : "先绑定 PDF"}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="aps-hint">库里还没有配了 PDF 的书。用 book2md1012 导入一本，或打开笔记后在工具条的 ⋯ 菜单里绑定 PDF。</p>
      )}
    </div>
  ];

  return (
    <MotionConfig reducedMotion={values.reducedMotion ? "always" : "user"}>
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (!next) close(props.onSkip);
        }}
      >
        <Dialog.Portal container={props.container}>
          <Dialog.Backdrop className="aps-dialog-backdrop" />
          <Dialog.Popup
            className="aps-dialog aps-onboarding"
            render={<motion.div initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={SPRING} />}
          >
            <div className="aps-ob-head">
              <Dialog.Title className="aps-dialog-title">欢迎使用 PDF Sync Markdown</Dialog.Title>
              <span className="aps-ob-steps">第 {step + 1} 步，共 {STEPS.length} 步：{STEPS[step]}</span>
            </div>
            <div className="aps-ob-grid">
              <div className="aps-ob-controls">
                <AnimatePresence mode="wait" initial={false} custom={direction}>
                  <motion.div
                    key={step}
                    initial={{ opacity: 0, x: 24 * direction }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -24 * direction }}
                    transition={SPRING}
                  >
                    {body[step]}
                  </motion.div>
                </AnimatePresence>
              </div>
              <div>
                <Preview
                  options={{ pdfSide: values.pdfSide, dock: values.dock, mode: values.mode, pageLabels: values.pageLabels, shade: values.shade, baseline: values.showBaseline ? values.baselineStyle : false, night: values.night === "on" || (values.night === "auto" && document.body.classList.contains("theme-dark")) ? values.nightTone : false, reducedMotion: values.reducedMotion }}
                />
                <p className="aps-hint">右边是实时预览，选项一改就变</p>
              </div>
            </div>
            <div className="aps-ob-foot">
              <button type="button" className="aps-button aps-ob-skip" onClick={() => close(props.onSkip)}>跳过，以后在设置里重开</button>
              <span className="aps-spacer" />
              {step > 0 ? <button type="button" className="aps-button" onClick={() => go(-1)}>上一步</button> : null}
              {step < STEPS.length - 1 ? (
                <button type="button" className="aps-button mod-cta" onClick={() => go(1)}>下一步</button>
              ) : (
                <button type="button" className="aps-button mod-cta" onClick={() => close(() => props.onFinish(values))}>完成</button>
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </MotionConfig>
  );
}
