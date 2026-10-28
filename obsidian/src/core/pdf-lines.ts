/**
 * PDF 文字层 → 一行一行：PDF.js getTextContent 给的文字块按内容流顺序（一般就是阅读顺序）归并成行，
 * 记下每行在页上的高度（页高的比例，与缩放无关）。纯函数：PDF.js 的对象由调用方（pdf-view.ts）取好传进来。
 */
import type { PdfLine } from "./line-align";

/** PDF.js TextItem 里用到的部分（TextMarkedContent 没有 str，跳过） */
export interface TextItemLike {
  str?: string;
  /** [a, b, c, d, e, f]：文字空间 → PDF 用户空间；(e, f) 是基线起点，(a, b) 沿字的走向，(c, d) 朝上 */
  transform?: number[];
  height?: number;
  hasEOL?: boolean;
  fontName?: string;
}

/** PDF.js PageViewport 里用到的部分（缩放取 1） */
export interface ViewportLike {
  height: number;
  convertToViewportPoint(x: number, y: number): number[];
}

export interface GroupedLines {
  lines: PdfLine[];
  /** 竖排，或页面转了 90 度、字成了竖行：不能按行高对齐 */
  vertical: boolean;
}

/** 字顶、字底相对基线的位置（字号的比例）：汉字字身大致如此，只用来判断哪些字同在一行 */
const ASCENT = 0.85;
const DESCENT = 0.15;

export function groupTextLines(items: readonly unknown[], styles: Readonly<Record<string, { vertical?: boolean }>> | undefined, viewport: ViewportLike): GroupedLines {
  const lines: PdfLine[] = [];
  let current: PdfLine | null = null;
  let counted = 0;
  let vertical = 0;
  const close = () => {
    if (current) lines.push(current);
    current = null;
  };
  for (const raw of items) {
    const item = raw as TextItemLike;
    if (typeof item.str !== "string" || !item.transform || item.transform.length < 6) continue;
    const [a, b, c, d, e, f] = item.transform;
    if (item.str.trim()) {
      counted += 1;
      const [x0, y0] = viewport.convertToViewportPoint(e, f);
      const [x1, y1] = viewport.convertToViewportPoint(e + a, f + b);
      const [x2, y2] = viewport.convertToViewportPoint(e + c, f + d);
      const size = Math.hypot(x2 - x0, y2 - y0) || item.height || 0;
      const sideways = Math.abs(y1 - y0) > Math.abs(x1 - x0);
      if (sideways || (item.fontName && styles?.[item.fontName]?.vertical)) vertical += 1;
      else if (size > 0 && viewport.height > 0) {
        const top = (y0 - size * ASCENT) / viewport.height;
        const bottom = (y0 + size * DESCENT) / viewport.height;
        const overlap = current ? Math.min(current.bottom, bottom) - Math.max(current.top, top) : 0;
        if (current && overlap > Math.min(current.bottom - current.top, bottom - top) * 0.5) {
          current.text += item.str;
          current.top = Math.min(current.top, top);
          current.bottom = Math.max(current.bottom, bottom);
        } else {
          close();
          current = { top, bottom, text: item.str };
        }
      }
    } else if (current) {
      current.text += item.str;
    }
    if (item.hasEOL) close();
  }
  close();
  return { lines, vertical: counted > 0 && vertical > counted / 2 };
}
