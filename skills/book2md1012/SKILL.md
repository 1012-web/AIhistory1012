---
name: book2md1012
description: 把论文、专著、教材及现代排版古籍 PDF 整理成可在 Obsidian 对照阅读、自行修订的 Markdown。默认调用 MinerU 与 PaddleOCR 云端 API 交叉核对，AI 负责参数、结构整理与检查，用户判断未决疑字；现代竖排先按实际服务与样页验证读序、标点和夹注，不一概排除。用户要求安装 AIhistory1012、首次引导、PDF 转 Markdown、导入 Obsidian、重建脚注页码，或整理已有识别结果时使用。同一入口也处理按页修订、抽检与通读，兼容旧版 lunzhu2md、lunzhu2md-fix、lunzhu2md-audit 请求；单纯摘要翻译不使用。
---

# Book2MD1012：PDF 整理、阅读核对与修订

目标：用户把 PDF 交给 AI，即可得到正文、脚注、标题和页码对应完整的可读成品。默认 MinerU + PaddleOCR 双家识别；处理前由用户选择仅核双家冲突或全书逐页逐字核对；参数选择、整理和所选范围内的检查由 AI 完成，用户只判断 AI 核过原页仍未能确定的疑字，并在阅读中发现错漏。导入后修改 Markdown，不改原始识别 JSON。

## 按用户当前任务加载流程

用户只需描述要做的事，不必选择子 skill：

- **安装或使用引导**：读下方首次引导说明。
- **新导入 PDF，或拿已有双家结果继续整理**：执行本文件的导入流程，直到可读成品、交叉核对和必要修复完成；已有结果不重复调用。检测文字层不代替整理。
- **阅读中指出某页错误，或粘贴插件修订请求**：读 [references/revision.md](references/revision.md)。兼容旧版 lunzhu2md、lunzhu2md-fix、lunzhu2md-audit 调用，以及旧插件写出的“请用 lunzhu2md-fix 按原页修订”。按用户授权的问题/页范围修订，保留备份、范围守卫与校注。
- **要求抽检、检查质量或全书通读**：读 [references/audit.md](references/audit.md)。只检查就只出报告；明确要求检查并修复时在授权范围内连续完成，不逐条重新索取许可。

导入中的核对与必要修复属于导入任务，不得借“检查只查不改”或“修订一次一页”停止整理。用户的任务改变时切换操作，不要求重新安装或另开对话。各模式共享下方分工、保真、凭据与偏离流程许可规则。

**首次安装或用户要求使用引导**：先读 [references/onboarding.md](references/onboarding.md) 和 [references/ocr-support.md](references/ocr-support.md)，一次回复给出完整入门说明（两家 API 配置、官方适用范围、效果预览、询问是否已装 Obsidian、插件与 Markdown 阅读修订）。首次介绍时明确说明：**PDF Sync Markdown 是本 skill 作者自行开发的配套 Obsidian 插件**，用于 PDF 与 Markdown 对照阅读、按页联动及修订；作者推荐 Obsidian 搭配该插件。线上站仅预览这个自制插件的对照阅读效果，不是用户文献的在线阅读器。

锚点、frontmatter `pdf`、书文件夹、`book.json`、疑字清单链接的格式只以 [references/anchors.md](references/anchors.md) 为准（仓库 `docs/anchors.md` 是同一份，改时两边同步）；Obsidian 插件 AIhistory PDF Sync 靠它配对、翻页。

命令一律在 PowerShell 里跑，写作 `python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/<脚本>.py`。`${CLAUDE_SKILL_DIR}` 指本 SKILL.md 所在的目录：Claude Code 会自动替换；在 Codex 等别的平台上没被替换时，自己代入本文件所在目录的绝对路径（references 里的命令同理）。脚本 stdout 只打 ASCII 状态行，详细报告写进 `<书>/_数据/过程报告/`，用 Read 工具读。

## 〇、工作方式：脚本给证据，AI 做判断

