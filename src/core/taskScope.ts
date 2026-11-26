// 优化第 12 条（核心部分，T-20）：任务范围提醒、命令证据、等人决定的问题。
// 这里只放数据结构和纯函数，不读写磁盘；接到 tasks.ts / types.ts / commandRunner / mcpServer 的部分按 T-20 结果里的接线需求做。
// 用户还没答复第 12 条要不要拦，范围检查默认只提醒（mode=warn），block 只是留好的开关。
import path from 'node:path'
import { globToRegExp } from './fileClaims'
import { ToolError } from './fileTools'
import { redactText } from './redact'

// ===================== 1. 任务范围（allowedPaths） =====================

/** warn：照常写，结果里加【范围提醒】（默认）；block：范围外不写（用户答复前不开）；off：不检查 */
export type ScopeMode = 'warn' | 'block' | 'off'

export const MAX_ALLOWED_PATHS = 50
const MAX_PATH_CHARS = 500
const WARN_LIST_MAX = 5

export interface ScopeOptions {
  /** 工作区根目录 */
  root: string
  /** 机器工作区（整台电脑）：路径写绝对路径 */
  machine?: boolean
  /** 默认按平台：Windows 不分大小写 */
  caseInsensitive?: boolean
}

function toSlash(p: string): string {
  return p.replace(/\\/g, '/')
}

function isAbsoluteAny(p: string): boolean {
  return /^[a-zA-Z]:\//.test(p) || p.startsWith('/')
}

function ciOf(opts: ScopeOptions): boolean {
  return opts.caseInsensitive ?? process.platform === 'win32'
}

/**
 * 路径统一成和 T-16 文件占用登记一样的形式：普通工作区是相对根目录、/ 分隔；整台电脑是绝对路径。
 * 末尾的 / 去掉；工作区根本身记成 **。越出工作区报 OUTSIDE_WORKSPACE
 */
export function normalizeScopePath(input: string, opts: ScopeOptions): string {
  const raw = toSlash(String(input ?? '').trim())
  if (!raw) throw new ToolError('INVALID_ARGS', '路径不能为空')
  let out: string
  if (opts.machine) {
    if (!isAbsoluteAny(raw)) throw new ToolError('INVALID_ARGS', `整台电脑工作区要写绝对路径：${input}`)
    out = toSlash(path.resolve(raw))
  } else {
    const abs = path.resolve(opts.root, raw)
    const rel = toSlash(path.relative(opts.root, abs))
    if (rel === '..' || rel.startsWith('../') || isAbsoluteAny(rel)) throw new ToolError('OUTSIDE_WORKSPACE', `路径越出了工作区：${input}`)
    out = rel === '' ? '**' : rel
  }
  return out.replace(/\/+$/, '') || out
}

/**
 * 校验并统一任务的 allowedPaths（glob，规则同 T-16：** 跨多级目录，* 和 ? 不跨 /，不带 glob 的路径连同下面所有文件）。
 * 不传（undefined / null）返回 undefined；空数组也返回 undefined，表示不限范围（用来清掉范围）。重复的只留一条
 */
export function normalizeAllowedPaths(list: unknown, opts: ScopeOptions): string[] | undefined {
  if (list === undefined || list === null) return undefined
  if (!Array.isArray(list)) throw new ToolError('INVALID_ARGS', 'allowedPaths 要是字符串数组')
  if (list.length > MAX_ALLOWED_PATHS) throw new ToolError('LIMIT', `allowedPaths 最多 ${MAX_ALLOWED_PATHS} 条`)
  const ci = ciOf(opts)
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') throw new ToolError('INVALID_ARGS', 'allowedPaths 的每一项都要是字符串')
    if (item.length > MAX_PATH_CHARS) throw new ToolError('INVALID_ARGS', `allowedPaths 单条不能超过 ${MAX_PATH_CHARS} 字`)
    const n = normalizeScopePath(item, opts)
    const k = ci ? n.toLowerCase() : n
    if (seen.has(k)) continue
    seen.add(k)
    out.push(n)
  }
  return out.length ? out : undefined
}

/** 范围检查只用到任务的这几个字段（TaskItem 加上 allowedPaths 后直接传进来） */
export interface ScopeTask {
  id: string
  ref: string
  status: string
  assigneeId?: string
  allowedPaths?: string[]
}

/**
 * 找这次写入属于哪个任务：显式带了 task（id 或 T-12 这样的编号）就用它，找不到报 NOT_FOUND；
 * 没带时，调用者手上恰好一个 in_progress 任务才算，零个或多个都返回 null（不检查）
 */
