/**
 * 核心逻辑：不得 import `obsidian` 与 React，便于单测。
 * 除 collation/pdf-dom、highlight（要浏览器 DOM）与 cm-sync（入参是 CodeMirror 的 EditorView）外都是纯函数，可在 Node 里跑。
 */
export {
  PAGE_ANCHOR_RE,
  PRINTED_ANCHOR_RE,
  anchorProblems,
  bodyAnchors,
  footnoteRanges,
  footnotesForPage,
  formatPageAnchor,
  frontmatterLength,
  lineStarts,
  pageAtOffset,
  pageSegments,
  parseAnchors,
  segmentForPage,
  segmentForPageOrGap,
  stripAnchors,
  type Anchor,
  type PagePosition,
  type PageSegment
} from "./anchors";
export {
  bookPages,
  buildBookIndex,
  compareBookPaths,
  fileForPage,
  indexEntry,
  printedLabel,
  suggestedPageRange,
  type BookFileEntry,
  type BookIndex
} from "./book-index";
export { headingIndexBefore, headingPath, headings, outline, siblingsOf, type Heading, type Outline } from "./headings";
export {
  LeaderTracker,
  QuietWindow,
  baselineY,
  clamp01,
  fractionWithin,
  heightInBlock,
  pdfPointAt,
  posInBlock,
  scrollDeltaToBaseline,
  type PageBox,
  type PagePoint,
  type Side
} from "./sync-math";
export {
  buildCharOriginMap,
  findBestNormalizedRange,
  findPageStartNormIndex,
  matchSegmentSlices,
  normalizeText,
  type CharOrigin,
  type SegmentSlice,
  type SelectionContext
} from "./collation/compare";
export { computeSliceHighlightBoxes, mergeLineBoxes, type HighlightBox, type SpanSlice } from "./collation/pdf-dom";
export { PROTOCOL_ACTION, locateSuspect, parseSuspectLink, uriParams, type SuspectLink } from "./link";
export {
  applyPagemarks,
  maskForMatching,
  planPagemarks,
  startSimilarity,
  type Confidence,
  type PagemarkPlan,
  type PagemarkProposal,
  type Placement
} from "./pagemarks";
export { buildRevisionRequest, type RevisionRequest } from "./revision";
export { cmGeometry, markdownPointAt, parsedDoc, parsedText, scrollMarkdownTo, setLegacyOffset, scrollOffsetToBaseline, type CmDoc, type EditorView as CmEditorView, type MarkdownGeometry, type MarkdownPoint, type Parsed } from "./cm-sync";
export {
  alignSegment,
  fallbackPoints,
  longestIncreasing,
  textBox,
  type AlignPoint,
  type AlignQuality,
  type PdfLine,
  type PdfPageLines,
  type SegmentAlignment
} from "./line-align";
export { LineMap, type TextLayerProblem } from "./line-map";
export { markdownTargetForPdf, pdfTargetForMarkdown, type MarkdownHeight, type PdfHeight } from "./line-sync";
export { groupTextLines, type GroupedLines, type TextItemLike, type ViewportLike } from "./pdf-lines";
export { frontmatterPdf, linkpathOf, pdfLinkValue, setFrontmatterPdf } from "./frontmatter";
export { BOOK_JSON, DATA_DIR, TEXT_LAYER_SUFFIX, uniquePdf, type BookJson, type BookJsonFile, type PairSource } from "./pairing";
export {
  PdfHighlighter,
  locateInSegment,
  selectionContext,
  textLayerSpans,
  waitTextSpans,
  type HighlightHost,
  type HighlightRequest,
  type HighlighterOptions
} from "./highlight";
