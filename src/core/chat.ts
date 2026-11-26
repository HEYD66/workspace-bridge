import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { JsonStore } from './jsonStore'
import { ToolError } from './fileTools'
import type { ChatAttachment } from './chatAttachments'
import type { GroupMessage } from './types'
import { taskThreadChannel, taskThreadTitle, type TaskPosted } from './taskThread'

export const CHAT_CHANNEL = 'general'
export const MAX_CHAT_CHARS = 8000
/** 频道里超过这么多条就把最旧的一半挪进归档 */
export const CHAT_KEEP = 5000
export const CHAT_RATE_LIMIT = 20
export const CHAT_RATE_WINDOW_MS = 60_000
/** 用户在群聊里的成员 id */
export const CHAT_USER = 'user'
/** @所有人 */
export const CHAT_EVERYONE = '*'
/** 回执（receipt=true 的消息）正文最多这么多字 */
export const CHAT_RECEIPT_CHARS = 200
/** next_ack / ack 里表示「任务通知收到第几条」的键（频道 id 不会长这样） */
export const CHAT_NOTICE_ACK_KEY = '_notices'
/** 读者名：同一个身份的副连接（代理脚本之类）握手时自己报的名字，只用来把已读位置分开，不是身份也不是权限 */
export const CHAT_READER_RE = /^[A-Za-z0-9_-]{1,24}$/

/**
 * 读者键：主连接就是成员 id；副连接是「成员id#读者名」。ChatStore 里凡是收 memberId 的读、等、已读位置的方法都认这个键：
 * - 看得到什么、是不是点名给它，照成员 id 算（读者名不改变身份）
 * - 已读位置按整个键分开记。副连接读过的不动主连接的；主连接读过的副连接也算读过（代理不用再处理本人看过的）
 */
export function chatReaderKey(memberId: string, reader?: string): string {
  return reader && CHAT_READER_RE.test(reader) ? `${memberId}#${reader}` : memberId
}

interface Who {
  /** 成员 id */
  id: string
  /** 已读位置记在哪个键下 */
  key: string
  /** 副连接的读者名；主连接没有 */
  reader?: string
}

function who(key: string): Who {
  const i = key.indexOf('#')
  if (i <= 0) return { id: key, key }
  const reader = key.slice(i + 1)
  const id = key.slice(0, i)
  return CHAT_READER_RE.test(reader) ? { id, key, reader } : { id: key, key }
}

/** 能被 @、能私聊的成员（AI）；用户固定是 'user'，不在这里 */
export interface ChatMember {
  id: string
  name: string
}

export type ChatSender = GroupMessage['from']

export interface ChatSendInput {
  text: string
  /** 私聊对象：成员名字或 id，或 user / 用户 */
  to?: string
  /** 引用的消息：消息 id，或同一个频道里的序号（数字、'12'、'#12'）。存下来的一律是消息 id */
  replyTo?: string | number
  workspaceId?: string
  /** 正文之外再 @ 这些 AI（定时任务用；不存在的 id 丢掉） */
  extraMentions?: string[]
  /**
   * 回执（「收到」这一类）：只送给它回复的那条消息的作者、正文里点名的成员和私聊对象；
   * 对其他人不叫醒 chat_wait、不出通知、不计未读。正文最多 CHAT_RECEIPT_CHARS 字，@所有人 在回执里不算数
   */
  receipt?: boolean
  /**
   * 图片附件：先上传拿到 {id, …}，发消息时带上（最多 4 张）。由 ChatStoreOptions.attachments 核对：
   * 每张都要已经存过，元信息以磁盘上的为准，只沿用这里给的 name。带了图片时 text 可以为空；回执不能带图片
   */
  attachments?: ChatAttachment[]
}

export interface ChatListOptions {
  channel?: string
  after?: number
  before?: number
  limit?: number
  query?: string
  /** 谁在看：私聊只有发送方、接收方和 user 能看到 */
  viewer: string
}

export interface ChatReadOptions {
  /** after / before 只能和单个频道一起用（seq 是频道内的） */
  after?: number
  before?: number
  limit?: number
  query?: string
  /** 只要这些人发的（成员 id，用户是 'user'）。给了就按翻历史算：带上自己发的、不动已读位置、返回最新的 limit 条 */
  from?: string[]
  /** 默认 true */
  markRead?: boolean
  /** 只要 @它、@所有人、私聊它的消息 */
  mentionsOnly?: boolean
  /** 读哪些频道，默认只读大厅；多个频道时结果按时间合并 */
  channels?: string[]
  /**
   * 先确认再算已读：这次不动已读位置，结果里带 next_ack；调用方下次把它原样放进 ack 才往前推。
   * 回复在路上丢了的话，下次（不带 ack）同一批原样再给一遍
   */
  confirm?: boolean
  /** 上次结果里的 next_ack：先把已读位置推到这里（只进不退），再做这次的读 */
  ack?: unknown
  /** ack 里只认这些频道（这个成员能看到的全部频道）；不给就用 channels */
  ackChannels?: string[]
}

export interface ChatReadResult {
  messages: GroupMessage[]
  /** 这些频道里还剩的未读数之和 */
  unread_left: number
  /** 频道 → 最新 seq */
  last_seq: Record<string, number>
  /** confirm=true 时才有：频道 → 这次读到的序号，外加 _notices（任务通知收到第几条）。没有新东西时是 {} */
  next_ack?: Record<string, number>
}

/** 任务通知队列（在 Bridge 里）和群聊收信之间的接口：通知能叫醒等待，确认模式下通知等 ack 才删 */
export interface ChatNoticeHooks {
  /** 这个成员有没有还没带走（或带走了还没确认）的通知 */
  pending: (memberId: string) => boolean
  /** 队列里最新一条通知的编号，没有是 0 */
  mark: (memberId: string) => number
  /** 编号不超过 upTo、已经带出去过的通知可以删了 */
  ack: (memberId: string, upTo: number) => void
  /** 这次调用的结果带走的通知先留着，等 ack */
  hold: (memberId: string) => void
}

/** chat_wait 用：ack → 等 → 读 → 该不该算已读，一次包好 */
export interface ChatReceiveOptions {
  channels: string[]
  /** 最多等多久；0 不等 */
  timeoutMs: number
  mentionsOnly?: boolean
  signal?: AbortSignal
  confirm?: boolean
  ack?: unknown
  ackChannels?: string[]
  /**
   * 结果还送不送得出去（没暂停、身份没被吊销、连接还在）。返回 false 时不标已读、不留通知，结果带 undelivered=true。
   * signal 已经 abort 也按送不出去算
   */
  deliverable?: () => boolean
}

export interface ChatReceiveResult extends ChatReadResult {
  /** 等到头也没有要送给它的新消息、也没被通知叫醒 */
  timed_out?: true
  /** message：有新消息；notice：被任务通知叫醒（messages 可能是空的） */
  woken_by?: 'message' | 'notice'
  /** 结果送不出去（见 deliverable），已读位置没动 */
  undelivered?: true
}

export interface ChatWaitOptions {
  /** 只返回 seq 比它大的（只用于单个频道）；不传用这个成员在各频道的已读位置 */
  afterSeq?: number
  timeoutMs: number
  mentionsOnly?: boolean
  signal?: AbortSignal
  /** 等哪些频道，默认只等大厅 */
  channels?: string[]
  /** 任务通知来了也结束等待（ChatStore.nudge）。默认不理会，和原来一样 */
  nudge?: boolean
}

/**
 * 频道 id：'general'（大厅）、'ws:<工作区 id>'（项目的主群聊，一直在），
 * 或 'ws:<工作区 id>.c_<会话 id>'（用户在项目里另开的会话，能改名、归档、删除）
 */
export function workspaceChannel(workspaceId: string): string {
  return `ws:${workspaceId}`
}

/** 'ws:<id>' 和 'ws:<id>.c_<会话>' → 工作区 id；大厅或别的返回 undefined */
export function channelWorkspaceId(channel: string): string | undefined {
  if (!channel.startsWith('ws:')) return undefined
  const dot = channel.indexOf('.')
  return dot < 0 ? channel.slice(3) : channel.slice(3, dot)
}

const CHANNEL_RE = /^(general|ws:[A-Za-z0-9_-]{1,64}(\.c_[a-z0-9]{6,20})?)$/
const THREAD_RE = /^ws:[A-Za-z0-9_-]{1,64}\.c_[a-z0-9]{6,20}$/

/** 是不是项目里另开的会话（'ws:<id>.c_<会话>'） */
export function isThreadChannel(channel: string): boolean {
  return THREAD_RE.test(channel)
}

/** 是不是某个项目的主群聊（'ws:<id>'；大厅和另开的会话不是） */
export function isMainChannel(channel: string): boolean {
  return CHANNEL_RE.test(channel) && channel !== CHAT_CHANNEL && !THREAD_RE.test(channel)
}

/** 会话标题最多这么多字 */
export const MAX_THREAD_TITLE = 60
/** 一个项目里最多这么多个会话（含归档的） */
export const MAX_THREADS_PER_WORKSPACE = 200

/** 项目里另开的一个会话 */
export interface ChatThread {
  /** 频道 id：'ws:<工作区 id>.c_<会话 id>' */
  id: string
  workspaceId: string
  title: string
  createdAt: number
  /** 归档了：AI 看不到、不能再发言，用户还能看、能恢复 */
  archived?: boolean
  /** 任务的线才有：是哪条任务的、谁在里面、任务记录记到哪了 */
  task?: ChatThreadTask
}

/** 任务的线挂在哪条任务上。members：能进这条线的 AI（执行者、派活的人、创建者），用户总能进 */
export interface ChatThreadTask {
  id: string
  ref: string
  members: string[]
  /** 任务记录里已经记进线里的最后一条；没有就是一条都还没记 */
  posted?: TaskPosted
}

