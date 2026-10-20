/**
 * 监视书文件夹：Claude（或别的程序）在硬盘上改了 .md / .pdf / book.json，就推给所有打开着的网页。
 * 推的是「哪个文件、现在内容的 hash」；网页拿 hash 跟自己手里的比，相同就是自己刚存的，不用理。
 */
import { EventEmitter } from "node:events";
import type { Stats } from "node:fs";
import { relative, sep } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { allowedKind } from "./paths";
import { readSnapshot, TMP_SUFFIX } from "./files";

export interface ChangeEvent {
  type: "change" | "add" | "unlink";
  path: string;
  hash: string | null;
  /** Markdown 的新内容（小于 2 MB 时顺带送去，网页少跑一趟） */
  text?: string;
  mtimeMs?: number;
}

export class BookWatcher extends EventEmitter<{ change: [ChangeEvent] }> {
  private watcher: FSWatcher | null = null;

  constructor(private readonly root: string) {
    super();
    this.setMaxListeners(100);
  }

  private rel(abs: string): string {
    return relative(this.root, abs).split(sep).join("/");
  }

  /** chokidar 对同一路径先不带 stats 问一次、再带 stats 问一次；不知道是文件还是目录时先放行 */
  private ignored = (abs: string, stats?: Stats): boolean => {
    const rel = this.rel(abs);
    if (!rel) return false;
    if (rel.endsWith(TMP_SUFFIX)) return true;
    const parts = rel.split("/");
    if (parts.some((part) => part.startsWith(".") || part === "node_modules")) return true;
    if (!stats) return false;
    // _数据/ 只往下看 book.json 所在的那一层
    if (stats.isDirectory()) return parts[0] === "_数据" && parts.length > 1;
    return !allowedKind(rel, "read");
  };

  async start(): Promise<void> {
    this.watcher = watch(this.root, {
      ignoreInitial: true,
      ignored: this.ignored,
      depth: 3,
      atomic: true,
      // 编辑器分几次写完一个文件时，等它停 150 毫秒再报
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 40 },
    });
    const forward = (type: ChangeEvent["type"]) => async (abs: string) => {
      const path = this.rel(abs);
      if (type === "unlink") {
        this.emit("change", { type, path, hash: null });
        return;
      }
      try {
        if (path.toLowerCase().endsWith(".pdf")) {
          this.emit("change", { type, path, hash: null });
          return;
        }
        const snap = await readSnapshot(abs);
        const event: ChangeEvent = { type, path, hash: snap.hash, mtimeMs: snap.mtimeMs };
        if (snap.text.length < 2 * 1024 * 1024) event.text = snap.text;
        this.emit("change", event);
      } catch {
        // 文件刚被删或正被占用：下一次事件会再报
      }
    };
    this.watcher.on("add", forward("add")).on("change", forward("change")).on("unlink", forward("unlink"));
    await new Promise<void>((resolve) => this.watcher?.once("ready", () => resolve()));
  }

  async close(): Promise<void> {
    await this.watcher?.close();
  }
}
