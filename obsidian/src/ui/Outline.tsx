/**
 * 工具条上的多级标题（面包屑）与点开的标题菜单。不碰 Obsidian：标题、页码、偏好、跳转都由宿主经 props 注入。
 *
 * 菜单两种样式：
 * - 目录树（默认）：各级标题缩进成树，H1–H5 一眼看全；键盘、展开收起用 @headless-tree（无样式的树组件，
 *   约 52 万周下载、零依赖），外观照工具条自己画。
 * - 分栏：当前位置的每一级并排一栏（Miller columns，即访达那种分栏）。这种排法没有合适的通用库，
 *   用 Base UI 的东西也拼不出来，按键自己接。
 * 搜索时两种样式都用目录树显示结果（匹配的标题连同上级，全展开）。
 *
 * 展开记忆见 core/outline-view：手动的展开、收起与「展开到第几级」每本书记一份；当前位置的上级只临时展开。
 */
import { Popover } from "@base-ui/react/popover";
import { hotkeysCoreFeature, syncDataLoaderFeature, type ItemInstance } from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type RefObject } from "react";
import { LocateIcon, PinIcon } from "./icons";
import { headingPath, outline as buildOutline, type Heading, type Outline } from "../core/headings";
import { ALL_LEVELS, expandedIds, headingIds, pageLabel, searchKeep, splitMatch, withToggles, type HeadingPage, type OutlineBookState, type OutlinePages } from "../core/outline-view";

export type OutlineStyle = "tree" | "columns";

/** 菜单里能直接切换的显示偏好（全局记住） */
export interface OutlinePrefs {
  showLevel?: boolean;
  showPage?: boolean;
  pinned?: boolean;
}

export interface OutlineStatus {
  /** 当前正文文件的全部标题（按出现先后） */
  headings: Heading[];
  /** 与 headings 一一对应的所在页 */
  pages: HeadingPage[];
  /** 当前文件路径（标题编号的前缀） */
  file: string;
  /** 阅读线处的标题序号；-1 = 还没到第一个标题 */
  current: number;
  /** Obsidian 界面是中文：页码写「第50页」，否则「p.50」 */
  zh: boolean;
  style: OutlineStyle;
  pageMode: OutlinePages;
  showLevel: boolean;
  showPage: boolean;
  /** 设置里允许显示「钉住」按钮 */
  pinButton: boolean;
  pinned: boolean;
  /** 这本书的展开记忆 */
  book: OutlineBookState;
}

export interface OutlineActions {
  /** 跳到正文里偏移 offset 处的那个标题 */
  jumpToHeading: (offset: number) => void;
  setOutline: (prefs: OutlinePrefs) => void;
  setOutlineBook: (state: OutlineBookState) => void;
}

const ROOT = "\u0000root";

interface TreeNode {
  index: number;
}
const ROOT_NODE: TreeNode = { index: -1 };

/** 工具条上的一串标题；点任一级打开标题菜单，光标落在点的那一级上 */
export function HeadingCrumbs({ outline: o, actions, container }: { outline: OutlineStatus; actions: OutlineActions; container: HTMLElement | null }): ReactElement {
  const tree = useMemo(() => buildOutline(o.headings), [o.headings]);
  const current = o.current < o.headings.length ? o.current : -1;
  const path = headingPath(tree, current);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);
  if (!o.headings.length) return <span className="aps-crumbs" />;
  const full = path.map((index) => o.headings[index].text).join(" › ");
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next, details) => {
        // 钉住时点别处、焦点离开都不关；Esc 和再点标题照常关
        if (!next && o.pinned && (details.reason === "outside-press" || details.reason === "focus-out")) return;
        setOpen(next);
      }}
    >
      <Popover.Trigger
        nativeButton={false}
        render={<span />}
        className="aps-crumbs"
        title={full}
        aria-label={`标题：${full || "目录"}，点开标题菜单`}
        onKeyDown={() => setTarget(current)}
      >
        {path.length ? (
          path.map((index, depth) => (
            <Fragment key={index}>
              {depth > 0 ? <span className="aps-crumb-sep" aria-hidden="true">›</span> : null}
              <span className="aps-crumb" onPointerDown={() => setTarget(index)}>{o.headings[index].text}</span>
            </Fragment>
          ))
        ) : (
          <span className="aps-crumb aps-crumb-placeholder" onPointerDown={() => setTarget(-1)}>目录</span>
        )}
      </Popover.Trigger>
      <Popover.Portal container={container}>
        <Popover.Positioner className="aps-menu-positioner" side="bottom" align="start" sideOffset={6} collisionPadding={8}>
          <Popover.Popup className={`aps-menu aps-outline-pop aps-outline-${o.style}`} initialFocus={searchRef}>
            <OutlinePanel
              o={o}
              tree={tree}
              target={target >= 0 ? target : current}
              searchRef={searchRef}
              actions={actions}
              onJump={(index) => {
                actions.jumpToHeading(o.headings[index].offset);
                if (!o.pinned) setOpen(false);
              }}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