interface ThreadsFile {
  /** 频道 id → 会话 */
  threads: Record<string, { title: string; createdAt: number; archived?: boolean; task?: ChatThreadTask }>
  /** 清空过的频道：序号从这个数往后接着排（已读位置、AI 手里的 ack 不会错位） */
  floors: Record<string, number>
  /** 用户给项目主群聊起的名字：频道 id（'ws:<工作区 id>'）→ 名字。没有就叫「群聊」。只在工作台界面上用 */
  titles: Record<string, string>
}

function parseThreadTask(v: unknown): ChatThreadTask | undefined {
  if (!v || typeof v !== 'object') return undefined
  const t = v as Record<string, unknown>
  if (typeof t.id !== 'string' || !t.id || typeof t.ref !== 'string') return undefined
  const members = Array.isArray(t.members) ? t.members.filter((x): x is string => typeof x === 'string') : []
  const p = t.posted as Record<string, unknown> | undefined
  const posted = p && typeof p === 'object' && typeof p.ts === 'number' && typeof p.n === 'number' ? { ts: p.ts, n: p.n } : undefined
  return { id: t.id, ref: t.ref, members, ...(posted ? { posted } : {}) }
}

/** 频道的文件名（不带扩展名）：冒号换成下划线 */
function channelFileBase(channel: string): string {
  return channel.replace(/:/g, '_')
}

export interface ChatStoreOptions {
  /** <dataDir>/chat */
  dir: string
  /** 当前的 AI 名单（解析 @、私聊对象），每次现取 */
  members: () => ChatMember[]
  /** 新消息到达（已进内存；写盘失败也会发） */
  onChange?: (msg: GroupMessage) => void
  /** 任务通知队列；不给时通知不叫醒等待，next_ack 里也没有 _notices */
  notices?: ChatNoticeHooks
  /** 图片存储（ChatAttachmentStore）：发消息时用它核对附件。不给的话这个群聊不收图片 */
  attachments?: { resolve: (list: unknown) => ChatAttachment[] }
  /** 测试用：归档阈值、限流 */
  maxMessages?: number
  rateLimit?: number
  rateWindowMs?: number
  now?: () => number
}

interface Channel {
  name: string
  file: string
  messages: GroupMessage[]
  lastSeq: number
  lastTs: number
  /** 还没写进 jsonl 的行（写失败时留着，下次一起写） */
  pending: string[]
  /** 上次写到一半失败：文件末尾可能没有换行，下次先补一个 */
  dirty: boolean
  /** 已经写进归档的最大 seq（归档后重写主文件失败时，重试不重复归档） */
  archivedThrough: number
}

interface Waiter {
  /** 等的频道 → 从哪个 seq 之后算新消息 */
  after: Map<string, number>
  /** 成员 id（不带读者名） */
  memberId: string
  /** 副连接的读者名 */
  reader?: string
  mentionsOnly: boolean
  /** 任务通知来了要不要醒 */
  nudge: boolean
  /** 唤醒时收集各频道的新消息 */
  collect: () => GroupMessage[]
  done: (msgs: GroupMessage[], nudged?: boolean) => void
}

const norm = (s: string): string => s.replace(/\s+/g, '').toLowerCase()
const WORD = /[A-Za-z0-9_]/
const USER_ALIASES = ['user', '用户', '我', '你']

/**
 * 私聊只有发送方、接收方和 user 能看到；「分工明确」时发的消息（带 audience）只有发的人、audience 里的成员和 user 能看到。
 * 频道当前的主脑另外总能看到带 audience 的消息，那一条在 ChatStore 里判断（要知道现在的主脑是谁）
 */
export function chatVisible(m: GroupMessage, viewer: string): boolean {
  if (viewer === CHAT_USER || m.from.id === viewer) return true
  if (m.to) return m.to === viewer
  return !m.audience || m.audience.includes(viewer)
}

/** 这条消息是不是点名给这个成员的：@它、@所有人、私聊它 */
export function chatMentions(m: GroupMessage, memberId: string): boolean {
  return m.to === memberId || m.mentions.includes(memberId) || m.mentions.includes(CHAT_EVERYONE)
}

/**
 * 这条消息要不要送到这个成员面前（叫醒它的 chat_wait、出通知、计进未读）。
 * 普通消息都送；回执只送给点名到的人：它回复的那条消息的作者和正文里 @ 的成员（发的时候都记进了 mentions）、私聊对象
 */
export function chatDelivers(m: GroupMessage, memberId: string): boolean {
  // 任务的线里自动记的事件：谁都不送（任务本身的通知另外走），读频道时能看到
  if (m.kind === 'event') return false
  return m.kind !== 'receipt' || m.to === memberId || m.mentions.includes(memberId)
}

/**
 * 对这个读者来说是不是「自己发的」（从已读位置往后读时不带、不算未读、不叫醒）。
 * 主连接：同一个身份从副连接（from.via）发的不算自己发的，本人下次读能看到代理替它说了什么；
 * 副连接：同一个身份发的都算自己的
 */
function isOwn(m: GroupMessage, w: Who): boolean {
  return m.from.id === w.id && (w.reader !== undefined || !m.from.via)
}

/** i 这个位置的字符前面是不是有奇数个反斜杠（被转义了） */
function escapedAt(text: string, i: number): boolean {
  let n = 0
  while (i - 1 - n >= 0 && text[i - 1 - n] === '\\') n++
  return n % 2 === 1
}

/**
 * 标出正文里属于代码的字符（值为 1）：``` 或 ~~~ 围起来的代码块、反引号围起来的行内代码。
 * 举例或贴代码时写到的 @名字 不该提醒到人。规则照 Markdown：
 * - 代码块：一行以最多 3 个空格加至少 3 个 ` 或 ~ 开头，到下一行同一种、不短于它的围栏为止；没有收尾就到文末
 * - 行内代码：一串反引号开头，到同一段里下一串一样长的反引号为止；配不上对的反引号是普通字符，不跨空行
 */
function codeMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length)
  if (!text.includes('`') && !text.includes('~~~')) return mask
  // 代码块以外的区间，按空行切成段，行内代码只在段里找
  const plain: [number, number][] = []
  let fence: { ch: string; len: number } | undefined
  let plainStart = 0
  for (let lineStart = 0; lineStart <= text.length; ) {
    let lineEnd = text.indexOf('\n', lineStart)
    if (lineEnd < 0) lineEnd = text.length
    const line = text.slice(lineStart, lineEnd)
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      mask.fill(1, lineStart, lineEnd)
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && !m[2].trim()) {
        fence = undefined
        plainStart = Math.min(lineEnd + 1, text.length)
      }
    } else if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      // 反引号围栏那一行后面还有反引号的不是代码块（是行内代码）
      if (lineStart > plainStart) plain.push([plainStart, lineStart])
      fence = { ch: m[1][0], len: m[1].length }
      mask.fill(1, lineStart, lineEnd)
    } else if (!line.trim()) {
      // 空行：段落到此为止
      if (lineStart > plainStart) plain.push([plainStart, lineStart])
      plainStart = Math.min(lineEnd + 1, text.length)
    }
    lineStart = lineEnd + 1
  }
  if (!fence && plainStart < text.length) plain.push([plainStart, text.length])
  for (const [from, to] of plain) {
    for (let i = from; i < to; ) {
      if (text[i] !== '`' || escapedAt(text, i)) {
        i++
        continue
      }
      let n = 1
      while (i + n < to && text[i + n] === '`') n++
      // 找下一串正好 n 个的反引号
      let close = -1
      for (let j = i + n; j < to; ) {
        if (text[j] !== '`') {
          j++
          continue
        }
        let k = 1
        while (j + k < to && text[j + k] === '`') k++
        if (k === n) {
          close = j
          break
        }
        j += k
      }
      if (close < 0) {
        i += n
        continue
      }
      mask.fill(1, i, close + n)
      i = close + n
    }
  }
  return mask
}

/**
 * 解析 @：@ 后面按 AI 名字或 id 匹配（不区分大小写，忽略空格，长的优先），
 * @所有人 / @全体 / @all → '*'，@我 / @用户 / @你 → 'user'。邮箱里的 @ 不算；
 * 代码块、行内代码（反引号）里的 @ 不算，写成 \@ 的也不算（举例时用）
 */
export function parseMentions(text: string, members: ChatMember[]): string[] {
  const keys: { key: string; id: string }[] = [
    { key: '所有人', id: CHAT_EVERYONE },
    { key: '全体', id: CHAT_EVERYONE },
    { key: 'all', id: CHAT_EVERYONE },
    ...['我', '用户', '你'].map((key) => ({ key, id: CHAT_USER }))
  ]
  for (const m of members) {
    keys.push({ key: norm(m.name), id: m.id }, { key: m.id.toLowerCase(), id: m.id })
  }
  const sorted = keys.filter((k) => k.key).sort((a, b) => b.key.length - a.key.length)
  const out = new Set<string>()
  const code = codeMask(text)
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@' && text[i] !== '＠') continue
    if (code[i] || escapedAt(text, i)) continue
    if (i > 0 && /[A-Za-z0-9._%+-]/.test(text[i - 1])) continue
    // @ 后面去掉空白拼起来比对，记下每个字符在原文里的位置
    let compact = ''
    const pos: number[] = []
    for (let j = i + 1; j < text.length && compact.length < 64; j++) {
      const ch = text[j]
      if (/\s/.test(ch)) {
        if (!compact) break
        continue
      }
      if (ch === '@' || ch === '＠' || code[j]) break
      compact += ch.toLowerCase()
      pos.push(j)
    }
    for (const k of sorted) {
      if (!compact.startsWith(k.key)) continue
      const end = pos[k.key.length - 1]
      const next = text[end + 1] ?? ''
      // @alice2 不算 @alice；@我们 不算 @我
      if (WORD.test(k.key.at(-1)!) && WORD.test(next)) continue
      if (k.key === '我' && next === '们') continue
      out.add(k.id)
      i = end
      break
    }
  }
  return [...out]
}

