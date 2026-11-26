// 第 1 批公共接线与参数规范测试（优化 #13、T-3、T-4）
// 真实 Bridge + 真实 MCP 客户端
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import type { Agent } from '../src/core/types'

let base: string
let root: string
let bridge: Bridge
let url: string
const clients: Client[] = []

interface Result {
  isError: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  blocks: string[]
}

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 'batch1-test', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  clients.push(c)
  return c
}

async function join(name: string): Promise<{ agent: Agent; c: Client }> {
  const agent = bridge.createAgent(name)
  return { agent, c: await connect(agent.token) }
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const r = await c.callTool({ name, arguments: args })
  const blocks = (r.content as { type: string; text: string }[]).map((p) => p.text)
  let data: unknown = blocks[0]
  try {
    data = JSON.parse(blocks[0])
  } catch {
    // 纯文本工具
  }
  return { isError: Boolean(r.isError), data, blocks }
}

const code = (r: Result): string => (r.isError ? (typeof r.data === 'object' ? r.data.error : 'SDK_ERROR') : 'OK')

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-b1-'))
  root = path.join(base, 'ws')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'a.txt'), 'alpha\nbeta\ngamma\n')
  bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'user-skills') })
  await bridge.start()
  url = bridge.getState().mcpUrl
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  await bridge.stop()
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

describe('优化 #13：任务 tools 的 task / id 别名与未识别参数提示', () => {
  it('task_get / task_claim / task_update / task_review / task_assign / task_delete 都认 id 别名，冲突或全空报 INVALID_ARGS', async () => {
    const boss = await join('Boss')
    const dev = await join('Dev')

    const created = await call(boss.c, 'task_create', { title: '任务一', description: '初始说明' })
    expect(code(created)).toBe('OK')
    const ref: string = created.data.ref
    const id: string = created.data.id

    // id 查、同值双传OK、异值双传报错、全空报错
    expect((await call(boss.c, 'task_get', { id })).data.ref).toBe(ref)
    expect((await call(boss.c, 'task_get', { task: ref, id: ref })).data.id).toBe(id)
    expect(code(await call(boss.c, 'task_get', { task: ref, id: 'T-999' }))).toBe('INVALID_ARGS')
    expect(code(await call(boss.c, 'task_get', {}))).toBe('INVALID_ARGS')

    // assign / claim / update / review / delete 全走 id
    expect(code(await call(boss.c, 'task_assign', { id: ref, assigneeId: 'Dev' }))).toBe('OK')
    expect(code(await call(dev.c, 'task_claim', { id: ref }))).toBe('OK')
    expect(code(await call(dev.c, 'task_update', { id: ref, status: 'review', result: '完成' }))).toBe('OK')
    expect(code(await call(boss.c, 'task_review', { id: ref, decision: 'accept', note: '通过' }))).toBe('OK')
    expect((await call(boss.c, 'task_get', { id: ref })).data.status).toBe('done')

    const del = await call(boss.c, 'task_delete', { id: ref })
    expect(code(del)).toBe('OK')
    expect(del.data.deleted).toBe(ref)
  })

  it('传了不认识的参数时提示但不拒绝，且不污染 JSON / read_file 正文，【通知】仍在最后一块', async () => {
    const a = await join('Alice')
    const b = await join('Bob')

    const w = await call(a.c, 'whoami', { legacy_flag: true })
    expect(code(w)).toBe('OK')
    expect(() => JSON.parse(w.blocks[0])).not.toThrow()
    expect(w.data.agent).toBe('Alice')
    expect(w.blocks).toHaveLength(2)
    expect(w.blocks[1]).toContain('【参数提示】')
    expect(w.blocks[1]).toContain('legacy_flag')

    // read_file 正文不被污染
    const rf = await call(a.c, 'read_file', { path: 'a.txt', lineNumbers: true })
    expect(code(rf)).toBe('OK')
    expect(rf.blocks[0]).not.toContain('【参数提示】')
    expect(rf.blocks[1]).toContain('lineNumbers')

    // 有待读通知时：【参数提示】在通知前面，【通知】仍是最后一块
    await call(a.c, 'chat_send', { text: '@Bob 你好' })
    const bRes = await call(b.c, 'chat_channels', { unknown_opt: 42 })
    expect(code(bRes)).toBe('OK')
    expect(() => JSON.parse(bRes.blocks[0])).not.toThrow()
    expect(bRes.blocks).toHaveLength(3)
    expect(bRes.blocks[1]).toContain('unknown_opt')
    expect(bRes.blocks[2].startsWith('【通知】')).toBe(true)

    // 报错时也会带上未识别参数提示；已知参数类型错误也被统一包成 JSON INVALID_ARGS
    const badKey = await call(a.c, 'task_get', { task_id: 'T-1' })
    expect(code(badKey)).toBe('INVALID_ARGS')
    expect(badKey.blocks[1]).toContain('task_id')
    expect(code(await call(a.c, 'read_file', { path: 123 }))).toBe('INVALID_ARGS')
  })
})

