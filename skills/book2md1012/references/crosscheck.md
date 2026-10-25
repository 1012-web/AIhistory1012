# 两家识别：PaddleOCR-VL 交叉核对与 AI 裁决

两种核对模式都执行双家比对。先按 [verification-modes.md](verification-modes.md) 取得本书的选择；仅核冲突时只看分歧及必要上下文，全书模式另逐页逐字核验。MinerU（或竖排分支的看典）提供主体底稿，PaddleOCR-VL 是第二识别者，不能整份覆盖正文。

## 1. 调 PaddleOCR-VL

```powershell
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/paddle_api.py configure
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/paddle_api.py submit <书>/<原件>.pdf -o <书>/_数据/PaddleOCR
```

- 每页存 `pNNNN.json`（物理页，1 起；字段 `page`、`width`、`height`、`parsing_res_list`），原始返回在 `_raw/`，汇总 `_run.json`。已有的页跳过，中断后重跑即续；已有缓存直接用。
- PDF 会上传到百度服务器，要有本次任务的授权。令牌同样用 `configure` 本机隐藏输入、DPAPI 加密，不进命令行参数。
- 超过 100 页自动分块；免费额度每用户每模型每日 20000 页（2026-10-16 核对），以服务实际限制为准。
- 已知毛病：会把原书异体写成通行字，漏后引号、书名号间的顿号，在空白页或透印处编字；脚注上标写成 `$ ^{①} $`。

## 2. 对齐出冲突清单

双家结果在导入第 2 步备齐。结构整理时先比较两家原始文字、结构字段与坐标，仅核冲突模式按分歧区域核图。下列脚本在标题定稿、`split_book.py` 拆好文件之后跑，生成最终文字与结构冲突清单（它按当时的正文记位置）：

```powershell
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/crosscheck.py --book <书> --vl <书>/_数据/PaddleOCR
```

- 按物理页锚点把 Markdown 切成页：正文流（锚点到下一锚点）、注文流（锚在该页的脚注定义）；VL 那页的正文类块与 `footnote` 块各成一流。
- 比之前两边都折叠：NFKC 统一全半角、去空白与 Markdown 语法、去锚点；注号（`[^n]`、`①`、`$^{1}$`）另计个数，不比字。
- 产出 `<书>/_数据/冲突清单/conflicts.json`（给 `doubts.py`）与 `冲突清单.md`（给 AI 读）。每条有编号、PDF 页、流、类别、MinerU 与 VL 两边的前后文。

| 类别 | 含义 | 仅核冲突模式怎么裁 |
|---|---|---|
| 字冲突 `char` | 对齐后 1–4 字的替换、一边多、一边少（标点也算） | 看冲突字与必要上下文 |
| 正文注号 `refs` | 本页注号个数不同 | 核对应注号区域 |
| 整段有无 `passage` | 一边多出 20 字以上，只有一家读出 | **核对应原图区域** |
| 成片差异 `span` | 5 字以上、不到整段 | **核对应原图区域** |
| 脚注条数 `notes`、标题个数 `heading`、表格个数 `table` | 结构不一致 | **核对应原图区域** |

两家一致不证明无误；VL 缺页（`pagesWithoutSecondReader`）在交付报告里写成「无第二读者覆盖」。

## 3. AI 裁决

AI 先自动比较双家结果，再按本书已选范围看图：仅核冲突时查看分歧字及必要上下文、结构冲突区域，不把整张冲突页重新逐字读一遍，不看无冲突页面。全书模式还需逐页逐字核验一致部分。仍拿不准的才交给用户，不要求用户先筛选全部冲突。

裁决原则：

1. 以原件为准，不以文意为准。两家都通、看不出谁对的，不猜，记 `pending`。
2. 文意、典籍原文和专名仅供定位与理解；字词与标点的裁决对照原图，理由写清看到的字形及区域，不能只凭成句选字。
3. 两家都不对（「鸜鹆」读成「鹳鸽」「鹮鸻」）：先看对应原图，不凭记忆改成“应有”的字；确认后用 `text` 改，仍看不清则记 `pending`。
4. 异体、旧字形、通假（穀／榖、幾／几）按本书字形方针；没定方针时保留正文、记 `pending`，汇总后问用户一次。
5. 原刊自身误印、疑脱字照录，不改，写进校注「存疑」。
6. 标点只在原图能确定时改；全半角差异比对时已折叠，不用裁。
7. 只有一家读出的整段：看原图。确有其文、MinerU 漏了的，按原图补进正文对应位置（手动改，记校注）；VL 编出来的，`md` 保留。

裁决写成 `<书>/_数据/冲突清单/decisions.json`：

```json
[
  {"id": "C00034", "decision": "vl", "reason": "冲突区域原图字形为「阤」", "by": "image"},
  {"id": "C00033", "decision": "md", "reason": "冲突区域原图为「雊」，保留底稿", "by": "image"},
  {"id": "C00038", "decision": "text", "text": "曀", "reason": "看原图作「曀」", "by": "image"},
  {"id": "C00036", "decision": "pending", "reason": "已看冲突区域，字形仍模糊，交用户判断", "by": "image"}
]
```

`decision`：`vl` 采 VL 读法；`md` 保留正文；`text` 改成给定的字；`pending` 未决。`by`：`text` 只读文字，`image` 看了原图。

冲突很多时分批裁（每批几百条），派子代理时把本节原则原样交给它，结果合并成一份 `decisions.json`。

## 4. 改正文、记校注、出疑字清单

```powershell
python -X utf8 ${CLAUDE_SKILL_DIR}/scripts/doubts.py --book <书> --decisions <书>/_数据/冲突清单/decisions.json
```

- 只自动改字冲突里定位得到的条目；改之前核对正文那几个字仍是比对时的样子，对不上就不改、转进疑字清单；不碰锚点和注号。
- 每处改动在《<书名>.AI校注.md》追加一行（编号、位置、MinerU、改作、依据）。
- `pending` 与没写裁决的条目写进《<书名>.疑字清单.md》，每条带 `obsidian://aihistory-pdf-sync?...` 链接（从书文件夹向上找 `.obsidian` 定库根；不在库里只写页码）。`--undecided skip` 不列没写裁决的。
- 改完再跑 `verify.py --book <书>`。改了正文之后冲突清单的位置就过期了；要再比，重跑 `crosscheck.py`。
