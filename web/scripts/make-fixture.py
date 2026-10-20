"""造端到端测试用的书 fixture（只读仓库里的测试样本，产物写进 fixtures/，git 忽略）。

来源：tests/fixtures/clean/新史學（演示书《新史學》，梁启超 1902，文字据维基文库，CC BY-SA 4.0）
与 tests/fixtures/新史學.pdf（排印本，23 页，有文字层；物理页 = 印刷页 + 4）。不读任何本机材料。

产物：
- fixtures/新史學/：第一章拆成「00-卷首」（书名页到第 5 页的第一段）与「01-正文」（第 5 页其余起），
  第 5 页跨两个文件、正文开头写续页锚点（docs/anchors.md 第二节第 6 条）；第二、三章原样；
  加索引、book.json（version 2）和一份疑字清单。
- fixtures/新史學-旧格式/：第一章原样一个文件、只有印刷页锚点 <!--p.M-->，book.json 第 1 版只给 pdf 与 printedPageOffset。
- fixtures/中国历史研究法/：繁简通搜用的公版小样书。

用法：python -X utf8 scripts/make-fixture.py
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "tests" / "fixtures" / "clean" / "新史學"
SRC_PDF = REPO / "tests" / "fixtures" / "新史學.pdf"
BOOK = "新史學"
OUT = Path(__file__).resolve().parent.parent / "fixtures" / BOOK
PDF_NAME = f"{BOOK}.pdf"
OFFSET = 4  # 物理页 = 印刷页 + 4
SPLIT_AT = "今請舉中國史學之派別"  # 第 5 页从这一段起归「01-正文」
CHAPTERS = ["01-中國之舊史.md", "02-史學之界說.md", "03-論正統.md"]
LINK_FILE = f"书/{BOOK}/01-正文.md"  # 疑字清单链接里的库内路径（假想的库）
SUSPECTS = [("而已", "家譜而已"), ("而已", "正史而已")]  # 「而已」本页多处，靠 ctx 消歧

FM_RE = re.compile(r"^---\n[\s\S]*?\n---\n")
NOTE_RE = re.compile(r"^\[\^(\d+)\]:", re.M)
REF_RE = re.compile(r"\[\^(\d+)\](?!:)")


def read(name: str) -> str:
    return (SRC / name).read_text(encoding="utf-8").replace("\r\n", "\n")


def split_notes(text: str) -> tuple[str, str, dict[str, str]]:
    """→ (frontmatter, 正文, {注号: 注文整行})"""
    fm = FM_RE.match(text).group(0)
    body, _, notes = text[len(fm):].partition("\n## 注释\n")
    body = re.sub(r"\n+---\n*$", "\n", body.rstrip() + "\n")
    defs = {m.group(1): line for line in notes.split("\n") if (m := NOTE_RE.match(line))}
    return fm, body, defs


def with_notes(fm: str, body: str, defs: dict[str, str]) -> str:
    used = [d for n, d in defs.items() if n in set(REF_RE.findall(body))]
    tail = "\n---\n\n## 注释\n\n" + "\n\n".join(used) + "\n" if used else ""
    return fm + "\n" + body.strip("\n") + "\n" + tail


def pages_of(content: str) -> list[int]:
    body_only = re.split(r"^\[\^", content, maxsplit=1, flags=re.M)[0]
    return [int(n) for n in re.findall(r"<!--pdf-page\.(\d+)-->", body_only)]


def main() -> int:
    fm, body, defs = split_notes(read(CHAPTERS[0]))
    at = body.index(SPLIT_AT)
    head_fm = fm.replace("title: 中國之舊史", "title: 新史學 卷首", 1)
    body_fm = fm.replace("title: 中國之舊史", "title: 中國之舊史 正文", 1)
    files = {
        "00-卷首.md": with_notes(head_fm, body[:at], defs),
        "01-正文.md": with_notes(body_fm, "<!--pdf-page.5--><!--p.1-->\n\n" + body[at:], defs),
        CHAPTERS[1]: read(CHAPTERS[1]),
        CHAPTERS[2]: read(CHAPTERS[2]),
        f"{BOOK}.md": f'---\ntitle: {BOOK}\npdf: "[[{PDF_NAME}]]"\n---\n\n# {BOOK}\n\n'
                      + "\n".join(f"- [[{n[:-3]}]]" for n in ["00-卷首.md", "01-正文.md", *CHAPTERS[1:]]) + "\n",
    }

    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "_数据").mkdir(parents=True)
    shutil.copyfile(SRC_PDF, OUT / PDF_NAME)
    for name, content in files.items():
        (OUT / name).write_text(content, encoding="utf-8", newline="\n")

    entries = []
    for name in ["00-卷首.md", "01-正文.md", *CHAPTERS[1:]]:
        pages = pages_of(files[name])
        entry = {"path": name, "pdfPages": [min(pages), max(pages)]}
        if max(pages) > OFFSET:
            entry["printedPages"] = f"{max(min(pages) - OFFSET, 1)}-{max(pages) - OFFSET}"
        entries.append(entry)
    book = {
        "version": 2,
        "title": BOOK,
        "pdf": PDF_NAME,
        "originalPdf": PDF_NAME,
        "pageCount": 23,
        "printedPageOffset": OFFSET,
        "writingMode": "horizontal-tb",
        "indexNote": f"{BOOK}.md",
        "files": entries,
        "generator": "web make-fixture.py",
    }
    (OUT / "_数据" / "book.json").write_text(json.dumps(book, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # 疑字清单：链接格式照 docs/anchors.md 第六节；库名用假想的「史料库」，文件按库内路径写
    def link(page: int, text: str, ctx: str) -> str:
        params = {"vault": "史料库", "file": LINK_FILE, "page": str(page), "text": text, "ctx": ctx}
        return "obsidian://aihistory-pdf-sync?" + "&".join(f"{k}={quote(v, safe='')}" for k, v in params.items())

    body_text = re.split(r"^\[\^", files["01-正文.md"], maxsplit=1, flags=re.M)[0]

    def page_at(ctx: str) -> int:
        at = body_text.index(ctx)
        return int(re.findall(r"<!--pdf-page\.(\d+)-->", body_text[:at])[-1])

    suspects = [(page_at(ctx), text_, ctx) for text_, ctx in SUSPECTS]
    lines = [f"---\ntitle: {BOOK} 疑字清单\n---\n", "# 疑字清单\n", "| # | 位置 | 现字 | 链接 |", "|---|---|---|---|"]
    for index, (page, text_, ctx) in enumerate(suspects, 1):
        lines.append(f"| {index} | PDF 第 {page} 页 | {text_} | [打开]({link(page, text_, ctx)}) |")
    (OUT / f"{BOOK}.疑字清单.md").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")

    for name in files:
        print(name, pages_of(files[name]))
    print("疑字", suspects)

    # 旧格式：第一章原样一个文件、只有印刷页锚点 <!--p.M-->，book.json 第 1 版只给 pdf 与 printedPageOffset
    # （插件与网页共用的 core/cm-sync.ts 按偏移换算物理页；端到端测试验证跟随准）
    legacy = OUT.parent / f"{BOOK}-旧格式"
    if legacy.exists():
        shutil.rmtree(legacy)
    (legacy / "_数据").mkdir(parents=True)
    shutil.copyfile(SRC_PDF, legacy / PDF_NAME)
    old = re.sub(r"^pdf:.*\n", "", read(CHAPTERS[0]), flags=re.M)
    old = re.sub(r"<!--pdf-page\.\d+-->", "", old)
    (legacy / f"{BOOK}.md").write_text(old, encoding="utf-8", newline="\n")
    old_book = {"version": 1, "title": BOOK, "pdf": PDF_NAME, "printedPageOffset": OFFSET}
    (legacy / "_数据" / "book.json").write_text(json.dumps(old_book, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{BOOK}-旧格式", "印刷页锚点", len(re.findall(r"<!--p\.\d+-->", old)))
    make_sample_book()
    return 0


SAMPLE = "中国历史研究法"


def make_sample_book() -> None:
    """繁简通搜用的公版小样书（梁启超《中国历史研究法》首章开头），与插件端到端测试同一份 PDF 脚本。"""
    folder = OUT.parent / SAMPLE
    if folder.exists():
        shutil.rmtree(folder)
    folder.mkdir(parents=True)
    script = Path(__file__).resolve().parents[2] / "obsidian" / "tests" / "e2e" / "make-sample-pdf.py"
    subprocess.run([sys.executable, "-X", "utf8", str(script), str(folder / f"{SAMPLE}.pdf")], check=True)
    note = "\n".join([
        "---",
        f'pdf: "[[{SAMPLE}.pdf]]"',
        "---",
        "",
        "<!--pdf-page.1--><!--p.1-->",
        "",
        "# 第一章　史之意义及其范围",
        "",
        "史者何？记述人类社会赓续活动之体相，校其总成绩，求得其因果<!--pdf-page.2--><!--p.2-->关系，以为现代一般人活动之资鉴者也。其专述中国先民之活动，供现代中国国民之资鉴者，则曰中国史。",
        "",
    ])
    (folder / f"{SAMPLE}.md").write_text(note, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    sys.exit(main())
