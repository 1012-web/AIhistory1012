"""Local PDF text-layer evidence, without OCR, upload, or credentials."""
from __future__ import annotations

import argparse
import json
import unicodedata
from pathlib import Path


def sample_indexes(total: int, limit: int = 9) -> list[int]:
    if total < 1 or limit < 2:
        raise ValueError("PDF must have pages and sample limit must be >= 2")
    count = min(total, limit)
    return sorted({round(i * (total - 1) / max(1, count - 1)) for i in range(count)})


def text_evidence(text: str) -> dict:
    visible = [c for c in text if not c.isspace()]
    suspect = [c for c in visible if c == "\ufffd" or unicodedata.category(c) in {"Co", "Cc", "Cs"}]
    punctuation = sum(unicodedata.category(c).startswith("P") for c in visible)
    return {
        "characters": len(visible), "suspiciousCount": len(suspect),
        "suspiciousCodepoints": sorted({f"U+{ord(c):04X}" for c in suspect}),
        "punctuationCount": punctuation,
        "punctuationRatio": round(punctuation / max(1, len(visible)), 4),
        "cjkCount": sum("㐀" <= c <= "鿿" for c in visible),
        "latinCount": sum(c.isascii() and c.isalpha() for c in visible),
        "excerpt": text[:600],
        "signals": (["suspicious_codepoints"] if suspect else [])
        + (["long_text_without_punctuation_review_original"] if len(visible) >= 200 and not punctuation else []),
    }


def summarize(pages: list[dict], requested_ocr: str) -> dict:
    readable = [p for p in pages if not p.get("error")]
    with_text = sum(p["characters"] > 0 for p in readable)
    suspicious = any(p["signals"] for p in readable)
    if len(readable) != len(pages):
        status, recommendation = "extraction_error", "review_original"
    elif with_text == 0:
        status, recommendation = "no_extractable_text_in_sample", "ocr"
    elif with_text != len(pages):
        status, recommendation = "mixed_sample", "review_original"
    elif suspicious:
        status, recommendation = "suspect_text", "review_original"
    else:
        status, recommendation = "text_present_in_sample", "reuse_text_after_visual_check"
    cjk = sum(p.get("cjkCount", 0) for p in readable)
    latin = sum(p.get("latinCount", 0) for p in readable)
    if status == "no_extractable_text_in_sample":
        mode, why = "ocr", "sample pages have no text layer (scanned)"
    elif status != "text_present_in_sample":
        mode, why = "ocr", "text layer missing on some pages or suspicious; OCR avoids broken glyph mappings"
    elif cjk >= latin:
        # 2026-10-20 实测：一篇期刊论文的文字层本身完好（pypdf、pdfium 都抽得出标点），
        # 但 MinerU 3.4.4 的 txt 路线把中文标点吞成空格或 <sub>；同一 PDF 走 OCR 标点齐全
        mode, why = "ocr", "Chinese text layer: MinerU 3.4.4 txt route drops CJK punctuation (measured 2026-10-20)"
    else:
        mode, why = "txt", "Latin-script text layer present and clean in the sample"
    return {
        "sampleStatus": status, "recommendation": recommendation,
        "recommendedOcrMode": mode, "ocrModeReason": why,
        "needsTextLayerCopy": status in ("no_extractable_text_in_sample", "mixed_sample", "suspect_text"),
        "requestedOCR": requested_ocr,
        "awaitUserChoice": requested_ocr == "auto" and recommendation == "review_original",
        "decision": "user_requested_ocr" if requested_ocr == "on" else
                    "user_requested_existing_text" if requested_ocr == "off" else "recommendation_only",
        "limitation": "Sample evidence only; extraction and punctuation counts do not prove correctness. Compare suspect pages with their rendered originals.",
    }


def inspect_pdf(path: Path, requested_ocr: str = "auto", limit: int = 9) -> dict:
    from pypdf import PdfReader
    reader = PdfReader(str(path))
    if reader.is_encrypted and not reader.decrypt(""):
        raise ValueError("PDF is encrypted; a user-provided unlocked copy is required")
    pages = []
    for i in sample_indexes(len(reader.pages), limit):
        try:
            pages.append({"physicalPage": i + 1, **text_evidence(reader.pages[i].extract_text() or "")})
        except Exception as exc:
            pages.append({"physicalPage": i + 1, "error": type(exc).__name__})
    return {"version": 1, "pdf": str(path.resolve()), "pageCount": len(reader.pages),
            "sampledPages": pages, **summarize(pages, requested_ocr),
            "networkRequests": 0, "ocrRuns": 0}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--ocr", choices=("auto", "on", "off"), default="auto")
    parser.add_argument("--samples", type=int, default=9)
    args = parser.parse_args()
    if args.output.resolve() == args.pdf.resolve() or args.output.exists():
        parser.error("Choose a new report path; inputs and earlier reports are never overwritten")
    payload = inspect_pdf(args.pdf, args.ocr, args.samples)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8", errors="strict", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    print("PREFLIGHT_OK")


if __name__ == "__main__":
    main()
