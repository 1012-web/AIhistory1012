#!/usr/bin/env python3
"""lunzhu2md-fix 的按页工具：找 PDF、取第 N 页锚点段、渲染页图、读文字层、改动守卫。

只做机械活：取段、出图、读文字层、备份、核对改动范围；从不改正文。改什么、怎么改由 AI 对照原页图决定。

独立脚本，只用标准库；渲染与读文字层优先 pypdfium2，没有再退 PyMuPDF。
锚点约定见仓库 docs/anchors.md：
    <!--pdf-page.N-->            PDF 第 N 页（从 1 起）内容的起点，段落跨页时插在接缝处
    <!--p.M-->                   印刷页，紧跟物理页锚点
    [^n]: <!--pdf-page.N--><!--p.M--> 注文   脚注定义自带所在页

子命令（PATH 可以是一个 .md，也可以是书文件夹）：
    locate   PATH                      找配对的 PDF，说明怎么找到的
    pages    PATH [--json]             列出每个文件覆盖的物理页范围、缺页、重复、倒序
    extract  PATH --page N [--json] [--numbered]
                                       取第 N 页锚点段，连同挂在本页的脚注定义
    render   PATH --page N [--dpi 150] [--out FILE]
                                       把 PDF 第 N 页渲染成 PNG，打印路径
    pdftext  PATH --page N             PDF 第 N 页的文字层（有「.文字层.pdf」副本时读副本）
    search   PATH 文字                 在文字层和正文里找一句话，报出在 PDF 哪页、正文哪页哪行
    （extract、render、pdftext 也可用 --printed M 按原书印刷页指定）
    snapshot FILE                      改之前先备份到 <书>/_数据/过程报告/fix-备份/，打印备份路径
    guard    BACKUP FILE --page N      核对：锚点一个不差，且只有第 N 页（含其脚注）变了
             [--page N2 --anchor-move] 用户同意挪锚点时：允许锚点在这几页之间挪位

退出码：0 正常；1 守卫不通过或找不到东西；2 用法错误。
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

# >>> shared-core：与 lunzhu2md-audit/scripts/audit_scan.py 逐字相同，改一处要同步另一处（tests 会查）
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


# ---------------------------------------------------------------- 子命令

def cmd_locate(args) -> int:
    path = Path(args.path)
    pdf, how = locate_pdf(path)
    if not pdf:
        print(f"找不到 PDF：{how}", file=sys.stderr)
        return 1
    layer = text_layer_pdf(pdf)
    info = {"pdf": str(pdf), "found_by": how, "text_layer_pdf": str(layer),
            "pages": pdf_page_count(pdf), "book_dir": str(book_dir_of(path.resolve())),
            "backend": _backend()}
    print(json.dumps(info, ensure_ascii=False, indent=2))
    return 0


def coverage(doc: Doc) -> dict:
    pages = [a.page for a in doc.body_anchors]
    seen, dups, back = set(), [], []
    for i, p in enumerate(pages):
        if p in seen:
            dups.append(p)
        seen.add(p)
        if i and p < pages[i - 1]:
            back.append((pages[i - 1], p))
    missing = []
    if pages:
        missing = [p for p in range(min(pages), max(pages) + 1) if p not in seen]
    return {"file": str(doc.path), "first": min(pages) if pages else None,
            "last": max(pages) if pages else None, "anchors": len(pages),
            "missing": missing, "duplicates": sorted(set(dups)),
            "out_of_order": back,
            "footnotes": len(doc.footnotes),
            "footnotes_without_page": [f.label for f in doc.footnotes if f.page is None]}


def cmd_pages(args) -> int:
    files = book_files(Path(args.path))
    if not files:
        print("没有带 <!--pdf-page.N--> 锚点的 Markdown 文件", file=sys.stderr)
        return 1
    rows = [coverage(parse_doc(f)) for f in files]
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return 0
    for r in rows:
        rng = f"{r['first']}–{r['last']}" if r["first"] is not None else "无"
        print(f"{Path(r['file']).name}: PDF 第 {rng} 页，锚点 {r['anchors']} 个，脚注 {r['footnotes']} 条")
        for key, label in (("missing", "缺页"), ("duplicates", "重复"), ("out_of_order", "倒序"),
                           ("footnotes_without_page", "无页锚点的脚注")):
            if r[key]:
                print(f"  {label}：{r[key]}")
    return 0


def find_page(files: list[Path], page: int) -> list[tuple[Doc, Segment]]:
    out = []
    docs = [parse_doc(f) for f in files]
    mark_continuations(docs)
    for doc in docs:
        for seg in doc.segments:
            if seg.page == page:
                out.append((doc, seg))
    return out


def next_file_lead(files: list[Path], doc: Doc, seg: Segment) -> dict | None:
    """本页是某文件的最后一页时，下一个文件锚点前的开头部分也属于本页。"""
    if not doc.segments or doc.segments[-1] is not seg:
        return None
    try:
        i = [f.resolve() for f in files].index(doc.path.resolve())
    except ValueError:
        return None
    if i + 1 >= len(files):
        return None
    nxt = parse_doc(files[i + 1])
    line, text = lead_text(nxt)
    return {"file": str(nxt.path), "line_start": line, "text": text} if text else None


def page_bundle(doc: Doc, seg: Segment) -> dict:
    body = doc.segment_text(seg)
    refs = list(dict.fromkeys(FN_REF_RE.findall(body)))
    by_label = {f.label: f for f in doc.footnotes}
    own = [f for f in doc.footnotes if seg.page in f.pages]
    elsewhere = []
    for lab in refs:
        f = by_label.get(lab)
        if f is None:
            elsewhere.append({"label": lab, "problem": "正文有注码，全文找不到定义"})
        elif seg.page not in f.pages:
            elsewhere.append({"label": lab, "def_page": f.page, "line": f.line,
                              "problem": "定义挂在别的页" if f.page else "定义没有页锚点"})
    own_labels = {f.label for f in own}
    orphan = [f.label for f in own if f.label not in refs and
              not any(f.label in FN_REF_RE.findall(doc.segment_text(s)) for s in doc.segments)]
    return {
        "file": str(doc.path), "page": seg.page, "printed": seg.printed,
        "line_start": seg.line, "line_end": seg.end_line,
        "text": body,
        "footnotes": [{"label": f.label, "line": f.line, "end_line": f.end_line, "text": f.text,
                       "pages": f.pages,
                       "part_on_this_page": footnote_part_text(doc, f, seg.page) if len(f.pages) > 1 else None}
                      for f in own],
        "continuation": seg.continuation,
        "refs_in_body": refs,
        "refs_elsewhere": elsewhere,
        "defs_without_ref": [x for x in orphan if x in own_labels],
    }


def resolve_page(args) -> int:
    """--page 直接用；--printed M 按 <!--p.M--> 换成物理页。"""
    if getattr(args, "printed", None) is None:
        if args.page is None:
            raise SystemExit("要给 --page N（PDF 物理页）或 --printed M（原书印刷页）")
        return args.page
    hits = sorted({a.page for f in book_files(Path(args.path)) for a in parse_doc(f).body_anchors
                   if a.printed == str(args.printed)})
    if not hits:
        raise SystemExit(f"正文里没有 <!--p.{args.printed}--> 印刷页锚点")
    if len(hits) > 1:
        raise SystemExit(f"印刷页 p.{args.printed} 对应多个物理页 {hits}，请用 --page 指定")
    print(f"（原书 p.{args.printed} = PDF 第 {hits[0]} 页）", file=sys.stderr)
    args.page = hits[0]
    return hits[0]


def _norm_plain(s: str) -> str:
    s = re.sub(r"<!--[\s\S]*?-->|\[\^[^\]\s]+\]:?", "", s)
    return "".join(ch for ch in s if ch.isalnum() and not ("①" <= ch <= "⓿"))


def cmd_search(args) -> int:
    """在文字层与正文里找一句话，用于截图、「某句话不见了」这类不知道页码的情形。"""
    needle = _norm_plain(args.text)
    if len(needle) < 4:
        print("要找的文字太短（去掉标点后至少 4 个字）", file=sys.stderr)
        return 2
    path = Path(args.path)
    result = {"needle": needle, "pdf_pages": [], "md": []}
    pdf, _ = locate_pdf(path)
    if pdf:
        for p, t in enumerate(all_page_texts(text_layer_pdf(pdf)), 1):
            if needle in _norm_plain(t):
                result["pdf_pages"].append(p)
    for f in book_files(path):
        doc = parse_doc(f)
        for seg in doc.segments:
            if needle in _norm_plain(doc.segment_text(seg)):
                result["md"].append({"file": str(f), "page": seg.page, "line": seg.line})
        for fd in doc.footnotes:
            if needle in _norm_plain(fd.text):
                result["md"].append({"file": str(f), "page": fd.page, "line": fd.line, "footnote": fd.label})
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["pdf_pages"] or result["md"] else 1


def cmd_extract(args) -> int:
    files = book_files(Path(args.path))
    resolve_page(args)
    hits = find_page(files, args.page)
    if not hits:
        print(f"没找到 <!--pdf-page.{args.page}--> 锚点（正文里）", file=sys.stderr)
        return 1
    bundles = []
    for d, s in hits:
        b = page_bundle(d, s)
        b["continued_in_next_file"] = next_file_lead(files, d, s)
        b["legacy"] = d.legacy
        bundles.append(b)
    if args.json:
        print(json.dumps(bundles, ensure_ascii=False, indent=2))
        return 0
    if sum(1 for b in bundles if not b["continuation"]) > 1:
        print(f"！第 {args.page} 页的锚点出现 {len(bundles)} 次（重复锚点），逐个列出\n")
    elif len(bundles) > 1:
        print(f"（第 {args.page} 页跨两个文件：后一个文件开头是续页锚点，两部分都列出）\n")
    for b in bundles:
        pr = f"（原书 p.{b['printed']}）" if b["printed"] else ""
        print(f"=== {b['file']}  PDF 第 {b['page']} 页{pr}  行 {b['line_start']}–{b['line_end']}")
        _print_text(b["text"], b["line_start"], args.numbered)
        print(f"\n=== 挂在本页的脚注定义：{len(b['footnotes'])} 条")
        for f in b["footnotes"]:
            _print_text(f["text"], f["line"], args.numbered)
            if f["part_on_this_page"] is not None:
                print(f"    （这条注跨第 {'、'.join(map(str, f['pages']))} 页，本页部分：{f['part_on_this_page'][:60]}…）")
        if b["refs_elsewhere"]:
            print("\n=== 本页正文的注码，定义不在本页：")
            for e in b["refs_elsewhere"]:
                where = f"第 {e['def_page']} 页，行 {e['line']}" if e.get("def_page") else ""
                print(f"  [^{e['label']}] {e['problem']} {where}".rstrip())
        if b["defs_without_ref"]:
            print(f"\n=== 本页的脚注定义在正文里找不到注码：{b['defs_without_ref']}")
        nx = b["continued_in_next_file"]
        if nx:
            print(f"\n=== 本页还有一部分在下一个文件开头（锚点前）：{nx['file']} 行 {nx['line_start']} 起")
            _print_text(nx["text"], nx["line_start"], args.numbered)
        if b["legacy"]:
            print("\n（旧格式：本文件只有 <!--p.M--> 印刷页锚点，物理页按 book.json 的 printedPageOffset 换算）")
        print()
    return 0


def _print_text(text: str, first_line: int, numbered: bool) -> None:
    if not numbered:
        print(text.rstrip("\n"))
        return
    for i, ln in enumerate(text.rstrip("\n").split("\n")):
        print(f"{first_line + i:>6}\t{ln}")


def _pdf_or_die(path: Path) -> Path:
    pdf, how = locate_pdf(path)
    if not pdf:
        raise SystemExit(f"找不到 PDF：{how}")
    return pdf


def cmd_render(args) -> int:
    pdf = _pdf_or_die(Path(args.path))
    resolve_page(args)
    out = Path(args.out) if args.out else (
        Path(tempfile.gettempdir()) / "lunzhu2md-fix" / f"{pdf.stem}-p{args.page:04d}-{args.dpi}dpi.png")
    backend = render_page(pdf, args.page, out, args.dpi)
    print(str(out))
    print(f"（{backend}，{args.dpi} dpi，{pdf.name} 第 {args.page} 页）", file=sys.stderr)
    return 0


def cmd_pdftext(args) -> int:
    pdf = text_layer_pdf(_pdf_or_die(Path(args.path)))
    print(page_text(pdf, resolve_page(args)))
    return 0


def cmd_snapshot(args) -> int:
    f = Path(args.file).resolve()
    book = book_dir_of(f)
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    dst = book / "_数据" / "过程报告" / "fix-备份" / f"{f.stem}.{stamp}.md"
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(f, dst)
    print(str(dst))
    return 0


def _units(doc: Doc) -> dict[tuple, str]:
    """把文件拆成可比单元：引子、每页正文段、每条脚注定义。"""
    units: dict[tuple, str] = {}
    first = doc.body_anchors[0].start if doc.body_anchors else len(doc.text)
    fn = [(f.start, f.end) for f in doc.footnotes]
    units[("lead",)] = "".join(doc.text[a:b] for a, b in _subtract(0, first, fn))
    counts: dict[int, int] = {}
    for seg in doc.segments:
        k = counts.get(seg.page, 0)
        counts[seg.page] = k + 1
        units[("page", seg.page, k)] = doc.segment_text(seg)
    if doc.segments:
        last = doc.segments[-1]
        tail_start = last.pieces[-1][1] if last.pieces else last.end
        units[("tail",)] = "".join(doc.text[a:b] for a, b in _subtract(tail_start, len(doc.text), fn))
    for f in doc.footnotes:
        units[("fn", f.label)] = f.text
    return units


def _anchor_context(doc: Doc, a: Anchor, n: int = 8) -> tuple[str, str]:
    """锚点前后各 n 个字（去掉别的锚点注释），用来判断锚点有没有挪位。"""
    strip = lambda t: re.sub(r"<!--[\s\S]*?-->|\s+", "", t)  # noqa: E731
    return strip(doc.text[max(0, a.start - 4 * n):a.start])[-n:], strip(doc.text[a.end:a.end + 4 * n])[:n]


def guard(before: Doc, after: Doc, page, anchor_move: bool = False) -> list[str]:
    pages = {page} if isinstance(page, int) else set(page)
    problems = []
    sig_b = [(a.page, a.printed, a.footnote) for a in before.body_anchors]
    sig_a = [(a.page, a.printed, a.footnote) for a in after.body_anchors]
    if sig_b != sig_a:
        problems.append(f"正文锚点序列变了：改前 {len(sig_b)} 个，改后 {len(sig_a)} 个")
    else:
        prev_page = None
        for ab, aa in zip(before.body_anchors, after.body_anchors):
            # 锚点两侧只有一侧可改时，挪锚点必然让另一侧的页变动，下面按页比对就能查出；
            # 两侧都可改（多页修订）时才需要看锚点前后的字
            both = ab.page in pages and prev_page in pages
            prev_page = ab.page
            if not both and not anchor_move:
                continue
            if _anchor_context(before, ab) != _anchor_context(after, aa):
                if not anchor_move:
                    problems.append(f"第 {ab.page} 页锚点的位置动了（前后文字变了）；挪锚点须经用户同意，并加 --anchor-move")
                elif ab.page not in pages:
                    problems.append(f"第 {ab.page} 页锚点动了，但第 {ab.page} 页不在 --page 里")
    if before.frontmatter != after.frontmatter:
        problems.append("frontmatter 变了")
    ub, ua = _units(before), _units(after)
    fn_page_b = {f.label: f.page for f in before.footnotes}
    fn_page_a = {f.label: f.page for f in after.footnotes}
    shown = "、".join(str(x) for x in sorted(pages))
    for key in sorted(set(ub) | set(ua), key=str):
        if ub.get(key) == ua.get(key):
            continue
        if key[0] in ("lead", "tail") and re.sub(r"\s+", "", ub.get(key, "")) == re.sub(r"\s+", "", ua.get(key, "")):
            continue  # 补注时注与注之间多了空行，不算改动
        if key[0] == "page" and key[1] in pages:
            continue
        if key[0] == "fn":
            pb, pa = fn_page_b.get(key[1]), fn_page_a.get(key[1])
            if key in ua and key not in ub and pa in pages:
                continue  # 本页补回的注
            if pb in pages and pa == pb:
                continue  # 本页的注改了
            if anchor_move and pb in pages and pa in pages:
                continue  # 用户同意后改了注文挂的页
            if key in ub and key not in ua:
                problems.append(f"删掉了脚注 [^{key[1]}]（原挂第 {pb} 页）")
                continue
            if pb != pa and pb is not None and pa is not None:
                problems.append(f"脚注 [^{key[1]}] 挂的页从第 {pb} 页改成第 {pa} 页；改注文锚点须经用户同意，并加 --anchor-move")
                continue
            problems.append(f"脚注 [^{key[1]}] 变了，但它不挂在第 {shown} 页（改前 {pb}，改后 {pa}）")
            continue
        name = {"lead": "第一个锚点之前的部分", "tail": "最后一页之后的部分（注释标题等）"}.get(key[0])
        problems.append(f"{name or f'第 {key[1]} 页'}也变了")
    return problems


def cmd_guard(args) -> int:
    before = parse_doc(Path(args.backup))
    after = parse_doc(Path(args.file))
    problems = guard(before, after, args.page, args.anchor_move)
    shown = "、".join(str(x) for x in sorted(set(args.page)))
    if problems:
        print("守卫不通过：")
        for p in problems:
            print(f"  - {p}")
        return 1
    if args.anchor_move:
        print(f"通过：锚点序列未变，改动（含挪锚点）只在第 {shown} 页")
    else:
        print(f"通过：锚点未动，改动只在第 {shown} 页（含挂在本页的脚注）")
    return 0


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="lunzhu2md-fix 按页工具")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("locate"); p.add_argument("path"); p.set_defaults(fn=cmd_locate)
    p = sub.add_parser("pages"); p.add_argument("path"); p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_pages)
    p = sub.add_parser("extract"); p.add_argument("path"); p.add_argument("--page", type=int)
    p.add_argument("--printed", help="原书印刷页（按 <!--p.M--> 换成物理页）")
    p.add_argument("--json", action="store_true"); p.add_argument("--numbered", action="store_true")
    p.set_defaults(fn=cmd_extract)
    p = sub.add_parser("render"); p.add_argument("path"); p.add_argument("--page", type=int)
    p.add_argument("--printed", help="原书印刷页（按 <!--p.M--> 换成物理页）")
    p.add_argument("--dpi", type=int, default=150); p.add_argument("--out")
    p.set_defaults(fn=cmd_render)
    p = sub.add_parser("pdftext"); p.add_argument("path"); p.add_argument("--page", type=int)
    p.add_argument("--printed", help="原书印刷页（按 <!--p.M--> 换成物理页）")
    p.set_defaults(fn=cmd_pdftext)
    p = sub.add_parser("search"); p.add_argument("path"); p.add_argument("text"); p.set_defaults(fn=cmd_search)
    p = sub.add_parser("snapshot"); p.add_argument("file"); p.set_defaults(fn=cmd_snapshot)
    p = sub.add_parser("guard"); p.add_argument("backup"); p.add_argument("file")
    p.add_argument("--page", type=int, action="append", required=True,
                   help="允许改动的物理页；挪锚点时给锚点两侧的两页，各写一个 --page")
    p.add_argument("--anchor-move", action="store_true", help="用户已同意挪锚点：允许锚点位置与注文挂页在这些页之间变动")
    p.set_defaults(fn=cmd_guard)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
