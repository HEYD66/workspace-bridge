// T-15（用户 #117 第 2 点 + 优化.txt 第 9 条）：成员状态细分和掉线检测
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { chatReaderKey } from '../src/core/chat'
import {
  MEMBER_CALL_MAX_MS,
  MEMBER_GRACE_MS,
  MEMBER_STALE_MS,
  MemberActivity,
  StaleWatch,
  describeMemberStatus,
  memberGone,
  memberHint,
  type MemberFacts
} from '../src/core/memberStatus'
import type { Agent, BridgeState, MemberStatus } from '../src/core/types'

const T0 = 1_700_000_000_000
const MIN = 60_000
const A = 'a_bob'

/** 一个连着的主连接，刚握手 */
const facts = (now: number, over: Partial<MemberFacts> = {}): MemberFacts => ({
  now,
  sessions: [{ lastSeen: T0, createdAt: T0 }],
  ...over
})
let seq = 0
const start = (act: MemberActivity, tool: string, at: number, agentId = A): string => {
  const id = `e${++seq}`
  act.ingest({ id, agentId, tool, status: 'running', ts: at }, at)
  return id
}
const end = (act: MemberActivity, id: string, tool: string, at: number, agentId = A): void => {
  act.ingest({ id, agentId, tool, status: 'ok', ts: at }, at)
}

