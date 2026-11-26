import { useSyncExternalStore } from 'react'

/** 左侧活动栏的分区 */
export type Section = 'overview' | 'canvas' | 'files' | 'search' | 'chat' | 'group' | 'commands' | 'changes' | 'tasks' | 'schedules' | 'memory' | 'skills' | 'playground' | 'audit' | 'team' | 'settings'

/**
 * 导航目标。id 的含义按分区：
 * - team：agentId，或 `role:<roleId>`；新建 AI（外部或内置）是 `new`，新建职位是 `role:new`
 * - chat：agentId（新建内置 AI 走 team 的 `new`）
 * - group：频道 id（大厅 `general`，工作区 `ws:<workspaceId>`）；不设时进当前工作区的频道，没有就进大厅
 * - commands：AI 命令的 command_id
 * - changes：`step:<检查点 id>` 或 `session:<会话 id>`（当前工作区的）
 * - tasks / memory / skills：条目 id（memory 新建是 `'new'`）
 * - schedules：定时任务 id，新建是 `'new'`
 * - playground：工具名（选中的 AI 存在 localStorage，不放在这里）
 * - canvas：不用（选中哪张卡片、镜头在哪，记在 lib/canvasStore 里）
 * - overview / files / search / audit / settings：不用
 */
export interface NavTarget {
  section: Section
  id?: string
}

export const SECTIONS: readonly Section[] = ['overview', 'canvas', 'files', 'search', 'chat', 'group', 'commands', 'changes', 'tasks', 'schedules', 'memory', 'skills', 'playground', 'audit', 'team', 'settings']

const STORAGE_KEY = 'wb.nav.section'

interface NavState {
  section: Section
  /** 每个分区各自记住上次选中的条目，切回来时还在 */
  ids: Partial<Record<Section, string>>
}

function initialSection(): Section {
  try {
    const s = localStorage.getItem(STORAGE_KEY) as Section | null
    if (s && SECTIONS.includes(s)) return s
  } catch {
    // localStorage 不可用时用默认值
  }
  // 第一次打开进概览（MCP 控制台首页）
  return 'overview'
}

let state: NavState = { section: initialSection(), ids: {} }
let snapshot: NavTarget = { section: state.section }
const listeners = new Set<() => void>()

function commit(next: NavState): void {
  state = next
  const id = next.ids[next.section]
  if (snapshot.section !== next.section || snapshot.id !== id) snapshot = { section: next.section, id }
  try {
    localStorage.setItem(STORAGE_KEY, next.section)
  } catch {
    // 忽略
  }
  for (const l of listeners) l()
}

/**
 * 切换分区 / 选中条目。
 * - `navigate({ section: 'tasks' })`：只切分区，保留这个分区上次选中的条目
 * - `navigate({ section: 'tasks', id: 't_1' })`：切过去并选中
 * - `navigate({ section: 'tasks', id: undefined })`：显式传 id 键（值为 undefined）表示清除选中
 */
export function navigate(t: NavTarget): void {
  const ids = 'id' in t ? { ...state.ids, [t.section]: t.id } : state.ids
  if (ids === state.ids && t.section === state.section) return
  commit({ section: t.section, ids })
}

/** 当前分区和它选中的条目 */
export function useNav(): NavTarget {
  return useSyncExternalStore(subscribe, getNav, getNav)
}

/** 非 React 代码里读当前导航 */
export function getNav(): NavTarget {
  return snapshot
}

/** 某个分区记住的条目（不切换分区） */
export function navId(section: Section): string | undefined {
  return state.ids[section]
}

/** 清掉某些分区记住的条目，不切换分区（例如换工作区后，任务、记忆的选中就失效了） */
export function clearNavIds(...sections: Section[]): void {
  if (!sections.some((s) => state.ids[s] !== undefined)) return
  const ids = { ...state.ids }
  for (const s of sections) delete ids[s]
  commit({ section: state.section, ids })
}

/** 打开文件前调用：当前不在 files / search 分区时切到 files，让编辑区可见 */
export function revealEditor(): void {
  if (state.section !== 'files' && state.section !== 'search') navigate({ section: 'files' })
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
