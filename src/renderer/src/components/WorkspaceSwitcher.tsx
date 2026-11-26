import { Check, ChevronDown, Folder, FolderPlus, Loader2, Settings2, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { BridgeState, WorkspaceView } from '../../../shared/api'
import { errText } from '../lib/format'
import { workspaceMenu } from '../lib/menus'
import { navigate } from '../lib/nav'
import { addWorkspaceFlow, editWorkspaceMembers } from '../lib/workspaceDialog'
import { useContextMenu } from './ContextMenu'
import { Badge, cx } from './ui'

/** 界面的当前工作区；一个都没有时为 undefined */
export function activeWorkspace(state: BridgeState): WorkspaceView | undefined {
  return (state.workspaces ?? []).find((w) => w.id === state.activeWorkspaceId)
}

/** 任务、记忆、技能页标题旁的小标签：这页显示的是哪个工作区的数据 */
export function WorkspaceTag({ state }: { state: BridgeState }) {
  const w = activeWorkspace(state)
  if (!w) return <Badge color="#d29922">没有工作区</Badge>
  return (
    <span
      title={`当前工作区：${w.root}\n在顶栏切换`}
      className="mr-1 inline-flex max-w-[120px] min-w-0 items-center gap-1 rounded-full bg-hover px-2 py-px text-[11px] font-medium tracking-normal text-muted normal-case"
    >
      {w.exists ? <Folder size={10} className="shrink-0" /> : <TriangleAlert size={10} className="shrink-0 text-warn" />}
      <span className="truncate">{w.name}</span>
    </span>
  )
}

function MenuItem({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[13px] text-muted hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-50"
    >
      {children}
    </button>
  )
}

/** 顶栏：当前工作区名和路径，点开切换或添加文件夹 */
export function WorkspaceSwitcher({ state }: { state: BridgeState }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  // 内置的整台电脑不在切换列表里（每个 AI 能不能用它在团队页勾）
  const list = (state.workspaces ?? []).filter((w) => w.kind !== 'machine')
  const current = activeWorkspace(state)

  // 点外面或按 Esc 收起
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (!open) setError('')
  }, [open])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      setOpen(false)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const add = () => void act(() => addWorkspaceFlow())
  const pick = (w: WorkspaceView) => (w.id === state.activeWorkspaceId ? setOpen(false) : void act(() => window.bridge.setActiveWorkspace(w.id)))

  // 工作区右键（T-13）：切换、在系统资源管理器中显示、复制路径、管理、移出列表
  const ctx = useContextMenu()
  const openMenu = (e: React.MouseEvent, w: WorkspaceView): void =>
    ctx.open(
      e,
      workspaceMenu(
        { active: w.id === state.activeWorkspaceId, exists: w.exists },
        {
          switchTo: () => pick(w),
          reveal: () => void window.bridge.openWorkspace(w.id).catch((err) => setError(errText(err))),
          copyPath: () => void window.bridge.copy(w.root),
          members: () => {
            setOpen(false)
            editWorkspaceMembers(w.id)
          },
          manage: () => {
            setOpen(false)
            navigate({ section: 'settings' })
          },
          remove: () => void act(() => window.bridge.removeWorkspace(w.id))
        }
      )
    )

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        // 一个工作区都没有时直接弹目录选择框，省一步
        onClick={() => (list.length ? setOpen(!open) : add())}
        title={current ? current.root : '添加工作区'}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cx('flex max-w-[480px] min-w-0 cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 text-[13px] hover:bg-hover', open && 'bg-hover')}
      >
        {busy && !open ? <Loader2 size={12} className="shrink-0 animate-spin text-muted" /> : current && !current.exists && <TriangleAlert size={12} className="shrink-0 text-warn" />}
        <span className="shrink-0 font-medium">{current?.name ?? (list.length ? '选择工作区' : '添加工作区')}</span>
        {current && <span className="min-w-0 truncate text-xs text-faint">{current.root}</span>}
        {list.length > 0 && <ChevronDown size={12} className="shrink-0 text-faint" />}
      </button>
      {open && (
        <div role="menu" className="absolute top-full left-0 z-50 mt-1 w-[420px] max-w-[90vw] overflow-hidden rounded-lg border border-line bg-panel shadow-xl shadow-black/40">
          <div className="px-3 pt-2 pb-1 text-[11px] leading-relaxed text-faint">任务、记忆、技能页显示当前工作区的数据；文件树显示全部工作区</div>
          <div className="max-h-80 overflow-auto py-1">
            {list.map((w) => {
              const active = w.id === state.activeWorkspaceId
              return (
                <button
                  key={w.id}
                  role="menuitemradio"
                  aria-checked={active}
                  disabled={busy}
                  onClick={() => pick(w)}
                  onContextMenu={(e) => openMenu(e, w)}
                  title={w.root}
                  className={cx('flex w-full cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left hover:bg-hover disabled:opacity-60', active && 'bg-accent/10')}
                >
                  <span className="flex w-3.5 shrink-0 justify-center">{active && <Check size={14} className="text-accent" />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] text-fg">{w.name}</span>
                      {!w.exists && <Badge color="#f85149">目录不存在</Badge>}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-faint">{w.root}</span>
                  </span>
                </button>
              )
            })}
          </div>
          {error && <div className="px-3 pb-2 text-xs text-bad">{error}</div>}
          <div className="border-t border-line-soft py-1">
            <MenuItem onClick={add} disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <FolderPlus size={14} />} 添加文件夹…
            </MenuItem>
            <MenuItem
              onClick={() => {
                setOpen(false)
                navigate({ section: 'settings' })
              }}
            >
              <Settings2 size={14} /> 管理工作区…
            </MenuItem>
          </div>
        </div>
      )}
      {ctx.menu}
    </div>
  )
}