/**
 * 群聊存储：每个频道一个 jsonl（只追加），启动时读进内存，之后读都走内存。
 * 写盘失败不丢消息：消息照样进内存、照样通知，没写进去的行留着下次一起写。
 * 已读游标存在 cursors.json：{ [memberId]: { [channel]: seq } }；副连接的记在「memberId#读者名」下
 */
export class ChatStore {
  private readonly channels = new Map<string, Channel>()
  private readonly cursors: JsonStore<Record<string, Record<string, number>>>
  /** 干活方式，存在 modes.json：{ [频道]: 主脑的成员 id }。有主脑是「分工明确」，没有记录是「灵感激荡」 */
  private readonly leads: JsonStore<Record<string, string>>
  /**
   * 用户给频道挑的人，存在 teams.json：{ [频道]: 成员 id[] }。「分工明确」时是子代理（不含主脑），「灵感激荡」时是参与讨论的 AI。
   * 没有记录是没挑过：频道里的成员都算。单独一个文件，modes.json 的格式不变（旧版本照样读得懂）
   */
  private readonly teams: JsonStore<Record<string, string[]>>
  /** 会话和清空记录，存在 threads.json */
  private readonly threadStore: JsonStore<ThreadsFile>
  private readonly waiters = new Set<Waiter>()
  /** agentId → 最近一分钟内发消息的时间 */
  private readonly sent = new Map<string, number[]>()
  private readonly max: number
  private readonly rateLimit: number
  private readonly rateWindow: number
  private readonly now: () => number

  constructor(private readonly opts: ChatStoreOptions) {
    fs.mkdirSync(opts.dir, { recursive: true })
    this.max = opts.maxMessages ?? CHAT_KEEP
    this.rateLimit = opts.rateLimit ?? CHAT_RATE_LIMIT
    this.rateWindow = opts.rateWindowMs ?? CHAT_RATE_WINDOW_MS
    this.now = opts.now ?? Date.now
    this.cursors = new JsonStore(path.join(opts.dir, 'cursors.json'), () => ({}))
    this.leads = new JsonStore(path.join(opts.dir, 'modes.json'), () => ({}))
    this.teams = new JsonStore(path.join(opts.dir, 'teams.json'), () => ({}))
    this.threadStore = new JsonStore<ThreadsFile>(path.join(opts.dir, 'threads.json'), () => ({ threads: {}, floors: {}, titles: {} }))
    this.channel(CHAT_CHANNEL)
  }

  // ========== 会话 ==========
  // 每个项目有一个主群聊（'ws:<id>'，一直在），用户可以另开任意多个会话（'ws:<id>.c_<会话>'）。
  // 会话和主群聊一样是一个频道：谁能进看的是工作区的访问权，干活方式各管各的。
  // 归档的会话 AI 看不到也发不了言；删除是把消息文件挪进 deleted/ 再从列表里拿掉

