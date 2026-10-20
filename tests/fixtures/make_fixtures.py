"""由演示书《新史學》造测试材料（只读演示书，不改它）。

    python -X utf8 tests/fixtures/make_fixtures.py --src <演示书文件夹>
    （或设环境变量 AIHISTORY_DEMO_BOOK 指向演示书文件夹）

演示书是 AIhistory1012 用 lunzhu2md 真实导入的《新史學》（23 页；物理页 = 印刷页 + 4），
文字据维基文库，CC BY-SA 4.0；来源与许可见同目录 README.md。

产出（都进仓库）：
- clean/新史學/   三章三个 Markdown（frontmatter 的 pdf 改指 新史學.pdf）与 _数据/book.json
- broken/新史學/  在 clean 上埋 5 处错，另有 埋错清单.json（埋了什么、在哪页，测试用的标准答案）

测试用的 PDF 是同目录的 新史學.pdf：演示书的排印本（有文字层），与这里的 Markdown 逐页对应，
由维护者从演示书的 排版源/新史學.排印本.pdf 复制进来，不由本脚本生成。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path

BOOK = "新史學"
PDF_NAME = "新史學.pdf"
FILES = ["01-中國之舊史.md", "02-史學之界說.md", "03-論正統.md"]
OFFSET = 4                       # 物理页 - 印刷页
RUNNING_HEAD = "新史學　梁啟超"  # 排印本偶数页的页眉（奇数页是章名）

HERE = Path(__file__).resolve().parent
CLEAN = HERE / "clean" / BOOK
BROKEN = HERE / "broken" / BOOK
MD_PDF_RE = re.compile(r'^pdf: "\[\[[^\]]+\]\]"$', re.M)


# ---------------------------------------------------------------- clean

def make_clean(src: Path) -> dict[str, str]:
    out = {}
    for name in FILES:
        text = (src / name).read_text(encoding="utf-8").replace("\r\n", "\n")
        text, n = MD_PDF_RE.subn(f'pdf: "[[{PDF_NAME}]]"', text, count=1)
        assert n == 1, name
        out[name] = text
    return out


def book_json(src: Path) -> dict:
    data = json.loads((src / "_数据" / "book.json").read_text(encoding="utf-8"))
    data.update(pdf=PDF_NAME, originalPdf=PDF_NAME)
    data.pop("indexNote", None)          # 索引笔记不随测试材料走
    return data


# ---------------------------------------------------------------- broken

def _replace_once(s: str, old: str, new: str) -> str:
    assert s.count(old) == 1, (old[:40], s.count(old))
    return s.replace(old, new, 1)


def _segment(s: str, page: int) -> tuple[int, int]:
    a = s.index(f"<!--pdf-page.{page}-->")
    m = re.compile(r"<!--pdf-page\.\d+-->|\n## 注释").search(s, a + 10)
    return a, (m.start() if m else len(s))


def make_broken(clean: dict[str, str]) -> tuple[dict[str, str], list[dict]]:
    f = dict(clean)
    bugs: list[dict] = []

    # 1. 删一段：第 18 页上最长的、不含注码和锚点的整段
    name = "03-論正統.md"
    s = f[name]
    a, b = _segment(s, 18)
    paras = [p for p in s[a:b].split("\n\n")[1:-1]
             if "[^" not in p and "<!--" not in p and not p.startswith("#") and p.strip()]
    para = max(paras, key=len)
    s = _replace_once(s, "\n\n" + para + "\n", "\n")
    f[name] = s
    bugs.append({"kind": "删一段", "file": name, "page": 18, "text_head": para[:20], "chars": len(para)})

    # 2. 删一条注：删注 5 的定义（正文注码保留），注在第 6 页
    name = "01-中國之舊史.md"
    m = re.search(r"\n\[\^5\]: [^\n]*\n", f[name])
    assert m
    f[name] = f[name].replace(m.group(0), "\n", 1)
    page = int(re.search(r"pdf-page\.(\d+)", m.group(0)).group(1))
    bugs.append({"kind": "删一条注", "file": name, "page": page, "footnote": "5"})

    # 3. 整段重复：第 13 页第二段（不含注码）在原处又出现一次（接缝处重复识别）
    name = "02-史學之界說.md"
    s = f[name]
    a, b = _segment(s, 13)
    paras = [p for p in s[a:b].split("\n\n")[1:]
             if p.strip() and "[^" not in p and "<!--" not in p and not p.startswith("#")]
    para = paras[0]
    s = _replace_once(s, "\n\n" + para + "\n", "\n\n" + para + "\n\n" + para + "\n")
    f[name] = s
    bugs.append({"kind": "整段重复", "file": name, "page": 13, "text_head": para[:20], "chars": len(para)})

    # 4. 页码锚点错位：第 21 页的锚点本在段中接缝处，挪到这一段段首（段首在第 20 页）
    name = "03-論正統.md"
    s = f[name]
    anchor = "<!--pdf-page.21--><!--p.17-->"
    pos = s.index(anchor)
    s = s[:pos] + s[pos + len(anchor):]
    para_start = s.rfind("\n\n", 0, pos) + 2
    s = s[:para_start] + anchor + s[para_start:]
    f[name] = s
    bugs.append({"kind": "页码锚点错位", "file": name, "page": 21, "moved_to_line": s[:para_start].count("\n") + 1})

    # 5. 混进一行页眉：第 19 页正文第二段之后插一行页眉
    s = f[name]
    seg_start = s.index("<!--pdf-page.19-->")
    nxt = s.index("\n\n", s.index("\n\n", seg_start) + 2)
    s = s[:nxt] + "\n\n" + RUNNING_HEAD + s[nxt:]
    f[name] = s
    bugs.append({"kind": "混进一行页眉", "file": name, "page": 19, "text": RUNNING_HEAD})
    return f, bugs


# ---------------------------------------------------------------- 写出

def write_book(d: Path, files: dict[str, str], bj: dict) -> None:
    if d.exists():
        shutil.rmtree(d)
    (d / "_数据").mkdir(parents=True)
    for name, text in files.items():
        (d / name).write_text(text, encoding="utf-8", newline="\n")
    (d / "_数据" / "book.json").write_text(json.dumps(bj, ensure_ascii=False, indent=2) + "\n",
                                           encoding="utf-8", newline="\n")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", default=os.environ.get("AIHISTORY_DEMO_BOOK"),
                    help="演示书《新史學》的书文件夹（默认取环境变量 AIHISTORY_DEMO_BOOK）")
    args = ap.parse_args(argv)
    if not args.src:
        print("要给演示书文件夹：--src <文件夹> 或环境变量 AIHISTORY_DEMO_BOOK", file=sys.stderr)
        return 2
    src = Path(args.src)
    if not all((src / n).exists() for n in FILES):
        print(f"演示书文件夹里缺章节文件：{src}", file=sys.stderr)
        return 1
    clean = make_clean(src)
    broken, bugs = make_broken(clean)
    bj = book_json(src)
    write_book(CLEAN, clean, bj)
    write_book(BROKEN, broken, bj)
    (BROKEN / "埋错清单.json").write_text(json.dumps(bugs, ensure_ascii=False, indent=2) + "\n",
                                       encoding="utf-8", newline="\n")
    print("ok", CLEAN, BROKEN)
    return 0


if __name__ == "__main__":
    sys.exit(main())
