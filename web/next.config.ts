import type { NextConfig } from "next";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// 规矩：只当本机工作台的界面用；接口与文件监视在 server/ 里由自定义服务器直接处理（见 server/workbench.ts）。
// 核心逻辑引自插件源码（tsconfig 的 @core/*，在本目录之外），所以打包根设到上一级：
// 即仓库根（与 obsidian/ 同级）。
const nextConfig: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  turbopack: { root: resolve(here, "..") },
  outputFileTracingRoot: resolve(here, ".."),
};

export default nextConfig;
