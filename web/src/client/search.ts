/**
 * 全文搜索：同时搜书里的 Markdown 与 PDF 文字层。
 * 做法参考 Collatio（HongdongLee/obsidian-pdf-collation 的 web-demo/src/search.js，MIT）：逐字用 normalizeText 归一化
 * （抹平标点、全半角、空格），记下每个归一化字符在原文里的位置，命中后据此截原文片段。
 * 本版的改动：Markdown 按文件整篇建索引，命中后用锚点算页；锚点、脚注引用、Markdown 记号先用空格盖掉，保住位置不变。
 */
import { normalizeText, pageAtOffset, parsedText, type SelectionContext } from "@/s3/core";

export interface SearchDoc {
  source: "md" | "pdf";
  /** Markdown 的文件路径；PDF 为 null */
  path: string | null;
  /** PDF 的页；Markdown 命中后再算 */
  page: number | null;
  text: string;
  normalized: string;
  offsets: number[];
}

export interface SearchHit {
  key: string;
  source: "md" | "pdf";
  path: string | null;
  page: number;
  printed: string | null;
  start: number;
  end: number;
  match: string;
  before: string;
  after: string;
  context: SelectionContext;
}

/** 盖掉不参与搜索的记号：同长度的空格替换，原文位置不变 */
export function maskMarkup(text: string): string {
  const blank = (match: string) => " ".repeat(match.length);
  return text
    .replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?=\r?\n|$)/, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\[\^[^\]\s]+\]:?/g, blank)
    .replace(/^#{1,6}[ \t]+/gm, blank)
    .replace(/\*\*|__|~~|`/g, blank)
    .replace(/\]\([^)]*\)/g, blank);
}

export function indexText(text: string, masked = text): { normalized: string; offsets: number[] } {
  let normalized = "";
  const offsets: number[] = [];
  for (let i = 0; i < masked.length; i += 1) {
    const code = masked.charCodeAt(i);
    // 代理对（生僻字）整个取
    const ch = code >= 0xd800 && code <= 0xdbff ? masked.slice(i, i + 2) : masked[i];
    const out = ch.trim() ? normalizeText(ch) : "";
    for (const c of out) {
      normalized += c;
      offsets.push(i);
    }
    if (ch.length === 2) i += 1;
  }
  return { normalized, offsets };
}

export function markdownDoc(path: string, text: string): SearchDoc {
  return { source: "md", path, page: null, text, ...indexText(text, maskMarkup(text)) };
}

export function pdfDoc(page: number, text: string): SearchDoc {
  return { source: "pdf", path: null, page, text, ...indexText(text) };
}

function plain(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");
}

export function searchDocs(docs: SearchDoc[], query: string, limit = 200): { hits: SearchHit[]; total: number } {
  const needle = normalizeText(query.trim());
  if (!needle || needle.length > 150) return { hits: [], total: 0 };
  const hits: SearchHit[] = [];
  let total = 0;
  for (const doc of docs) {
    if (!doc.normalized) continue;
    // parsedText 认这本书的 printedPageOffset（旧格式文件按印刷页换算）
    const parsed = doc.source === "md" ? parsedText(doc.text) : null;
    for (let from = 0; from < doc.normalized.length; ) {
      const index = doc.normalized.indexOf(needle, from);
      if (index < 0) break;
      total += 1;
      if (hits.length < limit) {
        const start = doc.offsets[index] ?? 0;
        const end = (doc.offsets[index + needle.length - 1] ?? start) + 1;
        let page = doc.page ?? 1;
        let printed: string | null = null;
        let progress = index / Math.max(1, doc.normalized.length);
        if (parsed) {
          const at = pageAtOffset(doc.text, start, parsed.anchors, parsed.segments);
          if (at) {
            page = at.page;
            printed = at.printed;
            progress = at.to > at.from ? (start - at.from) / (at.to - at.from) : 0;
          }
        }
        hits.push({
          key: `${doc.source}-${doc.path ?? ""}-${doc.page ?? ""}-${index}`,
          source: doc.source,
          path: doc.path,
          page,
          printed,
          start,
          end,
          match: doc.text.slice(start, end),
          before: plain(doc.text.slice(Math.max(0, start - 40), start)).slice(-24),
          after: plain(doc.text.slice(end, end + 50)).slice(0, 32),
          context: {
            before: plain(doc.text.slice(Math.max(0, start - 80), start)),
            after: plain(doc.text.slice(end, end + 80)),
            progress,
          },
        });
      }
      from = index + Math.max(needle.length, 1);
    }
  }
  hits.sort((a, b) => a.page - b.page || (a.source === b.source ? a.start - b.start : a.source === "md" ? -1 : 1));
  return { hits, total };
}
