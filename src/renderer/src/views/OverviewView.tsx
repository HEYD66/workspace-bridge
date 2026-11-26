import { Activity, AlertTriangle, Bot, Globe, TerminalSquare } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Overview, OverviewAgent } from '../../../core/overview'
import { Avatar, Badge, Card, cx } from '../components/ui'
import { STATUS_META, STATUS_ORDER, errText, timeAgo, toolLabel } from '../lib/format'
import { navigate } from '../lib/nav'

/** 页面自己的刷新间隔；主进程那边也缓存 5 秒 */
const REFRESH_MS = 5000
/** bridge 推 state / event 很密，合并成最多每秒刷新一次 */
const PUSH_THROTTLE_MS = 1000

function useOverview(): { data?: Overview; error: string } {
  const [data, setData] = useState<Overview>()
  const [error, setError] = useState('')
  const inflight = useRef(false)
  const lastPush = useRef(0)
  const pushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const load = useCallback(() => {
    if (inflight.current) return
    inflight.current = true
    window.bridge
      .getOverview()
      .then((o) => {
        setData(o)
        setError('')
      })
      .catch((e) => setError(errText(e)))
      .finally(() => (inflight.current = false))
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, REFRESH_MS)
    const onPush = () => {
      const wait = lastPush.current + PUSH_THROTTLE_MS - Date.now()
      if (wait <= 0) {
        lastPush.current = Date.now()
        load()
      } else if (!pushTimer.current) {
        pushTimer.current = setTimeout(() => {
          pushTimer.current = undefined
          lastPush.current = Date.now()
          load()
        }, wait)
      }
    }
    const offState = window.bridge.onState(onPush)
    const offEvent = window.bridge.onEvent(onPush)
    return () => {
      clearInterval(timer)
      if (pushTimer.current) clearTimeout(pushTimer.current)
      offState()
      offEvent()
    }
  }, [load])

  return { data, error }
}

function StatCard({
  icon,
  label,
  value,
  hint,
  tone,
  onClick,
  title
}: {
  icon: ReactNode
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: 'ok' | 'warn' | 'bad' | 'accent'
  onClick?: () => void
  title?: string
}) {
  const toneCls = tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : tone === 'accent' ? 'text-accent' : 'text-fg'
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-xs text-muted">
        {icon}
        {label}
      </div>
      <div className={cx('mt-1 text-2xl font-semibold tabular-nums', toneCls)}>{value}</div>
      {hint && <div className="mt-0.5 truncate text-[11px] text-faint">{hint}</div>}
    </>
  )
  if (onClick) {
    return (
      <button type="button" title={title} onClick={onClick} className="cursor-pointer rounded-lg border border-line bg-panel p-3 text-left hover:bg-hover">
        {body}
      </button>
    )
  }
  return <div className="rounded-lg border border-line bg-panel p-3">{body}</div>
}

