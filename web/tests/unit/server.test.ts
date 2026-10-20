import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanBook } from "../../server/book";
import { checkRequest, hostAllowed, originAllowed, tokenMatches } from "../../server/guard";
import { hashText } from "../../server/files";
import { makeListener } from "../../server/listener";
import { PathError, resolveInBook } from "../../server/paths";

let root = "";
let outside = "";

beforeAll(() => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "aih-unit-")));
  root = join(base, "书");
  outside = join(base, "外面");
  mkdirSync(join(root, "_数据", "MinerU"), { recursive: true });
  mkdirSync(join(root, "子目录"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "01-正文.md"), '---\npdf: "[[书.pdf]]"\n---\n<!--pdf-page.1-->甲\n');
  writeFileSync(join(root, "00-卷首.md"), "卷首\n");
  writeFileSync(join(root, "书.pdf"), "%PDF-1.4 假的");
  writeFileSync(join(root, "_数据", "book.json"), JSON.stringify({ version: 2, pdf: "书.pdf", files: [{ path: "00-卷首.md" }, { path: "01-正文.md" }] }));
  writeFileSync(join(root, "_数据", "MinerU", "x.md"), "原始结果");
  writeFileSync(join(root, "笔记.txt"), "不是 md");
  writeFileSync(join(outside, "秘密.md"), "书外的文件");
  // junction 指向书外（Windows 上不要管理员权限）
  if (process.platform === "win32") execSync(`mklink /J "${join(root, "链接")}" "${outside}"`, { shell: "cmd.exe", stdio: "ignore" });
});

afterAll(() => {
  rmSync(join(root, ".."), { recursive: true, force: true });
});

describe("路径校验", () => {
  it("书里的 .md、.pdf、book.json 放行", () => {
    expect(resolveInBook(root, "01-正文.md", "read").rel).toBe("01-正文.md");
    expect(resolveInBook(root, "书.pdf", "read").abs).toBe(join(root, "书.pdf"));
    expect(resolveInBook(root, "_数据/book.json", "write").rel).toBe("_数据/book.json");
    expect(resolveInBook(root, "./子目录/新.md", "write").rel).toBe("子目录/新.md");
    expect(resolveInBook(root, "子目录\\新.md", "write").rel).toBe("子目录/新.md");
  });

  const bad: Array<[string, unknown, "read" | "write"]> = [
    ["..穿越", "../外面/秘密.md", "read"],
    ["中间夹 ..", "子目录/../../外面/秘密.md", "read"],
    ["反斜杠穿越", "..\\外面\\秘密.md", "read"],
    ["绝对路径", "/etc/passwd.md", "read"],
    ["盘符", "C:/Windows/win.ini.md", "read"],
    ["UNC", "\\\\server\\share\\a.md", "read"],
    ["空字节", "01-正文.md\0.pdf", "read"],
    ["扩展名不对", "笔记.txt", "read"],
    ["_数据 里别的文件", "_数据/MinerU/x.md", "read"],
    ["PDF 不能写", "书.pdf", "write"],
    ["空串", "", "read"],
    ["不是字符串", 42, "read"],
    ["点段", "./././", "read"],
  ];
  for (const [name, rel, access] of bad) {
    it(`挡住：${name}`, () => {
      expect(() => resolveInBook(root, rel, access)).toThrow(PathError);
    });
  }

  it.runIf(process.platform === "win32")("挡住：经 junction 绕出书文件夹", () => {
    expect(() => resolveInBook(root, "链接/秘密.md", "read")).toThrow(/链接/);
    expect(() => resolveInBook(root, "链接/新.md", "write")).toThrow(/链接/);
  });
});

describe("请求把关", () => {
  it("Host 只认 127.0.0.1 / localhost 加本端口", () => {
    expect(hostAllowed("127.0.0.1:4312", 4312)).toBe(true);
    expect(hostAllowed("localhost:4312", 4312)).toBe(true);
    expect(hostAllowed("evil.example:4312", 4312)).toBe(false);
    expect(hostAllowed("127.0.0.1:80", 4312)).toBe(false);
    expect(hostAllowed(undefined, 4312)).toBe(false);
  });
  it("Origin 缺省放行，别的站拒绝", () => {
    expect(originAllowed(undefined, 4312)).toBe(true);
    expect(originAllowed("http://127.0.0.1:4312", 4312)).toBe(true);
    expect(originAllowed("https://evil.example", 4312)).toBe(false);
    expect(originAllowed("null", 4312)).toBe(false);
  });
  it("令牌逐字比较，长度不同、数组都拒绝", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abd", "abc")).toBe(false);
    expect(tokenMatches("ab", "abc")).toBe(false);
    expect(tokenMatches(["abc"], "abc")).toBe(false);
    expect(tokenMatches(undefined, "abc")).toBe(false);
  });
  it("页面不要令牌，接口要", () => {
    const base = { host: "127.0.0.1:1", origin: undefined };
    expect(checkRequest({ ...base, token: undefined, api: false }, 1, "t")).toBeNull();
    expect(checkRequest({ ...base, token: undefined, api: true }, 1, "t")?.status).toBe(401);
    expect(checkRequest({ ...base, token: "t", api: true }, 1, "t")).toBeNull();
    expect(checkRequest({ ...base, host: "a.com:1", token: "t", api: true }, 1, "t")?.status).toBe(421);
  });
});

