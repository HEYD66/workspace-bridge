// 留痕：从检查点整理「任务编号 → 谁改了哪些文件」；AI 用的 change_trail 工具
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { buildTrail, trailMarkdown, type TrailStep } from '../src/shared/changeTrail'

const step = (ts: number, agentName: string, task: string | null, files: (string | { path: string; rolledBackBy?: string })[], kind: 'edit' | 'rollback' = 'edit'): TrailStep => ({
  ts,
  agentName,
  task,
  kind,
  files: files.map((f) => (typeof f === 'string' ? { path: f } : f))
})

describe('buildTrail', () => {
  it('一条任务一项：谁改了哪些文件、各几次；最近动过的任务在前，没挂任务的在最后', () => {
    const trail = buildTrail(
      [
        step(100, 'Alice', 'T-1', ['src/a.ts', 'src/b.ts']),
        step(200, 'Bob', 'T-1', ['src/b.ts']),
        step(300, 'Alice', null, ['notes.md']),
        step(400, 'Bob', 't-2', ['src/c.ts']),
        step(500, 'Alice', 'T-1', ['src/a.ts'])
      ],
      new Map([
        ['T-1', { title: '修登录页', status: 'done' }],
        ['T-2', { title: '加搜索' }]
      ])
    )
    expect(trail.map((e) => e.task)).toEqual(['T-1', 'T-2', null])
    const t1 = trail[0]
    expect(t1).toMatchObject({ title: '修登录页', status: 'done', firstTs: 100, lastTs: 500 })
    expect(t1.agents).toEqual([
      { name: 'Alice', edits: 2, files: 2 },
      { name: 'Bob', edits: 1, files: 1 }
    ])
    expect(t1.files).toEqual([
      { path: 'src/a.ts', by: ['Alice'], edits: 2, lastTs: 500 },
      { path: 'src/b.ts', by: ['Alice', 'Bob'], edits: 2, lastTs: 200 }
    ])
    // 编号大小写不论，统一成大写；没有状态就不带
    expect(trail[1]).toMatchObject({ task: 'T-2', title: '加搜索' })
    expect(trail[1].status).toBeUndefined()
    expect(trail[2]).toMatchObject({ task: null, agents: [{ name: 'Alice', edits: 1, files: 1 }] })
    expect(trail[2].title).toBeUndefined()
  })

  it('回滚那一步不算改动；被撤销的改动还列着，一个文件的改动全被撤销了才标「已撤销」', () => {
    const trail = buildTrail([
      step(100, 'Alice', 'T-1', [{ path: 'a.ts', rolledBackBy: 'cp-3' }, 'b.ts']),
      step(200, 'Alice', 'T-1', [{ path: 'b.ts', rolledBackBy: 'cp-3' }]),
      step(300, 'Alice', 'T-1', ['a.ts', 'b.ts'], 'rollback')
    ])
    expect(trail).toHaveLength(1)
    expect(trail[0].lastTs).toBe(200)
    expect(trail[0].files).toEqual([
      { path: 'a.ts', by: ['Alice'], edits: 1, lastTs: 100, undone: true },
      { path: 'b.ts', by: ['Alice'], edits: 2, lastTs: 200 }
    ])
  })

  it('没有改动、任务不在清单里（已经删了）都不出错', () => {
    expect(buildTrail([])).toEqual([])
    expect(buildTrail([step(1, 'A', 'T-9', ['x'])], new Map())[0]).toMatchObject({ task: 'T-9' })
  })
})

describe('trailMarkdown', () => {
  it('每条任务一节，标题是「编号 + 做什么」，下面是谁改了哪些文件；文件太多只列前面的并报个数', () => {
    const md = trailMarkdown(
      buildTrail(
        [step(Date.UTC(2026, 10, 15, 3, 0), 'Alice', 'T-1', ['a.ts', 'b.ts', 'c.ts']), step(Date.UTC(2026, 10, 15, 4, 0), 'Bob', 'T-1', ['a.ts']), step(Date.UTC(2026, 10, 15, 5, 0), 'Bob', null, ['z.md'])],
        new Map([['T-1', { title: '修登录页', status: 'review' }]])
      ),
      { heading: 'alpha 改动留痕', maxFiles: 2 }
    )
    expect(md.startsWith('# alpha 改动留痕\n')).toBe(true)
    expect(md).toContain('## T-1 修登录页（review）')
    expect(md).toContain('- 谁改的：Alice（1 次，3 个文件）、Bob（1 次，1 个文件）')
    expect(md).toContain('  - `a.ts` — Alice、Bob，2 次')
    expect(md).toContain('  - `b.ts` — Alice')
    expect(md).not.toContain('`c.ts`')
    expect(md).toContain('  - （还有 1 个）')
    expect(md).toContain('## 没挂任务的改动')
    expect(md.indexOf('## T-1')).toBeLessThan(md.indexOf('## 没挂任务的改动'))
  })

  it('没有记录时说一句', () => {
    expect(trailMarkdown([])).toContain('还没有改动记录。')
  })
})

