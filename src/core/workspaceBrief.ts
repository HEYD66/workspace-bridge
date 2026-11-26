// 优化第 10 条：开工简报。一次拿回置顶规范、自己的任务、没结的任务、最近消息、文件占用、谁也没登记的改动和记忆索引。
// 纯函数：数据都由调用方传进来，这里只排序、截断、排版。每一节有条数和字数上限，整份有总字数上限，
// 超出时写明省略了多少、用什么工具看全部。同时返回 JSON 和纯文本，两边列出的条目一致。
import type { GroupMessage, MemoryItem, TaskItem, TaskStatus } from './types'
import type { ClaimSummary } from './fileClaims'
import { ToolError } from './fileTools'

export const BRIEF_SECTIONS = ['rules', 'my_tasks', 'open_tasks', 'messages', 'claims', 'unclaimed', 'memories'] as const
export type BriefSection = (typeof BRIEF_SECTIONS)[number]

export interface SectionLimit {
  /** 最多列几条 */
  maxItems: number
  /** 这一节（含标题和省略说明）最多几个字 */
  maxChars: number
  /** 单条最多几个字，超出的部分用 … 截掉 */
  itemChars: number
}

export const DEFAULT_LIMITS: Readonly<Record<BriefSection, SectionLimit>> = {
  rules: { maxItems: 10, maxChars: 3000, itemChars: 3000 },
  my_tasks: { maxItems: 10, maxChars: 1500, itemChars: 220 },
  open_tasks: { maxItems: 30, maxChars: 1200, itemChars: 120 },
  messages: { maxItems: 15, maxChars: 1500, itemChars: 200 },
  claims: { maxItems: 30, maxChars: 800, itemChars: 200 },
  unclaimed: { maxItems: 30, maxChars: 600, itemChars: 160 },
  memories: { maxItems: 50, maxChars: 1000, itemChars: 100 }
}

export const DEFAULT_MAX_CHARS = 8000
export const MIN_MAX_CHARS = 1000
export const MAX_MAX_CHARS = 30000
/** 给后面每一节至少留这么多字，够写标题和省略说明 */
const SECTION_RESERVE = 90

const SECTION_TITLES: Record<BriefSection, string> = {
  rules: '置顶规范',
  my_tasks: '我手上的任务和等我审的',
  open_tasks: '其他没结的任务',
  messages: '最近消息',
  claims: '文件占用',
  unclaimed: '谁也没登记的改动',
  memories: '记忆索引'
}

const STATUS_LABEL: Record<TaskStatus, string> = { todo: '待办', in_progress: '进行中', review: '待审', blocked: '卡住', done: '完成' }
const PRIORITY_RANK: Record<TaskItem['priority'], number> = { high: 0, normal: 1, low: 2 }

export interface BriefInput {
  /** 要简报的 AI */
  me: { id: string; name: string }
  workspace?: { id: string; name: string }
  /** 置顶记忆（MemoryStore.pinnedFor(me.id)），按传入顺序全文列出 */
  pinned?: MemoryItem[]
  /** 记忆列表（这个 AI 看得到的）；置顶的已在规范里列过，索引里不再重复 */
  memories?: MemoryItem[]
  /** 工作区全部任务；done 的会跳过 */
  tasks?: TaskItem[]
  /** agent id → 名字，用来显示负责人；没有就显示 id */
  names?: Record<string, string>
  /** 工作区频道最近的消息（顺序不限，这里按 seq 排）；回执类消息跳过 */
  messages?: GroupMessage[]
  /** 这个 AI 在该频道的未读数 */
  unread?: number
  /** 大厅里点名此成员的未读数。 */
  lobbyMentions?: number
  /** FileClaimStore.summary()；不传表示没有占用数据 */
  claims?: ClaimSummary
  /** FileClaimStore.unclaimed(git status 的路径)；不传表示没检查 */
  unclaimed?: string[]
  now?: number
}

export interface BriefOptions {
  /** 只要这几节（顺序始终按 BRIEF_SECTIONS）；不传 = 全部 */
  sections?: string[]
  /** 整份纯文本最多几个字，默认 8000，范围 1000–30000 */
  maxChars?: number
  /** 覆盖某一节的上限 */
  limits?: Partial<Record<BriefSection, Partial<SectionLimit>>>
}

export interface BriefSectionJson {
  title: string
  /** 符合条件的总条数 */
  total: number
  /** 列出了几条 */
  shown: number
  omitted: number
  /** 有省略时：用什么看全部 */
  more: string | null
  /** 这一节没有数据或没检查时的说明 */
  note?: string
  items: Record<string, unknown>[]
  /** 只有 messages 节有 */
  unread?: number
  lobby_mentions?: number
}

