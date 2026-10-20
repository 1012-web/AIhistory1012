#!/usr/bin/env python3
"""lunzhu2md-audit 的零花费初筛：不调任何接口、不用 AI，只靠正文与 PDF 文字层找疑点、给抽查页。

只读正文、只写报告：报出的都是「疑点」，是给 AI 看图判断的线索，不是结论；本脚本从不改正文。

独立脚本，只用标准库；读 PDF 文字层与渲染优先 pypdfium2，没有再退 PyMuPDF。没有 PDF 也能跑
（字数改与全书中位数比，接缝、上标两项跳过）。

子命令（PATH 可以是一个 .md，也可以是书文件夹）：
    scan    PATH [--out-dir DIR] [--sample N] [--seed S] [--no-pdf] [--stdout]
            初筛，写 抽检初筛.json（机器读）与 抽检初筛.md（人读）；默认写进 <书>/_数据/过程报告/
    render  PATH --pages 3,5-7 [--dpi 60] [--out-dir DIR]
            渲染页图（两步法第一步用低清，60 dpi 左右；第二步高清 150–200 dpi）
    facts   PATH --pages 3,5-7
            输出正文这几页的「事实清单」（段数、注码、注文、标题、表格、图、首尾字），供与 AI 读图结果比对
    compare PATH --facts FILE.json [--out FILE]
            把 AI 从页图列出的事实清单与正文比对，列出对不上的页（这些页才需要高清通读）

退出码：0 正常；1 出错或 compare 有对不上的页；2 用法错误。
"""
from __future__ import annotations

import argparse
import datetime as _dt
import difflib
import json
import math
import os
import random
import re
import shutil
import statistics
import sys
import tempfile
import unicodedata
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from pathlib import Path

# >>> shared-core：与 lunzhu2md-fix/scripts/page_tool.py 逐字相同，改一处要同步另一处（tests 会查）
# ---------------------------------------------------------------- 锚点解析

ANCHOR_RE = re.compile(r"<!--\s*pdf-page\.(\d+)\s*-->")
PRINTED_RE = re.compile(r"<!--\s*p\.([^\s>-][^\s>]*?)\s*-->")
FOLLOWING_PRINTED_RE = re.compile(r"[ \t]*<!--\s*p\.([^\s>-][^\s>]*?)\s*-->")
FN_DEF_RE = re.compile(r"^\[\^([^\]\s]+)\]:")
FN_REF_RE = re.compile(r"\[\^([^\]\s]+)\](?!:)")
FRONTMATTER_RE = re.compile(r"^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)")
NOTES_HEADING_RE = re.compile(r"^(?:#{1,6}\s*)?(?:注释|注|脚注|尾注|Notes?)\s*$", re.I)
SIDECAR_SUFFIXES = (".AI校注.md", ".疑字清单.md")


@dataclass
class Anchor:
    page: int
    printed: str | None
    start: int          # 锚点在全文中的起点
    end: int            # 含紧跟的印刷页锚点
    line: int           # 1 起
    footnote: bool      # 是否在脚注定义里


@dataclass
class FootnoteDef:
    label: str
    start: int
    end: int
    line: int
    end_line: int
    page: int | None
    printed: str | None
    text: str
    # 注文内的各段：[(物理页, 印刷页, 在全文中的起点, 终点)]；跨页注文在接缝处另插锚点时有多段
    parts: list[tuple[int, str | None, int, int]] = field(default_factory=list)

    @property
    def pages(self) -> list[int]:
        return [x[0] for x in self.parts] or ([self.page] if self.page is not None else [])


@dataclass
class Segment:
    page: int
    printed: str | None
    start: int
    end: int
    line: int
    end_line: int
    pieces: list[tuple[int, int]] = field(default_factory=list)  # 去掉脚注定义后的区间
    continuation: bool = False  # 文件开头重复上一文件最后一页的锚点（续页锚点），不算重复


@dataclass
class Doc:
    path: Path
    text: str
    frontmatter: str
    anchors: list[Anchor]
    footnotes: list[FootnoteDef]
    segments: list[Segment]
    line_starts: list[int]
    legacy: bool = False  # 旧格式：只有 <!--p.M-->，按 book.json 的 printedPageOffset 换算物理页

    @property
    def body_anchors(self) -> list[Anchor]:
        return [a for a in self.anchors if not a.footnote]

    def line_of(self, offset: int) -> int:
        lo, hi = 0, len(self.line_starts) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self.line_starts[mid] <= offset:
                lo = mid
            else:
                hi = mid - 1
        return lo + 1

    def segment_text(self, seg: Segment) -> str:
        return "".join(self.text[a:b] for a, b in seg.pieces)


def _line_starts(text: str) -> list[int]:
    starts = [0]
    for i, ch in enumerate(text):
        if ch == "\n":
            starts.append(i + 1)
    return starts


def footnote_ranges(text: str, fm_len: int = 0) -> list[tuple[int, int]]:
    """脚注定义所占区间：定义行，加其后缩进的续行（中间可隔空行）。"""
    out: list[tuple[int, int]] = []
    lines = text.splitlines(keepends=True)
    pos = 0
    open_rng: list[int] | None = None
    pending_blank = 0
    for ln in lines:
        start, pos = pos, pos + len(ln)
        if start < fm_len:
            continue
        stripped = ln.rstrip("\r\n")
        if FN_DEF_RE.match(stripped):
            if open_rng:
                out.append((open_rng[0], open_rng[1]))
            open_rng = [start, pos]
            pending_blank = 0
        elif open_rng is not None:
            if stripped.strip() == "":
                pending_blank += len(ln)
            elif ln.startswith(("    ", "\t", "  ")):
                open_rng[1] = pos
                pending_blank = 0
            else:
                out.append((open_rng[0], open_rng[1]))
                open_rng = None
    if open_rng:
        out.append((open_rng[0], open_rng[1]))
    return out


def parse_doc(path: Path, text: str | None = None, legacy_offset: int | None | str = "auto") -> Doc:
    if text is None:
        text = path.read_text(encoding="utf-8")
    text = text.replace("\r\n", "\n")
    fm = FRONTMATTER_RE.match(text)
    fm_len = fm.end() if fm else 0
    starts = _line_starts(text)
    fn_rngs = footnote_ranges(text, fm_len)

    def in_fn(off: int) -> tuple[int, int] | None:
        for a, b in fn_rngs:
            if a <= off < b:
                return (a, b)
        return None

    doc = Doc(path, text, text[:fm_len], [], [], [], starts)
    for m in ANCHOR_RE.finditer(text, fm_len):
        end = m.end()
        printed = None
        pm = FOLLOWING_PRINTED_RE.match(text, end)
        if pm:
            printed, end = pm.group(1), pm.end()
        doc.anchors.append(Anchor(int(m.group(1)), printed, m.start(), end,
                                  doc.line_of(m.start()), in_fn(m.start()) is not None))
    # 章首页：<!--pdf-page.N--> 在章标题前独占一段，<!--p.M--> 可在标题后另起，归同一页
    body_idx = [i for i, a in enumerate(doc.anchors) if not a.footnote]
    for k, i in enumerate(body_idx):
        a = doc.anchors[i]
        if a.printed is not None:
            continue
        stop = doc.anchors[body_idx[k + 1]].start if k + 1 < len(body_idx) else len(text)
        for fr in fn_rngs:
            if a.end <= fr[0] < stop:
                stop = fr[0]
        pm = PRINTED_RE.search(text, a.end, stop)
        if pm and not ANCHOR_RE.search(text, a.end, pm.start()):
            a.printed = pm.group(1)
    if not doc.anchors:
        if legacy_offset == "auto":
            legacy_offset = printed_offset(book_dir_of(path)) if path else None
        if isinstance(legacy_offset, int):
            for m in PRINTED_RE.finditer(text, fm_len):
                if m.group(1).isdigit():
                    doc.anchors.append(Anchor(int(m.group(1)) + legacy_offset, m.group(1), m.start(), m.end(),
                                              doc.line_of(m.start()), in_fn(m.start()) is not None))
            doc.legacy = bool(doc.anchors)

    for a, b in fn_rngs:
        first = text[a:b]
        m = FN_DEF_RE.match(first)
        own = [x for x in doc.anchors if x.footnote and a <= x.start < b]
        page = own[0].page if own else None
        printed = own[0].printed if own else None
        if not own:  # 只有印刷页锚点的旧写法
            pm = PRINTED_RE.search(first.split("\n", 1)[0])
            printed = pm.group(1) if pm else None
        fd = FootnoteDef(m.group(1), a, b, doc.line_of(a), doc.line_of(max(a, b - 1)),
                         page, printed, first.rstrip("\n"))
        for k, x in enumerate(own):
            fd.parts.append((x.page, x.printed, x.start, own[k + 1].start if k + 1 < len(own) else b))
        doc.footnotes.append(fd)

    body = doc.body_anchors
    hole_starts = {h0 for h0, _ in fn_rngs}
    for i, anc in enumerate(body):
        end = body[i + 1].start if i + 1 < len(body) else len(text)
        pieces = _trim_notes_tail(text, _subtract(anc.start, end, fn_rngs), hole_starts, i + 1 == len(body))
        seg_end = pieces[-1][1] if pieces else anc.end
        doc.segments.append(Segment(anc.page, anc.printed, anc.start, seg_end, anc.line,
                                    doc.line_of(max(anc.start, seg_end - 1)), pieces))
    return doc


def footnote_part_text(doc: Doc, f: FootnoteDef, page: int) -> str:
    """注文落在第 page 页的那部分（注文内插了续页锚点时只取这一段；没插就是全文）。"""
    if not f.parts:
        return f.text if f.page == page else ""
    return "".join(doc.text[a:b] for p, _, a, b in f.parts if p == page).rstrip("\n")


