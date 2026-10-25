from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / "skills"

# docs/ 是唯一源，skill 里放同内容的副本，装到别的平台时才能自包含。
MIRRORED = ("anchors.md", "division-of-labor.md")


def test_mirrored_docs_match():
    for name in MIRRORED:
        src = ROOT / "docs" / name
        dst = SKILLS / "book2md1012" / "references" / name
        assert src.is_file(), f"缺 docs/{name}"
        assert dst.is_file(), f"缺 skills/book2md1012/references/{name}"
        assert src.read_bytes() == dst.read_bytes(), (
            f"{name} 的两份内容不一致。改 docs/{name} 之后，"
            f"要同步覆盖 skills/book2md1012/references/{name}（skill 单独安装时要能自包含）"
        )


LINK = re.compile(r"\]\(([^)\s]+)\)")


def _local_links(text: str):
    """收集 Markdown 里的本地链接（跳过 http、锚点、代码块）。"""
    lines, in_fence, out = text.splitlines(), False, []
    for line in lines:
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for target in LINK.findall(line):
            if target.startswith(("http://", "https://", "#", "mailto:")):
                continue
            if not target.endswith(".md"):
                continue          # 只查文档链接；图片、示例路径不算
            if any(tok in target for tok in ("…", "xxx", "<", ">")):
                continue          # 模板里的占位符
            out.append(target.split("#", 1)[0])
    return [t for t in out if t]


def test_skill_links_resolve_inside_repo():
    missing = []
    for md in SKILLS.rglob("*.md"):
        for target in _local_links(md.read_text(encoding="utf-8")):
            if not (md.parent / target).resolve().is_file():
                missing.append(f"{md.relative_to(ROOT)} → {target}")
    assert not missing, "以下链接指向不存在的文件：\n" + "\n".join(missing)


def test_skills_have_frontmatter_name():
    for skill in sorted(p for p in SKILLS.iterdir() if p.is_dir()):
        md = skill / "SKILL.md"
        assert md.is_file(), f"{skill.name} 缺 SKILL.md"
        text = md.read_text(encoding="utf-8")
        assert text.startswith("---\n"), f"{md.relative_to(ROOT)} 缺 frontmatter"
        head = text.split("---", 2)[1]
        assert f"name: {skill.name}" in head, f"{md.relative_to(ROOT)} 的 name 与文件夹名不一致"
        assert "description:" in head, f"{md.relative_to(ROOT)} 缺 description"
