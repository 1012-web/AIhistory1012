from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import ROOT, write


def _scan(au, path, **kw):
    return au.scan(Path(path), **kw)


def _checks(r, sev=("high", "medium")):
    return [(i["check"], i["page"]) for i in r["issues"] if i["severity"] in sev]


def test_shared_core_in_sync():
    rc = subprocess.run([sys.executable, "-X", "utf8", str(ROOT / "tests" / "sync_shared_core.py"), "--check"])
    assert rc.returncode == 0, "page_tool.py 与 audit_scan.py 的 shared-core 不一致：跑 tests/sync_shared_core.py"


def test_clean_fixture_has_no_real_issues(au, clean_book):
    r = _scan(au, clean_book)
    assert r["pdf_pages"] == 23 and r["text_layer_pages"] == 21   # 书名页、目录页字太少，不算可用
    # 只剩两处原书照录的括号（维基本「《周秦學案)」、第 15 页夹注少一个开括号），不是导入的错
    assert _checks(r) == [("bracket", 9), ("bracket", 15)]
    assert "新史學梁啟超" in r["running_heads"]   # 排印本偶数页页眉；书名页同字，不算混入
    # 正文与真实排印本的文字层：每页字数差不到 5%（成品校对过的字、注码写法与排印本略有出入；报警线是 6%）
    for p, row in r["pages"].items():
        if row.get("ratio") is not None:
            assert abs(row["ratio"] - 1) < 0.05, (p, row)


def test_broken_fixture_all_bugs_found(au, broken_book):
    bugs = json.loads((broken_book / "埋错清单.json").read_text(encoding="utf-8"))
    r = _scan(au, broken_book)
    found = _checks(r)
    kinds = {b["kind"]: b for b in bugs}
    # 删一段 → 本页字数明显少
    assert ("page_chars", kinds["删一段"]["page"]) in found
    # 删一条注 → 注码无注文
    assert any(i["check"] == "footnote_ref_no_def" and "[^5]" in i["message"] and i["page"] == kinds["删一条注"]["page"]
               for i in r["issues"])
    # 整段重复 → 报重复，本页字数多
    assert ("repeat", kinds["整段重复"]["page"]) in found and ("page_chars", kinds["整段重复"]["page"]) in found
    # 页码锚点错位 → 接缝核对报出放早了，前后两页字数一少一多
    assert ("anchor_seam", kinds["页码锚点错位"]["page"]) in found
    assert ("page_chars", 20) in found and ("page_chars", 21) in found
    # 混进一行页眉
    rh = [i for i in r["issues"] if i["check"] == "running_head"]
    assert rh and rh[0]["page"] == kinds["混进一行页眉"]["page"] and rh[0]["severity"] == "high"
    # 必查页覆盖所有埋错页
    risk = {x["page"] for x in r["suggested_pages"]["risk"]}
    assert {b["page"] for b in bugs} <= risk


def test_broken_fixture_without_pdf(au, broken_book):
    r = _scan(au, broken_book, use_pdf=False)
    checks = {c for c, _ in _checks(r)}
    assert {"footnote_ref_no_def", "repeat"} <= checks
    assert "running_head" not in checks   # 页眉要从文字层认，没有 PDF 就认不出书名页眉
    assert r["pdf"] is None


def test_scan_cli_writes_reports(au, broken_book, tmp_path, capsys):
    out = tmp_path / "out"
    assert au.main(["scan", str(broken_book), "--out-dir", str(out)]) == 0
    data = json.loads((out / "抽检初筛.json").read_text(encoding="utf-8"))
    md = (out / "抽检初筛.md").read_text(encoding="utf-8")
    assert data["summary"]["高"] >= 5
    assert "三分之一法则" in md and "必查" in md
    # 默认写进 <书>/_数据/过程报告/
    assert au.main(["scan", str(broken_book / "03-論正統.md")]) == 0
    assert (broken_book / "_数据" / "过程报告" / "抽检初筛.md").exists()


# ---------------------------------------------------------------- 各项检查的小样

def _book(au, tmp_path, text, name="t.md"):
    write(tmp_path / "b" / name, text)
    return au.load_book(tmp_path / "b", use_pdf=False)


def _found(issues, check):
    return [i for i in issues if i.check == check]


