// 定时任务：下次运行时间的计算、到点执行、补跑、暂停时跳过、三种动作（chat / task 用真实 Bridge，builtin 注入假实现）、持久化重载。
// 全部用假时钟：scheduler 的 now 由测试控制，定时器关掉，手动 tick
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { MACHINE_WORKSPACE_ID } from '../src/core/config'
import { CATCHUP_GRACE_MS, describeSchedule, nextRun, normalizeSpec, Scheduler, type ScheduleAction, type ScheduleItem } from '../src/core/scheduler'
import type { ActivityEvent } from '../src/core/types'

let base: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sched-'))
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

/** 本机时区的某个时刻 */
const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
const MIN = 60_000
// 2026-11-04 是周三
const WED_0800 = at(2026, 11, 4, 8, 0)

describe('nextRun：下次运行时间', () => {
  it('every：从创建时（或上次运行）起每 N 分钟，错过的整段跳过', () => {
    const spec = { kind: 'every', minutes: 30 } as const
    expect(nextRun(spec, WED_0800, { createdAt: WED_0800 })).toBe(WED_0800 + 30 * MIN)
    expect(nextRun(spec, WED_0800 + 29 * MIN, { createdAt: WED_0800 })).toBe(WED_0800 + 30 * MIN)
    // 正好在点上：严格晚于 after
    expect(nextRun(spec, WED_0800 + 30 * MIN, { createdAt: WED_0800 })).toBe(WED_0800 + 60 * MIN)
    // 睡了 5 小时：下一次是 5 小时后的下一个整 30 分
    expect(nextRun(spec, WED_0800 + 5 * 60 * MIN + 10 * MIN, { createdAt: WED_0800 })).toBe(WED_0800 + 5 * 60 * MIN + 30 * MIN)
    // 有上次运行时间时以它为准
    expect(nextRun(spec, WED_0800 + 50 * MIN, { createdAt: WED_0800, lastRunAt: WED_0800 + 45 * MIN })).toBe(WED_0800 + 75 * MIN)
  })

  it('daily：当天还没到就是今天，过了就是明天（跨天、跨月）', () => {
    expect(nextRun({ kind: 'daily', time: '09:00' }, WED_0800)).toBe(at(2026, 11, 4, 9, 0))
    expect(nextRun({ kind: 'daily', time: '09:00' }, at(2026, 11, 4, 9, 0))).toBe(at(2026, 11, 5, 9, 0))
    expect(nextRun({ kind: 'daily', time: '00:05' }, at(2026, 11, 4, 23, 59))).toBe(at(2026, 11, 5, 0, 5))
    expect(nextRun({ kind: 'daily', time: '09:00' }, at(2026, 11, 30, 10, 0))).toBe(at(2026, 12, 1, 9, 0))
    expect(nextRun({ kind: 'daily', time: '09:00' }, at(2026, 12, 31, 10, 0))).toBe(at(2027, 1, 1, 9, 0))
  })

  it('daily + 周几：跳到下一个符合的日子', () => {
    // 周一、周五（1、5）；现在是周三 8 点 → 周五 9 点
    expect(nextRun({ kind: 'daily', time: '09:00', weekdays: [1, 5] }, WED_0800)).toBe(at(2026, 11, 6, 9, 0))
    // 周五 9 点之后 → 下周一
    expect(nextRun({ kind: 'daily', time: '09:00', weekdays: [1, 5] }, at(2026, 11, 6, 9, 30))).toBe(at(2026, 11, 9, 9, 0))
    // 只有周三，现在是周三 8 点 → 今天；周三 10 点 → 下周三
    expect(nextRun({ kind: 'daily', time: '09:00', weekdays: [3] }, WED_0800)).toBe(at(2026, 11, 4, 9, 0))
    expect(nextRun({ kind: 'daily', time: '09:00', weekdays: [3] }, at(2026, 11, 4, 10, 0))).toBe(at(2026, 11, 11, 9, 0))
    // 周日 = 0
    expect(new Date(nextRun({ kind: 'daily', time: '12:00', weekdays: [0] }, WED_0800)!).getDay()).toBe(0)
  })

  it('once：时间没到且没跑过才有下次；跑过或已过期是 null', () => {
    const t = new Date(at(2026, 11, 4, 9, 30)).toISOString()
    expect(nextRun({ kind: 'once', at: t }, WED_0800)).toBe(at(2026, 11, 4, 9, 30))
    expect(nextRun({ kind: 'once', at: t }, at(2026, 11, 4, 10, 0))).toBeNull()
    expect(nextRun({ kind: 'once', at: t }, WED_0800, { lastRunAt: WED_0800 })).toBeNull()
  })

  it('normalizeSpec 校验，describeSchedule 给人看', () => {
    expect(() => normalizeSpec({ kind: 'every', minutes: 0 })).toThrow('间隔')
    expect(() => normalizeSpec({ kind: 'daily', time: '25:00' })).toThrow('HH:mm')
    expect(() => normalizeSpec({ kind: 'once', at: 'nope' })).toThrow('时间')
    expect(() => normalizeSpec({ kind: 'cron' })).toThrow('频率')
    // 周几去重排序，选了全部 7 天就等于每天
    expect(normalizeSpec({ kind: 'daily', time: '09:00', weekdays: [5, 1, 1, 9] })).toEqual({ kind: 'daily', time: '09:00', weekdays: [1, 5] })
    expect(normalizeSpec({ kind: 'daily', time: '09:00', weekdays: [0, 1, 2, 3, 4, 5, 6] })).toEqual({ kind: 'daily', time: '09:00' })
    expect(describeSchedule({ kind: 'every', minutes: 30 })).toBe('每 30 分钟')
    expect(describeSchedule({ kind: 'every', minutes: 120 })).toBe('每 2 小时')
    expect(describeSchedule({ kind: 'daily', time: '09:00', weekdays: [1, 5] })).toBe('每周一、五 09:00')
  })
})

