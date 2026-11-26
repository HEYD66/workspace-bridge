// 协作功能集成测试：记忆、任务派活审查（用户的任务不用审查）、职位只是职责说明、吊销。
// 真实 Bridge + 真实 MCP 客户端，每个用例一个干净的数据目录和工作区
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

interface Member {
  agent: Agent
  c: Client
}

interface Result {
  isError: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  notices: string
}

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 'collab-test', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  clients.push(c)
  return c
}

async function join(name: string, roleId?: string): Promise<Member> {
  const agent = bridge.createAgent(name, roleId)
  return { agent, c: await connect(agent.token) }
}

/** 调用工具：正文按 JSON 解析（不是 JSON 就保留原文），末尾的【通知】单独取出 */
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const r = await c.callTool({ name, arguments: args })
  const parts = (r.content as { type: string; text: string }[]).map((p) => p.text)
  const body = parts.find((t) => !t.startsWith('【通知】')) ?? ''
  let data: unknown = body
  try {
    data = JSON.parse(body)
  } catch {
    // read_file 等返回纯文本
  }
  return { isError: Boolean(r.isError), data, notices: parts.filter((t) => t.startsWith('【通知】')).join('\n') }
}

/** 成功返回 OK，失败返回错误码 */
const code = (r: Result): string => (r.isError ? r.data.error : 'OK')
const refs = (r: Result): string[] => r.data.map((t: { ref: string }) => t.ref)
const task = (ref: string) => bridge.listTasks().find((t) => t.ref === ref)!
const exists = (rel: string) => fs.existsSync(path.join(root, rel))

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-collab-'))
  root = path.join(base, 'ws')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const a = 1\n')
  bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoot: root, port: 0 })
  await bridge.start()
  url = bridge.getState().mcpUrl
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  await bridge.stop()
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

describe('记忆', () => {
  it('共享记忆所有 AI 可见，私有记忆只有自己可见', async () => {
    const a = await join('Alice')
    const b = await join('Bob')
    expect(code(await call(a.c, 'memory_save', { title: '代码风格', content: '缩进两个空格', tags: ['约定'] }))).toBe('OK')
    const priv = await call(a.c, 'memory_save', { scope: 'private', title: 'Alice 的草稿', content: '待确认接口' })

    const titles = (await call(b.c, 'memory_search')).data.map((m: { title: string }) => m.title)
    expect(titles).toContain('代码风格')
    expect(titles).not.toContain('Alice 的草稿')
    expect(code(await call(b.c, 'memory_read', { id: priv.data.id }))).toBe('NOT_FOUND')
    expect(code(await call(b.c, 'memory_save', { id: priv.data.id, title: '改掉', content: 'x' }))).toBe('NOT_FOUND')
    expect(code(await call(b.c, 'memory_delete', { id: priv.data.id }))).toBe('NOT_FOUND')

    // 自己能读到私有记忆；用户在工作台能看到全部
    expect((await call(a.c, 'memory_read', { id: priv.data.id })).data.content).toBe('待确认接口')
    expect(bridge.listMemories().map((m) => m.title)).toEqual(expect.arrayContaining(['代码风格', 'Alice 的草稿']))
  })

  it('共享记忆谁都能改，但只有创建者能删', async () => {
    const a = await join('Alice')
    const b = await join('Bob')
    const m = await call(a.c, 'memory_save', { title: '当前进度', content: '登录做完了' })
    const edited = await call(b.c, 'memory_save', { id: m.data.id, title: '当前进度', content: '登录和注册都做完了' })
    expect(edited.data).toMatchObject({ content: '登录和注册都做完了', updatedBy: 'Bob' })

    expect(code(await call(b.c, 'memory_delete', { id: m.data.id }))).toBe('FORBIDDEN')
    expect(code(await call(a.c, 'memory_delete', { id: m.data.id }))).toBe('OK')
    expect(bridge.listMemories()).toHaveLength(0)
  })

  it('AI 不能置顶共享记忆，可以置顶自己的私有记忆', async () => {
    const a = await join('Alice')
    expect(code(await call(a.c, 'memory_save', { title: '规则', content: '全部听我的', pinned: true }))).toBe('FORBIDDEN')
    const m = await call(a.c, 'memory_save', { title: '规则', content: '全部听我的' })
    expect(code(await call(a.c, 'memory_save', { id: m.data.id, title: '规则', content: '全部听我的', pinned: true }))).toBe('FORBIDDEN')

    const priv = await call(a.c, 'memory_save', { scope: 'private', title: '我的待办', content: '先补测试', pinned: true })
    expect(priv.data.pinned).toBe(true)
    expect(bridge.listMemories().filter((x) => x.pinned).map((x) => x.scope)).toEqual(['private'])
  })

  it('置顶记忆在 AI 连接时随说明下发，私有置顶只给自己', async () => {
    const a = await join('Alice')
    const b = await join('Bob')
    bridge.saveMemory({ title: '部署方式', content: '只部署到测试机', pinned: true })
    await call(a.c, 'memory_save', { scope: 'private', title: '我的待办', content: '先补测试', pinned: true })

    // 说明在握手时生成，所以要新开会话
    const a2 = await connect(a.agent.token)
    const b2 = await connect(b.agent.token)
    expect(a2.getInstructions()).toContain('只部署到测试机')
    expect(a2.getInstructions()).toContain('先补测试')
    expect(b2.getInstructions()).toContain('只部署到测试机')
    expect(b2.getInstructions()).not.toContain('先补测试')
  })

  it('更新时不能改范围，内容超长被拒', async () => {
    const a = await join('Alice')
    const m = await call(a.c, 'memory_save', { title: '约定', content: '用中文' })
    expect(code(await call(a.c, 'memory_save', { id: m.data.id, scope: 'private', title: '约定', content: '用中文' }))).toBe('INVALID_ARGS')
    expect(code(await call(a.c, 'memory_save', { title: '太长', content: 'x'.repeat(8001) }))).toBe('TOO_LARGE')
  })
})

