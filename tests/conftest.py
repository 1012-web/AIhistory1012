from __future__ import annotations

import importlib.util
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "tests" / "fixtures"
sys.path.insert(0, str(FIX))
import make_fixtures  # noqa: E402


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


page_tool = _load("page_tool", ROOT / "skills" / "lunzhu2md-fix" / "scripts" / "page_tool.py")
audit_scan = _load("audit_scan", ROOT / "skills" / "lunzhu2md-audit" / "scripts" / "audit_scan.py")


@pytest.fixture(scope="session")
def pt():
    return page_tool


@pytest.fixture(scope="session")
def au():
    return audit_scan


@pytest.fixture(scope="session")
def fixture_pdf() -> Path:
    """《新史學》排印本（有文字层，23 页，公版，CC BY-SA 4.0），存在仓库里。"""
    return FIX / make_fixtures.PDF_NAME


def _copy_book(kind: str, tmp_path: Path, pdf: Path) -> Path:
    dst = tmp_path / kind / make_fixtures.BOOK
    shutil.copytree(FIX / kind / make_fixtures.BOOK, dst)
    shutil.copyfile(pdf, dst / make_fixtures.PDF_NAME)
    return dst


@pytest.fixture
def clean_book(tmp_path, fixture_pdf) -> Path:
    """clean 书文件夹的临时副本（带现造的 PDF，测试可以随便改）。"""
    return _copy_book("clean", tmp_path, fixture_pdf)


@pytest.fixture
def broken_book(tmp_path, fixture_pdf) -> Path:
    return _copy_book("broken", tmp_path, fixture_pdf)


@pytest.fixture(scope="session")
def synth_pdf(tmp_path_factory) -> Path:
    """3 页的小 PDF：每页一行中文，用来测渲染与文字层，不依赖外部文件。"""
    try:
        import pymupdf
    except ImportError:
        import fitz as pymupdf  # type: ignore
    out = tmp_path_factory.mktemp("synth") / "小样.pdf"
    doc = pymupdf.open()
    for i in range(1, 4):
        page = doc.new_page(width=300, height=400)
        page.insert_text((30, 60), f"第{i}页正文甲乙丙丁", fontname="china-s", fontsize=14)
    doc.save(str(out))
    doc.close()
    return out


def write(p: Path, text: str) -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8", newline="\n")
    return p
