// 分工明确时子代理也由用户选：选中的和主脑是这次分工的人，没选中的不参与
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { ChatStore, type ChatMember, type ChatSender } from '../src/core/chat'
import { ToolError } from '../src/core/fileTools'
import { audienceLabel, modeLine, subsOf, subsToSave, teamRole } from '../src/renderer/src/lib/groupChat'
import type { Agent, BridgeState, GroupMessage } from '../src/core/types'

let base: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-chat-subs-'))
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

let members: ChatMember[]
const ALICE: ChatSender = { kind: 'agent', id: 'a_alice', name: 'Alice' }
const BOB: ChatSender = { kind: 'agent', id: 'a_bob', name: 'Bob' }
const CAROL: ChatSender = { kind: 'agent', id: 'a_carol', name: 'Carol' }
const DAVE: ChatSender = { kind: 'agent', id: 'a_dave', name: 'Dave' }
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
const sees = (s: ChatStore, viewer: string, channel = WS): string[] => s.list({ channel, viewer, limit: 500 }).map((m) => m.text)

beforeEach(() => {
  members = [
    { id: 'a_alice', name: 'Alice' },
    { id: 'a_bob', name: 'Bob' },
    { id: 'a_carol', name: 'Carol' },
    { id: 'a_dave', name: 'Dave' }
  ]
})

