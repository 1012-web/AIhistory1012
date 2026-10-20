// 网页直接引用插件源码 obsidian/src/（core、ui），那些文件里的 react、@base-ui/react、motion 按 Node 的规矩
// 从 obsidian/node_modules 找，不从本目录找。所以类型检查、构建之前，插件目录的依赖必须已装好。
// 没装就在插件目录跑一次 npm ci（按它自己的 package-lock.json，版本与本目录一致）；装好了什么都不做。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const plugin = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "obsidian");
if (!existsSync(join(plugin, "package.json"))) process.exit(0);
const ready = ["react", "@base-ui/react", "motion"].every((name) => existsSync(join(plugin, "node_modules", name, "package.json")));
if (ready) process.exit(0);

console.log("网页要用插件源码，插件目录 obsidian/ 的依赖还没装：现在在那里跑 npm ci");
const result = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], {
  cwd: plugin,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
