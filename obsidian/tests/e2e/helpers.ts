import { browser } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

export const BOOK = "新史學";
export const FILE = (name: string) => `${BOOK}/${name}.md`;
/** 端到端测试顺手拍的图：放 git 忽略的 .scratch 下，不进仓库（wdio.conf.mts 开跑前建好目录） */
export const SCREENSHOTS = ".scratch/screenshots";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 打开笔记，等插件接管（配到书、PDF 窗格就绪） */
export async function openBookFile(path: string): Promise<void> {
  await obsidianPage.openFile(path);
  await browser.waitUntil(async () => browser.executeObsidian(({ app }, wanted) => {
    const controller = (app as any).plugins.plugins["aihistory-pdf-sync"]?.controller;
    return !!controller?.book && controller.markdownView?.file?.path === wanted && !!controller.pdf?.ready && controller.pdf.container.getBoundingClientRect().height > 0;
  }, path), { timeout: 30_000, timeoutMsg: `插件没接管 ${path}` });
}

export async function setMode(mode: "source" | "live" | "preview"): Promise<void> {
  await browser.executeObsidian(async ({ app }, wanted) => {
    const leaf = (app as any).plugins.plugins["aihistory-pdf-sync"].controller.markdownLeaf;
    const state = leaf.getViewState();
    state.state.mode = wanted === "preview" ? "preview" : "source";
    state.state.source = wanted === "source";
    await leaf.setViewState(state);
  }, mode);
  await browser.pause(400);
}

export async function settle(ms = 500): Promise<void> {
  await browser.pause(ms);
}

export interface Points {
  markdown: { page: number; fraction: number } | null;
  pdf: { page: number; fraction: number } | null;
  file: string | null;
}

export async function points(): Promise<Points> {
  return browser.executeObsidian(({ app }) => {
    const controller = (app as any).plugins.plugins["aihistory-pdf-sync"].controller;
    return { markdown: controller.markdownPoint(), pdf: controller.pdfPoint(), file: controller.markdownView?.file?.path ?? null };
  });
}

/** 窗口尺寸：WebDriver 的 setWindowSize 在 Electron 里不可用，走 @electron/remote */
export async function windowSize(width: number, height: number): Promise<void> {
  await browser.execute((w, h) => {
    const req = (window as unknown as { require: (name: string) => any }).require;
    req("@electron/remote").getCurrentWindow().setSize(w, h);
  }, width, height);
  await browser.pause(300);
}