describe('ChatStore：选子代理', () => {
  it('没选过：主脑以外都算子代理；灵感激荡时没有角色，也不能选子代理', () => {
    const s = store()
    expect(s.subs(WS)).toBeUndefined()
    expect(s.role(WS, 'a_bob')).toBeUndefined()
    expect(codeOf(() => s.setSubs(WS, ['a_bob']))).toBe('INVALID_ARGS')
    s.setLead(WS, 'a_alice')
    expect(s.subs(WS)).toBeUndefined()
    expect([s.role(WS, 'a_alice'), s.role(WS, 'a_bob'), s.role(WS, 'a_dave')]).toEqual(['lead', 'sub', 'sub'])
  })

  it('选了以后：选中的是子代理，没选中的是 out；主脑自己不进名单；重复设不算变化；找不到的成员报 NOT_FOUND', () => {
    const s = store()
    s.setLead(WS, 'a_alice')
    expect(s.setSubs(WS, ['a_bob', 'a_alice', 'a_bob'])).toBe(true)
    expect(s.subs(WS)).toEqual(['a_bob'])
    expect([s.role(WS, 'a_alice'), s.role(WS, 'a_bob'), s.role(WS, 'a_carol')]).toEqual(['lead', 'sub', 'out'])
    expect(s.setSubs(WS, ['a_bob'])).toBe(false)
    expect(codeOf(() => s.setSubs(WS, ['a_nobody']))).toBe('NOT_FOUND')
    // 空名单：主脑一个人干
    expect(s.setSubs(WS, [])).toBe(true)
    expect(s.role(WS, 'a_bob')).toBe('out')
    // 不挑了：回到主脑以外都算
    expect(s.setSubs(WS, undefined)).toBe(true)
    expect(s.subs(WS)).toBeUndefined()
    expect(s.role(WS, 'a_carol')).toBe('sub')
    expect(s.setSubs(WS, undefined)).toBe(false)
  })

  it('子代理发的只到主脑；没选中的成员发的只有用户看到，主脑也看不到，@谁都不算数', () => {
    const s = store()
    s.setLead(WS, 'a_alice')
    s.setSubs(WS, ['a_bob'])
    const fromSub = s.send(BOB, { text: '@Carol 我做完了' }, WS)
    expect(fromSub.audience).toEqual(['a_alice'])
    const fromOut = s.send(CAROL, { text: '@Alice @Bob @所有人 我也想参与' }, WS)
    expect(fromOut.audience).toEqual([])
    expect(fromOut.mentions).toEqual([])
    expect(sees(s, 'a_alice')).toEqual(['@Carol 我做完了'])
    expect(sees(s, 'a_bob')).toEqual(['@Carol 我做完了'])
    expect(sees(s, 'a_carol')).toEqual(['@Alice @Bob @所有人 我也想参与'])
    expect(sees(s, 'user')).toHaveLength(2)
    expect(s.unread('a_alice', WS).unread).toBe(1)
    // 没选中的成员点名用户照样算
    expect(s.send(CAROL, { text: '@我 能把我加进来吗' }, WS).mentions).toEqual(['user'])
  })

  it('主脑：@名单外的成员不送到（点名去掉，droppedMentions 说得出是谁）；@所有人 只到主脑和子代理', () => {
    const s = store()
    s.setLead(WS, 'a_alice')
    s.setSubs(WS, ['a_bob', 'a_carol'])
    const m1 = s.send(ALICE, { text: '@Bob @Dave 你们俩对一下接口' }, WS)
    expect(m1.mentions).toEqual(['a_bob'])
    expect(m1.audience).toEqual(['a_alice', 'a_bob'])
    expect(s.droppedMentions(m1)).toEqual(['a_dave'])
    const m2 = s.send(ALICE, { text: '@所有人 三点前交' }, WS)
    expect(m2.audience).toEqual(['a_alice', 'a_bob', 'a_carol'])
    expect(m2.mentions).toEqual(['*'])
    expect(s.droppedMentions(m2)).toEqual([])
    expect(sees(s, 'a_dave')).toEqual([])
    expect(sees(s, 'a_carol')).toEqual(['@所有人 三点前交'])
    expect(s.unread('a_dave', WS).unread).toBe(0)
    // 只 @ 了名单外的：谁也没送到，只有用户看到
    const m3 = s.send(ALICE, { text: '@Dave 你来一下' }, WS)
    expect(m3.mentions).toEqual([])
    expect(m3.audience).toEqual(['a_alice'])
  })

  it('用户：@所有人 只到主脑和子代理；点名名单外的成员照样送到（主脑也看得到）', () => {
    const s = store()
    s.setLead(WS, 'a_alice')
    s.setSubs(WS, ['a_bob'])
    expect(s.send(USER, { text: '@所有人 开工' }, WS).audience).toEqual(['a_alice', 'a_bob'])
    const m = s.send(USER, { text: '@Dave 你先别动这个仓库' }, WS)
    expect(m.audience).toEqual(['a_alice', 'a_dave'])
    expect(sees(s, 'a_dave')).toEqual(['@Dave 你先别动这个仓库'])
    expect(sees(s, 'a_carol')).toEqual([])
    expect(sees(s, 'a_alice')).toHaveLength(2)
  })

  it('没选过子代理时 @所有人 还是频道里所有人（不记 audience），和以前一样', () => {
    const s = store()
    s.setLead(WS, 'a_alice')
    expect(s.send(ALICE, { text: '@所有人 开会' }, WS).audience).toBeUndefined()
    expect(s.send(USER, { text: '@所有人 开会' }, WS).audience).toBeUndefined()
  })

  it('等消息：主脑 @所有人 叫醒子代理，不叫醒没选中的成员', async () => {
    const s = store()
    s.setLead(WS, 'a_alice')
    s.setSubs(WS, ['a_bob'])
    const bob = s.wait('a_bob', { channels: [WS], timeoutMs: 3000 })
    const dave = s.wait('a_dave', { channels: [WS], timeoutMs: 150 })
    s.send(ALICE, { text: '@所有人 三点前交' }, WS)
    expect((await bob).map((m) => m.text)).toEqual(['@所有人 三点前交'])
    expect(await dave).toEqual([])
  })

  it('大厅是分工明确时的私聊：没选中的只能找用户；主脑不能私聊名单外的；子代理只能找主脑或用户', () => {
    const s = store()
    s.setLead('general', 'a_alice')
    s.setSubs('general', ['a_bob'])
    expect(codeOf(() => s.send(CAROL, { text: '在吗', to: 'Alice' }))).toBe('FORBIDDEN')
    expect(codeOf(() => s.send(CAROL, { text: '在吗', to: 'user' }))).toBe('OK')
    expect(codeOf(() => s.send(ALICE, { text: '在吗', to: 'Carol' }))).toBe('FORBIDDEN')
    expect(codeOf(() => s.send(ALICE, { text: '在吗', to: 'Bob' }))).toBe('OK')
    expect(codeOf(() => s.send(BOB, { text: '在吗', to: 'Carol' }))).toBe('FORBIDDEN')
    expect(codeOf(() => s.send(BOB, { text: '在吗', to: 'Alice' }))).toBe('OK')
    expect(codeOf(() => s.send(USER, { text: '在吗', to: 'Carol' }))).toBe('OK')
  })

  it('换主脑：新主脑出名单，原主脑留在分工里；改回灵感激荡，主脑和子代理接着是参与讨论的人；再改成分工明确还是这几个', () => {
    const s = store()
    s.setLead(WS, 'a_alice')
    s.setSubs(WS, ['a_bob'])
    s.setLead(WS, 'a_bob')
    expect(s.subs(WS)).toEqual(['a_alice'])
    expect([s.role(WS, 'a_alice'), s.role(WS, 'a_bob'), s.role(WS, 'a_carol')]).toEqual(['sub', 'lead', 'out'])
    s.setLead(WS, undefined)
    expect(s.subs(WS)).toBeUndefined()
    expect(s.participants(WS)).toEqual(['a_bob', 'a_alice'])
    s.setLead(WS, 'a_carol')
    expect(s.subs(WS)).toEqual(['a_bob', 'a_alice'])
    expect(s.role(WS, 'a_dave')).toBe('out')
  })

  it('没选过子代理时换主脑：还是不挑', () => {
    const s = store()
    s.setLead(WS, 'a_alice')
    s.setLead(WS, 'a_bob')
    expect(s.subs(WS)).toBeUndefined()
    expect(s.role(WS, 'a_alice')).toBe('sub')
  })

  it('存盘：名单在 teams.json，modes.json 格式不变；重开后还在；子代理被吊销就从名单里去掉，主脑被吊销后剩下的子代理是参与讨论的人', () => {
    const s = store()
    s.setLead(WS, 'a_alice')
    s.setSubs(WS, ['a_bob', 'a_carol'])
    const dir = path.join(base, 'chat')
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'modes.json'), 'utf8'))).toEqual({ [WS]: 'a_alice' })
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'teams.json'), 'utf8'))).toEqual({ [WS]: ['a_bob', 'a_carol'] })
    expect(store().subs(WS)).toEqual(['a_bob', 'a_carol'])
    members = members.filter((m) => m.id !== 'a_carol')
    s.removeMember('a_carol')
    expect(s.subs(WS)).toEqual(['a_bob'])
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'teams.json'), 'utf8'))).toEqual({ [WS]: ['a_bob'] })
    members = members.filter((m) => m.id !== 'a_alice')
    s.removeMember('a_alice')
    expect(s.lead(WS)).toBeUndefined()
    expect(s.subs(WS)).toBeUndefined()
    expect(s.participants(WS)).toEqual(['a_bob'])
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'teams.json'), 'utf8'))).toEqual({ [WS]: ['a_bob'] })
  })

  it('teams.json 被写坏（不是对象、值不是数组、数组里混了别的）：当成没选过或只认字符串，不报错', () => {
    const dir = path.join(base, 'chat')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'modes.json'), JSON.stringify({ [WS]: 'a_alice', general: 'a_alice' }))
    fs.writeFileSync(path.join(dir, 'teams.json'), JSON.stringify({ [WS]: 'a_bob', general: ['a_bob', 7, null, 'a_gone', 'a_alice'] }))
    const s = store()
    expect(s.subs(WS)).toBeUndefined()
    expect(s.subs('general')).toEqual(['a_bob'])
    expect(s.send(BOB, { text: '可以发' }, WS).audience).toEqual(['a_alice'])
    fs.writeFileSync(path.join(dir, 'teams.json'), '[1,2]')
    expect(store().subs('general')).toBeUndefined()
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
  const c = new Client({ name: 'chat-subs-test', version: '1.0.0' })
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

