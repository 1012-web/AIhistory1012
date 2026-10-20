/**
 * 请求把关：别的网页可以借浏览器向 127.0.0.1 发请求（CSRF），也可以把自己的域名解析到 127.0.0.1（DNS 重绑定）。
 * 所以：
 *   1. Host 头必须是 127.0.0.1:<端口> 或 localhost:<端口>（挡 DNS 重绑定）；
 *   2. 带 Origin 头的请求，Origin 必须是本服务自己（挡跨站请求）；
 *   3. 接口必须带启动时生成的随机令牌（请求头 x-aih-token）。别的网页读不到这个令牌。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_HEADER = "x-aih-token";

export function makeToken(): string {
  return randomBytes(24).toString("base64url");
}

export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function originAllowed(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export function tokenMatches(given: string | string[] | undefined, token: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface GuardInput {
  host: string | undefined;
  origin: string | undefined;
  token: string | string[] | undefined;
  /** 接口路径要令牌；页面与静态文件不要（里面没有书的内容） */
  api: boolean;
}

/** 返回 null 表示放行，否则是拒绝的状态码与原因 */
export function checkRequest(input: GuardInput, port: number, token: string): { status: number; reason: string } | null {
  if (!hostAllowed(input.host, port)) return { status: 421, reason: "Host 头不对：只接受 127.0.0.1 或 localhost" };
  if (!originAllowed(input.origin, port)) return { status: 403, reason: "不接受别的网页发来的请求" };
  if (input.api && !tokenMatches(input.token, token)) return { status: 401, reason: "令牌不对或缺失：请用启动命令打开的网址进入" };
  return null;
}
