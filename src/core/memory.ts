import crypto from 'node:crypto'
import { JsonStore } from './jsonStore'
import { ToolError } from './fileTools'
import type { MemoryItem, MemoryRevision } from './types'

export const MAX_MEMORY_CHARS = 8000
export const MAX_MEMORIES = 2000
/** 每条记忆最多留几个旧版本 */
export const MEMORY_HISTORY_MAX = 10
/** 这么多天没人用也没人改，自动归档 */
export const MEMORY_ARCHIVE_DAYS = 60
/** 同一条记忆在这段时间里被用到多次只算一次（也免得每次搜索都写盘） */
const TOUCH_GAP_MS = 10 * 60_000
/** 自动归档最多多久查一次 */
const SWEEP_GAP_MS = 60 * 60_000
const DAY_MS = 24 * 3600_000

/** 操作者：AI（agent）或工作台里的用户（user） */
export interface Actor {
  id: string
  name: string
  kind: 'agent' | 'user'
}

export interface MemoryInput {
  id?: string
  scope?: 'shared' | 'private'
  title: string
  content: string
  tags?: string[]
  pinned?: boolean
  /**
   * 更新时可选：你读到的那一版的 version。和现在的对不上（别人先改过）就报 CONFLICT，什么都不写，
   * data.current 带回最新内容。不传照旧直接覆盖（老调用方式不变）。新建时不能传
   */
  expectedVersion?: number
  /** 挂在哪条任务上（任务编号）；更新时不传就不动，传空串是摘掉 */
  taskRef?: string
  /** 从哪来的，一句话（最多 200 字）；更新时不传就不动 */
  source?: string
}

/**
 * 搜索词切成一小段一小段：按空格分开的每个词算一段；连着写的中文没有空格，再按两个字一段切（「部署约定」→ 部署、署约、约定），
 * 这样换个说法、多写少写几个字也能对上一部分。返回 { words: 用户写的词, grams: 切出来的小段（不含 words 里已有的） }
 */
const STOP_CHARS = /[的了和是在把要与及或也就都而被对从到给让]/

export function searchTokens(query: string): { words: string[]; grams: string[] } {
  const words = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))]
  const grams = new Set<string>()
  for (const w of words) {
    for (const run of w.match(/[\u3400-\u9fff]+/g) ?? []) {
      if (run.length <= 2) continue
      for (let i = 0; i < run.length - 1; i++) {
        const g = run.slice(i, i + 2)
        // 带「的、了、和」这类字的小段到处都是，对上了也说明不了什么
        if (!STOP_CHARS.test(g)) grams.add(g)
      }
    }
  }
  for (const w of words) grams.delete(w)
  return { words, grams: [...grams] }
}

export interface MemoryHit {
  m: MemoryItem
  /** 用户写的词里对上了几个（全对上的排最前，和以前「每个词都要有」的结果一样） */
  words: number
  /** 细分：标题里对上比正文里对上分高，标签居中；切出来的小段分低一些 */
  score: number
}

