import { CaseSensitive, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Ellipsis, Loader2, RefreshCw, Regex, Search, WholeWord, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { BridgeState, SearchFileResult, SearchMatch, SearchResult } from '../../../shared/api'
import { FileIcon } from '../components/FileIcon'
import { cx, EmptyState, IconButton, PanelHeader } from '../components/ui'
import { openFile } from '../lib/editorStore'
import { errText } from '../lib/format'

const DEBOUNCE_MS = 300

interface Opts {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  include: string
  exclude: string
  /** 空字符串 = 全部工作区 */
  scope: string
}

interface Memo {
  opts: Opts
  showDetails: boolean
  result?: SearchResult
  error: string
  collapsed: string[]
}

// 切到别的分区时 SearchPanel 会卸载，回来时接着显示上次的搜索
let memo: Memo = {
  opts: { query: '', caseSensitive: false, wholeWord: false, regex: false, include: '', exclude: '', scope: '' },
  showDetails: false,
  error: '',
  collapsed: []
}

const fileKey = (f: SearchFileResult): string => `${f.workspaceId}:${f.path}`
const countOf = (f: SearchFileResult): number => f.matches.reduce((n, m) => n + m.ranges.length, 0)

/** 被截断时按原因说清楚：没搜完（超时、文件数上限、被新搜索打断）和搜完了但只显示一部分（结果上限）是两回事 */
function truncatedText(reason: string | undefined, shown: number): string {
  switch (reason) {
    case 'timeout':
      return `搜了 15 秒还没搜完，已停下，只显示目前找到的 ${shown} 处。缩小范围（设起始目录或「包含」规则）再搜`
    case 'scan_limit':
      return `看过的文件超过 20 万个，已停下，只显示目前找到的 ${shown} 处。缩小范围再搜`
    case 'max_results':
      return `结果太多，只显示前 ${shown} 处。换个更具体的词再搜`
    case 'max_matches_per_file':
      return '已搜完。有的文件匹配太多，每个文件只显示前 100 处'
    case 'canceled':
      return '这次搜索被新的搜索打断了'
    default:
      return '结果不完整，只显示了一部分。缩小范围或换个更具体的词再搜'
  }
}

const inputClass =
  'h-8 w-full rounded-md border border-line bg-canvas px-2.5 text-[13px] text-fg outline-none placeholder:text-faint focus:border-accent'

function Toggle({ on, title, onClick, children }: { on: boolean; title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      title={title}
      aria-label={title}
      aria-pressed={on}
      onClick={onClick}
      className={cx(
        'inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded',
        on ? 'bg-accent/25 text-accent ring-1 ring-accent/60' : 'text-faint hover:bg-hover hover:text-fg'
      )}
    >
      {children}
    </button>
  )
}

/** 一行匹配的显示：去掉行首缩进，匹配很靠后时只留前面一小段，保证高亮看得见 */
function lineParts(m: SearchMatch): { ellipsis: boolean; parts: { text: string; hit: boolean }[] } {
  const base = m.textStart ?? 0
  const text = m.text
  const rs = m.ranges
    .map(([s, e]): [number, number] => [Math.max(0, s - base), Math.min(text.length, e - base)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0])
  const indent = text.length - text.trimStart().length
  const first = rs[0]?.[0] ?? 0
  let cut = Math.min(indent, first)
  if (first - cut > 40) cut = first - 24
  const parts: { text: string; hit: boolean }[] = []
  let pos = cut
  for (const [s0, e] of rs) {
    const s = Math.max(s0, pos)
    if (e <= s) continue
    if (s > pos) parts.push({ text: text.slice(pos, s), hit: false })
    parts.push({ text: text.slice(s, e), hit: true })
    pos = e
  }
  if (pos < text.length) parts.push({ text: text.slice(pos), hit: false })
  return { ellipsis: base > 0 || cut > indent, parts }
}

function MatchRow({ f, m, active, onPick }: { f: SearchFileResult; m: SearchMatch; active: boolean; onPick: (pin: boolean) => void }) {
  const { ellipsis, parts } = useMemo(() => lineParts(m), [m])
  return (
    <div
      onClick={() => onPick(false)}
      onDoubleClick={() => onPick(true)}
      title={`${f.path}，第 ${m.line} 行（双击固定标签）`}
      className={cx('flex h-[22px] cursor-pointer items-center gap-2 pr-2 pl-[38px] text-xs hover:bg-hover', active && 'bg-accent/15')}
    >
      <span className="min-w-0 flex-1 overflow-hidden font-mono text-ellipsis whitespace-pre text-muted [tab-size:2]">
        {ellipsis && <span className="text-faint">…</span>}
        {parts.map((p, i) =>
          p.hit ? (
            <span key={i} className="rounded-sm bg-warn/30 text-fg">
              {p.text}
            </span>
          ) : (
            <span key={i}>{p.text}</span>
          )
        )}
      </span>
      <span className="shrink-0 font-mono text-[10px] text-faint">{m.line}</span>
    </div>
  )
}

function FileGroup({
  f,
  wsName,
  collapsed,
  activeKey,
  onToggle,
  onPick
}: {
  f: SearchFileResult
  wsName?: string
  collapsed: boolean
  activeKey?: string
  onToggle: () => void
  onPick: (m: SearchMatch, pin: boolean) => void
}) {
  const slash = f.path.lastIndexOf('/')
  const name = f.path.slice(slash + 1)
  const dir = slash > 0 ? f.path.slice(0, slash) : ''
  const where = [wsName, dir].filter(Boolean).join(' · ')
  return (
    <div>
      <div onClick={onToggle} title={wsName ? `${wsName}：${f.path}` : f.path} className="flex h-[22px] cursor-pointer items-center gap-1 pr-2 pl-1 hover:bg-hover">
        {collapsed ? <ChevronRight size={14} className="shrink-0 text-faint" /> : <ChevronDown size={14} className="shrink-0 text-faint" />}
        <FileIcon name={name} size={16} />
        <span className="truncate text-[13px] text-fg">{name}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-faint">{where}</span>
        <span className="shrink-0 rounded-full bg-hover px-1.5 text-[10px] leading-4 text-muted">
          {countOf(f)}
          {f.truncated ? '+' : ''}
        </span>
      </div>
      {!collapsed &&
        f.matches.map((m) => (
          <MatchRow key={m.line} f={f} m={m} active={activeKey === `${fileKey(f)}:${m.line}`} onPick={(pin) => onPick(m, pin)} />
        ))}
      {!collapsed && f.truncated && <div className="py-0.5 pl-[38px] text-[11px] text-faint">这个文件匹配太多，只显示前 100 处</div>}
    </div>
  )
}

/** 侧栏的全文搜索（像 VS Code）：边输入边搜，结果按文件分组，点一行跳到编辑器里对应位置 */
export function SearchPanel({ state }: { state: BridgeState }) {
  const workspaces = state.workspaces ?? []
  const usable = workspaces.filter((w) => w.exists)
  // 整台电脑总在列表里，不算进「多个工作区」
  const multi = workspaces.filter((w) => w.kind !== 'machine').length > 1

  const [opts, setOpts] = useState<Opts>(memo.opts)
  const [showDetails, setShowDetails] = useState(memo.showDetails)
  const [result, setResult] = useState<SearchResult | undefined>(memo.result)
  const [error, setError] = useState(memo.error)
  const [busy, setBusy] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(memo.collapsed))
  const [activeKey, setActiveKey] = useState<string>()
  const seq = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const restored = useRef(!!memo.result)
  const inputRef = useRef<HTMLInputElement>(null)

  // 选中的工作区被移出列表或目录没了：按全部工作区搜
  const scope = opts.scope && usable.some((w) => w.id === opts.scope) ? opts.scope : ''

  useEffect(() => {
    memo = { opts, showDetails, result, error, collapsed: [...collapsed] }
  }, [opts, showDetails, result, error, collapsed])

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
    return () => {
      // 卸载后迟到的结果不再处理
      seq.current++
      clearTimeout(timer.current)
    }
  }, [])

  const run = useCallback(async (o: Opts, workspaceId: string) => {
    const n = ++seq.current
    if (!o.query) {
      setResult(undefined)
      setError('')
      setBusy(false)
      return
    }
    setBusy(true)
    try {
      const r = await window.bridge.searchFiles({
        query: o.query,
        workspaceId: workspaceId || undefined,
        regex: o.regex,
        caseSensitive: o.caseSensitive,
        wholeWord: o.wholeWord,
        include: o.include.trim() || undefined,
        exclude: o.exclude.trim() || undefined
      })
      if (n !== seq.current) return
      setResult(r)
      setError('')
      setCollapsed(new Set())
    } catch (e) {
      if (n !== seq.current) return
      setResult(undefined)
      setError(errText(e))
    } finally {
      if (n === seq.current) setBusy(false)
    }
  }, [])

  // 输入防抖自动搜；从别的分区切回来、有上次结果时不重搜
  const key = JSON.stringify([opts.query, opts.caseSensitive, opts.wholeWord, opts.regex, opts.include, opts.exclude, scope])
  useEffect(() => {
    if (restored.current) {
      restored.current = false
      return
    }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void run(opts, scope), opts.query ? DEBOUNCE_MS : 0)
    return () => clearTimeout(timer.current)
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const searchNow = () => {
    clearTimeout(timer.current)
    void run(opts, scope)
  }
  const set = <K extends keyof Opts>(k: K, v: Opts[K]) => setOpts((o) => ({ ...o, [k]: v }))

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      searchNow()
    } else if (e.altKey && !e.ctrlKey && !e.metaKey) {
      // 和 VS Code 一样：Alt+C 大小写、Alt+W 全字、Alt+R 正则
      const k = e.key.toLowerCase()
      if (k === 'c') set('caseSensitive', !opts.caseSensitive)
      else if (k === 'w') set('wholeWord', !opts.wholeWord)
      else if (k === 'r') set('regex', !opts.regex)
      else return
      e.preventDefault()
    }
  }

  const files = result?.files ?? []
  const allCollapsed = files.length > 0 && files.every((f) => collapsed.has(fileKey(f)))
  const wsName = (id: string): string | undefined => (multi ? (workspaces.find((w) => w.id === id)?.name ?? '已移除的工作区') : undefined)

  const pick = (f: SearchFileResult, m: SearchMatch, pin: boolean) => {
    setActiveKey(`${fileKey(f)}:${m.line}`)
    openFile({ workspaceId: f.workspaceId, path: f.path, line: m.line, column: (m.ranges[0]?.[0] ?? 0) + 1, preview: !pin })
  }
  const toggle = (k: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="搜索">
        <IconButton title="重新搜索" disabled={!opts.query} onClick={searchNow} className="disabled:pointer-events-none disabled:opacity-40">
          <RefreshCw size={13} />
        </IconButton>
        <IconButton
          title={allCollapsed ? '全部展开' : '全部折叠'}
          disabled={!files.length}
          onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(files.map(fileKey)))}
          className="disabled:pointer-events-none disabled:opacity-40"
        >
          {allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
        </IconButton>
        <IconButton
          title="清除搜索结果"
          disabled={!opts.query && !result && !error}
          onClick={() => {
            set('query', '')
            inputRef.current?.focus()
          }}
          className="disabled:pointer-events-none disabled:opacity-40"
        >
          <X size={13} />
        </IconButton>
      </PanelHeader>

      <div className="space-y-1.5 px-3 pb-2">
        <div className="flex items-center gap-1">
          <div className="relative min-w-0 flex-1">
            <input
              ref={inputRef}
              value={opts.query}
              onChange={(e) => set('query', e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="搜索"
              spellCheck={false}
              className={cx(inputClass, 'pr-[74px]', error && 'border-bad/60 focus:border-bad')}
            />
            <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-0.5">
              <Toggle on={opts.caseSensitive} title="区分大小写（Alt+C）" onClick={() => set('caseSensitive', !opts.caseSensitive)}>
                <CaseSensitive size={14} />
              </Toggle>
              <Toggle on={opts.wholeWord} title="全字匹配（Alt+W）" onClick={() => set('wholeWord', !opts.wholeWord)}>
                <WholeWord size={14} />
              </Toggle>
              <Toggle on={opts.regex} title="正则表达式（Alt+R）" onClick={() => set('regex', !opts.regex)}>
                <Regex size={14} />
              </Toggle>
            </div>
          </div>
          <IconButton title={showDetails ? '隐藏包含 / 排除' : '包含 / 排除的文件'} onClick={() => setShowDetails(!showDetails)} className={cx(showDetails && 'text-fg')}>
            <Ellipsis size={14} />
          </IconButton>
        </div>

        {showDetails && (
          <div className="space-y-1.5">
            <div>
              <div className="mb-1 text-[11px] text-muted">包含的文件</div>
              <input value={opts.include} onChange={(e) => set('include', e.target.value)} onKeyDown={onKeyDown} placeholder="例如 src/**, *.ts" spellCheck={false} className={inputClass} />
            </div>
            <div>
              <div className="mb-1 text-[11px] text-muted">排除的文件</div>
              <input value={opts.exclude} onChange={(e) => set('exclude', e.target.value)} onKeyDown={onKeyDown} placeholder="例如 *.test.ts, docs" spellCheck={false} className={inputClass} />
              <div className="mt-1 text-[11px] leading-relaxed text-faint">逗号分隔。已默认跳过 node_modules、.git、out、dist、build 等目录和 .gitignore 里写的</div>
            </div>
          </div>
        )}

        {multi && (
          <select
            value={scope}
            onChange={(e) => set('scope', e.target.value)}
            title="搜索范围"
            className="h-7 w-full rounded-md border border-line bg-canvas px-2 text-xs text-fg outline-none focus:border-accent"
          >
            <option value="">全部工作区</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id} disabled={!w.exists}>
                {w.exists ? w.name : `${w.name}（目录不存在）`}
              </option>
            ))}
          </select>
        )}

        {error && <div className="text-[11px] leading-relaxed break-words text-bad">{error}</div>}
        {busy && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted">
            <Loader2 size={11} className="animate-spin" /> 搜索中…
          </div>
        )}
        {!busy && result && files.length > 0 && (
          <div className="text-[11px] text-muted">
            {files.length} 个文件中有 {result.totalMatches} 处结果
            <span className="text-faint">（{result.durationMs < 1000 ? `${result.durationMs} 毫秒` : `${(result.durationMs / 1000).toFixed(1)} 秒`}）</span>
          </div>
        )}
        {!busy && result?.truncated && <div className="text-[11px] leading-relaxed text-warn">{truncatedText(result.truncatedReason, result.totalMatches)}</div>}
        {!busy && !!result?.skippedLargeFiles && (
          <div className="text-[11px] leading-relaxed text-faint">有 {result.skippedLargeFiles} 个超过 2 MB 的文件没搜内容</div>
        )}
      </div>

      <div className="flex-1 overflow-auto pb-4">
        {usable.length === 0 ? (
          <EmptyState icon={<Search size={24} />} title="还没有可搜的工作区" hint="先在顶栏添加一个文件夹" />
        ) : !opts.query ? (
          <EmptyState icon={<Search size={24} />} title="搜索工作区里的文件内容" hint="输入后自动搜索，Enter 立即搜。单击结果打开预览，双击固定标签" />
        ) : (
          result &&
          !busy &&
          files.length === 0 &&
          !error &&
          (result.truncated ? (
            <EmptyState title="没搜完，目前还没找到" hint="工作区太大，没来得及搜完。设一个起始目录或「包含」规则缩小范围再搜" />
          ) : (
            <EmptyState title="没有找到结果" hint="检查一下大小写、全字、正则开关和包含 / 排除规则；node_modules、out、dist 等目录默认不搜" />
          ))
        )}
        {files.map((f) => (
          <FileGroup
            key={fileKey(f)}
            f={f}
            wsName={wsName(f.workspaceId)}
            collapsed={collapsed.has(fileKey(f))}
            activeKey={activeKey}
            onToggle={() => toggle(fileKey(f))}
            onPick={(m, pin) => pick(f, m, pin)}
          />
        ))}
      </div>
    </div>
  )
}