interface PanelProps {
  o: OutlineStatus;
  tree: Outline;
  /** 打开时光标落在哪个标题上 */
  target: number;
  searchRef: RefObject<HTMLInputElement | null>;
  actions: OutlineActions;
  onJump: (index: number) => void;
}

function OutlinePanel({ o, tree, target, searchRef, actions, onJump }: PanelProps): ReactElement {
  const ids = useMemo(() => headingIds(o.headings, tree, o.file), [o.headings, tree, o.file]);
  const [query, setQuery] = useState("");
  const found = useMemo(() => searchKeep(o.headings, tree, query), [o.headings, tree, query]);
  const [expanded, setExpanded] = useState<string[]>(() => expandedIds(o.headings, tree, ids, o.book, o.current));
  const [locateTick, setLocateTick] = useState(0);
  const listRef = useRef<ListHandle>(null);
  const bookRef = useRef(o.book);
  bookRef.current = o.book;

  // 阅读位置变了（钉住时）或换了文件：按记忆重排，临时展开新位置的上级
  useEffect(() => {
    setExpanded(expandedIds(o.headings, tree, ids, bookRef.current, o.current));
  }, [o.current, o.headings, tree, ids]);

  const maxLevel = o.headings.reduce((max, heading) => Math.max(max, heading.level), 1);
  const depthLevels: number[] = [];
  for (let level = 2; level < maxLevel; level++) depthLevels.push(level);
  const applyDepth = (depth: number) => {
    const state = { depth, manual: {} };
    actions.setOutlineBook(state);
    // 点了「全部收起」就真收起：这一回不临时展开当前位置（下次打开再展开）
    setExpanded(expandedIds(o.headings, tree, ids, state, -1));
  };
  const userExpanded = (next: string[]) => {
    actions.setOutlineBook(withToggles(bookRef.current, expanded, next));
    setExpanded(next);
  };
  const locate = () => {
    setQuery("");
    setExpanded((old) => [...new Set([...old, ...expandedIds(o.headings, tree, ids, { depth: 0, manual: {} }, o.current)])]);
    setLocateTick((tick) => tick + 1);
  };
  const searching = !!found;
  const useTreeView = o.style === "tree" || searching;

  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      listRef.current?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const first = found?.hits[0];
      if (first !== undefined) onJump(first);
    }
  };

  return (
    <div className="aps-ol">
      <div className="aps-ol-head">
        <input
          ref={searchRef}
          className="aps-ol-search"
          type="search"
          placeholder="搜索标题"
          aria-label="搜索标题"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKey}
        />
        {found ? <span className="aps-muted aps-ol-count">{found.hits.length} 个</span> : null}
        <button type="button" className="aps-ib aps-ol-btn" title="定位到当前位置" aria-label="定位到当前位置" onClick={locate}>
          <LocateIcon />
        </button>
        {o.pinButton ? (
          <button
            type="button"
            className="aps-ib aps-ol-btn"
            data-on={o.pinned ? "" : undefined}
            aria-pressed={o.pinned}
            title={o.pinned ? "已钉住：跳转后不关，跟着阅读位置走。点一下取消" : "钉住：跳转后菜单不关，跟着阅读位置高亮"}
            aria-label="钉住"
            onClick={() => actions.setOutline({ pinned: !o.pinned })}
          >
            <PinIcon />
          </button>
        ) : null}
      </div>
      <div className="aps-ol-tools">
        {o.style === "tree" && !searching ? (
          <>
            <button type="button" className="aps-ib aps-ol-chip" onClick={() => applyDepth(0)}>全部收起</button>
            {depthLevels.length ? <span className="aps-muted">展开到</span> : null}
            {depthLevels.map((level) => (
              <button key={level} type="button" className="aps-ib aps-ol-chip" data-on={o.book.depth === level ? "" : undefined} title={`H1 到 H${level} 都看得见`} onClick={() => applyDepth(level)}>
                H{level}
              </button>
            ))}
            <button type="button" className="aps-ib aps-ol-chip" data-on={o.book.depth === ALL_LEVELS ? "" : undefined} onClick={() => applyDepth(ALL_LEVELS)}>全部展开</button>
          </>
        ) : null}
        <span className="aps-spacer" />
        <button type="button" className="aps-ib aps-ol-chip" data-on={o.showLevel ? "" : undefined} aria-pressed={o.showLevel} title="每行左边标 H1–H5" onClick={() => actions.setOutline({ showLevel: !o.showLevel })}>H#</button>
        <button type="button" className="aps-ib aps-ol-chip" data-on={o.showPage ? "" : undefined} aria-pressed={o.showPage} title="每行右边标页码" onClick={() => actions.setOutline({ showPage: !o.showPage })}>页码</button>
      </div>
      {useTreeView ? (
        <TreeList
          key={searching ? "search" : "tree"}
          ref={listRef}
          o={o}
          tree={tree}
          ids={ids}
          keep={found?.keep ?? null}
          query={query}
          expanded={searching ? null : expanded}
          setExpanded={userExpanded}
          target={target}
          locateTick={locateTick}
          searchRef={searchRef}
          onJump={onJump}
        />
      ) : (
        <Columns ref={listRef} o={o} tree={tree} target={target} locateTick={locateTick} searchRef={searchRef} onJump={onJump} />
      )}
    </div>
  );
}

