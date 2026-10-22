"use client";
/**
 * 网页工作台主体：左 PDF、右 Markdown（可换边），按物理页锚点跟随；编辑自动存回硬盘；
 * 磁盘上的改动经推送即时刷新；有未存改动时磁盘又被改了就弹冲突对话框。
 */
import { Menu } from "@base-ui/react/menu";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { ApiError, DEMO, fetchBook, fetchFile, fetchSettings, saveFile, saveSettings, subscribeChanges, takeToken, type BookInfo, type ChangeEvent, type SettingsSnapshot } from "./api";
import { applyChecked, checkTextLayer } from "./pagemark";
import { DEFAULT_PREFS, dockChoiceOf, normalizePrefs, withDockChoice, type WebPrefs } from "./prefs";
import { SettingsDialog } from "./SettingsDialog";
import { ConflictDialog, type ConflictInfo } from "./ConflictDialog";
import { EditorPane, parsedDoc, type EditorHandle, type EditorSelectionInfo } from "./editor/EditorPane";
import { PdfFinder, setFrontmatterPdf, type PdfHit } from "@/s3/core";
import { PdfPane, type PdfHandle, type PdfTextSelection } from "./pdf/PdfPane";
import { SearchBox } from "./SearchBox";
import type { SearchHit } from "./search";
import { SyncController } from "./sync";
import { mapLinkFile, openRequestFromLocation, type OpenRequest } from "./open-link";
import {
  buildBookIndex,
  setLegacyOffset,
  buildRevisionRequest,
  fileForPage,
  headingBefore,
  indexEntry,
  locateSuspect,
  planPagemarks,
  matchSegmentSlices,
  parseSuspectLink,
  printedLabel,
  segmentForPage,
  suggestedPageRange,
  uriParams,
  type BookIndex,
  type PagePoint,
} from "@/s3/core";
import { BindDialog, Coachmark, DOCK_INSET, FindBar, Onboarding, type FindResult, PagemarkDialog, Toolbar, type CoachStep, type OnboardingValues, type DockFrame, type SyncMode, type ToolbarActions, type ToolbarPlacement, type ToolbarStatus } from "@/s3/ui";

const QUIET_MS = 200;
const SAVE_DELAY = 700;
const SNAP_DISTANCE = 36;

interface DocState {
  /** 当前内容（打开着的文件就是编辑器里的） */
  text: string;
  /** 已知磁盘上的版本 */
  diskHash: string;
  dirty: boolean;
  /** 正在存的那份内容 */
  saving: string | null;
  /** 有冲突时磁盘上的内容 */
  conflict: { text: string; hash: string } | null;
}

type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

function onboardingValues(prefs: WebPrefs): OnboardingValues {
  return {
    pdfSide: prefs.pdfSide,
    dock: dockChoiceOf(prefs.toolbar),
    mode: prefs.mode,
    autoOpen: prefs.showPdf,
    proportional: prefs.proportional,
    pageLabels: prefs.pageLabels,
    shade: prefs.shade,
    reducedMotion: prefs.reducedMotion,
  };
}

function prefsFromOnboarding(prefs: WebPrefs, values: OnboardingValues): Partial<WebPrefs> {
  return {
    pdfSide: values.pdfSide,
    toolbar: withDockChoice(prefs.toolbar, values.dock),
    mode: values.mode,
    showPdf: values.autoOpen,
    proportional: values.proportional,
    pageLabels: values.pageLabels,
    shade: values.shade,
    reducedMotion: values.reducedMotion,
  };
}