def mark_continuations(docs: list[Doc]) -> None:
    """多文件的书：后一个文件开头（锚点前无正文）重复了上一文件最后一页的锚点，是续页锚点。"""
    prev_last = None
    for d in docs:
        if d.segments and prev_last is not None and d.segments[0].page == prev_last and not lead_text(d)[1]:
            d.segments[0].continuation = True
        if d.segments:
            prev_last = d.segments[-1].page


def lead_text(doc: Doc) -> tuple[int, str]:
    """第一个正文锚点之前、frontmatter 之后的正文（多文件的书里，它属于上一个文件的最后一页）。"""
    first = doc.body_anchors[0].start if doc.body_anchors else len(doc.text)
    pieces = _subtract(len(doc.frontmatter), first, [(f.start, f.end) for f in doc.footnotes])
    text = "".join(doc.text[a:b] for a, b in pieces)
    start = pieces[0][0] if pieces else len(doc.frontmatter)
    return doc.line_of(start + len(text) - len(text.lstrip())), text.strip()


def _subtract(a: int, b: int, holes: list[tuple[int, int]]) -> list[tuple[int, int]]:
    out, cur = [], a
    for h0, h1 in holes:
        if h1 <= cur or h0 >= b:
            continue
        if h0 > cur:
            out.append((cur, h0))
        cur = max(cur, h1)
    if cur < b:
        out.append((cur, b))
    return out


def _trim_notes_tail(text: str, pieces: list[tuple[int, int]], hole_starts: set[int],
                     is_last: bool) -> list[tuple[int, int]]:
    """紧挨注释区（或文末）的那段去掉末尾的「## 注释」「---」与空行；只剩空白的段丢掉。"""
    out = []
    for k, (a, b) in enumerate(pieces):
        if b in hole_starts or (is_last and k == len(pieces) - 1):
            lines = text[a:b].split("\n")
            cut = len(lines)
            while cut > 1:
                t = lines[cut - 1].strip()
                if t == "" or t in ("---", "***", "___") or NOTES_HEADING_RE.match(t):
                    cut -= 1
                else:
                    break
            b = a + len("\n".join(lines[:cut]))
        if k == 0 or text[a:b].strip():
            out.append((a, b))
    return out


# ---------------------------------------------------------------- 书与 PDF

def frontmatter_pdf(doc_or_text) -> str | None:
    fm = doc_or_text.frontmatter if isinstance(doc_or_text, Doc) else (
        (FRONTMATTER_RE.match(doc_or_text) or [""])[0] if isinstance(doc_or_text, str) else "")
    m = re.search(r"^pdf:\s*(.+?)\s*$", fm, re.M)
    return _clean_link(m.group(1)) if m else None


def _clean_link(v: str) -> str:
    v = v.strip().strip("'\"")
    m = re.match(r"^!?\[\[(.+?)\]\]$", v)
    if m:
        v = m.group(1)
    v = v.split("|", 1)[0].split("#", 1)[0]
    return v.strip()


def vault_root(start: Path) -> Path | None:
    for d in [start, *start.parents]:
        if (d / ".obsidian").is_dir():
            return d
    return None


def book_dir_of(path: Path) -> Path:
    """书文件夹：md 所在文件夹或其上一级里带 _数据 的那个；都没有就是 md 所在文件夹。"""
    d = path if path.is_dir() else path.parent
    for c in (d, d.parent):
        if (c / "_数据").is_dir():
            return c
    return d


def read_book_json(book: Path) -> dict:
    p = book / "_数据" / "book.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
    return {}


def _resolve_name(name: str, bases: list[Path], vault: Path | None) -> Path | None:
    p = Path(name)
    if p.is_absolute() and p.exists():
        return p
    for b in bases:
        if (b / name).exists():
            return (b / name).resolve()
    if vault:
        if (vault / name).exists():
            return (vault / name).resolve()
        hits = [h for h in vault.rglob(Path(name).name) if ".obsidian" not in h.parts]
        if len(hits) == 1:
            return hits[0].resolve()
    return None


def locate_pdf(path: Path) -> tuple[Path | None, str]:
    """按 frontmatter pdf → _数据/book.json → 同文件夹唯一 PDF 的次序找原件。返回 (路径, 说明)。"""
    path = path.resolve()
    book = book_dir_of(path)
    md_dir = path if path.is_dir() else path.parent
    vault = vault_root(md_dir)
    bases = list(dict.fromkeys([md_dir, book, book.parent]))
    mds = [path] if path.is_file() else book_files(path)
    for md in mds:
        name = frontmatter_pdf(md.read_text(encoding="utf-8")) if md.exists() else None
        if name:
            hit = _resolve_name(name, [md.parent, *bases], vault)
            if hit:
                return hit, f"frontmatter pdf（{md.name}）"
            return None, f"frontmatter pdf 写的是 {name}，但找不到这个文件"
    bj = read_book_json(book)
    if isinstance(bj.get("pdf"), str):
        name = _clean_link(bj["pdf"])
        hit = _resolve_name(name, [book, book / "_数据", *bases], vault)
        if hit:
            return hit, "_数据/book.json"
    for d in (md_dir, book):
        pdfs = [p for p in d.glob("*.pdf") if not p.name.endswith(".文字层.pdf")]
        if len(pdfs) == 1:
            return pdfs[0].resolve(), f"{d.name} 文件夹里唯一的 PDF"
        if not pdfs:
            layer = list(d.glob("*.文字层.pdf"))
            if len(layer) == 1:
                return layer[0].resolve(), f"{d.name} 文件夹里唯一的文字层 PDF"
    return None, "frontmatter 没有 pdf、没有 _数据/book.json、文件夹里也不是唯一一个 PDF"


def printed_offset(book: Path) -> int | None:
    """book.json 的 printedPageOffset（物理页 = 印刷页 + 偏移），旧格式换算用。"""
    v = read_book_json(book).get("printedPageOffset")
    return v if isinstance(v, int) else None


def text_layer_pdf(pdf: Path) -> Path:
    """原件旁有「<原件>.文字层.pdf」就读它的文字。"""
    if pdf.name.endswith(".文字层.pdf"):
        return pdf
    cand = pdf.with_name(pdf.stem + ".文字层.pdf")
    return cand if cand.exists() else pdf


def book_files(path: Path) -> list[Path]:
    """书里带物理页锚点的 Markdown 文件，按 book.json 的文件列表或文件名排序。"""
    if path.is_file():
        return [path]
    book = book_dir_of(path)
    bj = read_book_json(book)
    files: list[Path] = []
    listed = bj.get("files")
    if isinstance(listed, list):
        for item in listed:
            rel = item.get("path") or item.get("file") if isinstance(item, dict) else item
            if isinstance(rel, str):
                p = (book / _clean_link(rel))
                if p.suffix != ".md":
                    p = p.with_suffix(p.suffix + ".md") if not p.exists() else p
                if p.exists():
                    files.append(p)
    if not files:
        files = sorted(p for p in path.glob("*.md") if not p.name.endswith(SIDECAR_SUFFIXES))
    legacy = printed_offset(book) is not None
    out = []
    for p in files:
        if p.name.endswith(SIDECAR_SUFFIXES):
            continue
        t = p.read_text(encoding="utf-8")
        if ANCHOR_RE.search(t) or (legacy and PRINTED_RE.search(t)):
            out.append(p)
    return out


# ---------------------------------------------------------------- PDF 后端

def _backend() -> str:
    want = os.environ.get("LUNZHU2MD_PDF_BACKEND", "").lower()
    if want in ("pymupdf", "fitz"):
        return "pymupdf"
    try:
        import pypdfium2  # noqa: F401
        return "pypdfium2"
    except ImportError:
        return "pymupdf"


def _open_pdfium(pdf: Path):
    import pypdfium2 as pdfium
    # 用字节打开，免得 Windows 上中文路径出问题
    return pdfium.PdfDocument(pdf.read_bytes())


def _open_mupdf(pdf: Path):
    try:
        import pymupdf
    except ImportError:  # 旧版只有 fitz
        import fitz as pymupdf  # type: ignore
    return pymupdf.open(stream=pdf.read_bytes(), filetype="pdf")


def pdf_page_count(pdf: Path) -> int:
    if _backend() == "pypdfium2":
        doc = _open_pdfium(pdf)
        try:
            return len(doc)
        finally:
            doc.close()
    doc = _open_mupdf(pdf)
    try:
        return doc.page_count
    finally:
        doc.close()


def render_page(pdf: Path, page: int, out: Path, dpi: int = 150) -> str:
    out.parent.mkdir(parents=True, exist_ok=True)
    if _backend() == "pypdfium2":
        doc = _open_pdfium(pdf)
        try:
            _check_page(page, len(doc))
            pg = doc[page - 1]
            img = pg.render(scale=dpi / 72).to_pil()
            img.save(out)
            pg.close()
        finally:
            doc.close()
        return "pypdfium2"
    doc = _open_mupdf(pdf)
    try:
        _check_page(page, doc.page_count)
        doc[page - 1].get_pixmap(dpi=dpi).save(str(out))
    finally:
        doc.close()
    return "pymupdf"


def page_text(pdf: Path, page: int) -> str:
    if _backend() == "pypdfium2":
        doc = _open_pdfium(pdf)
        try:
            _check_page(page, len(doc))
            pg = doc[page - 1]
            tp = pg.get_textpage()
            s = tp.get_text_bounded()
            tp.close()
            pg.close()
            return s.replace("\r\n", "\n").replace("\r", "\n")
        finally:
            doc.close()
    doc = _open_mupdf(pdf)
    try:
        _check_page(page, doc.page_count)
        return doc[page - 1].get_text()
    finally:
        doc.close()


def all_page_texts(pdf: Path) -> list[str]:
    out = []
    if _backend() == "pypdfium2":
        doc = _open_pdfium(pdf)
        try:
            for i in range(len(doc)):
                pg = doc[i]
                tp = pg.get_textpage()
                out.append(tp.get_text_bounded().replace("\r\n", "\n").replace("\r", "\n"))
                tp.close()
                pg.close()
        finally:
            doc.close()
        return out
    doc = _open_mupdf(pdf)
    try:
        return [pg.get_text() for pg in doc]
    finally:
        doc.close()


