from __future__ import annotations

import json
from pathlib import Path

import pytest

from conftest import write

SAMPLE = """---
title: 样书
pdf: "[[小样.pdf]]"
---

<!--pdf-page.1--><!--p.1-->

# 第一章

甲段第一页。[^1]跨页的段落前半<!--pdf-page.2--><!--p.2-->后半在第二页。[^2]

乙段在第二页。

<!--pdf-page.3--><!--p.3-->

丙段第三页。[^3]

---

## 注释

[^1]: <!--pdf-page.1--><!--p.1--> 注一。

[^2]: <!--pdf-page.2--><!--p.2--> 注二第一行。

    注二续行。

[^3]: <!--pdf-page.3--><!--p.3--> 注三。
"""


@pytest.fixture
def sample(tmp_path, synth_pdf):
    book = tmp_path / "样书"
    md = write(book / "样书.md", SAMPLE)
    (book / "小样.pdf").write_bytes(synth_pdf.read_bytes())
    return md


def test_parse_segments_and_footnotes(pt, sample):
    doc = pt.parse_doc(sample)
    assert [a.page for a in doc.body_anchors] == [1, 2, 3]
    assert [a.printed for a in doc.body_anchors] == ["1", "2", "3"]
    assert [(f.label, f.page) for f in doc.footnotes] == [("1", 1), ("2", 2), ("3", 3)]
    assert "注二续行" in doc.footnotes[1].text
    seg2 = doc.segment_text(doc.segments[1])
    assert seg2.startswith("<!--pdf-page.2-->") and "乙段在第二页" in seg2 and "甲段" not in seg2
    seg3 = doc.segment_text(doc.segments[2])
    assert "丙段第三页" in seg3
    assert "注释" not in seg3 and "注三" not in seg3 and "---" not in seg3


def test_locate_by_frontmatter(pt, sample):
    pdf, how = pt.locate_pdf(sample)
    assert pdf.name == "小样.pdf" and "frontmatter" in how


def test_locate_fallbacks(pt, tmp_path, synth_pdf):
    # 1) book.json
    book = tmp_path / "书甲"
    md = write(book / "正文.md", "<!--pdf-page.1-->正文\n")
    write(book / "_数据" / "book.json", json.dumps({"pdf": "原件.pdf"}, ensure_ascii=False))
    (book / "原件.pdf").write_bytes(synth_pdf.read_bytes())
    (book / "别的.pdf").write_bytes(synth_pdf.read_bytes())
    pdf, how = pt.locate_pdf(md)
    assert pdf.name == "原件.pdf" and "book.json" in how
    # 2) 同文件夹唯一 PDF（文字层副本不算第二个）
    book2 = tmp_path / "书乙"
    md2 = write(book2 / "正文.md", "<!--pdf-page.1-->正文\n")
    (book2 / "唯一.pdf").write_bytes(synth_pdf.read_bytes())
    (book2 / "唯一.文字层.pdf").write_bytes(synth_pdf.read_bytes())
    pdf2, how2 = pt.locate_pdf(md2)
    assert pdf2.name == "唯一.pdf" and "唯一" in how2
    assert pt.text_layer_pdf(pdf2).name == "唯一.文字层.pdf"
    # 3) 找不到
    md3 = write(tmp_path / "书丙" / "正文.md", "<!--pdf-page.1-->正文\n")
    assert pt.locate_pdf(md3)[0] is None


def test_locate_wikilink_across_vault(pt, tmp_path, synth_pdf):
    vault = tmp_path / "库"
    (vault / ".obsidian").mkdir(parents=True)
    (vault / "附件").mkdir()
    (vault / "附件" / "远处.pdf").write_bytes(synth_pdf.read_bytes())
    md = write(vault / "书" / "正文.md", '---\npdf: "[[远处.pdf]]"\n---\n<!--pdf-page.1-->x\n')
    pdf, _ = pt.locate_pdf(md)
    assert pdf.name == "远处.pdf"


def test_extract_bundle(pt, sample, capsys):
    rc = pt.main(["extract", str(sample), "--page", "2", "--json"])
    assert rc == 0
    b = json.loads(capsys.readouterr().out)[0]
    assert b["page"] == 2 and b["printed"] == "2"
    assert [f["label"] for f in b["footnotes"]] == ["2"]
    assert b["refs_in_body"] == ["2"]
    assert b["line_start"] == 10


def test_extract_reports_missing_def(pt, broken_book, capsys):
    assert pt.main(["extract", str(broken_book), "--page", "6", "--json"]) == 0
    b = json.loads(capsys.readouterr().out)[0]
    labels = [f["label"] for f in b["footnotes"]]
    assert labels == ["3", "4"]
    assert {"label": "5", "problem": "正文有注码，全文找不到定义"} in b["refs_elsewhere"]
    assert pt.main(["extract", str(broken_book), "--page", "19", "--json"]) == 0
    assert "新史學　梁啟超" in json.loads(capsys.readouterr().out)[0]["text"]


