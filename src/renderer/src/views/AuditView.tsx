// 审计日志：读数据目录 audit/*.jsonl（每次工具调用一条，已脱敏），筛选、翻页、统计、导出 CSV
import { ChevronDown, ChevronRight, Download, RefreshCw, ScrollText, Search } from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AuditPage, AuditQuery, AuditRow, AuditStats } from '../../../core/auditReader'
import type { BridgeState } from '../../../core/types'
import { Avatar, Button, EmptyState, IconButton, cx } from '../components/ui'
import { errText } from '../lib/format'

type Range = 'today' | '24h' | '7d' | '30d'
const RANGES: { value: Range; label: string }[] = [
  { value: 'today', label: '今天' },
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' }
]

function rangeFrom(r: Range, now = Date.now()): number {
  if (r === 'today') {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  return now - (r === '24h' ? 1 : r === '7d' ? 7 : 30) * 24 * 3600_000
}

const pad = (n: number) => String(n).padStart(2, '0')
export function auditTime(ts: number, now = Date.now()): string {
  const d = new Date(ts)
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return new Date(now).toDateString() === d.toDateString() ? t : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${t.slice(0, 5)}`
}

function prettyArgs(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

const sel = 'rounded border border-line bg-canvas px-1.5 py-1 text-xs text-fg'

export function AuditView({ state }: { state: BridgeState }) {
  const [range, setRange] = useState<Range>('24h')
  const [agentId, setAgentId] = useState('')
  const [tool, setTool] = useState('')
  const [status, setStatus] = useState<'' | 'ok' | 'error'>('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [text, setText] = useState('')
  const [debounced, setDebounced] = useState('')
  const [rows, setRows] = useState<AuditRow[]>([])
  const [page, setPage] = useState<AuditPage | null>(null)
  const [stats, setStats] = useState<AuditStats | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const seq = useRef(0)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 300)
    return () => clearTimeout(t)
  }, [text])

  const query = useMemo<AuditQuery>(
    () => ({
      from: rangeFrom(range),
      ...(agentId ? { agentId } : {}),
      ...(tool ? { tool } : {}),
      ...(status ? { status } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(debounced ? { text: debounced } : {}),
      limit: 200
    }),
    [range, agentId, tool, status, workspaceId, debounced]
  )

  const load = useCallback(
    async (more: boolean) => {
      const my = ++seq.current
      setBusy(true)
      setError('')
      try {
        const p = await window.bridge.queryAudit({ ...query, ...(more && page?.nextCursor ? { cursor: page.nextCursor } : {}) })
        if (my !== seq.current) return
        setPage(p)
        setRows((old) => (more ? [...old, ...p.rows] : p.rows))
        if (!more) {
          const s = await window.bridge.auditStats({ from: query.from, ...(agentId ? { agentId } : {}), ...(workspaceId ? { workspaceId } : {}) })
          if (my === seq.current) setStats(s)
        }
      } catch (e) {
        if (my === seq.current) setError(errText(e))
      } finally {
        if (my === seq.current) setBusy(false)
      }
    },
    [query, page?.nextCursor, agentId, workspaceId]
  )

  useEffect(() => {
    void load(false)
    // 只在条件变化时重查；load 依赖 page 会造成循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const agents = state.agents
  const wsName = (id?: string) => (id ? (state.workspaces ?? []).find((w) => w.id === id)?.name ?? id : '')
  const colorOf = (r: AuditRow) => r.agentColor ?? agents.find((a) => a.id === r.agentId)?.color ?? '#8b949e'
  const tools = stats?.byTool.map((t) => t.tool) ?? []

  const exportCsv = async () => {
    setNotice('')
    try {
      const r = await window.bridge.exportAudit({ ...query, limit: undefined })
      if (r.saved) setNotice(`已导出 ${r.rows} 行到 ${r.path}${r.truncated ? '（到上限，未全部导出）' : ''}`)
    } catch (e) {
      setError(errText(e))
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <ScrollText size={15} className="text-muted" />
        <span className="text-[13px] font-medium text-fg">审计日志</span>
        <div className="ml-2 flex overflow-hidden rounded border border-line">
          {RANGES.map((r) => (
            <button
              key={r.value}
              onClick={() => setRange(r.value)}
              className={cx('cursor-pointer px-2 py-1 text-xs', range === r.value ? 'bg-accent/20 text-fg' : 'text-muted hover:bg-hover')}
            >
              {r.label}
            </button>
          ))}
        </div>
        <select className={sel} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">全部 AI</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select className={sel} value={tool} onChange={(e) => setTool(e.target.value)}>
          <option value="">全部工具</option>
          {[...new Set([...(tool ? [tool] : []), ...tools])].map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select className={sel} value={status} onChange={(e) => setStatus(e.target.value as '' | 'ok' | 'error')}>
          <option value="">全部状态</option>
          <option value="ok">成功</option>
          <option value="error">出错</option>
        </select>
        <select className={sel} value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
          <option value="">全部工作区</option>
          {(state.workspaces ?? []).map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <div className="flex min-w-[160px] flex-1 items-center gap-1 rounded border border-line bg-canvas px-1.5">
          <Search size={12} className="text-faint" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="搜工具、路径、摘要、错误、参数" className="w-full bg-transparent py-1 text-xs text-fg outline-none" />
        </div>
        <IconButton title="刷新" onClick={() => void load(false)}>
          <RefreshCw size={13} className={cx(busy && 'animate-spin')} />
        </IconButton>
        <Button size="sm" onClick={() => void exportCsv()}>
          <Download size={12} /> 导出 CSV
        </Button>
      </div>

      {stats && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-line-soft px-4 py-2 text-xs text-muted">
          <span>
            调用 <b className="text-fg">{stats.total}</b> 次 · 出错 <b className={stats.errors ? 'text-bad' : 'text-fg'}>{stats.errors}</b>
            {stats.total ? `（${((stats.errors / stats.total) * 100).toFixed(1)}%）` : ''}
          </span>
          <span className="flex flex-wrap gap-2">
            常用：
            {stats.byTool.slice(0, 5).map((t) => (
              <button key={t.tool} className="cursor-pointer hover:text-fg" onClick={() => setTool(t.tool)}>
                {t.tool} <span className="text-faint">{t.calls}</span>
                {t.errors ? <span className="text-bad"> / {t.errors}</span> : null}
              </button>
            ))}
          </span>
          <span className="flex flex-wrap gap-2">
            {stats.byAgent.slice(0, 6).map((a) => (
              <span key={a.agentId}>
                {a.agentName} <span className="text-faint">{a.calls}</span>
              </span>
            ))}
          </span>
        </div>
      )}
      {error && <div className="px-4 py-2 text-xs text-bad">{error}</div>}
      {notice && <div className="px-4 py-2 text-xs text-ok">{notice}</div>}

      <div className="flex-1 overflow-auto">
        {rows.length === 0 && !busy ? (
          <EmptyState icon={<ScrollText size={26} />} title="这个范围内没有记录" hint="AI 每次调用工具都会记一条；换个时间范围或去掉筛选试试" />
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-panel text-left text-faint">
              <tr>
                <th className="w-6" />
                <th className="px-2 py-1.5 font-normal">时间</th>
                <th className="px-2 py-1.5 font-normal">AI</th>
                <th className="px-2 py-1.5 font-normal">工具</th>
                <th className="px-2 py-1.5 font-normal">工作区</th>
                <th className="px-2 py-1.5 font-normal">耗时</th>
                <th className="px-2 py-1.5 font-normal">结果</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = open === r.id
                const bad = r.status === 'error'
                return (
                  <Fragment key={r.id}>
                    <tr onClick={() => setOpen(isOpen ? null : r.id)} className={cx('cursor-pointer border-t border-line-soft hover:bg-hover', isOpen && 'bg-accent/10')}>
                      <td className="pl-2 text-faint">{isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</td>
                      <td className="px-2 py-1 font-mono whitespace-nowrap text-muted">{auditTime(r.ts)}</td>
                      <td className="px-2 py-1 whitespace-nowrap">
                        <span className="flex items-center gap-1.5">
                          <Avatar name={r.agentName} color={colorOf(r)} size={14} />
                          {r.agentName}
                        </span>
                      </td>
                      <td className="px-2 py-1 font-mono whitespace-nowrap text-fg">{r.tool}</td>
                      <td className="max-w-[140px] truncate px-2 py-1 text-muted">{wsName(r.workspaceId)}</td>
                      <td className="px-2 py-1 whitespace-nowrap text-faint">{typeof r.durationMs === 'number' ? `${r.durationMs} ms` : ''}</td>
                      <td className={cx('max-w-[520px] truncate px-2 py-1', bad ? 'text-bad' : 'text-muted')}>{bad ? r.error ?? '出错' : r.summary ?? r.path ?? ''}</td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-canvas">
                        <td />
                        <td colSpan={6} className="px-2 pt-1 pb-3">
                          {r.path && <div className="mb-1 font-mono text-[11px] text-muted">路径：{r.path}</div>}
                          {r.summary && <div className="mb-1 text-[12px] text-fg">{r.summary}</div>}
                          {r.error && <div className="mb-1 text-[12px] whitespace-pre-wrap text-bad">{r.error}</div>}
                          <pre className="max-h-72 overflow-auto rounded border border-line-soft bg-panel px-2.5 py-2 font-mono text-[11.5px] whitespace-pre-wrap break-all text-fg">{prettyArgs(r.args)}</pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
        <div className="flex items-center gap-3 px-4 py-3 text-xs text-faint">
          {rows.length > 0 && <span>已显示 {rows.length} 条</span>}
          {page?.truncated && <span className="text-warn">扫描到上限，结果可能不全，缩小时间范围再看</span>}
          {page?.nextCursor && (
            <Button size="sm" disabled={busy} onClick={() => void load(true)}>
              {busy ? '加载中…' : '加载更多'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
