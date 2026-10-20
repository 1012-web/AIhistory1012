// 来源：Better Search Result Views（https://github.com/1012-web/better-search-result-views，MIT，同一作者）src/shared/variants.ts，提交 b74e1d7，原样拷入，未改动。
// 两个插件认的「同一个字」要一致：改这里先改那边，再照拷。
/**
 * 异体字折叠表（纯函数，不依赖 obsidian，手机端也可用）：把互为异体的字归成一组，
 * 检索时同组的字当同一个字比对。只用于检索，绝不回写正文。
 *
 * 用「并查集」合并：每组选一个代表字，rep(字) 相同即同组；甲＝乙、乙＝丙时甲丙自动同组。
 * 一律按码点处理：扩展区的字（如「𫍲」）在 JavaScript 字符串里占两个位置，不能按位置切。
 */

export class VariantTable {
  private readonly parent = new Map<string, string>();
  private membersCache: Map<string, string[]> | null = null;

  /** 已登记的字数（含代表字） */
  get size(): number {
    return this.parent.size;
  }

  /** 这张表有没有登记任何字 */
  get empty(): boolean {
    return this.parent.size === 0;
  }

  /** 一组互为异体的字，如「鄴邺」；组内的空白与分隔符（＝、=、,、、）忽略，少于两个字的组不收 */
  addGroup(group: string | Iterable<string>): void {
    const chars = typeof group === "string" ? groupChars(group) : [...group];
    for (let i = 1; i < chars.length; i++) this.union(chars[0], chars[i]);
  }

  /** 按码点每两个一组的字对串（生成的 Unihan 表的格式） */
  addPairs(packed: string): void {
    const chars = [...packed];
    for (let i = 0; i + 1 < chars.length; i += 2) this.union(chars[i], chars[i + 1]);
  }

  /** 并入另一张表 */
  addTable(other: VariantTable): void {
    for (const ch of other.parent.keys()) this.union(ch, other.rep(ch));
  }

  /** 一个字所在组的代表字；没登记的字就是它自己 */
  rep(ch: string): string {
    let root = ch;
    let next = this.parent.get(root);
    while (next !== undefined && next !== root) {
      root = next;
      next = this.parent.get(root);
    }
    // 路径压缩：沿路各字直接指向代表字，下次查得快
    let node = ch;
    while (node !== root) {
      const up = this.parent.get(node);
      if (up === undefined) break;
      this.parent.set(node, root);
      node = up;
    }
    return root;
  }

  /** 与这个字同组的全部字（含自身，按码点排序）；没登记的字只有它自己 */
  members(ch: string): string[] {
    if (!this.parent.has(ch)) return [ch];
    if (!this.membersCache) {
      const groups = new Map<string, string[]>();
      for (const key of this.parent.keys()) {
        const root = this.rep(key);
        const list = groups.get(root);
        if (list) list.push(key);
        else groups.set(root, [key]);
      }
      for (const list of groups.values()) list.sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!);
      this.membersCache = groups;
    }
    return this.membersCache.get(this.rep(ch)) ?? [ch];
  }

  private union(a: string, b: string): void {
    if (!a || !b || a === b) return;
    this.membersCache = null;
    if (!this.parent.has(a)) this.parent.set(a, a);
    if (!this.parent.has(b)) this.parent.set(b, b);
    const ra = this.rep(a);
    const rb = this.rep(b);
    if (ra === rb) return;
    // 代表字取码点小的一方，结果与登记顺序无关，便于测试与排查
    if (ra.codePointAt(0)! < rb.codePointAt(0)!) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
}

const SEPARATORS = /[\s＝=,，、;；/／|｜]/u;

/** 一组异体的字，去掉空白与分隔符 */
export function groupChars(group: string): string[] {
  return [...group].filter((ch) => !SEPARATORS.test(ch));
}

/** 多行文本（设置里一行一组）→ 各组；少于两个字的行跳过 */
export function parseGroupLines(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => groupChars(line))
    .filter((chars) => chars.length >= 2);
}

/**
 * 书的逐字映射配置（_数据/config.json）里的 variantEquivalents：["鄴邺", "𫍲謏"]，
 * 每组第一个字是原书字形。格式不对的项跳过，不报错。
 */
export function parseVariantEquivalents(raw: unknown): string[][] {
  if (typeof raw !== "object" || raw === null) return [];
  const list = (raw as Record<string, unknown>).variantEquivalents;
  if (!Array.isArray(list)) return [];
  return list
    .filter((item): item is string => typeof item === "string")
    .map((item) => groupChars(item))
    .filter((chars) => chars.length >= 2);
}

/** 正则里要转义的字符 */
function escapeForRegex(ch: string): string {
  return /[\\^$.*+?()[\]{}|\-/]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * 查询 → Obsidian 自带搜索认得的正则写法：每个有异体的字展开成字符组。
 * 如「邺城」→「/[邺鄴]城/」。自带搜索的正则按原文匹配，跨不过标注标签与页码锚点。
 * 自带搜索的正则不带 u 标志，扩展区的字（两个 UTF-16 单位）放进方括号会被拆成两半，
 * 所以组里有扩展区字时改写成「(?:𫍲|謏)」。
 */
export function toSearchRegex(query: string, table: VariantTable | null): string {
  const parts: string[] = [];
  for (const ch of query) {
    if (/\s/u.test(ch)) continue;
    parts.push(charPattern(ch, table));
  }
  return parts.length ? `/${parts.join("")}/` : "";
}

/** 一个字在正则里的写法：有异体的展开成字符组（含扩展区字时用分支），没有的只转义 */
export function charPattern(ch: string, table: VariantTable | null): string {
  const members = (table ? table.members(ch) : [ch]).map(escapeForRegex);
  if (members.length === 1) return members[0];
  if (members.some((member) => member.codePointAt(0)! > 0xffff)) return `(?:${members.join("|")})`;
  return `[${members.join("")}]`;
}
