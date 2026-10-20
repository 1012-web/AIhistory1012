"""MinerU 产物读取的共用工具。

Windows 说明：这些脚本一律把详细报告写成 UTF-8 文件，stdout 只打印 ASCII 状态行。
原因是 Windows 控制台默认 GBK，中文报告直接 print 会变成乱码，反而看不了。
详细内容请用 Read 工具读生成的文件。
"""
import json
import os
import re
import sys
import glob

CIRC = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
CIRC_RE = re.compile('[' + CIRC + ']')

# 实义字符：比对时只看这些，标点/空格/Markdown 语法一律忽略
KEEP_RE = re.compile(r'[㐀-䶿一-鿿A-Za-z0-9' + CIRC + r'□〈〉〔〕]')

TEXTLIKE = ('text', 'ref_text', 'title', 'list', 'index')

# ---- 跨页断段判定：probe 报告和 build 接合必须用同一套判据，否则报告与成品对不上
# 收尾标点里带上 ：；——「其职责：」后面换页跟一串列举，那是新块不是断句
TERMINAL = '。！？”』》）】…—：；'
OPENER = re.compile(r'^\s*(第[一二三四五六七八九十百]+[章节編编篇]|[一二三四五六七八九十]+[、．.]|'
                    r'[（(]\s*\d+\s*[)）]|\d+\s*[.．、]|附录|绪论|结语|参考|思考题|本章|学术)')
# 句末的脚注引用不是句末标记：「…近代化。[^11]」是正常段末，不是断句
TRAIL_REF = re.compile(r'(\[\^\d+\]\s*)+$')
# 页码锚点（约定见仓库 docs/anchors.md）：物理页 <!--pdf-page.N--> 为主，印刷页 <!--p.M--> 紧跟其后。
# 旧成品只有 <!--p.M-->，读的一方两种都要认。
PDF_PAGE_RE = re.compile(r'<!--pdf-page\.(\d+)-->')
PRINTED_RE = re.compile(r'<!--p\.([^>]+?)-->')
# 独占一段的锚点块：<!--pdf-page.N--> 后面可带 <!--p.M-->；旧格式只有 <!--p.M-->。
# group(1) 是物理页（旧格式为 None），group(2) 是印刷页（可无）。
ANCHOR_RE = re.compile(r'^(?:<!--pdf-page\.(\d+)-->)(?:<!--p\.([^>]+?)-->)?$|^<!--p\.(-?\d+)-->$')


def anchor_tag(phys, printed=None):
    """一页的锚点串：<!--pdf-page.N--> 加（有印刷页时）<!--p.M-->。"""
    return '<!--pdf-page.%d-->' % phys + ('<!--p.%s-->' % printed if printed not in (None, '') else '')


def anchor_page(text):
    """独占一段的锚点块的物理页号；不是锚点块返回 None。旧格式（只有 p.M）返回 0。"""
    m = ANCHOR_RE.match(text.strip())
    if not m:
        return None
    return int(m.group(1)) if m.group(1) else 0


class SchemaError(RuntimeError):
    """MinerU 中间结构不是本 skill 认得的 3.x（pdf_info）结构。"""


def check_schema(data, path=''):
    """读 MinerU 中间结构前先看 schema：3.x 有 pdf_info；4.0 是 docvortex（schema: docvortex.middle，2.0），
    没有 pdf_info、discarded_blocks，照 3.x 读会静默丢脚注，必须停下。返回 (版本名, OCR 是否开启)。"""
    if isinstance(data, dict):
        schema = data.get('schema')
        scalars = {k: v for k, v in data.items() if isinstance(v, (str, int, float, bool))}
        if schema is not None or 'docvortex' in json.dumps(scalars).lower():
            raise SchemaError('%s 是 MinerU 4.0（DocVortex）中间结构（schema=%r），本 skill 只认 3.x 的 pdf_info 结构。'
                              '请改用 v4 接口重解析，或等 DocVortex 适配。' % (path or 'middle json', schema))
        if not isinstance(data.get('pdf_info'), list):
            raise SchemaError('%s 没有 pdf_info 列表，不是 MinerU 3.x 中间结构。' % (path or 'middle json'))
        version = str(data.get('_version_name') or '')
        if version and not version.startswith(('2.', '3.')):
            raise SchemaError('%s 的 _version_name=%s，未经验证；请先核对结构再用。' % (path or 'middle json', version))
        return version, data.get('_ocr_enable')
    raise SchemaError('%s 不是 JSON 对象。' % (path or 'middle json'))