describe('经过 Bridge 和 MCP：选子代理', () => {
  let a: { agent: Agent; c: Client }
  let b: { agent: Agent; c: Client }
  let cc: { agent: Agent; c: Client }
  let d: { agent: Agent; c: Client }
  let ws: string

  beforeEach(async () => {
    const root = path.join(base, 'ws')
    fs.mkdirSync(root, { recursive: true })
    bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'skills') })
    await bridge.start()
    url = bridge.getState().mcpUrl
    const mk = async (name: string): Promise<{ agent: Agent; c: Client }> => {
      const agent = bridge.createAgent(name)
      return { agent, c: await connect(agent.token) }
    }
    a = await mk('Alice')
    b = await mk('Bob')
    cc = await mk('Carol')
    d = await mk('Dave')
    ws = `ws:${bridge.getState().activeWorkspaceId}`
  })

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.stop()
  })

  const info = (): { leadId?: string; subIds?: string[] } => bridge.getState().chat.channels.find((c) => c.id === ws) ?? {}
  const channelOf = (r: Result): { mode: string; your_role?: string; subs?: string[] } => r.data.find((c: { id: string }) => c.id === ws)
  const drain = async (): Promise<void> => {
    for (const x of [a, b, cc, d]) await call(x.c, 'whoami')
  }

  it('一次定下主脑和子代理：状态带 subIds；主脑、子代理、没选中的各收到说法不同的通知；chat_channels 和 whoami 带角色', async () => {
    bridge.setChatLead(ws, a.agent.id, [b.agent.id, cc.agent.id])
    expect(info()).toMatchObject({ leadId: a.agent.id, subIds: [b.agent.id, cc.agent.id] })
    const ra = await call(a.c, 'chat_channels')
    const rb = await call(b.c, 'chat_channels')
    const rd = await call(d.c, 'chat_channels')
    expect(ra.notices).toContain('你是主脑')
    expect(ra.notices).toContain('子代理是：Bob、Carol')
    expect(rb.notices).toContain('只和主脑联系')
    expect(rd.notices).toContain('这次分工没有选你')
    expect(rd.notices).not.toContain('只和主脑联系')
    expect(channelOf(ra)).toMatchObject({ mode: 'lead', your_role: 'lead', subs: ['Bob', 'Carol'] })
    expect(channelOf(rb)).toMatchObject({ your_role: 'sub' })
    expect(channelOf(rd)).toMatchObject({ your_role: 'none' })
    expect((await call(d.c, 'whoami')).data.collaboration[0]).toMatchObject({ your_role: 'none', subs: ['Bob', 'Carol'] })
  })

  it('不传 subIds：和以前一样，主脑以外都是子代理，状态里没有 subIds，chat_channels 没有 subs', async () => {
    bridge.setChatLead(ws, a.agent.id)
    expect(info().subIds).toBeUndefined()
    const rd = await call(d.c, 'chat_channels')
    expect(channelOf(rd).your_role).toBe('sub')
    expect(channelOf(rd).subs).toBeUndefined()
  })

  it('改子代理名单：只通知主脑和角色变了的人；没变的人不打扰', async () => {
    bridge.setChatLead(ws, a.agent.id, [b.agent.id, cc.agent.id])
    await drain()
    bridge.setChatSubs(ws, [b.agent.id, d.agent.id])
    expect(info().subIds).toEqual([b.agent.id, d.agent.id])
    const [na, nb, nc, nd] = [await call(a.c, 'whoami'), await call(b.c, 'whoami'), await call(cc.c, 'whoami'), await call(d.c, 'whoami')]
    expect(na.notices).toContain('子代理名单变了')
    expect(na.notices).toContain('Bob、Dave')
    expect(nb.notices).toBe('')
    expect(nc.notices).toContain('这次分工没有选你')
    expect(nd.notices).toContain('用户把你加进了子代理')
    // 同一份名单再设一次：谁都不通知
    bridge.setChatSubs(ws, [d.agent.id, b.agent.id])
    expect((await call(a.c, 'whoami')).notices).toBe('')
    // 不挑了
    bridge.setChatSubs(ws, null)
    expect(info().subIds).toBeUndefined()
    expect((await call(cc.c, 'whoami')).notices).toContain('用户把你加进了子代理')
    expect((await call(a.c, 'whoami')).notices).toContain('不再挑子代理')
  })

  it('没选中的成员发消息：结果里说清只有用户看到；主脑没有通知、读不到', async () => {
    bridge.setChatLead(ws, a.agent.id, [b.agent.id])
    await drain()
    const sent = await call(d.c, 'chat_send', { channel: ws, text: '@Alice 我也可以帮忙' })
    expect(sent.isError).toBe(false)
    expect(sent.data.note).toContain('这次分工没有选你')
    expect(sent.data.only_visible_to).toEqual(['Dave', '用户'])
    expect((await call(a.c, 'whoami')).notices).toBe('')
    expect((await call(a.c, 'chat_read', { channel: ws })).data.messages).toEqual([])
  })

  it('主脑 @名单外的成员：结果里说没送到；那个成员没有通知、读不到；@所有人 只到子代理', async () => {
    bridge.setChatLead(ws, a.agent.id, [b.agent.id])
    await drain()
    const s1 = await call(a.c, 'chat_send', { channel: ws, text: '@Bob @Dave 对一下接口' })
    expect(s1.data.note).toContain('Dave 不在这个频道的子代理名单里')
    expect(s1.data.only_visible_to).toEqual(['Alice', 'Bob', '用户'])
    expect((await call(d.c, 'whoami')).notices).toBe('')
    expect((await call(b.c, 'whoami')).notices).toContain('对一下接口')
    const s2 = await call(a.c, 'chat_send', { channel: ws, text: '@所有人 三点前交' })
    expect(s2.data.only_visible_to).toEqual(['Alice', 'Bob', '用户'])
    expect((await call(d.c, 'chat_read', { channel: ws })).data.messages).toEqual([])
    expect((await call(cc.c, 'whoami')).notices).toBe('')
    const s3 = await call(a.c, 'chat_send', { channel: ws, text: '@Dave 你来' })
    expect(s3.data.note).toContain('Dave 不在这个频道的子代理名单里')
    expect(s3.data.note).toContain('只有用户能看到')
  })

  it('用户在工作台 @名单外的成员：它收到通知', async () => {
    bridge.setChatLead(ws, a.agent.id, [b.agent.id])
    await drain()
    bridge.sendChat({ channel: ws, text: '@Dave 这个仓库你先别动' })
    expect((await call(d.c, 'whoami')).notices).toContain('这个仓库你先别动')
    expect((await call(cc.c, 'whoami')).notices).toBe('')
  })

  it('派活：主脑不能把任务派给名单外的成员，派给子代理可以；用户把它加进来以后就可以', async () => {
    bridge.setChatLead(ws, a.agent.id, [b.agent.id])
    const denied = await call(a.c, 'task_create', { title: '测登录页', assigneeId: 'Dave' })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.data)).toContain('FORBIDDEN')
    expect(JSON.stringify(denied.data)).toContain('不在工作区')
    const ok = await call(a.c, 'task_create', { title: '测登录页', assigneeId: 'Bob' })
    expect(ok.isError).toBe(false)
    const assignDenied = await call(a.c, 'task_assign', { id: ok.data.id, assigneeId: 'Dave' })
    expect(assignDenied.isError).toBe(true)
    bridge.setChatSubs(ws, [b.agent.id, d.agent.id])
    expect((await call(a.c, 'task_assign', { id: ok.data.id, assigneeId: 'Dave' })).isError).toBe(false)
  })

  it('校验：灵感激荡时不能选子代理；名单里有不存在的 AI 报错，什么都不改', () => {
    expect(() => bridge.setChatSubs(ws, [b.agent.id])).toThrow(/先选主脑/)
    expect(() => bridge.setChatLead(ws, a.agent.id, ['no-such-agent'])).toThrow(/不存在/)
    expect(info().leadId).toBeUndefined()
    bridge.setChatLead(ws, a.agent.id)
    expect(() => bridge.setChatSubs(ws, ['no-such-agent'])).toThrow(/不存在/)
    expect(info().subIds).toBeUndefined()
  })

  it('子代理被吊销：名单里没有它了，主脑收到通知', async () => {
    bridge.setChatLead(ws, a.agent.id, [b.agent.id, cc.agent.id])
    await drain()
    await bridge.removeAgent(cc.agent.id)
    expect(info().subIds).toEqual([b.agent.id])
    const na = await call(a.c, 'whoami')
    expect(na.notices).toContain('子代理 Carol 已被用户吊销')
    expect(na.notices).toContain('子代理是：Bob')
  })
})

