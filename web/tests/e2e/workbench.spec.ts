import { expect, openFileFromMenu, pdfPageAtBaseline, statusPage, test } from "./fixtures";

// 顺手拍的图拍的是本机测试材料：放 git 忽略的 .scratch 下，不进仓库
const SHOTS = ".scratch/screenshots";

test("打开多文件书：两栏就绪、按 book.json 列出成员、工具条显示总页数", async ({ page, book }) => {
  await book.open(page);
  await expect(page.locator(".aih-title")).toHaveText("新史學");
  await expect(page.getByTestId("file-menu")).toContainText("00-卷首.md");
  await expect(page.locator(".aps-total")).toHaveText("/23");
  await expect(page.locator(".aih-page-label").first()).toHaveText("1");
  await page.getByTestId("file-menu").click();
  await expect(page.getByRole("menuitem", { name: /01-正文\.md/ })).toContainText("PDF 5–11");
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${SHOTS}/01-打开书.png` });

  // 换边：PDF 从左换到右
  const pdfLeft = async () => (await page.getByTestId("pdf-pane").boundingBox())!.x < (await page.getByTestId("editor-pane").boundingBox())!.x;
  expect(await pdfLeft()).toBe(true);
  await page.getByRole("button", { name: /PDF 在左/ }).click();
  await expect.poll(pdfLeft).toBe(false);
});

test("单向：手动翻 PDF 不带正文；回到正文一滚又带动 PDF", async ({ page, book }) => {
  await book.open(page);
  await openFileFromMenu(page, "01-正文.md");
  await page.getByRole("button", { name: /单向/ }).click();
  const before = await page.evaluate(() => document.querySelector<HTMLElement>(".aih-editor .cm-scroller")!.scrollTop);
  await page.locator(".aih-pdf-container").hover();
  for (let i = 0; i < 8; i += 1) await page.mouse.wheel(0, 600);
  await expect.poll(() => pdfPageAtBaseline(page)).toBeGreaterThan(5);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => document.querySelector<HTMLElement>(".aih-editor .cm-scroller")!.scrollTop)).toBe(before);
  await page.locator(".aih-editor .cm-scroller").hover();
  await page.mouse.wheel(0, 300);
  await expect.poll(async () => (await pdfPageAtBaseline(page)) === (await statusPage(page))).toBe(true);
});

test("正文 → PDF 跟随；◀ ▶ 两边一起翻；PDF → 正文跨文件", async ({ page, book }) => {
  await book.open(page);
  await openFileFromMenu(page, "01-正文.md");
  const editor = page.locator(".aih-editor .cm-scroller");
  await editor.hover();
  for (let i = 0; i < 12; i += 1) await page.mouse.wheel(0, 500);
  await expect.poll(() => statusPage(page)).toBeGreaterThan(5);
  const mdPage = await statusPage(page);
  await expect.poll(() => pdfPageAtBaseline(page)).toBe(mdPage);
  await page.screenshot({ path: `${SHOTS}/02-正文带动PDF.png` });

  // ▶：两边一起到下一页，当前页加底色
  await page.getByRole("button", { name: "下一页（两边一起翻）" }).click();
  await expect.poll(() => statusPage(page)).toBe(mdPage + 1);
  await expect.poll(() => pdfPageAtBaseline(page)).toBe(mdPage + 1);
  await expect(page.locator(".cm-line.aih-current-page").first()).toBeVisible();

  // 翻回第 5 页：第 5 页两个文件都有（正文开头是续页锚点），按书内顺序取卷首
  await page.getByLabel("跳到 PDF 第几页").fill("5");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("file-menu")).toContainText("00-卷首.md", { timeout: 10_000 });
  // 等跳页落定再滚（换文件、跳页带来的滚动不算用户滚动；紧接着滚，这几下会被一起忽略）
  await expect.poll(() => statusPage(page)).toBe(5);
  await page.waitForTimeout(600);

  // 双向：在卷首里往下滚 PDF 到第 6 页以后，正文自动换到 01-正文
  const pdf = page.locator(".aih-pdf-container");
  await pdf.hover();
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(100);
  }
  await expect.poll(() => pdfPageAtBaseline(page)).toBeGreaterThan(5);
  await expect(page.getByTestId("file-menu")).toContainText("01-正文.md", { timeout: 10_000 });
  await expect.poll(async () => (await statusPage(page)) === (await pdfPageAtBaseline(page))).toBe(true);
});

test("编辑后自动存回硬盘", async ({ page, book }) => {
  await book.open(page);
  await openFileFromMenu(page, "01-正文.md");
  await page.locator(".cm-line", { hasText: "今請舉中國史學" }).first().click();
  await page.keyboard.type("【网页编辑】");
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 10_000 });
  await expect.poll(() => book.read("01-正文.md")).toContain("【网页编辑】");
  // 磁盘上的内容与编辑器里的逐字相同
  const editorText = await page.evaluate(() => (window as unknown as { __aihEditor?: { state: { doc: { toString(): string } } } }).__aihEditor?.state.doc.toString());
  expect(editorText).toBeDefined();
  expect(book.read("01-正文.md")).toBe(editorText);
});

test("外部（Claude）改了文件，网页即时刷新", async ({ page, book }) => {
  await book.open(page);
  await openFileFromMenu(page, "01-正文.md");
  const before = book.read("01-正文.md");
  book.write("01-正文.md", before.replace("今請舉中國史學之派別", "【Claude 改过】今請舉中國史學之派別"));
  await expect(page.locator(".cm-content")).toContainText("【Claude 改过】今請舉中國史學", { timeout: 10_000 });
  await expect(page.getByTestId("notice").filter({ hasText: "已刷新" })).toBeVisible();
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
  await page.screenshot({ path: `${SHOTS}/03-外部改动即时刷新.png` });
});

test("冲突：网页有未存改动时磁盘又被改，弹出差异让用户选；选「保留网页里的」才覆盖", async ({ page, book }) => {
  await book.open(page);
  await openFileFromMenu(page, "01-正文.md");
  await page.locator(".cm-line", { hasText: "今請舉中國史學" }).first().click();
  await page.keyboard.type("【网页这边】");
  // 存盘有 0.7 秒防抖：趁还没存，磁盘上先被改
  book.write("01-正文.md", book.read("01-正文.md").replace("今請舉中國史學", "【磁盘那边】今請舉中國史學"));
  const dialog = page.getByTestId("conflict-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("conflict-diff")).toContainText("【网页这边】");
  await expect(page.getByTestId("conflict-diff")).toContainText("【磁盘那边】");
  // 用户选之前，磁盘上仍是外部改的版本
  expect(book.read("01-正文.md")).toContain("【磁盘那边】");
  expect(book.read("01-正文.md")).not.toContain("【网页这边】");
  await page.waitForTimeout(600); // 等弹出动效走完
  await page.screenshot({ path: `${SHOTS}/04-冲突对话框.png` });
  await page.getByTestId("conflict-keep-mine").click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => book.read("01-正文.md")).toContain("【网页这边】");
  expect(book.read("01-正文.md")).not.toContain("【磁盘那边】");
});

test("冲突：选「用磁盘上的」就丢掉网页里的改动", async ({ page, book }) => {
  await book.open(page);
  await openFileFromMenu(page, "01-正文.md");
  await page.locator(".cm-line", { hasText: "今請舉中國史學" }).first().click();
  await page.keyboard.type("【网页这边】");
  book.write("01-正文.md", book.read("01-正文.md").replace("今請舉中國史學", "【磁盘那边】今請舉中國史學"));
  await expect(page.getByTestId("conflict-dialog")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("conflict-take-disk").click();
  await expect(page.locator(".cm-content")).toContainText("【磁盘那边】");
  await expect(page.locator(".cm-content")).not.toContainText("【网页这边】");
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
  expect(book.read("01-正文.md")).not.toContain("【网页这边】");
});

test("疑字清单链接：/open 路由跳到对应页并选中那个字（库内路径按后缀认）", async ({ page, book }) => {
  await book.open(page);
  const query = new URLSearchParams({ file: "书/新史學/01-正文.md", page: "8", text: "而已", ctx: "正史而已" });
  await page.goto(`http://127.0.0.1:${book.workbench.port}/open?${query.toString()}`);
  await expect(page.getByTestId("file-menu")).toContainText("01-正文.md", { timeout: 20_000 });
  await expect.poll(() => statusPage(page)).toBe(8);
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() || document.querySelector(".cm-selectionBackground") !== null))
    .toBeTruthy();
  await expect.poll(() => pdfPageAtBaseline(page)).toBe(8);
  await expect(page.locator(".aih-hl").first()).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: `${SHOTS}/05-疑字链接与逐字高亮.png` });
});

