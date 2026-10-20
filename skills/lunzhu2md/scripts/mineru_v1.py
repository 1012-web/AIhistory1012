"""MinerU 云端 V1 接口客户端（主），失败或结构异常时自动退回 v4（mineru_api.py）。

V1 流程（官方文档 opendatalab/MinerU docs/next/api，2026-10-20 实测）：
  POST /v1/uploads（带 sha256sum，命中已有文件即「秒传」，不再传字节）→ PUT 预签名地址 → POST /v1/uploads/{id}/complete
  → POST /v1/parse/jobs（ocr_mode、page_range、output_formats=["zip"]）→ 轮询 GET /v1/parse/jobs/{id}（2 秒起、指数退避、最长 30 秒）
  → GET /v1/files/{file_id}/content（302 到 CDN，跟随时不带令牌）→ 解压 → 先查中间结构的 schema。
所有 POST 都带 Idempotency-Key（按文件哈希与参数算），中断后重跑不会重复建任务。

退回 v4 的条件：V1 请求失败（网络、HTTP 错误、任务 failed/partial/canceled、超时），或产物不是 3.x 结构
（没有 layout.json / middle.json、schema 是 docvortex 4.0）。v4 仍交 3.4.4 结构。--no-fallback 关掉退回。

ocr_mode：auto 自动判断、txt 用文字层、ocr 强制 OCR。导入前先跑 pdf_preflight.py，显式传，不要依赖 auto
（实测论文 auto 走了文字层，3.4.4 的文字层抽取把中文标点吞成空格或 <sub>）。退回 v4 时 ocr→is_ocr=true，txt→false，auto→本地抽样判断。

令牌沿用 mineru_api.py configure 存的那份（环境变量 MINERU_API_TOKEN 优先；Windows 用 DPAPI 加密）。
令牌绝不打印、不写盘：日志与报告里出现的一律替换成 <TOKEN>，预签名地址的签名部分去掉。

用法：
  python mineru_v1.py usage
  python mineru_v1.py submit <原件>.pdf -o <书>/_数据/MinerU --ocr-mode ocr [--page-range 37] [--no-fallback]
stdout 只打 ASCII 行；报告写 <输出目录>/_mineru_v1_report_*.json。
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mineru_api as v4  # noqa: E402
from _common import SOURCE_SIDECAR, SchemaError, check_schema, find_files  # noqa: E402

V1_BASE = "https://mineru.net/api/v1"
V1_BASE_ENV = "MINERU_V1_BASE_URL"
OCR_MODES = ("auto", "txt", "ocr")
TERMINAL = {"completed", "partial", "failed", "canceled"}
USER_AGENT = "aihistory1012-lunzhu2md/0.1"


class V1Error(RuntimeError):
    """V1 这条路走不通（网络、HTTP、任务失败、结构不对），调用方据此退回 v4。"""


class Client:
    def __init__(self, token: str, base: str | None = None, timeout: int = 120) -> None:
        self.token = token
        self.base = (base or os.environ.get(V1_BASE_ENV) or V1_BASE).rstrip("/")
        self.timeout = timeout
        self.opener = urllib.request.build_opener(_NoRedirect)

    def redact(self, text: str) -> str:
        if self.token and self.token in text:
            text = text.replace(self.token, "<TOKEN>")
        return text

    def call(self, method: str, path: str, payload: Any = None, idempotency_key: str | None = None) -> dict[str, Any]:
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Accept": "application/json", "User-Agent": USER_AGENT, "Authorization": f"Bearer {self.token}"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                body = response.read().decode("utf-8", "replace")
                status = response.status
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")
            raise V1Error(self.redact(f"V1 {method} {path} HTTP {exc.code}: {body[:500]}")) from None
        except (urllib.error.URLError, OSError) as exc:
            raise V1Error(self.redact(f"V1 {method} {path} failed: {exc}")) from None
        try:
            parsed = json.loads(body) if body else {}
        except json.JSONDecodeError:
            raise V1Error(f"V1 {method} {path} returned non-JSON (HTTP {status})") from None
        if isinstance(parsed, dict) and parsed.get("error"):
            raise V1Error(self.redact(f"V1 {method} {path} error: {json.dumps(parsed['error'], ensure_ascii=False)[:500]}"))
        return parsed

    def usage(self) -> dict[str, Any]:
        return self.call("GET", "/usage")

    def upload(self, path: Path, sha: str) -> tuple[str, bool]:
        """返回 (file_id, 是否秒传)。"""
        size = path.stat().st_size
        created = self.call("POST", "/uploads", {
            "filename": path.name, "bytes": size, "mime_type": "application/pdf",
            "purpose": "parse", "sha256sum": sha,
        }, idempotency_key=f"upload-{sha}")
        if created.get("status") == "completed" and (created.get("file") or {}).get("id"):
            return created["file"]["id"], True
        url = created.get("upload_url")
        if not url or created.get("status") != "pending":
            raise V1Error(f"V1 upload session in unexpected state: {created.get('status')}")
        put_bytes(url, created.get("upload_method") or "PUT", created.get("upload_headers") or {}, path)
        done = self.call("POST", f"/uploads/{created['id']}/complete", {"sha256sum": sha},
                         idempotency_key=f"complete-{created['id']}")
        file_id = (done.get("file") or {}).get("id")
        if done.get("status") != "completed" or not file_id:
            raise V1Error("V1 upload complete did not return a file")
        return file_id, False

    def create_job(self, file_id: str, ocr_mode: str, page_range: str | None, tier: str | None) -> dict[str, Any]:
        entry: dict[str, Any] = {"source": {"type": "file_id", "file_id": file_id}}
        if page_range:
            entry["page_range"] = page_range
        payload: dict[str, Any] = {"files": [entry], "ocr_mode": ocr_mode, "output_formats": ["zip"]}
        if tier:
            payload["tier"] = tier
        key = "job-" + hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()[:40]
        return self.call("POST", "/parse/jobs", payload, idempotency_key=key)

    def poll(self, job_id: str, timeout: float, sleep=time.sleep) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        delay, last = 2.0, ""
        while True:
            job = self.call("GET", f"/parse/jobs/{job_id}")
            status = job.get("status", "")
            if status != last:
                print(f"V1_STATUS job={job_id} status={status}")
                last = status
            if status in TERMINAL:
                return job
            if time.monotonic() >= deadline:
                raise V1Error(f"V1 job {job_id} timed out")
            sleep(delay)
            delay = min(delay * 2, 30.0)

    def download(self, file_id: str, destination: Path) -> None:
        request = urllib.request.Request(self.base + f"/files/{file_id}/content",
                                         headers={"Authorization": f"Bearer {self.token}", "User-Agent": USER_AGENT})
        try:
            with self.opener.open(request, timeout=300) as response:
                destination.write_bytes(response.read())
                return
        except urllib.error.HTTPError as exc:
            if exc.code not in (301, 302, 303, 307, 308):
                raise V1Error(f"V1 download {file_id} HTTP {exc.code}") from None
            location = exc.headers.get("Location")
        except (urllib.error.URLError, OSError) as exc:
            raise V1Error(f"V1 download {file_id} failed: {exc}") from None
        if not location:
            raise V1Error(f"V1 download {file_id}: redirect without Location")
        # 跟随重定向时不带令牌：CDN 地址自带签名
        try:
            with urllib.request.urlopen(urllib.request.Request(location, headers={"User-Agent": USER_AGENT}),
                                        timeout=300) as response:
                destination.write_bytes(response.read())
        except (urllib.error.URLError, OSError) as exc:
            raise V1Error(f"V1 download {file_id} from CDN failed: {exc}") from None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def put_bytes(url: str, method: str, headers: dict[str, str], path: Path) -> None:
    data = path.read_bytes()
    request = urllib.request.Request(url, data=data, method=method,
                                     headers={**headers, "Content-Length": str(len(data))})
    host = urllib.parse.urlsplit(url).hostname
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            if not 200 <= response.status < 300:
                raise V1Error(f"V1 PUT to {host} HTTP {response.status}")
    except urllib.error.HTTPError as exc:
        raise V1Error(f"V1 PUT to {host} HTTP {exc.code}") from None
    except (urllib.error.URLError, OSError) as exc:
        raise V1Error(f"V1 PUT to {host} failed: {exc}") from None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_page_range(value: str | None, total: int) -> tuple[int, int] | None:
    """本客户端只接受一段连续页「N」或「N-M」（1 起）：重跑单页或一小段时用。"""
    if not value:
        return None
    parts = value.replace("~", "-").split("-")
    try:
        start, end = (int(parts[0]), int(parts[-1])) if len(parts) in (1, 2) else (0, 0)
    except ValueError:
        start, end = 0, 0
    if not 1 <= start <= end <= total:
        raise v4.ClientError(f"--page-range must be N or N-M within 1-{total}: {value}")
    if end - start + 1 > v4.MAX_PAGES:
        raise v4.ClientError(f"--page-range covers more than {v4.MAX_PAGES} pages")
    return start, end


def check_result_dir(directory: Path) -> dict[str, Any]:
    """解压后的产物是不是本 skill 读得了的 3.x 结构；不是就抛 SchemaError（调用方退回 v4）。"""
    layout = find_files(str(directory))["layout"]
    if not layout:
        raise SchemaError(f"no layout.json / middle.json in {directory.name}")
    data = json.loads(Path(layout).read_text(encoding="utf-8"))
    version, ocr = check_schema(data, Path(layout).name)
    return {"layout": Path(layout).name, "version": version, "ocr_enable": ocr, "pages": len(data["pdf_info"])}


def write_sidecar(directory: Path, info: dict[str, Any]) -> None:
    (directory / SOURCE_SIDECAR).write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")


def v4_ocr_flag(ocr_mode: str, part_path: Path) -> bool:
    if ocr_mode == "ocr":
        return True
    if ocr_mode == "txt":
        return False
    PdfReader, _ = v4.require_pypdf()
    return v4.detect_ocr(PdfReader(str(part_path)))


def run_v1_part(client: Client, part: v4.UploadPart, output_dir: Path, ocr_mode: str,
                page_range: str | None, tier: str | None, timeout: float) -> dict[str, Any]:
    path = Path(part.path)
    sha = sha256_file(path)
    file_id, instant = client.upload(path, sha)
    print(f"V1_UPLOADED file={part.upload_name} instant={str(instant).lower()}")
    job = client.create_job(file_id, ocr_mode, page_range, tier)
    job_id = job.get("job_id")
    if not job_id:
        raise V1Error("V1 job create returned no job_id")
    final = client.poll(job_id, timeout)
    if final.get("status") != "completed":
        raise V1Error(f"V1 job {job_id} ended {final.get('status')}")
    entry = (final.get("files") or [{}])[0]
    zip_ref = (entry.get("output_files") or {}).get("zip") or {}
    if not zip_ref.get("file_id"):
        raise V1Error(f"V1 job {job_id} has no zip output")
    stem = Path(part.upload_name).stem + ".mineru"
    archive = v4.unique_path(output_dir / f"{stem}.zip")
    directory = v4.unique_path(output_dir / stem)
    client.download(zip_ref["file_id"], archive)
    v4.safe_extract(archive, directory)
    try:
        info = check_result_dir(directory)
    except SchemaError as exc:
        raise V1Error(f"V1 result structure not usable: {exc}") from None
    if ocr_mode == "ocr" and info.get("ocr_enable") is False:
        # 2026-10-20 实测：同一文件先 auto 后 ocr，V1 第二次返回的 layout.json 与第一次逐字节相同（_ocr_enable=false），
        # ocr_mode 没起作用（疑为服务端按文件缓存）。要的是 OCR，拿到的是文字层解析，退回 v4 用 is_ocr=true
        raise V1Error("V1 ignored ocr_mode=ocr: result has _ocr_enable=false (text-layer parse, possibly cached)")
    origin_info = v4.asdict(part)
    if page_range:
        origin_info["path"] = ""  # 交的是整份原件：原件副本按页段从原件切
    origin = v4.restore_origin_pdf(origin_info, directory / f"{Path(part.upload_name).stem}_origin.pdf")
    write_sidecar(directory, {"source": part.source, "page_start": part.page_start, "page_end": part.page_end,
                              "backend": "v1", "ocr_mode": ocr_mode, "job_id": job_id})
    return {"file_name": part.upload_name, "state": "done", "backend": "v1", "job_id": job_id, "instant_upload": instant,
            "page_range": entry.get("page_range"), "parse": entry.get("parse"), "archive": str(archive),
            "directory": str(directory), "origin_pdf": origin, "structure": info}


def run_v4_parts(token: str, parts: list[v4.UploadPart], output_dir: Path, ocr_mode: str,
                 poll_interval: int, timeout: int) -> list[dict[str, Any]]:
    for part in parts:
        part.is_ocr = v4_ocr_flag(ocr_mode, Path(part.path))
    batch = v4.create_and_run_batch(token, parts, output_dir, "vlm", "ch", True, True, poll_interval, timeout)
    results = []
    for result in batch["results"]:
        part = next((p for p in parts if p.upload_name == result.get("file_name")), None)
        if result.get("state") == "done" and part is not None:
            directory = Path(result["directory"])
            try:
                result["structure"] = check_result_dir(directory)
            except SchemaError as exc:
                result["state"] = "failed"
                result["error"] = f"v4 result structure not usable: {exc}"
            write_sidecar(directory, {"source": part.source, "page_start": part.page_start, "page_end": part.page_end,
                                      "backend": "v4", "ocr_mode": ocr_mode, "is_ocr": part.is_ocr,
                                      "batch_id": batch["batch_id"]})
        result["backend"] = "v4"
        result["batch_id"] = batch["batch_id"]
        results.append(result)
    return results


def range_part(source: Path, start: int, end: int) -> v4.UploadPart:
    """不切文件、整份上传（多半秒传），让 V1 按 page_range 只解析这几页。"""
    name = f"{source.stem}.pages-{start:04d}-{end:04d}.pdf"
    return v4.UploadPart(source=str(source), path=str(source), upload_name=name, data_id=f"range-{start}-{end}",
                         pages=end - start + 1, page_start=start, page_end=end, is_ocr=False)


def prepare_parts(source: Path, output_dir: Path, page_range: tuple[int, int] | None) -> list[v4.UploadPart]:
    """整本按 200 页拆卷（与 v4 同一套缓存）；给了 --page-range 时只切出这一段（v4 兜底、或原件超过 200 页时用）。"""
    cache = output_dir / "_upload_cache"
    if page_range is None:
        return v4.prepare_pdf(source, cache, "off")
    PdfReader, PdfWriter = v4.require_pypdf()
    reader = PdfReader(str(source))
    start, end = page_range
    digest = hashlib.sha256(f"{source.resolve()}|{source.stat().st_size}|{source.stat().st_mtime_ns}".encode()).hexdigest()[:12]
    folder = cache / digest
    folder.mkdir(parents=True, exist_ok=True)
    name = f"{source.stem}.pages-{start:04d}-{end:04d}.pdf"
    target = folder / name
    if not target.exists():
        partial = target.with_suffix(".pdf.partial")
        v4.write_pdf_range(reader, PdfWriter, start - 1, end, partial)
        os.replace(partial, target)
    return [v4.UploadPart(source=str(source), path=str(target), upload_name=name, data_id=f"{digest}-{start}-{end}",
                          pages=end - start + 1, page_start=start, page_end=end, is_ocr=False)]


def submit(args: argparse.Namespace, token: str, client: Client | None = None) -> dict[str, Any]:
    source = Path(args.pdf).expanduser().resolve()
    if not source.is_file() or source.suffix.lower() != ".pdf":
        raise v4.ClientError(f"Not a PDF file: {source}")
    output_dir = Path(args.output).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    PdfReader, _ = v4.require_pypdf()
    total = len(PdfReader(str(source)).pages)
    page_range = parse_page_range(args.page_range, total)
    # 重跑几页：原件不超过 200 页时整份交 V1 并带 page_range（同一文件 sha256 秒传，不重传字节）；
    # 否则或退回 v4 时，用本地切出的那几页
    server_range = page_range is not None and total <= v4.MAX_PAGES
    parts = [range_part(source, *page_range)] if server_range else prepare_parts(source, output_dir, page_range)
    client = client or Client(token)
    usage_before = None
    try:
        usage_before = client.usage()
    except V1Error as exc:
        print("V1_USAGE_UNAVAILABLE " + ascii(str(exc))[:200])
    results, fallback = [], []
    for part in parts:
        try:
            pr = f"{part.page_start}-{part.page_end}" if server_range else None
            results.append(run_v1_part(client, part, output_dir, args.ocr_mode, pr, args.tier, args.timeout))
            print(f"V1_DONE file={part.upload_name}")
        except V1Error as exc:
            reason = client.redact(str(exc))
            print("V1_FAILED " + ascii(reason)[:300])
            if args.no_fallback:
                results.append({"file_name": part.upload_name, "state": "failed", "backend": "v1", "error": reason})
            else:
                fallback.append((part, reason))
    # V1 交回 MinerU 4.0（DocVortex）结构：不停下，提示更新 skill，这几卷自动改走 v4 继续；v4 也不行才失败
    update_skill = any("DocVortex" in reason or "docvortex" in reason for _, reason in fallback)
    if update_skill:
        print("NOTICE_UPDATE_SKILL MinerU V1 now returns the 4.0 (DocVortex) structure; "
              "update the lunzhu2md skill. Continuing with the v4 API.")
    if fallback:
        print(f"FALLBACK_V4 parts={len(fallback)}")
        if server_range:
            # v4 不认这里的 page_range 用法：换成本地切出的那几页再交
            cut = prepare_parts(source, output_dir, page_range)
            fallback = [(cut[0], fallback[0][1])]
        for item in run_v4_parts(token, [p for p, _ in fallback], output_dir, args.ocr_mode,
                                 args.poll_interval, int(args.timeout)):
            reason = next((r for p, r in fallback if p.upload_name == item.get("file_name")), "")
            item["fallback_reason"] = reason
            results.append(item)
    usage_after = None
    try:
        usage_after = client.usage()
    except V1Error:
        pass
    report = {
        "created_at": dt.datetime.now().astimezone().isoformat(),
        "source": str(source), "output_dir": str(output_dir), "ocr_mode": args.ocr_mode,
        "page_range": list(page_range) if page_range else None,
        "parts": [v4.public_part(p) for p in parts], "results": results,
        "usage_before": usage_before, "usage_after": usage_after,
        "update_skill_suggested": update_skill,
    }
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    path = v4.unique_path(output_dir / f"_mineru_v1_report_{stamp}.json")
    path.write_text(client.redact(json.dumps(report, ensure_ascii=False, indent=2)), encoding="utf-8")
    print(f"DONE report={path}")
    return report


def main() -> int:
    v4.ascii_console()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("usage", help="GET /v1/usage (official daily usage and limits)")
    s = sub.add_parser("submit", help="upload one PDF, parse, download and extract")
    s.add_argument("pdf")
    s.add_argument("-o", "--output", required=True)
    s.add_argument("--ocr-mode", choices=OCR_MODES, required=True,
                   help="decide with pdf_preflight.py first; auto is not a safe default for Chinese text layers")
    s.add_argument("--page-range", help="one physical page N or a range N-M (1-based) to (re)parse only those pages")
    s.add_argument("--tier", default="standard")
    s.add_argument("--timeout", type=float, default=21600)
    s.add_argument("--poll-interval", type=int, default=5, help="v4 fallback polling interval")
    s.add_argument("--no-fallback", action="store_true", help="do not fall back to the v4 API")
    args = parser.parse_args()
    try:
        token = v4.load_token()
        if args.command == "usage":
            usage = Client(token).usage()
            current = usage.get("current") or {}
            limits = usage.get("limits") or {}
            print("V1_USAGE pages_processed=%s files_processed=%s jobs_created=%s max_pages_per_file=%s"
                  % (current.get("pages_processed"), current.get("files_processed"), current.get("jobs_created"),
                     limits.get("max_pages_per_file")))
            return 0
        report = submit(args, token)
        return 2 if any(r.get("state") != "done" for r in report["results"]) else 0
    except (v4.ClientError, V1Error) as exc:
        print("ERROR " + ascii(str(exc))[:500], file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
