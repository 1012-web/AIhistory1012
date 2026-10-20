import { expect, pdfPageAtBaseline, statusPage, test } from "./fixtures";

// 旧格式小样书：正文只有印刷页锚点 <!--p.M-->，book.json 第 1 版给 printedPageOffset（-106）。
// 共用的 core/cm-sync.ts 按偏移换算物理页（物理页 = 印刷页 + 偏移），跟随要准。
test.use({ fixtureName: "新史學-旧格式" });

test("旧格式（只有印刷页锚点）：按 printedPageOffset 换算，正文 → PDF、PDF → 正文都跟得准", async ({ page, book }) => {
  await book.open(page);
  await expect(page.locator(".aps-total")).toHaveText("/23");

  // 正文往下滚：PDF 跟到同一物理页
  const editor = page.locator(".aih-editor .cm-scroller");
  await editor.hover();
  for (let i = 0; i < 12; i += 1) await page.mouse.wheel(0, 500);
  await expect.poll(() => statusPage(page)).toBeGreaterThan(2);
  const mdPage = await statusPage(page);
  await expect.poll(() => pdfPageAtBaseline(page)).toBe(mdPage);

  // 页码标签显示换算出来的物理页与原来的印刷页
  await expect(page.locator(".aih-page-label").filter({ hasText: `${mdPage} · p.${mdPage - 4}` }).first()).toBeAttached();

  // 跳页：两边一起到第 8 页
  await page.getByLabel("跳到 PDF 第几页").fill("8");
  await page.keyboard.press("Enter");
  await expect.poll(() => pdfPageAtBaseline(page)).toBe(8);
  await expect.poll(() => statusPage(page)).toBe(8);

  // PDF 往回滚到第 6 页：正文跟回去。一下一下滚，停在第 6 页就比：
  // 别滚到第 1–4 页（卷首这几页旧格式文件里没有印刷页锚点，正文本来就跟不了）；
  // 也别停在两页交界（锚点夹在长段中间时，正文按整行算页，交界处会差一页，已知问题）
  await page.locator(".aih-pdf-container").hover();
  for (let i = 0; i < 12 && (await pdfPageAtBaseline(page)) > 6; i += 1) {
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(250);
  }
  expect(await pdfPageAtBaseline(page)).toBe(6);
  await expect.poll(async () => (await statusPage(page)) === (await pdfPageAtBaseline(page))).toBe(true);
});
