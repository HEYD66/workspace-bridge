// 画布上的动作背后的规则：拉线派活、拖进框组队、换主脑、框选群发、套模板、搜索、名单排序、镜头跟谁。
// 全是纯计算：界面把「用户做了什么」交进来，拿到「该调工作台的哪个方法、参数是什么」，或者一句为什么不行。
import { CANVAS_USER_ID, type CanvasCard, type CanvasCardState, type CanvasModel } from './canvasModel'
import type { CanvasDoc, CanvasRelay, CanvasTemplate } from './canvasDoc'

// ===== 拉线派活 / 把任务拖给 AI =====

export type AssignPlan =
  /** 新建一条任务：分给 assigneeId；managedBy 是派活的 AI（用户派的没有这一项）。标题和说明由界面弹框问 */
  | { kind: 'create'; assigneeId: string; managedBy?: string }
  /** 把已有的任务改派给 assigneeId */
  | { kind: 'reassign'; taskRef: string; assigneeId: string }
  | { kind: 'invalid'; reason: string }

/**
 * 从一张卡片拉线到另一张（或者把一张任务卡片拖到 AI 上：带 taskRef）。
 * - 用户 → AI：用户派活
 * - AI → AI：前一个当经理派给后一个（做完要它验收）
 * - 拉到用户、便签、自己身上：不行
 */
export function planAssign(model: CanvasModel, fromId: string, toId: string, taskRef?: string): AssignPlan {
  const to = model.cards.find((c) => c.id === toId)
  if (toId === CANVAS_USER_ID) return { kind: 'invalid', reason: '不能把活派给你自己，线要连到一个 AI 上' }
  if (!to || to.kind !== 'agent') return { kind: 'invalid', reason: '线要连到一个 AI 的卡片上' }
  if (taskRef) return { kind: 'reassign', taskRef, assigneeId: toId }
  if (fromId === toId) return { kind: 'invalid', reason: '不能自己给自己派活' }
  if (fromId === CANVAS_USER_ID) return { kind: 'create', assigneeId: toId }
  const from = model.cards.find((c) => c.id === fromId)
  if (!from || from.kind !== 'agent') return { kind: 'invalid', reason: '线要从你或者一个 AI 的卡片拉出来' }
  return { kind: 'create', assigneeId: toId, managedBy: fromId }
}

// ===== 团队：拖进框、拖出框、换主脑 =====

/** 频道现在的分工 */
export interface TeamShape {
  leadId?: string
  /** 没有这一项 = 没挑过：主脑以外的都算子代理 */
  subIds?: string[]
}

/** 要把分工改成什么样：直接对上 bridge.setChatLead(频道, leadId, subIds)。subIds 是 null = 不挑 */
export type TeamPlan = { kind: 'set'; leadId: string | undefined; subIds: string[] | null } | { kind: 'none'; reason: string }

/** 现在算在团队里的子代理（没挑过就是主脑以外的全部） */
export function currentSubs(team: TeamShape, allAgentIds: readonly string[]): string[] {
  if (!team.leadId) return []
  return (team.subIds ?? [...allAgentIds]).filter((id) => id !== team.leadId && allAgentIds.includes(id))
}

/**
 * 把一个 AI 拖进团队框。
 * - 框里还没有主脑：它当主脑，别人都算子代理
 * - 已经有主脑：它加进子代理
 */
export function planJoinTeam(team: TeamShape, allAgentIds: readonly string[], agentId: string): TeamPlan {
  if (!allAgentIds.includes(agentId)) return { kind: 'none', reason: '这个 AI 进不了这个项目' }
  if (!team.leadId) return { kind: 'set', leadId: agentId, subIds: null }
  if (agentId === team.leadId) return { kind: 'none', reason: '它已经是主脑了' }
  const subs = currentSubs(team, allAgentIds)
  if (subs.includes(agentId)) return { kind: 'none', reason: '它已经在团队里了' }
  return { kind: 'set', leadId: team.leadId, subIds: [...subs, agentId] }
}

/**
 * 把一个 AI 拖出团队框。
 * - 拖出的是主脑：团队解散，回到「一起讨论」
 * - 拖出的是子代理：从子代理里去掉（去掉以后就是「挑过」的了，哪怕一个不剩）
 */
