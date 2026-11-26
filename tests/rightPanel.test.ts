// 类 Codex 界面第 3 步：右栏（变更 / 任务 / 活动）用到的纯函数
import { describe, expect, it } from 'vitest'
import { changeGroups, focusGroup, GROUP_GAP_MS, panelTasks, panelWorkspaceId, previewLines } from '../src/renderer/src/lib/rightPanel'
import { changeCards } from '../src/renderer/src/lib/changeCards'
import type { BridgeState, CheckpointStepView, GroupMessage, TaskItem } from '../src/core/types'

const T0 = 1_700_000_000_000
const MIN = 60_000

const state = (active = 'w_b'): BridgeState =>
  ({
    activeWorkspaceId: active,
    workspaces: [
      { id: 'w_m', name: '整台电脑', root: 'C:/', kind: 'machine', exists: true },
      { id: 'w_a', name: 'alpha', root: 'D:/alpha', exists: true },
      { id: 'w_b', name: 'beta', root: 'D:/beta', exists: true }
    ],
    agents: [],
    chat: {
      channels: [
        { id: 'general', name: '大厅', unread: 0, mentions: 0 },
        { id: 'ws:w_a', name: 'alpha', workspaceId: 'w_a', unread: 0, mentions: 0 },
        { id: 'ws:w_a.c_0123456789', name: '登录改版', workspaceId: 'w_a', thread: true, unread: 0, mentions: 0 },
        { id: 'ws:w_b', name: 'beta', workspaceId: 'w_b', unread: 0, mentions: 0 }
      ]
    }
  }) as unknown as BridgeState

let n = 0
const step = (p: Partial<CheckpointStepView> & { ts: number }): CheckpointStepView => ({
  id: `cp_${++n}`,
  seq: n,
  agentId: 'a1',
  agentName: 'Alice',
  session: 's1',
  task: null,
  tool: 'edit_file',
  kind: 'edit',
  files: [{ path: 'src/a.ts', change: 'modified', additions: 2, deletions: 1 }] as CheckpointStepView['files'],
  additions: 2,
  deletions: 1,
  rolledBack: 'none',
  skipped: [],
  ...p
})

describe('右栏看哪个项目', () => {
  it('首页开着某个会话：看这个会话所在的项目，不管当前工作区是哪个', () => {
    expect(panelWorkspaceId(state('w_b'), { section: 'overview', home: { kind: 'channel', channel: 'ws:w_a.c_0123456789' } })).toBe('w_a')
    expect(panelWorkspaceId(state('w_b'), { section: 'overview', home: { kind: 'channel', channel: 'ws:w_a' } })).toBe('w_a')
  })
  it('首页开着某个任务：看这个任务所在的项目（整台电脑也算）', () => {
    expect(panelWorkspaceId(state('w_b'), { section: 'overview', home: { kind: 'task', workspaceId: 'w_m', taskId: 't_1' } })).toBe('w_m')
  })
  it('首页什么都没选（新会话页）、大厅、概览：看当前工作区', () => {
    expect(panelWorkspaceId(state('w_b'), { section: 'overview' })).toBe('w_b')
    expect(panelWorkspaceId(state('w_b'), { section: 'overview', home: { kind: 'channel', channel: 'general' } })).toBe('w_b')
    expect(panelWorkspaceId(state('w_b'), { section: 'overview', home: { kind: 'overview' } })).toBe('w_b')
  })
  it('群聊页：看选中的频道所在的项目；没选或选的没了，就是当前工作区的频道', () => {
    expect(panelWorkspaceId(state('w_b'), { section: 'group', navId: 'ws:w_a' })).toBe('w_a')
    expect(panelWorkspaceId(state('w_b'), { section: 'group' })).toBe('w_b')
    expect(panelWorkspaceId(state('w_b'), { section: 'group', navId: 'ws:w_gone' })).toBe('w_b')
    expect(panelWorkspaceId(state('w_b'), { section: 'group', navId: 'general' })).toBe('w_b')
  })
  it('别的页面不看 id（任务页的 id 是任务编号）：当前工作区', () => {
    expect(panelWorkspaceId(state('w_b'), { section: 'tasks', navId: 'ws:w_a' })).toBe('w_b')
    expect(panelWorkspaceId(state('w_b'), { section: 'files', home: { kind: 'channel', channel: 'ws:w_a' } })).toBe('w_b')
  })
  it('会话所在的项目已经移除了：退回当前工作区；一个工作区都没有时是 undefined', () => {
    expect(panelWorkspaceId(state('w_b'), { section: 'overview', home: { kind: 'channel', channel: 'ws:w_gone.c_0123456789' } })).toBe('w_b')
    const empty = { workspaces: [], agents: [], chat: { channels: [] } } as unknown as BridgeState
    expect(panelWorkspaceId(empty, { section: 'overview' })).toBeUndefined()
  })
})