def _check_page(page: int, count: int) -> None:
    if not 1 <= page <= count:
        raise SystemExit(f"PDF 只有 {count} 页，没有第 {page} 页")


# <<< shared-core


# ---------------------------------------------------------------- 文字处理

_MD_STRIP = [
    (re.compile(r"<!--[\s\S]*?-->"), ""),
    (re.compile(r"\[\^[^\]\s]+\]:?"), ""),
    (re.compile(r"!\[[^\]]*\]\([^)]*\)"), ""),
    (re.compile(r"\[([^\]]*)\]\([^)]*\)"), r"\1"),
    (re.compile(r"<[^>\n]+>"), ""),
]
_KEEP_CATS = {"Lo", "Lu", "Ll", "Lt", "Lm", "Nd"}


def strip_md(s: str) -> str:
    for rx, rep in _MD_STRIP:
        s = rx.sub(rep, s)
    return s


def norm(s: str, digits: bool = True, md: bool = True) -> str:
    """只留文字与数字（先丢 ①¹ 这类「其他数字」，再 NFKC 统一全半角）。"""
    if md:
        s = strip_md(s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "No")
    s = unicodedata.normalize("NFKC", s)
    return "".join(ch for ch in s if unicodedata.category(ch) in _KEEP_CATS
                   and (digits or not ch.isdigit()))


SEVERITY_ZH = {"high": "高", "medium": "中", "low": "低", "info": "提示"}
SEVERITY_RANK = {"high": 3, "medium": 2, "low": 1, "info": 0}
CHECKS = {
    "anchor_missing": "锚点缺页",
    "anchor_duplicate": "锚点重复",
    "anchor_order": "锚点倒序",
    "anchor_uncovered": "PDF 页未覆盖",
    "anchor_format": "锚点格式",
    "anchor_seam": "锚点错位",
    "printed_page": "印刷页码",
    "page_chars": "每页字数",
    "footnote_ref_no_def": "注码无注文",
    "footnote_def_no_ref": "注文无注码",
    "footnote_duplicate": "注文重复定义",
    "footnote_gap": "注号跳号",
    "footnote_order": "注码次序",
    "footnote_page": "注文挂页",
    "footnote_no_anchor": "注文缺页锚点",
    "heading_level": "标题层级跳级",
    "heading_number": "标题跳号",
    "residual_tag": "残留标签",
    "latin_run": "长段拉丁文",
    "watermark": "知网等水印",
    "running_head": "页眉页脚混入",
    "superscript_merge": "上标并入",
    "bracket": "括号引号不成对",
    "repeat": "重复串",
    "table_count": "表格个数两家不同",
    "table_cross_page": "疑似跨页表",
}


@dataclass
class Issue:
    check: str
    severity: str
    message: str
    file: str | None = None
    page: int | None = None
    line: int | None = None
    snippet: str = ""
    evidence: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        d = asdict(self)
        d["check_name"] = CHECKS.get(self.check, self.check)
        return d


def _snip(s: str, n: int = 40) -> str:
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= n else s[:n] + "…"


# ---------------------------------------------------------------- 书

@dataclass
class Para:
    doc: Doc
    start: int
    text: str
    page: int | None
    line: int


@dataclass
class Book:
    root: Path
    docs: list[Doc]
    pdf: Path | None
    pdf_how: str
    page_count: int | None
    texts: dict[int, str]          # 文字层原文，键为物理页
    usable: set[int]               # 文字层可用的页
    heads: set[str]                # 页眉页脚候选（去数字的规范化串）
    body_texts: dict[int, str]     # 去掉页眉页脚后的规范化文字层

    def rel(self, p: Path) -> str:
        try:
            return str(p.resolve().relative_to(self.root.resolve()))
        except ValueError:
            return str(p)


def detect_running_heads(texts: dict[int, str]) -> set[str]:
    """各页头 3 行、尾 2 行里反复出现的行（去数字后比），当页眉页脚。"""
    cnt: Counter = Counter()
    for t in texts.values():
        lines = [ln for ln in t.split("\n") if ln.strip()]
        keys = {norm(ln, digits=False, md=False) for ln in lines[:3] + lines[-2:]}
        cnt.update(k for k in keys if len(k) >= 2)
    need = max(2, math.ceil(len(texts) * 0.2))
    return {k for k, c in cnt.items() if c >= need}


def page_body_norm(t: str, heads: set[str], digits: bool = True) -> str:
    lines = [ln for ln in t.split("\n") if ln.strip()]
    keep = []
    for i, ln in enumerate(lines):
        edge = i < 3 or i >= len(lines) - 2
        key = norm(ln, digits=False, md=False)
        if edge and (key in heads or (key == "" and re.fullmatch(r"\s*\d{1,4}\s*", ln))):
            continue
        keep.append(ln)
    return norm("\n".join(keep), digits=digits, md=False)


def load_book(path: Path, use_pdf: bool = True) -> Book:
    path = path.resolve()
    files = book_files(path)
    if not files and path.is_file():
        files = [path]
    root = book_dir_of(path)
    docs = [parse_doc(f) for f in files]
    mark_continuations(docs)
    pdf, how, count = None, "未使用 PDF（--no-pdf）", None
    texts: dict[int, str] = {}
    if use_pdf:
        pdf, how = locate_pdf(path)
        if pdf:
            raw = all_page_texts(text_layer_pdf(pdf))
            count = len(raw)
            texts = {i + 1: t for i, t in enumerate(raw)}
    usable = {p for p, t in texts.items() if len(norm(t, md=False)) >= 30}
    heads = detect_running_heads({p: texts[p] for p in usable}) if usable else set()
    body = {p: page_body_norm(texts[p], heads) for p in usable}
    return Book(root, docs, pdf, how, count, texts, usable, heads, body)


def paragraphs(doc: Doc) -> list[Para]:
    """正文段落（跨页的段算一段，脚注定义不算），页 = 段首所在页。"""
    fm_len = len(doc.frontmatter)
    holes = [(f.start, f.end) for f in doc.footnotes]
    body = doc.body_anchors
    out: list[Para] = []

    def page_at(off: int) -> int | None:
        cur = None
        for a in body:
            if a.start <= off:
                cur = a.page
            else:
                break
        return cur

    for a, b in _subtract(fm_len, len(doc.text), holes):
        pos = a
        for blk in re.split(r"(\n[ \t]*\n)", doc.text[a:b]):
            if blk.strip() and not re.fullmatch(r"\n[ \t]*\n", blk):
                lead = len(blk) - len(blk.lstrip())
                start = pos + lead
                out.append(Para(doc, start, blk.strip(), page_at(start), doc.line_of(start)))
            pos += len(blk)
    return out


def page_at(doc: Doc, off: int) -> int | None:
    cur = None
    for a in doc.body_anchors:
        if a.start <= off:
            cur = a.page
        else:
            break
    return cur


def _has_table(t: str) -> bool:
    return "<table" in t or bool(re.search(r"(?m)^\|[\s:-]+\|", t))


def _strip_tables(t: str) -> str:
    t = re.sub(r"<table[\s\S]*?</table>", "", t)
    return re.sub(r"(?m)^\|.*\|\s*$", "", t)


def is_heading(t: str) -> re.Match | None:
    """标题行（前面可以挂着锚点注释）。"""
    return re.match(r"^(?:<!--[^>]*-->\s*)*(#{1,6})\s+(.*)$", t)


def _is_table(t: str) -> bool:
    return t.lstrip().startswith(("<table", "|")) or "<table" in t[:200]


# ---------------------------------------------------------------- 各项检查

def check_anchors(book: Book) -> list[Issue]:
    issues: list[Issue] = []
    seq: list[tuple[int, Doc, Anchor]] = []
    # 新书（book.json version ≥ 2，或没有 book.json 的新导入）每页都要有锚点；旧笔记可以缺页
    bj = read_book_json(book.root)
    old = any(d.legacy for d in book.docs) or (bj and int(bj.get("version", 1) or 1) < 2)
    gap_sev = "low" if old else "high"
    cont = {(id(d), d.segments[0].start) for d in book.docs if d.segments and d.segments[0].continuation}
    for d in book.docs:
        if d.legacy:
            issues.append(Issue("anchor_format", "info",
                                "旧格式：只有 <!--p.M--> 印刷页锚点，物理页按 book.json 的 printedPageOffset 换算；"
                                "接缝、字数等按页的检查可能偏差，建议先补物理页锚点", book.rel(d.path)))
        for a in d.body_anchors:
            if (id(d), a.start) not in cont:  # 续页锚点不算重复、倒序
                seq.append((a.page, d, a))
        if not d.body_anchors:
            issues.append(Issue("anchor_missing", "high", "整个文件没有 <!--pdf-page.N--> 物理页锚点",
                                book.rel(d.path)))
    seen: dict[int, tuple[Doc, Anchor]] = {}
    for i, (p, d, a) in enumerate(seq):
        if p < 1:
            issues.append(Issue("anchor_format", "high", f"页码 {p} 不合法（从 1 起）", book.rel(d.path), p, a.line))
        if p in seen:
            d0, a0 = seen[p]
            issues.append(Issue("anchor_duplicate", "high",
                                f"第 {p} 页的锚点出现两次（另一个在 {book.rel(d0.path)} 行 {a0.line}）",
                                book.rel(d.path), p, a.line))
        else:
            seen[p] = (d, a)
        if i and p < seq[i - 1][0]:  # 扫描页序乱时允许局部倒序：只提示
            issues.append(Issue("anchor_order", "info",
                                f"第 {p} 页锚点排在第 {seq[i - 1][0]} 页之后（扫描页序乱时允许；若不是，请核对）",
                                book.rel(d.path), p, a.line))
    if seq:
        pages = [s[0] for s in seq]
        lo, hi = min(pages), max(pages)
        for p in range(lo, hi + 1):
            if p not in seen:
                prev = max((s for s in seq if s[0] < p), key=lambda s: s[0])
                issues.append(Issue("anchor_missing", gap_sev,
                                    f"缺第 {p} 页的锚点（这页的内容可能整页丢了，或并进了第 {prev[0]} 页）"
                                    + ("；旧笔记可以缺页" if old else ""),
                                    book.rel(prev[1].path), p, prev[2].line))
        if book.page_count:
            outside = [p for p in range(1, book.page_count + 1) if p < lo or p > hi]
            if outside:
                issues.append(Issue("anchor_uncovered", "low" if old else "medium",
                                    f"PDF 共 {book.page_count} 页，正文锚点只覆盖第 {lo}–{hi} 页；"
                                    f"{_ranges(outside)} 没有锚点（约定要求空白页、插图页也有锚点；"
                                    "单篇论文从期刊整本中截出时可忽略）",
                                    evidence={"pages": outside}))
            beyond = sorted({p for p in pages if p > book.page_count})
            if beyond:
                issues.append(Issue("anchor_format", "high",
                                    f"锚点页码超出 PDF 页数 {book.page_count}：{beyond}（PDF 配错了？）"))
    for d in book.docs:
        for m in re.finditer(r"<!--\s*pdf[-_ ]?page[^>]*-->", d.text):
            if not re.fullmatch(r"<!--pdf-page\.\d+-->", m.group(0)):
                issues.append(Issue("anchor_format", "low", f"锚点写法不规范：{m.group(0)}（应为 <!--pdf-page.N-->）",
                                    book.rel(d.path), None, d.line_of(m.start())))
    return issues


