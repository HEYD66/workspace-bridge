// 会话：项目里另开的群聊，能新开、改名、归档、删除；主群聊和大厅只能清空
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { ChatStore, channelWorkspaceId, isMainChannel, isThreadChannel, type ChatMember, type ChatSender } from '../src/core/chat'
import { ToolError } from '../src/core/fileTools'
import { channelFullName, channelLabel, channelsOf, channelTs, channelWorkspaceId as uiWorkspaceId, chatTotals } from '../src/renderer/src/lib/groupChat'
import { projectRows, recentItems } from '../src/renderer/src/lib/projects'
import type { Agent, BridgeState, GroupChannelInfo } from '../src/core/types'

let base: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-chat-threads-'))
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

const members: ChatMember[] = [
  { id: 'a_alice', name: 'Alice' },
  { id: 'a_bob', name: 'Bob' }
]
const ALICE: ChatSender = { kind: 'agent', id: 'a_alice', name: 'Alice' }
const BOB: ChatSender = { kind: 'agent', id: 'a_bob', name: 'Bob' }
const USER: ChatSender = { kind: 'user', id: 'user', name: '你' }
const WS = 'ws:w_demo'

const dir = (): string => path.join(base, 'chat')
const store = (over: { maxMessages?: number; now?: () => number } = {}): ChatStore => new ChatStore({ dir: dir(), members: () => members, ...over })
const codeOf = (fn: () => unknown): string => {
  try {
    fn()
    return 'OK'
  } catch (e) {
    return e instanceof ToolError ? e.code : String(e)
  }
}
const texts = (s: ChatStore, channel: string, viewer = 'user'): string[] => s.list({ channel, viewer, limit: 500 }).map((m) => m.text)

describe('频道 id', () => {
  it('主群聊和会话都能取出工作区 id；大厅没有；界面那份算得一样', () => {
    for (const f of [channelWorkspaceId, uiWorkspaceId]) {
      expect(f('ws:w_demo')).toBe('w_demo')
      expect(f('ws:w_demo.c_0123456789')).toBe('w_demo')
      expect(f('ws:w-a_b.c_abcdef')).toBe('w-a_b')
      expect(f('general')).toBeUndefined()
    }
    expect(isThreadChannel('ws:w_demo.c_0123456789')).toBe(true)
    expect(isThreadChannel('ws:w_demo')).toBe(false)
    expect(isThreadChannel('general')).toBe(false)
    expect(isThreadChannel('ws:w_demo.x_0123456789')).toBe(false)
  })
})

