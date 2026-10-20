/**
 * 启动网页工作台：
 *   npm run workbench -- "<书文件夹>"            用构建好的版本（第一次会先自动构建，约一两分钟）
 *   npm run dev -- "<书文件夹>"                  开发模式（改界面代码即时生效）
 * 选项：--port <端口>（只管这一次；平时的默认端口在设置页里改，存进用户配置文件）、--no-open（不自动开浏览器）
 *
 * 只监听 127.0.0.1。令牌存在用户配置文件里（见 config.ts），重启照用，所以网址、疑字链接重启后照样能用；
 * 令牌不打印、不进日志，只放进自动打开的那个网址的 #token= 里交给浏览器。
 * 端口固定：被占用就明说并退出，不悄悄换一个。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import next from "next";
import { configPath, loadConfig, validPort } from "./config";
import { makeListener } from "./listener";
import { BookWatcher } from "./watcher";

// 不联网：关掉 Next.js 的匿名使用统计（构建子进程也继承这个环境变量）
process.env.NEXT_TELEMETRY_DISABLED = "1";

const HOST = "127.0.0.1";
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Options {
  folder: string;
  dev: boolean;
  /** null：用配置文件里的端口；0：让系统随便给一个（测试用） */
  port: number | null;
  open: boolean;
}

export class StartError extends Error {}

function parseArgs(argv: string[]): Options {
  const options: Options = { folder: "", dev: false, port: null, open: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dev") options.dev = true;
    else if (arg === "--no-open") options.open = false;
    else if (arg === "--port") options.port = Number(argv[(i += 1)]);
    else if (!arg.startsWith("--")) options.folder = arg;
  }
  return options;
}

/** 端口能不能用；不能用时给出原因 */
function probePort(port: number): Promise<{ ok: true; port: number } | { ok: false; code: string }> {
  return new Promise((done) => {
    const probe = createNetServer();
    probe.once("error", (error: NodeJS.ErrnoException) => done({ ok: false, code: error.code ?? "?" }));
    probe.listen(port, HOST, () => {
      const actual = (probe.address() as { port: number }).port;
      probe.close(() => done({ ok: true, port: actual }));
    });
  });
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", '""', `"${url}"`]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(command, args as string[], { stdio: "ignore", detached: true, windowsVerbatimArguments: process.platform === "win32" }).unref();
}

function ensureBuilt(): void {
  if (existsSync(join(projectDir, ".next", "BUILD_ID"))) return;
  console.log("第一次启动：先构建界面（约一两分钟）……");
  const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["next", "build"], { cwd: projectDir, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new StartError("构建失败，见上面的输出");
}

export interface Workbench {
  /** 不带令牌的网址（可以打印） */
  url: string;
  /** 带令牌的网址（只交给浏览器） */
  openUrl: string;
  port: number;
  root: string;
  close: () => Promise<void>;
}

export async function startWorkbench(input: Options): Promise<Workbench> {
  if (!input.folder) throw new StartError('用法：npm run workbench -- "<书文件夹>"');
  const abs = resolve(input.folder);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new StartError(`不是文件夹：${abs}`);
  const root = realpathSync.native(abs);
  const config = loadConfig();
  const wanted = input.port ?? config.port;
  if (wanted !== 0 && !validPort(wanted)) throw new StartError(`端口 ${String(wanted)} 不合法：要在 1024–65535 之间`);
  const probe = await probePort(wanted);
  if (!probe.ok) {
    const reason = probe.code === "EADDRINUSE" ? "已被占用（可能另一个工作台还开着，或别的程序在用）" : `用不了（${probe.code}）`;
    throw new StartError(
      `端口 ${wanted} ${reason}。\n` +
        `· 已经开着工作台的话，直接用那个浏览器标签页，或先关掉那个窗口；\n` +
        `· 想换端口：这一次用 npm run workbench -- "<书文件夹>" --port 4313；长期换就在工作台的设置页「本机服务」里改默认端口\n` +
        `  （配置文件：${configPath()}）。`
    );
  }
  const port = probe.port;
  if (!input.dev) ensureBuilt();

  const watcher = new BookWatcher(root);
  await watcher.start();

  const app = next({ dev: input.dev, dir: projectDir, hostname: HOST, port });
  await app.prepare();
  const handle = app.getRequestHandler();

  const server: Server = createServer(makeListener({ port, token: config.token, root, watcher }, (req, res) => void handle(req, res)));
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(port, HOST, done);
  });

  const url = `http://${HOST}:${port}/`;
  return {
    url,
    openUrl: `${url}#token=${config.token}`,
    port,
    root,
    close: async () => {
      await watcher.close();
      // 改动推送是长连接：先断掉所有连接，close 才会返回
      const closed = new Promise<void>((done) => server.close(() => done()));
      server.closeAllConnections();
      await closed;
      await app.close?.();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  startWorkbench(options)
    .then((workbench) => {
      console.log(`书文件夹：${workbench.root}`);
      console.log(`工作台已启动（只在本机可见）：${workbench.url}`);
      console.log(options.open ? "已在默认浏览器里打开（网址带着令牌，不在这里打印）。" : "没有自动开浏览器（--no-open）。");
      console.log("关掉这个窗口或按 Ctrl+C 停止。");
      if (options.open) openBrowser(workbench.openUrl);
      const stop = () => void workbench.close().finally(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    })
    .catch((error: Error) => {
      console.error(error.message);
      process.exit(1);
    });
}
