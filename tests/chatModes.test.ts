// 两种干活方式：灵感激荡（默认，频道里的人都看得到）和分工明确（一个主脑，别的成员只和主脑联系，活由主脑派）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { ChatStore, chatVisible, type ChatMember, type ChatSender } from '../src/core/chat'
import { ToolError } from '../src/core/fileTools'
import { audienceLabel, buildRows, involves, leadOf } from '../src/renderer/src/lib/groupChat'
import type { Agent, BridgeState, GroupMessage } from '../src/core/types'

let base: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-chat-modes-'))
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

let members: ChatMember[]
const ALICE: ChatSender = { kind: 'agent', id: 'a_alice', name: 'Alice' }
const BOB: ChatSender = { kind: 'agent', id: 'a_bob', name: 'Bob' }
const CAROL: ChatSender = { kind: 'agent', id: 'a_carol', name: 'Carol' }
const USER: ChatSender = { kind: 'user', id: 'user', name: '你' }
const WS = 'ws:w_demo'

const store = (): ChatStore => new ChatStore({ dir: path.join(base, 'chat'), members: () => members })
const codeOf = (fn: () => unknown): string => {
  try {
    fn()
    return 'OK'
  } catch (e) {
    return e instanceof ToolError ? e.code : String(e)
  }
}
const texts = (list: { text: string }[]): string[] => list.map((m) => m.text)
/** viewer 在这个频道里看得到的全部消息 */
const sees = (s: ChatStore, viewer: string, channel = WS): string[] => texts(s.list({ channel, viewer, limit: 500 }))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  members = [
    { id: 'a_alice', name: 'Alice' },
    { id: 'a_bob', name: 'Bob' },
    { id: 'a_carol', name: 'Carol' }
  ]
})

describe('ChatStore：灵感激荡（默认）', () => {
  it('没设过主脑：频道没有主脑，消息不带 audience，所有人都看得到', () => {
    const s = store()
    expect(s.lead(WS)).toBeUndefined()
    expect(s.lead()).toBeUndefined()
    const m = s.send(BOB, { text: '@Carol 看一下这个' }, WS)
    expect(m.audience).toBeUndefined()
    expect(m.mentions).toEqual(['a_carol'])
    for (const v of ['a_alice', 'a_carol', 'user']) expect(sees(s, v)).toEqual(['@Carol 看一下这个'])
    expect(s.unread('a_alice', WS)).toEqual({ unread: 1, mentions: 0 })
  })
})