/** 一段话切成两个字一段的小段（去掉空白和标点），比较两段话像不像用 */
function bigrams(text: string): Set<string> {
  const s = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  const out = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

function overlap(a: Set<string>, b: Set<string>): { jaccard: number; contain: number } {
  if (!a.size || !b.size) return { jaccard: 0, contain: 0 }
  let both = 0
  for (const g of a) if (b.has(g)) both++
  return { jaccard: both / (a.size + b.size - both), contain: both / Math.min(a.size, b.size) }
}

/**
 * 两条记忆有多像，0～1。标题一样算 1；否则看标题和正文各自重合多少：
 * 标题大半重合、或者正文大半重合（短的那条的内容基本都在长的那条里）就算像
 */
export function memorySimilarity(a: { title: string; content: string }, b: { title: string; content: string }): number {
  const ta = a.title.trim().toLowerCase()
  const tb = b.title.trim().toLowerCase()
  if (ta && ta === tb) return 1
  const t = overlap(bigrams(ta), bigrams(tb))
  const ca = bigrams(a.content.slice(0, 1200))
  const cb = bigrams(b.content.slice(0, 1200))
  // 正文太短（不到 8 段）重合多少都说明不了什么
  const c = Math.min(ca.size, cb.size) >= 8 ? overlap(ca, cb) : { jaccard: 0, contain: 0 }
  // 标题：一条的字基本都在另一条里（「提交信息写法」和「提交信息的写法」）也算像，标题太短的不算
  return Math.max(t.jaccard, c.jaccard, c.contain * 0.9, t.contain >= 0.8 && Math.min(ta.length, tb.length) >= 4 ? 0.7 : 0)
}

/** 多像才提示（memorySimilarity 的结果） */
export const SIMILAR_THRESHOLD = 0.6

/**
 * 开场说明里先放哪条：这条记忆有多「热」。用得多、最近还在用的分高；从没被用到过的是 0。
 * 每 30 天不用，分数减半
 */
export function memoryHeat(m: Pick<MemoryItem, 'lastUsedAt' | 'useCount'>, now = Date.now()): number {
  if (!m.lastUsedAt || !m.useCount) return 0
  const days = Math.max(0, now - m.lastUsedAt) / DAY_MS
  return Math.log2(1 + m.useCount) * Math.pow(0.5, days / 30)
}

/** 开场说明里的先后：置顶的在前，然后按热度，再按更新时间（新的在前） */
export function byPriority(now = Date.now()): (a: MemoryItem, b: MemoryItem) => number {
  return (a, b) => Number(b.pinned) - Number(a.pinned) || memoryHeat(b, now) - memoryHeat(a, now) || b.updatedAt - a.updatedAt
}

/** 记忆现在的版本号。老数据没有 version 字段，算第 1 版 */
export function memoryVersion(m: Pick<MemoryItem, 'version'>): number {
  return typeof m.version === 'number' && Number.isInteger(m.version) && m.version > 0 ? m.version : 1
}

/** 检查 expectedVersion：传了且对不上就抛 CONFLICT，带回最新内容让调用方合并 */
function checkVersion(m: MemoryItem, expected: number | undefined, what: '修改' | '删除'): void {
  if (expected === undefined || expected === null) return
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 1) {
    throw new ToolError('INVALID_ARGS', 'expected_version 要是正整数（读记忆时返回的 version）')
  }
  const now = memoryVersion(m)
  if (expected === now) return
  const when = new Date(m.updatedAt).toISOString()
  throw new ToolError(
    'CONFLICT',
    `记忆 ${m.id} 已经是第 ${now} 版（你读到的是第 ${expected} 版），${m.updatedByName} 在 ${when} 改过。这次${what}没有生效；先看 data.current 里的最新内容，合并后带 expected_version=${now} 再${what}`,
    {
      current: {
        id: m.id,
        version: now,
        title: m.title,
        content: m.content,
        tags: m.tags,
        pinned: m.pinned,
        updatedBy: m.updatedBy,
        updatedByName: m.updatedByName,
        updatedAt: m.updatedAt
      }
    }
  )
}

/** 搜索结果的先后：没归档的在前，然后对上的词多的、分高的、置顶的、新的 */
export function compareHits(a: MemoryHit, b: MemoryHit): number {
  return (
    Number(Boolean(a.m.archivedAt)) - Number(Boolean(b.m.archivedAt)) ||
    b.words - a.words ||
    b.score - a.score ||
    Number(b.m.pinned) - Number(a.m.pinned) ||
    b.m.updatedAt - a.m.updatedAt
  )
}

/** 把现在这一版记进历史（改之前调用），只留最近 MEMORY_HISTORY_MAX 版 */
function pushRevision(m: MemoryItem): void {
  const rev: MemoryRevision = {
    version: memoryVersion(m),
    title: m.title,
    content: m.content,
    tags: [...m.tags],
    updatedBy: m.updatedBy,
    updatedByName: m.updatedByName,
    updatedAt: m.updatedAt
  }
  m.history = [...(m.history ?? []), rev].slice(-MEMORY_HISTORY_MAX)
}

function normTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 10)
}

/**
 * 工作区记忆。shared 所有 AI 可读写；private 只有所属 AI 可见。用户在工作台能看和改全部。
 * AI 不能置顶共享记忆：置顶内容会进每个 AI 的连接说明，只让用户决定，防止一个 AI 往所有 AI 的提示里塞指令。
 */
