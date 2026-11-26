// 记忆第一批：搜索按对上多少排序（不再要求每个词都有、中文按两个字切）、全局和个人两层跨项目的记忆、
// 记忆挂在任务上、认领任务时自动带回相关记忆、交付时顺手留结论
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { MemoryStore, searchTokens, type Actor } from '../src/core/memory'

const ALICE: Actor = { id: 'a', name: 'Alice', kind: 'agent' }
const BOB: Actor = { id: 'b', name: 'Bob', kind: 'agent' }

describe('搜索', () => {
  let dir: string
  let store: MemoryStore
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mem-'))
    store = new MemoryStore(path.join(dir, 'memory.json'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))

  it('searchTokens：空格分开的是词；连着写的中文再按两个字一段切', () => {
    expect(searchTokens('部署约定 npm')).toEqual({ words: ['部署约定', 'npm'], grams: ['部署', '署约', '约定'] })
    expect(searchTokens('登录')).toEqual({ words: ['登录'], grams: [] })
    expect(searchTokens('  NPM   Test npm ')).toEqual({ words: ['npm', 'test'], grams: [] })
    expect(searchTokens('')).toEqual({ words: [], grams: [] })
    // 带「的、了、和」这类字的小段不要
    expect(searchTokens('做登录页的表单校验').grams).toEqual(['做登', '登录', '录页', '表单', '单校', '校验'])
  })

  it('不要求每个词都出现：全对上的在最前，对上一部分的在后面，一个都没对上的不要', () => {
    const both = store.save(ALICE, { title: '部署约定', content: '用 npm run deploy，先跑测试' })
    const one = store.save(ALICE, { title: '代码风格', content: '缩进两格，npm 脚本名用短横线' })
    store.save(ALICE, { title: '无关的', content: '午饭吃什么' })
    const hits = store.rank(ALICE, { query: '部署约定 npm' })
    expect(hits.map((h) => h.m.id)).toEqual([both.id, one.id])
    expect(hits[0].words).toBe(2)
    expect(hits[1].words).toBe(1)
    expect(store.search(ALICE, { query: '完全没有的词' })).toEqual([])
  })

  it('换个说法也能找到：「部署方式」能对上标题是「部署约定」的；标题里对上比正文里对上靠前', () => {
    const title = store.save(ALICE, { title: '部署约定', content: '见 README' })
    const body = store.save(ALICE, { title: '杂项', content: '上线前要先部署到测试环境' })
    expect(store.search(ALICE, { query: '部署方式' }).map((m) => m.id)).toEqual([title.id, body.id])
  })

  it('不给搜索词返回全部；task 只要挂在那条任务上的；私有的别人看不到', () => {
    const t = store.save(ALICE, { title: '登录页的坑', content: 'x', taskRef: 'T-3' })
    store.save(ALICE, { title: '别的', content: 'y' })
    store.save(ALICE, { scope: 'private', title: 'Alice 的笔记', content: 'z', taskRef: 'T-3' })
    expect(store.search(ALICE, {})).toHaveLength(3)
    expect(store.search(BOB, {})).toHaveLength(2)
    expect(store.search(BOB, { task: 't-3' }).map((m) => m.id)).toEqual([t.id])
    expect(store.search(ALICE, { task: 'T-3' })).toHaveLength(2)
  })

  it('挂任务和来源：新建时存下；更新时不传就不动，传空串摘掉任务；来源最多 200 字', () => {
    const m = store.save(ALICE, { title: 'a', content: 'b', taskRef: ' T-7 ', source: 's'.repeat(300) })
    expect(m.taskRef).toBe('T-7')
    expect(m.source).toHaveLength(200)
    const kept = store.save(ALICE, { id: m.id, title: 'a2', content: 'b' })
    expect(kept.taskRef).toBe('T-7')
    const off = store.save(ALICE, { id: m.id, title: 'a2', content: 'b', taskRef: '' })
    expect(off.taskRef).toBeUndefined()
    expect(off.source).toHaveLength(200)
  })

  it('related：挂在这条任务上的排最前，再按标题和说明对上多少；只对上一点零碎的不算', () => {
    const onTask = store.save(ALICE, { title: '上次的结论', content: '表单校验放在提交时', taskRef: 'T-1' })
    const similar = store.save(ALICE, { title: '登录页约定', content: '按钮在右下' })
    store.save(ALICE, { title: '数据库备份', content: '登这个字只在正文里出现一次：登录' })
    store.save(ALICE, { title: '无关', content: '午饭' })
    const r = store.related(BOB, '做登录页的表单校验', { taskRef: 'T-1' })
    expect(r.map((x) => [x.m.id, x.why])).toEqual([
      [onTask.id, 'task'],
      [similar.id, 'match']
    ])
    expect(store.related(BOB, '', {})).toEqual([])
    expect(store.related(BOB, '做登录页的表单校验', { limit: 1 })).toHaveLength(1)
  })

  it('idPrefix：全局记忆库的 id 以 mg_ 开头，普通的以 m_ 开头', () => {
    const g = new MemoryStore(path.join(dir, 'g.json'), undefined, { idPrefix: 'mg_' })
    expect(g.save(ALICE, { title: 'x', content: 'y' }).id).toMatch(/^mg_[0-9a-f]{10}$/)
    expect(store.save(ALICE, { title: 'x', content: 'y' }).id).toMatch(/^m_[0-9a-f]{10}$/)
  })
})

