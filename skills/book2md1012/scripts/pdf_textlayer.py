"""给扫描件（或文字层坏的 PDF）做可检索的文字层副本 <原件>.文字层.pdf。字用 MinerU 的，位置用找行的行框。

脚本只做机械的几步，内容上的事交给 AI（见 SKILL.md「脚本给证据，AI 做判断」）：

  assign  按 MinerU 自己的跨页标记把跨页段落拆回各页（与 build.py 放物理页锚点用的是同一个标记），
          再把每页 MinerU 的字按编辑距离对齐到行框文件的各行，写出分配表 assignment.json 和报告。
          对不上的不硬塞：空着的行（表格为主、也可能是 MinerU 漏行）、放不进任何行的字、疑似跨页表，
          都逐处列进报告，附 OCR 自己认的字，只作参考，不自动拿来补。写进每一行之前再核一次：
          行框上 OCR 认出的字和要写的字差得太远（如空白页上模型编出的整段字落到一条横线上）就不写，也列进报告。
  fill    把给定的字写进分配表里指定的那一行（AI 看过原页、决定了用什么字之后调用）。
  write   按分配表写文字层副本：每行一条隐形文字，横向缩放铺满行框。原件不动。
  build   assign + write 一步做完（报告里没有待定项时用）。

行框文件格式见 paddle_lines.py；没有行框文件时退回 MinerU 自己的行框（文字层路线是真的行，
OCR 路线一块只有一个整段框，报告会提醒去找行）。

页面处理：扫描页（删文字前后外观不变）删旧隐形层再写；字本来看得见的页默认原样保留（--visible-text keep）；
文字层坏了的用 --visible-text raster 把那页渲染成图换进副本再写字。

用法：
  python -X utf8 pdf_textlayer.py assign --pdf <书>/<原件>.pdf --mineru <卷1>.mineru [--mineru <卷2>.mineru]
                                         [--lines <书>/_数据/PaddleOCR行框/lines.json] [-o <书>/_数据/文字层]
  python -X utf8 pdf_textlayer.py fill --assignment <书>/_数据/文字层/assignment.json --page 85 --line 3 --text "某字"
  python -X utf8 pdf_textlayer.py write --pdf <书>/<原件>.pdf --assignment <书>/_数据/文字层/assignment.json
                                        [--output <书>/<原件>.文字层.pdf] [--visible-text keep|raster] [--dpi 200]
  python -X utf8 pdf_textlayer.py build --pdf … --mineru … [--lines …]        # 两步合一
报告：<文字层目录>/文字层报告.md（给 AI 读）、_textlayer_report.json（写入结果）。stdout 只打 ASCII。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import load_layout_doc, para_blocks, physical_pages, strip_tags, volume_start  # noqa: E402

FALLBACK_FONT_FILES = (
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simsun.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
)
VERIFY_DPI = 36
VERIFY_TOLERANCE = 0.0005
PAD = 0.006            # 行中心落在块框外这么一点也算块内（0–1 比例）
EDGE = 8               # 块首、块尾连续这么多字以上对不上的，不硬塞进行里，列进报告
# 写进一行之前的核对：行框上 OCR 认出的字和要写的字差得太远就不写，列进报告（见 line_mismatch）
CHECK_MIN = 8          # 要写的字少于这么多不查（短行一两个字认错很常见）
CHECK_SAME = 0.3       # OCR 认出了字：要写的字里和 OCR 对得上的不到这个比例，算差太远
CHECK_ROOM = 1.5       # OCR 一个字也没认出：要写的字超过行框放得下的这么多倍（再加 4），算差太远
FURNITURE = {"header", "footer", "page_number"}
TEXT_TYPES = {"text", "title", "ref_text", "list", "index", "interline_equation", "image_caption", "image_footnote",
              "table_caption", "table_footnote", "page_footnote", "header", "footer", "page_number", "aside_text",
              "table_body"}
TYPE_LABEL = {"text": "正文", "title": "标题", "ref_text": "参考文献", "list": "列表", "page_footnote": "脚注",
              "header": "页眉", "footer": "页脚", "page_number": "页码", "table": "表格", "table_body": "表格",
              "table_caption": "表题", "table_footnote": "表注", "image_caption": "图注", "image_footnote": "图注",
              "interline_equation": "公式", "aside_text": "边注", None: "不在任何 MinerU 块里"}


# ---------------------------------------------------------------- MinerU：每页的字（跨页段拆回各页）

def span_text(span: dict[str, Any]) -> str:
    if span.get("type") == "image":
        return ""
    if span.get("html"):
        return re.sub(r"<[^>]+>", "", span["html"])
    return span.get("content") or ""


def frac(box: list[float] | None, size: tuple[float, float]) -> list[float] | None:
    if not box or not size[0] or not size[1]:
        return None
    return [box[0] / size[0], box[1] / size[1], box[2] / size[0], box[3] / size[1]]


def leaf_blocks(block: dict[str, Any]) -> list[dict[str, Any]]:
    """图表块拆成子块（图注、表题、表格主体、表注），各有各的框。"""
    subs = block.get("blocks") or []
    if subs:
        out = []
        for sub in subs:
            out += leaf_blocks(sub)
        return out
    return [block]


def mineru_pieces(mineru_dirs: list[Path]) -> tuple[dict[int, list[dict[str, Any]]], list[dict[str, Any]], dict]:
    """返回 ({物理页: [片段]}, 疑似跨页表, {物理页: (宽, 高)})。片段 = {type, box(0–1 或 None), text, lines}。

    跨页段落：块里带 cross_page 的续行属于下一页（续行跨了不止一页时行框纵坐标回跳到页顶，据此再往后切）；
    它们配给那一页空出来的续段块（lines_deleted），用那个块的框。"""
    pages: dict[int, list[dict[str, Any]]] = {}
    sizes: dict[int, tuple[float, float]] = {}
    tables: list[dict[str, Any]] = []
    for directory in mineru_dirs:
        layout = load_layout_doc(str(directory))["pdf_info"]
        phys = physical_pages(layout, volume_start(str(directory)))
        deleted = {pi: [b for b in (pg.get("para_blocks") or []) if b.get("lines_deleted")]
                   for pi, pg in enumerate(layout)}
        for pi, page in enumerate(layout):
            size = tuple((page.get("page_size") or [0, 0])[:2])
            sizes[phys[pi]] = size
            for block in para_blocks(page) + (page.get("discarded_blocks") or []):
                if block.get("lines_deleted") and not block.get("lines"):
                    continue
                for leaf in leaf_blocks(block):
                    kind = leaf.get("type")
                    if kind not in TEXT_TYPES:
                        continue
                    if not leaf.get("lines"):
                        # 空块（如并进前一页的续表）：不带字，只用来标出这片区域是什么
                        pages.setdefault(phys[pi], []).append({
                            "type": "table" if kind == "table_body" else kind, "box": frac(leaf.get("bbox"), size),
                            "text": "", "lines": [], "line_texts": []})
                        continue
                    groups: list[list[Any]] = []          # [是否续行, [行], 上一行 y0]
                    for line in leaf.get("lines") or []:
                        cross = any(s.get("cross_page") for s in line.get("spans") or [])
                        y0 = (line.get("bbox") or [0, 0])[1]
                        if groups and groups[-1][0] == cross and not (cross and y0 < groups[-1][2] - 1):
                            groups[-1][1].append(line)
                            groups[-1][2] = y0
                        else:
                            groups.append([cross, [line], y0])
                    target = pi
                    for cross, lines, _ in groups:
                        text = "".join(span_text(s) for ln in lines for s in ln.get("spans") or [])
                        if not cross:
                            pages.setdefault(phys[pi], []).append({
                                "type": "table" if kind == "table_body" else kind, "box": frac(leaf.get("bbox"), size),
                                "text": strip_tags(text), "lines": [frac(ln.get("bbox"), size) for ln in lines],
                                "line_texts": [strip_tags("".join(span_text(s) for s in ln.get("spans") or []))
                                               for ln in lines]})
                            continue
                        target += 1
                        if target >= len(layout):
                            continue
                        holder = deleted[target].pop(0) if deleted[target] else None
                        tsize = tuple((layout[target].get("page_size") or [0, 0])[:2])
                        pages.setdefault(phys[target], []).append({
                            "type": kind, "box": frac(holder.get("bbox"), tsize) if holder else None,
                            "text": strip_tags(text), "lines": [], "continued_from": phys[pi]})
            # 疑似跨页表：本页有表格块、内容全空（行列都并进了前一页的表）——数据定不了哪几行属于本页
            for block in para_blocks(page):
                if block.get("type") == "table" and not "".join(
                        span_text(s) for leaf in leaf_blocks(block) for ln in leaf.get("lines") or []
                        for s in ln.get("spans") or []).strip():
                    tables.append({"page": phys[pi], "box": frac(block.get("bbox"), size),
                                   "previous_page_has_table": pi > 0 and any(
                                       b.get("type") == "table" for b in para_blocks(layout[pi - 1]))})
    return pages, tables, sizes


# ---------------------------------------------------------------- 对齐：MinerU 的字 → 行

def fold_char(char: str) -> str:
    folded = unicodedata.normalize("NFKC", char)
    return folded[0] if folded else char


SKIP = set(" \t\r\n\u3000$\\{}^_")


def comparable(text: str) -> tuple[str, list[int]]:
    """比对用的字串与每个字在原文里的下标（去空白与 LaTeX 记号，NFKC 一对一）。"""
    out, where = [], []
    for index, char in enumerate(text):
        if char in SKIP:
            continue
        out.append(fold_char(char))
        where.append(index)
    return "".join(out), where


def opcodes(a: str, b: str) -> list[tuple[str, int, int, int, int]]:
    try:
        from rapidfuzz.distance import Levenshtein
        return [(o.tag, o.src_start, o.src_end, o.dest_start, o.dest_end) for o in Levenshtein.opcodes(a, b)]
    except ImportError:
        import difflib
        return difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes()


def inside(box: list[float], area: list[float] | None) -> bool:
    if not area:
        return False
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    return area[0] - PAD <= cx <= area[2] + PAD and area[1] - PAD <= cy <= area[3] + PAD


def line_mismatch(text: str, ocr: str | None, box: list[float], size: tuple[float, float] | None) -> str | None:
    """要写进这一行的字和行框上 OCR 认出的字差得太远时，返回原因；否则 None。

    只比字、不判断谁对：MinerU 在空白页上编出整段字（模型幻觉）时，整块的字会全落到这页仅有的一行上
    （哪怕那一行只是一条横线）。这一步把这种行拦下来，列进报告交 AI 看原页，不写进文字层。"""
    # 只比字母、数字、汉字：目录的引线点、破折号 OCR 常合并成一个，不算差异
    mine = "".join(ch for ch in comparable(text)[0] if ch.isalnum())
    if len(mine) < CHECK_MIN:
        return None
    seen = "".join(ch for ch in comparable(ocr or "")[0] if ch.isalnum())
    if seen:
        same = sum(i2 - i1 for tag, i1, i2, _, _ in opcodes(mine, seen) if tag == "equal")
        if same / len(mine) < CHECK_SAME:      # 要写的字远多于 OCR 认出的，也落在这一条里
            return "要写的 %d 字里只有 %d 字与 OCR 认的字对得上" % (len(mine), same)
        return None
    width, height = size if size and size[0] and size[1] else (1.0, 1.0)
    line_w, line_h = (box[2] - box[0]) * width, (box[3] - box[1]) * height
    room = line_w / max(line_h, 6.0)              # 行高（至少 6 pt）当一个汉字宽，能放几个字
    need = sum(0.5 if ord(ch) < 0x2E80 else 1 for ch in mine)   # 西文、数字按半个字算
    if need > CHECK_ROOM * room + 4:
        return "OCR 在这一行一个字也没认出，要写的 %d 字远超行框放得下的约 %d 字" % (len(mine), round(room))
    return None


def assign_page(pieces: list[dict[str, Any]], lines: list[dict[str, Any]]) -> tuple[list[str], list[str], list[dict]]:
    """返回 (每行的字, 每行归属的块类型, 放不进的字)。"""
    owner: list[int | None] = [None] * len(lines)
    for li, line in enumerate(lines):
        for pi, piece in enumerate(pieces):
            if inside(line["box"], piece["box"]):
                owner[li] = pi
                break
    loose = [pi for pi, piece in enumerate(pieces) if piece["box"] is None]
    if loose:  # 续段没有框可依（续段块缺失）：用没归属的行
        for li in range(len(lines)):
            if owner[li] is None:
                owner[li] = loose[0]
    chars: list[list[str]] = [[] for _ in lines]
    unplaced: list[dict] = []
    for pi, piece in enumerate(pieces):
        mine = sorted((li for li in range(len(lines)) if owner[li] == pi),
                      key=lambda k: (round(lines[k]["box"][1], 3), lines[k]["box"][0]))
        src, src_at = comparable(piece["text"])
        ocr, ocr_line = "", []
        for li in mine:
            folded, _ = comparable(lines[li].get("text") or "")
            ocr += folded
            ocr_line += [li] * len(folded)
        if not src:
            continue
        matched: list[int | None] = [None] * len(src)
        if ocr:
            for tag, i1, i2, j1, j2 in opcodes(src, ocr):
                if tag in ("equal", "replace") and i2 - i1 == j2 - j1:
                    for k in range(i2 - i1):
                        matched[i1 + k] = ocr_line[j1 + k]
                elif tag == "replace":
                    for k in range(i1, i2):
                        matched[k] = ocr_line[j1 + int((k - i1) * (j2 - j1) / (i2 - i1))]
        elif mine and len(mine) == 1:
            matched = [mine[0]] * len(src)       # 这块只有一行、OCR 一字没认出：整块就是这一行
        hits = [k for k, m in enumerate(matched) if m is not None]
        if not hits and not mine and piece["type"] in FURNITURE:
            # 页码、页眉常和相邻的页眉被 OCR 框成一行（「序论3」）：OCR 那一行里正好含这几个字的，并进那一行
            host = next((li for li in range(len(lines)) if owner[li] is not None
                         and pieces[owner[li]]["type"] in FURNITURE
                         and src in comparable(lines[li].get("text") or "")[0]), None)
            if host is not None:
                ocr_host = comparable(lines[host].get("text") or "")[0]
                if ocr_host.startswith(src):
                    chars[host].insert(0, piece["text"].strip() + " ")
                else:
                    chars[host].append(" " + piece["text"].strip())
                continue
        if not hits:
            unplaced.append({"type": piece["type"], "text": piece["text"], "why": "本块范围里没有能对上的行"})
            continue
        first, last = hits[0], hits[-1]
        for k in range(first, last + 1):         # 夹在两个对上的字之间的，跟前一个字走
            if matched[k] is None:
                matched[k] = matched[k - 1]
        if first <= EDGE:
            for k in range(first):
                matched[k] = matched[first]
        else:
            unplaced.append({"type": piece["type"], "text": "".join(piece["text"][src_at[k]] for k in range(first)),
                             "why": "块首这些字对不上本页任何一行"})
        if len(src) - 1 - last <= EDGE:
            for k in range(last + 1, len(src)):
                matched[k] = matched[last]
        else:
            unplaced.append({"type": piece["type"],
                             "text": "".join(piece["text"][src_at[k]] for k in range(last + 1, len(src))),
                             "why": "块尾这些字对不上本页任何一行"})
        # 写进行里的是 MinerU 原文的字；空格跟着前一个字（西文词间空格要留）
        for k, line_index in enumerate(matched):
            if line_index is None:
                continue
            start = src_at[k]
            end = src_at[k + 1] if k + 1 < len(src_at) else len(piece["text"])
            chars[line_index].append(piece["text"][start:end].rstrip("\n"))
    texts = ["".join(c).strip() for c in chars]
    kinds = [pieces[o]["type"] if o is not None else None for o in owner]
    return texts, kinds, unplaced


def assign(pdf: Path, mineru_dirs: list[Path], lines_path: Path | None) -> dict[str, Any]:
    pieces, tables, sizes = mineru_pieces(mineru_dirs)
    if lines_path:
        data = json.loads(lines_path.read_text(encoding="utf-8"))
        if data.get("version") != 1 or data.get("units") != "fraction":
            raise ValueError("lines file must be version 1 with units=fraction (see paddle_lines.py)")
        line_pages = {int(k): v.get("lines") or [] for k, v in data["pages"].items()}
        source = data.get("source", "lines file")
    else:
        line_pages = {p: [{"box": box, "text": None} for piece in ps for box in piece["lines"] if box]
                      for p, ps in pieces.items()}
        source = "MinerU line boxes"
    out_pages: dict[str, list[dict[str, Any]]] = {}
    empty, unplaced, no_lines, mismatched = [], [], [], []
    for page in sorted(set(pieces) | set(line_pages)):
        lines = line_pages.get(page)
        if not lines:
            if any(p["text"].strip() for p in pieces.get(page, [])):
                no_lines.append(page)
            continue
        rejected: set[int] = set()
        if lines_path:
            texts, kinds, lost = assign_page(pieces.get(page, []), lines)
            for number, (ln, t, k) in enumerate(zip(lines, texts, kinds), 1):
                why = line_mismatch(t, ln.get("text"), ln["box"], sizes.get(page)) if t else None
                if why:
                    mismatched.append({"page": page, "line": number, "region": TYPE_LABEL.get(k, k),
                                       "ocr": ln.get("text") or "", "text": t, "why": why})
                    texts[number - 1] = ""
                    rejected.add(number)
        else:
            texts, kinds, lost = _fallback_texts(pieces.get(page, []))
        out_pages[str(page)] = [{"box": ln["box"], "text": t, "ocr": ln.get("text"), "region": TYPE_LABEL.get(k, k)}
                                for ln, t, k in zip(lines, texts, kinds)]
        for item in lost:
            unplaced.append({"page": page, "region": TYPE_LABEL.get(item["type"], item["type"]),
                             "text": item["text"], "why": item["why"]})
        run: dict[str, Any] | None = None
        for number, (ln, t, k) in enumerate(zip(lines, texts, kinds), 1):
            if t or number in rejected:      # 拦下的行单列在 mismatched，不算空行
                run = None
                continue
            region = TYPE_LABEL.get(k, k)
            if run and run["region"] == region and run["last"] == number - 1:
                run["lines"].append(number)
                run["ocr"].append(ln.get("text") or "")
                run["last"] = number
            else:
                run = {"page": page, "region": region, "lines": [number], "ocr": [ln.get("text") or ""], "last": number}
                empty.append(run)
    for run in empty:
        run.pop("last", None)
    return {"version": 1, "pdf": str(pdf), "lineSource": source, "pages": out_pages, "empty": empty,
            "unplaced": unplaced, "mismatched": mismatched, "crossPageTables": tables,
            "pagesWithoutLines": no_lines}


def _fallback_texts(pieces: list[dict[str, Any]]) -> tuple[list[str], list[str], list[dict]]:
    """没有行框文件：每个 MinerU 行框配它自己那一行的字（OCR 路线一块只有一行，就是整段）。"""
    texts, kinds = [], []
    for piece in pieces:
        for box, text in zip(piece["lines"], piece.get("line_texts") or []):
            if box:
                texts.append(text.strip())
                kinds.append(piece["type"])
    return texts, kinds, []


def report_markdown(result: dict[str, Any]) -> str:
    out = ["# 文字层报告", "",
           "字用 MinerU 的，行框来自：%s。下列各项脚本没有动，交给 AI 看原页决定（规则见 SKILL.md 第 5 步）：" % result["lineSource"],
           "先改正文再按改好的字写、用核过的字 `fill` 进那一行、或者留空；拿不准问用户。OCR 认的字只作参考，不要直接拿来补。", ""]
    if result["lineSource"] == "MinerU line boxes":
        out += ["**没有行框文件**：用的是 MinerU 自己的行框。OCR 路线一块只有一个整段框，选字、高亮会落在整段上；"
                "要逐行准确，先跑 `paddle_lines.py` 找行。", ""]
    if result["crossPageTables"]:
        out += ["## 疑似跨页表（MinerU 把续表并进了前一页的表，数据定不了哪几行属于本页）", ""]
        for t in result["crossPageTables"]:
            out.append("- PDF 第 %d 页：本页表格块是空的%s。正文里这一页的锚点落在整张表之后，读到续表时 PDF 会停在前一页；"
                       "要不要把锚点挪进表里、续表的字怎么写进文字层，看原页定。"
                       % (t["page"], "，前一页有表" if t["previous_page_has_table"] else ""))
        out.append("")
    if result.get("mismatched"):
        out += ["## 行框上 OCR 认的字与要写的字差得太远（%d 行，没写进文字层）" % len(result["mismatched"]), "",
                "多半是识别模型在近乎空白的页上编出了字（幻觉），也可能是行框找错了位置。看原页：页上真有这些字就 "
                "`fill` 进去，没有就留空，并核正文里是不是也混进了同一段。", "",
                "| PDF 页 | 区域 | 第几行 | 为什么 | OCR 认的字 | 本要写的字（前 80 字） |", "|---|---|---|---|---|---|"]
        for m in result["mismatched"]:
            def esc(x: str) -> str:
                return x.replace("|", "\\|").replace("\n", " ")
            out.append("| %d | %s | %d | %s | %s | %s |" % (m["page"], m["region"], m["line"], m["why"],
                                                           esc(m["ocr"][:40]) or "—", esc(m["text"][:80])))
        out.append("")
    if result["empty"]:
        out += ["## 空着的行（%d 处）" % len(result["empty"]), "",
                "| PDF 页 | 区域 | 第几行 | 空了几行 | OCR 认的字（只作参考） |", "|---|---|---|---|---|"]
        for run in result["empty"]:
            ocr = " / ".join(x for x in run["ocr"] if x)[:120].replace("|", "\\|")
            span = "%d" % run["lines"][0] if len(run["lines"]) == 1 else "%d—%d" % (run["lines"][0], run["lines"][-1])
            out.append("| %d | %s | %s | %d | %s |" % (run["page"], run["region"], span, len(run["lines"]), ocr or "—"))
        out.append("")
    if result["unplaced"]:
        out += ["## 放不进任何行的 MinerU 字（%d 处，没写进文字层）" % len(result["unplaced"]), ""]
        for item in result["unplaced"]:
            out.append("- PDF 第 %d 页 · %s · %s：%s" % (item["page"], item["region"], item["why"], item["text"][:120]))
        out.append("")
    if result["pagesWithoutLines"]:
        runs = []
        for n in result["pagesWithoutLines"]:
            if runs and n == runs[-1][1] + 1:
                runs[-1][1] = n
            else:
                runs.append([n, n])
        text = ", ".join(str(a) if a == b else "%d—%d" % (a, b) for a, b in runs)
        out += ["## 有字但没有行框的页（%d 页，这些页不写文字层）" % len(result["pagesWithoutLines"]), "",
                "PDF 第 %s 页。" % text, ""]
    if not (result["empty"] or result["unplaced"] or result.get("mismatched") or result["crossPageTables"]
            or result["pagesWithoutLines"]):
        out += ["没有待定项，可以直接 `write`。", ""]
    return "\n".join(out)


def fill(assignment: dict[str, Any], page: int, line: int, text: str) -> dict[str, Any]:
    rows = assignment["pages"].get(str(page))
    if not rows or not 1 <= line <= len(rows):
        raise ValueError(f"page {page} has no line {line}")
    rows[line - 1]["text"] = text
    rows[line - 1]["filledBy"] = "fill"
    # 空行段里填了的行逐行去掉；一段的行都填完了，这一段才从待定里消失（两行以上的段也一样）
    remaining = []
    for run in assignment["empty"]:
        if run["page"] == page and line in run["lines"]:
            keep = [(n, o) for n, o in zip(run["lines"], run["ocr"]) if n != line]
            if not keep:
                continue
            run = dict(run, lines=[n for n, _ in keep], ocr=[o for _, o in keep])
        remaining.append(run)
    assignment["empty"] = remaining
    assignment["mismatched"] = [m for m in assignment.get("mismatched", [])
                                if not (m["page"] == page and m["line"] == line)]
    return assignment


# ---------------------------------------------------------------- 写副本

@dataclass
class PageResult:
    page: int
    written: int = 0
    removed_old: bool = False
    kept_old_layer: bool = False
    rasterized: bool = False
    extracted_match: float | None = None
    notes: list[str] = field(default_factory=list)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


class FontSet:
    """首选字体加后备字体；每个字挑第一个有它的字体。"""

    def __init__(self, fallback_files: tuple[str, ...] = FALLBACK_FONT_FILES) -> None:
        import pymupdf

        self.fonts = [pymupdf.Font("cjk")]
        for file in fallback_files:
            if Path(file).exists():
                self.fonts.append(pymupdf.Font(fontfile=file))
        self.missing: set[str] = set()

    def pick(self, char: str) -> Any:
        for font in self.fonts:
            if font.has_glyph(ord(char[0])):
                return font
        self.missing.add(char)
        return self.fonts[0]


def pixmap_digest(page: Any, dpi: int = VERIFY_DPI) -> tuple[int, int, int, bytes]:
    pixmap = page.get_pixmap(dpi=dpi, alpha=False)
    return pixmap.width, pixmap.height, pixmap.n, bytes(pixmap.samples)


def changed_ratio(before: tuple, after: tuple) -> float:
    if before[:3] != after[:3]:
        return 1.0
    width, height, channels, left = before
    right = after[3]
    if left == right:
        return 0.0
    differ = sum(1 for i in range(0, len(left), channels) if left[i:i + channels] != right[i:i + channels])
    return differ / max(1, width * height)


def remove_text_layer(page: Any, verify: bool = True) -> tuple[bool, float]:
    import pymupdf

    if not page.get_text("text").strip() and not page.get_texttrace():
        return False, 0.0
    before = pixmap_digest(page) if verify else None
    page.add_redact_annot(page.rect)
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                          text=pymupdf.PDF_REDACT_TEXT_REMOVE)
    return True, (changed_ratio(before, pixmap_digest(page)) if before is not None else 0.0)


def write_line(page: Any, box: list[float], text: str, fonts: FontSet) -> int:
    """一行写成一条隐形文字：字号按行高，横向缩放到正好铺满行框（逐字分开写时阅读器抽出来一字一行）。"""
    import pymupdf

    text = "".join(ch for ch in text if ch.isprintable()).strip()
    if not text:
        return 0
    width, height = page.rect.width, page.rect.height
    x0, y0, x1, y1 = box[0] * width, box[1] * height, box[2] * width, box[3] * height
    main = fonts.fonts[0]
    size = max(0.5, (y1 - y0) / max(0.5, main.ascender - main.descender))
    baseline = y0 + size * main.ascender
    runs: list[tuple[Any, str]] = []
    for ch in text:
        font = fonts.pick(ch)
        if runs and runs[-1][0] is font:
            runs[-1] = (font, runs[-1][1] + ch)
        else:
            runs.append((font, ch))
    natural = sum(font.text_length(t, fontsize=size) for font, t in runs)
    writer = pymupdf.TextWriter(page.rect)
    point = pymupdf.Point(x0, baseline)
    for font, t in runs:
        _, point = writer.append(point, t, font=font, fontsize=size)
    scale = (x1 - x0) / natural if natural > 0 else 1.0
    writer.write_text(page, render_mode=3, morph=(pymupdf.Point(x0, baseline), pymupdf.Matrix(scale, 1)))
    return len(text)


def rasterize_page(work: Any, original: Any, index: int, dpi: int) -> Any:
    source = original[index]
    pixmap = source.get_pixmap(dpi=dpi, alpha=False)
    work.delete_page(index)
    page = work.new_page(pno=index, width=source.rect.width, height=source.rect.height)
    page.insert_image(page.rect, pixmap=pixmap)
    return page


def comparable_plain(text: str) -> str:
    return "".join(ch for ch in text if not ch.isspace())


def write(pdf: Path, pages: dict[str, list[dict[str, Any]]], output: Path, verify: bool = True,
          visible_text: str = "keep", dpi: int = 200) -> dict[str, Any]:
    """pages: {物理页: [{box, text}]}。text 为空的行不写。"""
    import difflib
    import pymupdf

    if visible_text not in ("keep", "raster"):
        raise ValueError("visible_text must be keep or raster")
    if output.resolve() == pdf.resolve():
        raise ValueError("output must be a new file; the original PDF is never modified")
    started = time.monotonic()
    source_hash = sha256(pdf)
    original, work = pymupdf.open(pdf), pymupdf.open(pdf)
    fonts = FontSet()
    results: list[PageResult] = []
    for index in range(work.page_count):
        number = index + 1
        result = PageResult(page=number)
        page = work[index]
        rows = pages.get(str(number))
        if rows is None:
            results.append(result)
            continue
        removed, ratio = remove_text_layer(page, verify)
        if removed and ratio > VERIFY_TOLERANCE:
            if visible_text == "raster":
                page = rasterize_page(work, original, index, dpi)
                result.rasterized = True
            else:
                work.delete_page(index)
                work.insert_pdf(original, from_page=index, to_page=index, start_at=index)
                result.kept_old_layer = True
                result.notes.append(f"removing text changed {ratio:.4%} of pixels; original page kept")
                results.append(result)
                continue
        result.removed_old = removed
        for row in rows:
            if row.get("text"):
                result.written += write_line(page, row["box"], row["text"], fonts)
        expected = comparable_plain("".join(r.get("text") or "" for r in rows))
        if expected:
            result.extracted_match = round(difflib.SequenceMatcher(
                None, expected, comparable_plain(page.get_text("text")), autojunk=False).ratio(), 4)
        results.append(result)
    metadata = dict(work.metadata or {})
    note = f"searchable text layer from MinerU by lunzhu2md pdf_textlayer on {datetime.now():%Y-%m-%d}"
    metadata["keywords"] = f"{metadata.get('keywords') or ''} {note}".strip()
    work.set_metadata(metadata)
    work.subset_fonts()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp")
    work.save(temporary, garbage=3, deflate=True)
    work.close()
    original.close()
    os.replace(temporary, output)
    scored = [r.extracted_match for r in results if r.extracted_match is not None]
    return {
        "version": 3, "source": str(pdf), "sourceSha256": source_hash, "output": str(output),
        "outputSha256": sha256(output), "outputBytes": output.stat().st_size, "visibleText": visible_text,
        "pages": len(results), "pagesWithText": sum(1 for r in results if r.written),
        "pagesUntouched": [r.page for r in results if str(r.page) not in pages],
        "pagesKeptOldLayer": [r.page for r in results if r.kept_old_layer],
        "pagesRasterized": [r.page for r in results if r.rasterized],
        "charactersWritten": sum(r.written for r in results), "lowestMatch": min(scored) if scored else None,
        "pagesBelow99": [r.page for r in results if r.extracted_match is not None and r.extracted_match < 0.99],
        "fontMissing": sorted(fonts.missing), "elapsedSeconds": round(time.monotonic() - started, 2),
        "sourceUnchanged": sha256(pdf) == source_hash,
    }


def default_output(pdf: Path) -> Path:
    return pdf.with_name(pdf.stem + ".文字层.pdf")


def default_dir(pdf: Path) -> Path:
    return pdf.parent / "_数据" / "文字层"


def ascii_path(path: Path) -> str:
    return str(path).encode("ascii", "backslashreplace").decode("ascii")


def save_assignment(result: dict[str, Any], folder: Path) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / "assignment.json"
    target.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    (folder / "文字层报告.md").write_text(report_markdown(result), encoding="utf-8")
    return target


def run_write(pdf: Path, assignment_path: Path, output: Path | None, visible: str, dpi: int, verify: bool) -> dict:
    assignment = json.loads(assignment_path.read_text(encoding="utf-8"))
    report = write(pdf, assignment["pages"], output or default_output(pdf), verify=verify, visible_text=visible, dpi=dpi)
    report["pendingInReport"] = {"empty": len(assignment.get("empty", [])),
                                 "unplaced": len(assignment.get("unplaced", [])),
                                 "mismatched": len(assignment.get("mismatched", [])),
                                 "crossPageTables": len(assignment.get("crossPageTables", []))}
    (assignment_path.parent / "_textlayer_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1),
                                                                   encoding="utf-8")
    pending = report["pendingInReport"]
    print("TEXTLAYER pages=%d written=%d kept=%d raster=%d lowest=%s pending_empty=%d pending_unplaced=%d "
          "pending_mismatched=%d" % (
              report["pages"], report["pagesWithText"], len(report["pagesKeptOldLayer"]), len(report["pagesRasterized"]),
              report["lowestMatch"], pending["empty"], pending["unplaced"], pending["mismatched"]))
    if not report["sourceUnchanged"]:
        raise SystemExit(4)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="action", required=True)
    for name in ("assign", "build"):
        p = sub.add_parser(name)
        p.add_argument("--pdf", type=Path, required=True)
        p.add_argument("--mineru", type=Path, action="append", required=True)
        p.add_argument("--lines", type=Path, help="lines file (paddle_lines.py); default: MinerU's own line boxes")
        p.add_argument("-o", "--out", type=Path, help="folder for assignment.json and the report")
        if name == "build":
            p.add_argument("--output", type=Path)
            p.add_argument("--visible-text", choices=("keep", "raster"), default="keep")
            p.add_argument("--dpi", type=int, default=200)
            p.add_argument("--no-verify", action="store_true")
    f = sub.add_parser("fill")
    f.add_argument("--assignment", type=Path, required=True)
    f.add_argument("--page", type=int, required=True)
    f.add_argument("--line", type=int, required=True, help="1-based line number on that page (as in the report)")
    f.add_argument("--text", required=True)
    w = sub.add_parser("write")
    w.add_argument("--pdf", type=Path, required=True)
    w.add_argument("--assignment", type=Path, required=True)
    w.add_argument("--output", type=Path)
    w.add_argument("--visible-text", choices=("keep", "raster"), default="keep")
    w.add_argument("--dpi", type=int, default=200)
    w.add_argument("--no-verify", action="store_true")
    args = parser.parse_args()
    if args.action in ("assign", "build"):
        result = assign(args.pdf, args.mineru, args.lines)
        target = save_assignment(result, args.out or default_dir(args.pdf))
        print("ASSIGNED pages=%d empty_runs=%d unplaced=%d mismatched=%d cross_page_tables=%d no_lines=%d -> %s" % (
            len(result["pages"]), len(result["empty"]), len(result["unplaced"]), len(result["mismatched"]),
            len(result["crossPageTables"]), len(result["pagesWithoutLines"]), ascii_path(target)))
        if args.action == "build":
            run_write(args.pdf, target, args.output, args.visible_text, args.dpi, not args.no_verify)
    elif args.action == "fill":
        assignment = fill(json.loads(args.assignment.read_text(encoding="utf-8")), args.page, args.line, args.text)
        save_assignment(assignment, args.assignment.parent)
        print("FILLED page=%d line=%d" % (args.page, args.line))
    else:
        run_write(args.pdf, args.assignment, args.output, args.visible_text, args.dpi, not args.no_verify)


if __name__ == "__main__":
    main()
