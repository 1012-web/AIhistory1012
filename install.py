#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AIhistory1012 安装器：把三个 skill 装到当前 agent 的技能目录，可选建一个 Obsidian 库。

只用标准库。默认不改用户已有的库（除了新建库时写 .obsidian 骨架）。

    python install.py                     # 自动探测平台并安装
    python install.py --dry-run           # 只说要做什么
    python install.py --list              # 列出探测到的平台
    python install.py --target ~/.foo/skills
    python install.py --uninstall         # 卸装（需 --yes）
    python install.py --make-vault ~/书库 --plugin-dir <含 main.js 的目录>
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import py_compile
import shutil
import sys
import tempfile
from pathlib import Path

SKILL_DIR_TOKEN = "${CLAUDE_SKILL_DIR}"

if hasattr(sys.stdout, "reconfigure"):
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

ROOT = Path(__file__).resolve().parent
SKILLS_DIR = ROOT / "skills"
VAULT_TEMPLATE = ROOT / "vault-template"
PLUGIN_ID = "aihistory-pdf-sync"
PLUGIN_FILES = ("main.js", "manifest.json", "styles.css")
DEPS = ("pymupdf", "pypdf", "yaml", "rapidfuzz")

# 已知平台的技能目录。探测不到时不要猜，交给用户/agent。
PLATFORMS = {
    "claude": ("Claude Code", "~/.claude/skills"),
    "dsh": ("DeepSeek Harness", "~/.dsh/skills"),
    "codex": ("Codex CLI", "~/.codex/skills"),
    "gemini": ("Gemini CLI", "~/.gemini/skills"),
}

STAMP = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")


def say(msg: str = "") -> None:
    print(msg)


def err(msg: str) -> None:
    print(msg, file=sys.stderr)


def expand(p: str) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(p)))


def skill_dirs() -> list[Path]:
    return sorted(p for p in SKILLS_DIR.iterdir() if p.is_dir() and (p / "SKILL.md").is_file())


def detect() -> dict[str, Path]:
    found = {}
    for key, (_label, rel) in PLATFORMS.items():
        parent = expand(rel).parent
        if parent.is_dir():
            found[key] = expand(rel)
    return found


def cmd_list() -> int:
    found = detect()
    say("探测到的平台：")
    for key, (label, rel) in PLATFORMS.items():
        mark = "✓" if key in found else "·"
        say(f"  {mark} {key:<8} {label:<20} {rel}")
    if not found:
        say("\n没有探测到已知平台。用 --target 指定技能目录：")
    say("")
    say(f"本仓库的 skill：{', '.join(p.name for p in skill_dirs())}")
    return 0


def pick_target(args) -> Path | None:
    if args.target:
        return expand(args.target)
    found = detect()
    if args.platform and args.platform != "auto":
        if args.platform not in PLATFORMS:
            err(f"未知平台：{args.platform}（可选：{', '.join(PLATFORMS)}）")
            return None
        return expand(PLATFORMS[args.platform][1])
    if len(found) == 1:
        key = next(iter(found))
        say(f"探测到 {PLATFORMS[key][0]}，技能目录 {found[key]}")
        return found[key]
    if not found:
        err("没有探测到已知平台。请用 --target <技能目录> 指定（先问用户用的是哪个 agent）。")
        cmd_list()
        return None
    err("探测到多个平台，请用 --platform 或 --target 指定其一：")
    for key, path in found.items():
        err(f"  --platform {key:<8} {PLATFORMS[key][0]}  ({path})")
    return None


def install(args) -> int:
    target = pick_target(args)
    if target is None:
        return 2
    # Claude Code 自己会替换 ${CLAUDE_SKILL_DIR}；别的平台不会，装的时候写死本机路径。
    fill = not args.keep_skill_dir_var and args.platform != "claude"
    say(f"目标目录：{target}")
    if args.dry_run:
        say("（dry-run，不写盘）")

    if not any(skill_dirs()):
        err("仓库里没有找到 skill（skills/*/SKILL.md）")
        return 2

    target.mkdir(parents=True, exist_ok=True)
    for src in skill_dirs():
        dst = target / src.name
        backup = None
        if dst.exists():
            backup = dst.with_name(f"{dst.name}.bak-{STAMP}")
            say(f"已有 {src.name}，先备份到 {backup.name}")
            if not args.dry_run:
                if backup.exists():
                    shutil.rmtree(backup)
                dst.rename(backup)
        say(f"复制 {src.name} → {target / src.name}")
        if not args.dry_run:
            shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            if fill:
                n = fill_skill_dir(dst)
                if n:
                    say(f"  把 {SKILL_DIR_TOKEN} 换成本机路径（{n} 个文档）")

    if not args.dry_run and not args.no_verify:
        return verify(target)
    return 0


