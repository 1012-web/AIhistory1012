"""两家识别交叉核对：PaddleOCR-VL 逐页结果对照成品 Markdown，按物理页锚点对齐，出冲突清单。

MinerU 是骨架（成品正文就是它整理出来的），PaddleOCR-VL 是第二识别者。每页分两条流比：
  正文流：Markdown 里 <!--pdf-page.N--> 到下一锚点之间的正文  ↔  VL 该页的正文类块（text、标题、引文、表格……）
  注文流：Markdown 里锚在第 N 页的脚注定义                      ↔  VL 该页的 footnote 块
比之前两边都做同样的折叠（NFKC 统一全半角、去空白、去 Markdown 语法与锚点、注号另计），只比字和标点。

冲突分两类：
  字冲突（kind=char）：对齐后 1–4 字的替换、一边多、一边少。档 ① 由 AI 只读文字裁决。
  结构冲突：
    passage   整段有无：一边多出 ≥ --passage 个字（默认 20）——只有一家读出，必须看原图核；
    span      5 字以上、不到整段的成片差异——看原图；
    notes     本页脚注条数不同；
    refs      本页正文注号个数不同；
    heading   本页标题个数不同；
    table     本页表格个数不同。

两家读法一致不证明无误；只有 MinerU 一家的页（VL 缺页）列在报告里，算「无第二读者覆盖」。

用法：
  python -X utf8 crosscheck.py --book <书> --vl <书>/_数据/PaddleOCR [--md 01-正文.md ...] [--out <书>/_数据/冲突清单]
默认按 <书>/_数据/book.json 的文件列表。产出 <out>/conflicts.json（给 doubts.py）与 <out>/冲突清单.md（给 AI 读）。
stdout 只打一行 ASCII。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import ANCHOR_RE, CIRC, PDF_PAGE_RE  # noqa: E402

VERSION = 1
CTX = 8
# VL 的块标签：哪些算正文、哪些算脚注；页眉、页码、页脚、边注不比
VL_BODY = {"text", "paragraph_title", "doc_title", "abstract", "content", "reference", "reference_content",
           "figure_title", "chart_title", "table_title", "table", "display_formula", "formula", "algorithm",
           "list", "vision_footnote", "vertical_text"}
VL_NOTES = {"footnote"}
VL_HEADINGS = {"paragraph_title", "doc_title"}
SKIP_SPAN = re.compile(r"<!--.*?-->|!\[[^\]]*\]\([^)]*\)|<[^<>\n]+>|\$+", re.S)
REF = re.compile(r"\[\^\d+\]")
LATEX_SUP = re.compile(r"\$\s*\^\{\s*([^{}$]*?)\s*\}\s*\$")
LATEX_CMD = re.compile(r"\\[a-zA-Z]+\s*")
MD_SYNTAX = set("#*>|`_")
NOTE_DEF = re.compile(r"^\[\^(\d+)\]:\s*(?:<!--pdf-page\.(\d+)-->)?(?:<!--p\.[^>]+?-->)?\s*(.*)$", re.S)
CIRC_RUN = re.compile("^[" + CIRC + "]+")


# ---------------------------------------------------------------- 折叠：原文 → 可比的字串，每个字记回原文位置

def fold(text: str, base: int = 0, keep_refs: bool = False) -> tuple[str, list[int], int]:
    """返回 (折叠后的字串, 每个字在原文里的偏移, 注号个数)。偏移以 base 为起点。"""
    out, where, refs = [], [], 0
    index = 0
    protected = [(m.start(), m.end(), m.group(0)) for m in SKIP_SPAN.finditer(text)]
    protected += [(m.start(), m.end(), m.group(0)) for m in REF.finditer(text)]
    protected.sort()
    pi = 0
    while index < len(text):
        while pi < len(protected) and protected[pi][1] <= index:
            pi += 1
        if pi < len(protected) and protected[pi][0] <= index < protected[pi][1]:
            if REF.fullmatch(protected[pi][2]):
                refs += 1
            index = protected[pi][1]
            continue
        char = text[index]
        if not char.isspace() and char not in MD_SYNTAX:
            for piece in unicodedata.normalize("NFKC", char):
                if not piece.isspace():
                    out.append(piece)
                    where.append(base + index)
        index += 1
    return "".join(out), where, refs


NOTE_MARK = ""   # VL 的注号（$ ^{①} $、$^{1}$、正文里的 ①）先换成这个记号：计数，不参与比字
NOTE_LEAD = re.compile(r"^\s*(?:" + NOTE_MARK + r"|[" + CIRC + r"]|\d{1,3}(?=\s*\D))+\s*", re.M)


def clean_vl(text: str, notes: bool = False) -> tuple[str, int]:
    """VL 的 LaTeX 包装与注号：返回 (清理后的文字, 注号个数)。注文流里每行开头的注号（①、1）去掉。"""
    text = LATEX_SUP.sub(NOTE_MARK, text)
    text = re.sub("[" + CIRC + "]", NOTE_MARK, text)
    text = LATEX_CMD.sub("", text).replace("$", "")
    if notes:
        count = sum(m.group(0).count(NOTE_MARK) or 1 for m in NOTE_LEAD.finditer(text))
        return NOTE_LEAD.sub("", text).replace(NOTE_MARK, ""), count
    return text.replace(NOTE_MARK, ""), text.count(NOTE_MARK)


# ---------------------------------------------------------------- Markdown 按物理页切开

NOTES_HEAD = re.compile(r"^#{1,6}\s*注释\s*$")
HEAD_LINE = re.compile(r"^#{1,6}\s+\S")


def mask_non_body(text: str) -> str:
    """frontmatter、注释区（「## 注释」到下一个标题）、分隔线、callout 换成等长空白，正文偏移不变。"""
    out = list(text)

    def blank(a: int, b: int) -> None:
        for i in range(a, b):
            if out[i] != "\n":
                out[i] = " "

    fm = re.match(r"^---\n.*?\n---\n", text, re.S)
    if fm:
        blank(0, fm.end())
    pos, in_notes = (fm.end() if fm else 0), False
    for line in text[pos:].split("\n"):
        end = pos + len(line)
        stripped = line.strip()
        if NOTES_HEAD.match(stripped):
            in_notes = True
        elif in_notes and (HEAD_LINE.match(line) or ANCHOR_RE.match(stripped)):
            in_notes = False
        if in_notes or stripped == "---" or stripped.startswith("> [!"):
            blank(pos, end)
        pos = end + 1
    return "".join(out)

