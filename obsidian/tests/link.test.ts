import { describe, expect, it } from "vitest";
import { locateSuspect, parseSuspectLink, uriParams } from "../src/core/link";
import { buildRevisionRequest } from "../src/core/revision";

describe("obsidian:// suspect links", () => {
  it("parses an encoded URI", () => {
    const uri = "obsidian://aihistory-pdf-sync?vault=%E5%BA%93&file=%E4%B9%A6%2F01-%E6%AD%A3%E6%96%87.md&page=4&text=%E9%BB%94&ctx=%E6%96%B0%E9%BB%94%E9%A6%96";
    const params = uriParams(uri);
    expect(params.action).toBe("aihistory-pdf-sync");
    expect(parseSuspectLink(params)).toEqual({ file: "书/01-正文.md", page: 4, text: "黔", ctx: "新黔首" });
  });

  it("tolerates a missing page and rejects a missing file", () => {
    expect(parseSuspectLink({ file: "/a.md", page: "x" })?.page).toBeNull();
    expect(parseSuspectLink({ page: "3" })).toBeNull();
  });

  it("locates the text using ctx, with or without the text inside ctx", () => {
    const segment = "新地吏收受新黔首的酒肉，旧黔首则不同，新黔首勿强";
    const second = segment.lastIndexOf("黔");
    expect(locateSuspect(segment, "黔", "首勿强")).toEqual([second, second + 1]);
    expect(locateSuspect(segment, "黔", "同，新黔首勿")).toEqual([second, second + 1]);
    const first = segment.indexOf("黔");
    expect(locateSuspect(segment, "黔", "收受新黔首的酒")).toEqual([first, first + 1]);
  });

  it("falls back to fuzzy matching across punctuation", () => {
    const segment = "秦的皇权郡县制统治依赖文书，天下事通过文书汇集";
    const hit = locateSuspect(segment, "依赖文书天下事", "统治依赖文书天下事通过");
    expect(segment.slice(...hit!)).toBe("依赖文书，天下事");
    expect(locateSuspect(segment, "", "")).toBeNull();
  });
});

describe("revision request", () => {
  it("builds a request with page, printed page and head/tail", () => {
    const text = buildRevisionRequest({
      notePath: "D:/库/书/01-正文.md",
      pdfPath: "D:/库/书/书.pdf",
      page: 4,
      printed: "113",
      segment: `<!--pdf-page.4--><!--p.113-->${"甲".repeat(40)}${"乙".repeat(40)}`,
      selection: "乙乙"
    });
    expect(text).toContain("PDF 第 4 页（印刷页 p.113）");
    expect(text).toContain(`本页开头：${"甲".repeat(30)}`);
    expect(text).toContain(`本页结尾：${"乙".repeat(30)}`);
    expect(text).toContain("选中的文字：乙乙");
  });
});
