/**
 * 判字面板：一次看一条疑字（截图、前后文、各家读法），点读法或按数字键定字，S 存疑，←/→ 换条。
 * 不碰 Obsidian：条目、截图地址、跳转与写回都由宿主（suspect-view）经 props 注入。
 */
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { CheckRow } from "./controls";
import { SPRING } from "./motion";

export type SuspectCardState = "open" | "done" | "doubt";

export interface SuspectCard {
  key: string;
  id: string | null;
  page: number | null;
  kind: string;
  before: string;
  current: string;
  after: string;
  readings: Array<{ source: string; text: string }>;
  note: string;
  /** 截图的可显示地址（宿主换算好） */
  image: string | null;
  state: SuspectCardState;
  chosen: string | null;
}

export interface SuspectPanelProps {
  /** 清单文件名；没有清单时为 null */
  title: string | null;
  cards: SuspectCard[];
  /** 外部要求看哪一条（正文悬停卡片里点「在面板里看」） */
  focusKey: string | null;
  focusSerial: number;
  reducedMotion: boolean;
  onReveal: (key: string) => void;
  onChoose: (key: string, text: string) => Promise<boolean>;
  onDoubt: (key: string) => Promise<boolean>;
  /** 撤回判定或存疑：正文改回现字，清单回到没判，校注删掉这一行 */
  onWithdraw: (key: string) => Promise<boolean>;
  onOpenList: () => void;
  /** 在新标签页里打开这一条的截图原图 */
  onOpenImage: (key: string) => void;
}

const STATE_LABEL: Record<SuspectCardState, string> = { open: "未判", done: "已判", doubt: "存疑" };

function showText(text: string): string {
  return text === "" ? "∅" : text;
}

/** 下一条没判的（不含存疑），从 key 之后找，到尾绕回 */
function nextOpenKey(cards: SuspectCard[], key: string | null): string | null {
  const start = cards.findIndex((card) => card.key === key);
  for (let step = 1; step <= cards.length; step += 1) {
    const card = cards[(start + step + cards.length) % cards.length];
    if (card.state === "open") return card.key;
  }
  return null;
}

