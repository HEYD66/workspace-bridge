// 首页的「项目」侧栏（照 Codex 的样子）：每个工作区是一个项目，下面挂它的群聊、另开的会话和没做完的任务；「最近」跨项目列最近有动静的
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { BridgeState, GroupChannelInfo, TaskItem, WorkspaceView } from '../../../core/types'
import { channelLabel, channelTs, wsChannel } from './groupChat'

/**
 * 首页主区正在看什么：一个频道、某个工作区的一个任务，或者概览页。放在 nav 的 overview 分区的 id 里。
 * 什么都没有 = 「新会话」页（照 Codex：打开就是等你说话的那一页）
 */
export type HomeTarget = { kind: 'channel'; channel: string } | { kind: 'task'; workspaceId: string; taskId: string } | { kind: 'overview' }

export function homeId(t: HomeTarget): string {
  return t.kind === 'overview' ? 'overview' : t.kind === 'channel' ? `ch:${t.channel}` : `task:${t.workspaceId}|${t.taskId}`
}

export function sameTarget(a: HomeTarget | undefined, b: HomeTarget): boolean {
  if (!a || a.kind !== b.kind) return false
  if (a.kind === 'channel') return a.channel === (b as typeof a).channel
  if (a.kind === 'task') return a.workspaceId === (b as typeof a).workspaceId && a.taskId === (b as typeof a).taskId
  return true
}

export function parseHomeId(id: string | undefined): HomeTarget | undefined {
  if (!id) return undefined
  if (id === 'overview') return { kind: 'overview' }
  if (id.startsWith('ch:') && id.length > 3) return { kind: 'channel', channel: id.slice(3) }
  if (id.startsWith('task:')) {
    const rest = id.slice(5)
    const i = rest.indexOf('|')
    if (i > 0 && i < rest.length - 1) return { kind: 'task', workspaceId: rest.slice(0, i), taskId: rest.slice(i + 1) }
  }
  return undefined
}

export interface ProjectRow {
  ws: WorkspaceView
  /** 是不是现在的当前工作区（文件、终端、改动页跟着它） */
  active: boolean
  /** 这个工作区的主群聊；旧版主进程没给时没有 */
  channel?: GroupChannelInfo
  /** 另开的会话（没归档的），最近有动静的在前 */
  threads: GroupChannelInfo[]
  /** 归档的会话，最近有动静的在前 */
  archived: GroupChannelInfo[]
  /** 主群聊和没归档的会话的未读加起来；mentions 是其中点名你的 */
  unread: number
  mentions: number
  /** 没做完的任务：进行中、待审查、受阻、待办，各自按最近更新排 */
  open: TaskItem[]
  /** 等你审查的条数 */
  review: number
  /** 最近有动静的时间（频道最后一条消息、任务最后更新），排序和显示用 */
  lastTs: number
}

const OPEN_ORDER: TaskItem['status'][] = ['in_progress', 'review', 'blocked', 'todo']

/** 每个工作区一行：置顶的在最前（它们之间按列表顺序），然后目录工作区按列表顺序，「整台电脑」放最后 */
export function projectRows(state: BridgeState, tasksByWs: Record<string, TaskItem[]>, pinned: ReadonlySet<string> = new Set()): ProjectRow[] {
  const all = state.workspaces ?? []
  const byKind = [...all.filter((w) => w.kind !== 'machine'), ...all.filter((w) => w.kind === 'machine')]
  const ordered = [...byKind.filter((w) => pinned.has(w.id)), ...byKind.filter((w) => !pinned.has(w.id))]
  const channels = state.chat?.channels ?? []
  return ordered.map((ws) => {
    const tasks = tasksByWs[ws.id] ?? []
    const open = tasks
      .filter((t) => t.status !== 'done')
      .sort((a, b) => OPEN_ORDER.indexOf(a.status) - OPEN_ORDER.indexOf(b.status) || b.updatedAt - a.updatedAt)
    const channel = channels.find((c) => c.id === wsChannel(ws.id))
    const mine = channels.filter((c) => c.thread && c.workspaceId === ws.id).sort((a, b) => channelTs(b) - channelTs(a))
    const threads = mine.filter((c) => !c.thread?.archived)
    const live = [...(channel ? [channel] : []), ...threads]
    return {
      ws,
      active: ws.id === state.activeWorkspaceId,
      ...(channel ? { channel } : {}),
      threads,
      archived: mine.filter((c) => c.thread?.archived),
      unread: live.reduce((s, c) => s + c.unread, 0),
      mentions: live.reduce((s, c) => s + c.mentions, 0),
      open,
      review: open.filter((t) => t.status === 'review').length,
      lastTs: Math.max(0, ...live.map((c) => c.lastTs), ...tasks.map((t) => t.updatedAt))
    }
  })
}

