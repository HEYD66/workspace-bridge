// 检查点工具的集成测试：写文件工具自动存检查点、checkpoint_list / changes_summary / checkpoint_rollback、
// 冲突时一个都不写、只能回滚自己的、有职位的 AI 也有检查点工具、task_update 的 attach_changes。
// 真实 Bridge + 真实 MCP 客户端；存储和回滚算法的细节在 checkpoints.test.ts
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
}

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 'checkpoint-test', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  clients.push(c)
  return c
}

async function join(name: string, roleId?: string): Promise<{ agent: Agent; c: Client }> {
  const agent = bridge.createAgent(name, roleId)
  return { agent, c: await connect(agent.token) }
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const r = await c.callTool({ name, arguments: args })
  const body = (r.content as { type: string; text: string }[]).map((p) => p.text).find((t) => !t.startsWith('【通知】')) ?? ''
  let data: unknown = body
  try {
    data = JSON.parse(body)
  } catch {
    // 纯文本结果
  }
  return { isError: Boolean(r.isError), data }
}

const code = (r: Result): string => (r.isError ? (typeof r.data === 'object' ? r.data.error : 'SDK_ERROR') : 'OK')
const toolNames = async (c: Client): Promise<string[]> => (await c.listTools()).tools.map((t) => t.name)
const P = (...lines: string[]): string => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')
const text = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')
const exists = (rel: string): boolean => fs.existsSync(path.join(root, rel))

/** 一个补丁同时改、增、删 */
const MULTI = P(
  '*** Update File: src/app.ts',
  '@@',
  '-export const a = 1',
  '+export const a = 2',
  '*** Add File: src/new.ts',
  '+export const b = 1',
  '*** Delete File: docs/old.md'
)

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ckpt-'))
  root = path.join(base, 'ws')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const a = 1\n')
  fs.writeFileSync(path.join(root, 'docs', 'old.md'), 'old\n')
  bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'user-skills') })
  await bridge.start()
  url = bridge.getState().mcpUrl
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  await bridge.stop()
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

describe('检查点工具的可用性', () => {
  it('有职位的 AI 连上后也能看到三个检查点工具', async () => {
    const w = await join('Writer', 'tester')
    expect(await toolNames(w.c)).toEqual(expect.arrayContaining(['checkpoint_list', 'changes_summary', 'checkpoint_rollback']))
  })
})