def _ranges(nums: list[int]) -> str:
    out, i = [], 0
    while i < len(nums):
        j = i
        while j + 1 < len(nums) and nums[j + 1] == nums[j] + 1:
            j += 1
        out.append(f"第 {nums[i]} 页" if i == j else f"第 {nums[i]}–{nums[j]} 页")
        i = j + 1
    return "、".join(out)


def check_printed(book: Book) -> list[Issue]:
    issues: list[Issue] = []
    rows = [(d, a) for d in book.docs for a in d.body_anchors]
    if not rows:
        return issues
    for d in book.docs:  # 每个物理页最多一个 <!--p.M-->，归它前面最近的物理页锚点
        for s in d.segments:
            labels = PRINTED_RE.findall(d.segment_text(s))
            if len(labels) > 1:
                issues.append(Issue("printed_page", "medium",
                                    f"第 {s.page} 页带了 {len(labels)} 个印刷页锚点：{'、'.join('p.' + x for x in labels)}",
                                    book.rel(d.path), s.page, s.line))
    no_label = [a.page for d, a in rows if a.printed is None]
    if no_label and len(no_label) < len(rows):
        issues.append(Issue("printed_page", "info", f"这些页没有印刷页锚点：{_ranges(sorted(no_label))}",
                            evidence={"pages": no_label}))
    num = [(d, a, int(a.printed) - a.page) for d, a in rows if a.printed and a.printed.isdigit()]
    for i in range(1, len(num) - 1):
        (_, _, o0), (d, a, o), (_, _, o2) = num[i - 1], num[i], num[i + 1]
        if o0 == o2 and o != o0:
            issues.append(Issue("printed_page", "low",
                                f"印刷页 p.{a.printed} 疑误：前后页的「印刷页 − 物理页」都是 {o0}，这页是 {o}",
                                book.rel(d.path), a.page, a.line))
    for i in range(1, len(num)):
        if int(num[i][1].printed) <= int(num[i - 1][1].printed) and num[i][1].page > num[i - 1][1].page:
            d, a, _ = num[i]
            issues.append(Issue("printed_page", "low",
                                f"印刷页 p.{a.printed} 不大于上一页的 p.{num[i - 1][1].printed}",
                                book.rel(d.path), a.page, a.line))
    return issues


def md_page_chars(book: Book) -> dict[int, int]:
    chars: dict[int, int] = defaultdict(int)
    for prev, d in zip(book.docs, book.docs[1:]):
        if prev.segments:  # 一页拆到两个文件时，后一个文件锚点前的部分算上一文件的最后一页
            chars[prev.segments[-1].page] += len(norm(lead_text(d)[1]))
    for d in book.docs:
        for s in d.segments:
            chars[s.page] += len(norm(d.segment_text(s)))
        for f in d.footnotes:
            for p in f.pages:
                chars[p] += len(norm(footnote_part_text(d, f, p)))
    return dict(chars)


def check_page_chars(book: Book, chars: dict[int, int]) -> tuple[list[Issue], dict]:
    issues: list[Issue] = []
    table = {}
    loc = {s.page: (d, s) for d in book.docs for s in d.segments}
    for p in sorted(chars):
        md = chars[p]
        row = {"md": md}
        if p in book.usable:
            pdf = len(book.body_texts[p])
            row.update(pdf=pdf, ratio=round(md / pdf, 3) if pdf else None)
            diff = md - pdf
            ratio = md / pdf if pdf else 0
            if pdf and abs(diff) >= 40 and abs(1 - ratio) >= 0.06:
                sev = "high" if abs(1 - ratio) >= 0.15 else "medium"
                first_of_file = any(d.segments and d.segments[0].page == p for d in book.docs)
                if first_of_file and diff < 0:
                    sev = "low"  # 首页的刊头、收稿日期、作者简介常移进 frontmatter
                d, s = loc.get(p, (None, None))
                has_table = d is not None and _has_table(d.segment_text(s))
                if has_table and diff > 0:
                    sev = "low"  # 文字层常不含表格里的字
                what = "少" if diff < 0 else "多"
                issues.append(Issue("page_chars", sev,
                                    f"正文比文字层{what} {abs(diff)} 字（{md}/{pdf}，{ratio:.0%}）"
                                    + ("：可能丢段、丢注或丢表" if diff < 0 else
                                       "：本页有表格，文字层多半不含表格文字" if has_table else
                                       "：可能有重复、页眉混入或锚点错位"),
                                    book.rel(d.path) if d else None, p, s.line if s else None,
                                    evidence={"md_chars": md, "pdf_chars": pdf}))
        table[p] = row
    no_layer = [p for p in chars if p not in book.usable]
    if len(no_layer) >= 3:
        vals = [chars[p] for p in no_layer]
        med = statistics.median(vals)
        ends = {min(chars), max(chars)}
        for p in no_layer:
            table[p]["median"] = med
            if p in ends or med == 0:
                continue
            r = chars[p] / med
            if r < 0.5 or r > 1.6:
                d, s = loc.get(p, (None, None))
                issues.append(Issue("page_chars", "medium" if r < 0.35 or r > 2 else "low",
                                    f"本页 {chars[p]} 字，是全书每页中位数 {med:.0f} 的 {r:.0%}"
                                    "（没有可用文字层，只能和中位数比；章首、图表页偏少属正常）",
                                    book.rel(d.path) if d else None, p, s.line if s else None,
                                    evidence={"md_chars": chars[p], "median": med}))
    return issues, table


def check_seams(book: Book) -> list[Issue]:
    """锚点后的头几个字应在文字层本页开头；出现在上一页或下一页就是锚点错位。"""
    issues: list[Issue] = []
    if not book.usable:
        return issues
    plain = {p: page_body_norm(book.texts[p], book.heads, digits=False) for p in book.usable}
    for d in book.docs:
        for s in d.segments:
            body = norm(d.segment_text(s), digits=False)
            p = s.page
            if p not in plain or len(body) < 10:
                continue
            head, tail = body[:12], body[-12:]
            if s.continuation:  # 续页锚点后接的是本页中段，不查开头
                head = ""
            pos = plain[p].find(head) if head else 0
            if pos < 0:
                pos = plain[p].find(head[:8])
            if pos < 0:
                for q, word in ((p - 1, "早"), (p + 1, "晚")):
                    if q in plain and plain[q].find(head[:8]) >= 0:
                        issues.append(Issue("anchor_seam", "high",
                                            f"第 {p} 页锚点疑似放{word}了：锚点后的「{_snip(head, 12)}」在文字层第 {q} 页（请对照原图）",
                                            book.rel(d.path), p, s.line, evidence={"found_on": q}))
                        break
            elif pos > max(80, 0.2 * len(plain[p])):
                issues.append(Issue("anchor_seam", "medium",
                                    f"第 {p} 页锚点可能偏后：锚点后的字在文字层本页第 {pos} 字处（共 {len(plain[p])} 字）",
                                    book.rel(d.path), p, s.line, evidence={"pos": pos}))
            if plain[p].find(tail) < 0 and plain[p].find(tail[-8:]) < 0:
                q = p + 1
                if q in plain and plain[q].find(tail[-8:]) >= 0:
                    issues.append(Issue("anchor_seam", "high",
                                        f"第 {p} 页段末的「{_snip(tail, 12)}」在文字层第 {q} 页：第 {q} 页锚点疑似放晚了（请对照原图）",
                                        book.rel(d.path), p, s.end_line, evidence={"found_on": q}))
    return issues


def check_cross_page_notes(book: Book) -> list[Issue]:
    """注文末尾的字在文字层下一页而不在本页：注文跨页，可补续页锚点（可选）。"""
    issues: list[Issue] = []
    if not book.usable:
        return issues
    plain = {p: page_body_norm(book.texts[p], book.heads, digits=False) for p in book.usable}
    for d in book.docs:
        for f in d.footnotes:
            if len(f.pages) != 1 or f.page not in plain or f.page + 1 not in plain:
                continue
            t = norm(f.text, digits=False)
            if len(t) < 20:
                continue
            tail = t[-10:]
            if tail not in plain[f.page] and tail in plain[f.page + 1]:
                issues.append(Issue("footnote_page", "low",
                                    f"注文 [^{f.label}] 续到了第 {f.page + 1} 页（末尾的字在文字层第 {f.page + 1} 页）："
                                    "可按 lunzhu2md-fix 的做法在接缝处补续页锚点（可选，需用户同意）",
                                    book.rel(d.path), f.page, f.line, _snip(f.text)))
    return issues


