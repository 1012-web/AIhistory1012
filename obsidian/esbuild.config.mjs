import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const production = process.argv[2] === "production";

// Obsidian 的清单放在仓库根目录（社区目录从那里读），构建时拷进 dist；样式分三份维护，拼成一个 styles.css。
// 三个文件就是发布附件。
const STYLES = ["styles/tokens-obsidian.css", "src/ui/ui.css", "styles/plugin.css"];
const assetsPlugin = {
  name: "aihistory-assets",
  setup(build) {
    build.onEnd(() => {
      mkdirSync("dist", { recursive: true });
      copyFileSync("../manifest.json", "dist/manifest.json");
      const parts = STYLES.map((file) => "/* ==== " + file + " ==== */" + String.fromCharCode(10) + readFileSync(file, "utf8").trimEnd() + String.fromCharCode(10));
      writeFileSync("dist/styles.css", parts.join(String.fromCharCode(10)));
    });
  }
};

// 社区目录的审核把「运行时建 <script> 元素」判为错误。插件里只有 react-dom 有这几处
// （预加载脚本、渲染 <script> 资源，插件从不用），打包时换成直接报错，产物里不留建 <script> 的代码。
const NO_SCRIPT = "(() => { throw new Error(\"PDF Sync Markdown: script elements are not supported\"); })()";
const noScriptPlugin = {
  name: "aihistory-no-script",
  setup(build) {
    build.onLoad({ filter: /[\\/]react-dom[\\/]cjs[\\/]react-dom-client\.(production|development)\.js$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      const patched = source
        .replace(/[\w$]+\.createElement\("script"\)/g, NO_SCRIPT)
        .replace(/[\w$]+\.innerHTML = "<script>\\x3c\/script>";/g, NO_SCRIPT + ";");
      if (/createElement\("script"\)|<script>/.test(patched)) throw new Error("react-dom 里还有建 <script> 的代码，改 noScriptPlugin 的替换规则");
      return { contents: patched, loader: "js" };
    });
  }
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view", "@codemirror/language", "@lezer/common"],
  format: "cjs",
  // React 打进 main.js，用生产版（去掉开发期检查，体积小一半）
  define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
  jsx: "automatic",
  target: "es2022",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  minify: production,
  legalComments: "inline",
  charset: "utf8",
  treeShaking: true,
  outfile: "dist/main.js",
  plugins: [noScriptPlugin, assetsPlugin]
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
