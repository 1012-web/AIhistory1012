import { describe, expect, it } from "vitest";
import { linkPointsTo, PdfMoveDetector } from "../src/core/pairing";

describe("linkPointsTo", () => {
  it("只写文件名：比文件名，.pdf 可省，大小写不论", () => {
    expect(linkPointsTo("新史學.pdf", "书/新史學.pdf")).toBe(true);
    expect(linkPointsTo("新史學", "书/新史學.pdf")).toBe(true);
    expect(linkPointsTo("新史學.PDF", "新史學.pdf")).toBe(true);
    expect(linkPointsTo("新史學.pdf", "书/新史學.文字层.pdf")).toBe(false);
  });

  it("带文件夹：比路径结尾，不跨半截文件夹名", () => {
    expect(linkPointsTo("书/新史學.pdf", "库/书/新史學.pdf")).toBe(true);
    expect(linkPointsTo("书/新史學.pdf", "库/旧书/新史學.pdf")).toBe(false);
    expect(linkPointsTo("./书/新史學.pdf", "书/新史學.pdf")).toBe(true);
  });
});

describe("PdfMoveDetector", () => {
  it("先删后建、大小一样、相隔不久：算挪了地方", () => {
    const detector = new PdfMoveDetector(10_000);
    expect(detector.deletedPdf({ path: "a/旧.pdf", size: 100, at: 0 })).toBeNull();
    expect(detector.createdPdf({ path: "b/新.pdf", size: 100, at: 50 })).toEqual({ from: "a/旧.pdf", to: "b/新.pdf" });
  });

  it("先建后删也认", () => {
    const detector = new PdfMoveDetector(10_000);
    expect(detector.createdPdf({ path: "新.pdf", size: 7, at: 0 })).toBeNull();
    expect(detector.deletedPdf({ path: "旧.pdf", size: 7, at: 3000 })).toEqual({ from: "旧.pdf", to: "新.pdf" });
  });

  it("大小不一样、隔太久都不认；配过一次就不再配", () => {
    const detector = new PdfMoveDetector(10_000);
    detector.deletedPdf({ path: "旧.pdf", size: 100, at: 0 });
    expect(detector.createdPdf({ path: "别的.pdf", size: 101, at: 10 })).toBeNull();
    expect(detector.createdPdf({ path: "晚了.pdf", size: 100, at: 20_000 })).toBeNull();

    const again = new PdfMoveDetector(10_000);
    again.deletedPdf({ path: "旧.pdf", size: 5, at: 0 });
    expect(again.createdPdf({ path: "新.pdf", size: 5, at: 1 })).not.toBeNull();
    expect(again.createdPdf({ path: "再一份.pdf", size: 5, at: 2 })).toBeNull();
  });
});
