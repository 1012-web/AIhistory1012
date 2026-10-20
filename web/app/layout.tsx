import type { Metadata } from "next";
import "pdfjs-dist/web/pdf_viewer.css";
// S3 的设计变量（网页取值）与界面组件样式；见 src/s3/core.ts 的说明
import "@plugin/src/ui/tokens-web.css";
import "@plugin/src/ui/ui.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "AIhistory 工作台",
  description: "本机对照 PDF 与 Markdown",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
