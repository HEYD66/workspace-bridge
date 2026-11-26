// 右栏的文件标签：在右栏里看和改文件（Ctrl+P 选的文件开在这里），有「保存」和「在编辑器里打开」。
// 做法照整页的编辑区（views/EditorArea.tsx）：一个 Monaco 实例挂多个模型，切标签只换模型；
// 它自己有一份正文（模型的身份带 right: 前缀），和整页编辑器里的同一个文件各改各的，存盘时靠版本号防互相覆盖。
import { AlertTriangle, FileText, Loader2, RotateCw, Save, ExternalLink } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { ActivityEvent, BridgeState, FileContent } from '../../../shared/api'
import { CodeEditor, type CodeEditorHandle } from '../components/CodeEditor'
import { FileIcon } from '../components/FileIcon'
import { Button, cx, EmptyState } from '../components/ui'
import { openFile } from '../lib/editorStore'
import { errText, FILE_WRITE_TOOLS, formatBytes } from '../lib/format'
import { languageOf } from '../lib/monaco'
import { cancelCloseFileTab, closeFileTab, getRightFiles, markRightFilesDeleted, onRightFileSignal, renameRightFiles, resetRightFiles, setRightFileDirty, useRightFiles } from '../lib/rightFiles'
import { fileTabKey, type PanelTab } from '../lib/rightTabs'

type FileTab = Extract<PanelTab, { kind: 'file' }>

/** 一个文件读盘 / 存盘的进展 */
interface FileData {
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
  /** 这个文件在磁盘上已经没了（被删了）：标签留着，提示条让用户选关掉还是存回去 */
  gone?: boolean
  /** 保存时发现磁盘上的版本变了 */
  conflict?: string
  /** 保存失败的原因 */
  error?: string
  /** 文件被外部（AI 或别的程序）改过，但这里有没保存的改动 */
  external?: boolean
  saving?: boolean
}

const fileName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

/** 什么情况下只给占位提示、不打开编辑器 */
function blockOf(f: FileContent): FileData['block'] {
  if (f.error) return { title: '读不了这个文件', hint: f.error }
  if (f.binary) return { title: '这是个二进制文件', hint: `${formatBytes(f.size)}，这里只打开文本文件` }
  if (f.tooLarge) return { title: '文件太大', hint: `${formatBytes(f.size)}，超过 5 MB 的文本不在这里打开` }
  if (typeof f.content !== 'string') return { title: '没有可显示的内容', hint: f.encoding ? `检测到的编码：${f.encoding}` : undefined }
  return undefined
}

/**
 * 右栏里所有文件标签共用的一块：右栏只要有文件标签它就一直挂着（翻到别的标签时藏起来），
 * 这样翻走再翻回来，没保存的改动、光标、撤销记录都还在。
 * tabs 是右栏里的文件标签，activeId 是正在看的那个的 id（正在看的不是文件标签就是 undefined）
 */
