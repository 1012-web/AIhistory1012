"""成品自检：脚注编号、标签残留、页码锚点、frontmatter（含 pdf）、图片链接。

用法:
    python verify.py <成品.md> [--images-dir <目录>]
    python verify.py --book <书文件夹>        # 按 _数据/book.json 逐个文件查，再查全书物理页锚点全覆盖

锚点约定见仓库 docs/anchors.md：每个物理页恰好一个 <!--pdf-page.N-->，正文里连续、单调；
<!--p.M--> 紧跟在物理页锚点后；锚点不写进标题行；每个文件 frontmatter 有 pdf: "[[…pdf]]"。
只报结构性问题。内容层面的改动要靠 diff_report.py。
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import PDF_PAGE_RE, latin_runs, mostly_chinese, process_report, split_notes, write_report

BUILTIN = ('tags', 'aliases', 'cssclasses')
BUILTIN_CN = {'标签': 'tags', '别名': 'aliases', '样式': 'cssclasses'}


PDF_LINK_RE = re.compile(r'^pdf:\s*["\']?\[\[([^\]|#]+?\.pdf)(?:[|#][^\]]*)?\]\]["\']?\s*$', re.M)
PRINTED_ANY = re.compile(r'<!--p\.([^>]+?)-->')


def anchor_checks(body, problems, warnings, R, allow_gaps=False):
    """正文区的页码锚点（docs/anchors.md 第二节）。返回正文里的物理页号列表（按出现顺序）。

    缺页是问题（新导入的书每页都要有）；--allow-gaps 时只提示（旧数据、外来笔记）。
    倒序只提示（扫描件本身页序乱时照实写）。"""
    phys = [int(x) for x in PDF_PAGE_RE.findall(body)]
    printed = PRINTED_ANY.findall(body)
    R.append('正文物理页锚点: %d 个%s；印刷页锚点: %d 个\n'
             % (len(phys), ('（PDF 第 %d—%d 页）' % (phys[0], phys[-1])) if phys else '', len(printed)))
    if not phys:
        if printed:
            warnings.append('只有印刷页锚点 <!--p.M-->、没有物理页锚点 <!--pdf-page.N-->：旧格式，'
                            '插件只能按 book.json 的 printedPageOffset 换算')
        else:
            problems.append('正文没有任何页码锚点')
        return phys
    dup = sorted({n for n in phys if phys.count(n) > 1})
    if dup:
        problems.append('同一物理页有多个锚点: %s' % dup[:20])
    backward = [(a, b) for a, b in zip(phys, phys[1:]) if b < a]
    if backward:
        warnings.append('物理页锚点倒序（扫描件页序本来就乱的照实写；否则核对块顺序）: %s'
                        % ', '.join('%d→%d' % x for x in backward[:10]))
    ordered = sorted(set(phys))
    missing = [n for a, b in zip(ordered, ordered[1:]) for n in range(a + 1, b)]
    if missing:
        (warnings if allow_gaps else problems).append('物理页锚点不连续，缺 %d 页: %s' % (len(missing), missing[:30]))
    # 每个物理页最多一个 <!--p.M-->，归它前面最近的物理页锚点；页首是章标题时两者可以分开写
    tokens = re.findall(r'<!--pdf-page\.\d+-->|<!--p\.[^>]+?-->', body)
    seen_page, counts, before_first = False, [], 0
    for token in tokens:
        if token.startswith('<!--pdf-page.'):
            seen_page = True
            counts.append(0)
        elif seen_page:
            counts[-1] += 1
        else:
            before_first += 1
    doubled = sum(1 for n in counts if n > 1)
    if doubled:
        problems.append('有 %d 个物理页带了不止一个 <!--p.M-->' % doubled)
    if before_first:
        warnings.append('文件开头有 %d 个 <!--p.M--> 在第一个物理页锚点之前' % before_first)
    in_heading = [ln.strip()[:40] for ln in body.split('\n') if ln.startswith('#') and '<!--pdf-page.' in ln]
    if in_heading:
        problems.append('锚点写进了标题行（应放在标题上一段）: %s' % in_heading[:5])
    return phys


def pdf_check(fm, md_path, problems, R):
    m = PDF_LINK_RE.search(fm or '')
    if not m:
        problems.append('frontmatter 没有 pdf: "[[<原件或文字层副本>.pdf]]"')
        return None
    name = m.group(1).strip()
    folder = os.path.dirname(os.path.abspath(md_path))
    R.append('frontmatter pdf: %s\n' % name)
    if not os.path.isfile(os.path.join(folder, name)):
        problems.append('frontmatter pdf 指向的 %s 不在书文件夹里' % name)
    return name


def check_book(folder, allow_gaps=False):
    """按 _数据/book.json 查全书：每个文件各自的检查 + 物理页锚点覆盖 1..pageCount、跨文件单调。"""
    path = os.path.join(folder, '_数据', 'book.json')
    if not os.path.isfile(path):
        print('ERROR: no _数据/book.json in ' + folder.encode('ascii', 'backslashreplace').decode('ascii'))
        sys.exit(2)
    book = json.load(open(path, encoding='utf-8'))
    R = ['# 全书自检: %s\n\n' % book.get('title', os.path.basename(folder))]
    problems, warnings, every = [], [], []
    pdfs = set()
    for item in book.get('files', []):
        md = os.path.join(folder, item['path'])
        if not os.path.isfile(md):
            problems.append('book.json 列的文件不存在: %s' % item['path'])
            continue
        result = check_file(md, None, quiet=True, allow_gaps=allow_gaps)
        R.append('- %s：物理页 %s，问题 %d 项\n' % (item['path'], ('%d—%d' % (result['phys'][0], result['phys'][-1]))
                                              if result['phys'] else '—', len(result['problems'])))
        problems += ['%s：%s' % (item['path'], x) for x in result['problems']]
        phys = list(result['phys'])
        if every and phys and phys[0] == every[-1]:
            phys = phys[1:]   # 续页锚点：与上一文件最后一个锚点相同，只在文件开头允许，不算重复
        every += phys
        if result['pdf']:
            pdfs.add(result['pdf'])
        span = item.get('pdfPages')
        if span and result['phys'] and (result['phys'][-1] != span[1]):
            problems.append('%s：book.json 记的 pdfPages %s 与文件里的锚点 %d—%d 不符'
                            % (item['path'], span, result['phys'][0], result['phys'][-1]))
    total = book.get('pageCount') or (max(every) if every else 0)
    if every:
        if sorted(every) != every:
            warnings.append('跨文件的物理页锚点不是单调递增（扫描件页序乱的照实写；否则核对文件顺序）')
        dup = sorted({n for n in every if every.count(n) > 1})
        if dup:
            problems.append('同一物理页的锚点出现在不止一处: %s' % dup[:20])
        missing = sorted(set(range(1, total + 1)) - set(every))
        if missing:
            (warnings if allow_gaps else problems).append('全书缺物理页锚点 %d 页: %s' % (len(missing), missing[:40]))
        extra = sorted(n for n in set(every) if n > total or n < 1)
        if extra:
            problems.append('锚点页号超出 PDF 页数 %d: %s' % (total, extra[:10]))
    R.append('\n全书物理页 %d 页，锚点 %d 个；frontmatter pdf：%s\n' % (total, len(every), '、'.join(sorted(pdfs)) or '—'))
    if len(pdfs) > 1:
        problems.append('各文件 frontmatter pdf 不一致: %s' % sorted(pdfs))
    if book.get('pdf') and pdfs and book['pdf'] not in pdfs:
        problems.append('book.json 的 pdf（%s）与 frontmatter 不一致' % book['pdf'])
    R.append('\n')
    if warnings:
        R.append('## 提醒 %d 项（不算失败）\n' % len(warnings))
        R += ['  - %s\n' % x for x in warnings]
    if problems:
        R.append('## 待处理 %d 项\n' % len(problems))
        R += ['  - %s\n' % x for x in problems]
    else:
        R.append('## 全部通过\n')
    write_report(process_report(folder, '_verify_book.txt'), ''.join(R))
    print('book_files=%d pages=%d anchors=%d problems=%d' % (len(book.get('files', [])), total, len(every), len(problems)))
    sys.exit(1 if problems else 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('md', nargs='?')
    ap.add_argument('--images-dir', default=None)
    ap.add_argument('--book', default=None, help='书文件夹：按 _数据/book.json 查全书')
    ap.add_argument('--allow-gaps', action='store_true', help='缺页只提示不报错（旧数据、外来笔记；新导入的书不要加）')
    a = ap.parse_args()
    if a.book:
        check_book(os.path.abspath(a.book), a.allow_gaps)
    if not a.md:
        ap.error('给一个成品 .md，或用 --book <书文件夹>')
    result = check_file(a.md, a.images_dir, allow_gaps=a.allow_gaps)
    sys.exit(1 if result['problems'] else 0)


def check_file(md, images_dir, quiet=False, allow_gaps=False):
    class A:
        pass
    a = A()
    a.md, a.images_dir = md, images_dir
    text = open(a.md, encoding='utf-8', errors="strict").read()
    R = ['# 成品自检: %s\n\n' % os.path.basename(a.md)]
    problems = []

    # ---- frontmatter
    fm = ''
    pdf_name = None
    m = re.match(r'^---\n(.*?)\n---\n', text, re.S)
    if not m:
        problems.append('没有 YAML frontmatter（如果本来就不需要，忽略这条）')
    else:
        fm = m.group(1)
        try:
            import yaml
            data = yaml.safe_load(fm)
            R.append('frontmatter: %d 个字段，YAML 解析通过\n' % (len(data) if isinstance(data, dict) else 0))
        except ImportError:
            bad = [ln for ln in fm.split('\n')
                   if ln.strip() and not ln.startswith((' ', '-', '#')) and ':' not in ln]
            R.append('frontmatter: %d 行（未装 pyyaml，只做粗查）\n' % len(fm.split('\n')))
            for ln in bad:
                problems.append('frontmatter 这行可能不是合法 YAML: %s' % ln.strip())
        except Exception as e:
            problems.append('frontmatter YAML 解析失败: %s' % e)
        pdf_name = pdf_check(fm, a.md, problems, R)
        for cn, en in BUILTIN_CN.items():
            if re.search(r'^%s\s*:' % cn, fm, re.M):
                problems.append('frontmatter 用了中文键「%s」——它是 Obsidian 内置属性，'
                                '必须写成英文 %s，否则会退化成普通文本字段' % (cn, en))

    # ---- 正文 / 注释 分区
    # 注释区可能每章一个（split_book.py 默认），全部剔掉才是正文
    body, notes = split_notes(text)
    body = re.sub(r'>\s*\[!\w+\][^\n]*\n(?:>[^\n]*\n?)*', '', body)  # 去掉 callout（含 AI 校注）

    # ---- 脚注
    refs = [int(x) for x in re.findall(r'\[\^(\d+)\](?!:)', text)]
    defs = [int(x) for x in re.findall(r'^\[\^(\d+)\]:', text, re.M)]
    R.append('脚注: 引用 %d 个（去重 %d），定义 %d 个\n' % (len(refs), len(set(refs)), len(defs)))
    if sorted(set(refs)) != sorted(defs):
        miss = sorted(set(defs) - set(refs))
        extra = sorted(set(refs) - set(defs))
        if miss:
            problems.append('有定义但正文没引用的脚注: %s' % miss)
        if extra:
            problems.append('引用了但没有定义的脚注: %s' % extra)
    if defs and sorted(defs) != list(range(1, len(defs) + 1)):
        problems.append('脚注编号不连续（应为 1..%d）' % len(defs))
    if len(refs) != len(set(refs)):
        dup = sorted({r for r in refs if refs.count(r) > 1})
        problems.append('脚注被重复引用: %s（Obsidian 对重复锚点的渲染不稳定）' % dup)

    # ---- 标签残留
    # 先剥掉行内代码/代码块：AI 校注里用反引号提到 `<sub>` 时不该被当成残留标签
    scan = re.sub(r'```.*?```', '', text, flags=re.S)
    scan = re.sub(r'`[^`\n]*`', '', scan)
    tags = re.findall(r'</?su[bp]>', scan)
    R.append('MinerU 标签残留: %d\n' % len(tags))
    if tags:
        problems.append('还有 %d 处 <sub>/<sup> 没清干净' % len(tags))
    for mark in ('<!--?quote-->', '<!--?center-->', '<!--?meta-->', '<!--?structure-->', '<!--?volume-->', '<!--?page-guess-->'):
        n = text.count(mark)
        if n:
            problems.append('还有 %d 处 %s 待复核标记没处理' % (n, mark))

    # ---- 中文书里的长段拉丁文：多半是模型在空白页编出来的（参考文献里的外文书目会误报，逐条看）
    warnings = []
    for frag in (latin_runs(body) if mostly_chinese(body) else []):
        warnings.append('长段拉丁文（疑模型编造，外文引文/书目可忽略）：%s' % frag[:80])

    # ---- 页码锚点（只看正文区；脚注定义里的锚点不参与连续、单调检查）
    phys = anchor_checks(body, problems, warnings, R, allow_gaps)
    anchors = phys

    # ---- 图片
    imgs = re.findall(r'!\[[^\]]*\]\(([^)]+)\)', text)
    if imgs:
        R.append('图片引用: %d 个\n' % len(imgs))
        base = a.images_dir or os.path.dirname(os.path.abspath(a.md))
        missing = [p for p in imgs if not p.startswith(('http:', 'https:'))
                   and not os.path.exists(os.path.join(base, p))]
        if missing:
            problems.append('这些图片文件找不到（记得把 images/ 目录一起拷到 md 旁边）: %s'
                            % ', '.join(missing[:5]))

    R.append('\n')
    if warnings:
        R.append('## 提醒 %d 项（不算失败）\n' % len(warnings))
        for w in warnings:
            R.append('  - %s\n' % w)
    if problems:
        R.append('## 待处理 %d 项\n' % len(problems))
        for p in problems:
            R.append('  - %s\n' % p)
    else:
        R.append('## 全部通过\n')
    R.append('\n结构自检只管形式。内容有没有被改动，跑 diff_report.py。\n')

    # 一本书有几个成品文件，各写各的报告，不互相覆盖
    stem = os.path.splitext(os.path.basename(a.md))[0]
    out = process_report(os.path.dirname(os.path.abspath(a.md)), '_verify_%s.txt' % stem)
    if quiet:
        with open(out, 'w', encoding='utf-8') as fh:
            fh.write(''.join(R))
    else:
        write_report(out, ''.join(R))
        print('refs=%d defs=%d tags=%d anchors=%d problems=%d'
              % (len(refs), len(defs), len(tags), len(anchors), len(problems)))
    return {'problems': problems, 'phys': phys, 'pdf': pdf_name}


if __name__ == '__main__':
    main()