export function Workbench() {
  // 令牌在挂上后才取（取时会改地址栏，不能在渲染中做）；undefined 表示还没取
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setToken(takeToken());
    // 地址栏换了令牌（重启后用新网址打开同一标签页）：整页重载，免得旧状态残留
    const reload = () => {
      if (/token=/.test(window.location.hash)) window.location.reload();
    };
    window.addEventListener("hashchange", reload);
    return () => window.removeEventListener("hashchange", reload);
  }, []);
  const [book, setBook] = useState<BookInfo | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const docs = useRef(new Map<string, DocState>());
  const [docsVersion, bumpDocs] = useReducer((n: number) => n + 1, 0);
  const [openPath, setOpenPathState] = useState<string | null>(null);
  const openPathRef = useRef<string | null>(null);
  const editor = useRef<EditorHandle>(null);
  const pdf = useRef<PdfHandle>(null);
  const [pdfReloadKey, setPdfReloadKey] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  const [printed, setPrinted] = useState<string | null>(null);
  const [chapter, setChapter] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  // 界面设置存在本机服务的用户配置文件里（见 prefs.ts）；启动时取一次，改了就存回去
  const [prefs, setPrefs] = useState<WebPrefs>(DEFAULT_PREFS);
  const [settingsInfo, setSettingsInfo] = useState<SettingsSnapshot | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const prefsTimer = useRef<number | undefined>(undefined);
  const updatePrefs = useCallback((patch: Partial<WebPrefs>) => {
    setPrefs((old) => {
      const next = { ...old, ...patch };
      prefsRef.current = next;
      return next;
    });
    window.clearTimeout(prefsTimer.current);
    prefsTimer.current = window.setTimeout(() => {
      void saveSettings({ prefs: prefsRef.current as unknown as Record<string, unknown> })
        .then(setSettingsInfo)
        .catch((error: Error) => notifyRef.current(`设置没存上：${error.message}`));
    }, 300);
  }, []);
  const mode = prefs.mode;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const pdfSide = prefs.pdfSide;
  /** 工具条菜单与首次引导里的「显示 PDF 栏」（插件里同一个开关叫「打开笔记时自动开 PDF」）：记住上次的选择 */
  const autoOpen = prefs.showPdf;
  const reducedMotion = prefs.reducedMotion;
  const placement = prefs.toolbar;
  const ratio = prefs.baseline;
  const [dockFrame, setDockFrame] = useState<DockFrame | null>(null);
  const [toolbarHeight, setToolbarHeight] = useState(40);
  const snapTarget = useRef<"markdown" | "pdf" | null>(null);
  /** 拖工具条时各窗格顶部显示停靠区；进入的那个变实线 */
  const [dockZones, setDockZones] = useState<{ active: "markdown" | "pdf" | null } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [notices, setNotices] = useState<Array<{ id: number; text: string }>>([]);
  const [binding, setBinding] = useState<string | null>(null);
  const [pickPdf, setPickPdf] = useState(false);
  const pendingOpen = useRef<OpenRequest | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  /** 导览气泡：首次引导「开始导览」的三步，或设置页「带我做」的一步 */
  const [coach, setCoach] = useState<{ steps: CoachStep[]; practice: "highlight" | "pageEdit" | null; completed: boolean } | null>(null);
  const coachRef = useRef(coach);
  coachRef.current = coach;
  const [pagemark, setPagemark] = useState<{ path: string; original: string; range: [number, number] } | null>(null);
  /** 只能说明、不能做的事（如 PDF 没有文字层），弹窗明说 */
  const [explain, setExplain] = useState<{ title: string; text: string } | null>(null);
  /** 「只对齐到页首」时，上次对齐过的页 */
  const lastAlignedPage = useRef<{ pdf: number | null; markdown: number | null }>({ pdf: null, markdown: null });
  const saveTimer = useRef<number | undefined>(undefined);
  const selectTimer = useRef<number | undefined>(undefined);
  const selectionFromPdf = useRef(false);
  const mdPaneRef = useRef<HTMLDivElement>(null);
  const pdfPaneRef = useRef<HTMLDivElement>(null);

  const notify = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setNotices((old) => [...old.slice(-3), { id, text }]);
    window.setTimeout(() => setNotices((old) => old.filter((item) => item.id !== id)), 4000);
  }, []);
  const notifyRef = useRef(notify);

  // ---------- 书与书内索引 ----------

  // 旧格式文件（只有印刷页锚点）按这本书的 printedPageOffset 换算物理页；没变时不做事
  setLegacyOffset(book?.printedPageOffset ?? null);

  const index: BookIndex | null = useMemo(() => {
    if (!book) return null;
    const entries = book.members.filter((path) => docs.current.has(path)).map((path) => indexEntry(path, docs.current.get(path)!.text));
    return buildBookIndex(book.pdf ?? "", "", entries, book.members, book.printedPageOffset);
    // docsVersion：文档内容变了要重建
  }, [book, docsVersion]);
  const indexRef = useRef(index);
  indexRef.current = index;

  const pdfPath = useMemo(() => {
    if (!book) return null;
    return book.markdown.find((item) => item.path === openPath)?.pdf ?? book.pdf;
  }, [book, openPath]);

  // ---------- 繁简通搜（PDF） ----------

  const [findOpen, setFindOpen] = useState(false);
  /** 最近一次点在哪栏：Ctrl+F 只在 PDF 栏接管，正文栏的不碰 */
  const lastPane = useRef<"pdf" | "markdown" | null>(null);
  // 一份 PDF（换文件或重新载入时换）一个查找器，文字只取一次
  const finder = useMemo(
    () => new PdfFinder({ pageCount: () => pdf.current?.pageCount ?? 0, pageText: (target) => pdf.current?.pageText(target) ?? Promise.resolve("") }),
    [pdfPath, pdfReloadKey]
  );
  const findSearch = useCallback(
    async (query: string, onProgress: (done: number, total: number) => void): Promise<FindResult> => {
      const current = prefsRef.current;
      const variants = { unihanTradSimp: current.unihanTradSimp, unihanZ: current.unihanZ, unihanSemantic: current.unihanSemantic };
      const hits = await finder.search(query, variants, onProgress);
      const pages = await finder.load();
      return { hits, noTextLayer: !hits.length && pages.every((text) => !text.trim()) };
    },
    [finder]
  );
  const findReveal = useCallback((hit: PdfHit) => {
    const handle = pdf.current;
    if (!handle) return;
    void handle.highlight({ page: hit.page, query: hit.text, context: { before: hit.before, after: hit.after } }, true).then((shown) => {
      if (!shown) handle.scrollToPoint({ page: hit.page, fraction: 0 });
    });
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!prefsRef.current.findTakeover || lastPane.current !== "pdf") return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      event.stopPropagation();
      setFindOpen(true);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  const refreshSaveState = useCallback(() => {
    const path = openPathRef.current;
    const doc = path ? docs.current.get(path) : null;
    const anyConflict = [...docs.current.values()].some((item) => item.conflict);
    if (anyConflict) setSaveState("conflict");
    else if (!doc) setSaveState("saved");
    else if (doc.saving !== null) setSaveState("saving");
    else if (doc.dirty) setSaveState("dirty");
    else setSaveState("saved");
  }, []);

  const loadDoc = useCallback(async (path: string) => {
    const snap = await fetchFile(path);
    docs.current.set(path, { text: snap.text, diskHash: snap.hash, dirty: false, saving: null, conflict: null });
  }, []);

  const reloadBook = useCallback(async () => {
    const info = await fetchBook();
    await Promise.all(info.markdown.filter((item) => !docs.current.has(item.path)).map((item) => loadDoc(item.path)));
    for (const path of [...docs.current.keys()]) if (!info.markdown.some((item) => item.path === path) && !docs.current.get(path)!.dirty) docs.current.delete(path);
    setBook(info);
    bumpDocs();
    return info;
  }, [loadDoc]);

  // ---------- 存盘 ----------

  const flushSave = useCallback(
    async (path: string | null) => {
      if (!path) return;
      const doc = docs.current.get(path);
      if (!doc || !doc.dirty || doc.saving !== null || doc.conflict) return;
      const text = doc.text;
      doc.saving = text;
      refreshSaveState();
      try {
        const result = await saveFile(path, text, doc.diskHash);
        doc.saving = null;
        if (result.ok) {
          doc.diskHash = result.hash;
          if (doc.text === text) doc.dirty = false;
          else saveTimer.current = window.setTimeout(() => void flushSave(path), SAVE_DELAY);
        } else {
          doc.conflict = result.conflict;
          setConflict({ path, mine: doc.text, disk: result.conflict.text });
          setConflictOpen(true);
        }
      } catch (error) {
        doc.saving = null;
        setSaveState("error");
        notify(`存盘失败：${(error as Error).message}`);
        return;
      }
      refreshSaveState();
    },
    [notify, refreshSaveState]
  );

  const scheduleSave = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    const path = openPathRef.current;
    saveTimer.current = window.setTimeout(() => void flushSave(path), SAVE_DELAY);
  }, [flushSave]);

  // 关页面前还有没存的：先存，并让浏览器提示
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const unsaved = [...docs.current.values()].some((doc) => doc.dirty || doc.conflict);
      if (!unsaved) return;
      void flushSave(openPathRef.current);
      event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [flushSave]);

  // ---------- 打开文件、跳页 ----------

  const openFile = useCallback(
    async (path: string) => {
      if (openPathRef.current === path) return;
      window.clearTimeout(saveTimer.current);
      await flushSave(openPathRef.current);
      if (!docs.current.has(path)) await loadDoc(path);
      openPathRef.current = path;
      setOpenPathState(path);
      editor.current?.reset(docs.current.get(path)!.text);
      refreshSaveState();
      await nextFrame();
    },
    [flushSave, loadDoc, refreshSaveState]
  );

  const updatePageInfo = useCallback((nextPage: number, fromAnchor: string | null) => {
    setPage(nextPage);
    setPrinted(printedLabel(indexRef.current, nextPage, fromAnchor));
    const cm = editor.current?.view;
    if (cm) {
      const point = editor.current?.pointAtBaseline();
      const text = cm.state.doc.toString();
      setChapter(headingBefore(text, point?.offset ?? 0)?.text ?? null);
    }
  }, []);

  const sync = useMemo(
    () =>
      new SyncController(
        {
          mode: () => modeRef.current,
          markdownPoint: () => editor.current?.pointAtBaseline() ?? null,
          pdfPoint: () => pdf.current?.pointAtBaseline() ?? null,
          scrollPdf: (point) => {
            if (prefsRef.current.proportional) return pdf.current?.scrollToPoint(point);
            // 只对齐到页首：换页时才滚
            if (lastAlignedPage.current.pdf === point.page) return;
            lastAlignedPage.current.pdf = point.page;
            pdf.current?.scrollToPoint({ page: point.page, fraction: 0 });
          },
          scrollMarkdown: (point) => {
            if (prefsRef.current.proportional) return editor.current?.scrollToPoint(point) ?? false;
            if (lastAlignedPage.current.markdown === point.page) return true;
            const done = editor.current?.scrollToPoint({ page: point.page, fraction: 0 }) ?? false;
            if (done) lastAlignedPage.current.markdown = point.page;
            return done;
          },
          openPageInOtherFile: async (point) => {
            const idx = indexRef.current;
            const entry = idx ? fileForPage(idx, point.page) : null;
            if (!entry || entry.path === openPathRef.current) return;
            await openFile(entry.path);
            editor.current?.scrollToPoint(point);
          },
          onPage: (nextPage, fromAnchor) => updatePageInfo(nextPage, fromAnchor),
        },
        QUIET_MS
      ),
    [openFile, updatePageInfo]
  );
  useEffect(() => () => sync.dispose(), [sync]);

  /** 两边一起跳到某页某处（◀ ▶、输入页码、点锚点标签、搜索结果） */
  const goToPage = useCallback(
    async (target: number, fraction = 0) => {
      const count = pdf.current?.pageCount || pageCount || 1;
      const nextPage = Math.min(Math.max(1, Math.round(target)), count);
      const point: PagePoint = { page: nextPage, fraction };
      const idx = indexRef.current;
      const entry = idx ? fileForPage(idx, nextPage) : null;
      if (entry && entry.path !== openPathRef.current) await openFile(entry.path);
      sync.holdBoth();
      editor.current?.scrollToPoint(point);
      pdf.current?.scrollToPoint(point);
      const segment = editor.current?.view ? segmentForPage(parsedDoc(editor.current.view.state.doc).segments, nextPage) : null;
      updatePageInfo(nextPage, segment?.printed ?? null);
      // 程序滚动后对侧静默期内的滚动事件已被忽略；这里再落一次，保证页码与底色对
      window.setTimeout(() => sync.holdBoth(), 0);
    },
    [openFile, pageCount, sync, updatePageInfo]
  );

  // 当前页底色
  useEffect(() => {
    editor.current?.setCurrentPage(page);
  }, [page, openPath, docsVersion]);

  // ---------- 疑字清单链接 / open 路由 ----------

  const openSuspect = useCallback(
    async (request: OpenRequest) => {
      const info = book;
      if (!info) return;
      const path = mapLinkFile(request.file, info.markdown.map((item) => item.path), info.members);
      const idx = indexRef.current;
      const target = path ?? (request.page && idx ? fileForPage(idx, request.page)?.path ?? null : null);
      if (!target) {
        notify(`书里找不到链接里的文件：${request.file}`);
        return;
      }
      if (request.page) await goToPage(request.page);
      if (target !== openPathRef.current) await openFile(target);
      const cm = editor.current?.view;
      if (!cm || !request.text) return;
      const parsed = parsedDoc(cm.state.doc);
      const segment = request.page ? segmentForPage(parsed.segments, request.page) : null;
      const from = segment?.from ?? 0;
      const slice = parsed.text.slice(from, segment?.to ?? parsed.text.length);
      const hit = locateSuspect(slice, request.text, request.ctx);
      if (!hit) {
        notify(`第 ${request.page ?? "?"} 页里没找到「${request.text}」`);
        return;
      }
      editor.current?.select(from + hit[0], from + hit[1], true);
    },
    [book, goToPage, notify, openFile]
  );

  const openSuspectUri = useCallback(
    (uri: string) => {
      const link = parseSuspectLink(uriParams(uri));
      if (!link) return;
      const url = `/open?file=${encodeURIComponent(link.file)}&page=${link.page ?? ""}&text=${encodeURIComponent(link.text)}&ctx=${encodeURIComponent(link.ctx)}`;
      history.pushState(null, "", url);
      void openSuspect({ file: link.file, page: link.page, text: link.text, ctx: link.ctx });
    },
    [openSuspect]
  );

  // ---------- 启动 ----------

  useEffect(() => {
    if (token === undefined) return;
    if (!token) {
      setFatal("没有拿到令牌。请用启动命令打印出来的网址（或它自动打开的那个标签页）进入；每次启动令牌都会换新。");
      return;
    }
    pendingOpen.current = openRequestFromLocation(window.location);
    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await fetchSettings();
        const loaded = normalizePrefs(snapshot.prefs);
        prefsRef.current = loaded;
        setPrefs(loaded);
        setSettingsInfo(snapshot);
        const info = await reloadBook();
        await nextFrame(); // 等编辑器挂上
        if (cancelled) return;
        const request = pendingOpen.current;
        const linked = request ? mapLinkFile(request.file, info.markdown.map((item) => item.path), info.members) : null;
        const first =
          linked ??
          info.members.find((path) => /<!--\s*pdf-page\.\d+/.test(docs.current.get(path)?.text ?? "")) ??
          info.members[0] ??
          info.markdown[0]?.path ??
          null;
        if (first) await openFile(first);
        // 第一次打开：弹四步引导，只弹一次（「跳过」也算看过）
        if (!loaded.onboarded) {
          setOnboardingOpen(true);
          updatePrefs({ onboarded: true });
        }
      } catch (error) {
        setFatal(
          error instanceof ApiError && error.status === 401
            ? "令牌对不上。请用 npm run workbench 自动打开的那个浏览器标签页进入；如果删过或改过用户配置文件里的令牌，要从启动命令重新打开一次。"
            : `打不开这本书：${(error as Error).message}`
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, reloadBook, openFile, updatePrefs]);

  // PDF 就绪后：处理 /open 请求，否则让 PDF 跟上正文
  const onPdfReady = useCallback(
    (count: number) => {
      setPageCount(count);
      void (async () => {
        await nextFrame();
        const request = pendingOpen.current;
        pendingOpen.current = null;
        if (request && book) {
          await openSuspect(request);
          history.replaceState(null, "", "/");
          return;
        }
        const point = editor.current?.pointAtBaseline();
        if (point) {
          sync.holdBoth();
          pdf.current?.scrollToPoint(point);
          updatePageInfo(point.page, point.printed);
        }
      })();
    },
    [book, openSuspect, sync, updatePageInfo]
  );

  // ---------- 磁盘改动推送 ----------

  const onChange = useCallback(
    async (event: ChangeEvent) => {
      const lower = event.path.toLowerCase();
      if (lower.endsWith(".pdf")) {
        if (event.type !== "change") await reloadBook();
        if (event.path === pdfPath) {
          setPdfReloadKey((key) => key + 1);
          notify("PDF 在磁盘上换了，已重新载入");
        }
        return;
      }
      if (event.path === "_数据/book.json") {
        await reloadBook();
        notify("book.json 改了，已重新配对");
        return;
      }
      if (event.type === "unlink") {
        const doc = docs.current.get(event.path);
        if (doc && !doc.dirty) docs.current.delete(event.path);
        notify(`磁盘上删掉了「${event.path}」${doc?.dirty ? "；网页里还有没存的改动，存盘时会重新建出这个文件" : ""}`);
        await reloadBook();
        return;
      }
      let text = event.text;
      if (text === undefined) text = (await fetchFile(event.path)).text;
      const hash = event.hash ?? "";
      const doc = docs.current.get(event.path);
      if (!doc) {
        await reloadBook();
        return;
      }
      if (hash === doc.diskHash) return; // 自己刚存的
      if (doc.saving !== null && text === doc.saving) return; // 自己正在存的那份，回声
      if (text === doc.text) {
        doc.diskHash = hash;
        doc.dirty = false;
        doc.conflict = null;
        refreshSaveState();
        return;
      }
      if (!doc.dirty && doc.saving === null) {
        doc.text = text;
        doc.diskHash = hash;
        if (event.path === openPathRef.current) editor.current?.merge(text);
        bumpDocs();
        notify(`「${event.path}」在磁盘上改了，已刷新`);
        return;
      }
      // 网页里有没存的改动，磁盘上又变了：冲突，交给用户选
      window.clearTimeout(saveTimer.current);
      doc.conflict = { text, hash };
      setConflict({ path: event.path, mine: doc.text, disk: text });
      setConflictOpen(true);
      refreshSaveState();
    },
    [notify, pdfPath, refreshSaveState, reloadBook]
  );
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!token) return;
    return subscribeChanges(
      (event) => void onChangeRef.current(event),
      (state) => setConnected(state)
    );
  }, [token]);

  // ---------- 冲突处理 ----------

  const resolveConflict = useCallback(
    async (keep: "mine" | "disk") => {
      if (!conflict) return;
      const doc = docs.current.get(conflict.path);
      if (!doc || !doc.conflict) {
        setConflict(null);
        return;
      }
      if (keep === "disk") {
        doc.text = doc.conflict.text;
        doc.diskHash = doc.conflict.hash;
        doc.dirty = false;
        doc.conflict = null;
        if (conflict.path === openPathRef.current) editor.current?.merge(doc.text);
        notify("已改用磁盘上的版本");
      } else {
        doc.conflict = null;
        const text = doc.text;
        doc.saving = text;
        const result = await saveFile(conflict.path, text, null, true);
        doc.saving = null;
        if (result.ok) {
          doc.diskHash = result.hash;
          doc.dirty = doc.text !== text;
        }
        notify("已用网页里的版本覆盖磁盘");
      }
      setConflict(null);
      setConflictOpen(false);
      bumpDocs();
      refreshSaveState();
    },
    [conflict, notify, refreshSaveState]
  );

  // ---------- 编辑器、PDF 的回调 ----------

  const onDocChange = useCallback(
    (text: string) => {
      const path = openPathRef.current;
      const doc = path ? docs.current.get(path) : null;
      if (!doc) return;
      doc.text = text;
      doc.dirty = true;
      if (doc.conflict) {
        // 冲突还没处理又接着改：对话框里的「网页里的」跟着更新
        setConflict((old) => (old && old.path === path ? { ...old, mine: text } : old));
      } else scheduleSave();
      refreshSaveState();
      bumpDocs();
    },
    [refreshSaveState, scheduleSave]
  );

  const onEditorSelection = useCallback((selection: EditorSelectionInfo | null) => {
    window.clearTimeout(selectTimer.current);
    if (selectionFromPdf.current) {
      selectionFromPdf.current = false;
      return;
    }
    selectTimer.current = window.setTimeout(() => {
      const cm = editor.current?.view;
      if (!selection || !cm || !selection.text.trim() || selection.text.length > 400) {
        pdf.current?.clearHighlight();
        return;
      }
      const parsed = parsedDoc(cm.state.doc);
      const point = parsed.segments.length ? parsed.segments.filter((segment) => segment.from <= selection.from).pop() : null;
      if (!point) return;
      const progress = point.to > point.from ? (selection.from - point.from) / (point.to - point.from) : 0;
      void pdf.current
        ?.highlight(
          {
            page: point.page,
            query: selection.text,
            context: { before: selection.doc.slice(Math.max(0, selection.from - 60), selection.from), after: selection.doc.slice(selection.to, selection.to + 60), progress },
          },
          true
        )
        .then((shown) => {
          if (shown) practicedRef.current("highlight");
        });
    }, 180);
  }, []);

  const onPdfSelect = useCallback(
    async (selection: PdfTextSelection) => {
      const idx = indexRef.current;
      const entry = idx ? fileForPage(idx, selection.page) : null;
      if (entry && entry.path !== openPathRef.current) {
        sync.holdBoth();
        await openFile(entry.path);
      }
      const cm = editor.current?.view;
      if (!cm) return;
      const parsed = parsedDoc(cm.state.doc);
      const segment = segmentForPage(parsed.segments, selection.page);
      if (!segment) return;
      const match = matchSegmentSlices([parsed.text.slice(segment.from, segment.to)], selection.query, selection.context);
      const slice = match?.slices[0];
      if (!slice) return;
      selectionFromPdf.current = true;
      sync.holdBoth();
      editor.current?.select(segment.from + slice.startOffset, segment.from + slice.endOffset, true);
    },
    [openFile, sync]
  );

  const onSearchHit = useCallback(
    async (hit: SearchHit) => {
      if (hit.source === "md" && hit.path) {
        await openFile(hit.path);
        sync.holdBoth();
        editor.current?.select(hit.start, hit.end, true);
        updatePageInfo(hit.page, hit.printed);
        return;
      }
      await goToPage(hit.page, hit.context.progress ?? 0);
      void pdf.current?.highlight({ page: hit.page, query: hit.match, context: hit.context }, true);
      const cm = editor.current?.view;
      if (!cm) return;
      const parsed = parsedDoc(cm.state.doc);
      const segment = segmentForPage(parsed.segments, hit.page);
      if (!segment) return;
      const match = matchSegmentSlices([parsed.text.slice(segment.from, segment.to)], hit.match, hit.context);
      const slice = match?.slices[0];
      if (slice) {
        selectionFromPdf.current = true;
        editor.current?.select(segment.from + slice.startOffset, segment.from + slice.endOffset, true);
      }
    },
    [goToPage, openFile, sync, updatePageInfo]
  );

  const pageText = useCallback((n: number) => pdf.current?.pageText(n) ?? Promise.resolve(""), []);

  // ---------- 工具条 ----------

  const setMode = useCallback((next: SyncMode) => {
    modeRef.current = next;
    updatePrefs({ mode: next });
  }, []);

  const savePlacement = useCallback((next: ToolbarPlacement & { dock: "markdown" | "pdf" }) => {
    updatePrefs({ toolbar: next });
  }, []);

  const paneFor = useCallback((target: "markdown" | "pdf") => (target === "markdown" ? mdPaneRef.current : pdfPaneRef.current), []);

  // 停靠框：所停窗格的顶部（窗格大小一变就重量）
  useEffect(() => {
    const element = paneFor(placement.dock);
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setDockFrame((old) => (old && old.left === rect.left && old.top === rect.top && old.width === rect.width ? old : { left: rect.left, top: rect.top, width: rect.width }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [placement.dock, pdfSide, paneFor, book]);

  const actions: ToolbarActions = useMemo(
    () => ({
      jump: (target) => void goToPage(target),
      step: (delta) => {
        void goToPage(page + delta);
        practicedRef.current("pageEdit");
      },
      setMode,
      setAutoOpen: (value) => {
        updatePrefs({ showPdf: value });
      },
      swapSide: () =>
        updatePrefs({ pdfSide: prefsRef.current.pdfSide === "left" ? "right" : "left" }),
      zoom: (delta) => {
        const handle = pdf.current;
        if (!handle) return;
        if (delta === null) handle.setScale("page-width");
        else handle.setScale(handle.scale + delta);
      },
      rebind: () => setPickPdf(true),
      find: () => setFindOpen(true),
      setCollapsed: (collapsed) => savePlacement({ ...placement, collapsed }),
      dragStart: () => setDockZones({ active: null }),
      dragMove: (pointerX, _pointerY, barTop) => {
        snapTarget.current = null;
        for (const target of ["markdown", "pdf"] as const) {
          const rect = paneFor(target)?.getBoundingClientRect();
          if (rect && pointerX >= rect.left && pointerX <= rect.right && Math.abs(barTop - rect.top) <= SNAP_DISTANCE) snapTarget.current = target;
        }
        setDockZones((old) => (old && old.active === snapTarget.current ? old : { active: snapTarget.current }));
        return snapTarget.current !== null;
      },
      dragEnd: (_pointerX, _pointerY, x, y) => {
        const target = snapTarget.current;
        snapTarget.current = null;
        setDockZones(null);
        if (target) savePlacement({ ...placement, mode: "docked", dock: target });
        else savePlacement({ ...placement, mode: "floating", x: Math.max(0, x), y: Math.max(0, y) });
      },
      resize: (_width, height) => setToolbarHeight((old) => (Math.abs(old - height) < 0.5 ? old : height)),
    }),
    [goToPage, page, paneFor, placement, savePlacement, setMode]
  );

  const status: ToolbarStatus = {
    page,
    pageCount,
    printed,
    chapter,
    scale,
    mode,
    pdfName: pdfPath ? pdfPath.slice(pdfPath.lastIndexOf("/") + 1) : "（没有配对）",
    pdfSide,
    autoOpen,
  };

  const copyRevision = useCallback(async () => {
    const cm = editor.current?.view;
    const path = openPathRef.current;
    if (!cm || !path || !book) return;
    const parsed = parsedDoc(cm.state.doc);
    const segment = segmentForPage(parsed.segments, page);
    const sep = book.root.includes("\\") ? "\\" : "/";
    const text = buildRevisionRequest({
      notePath: `${book.root}${sep}${path.split("/").join(sep)}`,
      pdfPath: pdfPath ? `${book.root}${sep}${pdfPath.split("/").join(sep)}` : "",
      page,
      printed,
      segment: segment ? parsed.text.slice(segment.from, segment.to) : "",
      selection: cm.state.sliceDoc(cm.state.selection.main.from, cm.state.selection.main.to),
    });
    try {
      await navigator.clipboard.writeText(text);
      notify(`已复制第 ${page} 页的修订请求，粘给 Claude Code 即可`);
    } catch {
      notify("浏览器不让写剪贴板");
    }
  }, [book, notify, page, pdfPath, printed]);

  const bindPdf = useCallback(
    async (files: string[]) => {
      const target = binding;
      if (!target) return;
      let failed = 0;
      for (const path of files) {
        if (!docs.current.has(path)) await loadDoc(path);
        const doc = docs.current.get(path)!;
        const next = setFrontmatterPdf(doc.text, target);
        if (next === doc.text) continue;
        const result = await saveFile(path, next, doc.dirty ? doc.diskHash : doc.diskHash);
        if (result.ok) {
          doc.text = next;
          doc.diskHash = result.hash;
          doc.dirty = false;
          if (path === openPathRef.current) editor.current?.merge(next);
        } else failed += 1;
      }
      notify(failed ? `${failed} 个文件磁盘上刚被改过，没写；请重试` : `已把 ${files.length} 个文件配到 ${target}`);
      await reloadBook();
    },
    [binding, loadDoc, notify, reloadBook]
  );

  // ---------- 首次引导、导览、上手 ----------

  /** 首次引导「开始导览」：在真界面上走三步气泡（目标与 S3 的 onboarding-host.tsx 相同） */
  const startTour = useCallback(() => {
    if (prefsRef.current.toolbar.collapsed) updatePrefs({ toolbar: { ...prefsRef.current.toolbar, collapsed: false } });
    const find = (selector: string) => () => document.querySelector<HTMLElement>(`.aps-toolbar ${selector}`);
    setCoach({
      practice: null,
      completed: false,
      steps: [
        { target: find(".aps-grip"), text: "这是工具条：按住左端把手能拖开，拖近正文或 PDF 栏顶部就停靠过去" },
        { target: find(".aps-page-input"), text: "点页码数字可以直接输入页数，回车后两边一起跳" },
        { target: find(".aps-seg"), text: "这里切换联动方式：双向、单向、暂停" },
      ],
    });
  }, [updatePrefs]);

  /** 设置页「带我做」：在正文或工具条上提示，做到了打勾并记下 */
  const startPractice = useCallback((id: "highlight" | "pageEdit") => {
    const target =
      id === "highlight" ? () => document.querySelector<HTMLElement>(".aih-editor .cm-content") : () => document.querySelector<HTMLElement>(".aps-toolbar .aps-stepper");
    const text = id === "highlight" ? "在正文里选中几个字，PDF 上同样的字会高亮" : "点工具条上的 ‹ › 两边一起翻一页；当前页正文有浅底色，直接在里面改字";
    setCoach({ practice: id, completed: false, steps: [{ target, text }] });
  }, []);

  const practiced = useCallback(
    (id: "highlight" | "pageEdit") => {
      const current = coachRef.current;
      if (!current || current.practice !== id) return;
      setCoach({ ...current, completed: true });
      if (!prefsRef.current.practice[id]) updatePrefs({ practice: { ...prefsRef.current.practice, [id]: true } });
    },
    [updatePrefs]
  );
  const practicedRef = useRef(practiced);
  practicedRef.current = practiced;

  // ---------- 补页码锚点 ----------

  const openPagemarks = useCallback(async () => {
    const path = openPathRef.current;
    const handle = pdf.current;
    if (!path || !book) return;
    if (!handle?.ready || !pdfPath) {
      setExplain({ title: "补不了页码锚点", text: "这篇笔记没有配上 PDF，或 PDF 还没打开好。先在工具条 ⋯ 菜单里配好 PDF，或把 PDF 栏显示出来。" });
      return;
    }
    // 先把手上的改动存掉，预览与写入都以磁盘上这一版为准
    window.clearTimeout(saveTimer.current);
    await flushSave(path);
    const doc = docs.current.get(path);
    if (!doc || doc.dirty || doc.conflict) {
      setExplain({ title: "先处理没存上的改动", text: "这篇笔记还有没存上的改动或冲突，处理完再补锚点。" });
      return;
    }
    const count = handle.pageCount;
    const range = indexRef.current ? suggestedPageRange(indexRef.current, path, count) : ([1, count] as [number, number]);
    const layer = await checkTextLayer(range[0], range[1], (n) => handle.pageText(n));
    if (!layer.ok) {
      setExplain({
        title: "这份 PDF 没有文字层",
        text:
          `抽看了第 ${layer.sampled.map(([n]) => n).join("、")} 页，都读不出文字（多半是扫描件）。补锚点要靠 PDF 文字层找每页开头，所以这里不硬做。` +
          "请先用 lunzhu2md 给它做一份文字层副本（<原件>.文字层.pdf），把这本书配到副本上，再来补。",
      });
      return;
    }
    setPagemark({ path, original: doc.text, range });
  }, [book, flushSave, pdfPath]);

  const writePagemarks = useCallback(
    async (path: string, original: string, proposals: Parameters<typeof applyChecked>[1]) => {
      const doc = docs.current.get(path);
      if (!doc) return;
      if (doc.text !== original || doc.dirty) {
        notify("预览之后笔记又改过，没有写入；请重新预览");
        return;
      }
      const checked = applyChecked(original, proposals);
      if (!checked.ok) {
        setExplain({ title: "没有写入", text: `核对没过：${checked.reason}。补锚点只许插锚点、不改正文，所以停下了；请把这个情况告诉对话里的 AI 或检查笔记。` });
        return;
      }
      const result = await saveFile(path, checked.text, doc.diskHash);
      if (!result.ok) {
        notify("磁盘上的笔记刚被改过，没有写入；请重新预览");
        return;
      }
      doc.text = checked.text;
      doc.diskHash = result.hash;
      doc.dirty = false;
      if (path === openPathRef.current) editor.current?.merge(checked.text);
      bumpDocs();
      notify(`已插入 ${proposals.length} 个页码锚点`);
    },
    [notify]
  );

  // ---------- 画面 ----------

  if (fatal) return <Fatal message={fatal} />;
  if (!book) return <Fatal message="正在打开书……" quiet />;

  const docked = placement.mode === "docked" && !placement.collapsed;
  const spacer = (target: "markdown" | "pdf") => (
    <>
      {docked && placement.dock === target ? <div style={{ height: toolbarHeight + DOCK_INSET.top * 2 }} className="shrink-0" /> : null}
    </>
  );

  const mdPanel = (
    <Panel id="markdown" minSize="20%" defaultSize="50%">
      <div className="relative flex h-full flex-col" onPointerDownCapture={() => (lastPane.current = "markdown")}>
        <div ref={mdPaneRef} className="shrink-0" />
        {spacer("markdown")}
        <div className="min-h-0 flex-1">
          <EditorPane
            ref={editor}
            ratio={ratio}
            pageLabels={prefs.pageLabels}
            shade={prefs.shade}
            onDocChange={onDocChange}
            onScroll={() => sync.scrolled("markdown")}
            onUserInput={() => sync.input("markdown")}
            onSelection={onEditorSelection}
            onPageLabel={(target) => void goToPage(target)}
            onSuspectLink={openSuspectUri}
          />
        </div>
      </div>
    </Panel>
  );
  const pdfPanel = (
    <Panel id="pdf" minSize="20%" defaultSize="50%">
      <div className="relative flex h-full flex-col" onPointerDownCapture={() => (lastPane.current = "pdf")}>
        {findOpen && pdfPath ? (
          <FindBar key={`${pdfPath}#${pdfReloadKey}`} search={findSearch} reveal={findReveal} onClose={() => setFindOpen(false)} />
        ) : null}
        <div ref={pdfPaneRef} className="shrink-0" />
        {spacer("pdf")}
        <div className="min-h-0 flex-1">
          <PdfPane
            ref={pdf}
            path={pdfPath}
            reloadKey={pdfReloadKey}
            ratio={ratio}
            onScroll={() => sync.scrolled("pdf")}
            onUserInput={() => sync.input("pdf")}
            onReady={onPdfReady}
            onScaleChange={setScale}
            onTextSelect={(selection) => void onPdfSelect(selection)}
            onError={notify}
          />
        </div>
      </div>
    </Panel>
  );

  const fileGroups = [
    { label: "本书", paths: book.members },
    { label: "其他", paths: book.markdown.map((item) => item.path).filter((path) => !book.members.includes(path)) },
  ].filter((group) => group.paths.length);

  return (
    <div className="flex h-dvh flex-col bg-[var(--background-primary)] text-[var(--text-normal)]">
      <header className="aih-header">
        <div className="aih-title" title={book.root}>
          {book.title}
        </div>
        <Menu.Root>
          <Menu.Trigger className="aih-file-trigger" data-testid="file-menu">
            {openPath ?? "选文件"}
            <span aria-hidden="true">▾</span>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner className="aps-menu-positioner" sideOffset={6} align="start">
              <Menu.Popup className="aps-menu aih-file-menu">
                {fileGroups.map((group) => (
                  <Menu.Group key={group.label}>
                    <Menu.GroupLabel className="aih-menu-label">{group.label}</Menu.GroupLabel>
                    {group.paths.map((path) => {
                      const entry = index?.files.find((item) => item.path === path);
                      return (
                        <Menu.Item key={path} className="aps-menu-item aih-file-item" onClick={() => void openFile(path)}>
                          <span>{path}</span>
                          {entry?.minPage ? <span className="aps-muted">PDF {entry.minPage}–{entry.maxPage}</span> : null}
                          {docs.current.get(path)?.dirty ? <span className="aih-dot" title="有没存的改动" /> : null}
                        </Menu.Item>
                      );
                    })}
                  </Menu.Group>
                ))}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        <SearchBox
          markdown={book.markdown.map((item) => ({ path: item.path, text: docs.current.get(item.path)?.text ?? "" }))}
          pageCount={pageCount}
          pageText={pageText}
          pdfKey={`${pdfPath}:${pdfReloadKey}`}
          onChoose={(hit) => void onSearchHit(hit)}
        />
        <div className="ml-auto flex items-center gap-2">
          {/* 补锚点要写盘，演示站没有盘可写 */}
          {!DEMO && (
            <button type="button" className="aih-button" onClick={() => void openPagemarks()} title="给没有物理页锚点的笔记，按 PDF 文字层找每页开头补上 <!--pdf-page.N-->；先预览，确认才写">
              补页码锚点
            </button>
          )}
          <button type="button" className="aih-button" data-testid="open-settings" onClick={() => setSettingsOpen(true)}>
            设置
          </button>
          <button type="button" className="aih-button" onClick={() => void copyRevision()} title="把本页的定位信息复制下来，粘给 Claude Code 的 lunzhu2md-fix">
            复制本页修订请求
          </button>
          {DEMO ? <span className="aih-save" title="演示站只读：改动不会保存">只读</span> : <SaveChip state={saveState} onOpenConflict={() => setConflictOpen(true)} />}
        </div>
      </header>
      {book.bookJsonError && <div className="aih-banner">{book.bookJsonError}</div>}
      <main className="min-h-0 flex-1">
        <Group orientation="horizontal" className="h-full">
          {autoOpen ? (
            <>
              {pdfSide === "left" ? pdfPanel : mdPanel}
              <Separator className="aih-separator" />
              {pdfSide === "left" ? mdPanel : pdfPanel}
            </>
          ) : (
            mdPanel
          )}
        </Group>
      </main>
      <footer className="aih-statusbar" data-testid="statusbar">
        <span data-testid="status-page">
          PDF 第 {page} 页{printed ? ` · 原书 p.${printed}` : ""}
        </span>
        <span>{openPath}</span>
        <span className={DEMO || connected ? "aih-ok" : "aih-warn"}>{DEMO ? "● 演示站 · 只读（样例书《新史學》）" : connected ? "● 已连上本机服务" : "○ 本机服务断开，重连中"}</span>
      </footer>
      {dockZones &&
        (["markdown", "pdf"] as const).map((target) => {
          const rect = paneFor(target)?.getBoundingClientRect();
          if (!rect) return null;
          // S3 的停靠区是 position: fixed，按窗口坐标给
          return (
            <div
              key={target}
              className={`aps-dock-zone${dockZones.active === target ? " is-active" : ""}`}
              style={{ left: rect.left + 6, top: rect.top + 2, width: rect.width - 12, height: toolbarHeight + DOCK_INSET.top * 2 }}
            />
          );
        })}
      <Toolbar status={status} placement={placement} dock={dockFrame} reducedMotion={reducedMotion} portalContainer={document.body} actions={actions} autoOpenLabel="显示 PDF 栏" />
      <SettingsDialog
        open={settingsOpen}
        prefs={prefs}
        info={settingsInfo}
        onChange={updatePrefs}
        onPort={async (port) => {
          try {
            setSettingsInfo(await saveSettings({ port }));
            return null;
          } catch (error) {
            return (error as Error).message;
          }
        }}
        onReopenGuide={() => {
          setSettingsOpen(false);
          setOnboardingOpen(true);
        }}
        onPractice={(id) => {
          setSettingsOpen(false);
          startPractice(id);
        }}
        onClose={() => setSettingsOpen(false)}
      />
      {onboardingOpen && (
        <Onboarding
          initial={onboardingValues(prefs)}
          books={[{ key: book.root, title: book.title, folder: book.root, paired: !!book.pdf }]}
          container={document.body}
          autoOpenLabel={{ label: "显示 PDF 栏", hint: "收起后只留正文；记住上次的选择" }}
          onSkip={() => setOnboardingOpen(false)}
          onFinish={(values) => {
            setOnboardingOpen(false);
            updatePrefs(prefsFromOnboarding(prefsRef.current, values));
            notify("设置已保存；引导可在设置里重开");
          }}
          onStartTour={(values) => {
            setOnboardingOpen(false);
            updatePrefs(prefsFromOnboarding(prefsRef.current, values));
            window.setTimeout(startTour, 400);
          }}
          onBind={(values) => {
            setOnboardingOpen(false);
            updatePrefs(prefsFromOnboarding(prefsRef.current, values));
            setPickPdf(true);
          }}
        />
      )}
      {coach && (
        <Coachmark
          steps={coach.steps}
          reducedMotion={reducedMotion}
          waitForAction={coach.practice !== null}
          completed={coach.completed}
          onDone={() => setCoach(null)}
        />
      )}
      {pagemark && (
        <PagemarkDialog
          filePath={pagemark.path}
          pageCount={pdf.current?.pageCount ?? pageCount}
          range={pagemark.range}
          container={document.body}
          reducedMotion={reducedMotion}
          plan={async (from, to) => {
            const pages: Array<[number, string]> = [];
            for (let n = from; n <= to; n += 1) pages.push([n, (await pdf.current?.pageText(n)) ?? ""]);
            return planPagemarks(pagemark.original, pages);
          }}
          write={(proposals) => writePagemarks(pagemark.path, pagemark.original, proposals)}
          onClose={() => setPagemark(null)}
        />
      )}
      {explain && (
        <div className="aps-dialog-backdrop" onClick={() => setExplain(null)}>
          <div className="aps-dialog aih-explain" role="alertdialog" aria-label={explain.title} onClick={(event) => event.stopPropagation()}>
            <div className="aps-dialog-title">{explain.title}</div>
            <p className="aih-explain-text">{explain.text}</p>
            <div className="aps-dialog-buttons">
              <button type="button" className="aps-button mod-cta" onClick={() => setExplain(null)}>
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
      <ConflictDialog
        conflict={conflict}
        open={conflictOpen}
        onKeepMine={() => void resolveConflict("mine")}
        onTakeDisk={() => void resolveConflict("disk")}
        onLater={() => setConflictOpen(false)}
      />
      {pickPdf && (
        <PdfPicker
          pdfs={book.pdfs}
          current={pdfPath}
          onPick={(path) => {
            setPickPdf(false);
            setBinding(path);
          }}
          onClose={() => setPickPdf(false)}
        />
      )}
      {binding && (
        <BindDialog
          pdfPath={binding}
          files={book.members.length ? book.members : book.markdown.map((item) => item.path)}
          container={document.body}
          reducedMotion={reducedMotion}
          onConfirm={(files) => void bindPdf(files)}
          onClose={() => setBinding(null)}
        />
      )}
      <div className="aih-notices" aria-live="polite">
        {notices.map((item) => (
          <div key={item.id} className="aih-notice" data-testid="notice">
            {item.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function SaveChip({ state, onOpenConflict }: { state: SaveState; onOpenConflict: () => void }) {
  const labels: Record<SaveState, string> = { saved: "已存盘", dirty: "未存", saving: "存盘中…", error: "存盘失败", conflict: "有冲突，点此处理" };
  if (state === "conflict")
    return (
      <button type="button" className="aih-save aih-save-conflict" data-testid="save-state" data-state={state} onClick={onOpenConflict}>
        {labels[state]}
      </button>
    );
  return (
    <span className={`aih-save aih-save-${state}`} data-testid="save-state" data-state={state}>
      {labels[state]}
    </span>
  );
}

function PdfPicker({ pdfs, current, onPick, onClose }: { pdfs: string[]; current: string | null; onPick: (path: string) => void; onClose: () => void }) {
  return (
    <div className="aps-dialog-backdrop" onClick={onClose}>
      <div className="aps-dialog aih-picker" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="选 PDF">
        <div className="aps-dialog-title">选这本书配对的 PDF</div>
        {pdfs.length ? (
          pdfs.map((path) => (
            <button key={path} type="button" className="aps-menu-item aih-file-item" onClick={() => onPick(path)}>
              {path}
              {path === current ? <span className="aps-muted">（现在的）</span> : null}
            </button>
          ))
        ) : (
          <p className="aps-muted">书文件夹里没有 PDF。</p>
        )}
        <div className="aps-dialog-buttons">
          <button type="button" className="aps-button" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

function Fatal({ message, quiet }: { message: ReactNode; quiet?: boolean }) {
  return (
    <div className="flex h-dvh items-center justify-center bg-[var(--background-primary)] p-8 text-center">
      <p className={quiet ? "text-[var(--text-muted)]" : "max-w-xl text-[var(--text-normal)]"}>{message}</p>
    </div>
  );
}