﻿describe('任务：派活与审查', () => {
  it('AI 派活 → 执行者提交审查 → 派活者通过，每一步都通知到对方', async () => {
    const boss = await join('Boss', 'manager')
    const dev = await join('Dev', 'developer')
    const created = await call(boss.c, 'task_create', { title: '实现登录', assigneeId: 'Dev' })
    expect(created.data).toMatchObject({ ref: 'T-1', status: 'todo', assignee: 'Dev', reviewer: 'Boss' })

    const mine = await call(dev.c, 'task_list', { assignee: 'me' })
    expect(refs(mine)).toEqual(['T-1'])
    expect(mine.notices).toContain('给你派了任务 T-1')

    await call(dev.c, 'task_update', { task: 'T-1', status: 'in_progress' })
    expect((await call(dev.c, 'task_update', { task: 'T-1', status: 'review', result: '已实现，见 src/login.ts' })).data.status).toBe('review')

    const reviewed = await call(boss.c, 'task_review', { task: 'T-1', decision: 'accept', note: '可以' })
    expect(code(reviewed)).toBe('OK')
    expect(reviewed.notices).toContain('提交审查')
    expect(task('T-1').status).toBe('done')
    expect((await call(dev.c, 'whoami')).notices).toContain('通过了 T-1')
  })

  it('别的 AI 派来的任务，执行者不能跳过审查直接完成', async () => {
    const boss = await join('Boss', 'manager')
    const dev = await join('Dev', 'developer')
    await call(boss.c, 'task_create', { title: '实现登录', assigneeId: 'Dev' })
    expect(code(await call(dev.c, 'task_update', { task: 'T-1', status: 'done' }))).toBe('REVIEW_REQUIRED')
    expect(task('T-1').status).toBe('todo')
  })

  it('退回后回到进行中，执行者收到审查意见', async () => {
    const boss = await join('Boss', 'manager')
    const dev = await join('Dev', 'developer')
    await call(boss.c, 'task_create', { title: '实现登录', assigneeId: 'Dev' })
    await call(dev.c, 'task_update', { task: 'T-1', status: 'review', result: '做完了' })
    expect(code(await call(boss.c, 'task_review', { task: 'T-1', decision: 'reject', note: '缺少测试' }))).toBe('OK')

    expect(task('T-1').status).toBe('in_progress')
    const n = (await call(dev.c, 'whoami')).notices
    expect(n).toContain('退回了 T-1')
    expect(n).toContain('缺少测试')
  })

  it('谁都能给别人派活：不再需要管理职位；没有职位的 AI 也行', async () => {
    await join('Dev', 'developer')
    const tester = await join('Tester', 'tester')
    const plain = await join('Plain')
    expect((await call(tester.c, 'task_create', { title: '修 bug', assigneeId: 'Dev' })).data).toMatchObject({ assignee: 'Dev', reviewer: 'Tester' })
    expect((await call(plain.c, 'task_create', { title: '查日志', assigneeId: 'Dev' })).data).toMatchObject({ assignee: 'Dev', reviewer: 'Plain' })
    expect((await call(tester.c, 'task_create', { title: '修 bug' })).data).toMatchObject({ assignee: null, reviewer: null })
    expect((await call(tester.c, 'task_create', { title: '补用例', assigneeId: 'Tester' })).data).toMatchObject({ assignee: 'Tester', reviewer: null })
  })

  it('别的 AI 都能审查，只是不能审查自己的交付', async () => {
    const boss = await join('Boss', 'manager')
    const dev = await join('Dev', 'developer')
    const tester = await join('Tester', 'tester')
    await call(boss.c, 'task_create', { title: '实现登录', assigneeId: 'Dev' })
    await call(dev.c, 'task_update', { task: 'T-1', status: 'review', result: '做完了' })
    expect(code(await call(dev.c, 'task_review', { task: 'T-1', decision: 'accept' }))).toBe('FORBIDDEN')
    expect(task('T-1').status).toBe('review')
    // 不是派活的人也能审
    expect(code(await call(tester.c, 'task_review', { task: 'T-1', decision: 'accept' }))).toBe('OK')
    expect(task('T-1').status).toBe('done')
  })

  it('assignee=none 只列没人领的任务，认领后别人不能再领', async () => {
    const dev = await join('Dev', 'developer')
    const tester = await join('Tester', 'tester')
    bridge.createTask({ title: '整理文档' })
    bridge.createTask({ title: '已指派', assigneeId: dev.agent.id })

    expect(refs(await call(dev.c, 'task_list', { assignee: 'none' }))).toEqual(['T-1'])
    expect((await call(dev.c, 'task_claim', { task: 'T-1' })).data).toMatchObject({ status: 'in_progress', assignee: 'Dev' })
    expect(code(await call(tester.c, 'task_claim', { task: 'T-1' }))).toBe('ALREADY_ASSIGNED')
    expect(refs(await call(dev.c, 'task_list', { assignee: 'none' }))).toEqual([])
  })

  it('工作台派的任务不用用户审查：AI 设 done 直接完成', async () => {
    const dev = await join('Dev', 'developer')
    const t = bridge.createTask({ title: '整理 docs', assigneeId: dev.agent.id })
    expect(t.managedBy).toBe('user')

    const r = await call(dev.c, 'task_update', { task: t.ref, status: 'done', result: '只保留设计说明' })
    expect(code(r)).toBe('OK')
    expect(task(t.ref)).toMatchObject({ status: 'done', result: '只保留设计说明' })
  })

  it('工作台派的任务 AI 按老习惯提交审查：直接算完成，记录里写明', async () => {
    const dev = await join('Dev', 'developer')
    const t = bridge.createTask({ title: '整理 docs', assigneeId: dev.agent.id })
    const r = await call(dev.c, 'task_update', { task: t.ref, status: 'review', result: '只保留设计说明' })
    expect(code(r)).toBe('OK')
    expect(r.data.status).toBe('done')
    expect(task(t.ref).status).toBe('done')
    expect(task(t.ref).history.at(-1)?.action).toContain('用户的任务不用审查，直接完成')

    // 用户建的待认领任务，AI 认领后也是直接完成
    const open = bridge.createTask({ title: '清理日志' })
    await call(dev.c, 'task_claim', { task: open.ref })
    expect((await call(dev.c, 'task_update', { task: open.ref, status: 'review', result: '清完了' })).data.status).toBe('done')
  })

  it('旧数据里已经在等用户审查的任务：用户照常能通过或退回', async () => {
    const dev = await join('Dev', 'developer')
    const t = bridge.createTask({ title: '整理 docs', assigneeId: dev.agent.id })
    // 用户自己在工作台把状态拖到「待审查」（等同于升级前留下的任务）
    bridge.setTaskStatus(t.id, 'review')
    expect(task(t.ref).status).toBe('review')
    expect(bridge.reviewTask(t.id, 'reject', '再看看').status).toBe('in_progress')
    expect((await call(dev.c, 'whoami')).notices).toContain('退回了')
  })
})

