/**
 * 界面组件（React 19 + Base UI + Motion），不 import `obsidian`。
 * 不得 import `obsidian`；宿主能力（翻页、读当前页、切换联动、吸附判断、读写文件）一律经 props 注入。
 * 样式类名以 `aps-` 开头，插件的 styles.css 用 Obsidian CSS 变量画。
 */
export { SPRING } from "./motion";
export {
  DOCK_INSET,
  Toolbar,
  type DockFrame,
  type SyncMode,
  type ToolbarActions,
  type ToolbarPlacement,
  type ToolbarProps,
  type ToolbarStatus
} from "./Toolbar";
export { HeadingCrumbs, type OutlineActions, type OutlinePrefs, type OutlineStatus, type OutlineStyle } from "./Outline";
export { BindDialog, PagemarkDialog, type BindDialogProps, type PagemarkDialogProps } from "./Dialogs";
export { Check, CheckRow, Choice, ChoiceRow, type ChoiceOption } from "./controls";
export { Preview, type DockChoice, type PreviewOptions } from "./Preview";
export { AUTO_OPEN_LABEL, Onboarding, type OnboardingBook, type OnboardingProps, type OnboardingValues } from "./Onboarding";
export { Coachmark, type CoachmarkProps, type CoachStep } from "./Coachmark";
export { GettingStarted, SettingsHeader, type PracticeTask } from "./SettingsBlocks";
export { SuspectPanel, type SuspectCard, type SuspectCardState, type SuspectPanelProps } from "./SuspectPanel";
