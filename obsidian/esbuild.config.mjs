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
  plugins: [assetsPlugin]
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
