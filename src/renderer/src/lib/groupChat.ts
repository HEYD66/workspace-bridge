// 群聊（.team/chat-contract.md）：按频道缓存消息、草稿、频道列表，以及消息流用到的纯函数
import { useEffect, useSyncExternalStore } from 'react'
import type { Agent, BridgeState, GroupChannelInfo, GroupMessage, WorkspaceView } from '../../../core/types'
import type { GroupChatSendInput } from '../../../shared/api'
import { errText } from './format'

/** 一次拉多少条；往上翻时再按 before 拉更早的。停在底部时页面上也只留这么多条（用户 #117） */
export const PAGE = 100
/** 每个频道在内存里最多留这么多条 */
const MAX_KEEP = 2000
/** 单条最长字数（约定：8000） */
export const MAX_TEXT = 8000
/** 同一个人连续发言、间隔不超过这么久就合并成一组 */
const GROUP_GAP = 5 * 60 * 1000

/** 大厅；私聊也都在这里 */
export const LOBBY = 'general'

/** 工作区频道的 id */
export function wsChannel(workspaceId: string): string {
  return `ws:${workspaceId}`
}

export function sendGroupChat(input: GroupChatSendInput & { channel: string }): Promise<GroupMessage> {
  // 私聊只能发在大厅
  return window.bridge.sendGroupChat(input.to ? { ...input, channel: LOBBY } : input)
}

export function markGroupChatRead(channel: string, seq: number): Promise<void> {
  return window.bridge.markGroupChatRead(channel, seq)
}

/**
 * 设频道的干活方式：leadId 给 AI 的 id 是「分工明确」（它当主脑），给 null 是「灵感激荡」。
 * subIds 顺便定下子代理（数组是选中的，null 是不挑，不传是不动）。出错时错误写进 useModeError
 */
export async function setGroupChatLead(channel: string, leadId: string | null, subIds?: string[] | null): Promise<void> {
  setModeError(undefined)
  try {
    if (subIds === undefined) await window.bridge.setGroupChatLead(channel, leadId)
    else await window.bridge.setGroupChatLead(channel, leadId, subIds)
  } catch (e) {
    setModeError(errText(e))
  }
}

/** 「分工明确」的频道选子代理：数组是选中的 AI，null 是不挑（主脑以外都算）。出错时错误写进 useModeError */
export async function setGroupChatSubs(channel: string, subIds: string[] | null): Promise<void> {
  setModeError(undefined)
  try {
    await window.bridge.setGroupChatSubs(channel, subIds)
  } catch (e) {
    setModeError(errText(e))
  }
}

/** 「灵感激荡」的频道挑参与讨论的 AI：数组是选中的 AI（至少一个），null 是不挑（都参与）。出错时错误写进 useModeError */
export async function setGroupChatParticipants(channel: string, ids: string[] | null): Promise<void> {
  setModeError(undefined)
  try {
    await window.bridge.setGroupChatParticipants(channel, ids)
  } catch (e) {
    setModeError(errText(e))
  }
}

// ========== 会话（项目里另开的群聊） ==========

/** 在一个工作区里新开会话；title 不给由主进程起名。返回新频道的 id */
export async function newThread(workspaceId: string, title?: string): Promise<string> {
  return (await window.bridge.newGroupChatThread(workspaceId, title)).id
}

/** 是不是另开的会话（主群聊、大厅不是） */
export const isThread = (c: GroupChannelInfo | undefined): boolean => !!c?.thread

/** 侧栏里这个频道叫什么：会话用它的标题，主群聊用用户起的名字（没起过叫「群聊」），大厅叫「大厅」 */
export function channelLabel(c: GroupChannelInfo): string {
  return c.thread ? c.thread.title : c.id === LOBBY ? '大厅' : c.title || '群聊'
}

/** 带项目名的全称（页头、群聊页的频道列表、命令面板）：起过名字的主群聊是「工作区名 / 名字」，别的就是 name */
export function channelFullName(c: GroupChannelInfo): string {
  return c.title && !c.thread ? `${c.name} / ${c.title}` : c.name
}

/** 排序用的时间：最后一条消息的时间；还没有消息的会话用创建时间 */
export function channelTs(c: GroupChannelInfo): number {
  return c.lastTs || c.thread?.createdAt || 0
}

