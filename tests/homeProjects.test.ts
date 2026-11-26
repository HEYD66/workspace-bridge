// 首页的项目侧栏和群聊里的改动卡片：界面用的纯函数
import { describe, expect, it } from 'vitest'
import { CARD_WINDOW_MS, changeCards } from '../src/renderer/src/lib/changeCards'
import { homeId, parseHomeId, projectRows, recentItems } from '../src/renderer/src/lib/projects'
import type { BridgeState, CheckpointStepView, GroupMessage, TaskItem } from '../src/core/types'

const T0 = 1_700_000_000_000
const task = (over: Partial<TaskItem>): TaskItem =>
  ({ id: 't1', ref: 'T-1', title: '任务', description: '', status: 'todo', priority: 'normal', createdBy: 'user', createdByName: '你', createdAt: T0, updatedAt: T0, history: [], ...over }) as TaskItem

const state = (over: Partial<BridgeState> = {}): BridgeState =>
  ({
    activeWorkspaceId: 'w_b',
    workspaces: [
      { id: 'w_m', name: '整台电脑', root: 'C:/', kind: 'machine', exists: true },
      { id: 'w_a', name: 'alpha', root: 'D:/alpha', exists: true },
      { id: 'w_b', name: 'beta', root: 'D:/beta', exists: true }
    ],
    agents: [],
    chat: {
      unread: 3,
      mentions: 0,
      channels: [
        { id: 'general', name: '大厅', unread: 1, mentions: 0, lastTs: T0 + 50 },
        { id: 'ws:w_a', name: 'alpha', workspaceId: 'w_a', unread: 2, mentions: 0, lastTs: T0 + 300, leadId: 'a1' },
        { id: 'ws:w_b', name: 'beta', workspaceId: 'w_b', unread: 0, mentions: 0, lastTs: 0 }
      ]
    },
    ...over
  }) as unknown as BridgeState

describe('首页：nav id', () => {
  it('频道和任务的 id 来回转；频道 id 里的冒号不碍事；不认识的当没有', () => {
    for (const t of [
      { kind: 'channel', channel: 'general' },
      { kind: 'channel', channel: 'ws:w_1a2b3c4d' },
      { kind: 'task', workspaceId: 'w_1a2b3c4d', taskId: 't_9' }
    ] as const)
      expect(parseHomeId(homeId(t))).toEqual(t)
    expect(homeId({ kind: 'channel', channel: 'ws:w_a' })).toBe('ch:ws:w_a')
    for (const bad of [undefined, '', 'ch:', 'task:', 'task:w_a', 'task:|t', 'task:w_a|', 'step:abc']) expect(parseHomeId(bad)).toBeUndefined()
  })
})

describe('首页：项目列表', () => {
  const tasks = {
    w_a: [
      task({ id: 'a1', ref: 'T-1', status: 'todo', updatedAt: T0 + 400 }),
      task({ id: 'a2', ref: 'T-2', status: 'review', updatedAt: T0 + 100 }),
      task({ id: 'a3', ref: 'T-3', status: 'done', updatedAt: T0 + 900 }),
      task({ id: 'a4', ref: 'T-4', status: 'in_progress', updatedAt: T0 + 10 }),
      task({ id: 'a5', ref: 'T-5', status: 'in_progress', updatedAt: T0 + 20 })
    ],
    w_gone: [task({ id: 'g1', updatedAt: T0 + 5000 })]
  }

  it('目录工作区按列表顺序，「整台电脑」放最后；标出当前工作区', () => {
    const rows = projectRows(state(), tasks)
    expect(rows.map((r) => r.ws.id)).toEqual(['w_a', 'w_b', 'w_m'])
    expect(rows.map((r) => r.active)).toEqual([false, true, false])
  })

  it('每个项目带它的频道、没做完的任务（进行中、待审查、受阻、待办，各自新的在前）、待审查数', () => {
    const [a, b, m] = projectRows(state(), tasks)
    expect(a.channel?.id).toBe('ws:w_a')
    expect(a.channel?.leadId).toBe('a1')
    expect(a.open.map((t) => t.id)).toEqual(['a5', 'a4', 'a2', 'a1'])
    expect(a.review).toBe(1)
    // 最近有动静的时间：频道和任务（含做完的）里最新的
    expect(a.lastTs).toBe(T0 + 900)
    expect(b.open).toEqual([])
    expect(b.lastTs).toBe(0)
    // 旧版主进程没给这个频道
    expect(m.channel).toBeUndefined()
  })

  it('旧版主进程没有 chat、没有 workspaces 时不报错', () => {
    expect(projectRows({ agents: [] } as unknown as BridgeState, {})).toEqual([])
    expect(recentItems({ agents: [] } as unknown as BridgeState, {})).toEqual([])
  })

  it('最近：频道和任务合在一起，新的在前；没消息的频道、已移除工作区的任务不列；带项目名', () => {
    const r = recentItems(state(), tasks, 4)
    expect(r.map((x) => x.key)).toEqual(['task:w_a|a3', 'task:w_a|a1', 'ch:ws:w_a', 'task:w_a|a2'])
    expect(r[0]).toMatchObject({ title: 'T-3 任务', project: 'alpha', status: 'done', target: { kind: 'task', workspaceId: 'w_a', taskId: 'a3' } })
    expect(r[2]).toMatchObject({ title: '群聊', project: 'alpha', unread: 2, target: { kind: 'channel', channel: 'ws:w_a' } })
    const all = recentItems(state(), tasks, 50)
    expect(all.some((x) => x.key.includes('g1'))).toBe(false)
    expect(all.some((x) => x.key === 'ch:ws:w_b')).toBe(false)
    const lobby = all.find((x) => x.key === 'ch:general')
    expect(lobby?.title).toBe('大厅')
    expect(lobby?.project).toBeUndefined()
  })
})

