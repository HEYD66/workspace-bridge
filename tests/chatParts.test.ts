// 灵感激荡也能挑参与的 AI：挑了以后只有他们看得到这个频道的消息，没选中的不参与
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { ChatStore, type ChatMember, type ChatSender } from '../src/core/chat'
import { ToolError } from '../src/core/fileTools'
import { modeLine, partsOf } from '../src/renderer/src/lib/groupChat'
import type { Agent, BridgeState } from '../src/core/types'

let base: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-chat-parts-'))
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
const sees = (s: ChatStore, viewer: string, channel = WS): string[] => s.list({ channel, viewer, limit: 500 }).map((m) => m.text)

beforeEach(() => {
  members = [
    { id: 'a_alice', name: 'Alice' },
    { id: 'a_bob', name: 'Bob' },
    { id: 'a_carol', name: 'Carol' },
    { id: 'a_dave', name: 'Dave' }
  ]
})

describe('ChatStore：灵感激荡挑参与的 AI', () => {
  it('没挑过：都参与；挑了以后名单里的参与；重复设不算变化；空名单、找不到的成员报错；不挑了回到都参与', () => {
    const s = store()
    expect(s.participants(WS)).toBeUndefined()
    expect(s.sitsOut(WS, 'a_dave')).toBe(false)
    expect(s.setParticipants(WS, ['a_alice', 'a_bob', 'a_alice'])).toBe(true)
    expect(s.participants(WS)).toEqual(['a_alice', 'a_bob'])
    expect([s.sitsOut(WS, 'a_alice'), s.sitsOut(WS, 'a_carol'), s.sitsOut(WS, 'user')]).toEqual([false, true, false])
    expect(s.setParticipants(WS, ['a_bob', 'a_alice'])).toBe(false)
    expect(codeOf(() => s.setParticipants(WS, []))).toBe('INVALID_ARGS')
    expect(codeOf(() => s.setParticipants(WS, ['a_nobody']))).toBe('NOT_FOUND')
    expect(s.participants(WS)).toEqual(['a_alice', 'a_bob'])
    // 灵感激荡没有分工角色，子代理名单也没有
    expect(s.role(WS, 'a_carol')).toBeUndefined()
    expect(s.subs(WS)).toBeUndefined()
    expect(s.setParticipants(WS, undefined)).toBe(true)
    expect(s.participants(WS)).toBeUndefined()
    expect(s.sitsOut(WS, 'a_carol')).toBe(false)
    expect(s.setParticipants(WS, undefined)).toBe(false)
    // 别的频道不受影响
    s.setParticipants(WS, ['a_alice'])
    expect(s.participants('general')).toBeUndefined()
  })

  it('分工明确的频道不能挑参与的 AI（那边选子代理）', () => {
    const s = store()
    s.setLead(WS, 'a_alice')
    expect(codeOf(() => s.setParticipants(WS, ['a_bob']))).toBe('INVALID_ARGS')
    expect(s.participants(WS)).toBeUndefined()
  })

  it('参与的人发的：参与的都看到，外面的看不到；@外面的成员不送到；@所有人 只到参与的人', () => {
    const s = store()
    s.setParticipants(WS, ['a_alice', 'a_bob'])
    const m1 = s.send(ALICE, { text: '@Bob @Carol 先定接口' }, WS)
    expect(m1.audience).toBeUndefined()
    expect(m1.mentions).toEqual(['a_bob'])
    expect(s.droppedMentions(m1, true)).toEqual(['a_carol'])
    const m2 = s.send(BOB, { text: '@所有人 我写后端' }, WS)
    expect(m2.mentions).toEqual(['*'])
    expect(sees(s, 'a_alice')).toEqual(['@Bob @Carol 先定接口', '@所有人 我写后端'])
    expect(sees(s, 'a_bob')).toEqual(['@Bob @Carol 先定接口', '@所有人 我写后端'])
    expect(sees(s, 'a_carol')).toEqual([])
    expect(sees(s, 'user')).toHaveLength(2)
    expect(s.unread('a_carol', WS)).toMatchObject({ unread: 0, mentions: 0 })
    expect(s.unread('a_bob', WS)).toMatchObject({ unread: 1, mentions: 1 })
    expect(s.unread('a_alice', WS)).toMatchObject({ unread: 1, mentions: 1 })
  })

  it('外面的成员发的：只有用户看到，@谁都不算数', () => {
    const s = store()
    s.setParticipants(WS, ['a_alice', 'a_bob'])
    const m = s.send(CAROL, { text: '@Alice @所有人 我也想说一句' }, WS)
    expect(m.audience).toEqual([])
    expect(m.mentions).toEqual([])
    expect(sees(s, 'a_alice')).toEqual([])
    expect(sees(s, 'a_carol')).toEqual(['@Alice @所有人 我也想说一句'])
    expect(sees(s, 'user')).toHaveLength(1)
  })

  it('用户发的：参与的都看到；点名外面的成员，那一条它也看到，别的还是看不到', () => {
    const s = store()
    s.setParticipants(WS, ['a_alice', 'a_bob'])
    s.send(USER, { text: '大家想想首页怎么改' }, WS)
    const m = s.send(USER, { text: '@Carol 你看一下这条' }, WS)
    expect(m.audience).toBeUndefined()
    expect(sees(s, 'a_alice')).toEqual(['大家想想首页怎么改', '@Carol 你看一下这条'])
    expect(sees(s, 'a_carol')).toEqual(['@Carol 你看一下这条'])
    expect(s.unread('a_carol', WS)).toMatchObject({ unread: 1, mentions: 1 })
    expect(sees(s, 'a_dave')).toEqual([])
  })

  it('看的是现在的名单：后来加进来的看得到之前的讨论；移出去的看不到了（点过它名的、它自己发的除外）；不挑了都看得到', () => {
    const s = store()
    s.send(BOB, { text: '挑人之前的话' }, WS)
    s.setParticipants(WS, ['a_alice', 'a_bob'])
    s.send(ALICE, { text: '挑人之后的话' }, WS)
    expect(sees(s, 'a_carol')).toEqual([])
    s.setParticipants(WS, ['a_alice', 'a_bob', 'a_carol'])
    expect(sees(s, 'a_carol')).toEqual(['挑人之前的话', '挑人之后的话'])
    expect(s.unread('a_carol', WS).unread).toBe(2)
    s.send(CAROL, { text: '@Bob 我来了' }, WS)
    s.setParticipants(WS, ['a_alice', 'a_carol'])
    expect(sees(s, 'a_bob')).toEqual(['挑人之前的话', '@Bob 我来了'])
    s.setParticipants(WS, undefined)
    expect(sees(s, 'a_dave')).toEqual(['挑人之前的话', '挑人之后的话', '@Bob 我来了'])
  })

  it('等消息：参与的人说话不叫醒外面的成员', async () => {
    const s = store()
    s.setParticipants(WS, ['a_alice', 'a_bob'])
    const inside = s.wait('a_bob', { channels: [WS], timeoutMs: 3000 })
    const outside = s.wait('a_carol', { channels: [WS], timeoutMs: 150 })
    s.send(ALICE, { text: '@所有人 开始' }, WS)
    expect((await inside).map((m) => m.text)).toEqual(['@所有人 开始'])
    expect(await outside).toEqual([])
  })

  it('大厅挑了人：私聊不受影响', () => {
    const s = store()
    s.setParticipants('general', ['a_alice', 'a_bob'])
    expect(codeOf(() => s.send(CAROL, { text: '私下说', to: 'Alice' }))).toBe('OK')
    expect(sees(s, 'a_alice', 'general')).toEqual(['私下说'])
    expect(sees(s, 'a_bob', 'general')).toEqual([])
  })

  it('名单跟着干活方式走：改成分工明确，参与的人（除了主脑）是子代理；改回来，主脑和子代理是参与的人', () => {
    const s = store()
    s.setParticipants(WS, ['a_alice', 'a_bob'])
    s.setLead(WS, 'a_alice')
    expect(s.participants(WS)).toBeUndefined()
    expect(s.subs(WS)).toEqual(['a_bob'])
    expect([s.role(WS, 'a_alice'), s.role(WS, 'a_bob'), s.role(WS, 'a_carol')]).toEqual(['lead', 'sub', 'out'])
    s.setLead(WS, undefined)
    expect(s.participants(WS)).toEqual(['a_alice', 'a_bob'])
    // 主脑不在参与名单里：改回来时它也算参与的人
    s.setLead(WS, 'a_carol')
    expect(s.subs(WS)).toEqual(['a_alice', 'a_bob'])
    s.setLead(WS, undefined)
    expect(s.participants(WS)).toEqual(['a_carol', 'a_alice', 'a_bob'])
    // 没挑过人的：来回改都是不挑
    s.setParticipants(WS, undefined)
    s.setLead(WS, 'a_alice')
    expect(s.subs(WS)).toBeUndefined()
    s.setLead(WS, undefined)
    expect(s.participants(WS)).toBeUndefined()
  })

  it('灵感激荡时的话，改成分工明确以后没选中的成员还是看不到', () => {
    const s = store()
    s.setParticipants(WS, ['a_alice', 'a_bob'])
    s.send(ALICE, { text: '只给参与的人看' }, WS)
    s.setLead(WS, 'a_alice')
    expect(sees(s, 'a_carol')).toEqual([])
    expect(sees(s, 'a_bob')).toEqual(['只给参与的人看'])
  })

  it('存盘：名单在 teams.json，重开后还在；参与的人被吊销就从名单里去掉，一个都不剩就算没挑过', () => {
    const s = store()
    s.setParticipants(WS, ['a_alice', 'a_bob'])
    const file = path.join(base, 'chat', 'teams.json')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ [WS]: ['a_alice', 'a_bob'] })
    expect(fs.existsSync(path.join(base, 'chat', 'modes.json')) ? JSON.parse(fs.readFileSync(path.join(base, 'chat', 'modes.json'), 'utf8')) : {}).toEqual({})
    expect(store().participants(WS)).toEqual(['a_alice', 'a_bob'])
    members = members.filter((m) => m.id !== 'a_bob')
    s.removeMember('a_bob')
    expect(s.participants(WS)).toEqual(['a_alice'])
    members = members.filter((m) => m.id !== 'a_alice')
    s.removeMember('a_alice')
    expect(s.participants(WS)).toBeUndefined()
    expect(s.sitsOut(WS, 'a_carol')).toBe(false)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({})
  })
})

