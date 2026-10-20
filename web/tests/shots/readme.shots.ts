import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { spawnWorkbench, writeConfig, openFileFromMenu, type Workbench } from "../e2e/fixtures";

// README 截图（不是测试）：书拷到临时目录，配置目录也是临时的，不碰用户的配置文件。
// 镜头（选的句子、疑字链接、冲突示例）按演示书《新史學》取景。用法见 shots.config.ts。
const DEMO = process.env.APS_DEMO_BOOK ?? "";
if (!DEMO || !existsSync(join(DEMO, "_数据", "book.json"))) throw new Error("请用环境变量 APS_DEMO_BOOK 指向一本 lunzhu2md 导入的书文件夹（要有 _数据/book.json）");
const OUT = resolve(process.env.APS_SHOTS ?? ".scratch/shots/web");
mkdirSync(OUT, { recursive: true });
const BOOK = basename(DEMO);

interface Book { dir: string; workbench: Workbench; read: (n: string) => string; write: (n: string, t: string) => void; open: (page: Page, path?: string) => Promise<void> }

const test = base.extend<{ book: Book; strip02: boolean; prefs: Record<string, unknown> }>({
  strip02: [false, { option: true }],
  prefs: [{ onboarded: true }, { option: true }],
  book: async ({ strip02, prefs }, use) => {
    const root = mkdtempSync(join(tmpdir(), "aih-shots-"));
    const dir = join(root, BOOK);
    const configDir = join(root, "config");
    cpSync(DEMO, dir, { recursive: true, filter: (src) => !/[\\/]_数据[\\/](MinerU|PaddleOCR|PaddleOCR行框|文字层|过程报告)/.test(src) });
    if (strip02) {
      const p = join(dir, "02-史學之界說.md");
      writeFileSync(p, readFileSync(p, "utf8").replace(/<!--pdf-page\.\d+-->(<!--p\.\d+-->)?(\n\n)?/g, ""), "utf8");
    }
    writeConfig(configDir, prefs);
    const workbench = await spawnWorkbench(dir, { configDir });
    await use({
      dir,
      workbench,
      read: (n) => readFileSync(join(dir, n), "utf8"),
      write: (n, t) => writeFileSync(join(dir, n), t, "utf8"),
      open: async (page, path = "/") => {
        await page.goto(`http://127.0.0.1:${workbench.port}${path}#token=${workbench.token}`);
        await expect(page.locator(".aih-pdf-container .page canvas").first()).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(1200);
      },
    });
    await workbench.close();
    rmSync(root, { recursive: true, force: true });
  },
});

test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 });

test("01 主界面：多文件书、按页跟随、页码标签", async ({ page, book }) => {
  await book.open(page);
  await openFileFromMenu(page, "02-史學之界說.md");
  await page.locator(".cm-line", { hasText: "欲創新史學" }).first().click();
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/01-主界面.png` });
});

test("04 疑字链接：/open 跳到原页、选中现字", async ({ page, book }) => {
  const q = new URLSearchParams({ file: `${BOOK}/01-中國之舊史.md`, page: "7", text: "已", ctx: "四姓之家譜而已。其言似稍過" });
  await book.open(page, `/open?${q}`);
  await expect(page.getByTestId("file-menu")).toContainText("01-中國之舊史.md", { timeout: 20_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/04-疑字链接.png` });
});

test("03 冲突提示：网页未存时 Claude 改了磁盘", async ({ page, book }) => {
  await book.open(page);
  await openFileFromMenu(page, "01-中國之舊史.md");
  await page.locator(".cm-line", { hasText: "本書為 AIhistory1012" }).first().click();
  await page.keyboard.press("End");
  await page.keyboard.type("（網頁這邊加的按語）");
  book.write("01-中國之舊史.md", book.read("01-中國之舊史.md").replace("二十四姓之家譜而已", "二十四姓之家譜而己"));
  await expect(page.getByTestId("conflict-dialog")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/03-冲突提示.png` });
  await page.getByTestId("conflict-take-disk").click();
});

test.describe("补页码锚点", () => {
  test.use({ strip02: true });
  test("02 补页码锚点预览", async ({ page, book }) => {
    await book.open(page);
    await openFileFromMenu(page, "02-史學之界說.md");
    await page.getByRole("button", { name: "补页码锚点" }).click();
    await expect(page.locator(".aps-pagemark-modal")).toContainText("把握报告", { timeout: 20_000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT}/02-补页码锚点预览.png` });
  });
});

test.describe("首次引导", () => {
  test.use({ prefs: {} });
  test("05 首次引导", async ({ page, book }) => {
    await page.goto(`http://127.0.0.1:${book.workbench.port}/#token=${book.workbench.token}`);
    await expect(page.locator(".aps-onboarding")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/05-首次引导.png` });
  });
});
