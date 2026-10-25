from __future__ import annotations

import importlib.util
import io
import json
import sys
from argparse import Namespace
from pathlib import Path

import pymupdf
import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "skills" / "book2md1012" / "scripts"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("kandian_api", SCRIPTS / "kandian_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


def sample():
    return {"message": "success", "data": {"width": 100, "height": 200, "text_lines": [
        {"text": "正文甲", "position": [[1, 1], [2, 1], [2, 5], [1, 5]], "layout_classes_id": 0},
        {"text": "版心", "layout_classes_id": 1}]}}


def test_request_official_schema_and_secret_redaction(monkeypatch):
    auth = {"token": "test-secret", "email": "test@example.com"}
    def respond(req, timeout):
        assert req.full_url == "https://ocr.kandianguji.com/ocr_api"
        body = json.loads(req.data.decode("utf-8", errors="strict"))
        assert body["token"] == auth["token"] and body["det_mode"] == "sp"
        return io.BytesIO(json.dumps(sample()).encode("utf-8"))
    monkeypatch.setattr(api.urllib.request, "urlopen", respond)
    assert api.request("/ocr_api", auth, {"det_mode": "sp"}) == sample()
    clean = api.redact({"info": "test-secret test@example.com", "token": "test-secret"}, auth)
    assert "test-secret" not in json.dumps(clean) and "test@example.com" not in json.dumps(clean)


def test_response_error_does_not_echo_secrets(monkeypatch):
    monkeypatch.setattr(api.urllib.request, "urlopen", lambda *a, **k: io.BytesIO(
        b'{"message":"error","info":"test-secret"}'))
    with pytest.raises(api.ClientError) as exc:
        api.request("/ocr_api", {"token": "test-secret", "email": "account"})
    assert "test-secret" not in str(exc.value)


def test_pages_and_coarse_labels():
    assert api.page_numbers("3,1-2,2", 4) == [1, 2, 3]
    for invalid in ("0", "4-2", "5", "a", "1-2-3"):
        with pytest.raises(api.ClientError):
            api.page_numbers(invalid, 4)
    page = api.normalized_page(sample(), 7)
    assert page["page"] == 7 and page["source"] == "kandian"
    assert [b["block_label"] for b in page["parsing_res_list"]] == ["text", "header"]
    assert page["structure_review_required"] is True
    with pytest.raises(api.ClientError):
        api.normalized_page({"data": ["unpositioned text"]}, 1)


def test_submit_real_pdf_resume_and_persist_raw_before_adaptation(tmp_path, monkeypatch):
    source = tmp_path / "source.pdf"
    with pymupdf.open() as doc:
        doc.new_page()
        doc.new_page()
        doc.save(source)
    calls = []
    monkeypatch.setattr(api, "credentials", lambda: {"token": "secret", "email": "account"})
    def respond(endpoint, auth, fields):
        assert fields["version"] == "v2" and fields["return_position"] is True
        assert fields["det_mode"] == "sp" and fields["char_ocr"] is False
        calls.append(endpoint)
        return sample()
    monkeypatch.setattr(api, "request", respond)
    args = Namespace(pdf=source, output=tmp_path / "out", pages="2", dpi=72)
    api.submit(args)
    api.submit(args)
    assert calls == ["/ocr_api"]
    text = (args.output / "_skeleton.md").read_text(encoding="utf-8", errors="strict")
    assert "<!--pdf-page.2-->" in text and "正文甲" in text and "版心" not in text
    assert (args.output / "_raw" / "p0002.json").is_file()
    assert api.read_json(args.output / "p0002.json")["page"] == 2
    args.dpi = 100
    with pytest.raises(api.ClientError, match="different input/settings"):
        api.submit(args)


def test_configure_hidden_store_roundtrip_and_status_no_decrypt(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "settings_path", lambda: tmp_path / "kandian.json")
    values = iter(["account", "secret"])
    monkeypatch.setattr(api.getpass, "getpass", lambda prompt: next(values))
    api.configure()
    assert api.configured() is True
    assert api.credentials() == {"email": "account", "token": "secret"}
