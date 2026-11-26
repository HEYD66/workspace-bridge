// 记忆第二批：版本历史、最后使用时间和自动归档、新建时提示相似的、开场说明里按热度排、来源自动填
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { byPriority, MEMORY_ARCHIVE_DAYS, MEMORY_HISTORY_MAX, memoryHeat, memorySimilarity, MemoryStore, SIMILAR_THRESHOLD, type Actor } from '../src/core/memory'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Bridge } from '../src/core/bridge'
import type { MemoryItem } from '../src/core/types'

const DAY = 24 * 3600_000
const alice: Actor = { id: 'a1', name: 'Alice', kind: 'agent' }
const bob: Actor = { id: 'b1', name: 'Bob', kind: 'agent' }
const user: Actor = { id: 'user', name: '用户', kind: 'user' }

const dirs: string[] = []
function store(): MemoryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mem2-'))
  dirs.push(dir)
  return new MemoryStore(path.join(dir, 'memory.json'))
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** 直接改存盘的时间，装作是很久以前的记忆 */
function age(s: MemoryStore, id: string, patch: Partial<MemoryItem>): void {
  const file = (s as unknown as { store: { file: string; data: { items: MemoryItem[] } } }).store
  Object.assign(file.data.items.find((m) => m.id === id)!, patch)
}
/** 装作这个库很早就开始记「用没用到」了（不然刚打开的库 60 天内什么都不归档） */
function trackedSince(s: MemoryStore, ts: number | undefined): void {
  const file = (s as unknown as { store: { data: { trackedSince?: number } } }).store
  if (ts === undefined) delete file.data.trackedSince
  else file.data.trackedSince = ts
}
const trackedOf = (s: MemoryStore): number | undefined => (s as unknown as { store: { data: { trackedSince?: number } } }).store.data.trackedSince

describe('记忆第二批：版本历史', () => {
  it('内容变了记一版，只改置顶不记；能看、能恢复，恢复也算一次新修改', () => {
    const s = store()
    const m = s.save(alice, { title: '部署约定', content: '第一版', tags: ['a'] })
    s.save(bob, { id: m.id, title: '部署约定', content: '第二版', tags: ['a'] })
    s.save(user, { id: m.id, title: '部署约定', content: '第二版', tags: ['a'], pinned: true })
    const now = s.get(alice, m.id)
    expect(now.version).toBe(3)
    expect(now.history?.map((r) => [r.version, r.content, r.updatedByName])).toEqual([[1, '第一版', 'Alice']])
    expect(s.history(bob, m.id)[0].version).toBe(1)

    const back = s.restore(bob, m.id, 1)
    expect(back.content).toBe('第一版')
    expect(back.version).toBe(4)
    expect(back.pinned).toBe(true)
    // 恢复之前的那一版（第二版，Bob 写的）也留下了
    expect(back.history?.map((r) => [r.version, r.content, r.updatedByName])).toEqual([
      [1, '第一版', 'Alice'],
      [3, '第二版', '用户']
    ])
    expect(() => s.restore(bob, m.id, 2)).toThrow(/没有第 2 版/)
  })

  it('最多留 MEMORY_HISTORY_MAX 版，旧的先丢；别人的私有记忆恢复不了', () => {
    const s = store()
    const m = s.save(alice, { scope: 'private', title: 't', content: 'v1' })
    for (let i = 2; i <= MEMORY_HISTORY_MAX + 4; i++) s.save(alice, { id: m.id, title: 't', content: `v${i}` })
    const h = s.get(alice, m.id).history!
    expect(h).toHaveLength(MEMORY_HISTORY_MAX)
    expect(h[0].content).toBe('v4')
    expect(h.at(-1)?.content).toBe(`v${MEMORY_HISTORY_MAX + 3}`)
    expect(() => s.restore(bob, m.id, 5)).toThrow(/不存在或你无权/)
  })
})

