// 优化第 16 条：改任务的标题、说明、优先级时，历史记下改了哪些字段和旧值、新值；
// 标题和说明只有用户、创建者、派活的人能改，执行者不能改
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Actor } from '../src/core/memory'
import { EDIT_HISTORY_VALUE_CHARS, TaskStore } from '../src/core/tasks'

const USER: Actor = { id: 'user', name: '用户', kind: 'user' }
const BOSS: Actor = { id: 'a_boss', name: '协调员', kind: 'agent' }
const WORKER: Actor = { id: 'a_worker', name: '执行者', kind: 'agent' }
const OTHER: Actor = { id: 'a_other', name: '路人', kind: 'agent' }
const names: Record<string, string> = { a_boss: '协调员', a_worker: '执行者', a_other: '路人' }

let base: string
let store: TaskStore

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-taskedit-'))
  store = new TaskStore(path.join(base, 'tasks.json'), { nameOf: (id) => names[id], notify: () => {} })
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

const lastHistory = (key: string) => store.get(key).history.at(-1)!

describe('task edit 记下改了什么', () => {
  it('只记真正变了的字段，带旧值和新值', () => {
    const t = store.create(BOSS, { title: '旧标题', description: '旧说明', assigneeId: WORKER.id })
    store.edit(BOSS, t.ref, { title: '新标题', description: '旧说明', priority: 'high' })
    const h = lastHistory(t.ref)
    expect(h.action).toBe('edited')
    expect(h.note).toBe('改了标题、优先级')
    expect(h.changes).toEqual([
      { field: 'title', from: '旧标题', to: '新标题' },
      { field: 'priority', from: 'normal', to: 'high' }
    ])
    expect(store.get(t.ref)).toMatchObject({ title: '新标题', description: '旧说明', priority: 'high' })
  })

  it('什么都没变不记历史', () => {
    const t = store.create(BOSS, { title: '标题' })
    const before = store.get(t.ref).history.length
    store.edit(BOSS, t.ref, { title: '  标题  ', description: '' })
    expect(store.get(t.ref).history).toHaveLength(before)
  })

  it('说明太长时旧值新值都截断，并标明截断了', () => {
    const long = '长'.repeat(EDIT_HISTORY_VALUE_CHARS + 50)
    const t = store.create(BOSS, { title: '标题', description: '短' })
    store.edit(BOSS, t.ref, { description: long })
    const [c] = lastHistory(t.ref).changes!
    expect(c.field).toBe('description')
    expect(c.truncated).toBe(true)
    expect(c.from).toBe('短')
    expect(c.to.startsWith('长'.repeat(EDIT_HISTORY_VALUE_CHARS))).toBe(true)
    expect(c.to).toContain(`截断，原文 ${long.length} 字`)
    // 任务本身存的是全文
    expect(store.get(t.ref).description).toBe(long)
  })

  it('标题为空照旧报 INVALID_ARGS，不记历史', () => {
    const t = store.create(BOSS, { title: '标题' })
    const before = store.get(t.ref).history.length
    expect(() => store.edit(BOSS, t.ref, { title: '   ' })).toThrow(/INVALID_ARGS/)
    expect(store.get(t.ref).history).toHaveLength(before)
  })
})