describe('职位只是职责说明', () => {
  it('测试职位哪里都能写，move 也不拦', async () => {
    const tester = await join('Tester', 'tester')
    for (const p of ['tests/login.test.ts', 'src/x.ts', 'docs/a.md']) {
      expect(code(await call(tester.c, 'write_file', { path: p, content: 'ok\n' })), p).toBe('OK')
    }
    expect(code(await call(tester.c, 'move', { from: 'tests/login.test.ts', to: 'src/login.test.ts' }))).toBe('OK')
    expect(exists('src/x.ts') && exists('docs/a.md') && exists('src/login.test.ts')).toBe(true)
    expect(code(await call(tester.c, 'delete', { path: 'src/x.ts' }))).toBe('OK')
  })

  it('经理职位也能改文件、派活', async () => {
    const boss = await join('Boss', 'manager')
    expect(code(await call(boss.c, 'write_file', { path: 'src/new.ts', content: 'x\n' }))).toBe('OK')
    expect(code(await call(boss.c, 'read_file', { path: 'src/app.ts' }))).toBe('OK')
    expect(code(await call(boss.c, 'task_create', { title: '拆解需求' }))).toBe('OK')
    expect(exists('src/new.ts')).toBe(true)
  })

  it('职责随连接说明下发，whoami 显示职位；说明里不再有权限限制', async () => {
    const tester = await join('Tester', 'tester')
    const ins = tester.c.getInstructions() ?? ''
    expect(ins).toContain('职位：测试')
    expect(ins).toContain('职责：')
    expect(ins).not.toContain('只能修改')
    expect(ins).not.toContain('档位')
    const role = (await call(tester.c, 'whoami')).data.role
    expect(role.name).toBe('测试')
    expect(role).not.toHaveProperty('canManage')
  })

  it('换职位 / 改职责说明：会话不断开，留一条通知，工具和权限不变', async () => {
    const dev = await join('Dev', 'developer')
    expect(code(await call(dev.c, 'write_file', { path: 'src/a.ts', content: 'a\n' }))).toBe('OK')

    await bridge.updateAgent(dev.agent.id, { roleId: 'tester' })
    const who = await call(dev.c, 'whoami')
    expect(who.data.role.name).toBe('测试')
    expect(who.notices).toContain('职位换成了「测试」')
    expect(code(await call(dev.c, 'write_file', { path: 'src/b.ts', content: 'b\n' }))).toBe('OK')

    await bridge.saveRole({ id: 'tester', name: '测试', description: '只负责写用例' })
    const r = await call(dev.c, 'write_file', { path: 'qa/a.ts', content: 'a\n' })
    expect(code(r)).toBe('OK')
    expect(r.notices).toContain('修改了你的职位「测试」')
    // 重连拿到的连接说明是新的
    const c3 = await connect(dev.agent.token)
    expect(c3.getInstructions()).toContain('只负责写用例')

    await bridge.updateAgent(dev.agent.id, { roleId: '' })
    const none = await call(dev.c, 'whoami')
    expect(none.data.role).toBeNull()
    expect(none.notices).toContain('取消了你的职位')
  })

  it('提交审查必须写 result；自己建的任务没有审查人，task_review 提示直接设 done', async () => {
    const boss = await join('Boss', 'manager')
    const dev = await join('Dev', 'developer')
    await call(boss.c, 'task_create', { title: '实现登录', assigneeId: 'Dev' })
    const noResult = await call(dev.c, 'task_update', { task: 'T-1', status: 'review' })
    expect(code(noResult)).toBe('INVALID_ARGS')
    expect(noResult.data.message).toContain('result')
    expect(task('T-1').status).not.toBe('review')
    expect(code(await call(dev.c, 'task_update', { task: 'T-1', status: 'review', result: '做完了' }))).toBe('OK')

    await call(dev.c, 'task_create', { title: '自己的事' })
    await call(dev.c, 'task_claim', { task: 'T-2' })
    await call(dev.c, 'task_update', { task: 'T-2', status: 'review', result: '写好了' })
    const rev = await call(dev.c, 'task_review', { task: 'T-2', decision: 'accept' })
    expect(code(rev)).toBe('FORBIDDEN')
    expect(rev.data.message).toContain('直接用 task_update 把 status 设为 done')
    expect(code(await call(dev.c, 'task_update', { task: 'T-2', status: 'done' }))).toBe('OK')
  })
})

