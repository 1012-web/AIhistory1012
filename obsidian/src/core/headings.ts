/**
 * 章名：某个位置之前最近的一个 Markdown 标题（工具条显示用）。代码块里的 `#` 不算。
 */
import { frontmatterLength } from "./anchors";

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/;

export interface Heading {
  level: number;
  text: string;
  offset: number;
}

export function headings(text: string): Heading[] {
  const out: Heading[] = [];
  let offset = 0;
  let fence: string | null = null;
  const skip = frontmatterLength(text);
  for (const line of text.split("\n")) {
    const fenceMatch = /^(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (line.startsWith(fence)) fence = null;
    } else if (!fence && offset >= skip) {
      const match = HEADING_RE.exec(line.replace(/\r$/, ""));
      if (match) out.push({ level: match[1].length, text: match[2].replace(/<!--[\s\S]*?-->/g, "").trim(), offset });
    }
    offset += line.length + 1;
  }
  return out;
}

/** offset 之前（含所在行）最近的标题；没有返回 null */
export function headingBefore(text: string, offset: number, list: Heading[] = headings(text)): Heading | null {
  let found: Heading | null = null;
  for (const heading of list) {
    if (heading.offset > offset) break;
    found = heading;
  }
  return found;
}
