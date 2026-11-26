// 类 Codex 界面第 3 步：右栏（变更 / 任务 / 活动）用到的纯函数和两个小状态
import { useSyncExternalStore } from 'react'
import type { BridgeState, CheckpointStepView, TaskItem } from '../../../core/types'
import { mergeStepFiles, type ChangeCardFile } from './changeCards'
import { STATUS_ORDER } from './format'
import { channelInfo, channelWorkspaceId, resolveChannel, wsChannel } from './groupChat'
import type { Section } from './nav'
import type { HomeTarget } from './projects'
import { openTool, updatePanelTabs, type ToolId } from './rightTabs'

/** 右栏的工具页。右栏现在是可开可关的标签页（lib/rightTabs.ts），这三个是其中固定的三种 */
export type RightTab = ToolId

/**
 * 右栏的「变更」「任务」看哪个项目：正在看的会话 / 任务属于哪个项目就看哪个，别的页面看当前工作区。
 * home：首页主区里选中的东西（已经确认还存在的）；navId：群聊页选中的频道
 */
export function panelWorkspaceId(state: BridgeState, where: { section: Section; home?: HomeTarget; navId?: string }): string | undefined {
  const known = (id: string | undefined): string | undefined => (id && (state.workspaces ?? []).some((w) => w.id === id) ? id : undefined)
  let id: string | undefined
  if (where.section === 'overview') {
    if (where.home?.kind === 'channel') id = known(channelWorkspaceId(where.home.channel))
    else if (where.home?.kind === 'task') id = known(where.home.workspaceId)
  } else if (where.section === 'group') id = known(channelWorkspaceId(resolveChannel(state, where.navId)))
  return id ?? state.activeWorkspaceId ?? undefined
}

/**
 * 右栏「活动」按群聊看时看哪个群聊：正在看的会话 / 群聊；别的页面是右栏所在项目的主群聊。
 * 都没有（没有项目）返回 undefined
 */
export function panelChannel(state: BridgeState, where: { section: Section; home?: HomeTarget; navId?: string }): string | undefined {
  if (where.section === 'overview' && where.home?.kind === 'channel') return where.home.channel
  if (where.section === 'group') return resolveChannel(state, where.navId)
  const ws = panelWorkspaceId(state, where)
  return ws && channelInfo(state, wsChannel(ws)) ? wsChannel(ws) : undefined
}

/** 同一个 AI 连着改的几步算「一次改动」：同一个会话，前后两步隔得不超过这么久 */
export const GROUP_GAP_MS = 10 * 60 * 1000

export interface ChangeGroup {
  /** 最后一步的 id */
  id: string
  agentId: string
  agentName: string
  agentColor?: string
  firstTs: number
  lastTs: number
  /** 旧的在前 */
  stepIds: string[]
  files: ChangeCardFile[]
  additions: number
  deletions: number
  rolledBack: 'none' | 'partial' | 'all'
}

/** 几步检查点合成一次改动（steps 要按时间从旧到新，不能是空的） */
export function groupOf(steps: CheckpointStepView[]): ChangeGroup {
  const last = steps[steps.length - 1]
  const files = mergeStepFiles(steps)
  const done = steps.filter((s) => s.rolledBack === 'all').length
  return {
    id: last.id,
    agentId: last.agentId,
    agentName: last.agentName,
    agentColor: last.agentColor,
    firstTs: steps[0].ts,
    lastTs: last.ts,
    stepIds: steps.map((s) => s.id),
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    rolledBack: done === steps.length ? 'all' : done > 0 || steps.some((s) => s.rolledBack === 'partial') ? 'partial' : 'none'
  }
}

/** 一个项目最近的改动，新的在前。只算改文件的检查点（回滚那一步本身不算）；没有文件的不列 */
export function changeGroups(steps: CheckpointStepView[], opts: { gapMs?: number; limit?: number } = {}): ChangeGroup[] {
  const gap = opts.gapMs ?? GROUP_GAP_MS
  const sorted = steps.filter((s) => s.kind === 'edit').sort((a, b) => a.ts - b.ts || a.seq - b.seq)
  const open = new Map<string, CheckpointStepView[]>()
  const all: CheckpointStepView[][] = []
  for (const s of sorted) {
    const cur = open.get(s.agentId)
    const prev = cur?.[cur.length - 1]
    if (cur && prev && prev.session === s.session && s.ts - prev.ts <= gap) cur.push(s)
    else {
      const next = [s]
      open.set(s.agentId, next)
      all.push(next)
    }
  }
  return all
    .map(groupOf)
    .filter((g) => g.files.length > 0)
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, opts.limit ?? 30)
}

/** 聊天里某张改动卡片对应的那次改动；这些检查点一个都找不到（太旧，没拉到）时没有 */
export function focusGroup(steps: CheckpointStepView[], stepIds: string[]): ChangeGroup | undefined {
  const want = new Set(stepIds)
  const mine = steps.filter((s) => want.has(s.id)).sort((a, b) => a.ts - b.ts || a.seq - b.seq)
  return mine.length ? groupOf(mine) : undefined
}

/** 右栏「任务」页：没做完的在上面（进行中、待审查、卡住、待办，各自新的在前），做完的另外收着 */
export function panelTasks(tasks: TaskItem[]): { open: TaskItem[]; done: TaskItem[] } {
  const rank = (t: TaskItem): number => STATUS_ORDER.indexOf(t.status)
  const open = tasks.filter((t) => t.status !== 'done').sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
  const done = tasks.filter((t) => t.status === 'done').sort((a, b) => b.updatedAt - a.updatedAt)
  return { open, done }
}

/** 预览文件全文时最多显示这么多行 */
export const PREVIEW_LINES = 400

export function previewLines(content: string, max = PREVIEW_LINES): { lines: string[]; more: number } {
  const all = content.replace(/\r\n/g, '\n').split('\n')
  if (all.length > 1 && all[all.length - 1] === '') all.pop()
  return { lines: all.slice(0, max), more: Math.max(0, all.length - max) }
}

// ========== 翻到哪个工具页 ==========

/** 翻到一个工具页；它被关掉了就重新打开 */
export function setRightTab(t: RightTab): void {
  updatePanelTabs((s) => openTool(s, t))
}

// ========== 聊天里点了「查看变更」：右栏翻到「变更」，把那次改动摆在最上面 ==========

export interface ChangeFocus {
  workspaceId: string
  stepIds: string[]
  /** 每点一次加一：同一张卡片再点一次也要重新展开 */
  seq: number
}

const focusSubs = new Set<() => void>()
const openers = new Set<() => void>()
let focus: ChangeFocus | undefined
let focusSeq = 0

export function showChanges(workspaceId: string, stepIds: string[]): void {
  focus = { workspaceId, stepIds: [...stepIds], seq: ++focusSeq }
  setRightTab('changes')
  for (const l of focusSubs) l()
  for (const o of openers) o()
}

export function clearChangeFocus(): void {
  if (!focus) return
  focus = undefined
  for (const l of focusSubs) l()
}

const getFocus = (): ChangeFocus | undefined => focus

export const useChangeFocus = (): ChangeFocus | undefined =>
  useSyncExternalStore(
    (cb) => {
      focusSubs.add(cb)
      return () => focusSubs.delete(cb)
    },
    getFocus,
    getFocus
  )

/** 右栏收着的时候点了「查看变更」要把它展开：App 在这里登记怎么展开 */
export function onShowChanges(open: () => void): () => void {
  openers.add(open)
  return () => openers.delete(open)
}
