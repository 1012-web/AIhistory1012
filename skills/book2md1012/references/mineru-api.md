# MinerU 云端接口

MinerU 是导入的骨架：区域框、分类、读序、脚注、图表都从它来。产物文件怎么读见 [mineru-outputs.md](mineru-outputs.md)。

- **V1 接口为主**：`mineru_v1.py`。官方说明在 MinerU 仓库 `docs/next/api/`（parse-jobs、uploads-files、usage-limits），mineru.net 的网页文档只写 v4。
- **v4 接口兜底**：`mineru_api.py`。V1 失败或产物结构不对时自动退回，不用手动切。

## 令牌

两条接口用同一个令牌，存一次。首次引导优先由 AI 打开 `configure_tokens.py`，让用户在本机窗口粘贴、保存与验证（见 [get-token.md](get-token.md)）。原命令行入口保留：

```powershell
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/mineru_api.py configure
```

- 本机隐藏输入；Windows 存 `%APPDATA%\mineru-skill\config.json`，用当前用户的 DPAPI 加密；Linux/macOS 存 `${XDG_CONFIG_HOME:-~/.config}/mineru-skill/config.json`，权限 `0600`。
- 环境变量 `MINERU_API_TOKEN` 优先于配置文件。
- 令牌不进聊天、不进命令行参数、不进仓库；脚本的日志和报告里出现令牌一律换成 `<TOKEN>`，预签名地址的签名部分去掉。

## 先定 `ocr_mode`

导入前一定先跑本地预检，再**显式**传 `--ocr-mode`，不交 `auto` 了事：

```powershell
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/pdf_preflight.py <书>/<原件>.pdf --output <书>/_数据/过程报告/_preflight.json
```

本地预检只检测是否有可提取文字，不判断“干净”“可疑”或“质量好坏”。`encodingWarnings` 可附带替代字符或空字符的具体提示；没有警告不能作为文字层可靠的依据。检测到文字就交互提问是否沿用，推荐不沿用、由 MinerU 重新识别重构。用户选择后显式传 `ocr` 或 `txt`；已选择过的不再问。抽样未检出文字直接 `ocr`，提取失败不能当成无文字。原 PDF 不改。

两条路线均用 MinerU 返回的版面结构构建 Markdown，再与 PaddleOCR 核对，不直接导出本地旧文字层交付。预检报告旧版可能包含质量指标或自动推荐；复用旧报告时只读页号、是否提取到文字，不沿用旧质量结论。

## V1 流程（`mineru_v1.py`）

```powershell
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/mineru_v1.py usage
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/mineru_v1.py submit <书>/<原件>.pdf -o <书>/_数据/MinerU --ocr-mode ocr
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/mineru_v1.py submit <书>/<原件>.pdf -o <书>/_数据/MinerU --ocr-mode ocr --page-range 37
```

1. 超过 200 页按 200 页拆卷（`pypdf` 复制页面对象，不重新编码图像）；分卷缓存在 `<输出目录>/_upload_cache/`。`/v1/usage` 实测 `max_pages_per_file` 仍是 200。
2. `POST /v1/uploads` 带文件的 sha256：同一账户已有同一文件时直接返回 `completed`（秒传），不再传字节；否则按返回的 `upload_url`、`upload_headers` `PUT`，再 `POST /v1/uploads/{id}/complete`。
3. `POST /v1/parse/jobs`：`ocr_mode`、`output_formats: ["zip"]`、`tier: "standard"`；`--page-range` 时文件项带 `page_range`（原件不超过 200 页时整份交、只解析这几页，多半秒传；超过时本地切出这几页再交）。
4. 轮询 `GET /v1/parse/jobs/{id}`：2 秒起、指数退避、最长 30 秒；`completed`、`partial`、`failed`、`canceled` 是终态。
5. `GET /v1/files/{zip 的 file_id}/content` 返回 302 到 CDN，跟随时不带令牌。解压到 `<输出目录>/<原件>[.pages-0001-0200].mineru/`，写 `_lunzhu2md_source.json`（原件、起止物理页、用的哪条接口、`ocr_mode`），`build.py` 据此算物理页。
6. 先查中间结构的 `schema`（见下）。