// ---------- 经过 Bridge 和 MCP ----------

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
  const c = new Client({ name: 'chat-parts-test', version: '1.0.0' })
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

describe('经过 Bridge 和 MCP：灵感激荡挑参与的 AI', () => {
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

  const info = (): { leadId?: string; subIds?: string[]; partIds?: string[] } => bridge.getState().chat.channels.find((c) => c.id === ws) ?? {}
  const channelOf = (r: Result): { mode: string; participants?: string[]; you_participate?: boolean; your_role?: string; subs?: string[] } => r.data.find((c: { id: string }) => c.id === ws)
  const drain = async (): Promise<void> => {
    for (const x of [a, b, cc, d]) await call(x.c, 'whoami')
  }

  it('挑人：状态带 partIds；选中的和没选中的收到说法不同的通知；chat_channels 带 participants 和 you_participate', async () => {
    await drain()
    bridge.setChatParticipants(ws, [a.agent.id, b.agent.id])
    expect(info().partIds).toEqual([a.agent.id, b.agent.id])
    expect(info().leadId).toBeUndefined()
    const [ra, rc] = [await call(a.c, 'chat_channels'), await call(cc.c, 'chat_channels')]
    expect(ra.notices).toContain('用户挑了参与讨论的 AI：Alice、Bob（有你）')
    expect(rc.notices).toContain('没有选你')
    expect(channelOf(ra)).toMatchObject({ mode: 'brainstorm', participants: ['Alice', 'Bob'], you_participate: true })
    expect(channelOf(rc)).toMatchObject({ mode: 'brainstorm', participants: ['Alice', 'Bob'], you_participate: false })
    // 没挑过的频道没有这两个字段
    const lobby = ra.data.find((c: { id: string }) => c.id === 'general')
    expect(lobby.participants).toBeUndefined()
    expect(lobby.you_participate).toBeUndefined()
  })

  it('改名单：加进来的、移出去的、留下的各有说法；一直在外面的不打扰；不挑了，外面的回到讨论里', async () => {
    bridge.setChatParticipants(ws, [a.agent.id, b.agent.id])
    await drain()
    bridge.setChatParticipants(ws, [a.agent.id, cc.agent.id])
    const [na, nb, nc, nd] = [await call(a.c, 'whoami'), await call(b.c, 'whoami'), await call(cc.c, 'whoami'), await call(d.c, 'whoami')]
    expect(na.notices).toContain('参与讨论的 AI 变了，现在是：Alice、Carol')
    expect(nb.notices).toContain('没有选你')
    expect(nc.notices).toContain('用户把你加进了讨论')
    expect(nd.notices).toBe('')
    // 同一份名单再设一次：谁都不通知
    bridge.setChatParticipants(ws, [cc.agent.id, a.agent.id])
    expect((await call(a.c, 'whoami')).notices).toBe('')
    bridge.setChatParticipants(ws, null)
    expect(info().partIds).toBeUndefined()
    expect((await call(d.c, 'whoami')).notices).toContain('你回到讨论里了')
    expect((await call(a.c, 'whoami')).notices).toContain('不再挑参与的 AI')
  })

  it('参与的人说话：参与的收到，外面的没有通知、读不到；@外面的成员结果里说没送到', async () => {
    bridge.setChatParticipants(ws, [a.agent.id, b.agent.id])
    await drain()
    const s1 = await call(a.c, 'chat_send', { channel: ws, text: '@Bob @Dave 对一下接口' })
    expect(s1.isError).toBe(false)
    expect(s1.data.note).toContain('Dave 没有参与这个频道的讨论')
    expect(s1.data.mentions).toEqual([b.agent.id])
    expect((await call(b.c, 'whoami')).notices).toContain('对一下接口')
    expect((await call(d.c, 'whoami')).notices).toBe('')
    expect((await call(d.c, 'chat_read', { channel: ws })).data.messages).toEqual([])
    const s2 = await call(a.c, 'chat_send', { channel: ws, text: '@所有人 三点前交' })
    expect(s2.data.note).toBeUndefined()
    expect((await call(cc.c, 'whoami')).notices).toBe('')
    expect((await call(cc.c, 'chat_channels')).data.find((c: { id: string }) => c.id === ws).unread).toBe(0)
    expect((await call(b.c, 'chat_read', { channel: ws })).data.messages.map((m: { text: string }) => m.text)).toEqual(['@Bob @Dave 对一下接口', '@所有人 三点前交'])
  })

  it('外面的成员发消息：结果里说清只有用户看到；参与的人没有通知、读不到', async () => {
    bridge.setChatParticipants(ws, [a.agent.id, b.agent.id])
    await drain()
    const sent = await call(d.c, 'chat_send', { channel: ws, text: '@Alice 我也可以帮忙' })
    expect(sent.isError).toBe(false)
    expect(sent.data.note).toContain('没有选你')
    expect(sent.data.only_visible_to).toEqual(['Dave', '用户'])
    expect((await call(a.c, 'whoami')).notices).toBe('')
    expect((await call(a.c, 'chat_read', { channel: ws })).data.messages).toEqual([])
  })

  it('用户在工作台说话：参与的收到，外面的收不到；点名外面的成员，它收到那一条', async () => {
    bridge.setChatParticipants(ws, [a.agent.id, b.agent.id])
    await drain()
    bridge.sendChat({ channel: ws, text: '大家想想首页怎么改' })
    expect((await call(a.c, 'whoami')).notices).toContain('大家想想首页怎么改')
    expect((await call(d.c, 'whoami')).notices).toBe('')
    bridge.sendChat({ channel: ws, text: '@Dave 这个仓库你先别动' })
    expect((await call(d.c, 'whoami')).notices).toContain('这个仓库你先别动')
    expect((await call(cc.c, 'whoami')).notices).toBe('')
    expect((await call(d.c, 'chat_read', { channel: ws })).data.messages.map((m: { text: string }) => m.text)).toEqual(['@Dave 这个仓库你先别动'])
  })

  it('加进来的 AI 读得到之前的讨论', async () => {
    bridge.setChatParticipants(ws, [a.agent.id, b.agent.id])
    await call(a.c, 'chat_send', { channel: ws, text: '方案一：先做首页' })
    bridge.setChatParticipants(ws, [a.agent.id, b.agent.id, cc.agent.id])
    expect((await call(cc.c, 'chat_read', { channel: ws })).data.messages.map((m: { text: string }) => m.text)).toEqual(['方案一：先做首页'])
  })

  it('改成分工明确再改回来：名单跟着走，通知里说清谁在里面', async () => {
    bridge.setChatParticipants(ws, [a.agent.id, b.agent.id])
    bridge.setChatLead(ws, a.agent.id)
    expect(info()).toMatchObject({ leadId: a.agent.id, subIds: [b.agent.id] })
    expect(info().partIds).toBeUndefined()
    await drain()
    bridge.setChatLead(ws, undefined)
    expect(info().leadId).toBeUndefined()
    expect(info().partIds).toEqual([a.agent.id, b.agent.id])
    expect((await call(b.c, 'whoami')).notices).toContain('参与讨论的还是用户挑的这几个：Alice、Bob')
    // 一直在外面的也说一声（它被告知过改回灵感激荡时会收到通知）：还是没有它
    expect((await call(cc.c, 'whoami')).notices).toContain('没有你')
  })

  it('校验：分工明确的频道不能挑；空名单、不存在的 AI 报错，什么都不改', () => {
    expect(() => bridge.setChatParticipants(ws, [])).toThrow(/至少选一个/)
    expect(() => bridge.setChatParticipants(ws, ['no-such-agent'])).toThrow(/不存在/)
    expect(info().partIds).toBeUndefined()
    bridge.setChatLead(ws, a.agent.id)
    expect(() => bridge.setChatParticipants(ws, [b.agent.id])).toThrow(/分工明确/)
  })

  it('参与的 AI 被吊销：名单里没有它了', async () => {
    bridge.setChatParticipants(ws, [a.agent.id, b.agent.id])
    await bridge.removeAgent(b.agent.id)
    expect(info().partIds).toEqual([a.agent.id])
  })
})

