/**
 * 造 e2e 测试库：一本多文件的书（三章三个文件，带物理页锚点）+ 一篇无锚点笔记 + 一本旧格式的书。
 *
 * 原材料是仓库里的测试样本：tests/fixtures/clean/新史學 与 tests/fixtures/新史學.pdf（演示书《新史學》的排印本，
 * 梁启超 1902，文字据维基文库，CC BY-SA 4.0；23 页，有文字层，物理页 = 印刷页 + 4）。不读任何本机材料；
 * 测试库现造到 git 忽略的 .scratch 下。
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SOURCE_DIR = path.join(REPO, "tests", "fixtures", "clean", "新史學");
const SOURCE_PDF = path.join(REPO, "tests", "fixtures", "新史學.pdf");
/** 物理页 = 印刷页 + 4（前 4 页是书名页、说明页、校订说明、目录）；book.json 的 printedPageOffset 同此约定 */
export const BOOK_JSON_OFFSET = 4;
export const BOOK = "新史學";
export const CHAPTERS = ["01-中國之舊史", "02-史學之界說", "03-論正統"];

function readSource(name: string): string {
  return readFileSync(path.join(SOURCE_DIR, `${name}.md`), "utf8").replace(/\r\n/g, "\n");
}

export function makeFixture(vault: string): void {
  rmSync(vault, { recursive: true, force: true });
  const book = path.join(vault, BOOK);
  mkdirSync(path.join(book, "_数据"), { recursive: true });
  copyFileSync(SOURCE_PDF, path.join(book, `${BOOK}.pdf`));

  // 01、02 带 frontmatter（pdf 指 新史學.pdf）；03 去掉 frontmatter，靠 _数据/book.json 配对
  for (const name of CHAPTERS) {
    const text = readSource(name);
    writeFileSync(path.join(book, `${name}.md`), name === CHAPTERS[2] ? text.replace(/^---\n[\s\S]*?\n---\n\n?/, "") : text);
  }
  // 书的索引：无锚点、无 frontmatter
  writeFileSync(path.join(book, `${BOOK}.md`), `# ${BOOK}\n\n${CHAPTERS.map((name) => `- [[${name}]]`).join("\n")}\n`);
  writeFileSync(path.join(book, "_数据", "book.json"), `${JSON.stringify({
    version: 1,
    title: BOOK,
    pdf: `${BOOK}.pdf`,
    files: [...CHAPTERS.map((name) => `${name}.md`), `${BOOK}.md`],
    printedPageOffset: BOOK_JSON_OFFSET
  }, null, 2)}\n`);

  // 补锚点用：第二章去掉全部锚点，单放一个文件夹，frontmatter 链到书里的 PDF
  const bare = path.join(vault, "补锚点");
  mkdirSync(bare, { recursive: true });
  const second = readSource(CHAPTERS[1]).replace(/^---\n[\s\S]*?\n---\n/, "");
  const stripped = second.replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n");
  writeFileSync(path.join(bare, "无锚点.md"), `---\npdf: "[[${BOOK}.pdf]]"\n---\n${stripped}`);

  // 旧格式（md1012 时期）：只有印刷页锚点 <!--p.M-->；第 1 版 book.json 靠 printedPageOffset 换算物理页
  const legacy = path.join(vault, "旧格式");
  mkdirSync(path.join(legacy, "_数据"), { recursive: true });
  copyFileSync(path.join(book, `${BOOK}.pdf`), path.join(legacy, "旧格式.pdf"));
  const old = readSource(CHAPTERS[1]).replace(/^pdf:.*\n/m, "").replace(/<!--pdf-page\.\d+-->/g, "");
  writeFileSync(path.join(legacy, "旧格式.md"), old);
  writeFileSync(path.join(legacy, "_数据", "book.json"), `${JSON.stringify({ version: 1, id: "legacy", title: "旧格式", pdf: "旧格式.pdf", index: "_数据/映射/index.json", printedPageOffset: BOOK_JSON_OFFSET }, null, 2)}
`);

  // 测试库的 Obsidian 设置：关掉安全模式、打开本插件
  mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  writeFileSync(path.join(vault, ".obsidian", "app.json"), JSON.stringify({ livePreview: true, readableLineLength: true }, null, 2));
}
