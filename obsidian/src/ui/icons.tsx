/** 对话框、工具条用的小图标（自绘线条，不引图标库） */
import type { ReactElement } from "react";

/** 定位到当前位置：准星 */
export const LocateIcon = (): ReactElement => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
    <circle cx="8" cy="8" r="4.5" />
    <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" />
  </svg>
);

/** 钉住：图钉 */
export const PinIcon = (): ReactElement => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5" />
  </svg>
);

/** 打开 PDF：折角的一页纸 */
export const PdfIcon = (): ReactElement => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 1.75h5.25L12.5 5v9.25H4zM9 1.75V5.25h3.5M6 8.5h4.5M6 11h4.5" />
  </svg>
);

export const CheckIcon =(): ReactElement => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.5 8.5 6.5 11.5 12.5 5" />
  </svg>
);