describe('成员状态的计算（MemberActivity）', () => {
  it('没有连接是 offline；知道什么时候断的就带 since，不知道就不带', () => {
    const act = new MemberActivity()
    expect(act.status(A, { now: T0, sessions: [] })).toEqual({ status: 'offline', sessions: 0 })
    expect(act.status(A, { now: T0 + 5000, sessions: [], offlineSince: T0 })).toEqual({ status: 'offline', since: T0, sessions: 0 })
  })

  it('只剩副连接也算 offline，readers 里写着哪些副连接还在；lastSeen 只看主连接', () => {
    const act = new MemberActivity()
    const st = act.status(A, {
      now: T0 + 1000,
      sessions: [
        { lastSeen: T0 + 900, createdAt: T0, reader: 'proxy' },
        { lastSeen: T0 + 900, createdAt: T0, reader: 'proxy' },
        { lastSeen: T0 + 900, createdAt: T0, reader: 'bot2' }
      ]
    })
    expect(st).toEqual({ status: 'offline', sessions: 3, readers: ['bot2', 'proxy'] })
    const both = act.status(A, {
      now: T0 + 1000,
      sessions: [
        { lastSeen: T0 + 100, createdAt: T0 },
        { lastSeen: T0 + 900, createdAt: T0, reader: 'proxy' }
      ]
    })
    expect(both.status).toBe('idle')
    expect(both.lastSeen).toBe(T0 + 100)
    expect(both.readers).toEqual(['proxy'])
  })

  it('连着、什么都没干是 idle，since 是最后一次动作的时间', () => {
    const act = new MemberActivity()
    expect(act.status(A, facts(T0 + 30_000))).toEqual({ status: 'idle', since: T0, sessions: 1, lastSeen: T0 })
    expect(act.status(A, facts(T0 + 30_000, { sessions: [{ lastSeen: T0 + 20_000, createdAt: T0 }] })).since).toBe(T0 + 20_000)
  })

  it('有工具调用在途是 working：带工具名、calling=true、since 是这一段开始的时间', () => {
    const act = new MemberActivity()
    start(act, 'read_file', T0 + 1000)
    expect(act.status(A, facts(T0 + 1500))).toMatchObject({ status: 'working', tool: 'read_file', calling: true, since: T0 + 1000 })
    // 别的成员不受影响
    expect(act.status('a_alice', facts(T0 + 1500)).status).toBe('idle')
  })

  it('几个调用同时在途：报最后开始的那个；先结束一个，另一个还在，仍是 working', () => {
    const act = new MemberActivity()
    const a = start(act, 'read_file', T0 + 1000)
    const b = start(act, 'grep', T0 + 1200)
    expect(act.status(A, facts(T0 + 1300)).tool).toBe('grep')
    end(act, b, 'grep', T0 + 1400)
    expect(act.status(A, facts(T0 + 1500))).toMatchObject({ status: 'working', tool: 'read_file', calling: true })
    end(act, a, 'read_file', T0 + 1600)
    expect(act.status(A, facts(T0 + 1700))).toMatchObject({ status: 'working', calling: false })
  })

  it('刚调完不到 20 秒还算 working（calling=false）；超过就是 idle，since 是调完的时间', () => {
    const act = new MemberActivity()
    const a = start(act, 'edit_file', T0 + 1000)
    end(act, a, 'edit_file', T0 + 2000)
    expect(act.status(A, facts(T0 + 2000 + MEMBER_GRACE_MS))).toMatchObject({ status: 'working', tool: 'edit_file', calling: false, since: T0 + 1000 })
    const idle = act.status(A, facts(T0 + 2001 + MEMBER_GRACE_MS))
    expect(idle.status).toBe('idle')
    expect(idle.since).toBe(T0 + 2000)
    expect(idle.tool).toBeUndefined()
  })

  it('连着调工具（间隔不到 20 秒）since 不变；停了超过 20 秒再调，算新的一段', () => {
    const act = new MemberActivity()
    const a = start(act, 'read_file', T0 + 1000)
    end(act, a, 'read_file', T0 + 2000)
    const b = start(act, 'grep', T0 + 2000 + MEMBER_GRACE_MS)
    expect(act.status(A, facts(T0 + 2100 + MEMBER_GRACE_MS)).since).toBe(T0 + 1000)
    end(act, b, 'grep', T0 + 30_000)
    const c = start(act, 'grep', T0 + 30_001 + MEMBER_GRACE_MS)
    expect(act.status(A, facts(T0 + 30_002 + MEMBER_GRACE_MS)).since).toBe(T0 + 30_001 + MEMBER_GRACE_MS)
    end(act, c, 'grep', T0 + 60_000)
  })

  it('graceMs 可配置：给 0 的话调完立刻是 idle', () => {
    const act = new MemberActivity({ graceMs: 0 })
    const a = start(act, 'read_file', T0 + 1000)
    end(act, a, 'read_file', T0 + 2000)
    expect(act.status(A, facts(T0 + 2001)).status).toBe('idle')
  })

  it('在途的是 run_command 就是 command；调完的窗口里也还是 command', () => {
    const act = new MemberActivity()
    const a = start(act, 'run_command', T0 + 1000)
    expect(act.status(A, facts(T0 + 5000))).toMatchObject({ status: 'command', tool: 'run_command', calling: true, since: T0 + 1000 })
    expect(act.status(A, facts(T0 + 5000)).background).toBeUndefined()
    end(act, a, 'run_command', T0 + 6000)
    expect(act.status(A, facts(T0 + 7000))).toMatchObject({ status: 'command', calling: false })
  })

  it('主连接在等消息是 waiting，since 是这次开始等的时间；同时在调别的工具，算 working', () => {
    const act = new MemberActivity()
    const w = start(act, 'chat_wait', T0 + 1000)
    const st = act.status(A, facts(T0 + 9000, { waiting: true }))
    expect(st).toMatchObject({ status: 'waiting', since: T0 + 1000 })
    expect(st.tool).toBeUndefined()
    const r = start(act, 'read_file', T0 + 9500)
    expect(act.status(A, facts(T0 + 9600, { waiting: true }))).toMatchObject({ status: 'working', tool: 'read_file' })
    end(act, r, 'read_file', T0 + 9700)
    // 调完了，还在等：回到 waiting，不停在 working 的窗口里
    expect(act.status(A, facts(T0 + 9800, { waiting: true })).status).toBe('waiting')
    end(act, w, 'chat_wait', T0 + 10_000)
  })

  it('chat_wait 在途但主连接没在等（是副连接在等）：不算 waiting', () => {
    const act = new MemberActivity()
    start(act, 'chat_wait', T0 + 1000)
    expect(act.status(A, facts(T0 + 9000, { waiting: false })).status).toBe('idle')
  })

  it('一轮接一轮地等：两次 chat_wait 之间不闪成 idle，since 还是最早那次', () => {
    const act = new MemberActivity()
    const w1 = start(act, 'chat_wait', T0 + 1000)
    end(act, w1, 'chat_wait', T0 + 51_000)
    expect(act.status(A, facts(T0 + 53_000))).toMatchObject({ status: 'waiting', since: T0 + 1000 })
    const w2 = start(act, 'chat_wait', T0 + 54_000)
    expect(act.status(A, facts(T0 + 60_000, { waiting: true }))).toMatchObject({ status: 'waiting', since: T0 + 1000 })
    end(act, w2, 'chat_wait', T0 + 104_000)
    // 等完超过 20 秒没再等：idle
    expect(act.status(A, facts(T0 + 104_001 + MEMBER_GRACE_MS)).status).toBe('idle')
  })

  it('等完以后去干活：按最后结束的那个算', () => {
    const act = new MemberActivity()
    const w = start(act, 'chat_wait', T0 + 1000)
    end(act, w, 'chat_wait', T0 + 5000)
    const r = start(act, 'read_file', T0 + 6000)
    end(act, r, 'read_file', T0 + 7000)
    expect(act.status(A, facts(T0 + 8000))).toMatchObject({ status: 'working', tool: 'read_file', calling: false })
  })

  it('干完活以后去等了一小会儿：两个窗口都没过，按最后结束的那个算 waiting', () => {
    const act = new MemberActivity()
    const r = start(act, 'read_file', T0 + 1000)
    end(act, r, 'read_file', T0 + 2000)
    const w = start(act, 'chat_wait', T0 + 3000)
    end(act, w, 'chat_wait', T0 + 5000)
    const st = act.status(A, facts(T0 + 6000))
    expect(st).toMatchObject({ status: 'waiting', since: T0 + 3000 })
    expect(st.tool).toBeUndefined()
  })

  it('没有 chat_wait 事件却在等（直接调 ChatStore）：since 是第一次看到的时间，之后不变；不等了就清掉', () => {
    const act = new MemberActivity()
    expect(act.status(A, facts(T0 + 1000, { waiting: true }))).toMatchObject({ status: 'waiting', since: T0 + 1000 })
    expect(act.status(A, facts(T0 + 9000, { waiting: true })).since).toBe(T0 + 1000)
    expect(act.status(A, facts(T0 + 10_000)).status).toBe('idle')
    expect(act.status(A, facts(T0 + 20_000, { waiting: true })).since).toBe(T0 + 20_000)
  })

  it('没在调工具但有后台命令在跑：command，background=true，since 是最早那条命令的开始时间；不会变 stale', () => {
    const act = new MemberActivity()
    const st = act.status(A, facts(T0 + 30 * MIN, { commands: [T0 + 5000, T0 + 2000] }))
    expect(st).toMatchObject({ status: 'command', background: true, since: T0 + 2000, commands: 2 })
    expect(st.calling).toBeUndefined()
    // 正在调工具时还是 working，后台命令数照带
    start(act, 'read_file', T0 + 31 * MIN)
    expect(act.status(A, facts(T0 + 31 * MIN + 10, { commands: [T0 + 2000] }))).toMatchObject({ status: 'working', commands: 1 })
  })

  it('超过 10 分钟没有任何请求、也不在等消息：stale，since 是满 10 分钟的那一刻；正好 10 分钟还是 idle', () => {
    const act = new MemberActivity()
    expect(act.status(A, facts(T0 + MEMBER_STALE_MS)).status).toBe('idle')
    expect(act.status(A, facts(T0 + MEMBER_STALE_MS + 1))).toMatchObject({ status: 'stale', since: T0 + MEMBER_STALE_MS, lastSeen: T0 })
    // 有请求就不算（lastSeen 更新了）
    expect(act.status(A, facts(T0 + 20 * MIN, { sessions: [{ lastSeen: T0 + 15 * MIN, createdAt: T0 }] })).status).toBe('idle')
    // 最后的动作是一次工具调用：从调完算起
    const a = start(act, 'read_file', T0 + 2 * MIN)
    end(act, a, 'read_file', T0 + 3 * MIN)
    expect(act.status(A, facts(T0 + 13 * MIN)).status).toBe('idle')
    expect(act.status(A, facts(T0 + 13 * MIN + 1))).toMatchObject({ status: 'stale', since: T0 + 13 * MIN })
  })

  it('在等消息的不算 stale，等多久都是 waiting', () => {
    const act = new MemberActivity()
    start(act, 'chat_wait', T0 + 1000)
    expect(act.status(A, facts(T0 + 14 * MIN, { waiting: true })).status).toBe('waiting')
  })

  it('staleMs 可配置；给 0 或负数用默认值', () => {
    const act = new MemberActivity({ staleMs: 2 * MIN })
    expect(act.status(A, facts(T0 + 2 * MIN)).status).toBe('idle')
    expect(act.status(A, facts(T0 + 2 * MIN + 1))).toMatchObject({ status: 'stale', since: T0 + 2 * MIN })
    expect(new MemberActivity({ staleMs: 0 }).staleMs).toBe(MEMBER_STALE_MS)
    expect(new MemberActivity({ staleMs: -5, graceMs: -1 }).graceMs).toBe(MEMBER_GRACE_MS)
  })

  it('暂停盖过 working、waiting、stale；离线盖过暂停', () => {
    const act = new MemberActivity()
    start(act, 'read_file', T0 + 1000)
    expect(act.status(A, facts(T0 + 2000, { paused: true, pausedSince: T0 + 1500, waiting: true }))).toMatchObject({ status: 'paused', since: T0 + 1500 })
    expect(act.status('a_x', facts(T0 + 30 * MIN, { paused: true, pausedSince: T0 + 1500 })).status).toBe('paused')
    expect(act.status(A, { now: T0 + 2000, sessions: [], paused: true, pausedSince: T0 + 1500 }).status).toBe('offline')
    // 暂停时等恢复（wait_for_resume）不算干活
    const act2 = new MemberActivity()
    start(act2, 'wait_for_resume', T0 + 1000)
    expect(act2.status(A, facts(T0 + 2000)).status).toBe('idle')
  })

  it('内置 AI 没有连接：不算 offline，也不会 stale；在调工具时是 working', () => {
    const act = new MemberActivity()
    expect(act.status(A, { now: T0 + 60 * MIN, sessions: [], builtin: true }).status).toBe('idle')
    start(act, 'read_file', T0 + 61 * MIN)
    expect(act.status(A, { now: T0 + 61 * MIN + 5, sessions: [], builtin: true })).toMatchObject({ status: 'working', tool: 'read_file', sessions: 0 })
  })

  it('手上进行中的任务跟着带出来，最多 5 个；每种状态都带', () => {
    const act = new MemberActivity()
    const tasks = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ ref: `T-${n}`, title: `任务${n}`, workspaceId: 'w1' }))
    const st = act.status(A, facts(T0 + 1000, { tasks }))
    expect(st.tasks?.map((t) => t.ref)).toEqual(['T-1', 'T-2', 'T-3', 'T-4', 'T-5'])
    expect(st.tasks?.[0]).toEqual({ ref: 'T-1', title: '任务1', workspaceId: 'w1' })
    expect(act.status(A, { now: T0, sessions: [], tasks: tasks.slice(0, 1) }).tasks).toHaveLength(1)
    expect(act.status(A, facts(T0 + 1000)).tasks).toBeUndefined()
  })

  it('审计记录（command_audit）不算工具调用', () => {
    const act = new MemberActivity()
    start(act, 'command_audit', T0 + 1000)
    expect(act.status(A, facts(T0 + 2000)).status).toBe('idle')
  })

  it('没见过开始、只来了结束的调用（启动前开始的）也算一次动作', () => {
    const act = new MemberActivity()
    end(act, 'ghost', 'read_file', T0 + 5 * MIN)
    expect(act.status(A, facts(T0 + 5 * MIN + 1000))).toMatchObject({ status: 'working', calling: false, since: T0 + 5 * MIN })
    expect(act.status(A, facts(T0 + 14 * MIN)).status).toBe('idle')
  })

  it('一次调用挂了 15 分钟还没结束：当结束事件丢了，不再算 working', () => {
    const act = new MemberActivity()
    start(act, 'read_file', T0 + 1000)
    expect(act.status(A, facts(T0 + 1000 + MEMBER_CALL_MAX_MS, { sessions: [{ lastSeen: T0 + 1000 + MEMBER_CALL_MAX_MS, createdAt: T0 }] })).status).toBe('working')
    const st = act.status(A, facts(T0 + 1001 + MEMBER_CALL_MAX_MS, { sessions: [{ lastSeen: T0 + 1000 + MEMBER_CALL_MAX_MS, createdAt: T0 }] }))
    expect(st.status).toBe('idle')
  })

  it('forget：吊销后记录清掉', () => {
    const act = new MemberActivity()
    start(act, 'read_file', T0 + 1000)
    act.forget(A)
    expect(act.status(A, facts(T0 + 1500)).status).toBe('idle')
  })

  it('since 不会跑到 now 之后', () => {
    const act = new MemberActivity()
    expect(act.status(A, facts(T0 - 5000)).since).toBe(T0 - 5000)
  })
})

