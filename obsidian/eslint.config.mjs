import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// 官方审查规则的本地版本：提交社区目录前先在这里跑通。
export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*"]
        }
      }
    }
  },
  { ignores: ["dist/**", "node_modules/**", "tests/**", "vitest.config.ts", "esbuild.config.mjs", "wdio.conf.mts", ".scratch/**", ".obsidian-cache/**"] }
]);
