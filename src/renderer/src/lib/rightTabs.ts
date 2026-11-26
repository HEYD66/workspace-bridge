// 右栏的标签页（照 Codex）：可开可关，「+」出新标签页；工具页（变更 / 任务 / 活动）各最多一个，网页标签、终端标签可以开好几个。
// 上半是纯函数（tests/rightTabs.test.ts），下半是记在 localStorage 里的小状态
import { useSyncExternalStore } from 'react'
import { browsableUrl } from '../../../shared/browser'

export { browsableUrl }

export type ToolId = 'changes' | 'tasks' | 'activity'

export type PanelTab =
  | { id: ToolId; kind: 'tool' }
  /** 新标签页：地址栏 + 工具 + 最近打开。同一时间最多一个 */
  | { id: string; kind: 'newtab' }
  /** 网页：url 是最后一次导航到的地址（重开应用后从它恢复），title 是网页自己的标题 */
  | { id: string; kind: 'browser'; url: string; title?: string }
  /** 终端：一个终端一个标签。termId 是那个终端的 id（lib/terminals.ts），cwd 是它开在哪个目录，标签名用目录名 */
  | { id: string; kind: 'terminal'; termId: string; cwd: string }
  /** 文件：在右栏里看和改一个文件（views/FileTab.tsx）。path 是工作区相对路径，/ 分隔。同一个文件只有一个标签 */
  | { id: string; kind: 'file'; workspaceId: string; path: string }

export interface PanelTabs {
  tabs: PanelTab[]
  /** 正在看的标签的 id（一定在 tabs 里） */
  active: string
}

export const TOOL_IDS: readonly ToolId[] = ['changes', 'tasks', 'activity']
export const TOOL_LABEL: Record<ToolId, string> = { changes: '变更', tasks: '任务', activity: '活动' }
/** 标签太多挤得看不清，也占内存（每个网页标签是一个独立的网页进程） */
export const MAX_PANEL_TABS = 24
export const MAX_RECENT = 8
/** 地址栏里输的不是网址时拿去搜 */
export const SEARCH_URL = 'https://www.bing.com/search?q='

const isTool = (v: unknown): v is ToolId => v === 'changes' || v === 'tasks' || v === 'activity'
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/
const TERM_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/

export const defaultTabs = (active: ToolId = 'activity'): PanelTabs => ({ tabs: TOOL_IDS.map((id) => ({ id, kind: 'tool' as const })), active })

/** 新标签的 id */
export const newTabId = (): string => `t_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-3)}`

