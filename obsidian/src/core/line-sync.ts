/**
 * 按对齐点分段插值：正文的「阅读高度」↔ PDF 滚动容器里的文档高度（像素）。
 * 对齐点由 line-align.ts 给（逐行，或按页兜底），按正文偏移升序；两边的像素由视图量好，以函数传进来。
 *
 * 正文的阅读高度：以偏移所在显示行（折行后的一行）的正中为准，按该字在行内的横向位置在一个行距里摊开（见 cm-sync.ts），
 * 一行读到右端就接上下一行，所以同一显示行里的两个对齐点也分得开，PDF 跟着平滑移动。
 * 分段线性插值只有十来行，又要按页码判断「往回跳不插值」，没用 d3-scale 这类插值库。
 */
import { longestIncreasing, type AlignPoint } from "./line-align";

/** 正文偏移 → 阅读高度；量不到（阅读视图里还没渲染）返回 null */
export type MarkdownHeight = (offset: number) => number | null;
/** PDF（页，页内比例）→ 文档高度；量不到返回 null */
export type PdfHeight = (page: number, fraction: number) => number | null;

interface Measured {
  point: AlignPoint;
  markdown: number;
  pdf: number;
}

function measure(points: readonly AlignPoint[], markdownHeight: MarkdownHeight, pdfHeight: PdfHeight): Measured[] {
  const out: Measured[] = [];
  for (const point of points) {
    const markdown = markdownHeight(point.offset);
    const pdf = pdfHeight(point.page, point.fraction);
    if (markdown === null || pdf === null) continue;
    // 正文高度随偏移只增不减：前面估高了的点（没渲染的行按字数估）不要
    if (out.length && markdown < out[out.length - 1].markdown) continue;
    out.push({ point, markdown, pdf });
  }
  return out;
}

/** 最后一个 key ≤ value 的下标；都比 value 大返回 -1 */
function lastAtOrBelow(list: readonly Measured[], value: number, key: (item: Measured) => number): number {
  let low = 0;
  let high = list.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (key(list[mid]) <= value) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * 正文阅读高度 height → PDF 文档高度。落在两点之间按像素线性插值；
 * 往回跳（后一点页码更小，如正文读进章末注释；或双栏页从左栏底跳到右栏顶）不插值，停在前一点，到了后一点再跳；
 * 在第一个点之前、最后一个点之后贴住端点。没有能量的点返回 null。
 */
export function pdfTargetForMarkdown(points: readonly AlignPoint[], height: number, markdownHeight: MarkdownHeight, pdfHeight: PdfHeight): number | null {
  const list = measure(points, markdownHeight, pdfHeight);
  if (!list.length) return null;
  const index = lastAtOrBelow(list, height, (item) => item.markdown);
  if (index === -1) return list[0].pdf;
  const a = list[index];
  const b = list[index + 1];
  if (!b) return a.pdf;
  const forward = b.point.page >= a.point.page && b.pdf >= a.pdf;
  if (!forward || b.markdown - a.markdown < 0.5) return a.pdf;
  return a.pdf + ((b.pdf - a.pdf) * (height - a.markdown)) / (b.markdown - a.markdown);
}

/**
 * PDF 文档高度 height → 正文阅读高度。只用 PDF 高度也递增的那些点（最长递增子序列）：
 * 双栏页只认其中一栏，一样长时取先读的那栏。在第一个点之前、最后一个点之后贴住端点。
 */
export function markdownTargetForPdf(points: readonly AlignPoint[], height: number, markdownHeight: MarkdownHeight, pdfHeight: PdfHeight): number | null {
  // 倒着找「递减」的最长链再翻回来：一样长的链里取靠前的
  const list = longestIncreasing(measure(points, markdownHeight, pdfHeight).reverse(), (item) => -item.pdf).reverse();
  if (!list.length) return null;
  const index = lastAtOrBelow(list, height, (item) => item.pdf);
  if (index === -1) return list[0].markdown;
  const a = list[index];
  const b = list[index + 1];
  if (!b || b.pdf - a.pdf < 0.5) return a.markdown;
  return a.markdown + ((b.markdown - a.markdown) * (height - a.pdf)) / (b.pdf - a.pdf);
}
