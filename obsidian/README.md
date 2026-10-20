# AIhistory PDF Sync（Obsidian 插件）

左边用 Obsidian 内置 PDF 阅读器看原件，右边用原生编辑器看 Markdown：读到哪页 PDF 跟到哪页，选字逐字高亮，按页校改。
只靠正文里的物理页锚点 `<!--pdf-page.N-->`（后跟印刷页 `<!--p.M-->`）和 frontmatter `pdf: "[[原件.pdf]]"` 工作，不用旁挂 JSON。

## 代码分层（网页版复用）

- `src/core/`：锚点解析、书内索引、页内比例换算、移植的匹配算法、`obsidian://` 链接解析、补锚点方案、修订请求。不 import `obsidian` 与 React，对外导出见 `src/core/index.ts`。
- `src/ui/`：工具条、绑定确认窗、补锚点预览窗（React 19 + Base UI + Motion）。不 import `obsidian`，宿主能力经 props 注入，对外导出见 `src/ui/index.ts`。外观以 `design/toolbar-approved.html` 为准；组件样式在 `src/ui/ui.css`，只引用 `--aps-*` 设计变量（插件在 `styles/tokens-obsidian.css` 里指向 Obsidian 主题变量，网页版用 `src/ui/tokens-web.css`）。构建时把这两份和 `styles/plugin.css` 拼成 `dist/styles.css`。
- 其余（`controller.ts`、`toolbar-host.tsx`、`pdf-view.ts`、`markdown-pane.ts`、`editor-ext.ts`……）是 Obsidian 宿主层。React 挂在目标窗格所在窗口的 document 里（兼容弹出窗口）。

## 开发

```bash
npm install
npm run check      # tsc + eslint（官方审查规则）+ vitest 单测
npm run build      # 产物在 dist/：main.js、manifest.json（拷自仓库根目录）、styles.css
npm run test:e2e   # 在 wdio-obsidian-service 下载的独立 Obsidian 里跑端到端测试
```

端到端测试的测试库每次现造在 `.scratch/e2e-vault`，原材料是仓库里的测试样本 `tests/fixtures/clean/新史學`（公版演示书，CC BY-SA 4.0）与 `tests/fixtures/新史學.pdf`（排印本），不读本机材料；Obsidian 安装包缓存在本目录的 `.obsidian-cache`（git 忽略，首次运行下载；`OBSIDIAN_CACHE` 可改）。
窗口默认挪到屏幕外，想看过程设 `APS_E2E_SHOW=1`。

## 内部接口

PDF 一侧用了 Obsidian 内置 PDF 视图的非公开对象（`view.viewer.child.pdfViewer.pdfViewer`、`dom.viewerContainerEl`、PDF.js 的 eventBus 与 `.page` / `.textLayer` DOM），
全部集中在 `src/pdf-view.ts`；拿不到时跳页退回公开的 `setEphemeralState({ subpath: "#page=N" })`。Obsidian 升级后先跑 e2e。
