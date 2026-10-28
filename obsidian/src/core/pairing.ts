/**
 * 配对用到的纯数据：book.json 的形状、文字层副本的命名、在一组 PDF 里挑唯一的那份。
 * 插件的 pairing.ts（连着 Obsidian 的 TFile）用这里。
 */
export const DATA_DIR = "_数据";
export const BOOK_JSON = `${DATA_DIR}/book.json`;
export const TEXT_LAYER_SUFFIX = ".文字层";

export type PairSource = "frontmatter" | "book.json" | "folder" | "same-name";

export interface BookJsonFile {
  path?: string;
  /** 第 1 版的写法 */
  file?: string;
  pdfPages?: [number, number];
  printedPages?: string;
}

export interface BookJson {
  version?: number;
  title?: string;
  pdf?: string;
  /** 第 2 版：有文字层副本时记原件 */
  originalPdf?: string;
  pageCount?: number;
  /** 第 2 版：索引笔记（不在 files 里，但也算这本书）。注意第 1 版的 `index` 是逐字映射索引，不是笔记 */
  indexNote?: string;
  index?: string;
  /** 第 2 版是 {path, pdfPages, printedPages}；也认纯字符串 */
  files?: Array<string | BookJsonFile>;
  printedPageOffset?: number;
}

function stem(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
}

/** 一组 PDF 里挑「唯一」的那份：只有一份就是它；原件与文字层副本成对时取副本 */
export function uniquePdf<T>(pdfs: T[], pathOf: (pdf: T) => string): T | null {
  if (pdfs.length === 1) return pdfs[0];
  if (pdfs.length === 2) {
    const [a, b] = pdfs;
    if (stem(pathOf(a)) === `${stem(pathOf(b))}${TEXT_LAYER_SUFFIX}`) return a;
    if (stem(pathOf(b)) === `${stem(pathOf(a))}${TEXT_LAYER_SUFFIX}`) return b;
  }
  return null;
}
