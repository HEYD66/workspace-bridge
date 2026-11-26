// 终端的小仓库：开着哪些终端、每个终端的 xterm 界面。整个应用只有一份。
// 底部的终端面板（views/TerminalView.tsx）和右栏的终端标签（views/RightPanel.tsx）都从这里拿，
// 同一个终端的界面可以从一处挪到另一处（mountTerminal），里面的内容不丢。
// 终端放在哪：右栏的标签里有它（lib/rightTabs.ts 的 terminal 标签）就在右栏，没有就在底部面板
import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ITheme } from '@xterm/xterm'
import { useSyncExternalStore } from 'react'
import type { TerminalInfo } from '../../../shared/api'
import { errText } from './format'
import { closeTab, getPanelTabs, newTabId, pruneTerminalTabs, updatePanelTabs } from './rightTabs'

/** 和 index.css 的深色主题一致（GitHub Dark 的 ANSI 配色） */
const THEME: ITheme = {
  background: '#171717',
  foreground: '#e6edf3',
  cursor: '#58a6ff',
  cursorAccent: '#171717',
  selectionBackground: '#264f78',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#ffffff'
}

const IS_WINDOWS = navigator.userAgent.includes('Windows')
/** 终端还没建好时先到的输出最多攒这么多（字符） */
const MAX_EARLY = 256 * 1024

interface View {
  term: Terminal
  fit: FitAddon
  el: HTMLDivElement
  /** xterm 在看不见的元素里 open 会量错字符尺寸，所以第一次显示时才 open */
  opened: boolean
  /** 正在用 terminalBuffer 恢复：这期间到达的输出已经包含在缓冲里，丢掉免得重复 */
  restoring: boolean
  /** 恢复期间进程退出了，等缓冲写完再显示「已退出」 */
  pendingExit?: number
  /** 最后一次告诉主进程的尺寸 */
  sent?: string
}

export interface TerminalsState {
  /** 开着的终端（底部面板的和右栏的都在），按打开的先后 */
  list: TerminalInfo[]
  /** 界面刷新前就开着的终端已经找回来了 */
  loaded: boolean
  creating: boolean
  error?: string
}

const exitNote = (code: number): string => `\r\n\x1b[90m[进程已退出，代码 ${code}]\x1b[0m\r\n`

/** 读不了剪贴板（窗口没焦点等）就算了 */
async function pasteInto(term: Terminal): Promise<void> {
  try {
    const text = await navigator.clipboard.readText()
    if (text) term.paste(text)
  } catch {
    // 忽略
  }
  term.focus()
}

/** 返回 false 表示 xterm 不处理这个按键（不发给 shell） */
function handleKey(term: Terminal, ev: KeyboardEvent): boolean {
  if (ev.type !== 'keydown') return true
  const ctrl = ev.ctrlKey || ev.metaKey
  if (!ctrl || ev.altKey) return true
  const k = ev.key.toLowerCase()
  // 有选中时 Ctrl+C 是复制；没选中时照常发给 shell 中断程序
  if (k === 'c' && (ev.shiftKey || term.hasSelection())) {
    if (term.hasSelection()) {
      ev.preventDefault()
      void window.bridge.copy(term.getSelection())
      term.clearSelection()
    }
    return false
  }
  // 不拦默认动作：浏览器原生的 paste 事件会交给 xterm，它会处理括号粘贴模式
  if (k === 'v') return false
  // 应用自己的快捷键不发给 shell（和 VS Code 一样）
  if (ev.key === '`' || (!ev.shiftKey && (k === 'p' || k === 'b' || k === 'j')) || (ev.shiftKey && (k === 'f' || k === 'e'))) return false
  return true
}

const views = new Map<string, View>()
const early = new Map<string, string[]>()
/** 新建终端的回复还没到进程就退出了（比如 shell 启动即失败），先记下退出码 */
const earlyExit = new Map<string, number>()
const subs = new Set<() => void>()
let st: TerminalsState = { list: [], loaded: false, creating: false }
let started = false

function set(patch: Partial<TerminalsState>): void {
  st = { ...st, ...patch }
  for (const l of subs) l()
}