- **脚本只做确定的机械活**：解析 MinerU、PaddleOCR 的结果，写锚点，校验，渲染页图，写文字层，按你给的裁决改字。遇到异常只报告，不自行改内容。
- **内容上的判断由你来做**：补不补、接不接、用哪份字、怎么改。把脚本的报告当证据、不当结论：对照原页图决定，并在校注里写明理由。拿不准就问用户，不猜。
- **不为少见情况往脚本里加自动修补规则**。碰到新情况，在对话里处理、写进校注，需要时向用户提出改流程。
- **脚本不判断，不等于 AI 只报告**：用户委托整份导入时，AI 应核实并完成本书范围内的断段、漏注、标题、表格、页码及 OCR 错误修复，记校注；不把结构候选全部退给用户审批。只检查、只修某页的委托仍遵守原范围。
- **默认保真**：保留原书字形和标点体例；按目录与正文恢复标题层级。AI 记录本书凡例，不要求用户选择技术参数或例行确认标题映射。原书本身误印照录，证据不足的疑字汇总问用户。
- **每条内容改动都要有证据**：页码锚点 + 原图上的细节。指不出，就是没看原页。

**偏离已定流程必须先取得许可**：已有双家云端结果，却拟改用本地旧文字层直接导出、只取一家结果，或跳过结构整理、交叉核对/必要检查时，先停止受影响的处理与交付，用交互式提问说明：为什么拟变更、哪些页/步骤受影响、替代方案实际使用什么来源，以及哪些内容不再可靠；给出继续按原流程完成（推荐）、明确缩小范围或接受具体降级方案的选择。等待用户明确答复后才能执行替代方案；没有交互工具时在对话里提问并等回复。不把用户未回复、笼统的“继续”、赶时间或一般处理授权当作对这次偏差的许可，也不能交付后才附一句“未核对”。获得许可后记录用户选择及实际完成范围，替代产物不得标成已完成双家整理。原流程中有证据的正常修复仍由 AI 完成，不逐处审批。

全文见 [references/division-of-labor.md](references/division-of-labor.md)。

**怎么读报告**：每一步的报告（`_数据/过程报告/` 下的构建报告、合并报告，`_数据/文字层/文字层报告.md`，`_数据/冲突清单/冲突清单.md`）都分两类：脚本已经做了的机械活（抽查几处即可），和「交 AI 定」的候选（逐条处理）。候选处理完才往下走。

**什么时候看原页图**：先遵守本书已选核对范围。仅核冲突时，下列候选先与第二家结果比较，确认双家分歧后才用 `crop_pdf.py` 查看对应区域与必要上下文；不据此通读整页：跨页断段接不接；没认出注号的注、整条漏的注；跨页表；章题、标题层级；疑误读、跳号的印刷页；文字层里空着的行；两家识别里只有一家读出的整段、结构冲突。文字比对可先筛选字冲突；需要辨认原书字形或文意不能排除误印时，AI 再看原图，仍不确定才列疑字。

**什么时候问用户**：每份 PDF 开始前选择仅核双家冲突或全书逐字核对（同书已明确选择不重复问）；拟扩大已选看图范围，或偏离已定识别来源、结构整理或核对流程时，须说明影响并先取得明确许可；检测到已有文字层时是否沿用（本书已选择的不重复问）；原图仍不能确定的疑字；请求超出已授权的文件、服务、费用或修改范围；用户需要改变原书的字形、标点或误印。技术参数、标题级别和有原图依据的整理修复由 AI 负责。

## 一、确定范围，默认双家核对

**每份 PDF 先选择核对范围**：上传识别或处理已有结果前，按 [references/verification-modes.md](references/verification-modes.md) 交互询问“仅核双家冲突（推荐）／全书逐页逐字核对”，等用户明确选择后再开始。可与是否沿用原文字层合并提问。本书已明确选过则沿用，其他文献的选择不自动沿用。仅核冲突时，AI 对照冲突字和必要上下文、结构冲突对应区域裁决，不通读无冲突页面；不能自行升级到整页/全书通读。这个范围约束适用于下方各步及所有参考文件。

新导入在上传前先按第 1 步检测文字层；有文字就交互询问是否沿用，推荐不沿用并由 MinerU 重新识别重构。本书已有明确选择则复用，不重复询问。

