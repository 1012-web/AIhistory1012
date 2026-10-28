import { $, browser, expect } from "@wdio/globals";
import { before, describe, it } from "mocha";
import { BOOK, FILE, openBookFile, SCREENSHOTS, settle, windowSize } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

const LIST = `${BOOK}/${BOOK}.疑字清单.md`;
const NOTES = `${BOOK}/${BOOK}.AI校注.md`;
const CHAPTER = FILE("03-論正統");

/** 一条清单条目（照 book2md1012 的写法）；字是样例书里的真字，「VL」读法是编的 */
function item(id: string, page: number, text: string, ctx: string, shown: string, other: string): string {
  const enc = encodeURIComponent;
  const href = `obsidian://aihistory-pdf-sync?file=${enc(CHAPTER)}&page=${page}&text=${enc(text)}&ctx=${enc(ctx)}`;
  return `- [ ] \`${id}\` [PDF 第 ${page} 页](${href}) · 字 · ${shown} ／ VL 作【${other}】（测试用）`;
}

const LIST_TEXT = [
  "---",
  "type: 疑字清单",
  "---",
  "",
  `# ${BOOK} · 疑字清单`,
  "",
  "## PDF 第 18 页",
  "",
  item("C901", 18, "闢", "則辭而闢之，固非", "則辭而【闢】之，固非", "辟"),
  "",
  "## PDF 第 19 页",
  "",
  item("C902", 19, "埒", "幾與漢唐埒，地亦", "幾與漢唐【埒】，地亦", "垺"),
  item("C903", 19, "迥", "之祚，迥軼於宋", "之祚，【迥】軼於宋", "迴"),
  "",
  "## PDF 第 17 页",
  "",
  // 在脚注里：本页正文段里没有，要到挂在第 17 页的注释里找
  item("C904", 17, "萬章", "《孟子·萬章上》引孔", "《孟子·【萬章】上》引孔", "万章"),
  ""
].join("\n");

async function read(path: string): Promise<string | null> {
  return browser.executeObsidian(async ({ app }, wanted) => {
    const file = app.vault.getAbstractFileByPath(wanted);
    return file ? app.vault.read(file as any) : null;
  }, path);
}

function line(text: string | null, id: string): string {
  return (text ?? "").split("\n").find((row) => row.includes(`\`${id}\``)) ?? "";
}

