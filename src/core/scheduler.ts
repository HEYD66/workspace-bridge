// 定时任务：每 N 分钟 / 每天几点（可选周几）/ 一次，到点往群聊发消息、在任务板派任务，或者直接给内置 AI 发一条消息。
// 存在数据目录/schedules.json；每个任务记着所属工作区（界面按工作区分列表），到点了不管当前开着哪个工作区都会跑。时间一律按本机时区算。
// 定时器是一条 setTimeout 链：每次最多睡 30 秒，醒来看哪些任务到点了。电脑睡眠、工作台关着时错过的只补跑最近一次（标「补跑」），
// 「全部停下」时到点的不跑，记成 skipped，下次时间照常往后排
import crypto from 'node:crypto'
import { JsonStore } from './jsonStore'

export type ScheduleSpec =
  | { kind: 'every'; minutes: number }
  /** time 是本机时间 HH:mm；weekdays 是 0（周日）～6（周六），不给 = 每天 */
  | { kind: 'daily'; time: string; weekdays?: number[] }
  /** at 是 ISO 时间 */
  | { kind: 'once'; at: string }

export type ScheduleAction =
  /** 以「定时任务」的身份往群聊发消息；mention 里的 AI 会被 @ 到（收到通知，内置 AI 自动接活） */
  | { kind: 'chat'; channel: string; text: string; mention?: string[] }
  /** 在这个工作区的任务板上派一个任务 */
  | { kind: 'task'; workspaceId: string; title: string; description: string; assigneeId?: string }
  /** 直接给内置 AI 发一条消息（它要绑了模型） */
  | { kind: 'builtin'; agentId: string; prompt: string }

export interface ScheduleResult {
  status: 'ok' | 'error' | 'skipped'
  message: string
  at: number
  /** 这次是补跑（错过了时间，醒来后补的） */
  catchup?: boolean
  /** 这次是用户点了「立即运行」 */
  manual?: boolean
}

export interface ScheduleItem {
  id: string
  /** 所属工作区：界面上它出现在这个工作区的列表里。没有、或工作区已被移出时，每个工作区的列表里都显示它（免得看不见地继续跑） */
  workspaceId?: string
  name: string
  enabled: boolean
  schedule: ScheduleSpec
  action: ScheduleAction
  createdAt: number
  lastRunAt?: number
  lastResult?: ScheduleResult
  /** 下次运行时间；null = 不会再跑（一次性的跑过了或时间已过） */
  nextRunAt: number | null
}

/** workspaceId 不给：新建的不归属任何工作区，修改的保持原样 */
export type ScheduleInput = Partial<Pick<ScheduleItem, 'id' | 'enabled' | 'workspaceId'>> & Pick<ScheduleItem, 'name' | 'schedule' | 'action'>

/** 给内置 AI 发消息（main 里由 LlmService 提供） */
export interface BuiltinRunner {
  /** 绑了模型 */
  hasModel(agentId: string): boolean
  /** 立刻返回，后台执行；开不了头（正在跑、Key 解不开）时抛错 */
  send(agentId: string, text: string): void
}

export const MIN_EVERY_MINUTES = 1
export const MAX_EVERY_MINUTES = 7 * 24 * 60
/** 定时器每次最多睡这么久 */
export const TICK_MAX_MS = 30_000
/** 比计划时间晚这么多才算「补跑」（正常的定时器抖动不算） */
export const CATCHUP_GRACE_MS = 60_000
export const MAX_SCHEDULES = 200

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** 下次运行时间（严格晚于 after）；null = 不会再跑 */
export function nextRun(spec: ScheduleSpec, after: number, opts: { createdAt?: number; lastRunAt?: number } = {}): number | null {
  if (spec.kind === 'every') {
    const step = spec.minutes * 60_000
    // 从上次运行（没跑过就从创建时）起每 N 分钟一次；落在 after 之前的跳过
    const anchor = opts.lastRunAt ?? opts.createdAt ?? after
    if (anchor > after) return anchor + step
    const n = Math.floor((after - anchor) / step) + 1
    return anchor + n * step
  }
  if (spec.kind === 'once') {
    const t = Date.parse(spec.at)
    return Number.isFinite(t) && t > after && opts.lastRunAt === undefined ? t : null
  }
  const m = TIME_RE.exec(spec.time)
  if (!m) return null
  const days = spec.weekdays?.length ? new Set(spec.weekdays) : null
  const base = new Date(after)
  for (let i = 0; i <= 8; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, Number(m[1]), Number(m[2]), 0, 0)
    if (d.getTime() <= after) continue
    if (days && !days.has(d.getDay())) continue
    return d.getTime()
  }
  return null
}