describe('T-3 接线：task_update 支持改 title / description / priority', () => {
  it('创建者可只改标题说明而不额外记 updated；执行者改标题报 FORBIDDEN 且不推进状态，但能改优先级', async () => {
    const boss = await join('Boss')
    const dev = await join('Dev')
    const t = (await call(boss.c, 'task_create', { title: '旧题', description: '旧述', assigneeId: 'Dev' })).data

    const edited = await call(boss.c, 'task_update', { task: t.ref, title: '新题', description: '新述', priority: 'high' })
    expect(code(edited)).toBe('OK')
    expect(edited.data).toMatchObject({ title: '新题', description: '新述', priority: 'high' })
    expect(edited.data.history.at(-1)).toContain('edited')
    expect(edited.data.history.at(-1)).toContain('旧题')
    expect(edited.data.history.at(-1)).toContain('新题')

    // 执行者改 title 同时传 status=review：整体 FORBIDDEN，状态仍为 todo
    const forbid = await call(dev.c, 'task_update', { id: t.ref, title: '擅改', status: 'review', result: 'ok' })
    expect(code(forbid)).toBe('FORBIDDEN')
    expect((await call(boss.c, 'task_get', { task: t.ref })).data.status).toBe('todo')

    // 执行者只改 priority 可以
    const prio = await call(dev.c, 'task_update', { id: t.ref, priority: 'low' })
    expect(code(prio)).toBe('OK')
    expect(prio.data.priority).toBe('low')
  })
})

describe('T-4 接线：read_file line_numbers 与 write_file 说明', () => {
  it('read_file 默认无行号，line_numbers=true 从真实 offset 开始带行号；write_file 说明提了 apply_patch', async () => {
    const a = await join('Alice')
    const def = await call(a.c, 'read_file', { path: 'a.txt', offset: 2, limit: 2 })
    expect(code(def)).toBe('OK')
    expect(def.blocks[0].split('---\n')[1]).toBe('beta\ngamma')

    const num = await call(a.c, 'read_file', { path: 'a.txt', offset: 2, limit: 2, line_numbers: true })
    expect(code(num)).toBe('OK')
    expect(num.blocks[0].split('---\n')[1]).toBe('2\tbeta\n3\tgamma')

    const tools = (await a.c.listTools()).tools
    expect(tools.find((x) => x.name === 'write_file')?.description).toContain('apply_patch')
    expect(tools.find((x) => x.name === 'read_file')?.description).toContain('line_numbers')
  })
})
describe('T-2 接线：chat_send reply_to 序号、@全体、代码转义跳过与通知正文', () => {
  it('chat_send reply_to 同时收数字/字符串/#N 序号和消息 id，且 inputSchema 保持纯 string；代码/@全体/通知全文生效', async () => {
    const a = await join('Alice')
    const b = await join('Bob')

    // inputSchema 不带 anyOf，且说明含 @全体 和 \@
    const tools = (await a.c.listTools()).tools
    const sendTool = tools.find((x) => x.name === 'chat_send')!
    expect(sendTool.description).toContain('@全体')
    expect(sendTool.description).toContain('\\@')
    const replySchema = (sendTool.inputSchema.properties as Record<string, Record<string, unknown>>).reply_to
    expect(replySchema.type).toBe('string')
    expect(replySchema.anyOf).toBeUndefined()
    expect(a.c.getInstructions()).toContain('@全体')

    // 代码块、反引号和 \@ 不提醒；@全体 提醒所有人
    const m1 = await call(a.c, 'chat_send', { text: '举例 `\\@Bob` 和 `@Bob`\n```\n@Bob\n```\n\\@Bob 请忽略' })
    expect(code(m1)).toBe('OK')
    expect(m1.data.mentions).toEqual([])
    const bAfterCode = await call(b.c, 'whoami')
    const bCodeNotice = bAfterCode.blocks.find((t) => t.startsWith('【通知】')) ?? ''
    expect(bCodeNotice).not.toContain('[群聊·')
    expect(bCodeNotice).toContain('有 1 条未读')

    // @全体 带长文（>300 但 <2000，属于 @所有人 短版 300；点名给 @Bob 带全文 >300）
    const longBody = '@Bob ' + '乙'.repeat(450)
    const m2 = await call(a.c, 'chat_send', { text: longBody })
    expect(code(m2)).toBe('OK')
    const bNotified = await call(b.c, 'whoami')
    const noticeBlock = bNotified.blocks.find((t) => t.startsWith('【通知】')) ?? ''
    expect(noticeBlock).toContain('乙'.repeat(450))
    expect(noticeBlock).toContain('以上是全文')

    // 数字序号 / 字符串序号 / #序号 都能 reply_to，最终存 id
    const rNum = await call(b.c, 'chat_send', { text: '@全体 收到', reply_to: m1.data.seq })
    expect(code(rNum)).toBe('OK')
    expect(rNum.data.mentions).toContain('*')
    const rHash = await call(b.c, 'chat_send', { text: '再补一句', reply_to: `#${m2.data.seq}` })
    expect(code(rHash)).toBe('OK')
    const readBack = await call(a.c, 'chat_read', { channel: m1.data.channel })
    const msgs = readBack.data.messages as { seq: number; reply_to?: string }[]
    expect(msgs.find((x) => x.seq === rNum.data.seq)?.reply_to).toBe(m1.data.id)
    expect(msgs.find((x) => x.seq === rHash.data.seq)?.reply_to).toBe(m2.data.id)

    // 不存在的序号报 NOT_FOUND；非正整数报校验错（统一包成 JSON INVALID_ARGS）
    expect(code(await call(a.c, 'chat_send', { text: 'x', reply_to: 9999 }))).toBe('NOT_FOUND')
    expect(code(await call(a.c, 'chat_send', { text: 'x', reply_to: 0 }))).toBe('INVALID_ARGS')
    expect(code(await call(a.c, 'chat_send', { text: 'x', reply_to: 1.5 }))).toBe('INVALID_ARGS')
  })
})