def md_pages(book: Path, files: list[str]) -> dict[int, dict[str, Any]]:
    """{物理页: {body: [(文件, 段文字, 段起点)], notes: [(文件, 注文, 起点)], headings: [..], tables: n}}"""
    pages: dict[int, dict[str, Any]] = {}

    def page(n: int) -> dict[str, Any]:
        return pages.setdefault(n, {"body": [], "notes": [], "headings": [], "tables": 0})

    current = None
    for name in files:
        text = (book / name).read_text(encoding="utf-8")
        masked = mask_non_body(text)
        # 正文：按锚点切段，记下每段在原文件里的起点（遮掉的地方是空格，偏移不变）
        for chunk_match in re.finditer(r"<!--pdf-page\.\d+-->|(?s:.+?)(?=<!--pdf-page\.\d+-->|\Z)", masked):
            chunk = chunk_match.group(0)
            m = PDF_PAGE_RE.fullmatch(chunk)
            if m:
                current = int(m.group(1))
                page(current)
                continue
            if current is None or not chunk.strip():
                continue
            page(current)["body"].append((name, chunk, chunk_match.start()))
            for line in chunk.split("\n"):
                if re.match(r"^#{1,6}\s+\S", line):
                    page(current)["headings"].append(line.lstrip("#").strip())
            page(current)["tables"] += len(re.findall(r"<table\b", chunk))
        # 注文：按定义开头的物理页锚点归页
        for m in re.finditer(r"(?m)^\[\^\d+\]:.*$", text):
            dm = NOTE_DEF.match(m.group(0))
            if not dm or not dm.group(2):
                continue
            note_text = dm.group(3)
            note_start = m.start() + m.group(0).index(note_text) if note_text else m.end()
            # 脚注跨页：注文中间可以再插物理页锚点，后半段归下一页（docs/anchors.md 第三节）
            owner, cursor = int(dm.group(2)), 0
            for inner in PDF_PAGE_RE.finditer(note_text):
                page(owner)["notes"].append((name, note_text[cursor:inner.start()], note_start + cursor))
                owner, cursor = int(inner.group(1)), inner.end()
            page(owner)["notes"].append((name, note_text[cursor:], note_start + cursor))
    return pages