describe('ChatStore：分工明确', () => {
  it('设主脑、换主脑、改回去；找不到的成员报 NOT_FOUND；重复设不算变化', () => {
    const s = store()
    expect(s.setLead(WS, 'a_alice')).toBe(true)
    expect(s.lead(WS)).toBe('a_alice')
    expect(s.setLead(WS, 'a_alice')).toBe(false)
    // 各频道各管各的
    expect(s.lead('general')).toBeUndefined()
    expect(s.setLead(WS, 'a_bob')).toBe(true)
    expect(s.lead(WS)).toBe('a_bob')
    expect(codeOf(() => s.setLead(WS, 'a_nobody'))).toBe('NOT_FOUND')
    expect(codeOf(() => s.setLead('bad channel', 'a_bob'))).toBe('INVALID_ARGS')
    expect(s.setLead(WS, undefined)).toBe(true)
    expect(s.lead(WS)).toBeUndefined()
    expect(s.setLead(WS, undefined)).toBe(false)
  })

  it('别的成员发的消息只有主脑和用户看得到；@别的成员、@所有人不算数，主脑算被点名', () => {
    const s = store()
    s.setLead(WS, 'a_alice')
    const m = s.send(BOB, { text: '@Carol @所有人 我这边做完了' }, WS)
    expect(m.audience).toEqual(['a_alice'])
    expect(m.mentions).toEqual(['a_alice'])
    expect(sees(s, 'a_alice')).toEqual([m.text])
    expect(sees(s, 'user')).toEqual([m.text])
    expect(sees(s, 'a_bob')).toEqual([m.text])
    expect(sees(s, 'a_carol')).toEqual([])
    // Carol：不算未读，读不到，搜不到
    expect(s.unread('a_carol', WS)).toEqual({ unread: 0, mentions: 0 })
    expect(s.read('a_carol', { channels: [WS] }).messages).toEqual([])
    expect(s.read('a_carol', { channels: [WS], query: '做完' }).messages).toEqual([])
    // 主脑：算未读，而且是点名给它的
    expect(s.unread('a_alice', WS)).toEqual({ unread: 1, mentions: 1 })
    expect(texts(s.read('a_alice', { channels: [WS], mentionsOnly: true }).messages)).toEqual([m.text])
    // 成员 @用户 留着
    expect(s.send(BOB, { text: '@我 这个要你定' }, WS).mentions.sort()).toEqual(['a_alice', 'user'])
  })

  it('主脑：@谁只送给谁；@所有人全员可见；谁都不 @ 只有用户看到', () => {
    const s = store()
    s.setLead(WS, 'a_alice')
    const toBob = s.send(ALICE, { text: '@Bob 你做登录页' }, WS)
    const toAll = s.send(ALICE, { text: '@所有人 下午三点前交' }, WS)
    const note = s.send(ALICE, { text: '进度：三项里做完两项' }, WS)
    expect(toBob.audience).toEqual(['a_alice', 'a_bob'])
    expect(toAll.audience).toBeUndefined()
    expect(note.audience).toEqual(['a_alice'])
    expect(sees(s, 'a_bob')).toEqual([toBob.text, toAll.text])
    expect(sees(s, 'a_carol')).toEqual([toAll.text])
    expect(sees(s, 'user')).toEqual([toBob.text, toAll.text, note.text])
    expect(s.unread('a_bob', WS)).toEqual({ unread: 2, mentions: 2 })
    expect(s.unread('a_carol', WS)).toEqual({ unread: 1, mentions: 1 })
  })

  it('用户和主脑一样：不 @ 只有主脑收到，@谁再加上谁', () => {
    const s = store()
    s.setLead(WS, 'a_alice')
    const plain = s.send(USER, { text: '把首页改成深色' }, WS)
    const direct = s.send(USER, { text: '@Carol 你那边先停一下' }, WS)
    expect(plain.audience).toEqual(['a_alice'])
    // 不 @ 就是说给主脑的：算点名给它
    expect(plain.mentions).toEqual(['a_alice'])
    expect(direct.audience).toEqual(['a_alice', 'a_carol'])
    expect(direct.mentions).toEqual(['a_carol'])
    expect(s.unread('a_alice', WS)).toEqual({ unread: 2, mentions: 1 })
    expect(sees(s, 'a_alice')).toEqual([plain.text, direct.text])
    expect(sees(s, 'a_bob')).toEqual([])
    expect(sees(s, 'a_carol')).toEqual([direct.text])
  })

  it('等消息：别的成员发的不叫醒其他成员，叫醒主脑', async () => {
    const s = store()
    s.setLead(WS, 'a_alice')
    let carolGot: GroupMessage[] | undefined
    let aliceGot: GroupMessage[] | undefined
    const pc = s.wait('a_carol', { channels: [WS], timeoutMs: 300 }).then((r) => (carolGot = r))
    const pa = s.wait('a_alice', { channels: [WS], timeoutMs: 3000, mentionsOnly: true }).then((r) => (aliceGot = r))
    await sleep(20)
    s.send(BOB, { text: '登录页做完了' }, WS)
    await pa
    expect(texts(aliceGot ?? [])).toEqual(['登录页做完了'])
    await pc
    expect(carolGot).toEqual([])
  })

  it('引用：看不到的消息不能引用；回执在分工明确下也只到主脑', () => {
    const s = store()
    s.setLead(WS, 'a_alice')
    const fromBob = s.send(BOB, { text: '我的结果' }, WS)
    expect(codeOf(() => s.send(CAROL, { text: '同意', replyTo: fromBob.id }, WS))).toBe('NOT_FOUND')
    const task = s.send(ALICE, { text: '@Carol 你来做测试' }, WS)
    const ack = s.send(CAROL, { text: '收到', replyTo: task.seq, receipt: true }, WS)
    expect(ack.audience).toEqual(['a_alice'])
    expect(ack.mentions).toEqual(['a_alice'])
    expect(sees(s, 'a_bob')).toEqual([fromBob.text])
  })

  it('大厅是分工明确时：成员只能私聊主脑或用户', () => {
    const s = store()
    s.setLead('general', 'a_alice')
    expect(codeOf(() => s.send(BOB, { text: '悄悄说', to: 'Carol' }))).toBe('FORBIDDEN')
    expect(s.send(BOB, { text: '给主脑', to: 'Alice' }).to).toBe('a_alice')
    expect(s.send(BOB, { text: '给用户', to: 'user' }).to).toBe('user')
    // 主脑和用户私聊谁都行
    expect(s.send(ALICE, { text: '单独说', to: 'Carol' }).to).toBe('a_carol')
    expect(s.send(USER, { text: '单独说', to: 'Bob' }).to).toBe('a_bob')
    // 大厅是灵感激荡时不拦
    s.setLead('general', undefined)
    expect(s.send(BOB, { text: '悄悄说', to: 'Carol' }).to).toBe('a_carol')
  })

  it('改回灵感激荡：之前限定范围的消息范围不变，新消息大家都看得到；以前的普通消息一直看得到', () => {
    const s = store()
    const before = s.send(BOB, { text: '切换前说的' }, WS)
    s.setLead(WS, 'a_alice')
    const during = s.send(BOB, { text: '只给主脑的' }, WS)
    s.setLead(WS, undefined)
    const after = s.send(BOB, { text: '切回来之后说的' }, WS)
    expect(after.audience).toBeUndefined()
    expect(sees(s, 'a_carol')).toEqual([before.text, after.text])
    expect(sees(s, 'a_alice')).toEqual([before.text, during.text, after.text])
    expect(sees(s, 'user')).toEqual([before.text, during.text, after.text])
  })

  it('换主脑：新主脑接着看得到之前限定范围的消息，原主脑看到的不变', () => {
    const s = store()
    s.setLead(WS, 'a_alice')
    const m1 = s.send(BOB, { text: 'Bob 给原主脑的' }, WS)
    const m2 = s.send(ALICE, { text: '@Bob 原主脑派的活' }, WS)
    expect(sees(s, 'a_carol')).toEqual([])
    s.setLead(WS, 'a_carol')
    expect(sees(s, 'a_carol')).toEqual([m1.text, m2.text])
    expect(sees(s, 'a_alice')).toEqual([m1.text, m2.text])
    // 现在 Alice 是普通成员
    expect(s.send(ALICE, { text: '@Bob 还想直接说' }, WS).audience).toEqual(['a_carol'])
    expect(sees(s, 'a_bob')).toEqual([m1.text, m2.text])
  })

  it('纯函数 chatVisible：带 audience 的消息只有发的人、audience 里的人和用户看得到', () => {
    const m = { from: { kind: 'agent', id: 'a_bob', name: 'Bob' }, audience: ['a_alice'], mentions: [], text: 'x' } as unknown as GroupMessage
    expect(chatVisible(m, 'a_bob')).toBe(true)
    expect(chatVisible(m, 'a_alice')).toBe(true)
    expect(chatVisible(m, 'user')).toBe(true)
    expect(chatVisible(m, 'a_carol')).toBe(false)
  })

  it('存盘：重开后主脑还在；主脑被吊销（removeMember 或不在名单里）就回到灵感激荡', () => {
    const s = store()
    s.setLead(WS, 'a_alice')
    s.setLead('general', 'a_bob')
    const again = store()
    expect(again.lead(WS)).toBe('a_alice')
    expect(again.lead('general')).toBe('a_bob')
    again.removeMember('a_alice')
    expect(again.lead(WS)).toBeUndefined()
    expect(again.lead('general')).toBe('a_bob')
    expect(JSON.parse(fs.readFileSync(path.join(base, 'chat', 'modes.json'), 'utf8'))).toEqual({ general: 'a_bob' })
    // 名单里没有了（没走 removeMember）也不算主脑
    members = members.filter((m) => m.id !== 'a_bob')
    expect(again.lead('general')).toBeUndefined()
    expect(again.send(CAROL, { text: '大家好' }).audience).toBeUndefined()
  })

  it('modes.json 被写坏（不是对象、值不是字符串）：当成没有主脑，不报错', () => {
    fs.mkdirSync(path.join(base, 'chat'), { recursive: true })
    fs.writeFileSync(path.join(base, 'chat', 'modes.json'), JSON.stringify({ [WS]: 42, general: ['a_bob'] }))
    const s = store()
    expect(s.lead(WS)).toBeUndefined()
    expect(s.lead('general')).toBeUndefined()
    expect(s.setLead(WS, 'a_alice')).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(base, 'chat', 'modes.json'), 'utf8'))).toEqual({ [WS]: 'a_alice' })
  })
})

