import { browser, expect } from "@wdio/globals";
import { before, describe, it } from "mocha";
import { FILE, openBookFile, points, SCREENSHOTS, setMode, settle, windowSize } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 模拟用户在正文里滚：先发一次滚轮（让正文领跑），再把滚动容器滚到总高的 ratio 处 */
async function userScrollMarkdown(ratio: number): Promise<void> {
  await browser.executeObsidian(({ app }, r) => {
    const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
    const scroller: HTMLElement = controller.scroller;
    scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * r;
  }, ratio);
}

/** 模拟用户在 PDF 上滚到第 page 页的 fraction 处（落在基准线上） */
async function userScrollPdf(page: number, fraction: number): Promise<void> {
  await browser.executeObsidian(({ app }, p, f) => {
    const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
    const container: HTMLElement = controller.pdf.container;
    container.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
    const pageEl = container.querySelector<HTMLElement>(`.page[data-page-number="${p}"]`)!;
    const rect = container.getBoundingClientRect();
    const pageRect = pageEl.getBoundingClientRect();
    container.scrollTop += pageRect.top + pageRect.height * f - (rect.top + rect.height * controller.settings.baseline);
  }, page, fraction);
}

/**
 * 工具条上当前标题的完整路径（取悬停提示，各级以 › 相连）。
 * 窄窗格里完整路径放不下时只显示最末一级。
 */
async function crumbsText(): Promise<string> {
  return browser.execute(() => (document.querySelector(".aps-toolbar .aps-crumbs")?.getAttribute("title") ?? "").replace(/\s*›\s*/g, "›"));
}


async function scrollTops(): Promise<[number, number]> {
  return browser.executeObsidian(({ app }) => {
    const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
    return [Math.round(controller.scroller.scrollTop), Math.round(controller.pdf.container.scrollTop)] as [number, number];
  });
}

describe("配对与书内索引", function () {
  before(async function () {
    await windowSize(1600, 1000);
    // 本文件不测首次引导（onboarding.e2e.ts 测）：先标成已引导过，免得引导窗挡住后面的操作
    await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as any).plugins.plugins["aihistory-pdf-sync"];
      plugin.settings.onboarded = true;
      await plugin.saveSettings();
    });
    await openBookFile(FILE("02-史學之界說"));
  });

  it("多文件书：四个文件同属一本，各管各的页；三种配对来源都认", async () => {
    const info = await browser.executeObsidian(async ({ app }) => {
      const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
      const book = controller.book;
      const resolve = async (path: string) => (await controller.pairer.resolve(app.vault.getAbstractFileByPath(path)))?.source ?? null;
      return {
        pdf: book.pdf.path,
        files: book.index.files.map((file: any) => [file.path, file.pages]),
        offset: book.index.printedPageOffset,
        sources: [
          await resolve("新史學/01-中國之舊史.md"),
          await resolve("新史學/03-論正統.md"),
          await resolve("新史學/新史學.md")
        ],
        pageCount: controller.pdf.pageCount
      };
    });
    expect(info.pdf).toBe("新史學/新史學.pdf");
    expect(info.pageCount).toBe(23);
    expect(info.offset).toBe(4);
    expect(info.files).toEqual([
      ["新史學/01-中國之舊史.md", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
      ["新史學/02-史學之界說.md", [12, 13, 14, 15, 16]],
      ["新史學/03-論正統.md", [17, 18, 19, 20, 21, 22, 23]],
      ["新史學/新史學.md", []]
    ]);
    expect(info.sources).toEqual(["frontmatter", "book.json", "book.json"]);
  });

  it("PDF 默认开在左边，正文在右", async () => {
    const order = await browser.executeObsidian(({ app }) => {
      const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
      return [controller.pdf.leaf.view.containerEl.getBoundingClientRect().left, controller.markdownView.containerEl.getBoundingClientRect().left];
    });
    expect(order[0]).toBeLessThan(order[1]);
  });

  it("在 PDF 那组标签里打开笔记：不关用户的 PDF 标签，在笔记旁边另开一个看得见的", async () => {
    const result = await browser.executeObsidian(async ({ app }) => {
      const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
      const original = controller.pdf.leaf;
      app.workspace.setActiveLeaf(original, { focus: true });
      const file = app.vault.getAbstractFileByPath("新史學/01-中國之舊史.md");
      await app.workspace.getLeaf("tab").openFile(file as any);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      let alive = false;
      app.workspace.iterateAllLeaves((leaf: any) => {
        if (leaf === original) alive = true;
      });
      const pane = controller.pdf;
      return {
        alive,
        newLeaf: pane?.leaf !== original,
        visible: (pane?.container?.getBoundingClientRect().height ?? 0) > 0,
        file: controller.markdownView?.file?.path
      };
    });
    expect(result).toEqual({ alive: true, newLeaf: true, visible: true, file: "新史學/01-中國之舊史.md" });
  });

  it("跨文件跳页：跳到第 20 页自动打开第三章，跳回第 1 页打开第一章", async () => {
    await browser.executeObsidian(async ({ app }) => {
      await (app as any).plugins.plugins["aihistory-pdf-sync"].controller.jumpToPage(20);
    });
    await settle(800);
    let now = await points();
    expect(now.file).toBe(FILE("03-論正統"));
    expect(now.pdf?.page).toBe(20);
    expect(now.markdown?.page).toBe(20);
    await browser.executeObsidian(async ({ app }) => {
      await (app as any).plugins.plugins["aihistory-pdf-sync"].controller.jumpToPage(1);
    });
    await settle(800);
    now = await points();
    expect(now.file).toBe(FILE("01-中國之舊史"));
    expect(now.pdf?.page).toBe(1);
  });

  it("◀ ▶ 两边一起翻（跨文件也跟着换）", async () => {
    await browser.executeObsidian(async ({ app }) => {
      const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
      await controller.jumpToPage(11);
      await controller.step(1);
    });
    await settle(800);
    const now = await points();
    expect(now.file).toBe(FILE("02-史學之界說"));
    expect(now.pdf?.page).toBe(12);
    expect(now.markdown?.page).toBe(12);
  });
});

