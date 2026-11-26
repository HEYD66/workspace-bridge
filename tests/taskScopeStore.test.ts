// T-22：任务板上的允许范围（allowedPaths）和等人决定的问题（questions）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Actor } from '../src/core/memory'
import { TaskStore } from '../src/core/tasks'
import { ToolError } from '../src/core/fileTools'

const USER: Actor = { id: 'user', name: '用户', kind: 'user' }
const BOSS: Actor = { id: 'a_boss', name: '协调员', kind: 'agent' }
const WORKER: Actor = { id: 'a_worker', name: '执行者', kind: 'agent' }
const OTHER: Actor = { id: 'a_other', name: '路人', kind: 'agent' }
const names: Record<string, string> = { a_boss: '协调员', a_worker: '执行者', a_other: '路人' }

let base: string
let root: string
let store: TaskStore
let notices: { to: string; text: string }[]

function makeStore(withScope = true): TaskStore {
  return new TaskStore(path.join(base, 'tasks.json'), {
    nameOf: (id) => names[id],
    notify: (to, text) => notices.push({ to, text }),
    ...(withScope ? { scope: () => ({ root, caseInsensitive: false }) } : {})
  })
}

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return e instanceof ToolError ? e.code : 'OTHER'
  }
  return 'NONE'
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-taskscope-'))
  root = path.join(base, 'ws')
  notices = []
  store = makeStore()
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

const lastHistory = (key: string) => store.get(key).history.at(-1)!

describe('允许范围 allowedPaths', () => {
  it('create 时规范化、去重并写进创建记录；不传或传空数组就没有这个字段', () => {
    const t = store.create(BOSS, { title: 'a', assigneeId: WORKER.id, allowedPaths: ['src\\core\\tasks.ts', './src/core/tasks.ts', 'tests/'] })
    expect(t.allowedPaths).toEqual(['src/core/tasks.ts', 'tests'])
    expect(lastHistory(t.ref).note).toBe('指派给 执行者；允许范围：src/core/tasks.ts、tests')
    expect('allowedPaths' in store.create(BOSS, { title: 'b' })).toBe(false)
    expect('allowedPaths' in store.create(BOSS, { title: 'c', allowedPaths: [] })).toBe(false)
    expect(code(() => store.create(BOSS, { title: 'd', allowedPaths: ['../x'] }))).toBe('OUTSIDE_WORKSPACE')
    expect(store.all()).toHaveLength(3)
  })

  it('edit 能设置、改、清掉范围，历史记旧值和新值；没变就不记', () => {
    const t = store.create(BOSS, { title: 'a', assigneeId: WORKER.id })
    store.edit(BOSS, t.ref, { allowedPaths: ['src/a.ts', 'src/b.ts'] })
    expect(store.get(t.ref).allowedPaths).toEqual(['src/a.ts', 'src/b.ts'])
    expect(lastHistory(t.ref)).toMatchObject({ action: 'edited', note: '改了允许范围', changes: [{ field: 'allowedPaths', from: '（不限）', to: 'src/a.ts\nsrc/b.ts' }] })
    const n = store.get(t.ref).history.length
    store.edit(BOSS, t.ref, { allowedPaths: ['src\\a.ts', 'src/b.ts'] })
    expect(store.get(t.ref).history).toHaveLength(n)
    store.edit(USER, t.ref, { allowedPaths: null })
    expect('allowedPaths' in store.get(t.ref)).toBe(false)
    expect(lastHistory(t.ref).changes).toEqual([{ field: 'allowedPaths', from: 'src/a.ts\nsrc/b.ts', to: '（不限）' }])
    store.edit(BOSS, t.ref, { allowedPaths: ['docs'] })
    store.edit(BOSS, t.ref, { allowedPaths: [] })
    expect(store.get(t.ref).allowedPaths).toBeUndefined()
  })

  it('执行者和路人不能改范围（整次编辑回滚）；editAndUpdate 里范围和状态一次写完', () => {
    const t = store.create(BOSS, { title: 'a', assigneeId: WORKER.id, allowedPaths: ['src'] })
    expect(code(() => store.edit(WORKER, t.ref, { allowedPaths: ['**'] }))).toBe('FORBIDDEN')
    expect(code(() => store.editAndUpdate(OTHER, t.ref, { priority: 'high', allowedPaths: ['docs'] }))).toBe('FORBIDDEN')
    expect(store.get(t.ref)).toMatchObject({ allowedPaths: ['src'], priority: 'normal' })
    // 执行者传一样的范围不算改
    store.edit(WORKER, t.ref, { allowedPaths: ['src/'] })
    const r = store.editAndUpdate(BOSS, t.ref, { allowedPaths: ['src', 'tests'], status: 'in_progress', note: '加上 tests' })
    expect(r.allowedPaths).toEqual(['src', 'tests'])
    expect(r.status).toBe('in_progress')
    expect(r.history.slice(-2).map((h) => h.action)).toEqual(['edited', 'status → in_progress'])
  })

  it('没配 scope 的任务板不能设范围，但不影响其它操作', () => {
    const s = makeStore(false)
    expect(code(() => s.create(BOSS, { title: 'a', allowedPaths: ['src'] }))).toBe('INVALID_STATE')
    const t = s.create(BOSS, { title: 'b' })
    expect(s.edit(BOSS, t.ref, { title: 'c', allowedPaths: null }).title).toBe('c')
  })

  it('整台电脑：绝对路径、不分大小写去重', () => {
    const s = new TaskStore(path.join(base, 'm.json'), { nameOf: (id) => names[id], notify: () => {}, scope: () => ({ root, machine: true, caseInsensitive: true }) })
    const d = path.resolve(base, 'Proj').replace(/\\/g, '/')
    const t = s.create(BOSS, { title: 'a', allowedPaths: [`${d}/src/`, `${d.toLowerCase()}/SRC`] })
    expect(t.allowedPaths).toEqual([`${d}/src`])
    expect(code(() => s.create(BOSS, { title: 'b', allowedPaths: ['src'] }))).toBe('INVALID_ARGS')
  })
})