describe('群聊：改动卡片', () => {
  const msg = (id: string, from: string, ts: number, over: Partial<GroupMessage> = {}): GroupMessage =>
    ({ id, seq: 1, ts, channel: 'ws:w_a', from: from === 'user' ? { kind: 'user', id: 'user', name: '你' } : { kind: 'agent', id: from, name: from }, text: 'x', mentions: [], ...over }) as unknown as GroupMessage
  const step = (id: string, agentId: string, ts: number, files: [string, number, number, ('added' | 'modified' | 'deleted')?][], over: Partial<CheckpointStepView> = {}): CheckpointStepView =>
    ({
      id,
      seq: 1,
      ts,
      agentId,
      agentName: agentId,
      session: 's',
      task: null,
      tool: 'edit_file',
      kind: 'edit',
      files: files.map(([path, additions, deletions, change]) => ({ path, change: change ?? 'modified', additions, deletions })),
      additions: 0,
      deletions: 0,
      rolledBack: 'none',
      skipped: [],
      ...over
    }) as CheckpointStepView

  it('AI 的消息带上它从上一条消息到这一条之间的改动；同一个文件的行数加起来', () => {
    const cards = changeCards(
      [msg('m1', 'bob', T0 + 1000), msg('m2', 'bob', T0 + 5000)],
      [step('c3', 'bob', T0 + 4000, [['a.ts', 3, 1]]), step('c1', 'bob', T0 + 500, [['old.ts', 1, 1]]), step('c2', 'bob', T0 + 2000, [['a.ts', 10, 0, 'added'], ['b.ts', 2, 2]])]
    )
    expect(cards.get('m1')).toMatchObject({ stepIds: ['c1'], additions: 1, deletions: 1 })
    expect(cards.get('m2')).toEqual({
      stepIds: ['c2', 'c3'],
      files: [
        { path: 'a.ts', change: 'added', additions: 13, deletions: 1 },
        { path: 'b.ts', change: 'modified', additions: 2, deletions: 2 }
      ],
      additions: 15,
      deletions: 3,
      rolledBack: 'none'
    })
  })

  it('只算这个 AI 自己的改动；用户的消息、私聊、没有改动的消息没有卡片；回滚那一步不算改动', () => {
    const cards = changeCards(
      [msg('u', 'user', T0 + 900), msg('m1', 'bob', T0 + 1000), msg('p', 'carol', T0 + 1500, { to: 'bob' }), msg('m2', 'carol', T0 + 2000), msg('m3', 'bob', T0 + 3000)],
      [step('c1', 'carol', T0 + 800, [['c.ts', 1, 0]]), step('c2', 'bob', T0 + 2500, [['x.ts', 1, 0]], { kind: 'rollback' })]
    )
    expect([...cards.keys()]).toEqual(['m2'])
    expect(cards.get('m2')?.stepIds).toEqual(['c1'])
  })

  it('没有上一条消息时最多往前算两小时；正好卡在消息时间上的算这条的', () => {
    const cards = changeCards(
      [msg('m1', 'bob', T0)],
      [step('old', 'bob', T0 - CARD_WINDOW_MS - 1, [['old.ts', 1, 0]]), step('in', 'bob', T0 - CARD_WINDOW_MS + 1, [['in.ts', 1, 0]]), step('edge', 'bob', T0, [['edge.ts', 1, 0]]), step('after', 'bob', T0 + 1, [['after.ts', 1, 0]])]
    )
    expect(cards.get('m1')?.files.map((f) => f.path)).toEqual(['in.ts', 'edge.ts'])
  })

  it('已撤销的标记：全退回是 all，退了一部分是 partial；先建后删的文件算删除', () => {
    const one = (a: CheckpointStepView['rolledBack'], b: CheckpointStepView['rolledBack']) =>
      changeCards([msg('m1', 'bob', T0 + 10)], [step('c1', 'bob', T0 + 1, [['a.ts', 1, 0, 'added']], { rolledBack: a }), step('c2', 'bob', T0 + 2, [['a.ts', 0, 1, 'deleted']], { rolledBack: b })]).get('m1')
    expect(one('all', 'all')?.rolledBack).toBe('all')
    expect(one('all', 'none')?.rolledBack).toBe('partial')
    expect(one('partial', 'none')?.rolledBack).toBe('partial')
    expect(one('none', 'none')?.rolledBack).toBe('none')
    expect(one('none', 'none')?.files).toEqual([{ path: 'a.ts', change: 'deleted', additions: 1, deletions: 1 }])
  })

  it('没有检查点时什么都不挂', () => {
    expect(changeCards([msg('m1', 'bob', T0)], []).size).toBe(0)
  })
})