/** 频道清空过（state 里的 floor 变了）：缓存里这个序号及之前的消息丢掉 */
export function pruneCleared(ch: string, floor: number | undefined): void {
  const s = stores.get(ch)
  if (!floor || !s || !s.messages.some((m) => m.seq <= floor)) return
  set(ch, { messages: s.messages.filter((m) => m.seq > floor), hasMore: false })
}

/** 旧消息没有 channel 字段时算大厅 */
const channelOf = (m: GroupMessage) => m.channel || LOBBY

// ========== 消息缓存（每个频道一份） ==========

export interface ChannelStore {
  messages: GroupMessage[]
  loaded: boolean
  loading: boolean
  error?: string
  /** 服务端还有更早的消息 */
  hasMore: boolean
}

const EMPTY: ChannelStore = { messages: [], loaded: false, loading: false, hasMore: false }
const stores = new Map<string, ChannelStore>()
const listeners = new Set<() => void>()
let subscribed = false

const get = (ch: string) => stores.get(ch) ?? EMPTY

function set(ch: string, patch: Partial<ChannelStore>): void {
  stores.set(ch, { ...get(ch), ...patch })
  for (const l of listeners) l()
}

/** 按 seq 合并去重（发送返回的消息和推送的消息可能是同一条） */
function merge(cur: GroupMessage[], add: GroupMessage[]): GroupMessage[] {
  const bySeq = new Map<number, GroupMessage>()
  for (const m of cur) bySeq.set(m.seq, m)
  for (const m of add) bySeq.set(m.seq, m)
  const all = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  return all.length > MAX_KEEP ? all.slice(-MAX_KEEP) : all
}

/** 按消息自带的频道放进对应缓存；没加载过的频道不收（打开时会整页拉） */
export function addMessages(add: GroupMessage[]): void {
  const by = new Map<string, GroupMessage[]>()
  for (const m of add) by.set(channelOf(m), [...(by.get(channelOf(m)) ?? []), m])
  for (const [ch, list] of by) if (get(ch).loaded) set(ch, { messages: merge(get(ch).messages, list) })
}
function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  window.bridge.onChanged((kind, payload) => {
    if (kind !== 'chat') return
    const msg = payload
    if (!msg || !msg.seq) {
      // 推送没带消息：已加载的频道都往后补拉
      for (const ch of stores.keys()) void loadNewer(ch)
      return
    }
    const ch = channelOf(msg)
    const s = get(ch)
    if (!s.loaded) return
    const last = s.messages[s.messages.length - 1]
    // 中间漏了（seq 跳号）：从最后一条往后补拉
    if (last && msg.seq > last.seq + 1) void loadNewer(ch)
    else addMessages([msg])
  })
}

export async function loadLatest(ch: string): Promise<void> {
  if (get(ch).loading) return
  set(ch, { loading: true })
  try {
    const list = await window.bridge.listGroupChat({ channel: ch, limit: PAGE })
    set(ch, { messages: merge(get(ch).messages, list), loaded: true, loading: false, error: undefined, hasMore: list.length >= PAGE })
  } catch (e) {
    set(ch, { loading: false, error: errText(e) })
  }
}

async function loadNewer(ch: string): Promise<void> {
  const s = get(ch)
  const last = s.messages[s.messages.length - 1]
  if (!last) return loadLatest(ch)
  try {
    const list = await window.bridge.listGroupChat({ channel: ch, after: last.seq, limit: PAGE })
    if (list.length) set(ch, { messages: merge(get(ch).messages, list) })
  } catch {
    // 下一条推送来时再补
  }
}

/**
 * 只留最新的 keep 条。多出来的从前面收起，trimmed=true（服务端还能按 before 拉回来，所以调用方要把 hasMore 设成 true）
 */
export function keepLatest(messages: GroupMessage[], keep = PAGE): { messages: GroupMessage[]; trimmed: boolean } {
  if (keep < 1 || messages.length <= keep) return { messages, trimmed: false }
  return { messages: messages.slice(-keep), trimmed: true }
}

/** 停在底部看新消息时调用：频道缓存只留最新 keep 条，更早的收起，往上翻再加载 */
export function trimToLatest(ch: string, keep = PAGE): void {
  const s = get(ch)
  if (s.loading) return
  const r = keepLatest(s.messages, keep)
  if (r.trimmed) set(ch, { messages: r.messages, hasMore: true })
}

