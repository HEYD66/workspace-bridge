// T-26：T-19 的 A 部分（群聊消息带图片的核心接线）+ T-16 在 bridge 这边的部分（每个工作区一个文件占用登记）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Bridge, chatNoticeLine } from '../src/core/bridge'
import { ChatStore, type ChatMember, type ChatSender } from '../src/core/chat'
import { ChatAttachmentStore, type ChatAttachment } from '../src/core/chatAttachments'
import type { FileClaimStore } from '../src/core/fileClaims'
import { ToolError } from '../src/core/fileTools'
import type { Agent } from '../src/core/types'

// 把 bridge 交给 createMcpServer 的上下文留一份，核对运行时给的那几样（McpContext 的类型字段由接线加）
const captured = vi.hoisted(() => ({ ctxs: [] as Record<string, unknown>[] }))
vi.mock('../src/core/mcpServer', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/core/mcpServer')>()
  return {
    ...mod,
    createMcpServer: (ctx: Parameters<typeof mod.createMcpServer>[0]) => {
      captured.ctxs.push(ctx as unknown as Record<string, unknown>)
      return mod.createMcpServer(ctx)
    }
  }
})

/** 最小的 PNG 头：签名 + IHDR（宽 w 高 h），salt 让内容不同 */
function png(w: number, h: number, salt = 0): Buffer {
  const b = Buffer.alloc(40)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  b.writeUInt32BE(salt, 36)
  return b
}

let base: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-t26-'))
  captured.ctxs.length = 0
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
    return 'OK'
  } catch (e) {
    return e instanceof ToolError ? e.code : String(e)
  }
}

const members: ChatMember[] = [
  { id: 'a_alice', name: 'Alice' },
  { id: 'a_bob', name: 'Bob' }
]
const ALICE: ChatSender = { kind: 'agent', id: 'a_alice', name: 'Alice' }
const BOB: ChatSender = { kind: 'agent', id: 'a_bob', name: 'Bob' }

