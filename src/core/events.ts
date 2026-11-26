import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { redactText, redactValue } from './redact'
import type { ActivityEvent } from './types'

const MAX_MEMORY_EVENTS = 1000
const MAX_ARG_CHARS = 2000
const MAX_DIFF_IN_AUDIT = 20_000

/** 参数截断加脱敏：AI 写入的大段内容不进日志全文，只留长度和开头；令牌换成 [REDACTED] */
export function sanitizeArgs(args: Record<string, unknown>, secrets: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args ?? {})) {
    if (typeof v === 'string') {
      // 先脱敏再截断：令牌跨在截断点上时也不会留下半截
      const r = redactText(v, secrets)
      out[k] = r.length > MAX_ARG_CHARS ? `${r.slice(0, MAX_ARG_CHARS)}…（共 ${v.length} 字符）` : r
    } else if (v && typeof v === 'object') {
      const r = redactValue(v, secrets)
      const s = JSON.stringify(r)
      out[k] = s.length > MAX_ARG_CHARS ? `${s.slice(0, MAX_ARG_CHARS)}…（共 ${s.length} 字符）` : r
    } else {
      out[k] = v
    }
  }
  return out
}

export interface EventLogOptions {
  /** 当前所有令牌原值（静态令牌、隧道令牌等），写日志前替换掉；每次写都重新取，换过的令牌也能覆盖 */
  secrets?: () => readonly string[]
}

/**
 * 活动事件总线：内存里留最近 1000 条给工作台，完成的事件按天追加到 audit/YYYY-MM-DD.jsonl。
 * 事件：'event' (ActivityEvent) —— 同一个 id 先发 running，再发 ok/error。
 * 参数、路径、错误、摘要、diff 都先脱敏再进内存和审计文件。
 */
export class EventLog extends EventEmitter {
  private events: ActivityEvent[] = []
  private writeChain: Promise<void> = Promise.resolve()
  private readonly auditDir: string
  private readonly secrets: () => readonly string[]

  constructor(dataDir: string, opts: EventLogOptions = {}) {
    super()
    this.auditDir = path.join(dataDir, 'audit')
    this.secrets = opts.secrets ?? (() => [])
    fs.mkdirSync(this.auditDir, { recursive: true })
  }

  private currentSecrets(): readonly string[] {
    try {
      return this.secrets()
    } catch {
      return []
    }
  }

  start(e: Omit<ActivityEvent, 'id' | 'ts' | 'status'>): ActivityEvent {
    const secrets = this.currentSecrets()
    const ev: ActivityEvent = { ...e, args: sanitizeArgs(e.args, secrets), id: crypto.randomUUID(), ts: Date.now(), status: 'running' }
    if (typeof ev.path === 'string') ev.path = redactText(ev.path, secrets)
    this.events.push(ev)
    if (this.events.length > MAX_MEMORY_EVENTS) this.events.splice(0, this.events.length - MAX_MEMORY_EVENTS)
    this.emit('event', ev)
    return ev
  }

  finish(ev: ActivityEvent, patch: Partial<Pick<ActivityEvent, 'status' | 'summary' | 'error' | 'diff' | 'path'>>): ActivityEvent {
    const secrets = this.currentSecrets()
    const clean = { ...patch }
    if (typeof clean.error === 'string') clean.error = redactText(clean.error, secrets)
    if (typeof clean.summary === 'string') clean.summary = redactText(clean.summary, secrets)
    if (typeof clean.path === 'string') clean.path = redactText(clean.path, secrets)
    if (typeof clean.diff === 'string') clean.diff = redactText(clean.diff, secrets, { mode: 'light' })
    Object.assign(ev, clean, { durationMs: Date.now() - ev.ts })
    this.emit('event', ev)
    this.appendAudit(ev)
    return ev
  }

  recent(limit = 500): ActivityEvent[] {
    return this.events.slice(-limit)
  }

  private appendAudit(ev: ActivityEvent): void {
    const day = new Date(ev.ts).toISOString().slice(0, 10)
    const record = { ...ev, diff: ev.diff && ev.diff.length > MAX_DIFF_IN_AUDIT ? ev.diff.slice(0, MAX_DIFF_IN_AUDIT) + '\n…' : ev.diff }
    const line = JSON.stringify(record) + '\n'
    // 串行追加，保证同一天文件里的行不交错
    this.writeChain = this.writeChain
      .then(() => fsp.appendFile(path.join(this.auditDir, `${day}.jsonl`), line, 'utf8'))
      .catch((err) => {
        this.emit('audit-error', err)
      })
  }

  /** 等待日志落盘（测试和退出时用） */
  flush(): Promise<void> {
    return this.writeChain
  }
}