# 图、图注、图下小字注：可能夹在断点中间，判定时要跨过去
FLOAT_PREFIX = ('![', '*', '<small>')


def is_break(prev, nxt):
    """prev 与 nxt 之间的换页是否切断了同一个段落。"""
    if not prev or not nxt:
        return False
    if prev.startswith(('#', '<!--') + FLOAT_PREFIX) or nxt.startswith(('#', '<!--') + FLOAT_PREFIX):
        return False
    tail = TRAIL_REF.sub('', prev).rstrip()
    # 目录行「后记/329」「第一章 溯源……9」以页码收尾、没有句末标点，但不是断句（曾把目录末行接进序论首段）
    if TOC_TAIL.search(tail):
        return False
    return bool(tail) and tail[-1] not in TERMINAL and not OPENER.match(nxt)


TOC_TAIL = re.compile(r'(?:[/／]|[…·．.]{2,})\s*\d{1,4}$')


def die(msg):
    print('ERROR: ' + msg)
    sys.exit(1)


def find_files(d):
    """定位 MinerU 输出目录里的各个产物。"""

    def one(pattern):
        hits = sorted(glob.glob(os.path.join(d, pattern)))
        if not hits:
            hits = sorted(glob.glob(os.path.join(d, '**', pattern), recursive=True))
        return hits[0] if hits else None

    images = os.path.join(d, 'images') if os.path.isdir(os.path.join(d, 'images')) else None
    if not images:
        nested_images = sorted(glob.glob(os.path.join(d, '**', 'images'), recursive=True))
        images = nested_images[0] if nested_images else None

    return {
        'layout': one('layout.json') or one('*_middle.json') or one('middle.json'),
        'block_list': one('block_list.json'),
        'full_md': one('full.md') or one('MinerU_markdown_*.md'),
        'content_list': one('*_content_list.json'),
        'content_list_v2': one('*_content_list_v2.json'),
        'model': one('*_model.json'),
        'origin_pdf': one('*_origin.pdf'),
        'images': images,
    }


def load_layout_doc(d):
    """读 MinerU 中间结构整份 JSON，先查 schema；4.0 结构直接报错停下。"""
    f = find_files(d)['layout']
    if not f:
        die('找不到 layout.json / *_middle.json——它是正文的唯一可靠来源，没有它无法继续。')
    data = json.load(open(f, encoding='utf-8'))
    try:
        check_schema(data, os.path.basename(f))
    except SchemaError as exc:
        die(str(exc))
    return data


def load_layout(d):
    return load_layout_doc(d)['pdf_info']


SOURCE_SIDECAR = '_lunzhu2md_source.json'
VOLUME_RE = re.compile(r'pages-(\d+)-(\d+)')


def volume_start(d):
    """这一卷的第 1 页是原 PDF 的第几页（1 起）。依次看：客户端写的 _lunzhu2md_source.json、
    目录名里的 pages-0201-0339、目录下 *_origin.pdf 的文件名；都没有就是 1（整本一卷）。"""
    side = os.path.join(d, SOURCE_SIDECAR)
    if os.path.isfile(side):
        try:
            return int(json.load(open(side, encoding='utf-8')).get('page_start') or 1)
        except (ValueError, OSError):
            pass
    m = VOLUME_RE.search(os.path.basename(os.path.normpath(d)))
    if not m:
        origin = find_files(d).get('origin_pdf') or ''
        m = VOLUME_RE.search(os.path.basename(origin))
    return int(m.group(1)) if m else 1


