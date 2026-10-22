// 本机预览 site/：npm run demo:serve（默认 http://127.0.0.1:4320/）。
// 只是把静态文件发出去，为了在推送前看一眼主页与 /demo/；线上由 GitHub Pages 发。
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const site = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "site");
const port = Number(process.env.PORT ?? 4320);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  let path = normalize(join(site, decodeURIComponent(url.pathname)));
  if (!path.startsWith(site + sep) && path !== site) {
    response.writeHead(403).end("forbidden");
    return;
  }
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
  if (!existsSync(path)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end(`404 ${url.pathname}`);
    return;
  }
  response.writeHead(200, { "content-type": TYPES[extname(path).toLowerCase()] ?? "application/octet-stream" });
  createReadStream(path).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`预览：http://127.0.0.1:${port}/（主页）  http://127.0.0.1:${port}/demo/（演示站）`);
});