// ========== 经过 Bridge 和 MCP ==========

let bridge: Bridge
let url: string
const clients: Client[] = []

interface Result {
  isError: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  notices: string
}

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 'chat-modes-test', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
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

describe('经过 Bridge 和 MCP：切换方式、通知、可见范围、派活', () => {
  let a: { agent: Agent; c: Client }
  let b: { agent: Agent; c: Client }
  let cc: { agent: Agent; c: Client }
  let ws: string
  let wsName: string

  beforeEach(async () => {
    const root = path.join(base, 'ws')
    fs.mkdirSync(root, { recursive: true })
    bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'skills') })
    await bridge.start()
    url = bridge.getState().mcpUrl
    const aa = bridge.createAgent('Alice')
    const bb = bridge.createAgent('Bob')
    const c3 = bridge.createAgent('Carol')
    a = { agent: aa, c: await connect(aa.token) }
    b = { agent: bb, c: await connect(bb.token) }
    cc = { agent: c3, c: await connect(c3.token) }
    ws = `ws:${bridge.getState().activeWorkspaceId}`
    wsName = bridge.getState().chat.channels.find((c) => c.id === ws)?.name ?? ''
  })

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.stop()
  })

  const channelOf = (r: Result): { mode: string; lead?: string; you_are_lead?: boolean } => r.data.find((c: { id: string }) => c.id === ws)

  it('默认是灵感激荡：chat_channels 的 mode=brainstorm，whoami 的 collaboration 是空的，状态里没有 leadId', async () => {
    expect(channelOf(await call(a.c, 'chat_channels')).mode).toBe('brainstorm')
    expect((await call(a.c, 'whoami')).data.collaboration).toEqual([])
    expect(bridge.getState().chat.channels.every((c) => c.leadId === undefined)).toBe(true)
  })

  it('切到分工明确：状态带 leadId；主脑和成员各收到一条说法不同的通知；chat_channels、whoami、team_list 都看得出来', async () => {
    bridge.setChatLead(ws, a.agent.id)
    expect(bridge.getState().chat.channels.find((c) => c.id === ws)?.leadId).toBe(a.agent.id)
    const ra = await call(a.c, 'chat_channels')
    const rb = await call(b.c, 'chat_channels')
    expect(ra.notices).toContain('[干活方式]')
    expect(ra.notices).toContain('你是主脑')
    expect(rb.notices).toContain('主脑是 Alice')
    expect(rb.notices).toContain('只和主脑联系')
    expect(channelOf(ra)).toMatchObject({ mode: 'lead', lead: 'Alice', you_are_lead: true })
    expect(channelOf(rb)).toMatchObject({ mode: 'lead', lead: 'Alice', you_are_lead: false })
    // 大厅没动
    expect(rb.data.find((c: { id: string }) => c.id === 'general').mode).toBe('brainstorm')
    expect((await call(b.c, 'whoami')).data.collaboration).toEqual([{ channel: ws, channel_name: wsName, lead: 'Alice', you_are_lead: false, your_role: 'sub' }])
    const team = (await call(cc.c, 'team_list')).data as { name: string; lead_of?: string[] }[]
    expect(team.find((m) => m.name === 'Alice')?.lead_of).toEqual([wsName])
    expect(team.find((m) => m.name === 'Bob')?.lead_of).toBeUndefined()
    // 重复设同一个人：不再通知
    bridge.setChatLead(ws, a.agent.id)
    expect((await call(b.c, 'whoami')).notices).toBe('')
  })

  it('成员发消息：结果里说清只有主脑和用户看得到；别的成员读不到、没有通知；主脑收到点名通知', async () => {
    bridge.setChatLead(ws, a.agent.id)
    for (const x of [a, b, cc]) await call(x.c, 'whoami')
    const sent = await call(b.c, 'chat_send', { channel: ws, text: '@Carol 登录页做完了，你接着测' })
    expect(sent.isError).toBe(false)
    expect(sent.data.only_visible_to.sort()).toEqual(['Alice', 'Bob', '用户'].sort())
    expect(sent.data.note).toContain('只有主脑 Alice 和用户能看到')
    expect(sent.data.mentions).toEqual([a.agent.id])
    const rc = await call(cc.c, 'chat_read', { channel: ws })
    expect(rc.data.messages).toEqual([])
    expect(rc.notices).toBe('')
    const ra = await call(a.c, 'chat_read', { channel: ws })
    expect(ra.data.messages.map((m: { text: string }) => m.text)).toEqual(['@Carol 登录页做完了，你接着测'])
    expect(ra.data.messages[0].only_visible_to.sort()).toEqual(['Alice', 'Bob', '用户'].sort())
    // 用户在工作台里都看得到
    expect(bridge.listChat({ channel: ws }).map((m) => m.text)).toEqual(['@Carol 登录页做完了，你接着测'])
  })

  it('主脑发消息：@Bob 只有 Bob 收到；不 @ 的结果里提醒只有用户看得到；@所有人 全员收到', async () => {
    bridge.setChatLead(ws, a.agent.id)
    for (const x of [a, b, cc]) await call(x.c, 'whoami')
    const toBob = await call(a.c, 'chat_send', { channel: ws, text: '@Bob 你做登录页' })
    expect(toBob.data.only_visible_to.sort()).toEqual(['Alice', 'Bob', '用户'].sort())
    expect(toBob.data.note).toBeUndefined()
    const plain = await call(a.c, 'chat_send', { channel: ws, text: '进度汇报：一切正常' })
    expect(plain.data.note).toContain('只有用户能看到')
    const all = await call(a.c, 'chat_send', { channel: ws, text: '@所有人 三点前交' })
    expect(all.data.only_visible_to).toBeUndefined()
    const rb = await call(b.c, 'chat_read', { channel: ws })
    expect(rb.data.messages.map((m: { text: string }) => m.text)).toEqual(['@Bob 你做登录页', '@所有人 三点前交'])
    const rc = await call(cc.c, 'chat_read', { channel: ws })
    expect(rc.data.messages.map((m: { text: string }) => m.text)).toEqual(['@所有人 三点前交'])
  })

  it('用户在工作台发的：不 @ 只有主脑收到通知，别的成员没有', async () => {
    bridge.setChatLead(ws, a.agent.id)
    for (const x of [a, b, cc]) await call(x.c, 'whoami')
    bridge.sendChat({ channel: ws, text: '把首页改成深色' })
    expect((await call(a.c, 'whoami')).notices).toContain('把首页改成深色')
    expect((await call(b.c, 'whoami')).notices).toBe('')
    expect((await call(b.c, 'chat_read', { channel: ws })).data.messages).toEqual([])
  })

  it('派活：成员不能把任务派给别的成员（task_create、task_assign），给自己或不指定可以；主脑可以', async () => {
    bridge.setChatLead(ws, a.agent.id)
    const denied = await call(b.c, 'task_create', { title: '测登录页', assigneeId: 'Carol' })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.data)).toContain('FORBIDDEN')
    expect(JSON.stringify(denied.data)).toContain('主脑 Alice')
    const mine = await call(b.c, 'task_create', { title: '我自己的活', assigneeId: 'me' })
    expect(mine.isError).toBe(false)
    const open = await call(b.c, 'task_create', { title: '没人负责的活' })
    expect(open.isError).toBe(false)
    const assignDenied = await call(b.c, 'task_assign', { id: open.data.id, assigneeId: 'Carol' })
    expect(assignDenied.isError).toBe(true)
    expect(JSON.stringify(assignDenied.data)).toContain('FORBIDDEN')
    const byLead = await call(a.c, 'task_create', { title: '测登录页', assigneeId: 'Carol' })
    expect(byLead.isError).toBe(false)
    const leadAssign = await call(a.c, 'task_assign', { id: open.data.id, assigneeId: 'Bob' })
    expect(leadAssign.isError).toBe(false)
    // 改回灵感激荡后成员又能派
    bridge.setChatLead(ws, undefined)
    expect((await call(b.c, 'task_create', { title: '再测一次', assigneeId: 'Carol' })).isError).toBe(false)
  })

  it('改回灵感激荡：大家收到通知，新消息全员可见', async () => {
    bridge.setChatLead(ws, a.agent.id)
    for (const x of [a, b, cc]) await call(x.c, 'whoami')
    bridge.setChatLead(ws, undefined)
    expect(bridge.getState().chat.channels.find((c) => c.id === ws)?.leadId).toBeUndefined()
    const rc = await call(cc.c, 'chat_channels')
    expect(rc.notices).toContain('改回「灵感激荡」')
    expect(channelOf(rc).mode).toBe('brainstorm')
    const sent = await call(b.c, 'chat_send', { channel: ws, text: '大家看看这个方案' })
    expect(sent.data.only_visible_to).toBeUndefined()
    expect((await call(cc.c, 'chat_read', { channel: ws })).data.messages.map((m: { text: string }) => m.text)).toEqual(['大家看看这个方案'])
  })

  it('主脑被吊销：频道自动回到灵感激荡，其余成员收到通知', async () => {
    bridge.setChatLead(ws, a.agent.id)
    for (const x of [b, cc]) await call(x.c, 'whoami')
    await bridge.removeAgent(a.agent.id)
    expect(bridge.getState().chat.channels.find((c) => c.id === ws)?.leadId).toBeUndefined()
    const rb = await call(b.c, 'chat_channels')
    expect(rb.notices).toContain('主脑 Alice 已被用户吊销')
    expect(channelOf(rb).mode).toBe('brainstorm')
  })

  it('设主脑的校验：不存在的 AI、不存在的频道报错', () => {
    expect(() => bridge.setChatLead(ws, 'no-such-agent')).toThrow(/不存在/)
    expect(() => bridge.setChatLead('ws:w_nope', a.agent.id)).toThrow(/不存在/)
  })
})

