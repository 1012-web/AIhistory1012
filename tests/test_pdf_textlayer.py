import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

pymupdf = pytest.importorskip("pymupdf")

SCRIPTS = Path(__file__).resolve().parents[1] / "skills" / "lunzhu2md" / "scripts"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("pdf_textlayer", SCRIPTS / "pdf_textlayer.py")
MODULE = importlib.util.module_from_spec(spec)
sys.modules["pdf_textlayer"] = MODULE
spec.loader.exec_module(MODULE)
import paddle_lines  # noqa: E402


def scanned_page(doc, old_text: str | None = None, visible_text: str | None = None) -> None:
    """一页「扫描图」（200x100）：整页一张图，上面可选叠一层隐形旧文字，或一段看得见的字。"""
    page = doc.new_page(width=200, height=100)
    if visible_text is None:
        pixmap = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 200, 100), False)
        pixmap.set_rect(pixmap.irect, (240, 240, 230))
        pixmap.set_rect(pymupdf.IRect(20, 30, 120, 60), (20, 20, 20))
        page.insert_image(page.rect, pixmap=pixmap)
    if old_text:
        page.insert_text((20, 50), old_text, fontname="china-s", fontsize=12, render_mode=3)
    if visible_text:
        page.insert_text((20, 50), visible_text, fontname="china-s", fontsize=16, render_mode=0)


def make_pdf(path: Path, pages=("旧的错字", "封面文字", None)) -> Path:
    doc = pymupdf.open()
    for text in pages:
        if text is None:
            scanned_page(doc, visible_text="看得见")
        else:
            scanned_page(doc, text)
    doc.save(path)
    return path


ROWS = {"1": [{"box": [0.1, 0.3, 0.5, 0.45], "text": "新的正字"}],
        "3": [{"box": [0.1, 0.3, 0.2, 0.45], "text": "换"}]}


def text_of(path: Path, number: int) -> str:
    with pymupdf.open(path) as doc:
        return "".join(doc[number - 1].get_text().split())


# ---------------------------------------------------------------- write：按行写

def test_write_replaces_hidden_text_keeps_image_and_leaves_unlisted_pages(tmp_path: Path) -> None:
    source = make_pdf(tmp_path / "书.pdf")
    before = source.read_bytes()
    output = tmp_path / "书.文字层.pdf"
    report = MODULE.write(source, ROWS, output)
    assert source.read_bytes() == before and report["sourceUnchanged"]
    assert text_of(output, 1) == "新的正字" and text_of(output, 2) == "封面文字"
    assert report["lowestMatch"] == 1.0
    with pymupdf.open(source) as a, pymupdf.open(output) as b:
        assert a[0].get_pixmap(dpi=72).samples == b[0].get_pixmap(dpi=72).samples


def test_one_line_is_one_string_that_fills_its_box(tmp_path: Path) -> None:
    source = make_pdf(tmp_path / "书.pdf")
    output = tmp_path / "书.文字层.pdf"
    MODULE.write(source, ROWS, output)
    with pymupdf.open(output) as doc:
        assert [ln for ln in doc[0].get_text().split("\n") if ln.strip()] == ["新的正字"]
        chars = [c for b in doc[0].get_text("rawdict")["blocks"] for ln in b.get("lines", [])
                 for sp in ln["spans"] for c in sp["chars"]]
    assert abs(chars[0]["bbox"][0] - 20) < 1.5 and abs(chars[-1]["bbox"][2] - 100) < 3


def test_visible_page_is_kept_or_rasterized(tmp_path: Path) -> None:
    source = make_pdf(tmp_path / "书.pdf")
    kept = MODULE.write(source, ROWS, tmp_path / "a.pdf")
    assert kept["pagesKeptOldLayer"] == [3] and text_of(tmp_path / "a.pdf", 3) == "看得见"
    raster = MODULE.write(source, ROWS, tmp_path / "b.pdf", visible_text="raster", dpi=72)
    assert raster["pagesRasterized"] == [3] and text_of(tmp_path / "b.pdf", 3) == "换"


