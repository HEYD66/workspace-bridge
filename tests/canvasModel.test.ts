// 画布的数据模型：工作台的数据 → 卡片、框、线、总数
import { describe, expect, it } from 'vitest'
import type { ActivityEvent, MemberStatus, TaskItem } from '../src/core/types'
import { buildCanvasModel, CANVAS_USER_ID, type CanvasInput } from '../src/shared/canvasModel'

const agent = (id: string, roleId?: string) => ({ id, name: `AI-${id}`, color: '#123456', roleId })
const st = (status: MemberStatus['status'], extra: Partial<MemberStatus> = {}): MemberStatus => ({ status, sessions: status === 'offline' ? 0 : 1, ...extra })

let seq = 0
const task = (over: Partial<TaskItem>): TaskItem => {
  seq += 1
  return {
    id: `id${seq}`,
    ref: `T-${seq}`,
    title: `任务${seq}`,
    description: '',
    status: 'todo',
    priority: 'normal',
    createdBy: CANVAS_USER_ID,
    createdByName: '你',
    createdAt: 1000,
    updatedAt: 2000,
    history: [],
    ...over
  }
}
const event = (agentId: string, ts: number, over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: `e${ts}`,
  ts,
  agentId,
  agentName: agentId,
  agentColor: '#000',
  tool: 'edit_file',
  args: {},
  status: 'ok',
  ...over
})
const base = (over: Partial<CanvasInput> = {}): CanvasInput => ({ agents: [agent('a'), agent('b')], tasks: [], ...over })
const card = (m: ReturnType<typeof buildCanvasModel>, id: string) => m.cards.find((c) => c.id === id)!

describe('卡片状态', () => {
  it('直接取工作台算好的状态：跑命令也算在干活，stale 是可能卡住，没有状态按离线', () => {
    const m = buildCanvasModel(
      base({
        agents: [agent('a'), agent('b'), agent('c'), agent('d'), agent('e'), agent('f'), agent('g')],
        memberStatus: { a: st('working', { tool: 'edit_file', since: 5 }), b: st('command'), c: st('waiting'), d: st('idle'), e: st('stale'), f: st('paused') }
      })
    )
    expect(m.cards.map((c) => c.state)).toEqual(['working', 'working', 'waiting', 'idle', 'stuck', 'paused', 'offline'])
    expect(card(m, 'a').tool).toBe('edit_file')
    expect(card(m, 'a').since).toBe(5)
    expect(m.totals).toEqual({ agents: 7, working: 2, attention: 0, stuck: 1, offline: 1, unclaimed: 0 })
  })

  it('不在干活时不带工具名（MemberStatus 里可能留着刚调完的那个）', () => {
    const m = buildCanvasModel(base({ memberStatus: { a: st('idle', { tool: 'read_file' }) } }))
    expect(card(m, 'a').tool).toBeUndefined()
  })

  it('手上的任务只留这个项目的；职位写名字；后台命令数带上', () => {
    const m = buildCanvasModel(
      base({
        agents: [agent('a', 'r1')],
        roles: [{ id: 'r1', name: '前端' }],
        workspaceId: 'w1',
        memberStatus: {
          a: st('working', {
            commands: 2,
            tasks: [
              { ref: 'T-1', title: '这个项目的', workspaceId: 'w1' },
              { ref: 'T-9', title: '别的项目的', workspaceId: 'w2' }
            ]
          })
        }
      })
    )
    expect(card(m, 'a').tasks).toEqual([{ ref: 'T-1', title: '这个项目的' }])
    expect(card(m, 'a').role).toBe('前端')
    expect(card(m, 'a').commands).toBe(2)
  })

  it('最后做的一件事：取最新的一条，别的项目的不算，失败的标出来', () => {
    const m = buildCanvasModel(
      base({
        workspaceId: 'w1',
        events: [
          event('a', 10, { path: 'old.ts', workspaceId: 'w1' }),
          event('a', 30, { summary: '改了 3 处', path: 'new.ts', workspaceId: 'w1' }),
          event('a', 50, { path: 'other.ts', workspaceId: 'w2' }),
          event('b', 20, { tool: 'run_command', status: 'error' })
        ]
      })
    )
    expect(card(m, 'a').last).toEqual({ ts: 30, tool: 'edit_file', text: '改了 3 处' })
    expect(card(m, 'b').last).toEqual({ ts: 20, tool: 'run_command', failed: true })
  })

  it('memberIds 只画指定的成员', () => {
    const m = buildCanvasModel(base({ memberIds: ['b'] }))
    expect(m.cards.map((c) => c.id)).toEqual(['b'])
    expect(m.totals.agents).toBe(1)
  })
})

