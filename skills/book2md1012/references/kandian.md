# 看典古籍：MinerU 样页失败后的竖排来源

代表页适用性验证先说明页范围与目的并取得用户许可；仅核双家冲突模式不因此授权通读全书。整理仍按 [verification-modes.md](verification-modes.md) 的范围，仅核冲突先比双家结果，只看分歧区域。

适用于竖排材料的 MinerU 样页出现实质缺漏、列序或夹注结构不可用时。先告诉用户增加看典云端服务的理由、上传页和可能费用，取得授权；PaddleOCR 仍作为另一家识别交叉核对。

## 配置与调用

用户在 [看典古籍 OCR API](https://kandianguji.com/shuzihua?page_mode=ocr_api) 登录并申请 Token，审核激活后在本机运行：

```powershell
python -X utf8 "${CLAUDE_SKILL_DIR}/scripts/kandian_api.py" configure
```

账号与令牌均隐藏输入，不贴进聊天。Windows 用现有 DPAPI 方法加密；其他系统配置文件仅当前用户可读。AI 用 `status` 查看本机是否配置、用 `usage` 查询激活及额度，不打印账号或令牌。

```powershell
python -X utf8 "${CLAUDE_SKILL_DIR}/scripts/kandian_api.py" status
python -X utf8 "${CLAUDE_SKILL_DIR}/scripts/kandian_api.py" usage
python -X utf8 "${CLAUDE_SKILL_DIR}/scripts/kandian_api.py" submit "<原件>.pdf" -o "<书>/_数据/看典" --pages 1-3
```

AI 先选正文及双行夹注等代表页，核对图像与结果后继续全书（不传 `--pages`）。客户端在本地把 PDF 逐页渲染为图像，使用官方 `/ocr_api`，固定 `det_mode=sp`、`version=v2`，请求版面、行坐标和候选字。旧 PDF 任务 API 已停用，不能调用。

失败时停在失败页，保留已完成页；同样命令续跑不重复调用已保存原始响应的页。输入文件或 DPI 改变时另选输出目录，不混用缓存。初次接入若账号尚未提供，只能验证本地及模拟 API 流程，不能声称真实识别已通过。

## 接入现有整理流程

1. `_raw/pNNNN.json` 保留原始响应（去凭据）；`pNNNN.json` 保留来源、页号、逐行内容和粗版面标签；`_skeleton.md` 只有物理页锚点与正文行，不是可交付成品。
2. **不要把看典 JSON 传给 MinerU 的 `build.py`。** AI 据逐页图像、原始坐标与文本底稿，恢复段落、双行夹注、脚注和标题。页眉/版心不得混入正文，注区也不得因粗分类而丢弃。只读文本无法判定时看原图，未决字问用户。
3. 对照原页补全印刷页，写 frontmatter 的 `pdf`、校注、书索引和 `book.json`；沿用导入 skill 的拆文件、拷图（有图时据来源）、`verify.py --book`、交付检查。不要伪造 MinerU 的分类或跨页字段。
4. 运行 `paddle_api.py submit` 取得同页另一份结果，再用现有 `crosscheck.py --book <书> --vl <书>/_数据/PaddleOCR` 比对已经整理的 Markdown。这里 `--vl` 仍是 PaddleOCR，不是看典。AI 处理两份结果的差异，完成疑字清单与校注。
5. 文字层制作的现有脚本依赖 MinerU 行文/段落数据，不适配看典底稿。竖排分支保留原 PDF，不把未经适配的文字层副本写成已完成；插件按页跟随仍靠 Markdown 锚点，逐字定位取决于原 PDF 是否有可用文字层。

依据：[看典官方 API 文档](https://kandianguji.com/api_documentation)，核对日期 2026-10-25。尚需用实际账号和真实竖排材料验证本路线的线上质量。