def fill_skill_dir(skill_root: Path) -> int:
    """Claude Code 会替换 ${CLAUDE_SKILL_DIR}，别的平台不会——装的时候直接写死本机路径。"""
    changed = 0
    for md in skill_root.rglob("*.md"):
        text = md.read_text(encoding="utf-8")
        if SKILL_DIR_TOKEN not in text:
            continue
        md.write_text(text.replace(SKILL_DIR_TOKEN, str(skill_root)), encoding="utf-8", newline="\n")
        changed += 1
    return changed


def verify(target: Path) -> int:
    say("\n校验：")
    problems = []

    for src in skill_dirs():
        dst = target / src.name
        if not (dst / "SKILL.md").is_file():
            problems.append(f"{src.name}: 缺 SKILL.md")

    refs = target / "lunzhu2md" / "references"
    for name in ("anchors.md", "division-of-labor.md"):
        if not (refs / name).is_file():
            problems.append(f"lunzhu2md: 缺 references/{name}（安装不完整，会找不到锚点约定）")

    bad_py = []
    for py in target.glob("*/scripts/*.py"):
        try:
            with tempfile.TemporaryDirectory() as tmp:
                py_compile.compile(str(py), cfile=str(Path(tmp) / "x.pyc"), doraise=True)
        except Exception as exc:  # noqa: BLE001
            bad_py.append(f"{py.parent.name}/{py.name}: {exc}")
    problems.extend(bad_py)

    missing = []
    for mod in DEPS:
        try:
            __import__(mod)
        except Exception:  # noqa: BLE001
            missing.append(mod)
    if missing:
        say(f"  ! 缺少 Python 依赖：{', '.join(missing)}")
        say(f"    装法：python -m pip install {' '.join('pymupdf' if m == 'pymupdf' else m for m in missing)}")

    if problems:
        say("  ✗ 有 %d 个问题：" % len(problems))
        for p in problems:
            say("    - " + p)
        return 1

    say(f"  ✓ {len(skill_dirs())} 个 skill 已就位，脚本可编译，文档齐全")
    say("\n下一步：")
    say("  1. 配 MinerU 令牌（本机存一次，别贴进聊天）：")
    say(f"     python -X utf8 {target / 'lunzhu2md' / 'scripts' / 'mineru_api.py'} configure")
    say(f"  2. 让 agent 读 {target / 'lunzhu2md' / 'SKILL.md'}，然后说「把这份 PDF 导入成 Markdown」")
    return 0


def uninstall(args) -> int:
    target = pick_target(args)
    if target is None:
        return 2
    names = [p.name for p in skill_dirs()]
    if not args.yes:
        err(f"将删除 {target} 下的：{', '.join(names)}（加 --yes 确认）")
        return 2
    for name in names:
        dst = target / name
        if dst.exists():
            say(f"删除 {dst}")
            if not args.dry_run:
                shutil.rmtree(dst)
    say("已卸装。备份目录（*.bak-*）没动，需要的话自己删。")
    return 0


