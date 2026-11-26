// 画布的「撞车」数据：哪几个 AI 正在改或占着同一个文件（T-20），纯计算。
//
// 「正在」怎么算：
// - 文件占用登记（core/fileClaims）没过期就算，以登记的 expiresAt 为准：主动登记默认 30 分钟，写过文件自动登记 10 分钟；
// - 改动记录里 WRITE_WINDOW_MS（10 分钟，和自动登记一样长）内经工作台写过的文件也算（登记推到界面前就能看见）。
// 只看经过工作台写文件工具的改动：Cursor 等绕过工作台的写入这里看不到。
// 只在同一个工作区里比：同一个文件一个 AI 从「MCP」工作区用相对路径写、另一个从「整台电脑」用绝对路径写，会当成两个文件，看不出撞车。
// glob 登记只和具体路径比；两个 glob 只有写法完全一样才算撞上。不带 glob 的路径同时盖住它下面的文件（当目录用），和 fileClaims 一样。
import type { ActivityEvent } from '../../../core/types'
import { FILE_WRITE_TOOLS } from './format'

/** 写过的文件多久内算「正在改」：和写过自动登记的时长（IMPLICIT_TTL_MIN）一样 */
export const WRITE_WINDOW_MS = 10 * 60_000

/** 一条占用登记里画布要用的字段（ClaimSummary['claims'] 的元素） */
export interface ClaimLike {
  agentId: string
  agentName: string
  paths: string[]
  task: string | null
  kind: 'explicit' | 'implicit'
  since: number
  expiresAt: number
}

export interface FileHold {
  agentId: string
  agentName: string
  /** 从什么时候起占着或开始改 */
  since: number
  /** 到什么时候不再算「正在」 */
  until: number
  /** claim：有占用登记；write：只在改动记录里写过 */
  via: 'claim' | 'write'
  /** 登记的种类（via 为 claim 时才有） */
  kind?: 'explicit' | 'implicit'
  task?: string | null
}

export interface FileConflict {
  /** `${工作区 id}|${路径}` */
  id: string
  workspaceId: string
  /** 撞上的文件（工作区相对路径；整台电脑是绝对路径）；一边登记的是目录或 glob 时取具体的那个 */
  path: string
  /** 两个或更多人，早的在前 */
  holders: FileHold[]
  /** 撞上的时刻：第二个人开始占着或改的时间 */
  since: number
}

export interface ConflictInput {
  /** 每个工作区现在的占用登记 */
  claimsByWs?: Record<string, readonly ClaimLike[] | undefined>
  /** 改动记录 */
  events?: readonly ActivityEvent[]
  now: number
  /** 默认 true（用户在 Windows 上） */
  caseInsensitive?: boolean
  windowMs?: number
}

interface Hold extends FileHold {
  pattern: string
}

const hasGlob = (p: string): boolean => /[*?]/.test(p)

function norm(p: string): string {
  let s = p.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (s.startsWith('./')) s = s.slice(2)
  return s.length > 1 ? s.replace(/\/+$/, '') : s
}

/** glob → 正则，规则和 core/fileClaims 的 globToRegExp 一样（那边带 node:path，界面引不了） */
const reCache = new Map<string, RegExp>()

function toRegExp(pattern: string, ci: boolean): RegExp {
  const key = `${ci ? 'i' : 's'}|${pattern}`
  const hit = reCache.get(key)
  if (hit) return hit
  if (reCache.size > 500) reCache.clear()
  const segs = pattern.split('/')
  let re = ''
  segs.forEach((s, i) => {
    const last = i === segs.length - 1
    if (s === '**') {
      re += last ? '.*' : '(?:[^/]*/)*'
      return
    }
    re += s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    if (!last) re += '/'
  })
  const out = new RegExp(`^${re}${hasGlob(pattern) ? '' : '(?:/.*)?'}$`, ci ? 'i' : '')
  reCache.set(key, out)
  return out
}