describe('等人决定的问题', () => {
  it('执行者提问：写进 questions 和历史，通知派活的人（不重复，不通知自己）', () => {
    const t = store.create(BOSS, { title: '做一个功能', assigneeId: WORKER.id })
    notices = []
    const { question, task } = store.addQuestion(WORKER, t.ref, { text: '范围外要不要拦？', options: ['拦', '只提醒'] })
    expect(question).toMatchObject({ id: 'q1', status: 'open', askedBy: WORKER.id, askedByName: '执行者', options: ['拦', '只提醒'] })
    expect(task.questions).toHaveLength(1)
    expect(store.get(t.ref).questions?.[0].id).toBe('q1')
    expect(lastHistory(t.ref)).toMatchObject({ action: 'question_added', note: 'q1：范围外要不要拦？', actorId: WORKER.id })
    expect(notices).toEqual([{ to: BOSS.id, text: '执行者 在 T-1「做一个功能」提了问题 q1，等你决定：范围外要不要拦？（用 task_get 查看）' }])
    expect(store.addQuestion(WORKER, t.ref, { text: '第二个' }).question.id).toBe('q2')
  })

  it('回答：用户、派活的人能答，执行者和路人不能；答完通知提问的人和执行者', () => {
    const t = store.create(BOSS, { title: 'a', assigneeId: WORKER.id })
    store.addQuestion(OTHER, t.ref, { text: '要不要拦？' })
    notices = []
    expect(code(() => store.answerQuestion(WORKER, t.ref, 'q1', '拦'))).toBe('FORBIDDEN')
    expect(code(() => store.answerQuestion(OTHER, t.ref, 'q1', '拦'))).toBe('FORBIDDEN')
    const r = store.answerQuestion(USER, t.ref, 'q1', '先只提醒')
    expect(r.question).toMatchObject({ status: 'answered', answer: '先只提醒', answeredBy: 'user', answeredByName: '用户' })
    expect(lastHistory(t.ref)).toMatchObject({ action: 'question_answered', note: 'q1 → 先只提醒', actorId: 'user' })
    expect(notices.map((n) => n.to).sort()).toEqual([OTHER.id, WORKER.id].sort())
    expect(notices[0].text).toContain('用户 回答了 T-1「a」的问题 q1：先只提醒')
    expect(store.answerQuestion(BOSS, t.ref, 'q1', '拦').question.answer).toBe('拦')
    expect(code(() => store.answerQuestion(BOSS, t.ref, 'q9', '拦'))).toBe('NOT_FOUND')
  })

  it('关闭：提问的人能关，路人不能；关了不能再答，失败不留历史', () => {
    const t = store.create(BOSS, { title: 'a', assigneeId: WORKER.id })
    store.addQuestion(WORKER, t.ref, { text: '要不要拦？' })
    expect(code(() => store.closeQuestion(OTHER, t.ref, 'q1'))).toBe('FORBIDDEN')
    const n = store.get(t.ref).history.length
    notices = []
    const r = store.closeQuestion(WORKER, t.ref, 'q1', '想通了，不用问')
    expect(r.question).toMatchObject({ status: 'closed', closedBy: WORKER.id, closeNote: '想通了，不用问' })
    expect(lastHistory(t.ref)).toMatchObject({ action: 'question_closed', note: 'q1：想通了，不用问' })
    expect(store.get(t.ref).history).toHaveLength(n + 1)
    expect(notices).toEqual([])
    expect(code(() => store.answerQuestion(USER, t.ref, 'q1', '拦'))).toBe('INVALID_STATE')
    expect(store.get(t.ref).history).toHaveLength(n + 1)
    expect(store.get(t.ref).questions?.[0].status).toBe('closed')
  })

  it('老数据没有 questions / allowedPaths 字段时照常工作，重新加载后数据还在', () => {
    const file = path.join(base, 'old.json')
    const old = {
      seq: 1,
      tasks: [{ id: 't_old', ref: 'T-1', title: '老任务', description: '', status: 'in_progress', priority: 'normal', assigneeId: WORKER.id, createdBy: BOSS.id, createdByName: '协调员', managedBy: BOSS.id, createdAt: 1, updatedAt: 1, history: [] }]
    }
    fs.writeFileSync(file, JSON.stringify(old), 'utf8')
    const deps = { nameOf: (id: string) => names[id], notify: () => {}, scope: () => ({ root, caseInsensitive: false }) }
    const s = new TaskStore(file, deps)
    expect(s.get('T-1').questions).toBeUndefined()
    expect(s.update(WORKER, 'T-1', { status: 'review', result: '做完了' }).status).toBe('review')
    s.addQuestion(WORKER, 'T-1', { text: '还要加测试吗？' })
    s.edit(BOSS, 'T-1', { allowedPaths: ['src'] })
    const again = new TaskStore(file, deps)
    expect(again.get('T-1').questions?.map((q) => q.id)).toEqual(['q1'])
    expect(again.get('T-1').allowedPaths).toEqual(['src'])
  })
})