export function resolveScopeTask<T extends ScopeTask>(tasks: readonly T[], agentId: string, explicit?: string | null): T | null {
  if (explicit !== undefined && explicit !== null && String(explicit).trim()) {
    const k = String(explicit).trim()
    const t = tasks.find((x) => x.id === k || x.ref.toLowerCase() === k.toLowerCase())
    if (!t) throw new ToolError('NOT_FOUND', `任务 ${k} 不存在`)
    return t
  }
  const mine = tasks.filter((t) => t.status === 'in_progress' && t.assigneeId === agentId)
  return mine.length === 1 ? mine[0] : null
}

export interface ScopeCheck {
  /** 按哪个任务检查的（编号）；没确定任务为 null */
  task: string | null
  /** 是否真的做了检查（off、没确定任务、任务没设 allowedPaths 时为 false） */
  checked: boolean
  /** 不在范围内的路径（统一后的形式，越出工作区的保留原样） */
  outside: string[]
  /** 只有 block 模式且有范围外的路径时为 true */
  blocked: boolean
  /** 放进写文件结果的【范围提醒】文本块；没有范围外的路径为 null */
  text: string | null
}

function listShort(items: readonly string[]): string {
  const head = items.slice(0, WARN_LIST_MAX).join('、')
  return items.length > WARN_LIST_MAX ? `${head} 等 ${items.length} 个` : head
}

/** 写文件结果里的【范围提醒】文本 */
export function formatScopeWarning(taskRef: string, outside: readonly string[], allowed: readonly string[], blocked = false): string {
  const tail = blocked
    ? '这次没有写入；确实要改，请先让派活的人把路径加进任务范围。'
    : '这次写入照常完成；如果是任务需要，请在交付里说明，或让派活的人把路径加进任务范围。'
  return `【范围提醒】${listShort(outside)} 不在 ${taskRef} 允许改的范围内（${listShort(allowed)}），${tail}`
}

/** 检查这次要写的路径是否都在任务范围内。只算，不写盘 */
export function checkTaskScope(task: ScopeTask | null, paths: readonly string[], opts: ScopeOptions & { mode?: ScopeMode }): ScopeCheck {
  const mode = opts.mode ?? 'warn'
  const allowed = task?.allowedPaths ?? []
  if (mode === 'off' || !task || allowed.length === 0) {
    return { task: task?.ref ?? null, checked: false, outside: [], blocked: false, text: null }
  }
  const ci = ciOf(opts)
  const res = allowed.map((p) => globToRegExp(p, ci))
  const outside: string[] = []
  const seen = new Set<string>()
  const push = (p: string) => {
    const k = ci ? p.toLowerCase() : p
    if (!seen.has(k)) {
      seen.add(k)
      outside.push(p)
    }
  }
  for (const raw of paths) {
    let p: string
    try {
      p = normalizeScopePath(raw, opts)
    } catch {
      // 越出工作区、整台电脑下写了相对路径：确定不在范围内
      push(toSlash(String(raw ?? '').trim()))
      continue
    }
    if (!res.some((r) => r.test(p))) push(p)
  }
  const blocked = mode === 'block' && outside.length > 0
  return { task: task.ref, checked: true, outside, blocked, text: outside.length ? formatScopeWarning(task.ref, outside, allowed, blocked) : null }
}

// ===================== 2. 命令证据 =====================

/** 一条命令记录（由 commandRunner 提供，字段缺的就不显示） */
export interface CommandRecord {
  /** 一整行命令，或 argv */
  command: string | readonly string[]
  cwd?: string
  exitCode: number | null
  timedOut?: boolean
  cancelled?: boolean
  startedAt: number
  endedAt?: number
  durationMs?: number
  /** 合并后的输出；没有时用 stdout + stderr */
  output?: string
  stdout?: string
  stderr?: string
}

export interface EvidenceOptions {
  /** 整段证据最多多少字，默认 4000，范围 600–20000 */
  maxChars?: number
  /** 每条命令最多留多少字输出结尾，默认 1500 */
  tailChars?: number
  /** 最多列几条（取最近的），默认 8，最多 30 */
  maxCommands?: number
  /** 已知令牌原值，一起换成 [REDACTED] */
  secrets?: readonly string[]
}

