"use client";
/**
 * 设置页（照 design/onboarding-settings-approved.html 的「设置页」）：顶部插件名 +「重新打开引导」+ 实时预览，
 * 分组 布局 / 联动 / 外观 / 上手，另加网页特有的「本机服务」（端口）。
 * 预览、分段选择、勾选行、上手清单都用 S3 ui/ 的组件；网页用不上的（Obsidian 设置搜索、原生子页、frontmatter 键名等）不做。
 */
import { Dialog } from "@base-ui/react/dialog";
import { MotionConfig, motion } from "motion/react";
import { useState } from "react";
import type { SettingsSnapshot } from "./api";
import { DEMO } from "./api";
import { dockChoiceOf, withDockChoice, type WebPrefs } from "./prefs";
import { CheckRow, ChoiceRow, GettingStarted, SettingsHeader, SPRING } from "@/s3/ui";

interface Props {
  open: boolean;
  prefs: WebPrefs;
  info: SettingsSnapshot | null;
  onChange: (patch: Partial<WebPrefs>) => void;
  onPort: (port: number) => Promise<string | null>;
  onReopenGuide: () => void;
  onPractice: (id: "highlight" | "pageEdit") => void;
  onClose: () => void;
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="aih-settings-group">
      <h3 className="aih-settings-group-title">{title}</h3>
      {children}
    </section>
  );
}