def physical_pages(layout, start):
    """每个 page_idx 对应的物理页（1 起）：按卷起始页加偏移；产物保留了原 PDF 绝对页序（page_idx 不从 0 起）时用 page_idx + 1。"""
    absolute = any(pg.get('page_idx', pi) != pi for pi, pg in enumerate(layout))
    return [(pg['page_idx'] + 1) if absolute else start + pi for pi, pg in enumerate(layout)]


def para_blocks(page):
    """一页里合并过跨页段落之后的块（3.x 的 para_blocks），按阅读顺序。没有就退回 preproc_blocks。

    跨页段落：下一页开头的续段被并进上一页的末块，拼进来的 span 带 cross_page: true；
    下一页原来那块变空（lines 为空、lines_deleted: true）。"""
    blocks = page.get('para_blocks')
    if blocks is None:
        return body_blocks(page)
    return sorted(blocks, key=lambda b: b.get('index', 0))


def load_blocklist(d):
    """返回 (pages, merge_map)。merge_map: (page_idx, index) -> (page_idx, index)"""
    f = find_files(d)['block_list']
    if not f:
        return None, {}
    raw = json.load(open(f, encoding='utf-8'))
    pages = raw.get('pdfData', [])
    pos2key = {}
    for pi, pg in enumerate(pages):
        for b in pg:
            if 'block_position' in b:
                pos2key[b['block_position']] = (pi, b.get('index'))
    merge = {}
    for c in raw.get('mergeConnections', []):
        blocks = c.get('blocks', [])
        for a, b in zip(blocks, blocks[1:]):
            if a in pos2key and b in pos2key:
                merge[pos2key[a]] = pos2key[b]
    return pages, merge


def strip_tags(t):
    """MinerU 用 <sub>/<sup> 包裹部分标点和上下标，还原为普通字符。"""
    t = re.sub(r'<sub>(.*?)</sub>', r'\1', t)
    t = re.sub(r'<sup>(.*?)</sup>', r'\1', t)
    return t


def join_lines(lines):
    """按行拼接。只有两侧都是 ASCII 字母数字时才补空格。

    中文换行处不能加空格（会多出空格），但英文/数字换行处必须加，
    否则 '2020' + '2022' 会粘成 '20202022'——这正是 block_list.json 的通病。
    """
    out = ''
    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        if out and re.search(r'[0-9A-Za-z]$', out) and re.match(r'[0-9A-Za-z]', ln):
            out += ' '
        out += ln
    return out


def line_texts(block):
    """取出一个 layout 块的每行文字。

    注意 image/table 类块是嵌套的：它们有 `blocks`（image_body / image_caption）
    而不是直接的 `lines`。套用正文逻辑会静默漏掉图注。
    """
    out = []
    for ln in block.get('lines', []) or []:
        out.append(''.join(s.get('content') or '' for s in ln.get('spans', [])))
    for sub in block.get('blocks', []) or []:
        out.extend(line_texts(sub))
    return out


def block_text(block):
    return join_lines(line_texts(block))


def image_paths(block):
    """递归取出块里的图片路径。"""
    out = []
    for ln in block.get('lines', []) or []:
        for s in ln.get('spans', []):
            p = s.get('image_path') or s.get('img_path')
            if p:
                out.append(p.lstrip('/'))
    for sub in block.get('blocks', []) or []:
        out.extend(image_paths(sub))
    return out


def sub_blocks_by_type(block, wanted):
    out = []
    for sub in block.get('blocks', []) or []:
        if sub.get('type') in wanted:
            out.append(sub)
        out.extend(sub_blocks_by_type(sub, wanted))
    return out


def body_blocks(page):
    """一页里参与正文的块，按阅读顺序。"""
    return sorted(page.get('preproc_blocks', []), key=lambda b: b.get('index', 0))


def footnote_blocks(page):
    return [b for b in page.get('discarded_blocks', []) if b.get('type') == 'page_footnote']


def discarded_of_type(page, t):
    return [b for b in page.get('discarded_blocks', []) if b.get('type') == t]