describe("正文 → PDF 跟随（三种视图）", function () {
  before(async function () {
    await openBookFile(FILE("03-論正統"));
  });

  for (const mode of ["source", "live", "preview"] as const) {
    it(`${mode === "source" ? "源码" : mode === "live" ? "实时预览" : "阅读"}视图：滚动正文，PDF 翻到同一页、页内大致同一处`, async () => {
      await setMode(mode);
      for (const ratio of [0.25, 0.6]) {
        await userScrollMarkdown(ratio);
        await settle(700);
        const now = await points();
        expect(now.markdown).not.toBeNull();
        expect(now.pdf?.page).toBe(now.markdown!.page);
        expect(Math.abs(now.pdf!.fraction - now.markdown!.fraction)).toBeLessThan(0.3);
      }
      if (mode === "live") await browser.saveScreenshot(`${SCREENSHOTS}/01-实时预览跟随.png`);
      if (mode === "preview") await browser.saveScreenshot(`${SCREENSHOTS}/02-阅读视图跟随.png`);
    });
  }
});

describe("旧格式（只有印刷页锚点）", function () {
  it("第 1 版 book.json 的偏移换算物理页：滚正文，PDF 跟到同一页", async () => {
    await openBookFile("旧格式/旧格式.md");
    await setMode("live");
    const pages = await browser.executeObsidian(({ app }) => (app as any).plugins.plugins["aihistory-pdf-sync"].controller.book.index.files[0].pages);
    expect(pages.slice(0, 3)).toEqual([12, 13, 14]);
    await userScrollMarkdown(0.5);
    await settle(700);
    const now = await points();
    expect(now.markdown).not.toBeNull();
    expect(now.pdf?.page).toBe(now.markdown!.page);
  });
});

