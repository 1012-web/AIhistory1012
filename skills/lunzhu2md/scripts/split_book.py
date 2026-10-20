"""把论文或整书骨架整理成交付文件：默认正文合成一份，卷首与书末另存；另出一份索引。

用法:
    python split_book.py <材料.md> -o <书文件夹> [--pdf <原件或文字层副本>.pdf] [--meta book=中国近现代史 --meta year=2009]
                         [--level 1|2] [--start-page 1] [--body 3-14] [--no-index] [--index-name 索引.md]
                         [--split]

默认（合并）:
    图书：正文各章合成一份 NN-正文.md；正文之前的篇章（书名页、目录、前言、总序……）与之后的
    （后记、附录、郑重声明……）各自一个文件。哪些算正文：默认从第一个到最后一个「第X章/编/篇/部分、
    绪论、导论、结束语……」标题；认错时用 --body 起-止（按本脚本列出的篇章序号）指定。
    正文脚注全书连续编号，注释放在各章末尾（「---」+「## 注释」），检索到某段时注就在同一章里。
    正文 frontmatter 的 chapter_metadata 记各章标题与印刷页：章首页的页码锚点在拼接时会落在上一章，
    靠它才知道每章从哪一页起。
    论文（--level 2）：整篇一份文件，注释在文末。

--split（只在用户要求按章拆分时用）:
    每个篇章一个文件，脚注按篇章重编号。

每个文件的 frontmatter 都写 `pdf: "[[<PDF>]]"`（锚点约定见仓库 docs/anchors.md）；另写 `_数据/book.json`
（PDF、文件列表与各文件的物理页范围、页码偏移），Obsidian 插件按它配对。章首页的锚点独占一段、紧挨在章标题前时，
跟着章标题进新文件。

不要再叠一份全文/全书：同一段文字存两份，检索时同时命中、互相挤占名额，两份还会随编辑漂移。

输入要求:
    - 可有可无的 YAML frontmatter（其中的字段会被每一章继承）
    - 图书通常用 `# ` 一级标题分章；论文通常用 `## ` 二级标题分节，并传 --level 2
    - 文末的注释区形如 `\\n\\n---\\n\\n## 注释\\n\\n` 后跟 `[^n]: <!--pdf-page.N--><!--p.M--> 正文`
"""
import argparse
import collections
import hashlib
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import PDF_PAGE_RE, anchor_page, die, process_report, split_notes, write_report

SPLIT_RE = re.compile(r'\n+---\n+#+\s*注释\s*\n+')
# 脚注定义开头的锚点（<!--pdf-page.N--><!--p.M-->，或旧格式只有 <!--p.M-->）原样保留
NOTE_RE = re.compile(r'^\[\^(\d+)\]:\s*((?:<!--pdf-page\.\d+-->)?(?:<!--p\.[^>]+?-->)?)\s*(.*)$', re.S)
ANCHOR = re.compile(r'<!--p\.([^>]+?)-->')   # 印刷页，用于 frontmatter 的 pages
GENERATOR = 'lunzhu2md 0.1.0'
FM_RE = re.compile(r'^---\n(.*?)\n---\n', re.S)
BAD = '\\/:*?"<>|'


def safe(name):
    for c in BAD:
        name = name.replace(c, '／' if c == '/' else '-')
    # 文件名不留空格：命令行里拼 --md 时空格最容易出错
    return re.sub(r'\s+', '-', name.strip())


