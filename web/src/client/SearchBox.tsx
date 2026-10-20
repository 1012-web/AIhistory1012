"use client";
/**
 * 顶栏的全文搜索框。交互照 Collatio：Ctrl/⌘ + K 聚焦；输入停 120 毫秒后搜；↑ ↓ 选、Enter 定位、Esc 关。
 * 结果分「正文」「PDF」两种来源，按页排；点一条，两边一起跳过去并高亮。
 */
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { markdownDoc, pdfDoc, searchDocs, type SearchDoc, type SearchHit } from "./search";

interface Props {
  /** Markdown 文件：路径 → 正文；变了就重建索引 */
  markdown: Array<{ path: string; text: string }>;
  pageCount: number;
  pageText: (page: number) => Promise<string>;
  /** PDF 换了时变，PDF 文字层要重取 */
  pdfKey: string;
  onChoose: (hit: SearchHit) => void;
}

export function SearchBox({ markdown, pageCount, pageText, pdfKey, onChoose }: Props) {
  const [value, setValue] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [pdfDocs, setPdfDocs] = useState<SearchDoc[]>([]);
  const [indexing, setIndexing] = useState<{ done: number; total: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setQuery(value.trim()), 120);
    return () => clearTimeout(id);
  }, [value]);
  useEffect(() => setCursor(0), [query]);

  // 第一次搜时才取 PDF 文字层（逐页，边取边能搜）；PDF 换了重取
  const wanted = !!query;
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (wanted) setArmed(true);
  }, [wanted]);
  useEffect(() => {
    if (!armed || !pageCount) return;
    let cancelled = false;
    setPdfDocs([]);
    void (async () => {
      const out: SearchDoc[] = [];
      for (let page = 1; page <= pageCount && !cancelled; page += 1) {
        out.push(pdfDoc(page, await pageText(page)));
        if (cancelled) return;
        if (page % 8 === 0 || page === pageCount) {
          setPdfDocs([...out]);
          setIndexing(page === pageCount ? null : { done: page, total: pageCount });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [armed, pageCount, pdfKey, pageText]);

  const mdDocs = useMemo(() => markdown.map((item) => markdownDoc(item.path, item.text)), [markdown]);
  const result = useMemo(() => searchDocs([...mdDocs, ...pdfDocs], query), [mdDocs, pdfDocs, query]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
        input.current?.focus();
        input.current?.select();
      }
    };
    const close = (event: PointerEvent) => {
      if (!holder.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", key);
    document.addEventListener("pointerdown", close);
    return () => {
      window.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", close);
    };
  }, []);

  const choose = (hit: SearchHit | undefined) => {
    if (!hit) return;
    setOpen(false);
    input.current?.blur();
    onChoose(hit);
  };

  const mdCount = result.hits.filter((hit) => hit.source === "md").length;
  const showList = open && !!query;

  return (
    <div className="aih-search" ref={holder}>
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          choose(result.hits[Math.min(cursor, result.hits.length - 1)]);
        }}
      >
        <input
          ref={input}
          className="aih-search-input"
          aria-label="搜索正文与 PDF"
          placeholder="搜索正文与 PDF…"
          autoComplete="off"
          value={value}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setValue(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              input.current?.blur();
            } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && result.hits.length) {
              event.preventDefault();
              setCursor((i) => (i + (event.key === "ArrowDown" ? 1 : -1) + result.hits.length) % result.hits.length);
            }
          }}
        />
        {!value && <kbd className="aih-kbd">Ctrl K</kbd>}
      </form>
      <AnimatePresence>
        {showList && (
          <motion.div
            className="aih-search-results"
            role="listbox"
            data-testid="search-results"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.14 }}
          >
            <div className="aih-search-summary">
              {result.total ? `共 ${result.total} 处：正文 ${mdCount}、PDF ${result.hits.length - mdCount}${result.total > result.hits.length ? `（只列前 ${result.hits.length} 条）` : ""}` : "没有找到"}
              {indexing && <span className="aih-muted">　PDF 文字层读取中 {indexing.done}/{indexing.total}</span>}
            </div>
            {result.hits.map((hit, index) => (
              <button
                key={hit.key}
                type="button"
                role="option"
                aria-selected={index === cursor}
                className="aih-search-hit"
                onMouseEnter={() => setCursor(index)}
                onClick={() => choose(hit)}
              >
                <span className={`aih-badge aih-badge-${hit.source}`}>{hit.source === "md" ? "正文" : "PDF"}</span>
                <span className="aih-hit-page">
                  {hit.page}
                  {hit.printed ? ` · p.${hit.printed}` : ""}
                </span>
                <span className="aih-hit-text">
                  {hit.before}
                  <mark>{hit.match}</mark>
                  {hit.after}
                </span>
                {hit.path && <span className="aih-hit-file">{hit.path.replace(/\.md$/, "")}</span>}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
