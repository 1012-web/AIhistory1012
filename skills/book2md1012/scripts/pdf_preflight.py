"""Local PDF text-layer evidence, without OCR, upload, or credentials."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def sample_indexes(total: int, limit: int = 9) -> list[int]:
    if total < 1 or limit < 2:
        raise ValueError("PDF must have pages and sample limit must be >= 2")
    count = min(total, limit)
    return sorted({round(i * (total - 1) / max(1, count - 1)) for i in range(count)})


def text_evidence(text: str) -> dict:
    # These are concrete encoding warnings, not an OCR-quality score or verdict.
    warnings = []
    if "\ufffd" in text:
        warnings.append("unicode_replacement_character_present")
    if "\x00" in text:
        warnings.append("null_character_present")
    return {"characters": sum(not c.isspace() for c in text), "excerpt": text[:600],
            "encodingWarnings": warnings}


def summarize(pages: list[dict], requested_ocr: str) -> dict:
    readable = [p for p in pages if not p.get("error")]
    with_text = sum(p["characters"] > 0 for p in readable)
    if len(readable) != len(pages):
        status = "extraction_error"
    elif not with_text:
        status = "no_extractable_text_in_sample"
    elif with_text != len(pages):
        status = "mixed_sample"
    else:
        status = "text_present_in_sample"
    awaiting = requested_ocr == "auto" and (with_text > 0 or status == "extraction_error")
    return {
        "sampleStatus": status,
        "hasExtractableTextInSample": with_text > 0,
        "recommendation": "ask_user_reocr_recommended" if awaiting else
                          "use_existing_text" if requested_ocr == "off" else "ocr",
        "recommendedOcrMode": "txt" if requested_ocr == "off" else "ocr",
        "ocrModeReason": "user chose existing text" if requested_ocr == "off" else
                         "re-recognition recommended; text quality is not assessed",
        "needsTextLayerCopy": requested_ocr == "on" or (not with_text and status != "extraction_error"),
        "requestedOCR": requested_ocr,
        "awaitUserChoice": awaiting,
        "decision": "user_requested_ocr" if requested_ocr == "on" else
                    "user_requested_existing_text" if requested_ocr == "off" else
                    "await_user_choice" if awaiting else "ocr_no_text_detected",
        "limitation": "Presence in sampled pages only; no text quality assessment. The original PDF is never modified.",
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
    return {"version": 2, "pdf": str(path.resolve()), "pageCount": len(reader.pages),
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