// ========== 界面用的纯函数 ==========

describe('界面：主脑、消息范围标签、分组', () => {
  const agents = [
    { id: 'a_alice', name: 'Alice' },
    { id: 'a_bob', name: 'Bob' }
  ] as unknown as Agent[]
  const msg = (over: Partial<GroupMessage>): GroupMessage =>
    ({ id: 'm1', seq: 1, ts: 1_700_000_000_000, channel: WS, from: { kind: 'agent', id: 'a_bob', name: 'Bob' }, text: 'x', mentions: [], ...over }) as unknown as GroupMessage

  it('leadOf：频道带 leadId 且那个 AI 还在才算有主脑', () => {
    const state = (leadId?: string): BridgeState =>
      ({ agents, chat: { unread: 0, mentions: 0, channels: [{ id: WS, name: 'demo', unread: 0, mentions: 0, lastTs: 0, ...(leadId ? { leadId } : {}) }] } }) as unknown as BridgeState
    expect(leadOf(state('a_alice'), WS)?.name).toBe('Alice')
    expect(leadOf(state(), WS)).toBeUndefined()
    expect(leadOf(state('a_gone'), WS)).toBeUndefined()
    expect(leadOf(state('a_alice'), 'general')).toBeUndefined()
  })

  it('audienceLabel：只发给谁（不列发的人自己）；普通消息和私聊没有', () => {
    expect(audienceLabel(msg({}), agents)).toBeUndefined()
    expect(audienceLabel(msg({ audience: ['a_alice'] }), agents)).toBe('只发给 Alice')
    expect(audienceLabel(msg({ from: { kind: 'agent', id: 'a_alice', name: 'Alice' }, audience: ['a_alice', 'a_bob'] }), agents)).toBe('只发给 Bob')
    expect(audienceLabel(msg({ from: { kind: 'agent', id: 'a_alice', name: 'Alice' }, audience: ['a_alice'] }), agents)).toBe('只发给你')
    expect(audienceLabel(msg({ from: { kind: 'user', id: 'user', name: '你' }, audience: ['a_alice'] }), agents)).toBe('只发给 Alice')
    expect(audienceLabel(msg({ to: 'a_alice', audience: ['a_alice'] }), agents)).toBeUndefined()
  })

  it('buildRows：送给谁变了另起一组；involves 把只送给他的也算上', () => {
    const rows = buildRows([msg({ id: 'm1' }), msg({ id: 'm2', seq: 2, audience: ['a_alice'] }), msg({ id: 'm3', seq: 3, audience: ['a_alice'] })], 1_700_000_000_000)
    expect(rows.filter((r) => r.kind === 'msg').map((r) => (r.kind === 'msg' ? r.first : false))).toEqual([true, true, false])
    expect(involves(msg({ audience: ['a_alice'] }), 'a_alice')).toBe(true)
    expect(involves(msg({}), 'a_alice')).toBe(false)
  })
})
