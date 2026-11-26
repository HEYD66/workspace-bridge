import { describe, expect, it } from 'vitest'
import type { ActivityEvent, GroupChannelInfo, MemberStatus, TaskItem } from '../src/core/types'
import { agentOfKey, buildBoard, CARD_GAP, CARD_H, CARD_W, cardKey, FRAME_HEADER, FRAME_PAD, frameKey, homeOf, layoutBoard, LOBBY_GROUP, tidyGroup, type BoardInput, type Box } from '../src/renderer/src/lib/canvasBoard'

const agent = (id: string) => ({ id, name: id.toUpperCase(), color: '#fff' })
const st = (status: MemberStatus['status'], extra: Partial<MemberStatus> = {}): MemberStatus => ({ status, sessions: status === 'offline' ? 0 : 1, ...extra })
let n = 0
const task = (ws: string, patch: Partial<TaskItem>): TaskItem =>
  ({ id: `t_${++n}`, ref: `T-${n}`, title: `task ${n}`, description: '', status: 'todo', priority: 'normal', createdBy: 'user', createdAt: 1, updatedAt: n, history: [], workspaceId: ws, ...patch }) as unknown as TaskItem
const channel = (ws: string, patch: Partial<GroupChannelInfo> = {}): GroupChannelInfo => ({ id: `ws:${ws}`, name: ws, workspaceId: ws, unread: 0, mentions: 0, lastTs: 0, ...patch })
const event = (agentId: string, ws: string | undefined, ts: number): ActivityEvent => ({ id: `e${ts}`, ts, agentId, agentName: agentId, agentColor: '#fff', tool: 'read_file', args: {}, status: 'ok', workspaceId: ws })

const WS = [{ id: 'w1', name: 'one' }, { id: 'w2', name: 'two' }, { id: 'wm', name: '整台电脑', kind: 'machine' as const }]
const base = (patch: Partial<BoardInput> = {}): BoardInput => ({ agents: ['a', 'b', 'c', 'd'].map(agent), workspaces: WS, tasksByWs: {}, ...patch })
const overlap = (p: Box, q: Box) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h

describe('homeOf：每个 AI 归哪个项目', () => {
  it('群聊里点过名的最优先，其次是进行中的任务、没做完的任务、最近动过手的项目', () => {
    const home = homeOf(
      base({
        channels: [channel('w1', { leadId: 'a', subIds: ['b'] }), channel('w2')],
        memberStatus: { a: st('working', { tasks: [{ ref: 'T-1', title: 'x', workspaceId: 'w2' }] }), c: st('working', { tasks: [{ ref: 'T-2', title: 'y', workspaceId: 'w2' }] }) },
        tasksByWs: { w1: [task('w1', { assigneeId: 'd', status: 'review' })] },
        events: [event('d', 'w2', 50)]
      })
    )
    expect(Object.fromEntries(home)).toEqual({ a: 'w1', b: 'w1', c: 'w2', d: 'w1' })
  })

  it('只在「整台电脑」和一个目录项目里都动过手：归目录项目；什么都不沾的不归任何项目', () => {
    const home = homeOf(base({ events: [event('a', 'wm', 90), event('a', 'w2', 10), event('b', 'wm', 5), event('c', undefined, 99)] }))
    expect(Object.fromEntries(home)).toEqual({ a: 'w2', b: 'wm' })
  })

  it('做完的任务不算', () => {
    expect(homeOf(base({ tasksByWs: { w1: [task('w1', { assigneeId: 'a', status: 'done' })] } })).size).toBe(0)
  })
})

