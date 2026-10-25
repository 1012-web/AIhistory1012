"""mineru_v1.py：用本地假服务器（V1 与 v4 两套端点），不联网。"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from pypdf import PdfReader, PdfWriter

SCRIPTS = Path(__file__).resolve().parents[1] / "skills" / "book2md1012" / "scripts"
CLIENT = SCRIPTS / "mineru_v1.py"
TOKEN = "sk-secret-v1-test-token"


def layout_zip(kind: str) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("full.md", "# mock\n")
        if kind == "docvortex":
            archive.writestr("x_middle.json", json.dumps({"schema": "docvortex.middle", "version": "2.0", "pages": []}))
        else:
            archive.writestr("layout.json", json.dumps({"_version_name": "3.4.4", "_ocr_enable": kind != "txtparse",
                                                        "pdf_info": [{"page_idx": 0, "para_blocks": []}]}))
    return buffer.getvalue()


class Fake(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    mode = "ok"
    known_sha: set[str] = set()
    log: list[dict] = []

    def log_message(self, *_args):
        pass

    def record(self, body=None):
        type(self).log.append({"method": self.command, "path": self.path, "auth": self.headers.get("Authorization"),
                               "idem": self.headers.get("Idempotency-Key"), "body": body})

    def send_json(self, value, status=200):
        data = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_bytes(self, data: bytes):
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            return json.loads(raw) if raw else None
        except ValueError:
            return {"_bytes": len(raw)}

    def base(self):
        return f"http://127.0.0.1:{self.server.server_port}"

    def do_POST(self):
        payload = self.body()
        self.record(payload)
        if self.path == "/v1/uploads":
            sha = payload["sha256sum"]
            file = {"id": "file-" + sha[:8], "object": "file", "sha256sum": sha}
            if sha in type(self).known_sha:
                return self.send_json({"id": "up-" + sha[:8], "status": "completed", "upload_url": None, "file": file})
            return self.send_json({"id": "up-" + sha[:8], "status": "pending", "upload_method": "PUT",
                                   "upload_url": self.base() + "/oss/" + sha[:8] + "?Signature=abc",
                                   "upload_headers": {"Content-Type": "application/pdf"}})
        if self.path.startswith("/v1/uploads/") and self.path.endswith("/complete"):
            sha = payload["sha256sum"]
            type(self).known_sha.add(sha)
            return self.send_json({"status": "completed", "file": {"id": "file-" + sha[:8], "sha256sum": sha}})
        if self.path == "/v1/parse/jobs":
            return self.send_json({"job_id": "job-1", "status": "queued"}, 202)
        if self.path == "/api/v4/file-urls/batch":
            type(self).v4_names = [f["name"] for f in payload["files"]]
            urls = [self.base() + f"/v4upload/{i}" for i in range(len(payload["files"]))]
            return self.send_json({"code": 0, "msg": "ok", "data": {"batch_id": "batch-v4", "file_urls": urls}})
        self.send_json({"error": {"type": "invalid_request_error", "code": "not_found"}}, 404)

    def do_PUT(self):
        self.record(self.body())
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self.record()
        if self.path == "/v1/usage":
            return self.send_json({"object": "usage", "current": {"pages_processed": 3}, "limits": {"max_pages_per_file": 200}})
        if self.path == "/v1/parse/jobs/job-1":
            if type(self).mode == "job_failed":
                return self.send_json({"job_id": "job-1", "status": "failed", "files": [{"status": "failed"}]})
            return self.send_json({"job_id": "job-1", "status": "completed", "files": [{
                "status": "completed", "page_range": "1-3", "parse": {"model_used": "vlm"},
                "output_files": {"zip": {"file_id": "file-zip"}}}]})
        if self.path == "/v1/files/file-zip/content":
            self.send_response(302)
            self.send_header("Location", self.base() + "/cdn/result.zip")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        if self.path == "/cdn/result.zip":
            return self.send_bytes(layout_zip(type(self).mode if type(self).mode in ("docvortex", "txtparse") else "ok"))
        if self.path == "/api/v4/extract-results/batch/batch-v4":
            results = [{"file_name": name, "state": "done", "full_zip_url": self.base() + f"/v4zip/{i}.zip"}
                       for i, name in enumerate(type(self).v4_names)]
            return self.send_json({"code": 0, "msg": "ok", "data": {"batch_id": "batch-v4", "extract_result": results}})
        if self.path.startswith("/v4zip/"):
            return self.send_bytes(layout_zip("ok"))
        self.send_json({"error": {"code": "not_found"}}, 404)


@pytest.fixture()
def server():
    Fake.mode, Fake.known_sha, Fake.log = "ok", set(), []
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield httpd
    httpd.shutdown()
    httpd.server_close()
    thread.join(timeout=5)


def make_pdf(path: Path, pages: int = 3) -> Path:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=595, height=842)
    with path.open("wb") as handle:
        writer.write(handle)
    return path


def submit(server, tmp_path: Path, *extra: str) -> tuple[subprocess.CompletedProcess, dict]:
    env = os.environ.copy()
    env.update({"MINERU_API_TOKEN": TOKEN, "MINERU_SKILL_CONFIG_DIR": str(tmp_path / "config"),
                "MINERU_V1_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1",
                "MINERU_API_BASE_URL": f"http://127.0.0.1:{server.server_port}/api/v4"})
    pdf = tmp_path / "书.pdf"
    if not pdf.exists():
        make_pdf(pdf)
    out = tmp_path / "MinerU"
    result = subprocess.run([sys.executable, str(CLIENT), "submit", str(pdf), "-o", str(out), "--ocr-mode", "ocr",
                             "--poll-interval", "1", "--timeout", "30", *extra],
                            env=env, capture_output=True, text=True, timeout=60)
    reports = sorted(out.glob("_mineru_v1_report_*.json"), key=lambda p: p.stat().st_mtime_ns)
    report = json.loads(reports[-1].read_text(encoding="utf-8")) if reports else {}
    for path in out.rglob("*"):
        if path.is_file() and path.suffix in (".json", ".txt"):
            assert TOKEN not in path.read_text(encoding="utf-8", errors="replace")
    assert TOKEN not in result.stdout + result.stderr
    return result, report


def test_v1_happy_path_uploads_parses_and_checks_structure(server, tmp_path: Path) -> None:
    result, report = submit(server, tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    item = report["results"][0]
    assert item["backend"] == "v1" and item["instant_upload"] is False
    assert item["structure"]["version"] == "3.4.4"
    directory = Path(item["directory"])
    side = json.loads((directory / "_lunzhu2md_source.json").read_text(encoding="utf-8"))
    assert side["page_start"] == 1 and side["backend"] == "v1" and side["ocr_mode"] == "ocr"
    posts = [e for e in Fake.log if e["method"] == "POST" and e["path"].startswith("/v1/")]
    assert posts and all(e["idem"] for e in posts)                     # 每个 POST 都带 Idempotency-Key
    job = next(e for e in Fake.log if e["path"] == "/v1/parse/jobs")["body"]
    assert job["ocr_mode"] == "ocr" and job["output_formats"] == ["zip"] and "page_range" not in job["files"][0]
    cdn = next(e for e in Fake.log if e["path"] == "/cdn/result.zip")
    assert cdn["auth"] is None                                         # 跟随重定向不带令牌
    oss = next(e for e in Fake.log if e["path"].startswith("/oss/"))
    assert oss["auth"] is None
    assert report["usage_before"]["current"]["pages_processed"] == 3


def test_second_submit_of_the_same_file_is_an_instant_upload(server, tmp_path: Path) -> None:
    submit(server, tmp_path)
    before = len([e for e in Fake.log if e["method"] == "PUT"])
    result, report = submit(server, tmp_path)
    assert result.returncode == 0
    assert report["results"][0]["instant_upload"] is True
    assert len([e for e in Fake.log if e["method"] == "PUT"]) == before


def test_page_range_is_sent_to_v1_and_recorded_for_build(server, tmp_path: Path) -> None:
    result, report = submit(server, tmp_path, "--page-range", "2")
    assert result.returncode == 0, result.stdout + result.stderr
    job = next(e for e in Fake.log if e["path"] == "/v1/parse/jobs")["body"]
    assert job["files"][0]["page_range"] == "2-2"
    directory = Path(report["results"][0]["directory"])
    assert directory.name == "书.pages-0002-0002.mineru"
    side = json.loads((directory / "_lunzhu2md_source.json").read_text(encoding="utf-8"))
    assert side["page_start"] == 2 and side["page_end"] == 2
    origin = next(directory.glob("*_origin.pdf"))
    assert len(PdfReader(str(origin)).pages) == 1


@pytest.mark.parametrize("mode", ["job_failed", "docvortex", "txtparse"])
def test_v1_failure_or_docvortex_structure_falls_back_to_v4(server, tmp_path: Path, mode: str) -> None:
    Fake.mode = mode
    result, report = submit(server, tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "FALLBACK_V4" in result.stdout
    item = report["results"][0]
    assert item["backend"] == "v4" and item["fallback_reason"]
    assert item["structure"]["version"] == "3.4.4"
    assert any(e["path"] == "/api/v4/file-urls/batch" for e in Fake.log)
    side = json.loads((Path(item["directory"]) / "_lunzhu2md_source.json").read_text(encoding="utf-8"))
    assert side["backend"] == "v4" and side["is_ocr"] is True        # ocr_mode=ocr → is_ocr=true
    assert report["update_skill_suggested"] is (mode == "docvortex")
    assert ("NOTICE_UPDATE_SKILL" in result.stdout) is (mode == "docvortex")


def test_no_fallback_reports_the_failure(server, tmp_path: Path) -> None:
    Fake.mode = "job_failed"
    result, report = submit(server, tmp_path, "--no-fallback")
    assert result.returncode == 2
    assert report["results"][0]["state"] == "failed"
    assert not any(e["path"].startswith("/api/v4/") for e in Fake.log)
