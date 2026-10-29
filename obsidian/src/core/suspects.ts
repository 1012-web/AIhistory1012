/**
 * 判字：读疑字清单、在正文里找到每一条、用户判定后改写正文、清单与校注。不碰 Obsidian，纯文本进、纯文本出。
 *
 * 清单条目（book2md1012 生成；约定里只有链接一项，其余按现行写法尽量读，读不出就只剩「现字」与自填）：
 *   - [ ] `C00012` [PDF 第 5 页](obsidian://aihistory-pdf-sync?…) · 字 · 前文【现字】后文 ／ VL 作【读法】（说明）
 *     ![[书/_数据/疑字图/C00012.png]]
 * 判定后：勾上，行尾补「 · 判定作【X】（日期）」；存疑不勾，行尾补「 · 存疑（日期）」。
 */
import { footnotesForPage, segmentForPage, type Anchor, type PageSegment } from "./anchors";
import { locateSuspect, parseSuspectLink, uriParams, type SuspectLink } from "./link";

/** 清单里「漏读」的记号 */
export const EMPTY_MARK = "∅";

export type SuspectState = "open" | "done" | "doubt";

export interface Reading {
  /** 读法出处：「现字」或清单写的识别家名（VL……） */
  source: string;
  /** 读法；空串表示这一家没读出字（清单写作 ∅） */
  text: string;
}

export interface SuspectItem {
  /** 清单里的编号（如 C00012）；没有编号时为 null */
  id: string | null;
  /** 条目所在行（0 起），只在刚解析出的这份清单里有效 */
  line: number;
  /** 条目首行原文：写回时据此确认没认错行 */
  raw: string;
  state: SuspectState;
  link: SuspectLink;
  /** 「字」「标点」…… */
  kind: string;
  /** 清单展示的前文、现字、后文；读不出时为 null */
  display: { before: string; current: string; after: string } | null;
  /** 候选读法：第一项总是正文现字，其后按清单顺序，去重 */
  readings: Reading[];
  note: string;
  /** 截图的库内路径（![[…]] 里的） */
  image: string | null;
  /** 已判定时定作的字 */
  chosen: string | null;
}

const ITEM_RE = /^\s*- \[([ xX])\] (.*)$/;
const LINK_RE = /\]\((obsidian:\/\/aihistory-pdf-sync\?[^)\s]+)\)/;
const IMAGE_RE = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/;
const DECIDED_RE = / · 判定作【(.*?)】（[^）]*）/;
const DOUBT_RE = / · 存疑（[^）]*）/;

function unmark(text: string): string {
  return text === EMPTY_MARK ? "" : text;
}

/** 「前文【现字】后文 ／ VL 作【读法】（说明）」→ 各部分 */
function parseBody(body: string): { display: SuspectItem["display"]; others: Reading[]; note: string } {
  const cut = body.indexOf("／");
  const shownPart = (cut === -1 ? body : body.slice(0, cut)).trim();
  const rest = cut === -1 ? "" : body.slice(cut + 1).trim();
  const match = /^(.*?)【(.*?)】(.*)$/.exec(shownPart);
  const display = match ? { before: match[1], current: unmark(match[2]), after: match[3] } : null;
  const others: Reading[] = [];
  for (const reading of rest.matchAll(/([^\s／；;，,（）()]+?)\s*作【(.*?)】/g)) others.push({ source: reading[1], text: unmark(reading[2]) });
  const note = /（([^（）]*(?:（[^（）]*）[^（）]*)*)）\s*$/.exec(rest)?.[1] ?? "";
  return { display, others, note };
}

