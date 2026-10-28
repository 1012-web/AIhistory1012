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

/** 笔记 frontmatter 的 pdf 链接（linkpath，`[[]]` 里那段）是不是指着 path 这份 PDF：带文件夹的比路径结尾，只写文件名的比文件名，`.pdf` 可省 */
export function linkPointsTo(linkpath: string, path: string): boolean {
  const link = linkpath.replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
  const target = path.toLowerCase();
  const withExt = /\.pdf$/.test(link) ? link : `${link}.pdf`;
  if (withExt.includes("/")) return target === withExt || target.endsWith(`/${withExt}`);
  return target.slice(target.lastIndexOf("/") + 1) === withExt;
}

export interface PdfSighting {
  path: string;
  size: number;
  /** 毫秒时间戳 */
  at: number;
}

export interface PdfMove {
  from: string;
  to: string;
}

/**
 * 在 Obsidian 外改名、移动 PDF，库里只看到「少了一份」「多了一份」，不是改名。
 * 两件事相隔不到 windowMs、文件大小一样，就当是同一份挪了地方。先后顺序不论（跨盘移动可能先建后删）。
 */
export class PdfMoveDetector {
  private readonly seen: Record<"deleted" | "created", PdfSighting[]> = { deleted: [], created: [] };

  constructor(private readonly windowMs = 10_000) {}

  deletedPdf(sighting: PdfSighting): PdfMove | null {
    const other = this.take("created", sighting) ?? this.keep("deleted", sighting);
    return other ? { from: sighting.path, to: other.path } : null;
  }

  createdPdf(sighting: PdfSighting): PdfMove | null {
    const other = this.take("deleted", sighting) ?? this.keep("created", sighting);
    return other ? { from: other.path, to: sighting.path } : null;
  }

  /** 从另一边取走一份对得上的；对不上返回 null */
  private take(kind: "deleted" | "created", sighting: PdfSighting): PdfSighting | null {
    const fresh = (item: PdfSighting) => Math.abs(sighting.at - item.at) <= this.windowMs;
    this.seen.deleted = this.seen.deleted.filter(fresh);
    this.seen.created = this.seen.created.filter(fresh);
    const pool = this.seen[kind];
    const at = pool.findIndex((other) => other.size === sighting.size && other.path !== sighting.path);
    return at === -1 ? null : pool.splice(at, 1)[0];
  }

  private keep(kind: "deleted" | "created", sighting: PdfSighting): null {
    this.seen[kind].push(sighting);
    return null;
  }
}
