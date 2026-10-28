/**
 * 配对：一本书 = 一个 PDF + 多个 Markdown。
 *
 * 找 PDF 依次看：frontmatter `pdf` → 本文件夹或上一级的 `_数据/book.json` → 本文件夹或上一级里唯一的 PDF
 * （`X.pdf` 与 `X.文字层.pdf` 成对时算一份，取文字层副本）→ 同名 PDF。
 * 书的成员：book.json 列了文件就照它，否则是书文件夹里配到同一个 PDF 的全部 Markdown（无锚点的目录、索引也算）。
 */
import { TFile, TFolder, type App } from "obsidian";
import { buildBookIndex, indexEntry, type BookIndex } from "./core/book-index";

import { BOOK_JSON, DATA_DIR, TEXT_LAYER_SUFFIX, uniquePdf as uniqueByPath, type BookJson, type PairSource } from "./core/pairing";
import { linkpathOf } from "./core/frontmatter";

export { BOOK_JSON, DATA_DIR, TEXT_LAYER_SUFFIX, linkpathOf, type BookJson, type PairSource };

export interface Pairing {
  pdf: TFile;
  source: PairSource;
  /** 书文件夹（库内路径） */
  root: string;
}

export interface Book {
  pdf: TFile;
  root: string;
  members: TFile[];
  index: BookIndex;
  /** 每个成员的正文（读索引时顺带留下，跟随时按页查段要用） */
  texts: Map<string, string>;
}