describe('等你', () => {
  it('没回答的问题记在提问的人头上；答过的、关掉的不算', () => {
    const q = (id: string, status: 'open' | 'answered' | 'closed', askedAt: number) => ({ id, text: `问题${id}`, askedBy: 'a', askedByName: 'A', askedAt, status })
    const t = task({ assigneeId: 'a', status: 'in_progress', questions: [q('q1', 'answered', 1), q('q2', 'open', 9), q('q3', 'closed', 3), q('q4', 'open', 4)] })
    const m = buildCanvasModel(base({ tasks: [t] }))
    expect(card(m, 'a').attention).toEqual([
      { kind: 'question', taskRef: t.ref, taskTitle: t.title, text: '问题q4', questionId: 'q4', since: 4 },
      { kind: 'question', taskRef: t.ref, taskTitle: t.title, text: '问题q2', questionId: 'q2', since: 9 }
    ])
    expect(m.totals.attention).toBe(2)
  })

  it('用户派的活等验收算等你；AI 派给 AI 的等验收不算', () => {
    const mine = task({ assigneeId: 'a', status: 'review', result: '做完了', updatedAt: 77 })
    const theirs = task({ assigneeId: 'b', status: 'review', createdBy: 'a', managedBy: 'a' })
    const m = buildCanvasModel(base({ tasks: [mine, theirs] }))
    expect(card(m, 'a').attention).toEqual([{ kind: 'review', taskRef: mine.ref, taskTitle: mine.title, text: '做完了', since: 77 }])
    expect(card(m, 'b').attention).toEqual([])
  })

  it('交付了还没看：做完的、没有别的 AI 验收的才算；看过、全部看过、太早的、之后没再动的不算', () => {
    const now = 10 * 24 * 3600 * 1000
    const fromUser = task({ assigneeId: 'a', status: 'done', result: '好了', updatedAt: now - 1000 })
    const selfMade = task({ assigneeId: 'b', createdBy: 'b', status: 'done', updatedAt: now - 2000 })
    const reviewedByAi = task({ assigneeId: 'b', createdBy: 'a', managedBy: 'a', status: 'done', updatedAt: now - 1000 })
    const old = task({ assigneeId: 'a', status: 'done', updatedAt: now - 4 * 24 * 3600 * 1000 })
    const tasks = [fromUser, selfMade, reviewedByAi, old]
    // 不给 now：不提醒
    expect(buildCanvasModel(base({ tasks })).totals.attention).toBe(0)
    const m = buildCanvasModel(base({ tasks, now }))
    expect(card(m, 'a').attention).toEqual([{ kind: 'delivered', taskRef: fromUser.ref, taskTitle: fromUser.title, text: '好了', since: now - 1000 }])
    expect(card(m, 'b').attention.map((x) => x.taskRef)).toEqual([selfMade.ref])
    // 看过一条
    const seen = buildCanvasModel(base({ tasks, now, acks: { [fromUser.ref]: now - 500 } }))
    expect(card(seen, 'a').attention).toEqual([])
    expect(seen.totals.attention).toBe(1)
    // 看过以后任务又动了：又算没看
    expect(buildCanvasModel(base({ tasks, now, acks: { [fromUser.ref]: now - 5000 } })).totals.attention).toBe(2)
    // 全部看过
    expect(buildCanvasModel(base({ tasks, now, ackAll: now - 10 })).totals.attention).toBe(0)
    // 窗口可以调
    expect(buildCanvasModel(base({ tasks, now, deliveredWindowMs: 30 * 24 * 3600 * 1000 })).totals.attention).toBe(3)
  })

  it('AI 在等群消息不算等你', () => {
    const m = buildCanvasModel(base({ memberStatus: { a: st('waiting') } }))
    expect(m.totals.attention).toBe(0)
    expect(card(m, CANVAS_USER_ID)).toBeUndefined()
  })

  it('有事等用户时出现用户那张卡片，排在最前', () => {
    const t = task({ assigneeId: 'a', createdBy: 'a', status: 'in_progress', questions: [{ id: 'q1', text: '?', askedBy: 'a', askedByName: 'A', askedAt: 1, status: 'open' }] })
    const m = buildCanvasModel(base({ tasks: [t] }))
    expect(m.cards[0]).toMatchObject({ id: CANVAS_USER_ID, kind: 'user' })
    expect(m.lines).toEqual([])
  })
})

