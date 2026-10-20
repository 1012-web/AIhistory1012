/**
 * 路径校验：网页只能碰所开书文件夹里的 `.md`、`.pdf` 和 `_数据/book.json`。
 *
 * 网页传来的路径一律是「相对书文件夹、用 / 分隔」的字符串。这里把它换成磁盘上的绝对路径，
 * 并挡住：绝对路径、盘符、`..` 穿越、空字节、扩展名不对、经 junction / 符号链接绕出书文件夹。
 */
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const BOOK_JSON = "_数据/book.json";

export type Access = "read" | "write";

export class PathError extends Error {
  constructor(message: string, readonly status = 403) {
    super(message);
  }
}

/** 相对路径的规范形式：正斜杠、无开头的 `./` 与 `/` */
export function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

/** 这个相对路径的种类是否允许；PDF 只读 */
export function allowedKind(rel: string, access: Access): boolean {
  const lower = rel.toLowerCase();
  if (rel === BOOK_JSON) return true;
  if (rel.split("/")[0] === "_数据") return false; // _数据/ 里只开放 book.json；MinerU 等原始结果不给网页碰
  if (lower.endsWith(".md")) return true;
  if (lower.endsWith(".pdf")) return access === "read";
  return false;
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" ? false : !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..");
}

/**
 * 把网页传来的相对路径换成绝对路径。root 必须是已经 realpath 过的书文件夹。
 * 文件已存在时还要核对它的真实路径（防 junction / 符号链接绕出去）；不存在时核对它的上级目录。
 */
export function resolveInBook(root: string, rawRel: unknown, access: Access): { abs: string; rel: string } {
  if (typeof rawRel !== "string" || !rawRel) throw new PathError("缺少路径", 400);
  if (rawRel.includes("\0")) throw new PathError("路径里有空字节", 400);
  const rel = normalizeRel(rawRel);
  if (rel.startsWith("/") || /^[a-zA-Z]:/.test(rel) || isAbsolute(rel)) throw new PathError("只接受书文件夹内的相对路径");
  const parts = rel.split("/");
  if (parts.some((part) => part === ".." || part === "." || part === "")) throw new PathError("路径不能含 .. 或空段");
  if (!allowedKind(rel, access)) throw new PathError(access === "write" ? "只能写 .md 与 _数据/book.json" : "只能读 .md、.pdf 与 _数据/book.json");
  const abs = resolve(root, ...parts);
  if (!inside(root, abs)) throw new PathError("路径越出书文件夹");
  let real: string;
  try {
    real = realpathSync.native(abs);
  } catch {
    // 文件还不存在：核对上级目录
    try {
      real = resolve(realpathSync.native(dirname(abs)), abs.slice(dirname(abs).length + 1));
    } catch {
      throw new PathError("文件不存在", 404);
    }
  }
  if (!inside(root, real)) throw new PathError("路径经链接越出书文件夹");
  return { abs, rel };
}