// ========== 界面用的纯函数 ==========

describe('界面：子代理', () => {
  const agents = [
    { id: 'a_alice', name: 'Alice' },
    { id: 'a_bob', name: 'Bob' },
    { id: 'a_carol', name: 'Carol' }
  ] as unknown as Agent[]
  const state = (leadId?: string, subIds?: string[]): BridgeState =>
    ({ agents, chat: { unread: 0, mentions: 0, channels: [{ id: WS, name: 'demo', unread: 0, mentions: 0, lastTs: 0, ...(leadId ? { leadId } : {}), ...(subIds ? { subIds } : {}) }] } }) as unknown as BridgeState

  it('subsOf / teamRole：没挑过是主脑以外都算；挑过只算名单里还在的；灵感激荡没有', () => {
    expect(subsOf(state(), WS, agents)).toBeUndefined()
    expect(teamRole(state(), WS, 'a_bob')).toBeUndefined()
    expect(subsOf(state('a_alice'), WS, agents)).toEqual({ picked: false, ids: ['a_bob', 'a_carol'] })
    expect(subsOf(state('a_alice', ['a_carol', 'a_gone']), WS, agents)).toEqual({ picked: true, ids: ['a_carol'] })
    expect(['a_alice', 'a_bob', 'a_carol'].map((id) => teamRole(state('a_alice', ['a_carol']), WS, id))).toEqual(['lead', 'out', 'sub'])
    expect(teamRole(state('a_alice'), WS, 'a_bob')).toBe('sub')
  })

  it('subsToSave：全勾是 null（不挑），不然是勾中的（按候选顺序、不认候选外的）；没有候选人时是空名单', () => {
    expect(subsToSave(['a_carol', 'a_bob'], ['a_bob', 'a_carol'])).toBeNull()
    expect(subsToSave(['a_carol', 'a_x'], ['a_bob', 'a_carol'])).toEqual(['a_carol'])
    expect(subsToSave([], ['a_bob'])).toEqual([])
    expect(subsToSave([], [])).toEqual([])
  })

  it('modeLine：频道列表里的小字；挑过子代理的带个数', () => {
    expect(modeLine(state(), WS)).toBeUndefined()
    expect(modeLine(state('a_alice'), WS)).toBe('分工明确 · 主脑 Alice')
    expect(modeLine(state('a_alice', ['a_bob']), WS)).toBe('分工明确 · 主脑 Alice · 子代理 1 个')
    expect(modeLine(state('a_alice', []), WS)).toBe('分工明确 · 主脑 Alice · 子代理 0 个')
  })

  it('audienceLabel：没选中的成员发的（audience 是空的）显示「只发给你」；人多的不一个个列', () => {
    const msg = (over: Partial<GroupMessage>): GroupMessage =>
      ({ id: 'm1', seq: 1, ts: 1_700_000_000_000, channel: WS, from: { kind: 'agent', id: 'a_bob', name: 'Bob' }, text: 'x', mentions: [], ...over }) as unknown as GroupMessage
    expect(audienceLabel(msg({ audience: [] }), agents)).toBe('只发给你')
    expect(audienceLabel(msg({ from: { kind: 'user', id: 'user', name: '你' }, audience: ['a_alice', 'a_bob', 'a_carol', 'a_d', 'a_e'] }), agents)).toBe('只发给 Alice、Bob、Carol 等 5 个')
  })
})