/** 拉更早的一页；返回拉到了几条 */
export async function loadOlder(ch: string): Promise<number> {
  const s = get(ch)
  const first = s.messages[0]
  if (!first || s.loading) return 0
  set(ch, { loading: true })
  try {
    const list = await window.bridge.listGroupChat({ channel: ch, before: first.seq, limit: PAGE })
    set(ch, { messages: merge(list, get(ch).messages), loading: false, hasMore: list.length >= PAGE })
    return list.length
  } catch (e) {
    set(ch, { loading: false, error: errText(e) })
    return 0
  }
}

/** 订阅某个频道的消息缓存；第一次打开这个频道时拉最新一页 */
export function useGroupMessages(ch: string): ChannelStore {
  ensureSubscribed()
  const s = useSyncExternalStore(subscribe, () => get(ch), () => get(ch))
  useEffect(() => {
    if (!get(ch).loaded && !get(ch).loading) void loadLatest(ch)
  }, [ch])
  return s
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
// ========== 草稿（每个频道一份）和成员过滤（侧栏和主区共用） ==========

export interface Draft {
  text: string
  /** 私聊对象 agent id；只在大厅用 */
  to?: string
  replyTo?: GroupMessage
}

const NO_DRAFT: Draft = { text: '' }
const drafts = new Map<string, Draft>()
/** 侧栏点选的成员：只看和他相关的消息 */
let member: string | undefined
const uiListeners = new Set<() => void>()

function emitUi(): void {
  for (const l of uiListeners) l()
}

function subscribeUi(l: () => void): () => void {
  uiListeners.add(l)
  return () => {
    uiListeners.delete(l)
  }
}

export function setDraft(ch: string, patch: Partial<Draft>): void {
  drafts.set(ch, { ...(drafts.get(ch) ?? NO_DRAFT), ...patch })
  emitUi()
}

export function useDraft(ch: string): Draft {
  return useSyncExternalStore(subscribeUi, () => drafts.get(ch) ?? NO_DRAFT, () => drafts.get(ch) ?? NO_DRAFT)
}

export function setMemberFilter(id: string | undefined): void {
  member = id
  emitUi()
}

export function useMemberFilter(): string | undefined {
  return useSyncExternalStore(subscribeUi, () => member, () => member)
}

/** 切换干活方式出的错（头上的开关和成员右键菜单共用一处显示） */
let modeError: string | undefined

export function setModeError(text: string | undefined): void {
  if (modeError === text) return
  modeError = text
  emitUi()
}

export function useModeError(): string | undefined {
  return useSyncExternalStore(subscribeUi, () => modeError, () => modeError)
}

// ========== 频道列表 ==========

/** state.chat.channels：大厅放第一个，其余按最后一条消息的时间排，新的在前 */
export function channelsOf(state: BridgeState): GroupChannelInfo[] {
  // 旧版主进程推来的 state 可能没有 chat 或 channels
  const chat = state.chat as BridgeState['chat'] | undefined
  const list = chat?.channels ?? []
  const lobby = list.find((c) => c.id === LOBBY) ?? { id: LOBBY, name: '大厅', unread: chat?.unread ?? 0, mentions: chat?.mentions ?? 0, lastTs: 0 }
  const rest = list.filter((c) => c.id !== LOBBY).sort((a, b) => channelTs(b) - channelTs(a) || a.name.localeCompare(b.name, 'zh-CN'))
  return [lobby, ...rest]
}

/** 按 id 找频道信息：频道列表里的，或任务的线（它不在频道列表里） */
export function channelInfo(state: BridgeState, id: string): GroupChannelInfo | undefined {
  const chat = state.chat as BridgeState['chat'] | undefined
  return channelsOf(state).find((c) => c.id === id) ?? chat?.taskThreads?.find((c) => c.id === id)
}

/** 这条任务的线（开了才有）。workspaceId 不给时只按任务 id 找 */
export function taskThreadOf(state: BridgeState, taskId: string, workspaceId?: string): GroupChannelInfo | undefined {
  const chat = state.chat as BridgeState['chat'] | undefined
  return chat?.taskThreads?.find((c) => c.task?.id === taskId && (!workspaceId || c.workspaceId === workspaceId))
}

/** 活动栏角标：所有频道的未读和 @ 你的数加起来 */
export function chatTotals(state: BridgeState): { unread: number; mentions: number } {
  let unread = 0
  let mentions = 0
  for (const c of channelsOf(state)) {
    // 归档的会话不算
    if (c.thread?.archived) continue
    unread += c.unread
    mentions += c.mentions
  }
  return { unread, mentions }
}

/** 没选频道或选的频道没了：进当前工作区的频道，没有就进大厅 */
export function resolveChannel(state: BridgeState, id: string | undefined): string {
  const list = channelsOf(state)
  if (id && list.some((c) => c.id === id)) return id
  const ws = state.activeWorkspaceId ? wsChannel(state.activeWorkspaceId) : undefined
  return ws && list.some((c) => c.id === ws) ? ws : LOBBY
}

/** 'ws:<id>'（主群聊）和 'ws:<id>.c_<会话>'（另开的会话）→ 工作区 id；大厅返回 undefined */
export function channelWorkspaceId(ch: string): string | undefined {
  if (!ch.startsWith('ws:')) return undefined
  const dot = ch.indexOf('.')
  return dot < 0 ? ch.slice(3) : ch.slice(3, dot)
}

/** 能不能访问这个频道：大厅谁都能；目录工作区的频道看工作区成员（没设成员名单是谁都能）；整台电脑的频道要开了「整台电脑」 */
export function canAccess(agent: Agent, ch: string, workspaces: WorkspaceView[]): boolean {
  const wsId = channelWorkspaceId(ch)
  if (!wsId) return true
  const ws = workspaces.find((w) => w.id === wsId)
  if (!ws) return true
  if (ws.kind === 'machine') return agent.machineAccess === true
  return !ws.members || ws.members.includes(agent.id)
}

// ========== 纯函数 ==========

export const USER_COLOR = '#8b949e'
const FALLBACK_COLOR = '#6e7681'

/** 发言人的显示名和颜色：优先用现在的 agent 设置，吊销了就用消息里记的 */
export function senderOf(m: GroupMessage, agents: Agent[]): { name: string; color: string } {
  if (m.from.kind === 'user') return { name: m.from.name || '你', color: USER_COLOR }
  const a = agents.find((x) => x.id === m.from.id)
  return { name: a?.name ?? m.from.name, color: a?.color ?? m.from.color ?? FALLBACK_COLOR }
}

export function memberName(id: string, agents: Agent[]): string {
  if (id === 'user') return '你'
  return agents.find((a) => a.id === id)?.name ?? id
}

/** 「私聊 → 某某」；从对方发给你的显示「私聊 → 你」 */
export function privateLabel(m: GroupMessage, agents: Agent[]): string | undefined {
  return m.to ? `私聊 → ${memberName(m.to, agents)}` : undefined
}

/** 这个频道的主脑（干活方式是「分工明确」时才有）；主脑已经不在 AI 列表里就当没有 */
export function leadOf(state: BridgeState, channel: string): Agent | undefined {
  const id = channelInfo(state, channel)?.leadId
  return id ? state.agents.find((a) => a.id === id) : undefined
}

/** 分工里的角色：lead 主脑、sub 子代理、out 这次没选它 */
export type TeamRole = 'lead' | 'sub' | 'out'

/**
 * 「分工明确」的频道里谁是子代理。members 是能进这个频道的 AI。
 * picked：用户挑过没有（没挑过就是主脑以外都算）；ids：现在算子代理的 AI。「灵感激荡」时返回 undefined
 */
export function subsOf(state: BridgeState, channel: string, members: Agent[]): { picked: boolean; ids: string[] } | undefined {
  const info = channelInfo(state, channel)
  const lead = leadOf(state, channel)
  if (!info || !lead) return undefined
  const others = members.filter((a) => a.id !== lead.id).map((a) => a.id)
  if (!info.subIds) return { picked: false, ids: others }
  const set = new Set(info.subIds)
  return { picked: true, ids: others.filter((id) => set.has(id)) }
}

/**
 * 「灵感激荡」的频道里谁参与讨论。members 是能进这个频道的 AI。
 * picked：用户挑过没有（没挑过就是都参与）；ids：现在参与的 AI。「分工明确」时返回 undefined
 */
export function partsOf(state: BridgeState, channel: string, members: Agent[]): { picked: boolean; ids: string[] } | undefined {
  const info = channelInfo(state, channel)
  if (info?.leadId) return undefined
  const all = members.map((a) => a.id)
  if (!info?.partIds) return { picked: false, ids: all }
  const set = new Set(info.partIds)
  return { picked: true, ids: all.filter((id) => set.has(id)) }
}

/** 这个 AI 在这个频道的分工里是什么角色；「灵感激荡」时是 undefined */
export function teamRole(state: BridgeState, channel: string, agentId: string): TeamRole | undefined {
  const info = channelInfo(state, channel)
  const lead = leadOf(state, channel)
  if (!info || !lead) return undefined
  if (lead.id === agentId) return 'lead'
  return !info.subIds || info.subIds.includes(agentId) ? 'sub' : 'out'
}

/**
 * 这个群聊里的 AI（右栏「活动」按群聊看时用），按 state.agents 的顺序：
 * 任务的线是任务里的 AI；「分工明确」是主脑加子代理；「灵感激荡」是参与讨论的（没挑过就是能进这个频道的全部）
 */
export function channelAgents(state: BridgeState, channel: string): Agent[] {
  const info = channelInfo(state, channel)
  const members = state.agents.filter((a) => canAccess(a, channel, state.workspaces ?? []))
  if (info?.task) return members.filter((a) => info.task!.memberIds.includes(a.id))
  const lead = leadOf(state, channel)
  if (lead) {
    const subs = subsOf(state, channel, members)
    return members.filter((a) => a.id === lead.id || !!subs?.ids.includes(a.id))
  }
  const parts = partsOf(state, channel, members)
  return parts ? members.filter((a) => parts.ids.includes(a.id)) : members
}

/** 选择器里勾的结果要存成什么：全勾上是「不挑」（null，以后新加的 AI 也算），不然是勾中的那几个 */
export function subsToSave(checked: string[], candidates: string[]): string[] | null {
  const set = new Set(checked)
  const ids = candidates.filter((id) => set.has(id))
  return candidates.length > 0 && ids.length === candidates.length ? null : ids
}

/** 频道列表里那行小字：「分工明确 · 主脑 X」，挑过子代理的再带「子代理 N 个」 */
export function modeLine(state: BridgeState, channel: string): string | undefined {
  const lead = leadOf(state, channel)
  const info = channelInfo(state, channel)
  if (!lead || !info) {
    if (info?.leadId) return `分工明确 · 主脑 ${memberName(info.leadId, state.agents)}`
    const p = info?.partIds?.filter((id) => state.agents.some((a) => a.id === id)).length
    return p ? `灵感激荡 · ${p} 个 AI 参与` : undefined
  }
  const n = info.subIds ? info.subIds.filter((id) => id !== lead.id && state.agents.some((a) => a.id === id)).length : undefined
  return `分工明确 · 主脑 ${lead.name}${n === undefined ? '' : ` · 子代理 ${n} 个`}`
}

/** 「分工明确」时发的消息只送给了谁（发的人自己不列）；普通消息和私聊返回 undefined */
export function audienceLabel(m: GroupMessage, agents: Agent[]): string | undefined {
  if (!m.audience || m.to) return undefined
  const others = m.audience.filter((id) => id !== m.from.id)
  // 人多的（@所有人 到主脑和全部子代理）不一个个列
  if (others.length > 4) return `只发给 ${others.slice(0, 3).map((id) => memberName(id, agents)).join('、')} 等 ${others.length} 个`
  return others.length ? `只发给 ${others.map((id) => memberName(id, agents)).join('、')}` : '只发给你'
}

export function mentionsUser(m: GroupMessage): boolean {
  return m.from.kind !== 'user' && (m.mentions.includes('user') || m.mentions.includes('*') || m.to === 'user')
}

/** 和某个成员相关：他发的、发给他的、@ 到他的、「分工明确」时只送给他的 */
export function involves(m: GroupMessage, memberId: string): boolean {
  return m.from.id === memberId || m.to === memberId || m.mentions.includes(memberId) || (m.audience?.includes(memberId) ?? false)
}

function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

export function dayLabel(ts: number, now = Date.now()): string {
  const k = dayKey(ts)
  if (k === dayKey(now)) return '今天'
  if (k === dayKey(now - 86_400_000)) return '昨天'
  const d = new Date(ts)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString('zh-CN', sameYear ? { month: 'long', day: 'numeric', weekday: 'short' } : { year: 'numeric', month: 'long', day: 'numeric' })
}

export type Row = { kind: 'day'; key: string; label: string } | { kind: 'msg'; key: string; m: GroupMessage; first: boolean }

/** 消息流的行：跨天插分隔，同一个人、同一私聊对象、间隔不到 5 分钟的连续消息合并（只有第一条显示头像和名字） */
/** 送给谁变了就另起一组，好在组头上标出来 */
const audienceKey = (m: GroupMessage): string => m.audience?.join(',') ?? ''

export function buildRows(messages: GroupMessage[], now = Date.now()): Row[] {
  const rows: Row[] = []
  let prev: GroupMessage | undefined
  for (const m of messages) {
    const newDay = !prev || dayKey(prev.ts) !== dayKey(m.ts)
    if (newDay) rows.push({ kind: 'day', key: `d:${dayKey(m.ts)}`, label: dayLabel(m.ts, now) })
    // 自动记的事件和说的话不并成一组
    const first = newDay || !prev || (prev.kind === 'event') !== (m.kind === 'event') || prev.from.id !== m.from.id || prev.to !== m.to || prev.workspaceId !== m.workspaceId || audienceKey(prev) !== audienceKey(m) || m.ts - prev.ts > GROUP_GAP
    rows.push({ kind: 'msg', key: m.id, m, first })
    prev = m
  }
  return rows
}

/** 光标前正在输入的 @词：返回 @ 的位置和已输入的部分；没有就返回 undefined */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | undefined {
  const before = text.slice(0, caret)
  const match = /(^|[\s(（，,。:：])@([^\s@]*)$/.exec(before)
  if (!match) return undefined
  return { start: caret - match[2].length - 1, query: match[2] }
}

export interface MentionOption {
  id: string
  /** 插进输入框的名字（去掉空格，后端匹配时也忽略空格） */
  insert: string
  label: string
  color?: string
}

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()

/** 「所有人」这一项的别名：输入其中任何一个的开头都能匹配到（插进去的还是「所有人」） */
const EVERYONE_ALIASES = ['所有人', '全体', '全体成员', '大家', 'all', 'everyone']

/** @ 弹出的候选：所有人 + AI 名单，按已输入部分过滤 */
export function mentionOptions(agents: Agent[], query: string): MentionOption[] {
  const q = norm(query)
  const all: MentionOption[] = [
    { id: '*', insert: '所有人', label: '所有人' },
    ...agents.map((a) => ({ id: a.id, insert: a.name.replace(/\s+/g, ''), label: a.name, color: a.color }))
  ]
  if (!q) return all
  const everyone = EVERYONE_ALIASES.some((w) => w.startsWith(q))
  const hit = (o: MentionOption) => (o.id === '*' ? everyone : norm(o.label).includes(q) || norm(o.id).startsWith(q))
  const front = (o: MentionOption) => (o.id === '*' ? everyone : norm(o.label).startsWith(q))
  // 开头匹配的排前面
  return all.filter(hit).sort((a, b) => Number(!front(a)) - Number(!front(b)))
}

/** 把光标前的 @词换成选中的名字，返回新文本和新光标 */
export function applyMention(text: string, start: number, caret: number, opt: MentionOption): { text: string; caret: number } {
  const ins = `@${opt.insert} `
  return { text: text.slice(0, start) + ins + text.slice(caret), caret: start + ins.length }
}

/** 右键「@他」插进输入框的文字：名字去掉空格 */
export function mentionText(name: string): string {
  return `@${name.replace(/\s+/g, '')} `
}

/** 右键「引用」：把原文变成 Markdown 引用块（每行前加 >），后面空一行接着写 */
export function quoteBlock(text: string, who?: string): string {
  const body = text.replace(/\r\n/g, '\n').trim()
  const lines = (who ? [`${who}：`, ...body.split('\n')] : body.split('\n')).map((l) => (l ? `> ${l}` : '>'))
  return `${lines.join('\n')}\n\n`
}

/** 往草稿里加一段：@ 接在末尾（中间补空格），引用块另起一段 */
export function appendPiece(text: string, piece: string): string {
  if (!text) return piece
  if (piece.startsWith('>')) return `${text.replace(/\s+$/, '')}\n\n${piece}`
  return /\s$/.test(text) ? text + piece : `${text} ${piece}`
}

/** 往某个频道的草稿末尾加一段（右键 @他、引用用） */
export function appendToDraft(ch: string, piece: string, patch: Partial<Draft> = {}): void {
  setDraft(ch, { ...patch, text: appendPiece((drafts.get(ch) ?? NO_DRAFT).text, piece) })
}

/** 引用块里显示的摘要：去掉 Markdown 记号，单行 */
export function snippet(text: string, max = 80): string {
  const t = text.replace(/```[\s\S]*?```/g, '[代码]').replace(/[#>*_`~\[\]]/g, '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}
