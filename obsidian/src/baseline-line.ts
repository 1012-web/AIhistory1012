/**
 * 阅读线：在一个窗格（正文或 PDF）里，按设置的比例标出两边对齐的那一高度。三种样式（设置「阅读线样式」）：
 * band 一条很淡的横带；line 一根细线、右端标「阅读线」；markers 只在左右两端各标一个小三角。
 * 位置与跟随时量的那条线一致：都用 baselineY(容器可见框, 比例)，正文取滚动容器、PDF 取 viewer 容器；
 * 比例由控制器按两窗格的重叠区间折算，所以两边落在同一屏幕高度。
 * 线挂在窗格的 containerEl 里，只显示、不拦鼠标；容器尺寸一变（拖动分栏、切换阅读/编辑）就重算。
 */
import { baselineY } from "./core/sync-math";
import type { BaselineStyle } from "./settings";

export class BaselineLine {
  private line: HTMLElement | null = null;
  private drawn: BaselineStyle | null = null;
  private observer: ResizeObserver | null = null;
  private observed: HTMLElement | null = null;

  /**
   * host：窗格的 containerEl（线挂在这里）；
   * measure：返回跟随时用来量阅读线的那个容器（正文的滚动容器、PDF 的 viewer 容器），量不到返回 null；
   * ratio：这一侧实际用的比例（控制器按两窗格重叠区间算，跟随与画线用同一个值），每次重算时现取；
   * style：当前样式，每次重算时现取（设置一改就换）
   */
  constructor(
    private readonly host: HTMLElement,
    private readonly measure: () => HTMLElement | null,
    private readonly ratio: () => number,
    private readonly style: () => BaselineStyle,
    /** 本窗格尺寸变了时调用：比例取决于两个窗格，所以由控制器把两条线一起重算；不给则只重算自己 */
    private readonly relayout?: () => void
  ) {}

  /** 显示（或按当前布局、样式更新） */
  show(): void {
    if (!this.line) {
      this.host.addClass("aps-baseline-host");
      this.line = this.host.createDiv({ cls: "aps-baseline", attr: { "aria-hidden": "true" } });
    }
    this.position();
  }

  hide(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.observed = null;
    this.line?.remove();
    this.line = null;
    this.drawn = null;
    this.host.removeClass("aps-baseline-host");
  }

  /** 按当前容器的可见框重算位置；样式换了就重画；容器换了（如编辑 ↔ 阅读）就改观察对象 */
  position(): void {
    if (!this.line) return;
    this.draw(this.style());
    const target = this.measure();
    if (!target) {
      this.line.hide();
      return;
    }
    this.watch(target);
    const box = target.getBoundingClientRect();
    const host = this.host.getBoundingClientRect();
    if (box.height <= 0 || box.width <= 0) {
      this.line.hide();
      return;
    }
    this.line.show();
    this.line.style.top = `${baselineY(box.top, box.height, this.ratio()) - host.top}px`;
    this.line.style.left = `${box.left - host.left}px`;
    this.line.style.width = `${box.width}px`;
  }

  private draw(style: BaselineStyle): void {
    if (!this.line || this.drawn === style) return;
    this.drawn = style;
    this.line.empty();
    this.line.className = `aps-baseline is-${style}`;
    if (style === "line") this.line.createSpan({ cls: "aps-baseline-label", text: "阅读线" });
    if (style === "markers") {
      this.line.createSpan({ cls: "aps-baseline-mark is-start" });
      this.line.createSpan({ cls: "aps-baseline-mark is-end" });
    }
  }

  private watch(target: HTMLElement): void {
    if (this.observed === target) return;
    const view = target.ownerDocument.defaultView;
    if (!view?.ResizeObserver) return;
    this.observer?.disconnect();
    this.observer = new view.ResizeObserver(() => (this.relayout ? this.relayout() : this.position()));
    this.observer.observe(target);
    this.observer.observe(this.host);
    this.observed = target;
  }
}
