// 画布页的数据拼装和摆放，纯计算（界面在 views/CanvasView.tsx）。
//
// 一张画布画所有项目：每个项目（工作区）一个框，每个 AI 只有一张卡片，放在它「主要在干活」的那个项目里；
// 哪个项目都不沾的放进「没在项目里」。每个项目的卡片内容、线和「等你」来自 shared/canvasModel（arena-006），
// 这里只做三件事：定每个 AI 归哪个框、把各项目的结果并成一张图、算每张卡片和每个框的位置。
import type { ActivityEvent, Agent, GroupChannelInfo, MemberStatus, PendingAuthorization, Role, TaskItem, TaskStatus, WorkspaceInfo } from '../../../core/types'
import type { CanvasDoc } from '../../../shared/canvasDoc'
import { buildCanvasModel, CANVAS_USER_ID, type CanvasAttention, type CanvasCard, type CanvasCardState, type CanvasLineState, type CanvasModel, type CanvasTaskCard, type CanvasTotals } from '../../../shared/canvasModel'
import { computeFrameLayout, nextSlotInFrame, type FrameGeom, type LayoutRect, type MemberRect } from '../../../shared/canvas/frameLayout'
import { fileConflicts, type ClaimLike, type FileConflict } from './canvasConflicts'

/** 「没在项目里」那个框的 id */
export const LOBBY_GROUP = 'lobby'

export const CARD_W = 268
export const CARD_H = 132
export const USER_W = 132
export const USER_H = 64
/** 卡片到框边的距离、框标题栏的高度、卡片之间的距离 */
export const FRAME_PAD = 24
export const FRAME_HEADER = 56
export const CARD_GAP = 44
export const EMPTY_W = 300
export const EMPTY_H = 120
/** 新框一行排到这么宽就换行（调用方可以按窗口的宽度给一个更合适的） */
export const SHELF_WIDTH = 1500
const SHELF_GAP = 64
/** 框里一行最多三张卡片 */
const ROW_MAX = CARD_W * 3 + CARD_GAP * 2

export interface BoardAttention extends CanvasAttention {
  workspaceId: string
}

export interface BoardTask {
  ref: string
  title: string
  workspaceId: string
}

export interface BoardCard extends Omit<CanvasCard, 'tasks' | 'attention'> {
  /** 画布上的唯一标识，位置按它记：`<AI 的 id>@<框的 id>`，用户那张是 'user' */
  key: string
  /** 所在的框；用户那张卡片不在框里 */
  groupId?: string
  /** 手上进行中的任务（所有项目的） */
  tasks: BoardTask[]
  /** 要用户处理的事（所有项目的），早的在前 */
  attention: BoardAttention[]
}

export interface BoardGroup {
  id: string
  /** 项目的工作区 id；「没在项目里」没有 */
  workspaceId?: string
  title: string
  /** team：有主脑的分工；brainstorm：一起讨论；lobby：没在项目里 */
  kind: 'team' | 'brainstorm' | 'lobby'
  /** 这个项目的主群聊 */
  channel?: string
  leadKey?: string
  cardKeys: string[]
  /** 这个框里要用户处理的事的总数 */
  attention: number
  working: number
  /** 这个项目里还没人接的任务（可以拖给框里的 AI） */
  openTasks: CanvasTaskCard[]
}

export interface BoardLineTask {
  ref: string
  title: string
  status: TaskStatus
  workspaceId: string
}

export interface BoardLine {
  id: string
  /** team：主脑到子代理；task：派活；relay：接力线（from 做完的活自动转告 to） */
  kind: 'team' | 'task' | 'relay'
  /** 两头卡片的 key */
  from: string
  to: string
  tasks?: BoardLineTask[]
  state?: CanvasLineState
  /** 接力线才有：存在哪个项目里、存储里的 id（删线时用） */
  workspaceId?: string
  relayId?: string
}

