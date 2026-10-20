/**
 * 设置页里自绘的两块（design/onboarding-settings-approved.html 的「设置页」）：
 * 顶部（插件名 +「重新打开引导」+ 实时预览）与「上手」（带我做，做到了打勾）。
 * 普通开关、选择项由宿主用各自平台的设置接口画（Obsidian 用声明式设置，能被设置搜索搜到）。
 */
import type { ReactElement } from "react";
import { Preview, type PreviewOptions } from "./Preview";

export function SettingsHeader({ title, preview, message, onReopen }: { title: string; preview: PreviewOptions; message?: string; onReopen: () => void }): ReactElement {
  return (
    <div className="aps-settings-head">
      <div className="aps-settings-title">
        <span>{title}</span>
        <span className="aps-spacer" />
        <button type="button" className="aps-button aps-reopen" onClick={onReopen}>重新打开引导</button>
      </div>
      <Preview options={preview} height={120} className="aps-preview-muted" />
      <span className="aps-hint">{message ?? "上面是实时预览：改哪一项，预览就跟着变"}</span>
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