export const EVIDENCE_DEFAULT_CHARS = 4000
export const EVIDENCE_MIN_CHARS = 600
export const EVIDENCE_MAX_CHARS = 20000
const EVIDENCE_DEFAULT_TAIL = 1500
const EVIDENCE_DEFAULT_COMMANDS = 8
const EVIDENCE_MAX_COMMANDS = 30
const MAX_COMMAND_CHARS = 300
const MIN_USEFUL_TAIL = 120

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def
  return Math.min(max, Math.max(min, n))
}

function hhmmss(ts: number): string {
  const d = new Date(ts)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
}

function fmtDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null
  return ms < 1000 ? `${Math.round(ms)} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`
}

function quoteArg(a: string): string {
  return a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g

/** 去掉颜色码；进度条那种 \r 覆盖的只留每行最后一段 */
function cleanOutput(s: string): string {
  return s
    .replace(ANSI_RE, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1))
    .join('\n')
    .trimEnd()
}

function tailOf(s: string, limit: number): string {
  if (s.length <= limit) return s
  let cut = s.slice(s.length - limit)
  const nl = cut.indexOf('\n')
  // 尽量从整行开始，别让第一行只剩半截
  if (nl >= 0 && nl < limit / 3) cut = cut.slice(nl + 1)
  return `…（前面省略 ${s.length - cut.length} 字）\n${cut}`
}

