"""One install must contain all three operations and safely retire old entries."""
from argparse import Namespace
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("aih_install", ROOT / "install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def test_install_unified_skill_and_upgrade_legacy(tmp_path):
    for name in ("lunzhu2md", "lunzhu2md-fix", "lunzhu2md-audit"):
        old = tmp_path / name
        old.mkdir()
        (old / "SKILL.md").write_text("old entry", encoding="utf-8", errors="strict")
        (old / "personal.md").write_text("keep", encoding="utf-8", errors="strict")
    args = Namespace(target=str(tmp_path), platform="codex", keep_skill_dir_var=False,
                     dry_run=False, no_verify=False)
    assert installer.install(args) == 0
    assert [p.parent.name for p in tmp_path.glob("*/SKILL.md")] == ["book2md1012"]
    skill = tmp_path / "book2md1012"
    for name in ("page_tool.py", "audit_scan.py", "build.py", "crosscheck.py"):
        assert (skill / "scripts" / name).is_file()
    for name in ("revision.md", "audit.md"):
        text = (skill / "references" / name).read_text(encoding="utf-8", errors="strict")
        assert installer.SKILL_DIR_TOKEN not in text
        assert str(skill) in text
    for name in ("lunzhu2md", "lunzhu2md-fix", "lunzhu2md-audit"):
        old = tmp_path / name
        assert (old / "SKILL.legacy.md").read_text(encoding="utf-8", errors="strict") == "old entry"
        assert (old / "personal.md").read_text(encoding="utf-8", errors="strict") == "keep"


def test_retire_dry_run_preserves_entries(tmp_path):
    old = tmp_path / "lunzhu2md-fix"
    old.mkdir()
    (old / "SKILL.md").write_text("entry", encoding="utf-8", errors="strict")
    installer.retire_legacy_entries(tmp_path, dry_run=True)
    assert (old / "SKILL.md").is_file()
