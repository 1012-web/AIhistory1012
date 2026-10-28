# Agent 维护约定

本仓库只放 Obsidian 插件 PDF Sync Markdown（网页工作台与演示站已于 2026-10-28 移除，不再维护）。配套的 agent skill book2md1012 在另一个仓库 1012-web/AIHIST-skills-1012。改动时遵守下面的约定。

## 目录结构

```
obsidian/               Obsidian 插件源码（自己的 package.json）
manifest.json, versions.json   Obsidian 清单（根目录，Obsidian 只认这里）
vault-template/         新建读书库用的 .obsidian 骨架
docs/anchors.md         与 skill 之间唯一的接口约定（副本，见下）
docs/division-of-labor.md  脚本、AI、用户的分工（副本）
tests/fixtures/         公版《新史學》样例书与排印本 PDF，端到端测试用
```

根目录不放 `package.json` 与锁文件：插件在 `obsidian/` 里管自己的依赖。

## 与 skill 的接口

锚点、frontmatter `pdf`、书文件夹、`book.json`、疑字清单链接与条目写法（含判定、存疑记号）、修订请求格式以 skill 仓库的 `skills/book2md1012/references/anchors.md` 为唯一源；本仓库 `docs/anchors.md`、`docs/division-of-labor.md` 是逐字副本，不在这里单独改。约定要变时：先在 skill 仓库改并补测试，再把两份副本原样覆盖过来，然后改插件代码、补测试。

插件不识字，也不自己改内容；整页修订由对话里的 AI 用 skill 完成，插件只生成「本页修订请求」（格式见 `obsidian/src/core/revision.ts`）。例外只有用户逐条点了才写的两处：补页码锚点（预览后写入）、判字（用户定字后改正文那个字、勾疑字清单、在 AI 校注补一行，见 `obsidian/src/core/suspects.ts`）；对不上原样的一律不写。判字读写疑字清单与校注的写法见 `docs/anchors.md` 第六节。

## 测试

两层，分工不混：

1. **回归（提交前必跑）**：`obsidian/` 里 `npm run check`（类型检查、eslint、单测）与 `npm run test:e2e`（wdio 端到端）。wdio 自己下载一份 Obsidian（钉在 `minAppVersion` 1.13.7），每个测试文件现造测试库、窗口挪到屏幕外，不碰用户的 Obsidian 与库，能无人值守跑完。新功能必须补端到端用例。
   - 测试不联网、不读本机书；样例书只用 `tests/fixtures/` 里的公版《新史學》。
2. **实测（装进用户的库之后）**：一律用 Obsidian 官方命令行（Obsidian CLI，Windows 上是 Obsidian 安装目录里的 `Obsidian.com`，命令带 `vault=<库名>`）在用户正在用的 Obsidian 里验证，不用点屏幕的方式（computer use）操作界面。常用：
   - `plugin:reload id=aihistory-pdf-sync` 重载插件；`dev:errors`（先 `dev:errors clear`）、`dev:console` 看报错与日志；
   - `open path=<库内路径>` 打开笔记，`command id=aihistory-pdf-sync:<命令>` 跑插件命令；
   - `eval code=<JS>` 在 Obsidian 里取状态（`app.plugins.plugins["aihistory-pdf-sync"]`），`dev:dom selector=<CSS> text|total`、`dev:css selector=<CSS> prop=<属性>` 查界面与样式，`dev:screenshot path=<文件>` 截图后看图。
   - 默认只读：只看、只查、只截图。会改用户文件的动作（判字定字、补锚点写入）要先征得用户同意，或在写完后立刻还原并核对 `git diff`；用户的库里别人的未提交改动不碰。
   - 重载插件、开面板会打断用户手上的操作：先确认用户此刻没在用；实测中发现文件被改了，先停下来问清是谁改的，不要接着测。
   - Obsidian 窗口不在前台时 Chromium 不重绘：`dev:screenshot` 可能拍到旧画面，`:focus` 之类的样式也不生效（`document.hasFocus()` 为 false）。判断以 `dev:dom`、`eval` 为准，截图只作参考。
   - 不用 CLI 新开测试库：新库第一次打开会弹「是否信任作者」，要人点，回归交给 wdio。

## 凭据与隐私

- 仓库会公开。提交前确认没有密钥、令牌、个人姓名、本机绝对路径、待处理文献原文与解析产物（`.gitignore` 已挡 `*.pdf`、`*.json`、`images/`，例外见其中）。

## 发布

- Obsidian 发布标签等于版本号（`x.y.z`，不带 v），与 `manifest.json`、`versions.json` 一致；附件 `main.js`、`manifest.json`、`styles.css`，由 `.github/workflows/obsidian-release.yml` 构建。同仓库别的组件不发 GitHub release。
- 推送、改名、发布都是对外动作，先经用户同意。