/** 两个以上 AI 正在改或占着同一个文件（T-20；「正在」怎么算见 canvasConflicts） */
export interface BoardConflict extends FileConflict {
  /** 这几个人的卡片 key，和 holders 一一对应（红线连这几张） */
  keys: string[]
}

/** 网页 AI 接入工作台，等你在桌面同意（OAuth 待批准） */
export interface BoardOAuthWait {
  id: string
  clientName: string
  /** 从哪个网站来的（如 chatgpt.com） */
  redirectHost: string
  /** 4 位配对码，和浏览器页上的对得上才同意 */
  pairCode: string
  since: number
  expiresAt: number
}

export interface Board {
  cards: BoardCard[]
  groups: BoardGroup[]
  lines: BoardLine[]
  totals: CanvasTotals
  /** 每个项目自己的那份模型（拉线派活、组队的规则函数要用） */
  models: Record<string, CanvasModel>
  /** 收纳起来、现在没画出来的 AI */
  archived: { id: string; name: string; color?: string }[]
  /** 两个以上 AI 正在改或占着同一个文件：只算画在画布上的人，早撞上的在前；没给 now 时为空 */
  conflicts: BoardConflict[]
  /** 等你同意的 OAuth 接入（过期的不算），早的在前；也算进 totals.attention，有它时用户那张卡片照画 */
  oauth: BoardOAuthWait[]
}

export interface BoardInput {
  agents: Pick<Agent, 'id' | 'name' | 'color' | 'roleId'>[]
  roles?: Pick<Role, 'id' | 'name'>[]
  memberStatus?: Record<string, MemberStatus>
  workspaces: Pick<WorkspaceInfo, 'id' | 'name' | 'kind'>[]
  channels?: GroupChannelInfo[]
  tasksByWs: Record<string, TaskItem[]>
  events?: ActivityEvent[]
  /** 不画离线的卡片（手上有事等用户的照画）；角上的总数照算 */
  hideOffline?: boolean
  /** 每个项目存的画布内容：接力线、哪些交付用户看过了 */
  docs?: Record<string, Pick<CanvasDoc, 'relays' | 'acks' | 'ackAll'> | undefined>
  /** 现在的时间：给了才提醒「交付了你还没看」 */
  now?: number
  /** 收纳起来的 AI 的 id：不画（手上有事等用户的照画）；总数照算 */
  archived?: readonly string[]
  /** 每个工作区现在的文件占用登记（BridgeState.fileClaims），和 events 一起算「两个 AI 改同一个文件」；要给 now */
  fileClaims?: Record<string, readonly ClaimLike[] | undefined>
  /** 等你同意的 OAuth 接入（BridgeState.oauthPending） */
  oauthPending?: readonly PendingAuthorization[]
}

const LINE_RANK: Record<TaskStatus, number> = { blocked: 0, review: 1, in_progress: 2, todo: 3, done: 4 }

export function cardKey(agentId: string, groupId: string): string {
  return `${agentId}@${groupId}`
}

/** key 里的 AI id；用户那张返回 undefined */
export function agentOfKey(key: string): string | undefined {
  if (key === CANVAS_USER_ID) return undefined
  const i = key.lastIndexOf('@')
  return i > 0 ? key.slice(0, i) : key
}

/**
 * 每个 AI 归哪个项目。按这个顺序找，先找到的算：
 * 1. 用户在项目群聊里点过名的（主脑、子代理、参与讨论的）；
 * 2. 手上有进行中任务的项目；
 * 3. 名下有没做完的任务的项目（派活的、干活的、提问的都算），取最近动过的；
 * 4. 最近在哪个项目里动过手（「整台电脑」排在目录项目后面）。
 * 都没有就不归任何项目。前面的几条不常变，卡片不会在框之间跳来跳去。
 */