def test_listed_page_without_text_loses_its_old_layer_and_original_is_protected(tmp_path: Path) -> None:
    source = make_pdf(tmp_path / "书.pdf")
    MODULE.write(source, {"2": [{"box": [0.1, 0.3, 0.5, 0.45], "text": ""}]}, tmp_path / "c.pdf")
    assert text_of(tmp_path / "c.pdf", 2) == "" and text_of(tmp_path / "c.pdf", 1) == "旧的错字"
    with pytest.raises(ValueError):
        MODULE.write(source, ROWS, source)


# ---------------------------------------------------------------- assign：跨页段拆回、对齐到行、空行与跨页表只报告

def line(text, y, cross=False):
    span = {"type": "text", "content": text}
    if cross:
        span["cross_page"] = True
    return {"bbox": [20, y, 180, y + 8], "spans": [span]}


def mineru_dir(tmp_path: Path) -> Path:
    """两页（200x100）：第 1 页一段跨到第 2 页（续行带 cross_page，第 2 页留一个空的续段块）；
    第 1 页末有一张表，第 2 页的表格块是空的（续表被并进了第 1 页）。"""
    p1 = {"page_idx": 0, "page_size": [200, 100], "discarded_blocks": [], "para_blocks": [
        {"type": "text", "index": 0, "bbox": [20, 10, 180, 40], "lines": [line("甲乙丙丁", 12), line("戊己", 12, True)]},
        {"type": "table", "index": 1, "bbox": [20, 60, 180, 90], "blocks": [
            {"type": "table_body", "bbox": [20, 60, 180, 90], "lines": [
                {"bbox": [20, 60, 180, 90], "spans": [{"type": "table", "html": "<table><tr><td>子丑</td></tr></table>"}]}]}]}]}
    p2 = {"page_idx": 1, "page_size": [200, 100], "discarded_blocks": [], "para_blocks": [
        {"type": "text", "index": 0, "bbox": [20, 5, 180, 15], "lines": [], "lines_deleted": True},
        {"type": "text", "index": 1, "bbox": [20, 20, 180, 30], "lines": [line("庚辛", 22)]},
        {"type": "table", "index": 2, "bbox": [20, 60, 180, 90], "blocks": [
            {"type": "table_body", "bbox": [20, 60, 180, 90], "lines": []}]}]}
    for p in (p1, p2):
        p["preproc_blocks"] = p["para_blocks"]
    folder = tmp_path / "书.mineru"
    folder.mkdir()
    (folder / "layout.json").write_text(json.dumps({"_version_name": "3.4.4", "pdf_info": [p1, p2]}, ensure_ascii=False),
                                        encoding="utf-8")
    return folder


LINES = {"version": 1, "source": "test", "units": "fraction", "pages": {
    "1": {"lines": [{"box": [0.1, 0.12, 0.9, 0.2], "text": "甲乙丙丁"}, {"box": [0.1, 0.65, 0.9, 0.75], "text": "子丑"}]},
    "2": {"lines": [{"box": [0.1, 0.06, 0.9, 0.14], "text": "戊巳"}, {"box": [0.1, 0.21, 0.9, 0.29], "text": "庚辛"},
                    {"box": [0.1, 0.65, 0.9, 0.75], "text": "寅卯"}]}}}


def run_assign(tmp_path: Path):
    pdf = tmp_path / "书.pdf"
    doc = pymupdf.open()
    scanned_page(doc)
    scanned_page(doc)
    doc.save(pdf)
    lines = tmp_path / "lines.json"
    lines.write_text(json.dumps(LINES, ensure_ascii=False), encoding="utf-8")
    return pdf, MODULE.assign(pdf, [mineru_dir(tmp_path)], lines)


def test_cross_page_paragraph_is_split_back_and_mineru_text_is_used(tmp_path: Path) -> None:
    _, result = run_assign(tmp_path)
    page1 = [r["text"] for r in result["pages"]["1"]]
    page2 = [r["text"] for r in result["pages"]["2"]]
    assert page1 == ["甲乙丙丁", "子丑"]
    # 续行「戊己」写在第 2 页顶上那一行；字用 MinerU 的「己」，不用 OCR 的「巳」
    assert page2[:2] == ["戊己", "庚辛"]