describe("双向联动", function () {
  before(async function () {
    await openBookFile(FILE("03-論正統"));
    await setMode("live");
  });

  it("滚 PDF 到第 14 页：正文自动换到第二章并对到第 14 页；之后两边都静止，不互相拽", async () => {
    await userScrollPdf(14, 0.5);
    await settle(1000);
    const now = await points();
    expect(now.file).toBe(FILE("02-史學之界說"));
    expect(now.markdown?.page).toBe(14);
    expect(now.pdf?.page).toBe(14);
    const samples: Array<[number, number]> = [];
    for (let i = 0; i < 8; i += 1) {
      samples.push(await scrollTops());
      await browser.pause(150);
    }
    const unique = new Set(samples.map((sample) => sample.join(",")));
    expect(unique.size).toBe(1);
  });

  it("接着滚正文：PDF 跟过来，也不会被拽回去", async () => {
    await userScrollMarkdown(0.8);
    await settle(800);
    const now = await points();
    expect(now.pdf?.page).toBe(now.markdown?.page);
    const first = await scrollTops();
    await browser.pause(800);
    expect(await scrollTops()).toEqual(first);
  });

  it("关掉双向：手动翻 PDF 时正文不动，PDF 也不被正文拽回；回到正文一滚就恢复跟随", async () => {
    await browser.executeObsidian(({ app }) => {
      (app as any).plugins.plugins["aihistory-pdf-sync"].settings.bidirectional = false;
    });
    const before = await scrollTops();
    await userScrollPdf(2, 0.3);
    await settle(600);
    const after = await scrollTops();
    expect(after[0]).toBe(before[0]);
    // 正文被动重排（不是用户输入）触发滚动事件：PDF 不该被拽回
    await browser.executeObsidian(({ app }) => {
      const scroller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller.scroller as HTMLElement;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await settle(400);
    expect((await points()).pdf?.page).toBe(2);
    await userScrollMarkdown(0.3);
    await settle(700);
    const now = await points();
    expect(now.pdf?.page).toBe(now.markdown?.page);
    await browser.executeObsidian(({ app }) => {
      (app as any).plugins.plugins["aihistory-pdf-sync"].settings.bidirectional = true;
    });
  });
});

describe("逐字高亮", function () {
  before(async function () {
    await openBookFile(FILE("03-論正統"));
    await setMode("live");
  });

  it("选中正文一句：PDF 第 19 页高亮正好盖住这些字", async () => {
    const phrase = "而果誰爲正而誰爲僞也";
    const ok = await browser.executeObsidian(async ({ app }, text) => {
      const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
      const editor = controller.markdownView.editor;
      const from = editor.getValue().indexOf(text);
      editor.setSelection(editor.offsetToPos(from), editor.offsetToPos(from + text.length));
      return controller.onMarkdownSelection();
    }, phrase);
    expect(ok).toBe(true);
    await settle(300);
    const covered = await browser.executeObsidian(() => {
      const page = document.querySelector<HTMLElement>('.page[data-page-number="19"]')!;
      const boxes = [...page.querySelectorAll<HTMLElement>(".aps-hl")].map((el) => el.getBoundingClientRect());
      const spans = [...page.querySelectorAll<HTMLElement>(".textLayer span")];
      // 高亮框里各点下面的字：用 caretRange 取框内中线上的字
      let text = "";
      for (const box of boxes) {
        for (let x = box.left + 3; x < box.right; x += 4) {
          const range = document.caretRangeFromPoint(x, box.top + box.height / 2);
          const node = range?.startContainer;
          if (node && node.nodeType === 3 && spans.some((span) => span.contains(node))) {
            const ch = node.nodeValue![Math.min(range!.startOffset, node.nodeValue!.length - 1)];
            if (!text.endsWith(ch)) text += ch;
          }
        }
      }
      return { boxes: boxes.length, text };
    });
    expect(covered.boxes).toBeGreaterThan(0);
    expect(covered.text).toContain("而果");
    expect(covered.text).toContain("僞也");
    await browser.saveScreenshot(`${SCREENSHOTS}/03-逐字高亮.png`);
  });

  it("在 PDF 上选字：正文选中同一段字", async () => {
    const result = await browser.executeObsidian(async ({ app }) => {
      const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
      await controller.jumpToPage(20);
      const spans: HTMLElement[] = await controller.pdf.textSpans(20);
      // 从某个以汉字开头的 span 起，连着往后选，凑够 6 个字（知网 PDF 常把一行拆成很多小 span）
      const isHan = (text: string) => /^[一-鿿]/.test(text);
      const startIndex = spans.findIndex((el, i) => i > spans.length / 3 && isHan(el.textContent ?? ""));
      if (startIndex === -1) return { error: "第 20 页文字层里没有汉字" };
      let endIndex = startIndex;
      let wanted = spans[startIndex].textContent ?? "";
      while (wanted.length < 6 && endIndex + 1 < spans.length) wanted += spans[++endIndex].textContent ?? "";
      const range = document.createRange();
      range.setStart(spans[startIndex].firstChild!, 0);
      range.setEnd(spans[endIndex].firstChild!, (spans[endIndex].textContent ?? "").length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      wanted = selection.toString();
      const ok = await controller.onPdfSelection();
      return { ok, wanted, selected: controller.markdownView.editor.getSelection(), file: controller.markdownView.file.path };
    });
    expect(result.ok).toBe(true);
    expect(String(result.selected).replace(/[\s\p{P}]/gu, "")).toBe(String(result.wanted).replace(/[\s\p{P}]/gu, ""));
    expect(result.file).toBe(FILE("03-論正統"));
  });
});

describe("实时预览的页码标签与当前页底色", function () {
  before(async function () {
    await openBookFile(FILE("02-史學之界說"));
  });

  it("实时预览：锚点显示成「页 · p.印刷页」小标签，当前页有底色；源码视图不显示标签", async () => {
    await setMode("live");
    await browser.executeObsidian(async ({ app }) => {
      await (app as any).plugins.plugins["aihistory-pdf-sync"].controller.jumpToPage(13);
    });
    await settle(600);
    const live = await browser.executeObsidian(() => ({
      labels: [...document.querySelectorAll(".workspace-leaf.mod-active .aps-page-label, .aps-page-label")].map((el) => el.textContent),
      shaded: document.querySelectorAll(".cm-line.aps-current-page").length
    }));
    expect(live.labels).toContain("13 · p.9");
    expect(live.shaded).toBeGreaterThan(0);
    await browser.saveScreenshot(`${SCREENSHOTS}/04-页码标签与底色.png`);
    const clicked = await browser.executeObsidian(async ({ app }) => {
      const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
      // PDF 先翻到第 1 页，再点正文里第 13 页的标签
      controller.pdf.scrollTo({ page: 1, fraction: 0 }, 0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const label = [...controller.markdownView.contentEl.querySelectorAll(".aps-page-label") as NodeListOf<HTMLElement>].find((el) => el.dataset.page === "13");
      label?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      return label ? Number(label.dataset.page) : null;
    });
    expect(clicked).not.toBeNull();
    await settle(600);
    expect((await points()).pdf?.page).toBe(clicked);
    await setMode("source");
    const source = await browser.executeObsidian(({ app }) => (app as any).plugins.plugins["aihistory-pdf-sync"].controller.markdownView.contentEl.querySelectorAll(".aps-page-label").length);
    expect(source).toBe(0);
    await setMode("live");
  });
});

describe("工具条", function () {
  before(async function () {
    await openBookFile(FILE("02-史學之界說"));
    await browser.executeObsidian(async ({ app }) => {
      await (app as any).plugins.plugins["aihistory-pdf-sync"].controller.jumpToPage(13);
    });
    await settle(600);
  });

  it("默认停靠在正文窗格顶部：窗格里垫了等高空白，工具条正好盖在上面；显示页码、印刷页、章名、进度线", async () => {
    const info = await browser.executeObsidian(({ app }) => {
      const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
      const bar = document.querySelector<HTMLElement>(".aps-toolbar")!;
      const content = controller.markdownView.containerEl.querySelector(":scope > .view-content") as HTMLElement;
      const spacer = content.previousElementSibling as HTMLElement;
      const barRect = bar.getBoundingClientRect();
      const spacerRect = spacer.getBoundingClientRect();
      return {
        docked: bar.classList.contains("aps-docked"),
        spacer: spacer.classList.contains("aps-toolbar-spacer"),
        // 卡片在停靠框里左留 12、上留 6；垫的空白 = 卡片高 + 上下各 6
        dy: Math.abs(barRect.top - (spacerRect.top + 6)),
        dx: Math.abs(barRect.left - (content.getBoundingClientRect().left + 12)),
        dh: Math.abs(spacerRect.height - (barRect.height + 12)),
        page: bar.querySelector<HTMLInputElement>(".aps-page-input")!.value,
        text: bar.textContent,
        chapter: bar.querySelector(".aps-crumbs")?.textContent ?? "",
        progress: (bar.querySelector<HTMLElement>(".aps-prog")?.getBoundingClientRect().width ?? 0) > 0
      };
    });
    expect(info.docked).toBe(true);
    expect(info.spacer).toBe(true);
    expect(info.dy).toBeLessThan(2);
    expect(info.dx).toBeLessThan(2);
    expect(info.dh).toBeLessThan(2);
    expect(info.page).toBe("13");
    expect(info.text).toContain("/23");
    expect(info.text).toContain("p.9");
    expect(info.chapter.length).toBeGreaterThan(0);
    expect(info.progress).toBe(true);
    await browser.saveScreenshot(`${SCREENSHOTS}/05-工具条停靠.png`);
  });

  it("点页码输入数字回车：两边跳到那一页", async () => {
    const input = await browser.$(".aps-toolbar .aps-page-input");
    await input.click();
    await browser.keys(["Control", "a"]);
    await browser.keys(["2", "0", "Enter"]);
    await settle(900);
    const now = await points();
    expect(now.pdf?.page).toBe(20);
    expect(now.file).toBe(FILE("03-論正統"));
    await browser.executeObsidian(async ({ app }) => {
      await (app as any).plugins.plugins["aihistory-pdf-sync"].controller.jumpToPage(13);
    });
    await settle(600);
  });

  it("多级标题：一行显示各级标题，不把工具条撑高；点开目录树，▸ 只展开不跳，点文字两边跳过去", async () => {
    const bar = await browser.$(".aps-toolbar");
    const height = (await bar.getSize()).height;
    expect(await crumbsText()).toBe("史學之界說");
    await browser.$(".aps-toolbar .aps-crumb").click();
    const here = await browser.$(".aps-outline-pop .aps-ol-item[data-here]");
    await here.waitForDisplayed();
    const opened = await browser.execute(() => {
      const row = document.querySelector<HTMLElement>(".aps-ol-item[data-here]")!;
      return {
        focusInSearch: document.activeElement?.classList.contains("aps-ol-search") ?? false,
        level: row.querySelector(".aps-ol-lv")?.textContent,
        page: row.querySelector(".aps-ol-pg")?.textContent,
        rows: [...document.querySelectorAll(".aps-ol-item")].map((el) => el.querySelector(".aps-ol-text")?.textContent)
      };
    });
    expect(opened.focusInSearch).toBe(true);
    expect(opened.level).toBe("H1");
    expect(opened.page).toMatch(/^(p\.8|第8页)$/);
    // 当前就在最上一级：没有临时展开什么
    expect(opened.rows).toEqual(["史學之界說"]);
    await here.$(".aps-ol-tw").click();
    const notes = await browser.$('//*[contains(@class,"aps-ol-item")][.//span[text()="注释"]]');
    await notes.waitForDisplayed();
    // 点 ▸ 不跳页，展开记进这本书
    const remembered = await browser.executeObsidian(({ app }) => {
      const plugin = (app as any).plugins.plugins["aihistory-pdf-sync"];
      return { page: plugin.controller.currentPage, manual: Object.values(plugin.settings.outlineBooks[plugin.controller.book.pdf.path]?.manual ?? {}) };
    });
    expect(remembered.page).toBe(13);
    expect(remembered.manual).toEqual([true]);
    await browser.saveScreenshot(`${SCREENSHOTS}/06-目录树.png`);
    await notes.click();
    await settle(900);
    const info = await browser.executeObsidian(({ app }) => {
      const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
      const view = controller.markdownView;
      const text: string = view.editor.getValue();
      const cm = view.editor.cm;
      const rect = (controller.scroller as HTMLElement).getBoundingClientRect();
      const headingTop = cm.lineBlockAt(text.indexOf("## 注释")).top + cm.documentTop;
      return {
        crumbs: (document.querySelector(".aps-toolbar .aps-crumbs")?.getAttribute("title") ?? "").replace(/\s*›\s*/g, "›"),
        shown: [...document.querySelectorAll(".aps-toolbar .aps-crumbs .aps-crumb")].map((el) => el.textContent),
        cut: [...document.querySelectorAll<HTMLElement>(".aps-toolbar .aps-crumbs .aps-crumb")].some((el) => el.scrollWidth > el.clientWidth + 1),
        menuOpen: !!document.querySelector(".aps-outline-pop"),
        // 标题落在正文的阅读线上
        offBaseline: Math.abs(headingTop - (rect.top + rect.height * controller.ratioFor("markdown")))
      };
    });
    expect(info.crumbs).toBe("史學之界說›注释");
    // 测试窗口里正文窗格窄：完整路径放不下就只显示最末一级，且不再截成省略号
    if (info.shown.length === 1) expect(info.shown).toEqual(["注释"]);
    else expect(info.cut).toBe(false);
    expect(info.menuOpen).toBe(false);
    expect(info.offBaseline).toBeLessThan(4);
    expect((await bar.getSize()).height).toBe(height);
  });

  it("标题菜单：搜索筛选、键盘跳转、全部收起、钉住", async () => {
    await browser.$(".aps-toolbar .aps-crumb").click();
    await browser.$(".aps-outline-pop .aps-ol-search").waitForDisplayed();
    // 搜索：只留匹配的与上级，匹配的字标出来；回车跳到第一个
    await browser.keys(["史", "學"]);
    await settle(200);
    const searched = await browser.execute(() => ({
      rows: [...document.querySelectorAll(".aps-ol-item .aps-ol-text")].map((el) => el.textContent),
      hit: document.querySelector(".aps-ol-hit")?.textContent,
      count: document.querySelector(".aps-ol-count")?.textContent
    }));
    expect(searched).toEqual({ rows: ["史學之界說"], hit: "史學", count: "1 个" });
    await browser.keys(["Enter"]);
    await settle(900);
    expect(await crumbsText()).toBe("史學之界說");
    expect(await browser.$(".aps-outline-pop").isExisting()).toBe(false);
    // 键盘：↓ 进列表，↓ 到下一行，回车跳
    await browser.$(".aps-toolbar .aps-crumb").click();
    await browser.$(".aps-outline-pop .aps-ol-search").waitForDisplayed();
    // 焦点进列表要等一拍（树组件下一帧才移焦点），按键之间稍停
    await browser.keys(["ArrowDown"]);
    await settle(200);
    await browser.keys(["ArrowDown"]);
    await settle(200);
    await browser.keys(["Enter"]);
    await settle(900);
    expect(await crumbsText()).toBe("史學之界說›注释");
    // 全部收起：真收起，并记成这本书的选择
    await browser.$(".aps-toolbar .aps-crumb").click();
    await browser.$(".aps-outline-pop .aps-ol-search").waitForDisplayed();
    await browser.$("button=全部收起").click();
    await settle(200);
    const collapsed = await browser.executeObsidian(({ app }) => {
      const plugin = (app as any).plugins.plugins["aihistory-pdf-sync"];
      return { rows: document.querySelectorAll(".aps-ol-item").length, state: plugin.settings.outlineBooks[plugin.controller.book.pdf.path] };
    });
    expect(collapsed.rows).toBe(1);
    expect(collapsed.state).toEqual({ depth: 0, manual: {} });
    // 钉住：点了标题菜单不关
    await browser.$('.aps-outline-pop [aria-label="钉住"]').click();
    await browser.$(".aps-outline-pop .aps-ol-item .aps-ol-text").click();
    await settle(900);
    expect(await browser.$(".aps-outline-pop").isDisplayed()).toBe(true);
    expect(await crumbsText()).toBe("史學之界說");
    await browser.$('.aps-outline-pop [aria-label="钉住"]').click();
    await browser.keys(["Escape"]);
    await settle(300);
    expect(await browser.$(".aps-outline-pop").isExisting()).toBe(false);
    expect(await browser.executeObsidian(({ app }) => (app as any).plugins.plugins["aihistory-pdf-sync"].settings.outlinePinned)).toBe(false);
  });

  it("标题菜单换成分栏：每级一栏，点有下级的往右展开，点没有下级的跳过去", async () => {
    await browser.executeObsidian(({ app }) => {
      const plugin = (app as any).plugins.plugins["aihistory-pdf-sync"];
      plugin.settings.outlineStyle = "columns";
      plugin.settingsChanged();
    });
    await settle(300);
    await browser.$(".aps-toolbar .aps-crumb").click();
    await browser.$(".aps-outline-pop .aps-cols").waitForDisplayed();
    const columns = async () => browser.execute(() => [...document.querySelectorAll(".aps-col")].map((col) => [...col.querySelectorAll(".aps-ol-text")].map((el) => el.textContent)));
    expect(await columns()).toEqual([["史學之界說"], ["注释"]]);
    await browser.saveScreenshot(`${SCREENSHOTS}/07-分栏.png`);
    await browser.$('//*[contains(@class,"aps-col-item")][.//span[text()="注释"]]').click();
    await settle(900);
    expect(await crumbsText()).toBe("史學之界說›注释");
    await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as any).plugins.plugins["aihistory-pdf-sync"];
      plugin.settings.outlineStyle = "tree";
      plugin.settingsChanged();
      await plugin.controller.jumpToPage(13);
    });
    await settle(600);
  });

  it("分段开关：双向 / 单向 / 暂停 切换联动方式，选中底色跟着走", async () => {
    const pick = async (label: string) => browser.executeObsidian(async ({ app }, text) => {
      const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
      const segment = [...document.querySelectorAll<HTMLElement>(".aps-segment")].find((el) => el.textContent === text)!;
      segment.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const pressed = document.querySelector<HTMLElement>(".aps-segment[data-pressed]");
      return { mode: controller.mode, bidirectional: controller.settings.bidirectional, paused: controller.paused, pressed: pressed?.textContent, bg: !!pressed?.querySelector(".aps-seg-ind") };
    }, label);
    expect(await pick("单向")).toEqual({ mode: "one", bidirectional: false, paused: false, pressed: "单向", bg: true });
    expect(await pick("暂停")).toEqual({ mode: "paused", bidirectional: false, paused: true, pressed: "暂停", bg: true });
    expect(await pick("双向")).toEqual({ mode: "both", bidirectional: true, paused: false, pressed: "双向", bg: true });
  });

  it("溢出菜单：缩放、配对 PDF 名", async () => {
    const info = await browser.executeObsidian(async ({ app }) => {
      const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
      const before = controller.pdf.scale;
      const trigger = document.querySelector<HTMLElement>('.aps-toolbar [aria-label="更多：缩放、配对 PDF"]')!;
      trigger.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const menu = document.querySelector<HTMLElement>(".aps-menu");
      const name = menu?.querySelector(".aps-pdf-name")?.textContent ?? "";
      menu?.querySelector<HTMLElement>('[aria-label="放大 PDF"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const after = controller.pdf.scale;
      controller.zoom(null);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      trigger.click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { opened: !!menu, name, before, after };
    });
    expect(info.opened).toBe(true);
    expect(info.name).toContain("新史學.pdf");
    expect(info.after).toBeGreaterThan(info.before);
  });

  it("溢出菜单里的「打开笔记时自动开 PDF」：默认开，点了记进设置", async () => {
    const info = await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as any).plugins.plugins["aihistory-pdf-sync"];
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const before = plugin.settings.autoOpen;
      document.querySelector<HTMLElement>('.aps-toolbar [aria-label="更多：缩放、配对 PDF"]')!.click();
      await wait(300);
      document.querySelector<HTMLElement>(".aps-menu .aps-menu-check")!.click();
      await wait(300);
      const after = plugin.settings.autoOpen;
      const saved = (await plugin.loadData()).autoOpen;
      document.querySelector<HTMLElement>(".aps-menu .aps-menu-check")!.click();
      await wait(300);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await wait(200);
      return { before, after, saved, restored: plugin.settings.autoOpen };
    });
    expect(info).toEqual({ before: true, after: false, saved: false, restored: true });
  });

  it("溢出菜单底部「插件设置…」打开本插件的设置页", async () => {
    const info = await browser.executeObsidian(async ({ app }) => {
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      document.querySelector<HTMLElement>(".aps-toolbar .aps-more")!.click();
      await wait(300);
      const items = Array.from(document.querySelectorAll<HTMLElement>(".aps-menu .aps-menu-item"));
      const last = items[items.length - 1]?.textContent ?? "";
      document.querySelector<HTMLElement>(".aps-menu .aps-open-settings")!.click();
      await wait(500);
      const setting = (app as any).setting;
      const tab = setting.activeTab?.id ?? "";
      setting.close();
      await wait(200);
      return { last, tab };
    });
    expect(info.last).toContain("插件设置");
    expect(info.tab).toBe("aihistory-pdf-sync");
  });

  it("拖出来悬浮、拖近 PDF 窗格顶部吸附过去；位置记进设置", async () => {
    const drag = async (toX: number, toY: number | "pdf-top") => browser.executeObsidian(async ({ app }, x, y) => {
      const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
      const handle = document.querySelector<HTMLElement>(".aps-toolbar .aps-grip")!;
      const start = handle.getBoundingClientRect();
      const fire = (target: EventTarget, type: string, cx: number, cy: number) =>
        target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, buttons: 1, clientX: cx, clientY: cy }));
      let targetY = y as number;
      let targetX = x as number;
      if (y === "pdf-top") {
        const content = controller.pdf.leaf.view.containerEl.querySelector(":scope > .view-content").getBoundingClientRect();
        targetY = content.top + 10;
        targetX = content.left + 60;
      }
      fire(handle, "pointerdown", start.left + 2, start.top + 2);
      fire(document, "pointermove", start.left + 20, start.top + 20);
      fire(document, "pointermove", targetX, targetY);
      const zones = document.querySelectorAll(".aps-dock-zone").length;
      const hint = document.querySelector(".aps-dock-zone.is-active") !== null;
      fire(document, "pointerup", targetX, targetY);
      // 等弹簧动画落定
      await new Promise((resolve) => setTimeout(resolve, 900));
      const bar = document.querySelector<HTMLElement>(".aps-toolbar")!;
      const crumbs = bar.querySelectorAll(".aps-crumbs .aps-crumb").length;
      // 一行：所有直接子元素的顶边都在第一行里
      const tops = Array.from(bar.children).filter((el) => !el.classList.contains("aps-prog")).map((el) => el.getBoundingClientRect().top);
      const oneRow = Math.max(...tops) - Math.min(...tops) < 12;
      return { zones, hint, crumbs, oneRow, view: { w: window.innerWidth, h: window.innerHeight }, classes: bar.className, rect: bar.getBoundingClientRect().toJSON(), state: { ...controller.settings.toolbar } };
    }, toX, toY);
    const floating = await drag(500, 400);
    expect(floating.classes).toContain("aps-floating");
    expect(floating.state.mode).toBe("floating");
    expect(Math.abs(floating.rect.top - floating.state.y)).toBeLessThan(3);
    // 悬浮时标题只留最末一级，卡片不折行
    expect(floating.crumbs).toBe(1);
    expect(floating.oneRow).toBe(true);
    // 拖到窗口外：存下的位置和卡片都夹回窗口里
    const outside = await drag(-600, -300);
    expect(outside.state.x).toBeGreaterThanOrEqual(0);
    expect(outside.state.y).toBeGreaterThanOrEqual(0);
    expect(outside.rect.left).toBeGreaterThanOrEqual(-1);
    expect(outside.rect.top).toBeGreaterThanOrEqual(-1);
    const farOut = await drag(99999, 99999);
    expect(farOut.rect.right).toBeLessThanOrEqual(farOut.view.w + 1);
    expect(farOut.rect.bottom).toBeLessThanOrEqual(farOut.view.h + 1);
    await browser.saveScreenshot(`${SCREENSHOTS}/06-工具条悬浮.png`);
    expect(floating.zones).toBe(2);
    expect(floating.hint).toBe(false);
    const snapped = await drag(0, "pdf-top");
    expect(snapped.hint).toBe(true);
    expect(snapped.classes).toContain("aps-docked");
    expect(snapped.state).toMatchObject({ mode: "docked", dock: "pdf" });
    const pdfTop = await browser.executeObsidian(({ app }) => {
      const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
      const content = controller.pdf.leaf.view.containerEl.querySelector(":scope > .view-content") as HTMLElement;
      return (content.previousElementSibling as HTMLElement).getBoundingClientRect().top;
    });
    expect(Math.abs(snapped.rect.top - (pdfTop + 6))).toBeLessThan(3);
    expect(await browser.executeObsidian(() => document.querySelectorAll(".aps-dock-zone").length)).toBe(0);
    const saved = await browser.executeObsidian(async ({ app }) => (await (app as any).plugins.plugins["aihistory-pdf-sync"].loadData()).toolbar);
    expect(saved).toMatchObject({ mode: "docked", dock: "pdf" });
  });

  it("收成「页 · p.印刷页」小标（宽度渐变），再点展开", async () => {
    const info = await browser.executeObsidian(async () => {
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const bar = () => document.querySelector<HTMLElement>(".aps-toolbar")!;
      const fullWidth = bar().getBoundingClientRect().width;
      bar().querySelector<HTMLElement>('[aria-label="收起成小标"]')!.click();
      await wait(60);
      const midWidth = bar().getBoundingClientRect().width;
      await wait(800);
      const collapsed = bar().classList.contains("aps-collapsed");
      const chip = bar().querySelector<HTMLElement>(".aps-chip")!;
      const chipText = chip.textContent;
      const chipWidth = bar().getBoundingClientRect().width;
      bar().querySelector<HTMLElement>('[aria-label="展开工具条"]')!.click();
      await wait(800);
      return { collapsed, chipText, chipWidth, fullWidth, midWidth, expanded: !bar().classList.contains("aps-collapsed"), finalWidth: bar().getBoundingClientRect().width };
    });
    // 收起过程中宽度在两者之间（弹簧渐变，不是瞬切）
    expect(info.midWidth).toBeLessThan(info.fullWidth);
    expect(info.midWidth).toBeGreaterThan(info.chipWidth);
    expect(Math.abs(info.finalWidth - info.fullWidth)).toBeLessThan(2);
    expect(info.collapsed).toBe(true);
    expect(info.chipWidth).toBeGreaterThan(0);
    expect(info.chipWidth).toBeLessThan(info.fullWidth / 2);
    expect(info.chipText).toMatch(/^\d+( · p\.\S+)?$/);
    expect(info.expanded).toBe(true);
    // 放回默认（正文顶部），后面的截图用
    await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as any).plugins.plugins["aihistory-pdf-sync"];
      plugin.settings.toolbar = { mode: "docked", dock: "markdown", x: 120, y: 120, collapsed: false };
      await plugin.saveSettings();
      plugin.settingsChanged();
    });
    await settle(600);
  });

  it("减少动效：收起照常，但一律瞬切（下一帧宽度就是终值）", async () => {
    const info = await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as any).plugins.plugins["aihistory-pdf-sync"];
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      plugin.settings.reducedMotion = true;
      plugin.settingsChanged();
      await wait(100);
      const bar = () => document.querySelector<HTMLElement>(".aps-toolbar")!;
      bar().querySelector<HTMLElement>('[aria-label="收起成小标"]')!.click();
      await wait(60);
      const early = bar().getBoundingClientRect().width;
      await wait(600);
      const late = bar().getBoundingClientRect().width;
      const collapsed = bar().classList.contains("aps-collapsed");
      bar().querySelector<HTMLElement>('[aria-label="展开工具条"]')!.click();
      plugin.settings.reducedMotion = false;
      await plugin.saveSettings();
      plugin.settingsChanged();
      await wait(300);
      return { collapsed, early, late };
    });
    expect(info.collapsed).toBe(true);
    expect(Math.abs(info.early - info.late)).toBeLessThan(1);
  });

  it("状态栏常驻页码", async () => {
    const text = await browser.executeObsidian(() => document.querySelector(".aps-status")?.textContent ?? "");
    expect(text).toMatch(/^PDF \d+\/23/);
  });

  it("复制本页修订请求：带绝对路径、页码、印刷页", async () => {
    const request = await browser.executeObsidian(async ({ app }) => {
      const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
      await controller.jumpToPage(13);
      const text: string = await controller.copyRevisionRequest();
      const clipboard = (window as any).require("electron").clipboard.readText();
      return { text, clipboard };
    });
    expect(request.text).toContain("PDF 第 13 页（印刷页 p.9）");
    expect(request.text).toMatch(/笔记：[A-Za-z]:[\\/].*02-史學之界說\.md/);
    expect(request.clipboard).toBe(request.text);
  });
});

