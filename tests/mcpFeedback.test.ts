// 网页 AI 实测反馈后的改动：等待恢复、只退一步、删任务、回收站工具、会话被关时说明原因、命令默认等 30 秒。
// 真实 Bridge + 真实 MCP 客户端
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from '../src/core/commandRunner'
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
  /** 结果里的全部文本块 */
  blocks: string[]
}

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 'feedback-test', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  clients.push(c)
  return c
}

async function join(name: string, machine = false): Promise<{ agent: Agent; c: Client }> {
  const agent = bridge.createAgent(name, undefined, machine)
  return { agent, c: await connect(agent.token) }
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const r = await c.callTool({ name, arguments: args })
  const blocks = (r.content as { type: string; text: string }[]).map((p) => p.text)
  let data: unknown = blocks[0]
  try {
    data = JSON.parse(blocks[0])
  } catch {
    // 纯文本结果
  }
  return { isError: Boolean(r.isError), data, blocks }
}

const code = (r: Result): string => (r.isError ? (typeof r.data === 'object' ? r.data.error : 'SDK_ERROR') : 'OK')
const text = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')
const exists = (rel: string): boolean => fs.existsSync(path.join(root, rel))
const sid = (c: Client): string => (c as unknown as { _transport: StreamableHTTPClientTransport })._transport.sessionId!
const trashDir = (): string => path.join(dataDir, 'trash')

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-fb-'))
  root = path.join(base, 'ws')
  dataDir = path.join(base, 'data')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'a.txt'), 'a0\n')
  fs.writeFileSync(path.join(root, 'b.txt'), 'b0\n')
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const a = 1\n')
  bridge = new Bridge({ dataDir, workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'user-skills') })
  await bridge.start()
  url = bridge.getState().mcpUrl
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  await bridge.stop()
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

describe('「全部停下」期间等恢复', () => {
  it('没暂停时 wait_for_resume 立即返回；暂停时别的工具返回 PAUSED 并指向它；恢复后它马上返回', async () => {
    const a = await join('Alice')
    const idle = await call(a.c, 'wait_for_resume')
    expect(code(idle)).toBe('OK')
    expect(idle.data).toMatchObject({ paused: false })

    bridge.setPaused(true)
    const blocked = await call(a.c, 'list_dir')
    expect(code(blocked)).toBe('PAUSED')
    expect(blocked.data.message).toContain('wait_for_resume')

    const started = Date.now()
    const waiting = call(a.c, 'wait_for_resume', { timeout_ms: 20_000 })
    setTimeout(() => bridge.setPaused(false), 400)
    const r = await waiting
    expect(code(r)).toBe('OK')
    expect(r.data.paused).toBe(false)
    expect(r.data.waited_ms).toBeGreaterThanOrEqual(300)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(code(await call(a.c, 'list_dir'))).toBe('OK')
  })

  it('到时间还没恢复：返回 paused=true、timed_out，不算错误', async () => {
    const a = await join('Alice')
    bridge.setPaused(true)
    const r = await call(a.c, 'wait_for_resume', { timeout_ms: 300 })
    expect(code(r)).toBe('OK')
    expect(r.data).toMatchObject({ paused: true, timed_out: true })
    expect(r.data.waited_ms).toBeGreaterThanOrEqual(250)
  })
})