/** 只测调度：动作不校验，执行记下来 */
function makeScheduler(clock: { t: number }, opts: { paused?: () => boolean; fail?: boolean } = {}) {
  const runs: { id: string; catchup: boolean; manual: boolean; at: number }[] = []
  const logged: { name: string; status: string; catchup?: boolean }[] = []
  const s = new Scheduler({
    file: path.join(base, 'schedules.json'),
    now: () => clock.t,
    timers: false,
    isPaused: opts.paused ?? (() => false),
    normalizeAction: (a) => a as ScheduleAction,
    run: async (item, info) => {
      runs.push({ id: item.id, ...info, at: clock.t })
      if (opts.fail) throw new Error('炸了')
      return `跑了 ${item.name}`
    },
    onRun: (item, r) => logged.push({ name: item.name, status: r.status, ...(r.catchup ? { catchup: true } : {}) })
  })
  return { s, runs, logged }
}
const CHAT: ScheduleAction = { kind: 'chat', channel: 'general', text: 'hi' }

describe('Scheduler', () => {
  it('到点执行一次，记下 lastRunAt / lastResult，下次时间往后排；没到点不跑', async () => {
    const clock = { t: WED_0800 }
    const { s, runs, logged } = makeScheduler(clock)
    const item = s.save({ name: '每半小时', schedule: { kind: 'every', minutes: 30 }, action: CHAT })
    expect(item).toMatchObject({ enabled: true, nextRunAt: WED_0800 + 30 * MIN })
    clock.t += 29 * MIN
    await s.tick()
    expect(runs).toEqual([])
    clock.t += MIN
    await s.tick()
    expect(runs).toEqual([{ id: item.id, catchup: false, manual: false, at: WED_0800 + 30 * MIN }])
    expect(s.get(item.id)).toMatchObject({ lastRunAt: WED_0800 + 30 * MIN, lastResult: { status: 'ok', message: '跑了 每半小时' }, nextRunAt: WED_0800 + 60 * MIN })
    expect(logged).toEqual([{ name: '每半小时', status: 'ok' }])
    // 同一时刻再 tick 不会重复跑
    await s.tick()
    expect(runs).toHaveLength(1)
  })

  it('错过了很多次（睡眠 / 工作台关着）：只补跑一次并标「补跑」，下次时间从现在往后算', async () => {
    const clock = { t: WED_0800 }
    const { s, runs, logged } = makeScheduler(clock)
    const item = s.save({ name: '每 10 分钟', schedule: { kind: 'every', minutes: 10 }, action: CHAT })
    clock.t += 3 * 60 * MIN + 5 * MIN
    await s.tick()
    expect(runs).toHaveLength(1)
    expect(runs[0].catchup).toBe(true)
    expect(s.get(item.id)?.lastResult).toMatchObject({ status: 'ok', catchup: true })
    expect(s.get(item.id)?.nextRunAt).toBe(clock.t + 10 * MIN)
    expect(logged[0].catchup).toBe(true)
    // 晚了不到 1 分钟（定时器抖动）不算补跑
    clock.t = s.get(item.id)!.nextRunAt! + CATCHUP_GRACE_MS - 1000
    await s.tick()
    expect(runs[1].catchup).toBe(false)
  })

  it('「全部停下」时到点的不跑，记成 skipped，下次时间照常往后排；恢复后正常跑', async () => {
    const clock = { t: WED_0800 }
    let paused = true
    const { s, runs, logged } = makeScheduler(clock, { paused: () => paused })
    const item = s.save({ name: '早报', schedule: { kind: 'daily', time: '09:00' }, action: CHAT })
    clock.t = at(2026, 11, 4, 9, 0)
    await s.tick()
    expect(runs).toEqual([])
    expect(s.get(item.id)?.lastResult).toMatchObject({ status: 'skipped' })
    expect(s.get(item.id)?.lastRunAt).toBeUndefined()
    expect(s.get(item.id)?.nextRunAt).toBe(at(2026, 11, 5, 9, 0))
    expect(logged).toEqual([{ name: '早报', status: 'skipped' }])
    // 暂停时手动运行也不行
    await expect(s.runNow(item.id)).rejects.toThrow('全部停下')
    paused = false
    clock.t = at(2026, 11, 5, 9, 0)
    await s.tick()
    expect(runs).toHaveLength(1)
  })

  it('执行出错记进 lastResult；停用的不跑；一次性的跑完就没有下次', async () => {
    const clock = { t: WED_0800 }
    const { s, runs } = makeScheduler(clock, { fail: true })
    const once = s.save({ name: '一次', schedule: { kind: 'once', at: new Date(WED_0800 + 5 * MIN).toISOString() }, action: CHAT })
    const off = s.save({ name: '停用的', enabled: false, schedule: { kind: 'every', minutes: 1 }, action: CHAT })
    clock.t += 10 * MIN
    await s.tick()
    expect(runs.map((r) => r.id)).toEqual([once.id])
    expect(s.get(once.id)).toMatchObject({ lastResult: { status: 'error', message: '炸了' }, nextRunAt: null })
    expect(s.get(off.id)?.lastRunAt).toBeUndefined()
    clock.t += 60 * MIN
    await s.tick()
    expect(runs).toHaveLength(1)
  })

  it('一次性任务的时间已经过了：新建和重新启用都报错，不会存成一个启用着却永远不跑的任务', () => {
    const clock = { t: WED_0800 }
    const { s } = makeScheduler(clock)
    const past = new Date(WED_0800 - 5 * MIN).toISOString()
    const future = new Date(WED_0800 + 5 * MIN).toISOString()

    expect(() => s.save({ name: '过期的', schedule: { kind: 'once', at: past }, action: CHAT })).toThrow('已经过了')
    expect(s.list()).toEqual([])

    // 停用状态可以先存着，改了时间再开
    const off = s.save({ name: '过期的', enabled: false, schedule: { kind: 'once', at: past }, action: CHAT })
    expect(off).toMatchObject({ enabled: false, nextRunAt: null })
    expect(() => s.save({ ...off, enabled: true })).toThrow('已经过了')
    expect(s.get(off.id)?.enabled).toBe(false)
    expect(s.save({ ...off, enabled: true, schedule: { kind: 'once', at: future } }).nextRunAt).toBe(WED_0800 + 5 * MIN)
  })

  it('立即运行：不影响下次计划时间；改频率、重新启用时下次时间从现在重算', async () => {
    const clock = { t: WED_0800 }
    const { s, runs } = makeScheduler(clock)
    const item = s.save({ name: 'x', schedule: { kind: 'every', minutes: 60 }, action: CHAT })
    clock.t += 10 * MIN
    const r = await s.runNow(item.id)
    expect(runs[0].manual).toBe(true)
    expect(r.lastResult).toMatchObject({ status: 'ok', manual: true })
    expect(r.nextRunAt).toBe(WED_0800 + 60 * MIN)
    // 只改名字：下次时间不变
    expect(s.save({ ...item, name: '改名' }).nextRunAt).toBe(WED_0800 + 60 * MIN)
    // 改频率：从现在算
    expect(s.save({ ...item, schedule: { kind: 'every', minutes: 15 } }).nextRunAt).toBe(clock.t + 15 * MIN)
    s.save({ ...item, schedule: { kind: 'every', minutes: 15 }, enabled: false })
    clock.t += 7 * MIN
    expect(s.save({ ...item, schedule: { kind: 'every', minutes: 15 }, enabled: true }).nextRunAt).toBe(clock.t + 15 * MIN)
    expect(() => s.save({ name: ' ', schedule: { kind: 'every', minutes: 5 }, action: CHAT })).toThrow('名字')
    s.delete(item.id)
    expect(s.list()).toEqual([])
  })

  it('持久化：重启后任务、下次时间、上次结果都还在；关着时错过的启动后补跑', async () => {
    const clock = { t: WED_0800 }
    const a = makeScheduler(clock)
    const item = a.s.save({ name: '每天九点', schedule: { kind: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5] }, action: CHAT })
    clock.t = at(2026, 11, 4, 9, 0)
    await a.s.tick()
    const saved = a.s.get(item.id)!
    expect(saved.nextRunAt).toBe(at(2026, 11, 5, 9, 0))
    // 「关机」两天后启动
    clock.t = at(2026, 11, 6, 15, 0)
    const b = makeScheduler(clock)
    const reloaded = b.s.get(item.id)!
    expect(reloaded).toMatchObject({ name: '每天九点', schedule: saved.schedule, lastRunAt: saved.lastRunAt, nextRunAt: saved.nextRunAt })
    await b.s.tick()
    expect(b.runs).toEqual([expect.objectContaining({ catchup: true })])
    expect(b.s.get(item.id)?.nextRunAt).toBe(at(2026, 11, 9, 9, 0))
    // 文件里的坏条目丢掉
    const file = path.join(base, 'schedules.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    raw.items.push({ id: 'bad', name: 'x', schedule: { kind: 'cron' }, action: CHAT }, { name: '没 id', schedule: { kind: 'every', minutes: 5 }, action: CHAT })
    fs.writeFileSync(file, JSON.stringify(raw))
    expect(makeScheduler(clock).s.list().map((x) => x.id)).toEqual([item.id])
  })

  it('一次性任务在「全部停下」期间到点：记成跳过，之后不再运行（恢复后也不补）', async () => {
    const clock = { t: WED_0800 }
    let paused = true
    const { s, runs } = makeScheduler(clock, { paused: () => paused })
    const item = s.save({ name: '只跑一次', schedule: { kind: 'once', at: new Date(WED_0800 + 5 * MIN).toISOString() }, action: CHAT })
    clock.t = WED_0800 + 5 * MIN
    await s.tick()
    expect(s.get(item.id)).toMatchObject({ lastResult: { status: 'skipped' }, nextRunAt: null })
    paused = false
    clock.t += 60 * MIN
    await s.tick()
    expect(runs).toEqual([])
  })

  it('写不进文件：保存和删除都报错，列表保持原样（不能显示「已保存」而重启后没了）', () => {
    const clock = { t: WED_0800 }
    const { s } = makeScheduler(clock)
    const kept = s.save({ name: '原来的', schedule: { kind: 'every', minutes: 5 }, action: CHAT })
    // JsonStore 先写 schedules.json.tmp 再改名：在这个位置放一个目录，写就会失败
    const tmp = path.join(base, 'schedules.json.tmp')
    fs.mkdirSync(tmp)
    expect(() => s.save({ name: '存不进去', schedule: { kind: 'every', minutes: 5 }, action: CHAT })).toThrow('保存失败')
    expect(() => s.save({ ...kept, name: '改名' })).toThrow('保存失败')
    expect(() => s.delete(kept.id)).toThrow('保存失败')
    expect(s.list().map((x) => x.name)).toEqual(['原来的'])
    // 磁盘恢复后照常
    fs.rmdirSync(tmp)
    expect(s.save({ ...kept, name: '改名' }).name).toBe('改名')
    expect(makeScheduler(clock).s.list().map((x) => x.name)).toEqual(['改名'])
  })

  it('定时器：start 之后到点自己运行，stop 之后不再运行', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(WED_0800)
      const runs: string[] = []
      const s = new Scheduler({
        file: path.join(base, 'schedules.json'),
        isPaused: () => false,
        normalizeAction: (a) => a as ScheduleAction,
        run: async (item) => {
          runs.push(item.name)
          return 'ok'
        }
      })
      s.save({ name: '每分钟', schedule: { kind: 'every', minutes: 1 }, action: CHAT })
      s.start()
      await vi.advanceTimersByTimeAsync(59_000)
      expect(runs).toEqual([])
      await vi.advanceTimersByTimeAsync(2_000)
      expect(runs).toEqual(['每分钟'])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(runs).toHaveLength(2)
      s.stop()
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(runs).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('所属工作区：新建时记下，修改时不给就保持、给了就换；重启后还在，文件里类型不对的丢掉', () => {
    const clock = { t: WED_0800 }
    const { s } = makeScheduler(clock)
    const a = s.save({ name: 'A 的', workspaceId: 'w_a', schedule: { kind: 'every', minutes: 5 }, action: CHAT })
    const none = s.save({ name: '没归属', schedule: { kind: 'every', minutes: 5 }, action: CHAT })
    expect(a.workspaceId).toBe('w_a')
    expect(none.workspaceId).toBeUndefined()
    // 列表里的开关只传 id / name / schedule / action / enabled：所属工作区不能丢
    expect(s.save({ id: a.id, name: a.name, schedule: a.schedule, action: a.action, enabled: false }).workspaceId).toBe('w_a')
    expect(s.save({ ...none, workspaceId: 'w_b' }).workspaceId).toBe('w_b')
    const file = path.join(base, 'schedules.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    raw.items.push({ id: 'sch_odd', name: '类型不对', workspaceId: 42, schedule: { kind: 'every', minutes: 5 }, action: CHAT })
    fs.writeFileSync(file, JSON.stringify(raw))
    const again = makeScheduler(clock).s.list()
    expect(again.map((x) => [x.name, x.workspaceId])).toEqual([
      ['A 的', 'w_a'],
      ['没归属', 'w_b'],
      ['类型不对', undefined]
    ])
  })
})

describe('Bridge 里的定时任务（三种动作）', () => {
  let bridge: Bridge
  let clock: { t: number }
  let wsId: string
  let events: ActivityEvent[]
  let notices: { agentId: string; text: string }[]

  beforeEach(async () => {
    clock = { t: WED_0800 }
    const root = path.join(base, 'proj')
    fs.mkdirSync(root, { recursive: true })
    bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'skills'), scheduler: { now: () => clock.t, timers: false } })
    wsId = bridge.getState().activeWorkspaceId!
    events = []
    notices = []
    bridge.on('event', (e: ActivityEvent) => e.status !== 'running' && events.push(e))
    bridge.on('notice', (agentId: string, text: string) => notices.push({ agentId, text }))
  })

  afterEach(async () => {
    await bridge.stop()
  })

  const due = async (item: ScheduleItem): Promise<ScheduleItem> => {
    clock.t = item.nextRunAt!
    await bridge.scheduler.tick()
    return bridge.listSchedules().find((x) => x.id === item.id)!
  }

  it('chat：以「定时任务」的身份发到频道，@ 的 AI 收到通知（内置 AI 会自动接活），记一条活动事件', async () => {
    const maya = bridge.createAgent('Maya')
    const item = bridge.saveSchedule({
      name: '早报',
      schedule: { kind: 'daily', time: '09:00' },
      action: { kind: 'chat', channel: `ws:${wsId}`, text: '请汇报昨天的进度', mention: [maya.id] }
    })
    const done = await due(item)
    expect(done.lastResult).toMatchObject({ status: 'ok', message: expect.stringContaining('@ 了 Maya') })
    const msgs = bridge.listChat({ channel: `ws:${wsId}` })
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ from: { kind: 'user', id: 'scheduler', name: '定时任务「早报」' }, workspaceId: wsId })
    expect(msgs[0].text).toBe('@Maya 请汇报昨天的进度')
    expect(msgs[0].mentions).toContain(maya.id)
    expect(notices.map((n) => n.agentId)).toEqual([maya.id])
    // 用户的未读里有它（不是用户自己发的）
    expect(bridge.getState().chat.unread).toBe(1)
    const ev = events.find((e) => e.tool === 'schedule_run')!
    expect(ev).toMatchObject({ agentId: 'scheduler', agentName: '定时任务', status: 'ok', workspaceId: wsId })
    expect(ev.summary).toContain('「早报」')
  })

  it('task：在指定工作区的任务板上派任务给 AI，它收到通知', async () => {
    const maya = bridge.createAgent('Maya')
    const item = bridge.saveSchedule({
      name: '检查构建',
      schedule: { kind: 'every', minutes: 30 },
      action: { kind: 'task', workspaceId: wsId, title: '检查一次构建', description: '跑 npm run build，有错就修', assigneeId: maya.id }
    })
    const done = await due(item)
    expect(done.lastResult?.status).toBe('ok')
    const tasks = bridge.listTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ title: '检查一次构建', assigneeId: maya.id, createdBy: 'scheduler', createdByName: '定时任务' })
    expect(tasks[0].description).toContain('由定时任务「检查构建」创建')
    expect(notices.some((n) => n.agentId === maya.id)).toBe(true)
    expect(done.nextRunAt).toBe(clock.t + 30 * MIN)
  })

  it('builtin：给内置 AI 发消息；没绑模型、没有内置 AI 时记成错误', async () => {
    const maya = bridge.createAgent('Maya')
    const item = bridge.saveSchedule({ name: '提醒', schedule: { kind: 'every', minutes: 60 }, action: { kind: 'builtin', agentId: maya.id, prompt: '看看有没有新任务' } })
    // 没有接内置 AI
    expect((await due(item)).lastResult).toMatchObject({ status: 'error', message: expect.stringContaining('内置 AI 不可用') })
    const sent: { agentId: string; text: string }[] = []
    let bound = false
    bridge.setBuiltinRunner({ hasModel: () => bound, send: (agentId, text) => sent.push({ agentId, text }) })
    expect((await due(bridge.listSchedules()[0])).lastResult).toMatchObject({ status: 'error', message: expect.stringContaining('没有绑定模型') })
    bound = true
    const ok = await due(bridge.listSchedules()[0])
    expect(ok.lastResult).toMatchObject({ status: 'ok', message: '给 Maya 发了消息' })
    expect(sent).toEqual([{ agentId: maya.id, text: expect.stringContaining('看看有没有新任务') }])
    expect(sent[0].text).toContain('【定时任务「提醒」】')
    expect(events.filter((e) => e.tool === 'schedule_run').map((e) => e.status)).toEqual(['error', 'error', 'ok'])
  })

  it('全部停下时跳过；补跑在消息里注明；立即运行', async () => {
    const item = bridge.saveSchedule({ name: '广播', schedule: { kind: 'every', minutes: 10 }, action: { kind: 'chat', channel: 'general', text: '心跳' } })
    bridge.setPaused(true)
    const skipped = await due(item)
    expect(skipped.lastResult?.status).toBe('skipped')
    expect(bridge.listChat()).toEqual([])
    await expect(bridge.runScheduleNow(item.id)).rejects.toThrow('全部停下')
    bridge.setPaused(false)
    // 错过了一个多小时
    clock.t = skipped.nextRunAt! + 70 * MIN
    await bridge.scheduler.tick()
    expect(bridge.listChat()[0].text).toContain('补跑')
    const now = await bridge.runScheduleNow(item.id)
    expect(now.lastResult).toMatchObject({ status: 'ok', manual: true })
    expect(bridge.listChat()).toHaveLength(2)
  })

  it('保存时校验动作；吊销 AI、移出工作区后用到它们的任务停用', async () => {
    const maya = bridge.createAgent('Maya')
    expect(() => bridge.saveSchedule({ name: 'x', schedule: { kind: 'every', minutes: 5 }, action: { kind: 'chat', channel: 'ws:w_nope', text: 'x' } })).toThrow('频道')
    expect(() => bridge.saveSchedule({ name: 'x', schedule: { kind: 'every', minutes: 5 }, action: { kind: 'task', workspaceId: 'w_nope', title: 't', description: '' } })).toThrow('工作区')
    expect(() => bridge.saveSchedule({ name: 'x', schedule: { kind: 'every', minutes: 5 }, action: { kind: 'builtin', agentId: 'nobody', prompt: 'p' } })).toThrow('不存在')
    expect(() => bridge.saveSchedule({ name: 'x', schedule: { kind: 'every', minutes: 5 }, action: { kind: 'chat', channel: 'general', text: ' ' } })).toThrow('消息')
    const t = bridge.saveSchedule({ name: '派活', schedule: { kind: 'every', minutes: 5 }, action: { kind: 'task', workspaceId: wsId, title: 't', description: '', assigneeId: maya.id } })
    const c = bridge.saveSchedule({ name: '发群', schedule: { kind: 'every', minutes: 5 }, action: { kind: 'chat', channel: `ws:${wsId}`, text: 'hi' } })
    await bridge.removeAgent(maya.id)
    expect(bridge.listSchedules().find((x) => x.id === t.id)).toMatchObject({ enabled: false, lastResult: { status: 'error' } })
    expect(bridge.listSchedules().find((x) => x.id === c.id)?.enabled).toBe(true)
    await bridge.removeWorkspace(wsId)
    expect(bridge.listSchedules().find((x) => x.id === c.id)?.enabled).toBe(false)
  })

  it('每个工作区有自己的列表：保存时记下所属工作区（要存在，不能是整台电脑）；移出工作区后任务还在，不会看不见地继续跑', async () => {
    const other = path.join(base, 'other')
    fs.mkdirSync(other, { recursive: true })
    const ws2 = await bridge.addWorkspace(other)
    const every = { kind: 'every', minutes: 5 } as const
    const say = { kind: 'chat', channel: 'general', text: 'hi' } as const
    const a = bridge.saveSchedule({ name: '一号的', workspaceId: wsId, schedule: every, action: say })
    const b = bridge.saveSchedule({ name: '二号的', workspaceId: ws2.id, schedule: every, action: say })
    expect(() => bridge.saveSchedule({ name: 'x', workspaceId: 'w_nope', schedule: every, action: say })).toThrow('工作区不存在')
    // 工作台切不到整台电脑，归给它的任务哪个列表都不会显示：不让归
    expect(() => bridge.saveSchedule({ name: 'x', workspaceId: MACHINE_WORKSPACE_ID, schedule: every, action: say })).toThrow('整台电脑')
    const owners = (): Record<string, string | undefined> => Object.fromEntries(bridge.listSchedules().map((x) => [x.name, x.workspaceId]))
    expect(owners()).toEqual({ 一号的: wsId, 二号的: ws2.id })
    // 活动事件记在所属工作区名下（动作本身不带工作区时）
    await due(a)
    expect(events.find((e) => e.tool === 'schedule_run')).toMatchObject({ workspaceId: wsId })
    // 移出二号：它的任务不删，所属工作区原样留着（界面把找不到工作区的任务显示在每个列表里）
    await bridge.removeWorkspace(ws2.id)
    expect(bridge.listSchedules().find((x) => x.id === b.id)).toMatchObject({ name: '二号的', workspaceId: ws2.id, enabled: true })
    // 在别的工作区里保存它：归到那个工作区
    expect(bridge.saveSchedule({ id: b.id, name: b.name, workspaceId: wsId, schedule: every, action: say }).workspaceId).toBe(wsId)
  })

  it('群聊任务 @ 的 AI 被吊销后：任务还能停用、能改、能跑，保存时把已吊销的 AI 从 @ 里去掉', async () => {
    const maya = bridge.createAgent('Maya')
    const arena = bridge.createAgent('Arena')
    const item = bridge.saveSchedule({ name: '早报', schedule: { kind: 'every', minutes: 5 }, action: { kind: 'chat', channel: 'general', text: '汇报', mention: [maya.id, arena.id] } })
    await bridge.removeAgent(maya.id)
    // 只 @ 它的群聊任务不停用（消息照发）；到点运行不报错，只 @ 还在的
    const still = bridge.listSchedules().find((x) => x.id === item.id)!
    expect(still.enabled).toBe(true)
    expect((await due(still)).lastResult).toMatchObject({ status: 'ok', message: expect.stringContaining('@ 了 Arena') })
    // 侧栏的开关把原来的动作整个传回来：不能因为里面有已吊销的 AI 就存不了
    const off = bridge.saveSchedule({ id: item.id, name: item.name, schedule: item.schedule, action: item.action, enabled: false })
    expect(off).toMatchObject({ enabled: false, action: { kind: 'chat', mention: [arena.id] } })
  })

  it('task：可以派到「整台电脑」的任务板', async () => {
    const item = bridge.saveSchedule({ name: '整机巡检', schedule: { kind: 'every', minutes: 30 }, action: { kind: 'task', workspaceId: MACHINE_WORKSPACE_ID, title: '看一眼磁盘空间', description: '' } })
    const done = await due(item)
    expect(done.lastResult).toMatchObject({ status: 'ok', message: expect.stringContaining('看一眼磁盘空间') })
    // 当前工作区的任务板上没有，切到整台电脑才看得到
    expect(bridge.listTasks()).toEqual([])
    bridge.setActiveWorkspace(MACHINE_WORKSPACE_ID)
    expect(bridge.listTasks()).toEqual([expect.objectContaining({ title: '看一眼磁盘空间', createdBy: 'scheduler' })])
    expect(events.find((e) => e.tool === 'schedule_run')).toMatchObject({ status: 'ok', workspaceId: MACHINE_WORKSPACE_ID })
  })

  it('持久化：Bridge 重启后定时任务还在（schedules.json 在数据目录）', async () => {
    const item = bridge.saveSchedule({ name: '留着', schedule: { kind: 'daily', time: '18:30', weekdays: [5] }, action: { kind: 'chat', channel: 'general', text: '周五了' } })
    await bridge.stop()
    expect(fs.existsSync(path.join(base, 'data', 'schedules.json'))).toBe(true)
    bridge = new Bridge({ dataDir: path.join(base, 'data'), port: 0, userSkillsDir: path.join(base, 'skills'), scheduler: { now: () => clock.t, timers: false } })
    expect(bridge.listSchedules()).toEqual([expect.objectContaining({ id: item.id, name: '留着', nextRunAt: at(2026, 11, 6, 18, 30) })])
  })
})