def test_anchor_checks(au, tmp_path):
    b = _book(au, tmp_path, "<!--pdf-page.1-->a\n\n<!--pdf-page.3-->b\n\n<!--pdf-page.3-->c\n\n<!--pdf-page.2-->d\n\n"
                            "<!-- pdf-page.5 -->e\n")
    iss = au.check_anchors(b)
    assert _found(iss, "anchor_duplicate")[0].page == 3
    assert _found(iss, "anchor_order")[0].page == 2
    assert [i.page for i in _found(iss, "anchor_missing")] == [4]
    assert _found(iss, "anchor_format")


def test_anchor_uncovered_pages(au, tmp_path):
    b = _book(au, tmp_path, "<!--pdf-page.2-->a\n\n<!--pdf-page.3-->b\n")
    b.page_count = 5
    iss = au.check_anchors(b)
    assert _found(iss, "anchor_uncovered")[0].evidence["pages"] == [1, 4, 5]


def test_printed_outlier(au, tmp_path):
    b = _book(au, tmp_path, "".join(f"<!--pdf-page.{n}--><!--p.{n + 10 if n != 3 else 31}-->x{n}\n\n" for n in range(1, 6)))
    iss = au.check_printed(b)
    assert any(i.page == 3 and "p.31" in i.message for i in iss)


def test_footnote_checks(au, tmp_path):
    text = ("<!--pdf-page.1-->甲[^1]乙[^2]丙[^4]丁[^3]\n\n"
            "[^1]: <!--pdf-page.1--> 一\n\n[^2]: <!--pdf-page.1--> 二\n\n[^2]: <!--pdf-page.1--> 二又\n\n"
            "[^3]: 没锚点\n\n[^6]: <!--pdf-page.2--> 六\n")
    iss = au.check_footnotes(_book(au, tmp_path, text))
    assert [i.message for i in _found(iss, "footnote_ref_no_def")] == ["正文有注码 [^4]，找不到注文"]
    assert "[^6]" in _found(iss, "footnote_def_no_ref")[0].message
    assert _found(iss, "footnote_duplicate")
    assert "[^5]" in _found(iss, "footnote_gap")[0].message
    assert _found(iss, "footnote_order")
    assert _found(iss, "footnote_no_anchor")


def test_cn_int(au):
    assert [au.cn_int(x) for x in ("一", "九", "十", "十一", "二十", "二十三", "99", "两", "百")] == \
           [1, 9, 10, 11, 20, 23, 99, 2, None]


def test_heading_checks(au, tmp_path):
    text = ("<!--pdf-page.1-->\n\n# 书名\n\n## 第一章 甲\n\n### 一、子\n\n### 二、子\n\n## 第二章 乙\n\n"
            "### 一、子\n\n### 三、子\n\n## 第四章 丙\n\n##### 太深\n\n## 2.1 x\n\n## 2.3 y\n")
    iss = au.check_headings(_book(au, tmp_path, text))
    msgs = [i.message for i in _found(iss, "heading_number")]
    assert any("一、子」之后是「三、子" in m for m in msgs)
    assert any("第二章" in m and "第四章" in m for m in msgs)
    assert any("2.1" in m and "2.3" in m for m in msgs)
    assert not any("一、子」之后是「二、子" in m for m in msgs)  # 换章后重新数
    assert _found(iss, "heading_level")


def test_residual_latin_watermark(au, tmp_path):
    text = ("<!--pdf-page.1-->正文<span>残</span>注$^{1}$。\n\n<|ref|>块\n\npage_header\n\n"
            "下载自中国知网 http://www.cnki.net 。\n\n"
            "(C)1994-2023 China Academic Journal Electronic Publishing House. All rights reserved. http://www.cnki.net\n\n"
            "正文 " + "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore" + " 完。\n\n"
            "108\n\n第62 卷第1 期\n")
    b = _book(au, tmp_path, text)
    res = au.check_residual(b)
    whats = " ".join(i.message for i in res)
    assert "HTML 标签" in whats and "上标" in whats and "特殊记号" in whats and "版面块类型名" in whats
    assert _found(au.check_latin(b), "latin_run")[0].severity == "low"
    wh = au.check_watermark_and_heads(b)
    assert len(_found(wh, "watermark")) >= 2
    heads = [i.message for i in _found(wh, "running_head")]
    assert any("孤立的页码行" in m for m in heads) and any("刊期页眉" in m for m in heads)