describe('change_trail 工具', () => {
  let base: string
  let bridge: Bridge
  const clients: Client[] = []

  async function connect(token: string): Promise<Client> {
    const c = new Client({ name: 'trail-test', version: '1' })
    await c.connect(new StreamableHTTPClientTransport(new URL(bridge.getState().mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    clients.push(c)
    return c
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; data: any }> {
    const r = await c.callTool({ name, arguments: args })
    const body = (r.content as { type: string; text: string }[]).map((p) => p.text).find((t) => !t.startsWith('【通知】')) ?? ''
    let data: unknown = body
    try {
      data = JSON.parse(body)
    } catch {
      // 不是 JSON 就留原文
    }
    return { isError: Boolean(r.isError), data }
  }

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-trail-'))
    fs.mkdirSync(path.join(base, 'alpha'), { recursive: true })
    bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoots: [path.join(base, 'alpha')], port: 0, userSkillsDir: path.join(base, 'user-skills') })
    await bridge.start()
  })
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.stop()
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
  })

  it('两个 AI 各在自己的任务里改文件：清单按任务分开，写着谁改了什么；任务外的改动单列；能只看一条任务、能出文字版', async () => {
    const alice = bridge.createAgent('Alice')
    const bob = bridge.createAgent('Bob')
    const a = await connect(alice.token)
    const b = await connect(bob.token)

    // 任务外的改动
    expect((await call(a, 'write_file', { path: 'README.md', content: 'hi\n' })).isError).toBe(false)
    const t1 = (await call(a, 'task_create', { title: '修登录页' })).data.ref as string
    expect((await call(a, 'task_claim', { task: t1 })).isError).toBe(false)
    expect((await call(a, 'write_file', { path: 'src/login.ts', content: 'export const a = 1\n' })).isError).toBe(false)
    expect((await call(a, 'write_file', { path: 'src/form.ts', content: 'export const f = 1\n' })).isError).toBe(false)
    const t2 = (await call(b, 'task_create', { title: '加搜索' })).data.ref as string
    expect((await call(b, 'task_claim', { task: t2 })).isError).toBe(false)
    expect((await call(b, 'write_file', { path: 'src/search.ts', content: 'export const s = 1\n' })).isError).toBe(false)

    // 谁来查都是全员的清单
    const all = await call(b, 'change_trail')
    expect(all.isError).toBe(false)
    const entries = all.data.entries as { task: string | null; title?: string; agents: { name: string }[]; files: { path: string; by: string[] }[] }[]
    expect(entries.map((e) => e.task)).toEqual([t2, t1, null])
    expect(entries[0]).toMatchObject({ title: '加搜索', agents: [{ name: 'Bob' }] })
    expect(entries[0].files.map((f) => f.path)).toEqual(['src/search.ts'])
    expect(entries[1]).toMatchObject({ title: '修登录页', agents: [{ name: 'Alice' }] })
    expect(entries[1].files.map((f) => f.path)).toEqual(['src/form.ts', 'src/login.ts'])
    expect(entries[2].files).toEqual([expect.objectContaining({ path: 'README.md', by: ['Alice'] })])

    const one = await call(a, 'change_trail', { task: t1.toLowerCase() })
    expect(one.data.entries.map((e: { task: string }) => e.task)).toEqual([t1])

    const md = (await call(a, 'change_trail', { format: 'markdown' })).data.markdown as string
    expect(md).toContain(`## ${t1} 修登录页`)
    expect(md).toContain('`src/login.ts` — Alice')
    expect(md).toContain('## 没挂任务的改动')
  })

  it('还没有任何改动时返回空清单；开场说明里讲了不用在代码里做标记', async () => {
    const alice = bridge.createAgent('Alice')
    const a = await connect(alice.token)
    expect((await call(a, 'change_trail')).data).toEqual({ entries: [] })
    expect(a.getInstructions()).toContain('change_trail')
  })
})
