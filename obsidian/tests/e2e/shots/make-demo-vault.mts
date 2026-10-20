/**
 * README 截图用的测试库：一本已导入的书（默认演示书《新史學》）+ 一篇去掉锚点的笔记（拍补锚点预览）。
 * 库现造在 git 忽略的 .scratch 下，绝不碰用户自己的库。
 * 书文件夹用环境变量 APS_DEMO_BOOK 指定（lunzhu2md 导入的成品，含 01-…md、<书名>.文字层.pdf、_数据/book.json）。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { env } from "node:process";

export const DEMO = env.APS_DEMO_BOOK ?? "";
export const BOOK = path.basename(DEMO);

export function makeDemoVault(vault: string): void {
  if (!DEMO || !existsSync(path.join(DEMO, "_数据", "book.json"))) {
    throw new Error("请用环境变量 APS_DEMO_BOOK 指向一本 lunzhu2md 导入的书文件夹（要有 _数据/book.json）");
  }
  rmSync(vault, { recursive: true, force: true });
  const book = path.join(vault, BOOK);
  mkdirSync(path.join(book, "_数据"), { recursive: true });
  for (const name of readdirSync(DEMO)) {
    if (/\.(md|pdf)$/.test(name)) copyFileSync(path.join(DEMO, name), path.join(book, name));
  }
  copyFileSync(path.join(DEMO, "_数据", "book.json"), path.join(book, "_数据", "book.json"));
  if (existsSync(path.join(DEMO, "images"))) cpSync(path.join(DEMO, "images"), path.join(book, "images"), { recursive: true });

  // 补锚点用：第二个正文文件去掉全部锚点，frontmatter 只留 pdf
  const chapters = readdirSync(DEMO).filter((name) => /^\d\d-.*\.md$/.test(name)).sort();
  const source = chapters[1] ?? chapters[0];
  const pdf = readdirSync(DEMO).find((name) => name.endsWith(".文字层.pdf")) ?? `${BOOK}.pdf`;
  const bare = path.join(vault, "补锚点");
  mkdirSync(bare, { recursive: true });
  const chapter = readFileSync(path.join(DEMO, source), "utf8").replace(/\r\n/g, "\n");
  const body = chapter.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n");
  writeFileSync(path.join(bare, "無錨點筆記.md"), `---\npdf: "[[${BOOK}/${pdf}]]"\n---\n${body}`);

  mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  writeFileSync(path.join(vault, ".obsidian", "app.json"), JSON.stringify({ livePreview: true, readableLineLength: true }, null, 2));
}