def test_pages_coverage(pt, tmp_path, capsys):
    md = write(tmp_path / "b" / "x.md", "<!--pdf-page.1-->a\n\n<!--pdf-page.3-->b\n\n<!--pdf-page.3-->c\n\n"
                                       "<!--pdf-page.2-->d\n")
    cov = pt.coverage(pt.parse_doc(md))
    assert cov["duplicates"] == [3] and cov["out_of_order"] == [(3, 2)] and cov["missing"] == []
    md2 = write(tmp_path / "b" / "y.md", "<!--pdf-page.5-->a\n\n<!--pdf-page.8-->b\n")
    assert pt.coverage(pt.parse_doc(md2))["missing"] == [6, 7]
    assert pt.main(["pages", str(tmp_path / "b")]) == 0
    out = capsys.readouterr().out
    assert "x.md" in out and "y.md" in out and "缺页" in out


def test_book_files_skip_sidecars_and_index(pt, tmp_path):
    book = tmp_path / "书"
    write(book / "01-正文.md", "<!--pdf-page.1-->a\n")
    write(book / "02-下篇.md", "<!--pdf-page.2-->b\n")
    write(book / "书.md", "# 索引\n[[01-正文]]\n")
    write(book / "书.AI校注.md", "<!--pdf-page.1-->\n")
    names = [p.name for p in pt.book_files(book)]
    assert names == ["01-正文.md", "02-下篇.md"]
    write(book / "_数据" / "book.json", json.dumps({"files": ["02-下篇.md", "01-正文.md"]}))
    assert [p.name for p in pt.book_files(book)] == ["02-下篇.md", "01-正文.md"]


@pytest.mark.parametrize("backend", ["pypdfium2", "pymupdf"])
def test_render_and_text(pt, sample, tmp_path, monkeypatch, backend):
    if backend == "pypdfium2":
        pytest.importorskip("pypdfium2")
    monkeypatch.setenv("LUNZHU2MD_PDF_BACKEND", "pymupdf" if backend == "pymupdf" else "")
    out = tmp_path / f"p2-{backend}.png"
    assert pt.main(["render", str(sample), "--page", "2", "--dpi", "72", "--out", str(out)]) == 0
    from PIL import Image
    with Image.open(out) as im:
        assert im.size == (300, 400)
    pdf, _ = pt.locate_pdf(sample)
    assert "第2页正文甲乙丙丁" in pt.page_text(pdf, 2).replace(" ", "")
    assert pt.pdf_page_count(pdf) == 3
    with pytest.raises(SystemExit):
        pt.page_text(pdf, 9)


def test_render_real_pdf(pt, broken_book, tmp_path):
    out = tmp_path / "p7.png"
    assert pt.main(["render", str(broken_book / "01-中國之舊史.md"), "--page", "7", "--dpi", "50",
                    "--out", str(out)]) == 0
    assert out.stat().st_size > 1000


def test_guard(pt, sample, tmp_path):
    before = pt.parse_doc(sample)
    text = sample.read_text(encoding="utf-8")

    def after(new: str):
        return pt.parse_doc(sample, new)

    # 只改第 2 页正文，加一条挂在第 2 页的新注：通过
    ok = text.replace("乙段在第二页。", "乙段在第二页。补回的段落。[^9]").replace(
        "[^3]: <!--pdf-page.3-->", "[^9]: <!--pdf-page.2--><!--p.2--> 新注。\n\n[^3]: <!--pdf-page.3-->")
    assert pt.guard(before, after(ok), 2) == []
    # 改了第 3 页：不通过
    bad = text.replace("丙段第三页。", "丙段第三页改了。")
    assert any("第 3 页" in p for p in pt.guard(before, after(bad), 2))
    # 动了锚点：不通过
    moved = text.replace("跨页的段落前半<!--pdf-page.2--><!--p.2-->后半", "跨页的段落<!--pdf-page.2--><!--p.2-->前半后半")
    probs = pt.guard(before, after(moved), 2)
    assert probs  # 第 1 页的正文跟着变了
    renum = text.replace("<!--pdf-page.3--><!--p.3-->\n\n丙段", "<!--pdf-page.4--><!--p.3-->\n\n丙段")
    assert any("锚点" in p for p in pt.guard(before, after(renum), 3))
    # 删了别页的注：不通过
    gone = text.replace("[^1]: <!--pdf-page.1--><!--p.1--> 注一。\n", "")
    assert any("删掉了脚注 [^1]" in p for p in pt.guard(before, after(gone), 2))


