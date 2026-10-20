/**
 * 文字匹配：选中的正文 ↔ PDF 文字层，以及补页码锚点时找每页开头。
 *
 * 移植自 HongdongLee/obsidian-pdf-collation 的 src/compare.ts
 * （https://github.com/HongdongLee/obsidian-pdf-collation，MIT License，Copyright (c) 2026 lihaodong，
 * 全文见仓库根目录 THIRD_PARTY_NOTICES.md）。
 * 取了 normalizeText、buildCharOriginMap、findBestNormalizedRange、matchSegmentSlices 与
 * autoInsertPagemarks 用到的 findPageStartNormIndex。本插件的改动：
 *   - 噪声区间加上 HTML 注释（物理页、印刷页锚点 `<!--pdf-page.N-->` `<!--p.M-->`）；
 *   - findPageStartNormIndex 导出，并多返回相似度，供补锚点的把握报告用；
 *   - SelectionContext 类型就地定义；去掉与 PDF textItems 对象相关的部分（本插件直接读文字层 DOM）。
 */

export interface SelectionContext {
  before?: string
  after?: string
  /** 选区在所属页里的相对位置 0..1，多处同名时用来消歧 */
  progress?: number
}

/**
 * 剔除校勘文本中的人工校按注记、Markdown 脚注引用与页标，避免干扰 PDF 原文匹配
 */
export function stripEditorialNoise(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, '') // aihistory：锚点注释
    .replace(/[［[【]\s*校(?:按|注|勘|改)[：:][^\n］\]】]*[］\]】]/g, '')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/\[p\.[^\]\n/]*\/[ \t]*pdf\.[^\]\n]*\]/gi, '')
    .replace(/\[(?:pdf|p)\.?[ \t]*\d+[^\]\n]*\]/gi, '')
}

function normalizeCharForMatch(ch: string): string {
  const code = ch.charCodeAt(0)
  const half = code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : ch
  const decomposed = half
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
  let out = ''
  for (const c of decomposed) {
    if (/[\p{Unified_Ideograph}a-z0-9]/u.test(c)) {
      out += c
    }
  }
  return out
}

/**
 * 归一化：抹平人工校订文本与 PDF 文字层之间的全半角括号、引号、破折号、标点、参考文献角标与空格差异
 */
export function normalizeText(s: string): string {
  const stripped = stripEditorialNoise(s).replace(
    /[［[][ \t]*\d{1,3}(?:[ \t]*[-,，][ \t]*\d{1,3})*[ \t]*[］\]][ \t]*\d*/g,
    ''
  )
  let out = ''
  for (const ch of stripped) {
    out += normalizeCharForMatch(ch)
  }
  if (out.length > 0) return out

  // 若输入仅含数字角标或特殊符号，回退保留基础字符
  let fallback = ''
  for (const ch of stripEditorialNoise(s)) {
    fallback += normalizeCharForMatch(ch)
  }
  return fallback
}

export interface CharOrigin {
  segIdx: number
  charIdx: number
  charLen?: number
  wordStart?: boolean
  wordEnd?: boolean
}

export interface SegmentSlice {
  segIdx: number
  startOffset: number
  endOffset: number
}

// aihistory：开头加了 HTML 注释（锚点）
const NOISE_SPAN_RE =
  /<!--[\s\S]*?-->|[［[【]\s*校(?:按|注|勘|改)[：:][^\n］\]】]*[］\]】]|\[\^[^\]]+\]|\[p\.[^\]\n/]*\/[ \t]*pdf\.[^\]\n]*\]|\[(?:pdf|p)\.?[ \t]*\d+[^\]\n]*\]|[［[][ \t]*\d{1,3}(?:[ \t]*[-,，][ \t]*\d{1,3})*[ \t]*[］\]][ \t]*\d*/gi

function isLatinAlnum(ch: string | undefined): boolean {
  return !!ch && /[a-z0-9]/i.test(ch)
}

/**
 * 将一组文本片段（如 PDF textItems 或 Markdown DOM Text 节点）归一化为连续字符串，
 * 同时记录每个归一化字符精确对应的源片段下标与字符偏移量，自动跳过校按/角标等噪声区间
 */
