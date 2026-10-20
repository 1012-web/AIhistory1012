"""从 layout.json 重建正文骨架。

用法:
    python build.py <mineru输出目录> -o _skeleton.md [--skip-marker 12,30] [--quote-indent 10]

骨架里的正文仍是 MinerU 的原始用字（标点可能缺失），需要人工还原标点。
但脚注、页码锚点、跨页合并、图片、编号这些机械活已经做完了。

产出:
    -o 指定的 markdown 骨架
    <书>/_数据/过程报告/_build_report.txt  疑似引文块清单等需要复核的项（-o 不在书文件夹里时写在 -o 旁边）
"""
import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (CIRC, CIRC_RE, FLOAT_PREFIX, anchor_page, anchor_tag, block_text, body_blocks, die,
                     find_files, footnote_blocks, image_paths, is_break, join_lines, line_texts, load_blocklist,
                     load_layout_doc, para_blocks, physical_pages, printed_pages, process_report, strip_tags, sub_blocks_by_type,
                     volume_start, write_report)

META_PREFIX = ('收稿日期', '作者简介', '基金项目', '通信作者', '引用格式', '作者单位', 'DOI')
CJK = r'㐀-䶿一-鿿'


def btext(b):
    return strip_tags(b.get('text') or block_text(b)).strip()


def tidy_footnote(t):
    """脚注只做机械清理：还原 <sub>/<sup> 标签、多个空白并成一个。不改半全角、不补标点、不动括号——
    标点宽度要统一，由 AI 决定后另跑 punct_width.py。保留原有空格：它们常是被吞掉的标点的位置。"""
    return re.sub(r'\s{2,}', ' ', strip_tags(t)).strip()


LEAD_CIRC_RE = re.compile('^[' + CIRC + ']+')


def parse_add_footnote(vals):
    """--add-footnote 页序号:圈码序号:正文 -> {页序号: [(圈码序号-1, 正文), ...]}"""
    add = {}
    for v in vals:
        parts = v.split(':', 2)
        if len(parts) != 3 or not parts[0].strip().isdigit() or not parts[1].strip().isdigit():
            die('--add-footnote 格式应为 页序号:圈码序号:正文，收到 %r' % v)
        add.setdefault(int(parts[0]), []).append((int(parts[1]) - 1, parts[2].strip()))
    return add


def collect_footnotes(layout, pnum, add=None, tags=None):
    """按页序取出脚注。开头没有圈码的条目照位置保留——那多半是圈码识别丢了。

    两个坑，中文书里都很常见：

    一、**一条脚注可能领起多个圈码**——「②③⑥⑦⑧《史记·商君列传》。」是一条块，
    却对应正文里五个引用。只当成一条，其后所有脚注编号会整体错位。要拆成五条。

    二、拆完还得**按圈码值在页内重排**。上例那页的块序是 ①／②③⑥⑦⑧／④／⑤，
    照块序输出就成了 1,2,3,6,7,8,4,5，与正文的 ①②③④⑤⑥⑦⑧ 对不上。
    只在该页每条都认出了圈码时才排序；有认不出的就保持块序，宁可不动也别乱排。

    add 是 --add-footnote 回补的条目：MinerU 偶尔会整条漏掉一个脚注块，
    或把它误判成正文。漏一条，其后所有编号就错一位，必须在这里补回来。
    """
    notes, meta = [], []
    split, added, unnumbered = [], [], []
    add = add or {}
    for pi, pg in enumerate(layout):
        page_notes = []
        for b in footnote_blocks(pg):
            raw = b.get('text') or join_lines(line_texts(b))
            t = strip_tags(raw).strip()
            if not t:
                continue
            if t.startswith(META_PREFIX):
                meta.append((pnum[pi], tidy_footnote(t)))
                continue
            m = LEAD_CIRC_RE.match(t)
            if not m:
                unnumbered.append((pnum[pi], tidy_footnote(t)))
                page_notes.append((None, tidy_footnote(t)))
                continue
            body = tidy_footnote(t[m.end():])
            if len(m.group(0)) > 1:
                split.append((pnum[pi], m.group(0), body))
            for c in m.group(0):
                page_notes.append((CIRC.index(c), body))
        for k, t in add.get(pi, []):
            page_notes.append((k, t))
            added.append((pnum[pi], CIRC[k] if k < len(CIRC) else '?', t))
        if page_notes and all(k is not None for k, _ in page_notes):
            page_notes.sort(key=lambda kv: kv[0])
        notes += [((tags or pnum)[pi], t) for _, t in page_notes]
    return notes, meta, split, added, unnumbered