def test_running_head_from_text_layer(au, tmp_path):
    b = _book(au, tmp_path, "<!--pdf-page.1-->正文甲\n\n某某大学学报 哲学社会科学版 2025 年\n\n"
                            "<!--pdf-page.2-->某某大学学报（哲学社会科学版）2025年 正文乙继续写下去写很多字\n")
    b.heads = {"某某大学学报哲学社会科学版年"}
    b.usable = {1, 2}          # 页首混页眉只在文字层可用的页上比
    iss = _found(au.check_watermark_and_heads(b), "running_head")
    assert any("整行页眉页脚" in i.message and i.page == 1 for i in iss)
    assert any("第 2 页开头混着页眉" in i.message for i in iss)


def test_detect_running_heads(au):
    words = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥"
    texts = {p: f"{100 + p}\n某某大学学报( 哲学社会科学版)\n2025 年\n"
                + "\n".join(f"正文{words[(p * 3 + i) % len(words)]}{words[i]}很多字" for i in range(6))
             for p in range(1, 7)}
    heads = au.detect_running_heads(texts)
    assert "某某大学学报哲学社会科学版" in heads
    assert not any("很多字" in h for h in heads)
    body = au.page_body_norm(texts[3], heads)
    assert "学报" not in body and "很多字" in body


def test_superscript_with_text_layer(au, tmp_path):
    b = _book(au, tmp_path, "<!--pdf-page.1-->共计10人，另有2025年的记录。\n")
    b.texts = {1: "共计10 1人，另有2025 年的记录。"}
    b.usable = {1}
    iss = au.check_superscript(b)
    assert iss == []
    b2 = _book(au, tmp_path, "<!--pdf-page.1-->共计101人，另有2025年的记录。\n", name="u.md")
    b2.docs = [d for d in b2.docs if d.path.name == "u.md"]
    b2.texts = {1: "共计10 人①，另有2025 年的记录。1"}
    b2.usable = {1}
    iss = au.check_superscript(b2)
    assert iss and "101" in iss[0].message and "上标 1" in iss[0].message


def test_brackets(au, tmp_path):
    assert au.bracket_problems("甲（乙）《丙》“丁”") == []
    assert au.bracket_problems("甲（乙《丙") == ["（） 开 1 闭 0", "《》 开 1 闭 0"]
    assert au.bracket_problems("1）第一条\n2）第二条") == []
    assert au.bracket_problems("Qin’s rule") == []
    iss = au.check_brackets(_book(au, tmp_path, "<!--pdf-page.1-->“多段连引前段\n\n甲（乙\n"))
    sev = {i.message.split("：")[0]: i.severity for i in iss}
    assert sorted(i.severity for i in iss) == ["low", "medium"]


def test_repeats(au, tmp_path):
    p = "秦通过强化中央集权体制赢得了统一战争的速胜这是一段足够长的文字"
    text = (f"<!--pdf-page.1-->{p}\n\n{p}\n\n甲乙丙丁戊己庚辛壬癸甲乙丙丁戊己庚辛壬癸之后\n\n"
            f"<!--pdf-page.2-->前面不同的话一二三四五六七八九十秦朝的统治方式在统一之后并没有及时转变而是延续旧法\n\n"
            f"后面也不同的话秦朝的统治方式在统一之后并没有及时转变而是延续旧法的结尾\n")
    iss = au.check_repeats(_book(au, tmp_path, text))
    msgs = [i.message for i in iss]
    assert any("整段重复" in m for m in msgs)
    assert any("段内同一串连写两遍" in m for m in msgs)
    assert any("20 字以上相同" in m for m in msgs)


def test_suggest_pages_deterministic(au, tmp_path):
    text = "".join(f"<!--pdf-page.{n}-->第{n}页正文。\n\n" for n in range(1, 41))
    text = text.replace("第5页正文。", "## 第二章\n\n第5页正文。").replace("第9页正文。", "<table><tr><td>1</td></tr></table>")
    b = _book(au, tmp_path, text)
    iss = [au.Issue("page_chars", "high", "x", page=12)]
    s1 = au.suggest_pages(b, iss, 10, 7)
    s2 = au.suggest_pages(b, iss, 10, 7)
    assert s1 == s2
    assert [x["page"] for x in s1["risk"]] == [12]
    st = {x["page"]: x["reasons"] for x in s1["structural"]}
    assert "章首" in st[5] and "表格" in st[9]
    assert len(s1["random"]) == 10 - len(s1["structural"])
    assert s1["random_bound"] == round(3 / len(s1["random"]), 3)


