# 安装 AIhistory1012（写给 AI agent）

用户会把仓库链接丢给你。你要做三件事：**装三个 skill → 校验 → 告诉用户还差什么**（令牌、Obsidian）。

先记住一句：**手工步骤永远有效，脚本只是省事。** 脚本报错就回到手工，不要反复调脚本，也不要改仓库文件去适配这台机器。

---

## 一、装到哪：先确认，别猜

三个 skill 是 `lunzhu2md`（导入）、`lunzhu2md-fix`（按页修）、`lunzhu2md-audit`（抽检），**要装一起装**——它们互相引用脚本。

| 平台 | 技能目录（只是提示） |
|---|---|
| Claude Code | `~/.claude/skills` |
| DeepSeek Harness | `~/.dsh/skills` |
| Codex CLI | `~/.codex/skills` |
| 其他 | **问用户**，不要猜 |

你自己的平台你最清楚。拿不准就问一句「你的 skills 目录在哪」，比装错地方再清理省事得多。

## 二、安装（手工版，任何平台都一样）

```bash
git clone https://github.com/1012-web/AIhistory1012
cp -r AIhistory1012/skills/lunzhu2md* <技能目录>/
```

Windows PowerShell：

```powershell
git clone https://github.com/1012-web/AIhistory1012
Copy-Item AIhistory1012\skills\lunzhu2md* <技能目录> -Recurse
```

没有 git 就让用户下 zip，解压后同样拷 `skills/` 下三个目录。

装完目录结构应该是：

```
<技能目录>/lunzhu2md/SKILL.md
<技能目录>/lunzhu2md/references/anchors.md
<技能目录>/lunzhu2md-fix/SKILL.md
<技能目录>/lunzhu2md-audit/SKILL.md
```

## 三、脚本版（可选，省事）

```bash
python install.py --list                 # 探测平台，只读
python install.py --target <技能目录>     # 装，旧的自动备份成 *.bak-<时间戳>
```

它多做的事：把文档里的 `${CLAUDE_SKILL_DIR}` 换成本机路径（Claude Code 会自己替换，别的平台不会）、编译所有脚本、检查依赖、检查文档齐不齐。

**脚本挂了就回第二节手工装**，别修脚本。

## 四、校验（必须做，别跳）

```bash
python -c "import pymupdf, pypdf, yaml, rapidfuzz; print('deps ok')"
python <技能目录>/lunzhu2md/scripts/pdf_preflight.py --help
python <技能目录>/lunzhu2md-fix/scripts/page_tool.py --help
```

三条都应正常输出。报 `ModuleNotFoundError` 就：

```bash
python -m pip install pymupdf pypdf PyYAML rapidfuzz
```

## 五、令牌（用户自己跑，你不要代填）

```bash
python <技能目录>/lunzhu2md/scripts/mineru_api.py configure
```

告诉用户：「这条命令隐藏输入，令牌存在本机，不会进仓库、不进聊天记录。」你**不要**索取令牌字符串。

可选：`paddle_api.py configure`（第二家识别，用于交叉核对；没有也能导入）。

## 六、Obsidian：带着用户点，别只丢命令

**先问有没有装 Obsidian。** 没装也能用——导出的 Markdown 任何编辑器都能读，只是不能左右对照。

### 已经装了

```bash
python install.py --make-vault <库路径>
```

脚本会建好 `.obsidian/` 骨架、下载插件、装好阅读样式。然后**在对话里一步步带用户走**：

1. 「库建在 `<路径>`。」
2. 「打开 Obsidian，点左下角的库切换图标（vault switcher）→『打开文件夹作为库』→ 选这个路径。」
3. 「如果弹出『限制模式 / 是否信任此库』，选信任，然后到『设置 → 第三方插件』把 PDF Sync Markdown 打开。」——这步只能人点，别承诺全自动。
4. 「把 PDF 和导入好的书文件夹放进去，打开 `01-正文.md`，左边 PDF、右边正文。」

已经注册过的库，也可以直接给 `obsidian://open?vault=<库名>`，但**先给界面路径**，URL 只当捷径。

### 没装 Obsidian

先问要不要装，给了同意再说：

| 系统 | 命令 |
|---|---|
| Windows | `winget install Obsidian.Obsidian` |
| macOS | `brew install --cask obsidian` |
| Linux | 官网 AppImage / `flatpak install flathub md.obsidian.Obsidian` |

装完回到上一节的四步。

### 插件

`--make-vault` 会从 GitHub Release 自动下载 `main.js`、`manifest.json`、`styles.css`（稳定地址 `releases/latest/download/`）。下不到（断网、公司网络拦了）就手工：

1. 打开仓库 Releases 页面，下这三个文件；
2. 放进 `<库>/.obsidian/plugins/aihistory-pdf-sync/`；
3. 确认 `<库>/.obsidian/community-plugins.json` 里有 `"aihistory-pdf-sync"`。

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

拿一篇 10 页内的 PDF 试一次预检（不上传）：

```bash
python <技能目录>/lunzhu2md/scripts/pdf_preflight.py <样本.pdf> --output /tmp/preflight.json
```

看到 `PREFLIGHT_OK` 说明脚本和依赖都通了。真要导入会上传云端，**先问用户**。
