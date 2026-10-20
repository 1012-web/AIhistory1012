# MinerU 产物文件详解

一次解析会吐出六七个文件。它们内容高度重叠但**各有缺失**，选错源头会让后面所有工作都建在坏地基上。

## 速查

| 文件 | 有什么 | 缺什么 | 什么时候用 |
|---|---|---|---|
| `layout.json` / `*_middle.json` | 行级 spans、bbox、置信度、嵌套的图表块、`discarded_blocks`（脚注/页眉/页码）；3.x 的 `para_blocks` 带跨页合并（`cross_page`） | OCR 路线没有逐行框 | **正文与脚注的唯一可靠来源**；读前先查 `schema`，4.0（DocVortex）结构报错停下 |
| `block_list.json` | 块级 text、`is_discarded`、`index`、`mergeConnections` | 行级粒度 | 只在没有 `para_blocks` 的旧产物里取 `mergeConnections` |
| `full.md` | 现成 markdown | **脚注、页眉、页码全没了**；行级信息已丢失 | 只做对照参考，不当底稿 |
| `content_list.json` | 扁平块列表、`text_level` | 脚注拼接有缺陷、无合并信息 | 一般用不上 |
| `content_list_v2.json` | 按页嵌套、保留 footnote/header/page_number 类型 | 无 `index` / 无合并信息、拼接缺陷同上 | 一般用不上 |
| `*_model.json` | 归一化 bbox（0–1）的版式层 | 文字内容为 null | 需要版面几何时 |
| `*_origin.pdf` | 原件 | — | **核对与裁图的最终依据** |
| `images/` | 抽出的图片 | — | 随成品一起拷走 |

## 为什么正文必须从 layout.json / *_middle.json 重建

`block_list.json` 和 `content_list*.json` 里的 `text` 是把行拼好、并压缩过空格的。中文没问题，但**换行处如果两边都是数字或字母，就会粘连**：

```
原件:  ……上海辞书出版社 2016 2017
       2020 2022 年版。
block_list 给出:  ……上海辞书出版社 2016 2017 20202022 年版。   ← 2020 和 2022 粘住了
```

`layout.json` / `*_middle.json` 保留了每一行的 spans，可以按「两侧都是 ASCII 字母数字才补空格」的规则正确拼接。这个规则在 `_common.py:join_lines`。

## discarded_blocks：full.md 丢掉的东西

MinerU 把这些类型标为丢弃，`full.md` 直接不输出：

- `page_footnote` — **脚注全文**。学术文献里最有价值的部分，一篇论文可能有几十条
- `header` — 页眉，常含刊名、卷期、年月，可入 frontmatter
- `page_number` — 印刷页码，用来做页码锚点
- `footer` — 页脚

脚注区里还常混着**期刊元信息**（`收稿日期` `作者简介` `基金项目` `DOI`），它们不是注释，应该移进 frontmatter。

### 一个反复踩的坑

`layout.json` 的 `discarded_blocks` **没有 `text` 字段**，只有 `lines`/`spans`；而 `block_list.json` 的块**有 `text`**。写代码时两边都要能取到：

```python
t = b.get('text') or join_lines(line_texts(b))
```

只写 `b.get('text','')` 会静默拿到空串——页码推断、元信息过滤都会悄悄失效，而且不报错。

## 跨页段落与物理页锚点

3.x 中间结构每页有两份块表：`preproc_blocks`（合并前）和 `para_blocks`（合并后）。一个段落跨页时，MinerU 把下一页开头的续段**并进上一页的末块**，拼进来的 span 带 `cross_page: true`；下一页原来那块变空（`lines: []`、`lines_deleted: true`）。4.0 结构对应的是 `continues_prev`。

`build.py` 读 `para_blocks`，在第一个 `cross_page` 续行前插下一页的锚点，段落不断、页码也对：

```
……坚持通过强化中央集权、官僚<!--pdf-page.2--><!--p.108-->军国主义，更大规模地……
```

续行跨了不止一页（中间整页都是这一段）时，行框纵坐标回跳到页顶，据此切出每一页。MinerU 没合并、但上页末尾无句末标点、下页开头不像新段的，`build.py` 按 `_common.is_break` 只列进构建报告，不自动接：接不接由 AI 对原图定。没被接缝领走的页，锚点在该页第一个块前独占一段；空白页也写，保证全书每页恰好一个。

物理页 = 分卷起始页 + `page_idx`。分卷起始页依次取 `_lunzhu2md_source.json`、目录名里的 `pages-0201-0339`、`*_origin.pdf` 的文件名；产物保留了原 PDF 绝对页序（`page_idx` 不从 0 起，如 V1 按 `page_range` 解析）时直接用 `page_idx + 1`。

更旧的产物（有 `block_list.json`、没有 `para_blocks`）退回 `preproc_blocks` + `mergeConnections`：`{"blocks": ["0-14", "1-2"], "type": "merge"}`，`"0-14"` 是 `page_idx-block_position`（`block_position` 含丢弃块在内，不等于 `index`）。