export function homeOf(input: BoardInput): Map<string, string> {
  const home = new Map<string, string>()
  const agentIds = new Set(input.agents.map((a) => a.id))
  const wsIds = input.workspaces.map((w) => w.id)
  const wsSet = new Set(wsIds)
  const give = (agentId: string | undefined, ws: string): void => {
    if (agentId && agentIds.has(agentId) && wsSet.has(ws) && !home.has(agentId)) home.set(agentId, ws)
  }
  for (const ws of wsIds) {
    const ch = input.channels?.find((c) => c.id === `ws:${ws}`)
    if (!ch) continue
    give(ch.leadId, ws)
    for (const id of ch.subIds ?? []) give(id, ws)
    for (const id of ch.partIds ?? []) give(id, ws)
  }
  for (const a of input.agents) for (const t of input.memberStatus?.[a.id]?.tasks ?? []) give(a.id, t.workspaceId)
  const open: { ts: number; ws: string; ids: (string | undefined)[] }[] = []
  for (const ws of wsIds) {
    for (const t of input.tasksByWs[ws] ?? []) {
      if (t.status === 'done') continue
      open.push({ ts: t.updatedAt, ws, ids: [t.assigneeId, t.managedBy, t.createdBy, ...(t.questions ?? []).filter((q) => q.status === 'open').map((q) => q.askedBy)] })
    }
  }
  open.sort((a, b) => b.ts - a.ts)
  for (const o of open) for (const id of o.ids) give(id, o.ws)
  const machine = new Set(input.workspaces.filter((w) => w.kind === 'machine').map((w) => w.id))
  const recent = [...(input.events ?? [])].filter((e) => e.workspaceId).sort((a, b) => b.ts - a.ts)
  for (const e of recent) if (!machine.has(e.workspaceId!)) give(e.agentId, e.workspaceId!)
  for (const e of recent) give(e.agentId, e.workspaceId!)
  return home
}

