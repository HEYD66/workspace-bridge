// 优化第 7 条：文件占用登记。几个 AI 共用一个工作目录时，记下谁在改哪些文件；别人写已登记的文件时给提醒。
// 只管经过工作台写文件工具的写入：用户在工作台里直接保存文件既不登记，也不受提醒或拦截；
// Cursor 等绕过工作台的改动这里也看不到，unclaimed() 只帮调用方把 git status 里谁也没登记的路径挑出来。
import path from 'node:path'
import { JsonStore } from './jsonStore'
import { ToolError } from './fileTools'

export type ClaimKind = 'explicit' | 'implicit'
/** warn：照常写，结果里加提醒（默认）；block：拦主动登记的文件（第 12 条，用户答复前不开）；off：不提醒 */
export type ClaimMode = 'warn' | 'block' | 'off'

export interface FileClaim {
  id: string
  agentId: string
  agentName: string
  /** MCP 会话 id；会话断开时按它释放 */
  session: string | null
  /** 路径或 glob，相对工作区根、/ 分隔（机器工作区存绝对路径） */
  paths: string[]
  task: string | null
  note?: string
  /** explicit：主动登记；implicit：写过文件自动登记 */
  kind: ClaimKind
  createdAt: number
  expiresAt: number
}

export interface ClaimHolder {
  agentId: string
  agentName: string
  session?: string | null
}

export interface ClaimHit {
  path: string
  pattern: string
  claimId: string
  agentId: string
  agentName: string
  task: string | null
  kind: ClaimKind
  since: number
  expiresAt: number
}

export interface ClaimGate {
  /** 只有 block 模式且命中主动登记时为 true */
  blocked: boolean
  hits: ClaimHit[]
  /** 放进写文件结果的【占用提醒】文本块；没有命中或 off 模式为 null */
  text: string | null
}

export interface ClaimSummary {
  claims: { id: string; agentId: string; agentName: string; task: string | null; paths: string[]; kind: ClaimKind; since: number; expiresAt: number }[]
  /** 名字 → 占着的路径（去重） */
  byAgent: Record<string, string[]>
}

interface ClaimFile {
  version: 1
  claims: FileClaim[]
}

export const EXPLICIT_TTL_MIN = 30
export const MIN_TTL_MIN = 1
export const MAX_TTL_MIN = 240
export const IMPLICIT_TTL_MIN = 10
const NOTIFY_DEDUPE_MS = 10 * 60_000
const MINUTE = 60_000

export interface FileClaimOptions {
  /** 工作区根目录 */
  root: string
  /** 机器工作区（整台电脑）：存绝对路径，不做越出根目录的检查 */
  machine?: boolean
  /** 默认按平台：Windows 不分大小写 */
  caseInsensitive?: boolean
  mode?: ClaimMode
  now?: () => number
}

const GLOB_CHARS = /[*?]/

function hasGlob(p: string): boolean {
  return GLOB_CHARS.test(p)
}

function toSlash(p: string): string {
  return p.replace(/\\/g, '/')
}

function isAbsoluteAny(p: string): boolean {
  return /^[a-zA-Z]:\//.test(p) || p.startsWith('/')
}

/** glob → 正则：** 占零到多级目录，* 和 ? 不跨 /；不带 glob 的路径同时覆盖它下面的所有文件（当目录用） */
export function globToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
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
  return new RegExp(`^${re}${hasGlob(pattern) ? '' : '(?:/.*)?'}$`, caseInsensitive ? 'i' : '')
}

