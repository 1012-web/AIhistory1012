/** 判字面板的 Obsidian 视图（默认开在右侧栏），里面挂 React 的 SuspectPanel，数据与动作来自 SuspectDesk。 */
import { ItemView, type WorkspaceLeaf } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import type { SuspectDesk } from "./suspect-desk";
import { SuspectPanel } from "./ui";

export const SUSPECT_VIEW = "aps-suspects";

export class SuspectView extends ItemView {
  private root: Root | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly desk: SuspectDesk, private readonly reducedMotion: () => boolean) {
    super(leaf);
  }

  getViewType(): string {
    return SUSPECT_VIEW;
  }

  getDisplayText(): string {
    return "判字";
  }

  getIcon(): string {
    return "spell-check";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("aps-suspects-view");
    this.root = createRoot(this.contentEl.createDiv());
    this.unsubscribe = this.desk.subscribe(() => this.render());
    await this.desk.follow();
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const root = this.root;
    this.root = null;
    window.setTimeout(() => root?.unmount(), 0);
  }

  private render(): void {
    const desk = this.desk;
    this.root?.render(
      <SuspectPanel
        title={desk.list ? desk.list.basename.replace(/\.疑字清单$/, " · 疑字清单") : null}
        cards={desk.cards()}
        focusKey={desk.focusKey}
        focusSerial={desk.focusSerial}
        reducedMotion={this.reducedMotion()}
        onReveal={(key) => void desk.reveal(key)}
        onChoose={(key, text) => desk.decide(key, text)}
        onDoubt={(key) => desk.decide(key, null)}
        onWithdraw={(key) => desk.withdraw(key)}
        onOpenList={() => void desk.openList()}
        onOpenImage={(key) => void desk.openImage(key)}
      />
    );
  }
}