def parse(path):
    text = io.open(path, encoding='utf-8', errors='strict').read()
    fm = ''
    m = FM_RE.match(text)
    if m:
        fm = m.group(1)
        text = text[m.end():]
    parts = SPLIT_RE.split(text, maxsplit=1)
    body = parts[0].strip()
    notes = {}
    if len(parts) > 1:
        for chunk in parts[1].strip().split('\n\n'):
            chunk = chunk.strip()
            if not chunk:
                continue
            mm = NOTE_RE.match(chunk)
            if not mm:
                die('脚注解析失败，这一条不是 `[^n]: 正文` 的形态:\n' + chunk[:80])
            notes[int(mm.group(1))] = (mm.group(2) or '', mm.group(3).strip())
    return fm, body, notes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('md')
    ap.add_argument('-o', '--out', required=True)
    ap.add_argument('--meta', action='append', default=[],
                    help='附加到每章 frontmatter 的字段，形如 book=中国近现代史，可重复')
    ap.add_argument('--start-page', default=None,
                    help='第一章起始印刷页（首个页码锚点常在章标题之前，切分时已被留在卷首）')
    ap.add_argument('--level', type=int, choices=(1, 2), default=1,
                    help='按第几级标题切分：1=一级标题（默认，常用于图书），2=二级标题（常用于论文）')
    ap.add_argument('--index-name', default=None, help='索引文件名，默认取 --meta 里的 book')
    ap.add_argument('--no-index', action='store_true')
    ap.add_argument('--body', default=None,
                    help='合并时哪几个篇章算正文，形如 3-14（本脚本报告里的篇章序号）；默认按标题自动认')
    ap.add_argument('--split', action='store_true', help='按篇章拆成多个文件（旧做法，只在用户要求时用）')
    ap.add_argument('--pdf', default=None,
                    help='frontmatter pdf 指向的文件（原件或 <原件>.文字层.pdf）；默认在书文件夹里找，文字层副本优先')
    ap.add_argument('--original-pdf', default=None, help='原件文件名（记进 book.json）；默认由 --pdf 推')
    a = ap.parse_args()

    if not os.path.isdir(a.out):
        os.makedirs(a.out)
    extra = []
    for kv in a.meta:
        if '=' not in kv:
            die('--meta 要写成 键=值: ' + kv)
        extra.append(tuple(kv.split('=', 1)))
    meta = dict(extra)
    a.pdf_name, a.original_name = resolve_pdf(a)

    fm, body, notes = parse(a.md)
    blocks = body.split('\n\n')
    heading_re = re.compile(r'^' + re.escape('#' * a.level) + r'\s+(.+)$')
    first_split = next((i for i, b in enumerate(blocks) if heading_re.match(b)), None)
    if first_split is None:
        die('正文没有可供切分的 %d 级标题。先确认 build.py 的层级重建结果，或改用 --level 1/2。' % a.level)

    chapters, cur = [], None
    preface = blocks[:first_split]
    for b in blocks[first_split:]:
        match = heading_re.match(b)
        if match:
            carry = []
            if cur is not None:
                # 上一章末尾独占一段的锚点紧挨着本章标题：那一页从本章标题开始，锚点跟着本章走
                # （只挪紧挨着的那一个；再往前的空白页锚点留在上一章）
                if cur['blocks'] and anchor_page(cur['blocks'][-1]) is not None:
                    carry.append(cur['blocks'].pop())
            cur = {'title': match.group(1).strip(), 'blocks': (list(preface) if not chapters else []) + carry}
            chapters.append(cur)
        cur['blocks'].append(b)
    page_ranges(chapters, heading_re, a.start_page)

    if not a.split:
        merged(a, fm, extra, meta, notes, chapters)
        return

    rows = []
    for i, c in enumerate(chapters, 1):
        used, remap = [], {}

        def sub(m):
            n = int(m.group(1))
            if n not in remap:
                used.append(n)
                remap[n] = len(used)
            return '[^%d]' % remap[n]

        text = re.sub(r'\[\^(\d+)\]', sub, '\n\n'.join(c['blocks']))
        missing = [n for n in used if n not in notes]
        if missing:
            die('第 %d 章引用了没有定义的脚注: %s' % (i, missing[:8]))

        pages = '-'.join(x for x in (c['start'], c['end']) if x) or ''
        head = ['---', 'title: %s' % c['title'], pdf_line(a.pdf_name)]
        head += clean_fm(fm, extra)
        head += ['%s: %s' % kv for kv in extra]
        if pages:
            head.append('pages: %s' % pages)
        head += ['---', '']

        out = '\n'.join(head) + '\n' + text
        if used:
            out += '\n\n---\n\n## 注释\n\n' + '\n\n'.join(note_line(remap[n], notes[n]) for n in used)
        fname = '%02d-%s.md' % (i, safe(c['title']))
        io.open(os.path.join(a.out, fname), 'w', encoding='utf-8', errors='strict').write(out.rstrip() + '\n')
        rows.append((i, c['title'], fname, pages, len(used)))

    used_all = sum(r[4] for r in rows)

    if not a.no_index:
        name = a.index_name or (safe(meta.get('book', '')) + '.md' if meta.get('book') else '索引.md')
        L = ['---', pdf_line(a.pdf_name)]
        L += ['%s: %s' % kv for kv in extra]
        L += ['---', '', '# %s' % meta.get('book', os.path.basename(a.md)[:-3]), '',
              '| 篇章 | 文件 | 印刷页 | 脚注 |', '|---|---|---|---|']
        for i, title, fname, pages, n in rows:
            L.append('| %s | [[%s]] | %s | %d |' % (title, fname[:-3], pages or '—', n))
        L += ['', '共 %d 篇章，%d 条脚注。' % (len(rows), used_all)]
        io.open(os.path.join(a.out, name), 'w', encoding='utf-8', errors='strict').write('\n'.join(L) + '\n')
    write_book_json(a, meta.get('book') or os.path.basename(a.md)[:-3], a.pdf_name, a.original_name,
                    [r[2] for r in rows], None if a.no_index else name, {r[2]: r[3] for r in rows if r[3]})

    R = ['# 分章报告\n\n输出目录: %s\n\n' % os.path.abspath(a.out)]
    R.append('%-4s %-46s %-12s %s\n' % ('#', '标题', '印刷页', '脚注'))
    for i, title, fname, pages, n in rows:
        R.append('%-4d %-46s %-12s %d\n' % (i, title[:46], pages or '—', n))
    R.append('\n共 %d 篇章；脚注 源 %d 条 -> 分配 %d 条\n' % (len(rows), len(notes), used_all))
    if used_all != len(notes):
        R.append('\n** 有 %d 条脚注没有被任何一章引用。回到 verify.py / diff_report.py 查清楚。 **\n'
                 % (len(notes) - used_all))
    R.append('\n下一步: 对每个成品跑 verify.py，再跑 diff_report.py 出改动报告。\n')
    write_report(process_report(a.out, '_split_report.txt'), ''.join(R))
    print('chapters=%d notes_src=%d notes_placed=%d' % (len(rows), len(notes), used_all))


