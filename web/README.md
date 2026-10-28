# AIhistory 网页工作台

给不用 Obsidian 的人：在本机打开一本书的文件夹，浏览器里左右对照 PDF 与 Markdown。
编辑自动存回硬盘；Claude 在硬盘上改了文件，网页立刻刷新；两边同时改了会弹出差异让你选，绝不静默覆盖。

与 Obsidian 插件 `aihistory-pdf-sync` 共用同一套约定（`docs/anchors.md`：物理页锚点 `<!--pdf-page.N-->`、frontmatter `pdf`、`_数据/book.json`、疑字清单链接），
核心逻辑与工具条直接用插件源码里的 `obsidian/src/core/`、`obsidian/src/ui/`，不另写一套。

## 启动

第一次先装依赖（只需一次）：

```bash
npm install
```

打开一本书（第一次会先自动构建界面，约一两分钟；之后秒开）：

```bash
npm run workbench -- "D:\书\新史學"
```

启动后自动用默认浏览器打开（网址带着令牌，终端里只打印不带令牌的 `http://127.0.0.1:<端口>/`）。关掉终端窗口或按 Ctrl+C 停止。
第一次打开会弹四步引导（布局、联动、外观、开始），平时在顶栏「设置」里改，也可在那里重开引导。

- **端口固定**：默认 4312，在设置页「本机服务」里改，下次启动生效。端口被占用时启动命令会明说原因并停下，不会悄悄换一个；这一次临时换用 `--port 4313`。
- **令牌**：第一次启动时生成，存在用户配置文件里，重启照用，所以浏览器记住一次、疑字链接的网址重启后照样能用。令牌不打印、不进日志、不进仓库。
  配置文件：Windows 是 `%APPDATA%\AIhistory1012\workbench.json`（其他系统 `~/.config/aihistory1012/workbench.json`），里面还存着界面设置。删掉它会换一个新令牌。
- 其他选项：`--no-open`（不自动开浏览器）。改界面代码时用 `npm run dev -- "<书文件夹>"`。

## 演示站（线上，只读）

线上预览原在 <https://pdf2md.1012.wiki/demo/>（2026-10-28 起暂停，访问为 404；本机用下面的 `npm run demo:serve` 看）：同一套界面静态导出的一份，读的是站点自带的公版样例书，能翻页、对照、选字高亮、搜索，**不能存盘**（没有本机文件夹可写）。

```bash
npm run demo        # 造演示书 → next build（output: export，basePath /demo）→ 拷进 ../site/demo/
npm run demo:serve  # 本机预览整个站点：http://127.0.0.1:4320/
```

- 演示模式由 `src/client/demo.ts` 接管：`fetchBook`/`fetchFile` 读 `public/demo/index.json`；保存直接报只读；设置存在浏览器 localStorage；PDF 走静态文件。`api.ts` 里每个接口开头一行 `DEMO ? …` 分支，本机版一行都不走。
- `scripts/make-demo.mjs` 从 `tests/fixtures/clean/新史學` 与 `tests/fixtures/新史學.pdf` 造数据（公版，CC BY-SA 4.0），不读本机任何材料。
- 静态导出时 `_next/` 与 pdf.js 的 worker/CMap 都在 `/demo/` 下，靠 `NEXT_PUBLIC_AIH_BASE` 拼绝对路径（`PdfPane.tsx` 的 `asset()`）。
- 站点主页是仓库根目录的 `site/index.html`（手写，无构建），`site/CNAME` 是自定义域名；推送 main 后由 `.github/workflows/pages.yml` 上传整个 `site/`。

## 能做什么

| 功能 | 说明 |
|---|---|
| 对照 | 左 PDF（pdf.js 官方查看器，带文字层）、右 Markdown（CodeMirror 6）；工具条 ⇄ 换边；中间分隔条可拖 |
| 按页跟随 | 基准线在视口距顶 35%，页内按比例；双向 / 单向 / 暂停三档；程序滚动后对侧静默 200 毫秒防回环 |
| 按页校改 | 当前页正文加浅底色；工具条 ‹ › 两边一起翻，页码框可直接输入跳页 |
| 多文件书 | 按 frontmatter `pdf` → `book.json` → 文件夹里唯一的 PDF → 同名 PDF 配对；按书内索引跨文件跳页（PDF 翻到卷首那页，正文自动换到卷首） |
| 锚点标签 | 正文里的锚点显示成「7 · p.113」小标签，点击两边跳到该页；光标移进去露出原文可改 |
| 逐字高亮 | 正文里选字 → PDF 上高亮同一处；PDF 上选字 → 正文里选中同一处（插件移植自 PDF Collation 的匹配算法） |
| 全文搜索 | Ctrl+K；同时搜 Markdown 与 PDF 文字层，↑ ↓ 选、Enter 定位 |
| 自动存盘 | 停手 0.7 秒存回硬盘（先写临时文件再改名）；顶栏显示 已存盘 / 未存 / 存盘中 / 有冲突 |
| 外部改动 | Claude 或别的程序改了 `.md`、`.pdf`、`book.json`，网页即时刷新（chokidar 监视 + 推送） |
| 冲突 | 网页有没存的改动、磁盘上又被改了：并排显示两边差异（@codemirror/merge），选「保留网页里的」或「用磁盘上的」 |
| 疑字链接 | 编辑器里 Ctrl/⌘ + 点击疑字清单中的 `obsidian://aihistory-pdf-sync?…` 链接，网页里跳到该页该字（见下） |
| 修订请求 | 顶栏「复制本页修订请求」，格式与插件相同（`obsidian/src/core/revision.ts`），粘给 Claude Code 的 book2md1012 |
| 改绑 PDF | 工具条 ⋯ →「配对：…（点击改绑）」→ 选 PDF → 勾选文件，写进各文件 frontmatter 的 `pdf` |
| 补页码锚点 | 顶栏「补页码锚点」：按 PDF 文字层找每页开头，先出预览和把握报告，勾选确认才写；只插 `<!--pdf-page.N-->`、不改正文、已有锚点不动（写前逐字核对）。PDF 没有文字层（扫描件）时说明原因、不硬做：先用 book2md1012 做 `<原件>.文字层.pdf` 副本 |
| 设置 | 布局（PDF 左右、工具条默认位置）/ 联动（双向·单向·暂停、显示 PDF 栏、页内按比例、跟随基准线 20–50%）/ 外观（页码标签、当前页底色、减少动效）/ 上手（「带我做」）/ 本机服务（端口）；顶部实时预览 |