describe('ChatStore：会话', () => {
  it('新开：id 带工作区，标题收拾过，按工作区列出；重启后还在', () => {
    const s = store()
    const t = s.createThread('w_demo', '  登录页\n改版  ')
    expect(t.id).toMatch(/^ws:w_demo\.c_[a-z0-9]{10}$/)
    expect(t).toMatchObject({ workspaceId: 'w_demo', title: '登录页 改版' })
    const other = s.createThread('w_other', '别的项目')
    expect(s.threads('w_demo').map((x) => x.id)).toEqual([t.id])
    expect(s.threads().map((x) => x.id).sort()).toEqual([t.id, other.id].sort())
    expect(s.thread(t.id)?.title).toBe('登录页 改版')
    expect(s.thread(WS)).toBeUndefined()
    expect(s.thread('general')).toBeUndefined()
    const again = store()
    expect(again.threads('w_demo').map((x) => [x.id, x.title])).toEqual([[t.id, '登录页 改版']])
  })

  it('标题不能空、不能太长；没登记过的会话 id 不能用（不会凭空建出文件）', () => {
    const s = store()
    expect(codeOf(() => s.createThread('w_demo', '   '))).toBe('INVALID_ARGS')
    expect(codeOf(() => s.createThread('w_demo', 'x'.repeat(61)))).toBe('TOO_LARGE')
    expect(codeOf(() => s.createThread('bad id!', '标题'))).toBe('INVALID_ARGS')
    expect(codeOf(() => s.send(ALICE, { text: 'hi' }, 'ws:w_demo.c_0123456789'))).toBe('NOT_FOUND')
    expect(codeOf(() => s.list({ channel: 'ws:w_demo.c_0123456789', viewer: 'user' }))).toBe('NOT_FOUND')
    expect(fs.readdirSync(dir()).filter((f) => f.includes('.c_'))).toEqual([])
  })

  it('会话是独立的频道：消息、序号、未读、干活方式都各管各的', () => {
    const s = store()
    const t = s.createThread('w_demo', '支线')
    s.send(ALICE, { text: '主群聊里说' }, WS)
    s.send(ALICE, { text: '会话里说 1' }, t.id)
    const m = s.send(BOB, { text: '会话里说 2' }, t.id)
    expect(m).toMatchObject({ channel: t.id, seq: 2 })
    expect(texts(s, WS)).toEqual(['主群聊里说'])
    expect(texts(s, t.id)).toEqual(['会话里说 1', '会话里说 2'])
    expect(s.unread('a_bob', t.id).unread).toBe(1)
    expect(s.unread('a_bob', WS).unread).toBe(1)
    s.setLead(t.id, 'a_alice')
    expect(s.lead(t.id)).toBe('a_alice')
    expect(s.lead(WS)).toBeUndefined()
    expect(fs.existsSync(path.join(dir(), `ws_w_demo.c_${t.id.split('.c_')[1]}.jsonl`))).toBe(true)
  })

  it('改名：标题变了才算变；主群聊、不存在的会话不能改', () => {
    const s = store()
    const t = s.createThread('w_demo', '旧名')
    expect(s.renameThread(t.id, '新名')).toBe(true)
    expect(s.renameThread(t.id, ' 新名 ')).toBe(false)
    expect(s.thread(t.id)?.title).toBe('新名')
    expect(codeOf(() => s.renameThread(t.id, ''))).toBe('INVALID_ARGS')
    expect(codeOf(() => s.renameThread(WS, 'x'))).toBe('NOT_FOUND')
    expect(codeOf(() => s.renameThread('ws:w_demo.c_0123456789', 'x'))).toBe('NOT_FOUND')
  })

  it('主群聊起名字：记在 threads.json 的 titles 里，留空恢复默认；大厅和会话不走这条；重开还在，删会话、清空不丢', () => {
    const s = store()
    expect(isMainChannel(WS)).toBe(true)
    expect(isMainChannel('general')).toBe(false)
    expect(isMainChannel('ws:w_demo.c_0123456789')).toBe(false)
    expect(s.mainTitle(WS)).toBeUndefined()
    expect(s.renameMain(WS, '  日常  闲聊 ')).toBe(true)
    expect(s.renameMain(WS, '日常 闲聊')).toBe(false)
    expect(s.mainTitle(WS)).toBe('日常 闲聊')
    expect(codeOf(() => s.renameMain('general', 'x'))).toBe('INVALID_ARGS')
    expect(codeOf(() => s.renameMain('ws:w_demo.c_0123456789', 'x'))).toBe('INVALID_ARGS')
    expect(codeOf(() => s.renameMain(WS, 'x'.repeat(61)))).toBe('TOO_LARGE')
    expect(s.mainTitle(WS)).toBe('日常 闲聊')
    // 删一个会话、清空主群聊都会重写 threads.json：名字得留着
    const t = s.createThread('w_demo', '要删的')
    s.send(USER, { channel: t.id, text: 'x' })
    s.removeChannel(t.id)
    s.send(USER, { channel: WS, text: 'y' })
    s.removeChannel(WS)
    expect(s.mainTitle(WS)).toBe('日常 闲聊')
    expect(JSON.parse(fs.readFileSync(path.join(dir(), 'threads.json'), 'utf8')).titles).toEqual({ [WS]: '日常 闲聊' })
    expect(store().mainTitle(WS)).toBe('日常 闲聊')
    // 另一个项目不受影响；留空是恢复默认
    expect(s.mainTitle('ws:w_other')).toBeUndefined()
    expect(s.renameMain(WS, '   ')).toBe(true)
    expect(s.renameMain(WS, '')).toBe(false)
    expect(s.mainTitle(WS)).toBeUndefined()
    expect(JSON.parse(fs.readFileSync(path.join(dir(), 'threads.json'), 'utf8')).titles).toEqual({})
  })

  it('归档：不能再发言，消息还在、还能读；恢复后又能发', () => {
    const s = store()
    const t = s.createThread('w_demo', '要归档的')
    s.send(ALICE, { text: '归档前' }, t.id)
    expect(s.setThreadArchived(t.id, true)).toBe(true)
    expect(s.setThreadArchived(t.id, true)).toBe(false)
    expect(s.thread(t.id)?.archived).toBe(true)
    expect(codeOf(() => s.send(ALICE, { text: '归档后' }, t.id))).toBe('INVALID_ARGS')
    expect(codeOf(() => s.send(USER, { text: '用户也不行' }, t.id))).toBe('INVALID_ARGS')
    expect(texts(s, t.id)).toEqual(['归档前'])
    expect(store().thread(t.id)?.archived).toBe(true)
    expect(s.setThreadArchived(t.id, false)).toBe(true)
    expect(s.thread(t.id)?.archived).toBeUndefined()
    s.send(ALICE, { text: '恢复后' }, t.id)
    expect(texts(s, t.id)).toEqual(['归档前', '恢复后'])
  })

  it('删除会话：频道没了，记录、已读位置、干活方式都去掉；消息文件挪进 deleted/，主群聊不受影响', () => {
    const s = store({ now: () => new Date(2026, 10, 14, 9, 5, 7).getTime() })
    const t = s.createThread('w_demo', '要删的')
    const keep = s.createThread('w_demo', '留着的')
    s.send(ALICE, { text: '主群聊' }, WS)
    s.send(ALICE, { text: '要删 1' }, t.id)
    s.send(BOB, { text: '要删 2' }, t.id)
    s.send(ALICE, { text: '留着' }, keep.id)
    s.markRead('a_bob', 1, t.id)
    s.setLead(t.id, 'a_alice')
    s.setSubs(t.id, ['a_bob'])
    expect(s.removeChannel(t.id)).toBe(2)
    expect(s.thread(t.id)).toBeUndefined()
    expect(s.threads('w_demo').map((x) => x.id)).toEqual([keep.id])
    expect(codeOf(() => s.list({ channel: t.id, viewer: 'user' }))).toBe('NOT_FOUND')
    expect(codeOf(() => s.send(ALICE, { text: '再发' }, t.id))).toBe('NOT_FOUND')
    expect(texts(s, WS)).toEqual(['主群聊'])
    expect(texts(s, keep.id)).toEqual(['留着'])
    const fileBase = t.id.replace(':', '_')
    expect(fs.existsSync(path.join(dir(), `${fileBase}.jsonl`))).toBe(false)
    const moved = path.join(dir(), 'deleted', `20261114-090507-${fileBase}`, `${fileBase}.jsonl`)
    expect(fs.readFileSync(moved, 'utf8')).toContain('要删 2')
    for (const f of ['cursors.json', 'modes.json', 'teams.json', 'threads.json']) expect(fs.readFileSync(path.join(dir(), f), 'utf8')).not.toContain(t.id)
    // 重启后也是没了
    const again = store()
    expect(again.threads('w_demo').map((x) => x.id)).toEqual([keep.id])
    expect(texts(again, keep.id)).toEqual(['留着'])
  })

  it('清空主群聊 / 大厅：频道还在，消息没了，序号接着往后排（重启后也是），已读位置不错位', () => {
    const s = store()
    s.send(ALICE, { text: '一' }, WS)
    s.send(BOB, { text: '二' }, WS)
    s.send(ALICE, { text: '三' }, WS)
    s.markRead('a_bob', 3, WS)
    s.setLead(WS, 'a_alice')
    expect(s.removeChannel(WS)).toBe(3)
    expect(texts(s, WS)).toEqual([])
    expect(s.floor(WS)).toBe(3)
    expect(s.lastTs(WS)).toBe(0)
    expect(s.unread('a_bob', WS)).toEqual({ unread: 0, mentions: 0 })
    // 干活方式留着
    expect(s.lead(WS)).toBe('a_alice')
    const again = store()
    const m = again.send(USER, { text: '清空后第一条' }, WS)
    expect(m.seq).toBe(4)
    // 分工明确时用户不 @ 只发给主脑：主脑有 1 条未读；Bob 的已读位置原样留着
    expect(again.unread('a_alice', WS).unread).toBe(1)
    expect(again.cursor('a_bob', WS)).toBe(3)
    expect(texts(again, WS)).toEqual(['清空后第一条'])
    // 大厅也能清；空的频道清了不出错
    s.send(ALICE, { text: '大厅里' })
    expect(s.removeChannel('general')).toBe(1)
    expect(s.removeChannel('general')).toBe(0)
    expect(texts(s, 'general')).toEqual([])
  })

  it('清空时归档文件也一起挪走；同名工作区前缀的别的频道不动', () => {
    const s = store({ maxMessages: 4 })
    const t = s.createThread('w_demo', '支线')
    for (let i = 1; i <= 6; i++) s.send(ALICE, { text: `主 ${i}` }, WS)
    for (let i = 1; i <= 6; i++) s.send(ALICE, { text: `支 ${i}` }, t.id)
    const arch = path.join(dir(), 'archive')
    const before = fs.readdirSync(arch)
    expect(before.some((f) => f.startsWith('ws_w_demo-'))).toBe(true)
    expect(before.some((f) => f.startsWith('ws_w_demo.c_'))).toBe(true)
    s.removeChannel(WS)
    const after = fs.readdirSync(arch)
    expect(after.some((f) => f.startsWith('ws_w_demo-'))).toBe(false)
    expect(after.some((f) => f.startsWith('ws_w_demo.c_'))).toBe(true)
    expect(texts(s, t.id).length).toBeGreaterThan(0)
    // 序号从清掉的最大序号往后接
    expect(s.send(ALICE, { text: '主 7' }, WS).seq).toBe(7)
  })

  it('threads.json 坏了或混进别的东西：只认看得懂的', () => {
    fs.mkdirSync(dir(), { recursive: true })
    fs.writeFileSync(
      path.join(dir(), 'threads.json'),
      JSON.stringify({ threads: { 'ws:w_demo.c_aaaaaaaaaa': { title: '好的', createdAt: 5 }, 'ws:w_demo': { title: '不是会话' }, 'ws:w_demo.c_bbbbbbbbbb': { title: '' }, junk: 1 }, floors: { 'ws:w_demo': 'x', general: 9 } })
    )
    const s = store()
    expect(s.threads().map((t) => t.id)).toEqual(['ws:w_demo.c_aaaaaaaaaa'])
    expect(s.floor('ws:w_demo')).toBe(0)
    expect(s.send(ALICE, { text: '大厅' }).seq).toBe(10)
  })
})