/** 24 小时调用量柱状图：纯 SVG，错误叠在柱子底部用红色 */
function HourlyChart({ hourly }: { hourly: Overview['totals']['hourly'] }) {
  const W = 720
  const H = 140
  const PAD_B = 18
  const max = Math.max(1, ...hourly.map((h) => h.calls))
  const bw = W / hourly.length
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-36 w-full" role="img" aria-label="近 24 小时调用量">
      {hourly.map((h, i) => {
        const ch = ((H - PAD_B - 4) * h.calls) / max
        const eh = ((H - PAD_B - 4) * h.errors) / max
        const x = i * bw + 2
        const hour = new Date(h.hourStart).getHours()
        return (
          <g key={h.hourStart}>
            <title>{`${hour}:00～${hour + 1}:00　调用 ${h.calls}，错误 ${h.errors}`}</title>
            <rect x={x} y={0} width={bw - 4} height={H - PAD_B} fill="transparent" />
            <rect x={x} y={H - PAD_B - ch} width={bw - 4} height={ch} rx={2} fill="var(--color-accent)" opacity={0.75} />
            {eh > 0 && <rect x={x} y={H - PAD_B - eh} width={bw - 4} height={eh} rx={2} fill="var(--color-bad)" />}
            {(i % 3 === 0 || i === hourly.length - 1) && (
              <text x={x + (bw - 4) / 2} y={H - 4} textAnchor="middle" fontSize={10} fill="var(--color-faint)">
                {hour}时
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

function AgentRow({ a, now }: { a: OverviewAgent; now: number }) {
  const status = a.currentTool ? `正在 ${toolLabel(a.currentTool)}` : a.online ? '在线' : '离线'
  return (
    <tr className="cursor-pointer border-t border-line-soft hover:bg-hover" onClick={() => navigate({ section: 'team', id: a.id })} title="在团队页打开">
      <td className="py-1.5 pr-2 pl-3">
        <div className="flex items-center gap-2">
          <Avatar name={a.name} color={a.color} size={22} active={a.online} />
          <div className="min-w-0">
            <div className="truncate text-fg">{a.name}</div>
            {(a.clientName || a.roleName) && <div className="truncate text-[11px] text-faint">{[a.roleName, a.clientName].filter(Boolean).join(' · ')}</div>}
          </div>
        </div>
      </td>
      <td className="px-2">
        <span className={cx('text-xs', a.currentTool ? 'text-accent' : a.online ? 'text-ok' : 'text-faint')}>{status}</span>
        {a.sessions > 1 && <span className="ml-1 text-[11px] text-faint">{a.sessions} 个连接</span>}
      </td>
      <td className={cx('px-2 text-xs', a.machineAccess ? 'text-warn' : 'text-faint')}>{a.machineAccess ? '开' : '关'}</td>
      <td className="px-2 text-right tabular-nums">{a.calls24h}</td>
      <td className={cx('px-2 text-right tabular-nums', a.errors24h ? 'text-bad' : 'text-faint')}>{a.errors24h}</td>
      <td className="px-2">
        <div className="flex flex-wrap gap-1">
          {a.topTools.length ? a.topTools.map((t) => <Badge key={t.tool}>{`${toolLabel(t.tool)} ${t.count}`}</Badge>) : <span className="text-xs text-faint">—</span>}
        </div>
      </td>
      <td className="pr-3 pl-2 text-right text-xs whitespace-nowrap text-muted">{a.lastCallAt ? timeAgo(a.lastCallAt, now) : '—'}</td>
    </tr>
  )
}

function tunnelText(o: Overview): { value: string; tone: 'ok' | 'warn' | 'bad' | undefined; hint: string } {
  const t = o.tunnel
  if (t.status === 'running') return { value: '运行中', tone: 'ok', hint: o.publicUrl ?? t.url ?? '' }
  if (t.status === 'starting') return { value: '启动中', tone: 'warn', hint: t.mode === 'named' ? '自有域名' : '临时地址' }
  if (t.status === 'error') return { value: '出错', tone: 'bad', hint: t.error ?? '' }
  return { value: '未开启', tone: undefined, hint: o.lanEnabled ? '局域网已开' : '只在本机' }
}

export function OverviewView() {
  const { data: o, error } = useOverview()
  if (!o) {
    return <div className="p-6 text-sm text-muted">{error ? `概览加载失败：${error}` : '正在加载概览…'}</div>
  }
  const now = o.generatedAt
  const rate = o.totals.errorRate
  const tunnel = tunnelText(o)
  const agents = [...o.agents].sort((a, b) => Number(b.online) - Number(a.online) || b.calls24h - a.calls24h || (b.lastCallAt ?? 0) - (a.lastCallAt ?? 0))
  const workspaces = o.workspaces.filter((w) => w.kind !== 'machine' || STATUS_ORDER.some((s) => w.tasks[s] > 0))

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-5">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-fg">概览</h1>
        <div className="text-xs text-faint">
          {!o.running ? <span className="text-bad">MCP 服务没有运行</span> : o.paused ? <span className="text-warn">已暂停所有 AI 操作</span> : <span>{o.mcpUrl}</span>}
          {error && <span className="ml-2 text-bad">刷新失败：{error}</span>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard icon={<Bot size={14} />} label="在线 AI" value={o.totals.onlineAgents} hint={`共 ${o.agents.length} 个身份`} tone={o.totals.onlineAgents ? 'ok' : undefined} />
        <StatCard icon={<Activity size={14} />} label="24 小时调用" value={o.totals.calls24h} hint={`错误 ${o.totals.errors24h} 次`} />
        <StatCard
          icon={<AlertTriangle size={14} />}
          label="错误率"
          value={`${(rate * 100).toFixed(rate > 0 && rate < 0.1 ? 1 : 0)}%`}
          hint="近 24 小时"
          tone={rate >= 0.2 ? 'bad' : rate >= 0.05 ? 'warn' : undefined}
        />
        <StatCard
          icon={<TerminalSquare size={14} />}
          label="运行中命令"
          value={o.runningCommands}
          hint="AI 发起的命令"
          tone={o.runningCommands ? 'accent' : undefined}
          onClick={() => navigate({ section: 'commands' })}
          title="打开 AI 命令"
        />
        <StatCard icon={<Globe size={14} />} label="隧道" value={tunnel.value} hint={tunnel.hint} tone={tunnel.tone} onClick={() => navigate({ section: 'settings' })} title="到设置里管理隧道" />
      </div>

      <Card className="p-3">
        <div className="mb-1 flex items-center justify-between text-xs text-muted">
          <span>近 24 小时调用量（按小时）</span>
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm bg-accent opacity-75" />调用</span>
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm bg-bad" />错误</span>
          </span>
        </div>
        <HourlyChart hourly={o.totals.hourly} />
      </Card>

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-faint">
              <th className="py-2 pr-2 pl-3 font-normal">AI</th>
              <th className="px-2 font-normal">状态</th>
              <th className="px-2 font-normal" title="能不能用本机任意盘的文件；在团队页开关">整台电脑</th>
              <th className="px-2 text-right font-normal">调用</th>
              <th className="px-2 text-right font-normal">错误</th>
              <th className="px-2 font-normal">常用工具</th>
              <th className="pr-3 pl-2 text-right font-normal">最后活跃</th>
            </tr>
          </thead>
          <tbody>
            {agents.length ? (
              agents.map((a) => <AgentRow key={a.id} a={a} now={now} />)
            ) : (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-xs text-faint">
                  还没有接入的 AI，到「团队与职位」里新建一个
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <div className="grid gap-3 md:grid-cols-[1fr_auto]">
        <Card className="p-3">
          <div className="mb-2 flex items-center justify-between text-xs text-muted">
            <span>各工作区任务</span>
            <span className="flex gap-2">
              {STATUS_ORDER.map((s) => (
                <span key={s} style={{ color: STATUS_META[s].color }}>
                  {STATUS_META[s].label} {o.taskTotals[s]}
                </span>
              ))}
            </span>
          </div>
          {workspaces.length ? (
            <div className="space-y-1">
              {workspaces.map((w) => (
                <div key={w.id} className="flex items-center gap-2 text-sm">
                  <span className={cx('min-w-0 flex-1 truncate', w.exists ? 'text-fg' : 'text-faint line-through')} title={w.exists ? undefined : '目录不存在'}>
                    {w.kind === 'machine' ? '整台电脑' : w.name}
                    {w.active && <span className="ml-1.5 text-[11px] text-accent">当前</span>}
                  </span>
                  {STATUS_ORDER.map((s) => (
                    <span key={s} className={cx('w-14 text-right text-xs tabular-nums', !w.tasks[s] && 'text-faint')} style={w.tasks[s] ? { color: STATUS_META[s].color } : undefined}>
                      {w.tasks[s]}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-faint">还没有添加工作区</div>
          )}
        </Card>
        <StatCard
          icon={<Activity size={14} />}
          label="群聊未读"
          value={o.chat.unread}
          hint={o.chat.mentions ? `其中 @ 你 ${o.chat.mentions} 条` : '没有 @ 你的消息'}
          tone={o.chat.mentions ? 'bad' : o.chat.unread ? 'accent' : undefined}
          onClick={() => navigate({ section: 'group' })}
          title="打开群聊"
        />
      </div>
    </div>
  )
}