function fenceFor(content: string): string {
  let longest = 0
  for (const m of content.matchAll(/`+/g)) longest = Math.max(longest, m[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

interface PreparedRecord {
  head: string
  output: string
}

function prepare(r: CommandRecord, secrets: readonly string[]): PreparedRecord {
  const cmdRaw = typeof r.command === 'string' ? r.command : (r.command as readonly string[]).map((a) => quoteArg(String(a))).join(' ')
  let cmd = redactText(cmdRaw, secrets).replace(/\s*[\r\n]+\s*/g, ' ⏎ ').trim()
  if (cmd.length > MAX_COMMAND_CHARS) cmd = `${cmd.slice(0, MAX_COMMAND_CHARS)}…`
  const tick = cmd.includes('`') ? '``' : '`'
  const status = r.timedOut ? '超时被结束' : r.cancelled ? '已取消' : r.exitCode === null || r.exitCode === undefined ? '没有退出码' : `退出码 ${r.exitCode}`
  const dur = fmtDuration(r.durationMs ?? (r.endedAt !== undefined ? r.endedAt - r.startedAt : undefined))
  const meta = [status, dur, Number.isFinite(r.startedAt) ? hhmmss(r.startedAt) : null, r.cwd ? `在 ${redactText(r.cwd, secrets)}` : null].filter(Boolean).join('，')
  const rawOut = r.output ?? [r.stdout ?? '', r.stderr ? `[stderr]\n${r.stderr}` : ''].filter(Boolean).join('\n')
  return { head: `${tick}${tick.length > 1 ? ' ' : ''}${cmd}${tick.length > 1 ? ' ' : ''}${tick}（${meta}）`, output: redactText(cleanOutput(String(rawOut)), secrets) }
}

function renderEvidence(items: readonly PreparedRecord[], total: number, tail: number): string {
  const omitted = total - items.length
  const header = `【命令证据】共 ${total} 条命令${omitted > 0 ? `，只列最近 ${items.length} 条` : ''}；下面是真实输出的结尾部分，已脱敏`
  const parts = items.map((it, i) => {
    const n = omitted + i + 1
    if (!it.output) return `${n}. ${it.head}\n（没有输出）`
    const body = tail > 0 ? tailOf(it.output, tail) : `…（输出 ${it.output.length} 字，篇幅不够没列）`
    const fence = fenceFor(body)
    return `${n}. ${it.head}\n${fence}\n${body}\n${fence}`
  })
  return [header, ...parts].join('\n')
}

/**
 * 把 run_command 的命令记录整理成能附在任务 result 后面的「命令证据」：每条写命令、退出码、用时、开始时间、输出结尾。
 * 命令和输出都过一遍 redactText（Bearer、/mcp/<令牌>、token=xxx 和传进来的已知令牌）。
 * 总字数超过 maxChars 时先压每条的输出，还不够就从最早的命令开始省略。没有记录返回空串
 */
export function formatCommandEvidence(records: readonly CommandRecord[], opts: EvidenceOptions = {}): string {
  if (!records || records.length === 0) return ''
  const maxChars = clampInt(opts.maxChars, EVIDENCE_DEFAULT_CHARS, EVIDENCE_MIN_CHARS, EVIDENCE_MAX_CHARS)
  const maxCommands = clampInt(opts.maxCommands, EVIDENCE_DEFAULT_COMMANDS, 1, EVIDENCE_MAX_COMMANDS)
  const tailWanted = clampInt(opts.tailChars, EVIDENCE_DEFAULT_TAIL, 0, EVIDENCE_MAX_CHARS)
  const secrets = opts.secrets ?? []
  let items = records.slice(-maxCommands).map((r) => prepare(r, secrets))
  const total = records.length

  for (;;) {
    let text = renderEvidence(items, total, tailWanted)
    if (text.length <= maxChars) return text
    // 按剩下的篇幅平均分给每条的输出（每条另留 60 字给省略说明和代码块围栏）
    const fixed = renderEvidence(items, total, 0).length
    const withOutput = items.filter((it) => it.output).length || 1
    const per = Math.floor((maxChars - fixed) / withOutput) - 60
    if (per >= MIN_USEFUL_TAIL || items.length === 1) {
      text = renderEvidence(items, total, Math.max(0, Math.min(tailWanted, per)))
      if (text.length <= maxChars) return text
      if (items.length === 1) return `${text.slice(0, maxChars - 12)}\n…（已截断）`
    }
    items = items.slice(1)
  }
}

// ===================== 3. 等人决定的问题 =====================

export type QuestionStatus = 'open' | 'answered' | 'closed'

export interface TaskQuestion {
  /** 任务内的编号：q1、q2…，不复用 */
  id: string
  text: string
  /** 可选的备选答案；回答时不限于这几个 */
  options?: string[]
  askedBy: string
  askedByName: string
  askedAt: number
  status: QuestionStatus
  answer?: string
  answeredBy?: string
  answeredByName?: string
  answeredAt?: number
  closedBy?: string
  closedByName?: string
  closedAt?: number
  closeNote?: string
}

/** 谁在操作；用户的 id 是 'user' */
export interface QuestionActor {
  id: string
  name: string
}

/** 判断谁能回答只用到任务的这两个字段 */
export interface QuestionTaskInfo {
  createdBy: string
  managedBy?: string
}

export const QUESTION_USER_ID = 'user'
export const MAX_QUESTIONS_PER_TASK = 50
export const MAX_OPEN_QUESTIONS = 10
const MAX_QUESTION_CHARS = 2000
const MAX_ANSWER_CHARS = 2000
const MAX_OPTIONS = 10
const MAX_OPTION_CHARS = 200
const MAX_NOTE_CHARS = 500

function requireText(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new ToolError('INVALID_ARGS', `${what}不能为空`)
  const s = v.trim()
  if (s.length > max) throw new ToolError('INVALID_ARGS', `${what}不能超过 ${max} 字`)
  return s
}

function findQuestion(list: readonly TaskQuestion[], id: unknown): number {
  const i = list.findIndex((q) => q.id === id)
  if (i < 0) throw new ToolError('NOT_FOUND', `问题 ${String(id).slice(0, 40)} 不存在`)
  return i
}

/** 能回答（拍板）的人：用户、任务创建者、派活的人 */
export function canAnswerQuestion(task: QuestionTaskInfo, actorId: string): boolean {
  return actorId === QUESTION_USER_ID || actorId === task.createdBy || (!!task.managedBy && actorId === task.managedBy)
}

/** 新增一个问题，返回新列表（不改原数组）和这个问题。谁能提问由调用方决定（一般是执行者） */
export function addQuestion(
  list: readonly TaskQuestion[] | undefined,
  actor: QuestionActor,
  input: { text: unknown; options?: unknown },
  now = Date.now()
): { questions: TaskQuestion[]; question: TaskQuestion } {
  const cur = list ?? []
  const text = requireText(input.text, '问题', MAX_QUESTION_CHARS)
  let options: string[] | undefined
  if (input.options !== undefined && input.options !== null) {
    if (!Array.isArray(input.options)) throw new ToolError('INVALID_ARGS', 'options 要是字符串数组')
    if (input.options.length > MAX_OPTIONS) throw new ToolError('INVALID_ARGS', `备选答案最多 ${MAX_OPTIONS} 个`)
    options = [...new Set(input.options.map((o) => requireText(o, '备选答案', MAX_OPTION_CHARS)))]
    if (!options.length) options = undefined
  }
  if (cur.length >= MAX_QUESTIONS_PER_TASK) throw new ToolError('LIMIT', `一个任务最多 ${MAX_QUESTIONS_PER_TASK} 个问题`)
  if (cur.filter((q) => q.status === 'open').length >= MAX_OPEN_QUESTIONS) {
    throw new ToolError('LIMIT', `没答的问题已经有 ${MAX_OPEN_QUESTIONS} 个，先等回答或关掉一些`)
  }
  const next = cur.reduce((m, q) => Math.max(m, Number(/^q(\d+)$/.exec(q.id)?.[1] ?? 0)), 0) + 1
  const question: TaskQuestion = { id: `q${next}`, text, ...(options ? { options } : {}), askedBy: actor.id, askedByName: actor.name, askedAt: now, status: 'open' }
  return { questions: [...cur, question], question }
}

/** 回答一个问题：只有用户、创建者、派活的人能答；已关闭的不能答；已答过的可以改答案（以最后一次为准） */
export function answerQuestion(
  list: readonly TaskQuestion[] | undefined,
  task: QuestionTaskInfo,
  actor: QuestionActor,
  id: string,
  answer: unknown,
  now = Date.now()
): { questions: TaskQuestion[]; question: TaskQuestion } {
  const cur = list ?? []
  const i = findQuestion(cur, id)
  if (!canAnswerQuestion(task, actor.id)) throw new ToolError('FORBIDDEN', '只有用户、任务创建者和派活的人能回答这个问题')
  if (cur[i].status === 'closed') throw new ToolError('INVALID_STATE', `问题 ${id} 已关闭，不能再回答`)
  const text = requireText(answer, '回答', MAX_ANSWER_CHARS)
  const question: TaskQuestion = { ...cur[i], status: 'answered', answer: text, answeredBy: actor.id, answeredByName: actor.name, answeredAt: now }
  const questions = cur.slice()
  questions[i] = question
  return { questions, question }
}

/** 关掉一个问题（不用再决定了）：提问的人和能回答的人都能关；已关闭的再关报 INVALID_STATE */
export function closeQuestion(
  list: readonly TaskQuestion[] | undefined,
  task: QuestionTaskInfo,
  actor: QuestionActor,
  id: string,
  note?: unknown,
  now = Date.now()
): { questions: TaskQuestion[]; question: TaskQuestion } {
  const cur = list ?? []
  const i = findQuestion(cur, id)
  if (actor.id !== cur[i].askedBy && !canAnswerQuestion(task, actor.id)) throw new ToolError('FORBIDDEN', '只有提问的人、用户、任务创建者和派活的人能关掉这个问题')
  if (cur[i].status === 'closed') throw new ToolError('INVALID_STATE', `问题 ${id} 已经关了`)
  const closeNote = note === undefined || note === null || (typeof note === 'string' && !note.trim()) ? undefined : requireText(note, '关闭说明', MAX_NOTE_CHARS)
  const question: TaskQuestion = { ...cur[i], status: 'closed', closedBy: actor.id, closedByName: actor.name, closedAt: now, ...(closeNote ? { closeNote } : {}) }
  const questions = cur.slice()
  questions[i] = question
  return { questions, question }
}

/** 还没答的问题 */
export function openQuestions(list: readonly TaskQuestion[] | undefined): TaskQuestion[] {
  return (list ?? []).filter((q) => q.status === 'open')
}

function hhmm(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 任务详情、开工简报里用的【待决定问题】文本：默认列没答的和已答的，includeClosed 才列已关闭的。没有可列的返回空串
 */
export function formatQuestions(list: readonly TaskQuestion[] | undefined, opts: { includeClosed?: boolean } = {}): string {
  const shown = (list ?? []).filter((q) => opts.includeClosed || q.status !== 'closed')
  if (!shown.length) return ''
  const open = shown.filter((q) => q.status === 'open').length
  const lines = shown.map((q) => {
    let s = `- ${q.id}（${q.askedByName} 问，${hhmm(q.askedAt)}）${q.text}`
    if (q.options?.length) s += `\n  备选：${q.options.join(' / ')}`
    if (q.status === 'open') s += '\n  → 等回答'
    if (q.answer !== undefined) s += `\n  → ${q.answeredByName ?? q.answeredBy} 答（${hhmm(q.answeredAt ?? 0)}）：${q.answer}`
    if (q.status === 'closed') s += `\n  → 已关闭（${q.closedByName ?? q.closedBy}，${hhmm(q.closedAt ?? 0)}）${q.closeNote ? `：${q.closeNote}` : ''}`
    return s
  })
  return `【待决定问题】${open ? `${open} 个等回答` : '都已回答'}\n${lines.join('\n')}`
}