test("Ctrl + 点击疑字清单里的 obsidian:// 链接，在网页里打开", async ({ page, book }) => {
  await book.open(page);
  await openFileFromMenu(page, "疑字清单");
  const link = page.locator(".aih-suspect-link").first();
  await expect(link).toBeVisible();
  await link.click({ modifiers: ["Control"] });
  await expect(page.getByTestId("file-menu")).toContainText("01-正文.md", { timeout: 10_000 });
  await expect.poll(() => statusPage(page)).toBe(7);
});

test("全文搜索同时搜正文与 PDF 文字层", async ({ page, book }) => {
  await book.open(page);
  await page.getByLabel("搜索正文与 PDF").fill("蠟人院之偶像");
  const results = page.getByTestId("search-results");
  await expect(results.locator(".aih-badge-md").first()).toBeVisible();
  await expect(results.locator(".aih-badge-pdf").first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/06-全文搜索.png` });
  await results.locator(".aih-search-hit", { has: page.locator(".aih-badge-pdf") }).first().click();
  await expect(page.getByTestId("file-menu")).toContainText("01-正文.md");
  await expect(page.locator(".aih-hl").first()).toBeVisible({ timeout: 10_000 });
});

test("接口不带令牌一律拒绝", async ({ page, book }) => {
  const origin = `http://127.0.0.1:${book.workbench.port}`;
  const res = await page.request.get(`${origin}/api/book`);
  expect(res.status()).toBe(401);
  const evil = await page.request.get(`${origin}/api/file?path=${encodeURIComponent("../../x.md")}`, { headers: { "x-aih-token": book.workbench.token } });
  expect(evil.status()).toBe(403);
});

test("逐字高亮：在 PDF 上选字，正文里选中同一处", async ({ page, book }) => {
  await book.open(page);
  await page.getByLabel("跳到 PDF 第几页").fill("7");
  await page.keyboard.press("Enter");
  await expect.poll(() => pdfPageAtBaseline(page)).toBe(7);
  // 知网 PDF 的文字层一两个字一块：从正文区第 40 块起往右拖一小段（别拖出 PDF 栏）
  const span = page.locator('.page[data-page-number="7"] .textLayer span').filter({ hasText: /[一-鿿]/ }).nth(30);
  await expect(span).toBeAttached({ timeout: 10_000 });
  const box = (await span.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 70, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const picked = await page.evaluate(() => (window.getSelection()?.toString() ?? "").replace(/[^一-鿿]/g, ""));
  expect(picked.length).toBeGreaterThan(3);
  await expect(page.getByTestId("file-menu")).toContainText("01-正文.md");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const view = (window as unknown as { __aihEditor?: { state: { selection: { main: { from: number; to: number } }; sliceDoc(a: number, b: number): string } } }).__aihEditor;
        if (!view) return "";
        const { from, to } = view.state.selection.main;
        return view.state.sliceDoc(from, to).replace(/[^一-鿿]/g, "");
      })
    )
    .toContain(picked.slice(0, 3));
});