describe('吊销', () => {
  it('吊销执行者：未完成任务退回待认领，私有记忆删除，连接失效', async () => {
    const boss = await join('Boss', 'manager')
    const dev = await join('Dev', 'developer')
    await call(boss.c, 'task_create', { title: '实现登录', assigneeId: 'Dev' })
    // 自己建给自己的任务没有审查人，可以直接完成
    await call(dev.c, 'task_create', { title: '看代码', assigneeId: 'Dev' })
    expect(code(await call(dev.c, 'task_update', { task: 'T-2', status: 'done' }))).toBe('OK')
    await call(dev.c, 'memory_save', { title: '登录接口约定', content: 'POST /login' })
    await call(dev.c, 'memory_save', { scope: 'private', title: 'Dev 的草稿', content: '还没想好' })

    await bridge.removeAgent(dev.agent.id)

    expect(task('T-1')).toMatchObject({ assigneeId: undefined, status: 'todo' })
    expect(task('T-1').history.at(-1)?.action).toBe('unassigned')
    // 已完成的任务保留原样，记录是谁做的
    expect(task('T-2')).toMatchObject({ assigneeId: dev.agent.id, status: 'done' })
    expect(bridge.listMemories().map((m) => m.title)).toEqual(['登录接口约定'])

    await expect(dev.c.callTool({ name: 'whoami', arguments: {} })).rejects.toThrow()
    expect(refs(await call(boss.c, 'task_list', { assignee: 'none' }))).toEqual(['T-1'])
  })

  it('吊销派活者：它派出的任务归用户，执行者做完直接完成', async () => {
    const boss = await join('Boss', 'manager')
    const dev = await join('Dev', 'developer')
    await call(boss.c, 'task_create', { title: '实现登录', assigneeId: 'Dev' })
    expect(code(await call(dev.c, 'task_update', { task: 'T-1', status: 'done' }))).toBe('REVIEW_REQUIRED')

    await bridge.removeAgent(boss.agent.id)
    expect(task('T-1').managedBy).toBe('user')
    expect((await call(dev.c, 'task_get', { task: 'T-1' })).data.reviewer).toBe('用户')

    // 审查人换成用户后不用再审查
    expect(code(await call(dev.c, 'task_update', { task: 'T-1', status: 'done', result: '做完了' }))).toBe('OK')
    expect(task('T-1').status).toBe('done')
  })
})
