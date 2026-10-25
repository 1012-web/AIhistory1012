from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "skills" / "book2md1012" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import configure_tokens as ui


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv(ui.mineru_api.CONFIG_DIR_ENV, str(tmp_path))
    for name in ui.ENV_NAMES.values():
        monkeypatch.delenv(name, raising=False)
    return tmp_path


@pytest.mark.parametrize("service", ui.SERVICES)
def test_save_compatible_encrypted_and_blank_unchanged(isolated, service, capsys):
    message = ui.save_token(service, "test-private-value")
    assert "尚未验证" in message
    path = ui.mineru_api.config_path() if service == "mineru" else ui.paddle_api.settings_path()
    before = path.read_bytes()
    if os.name == "nt":
        assert b"test-private-value" not in before
    assert "本机已保存" in ui.config_presence(service)
    ui.save_token(service, "  ")
    assert path.read_bytes() == before
    loader = ui.mineru_api.load_token if service == "mineru" else ui.paddle_api.load_token
    assert loader() == "test-private-value"
    assert "test-private-value" not in capsys.readouterr().out


def test_preserves_existing_settings_and_environment_precedence(isolated, monkeypatch):
    ui.mineru_api.store_token("old", 7, 31)
    ui.paddle_api.write_json(ui.paddle_api.settings_path(), {"model": "custom-model", "usage": {"pages": 12}})
    ui.save_token("mineru", "new")
    ui.save_token("paddle", "other")
    config = ui.mineru_api.load_config()
    assert (config["daily_file_quota"], config["priority_page_quota"]) == (7, 31)
    config = ui.paddle_api.read_json(ui.paddle_api.settings_path(), {})
    assert config["model"] == "custom-model" and config["usage"]["pages"] == 12
    monkeypatch.setenv(ui.ENV_NAMES["mineru"], "environment-value")
    assert "环境变量" in ui.config_presence("mineru")
    assert ui.mineru_api.load_token() == "environment-value"
    assert "仍优先使用环境变量" in ui.save_token("mineru", "another-new")


def test_mineru_validation_is_usage_only(isolated, monkeypatch):
    ui.save_token("mineru", "fake")
    class Client:
        def __init__(self, token, timeout):
            assert token == "fake" and timeout == 20
        def usage(self):
            return {"current": {}, "limits": {}}
    monkeypatch.setattr(ui.mineru_v1, "Client", Client)
    assert "验证通过" in ui.verify_service("mineru")


def test_paddle_validation_uses_generated_blank_page(isolated, monkeypatch):
    from pypdf import PdfReader
    ui.save_token("paddle", "fake")
    calls = []
    def submit(token, pdf, model):
        assert token == "fake" and model == ui.paddle_api.DEFAULT_MODEL
        reader = PdfReader(pdf)
        assert len(reader.pages) == 1 and not reader.pages[0].extract_text()
        calls.append("submit")
        return "test-job"
    def poll(token, job, interval, timeout):
        assert token == "fake" and job == "test-job" and timeout == 90
        calls.append("done")
        return {"state": "done"}
    monkeypatch.setattr(ui.paddle_api, "submit_file", submit)
    monkeypatch.setattr(ui.paddle_api, "poll_job", poll)
    assert "验证通过" in ui.verify_service("paddle")
    assert calls == ["submit", "done"]


def test_errors_never_echo_upstream_secret():
    assert "private-token" not in ui.safe_error(RuntimeError("HTTP 401 private-token"))
    assert "private-token" not in ui.safe_error(RuntimeError("server echo private-token"))
    assert "保存失败" in ui.safe_error(PermissionError("private-token"), saving=True)
    assert "保存失败" not in ui.safe_error(TimeoutError("private-token"))


def test_window_mask_save_failure_validation_and_cancel(isolated, monkeypatch):
    tk = pytest.importorskip("tkinter")
    try:
        root = tk.Tk()
    except tk.TclError:
        pytest.skip("No graphical display for Tk")
    root.withdraw()
    saved, checked = [], []
    def save(service, value):
        if service == "paddle":
            raise PermissionError("do-not-display-this-token")
        saved.append((service, value))
        return "已保存到本机，尚未验证。"
    def verify(service):
        checked.append(service)
        return "验证通过。"
    fake = SimpleNamespace(config_presence=lambda s: "测试：未配置。", save_token=save, verify_service=verify)
    app = ui.TokenWindow(root, backend=fake)
    try:
        assert all(not field.get() for field in app.fields.values())
        assert all(entry.cget("show") for entry in app.entries.values())
        app.fields["mineru"].set("test-input")
        app.fields["paddle"].set("test-input")
        app.save_all()
        assert saved == [("mineru", "test-input")]
        assert not app.fields["mineru"].get() and app.fields["paddle"].get()
        assert "部分" in app.summary.get() and "保存失败" in app.messages["paddle"].get()
        monkeypatch.setattr(app.messagebox, "askokcancel", lambda *a, **k: False)
        app.verify("paddle")
        assert not checked
        app.fields["paddle"].set("")
        app.verify("mineru")
        until = time.monotonic() + 2
        while app.busy and time.monotonic() < until:
            root.update()
            time.sleep(.02)
        assert checked == ["mineru"] and "验证通过" in app.messages["mineru"].get()
        assert not app.busy
    finally:
        root.after_cancel(app.poll_id)
        root.destroy()