function joinPath(root: string, relative: string): string {
  const clean = relative.replace(/\\/g, "/").replace(/^\.\//, "");
  return root ? `${root}/${clean}` : clean;
}

function parentPath(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

/**
 * 疑字链接里的 file：书在库里时是库内路径；书不在登记过的库里时是「书文件夹/文件名」，
 * 按约定在当前库里找路径以它结尾的文件。
 */
export function findNote(app: App, path: string): TFile | null {
  const vault = app.vault;
  const direct = vault.getAbstractFileByPath(path) ?? vault.getAbstractFileByPath(`${path}.md`);
  if (direct instanceof TFile) return direct;
  const tail = `/${path}`;
  return vault.getMarkdownFiles().find((file) => file.path.endsWith(tail)) ?? null;
}

/** 一组 PDF 里挑「唯一」的那份：只有一份就是它；原件与文字层副本成对时取副本 */
export function uniquePdf(pdfs: TFile[]): TFile | null {
  return uniqueByPath(pdfs, (pdf) => pdf.path);
}

export class Pairer {
  private readonly bookJsonCache = new Map<string, { mtime: number; data: BookJson | null }>();

  constructor(private readonly app: App) {}

  /** 书文件夹候选：本文件夹、上一级 */
  private folders(file: TFile): string[] {
    const here = file.parent?.path ?? "";
    const normalized = here === "/" ? "" : here;
    const out = [normalized];
    if (normalized) out.push(parentPath(normalized));
    return out;
  }

  async readBookJson(root: string): Promise<BookJson | null> {
    const file = this.app.vault.getAbstractFileByPath(joinPath(root, BOOK_JSON));
    if (!(file instanceof TFile)) return null;
    const cached = this.bookJsonCache.get(file.path);
    if (cached && cached.mtime === file.stat.mtime) return cached.data;
    let data: BookJson | null = null;
    try {
      const parsed: unknown = JSON.parse(await this.app.vault.cachedRead(file));
      data = parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      data = null;
    }
    this.bookJsonCache.set(file.path, { mtime: file.stat.mtime, data });
    return data;
  }

  private pdfAt(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile && file.extension.toLowerCase() === "pdf" ? file : null;
  }

  private pdfsIn(folderPath: string): TFile[] {
    const folder = folderPath ? this.app.vault.getAbstractFileByPath(folderPath) : this.app.vault.getRoot();
    if (!(folder instanceof TFolder)) return [];
    return folder.children.filter((child): child is TFile => child instanceof TFile && child.extension.toLowerCase() === "pdf");
  }

  async resolve(file: TFile): Promise<Pairing | null> {
    const folders = this.folders(file);
    const frontmatter: Record<string, unknown> | undefined = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const linkpath = linkpathOf(frontmatter?.pdf);
    if (linkpath) {
      const target = this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
      if (target instanceof TFile && target.extension.toLowerCase() === "pdf") {
        return { pdf: target, source: "frontmatter", root: await this.bookRootFor(file, folders) };
      }
    }
    for (const root of folders) {
      const book = await this.readBookJson(root);
      if (book?.pdf) {
        const pdf = this.pdfAt(joinPath(root, book.pdf));
        if (pdf) return { pdf, source: "book.json", root };
      }
    }
    for (const root of folders) {
      const pdf = uniquePdf(this.pdfsIn(root));
      if (pdf) return { pdf, source: "folder", root };
    }
    const sameName = this.app.vault.getFiles().find((candidate) => candidate.extension.toLowerCase() === "pdf"
      && (candidate.basename === file.basename || candidate.basename === `${file.basename}${TEXT_LAYER_SUFFIX}`));
    if (sameName) return { pdf: sameName, source: "same-name", root: folders[0] };
    return null;
  }

  /** frontmatter 配对时书文件夹：有 book.json 的那一级，否则本文件夹 */
  private async bookRootFor(file: TFile, folders: string[]): Promise<string> {
    for (const root of folders) if (await this.readBookJson(root)) return root;
    return folders[0];
  }

  /** 书文件夹下（不进 `_数据`，只看本级）的 Markdown */
  private markdownIn(root: string): TFile[] {
    const folder = root ? this.app.vault.getAbstractFileByPath(root) : this.app.vault.getRoot();
    if (!(folder instanceof TFolder)) return [];
    return folder.children.filter((child): child is TFile => child instanceof TFile && child.extension === "md");
  }

  async book(file: TFile): Promise<Book | null> {
    const pairing = await this.resolve(file);
    if (!pairing) return null;
    const json = await this.readBookJson(pairing.root);
    let order: string[] | null = null;
    let members: TFile[] = [];
    if (json?.files?.length) {
      order = json.files
        .map((entry) => (typeof entry === "string" ? entry : entry.path ?? entry.file ?? ""))
        .filter(Boolean)
        .map((relative) => joinPath(pairing.root, relative));
      if (json.indexNote) order.push(joinPath(pairing.root, json.indexNote));
      members = order.map((path) => this.app.vault.getAbstractFileByPath(path)).filter((item): item is TFile => item instanceof TFile && item.extension === "md");
    } else {
      for (const candidate of this.markdownIn(pairing.root)) {
        if (candidate.path === file.path) {
          members.push(candidate);
          continue;
        }
        const other = await this.resolve(candidate);
        if (other?.pdf.path === pairing.pdf.path) members.push(candidate);
      }
    }
    if (!members.some((member) => member.path === file.path)) members.push(file);
    const texts = new Map<string, string>();
    for (const member of members) texts.set(member.path, await this.app.vault.cachedRead(member));
    const offset = typeof json?.printedPageOffset === "number" ? json.printedPageOffset : null;
    const entries = members.map((member) => indexEntry(member.path, texts.get(member.path) ?? "", offset));
    return { pdf: pairing.pdf, root: pairing.root, members, index: buildBookIndex(pairing.pdf.path, pairing.root, entries, order, offset), texts };
  }

  /** 手动绑定：写进这些文件的 frontmatter `pdf` */
  async bind(files: TFile[], pdf: TFile): Promise<void> {
    for (const file of files) {
      const linktext = this.app.metadataCache.fileToLinktext(pdf, file.path, false);
      await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
        frontmatter.pdf = `[[${linktext}]]`;
      });
    }
  }

  /** 手动绑定时列给用户确认的清单：书文件夹里的全部 Markdown */
  bindCandidates(file: TFile): TFile[] {
    const root = file.parent?.path === "/" ? "" : file.parent?.path ?? "";
    const list = this.markdownIn(root);
    return list.length ? list : [file];
  }
}
