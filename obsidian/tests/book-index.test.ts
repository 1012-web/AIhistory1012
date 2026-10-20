import { describe, expect, it } from "vitest";
import { buildBookIndex, compareBookPaths, fileForPage, indexEntry, printedLabel, suggestedPageRange } from "../src/core/book-index";

const entries = [
  indexEntry("书/10-附录.md", "<!--pdf-page.11-->附录<!--pdf-page.12-->"),
  indexEntry("书/01-正文.md", "<!--pdf-page.3-->a<!--pdf-page.4-->b<!--pdf-page.6-->c"),
  indexEntry("书/00-卷首.md", "<!--pdf-page.1-->封面<!--pdf-page.2-->"),
  indexEntry("书/书.md", "索引，无锚点"),
  indexEntry("书/02-下编.md", "无锚点")
];

describe("book index", () => {
  it("orders by numeric file name", () => {
    expect(compareBookPaths("2-a.md", "10-a.md")).toBeLessThan(0);
    const index = buildBookIndex("书/书.pdf", "书", entries);
    expect(index.files.map((file) => file.path)).toEqual(["书/00-卷首.md", "书/01-正文.md", "书/02-下编.md", "书/10-附录.md", "书/书.md"]);
  });

  it("honours book.json order", () => {
    const index = buildBookIndex("书/书.pdf", "书", entries, ["书/书.md", "书/00-卷首.md"]);
    expect(index.files[0].path).toBe("书/书.md");
    expect(index.files[1].path).toBe("书/00-卷首.md");
  });

  it("finds the file for a page: exact, covering gap, after last", () => {
    const index = buildBookIndex("书/书.pdf", "书", entries);
    expect(fileForPage(index, 2)?.path).toBe("书/00-卷首.md");
    expect(fileForPage(index, 4)?.path).toBe("书/01-正文.md");
    expect(fileForPage(index, 5)?.path).toBe("书/01-正文.md");
    expect(fileForPage(index, 8)?.path).toBe("书/01-正文.md");
    expect(fileForPage(index, 12)?.path).toBe("书/10-附录.md");
    expect(fileForPage(index, 40)?.path).toBe("书/10-附录.md");
  });

  it("suggests a search range for an unanchored file", () => {
    const index = buildBookIndex("书/书.pdf", "书", entries);
    expect(suggestedPageRange(index, "书/02-下编.md", 12)).toEqual([6, 11]);
    expect(suggestedPageRange(index, "书/书.md", 12)).toEqual([12, 12]);
  });

  it("derives printed page labels", () => {
    const index = buildBookIndex("书/书.pdf", "书", entries, null, 106);
    expect(printedLabel(index, 107, null)).toBe("1");
    expect(printedLabel(index, 3, null)).toBeNull();
    expect(printedLabel(index, 3, "xii")).toBe("xii");
  });
});

describe("续页锚点", () => {
  const index = buildBookIndex("书/书.pdf", "书", [
    indexEntry("书/01-上.md", "<!--pdf-page.3-->a<!--pdf-page.4-->b"),
    indexEntry("书/02-下.md", "<!--pdf-page.4-->续b<!--pdf-page.5-->c")
  ]);

  it("同一页在两个文件里：默认取前一个文件，给了当前文件且它也有这页就留在当前文件", () => {
    expect(fileForPage(index, 4)?.path).toBe("书/01-上.md");
    expect(fileForPage(index, 4, "书/02-下.md")?.path).toBe("书/02-下.md");
    expect(fileForPage(index, 3, "书/02-下.md")?.path).toBe("书/01-上.md");
  });
});
