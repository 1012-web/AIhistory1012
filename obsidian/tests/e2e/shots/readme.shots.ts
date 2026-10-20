import { browser, expect } from "@wdio/globals";
import { describe, it, before } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { openBookFile, points, setMode, settle, windowSize } from "../helpers";

// README 截图：镜头（页码、选的句子、疑字链接）按演示书《新史學》取景；换别的书要改这些参数。用法见 shots.conf.mts。

/* eslint-disable @typescript-eslint/no-explicit-any */

const PLUGIN = "aihistory-pdf-sync";
const BOOK = path.basename(process.env.APS_DEMO_BOOK ?? "新史學");
const FILE = (name: string) => `${BOOK}/${name}.md`;
const OUT = path.resolve(process.env.APS_SHOTS ?? ".scratch/shots/obsidian");
mkdirSync(OUT, { recursive: true });

async function shot(name: string): Promise<void> {
  await settle(400);
  await browser.saveScreenshot(`${OUT}/${name}.png`);
}

async function clickText(text: string, scope = ".aps-onboarding"): Promise<void> {
  await browser.waitUntil(async () => browser.executeObsidian((_, wanted, root) => {
    const button = [...document.querySelectorAll<HTMLElement>(`${root} button`)].find((el) => el.textContent?.trim() === wanted);
    button?.click();
    return !!button;
  }, text, scope), { timeout: 5000, interval: 200, timeoutMsg: `找不到按钮「${text}」` });
  await browser.pause(350);
}

async function jump(page: number): Promise<void> {
  await browser.executeObsidian(async ({ app }, p) => {
    await (app as any).plugins.plugins["aihistory-pdf-sync"].controller.jumpToPage(p);
  }, page);
  await settle(800);
}

async function scrollMarkdown(ratio: number): Promise<void> {
  await browser.executeObsidian(({ app }, r) => {
    const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
    const scroller: HTMLElement = controller.scroller;
    scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * r;
  }, ratio);
  await settle(900);
}

async function openSettingsTab(): Promise<void> {
  await browser.executeObsidian(async ({ app }, id) => {
    const setting = (app as any).setting;
    setting.open();
    setting.openTabById(id);
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }, PLUGIN);
}