### 疑字清单链接与 `/open` 路由

| | 网址 |
|---|---|
| 插件 | `obsidian://aihistory-pdf-sync?vault=<库名>&file=<库内相对路径>&page=<N>&text=<现字>&ctx=<前后各约 6 字>` |
| 网页 | `http://127.0.0.1:<端口>/open?file=<路径>&page=<N>&text=<现字>&ctx=<前后各约 6 字>` |

参数同名同义，同样 UTF-8 百分号编码；网页没有「库」，不要 `vault`。`file` 可以照抄清单里的库内路径，网页按最长后缀认到书里的文件
（`论文/某某考/01-正文.md` → `01-正文.md`）。清单不用改：在网页编辑器里 Ctrl/⌘ + 点击原来的 `obsidian://` 链接即可。
`/open` 要在已经用启动命令打开过一次的浏览器里用（令牌记在该站点的本地存储里；令牌重启不换，所以一直有效）。

## 安全

- 只监听 127.0.0.1，不监听 0.0.0.0；不联网（不调 MinerU、PaddleOCR 等；Next.js 的匿名使用统计已关）。
- 随机令牌存在用户配置文件里，只放进自动打开的网址的 `#token=` 交给浏览器（`#` 后面的部分不会发给服务器、也不进 Referer）；所有 `/api/` 接口都要带请求头 `x-aih-token`，设置接口也不交出令牌。
- 只接受 Host 为 `127.0.0.1:<端口>` / `localhost:<端口>` 的请求（挡 DNS 重绑定），带 Origin 的请求必须来自本服务（挡别的网页借浏览器乱调）。
- 只能读写所开书文件夹里的 `.md` 与 `_数据/book.json`，PDF 只读；`_数据/` 里别的文件（MinerU 原始结果等）不开放。挡 `..`、绝对路径、盘符、空字节，并核对真实路径，防 junction / 符号链接绕出书文件夹。

## 代码在哪

```
server/       本机服务（Node）：workbench.ts 启动入口；listener.ts + guard.ts 把关；api.ts 接口；paths.ts 路径校验；
              files.ts 读写与冲突检测；book.ts 扫描与配对；watcher.ts 监视
app/          Next.js 页面（/ 与 /open），只是外壳
src/client/   浏览器端：Workbench.tsx 主体；pdf/ PDF 栏；editor/ 编辑器栏；sync.ts 跟随调度；search.ts 搜索；
              ConflictDialog.tsx 冲突；open-link.ts 疑字链接路由
src/s3/       对插件源码 core/、ui/ 的唯一入口（core.ts、ui.ts）
fixtures/     测试用的书（`npm run check`、`npm run test:e2e` 先跑 scripts/make-fixture.py，按仓库里的《新史學》样本 tests/fixtures/ 现造；git 忽略）
tests/unit/   vitest：路径校验、令牌、接口、配对、锚点跳转、链接路由、搜索
tests/e2e/    Playwright：每个用例拷一份书到临时目录、起一个工作台子进程
screenshots/  效果图（端到端测试生成）
```

插件源码的位置由 `tsconfig.json` 与 `vitest.config.ts` 里的 `@plugin/*` 别名决定（两处须一致）：指 `../obsidian/*`（本仓库的插件目录）。
`next.config.ts` 的打包根设在上一级目录（仓库根），原因同此。类型检查、构建要用到插件目录的依赖：本目录 `npm install`／`npm ci` 之后、以及 `build`、`typecheck`、`check` 之前，`scripts/ensure-plugin-deps.mjs` 会查一遍，没装就自动在 `obsidian/` 里跑 `npm ci`。

## 测试

```bash
npm run check
```

```bash
npm run build
```

```bash
npm run test:e2e
```
