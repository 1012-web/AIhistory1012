# AIhistory1012

把现代出版物（论文、研究专著、教材、横排点校本）的 PDF 转成忠于原件、能逐页对回原书的 Markdown，再左 PDF、右正文对照校对。古籍刻本、抄本、竖排本不在本仓库范围内。

**线上预览**：<https://pdf2md.1012.wiki/>，其中 `/demo/` 是只读演示站（自带公版《新史學》样例书，能翻页、对照、选字高亮、搜索，不能存盘）。主页在 `site/`，演示站由 `web/` 静态导出，`.github/workflows/pages.yml` 推 main 就重建。

一个仓库装三样东西：

| 东西 | 干什么 | 给谁用 |
|---|---|---|
| **三个 Claude skill**（Claude Code 插件 `aihistory1012`） | `lunzhu2md` 导入；`lunzhu2md-fix` 按原页修订；`lunzhu2md-audit` 抽检通读 | 所有人；在 Claude Code（或 Codex）对话里用 |
| **Obsidian 插件 `aihistory-pdf-sync`**（PDF Sync Markdown） | 左 PDF、右正文对照，按页跟随，选字逐字高亮，按页校改 | 用 Obsidian 的人 |
| **网页工作台**（`web/`） | 同样的对照阅读与校改，在本机浏览器里打开一本书的文件夹 | 不用 Obsidian 的人 |

三样东西只靠一套约定连着：正文里的物理页锚点 `<!--pdf-page.N-->`（PDF 第 N 页的起点）、印刷页锚点 `<!--p.M-->`、frontmatter（文件开头的属性区）里的 `pdf: "[[原件.pdf]]"`，以及 `_数据/book.json`。约定全文见 [docs/anchors.md](docs/anchors.md)。阅读工具不识字、不改内容；改内容的是对话里的 AI，脚本只是它的工具。

## 截图

| 对照阅读、按页跟随 | 逐字高亮 | 网页工作台 |
|---|---|---|
| ![Obsidian 里左 PDF、右正文，按页跟随](docs/screenshots/01-对照阅读与按页跟随.webp) | ![在正文里选一句，PDF 上高亮同一处](docs/screenshots/02-逐字高亮.webp) | ![网页工作台：浏览器里左右对照](docs/screenshots/03-网页工作台.webp) |

演示文字为梁启超《新史學》，据维基文库，CC BY-SA 4.0。演示书按真实流程排印成扫描件、用 `lunzhu2md` 导入后拍摄；截图同按 CC BY-SA 4.0 释出。

### AI 会犯什么错

识别模型和 AI 都会出错，而且错得「像真的」。所以这套流程处处要对照原页图，阅读工具也把原页放在旁边。举两个试跑里真出过的例子：

- **凭空编出整段字**：一本专著的空白页（只有一条横线），MinerU 识别出了一段通顺的英文，大意是「原图只有一条横线，按规则应当忽略」。这是模型把自己内部的检查过程当成页面文字吐了出来，即「幻觉」：读起来通顺，原书上没有。导入时脚本报了「长段拉丁文」，AI 对照原页后从正文里删掉了；文字层副本那边，现在写字前会比对行框上 OCR 认出的字，差得太远就不写、列进报告交 AI（见 [docs/known-issues.md](docs/known-issues.md)）。
- **几家一起认错**：同一本书里的「蠃虫」，四家识别都认成了「赢虫」。几家互相印证的办法抓不到这种错，只能靠对照原页通读（`lunzhu2md-audit`）。

## 工作流

1. **导入**（`lunzhu2md`）：在对话里说「把这份 PDF 导入成 Markdown」。MinerU 云端解析一次重建正文、脚注、多级标题与页码锚点；可选 PaddleOCR 第二家识别交叉核对，拿不准的字列进「疑字清单」；扫描件另做一份可检索的文字层副本 `<原件>.文字层.pdf`。脚本只做机械活、有异常就报告，内容上的判断由 AI 对照原页图做，拿不准问你。
2. **对照阅读、手改小错**：在 Obsidian 插件或网页工作台里打开这本书，左边原件、右边正文，读到哪页跟到哪页。错一两个字，直接在正文里改。疑字清单里的每一条都是链接，点一下跳到那一页那个字。
3. **大错交 AI 按原页修**（`lunzhu2md-fix`）：整段丢了、脚注错位、表格坏了，在工具条点「复制本页修订请求」，粘给 Claude Code。AI 对照 PDF 原页只改这一页，锚点不动。
4. **可选：抽检通读**（`lunzhu2md-audit`）：全书导入后让 AI 抽检或逐页通读，出一份问题报告（漏段、错字、锚点、脚注），再按报告逐页修。

导入之后只改 Markdown，不再回头改识别结果的 JSON。

## 安装

### 任何 agent：读 INSTALL.md 自己装

把仓库链接丢给 Claude Code、Codex、DSH 或别的 agent，说一句「读 INSTALL.md，按里面装」即可。也可以自己跑：