// ---------- Bridge + MCP ----------

let url: string
const clients: Client[] = []

interface Result {
  isError: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  raw: string
  notices: string
}

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 'chat-threads-test', version: '1.0.0' })
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
  return { isError: Boolean(r.isError), data, raw: body, notices: parts.filter((t) => t.startsWith('【通知】')).join('\n') }
}

describe('经过 Bridge 和 MCP：会话', () => {
  let bridge: Bridge
  let a: { agent: Agent; c: Client }
  let b: { agent: Agent; c: Client }
  let wsId: string
  let main: string

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
    wsId = bridge.getState().activeWorkspaceId!
    main = `ws:${wsId}`
  })

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.stop()
  })

  const channels = (): GroupChannelInfo[] => bridge.getState().chat.channels
  const ids = async (x: { c: Client }): Promise<string[]> => (await call(x.c, 'chat_channels')).data.map((c: { id: string }) => c.id)

  it('新开会话：状态里跟在主群聊后面，带 thread；AI 的 chat_channels 里也有，带 conversation', async () => {
    const t = bridge.createChatThread(wsId, '登录页改版')
    expect(t.id.startsWith(`${main}.c_`)).toBe(true)
    expect(t).toMatchObject({ workspaceId: wsId, thread: { title: '登录页改版' }, unread: 0, lastTs: 0 })
    const list = channels().map((c) => c.id)
    expect(list.indexOf(t.id)).toBe(list.indexOf(main) + 1)
    const wsName = bridge.getState().workspaces!.find((w) => w.id === wsId)!.name
    expect(channels().find((c) => c.id === t.id)?.name).toBe(`${wsName} / 登录页改版`)
    const r = await call(a.c, 'chat_channels')
    const mine = r.data.find((c: { id: string }) => c.id === t.id)
    expect(mine).toMatchObject({ conversation: '登录页改版', workspace_id: wsId, mode: 'brainstorm', unread: 0 })
    expect(r.data.find((c: { id: string }) => c.id === main).conversation).toBeUndefined()
    // 不给标题：自动起名
    const auto = bridge.createChatThread(wsId)
    expect(auto.thread?.title).toMatch(/^新会话 \d{1,2}-\d{1,2} \d{2}:\d{2}$/)
    expect(() => bridge.createChatThread('w_nope', 'x')).toThrow(/不存在/)
  })

  it('在会话里聊：用户发的带全文通知到 AI，标着「工作区 / 会话」；AI 用 id、标题都能发和读；主群聊看不到', async () => {
    const t = bridge.createChatThread(wsId, '支线讨论')
    bridge.sendChat({ channel: t.id, text: '这条发在会话里' })
    const w = await call(a.c, 'whoami')
    expect(w.notices).toContain('支线讨论')
    expect(w.notices).toContain('这条发在会话里')
    expect(w.notices).toContain(`channel=${t.id}`)
    const s1 = await call(a.c, 'chat_send', { channel: t.id, text: 'Alice 用 id 回' })
    expect(s1.isError).toBe(false)
    const s2 = await call(b.c, 'chat_send', { channel: '支线讨论', text: 'Bob 用标题回' })
    expect(s2.isError).toBe(false)
    const read = await call(b.c, 'chat_read', { channel: t.id })
    expect(read.raw).toContain('这条发在会话里')
    expect(read.raw).toContain('Alice 用 id 回')
    const mainRead = await call(b.c, 'chat_read', { channel: main })
    expect(mainRead.raw).not.toContain('这条发在会话里')
    expect(bridge.listChat({ channel: t.id }).map((m) => m.text)).toEqual(['这条发在会话里', 'Alice 用 id 回', 'Bob 用标题回'])
    expect(channels().find((c) => c.id === t.id)?.unread).toBe(2)
    // 没这个会话
    const bad = await call(a.c, 'chat_send', { channel: `${main}.c_0000000000`, text: '不该发到主群聊' })
    expect(bad.isError).toBe(true)
    expect(bridge.listChat({ channel: main })).toEqual([])
  })

  it('改名：状态和 AI 看到的名字都变；大厅不能改名，主群聊、大厅不能归档', async () => {
    const t = bridge.createChatThread(wsId, '旧名')
    bridge.renameChatThread(t.id, '新名')
    expect(channels().find((c) => c.id === t.id)?.thread?.title).toBe('新名')
    expect((await call(a.c, 'chat_channels')).data.find((c: { id: string }) => c.id === t.id).conversation).toBe('新名')
    expect(() => bridge.renameChatThread('general', 'x')).toThrow(/不是另开的会话/)
    expect(() => bridge.archiveChatThread('general', true)).toThrow(/不是另开的会话/)
    expect(() => bridge.archiveChatThread(main, true)).toThrow(/不是另开的会话/)
    expect(() => bridge.renameChatThread(t.id, '')).toThrow()
  })

  it('主群聊起名字：状态里多 title，name 不变；AI 看到的频道名、用项目名发消息都不变；留空恢复', async () => {
    const before = (await call(a.c, 'chat_channels')).data.find((c: { id: string }) => c.id === main)
    const nameBefore = channels().find((c) => c.id === main)?.name
    bridge.renameChatThread(main, '日常闲聊')
    const info = channels().find((c) => c.id === main)
    expect(info?.title).toBe('日常闲聊')
    expect(info?.name).toBe(nameBefore)
    expect(info?.thread).toBeUndefined()
    expect((await call(a.c, 'chat_channels')).data.find((c: { id: string }) => c.id === main)).toEqual(before)
    expect((await call(a.c, 'chat_send', { channel: nameBefore, text: '用项目名照样能发' })).isError).toBe(false)
    expect(bridge.listChat({ channel: main }).map((m) => m.text)).toEqual(['用项目名照样能发'])
    expect(() => bridge.renameChatThread(main, 'x'.repeat(61))).toThrow()
    bridge.renameChatThread(main, '')
    expect(channels().find((c) => c.id === main)?.title).toBeUndefined()
    expect(() => bridge.renameChatThread('ws:w_nope', 'x')).toThrow(/不存在/)
  })

  it('归档：AI 的频道列表里没了、发不进去、排着的通知不再送；用户还能看；未读不算进总数；恢复后回来', async () => {
    const t = bridge.createChatThread(wsId, '要归档')
    await call(a.c, 'chat_send', { channel: t.id, text: '归档前说的' })
    bridge.sendChat({ channel: t.id, text: '用户：归档前' })
    const totalBefore = bridge.getState().chat.unread
    expect(totalBefore).toBeGreaterThan(0)
    bridge.archiveChatThread(t.id, true)
    expect(channels().find((c) => c.id === t.id)?.thread?.archived).toBe(true)
    expect(bridge.getState().chat.unread).toBe(totalBefore - 1)
    expect(await ids(a)).not.toContain(t.id)
    const w = await call(b.c, 'whoami')
    expect(w.notices).not.toContain('用户：归档前')
    const send = await call(a.c, 'chat_send', { channel: t.id, text: '归档后' })
    expect(send.isError).toBe(true)
    expect(send.raw).toContain('归档')
    expect(() => bridge.sendChat({ channel: t.id, text: '用户也发不了' })).toThrow(/归档/)
    expect(bridge.listChat({ channel: t.id }).map((m) => m.text)).toEqual(['归档前说的', '用户：归档前'])
    bridge.archiveChatThread(t.id, false)
    expect(await ids(a)).toContain(t.id)
    expect((await call(a.c, 'chat_send', { channel: t.id, text: '恢复后' })).isError).toBe(false)
  })

  it('删除会话：状态和 AI 那里都没了，发消息报不存在；主群聊还在', async () => {
    const t = bridge.createChatThread(wsId, '要删')
    await call(a.c, 'chat_send', { channel: t.id, text: '会话里的' })
    await call(a.c, 'chat_send', { channel: main, text: '主群聊里的' })
    expect(bridge.deleteChatChannel(t.id)).toBe(1)
    expect(channels().some((c) => c.id === t.id)).toBe(false)
    expect(await ids(b)).not.toContain(t.id)
    expect((await call(a.c, 'chat_send', { channel: t.id, text: 'x' })).isError).toBe(true)
    expect(() => bridge.listChat({ channel: t.id })).toThrow(/不存在/)
    expect(bridge.listChat({ channel: main }).map((m) => m.text)).toEqual(['主群聊里的'])
    expect(fs.readdirSync(path.join(base, 'data', 'chat', 'deleted')).length).toBe(1)
  })

  it('清空主群聊：消息没了，频道还在，状态带 floor；AI 排着的通知不再送，之后照常收发', async () => {
    bridge.sendChat({ channel: main, text: '清空前用户说的' })
    await call(a.c, 'chat_send', { channel: main, text: '清空前 Alice 说的' })
    expect(bridge.deleteChatChannel(main)).toBe(2)
    const info = channels().find((c) => c.id === main)
    expect(info).toMatchObject({ unread: 0, lastTs: 0, floor: 2 })
    expect(bridge.listChat({ channel: main })).toEqual([])
    const w = await call(b.c, 'whoami')
    expect(w.notices).not.toContain('清空前用户说的')
    expect((await call(b.c, 'chat_read', { channel: main })).raw).not.toContain('清空前')
    const m = bridge.sendChat({ channel: main, text: '清空后' })
    expect(m.seq).toBe(3)
    expect((await call(b.c, 'chat_read', { channel: main })).raw).toContain('清空后')
  })

  it('会话有自己的干活方式，不影响主群聊；归档的会话不能再设主脑', async () => {
    const t = bridge.createChatThread(wsId, '分工的会话')
    bridge.setChatLead(t.id, a.agent.id)
    expect(channels().find((c) => c.id === t.id)?.leadId).toBe(a.agent.id)
    expect(channels().find((c) => c.id === main)?.leadId).toBeUndefined()
    const mode = (await call(b.c, 'chat_channels')).data.find((c: { id: string }) => c.id === t.id)
    expect(mode).toMatchObject({ mode: 'lead', your_role: 'sub' })
    // 归档的会话里的 AI 进不去：不能当主脑
    bridge.archiveChatThread(t.id, true)
    expect(() => bridge.setChatLead(t.id, b.agent.id)).toThrow()
  })

  it('移出工作区：它的会话不再列出', async () => {
    const other = path.join(base, 'ws2')
    fs.mkdirSync(other, { recursive: true })
    const w2 = await bridge.addWorkspace(other)
    const t = bridge.createChatThread(w2.id, '另一个项目的会话')
    expect(channels().some((c) => c.id === t.id)).toBe(true)
    await bridge.removeWorkspace(w2.id)
    expect(channels().some((c) => c.id === t.id)).toBe(false)
  })
})