export function SettingsDialog({ open, prefs, info, onChange, onPort, onReopenGuide, onPractice, onClose }: Props) {
  const [portDraft, setPortDraft] = useState<string | null>(null);
  const [portMessage, setPortMessage] = useState<string | null>(null);
  const dock = dockChoiceOf(prefs.toolbar);
  const running = info?.runningPort ?? null;
  return (
    <MotionConfig reducedMotion={prefs.reducedMotion ? "always" : "user"}>
      <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
        <Dialog.Portal container={typeof document === "undefined" ? null : document.body}>
          <Dialog.Backdrop className="aps-dialog-backdrop" />
          <Dialog.Popup
            className="aps-dialog aih-settings"
            data-testid="settings-dialog"
            render={<motion.div initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={SPRING} />}
          >
            <Dialog.Title className="aih-visually-hidden">设置</Dialog.Title>
            <Dialog.Close className="aps-dialog-close" aria-label="关闭">×</Dialog.Close>
            <SettingsHeader
              title="AIhistory 工作台"
              preview={{ pdfSide: prefs.pdfSide, dock, mode: prefs.mode, pageLabels: prefs.pageLabels, shade: prefs.shade, reducedMotion: prefs.reducedMotion }}
              onReopen={onReopenGuide}
            />
            <Group title="布局">
              <ChoiceRow title="PDF 放哪边" value={prefs.pdfSide} onChange={(value) => onChange({ pdfSide: value })} options={[{ value: "left", label: "左" }, { value: "right", label: "右" }]} />
              <ChoiceRow
                title="工具条默认位置"
                value={dock}
                onChange={(value) => onChange({ toolbar: withDockChoice(prefs.toolbar, value) })}
                options={[{ value: "markdown", label: "正文顶部" }, { value: "pdf", label: "PDF 顶部" }, { value: "floating", label: "悬浮" }]}
              >
                <span className="aps-hint">拖动后会记住新位置</span>
              </ChoiceRow>
            </Group>
            <Group title="联动">
              <ChoiceRow title="联动方式" value={prefs.mode} onChange={(value) => onChange({ mode: value })} options={[{ value: "both", label: "双向" }, { value: "one", label: "单向" }, { value: "paused", label: "暂停" }]} />
              <CheckRow label="显示 PDF 栏" hint="收起后只留正文；记住上次的选择" checked={prefs.showPdf} onChange={(value) => onChange({ showPdf: value })} />
              <CheckRow label="页内按比例跟随" hint="关掉则只在换页时对齐到页首" checked={prefs.proportional} onChange={(value) => onChange({ proportional: value })} />
              <div className="aps-row">
                <span>
                  跟随基准线 <span className="aps-hint aih-inline-hint">正文视口从顶往下的位置</span>
                </span>
                <div className="aih-range">
                  <input
                    type="range"
                    min={20}
                    max={50}
                    step={1}
                    aria-label="跟随基准线"
                    value={Math.round(prefs.baseline * 100)}
                    onChange={(event) => onChange({ baseline: Number(event.currentTarget.value) / 100 })}
                  />
                  <span className="aih-range-value">{Math.round(prefs.baseline * 100)}%</span>
                </div>
              </div>
            </Group>
            <Group title="外观">
              <CheckRow label="正文里显示页码标签" checked={prefs.pageLabels} onChange={(value) => onChange({ pageLabels: value })} />
              <CheckRow label="当前页加浅底色" checked={prefs.shade} onChange={(value) => onChange({ shade: value })} />
              <CheckRow label="减少动效" hint="系统开了「减少动态效果」时自动减少" checked={prefs.reducedMotion} onChange={(value) => onChange({ reducedMotion: value })} />
            </Group>
            <Group title="繁简通搜">
              <CheckRow label="PDF 栏里的 Ctrl+F 用繁简通搜" hint="繁体、简体、异体都算同一个字，跨行也找得到；关掉则用浏览器自带的查找（只认字面）。正文里的 Ctrl+F 不受影响" checked={prefs.findTakeover} onChange={(value) => onChange({ findTakeover: value })} />
              <CheckRow label="繁简对应" hint="如 鄴／邺、於／于、後／后" checked={prefs.unihanTradSimp} onChange={(value) => onChange({ unihanTradSimp: value })} />
              <CheckRow label="同字异写" hint="同一个字的不同写法" checked={prefs.unihanZ} onChange={(value) => onChange({ unihanZ: value })} />
              <CheckRow label="语义异体" hint="意思相通的异体，范围宽、误中多，默认关" checked={prefs.unihanSemantic} onChange={(value) => onChange({ unihanSemantic: value })} />
            </Group>
            <Group title="上手">
              <GettingStarted
                tasks={[
                  { id: "highlight", label: "试一次逐字高亮", hint: "点了会关掉设置窗，在正文上提示", done: prefs.practice.highlight },
                  { id: "pageEdit", label: "试一次按页校改", done: prefs.practice.pageEdit },
                ]}
                onDo={(id) => onPractice(id as "highlight" | "pageEdit")}
              />
            </Group>
            {/* 演示站没有本机服务，端口这一组不显示 */}
            {!DEMO && (
            <Group title="本机服务">
              <div className="aps-row">
                <span>默认端口</span>
                <div className="aih-port-row">
                <input
                  className="aih-port-input"
                  aria-label="默认端口"
                  inputMode="numeric"
                  value={portDraft ?? String(info?.port ?? "")}
                  onChange={(event) => {
                    setPortDraft(event.currentTarget.value);
                    setPortMessage(null);
                  }}
                />
                <button
                  type="button"
                  className="aps-button"
                  disabled={portDraft === null}
                  onClick={() => {
                    const value = Number(portDraft);
                    void onPort(value).then((error) => {
                      if (error) setPortMessage(error);
                      else {
                        setPortDraft(null);
                        setPortMessage(running !== null && value !== running ? `已存。下次启动用 ${value}；这一次仍在 ${running}。` : "已存。");
                      }
                    });
                  }}
                >
                  保存
                </button>
                </div>
              </div>
              <p className="aps-hint">
                端口被占用时，启动命令会明说并停下，不会悄悄换一个。只监听 127.0.0.1，别的电脑连不上。
                {info ? ` 配置文件：${info.configPath}` : ""}
              </p>
              {portMessage ? <p className="aih-port-message" role="status">{portMessage}</p> : null}
            </Group>
            )}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </MotionConfig>
  );
}