describe('改文件 → 汇总 → 回滚', () => {
  it('写文件工具自动存检查点；汇总给出净改动；回滚后改过的恢复、新建的进回收站、删掉的建回来', async () => {
    const a = await join('Alice')
    expect(code(await call(a.c, 'apply_patch', { patch: MULTI }))).toBe('OK')
    expect(code(await call(a.c, 'write_file', { path: 'notes/x.md', content: 'x\n' }))).toBe('OK')

    const list = await call(a.c, 'checkpoint_list')
    expect(code(list)).toBe('OK')
    expect(list.data.sessions).toHaveLength(1)
    expect(list.data.sessions[0].current).toBe(true)
    expect(list.data.sessions[0].checkpoints.map((s: { tool: string }) => s.tool)).toEqual(['write_file', 'apply_patch'])

    const sum = await call(a.c, 'changes_summary')
    expect(code(sum)).toBe('OK')
    expect(sum.data.files.map((f: { status: string; path: string }) => `${f.status}:${f.path}`)).toEqual([
      'deleted:docs/old.md',
      'added:notes/x.md',
      'modified:src/app.ts',
      'added:src/new.ts'
    ])
    expect(sum.data.diff).toContain('+export const a = 2')
    expect(sum.data.review_text).toContain('4 个文件')
    // 检查点存在 Bridge 的数据目录里，工作区里没有多出东西
    expect(fs.readdirSync(root).sort()).toEqual(['docs', 'notes', 'src'])

    const dry = await call(a.c, 'checkpoint_rollback', { dry_run: true })
    expect(code(dry)).toBe('OK')
    expect(dry.data.files).toHaveLength(4)
    expect(text('src/app.ts')).toBe('export const a = 2\n')

    const rb = await call(a.c, 'checkpoint_rollback')
    expect(code(rb)).toBe('OK')
    expect(text('src/app.ts')).toBe('export const a = 1\n')
    expect(text('docs/old.md')).toBe('old\n')
    expect(exists('src/new.ts')).toBe(false)
    expect(exists('notes/x.md')).toBe(false)

    const after = await call(a.c, 'changes_summary')
    expect(after.data.totals.files).toBe(0)
    // 再退一次：没东西可退
    expect(code(await call(a.c, 'checkpoint_rollback'))).toBe('NOTHING_TO_ROLLBACK')
  })

  it('检查点之后文件被编辑器改过：CONFLICT，一个文件都不写；paths 只退没冲突的', async () => {
    const a = await join('Alice')
    expect(code(await call(a.c, 'apply_patch', { patch: MULTI }))).toBe('OK')
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const a = 99\n')

    const r = await call(a.c, 'checkpoint_rollback')
    expect(code(r)).toBe('CONFLICT')
    expect(r.data.conflicts).toEqual([expect.objectContaining({ path: 'src/app.ts', reason: 'modified_after' })])
    expect(exists('src/new.ts')).toBe(true)
    expect(exists('docs/old.md')).toBe(false)

    expect(code(await call(a.c, 'checkpoint_rollback', { paths: ['src/new.ts', 'docs/old.md'] }))).toBe('OK')
    expect(exists('src/new.ts')).toBe(false)
    expect(text('docs/old.md')).toBe('old\n')
    expect(text('src/app.ts')).toBe('export const a = 99\n')
  })

  it('另一个 AI 后来也改了同一个文件：CONFLICT（touched_by_other）；也不能回滚别人的检查点', async () => {
    const a = await join('Alice')
    const b = await join('Bob')
    expect(code(await call(a.c, 'apply_patch', { patch: P('*** Update File: docs/old.md', '@@', '-old', '+alice') }))).toBe('OK')
    expect(code(await call(b.c, 'apply_patch', { patch: P('*** Update File: docs/old.md', '@@', '-alice', '+bob') }))).toBe('OK')

    const r = await call(a.c, 'checkpoint_rollback')
    expect(code(r)).toBe('CONFLICT')
    expect(r.data.conflicts).toEqual([expect.objectContaining({ path: 'docs/old.md', reason: 'touched_by_other' })])
    expect(text('docs/old.md')).toBe('bob\n')

    const bobStep = (await call(b.c, 'checkpoint_list')).data.sessions[0].checkpoints[0].id
    expect(code(await call(a.c, 'checkpoint_rollback', { step: bobStep }))).toBe('FORBIDDEN')
    expect(text('docs/old.md')).toBe('bob\n')
  })
})

describe('task_update 的 attach_changes', () => {
  it('提交审查时把这个任务里的改动汇总附在交付说明后面；按 task 汇总', async () => {
    const a = await join('Alice')
    const t = await call(a.c, 'task_create', { title: '把 a 改成 2' })
    expect(code(t)).toBe('OK')
    const ref = t.data.ref as string
    expect(code(await call(a.c, 'task_claim', { task: ref }))).toBe('OK')
    expect(code(await call(a.c, 'apply_patch', { patch: MULTI }))).toBe('OK')

    const byTask = await call(a.c, 'changes_summary', { task: ref })
    expect(byTask.data.totals.files).toBe(3)

    const r = await call(a.c, 'task_update', { task: ref, status: 'review', result: '改好了', attach_changes: true })
    expect(code(r)).toBe('OK')
    const body = JSON.stringify(r.data)
    expect(body).toContain('改好了')
    expect(body).toContain('src/app.ts')
    expect(body).toContain('```diff')
  })
})