describe('最近的改动', () => {
  it('同一个 AI、同一个会话里连着改的几步算一次，文件合在一起，新的在前', () => {
    const steps = [
      step({ ts: T0 }),
      step({ ts: T0 + MIN, files: [{ path: 'src/b.ts', change: 'added', additions: 5, deletions: 0 }] as CheckpointStepView['files'] }),
      step({ ts: T0 + 2 * MIN }),
      step({ ts: T0 + 3 * MIN, agentId: 'a2', agentName: 'Bob', session: 's2' })
    ]
    const g = changeGroups(steps)
    expect(g.map((x) => x.agentName)).toEqual(['Bob', 'Alice'])
    expect(g[1].stepIds).toEqual([steps[0].id, steps[1].id, steps[2].id])
    expect(g[1].id).toBe(steps[2].id)
    expect(g[1].files).toEqual([
      { path: 'src/a.ts', change: 'modified', additions: 4, deletions: 2 },
      { path: 'src/b.ts', change: 'added', additions: 5, deletions: 0 }
    ])
    expect([g[1].additions, g[1].deletions, g[1].firstTs, g[1].lastTs]).toEqual([9, 2, T0, T0 + 2 * MIN])
  })
  it('隔得太久、或者换了会话，就是另一次改动；别的 AI 夹在中间不打断', () => {
    const a1 = step({ ts: T0 })
    const b1 = step({ ts: T0 + MIN, agentId: 'a2', agentName: 'Bob', session: 's2' })
    const a2 = step({ ts: T0 + 2 * MIN })
    const a3 = step({ ts: T0 + 2 * MIN + GROUP_GAP_MS + 1 })
    const a4 = step({ ts: T0 + 2 * MIN + GROUP_GAP_MS + 2, session: 's9' })
    const g = changeGroups([a4, a3, a2, b1, a1])
    expect(g.map((x) => x.stepIds)).toEqual([[a4.id], [a3.id], [a1.id, a2.id], [b1.id]])
  })
  it('回滚那一步本身不算改动；没有文件的不列；limit 只留最新的几次', () => {
    const steps = [
      step({ ts: T0 }),
      step({ ts: T0 + 20 * MIN, kind: 'rollback' }),
      step({ ts: T0 + 40 * MIN, files: [] }),
      step({ ts: T0 + 60 * MIN }),
      step({ ts: T0 + 80 * MIN })
    ]
    expect(changeGroups(steps).map((x) => x.id)).toEqual([steps[4].id, steps[3].id, steps[0].id])
    expect(changeGroups(steps, { limit: 2 }).map((x) => x.id)).toEqual([steps[4].id, steps[3].id])
    expect(changeGroups([])).toEqual([])
  })
  it('撤销状态：全撤了是 all，撤了一部分是 partial', () => {
    expect(changeGroups([step({ ts: T0, rolledBack: 'all' }), step({ ts: T0 + MIN, rolledBack: 'all' })])[0].rolledBack).toBe('all')
    expect(changeGroups([step({ ts: T0, rolledBack: 'all' }), step({ ts: T0 + MIN })])[0].rolledBack).toBe('partial')
    expect(changeGroups([step({ ts: T0, rolledBack: 'partial' })])[0].rolledBack).toBe('partial')
    expect(changeGroups([step({ ts: T0 })])[0].rolledBack).toBe('none')
  })
  it('先新建后修改还是新建；之后删了算删除', () => {
    const f = (change: string): CheckpointStepView['files'] => [{ path: 'x.ts', change, additions: 1, deletions: 0 }] as CheckpointStepView['files']
    expect(changeGroups([step({ ts: T0, files: f('added') }), step({ ts: T0 + 1, files: f('modified') })])[0].files[0].change).toBe('added')
    expect(changeGroups([step({ ts: T0, files: f('added') }), step({ ts: T0 + 1, files: f('deleted') })])[0].files[0].change).toBe('deleted')
  })
})

