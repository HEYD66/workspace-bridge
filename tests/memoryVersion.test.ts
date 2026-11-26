// 优化第 6 条：共享记忆加版本号。memory_save / delete 带 expectedVersion 时，别人先改过就报 CONFLICT，不再后写的盖掉先写的
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore, memoryVersion, type Actor } from '../src/core/memory'
import { ToolError } from '../src/core/fileTools'

const USER: Actor = { id: 'user', name: '用户', kind: 'user' }
const A: Actor = { id: 'a_a', name: 'Alice', kind: 'agent' }
const B: Actor = { id: 'a_b', name: 'Bob', kind: 'agent' }

let base: string
let store: MemoryStore

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-memver-'))
  store = new MemoryStore(path.join(base, 'memory.json'))
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

function caught(fn: () => unknown): ToolError {
  try {
    fn()
  } catch (e) {
    if (e instanceof ToolError) return e
    throw e
  }
  throw new Error('应该抛错，但没有')
}

describe('记忆版本号', () => {
  it('新建是第 1 版，每次更新加 1', () => {
    const m = store.save(A, { title: '进度', content: '登录做完了' })
    expect(m.version).toBe(1)
    expect(store.save(B, { id: m.id, title: '进度', content: '注册也做完了' }).version).toBe(2)
    expect(store.save(USER, { id: m.id, title: '进度', content: '都做完了' }).version).toBe(3)
    expect(store.get(A, m.id).version).toBe(3)
  })

  it('老数据没有 version 字段：按第 1 版算，更新后变成第 2 版', () => {
    const file = path.join(base, 'old.json')
    const now = Date.now()
    fs.writeFileSync(
      file,
      JSON.stringify({
        items: [
          { id: 'm_old', scope: 'shared', title: '老记忆', content: '旧', tags: [], pinned: false, createdBy: 'a_a', createdByName: 'Alice', updatedBy: 'a_a', updatedByName: 'Alice', createdAt: now, updatedAt: now }
        ]
      })
    )
    const old = new MemoryStore(file)
    const m = old.get(A, 'm_old')
    expect(m.version).toBeUndefined()
    expect(memoryVersion(m)).toBe(1)
    expect(old.save(B, { id: 'm_old', title: '老记忆', content: '新', expectedVersion: 1 }).version).toBe(2)
  })

  it('memoryVersion 遇到坏值按 1 算', () => {
    expect(memoryVersion({})).toBe(1)
    expect(memoryVersion({ version: 0 })).toBe(1)
    expect(memoryVersion({ version: 2.5 })).toBe(1)
    expect(memoryVersion({ version: 7 })).toBe(7)
  })
})

