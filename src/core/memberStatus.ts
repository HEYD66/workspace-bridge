/**
 * 成员状态：把「在线 / 离线」细分成 working、command、waiting、idle、stale、offline、paused，各带一个 since。
 *
 * 这里只做计算，不碰会话、任务、命令：Bridge 把事实（MemberFacts）拿来，这里结合工具调用的开始和结束算出状态。
 *
 * 判断顺序（前面的优先）：
 *  1. offline  没有主连接（只剩副连接也算 offline，readers 里写着哪些副连接还在）。内置 AI 没有连接，不走这条
 *  2. paused   工作台按了暂停
 *  3. working / command  有工具调用在途；在途的是 run_command 就是 command
 *  4. waiting  主连接正在 chat_wait 里等
 *  5. 刚调完工具不到 graceMs（默认 20 秒）：沿用刚才的状态。AI 两次调用之间在想，不该闪成 idle
 *  6. command  没有调用在途，但它有后台命令还在跑
 *  7. stale    超过 staleMs（默认 10 分钟）没有任何请求，也不在等消息：多半是这一轮结束了或者掉线了
 *  8. idle
 */
import type { MemberStatus, MemberStatusKind } from './types'

/** 超过这么久没有动作、也不在等消息，算「可能掉线」 */
export const MEMBER_STALE_MS = 10 * 60_000
/** 一次调用结束后这么久之内还算在连续干活（或连续等消息） */
export const MEMBER_GRACE_MS = 20_000
/** 一次调用挂了这么久还没结束，就当结束事件丢了，不再算在途 */
export const MEMBER_CALL_MAX_MS = 15 * 60_000
/** 状态里最多带几个进行中的任务 */
export const MEMBER_STATUS_TASKS = 5

/** 等消息类的工具：在途时不算干活 */
const WAIT_TOOLS = new Set(['chat_wait', 'wait_for_resume'])
/** 审计记录不是 AI 调的工具 */
const IGNORED_TOOLS = new Set(['command_audit'])
const COMMAND_TOOLS = new Set(['run_command'])

export interface MemberStatusOptions {
  staleMs?: number
  graceMs?: number
}

export interface MemberTaskRef {
  ref: string
  title: string
  workspaceId: string
}

/** Bridge 提供的事实 */
export interface MemberFacts {
  now: number
  /** 工作台是否暂停，以及从什么时候开始 */
  paused?: boolean
  pausedSince?: number
  /** 内置 AI：没有连接，不会 offline / stale */
  builtin?: boolean
  /** 这个成员的全部会话（含副连接） */
  sessions: { lastSeen: number; createdAt: number; reader?: string }[]
  /** 主连接是否正在 ChatStore 里等消息 */
  waiting?: boolean
  /** 它名下还在跑的后台命令的开始时间 */
  commands?: number[]
  /** 它手上进行中的任务 */
  tasks?: MemberTaskRef[]
  /** 最后一个主连接是什么时候断的（不知道就不给） */
  offlineSince?: number
}

interface Burst {
  /** 这一段连续调用从什么时候开始 */
  since: number
  running: Map<string, { tool: string; ts: number }>
  lastEnd: number
  lastTool?: string
}

interface Track {
  work: Burst
  wait: Burst
  /** 没有 chat_wait 事件却看到它在等（直接调 ChatStore 的情况）：第一次看到的时间 */
  waitSeen?: number
}

const newBurst = (): Burst => ({ since: 0, running: new Map(), lastEnd: 0 })

export class MemberActivity {
  readonly staleMs: number
  readonly graceMs: number
  private tracks = new Map<string, Track>()

  constructor(opts: MemberStatusOptions = {}) {
    this.staleMs = opts.staleMs !== undefined && opts.staleMs > 0 ? opts.staleMs : MEMBER_STALE_MS
    this.graceMs = opts.graceMs !== undefined && opts.graceMs >= 0 ? opts.graceMs : MEMBER_GRACE_MS
  }

  private track(agentId: string): Track {
    let t = this.tracks.get(agentId)
    if (!t) {
      t = { work: newBurst(), wait: newBurst() }
      this.tracks.set(agentId, t)
    }
    return t
  }

  /**
   * 记一条活动事件：同一个 id 先来 running，再来 ok / error。
   * now 是收到事件的时间（结束事件用它当结束时间）。
   */
  ingest(ev: { id: string; agentId: string; tool: string; status: string; ts: number }, now: number = Date.now()): void {
    if (IGNORED_TOOLS.has(ev.tool)) return
    const t = this.track(ev.agentId)
    const b = WAIT_TOOLS.has(ev.tool) ? t.wait : t.work
    if (ev.status === 'running') {
      this.prune(b, now)
      // 上一段已经停了超过 graceMs，这次算新的一段
      if (b.running.size === 0 && now - b.lastEnd > this.graceMs) b.since = now
      b.running.set(ev.id, { tool: ev.tool, ts: now })
      b.lastTool = ev.tool
      return
    }
    // 结束：没见过开始的（比如启动前开始的）也当一次动作记下
    if (!b.running.delete(ev.id) && now - b.lastEnd > this.graceMs && b.running.size === 0) b.since = now
    b.lastEnd = Math.max(b.lastEnd, now)
    b.lastTool = ev.tool
  }

  /** 成员被吊销：丢掉它的记录 */
  forget(agentId: string): void {
    this.tracks.delete(agentId)
  }

  /** 挂了太久的调用不再算在途 */
  private prune(b: Burst, now: number): void {
    for (const [id, r] of b.running) {
      if (now - r.ts > MEMBER_CALL_MAX_MS) {
        b.running.delete(id)
        b.lastEnd = Math.max(b.lastEnd, r.ts)
      }
    }
  }

