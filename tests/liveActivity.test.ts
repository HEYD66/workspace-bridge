// 会话最下面的「他在干什么」：谁该列出来、写什么、做过哪几步
import { describe, expect, it } from 'vitest'
import type { ActivityEvent, Agent, GroupMessage, MemberStatus } from '../src/core/types'
import { audienceOf, eventText, foldWaits, headerStatus, lastHeaders, LINGER_MS, liveActivity, MAX_ROWS, OWES_WINDOW_MS } from '../src/renderer/src/lib/liveActivity'

const T0 = 1_700_000_000_000
const SEC = 1000
const MIN = 60_000

const agent = (id: string, name: string): Agent => ({ id, name, color: '#58a6ff', token: 't', createdAt: 0 }) as Agent
const A = agent('a', 'Alice')
const B = agent('b', 'Bob')
const C = agent('c', 'Carol')
let seq = 0
const msg = (from: 'user' | string, ts: number, extra: Partial<GroupMessage> = {}): GroupMessage =>
  ({ id: `m${++seq}`, seq, channel: 'ws:w', ts, from: from === 'user' ? { kind: 'user', id: 'user', name: '你' } : { kind: 'agent', id: from, name: from }, text: 'x', mentions: [], ...extra }) as GroupMessage
const ev = (agentId: string, tool: string, ts: number, extra: Partial<ActivityEvent> = {}): ActivityEvent => ({ id: `e${++seq}`, ts, agentId, agentName: agentId, agentColor: '#fff', tool, args: {}, status: 'ok', ...extra }) as ActivityEvent
const st = (status: MemberStatus['status'], extra: Partial<MemberStatus> = {}): MemberStatus => ({ status, sessions: 1, ...extra })