export interface RecentItem {
  key: string
  target: HomeTarget
  title: string
  /** 属于哪个项目（大厅没有） */
  project?: string
  ts: number
  /** 任务才有 */
  status?: TaskItem['status']
  unread?: number
}

/** 跨项目的「最近」：各频道和会话（按最后一条消息；还没消息的会话按创建时间）和各任务（按最后更新）合在一起，新的在前。做完的任务也算，方便回头看；归档的会话不列 */
export function recentItems(state: BridgeState, tasksByWs: Record<string, TaskItem[]>, limit = 8): RecentItem[] {
  const names = new Map((state.workspaces ?? []).map((w) => [w.id, w.name]))
  const out: RecentItem[] = []
  for (const c of state.chat?.channels ?? []) {
    const ts = channelTs(c)
    if (!ts || c.thread?.archived) continue
    out.push({
      key: `ch:${c.id}`,
      target: { kind: 'channel', channel: c.id },
      title: channelLabel(c),
      ...(c.workspaceId ? { project: names.get(c.workspaceId) ?? c.name } : {}),
      ts,
      ...(c.unread ? { unread: c.unread } : {})
    })
  }
  for (const [wsId, tasks] of Object.entries(tasksByWs)) {
    // 工作区已经移出列表：不列
    if (!names.has(wsId)) continue
    for (const t of tasks) out.push({ key: `task:${wsId}|${t.id}`, target: { kind: 'task', workspaceId: wsId, taskId: t.id }, title: `${t.ref} ${t.title}`, project: names.get(wsId), ts: t.updatedAt, status: t.status })
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, limit)
}

/**
 * 侧栏切到「全部会话」时列的：所有没归档的频道和会话（大厅、各项目的群聊和另开的会话），不分项目，最近有动静的在前。
 * 还没有消息的主群聊排在最后。任务的线不在这里（它们只在任务页上）
 */
export function allChats(state: BridgeState): RecentItem[] {
  const names = new Map((state.workspaces ?? []).map((w) => [w.id, w.name]))
  return (state.chat?.channels ?? [])
    .filter((c) => !c.thread?.archived && !c.task)
    .map((c) => ({
      key: `ch:${c.id}`,
      target: { kind: 'channel' as const, channel: c.id },
      title: channelLabel(c),
      ...(c.workspaceId ? { project: names.get(c.workspaceId) ?? c.name } : {}),
      ts: channelTs(c),
      ...(c.unread ? { unread: c.unread } : {})
    }))
    .sort((a, b) => b.ts - a.ts)
}

/** 会话标题最长这么多字（主进程的上限是 60） */
const TITLE_MAX = 30

/**
 * 在「新会话」页直接发消息时，会话的标题取消息的第一行：去掉开头的 @名字 和 Markdown 记号，太长截断。
 * 取不出来（只发了图片、只有 @）返回 undefined，由主进程起名
 */
