import { browser, expect } from "@wdio/globals";
import { before, describe, it } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";
import { BOOK, FILE, openBookFile, settle, windowSize } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 绕过 Obsidian、直接在磁盘上改名或移动（模拟用户在资源管理器里操作），等库察觉 */
async function renameOnDisk(from: string, to: string): Promise<void> {
  await browser.executeObsidian(({ app }, a, b) => {
    const req = (window as unknown as { require: (name: string) => any }).require;
    const fs = req("fs");
    const path = req("path");
    const base: string = (app.vault.adapter as any).getBasePath();
    fs.mkdirSync(path.dirname(path.join(base, b)), { recursive: true });
    fs.renameSync(path.join(base, a), path.join(base, b));
  }, from, to);
  await browser.waitUntil(async () => browser.executeObsidian(({ app }, b) => !!app.vault.getAbstractFileByPath(b), to),
    { timeout: 15_000, timeoutMsg: `库没察觉 ${to}` });
}

/** 右上角带按钮的配对提示：文字与按钮名 */
async function offers(): Promise<Array<{ text: string; action: string }>> {
  return browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>(".notice")).flatMap((notice) => {
    const button = notice.querySelector<HTMLElement>(".aps-notice-action");
    return button ? [{ text: notice.textContent ?? "", action: button.textContent ?? "" }] : [];
  }));
}

async function clearNotices(): Promise<void> {
  await browser.execute(() => document.querySelectorAll(".notice").forEach((notice) => notice.remove()));
}

/** 点提示里的按钮，在配对清单里点确认 */
async function acceptOffer(action: string): Promise<void> {
  await browser.execute((wanted) => {
    const button = Array.from(document.querySelectorAll<HTMLElement>(".notice .aps-notice-action")).find((item) => item.textContent === wanted)!;
    button.click();
  }, action);
  await browser.waitUntil(async () => browser.execute(() => !!document.querySelector(".aps-bind-modal")), { timeoutMsg: "没弹出配对清单" });
  await browser.execute(() => document.querySelector<HTMLElement>(".aps-bind-modal button.mod-cta")!.click());
  await settle(1200);
}

async function frontmatterPdf(path: string): Promise<string | null> {
  return browser.executeObsidian(({ app }, p) => {
    const file = app.vault.getAbstractFileByPath(p) as any;
    return app.metadataCache.getFileCache(file)?.frontmatter?.pdf ?? null;
  }, path);
}

async function bookPdf(): Promise<string | null> {
  return browser.executeObsidian(({ app }) => (app as any).plugins.plugins["aihistory-pdf-sync"].controller.book?.pdf.path ?? null);
}

describe("配对失效：提示与修复", function () {
  before(async function () {
    await windowSize(1600, 1000);
    await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as any).plugins.plugins["aihistory-pdf-sync"];
      plugin.settings.onboarded = true;
      await plugin.saveSettings();
    });
    await openBookFile(FILE("01-中國之舊史"));
  });

  it("在 Obsidian 外改名 PDF：提示还有笔记指着旧名，点「重新配对」确认后 frontmatter 改成新名", async () => {
    await clearNotices();
    await renameOnDisk(`${BOOK}/${BOOK}.pdf`, `${BOOK}/新史學-改名.pdf`);
    await browser.waitUntil(async () => (await offers()).some((offer) => offer.text.includes("新史學-改名.pdf")),
      { timeout: 15_000, timeoutMsg: "没提示改名" });
    const offer = (await offers()).find((item) => item.text.includes("新史學-改名.pdf"))!;
    expect(offer.action).toBe("重新配对");
    // 两章正文与「补锚点」那篇都写着旧名
    expect(offer.text).toContain("3 篇笔记");
    await acceptOffer("重新配对");
    expect(await frontmatterPdf(FILE("01-中國之舊史"))).toBe("[[新史學-改名.pdf]]");
    expect(await frontmatterPdf(FILE("02-史學之界說"))).toBe("[[新史學-改名.pdf]]");
    expect(await bookPdf()).toBe(`${BOOK}/新史學-改名.pdf`);
  });

  it("写的 PDF 找不到、同文件夹里有一份：照常打开，提示「写回笔记」", async () => {
    await clearNotices();
    // 改完磁盘把挪动提示关掉，模拟用户早就挪过、这次才打开
    await renameOnDisk(`${BOOK}/新史學-改名.pdf`, `${BOOK}/又改了.pdf`);
    await settle(1500);
    await clearNotices();
    await obsidianPage.openFile(FILE("新史學"));
    await settle(500);
    await openBookFile(FILE("02-史學之界說"));
    expect(await bookPdf()).toBe(`${BOOK}/又改了.pdf`);
    await browser.waitUntil(async () => (await offers()).some((offer) => offer.action === "写回笔记"),
      { timeout: 10_000, timeoutMsg: "没提示写回笔记" });
    await acceptOffer("写回笔记");
    expect(await frontmatterPdf(FILE("02-史學之界說"))).toBe("[[又改了.pdf]]");
  });

  it("PDF 挪出书文件夹、哪儿都找不到：提示找不到，给「重新配对」", async () => {
    await clearNotices();
    await renameOnDisk(`${BOOK}/又改了.pdf`, "别处/改名后.pdf");
    // 新名字与文件夹都对不上：挪动提示（笔记还指着旧名）与打开时的「找不到」二选一都算提示到了
    await settle(1500);
    await clearNotices();
    await obsidianPage.openFile(FILE("新史學"));
    await settle(500);
    await obsidianPage.openFile(FILE("03-論正統"));
    await browser.waitUntil(async () => (await offers()).some((offer) => offer.text.includes("找不到这本书的 PDF")),
      { timeout: 10_000, timeoutMsg: "没提示找不到" });
    const offer = (await offers()).find((item) => item.text.includes("找不到这本书的 PDF"))!;
    expect(offer.action).toBe("重新配对");
  });
});
