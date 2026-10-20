import { defineConfig, devices } from "@playwright/test";

// README 截图（不是测试）。用法：先 npm run build，再
//   APS_DEMO_BOOK=<书文件夹> [APS_SHOTS=<输出目录>] npx playwright test -c shots.config.ts
// 输出默认在 .scratch/shots/web。
export default defineConfig({
  testDir: "tests/shots",
  testMatch: "**/*.shots.ts",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { ...devices["Desktop Chrome"], trace: "retain-on-failure" },
});
