/**
 * 设置页里自绘的两块（design/onboarding-settings-approved.html 的「设置页」）：
 * 顶部（插件名 +「外观与布局…」+「重新打开引导」）与「上手」（带我做，做到了打勾）。
 * 实时预览放在外观与布局面板里，那里改什么都看得见。
 * 普通开关、选择项由宿主用各自平台的设置接口画（Obsidian 用声明式设置，能被设置搜索搜到）。
 */
import type { ReactElement } from "react";

export function SettingsHeader({ title, message, onLook, onReopen }: { title: string; message?: string; onLook: () => void; onReopen: () => void }): ReactElement {
  return (
    <div className="aps-settings-head">
      <div className="aps-settings-title">
        <span>{title}</span>
        <span className="aps-spacer" />
        <button type="button" className="aps-button mod-cta aps-open-look" onClick={onLook}>外观与布局…</button>
        <button type="button" className="aps-button aps-reopen" onClick={onReopen}>重新打开引导</button>
      </div>
      <span className="aps-hint">{message ?? "布局、阅读线、外观、标题菜单可在「外观与布局」里边改边看；下面是全部选项"}</span>
    </div>
  );
}

export interface PracticeTask {
  id: string;
  label: string;
  hint?: string;
  done: boolean;
}

export function GettingStarted({ tasks, onDo }: { tasks: PracticeTask[]; onDo: (id: string) => void }): ReactElement {
  return (
    <div className="aps-practice">
      {tasks.map((task) => (
        <div key={task.id} className="aps-practice-row" data-task={task.id}>
          <span className={`aps-practice-mark${task.done ? " is-done" : ""}`} aria-label={task.done ? "已做到" : "还没做"}>{task.done ? "✓" : ""}</span>
          <span className="aps-practice-text">
            {task.label}
            {task.hint ? <span className="aps-hint">{task.hint}</span> : null}
          </span>
          <button type="button" className="aps-button" onClick={() => onDo(task.id)}>带我做</button>
        </div>
      ))}
    </div>
  );
}
