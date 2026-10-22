/**
 * 演示站（GitHub Pages）用的替代数据层：书是从静态文件里读的，没有本机服务，也没有磁盘可写。
 *
 * 只在 NEXT_PUBLIC_AIH_DEMO=1 的构建里生效（scripts/build-demo.mjs）；本机工作台的构建里 DEMO 是 false，
 * 下面这些函数一个都不会被调用，读写仍然走 server/ 的 /api 接口。
 *
 * 演示站里能做的：左右对照、按页跟随、翻页、页内选字逐字高亮、全文搜索、设置（存在浏览器里）、
 * 复制本页修订请求。不能做的：存盘、改绑 PDF、补页码锚点——这些要碰硬盘，演示站只读。
 */
import type { BookInfo } from "../../server/book";
import type { SettingsSnapshot } from "./api";

export const DEMO = process.env.NEXT_PUBLIC_AIH_DEMO === "1";
/** 演示站在子路径下（Pages 的 /AIhistory1012/demo/），静态资源要带这个前缀 */
export const BASE_PATH = process.env.NEXT_PUBLIC_AIH_BASE ?? "";

export const asset = (path: string) => `${BASE_PATH}${path.startsWith("/") ? path : `/${path}`}`;

const PREFS_KEY = "aih-demo-prefs";
/** 演示站没有本机服务，设置存在浏览器里 */
const DEFAULT_PORT = 4312;

interface DemoIndex {
  book: BookInfo;
  /** 文件路径 → 正文（与书文件夹里的 Markdown 一字不差） */
  texts: Record<string, string>;
}

let index: Promise<DemoIndex> | null = null;

function loadIndex(): Promise<DemoIndex> {
  index ??= fetch(asset("/demo/index.json"))
    .then((res) => {
      if (!res.ok) throw new Error(`演示数据读不出来（HTTP ${res.status}）`);
      return res.json() as Promise<DemoIndex>;
    })
    .catch((error: Error) => {
      index = null;
      throw error;
    });
  return index;
}

/** 与服务端的 hash 算法无关：演示站没有磁盘，只要前后一致就行 */
async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function demoBook(): Promise<BookInfo> {
  return (await loadIndex()).book;
}

export async function demoFile(path: string): Promise<{ path: string; text: string; hash: string; mtimeMs: number }> {
  const { texts } = await loadIndex();
  const text = texts[path];
  if (text === undefined) throw new Error(`演示书里没有「${path}」`);
  return { path, text, hash: await hashText(text), mtimeMs: 0 };
}

export function demoSave(): never {
  throw new Error("演示站只读：翻页、对照、选字都能用，但改动不会保存。想改请在本地跑网页工作台。");
}

export function demoPdfSource(): { url: string; httpHeaders: Record<string, string> } {
  return { url: asset("/demo/book.pdf"), httpHeaders: {} };
}

/** 静态站没有推送：连一次就当连上了，不会有事件 */
export function demoSubscribe(onState: (connected: boolean) => void): () => void {
  onState(true);
  return () => {};
}

function readPrefs(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function demoSettings(): Promise<SettingsSnapshot> {
  // 演示站不自动弹四步引导（设置里还能重开）：来访的人先看到书，比先看到引导好
  return { port: DEFAULT_PORT, runningPort: null, prefs: { ...readPrefs(), onboarded: true }, configPath: "（演示站没有本机服务，设置只存在这个浏览器里）" };
}

export async function demoSaveSettings(patch: { prefs?: Record<string, unknown> }): Promise<SettingsSnapshot> {
  if (patch.prefs) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(patch.prefs));
    } catch {
      // 隐私模式：这次会话里照用，存不下就算了
    }
  }
  return demoSettings();
}
