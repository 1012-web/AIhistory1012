/**
 * 两个对话框（Base UI Dialog）：绑定 PDF 前列清单确认、补页码锚点预览。不碰 Obsidian，数据与动作由宿主注入。
 */
import { Dialog } from "@base-ui/react/dialog";
import { MotionConfig, motion } from "motion/react";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import type { Confidence, PagemarkPlan, PagemarkProposal } from "../core/pagemarks";
import { Check } from "./controls";
import { SPRING } from "./motion";

interface ShellProps {
  title: string;
  className?: string;
  container: HTMLElement | null;
  reducedMotion: boolean;
  onClose: () => void;
  children: ReactNode;
}

function Shell({ title, className, container, reducedMotion, onClose, children }: ShellProps): ReactElement {
  const [open, setOpen] = useState(true);
  return (
    <MotionConfig reducedMotion={reducedMotion ? "always" : "user"}>
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) onClose();
        }}
      >
        <Dialog.Portal container={container}>
          <Dialog.Backdrop className="aps-dialog-backdrop" />
          <Dialog.Popup
            className={`aps-dialog ${className ?? ""}`}
            render={<motion.div initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={SPRING} />}
          >
            <Dialog.Title className="aps-dialog-title">{title}</Dialog.Title>
            <Dialog.Close className="aps-dialog-close" aria-label="关闭">×</Dialog.Close>
            {children}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </MotionConfig>
  );
}

// ---------- 绑定 PDF ----------

export interface BindDialogProps {
  pdfPath: string;
  files: string[];
  container: HTMLElement | null;
  reducedMotion: boolean;
  onConfirm: (files: string[]) => void;
  onClose: () => void;
}

export function BindDialog({ pdfPath, files, container, reducedMotion, onConfirm, onClose }: BindDialogProps): ReactElement {
  const [chosen, setChosen] = useState(() => new Set(files));
  const toggle = (file: string, value: boolean) => setChosen((old) => {
    const next = new Set(old);
    if (value) next.add(file);
    else next.delete(file);
    return next;
  });
  return (
    <Shell title="把这本书的笔记配到 PDF" className="aps-bind-modal" container={container} reducedMotion={reducedMotion} onClose={onClose}>
      <p>PDF：{pdfPath}</p>
      <p className="aps-muted">下面勾选的笔记，frontmatter 里都会写上（或改成）PDF 链接：</p>
      <div className="aps-bind-list">
        {files.map((file) => (
          <label key={file} className="aps-bind-row">
            <Check checked={chosen.has(file)} onChange={(value) => toggle(file, value)} label={file} />
            <span>{file}</span>
          </label>
        ))}
      </div>
      <div className="aps-dialog-buttons">
        <Dialog.Close className="aps-button">取消</Dialog.Close>
        <button
          type="button"
          className="aps-button mod-cta"
          onClick={() => {
            onConfirm(files.filter((file) => chosen.has(file)));
            onClose();
          }}
        >
          写入
        </button>
      </div>
    </Shell>
  );
}

// ---------- 补页码锚点 ----------

const CONFIDENCE_LABEL: Record<Confidence, string> = { high: "高", medium: "中", low: "低" };
const PLACEMENT_LABEL = { mid: "段中", line: "行首", paragraph: "退到段首" } as const;

export interface PagemarkDialogProps {
  filePath: string;
  pageCount: number;
  range: [number, number];
  container: HTMLElement | null;
  reducedMotion: boolean;
  plan: (from: number, to: number) => Promise<PagemarkPlan>;
  write: (proposals: PagemarkProposal[]) => Promise<void>;
  onClose: () => void;
}

