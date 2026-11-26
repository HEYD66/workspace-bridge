import { CornerDownLeft, FileSearch, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { BridgeState, FileListEntry } from '../../../shared/api'
import { getActiveFile, openFile, useEditor } from '../lib/editorStore'
import { errText } from '../lib/format'
import { openRightFile } from '../lib/rightFiles'
import { FileIcon } from './FileIcon'
import { cx } from './ui'

/** 最多显示多少条 */
const MAX_SHOWN = 100
/** 和后端 listFiles 的上限一致：到了这个数说明没列全 */
const LIST_LIMIT = 50000

interface Entry {
  e: FileListEntry
  path: string
  lower: string
  /** 文件名在 path 里的起点 */
  nameStart: number
}

interface Row {
  entry: Entry
  /** 命中的字符在 path 里的位置 */
  pos: number[]
  score: number
  /** 空查询时列出的已打开文件 */
  opened?: boolean
}

// 文件清单缓存在模块里：再次打开时先显示上次的，后台重新拉
let cache: { key: string; entries: Entry[]; full: boolean } | undefined

function toEntries(list: FileListEntry[]): Entry[] {
  return list.map((e) => ({ e, path: e.path, lower: e.path.toLowerCase(), nameStart: e.path.lastIndexOf('/') + 1 }))
}

// ========== 模糊匹配 ==========

const SEPARATORS = '/\\._- '

function isBoundary(orig: string, i: number, from: number): boolean {
  if (i === from) return true
  const prev = orig[i - 1]
  if (SEPARATORS.includes(prev)) return true
  // 驼峰：小写后面跟大写（useBridge 的 B）
  const c = orig[i]
  return c !== c.toLowerCase() && prev === prev.toLowerCase() && prev !== prev.toUpperCase()
}

/** 在 [from, to) 里找 q：连续命中分最高，否则按顺序找每个字符（连续、词首、从头开始都加分） */
function fuzzyIn(q: string, lower: string, orig: string, from: number, to: number): { score: number; pos: number[] } | null {
  const idx = lower.indexOf(q, from)
  if (idx !== -1 && idx + q.length <= to) {
    let score = q.length * 10
    if (idx === from) score += 100
    else if (isBoundary(orig, idx, from)) score += 40
    if (idx === from && idx + q.length === to) score += 400
    return { score, pos: Array.from({ length: q.length }, (_, k) => idx + k) }
  }
  const pos: number[] = []
  let j = from
  for (const ch of q) {
    const k = lower.indexOf(ch, j)
    if (k === -1 || k >= to) return null
    pos.push(k)
    j = k + 1
  }
  let score = 0
  for (let i = 0; i < pos.length; i++) {
    score += 1
    if (i > 0 && pos[i] === pos[i - 1] + 1) score += 5
    if (isBoundary(orig, pos[i], from)) score += 6
  }
  if (pos[0] === from) score += 8
  score -= (pos[pos.length - 1] - pos[0] + 1 - pos.length) * 0.2
  return { score, pos }
}

/** 空格分开的每一段都要命中；文件名里命中的排在只有路径命中的前面 */
function scoreEntry(tokens: string[], en: Entry): { score: number; pos: number[] } | null {
  let score = 0
  const pos: number[] = []
  for (const t of tokens) {
    const inName = t.includes('/') ? null : fuzzyIn(t, en.lower, en.path, en.nameStart, en.path.length)
    if (inName) {
      score += 1000 + inName.score
      pos.push(...inName.pos)
      continue
    }
    const inPath = fuzzyIn(t, en.lower, en.path, 0, en.path.length)
    if (!inPath) return null
    score += inPath.score
    pos.push(...inPath.pos)
  }
  // 同样的分数，路径短的在前
  return { score: score - en.path.length * 0.05, pos }
}

/** 「文件:行号:列号」；只写「:行号」表示当前打开的文件 */
function parseQuery(raw: string): { text: string; line?: number; column?: number } {
  const q = raw.trim().replace(/\\/g, '/')
  const m = q.match(/:(\d+)(?::(\d+))?$/)
  if (m) return { text: q.slice(0, m.index).trim(), line: Number(m[1]) || 1, column: m[2] ? Number(m[2]) || 1 : undefined }
  // 正在输入「foo:」还没写行号
  return { text: q.replace(/:$/, '').trim() }
}

function Highlight({ text, offset, pos }: { text: string; offset: number; pos: Set<number> }) {
  const out: ReactNode[] = []
  let buf = ''
  let hit = false
  const flush = (k: number) => {
    if (!buf) return
    out.push(
      hit ? (
        <span key={k} className="font-semibold text-accent">
          {buf}
        </span>
      ) : (
        buf
      )
    )
    buf = ''
  }
  for (let i = 0; i < text.length; i++) {
    const h = pos.has(offset + i)
    if (h !== hit) {
      flush(i)
      hit = h
    }
    buf += text[i]
  }
  flush(text.length)
  return <>{out}</>
}

// ========== 组件 ==========

/** 选中的文件开在哪：right 右栏的文件标签，editor 「文件」那一页的编辑器 */
export type QuickOpenTarget = 'right' | 'editor'

/**
 * Ctrl+P 快速打开：模糊匹配文件名，回车打开；「:行号」跳到当前文件的某一行。
 * target 是回车开在哪（默认编辑器）；按住 Ctrl 回车 / 点击开在另一处
 */
export function QuickOpen({ state, open, onClose, target = 'editor' }: { state: BridgeState; open: boolean; onClose: () => void; target?: QuickOpenTarget }) {
  if (!open) return null
  return <QuickOpenDialog state={state} onClose={onClose} target={target} />
}

function QuickOpenDialog({ state, onClose, target }: { state: BridgeState; onClose: () => void; target: QuickOpenTarget }) {
  // 快速打开不扫整台电脑
  const workspaces = (state.workspaces ?? []).filter((w) => w.kind !== 'machine')
  const usable = workspaces.filter((w) => w.exists)
  const multi = workspaces.length > 1
  const listKey = usable.map((w) => w.id).join('|')

  const { tabs } = useEditor()
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<Entry[]>(() => (cache?.key === listKey ? cache.entries : []))
  const [full, setFull] = useState(cache?.key === listKey ? cache.full : true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 每次打开都重新列一遍文件（期间先用上次的）
  useEffect(() => {
    if (!usable.length) return
    let alive = true
    setLoading(true)
    window.bridge.listAllFiles().then(
      (list) => {
        if (!alive) return
        const next = toEntries(Array.isArray(list) ? list : [])
        const isFull = next.length < LIST_LIMIT
        cache = { key: listKey, entries: next, full: isFull }
        setEntries(next)
        setFull(isFull)
        setError('')
        setLoading(false)
      },
      (e) => {
        if (!alive) return
        setError(errText(e))
        setLoading(false)
      }
    )
    return () => {
      alive = false
    }
  }, [listKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = useMemo(() => parseQuery(query), [query])
  const jumpInActive = parsed.line !== undefined && !parsed.text
  const active = jumpInActive ? getActiveFile() : undefined

  const rows = useMemo((): Row[] => {
    if (jumpInActive) return []
    const tokens = parsed.text.toLowerCase().split(/\s+/).filter(Boolean)
    if (!tokens.length) {
      // 没输入时：先列已打开的文件，再按顺序列一些
      const seen = new Set<string>()
      const out: Row[] = []
      const byKey = new Map(entries.map((en) => [`${en.e.workspaceId}:${en.path}`, en]))
      for (const t of tabs) {
        const k = `${t.workspaceId}:${t.path}`
        if (seen.has(k)) continue
        seen.add(k)
        const en = byKey.get(k) ?? toEntries([{ workspaceId: t.workspaceId, path: t.path }])[0]
        out.push({ entry: en, pos: [], score: 0, opened: true })
      }
      for (const en of entries) {
        if (out.length >= MAX_SHOWN) break
        const k = `${en.e.workspaceId}:${en.path}`
        if (!seen.has(k)) out.push({ entry: en, pos: [], score: 0 })
      }
      return out
    }
    const hits: Row[] = []
    for (const en of entries) {
      const r = scoreEntry(tokens, en)
      if (r) hits.push({ entry: en, pos: r.pos, score: r.score })
    }
    hits.sort((a, b) => b.score - a.score || (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0))
    return hits.slice(0, MAX_SHOWN)
  }, [entries, parsed.text, jumpInActive, tabs])

  useEffect(() => setSel(0), [parsed.text])

  // 选中项保持在可见范围里
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${sel}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const wsName = (id: string): string | undefined => (multi ? (workspaces.find((w) => w.id === id)?.name ?? '已移除的工作区') : undefined)

  function choose(i: number, other = false) {
    if (jumpInActive) {
      if (!active) return
      openFile({ ...active, line: parsed.line, column: parsed.column })
      onClose()
      return
    }
    const r = rows[i]
    if (!r) return
    const file = { workspaceId: r.entry.e.workspaceId, path: r.entry.path, line: parsed.line, column: parsed.column }
    if ((target === 'right') !== other) openRightFile(file)
    else openFile({ ...file, preview: false })
    onClose()
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return
    const n = rows.length
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key.toLowerCase() === 'n')) {
      e.preventDefault()
      if (n) setSel((s) => (s + 1) % n)
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key.toLowerCase() === 'p' && !e.shiftKey)) {
      e.preventDefault()
      if (n) setSel((s) => (s - 1 + n) % n)
    } else if (e.key === 'PageDown') {
      e.preventDefault()
      if (n) setSel((s) => Math.min(n - 1, s + 10))
    } else if (e.key === 'PageUp') {
      e.preventDefault()
      if (n) setSel((s) => Math.max(0, s - 10))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(sel, e.ctrlKey || e.metaKey)
    }
  }

  const status = (() => {
    if (!usable.length) return '还没有工作区，先在顶栏添加一个文件夹'
    if (error && !entries.length) return `列不出文件：${error}`
    if (jumpInActive) return active ? `回车跳到 ${active.path} 第 ${parsed.line} 行${parsed.column ? ` 第 ${parsed.column} 列` : ''}` : '先打开一个文件，再用「:行号」跳行'
    if (loading && !entries.length) return '正在列出文件…'
    if (parsed.text && rows.length === 0) return '没有匹配的文件'
    if (!parsed.text && rows.length === 0) return '工作区里没有文件'
    return ''
  })()

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/30 pt-[12vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="快速打开"
        className="flex h-fit max-h-[60vh] w-[620px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-2xl shadow-black/50"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="relative border-b border-line-soft p-2">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="按文件名搜索，「文件:行号」打开并跳行，「:行号」跳到当前文件的某一行"
            spellCheck={false}
            className="h-8 w-full rounded-md border border-accent bg-canvas px-2.5 pr-8 text-[13px] text-fg outline-none placeholder:text-faint"
          />
          {loading && <Loader2 size={13} className="absolute top-1/2 right-4 -translate-y-1/2 animate-spin text-faint" />}
        </div>

        {status && (
          <div className={cx('flex items-center gap-2 px-3 py-2.5 text-xs', jumpInActive && active ? 'text-fg' : error && !entries.length ? 'text-bad' : 'text-muted')}>
            {jumpInActive && active ? <CornerDownLeft size={13} className="text-faint" /> : <FileSearch size={13} className="text-faint" />}
            {status}
          </div>
        )}

        {rows.length > 0 && (
          <div ref={listRef} className="min-h-0 flex-1 overflow-auto py-1">
            {rows.map((r, i) => {
              const { path, nameStart } = r.entry
              const name = path.slice(nameStart)
              const dir = nameStart > 0 ? path.slice(0, nameStart - 1) : ''
              const ws = wsName(r.entry.e.workspaceId)
              const pos = new Set(r.pos)
              return (
                <div
                  key={`${r.entry.e.workspaceId}:${path}`}
                  data-row={i}
                  onMouseMove={() => sel !== i && setSel(i)}
                  onClick={(e) => choose(i, e.ctrlKey || e.metaKey)}
                  className={cx('mx-1 flex h-[26px] cursor-pointer items-center gap-2 rounded px-2', i === sel ? 'bg-accent/20' : 'hover:bg-hover')}
                >
                  <FileIcon name={name} size={16} />
                  <span className="shrink-0 text-[13px] text-fg">
                    <Highlight text={name} offset={nameStart} pos={pos} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-faint">
                    {ws && <span className="text-muted">{ws}</span>}
                    {ws && dir && ' · '}
                    {dir && <Highlight text={dir} offset={0} pos={pos} />}
                  </span>
                  {r.opened && <span className="shrink-0 text-[11px] text-faint">已打开</span>}
                </div>
              )
            })}
          </div>
        )}

        {rows.length > 0 && (
          <div data-quick-open-target={target} className="border-t border-line-soft px-3 py-1.5 text-[11px] text-faint">
            {target === 'right' ? '回车：在右栏打开　Ctrl+回车：在「文件」页的编辑器里打开' : '回车：在编辑器里打开　Ctrl+回车：在右栏打开'}
          </div>
        )}

        {(!full || (error && entries.length > 0)) && (
          <div className="border-t border-line-soft px-3 py-1.5 text-[11px] text-faint">
            {error && entries.length > 0 ? `刷新文件列表失败，显示的是上次的结果：${error}` : `文件太多，只列了前 ${LIST_LIMIT} 个`}
          </div>
        )}
      </div>
    </div>
  )
}