export function threadTitleFrom(text: string): string | undefined {
  const line =
    text
      .split('\n')
      .map((l) =>
        l
          .replace(/^[\s#>*\-]+/, '')
          .replace(/^(@\S+\s*)+/, '')
          .replace(/\s+/g, ' ')
          .trim()
      )
      .find((l) => l.length > 0) ?? ''
  if (!line) return undefined
  const chars = [...line]
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join('')}…` : line
}

// ========== 各工作区的任务（首页要同时看所有项目的） ==========

/** 每个工作区的任务板各拉一份；任务有变动、工作区列表变了就重拉。state 还没到时返回空 */
export function useAllTasks(state: BridgeState | null | undefined): Record<string, TaskItem[]> {
  const [data, setData] = useState<Record<string, TaskItem[]>>({})
  const ids = (state?.workspaces ?? []).map((w) => w.id).join(',')
  useEffect(() => {
    if (!ids) {
      setData({})
      return
    }
    let dead = false
    let seq = 0
    const load = async () => {
      const mine = ++seq
      const list = ids.split(',')
      const got = await Promise.all(list.map((id) => window.bridge.listTasks(id).catch(() => [] as TaskItem[])))
      // 只认最后一次发出的请求，免得慢的旧结果盖掉新的
      if (!dead && mine === seq) setData(Object.fromEntries(list.map((id, i) => [id, got[i]])))
    }
    void load()
    const off = window.bridge.onChanged((kind) => {
      if (kind === 'tasks') void load()
    })
    return () => {
      dead = true
      off()
    }
  }, [ids])
  return data
}

// ========== 哪些项目是展开的（记在 localStorage） ==========

const KEY = 'wb.projects.expanded'
const listeners = new Set<() => void>()
let expanded: ReadonlySet<string> | undefined

function load(): ReadonlySet<string> {
  if (expanded) return expanded
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    expanded = new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    expanded = new Set()
  }
  return expanded
}

export function setExpanded(id: string, on: boolean): void {
  const next = new Set(load())
  if (on) next.add(id)
  else next.delete(id)
  expanded = next
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]))
  } catch {
    // 存不了就只在这次打开期间有效
  }
  for (const l of listeners) l()
}

export function useExpanded(): ReadonlySet<string> {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    load,
    load
  )
}

// ========== 置顶的项目、侧栏按项目还是按时间列（记在 localStorage） ==========

/** 一个记在 localStorage 里的小状态：读一次后放在内存里，改了通知用到它的组件 */
function stored<T>(key: string, parse: (raw: unknown) => T, fallback: T, dump: (v: T) => unknown = (v) => v): { get: () => T; set: (v: T) => void; use: () => T } {
  const subs = new Set<() => void>()
  let value: T | undefined
  let loaded = false
  const get = (): T => {
    if (!loaded) {
      loaded = true
      try {
        const raw = localStorage.getItem(key)
        value = raw === null ? fallback : parse(JSON.parse(raw))
      } catch {
        value = fallback
      }
    }
    return value as T
  }
  const set = (v: T): void => {
    value = v
    loaded = true
    try {
      localStorage.setItem(key, JSON.stringify(dump(v)))
    } catch {
      // 存不了就只在这次打开期间有效
    }
    for (const l of subs) l()
  }
  const use = (): T =>
    useSyncExternalStore(
      (cb) => {
        subs.add(cb)
        return () => subs.delete(cb)
      },
      get,
      get
    )
  return { get, set, use }
}

const pinnedStore = stored<ReadonlySet<string>>(
  'wb.projects.pinned',
  (raw) => new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []),
  new Set(),
  (v) => [...v]
)

/** 置顶的项目（工作区 id）。只是这台电脑上的界面偏好，不存进配置 */
export const usePinned = (): ReadonlySet<string> => pinnedStore.use()

export function setPinned(id: string, on: boolean): void {
  const next = new Set(pinnedStore.get())
  if (on) next.add(id)
  else next.delete(id)
  pinnedStore.set(next)
}

export type ProjectsView = 'projects' | 'chats'

const viewStore = stored<ProjectsView>('wb.projects.view', (raw) => (raw === 'chats' ? 'chats' : 'projects'), 'projects')

/** 首页侧栏怎么列：按项目分组（默认），还是不分项目按时间列全部会话 */
export const useProjectsView = (): ProjectsView => viewStore.use()
export const setProjectsView = (v: ProjectsView): void => viewStore.set(v)