describe('expectedVersion 防覆盖', () => {
  it('两个人都从第 1 版改：先保存的成功，后保存的报 CONFLICT，内容不被覆盖，并带回最新内容', () => {
    const m = store.save(A, { title: '约定', content: '缩进两个空格', tags: ['风格'] })
    const first = store.save(A, { id: m.id, title: '约定', content: '缩进两个空格；用单引号', expectedVersion: 1 })
    expect(first.version).toBe(2)

    const e = caught(() => store.save(B, { id: m.id, title: '约定', content: '缩进四个空格', expectedVersion: 1 }))
    expect(e.code).toBe('CONFLICT')
    expect(e.message).toContain('第 2 版')
    expect(e.message).toContain('expected_version=2')
    expect(e.data).toMatchObject({
      current: { id: m.id, version: 2, title: '约定', content: '缩进两个空格；用单引号', tags: ['风格'], updatedBy: A.id, updatedByName: 'Alice' }
    })
    const now = store.get(B, m.id)
    expect(now.content).toBe('缩进两个空格；用单引号')
    expect(now.version).toBe(2)
    expect(now.updatedBy).toBe(A.id)

    // 合并以后带上新版本号就能保存
    expect(store.save(B, { id: m.id, title: '约定', content: '缩进两个空格；用单引号；行宽 120', expectedVersion: 2 }).version).toBe(3)
  })

  it('不带 expectedVersion 照旧直接覆盖（老调用方式不变）', () => {
    const m = store.save(A, { title: '约定', content: 'v1' })
    store.save(A, { id: m.id, title: '约定', content: 'v2' })
    const r = store.save(B, { id: m.id, title: '约定', content: 'B 写的' })
    expect(r.content).toBe('B 写的')
    expect(r.version).toBe(3)
  })

  it('用户在工作台保存也一样核对', () => {
    const m = store.save(A, { title: '约定', content: 'v1' })
    store.save(A, { id: m.id, title: '约定', content: 'v2' })
    expect(caught(() => store.save(USER, { id: m.id, title: '约定', content: '用户改', expectedVersion: 1 })).code).toBe('CONFLICT')
  })

  it('权限错误优先于版本检查：看不到的私有记忆照旧 NOT_FOUND，不泄露版本和内容', () => {
    const p = store.save(A, { scope: 'private', title: '草稿', content: '秘密' })
    const e = caught(() => store.save(B, { id: p.id, title: '草稿', content: 'x', expectedVersion: 5 }))
    expect(e.code).toBe('NOT_FOUND')
    expect(e.data).toBeUndefined()
  })

  it('置顶等原有限制照旧先报', () => {
    const m = store.save(A, { title: '规则', content: 'x' })
    expect(caught(() => store.save(A, { id: m.id, title: '规则', content: 'x', pinned: true, expectedVersion: 9 })).code).toBe('FORBIDDEN')
  })

  it('expectedVersion 不是正整数报 INVALID_ARGS；新建时传了也报 INVALID_ARGS', () => {
    const m = store.save(A, { title: '约定', content: 'v1' })
    for (const bad of [0, -1, 1.5, '1' as unknown as number]) {
      expect(caught(() => store.save(A, { id: m.id, title: '约定', content: 'v2', expectedVersion: bad })).code).toBe('INVALID_ARGS')
    }
    expect(store.get(A, m.id).version).toBe(1)
    expect(caught(() => store.save(A, { title: '新的', content: 'x', expectedVersion: 1 })).code).toBe('INVALID_ARGS')
    expect(store.search(A, { query: '新的' })).toHaveLength(0)
  })

  it('改动失败时什么都不写（标题、标签、更新人都不变）', () => {
    const m = store.save(A, { title: '约定', content: 'v1', tags: ['a'] })
    store.save(A, { id: m.id, title: '约定', content: 'v2' })
    caught(() => store.save(B, { id: m.id, title: '改了标题', content: 'v3', tags: ['b'], expectedVersion: 1 }))
    const now = store.get(A, m.id)
    expect(now).toMatchObject({ title: '约定', content: 'v2', tags: ['a'], updatedBy: A.id, version: 2 })
  })
})

describe('删除也能带 expectedVersion', () => {
  it('版本对不上不删；对上了删；不带照旧删', () => {
    const m = store.save(A, { title: '临时', content: 'v1' })
    store.save(B, { id: m.id, title: '临时', content: 'B 补了重要内容' })
    const e = caught(() => store.delete(A, m.id, { expectedVersion: 1 }))
    expect(e.code).toBe('CONFLICT')
    expect((e.data as { current: { content: string } }).current.content).toBe('B 补了重要内容')
    expect(store.get(A, m.id)).toBeTruthy()
    expect(store.delete(A, m.id, { expectedVersion: 2 }).id).toBe(m.id)

    const n = store.save(A, { title: '另一个', content: 'x' })
    expect(store.delete(A, n.id).id).toBe(n.id)
  })

  it('删别人的共享记忆照旧 FORBIDDEN，不因为带了版本号就变', () => {
    const m = store.save(A, { title: '约定', content: 'x' })
    expect(caught(() => store.delete(B, m.id, { expectedVersion: 1 })).code).toBe('FORBIDDEN')
  })
})