const HOST_RE = /^(localhost|\[[0-9a-f:]+\]|(\d{1,3}\.){3}\d{1,3}|([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9])(:\d{1,5})?([/?#].*)?$/i

/**
 * 地址栏里输的东西变成要打开的地址：
 * 带协议的网址原样；localhost、IP（可带端口）补 http；像域名的补 https；
 * Windows 路径（D:\a\b.html）和 /开头的路径当本地文件；其余的拿去搜。空的返回 undefined
 */
export function addressToUrl(input: string): string | undefined {
  const v = input.trim()
  if (!v) return undefined
  if (/^[a-z]:[\\/]/i.test(v)) return browsableUrl(`file:///${v.replace(/\\/g, '/')}`)
  if (/^\\\\[^\\]/.test(v)) return browsableUrl(`file:${v.replace(/\\/g, '/')}`)
  const direct = /^(https?|file):/i.test(v) || v === 'about:blank' ? browsableUrl(v) : undefined
  if (direct) return direct
  if (!/\s/.test(v) && HOST_RE.test(v)) {
    const local = /^(localhost|\[|(\d{1,3}\.){3}\d{1,3})/i.test(v)
    const u = browsableUrl(`${local ? 'http' : 'https'}://${v}`)
    if (u) return u
  }
  return SEARCH_URL + encodeURIComponent(v)
}

/** 标签上、最近打开里显示的短名字：主机名（带端口）；本地文件是文件名 */
export function siteLabel(url: string): string {
  if (url === 'about:blank') return '空白页'
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '') || '本地文件'
    return u.host.replace(/^www\./, '') || url
  } catch {
    return url
  }
}

/** 目录的名字：路径的最后一段（D:\\a\\proj → proj；盘符根目录 D:\\ → D:） */
export function dirName(dir: string): string {
  const parts = dir
    .trim()
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
  return parts[parts.length - 1] || dir.trim() || '终端'
}

export function tabTitle(t: PanelTab): string {
  if (t.kind === 'tool') return TOOL_LABEL[t.id]
  if (t.kind === 'newtab') return '新标签页'
  if (t.kind === 'terminal') return dirName(t.cwd)
  if (t.kind === 'file') return t.path.slice(t.path.lastIndexOf('/') + 1)
  return t.title?.trim() || siteLabel(t.url)
}

/** 存下来的东西读回来：不认的丢掉，工具页不重复，新标签页最多一个；一个都不剩就回到默认的三个 */
export function parseTabs(raw: unknown, legacyTool?: unknown): PanelTabs {
  const fallback = defaultTabs(isTool(legacyTool) ? legacyTool : 'activity')
  if (!raw || typeof raw !== 'object') return fallback
  const o = raw as { tabs?: unknown; active?: unknown }
  if (!Array.isArray(o.tabs)) return fallback
  const tabs: PanelTab[] = []
  const seen = new Set<string>()
  let hasNew = false
  for (const v of o.tabs) {
    if (!v || typeof v !== 'object' || tabs.length >= MAX_PANEL_TABS) continue
    const t = v as { id?: unknown; kind?: unknown; url?: unknown; title?: unknown; termId?: unknown; cwd?: unknown; workspaceId?: unknown; path?: unknown }
    if (typeof t.id !== 'string' || seen.has(t.id)) continue
    if (t.kind === 'tool' && isTool(t.id)) tabs.push({ id: t.id, kind: 'tool' })
    else if (t.kind === 'newtab' && ID_RE.test(t.id) && !isTool(t.id) && !hasNew) {
      hasNew = true
      tabs.push({ id: t.id, kind: 'newtab' })
    } else if (t.kind === 'browser' && ID_RE.test(t.id) && !isTool(t.id)) {
      const url = browsableUrl(t.url)
      if (!url) continue
      tabs.push({ id: t.id, kind: 'browser', url, ...(typeof t.title === 'string' && t.title ? { title: t.title.slice(0, 200) } : {}) })
    } else if (t.kind === 'terminal' && ID_RE.test(t.id) && !isTool(t.id) && typeof t.termId === 'string' && TERM_ID_RE.test(t.termId) && typeof t.cwd === 'string') {
      const termId = t.termId
      // 一个终端只在一个标签里
      if (tabs.some((x) => x.kind === 'terminal' && x.termId === termId)) continue
      tabs.push({ id: t.id, kind: 'terminal', termId, cwd: t.cwd.slice(0, 1000) })
    } else if (t.kind === 'file' && ID_RE.test(t.id) && !isTool(t.id) && typeof t.workspaceId === 'string' && TERM_ID_RE.test(t.workspaceId) && typeof t.path === 'string') {
      const file = { workspaceId: t.workspaceId, path: filePath(t.path) }
      if (!file.path || file.path.length > 1000 || tabs.some((x) => sameFile(x, file))) continue
      tabs.push({ id: t.id, kind: 'file', ...file })
    } else continue
    seen.add(t.id)
  }
  if (!tabs.length) return fallback
  return { tabs, active: typeof o.active === 'string' && seen.has(o.active) ? o.active : tabs[0].id }
}

export const activeTab = (s: PanelTabs): PanelTab => s.tabs.find((t) => t.id === s.active) ?? s.tabs[0]

export function activate(s: PanelTabs, id: string): PanelTabs {
  return s.active === id || !s.tabs.some((t) => t.id === id) ? s : { ...s, active: id }
}

/** 打开一个工具页并翻到它：已经开着就只翻过去；没开着就加回来，排在别的工具页后面、网页前面 */
export function openTool(s: PanelTabs, id: ToolId): PanelTabs {
  if (s.tabs.some((t) => t.id === id)) return activate(s, id)
  const order = TOOL_IDS.indexOf(id)
  let at = 0
  s.tabs.forEach((t, i) => {
    if (t.kind === 'tool' && TOOL_IDS.indexOf(t.id) < order) at = i + 1
  })
  const tabs = [...s.tabs.slice(0, at), { id, kind: 'tool' as const }, ...s.tabs.slice(at)]
  return { tabs, active: id }
}

/** 点「+」：已经有一个新标签页就翻到它，没有就在最后加一个 */
export function addNewTab(s: PanelTabs, id: string): PanelTabs {
  const cur = s.tabs.find((t) => t.kind === 'newtab')
  if (cur) return activate(s, cur.id)
  if (s.tabs.length >= MAX_PANEL_TABS) return s
  return { tabs: [...s.tabs, { id, kind: 'newtab' }], active: id }
}

/** 关一个标签：关的是正在看的就翻到右边那个（没有就左边）；关完一个不剩就补一个新标签页（id 用 spareId） */
export function closeTab(s: PanelTabs, id: string, spareId: string): PanelTabs {
  const i = s.tabs.findIndex((t) => t.id === id)
  if (i < 0) return s
  const tabs = s.tabs.filter((t) => t.id !== id)
  if (!tabs.length) return { tabs: [{ id: spareId, kind: 'newtab' }], active: spareId }
  return { tabs, active: s.active === id ? (tabs[i] ?? tabs[i - 1]).id : s.active }
}

/** 在新标签页上点了一个工具：打开那个工具页，新标签页自己关掉 */
export function newTabToTool(s: PanelTabs, newId: string, tool: ToolId): PanelTabs {
  const without = s.tabs.filter((t) => !(t.id === newId && t.kind === 'newtab'))
  return openTool({ tabs: without, active: without.some((t) => t.id === s.active) ? s.active : (without[0]?.id ?? tool) }, tool)
}

/** 在一个标签里打开网址：新标签页变成网页标签（id 不变），网页标签改地址。别的标签不动 */
export function navigateTab(s: PanelTabs, id: string, url: string): PanelTabs {
  const u = browsableUrl(url)
  if (!u) return s
  let hit = false
  const tabs = s.tabs.map((t): PanelTab => {
    if (t.id !== id || (t.kind !== 'newtab' && t.kind !== 'browser')) return t
    hit = true
    return { id: t.id, kind: 'browser', url: u }
  })
  return hit ? { tabs, active: id } : s
}

/** 另开一个网页标签（网页里点了「在新窗口打开」的链接、从别处点了网址）：排在 afterId 后面，翻不翻过去看 focus */
export function openBrowserTab(s: PanelTabs, url: string, id: string, opts: { afterId?: string; focus?: boolean } = {}): PanelTabs {
  const u = browsableUrl(url)
  if (!u || s.tabs.length >= MAX_PANEL_TABS || s.tabs.some((t) => t.id === id)) return s
  const i = opts.afterId ? s.tabs.findIndex((t) => t.id === opts.afterId) : -1
  const at = i < 0 ? s.tabs.length : i + 1
  const tabs = [...s.tabs.slice(0, at), { id, kind: 'browser' as const, url: u }, ...s.tabs.slice(at)]
  return { tabs, active: opts.focus === false ? s.active : id }
}

/** 网页自己跳转了、标题变了：记下来。没变就返回原对象 */
export function patchBrowserTab(s: PanelTabs, id: string, patch: { url?: string; title?: string }): PanelTabs {
  let changed = false
  const tabs = s.tabs.map((t): PanelTab => {
    if (t.id !== id || t.kind !== 'browser') return t
    const url = patch.url !== undefined ? (browsableUrl(patch.url) ?? t.url) : t.url
    // 换了地址，旧标题就不作数了，等新网页报自己的标题
    const title = patch.title !== undefined ? patch.title.slice(0, 200) : url !== t.url ? undefined : t.title
    if (url === t.url && title === t.title) return t
    changed = true
    return { id: t.id, kind: 'browser', url, ...(title ? { title } : {}) }
  })
  return changed ? { ...s, tabs } : s
}

// ========== 终端标签 ==========

/** 右栏里放着哪些终端（终端的 id）。不在这里面的终端在底部面板 */
export const terminalTabIds = (s: PanelTabs): string[] => s.tabs.flatMap((t) => (t.kind === 'terminal' ? [t.termId] : []))

/**
 * 把一个终端放进右栏并翻到它：它已经有标签就只翻过去；
 * replaceId 是新标签页的话就地变成终端标签（在新标签页上点的「终端」），否则加在最后。
 * 标签满了放不进去时返回原对象（终端留在底部面板）
 */
export function openTerminalTab(s: PanelTabs, term: { termId: string; cwd: string }, id: string, opts: { replaceId?: string } = {}): PanelTabs {
  const cur = s.tabs.find((t) => t.kind === 'terminal' && t.termId === term.termId)
  if (cur) return activate(s, cur.id)
  const at = opts.replaceId ? s.tabs.findIndex((t) => t.id === opts.replaceId && t.kind === 'newtab') : -1
  if (at >= 0) {
    const tab: PanelTab = { id: s.tabs[at].id, kind: 'terminal', termId: term.termId, cwd: term.cwd }
    return { tabs: s.tabs.map((t, i) => (i === at ? tab : t)), active: tab.id }
  }
  if (s.tabs.length >= MAX_PANEL_TABS || s.tabs.some((t) => t.id === id)) return s
  return { tabs: [...s.tabs, { id, kind: 'terminal', termId: term.termId, cwd: term.cwd }], active: id }
}

/**
 * 终端没了（关掉了、应用重开过）：它的标签也去掉。alive 是还在的终端的 id。
 * 正在看的那个被去掉就翻到右边那个（没有就左边）；一个不剩就补一个新标签页。没有要去掉的返回原对象
 */
export function pruneTerminalTabs(s: PanelTabs, alive: ReadonlySet<string>, spareId: string): PanelTabs {
  const gone = s.tabs.filter((t) => t.kind === 'terminal' && !alive.has(t.termId))
  if (!gone.length) return s
  let next = s
  for (const t of gone) next = closeTab(next, t.id, spareId)
  return next
}

// ========== 文件标签 ==========

/** 统一成工作区相对、/ 分隔、没有开头的 ./ 和 /（和 lib/editorStore.ts 的 normPath 一样） */
const filePath = (p: string): string =>
  p
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')

const sameFile = (t: PanelTab, f: { workspaceId: string; path: string }): boolean => t.kind === 'file' && t.workspaceId === f.workspaceId && t.path === f.path

/** 右栏文件标签在编辑器里的身份。带 right: 前缀：和整页编辑器里的同一个文件是两份，各改各的 */
export const fileTabKey = (f: { workspaceId: string; path: string }): string => `right:${f.workspaceId}:${f.path}`

/**
 * 在右栏打开一个文件并翻到它：已经开着就只翻过去；
 * replaceId 是新标签页的话就地变成文件标签，否则加在最后。标签满了、路径是空的返回原对象
 */
export function openFileTab(s: PanelTabs, file: { workspaceId: string; path: string }, id: string, opts: { replaceId?: string } = {}): PanelTabs {
  const f = { workspaceId: file.workspaceId, path: filePath(file.path) }
  if (!f.workspaceId || !f.path || f.path === '.') return s
  const cur = s.tabs.find((t) => sameFile(t, f))
  if (cur) return activate(s, cur.id)
  const at = opts.replaceId ? s.tabs.findIndex((t) => t.id === opts.replaceId && t.kind === 'newtab') : -1
  if (at >= 0) {
    const tab: PanelTab = { id: s.tabs[at].id, kind: 'file', ...f }
    return { tabs: s.tabs.map((t, i) => (i === at ? tab : t)), active: tab.id }
  }
  if (s.tabs.length >= MAX_PANEL_TABS || s.tabs.some((t) => t.id === id)) return s
  return { tabs: [...s.tabs, { id, kind: 'file', ...f }], active: id }
}

const underPath = (p: string, dir: string): boolean => p === dir || p.startsWith(dir + '/')

/** 右栏里开着的、在这个路径上或它下面的文件标签（path 是文件或目录） */
export function fileTabsUnder(s: PanelTabs, workspaceId: string, path: string): Extract<PanelTab, { kind: 'file' }>[] {
  const p = filePath(path)
  if (!p || p === '.') return []
  return s.tabs.flatMap((t) => (t.kind === 'file' && t.workspaceId === workspaceId && underPath(t.path, p) ? [t] : []))
}

/**
 * 文件或目录改名 / 移动后，右栏里开着的文件标签跟着换路径（标签的 id 和位置不变）。
 * pairs 是「旧身份 → 新身份」（fileTabKey），编辑器靠它把没保存的内容搬过去。
 * 新路径上本来就开着另一个标签的（移动时覆盖了它）那个标签去掉，同一个文件只留一个
 */
export function renameFileTabs(s: PanelTabs, workspaceId: string, from: string, to: string): { next: PanelTabs; pairs: [string, string][] } {
  const f = filePath(from)
  const n = filePath(to)
  const pairs: [string, string][] = []
  if (!f || !n || f === n || f === '.' || n === '.') return { next: s, pairs }
  const moved = new Map<string, PanelTab>()
  for (const t of fileTabsUnder(s, workspaceId, f)) {
    const path = n + t.path.slice(f.length)
    moved.set(t.id, { ...t, path })
    pairs.push([fileTabKey(t), fileTabKey({ workspaceId, path })])
  }
  if (!moved.size) return { next: s, pairs }
  const taken = new Set(pairs.map((p) => p[1]))
  const tabs = s.tabs.flatMap((t) => (moved.has(t.id) ? [moved.get(t.id)!] : t.kind === 'file' && taken.has(fileTabKey(t)) ? [] : [t]))
  const active = tabs.some((t) => t.id === s.active) ? s.active : [...moved.keys()][0]
  return { next: { tabs, active }, pairs }
}

// ========== 最近打开的网址 ==========

export interface RecentSite {
  url: string
  title?: string
  ts: number
}

export function parseRecent(raw: unknown): RecentSite[] {
  if (!Array.isArray(raw)) return []
  const out: RecentSite[] = []
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue
    const r = v as { url?: unknown; title?: unknown; ts?: unknown }
    const url = browsableUrl(r.url)
    if (!url || url === 'about:blank' || out.some((x) => x.url === url)) continue
    out.push({ url, ...(typeof r.title === 'string' && r.title ? { title: r.title.slice(0, 200) } : {}), ts: typeof r.ts === 'number' ? r.ts : 0 })
    if (out.length >= MAX_RECENT) break
  }
  return out
}

/** 记一次打开：同一个地址只留一条（挪到最前，标题用新的），最多 MAX_RECENT 条。空白页不记 */
export function addRecent(list: RecentSite[], site: { url: string; title?: string }, now: number): RecentSite[] {
  const url = browsableUrl(site.url)
  if (!url || url === 'about:blank') return list
  const old = list.find((x) => x.url === url)
  const title = site.title?.trim() || old?.title
  return [{ url, ...(title ? { title: title.slice(0, 200) } : {}), ts: now }, ...list.filter((x) => x.url !== url)].slice(0, MAX_RECENT)
}

// ========== 状态（记在 localStorage） ==========

const TABS_KEY = 'wb.layout.rightTabs'
/** 改成标签页之前只记「开着哪一页」：第一次读的时候拿它当正在看的那一页 */
const LEGACY_TAB_KEY = 'wb.layout.rightTab'
const RECENT_KEY = 'wb.browser.recent'

const subs = new Set<() => void>()
let state: PanelTabs | undefined
let recent: RecentSite[] | undefined

const readJson = (key: string): unknown => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}
const writeJson = (key: string, v: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    // 存不了就只在这次打开期间有效
  }
}