describe('界面：参与的 AI', () => {
  const agents = [
    { id: 'a_alice', name: 'Alice' },
    { id: 'a_bob', name: 'Bob' },
    { id: 'a_carol', name: 'Carol' }
  ] as unknown as Agent[]
  const state = (extra: Record<string, unknown> = {}): BridgeState =>
    ({ agents, chat: { unread: 0, mentions: 0, channels: [{ id: WS, name: 'demo', unread: 0, mentions: 0, lastTs: 0, ...extra }] } }) as unknown as BridgeState

  it('partsOf：没挑过是都参与；挑过只算名单里还在的；分工明确没有', () => {
    expect(partsOf(state(), WS, agents)).toEqual({ picked: false, ids: ['a_alice', 'a_bob', 'a_carol'] })
    expect(partsOf(state({ partIds: ['a_carol', 'a_gone', 'a_alice'] }), WS, agents)).toEqual({ picked: true, ids: ['a_alice', 'a_carol'] })
    expect(partsOf(state({ leadId: 'a_alice' }), WS, agents)).toBeUndefined()
  })

  it('modeLine：挑过参与的 AI 的带个数；没挑过的灵感激荡没有这行', () => {
    expect(modeLine(state(), WS)).toBeUndefined()
    expect(modeLine(state({ partIds: ['a_alice', 'a_bob', 'a_gone'] }), WS)).toBe('灵感激荡 · 2 个 AI 参与')
  })
})
