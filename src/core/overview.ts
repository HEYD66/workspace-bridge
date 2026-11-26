/**
 * 概览仪表盘的统计：近 24 小时的工具调用（按 AI、按小时、按工具），以及各处计数的汇总类型。
 * 调用记录来自 EventLog：启动时从审计 jsonl（今天和昨天两天的文件）补一次，之后事件到达时增量记。
 * 只记已完成的调用（ok / error），command_audit 不是 AI 调的工具，不计。
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { ActivityEvent, TaskStatus, TunnelState } from './types'

export const OVERVIEW_WINDOW_MS = 24 * 60 * 60 * 1000
export const OVERVIEW_HOURS = 24
export const OVERVIEW_TOP_TOOLS = 5
/** 内存里最多留多少条调用记录（防止刷屏的 AI 把内存撑爆；超出就丢最旧的） */
export const MAX_STAT_RECORDS = 200_000

const HOUR_MS = 60 * 60 * 1000

export interface OverviewAgent {
  id: string
  name: string
  color: string
  /** 能用「整台电脑」 */
  machineAccess: boolean
  roleName?: string
  online: boolean
  sessions: number
  clientName?: string
  currentTool?: string
  /** 最近一次调用开始的时间（毫秒）；24 小时内没调用过也可能有（来自更早的记录或在线心跳） */
  lastCallAt?: number
  calls24h: number
  errors24h: number
  topTools: { tool: string; count: number }[]
}

export interface OverviewWorkspace {
  id: string
  name: string
  kind?: 'machine'
  exists: boolean
  active: boolean
  tasks: Record<TaskStatus, number>
}

export interface Overview {
  generatedAt: number
  running: boolean
  paused: boolean
  agents: OverviewAgent[]
  totals: {
    onlineAgents: number
    calls24h: number
    errors24h: number
    /** 0～1；没有调用时是 0 */
    errorRate: number
    /** 24 个桶，最旧的在前，最后一个是当前这一小时；hourStart 是整点时间戳 */
    hourly: { hourStart: number; calls: number; errors: number }[]
  }
  runningCommands: number
  tunnel: TunnelState
  publicUrl?: string
  lanEnabled: boolean
  mcpUrl: string
  lanUrls: string[]
  workspaces: OverviewWorkspace[]
  /** 所有工作区合计 */
  taskTotals: Record<TaskStatus, number>
  chat: { unread: number; mentions: number }
}

export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'review', 'done', 'blocked']

export function emptyTaskCounts(): Record<TaskStatus, number> {
  return { todo: 0, in_progress: 0, review: 0, done: 0, blocked: 0 }
}

interface CallRecord {
  id: string
  ts: number
  agentId: string
  tool: string
  error: boolean
}

export interface AgentCallStats {
  calls: number
  errors: number
  topTools: { tool: string; count: number }[]
  lastCallAt?: number
}

export interface CallStatsSnapshot {
  calls: number
  errors: number
  hourly: { hourStart: number; calls: number; errors: number }[]
  byAgent: Map<string, AgentCallStats>
}

/** 近 24 小时调用统计：增量记录，读的时候裁掉窗口外的 */
export class CallStats {
  private records: CallRecord[] = []
  private readonly seen = new Set<string>()
  private readonly lastCall = new Map<string, number>()
  private seeded: Promise<void> | undefined

  constructor(private readonly now: () => number = Date.now) {}

  /** EventLog 的 'event'：running 只更新最近调用时间，ok / error 计一次调用 */
  ingest(ev: Pick<ActivityEvent, 'id' | 'ts' | 'agentId' | 'tool' | 'status'>): void {
    if (!ev || ev.tool === 'command_audit' || !ev.agentId) return
    const prev = this.lastCall.get(ev.agentId) ?? 0
    if (ev.ts > prev) this.lastCall.set(ev.agentId, ev.ts)
    if (ev.status === 'running') return
    if (this.seen.has(ev.id)) return
    if (ev.ts < this.now() - OVERVIEW_WINDOW_MS) return
    this.seen.add(ev.id)
    this.records.push({ id: ev.id, ts: ev.ts, agentId: ev.agentId, tool: ev.tool, error: ev.status === 'error' })
    if (this.records.length > MAX_STAT_RECORDS) this.prune(true)
  }

