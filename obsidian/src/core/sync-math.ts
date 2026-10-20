/**
 * 跟随用的比例换算。两边都换成「第几页 + 页内比例」再对齐：
 *   正文一侧：基准线（视口距顶 35%）落在哪个页段，在页段的像素高度里占多少；
 *   PDF 一侧：基准线落在哪一页的方框里，在页高里占多少。
 * 都是纯函数，坐标由调用方量好传进来。
 */

export interface PagePoint {
  page: number;
  /** 页内比例 0..1 */
  fraction: number;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 基准线在视口里的高度 */
export function baselineY(viewportTop: number, viewportHeight: number, ratio: number): number {
  return viewportTop + viewportHeight * clamp01(ratio);
}

/** y 在 [top, bottom) 里的比例；区间退化时给 0 */
export function fractionWithin(y: number, top: number, bottom: number): number {
  if (bottom - top <= 0.5) return 0;
  return clamp01((y - top) / (bottom - top));
}

/**
 * 把一个点滚到基准线：返回滚动量（加到 scrollTop 上）。
 * targetY 是目标点当前在屏幕上的高度。
 */
export function scrollDeltaToBaseline(targetY: number, viewportTop: number, viewportHeight: number, ratio: number): number {
  return targetY - baselineY(viewportTop, viewportHeight, ratio);
}

export interface PageBox {
  page: number;
  top: number;
  bottom: number;
}

/**
 * PDF 一侧：基准线落在哪页。页与页之间的空隙算下一页的开头；
 * 在第一页之上算第一页开头，在最后一页之下算最后一页结尾。
 */
export function pdfPointAt(boxes: PageBox[], y: number): PagePoint | null {
  if (!boxes.length) return null;
  const sorted = [...boxes].sort((a, b) => a.top - b.top);
  if (y < sorted[0].top) return { page: sorted[0].page, fraction: 0 };
  for (let index = 0; index < sorted.length; index += 1) {
    const box = sorted[index];
    if (y < box.bottom) return { page: box.page, fraction: fractionWithin(y, box.top, box.bottom) };
    const next = sorted[index + 1];
    if (next && y < next.top) return { page: next.page, fraction: 0 };
  }
  const last = sorted[sorted.length - 1];
  return { page: last.page, fraction: 1 };
}

/**
 * 文本内位置的「高度」：块（行）的顶 + 块内按字符比例插值。
 * 编辑器里一个长段落是一个块，锚点插在段中时，靠这个让页段的起止落在段落中间的大致高度。
 */
export function heightInBlock(pos: number, blockFrom: number, blockTo: number, blockTop: number, blockHeight: number): number {
  const length = blockTo - blockFrom;
  if (length <= 0) return blockTop;
  return blockTop + blockHeight * clamp01((pos - blockFrom) / length);
}

/** heightInBlock 的反函数：块里高度 h 对应的大致偏移 */
export function posInBlock(height: number, blockFrom: number, blockTo: number, blockTop: number, blockHeight: number): number {
  if (blockHeight <= 0) return blockFrom;
  return Math.round(blockFrom + (blockTo - blockFrom) * clamp01((height - blockTop) / blockHeight));
}

/** 防回环：程序滚动后对侧静默这段时间内的滚动事件。 */
export class QuietWindow {
  private until = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  hold(milliseconds: number): void {
    this.until = Math.max(this.until, this.now() + milliseconds);
  }

  get quiet(): boolean {
    return this.now() < this.until;
  }
}

export type Side = "markdown" | "pdf";

/**
 * 领跑方：最近有用户输入（滚轮、按键、指针）的那一侧。
 * 只有领跑方的滚动才带动对侧；手动翻 PDF 就让 PDF 领跑，正文的被动滚动不会把它拽回去。
 */
export class LeaderTracker {
  private side: Side = "markdown";
  private at = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  input(side: Side): void {
    this.side = side;
    this.at = this.now();
  }

  get leader(): Side {
    return this.side;
  }

  get lastInputAt(): number {
    return this.at;
  }
}
