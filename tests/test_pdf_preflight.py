from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from collections import defaultdict
from pathlib import Path
import subprocess
import sys

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "skills" / "book2md1012" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import pdf_preflight as preflight


def write(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", errors="strict", newline="") as handle:
        handle.write(value)


def test_text_presence_requires_user_choice_without_quality_scoring():
    for value in ("正常文字。Another sentence.", "甲\ufffd\ue001", "古文" * 120):
        evidence = preflight.text_evidence(value)
        result = preflight.summarize([evidence], "auto")
        assert result["hasExtractableTextInSample"]
        assert result["awaitUserChoice"]
        assert result["recommendedOcrMode"] == "ocr"
        assert result["recommendation"] == "ask_user_reocr_recommended"
        assert "suspiciousCount" not in evidence
        assert "qualityScore" not in evidence
        if "\ufffd" in value:
            assert evidence["encodingWarnings"] == ["unicode_replacement_character_present"]
        else:
            assert not evidence["encodingWarnings"]
        for requested, mode in (("on", "ocr"), ("off", "txt")):
            chosen = preflight.summarize([evidence], requested)
            assert not chosen["awaitUserChoice"] and chosen["recommendedOcrMode"] == mode
    blank = preflight.text_evidence("")
    assert preflight.summarize([blank], "auto")["recommendation"] == "ocr"
    assert preflight.summarize([blank, preflight.text_evidence("x")], "auto")["sampleStatus"] == "mixed_sample"
    assert preflight.summarize([{"error": "DecodeError"}], "auto")["awaitUserChoice"]


def test_sample_distribution():
    assert preflight.sample_indexes(1) == [0]
    samples = preflight.sample_indexes(340)
    assert len(samples) == 9 and samples[0] == 0 and samples[-1] == 339


def test_preflight_real_pdf_no_input_changes(tmp_path):
    pytest.importorskip("pypdf")
    fitz = pytest.importorskip("pymupdf")
    pdf = tmp_path / "scan.pdf"
    with fitz.open() as doc:
        doc.new_page()
        doc.new_page().insert_text((40, 40), "Readable sentence.")
        doc.save(pdf)
    original = pdf.read_bytes()
    report = preflight.inspect_pdf(pdf)
    assert report["sampleStatus"] == "mixed_sample"
    assert report["networkRequests"] == report["ocrRuns"] == 0
    assert pdf.read_bytes() == original