describe('只退单独一步', () => {
  it('only_step=true 只退那一个检查点，后面的改动留着；不加时连带后面的一起退', async () => {
    const a = await join('Alice')
    expect(code(await call(a.c, 'write_file', { path: 'a.txt', content: 'a1\n', overwrite: true }))).toBe('OK')
    expect(code(await call(a.c, 'write_file', { path: 'b.txt', content: 'b1\n', overwrite: true }))).toBe('OK')
    expect(code(await call(a.c, 'write_file', { path: 'c.txt', content: 'c1\n' }))).toBe('OK')
    const steps = (await call(a.c, 'checkpoint_list')).data.sessions[0].checkpoints as { id: string; tool: string }[]
    // 最近的在前：c、b、a
    expect(steps).toHaveLength(3)
    const [, stepB, stepA] = steps

    const dry = await call(a.c, 'checkpoint_rollback', { step: stepB.id, only_step: true, dry_run: true })
    expect(code(dry)).toBe('OK')
    expect(dry.data.files.map((f: { path: string }) => f.path)).toEqual(['b.txt'])

    expect(code(await call(a.c, 'checkpoint_rollback', { step: stepB.id, only_step: true }))).toBe('OK')
    expect(text('b.txt')).toBe('b0\n')
    expect(text('a.txt')).toBe('a1\n')
    expect(text('c.txt')).toBe('c1\n')

    // 不加 only_step：从 a 那一步起，后面的 c 也退掉
    expect(code(await call(a.c, 'checkpoint_rollback', { step: stepA.id }))).toBe('OK')
    expect(text('a.txt')).toBe('a0\n')
    expect(exists('c.txt')).toBe(false)
  })

  it('后面的步骤又改过同一个文件：CONFLICT（touched_later），一个都不写；only_step 不带 step 是 INVALID_ARGS', async () => {
    const a = await join('Alice')
    expect(code(await call(a.c, 'write_file', { path: 'a.txt', content: 'a1\n', overwrite: true }))).toBe('OK')
    expect(code(await call(a.c, 'write_file', { path: 'a.txt', content: 'a2\n', overwrite: true }))).toBe('OK')
    const steps = (await call(a.c, 'checkpoint_list')).data.sessions[0].checkpoints as { id: string }[]
    const first = steps[steps.length - 1]

    const r = await call(a.c, 'checkpoint_rollback', { step: first.id, only_step: true })
    expect(code(r)).toBe('CONFLICT')
    expect(r.data.conflicts).toEqual([expect.objectContaining({ path: 'a.txt', reason: 'touched_later' })])
    expect(text('a.txt')).toBe('a2\n')

    expect(code(await call(a.c, 'checkpoint_rollback', { only_step: true }))).toBe('INVALID_ARGS')
    // 最后一步单独退没有冲突
    expect(code(await call(a.c, 'checkpoint_rollback', { step: steps[0].id, only_step: true }))).toBe('OK')
    expect(text('a.txt')).toBe('a1\n')
  })
})

describe('task_delete', () => {
  it('AI 能删任何任务（别人建的也行），子任务一起删；没做完的通知执行者；不存在返回 NOT_FOUND', async () => {
    const a = await join('Alice')
    const b = await join('Bob')
    const t = await call(a.c, 'task_create', { title: '测试残留', assigneeId: 'Bob' })
    expect(code(t)).toBe('OK')
    const sub = await call(a.c, 'task_create', { title: '子任务', parentId: t.data.id })
    expect(code(sub)).toBe('OK')
    // Bob 先把派活的通知读掉
    await call(b.c, 'whoami')

    const other = await join('Carol')
    const del = await call(other.c, 'task_delete', { task: t.data.ref })
    expect(code(del)).toBe('OK')
    expect(del.data).toMatchObject({ deleted: t.data.ref, title: '测试残留' })
    expect(del.data.subtasks_deleted).toBe(1)

    const list = await call(a.c, 'task_list')
    expect(JSON.stringify(list.data)).not.toContain('测试残留')
    expect(JSON.stringify(list.data)).not.toContain('子任务')
    expect(code(await call(a.c, 'task_get', { task: t.data.ref }))).toBe('NOT_FOUND')
    expect(code(await call(a.c, 'task_get', { task: sub.data.ref }))).toBe('NOT_FOUND')
    expect(code(await call(a.c, 'task_delete', { task: t.data.ref }))).toBe('NOT_FOUND')

    const next = await call(b.c, 'whoami')
    expect(next.blocks.slice(1).join('\n')).toContain(`删除了任务 ${t.data.ref}`)
  })
})

