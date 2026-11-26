// 编辑区的标签页状态（ui-code）。纯状态，不引入 Monaco；搜索、快速打开、活动流都通过 openFile 打开文件
import { useSyncExternalStore } from 'react'
import { revealEditor } from './nav'

export interface OpenFileTarget {
  workspaceId: string
  /** 工作区相对路径，/ 分隔 */
  path: string
  /** 跳到这一行并高亮，从 1 开始 */
  line?: number
  /** 从 1 开始 */
  column?: number
  /** 默认 true：预览标签（斜体，再单击别的文件会被替换）；false 直接固定 */
  preview?: boolean
}

export interface EditorTab {
  /** `${workspaceId}:${path}` */
  key: string
  workspaceId: string
  path: string
  /** 预览标签：斜体，双击或编辑后固定 */
  preview: boolean
  /** 有未保存的修改 */
  dirty: boolean
}

/** openFile 带行号时的跳转请求；编辑器跳过去后调 clearReveal(seq) */
export interface RevealRequest {
  key: string
  line: number
  column?: number
  seq: number
}

export interface EditorSnapshot {
  tabs: EditorTab[]
  activeKey?: string
  /** 当前激活的标签（{ workspaceId, path } 在这里拿） */
  active?: EditorTab
  reveal?: RevealRequest
}

export const tabKey = (workspaceId: string, path: string): string => `${workspaceId}:${path}`

/** 统一成工作区相对、/ 分隔、没有开头的 ./ 和 / */
export function normPath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

let snap: EditorSnapshot = { tabs: [] }
/** 最近用过的顺序，关掉当前标签时激活上一个用过的 */
let mru: string[] = []
let seq = 0
const listeners = new Set<() => void>()

function commit(tabs: EditorTab[], activeKey: string | undefined, reveal: RevealRequest | undefined = snap.reveal): void {
  const active = tabs.find((t) => t.key === activeKey)
  const keys = new Set(tabs.map((t) => t.key))
  mru = mru.filter((k) => keys.has(k) && k !== active?.key)
  if (active) mru.unshift(active.key)
  snap = { tabs, activeKey: active?.key, active, reveal: reveal && keys.has(reveal.key) ? reveal : undefined }
  for (const l of listeners) l()
}

/** 打开文件（切到编辑区）。已打开就激活；带 line 时跳到那一行并高亮 */
export function openFile(t: OpenFileTarget): void {
  const path = normPath(t.path ?? '')
  if (!t.workspaceId || !path || path === '.') return
  revealEditor()
  const key = tabKey(t.workspaceId, path)
  const preview = t.preview !== false
  let tabs = snap.tabs
  const existing = tabs.find((x) => x.key === key)
  if (existing) {
    if (!preview && existing.preview) tabs = tabs.map((x) => (x.key === key ? { ...x, preview: false } : x))
  } else {
    const tab: EditorTab = { key, workspaceId: t.workspaceId, path, preview, dirty: false }
    // 预览标签只有一个：新的预览替换旧的
    const pi = preview ? tabs.findIndex((x) => x.preview && !x.dirty) : -1
    if (pi >= 0) {
      tabs = tabs.slice()
      tabs[pi] = tab
    } else {
      const ai = tabs.findIndex((x) => x.key === snap.activeKey)
      tabs = ai < 0 ? [...tabs, tab] : [...tabs.slice(0, ai + 1), tab, ...tabs.slice(ai + 1)]
    }
  }
  const line = t.line && t.line > 0 ? Math.floor(t.line) : undefined
  commit(tabs, key, line ? { key, line, column: t.column && t.column > 0 ? Math.floor(t.column) : undefined, seq: ++seq } : snap.reveal)
}

export function setActiveTab(key: string): void {
  if (snap.activeKey !== key && snap.tabs.some((t) => t.key === key)) commit(snap.tabs, key)
}

/** 预览标签转成固定标签 */
export function pinTab(key: string): void {
  if (snap.tabs.some((t) => t.key === key && t.preview)) commit(
    snap.tabs.map((t) => (t.key === key ? { ...t, preview: false } : t)),
    snap.activeKey
  )
}

/** 编辑后自动固定 */
export function setTabDirty(key: string, dirty: boolean): void {
  const t = snap.tabs.find((x) => x.key === key)
  if (!t || (t.dirty === dirty && (!dirty || !t.preview))) return
  commit(
    snap.tabs.map((x) => (x.key === key ? { ...x, dirty, preview: dirty ? false : x.preview } : x)),
    snap.activeKey
  )
}

/** 直接关掉（不问未保存），未保存的确认由编辑区负责 */
export function closeTabs(keys: string[]): void {
  const drop = new Set(keys)
  if (!snap.tabs.some((t) => drop.has(t.key))) return
  const tabs = snap.tabs.filter((t) => !drop.has(t.key))
  let active = snap.activeKey
  if (active && drop.has(active)) {
    active = mru.find((k) => !drop.has(k))
    if (!active) {
      const i = snap.tabs.findIndex((t) => t.key === snap.activeKey)
      active = (tabs[i] ?? tabs[i - 1] ?? tabs[tabs.length - 1])?.key
    }
  }
  commit(tabs, active)
}

/** 关掉某个工作区里某路径（含其下所有文件）的标签 */
export function tabsUnder(workspaceId: string, path: string): EditorTab[] {
  const p = normPath(path)
  return snap.tabs.filter((t) => t.workspaceId === workspaceId && (!p || t.path === p || t.path.startsWith(p + '/')))
}

/** 文件或目录改名 / 移动后，更新打开的标签 */
export function renameTabs(workspaceId: string, from: string, to: string): void {
  const f = normPath(from)
  const n = normPath(to)
  let changed = false
  const map = new Map<string, string>()
  const tabs = snap.tabs.map((t) => {
    if (t.workspaceId !== workspaceId || !(t.path === f || t.path.startsWith(f + '/'))) return t
    changed = true
    const path = n + t.path.slice(f.length)
    const key = tabKey(workspaceId, path)
    map.set(t.key, key)
    return { ...t, path, key }
  })
  if (!changed) return
  mru = mru.map((k) => map.get(k) ?? k)
  commit(tabs, snap.activeKey && (map.get(snap.activeKey) ?? snap.activeKey), undefined)
}

/** 拖动标签换位置 */
export function moveTab(key: string, beforeKey: string | null): void {
  const t = snap.tabs.find((x) => x.key === key)
  if (!t || key === beforeKey) return
  const rest = snap.tabs.filter((x) => x.key !== key)
  const i = beforeKey ? rest.findIndex((x) => x.key === beforeKey) : -1
  commit(i < 0 ? [...rest, t] : [...rest.slice(0, i), t, ...rest.slice(i)], snap.activeKey)
}

export function clearReveal(s: number): void {
  if (snap.reveal?.seq === s) commit(snap.tabs, snap.activeKey, undefined)
}

/** 非 React 代码里读 */
export function getEditor(): EditorSnapshot {
  return snap
}

/** 当前激活的文件；没有打开的文件时为 undefined */
export function getActiveFile(): { workspaceId: string; path: string } | undefined {
  return snap.active && { workspaceId: snap.active.workspaceId, path: snap.active.path }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** 标签页和当前文件：`const { tabs, active } = useEditor()`，active?.workspaceId / active?.path */
export function useEditor(): EditorSnapshot {
  return useSyncExternalStore(subscribe, getEditor, getEditor)
}
