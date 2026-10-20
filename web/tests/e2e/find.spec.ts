import { expect, pdfPageAtBaseline, test } from "./fixtures";

// 繁简通搜：公版小样书（梁启超《中国历史研究法》首章开头，测试时现造）。PDF 是简体，查询用繁体。
test.use({ fixtureName: "中国历史研究法" });

test("繁简通搜：PDF 栏里 Ctrl+F 打开；繁体命中简体，跨行、跨页都找得到并高亮；正文栏的 Ctrl+F 不接管", async ({ page, book }) => {
  await book.open(page);
  const find = page.locator(".aps-find");
  const count = page.locator(".aps-find-count");
  const search = async (query: string) => {
    await page.locator(".aps-find-input").fill(query);
    await page.keyboard.press("Enter");
    await expect(count).toHaveText(/第 \d+ \/ \d+ 处|没有找到/, { timeout: 20_000 });
    return count.textContent();
  };

  // 正文栏里按 Ctrl+F：不接管（交给浏览器）
  await page.locator(".aih-editor .cm-content").click();
  await page.keyboard.press("Control+f");
  await expect(find).toHaveCount(0);

  // PDF 栏里按 Ctrl+F：打开繁简通搜
  await page.locator(".aih-pdf-container").click({ position: { x: 20, y: 20 } });
  await page.keyboard.press("Control+f");
  await expect(find).toBeVisible();

  expect(await search("賡續活動")).toBe("第 1 / 1 处");
  await expect(page.locator(".aih-hl").first()).toBeVisible();
  expect(await search("因果關係")).toBe("第 1 / 1 处");
  expect(await search("資鑒")).toBe("第 1 / 2 处");
  await page.keyboard.press("Enter");
  await expect(count).toHaveText("第 2 / 2 处");
  await expect.poll(() => pdfPageAtBaseline(page)).toBe(2);
  expect(await search("司馬遷")).toBe("没有找到");
  await page.keyboard.press("Escape");
  await expect(find).toHaveCount(0);

  // 工具条「搜」按钮
  await page.locator(".aps-toolbar .aps-find-open").click();
  await expect(find).toBeVisible();
});