```bash
git clone https://github.com/1012-web/AIhistory1012 && cd AIhistory1012
python install.py --list     # 探测平台，只读不写
python install.py            # 装（探测到多个平台时用 --platform / --target 指定）
python install.py --make-vault <库路径>   # 可选：建一个 Obsidian 库（插件自动从 Release 下载）
```

`install.py` 只用标准库；装完会把 `SKILL_DIR` 占位符换成本机路径，非 Claude Code 平台不必再手改。三种 skill 自包含，单独拷一个目录也能用。细节与失败处理见 [INSTALL.md](INSTALL.md)。

MinerU 账号是唯一需要人做的事：有账号的话，在对话里说一声，agent 会给你一条隐藏输入的命令；没有账号就说「我没注册过」，它会给你三步注册引导（`skills/lunzhu2md/references/get-token.md`）。

### 三个 skill（Claude Code）

```text
/plugin marketplace add 1012-web/AIhistory1012
/plugin install aihistory1012@aihistory1012
```

更新：`claude plugin marketplace update` 后 `claude plugin update`，会话里 `/reload-plugins`。Codex 用户：各 skill 目录下的 `agents/openai.yaml` 是给 Codex 的说明，把 `skills/` 下三个目录放进 Codex 的 skills 目录即可。

运行环境：最新版 Python 3，外加这些库：

```bash
python -m pip install pymupdf pypdf PyYAML rapidfuzz
```

### Obsidian 插件

正在提交 Obsidian 社区插件市场；上架前先手动安装：从 Releases 下载 `main.js`、`manifest.json`、`styles.css`，放进库里的 `.obsidian/plugins/aihistory-pdf-sync/`，在「设置 → 第三方插件」里启用。也可以自己构建：

```bash
cd obsidian
npm install
npm run build
```

产物在 `obsidian/dist/`。第一次启用会弹四步引导（布局、联动、外观、开始），以后在插件设置页里改。

### 网页工作台

需要 Node.js 24 或更新。

```bash
cd web
npm install
npm run workbench -- "D:\书\某本书"
```

第一次会先构建界面（一两分钟），之后秒开，自动用默认浏览器打开。只监听本机（127.0.0.1），网址带令牌；编辑自动存回硬盘，Claude 在硬盘上改了文件网页立刻刷新，两边同时改了会弹出差异让你选，绝不静默覆盖。详见 [web/README.md](web/README.md)。

## 识别服务与隐私

识别走云端接口，本机不用装模型：[MinerU](https://mineru.net)（主）、[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)（第二家与找行，可选）。**PDF 会上传到这些服务的服务器**；未刊稿、有版权或保密顾虑的材料不要用。密钥用各脚本的 `configure` 在本机隐藏输入保存（Windows 用 DPAPI 加密），不写进仓库，不打印。Obsidian 插件与网页工作台不联网。

## 文档

- [docs/anchors.md](docs/anchors.md)：锚点、frontmatter、书文件夹、`book.json`、疑字清单链接、修订请求格式。skill 与阅读工具之间唯一的接口。
- [docs/division-of-labor.md](docs/division-of-labor.md)：脚本、AI、用户的分工；三条判据、三类半白名单、三色区、不在场协议。
- [skills/lunzhu2md/SKILL.md](skills/lunzhu2md/SKILL.md)、[skills/lunzhu2md-fix/SKILL.md](skills/lunzhu2md-fix/SKILL.md)、[skills/lunzhu2md-audit/SKILL.md](skills/lunzhu2md-audit/SKILL.md)：三个 skill 的流程。
- [obsidian/README.md](obsidian/README.md)：插件的代码分层与开发。
- [AGENTS.md](AGENTS.md)：维护约定。

## 测试

```bash
python -X utf8 -m pytest          # skill 脚本，不调用外部服务
cd obsidian && npm run check       # 插件：类型检查、eslint、单测
cd obsidian && npm run test:e2e    # 插件：在独立下载的 Obsidian 里跑端到端测试
cd web && npm test                 # 网页：单测
cd web && npm run test:e2e         # 网页：Playwright 端到端测试
```

端到端测试用的原材料受版权保护，不在仓库里，路径见各自 README。

## 致谢 / 相关项目

- [PDF Collation](https://github.com/HongdongLee/obsidian-pdf-collation)（Obsidian 插件）与它的网页版 [Collatio](https://hongdonglee.github.io/obsidian-pdf-collation/)。本仓库移植了它的文字匹配算法（MIT 许可，版权声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)），并借鉴了它的基准线跟随和工具条的设计思路。两者是不同的路线：本插件用 Obsidian 原生编辑器和内置 PDF 阅读器，配合 lunzhu2md skill；如果你更喜欢独立的校勘视图，可以试试 PDF Collation。
- [MinerU](https://github.com/opendatalab/MinerU)、[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)：识别服务。
- [PDF.js](https://mozilla.github.io/pdf.js/)、[CodeMirror](https://codemirror.net/)、[React](https://react.dev/)、[Base UI](https://base-ui.com/)、[Motion](https://motion.dev/)：阅读工具的基础。

## 来历

由 md1012 改造而来；改造前的最后状态在标签 `md1012-final`。

## 许可

MIT，见 [LICENSE](LICENSE)；第三方代码见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
