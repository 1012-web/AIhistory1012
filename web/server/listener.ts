/**
 * 每个请求先过把关（guard.ts），接口交给 api.ts，其余（页面、静态文件）交给 Next。
 */
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { handleApi } from "./api";
import { checkRequest, TOKEN_HEADER } from "./guard";
import type { BookWatcher } from "./watcher";

export interface ListenerOptions {
  port: number;
  token: string;
  root: string;
  watcher: BookWatcher | null;
}

export function makeListener(options: ListenerOptions, page: (req: IncomingMessage, res: ServerResponse) => void): RequestListener {
  return (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const api = path.startsWith("/api/");
    const denied = checkRequest({ host: req.headers.host, origin: req.headers.origin, token: req.headers[TOKEN_HEADER], api }, options.port, options.token);
    if (denied) {
      res.writeHead(denied.status, { "content-type": "text/plain; charset=utf-8" });
      res.end(denied.reason);
      return;
    }
    if (api) void handleApi(req, res, { root: options.root, watcher: options.watcher, port: options.port });
    else page(req, res);
  };
}
