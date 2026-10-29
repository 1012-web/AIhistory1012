/**
 * 判字的宿主一侧：跟着当前这本书找到疑字清单，给面板与正文标记供条目；用户判定后改写三处：
 * 正文（那个字，打开着就走编辑器、可以 Ctrl+Z 撤回）、疑字清单（勾上或记存疑）、AI 校注（补一行）。
 * 每一处都是用户逐条点了才写；定位对不上原样的不写，提示去正文手改。
 */
import { MarkdownView, Notice, TFile, TFolder, type App } from "obsidian";
import { findNote } from "./pairing";
import type { SyncController } from "./controller";
import { editorViewOf, modeOf, parsedText } from "./markdown-pane";
import { appendNote, asNow, bookNameOf, clearInList, EMPTY_MARK, locateItem, markInList, notesPathFor, parseSuspectList, pickSidecar, removeNotes, today, type SuspectItem } from "./core/suspects";
import { pushSuspectMarks, type SuspectMark } from "./suspect-ext";
import type { SuspectCard } from "./ui";

export interface SuspectDeskHost {
  app: App;
  controller: SyncController;
  marksEnabled: () => boolean;
}

/** 条目的稳定键：有编号用编号，否则用行号（只在这份清单里有效） */
export function keyOf(item: SuspectItem): string {
  return item.id ?? `line:${item.line}`;
}

function fileNames(folder: TFolder): string[] {
  return folder.children.filter((child) => child instanceof TFile).map((child) => child.name);
}

function shown(text: string): string {
  return text || EMPTY_MARK;
}

export class SuspectDesk {
  list: TFile | null = null;
  items: SuspectItem[] = [];
  private readonly listeners = new Set<() => void>();
  private markTimer: number | null = null;
  /** 面板以外（正文卡片）要求面板看某一条 */
  focusKey: string | null = null;
  focusSerial = 0;
  onShowInPanel: (() => void) | null = null;

  constructor(private readonly host: SuspectDeskHost) {}