def test_snapshot_and_guard_cli(pt, sample, capsys):
    (sample.parent / "_数据").mkdir()
    assert pt.main(["snapshot", str(sample)]) == 0
    backup = Path(capsys.readouterr().out.strip())
    assert backup.exists() and "fix-备份" in str(backup)
    sample.write_text(sample.read_text(encoding="utf-8").replace("乙段", "乙段改"), encoding="utf-8")
    assert pt.main(["guard", str(backup), str(sample), "--page", "2"]) == 0
    assert pt.main(["guard", str(backup), str(sample), "--page", "3"]) == 1


def test_crlf_and_legacy_footnote(pt, tmp_path):
    md = write(tmp_path / "c.md", "")
    md.write_bytes("<!--pdf-page.1-->甲[^1]\r\n\r\n[^1]: <!--p.7--> 旧写法注。\r\n".encode("utf-8"))
    doc = pt.parse_doc(md)
    assert doc.footnotes[0].page is None and doc.footnotes[0].printed == "7"
    assert pt.coverage(doc)["footnotes_without_page"] == ["1"]


def test_printed_and_search(pt, broken_book, capsys):
    assert pt.main(["extract", str(broken_book), "--printed", "14", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)[0]["page"] == 18
    with pytest.raises(SystemExit):
        pt.main(["extract", str(broken_book), "--printed", "999"])
    # 被删的段：文字层第 18 页有，正文里没有
    assert pt.main(["search", str(broken_book), "統之義已謬，而正與不正，更何足云"]) == 0
    r = json.loads(capsys.readouterr().out)
    assert r["pdf_pages"] == [18] and r["md"] == []
    # 被删注文所在页：文字层第 6 页有
    assert pt.main(["search", str(broken_book), "指清乾隆時所修《四庫全書》"]) == 0
    assert json.loads(capsys.readouterr().out)["pdf_pages"] == [6]
    assert pt.main(["search", str(broken_book), "完全不存在的一句話甲乙丙"]) == 1


def test_legacy_printed_only(pt, tmp_path):
    book = tmp_path / "旧书"
    md = write(book / "旧.md", "<!--p.107-->\n\n甲[^1]乙<!--p.108-->丙\n\n[^1]: <!--p.107--> 注\n")
    assert pt.book_files(book) == []  # 没有 book.json 偏移就不认
    write(book / "_数据" / "book.json", json.dumps({"version": 1, "printedPageOffset": -106}))
    assert [p.name for p in pt.book_files(book)] == ["旧.md"]
    doc = pt.parse_doc(md)
    assert doc.legacy and [a.page for a in doc.body_anchors] == [1, 2]
    assert doc.footnotes[0].page == 1


def test_page_split_across_files(pt, tmp_path, capsys):
    book = tmp_path / "书"
    write(book / "01-上.md", "---\npdf: \"[[x.pdf]]\"\n---\n<!--pdf-page.1-->甲\n\n<!--pdf-page.2-->乙页前半\n")
    write(book / "02-下.md", "---\npdf: \"[[x.pdf]]\"\n---\n\n# 第二章\n\n乙页后半\n\n<!--pdf-page.3-->丙\n")
    assert pt.main(["extract", str(book), "--page", "2", "--json"]) == 0
    b = json.loads(capsys.readouterr().out)[0]
    nx = b["continued_in_next_file"]
    assert nx["file"].endswith("02-下.md") and "第二章" in nx["text"] and "乙页后半" in nx["text"]
    assert nx["line_start"] == 5


def test_guard_anchor_move(pt, broken_book, clean_book):
    """埋错的第 21 页锚点挪回原位：要用户同意（--anchor-move）并放行两侧的两页。"""
    md = broken_book / "03-論正統.md"
    before = pt.parse_doc(md)
    text = md.read_text(encoding="utf-8")
    anchor = "<!--pdf-page.21--><!--p.17-->"
    fixed = text.replace(anchor, "", 1).replace("以保其一姓私産之謀耳", "以保其一姓" + anchor + "私産之謀耳", 1)
    assert fixed.count(anchor) == text.count(anchor) and fixed != text
    after = pt.parse_doc(md, fixed)
    clean = pt.parse_doc(clean_book / "03-論正統.md")
    seg = lambda d, p: [d.segment_text(s) for s in d.segments if s.page == p][0]  # noqa: E731
    assert seg(after, 21) == seg(clean, 21)
    assert pt.guard(before, after, 21)                      # 只放行一页：第 20 页也变了
    assert any("锚点的位置动了" in x for x in pt.guard(before, after, [20, 21]))
    assert pt.guard(before, after, [20, 21], anchor_move=True) == []
