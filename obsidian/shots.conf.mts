import * as path from "node:path";
import { env } from "node:process";
import { parseObsidianVersions } from "wdio-obsidian-service";
import { makeDemoVault } from "./tests/e2e/shots/make-demo-vault.mts";
import { quietHooks } from "./tests/e2e/quiet.mts";

// README 截图（不是测试）：独立下载的 Obsidian + 现造的演示库，不碰用户的库。
// 用法：先 npm run build，再
//   APS_DEMO_BOOK=<书文件夹> [APS_SHOTS=<输出目录>] [OBSIDIAN_CACHE=<安装包缓存>] npx wdio run ./shots.conf.mts
// 输出默认在 .scratch/shots/obsidian。
const vault = path.resolve(".scratch/demo-vault");
makeDemoVault(vault);
const cacheDir = path.resolve(env.OBSIDIAN_CACHE ?? ".obsidian-cache");
const versions = await parseObsidianVersions(env.OBSIDIAN_VERSIONS ?? "1.13.7/1.13.7", { cacheDir });

export const config: WebdriverIO.Config = {
  ...quietHooks,
  runner: "local",
  framework: "mocha",
  specs: ["./tests/e2e/shots/**/*.shots.ts"],
  maxInstances: 1,
  capabilities: versions.map<WebdriverIO.Capabilities>(([appVersion, installerVersion]) => ({
    browserName: "obsidian",
    "wdio:obsidianOptions": { appVersion, installerVersion, plugins: ["./dist"], vault: path.relative(process.cwd(), vault) }
  })),
  services: ["obsidian"],
  reporters: ["obsidian"],
  mochaOpts: { ui: "bdd", timeout: 180 * 1000 },
  waitforInterval: 250,
  waitforTimeout: 20 * 1000,
  logLevel: "warn",
  cacheDir,
  injectGlobals: false
};
