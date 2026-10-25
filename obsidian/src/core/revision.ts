/**
 * 「复制本页修订请求」：拼一段可直接粘给 Claude Code（book2md1012）的文字。
 * 路径给绝对路径，AI 不用先找库在哪；正文只给本页开头与结尾，免得粘一大段。
 */
import { stripAnchors } from "./anchors";

export interface RevisionRequest {
  /** 笔记的绝对路径（拿不到时给库内路径） */
  notePath: string;
  pdfPath: string;
  page: number;
  printed: string | null;
  /** 本页锚点段原文 */
  segment: string;
  /** 选中的文字（可空） */
  selection?: string;
}

function headTail(segment: string, size = 30): { head: string; tail: string } {
  const plain = stripAnchors(segment).replace(/\s+/g, " ").trim();
  if (plain.length <= size * 2) return { head: plain, tail: "" };
  return { head: plain.slice(0, size), tail: plain.slice(-size) };
}

export function buildRevisionRequest(request: RevisionRequest): string {
  const { head, tail } = headTail(request.segment);
  const printed = request.printed ? `（印刷页 p.${request.printed}）` : "";
  const lines = [
    `请用 book2md1012 按原页修订：PDF 第 ${request.page} 页${printed}。`,
    `- 笔记：${request.notePath}`,
    `- PDF：${request.pdfPath}`,
    `- 锚点：<!--pdf-page.${request.page}-->`,
    `- 本页开头：${head}`
  ];
  if (tail) lines.push(`- 本页结尾：${tail}`);
  if (request.selection?.trim()) lines.push(`- 选中的文字：${request.selection.trim()}`);
  lines.push("- 问题：（在这里写哪里丢了、错了；没写就请对照原页通查本页）");
  return lines.join("\n");
}
