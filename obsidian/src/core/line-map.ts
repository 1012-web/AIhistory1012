/**
 * 逐行对齐的缓存与取点：PDF 各页的文字层读一次就留着（换 PDF 才清）；正文各页段的对齐结果按正文版本缓存
 * （一编辑就是新版本，重算也只算眼前几页）。跟随时按正文偏移或 PDF 页取「前后几段」的对齐点，交给 line-sync.ts 插值。
 *
 * 文字层由调用方注入的 load 异步读取：还没读到的页先给按页的兜底点，读到后经 onLoaded 通知调用方再对一次。
 * 不碰 DOM 与 Obsidian。
 */
import { segmentIndexAt, segmentForPageOrGap, type PageSegment } from "./anchors";
import type { Parsed } from "./cm-sync";
import { alignSegment, fallbackPoints, type AlignPoint, type PdfPageLines, type SegmentAlignment } from "./line-align";

/** 一段最多跨几页去比（缺页按约定算进前一页段） */
const MAX_SPAN = 4;
/** 取点时前后各带几段 */
const RADIUS = 1;
/** 至少看过几页、一页都对不上，才判定这份 PDF 没有可用的文字层 */
const SAMPLE = 3;
/** 正文页段至少这么多字才拿来判断（插图页、空白页不算） */
const MIN_TEXT = 20;

/** none：没有文字层；mismatch：有文字层，但与正文对不上（乱码或错得太多）；vertical：竖排 */
export type TextLayerProblem = "none" | "mismatch" | "vertical";

export class LineMap {
  private readonly lines = new Map<number, PdfPageLines>();
  private readonly loading = new Set<number>();
  private cache = new WeakMap<Parsed, Map<string, AlignPoint[]>>();
  private source: string | null = null;
  private generation = 0;
  private tally: Record<TextLayerProblem | "aligned", number> = { aligned: 0, none: 0, mismatch: 0, vertical: 0 };
  private reported = false;
  /** 新读到一页文字层 */
  onLoaded: (() => void) | null = null;
  /** 看了几页都没有可用的文字层（每份 PDF 只报一次） */
  onProblem: ((problem: TextLayerProblem) => void) | null = null;

  constructor(private readonly load: (page: number) => Promise<PdfPageLines | null>) {}

  /** 配对的 PDF 变了（或换了窗格）：清掉文字层与对齐结果 */
  reset(source: string | null): void {
    if (source === this.source) return;
    this.source = source;
    this.clear();
  }

  /** 同一份 PDF 的文件改了（比如换成了文字层副本）：文字层重读，对齐重算 */
  clear(): void {
    this.generation += 1;
    this.lines.clear();
    this.loading.clear();
    this.cache = new WeakMap();
    this.tally = { aligned: 0, none: 0, mismatch: 0, vertical: 0 };
    this.reported = false;
  }

  /** 预读这几页的文字层 */
  prefetch(pages: readonly number[]): void {
    for (const page of pages) this.request(page);
  }

  /** 这一页的文字层是否已经读到（测试、状态用） */
  has(page: number): boolean {
    return this.lines.has(page);
  }

  private request(page: number): void {
    if (page < 1 || this.lines.has(page) || this.loading.has(page)) return;
    this.loading.add(page);
    const generation = this.generation;
    const done = (lines: PdfPageLines | null) => {
      if (generation !== this.generation) return;
      this.loading.delete(page);
      this.lines.set(page, lines ?? { page, lines: [] });
      this.onLoaded?.();
    };
    this.load(page).then(done, () => done(null));
  }

  /** 第 index 段覆盖的物理页：本页，加上它与下一个锚点之间缺的页 */
  private pagesOf(segments: readonly PageSegment[], index: number): number[] {
    const segment = segments[index];
    let next: PageSegment | undefined;
    for (let k = index + 1; k < segments.length && !next; k += 1) if (!segments[k].lead && segments[k].page > segment.page) next = segments[k];
    const last = next ? Math.min(next.page - 1, segment.page + MAX_SPAN - 1) : segment.page;
    const pages: number[] = [];
    for (let page = segment.page; page <= last; page += 1) pages.push(page);
    return pages;
  }