  /**
   * 从审计目录补最近 24 小时的记录（今天和昨天的文件，按 UTC 日期命名）。只跑一次；
   * 和启动后增量记的按事件 id 去重。读不到或坏行直接跳过
   */
  seedFromAudit(auditDir: string): Promise<void> {
    this.seeded ??= (async () => {
      const now = this.now()
      const days = new Set([new Date(now).toISOString().slice(0, 10), new Date(now - OVERVIEW_WINDOW_MS).toISOString().slice(0, 10)])
      for (const day of days) {
        const file = path.join(auditDir, `${day}.jsonl`)
        if (!fs.existsSync(file)) continue
        try {
          const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity })
          for await (const line of rl) {
            if (!line) continue
            try {
              const ev = JSON.parse(line) as ActivityEvent
              if (typeof ev.id === 'string' && typeof ev.ts === 'number' && typeof ev.agentId === 'string' && typeof ev.tool === 'string') this.ingest(ev)
            } catch {
              // 坏行跳过
            }
          }
        } catch {
          // 文件读不了就算了
        }
      }
      this.records.sort((a, b) => a.ts - b.ts)
    })()
    return this.seeded
  }

  /** 丢掉窗口外的记录；force 时还要把条数压回上限 */
  private prune(force = false): void {
    const cutoff = this.now() - OVERVIEW_WINDOW_MS
    let drop = 0
    // 记录基本按时间追加（补审计时排过序），从头找第一个还在窗口里的
    while (drop < this.records.length && this.records[drop].ts < cutoff) drop++
    if (force && this.records.length - drop > MAX_STAT_RECORDS) drop = this.records.length - MAX_STAT_RECORDS
    if (drop > 0) {
      for (const r of this.records.slice(0, drop)) this.seen.delete(r.id)
      this.records = this.records.slice(drop)
    }
  }

  snapshot(): CallStatsSnapshot {
    this.prune()
    const now = this.now()
    const cutoff = now - OVERVIEW_WINDOW_MS
    const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS
    const firstHour = currentHour - (OVERVIEW_HOURS - 1) * HOUR_MS
    const hourly = Array.from({ length: OVERVIEW_HOURS }, (_, i) => ({ hourStart: firstHour + i * HOUR_MS, calls: 0, errors: 0 }))
    const perAgent = new Map<string, { calls: number; errors: number; tools: Map<string, number> }>()
    let calls = 0
    let errors = 0
    for (const r of this.records) {
      if (r.ts < cutoff || r.ts > now + 60_000) continue
      calls++
      if (r.error) errors++
      const idx = Math.floor((r.ts - firstHour) / HOUR_MS)
      // 最旧那一桶只覆盖窗口内的部分；更早的那几分钟算进第一桶
      const bucket = hourly[Math.min(OVERVIEW_HOURS - 1, Math.max(0, idx))]
      bucket.calls++
      if (r.error) bucket.errors++
      let a = perAgent.get(r.agentId)
      if (!a) perAgent.set(r.agentId, (a = { calls: 0, errors: 0, tools: new Map() }))
      a.calls++
      if (r.error) a.errors++
      a.tools.set(r.tool, (a.tools.get(r.tool) ?? 0) + 1)
    }
    const byAgent = new Map<string, AgentCallStats>()
    const ids = new Set([...perAgent.keys(), ...this.lastCall.keys()])
    for (const id of ids) {
      const a = perAgent.get(id)
      const topTools = a
        ? [...a.tools.entries()]
            .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
            .slice(0, OVERVIEW_TOP_TOOLS)
            .map(([tool, count]) => ({ tool, count }))
        : []
      const last = this.lastCall.get(id)
      byAgent.set(id, { calls: a?.calls ?? 0, errors: a?.errors ?? 0, topTools, ...(last ? { lastCallAt: last } : {}) })
    }
    return { calls, errors, hourly, byAgent }
  }
}
