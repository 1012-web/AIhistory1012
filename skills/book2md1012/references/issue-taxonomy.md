# 问题分类

每条问题用两个字段定类：**块类型** `block_type`（出错的是页面上哪种东西，照 OmniDocBench 的块类型）和 **错误种类** `error`（错成什么样）。再加 **严重度** `severity`。

## 块类型 `block_type`（OmniDocBench 块级类型，原名照录）

| 名 | 中文 | 本项目里常见的样子 |
|---|---|---|
| `title` | 标题 | 章节标题、论文题目 |
| `text_block` | 正文段落 | 普通段落、独立引文段 |
| `figure` | 图 | `![](…)` 图片 |
| `figure_caption` | 图题 | 「图 1 ……」 |
| `figure_footnote` | 图注 | 图下的说明、出处 |
| `table` | 表格 | HTML 或 Markdown 表 |
| `table_caption` | 表题 | 「表 2 ……」 |
| `table_footnote` | 表注 | 表下的「资料来源」「说明」 |
| `equation_isolated` | 独立公式 | 少见 |
| `equation_caption` | 公式编号 | 少见 |
| `header` | 页眉 | 刊名、书名、章名、作者名 |
| `footer` | 页脚 | 页脚刊名、版权行 |
| `page_number` | 页码 | 孤立的数字行 |
| `page_footnote` | 页下注 | `[^n]` 脚注定义 |
| `abandon` | 应丢弃的内容 | 知网水印、下载信息、扫描污点 |
| `code_txt` | 代码块 | 少见 |
| `code_txt_caption` | 代码块说明 | 少见 |
| `reference` | 参考文献 | 文末参考文献表 |

行内（span 级）类型，问题出在一段之内的某个片段时用：

| 名 | 中文 | 例 |
|---|---|---|
| `text_span` | 行内文字 | 段内错字、漏字 |
| `equation_inline` | 行内公式 | `$…$` 残留 |
| `footnote_mark` | 注码、上下标 | `[^n]` 位置错，「10¹」并成「101」 |

## 错误种类 `error`

| 名 | 中文 | 说明 |
|---|---|---|
| `missing` | 漏 | 原页有、正文没有：整段、半段、整注、表格、标题、表题 |
| `extra` | 多 | 原页没有、正文有：页眉页脚页码混入、水印、重复识别的段 |
| `wrong_text` | 错字 | OCR 误识的字、数字、标点（原书误印不算） |
| `order` | 次序错 | 段落次序颠倒、注文与注码对不上号 |
| `merge_split` | 并段拆段 | 两段并成一段，或一段拆成两段；正文与注文互串 |
| `structure` | 结构层级 | 标题级别错、注文误成正文、引文段误成正文、表格行列错 |
| `anchor` | 锚点 | `<!--pdf-page.N-->` 位置错、缺、重复；脚注挂错页 |
| `residual` | 残留标记 | HTML 标签、LaTeX、模型特殊记号、版面块类型名 |
| `other` | 其他 | 以上都不是，在说明里写清楚 |

## 严重度 `severity`

| 名 | 中文 | 判定 |
|---|---|---|
| `high` | 高 | 内容丢了或多了：整段、整注、表格、标题、半页；水印、页眉成段混入 |
| `medium` | 中 | 结构错：串段、并段、层级、注挂错页、锚点错位；影响引用的数字错 |
| `low` | 低 | 个别字、标点、全半角；不影响理解的残留标记 |
| `info` | 提示 | 不确定是不是错，或原书误印，请用户看 |

## 初筛项与分类的对应

`audit_scan.py` 的 `check` 名与上表的大致对应，便于把初筛结果并入同一份报告：

| check | 中文 | block_type | error |
|---|---|---|---|
| `anchor_missing` / `anchor_duplicate` / `anchor_order` / `anchor_seam` / `anchor_format` | 锚点缺页、重复、倒序、错位、格式 | `text_block` | `anchor` |
| `anchor_uncovered` | PDF 页未覆盖 | `text_block` | `missing` |
| `printed_page` | 印刷页码 | `page_number` | `anchor` |
| `page_chars` | 每页字数 | `text_block` | `missing` / `extra` |
| `footnote_ref_no_def` / `footnote_gap` | 注码无注文、注号跳号 | `page_footnote` | `missing` |
| `footnote_def_no_ref` | 注文无注码 | `footnote_mark` | `missing` |
| `footnote_duplicate` | 注文重复定义 | `page_footnote` | `extra` |
| `footnote_order` / `footnote_page` / `footnote_no_anchor` | 注码次序、注文挂页、注文缺页锚点 | `page_footnote` | `order` / `anchor` |
| `heading_level` / `heading_number` | 标题层级、标题跳号 | `title` | `structure` / `missing` |
| `residual_tag` | 残留标签 | `abandon` 或 `equation_inline` | `residual` |
| `latin_run` | 长段拉丁文 | `text_block` | `wrong_text`（或英文摘要，`info`） |
| `watermark` | 知网等水印 | `abandon` | `extra` |
| `running_head` | 页眉页脚混入 | `header` / `footer` / `page_number` | `extra` |
| `superscript_merge` | 上标并入 | `footnote_mark` | `wrong_text` |
| `bracket` | 括号引号不成对 | `text_span` | `wrong_text` |
| `repeat` | 重复串 | `text_block` | `extra` |
