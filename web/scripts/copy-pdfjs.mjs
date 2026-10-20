// 把 pdf.js 的 worker、CMap（中文 PDF 文字层要用）、标准字体拷进 public/pdfjs/，由 Next 当静态文件发出。
// 不走打包器：worker 要单独一个文件，CMap 是按需取的几百个小文件。
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist");
const out = join(root, "public", "pdfjs");
if (!existsSync(src)) process.exit(0);
mkdirSync(out, { recursive: true });
cpSync(join(src, "build", "pdf.worker.min.mjs"), join(out, "pdf.worker.min.mjs"));
cpSync(join(src, "cmaps"), join(out, "cmaps"), { recursive: true });
cpSync(join(src, "standard_fonts"), join(out, "standard_fonts"), { recursive: true });
console.log("pdf.js 静态文件已拷到 public/pdfjs/");