export class MemoryStore {
  /** trackedSince：这个库从什么时候开始记「用没用到」。在那之前的记忆没有 lastUsedAt，不能因此当成「一直没人用」 */
  private store: JsonStore<{ items: MemoryItem[]; trackedSince?: number }>

  /** 这次打开库的时间：库里还没有 trackedSince 时用它起算 */
  private openedAt = Date.now()

  private idPrefix: string

  /** idPrefix：记忆 id 的开头。全局记忆库用 'mg_'，和各项目的 'm_' 分开，拿到 id 就知道去哪个库找 */
  constructor(file: string, onChange?: () => void, opts: { idPrefix?: string } = {}) {
    this.store = new JsonStore(file, () => ({ items: [] }), onChange)
    this.idPrefix = opts.idPrefix ?? 'm_'
  }

  /** AI 能看到的：全部共享 + 自己的私有 */
  private visible(actor: Actor): MemoryItem[] {
    const items = this.store.get().items
    if (actor.kind === 'user') return items
    return items.filter((m) => m.scope === 'shared' || m.ownerId === actor.id)
  }

  all(): MemoryItem[] {
    return this.store.get().items
  }

  get(actor: Actor, id: string): MemoryItem {
    const m = this.visible(actor).find((x) => x.id === id)
    if (!m) throw new ToolError('NOT_FOUND', `记忆 ${id} 不存在或你无权查看`)
    return m
  }

  /**
   * 搜索并打分。不再要求每个词都出现：对上得越多排得越前，一个都没对上的不要。
   * 不给 query 时返回全部（按置顶、更新时间排）。task：只要挂在这条任务上的
   */
  rank(actor: Actor, opts: { query?: string; scope?: 'shared' | 'private'; tag?: string; task?: string; limit?: number; archived?: boolean } = {}): MemoryHit[] {
    const q = opts.query?.trim()
    // 归档的：带了搜索词或者指定了任务才出现（排在没归档的后面）；只是列全部时不出。archived 明说了就照它
    const withArchived = opts.archived ?? Boolean(q || opts.task?.trim())
    const { words, grams } = q ? searchTokens(q) : { words: [], grams: [] }
    const tag = opts.tag?.trim().toLowerCase()
    const task = opts.task?.trim().toLowerCase()
    return this.visible(actor)
      .filter((m) => withArchived || !m.archivedAt)
      .filter((m) => !opts.scope || m.scope === opts.scope)
      .filter((m) => !tag || m.tags.includes(tag))
      .filter((m) => !task || m.taskRef?.toLowerCase() === task)
      .map((m): MemoryHit | null => {
        if (!words.length) return { m, words: 0, score: 0 }
        const title = m.title.toLowerCase()
        const body = `${m.content}\n${m.tags.join(' ')}`.toLowerCase()
        const one = (w: string, weight: number): number => (title.includes(w) ? 3 : m.tags.includes(w) ? 2 : body.includes(w) ? 1 : 0) * weight
        let hit = 0
        let score = 0
        for (const w of words) {
          const s = one(w, 2)
          if (s) hit++
          score += s
        }
        for (const g of grams) score += one(g, 1)
        return score > 0 ? { m, words: hit, score } : null
      })
      .filter((x): x is MemoryHit => x !== null)
      .sort(compareHits)
      .slice(0, opts.limit ?? 50)
  }

  search(actor: Actor, opts: { query?: string; scope?: 'shared' | 'private'; tag?: string; task?: string; limit?: number; archived?: boolean } = {}): MemoryItem[] {
    return this.rank(actor, opts).map((x) => x.m)
  }

