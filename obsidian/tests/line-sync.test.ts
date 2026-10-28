import { describe, expect, it } from "vitest";
import { markdownPointAt, parsedText, type EditorView } from "../src/core/cm-sync";
import type { AlignPoint, PdfPageLines } from "../src/core/line-align";
import { LineMap } from "../src/core/line-map";
import { markdownTargetForPdf, pdfTargetForMarkdown } from "../src/core/line-sync";

/** 正文阅读高度 = 偏移 × 2；PDF 每页高 1000、页缝 20 */
const markdownHeight = (offset: number) => offset * 2;
const pdfHeight = (page: number, fraction: number) => (page - 1) * 1020 + fraction * 1000;

describe("line sync", () => {
  const points: AlignPoint[] = [
    { offset: 0, page: 1, fraction: 0.1 },
    { offset: 100, page: 1, fraction: 0.5 },
    { offset: 200, page: 1, fraction: 0.85 },
    { offset: 220, page: 2, fraction: 0.12 }
  ];

  it("interpolates between neighbouring lines and slides over the page gap", () => {
    expect(pdfTargetForMarkdown(points, 100, markdownHeight, pdfHeight)).toBeCloseTo(300);
    // 第 1 页末行到第 2 页首行之间：正文只走一行多，PDF 滑过页脚、页缝、页眉
    expect(pdfTargetForMarkdown(points, 420, markdownHeight, pdfHeight)).toBeCloseTo(850 + (1140 - 850) / 2);
  });

  it("clamps before the first and after the last point", () => {
    expect(pdfTargetForMarkdown(points, -50, markdownHeight, pdfHeight)).toBeCloseTo(100);
    expect(pdfTargetForMarkdown(points, 5000, markdownHeight, pdfHeight)).toBeCloseTo(1140);
    expect(pdfTargetForMarkdown([], 10, markdownHeight, pdfHeight)).toBeNull();
  });

  it("holds instead of sweeping backwards (body text into chapter-end notes)", () => {
    const withNote = [...points, { offset: 400, page: 1, fraction: 0.9 }];
    expect(pdfTargetForMarkdown(withNote, 600, markdownHeight, pdfHeight)).toBeCloseTo(1140);
    expect(pdfTargetForMarkdown(withNote, 800, markdownHeight, pdfHeight)).toBeCloseTo(900);
  });

  it("maps the PDF back to the same reading height", () => {
    for (const height of [40, 200, 410, 430]) {
      const pdf = pdfTargetForMarkdown(points, height, markdownHeight, pdfHeight)!;
      expect(markdownTargetForPdf(points, pdf, markdownHeight, pdfHeight)).toBeCloseTo(height);
    }
  });

  it("follows one column of a two-column page when the PDF leads", () => {
    const columns: AlignPoint[] = [
      { offset: 0, page: 1, fraction: 0.1 },
      { offset: 100, page: 1, fraction: 0.9 },
      { offset: 200, page: 1, fraction: 0.1 },
      { offset: 300, page: 1, fraction: 0.9 }
    ];
    expect(markdownTargetForPdf(columns, 500, markdownHeight, pdfHeight)).toBeCloseTo(100);
  });

  it("skips points it cannot measure", () => {
    const partial = (offset: number) => (offset >= 200 ? null : offset * 2);
    expect(pdfTargetForMarkdown(points, 1000, partial, pdfHeight)).toBeCloseTo(500);
  });
});