从用户请求及已有文件确定新导入、复用结果或只读检查；只有范围不清才问。已有识别结果先用，不重复上传。来源目录被指定为只读时，先把要使用的识别结果复制到新书的 `_数据/MinerU`、`_数据/PaddleOCR` 再处理：`probe.py` 等脚本会向来源所属的过程报告目录写文件，不能直接对只读来源运行。

两种核对模式都执行双家识别、按页比对、AI 裁决、结构整理与可读性交付；区别是 AI 看图的范围。旧报告的“档 ①/②/③”不作为本次模式选择，不据此让 AI 自行决定通读范围。

首次安装引导两家配置；正式新导入前先查 `paddle_api.py status`，缺令牌按 [references/get-token.md](references/get-token.md) 引导。未配、失效、配额用尽或调用失败，说明影响并帮助恢复，**不自行降为单家完成**。已有结果、只读检查不以两家凭据为前置条件。用户明确选择单家时仍可按其要求执行，报告如实记录覆盖。

现代竖排点校本不一概排除。AI 先说明并取得代表页适用性验证许可，再检查正文列序、标点、双行夹注和注区；依据 [references/ocr-support.md](references/ocr-support.md) 区分官方能力与当前接口实测，再决定识别路线。样页识别与核验也由 AI 完成。

## 二、导入流程

下图是 MinerU 主来源的常规路线。现代竖排先核代表页；若样页有实质缺漏、列序或夹注不可用，按 [references/kandian.md](references/kandian.md) 改用看典逐页来源，再与 PaddleOCR 核对。该分支由 AI 据页图整理底稿，不运行 MinerU 的 `probe/build` 或依赖其结构的文字层制作；继续完成标题、脚注、锚点、拆文件、校注与可读性检查。

```mermaid
flowchart TD
    Q[先交互选择：仅核冲突 / 全书逐字] --> A[0 书文件夹]
    A --> B[1 检测文字层：有文字先询问是否沿用]
    B --> C[2 双家解析：MinerU + PaddleOCR]
    C --> D[3 骨架：probe 审计 → build 写锚点 → 分卷合并]
    D --> E[4 目录与标题、缩排标记、frontmatter]
    E --> F[5 文字层副本（扫描件或文字层坏）]
    F --> G[6 拆文件、book.json、拷图、verify]
    G --> I[7 双家冲突清单 → 按所选范围核图裁决 → 校注、疑字清单]
    I --> J[8 改动报告与可读成品交付]
```

### 0. 书文件夹

```text
<书>/
├─ <原件>.pdf                 原件，只读
├─ <原件>.文字层.pdf          需要时
├─ 00-卷首.md、01-正文.md …   成品
├─ <书名>.md                  索引
├─ <书名>.AI校注.md           校注
├─ <书名>.疑字清单.md         有未决疑字时
└─ _数据/  book.json  MinerU/  PaddleOCR/（原始结果，只读）  冲突清单/  过程报告/
```

输出位置照用户说的；没说就用 PDF 所在文件夹，或在它旁边建 `<书名>/` 把 PDF 复制进去（原件不移动、不改）。已有的书沿用原来的目录名。

### 1. 预检

```powershell
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/pdf_preflight.py <书>/<原件>.pdf --output <书>/_数据/过程报告/_preflight.json
```

预检主要检查能否提取文字，**不评分、不提前判断文字层质量**。`encodingWarnings` 仅提示明确观察到的替代字符 `�` 或空字符，不据此给出准确率；没有警告也不证明文字层可靠。读 `hasExtractableTextInSample` 与 `sampleStatus`：

- 检测到文字（含只有部分抽样页有文字）：先用当前平台的交互式提问工具让用户选择；没有这类工具时直接问并等待答复。本书已明确选择的不重复问：
  - **不沿用原文字层，由 MinerU 重新识别并重构（推荐）** → `--ocr-mode ocr`。
  - **沿用原文字层，由 MinerU 解析重构** → `--ocr-mode txt`。
- 抽样未检测到文字：说明“抽样页未检测到可提取文字”，直接走 `ocr`；不把抽样说成全书检查。
- 提取报错：说明检测未完成，不把报错当作没有文字。