def make_vault(args) -> int:
    vault = expand(args.make_vault)
    name = args.vault_name or vault.name
    say(f"建库：{vault}（库名 {name}）")
    if args.dry_run:
        say("（dry-run，不写盘）")
        return 0
    if vault.exists() and any(vault.iterdir()) and not args.force:
        err(f"{vault} 已存在且非空。换一个路径，或加 --force 只补 .obsidian 骨架（不碰已有笔记和 workspace.json）。")
        return 2
    vault.mkdir(parents=True, exist_ok=True)
    tpl = VAULT_TEMPLATE / ".obsidian"
    if not tpl.is_dir():
        err(f"缺 {tpl}（模板没随仓库来）")
        return 2
    obs = vault / ".obsidian"
    for src in tpl.rglob("*"):
        if src.is_dir():
            continue
        rel = src.relative_to(tpl)
        if rel.name == "community-plugins.json" or rel.parts[0] == "snippets":
            _copy_merge(src, obs / rel, rel.as_posix())
        elif (obs / rel).exists():
            say(f"  跳过已有 {rel}")
        else:
            (obs / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, obs / rel)
            say(f"  写入 .obsidian/{rel.as_posix()}")

    installed_plugin = False
    if args.plugin_dir:
        pdir = expand(args.plugin_dir)
        missing = [f for f in PLUGIN_FILES if not (pdir / f).is_file()]
        if missing:
            err(f"{pdir} 里缺 {', '.join(missing)}")
        else:
            dst = obs / "plugins" / PLUGIN_ID
            dst.mkdir(parents=True, exist_ok=True)
            for f in PLUGIN_FILES:
                shutil.copyfile(pdir / f, dst / f)
            say(f"  插件已放进 .obsidian/plugins/{PLUGIN_ID}/")
            installed_plugin = True

    plugins_json = obs / "community-plugins.json"
    ids = []
    if plugins_json.is_file():
        try:
            ids = json.loads(plugins_json.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            ids = []
    if installed_plugin and PLUGIN_ID not in ids:
        ids.append(PLUGIN_ID)
        plugins_json.write_text(json.dumps(ids, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    say("\n下一步：")
    say(f"  1. 打开库：obsidian://open?vault={name}")
    if not installed_plugin:
        say("     （还没装插件：下载 Release 里的 main.js / manifest.json / styles.css，")
        say("      放进 .obsidian/plugins/aihistory-pdf-sync/，或用 --plugin-dir <目录> 重跑）")
    say("  2. 首次打开若提示「限制模式 / 是否信任此库」，选信任并启用社区插件（这步只能人工点一次）")
    say("  3. 把 PDF 和导入好的书文件夹放进去，打开 01-正文.md 即可左右对照")
    return 0


def _copy_merge(src: Path, dst: Path, label: str = "") -> None:
    """snippets 直接覆盖；community-plugins.json 合并，不丢用户已启用的插件。"""
    dst.parent.mkdir(parents=True, exist_ok=True)
    label = label or dst.name
    if src.name == "community-plugins.json" and dst.is_file():
        try:
            old = json.loads(dst.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            old = []
        try:
            new = json.loads(src.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            new = []
        merged = list(dict.fromkeys([*old, *new]))
        dst.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        say(f"  合并 .obsidian/{label}（{len(old)} → {len(merged)} 项）")
        return
    shutil.copyfile(src, dst)
    say(f"  写入 .obsidian/{label}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="AIhistory1012 安装器")
    ap.add_argument("--target", help="技能目录（不给则按平台探测）")
    ap.add_argument("--platform", default="auto", help="auto|claude|dsh|codex|gemini")
    ap.add_argument("--dry-run", action="store_true", help="只说做什么，不写盘")
    ap.add_argument("--no-verify", action="store_true")
    ap.add_argument("--list", action="store_true", help="列出探测到的平台")
    ap.add_argument("--uninstall", action="store_true")
    ap.add_argument("--yes", action="store_true", help="卸装时确认")
    ap.add_argument("--make-vault", metavar="DIR", help="建一个 Obsidian 库（不需要 Obsidian 在场）")
    ap.add_argument("--vault-name", help="库名（默认取文件夹名）")
    ap.add_argument("--plugin-dir", help="含 main.js/manifest.json/styles.css 的目录")
    ap.add_argument("--force", action="store_true", help="已存在的库只补骨架，不覆盖笔记")
    ap.add_argument("--keep-skill-dir-var", action="store_true",
                    help=f"保留 {SKILL_DIR_TOKEN}，不换成本机路径（给会自己替换的平台用）")
    args = ap.parse_args(argv)

    if args.list:
        return cmd_list()
    if args.uninstall:
        return uninstall(args)
    if args.make_vault:
        return make_vault(args)
    return install(args)


if __name__ == "__main__":
    sys.exit(main())
