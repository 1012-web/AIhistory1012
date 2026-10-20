# Agent 维护约定

本仓库是一个 Claude Code 插件市场兼插件本体（`aihistory1012`），外加一个 Obsidian 插件。改动时遵守下面的约定。

## 目录结构

```
.claude-plugin/
  marketplace.json      市场 aihistory1012，插件 source "./"
  plugin.json           插件 aihistory1012；skills 数组列出全部 skill 路径；version 每次发布必改
skills/<skill-name>/
  SKILL.md              必需。frontmatter 只放 name + description
  scripts/              Python 脚本
  references/*.md       按需加载的长流程
obsidian/               Obsidian 插件源码（自己的 package.json；根目录不放 package.json）
manifest.json, versions.json   Obsidian 清单（根目录，Obsidian 只认这里）
docs/anchors.md         skill 与插件之间唯一的接口约定
tests/                  pytest
```

根目录不放 `package.json` 与锁文件：插件以仓库根为源时整个仓库会复制进用户本机缓存，根目录有它们会触发装依赖。

## 总原则：脚本只做机械活，判断交 AI

1. 脚本只做确定的机械活：解析 MinerU、PaddleOCR 的结果，写锚点，校验，渲染页图，写文字层，执行 AI 给的裁决。遇到异常只报告（列进报告、打 `<!--?…-->` 标记），不自行改内容。
2. 内容上的判断——补不补、接不接、用哪份字、怎么改、标题几级——交给对话里的 AI：它把脚本输出当证据、不当结论，对照原页图决定并说明理由，拿不准就问用户。
3. 不为少见情况往脚本里加自动修补规则。新情况先在对话里处理；反复出现、而且能写成确定规则的，才进脚本。
4. 判断「机械」的标准不是「同样输入永远同样输出」——七项自动改动都满足这一条，因为它们都是代码。要看三件事：
   - **输入充分**：正确结果所需的信息都在脚本输入里，不需要页图、不需要文意。「识别」也算：连「这是不是脚注」都要判断，就不满足。
   - **错误可逆、可见**：每处改动有前后文、页码锚点，能一键回退；后续零成本检查能发现。
   - **错误代价低**：最坏是格式瑕疵，不是内容增删、页码错配、引文失真。
   三条全过才自动；缺一条只报告。启发式猜测（像不像断句、像不像标题、哪个字对）一律只给候选。
5. 报告要让 AI 能直接动手：写清页码、位置、两边的文字，以及可选的做法。
6. **推荐不是授权**。用户不在场或说「按推荐先做」时，只做点名范围内的最小改动；同页、同书的其他问题另列，不顺手改。做窄、留痕、列清单。
7. 能自动的只有**三类半**：窄口径半全角（`punct_width.py`，凡例定了才跑）、分卷纯拼接（`merge_skeletons.py`）、MinerU 明确标注的跨页合并（`build.py` 插锚点），以及用户确认过凡例后的标题级应用（**尚未实现**，由 AI 按凡例手工做）。凡例记在 `book.json` 的 `conventions`。其余（推断的断段、期刊信息、疑误读页码、OCR 补空行）只报告。详见 [docs/division-of-labor.md](docs/division-of-labor.md)。

## skill 规则

- `name` 与文件夹同名，小写字母、数字、连字符；`description` 写清什么时候用、什么时候不用，含用户可能说的原话。
- 正文写给 agent 看，用祈使句。单文件超过约 500 行就拆进 `references/`，主文件只留路由和不可协商的规则；引用时写相对路径并说明何时读。
- 脚本路径写 `${CLAUDE_SKILL_DIR}/scripts/…`；`lunzhu2md-fix`、`lunzhu2md-audit` 复用导入 skill 的脚本时写 `${CLAUDE_SKILL_DIR}/../lunzhu2md/scripts/…`，不复制一份。
- 每个 skill 另放 `agents/openai.yaml`（Codex 等平台的展示名、一句话说明、默认提示），照 nagi-studio/skills 的格式。SKILL.md 开头说明 `${CLAUDE_SKILL_DIR}` 在别的平台上怎么代入。
- 脚本 stdout 只打 ASCII 状态行（Windows 控制台是 GBK），详细内容写 UTF-8 报告文件。
- 新增 skill：路径加进 `plugin.json` 的 `skills`（目录里有 SKILL.md 才加；占位目录不加），README 加一行。

## 接口约定

锚点、frontmatter `pdf`、书文件夹、`book.json`、疑字清单链接只以 [docs/anchors.md](docs/anchors.md) 为准。要改先改它，再同时改 skill 脚本与插件，并补测试。

## 测试

- `python -X utf8 -m pytest` 必须全过；测试不联网，接口用假响应或本地假服务器。
- Obsidian 插件在 `obsidian/` 里 `npm run check`。

## 凭据与隐私

- 仓库公开。提交前确认没有密钥、令牌、个人姓名、本机绝对路径、待处理文献原文与解析产物（`.gitignore` 已挡 `*.pdf`、`*.json`、`images/`，例外见其中）。
- 令牌只经各脚本的 `configure` 存在本机用户配置目录，绝不打印、不写盘到仓库、不进命令行参数。

## 发布

- 改 `plugin.json` 的 `version`，否则已安装用户收不到更新。
- Obsidian 发布标签等于版本号（`x.y.z`，不带 v），附件 `main.js`、`manifest.json`、`styles.css`；同仓库别的组件不发 GitHub release。
- 推送、改名、发布都是对外动作，先经用户同意。
