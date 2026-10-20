/**
 * 繁简通搜的查找条：输入框、命中数、上一个 / 下一个、关闭。插件与网页共用，不碰 Obsidian。
 * 宿主只给两样：search（查，返回命中）与 reveal（跳到某处命中并高亮）。命中的状态都在这里。
 *
 *   [ 災異            ]  第 3 / 17 处  ‹  ›  ×
 *
 * Enter 下一个（查询改了就重新查），Shift+Enter 上一个，Esc 关闭。
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { PdfHit } from "../core/pdf-search";

export interface FindResult {
  hits: PdfHit[];
  /** 全书文字层一个字都没有（扫描件）：明说，不假装没找到 */
  noTextLayer: boolean;
}

export interface FindBarProps {
  initialQuery?: string;
  /** 查；onProgress 报告读文字层的进度（第一次查时要逐页读） */
  search: (query: string, onProgress: (done: number, total: number) => void) => Promise<FindResult>;
  /** 跳到这处命中并高亮 */
  reveal: (hit: PdfHit) => void;
  onClose: () => void;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading"; done: number; total: number }
  | { kind: "done"; query: string; hits: PdfHit[]; index: number }
  | { kind: "noText" };

export function FindBar(props: FindBarProps): ReactElement {
  const [query, setQuery] = useState(props.initialQuery ?? "");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const input = useRef<HTMLInputElement>(null);
  const run = useRef(0);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const go = (hits: PdfHit[], index: number, searched: string) => {
    setStatus({ kind: "done", query: searched, hits, index });
    if (hits.length) props.reveal(hits[index]);
  };

  const submit = async (backward: boolean) => {
    const text = query.trim();
    if (!text) return;
    if (status.kind === "done" && status.query === text) {
      if (!status.hits.length) return;
      const next = (status.index + (backward ? -1 : 1) + status.hits.length) % status.hits.length;
      go(status.hits, next, text);
      return;
    }
    const id = (run.current += 1);
    const result = await props.search(text, (done, total) => {
      if (run.current === id && done < total) setStatus({ kind: "loading", done, total });
    });
    if (run.current !== id) return;
    if (result.noTextLayer) setStatus({ kind: "noText" });
    else go(result.hits, backward ? Math.max(0, result.hits.length - 1) : 0, text);
  };

  const done = status.kind === "done" ? status : null;
  const label =
    status.kind === "loading" ? `读取文字层 ${status.done}/${status.total} 页…`
      : status.kind === "noText" ? "这份 PDF 没有文字层，搜不了"
        : done ? (done.hits.length ? `第 ${done.index + 1} / ${done.hits.length} 处` : "没有找到")
          : "繁简、异体都算同一个字";

  return (
    <div className="aps-find" role="search" aria-label="繁简通搜">
      <input
        ref={input}
        className="aps-find-input"
        type="search"
        aria-label="在 PDF 里搜（繁简通搜）"
        placeholder="在 PDF 里搜"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submit(event.shiftKey);
          } else if (event.key === "Escape") {
            event.preventDefault();
            props.onClose();
          }
        }}
      />
      <span className={`aps-find-count${done && !done.hits.length || status.kind === "noText" ? " aps-find-miss" : ""}`} aria-live="polite">
        {label}
      </span>
      <button type="button" className="aps-ib" aria-label="上一个" disabled={!done?.hits.length} onClick={() => void submit(true)}>‹</button>
      <button type="button" className="aps-ib" aria-label="下一个" disabled={!done?.hits.length} onClick={() => void submit(false)}>›</button>
      <button type="button" className="aps-ib" aria-label="关闭查找" onClick={props.onClose}>×</button>
    </div>
  );
}