export function buildCharOriginMap(segments: readonly string[]): {
  norm: string
  origins: CharOrigin[]
} {
  let rawJoined = ''
  const rawMap: { segIdx: number; charIdx: number }[] = []
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx] || ''
    for (let charIdx = 0; charIdx < seg.length; charIdx++) {
      rawMap.push({ segIdx, charIdx })
    }
    rawJoined += seg
  }

  const skipped = new Uint8Array(rawJoined.length)
  for (const m of rawJoined.matchAll(NOISE_SPAN_RE)) {
    if (m.index != null) {
      skipped.fill(1, m.index, m.index + m[0].length)
    }
  }

  let norm = ''
  const origins: CharOrigin[] = []
  for (let i = 0; i < rawJoined.length; ) {
    const cp = rawJoined.codePointAt(i)!
    const chStr = String.fromCodePoint(cp)
    const charLen = chStr.length
    if (!skipped[i]) {
      const normalized = normalizeCharForMatch(chStr)
      if (normalized) {
        const prevRaw = i > 0 ? rawJoined[i - 1] : ''
        const nextRaw = i + charLen < rawJoined.length ? rawJoined[i + charLen] : ''
        const wordStart = !isLatinAlnum(prevRaw)
        const wordEnd = !isLatinAlnum(nextRaw)
        for (let k = 0; k < normalized.length; k++) {
          norm += normalized[k]
          origins.push({
            segIdx: rawMap[i].segIdx,
            charIdx: rawMap[i].charIdx,
            charLen,
            wordStart: k === 0 ? wordStart : false,
            wordEnd: k === normalized.length - 1 ? wordEnd : false,
          })
        }
      }
    }
    i += charLen
  }

  return { norm, origins }
}

function scoreContextOverlap(
  full: string,
  start: number,
  end: number,
  beforeNorm: string,
  afterNorm: string,
  progress?: number
): number {
  let score = 0
  if (beforeNorm) {
    const bSlice = beforeNorm.slice(-36)
    const leftWin = full.slice(Math.max(0, start - bSlice.length - 16), start)
    // 紧邻后缀直接重合权重最高（允许极小 0..2 字符间隙）
    for (let gap = 0; gap <= Math.min(2, leftWin.length); gap++) {
      const trimmedLeft = leftWin.slice(0, leftWin.length - gap)
      let suffixLen = 0
      const maxCheck = Math.min(bSlice.length, trimmedLeft.length)
      while (
        suffixLen < maxCheck &&
        bSlice[bSlice.length - 1 - suffixLen] === trimmedLeft[trimmedLeft.length - 1 - suffixLen]
      ) {
        suffixLen++
      }
      if (suffixLen >= 1) {
        score += suffixLen * 5 - gap * 2
        break
      }
    }
    for (let len = Math.min(bSlice.length, leftWin.length); len >= 2; len--) {
      if (leftWin.includes(bSlice.slice(-len))) {
        score += len * 4
        break
      }
    }
    for (let i = 0; i < bSlice.length - 1; i++) {
      if (leftWin.includes(bSlice.slice(i, i + 2))) score += 2
    }
  }
  if (afterNorm) {
    const aSlice = afterNorm.slice(0, 36)
    const rightWin = full.slice(end, Math.min(full.length, end + aSlice.length + 16))
    for (let gap = 0; gap <= Math.min(2, rightWin.length); gap++) {
      const trimmedRight = rightWin.slice(gap)
      let prefixLen = 0
      const maxCheck = Math.min(aSlice.length, trimmedRight.length)
      while (prefixLen < maxCheck && aSlice[prefixLen] === trimmedRight[prefixLen]) {
        prefixLen++
      }
      if (prefixLen >= 1) {
        score += prefixLen * 5 - gap * 2
        break
      }
    }
    for (let len = Math.min(aSlice.length, rightWin.length); len >= 2; len--) {
      if (rightWin.includes(aSlice.slice(0, len))) {
        score += len * 4
        break
      }
    }
    for (let i = 0; i < aSlice.length - 1; i++) {
      if (rightWin.includes(aSlice.slice(i, i + 2))) score += 2
    }
  }
  if (typeof progress === 'number' && Number.isFinite(progress) && full.length > 0) {
    const hitProgress = start / full.length
    const dist = Math.abs(hitProgress - progress)
    score += Math.round(Math.max(0, 1 - dist * 1.6) * 36)
  }
  return score
}

function orderedCharSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  const maxLen = Math.max(a.length, b.length)
  if (maxLen > 120) {
    const bigrams = new Set<string>()
    for (let i = 0; i < a.length - 1; i++) bigrams.add(a.slice(i, i + 2))
    if (bigrams.size === 0) return a === b ? 1 : 0
    let hits = 0
    for (let i = 0; i < b.length - 1; i++) {
      if (bigrams.has(b.slice(i, i + 2))) hits++
    }
    return hits / Math.max(1, maxLen - 1)
  }

  const m = a.length
  const n = b.length
  const dp = new Uint16Array(n + 1)
  for (let i = 1; i <= m; i++) {
    let prev = 0
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= n; j++) {
      const temp = dp[j]
      if (ca === b.charCodeAt(j - 1)) {
        dp[j] = prev + 1
      } else if (dp[j - 1] > dp[j]) {
        dp[j] = dp[j - 1]
      }
      prev = temp
    }
  }
  return dp[n] / maxLen
}

function countLanguageUnits(norm: string): number {
  let units = 0
  for (const ch of norm) {
    units += /\p{Unified_Ideograph}/u.test(ch) ? 1 : 0.35
  }
  return units
}

export interface RangeMatchResult {
  start: number
  end: number
  score: number
}

/**
 * 在归一化全文中结合上下文查找最佳匹配区间，支持多处重名消歧、异文夹逼定位与首尾锚点容错
 */