# 「序论」「緒論」是正文第一篇（带注），不是卷首的「序」（实测一本专著的序论有 13 条注，曾被划进卷首）
BODY_TITLE = re.compile(r'^(第[一二三四五六七八九十百零〇两\d]+[章编篇部讲編]|绪论|緒論|序论|序論|导论|導論|引论|引論'
                        r'|导言|導言|结束语|結束語|结语|結語|余论|餘論|尾论|尾論)')


def page_ranges(chapters, heading_re, start_page):
    """每章的印刷页起止：起页是章标题那一刻生效的页码（前面的锚点都算），止页是章内最后一个页码。"""
    page = start_page
    for c in chapters:
        c['start'] = None
        for b in c['blocks']:
            if c['start'] is None and heading_re.match(b):
                c['start'] = page
            for m in ANCHOR.finditer(b):
                page = m.group(1)
        c['end'] = page


def body_of(text):
    """去掉 frontmatter 与注释区，只留正文（锚点检查只看正文区）。"""
    return split_notes(FM_RE.sub('', text, count=1))[0]


def pdf_ranges(out, fnames):
    """各文件的物理页范围 [首, 末]：文件开头不是锚点时，首页取上一文件最后的物理页（内容从那页中间接着来）。"""
    ranges, carry = {}, None
    for fname in fnames:
        body = body_of(io.open(os.path.join(out, fname), encoding='utf-8').read()).strip()
        pages = [int(x) for x in PDF_PAGE_RE.findall(body)]
        first_block = body.split('\n\n', 1)[0] if body else ''
        starts_with_anchor = anchor_page(first_block) is not None and pages
        first = pages[0] if starts_with_anchor else (carry if carry is not None else (pages[0] if pages else None))
        last = pages[-1] if pages else first
        ranges[fname] = [first, last] if first is not None else None
        carry = last if last is not None else carry
    return ranges


def resolve_pdf(a):
    """frontmatter 要指向的 PDF：--pdf 给了就用；否则在书文件夹里找，文字层副本优先，其次唯一的原件。"""
    if a.pdf:
        name = os.path.basename(a.pdf)
    else:
        pdfs = sorted(f for f in os.listdir(a.out) if f.lower().endswith('.pdf'))
        layer = [f for f in pdfs if f.endswith('.文字层.pdf')]
        plain = [f for f in pdfs if not f.endswith('.文字层.pdf')]
        if len(layer) == 1:
            name = layer[0]
        elif len(plain) == 1:
            name = plain[0]
        else:
            die('书文件夹里找不到唯一的 PDF（%d 个），用 --pdf 指定 frontmatter 要指向的文件。' % len(pdfs))
    original = os.path.basename(a.original_pdf) if a.original_pdf else (
        name[:-len('.文字层.pdf')] + '.pdf' if name.endswith('.文字层.pdf') else name)
    return name, original


