import { describe, expect, it } from "vitest";
import {
  anchorProblems,
  footnoteRanges,
  footnotesForPage,
  frontmatterLength,
  pageAtOffset,
  pageSegments,
  parseAnchors,
  segmentForPage,
  stripAnchors
} from "../src/core/anchors";

const DOC = [
  "---",
  "pdf: \"[[书.pdf]]\"",
  "note: <!--pdf-page.99-->",
  "---",
  "",
  "引子一行",
  "",
  "<!--pdf-page.3--><!--p.112-->",
  "",
  "# 第一章",
  "",
  "第一段正文，跨页<!--pdf-page.4--><!--p.113-->接着写。[^1]",
  "",
  "第二段。",
  "",
  "[^1]: <!--pdf-page.4--><!--p.113--> 注文一",
  "[^2]: <!--pdf-page.3--><!--p.112--> 注文二",
  "    续行",
  ""
].join("\n");

describe("anchors", () => {
  it("skips frontmatter", () => {
    expect(DOC.slice(0, frontmatterLength(DOC))).toMatch(/---\n$/);
    expect(parseAnchors(DOC).some((anchor) => anchor.page === 99)).toBe(false);
  });

  it("parses page and printed anchors, flags footnotes", () => {
    const anchors = parseAnchors(DOC);
    expect(anchors.map((a) => [a.page, a.printed, a.footnote])).toEqual([
      [3, "112", false],
      [4, "113", false],
      [4, "113", true],
      [3, "112", true]
    ]);
  });

  it("finds footnote ranges with continuation lines", () => {
    const ranges = footnoteRanges(DOC);
    expect(ranges).toHaveLength(2);
    expect(DOC.slice(...ranges[1])).toContain("续行");
  });

  it("cuts pages, mid-line seams, stops body at footnotes", () => {
    const segments = pageSegments(DOC);
    expect(segments.map((s) => [s.page, !!s.lead])).toEqual([[2, true], [3, false], [4, false]]);
    const page4 = segmentForPage(segments, 4)!;
    expect(DOC.slice(page4.from, page4.to)).toMatch(/^<!--pdf-page\.4-->/);
    expect(DOC.slice(page4.from, page4.to)).not.toContain("注文一");
    const page3 = segmentForPage(segments, 3)!;
    expect(DOC.slice(page3.from, page3.to)).toContain("第一段正文，跨页");
  });

  it("looks up the page at an offset, including footnotes", () => {
    expect(pageAtOffset(DOC, DOC.indexOf("接着写"))?.page).toBe(4);
    expect(pageAtOffset(DOC, DOC.indexOf("第一章"))?.page).toBe(3);
    expect(pageAtOffset(DOC, DOC.indexOf("注文二"))).toMatchObject({ page: 3, footnote: true });
    expect(pageAtOffset(DOC, DOC.indexOf("续行"))).toMatchObject({ page: 3, footnote: true });
    expect(pageAtOffset("无锚点", 1)).toBeNull();
  });

  it("lists footnotes of a page", () => {
    const notes = footnotesForPage(DOC, 4);
    expect(notes).toHaveLength(1);
    expect(DOC.slice(...notes[0])).toContain("注文一");
  });

  it("reports duplicate and out-of-order anchors", () => {
    const text = "<!--pdf-page.2-->a<!--pdf-page.1-->b<!--pdf-page.2-->c";
    expect(anchorProblems(parseAnchors(text))).toHaveLength(2);
    expect(anchorProblems(parseAnchors(DOC))).toEqual([]);
  });

  it("strips anchors", () => {
    expect(stripAnchors("a<!--pdf-page.3--><!--p.12-->b")).toBe("ab");
  });
});

import { headingBefore } from "../src/core/headings";

describe("headings", () => {
  it("finds the nearest heading before an offset, skipping code fences", () => {
    const text = "---\na: 1\n---\n# 第一章\n正文\n```\n# 不是标题\n```\n## 第一节 <!--pdf-page.3-->\n更多";
    expect(headingBefore(text, text.indexOf("正文"))?.text).toBe("第一章");
    expect(headingBefore(text, text.indexOf("更多"))).toMatchObject({ level: 2, text: "第一节" });
    expect(headingBefore(text, 2)).toBeNull();
  });
});

import { segmentForPageOrGap } from "../src/core/anchors";

describe("约定第 2 版的几条", () => {
  it("章首：物理页锚点在章标题前，印刷页锚点分开写在标题后，也算本页的印刷页", () => {
    const text = "<!--pdf-page.9-->\n\n# 第一章\n\n<!--p.1-->\n\n正文<!--pdf-page.10--><!--p.2-->接着";
    expect(parseAnchors(text).map((a) => [a.page, a.printed])).toEqual([[9, "1"], [10, "2"]]);
  });

  it("印刷页锚点不会借用到下一页去", () => {
    const text = "<!--pdf-page.1-->\n\n封面\n\n<!--pdf-page.2--><!--p.ii-->";
    expect(parseAnchors(text).map((a) => a.printed)).toEqual([null, "ii"]);
  });

  it("缺页：两个锚点之间缺的页算前一页", () => {
    const text = "<!--pdf-page.3-->甲<!--pdf-page.6-->乙";
    const segments = pageSegments(text);
    expect(segmentForPageOrGap(segments, 6)).toMatchObject({ gap: false, segment: { page: 6 } });
    expect(segmentForPageOrGap(segments, 4)).toMatchObject({ gap: true, segment: { page: 3 } });
    expect(segmentForPageOrGap(segments, 2)).toBeNull();
    // 比本文件最大页还大：不在本文件里，交给调用方换文件
    expect(segmentForPageOrGap(segments, 7)).toBeNull();
  });

  it("局部倒序只列为问题，不影响按页取段", () => {
    const text = "<!--pdf-page.5-->甲<!--pdf-page.7-->乙<!--pdf-page.6-->丙<!--pdf-page.8-->丁";
    expect(anchorProblems(parseAnchors(text))).toHaveLength(1);
    const segment = segmentForPage(pageSegments(text), 6)!;
    expect(text.slice(segment.from, segment.to)).toContain("丙");
  });
});

describe("旧格式与脚注跨页", () => {
  it("只有印刷页锚点的旧文件：按 printedPageOffset 换算物理页（物理页 = 印刷页 + 偏移）", () => {
    const text = "<!--p.107-->\n\n# 题\n\n正文<!--p.108-->接着\n\n[^1]: <!--p.107--> 注";
    expect(parseAnchors(text)).toEqual([]);
    const anchors = parseAnchors(text, -106);
    expect(anchors.map((a) => [a.page, a.printed, a.footnote, a.legacy])).toEqual([[1, "107", false, true], [2, "108", false, true], [1, "107", true, true]]);
    expect(pageAtOffset(text, text.indexOf("接着"), anchors)?.page).toBe(2);
  });

  it("有物理页锚点时不用旧格式换算", () => {
    expect(parseAnchors("<!--pdf-page.3--><!--p.5-->甲", 100).map((a) => a.page)).toEqual([3]);
  });

  it("脚注跨页：注文中间的锚点之后算下一页", () => {
    const text = "<!--pdf-page.4-->正文[^1]\n\n[^1]: <!--pdf-page.4--><!--p.10--> 前半<!--pdf-page.5--><!--p.11-->后半\n";
    expect(pageAtOffset(text, text.indexOf("前半"))?.page).toBe(4);
    expect(pageAtOffset(text, text.indexOf("后半"))?.page).toBe(5);
  });
});
