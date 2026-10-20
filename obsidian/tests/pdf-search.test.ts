import { describe, expect, it } from "vitest";
import { DEFAULT_VARIANT_OPTIONS, PdfFinder, buildVariantTable, queryUnits, searchPages } from "../src/core/pdf-search";

const table = buildVariantTable(DEFAULT_VARIANT_OPTIONS);

describe("PDF 繁简通搜", () => {
  it("折叠：繁体查询命中简体正文，反之亦然；禍／祸同组", () => {
    expect(searchPages(["西汉的灾异政治"], "災異", table)).toMatchObject([{ page: 1, text: "灾异" }]);
    expect(searchPages(["西漢的災異政治"], "灾异", table)).toMatchObject([{ page: 1, text: "災異" }]);
    expect(table.rep("禍")).toBe(table.rep("祸"));
    expect(searchPages(["天降禍福"], "祸福", table)).toHaveLength(1);
    // 「旤」不在三档 Unihan 表里（与 Better Search Result Views 一致：要靠自定义异体组）
    expect(table.rep("旤")).not.toBe(table.rep("禍"));
  });

  it("不开对照表时只认字面", () => {
    expect(searchPages(["西汉的灾异"], "災異", null)).toHaveLength(0);
    expect(searchPages(["西汉的灾异"], "灾异", null)).toHaveLength(1);
  });

  it("全半角、空白归一：查询里的空格不算字", () => {
    expect(queryUnits("史 学，")).toEqual(["史", "学", ","]);
    expect(searchPages(["史学,群学"], "史学，", table)).toHaveLength(1);
  });

  it("跨行：文字层折行处的换行不算字", () => {
    const hits = searchPages(["一种特殊能力，而这种\n能力是可以获得的。"], "而這種能力是", table);
    expect(hits).toMatchObject([{ page: 1, endPage: 1, text: "而这种\n能力是" }]);
  });

  it("跨页：命中记在起始页，text 只取起始页上的部分", () => {
    const hits = searchPages(["……都在探索如何", "维持灾异的政治"], "如何維持", table);
    expect(hits).toMatchObject([{ page: 1, endPage: 2, text: "如何" }]);
    expect(hits[0].before).toBe("……都在探索");
  });

  it("多处命中按页序；不重叠", () => {
    const hits = searchPages(["灾异灾异", "災異"], "灾异", table);
    expect(hits.map((hit) => [hit.page, hit.from])).toEqual([[1, 0], [1, 2], [2, 0]]);
  });

  it("PdfFinder 只取一次文字", async () => {
    let calls = 0;
    const finder = new PdfFinder({ pageCount: () => 2, pageText: async (page) => (calls += 1, page === 1 ? "史學" : "史学") });
    expect(await finder.search("史学", DEFAULT_VARIANT_OPTIONS)).toHaveLength(2);
    expect(await finder.search("史", DEFAULT_VARIANT_OPTIONS)).toHaveLength(2);
    expect(calls).toBe(2);
  });
});
