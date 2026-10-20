// 构建界面。关掉 Next.js 的匿名使用统计（它默认会联网上报），工作台不联网。
import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["next", "build"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
});
process.exit(result.status ?? 1);
