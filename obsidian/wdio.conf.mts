import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { env } from "node:process";
import { parseObsidianVersions } from "wdio-obsidian-service";
import { makeFixture } from "./tests/e2e/make-fixture.mts";
import { quietHooks } from "./tests/e2e/quiet.mts";

// 端到端测试：在 wdio-obsidian-service 下载的独立 Obsidian 里跑，测试库现造在 git 忽略的 .scratch 下，
// 绝不碰用户自己的库。安装包缓存在本目录的 .obsidian-cache（git 忽略），首次运行会下载。
const vault = path.resolve(".scratch/e2e-vault");
makeFixture(vault);
mkdirSync(path.resolve(".scratch/screenshots"), { recursive: true });

const cacheDir = path.resolve(env.OBSIDIAN_CACHE ?? ".obsidian-cache");
// 默认测用户现用的 1.13.7（也是 minAppVersion）；要换版本设 OBSIDIAN_VERSIONS="latest/latest"
const versions = await parseObsidianVersions(env.OBSIDIAN_VERSIONS ?? "1.13.7/1.13.7", { cacheDir });

export const config: WebdriverIO.Config = {
  ...quietHooks,
  runner: "local",
  framework: "mocha",
  specs: ["./tests/e2e/**/*.e2e.ts"],
  maxInstances: 1,
  capabilities: versions.map<WebdriverIO.Capabilities>(([appVersion, installerVersion]) => ({
    browserName: "obsidian",
    "wdio:obsidianOptions": {
      appVersion,
      installerVersion,
      plugins: ["./dist"],
      vault: path.relative(process.cwd(), vault)
    }
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
