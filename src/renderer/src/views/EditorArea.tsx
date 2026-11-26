// 编辑区（ui-code）：多标签页 + Monaco + 存盘 / 冲突处理
import { AlertTriangle, FileText, Loader2, RotateCw, Save, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActivityEvent, BridgeState, FileContent } from '../../../shared/api'
import { CodeEditor, type CodeEditorHandle } from '../components/CodeEditor'
import { useContextMenu } from '../components/ContextMenu'
import { FileIcon } from '../components/FileIcon'
import { Button, cx, EmptyState } from '../components/ui'
import { closeTabs, getEditor, moveTab, pinTab, setActiveTab, setTabDirty, useEditor } from '../lib/editorStore'
import { errText, FILE_WRITE_TOOLS, formatBytes } from '../lib/format'
import { editorTabMenu, joinRoot, tabsToClose } from '../lib/menus'
import { languageOf } from '../lib/monaco'

/** 一个标签读盘 / 存盘的进展 */
interface TabData {
  /** 磁盘上的正文；不能编辑时是空串 */
  content: string
  /** 每次从磁盘重新读取都 +1，用来通知编辑器把正文灌进模型 */
  seq: number
  loading: boolean
  /** 和 MCP read_file 的 version 一致，存盘时回传防覆盖 */
  version?: string
  size?: number
  encoding?: string
  eol?: 'lf' | 'crlf'
  /** 不能进编辑器的原因（二进制 / 太大 / 读失败） */
  block?: { title: string; hint?: string }
  /** 保存时发现磁盘上的版本变了 */
  conflict?: string
  /** 保存失败的原因 */
  error?: string
  /** 文件被外部（AI 或别的程序）改过，但本地有没保存的改动 */
  external?: boolean
  saving?: boolean
}

const fileName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

/** 什么情况下只给占位提示、不打开编辑器 */
function blockOf(f: FileContent): TabData['block'] {
  if (f.error) return { title: '读不了这个文件', hint: f.error }
  if (f.binary) return { title: '这是个二进制文件', hint: `${formatBytes(f.size)}，编辑器里只打开文本文件` }
  if (f.tooLarge) return { title: '文件太大', hint: `${formatBytes(f.size)}，超过 5 MB 的文本不在这里打开` }
  if (typeof f.content !== 'string') return { title: '没有可显示的内容', hint: f.encoding ? `检测到的编码：${f.encoding}` : undefined }
  return undefined
}

