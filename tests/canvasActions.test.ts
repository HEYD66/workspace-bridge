// 画布上动作背后的规则
import { describe, expect, it } from 'vitest'
import { planRelay, relayNotices, followTarget, planApplyTemplate, planAssign, planBroadcast, planJoinTeam, planLeaveTeam, planSetLead, rosterOrder, searchCanvas, templateFromTeam, currentSubs } from '../src/shared/canvasActions'
import type { CanvasCard, CanvasModel } from '../src/shared/canvasModel'

const card = (id: string, over: Partial<CanvasCard> = {}): CanvasCard => ({ id, kind: 'agent', name: id.toUpperCase(), state: 'idle', tasks: [], attention: [], ...over })
const user: CanvasCard = { id: 'user', kind: 'user', name: '你', state: 'idle', tasks: [], attention: [] }
const model = (...cards: CanvasCard[]): CanvasModel => ({ cards, frames: [], lines: [], tasks: [], totals: { agents: 0, working: 0, attention: 0, stuck: 0, offline: 0, unclaimed: 0 } })
const all = ['a', 'b', 'c', 'd']

describe('拉线派活', () => {
  const m = model(user, card('a'), card('b'))
  it('用户到 AI 是用户派活；AI 到 AI 是前一个当经理', () => {
    expect(planAssign(m, 'user', 'a')).toEqual({ kind: 'create', assigneeId: 'a' })
    expect(planAssign(m, 'a', 'b')).toEqual({ kind: 'create', assigneeId: 'b', managedBy: 'a' })
  })
  it('把任务卡片拖到 AI 上是改派，从哪拖来的不管', () => {
    expect(planAssign(m, 'task:T-3', 'b', 'T-3')).toEqual({ kind: 'reassign', taskRef: 'T-3', assigneeId: 'b' })
  })
  it('不行的：连到用户、连到自己、连到便签、从便签拉出来', () => {
    for (const [from, to] of [['a', 'user'], ['a', 'a'], ['a', 'n_1'], ['n_1', 'a']]) expect(planAssign(m, from, to).kind, `${from}>${to}`).toBe('invalid')
  })
})

describe('团队', () => {
  it('currentSubs：没挑过是主脑以外的全部；挑过只算挑的，不在项目里的丢掉', () => {
    expect(currentSubs({ leadId: 'a' }, all)).toEqual(['b', 'c', 'd'])
    expect(currentSubs({ leadId: 'a', subIds: ['c', 'gone', 'a'] }, all)).toEqual(['c'])
    expect(currentSubs({}, all)).toEqual([])
  })
  it('拖进框：没主脑时它当主脑；有主脑时加进子代理；已经在的不动', () => {
    expect(planJoinTeam({}, all, 'b')).toEqual({ kind: 'set', leadId: 'b', subIds: null })
    expect(planJoinTeam({ leadId: 'a', subIds: ['b'] }, all, 'c')).toEqual({ kind: 'set', leadId: 'a', subIds: ['b', 'c'] })
    expect(planJoinTeam({ leadId: 'a', subIds: ['b'] }, all, 'b').kind).toBe('none')
    expect(planJoinTeam({ leadId: 'a' }, all, 'c').kind).toBe('none')
    expect(planJoinTeam({ leadId: 'a' }, all, 'a').kind).toBe('none')
    expect(planJoinTeam({ leadId: 'a' }, all, 'zzz').kind).toBe('none')
  })
  it('拖出框：子代理是去掉它；主脑是解散；最后一个子代理拖走后是空名单不是「不挑」', () => {
    expect(planLeaveTeam({ leadId: 'a' }, all, 'c')).toEqual({ kind: 'set', leadId: 'a', subIds: ['b', 'd'] })
    expect(planLeaveTeam({ leadId: 'a', subIds: ['b'] }, all, 'b')).toEqual({ kind: 'set', leadId: 'a', subIds: [] })
    expect(planLeaveTeam({ leadId: 'a', subIds: ['b'] }, all, 'a')).toEqual({ kind: 'set', leadId: undefined, subIds: null })
    expect(planLeaveTeam({ leadId: 'a', subIds: ['b'] }, all, 'c').kind).toBe('none')
    expect(planLeaveTeam({}, all, 'a').kind).toBe('none')
  })
  it('换主脑：原主脑变子代理；原来没挑过的换完还是不挑', () => {
    expect(planSetLead({ leadId: 'a', subIds: ['b', 'c'] }, all, 'b')).toEqual({ kind: 'set', leadId: 'b', subIds: ['c', 'a'] })
    expect(planSetLead({ leadId: 'a', subIds: ['b'] }, all, 'd')).toEqual({ kind: 'set', leadId: 'd', subIds: ['b', 'a'] })
    expect(planSetLead({ leadId: 'a' }, all, 'b')).toEqual({ kind: 'set', leadId: 'b', subIds: null })
    expect(planSetLead({}, all, 'b')).toEqual({ kind: 'set', leadId: 'b', subIds: null })
    expect(planSetLead({ leadId: 'a' }, all, 'a').kind).toBe('none')
  })
  it('模板：存下现在的团队；套用时不在的成员跳过并报出来，主脑不在就套不了', () => {
    expect(templateFromTeam({ leadId: 'a', subIds: ['b'] }, all)).toEqual({ leadId: 'a', memberIds: ['b'] })
    const tpl = { id: 'tp_1', name: 't', leadId: 'a', memberIds: ['b', 'gone'], createdAt: 0 }
    expect(planApplyTemplate(tpl, all)).toEqual({ kind: 'set', leadId: 'a', subIds: ['b'], missing: ['gone'] })
    expect(planApplyTemplate({ ...tpl, leadId: 'gone2' }, all)).toMatchObject({ kind: 'none', missing: ['gone2', 'gone'] })
    expect(planApplyTemplate({ id: 'tp_2', name: 't', memberIds: ['b'], createdAt: 0 }, all).kind).toBe('none')
  })
})