def check_footnotes(book: Book) -> list[Issue]:
    issues: list[Issue] = []
    for d in book.docs:
        f = book.rel(d.path)
        paras = paragraphs(d)
        refs: list[tuple[str, Para]] = []
        for pa in paras:
            for m in FN_REF_RE.finditer(pa.text):  # 注码所在页按注码本身的位置算（段落可能跨页）
                off = pa.start + m.start()
                refs.append((m.group(1), Para(d, off, pa.text, page_at(d, off), d.line_of(off))))
        defs: dict[str, list[FootnoteDef]] = defaultdict(list)
        for fd in d.footnotes:
            defs[fd.label].append(fd)
        ref_labels = {lab for lab, _ in refs}
        first_ref: dict[str, Para] = {}
        for lab, pa in refs:
            first_ref.setdefault(lab, pa)
        for lab, pa in first_ref.items():
            if lab not in defs:
                issues.append(Issue("footnote_ref_no_def", "high", f"正文有注码 [^{lab}]，找不到注文",
                                    f, pa.page, pa.line, _snip(pa.text)))
        for lab, fds in defs.items():
            if lab not in ref_labels:
                issues.append(Issue("footnote_def_no_ref", "medium", f"注文 [^{lab}] 在正文里找不到注码",
                                    f, fds[0].page, fds[0].line, _snip(fds[0].text)))
            if len(fds) > 1:
                issues.append(Issue("footnote_duplicate", "high", f"注文 [^{lab}] 定义了 {len(fds)} 次",
                                    f, fds[1].page, fds[1].line, _snip(fds[1].text)))
            for fd in fds:
                if fd.page is None:
                    issues.append(Issue("footnote_no_anchor", "medium", f"注文 [^{lab}] 没有 <!--pdf-page.N--> 锚点",
                                        f, None, fd.line, _snip(fd.text)))
                elif lab in first_ref and first_ref[lab].page is not None and fd.page != first_ref[lab].page:
                    issues.append(Issue("footnote_page", "low",
                                        f"注文 [^{lab}] 挂在第 {fd.page} 页，注码在第 {first_ref[lab].page} 页",
                                        f, first_ref[lab].page, fd.line, _snip(fd.text)))
        nums = sorted({int(x) for x in ref_labels | set(defs) if x.isdigit()})
        if nums:
            have = set(nums)
            for n in range(nums[0], nums[-1] + 1):
                if n not in have:
                    nxt = next((x for x in nums if x > n), None)
                    pa = first_ref.get(str(nxt)) if nxt else None
                    issues.append(Issue("footnote_gap", "high", f"注号跳号：没有 [^{n}]（注码和注文都不见了）",
                                        f, pa.page if pa else None, pa.line if pa else None))
        order = [int(lab) for lab in first_ref if lab.isdigit()]
        for i in range(1, len(order)):
            if order[i] < order[i - 1]:
                pa = first_ref[str(order[i])]
                issues.append(Issue("footnote_order", "low", f"注码 [^{order[i]}] 出现在 [^{order[i - 1]}] 之后",
                                    f, pa.page, pa.line, _snip(pa.text)))
    return issues


_CN = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def cn_int(s: str) -> int | None:
    """一到九十九的中文数字（标题编号够用）；阿拉伯数字直接转。"""
    s = unicodedata.normalize("NFKC", s)
    if s.isdigit():
        return int(s)
    if s == "十":
        return 10
    if "百" in s or not s:
        return None
    if "十" in s:
        a, _, b = s.partition("十")
        tens = _CN.get(a, None) if a else 1
        ones = _CN.get(b, None) if b else 0
        return None if tens is None or ones is None else tens * 10 + ones
    if len(s) == 1:
        return _CN.get(s)
    return None


_HEADING_NUM = [
    ("第X章", re.compile(r"^第([一二三四五六七八九十两\d]+)([章节编部卷篇讲课回])")),
    ("X、", re.compile(r"^([一二三四五六七八九十]+)[、．.]")),
    ("（X）", re.compile(r"^[（(]([一二三四五六七八九十]+)[）)]")),
    ("n.n", re.compile(r"^(\d+(?:\.\d+)+)\s")),
    ("n、", re.compile(r"^(\d+)[、．.](?!\d)")),
    ("（n）", re.compile(r"^[（(](\d+)[）)]")),
]


_RANK = {"章": 0, "编": 0, "部": 0, "卷": 0, "篇": 0, "节": 1, "讲": 1, "课": 1, "回": 1}
_STYLE_RANK = {"X、": 2, "（X）": 3, "n、": 4, "（n）": 5, "n.n": 4}


def _style_rank(title: str) -> int | None:
    for style, rx in _HEADING_NUM:
        hm = rx.match(title)
        if hm:
            return _RANK.get(hm.group(2), 1) if style == "第X章" else _STYLE_RANK[style]
    return None


def _key_rank(key: tuple) -> int:
    style = key[1]
    if style.startswith("第X章"):
        return _RANK.get(style[-1], 1)
    return _STYLE_RANK.get(style, 9)


def check_headings(book: Book) -> list[Issue]:
    issues: list[Issue] = []
    last_level = None
    counters: dict[tuple, tuple[int, str, int | None]] = {}
    for d in book.docs:
        for pa in paragraphs(d):
            m = is_heading(pa.text.split("\n", 1)[0])
            if not m:
                continue
            level, title = len(m.group(1)), m.group(2).strip()
            if last_level is not None and level > last_level + 1:
                issues.append(Issue("heading_level", "low", f"标题从 {'#' * last_level} 跳到 {'#' * level}",
                                    book.rel(d.path), pa.page, pa.line, title))
            last_level = level
            for k in [k for k in counters if k[0] > level]:
                del counters[k]
            rank = _style_rank(title)
            if rank is not None:
                for k in [k for k in counters if _key_rank(k) > rank]:
                    del counters[k]
            elif not NOTES_HEADING_RE.match(title):
                # 不带编号的同级标题（附录、结语等）之后编号重新起算
                for k in [k for k in counters if k[0] >= level]:
                    del counters[k]
            for style, rx in _HEADING_NUM:
                hm = rx.match(title)
                if not hm:
                    continue
                if style == "n.n":
                    parts = [int(x) for x in hm.group(1).split(".")]
                    key, n = (level, style, tuple(parts[:-1])), parts[-1]
                else:
                    n = cn_int(hm.group(1))
                    key = (level, style + (hm.group(2) if style == "第X章" else ""))
                if n is None:
                    break
                prev = counters.get(key)
                if prev and n != prev[0] + 1:
                    gap = "重复" if n == prev[0] else (
                        f"疑缺 {n - prev[0] - 1} 个，到第 {prev[2]}–{pa.page} 页之间找" if n > prev[0] else "倒退")
                    issues.append(Issue("heading_number", "high" if n > prev[0] + 1 else "medium",
                                        f"标题编号跳号：「{prev[1]}」之后是「{title}」，{gap}",
                                        book.rel(d.path), pa.page, pa.line, title,
                                        evidence={"prev_page": prev[2]}))
                counters[key] = (n, title, pa.page)
                break
    return issues


_RESIDUAL = [
    (re.compile(r"<(?:div|span|p|html|body|img|font|center|section|figure)\b[^>]*>", re.I), "medium", "HTML 标签"),
    (re.compile(r"<!--(?!\s*pdf-page\.\d+\s*-->)(?!\s*p\.[^\s>-][^\s>]*?\s*-->)[\s\S]{0,80}?-->"), "low", "非锚点的注释"),
    (re.compile(r"\$\^\{?[^$\n]{1,8}?\}?\$"), "medium", "公式写法的上标（多半是注码或上标没转好）"),
    (re.compile(r"\\(?:textcircled|circled|mathrm|text|left|right|frac|cdot|quad)\b"), "low", "LaTeX 命令"),
    (re.compile(r"<\|[^|>\n]{1,40}\|>"), "medium", "模型输出的特殊记号"),
    (re.compile(r"<(?:fcel|ecel|lcel|ucel|xcel|nl|otsl|loc_\d+)>"), "medium", "表格结构记号（OTSL）"),
    (re.compile(r"^\s*(?:page_(?:header|footer|number)|abandon|image_caption|table_caption|"
                r"table_footnote|ref_text|aside_text|page_footnote)\s*$", re.M), "medium", "版面块类型名"),
    (re.compile(r"&(?:nbsp|amp|lt|gt|quot|#\d+);"), "low", "HTML 实体"),
    (re.compile(r"\\n"), "low", "字面的 \\n"),
]


def check_residual(book: Book) -> list[Issue]:
    issues: list[Issue] = []
    for d in book.docs:
        units = [(pa.text, pa.page, pa.line) for pa in paragraphs(d)] + \
                [(fd.text, fd.page, fd.line) for fd in d.footnotes]
        for text, page, line in units:
            for rx, sev, what in _RESIDUAL:
                for m in rx.finditer(text):
                    issues.append(Issue("residual_tag", sev, f"残留{what}：{_snip(m.group(0), 30)}",
                                        book.rel(d.path), page, line + text.count("\n", 0, m.start()),
                                        _snip(text[max(0, m.start() - 15):m.end() + 15])))
    return issues


_LATIN_RUN = re.compile(r"[A-Za-z][A-Za-z0-9 ,.;:'’\"“”()&/\-]{79,}")