/** 两个登记写法盖住的文件有没有交集；有就返回撞上的那个具体路径 */
function overlapOf(a: string, b: string, ci: boolean): string | undefined {
  const same = ci ? a.toLowerCase() === b.toLowerCase() : a === b
  if (same) return a
  const ga = hasGlob(a)
  const gb = hasGlob(b)
  if (ga && gb) return undefined
  if (!gb && toRegExp(a, ci).test(b)) return b
  if (!ga && toRegExp(b, ci).test(a)) return a
  return undefined
}

function holdsOf(input: ConflictInput): Map<string, Hold[]> {
  const windowMs = input.windowMs ?? WRITE_WINDOW_MS
  const byWs = new Map<string, Hold[]>()
  const add = (ws: string, h: Hold): void => {
    const list = byWs.get(ws)
    if (list) list.push(h)
    else byWs.set(ws, [h])
  }
  for (const [ws, claims] of Object.entries(input.claimsByWs ?? {})) {
    for (const c of claims ?? []) {
      if (!(c.expiresAt > input.now)) continue
      for (const p of c.paths) if (p) add(ws, { agentId: c.agentId, agentName: c.agentName, since: c.since, until: c.expiresAt, via: 'claim', kind: c.kind, task: c.task, pattern: norm(p) })
    }
  }
  // 同一个人同一个文件写了好几次：从第一次算起，到最后一次之后 windowMs
  const writes = new Map<string, Hold & { ws: string }>()
  for (const e of input.events ?? []) {
    if (!e.workspaceId || !e.path || e.status !== 'ok' || !FILE_WRITE_TOOLS.has(e.tool)) continue
    if (e.ts > input.now || input.now - e.ts > windowMs) continue
    const pattern = norm(e.path)
    const k = `${e.workspaceId}|${e.agentId}|${input.caseInsensitive === false ? pattern : pattern.toLowerCase()}`
    const was = writes.get(k)
    if (was) {
      was.since = Math.min(was.since, e.ts)
      was.until = Math.max(was.until, e.ts + windowMs)
    } else {
      writes.set(k, { ws: e.workspaceId, agentId: e.agentId, agentName: e.agentName, since: e.ts, until: e.ts + windowMs, via: 'write', pattern })
    }
  }
  for (const { ws, ...h } of writes.values()) add(ws, h)
  return byWs
}

/** 同一个人在同一个文件上有好几条（登记加写过）：并成一条，有登记的用登记的种类和任务 */
function merge(a: FileHold, b: FileHold): FileHold {
  const main = a.via === 'claim' ? a : b.via === 'claim' ? b : a
  return { ...main, since: Math.min(a.since, b.since), until: Math.max(a.until, b.until) }
}

function strip(h: Hold): FileHold {
  const out: FileHold = { agentId: h.agentId, agentName: h.agentName, since: h.since, until: h.until, via: h.via }
  if (h.kind) out.kind = h.kind
  if (h.task !== undefined) out.task = h.task
  return out
}

export function fileConflicts(input: ConflictInput): FileConflict[] {
  const ci = input.caseInsensitive !== false
  const out: FileConflict[] = []
  for (const [ws, holds] of holdsOf(input)) {
    const found = new Map<string, { path: string; holders: Map<string, FileHold> }>()
    for (let i = 0; i < holds.length; i++) {
      for (let j = i + 1; j < holds.length; j++) {
        const a = holds[i]
        const b = holds[j]
        if (a.agentId === b.agentId) continue
        const p = overlapOf(a.pattern, b.pattern, ci)
        if (p === undefined) continue
        const k = ci ? p.toLowerCase() : p
        let f = found.get(k)
        if (!f) {
          f = { path: p, holders: new Map() }
          found.set(k, f)
        }
        for (const src of [a, b]) {
          const h = strip(src)
          const was = f.holders.get(h.agentId)
          f.holders.set(h.agentId, was ? merge(was, h) : h)
        }
      }
    }
    for (const f of found.values()) {
      const holders = [...f.holders.values()].sort((x, y) => x.since - y.since || x.agentName.localeCompare(y.agentName))
      out.push({ id: `${ws}|${f.path}`, workspaceId: ws, path: f.path, holders, since: holders[1].since })
    }
  }
  return out.sort((x, y) => x.since - y.since || x.id.localeCompare(y.id))
}
