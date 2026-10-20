import { defineConfig } from "vitest/config";

// 单测只测不碰 Obsidian 的纯函数（锚点、书内索引、比例换算、匹配、链接解析）。
export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] }
});