describe('线', () => {
  it('派活的线从派活的人到干活的人，同一对人并成一条，要紧的任务在前', () => {
    const t1 = task({ assigneeId: 'b', createdBy: 'a', status: 'todo' })
    const t2 = task({ assigneeId: 'b', createdBy: 'x', managedBy: 'a', status: 'blocked' })
    const t3 = task({ assigneeId: 'b', createdBy: 'a', status: 'in_progress' })
    const m = buildCanvasModel(base({ tasks: [t1, t2, t3] }))
    expect(m.lines).toHaveLength(1)
    expect(m.lines[0]).toMatchObject({ id: 'task:a>b', kind: 'task', from: 'a', to: 'b', state: 'blocked' })
    expect(m.lines[0].tasks!.map((t) => t.ref)).toEqual([t2.ref, t3.ref, t1.ref])
  })

  it('用户派的活连到用户那张卡片', () => {
    const m = buildCanvasModel(base({ tasks: [task({ assigneeId: 'a', status: 'in_progress' })] }))
    expect(m.lines[0]).toMatchObject({ from: CANVAS_USER_ID, to: 'a', state: 'in_progress' })
    expect(m.cards[0].id).toBe(CANVAS_USER_ID)
  })

  it('接力线：两头都在画布上的才画，带上存储里的 id', () => {
    const m = buildCanvasModel(base({ relays: [{ id: 'r_1', from: 'a', to: 'b' }, { id: 'r_2', from: 'a', to: 'gone' }] }))
    expect(m.lines).toEqual([{ id: 'relay:r_1', kind: 'relay', from: 'a', to: 'b', relayId: 'r_1' }])
  })

  it('不画的：做完的、没人接的、自己给自己建的、两头有一头不在画布上的', () => {
    const tasks = [
      task({ assigneeId: 'a', createdBy: 'b', status: 'done' }),
      task({ createdBy: 'b' }),
      task({ assigneeId: 'a', createdBy: 'a' }),
      task({ assigneeId: 'a', createdBy: 'gone' }),
      task({ assigneeId: 'gone', createdBy: 'a' })
    ]
    expect(buildCanvasModel(base({ tasks })).lines).toEqual([])
    const withDone = buildCanvasModel(base({ tasks, includeDone: true }))
    expect(withDone.lines).toHaveLength(1)
    expect(withDone.lines[0]).toMatchObject({ from: 'b', to: 'a', state: 'done' })
  })
})

describe('任务卡片', () => {
  it('没做完的都有；没人接的排前面，再按最近改动；数出没人接的和没回答的问题', () => {
    const t1 = task({ assigneeId: 'a', status: 'in_progress', updatedAt: 10 })
    const t2 = task({ updatedAt: 5, priority: 'high' })
    const t3 = task({ assigneeId: 'b', status: 'done' })
    const t4 = task({ updatedAt: 9, createdBy: 'a', questions: [{ id: 'q1', text: '?', askedBy: 'a', askedByName: 'A', askedAt: 1, status: 'open' }] })
    const m = buildCanvasModel(base({ tasks: [t1, t2, t3, t4] }))
    expect(m.tasks.map((t) => t.ref)).toEqual([t4.ref, t2.ref, t1.ref])
    expect(m.tasks[0]).toEqual({ id: `task:${t4.ref}`, ref: t4.ref, title: t4.title, status: 'todo', priority: 'normal', fromId: 'a', openQuestions: 1, updatedAt: 9 })
    expect(m.tasks[2]).toMatchObject({ assigneeId: 'a', fromId: CANVAS_USER_ID, status: 'in_progress' })
    expect(m.totals.unclaimed).toBe(2)
    expect(buildCanvasModel(base({ tasks: [t1, t2, t3, t4], includeDone: true })).tasks).toHaveLength(4)
  })
})

describe('框', () => {
  const channel = { id: 'ws:w1', name: '项目' }

  it('有主脑：一个团队框，主脑排第一，主脑到每个子代理一条线', () => {
    const m = buildCanvasModel(base({ agents: [agent('a'), agent('b'), agent('c')], channel: { ...channel, title: '起的名字', leadId: 'b' } }))
    expect(m.frames).toEqual([{ id: 'team:ws:w1', kind: 'team', title: '起的名字', leadId: 'b', cardIds: ['b', 'a', 'c'] }])
    expect(m.lines.map((l) => l.id)).toEqual(['team:b>a', 'team:b>c'])
    expect(card(m, 'b').lead).toBe(true)
    expect(card(m, 'a').lead).toBeUndefined()
  })

  it('选过子代理就只算选的；不在画布上的丢掉', () => {
    const m = buildCanvasModel(base({ agents: [agent('a'), agent('b'), agent('c')], channel: { ...channel, leadId: 'a', subIds: ['c', 'gone'] } }))
    expect(m.frames[0].cardIds).toEqual(['a', 'c'])
    expect(m.lines.map((l) => l.id)).toEqual(['team:a>c'])
  })

  it('没有主脑：讨论框，没有团队线；主脑不在画布上也按没有主脑算', () => {
    const m = buildCanvasModel(base({ channel: { ...channel, partIds: ['b'] } }))
    expect(m.frames).toEqual([{ id: 'team:ws:w1', kind: 'brainstorm', title: '项目', cardIds: ['b'] }])
    expect(m.lines).toEqual([])
    const gone = buildCanvasModel(base({ channel: { ...channel, leadId: 'gone' } }))
    expect(gone.frames[0]).toMatchObject({ kind: 'brainstorm', cardIds: ['a', 'b'] })
  })

  it('不给频道就没有框', () => {
    expect(buildCanvasModel(base()).frames).toEqual([])
  })
})
