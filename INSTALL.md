# 安装 AIhistory1012（写给 AI agent）

用户会把仓库链接丢给你。你要完成 **安装一个统一 skill → 校验 → 一次给完使用引导**。先读 `skills/book2md1012/references/onboarding.md` 与 `ocr-support.md`，安装后依此介绍默认双家识别、两家账号配置、作者自制的配套 Obsidian 插件 PDF Sync Markdown，以及用它阅读、手动修订的方法。不要自行跳过第二家或插件引导。

先记住一句：**手工步骤永远有效，脚本只是省事。** 脚本报错就回到手工，不要反复调脚本，也不要改仓库文件去适配这台机器。

---

## 一、装到哪：先确认，别猜

只安装 `book2md1012`：导入、按页修订、抽检通读共用一个入口，细则在 references/ 按需读取。旧版插件的修订请求仍可使用。

| 平台 | 技能目录（只是提示） |
|---|---|
| Claude Code | `~/.claude/skills` |
| DeepSeek Harness | `~/.dsh/skills` |
| Codex CLI | `~/.codex/skills` |
| 其他 | **问用户**，不要猜 |

你自己的平台你最清楚。拿不准就问一句「你的 skills 目录在哪」，比装错地方再清理省事得多。

## 二、安装：要的是一个目录，不是一份仓库

目标只有一个：`book2md1012` 一个目录出现在技能目录里。源从哪来你定——clone、下 zip、下 tarball 都行，**用完把临时的源删掉**，别在用户机器上留一份没用的仓库副本（除非用户想留着以后 `git pull` 更新）。

**A. 临时目录，装完就删（推荐）**

```bash
tmp=$(mktemp -d)
git clone --depth 1 https://github.com/1012-web/AIhistory1012 "$tmp/repo"
cp -r "$tmp/repo"/skills/book2md1012 <技能目录>/
rm -rf "$tmp"
```

Windows PowerShell：

```powershell
$tmp = Join-Path $env:TEMP ("aih-" + [guid]::NewGuid().ToString("N"))
git clone --depth 1 https://github.com/1012-web/AIhistory1012 $tmp
Copy-Item "$tmp\skills\book2md1012" <技能目录> -Recurse
Remove-Item $tmp -Recurse -Force
```

**B. 没有 git**：让用户下 zip（仓库页 Code → Download ZIP）或 tarball，解压到临时目录，拷 `skills/book2md1012` 目录，删掉解压的东西。

**C. 用户想留着更新**：clone 到固定位置（比如 `~/tools/AIhistory1012`），以后 `git pull` 后重拷一次，或在仓库目录里重跑 `install.py`。

三种都行，选哪种看用户机器上有没有 git、想不想以后自动更新——**不用为此问用户**，按环境选最省事的一种即可；只有“要不要留一份仓库”这种会影响用户磁盘的决定，才值得问一句。

装完目录结构应该是：

```
<技能目录>/book2md1012/SKILL.md
<技能目录>/book2md1012/references/anchors.md
<技能目录>/book2md1012/references/revision.md
<技能目录>/book2md1012/references/audit.md
```

升级旧版时，安装器将三个旧入口的 SKILL.md 改名保存为非入口文档，不删除旧脚本与资料，避免三个 skill 同时触发。手工安装也要先将旧入口改名；不要删除用户文件。

## 三、脚本版（可选，省事）

在仓库目录里跑（A 方案那种临时目录也行，跑完连目录一起删）：

```bash
python install.py --list                 # 探测平台，只读
python install.py --target <技能目录>     # 装，旧的自动备份成 *.bak-<时间戳>
python install.py --manual               # 只打印手工步骤
```

它多做的事：把文档里的 `${CLAUDE_SKILL_DIR}` 换成本机路径（Claude Code 会自己替换，别的平台不会）、编译所有脚本、检查依赖、检查文档齐不齐。

**脚本挂了就回第二节手工装**，别修脚本。

安装到自定义测试目录并不等于平台会自动发现：不要承诺「下一轮自动生效」。说明后续可让 AI 显式读取该目录内的 `SKILL.md` 使用；只有已处于当前平台发现目录时，才按平台实际加载方式介绍。手工复制后，非 Claude Code 平台还须将文档内 `${CLAUDE_SKILL_DIR}` 替换为各 skill 的实际安装绝对路径（或用 `install.py --target` 完成）；这一步由 AI 做。

换电脑时需重新安装脚本运行环境，并在新电脑重新输入令牌；不要复制原电脑的 DPAPI 密文配置或写死原电脑的安装路径。图形配置窗口需要 Tk 和桌面会话；缺少图形支持时保留原终端隐藏输入方式。

## 四、校验（必须做，别跳）