def page_number_map(layout):
    """从 page_number 块推断每页的印刷页码。

    很多首页没有页码块，所以用「印刷页码 - page_idx」的众数当偏移量补齐。
    """
    seen = {}
    for pi, pg in enumerate(layout):
        for b in discarded_of_type(pg, 'page_number'):
            # layout.json 的 discarded 块没有 text 字段，只有 lines——必须回退到行级拼接
            m = re.search(r'\d+', strip_tags(b.get('text') or block_text(b)))
            if m:
                seen[pi] = int(m.group(0))
                break
    if not seen:
        return {pi: pi + 1 for pi in range(len(layout))}
    offsets = {}
    for pi, n in seen.items():
        offsets[n - pi] = offsets.get(n - pi, 0) + 1
    off = max(offsets, key=offsets.get)
    return {pi: seen.get(pi, pi + off) for pi in range(len(layout))}


def detected_page_numbers(layout):
    """MinerU 读到的印刷页码：{page_idx: 整数}。只认 page_number 块里的阿拉伯数字。"""
    seen = {}
    for pi, pg in enumerate(layout):
        for b in discarded_of_type(pg, 'page_number'):
            m = re.search(r'\d+', strip_tags(b.get('text') or block_text(b)))
            if m:
                seen[pi] = int(m.group(0))
                break
    return seen


def printed_pages(layout):
    """推定每页的印刷页码，返回 ({page_idx: 印刷页或 None}, 待核清单)。只照规则推，不替 MinerU 改读数：

    - 读到页码的页照用。某页的「印刷页 − 页序」与前后两个读到的页都不一致、而前后彼此一致的，照样写读到的数，
      列为「疑误读」并写出前后页推出的数，由 AI 看原页定；它不拿来给别的页作推定依据，也不算跳号；
    - 没读到的页按最近一个读到的页的偏移推（前面没有就看后面）；推出来小于 1 的（封面、扉页）不给印刷页；
    - 偏移在两页之间变了（缺页、页码体系换了）记为跳号，不自动抹平。
    待核清单每项 (page_idx, 类别, 说明)；类别：misread 疑误读、jump 跳号、inferred 推定（成段汇总）。
    """
    seen = detected_page_numbers(layout)
    keys = sorted(seen)
    review, suspect = [], set()
    for i, pi in enumerate(keys):
        if 0 < i < len(keys) - 1:
            before, here, after = seen[keys[i - 1]] - keys[i - 1], seen[pi] - pi, seen[keys[i + 1]] - keys[i + 1]
            if before == after != here:
                review.append((pi, 'misread', '读到 %d（照写），前后页推应为 %d，看原页定' % (seen[pi], pi + before)))
                suspect.add(pi)
    keys = [k for k in sorted(seen) if k not in suspect]
    for a, b in zip(keys, keys[1:]):
        if seen[a] - a != seen[b] - b:
            review.append((b, 'jump', '页码 %d → %d 之间偏移由 %d 变为 %d' % (seen[a], seen[b], seen[a] - a, seen[b] - b)))
    out, inferred = {}, []
    for pi in range(len(layout)):
        if pi in seen:
            out[pi] = seen[pi]
            continue
        prev = [k for k in keys if k < pi]
        nxt = [k for k in keys if k > pi]
        ref = prev[-1] if prev else (nxt[0] if nxt else None)
        value = None if ref is None else pi + seen[ref] - ref
        out[pi] = value if value is not None and value >= 1 else None
        if out[pi] is not None:
            inferred.append(pi)
    for start, end in _runs(inferred):
        review.append((start, 'inferred', '本页起连续 %d 页没读到页码，按相邻页推定为 %d—%d'
                       % (end - start + 1, out[start], out[end])))
    review.sort()
    return out, review


def _runs(values):
    runs = []
    for v in values:
        if runs and v == runs[-1][1] + 1:
            runs[-1][1] = v
        else:
            runs.append([v, v])
    return [tuple(r) for r in runs]


def significant(s):
    """只保留实义字符，用于比对。"""
    return ''.join(KEEP_RE.findall(s))