describe('聊天里点「查看变更」', () => {
  it('摆出来的就是那张卡片的那几步，数字和卡片上的一样', () => {
    const s1 = step({ ts: T0 + MIN })
    const s2 = step({ ts: T0 + 2 * MIN, files: [{ path: 'src/b.ts', change: 'added', additions: 3, deletions: 0 }] as CheckpointStepView['files'] })
    const later = step({ ts: T0 + 5 * MIN })
    const msg = { id: 'm1', seq: 1, ts: T0 + 3 * MIN, channel: 'ws:w_a', from: { kind: 'agent', id: 'a1', name: 'Alice' }, text: '好了', mentions: [] } as unknown as GroupMessage
    const card = changeCards([msg], [s1, s2, later]).get('m1')
    expect(card?.stepIds).toEqual([s1.id, s2.id])
    const g = focusGroup([later, s2, s1], card?.stepIds ?? [])
    expect(g?.stepIds).toEqual([s1.id, s2.id])
    expect(g?.files).toEqual(card?.files)
    expect([g?.additions, g?.deletions]).toEqual([card?.additions, card?.deletions])
  })
  it('那几步已经不在拉到的记录里：没有', () => {
    expect(focusGroup([step({ ts: T0 })], ['cp_gone'])).toBeUndefined()
    expect(focusGroup([], ['cp_1'])).toBeUndefined()
  })
})

describe('右栏的任务', () => {
  const task = (id: string, status: TaskItem['status'], updatedAt: number): TaskItem => ({ id, ref: `T-${id}`, title: id, status, updatedAt }) as unknown as TaskItem
  it('没做完的在上面：进行中、待审查、受阻、待办，各自新的在前；做完的另外收着', () => {
    const r = panelTasks([task('todo1', 'todo', 5), task('done1', 'done', 9), task('rev', 'review', 1), task('ip-old', 'in_progress', 2), task('blk', 'blocked', 8), task('ip-new', 'in_progress', 7), task('done2', 'done', 10)])
    expect(r.open.map((t) => t.id)).toEqual(['ip-new', 'ip-old', 'rev', 'blk', 'todo1'])
    expect(r.done.map((t) => t.id)).toEqual(['done2', 'done1'])
  })
  it('不改传进来的数组', () => {
    const list = [task('b', 'todo', 1), task('a', 'in_progress', 2)]
    panelTasks(list)
    expect(list.map((t) => t.id)).toEqual(['b', 'a'])
    expect(panelTasks([])).toEqual({ open: [], done: [] })
  })
})

describe('预览文件全文', () => {
  it('按行切，CRLF 也认，结尾的空行不算一行', () => {
    expect(previewLines('a\r\nb\r\n')).toEqual({ lines: ['a', 'b'], more: 0 })
    expect(previewLines('a\n\nb')).toEqual({ lines: ['a', '', 'b'], more: 0 })
    expect(previewLines('')).toEqual({ lines: [''], more: 0 })
  })
  it('太长只留前面的，说还有多少行', () => {
    const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n')
    expect(previewLines(text, 4)).toEqual({ lines: ['l0', 'l1', 'l2', 'l3'], more: 6 })
  })
})