describe("疑字清单链接", function () {
  it("obsidian:// 链接：打开文件、在该页用 ctx 消歧选中现字，PDF 翻到该页并高亮", async () => {
    const result = await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as any).plugins.plugins["aihistory-pdf-sync"];
      // Obsidian 收到 obsidian://aihistory-pdf-sync?... 时调的就是这个处理函数
      const handler = (app as any).workspace.protocolHandler?.handlers?.get?.("aihistory-pdf-sync");
      const params = { action: "aihistory-pdf-sync", vault: app.vault.getName(), file: "新史學/03-論正統.md", page: "19", text: "誰爲", ctx: "正而誰爲僞也" };
      if (handler) handler(params);
      else await plugin.controller.openSuspectLink({ file: params.file, page: 19, text: params.text, ctx: params.ctx });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const editor = plugin.controller.markdownView.editor;
      const from = editor.posToOffset(editor.getCursor("from"));
      const value: string = editor.getValue();
      return {
        viaHandler: !!handler,
        file: plugin.controller.markdownView.file.path,
        selected: editor.getSelection(),
        context: value.slice(from - 3, from + 4),
        highlighted: document.querySelectorAll('.page[data-page-number="19"] .aps-hl').length
      };
    });
    expect(result.file).toBe(FILE("03-論正統"));
    expect(result.selected).toBe("誰爲");
    expect(result.context).toBe("爲正而誰爲僞也");
    await browser.waitUntil(async () => browser.executeObsidian(() => document.querySelectorAll('.page[data-page-number="19"] .aps-hl').length > 0), { timeout: 5000, timeoutMsg: "PDF 第 19 页没有高亮" });
    expect(result.viaHandler).toBe(true);
  });
});

