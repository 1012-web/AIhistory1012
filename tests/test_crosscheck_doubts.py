"""crosscheck.py（两家识别对齐）与 doubts.py（裁决、校注、疑字清单）。"""
from __future__ import annotations

import json
import subprocess
import sys
import urllib.parse
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "skills" / "lunzhu2md" / "scripts"

BODY = """---
title: 测试书 · 正文
pdf: "[[测试书.pdf]]"
---

<!--pdf-page.1--><!--p.1-->

# 第一章

洪范说恭作肃，从作义，明作哲。[^1]下文接着讲五事，一直写到<!--pdf-page.2--><!--p.2-->第二页。

第二页还有一句，只有正文有这一整段二十多个字的文字在这里出现。

---

## 注释

[^1]: <!--pdf-page.1--><!--p.1--> 见《尚书·洪范》。
"""


def vl_page(number: int, blocks: list[tuple[str, str]]) -> dict:
    return {"page": number, "parsing_res_list": [{"block_label": label, "block_content": text, "block_bbox": [0, 0, 1, 1]}
                                                 for label, text in blocks]}


def make_book(tmp_path: Path, in_vault: bool = True, registered: bool = True) -> Path:
    root = tmp_path / "库"
    (tmp_path / ".obsidian").mkdir(parents=True, exist_ok=True)   # 上一级误留的 .obsidian，没登记，不算库
    vaults = {}
    if in_vault:
        (root / ".obsidian").mkdir(parents=True)
        if registered:
            vaults["abc"] = {"path": str(root), "ts": 1}
    REGISTRY["path"] = tmp_path / "obsidian.json"
    REGISTRY["path"].write_text(json.dumps({"vaults": vaults}), encoding="utf-8")
    book = root / "书" / "测试书"
    (book / "_数据" / "PaddleOCR").mkdir(parents=True)
    (book / "01-正文.md").write_text(BODY, encoding="utf-8")
    (book / "_数据" / "book.json").write_text(json.dumps({"version": 2, "title": "测试书", "pdf": "测试书.pdf",
                                                         "files": [{"path": "01-正文.md", "pdfPages": [1, 2]}]},
                                                        ensure_ascii=False), encoding="utf-8")
    pages = {
        1: [("paragraph_title", "第一章"),
            ("text", "洪范说恭作肃，从作乂，明作哲。$ ^{①} $下文接着讲五事，一直写到"),
            ("footnote", "① 见《尚书·洪范》。"), ("number", "1")],
        2: [("text", "第二页。"), ("number", "2")],
    }
    for number, blocks in pages.items():
        (book / "_数据" / "PaddleOCR" / f"p{number:04d}.json").write_text(
            json.dumps(vl_page(number, blocks), ensure_ascii=False), encoding="utf-8")
    return book


REGISTRY: dict[str, Path] = {}


def run(script: str, *args) -> subprocess.CompletedProcess:
    import os
    env = os.environ.copy()
    if "path" in REGISTRY:
        env["OBSIDIAN_CONFIG"] = str(REGISTRY["path"])
    result = subprocess.run([sys.executable, "-X", "utf8", str(SCRIPTS / script), *map(str, args)],
                            capture_output=True, text=True, encoding="utf-8", env=env)
    assert result.returncode == 0, result.stdout + result.stderr
    return result


def crosscheck(book: Path) -> dict:
    run("crosscheck.py", "--book", book, "--vl", book / "_数据" / "PaddleOCR")
    return json.loads((book / "_数据" / "冲突清单" / "conflicts.json").read_text(encoding="utf-8"))


def test_crosscheck_aligns_by_physical_page_and_classifies(tmp_path: Path) -> None:
    book = make_book(tmp_path)
    result = crosscheck(book)
    items = result["items"]
    char = [i for i in items if i["kind"] == "char"]
    assert [(i["page"], i["md_raw"], i["vl_raw"]) for i in char] == [(1, "义", "乂")]
    # 注号、注文、标题、全半角都对得上，不报
    assert not [i for i in items if i["kind"] in ("refs", "notes", "heading")]
    passage = [i for i in items if i["kind"] == "passage"]
    assert len(passage) == 1 and passage[0]["page"] == 2 and passage[0]["vl"] == "" and passage[0]["needs_image"]
    assert result["pagesCompared"] == [1, 2]
    sheet = (book / "_数据" / "冲突清单" / "冲突清单.md").read_text(encoding="utf-8")
    assert "从作【义】,明作哲" in sheet and "从作【乂】,明作哲" in sheet and "整段有无" in sheet


def test_missing_vl_page_is_reported_as_no_second_reader(tmp_path: Path) -> None:
    book = make_book(tmp_path)
    (book / "_数据" / "PaddleOCR" / "p0002.json").unlink()
    result = crosscheck(book)
    assert result["pagesWithoutSecondReader"] == [2]


def decide(book: Path, decisions: list[dict], *extra) -> dict:
    path = book / "_数据" / "冲突清单" / "decisions.json"
    path.write_text(json.dumps(decisions, ensure_ascii=False), encoding="utf-8")
    run("doubts.py", "--book", book, "--decisions", path, *extra)
    return json.loads((book / "_数据" / "冲突清单" / "_doubts_report.json").read_text(encoding="utf-8"))