describe('派活提示、状态说法、掉线盯防', () => {
  const st = (s: Partial<MemberStatus> & Pick<MemberStatus, 'status'>): MemberStatus => ({ sessions: 1, ...s })

  it('memberHint：stale 和 offline 才有提示，带上多久没动静', () => {
    const now = T0 + 30 * MIN
    expect(memberHint('Bob', st({ status: 'stale', since: now - 2 * MIN }), now)).toBe(
      '提示：Bob 可能掉线了（12 分钟没有动作，也不在等消息），这条通知要等它下次调用工具才收得到'
    )
    expect(memberHint('Bob', st({ status: 'stale', since: now - 2 * MIN }), now, 5 * MIN)).toContain('7 分钟没有动作')
    expect(memberHint('Bob', st({ status: 'offline', since: now - 7 * MIN, sessions: 0 }), now)).toBe(
      '提示：Bob 已经离线 7 分钟，要等它重新连上并调用工具才收得到这条通知'
    )
    expect(memberHint('Bob', st({ status: 'offline', sessions: 0 }), now)).toContain('Bob 现在不在线')
    for (const s of ['working', 'command', 'waiting', 'idle', 'paused'] as const) expect(memberHint('Bob', st({ status: s }), now)).toBeUndefined()
  })

  it('describeMemberStatus：每种状态一句话', () => {
    expect(describeMemberStatus(st({ status: 'working', tool: 'grep' }))).toBe('工作中（grep）')
    expect(describeMemberStatus(st({ status: 'working' }))).toBe('工作中')
    expect(describeMemberStatus(st({ status: 'command' }))).toBe('正在跑命令')
    expect(describeMemberStatus(st({ status: 'command', background: true }))).toBe('后台命令在跑')
    expect(describeMemberStatus(st({ status: 'waiting' }))).toBe('在等消息')
    expect(describeMemberStatus(st({ status: 'idle' }))).toBe('空闲')
    expect(describeMemberStatus(st({ status: 'stale' }))).toBe('可能掉线')
    expect(describeMemberStatus(st({ status: 'offline' }))).toBe('离线')
    expect(describeMemberStatus(st({ status: 'paused' }))).toBe('已暂停')
  })

  it('memberGone：stale 算；offline 要知道离线时间并且满了 staleMs 才算', () => {
    const now = T0 + 30 * MIN
    expect(memberGone(st({ status: 'stale' }), now)).toBe(true)
    expect(memberGone(st({ status: 'offline', since: now - MEMBER_STALE_MS }), now)).toBe(true)
    expect(memberGone(st({ status: 'offline', since: now - MEMBER_STALE_MS + 1 }), now)).toBe(false)
    expect(memberGone(st({ status: 'offline', since: now - 3 * MIN }), now, 2 * MIN)).toBe(true)
    expect(memberGone(st({ status: 'offline' }), now)).toBe(false)
    expect(memberGone(st({ status: 'idle' }), now)).toBe(false)
    expect(memberGone(st({ status: 'waiting' }), now)).toBe(false)
  })

  it('StaleWatch：一段没动静的时间里每个任务只报一次；新挂上的任务再报；有动静后清零', () => {
    const w = new StaleWatch()
    const t1 = { ref: 'T-1', title: '一', workspaceId: 'w1' }
    const t2 = { ref: 'T-2', title: '二', workspaceId: 'w1' }
    const t1other = { ref: 'T-1', title: '别的工作区的', workspaceId: 'w2' }
    expect(w.check(A, false, [t1])).toEqual([])
    expect(w.check(A, true, [t1])).toEqual([t1])
    expect(w.check(A, true, [t1])).toEqual([])
    expect(w.check(A, true, [t1, t2, t1other])).toEqual([t2, t1other])
    // 别的成员各算各的
    expect(w.check('a_alice', true, [t1])).toEqual([t1])
    // 有动静了：清零，下次没动静重新报
    expect(w.check(A, false, [t1, t2])).toEqual([])
    expect(w.check(A, true, [t1])).toEqual([t1])
    w.forget(A)
    expect(w.check(A, true, [t1])).toEqual([t1])
  })
})