  private get app(): App {
    return this.host.app;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** 控制器换了书：换成那本书的清单（没有书时保留原来的，面板照样能用） */
  async follow(): Promise<void> {
    const book = this.host.controller.book;
    if (!book) return;
    const list = this.findList(book.root);
    if (list?.path === this.list?.path) return;
    this.list = list;
    await this.reload();
  }

  private findList(root: string): TFile | null {
    const folder = root ? this.app.vault.getAbstractFileByPath(root) : this.app.vault.getRoot();
    if (!(folder instanceof TFolder)) return null;
    const name = pickSidecar(fileNames(folder), "list");
    const list = name ? folder.children.find((child) => child.name === name) : null;
    return list instanceof TFile ? list : null;
  }

  async reload(): Promise<void> {
    this.items = this.list ? parseSuspectList(await this.app.vault.read(this.list)) : [];
    this.notify();
    this.refreshMarks();
  }

  /** 库里有文件改了：是清单就重读；是正文就稍后重算标记（外部改动后编辑器会整篇换内容） */
  onFileChanged(file: TFile): void {
    if (file.path === this.list?.path) {
      void this.reload();
      return;
    }
    if (this.items.some((item) => this.resolveNote(item.link.file)?.path === file.path)) this.scheduleMarks();
  }

  resolveNote(path: string): TFile | null {
    return findNote(this.app, path);
  }

  itemFor(key: string): SuspectItem | null {
    return this.items.find((item) => keyOf(item) === key) ?? null;
  }

  /**
   * 原页截图：清单里可能写库内完整路径，也可能是只有文件名的 ![[C00224.png]]（图在 _数据/疑字图/ 里）。
   * 先按路径找，找不到再按 Obsidian 解析链接的规矩从清单所在处找。
   */
  private imageFile(link: string | null): TFile | null {
    if (!link) return null;
    const path = link.split("|")[0].trim();
    const direct = this.app.vault.getAbstractFileByPath(path);
    if (direct instanceof TFile) return direct;
    return this.app.metadataCache.getFirstLinkpathDest(path, this.list?.path ?? "");
  }

  cards(): SuspectCard[] {
    return this.items.map((item) => {
      const image = this.imageFile(item.image);
      return {
        key: keyOf(item),
        id: item.id,
        page: item.link.page,
        kind: item.kind,
        before: item.display?.before ?? "",
        current: item.link.text,
        after: item.display?.after ?? "",
        readings: item.readings,
        note: item.note,
        image: image instanceof TFile ? this.app.vault.getResourcePath(image) : null,
        state: item.state,
        chosen: item.chosen
      };
    });
  }

  async openList(): Promise<void> {
    if (this.list) await this.app.workspace.getLeaf("tab").openFile(this.list);
  }

  async openImage(key: string): Promise<void> {
    const file = this.imageFile(this.itemFor(key)?.image ?? null);
    if (file) await this.app.workspace.getLeaf("tab").openFile(file);
  }

  showInPanel(key: string): void {
    this.focusKey = key;
    this.focusSerial += 1;
    this.onShowInPanel?.();
    this.notify();
  }

  /** 跳到原页、正文选中这个字；焦点不离开面板 */
  async reveal(key: string): Promise<void> {
    const found = this.itemFor(key);
    if (!found) return;
    // 判过并改了字的，正文里现在是定作的字
    const item = asNow(found);
    const note = this.resolveNote(item.link.file);
    await this.host.controller.openSuspectLink(note ? { ...item.link, file: note.path } : item.link, { focus: false });
  }

  // ---------- 判定 ----------

  /**
   * chosen 为 null 表示存疑；返回是否写成。
   * 判过的再判：按正文现在的字（上次定作的）定位，校注里这一条的旧行换成新的一行（原字仍记清单上的现字）。
   * 改过字的又记存疑：正文先改回原字，免得清单说「没判」而正文已改。
   */
  async decide(key: string, chosen: string | null): Promise<boolean> {
    const item = this.itemFor(key);
    const list = this.list;
    if (!item || !list) return false;
    const label = item.id ?? "这一条";
    const note = this.resolveNote(item.link.file);
    const now = asNow(item);
    const target = chosen ?? item.link.text;
    if (target !== now.link.text) {
      if (!note) {
        new Notice(`找不到笔记：${item.link.file}`);
        return false;
      }
      if (!(await this.replaceInNote(note, now, target))) return false;
    }
    if (!(await this.writeList(list, label, (text) => markInList(text, item, chosen, today())))) return false;
    await this.writeNotes(list, item, note, chosen);
    await this.reload();
    if (chosen === null) new Notice(`${label} 记为存疑`);
    else if (chosen === item.link.text) new Notice(`${label} 维持「${shown(chosen)}」`);
    else new Notice(`${label}：「${shown(item.link.text)}」改作「${shown(chosen)}」`);
    return true;
  }

  /** 撤回判定：正文改回清单上的现字，清单这一条回到没判，校注里这一条的行删掉 */
  async withdraw(key: string): Promise<boolean> {
    const item = this.itemFor(key);
    const list = this.list;
    if (!item || !list) return false;
    const label = item.id ?? "这一条";
    if (item.state === "open") {
      new Notice(`${label} 还没判，不用撤回`);
      return false;
    }
    const note = this.resolveNote(item.link.file);
    const now = asNow(item);
    if (now !== item && !(note && (await this.replaceInNote(note, now, item.link.text)))) return false;
    if (!(await this.writeList(list, label, (text) => clearInList(text, item)))) return false;
    await this.writeNotes(list, item, note, null);
    await this.reload();
    new Notice(`${label} 已撤回：正文是「${shown(item.link.text)}」，回到没判`);
    return true;
  }

  private async writeList(list: TFile, label: string, edit: (text: string) => string | null): Promise<boolean> {
    let missing = false;
    await this.app.vault.process(list, (current) => {
      const next = edit(current);
      if (next === null) missing = true;
      return next ?? current;
    });
    if (missing) new Notice(`清单里没找到 ${label}（清单可能刚改过），清单未记；正文若已改，请用 Ctrl+Z 或手改回去`);
    return !missing;
  }

  private problem(item: SuspectItem, at: { exact: boolean; found: string } | null): string | null {
    const where = item.link.page ? `第 ${item.link.page} 页` : "正文";
    if (!at) return `${where}里没找到「${shown(item.link.text)}」，没有改；请到正文里手改`;
    if (!at.exact) return `${where}这里现在是「${shown(at.found)}」，不是应有的「${shown(item.link.text)}」（正文可能手改过），没有改；请到正文里手改`;
    return null;
  }

  /** 正文换字：开着的编辑器里直接改（进撤销历史），否则改文件 */
  private async replaceInNote(note: TFile, item: SuspectItem, chosen: string): Promise<boolean> {
    let view: MarkdownView | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!view && leaf.view instanceof MarkdownView && leaf.view.file?.path === note.path && modeOf(leaf.view) !== "preview") view = leaf.view;
    });
    const editorView = view as MarkdownView | null;
    if (editorView) {
      const editor = editorView.editor;
      const text = editor.getValue();
      const hit = locateItem(text, parsedText(text), item);
      const problem = this.problem(item, hit && { exact: hit.exact, found: text.slice(hit.from, hit.to) });
      if (problem || !hit) {
        new Notice(problem ?? "没有改");
        return false;
      }
      editor.replaceRange(chosen, editor.offsetToPos(hit.from), editor.offsetToPos(hit.to));
      return true;
    }
    let problem: string | null = null;
    await this.app.vault.process(note, (text) => {
      const hit = locateItem(text, parsedText(text), item);
      problem = this.problem(item, hit && { exact: hit.exact, found: text.slice(hit.from, hit.to) });
      if (problem || !hit) return text;
      return text.slice(0, hit.from) + chosen + text.slice(hit.to);
    });
    if (problem) new Notice(problem);
    return problem === null;
  }

  /** 校注：先删这一条的旧行；chosen 不为 null 时再补一行（原字是清单上的现字，即这条的净改动） */
  private async writeNotes(list: TFile, item: SuspectItem, note: TFile | null, chosen: string | null): Promise<void> {
    const path = notesPathFor(list.path, list.parent ? fileNames(list.parent) : []);
    const row = chosen === null ? null : { id: item.id, page: item.link.page, file: note?.name ?? item.link.file, from: item.link.text, to: chosen };
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, (text) => {
        const cleaned = removeNotes(text, item.id);
        return row ? appendNote(cleaned, row) : cleaned;
      });
      return;
    }
    if (!row) return;
    const about = bookNameOf(list.name);
    await this.app.vault.create(path, appendNote(`---\ntype: AI校注\nabout: ${about}\n---\n\n# ${about} · AI 校注\n`, row));
  }

  // ---------- 正文标记 ----------

  private scheduleMarks(): void {
    if (this.markTimer !== null) window.clearTimeout(this.markTimer);
    this.markTimer = window.setTimeout(() => {
      this.markTimer = null;
      this.refreshMarks();
    }, 300);
  }

  /** 给每个开着的编辑器算一遍标记（只标没判的与存疑的） */
  refreshMarks(): void {
    const enabled = this.host.marksEnabled();
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!(leaf.view instanceof MarkdownView) || !leaf.view.file) return;
      const cm = editorViewOf(leaf.view);
      if (!cm) return;
      pushSuspectMarks(cm, enabled ? this.marksFor(leaf.view.file, leaf.view.editor.getValue()) : []);
    });
  }

  private marksFor(file: TFile, text: string): SuspectMark[] {
    const mine = this.items.filter((item) => item.state !== "done" && this.resolveNote(item.link.file)?.path === file.path);
    if (!mine.length) return [];
    const parsed = parsedText(text);
    const marks: SuspectMark[] = [];
    for (const item of mine) {
      const hit = locateItem(text, parsed, item);
      if (hit?.exact) marks.push({ from: hit.from, to: hit.to, key: keyOf(item), doubt: item.state === "doubt" });
    }
    return marks;
  }

  /** 正文悬停卡片 */
  card(key: string, close: () => void): HTMLElement | null {
    const item = this.itemFor(key);
    if (!item) return null;
    const root = createDiv({ cls: "aps-suspect-tip" });
    root.createDiv({ cls: "aps-suspect-meta", text: [item.id, item.kind, item.link.page ? `PDF 第 ${item.link.page} 页` : null, item.state === "doubt" ? "存疑" : null].filter(Boolean).join(" · ") });
    const image = this.imageFile(item.image);
    if (image) {
      const strip = root.createDiv({ cls: "aps-suspect-strip", attr: { title: "点开看原图；左右拖动看整行" } });
      const img = strip.createEl("img", { attr: { src: this.app.vault.getResourcePath(image), alt: "原页截图" } });
      img.addEventListener("load", () => {
        strip.scrollLeft = strip.scrollWidth;
      });
      img.addEventListener("click", () => {
        close();
        void this.openImage(key);
      });
    }
    if (item.note) root.createEl("p", { cls: "aps-suspect-note", text: item.note });
    const run = (chosen: string | null) => {
      close();
      void this.decide(key, chosen);
    };
    const readings = root.createDiv({ cls: "aps-suspect-readings" });
    for (const reading of item.readings) {
      const button = readings.createEl("button", { cls: "aps-suspect-reading", attr: { type: "button" } });
      button.createSpan({ cls: "aps-suspect-source", text: reading.source });
      button.createSpan({ cls: "aps-suspect-glyph", text: shown(reading.text) });
      button.addEventListener("click", () => run(reading.text));
    }
    const form = root.createEl("form", { cls: "aps-suspect-custom" });
    const input = form.createEl("input", { attr: { placeholder: "自填", "aria-label": "自填读法" } });
    form.createEl("button", { text: "定作", attr: { type: "submit" } });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (input.value.trim()) run(input.value.trim());
    });
    const actions = root.createDiv({ cls: "aps-suspect-actions" });
    if (item.state === "doubt") {
      actions.createEl("button", { text: "撤回存疑", attr: { type: "button" } }).addEventListener("click", () => {
        close();
        void this.withdraw(key);
      });
    } else {
      actions.createEl("button", { text: "存疑", attr: { type: "button" } }).addEventListener("click", () => run(null));
    }
    actions.createEl("button", { text: "在判字面板里看", attr: { type: "button" } }).addEventListener("click", () => {
      close();
      this.showInPanel(key);
    });
    return root;
  }

  dispose(): void {
    if (this.markTimer !== null) window.clearTimeout(this.markTimer);
    this.listeners.clear();
  }
}
