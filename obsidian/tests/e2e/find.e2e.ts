import { browser, expect } from "@wdio/globals";
import { before, describe, it } from "mocha";
import { openBookFile, settle, windowSize } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

// 繁简通搜：公版小样书（梁启超《中国历史研究法》首章开头，测试时现造）。PDF 是简体，查询用繁体。
const NOTE = "中国历史研究法/中国历史研究法.md";

async function focusPdf(): Promise<void> {
  await browser.executeObsidian(({ app }) => {
    const leaf = (app as any).plugins.plugins["aihistory-pdf-sync"].controller.pdf.leaf;
    app.workspace.setActiveLeaf(leaf, { focus: true });
  });
  await settle(300);
}

async function setTakeover(value: boolean): Promise<void> {
  await browser.executeObsidian(async ({ app }, v) => {
    const plugin = (app as any).plugins.plugins["aihistory-pdf-sync"];
    plugin.settings.findTakeover = v;
    await plugin.saveSettings();
  }, value);
}

async function search(query: string): Promise<string> {
  const input = browser.$(".aps-find-input");
  await input.setValue(query);
  await browser.keys("Enter");
  await browser.waitUntil(async () => /第 \d+ \/ \d+ 处|没有找到/.test(await browser.$(".aps-find-count").getText()), { timeout: 20_000 });
  return browser.$(".aps-find-count").getText();
}

async function pdfPage(): Promise<number> {
  return browser.executeObsidian(({ app }) => (app as any).plugins.plugins["aihistory-pdf-sync"].controller.pdf.currentPage);
}

describe("繁简通搜（PDF）", () => {
  before(async function () {
    await windowSize(1600, 1000);
    // 本文件不测首次引导：先标成已引导过，免得引导窗挡住
    await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as any).plugins.plugins["aihistory-pdf-sync"];
      plugin.settings.onboarded = true;
      await plugin.saveSettings();
    });
  });

  it("PDF 窗格里 Ctrl+F 打开繁简通搜；繁体查询命中简体文字层，跨行、跨页都找得到，并高亮", async () => {
    await openBookFile(NOTE);
    await focusPdf();
    await browser.keys(["Control", "f"]);
    await expect(browser.$(".aps-find")).toBeDisplayed();

    // 跨行：「赓 / 续」在文字层里分两行
    expect(await search("賡續活動")).toBe("第 1 / 1 处");
    await browser.waitUntil(async () => (await browser.$$(".aps-hl").length) > 0, { timeout: 10_000, timeoutMsg: "没有高亮框" });
    expect(await pdfPage()).toBe(1);

    // 跨页：「因果」在第 1 页末、「关系」在第 2 页首
    expect(await search("因果關係")).toBe("第 1 / 1 处");

    // 多处：Enter 到下一处，PDF 翻到第 2 页（「鑒」与「鉴」在繁简档里同组；「鑑」要开语义档才连上）
    expect(await search("資鑒")).toBe("第 1 / 2 处");
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await browser.$(".aps-find-count").getText()) === "第 2 / 2 处");
    await browser.waitUntil(async () => (await pdfPage()) === 2, { timeout: 10_000, timeoutMsg: "没翻到第 2 页" });

    expect(await search("司馬遷")).toBe("没有找到");
    await browser.keys("Escape");
    await expect(browser.$(".aps-find")).not.toBeExisting();
  });

  it("工具条「搜」按钮也能打开；设置关掉接管后，PDF 里的 Ctrl+F 不再打开繁简通搜", async () => {
    await openBookFile(NOTE);
    await browser.$(".aps-toolbar .aps-find-open").click();
    await expect(browser.$(".aps-find")).toBeDisplayed();
    await browser.keys("Escape");
    await expect(browser.$(".aps-find")).not.toBeExisting();

    await setTakeover(false);
    await focusPdf();
    await browser.keys(["Control", "f"]);
    await settle(500);
    await expect(browser.$(".aps-find")).not.toBeExisting();
    await browser.keys("Escape");
    await setTakeover(true);
  });
});