describe("README 截图（演示书《新史學》）", function () {
  before(async function () {
    await windowSize(1600, 1000);
  });

  it("08 首次引导", async () => {
    await obsidianPage.openFile(FILE("01-中國之舊史"));
    await browser.waitUntil(async () => browser.executeObsidian(() => !!document.querySelector(".aps-onboarding")), { timeout: 30_000, timeoutMsg: "引导没弹出来" });
    await settle(800);
    await shot("08-首次引导");
    await clickText("跳过，以后在设置里重开");
    await settle(600);
  });

  it("01 实时预览跟随、02 阅读视图跟随", async () => {
    await openBookFile(FILE("02-史學之界說"));
    await setMode("live");
    await scrollMarkdown(0.35);
    const now = await points();
    expect(now.pdf?.page).toBe(now.markdown?.page);
    await shot("01-实时预览跟随");
    await setMode("preview");
    await scrollMarkdown(0.55);
    await shot("02-阅读视图跟随");
    await setMode("live");
  });

  it("03 逐字高亮", async () => {
    await jump(12);
    const phrase = "欲創新史學，不可不先明史學之界說";
    const ok = await browser.executeObsidian(async ({ app }, text) => {
      const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
      const editor = controller.markdownView.editor;
      const from = editor.getValue().indexOf(text);
      editor.setSelection(editor.offsetToPos(from), editor.offsetToPos(from + text.length));
      return controller.onMarkdownSelection();
    }, phrase);
    expect(ok).toBe(true);
    await browser.waitUntil(async () => browser.executeObsidian(() => document.querySelectorAll('.page[data-page-number="12"] .aps-hl').length > 0), { timeout: 5000, timeoutMsg: "第 12 页没有高亮" });
    await shot("03-逐字高亮");
  });

  it("04 页码标签与底色、05 工具条停靠", async () => {
    await openBookFile(FILE("01-中國之舊史"));
    await setMode("live");
    await jump(7);
    const labels = await browser.executeObsidian(() => [...document.querySelectorAll(".aps-page-label")].map((el) => el.textContent));
    expect(labels).toContain("7 · p.3");
    await shot("04-页码标签与底色");
    await shot("05-工具条停靠");
  });

  it("06 工具条悬浮", async () => {
    await browser.executeObsidian(async () => {
      const handle = document.querySelector<HTMLElement>(".aps-toolbar .aps-grip")!;
      const start = handle.getBoundingClientRect();
      const fire = (target: EventTarget, type: string, cx: number, cy: number) =>
        target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, buttons: 1, clientX: cx, clientY: cy }));
      fire(handle, "pointerdown", start.left + 2, start.top + 2);
      fire(document, "pointermove", start.left + 20, start.top + 20);
      fire(document, "pointermove", 560, 420);
      fire(document, "pointerup", 560, 420);
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    await shot("06-工具条悬浮");
    await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as any).plugins.plugins["aihistory-pdf-sync"];
      plugin.settings.toolbar = { mode: "docked", dock: "markdown", x: 120, y: 120, collapsed: false };
      await plugin.saveSettings();
      plugin.settingsChanged();
    });
    await settle(600);
  });

  it("12 疑字清单链接跳到原页", async () => {
    await browser.executeObsidian(async ({ app }, file) => {
      const handler = (app as any).workspace.protocolHandler?.handlers?.get?.("aihistory-pdf-sync");
      handler({ action: "aihistory-pdf-sync", file, page: "7", text: "已", ctx: "四姓之家譜而已。其言似稍過" });
    }, FILE("01-中國之舊史"));
    await browser.waitUntil(async () => browser.executeObsidian(() => document.querySelectorAll('.page[data-page-number="7"] .aps-hl').length > 0), { timeout: 8000, timeoutMsg: "第 7 页没有高亮" });
    await shot("12-疑字链接");
  });

  it("07 补锚点预览", async () => {
    await browser.executeObsidian(async ({ app }) => {
      const file = app.vault.getAbstractFileByPath("补锚点/無錨點筆記.md");
      await (app as any).plugins.plugins["aihistory-pdf-sync"].controller.markdownLeaf.openFile(file as any);
    });
    await browser.waitUntil(async () => browser.executeObsidian(({ app }) => {
      const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
      return controller.markdownView?.file?.path === "补锚点/無錨點筆記.md" && !!controller.pdf?.ready;
    }), { timeout: 30_000, timeoutMsg: "无锚点笔记没接管" });
    await browser.executeObsidian(async ({ app }) => {
      await (app as any).plugins.plugins["aihistory-pdf-sync"].controller.openPagemarkPreview();
    });
    await browser.waitUntil(async () => browser.executeObsidian(() => document.querySelectorAll(".aps-pagemark-table tbody tr").length > 0), { timeout: 30_000, timeoutMsg: "预览表没出来" });
    const rows = await browser.executeObsidian(() => [...document.querySelectorAll(".aps-pagemark-table tbody tr")].map((row) => row.textContent));
    console.log(rows.join("\n"));
    await shot("07-补锚点预览");
    await browser.executeObsidian(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle(500);
  });

  it("09 设置页", async () => {
    await openBookFile(FILE("02-史學之界說"));
    await openSettingsTab();
    const main = await browser.getWindowHandle();
    for (const handle of await browser.getWindowHandles()) {
      if (handle === main) continue;
      await browser.switchToWindow(handle);
      if (await browser.execute(() => !!document.querySelector(".aps-settings-head"))) {
        await settle(600);
        await browser.saveScreenshot(`${OUT}/09-设置页.png`);
        break;
      }
    }
    await browser.switchToWindow(main);
    await browser.executeObsidian(({ app }) => (app as any).setting.close());
    await settle(500);
  });

  it("10 导览气泡", async () => {
    await browser.executeObsidian(({ app }, id) => (app as any).commands.executeCommandById(`${id}:open-onboarding`), PLUGIN);
    await browser.waitUntil(async () => browser.executeObsidian(() => !!document.querySelector(".aps-onboarding")), { timeoutMsg: "命令没弹出引导" });
    await clickText("下一步");
    await clickText("下一步");
    await clickText("下一步");
    await browser.executeObsidian((_, book) => {
      const row = [...document.querySelectorAll<HTMLElement>(".aps-ob-book")].find((el) => el.textContent?.includes(book))!;
      row.querySelector<HTMLElement>("button")!.click();
    }, BOOK);
    await browser.waitUntil(async () => browser.executeObsidian(() => !!document.querySelector(".aps-coach-bubble")), { timeout: 20_000, timeoutMsg: "导览气泡没出来" });
    await settle(900);
    await shot("10-导览气泡");
    for (let i = 0; i < 3; i += 1) await clickText(i < 2 ? "下一个" : "完成", ".aps-coach-bubble");
    await settle(400);
  });

  it("11 带我做", async () => {
    await openBookFile(FILE("02-史學之界說"));
    await openSettingsTab();
    await browser.executeObsidian(({ app }) => (app as any).setting.activeTab.containerEl.querySelector('.aps-practice-row[data-task="highlight"] button').click());
    await browser.waitUntil(async () => browser.executeObsidian(() => !!document.querySelector(".aps-coach-bubble")), { timeoutMsg: "带我做的提示没出来" });
    await browser.executeObsidian(async ({ app }, id) => {
      const controller = (app as any).plugins.plugins[id].controller;
      const editor = controller.markdownView.editor;
      const value: string = editor.getValue();
      const from = value.indexOf("欲創新史學");
      editor.setSelection(editor.offsetToPos(from), editor.offsetToPos(from + 5));
      await controller.onMarkdownSelection();
    }, PLUGIN);
    await browser.waitUntil(async () => browser.executeObsidian(() => !!document.querySelector(".aps-coach-done")), { timeoutMsg: "没显示做到了" });
    await shot("11-带我做");
  });
});
