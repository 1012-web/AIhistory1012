// 造演示站的书：把仓库里的公版样例书（tests/fixtures/clean/新史學，梁启超《新史學》，CC BY-SA 4.0）
// 打成一份静态数据，给 public/demo/ 用。
//
// 产物（web/.gitignore 里忽略，构建时现造）：
//   public/demo/index.json  { book: BookInfo, texts: { 文件名: 正文 } }
//   public/demo/book.pdf    样例 PDF（23 页，有文字层）
//
// 只读，不碰本机任何材料，也不联网。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(web, "..", "tests", "fixtures", "clean", "新史學");
const out = join(web, "public", "demo");

if (!existsSync(src)) {
  console.error(`找不到样例书：${src}`);
  process.exit(1);
}

const bookJson = JSON.parse(readFileSync(join(src, "_数据", "book.json"), "utf8"));
const mdNames = readdirSync(src)
  .filter((name) => name.toLowerCase().endsWith(".md"))
  .sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { numeric: true }));

function frontmatter(text) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const value = /^pdf:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? null;
  // frontmatter 里的值可能带引号：pdf: "[[新史學.pdf]]"
  return value ? value.replace(/^["']|["']$/g, "").trim() : null;
}

/** `[[x.pdf]]`、`[[x.pdf|别名]]`、`![[x.pdf]]`、`x.pdf` 都认（与 server/book.ts 的 linkpathOf 一致） */
function linkpath(value) {
  return value.replace(/^!?\[\[|\]\]$/g, "").split("|")[0].trim();
}

const texts = {};
const markdown = [];
for (const path of mdNames) {
  const text = readFileSync(join(src, path), "utf8");
  const link = frontmatter(text);
  texts[path] = text;
  markdown.push({
    path,
    pdf: link ? linkpath(link) : bookJson.pdf ?? null,
    pdfSource: link ? "frontmatter" : "book.json",
    pdfLink: link,
  });
}

const listed = (bookJson.files ?? []).map((item) => (typeof item === "string" ? item : item.path));
const members = listed.filter((path) => mdNames.includes(path));

const book = {
  name: "新史學",
  root: "AIhistory1012 演示站 · 新史學（CC BY-SA 4.0）",
  title: bookJson.title ?? "新史學",
  markdown,
  pdfs: [bookJson.pdf ?? "新史學.pdf"],
  bookJson,
  bookJsonError: null,
  pdf: bookJson.pdf ?? "新史學.pdf",
  members: members.length ? members : mdNames,
  printedPageOffset: typeof bookJson.printedPageOffset === "number" ? bookJson.printedPageOffset : null,
};

const pdfName = book.pdf;
// 样例 PDF 与样例书文件夹同辈（tests/fixtures/新史學.pdf），不在书文件夹里
const pdfPath = [join(src, pdfName), join(web, "..", "tests", "fixtures", pdfName)].find((path) => existsSync(path));
if (!pdfPath) {
  console.error(`找不到样例 PDF：${pdfName}`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "index.json"), `${JSON.stringify({ book, texts }, null, 0)}\n`, "utf8");
copyFileSync(pdfPath, join(out, "book.pdf"));

console.log(`演示书已生成：${mdNames.length} 个文件、${Object.values(texts).reduce((n, t) => n + t.length, 0)} 字 → public/demo/`);
