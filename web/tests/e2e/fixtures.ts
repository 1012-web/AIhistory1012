import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";

const ROOT = resolve(import.meta.dirname, "../..");
/** 测试用的固定令牌：写进临时的用户配置文件，工作台照用（真用时令牌由工作台自己生成） */
export const TEST_TOKEN = "e2e-test-token-0123456789abcdef";

export interface Workbench {
  port: number;
  token: string;
  /** 工作台打印出来的全部输出（查有没有漏出令牌） */
  log: () => string;
  close: () => Promise<void>;
}

export interface SpawnOptions {
  configDir: string;
  /** null：用配置文件里的端口 */
  port?: number | null;
}

/**
 * 起一个独立的工作台子进程（与用户用的 npm run workbench 是同一个入口）。
 * 不在测试进程里直接 startWorkbench：同一进程里反复起停 Next 会撞上它内部的单例。
 */
export function spawnRaw(folder: string, options: SpawnOptions): { child: ChildProcess; output: () => string; exited: Promise<number | null> } {
  const args = ["--import", "tsx", "server/workbench.ts", folder, "--no-open"];
  if (options.port !== null) args.push("--port", String(options.port ?? 0));
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AIH_CONFIG_DIR: options.configDir } });
  let log = "";
  child.stdout!.on("data", (chunk: Buffer) => (log += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (log += chunk.toString()));
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  return { child, output: () => log, exited };
}

export async function spawnWorkbench(folder: string, options: SpawnOptions): Promise<Workbench> {
  const { child, output, exited } = spawnRaw(folder, options);
  const port = await new Promise<number>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`工作台没起来：${output()}`)), 60_000);
    const check = () => {
      const match = /工作台已启动[^\n]*http:\/\/127\.0\.0\.1:(\d+)\//.exec(output());
      if (match) {
        clearTimeout(timer);
        done(Number(match[1]));
      }
    };
    child.stdout!.on("data", check);
    void exited.then((code) => fail(new Error(`工作台退出了（${code}）：${output()}`)));
  });
  return {
    port,
    token: TEST_TOKEN,
    log: output,
    close: () =>
      new Promise<void>((done) => {
        if (child.exitCode !== null) return done();
        child.once("exit", () => done());
        child.kill();
      }),
  };
}

/** 写一份临时的用户配置文件 */
export function writeConfig(configDir: string, prefs: Record<string, unknown>, port = 4312): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "workbench.json"), JSON.stringify({ token: TEST_TOKEN, port, prefs }, null, 2));
}

export function readConfig(configDir: string): { token: string; port: number; prefs: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(configDir, "workbench.json"), "utf8"));
}

export const FIXTURE = resolve(import.meta.dirname, "../../fixtures/新史學");

export interface Book {
  dir: string;
  configDir: string;
  workbench: Workbench;
  read: (name: string) => string;
  write: (name: string, text: string) => void;
  /** 打开工作台并等两栏就绪 */
  open: (page: Page, path?: string) => Promise<void>;
}

/** 默认把「看过引导」记上，免得每个用例都先弹引导；测引导的用例写 test.use({ freshConfig: true }) */
export const test = base.extend<{ book: Book; freshConfig: boolean; fixtureName: string }>({
  freshConfig: [false, { option: true }],
  /** fixtures/ 下用哪本书（都由 scripts/make-fixture.py 按仓库里的《新史學》样本现造）；测旧格式的用例写 test.use({ fixtureName: "新史學-旧格式" }) */
  fixtureName: ["新史學", { option: true }],
  book: async ({ freshConfig, fixtureName }, use) => {
    if (!existsSync(resolve(FIXTURE, "..", fixtureName))) throw new Error(`fixtures/${fixtureName} 不在：先跑 npm run fixture`);
    const base = mkdtempSync(join(tmpdir(), "aih-e2e-"));
    const dir = join(base, fixtureName);
    const configDir = join(base, "config");
    cpSync(resolve(FIXTURE, "..", fixtureName), dir, { recursive: true });
    writeConfig(configDir, freshConfig ? {} : { onboarded: true });
    const workbench = await spawnWorkbench(dir, { configDir });
    const book: Book = {
      dir,
      configDir,
      workbench,
      read: (name) => readFileSync(join(dir, name), "utf8"),
      write: (name, text) => writeFileSync(join(dir, name), text, "utf8"),
      open: async (page, path = "/") => {
        const origin = `http://127.0.0.1:${workbench.port}`;
        await page.goto(`${origin}${path}#token=${workbench.token}`);
        await expect(page.locator(".cm-content")).toContainText(/\S/, { timeout: 20_000 });
        await expect(page.locator(".aih-pdf-container .page canvas").first()).toBeVisible({ timeout: 20_000 });
      },
    };
    await use(book);
    await workbench.close();
    rmSync(base, { recursive: true, force: true });
  },
});

export { expect };

/** 状态栏里的「PDF 第 N 页」 */
export async function statusPage(page: Page): Promise<number> {
  const text = (await page.getByTestId("status-page").textContent()) ?? "";
  return Number(/第 (\d+) 页/.exec(text)?.[1] ?? NaN);
}

/** PDF 一侧基准线（视口距顶 35%）落在第几页 */
export async function pdfPageAtBaseline(page: Page): Promise<number> {
  return page.evaluate(() => {
    const container = document.querySelector<HTMLElement>(".aih-pdf-container")!;
    const rect = container.getBoundingClientRect();
    const y = rect.top + rect.height * 0.35;
    for (const element of Array.from(container.querySelectorAll<HTMLElement>(".page[data-page-number]"))) {
      const box = element.getBoundingClientRect();
      if (box.top <= y && y < box.bottom + 12) return Number(element.dataset.pageNumber);
    }
    return -1;
  });
}

export async function openFileFromMenu(page: Page, name: string): Promise<void> {
  await page.getByTestId("file-menu").click();
  await page.getByRole("menuitem", { name: new RegExp(name) }).click();
  await expect(page.getByTestId("file-menu")).toContainText(name);
}
