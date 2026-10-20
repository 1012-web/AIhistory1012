import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_PORT, loadConfig, validPort } from "../../server/config";
import { applyChecked, checkTextLayer } from "../../src/client/pagemark";
import { DEFAULT_PREFS, dockChoiceOf, normalizePrefs, withDockChoice } from "../../src/client/prefs";
import type { PagemarkProposal } from "../../src/s3/core";

describe("用户配置文件", () => {
  it("没有就新建：生成令牌、默认端口；再读还是同一个令牌", () => {
    const path = join(mkdtempSync(join(tmpdir(), "aih-cfg-")), "workbench.json");
    const first = loadConfig(path);
    expect(first.token.length).toBeGreaterThanOrEqual(16);
    expect(first.port).toBe(DEFAULT_PORT);
    expect(loadConfig(path).token).toBe(first.token);
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(first.token);
  });

  it("文件坏了不悄悄重建，明说", () => {
    const path = join(mkdtempSync(join(tmpdir(), "aih-cfg-")), "workbench.json");
    writeFileSync(path, "{坏");
    expect(() => loadConfig(path)).toThrow(ConfigError);
    expect(readFileSync(path, "utf8")).toBe("{坏");
  });

  it("端口只认 1024–65535 的整数", () => {
    expect(validPort(4312)).toBe(true);
    expect(validPort(80)).toBe(false);
    expect(validPort(70000)).toBe(false);
    expect(validPort("4312")).toBe(false);
    expect(validPort(4312.5)).toBe(false);
  });
});

describe("界面设置", () => {
  it("认不得的值用默认，认得的照用", () => {
    expect(normalizePrefs({ pdfSide: "中间", baseline: 0.9, showPdf: false })).toMatchObject({ pdfSide: "left", baseline: 0.35, showPdf: false });
    expect(normalizePrefs(null)).toEqual(DEFAULT_PREFS);
  });
  it("工具条默认位置与停靠状态互换", () => {
    const floating = withDockChoice(DEFAULT_PREFS.toolbar, "floating");
    expect(dockChoiceOf(floating)).toBe("floating");
    expect(dockChoiceOf(withDockChoice(floating, "pdf"))).toBe("pdf");
  });
});

describe("补页码锚点的把关", () => {
  const proposal = (page: number, pos: number): PagemarkProposal => ({ page, pos, placement: "mid", similarity: 1, confidence: "high", before: "", after: "" });

  it("只插锚点：去掉锚点后与原文一致才放行", () => {
    const original = "甲乙丙丁\n\n戊己庚辛\n";
    const result = applyChecked(original, [proposal(2, 2), proposal(3, 6)]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe("甲乙<!--pdf-page.2-->丙丁\n\n<!--pdf-page.3-->戊己庚辛\n");
  });

  it("文字层抽样：都没字就判定为没有文字层", async () => {
    expect((await checkTextLayer(1, 10, async () => "  \n ")).ok).toBe(false);
    expect((await checkTextLayer(1, 10, async (page) => (page === 10 ? "正文正文正文正文正文正文正文正文正文正文正文" : ""))).ok).toBe(true);
  });
});
