// AI 命令监视：用户看所有 AI 用 run_command 跑过 / 正在跑的命令，读输出，替它停掉
import { Copy, Square, TerminalSquare } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AiCommandItem, AiCommandOutput } from '../../../shared/api'
import type { BridgeState } from '../../../core/types'
import { Avatar, Badge, Button, EmptyState, IconButton, PanelHeader, cx } from '../components/ui'
import { errText, formatBytes, timeAgo } from '../lib/format'

type StatusFilter = 'all' | 'running' | 'failed'

const STATUS_TEXT: Record<string, { label: string; color: string }> = {
  running: { label: '运行中', color: '#58a6ff' },
  completed: { label: '已结束', color: '#3fb950' },
  cancelled: { label: '已取消', color: '#d29922' },
  terminated: { label: '被终止', color: '#f85149' }
}

function statusOf(c: Pick<AiCommandItem, 'status' | 'exit_code'>): { label: string; color: string } {
  if (c.status === 'completed' && c.exit_code !== 0 && c.exit_code !== null && c.exit_code !== undefined) return { label: `退出码 ${c.exit_code}`, color: '#f85149' }
  return STATUS_TEXT[c.status] ?? { label: c.status, color: '#8b949e' }
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms} 毫秒`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

/** 去掉 ANSI 颜色 / 光标控制码（终端输出原样显示会是乱码），回车覆盖行只留最后一段 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  const noEsc = s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b[@-Z\\-_]/g, '')
  return noEsc
    .split('\n')
    .map((line) => {
      const i = line.lastIndexOf('\r', line.length - 2)
      return (i >= 0 ? line.slice(i + 1) : line).replace(/\r$/, '')
    })
    .join('\n')
}

/** 列表数据：首次进来拉一次，之后收到 'commands' 变化再拉 */
export function useAiCommands(): { list: AiCommandItem[]; running: number; error: string; reload: () => void } {
  const [list, setList] = useState<AiCommandItem[]>([])
  const [running, setRunning] = useState(0)
  const [error, setError] = useState('')
  const reload = useCallback(() => {
    window.bridge
      .listAiCommands()
      .then((r) => {
        setList(r.commands)
        setRunning(r.running)
        setError('')
      })
      .catch((e) => setError(errText(e)))
  }, [])
  useEffect(() => {
    reload()
    return window.bridge.onChanged((kind) => {
      if (kind === 'commands') reload()
    })
  }, [reload])
  return { list, running, error, reload }
}

export function CommandList({
  state,
  data,
  selected,
  onSelect
}: {
  state: BridgeState
  data: ReturnType<typeof useAiCommands>
  selected?: string
  onSelect: (id: string) => void
}) {
  const [status, setStatus] = useState<StatusFilter>('all')
  const [owner, setOwner] = useState('')
  const owners = useMemo(() => [...new Map(data.list.map((c) => [c.owner, c.owner_name])).entries()], [data.list])
  const shown = data.list.filter(
    (c) =>
      (!owner || c.owner === owner) &&
      (status === 'all' || (status === 'running' ? c.status === 'running' : c.status !== 'running' && statusOf(c).color === '#f85149'))
  )
  const colorOf = (c: AiCommandItem) => c.owner_color ?? state.agents.find((a) => a.id === c.owner)?.color ?? '#8b949e'
  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="AI 命令">
        {data.running > 0 && <Badge color="#58a6ff">{data.running} 条运行中</Badge>}
      </PanelHeader>
      <div className="flex gap-1.5 px-2.5 pb-2">
        <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className="min-w-0 flex-1 rounded border border-line bg-canvas px-1.5 py-1 text-xs text-fg">
          <option value="all">全部状态</option>
          <option value="running">运行中</option>
          <option value="failed">失败 / 被终止</option>
        </select>
        <select value={owner} onChange={(e) => setOwner(e.target.value)} className="min-w-0 flex-1 rounded border border-line bg-canvas px-1.5 py-1 text-xs text-fg">
          <option value="">全部 AI</option>
          {owners.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </div>
      {data.error && <div className="px-3 pb-2 text-xs text-bad">{data.error}</div>}
      <div className="flex-1 overflow-auto pb-2">
        {shown.length === 0 && (
          <EmptyState
            icon={<TerminalSquare size={24} />}
            title={data.list.length ? '没有符合条件的命令' : 'AI 还没有执行过命令'}
            hint="开了「命令执行」的 AI 用 run_command 跑的命令会出现在这里，你可以看输出、随时停掉"
          />
        )}
        {shown.map((c) => {
          const st = statusOf(c)
          return (
            <div
              key={c.command_id}
              onClick={() => onSelect(c.command_id)}
              className={cx('mx-1.5 cursor-pointer rounded px-2 py-1.5 hover:bg-hover', selected === c.command_id && 'bg-accent/15')}
            >
              <div className="flex items-center gap-1.5">
                <Avatar name={c.owner_name} color={colorOf(c)} size={14} active={c.status === 'running'} />
                <span className="truncate text-[11px] text-muted">{c.owner_name}</span>
                <span className="ml-auto shrink-0 text-[11px]" style={{ color: st.color }}>
                  {st.label}
                </span>
              </div>
              <div className="mt-0.5 truncate font-mono text-[12px] text-fg">{c.command.split('\n')[0]}</div>
              <div className="mt-0.5 flex gap-2 text-[11px] text-faint">
                <span>{timeAgo(Date.parse(c.started_at))}</span>
                <span>{duration(c.duration_ms)}</span>
                {c.shell === 'powershell' && <span>PowerShell</span>}
                {c.background && <span>后台</span>}
                <span className="ml-auto">{formatBytes(c.output_bytes)}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 输出最多在界面里留这么多字符，再多只留末尾 */
const MAX_VIEW_CHARS = 2_000_000

export function CommandDetail({ item }: { item?: AiCommandItem }) {
  const [out, setOut] = useState<AiCommandOutput | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const offsetRef = useRef(0)
  const boxRef = useRef<HTMLPreElement>(null)
  const followRef = useRef(true)
  const id = item?.command_id

  // 换了命令：从头读
  useEffect(() => {
    offsetRef.current = 0
    followRef.current = true
    setText('')
    setOut(null)
    setError('')
  }, [id])

  // 读增量输出：列表里这条的字节数或状态变了就接着读（运行中的命令由 'commands' 推送驱动）
  useEffect(() => {
    if (!id) return
    let alive = true
    const pull = async () => {
      try {
        for (let i = 0; i < 20 && alive; i++) {
          const r = await window.bridge.aiCommandOutput(id, offsetRef.current)
          if (!alive) return
          setOut(r)
          if (r.output) setText((t) => {
            const next = t + r.output
            return next.length > MAX_VIEW_CHARS ? next.slice(next.length - MAX_VIEW_CHARS) : next
          })
          if (typeof r.next_offset === 'number') offsetRef.current = r.next_offset
          if (!r.has_more) break
        }
      } catch (e) {
        if (alive) setError(errText(e))
      }
    }
    void pull()
    return () => {
      alive = false
    }
  }, [id, item?.output_bytes, item?.status])

  // 自动跟到底；用户往上滚就停
  useEffect(() => {
    const el = boxRef.current
    if (el && followRef.current) el.scrollTop = el.scrollHeight
  }, [text])

  if (!item) return <EmptyState icon={<TerminalSquare size={28} />} title="选一条命令看输出" hint="运行中的命令会实时刷新；需要时可以直接停掉" />

  const st = statusOf(item)
  const shown = stripAnsi(text)
  const stop = async () => {
    setBusy(true)
    try {
      await window.bridge.cancelAiCommand(item.command_id)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Badge color={st.color}>{st.label}</Badge>
          <span className="text-xs text-muted">
            {item.owner_name} · {item.shell === 'powershell' ? 'PowerShell' : 'bash'} · {timeAgo(Date.parse(item.started_at))}开始 · 用时 {duration(item.duration_ms)}
            {out?.output_lost ? ' · 早期输出已丢弃' : ''}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <IconButton title="复制命令" onClick={() => void window.bridge.copy(item.command)}>
              <Copy size={13} />
            </IconButton>
            {item.status === 'running' && (
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void stop()}>
                <Square size={11} /> {busy ? '正在停止…' : '停止'}
              </Button>
            )}
          </div>
        </div>
        <pre className="max-h-40 overflow-auto rounded border border-line-soft bg-canvas px-2.5 py-2 font-mono text-[12px] whitespace-pre-wrap break-all text-fg">{item.command}</pre>
        <div className="truncate font-mono text-[11px] text-faint" title={item.cwd}>
          cwd：{item.cwd}
        </div>
        {error && <div className="text-xs text-bad">{error}</div>}
      </div>
      <div className="flex items-center gap-2 px-4 py-1.5 text-[11px] text-faint">
        输出 · {formatBytes(item.output_bytes)}
        <button className="ml-auto cursor-pointer hover:text-fg" onClick={() => void window.bridge.copy(shown)}>
          复制输出
        </button>
      </div>
      <pre
        ref={boxRef}
        onScroll={(e) => {
          const el = e.currentTarget
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        className="mx-4 mb-4 flex-1 overflow-auto rounded border border-line-soft bg-canvas px-3 py-2 font-mono text-[12px] leading-[1.45] whitespace-pre-wrap break-all text-fg"
      >
        {shown || (item.status === 'running' ? '（等待输出…）' : '（没有输出）')}
      </pre>
    </div>
  )
}
