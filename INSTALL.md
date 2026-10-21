# 安装 AIhistory1012（写给 AI agent）

这是给 **agent 读的安装说明**，不是给人读的教程。用户会把仓库链接丢给你，你照这里做。

要装的是 `skills/` 下的三个 skill：`lunzhu2md`（导入）、`lunzhu2md-fix`（按页修）、`lunzhu2md-audit`（抽检）。三者互相引用，**要装一起装**。

---

## 第 0 步：判断往哪装

先跑：

```bash
python install.py --list
```

它只会探测、不写盘。三种结果：

| 结果 | 你该做什么 |
|---|---|
| 探测到一个平台（✓） | 直接进第 1 步 |
| 探测到多个（✓✓） | 问用户装到哪个，再加 `--platform claude` 之类 |
| 一个都没有 | **停下**，问用户用的哪个 agent，拿到它的技能目录后加 `--target <目录>` |

已知平台的技能目录（`--target` 就填这里的值）：

| 平台 | 技能目录 |
|---|---|
| Claude Code | `~/.claude/skills` |
| DeepSeek Harness（DSH） | `~/.dsh/skills` |
| Codex CLI | `~/.codex/skills`（未验证；目录存在才用） |
| 其他 | 问用户。不要猜 |

## 第 1 步：安装

```bash
python install.py --dry-run     # 先看它要做什么
python install.py               # 真装
```

装的时候会发生两件事：把三个 skill 复制到技能目录；如果目标已有同名目录，先改名为 `*.bak-<时间戳>` 再复制（不删用户的东西）。

脚本只依赖 Python 3.9+ 标准库。**没装 Python 就先装**，再回来。

## 第 2 步：校验（必须做，别跳过）

安装成功后脚本自己会校验，看到 `✓ 3 个 skill 已就位` 才算装完。没看到就按它列的问题处理：

| 它报什么 | 怎么办 |
|---|---|
| 缺 `references/anchors.md` | 安装不完整，重跑；确认是从仓库根目录跑的 |
| 脚本编译失败 | Python 版本太低，要 3.9+ |
| 缺 Python 依赖 | 跑它给出的 `pip install …` 命令 |

自己再确认一眼（三条都该通过）：

```bash
python -c "import pymupdf, pypdf, yaml, rapidfuzz; print('deps ok')"
python <技能目录>/lunzhu2md/scripts/pdf_preflight.py --help
python <技能目录>/lunzhu2md-fix/scripts/page_tool.py --help
```

## 第 3 步：交给用户做的一件事

MinerU 令牌**必须由用户本机输入**，你不能代填、不能问用户要令牌字符串、更不能写进任何文件：

```bash
python <技能目录>/lunzhu2md/scripts/mineru_api.py configure
```

告诉用户：「这条命令会隐藏输入令牌，存在本机用户配置目录，不会进仓库。」

可选（第二家识别，交叉核对用）：`paddle_api.py configure`，没有也能导入，只是没有第二读者。

## 第 4 步：Obsidian（可选，但决定体验）

**先问用户有没有 Obsidian。** 没有也能用——导出的 Markdown 在任何编辑器里都能读，只是不能左右对照 PDF。

有 Obsidian（或用户愿意装）：

```bash
python install.py --make-vault <库路径> --plugin-dir <含 main.js 的目录>
```

- 插件三件套（`main.js`、`manifest.json`、`styles.css`）在 GitHub Release 里，仓库不存二进制。让用户下 Release，或者你按用户指示下载到临时目录，再用 `--plugin-dir` 指过去。
- 建库只是往文件夹里写 `.obsidian/` 骨架，**不需要 Obsidian 已经装好**。
- 打开：`obsidian://open?vault=<库名>`
- 首次打开 Obsidian 会问一次「是否信任此库 / 关闭限制模式」，**这步只能用户点**，别承诺全自动。
- 用户没装 Obsidian 时：Windows `winget install Obsidian.Obsidian`，macOS `brew install --cask obsidian`，Linux flatpak。装之前先问。

## 不要做的事

- 不要覆盖或删除用户已有的库、笔记、`.obsidian/workspace.json`（窗格布局是用户自己的）。
- 不要改仓库里的文件来「适配」某台机器；路径问题由 `install.py --target` 解决。
- 不要打印、回显、提交任何令牌。
- 不要 push、不要发版本、不要改 `plugin.json` 的 version——那是仓库维护者的事。

## 装完怎么验证真的能用

拿一篇有文字层的小 PDF 试一次（10 页内最省）：

```bash
python <技能目录>/lunzhu2md/scripts/pdf_preflight.py <样本.pdf> --output /tmp/preflight.json
```

看到 `PREFLIGHT_OK` 就说明脚本和依赖都通了。真导入要上传云端，**先问用户**再做。
