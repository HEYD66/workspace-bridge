// 画布的数据那一半：把工作台已有的数据（成员、状态、任务、主脑和子代理、最近的操作）
// 变成「画哪些卡片、哪些框、哪些线、角上写几个数」。不碰界面、不碰位置，纯计算，界面照着结果画。
//
// 状态只认明确的事件（做法学自 Cate 的 docs/agent-activity.md，代码是自己写的）：
// 1. 卡片状态直接取工作台算好的 MemberStatus，不靠「多久没动静」再猜一遍；
// 2. 「等你」只在确实要用户处理时才亮：任务上有没回答的问题、交上来等验收、做完交付了用户还没看。
//    AI 在等群消息（chat_wait）不算等你；
// 3. 「可能卡住」（stale）和「离线」分开，不混成一个。

import type { ActivityEvent, Agent, GroupChannelInfo, MemberStatus, Role, TaskItem, TaskStatus } from '../core/types'

/** 用户那张卡片的 id，也是线两头里「用户」的写法（和任务里的 'user' 一致） */
export const CANVAS_USER_ID = 'user'

/**
 * 卡片状态：
 * - working  在干活（在调工具，或者在跑命令）
 * - waiting  在等群里的消息（空闲待命，有人说话就会动）
 * - idle     连着，没有动作
 * - stuck    连着但很久没动静，可能掉线了或者这一轮结束了
 * - offline  没连着
 * - paused   被暂停
 */
export type CanvasCardState = 'working' | 'waiting' | 'idle' | 'stuck' | 'offline' | 'paused'

/** 要用户处理的一件事 */
export interface CanvasAttention {
  /**
   * question：任务上有问题等回答；
   * review：交上来等用户点「通过」（少见：用户派的活 AI 提交审查时工作台直接算完成）；
   * delivered：做完交付了，用户还没看过（看过用 ackTasks 记下）
   */
  kind: 'question' | 'review' | 'delivered'
  taskRef: string
  taskTitle: string
  /** 问题的原文；review 时是交付说明（可能没有） */
  text?: string
  /** 问题编号（q1、q2…），回答时要用；review 没有 */
  questionId?: string
  /** 从什么时候开始等的 */
  since: number
}

export interface CanvasCard {
  /** 成员 id；用户那张是 CANVAS_USER_ID */
  id: string
  kind: 'agent' | 'user'
  name: string
  color?: string
  /** 职位名 */
  role?: string
  state: CanvasCardState
  /** 进入这个状态的时间 */
  since?: number
  /** 是这个项目的主脑 */
  lead?: boolean
  /** 手上进行中的任务（这个项目的） */
  tasks: { ref: string; title: string }[]
  /** 这一刻在调的工具（刚调完、还在连续干活时也有） */
  tool?: string
  /** 名下还在跑的后台命令数 */
  commands?: number
  /** 最后做的一件事 */
  last?: { ts: number; tool: string; text?: string; failed?: boolean }
  /** 要用户处理的事，早的在前；空数组就是没有 */
  attention: CanvasAttention[]
}

export interface CanvasFrame {
  id: string
  /** team：有主脑的分工；brainstorm：没有主脑，一起讨论 */
  kind: 'team' | 'brainstorm'
  title: string
  leadId?: string
  /** 框里的卡片，主脑排第一 */
  cardIds: string[]
}

/** 一条线上的任务状态里最要紧的那个，线的颜色照它定 */
export type CanvasLineState = 'blocked' | 'review' | 'in_progress' | 'todo' | 'done'

export interface CanvasLine {
  id: string
  /** team：主脑到子代理；task：派活的人到干活的人；relay：接力线（from 做完的活自动转给 to） */
  kind: 'team' | 'task' | 'relay'
  from: string
  to: string
  /** task 线才有：这两个人之间的任务，要紧的在前 */
  tasks?: { ref: string; title: string; status: TaskStatus }[]
  state?: CanvasLineState
  /** relay 线才有：存储里那条接力线的 id，删线时用 */
  relayId?: string
}

/** 一条任务，画成任务卡片用：没人接的可以拖给 AI，有人接的挂在那个 AI 旁边 */
export interface CanvasTaskCard {
  /** 卡片 id：'task:' + 任务编号 */
  id: string
  ref: string
  title: string
  status: TaskStatus
  priority: TaskItem['priority']
  /** 谁在做；没人接的没有这一项 */
  assigneeId?: string
  /** 谁派的（用户是 'user'） */
  fromId: string
  /** 没回答的问题数 */
  openQuestions: number
  updatedAt: number
}

export interface CanvasTotals {
  /** AI 卡片数（不算用户那张） */
  agents: number
  working: number
  /** 要用户处理的事的总数 */
  attention: number
  stuck: number
  offline: number
  /** 没人接的任务数 */
  unclaimed: number
}

export interface CanvasModel {
  cards: CanvasCard[]
  frames: CanvasFrame[]
  lines: CanvasLine[]
  /** 没做完的任务（includeDone 时连做完的一起），没人接的在前，然后按最近改动 */
  tasks: CanvasTaskCard[]
  totals: CanvasTotals
}