提问时说明：这里的“保留/不保留”指整理时是否沿用旧文字层，**原 PDF 始终只读，不删除其中的文字**。两种方式都要经 MinerU 结构重建和 PaddleOCR 交叉核对；不得把本地 `extract_text/get_text` 的输出直接当成品。选择记录在本书过程报告中，再由 AI 设置参数，不要求用户理解 `ocr/txt`。不沿用且需要可检索副本时，在副本重建文字层，不改原件。

### 2. 取得双家识别结果

先备齐两家结果，再开始需比较来源的结构整理。已有结果直接复用；新识别除下方 MinerU 命令外，还运行 `python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/paddle_api.py submit <书>/<原件>.pdf -o <书>/_数据/PaddleOCR`。第 7 步复用这里的结果，不再次提交。仅核冲突模式先比较双家原始文字与结构字段，再按冲突区域看图，不在第二家尚未取得时通读原页。

MinerU 解析：

```powershell
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/mineru_v1.py submit <书>/<原件>.pdf -o <书>/_数据/MinerU --ocr-mode ocr
```

V1 为主（sha256 秒传、`ocr_mode`、`page_range`、`/v1/usage` 官方用量、`Idempotency-Key`），失败或产物结构不对自动退回 v4；要 `ocr` 却拿到文字层解析（`_ocr_enable: false`，实测同一文件第二次交 V1 时 `ocr_mode` 不起作用）也退回 v4。超过 200 页自动拆卷。报告里写明每卷用的是哪条接口。令牌用 `mineru_api.py configure` 本机存一次，绝不打印、不写进任何文件。细节见 [mineru-api.md](references/mineru-api.md)。

所有脚本读中间结构前先查 `schema`。MinerU 云端若改交 4.0（DocVortex）结构：**不停下**，`mineru_v1.py` 打出 `NOTICE_UPDATE_SKILL`、报告里 `update_skill_suggested: true`，这几卷自动改走 v4 接口继续导入；在交付报告开头提醒用户更新 skill（Claude Code 里 skill 随 aihistory1012 插件更新：`claude plugin marketplace update` 后 `claude plugin update`；别的平台重新复制 skill 文件夹）。只有 v4 也失败、或 v4 也交 4.0 结构（`build.py` 报 DocVortex 错误）时才停下，告诉用户当前版本读不了，要等 skill 更新。

### 3. 骨架

每卷先审计，再构建；拆卷的书再合并：

```powershell
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/probe.py <书>/_数据/MinerU/<卷>.mineru
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/build.py <书>/_数据/MinerU/<卷>.mineru -o <书>/_数据/过程报告/_skeleton1.md [--skip-marker 1,2] [--add-footnote 页序号:圈码序号:正文]
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/merge_skeletons.py <骨架1.md> <骨架2.md> -o <书>/_数据/过程报告/_skeleton.md
```

- `probe.py` 报正文圈码与脚注条数是否对齐。对不上先查清：非脚注的圈码（作者用 ⑧ 指前文编号 (8)、版权页罗马数字被认成 ①）用 `--skip-marker 全局序号`（序号看 `_markers.tsv`）；MinerU 整条漏掉的注，裁原图确认原刊确有，才用 `--add-footnote` 补。原刊本就有注号无注文的，照录、写校注。
- `build.py` 只做机械的：写每页一个 `<!--pdf-page.N-->`（分卷自动加起始页偏移），段落跨页时按 MinerU 自己的 `cross_page` 插在接缝处；后面紧跟按 MinerU 读到的页码推定的 `<!--p.M-->`；脚注定义写成 `[^n]: <!--pdf-page.N--><!--p.M--> 注文`；领起几个圈码的注（「②③⑥」）按圈码拆成几条、页内按圈码排序。脚注只还原标签，不改半全角。
- 构建报告里「交 AI 定」的候选由 AI 与第二家结果比较，按已选模式处理；仅核冲突时只核双家分歧区域，不能将所有单家候选转成整页看图任务。脚本都没动：
  - **疑似被换页切断、MinerU 没合并的段落**：是一段就接上，下一页锚点留在接缝处；不是就不动；别给上页末尾补句号。分卷接缝（`_merge_report.txt`）同样处理。
  - **开头没认出注号的脚注块**：注号漏识、上页注文续接，还是页下别的文字。
  - **期刊元信息**（骨架开头的 `<!--?meta-->`）：移进 frontmatter。
  - **标题层级**：报告只给按编号形态的建议，骨架保留 MinerU 的级别，层级按第 4 步定。
  - **疑似跨页表**：这一页的表格块是空的、续表被并进了上一页的表；数据定不了哪几行属于这一页，看原图把这一页的锚点挪进表里续表开始处，或照原样留着并写进校注。
  - **印刷页疑误读、跳号**：读到的数照写着，看原页改。