export function parseSuspectList(text: string): SuspectItem[] {
  const lines = text.split("\n");
  const items: SuspectItem[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].replace(/\r$/, "");
    const item = ITEM_RE.exec(raw);
    const href = item && LINK_RE.exec(item[2]);
    if (!item || !href) continue;
    const link = parseSuspectLink(uriParams(href[1]));
    if (!link) continue;
    const id = /`([^`]+)`/.exec(item[2])?.[1] ?? null;
    // 链接之后：「 · 字 · 正文……」，末尾可能有判定、存疑记号
    const afterLink = item[2].slice((href.index ?? 0) + href[0].length);
    const decided = DECIDED_RE.exec(afterLink);
    const doubt = DOUBT_RE.test(afterLink);
    const tail = afterLink.replace(DECIDED_RE, "").replace(DOUBT_RE, "");
    const parts = tail.split(" · ").map((part) => part.trim()).filter(Boolean);
    const kind = parts.length > 1 ? parts[0] : "";
    const body = parts.length > 1 ? parts.slice(1).join(" · ") : parts[0] ?? "";
    const { display, others, note } = parseBody(body);
    const readings: Reading[] = [{ source: "现字", text: link.text }];
    for (const reading of others) if (!readings.some((known) => known.text === reading.text)) readings.push(reading);
    let image: string | null = null;
    for (let next = index + 1; next < lines.length && !ITEM_RE.test(lines[next]) && !/^#/.test(lines[next]); next += 1) {
      const found = IMAGE_RE.exec(lines[next]);
      if (found) {
        image = found[1].trim();
        break;
      }
    }
    const checked = item[1] !== " ";
    items.push({
      id,
      line: index,
      raw,
      state: checked ? "done" : doubt ? "doubt" : "open",
      link,
      kind,
      display,
      readings,
      note,
      image,
      chosen: decided ? unmark(decided[1]) : null
    });
  }
  return items;
}

/** 同一条：编号相同（都有编号时），否则链接参数相同 */
export function sameItem(a: SuspectItem, b: SuspectItem): boolean {
  if (a.id && b.id) return a.id === b.id && a.link.file === b.link.file;
  return a.link.file === b.link.file && a.link.page === b.link.page && a.link.text === b.link.text && a.link.ctx === b.link.ctx;
}

/** 下一条没判的（不含存疑），从 from 之后找，到尾再从头；没有返回 -1 */
export function nextOpen(items: SuspectItem[], from: number): number {
  for (let step = 1; step <= items.length; step += 1) {
    const at = (from + step + items.length) % items.length;
    if (items[at].state === "open") return at;
  }
  return -1;
}

// ---------- 在正文里找 ----------

export interface Located {
  from: number;
  to: number;
  /** 正文这里现在的字与清单记的现字一致（宽窄、兼容字形不计） */
  exact: boolean;
}

function fold(text: string): string {
  return text.normalize("NFKC");
}

/** 现字为空（正文漏了字）：在 ctx 里按清单展示的前文找插入点 */
function insertionInCtx(ctx: string, before: string): number | null {
  const tail = fold(before);
  for (let at = ctx.length; at >= 1; at -= 1) if (tail.endsWith(fold(ctx.slice(0, at)))) return at;
  return before ? null : 0;
}

function locateIn(text: string, base: number, slice: string, item: SuspectItem): Located | null {
  const { text: current, ctx } = item.link;
  if (current) {
    const found = locateSuspect(slice, current, ctx);
    if (!found) return null;
    const from = base + found[0];
    const to = base + found[1];
    return { from, to, exact: fold(text.slice(from, to)) === fold(current) };
  }
  if (!ctx || !item.display) return null;
  const at = slice.indexOf(ctx);
  const inner = insertionInCtx(ctx, item.display.before);
  if (at === -1 || inner === null || slice.indexOf(ctx, at + 1) !== -1) return null;
  return { from: base + at + inner, to: base + at + inner, exact: true };
}

/**
 * 在一个文件的全文里找这一条：先找第 page 页的正文锚点段，再找挂在这一页的脚注（注释区里带本页锚点的定义），
 * 都没有时只在 ctx 全文唯一出现的情况下认；没有页码时找全文。
 * 现字非空用链接的 text、ctx 定位；现字为空按清单展示的前文找插入点。
 */
export function locateItem(text: string, parsed: { segments: PageSegment[]; anchors: Anchor[] }, item: SuspectItem): Located | null {
  const page = item.link.page;
  if (page === null) return locateIn(text, 0, text, item);
  const segment = segmentForPage(parsed.segments, page);
  if (segment) {
    const hit = locateIn(text, segment.from, text.slice(segment.from, segment.to), item);
    if (hit?.exact) return hit;
  }
  // 脚注区间要扫全文，正文段里没找到才算
  for (const [from, to] of footnotesForPage(text, page, parsed.anchors)) {
    const hit = locateIn(text, from, text.slice(from, to), item);
    if (hit?.exact) return hit;
  }
  const ctx = item.link.ctx;
  const at = ctx ? text.indexOf(ctx) : -1;
  if (at !== -1 && text.indexOf(ctx, at + 1) === -1) {
    const hit = locateIn(text, at, ctx, item);
    if (hit) return hit;
  }
  // 都没有原样对上：退回本页段里的模糊结果（标出不一致，由用户决定）
  return segment ? locateIn(text, segment.from, text.slice(segment.from, segment.to), item) : null;
}

/**
 * 按正文「现在」的样子定位用的条目：判过并改了字的，正文里已是定作的字（清单链接记的还是原来的现字），
 * 现字与 ctx 里那一处都换成定作的字；没改过字的原样返回。重判、撤回时用。
 */
export function asNow(item: SuspectItem): SuspectItem {
  const chosen = item.chosen;
  if (item.state !== "done" || chosen === null || chosen === item.link.text) return item;
  const { text, ctx } = item.link;
  const found = text ? ctx.indexOf(text) : item.display ? insertionInCtx(ctx, item.display.before) : null;
  const at = found === null || found === -1 ? null : found;
  return {
    ...item,
    link: { ...item.link, text: chosen, ctx: at === null ? ctx : ctx.slice(0, at) + chosen + ctx.slice(at + text.length) },
    display: item.display && { ...item.display, current: chosen }
  };
}

/** 只有链接（点清单里的 obsidian:// 链接时）：同 locateItem，现字为空时没有展示上下文可用 */
export function locateLink(text: string, parsed: { segments: PageSegment[]; anchors: Anchor[] }, link: SuspectLink): Located | null {
  const item: SuspectItem = { id: null, line: 0, raw: "", state: "open", link, kind: "", display: null, readings: [], note: "", image: null, chosen: null };
  return locateItem(text, parsed, item);
}

// ---------- 写回 ----------

export function today(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shown(text: string): string {
  return text || EMPTY_MARK;
}

/**
 * 清单里这一条记上判定（chosen 为 null 表示存疑）；找不到这一条返回 null。
 * 再判一次会把旧记号换掉；存疑后又判定，存疑记号去掉。
 */
export function markInList(listText: string, item: SuspectItem, chosen: string | null, date: string): string | null {
  return rewriteListLine(listText, item, (line) => (chosen === null
    ? line.replace(/- \[[xX]\]/, "- [ ]") + ` · 存疑（${date}）`
    : line.replace(/- \[ \]/, "- [x]") + ` · 判定作【${shown(chosen)}】（${date}）`));
}

/** 撤回：这一条回到没判（去掉勾、判定与存疑记号）；找不到返回 null */
export function clearInList(listText: string, item: SuspectItem): string | null {
  return rewriteListLine(listText, item, (line) => line.replace(/- \[[xX]\]/, "- [ ]"));
}

/** 找到清单里的这一条，去掉旧记号后交给 edit 改写 */
function rewriteListLine(listText: string, item: SuspectItem, edit: (bare: string) => string): string | null {
  const lines = listText.split("\n");
  const target = parseSuspectList(listText).find((candidate) => sameItem(candidate, item));
  if (!target) return null;
  const crlf = lines[target.line].endsWith("\r");
  const line = edit(target.raw.replace(DECIDED_RE, "").replace(DOUBT_RE, ""));
  lines[target.line] = crlf ? `${line}\r` : line;
  return lines.join("\n");
}

export const NOTES_HEADING = "## 用户判定的疑字";

export interface NoteRow {
  id: string | null;
  page: number | null;
  file: string;
  from: string;
  to: string;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** 校注里补一行（「用户判定的疑字」一节，没有就在文末新开） */
export function appendNote(notesText: string, row: NoteRow): string {
  const unchanged = row.from === row.to;
  const line = `| ${cell(row.id ?? "—")} | ${row.page ? `PDF 第 ${row.page} 页` : "页码不明"}（${cell(row.file)}） | ${cell(shown(row.from))} | ${unchanged ? "（维持原字）" : cell(row.to || "（删）")} | 人工看图 |`;
  const lines = notesText.split("\n");
  const head = lines.findIndex((text) => text.trim() === NOTES_HEADING);
  if (head === -1) {
    const body = notesText.replace(/\s*$/, "");
    const block = [
      NOTES_HEADING,
      "",
      "在 Obsidian 里对照原页逐条判定的疑字（插件「判字」写入）。",
      "",
      "| 编号 | 位置 | 原字 | 改作 | 依据 |",
      "|---|---|---|---|---|",
      line
    ].join("\n");
    return `${body ? `${body}\n\n` : ""}${block}\n`;
  }
  // 本节表格的最后一行之后插入；本节还没有表格就补表头
  let end = head + 1;
  while (end < lines.length && !/^#{1,6} /.test(lines[end])) end += 1;
  let lastRow = -1;
  for (let index = head + 1; index < end; index += 1) if (lines[index].trim().startsWith("|")) lastRow = index;
  if (lastRow === -1) {
    lines.splice(head + 1, 0, "", "| 编号 | 位置 | 原字 | 改作 | 依据 |", "|---|---|---|---|---|", line);
  } else {
    lines.splice(lastRow + 1, 0, line);
  }
  return lines.join("\n");
}

/**
 * 校注「用户判定的疑字」一节里删掉这个编号的行（重判前、撤回时）；删完表里没有行了，整节去掉。
 * 没有这一节、或编号为空时原样返回。
 */
export function removeNotes(notesText: string, id: string | null): string {
  if (!id) return notesText;
  const lines = notesText.split("\n");
  const head = lines.findIndex((text) => text.trim() === NOTES_HEADING);
  if (head === -1) return notesText;
  let end = head + 1;
  while (end < lines.length && !/^#{1,6} /.test(lines[end])) end += 1;
  const isRow = (text: string) => text.trim().startsWith("|") && !/^\|\s*(编号|-)/.test(text.trim());
  const mine = (text: string) => isRow(text) && text.split("|")[1]?.trim() === id;
  const section = lines.slice(head, end).filter((text) => !mine(text));
  if (section.some(isRow)) return [...lines.slice(0, head), ...section, ...lines.slice(end)].join("\n");
  // 整节去掉，连同前面多出来的空行
  let start = head;
  while (start > 0 && lines[start - 1].trim() === "") start -= 1;
  const rest = lines.slice(end);
  const kept = [...lines.slice(0, start), ...(rest.length ? ["", ...rest] : [])].join("\n");
  return notesText.endsWith("\n") && !kept.endsWith("\n") ? `${kept}\n` : kept;
}

// 疑字清单、校注排在书文件夹最后：98-<书名>.疑字清单.md、99-<书名>.AI校注.md；0.1.5 之前的旧书不带序号（见 anchors.md 第四节）
export const LIST_SUFFIX = ".疑字清单.md";
export const NOTES_SUFFIX = ".AI校注.md";
const LIST_PREFIX = "98-";
const NOTES_PREFIX = "99-";

/** 同一文件夹里认后缀找已有的那份：带序号的优先，再按文件名；没有返回 null */
export function pickSidecar(names: string[], kind: "list" | "notes"): string | null {
  const [prefix, suffix] = kind === "list" ? [LIST_PREFIX, LIST_SUFFIX] : [NOTES_PREFIX, NOTES_SUFFIX];
  const rank = (name: string) => (name.startsWith(prefix) ? 0 : 1);
  const found = names.filter((name) => name.endsWith(suffix)).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  return found[0] ?? null;
}

/** 「98-X.疑字清单.md」「X.疑字清单.md」→「X」 */
export function bookNameOf(listName: string): string {
  const name = listName.slice(listName.lastIndexOf("/") + 1);
  return name.replace(/\.疑字清单\.md$/, "").replace(/^98-/, "");
}

/**
 * 由清单找校注：同一书文件夹里已有的 *.AI校注.md 就沿用（旧书不带序号，不另开一份）；都没有才是「99-<书名>.AI校注.md」。
 * siblings 是这个文件夹里的文件名（由宿主列出）。
 */
export function notesPathFor(listPath: string, siblings: string[]): string {
  const dir = listPath.slice(0, listPath.lastIndexOf("/") + 1);
  return dir + (pickSidecar(siblings, "notes") ?? `${NOTES_PREFIX}${bookNameOf(listPath)}${NOTES_SUFFIX}`);
}