describe('MCP：全局、个人、挂任务、认领时带回', () => {
  let base: string
  let bridge: Bridge
  const clients: Client[] = []

  async function connect(token: string): Promise<Client> {
    const c = new Client({ name: 'mem-test', version: '1.0.0' })
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
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-meml-'))
    for (const d of ['alpha', 'beta']) fs.mkdirSync(path.join(base, d), { recursive: true })
    bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoots: [path.join(base, 'alpha'), path.join(base, 'beta')], port: 0, userSkillsDir: path.join(base, 'user-skills') })
    await bridge.start()
  })
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.stop()
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
  })

  it('全局记忆：在一个项目里写，另一个项目里搜得到、读得到，新连接的开场说明里也有；项目里的共享记忆不跨项目', async () => {
    const alice = bridge.createAgent('Alice')
    const bob = bridge.createAgent('Bob')
    const a = await connect(alice.token)
    const g = await call(a, 'memory_save', { workspace: 'alpha', scope: 'global', title: '用户的习惯', content: '回答用中文，先说结论', source: '用户在大厅里说的' })
    expect(g.isError).toBe(false)
    expect(g.data.id).toMatch(/^mg_/)
    expect(g.data.scope).toBe('global')
    expect(g.data.source).toBe('用户在大厅里说的')
    const local = await call(a, 'memory_save', { workspace: 'alpha', title: 'alpha 的约定', content: '只在 alpha 里' })
    expect(local.data.scope).toBe('shared')

    const b = await connect(bob.token)
    expect(b.getInstructions()).toContain('## 全局记忆')
    expect(b.getInstructions()).toContain('### 用户的习惯\n回答用中文，先说结论')
    const fromBeta = await call(b, 'memory_search', { workspace: 'beta' })
    expect(fromBeta.data.map((m: { title: string }) => m.title)).toEqual(['用户的习惯'])
    expect((await call(b, 'memory_read', { workspace: 'beta', id: g.data.id })).data.content).toBe('回答用中文，先说结论')
    expect((await call(b, 'memory_search', { workspace: 'alpha', scope: 'global' })).data).toHaveLength(1)
    expect((await call(b, 'memory_search', { workspace: 'alpha', scope: 'shared' })).data.map((m: { title: string }) => m.title)).toEqual(['alpha 的约定'])
    // 别的 AI 也能改全局记忆；改完版本号加一
    const upd = await call(b, 'memory_save', { workspace: 'beta', id: g.data.id, title: '用户的习惯', content: '回答用中文，先说结论，少废话', expected_version: 1 })
    expect(upd.data.version).toBe(2)
    expect(upd.data.scope).toBe('global')
    // 已有的记忆不能换范围；全局记忆不能挂任务
    expect((await call(b, 'memory_save', { workspace: 'beta', id: g.data.id, scope: 'shared', title: 'x', content: 'y' })).data.error).toBe('INVALID_ARGS')
    expect((await call(b, 'memory_save', { workspace: 'beta', scope: 'global', title: 'x', content: 'y', task: 'T-1' })).data.error).toBe('INVALID_ARGS')
    // 工作台这边：全局的排在前面，能删
    expect(bridge.listMemories().map((m) => m.title)).toContain('用户的习惯')
    bridge.deleteMemory(g.data.id)
    expect((await call(b, 'memory_read', { workspace: 'beta', id: g.data.id })).data.error).toBe('NOT_FOUND')
  })

  it('个人记忆：只有自己看得到，换项目也带着；吊销这个 AI 时一起清掉', async () => {
    const alice = bridge.createAgent('Alice')
    const bob = bridge.createAgent('Bob')
    const a = await connect(alice.token)
    const b = await connect(bob.token)
    const p = await call(a, 'memory_save', { workspace: 'alpha', scope: 'personal', title: 'Alice 的待命笔记', content: '我的客户端在 ~/wb' })
    expect(p.data.scope).toBe('personal')
    expect(p.data.id).toMatch(/^mg_/)
    expect((await call(a, 'memory_search', { workspace: 'beta', query: '待命' })).data.map((m: { id: string }) => m.id)).toEqual([p.data.id])
    expect((await call(b, 'memory_search', { workspace: 'beta', query: '待命' })).data).toEqual([])
    expect((await call(b, 'memory_read', { workspace: 'alpha', id: p.data.id })).data.error).toBe('NOT_FOUND')
    expect((await call(a, 'memory_search', { workspace: 'beta', scope: 'personal' })).data).toHaveLength(1)
    // 个人记忆不进别人的开场说明；自己置顶的进自己的
    await call(a, 'memory_save', { workspace: 'alpha', id: p.data.id, title: 'Alice 的待命笔记', content: '我的客户端在 ~/wb', pinned: true })
    const a2 = await connect(alice.token)
    const b2 = await connect(bob.token)
    expect(a2.getInstructions()).toContain('### Alice 的待命笔记（个人）')
    expect(b2.getInstructions()).not.toContain('Alice 的待命笔记')
    await bridge.removeAgent(alice.id)
    expect(bridge.globalMemory.all()).toEqual([])
  })

  it('全局记忆太多时开场说明只放得下一部分，剩下的报个数', async () => {
    const alice = bridge.createAgent('Alice')
    const a = await connect(alice.token)
    for (let i = 0; i < 5; i++) await call(a, 'memory_save', { workspace: 'alpha', scope: 'global', title: `规范 ${i}`, content: '字'.repeat(500) })
    const ins = (await connect(alice.token)).getInstructions() ?? ''
    const sec = ins.split('## 全局记忆')[1].split('\n## ')[0]
    expect(sec).toContain('### 规范 4')
    expect(sec).toContain('### 规范 3')
    expect(sec).not.toContain('### 规范 1\n')
    expect(sec).toMatch(/还有 \d 条，用 memory_search scope=global 查看/)
    expect(sec.length).toBeLessThan(1800)
  })

  it('记忆挂在任务上；认领时自动带回：挂在这条任务上的、内容相关的；无关的不带', async () => {
    const alice = bridge.createAgent('Alice')
    const bob = bridge.createAgent('Bob')
    const a = await connect(alice.token)
    const b = await connect(bob.token)
    const t = await call(a, 'task_create', { workspace: 'alpha', title: '做登录页的表单校验', description: '邮箱和密码都要校验' })
    expect(t.isError).toBe(false)
    const ref = t.data.ref as string
    const onTask = await call(a, 'memory_save', { workspace: 'alpha', title: '上次试过的做法', content: '校验放在提交时，不要每敲一个字就校验', task: ref.toLowerCase() })
    expect(onTask.data.task).toBe(ref)
    const similar = await call(a, 'memory_save', { workspace: 'alpha', title: '登录页约定', content: '按钮在右下，错误提示用红字' })
    await call(a, 'memory_save', { workspace: 'alpha', title: '数据库备份', content: '每天凌晨三点' })
    await call(a, 'memory_save', { workspace: 'alpha', scope: 'global', title: '表单校验的通用规范', content: '错误提示写清楚哪里不对' })
    expect((await call(a, 'memory_save', { workspace: 'alpha', title: 'x', content: 'y', task: 'T-999' })).isError).toBe(true)
    expect((await call(b, 'memory_search', { workspace: 'alpha', task: ref })).data.map((m: { id: string }) => m.id)).toEqual([onTask.data.id])

    const claimed = await call(b, 'task_claim', { workspace: 'alpha', task: ref })
    expect(claimed.isError).toBe(false)
    const rel = claimed.data.related_memories as { id: string; why: string; scope: string; snippet: string; title: string }[]
    expect(rel[0]).toMatchObject({ id: onTask.data.id, why: '挂在这条任务上', scope: 'shared' })
    expect(rel.map((r) => r.title)).toContain('登录页约定')
    expect(rel.map((r) => r.title)).toContain('表单校验的通用规范')
    expect(rel.map((r) => r.title)).not.toContain('数据库备份')
    expect(rel.find((r) => r.id === similar.data.id)?.why).toBe('内容相关')
    expect(rel.find((r) => r.title === '表单校验的通用规范')?.scope).toBe('global')
    expect(claimed.data.related_memories_hint).toContain('memory_read')
  })

  it('没有相关记忆时，认领的返回里不带这一项', async () => {
    const alice = bridge.createAgent('Alice')
    const a = await connect(alice.token)
    const t = await call(a, 'task_create', { workspace: 'alpha', title: '整理文档' })
    const claimed = await call(a, 'task_claim', { workspace: 'alpha', task: t.data.ref })
    expect(claimed.isError).toBe(false)
    expect(claimed.data).not.toHaveProperty('related_memories')
  })

  it('交付时填了 lesson：存成一条挂在这个任务上的共享记忆；不填就不存', async () => {
    const alice = bridge.createAgent('Alice')
    const bob = bridge.createAgent('Bob')
    const a = await connect(alice.token)
    const b = await connect(bob.token)
    const t = await call(a, 'task_create', { workspace: 'alpha', title: '做登录页', assigneeId: 'Bob' })
    const ref = t.data.ref as string
    const plain = await call(b, 'task_update', { workspace: 'alpha', task: ref, status: 'in_progress' })
    expect(plain.data).not.toHaveProperty('lesson_memory')
    expect(bridge.openWorkspace(bridge.getState().workspaces[0].id)?.memory.all()).toEqual([])
    const done = await call(b, 'task_update', { workspace: 'alpha', task: ref, status: 'review', result: '做完了，表单在 src/login.tsx', lesson: '  这个项目的表单统一在提交时校验  ' })
    expect(done.isError).toBe(false)
    const id = done.data.lesson_memory as string
    const m = (await call(a, 'memory_read', { workspace: 'alpha', id })).data
    expect(m).toMatchObject({ scope: 'shared', task: ref, title: `${ref} 的结论：做登录页`, content: '这个项目的表单统一在提交时校验', tags: ['任务结论'], source: `任务 ${ref} 交付时写的` })
    // 以后谁认领相关的任务都会带回它
    const t2 = await call(a, 'task_create', { workspace: 'alpha', title: '注册页的表单校验' })
    const again = await call(a, 'task_claim', { workspace: 'alpha', task: t2.data.ref })
    expect((again.data.related_memories as { id: string }[]).map((r) => r.id)).toContain(id)
  })
})