  /** 新建（不带 id）或更新（带 id）。每次更新版本号加 1；带 expectedVersion 时先核对版本 */
  save(actor: Actor, input: MemoryInput): MemoryItem {
    const title = input.title?.trim()
    if (!title) throw new ToolError('INVALID_ARGS', 'title 不能为空')
    if (title.length > 200) throw new ToolError('INVALID_ARGS', 'title 不能超过 200 字')
    if ((input.content ?? '').length > MAX_MEMORY_CHARS) throw new ToolError('TOO_LARGE', `单条记忆不能超过 ${MAX_MEMORY_CHARS} 字，请拆分或精简`)
    const now = Date.now()
    let saved!: MemoryItem

    this.store.mutate((d) => {
      if (input.id) {
        const m = d.items.find((x) => x.id === input.id)
        if (!m || (actor.kind === 'agent' && m.scope === 'private' && m.ownerId !== actor.id)) {
          throw new ToolError('NOT_FOUND', `记忆 ${input.id} 不存在或你无权修改`)
        }
        if (input.scope && input.scope !== m.scope && actor.kind === 'agent') {
          throw new ToolError('INVALID_ARGS', '不能修改已有记忆的范围，请新建一条')
        }
        if (input.pinned !== undefined && input.pinned !== m.pinned && actor.kind === 'agent' && m.scope === 'shared') {
          throw new ToolError('FORBIDDEN', '共享记忆的置顶只能由用户在工作台设置')
        }
        checkVersion(m, input.expectedVersion, '修改')
        // 标题、正文、标签变了：把改之前的样子记成一版，以后能看、能恢复
        const nextContent = input.content ?? m.content
        const nextTags = input.tags ? normTags(input.tags) : m.tags
        if (title !== m.title || nextContent !== m.content || nextTags.join('\n') !== m.tags.join('\n')) pushRevision(m)
        // 有人改它，说明还有用：从归档里回来
        if (m.archivedBy !== 'user') delete m.archivedAt
        if (input.taskRef !== undefined) {
          if (input.taskRef.trim()) m.taskRef = input.taskRef.trim()
          else delete m.taskRef
        }
        if (input.source?.trim()) m.source = input.source.trim().slice(0, 200)
        Object.assign(m, {
          title,
          content: input.content ?? m.content,
          tags: input.tags ? normTags(input.tags) : m.tags,
          pinned: input.pinned ?? m.pinned,
          updatedBy: actor.id,
          updatedByName: actor.name,
          updatedAt: now,
          version: memoryVersion(m) + 1
        })
        saved = m
        return
      }
      if (input.expectedVersion !== undefined && input.expectedVersion !== null) {
        throw new ToolError('INVALID_ARGS', 'expected_version 只在更新时用（要同时传 id）；新建不用传')
      }
      const scope = input.scope ?? 'shared'
      if (scope === 'private' && actor.kind === 'user') throw new ToolError('INVALID_ARGS', '私有记忆属于某个 AI，用户请新建共享记忆')
      if (input.pinned && scope === 'shared' && actor.kind === 'agent') throw new ToolError('FORBIDDEN', '共享记忆的置顶只能由用户在工作台设置')
      if (d.items.length >= MAX_MEMORIES) throw new ToolError('LIMIT', `记忆已达 ${MAX_MEMORIES} 条上限，请先清理`)
      saved = {
        id: this.idPrefix + crypto.randomBytes(5).toString('hex'),
        scope,
        ownerId: scope === 'private' ? actor.id : undefined,
        title,
        content: input.content ?? '',
        tags: normTags(input.tags),
        pinned: Boolean(input.pinned),
        createdBy: actor.id,
        createdByName: actor.name,
        updatedBy: actor.id,
        updatedByName: actor.name,
        createdAt: now,
        updatedAt: now,
        version: 1,
        ...(input.taskRef?.trim() ? { taskRef: input.taskRef.trim() } : {}),
        ...(input.source?.trim() ? { source: input.source.trim().slice(0, 200) } : {})
      }
      d.items.push(saved)
    })
    return saved
  }

  /**
   * 恢复到以前的某一版：标题、正文、标签换回那一版的，算一次新的修改（版本号接着加，现在这版也进历史）。
   * 谁能恢复和谁能改一样
   */
  restore(actor: Actor, id: string, version: number): MemoryItem {
    const cur = this.store.get().items.find((x) => x.id === id)
    if (!cur || (actor.kind === 'agent' && cur.scope === 'private' && cur.ownerId !== actor.id)) throw new ToolError('NOT_FOUND', `记忆 ${id} 不存在或你无权修改`)
    const rev = cur.history?.find((r) => r.version === version)
    if (!rev) throw new ToolError('NOT_FOUND', `记忆 ${id} 没有第 ${version} 版的记录（留着的有：${cur.history?.map((r) => r.version).join('、') || '无'}）`)
    return this.save(actor, { id, title: rev.title, content: rev.content, tags: rev.tags })
  }

