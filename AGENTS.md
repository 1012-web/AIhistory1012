# Agent 维护约定

本仓库放 Obsidian 插件 PDF Sync Markdown、本机网页工作台与演示站。配套的 agent skill book2md1012 在另一个仓库 1012-web/AIHIST-skills-1012。改动时遵守下面的约定。

## 目录结构

```
obsidian/               Obsidian 插件源码（自己的 package.json）
manifest.json, versions.json   Obsidian 清单（根目录，Obsidian 只认这里）
web/                    本机网页工作台；直接引用 obsidian/src 的源码（@plugin/* 别名）
site/                   线上预览站主页；site/demo/ 由 web/ 静态导出（CI 现造）
vault-template/         新建读书库用的 .obsidian 骨架
docs/anchors.md         与 skill 之间唯一的接口约定（副本，见下）
docs/division-of-labor.md  脚本、AI、用户的分工（副本）
tests/fixtures/         公版《新史學》样例书与排印本 PDF，网页演示站与端到端测试用
```

根目录不放 `package.json` 与锁文件：Obsidian 插件与网页工作台各在 `obsidian/`、`web/` 里管自己的依赖。

## 与 skill 的接口

锚点、frontmatter `pdf`、书文件夹、`book.json`、疑字清单链接、修订请求格式以 skill 仓库的 `skills/book2md1012/references/anchors.md` 为唯一源；本仓库 `docs/anchors.md`、`docs/division-of-labor.md` 是逐字副本，不在这里单独改。约定要变时：先在 skill 仓库改并补测试，再把两份副本原样覆盖过来，然后改插件与网页代码、补测试。

阅读工具不识字、不改内容；内容修订由对话里的 AI 用 skill 完成，插件只生成「本页修订请求」（格式见 `obsidian/src/core/revision.ts`）。

## 测试

- 插件：`obsidian/` 里 `npm run check`（类型检查、eslint、单测）；端到端 `npm run test:e2e`。
- 网页：`web/` 里 `npm test`；端到端 `npm run test:e2e`。
- 测试不联网、不读本机书；样例书只用 `tests/fixtures/` 里的公版《新史學》。

## 凭据与隐私

- 仓库会公开。提交前确认没有密钥、令牌、个人姓名、本机绝对路径、待处理文献原文与解析产物（`.gitignore` 已挡 `*.pdf`、`*.json`、`images/`，例外见其中）。

## 发布

- Obsidian 发布标签等于版本号（`x.y.z`，不带 v），与 `manifest.json`、`versions.json` 一致；附件 `main.js`、`manifest.json`、`styles.css`，由 `.github/workflows/obsidian-release.yml` 构建。同仓库别的组件不发 GitHub release。
- 推送、改名、发布都是对外动作，先经用户同意。