export function buildBoard(input: BoardInput): Board {
  const home = homeOf(input)
  const keyOf = (agentId: string): string => (agentId === CANVAS_USER_ID ? CANVAS_USER_ID : cardKey(agentId, home.get(agentId) ?? LOBBY_GROUP))
  const cards = new Map<string, BoardCard>()
  const attention = new Map<string, BoardAttention[]>()
  const groups: BoardGroup[] = []
  const teamLines: BoardLine[] = []
  const taskLines = new Map<string, BoardLine & { tasks: BoardLineTask[] }>()
  let userCard: BoardCard | undefined
  let unclaimed = 0
  const models: Record<string, CanvasModel> = {}
  const relayLines: BoardLine[] = []

  const allTasks = (agentId: string): BoardTask[] => (input.memberStatus?.[agentId]?.tasks ?? []).map((t) => ({ ref: t.ref, title: t.title, workspaceId: t.workspaceId }))

  for (const ws of input.workspaces) {
    const tasks = input.tasksByWs[ws.id] ?? []
    const channel = input.channels?.find((c) => c.id === `ws:${ws.id}`)
    const here = input.agents.filter((a) => home.get(a.id) === ws.id).map((a) => a.id)
    // 这个项目的图上要有的人：归这里的，加上这个项目的任务牵涉到的（它们的卡片在别的框里，线照样连过去）
    const involved = new Set(here)
    for (const t of tasks) {
      if (t.status === 'done') continue
      for (const id of [t.assigneeId, t.managedBy, t.createdBy, ...(t.questions ?? []).map((q) => q.askedBy)]) if (id) involved.add(id)
    }
    const model = buildCanvasModel({ agents: input.agents, roles: input.roles, memberStatus: input.memberStatus, workspaceId: ws.id, tasks, channel, events: input.events, relays: input.docs?.[ws.id]?.relays, acks: input.docs?.[ws.id]?.acks, ackAll: input.docs?.[ws.id]?.ackAll, now: input.now, memberIds: [...new Set([...involved, ...(input.docs?.[ws.id]?.relays ?? []).flatMap((r) => [r.from, r.to])])] })
    const hereSet = new Set(here)
    models[ws.id] = model
    unclaimed += model.totals.unclaimed
    for (const c of model.cards) {
      if (c.kind === 'user') {
        userCard ??= { ...c, key: CANVAS_USER_ID, tasks: [], attention: [] }
        continue
      }
      if (c.attention.length > 0) {
        const list = attention.get(c.id) ?? []
        list.push(...c.attention.map((a) => ({ ...a, workspaceId: ws.id })))
        attention.set(c.id, list)
      }
      if (hereSet.has(c.id)) cards.set(c.id, { ...c, key: cardKey(c.id, ws.id), groupId: ws.id, tasks: allTasks(c.id), attention: [] })
    }
    const frame = model.frames[0]
    const lead = frame?.leadId && hereSet.has(frame.leadId) ? frame.leadId : undefined
    // 框里的顺序：主脑第一，然后照成员列表的顺序
    const order = lead ? [lead, ...here.filter((id) => id !== lead)] : here
    if (order.length > 0 || ws.kind !== 'machine') {
      groups.push({
        id: ws.id,
        workspaceId: ws.id,
        title: channel?.title || ws.name,
        kind: frame?.kind === 'team' ? 'team' : 'brainstorm',
        channel: `ws:${ws.id}`,
        leadKey: lead ? cardKey(lead, ws.id) : undefined,
        cardKeys: order.map((id) => cardKey(id, ws.id)),
        attention: 0,
        working: 0,
        openTasks: model.tasks.filter((t) => !t.assigneeId)
      })
    }
    for (const l of model.lines) {
      if (l.kind === 'team') {
        // 主脑的线只连到归这个项目的卡片：没挑过子代理时「别的都算」，不该连到别的项目里去
        if (hereSet.has(l.from) && hereSet.has(l.to)) teamLines.push({ id: `${ws.id}|${l.id}`, kind: 'team', from: keyOf(l.from), to: keyOf(l.to) })
        continue
      }
      if (l.kind === 'relay') {
        relayLines.push({ id: `relay:${ws.id}:${l.relayId ?? l.id}`, kind: 'relay', from: keyOf(l.from), to: keyOf(l.to), workspaceId: ws.id, relayId: l.relayId })
        continue
      }
      if (l.kind !== 'task') continue
      const id = `task:${l.from}>${l.to}`
      let line = taskLines.get(id)
      if (!line) {
        line = { id, kind: 'task', from: keyOf(l.from), to: keyOf(l.to), tasks: [] }
        taskLines.set(id, line)
      }
      for (const t of l.tasks ?? []) line.tasks.push({ ...t, workspaceId: ws.id })
    }
  }

  // 哪个项目都不沾的
  const loose = input.agents.filter((a) => !home.has(a.id)).map((a) => a.id)
  if (loose.length > 0) {
    const model = buildCanvasModel({ agents: input.agents, roles: input.roles, memberStatus: input.memberStatus, tasks: [], events: input.events, memberIds: loose })
    for (const c of model.cards) if (c.kind === 'agent') cards.set(c.id, { ...c, key: cardKey(c.id, LOBBY_GROUP), groupId: LOBBY_GROUP, tasks: allTasks(c.id), attention: [] })
    groups.push({ id: LOBBY_GROUP, title: '没在项目里', kind: 'lobby', cardKeys: loose.map((id) => cardKey(id, LOBBY_GROUP)), attention: 0, working: 0, openTasks: [] })
  }

  for (const [agentId, list] of attention) {
    const card = cards.get(agentId)
    if (card) card.attention = list.sort((a, b) => a.since - b.since)
  }

  const oauth: BoardOAuthWait[] = (input.oauthPending ?? [])
    .filter((p) => input.now === undefined || p.expiresAt > input.now)
    .map((p) => ({ id: p.id, clientName: p.clientName, redirectHost: p.redirectHost, pairCode: p.pairCode, since: p.createdAt, expiresAt: p.expiresAt }))
    .sort((a, b) => a.since - b.since)

  const count = (s: CanvasCardState): number => [...cards.values()].filter((c) => c.state === s).length
  const totals: CanvasTotals = {
    agents: cards.size,
    working: count('working'),
    attention: [...cards.values()].reduce((n, c) => n + c.attention.length, 0) + oauth.length,
    stuck: count('stuck'),
    offline: count('offline'),
    unclaimed
  }

  // 不画离线的：手上有事等用户的留着
  const hidden = new Set<string>()
  if (input.hideOffline) for (const c of cards.values()) if (c.state === 'offline' && c.attention.length === 0) hidden.add(c.key)
  // 收纳起来的也不画，规则一样：有事等用户就自己出来
  const put = new Set(input.archived ?? [])
  const archived: Board['archived'] = []
  for (const c of cards.values()) {
    if (!put.has(c.id)) continue
    if (c.attention.length === 0) hidden.add(c.key)
    archived.push({ id: c.id, name: c.name, color: c.color })
  }

  const shown = [...cards.values()].filter((c) => !hidden.has(c.key))
  const byKey = new Map(shown.map((c) => [c.key, c]))
  for (const g of groups) {
    g.cardKeys = g.cardKeys.filter((k) => byKey.has(k))
    if (g.leadKey && !byKey.has(g.leadKey)) g.leadKey = undefined
    for (const k of g.cardKeys) {
      const c = byKey.get(k)!
      g.attention += c.attention.length
      if (c.state === 'working') g.working++
    }
  }
  const shownGroups = groups.filter((g) => g.kind !== 'lobby' || g.cardKeys.length > 0)

  // 两个 AI 撞同一个文件：只留画在画布上的人，剩不到两个就不算
  const conflicts: BoardConflict[] = []
  if (input.now !== undefined) {
    for (const f of fileConflicts({ claimsByWs: input.fileClaims, events: input.events, now: input.now })) {
      const holders = f.holders.filter((h) => byKey.has(keyOf(h.agentId)))
      if (holders.length < 2) continue
      conflicts.push({ ...f, holders, since: holders[1].since, keys: holders.map((h) => keyOf(h.agentId)) })
    }
  }

  const lines: BoardLine[] = []
  const hasEnd = (k: string): boolean => k === CANVAS_USER_ID || byKey.has(k)
  const taskPairs = new Set<string>()
  let touchesUser = false
  for (const line of taskLines.values()) {
    if (!hasEnd(line.from) || !hasEnd(line.to) || line.from === line.to) continue
    line.tasks.sort((a, b) => LINE_RANK[a.status] - LINE_RANK[b.status])
    line.state = line.tasks[0]?.status
    lines.push(line)
    taskPairs.add(`${line.from}|${line.to}`)
    taskPairs.add(`${line.to}|${line.from}`)
    if (line.from === CANVAS_USER_ID || line.to === CANVAS_USER_ID) touchesUser = true
  }
  // 两张卡片之间已经有派活的线，就不再叠一条主脑的线
  for (const line of teamLines) if (hasEnd(line.from) && hasEnd(line.to) && !taskPairs.has(`${line.from}|${line.to}`)) lines.push(line)
  for (const line of relayLines) if (hasEnd(line.from) && hasEnd(line.to) && line.from !== line.to) lines.push(line)

  const out: BoardCard[] = []
  if (touchesUser || totals.attention > 0) out.push(userCard ?? { id: CANVAS_USER_ID, key: CANVAS_USER_ID, kind: 'user', name: '你', state: 'idle', tasks: [], attention: [] })
  // 卡片照框的顺序排，框里照 cardKeys 的顺序
  for (const g of shownGroups) for (const k of g.cardKeys) out.push(byKey.get(k)!)
  return { cards: out, groups: shownGroups, lines, totals, models, archived, conflicts, oauth }
}