describe('群聊消息带图片（ChatStore）', () => {
  let images: ChatAttachmentStore
  const store = (opts: { noImages?: boolean; rateLimit?: number } = {}): ChatStore =>
    new ChatStore({
      dir: path.join(base, 'chat'),
      members: () => members,
      ...(opts.noImages ? {} : { attachments: images }),
      ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {})
    })

  beforeEach(() => {
    images = new ChatAttachmentStore(path.join(base, 'chat', 'attachments'))
  })

  it('带图片发消息：消息里存元信息；读出来也带着；不带图片的消息没有这个字段', () => {
    const s = store()
    const att = images.save(png(640, 480), '截图.png')
    const m = s.send(ALICE, { text: '看这个', attachments: [att] })
    expect(m.attachments).toEqual([{ id: att.id, kind: 'image', name: '截图.png', mime: 'image/png', size: 40, width: 640, height: 480 }])
    expect(m.text).toBe('看这个')
    expect(s.read('a_bob').messages[0].attachments).toEqual(m.attachments)
    const plain = s.send(ALICE, { text: '没图' })
    expect('attachments' in plain).toBe(false)
  })

  it('有图片时正文可以为空；没图片正文为空照旧报错（空数组也算没图片）', () => {
    const s = store()
    const att = images.save(png(10, 10))
    const m = s.send(ALICE, { text: '', attachments: [att] })
    expect(m.text).toBe('')
    expect(m.attachments).toHaveLength(1)
    expect(s.send(ALICE, { text: '   ', attachments: [att] }).text).toBe('')
    expect(codeOf(() => s.send(ALICE, { text: '' }))).toBe('INVALID_ARGS')
    expect(codeOf(() => s.send(ALICE, { text: '  ', attachments: [] }))).toBe('INVALID_ARGS')
    // 空数组加正文：照常发，消息上没有 attachments
    expect('attachments' in s.send(ALICE, { text: '有字', attachments: [] })).toBe(false)
  })

  it('调用方给的元信息不算数：只认 id，以磁盘上的为准；名字沿用调用方给的', () => {
    const s = store()
    const att = images.save(png(100, 50), 'a.png')
    const forged = { ...att, mime: 'text/html', size: 1, width: 9999, height: 9999, name: '改过的名字.png', kind: 'file' } as unknown as ChatAttachment
    const m = s.send(ALICE, { text: 'x', attachments: [forged] })
    expect(m.attachments).toEqual([{ id: att.id, kind: 'image', name: '改过的名字.png', mime: 'image/png', size: 40, width: 100, height: 50 }])
    // 只给 id 字符串也行
    const m2 = s.send(ALICE, { text: 'y', attachments: [att.id] as unknown as ChatAttachment[] })
    expect(m2.attachments?.[0]).toMatchObject({ id: att.id, mime: 'image/png', width: 100 })
  })

  it('没存过的图片发不出去：报错，消息不进频道，也不占限流的次数', () => {
    const s = store({ rateLimit: 2 })
    const ghost = { id: 'att_' + '0'.repeat(24), kind: 'image', name: 'x.png', mime: 'image/png', size: 1, width: 1, height: 1 } as ChatAttachment
    expect(codeOf(() => s.send(ALICE, { text: '看', attachments: [ghost] }))).toBe('NOT_FOUND')
    expect(codeOf(() => s.send(ALICE, { text: '看', attachments: [{ id: '../../etc/passwd' }] as unknown as ChatAttachment[] }))).toBe('NOT_FOUND')
    expect(codeOf(() => s.send(ALICE, { text: '看', attachments: 'att_x' as unknown as ChatAttachment[] }))).toBe('INVALID_ARGS')
    expect(codeOf(() => s.send(ALICE, { text: '看', attachments: [{}] as unknown as ChatAttachment[] }))).toBe('INVALID_ARGS')
    expect(s.read('a_bob').messages).toEqual([])
    // 限流是每分钟 2 条：前面失败的 4 次不算
    s.send(ALICE, { text: '一' })
    s.send(ALICE, { text: '二' })
    expect(codeOf(() => s.send(ALICE, { text: '三' }))).toBe('RATE_LIMITED')
  })

  it('一条最多 4 张；同一张重复带只算一次', () => {
    const s = store()
    const five = [1, 2, 3, 4, 5].map((n) => images.save(png(8, 8, n)))
    expect(codeOf(() => s.send(ALICE, { text: '多了', attachments: five }))).toBe('INVALID_ARGS')
    const m = s.send(ALICE, { text: '四张', attachments: [five[0], five[1], five[1], five[2], five[3], five[0]] })
    expect(m.attachments?.map((a) => a.id)).toEqual(five.slice(0, 4).map((a) => a.id))
  })

  it('没接图片存储的群聊：带图片报错，不带的照常', () => {
    const s = store({ noImages: true })
    const att = images.save(png(10, 10))
    expect(codeOf(() => s.send(ALICE, { text: '看', attachments: [att] }))).toBe('INVALID_ARGS')
    expect(codeOf(() => s.send(ALICE, { text: '', attachments: [att] }))).toBe('INVALID_ARGS')
    expect(s.send(ALICE, { text: '没图' }).seq).toBe(1)
    expect(s.send(ALICE, { text: '空数组', attachments: [] }).seq).toBe(2)
  })

  it('回执不能带图片', () => {
    const s = store()
    const att = images.save(png(10, 10))
    const ask = s.send(ALICE, { text: '谁有空' })
    expect(codeOf(() => s.send(BOB, { text: '收到', replyTo: ask.id, receipt: true, attachments: [att] }))).toBe('INVALID_ARGS')
    expect(s.send(BOB, { text: '收到', replyTo: ask.id, receipt: true }).kind).toBe('receipt')
  })

  it('带图片的消息照样解析 @、私聊、引用', () => {
    const s = store()
    const att = images.save(png(10, 10))
    const first = s.send(ALICE, { text: '@Bob 看图', attachments: [att] })
    expect(first.mentions).toEqual(['a_bob'])
    const dm = s.send(BOB, { text: '', to: 'Alice', replyTo: first.id, attachments: [att] })
    expect(dm).toMatchObject({ to: 'a_alice', replyTo: first.id, text: '' })
    expect(dm.attachments).toHaveLength(1)
  })

  it('写进了文件：重新打开还在', () => {
    const s = store()
    const att = images.save(png(32, 16), 'p.png')
    s.send(ALICE, { text: '', attachments: [att] })
    s.dispose()
    const again = store()
    const got = again.read('a_bob').messages
    expect(got).toHaveLength(1)
    expect(got[0].attachments).toEqual([{ id: att.id, kind: 'image', name: 'p.png', mime: 'image/png', size: 40, width: 32, height: 16 }])
  })

  it('attachmentIds：收集所有频道里现存消息引用的图片，没打开过的频道也算', () => {
    const s = store()
    const a1 = images.save(png(8, 8, 1))
    const a2 = images.save(png(8, 8, 2))
    const a3 = images.save(png(8, 8, 3))
    expect(s.attachmentIds().size).toBe(0)
    s.send(ALICE, { text: '大厅', attachments: [a1] })
    s.send(ALICE, { text: '工作区', attachments: [a2, a1] }, 'ws:w1')
    s.send(ALICE, { text: '没图' }, 'ws:w2')
    expect([...s.attachmentIds()].sort()).toEqual([a1.id, a2.id].sort())
    s.dispose()
    // 新开一个，什么频道都没打开过：直接从文件里找
    const fresh = store()
    expect([...fresh.attachmentIds()].sort()).toEqual([a1.id, a2.id].sort())
    // 只打开其中一个频道，另一个还是从文件里找；新发的也算
    fresh.send(BOB, { text: '', attachments: [a3] })
    expect([...fresh.attachmentIds()].sort()).toEqual([a1.id, a2.id, a3.id].sort())
  })

  it('attachmentIds：目录还没有、文件里有坏行，都不出错', () => {
    expect(new ChatStore({ dir: path.join(base, 'nope'), members: () => members }).attachmentIds().size).toBe(0)
    const dir = path.join(base, 'chat')
    fs.mkdirSync(dir, { recursive: true })
    const id = 'att_' + 'a'.repeat(24)
    fs.writeFileSync(
      path.join(dir, 'ws_old.jsonl'),
      ['{"attachments": 坏的', JSON.stringify({ id: 'm1', attachments: [{ id }, { id: 5 }, null] }), JSON.stringify({ id: 'm2', attachments: 'x' }), ''].join('\n'),
      'utf8'
    )
    fs.writeFileSync(path.join(dir, 'cursors.json'), JSON.stringify({ attachments: [{ id: 'att_' + 'b'.repeat(24) }] }), 'utf8')
    expect([...store().attachmentIds()]).toEqual([id])
  })
})