  /** 正文 [from, to) 与这几页的对齐点；文字层没读全时先给兜底点（不缓存），并去读 */
  private rangePoints(parsed: Parsed, key: string, from: number, to: number, pages: readonly number[]): AlignPoint[] {
    let cache = this.cache.get(parsed);
    if (!cache) {
      cache = new Map();
      this.cache.set(parsed, cache);
    }
    const hit = cache.get(key);
    if (hit) return hit;
    const ready = pages.map((page) => this.lines.get(page));
    if (ready.some((item) => !item)) {
      this.prefetch(pages);
      return fallbackPoints(from, to, pages.map((page) => this.lines.get(page) ?? { page, lines: [] }));
    }
    const loaded = ready as PdfPageLines[];
    const alignment = alignSegment(parsed.text, from, to, loaded);
    this.count(alignment, parsed.text.slice(from, to));
    const points = alignment.quality === "lines" ? alignment.points : fallbackPoints(from, to, loaded);
    cache.set(key, points);
    return points;
  }

  /** 第 index 段的对齐点。文件开头的引子（上个文件末页的延续）只在它确实属于前一页时才比 */
  segmentPoints(parsed: Parsed, index: number): AlignPoint[] {
    const segment = parsed.segments[index];
    if (!segment) return [];
    if (segment.lead) {
      const next = parsed.segments[index + 1];
      if (!next || next.page <= segment.page) return [];
      return this.rangePoints(parsed, `lead:${segment.from}:${segment.to}:${segment.page}`, segment.from, segment.to, [segment.page]);
    }
    return this.rangePoints(parsed, `${segment.from}:${segment.to}:${segment.page}`, segment.from, segment.to, this.pagesOf(parsed.segments, index));
  }

  /** 第 index 段及前后各一段的对齐点，按偏移排好 */
  private around(parsed: Parsed, index: number): AlignPoint[] {
    const out: AlignPoint[] = [];
    for (let k = Math.max(0, index - RADIUS); k <= Math.min(parsed.segments.length - 1, index + RADIUS); k += 1) out.push(...this.segmentPoints(parsed, k));
    return out;
  }

  /**
   * 偏移 offset 在章末注释区里时：它所在（或它前面最近）的那条脚注的区间与页（注文里的锚点）。
   * 不在注释区返回 null。
   */
  private noteAt(parsed: Parsed, offset: number): { from: number; to: number; page: number } | null {
    let note: [number, number] | null = null;
    for (const range of parsed.notes) {
      if (range[0] > offset) break;
      note = range;
    }
    if (!note) return null;
    if (offset >= note[1]) {
      // 注与注之间的空行：只有落在正文段的终点之后（正文段截到注释区开头）才算注释区
      const segment = parsed.segments[segmentIndexAt(parsed.segments, offset)];
      if (!segment || offset < segment.to) return null;
    }
    const [from, to] = note;
    const anchor = parsed.anchors.find((item) => item.footnote && item.from >= from && item.from < to);
    return anchor ? { from, to, page: anchor.page } : null;
  }

  /** 正文偏移 offset 附近的对齐点（正文 → PDF 用） */
  pointsNearOffset(parsed: Parsed, offset: number): AlignPoint[] {
    if (!parsed.segments.length) return [];
    const note = this.noteAt(parsed, offset);
    if (note) return this.rangePoints(parsed, `note:${note.from}:${note.to}:${note.page}`, note.from, note.to, [note.page]);
    return this.around(parsed, Math.max(0, segmentIndexAt(parsed.segments, offset)));
  }

  /** PDF 第 page 页附近的对齐点（PDF → 正文用）；本文件没有这一页返回空数组 */
  pointsNearPage(parsed: Parsed, page: number): AlignPoint[] {
    const found = segmentForPageOrGap(parsed.segments, page);
    if (!found) return [];
    return this.around(parsed, parsed.segments.indexOf(found.segment));
  }

  private count(alignment: SegmentAlignment, text: string): void {
    if (this.reported || text.replace(/<!--[\s\S]*?-->|\s/g, "").length < MIN_TEXT) return;
    const kind = alignment.quality === "lines" ? "aligned" : alignment.vertical ? "vertical" : alignment.total === 0 ? "none" : "mismatch";
    this.tally[kind] += 1;
    const problems: TextLayerProblem[] = ["none", "mismatch", "vertical"];
    if (this.tally.aligned > 0 || problems.reduce((sum, problem) => sum + this.tally[problem], 0) < SAMPLE) return;
    this.reported = true;
    this.onProblem?.(problems.reduce((best, problem) => (this.tally[problem] > this.tally[best] ? problem : best)));
  }
}
