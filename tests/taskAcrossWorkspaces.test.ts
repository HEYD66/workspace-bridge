// 第 38 批：任务建在项目里，文件却在项目目录外面（各 AI 自己的工作目录），只能经「整台电脑」去改。
// 这种改动要挂到那个项目里进行中的任务上；没有任何进行中的任务就改文件时提醒一次。
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
let outside: string
let bridge: Bridge
let url: string
const clients: Client[] = []
const MACHINE = '整台电脑'
const REMIND = '你现在没有进行中的任务'

async function connect(agent: Agent): Promise<Client> {
  const c = new Client({ name: 'task-across-test', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${agent.token}` } } }))
  clients.push(c)
  return c
}

/** 结果的正文（解析成对象）和整个结果的全部文字（含【通知】） */
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; data: any; all: string }> {
  const r = await c.callTool({ name, arguments: args })
  const texts = (r.content as { type: string; text: string }[]).map((p) => p.text ?? '')
  const body = texts.find((t) => !t.startsWith('【通知】')) ?? ''
  let data: unknown = body
  try {
    data = JSON.parse(body)
  } catch {
    // 纯文本结果
  }
  return { isError: Boolean(r.isError), data, all: texts.join('\n') }
}

const slash = (p: string): string => p.split(path.sep).join('/')

async function member(name: string, machine = true): Promise<Agent> {
  const agent = bridge.createAgent(name)
  if (machine) await bridge.updateAgent(agent.id, { machineAccess: true })
  return agent
}

/** 在项目里建一条任务并认领（认领后就是进行中），返回编号 */
async function startTask(c: Client, title: string, workspace?: string): Promise<string> {
  const t = await call(c, 'task_create', { title, ...(workspace ? { workspace } : {}) })
  expect(t.isError).toBe(false)
  const ref = t.data.ref as string
  const claimed = await call(c, 'task_claim', { task: ref, ...(workspace ? { workspace } : {}) })
  expect(claimed.data.status).toBe('in_progress')
  return ref
}

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-across-'))
  root = path.join(base, 'proj')
  outside = path.join(base, 'proj-wt-alice')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(outside, 'src'), { recursive: true })
  fs.mkdirSync(path.join(base, 'home'), { recursive: true })
  fs.writeFileSync(path.join(outside, 'src', 'x.ts'), 'export const x = 1\n')
  bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoot: root, machineRoot: path.join(base, 'home'), port: 0, userSkillsDir: path.join(base, 'user-skills') })
  await bridge.start()
  url = bridge.getState().mcpUrl
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  await bridge.stop()
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

describe('经「整台电脑」改的文件挂到项目里进行中的任务上', () => {
  it('项目里有一条进行中的任务：改动记成「项目名/T-1」；在项目里按任务看得到（绝对路径）、交付时附得上；回滚去「整台电脑」里退，只能退自己的', async () => {
    const alice = await member('Alice')
    const a = await connect(alice)
    const ref = await startTask(a, '在工作目录里改 x')
    const file = slash(path.join(outside, 'src', 'x.ts'))
    const w = await call(a, 'edit_file', { workspace: MACHINE, path: file, edits: [{ old_string: 'x = 1', new_string: 'x = 2' }] })
    expect(w.isError, w.all).toBe(false)
    expect(w.all).not.toContain(REMIND)

    // 存在「整台电脑」的检查点里，任务标记带着项目名，和那边自己的 T-1 分得开
    const list = await call(a, 'checkpoint_list', { workspace: MACHINE, scope: 'all' })
    const tags = list.data.sessions.flatMap((s: { tasks: string[] }) => s.tasks) as string[]
    expect(tags).toHaveLength(1)
    const tag = tags[0]
    expect(tag).toMatch(new RegExp(`^.+/${ref}$`))

    // 在项目里按任务看：留痕清单里有，任务是这边的编号，路径是绝对路径
    const trail = await call(a, 'change_trail', { task: ref })
    expect(trail.data.entries).toHaveLength(1)
    expect(trail.data.entries[0].task).toBe(ref)
    expect(trail.data.entries[0].title).toBe('在工作目录里改 x')
    expect(trail.data.entries[0].files.map((f: { path: string }) => f.path)).toEqual([file])
    // 不带任务编号时也在，而且没有混进「没挂任务」那一项
    const whole = await call(a, 'change_trail', {})
    expect(whole.data.entries.map((e: { task: string | null }) => e.task)).toEqual([ref])

    // 项目里的汇总算不了那边的内容，但要说清楚还有改动在哪、怎么查
    const sum = await call(a, 'changes_summary', { task: ref })
    expect(sum.data.totals.files).toBe(0)
    expect(sum.data.elsewhere).toEqual([expect.objectContaining({ workspace: MACHINE, task: tag, checkpoints: 1, files: 1 })])
    const there = await call(a, 'changes_summary', { workspace: MACHINE, task: tag })
    expect(there.data.totals.files).toBe(1)
    expect(there.data.elsewhere).toBeUndefined()

    // 界面的留痕清单用的接口：要了 elsewhere 才给，任务是这边的编号、路径是绝对路径
    const forUi = await bridge.listCheckpoints({ elsewhere: true })
    expect(forUi.sessions).toEqual([])
    expect(forUi.elsewhere).toEqual([expect.objectContaining({ agentName: 'Alice', task: ref, kind: 'edit', files: [{ path: file }] })])
    expect((await bridge.listCheckpoints()).elsewhere).toBeUndefined()

    // 别人按这个标记去退：不是他的，一个文件也退不了
    const bob = await member('Bob')
    const b = await connect(bob)
    const notMine = await call(b, 'checkpoint_rollback', { workspace: MACHINE, task: tag, dry_run: true })
    expect(notMine.isError || (notMine.data.files as unknown[]).length === 0).toBe(true)

    // 在项目里按任务回滚预演：这边没有文件可退，但指了路
    const dryHere = await call(a, 'checkpoint_rollback', { task: ref, dry_run: true })
    expect(dryHere.isError).toBe(true)
    expect(dryHere.data.error).toBe('NOTHING_TO_ROLLBACK')
    expect(dryHere.data.message).toContain(`workspace="${MACHINE}" task="${tag}"`)
    expect(dryHere.data.elsewhere?.[0]).toMatchObject({ workspace: MACHINE, task: tag, files: 1 })
    // 去「整台电脑」里预演：列出要退的文件；真退之后内容回来了
    const dry = await call(a, 'checkpoint_rollback', { workspace: MACHINE, task: tag, dry_run: true })
    expect(JSON.stringify(dry.data.files)).toContain('x.ts')
    expect(fs.readFileSync(path.join(outside, 'src', 'x.ts'), 'utf8')).toBe('export const x = 2\n')

    // 交付时附改动：那边的改动附上了
    const done = await call(a, 'task_update', { task: ref, status: 'done', result: '改好了', attach_changes: true })
    expect(done.isError).toBe(false)
    const body = JSON.stringify(done.data)
    expect(body).toContain('改好了')
    expect(body).toContain('x.ts')
    expect(body).toContain('```diff')

    const back = await call(a, 'checkpoint_rollback', { workspace: MACHINE, task: tag })
    expect(back.isError).toBe(false)
    expect(fs.readFileSync(path.join(outside, 'src', 'x.ts'), 'utf8')).toBe('export const x = 1\n')
  })

  it('两个项目里各有一条进行中的任务：不猜，不挂，提醒一次说清有哪几条', async () => {
    const other = path.join(base, 'proj-b')
    fs.mkdirSync(other, { recursive: true })
    const w2 = await bridge.addWorkspace(other)
    const alice = await member('Alice')
    const a = await connect(alice)
    const r1 = await startTask(a, '项目一的活', 'proj')
    const r2 = await startTask(a, '项目二的活', w2.name)
    const file = slash(path.join(outside, 'src', 'x.ts'))
    const w = await call(a, 'edit_file', { workspace: MACHINE, path: file, edits: [{ old_string: 'x = 1', new_string: 'x = 3' }] })
    expect(w.isError, w.all).toBe(false)
    expect(w.all).toContain('2 条进行中的任务')
    expect(w.all).toContain(`proj/${r1}`)
    expect(w.all).toContain(`${w2.name}/${r2}`)
    const list = await call(a, 'checkpoint_list', { workspace: MACHINE, scope: 'all' })
    expect(list.data.sessions.flatMap((s: { tasks: string[] }) => s.tasks)).toEqual([])
    // 只提醒一次
    const again = await call(a, 'edit_file', { workspace: MACHINE, path: file, edits: [{ old_string: 'x = 3', new_string: 'x = 4' }] })
    expect(again.isError).toBe(false)
    expect(again.all).not.toContain('条进行中的任务')
  })

  it('有一个项目查不成（目录没了）：不把「只查到一条」当成「只有一条」，不挂，提醒里说清是没查全', async () => {
    const gone = path.join(base, 'proj-gone')
    fs.mkdirSync(gone, { recursive: true })
    await bridge.addWorkspace(gone)
    const alice = await member('Alice')
    const a = await connect(alice)
    const ref = await startTask(a, '项目一的活', 'proj')
    fs.rmSync(gone, { recursive: true, force: true })
    const file = slash(path.join(outside, 'src', 'x.ts'))
    const w = await call(a, 'edit_file', { workspace: MACHINE, path: file, edits: [{ old_string: 'x = 1', new_string: 'x = 5' }] })
    expect(w.isError, w.all).toBe(false)
    expect(w.all).toContain('有项目没查成')
    const list = await call(a, 'checkpoint_list', { workspace: MACHINE, scope: 'all' })
    expect(list.data.sessions.flatMap((s: { tasks: string[] }) => s.tasks)).toEqual([])
    expect((await call(a, 'change_trail', { workspace: 'proj', task: ref })).data.entries).toEqual([])
  })

  it('在项目工作区里改文件只认这个项目的任务：别的项目里的任务不算数', async () => {
    const other = path.join(base, 'proj-b')
    fs.mkdirSync(other, { recursive: true })
    const w2 = await bridge.addWorkspace(other)
    const alice = await member('Alice')
    const a = await connect(alice)
    await startTask(a, '项目二的活', w2.name)
    const w = await call(a, 'write_file', { workspace: 'proj', path: 'src/in.ts', content: 'export const y = 1\n' })
    expect(w.isError).toBe(false)
    expect(w.all).toContain(REMIND)
    const list = await call(a, 'checkpoint_list', { workspace: 'proj', scope: 'all' })
    expect(list.data.sessions.flatMap((s: { tasks: string[] }) => s.tasks)).toEqual([])
  })
})

