/**
 * e2e 静默运行：Obsidian 窗口一出现就挪到屏幕外、不进任务栏，并关掉后台降速。
 * Windows 上没有 xvfb 那样的虚拟屏幕，只能这样避免测试窗口盖在用户正在用的界面上。
 * 挪到屏幕外的窗口在系统看来仍是「可见」的，定时器与 requestAnimationFrame 照常，不影响计时类用例；
 * 若改成最小化或隐藏，Chromium 会把定时器节流到分钟级，测试会卡死。
 * 想看测试过程时设 APS_E2E_SHOW=1。
 */
import { browser } from "@wdio/globals";
import { env } from "node:process";

async function hideWindows(): Promise<void> {
  if (env.APS_E2E_SHOW === "1") return;
  try {
    await browser.execute(() => {
      const req = (window as unknown as { require?: (name: string) => unknown }).require;
      if (!req) return;
      type Win = {
        getPosition(): [number, number];
        getSize(): [number, number];
        setPosition(x: number, y: number): void;
        setSize(width: number, height: number): void;
        setSkipTaskbar(skip: boolean): void;
        webContents: {
          setBackgroundThrottling(allowed: boolean): void;
          debugger: { isAttached(): boolean; attach(version: string): void; sendCommand(method: string, params: object): Promise<unknown> };
        };
      };
      const remote = req("@electron/remote") as {
        BrowserWindow: { getAllWindows(): Win[] };
        app: { on(event: string, fn: (event: unknown, win: Win) => void): void };
      };
      const quiet = (win: Win) => {
        // 已在屏幕外就不再动：每挪一次，窗口会因换到无显示器的区域而差 1 像素尺寸，
        // 触发一次 resize，按窗口尺寸重排的逻辑会被误触发
        if (win.getPosition()[0] > -10000) {
          const [width, height] = win.getSize();
          win.setPosition(-32000, -32000);
          win.setSize(width, height);
        }
        win.setSkipTaskbar(true);
        win.webContents.setBackgroundThrottling(false);
        // 屏幕外的窗口不是前台窗口，页面会认为自己没有焦点：编辑器光标进标签展开源码这类
        // 依赖焦点的行为就不发生。用 DevTools 协议的焦点模拟让页面照常以为有焦点，不抢真实键盘焦点
        try {
          const dbg = win.webContents.debugger;
          if (!dbg.isAttached()) dbg.attach("1.3");
          void dbg.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
        } catch {
          // 调试器接不上时只是焦点类用例可能失败，窗口照样挪走
        }
      };
      for (const win of remote.BrowserWindow.getAllWindows()) quiet(win);
      // 弹出窗口等后来开的窗口：出现即挪走（同一主进程只挂一次）
      const flag = globalThis as unknown as { __apsQuiet?: boolean };
      if (!flag.__apsQuiet) {
        flag.__apsQuiet = true;
        remote.app.on("browser-window-created", (_event, win) => quiet(win));
      }
    });
  } catch {
    // 窗口还没就绪或 Obsidian 正在重载：下一条用例前会再挪一次，不影响测试本身
  }
}

/** 并进各 wdio 配置：会话开始、每条用例前都挪一次（有的用例会重载 Obsidian 换出新窗口） */
export const quietHooks: Pick<WebdriverIO.Config, "before" | "beforeTest"> = {
  before: async () => hideWindows(),
  beforeTest: async () => hideWindows()
};