describe('通知里的图片标记（chatNoticeLine）', () => {
  const att = (n: number): ChatAttachment[] => Array.from({ length: n }, (_, i) => ({ id: `att_${i}`, kind: 'image', name: 'x.png', mime: 'image/png', size: 1, width: 1, height: 1 }))

  it('带图片的消息在正文前标「[图片×N]」；只有图片时只有标记；没图片和原来一样', () => {
    expect(chatNoticeLine('[大厅]', '用户', { text: '看这个', channel: 'general', seq: 3, attachments: att(2) }, 500)).toContain('说：「[图片×2] 看这个」')
    expect(chatNoticeLine('[大厅]', '用户', { text: '', channel: 'general', seq: 3, attachments: att(1) }, 500)).toContain('说：「[图片×1]」')
    const plain = chatNoticeLine('[大厅]', '用户', { text: '看这个', channel: 'general', seq: 3 }, 500)
    expect(plain).toContain('说：「看这个」')
    expect(plain).not.toContain('图片')
    expect(chatNoticeLine('[大厅]', '用户', { text: '看这个', channel: 'general', seq: 3, attachments: [] }, 500)).toBe(plain)
  })

  it('正文里自己写「[图片×9]」伪造不了标记：方括号会被换掉', () => {
    const line = chatNoticeLine('[大厅]', '成员 Bob', { text: '[图片×9] 假的', channel: 'general', seq: 3 }, 500)
    expect(line).not.toContain('[图片×9]')
    expect(line).toContain('假的')
  })

  it('正文太长被截断时，标记还在最前面', () => {
    const line = chatNoticeLine('[大厅]', '用户', { text: '长'.repeat(50), channel: 'general', seq: 3, attachments: att(1) }, 10)
    expect(line).toContain(`说：「[图片×1] ${'长'.repeat(10)}…」`)
    expect(line).toContain('只带了前 10 字，全文 50 字')
  })
})

