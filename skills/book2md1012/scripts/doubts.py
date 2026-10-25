"""按 AI 的裁决改正文、记校注，没定的写进《<书名>.疑字清单.md》。

输入：crosscheck.py 的 conflicts.json，加一份裁决 decisions.json（AI 读冲突清单后写，格式见 SKILL.md）：
  [{"id": "C00018", "decision": "vl", "reason": "目录页与正文篇题都作「谶」", "by": "text"},
   {"id": "C00031", "decision": "md", "reason": "「霝」是 VL 误读", "by": "text"},
   {"id": "C00040", "decision": "text", "text": "某", "reason": "两家都错，看图作「某」", "by": "image"},
   {"id": "C00052", "decision": "pending", "reason": "看不清，待用户核"}]
  decision：vl 采 PaddleOCR 读法；md 保留正文；text 改成给定的字；pending 未决（进疑字清单）。
  清单里有、裁决里没写的条目，默认当 pending（--undecided skip 则不列）。

改正文的保险：只改字冲突（kind=char）里定位得到的条目；改之前核对正文那几个字仍是 crosscheck 当时看到的
（md_raw），对不上就不改、列进报告；同一文件从后往前改，偏移不互相影响；只改字，不碰锚点和注号。
每处改动在《<书名>.AI校注.md》追加一行（位置、原字、改字、依据）。

疑字清单条目的链接（约定见仓库 docs/anchors.md）：
  obsidian://aihistory-pdf-sync?vault=<库名>&file=<库内相对路径>&page=<N>&text=<现字>&ctx=<前后各约 6 字>
从书文件夹向上找含 .obsidian 的目录定库根；不在库里就只写「PDF 第 N 页」。

用法：
  python -X utf8 doubts.py --book <书> --decisions <裁决.json> [--conflicts <书>/_数据/冲突清单/conflicts.json]
                           [--undecided pending|skip] [--dry-run]
stdout 只打一行 ASCII；报告写 <书>/_数据/冲突清单/_doubts_report.json。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import urllib.parse
from pathlib import Path
from typing import Any

CTX = 6
ANCHOR_SPLIT = re.compile(r"<!--pdf-page\.\d+-->(?:<!--p\.[^>]+?-->)?")


def obsidian_registry() -> Path | None:
    """Obsidian 自己记的库清单 obsidian.json（打开过的库都在里面）。OBSIDIAN_CONFIG 可指定（测试用）。"""
    import os
    override = os.environ.get("OBSIDIAN_CONFIG")
    if override:
        return Path(override)
    home = Path.home()
    for candidate in (Path(os.environ.get("APPDATA", home / "AppData" / "Roaming")) / "obsidian" / "obsidian.json",
                      home / "Library" / "Application Support" / "obsidian" / "obsidian.json",
                      Path(os.environ.get("XDG_CONFIG_HOME", home / ".config")) / "obsidian" / "obsidian.json"):
        if candidate.is_file():
            return candidate
    return None


def registered_vaults() -> set[str] | None:
    """登记过的库（规范化的绝对路径，不分大小写）；读不到清单返回 None。"""
    path = obsidian_registry()
    if not path or not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return {str(Path(v["path"]).resolve()).casefold() for v in (data.get("vaults") or {}).values() if v.get("path")}


def vault_root(folder: Path) -> Path | None:
    """书所在的 Obsidian 库：从书文件夹往上找含 .obsidian 的目录，且它必须登记在 Obsidian 的库清单里
    （项目总目录这类误留的 .obsidian 不算）。本机读不到库清单时（没装 Obsidian）退回只看 .obsidian。"""
    known = registered_vaults()
    for candidate in [folder, *folder.parents]:
        if not (candidate / ".obsidian").is_dir():
            continue
        if known is None or str(candidate.resolve()).casefold() in known:
            return candidate
    return None


def context(text: str, start: int, end: int, size: int = CTX) -> str:
    """含现字的上下文：前后各约 size 个字，不跨页码锚点、不跨段落。"""
    left = text[max(0, start - size * 4):start]
    right = text[end:end + size * 4]
    left = ANCHOR_SPLIT.split(left)[-1].split("\n\n")[-1]
    right = ANCHOR_SPLIT.split(right)[0].split("\n\n")[0]
    return left[-size:] + text[start:end] + right[:size]


def obsidian_link(vault: Path | None, md: Path, page: int, current: str, ctx: str) -> str:
    """疑字链接一律写（docs/anchors.md 第六节）。在登记过的库里：vault + 库内相对路径；
    不在库里：省掉 vault，file 写「书文件夹名/文件名」，由插件在当前库里按路径结尾去找。"""
    if vault is not None:
        params = {"vault": vault.name, "file": md.resolve().relative_to(vault.resolve()).as_posix()}
    else:
        params = {"file": "%s/%s" % (md.resolve().parent.name, md.name)}
    params.update({"page": str(page), "text": current, "ctx": ctx})
    return "obsidian://aihistory-pdf-sync?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote, safe="")


def book_title(book: Path) -> str:
    path = book / "_数据" / "book.json"
    if path.is_file():
        title = json.loads(path.read_text(encoding="utf-8")).get("title")
        if title:
            return title
    return book.name


def apply_edits(book: Path, edits: list[dict[str, Any]], dry_run: bool) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """edits 每项带 file、start、end、md_raw、new。返回（改成的, 没改成的）。"""
    done, failed = [], []
    by_file: dict[str, list[dict[str, Any]]] = {}
    for edit in edits:
        by_file.setdefault(edit["file"], []).append(edit)
    for name, group in by_file.items():
        path = book / name
        text = path.read_text(encoding="utf-8")
        last_start = None
        for edit in sorted(group, key=lambda e: e["start"], reverse=True):
            start, end = edit["start"], edit["end"]
            if last_start is not None and end > last_start:
                failed.append({**edit, "why": "overlaps another edit"})
                continue
            if text[start:end] != edit["md_raw"]:
                failed.append({**edit, "why": "text changed since crosscheck"})
                continue
            if "<!--" in edit["md_raw"] or "[^" in edit["md_raw"] or "<!--" in edit["new"] or "[^" in edit["new"]:
                failed.append({**edit, "why": "would touch an anchor or a footnote reference"})
                continue
            text = text[:start] + edit["new"] + text[end:]
            last_start = start
            done.append(edit)
        if not dry_run:
            path.write_text(text, encoding="utf-8")
    return done, failed


def append_notes(book: Path, title: str, done: list[dict[str, Any]], dry_run: bool) -> Path:
    path = book / f"{title}.AI校注.md"
    rows = ["", "## 两家识别裁决后改动的字（%s）" % dt.date.today().isoformat(), "",
            "MinerU 与 PaddleOCR-VL 读法不同、经 AI 裁决改动的字。依据栏写「读文字」的只看了两家文字，写「看图」的核过原页。", "",
            "| 编号 | 位置 | MinerU | 改作 | 依据 |", "|---|---|---|---|---|"]
    for edit in sorted(done, key=lambda e: (e["page"], e["start"])):
        how = "看图" if edit.get("by") == "image" else "读文字"
        rows.append("| %s | PDF 第 %d 页（%s） | %s | %s | %s：%s |" % (
            edit["id"], edit["page"], edit["file"], edit["md_raw"] or "∅", edit["new"] or "（删）", how,
            (edit.get("reason") or "").replace("|", "\\|")))
    if not dry_run and done:
        if path.is_file():
            existing = path.read_text(encoding="utf-8").rstrip("\n")
        else:
            existing = "---\ntype: AI校注\nabout: %s\n---\n\n# %s · AI 校注" % (title, title)
        path.write_text(existing + "\n" + "\n".join(rows) + "\n", encoding="utf-8")
    return path


def write_sheet(book: Path, title: str, pending: list[dict[str, Any]], dry_run: bool) -> Path | None:
    path = book / f"{title}.疑字清单.md"
    if not pending:
        return None
    vault = vault_root(book)
    lines = ["---", "type: 疑字清单", "about: %s" % title, "generated: %s" % dt.date.today().isoformat(), "---", "",
             "# %s · 疑字清单" % title, "",
             "MinerU 与 PaddleOCR-VL 读法不同、AI 未能定的地方；正文未动。点链接在 Obsidian 里跳到原页、选中现字"
             "（需装 AIhistory PDF Sync 插件）。核过后在正文里直接改，并在本清单勾掉。" + (
                 "" if vault else "本书现在不在登记过的 Obsidian 库里，链接没带库名：放进库后点链接，"
                                  "插件在当前库里按「书文件夹/文件名」找。"), ""]
    current_page = None
    for item in sorted(pending, key=lambda i: (i["page"], i.get("start") or 0)):
        if item["page"] != current_page:
            current_page = item["page"]
            lines += ["", "## PDF 第 %d 页" % current_page, ""]
        md_now = item.get("md_raw") or ""
        ctx = ""
        link = None
        if item.get("file") and item.get("start") is not None:
            ctx = item.get("ctx") or ""
            link = obsidian_link(vault, book / item["file"], item["page"], md_now, ctx)
        where = "[PDF 第 %d 页](%s)" % (item["page"], link) if link else "PDF 第 %d 页" % item["page"]
        kind = {"char": "字", "passage": "整段", "span": "成片", "notes": "注数", "refs": "注号", "heading": "标题",
                "table": "表格"}.get(item["kind"], item["kind"])
        if item["stream"] == "structure":
            body = "%s：MinerU %s，VL %s" % (item.get("what", kind), item["md"], item["vl"])
        else:
            body = "%s【%s】%s ／ VL 作【%s】" % (item.get("md_before", ""), md_now or "∅", item.get("md_after", ""),
                                             item.get("vl_raw") or item.get("vl") or "∅")
        reason = item.get("reason")
        lines.append("- [ ] `%s` %s · %s · %s%s" % (item["id"], where, kind, body, ("（%s）" % reason) if reason else ""))
    if not dry_run:
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--book", type=Path, required=True)
    parser.add_argument("--conflicts", type=Path)
    parser.add_argument("--decisions", type=Path, required=True)
    parser.add_argument("--undecided", choices=("pending", "skip"), default="pending")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    conflicts_path = args.conflicts or args.book / "_数据" / "冲突清单" / "conflicts.json"
    conflicts = json.loads(conflicts_path.read_text(encoding="utf-8"))
    decisions = {d["id"]: d for d in json.loads(args.decisions.read_text(encoding="utf-8"))}
    unknown = sorted(set(decisions) - {i["id"] for i in conflicts["items"]})
    title = book_title(args.book)
    edits, pending, kept = [], [], []
    for item in conflicts["items"]:
        decision = decisions.get(item["id"])
        if decision is None:
            if args.undecided == "pending":
                pending.append(item)
            continue
        verdict = decision.get("decision")
        if verdict == "pending":
            pending.append({**item, "reason": decision.get("reason")})
        elif verdict == "md":
            kept.append(item["id"])
        elif verdict in ("vl", "text"):
            new = item.get("vl_raw", item.get("vl", "")) if verdict == "vl" else decision.get("text", "")
            if item["kind"] != "char" or item.get("start") is None or item.get("md_raw") is None:
                pending.append({**item, "reason": "裁决要改，但这条不是能自动改的字冲突：%s" % (decision.get("reason") or "")})
                continue
            edits.append({**item, "new": new, "reason": decision.get("reason"), "by": decision.get("by")})
    # 上下文在改字之前取：改过的字会让后面条目的偏移失效
    texts: dict[str, str] = {}
    for item in conflicts["items"]:
        if item.get("file") and item.get("start") is not None:
            text = texts.setdefault(item["file"], (args.book / item["file"]).read_text(encoding="utf-8"))
            item["ctx"] = context(text, item["start"], item["end"])
    for group in (pending, edits):
        for item in group:
            item["ctx"] = next((i.get("ctx") for i in conflicts["items"] if i["id"] == item["id"]), "")
    done, failed = apply_edits(args.book, edits, args.dry_run)
    for edit in failed:
        pending.append({**edit, "reason": "要改为「%s」但没改成（%s）" % (edit["new"], edit["why"])})
    notes = append_notes(args.book, title, done, args.dry_run)
    sheet = write_sheet(args.book, title, pending, args.dry_run)
    report = {"conflicts": str(conflicts_path), "decisions": str(args.decisions), "dryRun": args.dry_run,
              "applied": [e["id"] for e in done], "failed": [{"id": e["id"], "why": e["why"]} for e in failed],
              "kept": kept, "pending": [i["id"] for i in pending], "unknownDecisionIds": unknown,
              "notes": str(notes), "sheet": str(sheet) if sheet else None}
    out = conflicts_path.parent / "_doubts_report.json"
    if not args.dry_run:
        out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print("DOUBTS applied=%d failed=%d kept=%d pending=%d unknown_ids=%d" % (
        len(done), len(failed), len(kept), len(pending), len(unknown)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