describe('回收站工具', () => {
  it('delete 之后 trash_list 能看到，trash_restore 放回原位；原位置有东西时不覆盖', async () => {
    const a = await join('Alice')
    const del = await call(a.c, 'delete', { path: 'src/app.ts' })
    expect(code(del)).toBe('OK')
    expect(exists('src/app.ts')).toBe(false)

    const list = await call(a.c, 'trash_list')
    expect(code(list)).toBe('OK')
    expect(list.data.total).toBe(1)
    expect(list.data.items[0]).toMatchObject({
      id: del.data.trashId,
      name: 'app.ts',
      kind: 'file',
      source: 'delete',
      workspace: 'ws',
      restorable: true,
      files: 1,
      bytes: 19
    })
    expect(path.resolve(list.data.items[0].original_path)).toBe(path.join(root, 'src', 'app.ts'))

    // 原位置又有了同名文件：不覆盖
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'newer\n')
    expect(code(await call(a.c, 'trash_restore', { id: del.data.trashId }))).toBe('ALREADY_EXISTS')
    expect(text('src/app.ts')).toBe('newer\n')
    fs.rmSync(path.join(root, 'src', 'app.ts'))

    const back = await call(a.c, 'trash_restore', { id: del.data.trashId })
    expect(code(back)).toBe('OK')
    expect(back.data).toMatchObject({ restored: true, workspace: 'ws', path: 'src/app.ts' })
    expect(text('src/app.ts')).toBe('export const a = 1\n')
    expect((await call(a.c, 'trash_list')).data.total).toBe(0)
    expect(code(await call(a.c, 'trash_restore', { id: del.data.trashId }))).toBe('NOT_FOUND')
    expect(code(await call(a.c, 'trash_restore', { id: '../config.json' }))).toBe('INVALID_ARGS')
  })

  it('整个目录删掉也能原样恢复（连父目录一起建回来）', async () => {
    const a = await join('Alice')
    fs.mkdirSync(path.join(root, 'pkg', 'deep', 'x'), { recursive: true })
    fs.writeFileSync(path.join(root, 'pkg', 'deep', 'x', 'one.txt'), '1')
    fs.writeFileSync(path.join(root, 'pkg', 'deep', 'two.txt'), '22')
    const del = await call(a.c, 'delete', { path: 'pkg' })
    expect(code(del)).toBe('OK')
    const item = (await call(a.c, 'trash_list')).data.items[0]
    expect(item).toMatchObject({ name: 'pkg', kind: 'dir', files: 2, bytes: 3 })
    expect(code(await call(a.c, 'trash_restore', { id: item.id }))).toBe('OK')
    expect(text('pkg/deep/x/one.txt')).toBe('1')
    expect(text('pkg/deep/two.txt')).toBe('22')
  })

  it('trash_empty：按 id 只删指定的，按天数只删旧的，都不传清空；清掉的恢复不了', async () => {
    const a = await join('Alice')
    const ids: string[] = []
    for (const p of ['a.txt', 'b.txt', 'src/app.ts']) ids.push((await call(a.c, 'delete', { path: p })).data.trashId)
    expect((await call(a.c, 'trash_list')).data.total).toBe(3)

    const one = await call(a.c, 'trash_empty', { ids: [ids[0]] })
    expect(code(one)).toBe('OK')
    expect(one.data).toMatchObject({ removed: 1, remaining: 2, freed_bytes: 3 })
    expect(code(await call(a.c, 'trash_restore', { id: ids[0] }))).toBe('NOT_FOUND')

    // 刚删的不算「3 天以前」
    expect((await call(a.c, 'trash_empty', { older_than_days: 3 })).data).toMatchObject({ removed: 0, remaining: 2 })
    expect(code(await call(a.c, 'trash_empty', { ids: ['not-an-id'] }))).toBe('INVALID_ARGS')

    const all = await call(a.c, 'trash_empty')
    expect(all.data).toMatchObject({ removed: 2, remaining: 0 })
    expect(fs.readdirSync(trashDir())).toEqual([])
    expect(exists('b.txt')).toBe(false)
  })

  it('老版本删的条目（清单里没记原位置）：恢复到指定或默认工作区里原来的相对路径', async () => {
    const a = await join('Alice')
    const holder = path.join(trashDir(), '1700000000000-abcdef')
    fs.mkdirSync(holder, { recursive: true })
    fs.writeFileSync(path.join(holder, 'old.md'), 'old\n')
    fs.writeFileSync(path.join(holder, 'manifest.json'), JSON.stringify({ originalPath: 'docs/old.md', deletedAt: 1700000000000 }))

    const item = (await call(a.c, 'trash_list')).data.items[0]
    expect(item).toMatchObject({ id: '1700000000000-abcdef', original_path: 'docs/old.md', workspace: null, restorable: true })
    const r = await call(a.c, 'trash_restore', { id: item.id })
    expect(code(r)).toBe('OK')
    expect(r.data.path).toBe('docs/old.md')
    expect(text('docs/old.md')).toBe('old\n')
  })

  it('原位置不在这个 AI 能访问的工作区里：列表里标 restorable=false，恢复返回 WORKSPACE_FORBIDDEN；开了整台电脑的能恢复', async () => {
    const outside = path.join(base, 'outside')
    fs.mkdirSync(outside)
    const holder = path.join(trashDir(), '1700000000001-abcdef')
    fs.mkdirSync(holder, { recursive: true })
    fs.writeFileSync(path.join(holder, 'far.txt'), 'far\n')
    fs.writeFileSync(
      path.join(holder, 'manifest.json'),
      JSON.stringify({ originalPath: path.join(outside, 'far.txt').split(path.sep).join('/'), absPath: path.join(outside, 'far.txt'), deletedAt: 1700000000001 })
    )
    const plain = await join('Plain')
    expect((await call(plain.c, 'trash_list')).data.items[0]).toMatchObject({ workspace: null, restorable: false })
    expect(code(await call(plain.c, 'trash_restore', { id: '1700000000001-abcdef' }))).toBe('WORKSPACE_FORBIDDEN')
    expect(fs.existsSync(path.join(outside, 'far.txt'))).toBe(false)

    const power = await join('Power', true)
    const r = await call(power.c, 'trash_restore', { id: '1700000000001-abcdef' })
    expect(code(r)).toBe('OK')
    expect(r.data.workspace).toBe('整台电脑')
    expect(fs.readFileSync(path.join(outside, 'far.txt'), 'utf8')).toBe('far\n')
  })

  it('工作台：listTrash 带工作区，restoreTrash 放回原位，purgeTrash 清空；回滚移走的新建文件、删掉的技能也在回收站里', async () => {
    const a = await join('Alice')
    expect(code(await call(a.c, 'write_file', { path: 'made.txt', content: 'made\n' }))).toBe('OK')
    expect(code(await call(a.c, 'checkpoint_rollback'))).toBe('OK')
    expect(exists('made.txt')).toBe(false)
    expect(code(await call(a.c, 'delete', { path: 'a.txt' }))).toBe('OK')

    const wsId = bridge.getState().workspaces!.find((w) => !w.kind)!.id
    const skill = await bridge.saveSkill({ scope: 'project', name: 'demo-skill', description: '演示用的技能', body: '# 演示\n\n照着做。\n' })
    await bridge.deleteSkill(skill.id)

    const list = await bridge.listTrash()
    expect(list.map((x) => [x.name, x.source, x.workspaceId]).sort()).toEqual(
      [
        ['a.txt', 'delete', wsId],
        ['demo-skill', 'skill', wsId],
        ['made.txt', 'rollback', wsId]
      ].sort()
    )
    for (const x of list) expect(x.restoreTo && path.isAbsolute(x.restoreTo)).toBe(true)

    let changed = 0
    bridge.on('changed', (kind: string) => kind === 'trash' && changed++)
    const made = list.find((x) => x.name === 'made.txt')!
    expect(await bridge.restoreTrash(made.id)).toMatchObject({ path: 'made.txt', workspaceId: wsId })
    expect(text('made.txt')).toBe('made\n')
    const sk = list.find((x) => x.source === 'skill')!
    await bridge.restoreTrash(sk.id)
    expect(bridge.listSkills().map((s) => s.name)).toContain('demo-skill')
    await expect(bridge.restoreTrash(made.id)).rejects.toThrow(/回收站里没有/)

    expect(await bridge.purgeTrash()).toMatchObject({ removed: 1, failed: [] })
    expect(await bridge.listTrash()).toEqual([])
    expect(changed).toBeGreaterThanOrEqual(3)
  })
})

