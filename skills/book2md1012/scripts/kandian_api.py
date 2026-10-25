"""看典古籍逐页图像客户端；竖排主来源，输出交 AI 整理，不伪造脚注分类。

configure 隐藏输入账号与令牌；status 本地检查；usage 查询激活与额度；
submit PDF -o DIR [--pages 1-3] 按原 PDF 页号保存原始结果与带锚点的文本底稿。
"""
from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

from mineru_api import ClientError, _dpapi_protect, _dpapi_unprotect, config_dir

API_BASE = "https://ocr.kandianguji.com"


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8", errors="strict"))


def write_json(path, value, private=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8", errors="strict")
    if private and os.name != "nt":
        path.chmod(0o600)


def settings_path():
    return config_dir() / "kandian.json"


def configure():
    account = getpass.getpass("Kandian account (hidden): ").strip()
    token = getpass.getpass("Kandian token (hidden): ").strip()
    if not account or not token:
        raise ClientError("Account and token must not be empty")
    payload = {"email": account, "token": token}
    if os.name == "nt":
        payload = {"storage": "windows-dpapi", "protected": _dpapi_protect(json.dumps(payload))}
    write_json(settings_path(), payload, private=True)
    print("CONFIGURED")


def credentials():
    token, account = os.environ.get("KANDIAN_API_TOKEN", "").strip(), os.environ.get("KANDIAN_ACCOUNT", "").strip()
    if token and account:
        return {"token": token, "email": account}
    path = settings_path()
    if not path.is_file():
        raise ClientError("NOT_CONFIGURED: run kandian_api.py configure locally")
    data = read_json(path)
    if data.get("storage") == "windows-dpapi":
        data = json.loads(_dpapi_unprotect(data["protected"]))
    if not data.get("email") or not data.get("token"):
        raise ClientError("NOT_CONFIGURED: missing account or token")
    return {"token": data["token"], "email": data["email"]}


def configured():
    # Do not load/decrypt secrets merely to report local presence.
    return bool((os.environ.get("KANDIAN_API_TOKEN") and os.environ.get("KANDIAN_ACCOUNT"))
                or settings_path().is_file())


def request(endpoint, auth, fields=None):
    payload = dict(auth)
    payload.update(fields or {})
    req = urllib.request.Request(API_BASE + endpoint,
                                 data=json.dumps(payload).encode("utf-8", errors="strict"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            result = json.loads(response.read().decode("utf-8", errors="strict"))
    except urllib.error.HTTPError as exc:
        raise ClientError(f"Kandian HTTP {exc.code}") from None
    except (urllib.error.URLError, TimeoutError):
        raise ClientError("Kandian network request failed") from None
    except (ValueError, UnicodeError):
        raise ClientError("Kandian returned invalid JSON") from None
    if not isinstance(result, dict) or result.get("message") != "success":
        # Keep the actionable server explanation, but remove authentication values.
        detail = redact(result.get("info", "") if isinstance(result, dict) else "", auth)
        raise ClientError("Kandian rejected request: " + str(detail)[:300])
    return result


def redact(value, auth):
    if isinstance(value, dict):
        return {k: ("<REDACTED>" if k.lower() in ("token", "email") else redact(v, auth))
                for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v, auth) for v in value]
    if isinstance(value, str):
        for secret in auth.values():
            value = value.replace(secret, "<REDACTED>")
    return value


def page_numbers(spec, total):
    if not spec:
        return list(range(1, total + 1))
    pages = set()
    try:
        for group in spec.split(","):
            parts = group.strip().split("-")
            if len(parts) not in (1, 2):
                raise ValueError
            lo, hi = int(parts[0]), int(parts[-1])
            if not 1 <= lo <= hi <= total:
                raise ValueError
            pages.update(range(lo, hi + 1))
    except ValueError:
        raise ClientError("Invalid --pages; use physical pages such as 1,3-5") from None
    return sorted(pages)


def normalized_page(raw, number):
    data = raw.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("text_lines"), list):
        raise ClientError("Kandian response is missing positioned text_lines")
    blocks = []
    for line in data["text_lines"]:
        if not isinstance(line.get("text"), str):
            raise ClientError("Kandian text line is missing text")
        # These are coarse official labels, not inferred note/title categories.
        blocks.append({"block_label": "text" if line.get("layout_classes_id", 0) == 0 else "header",
                       "block_content": line["text"], "polygon": line.get("position"),
                       "source_layout_class": line.get("layout_classes_id")})
    return {"page": number, "source": "kandian", "version": "v2",
            "width": data.get("width"), "height": data.get("height"),
            "parsing_res_list": blocks, "structure_review_required": True}


def submit(args):
    import pymupdf
    source = args.pdf.resolve()
    stat = source.stat()
    identity = {"source": str(source), "size": stat.st_size, "mtime_ns": stat.st_mtime_ns,
                "dpi": args.dpi, "det_mode": "sp", "version": "v2"}
    out = args.output.resolve()
    manifest = out / "_source.json"
    if manifest.exists() and read_json(manifest) != identity:
        raise ClientError("Output belongs to a different input/settings; choose a new output directory")
    if not manifest.exists() and out.exists() and any(out.iterdir()):
        raise ClientError("Output is nonempty without a source record; choose a new directory")
    auth = credentials()
    with pymupdf.open(source) as doc:
        pages = page_numbers(args.pages, len(doc))
        write_json(manifest, identity)
        for number in pages:
            target = out / f"p{number:04d}.json"
            if target.is_file():
                continue
            raw_path = out / "_raw" / f"p{number:04d}.json"
            if raw_path.is_file():
                raw = read_json(raw_path)
            else:
                pix = doc[number - 1].get_pixmap(dpi=args.dpi)
                raw = request("/ocr_api", auth, {
                    "image": base64.b64encode(pix.tobytes("png")).decode("ascii"),
                    "det_mode": "sp", "version": "v2", "image_size": 0,
                    "return_position": True, "return_choices": True,
                    "det_layout": True, "return_layout": True, "char_ocr": False})
                raw = redact(raw, auth)
                write_json(raw_path, raw)
            write_json(target, normalized_page(raw, number))
            print(f"PAGE_OK page={number}")
    # Only explicit line contents are concatenated; AI must reconstruct notes/headings.
    chunks = []
    for number in pages:
        page = read_json(out / f"p{number:04d}.json")
        text = "\n\n".join(b["block_content"] for b in page["parsing_res_list"] if b["block_label"] == "text")
        chunks.append(f"<!--pdf-page.{number}-->\n\n{text}")
    (out / "_skeleton.md").write_text("\n\n".join(chunks) + "\n", encoding="utf-8", errors="strict")
    print(f"DONE pages={len(pages)} structure_review_required=true")


def main():
    parser = argparse.ArgumentParser(description="Kandian vertical image OCR client")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("configure", "status", "usage"):
        sub.add_parser(name)
    p = sub.add_parser("submit")
    p.add_argument("pdf", type=Path)
    p.add_argument("-o", "--output", required=True, type=Path)
    p.add_argument("--pages")
    p.add_argument("--dpi", type=int, default=200)
    args = parser.parse_args()
    try:
        if args.command == "configure":
            configure()
        elif args.command == "status":
            print("CONFIGURED" if configured() else "NOT_CONFIGURED")
            return 0 if configured() else 3
        elif args.command == "usage":
            data = request("/get_token_status", credentials()).get("data") or {}
            print("USAGE active=%s total=%s used=%s" % (data.get("is_active"), data.get("total_count"), data.get("used_count")))
        else:
            if not 72 <= args.dpi <= 600:
                raise ClientError("DPI must be between 72 and 600")
            submit(args)
        return 0
    except (ClientError, OSError, ValueError) as exc:
        # Paths or OS messages can contain non-ASCII: encode message for stdout.
        print("ERROR " + str(exc).encode("ascii", errors="backslashreplace").decode("ascii"))
        return 1


if __name__ == "__main__":
    sys.exit(main())