NOTES_HEAD_RE = re.compile(r'^#{1,6}\s*注释\s*$')
HEAD_LINE_RE = re.compile(r'^#{1,6}\s+\S')


def split_notes(text):
    """把成品拆成 (正文, 注释)。注释区可能有多个：split_book.py 默认每章末尾一个「## 注释」，
    从它到下一个标题行之前都算注释；不能只按第一个「## 注释」一刀切，否则第一章以后的正文全被当成注释。"""
    body, notes = [], []
    in_notes = False
    for line in text.split('\n'):
        if NOTES_HEAD_RE.match(line.strip()):
            in_notes = True
            continue
        # 注释区到下一个标题为止；独占一行的物理页锚点也算正文（下一章首页的锚点紧挨在章标题前，落在上一章注释区之后）
        if in_notes and (HEAD_LINE_RE.match(line) or ANCHOR_RE.match(line.strip())):
            in_notes = False
        (notes if in_notes else body).append(line)
    # 注释区之前的「---」分隔线留在正文里也无妨（比对、计数都会剔掉）
    return '\n'.join(body), '\n'.join(notes)


def book_folder(path):
    """从书文件夹里任何位置（包括 _数据/过程报告/ 下面）找回书文件夹本身。"""
    folder = os.path.abspath(path)
    parts = folder.split(os.sep)
    if '_数据' in parts:
        folder = os.sep.join(parts[:len(parts) - 1 - parts[::-1].index('_数据')])
    return folder


def process_report(folder, name):
    """交付物之外的过程报告（校验、比对、整理报告）一律放进 <书文件夹>/_数据/过程报告/，不跟正文混在一起。
    folder 落在 _数据/ 里面时（如成品临时放在过程报告目录），回到书文件夹再放，不嵌套出 _数据/过程报告/_数据/…"""
    target = os.path.join(book_folder(folder), '_数据', '过程报告')
    if not os.path.isdir(target):
        os.makedirs(target)
    return os.path.join(target, name)


def report_path(mineru_dir, name):
    """probe.py、build.py 等对着 MinerU 输出目录跑的报告放哪：目录在书文件夹的 _数据/ 里面时，
    放进 <书>/_数据/过程报告/；拆卷的分卷（目录名带 pages-0001-0200）在文件名后加卷标，几卷不互相覆盖。
    目录不在书文件夹里（用户直接给的 MinerU 目录）时照旧写在目录里。"""
    folder = os.path.abspath(mineru_dir)
    if '_数据' not in folder.split(os.sep):
        return os.path.join(folder, name)
    vol = re.search(r'pages-\d+-\d+', os.path.basename(os.path.normpath(folder)))
    if vol:
        stem, ext = os.path.splitext(name)
        name = '%s_%s%s' % (stem, vol.group(0), ext)
    return process_report(folder, name)


def write_report(path, text):
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(text)
    print('report -> ' + ascii_path(os.path.basename(path)))


def ascii_path(path):
    """stdout 只打 ASCII：中文路径在 GBK 控制台上是乱码，换成 \\uXXXX 转义，至少看得出是哪个文件。"""
    return str(path).encode('ascii', 'backslashreplace').decode('ascii')


# 中文书里不该有的长段拉丁文：模型在空白页上「自言自语」（实测 MinerU 在空白页写出
# 「The Ground Truth image …」一整段）。连续 8 个以上英文单词、且前后是中文或段首段尾才算。
LATIN_RUN_RE = re.compile(r'(?:\b[A-Za-z][A-Za-z\'’-]*\b[ ,.;:]+){8,}')


def mostly_chinese(text):
    """全书是不是以中文为主（汉字多于拉丁字母）：外文书不查长段拉丁文。"""
    return len(re.findall(r'[一-鿿]', text)) > len(re.findall(r'[A-Za-z]', text))


def latin_runs(text):
    """文本里的长段拉丁文片段。调用方先用 mostly_chinese 判断全书是中文书再查。"""
    return [m.group(0).strip() for m in LATIN_RUN_RE.finditer(text or '')]
