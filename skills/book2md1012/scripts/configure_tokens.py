"""两家 OCR 的本机配置窗口。空输入不覆盖已有凭据，不回显已保存的令牌。

python -X utf8 configure_tokens.py
无需 Obsidian。保存复用原客户端；网络验证只在用户点击后执行。
"""
from __future__ import annotations

import os
import queue
import sys
import tempfile
import threading
import urllib.error
import webbrowser
from pathlib import Path

import mineru_api
import mineru_v1
import paddle_api

SERVICES = ("mineru", "paddle")
NAMES = {"mineru": "MinerU", "paddle": "PaddleOCR"}
URLS = {"mineru": "https://mineru.net/apiManage", "paddle": "https://aistudio.baidu.com/paddleocr"}
ENV_NAMES = {"mineru": mineru_api.TOKEN_ENV, "paddle": paddle_api.TOKEN_ENV}


def config_presence(service):
    """Only report presence; never load/decrypt a saved secret for the UI."""
    path = mineru_api.config_path() if service == "mineru" else paddle_api.settings_path()
    local = bool(mineru_api.read_json(path, {}).get("token"))
    env = bool(os.environ.get(ENV_NAMES[service], "").strip())
    if env:
        return "当前使用环境变量；本机保存不会替换它。"
    return "本机已保存；留空保留原令牌。" if local else "尚未配置；请从官网复制令牌后粘贴。"


def save_token(service, value):
    value = value.strip()
    if not value:
        return "未更改。"  # Empty input is never a request to erase credentials.
    if service == "mineru":
        config = mineru_api.load_config()
        mineru_api.store_token(value, config["daily_file_quota"], config["priority_page_quota"])
    else:
        paddle_api.store_token(value)
    if os.environ.get(ENV_NAMES[service], "").strip():
        return "已保存到本机，尚未验证；当前调用仍优先使用环境变量。"
    return "已保存到本机，尚未验证。"


def verify_service(service):
    """Validate the effective config, including the existing environment precedence."""
    if service == "mineru":
        client = mineru_v1.Client(mineru_api.load_token(), timeout=20)
        result = client.usage()
        if isinstance(result, dict) and result.get("code") not in (None, 0):
            # Preserve the service code for UI classification, never its raw body.
            raise RuntimeError("MinerU API code " + str(result["code"]))
        if not isinstance(result, dict) or not isinstance(result.get("current"), dict):
            raise RuntimeError("Unexpected usage response")
        return "验证通过：认证和用量接口可用。"
    token = paddle_api.load_token()
    model = paddle_api.current_model(None)
    with tempfile.TemporaryDirectory(prefix="aihistory-paddle-check-") as tmp:
        sample = Path(tmp) / "blank.pdf"
        paddle_api.blank_pdf(sample)
        job = paddle_api.submit_file(token, sample, model)
        paddle_api.poll_job(token, job, interval=2, timeout=90)
    return "验证通过：认证与空白页解析任务可用。"


def safe_error(exc, saving=False):
    """No raw exception bodies/URLs: upstream errors may echo the submitted token."""
    if saving and isinstance(exc, OSError):
        return "保存失败：请检查本机配置目录权限。"
    # Existing clients wrap HTTP errors. Inspect for classification, never display.
    detail = str(exc)
    if "A0211" in detail:
        return "验证失败：MinerU 令牌已过期（A0211）。点击官网按钮生成新令牌，粘贴、保存后重新验证，无需重装。"
    if "A0202" in detail:
        return "验证失败：MinerU 令牌不正确（A0202）。请复制完整令牌，不含 Bearer 前缀或引号；必要时在官网重新生成。"
    if "401" in detail or "403" in detail:
        return "验证失败：令牌无效、已过期或没有访问权限。请在官网检查令牌状态，更新后保存并重新验证。"
    if "429" in detail or "-60018" in detail or "-60019" in detail:
        return "验证失败：请求限频或账号额度受限。请查看官网额度与限制，稍后重试；无需重装或反复更换令牌。"
    if isinstance(exc, TimeoutError) or "timed out" in detail.lower():
        return "验证失败：连接超时。请检查网络或稍后重试，不能据此判断令牌过期。"
    if isinstance(exc, urllib.error.URLError) or "request failed" in detail.lower():
        return "验证失败：无法连接服务。请检查网络和服务状态；这不表示令牌已过期。"
    if "not configured" in detail.lower() or "empty" in detail.lower():
        return "尚未配置：请先粘贴令牌并保存。"
    return "操作未完成：请检查网络、服务状态、令牌权限与账号额度后重试。"


