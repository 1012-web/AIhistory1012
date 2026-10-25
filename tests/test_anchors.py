"""物理页锚点：build.py 写、split_book.py 分文件与 book.json、verify.py 查（约定见 docs/anchors.md）。"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "skills" / "book2md1012" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import _common  # noqa: E402


def run(script: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-X", "utf8", str(SCRIPTS / script), *map(str, args)],
                          capture_output=True, text=True, encoding="utf-8")


def span(text: str, cross: bool = False) -> dict:
    item = {"type": "text", "content": text}
    if cross:
        item["cross_page"] = True
    return item


def line(text: str, y: float, cross: bool = False) -> dict:
    return {"bbox": [50, y, 500, y + 12], "spans": [span(text, cross)]}


def block(kind: str, index: int, lines: list[dict], **extra) -> dict:
    return {"type": kind, "index": index, "bbox": [50, 100, 500, 400], "lines": lines, **extra}


def page_number(n: int) -> dict:
    return {"type": "page_number", "bbox": [280, 800, 300, 810], "lines": [line(str(n), 800)]}


def footnote(text: str) -> dict:
    return {"type": "page_footnote", "bbox": [50, 760, 500, 780], "lines": [line(text, 760)]}


def layout_pages() -> list[dict]:
    """四页：第 1 页段落跨到第 2 页（cross_page）；第 3 页空白；第 4 页新起一章。印刷页 = 物理页 + 99。"""
    p1 = {"page_idx": 0, "page_size": [595, 842],
          "para_blocks": [block("title", 0, [line("第一章 开篇", 80)], level=1),
                          block("text", 1, [line("这一段从第一页开始①，一直写到", 100),
                                            line("第二页才结束。", 70, cross=True)])],
          "discarded_blocks": [page_number(100), footnote("①第一页的注。")]}
    p2 = {"page_idx": 1, "page_size": [595, 842],
          "para_blocks": [block("text", 0, [], lines_deleted=True),
                          block("text", 1, [line("第二页自己的一段。", 120)])],
          "discarded_blocks": [page_number(101)]}
    p3 = {"page_idx": 2, "page_size": [595, 842], "para_blocks": [], "discarded_blocks": []}
    p4 = {"page_idx": 3, "page_size": [595, 842],
          "para_blocks": [block("title", 0, [line("第二章 再说", 80)], level=1),
                          block("text", 1, [line("第二章的正文②。", 100)])],
          "discarded_blocks": [page_number(103), footnote("②第四页的注。")]}
    for p in (p1, p2, p3, p4):
        p["preproc_blocks"] = p["para_blocks"]
    return [p1, p2, p3, p4]


def write_layout(directory: Path, pages: list[dict], **meta) -> Path:
    directory.mkdir(parents=True)
    (directory / "layout.json").write_text(json.dumps({"_version_name": "3.4.4", **meta, "pdf_info": pages},
                                                      ensure_ascii=False), encoding="utf-8")
    return directory


def build(tmp_path: Path, name: str = "书.mineru", pages=None) -> str:
    mineru = write_layout(tmp_path / name, pages or layout_pages())
    out = tmp_path / "skeleton.md"
    result = run("build.py", mineru, "-o", out)
    assert result.returncode == 0, result.stdout + result.stderr
    return out.read_text(encoding="utf-8")


def body_of(text: str) -> str:
    return text.split("\n---\n\n## 注释")[0]


def test_every_page_gets_one_physical_anchor_and_cross_page_seam_is_mid_paragraph(tmp_path: Path) -> None:
    text = build(tmp_path)
    body = body_of(text)
    assert [int(n) for n in re.findall(r"<!--pdf-page\.(\d+)-->", body)] == [1, 2, 3, 4]
    # 接缝在段中：上页末字与下页首字之间
    assert "一直写到<!--pdf-page.2--><!--p.101-->第二页才结束。" in body
    # 空白页的锚点独占一段，印刷页推定为 102
    assert "\n\n<!--pdf-page.3--><!--p.102-->\n\n" in body
    # 锚点不进标题行
    assert not [ln for ln in body.split("\n") if ln.startswith("#") and "<!--" in ln]


def test_footnote_definitions_carry_their_page_anchors(tmp_path: Path) -> None:
    text = build(tmp_path)
    assert "[^1]: <!--pdf-page.1--><!--p.100--> 第一页的注。" in text
    assert "[^2]: <!--pdf-page.4--><!--p.103--> 第四页的注。" in text


def test_volume_start_offsets_physical_pages(tmp_path: Path) -> None:
    text = build(tmp_path, "书.pages-0201-0204.mineru")
    assert [int(n) for n in re.findall(r"<!--pdf-page\.(\d+)-->", body_of(text))] == [201, 202, 203, 204]


def test_absolute_page_idx_is_used_as_is(tmp_path: Path) -> None:
    pages = layout_pages()[:2]
    for number, page in enumerate(pages):
        page["page_idx"] = 36 + number
    text = build(tmp_path, pages=pages)
    assert re.findall(r"<!--pdf-page\.(\d+)-->", body_of(text)) == ["37", "38"]


def test_printed_pages_skip_cover_and_only_report_isolated_misreads() -> None:
    pages = [{"discarded_blocks": []}] + [{"discarded_blocks": [page_number(n)]} for n in (1, 2, 30, 4, 5)]
    printed, review = _common.printed_pages(pages)
    assert printed == {0: None, 1: 1, 2: 2, 3: 30, 4: 4, 5: 5}          # 读到的照写，不替 MinerU 改
    misread = [note for pi, kind, note in review if kind == "misread"]
    assert misread == ["读到 30（照写），前后页推应为 3，看原页定"]
    assert not [kind for _, kind, _ in review if kind == "jump"]       # 疑误读不算跳号


def test_anchor_regex_reads_both_formats() -> None:
    assert _common.anchor_page("<!--pdf-page.12--><!--p.3-->") == 12
    assert _common.anchor_page("<!--pdf-page.12-->") == 12
    assert _common.anchor_page("<!--p.3-->") == 0
    assert _common.anchor_page("正文<!--pdf-page.12-->") is None


def test_schema_check_rejects_docvortex_and_non_3x() -> None:
    with pytest.raises(_common.SchemaError):
        _common.check_schema({"schema": "docvortex.middle", "version": "2.0", "pages": []})
    with pytest.raises(_common.SchemaError):
        _common.check_schema({"pages": []})
    assert _common.check_schema({"_version_name": "3.4.4", "_ocr_enable": True, "pdf_info": []}) == ("3.4.4", True)


def test_build_stops_on_docvortex_layout(tmp_path: Path) -> None:
    mineru = tmp_path / "书.mineru"
    mineru.mkdir()
    (mineru / "x_middle.json").write_text(json.dumps({"schema": "docvortex.middle", "pages": []}), encoding="utf-8")
    result = run("build.py", mineru, "-o", tmp_path / "out.md")
    assert result.returncode != 0
    assert "DocVortex" in result.stdout


def make_book(tmp_path: Path) -> Path:
    skeleton = build(tmp_path)
    skeleton = skeleton.replace("title: \n", "title: 书\n").replace("author: \n", "")
    skeleton = "\n".join(ln for ln in skeleton.split("\n") if not ln.startswith("# 期刊"))
    skeleton = skeleton.replace("tags: []   # tags/aliases/cssclasses 是 Obsidian 内置属性，必须保持英文键名", "tags: []")
    src = tmp_path / "ready.md"
    src.write_text(skeleton, encoding="utf-8")
    book = tmp_path / "书"
    book.mkdir()
    (book / "书.pdf").write_bytes(b"%PDF-1.4 fake")
    result = run("split_book.py", src, "-o", book, "--meta", "book=书", "--split")
    assert result.returncode == 0, result.stdout + result.stderr
    return book


def test_split_writes_pdf_link_into_every_file_and_book_json(tmp_path: Path) -> None:
    book = make_book(tmp_path)
    files = sorted(book.glob("*.md"))
    assert len(files) == 3  # 两章 + 索引
    for path in files:
        assert 'pdf: "[[书.pdf]]"' in path.read_text(encoding="utf-8")
    data = json.loads((book / "_数据" / "book.json").read_text(encoding="utf-8"))
    assert data["version"] == 2 and data["pdf"] == "书.pdf" and data["printedPageOffset"] == -99
    assert [f["pdfPages"] for f in data["files"]] == [[1, 3], [4, 4]]


def test_chapter_start_anchor_moves_with_the_heading_into_the_next_file(tmp_path: Path) -> None:
    book = make_book(tmp_path)
    second = (book / "02-第一章-开篇.md").read_text(encoding="utf-8") if (book / "02-第一章-开篇.md").exists() else None
    names = sorted(p.name for p in book.glob("0*.md"))
    ch2 = (book / names[1]).read_text(encoding="utf-8")
    body = ch2.split("\n---\n", 1)[1]
    assert body.lstrip().startswith("<!--pdf-page.4--><!--p.103-->\n\n# 第二章 再说")
    assert second is None or "<!--pdf-page.4-->" not in second


def test_verify_book_passes_and_catches_a_missing_page(tmp_path: Path) -> None:
    book = make_book(tmp_path)
    ok = run("verify.py", "--book", book)
    assert ok.returncode == 0, (book / "_数据" / "过程报告" / "_verify_book.txt").read_text(encoding="utf-8")
    first = sorted(book.glob("0*.md"))[0]
    first.write_text(first.read_text(encoding="utf-8").replace("<!--pdf-page.3--><!--p.102-->", ""), encoding="utf-8")
    bad = run("verify.py", "--book", book)
    report = (book / "_数据" / "过程报告" / "_verify_book.txt").read_text(encoding="utf-8")
    assert bad.returncode == 1
    assert "全书缺物理页锚点 1 页: [3]" in report
    assert "pdfPages [1, 3] 与文件里的锚点 1—2 不符" in report


def test_verify_file_requires_pdf_frontmatter_and_monotonic_anchors(tmp_path: Path) -> None:
    md = tmp_path / "文.md"
    md.write_text("---\ntitle: 文\n---\n\n<!--pdf-page.2-->\n\n甲\n\n<!--pdf-page.1-->\n\n乙\n", encoding="utf-8")
    result = run("verify.py", md)
    report = (tmp_path / "_数据" / "过程报告" / "_verify_文.txt").read_text(encoding="utf-8")
    assert result.returncode == 1
    assert "没有 pdf" in report and "倒序" in report


SPLIT_SKELETON = """---
title: 书
---

