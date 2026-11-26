// 会话里的「他在干什么」：你发完话到 AI 回话之间，把参与的 AI 现在的动作摆在消息流最下面。
// 上半是纯函数（tests/liveActivity.test.ts），下半是活动事件的小仓库（订阅主进程推的事件）
import { useSyncExternalStore } from 'react'
import type { ActivityEvent, Agent, GroupMessage, MemberStatus, MemberStatusKind } from '../../../core/types'
import { toolLabel } from './format'
import { statusText } from './memberStatus'

/** 你发话后这么久还没回，就不再当成「在等它回」了 */
export const OWES_WINDOW_MS = 30 * 60_000
/** 一行里最多列几步 */
export const MAX_STEPS = 3
/** 最多列几个 AI，多的收成一句 */
export const MAX_ROWS = 4
/**
 * 连着干活时，两次调用之间的空当最多算这么久：这段时间里那一行留着，写「刚做完：…」。
 * 不留的话 AI 每调一次工具那一行就出来一下、调完又没了，上面的消息跟着一抽一抽
 */
export const LINGER_MS = 60_000

/** 不算「干活」的调用：等消息、看群聊、确认身份这些 */
const QUIET_TOOLS = new Set(['chat_wait', 'chat_read', 'chat_channels', 'chat_send', 'whoami', 'team_list', 'list_workspaces', 'command_audit'])
/** 调了这些说明这一段活干完了：说了话，或者去等消息了 */
const TURN_END_TOOLS = new Set(['chat_send', 'chat_wait'])

const short = (s: string, max = 48): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 一步动作说成几个字：「读文件 src/a.ts」「执行命令 npm test」 */
export function eventText(e: Pick<ActivityEvent, 'tool' | 'path' | 'summary' | 'args'>): string {
  const label = toolLabel(e.tool)
  const cmd = typeof e.args?.command === 'string' ? e.args.command : undefined
  const detail = e.path ?? cmd ?? (typeof e.args?.pattern === 'string' ? e.args.pattern : undefined) ?? (typeof e.args?.url === 'string' ? e.args.url : undefined)
  return detail ? `${label} ${short(detail)}` : label
}

export interface LiveRow {
  agentId: string
  name: string
  color: string
  kind: MemberStatusKind
  /** 现在在干什么，一句话 */
  text: string
  /** 进入这个状态的时间，算「已经多久」用 */
  since?: number
  /** 这一轮（你上一句话之后）做过的步骤，最近的在后，最多 MAX_STEPS 个 */
  steps: string[]
  /** 这一轮一共做了几步 */
  stepCount: number
  /** 真有调用在途（转圈），还是只是在线 */
  busy: boolean
}

export interface LiveView {
  rows: LiveRow[]
  /** 行太多没列出来的还有几个在干活 */
  more: number
  /** 该回话但不在线的 AI 的名字 */
  offline: string[]
  /** 有的行只是留在两次调用之间的空当里：到这个时间（毫秒时间戳）要是还没有新动作就该撤了，界面到点重算一次 */
  until?: number
}

/**
 * 你说的话会送到谁那里：「分工明确」只有主脑；「灵感激荡」挑过人就是那几个，没挑就是全部；
 * 这句话里 @ 了谁（或 @所有人）再加上；私聊只有那一个
 */
export function audienceOf(members: Agent[], opts: { leadId?: string; partIds?: string[] }, ask?: GroupMessage): Agent[] {
  if (ask?.to) return members.filter((a) => a.id === ask.to)
  const mentions = ask?.mentions ?? []
  if (mentions.includes('*')) return members
  const base = opts.leadId ? new Set([opts.leadId]) : opts.partIds ? new Set(opts.partIds) : undefined
  return members.filter((a) => !base || base.has(a.id) || mentions.includes(a.id))
}

/**
 * 消息流最下面该摆什么（只看这句话会送到的那些 AI）：
 * - 正在调工具 / 跑命令的，总是列出来；
 * - 你最近一句话（30 分钟内）之后还没回话的：在线的列出来（在等消息、空闲、可能卡住），不在线的收成一句；
 * - 已经回过话、手上也没在干活的，不列。
 * 工作台不给细分状态（status 是 undefined）时什么都不摆
 */
