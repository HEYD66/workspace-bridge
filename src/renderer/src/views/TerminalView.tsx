// 终端：底部面板（TerminalPanel）和右栏的终端标签（TerminalTabView）。
// 终端本身和它的 xterm 界面在 lib/terminals.ts 里，这里只管摆在哪、标签条和按钮
import { ChevronDown, PanelBottom, PanelBottomClose, PanelRight, Plus, SquareTerminal, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { BridgeState, TerminalInfo } from '../../../shared/api'
import { cx, IconButton } from '../components/ui'
import { closeTab, newTabId, openTerminalTab, requestRightPanel, terminalTabIds, updatePanelTabs, usePanelTabs } from '../lib/rightTabs'
import { closeTerminal, createTerminal, fitTerminal, mountTerminal, useTerminals } from '../lib/terminals'

interface OpenRequest {
  workspaceId?: string
  /** 相对工作区根目录，或绝对路径 */
  cwd?: string
}

// 面板是 App 一直挂着的单例，用模块级监听把「打开终端」的请求转给它，不用经过 App 传 props
const openListeners = new Set<(r: OpenRequest) => void>()
const showListeners = new Set<() => void>()
/** 「把这个终端翻到前面」：从右栏移回底部面板时用 */
const pickListeners = new Set<(id: string) => void>()

/** 在底部面板新开一个终端标签（文件树「在终端打开」用）；同时请 App 把面板显示出来 */
export function openTerminal(r: OpenRequest = {}): void {
  for (const l of showListeners) l()
  for (const l of openListeners) l(r)
}

/** App 订阅：有人调了 openTerminal 时把底部面板显示出来。返回取消订阅 */
export function onTerminalShowRequest(cb: () => void): () => void {
  showListeners.add(cb)
  return () => {
    showListeners.delete(cb)
  }
}

/** 把一个终端放到右栏（一个终端一个标签，标签名是它的目录名）；右栏收着就展开。replaceId：就地换掉那个新标签页 */
export function moveTerminalToRight(info: Pick<TerminalInfo, 'id' | 'cwd'>, replaceId?: string): void {
  updatePanelTabs((s) => openTerminalTab(s, { termId: info.id, cwd: info.cwd }, newTabId(), { replaceId }))
  requestRightPanel()
}

/** 把右栏的一个终端放回底部面板：标签关掉（终端不关），底部面板显示出来并翻到它 */
export function moveTerminalToBottom(termId: string): void {
  updatePanelTabs((s) => {
    const tab = s.tabs.find((t) => t.kind === 'terminal' && t.termId === termId)
    return tab ? closeTab(s, tab.id, newTabId()) : s
  })
  for (const l of showListeners) l()
  for (const l of pickListeners) l(termId)
}

/** 一个放 xterm 界面的格子：看得见时把那个终端的界面挂进来，大小变了跟着重排 */
function TerminalHost({ id, shown }: { id: string | undefined; shown: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const idRef = useRef(id)
  idRef.current = id
  const shownRef = useRef(shown)
  shownRef.current = shown
  /** 格子有大小了没有：面板藏着、右栏收着时宽高是 0，这时不挂（xterm 在量不出大小的地方 open 会量错字符尺寸） */
  const [sized, setSized] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host || !id || !shown || !sized) return
    return mountTerminal(id, host)
  }, [id, shown, sized])

  // 面板拖高、拖宽、窗口缩放时跟着重排
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let raf = 0
    const ro = new ResizeObserver(() => {
      setSized(host.clientWidth > 0 && host.clientHeight > 0)
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (idRef.current && shownRef.current) fitTerminal(idRef.current)
      })
    })
    ro.observe(host)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  // xterm 的元素由代码挂进来，React 不管这个 div 的子节点
  return <div ref={hostRef} data-terminal-host className="selectable absolute inset-0" />
}