interface ListHandle {
  focus: () => void;
}

/** 一行的级别、文字（搜索时标出匹配的字）、页码 */
function Row({ o, index, query }: { o: OutlineStatus; index: number; query: string }): ReactElement {
  const heading = o.headings[index];
  const page = o.pages[index];
  return (
    <>
      {o.showLevel ? <span className="aps-ol-lv">H{heading.level}</span> : null}
      <span className="aps-ol-text" title={heading.text}>
        {splitMatch(heading.text, query).map((part, at) => (part.hit ? <mark key={at} className="aps-ol-hit">{part.text}</mark> : <Fragment key={at}>{part.text}</Fragment>))}
      </span>
      {o.showPage && page && page.page > 0 ? <span className="aps-ol-pg">{pageLabel(page, o.pageMode, o.zh)}</span> : null}
    </>
  );
}

/** 把 element 滚到 box 的可视区中间（只滚菜单自己，不动外面的页面） */
function centerIn(box: HTMLElement | null, element: HTMLElement | null | undefined): void {
  if (!box || !element) return;
  const boxRect = box.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  box.scrollTop += rect.top - boxRect.top - (box.clientHeight - rect.height) / 2;
}

interface TreeListProps {
  ref: RefObject<ListHandle | null>;
  o: OutlineStatus;
  tree: Outline;
  ids: string[];
  /** 搜索时只留这些标题；null 不筛 */
  keep: Set<number> | null;
  query: string;
  /** 展开的标题编号；null = 搜索中，全展开 */
  expanded: string[] | null;
  setExpanded: (next: string[]) => void;
  target: number;
  locateTick: number;
  searchRef: RefObject<HTMLInputElement | null>;
  onJump: (index: number) => void;
}