def pdf_line(name):
    return 'pdf: "[[%s]]"' % name


TAG_RE = re.compile(r'<!--pdf-page\.\d+-->(?:<!--p\.[^>]+?-->)?')


def add_continuation_anchors(out, fnames):
    """一页跨两个文件时，后一个文件开头补一个「续页锚点」：与前一文件最后一个锚点相同、独占一段（docs/anchors.md 二·6）。"""
    added, prev = [], None
    for fname in fnames:
        path = os.path.join(out, fname)
        text = io.open(path, encoding='utf-8').read()
        m = FM_RE.match(text)
        start = m.end() if m else 0
        first = text[start:].lstrip('\n').split('\n\n', 1)[0]
        if prev and anchor_page(first) is None:
            text = text[:start] + '\n' + prev + '\n\n' + text[start:].lstrip('\n')
            io.open(path, 'w', encoding='utf-8', errors='strict').write(text)
            added.append((fname, prev))
        tags = TAG_RE.findall(body_of(text))
        if tags:
            prev = tags[-1]
    return added


def write_book_json(a, title, pdf, original, fnames, index_name, chapters_rows):
    """<书>/_数据/book.json（第 2 版，只加字段不删旧字段）。格式见 docs/anchors.md 第五节。"""
    add_continuation_anchors(a.out, fnames)
    ranges = pdf_ranges(a.out, fnames)
    pairs = collections.Counter()
    page_count = None
    for fname in fnames:
        body = body_of(io.open(os.path.join(a.out, fname), encoding='utf-8').read())
        for phys, printed in re.findall(r'<!--pdf-page\.(\d+)--><!--p\.(\d+)-->', body):
            pairs[int(phys) - int(printed)] += 1
        for x in PDF_PAGE_RE.findall(body):
            page_count = max(page_count or 0, int(x))
    try:
        from pypdf import PdfReader
        target = os.path.join(a.out, pdf)
        if os.path.isfile(target):
            page_count = len(PdfReader(target).pages)
    except Exception:
        pass
    files = []
    for fname in fnames:
        item = {'path': fname}
        if ranges.get(fname):
            item['pdfPages'] = ranges[fname]
        if chapters_rows.get(fname):
            item['printedPages'] = chapters_rows[fname]
        files.append(item)
    # 旧字段 id、title、pdf、printedPageOffset、writingMode 照旧写；index（旧书的逐字映射索引）、ocrBackend、rebuild 第 2 版不写
    book = {'version': 2, 'id': 'lunzhu2md-' + hashlib.sha1(title.encode('utf-8')).hexdigest()[:10], 'title': title,
            'pdf': pdf, 'originalPdf': original, 'pageCount': page_count,
            'printedPageOffset': pairs.most_common(1)[0][0] if pairs else None,
            'writingMode': 'horizontal-tb', 'files': files, 'generator': GENERATOR}
    if index_name:
        book['indexNote'] = index_name
    target = os.path.join(a.out, '_数据', 'book.json')
    # 只加字段、不删字段：已有 book.json 里本脚本不写的键（如用户确认过的凡例 conventions）原样保留
    if os.path.isfile(target):
        try:
            with io.open(target, encoding='utf-8') as fh:
                old = json.load(fh)
        except ValueError:
            old = None
        if isinstance(old, dict):
            book = dict(book, **{k: v for k, v in old.items() if k not in book})
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with io.open(target, 'w', encoding='utf-8') as fh:
        fh.write(json.dumps(book, ensure_ascii=False, indent=2) + '\n')
    return book


def page_range(c):
    return '-'.join(x for x in (c['start'], c['end']) if x) or ''


def note_line(number, note):
    prefix, text = note
    return '[^%d]: %s%s' % (number, (prefix + ' ') if prefix else '', text)


def renumber(text, notes, counter, where):
    """把 text 里的 [^n] 按首次出现顺序接着 counter 编号；返回新文本与本段用到的注（新号, 旧注）。"""
    used = []
    remap = {}

    def sub(m):
        n = int(m.group(1))
        if n not in remap:
            counter[0] += 1
            remap[n] = counter[0]
            used.append(n)
        return '[^%d]' % remap[n]

    out = re.sub(r'\[\^(\d+)\]', sub, text)
    missing = [n for n in used if n not in notes]
    if missing:
        die('%s引用了没有定义的脚注: %s' % (where, missing[:8]))
    return out, [(remap[n], notes[n]) for n in used]