def check_latin(book: Book) -> list[Issue]:
    issues: list[Issue] = []
    for d in book.docs:
        english_section = False
        for pa in paragraphs(d):
            m = is_heading(pa.text)
            if m:
                t = m.group(2)
                english_section = len(re.findall(r"[A-Za-z]", t)) > len(t) * 0.6
                continue
            for lm in _LATIN_RUN.finditer(pa.text):
                if len(re.findall(r"[A-Za-z]", lm.group(0))) < 40:
                    continue
                abstract = english_section or re.match(r"^(?:Abstract|Key ?words|Summary)\b", pa.text, re.I)
                issues.append(Issue("latin_run", "info" if abstract else "low",
                                    ("英文摘要或英文段，一般无需处理" if abstract else
                                     f"长段拉丁文 {len(lm.group(0))} 字：外文引文、英文摘要，或把中文认成了乱码"),
                                    book.rel(d.path), pa.page, pa.line, _snip(lm.group(0))))
                break
    return issues


_WATERMARK = re.compile(
    r"China Academic Journal Electronic Publishing House|\(C\)\s*1994-20\d\d|©\s*1994-20\d\d|"
    r"cnki\.net|中国知网|网络首发(?:时间|地址)|万方数据|wanfangdata|维普资讯|cqvip\.com|"
    r"All rights reserved\.?\s*http", re.I)
_ISSUE_LINE = re.compile(r"^(?:第\s*\d+\s*卷\s*)?第\s*\d+\s*期$|^\d{4}\s*年\s*第\s*\d+\s*期$|"
                         r"^Vol\.?\s*\d+\s*,?\s*No\.?\s*\d+$", re.I)


_HEADISH = re.compile(r"第\s*\d+\s*[卷期]|\d{4}\s*年\s*(?:第\s*\d+\s*期|\d{1,2}\s*月)?$|学报|Journal", re.I)
_EDGE_NUM = re.compile(r"^\d{1,4}\s|\s\d{1,4}$")


def check_watermark_and_heads(book: Book) -> list[Issue]:
    issues: list[Issue] = []
    heads = sorted(book.heads, key=len, reverse=True)
    for d in book.docs:
        f = book.rel(d.path)
        paras = paragraphs(d)
        for text, page, line in [(pa.text, pa.page, pa.line) for pa in paras] + \
                                [(fd.text, fd.page, fd.line) for fd in d.footnotes]:
            for m in _WATERMARK.finditer(text):
                issues.append(Issue("watermark", "high", f"疑似知网等数据库水印：{_snip(m.group(0), 30)}（对照原图确认后再删）",
                                    f, page, line + text.count("\n", 0, m.start()),
                                    _snip(text[max(0, m.start() - 15):m.end() + 15])))
        short_counts = Counter(norm(pa.text, digits=False) for pa in paras
                               if len(pa.text) <= 30 and not is_heading(pa.text))
        for pa in paras:
            if is_heading(pa.text) or _is_table(pa.text):
                continue
            raw = strip_md(pa.text).strip()
            key = norm(pa.text, digits=False)
            if re.fullmatch(r"\d{1,4}", raw):
                issues.append(Issue("running_head", "medium", f"孤立的页码行「{raw}」", f, pa.page, pa.line, raw))
                continue
            rest, hit = key, False
            for h in heads:
                if h and h in rest:
                    rest, hit = rest.replace(h, ""), True
            if hit and len(rest) <= max(2, len(key) * 0.2):
                issues.append(Issue("running_head", "high", f"疑似整行页眉页脚：「{_snip(raw, 30)}」（对照原图确认后再删）",
                                    f, pa.page, pa.line, raw))
                continue
            if _ISSUE_LINE.match(raw) or (len(raw) <= 40 and _HEADISH.search(raw) and _EDGE_NUM.search(raw)):
                issues.append(Issue("running_head", "medium", f"疑似刊期页眉「{raw}」", f, pa.page, pa.line, raw))
                continue
            if hit:
                for h in heads:
                    if len(h) >= 4 and (key.startswith(h) or key.endswith(h)):
                        issues.append(Issue("running_head", "low", f"段首或段尾混着页眉「{h}」（也可能只是正文提到书名）",
                                            f, pa.page, pa.line, _snip(raw)))
                        break
            if not book.heads and len(raw) <= 30 and key and short_counts[key] >= 3:
                issues.append(Issue("running_head", "low",
                                    f"短行「{raw}」在正文里出现 {short_counts[key]} 次，疑似页眉页脚",
                                    f, pa.page, pa.line, raw))
        # 锚点接缝处：页眉常混在新一页开头
        for s in d.segments:
            if s.page not in book.usable:
                continue  # 书名页、空白页：文字层没几个字，书名作者本来就印在页首，与页眉同字不算
            first_block = re.sub(r"<!--[\s\S]*?-->", "", d.segment_text(s)).strip()
            if is_heading(first_block.split("\n", 1)[0]):
                continue  # 书名、章名作标题时与页眉同字，不算
            head = norm(d.segment_text(s)[:120], digits=False)
            for h in heads:
                if len(h) >= 4 and head.startswith(h):
                    issues.append(Issue("running_head", "high", f"第 {s.page} 页开头混着页眉「{h}」",
                                        f, s.page, s.line, _snip(d.segment_text(s))))
                    break
    return _dedupe(issues)


def _dedupe(issues: list[Issue]) -> list[Issue]:
    seen, out = set(), []
    for i in issues:
        k = (i.check, i.file, i.line, i.message)
        if k not in seen:
            seen.add(k)
            out.append(i)
    return out


_NUM_CTX_BEFORE = "年月日第卷期页号简册条章节版次届岁里人户石斤钱元"


def check_superscript(book: Book) -> list[Issue]:
    """正文里的数字串文字层没有、去掉末一两位却有了 → 上标注码并进了数字（10¹ → 101）。"""
    issues: list[Issue] = []
    for d in book.docs:
        f = book.rel(d.path)
        for s in d.segments:
            p = s.page
            seg = _strip_tables(d.segment_text(s))
            if p in book.usable:
                nums: set[str] = set()
                for q in (p - 1, p, p + 1):  # 连上下页一起认，锚点略有错位时不误报
                    raw = book.texts.get(q, "")
                    nums |= set(re.findall(r"\d+", raw)) | set(re.findall(r"\d+", re.sub(r"\s+", "", raw)))
                for m in re.finditer(r"(?<![\d.])\d{2,}(?![\d.])", strip_md(seg)):
                    n = m.group(0)
                    if n in nums:
                        continue
                    for k in (1, 2):
                        if len(n) - k >= 1 and n[:-k] in nums and n[-k:] in nums:
                            line = s.line + strip_md(seg)[:m.start()].count("\n")
                            issues.append(Issue("superscript_merge", "medium",
                                                f"「{n}」文字层里没有，有「{n[:-k]}」：疑似上标 {n[-k:]} 并进了数字",
                                                f, p, line, _snip(strip_md(seg)[max(0, m.start() - 12):m.end() + 8])))
                            break
            else:
                text = strip_md(seg)
                for m in re.finditer(r"(?<=[\u4e00-\u9fff》”）])(\d{2,3})(?=[，。；：、！？])", text):
                    if text[m.start() - 1] in _NUM_CTX_BEFORE:
                        continue
                    issues.append(Issue("superscript_merge", "low",
                                        f"汉字后紧跟「{m.group(1)}」再接标点，可能是上标注码并进了正文（没有文字层，只是猜）",
                                        f, p, s.line + text[:m.start()].count("\n"),
                                        _snip(text[max(0, m.start() - 12):m.end() + 6])))
    return issues


_PAIRS = [("（", "）"), ("(", ")"), ("【", "】"), ("[", "]"), ("《", "》"), ("〈", "〉"),
          ("“", "”"), ("‘", "’"), ("「", "」"), ("『", "』")]


def bracket_problems(text: str) -> list[str]:
    t = strip_md(text)
    t = re.sub(r"(?<=[A-Za-z])’(?=[A-Za-z])", "", t)          # 英文撇号
    t = re.sub(r"(?m)^\s*(?:\d+|[a-zA-Z]|[一二三四五六七八九十]+)[)）]", "", t)  # 「1）」式编号
    out = []
    for o, c in _PAIRS:
        no, nc = t.count(o), t.count(c)
        if no != nc:
            out.append(f"{o}{c} 开 {no} 闭 {nc}")
    return out


def check_brackets(book: Book) -> list[Issue]:
    issues: list[Issue] = []
    for d in book.docs:
        units = [(pa.text, pa.page, pa.line, "body") for pa in paragraphs(d) if not _is_table(pa.text)] + \
                [(fd.text, fd.page, fd.line, "note") for fd in d.footnotes]
        for text, page, line, kind in units:
            probs = bracket_problems(text)
            if probs:
                only_quotes = all(p[0] in "“‘" for p in probs)
                issues.append(Issue("bracket", "low" if only_quotes else "medium",
                                    ("注文" if kind == "note" else "段内") + "括号或引号不成对：" + "；".join(probs)
                                    + ("（多段连引时前段只开不闭属正常）" if only_quotes else ""),
                                    book.rel(d.path), page, line, _snip(text)))
    return issues


def check_repeats(book: Book) -> list[Issue]:
    issues: list[Issue] = []
    for d in book.docs:
        f = book.rel(d.path)
        paras = [pa for pa in paragraphs(d) if not is_heading(pa.text) and not _is_table(pa.text)]
        keys = [norm(pa.text) for pa in paras]
        first: dict[str, Para] = {}
        for pa, k in zip(paras, keys):
            if len(k) >= 20:
                if k in first:
                    a = first[k]
                    near = a.page is None or pa.page is None or abs(pa.page - a.page) <= 1
                    issues.append(Issue("repeat", "high" if near else "low",
                                        f"整段重复（与行 {a.line} 那段相同"
                                        + ("）" if near else f"，在第 {a.page} 页；相隔较远，多半是作者重复引用）"),
                                        f, pa.page, pa.line, _snip(pa.text)))
                else:
                    first[k] = pa
        for pa, k in zip(paras, keys):
            if len(k) > 4000:
                continue
            m = re.search(r"(.{10,}?)\1", k)
            if m:
                issues.append(Issue("repeat", "medium", f"段内同一串连写两遍：「{_snip(m.group(1), 20)}」",
                                    f, pa.page, pa.line, _snip(pa.text)))
        # 同页或相邻页的两段有 20 字以上相同：段 a 取全部 20 字片，段 b 每隔 5 字取一片去碰
        by_page: dict[int | None, list[int]] = defaultdict(list)
        grams: dict[int, set[str]] = {}
        for i, (pa, k) in enumerate(zip(paras, keys)):
            dup = k in first and first[k] is not pa
            if pa.page is not None and not dup and len(k) >= 20:
                for j in by_page[pa.page - 1] + by_page[pa.page]:
                    if j not in grams:
                        grams[j] = {keys[j][x:x + 20] for x in range(len(keys[j]) - 19)}
                    hit = next((k[x:x + 20] for x in range(0, len(k) - 19, 5) if k[x:x + 20] in grams[j]), None)
                    if hit:
                        issues.append(Issue("repeat", "low",
                                            f"与行 {paras[j].line} 那段有 20 字以上相同：「{_snip(hit, 20)}」"
                                            "（接缝处重复识别，或作者重复引用）",
                                            f, pa.page, pa.line, _snip(pa.text)))
                        break
                by_page[pa.page].append(i)
    return issues


