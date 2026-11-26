// 右栏的文件标签：哪些有没保存的改动、要跳到哪一行、哪个标签在等「关不关」的确认。
// 标签本身记在 lib/rightTabs.ts 里（file 标签）；正文和编辑器在 views/FileTab.tsx
import { useSyncExternalStore } from 'react'
import { activate, closeTab, fileTabKey, fileTabsUnder, getPanelTabs, newTabId, openFileTab, renameFileTabs, requestRightPanel, updatePanelTabs } from './rightTabs'

export interface RightReveal {
  key: string
  line: number
  column?: number
  seq: number
}

export interface RightFilesState {
  /** 有没保存的改动的文件（fileTabKey） */
  dirty: ReadonlySet<string>
  /** 打开时带了行号：编辑器跳过去 */
  reveal?: RightReveal
  /** 这个标签有没保存的改动，用户点了关：等确认（标签的 id） */
  closing?: string
}

let st: RightFilesState = { dirty: new Set() }
let seq = 0
const subs = new Set<() => void>()

function set(patch: Partial<RightFilesState>): void {
  st = { ...st, ...patch }
  for (const l of subs) l()
}

const subscribe = (cb: () => void): (() => void) => {
  subs.add(cb)
  return () => subs.delete(cb)
}
const get = (): RightFilesState => st

export const useRightFiles = (): RightFilesState => useSyncExternalStore(subscribe, get, get)
export const getRightFiles = (): RightFilesState => st

/**
 * 在右栏打开一个文件（Ctrl+P 选的）：已经开着就翻过去；正在看的是新标签页就地换掉它，否则加一个标签。
 * 右栏收着就展开；带 line 时跳到那一行
 */
export function openRightFile(t: { workspaceId: string; path: string; line?: number; column?: number }): void {
  updatePanelTabs((s) => openFileTab(s, t, newTabId(), { replaceId: s.active }))
  const s = getPanelTabs()
  const tab = s.tabs.find((x) => x.id === s.active)
  if (tab?.kind !== 'file') return
  requestRightPanel()
  const line = t.line && t.line > 0 ? Math.floor(t.line) : undefined
  if (line) set({ reveal: { key: fileTabKey(tab), line, column: t.column && t.column > 0 ? Math.floor(t.column) : undefined, seq: ++seq } })
}

export function setRightFileDirty(key: string, dirty: boolean): void {
  if (st.dirty.has(key) === dirty) return
  const next = new Set(st.dirty)
  if (dirty) next.add(key)
  else next.delete(key)
  set({ dirty: next })
}

/**
 * 关一个文件标签。有没保存的改动时不直接关：翻到它、挂起来等确认（views/FileTab.tsx 弹出问「保存 / 不保存 / 取消」）；
 * force 是确认过了，直接关
 */
export function closeFileTab(tabId: string, force = false): void {
  const tab = getPanelTabs().tabs.find((t) => t.id === tabId)
  if (tab?.kind !== 'file') return
  const key = fileTabKey(tab)
  if (!force && st.dirty.has(key)) {
    updatePanelTabs((s) => activate(s, tabId))
    set({ closing: tabId })
    return
  }
  const dirty = new Set(st.dirty)
  dirty.delete(key)
  set({ dirty, closing: undefined, reveal: st.reveal?.key === key ? undefined : st.reveal })
  updatePanelTabs((s) => closeTab(s, tabId, newTabId()))
}

/** 开着的文件在磁盘上换了地方或者没了：告诉编辑器那一块（views/FileTab.tsx） */
export type RightFileSignal = { type: 'renamed'; pairs: [string, string][] } | { type: 'deleted'; keys: string[] }
const signalSubs = new Set<(s: RightFileSignal) => void>()
export function onRightFileSignal(cb: (s: RightFileSignal) => void): () => void {
  signalSubs.add(cb)
  return () => signalSubs.delete(cb)
}

/**
 * 文件或目录改了名 / 移走了（用户在文件树里改的，或者 AI 用 move 工具改的）：右栏里开着的标签跟着换路径。
 * 先发信号让编辑器把正文和没保存的改动搬到新路径下，再换标签——反过来的话旧标签一没，它的内容就被当成「关掉了」丢掉。
 * 不要在 React 的 effect 里直接调（编辑器那边要同步落一次状态），放到 effect 外面
 */
export function renameRightFiles(workspaceId: string, from: string, to: string): void {
  const { next, pairs } = renameFileTabs(getPanelTabs(), workspaceId, from, to)
  if (!pairs.length) return
  for (const cb of signalSubs) cb({ type: 'renamed', pairs })
  const map = new Map(pairs)
  if (st.reveal && map.has(st.reveal.key)) set({ reveal: undefined })
  updatePanelTabs(() => next)
}

/** 文件或目录被删了：右栏里开着的标签不关（里面可能有没保存的东西），标成「已经不在了」，由用户决定关掉还是存回去 */
export function markRightFilesDeleted(workspaceId: string, path: string): void {
  const keys = fileTabsUnder(getPanelTabs(), workspaceId, path).map(fileTabKey)
  if (keys.length) for (const cb of signalSubs) cb({ type: 'deleted', keys })
}

export function cancelCloseFileTab(): void {
  if (st.closing) set({ closing: undefined })
}

/** 右栏的文件那一块被卸掉了（比如切到手机布局）：编辑器里的正文跟着没了，「没保存」的记号也清掉，下次从磁盘重读 */
export function resetRightFiles(): void {
  if (st.dirty.size || st.closing || st.reveal) set({ dirty: new Set(), closing: undefined, reveal: undefined })
}