export function findBestNormalizedRange(
  full: string,
  queryNorm: string,
  beforeNorm = '',
  afterNorm = '',
  progress?: number,
  origins?: readonly CharOrigin[]
): RangeMatchResult | null {
  if (!full || !queryNorm) return null
  const isPureLatin = /^[a-z0-9]+$/.test(queryNorm)
  const units = countLanguageUnits(queryNorm)

  // Tier 1: 精确子串匹配（若同页出现多次，结合前后文与页内相对位置打分消歧）
  const exactHits: number[] = []
  let pos = 0
  while (pos <= full.length - queryNorm.length) {
    const idx = full.indexOf(queryNorm, pos)
    if (idx === -1) break
    exactHits.push(idx)
    pos = idx + 1
  }

  if (exactHits.length >= 1) {
    let bestStart = exactHits[0]
    let bestScore = -Infinity
    for (const start of exactHits) {
      const end = start + queryNorm.length
      let s = scoreContextOverlap(full, start, end, beforeNorm, afterNorm, progress)
      if (isPureLatin && origins && origins.length === full.length) {
        const wStart = origins[start]?.wordStart ?? true
        const wEnd = origins[end - 1]?.wordEnd ?? true
        if (wStart && wEnd) s += 28
        else if (!wStart && !wEnd && queryNorm.length <= 5) s -= 40
      }
      if (s > bestScore) {
        bestScore = s
        bestStart = start
      }
    }
    return {
      start: bestStart,
      end: bestStart + queryNorm.length,
      score: 1000 + queryNorm.length * 4 + Math.max(0, bestScore),
    }
  }

  // Tier 2: 前后文夹逼定位（针对用户刚好选中了被校改的短词，如「谢君豪」vs「谢天豪」）
  if (beforeNorm.length >= 3 && afterNorm.length >= 3 && queryNorm.length <= 24) {
    let bestBracket: RangeMatchResult | null = null
    for (let bLen = Math.min(12, beforeNorm.length); bLen >= 3; bLen--) {
      const bAnchor = beforeNorm.slice(-bLen)
      let bSearch = 0
      while (bSearch < full.length) {
        const bIdx = full.indexOf(bAnchor, bSearch)
        if (bIdx === -1) break
        const targetStart = bIdx + bLen
        for (let aLen = Math.min(12, afterNorm.length); aLen >= 3; aLen--) {
          const aAnchor = afterNorm.slice(0, aLen)
          const maxSpan = Math.max(queryNorm.length * 2 + 4, 10)
          const windowRight = full.slice(targetStart, targetStart + maxSpan + aLen)
          const aRel = windowRight.indexOf(aAnchor)
          if (aRel >= 1 && aRel <= maxSpan) {
            const targetEnd = targetStart + aRel
            const ctxScore = scoreContextOverlap(
              full,
              targetStart,
              targetEnd,
              beforeNorm,
              afterNorm,
              progress
            )
            const score = 850 + (bLen + aLen) * 5 + ctxScore
            if (!bestBracket || score > bestBracket.score) {
              bestBracket = { start: targetStart, end: targetEnd, score }
            }
          }
        }
        bSearch = bIdx + 1
      }
      if (bestBracket) return bestBracket
    }
  }

  // Tier 3: 首尾锚点容错匹配（句子中间存在校改异文或增删字）
  if (queryNorm.length >= 5 && units >= 3.2) {
    const maxAnchor = Math.min(6, Math.floor(queryNorm.length / 2))
    const minAnchor = isPureLatin ? Math.min(3, maxAnchor) : 2
    let bestCandidate: RangeMatchResult | null = null

    for (let anchorLen = maxAnchor; anchorLen >= minAnchor; anchorLen--) {
      const head = queryNorm.slice(0, anchorLen)
      const tail = queryNorm.slice(-anchorLen)
      let searchFrom = 0
      while (searchFrom < full.length) {
        const hIdx = full.indexOf(head, searchFrom)
        if (hIdx === -1) break
        const minSpan = Math.max(anchorLen + 1, Math.floor(queryNorm.length * 0.65))
        const maxSpan = Math.ceil(queryNorm.length * 1.45) + anchorLen
        const windowSlice = full.slice(hIdx, Math.min(full.length, hIdx + maxSpan))
        const tRel = windowSlice.lastIndexOf(tail)
        if (tRel !== -1 && tRel + anchorLen >= minSpan) {
          const end = hIdx + tRel + anchorLen
          const sim = orderedCharSimilarity(queryNorm, full.slice(hIdx, end))
          if (sim >= 0.62) {
            const ctxScore = scoreContextOverlap(full, hIdx, end, beforeNorm, afterNorm, progress)
            const score = Math.round(sim * 600) + anchorLen * 12 + ctxScore
            if (!bestCandidate || score > bestCandidate.score) {
              bestCandidate = { start: hIdx, end, score }
            }
          }
        }
        searchFrom = hIdx + 1
      }
      if (bestCandidate) return bestCandidate
    }
  }

  // Tier 4: 2-gram 滑动窗口近似匹配
  if (queryNorm.length >= 4 && units >= 3.0) {
    const candidateStarts = new Set<number>()
    for (let i = 0; i < queryNorm.length - 1; i++) {
      const bg = queryNorm.slice(i, i + 2)
      let p = 0
      while (p < full.length) {
        const hit = full.indexOf(bg, p)
        if (hit === -1) break
        candidateStarts.add(Math.max(0, hit - i))
        p = hit + 1
      }
    }

    const minWinLen = Math.max(3, Math.ceil(queryNorm.length * 0.75))
    let bestWin: RangeMatchResult | null = null
    for (const s of candidateStarts) {
      const e = Math.min(full.length, s + queryNorm.length)
      if (e - s < minWinLen) continue
      const sim = orderedCharSimilarity(queryNorm, full.slice(s, e))
      if (sim >= 0.72) {
        const ctxScore = scoreContextOverlap(full, s, e, beforeNorm, afterNorm, progress)
        const score = Math.round(sim * 500) + ctxScore
        if (!bestWin || score > bestWin.score) {
          bestWin = { start: s, end: e, score }
        }
      }
    }
    if (bestWin) return bestWin
  }

  // Tier 5: 跨页断句：匹配较长的前缀或后缀
  if (queryNorm.length >= 6 && units >= 4.2) {
    const subLen = Math.max(4, Math.floor(queryNorm.length * 0.58))
    const frontSub = queryNorm.slice(0, subLen)
    const backSub = queryNorm.slice(-subLen)
    let bestPartial: RangeMatchResult | null = null

    for (const sub of [frontSub, backSub]) {
      let searchPos = 0
      while (searchPos <= full.length - sub.length) {
        const hit = full.indexOf(sub, searchPos)
        if (hit === -1) break
        const end = hit + sub.length
        const ctxScore = scoreContextOverlap(full, hit, end, beforeNorm, afterNorm, progress)
        const score = 300 + ctxScore
        if (!bestPartial || score > bestPartial.score) {
          bestPartial = { start: hit, end, score }
        }
        searchPos = hit + 1
      }
    }
    if (bestPartial) return bestPartial
  }

  return null
}

