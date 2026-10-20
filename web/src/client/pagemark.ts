/**
 * 补页码锚点的两道把关（算法本身用 S3 的 core/pagemarks.ts）：
 *   1. 文字层：抽样几页，几乎没有字就判定为没有文字层（扫描件），不硬做，交给用户；
 *   2. 写入前核对：新文本去掉锚点后与原文逐字相同、锚点正好多了勾选的那几个——只插锚点、不改正文、已有锚点不动。
 * 程序只做确定的事：任一道不过就明说原因，不写。
 */
import { applyPagemarks, type PagemarkProposal } from "@/s3/core";

/** 一页里「算有字」的最少字数（去掉空白后） */
const MIN_CHARS = 20;

export interface TextLayerCheck {
  ok: boolean;
  /** 抽到的页与各页字数 */
  sampled: Array<[number, number]>;
}

/** 在 [from, to] 里均匀抽至多 6 页看文字层 */
export async function checkTextLayer(from: number, to: number, pageText: (page: number) => Promise<string>): Promise<TextLayerCheck> {
  const pages = new Set<number>();
  const span = Math.max(0, to - from);
  for (let i = 0; i < 6; i += 1) pages.add(from + Math.round((span * i) / 5));
  const sampled: Array<[number, number]> = [];
  for (const page of [...pages].sort((a, b) => a - b)) sampled.push([page, (await pageText(page)).replace(/\s+/g, "").length]);
  return { ok: sampled.some(([, count]) => count >= MIN_CHARS), sampled };
}

const ANCHOR_WITH_GAP_RE = /<!--\s*pdf-page\.\d+\s*-->(?:\n\n)?/g;
const ANCHOR_RE = /<!--\s*pdf-page\.\d+\s*-->/g;

export type ApplyResult = { ok: true; text: string } | { ok: false; reason: string };

export function applyChecked(original: string, proposals: PagemarkProposal[]): ApplyResult {
  const text = applyPagemarks(original, proposals);
  const before = original.match(ANCHOR_RE)?.length ?? 0;
  const after = text.match(ANCHOR_RE)?.length ?? 0;
  if (after - before !== proposals.length) return { ok: false, reason: `应插 ${proposals.length} 个锚点，实际多出 ${after - before} 个` };
  if (text.replace(ANCHOR_WITH_GAP_RE, "") !== original.replace(ANCHOR_WITH_GAP_RE, "")) return { ok: false, reason: "去掉锚点后与原文不一致（会改动正文）" };
  return { ok: true, text };
}