function TreeList({ ref, o, tree, ids, keep, query, expanded, setExpanded, target, locateTick, searchRef, onJump }: TreeListProps): ReactElement {
  const indexOf = useMemo(() => new Map(ids.map((id, index) => [id, index])), [ids]);
  // 树组件把假值当成「没取到」，序号 0 不能直接当数据：包一层
  const nodes = useMemo(() => ids.map((_, index) => ({ index })), [ids]);
  const childrenOf = (id: string): number[] => {
    const list = id === ROOT ? tree.roots : tree.children[indexOf.get(id) ?? -1] ?? [];
    return keep ? list.filter((index) => keep.has(index)) : list;
  };
  const searchOpen = useMemo(() => (keep ? ids.filter((_, index) => keep.has(index) && tree.children[index].length) : []), [keep, ids, tree]);
  const [focused, setFocused] = useState<string | null>(() => ids[target] ?? null);
  const boxRef = useRef<HTMLDivElement>(null);

  const instance = useTree<TreeNode>({
    rootItemId: ROOT,
    state: { expandedItems: expanded ?? searchOpen, focusedItem: focused },
    setExpandedItems: (updater) => {
      if (expanded === null) return;
      setExpanded(typeof updater === "function" ? updater(expanded) : updater);
    },
    setFocusedItem: (updater) => setFocused((old) => (typeof updater === "function" ? updater(old) : updater)),
    getItemName: (item) => o.headings[item.getItemData().index]?.text ?? "",
    isItemFolder: (item) => item.getId() === ROOT || childrenOf(item.getId()).length > 0,
    dataLoader: {
      getItem: (id) => nodes[indexOf.get(id) ?? -1] ?? ROOT_NODE,
      getChildren: (id) => childrenOf(id).map((index) => ids[index])
    },
    indent: 14,
    features: [syncDataLoaderFeature, hotkeysCoreFeature],
    hotkeys: {
      // 在第一行再按 ↑ 回到搜索框（回车跳转在列表的 onKeyDown 里接：树组件的自定义回车键在这里收不到）
      focusPreviousItem: {
        handler: (_event, tree) => {
          if (tree.getItems()[0]?.isFocused()) {
            searchRef.current?.focus();
            return;
          }
          tree.focusPreviousItem();
          tree.updateDomFocus();
        }
      }
    }
  });

  // 标题表、搜索词变了：重建树
  useEffect(() => {
    instance.rebuildTree();
  }, [instance, o.headings, keep]);

  // 打开时、点「定位」时、钉住后阅读位置变了：把当前位置（或点的那一级）滚到中间
  const here = keep ? -1 : o.current;
  useLayoutEffect(() => {
    const box = boxRef.current;
    const wanted = target >= 0 && locateTick === 0 ? target : here;
    centerIn(box, box?.querySelector<HTMLElement>(`[data-index="${wanted}"]`) ?? box?.querySelector<HTMLElement>("[data-here]"));
    if (ids[wanted]) setFocused(ids[wanted]);
    // target 只管刚打开那一下
  }, [here, locateTick]);

  ref.current = {
    focus: () => {
      const item = instance.getFocusedItem() ?? instance.getItems()[0];
      item?.setFocused();
      instance.updateDomFocus();
    }
  };

  const path = new Set(headingPath(tree, o.current));
  const items = instance.getItems();
  const { ref: registerTree, ...containerProps } = instance.getContainerProps("标题目录") as { ref: (element: HTMLElement | null) => void };
  return (
    <div
      {...containerProps}
      ref={(element) => {
        boxRef.current = element;
        registerTree(element);
      }}
      className="aps-ol-list"
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        const index = instance.getFocusedItem()?.getItemData().index;
        if (index !== undefined && index >= 0) onJump(index);
      }}
    >
      {items.length ? null : <div className="aps-muted aps-ol-empty">没有匹配的标题</div>}
      {items.map((item: ItemInstance<TreeNode>) => {
        const index = item.getItemData().index;
        const { onClick: _onClick, ...props } = item.getProps();
        const folder = item.isFolder();
        return (
          <div
            key={item.getId()}
            {...props}
            className="aps-ol-item"
            data-index={index}
            data-current={path.has(index) ? "" : undefined}
            data-here={index === o.current ? "" : undefined}
            data-focused={item.isFocused() ? "" : undefined}
            style={{ paddingLeft: 4 + item.getItemMeta().level * 14 }}
            onClick={(event) => {
              item.setFocused();
              // 点 ▸ 只展开收起；点文字才跳
              if (folder && (event.target as HTMLElement).closest(".aps-ol-tw")) {
                if (item.isExpanded()) item.collapse();
                else item.expand();
                return;
              }
              onJump(index);
            }}
          >
            <span className="aps-ol-tw" aria-hidden="true">{folder ? (item.isExpanded() ? "▾" : "▸") : ""}</span>
            <Row o={o} index={index} query={query} />
          </div>
        );
      })}
    </div>
  );
}