/**
 * 通用片段级精确字符区间匹配（同时服务 PDF textItems 与 Markdown DOM 文本节点）
 */
export function matchSegmentSlices(
  segments: readonly string[],
  query: string,
  context?: SelectionContext
): { slices: SegmentSlice[]; score: number } | null {
  const queryNorm = normalizeText(query)
  if (queryNorm.length < 1) return null

  const { norm, origins } = buildCharOriginMap(segments)
  if (!norm.length) return null

  const beforeNorm = context?.before ? normalizeText(context.before) : ''
  const afterNorm = context?.after ? normalizeText(context.after) : ''

  const match = findBestNormalizedRange(
    norm,
    queryNorm,
    beforeNorm,
    afterNorm,
    context?.progress,
    origins
  )
  if (!match || match.end <= match.start) return null

  const sliceMap = new Map<number, { startOffset: number; endOffset: number }>()
  for (let i = match.start; i < match.end && i < origins.length; i++) {
    const { segIdx, charIdx, charLen } = origins[i]
    const spanEnd = charIdx + (charLen ?? 1)
    const prev = sliceMap.get(segIdx)
    if (!prev) {
      sliceMap.set(segIdx, { startOffset: charIdx, endOffset: spanEnd })
    } else {
      if (charIdx < prev.startOffset) prev.startOffset = charIdx
      if (spanEnd > prev.endOffset) prev.endOffset = spanEnd
    }
  }

  const slices: SegmentSlice[] = []
  for (const [segIdx, range] of sliceMap.entries()) {
    slices.push({
      segIdx,
      startOffset: range.startOffset,
      endOffset: range.endOffset,
    })
  }
  return slices.length > 0 ? { slices, score: match.score } : null
}

// aihistory：导出并多返回相似度 similarity；精确命中（短页）的相似度记 1
export function findPageStartNormIndex(
  norm: string,
  pNorm: string,
  searchStart: number
): { normIdx: number; matchedOffset: number; similarity: number } | null {
  if (!pNorm || pNorm.length < 2 || searchStart >= norm.length) return null

  if (pNorm.length < 8) {
    const idx = norm.indexOf(pNorm, searchStart)
    return idx !== -1 ? { normIdx: idx, matchedOffset: 0, similarity: 1 } : null
  }

  const passes = [
    { anchorLen: Math.min(8, Math.max(4, Math.floor(pNorm.length * 0.3))), minSim: 0.52 },
    { anchorLen: Math.min(4, pNorm.length), minSim: 0.62 },
  ]

  for (const { anchorLen, minSim } of passes) {
    const maxOffset = Math.min(120, Math.max(0, pNorm.length - anchorLen))
    for (let offset = 0; offset <= maxOffset; offset += 2) {
      const anchor = pNorm.slice(offset, offset + anchorLen)
      let pos = searchStart
      let bestHit = -1
      let bestSim = 0

      while (pos <= norm.length - anchorLen) {
        const idx = norm.indexOf(anchor, pos)
        if (idx === -1) break
        const checkLen = Math.min(72, pNorm.length - offset)
        const pdfSlice = pNorm.slice(offset, offset + checkLen)
        const mdSlice = norm.slice(idx, Math.min(norm.length, idx + Math.ceil(checkLen * 1.25)))
        const sim = orderedCharSimilarity(pdfSlice, mdSlice)
        if (sim > bestSim) {
          bestSim = sim
          bestHit = idx
        }
        if (sim >= 0.72) break
        pos = idx + 1
      }

      if (bestHit !== -1 && bestSim >= minSim) {
        let curOffset = offset
        let curHit = bestHit
        while (curOffset > 0 && curHit > searchStart) {
          if (norm[curHit - 1] === pNorm[curOffset - 1]) {
            curOffset--
            curHit--
          } else if (
            curOffset >= 2 &&
            curHit >= searchStart + 2 &&
            norm[curHit - 2] === pNorm[curOffset - 2]
          ) {
            curOffset -= 2
            curHit -= 2
          } else {
            break
          }
        }
        return { normIdx: curHit, matchedOffset: curOffset, similarity: bestSim }
      }
    }
  }

  return null
}