describe('eventText', () => {
  it('工具的中文名加上它在弄什么：路径、命令、搜索词；没有就只有名字', () => {
    expect(eventText({ tool: 'read_file', path: 'src/a.ts', args: {} })).toBe('读取 src/a.ts')
    expect(eventText({ tool: 'run_command', args: { command: 'npm   test\n--watch' } })).toBe('执行命令 npm test --watch')
    expect(eventText({ tool: 'search_files', args: { pattern: 'TODO' } })).toContain('TODO')
    expect(eventText({ tool: 'whoami', args: {} })).toBe('确认身份')
    const long = eventText({ tool: 'run_command', args: { command: 'x'.repeat(200) } })
    expect(long.length).toBeLessThan(70)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('audienceOf', () => {
  const all = [A, B, C]
  it('灵感激荡没挑人：全部；挑过人：那几个；分工明确：只有主脑', () => {
    expect(audienceOf(all, {})).toEqual(all)
    expect(audienceOf(all, { partIds: ['a', 'c'] })).toEqual([A, C])
    expect(audienceOf(all, { leadId: 'b' })).toEqual([B])
  })
  it('这句话里 @ 了谁再加上谁，@所有人 就是全部；私聊只有那一个', () => {
    expect(audienceOf(all, { leadId: 'b' }, msg('user', T0, { mentions: ['c'] }))).toEqual([B, C])
    expect(audienceOf(all, { partIds: ['a'] }, msg('user', T0, { mentions: ['*'] }))).toEqual(all)
    expect(audienceOf(all, {}, msg('user', T0, { to: 'c' }))).toEqual([C])
  })
})

describe('liveActivity', () => {
  const base = { members: [A, B], events: [] as ActivityEvent[] }

  it('工作台不给细分状态：什么都不摆', () => {
    expect(liveActivity({ ...base, messages: [msg('user', T0)], status: undefined, now: T0 + SEC })).toEqual({ rows: [], more: 0, offline: [] })
  })

  it('你刚说完话：在线的列出来（在等消息 / 没有动作），不在线的收成一句', () => {
    const v = liveActivity({ ...base, messages: [msg('user', T0)], status: { a: st('waiting', { since: T0 - MIN }) }, now: T0 + 5 * SEC })
    expect(v.rows).toHaveLength(1)
    expect(v.rows[0]).toMatchObject({ agentId: 'a', name: 'Alice', kind: 'waiting', text: '在等消息', since: T0 - MIN, busy: false, steps: [], stepCount: 0 })
    expect(v.offline).toEqual(['Bob'])
    const idle = liveActivity({ ...base, messages: [msg('user', T0)], status: { a: st('idle'), b: st('stale', { lastSeen: T0 - 12 * MIN }) }, now: T0 + SEC })
    expect(idle.rows.map((r) => [r.agentId, r.text])).toEqual([
      ['a', '在线，没有动作'],
      ['b', '可能卡住（12 分钟没有动静）']
    ])
  })

  it('它在干活：写正在干什么（在途的那次调用），转圈；这一轮做过的步骤列最近三个', () => {
    const events = [
      ev('a', 'whoami', T0 + 1 * SEC),
      ev('a', 'read_file', T0 + 2 * SEC, { path: 'a.ts' }),
      ev('a', 'read_file', T0 + 3 * SEC, { path: 'b.ts' }),
      ev('a', 'search_files', T0 + 4 * SEC, { args: { pattern: 'TODO' } }),
      ev('a', 'edit_file', T0 + 5 * SEC, { path: 'c.ts' }),
      ev('a', 'run_command', T0 + 6 * SEC, { status: 'running', args: { command: 'npm test' } }),
      ev('a', 'read_file', T0 - MIN, { path: 'old.ts' }),
      ev('b', 'read_file', T0 + 2 * SEC, { path: 'bob.ts' })
    ]
    const v = liveActivity({ members: [A], events, messages: [msg('user', T0)], status: { a: st('command', { tool: 'run_command', calling: true }) }, now: T0 + 9 * SEC })
    expect(v.rows[0]).toMatchObject({ kind: 'command', text: '正在执行命令 npm test', since: T0 + 6 * SEC, busy: true, stepCount: 4 })
    expect(v.rows[0].steps).toEqual(['读取 b.ts', expect.stringContaining('TODO'), '编辑 c.ts'])
  })

  it('回过话、手上没活：不列；回过话但还在跑命令：还列着', () => {
    const messages = [msg('user', T0), msg('a', T0 + 10 * SEC)]
    expect(liveActivity({ ...base, messages, status: { a: st('waiting'), b: st('waiting') }, now: T0 + 20 * SEC }).rows.map((r) => r.agentId)).toEqual(['b'])
    // 刚调完的那 20 秒（working，calling=false）不算在干活
    expect(liveActivity({ members: [A], events: [], messages, status: { a: st('working', { tool: 'chat_send', calling: false }) }, now: T0 + 12 * SEC }).rows).toEqual([])
    // 等消息、发消息的调用在途也不算
    expect(liveActivity({ members: [A], events: [ev('a', 'chat_wait', T0 + 11 * SEC, { status: 'running' })], messages, status: { a: st('working', { tool: 'chat_wait', calling: true }) }, now: T0 + 12 * SEC }).rows).toEqual([])
    const still = liveActivity({ members: [A], events: [], messages, status: { a: st('command', { background: true, commands: 1 }) }, now: T0 + 20 * SEC })
    expect(still.rows.map((r) => [r.agentId, r.busy])).toEqual([['a', true]])
    // 命令刚跑完（command，calling=false，不是后台的）：不转圈；还没回话就写「刚…完」
    expect(liveActivity({ members: [A], events: [], messages, status: { a: st('command', { tool: 'run_command', calling: false }) }, now: T0 + 20 * SEC }).rows).toEqual([])
    const just = liveActivity({ members: [A], events: [ev('a', 'run_command', T0 + SEC, { args: { command: 'npm test' } }), ev('a', 'command_audit', T0 + SEC, { args: { command: 'npm test' } })], messages: [msg('user', T0)], status: { a: st('command', { tool: 'run_command', calling: false }) }, now: T0 + 3 * SEC })
    expect(just.rows[0]).toMatchObject({ text: '刚做完：执行命令', busy: false, stepCount: 1, steps: ['执行命令 npm test'] })
    // 刚调完的是确认身份、发消息这类：只说在线
    expect(liveActivity({ members: [A], events: [], messages: [msg('user', T0)], status: { a: st('working', { tool: 'whoami', calling: false }) }, now: T0 + SEC }).rows[0]).toMatchObject({ text: '在线，没有动作', busy: false })
  })

  it('回执和自动记的事件不算你说的话，也不算它回的话', () => {
    const messages = [msg('user', T0), msg('a', T0 + SEC, { kind: 'receipt' }), msg('user', T0 + 2 * SEC, { kind: 'event' })]
    const v = liveActivity({ members: [A], events: [], messages, status: { a: st('waiting') }, now: T0 + 5 * SEC })
    expect(v.rows.map((r) => r.agentId)).toEqual(['a'])
    // 步骤从你真正说的那句算起
    expect(liveActivity({ members: [A], events: [ev('a', 'read_file', T0 + SEC, { path: 'x.ts' })], messages, status: { a: st('waiting') }, now: T0 + 5 * SEC }).rows[0].stepCount).toBe(1)
  })

  it('只看这句话会送到的 AI：挑过参与者就只有他们；私聊只有那一个', () => {
    const status = { a: st('waiting'), b: st('waiting'), c: st('waiting') }
    expect(liveActivity({ members: [A, B, C], events: [], messages: [msg('user', T0)], status, now: T0 + SEC, partIds: ['a'] }).rows.map((r) => r.agentId)).toEqual(['a'])
    expect(liveActivity({ members: [A, B, C], events: [], messages: [msg('user', T0)], status, now: T0 + SEC, leadId: 'b' }).rows.map((r) => r.agentId)).toEqual(['b'])
    expect(liveActivity({ members: [A, B, C], events: [], messages: [msg('user', T0, { to: 'c' })], status, now: T0 + SEC }).rows.map((r) => r.agentId)).toEqual(['c'])
    // 没参与的不在线也不提
    expect(liveActivity({ members: [A, B, C], events: [], messages: [msg('user', T0)], status: { a: st('waiting') }, now: T0 + SEC, partIds: ['a'] }).offline).toEqual([])
  })

  it('过了半小时还没回：不再等；没人说过话：只列真在干活的', () => {
    const status = { a: st('waiting'), b: st('working', { tool: 'read_file', calling: true }) }
    const late = liveActivity({ ...base, messages: [msg('user', T0)], status, now: T0 + OWES_WINDOW_MS + SEC })
    expect(late.rows.map((r) => r.agentId)).toEqual(['b'])
    expect(late.offline).toEqual([])
    expect(liveActivity({ ...base, messages: [], status, now: T0 }).rows.map((r) => [r.agentId, r.text])).toEqual([['b', '正在读取']])
  })

  it('很久以前开始、一直没结束的调用不当成在途；不在线的 AI 也没有在途的调用', () => {
    const stuck = [ev('a', 'run_command', T0 - 2 * OWES_WINDOW_MS, { status: 'running', args: { command: 'sleep' } })]
    expect(liveActivity({ members: [A], events: stuck, messages: [], status: { a: st('idle') }, now: T0 }).rows).toEqual([])
    const fresh = [ev('a', 'run_command', T0 - SEC, { status: 'running', args: { command: 'sleep' } })]
    const v = liveActivity({ members: [A], events: fresh, messages: [msg('user', T0 - 2 * SEC)], status: { a: st('offline') }, now: T0 })
    expect(v.rows).toEqual([])
    expect(v.offline).toEqual(['Alice'])
  })

  it('在干活的排前面；太多就只列四个，剩下的报个数', () => {
    const many = Array.from({ length: 6 }, (_, i) => agent(`x${i}`, `X${i}`))
    const status = Object.fromEntries(many.map((a, i) => [a.id, i === 5 ? st('working', { tool: 'read_file', calling: true }) : st('waiting')]))
    const v = liveActivity({ members: many, events: [], messages: [msg('user', T0)], status, now: T0 + SEC })
    expect(v.rows).toHaveLength(MAX_ROWS)
    expect(v.rows[0].agentId).toBe('x5')
    expect(v.more).toBe(2)
  })

  describe('连着干活：两次调用之间那一行不撤（不然消息一抽一抽）', () => {
    // 你说话，Alice 回了话，然后接着干活：读了一个文件（T0+30 秒开始，用了 2 秒）
    const messages = [msg('user', T0), msg('a', T0 + 10 * SEC)]
    const read = ev('a', 'read_file', T0 + 30 * SEC, { path: 'src/a.ts', durationMs: 2 * SEC })
    const END = T0 + 32 * SEC
    const gap = (now: number, events: ActivityEvent[], status: MemberStatus = st('working', { tool: 'read_file', calling: false }), msgs = messages) => liveActivity({ members: [A], events, messages: msgs, status: { a: status }, now })

    it('调用在途：有那一行，转圈', () => {
      const v = gap(T0 + 31 * SEC, [ev('a', 'read_file', T0 + 30 * SEC, { path: 'src/a.ts', status: 'running' })], st('working', { tool: 'read_file', calling: true }))
      expect(v.rows.map((r) => [r.text, r.busy])).toEqual([['正在读取 src/a.ts', true]])
      expect(v.until).toBeUndefined()
    })

    it('刚调完、下一次还没开始：那一行还在，写「刚做完」，不转圈，从调完那一刻起算时间', () => {
      const v = gap(END + 3 * SEC, [read])
      expect(v.rows).toHaveLength(1)
      expect(v.rows[0]).toMatchObject({ agentId: 'a', text: '刚做完：读取', busy: false, stepCount: 1, steps: ['读取 src/a.ts'] })
      expect(v.until).toBe(END + LINGER_MS)
    })

    it('工作台已经把它算成「在线」了（调完 20 秒以后），一分钟以内还留着', () => {
      const v = gap(END + 45 * SEC, [read], st('idle'))
      expect(v.rows[0]).toMatchObject({ text: '刚做完：读取', busy: false, since: END })
      expect(v.until).toBe(END + LINGER_MS)
    })

    it('过了一分钟还没有新动作：撤掉', () => {
      const v = gap(END + LINGER_MS + 1, [read], st('idle'))
      expect(v.rows).toEqual([])
      expect(v.until).toBeUndefined()
    })

    it('它说了话，或者去等消息了：这一段干完了，马上撤掉', () => {
      expect(gap(END + 3 * SEC, [read, ev('a', 'chat_send', END + 2 * SEC)], st('working', { tool: 'chat_send', calling: false })).rows).toEqual([])
      expect(gap(END + 3 * SEC, [read, ev('a', 'chat_wait', END + 2 * SEC, { status: 'running' })], st('waiting')).rows).toEqual([])
      expect(gap(END + 3 * SEC, [read], st('waiting')).rows).toEqual([])
      expect(gap(END + 3 * SEC, [read], undefined, [...messages, msg('a', END + SEC)]).rows).toEqual([])
    })

    it('中间看了一眼群聊、确认了身份、记了命令日志：不算干完，还留着', () => {
      const v = gap(END + 5 * SEC, [read, ev('a', 'chat_read', END + SEC), ev('a', 'whoami', END + 2 * SEC), ev('a', 'command_audit', END + 3 * SEC)], st('working', { tool: 'whoami', calling: false }))
      expect(v.rows.map((r) => r.text)).toEqual(['刚做完：读取'])
    })

    it('掉线了就不留', () => {
      expect(gap(END + 3 * SEC, [read], st('offline'))).toEqual({ rows: [], more: 0, offline: [] })
    })

    it('两个 AI 一起干活，一个在调用、一个在空当里：两行不来回换位置（都算在干活，按成员顺序）', () => {
      const evB = ev('b', 'read_file', T0 + 31 * SEC, { path: 'src/b.ts', status: 'running' })
      const doneB = { ...evB, status: 'ok' as const, durationMs: 3 * SEC }
      const msgs = [msg('user', T0), msg('a', T0 + 10 * SEC), msg('b', T0 + 11 * SEC)]
      const one = liveActivity({ members: [A, B], events: [read, evB], messages: msgs, status: { a: st('working', { tool: 'read_file', calling: false }), b: st('working', { tool: 'read_file', calling: true }) }, now: END + SEC })
      const runA = ev('a', 'run_command', END + 3 * SEC, { status: 'running' })
      const two = liveActivity({ members: [A, B], events: [read, doneB, runA], messages: msgs, status: { a: st('command', { tool: 'run_command', calling: true }), b: st('working', { tool: 'read_file', calling: false }) }, now: END + 4 * SEC })
      expect(one.rows.map((r) => [r.agentId, r.busy])).toEqual([['a', false], ['b', true]])
      expect(two.rows.map((r) => [r.agentId, r.busy])).toEqual([['a', true], ['b', false]])
    })
  })
})

describe('lastHeaders', () => {
  it('每个 AI 最近一段话的开头那条；你的话、自动记的事件不算', () => {
    const m1 = msg('a', T0)
    const m2 = msg('a', T0 + 1)
    const m3 = msg('user', T0 + 2)
    const m4 = msg('a', T0 + 3)
    const m5 = msg('a', T0 + 4)
    const m6 = msg('b', T0 + 5)
    const m7 = msg('b', T0 + 6, { kind: 'event' })
    const rows = [
      { m: m1, first: true },
      { m: m2, first: false },
      { m: m3, first: true },
      { m: m4, first: true },
      { m: m5, first: false },
      { m: m6, first: true },
      { m: m7, first: true }
    ]
    expect([...lastHeaders(rows)]).toEqual([
      [m4.id, 'a'],
      [m6.id, 'b']
    ])
    expect(lastHeaders([]).size).toBe(0)
  })
})

describe('headerStatus', () => {
  it('只说现在在干什么：真在调工具才写「正在…」；刚调完、等消息、发消息都不算干活', () => {
    expect(headerStatus(st('working', { tool: 'read_file', calling: true }))).toEqual({ text: '正在读取', busy: true })
    expect(headerStatus(st('working', { tool: 'read_file', calling: false }))).toEqual({ text: '在线', busy: false })
    expect(headerStatus(st('working', { tool: 'chat_send', calling: true }))).toEqual({ text: '在线', busy: false })
    expect(headerStatus(st('command', { tool: 'run_command', calling: true }))).toEqual({ text: '正在执行命令', busy: true })
    expect(headerStatus(st('command', { tool: 'run_command', calling: false }))).toEqual({ text: '在线', busy: false })
    expect(headerStatus(st('command', { background: true, commands: 2 }))).toEqual({ text: '后台跑着 2 个命令', busy: true })
    expect(headerStatus(st('waiting'))).toEqual({ text: '在等消息', busy: false })
    expect(headerStatus(st('idle'))).toEqual({ text: '在线', busy: false })
    expect(headerStatus(st('stale', { lastSeen: T0 - 12 * MIN }), T0)).toEqual({ text: '可能卡住（12 分钟没有动静）', busy: false })
    expect(headerStatus(st('paused'))).toEqual({ text: '已暂停', busy: false })
    expect(headerStatus(st('offline'))).toBeUndefined()
  })
})

describe('foldWaits', () => {
  const fmt = { time: (ts: number) => `t${(ts - T0) / SEC}`, duration: (ms: number) => `${ms / SEC}s` }
  const wait = (agentId: string, at: number, extra: Partial<ActivityEvent> = {}): ActivityEvent => ev(agentId, 'chat_wait', T0 + at * SEC, { summary: '等群聊消息：超时', ...extra })

  it('同一个 AI 连着的「等消息超时」合成一条，放在最后一次的位置，写从几点起、多久、几次', () => {
    const list = [wait('a', 0), wait('a', 50), wait('a', 100), wait('a', 150, { status: 'running', summary: undefined })]
    const out = foldWaits(list, fmt)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(list[3].id)
    expect(out[0].status).toBe('running')
    expect(out[0].summary).toBe('在等消息：t0 起，已 150s（4 次，中间没有新消息）')
  })

  it('只有一次的不动；别的 AI 的事不打断；各 AI 各算各的', () => {
    const a1 = wait('a', 0)
    const b1 = wait('b', 10)
    const bRead = ev('b', 'read_file', T0 + 20 * SEC, { path: 'x.ts' })
    const a2 = wait('a', 50)
    const b2 = wait('b', 60)
    const out = foldWaits([a1, b1, bRead, a2, b2], fmt)
    expect(out.map((e) => e.id)).toEqual([b1.id, bRead.id, a2.id, b2.id])
    expect(out[0].summary).toBe('等群聊消息：超时')
    expect(out[2].summary).toBe('在等消息：t0 起，已 50s（2 次，中间没有新消息）')
    expect(out[3].summary).toBe('等群聊消息：超时')
  })

  it('中间等到了消息、或者干了别的事，就从那以后重新算', () => {
    const got = ev('a', 'chat_wait', T0 + 100 * SEC, { summary: '等群聊消息：收到 1 条' })
    const list = [wait('a', 0), wait('a', 50), got, wait('a', 150), wait('a', 200), ev('a', 'chat_send', T0 + 210 * SEC), wait('a', 250)]
    const out = foldWaits(list, fmt)
    expect(out.map((e) => e.summary)).toEqual(['在等消息：t0 起，已 50s（2 次，中间没有新消息）', '等群聊消息：收到 1 条', '在等消息：t150 起，已 50s（2 次，中间没有新消息）', undefined, '等群聊消息：超时'])
    expect(foldWaits([], fmt)).toEqual([])
  })
})