  private threadData(): ThreadsFile {
    const raw: unknown = this.threadStore.get()
    // 存的对象没换就用上次校验过的（任务一多，频道列表里每个频道都要查一次，不能每次重新校验）
    if (this.threadCache && this.threadCache.raw === raw) return this.threadCache.data
    const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const threads: ThreadsFile['threads'] = {}
    if (o.threads && typeof o.threads === 'object') {
      for (const [id, v] of Object.entries(o.threads as Record<string, unknown>)) {
        if (!THREAD_RE.test(id) || !v || typeof v !== 'object') continue
        const t = v as Record<string, unknown>
        if (typeof t.title !== 'string' || !t.title) continue
        const task = parseThreadTask(t.task)
        threads[id] = { title: t.title, createdAt: typeof t.createdAt === 'number' ? t.createdAt : 0, ...(t.archived === true ? { archived: true } : {}), ...(task ? { task } : {}) }
      }
    }
    const floors: ThreadsFile['floors'] = {}
    if (o.floors && typeof o.floors === 'object') {
      for (const [id, v] of Object.entries(o.floors as Record<string, unknown>)) if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) floors[id] = v
    }
    const titles: ThreadsFile['titles'] = {}
    if (o.titles && typeof o.titles === 'object') {
      for (const [id, v] of Object.entries(o.titles as Record<string, unknown>)) {
        if (isMainChannel(id) && typeof v === 'string' && v && v.length <= MAX_THREAD_TITLE) titles[id] = v
      }
    }
    const data = { threads, floors, titles }
    this.threadCache = { raw, data }
    return data
  }
  private threadCache: { raw: unknown; data: ThreadsFile } | undefined

  private saveThreads(next: ThreadsFile): void {
    try {
      this.threadStore.set(next)
    } catch (e) {
      // JsonStore.set 先改内存再写盘：写失败这次运行里照样生效，重启后回到盘上的旧值
      console.warn(`[chat] 保存会话列表失败：${(e as Error).message}`)
    }
  }

  /** 这个频道是会话的话返回它；主群聊、大厅、不存在的返回 undefined */
  thread(channel: string): ChatThread | undefined {
    if (!THREAD_RE.test(channel)) return undefined
    const t = this.threadData().threads[channel]
    return t ? { id: channel, workspaceId: channelWorkspaceId(channel)!, ...t } : undefined
  }

  /** 这个频道清空过的话，返回清掉的最大序号；没清过是 0 */
  floor(channel: string): number {
    return this.threadData().floors[channel] ?? 0
  }

  /** 会话列表，按创建时间排（旧的在前）；给了工作区 id 只列它的。含归档的 */
  threads(workspaceId?: string): ChatThread[] {
    return Object.entries(this.threadData().threads)
      .map(([id, t]) => ({ id, workspaceId: channelWorkspaceId(id)!, ...t }))
      .filter((t) => workspaceId === undefined || t.workspaceId === workspaceId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  private threadTitle(title: unknown): string {
    const t = String(title ?? '').replace(/\s+/g, ' ').trim()
    if (!t) throw new ToolError('INVALID_ARGS', '会话标题不能为空')
    if (t.length > MAX_THREAD_TITLE) throw new ToolError('TOO_LARGE', `会话标题不能超过 ${MAX_THREAD_TITLE} 字`)
    return t
  }

  /** 在一个项目里新开会话。调用方先确认工作区存在 */
  createThread(workspaceId: string, title: string): ChatThread {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId)) throw new ToolError('INVALID_ARGS', `工作区 ${workspaceId} 不合法`)
    const name = this.threadTitle(title)
    const data = this.threadData()
    // 任务的线跟着任务走，不占这个名额
    if (Object.keys(data.threads).filter((id) => channelWorkspaceId(id) === workspaceId && !data.threads[id].task).length >= MAX_THREADS_PER_WORKSPACE) {
      throw new ToolError('TOO_LARGE', `一个项目最多 ${MAX_THREADS_PER_WORKSPACE} 个会话，先删掉不用的`)
    }
    let id = ''
    do id = `ws:${workspaceId}.c_${crypto.randomBytes(5).toString('hex')}`
    while (data.threads[id])
    const meta = { title: name, createdAt: this.now() }
    this.saveThreads({ ...data, threads: { ...data.threads, [id]: meta } })
    return { id, workspaceId, ...meta }
  }

  // ---------- 任务的线 ----------
  // 每条任务自带一个会话：id 由任务 id 算出来，标题跟着任务，谁能进看任务的执行者 / 派活的人 / 创建者

  /**
   * 确保这条任务有它的线：没有就开（posted 是开的时候任务记录已经到哪了，之前的不补记；不给就是从头记），
   * 有了就把标题、成员对齐。返回频道 id、是不是新开的、有没有改动；任务 id 不合规返回 undefined
   */
  ensureTaskThread(workspaceId: string, task: { id: string; ref: string; title: string }, members: string[], posted?: TaskPosted): { id: string; created: boolean; changed: boolean } | undefined {
    const id = taskThreadChannel(workspaceId, task.id)
    if (!id) return undefined
    const title = taskThreadTitle(task.ref, task.title)
    const mem = [...new Set(members)].sort()
    const data = this.threadData()
    const cur = data.threads[id]
    if (cur) {
      if (!cur.task) {
        // 这一项没有任务信息：退回过旧版本，旧版本一改会话列表就把它不认识的 task 丢了，这条线成了普通会话。
        // 'c_t…' 这种 id 只有任务的线会用（用户开的会话是十六进制，没有 t），所以认回来；归档标记去掉（任务的线不能归档），以前的记录不补记
        const { archived: _archived, ...rest } = cur
        this.saveThreads({ ...data, threads: { ...data.threads, [id]: { ...rest, title, task: { id: task.id, ref: task.ref, members: mem, ...(posted ? { posted } : {}) } } } })
        return { id, created: false, changed: true }
      }
      if (cur.title === title && cur.task.ref === task.ref && cur.task.members.join('\n') === mem.join('\n')) return { id, created: false, changed: false }
      this.saveThreads({ ...data, threads: { ...data.threads, [id]: { ...cur, title, task: { ...cur.task, ref: task.ref, members: mem } } } })
      return { id, created: false, changed: true }
    }
    const meta = { title, createdAt: this.now(), task: { id: task.id, ref: task.ref, members: mem, ...(posted ? { posted } : {}) } }
    this.saveThreads({ ...data, threads: { ...data.threads, [id]: meta } })
    return { id, created: true, changed: true }
  }

  /** 记下任务记录已经记到哪了 */
  setTaskPosted(channel: string, posted: TaskPosted): void {
    const data = this.threadData()
    const cur = data.threads[channel]
    if (!cur?.task) return
    this.saveThreads({ ...data, threads: { ...data.threads, [channel]: { ...cur, task: { ...cur.task, posted } } } })
  }

  /**
   * 往频道里记一条事件（任务的线里的派活、交付、审查……）。不是谁说的话：不解析 @、不限频、不分干活方式，
   * 对谁都不叫醒、不通知、不计未读，读这个频道时能看到。正文为空不记，返回 undefined
   */
  postEvent(channel: string, from: ChatSender, text: string, workspaceId?: string): GroupMessage | undefined {
    const body = String(text ?? '').trim().slice(0, MAX_CHAT_CHARS)
    if (!body) return undefined
    const ch = this.channel(channel)
    const ts = Math.max(this.now(), ch.lastTs + 1)
    const msg: GroupMessage = {
      id: `m_${ts.toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      seq: ch.lastSeq + 1,
      channel: ch.name,
      ts,
      from: { kind: from.kind, id: from.id, name: from.name, ...(from.color ? { color: from.color } : {}) },
      text: body,
      mentions: [],
      kind: 'event',
      ...(workspaceId ? { workspaceId } : {})
    }
    ch.messages.push(msg)
    ch.lastSeq = msg.seq
    ch.lastTs = ts
    ch.pending.push(JSON.stringify(msg) + '\n')
    this.flush(ch)
    this.maybeArchive(ch)
    try {
      this.opts.onChange?.(msg)
    } catch (e) {
      console.warn(`[chat] 通知新消息失败：${(e as Error).message}`)
    }
    return msg
  }

  /** 改会话的标题。返回有没有变 */
  renameThread(channel: string, title: string): boolean {
    const cur = this.thread(channel)
    if (!cur) throw new ToolError('NOT_FOUND', '这个会话不存在，可能已被删除')
    const name = this.threadTitle(title)
    if (name === cur.title) return false
    const data = this.threadData()
    this.saveThreads({ ...data, threads: { ...data.threads, [channel]: { ...data.threads[channel], title: name } } })
    return true
  }

  /** 用户给项目主群聊起的名字；没起过是 undefined（界面上叫「群聊」） */
  mainTitle(channel: string): string | undefined {
    return isMainChannel(channel) ? this.threadData().titles[channel] : undefined
  }

  /** 给项目的主群聊起名字；空的是恢复默认（「群聊」）。只是界面上的名字，AI 那边看到的还是工作区名。返回有没有变 */
  renameMain(channel: string, title: string): boolean {
    if (!isMainChannel(channel)) throw new ToolError('INVALID_ARGS', '只有项目的主群聊能这样改名')
    const blank = !String(title ?? '').replace(/\s+/g, ' ').trim()
    const name = blank ? undefined : this.threadTitle(title)
    const data = this.threadData()
    if (data.titles[channel] === name) return false
    const { [channel]: _old, ...rest } = data.titles
    this.saveThreads({ ...data, titles: name ? { ...rest, [channel]: name } : rest })
    return true
  }

  /** 归档 / 恢复会话。返回有没有变 */
  setThreadArchived(channel: string, archived: boolean): boolean {
    const cur = this.thread(channel)
    if (!cur) throw new ToolError('NOT_FOUND', '这个会话不存在，可能已被删除')
    if (!!cur.archived === archived) return false
    const data = this.threadData()
    const { archived: _old, ...rest } = data.threads[channel]
    this.saveThreads({ ...data, threads: { ...data.threads, [channel]: archived ? { ...rest, archived: true } : rest } })
    return true
  }

  /**
   * 删掉一个频道的全部消息：主文件和归档文件挪进 deleted/<时间>-<频道>/（不直接删，误删还能手动找回）。
   * 会话：连同它的记录、已读位置、干活方式一起去掉，频道不再存在。
   * 主群聊、大厅：只清空消息，频道还在，序号接着原来的往后排。
   * 文件挪不动时抛错，什么都不改。返回清掉了几条（只数还在主文件里的）
   */
  removeChannel(channel: string): number {
    const ch = this.channel(channel)
    const isThread = THREAD_RE.test(ch.name)
    const base = channelFileBase(ch.name)
    const files: { from: string; name: string }[] = []
    if (fs.existsSync(ch.file)) files.push({ from: ch.file, name: path.basename(ch.file) })
    try {
      for (const f of fs.readdirSync(this.archiveDir())) {
        if (f.startsWith(`${base}-`) && /^\d{8}\.jsonl$/.test(f.slice(base.length + 1))) files.push({ from: path.join(this.archiveDir(), f), name: `archive-${f}` })
      }
    } catch {
      // 没有归档目录
    }
    if (files.length) {
      const d = new Date(this.now())
      const p2 = (n: number): string => String(n).padStart(2, '0')
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
      let dir = path.join(this.opts.dir, 'deleted', `${stamp}-${base}`)
      for (let i = 2; fs.existsSync(dir); i++) dir = path.join(this.opts.dir, 'deleted', `${stamp}-${base}-${i}`)
      try {
        fs.mkdirSync(dir, { recursive: true })
        for (const f of files) fs.renameSync(f.from, path.join(dir, f.name))
      } catch (e) {
        throw new ToolError('INTERNAL', `消息文件挪不动，没有删：${(e as Error).message}`)
      }
    }
    const count = ch.messages.length
    const lastSeq = ch.lastSeq
    this.channels.delete(ch.name)
    const data = this.threadData()
    if (isThread) {
      const { [ch.name]: _gone, ...threads } = data.threads
      const { [ch.name]: _floor, ...floors } = data.floors
      this.saveThreads({ ...data, threads, floors })
      // 已读位置、干活方式、子代理名单里这个频道的记录一起去掉
      const cursors = this.cursors.get()
      if (Object.values(cursors).some((c) => c && typeof c === 'object' && ch.name in c)) {
        const next: Record<string, Record<string, number>> = {}
        for (const [k, c] of Object.entries(cursors)) {
          const { [ch.name]: _c, ...rest } = c ?? {}
          next[k] = rest
        }
        try {
          this.cursors.set(next)
        } catch (e) {
          console.warn(`[chat] 保存已读位置失败：${(e as Error).message}`)
        }
      }
      for (const store of [this.leads, this.teams] as JsonStore<Record<string, unknown>>[]) {
        const cur: unknown = store.get()
        if (!cur || typeof cur !== 'object' || !(ch.name in (cur as object))) continue
        const { [ch.name]: _m, ...rest } = cur as Record<string, unknown>
        try {
          store.set(rest)
        } catch (e) {
          console.warn(`[chat] 保存干活方式失败：${(e as Error).message}`)
        }
      }
    } else if (lastSeq > 0) {
      this.saveThreads({ ...data, floors: { ...data.floors, [ch.name]: lastSeq } })
    }
    return count
  }

  // ========== 干活方式 ==========
  // 灵感激荡（默认）：频道里的人都看得到每条消息。
  // 分工明确：频道有一个主脑。别的成员发的消息只有主脑和用户能看到；主脑和用户 @谁就只送给谁，@所有人 才是全员；
  // 谁都不 @ 的只有主脑和用户看到。谁能看到在发的时候记进消息的 audience，之后改方式不影响已经发出去的
  // 子代理可以由用户选：选了以后，主脑和选中的子代理是这次分工的人，@所有人 只到他们；没选中的成员不参与——
  // 主脑 @ 不到他们，他们在这个频道发的只有用户看到（用户点名他们照样送到）
  // 「灵感激荡」也可以挑人（参与讨论的 AI）：挑了以后只有他们看得到这个频道的消息，@所有人 只到他们；
  // 没选中的成员看不到（用户点名它的那条除外），别人 @ 不到它，它在这里发的只有用户看到。
  // 这里看的是现在的名单，不是发的时候的：后来加进来的 AI 能看到之前的讨论。
  // 名单跟着干活方式走：改成「分工明确」时参与的人（除了主脑）就是子代理，改回来时主脑和子代理就是参与的人

  /** 这个频道的主脑（成员 id）；「灵感激荡」时是 undefined。记着的主脑已经不在名单里（被吊销）也算没有 */
  lead(channel = CHAT_CHANNEL): string | undefined {
    const data: unknown = this.leads.get()
    const id = data && typeof data === 'object' ? (data as Record<string, unknown>)[channel] : undefined
    return typeof id === 'string' && id && this.opts.members().some((m) => m.id === id) ? id : undefined
  }

  /** 设主脑（改成「分工明确」或换主脑）；leadId 给 undefined 是改回「灵感激荡」。返回有没有变 */
  setLead(channel: string, leadId: string | undefined): boolean {
    const ch = this.channel(channel)
    if (leadId !== undefined && !this.opts.members().some((m) => m.id === leadId)) throw new ToolError('NOT_FOUND', '找不到这个成员，可能已被吊销')
    if (this.lead(ch.name) === leadId) return false
    const data: unknown = this.leads.get()
    const next: Record<string, string> = {}
    // 顺手丢掉坏数据和主脑已经不在的记录
    if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) if (k !== ch.name && typeof v === 'string' && this.opts.members().some((m) => m.id === v)) next[k] = v
    }
    // 挑过人的：换主脑时新主脑从名单里出来，原主脑留在这次分工里（进名单）；
    // 改回灵感激荡时主脑和子代理就是参与讨论的人；从灵感激荡改过来时参与的人（除了主脑）就是子代理
    const prev = this.lead(ch.name)
    const picked = this.picked(ch.name)
    if (leadId) next[ch.name] = leadId
    try {
      this.leads.set(next)
    } catch (e) {
      // JsonStore.set 先改内存再写盘：写失败这次运行里照样生效，重启后回到盘上的旧值
      console.warn(`[chat] 保存干活方式失败：${(e as Error).message}`)
    }
    if (picked) this.saveSubs(ch.name, [...new Set([...(prev ? [prev] : []), ...picked])].filter((id) => id !== leadId))
    return true
  }

  /** teams.json 里这个频道记着的人（已经不在的成员不算）；没记过是 undefined */
  private picked(channel: string): string[] | undefined {
    const data: unknown = this.teams.get()
    const list = data && typeof data === 'object' ? (data as Record<string, unknown>)[channel] : undefined
    if (!Array.isArray(list)) return undefined
    const known = new Set(this.opts.members().map((m) => m.id))
    return [...new Set(list.filter((id): id is string => typeof id === 'string' && known.has(id)))]
  }

  /**
   * 「灵感激荡」时用户挑的参与讨论的 AI（成员 id）。undefined：没挑过（频道里的成员都参与），或者频道是「分工明确」。
   * 名单里的人都不在了也算没挑过
   */
  participants(channel = CHAT_CHANNEL): string[] | undefined {
    if (this.lead(channel)) return undefined
    const list = this.picked(channel)
    return list && list.length ? list : undefined
  }

  /** 挑参与讨论的 AI：ids 给 undefined 是「不挑，都参与」；至少要有一个。频道得是「灵感激荡」。返回有没有变 */
  setParticipants(channel: string, ids: string[] | undefined): boolean {
    const ch = this.channel(channel)
    if (this.lead(ch.name)) throw new ToolError('INVALID_ARGS', '这个频道现在是「分工明确」，参与的 AI 在子代理里选')
    let next: string[] | undefined
    if (ids !== undefined) {
      const known = new Set(this.opts.members().map((m) => m.id))
      const missing = ids.find((id) => !known.has(id))
      if (missing !== undefined) throw new ToolError('NOT_FOUND', '找不到这个成员，可能已被吊销')
      next = [...new Set(ids)]
      if (!next.length) throw new ToolError('INVALID_ARGS', '至少选一个 AI；要让频道里的 AI 都参与，选「全选」')
    }
    const cur = this.participants(ch.name)
    const same = cur === undefined || next === undefined ? cur === next : cur.length === next.length && cur.every((id) => next!.includes(id))
    if (same) return false
    this.saveSubs(ch.name, next)
    return true
  }

  /**
   * 这个成员现在是不是被挑在这个频道外面：频道挑过人（子代理或参与讨论的 AI）而它不在里面、也不是主脑。
   * 没挑过人的频道谁都不在外面
   */
  sitsOut(channel: string, memberId: string): boolean {
    if (memberId === CHAT_USER) return false
    const data: unknown = this.teams.get()
    const list = data && typeof data === 'object' ? (data as Record<string, unknown>)[channel] : undefined
    if (!Array.isArray(list) || list.includes(memberId)) return false
    const leadId = this.lead(channel)
    if (leadId) return leadId !== memberId
    // 灵感激荡：名单里的人都不在了算没挑过
    return !!this.participants(channel)
  }

  /**
   * 被挑在外面的成员看不到的消息：频道里普通的、没有记 audience 的消息（灵感激荡时发的），
   * 除非是它自己发的或者点了它的名。带 audience 的和私聊照原来的规则
   */
  hiddenFromOutsider(m: GroupMessage, viewer: string): boolean {
    if (m.to || m.audience || m.from.id === viewer || m.mentions.includes(viewer)) return false
    return this.sitsOut(m.channel, viewer)
  }

  /**
   * 用户选的子代理（成员 id）。undefined：频道是「灵感激荡」，或者没选过（主脑以外的成员都算子代理）。
   * 名单里已经不在的成员、主脑自己不算
   */
  subs(channel = CHAT_CHANNEL): string[] | undefined {
    const leadId = this.lead(channel)
    if (!leadId) return undefined
    return this.picked(channel)?.filter((id) => id !== leadId)
  }

  /**
   * 选子代理：ids 给 undefined 是「不挑，主脑以外都算」；给空数组是主脑一个人干。频道要先有主脑。返回有没有变
   */
  setSubs(channel: string, ids: string[] | undefined): boolean {
    const ch = this.channel(channel)
    const leadId = this.lead(ch.name)
    if (!leadId) throw new ToolError('INVALID_ARGS', '这个频道现在是「灵感激荡」，先选主脑再选子代理')
    let next: string[] | undefined
    if (ids !== undefined) {
      const known = new Set(this.opts.members().map((m) => m.id))
      const missing = ids.find((id) => !known.has(id))
      if (missing !== undefined) throw new ToolError('NOT_FOUND', '找不到这个成员，可能已被吊销')
      next = [...new Set(ids)].filter((id) => id !== leadId)
    }
    const cur = this.subs(ch.name)
    const same = cur === undefined || next === undefined ? cur === next : cur.length === next.length && cur.every((id) => next!.includes(id))
    if (same) return false
    this.saveSubs(ch.name, next)
    return true
  }

  private saveSubs(channel: string, ids: string[] | undefined): void {
    const data: unknown = this.teams.get()
    const next: Record<string, string[]> = {}
    // 顺手丢掉坏数据
    if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        if (k !== channel && Array.isArray(v)) next[k] = v.filter((id): id is string => typeof id === 'string')
      }
    }
    if (ids) next[channel] = ids
    const before: unknown = this.teams.get()
    if (JSON.stringify(before) === JSON.stringify(next)) return
    try {
      this.teams.set(next)
    } catch (e) {
      console.warn(`[chat] 保存子代理名单失败：${(e as Error).message}`)
    }
  }

  /** 成员在这个频道的分工里是什么：lead 主脑、sub 子代理、out 没选中（不参与）；「灵感激荡」时是 undefined */
  role(channel: string, memberId: string): 'lead' | 'sub' | 'out' | undefined {
    const leadId = this.lead(channel)
    if (!leadId) return undefined
    if (memberId === leadId) return 'lead'
    const picked = this.subs(channel)
    return !picked || picked.includes(memberId) ? 'sub' : 'out'
  }

  /** 正文里 @ 了、但这条消息没有送到的成员（分工明确时被去掉的点名）；给 chat_send 的结果用 */
  droppedMentions(m: GroupMessage, anyMode = false): string[] {
    if (!m.audience && !anyMode) return []
    return parseMentions(m.text, this.opts.members()).filter((id) => id !== CHAT_USER && id !== CHAT_EVERYONE && id !== m.from.id && !m.mentions.includes(id))
  }

  /**
   * viewer 能不能看到这条：照 chatVisible；另外，带 audience 的消息频道当前的主脑总能看到。
   * audience 是空的那种（没选进分工的成员发的，只给用户看）主脑也看不到
   */
  private visible(m: GroupMessage, viewer: string): boolean {
    if (this.hiddenFromOutsider(m, viewer)) return false
    return chatVisible(m, viewer) || (!!m.audience && m.audience.length > 0 && !m.to && this.lead(m.channel) === viewer)
  }

  // ========== 加载与写盘 ==========

  private channel(name = CHAT_CHANNEL): Channel {
    if (!CHANNEL_RE.test(name)) throw new ToolError('INVALID_ARGS', `频道 ${name} 不合法`)
    if (THREAD_RE.test(name) && !this.threadData().threads[name]) throw new ToolError('NOT_FOUND', '这个会话不存在，可能已被删除')
    let ch = this.channels.get(name)
    if (!ch) {
      ch = this.load(name)
      this.channels.set(name, ch)
    }
    return ch
  }

  private load(name: string): Channel {
    const file = path.join(this.opts.dir, `${channelFileBase(name)}.jsonl`)
    const ch: Channel = { name, file, messages: [], lastSeq: 0, lastTs: 0, pending: [], dirty: false, archivedThrough: 0 }
    let raw = ''
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[chat] 读取 ${file} 失败：${(e as Error).message}`)
    }
    let bad = 0
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const m = JSON.parse(line) as GroupMessage
        // 归档重写失败时可能留下重复行：seq 不递增的跳过
        if (typeof m.seq !== 'number' || m.seq <= ch.lastSeq) continue
        ch.messages.push(m)
        ch.lastSeq = m.seq
        ch.lastTs = Math.max(ch.lastTs, m.ts)
      } catch {
        bad++
      }
    }
    if (bad) console.warn(`[chat] ${file} 里有 ${bad} 行解析失败，已跳过`)
    // 文件末尾不是换行（上次写到一半）：下次追加前先补换行
    ch.dirty = raw.length > 0 && !raw.endsWith('\n')
    // 主文件被清空过：seq 接着归档往下排
    if (!ch.messages.length) ch.lastSeq = Math.max(this.archivedMaxSeq(name), this.threadData().floors[name] ?? 0)
    ch.archivedThrough = ch.messages.length ? ch.messages[0].seq - 1 : ch.lastSeq
    return ch
  }

  private archiveDir(): string {
    return path.join(this.opts.dir, 'archive')
  }

  private archivedMaxSeq(name: string): number {
    let max = 0
    const base = channelFileBase(name)
    try {
      for (const f of fs.readdirSync(this.archiveDir())) {
        // 工作区 id 里可能有 -，按「前缀-8 位日期.jsonl」精确匹配
        if (!f.startsWith(`${base}-`) || !/^\d{8}\.jsonl$/.test(f.slice(base.length + 1))) continue
        for (const line of fs.readFileSync(path.join(this.archiveDir(), f), 'utf8').split('\n')) {
          try {
            if (line.trim()) max = Math.max(max, (JSON.parse(line) as GroupMessage).seq || 0)
          } catch {
            // 跳过坏行
          }
        }
      }
    } catch {
      // 没有归档目录
    }
    return max
  }

  /** 把没写进去的行追加到 jsonl；失败留着下次再写 */
  private flush(ch: Channel): void {
    if (!ch.pending.length) return
    const text = (ch.dirty ? '\n' : '') + ch.pending.join('')
    try {
      fs.appendFileSync(ch.file, text, 'utf8')
      ch.pending = []
      ch.dirty = false
    } catch (e) {
      // 可能写了一半：下次先补换行，加载时按 seq 去重
      ch.dirty = true
      console.warn(`[chat] 写入 ${ch.file} 失败，消息先留在内存里：${(e as Error).message}`)
    }
  }

  /** 超过上限时把最旧的一半挪进 archive/<频道>-<日期>.jsonl，主文件只留新的一半 */
  private maybeArchive(ch: Channel): void {
    if (ch.messages.length <= this.max) return
    const cut = Math.floor(ch.messages.length / 2)
    const old = ch.messages.slice(0, cut)
    const keep = ch.messages.slice(cut)
    try {
      const toArchive = old.filter((m) => m.seq > ch.archivedThrough)
      if (toArchive.length) {
        fs.mkdirSync(this.archiveDir(), { recursive: true })
        const d = new Date(this.now())
        const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
        fs.appendFileSync(path.join(this.archiveDir(), `${channelFileBase(ch.name)}-${day}.jsonl`), toArchive.map((m) => JSON.stringify(m) + '\n').join(''), 'utf8')
        ch.archivedThrough = old[old.length - 1].seq
      }
      const tmp = `${ch.file}.tmp`
      fs.writeFileSync(tmp, keep.map((m) => JSON.stringify(m) + '\n').join(''), 'utf8')
      fs.renameSync(tmp, ch.file)
      // 重写后的主文件已经包含了还没写进去的行
      ch.messages = keep
      ch.pending = []
      ch.dirty = false
    } catch (e) {
      console.warn(`[chat] 归档 ${ch.name} 失败，下次再试：${(e as Error).message}`)
    }
  }

  // ========== 发送 ==========

  /** 私聊对象：成员名字或 id（不区分大小写、忽略空格），或 user / 用户 / 我 / 你；找不到返回 undefined */
  resolveMember(key: string): string | undefined {
    const k = norm(key.replace(/^[@＠]/, ''))
    if (!k) return undefined
    if (USER_ALIASES.includes(k)) return CHAT_USER
    const ms = this.opts.members()
    return (ms.find((m) => m.id.toLowerCase() === k) ?? ms.find((m) => norm(m.name) === k))?.id
  }

  /**
   * 找被引用的消息：ref 是消息 id，或这个频道里的序号（数字、'12'、'#12'；消息 id 都是 m_ 开头，不会和序号混）。
   * 不存在、已经归档、或者 viewer 看不到（别人的私聊）都报 NOT_FOUND
   */
  private resolveReply(ch: Channel, ref: string | number, viewer: string): GroupMessage {
    const raw = String(ref).trim()
    const bySeq = /^[#＃]?(\d{1,15})$/.exec(raw)
    const seq = bySeq ? Number(bySeq[1]) : undefined
    const r = seq !== undefined ? ch.messages.find((m) => m.seq === seq) : ch.messages.find((m) => m.id === raw)
    if (!r || !this.visible(r, viewer)) {
      throw new ToolError(
        'NOT_FOUND',
        seq !== undefined
          ? `引用的消息（序号 ${seq}）在这个频道里不存在或你看不到；序号是频道内的，要和消息在同一个频道，太早的消息归档后不能引用`
          : `引用的消息 ${raw} 不存在或你看不到`
      )
    }
    return r
  }

  send(from: ChatSender, input: ChatSendInput, channel = CHAT_CHANNEL): GroupMessage {
    const text = String(input.text ?? '').trim()
    // 图片附件一律过图片存储核对（存过才算，元信息以磁盘上的为准），调用方给的元信息不直接进消息
    const rawAtt: unknown = input.attachments
    const hasAtt = Array.isArray(rawAtt) ? rawAtt.length > 0 : rawAtt !== undefined && rawAtt !== null
    const resolver = this.opts.attachments
    if (hasAtt && !resolver) throw new ToolError('INVALID_ARGS', '这里发不了图片（没有接图片存储）')
    const attachments = hasAtt && resolver ? resolver.resolve(rawAtt) : []
    if (!text && !attachments.length) throw new ToolError('INVALID_ARGS', 'text 不能为空')
    if (text.length > MAX_CHAT_CHARS) throw new ToolError('TOO_LARGE', `一条消息不能超过 ${MAX_CHAT_CHARS} 字，请拆开发`)
    const ch = this.channel(channel)
    if (this.thread(ch.name)?.archived) throw new ToolError('INVALID_ARGS', '这个会话已归档，不能再发言；要继续用先让用户恢复它')
    let to: string | undefined
    if (input.to !== undefined && String(input.to).trim()) {
      to = this.resolveMember(String(input.to))
      if (!to) throw new ToolError('NOT_FOUND', `找不到成员「${input.to}」，用 team_list 看成员名字`)
      if (to === from.id) throw new ToolError('INVALID_ARGS', '不能私聊自己')
      // 私聊不分频道，都在大厅
      if (ch.name !== CHAT_CHANNEL) throw new ToolError('INVALID_ARGS', '私聊只能发在大厅（channel=general），不要同时指定工作区频道')
    }
    const reply = input.replyTo !== undefined && input.replyTo !== null && input.replyTo !== '' ? this.resolveReply(ch, input.replyTo, from.id) : undefined
    const receipt = input.receipt === true
    if (receipt && attachments.length) throw new ToolError('INVALID_ARGS', '回执不能带图片；要发图就发普通消息，不带 receipt')
    if (receipt && text.length > CHAT_RECEIPT_CHARS) {
      throw new ToolError('TOO_LARGE', `回执最多 ${CHAT_RECEIPT_CHARS} 字（现在 ${text.length} 字）；要说的多就发普通消息，不带 receipt`)
    }
    const members = this.opts.members()
    let mentions = [...new Set([...parseMentions(text, members), ...(input.extraMentions ?? []).filter((id) => members.some((m) => m.id === id))])]
    if (receipt) {
      // 回执只送给点名到的人：群发的 @ 不算数；它回复的那条消息的作者算点名到
      mentions = mentions.filter((id) => id !== CHAT_EVERYONE)
      if (reply && reply.from.id !== from.id && !mentions.includes(reply.from.id)) mentions.push(reply.from.id)
      if (!to && !mentions.length) {
        throw new ToolError('INVALID_ARGS', 'receipt=true 的消息要有收的人：带 reply_to（回给那条消息的作者），或在正文里 @ 一个成员，或用 to 私聊；不然谁也收不到')
      }
    }
    // 分工明确：定下这条消息谁能看到
    const leadId = this.lead(ch.name)
    let audience: string[] | undefined
    if (leadId) {
      const leadName = members.find((m) => m.id === leadId)?.name ?? leadId
      // 用户选过子代理：只有主脑和选中的算这次分工的人；没选过就是主脑以外都算
      const picked = this.subs(ch.name)
      const inTeam = (id: string): boolean => id === leadId || !picked || picked.includes(id)
      const isUser = from.kind === 'user'
      const isLead = !isUser && from.id === leadId
      const outsider = !isUser && !inTeam(from.id)
      if (to) {
        // 私聊（只在大厅）：子代理只能找主脑或用户；主脑只能找子代理或用户；没选进分工的只能找用户
        if (outsider && to !== CHAT_USER) {
          throw new ToolError('FORBIDDEN', `这个频道现在是「分工明确」，这次分工没有选你（主脑是 ${leadName}）：你在这里只能找用户（to=user）`)
        }
        if (isLead && to !== CHAT_USER && !inTeam(to)) {
          const toName = members.find((m) => m.id === to)?.name ?? to
          throw new ToolError('FORBIDDEN', `${toName} 不在这个频道的子代理名单里，不能私聊它。要找它，请用户把它加进子代理`)
        }
        if (!isUser && !isLead && !outsider && to !== leadId && to !== CHAT_USER) {
          throw new ToolError('FORBIDDEN', `这个频道现在是「分工明确」：你只和主脑 ${leadName} 联系，不能私聊别的成员。有事发给 ${leadName}（to=${leadName}，或直接在频道里发）`)
        }
      } else if (isUser || isLead) {
        // 主脑 @ 不到没选进分工的成员（点名去掉）；用户点名谁都送到
        if (isLead && picked) mentions = mentions.filter((id) => id === CHAT_USER || id === CHAT_EVERYONE || inTeam(id))
        if (mentions.includes(CHAT_EVERYONE)) {
          // @所有人：这次分工的全员。没选过子代理就是频道里所有人（不记 audience），选过就只到主脑和子代理
          if (picked) audience = [leadId, ...picked]
        } else {
          // @谁就只送给谁；谁都不 @ 的只有主脑和用户看到。
          // 用户谁都不 @：就是说给主脑的，算点名给它（通知带全文，等「点名给我的」也等得到）
          if (isUser && !mentions.some((id) => id !== CHAT_USER)) mentions.push(leadId)
          audience = [...new Set([leadId, ...mentions.filter((id) => id !== CHAT_USER)])]
        }
      } else if (outsider) {
        // 没选进分工的成员：只有用户看得到（audience 是空的，主脑也不收）。@成员、@所有人 不算数
        mentions = mentions.filter((id) => id === CHAT_USER)
        audience = []
      } else {
        // 子代理：只送给主脑（用户总能看到）。@别的成员、@所有人 不算数；主脑算被点名，好让它及时看到
        mentions = mentions.filter((id) => id === leadId || id === CHAT_USER)
        if (!mentions.includes(leadId)) mentions.push(leadId)
        audience = [leadId]
      }
    } else if (!to && from.kind !== 'user') {
      // 灵感激荡、用户挑了参与的 AI：参与的人 @ 不到外面的成员；外面的成员发的只有用户看到。用户点名谁都送到
      const team = this.participants(ch.name)
      if (team) {
        if (team.includes(from.id)) mentions = mentions.filter((id) => id === CHAT_USER || id === CHAT_EVERYONE || team.includes(id))
        else {
          mentions = mentions.filter((id) => id === CHAT_USER)
          audience = []
        }
      }
    }
    const via = typeof from.via === 'string' && CHAT_READER_RE.test(from.via) ? from.via : undefined
    const now = this.now()
    if (from.kind === 'agent') {
      const recent = (this.sent.get(from.id) ?? []).filter((t) => now - t < this.rateWindow)
      if (recent.length >= this.rateLimit) {
        this.sent.set(from.id, recent)
        throw new ToolError('RATE_LIMITED', `每分钟最多发 ${this.rateLimit} 条群聊消息，稍后再发`)
      }
      recent.push(now)
      this.sent.set(from.id, recent)
    }
    // 时间戳在频道内严格递增，id 按时间排序也就按 seq 排序
    const ts = Math.max(now, ch.lastTs + 1)
    const msg: GroupMessage = {
      id: `m_${ts.toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      seq: ch.lastSeq + 1,
      channel: ch.name,
      ts,
      from: { kind: from.kind, id: from.id, name: from.name, ...(from.color ? { color: from.color } : {}), ...(via ? { via } : {}) },
      ...(to ? { to } : {}),
      text,
      mentions,
      ...(attachments.length ? { attachments } : {}),
      ...(receipt ? { kind: 'receipt' as const } : {}),
      ...(audience ? { audience } : {}),
      ...(reply ? { replyTo: reply.id } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {})
    }
    ch.messages.push(msg)
    ch.lastSeq = msg.seq
    ch.lastTs = ts
    ch.pending.push(JSON.stringify(msg) + '\n')
    this.flush(ch)
    this.maybeArchive(ch)
    try {
      this.opts.onChange?.(msg)
    } catch (e) {
      console.warn(`[chat] 通知新消息失败：${(e as Error).message}`)
    }
    this.wake(ch, msg)
    return msg
  }

  // ========== 读取 ==========

  lastSeq(channel = CHAT_CHANNEL): number {
    return this.channel(channel).lastSeq
  }

  /** 频道最后一条消息的时间；没有消息时为 0 */
  lastTs(channel = CHAT_CHANNEL): number {
    const ch = this.channel(channel)
    return ch.messages.length ? ch.messages[ch.messages.length - 1].ts : 0
  }

  /** 按 id 找消息（只找内存里的，不找归档） */
  find(channel: string, id: string): GroupMessage | undefined {
    return this.channel(channel).messages.find((m) => m.id === id)
  }

  /** 按 seq 升序。只给 before 或都不给时取最新的 limit 条；给了 after 时取它之后最早的 limit 条 */
  list(opts: ChatListOptions): GroupMessage[] {
    const ch = this.channel(opts.channel)
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500))
    const words = opts.query?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? []
    const hit = ch.messages.filter(
      (m) =>
        (opts.after === undefined || m.seq > opts.after) &&
        (opts.before === undefined || m.seq < opts.before) &&
        this.visible(m, opts.viewer) &&
        (!words.length || words.every((w) => `${m.text}\n${m.from.name}`.toLowerCase().includes(w)))
    )
    return opts.after !== undefined ? hit.slice(0, limit) : hit.slice(-limit)
  }

  /** memberId 可以是读者键（chatReaderKey）：副连接的已读位置取它自己的和主连接的较大者 */
  cursor(memberId: string, channel = CHAT_CHANNEL): number {
    const w = who(memberId)
    const data = this.cursors.get()
    const main = data[w.id]?.[channel] ?? 0
    return w.reader === undefined ? main : Math.max(main, data[w.key]?.[channel] ?? 0)
  }

  /** 已读位置只往前走；写盘失败只记日志，内存里照样更新。副连接只动它自己的那份 */
  markRead(memberId: string, seq: number, channel = CHAT_CHANNEL): void {
    const ch = this.channel(channel)
    const next = Math.min(Math.floor(Number(seq) || 0), ch.lastSeq)
    if (next <= this.cursor(memberId, channel)) return
    const key = who(memberId).key
    const data = this.cursors.get()
    const updated = { ...data, [key]: { ...data[key], [channel]: next } }
    try {
      this.cursors.set(updated)
    } catch (e) {
      // JsonStore.set 先改内存再写盘，写失败内存里已经是新的
      console.warn(`[chat] 保存已读位置失败：${(e as Error).message}`)
    }
  }

  /** 这个成员已读位置之后、别人发的、它能看到的消息条数；mentions 是其中点名给它的 */
  unread(memberId: string, channel = CHAT_CHANNEL): { unread: number; mentions: number } {
    const w = who(memberId)
    const ch = this.channel(channel)
    const cur = this.cursor(memberId, channel)
    let unread = 0
    let mentions = 0
    for (let i = ch.messages.length - 1; i >= 0 && ch.messages[i].seq > cur; i--) {
      const m = ch.messages[i]
      if (isOwn(m, w) || !this.visible(m, w.id) || !chatDelivers(m, w.id)) continue
      unread++
      if (chatMentions(m, w.id)) mentions++
    }
    return { unread, mentions }
  }

  /** 新消息：别人发的、它能看到的、要送给它的（不是给别人的回执）；mentionsOnly 时只要点名给它的 */
  private fresh(ch: Channel, w: Who, after: number, mentionsOnly: boolean): GroupMessage[] {
    const out: GroupMessage[] = []
    for (let i = ch.messages.length - 1; i >= 0 && ch.messages[i].seq > after; i--) {
      const m = ch.messages[i]
      if (isOwn(m, w) || !this.visible(m, w.id) || !chatDelivers(m, w.id)) continue
      if (mentionsOnly && !chatMentions(m, w.id)) continue
      out.push(m)
    }
    return out.reverse()
  }

  /**
   * 确认收到：ack 是上次结果里的 next_ack（{ 频道: 序号, _notices: 通知编号 }），把已读位置推到那里。
   * 只进不退；超过频道最新序号的按最新算；不在 channels 里的频道忽略（不给 channels 时只认已有的频道）。
   * 返回实际生效后的位置。格式不对报 INVALID_ARGS
   */
  ack(memberId: string, ack: unknown, opts: { channels?: string[] } = {}): Record<string, number> {
    if (ack === undefined || ack === null) return {}
    if (typeof ack !== 'object' || Array.isArray(ack)) {
      throw new ToolError('INVALID_ARGS', 'ack 要原样传回上次结果里的 next_ack（形如 {"general": 12}）')
    }
    const w = who(memberId)
    const out: Record<string, number> = {}
    for (const [name, v] of Object.entries(ack as Record<string, unknown>)) {
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
        throw new ToolError('INVALID_ARGS', `ack 里 ${name} 的值要是不小于 0 的整数；请原样传回上次结果里的 next_ack`)
      }
      if (name === CHAT_NOTICE_ACK_KEY) {
        // 通知只有主连接带，副连接的 ack 里出现也不理
        if (w.reader === undefined && v > 0) this.opts.notices?.ack(w.id, v)
        continue
      }
      if (!CHANNEL_RE.test(name)) continue
      if (opts.channels ? !opts.channels.includes(name) : !this.channels.has(name)) continue
      this.markRead(memberId, v, name)
      out[name] = this.cursor(memberId, name)
    }
    return out
  }

  /**
   * chat_read / chat_wait 的结果。不给 after / before 时从已读位置往后读。
   * mark_read 默认 true：读到哪儿记到哪儿（只往前走）；带 query 或 before 时不改已读位置（结果不连续）
   */
  /** 几个频道的未读数之和 */
  unreadAll(memberId: string, channels: string[]): { unread: number; mentions: number } {
    let unread = 0
    let mentions = 0
    for (const c of channels) {
      const u = this.unread(memberId, c)
      unread += u.unread
      mentions += u.mentions
    }
    return { unread, mentions }
  }

  /**
   * chat_read / chat_wait 的结果，可以跨多个频道（按时间合并）。
   * - 不给 after / before / query：从各频道的已读位置往后，取最早的 limit 条，并标记已读
   * - 给 after（只能单个频道）：从它往后取，并标记已读
   * - 给 before 或 query：取最新的 limit 条，不改已读位置（结果不连续）
   * mark_read=false 时都不标记
   * - confirm=true：也不标记，结果里带 next_ack；下次调用把它放进 ack 才算读过（见 ChatReadOptions）
   * memberId 可以是读者键（chatReaderKey）
   */
  read(memberId: string, opts: ChatReadOptions = {}): ChatReadResult {
    const w = who(memberId)
    const names = [...new Set(opts.channels?.length ? opts.channels : [CHAT_CHANNEL])]
    const chs = names.map((n) => this.channel(n))
    if ((opts.after !== undefined || opts.before !== undefined) && chs.length !== 1) {
      throw new ToolError('INVALID_ARGS', 'after / before 是频道内的 seq，要同时指定 channel')
    }
    if (opts.ack !== undefined) this.ack(memberId, opts.ack, { channels: opts.ackChannels ?? names })
    const limit = Math.max(1, Math.min(opts.limit ?? 30, 100))
    const from = opts.from?.length ? new Set(opts.from) : undefined
    const forward = opts.before === undefined && !opts.query && !from
    const words = opts.query?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? []
    const candidates: GroupMessage[] = []
    for (const ch of chs) {
      const after = opts.after ?? (forward ? this.cursor(memberId, ch.name) : 0)
      for (const m of ch.messages) {
        if (m.seq <= after || (opts.before !== undefined && m.seq >= opts.before)) continue
        if (!this.visible(m, w.id)) continue
        // 从已读位置往后读时不带自己发的；翻历史、搜索时带上
        if (forward && opts.after === undefined && isOwn(m, w)) continue
        if (opts.mentionsOnly && (isOwn(m, w) || !chatMentions(m, w.id))) continue
        if (from && !from.has(m.from.id)) continue
        if (words.length && !words.every((w) => `${m.text}\n${m.from.name}`.toLowerCase().includes(w))) continue
        candidates.push(m)
      }
    }
    candidates.sort((a, b) => a.ts - b.ts || (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : a.seq - b.seq))
    const messages = forward ? candidates.slice(0, limit) : candidates.slice(-limit)
    const confirm = opts.confirm === true
    let nextAck: Record<string, number> | undefined
    if (confirm) nextAck = {}
    if ((opts.markRead !== false || confirm) && forward) {
      // 没取满说明各频道都读到了最新：连看不到的私聊、自己发的一起越过去；mentionsOnly 只记到读过的那条
      const exhausted = candidates.length <= limit && !opts.mentionsOnly
      for (const ch of chs) {
        const mine = messages.filter((m) => m.channel === ch.name)
        const to = exhausted ? ch.lastSeq : mine.length ? mine[mine.length - 1].seq : 0
        if (!to) continue
        if (!nextAck) this.markRead(memberId, to, ch.name)
        else if (to > this.cursor(memberId, ch.name)) nextAck[ch.name] = to
      }
    }
    if (nextAck && w.reader === undefined && this.opts.notices) {
      // 这次结果带出去的任务通知先留着，等 ack 里的 _notices 到了再删
      this.opts.notices.hold(w.id)
      const n = this.opts.notices.mark(w.id)
      if (n > 0) nextAck[CHAT_NOTICE_ACK_KEY] = n
    }
    return {
      messages,
      unread_left: this.unreadAll(memberId, names).unread,
      last_seq: Object.fromEntries(chs.map((ch) => [ch.name, ch.lastSeq])),
      ...(nextAck ? { next_ack: nextAck } : {})
    }
  }

  // ========== 等待 ==========

  /** 有新消息（seq > afterSeq，别人发的、自己能看到的）、超时或 abort 时返回；已经有就立即返回。memberId 可以是读者键 */
  wait(memberId: string, opts: ChatWaitOptions): Promise<GroupMessage[]> {
    return this.waitEx(memberId, opts).then((r) => r.messages)
  }

  /** 和 wait 一样，多告诉一声是不是被任务通知叫醒的（opts.nudge=true 时才会） */
  waitEx(memberId: string, opts: ChatWaitOptions): Promise<{ messages: GroupMessage[]; nudged: boolean }> {
    const me = who(memberId)
    const names = [...new Set(opts.channels?.length ? opts.channels : [CHAT_CHANNEL])]
    if (opts.afterSeq !== undefined && names.length !== 1) throw new ToolError('INVALID_ARGS', 'afterSeq 只能和单个频道一起用')
    const after = new Map(names.map((n) => [n, opts.afterSeq ?? this.cursor(memberId, n)]))
    const mentionsOnly = !!opts.mentionsOnly
    const collect = (): GroupMessage[] =>
      names.flatMap((n) => this.fresh(this.channel(n), me, after.get(n)!, mentionsOnly)).sort((a, b) => a.ts - b.ts)
    const now = collect()
    if (now.length || opts.signal?.aborted || opts.timeoutMs <= 0) return Promise.resolve({ messages: now, nudged: false })
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = (): void => w.done([])
      const w: Waiter = {
        after,
        memberId: me.id,
        ...(me.reader !== undefined ? { reader: me.reader } : {}),
        mentionsOnly,
        nudge: opts.nudge === true,
        collect,
        done: (msgs, nudged) => {
          if (!this.waiters.delete(w)) return
          if (timer) clearTimeout(timer)
          opts.signal?.removeEventListener('abort', onAbort)
          resolve({ messages: msgs, nudged: nudged === true })
        }
      }
      this.waiters.add(w)
      timer = setTimeout(() => w.done([]), opts.timeoutMs)
      opts.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private wake(ch: Channel, msg: GroupMessage): void {
    for (const w of [...this.waiters]) {
      const after = w.after.get(ch.name)
      if (after === undefined || msg.seq <= after) continue
      if (isOwn(msg, { id: w.memberId, key: w.memberId, reader: w.reader }) || !this.visible(msg, w.memberId) || !chatDelivers(msg, w.memberId)) continue
      if (w.mentionsOnly && !chatMentions(msg, w.memberId)) continue
      w.done(w.collect())
    }
  }

  /**
   * 任务通知进了这个成员的队列：叫醒它主连接上愿意被叫醒的等待（waitEx 的 nudge=true）。
   * 副连接不带通知，不叫。返回叫醒了几个
   */
  nudge(memberId: string): number {
    let n = 0
    for (const w of [...this.waiters]) {
      if (w.memberId !== memberId || w.reader !== undefined || !w.nudge) continue
      w.done(w.collect(), true)
      n++
    }
    return n
  }

  /**
   * chat_wait 的全过程：先按 ack 确认上一批 → 有新消息、有没带走的任务通知就立即返回，否则等 →
   * 读（confirm=true 时不标已读、带 next_ack；否则读到哪儿记到哪儿）。
   * 结果送不出去时（deliverable 返回 false 或 signal 已 abort）不标已读，带 undelivered=true，调用方自己报暂停 / 吊销。
   * memberId 可以是读者键；副连接不会被任务通知叫醒
   */
  async receive(memberId: string, opts: ChatReceiveOptions): Promise<ChatReceiveResult> {
    const me = who(memberId)
    const hooks = me.reader === undefined ? this.opts.notices : undefined
    if (opts.ack !== undefined) this.ack(memberId, opts.ack, { channels: opts.ackChannels ?? opts.channels })
    let nudged = false
    if (hooks?.pending(me.id)) {
      nudged = true
    } else {
      const r = await this.waitEx(memberId, {
        channels: opts.channels,
        timeoutMs: opts.timeoutMs,
        mentionsOnly: opts.mentionsOnly,
        signal: opts.signal,
        nudge: !!hooks
      })
      nudged = r.nudged
    }
    const ok = !opts.signal?.aborted && (opts.deliverable ? opts.deliverable() : true)
    const r = this.read(memberId, {
      channels: opts.channels,
      mentionsOnly: opts.mentionsOnly,
      markRead: ok,
      confirm: ok && opts.confirm === true
    })
    if (!ok) return { ...r, undelivered: true }
    const got = r.messages.some((m) => chatDelivers(m, me.id))
    if (got) return { ...r, woken_by: 'message' }
    if (nudged) return { ...r, woken_by: 'notice' }
    return { ...r, timed_out: true }
  }

  /**
   * 正在等的调用数（测试和排查用）；给成员 id 就只数它的，判断「是不是正在等消息」用。
   * mainOnly=true 不数副连接的（成员状态里的 waiting 只看主连接）
   */
  waiting(memberId?: string, mainOnly = false): number {
    if (memberId === undefined) return this.waiters.size
    let n = 0
    for (const w of this.waiters) if (w.memberId === memberId && !(mainOnly && w.reader !== undefined)) n++
    return n
  }

  /**
   * 现存消息（没归档的）引用到的图片 id，清理没人引用的图片时用。
   * 没打开过的频道直接从它的 jsonl 里找，所以已经删掉的工作区留下的频道文件也算数：宁可多留，不误删
   */
  attachmentIds(): Set<string> {
    const out = new Set<string>()
    const add = (m: { attachments?: unknown }): void => {
      if (!Array.isArray(m.attachments)) return
      for (const a of m.attachments) {
        const id = (a as { id?: unknown } | null)?.id
        if (typeof id === 'string') out.add(id)
      }
    }
    const loaded = new Set<string>()
    for (const ch of this.channels.values()) {
      loaded.add(path.basename(ch.file))
      for (const m of ch.messages) add(m)
    }
    let files: string[] = []
    try {
      files = fs.readdirSync(this.opts.dir)
    } catch {
      // 目录还没建：没有别的频道文件
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl') || loaded.has(f)) continue
      let raw = ''
      try {
        raw = fs.readFileSync(path.join(this.opts.dir, f), 'utf8')
      } catch {
        continue
      }
      for (const line of raw.split('\n')) {
        if (!line.includes('"attachments"')) continue
        try {
          add(JSON.parse(line) as { attachments?: unknown })
        } catch {
          // 坏行跳过
        }
      }
    }
    return out
  }

  /** 结束所有等待（Bridge 停止时） */
  dispose(): void {
    for (const w of [...this.waiters]) w.done([])
    for (const ch of this.channels.values()) this.flush(ch)
  }

  /** 吊销 AI 时清掉它的已读位置和限流记录（消息保留）；它当主脑的频道改回「灵感激荡」，子代理名单里去掉它 */
  removeMember(memberId: string): void {
    const led: unknown = this.leads.get()
    if (led && typeof led === 'object' && Object.values(led as Record<string, unknown>).includes(memberId)) {
      try {
        this.leads.set(Object.fromEntries(Object.entries(led as Record<string, string>).filter(([, v]) => v !== memberId)))
      } catch (e) {
        console.warn(`[chat] 保存干活方式失败：${(e as Error).message}`)
      }
    }
    const picked: unknown = this.teams.get()
    if (picked && typeof picked === 'object') {
      const kept: Record<string, string[]> = {}
      for (const [k, v] of Object.entries(picked as Record<string, unknown>)) {
        // 各频道的名单里去掉它。它当主脑的频道已经回到灵感激荡（上面），剩下的子代理就是参与讨论的人；一个都不剩的不留
        if (!Array.isArray(v)) continue
        const list = v.filter((id): id is string => typeof id === 'string' && id !== memberId)
        if (list.length || this.lead(k)) kept[k] = list
      }
      if (JSON.stringify(kept) !== JSON.stringify(picked)) {
        try {
          this.teams.set(kept)
        } catch (e) {
          console.warn(`[chat] 保存子代理名单失败：${(e as Error).message}`)
        }
      }
    }
    this.sent.delete(memberId)
    for (const w of [...this.waiters]) if (w.memberId === memberId) w.done([])
    const data = this.cursors.get()
    // 连它副连接的已读位置（成员id#读者名）一起清
    const mine = (k: string): boolean => k === memberId || k.startsWith(`${memberId}#`)
    if (!Object.keys(data).some(mine)) return
    const rest = Object.fromEntries(Object.entries(data).filter(([k]) => !mine(k)))
    try {
      this.cursors.set(rest)
    } catch (e) {
      console.warn(`[chat] 保存已读位置失败：${(e as Error).message}`)
    }
  }
}
