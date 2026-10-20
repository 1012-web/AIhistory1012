"""docs/anchors.md 2026-10-20 更新后的几条细则。"""
from __future__ import annotations

import json

from conftest import write

CROSS_NOTE = """<!--pdf-page.1--><!--p.1-->

甲页正文。[^1]

<!--pdf-page.2--><!--p.2-->

乙页正文。[^2]

---

## 注释

[^1]: <!--pdf-page.1--><!--p.1--> 注一前半在第一页，<!--pdf-page.2--><!--p.2-->后半续到第二页。

[^2]: <!--pdf-page.2--><!--p.2--> 注二。
"""


def test_footnote_with_second_anchor(pt, au, tmp_path):
    md = write(tmp_path / "书" / "a.md", CROSS_NOTE)
    doc = pt.parse_doc(md)
    f1 = doc.footnotes[0]
    assert f1.pages == [1, 2] and f1.page == 1
    assert pt.footnote_part_text(doc, f1, 2).endswith("后半续到第二页。")
    assert "后半" not in pt.footnote_part_text(doc, f1, 1)
    # 正文锚点只有两个，注文里的不算
    assert [a.page for a in doc.body_anchors] == [1, 2]
    b2 = pt.page_bundle(doc, doc.segments[1])
    assert [f["label"] for f in b2["footnotes"]] == ["1", "2"]
    assert b2["footnotes"][0]["part_on_this_page"].endswith("后半续到第二页。")
    # 字数按段分到两页
    book = au.load_book(tmp_path / "书", use_pdf=False)
    chars = au.md_page_chars(book)
    assert chars[2] > chars[1] - 10
    # 「注」条数：续过来的不算新条
    assert au.facts_for(book, [2])[0]["notes"] == 1
    # 注文挂页检查不误报
    assert not [i for i in au.check_footnotes(book) if i.severity in ("high", "medium")]


def test_continuation_anchor_across_files(pt, au, tmp_path, capsys):
    book = tmp_path / "书"
    write(book / "01-上.md", "<!--pdf-page.1-->甲\n\n<!--pdf-page.2-->乙页前半属上一章。\n")
    write(book / "02-下.md", "<!--pdf-page.2-->\n\n# 第二章\n\n乙页后半。\n\n<!--pdf-page.3-->丙\n")
    b = au.load_book(book, use_pdf=False)
    assert b.docs[1].segments[0].continuation
    iss = au.check_anchors(b)
    assert not [i for i in iss if i.check in ("anchor_duplicate", "anchor_order")]
    assert pt.main(["extract", str(book), "--page", "2"]) == 0
    out = capsys.readouterr().out
    assert "续页锚点" in out and "重复锚点" not in out and "乙页前半" in out and "乙页后半" in out


def test_chapter_start_printed_anchor_separate(pt, tmp_path):
    md = write(tmp_path / "c.md", "<!--pdf-page.4-->\n\n# 第一章\n\n<!--p.1-->正文。\n\n<!--pdf-page.5--><!--p.2-->续\n")
    doc = pt.parse_doc(md)
    assert [(a.page, a.printed) for a in doc.body_anchors] == [(4, "1"), (5, "2")]


def test_notes_area_ends_at_next_chapter_anchor(pt, tmp_path):
    text = ("<!--pdf-page.1-->第一章正文。[^1]\n\n---\n\n## 注释\n\n[^1]: <!--pdf-page.1--> 注一。\n\n"
            "<!--pdf-page.2-->\n\n# 第二章\n\n第二章正文。\n")
    doc = pt.parse_doc(write(tmp_path / "d.md", text))
    seg1 = doc.segment_text(doc.segments[0])
    assert "注释" not in seg1 and "---" not in seg1 and "注一" not in seg1
    assert "第二章正文" in doc.segment_text(doc.segments[1])


def test_old_notes_gaps_and_local_reverse_are_soft(au, tmp_path):
    book = tmp_path / "旧书"
    write(book / "x.md", "<!--pdf-page.1-->a\n\n<!--pdf-page.3-->b\n\n<!--pdf-page.5-->c\n\n<!--pdf-page.4-->d\n")
    write(book / "_数据" / "book.json", json.dumps({"version": 1, "printedPageOffset": 0}))
    iss = au.check_anchors(au.load_book(book, use_pdf=False))
    sev = {(i.check, i.page): i.severity for i in iss}
    assert sev[("anchor_missing", 2)] == "low"
    assert sev[("anchor_order", 4)] == "info"
    # 新书缺页仍是高
    write(book / "_数据" / "book.json", json.dumps({"version": 2}))
    iss = au.check_anchors(au.load_book(book, use_pdf=False))
    assert {(i.check, i.page): i.severity for i in iss}[("anchor_missing", 2)] == "high"


def test_audit_suggests_continuation_anchor_for_cross_page_note(au, tmp_path):
    text = ("<!--pdf-page.1-->甲页正文写了很多字。[^1]\n\n<!--pdf-page.2-->乙页正文。\n\n"
            "[^1]: <!--pdf-page.1--> 这一条注的前半段印在第一页页脚而后半段续到第二页页脚才结束\n")
    write(tmp_path / "b" / "t.md", text)
    book = au.load_book(tmp_path / "b", use_pdf=False)
    book.texts = {1: "甲页正文写了很多字。\n这一条注的前半段印在第一页页脚", 2: "乙页正文。\n而后半段续到第二页页脚才结束"}
    book.usable = {1, 2}
    iss = au.check_cross_page_notes(book)
    assert iss and "续到了第 2 页" in iss[0].message


def test_printed_anchor_far_after_long_chapter_title_and_duplicates(pt, au, tmp_path):
    title = "很长的章名" * 120
    md = write(tmp_path / "e" / "e.md", f"<!--pdf-page.4-->\n\n# {title}\n\n<!--p.1-->正文。\n\n"
                                         "<!--pdf-page.5--><!--p.2-->续<!--p.3-->多出的\n")
    doc = pt.parse_doc(md)
    assert [(a.page, a.printed) for a in doc.body_anchors] == [(4, "1"), (5, "2")]
    iss = au.check_printed(au.load_book(tmp_path / "e", use_pdf=False))
    assert any(i.page == 5 and "2 个印刷页锚点" in i.message for i in iss)
