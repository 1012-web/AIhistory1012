import { describe, expect, it } from "vitest";
import { buildCharOriginMap, findBestNormalizedRange, matchSegmentSlices, normalizeText } from "../src/core/collation/compare";
import { mergeLineBoxes } from "../src/core/collation/pdf-dom";
import { applyPagemarks, maskForMatching, planPagemarks } from "../src/core/pagemarks";
import { parseAnchors } from "../src/core/anchors";

describe("normalizeText", () => {
  it("drops punctuation, anchors, footnote refs; folds width and case", () => {
    expect(normalizeText("“秦为何速亡？”[^1]<!--pdf-page.3--><!--p.12-->ＡＢ c")).toBe("秦为何速亡abc");
  });
});

describe("buildCharOriginMap", () => {
  it("maps normalized chars back to segments", () => {
    const { norm, origins } = buildCharOriginMap(["秦，", "<!--pdf-page.2-->汉"]);
    expect(norm).toBe("秦汉");
    expect(origins[1]).toMatchObject({ segIdx: 1, charIdx: 17 });
  });
});

describe("findBestNormalizedRange", () => {
  it("uses context to pick among duplicates", () => {
    const full = normalizeText("秦始皇死后秦二世立，秦始皇的权威无法转移");
    const hit = findBestNormalizedRange(full, normalizeText("秦始皇"), normalizeText("立，"), normalizeText("的权威"));
    expect(hit?.start).toBe(full.lastIndexOf("秦始皇"));
  });

  it("brackets a corrected word by its context", () => {
    const full = normalizeText("这位著名演员谢天豪出演了这部电影");
    const hit = findBestNormalizedRange(full, normalizeText("谢君豪"), normalizeText("著名演员"), normalizeText("出演了这部"));
    expect(full.slice(hit!.start, hit!.end)).toBe("谢天豪");
  });
});

describe("matchSegmentSlices", () => {
  it("matches across PDF text-layer spans", () => {
    const spans = ["新史學（演示排印本）", "史學之功居其半焉然則", "但患其國之無茲學耳"];
    const result = matchSegmentSlices(spans, "然則但患其國");
    expect(result?.slices).toEqual([
      { segIdx: 1, startOffset: 8, endOffset: 10 },
      { segIdx: 2, startOffset: 0, endOffset: 4 }
    ]);
  });
});

describe("mergeLineBoxes", () => {
  it("merges boxes on one line", () => {
    const merged = mergeLineBoxes([
      { left: 0, top: 0, width: 10, height: 10 },
      { left: 12, top: 1, width: 10, height: 10 },
      { left: 0, top: 30, width: 10, height: 10 }
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].width).toBe(22);
  });
});

describe("pagemarks", () => {
  // 文字取自演示书《新史學》（梁启超，1902；据维基文库，CC BY-SA 4.0）
  const pages: Array<[number, string]> = [
    [1, "新史學 1 中國之舊史 梁啟超 於今日泰西通行諸學科中，為中國所固有者，惟史學。史學者，學問之最博大而最切要者也。"],
    [2, "新史學 2 列國所以日進文明，史學之功居其半焉。然則但患其國之無茲學耳，苟其有之，則國民安有不團結者"],
    [3, "3 史學之界說 第一，歷史者，敘述進化之現象也。現象者何？事物之變化也。宇宙間之現象有二種"]
  ];
  const text = [
    "---",
    "title: 测试",
    "---",
    "",
    "# 中國之舊史",
    "",
    "於今日泰西通行諸學科中，為中國所固有者，惟史學。史學者，學問之最博大而最切要者也。",
    "",
    "今日歐洲民族主義所以發達，列國所以日進文明，史學之功居其半焉。然則但患其國之無茲學耳，苟其有之，則國民安有不團結者？",
    "",
    "## 史學之界說",
    "",
    "第一，歷史者，敘述進化之現象也。現象者何？事物之變化也。",
    "",
    "[^1]: 列國所以日進文明，史學之功居其半焉（脚注里的同样文字不该被选中）"
  ].join("\n");

  it("masks frontmatter, comments and footnotes without moving offsets", () => {
    const masked = maskForMatching(text);
    expect(masked).toHaveLength(text.length);
    expect(masked).not.toContain("title");
    expect(masked).not.toContain("脚注里");
  });

  it("plans monotone insertions with placement and confidence", () => {
    const plan = planPagemarks(text, pages);
    expect(plan.proposals.map((p) => p.page)).toEqual([1, 2, 3]);
    const [first, second, third] = plan.proposals;
    expect(first.placement).toBe("line");
    expect(text.slice(first.pos).startsWith("於今日")).toBe(true);
    expect(text.slice(second.pos, second.pos + 4)).toBe("列國所以");
    expect(second.placement).toBe("mid");
    expect(second.confidence).toBe("high");
    expect(third.placement).toBe("line");
    expect(text.slice(third.pos).startsWith("## 史學之界說")).toBe(true);
    expect(first.pos).toBeLessThan(second.pos);
  });

  it("writes anchors without touching existing ones", () => {
    const withExisting = text.replace("第一，歷史者", "<!--pdf-page.3-->第一，歷史者");
    const plan = planPagemarks(withExisting, pages);
    expect(plan.existing).toEqual([3]);
    const written = applyPagemarks(withExisting, plan.proposals);
    expect(parseAnchors(written).map((a) => a.page)).toEqual([1, 2, 3]);
    expect(written).toContain("發達，<!--pdf-page.2-->列國所以");
    expect(written).toContain("<!--pdf-page.1-->\n\n於今日");
    expect(written.replace(/<!--pdf-page\.\d+-->(\n\n)?/g, "")).toBe(withExisting.replace(/<!--pdf-page\.\d+-->/g, ""));
  });

  it("reports pages without text", () => {
    const plan = planPagemarks(text, [[1, " 107 "], [9, "完全不相干的另一篇文章里的话语内容绝不出现"]]);
    expect(plan.empty).toEqual([1]);
    expect(plan.missing).toEqual([9]);
  });
});
