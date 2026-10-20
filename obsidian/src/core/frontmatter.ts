/**
 * frontmatter 的 `pdf` 字段（docs/anchors.md 第一节：`pdf: "[[文件名.pdf]]"`）：读、写、解析内链。纯文本操作。
 * 插件里写 frontmatter 由 Obsidian 的 processFrontMatter 做；网页工作台用这里的 setFrontmatterPdf。
 */

/** `[[x.pdf]]`、`[[x.pdf|别名]]`、`![[x.pdf]]`、`x.pdf` 都认；空值返回 null */
export function linkpathOf(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const match = /^!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/.exec(value.trim());
  return (match ? match[1] : value).trim();
}

/** frontmatter 里的 pdf 原值；没有 frontmatter 或没写返回 null */
export function frontmatterPdf(text: string): string | null {
  const block = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!block) return null;
  const line = /^pdf:[ \t]*(.+?)[ \t]*$/m.exec(block[1]);
  if (!line) return null;
  return line[1].replace(/^(["'])(.*)\1$/, "$2").trim() || null;
}

export function pdfLinkValue(pdfPath: string): string {
  const name = pdfPath.slice(pdfPath.lastIndexOf("/") + 1);
  return `"[[${name}]]"`;
}

/** 把 frontmatter 的 pdf 改成指向 pdfPath（没有就加，没有 frontmatter 就建） */
export function setFrontmatterPdf(text: string, pdfPath: string): string {
  const line = `pdf: ${pdfLinkValue(pdfPath)}`;
  const block = /^---\r?\n([\s\S]*?)(\r?\n)---[ \t]*(\r?\n|$)/.exec(text);
  if (!block) return `---\n${line}\n---\n\n${text}`;
  const body = block[1];
  const replaced = /^pdf:.*$/m.test(body) ? body.replace(/^pdf:.*$/m, line) : `${body}${block[2]}${line}`;
  return `---\n${replaced}${block[2]}---${block[3]}${text.slice(block[0].length)}`;
}
