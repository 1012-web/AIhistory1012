/**
 * 跟随的调度（计划「插件」第 3 条）：
 *   - 正文 → PDF：按页、页内按比例，基准线在视口距顶 35%；
 *   - 双向时 PDF → 正文，可跨文件（书内索引找文件，自动换过去）；
 *   - 领跑方是最近有用户输入的那一侧；程序滚动后对侧静默约 200 毫秒，免得互相拽（防回环）；
 *   - 单向时手动翻 PDF 只是 PDF 领跑、不带正文，回到正文一动就恢复正文带 PDF。
 * 判定用 S3 的 LeaderTracker、QuietWindow（sync-math.ts）。
 */
import { LeaderTracker, QuietWindow, type PagePoint, type Side } from "@/s3/core";
import type { SyncMode } from "@/s3/ui";

export type { SyncMode };

export interface SyncHost {
  mode: () => SyncMode;
  markdownPoint: () => (PagePoint & { printed: string | null }) | null;
  pdfPoint: () => PagePoint | null;
  scrollPdf: (point: PagePoint) => void;
  /** 正文滚到这页这处；本文件没有这一页时返回 false（上层去换文件） */
  scrollMarkdown: (point: PagePoint) => boolean;
  /** 换到含这一页的文件再滚；没有就什么都不做 */
  openPageInOtherFile: (point: PagePoint) => Promise<void>;
  onPage: (page: number, printed: string | null, from: Side) => void;
}

export class SyncController {
  readonly leader = new LeaderTracker();
  /** 正文被程序滚动后的静默 */
  readonly quietMarkdown = new QuietWindow();
  readonly quietPdf = new QuietWindow();
  private frame = 0;
  private pendingSide: Side | null = null;
  private switching = false;

  constructor(private readonly host: SyncHost, readonly quietMs = 200) {}

  input(side: Side): void {
    this.leader.input(side);
  }

  /** 滚动事件合并到下一帧处理 */
  scrolled(side: Side): void {
    this.pendingSide = side;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const pending = this.pendingSide;
      this.pendingSide = null;
      if (pending === "markdown") this.fromMarkdown();
      else if (pending === "pdf") void this.fromPdf();
    });
  }

  private fromMarkdown(): void {
    if (this.quietMarkdown.quiet) return;
    const point = this.host.markdownPoint();
    if (!point) return;
    this.host.onPage(point.page, point.printed, "markdown");
    if (this.host.mode() === "paused" || this.leader.leader !== "markdown") return;
    this.quietPdf.hold(this.quietMs);
    this.host.scrollPdf(point);
  }

  private async fromPdf(): Promise<void> {
    if (this.quietPdf.quiet || this.switching) return;
    const point = this.host.pdfPoint();
    if (!point) return;
    const follow = this.host.mode() === "both" && this.leader.leader === "pdf";
    if (!follow) {
      this.host.onPage(point.page, null, "pdf");
      return;
    }
    this.quietMarkdown.hold(this.quietMs);
    if (this.host.scrollMarkdown(point)) {
      const md = this.host.markdownPoint();
      this.host.onPage(point.page, md?.printed ?? null, "pdf");
      return;
    }
    this.switching = true;
    try {
      await this.host.openPageInOtherFile(point);
      this.host.onPage(point.page, this.host.markdownPoint()?.printed ?? null, "pdf");
    } finally {
      this.switching = false;
      this.quietMarkdown.hold(this.quietMs);
    }
  }

  /** 两边都由程序跳页（◀ ▶、输入页码、点锚点标签、搜索结果）：两边都静默一会儿 */
  holdBoth(): void {
    this.quietMarkdown.hold(this.quietMs * 2);
    this.quietPdf.hold(this.quietMs * 2);
  }

  dispose(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
  }
}
