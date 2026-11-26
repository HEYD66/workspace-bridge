// 第 12 条接线（T-27）：任务范围提醒、交付附命令证据、待决定问题工具
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

async function join(name: string): Promise<{ agent: Agent; c: Client }> {
  const agent = bridge.createAgent(name)
  const c = new Client({ name: 'scope-wiring-test', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${agent.token}` } } }))
  clients.push(c)
  return { agent, c }
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const r = await c.callTool({ name, arguments: args })
  const blocks = (r.content as { type: string; text: string }[]).map((p) => p.text ?? '')
  let data: unknown = blocks[0]
  try {
    data = JSON.parse(blocks[0])
  } catch {
    // 纯文本
  }
  return { isError: Boolean(r.isError), data, blocks }
}

const all = (r: Result): string => r.blocks.join('\n')

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-t27-'))
  root = path.join(base, 'ws')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'user-skills') })
  await bridge.start()
  url = bridge.getState().mcpUrl
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  await bridge.stop()
  // run_command 的终端退出慢，Windows 上目录可能还被占着：多试几次，删不掉留给系统临时目录清理
  try {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch {
    // ignore
  }
})

describe('第 12 条接线：任务范围', () => {
  it('task_create 带 allowed_paths；执行者写到范围外只提醒、照常写入；范围内不提醒；清掉范围后不再提醒', async () => {
    const a = await join('Boss')
    const b = await join('Worker')
    const created = await call(a.c, 'task_create', { title: '改 src', assigneeId: 'Worker', allowed_paths: ['src/**'] })
    expect(created.isError).toBe(false)
    expect(created.data.allowedPaths).toEqual(['src/**'])
    const ref = created.data.ref as string
    expect((await call(b.c, 'task_update', { task: ref, status: 'in_progress' })).isError).toBe(false)

    const inside = await call(b.c, 'write_file', { path: 'src/a.ts', content: 'x' })
    expect(inside.isError).toBe(false)
    expect(all(inside)).not.toContain('【范围提醒】')

    const outside = await call(b.c, 'write_file', { path: 'README.md', content: 'y' })
    expect(outside.isError).toBe(false)
    expect(all(outside)).toContain('【范围提醒】')
    expect(all(outside)).toContain(ref)
    expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toBe('y')

    // 别人（没有进行中的任务）写同一个文件不检查
    const other = await call(a.c, 'write_file', { path: 'README.md', content: 'z' })
    expect(all(other)).not.toContain('【范围提醒】')

    // 派活的人清掉范围
    const cleared = await call(a.c, 'task_update', { task: ref, allowed_paths: [] })
    expect(cleared.isError).toBe(false)
    expect(cleared.data.allowedPaths).toBeUndefined()
    const after = await call(b.c, 'write_file', { path: 'README.md', content: 'w' })
    expect(all(after)).not.toContain('【范围提醒】')
  })

  it('没设范围的任务，task_get 不出 allowedPaths / questions 字段（老输出不变）', async () => {
    const a = await join('Boss')
    const t = await call(a.c, 'task_create', { title: '普通任务' })
    const got = await call(a.c, 'task_get', { task: t.data.ref })
    expect('allowedPaths' in got.data).toBe(false)
    expect('questions' in got.data).toBe(false)
  })

  it('越出工作区的 allowed_paths 报错', async () => {
    const a = await join('Boss')
    const r = await call(a.c, 'task_create', { title: 'x', allowed_paths: ['../outside/**'] })
    expect(r.isError).toBe(true)
  })
})

describe('第 12 条接线：待决定问题', () => {
  it('执行者提问、创建者回答；执行者不能回答；关闭后状态是 closed；task_get 带问题文本', async () => {
    const a = await join('Boss')
    const b = await join('Worker')
    const ref = (await call(a.c, 'task_create', { title: '要决定', assigneeId: 'Worker' })).data.ref as string

    const asked = await call(b.c, 'task_question', { task: ref, action: 'ask', text: '只提醒还是拦？', options: ['提醒', '拦'] })
    expect(asked.isError).toBe(false)
    expect(asked.data.question.id).toBe('q1')
    expect(asked.data.questions).toContain('只提醒还是拦？')

    // Boss 下一次调用会看到通知
    const seen = await call(a.c, 'whoami')
    expect(all(seen)).toContain('q1')

    const noQid = await call(a.c, 'task_question', { task: ref, action: 'answer', answer: '提醒' })
    expect(noQid.isError).toBe(true)

    const forbidden = await call(b.c, 'task_question', { task: ref, action: 'answer', question_id: 'q1', answer: '拦' })
    expect(forbidden.isError).toBe(true)

    const answered = await call(a.c, 'task_question', { task: ref, action: 'answer', question_id: 'q1', answer: '提醒' })
    expect(answered.isError).toBe(false)
    expect(answered.data.question.status).toBe('answered')

    const q2 = await call(b.c, 'task_question', { task: ref, action: 'ask', text: '另一个问题' })
    const closed = await call(b.c, 'task_question', { task: ref, action: 'close', question_id: q2.data.question.id, note: '不用了' })
    expect(closed.data.question.status).toBe('closed')

    const got = await call(a.c, 'task_get', { task: ref })
    expect(got.data.questions).toContain('提醒')
  })

  it('用户在工作台回答和关闭问题（bridge 方法）', async () => {
    const a = await join('Boss')
    const ref = (await call(a.c, 'task_create', { title: '问用户' })).data.ref as string
    const q = (await call(a.c, 'task_question', { task: ref, action: 'ask', text: '要不要拦？' })).data.question
    const t = bridge.answerTaskQuestion(ref, q.id, '先提醒')
    expect(t.questions?.[0].status).toBe('answered')
    expect(t.questions?.[0].answeredBy).toBe('user')
    const q2 = (await call(a.c, 'task_question', { task: ref, action: 'ask', text: '第二个' })).data.question
    expect(bridge.closeTaskQuestion(ref, q2.id, '算了').questions?.[1].status).toBe('closed')
  })
})

describe('第 12 条接线：交付附命令证据', () => {
  it('attach_commands=true 把任务期间的命令和输出附在 result 后面，令牌脱敏；不传不附', async () => {
    const a = await join('Boss')
    const b = await join('Worker')
    const ref = (await call(a.c, 'task_create', { title: '跑命令', assigneeId: 'Worker' })).data.ref as string
    await call(b.c, 'task_update', { task: ref, status: 'in_progress' })
    const ran = await call(b.c, 'run_command', { command: `echo evidence-marker ${b.agent.token}`, timeout_ms: 30000 })
    expect(ran.isError).toBe(false)

    const plain = await call(b.c, 'task_update', { task: ref, status: 'blocked', result: '卡住了' })
    expect(plain.data.result).toBe('卡住了')

    const r = await call(b.c, 'task_update', { task: ref, status: 'review', result: '做完了', attach_commands: true })
    expect(r.isError).toBe(false)
    const result = r.data.result as string
    expect(result.startsWith('做完了')).toBe(true)
    expect(result).toContain('【命令证据】')
    expect(result).toContain('evidence-marker')
    expect(result).not.toContain(b.agent.token)
  })

  it('没有命令记录时写明没有', async () => {
    const a = await join('Boss')
    const b = await join('Worker')
    const ref = (await call(a.c, 'task_create', { title: '不跑命令', assigneeId: 'Worker' })).data.ref as string
    const r = await call(b.c, 'task_update', { task: ref, status: 'review', result: '只改了文档', attach_commands: 3 })
    expect(r.data.result).toContain('没有 run_command 记录')
  })
})
