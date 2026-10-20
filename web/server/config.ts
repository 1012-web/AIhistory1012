/**
 * 用户配置文件：令牌、端口、界面设置，存在用户目录下，重启照用。
 *   Windows：%APPDATA%\AIhistory1012\workbench.json
 *   其他：~/.config/aihistory1012/workbench.json
 *   测试时可用环境变量 AIH_CONFIG_DIR 指到别处。
 * 令牌只在这个文件里：不打印、不进日志、不进仓库；接口也不把它交出去（设置接口只给端口与界面设置）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { makeToken } from "./guard";

export const DEFAULT_PORT = 4312;

export interface WorkbenchConfig {
  token: string;
  port: number;
  /** 网页的界面设置（布局、联动、外观、引导是否看过……），原样存，由网页解释 */
  prefs: Record<string, unknown>;
}

export function configDir(): string {
  if (process.env.AIH_CONFIG_DIR) return process.env.AIH_CONFIG_DIR;
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "AIhistory1012");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "aihistory1012");
}

export function configPath(): string {
  return join(configDir(), "workbench.json");
}

export class ConfigError extends Error {}

/** 读配置；没有就新建（生成令牌）。文件坏了不悄悄重建，明说让用户处理 */
export function loadConfig(path = configPath()): WorkbenchConfig {
  if (!existsSync(path)) {
    const fresh: WorkbenchConfig = { token: makeToken(), port: DEFAULT_PORT, prefs: {} };
    saveConfig(fresh, path);
    return fresh;
  }
  let parsed: Partial<WorkbenchConfig>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkbenchConfig>;
  } catch (error) {
    throw new ConfigError(`配置文件读不出来：${path}\n${(error as Error).message}\n请修好它，或删掉它让工作台重新生成（会换一个新令牌，旧的疑字链接网址要重新从启动命令打开一次）。`);
  }
  const config: WorkbenchConfig = {
    token: typeof parsed.token === "string" && parsed.token.length >= 16 ? parsed.token : makeToken(),
    port: validPort(parsed.port) ? parsed.port : DEFAULT_PORT,
    prefs: parsed.prefs && typeof parsed.prefs === "object" ? parsed.prefs : {},
  };
  if (config.token !== parsed.token || config.port !== parsed.port) saveConfig(config, path);
  return config;
}

export function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

export function saveConfig(config: WorkbenchConfig, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}
