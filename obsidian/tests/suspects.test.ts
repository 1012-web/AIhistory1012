import { describe, expect, it } from "vitest";
import { parseAnchors, pageSegments } from "../src/core/anchors";
import { appendNote, locateItem, markInList, nextOpen, NOTES_HEADING, notesPathFor, parseSuspectList, type SuspectItem } from "../src/core/suspects";

const enc = encodeURIComponent;

function link(file: string, page: number, text: string, ctx: string): string {
  return `obsidian://aihistory-pdf-sync?file=${enc(file)}&page=${page}&text=${enc(text)}&ctx=${enc(ctx)}`;
}

const LIST = [
  "---",
  "type: 疑字清单",
  "---",
  "",
  "## PDF 第 2 页",
  "",
  `- [ ] \`C001\` [PDF 第 2 页](${link("书/01-正文.md", 2, "毫", "甲从毫迁乙")}) · 字 · 甲从【毫】迁乙 ／ VL 作【亳】（字形似亳亦似毫）`,
  "  ![[书/_数据/疑字图/C001.png]]",
  `- [ ] \`C002\` [PDF 第 2 页](${link("书/01-正文.md", 2, "", "丙丁戊己")}) · 字 · 丙丁【∅】戊己 ／ VL 作【又】`,
  `- [x] \`C003\` [PDF 第 3 页](${link("书/01-正文.md", 3, "—", "庚—辛")}) · 标点 · 庚【—】辛 ／ VL 作【∅】 · 判定作【——】（2026-10-01）`,
  ""
].join("\n");

const TEXT = "<!--pdf-page.1-->序言毫无二致。\n<!--pdf-page.2-->甲从毫迁乙，丙丁戊己。\n<!--pdf-page.3-->庚—辛\n";

describe("疑字清单解析", () => {
  const items = parseSuspectList(LIST);

  it("读出每条的编号、状态、读法、截图", () => {
    expect(items.map((item) => item.id)).toEqual(["C001", "C002", "C003"]);
    expect(items[0]).toMatchObject({
      state: "open",
      kind: "字",
      display: { before: "甲从", current: "毫", after: "迁乙" },
      readings: [{ source: "现字", text: "毫" }, { source: "VL", text: "亳" }],
      note: "字形似亳亦似毫",
      image: "书/_数据/疑字图/C001.png"
    });
    expect(items[1].readings).toEqual([{ source: "现字", text: "" }, { source: "VL", text: "又" }]);
    expect(items[1].image).toBeNull();
    expect(items[2]).toMatchObject({ state: "done", chosen: "——", kind: "标点" });
  });

  it("下一条没判的会绕回开头", () => {
    expect(nextOpen(items, 0)).toBe(1);
    expect(nextOpen(items, 1)).toBe(0);
    expect(nextOpen(items.map((item) => ({ ...item, state: "done" as const })), 0)).toBe(-1);
  });
});

describe("在正文里找", () => {
  const items = parseSuspectList(LIST);
  const parse = (text: string) => { const anchors = parseAnchors(text); return { anchors, segments: pageSegments(text, anchors) }; };

  it("只在该页的锚点段里找现字（别页的同字不算）", () => {
    const hit = locateItem(TEXT, parse(TEXT), items[0])!;
    expect(TEXT.slice(hit.from, hit.to)).toBe("毫");
    expect(hit.from).toBe(TEXT.indexOf("甲从毫") + 2);
    expect(hit.exact).toBe(true);
  });

  it("现字为空时按前文找插入点", () => {
    const hit = locateItem(TEXT, parse(TEXT), items[1])!;
    expect(hit.from).toBe(hit.to);
    expect(TEXT.slice(hit.from - 2, hit.from + 2)).toBe("丙丁戊己");
  });

  it("正文段里没有时到这一页的脚注里找", () => {
    const withNote = "<!--pdf-page.2-->正文一句[^1]。\n\n## 注释\n\n[^1]: <!--pdf-page.2--> 甲从毫迁乙，见某书。\n";
    const hit = locateItem(withNote, parse(withNote), items[0])!;
    expect(hit.exact).toBe(true);
    expect(withNote.slice(hit.from - 2, hit.to)).toBe("甲从毫");
  });

  it("正文已被改过时找不到或标出不一致", () => {
    const edited = TEXT.replace("甲从毫迁乙", "甲从亳迁乙");
    const hit = locateItem(edited, parse(edited), items[0]);
    expect(hit === null || !hit.exact).toBe(true);
  });
});

