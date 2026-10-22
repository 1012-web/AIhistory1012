import type { NextConfig } from "next";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** 演示站构建（scripts/build-demo.mjs 会设 AIH_DEMO=1）：静态导出，挂在站点 /demo/ 子路径下 */
const demo = process.env.AIH_DEMO === "1";

// 规矩：只当本机工作台的界面用；接口与文件监视在 server/ 里由自定义服务器直接处理（见 server/workbench.ts）。
// 核心逻辑引自插件源码（tsconfig 的 @core/*，在本目录之外），所以打包根设到上一级：
// 即仓库根（与 obsidian/ 同级）。
const nextConfig: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  turbopack: { root: resolve(here, "..") },
  outputFileTracingRoot: resolve(here, ".."),
  // 演示站没有服务端：导出成纯静态文件（public/ 与 _next/ 都跟着 basePath 走）
  ...(demo
    ? {
        output: "export" as const,
        basePath: "/demo",
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {}),
};

export default nextConfig;