describe('没有进行中的任务就改文件：提醒一次', () => {
  it('每次连接只提醒一次，不拦；读文件、跑不改文件的工具不提醒；有了任务就不提醒', async () => {
    const alice = await member('Alice', false)
    const a = await connect(alice)
    expect((await call(a, 'list_dir', {})).all).not.toContain(REMIND)
    const first = await call(a, 'write_file', { path: 'src/a.ts', content: 'export const a = 1\n' })
    expect(first.isError).toBe(false)
    expect(first.all).toContain(REMIND)
    expect(first.all).toContain('【通知】')
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    const second = await call(a, 'edit_file', { path: 'src/a.ts', edits: [{ old_string: 'a = 1', new_string: 'a = 2' }] })
    expect(second.isError).toBe(false)
    expect(second.all).not.toContain(REMIND)

    // 新的连接：先认领任务再改，不提醒
    const a2 = await connect(alice)
    await startTask(a2, '改 a')
    const withTask = await call(a2, 'write_file', { path: 'src/b.ts', content: 'export const b = 1\n' })
    expect(withTask.all).not.toContain(REMIND)

    // 写失败不提醒（没有改动）
    const carol = await member('Carol', false)
    const c = await connect(carol)
    const bad = await call(c, 'edit_file', { path: 'src/nope.ts', edits: [{ old_string: 'x', new_string: 'y' }] })
    expect(bad.isError).toBe(true)
    expect(bad.all).not.toContain(REMIND)
  })
})