interface ColumnsProps {
  ref: RefObject<ListHandle | null>;
  o: OutlineStatus;
  tree: Outline;
  target: number;
  locateTick: number;
  searchRef: RefObject<HTMLInputElement | null>;
  onJump: (index: number) => void;
}

/**
 * 分栏：第一栏是最上一级，选中哪个，右边一栏就列它的下级。点没有下级的标题直接跳；
 * 有下级的点一下只往右展开，双击或点行尾的 ↵ 才跳。键盘 ↑↓ 在栏内移，←→ 换栏，回车跳。
 */
function Columns({ ref, o, tree, target, locateTick, searchRef, onJump }: ColumnsProps): ReactElement {
  const [chosen, setChosen] = useState<number[]>(() => headingPath(tree, target >= 0 ? target : o.current));
  const [cursor, setCursor] = useState(() => Math.max(0, chosen.length - 1));
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const path = headingPath(tree, o.current);
    setChosen(path);
    setCursor(Math.max(0, path.length - 1));
  }, [o.current, tree, locateTick]);

  const columns: number[][] = [tree.roots];
  for (const index of chosen) if (tree.children[index].length) columns.push(tree.children[index]);
  const path = new Set(headingPath(tree, o.current));

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.scrollLeft = box.scrollWidth;
    for (const column of Array.from(box.querySelectorAll<HTMLElement>(".aps-col"))) centerIn(column, column.querySelector<HTMLElement>("[data-chosen]"));
  }, [chosen.length, o.current]);

  const choose = (column: number, index: number) => {
    setChosen([...chosen.slice(0, column), index]);
    setCursor(column);
  };
  const focusCursor = () => boxRef.current?.querySelector<HTMLElement>(`.aps-col:nth-child(${cursor + 1}) [data-chosen]`)?.focus() ?? boxRef.current?.querySelector<HTMLElement>(".aps-col-item")?.focus();
  ref.current = { focus: focusCursor };
  useEffect(() => {
    if (boxRef.current?.contains(boxRef.current.ownerDocument.activeElement)) focusCursor();
  });

  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = columns[cursor] ?? [];
    const at = list.indexOf(chosen[cursor] ?? -1);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (event.key === "ArrowUp" && at <= 0) {
        searchRef.current?.focus();
        return;
      }
      const next = list[Math.min(list.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))];
      if (next !== undefined) choose(cursor, next);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      const kids = tree.children[chosen[cursor] ?? -1] ?? [];
      if (kids.length) choose(cursor + 1, kids[0]);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (cursor > 0) {
        setChosen(chosen.slice(0, cursor));
        setCursor(cursor - 1);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      const index = chosen[cursor];
      if (index !== undefined) onJump(index);
    }
  };

  return (
    <div ref={boxRef} className="aps-cols" role="group" aria-label="标题分栏" onKeyDown={onKey}>
      {columns.map((list, column) => (
        <div key={column} className="aps-col">
          <div className="aps-col-head">{o.headings[list[0]] ? `H${o.headings[list[0]].level}` : ""}</div>
          {list.map((index) => {
            const isChosen = chosen[column] === index;
            const hasKids = tree.children[index].length > 0;
            return (
              <div
                key={index}
                className="aps-col-item"
                role="button"
                tabIndex={isChosen && column === cursor ? 0 : -1}
                data-index={index}
                data-chosen={isChosen ? "" : undefined}
                data-current={path.has(index) ? "" : undefined}
                data-here={index === o.current ? "" : undefined}
                onClick={() => (hasKids ? choose(column, index) : onJump(index))}
                onDoubleClick={() => onJump(index)}
              >
                <Row o={{ ...o, showLevel: false }} index={index} query="" />
                {hasKids ? (
                  <span
                    className="aps-col-go"
                    role="button"
                    title="跳到这里"
                    aria-label="跳到这里"
                    onClick={(event) => {
                      event.stopPropagation();
                      onJump(index);
                    }}
                  >
                    ↵
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