export function EditorArea({ state, events }: { state: BridgeState | null; events: ActivityEvent[] }) {
  const { tabs, active, activeKey, reveal } = useEditor()
  const [data, setData] = useState<Record<string, TabData>>({})
  const [pendingClose, setPendingClose] = useState<string[] | null>(null)
  const codeRef = useRef<CodeEditorHandle | null>(null)
  const dragKey = useRef<string | null>(null)
  /** 异步回调用，避免闭包里拿到过期的 state */
  const dataRef = useRef(data)
  dataRef.current = data
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const activeKeyRef = useRef(activeKey)
  activeKeyRef.current = activeKey
  const savingRef = useRef(new Set<string>())

  const patch = useCallback((key: string, p: Partial<TabData>) => {
    setData((prev) => ({ ...prev, [key]: { ...(prev[key] ?? { content: '', seq: 0, loading: true }), ...p } }))
  }, [])

  /** 从磁盘读一个标签。force 时不看缓存 */
  const load = useCallback(
    async (key: string) => {
      const tab = tabsRef.current.find((t) => t.key === key)
      if (!tab) return
      patch(key, { loading: true })
      try {
        const f = await window.bridge.readFile(tab.workspaceId, tab.path)
        const block = blockOf(f)
        setData((prev) => {
          const old = prev[key]
          return {
            ...prev,
            [key]: {
              content: f.content ?? '',
              seq: (old?.seq ?? 0) + 1,
              loading: false,
              version: f.version,
              size: f.size,
              encoding: f.encoding,
              eol: f.eol,
              block
            }
          }
        })
        setTabDirty(key, false)
      } catch (e) {
        setData((prev) => ({
          ...prev,
          [key]: { ...(prev[key] ?? { content: '', seq: 0 }), loading: false, block: { title: '读不了这个文件', hint: errText(e) } }
        }))
      }
    },
    [patch]
  )

  // 打开标签时读盘。读失败过的再点一次也重试
  useEffect(() => {
    const key = active?.key
    if (!key) return
    const d = dataRef.current[key]
    if (d && !d.block) return
    void load(key)
  }, [active?.key, load])

  /** 存盘。force 表示无视版本冲突直接覆盖 */
  const save = useCallback(
    async (key: string, force = false) => {
      const tab = tabsRef.current.find((t) => t.key === key)
      const d = dataRef.current[key]
      if (!tab || !d || d.block || d.loading || savingRef.current.has(key)) return
      const value = codeRef.current?.value(key)
      // 模型还没建出来说明正文还没进编辑器，这次不存
      if (value === undefined) return
      savingRef.current.add(key)
      patch(key, { saving: true, error: undefined })
      try {
        const r = await window.bridge.saveFile(tab.workspaceId, tab.path, value, force ? undefined : d.version)
        setData((prev) => ({
          ...prev,
          [key]: { ...prev[key], saving: false, content: value, version: r.version, size: value.length, conflict: undefined, external: undefined }
        }))
        setTabDirty(key, false)
      } catch (e) {
        const msg = errText(e)
        setData((prev) => ({
          ...prev,
          [key]: msg.startsWith('CONFLICT')
            ? { ...prev[key], saving: false, conflict: msg, error: undefined }
            : { ...prev[key], saving: false, error: msg }
        }))
      } finally {
        savingRef.current.delete(key)
      }
    },
    [patch]
  )

  // Ctrl+S / Cmd+S 存当前标签。放在捕获阶段并且掐断冒泡：
  // 焦点在标签栏、编辑器、或者树上时都能存，也不会和别处的快捷键打两次
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      if (e.key.toLowerCase() !== 's') return
      const key = activeKeyRef.current
      if (!key) return
      // 光标在右栏的文件标签里：存的是那边的文件（views/FileTab.tsx），这里不管
      if (document.activeElement?.closest('[data-right-file]')) return
      e.preventDefault()
      e.stopPropagation()
      void save(key)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [save])

  // AI 或别的程序改了已打开的文件：干净的直接重读，有未保存改动的挂个提示条
  const seen = useRef(new Set<string>())
  useEffect(() => {
    for (const ev of events) {
      if (ev.status !== 'ok' || !FILE_WRITE_TOOLS.has(ev.tool) || !ev.workspaceId || !ev.path) continue
      if (seen.current.has(ev.id)) continue
      seen.current.add(ev.id)
      const p = ev.path.replace(/\\/g, '/')
      for (const t of tabsRef.current) {
        if (t.workspaceId !== ev.workspaceId || t.path !== p) continue
        if (t.dirty) patch(t.key, { external: true })
        else void load(t.key)
      }
    }
  }, [events, load, patch])

  /** 敲了字：只标脏，不比对全文（几 MB 的文件每敲一下比一遍会很卡） */
  const onChange = useCallback((key: string) => {
    const t = getEditor().tabs.find((x) => x.key === key)
    if (!t || t.dirty) return
    setTabDirty(key, true)
  }, [])

  const dropData = (keys: string[]): void => {
    for (const k of keys) codeRef.current?.forget(k)
    setData((prev) => {
      const next = { ...prev }
      for (const k of keys) delete next[k]
      return next
    })
  }

  const doClose = (keys: string[]): void => {
    dropData(keys)
    closeTabs(keys)
    setPendingClose(null)
  }

  const requestClose = (keys: string[]): void => {
    const dirty = keys.filter((k) => tabsRef.current.find((t) => t.key === k)?.dirty)
    if (dirty.length) setPendingClose(keys)
    else doClose(keys)
  }

  // 标签右键（T-13）：关闭类都走 requestClose，有没保存的照样先问
  const ctx = useContextMenu()
  const openTabMenu = (e: React.MouseEvent, t: (typeof tabs)[number]): void => {
    const i = tabs.findIndex((x) => x.key === t.key)
    const closeSome = (which: 'others' | 'right' | 'all'): void => requestClose(tabsToClose(tabs, i, which).map((x) => x.key))
    const root = state?.workspaces.find((w) => w.id === t.workspaceId)?.root
    ctx.open(
      e,
      editorTabMenu(i, tabs.length, {
        close: () => requestClose([t.key]),
        closeOthers: () => closeSome('others'),
        closeRight: () => closeSome('right'),
        closeAll: () => closeSome('all'),
        copyPath: () => void window.bridge.copy(root ? joinRoot(root, t.path) : t.path),
        copyRelPath: () => void window.bridge.copy(t.path),
        reveal: () => void window.bridge.revealPath(t.workspaceId, t.path).catch(() => undefined)
      })
    )
  }


  const cur = active ? data[active.key] : undefined
  const editable = !!cur && !cur.block
  const wsName = state?.workspaces.find((w) => w.id === active?.workspaceId)?.name ?? active?.workspaceId ?? ''

  if (tabs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={<FileText size={26} />}
          title="还没有打开的文件"
          hint="在左边资源管理器里点一个文件；想按名字找就按 Ctrl+P，想按内容找就按 Ctrl+Shift+F"
        />
      </div>
    )
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* 标签栏 */}
      <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-line bg-panel">
        {tabs.map((t) => (
          <div
            key={t.key}
            draggable
            onContextMenu={(e) => openTabMenu(e, t)}
            onDragStart={(e) => {
              dragKey.current = t.key
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(e) => {
              if (dragKey.current) e.preventDefault()
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (dragKey.current && dragKey.current !== t.key) moveTab(dragKey.current, t.key)
              dragKey.current = null
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return
              e.preventDefault()
              requestClose([t.key])
            }}
            onClick={() => {
              setActiveTab(t.key)
              codeRef.current?.focus()
            }}
            onDoubleClick={() => pinTab(t.key)}
            title={t.path}
            className={cx(
              'group relative flex max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-line pr-1.5 pl-3 text-xs select-none',
              activeKey === t.key ? 'bg-canvas text-fg' : 'text-muted hover:bg-hover',
              t.preview && 'italic'
            )}
          >
            {activeKey === t.key && <span className="absolute inset-x-0 top-0 h-px bg-accent" />}
            <FileIcon name={fileName(t.path)} size={14} />
            <span className="truncate">{fileName(t.path)}</span>
            {t.dirty ? (
              <>
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-fg group-hover:hidden" />
                <button
                  title="关闭（有未保存的改动）"
                  onClick={(e) => {
                    e.stopPropagation()
                    requestClose([t.key])
                  }}
                  className="hidden h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-muted hover:bg-hover hover:text-fg group-hover:flex"
                >
                  <X size={12} />
                </button>
              </>
            ) : (
              <button
                title="关闭"
                onClick={(e) => {
                  e.stopPropagation()
                  requestClose([t.key])
                }}
                className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-faint opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-fg"
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}
        <div className="ml-auto flex shrink-0 items-center gap-1 pr-2">
          <button
            title="保存当前文件（Ctrl+S）"
            disabled={!active || !cur || !!cur.block || !active.dirty}
            onClick={() => active && void save(active.key)}
            className="inline-flex h-6 cursor-pointer items-center gap-1 rounded px-2 text-[11px] text-muted hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-30"
          >
            {cur?.saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            保存
          </button>
          <button
            title="从磁盘重新读取（没保存的改动会丢）"
            disabled={!active}
            onClick={() => active && void load(active.key)}
            className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-30"
          >
            <RotateCw size={12} />
          </button>
        </div>
      </div>

      {/* 提示条：冲突 / 保存失败 / 被外部改过 */}
      {active && cur && (cur.conflict || cur.error || cur.external) && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-[#3d2b12] px-3 py-1.5 text-[11.5px] text-[#e3b341]">
          <AlertTriangle size={13} className="shrink-0" />
          {cur.conflict ? (
            <>
              <span className="truncate">磁盘上的内容已经变了，直接保存会盖掉别人的修改。</span>
              <div className="ml-auto flex shrink-0 gap-1.5">
                <Button size="sm" onClick={() => void load(active.key)}>
                  重新读取
                </Button>
                <Button size="sm" variant="danger" onClick={() => void save(active.key, true)}>
                  仍然覆盖
                </Button>
              </div>
            </>
          ) : cur.error ? (
            <>
              <span className="truncate">保存失败：{cur.error}</span>
              <div className="ml-auto flex shrink-0 gap-1.5">
                <Button size="sm" onClick={() => void save(active.key)}>
                  重试
                </Button>
                <Button size="sm" variant="ghost" onClick={() => patch(active.key, { error: undefined })}>
                  关掉提示
                </Button>
              </div>
            </>
          ) : (
            <>
              <span className="truncate">这个文件被外部改过，你有没保存的改动，所以没自动刷新。</span>
              <div className="ml-auto flex shrink-0 gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => void load(active.key)}>
                  丢掉我的改动并重读
                </Button>
                <Button size="sm" variant="ghost" onClick={() => patch(active.key, { external: undefined })}>
                  知道了
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* 正文：编辑器常驻（切标签只换模型），不能编辑时用占位层盖住 */}
      <div className="relative min-h-0 flex-1 bg-canvas">
        <div className={cx('absolute inset-0', !editable && 'invisible')}>
          <CodeEditor
            ref={codeRef}
            tabKey={active?.key ?? ''}
            language={active ? languageOf(active.path) : 'plaintext'}
            content={cur?.content ?? ''}
            contentSeq={cur?.seq ?? 0}
            readOnly={!editable}
            onChange={onChange}
            reveal={reveal && active && reveal.key === active.key ? reveal : undefined}
          />
        </div>
        {(cur?.loading || !cur) && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-canvas text-xs text-muted">
            <Loader2 size={14} className="animate-spin" />
            正在读取…
          </div>
        )}
        {!cur?.loading && cur?.block && (
          <div className="absolute inset-0 overflow-auto bg-canvas">
            <EmptyState icon={<FileText size={26} />} title={cur.block.title} hint={cur.block.hint} />
          </div>
        )}
      </div>

      {/* 状态栏 */}
      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-panel px-3 text-[11px] text-muted">
        <span className="truncate">
          {wsName}
          <span className="text-faint"> / </span>
          {active?.path}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {cur?.eol && <span>{cur.eol.toUpperCase()}</span>}
          {cur?.encoding && <span>{cur.encoding}</span>}
          {cur?.size !== undefined && <span>{formatBytes(cur.size)}</span>}
          {cur?.conflict ? (
            <span className="text-[#e3b341]">有冲突</span>
          ) : active?.dirty ? (
            <span className="text-[#e3b341]">未保存</span>
          ) : (
            <span className="text-ok">已保存</span>
          )}
        </div>
      </div>

      {/* 关未保存标签的确认 */}
      {pendingClose && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50">
          <div className="w-[380px] rounded-lg border border-line bg-panel p-4 shadow-2xl">
            <div className="text-[13px] text-fg">有没保存的改动</div>
            <div className="mt-1.5 text-xs leading-relaxed text-muted">
              要关闭的 {pendingClose.length} 个标签里有未保存的改动。关闭前要不要先保存？
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setPendingClose(null)}>
                取消
              </Button>
              <Button size="sm" variant="danger" onClick={() => doClose(pendingClose)}>
                不保存，直接关
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  const keys = pendingClose.filter((k) => tabsRef.current.find((t) => t.key === k)?.dirty)
                  void (async () => {
                    for (const k of keys) await save(k)
                    doClose(pendingClose)
                  })()
                }}
              >
                全部保存后关闭
              </Button>
            </div>
          </div>
        </div>
      )}
      {ctx.menu}
    </div>
  )
}

