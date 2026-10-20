/**
 * 网页 → 本机服务。令牌由启动命令放在网址的 #token=… 里交来：拿到后存进本标签页，并从地址栏抹掉。
 * 存 localStorage 而不只是 sessionStorage：从疑字清单点开的 /open 链接可能开在新标签页。令牌存在用户配置文件里、重启不换，所以浏览器记住一次就一直能用。
 */
import type { BookInfo } from "../../server/book";
import type { ChangeEvent } from "../../server/watcher";

export type { BookInfo, ChangeEvent };
export type { MarkdownInfo } from "../../server/book";

const KEY = "aih-workbench-token";
const HEADER = "x-aih-token";

export function takeToken(): string | null {
  const match = /(?:^#|&)token=([^&]+)/.exec(window.location.hash);
  if (match) {
    const token = decodeURIComponent(match[1]);
    try {
      localStorage.setItem(KEY, token);
      sessionStorage.setItem(KEY, token);
    } catch {
      // 隐私模式：只在内存里用
    }
    history.replaceState(null, "", window.location.pathname + window.location.search);
    memoryToken = token;
    return token;
  }
  if (memoryToken) return memoryToken;
  try {
    memoryToken = sessionStorage.getItem(KEY) ?? localStorage.getItem(KEY);
  } catch {
    memoryToken = null;
  }
  return memoryToken;
}

let memoryToken: string | null = null;

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = takeToken() ?? "";
  const res = await fetch(path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), [HEADER]: token } });
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(typeof body === "object" && body && "error" in body ? String((body as { error: string }).error) : String(body), res.status, body);
  return body as T;
}

export function fetchBook(): Promise<BookInfo> {
  return call<BookInfo>("/api/book");
}

export interface FileSnapshot {
  path: string;
  text: string;
  hash: string;
  mtimeMs: number;
}

export function fetchFile(path: string): Promise<FileSnapshot> {
  return call<FileSnapshot>(`/api/file?path=${encodeURIComponent(path)}`);
}

export type SaveOutcome = { ok: true; hash: string } | { ok: false; conflict: { text: string; hash: string } };

export async function saveFile(path: string, text: string, baseHash: string | null, force = false): Promise<SaveOutcome> {
  try {
    const body = await call<{ hash: string }>(`/api/file?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, baseHash, force }),
    });
    return { ok: true, hash: body.hash };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return { ok: false, conflict: (error.body as { conflict: { text: string; hash: string } }).conflict };
    throw error;
  }
}

export function pdfSource(path: string): { url: string; httpHeaders: Record<string, string> } {
  return { url: `/api/pdf?path=${encodeURIComponent(path)}`, httpHeaders: { [HEADER]: takeToken() ?? "" } };
}

/** 订阅改动推送。用 fetch 读流而不用 EventSource，因为 EventSource 带不了请求头（令牌不想放进网址）。断了自动重连。 */
export function subscribeChanges(onEvent: (event: ChangeEvent) => void, onState: (connected: boolean) => void): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  const run = async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetch("/api/events", { headers: { [HEADER]: takeToken() ?? "" }, signal: controller.signal });
        if (!res.ok || !res.body) throw new Error(String(res.status));
        onState(true);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let cut: number;
          while ((cut = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .map((line) => line.slice(6))
              .join("\n");
            if (data) onEvent(JSON.parse(data) as ChangeEvent);
          }
        }
      } catch {
        // 服务停了或网络断了：稍后重连
      }
      if (stopped) break;
      onState(false);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  };
  void run();
  return () => {
    stopped = true;
    controller?.abort();
  };
}

export interface SettingsSnapshot {
  /** 配置里的默认端口（下次启动用） */
  port: number;
  /** 这一次实际监听的端口 */
  runningPort: number | null;
  prefs: Record<string, unknown>;
  configPath: string;
}

export function fetchSettings(): Promise<SettingsSnapshot> {
  return call<SettingsSnapshot>("/api/settings");
}

export function saveSettings(patch: { port?: number; prefs?: Record<string, unknown> }): Promise<SettingsSnapshot> {
  return call<SettingsSnapshot>("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
}