function newId(): string {
  return `fc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function hhmm(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 写文件结果里的【占用提醒】文本 */
export function formatClaimWarning(hits: ClaimHit[], blocked = false): string {
  const lines = hits.map((h) => {
    const who = h.kind === 'implicit' ? `${h.agentName} 刚改过（写文件自动登记，` : `${h.agentName} 登记（`
    const task = h.task ? `${h.task}，` : ''
    return `${h.path} 已被 ${who}${task}${hhmm(h.since)} 起，到 ${hhmm(h.expiresAt)}）`
  })
  const tail = blocked ? '这次没有写入；等对方释放，或先在群里跟对方商量。' : '这次写入照常完成；要接着改请先在群里跟对方说一声。'
  return `【占用提醒】${lines.join('；')}，${tail}`
}

export class FileClaimStore {
  mode: ClaimMode
  private readonly store: JsonStore<ClaimFile>
  private readonly root: string
  private readonly machine: boolean
  private readonly ci: boolean
  private readonly now: () => number
  /** 给占用人推通知的去重：writer|owner|path → 上次推送时间（只在内存） */
  private readonly notified = new Map<string, number>()

  constructor(file: string, opts: FileClaimOptions) {
    this.root = path.resolve(opts.root)
    this.machine = !!opts.machine
    this.ci = opts.caseInsensitive ?? process.platform === 'win32'
    this.mode = opts.mode ?? 'warn'
    this.now = opts.now ?? Date.now
    this.store = new JsonStore<ClaimFile>(file, () => ({ version: 1, claims: [] }))
    this.prune() // 重启后过期的直接清掉
  }

  private key(p: string): string {
    return this.ci ? p.toLowerCase() : p
  }

  /** 统一成登记用的形式；越出工作区、一次占整个工作区的直接拒绝 */
  normalize(input: string): string {
    const raw = toSlash(String(input ?? '').trim())
    if (!raw) throw new ToolError('INVALID_ARGS', '路径不能为空')
    let out: string
    if (this.machine) {
      if (!isAbsoluteAny(raw)) throw new ToolError('INVALID_ARGS', `整台电脑工作区要写绝对路径：${input}`)
      out = toSlash(path.resolve(raw))
    } else {
      const abs = path.resolve(this.root, raw)
      const rel = toSlash(path.relative(this.root, abs))
      if (rel === '..' || rel.startsWith('../') || isAbsoluteAny(rel)) throw new ToolError('OUTSIDE_WORKSPACE', `路径越出了工作区：${input}`)
      out = rel === '' ? '**' : rel
    }
    out = out.replace(/\/+$/, '') || out
    if (this.tooBroad(out)) throw new ToolError('CLAIM_TOO_BROAD', `不能一次登记整个工作区（${input}），请写具体的目录或文件`)
    return out
  }

  /** 去掉开头不带 glob 的部分后只剩 ** 或 **\/*，且开头是空 / 盘符根 → 整个工作区（或整个盘） */
  private tooBroad(p: string): boolean {
    const segs = p.split('/')
    const firstGlob = segs.findIndex(hasGlob)
    if (firstGlob < 0) return this.machine && (segs.length <= 1 || (segs.length === 2 && segs[1] === ''))
    const prefix = segs.slice(0, firstGlob)
    const rest = segs.slice(firstGlob)
    const restAll = rest.every((s) => s === '**') || (rest.length >= 2 && rest.slice(0, -1).every((s) => s === '**') && rest[rest.length - 1] === '*')
    if (!restAll) return false
    if (!this.machine) return prefix.length === 0
    return prefix.length === 0 || (prefix.length === 1 && (prefix[0] === '' || /^[a-zA-Z]:$/.test(prefix[0])))
  }

  private matches(pattern: string, p: string): boolean {
    return globToRegExp(pattern, this.ci).test(p)
  }

  private overlaps(a: string, b: string): boolean {
    return this.key(a) === this.key(b) || this.matches(a, b) || this.matches(b, a)
  }

  /** 清掉过期的登记并写盘，返回清掉几条 */
  prune(): number {
    const t = this.now()
    const all = this.store.get().claims
    const live = all.filter((c) => c.expiresAt > t)
    if (live.length !== all.length) this.store.set({ version: 1, claims: live })
    return all.length - live.length
  }

  private live(): FileClaim[] {
    this.prune()
    return this.store.get().claims
  }

  /** 主动登记；同一 AI 同一任务的主动登记合并并续约。返回登记和与别人登记重叠的项（只提示，不拦） */
  claim(holder: ClaimHolder, paths: string[], opts: { task?: string | null; ttlMinutes?: number; note?: string } = {}): { claim: FileClaim; overlaps: ClaimHit[] } {
    if (!Array.isArray(paths) || paths.length === 0) throw new ToolError('INVALID_ARGS', 'paths 至少写一个路径')
    const ttl = opts.ttlMinutes ?? EXPLICIT_TTL_MIN
    if (!Number.isFinite(ttl) || ttl < MIN_TTL_MIN || ttl > MAX_TTL_MIN) throw new ToolError('INVALID_ARGS', `ttl_minutes 要在 ${MIN_TTL_MIN} 到 ${MAX_TTL_MIN} 之间`)
    const norm = this.dedupe(paths.map((p) => this.normalize(p)))
    const task = opts.task ?? null
    const t = this.now()
    const live = this.live()
    const overlaps: ClaimHit[] = []
    for (const c of live) {
      if (c.agentId === holder.agentId) continue
      for (const pat of c.paths) {
        const hit = norm.find((n) => this.overlaps(n, pat))
        if (hit) overlaps.push(this.hit(c, pat, hit))
      }
    }
    let result!: FileClaim
    this.store.mutate((d) => {
      const mine = d.claims.find((c) => c.expiresAt > t && c.agentId === holder.agentId && c.kind === 'explicit' && c.task === task)
      if (mine) {
        mine.paths = this.dedupe([...mine.paths, ...norm])
        mine.expiresAt = Math.max(mine.expiresAt, t + ttl * MINUTE)
        mine.session = holder.session ?? mine.session
        if (opts.note !== undefined) mine.note = opts.note
        result = mine
      } else {
        result = {
          id: newId(),
          agentId: holder.agentId,
          agentName: holder.agentName,
          session: holder.session ?? null,
          paths: norm,
          task,
          ...(opts.note ? { note: opts.note } : {}),
          kind: 'explicit',
          createdAt: t,
          expiresAt: t + ttl * MINUTE
        }
        d.claims.push(result)
      }
    })
    return { claim: structuredClone(result), overlaps }
  }

  /** 写文件成功后调用：这些文件各自自动登记 10 分钟（每个路径一条），并给本人覆盖到它们的主动登记续约 */
  touch(holder: ClaimHolder, paths: string[], task: string | null = null): void {
    const norm: string[] = []
    for (const p of paths) {
      try {
        norm.push(this.normalize(p))
      } catch {
        // 越出工作区之类的路径不登记，写文件工具自己会报
      }
    }
    if (!norm.length) return
    const t = this.now()
    this.live()
    this.store.mutate((d) => {
      for (const c of d.claims) {
        if (c.agentId !== holder.agentId || c.kind !== 'explicit') continue
        if (norm.some((n) => c.paths.some((pat) => this.matches(pat, n)))) {
          const ttl = Math.max(c.expiresAt - c.createdAt, EXPLICIT_TTL_MIN * MINUTE)
          c.expiresAt = Math.max(c.expiresAt, t + Math.min(ttl, MAX_TTL_MIN * MINUTE))
        }
      }
      // 自动登记每个路径一条、各自过期：只续这次写到的文件，早先碰过的不跟着续期
      const session = holder.session ?? null
      for (const n of this.dedupe(norm)) {
        const k = this.key(n)
        const imp = d.claims.find((c) => c.agentId === holder.agentId && c.kind === 'implicit' && c.session === session && this.key(c.paths[0]) === k)
        if (imp) {
          imp.task = task ?? imp.task
          imp.expiresAt = t + IMPLICIT_TTL_MIN * MINUTE
        } else {
          d.claims.push({ id: newId(), agentId: holder.agentId, agentName: holder.agentName, session, paths: [n], task, kind: 'implicit', createdAt: t, expiresAt: t + IMPLICIT_TTL_MIN * MINUTE })
        }
      }
    })
  }

  /** 本人释放：ids 或 paths 二选一；都不给 = 释放自己全部登记。返回释放了几条路径 */
  release(agentId: string, opts: { ids?: string[]; paths?: string[] } = {}): number {
    const live = this.live()
    if (opts.ids?.length) {
      const others = live.filter((c) => opts.ids!.includes(c.id) && c.agentId !== agentId)
      if (others.length) throw new ToolError('NOT_OWNER', `只能释放自己的登记：${others.map((c) => `${c.id}（${c.agentName}）`).join('、')}`)
    }
    const keys = opts.paths?.length ? new Set(opts.paths.map((p) => this.key(this.normalize(p)))) : null
    let removed = 0
    this.store.mutate((d) => {
      d.claims = d.claims.filter((c) => {
        if (c.agentId !== agentId) return true
        if (opts.ids?.length) {
          if (!opts.ids.includes(c.id)) return true
          removed += c.paths.length
          return false
        }
        if (keys) {
          const before = c.paths.length
          c.paths = c.paths.filter((p) => !keys.has(this.key(p)))
          removed += before - c.paths.length
          return c.paths.length > 0
        }
        removed += c.paths.length
        return false
      })
    })
    return removed
  }

  /** 会话断开：这个会话的登记全部释放 */
  releaseSession(session: string): number {
    return this.removeWhere((c) => c.session === session)
  }

  /** 任务结束（done 或删除）：关联这个任务的登记全部释放 */
  releaseTask(task: string): number {
    return this.removeWhere((c) => c.task === task)
  }

  private removeWhere(fn: (c: FileClaim) => boolean): number {
    const all = this.store.get().claims
    const keep = all.filter((c) => !fn(c))
    if (keep.length !== all.length) this.store.set({ version: 1, claims: keep })
    this.prune()
    return all.length - keep.length
  }

  /** 别人的有效登记里，命中这些路径的项（自己的不算） */
  check(agentId: string, paths: string[]): ClaimHit[] {
    const hits: ClaimHit[] = []
    const live = this.live()
    for (const raw of paths) {
      let p: string
      try {
        p = this.normalize(raw)
      } catch {
        continue
      }
      for (const c of live) {
        if (c.agentId === agentId) continue
        const pat = c.paths.find((x) => this.matches(x, p))
        if (pat) hits.push(this.hit(c, pat, p))
      }
    }
    return hits
  }

  /** 写文件前调用：按模式决定提醒还是拦。block 模式也只拦主动登记，自动登记永远只提醒 */
  gate(agentId: string, paths: string[]): ClaimGate {
    if (this.mode === 'off') return { blocked: false, hits: [], text: null }
    const hits = this.check(agentId, paths)
    if (!hits.length) return { blocked: false, hits, text: null }
    const blocked = this.mode === 'block' && hits.some((h) => h.kind === 'explicit')
    return { blocked, hits, text: formatClaimWarning(blocked ? hits.filter((h) => h.kind === 'explicit') : hits, blocked) }
  }

  /** 写入后给占用人的【通知】：同一写入人、同一占用人、同一文件 10 分钟内只推一次 */
  ownerNotices(writer: ClaimHolder, hits: ClaimHit[], task: string | null = null): { agentId: string; text: string }[] {
    const t = this.now()
    const byOwner = new Map<string, string[]>()
    for (const h of hits) {
      const k = `${writer.agentId}|${h.agentId}|${this.key(h.path)}`
      const last = this.notified.get(k)
      if (last !== undefined && t - last < NOTIFY_DEDUPE_MS) continue
      this.notified.set(k, t)
      const list = byOwner.get(h.agentId) ?? []
      if (!list.includes(h.path)) list.push(h.path)
      byOwner.set(h.agentId, list)
    }
    return [...byOwner].map(([agentId, ps]) => ({ agentId, text: `${writer.agentName} 写了你登记的 ${ps.join('、')}${task ? `（${task}）` : ''}` }))
  }

  /** 给第 10 条：这个工作区现在谁占着哪些文件 */
  summary(): ClaimSummary {
    const claims = this.live().map((c) => ({ id: c.id, agentId: c.agentId, agentName: c.agentName, task: c.task, paths: [...c.paths], kind: c.kind, since: c.createdAt, expiresAt: c.expiresAt }))
    const byAgent: Record<string, string[]> = {}
    for (const c of claims) byAgent[c.agentName] = this.dedupe([...(byAgent[c.agentName] ?? []), ...c.paths])
    return { claims, byAgent }
  }

  /** 单个文件现在被谁占着（含所有人） */
  ownerOf(p: string): ClaimHit[] {
    return this.check('\u0000', [p])
  }

  /** 传入 git status 列出的路径，返回谁也没登记的那部分（原样返回调用方给的写法） */
  unclaimed(dirtyPaths: string[]): string[] {
    const live = this.live()
    return dirtyPaths.filter((raw) => {
      let p: string
      try {
        p = this.normalize(raw)
      } catch {
        return false
      }
      return !live.some((c) => c.paths.some((pat) => this.matches(pat, p)))
    })
  }

  private hit(c: FileClaim, pattern: string, p: string): ClaimHit {
    return { path: p, pattern, claimId: c.id, agentId: c.agentId, agentName: c.agentName, task: c.task, kind: c.kind, since: c.createdAt, expiresAt: c.expiresAt }
  }

  private dedupe(list: string[]): string[] {
    const seen = new Set<string>()
    return list.filter((p) => {
      const k = this.key(p)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }
}