- 来源字段说明见 [mineru-outputs.md](references/mineru-outputs.md)（为什么必须从 `layout.json` 重建、脚注五个陷阱、标点丢失）。

### 4. 目录与标题、缩排标记、frontmatter

- 多级标题按 [toc-headings.md](references/toc-headings.md)：AI 先用双家目录/正文结构与坐标整理标题树，再改 `#` 层级；仅核冲突模式只在标题分歧或缺题冲突区域核原图，不逐个通读章首页。补回的标题放在该页锚点之后另起一段，锚点不写进标题行。
- `<!--?quote-->`、`<!--?center-->` 逐条对文字判：确是引文改成 `>`；题名、作者按本来身份；都不是删标记。
- frontmatter 从 `_probe.txt` 的页眉与骨架开头的 `<!--?meta-->`（`收稿日期`、`基金项目` 等）补，补完删掉这些标记；`tags`、`aliases`、`cssclasses` 键名必须英文。格式见 [templates.md](references/templates.md)。
- 空白页上模型编出来的英文（`verify.py` 报「长段拉丁文」）核原图后删，写进校注。
- 正文标点照原书；原书有标点而骨架缺的，按原图还原；脚注只清标签、不按文意补标点。
- 中文语境半角标点默认保留原样，AI 记进 `book.json` 的 `conventions.punctWidth`。仅用户明确要求统一全角时才跑 `punct_width.py`（改前备份、整批报告），没定就照原样。脚注同样按凡例，不在构建时自动改。

  ```powershell
  python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/punct_width.py "<书>/0*.md" [--dry-run]
  ```

### 5. 文字层副本（扫描件，或文字层坏的 PDF）

```powershell
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/paddle_lines.py submit <书>/<原件>.pdf -o <书>/_数据/PaddleOCR行框
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/pdf_textlayer.py assign --pdf <书>/<原件>.pdf --mineru <卷1>.mineru [--mineru <卷2>.mineru] --lines <书>/_数据/PaddleOCR行框/lines.json
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/pdf_textlayer.py fill --assignment <书>/_数据/文字层/assignment.json --page 85 --line 3 --text "…"
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/pdf_textlayer.py write --pdf <书>/<原件>.pdf --assignment <书>/_数据/文字层/assignment.json [--visible-text raster]
```

字用 MinerU 的，行框找 PaddleOCR 云端（PP-OCRv6）要；写成隐形文字存 `<原件>.文字层.pdf`，原件不动。

1. `paddle_lines.py` 找行（页面上传百度；默认流程也会将原件交给 PaddleOCR；行框与全文识别是不同调用，费用和配额分别记录；未刊稿等先问用户）。
2. `assign` 按 MinerU 的跨页标记把跨页段拆回各页，再把字对到行上，写 `_数据/文字层/assignment.json` 与 `文字层报告.md`。
3. 读报告，逐处定：**空着的行**（表格为主，也可能是 MinerU 漏行）、**放不进任何行的字**、**疑似跨页表**、**OCR 认的字与要写的字差得太远的行**（多半是空白页上模型编出的字，脚本没写进文字层）。报告附 OCR 自己认的字，只作参考，**不要直接拿来补**——实测专著第 84–85 页的表，四家识别都把同一个生僻字认成形近的常用字，OCR 还把「痾」认成「病」、「金沴木」认成「金诊木」。看原页后三选一：正文本身错了就先改正文（记校注），再按改好的字 `fill`；正文没有这几行就用核过的字 `fill`；拿不准或不值得的留空（写进交付报告）。
4. `write` 按分配表写副本。扫描页直接替换旧隐形层；字本来看得见的页默认原样保留，文字层坏了（复制出乱码、丢标点）才用 `--visible-text raster` 换成图再写字。看 `_textlayer_report.json` 的 `pagesBelow99`、`fontMissing`。