export function RightFiles({ state, events, tabs, activeId }: { state: BridgeState; events: ActivityEvent[]; tabs: FileTab[]; activeId?: string }) {
  const { dirty, reveal, closing } = useRightFiles()
  const [data, setData] = useState<Record<string, FileData>>({})
  const codeRef = useRef<CodeEditorHandle | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const active = tabs.find((t) => t.id === activeId)
  const activeKey = active ? fileTabKey(active) : undefined
  /** 藏起来的时候编辑器还显示最后看的那个文件 */
  const lastKey = useRef<string | undefined>(activeKey)
  if (activeKey) lastKey.current = activeKey
  const shownKey = activeKey ?? (lastKey.current && tabs.some((t) => fileTabKey(t) === lastKey.current) ? lastKey.current : undefined)
  const shown = tabs.find((t) => fileTabKey(t) === shownKey)
  /** 异步回调用，避免闭包里拿到过期的东西 */
  const dataRef = useRef(data)
  dataRef.current = data
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const activeKeyRef = useRef(activeKey)
  activeKeyRef.current = activeKey
  const savingRef = useRef(new Set<string>())
  /**
   * 改名 / 删除的活动记录里哪些是「刚发生的」：历史记录不能拿来动现在开着的标签。
   * 电脑上的窗口和工作台是同一个钟，比这一块挂上的时间晚就算；远端的浏览器钟可能不准，改成比第一次拿到的那批记录都新才算
   */
  const mountedAt = useRef(Date.now())
  const histMax = useRef<number | undefined>(undefined)
  /** 自己这边正在存、刚存完的：存盘也会记一条活动，别把它当成「被外部改过」 */
  const ownSaves = useRef<{ key: string; bytes: number }[]>([])

  const patch = useCallback((key: string, p: Partial<FileData>) => {
    setData((prev) => ({ ...prev, [key]: { ...(prev[key] ?? { content: '', seq: 0, loading: true }), ...p } }))
  }, [])

  /** 从磁盘读一个文件（没保存的改动会丢） */
  const load = useCallback(
    async (key: string) => {
      const tab = tabsRef.current.find((t) => fileTabKey(t) === key)
      if (!tab) return
      patch(key, { loading: true })
      try {
        const f = await window.bridge.readFile(tab.workspaceId, tab.path)
        const block = blockOf(f)
        setData((prev) => ({
          ...prev,
          [key]: { content: f.content ?? '', seq: (prev[key]?.seq ?? 0) + 1, loading: false, version: f.version, size: f.size, encoding: f.encoding, eol: f.eol, block }
        }))
        setRightFileDirty(key, false)
      } catch (e) {
        setData((prev) => ({ ...prev, [key]: { ...(prev[key] ?? { content: '', seq: 0 }), loading: false, block: { title: '读不了这个文件', hint: errText(e) } } }))
      }
    },
    [patch]
  )

  // 翻到一个文件标签时读盘。读失败过的再翻回来也重试
  useEffect(() => {
    if (!activeKey) return
    const d = dataRef.current[activeKey]
    if (d && !d.block) return
    void load(activeKey)
  }, [activeKey, load])

  // 标签关掉了：它的正文和模型丢掉，不然下次打开同一个文件会看到旧内容
  const keys = tabs.map(fileTabKey).join('\n')
  useEffect(() => {
    const live = new Set(keys ? keys.split('\n') : [])
    const gone = Object.keys(dataRef.current).filter((k) => !live.has(k))
    if (!gone.length) return
    for (const k of gone) {
      codeRef.current?.forget(k)
      setRightFileDirty(k, false)
    }
    setData((prev) => {
      const next = { ...prev }
      for (const k of gone) delete next[k]
      return next
    })
  }, [keys])

  /** 存盘。force 表示无视版本冲突直接覆盖。返回存成了没有 */
  const save = useCallback(
    async (key: string, force = false): Promise<boolean> => {
      const tab = tabsRef.current.find((t) => fileTabKey(t) === key)
      const d = dataRef.current[key]
      if (!tab || !d || d.block || d.loading || savingRef.current.has(key)) return false
      // 文件已经不在了：存就是重新建出来，没有「磁盘上的版本」可比
      if (d.gone) force = true
      const value = codeRef.current?.value(key)
      // 模型还没建出来说明正文还没进编辑器，这次不存
      if (value === undefined) return false
      savingRef.current.add(key)
      patch(key, { saving: true, error: undefined })
      const own = { key, bytes: new TextEncoder().encode(value).length }
      ownSaves.current.push(own)
      try {
        const r = await window.bridge.saveFile(tab.workspaceId, tab.path, value, force ? undefined : d.version)
        setData((prev) => ({ ...prev, [key]: { ...prev[key], saving: false, content: value, version: r.version, size: value.length, conflict: undefined, external: undefined, gone: undefined } }))
        setRightFileDirty(key, false)
        return true
      } catch (e) {
        const msg = errText(e)
        ownSaves.current = ownSaves.current.filter((o) => o !== own)
        setData((prev) => ({
          ...prev,
          [key]: msg.startsWith('CONFLICT') ? { ...prev[key], saving: false, conflict: msg, error: undefined } : { ...prev[key], saving: false, error: msg }
        }))
        return false
      } finally {
        savingRef.current.delete(key)
      }
    },
    [patch]
  )

  // 光标在右栏的文件里时 Ctrl+S / Cmd+S 存这个文件（整页编辑区的 Ctrl+S 这时不管，见 views/EditorArea.tsx）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 's') return
      const key = activeKeyRef.current
      if (!key || !rootRef.current?.contains(document.activeElement)) return
      e.preventDefault()
      e.stopPropagation()
      void save(key)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [save])

  // AI 或别的程序改了这里开着的文件：没动过的直接重读，有没保存的改动的挂个提示条
  const seen = useRef(new Set<string>())
  useEffect(() => {
    // 第一次拿到记录时，里面最新的那条的时间（这一批都是历史）
    const first = histMax.current
    if (first === undefined && events.length) histMax.current = events.reduce((m, e) => Math.max(m, e.ts), 0)
    for (const ev of events) {
      if (ev.status !== 'ok' || !FILE_WRITE_TOOLS.has(ev.tool) || !ev.workspaceId || !ev.path) continue
      if (seen.current.has(ev.id)) continue
      seen.current.add(ev.id)
      const p = ev.path.replace(/\\/g, '/')
      // AI 把文件（或它所在的目录）改名、移走、删掉了：标签跟过去 / 标成不在了。只认这一块挂上之后发生的
      if (ev.tool === 'move' || ev.tool === 'delete') {
        const fresh = window.bridge.isRemote ? first !== undefined && ev.ts > first : ev.ts >= mountedAt.current
        if (!fresh) continue
        const wsId = ev.workspaceId
        if (ev.tool === 'delete') markRightFilesDeleted(wsId, p)
        else if (typeof ev.args?.from === 'string') {
          const from = ev.args.from
          // 改标签时编辑器要同步落一次状态，不能在 effect 里做
          setTimeout(() => renameRightFiles(wsId, from, p), 0)
        }
        continue
      }
      for (const t of tabsRef.current) {
        if (t.workspaceId !== ev.workspaceId || t.path !== p) continue
        const key = fileTabKey(t)
        if (!dataRef.current[key]) continue
        const mine = ev.tool === 'write_file' ? ownSaves.current.findIndex((o) => o.key === key && o.bytes === ev.args?.bytes) : -1
        if (mine >= 0) {
          ownSaves.current.splice(mine, 1)
          continue
        }
        if (dirty.has(key)) patch(key, { external: true })
        else void load(key)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, load, patch])

  // 开着的文件换了路径 / 被删了
  useEffect(
    () =>
      onRightFileSignal((sig) => {
        if (sig.type === 'deleted') {
          for (const k of sig.keys) if (dataRef.current[k]) patch(k, { gone: true, external: undefined, conflict: undefined })
          return
        }
        // 改名：正文、版本、没保存的改动都搬到新路径下。必须在标签换路径之前落定，
        // 不然新路径在这边还没有内容，会被当成刚打开的文件从磁盘重读，没保存的改动就丢了
        const moves = sig.pairs.flatMap(([from, to]) => {
          const d = dataRef.current[from]
          if (!d) return []
          const unsaved = getRightFiles().dirty.has(from) ? codeRef.current?.value(from) : undefined
          return [{ to, d: { ...d, content: unsaved ?? d.content, seq: d.seq + 1, gone: undefined } as FileData, dirty: unsaved !== undefined }]
        })
        if (!moves.length) return
        flushSync(() =>
          setData((prev) => {
            const next = { ...prev }
            for (const m of moves) next[m.to] = m.d
            return next
          })
        )
        for (const m of moves) if (m.dirty) setRightFileDirty(m.to, true)
      }),
    [patch]
  )

  // 这一块被卸掉时编辑器里的正文就没了，记号跟着清
  useEffect(() => resetRightFiles, [])

  /** 敲了字：只标成「没保存」，不比对全文 */
  const onChange = useCallback((key: string) => setRightFileDirty(key, true), [])

  const cur = shownKey ? data[shownKey] : undefined
  const editable = !!cur && !cur.block
  const isDirty = !!shownKey && dirty.has(shownKey)
  const wsName = state.workspaces?.find((w) => w.id === shown?.workspaceId)?.name ?? shown?.workspaceId ?? ''
  const closingTab = closing ? tabs.find((t) => t.id === closing) : undefined

  return (
    <div
      ref={rootRef}
      data-right-file={active ? active.path : undefined}
      data-right-file-dirty={isDirty ? '' : undefined}
      className="absolute inset-0 flex flex-col bg-canvas"
      style={active ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
    >
      {/* 一行：文件名、保存、在编辑器里打开 */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line-soft bg-panel pr-2 pl-3">
        <FileIcon name={fileName(shown?.path ?? '')} size={14} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg" title={shown ? `${wsName} / ${shown.path}` : undefined}>
          {fileName(shown?.path ?? '')}
          {isDirty && <span data-right-file-unsaved className="ml-1.5 text-[11px] text-[#e3b341]">未保存</span>}
        </span>
        <button
          type="button"
          data-right-file-save
          title="保存（Ctrl+S）"
          disabled={!shown || !editable || !isDirty}
          onClick={() => shownKey && void save(shownKey)}
          className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 text-[11.5px] text-muted hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-30"
        >
          {cur?.saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          保存
        </button>
        <button
          type="button"
          data-right-file-open
          title="到「文件」那一页的编辑器里打开这个文件（这里没保存的改动不会带过去）"
          disabled={!shown}
          onClick={() => shown && openFile({ workspaceId: shown.workspaceId, path: shown.path, preview: false })}
          className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 text-[11.5px] text-muted hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-30"
        >
          <ExternalLink size={12} />
          在编辑器里打开
        </button>
        <button
          type="button"
          title="从磁盘重新读取（没保存的改动会丢）"
          disabled={!shown}
          onClick={() => shownKey && void load(shownKey)}
          className="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-30"
        >
          <RotateCw size={12} />
        </button>
      </div>

      {/* 提示条：冲突 / 保存失败 / 被外部改过 */}
      {shownKey && cur && (cur.gone || cur.conflict || cur.error || cur.external) && (
        <div data-right-file-notice={cur.gone ? 'gone' : ''} className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-[#3d2b12] px-3 py-1.5 text-[11.5px] text-[#e3b341]">
          <AlertTriangle size={13} className="shrink-0" />
          {cur.gone ? (
            <>
              <span className="min-w-0 flex-1">
                这个文件已经被删掉了（在回收站里）。{cur.error ? `存回去失败：${cur.error}` : isDirty ? '你没保存的改动还在这里。' : '这里显示的是删掉之前的内容。'}
              </span>
              <Button size="sm" data-right-file-recreate onClick={() => void save(shownKey)}>
                存回去
              </Button>
              <Button size="sm" variant="ghost" data-right-file-close-gone onClick={() => shown && closeFileTab(shown.id, true)}>
                关掉标签
              </Button>
            </>
          ) : cur.conflict ? (
            <>
              <span className="min-w-0 flex-1">磁盘上的内容已经变了，直接保存会盖掉别人的修改。</span>
              <Button size="sm" onClick={() => void load(shownKey)}>
                重新读取
              </Button>
              <Button size="sm" variant="danger" onClick={() => void save(shownKey, true)}>
                仍然覆盖
              </Button>
            </>
          ) : cur.error ? (
            <>
              <span className="min-w-0 flex-1">保存失败：{cur.error}</span>
              <Button size="sm" onClick={() => void save(shownKey)}>
                重试
              </Button>
              <Button size="sm" variant="ghost" onClick={() => patch(shownKey, { error: undefined })}>
                关掉提示
              </Button>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1">这个文件被外部改过，你有没保存的改动，所以没自动刷新。</span>
              <Button size="sm" variant="ghost" onClick={() => void load(shownKey)}>
                丢掉我的改动并重读
              </Button>
              <Button size="sm" variant="ghost" onClick={() => patch(shownKey, { external: undefined })}>
                知道了
              </Button>
            </>
          )}
        </div>
      )}

      {/* 正文：编辑器常驻（切标签只换模型），不能编辑时用占位层盖住 */}
      <div className="relative min-h-0 flex-1 bg-canvas">
        <div className={cx('absolute inset-0', !editable && 'invisible')}>
          <CodeEditor
            ref={codeRef}
            tabKey={shownKey ?? ''}
            language={shown ? languageOf(shown.path) : 'plaintext'}
            content={cur?.content ?? ''}
            contentSeq={cur?.seq ?? 0}
            readOnly={!editable}
            minimap={false}
            onChange={onChange}
            reveal={reveal && activeKey && reveal.key === activeKey && editable ? reveal : undefined}
          />
        </div>
        {shown && (cur?.loading || !cur) && (
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
        <span className="min-w-0 truncate" title={shown ? `${wsName} / ${shown.path}` : undefined}>
          {wsName}
          <span className="text-faint"> / </span>
          {shown?.path}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {cur?.eol && <span>{cur.eol.toUpperCase()}</span>}
          {cur?.encoding && <span>{cur.encoding}</span>}
          {cur?.conflict ? <span className="text-[#e3b341]">有冲突</span> : isDirty ? <span className="text-[#e3b341]">未保存</span> : <span className="text-ok">已保存</span>}
        </div>
      </div>

      {/* 关一个有没保存改动的标签：先问 */}
      {closingTab && (
        <div data-right-file-confirm className="absolute inset-0 z-30 flex items-center justify-center bg-black/50 p-3">
          <div className="w-full max-w-[360px] rounded-lg border border-line bg-panel p-4 shadow-2xl">
            <div className="text-[13px] text-fg">有没保存的改动</div>
            <div className="mt-1.5 text-xs leading-relaxed break-all text-muted">{closingTab.path} 里有没保存的改动。关闭前要不要先保存？</div>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={cancelCloseFileTab}>
                取消
              </Button>
              <Button size="sm" variant="danger" onClick={() => closeFileTab(closingTab.id, true)}>
                不保存，直接关
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() =>
                  void (async () => {
                    // 没存成（冲突、失败）就不关，提示条会说为什么
                    if (await save(fileTabKey(closingTab))) closeFileTab(closingTab.id, true)
                    else cancelCloseFileTab()
                  })()
                }
              >
                保存后关闭
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