describe('buildBoard：所有项目拼成一张图', () => {
  it('每个 AI 只有一张卡片；项目各一个框，空的目录项目也画，空的「整台电脑」不画；不沾项目的进「没在项目里」', () => {
    const b = buildBoard(base({ channels: [channel('w1', { leadId: 'a', subIds: ['b'] })], memberStatus: { a: st('working'), b: st('idle') } }))
    expect(b.groups.map((g) => [g.id, g.kind, g.cardKeys])).toEqual([
      ['w1', 'team', ['a@w1', 'b@w1']],
      ['w2', 'brainstorm', []],
      [LOBBY_GROUP, 'lobby', ['c@lobby', 'd@lobby']]
    ])
    expect(b.groups[0].leadKey).toBe('a@w1')
    expect(b.cards.map((c) => c.key)).toEqual(['a@w1', 'b@w1', 'c@lobby', 'd@lobby'])
    expect(b.cards[0].lead).toBe(true)
    expect(b.lines).toEqual([{ id: 'w1|team:a>b', kind: 'team', from: 'a@w1', to: 'b@w1' }])
    expect(b.totals).toEqual({ agents: 4, working: 1, attention: 0, stuck: 0, offline: 2, unclaimed: 0 })
    expect(b.groups[0].working).toBe(1)
  })

  it('没挑过子代理时，主脑的线只连到同一个项目里的卡片', () => {
    const b = buildBoard(base({ channels: [channel('w1', { leadId: 'a' })], memberStatus: { b: st('idle', { tasks: [{ ref: 'T-1', title: 'x', workspaceId: 'w1' }] }), c: st('idle', { tasks: [{ ref: 'T-2', title: 'y', workspaceId: 'w2' }] }) } }))
    expect(b.lines.filter((l) => l.kind === 'team').map((l) => [l.from, l.to])).toEqual([['a@w1', 'b@w1']])
  })

  it('派活的线可以跨框；同一对人在两个项目里的任务并成一条，最要紧的在前；有派活的线就不再画主脑的线', () => {
    const b = buildBoard(
      base({
        channels: [channel('w1', { leadId: 'a', subIds: ['b'] })],
        memberStatus: { c: st('idle', { tasks: [{ ref: 'T-9', title: 'z', workspaceId: 'w2' }] }) },
        tasksByWs: {
          w1: [task('w1', { createdBy: 'a', assigneeId: 'b', status: 'in_progress' }), task('w1', { createdBy: 'a', assigneeId: 'c', status: 'todo' })],
          w2: [task('w2', { createdBy: 'a', assigneeId: 'c', status: 'blocked' })]
        }
      })
    )
    const ac = b.lines.find((l) => l.id === 'task:a>c')!
    expect([ac.from, ac.to, ac.state]).toEqual(['a@w1', 'c@w2', 'blocked'])
    expect(ac.tasks!.map((t) => [t.status, t.workspaceId])).toEqual([['blocked', 'w2'], ['todo', 'w1']])
    expect(b.lines.map((l) => l.id).sort()).toEqual(['task:a>b', 'task:a>c'])
  })

  it('要用户处理的事：别的项目里的也记到那张卡片上，带着项目；用户那张卡片排第一', () => {
    const b = buildBoard(
      base({
        channels: [channel('w1', { partIds: ['a'] })],
        tasksByWs: {
          w1: [task('w1', { assigneeId: 'a', status: 'review', updatedAt: 30 })],
          w2: [task('w2', { createdBy: 'a', assigneeId: 'a', status: 'in_progress', questions: [{ id: 'q1', text: '用哪个？', askedBy: 'a', askedAt: 10, status: 'open' }] as TaskItem['questions'] })]
        }
      })
    )
    expect(b.cards[0].key).toBe('user')
    const a = b.cards.find((c) => c.key === 'a@w1')!
    expect(a.attention.map((x) => [x.kind, x.workspaceId])).toEqual([['question', 'w2'], ['review', 'w1']])
    expect(b.totals.attention).toBe(2)
    expect(b.groups[0].attention).toBe(2)
    expect(b.lines.map((l) => [l.from, l.to])).toEqual([['user', 'a@w1']])
  })

  it('hideOffline：离线的不画，线跟着去掉，空了的「没在项目里」也去掉；总数照算；有事等用户的离线卡片留着', () => {
    const input = base({
      agents: ['a', 'b', 'c'].map(agent),
      channels: [channel('w1', { leadId: 'a', subIds: ['b'] })],
      memberStatus: { a: st('working') },
      tasksByWs: { w2: [task('w2', { assigneeId: 'c', status: 'review' })] },
      hideOffline: true
    })
    const b = buildBoard(input)
    expect(b.cards.map((c) => c.key)).toEqual(['user', 'a@w1', 'c@w2'])
    expect(b.lines.map((l) => l.id)).toEqual(['task:user>c'])
    expect(b.groups.map((g) => g.id)).toEqual(['w1', 'w2'])
    expect(b.totals.offline).toBe(2)
  })

  it('key 和 AI id 的换算', () => {
    expect(agentOfKey(cardKey('x@y', 'w1'))).toBe('x@y')
    expect(agentOfKey('user')).toBeUndefined()
  })
})

