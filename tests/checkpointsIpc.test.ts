// 工作台「改动与检查点」页用的 Bridge 接口：listCheckpoints / checkpointSummary / rollbackCheckpoints。
// AI 用真实 MCP 客户端改文件（自动存检查点），用户这边直接调 Bridge（和 IPC 一样的参数）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import type { ActivityEvent, Agent } from '../src/core/types'

let base: string
let root: string
let bridge: Bridge
let url: string
let wsId: string
const clients: Client[] = []

async function join(name: string): Promise<{ agent: Agent; c: Client }> {
  const agent = bridge.createAgent(name)
  const c = new Client({ name: 'ckpt-ipc-test', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${agent.token}` } } }))
  clients.push(c)
  return { agent, c }
}

async function ok(c: Client, name: string, args: Record<string, unknown>): Promise<void> {
  const r = await c.callTool({ name, arguments: args })
  if (r.isError) throw new Error(`${name} 失败：${JSON.stringify(r.content)}`)
}

const P = (...lines: string[]): string => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')
const text = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')
const exists = (rel: string): boolean => fs.existsSync(path.join(root, rel))

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ckpt-ipc-'))
  root = path.join(base, 'ws')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const a = 1\nexport const keep = 0\n')
  fs.writeFileSync(path.join(root, 'old.md'), 'old\n')
  bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'user-skills') })
  await bridge.start()
  url = bridge.getState().mcpUrl
  wsId = bridge.getState().activeWorkspaceId!
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  await bridge.stop()
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

/** Alice 一个补丁改 app.ts、新建 new.ts、删 old.md，再单独写一个文件 */
async function aliceEdits() {
  const a = await join('Alice')
  await ok(a.c, 'apply_patch', {
    patch: P('*** Update File: src/app.ts', '@@', '-export const a = 1', '+export const a = 2', '*** Add File: src/new.ts', '+export const b = 1', '*** Delete File: old.md')
  })
  await ok(a.c, 'write_file', { path: 'notes/x.md', content: 'x\ny\n' })
  return a
}

describe('listCheckpoints', () => {
  it('按会话分组、新的在前，每步带 AI、工具、文件和增删行数；可按 AI 筛选', async () => {
    const a = await aliceEdits()
    const b = await join('Bob')
    await ok(b.c, 'write_file', { path: 'bob.txt', content: 'bob\n' })

    const all = await bridge.listCheckpoints({ workspaceId: wsId })
    expect(all.workspaceId).toBe(wsId)
    expect(all.total).toBe(3)
    expect(all.sessions.map((s) => s.agentName)).toEqual(['Bob', 'Alice'])
    expect(all.agents.map((x) => [x.agentName, x.steps]).sort()).toEqual([
      ['Alice', 2],
      ['Bob', 1]
    ])
    const alice = all.sessions[1]
    expect(alice.agentId).toBe(a.agent.id)
    expect(alice.agentColor).toBe(a.agent.color)
    expect(alice.steps.map((s) => s.tool)).toEqual(['write_file', 'apply_patch'])
    const patch = alice.steps[1]
    expect(patch.kind).toBe('edit')
    expect(patch.rolledBack).toBe('none')
    const byPath = Object.fromEntries(patch.files.map((f) => [f.path, f]))
    expect(byPath['src/app.ts']).toMatchObject({ change: 'modified', additions: 1, deletions: 1 })
    expect(byPath['src/new.ts']).toMatchObject({ change: 'added', additions: 1, deletions: 0 })
    expect(byPath['old.md']).toMatchObject({ change: 'deleted', additions: 0, deletions: 1 })
    expect(patch).toMatchObject({ additions: 2, deletions: 2 })
    expect(alice.steps[0].files).toEqual([expect.objectContaining({ path: 'notes/x.md', change: 'added', additions: 2 })])

    const onlyBob = await bridge.listCheckpoints({ agentId: b.agent.id })
    expect(onlyBob.sessions.flatMap((s) => s.steps.map((x) => x.agentName))).toEqual(['Bob'])
    // 筛选用的 AI 列表不受 agentId 影响
    expect(onlyBob.agents).toHaveLength(2)
    expect((await bridge.listCheckpoints({ limit: 1 })).truncated).toBe(true)
    // 只按会话看
    const one = await bridge.listCheckpoints({ session: alice.session })
    expect(one.sessions.map((s) => s.session)).toEqual([alice.session])
  })

  it('同一文件连改两次：每步的行数是这一步自己的，不是净改动', async () => {
    const a = await join('Alice')
    await ok(a.c, 'write_file', { path: 'f.txt', content: '1\n' })
    await ok(a.c, 'write_file', { path: 'f.txt', content: '1\n2\n3\n', overwrite: true })
    const steps = (await bridge.listCheckpoints()).sessions[0].steps
    expect(steps.map((s) => [s.files[0].additions, s.files[0].deletions])).toEqual([
      [2, 0],
      [1, 0]
    ])
  })

  it('只认工作台已知的工作区', async () => {
    await expect(bridge.listCheckpoints({ workspaceId: 'w_nope' })).rejects.toThrow('工作区不存在')
  })
})

describe('checkpointSummary', () => {
  it('净 diff：按文件给状态、增删行数和各自的 unified diff；可按 stepIds / session / agentId 选', async () => {
    const a = await aliceEdits()
    await ok(a.c, 'edit_file', { path: 'src/app.ts', edits: [{ old_string: 'export const a = 2', new_string: 'export const a = 3' }] })
    const s = await bridge.checkpointSummary({ workspaceId: wsId, agentId: a.agent.id })
    expect(s.files.map((f) => [f.path, f.status])).toEqual([
      ['notes/x.md', 'added'],
      ['old.md', 'deleted'],
      ['src/app.ts', 'modified'],
      ['src/new.ts', 'added']
    ])
    const app = s.files.find((f) => f.path === 'src/app.ts')!
    // 两次修改合并成从 1 到 3 的一处改动
    expect(app).toMatchObject({ additions: 1, deletions: 1 })
    expect(app.diff).toContain('-export const a = 1')
    expect(app.diff).toContain('+export const a = 3')
    expect(app.diff).not.toContain('old.md')
    expect(app.checkpoints).toHaveLength(2)
    expect(s.totals).toMatchObject({ files: 4, checkpoints: 3 })

    const list = await bridge.listCheckpoints()
    const firstStep = list.sessions[0].steps.at(-1)!.id
    const one = await bridge.checkpointSummary({ stepIds: [firstStep] })
    expect(one.files.find((f) => f.path === 'src/app.ts')?.diff).toContain('+export const a = 3')
    expect(one.files.map((f) => f.path)).not.toContain('notes/x.md')
    const bySession = await bridge.checkpointSummary({ session: list.sessions[0].session })
    expect(bySession.totals.files).toBe(4)
    await expect(bridge.checkpointSummary({ stepIds: ['cp-999'] })).rejects.toThrow('不存在')
  })
})

describe('rollbackCheckpoints', () => {
  it('dryRun 只给计划不写；真回滚以用户身份进行、记活动事件、存成回滚检查点', async () => {
    await aliceEdits()
    const events: ActivityEvent[] = []
    bridge.on('event', (e: ActivityEvent) => events.push(e))
    const session = (await bridge.listCheckpoints()).sessions[0].session

    const plan = await bridge.rollbackCheckpoints({ session, dryRun: true })
    expect(plan.status).toBe('dry_run')
    if (plan.status !== 'dry_run') return
    expect(Object.fromEntries(plan.files.map((f) => [f.path, f.action]))).toEqual({
      'src/app.ts': 'restore',
      'src/new.ts': 'delete',
      'old.md': 'recreate',
      'notes/x.md': 'delete'
    })
    expect(text('src/app.ts')).toContain('a = 2')
    expect(events).toEqual([])

    const r = await bridge.rollbackCheckpoints({ session })
    expect(r.status).toBe('done')
    if (r.status !== 'done') return
    expect(r.rolledBackCheckpoints).toHaveLength(2)
    expect(text('src/app.ts')).toBe('export const a = 1\nexport const keep = 0\n')
    expect(exists('src/new.ts')).toBe(false)
    expect(text('old.md')).toBe('old\n')
    expect(exists('notes/x.md')).toBe(false)

    const ev = events.find((e) => e.tool === 'checkpoint_rollback' && e.status === 'ok')
    expect(ev).toMatchObject({ agentId: 'user', agentName: '你', workspaceId: wsId })
    expect(ev?.summary).toContain('用户在工作台回滚了 4 个文件')

    const after = await bridge.listCheckpoints()
    const rb = after.sessions.find((s) => s.agentId === 'user')!
    expect(rb.steps[0]).toMatchObject({ kind: 'rollback', tool: 'checkpoint_rollback', agentName: '你' })
    expect(after.sessions.find((s) => s.session === session)!.steps.every((s) => s.rolledBack === 'all')).toBe(true)
    // 再回滚一次：没东西了
    expect((await bridge.rollbackCheckpoints({ session })).status).toBe('nothing')
  })

  it('只回滚选中的文件；paths 只接受检查点里记录过的路径', async () => {
    await aliceEdits()
    const steps = (await bridge.listCheckpoints()).sessions[0].steps
    const patchStep = steps.find((s) => s.tool === 'apply_patch')!
    const r = await bridge.rollbackCheckpoints({ stepIds: [patchStep.id], paths: ['src/app.ts'] })
    expect(r.status).toBe('done')
    expect(text('src/app.ts')).toContain('a = 1')
    expect(exists('src/new.ts')).toBe(true)
    expect(exists('old.md')).toBe(false)
    await expect(bridge.rollbackCheckpoints({ stepIds: [patchStep.id], paths: [path.join(root, 'src', 'new.ts')] })).rejects.toThrow('不在所选检查点里')
    await expect(bridge.rollbackCheckpoints({ stepIds: [patchStep.id], paths: ['../outside.txt'] })).rejects.toThrow('不在所选检查点里')
    await expect(bridge.rollbackCheckpoints({})).rejects.toThrow('stepIds')
  })

  it('冲突：别人后来又改过、或在工作台外被改过，返回冲突详情，一个文件都不写', async () => {
    const a = await join('Alice')
    const b = await join('Bob')
    await ok(a.c, 'write_file', { path: 'shared.txt', content: 'alice\n' })
    await ok(a.c, 'write_file', { path: 'mine.txt', content: 'mine\n' })
    await ok(b.c, 'write_file', { path: 'shared.txt', content: 'bob\n', overwrite: true })
    const aliceSession = (await bridge.listCheckpoints({ agentId: a.agent.id })).sessions[0].session

    const r = await bridge.rollbackCheckpoints({ session: aliceSession, dryRun: true })
    expect(r.status).toBe('conflict')
    if (r.status !== 'conflict') return
    expect(r.conflicts).toEqual([expect.objectContaining({ path: 'shared.txt', reason: 'touched_by_other', detail: expect.stringContaining('Bob') })])
    expect(r.restorable).toEqual(['mine.txt'])
    expect((await bridge.rollbackCheckpoints({ session: aliceSession })).status).toBe('conflict')
    expect(text('mine.txt')).toBe('mine\n')

    // 只退没冲突的文件可以
    expect((await bridge.rollbackCheckpoints({ session: aliceSession, paths: ['mine.txt'] })).status).toBe('done')
    expect(exists('mine.txt')).toBe(false)

    // 检查点之后被编辑器改过
    const bobSession = (await bridge.listCheckpoints({ agentId: b.agent.id })).sessions[0].session
    fs.writeFileSync(path.join(root, 'shared.txt'), 'edited by hand\n')
    const r2 = await bridge.rollbackCheckpoints({ session: bobSession, dryRun: true })
    expect(r2.status === 'conflict' && r2.conflicts[0].reason).toBe('modified_after')
    expect(text('shared.txt')).toBe('edited by hand\n')
  })

  it("有新检查点时推 changed('checkpoints')，做了节流", async () => {
    const kinds: [string, unknown][] = []
    bridge.on('changed', (kind: string, ws: unknown) => kinds.push([kind, ws]))
    const a = await join('Alice')
    for (let i = 0; i < 5; i++) await ok(a.c, 'write_file', { path: `f${i}.txt`, content: `${i}\n` })
    await new Promise((r) => setTimeout(r, 400))
    const ck = kinds.filter(([k]) => k === 'checkpoints')
    expect(ck.length).toBeGreaterThanOrEqual(1)
    expect(ck.length).toBeLessThan(5)
    expect(ck[0][1]).toBe(wsId)
  })
})
