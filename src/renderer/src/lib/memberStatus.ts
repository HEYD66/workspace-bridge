// T-23（T-15 的界面部分）：AI 细分状态的显示逻辑，纯函数。零件在 components/MemberStatusBadge.tsx。
// 数据来自 BridgeState.memberStatus（T-15，arena-001 3108665）。能力检测：state 里没有 memberStatus（老工作台）时
// memberStatusOf 返回 undefined，调用方照原来的在线/离线显示。
import type { MemberStatus, MemberStatusKind, TaskStatus } from '../../../core/types'
import { timeAgo, toolLabel } from './format'

export type { MemberStatus, MemberStatusKind }

/** 后端判 stale 的默认分钟数（T-15 可配置，默认 10），只用在说明文字里 */
export const STALE_MINUTES = 10

export const MEMBER_STATUS_META: Record<MemberStatusKind, { label: string; color: string; hint: string }> = {
  working: { label: '工作中', color: '#58a6ff', hint: '正在调用工具，或刚调完还在连续干活' },
  command: { label: '执行命令', color: '#a371f7', hint: '有命令在跑' },
  waiting: { label: '等待消息', color: '#3fb950', hint: '在群聊里等新消息' },
  idle: { label: '空闲', color: '#8b949e', hint: '连着，没有动作' },
  stale: { label: '可能卡住', color: '#d29922', hint: `超过 ${STALE_MINUTES} 分钟没有动静，也不在等消息：可能掉线了，或者这一轮已经结束` },
  offline: { label: '离线', color: '#484f58', hint: '没有连接' },
  paused: { label: '已暂停', color: '#db6d28', hint: '工作台按了暂停' }
}

/** 取某个成员的细分状态；工作台不提供 memberStatus 或没有这个成员时返回 undefined */
export function memberStatusOf(state: { memberStatus?: Record<string, MemberStatus> }, agentId?: string): MemberStatus | undefined {
  if (!agentId || !state.memberStatus) return undefined
  return state.memberStatus[agentId]
}

/** 「3 分钟」「1 小时 5 分钟」这样的持续时间 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h} 小时 ${m % 60} 分钟` : `${h} 小时`
  return `${Math.floor(h / 24)} 天`
}

/** 正在调工具或跑命令：头像上亮活动点 */
export function isBusy(s: MemberStatus): boolean {
  return s.status === 'working' || s.status === 'command'
}

/** 一句话说明，比如「正在读取」「可能卡住（12 分钟没有动静）」 */
export function statusText(s: MemberStatus, now = Date.now()): string {
  const tool = s.tool ? toolLabel(s.tool) : ''
  switch (s.status) {
    case 'working':
      if (!tool) return '工作中'
      return s.calling === false ? `工作中（刚调完${tool}）` : `正在${tool}`
    case 'command':
      if (s.background || !tool) return s.commands ? `执行命令（后台 ${s.commands} 个）` : '执行命令'
      return s.calling === false ? `执行命令（刚调完${tool}）` : `执行命令（正在${tool}）`
    case 'stale':
      return s.lastSeen !== undefined ? `可能卡住（${formatDuration(now - s.lastSeen)}没有动静）` : '可能卡住'
    default:
      return MEMBER_STATUS_META[s.status].label
  }
}

export interface StatusView {
  kind: MemberStatusKind
  label: string
  color: string
  /** 一句话说明 */
  text: string
  /** 处在这个状态多久了；不知道 since 时没有 */
  duration?: string
  /** 成员列表那一行：说明 · 持续时间 */
  line: string
  /** 鼠标悬停的详情，多行 */
  title: string
  /** stale / offline：该提醒派活的人 */
  alert: boolean
}

export function describeMemberStatus(s: MemberStatus, now = Date.now()): StatusView {
  const meta = MEMBER_STATUS_META[s.status]
  const text = statusText(s, now)
  const duration = s.since !== undefined ? formatDuration(now - s.since) : undefined
  // 卡住的说明里已经带了多久没动静，不再重复
  const line = duration && s.status !== 'stale' ? `${text} · ${duration}` : text
  const rows = [`状态：${meta.label}${duration ? `（已 ${duration}）` : ''}`, meta.hint]
  if (s.tool) rows.push(`当前工具：${toolLabel(s.tool)}${s.tool !== toolLabel(s.tool) ? ` ${s.tool}` : ''}${s.calling === false ? '（刚调完）' : s.calling ? '（调用中）' : ''}`)
  if (s.tasks?.length) rows.push(`进行中的任务：${s.tasks.map((t) => `${t.ref} ${t.title}`).join('；')}`)
  if (s.commands) rows.push(`正在跑的命令：${s.commands} 个`)
  rows.push(`连接数：${s.sessions}${s.readers?.length ? `（副连接：${s.readers.join('、')}）` : ''}`)
  rows.push(`最后活动：${s.lastSeen !== undefined ? timeAgo(s.lastSeen, now) : '没有记录'}`)
  return { kind: s.status, label: meta.label, color: meta.color, text, duration, line, title: rows.join('\n'), alert: s.status === 'stale' || s.status === 'offline' }
}

/** 任务卡上的提醒：执行者 stale / offline 且任务还没完成时给一句话，其余返回 undefined */
export function assigneeAlert(s: MemberStatus | undefined, taskStatus: TaskStatus, now = Date.now()): string | undefined {
  if (!s || taskStatus === 'done') return undefined
  if (s.status === 'offline') return s.since !== undefined ? `执行者已离线 ${formatDuration(now - s.since)}` : '执行者离线'
  if (s.status === 'stale') return s.lastSeen !== undefined ? `执行者可能卡住：${formatDuration(now - s.lastSeen)}没有动静` : '执行者可能卡住'
  return undefined
}