// ===== 经过 Bridge =====

let bridge: Bridge
let url: string
const clients: Client[] = []
interface Result {
  isError: boolean
  data: any
  notices: string
}

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 't26-test', version: '1.0.0' })
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

const newBridge = (): Bridge =>
  new Bridge({ dataDir: path.join(base, 'data'), workspaceRoot: path.join(base, 'ws'), port: 0, userSkillsDir: path.join(base, 'skills'), memberStatus: { timers: false } })
const wsId = (): string => bridge.getState().activeWorkspaceId as string
const wsChannel = (): string => `ws:${wsId()}`
const attDir = (): string => path.join(base, 'data', 'chat', 'attachments')
const attFiles = (): string[] => (fs.existsSync(attDir()) ? fs.readdirSync(attDir()).sort() : [])
/** 把图片文件的修改时间往前拨 */
const age = (id: string, ms: number): void => {
  const f = path.join(attDir(), `${id}.png`)
  const t = new Date(Date.now() - ms)
  fs.utimesSync(f, t, t)
}
const DAY = 24 * 60 * 60_000

describe('经过 Bridge：群聊图片', () => {
  let a: { agent: Agent; c: Client }

  beforeEach(async () => {
    fs.mkdirSync(path.join(base, 'ws'), { recursive: true })
    bridge = newBridge()
    await bridge.start()
    url = bridge.getState().mcpUrl
    const aa = bridge.createAgent('Alice')
    a = { agent: aa, c: await connect(aa.token) }
  })

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.stop()
  })

  it('图片存在 <数据目录>/chat/attachments；用户带图发消息，消息列表里带着附件', () => {
    const att = bridge.chatAttachments.save(png(300, 200), '界面.png')
    expect(attFiles()).toEqual([`${att.id}.png`])
    const m = bridge.sendChat({ text: '看界面', channel: wsChannel(), attachments: [att] })
    expect(m.attachments).toEqual([{ id: att.id, kind: 'image', name: '界面.png', mime: 'image/png', size: 40, width: 300, height: 200 }])
    const listed = bridge.listChat({ channel: wsChannel() }).find((x) => x.id === m.id)
    expect(listed?.attachments?.[0].id).toBe(att.id)
    // 只发图片不写字也行
    const only = bridge.sendChat({ text: '', channel: wsChannel(), attachments: [att] })
    expect(only.text).toBe('')
    expect(only.attachments).toHaveLength(1)
    // 不带图片的照旧
    expect('attachments' in bridge.sendChat({ text: '没图', channel: wsChannel() })).toBe(false)
  })

  it('用户带了没存过的图片：报错，消息没发出去', () => {
    const before = bridge.listChat({ channel: wsChannel() }).length
    const ghost = { id: 'att_' + 'f'.repeat(24), kind: 'image', name: 'x.png', mime: 'image/png', size: 1, width: 1, height: 1 } as ChatAttachment
    expect(() => bridge.sendChat({ text: '看', channel: wsChannel(), attachments: [ghost] })).toThrow(/不存在/)
    expect(() => bridge.sendChat({ text: '', channel: wsChannel() })).toThrow()
    expect(bridge.listChat({ channel: wsChannel() }).length).toBe(before)
  })

  it('AI 收到的通知里，正文前有「[图片×N]」；只有图片的消息也有通知', async () => {
    await call(a.c, 'whoami')
    const att = bridge.chatAttachments.save(png(300, 200))
    const att2 = bridge.chatAttachments.save(png(300, 200, 7))
    bridge.sendChat({ text: '看界面', channel: wsChannel(), attachments: [att, att2] })
    bridge.sendChat({ text: '', channel: wsChannel(), attachments: [att] })
    const r = await call(a.c, 'whoami')
    expect(r.notices).toContain('「[图片×2] 看界面」')
    expect(r.notices).toContain('「[图片×1]」')
  })

  it('AI 这条路（直接调 bridge.chat.send）也过图片存储核对；chat_read 读到的消息带附件', async () => {
    const att = bridge.chatAttachments.save(png(64, 64))
    const sender: ChatSender = { kind: 'agent', id: a.agent.id, name: a.agent.name }
    const m = bridge.chat.send(sender, { text: '', attachments: [{ id: att.id } as ChatAttachment] }, wsChannel())
    expect(m.attachments?.[0]).toMatchObject({ id: att.id, mime: 'image/png', width: 64, height: 64 })
    expect(codeOf(() => bridge.chat.send(sender, { text: 'x', attachments: [{ id: 'att_' + '1'.repeat(24) } as ChatAttachment] }, wsChannel()))).toBe('NOT_FOUND')
  })

  it('清理：没有消息引用、存了超过一天的图片删掉；有消息引用的、刚上传的留着', () => {
    const used = bridge.chatAttachments.save(png(8, 8, 1))
    const orphanOld = bridge.chatAttachments.save(png(8, 8, 2))
    const orphanNew = bridge.chatAttachments.save(png(8, 8, 3))
    bridge.sendChat({ text: '', channel: wsChannel(), attachments: [used] })
    age(used.id, 2 * DAY)
    age(orphanOld.id, 2 * DAY)
    age(orphanNew.id, DAY - 60_000)
    expect(bridge.cleanChatAttachments()).toBe(1)
    expect(attFiles()).toEqual([`${used.id}.png`, `${orphanNew.id}.png`].sort())
    expect(bridge.cleanChatAttachments()).toBe(0)
    // 再过一天，刚才那张没发出去的也清掉
    expect(bridge.cleanChatAttachments(Date.now() + DAY)).toBe(1)
    expect(attFiles()).toEqual([`${used.id}.png`])
  })

  it('启动时自动清一次；别的频道（这次还没打开过）里引用的图片不会被误删', async () => {
    const inWs = bridge.chatAttachments.save(png(8, 8, 1))
    const inLobby = bridge.chatAttachments.save(png(8, 8, 2))
    const orphan = bridge.chatAttachments.save(png(8, 8, 3))
    bridge.sendChat({ text: '', channel: wsChannel(), attachments: [inWs] })
    bridge.sendChat({ text: '大厅的', attachments: [inLobby] })
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.stop()
    for (const x of [inWs, inLobby, orphan]) age(x.id, 3 * DAY)
    expect(attFiles()).toHaveLength(3)
    bridge = newBridge()
    await bridge.start()
    expect(attFiles()).toEqual([`${inWs.id}.png`, `${inLobby.id}.png`].sort())
  })

  it('每天清一次的定时器：start 起，stop 停', async () => {
    const timer = (): unknown => (bridge as unknown as { attachmentGcTimer: unknown }).attachmentGcTimer
    expect(timer()).not.toBeNull()
    await bridge.stop()
    expect(timer()).toBeNull()
  })

  it('给 MCP 上下文的图片存储就是 bridge 上这一个', () => {
    const ctx = captured.ctxs.at(-1)!
    expect(ctx.chatAttachments).toBe(bridge.chatAttachments)
  })
})