def clean_fm(fm, extra):
    """骨架带来的 frontmatter：去掉注释行、空值的占位键（build.py 写的 `author: `），
    以及 --meta 也给了的同名键（--meta 为准）。否则会出现两个 author、两个 year，YAML 读不了。"""
    given = {k.strip() for k, _ in extra} | {'title', 'pages', 'pdf'}
    keep = []
    for ln in fm.split('\n'):
        if not ln.strip() or ln.lstrip().startswith('#'):
            continue
        m = re.match(r'^([^\s:#][^:]*?)\s*:\s*(.*?)\s*(?:#.*)?$', ln)
        if m and (m.group(1) in given or m.group(2) in ('', '[]', '""', "''")) and not ln.startswith((' ', '-')):
            continue
        keep.append(ln)
    return keep


def frontmatter(title, fm, extra, pages, more=(), pdf=None):
    head = ['---', 'title: %s' % title]
    if pdf:
        head.append(pdf_line(pdf))
    head += clean_fm(fm, extra)
    head += ['%s: %s' % kv for kv in extra]
    if pages:
        head.append('pages: %s' % pages)
    head += list(more)
    head += ['---', '']
    return '\n'.join(head) + '\n'


def merged(a, fm, extra, meta, notes, chapters):
    book = meta.get('book') or os.path.basename(a.md)[:-3]
    if a.level == 2:
        # 论文：整篇一份，注释在文末
        counter = [0]
        whole = '\n\n'.join(b for c in chapters for b in c['blocks'])
        text, used = renumber(whole, notes, counter, '全文')
        # 论文从全文第一个页码锚点算起：题名、摘要所在的首页在第一个小节标题之前，不能从小节标题算
        first_anchor = ANCHOR.search(whole)
        start = a.start_page or (first_anchor.group(1) if first_anchor else chapters[0]['start'])
        pages = '-'.join(x for x in (start, chapters[-1]['end']) if x)
        out = frontmatter(book, fm, extra, pages, pdf=a.pdf_name) + text
        if used:
            out += '\n\n---\n\n## 注释\n\n' + '\n\n'.join(note_line(n, note) for n, note in used)
        fname = safe(book) + '.md'
        io.open(os.path.join(a.out, fname), 'w', encoding='utf-8', errors='strict').write(out.rstrip() + '\n')
        write_book_json(a, book, a.pdf_name, a.original_name, [fname], None, {fname: pages} if pages else {})
        R = ['# 整理报告\n\n输出: %s\n\n论文一份，%d 节，脚注 源 %d 条 -> 用到 %d 条\n'
             % (os.path.abspath(os.path.join(a.out, fname)), len(chapters), len(notes), len(used))]
        if len(used) != len(notes):
            R.append('\n** 有 %d 条脚注没有被引用。回到 verify.py / diff_report.py 查清楚。 **\n' % (len(notes) - len(used)))
        write_report(process_report(a.out, '_split_report.txt'), ''.join(R))
        print('paper=1 notes_src=%d notes_placed=%d' % (len(notes), len(used)))
        return

    if a.body:
        m = re.match(r'^(\d+)-(\d+)$', a.body)
        if not m or not 1 <= int(m.group(1)) <= int(m.group(2)) <= len(chapters):
            die('--body 要写成 起-止，且在 1-%d 之内: %s' % (len(chapters), a.body))
        first, last = int(m.group(1)) - 1, int(m.group(2)) - 1
    else:
        hits = [i for i, c in enumerate(chapters) if BODY_TITLE.match(c['title'])]
        if not hits:
            die('认不出哪些篇章是正文（没有「第X章」之类的标题）。看 --split 报告里的篇章序号，用 --body 起-止 指定。')
        first, last = hits[0], hits[-1]

    rows = []  # (序号, 篇章标题, 文件名, 链接目标, 印刷页, 脚注数)
    number = 0

    def write(fname, content):
        io.open(os.path.join(a.out, fname), 'w', encoding='utf-8', errors='strict').write(content.rstrip() + '\n')

    def single(c):
        nonlocal number
        number += 1
        text, used = renumber('\n\n'.join(c['blocks']), notes, [0], '「%s」' % c['title'])
        out = frontmatter(c['title'], fm, extra, page_range(c), pdf=a.pdf_name) + text
        if used:
            out += '\n\n---\n\n## 注释\n\n' + '\n\n'.join(note_line(n, note) for n, note in used)
        fname = '%02d-%s.md' % (number, safe(c['title']))
        write(fname, out)
        rows.append((c['title'], fname, fname[:-3], page_range(c), len(used)))

    for c in chapters[:first]:
        single(c)

    number += 1
    body_name = '%02d-正文.md' % number
    counter = [0]
    parts = []
    body_rows = []
    for c in chapters[first:last + 1]:
        text, used = renumber('\n\n'.join(c['blocks']), notes, counter, '「%s」' % c['title'])
        if used:
            text += '\n\n---\n\n## 注释\n\n' + '\n\n'.join(note_line(n, note) for n, note in used)
        parts.append(text)
        body_rows.append((c['title'], body_name, '%s#%s' % (body_name[:-3], c['title']), page_range(c), len(used)))
    body_chapters = chapters[first:last + 1]
    metadata = ['chapter_metadata:']
    for c in body_chapters:
        metadata.append('- title: %s' % c['title'])
        if page_range(c):
            metadata.append('  pages: %s' % page_range(c))
    pages = body_pages = '-'.join(x for x in (body_chapters[0]['start'], body_chapters[-1]['end']) if x)
    more = ['footnotes: 全书正文连续编号；注释在各章末尾'] + metadata
    write(body_name, frontmatter('%s · 正文' % book, fm, extra, pages, more, pdf=a.pdf_name) + '\n\n'.join(parts))
    rows.extend(body_rows)

    for c in chapters[last + 1:]:
        single(c)

    used_all = sum(r[4] for r in rows)
    if not a.no_index:
        name = a.index_name or safe(book) + '.md'
        L = ['---', pdf_line(a.pdf_name)]
        L += ['%s: %s' % kv for kv in extra]
        L += ['---', '', '# %s' % book, '',
              '> 正文 %d 章合为一份 [[%s]]；卷首与书末另存。' % (len(body_chapters), body_name[:-3]), '',
              '| 篇章 | 文件 | 印刷页 | 脚注 |', '|---|---|---|---|']
        for title, fname, target, pages, n in rows:
            L.append('| %s | [[%s\\|%s]] | %s | %d |' % (title, target, fname[:-3], pages or '—', n))
        L += ['', '共 %d 篇章（正文 %d 章），%d 条脚注。' % (len(rows), len(body_chapters), used_all)]
        write(name, '\n'.join(L))
    fnames = list(dict.fromkeys(r[1] for r in rows))
    printed = {}
    for title, fname, _, pages_, _ in rows:
        printed.setdefault(fname, pages_)
    printed[body_name] = body_pages
    write_book_json(a, book, a.pdf_name, a.original_name, fnames, None if a.no_index else name,
                    {k: v for k, v in printed.items() if v})

    R = ['# 整理报告\n\n书文件夹: %s\n\n' % os.path.abspath(a.out)]
    R.append('%-4s %-46s %-14s %-12s %s\n' % ('#', '篇章', '文件', '印刷页', '脚注'))
    for i, (title, fname, _, pages, n) in enumerate(rows, 1):
        R.append('%-4d %-46s %-14s %-12s %d\n' % (i, title[:46], fname[:14], pages or '—', n))
    R.append('\n正文：第 %d—%d 篇（%s）；如认错，用 --body 起-止 重跑。\n'
             % (first + 1, last + 1, '手动指定' if a.body else '按标题自动认'))
    R.append('\n共 %d 篇章；脚注 源 %d 条 -> 分配 %d 条\n' % (len(rows), len(notes), used_all))
    if used_all != len(notes):
        R.append('\n** 有 %d 条脚注没有被任何篇章引用。回到 verify.py / diff_report.py 查清楚。 **\n'
                 % (len(notes) - used_all))
    R.append('\n下一步: 对每个成品跑 verify.py，再跑 diff_report.py 出改动报告。\n')
    write_report(process_report(a.out, '_split_report.txt'), ''.join(R))
    print('files=%d body_chapters=%d notes_src=%d notes_placed=%d' % (
        len({r[1] for r in rows}), len(body_chapters), len(notes), used_all))


if __name__ == '__main__':
    main()