/** 给人看的频率说明 */
export function describeSchedule(spec: ScheduleSpec): string {
  if (spec.kind === 'every') return spec.minutes % 60 === 0 ? `每 ${spec.minutes / 60} 小时` : `每 ${spec.minutes} 分钟`
  if (spec.kind === 'once') return `${new Date(spec.at).toLocaleString('zh-CN', { hour12: false })} 一次`
  const names = ['日', '一', '二', '三', '四', '五', '六']
  const days = spec.weekdays?.length ? `每周${[...spec.weekdays].sort().map((d) => names[d]).join('、')}` : '每天'
  return `${days} ${spec.time}`
}

/** 校验并规范化频率；不合法抛错 */
export function normalizeSpec(raw: unknown): ScheduleSpec {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (o.kind === 'every') {
    const minutes = Math.round(Number(o.minutes))
    if (!Number.isFinite(minutes) || minutes < MIN_EVERY_MINUTES || minutes > MAX_EVERY_MINUTES) throw new Error(`间隔要在 ${MIN_EVERY_MINUTES}～${MAX_EVERY_MINUTES} 分钟之间`)
    return { kind: 'every', minutes }
  }
  if (o.kind === 'daily') {
    const time = String(o.time ?? '').trim()
    if (!TIME_RE.test(time)) throw new Error('时间格式要是 HH:mm，例如 09:00')
    const weekdays = Array.isArray(o.weekdays) ? [...new Set(o.weekdays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : []
    return { kind: 'daily', time, ...(weekdays.length && weekdays.length < 7 ? { weekdays } : {}) }
  }
  if (o.kind === 'once') {
    const t = Date.parse(String(o.at ?? ''))
    if (!Number.isFinite(t)) throw new Error('请填写运行时间')
    return { kind: 'once', at: new Date(t).toISOString() }
  }
  throw new Error('不认识的频率类型')
}

export interface SchedulerOptions {
  /** 数据目录/schedules.json */
  file: string
  now?: () => number
  /** false：不起定时器，只能手动调 tick（测试用） */
  timers?: boolean
  isPaused: () => boolean
  /** 校验并规范化动作（AI、工作区、频道要存在）；不合法抛错 */
  normalizeAction: (raw: unknown) => ScheduleAction
  /** 真正执行一次；返回给人看的结果说明，失败抛错 */
  run: (item: ScheduleItem, info: { catchup: boolean; manual: boolean }) => Promise<string>
  /** 每次执行或跳过之后（记活动事件用） */
  onRun?: (item: ScheduleItem, result: ScheduleResult) => void
  /** 列表变了（保存、删除、跑完） */
  onChange?: () => void
}

interface ScheduleFile {
  version: 1
  items: ScheduleItem[]
}

export class Scheduler {
  private readonly store: JsonStore<ScheduleFile>
  private readonly now: () => number
  private timer?: ReturnType<typeof setTimeout>
  private stopped = true
  private ticking: Promise<void> = Promise.resolve()
  private readonly running = new Set<string>()

  constructor(private readonly opts: SchedulerOptions) {
    this.now = opts.now ?? Date.now
    this.store = new JsonStore<ScheduleFile>(opts.file, () => ({ version: 1, items: [] }))
    // 文件里坏掉的条目丢掉；没有下次时间的补上（过去的时间留着，tick 时按补跑处理）
    const now = this.now()
    const items: ScheduleItem[] = []
    for (const raw of Array.isArray(this.store.get().items) ? this.store.get().items : []) {
      try {
        const schedule = normalizeSpec(raw.schedule)
        if (!raw.id || !raw.action || typeof raw.action !== 'object') continue
        const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : now
        const lastRunAt = typeof raw.lastRunAt === 'number' ? raw.lastRunAt : undefined
        const nextRunAt = typeof raw.nextRunAt === 'number' || raw.nextRunAt === null ? raw.nextRunAt : nextRun(schedule, now, { createdAt, lastRunAt })
        const { workspaceId, ...rest } = raw
        items.push({
          ...rest,
          ...(typeof workspaceId === 'string' && workspaceId ? { workspaceId } : {}),
          name: String(raw.name ?? '').slice(0, 60) || '定时任务',
          enabled: raw.enabled === true,
          schedule,
          createdAt,
          nextRunAt,
          ...(lastRunAt !== undefined ? { lastRunAt } : {})
        })
      } catch {
        // 跳过坏条目
      }
    }
    this.data = items
  }

  private get data(): ScheduleItem[] {
    return this.store.get().items
  }

  private set data(items: ScheduleItem[]) {
    try {
      this.store.set({ version: 1, items })
    } catch (e) {
      console.warn(`[scheduler] 保存 ${this.opts.file} 失败：${(e as Error).message}`)
    }
  }

  /**
   * 用户发起的保存、删除：写不进文件就把内存里的列表恢复原样并抛错。
   * 不然界面显示「已保存」，重启后任务却没了（后台执行后的记录走上面的 setter：写失败只告警，任务照常在内存里跑）
   */
  private commit(items: ScheduleItem[]): void {
    const before = this.store.get()
    try {
      this.store.set({ version: 1, items })
    } catch (e) {
      // JsonStore.set 是先改内存再写文件：再 set 一次旧值把内存改回去，这次写不写得进去都无所谓
      try {
        this.store.set(before)
      } catch {
        // 内存已经是旧值
      }
      throw new Error(`保存失败，定时任务没有改动：${(e as Error).message}`)
    }
  }

  list(): ScheduleItem[] {
    return this.data.map((x) => ({ ...x }))
  }

  get(id: string): ScheduleItem | undefined {
    return this.data.find((x) => x.id === id)
  }

  /** 新建（不带 id）或修改；改了频率、或从停用改成启用时，下次时间从现在重新算 */
  save(input: ScheduleInput): ScheduleItem {
    const name = String(input.name ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 60)
    if (!name) throw new Error('名字不能为空')
    const schedule = normalizeSpec(input.schedule)
    const action = this.opts.normalizeAction(input.action)
    const now = this.now()
    const existing = input.id ? this.get(String(input.id)) : undefined
    if (input.id && !existing) throw new Error('定时任务不存在，可能已被删除')
    if (!existing && this.data.length >= MAX_SCHEDULES) throw new Error(`最多 ${MAX_SCHEDULES} 个定时任务`)
    const enabled = input.enabled ?? existing?.enabled ?? true
    const recompute = !existing || JSON.stringify(existing.schedule) !== JSON.stringify(schedule) || (enabled && !existing.enabled)
    const nextRunAt = recompute ? nextRun(schedule, now, { createdAt: now }) : (existing?.nextRunAt ?? null)
    // 时间已过的一次性任务不能启用着存下来：它永远不会跑，用户却以为排上了
    if (recompute && enabled && schedule.kind === 'once' && nextRunAt === null) throw new Error('运行时间已经过了，请改成将来的时间')
    // 所属工作区存不存在由调用方（Bridge）校验；这里只管记下
    const workspaceId = typeof input.workspaceId === 'string' && input.workspaceId ? input.workspaceId : existing?.workspaceId
    const item: ScheduleItem = {
      ...(existing ?? {}),
      id: existing?.id ?? 'sch_' + crypto.randomBytes(5).toString('hex'),
      ...(workspaceId ? { workspaceId } : {}),
      name,
      enabled,
      schedule,
      action,
      createdAt: existing?.createdAt ?? now,
      nextRunAt
    }
    this.commit(existing ? this.data.map((x) => (x.id === item.id ? item : x)) : [...this.data, item])
    this.changed()
    this.arm()
    return { ...item }
  }

  delete(id: string): void {
    if (!this.get(id)) throw new Error('定时任务不存在，可能已被删除')
    this.commit(this.data.filter((x) => x.id !== id))
    this.changed()
  }

  /** 吊销 AI、移出工作区之后：用到它们的任务停用（不删，用户可以改了再开） */
  disableWhere(pred: (a: ScheduleAction) => boolean, reason: string): number {
    let n = 0
    const at = this.now()
    this.data = this.data.map((x) => {
      if (!x.enabled || !pred(x.action)) return x
      n++
      return { ...x, enabled: false, lastResult: { status: 'error', message: reason, at } }
    })
    if (n) this.changed()
    return n
  }

  /** 立即运行一次（不影响下次计划时间）；「全部停下」时不跑 */
  async runNow(id: string): Promise<ScheduleItem> {
    const item = this.get(id)
    if (!item) throw new Error('定时任务不存在，可能已被删除')
    if (this.opts.isPaused()) throw new Error('已经「全部停下」，先在工作台恢复再运行')
    if (this.running.has(id)) throw new Error('这个任务正在运行')
    await this.execute(item, { catchup: false, manual: true })
    return { ...this.get(id)! }
  }

  /** 看哪些任务到点了，逐个执行（串行，不会同一个任务叠着跑） */
  tick(): Promise<void> {
    const run = this.ticking.then(() => this.tickOnce())
    this.ticking = run.catch(() => {})
    return run
  }

  private async tickOnce(): Promise<void> {
    const now = this.now()
    const due = this.data.filter((x) => x.enabled && x.nextRunAt !== null && x.nextRunAt <= now && !this.running.has(x.id))
    for (const item of due) {
      // 错过很久（睡眠、工作台关着）也只跑一次，之后的时间从现在往后算
      const catchup = now - (item.nextRunAt ?? now) > CATCHUP_GRACE_MS
      if (this.opts.isPaused()) {
        const result: ScheduleResult = { status: 'skipped', message: '已「全部停下」，这次没跑', at: now, ...(catchup ? { catchup: true } : {}) }
        this.update(item.id, (x) => ({ ...x, lastResult: result, nextRunAt: nextRun(x.schedule, now, { createdAt: x.createdAt, lastRunAt: x.lastRunAt ?? now }) }))
        this.opts.onRun?.(this.get(item.id) ?? item, result)
        continue
      }
      await this.execute(item, { catchup, manual: false })
    }
    if (due.length) this.changed()
  }

  private async execute(item: ScheduleItem, info: { catchup: boolean; manual: boolean }): Promise<void> {
    this.running.add(item.id)
    let result: ScheduleResult
    try {
      const message = await this.opts.run(item, info)
      result = { status: 'ok', message, at: this.now() }
    } catch (e) {
      result = { status: 'error', message: (e as Error)?.message ?? String(e), at: this.now() }
    } finally {
      this.running.delete(item.id)
    }
    if (info.catchup) result.catchup = true
    if (info.manual) result.manual = true
    const at = result.at
    // 执行期间可能被改过或删了：按 id 重新取
    this.update(item.id, (x) => ({
      ...x,
      lastRunAt: at,
      lastResult: result,
      ...(info.manual ? {} : { nextRunAt: nextRun(x.schedule, at, { createdAt: x.createdAt, lastRunAt: at }) })
    }))
    this.opts.onRun?.(this.get(item.id) ?? item, result)
    if (info.manual) this.changed()
  }

  private update(id: string, fn: (x: ScheduleItem) => ScheduleItem): void {
    if (!this.get(id)) return
    this.data = this.data.map((x) => (x.id === id ? fn(x) : x))
  }

  private changed(): void {
    try {
      this.opts.onChange?.()
    } catch {
      // 只是通知界面
    }
  }

  // ===== 定时器 =====

  start(): void {
    if (this.opts.timers === false) return
    this.stopped = false
    this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** 睡到最近一个任务的时间，但最多 30 秒（电脑睡眠后醒来、系统改了时间都能尽快发现） */
  private arm(): void {
    if (this.stopped || this.opts.timers === false) return
    if (this.timer) clearTimeout(this.timer)
    const now = this.now()
    const next = Math.min(...this.data.filter((x) => x.enabled && x.nextRunAt !== null).map((x) => x.nextRunAt as number), now + TICK_MAX_MS)
    const delay = Math.max(1000, Math.min(TICK_MAX_MS, next - now))
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick()
        .catch((e) => console.warn(`[scheduler] 执行出错：${(e as Error)?.message ?? e}`))
        .finally(() => this.arm())
    }, delay)
    this.timer.unref?.()
  }
}
