// 第 2 批公共接线 Part 1（T-11：T-9 / T-10 公共接线 + task_update 原子性）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Bridge } from '../src/core/bridge'
import type { Agent } from '../src/core/types'

let base: string
let root: string
let dataDir: string
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
  const c = new Client({ name: 'batch2-p1-test', version: '1.0.0' })
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
    // 非 JSON 文本工具
  }
  return { isError: Boolean(r.isError), data, blocks }
}

const code = (r: Result): string => (r.isError ? (typeof r.data === 'object' ? r.data.error : 'NON_JSON_ERROR') : 'OK')

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-b2p1-'))
  root = path.join(base, 'ws')
  dataDir = path.join(base, 'data')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'a.txt'), 'alpha\nbeta\ngamma\n')
  bridge = new Bridge({ dataDir, workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'user-skills') })
  await bridge.start()
  url = bridge.getState().mcpUrl
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  await bridge.stop()
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

describe('T-9 接线：read_file raw=true、SDK 报错统一 JSON、run_command 说明', () => {
  it('read_file raw=true 返回 JSON 并完整保留 CRLF/末尾换行与 BOM encoding；不传仍走旧纯文本；冲突参数或超长单行报错', async () => {
    const a = await join('Alice')
    fs.writeFileSync(path.join(root, 'crlf-bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\n', 'utf8')]))
    fs.writeFileSync(path.join(root, 'huge.txt'), 'x'.repeat(270 * 1024), 'utf8')

    // 默认仍返回旧纯文本格式
    const plain = await call(a.c, 'read_file', { path: 'crlf-bom.txt' })
    expect(code(plain)).toBe('OK')
    expect(typeof plain.data).toBe('string')
    expect(plain.blocks[0]).toContain('\n---\none\ntwo')

    // raw=true 返回 JSON 且保留真实 CRLF 与末尾换行、utf8-bom
    const raw = await call(a.c, 'read_file', { path: 'crlf-bom.txt', raw: true })
    expect(code(raw)).toBe('OK')
    expect(raw.data).toMatchObject({
      path: 'crlf-bom.txt',
      encoding: 'utf8-bom',
      eol: 'CRLF',
      totalLines: 2,
      startLine: 1,
      endLine: 2,
      hasMore: false,
      content: 'one\r\ntwo\r\n'
    })
    expect(typeof raw.data.version).toBe('string')

    // raw + line_numbers 互斥报 INVALID_ARGS
    expect(code(await call(a.c, 'read_file', { path: 'crlf-bom.txt', raw: true, line_numbers: true }))).toBe('INVALID_ARGS')

    // 单行超过 256 KB 时 raw=true 报 TOO_LARGE
    expect(code(await call(a.c, 'read_file', { path: 'huge.txt', raw: true }))).toBe('TOO_LARGE')

    // schema 里可见 raw 参数与说明
    const tools = (await a.c.listTools()).tools
    const rfTool = tools.find((x) => x.name === 'read_file')!
    expect(rfTool.description).toContain('raw=true')
    expect((rfTool.inputSchema.properties as Record<string, unknown>).raw).toBeDefined()
  })

  it('SDK 缺参/类型错/未知工具统一返回 JSON { error, message }；业务报错不双重包裹且保留后续提示块；协议层错误不吞掉', async () => {
    const a = await join('Alice')
    const b = await join('Bob')

    // 1. 缺参 -> INVALID_ARGS JSON
    const missingArg = await call(a.c, 'read_file', {})
    expect(missingArg.isError).toBe(true)
    expect(code(missingArg)).toBe('INVALID_ARGS')
    expect(missingArg.data.message).toContain('Input validation error')

    // 2. 类型错 -> INVALID_ARGS JSON
    const badType = await call(a.c, 'read_file', { path: 123 })
    expect(badType.isError).toBe(true)
    expect(code(badType)).toBe('INVALID_ARGS')
    expect(badType.data.message).toContain('Input validation error')

    // 3. 未知工具 -> TOOL_ERROR JSON
    const unknownTool = await call(a.c, 'no_such_tool', {})
    expect(unknownTool.isError).toBe(true)
    expect(code(unknownTool)).toBe('TOOL_ERROR')
    expect(unknownTool.data.message).toContain('not found')

    // 4. 业务报错（NOT_FOUND）+ 未识别参数 + 待读通知：不双重包裹，后续提示/通知块保持完整
    await call(a.c, 'chat_send', { text: '@Bob 看下报错' })
    const bizErr = await call(b.c, 'read_file', { path: 'nope.txt', bogus_flag: true })
    expect(bizErr.isError).toBe(true)
    expect(code(bizErr)).toBe('NOT_FOUND')
    expect(typeof bizErr.data.message).toBe('string')
    expect(bizErr.data.message).not.toContain('"error"')
    expect(bizErr.blocks).toHaveLength(3)
    expect(bizErr.blocks[1]).toContain('【参数提示】')
    expect(bizErr.blocks[1]).toContain('bogus_flag')
    expect(bizErr.blocks[2]).toContain('【通知】')

    // 5. 协议层错误（未注册的 JSON-RPC 方法）不被吞掉，客户端正常收到协议异常
    await expect(b.c.request({ method: 'custom/doesNotExist' }, z.record(z.string(), z.unknown()))).rejects.toThrow()
  })

  it('run_command 说明写清 timeout_ms 只是等待上限且不杀进程，以及 bash +H 与引号/转义规则', async () => {
    const a = await join('Alice')
    const runTool = (await a.c.listTools()).tools.find((x) => x.name === 'run_command')!
    expect(runTool.description).toContain('+H')
    expect(runTool.description).toContain('超时不会杀进程')
    expect(runTool.description).toContain('单引号')
    const timeoutDesc = String((runTool.inputSchema.properties as Record<string, { description?: string }>).timeout_ms?.description ?? '')
    expect(timeoutDesc).toContain('等待上限')
    expect(timeoutDesc).toContain('不会杀进程')
  })
})