  /** 以前的版本，新的在前。看得到这条记忆的人都能看 */
  history(actor: Actor, id: string): MemoryRevision[] {
    return [...(this.get(actor, id).history ?? [])].reverse()
  }

  /**
   * 新建之前看看有没有很像的（actor 看得到的里面找，归档的也算），最多 limit 条，最像的在前。
   * 只是提示，不拦着保存
   */
  similar(actor: Actor, input: { title: string; content: string; scope?: 'shared' | 'private' }, opts: { limit?: number; exceptId?: string } = {}): { m: MemoryItem; score: number }[] {
    return this.visible(actor)
      .filter((m) => m.id !== opts.exceptId && (!input.scope || m.scope === input.scope))
      .map((m) => ({ m, score: memorySimilarity(input, m) }))
      .filter((x) => x.score >= SIMILAR_THRESHOLD)
      .sort((a, b) => b.score - a.score || b.m.updatedAt - a.m.updatedAt)
      .slice(0, opts.limit ?? 3)
  }

  /**
   * 记一次「用到了」：AI 读了、搜到了、认领任务时带上了。更新最后使用时间和次数；自动归档的回来，用户手动归档的不回来。
   * revive=false（搜索时用）：归档的完全不算，免得随便一个沾边的词就把归档的带回来。
   * 不算修改（版本号、更新时间不动）。同一条 10 分钟内只记一次；一条都不用记就不写盘
   */
  touch(ids: readonly string[], now = Date.now(), opts: { revive?: boolean } = {}): number {
    const want = new Set(ids)
    if (!want.size) return 0
    const revive = opts.revive ?? true
    const gapOk = (m: MemoryItem): boolean => !m.lastUsedAt || now - m.lastUsedAt >= TOUCH_GAP_MS
    const due = this.store.get().items.filter((m) => {
      if (!want.has(m.id)) return false
      if (!m.archivedAt) return gapOk(m)
      // 归档的：revive=false（只是搜索时沾了边）完全不算；用户手动归档的照常记次数但不回来；自动归档的马上回来
      if (!revive) return false
      return m.archivedBy === 'user' ? gapOk(m) : true
    })
    if (!due.length) return 0
    const dueIds = new Set(due.map((m) => m.id))
    this.store.mutate((d) => {
      for (const m of d.items) {
        if (!dueIds.has(m.id)) continue
        m.lastUsedAt = now
        m.useCount = (m.useCount ?? 0) + 1
        if (m.archivedBy !== 'user') delete m.archivedAt
      }
    })
    return due.length
  }

  /** 用户在工作台手动归档 / 取消归档（AI 不能归档）。手动归档的记上 archivedBy，之后不会自己回来 */
  setArchived(actor: Actor, id: string, archived: boolean, now = Date.now()): MemoryItem {
    if (actor.kind !== 'user') throw new ToolError('FORBIDDEN', '归档只能由用户在工作台操作')
    let out!: MemoryItem
    this.store.mutate((d) => {
      const m = d.items.find((x) => x.id === id)
      if (!m) throw new ToolError('NOT_FOUND', `记忆 ${id} 不存在`)
      if (archived) {
        m.archivedAt = now
        m.archivedBy = 'user'
        m.pinned = false
      } else {
        delete m.archivedAt
        delete m.archivedBy
        // 手动拿回来的，从现在起重新算「多久没用」
        m.lastUsedAt = now
      }
      out = m
    })
    return out
  }

