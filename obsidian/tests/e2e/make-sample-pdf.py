"""现造繁简通搜用的小样书 PDF（公版：梁启超《中国历史研究法》第一章开头，作者卒于 1929 年）。

两页、简体、带文字层；故意让词跨行（「赓 / 续」）、跨页（「因果 / 关系」），供插件与网页的端到端测试搜繁体。
字体用 PyMuPDF 自带的 china-s（不读本机字体，各平台一致）。

用法：python -X utf8 make-sample-pdf.py <输出.pdf>
"""
from __future__ import annotations

import sys
from pathlib import Path

import pymupdf

PAGES = [
    [
        "第一章　史之意义及其范围",
        "史者何？记述人类社会赓",
        "续活动之体相，校其总成绩，求得其因果",
    ],
    [
        "关系，以为现代一般人活动之资鉴者也。",
        "其专述中国先民之活动，供现代中国国民之资鉴者，",
        "则曰中国史。",
    ],
]


def main() -> int:
    out = Path(sys.argv[1])
    out.parent.mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open()
    for lines in PAGES:
        page = doc.new_page(width=420, height=595)
        y = 80
        for line in lines:
            page.insert_text((40, y), line, fontname="china-s", fontsize=16)
            y += 28
    doc.save(out)
    # 自检：文字层取得出来
    text = "".join(p.get_text() for p in pymupdf.open(out))
    assert "记述人类社会赓" in text and "关系" in text, text
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
