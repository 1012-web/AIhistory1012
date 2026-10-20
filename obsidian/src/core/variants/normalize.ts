// 来源：Better Search Result Views（https://github.com/1012-web/better-search-result-views，MIT，同一作者）src/shared/normalize.ts，提交 b74e1d7，原样拷入，未改动。
// 两个插件认的「同一个字」要一致：改这里先改那边，再照拷。
/** 比对用的单字归一化：全角标点转半角，其余走 NFKC 并转小写。 */

const PUNCT_MAP: Record<string, string> = {
  "，": ",",
  "。": ".",
  "；": ";",
  "：": ":",
  "？": "?",
  "！": "!",
  "（": "(",
  "）": ")",
  "“": '"',
  "”": '"',
  "‘": "'",
  "’": "'",
  "、": ",",
  "《": "<",
  "》": ">",
  "—": "-",
  "－": "-",
  "～": "~"
};

export function normalizeChar(ch: string): string {
  if (PUNCT_MAP[ch]) return PUNCT_MAP[ch];
  return ch.normalize("NFKC").toLowerCase();
}