export interface CanvasInput {
  agents: Pick<Agent, 'id' | 'name' | 'color' | 'roleId'>[]
  roles?: Pick<Role, 'id' | 'name'>[]
  /** BridgeState.memberStatus；没有某个成员就按离线算 */
  memberStatus?: Record<string, MemberStatus>
  /** 这个项目的工作区 id：用来只留这个项目的进行中任务和最近操作。不填就不筛 */
  workspaceId?: string
  /** 这个项目的任务 */
  tasks: TaskItem[]
  /** 这个项目的主群聊：从它读主脑、子代理、参与讨论的人 */
  channel?: Pick<GroupChannelInfo, 'id' | 'name' | 'title' | 'leadId' | 'subIds' | 'partIds'>
  /** 最近的操作（顺序不限） */
  events?: ActivityEvent[]
  /** 只画这些成员；不填就是全部成员 */
  memberIds?: string[]
  /** 用户连的接力线（CanvasDoc.relays）；两头都在画布上的才画 */
  relays?: readonly { id: string; from: string; to: string }[]
  /** 用户看过的交付（CanvasDoc.acks / ackAll）：不给就不算「交付了还没看」这一种等你 */
  acks?: Readonly<Record<string, number>>
  ackAll?: number
  /** 现在的时间：只有 deliveredWindowMs 以内做完的才提醒。不给就不提醒「交付了还没看」 */
  now?: number
  /** 做完多久以内的交付算「还没看」，默认 3 天（再早的不翻旧账） */
  deliveredWindowMs?: number
  /** 做完的任务也画线；默认不画 */
  includeDone?: boolean
}

const DELIVERED_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

const STATE_OF: Record<MemberStatus['status'], CanvasCardState> = {
  working: 'working',
  command: 'working',
  waiting: 'waiting',
  idle: 'idle',
  stale: 'stuck',
  offline: 'offline',
  paused: 'paused'
}

// 线上任务的轻重：卡住 > 等验收 > 在做 > 没开始 > 做完
const LINE_RANK: Record<TaskStatus, number> = { blocked: 0, review: 1, in_progress: 2, todo: 3, done: 4 }

/** 这条任务是谁派的：有经理就是经理，否则是创建的人 */
function assignerOf(task: TaskItem): string {
  return task.managedBy ?? task.createdBy
}

function attentionOf(tasks: TaskItem[], input: Pick<CanvasInput, 'acks' | 'ackAll' | 'now' | 'deliveredWindowMs'> = {}): Map<string, CanvasAttention[]> {
  const since = input.now !== undefined ? input.now - (input.deliveredWindowMs ?? DELIVERED_WINDOW_MS) : undefined
  const byAgent = new Map<string, CanvasAttention[]>()
  const push = (agentId: string, item: CanvasAttention): void => {
    const list = byAgent.get(agentId)
    if (list) list.push(item)
    else byAgent.set(agentId, [item])
  }
  for (const task of tasks) {
    for (const q of task.questions ?? []) {
      if (q.status !== 'open') continue
      // 记在提问的人头上：是它在等这个答案
      push(q.askedBy, { kind: 'question', taskRef: task.ref, taskTitle: task.title, text: q.text, questionId: q.id, since: q.askedAt })
    }
    if (task.status === 'review' && task.assigneeId && assignerOf(task) === CANVAS_USER_ID) {
      push(task.assigneeId, { kind: 'review', taskRef: task.ref, taskTitle: task.title, text: task.result, since: task.updatedAt })
    }
    // 做完了、没有别的 AI 替用户验收（用户派的，或者 AI 自己建自己做的）、用户还没看过
    if (
      since !== undefined &&
      task.status === 'done' &&
      task.assigneeId &&
      (task.managedBy === undefined || task.managedBy === CANVAS_USER_ID) &&
      task.updatedAt >= since &&
      task.updatedAt > (input.ackAll ?? 0) &&
      task.updatedAt > (input.acks?.[task.ref] ?? 0)
    ) {
      push(task.assigneeId, { kind: 'delivered', taskRef: task.ref, taskTitle: task.title, text: task.result, since: task.updatedAt })
    }
  }
  for (const list of byAgent.values()) list.sort((a, b) => a.since - b.since)
  return byAgent
}

function lastEventOf(events: ActivityEvent[], workspaceId?: string): Map<string, ActivityEvent> {
  const last = new Map<string, ActivityEvent>()
  for (const e of events) {
    if (workspaceId && e.workspaceId && e.workspaceId !== workspaceId) continue
    const prev = last.get(e.agentId)
    if (!prev || e.ts > prev.ts) last.set(e.agentId, e)
  }
  return last
}

