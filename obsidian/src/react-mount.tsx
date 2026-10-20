/** 在某个窗口的 document 里临时挂一个 React 对话框，关掉时卸载。 */
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { BindDialog, PagemarkDialog, type BindDialogProps, type PagemarkDialogProps } from "./ui";

export function mountDialog(doc: Document, render: (close: () => void) => ReactElement): () => void {
  const host = doc.body.createDiv({ cls: "aps-dialog-mount" });
  const root = createRoot(host);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    // 等 Base UI 收尾（焦点归还）后再卸载
    window.setTimeout(() => {
      root.unmount();
      host.remove();
    }, 0);
  };
  root.render(render(close));
  return close;
}

type Injected = "container" | "onClose";

export function openBindDialog(doc: Document, props: Omit<BindDialogProps, Injected>): void {
  mountDialog(doc, (close) => <BindDialog {...props} container={doc.body} onClose={close} />);
}

export function openPagemarkDialog(doc: Document, props: Omit<PagemarkDialogProps, Injected>): void {
  mountDialog(doc, (close) => <PagemarkDialog {...props} container={doc.body} onClose={close} />);
}

/** 在一个元素里挂 React 根，可反复 render；设置页的自绘块用 */
export function mountReact(element: HTMLElement): { render: (node: ReactElement) => void; unmount: () => void } {
  const root = createRoot(element);
  return {
    render: (node) => root.render(node),
    unmount: () => window.setTimeout(() => root.unmount(), 0)
  };
}
