/**
 * 网页工作台自己的「跳到某页某字」路由，与插件的疑字链接一一对应：
 *
 *   插件：obsidian://aihistory-pdf-sync?vault=<库名>&file=<库内相对路径>&page=<N>&text=<现字>&ctx=<前后各约 6 字>
 *   网页：http://127.0.0.1:<端口>/open?file=<路径>&page=<N>&text=<现字>&ctx=<前后各约 6 字>
 *
 * 参数同名同义、同样 UTF-8 百分号编码；网页没有「库」，所以不要 vault。
 * file 可以是相对书文件夹的路径，也可以照抄疑字清单里的库内路径：网页按「最长后缀」认到书里的文件
 * （库内路径 `论文/某某考/01-正文.md` → 书里的 `01-正文.md`）。
 * 在编辑器里 Ctrl/⌘ + 点击疑字清单中的 obsidian:// 链接，网页换成 /open 路由处理，不必改清单。
 */
import { parseSuspectLink } from "@/s3/core";

export interface OpenRequest {
  file: string;
  page: number | null;
  text: string;
  ctx: string;
}

export function openRequestFromLocation(location: { pathname: string; search: string }): OpenRequest | null {
  if (location.pathname.replace(/\/+$/, "") !== "/open") return null;
  const params: Record<string, string> = {};
  new URLSearchParams(location.search).forEach((value, key) => {
    params[key] = value;
  });
  const link = parseSuspectLink(params);
  return link ? { file: link.file, page: link.page, text: link.text, ctx: link.ctx } : null;
}

/** 链接里的文件 → 书里的文件：完全相同优先，其次最长的路径后缀相同；同样长时书的成员优先 */
export function mapLinkFile(file: string, paths: string[], members: string[] = []): string | null {
  const clean = file.replace(/\\/g, "/").replace(/^\/+/, "");
  if (paths.includes(clean)) return clean;
  const parts = clean.split("/");
  for (let start = 1; start < parts.length; start += 1) {
    const suffix = parts.slice(start).join("/");
    const hits = paths.filter((path) => path === suffix || path.endsWith(`/${suffix}`));
    if (hits.length) return hits.find((path) => members.includes(path)) ?? hits[0];
  }
  return null;
}