  /**
   * 自动归档：超过 days 天没人用、没人改的归档。置顶的不动（那是用户明说要一直带着的）；keep 返回 true 的也不动。
   * 最多一小时查一次（force 除外）。返回这次归档了几条
   */
  sweep(opts: { now?: number; days?: number; keep?: (m: MemoryItem) => boolean; force?: boolean } = {}): number {
    const now = opts.now ?? Date.now()
    if (!opts.force && now - this.lastSweep < SWEEP_GAP_MS) return 0
    this.lastSweep = now
    const limit = now - (opts.days ?? MEMORY_ARCHIVE_DAYS) * DAY_MS
    // 「多久没用」最早从这个库开始记使用情况那一刻算起：有这个功能之前写的记忆没有 lastUsedAt，
    // 不这样的话它们会在第一次整理时被一口气归档掉，哪怕一直有人在用
    let since = this.store.get().trackedSince
    if (since === undefined) {
      since = Math.min(this.openedAt, now)
      const first = since
      if (this.store.get().items.length) this.store.mutate((d) => void (d.trackedSince = first))
    }
    const from = since
    const stale = (m: MemoryItem): boolean => !m.archivedAt && !m.pinned && Math.max(m.lastUsedAt ?? 0, m.updatedAt, m.createdAt, from) < limit && !opts.keep?.(m)
    const ids = new Set(this.store.get().items.filter(stale).map((m) => m.id))
    if (!ids.size) return 0
    this.store.mutate((d) => {
      for (const m of d.items) if (ids.has(m.id)) m.archivedAt = now
    })
    return ids.size
  }

  private lastSweep = 0

  /** AI 只能删自己的私有记忆和自己创建的共享记忆；用户都能删。带 expectedVersion 时版本对不上报 CONFLICT */
  delete(actor: Actor, id: string, opts: { expectedVersion?: number } = {}): MemoryItem {
    let removed!: MemoryItem
    this.store.mutate((d) => {
      const i = d.items.findIndex((x) => x.id === id)
      const m = d.items[i]
      if (!m || (actor.kind === 'agent' && m.scope === 'private' && m.ownerId !== actor.id)) {
        throw new ToolError('NOT_FOUND', `记忆 ${id} 不存在或你无权删除`)
      }
      if (actor.kind === 'agent' && m.scope === 'shared' && m.createdBy !== actor.id) {
        throw new ToolError('FORBIDDEN', '只能删除自己创建的共享记忆；内容过时请用 memory_save 更新，或请用户删除')
      }
      checkVersion(m, opts.expectedVersion, '删除')
      removed = m
      d.items.splice(i, 1)
    })
    return removed
  }

  /** 连接时下发：所有置顶共享 + 这个 AI 自己置顶的私有（归档的不发），用得多、最近还在用的在前 */
  pinnedFor(agentId: string, now = Date.now()): MemoryItem[] {
    return this.store
      .get()
      .items.filter((m) => m.pinned && !m.archivedAt && (m.scope === 'shared' || m.ownerId === agentId))
      .sort(byPriority(now))
  }

  /**
   * 和一段话（任务的标题、说明）相关的记忆，最多 limit 条：挂在这条任务上的排最前，其余按对上了多少排。
   * actor 看不到的不会出现
   */
  related(actor: Actor, text: string, opts: { taskRef?: string; limit?: number } = {}): { m: MemoryItem; why: 'task' | 'match' }[] {
    const limit = opts.limit ?? 5
    const out: { m: MemoryItem; why: 'task' | 'match' }[] = []
    const seen = new Set<string>()
    if (opts.taskRef) {
      for (const h of this.rank(actor, { task: opts.taskRef, limit })) {
        out.push({ m: h.m, why: 'task' })
        seen.add(h.m.id)
      }
    }
    // 说明可能很长：只拿开头一段去对，够判断相关不相关了
    const query = text.replace(/\s+/g, ' ').trim().slice(0, 240)
    if (query) {
      // 归档的不主动带（挂在这条任务上的例外，上面已经带了）
      for (const h of this.rank(actor, { query, limit: limit * 3, archived: false })) {
        if (out.length >= limit) break
        if (seen.has(h.m.id)) continue
        // 只在正文里对上一个零碎的小段不算相关；标题里对上一段、或者正文里对上两段才算
        if (h.words === 0 && h.score < 2) continue
        out.push({ m: h.m, why: 'match' })
        seen.add(h.m.id)
      }
    }
    return out.slice(0, limit)
  }

  /** 吊销 AI 时清掉它的私有记忆（共享记忆保留） */
  removeOwner(agentId: string): number {
    const before = this.store.get().items.length
    const after = this.store.get().items.filter((m) => !(m.scope === 'private' && m.ownerId === agentId))
    if (after.length !== before) this.store.set({ items: after })
    return before - after.length
  }
}
