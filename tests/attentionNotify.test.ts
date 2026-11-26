// 有事等用户时弹系统通知（T-19）：算出哪些事、只弹一次、看着工作台时不弹
import { describe, expect, it } from 'vitest'
import type { MemberStatus, TaskItem } from '../src/core/types'
import { buildCanvasModel } from '../src/shared/canvasModel'
import { AttentionTracker, attentionMessage, collectAttention, type AttentionSource } from '../src/shared/attentionNotify'

const agent = (id: string) => ({ id, name: `AI-${id}`, color: '#123456' })
const task = (over: Partial<TaskItem>): TaskItem =>
  ({ id: `t_${over.ref}`, ref: 'T-1', title: '做点事', description: '', status: 'in_progress', priority: 'normal', createdBy: 'user', createdAt: 1, updatedAt: 1, history: [], ...over }) as TaskItem

function source(tasks: TaskItem[], memberStatus: Record<string, MemberStatus> = {}, wsId = 'w_1'): AttentionSource {
  return { workspaceId: wsId, workspaceName: '项目A', model: buildCanvasModel({ agents: [agent('a'), agent('b')], tasks, memberStatus, workspaceId: wsId, now: 10_000 }) }
}

const question = task({ ref: 'T-2', title: '改按钮', assigneeId: 'a', questions: [{ id: 'q1', text: '按钮用蓝色还是绿色？', askedBy: 'a', askedAt: 5, status: 'open' }] as TaskItem['questions'] })
const delivered = task({ ref: 'T-3', title: '写文档', assigneeId: 'b', status: 'done', result: '写好了', updatedAt: 9_000 })

describe('collectAttention', () => {
  it('问题、交付、可能卡住各出一条，key 稳定', () => {
    const stuck: Record<string, MemberStatus> = { b: { status: 'stale', sessions: 1, since: 7, tasks: [{ ref: 'T-4', title: '跑测试', workspaceId: 'w_1' }] } as MemberStatus }
    const items = collectAttention([source([question, delivered], stuck)])
    expect(items.map((i) => i.kind).sort()).toEqual(['delivered', 'question', 'stuck'])
    const q = items.find((i) => i.kind === 'question')!
    expect(q).toMatchObject({ key: 'question:w_1:T-2:q1', cardId: 'a', workspaceId: 'w_1', title: 'AI-a 在 项目A 问你' })
    expect(q.body).toContain('按钮用蓝色还是绿色？')
    expect(items.find((i) => i.kind === 'stuck')).toMatchObject({ key: 'stuck:b:7', cardId: 'b', title: 'AI-b 可能卡住了' })
    expect(collectAttention([source([question, delivered], stuck)]).map((i) => i.key)).toEqual(items.map((i) => i.key))
    // 做完后加个备注（updatedAt 变了）不算新的一件事
    expect(items.find((i) => i.kind === 'delivered')?.key).toBe('delivered:w_1:T-3')
    const touched = collectAttention([source([question, { ...delivered, updatedAt: 9_500 }], stuck)])
    expect(touched.find((i) => i.kind === 'delivered')?.key).toBe('delivered:w_1:T-3')
  })

  it('可能卡住但手上没活的不算；同一个 AI 在两个项目里只算一次', () => {
    const idle: Record<string, MemberStatus> = { a: { status: 'stale', sessions: 1, since: 7 } as MemberStatus }
    expect(collectAttention([source([], idle)])).toEqual([])
    const busy: Record<string, MemberStatus> = { a: { status: 'stale', sessions: 1, since: 7, tasks: [{ ref: 'T-4', title: '跑测试', workspaceId: 'w_1' }, { ref: 'T-9', title: '别的', workspaceId: 'w_2' }] } as MemberStatus }
    expect(collectAttention([source([], busy, 'w_1'), source([], busy, 'w_2')]).filter((i) => i.kind === 'stuck')).toHaveLength(1)
  })
})

describe('AttentionTracker', () => {
  const items = collectAttention([source([question])])
  it('启动时不翻旧账，新出来的只弹一次', () => {
    const t = new AttentionTracker()
    expect(t.update([], false)).toEqual([])
    expect(t.update(items, false).map((i) => i.key)).toEqual(['question:w_1:T-2:q1'])
    expect(t.update(items, false)).toEqual([])
  })
  it('用户看着工作台时出现的不弹，之后也不补弹', () => {
    const t = new AttentionTracker()
    t.update([], false)
    expect(t.update(items, true)).toEqual([])
    expect(t.update(items, false)).toEqual([])
  })
  it('第一次就有的事不弹', () => {
    const t = new AttentionTracker()
    expect(t.update(items, false)).toEqual([])
  })
})

describe('attentionMessage', () => {
  it('一件事原样；几件事并成一条，跳到第一件', () => {
    const items = collectAttention([source([question, delivered])])
    expect(attentionMessage([])).toBeNull()
    expect(attentionMessage(items.slice(0, 1))?.title).toBe(items[0].title)
    const m = attentionMessage(items)!
    expect(m.title).toBe('2 件事等你')
    expect(m.target).toBe(items[0])
  })
})
