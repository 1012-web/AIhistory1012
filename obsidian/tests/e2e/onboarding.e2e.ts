import { browser, expect } from "@wdio/globals";
import { before, describe, it } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";
import { FILE, SCREENSHOTS, settle, windowSize } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

const PLUGIN = "aihistory-pdf-sync";

async function dialogOpen(): Promise<boolean> {
  return browser.executeObsidian(() => !!document.querySelector(".aps-onboarding"));
}

/** 在引导窗里点某个文字的按钮（分段选择、上一步下一步、跳过、完成） */
async function clickText(text: string, scope = ".aps-onboarding"): Promise<void> {
  // 步骤切换有进出动画：等目标按钮出现再点
  await browser.waitUntil(async () => browser.executeObsidian((_, wanted, root) => {
    const button = [...document.querySelectorAll<HTMLElement>(`${root} button`)].find((el) => el.textContent?.trim() === wanted);
    button?.click();
    return !!button;
  }, text, scope), { timeout: 5000, interval: 200, timeoutMsg: `找不到按钮「${text}」` });
  await browser.pause(350);
}

/** 点引导里某一行勾选框 */
async function toggleRow(label: string): Promise<void> {
  await browser.waitUntil(async () => browser.executeObsidian((_, wanted) => {
    const row = [...document.querySelectorAll<HTMLElement>(".aps-onboarding .aps-check-row")].find((el) => el.textContent?.includes(wanted));
    row?.querySelector<HTMLElement>(".aps-checkbox")?.click();
    return !!row;
  }, label), { timeout: 5000, interval: 200, timeoutMsg: `找不到选项「${label}」` });
  await browser.pause(250);
}

async function settings(): Promise<any> {
  return browser.executeObsidian(({ app }, id) => JSON.parse(JSON.stringify((app as any).plugins.plugins[id].settings)), PLUGIN);
}

/** 设置窗还开着吗（Obsidian 1.13 起设置是单独的弹出窗口） */
async function settingsOpen(): Promise<boolean> {
  return browser.executeObsidian(({ app }) => {
    const setting = (app as any).setting;
    const root: HTMLElement | undefined = setting.activeTab?.containerEl;
    if (!root?.isConnected) return false;
    const win = root.ownerDocument.defaultView as (Window & { closed?: boolean }) | null;
    return !!win && !win.closed && root.ownerDocument.body.contains(root);
  });
}

async function openSettingsTab(): Promise<void> {
  const error = await browser.executeObsidian(async ({ app }, id) => {
    try {
      const setting = (app as any).setting;
      setting.open();
      setting.openTabById(id);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return setting.activeTab?.containerEl?.querySelector(".aps-settings-head") ? null : "设置页里没有本插件的内容";
    } catch (caught) {
      return String((caught as Error)?.stack ?? caught);
    }
  }, PLUGIN);
  if (error) throw new Error(`打开设置页出错：${error}`);
}