describe('经过 Bridge：文件占用登记（T-16 在 bridge 这边的部分）', () => {
  let a: { agent: Agent; c: Client }
  let b: { agent: Agent; c: Client }
  const holder = (x: { agent: Agent }, session?: string): { agentId: string; agentName: string; session: string | null } => ({
    agentId: x.agent.id,
    agentName: x.agent.name,
    session: session ?? null
  })
  const sessionOf = (x: { agent: Agent }): string => bridge.listAgentSessions(x.agent.id)[0].id
  const claims = (): FileClaimStore => bridge.fileClaims() as FileClaimStore
  const held = (): string[] =>
    claims()
      .summary()
      .claims.map((c) => `${c.agentName}:${c.task ?? '-'}:${c.paths.join(',')}`)
      .sort()

  beforeEach(async () => {
    fs.mkdirSync(path.join(base, 'ws'), { recursive: true })
    bridge = newBridge()
    await bridge.start()
    url = bridge.getState().mcpUrl
    const aa = bridge.createAgent('Alice')
    const bb = bridge.createAgent('Bob')
    a = { agent: aa, c: await connect(aa.token) }
    b = { agent: bb, c: await connect(bb.token) }
  })

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.stop()
  })

  it('每个工作区一个登记，重复取是同一个；存在工作区的数据目录里；不存在的工作区返回 null', () => {
    const s = claims()
    expect(s).not.toBeNull()
    expect(bridge.fileClaims(wsId())).toBe(s)
    expect(bridge.fileClaims('w_nope')).toBeNull()
    s.claim(holder(a), ['src/a.ts'], { task: 'T-1' })
    const found: string[] = []
    const walk = (d: string): void => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        if (f.isDirectory()) walk(path.join(d, f.name))
        else if (f.name === 'file-claims.json') found.push(path.join(d, f.name))
      }
    }
    walk(path.join(base, 'data'))
    expect(found).toHaveLength(1)
    expect(path.dirname(found[0])).toBe(path.dirname(path.join(path.dirname(found[0]), 'tasks.json')))
    expect(fs.existsSync(path.join(path.dirname(found[0]), 'workspace.txt'))).toBe(true)
    // 工作区运行时上也挂着同一个（接线时可以直接用 ws.claims）
    const rt = (bridge as unknown as { openWorkspace: (id: string) => { claims: FileClaimStore } }).openWorkspace(wsId())
    expect(rt.claims).toBe(s)
  })

  it('会话断开：这个会话的登记放掉，别的会话的、不带会话的留着', async () => {
    claims().claim(holder(a, sessionOf(a)), ['src/a.ts'])
    claims().touch(holder(a, sessionOf(a)), ['src/auto.ts'])
    claims().claim(holder(b, sessionOf(b)), ['src/b.ts'])
    // 同一个人同一个任务的主动登记会合并，所以这条不带会话的挂在另一个任务名下
    claims().claim(holder(a), ['docs/**'], { task: 'T-9' })
    expect(held()).toHaveLength(4)
    await bridge.disconnectAgent(a.agent.id)
    expect(held()).toEqual(['Alice:T-9:docs/**', 'Bob:-:src/b.ts'])
    // 重新连上是新会话，原来放掉的不会回来
    a.c = await connect(a.agent.token)
    expect(held()).toEqual(['Alice:T-9:docs/**', 'Bob:-:src/b.ts'])
  })

  it('任务完成：挂在这个任务名下的登记放掉（编号不分大小写，写任务 id 也认）；别的任务的留着', async () => {
    const t1 = await call(a.c, 'task_create', { title: '一' })
    const t2 = await call(a.c, 'task_create', { title: '二' })
    await call(b.c, 'task_claim', { task: t1.data.id })
    await call(b.c, 'task_claim', { task: t2.data.id })
    claims().claim(holder(b), ['src/one.ts'], { task: t1.data.ref })
    claims().claim(holder(a), ['src/one-lower.ts'], { task: String(t1.data.ref).toLowerCase() })
    claims().claim(holder(b), ['src/one-id.ts'], { task: t1.data.id })
    claims().claim(holder(b), ['src/two.ts'], { task: t2.data.ref })
    claims().claim(holder(b), ['src/free.ts'])
    expect(held()).toHaveLength(5)
    // 交审还不算完成
    await call(b.c, 'task_update', { task: t1.data.id, status: 'review', result: '好了' })
    expect(held()).toHaveLength(5)
    bridge.reviewTask(t1.data.id, 'accept')
    expect(held()).toEqual([`Bob:${t2.data.ref}:src/two.ts`, 'Bob:-:src/free.ts'].sort())
  })

  it('任务删掉：它名下的登记也放掉', async () => {
    const t = bridge.createTask({ title: '要删的', assigneeId: b.agent.id })
    const keep = bridge.createTask({ title: '留着的', assigneeId: b.agent.id })
    claims().claim(holder(b), ['src/x.ts'], { task: t.ref })
    claims().claim(holder(b), ['src/y.ts'], { task: keep.ref })
    bridge.deleteTask(t.id)
    expect(held()).toEqual([`Bob:${keep.ref}:src/y.ts`])
  })

  it('登记时写了个任务板上没有的编号：别的任务有变动时不动它', async () => {
    const t = bridge.createTask({ title: '真的', assigneeId: b.agent.id })
    claims().claim(holder(b), ['src/x.ts'], { task: 'T-999' })
    claims().claim(holder(b), ['src/y.ts'], { task: t.ref })
    bridge.setTaskStatus(t.id, 'done')
    expect(held()).toEqual(['Bob:T-999:src/x.ts'])
    // 早就完成的任务后来又有改动（比如加备注），不会再去放一次别人后来登记的
    claims().claim(holder(a), ['src/z.ts'], { task: t.ref })
    bridge.createTask({ title: '又来一个' })
    expect(held()).toEqual(['Alice:' + t.ref + ':src/z.ts', 'Bob:T-999:src/x.ts'].sort())
  })

  it('任务板有了工作区范围（T-22 要的 scope）：能设置 allowedPaths', () => {
    const rt = (bridge as unknown as { openWorkspace: (id: string) => { tasks: { create: (actor: unknown, input: unknown) => { allowedPaths?: string[] } } } }).openWorkspace(wsId())
    const t = rt.tasks.create({ id: 'user', name: '你', kind: 'user' }, { title: '限范围', allowedPaths: ['src/**'] })
    expect(t.allowedPaths).toEqual(['src/**'])
  })

  it('MCP 上下文里运行时给的几样：fileClaims、sessionId、pushNotice', async () => {
    // 每个连接建一次服务端：找到 Alice 和 Bob 各自的上下文
    const ctxOf = (x: { agent: Agent }): Record<string, any> => captured.ctxs.find((c) => (c.getAgent as () => Agent | undefined)()?.id === x.agent.id) as Record<string, any>
    const ca = ctxOf(a)
    const cb = ctxOf(b)
    expect(ca.fileClaims(wsId())).toBe(claims())
    expect(ca.fileClaims('w_nope')).toBeNull()
    // 会话 id 握手完成后才有，和会话列表里的一致，各连接各是各的
    expect(ca.sessionId()).toBe(sessionOf(a))
    expect(cb.sessionId()).toBe(sessionOf(b))
    expect(ca.sessionId()).not.toBe(cb.sessionId())
    // pushNotice：进对方的【通知】队列，下次调用工具带回去
    await call(b.c, 'whoami')
    ca.pushNotice(b.agent.id, 'Alice 写了你登记的 src/b.ts', wsId())
    const r = await call(b.c, 'whoami')
    expect(r.notices).toContain('Alice 写了你登记的 src/b.ts')
    expect((await call(a.c, 'whoami')).notices).toBe('')
  })

  it('内置 AI 那种不经过握手建的服务端：sessionId 是 undefined，不报错', () => {
    bridge.createAgentServer(a.agent.id)
    const ctx = captured.ctxs.at(-1) as Record<string, any>
    expect(ctx.sessionId()).toBeUndefined()
    expect(ctx.fileClaims(wsId())).toBe(claims())
  })
})