export function getPanelTabs(): PanelTabs {
  if (!state) state = parseTabs(readJson(TABS_KEY), readJson(LEGACY_TAB_KEY))
  return state
}

/** 改标签页：fn 返回原对象就是没变，不存也不通知 */
export function updatePanelTabs(fn: (s: PanelTabs) => PanelTabs): void {
  const cur = getPanelTabs()
  const next = fn(cur)
  if (next === cur) return
  state = next
  writeJson(TABS_KEY, next)
  for (const l of subs) l()
}

const subscribe = (cb: () => void): (() => void) => {
  subs.add(cb)
  return () => subs.delete(cb)
}

export const usePanelTabs = (): PanelTabs => useSyncExternalStore(subscribe, getPanelTabs, getPanelTabs)

// 右栏收着的时候往里面放了东西（把终端移到右栏、在右栏打开文件）：请 App 把右栏展开
const showSubs = new Set<() => void>()

export function requestRightPanel(): void {
  for (const l of showSubs) l()
}

/** App 订阅：有人要求展开右栏。返回取消订阅 */
export function onRightPanelRequest(cb: () => void): () => void {
  showSubs.add(cb)
  return () => {
    showSubs.delete(cb)
  }
}

export function getRecentSites(): RecentSite[] {
  if (!recent) recent = parseRecent(readJson(RECENT_KEY))
  return recent
}

export function noteRecentSite(site: { url: string; title?: string }): void {
  const cur = getRecentSites()
  const next = addRecent(cur, site, Date.now())
  if (next === cur) return
  recent = next
  writeJson(RECENT_KEY, next)
  for (const l of subs) l()
}

export function clearRecentSites(): void {
  recent = []
  writeJson(RECENT_KEY, [])
  for (const l of subs) l()
}

export const useRecentSites = (): RecentSite[] => useSyncExternalStore(subscribe, getRecentSites, getRecentSites)