describe('layoutBoard：摆放', () => {
  const board = () =>
    buildBoard(
      base({
        agents: ['a', 'b', 'c', 'd', 'e', 'f'].map(agent),
        channels: [channel('w1', { partIds: ['a', 'b', 'c', 'd'] }), channel('w2', { partIds: ['e'] })],
        tasksByWs: { w1: [task('w1', { assigneeId: 'a' })] }
      })
    )

  it('第一次：每张卡片都有位置，一行最多三张，互不重叠；卡片在自己的框里；框互不重叠', () => {
    const b = board()
    const l = layoutBoard(b, {})
    const keys = b.cards.map((c) => c.key)
    expect(Object.keys(l.cards).sort()).toEqual([...keys].sort())
    for (const k of keys) expect(l.fresh[k]).toEqual({ x: l.cards[k].x, y: l.cards[k].y })
    const w1 = ['a@w1', 'b@w1', 'c@w1', 'd@w1'].map((k) => l.cards[k])
    expect(new Set(w1.slice(0, 3).map((r) => r.y)).size).toBe(1)
    expect(w1[3].y).toBeGreaterThan(w1[0].y)
    expect(w1[3].x).toBe(w1[0].x)
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) expect(overlap(l.cards[keys[i]], l.cards[keys[j]])).toBe(false)
    for (const g of b.groups) {
      const f = l.frames[g.id]
      for (const k of g.cardKeys) {
        const c = l.cards[k]
        expect(c.x >= f.x + FRAME_PAD && c.y >= f.y + FRAME_HEADER && c.x + c.w <= f.x + f.w - FRAME_PAD + 1 && c.y + c.h <= f.y + f.h - FRAME_PAD + 1).toBe(true)
      }
    }
    const ids = b.groups.map((g) => g.id)
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) expect(overlap(l.frames[ids[i]], l.frames[ids[j]])).toBe(false)
    // 用户那张在所有框的上面，左边对齐
    expect(l.cards.user.y + l.cards.user.h).toBeLessThan(Math.min(...ids.map((id) => l.frames[id].y)))
    expect(l.cards.user.x).toBe(Math.min(...ids.map((id) => l.frames[id].x)))
    expect(l.bounds).not.toBeNull()
  })

  it('新框排到给定的宽度就换行', () => {
    const b = board()
    const wide = layoutBoard(b, {}, undefined, { shelfWidth: 4000 })
    expect(new Set(b.groups.map((g) => wide.frames[g.id].y)).size).toBe(1)
    const narrow = layoutBoard(b, {}, undefined, { shelfWidth: 1000 })
    const ys = b.groups.map((g) => narrow.frames[g.id].y)
    expect(new Set(ys).size).toBeGreaterThan(1)
    expect(Math.max(...b.groups.map((g) => narrow.frames[g.id].x + narrow.frames[g.id].w)) - Math.min(...b.groups.map((g) => narrow.frames[g.id].x))).toBeLessThanOrEqual(1000)
    const ids = b.groups.map((g) => g.id)
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) expect(overlap(narrow.frames[ids[i]], narrow.frames[ids[j]])).toBe(false)
  })

  it('记过的位置照用，再算一次什么都不变', () => {
    const b = board()
    const first = layoutBoard(b, {})
    const second = layoutBoard(b, first.fresh)
    expect(second.fresh).toEqual({})
    expect(second.cards).toEqual(first.cards)
    expect(second.frames).toEqual(first.frames)
  })

  it('新来的卡片在自己的框里找空位，别的卡片不动', () => {
    const b = board()
    const first = layoutBoard(b, {})
    const saved = { ...first.fresh }
    delete saved['c@w1']
    const l = layoutBoard(b, saved)
    expect(Object.keys(l.fresh)).toEqual(['c@w1'])
    for (const k of Object.keys(saved)) expect(l.cards[k]).toEqual(first.cards[k])
    for (const k of ['a@w1', 'b@w1', 'd@w1']) expect(overlap(l.cards['c@w1'], l.cards[k])).toBe(false)
  })

  it('把一张卡片拖到别的框上：正在拖的框不动，被压住的框让开', () => {
    const b = board()
    const first = layoutBoard(b, {})
    const target = first.frames.w2
    const saved = { ...first.fresh, 'a@w1': { x: target.x + 10, y: target.y + 10 } }
    const l = layoutBoard(b, saved, 'w1')
    expect(l.cards['a@w1']).toMatchObject({ x: target.x + 10, y: target.y + 10 })
    expect(overlap(l.frames.w1, l.frames.w2)).toBe(false)
    expect(l.fresh['e@w2']).toBeDefined()
  })

  it('空框的位置记在框自己名下', () => {
    const b = buildBoard(base({ agents: [] }))
    const l = layoutBoard(b, {})
    expect(Object.keys(l.fresh).sort()).toEqual([frameKey('w1'), frameKey('w2')])
    const again = layoutBoard(b, { ...l.fresh, [frameKey('w1')]: { x: 900, y: 900 } })
    expect(again.frames.w1).toMatchObject({ x: 900, y: 900 })
    expect(again.fresh).toEqual({})
  })

  it('坏掉的位置（不是数）当没记过', () => {
    const b = board()
    const l = layoutBoard(b, { 'a@w1': { x: Number.NaN, y: 0 } })
    expect(Number.isFinite(l.cards['a@w1'].x)).toBe(true)
  })

  it('tidyGroup：从框的左上角起一行三张排整齐', () => {
    const at = tidyGroup({ cardKeys: ['p', 'q', 'r', 's'] }, { x: 100, y: 200, w: 0, h: 0 })
    expect(at.p).toEqual({ x: 100 + FRAME_PAD, y: 200 + FRAME_HEADER })
    expect(at.q.x).toBe(at.p.x + CARD_W + CARD_GAP)
    expect(at.s).toEqual({ x: at.p.x, y: at.p.y + CARD_H + CARD_GAP })
  })
})

