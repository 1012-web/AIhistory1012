import { describe, expect, it } from "vitest";
import { baselineY, fractionWithin, heightInBlock, LeaderTracker, pdfPointAt, posInBlock, QuietWindow, scrollDeltaToBaseline } from "../src/core/sync-math";

describe("sync math", () => {
  it("puts the baseline at 35%", () => {
    expect(baselineY(100, 1000, 0.35)).toBe(450);
    expect(scrollDeltaToBaseline(650, 100, 1000, 0.35)).toBe(200);
  });

  it("computes fractions and clamps", () => {
    expect(fractionWithin(150, 100, 200)).toBe(0.5);
    expect(fractionWithin(50, 100, 200)).toBe(0);
    expect(fractionWithin(500, 100, 200)).toBe(1);
    expect(fractionWithin(100, 100, 100)).toBe(0);
  });

  it("finds the PDF page under the baseline, gaps belong to the next page", () => {
    const boxes = [{ page: 1, top: 0, bottom: 100 }, { page: 2, top: 110, bottom: 210 }];
    expect(pdfPointAt(boxes, 50)).toEqual({ page: 1, fraction: 0.5 });
    expect(pdfPointAt(boxes, 105)).toEqual({ page: 2, fraction: 0 });
    expect(pdfPointAt(boxes, -5)).toEqual({ page: 1, fraction: 0 });
    expect(pdfPointAt(boxes, 500)).toEqual({ page: 2, fraction: 1 });
    expect(pdfPointAt([], 1)).toBeNull();
  });

  it("round-trips heights inside a block", () => {
    const h = heightInBlock(150, 100, 200, 1000, 80);
    expect(h).toBe(1040);
    expect(posInBlock(h, 100, 200, 1000, 80)).toBe(150);
  });

  it("keeps a quiet window and a leader", () => {
    let now = 0;
    const quiet = new QuietWindow(() => now);
    quiet.hold(200);
    expect(quiet.quiet).toBe(true);
    now = 201;
    expect(quiet.quiet).toBe(false);
    const leader = new LeaderTracker(() => now);
    expect(leader.leader).toBe("markdown");
    leader.input("pdf");
    expect(leader.leader).toBe("pdf");
    expect(leader.lastInputAt).toBe(201);
  });
});