export function TerminalPanel({ state, visible, onHide }: { state: BridgeState; visible: boolean; onHide: () => void }) {
  const { list, loaded, creating, error } = useTerminals()
  const panel = usePanelTabs()
  /** 不在右栏的终端都在这里 */
  const tabs = useMemo(() => {
    const right = new Set(terminalTabIds(panel))
    return list.filter((t) => !right.has(t.id))
  }, [list, panel])
  const [picked, setPicked] = useState<string>()
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const autoTried = useRef(false)
  // 正在看的那个：点过的还在就是它，不在了（关了、移到右栏了）就是最后一个
  const active = tabs.some((t) => t.id === picked) ? picked : tabs[tabs.length - 1]?.id
  const activeRef = useRef(active)
  activeRef.current = active

  const create = async (workspaceId?: string, cwd?: string): Promise<void> => {
    setMenu(false)
    const info = await createTerminal({ workspaceId, cwd, like: activeRef.current })
    if (info) setPicked(info.id)
  }
  const createRef = useRef(create)
  createRef.current = create

  // 别处（文件树「在终端打开」）要求开终端：先标记，免得面板显示时再自动多开一个
  useEffect(() => {
    const onOpen = (r: OpenRequest): void => {
      autoTried.current = true
      void createRef.current(r.workspaceId, r.cwd)
    }
    // 从右栏移回来的那个翻到前面；这时面板里有它了，不用再自动开一个
    const onPick = (id: string): void => {
      autoTried.current = true
      setPicked(id)
    }
    openListeners.add(onOpen)
    pickListeners.add(onPick)
    return () => {
      openListeners.delete(onOpen)
      pickListeners.delete(onPick)
    }
  }, [])

  // 打开面板时这里一个终端都没有就自动开一个；失败不重试，等用户点「新建」或下次打开面板
  useEffect(() => {
    if (!visible) {
      autoTried.current = false
      return
    }
    if (loaded && tabs.length === 0 && !autoTried.current) {
      autoTried.current = true
      void createRef.current()
    }
  }, [visible, loaded, tabs.length])

  // 点菜单外面或按 Esc 收起
  useEffect(() => {
    if (!menu) return
    const down = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(false)
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [menu])

  /** 这个终端要离开底部面板了（关掉、移到右栏）：翻到它旁边那个；是最后一个就收起面板（和 VS Code 一样） */
  const leave = (id: string): void => {
    const idx = tabs.findIndex((t) => t.id === id)
    const rest = tabs.filter((t) => t.id !== id)
    if (active === id) setPicked((rest[idx] ?? rest[idx - 1])?.id)
    if (!rest.length) onHide()
  }
  const close = (id: string): void => {
    leave(id)
    void closeTerminal(id)
  }
  const toRight = (t: TerminalInfo): void => {
    leave(t.id)
    moveTerminalToRight(t)
  }

  const workspaces = state.workspaces ?? []
  const wsName = (id?: string): string | undefined => workspaces.find((w) => w.id === id)?.name
  const cur = tabs.find((t) => t.id === active)

  return (
    <div data-terminal-panel className={cx('flex h-full min-h-0 flex-col bg-canvas', !visible && 'hidden')}>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line-soft bg-panel pr-1 pl-2">
        <span className="mr-1 shrink-0 text-[11px] font-semibold tracking-wide text-muted">终端</span>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" role="tablist">
          {tabs.map((t) => {
            const on = t.id === active
            const exited = t.exitCode !== undefined
            return (
              <div
                key={t.id}
                role="tab"
                aria-selected={on}
                data-terminal-tab={t.id}
                title={`${t.cwd}\n${t.shell} · PID ${t.pid}${wsName(t.workspaceId) ? `\n工作区：${wsName(t.workspaceId)}` : ''}`}
                onClick={() => setPicked(t.id)}
                onAuxClick={(e) => e.button === 1 && close(t.id)}
                className={cx(
                  'group flex h-6 max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 text-xs',
                  on ? 'bg-hover text-fg' : 'text-muted hover:bg-hover hover:text-fg'
                )}
              >
                <SquareTerminal size={12} className={exited ? 'text-faint' : on ? 'text-accent' : ''} />
                <span className={cx('truncate', exited && 'text-faint')}>{t.title}</span>
                {exited && <span className="shrink-0 text-[10px] text-faint">已退出</span>}
                <button
                  title="关闭终端"
                  aria-label="关闭终端"
                  onClick={(e) => {
                    e.stopPropagation()
                    close(t.id)
                  }}
                  className={cx('-mr-1 inline-flex h-4 w-4 cursor-pointer items-center justify-center rounded hover:bg-line', !on && 'opacity-0 group-hover:opacity-100')}
                >
                  <X size={11} />
                </button>
              </div>
            )
          })}
        </div>
        {error && (
          <span className="max-w-[45%] truncate text-xs text-bad" title={error}>
            {error}
          </span>
        )}
        <IconButton title="新建终端（当前工作区）" disabled={creating} onClick={() => void create()}>
          <Plus size={14} />
        </IconButton>
        <div className="relative" ref={menuRef}>
          <IconButton title="在指定工作区新建终端" disabled={creating} onClick={() => setMenu((m) => !m)}>
            <ChevronDown size={14} />
          </IconButton>
          {menu && (
            <div className="absolute top-full right-0 z-30 mt-1 max-h-64 w-72 overflow-y-auto rounded-md border border-line bg-panel py-1 shadow-xl">
              <div className="px-3 py-1 text-[11px] text-faint">在哪个工作区打开</div>
              {workspaces.length === 0 && <div className="px-3 py-1.5 text-xs text-muted">还没有工作区，新建的终端会在用户主目录打开</div>}
              {workspaces.map((w) => (
                <button
                  key={w.id}
                  disabled={!w.exists}
                  onClick={() => void create(w.id)}
                  className="flex w-full cursor-pointer flex-col items-start px-3 py-1.5 text-left hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="flex w-full items-center gap-1.5 text-xs text-fg">
                    <span className="truncate">{w.name}</span>
                    {w.id === state.activeWorkspaceId && <span className="shrink-0 text-[10px] text-accent">当前</span>}
                    {!w.exists && <span className="shrink-0 text-[10px] text-bad">目录不存在</span>}
                  </span>
                  <span className="w-full truncate text-[11px] text-faint">{w.root}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <IconButton title="把这个终端移到右栏（变成右栏的一个标签）" data-terminal-to-right disabled={!cur} onClick={() => cur && toRight(cur)}>
          <PanelRight size={14} />
        </IconButton>
        <IconButton title="隐藏面板" onClick={onHide}>
          <PanelBottomClose size={14} />
        </IconButton>
      </div>
      <div className="relative min-h-0 flex-1">
        <TerminalHost id={active} shown={visible} />
        {tabs.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-muted">
            <SquareTerminal size={20} className="text-faint" />
            <span>{creating ? '正在打开终端…' : '没有打开的终端'}</span>
            {!creating && (
              <button className="cursor-pointer text-accent hover:underline" onClick={() => void create()}>
                新建终端
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** 右栏的一个终端标签里的内容：上面一行写它在哪个目录、「移到底部面板」，下面是终端 */
export function TerminalTabView({ termId, cwd, active }: { termId: string; cwd: string; active: boolean }) {
  const { list, loaded } = useTerminals()
  const info = list.find((t) => t.id === termId)
  const exited = info?.exitCode !== undefined
  return (
    <div data-right-terminal={termId} className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line-soft bg-panel pr-1 pl-3 text-[11.5px] text-muted">
        <SquareTerminal size={12} className={cx('shrink-0', exited ? 'text-faint' : 'text-accent')} />
        <span data-terminal-cwd className="min-w-0 flex-1 truncate" title={info ? `${info.cwd}\n${info.shell} · PID ${info.pid}` : cwd}>
          {info?.cwd ?? cwd}
        </span>
        {exited && <span className="shrink-0 text-[10.5px] text-faint">已退出</span>}
        <IconButton title="把这个终端移到底部面板" data-terminal-to-bottom onClick={() => moveTerminalToBottom(termId)}>
          <PanelBottom size={14} />
        </IconButton>
      </div>
      <div className="relative min-h-0 flex-1">
        <TerminalHost id={info ? termId : undefined} shown={active} />
        {!info && <div className="absolute inset-0 flex items-center justify-center text-xs text-muted">{loaded ? '这个终端已经关了' : '正在找回终端…'}</div>}
      </div>
    </div>
  )
}