def test_empty_lines_and_cross_page_tables_are_reported_not_filled(tmp_path: Path) -> None:
    _, result = run_assign(tmp_path)
    assert result["pages"]["2"][2]["text"] == ""                       # 不拿 OCR 的「寅卯」去补
    assert result["empty"] == [{"page": 2, "region": "表格", "lines": [3], "ocr": ["寅卯"]}]
    assert [t["page"] for t in result["crossPageTables"]] == [2]
    report = MODULE.report_markdown(result)
    assert "疑似跨页表" in report and "| 2 | 表格 | 3 | 1 | 寅卯 |" in report


def test_fill_writes_the_given_text_into_that_line(tmp_path: Path) -> None:
    pdf, result = run_assign(tmp_path)
    folder = tmp_path / "文字层"
    target = MODULE.save_assignment(result, folder)
    subprocess.run([sys.executable, "-X", "utf8", str(SCRIPTS / "pdf_textlayer.py"), "fill", "--assignment", str(target),
                    "--page", "2", "--line", "3", "--text", "寅卯"], check=True, capture_output=True)
    filled = json.loads(target.read_text(encoding="utf-8"))
    assert filled["pages"]["2"][2]["text"] == "寅卯" and filled["empty"] == []
    out = subprocess.run([sys.executable, "-X", "utf8", str(SCRIPTS / "pdf_textlayer.py"), "write", "--pdf", str(pdf),
                          "--assignment", str(target)], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    assert text_of(tmp_path / "书.文字层.pdf", 2) == "戊己庚辛寅卯"


def test_fill_clears_a_multi_line_empty_run_line_by_line() -> None:
    """两行以上的空行段：填一行，段里少一行；都填完，这一段才不算待定。"""
    assignment = {"pages": {"5": [{"text": "甲"}, {"text": ""}, {"text": ""}, {"text": ""}]},
                  "empty": [{"page": 5, "region": "表格", "lines": [2, 3, 4], "ocr": ["子", "丑", "寅"]}],
                  "mismatched": []}
    MODULE.fill(assignment, 5, 3, "丑")
    assert assignment["empty"] == [{"page": 5, "region": "表格", "lines": [2, 4], "ocr": ["子", "寅"]}]
    MODULE.fill(assignment, 5, 2, "子")
    MODULE.fill(assignment, 5, 4, "寅")
    assert assignment["empty"] == []
    assert [r["text"] for r in assignment["pages"]["5"]] == ["甲", "子", "丑", "寅"]


def test_without_a_lines_file_mineru_line_boxes_are_used(tmp_path: Path) -> None:
    pdf = tmp_path / "书.pdf"
    doc = pymupdf.open()
    scanned_page(doc)
    scanned_page(doc)
    doc.save(pdf)
    result = MODULE.assign(pdf, [mineru_dir(tmp_path)], None)
    assert result["lineSource"] == "MinerU line boxes"
    assert [r["text"] for r in result["pages"]["1"]][0] == "甲乙丙丁"
    assert "没有行框文件" in MODULE.report_markdown(result)


# ---------------------------------------------------------------- 空白页上模型编出的字：不写进文字层，列进报告

HALLUCINATION = ("The Ground Truth image displays a single, solid horizontal line. According to the rules, "
                 "lines without text should be ignored, so the output for this page is empty.")


def blank_page_mineru(tmp_path: Path) -> Path:
    """两页（410x623）：第 1 页一段正常正文；第 2 页原书近乎空白（只有一条横线），
    MinerU 却给了一个占满整页的正文块，内容是模型自己的推理文字（第 46 页那种情形）。"""
    def page(idx, blocks):
        return {"page_idx": idx, "page_size": [410, 623], "discarded_blocks": [], "para_blocks": blocks,
                "preproc_blocks": blocks}
    p1 = page(0, [{"type": "text", "index": 0, "bbox": [40, 60, 370, 80], "lines": [
        {"bbox": [40, 60, 370, 80], "spans": [{"type": "text", "content": "灾异未必由于政治所致这是一行正常的正文"}]}]}])
    p2 = page(1, [{"type": "text", "index": 0, "bbox": [0, 0, 410, 622], "lines": [
        {"bbox": [0, 0, 410, 622], "spans": [{"type": "text", "content": HALLUCINATION}]}]}])
    folder = tmp_path / "空白页.mineru"
    folder.mkdir()
    (folder / "layout.json").write_text(json.dumps({"_version_name": "3.4.4", "pdf_info": [p1, p2]}, ensure_ascii=False),
                                        encoding="utf-8")
    return folder


@pytest.mark.parametrize("ocr", ["", "____"])
def test_model_text_on_a_blank_page_is_not_written_but_reported(tmp_path: Path, ocr: str) -> None:
    lines = tmp_path / "lines.json"
    lines.write_text(json.dumps({"version": 1, "units": "fraction", "source": "test", "pages": {
        # 正常页：OCR 认错了几个字（「災」「政冶」），仍要写
        "1": {"lines": [{"box": [0.1, 0.1, 0.9, 0.13], "text": "災异未必由于政冶所致这是一行正常的正文"}]},
        # 空白页：云端只找到那条横线
        "2": {"lines": [{"box": [0.25, 0.5, 0.75, 0.503], "text": ocr}]}}}, ensure_ascii=False), encoding="utf-8")
    result = MODULE.assign(tmp_path / "书.pdf", [blank_page_mineru(tmp_path)], lines)
    assert result["pages"]["1"][0]["text"] == "灾异未必由于政治所致这是一行正常的正文"
    assert result["pages"]["2"][0]["text"] == ""                       # 不写进文字层
    [m] = result["mismatched"]
    assert m["page"] == 2 and m["line"] == 1 and m["text"] == HALLUCINATION and "一个字也没认出" in m["why"]
    assert result["empty"] == []                                         # 拦下的行不重复算成空行
    report = MODULE.report_markdown(result)
    assert "差得太远" in report and "The Ground Truth image" in report and "没有待定项" not in report
    # AI 看过原页确认页上没字：留空即可；页上真有字就 fill，fill 后这一条从待定里去掉
    target = MODULE.save_assignment(result, tmp_path / "文字层")
    filled = MODULE.fill(json.loads(target.read_text(encoding="utf-8")), 2, 1, "某字")
    assert filled["mismatched"] == []


def test_line_mismatch_rules() -> None:
    box, size = [0.1, 0.1, 0.9, 0.13], (410, 623)
    assert MODULE.line_mismatch("甲乙丙", "", box, size) is None                     # 太短不查
    assert MODULE.line_mismatch("灾异未必由于政治所致", "災异未必由于政冶所致", box, size) is None
    assert "对得上" in MODULE.line_mismatch(HALLUCINATION, "一二三四五六七八九十", box, size)
    assert "只有 10 字" in MODULE.line_mismatch("甲乙丙丁戊己庚辛壬癸" * 5, "甲乙丙丁戊己庚辛壬癸", box, size)
    # 目录行：引线点 OCR 合并成一个，不算差异
    assert MODULE.line_mismatch("史學之界說．．．．．．．．．．．．．．．．8", "史學之界說.8", box, size) is None
    # OCR 没认出字：放得下就写（漏认的短标题），放不下才拦
    assert MODULE.line_mismatch("第二章汉儒的灾异论", "", box, size) is None
    assert MODULE.line_mismatch(HALLUCINATION, "", box, size)


# ---------------------------------------------------------------- 行框文件：PP-OCRv6 原始结果转换

def test_paddle_ocr_result_converts_to_a_fraction_lines_file() -> None:
    raw = json.dumps({"result": {"dataInfo": {"pages": [{"width": 200, "height": 100}, {"width": 200, "height": 100}]},
                                 "ocrResults": [
                                     {"prunedResult": {"rec_boxes": [[20, 10, 180, 20]], "rec_texts": ["甲"]}},
                                     {"prunedResult": {"rec_boxes": [[0, 0, 100, 50]], "rec_texts": ["乙"]}}]}})
    pages = paddle_lines.lines_from_jsonl(raw, [7, 9])
    doc = paddle_lines.lines_document(pages)
    assert doc["units"] == "fraction" and list(doc["pages"]) == ["7", "9"]
    assert doc["pages"]["7"]["lines"] == [{"box": [0.1, 0.1, 0.9, 0.2], "text": "甲"}]
    with pytest.raises(paddle_lines.pa.ClientError):
        paddle_lines.lines_from_jsonl(raw, [7])