describe("line map", () => {
  const TEXT = [
    "<!--pdf-page.1-->",
    "",
    "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黃宇宙洪荒日月盈昃辰宿列張寒來暑往秋收冬藏[^1]",
    "",
    "閏餘成歲律呂調陽雲騰致雨露結為霜金生麗水玉出崑岡劍號巨闕珠稱夜光果<!--pdf-page.2-->珍李柰菜重芥薑海鹹河淡鱗潛羽翔",
    "",
    "龍師火帝鳥官人皇始制文字乃服衣裳推位讓國有虞陶唐弔民伐罪周發殷湯坐朝問道垂拱平章",
    "",
    "[^1]: <!--pdf-page.1--> 千字文的注文在章末，正文裡沒有這幾個字。",
    ""
  ].join("\n");
  const lines = (page: number, texts: string[]): PdfPageLines => ({ page, lines: texts.map((text, index) => ({ top: 0.1 + index * 0.05, bottom: 0.13 + index * 0.05, text })) });
  const PAGES: Record<number, PdfPageLines> = {
    1: lines(1, ["頁眉", "甲乙丙丁戊己庚辛壬癸子丑寅卯", "辰巳午未申酉戌亥天地玄黃宇宙", "洪荒日月盈昃辰宿列張寒來暑往", "秋收冬藏閏餘成歲律呂調陽雲騰", "致雨露結為霜金生麗水玉出崑岡", "劍號巨闕珠稱夜光果", "千字文的注文在章末正文裡沒有這幾個字"]),
    2: lines(2, ["頁眉", "珍李柰菜重芥薑海鹹河淡鱗潛羽", "翔龍師火帝鳥官人皇始制文字乃", "服衣裳推位讓國有虞陶唐弔民伐", "罪周發殷湯坐朝問道垂拱平章"])
  };

  function map(source: Record<number, PdfPageLines | null>) {
    const loaded: number[] = [];
    const lineMap = new LineMap(async (page) => {
      loaded.push(page);
      return source[page] ?? null;
    });
    lineMap.reset("書.pdf");
    return { lineMap, loaded };
  }

  it("answers with page fallbacks first, then with lines once the text layer is read", async () => {
    const { lineMap, loaded } = map(PAGES);
    const parsed = parsedText(TEXT);
    const before = lineMap.pointsNearOffset(parsed, TEXT.indexOf("辰巳"));
    expect(before.every((point) => point.fraction === 0 || point.fraction === 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loaded.sort()).toEqual([1, 2]);
    const after = lineMap.pointsNearOffset(parsed, TEXT.indexOf("辰巳"));
    expect(after.length).toBeGreaterThanOrEqual(10);
    // 第 1 页第二行（页眉之后）从「辰巳」起，对齐高度在它的行顶之上、上一行顶之下
    const second = after.find((point) => point.page === 1 && TEXT.slice(point.offset, point.offset + 2) === "辰巳")!;
    expect(second.fraction).toBeGreaterThan(0.15);
    expect(second.fraction).toBeLessThan(0.2);
    // 第 2 页首行从段中的锚点后起
    const pageTwo = after.find((point) => point.page === 2)!;
    expect(TEXT.slice(pageTwo.offset, pageTwo.offset + 2)).toBe("珍李");
  });

  it("uses the chapter-end note itself when the reading position is in the notes", async () => {
    const { lineMap } = map(PAGES);
    const parsed = parsedText(TEXT);
    lineMap.prefetch([1, 2]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const note = lineMap.pointsNearOffset(parsed, TEXT.indexOf("千字文"));
    expect(note.length).toBeGreaterThan(0);
    expect(note.every((point) => point.page === 1 && point.offset >= TEXT.indexOf("[^1]:"))).toBe(true);
  });

  it("says the PDF is vertical writing instead of calling it garbage", async () => {
    const pages: Record<number, PdfPageLines> = {};
    for (let page = 1; page <= 3; page += 1) pages[page] = { page, lines: [{ top: 0.1, bottom: 0.9, text: "豎排的一列字" }], vertical: true };
    const { lineMap } = map(pages);
    const problems: string[] = [];
    lineMap.onProblem = (problem) => problems.push(problem);
    const parsed = parsedText(Array.from({ length: 3 }, (_, index) => `<!--pdf-page.${index + 1}-->\n\n${"正文的字".repeat(10)}\n`).join("\n"));
    lineMap.prefetch([1, 2, 3]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let index = 0; index < parsed.segments.length; index += 1) lineMap.segmentPoints(parsed, index);
    expect(problems).toEqual(["vertical"]);
  });

  it("reports once that a PDF has no usable text layer", async () => {
    const pages: Record<number, PdfPageLines> = {};
    for (let page = 1; page <= 6; page += 1) pages[page] = { page, lines: [] };
    const { lineMap } = map(pages);
    const problems: string[] = [];
    lineMap.onProblem = (problem) => problems.push(problem);
    const many = Array.from({ length: 6 }, (_, index) => `<!--pdf-page.${index + 1}-->\n\n${"正文的字".repeat(10)}\n`).join("\n");
    const parsed = parsedText(many);
    lineMap.prefetch([1, 2, 3, 4, 5, 6]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let index = 0; index < parsed.segments.length; index += 1) lineMap.segmentPoints(parsed, index);
    expect(problems).toEqual(["none"]);
  });
});

describe("markdown point", () => {
  /** 假编辑器：每个字 10px 宽、每行 10 字、行高 20，全文都在视口里 */
  function fakeView(text: string): EditorView {
    const doc = { length: text.length, toString: () => text };
    const rect = { left: 0, top: 0, width: 100, height: 400, right: 100, bottom: 400 } as DOMRect;
    const block = { from: 0, to: text.length, top: 0, height: Math.ceil(text.length / 10) * 20 };
    return {
      state: { doc },
      scrollDOM: { getBoundingClientRect: () => rect } as unknown as HTMLElement,
      contentDOM: { getBoundingClientRect: () => rect } as unknown as HTMLElement,
      documentTop: 0,
      defaultLineHeight: 20,
      viewport: { from: 0, to: text.length },
      lineBlockAt: () => block,
      lineBlockAtHeight: () => block,
      coordsAtPos: (pos: number) => ({ left: (pos % 10) * 10, right: (pos % 10) * 10 + 10, top: Math.floor(pos / 10) * 20, bottom: Math.floor(pos / 10) * 20 + 20 })
    };
  }

  it("knows which side of a mid-line page anchor the reading line is on", () => {
    // 锚点夹在一个长段中间、又在同一显示行的中间：阅读高度 = 2 × 偏移，阅读线压在锚点前一个字上仍是上一页
    const text = `<!--pdf-page.1-->${"甲".repeat(45)}<!--pdf-page.2-->${"乙".repeat(60)}`;
    const view = fakeView(text);
    const anchor = text.indexOf("<!--pdf-page.2-->");
    expect(anchor % 10).not.toBe(0);
    const before = markdownPointAt(view, (2 * (anchor - 1) + 1) / 400);
    expect(before).toMatchObject({ page: 1, offset: anchor - 1 });
    const after = markdownPointAt(view, (2 * anchor) / 400);
    expect(after).toMatchObject({ page: 2, offset: anchor });
  });
});
