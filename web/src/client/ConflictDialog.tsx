"use client";
/**
 * 冲突：网页里有没存的改动时，磁盘上的文件又被改了（多半是 Claude 改的）。
 * 把两边并排显示差异（CodeMirror 官方的 @codemirror/merge），由用户选保留哪边；选之前两边都不动，绝不静默覆盖。
 */
import { Dialog } from "@base-ui/react/dialog";
import { markdown } from "@codemirror/lang-markdown";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { motion } from "motion/react";
import { useEffect, useRef } from "react";

export interface ConflictInfo {
  path: string;
  mine: string;
  disk: string;
}

interface Props {
  conflict: ConflictInfo | null;
  open: boolean;
  onKeepMine: () => void;
  onTakeDisk: () => void;
  onLater: () => void;
}

function DiffView({ mine, disk }: { mine: string; disk: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const readOnly = [EditorView.lineWrapping, EditorState.readOnly.of(true), EditorView.editable.of(false), markdown(), EditorState.phrases.of({ "$ unchanged lines": "（$ 行相同，点击展开）" })];
    const view = new MergeView({
      a: { doc: mine, extensions: readOnly },
      b: { doc: disk, extensions: readOnly },
      parent: host.current!,
      collapseUnchanged: { margin: 2, minSize: 4 },
      gutter: true,
    });
    return () => view.destroy();
  }, [mine, disk]);
  return <div ref={host} className="aih-merge" data-testid="conflict-diff" />;
}

export function ConflictDialog({ conflict, open, onKeepMine, onTakeDisk, onLater }: Props) {
  return (
    <Dialog.Root open={open && !!conflict} onOpenChange={(next) => !next && onLater()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="aps-dialog-backdrop" />
        <Dialog.Popup
          className="aps-dialog aih-conflict"
          data-testid="conflict-dialog"
          render={<motion.div initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 500, damping: 36 }} />}
        >
          <Dialog.Title className="aps-dialog-title">磁盘上的文件被改了</Dialog.Title>
          <Dialog.Description className="aih-dialog-text">
            「{conflict?.path}」在网页里有还没存的改动，同时磁盘上的这个文件也被改了（可能是 Claude 改的）。两边都还没动，请选保留哪一边。
          </Dialog.Description>
          <div className="aih-merge-heads">
            <span>网页里的（没存）</span>
            <span>磁盘上的（新）</span>
          </div>
          {conflict && <DiffView mine={conflict.mine} disk={conflict.disk} />}
          <div className="aps-dialog-buttons">
            <button type="button" className="aps-button" onClick={onLater}>
              先不处理
            </button>
            <button type="button" className="aps-button" onClick={onTakeDisk} data-testid="conflict-take-disk">
              用磁盘上的（放弃网页里的改动）
            </button>
            <button type="button" className="aps-button mod-cta" onClick={onKeepMine} data-testid="conflict-keep-mine">
              保留网页里的（覆盖磁盘）
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