describe("写回", () => {
  const items = parseSuspectList(LIST);

  it("判定：勾上并记定作的字；再判一次换掉旧记号", () => {
    const once = markInList(LIST, items[0], "亳", "2026-10-28")!;
    const line = once.split("\n").find((text) => text.includes("C001"))!;
    expect(line.startsWith("- [x]")).toBe(true);
    expect(line.endsWith(" · 判定作【亳】（2026-10-28）")).toBe(true);
    const twice = markInList(once, parseSuspectList(once)[0], "毫", "2026-10-29")!;
    expect(twice.split("\n").find((text) => text.includes("C001"))!.match(/判定作/g)?.length).toBe(1);
    expect(parseSuspectList(twice)[0]).toMatchObject({ state: "done", chosen: "毫" });
  });

  it("存疑：不勾，记存疑；之后判定时存疑记号去掉", () => {
    const doubted = markInList(LIST, items[1], null, "2026-10-28")!;
    expect(parseSuspectList(doubted)[1].state).toBe("doubt");
    const decided = markInList(doubted, parseSuspectList(doubted)[1], "又", "2026-10-28")!;
    expect(decided).not.toContain("存疑（");
    expect(parseSuspectList(decided)[1]).toMatchObject({ state: "done", chosen: "又" });
  });

  it("空字判定写作 ∅，读回来是空串", () => {
    const out = markInList(LIST, items[0], "", "2026-10-28")!;
    expect(out).toContain("判定作【∅】");
    expect(parseSuspectList(out)[0].chosen).toBe("");
  });

  it("保留 CRLF 行尾", () => {
    const crlf = LIST.replace(/\n/g, "\r\n");
    const out = markInList(crlf, parseSuspectList(crlf)[0], "亳", "2026-10-28")!;
    expect(out.split("\r\n").length).toBe(crlf.split("\r\n").length);
  });

  it("清单里找不到这一条返回 null", () => {
    const other: SuspectItem = { ...items[0], id: "C999" };
    expect(markInList(LIST, other, "亳", "2026-10-28")).toBeNull();
  });

  it("校注：没有这一节就在文末新开，有就接在表格末尾", () => {
    const first = appendNote("# 校注\n\n## 别的\n\n| a |\n|---|\n| 1 |\n", { id: "C001", page: 2, file: "01-正文.md", from: "毫", to: "亳" });
    expect(first).toContain(`${NOTES_HEADING}\n`);
    expect(first.trimEnd().endsWith("| C001 | PDF 第 2 页（01-正文.md） | 毫 | 亳 | 人工看图 |")).toBe(true);
    const second = appendNote(`${first}\n## 后面一节\n`, { id: "C002", page: 2, file: "01-正文.md", from: "", to: "又" });
    const lines = second.split("\n");
    const at = lines.findIndex((text) => text.includes("| C002 |"));
    expect(lines[at - 1]).toContain("| C001 |");
    expect(lines[at]).toContain("| ∅ | 又 |");
    const same = appendNote("", { id: null, page: null, file: "x.md", from: "甲", to: "甲" });
    expect(same).toContain("| — | 页码不明（x.md） | 甲 | （维持原字） |");
  });

  it("校注文件名跟着清单", () => {
    expect(notesPathFor("书/某书.疑字清单.md")).toBe("书/某书.AI校注.md");
  });
});
