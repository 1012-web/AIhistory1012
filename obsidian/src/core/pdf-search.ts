/**
 * PDF 繁简通搜：在 PDF 文字层里找词，繁体、简体、异体当同一个字，跨行、跨页也找得到。
 *
 * 规则照 Better Search Result Views（variants/search.ts 的 tokenize / queryChars）：
 * 原文切成「可比对的字」，空白与折行不算字（所以能跨行），每个字先 normalizeChar（全半角、大小写），
 * 再按异体折叠表取代表字；查询照同样规则切开、折叠，再逐字比对。对照表见 core/variants/（原样拷自该插件）。
 * 全书按页序连成一串，所以跨页的词也能命中（命中记在起始页）。
 */
import { normalizeChar } from "./variants/normalize";
import { UNIHAN_SEMANTIC, UNIHAN_TRAD_SIMP, UNIHAN_Z } from "./variants/unihan-variants";
import { VariantTable } from "./variants/variants";

/** 三档 Unihan 对照表；默认值照 Better Search Result Views */
export interface VariantOptions {
  /** 繁简对应（鄴／邺、於／于、後／后） */
  unihanTradSimp: boolean;
  /** 同字异写 */
  unihanZ: boolean;
  /** 语义异体（范围宽） */
  unihanSemantic: boolean;
}

export const DEFAULT_VARIANT_OPTIONS: VariantOptions = { unihanTradSimp: true, unihanZ: true, unihanSemantic: false };

const tableCache = new Map<string, VariantTable>();

/** 按勾选的档位建折叠表（同样的组合只建一次） */
export function buildVariantTable(options: VariantOptions): VariantTable {
  const key = `${+options.unihanTradSimp}${+options.unihanZ}${+options.unihanSemantic}`;
  let table = tableCache.get(key);
  if (!table) {
    table = new VariantTable();
    if (options.unihanTradSimp) table.addPairs(UNIHAN_TRAD_SIMP);
    if (options.unihanZ) table.addPairs(UNIHAN_Z);
    if (options.unihanSemantic) table.addPairs(UNIHAN_SEMANTIC);
    tableCache.set(key, table);
  }
  return table;
}

/** 一页文字切成的可比对单位：字（已归一、未折叠）与它在该页文字里的 [at, end) */
interface PageUnits {
  chars: string[];
  at: number[];
  end: number[];
}

/** 一页文字 → 可比对单位；空白与折行跳过（跨行能连上） */
export function pageUnits(text: string): PageUnits {
  const out: PageUnits = { chars: [], at: [], end: [] };
  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    if (!/\s/u.test(ch)) {
      for (const unit of normalizeChar(ch)) {
        if (/\s/u.test(unit)) continue;
        out.chars.push(unit);
        out.at.push(i);
        out.end.push(i + ch.length);
      }
    }
    i += ch.length;
  }
  return out;
}

/** 查询 → 要比对的字（与正文同样归一；空白去掉） */
export function queryUnits(query: string): string[] {
  const out: string[] = [];
  for (const ch of query) {
    if (/\s/u.test(ch)) continue;
    for (const unit of normalizeChar(ch)) if (!/\s/u.test(unit)) out.push(unit);
  }
  return out;
}

export interface PdfHit {
  /** 起始页（从 1 起） */
  page: number;
  /** 在起始页文字里的 [from, to)；跨页时 to 是该页末尾 */
  from: number;
  to: number;
  /** 起始页上命中的原文（高亮用） */
  text: string;
  /** 起始页上命中前后的原文（高亮消歧用） */
  before: string;
  after: string;
  /** 命中结束在哪页（跨页时比 page 大） */
  endPage: number;
}

const CONTEXT = 20;

/** 在各页文字里找 query；pages[i] 是第 i + 1 页的文字 */
export function searchPages(pages: readonly string[], query: string, table: VariantTable | null): PdfHit[] {
  const wanted = queryUnits(query).map((ch) => (table ? table.rep(ch) : ch));
  if (!wanted.length) return [];
  // 全书连成一串：每个单位记着页与页内位置
  const chars: string[] = [];
  const pageOf: number[] = [];
  const at: number[] = [];
  const end: number[] = [];
  pages.forEach((text, index) => {
    const units = pageUnits(text);
    for (let k = 0; k < units.chars.length; k += 1) {
      chars.push(table ? table.rep(units.chars[k]) : units.chars[k]);
      pageOf.push(index + 1);
      at.push(units.at[k]);
      end.push(units.end[k]);
    }
  });
  const hits: PdfHit[] = [];
  for (let i = 0; i + wanted.length <= chars.length; i += 1) {
    let ok = true;
    for (let k = 0; k < wanted.length; k += 1) {
      if (chars[i + k] !== wanted[k]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const last = i + wanted.length - 1;
    const page = pageOf[i];
    const text = pages[page - 1];
    // 起始页上的最后一个单位
    let lastOnPage = i;
    while (lastOnPage + 1 <= last && pageOf[lastOnPage + 1] === page) lastOnPage += 1;
    const from = at[i];
    const to = end[lastOnPage];
    hits.push({
      page,
      from,
      to,
      text: text.slice(from, to),
      before: text.slice(Math.max(0, from - CONTEXT), from),
      after: text.slice(to, to + CONTEXT),
      endPage: pageOf[last]
    });
    i = last;
  }
  return hits;
}

/** 宿主提供的 PDF 文字：页数与某页文字层的字（pdf.js getTextContent，hasEOL 处换行） */
export interface PdfTextSource {
  pageCount(): number;
  pageText(page: number): Promise<string>;
}

/** 一份 PDF 的文字缓存与查找；换了 PDF 就换一个实例 */
export class PdfFinder {
  private pages: string[] | null = null;
  private loading: Promise<string[]> | null = null;

  constructor(private readonly source: PdfTextSource) {}

  /** 取全书文字（只取一次）；onProgress(已取页数, 总页数) */
  async load(onProgress?: (done: number, total: number) => void): Promise<string[]> {
    if (this.pages) return this.pages;
    if (!this.loading) {
      this.loading = (async () => {
        const total = this.source.pageCount();
        const out: string[] = [];
        for (let page = 1; page <= total; page += 1) {
          out.push(await this.source.pageText(page));
          onProgress?.(page, total);
        }
        this.pages = out;
        return out;
      })();
    }
    return this.loading;
  }

  async search(query: string, options: VariantOptions, onProgress?: (done: number, total: number) => void): Promise<PdfHit[]> {
    const pages = await this.load(onProgress);
    return searchPages(pages, query, buildVariantTable(options));
  }
}
