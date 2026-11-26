// 概览仪表盘：CallStats 的统计（纯逻辑，注入时钟）+ Bridge.getOverview 的集成
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { CallStats, MAX_STAT_RECORDS, OVERVIEW_HOURS, OVERVIEW_WINDOW_MS } from '../src/core/overview'
import type { ActivityEvent, EventStatus } from '../src/core/types'

const HOUR = 60 * 60 * 1000
/** 固定在某个整点过 30 分，桶边界好算 */
const NOW = Date.UTC(2026, 10, 5, 12, 30, 0)

let seq = 0
function ev(agentId: string, tool: string, status: EventStatus, ts: number, id = `e${++seq}`): ActivityEvent {
  return { id, ts, agentId, agentName: agentId, agentColor: '#fff', tool, args: {}, status }
}

function clock(t = NOW) {
  const c = { t, now: () => c.t }
  return c
}

describe('CallStats', () => {
  it('只计已完成的调用；running 只更新最近调用时间；command_audit 不计', () => {
    const c = clock()
    const s = new CallStats(c.now)
    s.ingest(ev('a', 'read_file', 'running', NOW - 1000, 'x1'))
    s.ingest(ev('a', 'read_file', 'ok', NOW - 1000, 'x1'))
    s.ingest(ev('a', 'write_file', 'error', NOW - 500))
    s.ingest(ev('a', 'command_audit', 'ok', NOW - 400))
    s.ingest(ev('b', 'list_dir', 'running', NOW - 100))
    const snap = s.snapshot()
    expect(snap.calls).toBe(2)
    expect(snap.errors).toBe(1)
    expect(snap.byAgent.get('a')).toMatchObject({ calls: 2, errors: 1, lastCallAt: NOW - 500 })
    // b 只有一个还没结束的调用：没有调用数，但有最近调用时间
    expect(snap.byAgent.get('b')).toMatchObject({ calls: 0, errors: 0, lastCallAt: NOW - 100, topTools: [] })
  })

  it('同一个事件 id 只计一次（running→ok 两次推送、审计补数和增量重叠）', () => {
    const s = new CallStats(clock().now)
    const e = ev('a', 'read_file', 'ok', NOW - 1000, 'dup')
    s.ingest(e)
    s.ingest({ ...e })
    s.ingest({ ...e, status: 'error' })
    expect(s.snapshot().calls).toBe(1)
  })

  it('24 小时窗口：窗口外的不进来，时间往后走时旧记录被裁掉', () => {
    const c = clock()
    const s = new CallStats(c.now)
    s.ingest(ev('a', 't', 'ok', NOW - OVERVIEW_WINDOW_MS - 1))
    s.ingest(ev('a', 't', 'ok', NOW - 23 * HOUR))
    s.ingest(ev('a', 't', 'ok', NOW - 1 * HOUR))
    expect(s.snapshot().calls).toBe(2)
    c.t = NOW + 2 * HOUR
    expect(s.snapshot().calls).toBe(1)
    c.t = NOW + 30 * HOUR
    const snap = s.snapshot()
    expect(snap.calls).toBe(0)
    // 记录没了，最近调用时间还在
    expect(snap.byAgent.get('a')?.lastCallAt).toBe(NOW - HOUR)
  })

  it('24 个小时桶：最后一个是当前小时，整点对齐，错误单独计', () => {
    const s = new CallStats(clock().now)
    s.ingest(ev('a', 't', 'ok', NOW - 10 * 60 * 1000)) // 12:20，当前小时
    s.ingest(ev('a', 't', 'error', NOW - 25 * 60 * 1000)) // 12:05，当前小时
    s.ingest(ev('a', 't', 'ok', NOW - 45 * 60 * 1000)) // 11:45，上一小时
    s.ingest(ev('a', 't', 'ok', NOW - 23 * HOUR - 10 * 60 * 1000)) // 13:20 前一天，第一个桶
    const { hourly } = s.snapshot()
    expect(hourly).toHaveLength(OVERVIEW_HOURS)
    expect(hourly[23].hourStart).toBe(Date.UTC(2026, 10, 5, 12))
    expect(hourly[0].hourStart).toBe(Date.UTC(2026, 10, 4, 13))
    for (let i = 1; i < hourly.length; i++) expect(hourly[i].hourStart - hourly[i - 1].hourStart).toBe(HOUR)
    expect(hourly[23]).toMatchObject({ calls: 2, errors: 1 })
    expect(hourly[22]).toMatchObject({ calls: 1, errors: 0 })
    expect(hourly[0]).toMatchObject({ calls: 1 })
    expect(hourly.reduce((n, h) => n + h.calls, 0)).toBe(4)
  })

  it('窗口最早那几分钟（落在第一个整点之前）算进第一个桶', () => {
    const s = new CallStats(clock().now)
    s.ingest(ev('a', 't', 'ok', NOW - 23 * HOUR - 50 * 60 * 1000)) // 12:40 前一天，比第一个桶的 13:00 早
    const { hourly, calls } = s.snapshot()
    expect(calls).toBe(1)
    expect(hourly[0].calls).toBe(1)
  })

  it('最常用的 5 个工具：按次数降序，次数相同按名字', () => {
    const s = new CallStats(clock().now)
    const counts: Record<string, number> = { read_file: 5, list_dir: 3, grep: 3, write_file: 2, edit_file: 1, delete: 1 }
    for (const [tool, n] of Object.entries(counts)) for (let i = 0; i < n; i++) s.ingest(ev('a', tool, 'ok', NOW - 1000))
    expect(s.snapshot().byAgent.get('a')!.topTools).toEqual([
      { tool: 'read_file', count: 5 },
      { tool: 'grep', count: 3 },
      { tool: 'list_dir', count: 3 },
      { tool: 'write_file', count: 2 },
      { tool: 'delete', count: 1 }
    ])
  })

  it('超过记录上限时丢最旧的', () => {
    const s = new CallStats(clock().now)
    for (let i = 0; i < MAX_STAT_RECORDS + 10; i++) s.ingest(ev('a', 't', 'ok', NOW - 1000))
    expect(s.snapshot().calls).toBe(MAX_STAT_RECORDS)
  })

  it('从审计文件补数：读今天和昨天两个文件，跳过坏行、窗口外的、running；和增量记录按 id 去重', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ovw-'))
    try {
      const today = new Date(NOW).toISOString().slice(0, 10)
      const yesterday = new Date(NOW - OVERVIEW_WINDOW_MS).toISOString().slice(0, 10)
      const line = (e: ActivityEvent) => JSON.stringify(e) + '\n'
      fs.writeFileSync(
        path.join(dir, `${yesterday}.jsonl`),
        line(ev('a', 'read_file', 'ok', NOW - 20 * HOUR, 'y1')) + line(ev('a', 'read_file', 'ok', NOW - 30 * HOUR, 'old')) + 'not json\n'
      )
      fs.writeFileSync(
        path.join(dir, `${today}.jsonl`),
        line(ev('a', 'grep', 'error', NOW - 2 * HOUR, 't1')) + line(ev('b', 'list_dir', 'ok', NOW - HOUR, 't2')) + line(ev('b', 'x', 'running', NOW - HOUR, 't3')) + '{"id":1}\n'
      )
      // 一个日期更早、不该读的文件
      fs.writeFileSync(path.join(dir, '2020-01-01.jsonl'), line(ev('a', 'z', 'ok', NOW - HOUR, 'z1')))
      const s = new CallStats(clock().now)
      // 启动后先到的增量事件，和审计里的 t2 是同一条
      s.ingest(ev('b', 'list_dir', 'ok', NOW - HOUR, 't2'))
      await s.seedFromAudit(dir)
      // 只补一次
      await s.seedFromAudit(dir)
      const snap = s.snapshot()
      expect(snap.calls).toBe(3)
      expect(snap.errors).toBe(1)
      expect(snap.byAgent.get('a')).toMatchObject({ calls: 2, errors: 1 })
      expect(snap.byAgent.get('b')).toMatchObject({ calls: 1 })
      // 审计目录不存在也不报错
      await expect(new CallStats(clock().now).seedFromAudit(path.join(dir, 'nope'))).resolves.toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Bridge.getOverview', () => {
  let base: string
  let bridge: Bridge | undefined
  const clients: Client[] = []
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge?.stop()
    bridge = undefined
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
  })

  it('汇总在线 AI、调用、错误、审计补数、任务、工作区、隧道、命令；缓存 5 秒', async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ovw-bridge-'))
    const root = path.join(base, 'ws')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n')
    const dataDir = path.join(base, 'data')
    // 上次运行留下的审计记录（一小时前）
    fs.mkdirSync(path.join(dataDir, 'audit'), { recursive: true })
    const old = ev('old-agent', 'read_file', 'ok', Date.now() - HOUR, 'seeded-1')
    fs.writeFileSync(path.join(dataDir, 'audit', `${new Date(old.ts).toISOString().slice(0, 10)}.jsonl`), JSON.stringify(old) + '\n')

    bridge = new Bridge({ dataDir, workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'skills') })
    await bridge.start()
    await bridge.overviewReady()
    const agent = bridge.createAgent('Alice')
    bridge.createTask({ title: '一' })
    const t2 = bridge.createTask({ title: '二' })
    bridge.setTaskStatus(t2.id, 'in_progress')

    const c = new Client({ name: 'overview-test', version: '1.0.0' })
    await c.connect(
      new StreamableHTTPClientTransport(new URL(bridge.getState().mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${agent.token}` } } })
    )
    clients.push(c)
    await c.callTool({ name: 'read_file', arguments: { path: 'a.txt' } })
    await c.callTool({ name: 'read_file', arguments: { path: 'nope.txt' } })
    await c.callTool({ name: 'list_dir', arguments: {} })

    const o = bridge.getOverview(true)
    const alice = o.agents.find((a) => a.id === agent.id)!
    expect(alice).toMatchObject({ name: 'Alice', machineAccess: false, online: true, calls24h: 3, errors24h: 1 })
    expect(alice).not.toHaveProperty('tier')
    expect(alice.topTools[0]).toEqual({ tool: 'read_file', count: 2 })
    expect(alice.lastCallAt).toBeGreaterThan(Date.now() - 60_000)
    expect(o.totals.onlineAgents).toBe(1)
    // 审计补进来的那一条也算
    expect(o.totals.calls24h).toBe(4)
    expect(o.totals.errors24h).toBe(1)
    expect(o.totals.errorRate).toBeCloseTo(0.25)
    expect(o.totals.hourly).toHaveLength(24)
    expect(o.totals.hourly.reduce((n, h) => n + h.calls, 0)).toBe(4)
    expect(o).not.toHaveProperty('pendingApprovals')
    expect(o.runningCommands).toBe(0)
    expect(o.tunnel.status).toBe('off')
    expect(o.mcpUrl).toBe(bridge.getState().mcpUrl)
    expect(o.taskTotals).toMatchObject({ todo: 1, in_progress: 1, done: 0 })
    const ws = o.workspaces.find((w) => w.active)!
    expect(ws.tasks).toMatchObject({ todo: 1, in_progress: 1 })
    expect(o.chat).toEqual({ unread: 0, mentions: 0 })

    // 5 秒内不带 force 返回缓存
    const cached = bridge.getOverview()
    await c.callTool({ name: 'list_dir', arguments: {} })
    expect(bridge.getOverview()).toBe(cached)
    expect(bridge.getOverview(true).totals.calls24h).toBe(5)
  })
})