# ---------------------------------------------------------------- 导入报告里的表格页

TABLE_COUNT_MD_RE = re.compile(r"表格个数：MinerU\s*(\d+)\s*[，,]\s*VL\s*(\d+)")
PDF_PAGE_HEAD_RE = re.compile(r"^##\s*PDF\s*第\s*(\d+)\s*页")
BUILD_TABLE_RE = re.compile(r"^\s*PDF\s*第\s*(\d+)\s*页\s*$")


def _read_json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def import_table_pages(root: Path) -> tuple[dict[int, str], dict[int, list[str]]]:
    """读导入时的报告，返回 ({页: 「MinerU x，VL y」}, {页: [出处]})：
    冲突清单里「表格个数」对不上的页；构建报告、文字层分配表里「疑似跨页表」的页。

    只读文件、不判断：这两类页表格最容易出错（行列错、续表并错页），抽检必须看图。"""
    data = root / "_数据"
    counts: dict[int, str] = {}
    conflicts = _read_json(data / "冲突清单" / "conflicts.json")
    if isinstance(conflicts, dict):
        for it in conflicts.get("items") or []:
            if it.get("kind") == "table" and isinstance(it.get("page"), int):
                counts[it["page"]] = f"MinerU {it.get('md')}，VL {it.get('vl')}"
    else:
        md = data / "冲突清单" / "冲突清单.md"
        if md.exists():
            page = None
            for ln in md.read_text(encoding="utf-8").splitlines():
                h = PDF_PAGE_HEAD_RE.match(ln)
                if h:
                    page = int(h.group(1))
                    continue
                m = TABLE_COUNT_MD_RE.search(ln)
                if m and page is not None:
                    counts[page] = f"MinerU {m.group(1)}，VL {m.group(2)}"
    cross: dict[int, list[str]] = defaultdict(list)
    build = data / "过程报告" / "_build_report.txt"
    if build.exists():
        inside = False
        for ln in build.read_text(encoding="utf-8").splitlines():
            if ln.startswith("## "):
                inside = "疑似跨页表" in ln
                continue
            m = BUILD_TABLE_RE.match(ln) if inside else None
            if m:
                cross[int(m.group(1))].append("构建报告")
    assignment = _read_json(data / "文字层" / "assignment.json")
    if isinstance(assignment, dict):
        for t in assignment.get("crossPageTables") or []:
            if isinstance(t.get("page"), int) and "文字层报告" not in cross[t["page"]]:
                cross[t["page"]].append("文字层报告")
    return counts, dict(cross)


def check_import_tables(book: Book) -> list[Issue]:
    counts, cross = import_table_pages(book.root)
    issues = [Issue("table_count", "medium", f"导入时两家识别的表格个数不同（{v}）：对图核表格有无、行列",
                    page=p, evidence={"source": "冲突清单"}) for p, v in sorted(counts.items())]
    issues += [Issue("table_cross_page", "medium", "导入时报了疑似跨页表：对两页原图核续表归属与本页锚点位置",
                     page=p, evidence={"source": src}) for p, src in sorted(cross.items())]
    return issues


# ---------------------------------------------------------------- 抽查页

def page_features(book: Book) -> dict[int, dict]:
    feats: dict[int, dict] = defaultdict(lambda: {"headings": [], "tables": 0, "figures": 0, "notes": 0,
                                                  "toc": False, "file": None})
    for d in book.docs:
        for s in d.segments:
            ft = feats[s.page]
            ft["file"] = ft["file"] or str(d.path)
            text = d.segment_text(s)
            for ln in text.split("\n"):
                m = is_heading(ln.strip())
                if m:
                    ft["headings"].append((len(m.group(1)), m.group(2).strip()))
                    if re.fullmatch(r"目\s*录|目\s*次|contents", m.group(2).strip(), re.I):
                        ft["toc"] = True
            ft["tables"] += text.count("<table") + len(re.findall(r"(?m)^\|[\s:-]+\|", text))
            ft["figures"] += len(re.findall(r"!\[[^\]]*\]\(", text)) + len(re.findall(r"!\[\[", text))
            if len(re.findall(r"(?m)\S.*?[.…·]{4,}\s*\d+\s*$", text)) >= 5:
                ft["toc"] = True
        for fd in d.footnotes:
            if fd.page is not None:
                feats[fd.page]["notes"] += 1
    return feats