# 标题编号形态由粗到细。MinerU 常把所有标题都标成 level=2（实测 120–154 个全一样），
# 那种情况下源里没有任何层级信息，只能从编号形态重建。
HEAD_PATTERNS = [
    ('部/编/篇/卷', re.compile(r'^第[一二三四五六七八九十百零〇\d]+\s*[部编篇卷]')),
    ('章', re.compile(r'^第[一二三四五六七八九十百零〇\d]+\s*章')),
    ('节', re.compile(r'^第[一二三四五六七八九十百零〇\d]+\s*节')),
    ('一、', re.compile(r'^[一二三四五六七八九十]+\s*[、．.]')),
    ('（一）', re.compile(r'^[（(]\s*[一二三四五六七八九十]+\s*[)）]')),
    ('1.', re.compile(r'^\d+\s*[、．.]')),
    ('（1）', re.compile(r'^[（(]\s*\d+\s*[)）]')),
]


def make_heading_level(layout):
    """按文档里实际出现的编号形态给出分级建议（H1 留给文档标题），只写进构建报告，不改骨架：
    标题层级由 AI 看目录原页定（references/toc-headings.md）。只在源里的 level 完全扁平时给建议。"""
    titles = [strip_tags(block_text(b)).strip()
              for pg in layout for b in body_blocks(pg) if b.get('type') == 'title']
    lv = {b.get('level') for pg in layout for b in body_blocks(pg) if b.get('type') == 'title'}
    if len(lv) > 1 or len(titles) <= 5:
        return (lambda _t: None), []
    present = [(name, rx) for name, rx in HEAD_PATTERNS if any(rx.match(t) for t in titles)]
    if not present:
        return (lambda _t: None), []
    mapping = {name: min(6, i + 2) for i, (name, _) in enumerate(present)}

    def level_of(t):
        for name, rx in present:
            if rx.match(t):
                return mapping[name]
        return None
    return level_of, [(n, mapping[n]) for n, _ in present]


def join_page_breaks(blocks):
    """找 MinerU 没合并、但像是被换页切断的段落（上页末无句末标点、下页首不像新段），只列候选，不改骨架。

    接不接由 AI 对着两页原图定；接的话把下一页锚点留在接缝处。这些地方极易被误当成「缺标点」
    而补一个句号——那是用标点掩盖数据丢失。判据：剥掉尾部的 [^n] 再看句末；跨过夹在中间的图和图注。
    返回 (原样的 blocks, 候选清单)。"""
    out, i, joined = [], 0, []
    while i < len(blocks):
        page = anchor_page(blocks[i])
        if page is not None and out:
            j = i + 1
            floats = []
            while j < len(blocks) and blocks[j].strip().startswith(FLOAT_PREFIX):
                floats.append(blocks[j])
                j += 1
            if j < len(blocks):
                prev, nxt = out[-1].strip(), blocks[j].strip()
                if is_break(prev, nxt):
                    joined.append((page, prev[-26:], nxt[:26], len(floats)))
        out.append(blocks[i])
        i += 1
    return out, joined


