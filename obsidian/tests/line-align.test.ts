import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pageSegments, parseAnchors, segmentForPage } from "../src/core/anchors";
import { normalizeText } from "../src/core/collation/compare";
import { alignSegment, fallbackPoints, longestIncreasing, textBox, type PdfPageLines } from "../src/core/line-align";
import { groupTextLines } from "../src/core/pdf-lines";

/** 演示书《新史學》第三章（公版，CC BY-SA 4.0）：用来造「PDF 文字层」 */
const CHAPTER = readFileSync(new URL("../../tests/fixtures/clean/新史學/03-論正統.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** 一个固定种子的随机数，测试可重放 */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/** 去掉锚点、脚注号与 Markdown 记号的正文，再按每行 width 字切成「PDF 行」；返回每行文字与它在原文里的起点 */
function typeset(text: string, from: number, to: number, width: number): Array<{ text: string; offset: number }> {
  const lines: Array<{ text: string; offset: number }> = [];
  const slice = text.slice(from, to);
  const skip = /<!--[\s\S]*?-->|\[\^[^\]]+\]|^#+\s|\n/gm;
  const kept: Array<{ ch: string; at: number }> = [];
  let last = 0;
  for (const match of slice.matchAll(skip)) {
    for (let k = last; k < match.index; k += 1) kept.push({ ch: slice[k], at: from + k });
    last = match.index + match[0].length;
  }
  for (let k = last; k < slice.length; k += 1) kept.push({ ch: slice[k], at: from + k });
  for (let k = 0; k < kept.length; k += width) {
    const chunk = kept.slice(k, k + width);
    if (chunk.some((item) => item.ch.trim())) lines.push({ text: chunk.map((item) => item.ch).join(""), offset: chunk[0].at });
  }
  return lines;
}

/** 正文行从页高 12% 排到 86%，页眉在上、页下注与页码在下 */
const spacing = (count: number) => 0.74 / Math.max(1, count);

function pageOf(page: number, body: Array<{ text: string }>, extra: { header?: string; footnote?: string } = {}): PdfPageLines {
  const lines = [];
  const step = spacing(body.length);
  if (extra.header) lines.push({ top: 0.06, bottom: 0.08, text: extra.header });
  body.forEach((line, index) => lines.push({ top: 0.12 + index * step, bottom: 0.12 + index * step + step * 0.7, text: line.text }));
  if (extra.footnote) lines.push({ top: 0.9, bottom: 0.92, text: extra.footnote });
  lines.push({ top: 0.95, bottom: 0.96, text: String(page - 4) });
  return { page, lines };
}

const segments = pageSegments(CHAPTER, parseAnchors(CHAPTER));
const page19 = segmentForPage(segments, 19)!;
const body19 = typeset(CHAPTER, page19.from, page19.to, 26);
const step19 = spacing(body19.length);
/** 对齐点落在哪一行：对齐高度在本行顶之上、上一行顶之下（行中线往上半个行距） */
const lineOf = (fraction: number) => body19.findIndex((_, index) => 0.12 + index * step19 >= fraction - 1e-9);

describe("line alignment", () => {
  it("matches every body line of a page, skipping the running head, footnote and folio", () => {
    const pdf = pageOf(19, body19, { header: "論正統　梁啟超", footnote: "〔演示注〕這一行正文裡沒有，是頁下注。" });
    const result = alignSegment(CHAPTER, page19.from, page19.to, [pdf]);
    expect(result.quality).toBe("lines");
    expect(result.points).toHaveLength(body19.length);
    result.points.forEach((point, index) => {
      expect(point.page).toBe(19);
      expect(lineOf(point.fraction)).toBe(index);
      // 行中线（顶 + 0.35 行距）往上半个行距；末行之后是页下注，行距按字高封顶
      if (index < body19.length - 1) expect(point.fraction).toBeCloseTo(0.12 + index * step19 - 0.15 * step19, 5);
      // 对齐点落在这一行第一个字上（同一个归一化字的位置，允许落在它前面的标点上）
      expect(normalizeText(CHAPTER.slice(point.offset, point.offset + 6)).slice(0, 3)).toBe(normalizeText(body19[index].text).slice(0, 3));
    });
  });

  it("still recognizes the lines when 40% of the text layer is wrong", () => {
    const next = random(1012);
    const pool = "的一是不了人我在有他這中大來上國個到說們為子和你地出道也時年";
    const noisy = body19.map((line) => ({ text: [...line.text].map((ch) => (/\p{Unified_Ideograph}/u.test(ch) && next() < 0.4 ? pool[Math.floor(next() * pool.length)] : ch)).join("") }));
    const result = alignSegment(CHAPTER, page19.from, page19.to, [pageOf(19, noisy)]);
    expect(result.quality).toBe("lines");
    expect(result.points.length).toBeGreaterThanOrEqual(body19.length - 1);
    for (const point of result.points) {
      expect(Math.abs(point.offset - body19[lineOf(point.fraction)].offset)).toBeLessThanOrEqual(4);
    }
  });

  it("gives up on garbage (wrong encoding) and on pages without a text layer", () => {
    const next = random(7);
    const garbage = body19.map((line) => ({ text: [...line.text].map(() => String.fromCharCode(0x4e00 + Math.floor(next() * 20000))).join("") }));
    expect(alignSegment(CHAPTER, page19.from, page19.to, [pageOf(19, garbage)]).quality).toBe("box");
    expect(alignSegment(CHAPTER, page19.from, page19.to, [{ page: 19, lines: [] }]).quality).toBe("page");
    expect(alignSegment(CHAPTER, page19.from, page19.to, [{ ...pageOf(19, body19), vertical: true }])).toMatchObject({ quality: "page", vertical: true });
  });

  it("aligns a page that starts and ends in the middle of a paragraph", () => {
    const segment = segmentForPage(segments, 20)!;
    // 第 20 页的锚点夹在段中：页首一行从锚点后的字起
    expect(CHAPTER[segment.from - 1]).not.toBe("\n");
    const body = typeset(CHAPTER, segment.from, segment.to, 26);
    const result = alignSegment(CHAPTER, segment.from, segment.to, [pageOf(20, body)]);
    expect(result.points[0].offset).toBeLessThanOrEqual(body[0].offset + 1);
    expect(result.points[0].offset).toBeGreaterThanOrEqual(segment.from);
  });

  it("drops matches that break the reading order", () => {
    expect(longestIncreasing([1, 5, 2, 3, 9, 4, 5], (value) => value)).toEqual([1, 2, 3, 4, 5]);
    expect(longestIncreasing([], (value: number) => value)).toEqual([]);
  });

  it("falls back to the text box of each page, then to the whole page", () => {
    const withText = pageOf(19, body19);
    expect(textBox(withText)).toEqual({ top: 0.12, bottom: 0.96 });
    expect(fallbackPoints(100, 300, [withText, { page: 20, lines: [] }])).toEqual([
      { offset: 100, page: 19, fraction: 0.12 },
      { offset: 200, page: 19, fraction: 0.96 },
      { offset: 200, page: 20, fraction: 0 },
      { offset: 300, page: 20, fraction: 1 }
    ]);
  });
});

describe("PDF text layer lines", () => {
  // scale 1、未旋转的 A4 页：PDF 坐标 y 向上，视口 y 向下
  const viewport = { height: 842, convertToViewportPoint: (x: number, y: number) => [x, 842 - y] };
  const item = (str: string, x: number, y: number, size = 10, extra: object = {}) => ({ str, transform: [size, 0, 0, size, x, y], width: str.length * size, height: size, ...extra });

  it("groups items on the same baseline into one line, in stream order", () => {
    const { lines, vertical } = groupTextLines([item("第一行", 50, 800), item("接著寫", 80, 800.5), item(" ", 110, 800, 10, { hasEOL: true }), item("第二行", 50, 780)], {}, viewport);
    expect(vertical).toBe(false);
    expect(lines.map((line) => line.text)).toEqual(["第一行接著寫 ", "第二行"]);
    // 合并后的行取各块里最高的顶（「接著寫」的基线高出半点）
    expect(lines[0].top).toBeCloseTo((842 - 800.5 - 8.5) / 842, 4);
    expect(lines[0].top).toBeLessThan(lines[1].top);
  });

  it("flags vertical writing", () => {
    const sideways = (str: string, x: number) => ({ str, transform: [0, 10, -10, 0, x, 700], height: 10 });
    expect(groupTextLines([sideways("豎排一", 500), sideways("豎排二", 480)], {}, viewport).vertical).toBe(true);
    expect(groupTextLines([item("字", 50, 800, 10, { fontName: "f1" })], { f1: { vertical: true } }, viewport).vertical).toBe(true);
  });

  it("ignores marked-content entries without text", () => {
    expect(groupTextLines([{ type: "beginMarkedContent" }, item("正文", 50, 800)], undefined, viewport).lines).toHaveLength(1);
  });
});