// ========== 摆放 ==========

export interface XY {
  x: number
  y: number
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** 空框的位置记在这个 key 下（有卡片的框，位置跟着卡片走） */
export function frameKey(groupId: string): string {
  return `#${groupId}`
}

export interface BoardLayout {
  cards: Record<string, Box>
  frames: Record<string, Box>
  /** 这一次新定下来的位置（新卡片找到的空位、被别的框挤开后的位置），调用方记下来，下次就不动了 */
  fresh: Record<string, XY>
  /** 所有东西的外框；一样东西都没有时是 null */
  bounds: Box | null
}

const sizeOf = (c: Pick<BoardCard, 'kind'>): { w: number; h: number } => (c.kind === 'user' ? { w: USER_W, h: USER_H } : { w: CARD_W, h: CARD_H })

function boundsOf(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const b of boxes) {
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.w)
    y1 = Math.max(y1, b.y + b.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * 算每张卡片、每个框在画布上的位置。
 * - 记过位置的卡片照记的放；没记过的在自己的框里找一个不压住别人的空位（一行最多三张）。
 * - 整个框都是新的：排在已有内容的下面，从左到右，太宽就换行。
 * - 框的大小跟着里面的卡片走；框和框压在一起时互相挤开，`anchorGroup`（正在拖的那个）不动。
 * - 用户那张卡片不在框里，没记过位置就放在所有框的左上方。
 */
export function layoutBoard(board: Pick<Board, 'cards' | 'groups'>, saved: Record<string, XY>, anchorGroup?: string, opts: { shelfWidth?: number } = {}): BoardLayout {
  const shelfWidth = Math.max(EMPTY_W, opts.shelfWidth ?? SHELF_WIDTH)
  const byKey = new Map(board.cards.map((c) => [c.key, c]))
  const rects = new Map<string, LayoutRect>()
  const fresh: Record<string, XY> = {}
  const ok = (p: XY | undefined): p is XY => !!p && Number.isFinite(p.x) && Number.isFinite(p.y)

  for (const c of board.cards) {
    const p = saved[c.key]
    if (c.groupId && ok(p)) rects.set(c.key, { id: c.key, x: p.x, y: p.y, ...sizeOf(c) })
  }
  const emptyAt = new Map<string, XY>()
  for (const g of board.groups) {
    const p = saved[frameKey(g.id)]
    if (g.cardKeys.length === 0 && ok(p)) emptyAt.set(g.id, p)
  }

  // 新框的起点：已有内容的左下方
  const existing = boundsOf([...[...rects.values()].map((r) => ({ x: r.x - FRAME_PAD, y: r.y - FRAME_HEADER, w: r.w + FRAME_PAD * 2, h: r.h + FRAME_HEADER + FRAME_PAD })), ...[...emptyAt.values()].map((p) => ({ ...p, w: EMPTY_W, h: EMPTY_H }))])
  const shelfLeft = existing ? existing.x : 0
  let shelfX = shelfLeft
  let shelfY = existing ? existing.y + existing.h + SHELF_GAP : 0
  let shelfH = 0
  const takeShelf = (w: number, h: number): XY => {
    if (shelfX > shelfLeft && shelfX + w > shelfLeft + shelfWidth) {
      shelfX = shelfLeft
      shelfY += shelfH + SHELF_GAP
      shelfH = 0
    }
    const at = { x: shelfX, y: shelfY }
    shelfX += w + SHELF_GAP
    shelfH = Math.max(shelfH, h)
    return at
  }

  const frames: FrameGeom[] = []
  const members = new Map<string, MemberRect[]>()
  for (const g of board.groups) {
    const have = g.cardKeys.map((k) => rects.get(k)).filter((r): r is LayoutRect => !!r)
    const missing = g.cardKeys.filter((k) => !rects.has(k) && byKey.has(k))
    if (g.cardKeys.length === 0) {
      let at = emptyAt.get(g.id)
      if (!at) {
        at = takeShelf(EMPTY_W, EMPTY_H)
        fresh[frameKey(g.id)] = at
      }
      frames.push({ id: g.id, x: at.x, y: at.y, w: EMPTY_W, h: EMPTY_H })
      continue
    }
    let origin: XY
    if (have.length > 0) {
      origin = { x: Math.min(...have.map((r) => r.x)) - FRAME_PAD, y: Math.min(...have.map((r) => r.y)) - FRAME_HEADER }
    } else {
      const cols = Math.min(3, missing.length)
      const rows = Math.ceil(missing.length / 3)
      origin = takeShelf(cols * CARD_W + (cols - 1) * CARD_GAP + FRAME_PAD * 2, rows * CARD_H + (rows - 1) * CARD_GAP + FRAME_HEADER + FRAME_PAD)
    }
    const taken = [...have]
    for (const k of missing) {
      const size = sizeOf(byKey.get(k)!)
      const at = nextSlotInFrame(origin, taken, size, { padX: FRAME_PAD, padTop: FRAME_HEADER, gap: CARD_GAP, maxRowWidth: ROW_MAX })
      const r = { id: k, x: at.x, y: at.y, ...size }
      taken.push(r)
      rects.set(k, r)
      fresh[k] = at
    }
    members.set(g.id, taken.map((r) => ({ x: r.x, y: r.y, r: r.x + r.w, b: r.y + r.h })))
    frames.push({ id: g.id, x: origin.x, y: origin.y, w: 0, h: 0 })
  }

  const fit = computeFrameLayout(frames, members, anchorGroup ?? null, { pad: FRAME_PAD, header: FRAME_HEADER, emptyW: EMPTY_W, emptyH: EMPTY_H, gap: 40 })
  const outFrames: Record<string, Box> = {}
  const outCards: Record<string, Box> = {}
  for (const g of board.groups) {
    const geo = fit.geometry.get(g.id)
    if (!geo) continue
    outFrames[g.id] = { x: geo.x, y: geo.y, w: geo.w, h: geo.h }
    const shift = fit.tileShift.get(g.id) ?? { dx: 0, dy: 0 }
    if (g.cardKeys.length === 0) {
      const was = emptyAt.get(g.id) ?? fresh[frameKey(g.id)]
      if (!was || was.x !== geo.x || was.y !== geo.y) fresh[frameKey(g.id)] = { x: geo.x, y: geo.y }
      continue
    }
    for (const k of g.cardKeys) {
      const r = rects.get(k)
      if (!r) continue
      const x = r.x + shift.dx
      const y = r.y + shift.dy
      outCards[k] = { x, y, w: r.w, h: r.h }
      if (shift.dx !== 0 || shift.dy !== 0 || fresh[k]) fresh[k] = { x, y }
    }
  }

  // 用户那张卡片不在框里：没记过位置就放在所有框的左上方（放上面不放左边：左右是最缺地方的）
  const user = byKey.get(CANVAS_USER_ID)
  if (user) {
    const p = saved[CANVAS_USER_ID]
    const all = boundsOf(Object.values(outFrames))
    const at = ok(p) ? p : { x: all?.x ?? 0, y: (all?.y ?? 0) - USER_H - 56 }
    if (!ok(p)) fresh[CANVAS_USER_ID] = at
    outCards[CANVAS_USER_ID] = { ...at, ...sizeOf(user) }
  }

  return { cards: outCards, frames: outFrames, fresh, bounds: boundsOf([...Object.values(outFrames), ...Object.values(outCards)]) }
}

/** 把一个框里的卡片从框的左上角起重新排整齐（一行三张），返回这些卡片的新位置 */
export function tidyGroup(group: Pick<BoardGroup, 'cardKeys'>, frame: Box, sizes: (key: string) => { w: number; h: number } = () => ({ w: CARD_W, h: CARD_H })): Record<string, XY> {
  const out: Record<string, XY> = {}
  const taken: LayoutRect[] = []
  for (const k of group.cardKeys) {
    const size = sizes(k)
    const at = nextSlotInFrame({ x: frame.x, y: frame.y }, taken, size, { padX: FRAME_PAD, padTop: FRAME_HEADER, gap: CARD_GAP, maxRowWidth: ROW_MAX })
    taken.push({ id: k, x: at.x, y: at.y, ...size })
    out[k] = at
  }
  return out
}