```bash
python -c "import pymupdf, pypdf, yaml, rapidfuzz; print('deps ok')"
python <技能目录>/book2md1012/scripts/pdf_preflight.py --help
python <技能目录>/book2md1012/scripts/page_tool.py --help
```

三条都应正常输出。报 `ModuleNotFoundError` 就：

```bash
python -m pip install pymupdf pypdf PyYAML rapidfuzz
```

## 五、两家 API 与完整使用引导

按安装后的 `book2md1012/references/onboarding.md` 和 `get-token.md`，在同一条回复里给完：

- 偏离已定识别来源、整理或核对流程，先交互说明原因和影响并取得明确许可；未获许可不得改用旧文字层或省略核对后交付。
- 默认 MinerU + PaddleOCR 云端 API。每份 PDF 处理前先交互选择“仅核双家冲突（推荐）／全书逐页逐字核对”；仅核冲突只看不同字及必要上下文、结构分歧对应区域，不通读无冲突页面，AI 裁决后仅将未决疑字交用户。导入前检测有无文字层，有则交互询问是否沿用，推荐不沿用、由 MinerU 重新识别重构；不预判质量，不因没有乱码警告就推荐保留。之后参数、整理和检查交给 AI，用户判断疑字、阅读找错。
- 由 AI 打开 `configure_tokens.py` 本机窗口，让用户从两家官网复制令牌、粘贴并保存，分别验证；说明上传与计费。没有图形界面才给原终端隐藏输入命令。明确说明无需安装 MinerU 客户端、PaddleOCR 软件、飞桨框架、本地 OCR 模型或 CUDA。Python 及脚本依赖由 AI 配置；Obsidian/配套插件是阅读环境，不是 OCR API 前置条件。不索取令牌。
- 根据 `ocr-support.md` 介绍官方版面能力及现代竖排的样页验证路线。
- 首次介绍时明确说「PDF Sync Markdown 是本 skill 作者自行开发的配套 Obsidian 插件」，说明它用于 PDF 与 Markdown 对照阅读、按页联动和修订；作者推荐用 Obsidian 搭配它。提供 [效果预览](https://pdf2md.1012.wiki/demo/)，说明它只是固定样例演示，不是个人书库阅读器。
- 问「你已安装 Obsidian 吗？准备使用哪个库？」同时说明安装/已有库两种情况的下一步。确认库路径后由 AI 安装 PDF Sync Markdown 插件，用户在 Obsidian 信任库并启用。
- 教用户打开索引和正文、阅读/实时预览/源码视图、自行改 Markdown、工具条「⋯ → 配对：…（点击改绑）」重新关联 PDF，或复制本页修订请求交 AI。
- 给一个直接交 PDF 路径的使用示例，说明「哪一步想具体了解，可以追问」。

有权限操作的安装和技术检查由 AI 完成；账号登录、验证码、本机窗口中的令牌输入由本人做。不要让用户自己承担预检、OCR 选参、整理及结构检查。

## 六、Obsidian 插件安装

新库可运行 `python -X utf8 install.py --make-vault <库路径>`；已有库只在用户选定库并授权后合并安装，不能覆盖笔记和原设置。插件从 [Releases](https://github.com/1012-web/AIhistory1012/releases) 下载 `main.js`、`manifest.json`、`styles.css`，放进 `<库>/.obsidian/plugins/aihistory-pdf-sync/`；保留并合并已有第三方插件列表。用户在「设置 → 第三方插件」启用 **PDF Sync Markdown**。具体操作与阅读方法见 `onboarding.md`。

## 七、出错了怎么办

| 现象 | 处理 |
|---|---|
| `install.py` 报错退出 | 按第二节手工装；脚本不修 |
| 探测到多个平台 | 问用户装哪个，再 `--target` |
| 目标目录没权限 | 换到用户主目录下的路径，或让用户手动拷 |
| 插件下载失败 | 走第六节「插件」的手工三步 |
| Obsidian 打开后插件没生效 | 检查「限制模式」是否关掉、`community-plugins.json` 是否登记、Obsidian 版本 ≥ 1.13.7 |

## 八、不要做

- 不要覆盖用户的库、笔记、`.obsidian/workspace.json`。
- 不要修改仓库文件来适配本机。
- 不要打印、回显、提交任何令牌。
- 不要 push、不要打标签、不要改 `plugin.json` 的 version。

## 九、装完的验证

用仓库提供的样例 PDF 试一次本地预检（不上传）；没有样例时用用户已提供的材料，不另找用户私人文件：

```bash
python <技能目录>/book2md1012/scripts/pdf_preflight.py <样本.pdf> --output /tmp/preflight.json
```

看到 `PREFLIGHT_OK` 说明脚本和依赖都通了。首次安装不上传材料。用户请求处理具体 PDF 时，先说明默认上传 MinerU 与 PaddleOCR 并确认相应权限；已明确授权则继续完成，不再逐步问。