所有 `POST` 都带 `Idempotency-Key`（按文件哈希与请求参数算）：中断后重跑不会重复建任务。

报告：`<输出目录>/_mineru_v1_report_*.json`，含每卷用的接口、任务号、是否秒传、`page_range`、结构版本、退回原因，以及 `/v1/usage` 前后的官方用量。

## 什么时候退回 v4

- V1 网络或 HTTP 出错、任务不是 `completed`、超时；
- 产物里没有 `layout.json` / `*_middle.json`，或中间结构是 MinerU 4.0（DocVortex，`schema: docvortex.middle`，2.0 版，没有 `pdf_info`、`discarded_blocks`）；
- 要的是 `ocr`，产物却是 `_ocr_enable: false`（文字层解析）。

**2026-10-20 实测（12 页论文，V1 两次）**：

| 运行 | `_ocr_enable` | 汉字 | 中文标点 | 标点/汉字 | `<sub>`/`<sup>` 标签 |
|---|---|---|---|---|---|
| v4 `is_ocr=true`（10-16） | true | 11495 | 1263 | 0.110 | 0 |
| V1 `ocr_mode=auto` | false | 11495 | 252 | 0.022 | 706 |
| V1 `ocr_mode=ocr`（新任务号，同一文件秒传） | false | 11495 | 252 | 0.022 | 706 |

两次 V1 的 `layout.json` 逐字节相同：`ocr_mode=ocr` 没起作用，疑为服务端按文件缓存了第一次的解析。所以同一文件已用别的 `ocr_mode` 交过 V1 时，V1 的结果不可信，客户端会检出并退回 v4。原因未与官方核实。

退回时 `ocr_mode` 换成 v4 的 `is_ocr`：`ocr` → `true`，`txt` → `false`，`auto` → 本地抽样判断。`--no-fallback` 关掉退回。v4 当前仍交 3.4.4 结构。

V1 交回 4.0 结构时不停下：客户端打 `NOTICE_UPDATE_SKILL`、报告记 `update_skill_suggested: true`，自动改走 v4 继续，交付时提醒用户更新 skill。

**读取层的规矩**：`_common.check_schema` 在所有脚本读中间结构前检查；遇到 4.0 结构直接报错停下（这时 v4 也交 4.0 了，或用户给的是 4.0 产物），不尝试照 3.x 读（会静默丢脚注）。以后用 DocVortex（MIT）的数据模型写 4.0 适配器。

## v4 接口（`mineru_api.py`）

V1 不可用、或要用 v4 独有参数时直接用：

```powershell
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/mineru_api.py submit <书>/<原件>.pdf -o <书>/_数据/MinerU --ocr on
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/mineru_api.py resume <batch_id>
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/mineru_api.py usage
```

- `POST /api/v4/file-urls/batch` 取预签名地址 → `PUT` 文件（不设 `Content-Type`）→ 每 5 秒轮询 `GET /api/v4/extract-results/batch/{batch_id}` → 下载 `full_zip_url`。
- 一次最多 50 个上传地址，客户端自动分批；默认 `model_version=vlm`、`language=ch`、公式与表格识别开。
- v4 没有用量查询端点：`usage` 只是本机记下的估算（每日 1000 页最高优先级，超出的排普通队列，不是拒绝），报告里标为估算，不冒充后台余额。
- 任务创建后在用户配置目录的 `jobs/` 存恢复信息。

## 交付报告里写

- 原件与实际上传的分卷，每卷页数、`ocr_mode`、用的哪条接口（退回 v4 的写原因）、任务号；
- 解压目录与结构版本（`_version_name`、`_ocr_enable`）；
- V1 的官方用量（`/v1/usage`），或 v4 的本机估算；
- 只交了这一份文件，没交别的。
