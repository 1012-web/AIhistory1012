import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // 与 tsconfig.json 的 paths 保持一致
    alias: [
      { find: /^@plugin\/(.*)$/, replacement: resolve(here, "../obsidian/$1") },
      { find: /^@\/(.*)$/, replacement: resolve(here, "src/$1") },
    ],
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
