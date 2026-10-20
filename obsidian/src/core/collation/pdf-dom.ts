/**
 * 高亮框计算：把文字层里匹配到的字符区间换成页面上的矩形。
 *
 * 移植自 HongdongLee/obsidian-pdf-collation 的 src/pdf-dom.ts
 * （https://github.com/HongdongLee/obsidian-pdf-collation，MIT License，Copyright (c) 2026 lihaodong，
 * 全文见仓库根目录 THIRD_PARTY_NOTICES.md）。
 * 取了 mergeLineBoxes 与 computeSliceHighlightBoxes 的 DOM Range 量法。本插件的改动：
 *   - 文字层用 Obsidian 内置 PDF 视图（PDF.js）自己画的 span，不另建；
 *   - 量不到 Range 时，退回按 span 方框与字符比例插值（原版退回 PDF 坐标换算）。
 */

export interface HighlightBox {
  left: number
  top: number
  width: number
  height: number
}

export interface SpanSlice {
  /** 文字层里第几个 span */
  spanIndex: number
  startOffset: number
  endOffset: number
}

/**
 * 合并同一水平行内相邻或重叠的高亮矩形，避免知网 PDF 标点拆碎成十几个零散小框
 */
export function mergeLineBoxes(boxes: HighlightBox[]): HighlightBox[] {
  if (boxes.length <= 1) return boxes
  const sorted = [...boxes].sort((a, b) => {
    const dy = a.top - b.top
    if (Math.abs(dy) > Math.min(a.height, b.height) * 0.55) return dy
    return a.left - b.left
  })

  const merged: HighlightBox[] = [{ ...sorted[0] }]
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]
    const prev = merged[merged.length - 1]
    const sameRow = Math.abs(cur.top - prev.top) <= Math.min(cur.height, prev.height) * 0.55
    const gap = cur.left - (prev.left + prev.width)
    if (sameRow && gap <= Math.max(cur.height, prev.height) * 1.6) {
      const right = Math.max(prev.left + prev.width, cur.left + cur.width)
      const top = Math.min(prev.top, cur.top)
      const bottom = Math.max(prev.top + prev.height, cur.top + cur.height)
      prev.left = Math.min(prev.left, cur.left)
      prev.top = top
      prev.width = right - prev.left
      prev.height = bottom - top
    } else {
      merged.push({ ...cur })
    }
  }
  return merged
}

function firstTextNode(span: HTMLElement): Text | null {
  if (span.firstChild?.nodeType === Node.TEXT_NODE) return span.firstChild as Text
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT)
  return walker.nextNode() as Text | null
}

/**
 * 精确计算匹配切片在 PDF 页面容器内的像素矩形：优先使用真实 textLayer DOM Range，回退至按比例插值
 */
export function computeSliceHighlightBoxes(
  slices: readonly SpanSlice[],
  spans: readonly HTMLElement[],
  pageContainer: HTMLElement
): HighlightBox[] {
  const pageRect = pageContainer.getBoundingClientRect()
  const rawBoxes: HighlightBox[] = []

  for (const slice of slices) {
    let measuredFromDom = false
    const span = spans[slice.spanIndex]
    if (!span) continue
    const textNode = firstTextNode(span)
    if (span.isConnected && textNode && pageRect.width > 0) {
      const len = textNode.nodeValue?.length ?? 0
      const s = Math.max(0, Math.min(slice.startOffset, len))
      const e = Math.max(s, Math.min(slice.endOffset, len))
      if (e > s) {
        const range = document.createRange()
        range.setStart(textNode, s)
        range.setEnd(textNode, e)
        for (const r of Array.from(range.getClientRects())) {
          if (r.width > 0.5 && r.height > 0.5) {
            rawBoxes.push({
              left: r.left - pageRect.left,
              top: r.top - pageRect.top - 1,
              width: Math.max(3, r.width),
              height: r.height + 2,
            })
            measuredFromDom = true
          }
        }
      }
    }

    if (!measuredFromDom) {
      const r = span.getBoundingClientRect()
      const len = Math.max(1, span.textContent?.length ?? 1)
      const fracStart = Math.max(0, Math.min(1, slice.startOffset / len))
      const fracEnd = Math.max(fracStart, Math.min(1, slice.endOffset / len))
      if (r.width > 0 && r.height > 0) {
        rawBoxes.push({
          left: r.left - pageRect.left + r.width * fracStart,
          top: r.top - pageRect.top - 1,
          width: Math.max(4, r.width * (fracEnd - fracStart)),
          height: r.height + 2,
        })
      }
    }
  }

  return mergeLineBoxes(rawBoxes)
}