describe("补页码锚点", function () {
  it("无锚点笔记：预览出把握报告；确认后写入，与原锚点位置一致，正文字一个不变", async () => {
    await browser.executeObsidian(async ({ app }) => {
      const file = app.vault.getAbstractFileByPath("补锚点/无锚点.md");
      await (app as any).plugins.plugins["aihistory-pdf-sync"].controller.markdownLeaf.openFile(file as any);
    });
    await browser.waitUntil(async () => browser.executeObsidian(({ app }) => {
      const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
      return controller.markdownView?.file?.path === "补锚点/无锚点.md" && !!controller.pdf?.ready;
    }), { timeoutMsg: "无锚点笔记没接管" });
    await browser.executeObsidian(async ({ app }) => {
      await (app as any).plugins.plugins["aihistory-pdf-sync"].controller.openPagemarkPreview();
    });
    await browser.waitUntil(async () => browser.executeObsidian(() => document.querySelectorAll(".aps-pagemark-table tbody tr").length > 0), { timeoutMsg: "预览表没出来" });
    const preview = await browser.executeObsidian(() => ({
      report: document.querySelector(".aps-pagemark-report")?.textContent ?? "",
      rows: [...document.querySelectorAll(".aps-pagemark-table tbody tr")].map((row) => [...row.querySelectorAll("td")].slice(1).map((cell) => cell.textContent))
    }));
    console.log(preview.report);
    for (const row of preview.rows) console.log(row.join(" | "));
    await browser.saveScreenshot(`${SCREENSHOTS}/07-补锚点预览.png`);
    const pages = preview.rows.map((row) => Number(row[0]));
    expect(pages).toEqual(expect.arrayContaining([12, 13, 14, 15, 16]));
    const before = await browser.executeObsidian(async ({ app }) => app.vault.read(app.vault.getAbstractFileByPath("补锚点/无锚点.md") as any));
    await browser.executeObsidian(() => {
      const buttons = [...document.querySelectorAll<HTMLButtonElement>(".aps-pagemark-modal button")];
      buttons.find((button) => button.textContent === "写入勾选的页")!.click();
    });
    await settle(800);
    const after = await browser.executeObsidian(async ({ app }) => app.vault.read(app.vault.getAbstractFileByPath("补锚点/无锚点.md") as any));
    expect(after.replace(/<!--pdf-page\.\d+-->(\n\n)?/g, "")).toBe(before);
    // 与原稿（第二章）的锚点对照：每个插入点后面的 12 个字相同
    const original = await browser.executeObsidian(async ({ app }) => app.vault.read(app.vault.getAbstractFileByPath("新史學/02-史學之界說.md") as any));
    const following = (text: string, page: number) => {
      const at = text.indexOf(`<!--pdf-page.${page}-->`);
      return at === -1 ? null : text.slice(at).replace(/<!--[\s\S]*?-->/g, "").replace(/\s/g, "").slice(0, 12);
    };
    for (const page of [12, 13, 14, 15, 16]) expect(following(after, page)).toBe(following(original, page));
  });
});
