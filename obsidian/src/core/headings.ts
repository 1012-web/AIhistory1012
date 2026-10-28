/**
 * 标题：工具条显示当前位置的多级标题（面包屑），点开是可点选的多级标题菜单。代码块里的 `#` 不算。
 * 上下级按 `#` 的个数排：某个标题的上级 = 它前面最近的、`#` 更少的那个（跳级也照此挂，如 `#` 下直接 `###`）。
 */
import { frontmatterLength } from "./anchors";

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/;

export interface Heading {
  level: number;
  text: string;
  offset: number;
}

/** 标题里显示用不着的记号：HTML 注释、脚注引用（含 `^{[^1]}` 写法）、内部链接与链接、粗体与高亮的记号 */
function plainHeading(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\^\{\s*\[\^[^\]]*\]\s*\}/g, "")
    .replace(/\[\^[^\]]*\]/g, "")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|==|~~/g, "")
    .trim();
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
      if (match) out.push({ level: match[1].length, text: plainHeading(match[2]), offset });
    }
    offset += line.length + 1;
  }
  return out;
}

/** offset 之前（含所在行）最近的标题在 list 里的序号；没有返回 -1 */
export function headingIndexBefore(list: Heading[], offset: number): number {
  let low = 0;
  let high = list.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (list[mid].offset <= offset) {
      found = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return found;
}

/** 标题的上下级：每个标题的上级序号（没有为 -1）、各自的下级、最上一级 */
export interface Outline {
  parents: number[];
  children: number[][];
  roots: number[];
}

export function outline(list: Heading[]): Outline {
  const parents: number[] = [];
  const children: number[][] = list.map(() => []);
  const roots: number[] = [];
  const stack: number[] = [];
  list.forEach((heading, index) => {
    while (stack.length && list[stack[stack.length - 1]].level >= heading.level) stack.pop();
    const parent = stack.length ? stack[stack.length - 1] : -1;
    parents.push(parent);
    if (parent === -1) roots.push(index);
    else children[parent].push(index);
    stack.push(index);
  });
  return { parents, children, roots };
}

/** 从最上一级到 index 自己的一串序号；index 为 -1 时为空 */
export function headingPath(tree: Outline, index: number): number[] {
  const path: number[] = [];
  for (let at = index; at >= 0; at = tree.parents[at] ?? -1) path.unshift(at);
  return path;
}

/** 与 index 同一级、同一上级的那一组（含它自己）；index 为 -1 时是最上一级 */
export function siblingsOf(tree: Outline, index: number): number[] {
  const parent = index >= 0 ? tree.parents[index] : -1;
  return parent === -1 ? tree.roots : tree.children[parent];
}
