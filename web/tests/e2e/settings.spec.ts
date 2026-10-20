import { createServer } from "node:net";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, FIXTURE, openFileFromMenu, readConfig, spawnRaw, spawnWorkbench, test, TEST_TOKEN, writeConfig } from "./fixtures";

// 顺手拍的图拍的是本机测试材料：放 git 忽略的 .scratch 下，不进仓库
const SHOTS = ".scratch/screenshots";

test.describe("令牌与端口", () => {
  test("令牌存在用户配置文件里，不打印；重启后同一网址照样能用", async ({ page }) => {
    const base = mkdtempSync(join(tmpdir(), "aih-e2e-"));
    const dir = join(base, "书");
    const configDir = join(base, "config");
    cpSync(FIXTURE, dir, { recursive: true });
    try {
      // 没有配置文件：工作台自己生成令牌并写进去
      const first = await spawnWorkbench(dir, { configDir });
      const token = readConfig(configDir).token;
      expect(token.length).toBeGreaterThanOrEqual(16);
      expect(first.log()).not.toContain(token);
      const origin1 = `http://127.0.0.1:${first.port}`;
      expect((await page.request.get(`${origin1}/api/book`, { headers: { "x-aih-token": token } })).status()).toBe(200);
      // 设置接口不交出令牌
      expect(JSON.stringify(await (await page.request.get(`${origin1}/api/settings`, { headers: { "x-aih-token": token } })).json())).not.toContain(token);
      await first.close();
      const second = await spawnWorkbench(dir, { configDir });
      expect(readConfig(configDir).token).toBe(token);
      const origin2 = `http://127.0.0.1:${second.port}`;
      expect((await page.request.get(`${origin2}/api/book`, { headers: { "x-aih-token": token } })).status()).toBe(200);
      await second.close();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("默认端口被占用：明说并退出，不悄悄换端口", async () => {
    const blocker = createServer();
    await new Promise<void>((done) => blocker.listen(0, "127.0.0.1", done));
    const busy = (blocker.address() as { port: number }).port;
    const base = mkdtempSync(join(tmpdir(), "aih-e2e-"));
    const dir = join(base, "书");
    const configDir = join(base, "config");
    cpSync(FIXTURE, dir, { recursive: true });
    writeConfig(configDir, {}, busy);
    try {
      const run = spawnRaw(dir, { configDir, port: null });
      const code = await run.exited;
      expect(code).toBe(1);
      expect(run.output()).toContain(`端口 ${busy} 已被占用`);
      expect(run.output()).toContain("--port");
      expect(run.output()).not.toContain("工作台已启动");
      expect(run.output()).not.toContain(TEST_TOKEN);
    } finally {
      await new Promise<void>((done) => blocker.close(() => done()));
      rmSync(base, { recursive: true, force: true });
    }
  });
});

test.describe("首次引导", () => {
  test.use({ freshConfig: true });

  test("第一次打开弹四步引导；改的选项实时进预览，完成后生效并记进配置；之后不再弹", async ({ page, book }) => {
    await book.open(page);
    const dialog = page.locator(".aps-onboarding");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("第 1 步，共 4 步：布局");
    await dialog.getByRole("button", { name: "右边" }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/10-首次引导.png` });
    for (let i = 0; i < 3; i += 1) await dialog.getByRole("button", { name: "下一步" }).click();
    await expect(dialog).toContainText("第 4 步，共 4 步：开始");
    await expect(dialog).toContainText("新史學");
    await dialog.getByRole("button", { name: "完成" }).click();
    await expect(dialog).toBeHidden();
    const pdfRight = async () => (await page.getByTestId("pdf-pane").boundingBox())!.x > (await page.getByTestId("editor-pane").boundingBox())!.x;
    await expect.poll(pdfRight).toBe(true);
    await expect.poll(() => readConfig(book.configDir).prefs).toMatchObject({ onboarded: true, pdfSide: "right" });
    await book.open(page);
    await page.waitForTimeout(800);
    await expect(page.locator(".aps-onboarding")).toHaveCount(0);
    await expect.poll(pdfRight).toBe(true);
  });

  test("开始导览：在真界面上走三步气泡", async ({ page, book }) => {
    await book.open(page);
    const dialog = page.locator(".aps-onboarding");
    for (let i = 0; i < 3; i += 1) await dialog.getByRole("button", { name: "下一步" }).click();
    await dialog.getByRole("button", { name: "开始导览" }).click();
    const bubble = page.locator(".aps-coach-bubble");
    await expect(bubble).toContainText("这是工具条");
    await page.screenshot({ path: `${SHOTS}/11-导览气泡.png` });
  });
});

test.describe("设置页", () => {
  test("收起 PDF 栏并记住；默认端口改了存进配置、下次启动生效", async ({ page, book }) => {
    await book.open(page);
    await page.getByTestId("open-settings").click();
    const settings = page.getByTestId("settings-dialog");
    await expect(settings).toBeVisible();
    for (const group of ["布局", "联动", "外观", "上手", "本机服务"]) await expect(settings.getByRole("heading", { name: group })).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/12-设置页.png` });
    await settings.getByRole("checkbox", { name: "显示 PDF 栏" }).click();
    await expect(page.getByTestId("pdf-pane")).toHaveCount(0);
    await settings.getByLabel("默认端口").fill("4399");
    await settings.getByRole("button", { name: "保存" }).click();
    await expect(settings.getByRole("status")).toContainText("下次启动用 4399");
    await expect.poll(() => readConfig(book.configDir).port).toBe(4399);
    await expect.poll(() => readConfig(book.configDir).prefs.showPdf).toBe(false);
    // 端口不合法：明说，不存
    await settings.getByLabel("默认端口").fill("80");
    await settings.getByRole("button", { name: "保存" }).click();
    await expect(settings.getByRole("status")).toContainText("1024");
    expect(readConfig(book.configDir).port).toBe(4399);
    // 重新打开：PDF 栏仍收着
    await page.reload();
    await expect(page.locator(".cm-content")).toContainText("新史學", { timeout: 20_000 });
    await expect(page.getByTestId("pdf-pane")).toHaveCount(0);
  });

  test("上手「带我做」：选字后 PDF 高亮，打勾并记下", async ({ page, book }) => {
    await book.open(page);
    await page.getByTestId("open-settings").click();
    await page.locator('.aps-practice-row[data-task="highlight"]').getByRole("button", { name: "带我做" }).click();
    await expect(page.locator(".aps-coach-bubble")).toContainText("选中几个字");
    // 正文里的一行（frontmatter 不在任何页里，选了不高亮）
    await page.locator(".cm-line", { hasText: "梁啟超 著" }).last().click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await expect.poll(() => (readConfig(book.configDir).prefs.practice as { highlight?: boolean } | undefined)?.highlight).toBe(true);
  });
});

test.describe("补页码锚点", () => {
  test("去掉正文锚点后补回：先预览、确认才写，只插锚点不改正文", async ({ page, book }) => {
    const original = book.read("01-正文.md");
    const stripped = original.replace(/<!--pdf-page\.\d+-->(<!--p\.\d+-->)?(\n\n)?/g, "");
    book.write("01-正文.md", stripped);
    await book.open(page);
    await openFileFromMenu(page, "01-正文.md");
    await page.getByRole("button", { name: "补页码锚点" }).click();
    const dialog = page.locator(".aps-pagemark-modal");
    await expect(dialog).toContainText("把握报告", { timeout: 20_000 });
    await page.screenshot({ path: `${SHOTS}/13-补页码锚点预览.png` });
    // 预览阶段磁盘上没动
    expect(book.read("01-正文.md")).toBe(stripped);
    await dialog.getByRole("button", { name: "写入勾选的页" }).click();
    await expect.poll(() => (book.read("01-正文.md").match(/<!--pdf-page\.\d+-->/g) ?? []).length).toBeGreaterThan(4);
    const after = book.read("01-正文.md");
    expect(after.replace(/<!--pdf-page\.\d+-->(\n\n)?/g, "")).toBe(stripped);
    await expect(page.locator(".aih-page-label").first()).toBeVisible();
  });

  test("PDF 没有文字层：说明原因，不硬做", async ({ page, book }) => {
    writeFileSync(join(book.dir, "空白.pdf"), blankPdf(3));
    book.write("02-附录.md", '---\npdf: "[[空白.pdf]]"\n---\n\n附录正文，没有锚点。\n');
    await book.open(page);
    await openFileFromMenu(page, "02-附录.md");
    await expect(page.locator(".aps-total")).toHaveText("/3", { timeout: 20_000 });
    await page.getByRole("button", { name: "补页码锚点" }).click();
    const explain = page.getByRole("alertdialog", { name: "这份 PDF 没有文字层" });
    await expect(explain).toContainText("lunzhu2md");
    await expect(page.locator(".aps-pagemark-modal")).toHaveCount(0);
    expect(book.read("02-附录.md")).not.toContain("pdf-page");
  });
});

/** 造一份只有空白页、没有文字层的 PDF */
function blankPdf(pages: number): Buffer {
  const objects: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let i = 0; i < pages; i += 1) objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>");
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
