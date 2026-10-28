/**
 * 配对：一本书 = 一个 PDF + 多个 Markdown。
 *
 * 找 PDF 依次看：frontmatter `pdf` → 本文件夹或上一级的 `_数据/book.json` → 本文件夹或上一级里唯一的 PDF
 * （`X.pdf` 与 `X.文字层.pdf` 成对时算一份，取文字层副本）→ 同名 PDF。
 * 书的成员：book.json 列了文件就照它，否则是书文件夹里配到同一个 PDF 的全部 Markdown（无锚点的目录、索引也算）。
 * frontmatter 或 book.json 写了 PDF、库里却没有（多半在 Obsidian 外改了名、挪了地方）：记成 broken，交给界面提示用户重新配对。
 */
import { TFile, TFolder, type App } from "obsidian";
import { buildBookIndex, indexEntry, type BookIndex } from "./core/book-index";

import { BOOK_JSON, DATA_DIR, linkPointsTo, TEXT_LAYER_SUFFIX, uniquePdf as uniqueByPath, type BookJson, type PairSource } from "./core/pairing";
import { linkpathOf } from "./core/frontmatter";

export { BOOK_JSON, DATA_DIR, TEXT_LAYER_SUFFIX, linkpathOf, type BookJson, type PairSource };

export interface Pairing {
  pdf: TFile;
  source: PairSource;
  /** 书文件夹（库内路径） */
  root: string;
}

/** 笔记写了、库里找不到的 PDF */
export interface BrokenLink {
  /** 写的是什么：frontmatter 的 linkpath，或 book.json 里的相对路径 */
  link: string;
  from: "frontmatter" | "book.json";
  /** 书文件夹（找到 book.json 的那一级，否则笔记所在文件夹） */
  root: string;
}

export interface Diagnosis {
  pairing: Pairing | null;
  broken: BrokenLink | null;
}

export interface Book {
  pdf: TFile;
  root: string;
  members: TFile[];
  index: BookIndex;
  /** 每个成员的正文（读索引时顺带留下，跟随时按页查段要用） */
  texts: Map<string, string>;
  /** 写的 PDF 找不到、靠后面的办法找到了这一份时，记下写的是什么 */
  broken: BrokenLink | null;
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
    return (await this.diagnose(file)).pairing;
  }

  /** 找 PDF，顺带记下写了却找不到的那个链接 */
  async diagnose(file: TFile): Promise<Diagnosis> {
    const folders = this.folders(file);
    let broken: BrokenLink | null = null;
    const frontmatter: Record<string, unknown> | undefined = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const linkpath = linkpathOf(frontmatter?.pdf);
    if (linkpath) {
      const root = await this.bookRootFor(file, folders);
      const target = this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
      if (target instanceof TFile && target.extension.toLowerCase() === "pdf") {
        return { pairing: { pdf: target, source: "frontmatter", root }, broken: null };
      }
      broken = { link: linkpath, from: "frontmatter", root };
    }
    for (const root of folders) {
      const book = await this.readBookJson(root);
      if (book?.pdf) {
        const pdf = this.pdfAt(joinPath(root, book.pdf));
        if (pdf) return { pairing: { pdf, source: "book.json", root }, broken };
        broken ??= { link: book.pdf, from: "book.json", root };
      }
    }
    for (const root of folders) {
      const pdf = uniquePdf(this.pdfsIn(root));
      if (pdf) return { pairing: { pdf, source: "folder", root }, broken };
    }
    const sameName = this.app.vault.getFiles().find((candidate) => candidate.extension.toLowerCase() === "pdf"
      && (candidate.basename === file.basename || candidate.basename === `${file.basename}${TEXT_LAYER_SUFFIX}`));
    if (sameName) return { pairing: { pdf: sameName, source: "same-name", root: folders[0] }, broken };
    return { pairing: null, broken };
  }

  /** frontmatter 的 pdf 指着 oldPath、现在又解析不到的笔记（PDF 被挪走或改名之后还指着旧名的） */
  notesPointingTo(oldPath: string): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((note) => {
      const linkpath = linkpathOf(this.app.metadataCache.getFileCache(note)?.frontmatter?.pdf);
      return !!linkpath && linkPointsTo(linkpath, oldPath) && !this.app.metadataCache.getFirstLinkpathDest(linkpath, note.path);
    });
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
    const { pairing, broken } = await this.diagnose(file);
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
    return { pdf: pairing.pdf, root: pairing.root, members, index: buildBookIndex(pairing.pdf.path, pairing.root, entries, order, offset), texts, broken };
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