export function buildCanvasModel(input: CanvasInput): CanvasModel {
  const only = input.memberIds ? new Set(input.memberIds) : null
  const agents = input.agents.filter((a) => !only || only.has(a.id))
  const agentIds = new Set(agents.map((a) => a.id))
  const roleName = new Map((input.roles ?? []).map((r) => [r.id, r.name]))
  const attention = attentionOf(input.tasks, input)
  const lastEvent = lastEventOf(input.events ?? [], input.workspaceId)
  const leadId = input.channel?.leadId && agentIds.has(input.channel.leadId) ? input.channel.leadId : undefined

  const cards: CanvasCard[] = agents.map((a) => {
    const st = input.memberStatus?.[a.id]
    const state = st ? STATE_OF[st.status] : 'offline'
    const card: CanvasCard = {
      id: a.id,
      kind: 'agent',
      name: a.name,
      color: a.color,
      state,
      tasks: (st?.tasks ?? [])
        .filter((t) => !input.workspaceId || t.workspaceId === input.workspaceId)
        .map((t) => ({ ref: t.ref, title: t.title })),
      attention: attention.get(a.id) ?? []
    }
    const role = a.roleId ? roleName.get(a.roleId) : undefined
    if (role) card.role = role
    if (st?.since !== undefined) card.since = st.since
    if (a.id === leadId) card.lead = true
    if (state === 'working' && st?.tool) card.tool = st.tool
    if (st?.commands) card.commands = st.commands
    const e = lastEvent.get(a.id)
    if (e) {
      card.last = { ts: e.ts, tool: e.tool }
      const text = e.summary ?? e.path
      if (text) card.last.text = text
      if (e.status === 'error') card.last.failed = true
    }
    return card
  })

  // ===== 线 =====
  const lines: CanvasLine[] = []
  let touchesUser = false

  // 派活的线：同一对人之间的任务并成一条
  const pairs = new Map<string, CanvasLine & { tasks: NonNullable<CanvasLine['tasks']> }>()
  for (const task of input.tasks) {
    if (!task.assigneeId || !agentIds.has(task.assigneeId)) continue
    if (task.status === 'done' && !input.includeDone) continue
    const from = assignerOf(task)
    // 自己给自己建的任务不画线
    if (from === task.assigneeId) continue
    if (from !== CANVAS_USER_ID && !agentIds.has(from)) continue
    if (from === CANVAS_USER_ID) touchesUser = true
    const id = `task:${from}>${task.assigneeId}`
    let line = pairs.get(id)
    if (!line) {
      line = { id, kind: 'task', from, to: task.assigneeId, tasks: [] }
      pairs.set(id, line)
    }
    line.tasks.push({ ref: task.ref, title: task.title, status: task.status })
  }
  for (const line of pairs.values()) {
    line.tasks.sort((a, b) => LINE_RANK[a.status] - LINE_RANK[b.status])
    line.state = line.tasks[0].status
    lines.push(line)
  }

  for (const r of input.relays ?? []) {
    if (agentIds.has(r.from) && agentIds.has(r.to)) lines.push({ id: `relay:${r.id}`, kind: 'relay', from: r.from, to: r.to, relayId: r.id })
  }

  // ===== 框 =====
  const frames: CanvasFrame[] = []
  if (input.channel) {
    const title = input.channel.title ?? input.channel.name
    if (leadId) {
      // 没选过子代理：主脑以外的都算
      const subs = (input.channel.subIds ?? agents.map((a) => a.id)).filter((id) => id !== leadId && agentIds.has(id))
      frames.push({ id: `team:${input.channel.id}`, kind: 'team', title, leadId, cardIds: [leadId, ...subs] })
      for (const sub of subs) lines.push({ id: `team:${leadId}>${sub}`, kind: 'team', from: leadId, to: sub })
    } else {
      const parts = (input.channel.partIds ?? agents.map((a) => a.id)).filter((id) => agentIds.has(id))
      if (parts.length > 0) frames.push({ id: `team:${input.channel.id}`, kind: 'brainstorm', title, cardIds: parts })
    }
  }

  // 用户那张卡片：有线连到用户，或者有事等用户时才出现
  const attentionCount = cards.reduce((n, c) => n + c.attention.length, 0)
  if (touchesUser || attentionCount > 0) {
    cards.unshift({ id: CANVAS_USER_ID, kind: 'user', name: '你', state: 'idle', tasks: [], attention: [] })
  }

  const taskCards: CanvasTaskCard[] = input.tasks
    .filter((t) => input.includeDone || t.status !== 'done')
    .map((t) => ({
      id: `task:${t.ref}`,
      ref: t.ref,
      title: t.title,
      status: t.status,
      priority: t.priority,
      ...(t.assigneeId ? { assigneeId: t.assigneeId } : {}),
      fromId: assignerOf(t),
      openQuestions: (t.questions ?? []).filter((q) => q.status === 'open').length,
      updatedAt: t.updatedAt
    }))
    .sort((a, b) => Number(!!a.assigneeId) - Number(!!b.assigneeId) || b.updatedAt - a.updatedAt)
  const unclaimed = taskCards.filter((t) => !t.assigneeId && t.status !== 'done').length

  const count = (s: CanvasCardState): number => cards.filter((c) => c.kind === 'agent' && c.state === s).length
  return {
    cards,
    frames,
    lines,
    tasks: taskCards,
    totals: { agents: agents.length, working: count('working'), attention: attentionCount, stuck: count('stuck'), offline: count('offline'), unclaimed }
  }
}