// ===== 经过 Bridge =====

let base: string
let bridge: Bridge
let url: string
let skew = 0
const clients: Client[] = []
interface Result {
  isError: boolean
  data: any
  notices: string
}

async function connect(token: string, query = ''): Promise<Client> {
  const c = new Client({ name: 'member-status-test', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url + query), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  clients.push(c)
  return c
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const r = await c.callTool({ name, arguments: args })
  const parts = (r.content as { type: string; text: string }[]).map((p) => p.text)
  const body = parts.find((t) => !t.startsWith('【通知】')) ?? ''
  let data: unknown = body
  try {
    data = JSON.parse(body)
  } catch {
    // 纯文本
  }
  return { isError: Boolean(r.isError), data, notices: parts.filter((t) => t.startsWith('【通知】')).join('\n') }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const wsChannel = (): string => `ws:${bridge.getState().activeWorkspaceId}`
const statusOf = (a: Agent): MemberStatus => bridge.memberStatuses()[a.id]

describe('经过 Bridge：状态进了 BridgeState，掉线会提醒', () => {
  let a: { agent: Agent; c: Client }
  let b: { agent: Agent; c: Client }
  let carol: Agent
  let notices: { agentId: string; text: string }[]

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-member-status-'))
    const root = path.join(base, 'ws')
    fs.mkdirSync(root, { recursive: true })
    skew = 0
    bridge = new Bridge({
      dataDir: path.join(base, 'data'),
      workspaceRoot: root,
      port: 0,
      userSkillsDir: path.join(base, 'skills'),
      // 不起定时检查，测试里自己调 tickMemberStatus；时钟可以往后拨
      memberStatus: { timers: false, now: () => Date.now() + skew }
    })
    await bridge.start()
    url = bridge.getState().mcpUrl
    notices = []
    bridge.on('notice', (agentId: string, text: string) => notices.push({ agentId, text }))
    const aa = bridge.createAgent('Alice')
    const bb = bridge.createAgent('Bob')
    carol = bridge.createAgent('Carol')
    a = { agent: aa, c: await connect(aa.token) }
    b = { agent: bb, c: await connect(bb.token) }
  })

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.stop()
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
  })

  it('BridgeState.memberStatus 里每个成员都有（含没连过的）；presence 里带同一份', () => {
    const st = bridge.getState()
    expect(Object.keys(st.memberStatus ?? {}).sort()).toEqual([a.agent.id, b.agent.id, carol.id].sort())
    expect(st.memberStatus?.[a.agent.id]).toMatchObject({ status: 'idle', sessions: 1 })
    expect(st.memberStatus?.[carol.id]).toEqual({ status: 'offline', sessions: 0 })
    const p = st.presence.find((x) => x.agentId === a.agent.id)
    expect(p?.status?.status).toBe('idle')
    // 原有字段不变
    expect(p).toMatchObject({ agentId: a.agent.id, sessions: 1 })
  })

  it('调用工具的那一刻是 working（带工具名），调完的 20 秒里还是 working，之后 idle', async () => {
    const during: MemberStatus[] = []
    const states: BridgeState[] = []
    bridge.on('event', (ev: { agentId: string; tool: string; status: string }) => {
      if (ev.tool === 'whoami' && ev.status === 'running') during.push(statusOf(a.agent))
    })
    bridge.on('state', (s: BridgeState) => states.push(s))
    const t0 = Date.now()
    await call(a.c, 'whoami')
    expect(during).toHaveLength(1)
    expect(during[0]).toMatchObject({ status: 'working', tool: 'whoami', calling: true })
    expect(during[0].since).toBeGreaterThanOrEqual(t0)
    // 推给界面的状态里也看得到
    expect(states.some((s) => s.memberStatus?.[a.agent.id]?.status === 'working' && s.memberStatus[a.agent.id].calling === true)).toBe(true)
    expect(statusOf(a.agent)).toMatchObject({ status: 'working', tool: 'whoami', calling: false })
    expect(statusOf(b.agent).status).toBe('idle')
    skew = MEMBER_GRACE_MS + 1000
    expect(statusOf(a.agent).status).toBe('idle')
    expect(statusOf(a.agent).tool).toBeUndefined()
  })

  it('chat_wait 等着的时候是 waiting；等完马上再看还是 waiting（一轮接一轮地等不闪）', async () => {
    const p = call(a.c, 'chat_wait', { timeout_ms: 600 })
    await sleep(150)
    const st = statusOf(a.agent)
    expect(st.status).toBe('waiting')
    expect(st.since).toBeLessThanOrEqual(Date.now())
    expect(bridge.getState().memberStatus?.[a.agent.id].status).toBe('waiting')
    await p
    expect(statusOf(a.agent).status).toBe('waiting')
    skew = MEMBER_GRACE_MS + 1000
    expect(statusOf(a.agent).status).toBe('idle')
  })

  it('只有副连接在等消息：本人不算 waiting；主连接直接在 ChatStore 里等也算 waiting', async () => {
    const ac = new AbortController()
    const proxy = bridge.chat.receive(chatReaderKey(a.agent.id, 'proxy'), { channels: [wsChannel()], timeoutMs: 5000, signal: ac.signal })
    await sleep(20)
    expect(bridge.chat.waiting(a.agent.id)).toBe(1)
    expect(bridge.chat.waiting(a.agent.id, true)).toBe(0)
    expect(statusOf(a.agent).status).toBe('idle')
    const main = bridge.chat.receive(a.agent.id, { channels: [wsChannel()], timeoutMs: 5000, signal: ac.signal })
    await sleep(20)
    expect(bridge.chat.waiting(a.agent.id, true)).toBe(1)
    expect(statusOf(a.agent).status).toBe('waiting')
    ac.abort()
    await Promise.all([proxy, main])
    expect(statusOf(a.agent).status).toBe('idle')
  })

  it('10 分钟没动静变 stale；正在等消息的不会；再调一次工具就回来', async () => {
    skew = MEMBER_STALE_MS + 5000
    const st = statusOf(a.agent)
    expect(st.status).toBe('stale')
    expect(st.since).toBeLessThanOrEqual(Date.now() + skew)
    expect(statusOf(carol).status).toBe('offline')
    const ac = new AbortController()
    const w = bridge.chat.receive(b.agent.id, { channels: [wsChannel()], timeoutMs: 5000, signal: ac.signal })
    await sleep(20)
    expect(statusOf(b.agent).status).toBe('waiting')
    ac.abort()
    await w
    await call(a.c, 'whoami')
    expect(statusOf(a.agent).status).toBe('working')
  })

  it('staleMs 可以在 BridgeOptions 里改', async () => {
    const root2 = path.join(base, 'ws2')
    fs.mkdirSync(root2, { recursive: true })
    const other = new Bridge({
      dataDir: path.join(base, 'data2'),
      workspaceRoot: root2,
      port: 0,
      userSkillsDir: path.join(base, 'skills2'),
      memberStatus: { timers: false, staleMs: 60_000, now: () => Date.now() + skew }
    })
    await other.start()
    try {
      const x = other.createAgent('X')
      const c = new Client({ name: 'member-status-test', version: '1.0.0' })
      await c.connect(new StreamableHTTPClientTransport(new URL(other.getState().mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${x.token}` } } }))
      clients.push(c)
      skew = 30_000
      expect(other.memberStatuses()[x.id].status).toBe('idle')
      skew = 65_000
      expect(other.memberStatuses()[x.id].status).toBe('stale')
      // 提示里的分钟数也按改过的 staleMs 算
      expect(other.assigneeHint(x.id)).toContain('X 可能掉线了（1 分钟没有动作')
    } finally {
      for (const c of clients.splice(0)) await c.close().catch(() => {})
      await other.stop()
    }
  })

  it('断开连接变 offline，since 是断开的时间；重新连上回到 idle', async () => {
    const t0 = Date.now()
    await bridge.disconnectAgent(a.agent.id)
    const st = statusOf(a.agent)
    expect(st.status).toBe('offline')
    expect(st.since).toBeGreaterThanOrEqual(t0)
    expect(st.since).toBeLessThanOrEqual(Date.now())
    expect(bridge.getState().memberStatus?.[a.agent.id].status).toBe('offline')
    a.c = await connect(a.agent.token)
    expect(statusOf(a.agent).status).toBe('idle')
    // 再断一次，since 是新的
    await sleep(15)
    const t1 = Date.now()
    await bridge.disconnectAgent(a.agent.id)
    expect(statusOf(a.agent).since).toBeGreaterThanOrEqual(t1)
  })

  it('只剩副连接：offline，readers 里有它', async () => {
    await connect(a.agent.token, '?reader=proxy')
    expect(statusOf(a.agent)).toMatchObject({ status: 'idle', sessions: 2, readers: ['proxy'] })
    const main = bridge.listAgentSessions(a.agent.id).find((s) => !s.reader)!
    const t0 = Date.now()
    await bridge.disconnectAgent(a.agent.id, main.id)
    expect(statusOf(a.agent)).toMatchObject({ status: 'offline', sessions: 1, readers: ['proxy'] })
    // 离线时间从主连接断开算起，副连接还在不影响
    expect(statusOf(a.agent).since).toBeGreaterThanOrEqual(t0)
  })

  it('工作台暂停：连着的都是 paused，带暂停的时间；没连的还是 offline；恢复后回去', async () => {
    const t0 = Date.now()
    bridge.setPaused(true)
    const st = statusOf(a.agent)
    expect(st.status).toBe('paused')
    expect(st.since).toBeGreaterThanOrEqual(t0)
    expect(statusOf(carol).status).toBe('offline')
    const since = st.since
    await sleep(15)
    expect(statusOf(a.agent).since).toBe(since)
    bridge.setPaused(false)
    expect(statusOf(a.agent).status).toBe('idle')
    // 再暂停，时间重新记
    await sleep(15)
    bridge.setPaused(true)
    expect(statusOf(a.agent).since).toBeGreaterThan(since!)
  })

  it('手上进行中的任务带在状态里；交出去以后就没了', async () => {
    const t = bridge.createTask({ title: '修登录', assigneeId: b.agent.id })
    expect(statusOf(b.agent).tasks).toBeUndefined()
    await call(b.c, 'task_update', { task: t.id, status: 'in_progress' })
    expect(statusOf(b.agent).tasks).toEqual([{ ref: t.ref, title: '修登录', workspaceId: bridge.getState().activeWorkspaceId }])
    expect(bridge.getState().memberStatus?.[b.agent.id].tasks?.[0].ref).toBe(t.ref)
    expect(statusOf(a.agent).tasks).toBeUndefined()
    await call(b.c, 'task_update', { task: t.id, status: 'review', result: '好了' })
    expect(statusOf(b.agent).tasks).toBeUndefined()
  })

  it('team 列表（给 team_list 用）运行时带上 status、since、tool、tasks', async () => {
    const t = bridge.createTask({ title: '修登录', assigneeId: b.agent.id })
    await call(b.c, 'task_update', { task: t.id, status: 'in_progress' })
    const team = (bridge as unknown as { teamMembers: () => Record<string, unknown>[] }).teamMembers()
    const bob = team.find((m) => m.id === b.agent.id)!
    expect(bob).toMatchObject({ name: 'Bob', online: true, status: 'working', tool: 'task_update', tasks: [t.ref] })
    expect(typeof bob.since).toBe('number')
    const c3 = team.find((m) => m.id === carol.id)!
    expect(c3).toMatchObject({ name: 'Carol', online: false, status: 'offline' })
    expect(c3.since).toBeUndefined()
    expect(c3.tasks).toBeUndefined()
  })

  it('assigneeHint：对方正常时没有提示；stale、offline 时有一句', async () => {
    expect(bridge.assigneeHint(b.agent.id)).toBeUndefined()
    expect(bridge.assigneeHint(carol.id)).toContain('Carol 现在不在线')
    expect(bridge.assigneeHint('nobody')).toBeUndefined()
    skew = MEMBER_STALE_MS + 2 * MIN
    expect(bridge.assigneeHint(b.agent.id)).toContain('Bob 可能掉线了（12 分钟没有动作')
    await bridge.disconnectAgent(b.agent.id)
    skew += 3 * MIN
    expect(bridge.assigneeHint(b.agent.id)).toContain('Bob 已经离线 3 分钟')
  })

  it('挂着进行中任务的成员没动静了：通知派活的人，只报一次；它回来再掉线会再报', async () => {
    const made = await call(a.c, 'task_create', { title: '修登录' })
    expect(made.isError).toBe(false)
    await call(b.c, 'task_claim', { task: made.data.id })
    await call(b.c, 'task_update', { task: made.data.id, status: 'in_progress' })
    await call(a.c, 'whoami')
    notices.length = 0
    bridge.tickMemberStatus()
    expect(notices).toEqual([])

    skew = MEMBER_STALE_MS + 2 * MIN
    bridge.tickMemberStatus()
    expect(notices).toHaveLength(1)
    expect(notices[0].agentId).toBe(a.agent.id)
    expect(notices[0].text).toContain('Bob 可能掉线了：已经 12 分钟没有动作，也不在等消息')
    expect(notices[0].text).toContain(`${made.data.ref}「修登录」`)
    // 通知进了派活人的队列，下次调用工具带回去
    const r = await call(a.c, 'whoami')
    expect(r.notices).toContain('Bob 可能掉线了')
    // 之后的检查不重复报
    bridge.tickMemberStatus()
    skew += MIN
    bridge.tickMemberStatus()
    expect(notices).toHaveLength(1)

    // Bob 回来干了点活，然后又没动静
    await call(b.c, 'whoami')
    bridge.tickMemberStatus()
    expect(notices).toHaveLength(1)
    skew += MEMBER_STALE_MS + MIN
    bridge.tickMemberStatus()
    expect(notices).toHaveLength(2)
    expect(notices[1].agentId).toBe(a.agent.id)
  })

  it('离线超过 10 分钟也报，说的是离线；刚断开不报', async () => {
    const made = await call(a.c, 'task_create', { title: '写文档' })
    await call(b.c, 'task_claim', { task: made.data.id })
    await call(b.c, 'task_update', { task: made.data.id, status: 'in_progress' })
    notices.length = 0
    await bridge.disconnectAgent(b.agent.id)
    skew = 3 * MIN
    bridge.tickMemberStatus()
    expect(notices).toEqual([])
    skew = MEMBER_STALE_MS + MIN
    bridge.tickMemberStatus()
    expect(notices).toHaveLength(1)
    expect(notices[0].text).toContain('Bob 已经离线 11 分钟')
    expect(notices[0].text).toContain('写文档')
  })

  it('不报的情况：任务已经交审；派活的是用户（含别人建、用户改派的）；派活的就是它自己；它在等消息', async () => {
    // 用户派的，进行中
    const byUser = bridge.createTask({ title: '用户派的', assigneeId: b.agent.id })
    await call(b.c, 'task_update', { task: byUser.id, status: 'in_progress' })
    // Alice 建的，Bob 做完交审了（不是进行中）
    const handed = await call(a.c, 'task_create', { title: '已经交审' })
    await call(b.c, 'task_claim', { task: handed.data.id })
    await call(b.c, 'task_update', { task: handed.data.id, status: 'review', result: '好了' })
    // Alice 建的，但是用户在工作台里派给 Bob 的：派活的人是用户，不通知 Alice
    const reassigned = await call(a.c, 'task_create', { title: '用户改派的' })
    bridge.assignTask(reassigned.data.id, b.agent.id)
    await call(b.c, 'task_update', { task: reassigned.data.id, status: 'in_progress' })
    // Alice 自己建自己做
    const own = await call(a.c, 'task_create', { title: '自己的' })
    await call(a.c, 'task_claim', { task: own.data.id })
    await call(a.c, 'task_update', { task: own.data.id, status: 'in_progress' })
    notices.length = 0
    skew = MEMBER_STALE_MS + MIN
    bridge.tickMemberStatus()
    expect(notices).toEqual([])

    // 在等消息的不算没动静
    const made = await call(a.c, 'task_create', { title: '等着的' })
    await call(b.c, 'task_claim', { task: made.data.id })
    await call(b.c, 'task_update', { task: made.data.id, status: 'in_progress' })
    notices.length = 0
    const ac = new AbortController()
    const w = bridge.chat.receive(b.agent.id, { channels: [wsChannel()], timeoutMs: 5000, signal: ac.signal })
    await sleep(20)
    skew += MEMBER_STALE_MS + MIN
    bridge.tickMemberStatus()
    expect(notices).toEqual([])
    ac.abort()
    await w
  })

  it('定时检查发现状态变了才推界面；没变不推', async () => {
    bridge.tickMemberStatus()
    const states: BridgeState[] = []
    bridge.on('state', (s: BridgeState) => states.push(s))
    bridge.tickMemberStatus()
    expect(states).toHaveLength(0)
    skew = MEMBER_STALE_MS + MIN
    bridge.tickMemberStatus()
    expect(states).toHaveLength(1)
    expect(states[0].memberStatus?.[a.agent.id].status).toBe('stale')
    bridge.tickMemberStatus()
    expect(states).toHaveLength(1)
  })

  it('吊销成员：状态里没有它了', async () => {
    await call(b.c, 'whoami')
    await bridge.removeAgent(b.agent.id)
    expect(bridge.memberStatuses()[b.agent.id]).toBeUndefined()
    expect(Object.keys(bridge.getState().memberStatus ?? {})).not.toContain(b.agent.id)
  })

  it('默认会起定时检查，stop 时停掉（不留定时器）', async () => {
    const root3 = path.join(base, 'ws3')
    fs.mkdirSync(root3, { recursive: true })
    const other = new Bridge({ dataDir: path.join(base, 'data3'), workspaceRoot: root3, port: 0, userSkillsDir: path.join(base, 'skills3') })
    const timer = (): unknown => (other as unknown as { statusTimer: unknown }).statusTimer
    expect(timer()).toBeNull()
    await other.start()
    expect(timer()).not.toBeNull()
    await other.stop()
    expect(timer()).toBeNull()
    // 关掉的就不起
    expect((bridge as unknown as { statusTimer: unknown }).statusTimer).toBeNull()
  })
})