def fold_parts(parts: list[tuple[str, str, int]]) -> tuple[str, list[tuple[str, int]], int]:
    chars, where, refs = [], [], 0
    for name, text, base in parts:
        folded, offsets, n = fold(text, base)
        chars.append(folded)
        where += [(name, o) for o in offsets]
        refs += n
    return "".join(chars), where, refs


# ---------------------------------------------------------------- VL 一页

def vl_page(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    body, notes, headings, tables, note_count, refs = [], [], [], 0, 0, 0
    for block in data.get("parsing_res_list", []):
        label = block.get("block_label")
        raw = block.get("block_content") or ""
        if label in VL_NOTES:
            content, count = clean_vl(raw, notes=True)
            notes.append(content)
            # 一块里注号领起的条数；一条没认出注号的块也算一条
            note_count += count or 1
        elif label in VL_BODY:
            content, count = clean_vl(raw)
            body.append(content)
            refs += count
            if label in VL_HEADINGS:
                headings.append(content.strip())
            if label == "table":
                tables += 1
    return {"body": "\n".join(body), "notes": "\n".join(notes), "headings": headings, "tables": tables,
            "note_count": note_count, "refs": refs}


# ---------------------------------------------------------------- 对齐与归类

def opcodes(a: str, b: str) -> list[tuple[str, int, int, int, int]]:
    try:
        from rapidfuzz.distance import Indel, Levenshtein  # noqa: F401
        return [(op.tag, op.src_start, op.src_end, op.dest_start, op.dest_end)
                for op in Levenshtein.opcodes(a, b) if op.tag != "equal"]
    except ImportError:
        import difflib
        return [op for op in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes() if op[0] != "equal"]


def merge_close(ops: list[tuple[str, int, int, int, int]], gap: int = 1) -> list[tuple[str, int, int, int, int]]:
    """相隔不到 gap 个相同字的差异并成一处（「秦令⑪」→「秦令11」这类拆成几段的，合起来才看得懂）。"""
    out: list[list[Any]] = []
    for tag, a0, a1, b0, b1 in ops:
        if out and a0 - out[-1][2] <= gap and b0 - out[-1][4] <= gap:
            out[-1] = ["replace", out[-1][1], a1, out[-1][3], b1]
        else:
            out.append([tag, a0, a1, b0, b1])
    return [tuple(x) for x in out]


def classify(md_len: int, vl_len: int, passage: int) -> str:
    longer = max(md_len, vl_len)
    if longer <= 4:
        return "char"
    if min(md_len, vl_len) == 0 and longer >= passage:
        return "passage"
    if longer >= passage and min(md_len, vl_len) <= longer // 4:
        return "passage"
    return "span"


def compare_stream(page: int, stream: str, md: tuple[str, list[tuple[str, int]], int], vl: str,
                   passage: int, items: list[dict[str, Any]]) -> dict[str, int]:
    a, where, _ = md
    b, where_b, _ = fold(vl)
    stats = {"md_chars": len(a), "vl_chars": len(b), "diff_chars": 0}
    for tag, a0, a1, b0, b1 in merge_close(opcodes(a, b)):
        kind = classify(a1 - a0, b1 - b0, passage)
        stats["diff_chars"] += max(a1 - a0, b1 - b0)
        if a0 < len(where):
            file, offset = where[a0]
        elif where:
            file, offset = where[-1][0], where[-1][1] + 1
        else:
            file, offset = None, None
        end = where[a1 - 1][1] + 1 if a1 > a0 and a1 - 1 < len(where) else offset
        if a1 > a0 and file is not None and where[a1 - 1][0] != file:
            file, offset, end = None, None, None  # 跨文件的差异不给定位，只供人看
        vl_raw = vl[where_b[b0]:where_b[b1 - 1] + 1] if b1 > b0 else ""
        items.append({
            "page": page, "stream": stream, "kind": kind, "op": tag,
            "md": a[a0:a1], "vl": b[b0:b1], "vl_raw": vl_raw,
            "md_before": a[max(0, a0 - CTX):a0], "md_after": a[a1:a1 + CTX],
            "vl_before": b[max(0, b0 - CTX):b0], "vl_after": b[b1:b1 + CTX],
            "file": file, "start": offset, "end": end,
            "needs_image": kind in ("passage", "span"),
        })
    return stats


def run(book: Path, vl_dir: Path, files: list[str], passage: int) -> dict[str, Any]:
    pages = md_pages(book, files)
    items: list[dict[str, Any]] = []
    covered, missing, stats = [], [], {}
    for number in sorted(pages):
        path = vl_dir / f"p{number:04d}.json"
        if not path.is_file():
            missing.append(number)
            continue
        covered.append(number)
        vl = vl_page(path)
        md = pages[number]
        body = fold_parts(md["body"])
        notes = fold_parts(md["notes"])
        s1 = compare_stream(number, "body", body, vl["body"], passage, items)
        s2 = compare_stream(number, "notes", notes, vl["notes"], passage, items)
        stats[number] = {"body": s1, "notes": s2}
        md_notes = len(md["notes"])
        for kind, ours, theirs, what in (("notes", md_notes, vl["note_count"], "脚注条数"),
                                         ("refs", body[2], vl["refs"], "正文注号个数"),
                                         ("heading", len(md["headings"]), len(vl["headings"]), "标题个数"),
                                         ("table", md["tables"], vl["tables"], "表格个数")):
            if ours != theirs:
                items.append({"page": number, "stream": "structure", "kind": kind, "op": "count",
                              "md": str(ours), "vl": str(theirs), "what": what,
                              "md_headings": md["headings"] if kind == "heading" else None,
                              "vl_headings": vl["headings"] if kind == "heading" else None,
                              "file": (md["body"][0][0] if md["body"] else None), "start": None, "end": None,
                              "needs_image": kind != "refs"})
    texts = {name: (book / name).read_text(encoding="utf-8") for name in files}
    for number, item in enumerate(items, 1):
        item["id"] = "C%05d" % number
        if item.get("file") and item.get("start") is not None and item["stream"] != "structure":
            item["md_raw"] = texts[item["file"]][item["start"]:item["end"]]
    return {"version": VERSION, "book": str(book), "vl": str(vl_dir), "files": files, "passage": passage,
            "pagesCompared": covered, "pagesWithoutSecondReader": missing, "items": items, "stats": stats}


KIND_LABEL = {"char": "字冲突", "passage": "整段有无", "span": "成片差异", "notes": "脚注条数", "refs": "正文注号",
              "heading": "标题个数", "table": "表格个数"}


def write_markdown(result: dict[str, Any], target: Path) -> None:
    items = result["items"]
    counts: dict[str, int] = {}
    for item in items:
        counts[item["kind"]] = counts.get(item["kind"], 0) + 1
    lines = ["# 两家识别冲突清单", "",
             "MinerU（成品正文）对 PaddleOCR-VL，按物理页锚点对齐。比对前统一全半角、去空白与 Markdown 语法；注号另计。",
             "两家一致不证明无误；以下只是线索，裁决规则见 SKILL.md「两家识别与核字档位」。", "",
             "比对 %d 页；无第二读者覆盖 %d 页%s。" % (
                 len(result["pagesCompared"]), len(result["pagesWithoutSecondReader"]),
                 ("（PDF 第 %s 页）" % ", ".join(map(str, result["pagesWithoutSecondReader"][:30])))
                 if result["pagesWithoutSecondReader"] else ""), "",
             "| 类别 | 条数 | 怎么裁 |", "|---|---|---|"]
    how = {"char": "读文字判（档 ①）", "passage": "看原图", "span": "看原图", "notes": "看原图",
           "refs": "读文字判", "heading": "看原图", "table": "看原图"}
    for kind in ("char", "passage", "span", "notes", "refs", "heading", "table"):
        if counts.get(kind):
            lines.append("| %s | %d | %s |" % (KIND_LABEL[kind], counts[kind], how[kind]))
    lines += ["", "每条：`编号` PDF 页 · 流 · 类别 ｜ MinerU 前文【MinerU】后文 ｜ VL 前文【VL】后文", ""]
    current = None
    for item in items:
        if item["page"] != current:
            current = item["page"]
            lines += ["", "## PDF 第 %d 页" % current, ""]
        if item["stream"] == "structure":
            extra = ""
            if item["kind"] == "heading":
                extra = " ｜ MinerU：%s ｜ VL：%s" % ("；".join(item["md_headings"] or []) or "—",
                                                   "；".join(item["vl_headings"] or []) or "—")
            lines.append("- `%s` %s：MinerU %s，VL %s%s" % (item["id"], item["what"], item["md"], item["vl"], extra))
            continue
        stream = "正文" if item["stream"] == "body" else "注文"
        lines.append("- `%s` %s·%s ｜ %s【%s】%s ｜ %s【%s】%s" % (
            item["id"], stream, KIND_LABEL[item["kind"]],
            item["md_before"], item.get("md_raw") or item["md"] or "∅", item["md_after"],
            item["vl_before"], item.get("vl_raw") or item["vl"] or "∅", item["vl_after"]))
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")


def book_files(book: Path) -> list[str]:
    path = book / "_数据" / "book.json"
    if path.is_file():
        data = json.loads(path.read_text(encoding="utf-8"))
        return [item["path"] for item in data.get("files", [])]
    return sorted(p.name for p in book.glob("*.md") if not p.name.endswith((".AI校注.md", ".疑字清单.md")))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--book", type=Path, required=True)
    parser.add_argument("--vl", type=Path, required=True, help="PaddleOCR-VL per-page results (pNNNN.json)")
    parser.add_argument("--md", action="append", default=[], help="Markdown files in book order (default: book.json)")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--passage", type=int, default=20, help="one side has >= this many extra characters: passage")
    args = parser.parse_args()
    files = args.md or book_files(args.book)
    result = run(args.book, args.vl, files, args.passage)
    out = args.out or args.book / "_数据" / "冲突清单"
    out.mkdir(parents=True, exist_ok=True)
    (out / "conflicts.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    write_markdown(result, out / "冲突清单.md")
    kinds: dict[str, int] = {}
    for item in result["items"]:
        kinds[item["kind"]] = kinds.get(item["kind"], 0) + 1
    print("CROSSCHECK pages=%d no_second_reader=%d items=%d %s" % (
        len(result["pagesCompared"]), len(result["pagesWithoutSecondReader"]), len(result["items"]),
        " ".join("%s=%d" % kv for kv in sorted(kinds.items()))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