**印刷页** `<!--p.M-->` 按 `page_number` 块推定：读到的照用；与前后两页偏移都不一致、前后彼此一致的当误读；没读到的按最近一页的偏移推；推出来小于 1 的（封面、扉页）不写；偏移变了记为跳号。推定与跳号都列进构建报告，待核。

**OCR 路线一块只有一「行」**：`ocr_mode=ocr`（扫描件）时 `lines` 只有一项，行框就是整段的框。要逐行坐标的（文字层副本）向 PaddleOCR 云端要行框（`paddle_lines.py`），见 [textlayer.md](textlayer.md)。

## 图表公式是嵌套结构

正文块用 `lines`，但 `image` / `table` 块用 **`blocks`**，子块才是 `image_body` / `image_caption` / `image_footnote`：

```json
{"type": "image", "blocks": [
    {"type": "image_body", "lines": [{"spans": [{"type": "image", "image_path": "xxx.jpg"}]}]},
    {"type": "image_caption", "lines": [...]}
]}
```

套用正文的 `lines` 逻辑会**静默漏掉图注**——不报错，只是图注没了。`_common.py:line_texts` 做了递归处理。

`block_list.json` 里图片路径在 `img_path` 且**带前导斜杠**（`/xxx.jpg`），`layout.json` 里叫 `image_path` 且不带。取的时候统一 `lstrip('/')`。

## 置信度

`layout.json` 的 span 有 `score`。原生文字层 PDF 全是 `1.0`；扫描件走 OCR 才会低于 1。**低于 0.9 的区域应该列成待人工复核清单**随成品交付，否则 OCR 错字会静默混进去。

## 脚注编号的五个陷阱

1. **圈码每页重置**（每页都从 ① 开始），必须**按全局顺序**重新编号
2. **正文里的圈码不都是脚注**。见过作者用 `秦令⑧` 指代前文编号 (8) 的条目——按脚注处理就会整体错位
3. **跨页合并会让逐页计数对不齐**：下一页开头的圈码被并进了上一页的块。逐页数对不上是正常的，**全局合计对得上才说明没问题**
4. **一条注可能领起多个圈码**——`②③⑥⑦⑧《史记·商君列传》。` 是一个块，却对应正文里五个引用。
   中文史学著作里极常见（《中国古代史教程》893 页里有 53 处）。只当一条，其后所有编号整体错位。
   `build.py` 已经拆开，但**拆完必须按圈码值在页内重排**：上例那页的块序是 ①／②③⑥⑦⑧／④／⑤，
   照块序输出就是 1,2,3,6,7,8,4,5，与正文的 ①②③④⑤⑥⑦⑧ 对不上。
5. **MinerU 偶尔整条漏掉一个脚注**，或把它误判成正文块混在页末。漏一条，其后全错一位。
   用 `build.py --add-footnote 页序号:圈码序号:正文` 回补，**补之前必须裁原图确认那条注真的在原刊上**——
   原刊自己漏注也是有的（该书 p.623 就有注号无注文），那种情况要的是 `--skip-marker`，不是补一条。

判据：把每个脚注块开头的**连续圈码全部数上**，总数应等于正文圈码数。差额落在陷阱 2、5 上。
`probe.py` 会同时报逐页和全局，并导出 `_markers.tsv` 供逐条确认。

## 标点丢失

中文标点大面积变成空格，有两种来历：PDF 文字层里那部分字形的 Unicode 映射坏了；或者文字层是好的，但 MinerU 3.4.4 走文字层路线（`ocr_mode=txt`，或 `auto` 判成了 txt）时把中文标点吞掉了（2026-10-20一篇期刊论文实测是后一种：pypdf、pdfium 都抽得出标点）。判断方法：裁一块图出来看，再用 `pdf_preflight.py` 看抽样页的标点比例。

**图里标点清清楚楚、提取出来却是空格 → 用 `ocr_mode=ocr` 重跑这几页（`mineru_v1.py --page-range`）或整份**，拿到的是原文标点，远胜模型推断。中文书导入时默认就走 `ocr`。

有意思的是同一页里**部分标点能正常提取**（会以 `<sub>；</sub>` 这种形式出现），那些正是编码没坏的字符。所以看到 `<sub>` 包着标点不要奇怪，那是好事。

## 图片拷贝（copy_images.py）

- 只复制成品 Markdown 真正引用到的图片；MinerU 多吐出来的页眉、装饰图、重复裁图留在原目录，报告里列为 orphans。
- 认得的引用写法：`![alt](images/x.png "标题")`、`![](<images/含 空格.png>)`、`%20` 之类的 URL 转义、`![[x.png|300]]`、带引号或不带引号的 `<img src=...>`、`[ref]: images/x.png` 这种引用式定义；扩展名覆盖 png/jpg/jpeg/gif/webp/bmp/jp2/svg/tif/tiff/avif。
- 源目录下所有 `images/` 目录一并收集合并（拆卷解析会有好几个），所以多段源只需对每个成品目录跑一次，不必按分卷跑。
- 退出码：3 = 已有同名不同内容的文件（不覆盖），或不同分卷出现同名但内容不同的图片（报告到 `sourceDuplicates`，不猜）；2 = 命令行用法错误。
