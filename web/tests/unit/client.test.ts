import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { setFrontmatterPdf } from "../../src/s3/core";
import { mapLinkFile, openRequestFromLocation } from "../../src/client/open-link";
import { markdownDoc, maskMarkup, pdfDoc, searchDocs } from "../../src/client/search";
import { buildBookIndex, fileForPage, indexEntry, locateSuspect, pageSegments, parseAnchors, printedLabel, segmentForPage, uriParams, parseSuspectLink } from "../../src/s3/core";

// 多文件书由 scripts/make-fixture.py 按仓库里的《新史學》样本现造（npm run fixture）
const BOOK = resolve(import.meta.dirname, "../../fixtures/新史學");
const read = (name: string) => readFileSync(join(BOOK, name), "utf8");
const head = read("00-卷首.md");
const body = read("01-正文.md");
const index = buildBookIndex("新史學.pdf", "", [indexEntry("00-卷首.md", head), indexEntry("01-正文.md", body)], ["00-卷首.md", "01-正文.md"], 4);

describe("锚点跳转（多文件书）", () => {
  it("第 1–5 页在卷首（第 5 页两个文件都有，取书内靠前的），第 6–11 页在正文", () => {
    for (let page = 1; page <= 5; page += 1) expect(fileForPage(index, page)?.path).toBe("00-卷首.md");
    for (let page = 6; page <= 11; page += 1) expect(fileForPage(index, page)?.path).toBe("01-正文.md");
  });

  it("每页都能找到页段，页段从该页锚点起", () => {
    const segments = pageSegments(body, parseAnchors(body));
    for (let page = 6; page <= 11; page += 1) {
      const segment = segmentForPage(segments, page)!;
      expect(body.slice(segment.from, segment.from + 20)).toMatch(new RegExp(`^<!--pdf-page\\.${page}-->`));
    }
    // 正文开头是第 5 页的续页锚点：第 5 页的后半在正文里有自己的页段；跳页仍取书内靠前的卷首
    expect(segments[0]).toMatchObject({ page: 5 });
    expect(segments[0].lead).toBeFalsy();
    expect(index.files[1].pages[0]).toBe(5);
  });

  it("印刷页：锚点里有就用锚点的，否则按偏移推算", () => {
    expect(printedLabel(index, 7, null)).toBe("3");
    expect(printedLabel(index, 7, "3")).toBe("3");
    expect(printedLabel(index, 2, null)).toBeNull();   // 卷首页（书名页、说明页）没有印刷页
  });

  it("疑字链接在第 7 页段内找到「而已」（本页两处），用 ctx 消歧到「家譜而已」那一处", () => {
    const segments = pageSegments(body, parseAnchors(body));
    const segment = segmentForPage(segments, 7)!;
    const slice = body.slice(segment.from, segment.to);
    expect(slice.split("而已").length - 1).toBe(2);
    const hit = locateSuspect(slice, "而已", "家譜而已")!;
    expect(slice.slice(hit[0] - 2, hit[1])).toBe("家譜而已");
  });
});

describe("疑字链接 ↔ 网页 /open 路由", () => {
  const links = read("新史學.疑字清单.md").match(/obsidian:\/\/aihistory-pdf-sync\?[^)\s]+/g)!;

  it("清单里的 obsidian:// 链接能解析，库内路径按后缀认到书里的文件", () => {
    const link = parseSuspectLink(uriParams(links[1]))!;
    expect(link).toMatchObject({ file: "书/新史學/01-正文.md", page: 8, text: "而已" });
    expect(mapLinkFile(link.file, ["00-卷首.md", "01-正文.md", "新史學.md"])).toBe("01-正文.md");
  });

  it("/open 路由参数与插件链接同名同义", () => {
    const request = openRequestFromLocation({ pathname: "/open", search: "?file=01-%E6%AD%A3%E6%96%87.md&page=3&text=%E8%AF%87%E5%91%8A&ctx=x" });
    expect(request).toEqual({ file: "01-正文.md", page: 3, text: "诇告", ctx: "x" });
    expect(openRequestFromLocation({ pathname: "/", search: "?file=a.md" })).toBeNull();
  });

  it("找不到的文件给 null；同名时书的成员优先", () => {
    expect(mapLinkFile("别的书/x.md", ["01-正文.md"])).toBeNull();
    expect(mapLinkFile("库/a/01.md", ["b/01.md", "a/01.md"], ["a/01.md"])).toBe("a/01.md");
  });
});

describe("全文搜索", () => {
  it("盖掉锚点、脚注号、标题号时位置不变", () => {
    const text = "# 标题<!--pdf-page.2-->正文[^3]后";
    const masked = maskMarkup(text);
    expect(masked.length).toBe(text.length);
    expect(masked.trim().replace(/\s+/g, "")).toBe("标题正文后");
  });

  it("跨锚点、跨标点命中，并换算出页码；PDF 文字层的换行不影响", () => {
    const md = markdownDoc("01-正文.md", body);
    const pdf = pdfDoc(7, "以史家名者不下數\n百。茲學之發達");
    const { hits } = searchDocs([md, pdf], "不下數百茲學");
    const mdHit = hits.find((hit) => hit.source === "md")!;
    expect(mdHit.page).toBe(6);
    expect(body.slice(mdHit.start, mdHit.end)).toBe("不下數<!--pdf-page.7--><!--p.3-->百。茲學");
    expect(hits.find((hit) => hit.source === "pdf")?.page).toBe(7);
  });
});

describe("frontmatter 的 pdf 字段", () => {
  it("有就改，没有就加，没有 frontmatter 就建", () => {
    expect(setFrontmatterPdf('---\ntitle: a\npdf: "[[旧.pdf]]"\n---\n正文', "新.pdf")).toBe('---\ntitle: a\npdf: "[[新.pdf]]"\n---\n正文');
    expect(setFrontmatterPdf("---\ntitle: a\n---\n正文", "子/新.pdf")).toBe('---\ntitle: a\npdf: "[[新.pdf]]"\n---\n正文');
    expect(setFrontmatterPdf("正文", "新.pdf")).toBe('---\npdf: "[[新.pdf]]"\n---\n\n正文');
  });
});