describe("首次引导", function () {
  before(async function () {
    await windowSize(1600, 1000);
  });

  it("首次打开配有 PDF 的笔记时弹出四步引导", async () => {
    expect((await settings()).onboarded).toBe(false);
    await obsidianPage.openFile(FILE("02-史學之界說"));
    await browser.waitUntil(dialogOpen, { timeout: 20_000, timeoutMsg: "引导没弹出来" });
    const head = await browser.executeObsidian(() => document.querySelector(".aps-ob-steps")?.textContent);
    expect(head).toBe("第 1 步，共 4 步：布局");
    expect((await settings()).onboarded).toBe(true);
    await browser.saveScreenshot(`${SCREENSHOTS}/08-首次引导.png`);
  });

  it("四步选项写进设置，PDF 挪到右边", async () => {
    await clickText("右边");
    await clickText("PDF 顶部");
    const preview = await browser.executeObsidian(() => {
      const box = document.querySelector<HTMLElement>(".aps-onboarding .aps-preview")!;
      return { side: box.dataset.side, dock: box.dataset.dock };
    });
    expect(preview).toEqual({ side: "right", dock: "pdf" });
    await clickText("下一步");
    await clickText("单向");
    await toggleRow("页内按比例跟随");
    await clickText("下一步");
    await toggleRow("实时预览里显示页码标签");
    await clickText("下一步");
    await browser.waitUntil(async () => browser.executeObsidian(() => document.querySelectorAll(".aps-ob-book").length > 0), { timeoutMsg: "第 4 步没列出书" });
    const books = await browser.executeObsidian(() => [...document.querySelectorAll(".aps-ob-book")].map((row) => row.textContent));
    expect(books.some((text) => text?.includes("新史學") && text.includes("开始导览"))).toBe(true);
    await clickText("完成");
    await settle(1500);
    expect(await dialogOpen()).toBe(false);
    const saved = await settings();
    // 页码标签、阅读线默认开，当前页标示默认淡底色、阅读线默认淡色带、夜间跟随主题：取消了页码标签就关，没动的保持默认
    expect(saved).toMatchObject({ pdfSide: "right", bidirectional: false, paused: false, proportional: false, pageLabels: false, shadeStyle: "tint", showBaseline: true, baselineStyle: "band", nightMode: "auto", nightTone: "neutral", onboarded: true });
    expect(saved.toolbar).toMatchObject({ mode: "docked", dock: "pdf" });
    const order = await browser.executeObsidian(({ app }, id) => {
      const controller = (app as any).plugins.plugins[id].controller;
      return [controller.pdf.leaf.view.containerEl.getBoundingClientRect().left, controller.markdownView.containerEl.getBoundingClientRect().left];
    }, PLUGIN);
    expect(order[0]).toBeGreaterThan(order[1]);
  });

  it("只弹一次：再打开别的书文件不弹", async () => {
    await obsidianPage.openFile(FILE("03-論正統"));
    await settle(1500);
    expect(await dialogOpen()).toBe(false);
  });

  it("设置页：分组、实时预览；「重新打开引导」关掉设置窗再弹引导；跳过不改设置", async () => {
    await openSettingsTab();
    const page = await browser.executeObsidian(({ app }) => {
      const root: HTMLElement = (app as any).setting.activeTab.containerEl;
      return {
        title: root.querySelector(".aps-settings-title")?.textContent ?? "",
        preview: root.querySelector<HTMLElement>(".aps-settings-head .aps-preview")?.dataset.side,
        practice: root.querySelectorAll(".aps-practice-row").length,
        text: root.textContent ?? "",
        popout: root.ownerDocument !== document
      };
    });
    expect(page.title).toContain("PDF Sync Markdown");
    expect(page.preview).toBe("right");
    expect(page.practice).toBe(2);
    for (const heading of ["布局", "联动", "外观", "上手", "高级", "跟随基准线"]) expect(page.text).toContain(heading);
    // 设置窗是单独的窗口：切过去截图再切回来
    const main = await browser.getWindowHandle();
    for (const handle of await browser.getWindowHandles()) {
      if (handle === main) continue;
      await browser.switchToWindow(handle);
      if ((await browser.getTitle()).includes("设置") || (await browser.execute(() => !!document.querySelector(".aps-settings-head")))) {
        await browser.saveScreenshot(`${SCREENSHOTS}/09-设置页.png`);
        break;
      }
    }
    await browser.switchToWindow(main);
    await browser.executeObsidian(({ app }) => (app as any).setting.activeTab.containerEl.querySelector(".aps-reopen").click());
    await browser.waitUntil(dialogOpen, { timeoutMsg: "重新打开引导没弹出来" });
    expect(await settingsOpen()).toBe(false);
    const before = await settings();
    await clickText("跳过，以后在设置里重开");
    await settle(500);
    expect(await dialogOpen()).toBe(false);
    const after = await settings();
    expect({ pdfSide: after.pdfSide, bidirectional: after.bidirectional, pageLabels: after.pageLabels }).toEqual({ pdfSide: before.pdfSide, bidirectional: before.bidirectional, pageLabels: before.pageLabels });
  });

  it("开始导览：关掉引导窗，在真工具条上走三步气泡（把手 → 页码 → 联动开关）", async () => {
    await browser.executeObsidian(({ app }, id) => (app as any).commands.executeCommandById(`${id}:open-onboarding`), PLUGIN);
    await browser.waitUntil(dialogOpen, { timeoutMsg: "命令没弹出引导" });
    await clickText("下一步");
    await clickText("下一步");
    await clickText("下一步");
    await browser.executeObsidian(() => {
      const row = [...document.querySelectorAll<HTMLElement>(".aps-ob-book")].find((el) => el.textContent?.includes("新史學"))!;
      row.querySelector<HTMLElement>("button")!.click();
    });
    await browser.waitUntil(async () => browser.executeObsidian(() => !!document.querySelector(".aps-coach-bubble")), { timeout: 20_000, timeoutMsg: "导览气泡没出来" });
    expect(await dialogOpen()).toBe(false);
    const targets: string[] = [];
    for (const [index, selector] of [".aps-grip", ".aps-page-input", ".aps-seg"].entries()) {
      await settle(700);
      const near = await browser.executeObsidian((_, sel) => {
        const ring = document.querySelector<HTMLElement>(".aps-coach-ring")!.getBoundingClientRect();
        const target = document.querySelector<HTMLElement>(`.aps-toolbar ${sel}`)!.getBoundingClientRect();
        return Math.abs(ring.left + 4 - target.left) < 3 && Math.abs(ring.top + 4 - target.top) < 3;
      }, selector);
      expect(near).toBe(true);
      targets.push(await browser.executeObsidian(() => document.querySelector(".aps-coach-text")?.textContent ?? ""));
      if (index === 0) await browser.saveScreenshot(`${SCREENSHOTS}/10-导览气泡.png`);
      await clickText(index < 2 ? "下一个" : "完成", ".aps-coach-bubble");
    }
    expect(targets[0]).toContain("把手");
    expect(targets[1]).toContain("页码");
    expect(targets[2]).toContain("联动方式");
    await settle(300);
    expect(await browser.executeObsidian(() => !!document.querySelector(".aps-coach-bubble"))).toBe(false);
  });

  it("「带我做」：关掉设置窗，在打开的书上提示；做到了打勾并记下", async () => {
    await obsidianPage.openFile(FILE("03-論正統"));
    await settle(1500);
    await openSettingsTab();
    await browser.executeObsidian(({ app }) => (app as any).setting.activeTab.containerEl.querySelector('.aps-practice-row[data-task="highlight"] button').click());
    await browser.waitUntil(async () => browser.executeObsidian(() => !!document.querySelector(".aps-coach-bubble")), { timeoutMsg: "带我做的提示没出来" });
    expect(await settingsOpen()).toBe(false);
    const text = await browser.executeObsidian(() => document.querySelector(".aps-coach-text")?.textContent ?? "");
    expect(text).toContain("选中几个字");
    await browser.executeObsidian(async ({ app }, id) => {
      const controller = (app as any).plugins.plugins[id].controller;
      const editor = controller.markdownView.editor;
      const value: string = editor.getValue();
      const from = value.indexOf("幅員亦有天下");
      editor.setSelection(editor.offsetToPos(from), editor.offsetToPos(from + 5));
      await controller.onMarkdownSelection();
    }, PLUGIN);
    await browser.waitUntil(async () => browser.executeObsidian(() => !!document.querySelector(".aps-coach-done")), { timeoutMsg: "没显示做到了" });
    await browser.saveScreenshot(`${SCREENSHOTS}/11-带我做.png`);
    expect((await settings()).practice).toEqual({ highlight: true, pageEdit: false });
    await clickText("好", ".aps-coach-bubble");
    await openSettingsTab();
    const marked = await browser.executeObsidian(({ app }) => (app as any).setting.activeTab.containerEl.querySelector('.aps-practice-row[data-task="highlight"] .aps-practice-mark')?.classList.contains("is-done"));
    expect(marked).toBe(true);
    await browser.executeObsidian(({ app }) => (app as any).setting.close());
  });
});