class TokenWindow:
    def __init__(self, root, backend=None):
        import tkinter as tk
        from tkinter import ttk, messagebox

        self.root, self.messagebox = root, messagebox
        self.backend = backend or sys.modules[__name__]
        self.events = queue.Queue()
        self.busy = set()
        self.fields, self.messages, self.presence, self.entries, self.buttons, self.message_labels = {}, {}, {}, {}, {}, {}
        root.title("AIhistory1012 · 配置 OCR 令牌")
        root.minsize(720, 650)
        root.geometry("720x650")
        style = ttk.Style(root)
        if "vista" in style.theme_names():
            style.theme_use("vista")
        style.configure("TLabel", font=("Microsoft YaHei UI", 10))
        style.configure("Heading.TLabel", font=("Microsoft YaHei UI", 17, "bold"))
        style.configure("Service.TLabel", font=("Microsoft YaHei UI", 12, "bold"))
        style.configure("TButton", font=("Microsoft YaHei UI", 10), padding=(12, 6))
        style.configure("Status.TLabel", foreground="#4c5864")
        frame = ttk.Frame(root, padding=24)
        frame.pack(fill="both", expand=True)
        frame.columnconfigure(0, weight=1)
        ttk.Label(frame, text="配置两家云端识别服务", style="Heading.TLabel").grid(sticky="w")
        ttk.Label(frame, text="从官网复制令牌，粘贴后保存。以后 AI 会自动使用，无需每次提供。",
                  wraplength=650).grid(sticky="w", pady=(8, 16))
        for i, service in enumerate(SERVICES, 1):
            box = ttk.Frame(frame, padding=(0, 8, 0, 12))
            box.grid(row=i * 2, column=0, sticky="ew")
            box.columnconfigure(0, weight=1)
            ttk.Label(box, text=NAMES[service], style="Service.TLabel").grid(row=0, column=0, sticky="w")
            ttk.Button(box, text="打开官网获取令牌", command=lambda s=service: webbrowser.open(URLS[s])).grid(row=0, column=1, sticky="e")
            self.presence[service] = tk.StringVar()
            try:
                self.presence[service].set(self.backend.config_presence(service))
            except Exception:
                self.presence[service].set("配置文件无法读取；请检查文件或联系 AI 处理。")
            ttk.Label(box, textvariable=self.presence[service], wraplength=630).grid(row=1, column=0, columnspan=2, sticky="w", pady=(6, 8))
            self.fields[service] = tk.StringVar()
            entry = ttk.Entry(box, textvariable=self.fields[service], show="●", font=("Segoe UI", 11))
            entry.grid(row=2, column=0, sticky="ew", padx=(0, 12), ipady=4)
            self.entries[service] = entry
            button = ttk.Button(box, text="验证当前配置" if service == "mineru" else "验证（空白测试页）",
                                command=lambda s=service: self.verify(s))
            button.grid(row=2, column=1, sticky="e")
            self.buttons[service] = button
            self.messages[service] = tk.StringVar(value="未验证。")
            label = ttk.Label(box, textvariable=self.messages[service], style="Status.TLabel", wraplength=630)
            label.grid(row=3, column=0, columnspan=2, sticky="w", pady=(8, 0))
            self.message_labels[service] = label
            self.fields[service].trace_add("write", lambda *_args, s=service: self.input_changed(s))
            if service == "mineru":
                ttk.Separator(frame).grid(row=3, sticky="ew", pady=4)
        ttk.Label(frame, text="保存仅写入本机，不联网。验证 MinerU 只查询用量；验证 PaddleOCR 会发送程序生成的 1 页空白 PDF，可能消耗 1 页额度，不发送你的文献。",
                  wraplength=650).grid(row=6, sticky="w", pady=(10, 8))
        privacy = ("令牌由 Windows 当前用户加密保存；输入框不会显示已有令牌。" if os.name == "nt" else
                   "当前系统保存为仅本用户可读的文件（未加密）；不显示已有令牌。")
        ttk.Label(frame, text=privacy, wraplength=650).grid(row=7, sticky="w", pady=(0, 12))
        footer = ttk.Frame(frame)
        footer.grid(row=8, sticky="ew", pady=(4, 0))
        footer.columnconfigure(0, weight=1)
        self.summary = tk.StringVar(value="留空的服务保持不变。令牌不需要发给 AI。")
        ttk.Label(footer, textvariable=self.summary, wraplength=400).grid(row=0, column=0, sticky="w")
        self.save_button = ttk.Button(footer, text="保存令牌", command=self.save_all)
        self.save_button.grid(row=0, column=1, padx=(10, 0))
        ttk.Button(footer, text="关闭", command=self.close).grid(row=0, column=2, padx=(10, 0))
        root.protocol("WM_DELETE_WINDOW", self.close)
        self.poll_id = root.after(100, self.poll)

    def set_message(self, service, message):
        self.messages[service].set(message)
        color = ("#a12c2c" if any(word in message for word in ("失败", "未完成", "尚未配置")) else
                 "#235b45" if message.startswith("验证通过") else "#4c5864")
        self.message_labels[service].configure(foreground=color)

    def input_changed(self, service):
        if self.fields[service].get():
            self.set_message(service, "新输入尚未保存、未验证。")

    def save_one(self, service):
        value = self.fields[service].get()
        if not value.strip():
            return True
        try:
            self.set_message(service, self.backend.save_token(service, value))
            self.fields[service].set("")
            self.presence[service].set(self.backend.config_presence(service))
            return True
        except Exception as exc:
            self.set_message(service, safe_error(exc, saving=True))
            return False

    def save_all(self):
        if self.busy:
            return
        changed = [s for s in SERVICES if self.fields[s].get().strip()]
        results = [self.save_one(s) for s in changed]
        self.summary.set("保存完成；可分别点击验证。" if changed and all(results) else
                         "部分令牌未保存，请查看对应提示。" if changed else "没有新令牌，原配置保持不变。")

    def verify(self, service):
        if service in self.busy:
            return
        if service == "paddle" and not self.messagebox.askokcancel(
                "验证 PaddleOCR", "将向 PaddleOCR 发送程序生成的 1 页空白 PDF，可能消耗 1 页额度，不上传你的文献。继续吗？", parent=self.root):
            return
        if not self.save_one(service):
            return
        self.busy.add(service)
        self.buttons[service].configure(state="disabled")
        self.entries[service].configure(state="disabled")
        self.save_button.configure(state="disabled")
        self.set_message(service, "正在验证，请稍候……")
        def work():
            try:
                message = self.backend.verify_service(service)
            except Exception as exc:
                message = safe_error(exc)
            self.events.put((service, message))
        threading.Thread(target=work, daemon=True).start()

    def poll(self):
        while not self.events.empty():
            service, message = self.events.get_nowait()
            if os.environ.get(ENV_NAMES[service], "").strip():
                message += "（本次验证的是环境变量。）"
            self.set_message(service, message)
            self.busy.discard(service)
            self.buttons[service].configure(state="normal")
            self.entries[service].configure(state="normal")
        if not self.busy:
            self.save_button.configure(state="normal")
        self.poll_id = self.root.after(100, self.poll)

    def close(self):
        if self.busy:
            self.summary.set("验证尚未结束，请等待结果后关闭。")
            return
        if any(v.get() for v in self.fields.values()) and not self.messagebox.askokcancel(
                "还有未保存的令牌", "关闭将放弃输入框中尚未保存的内容。继续吗？", parent=self.root):
            return
        for field in self.fields.values():
            field.set("")
        self.root.after_cancel(self.poll_id)
        self.root.destroy()


def main():
    try:
        import tkinter as tk
    except ImportError:
        print("GUI_UNAVAILABLE: use mineru_api.py configure and paddle_api.py configure locally.")
        return 1
    try:
        root = tk.Tk()
    except tk.TclError:
        print("GUI_UNAVAILABLE: use mineru_api.py configure and paddle_api.py configure locally.")
        return 1
    TokenWindow(root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