export function SuspectPanel(props: SuspectPanelProps): ReactElement {
  const { cards } = props;
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const revealed = useRef<string | null>(null);

  const visible = useMemo(() => (onlyOpen ? cards.filter((card) => card.state !== "done" || card.key === selected) : cards), [cards, onlyOpen, selected]);
  const card = cards.find((candidate) => candidate.key === selected) ?? null;
  const counts = useMemo(() => ({
    done: cards.filter((item) => item.state === "done").length,
    doubt: cards.filter((item) => item.state === "doubt").length
  }), [cards]);

  // 头一次有条目、或选中的那条没了：选第一条没判的
  useEffect(() => {
    if (selected && cards.some((item) => item.key === selected)) return;
    setSelected(nextOpenKey(cards, null) ?? cards[0]?.key ?? null);
  }, [cards, selected]);

  // 外部点名要看某一条（从正文的悬停卡片来：人已经在那一处，不再跳）
  useEffect(() => {
    if (props.focusKey && cards.some((item) => item.key === props.focusKey)) {
      revealed.current = props.focusKey;
      setSelected(props.focusKey);
      setCustom("");
      rootRef.current?.focus({ preventScroll: true });
    }
  }, [props.focusKey, props.focusSerial]);

  // 换了一条：跳到原页、正文选中，焦点留在面板（好继续按键）
  useEffect(() => {
    if (!selected || revealed.current === selected) return;
    revealed.current = selected;
    setCustom("");
    props.onReveal(selected);
    rootRef.current?.focus({ preventScroll: true });
  }, [selected]);

  const move = (delta: number) => {
    if (!visible.length) return;
    const at = visible.findIndex((item) => item.key === selected);
    const next = visible[(at + delta + visible.length) % visible.length];
    setSelected(next.key);
  };

  const settle = async (run: () => Promise<boolean>) => {
    if (!card || busy) return;
    setBusy(true);
    const key = card.key;
    try {
      if (await run()) {
        // 写回后宿主会刷新条目：按刷新前的顺序找下一条没判的
        const next = nextOpenKey(cards, key);
        if (next && next !== key) setSelected(next);
      }
    } finally {
      setBusy(false);
      rootRef.current?.focus({ preventScroll: true });
    }
  };
  const choose = (text: string) => settle(() => props.onChoose(card!.key, text));
  const doubt = () => settle(() => props.onDoubt(card!.key));
  // 撤回后留在这一条（不跳下一条），好接着重判
  const withdraw = async () => {
    if (!card || busy || card.state === "open") return;
    setBusy(true);
    try {
      await props.onWithdraw(card.key);
    } finally {
      setBusy(false);
      rootRef.current?.focus({ preventScroll: true });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement || event.ctrlKey || event.metaKey || event.altKey) return;
    const digit = /^[1-9]$/.test(event.key) ? Number(event.key) : 0;
    if (digit && card && digit <= card.readings.length) {
      event.preventDefault();
      void choose(card.readings[digit - 1].text);
    } else if (event.key === "u" || event.key === "U") {
      event.preventDefault();
      void withdraw();
    } else if (event.key === "s" || event.key === "S") {
      event.preventDefault();
      void doubt();
    } else if (event.key === "ArrowRight" || event.key === "j") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowLeft" || event.key === "k") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "f" || event.key === "/") {
      event.preventDefault();
      inputRef.current?.focus();
    } else if (event.key === "Enter" && card) {
      event.preventDefault();
      props.onReveal(card.key);
    }
  };

  if (props.title === null) {
    return (
      <div className="aps-suspects aps-suspects-empty">
        <p>当前这本书没有疑字清单。</p>
        <p className="aps-muted">打开一本配了 PDF、带「书名.疑字清单.md」的书，这里会列出待判的疑字。</p>
      </div>
    );
  }

  return (
    <MotionConfig reducedMotion={props.reducedMotion ? "always" : "user"}>
      <div className="aps-suspects" ref={rootRef} tabIndex={0} onKeyDown={onKeyDown} aria-label="判字面板">
        <div className="aps-suspects-head">
          <div className="aps-suspects-title">
            <button type="button" className="aps-link-button" onClick={props.onOpenList} title="打开疑字清单">{props.title}</button>
          </div>
          <span className="aps-suspects-focus" aria-hidden="true">按键在面板里</span>
          <div className="aps-suspects-count">已判 {counts.done} / 共 {cards.length}{counts.doubt ? ` · 存疑 ${counts.doubt}` : ""}</div>
          <CheckRow checked={onlyOpen} onChange={setOnlyOpen} label="只看没判的" />
        </div>

        {card ? (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={card.key}
              className="aps-suspect-card"
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              transition={SPRING}
            >
              <div className="aps-suspect-meta">
                <span>{[card.id, card.kind, card.page ? `PDF 第 ${card.page} 页` : null].filter(Boolean).join(" · ")}</span>
                <span className={`aps-suspect-state is-${card.state}`}>{STATE_LABEL[card.state]}{card.state === "done" && card.chosen !== null ? `：${showText(card.chosen)}` : ""}</span>
              </div>
              {card.image ? (
                // 截图是一整行的长条（右端是放大的疑字与各家读法）：按可读的高度显示、可横向拖动，先停在右端；点了开原图
                <div className="aps-suspect-strip" title="点开看原图；左右拖动看整行">
                  <img
                    src={card.image}
                    alt={`${card.id ?? "疑字"}的原页截图`}
                    onLoad={(event) => {
                      const strip = event.currentTarget.parentElement;
                      if (strip) strip.scrollLeft = strip.scrollWidth;
                    }}
                    onClick={() => props.onOpenImage(card.key)}
                  />
                </div>
              ) : null}
              <p className="aps-suspect-context">
                {card.before}<mark>{showText(card.current)}</mark>{card.after}
              </p>
              {card.note ? <p className="aps-muted aps-suspect-note">{card.note}</p> : null}
              <div className="aps-suspect-readings" role="group" aria-label="候选读法">
                {card.readings.map((reading, index) => (
                  <button
                    key={`${reading.source}-${reading.text}`}
                    type="button"
                    className={`aps-suspect-reading${card.state === "done" && card.chosen === reading.text ? " is-chosen" : ""}`}
                    disabled={busy}
                    onClick={() => void choose(reading.text)}
                  >
                    <kbd>{index + 1}</kbd>
                    <span className="aps-suspect-source">{reading.source}</span>
                    <span className="aps-suspect-glyph">{showText(reading.text)}</span>
                  </button>
                ))}
              </div>
              <form
                className="aps-suspect-custom"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (custom.trim()) void choose(custom.trim());
                }}
              >
                <input
                  ref={inputRef}
                  value={custom}
                  placeholder="自填（F）"
                  aria-label="自填读法"
                  onChange={(event) => setCustom(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") rootRef.current?.focus();
                  }}
                />
                <button type="submit" disabled={busy || !custom.trim()}>定作</button>
              </form>
              <div className="aps-suspect-actions">
                <button type="button" disabled={busy} onClick={() => void doubt()}><kbd>S</kbd> 存疑</button>
                {card.state !== "open" ? <button type="button" disabled={busy} onClick={() => void withdraw()}><kbd>U</kbd> 撤回</button> : null}
                <span className="aps-spacer" />
                <button type="button" onClick={() => move(-1)} aria-label="上一条">◀</button>
                <button type="button" onClick={() => move(1)} aria-label="下一条">▶</button>
              </div>
            </motion.div>
          </AnimatePresence>
        ) : (
          <p className="aps-muted">{cards.length ? "都判完了。" : "清单里没有条目。"}</p>
        )}

        <p className="aps-hint aps-suspects-keys">数字键选读法 · F 自填 · S 存疑 · U 撤回 · ←/→ 换条 · 回车重新跳到原页。按键只在面板有焦点时（标题旁显示「按键在面板里」）才起作用</p>

        <ol className="aps-suspects-list">
          {visible.map((item) => (
            <li key={item.key}>
              <button type="button" className={`aps-suspects-row${item.key === selected ? " is-selected" : ""} is-${item.state}`} onClick={() => setSelected(item.key)}>
                <span className="aps-suspects-row-id">{item.id ?? "—"}</span>
                <span className="aps-suspects-row-text">{item.before.slice(-4)}<mark>{showText(item.current)}</mark>{item.after.slice(0, 4)}</span>
                <span className="aps-suspects-row-page">{item.page ?? ""}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </MotionConfig>
  );
}