/** 建 xterm 实例（先不挂到页面上）；restore 为 true 时先到的输出已经在缓冲里，丢掉 */
function attach(info: TerminalInfo, restore: boolean): View {
  const existing = views.get(info.id)
  if (existing) return existing
  const el = document.createElement('div')
  el.dataset.terminalView = info.id
  el.style.cssText = 'position:absolute;inset:0;padding:4px 0 0 8px'
  const term = new Terminal({
    fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, 'Microsoft YaHei UI', monospace",
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: THEME,
    ...(IS_WINDOWS ? { windowsPty: { backend: 'conpty' as const } } : {})
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  // Ctrl+点击才打开，免得点终端获取焦点时误开浏览器；window.open 会被主进程转给系统浏览器
  term.loadAddon(
    new WebLinksAddon((e, uri) => {
      if ((e.ctrlKey || e.metaKey) && /^https?:\/\//i.test(uri)) window.open(uri, '_blank')
    })
  )
  term.onData((d) => window.bridge.terminalWrite(info.id, d))
  term.onBinary((d) => window.bridge.terminalWrite(info.id, d))
  term.attachCustomKeyEventHandler((ev) => handleKey(term, ev))
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    void pasteInto(term)
  })
  const v: View = { term, fit, el, opened: false, restoring: false }
  views.set(info.id, v)
  const pending = early.get(info.id)
  early.delete(info.id)
  if (pending && !restore) for (const d of pending) term.write(d)
  return v
}

/** 订阅输出和退出，把界面刷新前已经开着的终端找回来。只做一次 */
function start(): void {
  if (started) return
  started = true
  window.bridge.onTerminalData((id, data) => {
    const v = views.get(id)
    if (!v) {
      // 新建终端的回复还没到，先攒着
      const list = early.get(id) ?? []
      if (list.reduce((n, s) => n + s.length, 0) < MAX_EARLY) list.push(data)
      early.set(id, list)
      return
    }
    if (!v.restoring) v.term.write(data)
  })
  window.bridge.onTerminalExit((id, code) => {
    if (st.list.some((t) => t.id === id)) set({ list: st.list.map((t) => (t.id === id ? { ...t, exitCode: code } : t)) })
    const v = views.get(id)
    if (!v) {
      earlyExit.set(id, code)
      return
    }
    if (v.restoring) v.pendingExit = code
    else v.term.write(exitNote(code))
  })
  window.bridge
    .terminalList()
    .then(async (found) => {
      for (const info of found) attach(info, true).restoring = true
      // 这期间新建的排在后面
      const fresh = st.list.filter((t) => !found.some((f) => f.id === t.id))
      set({ list: [...found, ...fresh] })
      // 应用重开过的话，上次留在右栏的终端已经没了：它们的标签去掉
      const alive = new Set(st.list.map((t) => t.id))
      updatePanelTabs((s) => pruneTerminalTabs(s, alive, newTabId()))
      // IPC 按顺序到达：缓冲回复之前收到的输出都已经包含在缓冲里
      await Promise.all(
        found.map(async (info) => {
          const buf = await window.bridge.terminalBuffer(info.id).catch(() => '')
          const v = views.get(info.id)
          if (!v) return
          v.restoring = false
          if (buf) v.term.write(buf)
          const code = info.exitCode ?? v.pendingExit
          if (code !== undefined) v.term.write(exitNote(code))
        })
      )
    })
    .catch((e) => set({ error: errText(e) }))
    .finally(() => set({ loaded: true }))
}

const subscribe = (cb: () => void): (() => void) => {
  start()
  subs.add(cb)
  return () => subs.delete(cb)
}
const get = (): TerminalsState => st

export const useTerminals = (): TerminalsState => useSyncExternalStore(subscribe, get, get)
export const getTerminals = (): TerminalsState => st

export function setTerminalError(error: string | undefined): void {
  if (st.error !== error) set({ error })
}

/** 按容器大小重排行列，变了就告诉主进程 */
export function fitTerminal(id: string): void {
  const v = views.get(id)
  if (!v?.opened || !v.el.isConnected) return
  try {
    v.fit.fit()
  } catch {
    // 容器尺寸为 0 时量不出来
  }
  const key = `${v.term.cols}x${v.term.rows}`
  if (key !== v.sent) {
    v.sent = key
    window.bridge.terminalResize(id, v.term.cols, v.term.rows)
  }
}

/**
 * 把一个终端的界面放进 host 里显示（原来在别处的话挪过来），适配大小；focus 不是 false 就把光标给它。
 * host 要是看得见的。返回「收走」：只有它还在这个 host 里才拿掉（已经被挪到别处就不动）
 */
export function mountTerminal(id: string, host: HTMLElement, opts: { focus?: boolean } = {}): () => void {
  const v = views.get(id)
  if (!v) return () => undefined
  if (v.el.parentElement !== host) host.appendChild(v.el)
  const raf = requestAnimationFrame(() => {
    if (v.el.parentElement !== host || !host.isConnected) return
    if (!v.opened) {
      v.term.open(v.el)
      v.opened = true
    }
    fitTerminal(id)
    // 挪过地方、藏过再出来：滚动条回到最下面，整屏重画一遍
    v.term.scrollToBottom()
    v.term.refresh(0, v.term.rows - 1)
    if (opts.focus !== false) v.term.focus()
  })
  return () => {
    cancelAnimationFrame(raf)
    if (v.el.parentElement === host) v.el.remove()
  }
}

export function focusTerminal(id: string): void {
  views.get(id)?.term.focus()
}

/** 新开一个终端。like 是拿哪个终端的行列数当初始大小（没有就 80×24）。出错返回 undefined，原因在 state.error */
export async function createTerminal(opts: { workspaceId?: string; cwd?: string; like?: string } = {}): Promise<TerminalInfo | undefined> {
  start()
  set({ creating: true, error: undefined })
  try {
    const cur = opts.like ? views.get(opts.like)?.term : undefined
    const info = await window.bridge.terminalCreate({
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      cols: cur?.cols ?? 80,
      rows: cur?.rows ?? 24
    })
    const v = attach(info, false)
    const code = earlyExit.get(info.id)
    if (code !== undefined) {
      earlyExit.delete(info.id)
      info.exitCode = code
      v.term.write(exitNote(code))
    }
    set({ list: [...st.list.filter((t) => t.id !== info.id), info] })
    return info
  } catch (e) {
    set({ error: errText(e) })
    return undefined
  } finally {
    set({ creating: false })
  }
}

/** 关掉一个终端：界面销毁、进程结束；它在右栏有标签的话标签也去掉 */
export async function closeTerminal(id: string): Promise<void> {
  const v = views.get(id)
  views.delete(id)
  v?.term.dispose()
  v?.el.remove()
  set({ list: st.list.filter((t) => t.id !== id) })
  const tab = getPanelTabs().tabs.find((t) => t.kind === 'terminal' && t.termId === id)
  if (tab) updatePanelTabs((s) => closeTab(s, tab.id, newTabId()))
  try {
    await window.bridge.terminalKill(id)
  } catch (e) {
    set({ error: errText(e) })
  } finally {
    // 关掉之后、主进程收到 kill 之前到的输出会被当成「新终端先到的输出」攒起来，清掉
    early.delete(id)
    earlyExit.delete(id)
  }
}