def test_accepted_reading_is_written_into_the_text_and_the_notes(tmp_path: Path) -> None:
    book = make_book(tmp_path)
    items = crosscheck(book)["items"]
    char = next(i for i in items if i["kind"] == "char")
    report = decide(book, [{"id": char["id"], "decision": "vl", "reason": "《洪范》从作乂", "by": "text"}],
                    "--undecided", "skip")
    text = (book / "01-正文.md").read_text(encoding="utf-8")
    assert "从作乂" in text and "从作义" not in text
    assert text.count("<!--pdf-page.") == 3 and "[^1]" in text          # 锚点、注号没动
    notes = (book / "测试书.AI校注.md").read_text(encoding="utf-8")
    assert "| %s | PDF 第 1 页（01-正文.md） | 义 | 乂 | 读文字：《洪范》从作乂 |" % char["id"] in notes
    assert report["applied"] == [char["id"]] and report["sheet"] is None


def test_pending_items_go_to_the_doubt_sheet_with_obsidian_links(tmp_path: Path) -> None:
    book = make_book(tmp_path)
    items = crosscheck(book)["items"]
    char = next(i for i in items if i["kind"] == "char")
    decide(book, [{"id": char["id"], "decision": "pending", "reason": "看不清"}])
    sheet = (book / "测试书.疑字清单.md").read_text(encoding="utf-8")
    line = next(ln for ln in sheet.splitlines() if char["id"] in ln)
    link = line[line.index("(obsidian://") + 1:line.index(")")]
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(link).query)
    assert link.startswith("obsidian://aihistory-pdf-sync?")
    assert query == {"vault": ["库"], "file": ["书/测试书/01-正文.md"], "page": ["1"], "text": ["义"],
                     "ctx": ["恭作肃，从作义，明作哲。["]}
    # 整段有无没写裁决：默认也进清单，正文不动
    assert "整段" in sheet
    assert "从作义" in (book / "01-正文.md").read_text(encoding="utf-8")


def link_query(sheet: str, item_id: str) -> dict:
    line = next(ln for ln in sheet.splitlines() if item_id in ln)
    link = line[line.index("(obsidian://") + 1:line.index(")")]
    return urllib.parse.parse_qs(urllib.parse.urlsplit(link).query)


def test_outside_a_vault_the_link_is_written_without_vault(tmp_path: Path) -> None:
    book = make_book(tmp_path, in_vault=False)
    items = crosscheck(book)["items"]
    char = next(i for i in items if i["kind"] == "char")
    decide(book, [{"id": char["id"], "decision": "pending"}])
    sheet = (book / "测试书.疑字清单.md").read_text(encoding="utf-8")
    query = link_query(sheet, char["id"])
    assert "vault" not in query and query["file"] == ["测试书/01-正文.md"] and query["page"] == ["1"]


def test_edit_is_refused_when_the_text_changed_since_crosscheck(tmp_path: Path) -> None:
    book = make_book(tmp_path)
    items = crosscheck(book)["items"]
    char = next(i for i in items if i["kind"] == "char")
    path = book / "01-正文.md"
    path.write_text(path.read_text(encoding="utf-8").replace("从作义", "从作X"), encoding="utf-8")
    report = decide(book, [{"id": char["id"], "decision": "vl", "reason": "r"}], "--undecided", "skip")
    assert report["applied"] == [] and report["failed"][0]["why"] == "text changed since crosscheck"
    assert char["id"] in report["pending"]


def test_unregistered_obsidian_folder_is_not_taken_as_the_vault(tmp_path: Path) -> None:
    book = make_book(tmp_path, registered=False)
    items = crosscheck(book)["items"]
    char = next(i for i in items if i["kind"] == "char")
    decide(book, [{"id": char["id"], "decision": "pending"}])
    sheet = (book / "测试书.疑字清单.md").read_text(encoding="utf-8")
    assert "vault" not in link_query(sheet, char["id"])


def test_inline_anchor_inside_a_footnote_moves_the_rest_to_the_next_page(tmp_path: Path) -> None:
    book = make_book(tmp_path)
    md = book / "01-正文.md"
    md.write_text(md.read_text(encoding="utf-8").replace(
        "[^1]: <!--pdf-page.1--><!--p.1--> 见《尚书·洪范》。",
        "[^1]: <!--pdf-page.1--><!--p.1--> 见《尚书·<!--pdf-page.2--><!--p.2-->洪范》。"), encoding="utf-8")
    vl = book / "_数据" / "PaddleOCR"
    (vl / "p0001.json").write_text(json.dumps(vl_page(1, [
        ("paragraph_title", "第一章"), ("text", "洪范说恭作肃，从作义，明作哲。$ ^{①} $下文接着讲五事，一直写到"),
        ("footnote", "① 见《尚书·")]), ensure_ascii=False), encoding="utf-8")
    (vl / "p0002.json").write_text(json.dumps(vl_page(2, [
        ("text", "第二页。第二页还有一句，只有正文有这一整段二十多个字的文字在这里出现。"), ("footnote", "洪范》。")]),
        ensure_ascii=False), encoding="utf-8")
    items = crosscheck(book)["items"]
    assert [i for i in items if i["stream"] == "notes"] == []
