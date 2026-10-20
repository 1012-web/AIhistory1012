/**
 * 扫描书文件夹：有哪些 Markdown、哪些 PDF，book.json 说了什么，每个 Markdown 配哪个 PDF。
 *
 * 配对顺序照插件（计划「Obsidian 插件」第 1 条，S3 的 pairing.ts）：
 *   frontmatter `pdf` → `_数据/book.json` 的 `pdf` → 书文件夹里唯一的 PDF（原件与 `.文字层` 副本成对时取副本）→ 同名 PDF。
 * 书的成员：book.json 列了 files 就照它（索引文件 index 排最前），否则是配到同一个 PDF 的全部 Markdown，按文件名排。
 * linkpathOf、uniquePdf、frontmatterPdf、BookJson 与插件共用 obsidian/src/core/。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BOOK_JSON } from "./paths";

import { DATA_DIR, TEXT_LAYER_SUFFIX, frontmatterPdf, linkpathOf as linkpathOfValue, uniquePdf as uniqueByPath, type BookJson, type BookJsonFile, type PairSource } from "@plugin/src/core/index";

export { DATA_DIR, TEXT_LAYER_SUFFIX, frontmatterPdf, type BookJson, type BookJsonFile, type PairSource };

export interface MarkdownInfo {
  path: string;
  pdf: string | null;
  pdfSource: PairSource | null;
  /** frontmatter 里写的 pdf 原值（找不到文件时给用户看） */
  pdfLink: string | null;
}

export interface BookInfo {
  name: string;
  root: string;
  title: string;
  markdown: MarkdownInfo[];
  pdfs: string[];
  bookJson: BookJson | null;
  bookJsonError: string | null;
  /** 全书配对的 PDF（成员里最多的那个） */
  pdf: string | null;
  /** 按书内顺序的成员 */
  members: string[];
  printedPageOffset: number | null;
}

const SKIP_DIRS = new Set([DATA_DIR, "node_modules", ".git", ".obsidian", ".trash"]);

async function walk(root: string, rel: string, depth: number, out: string[]): Promise<void> {
  const entries = await readdir(join(root, rel), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (depth > 0 && !SKIP_DIRS.has(entry.name)) await walk(root, child, depth - 1, out);
    } else if (entry.isFile() && /\.(md|pdf)$/i.test(entry.name)) {
      out.push(child);
    }
  }
}

export function compareBookPaths(a: string, b: string): number {
  return a.localeCompare(b, "zh-Hans-CN", { numeric: true });
}

/** `[[x.pdf]]`、`[[x.pdf|别名]]`、`![[x.pdf]]`、`x.pdf` 都认 */
export function linkpathOf(value: string): string {
  return linkpathOfValue(value) ?? value.trim();
}

function base(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function dir(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

function stem(path: string): string {
  return base(path).replace(/\.[^.]+$/, "");
}

/** 按 Obsidian 的习惯解析内链：先认完整相对路径，再按文件名找，同名时取离 from 最近的 */
export function resolvePdfLink(link: string, from: string, pdfs: string[]): string | null {
  const target = linkpathOf(link).replace(/\\/g, "/").replace(/^\.\//, "");
  const withExt = /\.pdf$/i.test(target) ? target : `${target}.pdf`;
  const exact = pdfs.find((pdf) => pdf === withExt || pdf === (dir(from) ? `${dir(from)}/${withExt}` : withExt));
  if (exact) return exact;
  const byName = pdfs.filter((pdf) => base(pdf) === base(withExt));
  if (!byName.length) return null;
  const here = dir(from);
  return byName.find((pdf) => dir(pdf) === here) ?? byName.sort((a, b) => a.split("/").length - b.split("/").length)[0];
}

/** 一组 PDF 里挑「唯一」的那份；原件与文字层副本成对时取副本 */
export function uniquePdf(pdfs: string[]): string | null {
  return uniqueByPath(pdfs, (pdf) => pdf);
}

export function bookJsonPaths(book: BookJson | null): string[] {
  const out: string[] = [];
  for (const item of book?.files ?? []) {
    const path = typeof item === "string" ? item : item?.path;
    if (typeof path === "string" && path) out.push(path.replace(/\\/g, "/").replace(/^\.\//, ""));
  }
  return out;
}

export function pairMarkdown(path: string, text: string, pdfs: string[], bookJson: BookJson | null): MarkdownInfo {
  const link = frontmatterPdf(text);
  if (link) {
    const pdf = resolvePdfLink(link, path, pdfs);
    if (pdf) return { path, pdf, pdfSource: "frontmatter", pdfLink: link };
  }
  if (bookJson?.pdf) {
    const pdf = resolvePdfLink(bookJson.pdf, "", pdfs);
    if (pdf) return { path, pdf, pdfSource: "book.json", pdfLink: link };
  }
  const local = uniquePdf(pdfs.filter((pdf) => dir(pdf) === dir(path))) ?? uniquePdf(pdfs);
  if (local) return { path, pdf: local, pdfSource: "folder", pdfLink: link };
  const same = pdfs.find((pdf) => stem(pdf) === stem(path));
  if (same) return { path, pdf: same, pdfSource: "same-name", pdfLink: link };
  return { path, pdf: null, pdfSource: null, pdfLink: link };
}

export async function scanBook(root: string): Promise<BookInfo> {
  const found: string[] = [];
  await walk(root, "", 2, found);
  const pdfs = found.filter((path) => /\.pdf$/i.test(path)).sort(compareBookPaths);
  const mdPaths = found.filter((path) => /\.md$/i.test(path)).sort(compareBookPaths);

  let bookJson: BookJson | null = null;
  let bookJsonError: string | null = null;
  try {
    bookJson = JSON.parse(await readFile(join(root, ...BOOK_JSON.split("/")), "utf8")) as BookJson;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") bookJsonError = `book.json 读不出来：${(error as Error).message}`;
  }

  const markdown = await Promise.all(
    mdPaths.map(async (path) => pairMarkdown(path, await readFile(join(root, ...path.split("/")), "utf8"), pdfs, bookJson))
  );

  const votes = new Map<string, number>();
  for (const item of markdown) if (item.pdf) votes.set(item.pdf, (votes.get(item.pdf) ?? 0) + 1);
  const bookPdf = (bookJson?.pdf && resolvePdfLink(bookJson.pdf, "", pdfs)) || [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const listed = bookJsonPaths(bookJson).filter((path) => mdPaths.includes(path));
  let members: string[];
  if (listed.length) {
    const index = bookJson?.indexNote && mdPaths.includes(bookJson.indexNote) && !listed.includes(bookJson.indexNote) ? [bookJson.indexNote] : [];
    members = [...index, ...listed];
  } else {
    members = markdown.filter((item) => item.pdf && item.pdf === bookPdf).map((item) => item.path);
  }

  const name = base(root.replace(/\\/g, "/").replace(/\/+$/, ""));
  return {
    name,
    root,
    title: bookJson?.title ?? name,
    markdown,
    pdfs,
    bookJson,
    bookJsonError,
    pdf: bookPdf,
    members,
    printedPageOffset: typeof bookJson?.printedPageOffset === "number" ? bookJson.printedPageOffset : null,
  };
}