export function planLeaveTeam(team: TeamShape, allAgentIds: readonly string[], agentId: string): TeamPlan {
  if (!team.leadId) return { kind: 'none', reason: '这里现在没有团队' }
  if (agentId === team.leadId) return { kind: 'set', leadId: undefined, subIds: null }
  const subs = currentSubs(team, allAgentIds)
  if (!subs.includes(agentId)) return { kind: 'none', reason: '它本来就不在团队里' }
  return { kind: 'set', leadId: team.leadId, subIds: subs.filter((id) => id !== agentId) }
}

/** 换主脑：新主脑上去，原来的主脑变成子代理。原来没挑过子代理的，换完还是不挑 */
export function planSetLead(team: TeamShape, allAgentIds: readonly string[], agentId: string): TeamPlan {
  if (!allAgentIds.includes(agentId)) return { kind: 'none', reason: '这个 AI 进不了这个项目' }
  if (agentId === team.leadId) return { kind: 'none', reason: '它已经是主脑了' }
  if (!team.leadId || team.subIds === undefined) return { kind: 'set', leadId: agentId, subIds: null }
  const subs = currentSubs(team, allAgentIds).filter((id) => id !== agentId)
  return { kind: 'set', leadId: agentId, subIds: [...subs, team.leadId] }
}

/** 套用模板：模板里现在已经不在（被删了、进不了这个项目）的成员跳过，并报出来 */
export function planApplyTemplate(template: CanvasTemplate, allAgentIds: readonly string[]): TeamPlan & { missing: string[] } {
  const has = (id: string): boolean => allAgentIds.includes(id)
  const missing = [...(template.leadId && !has(template.leadId) ? [template.leadId] : []), ...template.memberIds.filter((id) => !has(id))]
  const members = template.memberIds.filter(has)
  if (template.leadId && has(template.leadId)) return { kind: 'set', leadId: template.leadId, subIds: members, missing }
  if (template.leadId) return { kind: 'none', reason: '模板里的主脑已经不在了，先在模板里换一个主脑', missing }
  return { kind: 'none', reason: '这个模板没有主脑，套不了', missing }
}

/** 把现在的团队存成模板要带的内容 */
export function templateFromTeam(team: TeamShape, allAgentIds: readonly string[]): { leadId?: string; memberIds: string[] } {
  return { ...(team.leadId ? { leadId: team.leadId } : {}), memberIds: currentSubs(team, allAgentIds) }
}

// ===== 框选群发 =====

export interface BroadcastPlan {
  /** 发给谁（只有 AI） */
  to: { id: string; name: string }[]
  /** 这些现在收不到，要等它们回来才看得到 */
  away: { id: string; name: string; state: CanvasCardState }[]
  /** 加在消息前面的 @ 名单，如 "@Alice @Bob " */
  mentions: string
}

/** 选中的卡片里挑出 AI；离线、卡住、暂停的照发，但单独列出来提醒 */
export function planBroadcast(model: CanvasModel, selectedIds: readonly string[]): BroadcastPlan {
  const picked = new Set(selectedIds)
  const agents = model.cards.filter((c) => c.kind === 'agent' && picked.has(c.id))
  const awayStates: CanvasCardState[] = ['offline', 'stuck', 'paused']
  return {
    to: agents.map((c) => ({ id: c.id, name: c.name })),
    away: agents.filter((c) => awayStates.includes(c.state)).map((c) => ({ id: c.id, name: c.name, state: c.state })),
    mentions: agents.map((c) => `@${c.name} `).join('')
  }
}

// ===== 名单、搜索、镜头跟随 =====

// 名单顺序：有事等你的最前，然后在干活、等消息、空闲、可能卡住、暂停、离线
const ROSTER_RANK: Record<CanvasCardState, number> = { working: 1, waiting: 2, idle: 3, stuck: 4, paused: 5, offline: 6 }

/** 画布旁边的 AI 名单：有事等你的排最前，同一档里主脑在前，再按名字 */
export function rosterOrder(model: CanvasModel): CanvasCard[] {
  const rank = (c: CanvasCard): number => (c.attention.length ? 0 : ROSTER_RANK[c.state])
  return model.cards
    .filter((c) => c.kind === 'agent')
    .sort((a, b) => rank(a) - rank(b) || Number(!!b.lead) - Number(!!a.lead) || a.name.localeCompare(b.name))
}

export interface CanvasHit {
  /** 卡片 id（AI）或便签 id：镜头飞过去的目标 */
  id: string
  kind: 'agent' | 'note'
  /** 命中的那段文字 */
  text: string
  /** 命中在哪：名字、职位、任务、等你的事、最后做的事、便签 */
  where: 'name' | 'role' | 'task' | 'attention' | 'last' | 'note'
}