def test_facts_and_compare(au, broken_book, tmp_path, capsys):
    book = au.load_book(broken_book, use_pdf=False)
    f6 = au.facts_for(book, [6])[0]
    assert f6["notes"] == 2 and f6["note_refs"] == 3 and f6["paragraphs"] >= 10
    ai = [dict(f6, notes=3, first_chars=f6["first_chars"]),
          {k: v for k, v in au.facts_for(book, [5])[0].items() if k != "file"}]
    res = au.compare_facts(ai, au.facts_for(book, [5, 6]))
    assert res[0]["page"] == 5 and res[0]["verdict"] == "一致"
    assert res[1]["page"] == 6 and res[1]["mismatches"][0]["field"] == "notes"
    fp = tmp_path / "facts.json"
    fp.write_text(json.dumps(ai, ensure_ascii=False), encoding="utf-8")
    assert au.main(["compare", str(broken_book), "--facts", str(fp)]) == 1
    assert au.main(["facts", str(broken_book), "--pages", "5,6"]) == 0


def test_render_cli(au, broken_book, tmp_path, capsys):
    out = tmp_path / "imgs"
    assert au.main(["render", str(broken_book), "--pages", "1,3-4", "--dpi", "30", "--out-dir", str(out)]) == 0
    assert len(list(out.glob("*.png"))) == 3


def test_parse_pages(au):
    assert au.parse_pages("3，1-2,2") == [1, 2, 3]


def test_import_table_pages_are_must_read(au, tmp_path):
    """冲突清单里表格个数对不上的页、导入报告里疑似跨页表的页：进必查页。"""
    root = tmp_path / "b"
    text = "".join(f"<!--pdf-page.{n}-->第{n}页正文。\n\n" for n in range(1, 31))
    write(root / "t.md", text)
    write(root / "_数据" / "冲突清单" / "conflicts.json", json.dumps({"items": [
        {"page": 6, "stream": "structure", "kind": "table", "op": "count", "md": "0", "vl": "1"},
        {"page": 7, "stream": "body", "kind": "char", "md": "甲", "vl": "乙"}]}, ensure_ascii=False))
    write(root / "_数据" / "过程报告" / "_build_report.txt",
          "# 构建报告\n\n## 疑似跨页表，共 1 处（交 AI 定）\n  这一页的表格块是空的……\n  PDF 第 12 页\n\n"
          "## 别的一节\n  PDF 第 20 页\n")
    write(root / "_数据" / "文字层" / "assignment.json",
          json.dumps({"crossPageTables": [{"page": 12}, {"page": 15}]}))
    r = _scan(au, root, use_pdf=False, sample=5)
    risk = {x["page"]: x["reasons"] for x in r["suggested_pages"]["risk"]}
    assert "表格个数两家不同" in risk[6] and "疑似跨页表" in risk[12] and "疑似跨页表" in risk[15]
    assert 7 not in risk and 20 not in risk
    tc = [i for i in r["issues"] if i["check"] == "table_count"]
    assert tc[0]["page"] == 6 and "MinerU 0，VL 1" in tc[0]["message"]
    src = {i["page"]: i["evidence"]["source"] for i in r["issues"] if i["check"] == "table_cross_page"}
    assert src == {12: ["构建报告", "文字层报告"], 15: ["文字层报告"]}


def test_import_table_pages_from_markdown_list(au, tmp_path):
    """没有 conflicts.json 时读 冲突清单.md 的条目「表格个数：MinerU 0，VL 1」。"""
    root = tmp_path / "b"
    write(root / "t.md", "".join(f"<!--pdf-page.{n}-->第{n}页。\n\n" for n in range(1, 6)))
    write(root / "_数据" / "冲突清单" / "冲突清单.md",
          "# 两家识别冲突清单\n\n## PDF 第 2 页\n\n- `C00001` 标题个数：MinerU 0，VL 1 ｜ MinerU：— ｜ VL：x\n\n"
          "## PDF 第 4 页\n\n- `C00002` 表格个数：MinerU 0，VL 1 ｜ MinerU：— ｜ VL：—\n")
    counts, cross = au.import_table_pages(root)
    assert counts == {4: "MinerU 0，VL 1"} and cross == {}