def suggest_pages(book: Book, issues: list[Issue], n: int | None, seed: int) -> dict:
    feats = page_features(book)
    pages = sorted(feats)
    if not pages:
        return {"risk": [], "structural": [], "random": [], "sample_size": 0}
    if n is None:
        n = min(len(pages), max(10, math.ceil(len(pages) * 0.05)))
    risk: dict[int, list[str]] = defaultdict(list)
    for i in issues:
        if i.page is not None and SEVERITY_RANK[i.severity] >= 2:
            risk[i.page].append(CHECKS.get(i.check, i.check))
    structural: dict[int, list[str]] = defaultdict(list)
    note_counts = sorted((feats[p]["notes"] for p in pages), reverse=True)
    note_cut = note_counts[max(0, len(note_counts) // 10 - 1)] if note_counts else 0
    for p in pages:
        ft = feats[p]
        if ft["toc"]:
            structural[p].append("目录")
        if any(lv <= 2 for lv, _ in ft["headings"]):
            structural[p].append("章首")
        if ft["tables"]:
            structural[p].append("表格")
        if ft["figures"]:
            structural[p].append("图片")
        if ft["notes"] >= max(3, note_cut) and ft["notes"]:
            structural[p].append(f"注多（{ft['notes']} 条）")
    structural_pages = [p for p in pages if structural[p] and p not in risk]
    # 结构页太多时按种类轮流挑，最多占样本一半
    cap = max(1, n // 2)
    picked_struct: list[int] = []
    for kind in ("目录", "表格", "图片", "章首", "注多"):
        for p in structural_pages:
            if len(picked_struct) >= cap:
                break
            if p not in picked_struct and any(r.startswith(kind) for r in structural[p]):
                picked_struct.append(p)
                break
    for p in structural_pages:
        if len(picked_struct) >= cap:
            break
        if p not in picked_struct:
            picked_struct.append(p)
    rest = [p for p in pages if p not in risk and p not in picked_struct]
    rng = random.Random(seed)
    k = max(0, min(len(rest), n - len(picked_struct)))
    rand = sorted(rng.sample(rest, k)) if k else []
    files = {p: feats[p]["file"] for p in pages}
    return {
        "sample_size": n,
        "risk": [{"page": p, "file": book.rel(Path(files[p])) if files.get(p) else None,
                  "reasons": sorted(set(risk[p]))} for p in sorted(risk)],
        "structural": [{"page": p, "file": book.rel(Path(files[p])), "reasons": structural[p]}
                       for p in sorted(picked_struct)],
        "random": [{"page": p, "file": book.rel(Path(files[p]))} for p in rand],
        "random_seed": seed,
        "random_bound": round(3 / len(rand), 3) if rand else None,
    }


# ---------------------------------------------------------------- 初筛总控与报告

def scan(path: Path, use_pdf: bool = True, sample: int | None = None, seed: int = 1012) -> dict:
    book = load_book(path, use_pdf)
    if not book.docs:
        raise SystemExit("没有找到 Markdown 文件")
    chars = md_page_chars(book)
    issues: list[Issue] = []
    issues += check_anchors(book)
    issues += check_printed(book)
    ci, table = check_page_chars(book, chars)
    issues += ci
    issues += check_seams(book)
    issues += check_cross_page_notes(book)
    issues += check_footnotes(book)
    issues += check_headings(book)
    issues += check_residual(book)
    issues += check_latin(book)
    issues += check_watermark_and_heads(book)
    issues += check_superscript(book)
    issues += check_brackets(book)
    issues += check_repeats(book)
    issues += check_import_tables(book)
    issues.sort(key=lambda i: (-SEVERITY_RANK[i.severity], i.page if i.page is not None else -1, i.line or 0))
    sug = suggest_pages(book, issues, sample, seed)
    by_sev = Counter(i.severity for i in issues)
    return {
        "tool": "lunzhu2md-audit/audit_scan.py",
        "generated": _dt.datetime.now().isoformat(timespec="seconds"),
        "book_dir": str(book.root),
        "files": [book.rel(d.path) for d in book.docs],
        "pdf": str(book.pdf) if book.pdf else None,
        "pdf_found_by": book.pdf_how,
        "text_layer_pdf": str(text_layer_pdf(book.pdf)) if book.pdf else None,
        "pdf_pages": book.page_count,
        "text_layer_pages": len(book.usable),
        "running_heads": sorted(book.heads),
        "summary": {SEVERITY_ZH[k]: by_sev.get(k, 0) for k in ("high", "medium", "low", "info")},
        "issues": [i.to_json() for i in issues],
        "pages": {str(p): v for p, v in sorted(table.items())},
        "suggested_pages": sug,
    }


def render_markdown(r: dict) -> str:
    L = [f"# 抽检初筛报告", "",
         f"- 书文件夹：`{r['book_dir']}`",
         f"- 文件：{'、'.join(f'`{f}`' for f in r['files'])}",
         f"- PDF：`{r['pdf'] or '未找到'}`（{r['pdf_found_by']}），共 {r['pdf_pages'] or '?'} 页，"
         f"文字层可用 {r['text_layer_pages']} 页",
         f"- 生成：{r['generated']}（零花费：只用程序比对，没有调用 AI 或接口）", "",
         "## 汇总", "",
         "| 严重度 | 条数 |", "|---|---|"]
    L += [f"| {k} | {v} |" for k, v in r["summary"].items()]
    sug = r["suggested_pages"]
    L += ["", "## 建议抽查页", ""]
    if sug["risk"]:
        L.append("**必查（初筛有中、高疑点）**：" + "、".join(
            f"第 {x['page']} 页（{'、'.join(x['reasons'])}）" for x in sug["risk"]))
    if sug["structural"]:
        L.append("")
        L.append("**结构页**：" + "、".join(f"第 {x['page']} 页（{'、'.join(x['reasons'])}）" for x in sug["structural"]))
    if sug["random"]:
        L.append("")
        L.append(f"**随机页**（种子 {sug['random_seed']}）：" + "、".join(str(x["page"]) for x in sug["random"]))
        L.append("")
        n = len(sug["random"])
        L.append(f"> 抽样极限（三分之一法则）：随机抽的 {n} 页若全对，只能说明其余页的错误页比例大约 < 3/{n} ≈ "
                 f"{3 / n:.0%}（95% 把握），不能说明「没有错」。必查页、结构页是挑出来的，不算随机样本。")
    L += ["", "## 疑点明细", ""]
    if not r["issues"]:
        L.append("没有发现机器能查的问题。")
    else:
        L += ["| # | 严重度 | 类型 | 页 | 行 | 说明 | 片段 |", "|---|---|---|---|---|---|---|"]
        for i, it in enumerate(r["issues"], 1):
            esc = lambda s: str(s).replace("|", "\\|").replace("\n", " ")  # noqa: E731
            L.append(f"| {i} | {SEVERITY_ZH[it['severity']]} | {it['check_name']} | {it['page'] or ''} | "
                     f"{it['line'] or ''} | {esc(it['message'])} | {esc(it['snippet'])} |")
    rows = [(p, v) for p, v in r["pages"].items()]
    if rows:
        L += ["", "## 每页字数", "", "| 页 | 正文字数 | 文字层字数 | 比 |", "|---|---|---|---|"]
        for p, v in rows:
            L.append(f"| {p} | {v['md']} | {v.get('pdf', '')} | "
                     f"{'' if v.get('ratio') is None else f'{v['ratio']:.0%}'} |")
    if r["running_heads"]:
        L += ["", "## 从文字层认出的页眉页脚", ""] + [f"- {h}" for h in r["running_heads"]]
    return "\n".join(L) + "\n"


def cmd_scan(args) -> int:
    path = Path(args.path)
    r = scan(path, not args.no_pdf, args.sample, args.seed)
    if args.stdout:
        print(json.dumps(r, ensure_ascii=False, indent=2))
        return 0
    out = Path(args.out_dir) if args.out_dir else book_dir_of(path.resolve()) / "_数据" / "过程报告"
    out.mkdir(parents=True, exist_ok=True)
    (out / "抽检初筛.json").write_text(json.dumps(r, ensure_ascii=False, indent=2) + "\n",
                                     encoding="utf-8", newline="\n")
    (out / "抽检初筛.md").write_text(render_markdown(r), encoding="utf-8", newline="\n")
    s = r["summary"]
    print(f"疑点：高 {s['高']}、中 {s['中']}、低 {s['低']}、提示 {s['提示']}")
    sug = r["suggested_pages"]
    print("必查页：" + (", ".join(str(x["page"]) for x in sug["risk"]) or "无"))
    print("结构页：" + (", ".join(str(x["page"]) for x in sug["structural"]) or "无"))
    print("随机页：" + (", ".join(str(x["page"]) for x in sug["random"]) or "无"))
    print(str(out / "抽检初筛.md"))
    print(str(out / "抽检初筛.json"))
    return 0


def parse_pages(spec: str) -> list[int]:
    out: list[int] = []
    for part in spec.replace("，", ",").split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            out += list(range(int(a), int(b) + 1))
        else:
            out.append(int(part))
    return sorted(dict.fromkeys(out))


def cmd_render(args) -> int:
    pdf, how = locate_pdf(Path(args.path))
    if not pdf:
        print(f"找不到 PDF：{how}", file=sys.stderr)
        return 1
    out_dir = Path(args.out_dir) if args.out_dir else Path(tempfile.gettempdir()) / "lunzhu2md-audit"
    for p in parse_pages(args.pages):
        out = out_dir / f"{pdf.stem}-p{p:04d}-{args.dpi}dpi.png"
        render_page(pdf, p, out, args.dpi)
        print(str(out))
    return 0


# ---------------------------------------------------------------- 事实清单

FACT_FIELDS = ("paragraphs", "note_refs", "notes", "headings", "tables", "figures", "first_chars", "last_chars")


def md_facts(doc: Doc, seg: Segment) -> dict:
    text = doc.segment_text(seg)
    blocks = [b.strip() for b in re.split(r"\n[ \t]*\n", text) if b.strip()]
    paras, heads, tables, figs = 0, [], 0, 0
    for b in blocks:
        bare = re.sub(r"<!--[\s\S]*?-->", "", b).strip()
        if not bare:
            continue
        m = is_heading(bare)
        if m:
            heads.append(m.group(2).strip())
        elif _is_table(bare):
            tables += 1
        elif re.fullmatch(r"!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]+\]\]", bare):
            figs += 1
        else:
            paras += 1
    body = norm("\n".join(b for b in blocks if not is_heading(re.sub(r"<!--[\s\S]*?-->", "", b).strip())),
                digits=False)
    return {
        "page": seg.page, "file": str(doc.path),
        "paragraphs": paras,
        "note_refs": len(FN_REF_RE.findall(text)),
        "notes": sum(1 for f in doc.footnotes if f.pages and f.pages[0] == seg.page),  # 续过来的注不算新条
        "headings": heads, "tables": tables, "figures": figs,
        "first_chars": body[:10], "last_chars": body[-10:],
    }


def facts_for(book: Book, pages: list[int]) -> list[dict]:
    out = []
    for d in book.docs:
        for s in d.segments:
            if s.page in pages:
                out.append(md_facts(d, s))
    return sorted(out, key=lambda x: x["page"])


def cmd_facts(args) -> int:
    book = load_book(Path(args.path), use_pdf=False)
    print(json.dumps(facts_for(book, parse_pages(args.pages)), ensure_ascii=False, indent=2))
    return 0


def _similar(a: str, b: str) -> float:
    a, b = norm(a, digits=False, md=False), norm(b, digits=False, md=False)
    if not a and not b:
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def compare_facts(ai: list[dict], md: list[dict]) -> list[dict]:
    by_page = {m["page"]: m for m in md}
    out = []
    for a in sorted(ai, key=lambda x: int(x["page"])):
        p = int(a["page"])
        m = by_page.get(p)
        if m is None:
            out.append({"page": p, "verdict": "需高清通读", "mismatches": [{"field": "page", "ai": "有这页",
                                                                         "md": "正文没有这页的锚点"}]})
            continue
        mism = []
        for k in ("paragraphs", "note_refs", "notes", "tables", "figures"):
            if k in a and a[k] is not None and int(a[k]) != int(m[k]):
                mism.append({"field": k, "ai": a[k], "md": m[k]})
        if "headings" in a and a["headings"] is not None:
            ah, mh = list(a["headings"]), list(m["headings"])
            ok = len(ah) == len(mh) and all(_similar(x, y) >= 0.7 for x, y in zip(ah, mh))
            if not ok:
                mism.append({"field": "headings", "ai": ah, "md": mh})
        for k in ("first_chars", "last_chars"):
            if a.get(k) and _similar(a[k], m[k]) < 0.6:
                mism.append({"field": k, "ai": a[k], "md": m[k]})
        out.append({"page": p, "verdict": "需高清通读" if mism else "一致", "mismatches": mism})
    return out


def cmd_compare(args) -> int:
    ai = json.loads(Path(args.facts).read_text(encoding="utf-8"))
    if isinstance(ai, dict):
        ai = ai.get("pages") or [ai]
    book = load_book(Path(args.path), use_pdf=False)
    res = compare_facts(ai, facts_for(book, [int(x["page"]) for x in ai]))
    text = json.dumps(res, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8", newline="\n")
    print(text)
    bad = [r["page"] for r in res if r["mismatches"]]
    print(f"对不上、需高清通读的页：{bad or '无'}", file=sys.stderr)
    return 1 if bad else 0


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="lunzhu2md-audit 零花费初筛")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("scan"); p.add_argument("path"); p.add_argument("--out-dir")
    p.add_argument("--sample", type=int); p.add_argument("--seed", type=int, default=1012)
    p.add_argument("--no-pdf", action="store_true"); p.add_argument("--stdout", action="store_true")
    p.set_defaults(fn=cmd_scan)
    p = sub.add_parser("render"); p.add_argument("path"); p.add_argument("--pages", required=True)
    p.add_argument("--dpi", type=int, default=60); p.add_argument("--out-dir"); p.set_defaults(fn=cmd_render)
    p = sub.add_parser("facts"); p.add_argument("path"); p.add_argument("--pages", required=True)
    p.set_defaults(fn=cmd_facts)
    p = sub.add_parser("compare"); p.add_argument("path"); p.add_argument("--facts", required=True)
    p.add_argument("--out"); p.set_defaults(fn=cmd_compare)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