export function liveActivity(opts: {
  messages: GroupMessage[]
  members: Agent[]
  status: Record<string, MemberStatus> | undefined
  events: ActivityEvent[]
  now: number
  /** 「分工明确」的主脑 */
  leadId?: string
  /** 「灵感激荡」挑过的参与者 */
  partIds?: string[]
}): LiveView {
  const { messages, status, events, now } = opts
  const out: LiveView = { rows: [], more: 0, offline: [] }
  if (!status) return out
  // 你最近说的一句话（自动记的事件、回执不算）
  let ask: GroupMessage | undefined
  for (const m of messages) if (m.from.kind === 'user' && !m.kind && (!ask || m.ts > ask.ts)) ask = m
  const asked = ask?.ts ?? 0
  const waiting = asked > 0 && now - asked < OWES_WINDOW_MS
  const rows: LiveRow[] = []
  /** 留在空当里的那几个 AI */
  const active = new Set<string>()
  for (const a of audienceOf(opts.members, opts, ask)) {
    const ms = status[a.id]
    const kind: MemberStatusKind = ms?.status ?? 'offline'
    const replied = asked > 0 && messages.some((m) => m.from.kind === 'agent' && m.from.id === a.id && !m.kind && m.ts > asked)
    const owes = waiting && !replied
    const mine = events.filter((e) => e.agentId === a.id)
    // 在途的调用：不在线的不算，太久以前的也不算（工作台重启过的话，「开始」那条可能永远等不到「结束」）
    const running = kind === 'offline' ? undefined : mine.filter((e) => e.status === 'running' && !QUIET_TOOLS.has(e.tool) && now - e.ts < OWES_WINDOW_MS).sort((x, y) => y.ts - x.ts)[0]
    // 真在干活：有调用在途（等消息、发消息这些不算），或者有命令在跑。刚调完的那 20 秒不算——回完话还挂着一行没意思
    const busy = !!running || (kind === 'command' && (ms?.background === true || ms?.calling !== false)) || (kind === 'working' && ms?.calling !== false && !QUIET_TOOLS.has(ms?.tool ?? ''))
    // 连着干活的空当：上一次干活的调用刚结束不久，之后没说过话、也没去等消息。这段时间那一行留着
    const lastWork = mine.filter((e) => e.status !== 'running' && !QUIET_TOOLS.has(e.tool)).sort((x, y) => y.ts + (y.durationMs ?? 0) - (x.ts + (x.durationMs ?? 0)))[0]
    const ended = lastWork ? lastWork.ts + (lastWork.durationMs ?? 0) : 0
    const between =
      !busy &&
      !!lastWork &&
      kind !== 'offline' &&
      kind !== 'waiting' &&
      now - ended < LINGER_MS &&
      !mine.some((e) => TURN_END_TOOLS.has(e.tool) && e.ts >= lastWork.ts) &&
      !messages.some((m) => m.from.kind === 'agent' && m.from.id === a.id && !m.kind && m.ts >= lastWork.ts)
    if (!busy && !owes && !between) continue
    if (kind === 'offline') {
      out.offline.push(a.name)
      continue
    }
    // 这一轮：你上一句话之后；没有上一句话（AI 之间自己在聊）就看最近十分钟
    const from = asked > 0 ? asked : now - 10 * 60_000
    const done = mine.filter((e) => e.status !== 'running' && e.ts >= from && !QUIET_TOOLS.has(e.tool)).sort((x, y) => x.ts - y.ts)
    // 刚调完的是确认身份、发消息这类，不值得说
    const justDone = (kind === 'working' || kind === 'command') && ms?.calling === false && !ms.background && ms.tool && !QUIET_TOOLS.has(ms.tool) ? ms.tool : undefined
    const text = running ? `正在${eventText(running)}` : justDone ? `刚做完：${toolLabel(justDone)}` : between && lastWork ? `刚做完：${toolLabel(lastWork.tool)}` : busy && ms ? statusText(ms, now) : kind === 'waiting' ? '在等消息' : kind === 'idle' || kind === 'working' || kind === 'command' ? '在线，没有动作' : ms ? statusText(ms, now) : '在线'
    rows.push({ agentId: a.id, name: a.name, color: a.color, kind, text, since: running ? running.ts : between && !justDone ? ended : ms?.since, steps: done.slice(-MAX_STEPS).map(eventText), stepCount: done.length, busy })
    if (between) {
      active.add(a.id)
      out.until = Math.min(out.until ?? Infinity, ended + LINGER_MS)
    }
  }
  // 在干活的排前面（空当里的也算在干活，不然两个 AI 一起干活时两行会来回换位置）
  const rank = (r: LiveRow): number => Number(r.busy || active.has(r.agentId))
  rows.sort((x, y) => rank(y) - rank(x))
  out.rows = rows.slice(0, MAX_ROWS)
  out.more = rows.length - out.rows.length
  return out
}