describe('buildBoard：接力线、收纳、没人接的任务、交付未看', () => {
  const input = (patch: Partial<BoardInput> = {}): BoardInput =>
    base({
      channels: [channel('w1', { leadId: 'a', subIds: ['b'] }), channel('w2')],
      memberStatus: { a: st('idle'), b: st('idle'), c: st('offline'), d: st('offline') },
      ...patch
    })

  it('接力线画成单独的一种线，带着存储里的 id 和项目', () => {
    const b = buildBoard(input({ docs: { w1: { relays: [{ id: 'r_1', from: 'a', to: 'b', createdAt: 1 }], acks: {} } } }))
    const relay = b.lines.filter((l) => l.kind === 'relay')
    expect(relay).toEqual([{ id: 'relay:w1:r_1', kind: 'relay', from: cardKey('a', 'w1'), to: cardKey('b', 'w1'), workspaceId: 'w1', relayId: 'r_1' }])
  })

  it('收纳起来的不画，总数照算；有事等用户时自己出来', () => {
    const quiet = buildBoard(input({ archived: ['b'] }))
    expect(quiet.cards.map((c) => c.id)).not.toContain('b')
    expect(quiet.archived).toEqual([{ id: 'b', name: 'B', color: '#fff' }])
    expect(quiet.totals.agents).toBe(4)
    const asks = buildBoard(input({ archived: ['b'], tasksByWs: { w1: [task('w1', { assigneeId: 'b', status: 'in_progress', questions: [{ id: 'q1', text: '?', askedBy: 'b', askedAt: 1, status: 'open' }] } as Partial<TaskItem>)] } }))
    expect(asks.cards.map((c) => c.id)).toContain('b')
    expect(asks.archived.map((a) => a.id)).toEqual(['b'])
  })

  it('没人接的任务挂在项目的框上', () => {
    const b = buildBoard(input({ tasksByWs: { w1: [task('w1', { title: 'free' }), task('w1', { title: 'taken', assigneeId: 'a' })] } }))
    expect(b.groups.find((g) => g.id === 'w1')!.openTasks.map((t) => t.title)).toEqual(['free'])
    expect(b.groups.find((g) => g.id === 'w2')!.openTasks).toEqual([])
    expect(b.totals.unclaimed).toBe(1)
    expect(Object.keys(b.models).sort()).toEqual(['w1', 'w2', 'wm'])
  })

  it('交付了用户还没看：给了现在的时间才提醒；记过看过就不提醒', () => {
    const done = task('w1', { assigneeId: 'a', status: 'done', result: '做完了', updatedAt: 1000 })
    const kinds = (patch: Partial<BoardInput>) => buildBoard(input({ tasksByWs: { w1: [done] }, events: [event('a', 'w1', 5)], ...patch })).cards.find((c) => c.id === 'a')?.attention.map((x) => x.kind)
    expect(kinds({})).toEqual([])
    expect(kinds({ now: 2000 })).toEqual(['delivered'])
    expect(kinds({ now: 2000, docs: { w1: { relays: [], acks: { [done.ref]: 1500 } } } })).toEqual([])
    expect(kinds({ now: 2000, docs: { w1: { relays: [], acks: {}, ackAll: 1500 } } })).toEqual([])
  })
})
