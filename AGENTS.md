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

锚点、frontmatter `pdf`、书文件夹、`book.json`、疑字清单链接、修订请求格式以 skill 仓库的 `skills/book2md1012/references/anchors.md` 为唯一源；本仓库 `docs/anchors.md`、`docs/division-of-labor.md` 是逐字副本，不在这里单独改。约定要变时：先在 skill 仓库改并补测试，再把两份副本原样覆盖过来，然后改插件代码、补测试。

插件不识字，也不自己改内容；整页修订由对话里的 AI 用 skill 完成，插件只生成「本页修订请求」（格式见 `obsidian/src/core/revision.ts`）。例外只有用户逐条点了才写的两处：补页码锚点（预览后写入）、判字（用户定字后改正文那个字、勾疑字清单、在 AI 校注补一行，见 `obsidian/src/core/suspects.ts`）；对不上原样的一律不写。

判字读疑字清单时，约定里只有条目链接一项；「· 字 · 前文【现字】后文 ／ VL 作【读法】（说明）」这段写法与判定后补的「 · 判定作【X】（日期）」「 · 存疑（日期）」、校注里「## 用户判定的疑字」一节，目前只按 skill 现行输出解析，尚未写进 `anchors.md`。skill 改这几处写法前，先把它们补进约定。

## 测试

- `obsidian/` 里 `npm run check`（类型检查、eslint、单测）；端到端 `npm run test:e2e`。
- 测试不联网、不读本机书；样例书只用 `tests/fixtures/` 里的公版《新史學》。

## 凭据与隐私

- 仓库会公开。提交前确认没有密钥、令牌、个人姓名、本机绝对路径、待处理文献原文与解析产物（`.gitignore` 已挡 `*.pdf`、`*.json`、`images/`，例外见其中）。

## 发布

- Obsidian 发布标签等于版本号（`x.y.z`，不带 v），与 `manifest.json`、`versions.json` 一致；附件 `main.js`、`manifest.json`、`styles.css`，由 `.github/workflows/obsidian-release.yml` 构建。同仓库别的组件不发 GitHub release。
- 推送、改名、发布都是对外动作，先经用户同意。
