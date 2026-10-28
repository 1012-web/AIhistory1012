import { describe, expect, it } from "vitest";
import { pageSegments } from "../src/core/anchors";
import { headings, outline } from "../src/core/headings";
import { ALL_LEVELS, EMPTY_BOOK_STATE, expandedIds, headingIds, headingPages, pageLabel, searchKeep, splitMatch, withToggles } from "../src/core/outline-view";

const TEXT = ["# 第一章", "## 导读", "## 第一节", "### 一、甲", "#### 1. 子", "### 二、乙", "# 第二章", "## 导读", "## 第一节", "### 一、丙"].join("\n");
const list = headings(TEXT);
const tree = outline(list);
const ids = headingIds(list, tree, "书/正文.md");
const at = (text: string, from = 0) => list.findIndex((heading, index) => index >= from && heading.text === text);

describe("标题菜单", () => {
  it("编号：带上级与文件，同名的「导读」各章各一个，互不相同", () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[at("导读")]).not.toBe(ids[at("导读", 2)]);
    // 别处改了标题，不影响这一支的编号
    const edited = headings(TEXT.replace("## 第一节\n### 一、甲", "## 第一节（改）\n### 一、甲"));
    const editedIds = headingIds(edited, outline(edited), "书/正文.md");
    expect(editedIds[edited.findIndex((heading) => heading.text === "一、丙")]).toBe(ids[at("一、丙")]);
  });

  it("展开：默认只临时展开当前位置的上级；展开到 H2 = 各章展开；手动记录压过层级", () => {
    const current = at("1. 子");
    expect(expandedIds(list, tree, ids, EMPTY_BOOK_STATE, current).sort()).toEqual([ids[at("第一章")], ids[at("第一节")], ids[at("一、甲")]].sort());
    expect(expandedIds(list, tree, ids, { depth: 2, manual: {} }, -1).sort()).toEqual([ids[at("第一章")], ids[at("第二章")]].sort());
    expect(expandedIds(list, tree, ids, { depth: 2, manual: { [ids[at("第二章")]]: false } }, -1)).toEqual([ids[at("第一章")]]);
    expect(expandedIds(list, tree, ids, { depth: ALL_LEVELS, manual: {} }, -1)).toHaveLength(tree.children.filter((kids) => kids.length).length);
  });

  it("读到别处：旧位置的临时展开收回，手动展开的留着", () => {
    let state = withToggles(EMPTY_BOOK_STATE, [], [ids[at("第二章")]]);
    expect(state.manual).toEqual({ [ids[at("第二章")]]: true });
    const there = expandedIds(list, tree, ids, state, at("一、丙"));
    expect(there).toContain(ids[at("第二章")]);
    const back = expandedIds(list, tree, ids, state, at("导读"));
    expect(back).toContain(ids[at("第一章")]);
    expect(back).toContain(ids[at("第二章")]);
    expect(back).not.toContain(ids[at("第一节", 7)]);
    state = withToggles(state, back, back.filter((id) => id !== ids[at("第二章")]));
    expect(state.manual[ids[at("第二章")]]).toBe(false);
  });

  it("搜索：留下匹配的与它们的上级", () => {
    const found = searchKeep(list, tree, "丙")!;
    expect(found.hits).toEqual([at("一、丙")]);
    expect([...found.keep].sort((a, b) => a - b)).toEqual([at("第二章"), at("第一节", 7), at("一、丙")]);
    expect(searchKeep(list, tree, "  ")).toBeNull();
    expect(splitMatch("一、丙丁丙", "丙")).toEqual([{ text: "一、", hit: false }, { text: "丙", hit: true }, { text: "丁", hit: false }, { text: "丙", hit: true }]);
  });

  it("页码：中文「第50页」、英文「p.50」；没有印刷页只写 PDF 页", () => {
    expect(pageLabel({ page: 65, printed: "50" }, "printed", true)).toBe("第50页");
    expect(pageLabel({ page: 65, printed: "50" }, "printed", false)).toBe("p.50");
    expect(pageLabel({ page: 65, printed: "50" }, "pdf", true)).toBe("PDF 65");
    expect(pageLabel({ page: 65, printed: "50" }, "both", true)).toBe("第50页 · PDF 65");
    expect(pageLabel({ page: 3, printed: null }, "printed", true)).toBe("PDF 3");
  });

  it("各标题所在页：按标题行落在哪个页段", () => {
    const text = "<!--pdf-page.9-->\n# 第一章\n<!--p.1-->\n正文<!--pdf-page.10--><!--p.2-->\n## 第一节\n接着";
    const own = headings(text);
    expect(headingPages(own, pageSegments(text), (_page, fromAnchor) => fromAnchor)).toEqual([{ page: 9, printed: "1" }, { page: 10, printed: "2" }]);
  });
});