细节、行框文件格式、云端用不了时怎么办，见 [textlayer.md](references/textlayer.md)。要在拆文件之前做，`split_book.py` 才会把 frontmatter `pdf` 指向副本。

### 6. 拆文件、book.json、拷图、自检

```powershell
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/split_book.py <书>/_数据/过程报告/_skeleton.md -o <书> --meta book=<书名> --meta author=<作者> [--level 2] [--pdf <原件>.文字层.pdf]
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/copy_images.py <书>/_数据/MinerU <书>
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/verify.py --book <书>
```

- 图书：正文各章合成一份 `NN-正文.md`，卷首、书末各篇另存；论文 `--level 2`，整篇一份。用户明说要按章拆才 `--split`。看 `_split_report.txt` 确认序论、结语等没被分错。
- 每个文件 frontmatter 写 `pdf: "[[…]]"`（有文字层副本时指副本）；写 `_数据/book.json`（PDF、文件列表与各自的物理页范围、页码偏移）。
- `verify.py --book` 必须全过：每个文件有 `pdf`、物理页锚点连续单调、全书覆盖第 1 页到最后一页、每页恰好一个；脚注引用与定义一一对应；没有残留标签和待复核标记。

### 7. 双家比对与按所选范围核对（两种模式都执行）

```powershell
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/crosscheck.py --book <书> --vl <书>/_数据/PaddleOCR
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/doubts.py --book <书> --decisions <书>/_数据/冲突清单/decisions.json
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/verify.py --book <书>
```

`crosscheck.py` 按物理页锚点把 PaddleOCR 逐页结果与正文对齐，出冲突清单：1–4 字的字冲突；注号个数、脚注条数、标题、表格、整段有无等结构冲突。裁决规则、`decisions.json` 格式见 [crosscheck.md](references/crosscheck.md)，要点：

- **仅核双家冲突**：AI 比较冲突清单，查看不同字及必要上下文；整段、注号、标题、脚注、表格等结构冲突核对应区域。不通读无冲突页面，也不顺带逐字核整张冲突页。
- **全书逐字核对**：除上述工作，还逐页逐字对照原图，记录已核与未核页。
- AI 对照原图裁决，仍不能确定的一律 `pending` 汇总问用户；不凭文意或典籍常见写法代替原图。
- `doubts.py` 只改定位得到的字冲突，每处记进《<书名>.AI校注.md》；未决的写《<书名>.疑字清单.md》，条目带 `obsidian://aihistory-pdf-sync?...` 链接，点了在 Obsidian 里跳到原页、选中现字。

### 8. 改动报告与交付

```powershell
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/diff_report.py <书>/_数据/MinerU/<卷1>.mineru,<卷2>.mineru "<书>/0*.md"
```

剔除标点、空格、Markdown 语法后仍有的差异就是实质改动，逐条对得上校注才交付。交付报告见第五节。

## 三、保真规则

1. 以本次所据原件为准。OCR 错读、漏读按原图纠正；原刊自身误印、疑脱字照录并列疑问，未经用户许可不改成「应有」的文字，不用别的版本补正文。
2. 原书有标点照录，无标点不补；不按语言模型的文意补标点。
3. 原有夹注、附注、缺字框和难以转录的内容不丢弃。
4. 字形方针先查本书记录（校注 frontmatter 的 `异体字方针`），本次需要新决策时才问。替换都要有原图依据并记校注。比对时的字形折叠不等于改正文。
5. 内容层修改逐处记录原字、改字、位置和依据；校注与正文分开，改动报告由脚本生成。
6. 两家读法不一致只是线索，一致也不证明无误。未经整页或整书核验，不报全书准确率；只有一家读者时，报告注明没有第二读者覆盖。
7. 模型输出、脚本推断、已核原图的事实三者分开标明。

## 四、页码口径

| 标记 | 含义 |
|---|---|
| `<!--pdf-page.N-->` | PDF 物理页（从 1 起），每页恰好一个，正文里连续、单调。**主锚点** |
| `<!--p.M-->` | 印刷页，紧跟在物理页锚点后；按 MinerU 读到的页码推定，待核项列在构建报告里 |

