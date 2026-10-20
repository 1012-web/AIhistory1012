/**
 * 本机接口（都要令牌，见 guard.ts）：
 *   GET  /api/book                 书的概况：文件、PDF、book.json、配对
 *   GET  /api/file?path=<相对路径>  读一个 .md 或 book.json → { path, text, hash, mtimeMs }
 *   PUT  /api/file?path=<相对路径>  存盘，body { text, baseHash, force? } → 200 { hash } 或 409 { conflict: { text, hash } }
 *   GET  /api/pdf?path=<相对路径>   PDF 原样字节，支持 Range（pdf.js 按需取）
 *   GET  /api/events               改动推送（Server-Sent Events），每条是一个 ChangeEvent
 *   GET  /api/settings             端口与界面设置（不含令牌）
 *   PUT  /api/settings             改端口（下次启动生效）或界面设置，body { port?, prefs? }
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { scanBook } from "./book";
import { configPath, loadConfig, saveConfig, validPort } from "./config";
import { readSnapshot, saveText } from "./files";
import { PathError, resolveInBook } from "./paths";
import type { BookWatcher, ChangeEvent } from "./watcher";

export interface ApiContext {
  root: string;
  watcher: BookWatcher | null;
  /** 这一次实际监听的端口（可能是 --port 临时指定的，与配置里的默认端口不同） */
  port?: number;
}

const MAX_BODY = 32 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new PathError("内容太大", 413);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function servePdf(req: IncomingMessage, res: ServerResponse, abs: string): Promise<void> {
  const info = await stat(abs);
  const size = info.size;
  const headers: Record<string, string | number> = {
    "content-type": "application/pdf",
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    createReadStream(abs, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "content-length": size });
  createReadStream(abs).pipe(res);
}

function serveEvents(req: IncomingMessage, res: ServerResponse, ctx: ApiContext): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  const listener = (event: ChangeEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  ctx.watcher?.on("change", listener);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  const stop = () => {
    clearInterval(ping);
    ctx.watcher?.off("change", listener);
  };
  req.on("close", stop);
  res.on("close", stop);
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, ctx: ApiContext): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const method = req.method ?? "GET";
  try {
    if (url.pathname === "/api/book" && method === "GET") {
      sendJson(res, 200, await scanBook(ctx.root));
      return;
    }
    if (url.pathname === "/api/settings" && method === "GET") {
      const config = loadConfig();
      sendJson(res, 200, { port: config.port, runningPort: ctx.port ?? null, prefs: config.prefs, configPath: configPath() });
      return;
    }
    if (url.pathname === "/api/settings" && method === "PUT") {
      const body = JSON.parse(await readBody(req)) as { port?: unknown; prefs?: unknown };
      const config = loadConfig();
      if (body.port !== undefined) {
        if (!validPort(body.port)) throw new PathError("端口要是 1024–65535 之间的整数", 400);
        config.port = body.port;
      }
      if (body.prefs !== undefined) {
        if (!body.prefs || typeof body.prefs !== "object" || Array.isArray(body.prefs)) throw new PathError("prefs 要是一个对象", 400);
        config.prefs = { ...config.prefs, ...(body.prefs as Record<string, unknown>) };
      }
      saveConfig(config);
      sendJson(res, 200, { port: config.port, runningPort: ctx.port ?? null, prefs: config.prefs, configPath: configPath() });
      return;
    }
    if (url.pathname === "/api/events" && method === "GET") {
      serveEvents(req, res, ctx);
      return;
    }
    if (url.pathname === "/api/pdf" && method === "GET") {
      const { abs, rel } = resolveInBook(ctx.root, url.searchParams.get("path"), "read");
      if (!rel.toLowerCase().endsWith(".pdf")) throw new PathError("这里只给 PDF", 400);
      await servePdf(req, res, abs);
      return;
    }
    if (url.pathname === "/api/file" && method === "GET") {
      const { abs, rel } = resolveInBook(ctx.root, url.searchParams.get("path"), "read");
      if (rel.toLowerCase().endsWith(".pdf")) throw new PathError("PDF 请走 /api/pdf", 400);
      sendJson(res, 200, { path: rel, ...(await readSnapshot(abs)) });
      return;
    }
    if (url.pathname === "/api/file" && method === "PUT") {
      const { abs, rel } = resolveInBook(ctx.root, url.searchParams.get("path"), "write");
      const body = JSON.parse(await readBody(req)) as { text?: unknown; baseHash?: unknown; force?: unknown };
      if (typeof body.text !== "string") throw new PathError("缺少 text", 400);
      if (rel.endsWith(".json")) JSON.parse(body.text); // book.json 写坏了会让插件读不出配对：先验一下
      const result = await saveText(abs, body.text, typeof body.baseHash === "string" ? body.baseHash : null, body.force === true);
      if (result.ok) sendJson(res, 200, { path: rel, hash: result.hash, mtimeMs: result.mtimeMs });
      else sendJson(res, 409, { path: rel, conflict: result.conflict });
      return;
    }
    sendJson(res, 404, { error: "没有这个接口" });
  } catch (error) {
    if (error instanceof PathError) sendJson(res, error.status, { error: error.message });
    else if (error instanceof SyntaxError) sendJson(res, 400, { error: `内容不是合法的 JSON：${error.message}` });
    else if ((error as NodeJS.ErrnoException).code === "ENOENT") sendJson(res, 404, { error: "文件不存在" });
    else sendJson(res, 500, { error: (error as Error).message });
  }
}
