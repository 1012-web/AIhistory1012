/** 引导、设置、对话框共用的小控件：勾选框、分段选择。Base UI 打底，样式类名见 ui.css。 */
import { Checkbox } from "@base-ui/react/checkbox";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { motion } from "motion/react";
import { useId, type ReactElement, type ReactNode } from "react";
import { CheckIcon } from "./icons";
import { SPRING } from "./motion";

export function Check({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }): ReactElement {
  return (
    <Checkbox.Root className="aps-checkbox" checked={checked} onCheckedChange={(value) => onChange(value)} aria-label={label}>
      <Checkbox.Indicator className="aps-checkbox-indicator">
        <CheckIcon />
      </Checkbox.Indicator>
    </Checkbox.Root>
  );
}

/** 一行：勾选框 + 文字 + 灰色说明 */
export function CheckRow({ checked, onChange, label, hint }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string }): ReactElement {
  return (
    <label className="aps-row aps-check-row">
      <Check checked={checked} onChange={onChange} label={label} />
      <span>{label}</span>
      {hint ? <span className="aps-hint">{hint}</span> : null}
    </label>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
}

/** 分段选择：选中项的底色用 Motion 弹簧滑过去 */
export function Choice<T extends string>({ value, options, onChange, label }: { value: T; options: Array<ChoiceOption<T>>; onChange: (value: T) => void; label: string }): ReactElement {
  const id = useId();
  return (
    <ToggleGroup
      className="aps-choice"
      aria-label={label}
      value={[value]}
      onValueChange={(next) => {
        const picked = next[0] as T | undefined;
        if (picked) onChange(picked);
      }}
    >
      {options.map((option) => (
        <Toggle key={option.value} value={option.value} className="aps-choice-item">
          {value === option.value ? <motion.span layoutId={`aps-choice-${id}`} className="aps-choice-ind" transition={SPRING} /> : null}
          <span className="aps-choice-label">{option.label}</span>
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

/** 一行：上面一句说明，下面分段选择 */
export function ChoiceRow<T extends string>(props: { title: string; value: T; options: Array<ChoiceOption<T>>; onChange: (value: T) => void; children?: ReactNode }): ReactElement {
  return (
    <div className="aps-row">
      <span>{props.title}</span>
      <Choice value={props.value} options={props.options} onChange={props.onChange} label={props.title} />
      {props.children}
    </div>
  );
}