export interface BriefJson {
  workspace: { id: string; name: string } | null
  me: { id: string; name: string }
  generatedAt: number
  maxChars: number
  /** 纯文本的实际字数 */
  chars: number
  /** 有任何一节省略或截断过 */
  truncated: boolean
  sections: Partial<Record<BriefSection, BriefSectionJson>>
}

export interface WorkspaceBrief {
  json: BriefJson
  text: string
}

interface Entry {
  /** 不可截的开头（编号、名字等） */
  head: string
  /** 可以截的正文 */
  body?: string
  sep?: string
  data: Record<string, unknown>
  /** body 写进 data 的哪个字段 */
  bodyKey?: string
}

function clip(s: string, n: number): string {
  if (s.length <= n) return s
  if (n <= 1) return '…'
  return s.slice(0, n - 1) + '…'
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function hhmm(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function stamp(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hhmm(ts)}`
}

function render(e: Entry, maxLen: number): { line: string; data: Record<string, unknown> } {
  if (e.body === undefined || !e.bodyKey) return { line: clip(e.head, maxLen), data: e.data }
  const sep = e.body ? (e.sep ?? '') : ''
  const avail = maxLen - e.head.length - sep.length
  if (avail < 2) return { line: clip(e.head, maxLen), data: { ...e.data, [e.bodyKey]: '', truncated: e.body.length > 0 } }
  const body = clip(e.body, avail)
  return { line: e.head + sep + body, data: { ...e.data, [e.bodyKey]: body, ...(body !== e.body ? { truncated: true } : {}) } }
}

interface Fitted {
  text: string
  json: BriefSectionJson
  truncated: boolean
}

/** 把一节的条目塞进 cap 个字里。partial：放不下的第一条截短了放（规范全文用）；newestLast：优先保留末尾的条目（消息） */
function fit(
  key: BriefSection,
  heading: string,
  entries: Entry[],
  limit: SectionLimit,
  cap: number,
  more: string,
  opts: { partial?: boolean; newestLast?: boolean; note?: string; extra?: Partial<BriefSectionJson> } = {}
): Fitted {
  const title = SECTION_TITLES[key]
  const head = `## ${heading}`
  const base: BriefSectionJson = { title, total: entries.length, shown: 0, omitted: 0, more: null, items: [], ...opts.extra }
  if (!entries.length) {
    const note = opts.note ?? '无'
    return { text: `${head}\n（${note}）`, json: { ...base, note }, truncated: false }
  }
  const order = opts.newestLast ? [...entries].reverse() : entries
  const footer = (n: number) => `（${opts.newestLast ? '更早的' : '另有'} ${n} 条没列出；看全部：${more}）`
  const lines: string[] = []
  const items: Record<string, unknown>[] = []
  let used = head.length
  let clipped = false
  for (let i = 0; i < order.length; i++) {
    if (items.length >= limit.maxItems) break
    const left = order.length - i - 1
    const reserve = left > 0 ? footer(left).length + 1 : 0
    let r = render(order[i], limit.itemChars)
    if (used + 1 + r.line.length + reserve > cap) {
      const room = cap - used - 1 - footer(left + 1).length - 1
      if (opts.partial && room >= 60) {
        r = render(order[i], room)
        lines.push(r.line)
        items.push(r.data)
        clipped = true
      }
      break
    }
    if (r.data.truncated) clipped = true
    lines.push(r.line)
    items.push(r.data)
    used += 1 + r.line.length
  }
  if (opts.newestLast) {
    lines.reverse()
    items.reverse()
  }
  const omitted = entries.length - items.length
  if (omitted > 0) lines.push(footer(omitted))
  return {
    text: [head, ...lines].join('\n'),
    json: { ...base, shown: items.length, omitted, more: omitted > 0 ? more : null, items },
    truncated: omitted > 0 || clipped
  }
}

function nameOf(id: string | undefined, names: Record<string, string>): string {
  if (!id) return '没人领'
  if (id === 'user') return '用户'
  return names[id] ?? id
}

/** 审查人：派活的经理（managedBy），没有就是创建人 */
function reviewerOf(t: TaskItem): string {
  return t.managedBy ?? t.createdBy
}

const STATUS_RANK: Record<TaskStatus, number> = { in_progress: 0, review: 1, blocked: 2, todo: 3, done: 4 }

function byTaskOrder(a: TaskItem, b: TaskItem): number {
  return STATUS_RANK[a.status] - STATUS_RANK[b.status] || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.updatedAt - a.updatedAt
}

function taskTag(t: TaskItem): string {
  const p = t.priority === 'high' ? '·高' : t.priority === 'low' ? '·低' : ''
  return `[${STATUS_LABEL[t.status]}${p}]`
}

function resolveSections(raw: string[] | undefined): BriefSection[] {
  if (!raw || raw.length === 0) return [...BRIEF_SECTIONS]
  const bad = raw.filter((s) => !(BRIEF_SECTIONS as readonly string[]).includes(s))
  if (bad.length) throw new ToolError('INVALID_ARGS', `不认识的 sections：${bad.join('、')}；可选 ${BRIEF_SECTIONS.join('、')}`)
  return BRIEF_SECTIONS.filter((s) => raw.includes(s))
}

/** 生成开工简报 */
export function buildWorkspaceBrief(input: BriefInput, options: BriefOptions = {}): WorkspaceBrief {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  if (!Number.isInteger(maxChars) || maxChars < MIN_MAX_CHARS || maxChars > MAX_MAX_CHARS) {
    throw new ToolError('INVALID_ARGS', `max_chars 要在 ${MIN_MAX_CHARS} 到 ${MAX_MAX_CHARS} 之间`)
  }
  const sections = resolveSections(options.sections)
  const limitOf = (k: BriefSection): SectionLimit => ({ ...DEFAULT_LIMITS[k], ...options.limits?.[k] })
  const now = input.now ?? Date.now()
  // 只取 id 和名字：调用方传进来的可能是整个成员对象（带接入令牌），结果里绝不能带出去
  const me = { id: input.me.id, name: input.me.name }
  const names = input.names ?? {}

  const wsName = input.workspace?.name
  const title = `# 开工简报${wsName ? ` · ${wsName}` : ''}（${me.name}，${stamp(now)}）`
  const parts: string[] = [title]
  let used = title.length
  let truncated = false
  const json: BriefJson = { workspace: input.workspace ?? null, me, generatedAt: now, maxChars, chars: 0, truncated: false, sections: {} }

  const openTasks = (input.tasks ?? []).filter((t) => t.status !== 'done')
  const mine = openTasks.filter((t) => t.assigneeId === me.id).sort(byTaskOrder)
  const toReview = openTasks.filter((t) => t.status === 'review' && t.assigneeId !== me.id && reviewerOf(t) === me.id).sort(byTaskOrder)
  const mineIds = new Set([...mine, ...toReview].map((t) => t.id))
  const pinnedIds = new Set((input.pinned ?? []).map((m) => m.id))

  const build = (k: BriefSection, cap: number): Fitted => {
    const limit = limitOf(k)
    switch (k) {
      case 'rules': {
        const list = input.pinned ?? []
        const entries: Entry[] = list.map((m) => ({
          head: `### ${m.title} [${m.id}]`,
          sep: '\n',
          body: m.content.trim(),
          bodyKey: 'content',
          data: { id: m.id, title: m.title, scope: m.scope }
        }))
        return fit(k, `置顶规范（${list.length} 条）`, entries, limit, cap, 'memory_read 传记忆 id 看全文', { partial: true, note: '没有置顶的记忆' })
      }
      case 'my_tasks': {
        const entries: Entry[] = [
          ...mine.map((t) => ({
            head: `- ${t.ref} ${taskTag(t)} ${t.title}`,
            sep: ' — ',
            body: oneLine(t.description),
            bodyKey: 'description',
            data: { ref: t.ref, id: t.id, title: t.title, status: t.status, priority: t.priority, role: 'assignee', reviewer: nameOf(reviewerOf(t), names) }
          })),
          ...toReview.map((t) => ({
            head: `- 待我审 ${t.ref} ${taskTag(t)} ${t.title}（执行：${nameOf(t.assigneeId, names)}）`,
            sep: ' — ',
            body: oneLine(t.result ?? ''),
            bodyKey: 'result',
            data: { ref: t.ref, id: t.id, title: t.title, status: t.status, priority: t.priority, role: 'reviewer', assignee: nameOf(t.assigneeId, names) }
          }))
        ]
        return fit(k, `${SECTION_TITLES[k]}（我的 ${mine.length}，待我审 ${toReview.length}）`, entries, limit, cap, 'task_list assignee=me，详情用 task_get', { note: '手上没有任务' })
      }
      case 'open_tasks': {
        const list = openTasks.filter((t) => !mineIds.has(t.id)).sort(byTaskOrder)
        const entries: Entry[] = list.map((t) => ({
          head: `- ${t.ref} ${taskTag(t)} — ${nameOf(t.assigneeId, names)} — `,
          body: t.title,
          bodyKey: 'title',
          data: { ref: t.ref, id: t.id, status: t.status, priority: t.priority, assignee: nameOf(t.assigneeId, names) }
        }))
        return fit(k, `${SECTION_TITLES[k]}（${list.length}）`, entries, limit, cap, 'task_list', { note: '没有别的没结任务' })
      }
      case 'messages': {
        const list = (input.messages ?? []).filter((m) => m.kind !== 'receipt').sort((a, b) => a.seq - b.seq || a.ts - b.ts)
        const unread = input.unread ?? 0
        const channel = list[0]?.channel
        const firstShownSeq = (n: number) => list[list.length - n]?.seq
        const entries: Entry[] = list.map((m) => {
          const atMe = m.mentions.includes(me.id) || m.mentions.includes('*')
          const dm = m.to ? '（私聊）' : ''
          return {
            head: `- ${hhmm(m.ts)} ${m.from.name}${dm}${atMe ? ' @我' : ''}：`,
            body: oneLine(m.text),
            bodyKey: 'text',
            data: { seq: m.seq, id: m.id, ts: m.ts, from: m.from.name, ...(m.to ? { to: m.to } : {}), ...(atMe ? { mentionsMe: true } : {}) }
          }
        })
        // 先按上限试一遍算出列出几条，再把「看全部」写成从最早列出的那条往前翻
        const probe = fit(k, '', entries, limit, cap, 'chat_read', { newestLast: true })
        const seq = firstShownSeq(probe.json.shown)
        const more = channel && seq ? `chat_read channel=${channel} before=${seq}` : 'chat_read'
        const lobby = input.lobbyMentions
        return fit(k, `${SECTION_TITLES[k]}（未读 ${unread}，共 ${list.length} 条${lobby !== undefined ? `，大厅点名未读 ${lobby}` : ''}）`, entries, limit, cap, more, { newestLast: true, note: '没有消息', extra: { unread, ...(lobby !== undefined ? { lobby_mentions: lobby } : {}) } })
      }
      case 'claims': {
        if (!input.claims) return fit(k, SECTION_TITLES[k], [], limit, cap, 'list_file_claims', { note: '没有占用数据' })
        // 别人的在前、自己的在后；同一组按名字（不用 localeCompare，结果不随系统语言变）再按登记时间
        const list = [...input.claims.claims].sort(
          (a, b) => Number(a.agentId === me.id) - Number(b.agentId === me.id) || (a.agentName < b.agentName ? -1 : a.agentName > b.agentName ? 1 : 0) || a.since - b.since
        )
        const entries: Entry[] = list.map((c) => {
          const who = `${c.agentName}${c.agentId === me.id ? '（我）' : ''}`
          const what = c.kind === 'implicit' ? '刚改过' : '登记'
          const tail = `（${what}${c.task ? `，${c.task}` : ''}，到 ${hhmm(c.expiresAt)}）`
          return {
            head: `- ${who}：`,
            body: `${c.paths.join('、')}${tail}`,
            bodyKey: 'detail',
            data: { id: c.id, agentId: c.agentId, agentName: c.agentName, kind: c.kind, task: c.task, paths: c.paths, expiresAt: c.expiresAt }
          }
        })
        return fit(k, `${SECTION_TITLES[k]}（${list.length}）`, entries, limit, cap, 'list_file_claims', { note: '没人登记文件' })
      }
      case 'unclaimed': {
        if (!input.unclaimed) return fit(k, SECTION_TITLES[k], [], limit, cap, 'git status', { note: '没传 git status，未检查' })
        const entries: Entry[] = input.unclaimed.map((p) => ({ head: '- ', body: p, bodyKey: 'path', data: {} }))
        return fit(k, `${SECTION_TITLES[k]}（${entries.length}）`, entries, limit, cap, 'git status', { note: '没有' })
      }
      case 'memories': {
        const list = (input.memories ?? []).filter((m) => !pinnedIds.has(m.id)).sort((a, b) => b.updatedAt - a.updatedAt)
        const entries: Entry[] = list.map((m) => ({
          head: `- [${m.id}]${m.scope === 'private' ? '（私有）' : ''} `,
          body: m.title,
          bodyKey: 'title',
          data: { id: m.id, scope: m.scope, updatedAt: m.updatedAt }
        }))
        return fit(k, `${SECTION_TITLES[k]}（${list.length}）`, entries, limit, cap, 'memory_search，全文用 memory_read', { note: '没有别的记忆' })
      }
    }
  }

  sections.forEach((k, i) => {
    const later = sections.length - i - 1
    const budget = maxChars - used - 2 - later * SECTION_RESERVE
    const cap = Math.max(Math.min(limitOf(k).maxChars, budget), 0)
    const f = build(k, cap)
    parts.push(f.text)
    used += 2 + f.text.length
    json.sections[k] = f.json
    if (f.truncated) truncated = true
  })

  let text = parts.join('\n\n')
  if (text.length > maxChars) {
    // 只在每节都已压到最少、仍然放不下时发生（max_chars 很小、节很多）
    text = clip(text, maxChars)
    truncated = true
  }
  json.chars = text.length
  json.truncated = truncated
  return { json, text }
}