/** 在画布上搜：AI 的名字、职位、手上的任务、等你的事、最后做的事，还有便签。不分大小写；空的关键词没有结果 */
export function searchCanvas(model: CanvasModel, doc: Pick<CanvasDoc, 'notes'>, query: string): CanvasHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const has = (s: string | undefined): s is string => !!s && s.toLowerCase().includes(q)
  const hits: CanvasHit[] = []
  for (const c of model.cards) {
    if (c.kind !== 'agent') continue
    const add = (where: CanvasHit['where'], text: string): void => {
      hits.push({ id: c.id, kind: 'agent', text, where })
    }
    if (has(c.name)) add('name', c.name)
    if (has(c.role)) add('role', c.role)
    for (const t of c.tasks) if (has(`${t.ref} ${t.title}`)) add('task', `${t.ref} ${t.title}`)
    for (const a of c.attention) if (has(`${a.taskRef} ${a.taskTitle} ${a.text ?? ''}`)) add('attention', a.text ?? `${a.taskRef} ${a.taskTitle}`)
    if (has(c.last?.text)) add('last', c.last!.text!)
  }
  for (const n of doc.notes) if (has(n.text)) hits.push({ id: n.id, kind: 'note', text: n.text, where: 'note' })
  return hits
}

/**
 * 镜头跟随该跟谁：在干活的 AI 里最后有动作的那个。
 * 现在跟着的那个还在干活、而且别人没有比它新出 holdMs 以上的动作，就不换（免得镜头来回跳）。没人在干活返回 undefined
 */
export function followTarget(model: CanvasModel, currentId?: string, holdMs = 8000): string | undefined {
  const working = model.cards.filter((c) => c.kind === 'agent' && c.state === 'working')
  if (working.length === 0) return undefined
  const stamp = (c: CanvasCard): number => Math.max(c.last?.ts ?? 0, c.since ?? 0)
  const newest = working.reduce((best, c) => (stamp(c) > stamp(best) ? c : best))
  const current = working.find((c) => c.id === currentId)
  if (current && stamp(newest) - stamp(current) < holdMs) return current.id
  return newest.id
}

// ===== 接力线 =====

/** 刚做完的一条任务里和接力有关的几项 */
export interface FinishedTask {
  ref: string
  title: string
  assigneeId?: string
  result?: string
}

export interface RelayNotice {
  /** 通知谁 */
  to: string
  text: string
}

/**
 * 一批任务刚做完：按接力线算出该通知谁、说什么。
 * 谁做完的就找从它出发的接力线，每条线通知线那头的人一次。nameOf 找不到名字（那个 AI 已经不在了）的线跳过
 */
export function relayNotices(relays: readonly CanvasRelay[], finished: readonly FinishedTask[], nameOf: (agentId: string) => string | undefined, resultMax = 600): RelayNotice[] {
  const out: RelayNotice[] = []
  for (const task of finished) {
    if (!task.assigneeId) continue
    const fromName = nameOf(task.assigneeId)
    if (!fromName) continue
    for (const r of relays) {
      if (r.from !== task.assigneeId || !nameOf(r.to)) continue
      const result = (task.result ?? '').replace(/\s+/g, ' ').trim()
      const short = result.length > resultMax ? `${result.slice(0, resultMax)}…` : result
      out.push({
        to: r.to,
        text: `[接力] ${fromName} 做完了 ${task.ref}「${task.title}」。用户在画布上连了接力线：它做完的活转给你接着做。${short ? `它的交付说明：${short}` : '它没有写交付说明，用 task_get 看这条任务。'}`
      })
    }
  }
  return out
}

/** 画接力线之前检查：两头都得是 AI，不能连自己，不能重复 */
export function planRelay(model: CanvasModel, relays: readonly CanvasRelay[], fromId: string, toId: string): { kind: 'add'; from: string; to: string } | { kind: 'invalid'; reason: string } {
  const isAgent = (id: string): boolean => model.cards.some((c) => c.id === id && c.kind === 'agent')
  if (!isAgent(fromId) || !isAgent(toId)) return { kind: 'invalid', reason: '接力线的两头都要是 AI' }
  if (fromId === toId) return { kind: 'invalid', reason: '接力线不能连到自己' }
  if (relays.some((r) => r.from === fromId && r.to === toId)) return { kind: 'invalid', reason: '这条接力线已经有了' }
  return { kind: 'add', from: fromId, to: toId }
}