describe('T-10 接线：memory_search / memory_read / memory_save / memory_delete 版本与乐观并发', () => {
  it('创建和读取返回 version；带对的 expected_version 递增；过期版本 CONFLICT 带回 data.current；兼容老数据与不传版本号覆盖', async () => {
    const a = await join('Alice')
    const b = await join('Bob')

    const created = await call(a.c, 'memory_save', { title: '部署约定', content: 'v1 内容', tags: ['ops'] })
    expect(code(created)).toBe('OK')
    expect(created.data.version).toBe(1)
    const id: string = created.data.id

    const read1 = await call(b.c, 'memory_read', { id })
    expect(read1.data.version).toBe(1)
    const searched = await call(b.c, 'memory_search', { query: '部署约定' })
    expect(searched.data[0].version).toBe(1)

    // Bob 用 expected_version=1 更新成功 -> 变成 version=2
    const up = await call(b.c, 'memory_save', {
      id,
      title: '部署约定',
      content: 'v2 Bob改的',
      expected_version: 1
    })
    expect(code(up)).toBe('OK')
    expect(up.data.version).toBe(2)

    // Alice 拿着旧 version=1 再更新 -> CONFLICT 并带回 data.current
    const conflictSave = await call(a.c, 'memory_save', {
      id,
      title: '部署约定',
      content: 'v2 Alice覆盖',
      expected_version: 1
    })
    expect(code(conflictSave)).toBe('CONFLICT')
    expect(conflictSave.data.current).toMatchObject({
      id,
      version: 2,
      content: 'v2 Bob改的',
      updatedByName: 'Bob'
    })
    // 没被覆盖
    expect((await call(a.c, 'memory_read', { id })).data.content).toBe('v2 Bob改的')

    // Alice 拿着旧 version=1 删除 -> CONFLICT 并带回 data.current
    const conflictDel = await call(a.c, 'memory_delete', { id, expected_version: 1 })
    expect(code(conflictDel)).toBe('CONFLICT')
    expect(conflictDel.data.current.version).toBe(2)

    // Alice 合并后带 expected_version=2 删除成功
    expect(code(await call(a.c, 'memory_delete', { id, expected_version: 2 }))).toBe('OK')

    // 新建带 expected_version 报 INVALID_ARGS；非法 expected_version 也报 INVALID_ARGS
    expect(code(await call(a.c, 'memory_save', { title: 'X', content: 'Y', expected_version: 1 }))).toBe('INVALID_ARGS')
    expect(code(await call(a.c, 'memory_save', { id: 'm_1', title: 'X', content: 'Y', expected_version: 0 }))).toBe('INVALID_ARGS')

    // 老数据没有 version 字段时，memory_read / search 补出 version=1，expected_version=1 可正常更新，不传仍可直接覆盖
    const legacy = await call(a.c, 'memory_save', { title: '老记录', content: '旧' })
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.stop()
    const memRel = fs.readdirSync(dataDir, { recursive: true }).map(String).find((f) => f.endsWith('memory.json'))!
    const memFile = path.join(dataDir, memRel)
    const rawJson = JSON.parse(fs.readFileSync(memFile, 'utf8'))
    delete rawJson.items.find((x: { id: string }) => x.id === legacy.data.id).version
    fs.writeFileSync(memFile, JSON.stringify(rawJson, null, 2))

    bridge = new Bridge({ dataDir, workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'user-skills') })
    await bridge.start()
    url = bridge.getState().mcpUrl
    const a2 = await connect(a.agent.token)
    expect((await call(a2, 'memory_read', { id: legacy.data.id })).data.version).toBe(1)
    expect((await call(a2, 'memory_search', { query: '老记录' })).data[0].version).toBe(1)
    const legacyUp = await call(a2, 'memory_save', { id: legacy.data.id, title: '老记录', content: '新内容', expected_version: 1 })
    expect(code(legacyUp)).toBe('OK')
    expect(legacyUp.data.version).toBe(2)
    // 不传 expected_version 依然兼容直接覆盖
    const noVer = await call(a2, 'memory_save', { id: legacy.data.id, title: '老记录', content: '不带版本覆盖' })
    expect(code(noVer)).toBe('OK')
    expect(noVer.data.version).toBe(3)
  })
})