describe('会话被关后：能接上的原地接上，用户手动断开的说明原因', () => {
  const stale = (token: string, id: string): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': id, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })

  it('增删工作区后：客户端拿旧会话 id 接着用，不用重新握手', async () => {
    const a = await join('Alice')
    const id1 = sid(a.c)
    const second = path.join(base, 'second')
    fs.mkdirSync(second)
    const ws2 = await bridge.addWorkspace(second)
    // 真实客户端照常调用：服务端用同一个 id 原地重建，用的是新配置
    const who = await call(a.c, 'whoami')
    expect(code(who)).toBe('OK')
    expect(JSON.stringify(who.data)).toContain('second')
    expect(sid(a.c)).toBe(id1)
    expect(bridge.listAgentSessions(a.agent.id).map((s) => s.id)).toEqual([id1])

    await bridge.removeWorkspace(ws2.id)
    const r = await stale(a.agent.token, id1)
    expect(r.status).toBe(200)
    expect(((await r.json()) as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0)
  })

  it('同一个旧 id 并发来几个请求只重建一次；工作台重启后没见过的 id 也接得上', async () => {
    const a = await join('Alice')
    const id = '00000000-0000-4000-8000-000000000000'
    const rs = await Promise.all([stale(a.agent.token, id), stale(a.agent.token, id), stale(a.agent.token, id)])
    for (const r of rs) {
      expect(r.status).toBe(200)
      expect(((await r.json()) as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0)
    }
    expect(bridge.listAgentSessions(a.agent.id).filter((s) => s.id === id)).toHaveLength(1)
  })

  it('别的身份接不走关掉的会话；格式不对的 id 还是原来的提示', async () => {
    const a = await join('Alice')
    const b = await join('Bob')
    const id1 = sid(a.c)
    const second = path.join(base, 'second')
    fs.mkdirSync(second)
    await bridge.addWorkspace(second)
    const r = await stale(b.agent.token, id1)
    expect(r.status).toBe(403)
    await r.text()
    expect(bridge.listAgentSessions(b.agent.id).map((s) => s.id)).not.toContain(id1)

    const r4 = await stale(a.agent.token, 'not-a-session-id')
    expect(r4.status).toBe(404)
    const j4 = (await r4.json()) as { error: { message: string; data: { code: string } } }
    expect(j4.error.message).toContain('会话不存在或已过期')
    expect(j4.error.data.code).toBe('SESSION_NOT_FOUND')
  })

  it('用户在工作台手动断开的不自动接上，404 里带原因', async () => {
    const a = await join('Alice')
    const id = sid(a.c)
    await bridge.disconnectAgent(a.agent.id)
    const r = await stale(a.agent.token, id)
    expect(r.status).toBe(404)
    const j = (await r.json()) as { error: { message: string; data: { code: string } } }
    expect(j.error.message).toContain('用户在工作台断开了这个连接')
    expect(j.error.data.code).toBe('SESSION_CLOSED')
    expect(bridge.listAgentSessions(a.agent.id)).toHaveLength(0)
  })
})

describe('接口说明', () => {
  it('run_command 默认前台等 30 秒（最长 120 秒），说明里写了；【通知】是单独的文本块；read_file 说明了返回格式', async () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000)
    expect(MAX_TIMEOUT_MS).toBe(120_000)
    const a = await join('Alice')
    const tools = (await a.c.listTools()).tools
    const desc = (n: string): string => tools.find((t) => t.name === n)!.description ?? ''
    expect(desc('run_command')).toContain('前台默认等 30 秒')
    expect(JSON.stringify(tools.find((t) => t.name === 'run_command')!.inputSchema)).toContain('默认 30000')
    expect(desc('read_file')).toContain('不是 JSON')
    expect(a.c.getInstructions()).toContain('单独的最后一个文本块')
    expect(a.c.getInstructions()).not.toContain('PROTECTED_PATH')

    // 通知不拼在 JSON 后面：第一个文本块能直接按 JSON 解析
    const b = await join('Bob')
    expect(code(await call(a.c, 'task_create', { title: '给 Bob 的活', assigneeId: 'Bob' }))).toBe('OK')
    const r = await call(b.c, 'whoami')
    expect(r.blocks).toHaveLength(2)
    expect(() => JSON.parse(r.blocks[0])).not.toThrow()
    expect(r.blocks[1].startsWith('【通知】')).toBe(true)
  })
})