describe('记忆第二批：最后使用时间和归档', () => {
  it('touch 记时间和次数，10 分钟内只算一次，不动版本和更新时间', () => {
    const s = store()
    const m = s.save(alice, { title: 't', content: 'c' })
    const t0 = m.updatedAt + 1000
    expect(s.touch([m.id], t0)).toBe(1)
    expect(s.touch([m.id], t0 + 60_000)).toBe(0)
    expect(s.touch([m.id, 'm_nope'], t0 + 11 * 60_000)).toBe(1)
    const now = s.get(alice, m.id)
    expect([now.useCount, now.lastUsedAt, now.version, now.updatedAt]).toEqual([2, t0 + 11 * 60_000, 1, m.updatedAt])
  })

  it('长期没人用也没人改的自动归档；置顶的、最近用过的、keep 说留的不动', () => {
    const s = store()
    const old = s.save(alice, { title: '旧的没人用', content: 'c' })
    const used = s.save(alice, { title: '旧的但最近用过', content: 'c' })
    const pinned = s.save(user, { title: '旧的但置顶', content: 'c', pinned: true })
    const kept = s.save(alice, { title: '旧的但说了要留', content: 'c' })
    const fresh = s.save(alice, { title: '新的', content: 'c' })
    const now = Date.now()
    const longAgo = now - (MEMORY_ARCHIVE_DAYS + 5) * DAY
    for (const m of [old, used, pinned, kept]) age(s, m.id, { createdAt: longAgo, updatedAt: longAgo })
    age(s, used.id, { lastUsedAt: now - 3 * DAY, useCount: 1 })
    trackedSince(s, longAgo)

    expect(s.sweep({ now, keep: (m) => m.id === kept.id })).toBe(1)
    expect(s.all().filter((m) => m.archivedAt).map((m) => m.id)).toEqual([old.id])
    // 一小时内不重复查
    age(s, kept.id, { updatedAt: longAgo })
    expect(s.sweep({ now: now + 60_000 })).toBe(0)
    expect(s.sweep({ now: now + 60_000, force: true })).toBe(1)
    expect(s.get(alice, fresh.id).archivedAt).toBeUndefined()
  })

  it('归档的：列全部时不出，带词搜索时排最后；不主动带给任务；读到、改到就回来', () => {
    const s = store()
    const a = s.save(alice, { title: '部署流程', content: '先构建再发布' })
    const b = s.save(alice, { title: '部署流程补充', content: '发布前要通知' })
    s.setArchived(user, a.id, true)
    expect(s.search(alice, {}).map((m) => m.id)).toEqual([b.id])
    expect(s.search(alice, { query: '部署流程' }).map((m) => m.id)).toEqual([b.id, a.id])
    expect(s.search(alice, { archived: true }).map((m) => m.id).sort()).toEqual([a.id, b.id].sort())
    expect(s.related(alice, '部署流程 怎么走').map((x) => x.m.id)).toEqual([b.id])
    expect(() => s.setArchived(alice, b.id, true)).toThrow(/只能由用户/)

    // 用户手动归档的：AI 读到、改到、搜到都不回来，只有用户点「取消归档」
    expect(s.get(alice, a.id).archivedBy).toBe('user')
    s.touch([a.id])
    expect(s.get(alice, a.id).archivedAt).toBeGreaterThan(0)
    expect(s.get(alice, a.id).useCount).toBe(1)
    s.save(bob, { id: a.id, title: '部署流程', content: '改过了' })
    expect(s.get(alice, a.id).archivedAt).toBeGreaterThan(0)
    const back = s.setArchived(user, a.id, false)
    expect([back.archivedAt, back.archivedBy]).toEqual([undefined, undefined])
  })

  it('自动归档的：只是搜索时沾了边不回来也不算用到；真的读到、改到才回来', () => {
    const s = store()
    const a = s.save(alice, { title: '部署流程', content: '先构建再发布' })
    const b = s.save(alice, { title: '发布说明', content: '写给用户看' })
    const longAgo = Date.now() - (MEMORY_ARCHIVE_DAYS + 5) * DAY
    for (const m of [a, b]) age(s, m.id, { createdAt: longAgo, updatedAt: longAgo })
    trackedSince(s, longAgo)
    expect(s.sweep({ force: true })).toBe(2)
    expect(s.get(alice, a.id).archivedBy).toBeUndefined()

    expect(s.touch([a.id], Date.now(), { revive: false })).toBe(0)
    expect([s.get(alice, a.id).archivedAt !== undefined, s.get(alice, a.id).useCount]).toEqual([true, undefined])
    expect(s.touch([a.id])).toBe(1)
    expect([s.get(alice, a.id).archivedAt, s.get(alice, a.id).useCount]).toEqual([undefined, 1])
    s.save(bob, { id: b.id, title: '发布说明', content: '改过了' })
    expect(s.get(alice, b.id).archivedAt).toBeUndefined()
  })

  it('有这个功能之前写的记忆（没有使用记录）：第一次整理不归档，从那一刻起算，满 60 天还没人用才归档', () => {
    const s = store()
    const legacy = s.save(alice, { title: '老约定', content: '一直在用，只是以前不记使用情况' })
    const other = s.save(alice, { title: '另一条老的', content: 'c' })
    const now = Date.now()
    const longAgo = now - 400 * DAY
    for (const m of [legacy, other]) age(s, m.id, { createdAt: longAgo, updatedAt: longAgo })
    trackedSince(s, undefined)

    expect(s.sweep({ now, force: true })).toBe(0)
    expect(s.all().some((m) => m.archivedAt)).toBe(false)
    const since = trackedOf(s)
    expect(since).toBeGreaterThan(now - 60_000)
    expect(since).toBeLessThanOrEqual(now)
    // 差一天满 60 天：还不归档
    expect(s.sweep({ now: now + (MEMORY_ARCHIVE_DAYS - 1) * DAY, force: true })).toBe(0)
    // 这期间用过的那条留下，没用过的那条归档；起算时间不会被后面的整理改掉
    s.touch([legacy.id], now + 30 * DAY)
    expect(s.sweep({ now: now + (MEMORY_ARCHIVE_DAYS + 1) * DAY, force: true })).toBe(1)
    expect(s.all().filter((m) => m.archivedAt).map((m) => m.id)).toEqual([other.id])
    expect(trackedOf(s)).toBe(since)
  })

  it('空的库整理时不写盘（不为每个没有记忆的项目建文件）', () => {
    const s = store()
    const file = (s as unknown as { store: { file: string } }).store.file
    expect(s.sweep({ force: true })).toBe(0)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('挂在任务上的记忆就算归档了，认领那条任务时还是会带上；归档会顺手取消置顶', () => {
    const s = store()
    const m = s.save(user, { title: '登录页的坑', content: '验证码有缓存', taskRef: 'T-3', pinned: true })
    const arch = s.setArchived(user, m.id, true)
    expect(arch.pinned).toBe(false)
    expect(s.pinnedFor('a1')).toEqual([])
    expect(s.related(alice, '别的事情', { taskRef: 'T-3' }).map((x) => [x.m.id, x.why])).toEqual([[m.id, 'task']])
  })
})

describe('记忆第二批：相似提示', () => {
  it('memorySimilarity：同标题、内容基本一样的算像；不相干的不算', () => {
    const base = { title: '提交信息的写法', content: '提交信息用中文，第一行不超过五十个字，写清楚改了什么和为什么改' }
    expect(memorySimilarity(base, { title: '提交信息的写法', content: '完全不同的内容' })).toBe(1)
    expect(memorySimilarity(base, { title: 'commit 规范', content: '提交信息用中文，第一行不超过五十个字，写清楚改了什么和为什么改。另外不要带表情' })).toBeGreaterThanOrEqual(SIMILAR_THRESHOLD)
    expect(memorySimilarity(base, { title: '提交信息写法', content: '别的' })).toBeGreaterThanOrEqual(SIMILAR_THRESHOLD)
    expect(memorySimilarity(base, { title: '数据库备份时间', content: '每天凌晨三点做一次全量备份，保留最近七天的' })).toBeLessThan(SIMILAR_THRESHOLD)
    expect(memorySimilarity({ title: '甲', content: '好' }, { title: '乙', content: '好' })).toBeLessThan(SIMILAR_THRESHOLD)
  })

  it('similar：只在看得到的里面找，最像的在前，最多 3 条', () => {
    const s = store()
    const mine = s.save(alice, { title: '提交信息的写法', content: '提交信息用中文' })
    s.save(bob, { scope: 'private', title: '提交信息的写法', content: 'Bob 自己的笔记' })
    s.save(alice, { title: '数据库备份', content: '每天凌晨三点' })
    const hits = s.similar(alice, { title: '提交信息的写法', content: '提交信息用中文，第一行不超过五十个字' })
    expect(hits.map((x) => x.m.id)).toEqual([mine.id])
    expect(s.similar(bob, { title: '提交信息的写法', content: 'x' })).toHaveLength(2)
    expect(s.similar(alice, { title: '全新的话题', content: '和上面都没关系的一段内容，讲的是别的事' })).toEqual([])
  })
})

describe('记忆第二批：开场说明里的先后', () => {
  it('memoryHeat：用得多的高，久不用的衰减；byPriority：置顶 → 热度 → 新旧', () => {
    const now = Date.now()
    expect(memoryHeat({}, now)).toBe(0)
    expect(memoryHeat({ useCount: 7, lastUsedAt: now }, now)).toBeCloseTo(3)
    expect(memoryHeat({ useCount: 7, lastUsedAt: now - 30 * DAY }, now)).toBeCloseTo(1.5)
    const mk = (id: string, p: Partial<MemoryItem>): MemoryItem => ({ id, scope: 'shared', title: id, content: '', tags: [], pinned: false, createdBy: 'u', createdByName: 'u', updatedBy: 'u', updatedByName: 'u', createdAt: 0, updatedAt: 0, ...p })
    const list = [mk('old-cold', { updatedAt: 1 }), mk('new-cold', { updatedAt: 9 }), mk('hot', { updatedAt: 2, useCount: 5, lastUsedAt: now }), mk('pinned', { pinned: true })]
    expect(list.sort(byPriority(now)).map((m) => m.id)).toEqual(['pinned', 'hot', 'new-cold', 'old-cold'])
  })
})

describe('记忆第二批：经 MCP 工具和工作台', () => {
  let base: string
  let bridge: Bridge
  const clients: Client[] = []

  async function connect(token: string): Promise<Client> {
    const c = new Client({ name: 'mem2-test', version: '1.0.0' })
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
  const item = (id: string): MemoryItem | undefined => bridge.listMemories().find((m) => m.id === id)

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mem2b-'))
    fs.mkdirSync(path.join(base, 'alpha'), { recursive: true })
    bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoots: [path.join(base, 'alpha')], port: 0, userSkillsDir: path.join(base, 'user-skills') })
    await bridge.start()
  })
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.stop()
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
  })

  it('memory_save 新建时提示相似的、自动填来源；memory_read 看旧版本并记一次使用；搜索结果标出归档的', async () => {
    const alice = bridge.createAgent('Alice')
    const c = await connect(alice.token)
    const first = await call(c, 'memory_save', { title: '提交信息的写法', content: '提交信息用中文，第一行不超过五十个字，写清楚改了什么和为什么改' })
    expect(first.isError).toBe(false)
    expect(first.data.similar).toBeUndefined()
    expect(first.data.source).toBe('Alice写的（工作台自动填）')

    const second = await call(c, 'memory_save', { title: '提交信息怎么写', content: '提交信息用中文，第一行不超过五十个字，写清楚改了什么和为什么改', source: '我自己写的来源' })
    expect(second.data.source).toBe('我自己写的来源')
    expect(second.data.similar.map((x: { id: string }) => x.id)).toEqual([first.data.id])
    expect(second.data.similar_note).toContain('memory_delete')

    // 更新不提示相似，也不改来源；返回里列出留着的旧版本
    const upd = await call(c, 'memory_save', { id: first.data.id, title: '提交信息的写法', content: '改成：第一行不超过七十二个字' })
    expect(upd.data.similar).toBeUndefined()
    expect(upd.data.source).toBe(first.data.source)
    expect(upd.data.older_versions).toEqual([1])

    const old = await call(c, 'memory_read', { id: first.data.id, version: 1 })
    expect(old.data.content).toContain('五十个字')
    expect(old.data.current_version).toBe(2)
    expect((await call(c, 'memory_read', { id: first.data.id, version: 7 })).data.error).toBe('NOT_FOUND')
    // 看旧版本不算用到；读现在这版算
    expect(item(first.data.id)?.useCount).toBeUndefined()
    await call(c, 'memory_read', { id: first.data.id })
    expect(item(first.data.id)?.useCount).toBe(1)

    // 用户归档的：带词搜到时排最后并标出来；搜到、读到都不会让它回来，搜到也不算用到
    bridge.archiveMemory(first.data.id, true)
    expect((await call(c, 'memory_search', {})).data.map((m: { id: string }) => m.id)).toEqual([second.data.id])
    const found = await call(c, 'memory_search', { query: '提交信息' })
    expect(found.data.map((m: { id: string; archived?: boolean }) => [m.id, m.archived ?? false])).toEqual([
      [second.data.id, false],
      [first.data.id, true]
    ])
    expect(item(second.data.id)?.useCount).toBe(1)
    expect([item(first.data.id)?.archivedAt !== undefined, item(first.data.id)?.useCount]).toEqual([true, 1])
    await call(c, 'memory_read', { id: first.data.id })
    expect(item(first.data.id)?.archivedAt).toBeGreaterThan(0)
    expect((await call(c, 'memory_search', {})).data).toHaveLength(1)
    bridge.archiveMemory(first.data.id, false)
    expect((await call(c, 'memory_search', {})).data).toHaveLength(2)
  })

  it('memory_save：找相似的、自动填来源出了错，保存照样成功；太长的正文直接拒掉，不先和全部记忆比一遍', async () => {
    const alice = bridge.createAgent('Alice')
    const c = await connect(alice.token)
    const similar = vi.spyOn(MemoryStore.prototype, 'similar').mockImplementation(() => {
      throw new Error('boom')
    })
    try {
      const ok = await call(c, 'memory_save', { title: '约定甲', content: '内容甲' })
      expect(ok.data.error).toBeUndefined()
      expect(ok.data.id).toMatch(/^m_/)
      expect(similar).toHaveBeenCalledTimes(1)
      const big = await call(c, 'memory_save', { title: '太长的', content: 'x'.repeat(8001) })
      expect(big.data.error).toBe('TOO_LARGE')
      expect(similar).toHaveBeenCalledTimes(1)
    } finally {
      similar.mockRestore()
    }
  })

  it('来源自动填：手上有进行中的任务就带上任务编号；用户刚私聊过就注明', async () => {
    const alice = bridge.createAgent('Alice')
    const c = await connect(alice.token)
    const t = await call(c, 'task_create', { title: '做登录页' })
    await call(c, 'task_claim', { task: t.data.ref })
    bridge.chat.send({ kind: 'user', id: 'user', name: '用户' }, { text: '密码规则是至少十位', to: 'Alice' })
    const m = await call(c, 'memory_save', { title: '密码规则', content: '至少十位' })
    expect(m.data.source).toBe(`Alice 做 ${t.data.ref} 时写的；写之前半小时内用户私聊过它，内容可能来自私聊（工作台自动填）`)
  })

  it('开场说明：常用的置顶记忆排在前面，归档的不进；全局记忆里全员可见的不会被自动归档', async () => {
    const alice = bridge.createAgent('Alice')
    const a = bridge.saveMemory({ title: '甲约定', content: '甲的内容', pinned: true })
    const b = bridge.saveMemory({ title: '乙约定', content: '乙的内容', pinned: true })
    const x = bridge.saveMemory({ title: '丙约定', content: '丙的内容', pinned: true })
    bridge.archiveMemory(x.id, true)
    const g = bridge.saveMemory({ title: '用户的习惯', content: '先说结论', global: true })
    const c1 = await connect(alice.token)
    expect(c1.getInstructions()).toContain('### 甲约定')
    expect(c1.getInstructions()).not.toContain('丙约定')
    await call(c1, 'memory_read', { id: a.id })
    const c2 = await connect(alice.token)
    const text = c2.getInstructions() ?? ''
    expect(text.indexOf('### 甲约定')).toBeGreaterThan(-1)
    expect(text.indexOf('### 甲约定')).toBeLessThan(text.indexOf('### 乙约定'))
    expect(b.id).not.toBe(a.id)

    // 全局、全员可见的那条很久没人读，握手时的整理也不归档它
    const longAgo = Date.now() - (MEMORY_ARCHIVE_DAYS + 30) * DAY
    age(bridge.globalMemory, g.id, { createdAt: longAgo, updatedAt: longAgo })
    trackedSince(bridge.globalMemory, longAgo)
    expect(bridge.globalMemory.sweep({ force: true, keep: (m) => m.scope === 'shared' })).toBe(0)
    expect(bridge.globalMemory.sweep({ force: true })).toBe(1)
  })

  it('用户在工作台恢复旧版本（撤掉 AI 写进来的内容）、归档和取消归档', async () => {
    const alice = bridge.createAgent('Alice')
    const c = await connect(alice.token)
    const m = await call(c, 'memory_save', { title: '约定', content: '第一版' })
    await call(c, 'memory_save', { id: m.data.id, title: '约定', content: 'AI 把私聊里的话写进来了' })
    const back = bridge.restoreMemory(m.data.id, 1)
    expect([back.content, back.version, back.updatedByName]).toEqual(['第一版', 3, '用户'])
    expect(back.history?.map((r) => r.content)).toEqual(['第一版', 'AI 把私聊里的话写进来了'])
    expect(bridge.archiveMemory(m.data.id, true).archivedAt).toBeGreaterThan(0)
    expect(bridge.archiveMemory(m.data.id, false).archivedAt).toBeUndefined()
  })
})
