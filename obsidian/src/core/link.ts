/**
 * 疑字清单的链接：
 *   obsidian://aihistory-pdf-sync?vault=<库名>&file=<库内相对路径>&page=<N>&text=<现字>&ctx=<前后各约 6 字>
 * Obsidian 收到后把参数（已解码）交给插件；这里解析参数，并在该页锚点段里找到 text（用 ctx 消歧）。
 */
import { matchSegmentSlices } from "./collation/compare";

export const PROTOCOL_ACTION = "aihistory-pdf-sync";

export interface SuspectLink {
  file: string;
  page: number | null;
  text: string;
  ctx: string;
}

/** Obsidian 交来的参数表 → 链接；缺 file 返回 null。 */
export function parseSuspectLink(params: Record<string, string | undefined>): SuspectLink | null {
  const file = (params.file ?? "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!file) return null;
  const pageNumber = Number.parseInt(params.page ?? "", 10);
  return {
    file,
    page: Number.isFinite(pageNumber) && pageNumber >= 1 ? pageNumber : null,
    text: params.text ?? "",
    ctx: params.ctx ?? ""
  };
}

/** 完整的 URI 字符串 → 参数表（单测、命令行粘贴用；Obsidian 自己处理时用不上） */
export function uriParams(uri: string): Record<string, string> {
  const query = uri.includes("?") ? uri.slice(uri.indexOf("?") + 1) : "";
  const out: Record<string, string> = {};
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = decodeURIComponent((eq === -1 ? part : part.slice(0, eq)).replace(/\+/g, " "));
    const value = eq === -1 ? "" : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, " "));
    out[key] = value;
  }
  if (uri.startsWith("obsidian://")) out.action = uri.slice("obsidian://".length).split(/[?/]/)[0];
  return out;
}

/** 有序公共子序列长度（字数少，直接 DP） */
function lcsLength(a: string, b: string): number {
  if (!a || !b) return 0;
  const row = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = row[j];
      row[j] = a[i - 1] === b[j - 1] ? previous + 1 : Math.max(row[j], row[j - 1]);
      previous = saved;
    }
  }
  return row[b.length];
}

/**
 * 在 segment（某页锚点段的原文）里找 text，返回相对 segment 的 [from, to)。
 * ctx 可以含 text（「前文+现字+后文」），也可以只有前后文；两种写法都认。
 * 先找原样出现的位置，多处时取周围与 ctx 最像的；原样找不到再做归一化的模糊匹配（标点、全半角差异）。
 */
export function locateSuspect(segment: string, text: string, ctx: string): [number, number] | null {
  if (!text) return null;
  const hits: number[] = [];
  for (let at = segment.indexOf(text); at !== -1; at = segment.indexOf(text, at + 1)) hits.push(at);
  if (hits.length === 1) return [hits[0], hits[0] + text.length];
  if (hits.length > 1) {
    // ctx 里含 text 时，直接看 ctx 能否原样定位
    const inner = ctx.indexOf(text);
    if (inner !== -1) {
      const direct = segment.indexOf(ctx);
      if (direct !== -1) return [direct + inner, direct + inner + text.length];
    }
    const pad = Math.max(6, ctx.length);
    let best = hits[0];
    let bestScore = -1;
    for (const at of hits) {
      const window = segment.slice(Math.max(0, at - pad), at + text.length + pad);
      const score = lcsLength(ctx, window);
      if (score > bestScore) {
        bestScore = score;
        best = at;
      }
    }
    return [best, best + text.length];
  }
  const inner = ctx.indexOf(text);
  const context = inner === -1
    ? { before: ctx.slice(0, Math.ceil(ctx.length / 2)), after: ctx.slice(Math.ceil(ctx.length / 2)) }
    : { before: ctx.slice(0, inner), after: ctx.slice(inner + text.length) };
  const fuzzy = matchSegmentSlices([segment], text, context);
  const slice = fuzzy?.slices[0];
  return slice ? [slice.startOffset, slice.endOffset] : null;
}