- 两种口径不混称。说「第 N 页」时写明是 PDF 第 N 页还是原书 p.M。
- 目录上的页码是印刷页，不是物理页。缺页、页码跳变要核原件，不自动补成连续；推不出印刷页的页（封面、扉页）只有物理页锚点。
- 从原 PDF 抽出几页测试或重跑时，锚点仍写原 PDF 的页号（`mineru_v1.py --page-range` 与 `build.py` 已按此处理）。
- 一页跨两个文件时，后一个文件开头有一个「续页锚点」（与前一文件最后的锚点相同，`split_book.py` 自动补）；这是唯一允许的重复。
- 页首就是章标题时，物理页锚点在标题前独占一行，印刷页锚点可以留在标题后。
- 扫描件本身页序乱的照实写原 PDF 页号，`verify.py` 只提示倒序；旧数据、外来笔记缺页时用 `verify.py --allow-gaps`。新导入的书不加，缺页就是问题。

## 五、服务、凭据与交付

**服务与凭据**：PDF 会上传到 MinerU 和 PaddleOCR／百度服务器；只向本次任务已授权的服务上传，用缓存完成的不上传，未刊稿、有保密顾虑的材料先问。密钥不贴进聊天、不写进仓库、不进命令行参数；缺凭据时由 AI 打开 `configure_tokens.py` 本机窗口，让用户直接粘贴保存；缺图形支持才用原客户端 `configure`。第二家的令牌状态用 `paddle_api.py status` 查（开工时就查，见第一节），配法、配额、失败处理见 [references/paddleocr.md](references/paddleocr.md)；**带用户拿令牌的话术见 [references/get-token.md](references/get-token.md)**（首次引导两家都配置，本机不用安装两家的模型）。

**不擅自删除**下载文件、原始结果、备份、过程报告或用户资料。

**交付分两份写，给不同的人**：

1. `_数据/过程报告/_交付报告.md`——过程与核验数据，留档用。清单见下。
2. **对话里的交付**——写给拿到书的人，不是写给运维。三步，顺序不能换：

   - **拿到什么**：几页、哪些篇、注在不在、和原件对不对得上，一句能复述；
   - **能不能信**：改了几处、依据是什么（举两三个最能说明问题的例子，如「效顰」「齗齗」）；哪几处拿不准、你该怎么核；
   - **哪里要自己核**：没做到的明说——没看页图、没有第二读者、哪些页只是抽样。

   术语只在需要用户判断处出现，出现就当场换成日常说法（锚点→「每页的隐形书签」；冲突清单→「两家识别读得不一样的地方」）。见 [delivery.md](references/delivery.md)。

**交付前检查 Markdown 成品可读性，不扩大看图范围。** `verify.py` 全绿只证明锚点连续、脚注对得上，不证明成品可读：段落被并、标题归错、表格串行都不会让它报警。检查成品的标题、段落、脚注与引用呈现；仅核冲突模式不因此抽看无冲突原页。全书模式按逐页核验记录交付。

`_交付报告.md` 的内容：

- 处理的页与未处理的页；用了哪条接口、`ocr_mode`、有没有退回 v4；用户所选核对方式、实际看图区域或逐字覆盖、未核范围；
- 物理页锚点覆盖（`verify.py --book` 结果）、印刷页待核项；
- 目录与标题的对应情况；脚注条数与引用对齐情况；图表；
- 文字层副本（有无、哪些页换成了图、最低回读匹配）；
- 两家识别：第二家令牌状态（`status` 结果）、比对页数、无第二读者覆盖的页、各类冲突条数、已改几处（依据读文字还是看图）、未决几处（疑字清单路径）；
- 改动及依据、未判疑问和缺口。

只做了抽样的写明是抽样，不说成全书校订完成；接口调用成功不等于校订完成。**没拿到的能力（没有图像输入、第二家令牌没配）写进「哪里要自己核」，不能略过。**

用户阅读与修订的具体引导见 [references/onboarding.md](references/onboarding.md)：可自行在 Obsidian 修改 Markdown；需要时通过工具条「⋯ → 配对：…（点击改绑）」重新关联 PDF。改字不会自动改写 PDF 文字层，也不必每改一个字重新绑定。
