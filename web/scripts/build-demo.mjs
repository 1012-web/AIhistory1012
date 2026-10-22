// 构建线上演示站（GitHub Pages 上的 /demo/）：纯静态，没有本机服务。
//
//   npm run demo
//
// 做三件事：造演示书（public/demo/）→ next build 静态导出到 out/ → 整个拷进 ../site/demo/。
// 站点目录 site/ 由 .github/workflows/pages.yml 原样上传，主页是手写的 site/index.html。
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const site = join(web, "..", "site");
const out = join(web, "out");

function run(args, extraEnv = {}) {
  // 一律用 process.execPath 起 node，不经 shell：Windows 上 node 装在 "C:\Program Files\…" 里，
  // 走 cmd 会被空格拆开（npm 的 shell:true 也一样）
  const result = spawnSync(process.execPath, args, {
    cwd: web,
    stdio: "inherit",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ...extraEnv },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(["scripts/make-demo.mjs"]);
run(["scripts/ensure-plugin-deps.mjs"]);
run([join(web, "node_modules", "next", "dist", "bin", "next"), "build"], {
  AIH_DEMO: "1",
  NEXT_PUBLIC_AIH_DEMO: "1",
  NEXT_PUBLIC_AIH_BASE: "/demo",
});

rmSync(out, { recursive: false, force: true });
const target = join(site, "demo");
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(out, target, { recursive: true });
rmSync(out, { recursive: true, force: true });

console.log(`演示站已生成：site/demo/（打开 site/index.html 或跑 npm run demo:serve 预览）`);