describe("判字", function () {
  before(async function () {
    await windowSize(1600, 1000);
    await browser.executeObsidian(async ({ app }, path, text) => {
      const plugin = (app as any).plugins.plugins["aihistory-pdf-sync"];
      plugin.settings.onboarded = true;
      await plugin.saveSettings();
      await app.vault.create(path, text);
    }, LIST, LIST_TEXT);
    await openBookFile(CHAPTER);
  });

  it("面板：列出清单，换条时正文选中现字、PDF 翻到该页；按数字键定字，改正文、勾清单、记校注，跳到下一条", async () => {
    await browser.executeObsidian(async ({ app }) => {
      await (app as any).commands.executeCommandById("aihistory-pdf-sync:open-suspects");
    });
    await browser.waitUntil(async () => browser.executeObsidian(() => document.querySelector(".aps-suspect-card .aps-suspect-meta")?.textContent?.includes("C901") ?? false), { timeoutMsg: "面板没显示第一条" });
    await browser.waitUntil(async () => browser.executeObsidian(({ app }) => (app as any).plugins.plugins["aihistory-pdf-sync"].controller.markdownView?.editor.getSelection() === "闢"), { timeoutMsg: "正文没选中「闢」" });
    const shown = await browser.executeObsidian(() => ({
      count: document.querySelector(".aps-suspects-count")?.textContent ?? "",
      readings: [...document.querySelectorAll(".aps-suspect-card .aps-suspect-glyph")].map((node) => node.textContent),
      rows: document.querySelectorAll(".aps-suspects-row").length,
      focused: document.activeElement?.classList.contains("aps-suspects") ?? false
    }));
    expect(shown.count).toBe("已判 0 / 共 4");
    expect(shown.readings).toEqual(["闢", "辟"]);
    expect(shown.rows).toBe(4);
    expect(shown.focused).toBe(true);
    await browser.waitUntil(async () => browser.executeObsidian(() => document.querySelectorAll('.page[data-page-number="18"] .aps-hl').length > 0), { timeout: 5000, timeoutMsg: "PDF 第 18 页没有高亮" });
    await browser.saveScreenshot(`${SCREENSHOTS}/20-判字面板.png`);

    await browser.executeObsidian(() => {
      document.querySelector(".aps-suspects")!.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    });
    await browser.waitUntil(async () => line(await read(LIST), "C901").includes("判定作【辟】"), { timeoutMsg: "清单没记上判定" });
    const after = await browser.executeObsidian(({ app }) => (app as any).plugins.plugins["aihistory-pdf-sync"].controller.markdownView.editor.getValue() as string);
    expect(after).toContain("則辭而辟之，固非");
    expect(after).not.toContain("則辭而闢之");
    expect(line(await read(LIST), "C901").startsWith("- [x]")).toBe(true);
    const notes = await read(NOTES);
    expect(notes).toContain("## 用户判定的疑字");
    expect(notes).toContain("| C901 | PDF 第 18 页（03-論正統.md） | 闢 | 辟 | 人工看图 |");
    await browser.waitUntil(async () => browser.executeObsidian(() => document.querySelector(".aps-suspect-card .aps-suspect-meta")?.textContent?.includes("C902") ?? false), { timeoutMsg: "没跳到下一条" });
    expect(await browser.executeObsidian(() => document.querySelector(".aps-suspects-count")?.textContent)).toBe("已判 1 / 共 4");
  });

  it("正文标记：没判的字有波浪线；悬停卡片里点「存疑」记进清单", async () => {
    await browser.executeObsidian(async ({ app }) => {
      await (app as any).plugins.plugins["aihistory-pdf-sync"].controller.jumpToPage(19);
    });
    await settle(600);
    const marks = await browser.executeObsidian(() => [...document.querySelectorAll(".cm-content .aps-suspect")].map((node) => [(node as HTMLElement).dataset.apsSuspect, node.textContent]));
    expect(marks).toEqual(expect.arrayContaining([["C902", "埒"], ["C903", "迥"]]));
    expect(marks.some(([key]) => key === "C901")).toBe(false);

    await $('.cm-content .aps-suspect[data-aps-suspect="C902"]').moveTo();
    await $(".aps-suspect-tip").waitForDisplayed({ timeoutMsg: "悬停卡片没出来" });
    await browser.saveScreenshot(`${SCREENSHOTS}/21-判字悬停卡片.png`);
    const tip = await browser.executeObsidian(() => ({
      meta: document.querySelector(".aps-suspect-tip .aps-suspect-meta")?.textContent ?? "",
      readings: [...document.querySelectorAll(".aps-suspect-tip .aps-suspect-glyph")].map((node) => node.textContent)
    }));
    expect(tip.meta).toContain("C902");
    expect(tip.readings).toEqual(["埒", "垺"]);
    await browser.executeObsidian(() => {
      [...document.querySelectorAll<HTMLButtonElement>(".aps-suspect-tip button")].find((button) => button.textContent === "存疑")!.click();
    });
    await browser.waitUntil(async () => line(await read(LIST), "C902").includes("存疑（"), { timeoutMsg: "清单没记存疑" });
    expect(line(await read(LIST), "C902").startsWith("- [ ]")).toBe(true);
    await browser.waitUntil(async () => browser.executeObsidian(() => document.querySelector('.cm-content .aps-suspect.is-doubt[data-aps-suspect="C902"]') !== null), { timeoutMsg: "存疑的标记没换样式" });
  });

  it("悬停卡片里自填：填的就是现字时正文不动，清单勾上，校注记「维持原字」", async () => {
    const editorText = () => browser.executeObsidian(({ app }) => (app as any).plugins.plugins["aihistory-pdf-sync"].controller.markdownView.editor.getValue() as string);
    const before = await editorText();
    await $('.cm-content .aps-suspect[data-aps-suspect="C903"]').moveTo();
    await $(".aps-suspect-tip").waitForDisplayed({ timeoutMsg: "悬停卡片没出来" });
    await $(".aps-suspect-tip input").setValue("迥");
    await browser.executeObsidian(() => {
      document.querySelector<HTMLFormElement>(".aps-suspect-tip form")!.requestSubmit();
    });
    await browser.waitUntil(async () => line(await read(LIST), "C903").includes("判定作【迥】"), { timeoutMsg: "清单没记上判定" });
    // 本条没改字；第一条在编辑器里改的字随 Obsidian 自动保存落盘
    expect(await editorText()).toBe(before);
    await browser.waitUntil(async () => (await read(CHAPTER))?.includes("則辭而辟之") ?? false, { timeout: 8000, timeoutMsg: "第一条的改字没存盘" });
    await settle(500);
    expect(await read(CHAPTER)).toBe(before);
    expect(await read(NOTES)).toContain("| C903 | PDF 第 19 页（03-論正統.md） | 迥 | （维持原字） | 人工看图 |");
    expect(await browser.executeObsidian(() => document.querySelector('.cm-content .aps-suspect[data-aps-suspect="C903"]'))).toBeNull();
  });

  it("脚注里的疑字：面板里点它，正文选中注释里那个字", async () => {
    await browser.executeObsidian(() => {
      [...document.querySelectorAll<HTMLButtonElement>(".aps-suspects-row")].find((row) => row.textContent?.includes("C904"))!.click();
    });
    await browser.waitUntil(async () => browser.executeObsidian(({ app }) => (app as any).plugins.plugins["aihistory-pdf-sync"].controller.markdownView?.editor.getSelection() === "萬章"), { timeoutMsg: "正文没选中脚注里的「萬章」" });
    const around = await browser.executeObsidian(({ app }) => {
      const editor = (app as any).plugins.plugins["aihistory-pdf-sync"].controller.markdownView.editor;
      const from = editor.posToOffset(editor.getCursor("from"));
      return (editor.getValue() as string).slice(from - 3, from + 3);
    });
    expect(around).toBe("孟子·萬章上");
  });

  it("重判：已改的字按现在的字定位，校注只留最后一行；面板里按 U 撤回，正文、清单、校注都回到没判", async () => {
    const editorText = () => browser.executeObsidian(({ app }) => (app as any).plugins.plugins["aihistory-pdf-sync"].controller.markdownView.editor.getValue() as string);
    const rows = async () => ((await read(NOTES)) ?? "").split("\n").filter((row) => row.startsWith("| C901 |"));
    // 第一条已判作「辟」：改判删去，再改判回「闢」
    await browser.executeObsidian(async ({ app }) => {
      await (app as any).plugins.plugins["aihistory-pdf-sync"].suspects.decide("C901", "");
    });
    expect(await editorText()).toContain("則辭而之，固非");
    expect(await rows()).toEqual(["| C901 | PDF 第 18 页（03-論正統.md） | 闢 | （删） | 人工看图 |"]);
    await browser.executeObsidian(async ({ app }) => {
      await (app as any).plugins.plugins["aihistory-pdf-sync"].suspects.decide("C901", "闢");
    });
    expect(await editorText()).toContain("則辭而闢之，固非");
    expect(await rows()).toEqual(["| C901 | PDF 第 18 页（03-論正統.md） | 闢 | （维持原字） | 人工看图 |"]);

    // 改判作「辟」，再在面板里撤回
    await browser.executeObsidian(async ({ app }) => {
      const desk = (app as any).plugins.plugins["aihistory-pdf-sync"].suspects;
      await desk.decide("C901", "辟");
      desk.showInPanel("C901");
    });
    await browser.waitUntil(async () => browser.executeObsidian(() => document.querySelector(".aps-suspect-card .aps-suspect-meta")?.textContent?.includes("C901") ?? false), { timeoutMsg: "面板没换到 C901" });
    const badge = await browser.executeObsidian(() => {
      const root = document.querySelector<HTMLElement>(".aps-suspects")!;
      root.focus();
      return getComputedStyle(root.querySelector(".aps-suspects-focus")!).display;
    });
    expect(badge).not.toBe("none");
    await browser.executeObsidian(() => {
      document.querySelector(".aps-suspects")!.dispatchEvent(new KeyboardEvent("keydown", { key: "u", bubbles: true }));
    });
    await browser.waitUntil(async () => line(await read(LIST), "C901").startsWith("- [ ]"), { timeoutMsg: "清单没回到没判" });
    expect(line(await read(LIST), "C901")).not.toMatch(/判定作|存疑（/);
    expect(await editorText()).toContain("則辭而闢之，固非");
    expect(await rows()).toEqual([]);
    // 别的条目的行还在，这一节不删
    expect(await read(NOTES)).toContain("| C903 |");
  });
});