describe('谁能改标题和说明', () => {
  it('创建者、派活的人、用户能改', () => {
    const t = store.create(BOSS, { title: 'A', assigneeId: WORKER.id })
    expect(store.edit(BOSS, t.ref, { title: 'B' }).title).toBe('B')
    expect(store.edit(USER, t.ref, { description: '用户补的' }).description).toBe('用户补的')
    // 用户建的任务，后来由协调员派出去：协调员是派活的人，也能改
    const u = store.create(USER, { title: 'U' })
    store.assign(BOSS, u.ref, WORKER.id)
    expect(store.edit(BOSS, u.ref, { title: 'U2' }).title).toBe('U2')
  })

  it('执行者和其他 AI 改标题或说明报 FORBIDDEN，任务和历史都不变', () => {
    const t = store.create(BOSS, { title: 'A', description: 'D', assigneeId: WORKER.id })
    const before = store.get(t.ref).history.length
    expect(() => store.edit(WORKER, t.ref, { title: 'X' })).toThrow(/FORBIDDEN/)
    expect(() => store.edit(OTHER, t.ref, { description: 'X' })).toThrow(/FORBIDDEN/)
    expect(store.get(t.ref)).toMatchObject({ title: 'A', description: 'D' })
    expect(store.get(t.ref).history).toHaveLength(before)
  })

  it('执行者能改优先级；传和原来一样的标题不算改，不会被拦', () => {
    const t = store.create(BOSS, { title: 'A', assigneeId: WORKER.id })
    const r = store.edit(WORKER, t.ref, { title: 'A', priority: 'low' })
    expect(r.priority).toBe('low')
    expect(lastHistory(t.ref).changes).toEqual([{ field: 'priority', from: 'normal', to: 'low' }])
  })

  it('自己建给自己的任务，自己能改', () => {
    const t = store.create(WORKER, { title: '自己的' })
    store.claim(WORKER, t.ref)
    expect(store.edit(WORKER, t.ref, { title: '自己的2' }).title).toBe('自己的2')
  })
})

describe('task editAndUpdate 原子性', () => {
  it('同一次调用里改标题但提交 review 缺少 result 报错时，标题和历史整体回滚不留半截', () => {
    const t = store.create(BOSS, { title: '原标题', description: '原说明', assigneeId: WORKER.id })
    const beforeLen = store.get(t.ref).history.length
    expect(() =>
      store.editAndUpdate(BOSS, t.ref, { title: '新标题', priority: 'high', status: 'review' })
    ).toThrow(/INVALID_ARGS/)
    const after = store.get(t.ref)
    expect(after.title).toBe('原标题')
    expect(after.priority).toBe('normal')
    expect(after.status).toBe('todo')
    expect(after.history).toHaveLength(beforeLen)
  })

  it('执行者改优先级同时试图直接 done（被 REVIEW_REQUIRED 拦截）时，优先级和历史也不变', () => {
    const t = store.create(BOSS, { title: '派活任务', assigneeId: WORKER.id })
    const beforeLen = store.get(t.ref).history.length
    expect(() =>
      store.editAndUpdate(WORKER, t.ref, { priority: 'high', status: 'done', result: 'ok' })
    ).toThrow(/REVIEW_REQUIRED/)
    const after = store.get(t.ref)
    expect(after.priority).toBe('normal')
    expect(after.status).toBe('todo')
    expect(after.history).toHaveLength(beforeLen)
  })

  it('edit 和 update 都合法时一次落盘，且提醒里带更新后的新标题', () => {
    const notices: { target: string | undefined; text: string }[] = []
    const notifiedStore = new TaskStore(path.join(base, 'tasks-notify.json'), {
      nameOf: (id) => names[id],
      notify: (target, text) => notices.push({ target, text })
    })
    const t2 = notifiedStore.create(BOSS, { title: '旧任务名' })
    notifiedStore.assign(OTHER, t2.ref, BOSS.id)
    notices.length = 0

    // BOSS 既是创建者也是被指派者（managedBy = OTHER），同时改标题并提交 review：通知给审查人 OTHER 带新标题
    const saved = notifiedStore.editAndUpdate(BOSS, t2.ref, {
      title: '新任务名',
      status: 'review',
      result: '交付说明'
    })
    expect(saved.title).toBe('新任务名')
    expect(saved.status).toBe('review')
    expect(saved.history.slice(-2).map((h) => h.action)).toEqual(['edited', 'status → review'])
    expect(notices.some((n) => n.target === OTHER.id && n.text.includes('新任务名'))).toBe(true)
  })
})