<!--pdf-page.1--><!--p.1-->

# 第一章 甲

甲章正文，到第一页中间结束。

# 第二章 乙

乙章从第一页中间开始，接着写到<!--pdf-page.2--><!--p.2-->第二页。

<!--pdf-page.3-->

# 第三章 丙

<!--p.3-->

丙章正文。
"""


def split_book_from(tmp_path: Path, skeleton: str) -> Path:
    src = tmp_path / "ready.md"
    src.write_text(skeleton, encoding="utf-8")
    book = tmp_path / "书"
    book.mkdir()
    (book / "书.pdf").write_bytes(b"%PDF-1.4 fake")
    result = run("split_book.py", src, "-o", book, "--meta", "book=书", "--split")
    assert result.returncode == 0, result.stdout + result.stderr
    return book


def test_continuation_anchor_opens_a_file_that_starts_mid_page(tmp_path: Path) -> None:
    book = split_book_from(tmp_path, SPLIT_SKELETON)
    second = (book / "02-第二章-乙.md").read_text(encoding="utf-8")
    body = second.split("\n---\n", 1)[1].lstrip("\n")
    assert body.startswith("<!--pdf-page.1--><!--p.1-->\n\n# 第二章 乙")
    # 页首就是章标题：物理页锚点在标题前，印刷页锚点留在标题后，分开写
    third = (book / "03-第三章-丙.md").read_text(encoding="utf-8")
    assert "<!--pdf-page.3-->\n\n# 第三章 丙\n\n<!--p.3-->" in third
    data = json.loads((book / "_数据" / "book.json").read_text(encoding="utf-8"))
    assert [f["pdfPages"] for f in data["files"]] == [[1, 1], [1, 2], [3, 3]]
    assert data["id"].startswith("lunzhu2md-") and data["indexNote"] == "书.md" and "index" not in data
    ok = run("verify.py", "--book", book)
    assert ok.returncode == 0, (book / "_数据" / "过程报告" / "_verify_book.txt").read_text(encoding="utf-8")


def write_md(tmp_path: Path, body: str) -> Path:
    md = tmp_path / "文.md"
    (tmp_path / "文.pdf").write_bytes(b"%PDF")
    md.write_text('---\ntitle: 文\npdf: "[[文.pdf]]"\n---\n\n' + body, encoding="utf-8")
    return md


def verify_report(tmp_path: Path, *extra) -> tuple[int, str]:
    result = run("verify.py", tmp_path / "文.md", *extra)
    return result.returncode, (tmp_path / "_数据" / "过程报告" / "_verify_文.txt").read_text(encoding="utf-8")


def test_backward_order_is_only_a_warning(tmp_path: Path) -> None:
    write_md(tmp_path, "<!--pdf-page.1-->\n\n甲\n\n<!--pdf-page.3-->\n\n丙\n\n<!--pdf-page.2-->\n\n乙\n")
    code, report = verify_report(tmp_path)
    assert code == 0 and "倒序" in report and "提醒" in report


def test_gaps_fail_unless_allowed(tmp_path: Path) -> None:
    write_md(tmp_path, "<!--pdf-page.1-->\n\n甲\n\n<!--pdf-page.4-->\n\n丁\n")
    code, report = verify_report(tmp_path)
    assert code == 1 and "缺 2 页: [2, 3]" in report
    code, report = verify_report(tmp_path, "--allow-gaps")
    assert code == 0 and "缺 2 页" in report


def test_two_printed_anchors_on_one_page_fail(tmp_path: Path) -> None:
    write_md(tmp_path, "<!--pdf-page.1--><!--p.5-->\n\n甲<!--p.6-->乙\n")
    code, report = verify_report(tmp_path)
    assert code == 1 and "不止一个 <!--p.M-->" in report