// ---------- 界面用的纯函数 ----------

describe('界面：会话', () => {
  const T0 = 1_700_000_000_000
  const ch = (over: Partial<GroupChannelInfo>): GroupChannelInfo => ({ id: 'x', name: 'x', unread: 0, mentions: 0, lastTs: 0, ...over })
  const state = (): BridgeState =>
    ({
      activeWorkspaceId: 'w_a',
      workspaces: [{ id: 'w_a', name: 'alpha', root: 'D:/alpha', exists: true }],
      agents: [],
      chat: {
        unread: 0,
        mentions: 0,
        channels: [
          ch({ id: 'general', name: '大厅', lastTs: T0 }),
          ch({ id: 'ws:w_a', name: 'alpha', workspaceId: 'w_a', unread: 1, lastTs: T0 + 10 }),
          ch({ id: 'ws:w_a.c_old', name: 'alpha / 旧的', workspaceId: 'w_a', unread: 2, mentions: 1, lastTs: T0 + 20, thread: { title: '旧的', createdAt: T0 } }),
          ch({ id: 'ws:w_a.c_new', name: 'alpha / 刚开的', workspaceId: 'w_a', thread: { title: '刚开的', createdAt: T0 + 500 } }),
          ch({ id: 'ws:w_a.c_arc', name: 'alpha / 归档的', workspaceId: 'w_a', unread: 7, lastTs: T0 + 900, thread: { title: '归档的', createdAt: T0, archived: true } })
        ]
      }
    }) as unknown as BridgeState

  it('channelLabel / channelTs：会话用标题，主群聊叫群聊；没消息的会话按创建时间排', () => {
    const list = state().chat.channels
    expect(list.map(channelLabel)).toEqual(['大厅', '群聊', '旧的', '刚开的', '归档的'])
    // 主群聊起过名字：侧栏用名字，全称是「项目名 / 名字」；会话和大厅的全称就是 name
    const named = { ...list[1], title: '日常闲聊' }
    expect(channelLabel(named)).toBe('日常闲聊')
    expect(channelFullName(named)).toBe(`${list[1].name} / 日常闲聊`)
    expect(list.map(channelFullName)).toEqual(list.map((c) => c.name))
    expect(channelTs(list[3])).toBe(T0 + 500)
    expect(channelTs(list[2])).toBe(T0 + 20)
    expect(channelsOf(state()).map((c) => c.id)).toEqual(['general', 'ws:w_a.c_arc', 'ws:w_a.c_new', 'ws:w_a.c_old', 'ws:w_a'])
  })

  it('projectRows：会话挂在项目下面（新的在前），归档的单放；未读是主群聊加没归档的会话', () => {
    const [p] = projectRows(state(), {})
    expect(p.channel?.id).toBe('ws:w_a')
    expect(p.threads.map((c) => c.id)).toEqual(['ws:w_a.c_new', 'ws:w_a.c_old'])
    expect(p.archived.map((c) => c.id)).toEqual(['ws:w_a.c_arc'])
    expect([p.unread, p.mentions]).toEqual([3, 1])
    expect(chatTotals(state())).toEqual({ unread: 3, mentions: 1 })
  })

  it('最近：会话按标题列出，刚开还没消息的也在；归档的不列', () => {
    const r = recentItems(state(), {})
    expect(r.map((x) => [x.key, x.title])).toEqual([
      ['ch:ws:w_a.c_new', '刚开的'],
      ['ch:ws:w_a.c_old', '旧的'],
      ['ch:ws:w_a', '群聊'],
      ['ch:general', '大厅']
    ])
    expect(r[0].project).toBe('alpha')
  })
})
