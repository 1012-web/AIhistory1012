import { defineConfig, devices } from "@playwright/test";

// 端到端：每个用例把 fixtures 里的书拷到临时目录，在本进程里起一个工作台（见 tests/e2e/fixtures.ts）。
// 先 npm run build（或让 startWorkbench 自动构建）。
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
});