describe("书的扫描与配对", () => {
  it("按 book.json 排成员，frontmatter 配 PDF，_数据 里的不算", async () => {
    const book = await scanBook(root);
    expect(book.pdf).toBe("书.pdf");
    expect(book.members).toEqual(["00-卷首.md", "01-正文.md"]);
    expect(book.markdown.find((item) => item.path === "01-正文.md")?.pdfSource).toBe("frontmatter");
    expect(book.markdown.find((item) => item.path === "00-卷首.md")?.pdfSource).toBe("book.json");
    expect(book.markdown.some((item) => item.path.startsWith("_数据"))).toBe(false);
  });
});

describe("接口（真起一个本机服务）", () => {
  let server: Server;
  let port = 0;
  const token = "测试令牌-0123456789";
  const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { "x-aih-token": encodeURIComponent(token), ...(init.headers ?? {}) } });

  beforeAll(async () => {
    server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as { port: number }).port;
    server.on("request", makeListener({ port, token: encodeURIComponent(token), root, watcher: null }, (_req, res) => res.end("页面")));
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  it("没令牌 401，令牌错 401", async () => {
    expect((await fetch(`http://127.0.0.1:${port}/api/book`)).status).toBe(401);
    expect((await call("/api/book", { headers: { "x-aih-token": "wrong" } })).status).toBe(401);
  });

  it("别的网页（Origin 不同）403", async () => {
    expect((await call("/api/book", { headers: { origin: "https://evil.example" } })).status).toBe(403);
  });

  it("读文件带 hash；越界 403", async () => {
    const ok = await call(`/api/file?path=${encodeURIComponent("01-正文.md")}`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { text: string; hash: string };
    expect(body.hash).toBe(hashText(body.text));
    expect((await call(`/api/file?path=${encodeURIComponent("../外面/秘密.md")}`)).status).toBe(403);
  });

  it("存盘：基于旧版本时 409 并交回磁盘内容；force 才覆盖", async () => {
    const path = `/api/file?path=${encodeURIComponent("00-卷首.md")}`;
    const first = (await (await call(path)).json()) as { hash: string };
    const saved = await call(path, { method: "PUT", body: JSON.stringify({ text: "卷首 改一\n", baseHash: first.hash }) });
    expect(saved.status).toBe(200);
    expect(readFileSync(join(root, "00-卷首.md"), "utf8")).toBe("卷首 改一\n");
    // 模拟 Claude 在磁盘上又改了
    writeFileSync(join(root, "00-卷首.md"), "卷首 Claude 改\n");
    const stale = await call(path, { method: "PUT", body: JSON.stringify({ text: "卷首 改二\n", baseHash: hashText("卷首 改一\n") }) });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { conflict: { text: string } }).conflict.text).toBe("卷首 Claude 改\n");
    expect(readFileSync(join(root, "00-卷首.md"), "utf8")).toBe("卷首 Claude 改\n");
    const forced = await call(path, { method: "PUT", body: JSON.stringify({ text: "卷首 改二\n", baseHash: null, force: true }) });
    expect(forced.status).toBe(200);
    expect(readFileSync(join(root, "00-卷首.md"), "utf8")).toBe("卷首 改二\n");
  });

  it("PDF 支持 Range", async () => {
    const res = await call(`/api/pdf?path=${encodeURIComponent("书.pdf")}`, { headers: { range: "bytes=0-3" } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("%PDF");
  });

  it("book.json 写坏的 JSON 拒绝", async () => {
    const res = await call(`/api/file?path=${encodeURIComponent("_数据/book.json")}`, { method: "PUT", body: JSON.stringify({ text: "{坏", force: true }) });
    expect(res.status).toBe(400);
  });
});
