"""找行：把 PDF 交 PaddleOCR 云端的普通识别（PP-OCRv6），只取每一行的行框（附它自己认的字，只作参考），
存成文字层脚本认的「行框文件」。字仍用 MinerU 的；这里不改正文、不选字。

行框文件格式（pdf_textlayer.py 读；换别家找行时照这个格式写一份即可，不用改代码）：
  {"version": 1, "source": "PaddleOCR PP-OCRv6", "units": "fraction",
   "pages": {"11": {"lines": [{"box": [x0, y0, x1, y1], "text": "该行 OCR 认的字（可省）"}, ...]}, ...}}
  页号是原 PDF 的物理页（1 起）；box 是相对页宽、页高的 0–1 比例，原点在左上；行按 OCR 给的顺序。

页面会上传到百度飞桨服务器；扫描件本来就交过 PaddleOCR-VL 的，不新增暴露面，未刊稿等先问用户。
令牌与 paddle_api.py 共用（configure 存的那份；或 --token-file），绝不打印。

用法：
  python -X utf8 paddle_lines.py submit <书>/<原件>.pdf -o <书>/_数据/PaddleOCR行框 [--pages 1-339]
  python -X utf8 paddle_lines.py convert <原始.jsonl> --pages 4,7,11 -o <行框.json>     # 已有原始结果时转换
产出：<out>/lines.json（行框文件，已有的页保留、新页补进）、<out>/_raw/*.jsonl（原始返回）。stdout 只打 ASCII。
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import paddle_api as pa  # noqa: E402

MODEL = "PP-OCRv6"
PAYLOAD = {"useDocOrientationClassify": False, "useDocUnwarping": False, "useTextlineOrientation": False}
CHUNK = 100


def lines_from_jsonl(jsonl: str, pages: list[int]) -> dict[str, Any]:
    """PP-OCRv6 的 JSONL 原始结果 → 行框文件里的 pages。pages 是上传文件里各页对应的原 PDF 物理页，按顺序。"""
    out: dict[str, Any] = {}
    index = 0
    for raw in jsonl.splitlines():
        if not raw.strip():
            continue
        result = json.loads(raw)["result"]
        infos = (result.get("dataInfo") or {}).get("pages") or []
        for number, ocr in enumerate(result.get("ocrResults") or []):
            if index >= len(pages):
                raise pa.ClientError("PaddleOCR returned more pages than were uploaded")
            pruned = ocr["prunedResult"]
            info = infos[number] if number < len(infos) else {}
            width, height = info.get("width") or pruned.get("width"), info.get("height") or pruned.get("height")
            if not width or not height:
                raise pa.ClientError("PaddleOCR result has no page size")
            boxes = pruned.get("rec_boxes") or []
            texts = pruned.get("rec_texts") or [""] * len(boxes)
            out[str(pages[index])] = {"lines": [
                {"box": [round(b[0] / width, 5), round(b[1] / height, 5), round(b[2] / width, 5), round(b[3] / height, 5)],
                 "text": t} for b, t in zip(boxes, texts)]}
            index += 1
    if index != len(pages):
        raise pa.ClientError(f"PaddleOCR returned {index} pages for {len(pages)} uploaded")
    return out


def lines_document(pages: dict[str, Any]) -> dict[str, Any]:
    return {"version": 1, "source": f"PaddleOCR {MODEL}", "units": "fraction",
            "pages": dict(sorted(pages.items(), key=lambda kv: int(kv[0])))}


def submit_chunk(token: str, pdf: Path) -> str:
    boundary = uuid.uuid4().hex
    parts = [f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode("utf-8")
             for k, v in (("model", MODEL), ("optionalPayload", json.dumps(PAYLOAD)))]
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"part.pdf\"\r\n"
                 "Content-Type: application/pdf\r\n\r\n".encode("utf-8") + pdf.read_bytes() + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    request = urllib.request.Request(pa.api_url("jobs"), data=b"".join(parts), method="POST",
                                     headers={"Authorization": f"bearer {token}",
                                              "Content-Type": f"multipart/form-data; boundary={boundary}"})
    job = (pa._read_json_response(request).get("data") or {}).get("jobId")
    if not job:
        raise pa.ClientError("PaddleOCR accepted the request but returned no jobId")
    return str(job)


def run_submit(pdf: Path, out: Path, pages_arg: str | None, token: str, interval: float, timeout: float) -> dict:
    from pypdf import PdfReader

    count = len(PdfReader(str(pdf)).pages)
    target = out / "lines.json"
    existing = json.loads(target.read_text(encoding="utf-8"))["pages"] if target.is_file() else {}
    todo = [p for p in pa.parse_pages(pages_arg, count) if str(p) not in existing]
    (out / "_raw").mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    for group in pa.chunks(todo, CHUNK):
        with tempfile.TemporaryDirectory() as temp:
            part = Path(temp) / "part.pdf"
            pa.write_chunk_pdf(pdf, group, part)
            data = pa.poll_job(token, submit_chunk(token, part), interval, timeout)
        url = (data.get("resultUrl") or {}).get("jsonUrl")
        if not url:
            raise pa.ClientError("PaddleOCR job finished without a jsonUrl")
        raw = pa.fetch_text(url)
        (out / "_raw" / f"p{group[0]:04d}-{group[-1]:04d}.jsonl").write_text(raw, encoding="utf-8")
        existing.update(lines_from_jsonl(raw, group))
        target.write_text(json.dumps(lines_document(existing), ensure_ascii=False), encoding="utf-8")
        print(f"LINES pages={group[0]}-{group[-1]} done")
    summary = {"pages": len(existing), "submitted": len(todo), "seconds": round(time.monotonic() - started, 1)}
    print("LINES_DONE pages=%(pages)d submitted=%(submitted)d seconds=%(seconds)s" % summary)
    return summary


def parse_page_list(value: str) -> list[int]:
    pages: list[int] = []
    for part in value.split(","):
        if "-" in part:
            a, b = part.split("-", 1)
            pages += list(range(int(a), int(b) + 1))
        elif part.strip():
            pages.append(int(part))
    return pages


def main() -> int:
    pa.ascii_console()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("submit")
    s.add_argument("pdf", type=Path)
    s.add_argument("-o", "--out", type=Path, required=True)
    s.add_argument("--pages", help="1-based physical pages: 17 or 17-20 (default: all)")
    s.add_argument("--token-file", type=Path)
    s.add_argument("--interval", type=float, default=3)
    s.add_argument("--timeout", type=float, default=3600)
    c = sub.add_parser("convert")
    c.add_argument("jsonl", type=Path)
    c.add_argument("--pages", required=True, help="physical pages in upload order, e.g. 4,7,11-12")
    c.add_argument("-o", "--out", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "convert":
            pages = lines_from_jsonl(args.jsonl.read_text(encoding="utf-8"), parse_page_list(args.pages))
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps(lines_document(pages), ensure_ascii=False), encoding="utf-8")
            print(f"LINES_CONVERTED pages={len(pages)}")
            return 0
        run_submit(args.pdf, args.out, args.pages, pa.load_token(args.token_file), args.interval, args.timeout)
        return 0
    except pa.ClientError as exc:
        print("ERROR " + ascii(str(exc))[:400], file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
