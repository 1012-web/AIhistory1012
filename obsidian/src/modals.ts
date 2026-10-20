import { FuzzySuggestModal, type App, type TFile } from "obsidian";

/** 挑一个 PDF */
export class PdfSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly onChoose: (file: TFile) => void) {
    super(app);
    this.setPlaceholder("选一个 PDF 配给这本书");
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles().filter((file) => file.extension.toLowerCase() === "pdf");
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onChoose(file);
  }
}