describe('task_update 原子性（edit + status/result）', () => {
  it('同一次 task_update 里改 title 但提交 review 缺 result 时整体报错回滚，不改 title 也不记历史；成功时用新标题发通知', async () => {
    const boss = await join('Boss')
    const reviewer = await join('Reviewer')

    // Boss 建任务并让 Reviewer 转派回来（模拟有审查人的任务：Reviewer 建并派给 Boss）
    const created = await call(reviewer.c, 'task_create', { title: '原标题', description: '原说明', assigneeId: 'Boss' })
    const ref: string = created.data.ref

    // 1. 派活人 Reviewer 改 title 同时传 status=review 但不传 result -> 报 INVALID_ARGS，原标题和历史保持不变
    const badReview = await call(reviewer.c, 'task_update', { task: ref, title: '改一半的标题', status: 'review' })
    expect(code(badReview)).toBe('INVALID_ARGS')
    const afterBadReview = (await call(reviewer.c, 'task_get', { task: ref })).data
    expect(afterBadReview.title).toBe('原标题')
    expect(afterBadReview.status).toBe('todo')
    expect(afterBadReview.history).toHaveLength(1)

    // 2. 执行者 Boss 改 priority 同时直接传 status=done -> 报 REVIEW_REQUIRED，priority 和历史保持不变
    const badDone = await call(boss.c, 'task_update', { task: ref, priority: 'high', status: 'done', result: '直接完成' })
    expect(code(badDone)).toBe('REVIEW_REQUIRED')
    const afterBadDone = (await call(reviewer.c, 'task_get', { task: ref })).data
    expect(afterBadDone.priority).toBe('normal')
    expect(afterBadDone.status).toBe('todo')
    expect(afterBadDone.history).toHaveLength(1)

    // 3. Reviewer 同时改 title 和 status=review + result（同一人创建并派活后由他自己测试 edit+update 提交给创建人/审查人；再建一个 Boss 建并提交给用户或 Boss 改+update）
    const selfCreated = await call(boss.c, 'task_create', { title: '旧标题2', assigneeId: 'Reviewer' })
    const ref2: string = selfCreated.data.ref
    // Reviewer 把任务还给 Boss 审查？不对：selfCreated.managedBy = Boss，所以 Reviewer 只能改 priority。换 Boss 改 title + status=in_progress + note
    const okCombo = await call(boss.c, 'task_update', {
      task: ref2,
      title: '新标题2',
      priority: 'high',
      status: 'in_progress',
      note: '先改名再开工'
    })
    expect(code(okCombo)).toBe('OK')
    expect(okCombo.data).toMatchObject({ title: '新标题2', priority: 'high', status: 'in_progress' })
    expect(okCombo.data.history.slice(-2).map((h: string) => h)).toEqual([
      expect.stringContaining('edited'),
      expect.stringContaining('status → in_progress')
    ])

    // 4. Reviewer（执行者）改 priority + 提交 review：校验成功同时改 priority 并用新状态通知 Boss
    const okReview = await call(reviewer.c, 'task_update', {
      task: ref2,
      priority: 'low',
      status: 'review',
      result: '全部完成'
    })
    expect(code(okReview)).toBe('OK')
    expect(okReview.data).toMatchObject({ priority: 'low', status: 'review', result: '全部完成' })
    const bossNotice = (await call(boss.c, 'whoami')).blocks.find((t) => t.startsWith('【通知】')) ?? ''
    expect(bossNotice).toContain('新标题2')
  })
})