describe('框选群发', () => {
  it('只发给 AI；不在线的照发但单独列出来', () => {
    const m = model(user, card('a', { name: 'Alice' }), card('b', { name: 'Bob', state: 'offline' }), card('c'))
    expect(planBroadcast(m, ['user', 'a', 'b', 'n_1'])).toEqual({
      to: [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }],
      away: [{ id: 'b', name: 'Bob', state: 'offline' }],
      mentions: '@Alice @Bob '
    })
  })
})

describe('名单、搜索、镜头', () => {
  it('名单：有事等你的最前，然后干活、等消息、空闲、卡住、暂停、离线；同档主脑在前', () => {
    const m = model(
      user,
      card('off', { state: 'offline' }),
      card('idle2'),
      card('idle1', { lead: true }),
      card('work', { state: 'working' }),
      card('ask', { state: 'offline', attention: [{ kind: 'review', taskRef: 'T-1', taskTitle: 't', since: 1 }] }),
      card('stuck', { state: 'stuck' }),
      card('wait', { state: 'waiting' })
    )
    expect(rosterOrder(m).map((c) => c.id)).toEqual(['ask', 'work', 'wait', 'idle1', 'idle2', 'stuck', 'off'])
  })

  it('搜索：名字、职位、任务、等你的事、最后做的事、便签；不分大小写', () => {
    const m = model(
      card('a', { name: 'Alice', role: '前端', tasks: [{ ref: 'T-7', title: '登录页' }], last: { ts: 1, tool: 'edit_file', text: 'src/Login.tsx' } }),
      card('b', { name: 'Bob', attention: [{ kind: 'question', taskRef: 'T-9', taskTitle: '数据库', text: '用哪个库？', since: 1 }] })
    )
    const notes = [{ id: 'n_1', text: '登录先别动', by: 'user', byName: '你', createdAt: 0, updatedAt: 0 }]
    const find = (q: string) => searchCanvas(m, { notes }, q).map((h) => `${h.id}:${h.where}`)
    expect(find('alice')).toEqual(['a:name'])
    expect(find('前端')).toEqual(['a:role'])
    expect(find('登录')).toEqual(['a:task', 'n_1:note'])
    expect(find('t-9')).toEqual(['b:attention'])
    expect(find('LOGIN')).toEqual(['a:last'])
    expect(find('  ')).toEqual([])
    expect(find('没有的')).toEqual([])
  })

  it('镜头跟随：跟最后有动作的干活的；现在跟的那个还在干就不轻易换；没人干活不跟', () => {
    const w = (id: string, ts: number) => card(id, { state: 'working', last: { ts, tool: 'x' } })
    expect(followTarget(model(card('a'), user))).toBeUndefined()
    expect(followTarget(model(w('a', 100), w('b', 5000)))).toBe('b')
    expect(followTarget(model(w('a', 100), w('b', 5000)), 'a')).toBe('a')
    expect(followTarget(model(w('a', 100), w('b', 9000)), 'a')).toBe('b')
    expect(followTarget(model(card('a'), w('b', 1)), 'a')).toBe('b')
  })
})

describe('接力线', () => {
  const relays = [
    { id: 'r_1', from: 'a', to: 'b', createdAt: 0 },
    { id: 'r_2', from: 'a', to: 'c', createdAt: 0 },
    { id: 'r_3', from: 'b', to: 'gone', createdAt: 0 }
  ]
  const names: Record<string, string> = { a: 'Alice', b: 'Bob', c: 'Carol' }
  const nameOf = (id: string) => names[id]

  it('谁做完的就通知它的接力线那头的人，带上交付说明（太长截断）', () => {
    const out = relayNotices(relays, [{ ref: 'T-3', title: '登录页', assigneeId: 'a', result: '改了\n两个文件' }], nameOf)
    expect(out.map((n) => n.to)).toEqual(['b', 'c'])
    expect(out[0].text).toBe('[接力] Alice 做完了 T-3「登录页」。用户在画布上连了接力线：它做完的活转给你接着做。它的交付说明：改了 两个文件')
    const long = relayNotices(relays, [{ ref: 'T-4', title: 't', assigneeId: 'a', result: 'x'.repeat(50) }], nameOf, 10)
    expect(long[0].text.endsWith(`它的交付说明：${'x'.repeat(10)}…`)).toBe(true)
  })

  it('没写交付说明时提示去看任务；没有接力线、没人接、那头的 AI 不在了：不通知', () => {
    expect(relayNotices(relays, [{ ref: 'T-5', title: 't', assigneeId: 'a' }], nameOf)[0].text).toContain('task_get')
    expect(relayNotices(relays, [{ ref: 'T-6', title: 't', assigneeId: 'c', result: 'r' }], nameOf)).toEqual([])
    expect(relayNotices(relays, [{ ref: 'T-7', title: 't', result: 'r' }], nameOf)).toEqual([])
    expect(relayNotices(relays, [{ ref: 'T-8', title: 't', assigneeId: 'b', result: 'r' }], nameOf)).toEqual([])
  })

  it('画线前的检查：两头都是 AI、不连自己、不重复', () => {
    const m = model(user, card('a'), card('b'), card('c'))
    expect(planRelay(m, relays, 'b', 'c')).toEqual({ kind: 'add', from: 'b', to: 'c' })
    for (const [f, t] of [['user', 'a'], ['a', 'user'], ['a', 'a'], ['a', 'b'], ['a', 'n_1']]) expect(planRelay(m, relays, f, t).kind, `${f}>${t}`).toBe('invalid')
  })
})