/**
 * 名字后面那几个字：它现在在干什么。只说现在，不说「刚调完什么」；等消息、发消息这类调用不算干活。
 * 不在线的不写（返回 undefined）
 */
export function headerStatus(ms: MemberStatus, now = Date.now()): { text: string; busy: boolean } | undefined {
  const calling = ms.calling !== false && !!ms.tool && !QUIET_TOOLS.has(ms.tool)
  switch (ms.status) {
    case 'offline':
      return undefined
    case 'working':
      return calling ? { text: `正在${toolLabel(ms.tool ?? '')}`, busy: true } : { text: '在线', busy: false }
    case 'command':
      if (ms.background) return { text: ms.commands ? `后台跑着 ${ms.commands} 个命令` : '后台跑着命令', busy: true }
      return calling ? { text: `正在${toolLabel(ms.tool ?? '')}`, busy: true } : { text: '在线', busy: false }
    case 'waiting':
      return { text: '在等消息', busy: false }
    case 'idle':
      return { text: '在线', busy: false }
    default:
      return { text: statusText(ms, now), busy: false }
  }
}

/** 每个 AI 最近一段话的开头那条消息：名字后面挂它现在的状态用。返回 消息 id → AI id */
export function lastHeaders(rows: { m: GroupMessage; first: boolean }[]): Map<string, string> {
  const byAgent = new Map<string, string>()
  for (const r of rows) if (r.first && r.m.from.kind === 'agent' && !r.m.kind) byAgent.set(r.m.from.id, r.m.id)
  return new Map([...byAgent].map(([agent, id]) => [id, agent]))
}

// ========== 活动列表里的「等消息」 ==========

/** 一次没等到消息的 chat_wait：还在等，或者超时返回了 */
const isIdleWait = (e: ActivityEvent): boolean => e.tool === 'chat_wait' && (e.status === 'running' || /超时/.test(e.summary ?? ''))

/**
 * 待命的 AI 每隔几十秒就有一条「等群聊消息：超时」，活动列表会被它刷满。
 * 同一个 AI 连着的这种等待合成一条（放在最后一次的位置）：写几点起、等了多久、一共几次。
 * 中间它干了别的事（包括等到了消息），就从那以后重新算。events 按时间从早到晚
 */
export function foldWaits(events: ActivityEvent[], fmt: { time: (ts: number) => string; duration: (ms: number) => string }): ActivityEvent[] {
  const runs = new Map<string, { first: ActivityEvent; last: number; n: number }>()
  const drop = new Set<number>()
  const folded = new Map<number, { first: ActivityEvent; n: number }>()
  events.forEach((e, i) => {
    if (!isIdleWait(e)) {
      runs.delete(e.agentId)
      return
    }
    const run = runs.get(e.agentId)
    if (!run) {
      runs.set(e.agentId, { first: e, last: i, n: 1 })
      return
    }
    drop.add(run.last)
    folded.delete(run.last)
    run.last = i
    run.n++
    folded.set(i, { first: run.first, n: run.n })
  })
  const out: ActivityEvent[] = []
  events.forEach((e, i) => {
    if (drop.has(i)) return
    const f = folded.get(i)
    out.push(f ? { ...e, summary: `在等消息：${fmt.time(f.first.ts)} 起，已 ${fmt.duration(e.ts - f.first.ts)}（${f.n} 次，中间没有新消息）` } : e)
  })
  return out
}

// ========== 活动事件的小仓库 ==========

const KEEP = 400
let events: ActivityEvent[] = []
let started = false
const subs = new Set<() => void>()

function put(list: ActivityEvent[]): void {
  // 同一次调用会来两条（开始时 running、结束时带结果），id 相同：后来的盖掉前面的
  const byId = new Map(events.map((e) => [e.id, e]))
  for (const e of list) byId.set(e.id, e)
  events = [...byId.values()].sort((a, b) => a.ts - b.ts).slice(-KEEP)
  for (const l of subs) l()
}

function start(): void {
  if (started) return
  started = true
  void window.bridge
    .getEvents()
    .then((list) => put(list))
    .catch(() => undefined)
  window.bridge.onEvent((e) => put([e]))
}

const subscribe = (cb: () => void): (() => void) => {
  start()
  subs.add(cb)
  return () => subs.delete(cb)
}
const get = (): ActivityEvent[] => events

/** 最近的活动事件（按时间从早到晚） */
export const useLiveEvents = (): ActivityEvent[] => useSyncExternalStore(subscribe, get, get)