def body_margins(page):
    """一页正文的左右边界：取多行文本块 x0 / x1 的众数。

    只看多行块，因为单行段落带首行缩进，x0 会假性偏大。
    """
    bs = [b for b in body_blocks(page)
          if b.get('type') in ('text', 'ref_text') and len(b.get('lines') or []) >= 2]
    if not bs:
        bs = [b for b in body_blocks(page) if b.get('type') in ('text', 'ref_text')]
    if not bs:
        return (None, None)
    xs = [b['bbox'][0] for b in bs]
    x1s = [b['bbox'][2] for b in bs]
    return (min(xs, key=lambda v: (-xs.count(v), v)),
            max(x1s, key=lambda v: (x1s.count(v), v)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dir')
    ap.add_argument('-o', '--out', required=True)
    ap.add_argument('--skip-marker', default='',
                    help='非脚注的圈码全局序号，逗号分隔（从 _markers.tsv 认定）')
    ap.add_argument('--add-footnote', action='append', default=[], metavar='页序号:圈码序号:正文',
                    help='回补 MinerU 漏掉的脚注，可重复。页序号是 layout.json 的 page_idx')
    ap.add_argument('--quote-indent', type=float, default=10.0,
                    help='相对左边界缩进超过此值（pt）视为疑似引文块')
    ap.add_argument('--page-start', type=int, default=None,
                    help='这一卷第 1 页是原 PDF 第几页；默认从 _lunzhu2md_source.json 或目录名 pages-0201-0339 推')
    ap.add_argument('--no-join', action='store_true', help='（已无作用：跨页断段只列候选，不自动接）')
    a = ap.parse_args()

    if not os.path.isdir(a.dir):
        die('目录不存在: ' + a.dir)
    skip = {int(x) for x in a.skip_marker.replace('，', ',').split(',') if x.strip()}

    doc = load_layout_doc(a.dir)
    layout = doc['pdf_info']
    start = a.page_start or volume_start(a.dir)
    # 3.x 有 para_blocks（已合并跨页段，接缝处 span 带 cross_page）就用它；更旧的产物退回 preproc_blocks + block_list
    use_para = any('para_blocks' in pg for pg in layout)
    _, merge = ({}, {}) if use_para else load_blocklist(a.dir)
    printed, page_review = printed_pages(layout)
    # 物理页（1 起）：按卷起始页加偏移；产物若保留了原 PDF 的绝对页序（page_idx 不从 0 起），直接用 page_idx + 1
    pnum = dict(enumerate(physical_pages(layout, start)))
    tags = {pi: anchor_tag(pnum[pi], printed[pi]) for pi in pnum}  # <!--pdf-page.N--><!--p.M-->
    has_images = bool(find_files(a.dir)['images'])
    # 每个空出来的续段块（lines_deleted）对应一处接缝；按页记下，配给上一页里带 cross_page 的块
    deleted_pages = sorted(pi for pi, pg in enumerate(layout)
                           for b in (pg.get('para_blocks') or []) if b.get('lines_deleted'))
    seams = []      # (接缝页物理页号, 上页结尾, 下页开头)

    merged_into = set(merge.values())
    margins = {pi: body_margins(pg) for pi, pg in enumerate(layout)}
    heading_level, head_map = make_heading_level(layout)

    quote_candidates = []
    state = {'seq': 0, 'used': 0}

    def sub_markers(text, pi):
        """圈码 -> [^n]。跳过被认定为非脚注的那些。"""
        def rep(m):
            state['seq'] += 1
            if state['seq'] in skip:
                return m.group(0)
            state['used'] += 1
            return '[^%d]' % state['used']
        return CIRC_RE.sub(rep, text)

    def seamed_text(pi, b):
        """块文字；拼进来的下页续行（span 带 cross_page）前插下页锚点。

        续行跨了不止一页时（中间整页都是这一段），行框的纵坐标会回跳到页顶，据此切出每一页。"""
        groups = []   # [(是否续行, [行文字], 上一行 y0)]
        for ln in b.get('lines', []) or []:
            spans = ln.get('spans', []) or []
            cross = any(s.get('cross_page') for s in spans)
            text = ''.join(s.get('content') or '' for s in spans)
            y0 = (ln.get('bbox') or [0, 0])[1]
            if groups and groups[-1][0] == cross and not (cross and y0 < groups[-1][2] - 1):
                groups[-1][1].append(text)
                groups[-1][2] = y0
            else:
                groups.append([cross, [text], y0])
        if not any(g[0] for g in groups):
            return block_text(b)
        out = ''
        for cross, texts, _ in groups:
            seg = join_lines(texts)
            if cross:
                later = [p for p in deleted_pages if p > pi and p not in seen_pages]
                npi = later[0] if later else pi + 1
                if npi < len(layout):
                    seen_pages.add(npi)
                    seams.append((pnum[npi], strip_tags(out)[-16:], strip_tags(seg)[:16]))
                    pad = ' ' if re.search(r'[0-9A-Za-z]$', out) and re.match(r'[0-9A-Za-z]', seg.strip()) else ''
                    out += pad + tags[npi] + seg.strip()
                    continue
            out = join_lines([out, seg]) if out else seg
        return out

    def render(pi, b, seam=None):
        """把一个块渲染成 markdown。seam 用于跨页合并时把页码锚点插在断页处。"""
        typ = b.get('type')
        if typ in ('image', 'table'):
            # 图和表统一处理。要点：图注只能出一次——block_text(b) 是递归的，
            # 会把子块里的图注一起取出来，再单独输出一遍就重复了。
            caps = [strip_tags(block_text(c)).strip()
                    for c in sub_blocks_by_type(b, ('image_caption', 'table_caption'))]
            foots = [strip_tags(block_text(c)).strip()
                     for c in sub_blocks_by_type(b, ('image_footnote', 'table_footnote'))]
            html = (b.get('html') or b.get('table_body') or '').strip()
            for sub in sub_blocks_by_type(b, ('table_body', 'image_body')):
                html = html or (sub.get('html') or sub.get('table_body') or '').strip()
                # vlm 后端的 layout.json 把表格的行列结构放在 table_body 的 span.html 里：
                # 只嵌截图会丢掉行列结构（不合「表格保留行列结构」），两样都要
                for ln in sub.get('lines', []) or []:
                    for sp in ln.get('spans', []) or []:
                        html = html or (sp.get('html') or '').strip()
            out = ['*%s*' % sub_markers(c, pi) for c in caps if c]
            if html:
                out.append(html)
            # 以图片承载的表格，html 是空的，图必须照样输出，否则内容直接丢失
            for p in image_paths(b):
                out.append('![](images/%s)' % os.path.basename(p) if has_images else '![](%s)' % p)
            if not html and not image_paths(b):
                inner = ' '.join(strip_tags(block_text(s)).strip()
                                 for s in sub_blocks_by_type(b, ('table_body', 'image_body')))
                if inner.strip():
                    out.append(sub_markers(inner.strip(), pi))
            out += ['<small>%s</small>' % sub_markers(c, pi) for c in foots if c]
            return '\n\n'.join(x for x in out if x)

        txt = strip_tags(seamed_text(pi, b) if use_para else block_text(b)).strip()
        if seam:
            txt = seam(txt)
        if not txt:
            return ''
        txt = sub_markers(txt, pi)

        if typ == 'title':
            plain = re.sub(r'^#+\s*', '', txt)
            lvl = max(1, min(6, int(b.get('level') or 2)))
            return '#' * lvl + ' ' + plain

        # 单行块的 x0 等于首行缩进后的位置，跟缩排引文无法区分——只判定多行块。
        # 实测在一本 200 页的书上，不加这个限制会产生 53 处误报、0 处真引文。
        x0, x1 = margins.get(pi, (None, None))
        if x0 is not None and len(b.get('lines') or []) >= 2 and b['bbox'][0] - x0 > a.quote_indent:
            li = b['bbox'][0] - x0
            ri = x1 - b['bbox'][2]
            # 居中块（题名、作者、机构、居中小标题）两侧留白接近，跟缩排引文不是一回事
            centered = abs(li - ri) < 12 and len(b.get('lines') or []) <= 2
            kind = 'center' if centered else 'quote'
            quote_candidates.append((pnum[pi], kind, round(li), round(ri), txt[:46]))
            return '<!--?%s--> %s' % (kind, txt)
        return txt

    lines = []
    seen_pages = set()
    for pi, pg in enumerate(layout):
        # 每页恰好一个物理页锚点：这一页没被上一页的接缝领走，就在本页第一个块前独占一段（空白页也写）
        if pi not in seen_pages:
            seen_pages.add(pi)
            lines.append(tags[pi])
        for b in (para_blocks(pg) if use_para else body_blocks(pg)):
            if b.get('lines_deleted') and not b.get('lines') and not b.get('blocks'):
                continue
            key = (pi, b.get('index'))
            if key in merged_into:
                continue
            # 旧产物（block_list.json 的 mergeConnections）：沿着链条把后续页的文字接上，锚点插在接缝处
            pieces = [render(pi, b)]
            k = key
            while k in merge:
                nk = merge[k]
                npi = nk[0]
                nb = next((x for x in body_blocks(layout[npi]) if x.get('index') == nk[1]), None)
                if nb is None:
                    break
                seg = render(npi, nb)
                if seg and npi not in seen_pages:
                    pieces.append(tags[npi] + seg)
                    seen_pages.add(npi)
                    seams.append((pnum[npi], strip_tags(pieces[-2])[-16:], seg[:16]))
                elif seg:
                    pieces.append(seg)
                k = nk
            body = ''.join(pieces).strip()
            if body:
                lines.append(body)

    lines, joined = join_page_breaks(lines)
    empty_tables = []
    for pi, pg in enumerate(layout):
        blocks = para_blocks(pg) if use_para else body_blocks(pg)
        prev_tables = pi > 0 and any(b.get('type') == 'table'
                                     for b in (para_blocks(layout[pi - 1]) if use_para else body_blocks(layout[pi - 1])))
        if prev_tables and any(b.get('type') == 'table' and not strip_tags(block_text(b)).strip()
                               and not any(sp.get('html') for sub in sub_blocks_by_type(b, ('table_body',))
                                           for ln in sub.get('lines') or [] for sp in ln.get('spans') or [])
                               for b in blocks):
            empty_tables.append(pnum[pi])

    notes, meta, split, added, unnumbered = collect_footnotes(layout, pnum, parse_add_footnote(a.add_footnote), tags)

    head = ['---',
            '# 期刊/图书元数据——从 _probe.txt 的页眉与期刊元信息补全后删掉本行注释',
            'title: ',
            'author: ',
            'tags: []   # tags/aliases/cssclasses 是 Obsidian 内置属性，必须保持英文键名',
            '---',
            '']

    # 期刊元信息（收稿日期、基金项目……）不从书里拿掉：放在骨架开头打 <!--?meta--> 标记，由 AI 移进 frontmatter
    meta_blocks = ['<!--?meta--> %s' % t for _, t in meta]
    out = '\n'.join(head) + '\n' + '\n\n'.join(meta_blocks + lines) + '\n\n---\n\n## 注释\n\n'
    for i, (tag, t) in enumerate(notes, 1):
        out += '[^%d]: %s %s\n\n' % (i, tag, t)

    with open(a.out, 'w', encoding='utf-8') as fh:
        fh.write(out)

    R = ['# 骨架构建报告\n\n']
    R.append('输出: %s\n' % os.path.abspath(a.out))
    R.append('页数 %d / 正文块 %d / 脚注 %d\n' % (len(layout), len(lines), len(notes)))
    R.append('圈码总数 %d，其中按 --skip-marker 跳过 %d，转为脚注引用 %d\n'
             % (state['seq'], len(skip), state['used']))
    if state['used'] != len(notes):
        R.append('\n** 引用数 %d != 脚注定义数 %d。先回到 probe.py 的审计结果查清原因，不要直接交付。 **\n'
                 % (state['used'], len(notes)))
    else:
        R.append('-> 引用与定义数量一致。\n')

    if added:
        R.append('\n## 按 --add-footnote 回补的脚注，共 %d 条\n' % len(added))
        R.append('  这些是 MinerU 整条漏掉或误判成正文的注，已核对原刊后补回。**必须写进交付报告。**\n')
        for pn, c, t in added:
            R.append('  PDF 第 %-5s页 %s %s\n' % (pn, c, t[:70]))

    if split:
        R.append('\n## 领起多个圈码、已拆成多条的脚注，共 %d 处\n' % len(split))
        R.append('  原刊一条注管几个引用（「②③④《史记·商君列传》。」），拆开后每个圈码各得一条同文的注。\n')
        R.append('  拆出来的条目按圈码值在页内重排过，因为原书这类块的排列并不是 ①②③④。\n')
        for pn, marks, t in split:
            R.append('  PDF 第 %-5s页 %-8s %s\n' % (pn, marks, t[:60]))

    if joined:
        R.append('\n## 疑似被换页切断、MinerU 没合并的段落，共 %d 处（骨架没动，交 AI 定）\n' % len(joined))
        R.append('  上页结尾无句末标点、下页开头不像新段。对着两页原图看：确是一段就接上，把下一页锚点留在接缝处；\n')
        R.append('  不是就不动。别给上页末尾补句号。「跨图 N」：断点中间夹着 N 个图／图注块。\n')
        for pn, l, r, nf in joined:
            R.append('  PDF 第 %-5s页 …%s  ▷?▷  %s…%s\n' % (pn, l, r, ('  跨图 %d' % nf) if nf else ''))

    if unnumbered:
        R.append('\n## 开头没认出注号的脚注块，共 %d 条（照位置当一条注保留，交 AI 核）\n' % len(unnumbered))
        R.append('  可能是注号漏识、上页注文的续接、或页下的别的文字。对着原页定：续接的并回上一条注，别的照原样处理。\n')
        for pn, t in unnumbered:
            R.append('  PDF 第 %-5s页 %s\n' % (pn, t[:70]))

    if meta:
        R.append('\n## 期刊元信息，共 %d 条（骨架开头已标 <!--?meta-->，交 AI 移进 frontmatter）\n' % len(meta))
        for pn, t in meta:
            R.append('  PDF 第 %s 页  %s\n' % (pn, t))

    if head_map:
        R.append('\n## 标题层级（源里全是同一级，下面只是按编号形态的建议，骨架没改级）\n')
        R.append('  层级由 AI 看目录原页定（references/toc-headings.md）。建议：%s\n'
                 % '；'.join('%s → H%d' % kv for kv in head_map))

    if empty_tables:
        R.append('\n## 疑似跨页表，共 %d 处（交 AI 定）\n' % len(empty_tables))
        R.append('  这一页的表格块是空的、上一页有表：MinerU 多半把续表并进了上一页的表。数据定不了哪几行属于这一页，\n')
        R.append('  所以这一页的锚点落在整张表之后。看两页原图：把锚点挪进表里续表开始处，或照原样留着并写进校注。\n')
        for pn in empty_tables:
            R.append('  PDF 第 %s 页\n' % pn)

    if quote_candidates:
        R.append('\n## 缩排/居中块（骨架已标 <!--?quote--> / <!--?center-->），共 %d 处\n'
                 % len(quote_candidates))
        R.append('  依据是 bbox 缩进量，只是线索不是结论。中文段落首行缩进 2 字，\n')
        R.append('  单行段落会被误判为缩排；居中的题名/作者两侧留白接近，标为 center。\n')
        R.append('  逐条对着文字确认：确是引文改成 > 引用块；题名/作者按其本来身份处理；都不是就删掉标记。\n')
        R.append('  物理页  类型    左缩进  右缩进  文字\n')
        for pn, kind, li, ri, t in quote_candidates:
            R.append('  %-7s %-7s %-7s %-7s %s\n' % (pn, kind, li, ri, t))

    R.append('\n## 物理页锚点\n')
    R.append('  PDF 第 %d—%d 页，共 %d 个锚点；其中 %d 个按 MinerU 的 cross_page 接缝插在段中。\n'
             % (pnum[0], pnum[len(layout) - 1], len(layout), len(seams)))
    if seams:
        R.append('  段中接缝（抽查几处对原图）：\n')
        for pn, l, r in seams[:40]:
            R.append('  PDF 第 %-5s页 …%s ▷ %s…\n' % (pn, l, r))
        if len(seams) > 40:
            R.append('  ……另 %d 处\n' % (len(seams) - 40))
    no_printed = [pnum[pi] for pi in pnum if printed[pi] is None]
    R.append('\n## 印刷页 <!--p.M-->（按 MinerU 读到的页码推定，待核）\n')
    if no_printed:
        R.append('  没写印刷页的物理页（封面、扉页等推不出页码）：%s\n' % ', '.join(map(str, no_printed[:60])))
    for pi, kind, note in page_review:
        label = {'misread': '疑误读', 'jump': '跳号', 'inferred': '推定'}[kind]
        R.append('  PDF 第 %-5s页 %s：%s\n' % (pnum[pi], label, note))
    if not page_review and not no_printed:
        R.append('  每页都读到了页码，前后一致。\n')

    R.append('\n## 下一步（都由 AI 对原页图决定，脚本没动内容）\n')
    R.append('  1. 逐条处理上面列的候选：跨页断段、没认出注号的注、跨页表、印刷页待核\n')
    R.append('  2. 复核 <!--?quote--> / <!--?center--> 标记；把 <!--?meta--> 移进 frontmatter\n')
    R.append('  3. 标题层级按目录原页定\n')
    R.append('  4. verify.py 校验 -> diff_report.py 出改动报告\n')
    # 报告跟着骨架走：骨架在 <书>/_数据/过程报告/ 时报告也在那里，不写进 MinerU 原始目录
    rep_dir = os.path.dirname(os.path.abspath(a.out))
    name = '_build_report.txt'
    vol = re.search(r'pages-\d+-\d+', os.path.basename(os.path.normpath(a.dir)))
    if vol:
        name = '_build_report_%s.txt' % vol.group(0)
    write_report(process_report(rep_dir, name) if '_数据' in rep_dir.split(os.sep) else os.path.join(rep_dir, name), ''.join(R))
    print('blocks=%d footnote_refs=%d footnote_defs=%d quote_candidates=%d joined=%d'
          % (len(lines), state['used'], len(notes), len(quote_candidates), len(joined)))


if __name__ == '__main__':
    main()