test("截图：暗色、工具条收起与拖开悬浮时的停靠区", async ({ page, book }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await book.open(page);
  await openFileFromMenu(page, "01-正文.md");
  await page.getByRole("button", { name: "下一页（两边一起翻）" }).click();
  await page.getByRole("button", { name: "下一页（两边一起翻）" }).click();
  await page.screenshot({ path: `${SHOTS}/07-暗色.png` });
  // 拖开工具条：各窗格顶部出现虚线停靠区
  const grip = page.getByLabel("拖动工具条");
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 260, { steps: 10 });
  await expect(page.locator(".aps-dock-zone")).toHaveCount(2);
  await page.screenshot({ path: `${SHOTS}/08-拖动工具条.png` });
  await page.mouse.up();
  await expect(page.locator(".aps-toolbar.aps-floating")).toBeVisible();
  await page.getByRole("button", { name: "收起成小标" }).click();
  await expect(page.locator(".aps-toolbar.aps-collapsed")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/09-工具条收起.png` });
});

test("改绑 PDF：选 PDF、勾文件，写进 frontmatter 的 pdf", async ({ page, book }) => {
  // 先把卷首的 pdf 字段删掉，看改绑能否写回
  book.write("00-卷首.md", book.read("00-卷首.md").replace(/^pdf:.*\n/m, ""));
  await book.open(page);
  await page.getByRole("button", { name: "更多：缩放、配对 PDF" }).click();
  await page.getByRole("menuitem", { name: /配对：/ }).click();
  await page.getByRole("dialog", { name: "选 PDF" }).getByRole("button", { name: /新史學\.pdf/ }).click();
  await page.getByRole("button", { name: "写入" }).click();
  await expect.poll(() => book.read("00-卷首.md")).toContain('pdf: "[[新史學.pdf]]"');
  expect(book.read("01-正文.md").match(/^pdf:/gm)?.length).toBe(1);
});