export function PagemarkDialog(props: PagemarkDialogProps): ReactElement {
  const [from, setFrom] = useState(String(props.range[0]));
  const [to, setTo] = useState(String(props.range[1]));
  const [plan, setPlan] = useState<PagemarkPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const preview = async () => {
    const a = Number.parseInt(from, 10) || 1;
    const b = Number.parseInt(to, 10) || props.pageCount;
    setBusy(true);
    const result = await props.plan(Math.max(1, Math.min(a, b)), Math.min(props.pageCount, Math.max(a, b)));
    setPlan(result);
    setSelected(new Set(result.proposals.filter((proposal) => proposal.confidence !== "low").map((proposal) => proposal.page)));
    setBusy(false);
  };

  useEffect(() => {
    void preview();
    // 只在打开时自动预览一次
  }, []);

  const count = (level: Confidence) => plan?.proposals.filter((proposal) => proposal.confidence === level).length ?? 0;

  return (
    <Shell title="补页码锚点（预览）" className="aps-pagemark-modal" container={props.container} reducedMotion={props.reducedMotion} onClose={props.onClose}>
      <p className="aps-muted">笔记：{props.filePath}。按 PDF 文字层找每页开头，已有锚点不动；预览确认后才写入。</p>
      <div className="aps-range">
        <span>在 PDF 第</span>
        <input className="aps-range-input" aria-label="起始页" value={from} onChange={(event) => setFrom(event.currentTarget.value)} />
        <span>到</span>
        <input className="aps-range-input" aria-label="结束页" value={to} onChange={(event) => setTo(event.currentTarget.value)} />
        <span>页里找（全书 {props.pageCount} 页）</span>
        <button type="button" className="aps-button mod-cta" onClick={() => void preview()} disabled={busy}>预览</button>
      </div>
      {busy || !plan ? (
        <p className="aps-muted">正在读 PDF 文字层……</p>
      ) : (
        <div className="aps-pagemark-result">
          <div className="aps-pagemark-report">
            <p>
              把握报告：可插 {plan.proposals.length} 页（高 {count("high")}、中 {count("medium")}、低 {count("low")}）；已有锚点 {plan.existing.length} 页；
              找不到 {plan.missing.length} 页；无文字层 {plan.empty.length} 页。低把握的默认不勾。
            </p>
            {plan.missing.length ? <p className="aps-muted">找不到：第 {plan.missing.join("、")} 页</p> : null}
            {plan.empty.length ? <p className="aps-muted">无文字层或空白：第 {plan.empty.join("、")} 页</p> : null}
          </div>
          <table className="aps-pagemark-table">
            <thead>
              <tr>
                {["写入", "页", "位置", "把握", "相似度", "插入点"].map((title) => <th key={title}>{title}</th>)}
              </tr>
            </thead>
            <tbody>
              {plan.proposals.map((proposal) => (
                <tr key={proposal.page} className={`aps-confidence-${proposal.confidence}`}>
                  <td>
                    <Check
                      checked={selected.has(proposal.page)}
                      label={`写入第 ${proposal.page} 页`}
                      onChange={(value) => setSelected((old) => {
                        const next = new Set(old);
                        if (value) next.add(proposal.page);
                        else next.delete(proposal.page);
                        return next;
                      })}
                    />
                  </td>
                  <td>{proposal.page}</td>
                  <td>{PLACEMENT_LABEL[proposal.placement]}</td>
                  <td>{CONFIDENCE_LABEL[proposal.confidence]}</td>
                  <td>{proposal.similarity.toFixed(2)}</td>
                  <td className="aps-snippet">
                    <span>…{proposal.before}</span>
                    <span className="aps-caret">▍</span>
                    <span>{proposal.after}…</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="aps-dialog-buttons">
            <Dialog.Close className="aps-button">取消</Dialog.Close>
            <button
              type="button"
              className="aps-button mod-cta"
              disabled={!plan.proposals.length}
              onClick={() => {
                const chosen = plan.proposals.filter((proposal) => selected.has(proposal.page));
                props.onClose();
                if (chosen.length) void props.write(chosen);
              }}
            >
              写入勾选的页
            </button>
          </div>
        </div>
      )}
    </Shell>
  );
}