  status(agentId: string, f: MemberFacts): MemberStatus {
    const now = f.now
    const t = this.track(agentId)
    this.prune(t.work, now)
    this.prune(t.wait, now)
    const main = f.sessions.filter((s) => !s.reader)
    const readers = [...new Set(f.sessions.filter((s) => s.reader).map((s) => s.reader as string))].sort()
    const lastSeen = Math.max(0, ...main.map((s) => s.lastSeen))
    const tasks = (f.tasks ?? []).slice(0, MEMBER_STATUS_TASKS)
    const commands = f.commands ?? []
    const base = {
      sessions: f.sessions.length,
      ...(readers.length ? { readers } : {}),
      ...(lastSeen ? { lastSeen } : {}),
      ...(tasks.length ? { tasks } : {}),
      ...(commands.length ? { commands: commands.length } : {})
    }
    const make = (status: MemberStatusKind, since: number | undefined, extra: Partial<MemberStatus> = {}): MemberStatus => ({
      status,
      ...(since !== undefined && since > 0 ? { since: Math.min(since, now) } : {}),
      ...base,
      ...extra
    })
    if (!f.waiting) t.waitSeen = undefined

    if (!f.builtin && main.length === 0) return make('offline', f.offlineSince)
    if (f.paused) return make('paused', f.pausedSince)

    const workKind = (tool: string | undefined): MemberStatusKind => (tool && COMMAND_TOOLS.has(tool) ? 'command' : 'working')
    if (t.work.running.size > 0) {
      // 同时有几个调用在途时报最后开始的那个
      const tool = [...t.work.running.values()].at(-1)!.tool
      return make(workKind(tool), t.work.since, { tool, calling: true })
    }
    if (f.waiting) {
      if (t.wait.running.size === 0 && t.waitSeen === undefined) t.waitSeen = now
      return make('waiting', t.wait.running.size > 0 ? t.wait.since : t.waitSeen)
    }
    const workEnd = t.work.lastEnd
    const waitEnd = t.wait.lastEnd
    if (workEnd > 0 && workEnd >= waitEnd && now - workEnd <= this.graceMs) {
      return make(workKind(t.work.lastTool), t.work.since, { ...(t.work.lastTool ? { tool: t.work.lastTool } : {}), calling: false })
    }
    if (waitEnd > workEnd && now - waitEnd <= this.graceMs) return make('waiting', t.wait.since)
    if (commands.length) return make('command', Math.min(...commands), { background: true })

    const lastActive = Math.max(workEnd, waitEnd, lastSeen, ...main.map((s) => s.createdAt))
    if (!f.builtin && now - lastActive > this.staleMs) return make('stale', lastActive + this.staleMs)
    return make('idle', lastActive)
  }
}

const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000))

/**
 * 给派活的人看的提示：对方 stale 或 offline 时返回一句话，其他状态返回 undefined。
 * 任务通知是跟着对方下一次工具调用带回去的，对方不动就收不到。
 */
export function memberHint(name: string, st: MemberStatus, now: number, staleMs: number = MEMBER_STALE_MS): string | undefined {
  if (st.status === 'stale') {
    const idle = st.since !== undefined ? minutes(now - st.since + staleMs) : minutes(staleMs)
    return `提示：${name} 可能掉线了（${idle} 分钟没有动作，也不在等消息），这条通知要等它下次调用工具才收得到`
  }
  if (st.status === 'offline') {
    const ago = st.since !== undefined ? `已经离线 ${minutes(now - st.since)} 分钟` : '现在不在线'
    return `提示：${name} ${ago}，要等它重新连上并调用工具才收得到这条通知`
  }
  return undefined
}

/** 状态的一句话说法（team_list 和提示里用） */
export function describeMemberStatus(st: MemberStatus): string {
  switch (st.status) {
    case 'working':
      return st.tool ? `工作中（${st.tool}）` : '工作中'
    case 'command':
      return st.background ? '后台命令在跑' : '正在跑命令'
    case 'waiting':
      return '在等消息'
    case 'idle':
      return '空闲'
    case 'stale':
      return '可能掉线'
    case 'offline':
      return '离线'
    case 'paused':
      return '已暂停'
  }
}

/**
 * 盯着「手上挂着进行中的任务却没动静」的成员：每个成员每个任务，一段没动静的时间里只报一次。
 * 成员重新有动作后清掉，下次再没动静会再报。
 */
export class StaleWatch {
  private told = new Map<string, Set<string>>()

  /**
   * 返回这次该报的任务。gone = 这个成员现在算没动静（stale，或者 offline 已经超过 staleMs）。
   */
  check<T extends MemberTaskRef>(agentId: string, gone: boolean, tasks: T[]): T[] {
    if (!gone) {
      this.told.delete(agentId)
      return []
    }
    let seen = this.told.get(agentId)
    if (!seen) {
      seen = new Set()
      this.told.set(agentId, seen)
    }
    const out: T[] = []
    for (const t of tasks) {
      const key = `${t.workspaceId}:${t.ref}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(t)
    }
    return out
  }

  forget(agentId: string): void {
    this.told.delete(agentId)
  }
}

/** 这个状态算不算「没动静」：stale，或者 offline 已经超过 staleMs（不知道什么时候离线的不算，免得一启动就全报一遍） */
export function memberGone(st: MemberStatus, now: number, staleMs: number = MEMBER_STALE_MS): boolean {
  if (st.status === 'stale') return true
  return st.status === 'offline' && st.since !== undefined && now - st.since >= staleMs
}
