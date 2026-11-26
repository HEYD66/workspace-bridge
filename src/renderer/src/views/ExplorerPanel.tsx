// 资源管理器（ui-code）：多工作区、多根文件树
//
// 每个工作区是一个根节点，展开某个目录时才去读它（懒加载）。
// 支持新建、重命名、删除、在系统文件管理器里显示，并把"最近被哪个 AI 改过"标在行上。
import {
  ChevronRight,
  ChevronsDownUp,
  FilePlus,
  FolderPlus,
  RefreshCw
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityEvent, BridgeState, DirEntry } from '../../../shared/api'
import { useContextMenu } from '../components/ContextMenu'
import { FileIcon } from '../components/FileIcon'
import { Button, cx, EmptyState, IconButton, Input, PanelHeader } from '../components/ui'
import { openFile, renameTabs, useEditor } from '../lib/editorStore'
import { markRightFilesDeleted, renameRightFiles } from '../lib/rightFiles'
import { FILE_WRITE_TOOLS, errText, timeAgo } from '../lib/format'
import { explorerMenu, joinRoot } from '../lib/menus'

/** 最近被 AI 改过的一次记录 */
interface Touch {
  color: string
  name: string
  ts: number
}

/** 树节点的 key：工作区 id 里不会有冒号，路径里（Windows 上）也不会有，所以按第一个冒号切就行 */
const nodeKey = (wsId: string, p: string): string => `${wsId}:${p}`
const wsOf = (key: string): string => key.slice(0, key.indexOf(':'))
const pathOf = (key: string): string => key.slice(key.indexOf(':') + 1)

const parentOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.')
const joinPath = (dir: string, name: string): string => (dir === '.' || !dir ? name : `${dir}/${name}`)
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

/** 目录在前、文件在后，各自按名字排（1.txt 排在 10.txt 前面） */
function sortEntries(list: DirEntry[]): DirEntry[] {
  return list.slice().sort((a, b) => {
    const da = a.type === 'dir' ? 0 : 1
    const db = b.type === 'dir' ? 0 : 1
    if (da !== db) return da - db
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
  })
}

/** 正在输入的那栏：新建文件 / 新建文件夹 / 重命名 */
interface Editing {
  kind: 'file' | 'dir' | 'rename'
  wsId: string
  /** file / dir：新东西所在目录；rename：要改的路径 */
  target: string
  value: string
}

export function ExplorerPanel({ state, events }: { state: BridgeState | null; events: ActivityEvent[] }) {
  const { active } = useEditor()
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const ctx = useContextMenu()
  const [editing, setEditing] = useState<Editing | null>(null)
  const [confirmDel, setConfirmDel] = useState<{ wsId: string; path: string } | null>(null)
  const [err, setErr] = useState<string | undefined>(undefined)
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const childrenRef = useRef(children)
  childrenRef.current = children

  // 文件树只显示添加的目录工作区，不显示内置的整台电脑
  const workspaces = useMemo(() => (state?.workspaces ?? []).filter((w) => w.kind !== 'machine'), [state?.workspaces])

  /** 读一个目录。读失败当空目录处理，不能把整棵树搞崩 */
  const load = useCallback(async (wsId: string, dir: string) => {
    try {
      const list = await window.bridge.listDir(wsId, dir)
      setChildren((prev) => ({ ...prev, [nodeKey(wsId, dir)]: sortEntries(Array.isArray(list) ? list : []) }))
    } catch {
      setChildren((prev) => ({ ...prev, [nodeKey(wsId, dir)]: [] }))
    }
  }, [])

  // 第一次拿到工作区就展开所有根
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const ws of workspaces) next.add(nodeKey(ws.id, '.'))
      if (next.size === prev.size) return prev
      return next
    })
    for (const ws of workspaces) {
      if (!childrenRef.current[nodeKey(ws.id, '.')]) void load(ws.id, '.')
    }
  }, [workspaces, load])

  // AI 改了文件：重新读涉及路径的所有已展开祖先目录。
  // 新建 docs/a.md 时 docs 本身是新目录，要刷新的是根目录，所以一路往上找
  const handled = useRef(new Set<string>())
  useEffect(() => {
    const dirs = new Set<string>()
    for (const ev of events) {
      if (ev.status !== 'ok' || !FILE_WRITE_TOOLS.has(ev.tool) || !ev.workspaceId) continue
      if (handled.current.has(ev.id)) continue
      handled.current.add(ev.id)
      const raw = [ev.path, typeof ev.args?.from === 'string' ? ev.args.from : undefined].filter(
        (p): p is string => typeof p === 'string' && p.length > 0
      )
      for (const p of raw) {
        let dir = parentOf(p.replace(/\\/g, '/').replace(/^\/+/, ''))
        for (;;) {
          const k = nodeKey(ev.workspaceId, dir)
          if (expandedRef.current.has(k)) dirs.add(k)
          if (dir === '.') break
          dir = parentOf(dir)
        }
      }
    }
    for (const k of dirs) void load(wsOf(k), pathOf(k))
  }, [events, load])

  /** 最近被 AI 动过的路径（含祖先目录），按工作区分开存，避免同名路径串台 */
  const touched = useMemo(() => {
    const m = new Map<string, Touch>()
    for (const ev of events) {
      if (ev.status !== 'ok' || !FILE_WRITE_TOOLS.has(ev.tool) || !ev.workspaceId) continue
      const p = (ev.path ?? '').replace(/\\/g, '/')
      if (!p || p === '.') continue
      const t: Touch = { color: ev.agentColor, name: ev.agentName, ts: ev.ts }
      const parts = p.split('/')
      for (let i = parts.length; i > 0; i--) m.set(nodeKey(ev.workspaceId, parts.slice(0, i).join('/')), t)
    }
    return m
  }, [events])

  const toggle = (wsId: string, path: string): void => {
    const k = nodeKey(wsId, path)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else {
        next.add(k)
        if (!childrenRef.current[k]) void load(wsId, path)
      }
      return next
    })
  }

  const collapseAll = (): void => {
    const next = new Set<string>()
    for (const ws of workspaces) next.add(nodeKey(ws.id, '.'))
    setExpanded(next)
  }

  const reloadAll = (): void => {
    for (const k of expandedRef.current) void load(wsOf(k), pathOf(k))
  }

  const openAt = (wsId: string, path: string, preview: boolean): void => {
    openFile({ workspaceId: wsId, path, preview })
  }

  /** 新建 / 重命名提交 */
  const commitEditing = async (): Promise<void> => {
    if (!editing) return
    const value = editing.value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!value) return
    setErr(undefined)
    try {
      if (editing.kind === 'file') {
        const path = joinPath(editing.target, value)
        await window.bridge.createFile(editing.wsId, path)
        setEditing(null)
        await load(editing.wsId, editing.target)
        openAt(editing.wsId, path, false)
      } else if (editing.kind === 'dir') {
        const path = joinPath(editing.target, value)
        await window.bridge.createDir(editing.wsId, path)
        setEditing(null)
        await load(editing.wsId, editing.target)
      } else {
        const from = editing.target
        const to = from.includes('/') ? joinPath(parentOf(from), value) : value
        if (to === from) {
          setEditing(null)
          return
        }
        await window.bridge.renamePath(editing.wsId, from, to)
        renameTabs(editing.wsId, from, to)
        // 右栏里开着的同一个文件（或这个目录下面的文件）也跟着换路径
        renameRightFiles(editing.wsId, from, to)
        setEditing(null)
        await load(editing.wsId, parentOf(from))
        // 目录改名后，它下面已展开的子目录缓存都失效了，抖掉让它们重新读
        if (childrenRef.current[nodeKey(editing.wsId, from)]) void load(editing.wsId, to)
      }
    } catch (e) {
      setErr(errText(e))
    }
  }

  const doDelete = async (): Promise<void> => {
    if (!confirmDel) return
    setErr(undefined)
    try {
      await window.bridge.deletePath(confirmDel.wsId, confirmDel.path)
      // 右栏里开着的不直接关：标成「已经不在了」，没保存的改动还能存回去
      markRightFilesDeleted(confirmDel.wsId, confirmDel.path)
      await load(confirmDel.wsId, parentOf(confirmDel.path))
    } catch (e) {
      setErr(errText(e))
    } finally {
      setConfirmDel(null)
    }
  }

  const startCreate = (wsId: string, dirPath: string, kind: 'file' | 'dir'): void => {
    setErr(undefined)
    setEditing({ kind, wsId, target: dirPath, value: '' })
  }

  /** 右键菜单（T-13 换成通用组件）：path 是右键点到的路径，点在根上是 '.'；根节点不显示重命名 / 删除 */
  const openMenu = (e: React.MouseEvent, wsId: string, path: string, isDir: boolean, isRoot: boolean): void => {
    const root = workspaces.find((w) => w.id === wsId)?.root
    ctx.open(
      e,
      explorerMenu(
        { isDir, isRoot },
        {
          newFile: () => startCreate(wsId, path, 'file'),
          newDir: () => startCreate(wsId, path, 'dir'),
          rename: () => setEditing({ kind: 'rename', wsId, target: path, value: baseName(path) }),
          remove: () => setConfirmDel({ wsId, path }),
          reveal: () => void window.bridge.revealPath(wsId, path).catch((err) => setErr(errText(err))),
          copyPath: () => void window.bridge.copy(root ? joinRoot(root, path) : path),
          copyRelPath: () => void window.bridge.copy(path),
          refresh: () => {
            void load(wsId, isDir && !isRoot ? path : parentOf(path))
            if (!isRoot) void load(wsId, parentOf(path))
          }
        }
      )
    )
  }

  const renderEntries = (wsId: string, dir: string, depth: number): React.ReactNode => {
    const list = children[nodeKey(wsId, dir)]
    if (!list) return null
    return list.map((e) => {
      const path = joinPath(dir, e.name)
      const k = nodeKey(wsId, path)
      const isDir = e.type === 'dir'
      const open = expanded.has(k)
      const isActive = active?.workspaceId === wsId && active.path === path
      const t = touched.get(k)
      return (
        <div key={k}>
          <div
            className={cx(
              'group flex h-[22px] cursor-pointer items-center gap-1 pr-2 text-[13px] hover:bg-hover',
              isActive && 'bg-accent/15'
            )}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => (isDir ? toggle(wsId, path) : openAt(wsId, path, true))}
            onDoubleClick={() => {
              if (!isDir) openAt(wsId, path, false)
            }}
            onContextMenu={(e) => openMenu(e, wsId, path, isDir, false)}
            title={t ? `${t.name} ${timeAgo(t.ts)}改过` : path}
          >
            {isDir ? (
              <ChevronRight size={13} className={cx('shrink-0 text-faint transition-transform', open && 'rotate-90')} />
            ) : (
              <span className="w-[13px] shrink-0" />
            )}
            <FileIcon name={e.name} isDir={isDir} open={open} size={15} />
            <span
              className={cx('truncate', isActive ? 'text-fg' : 'text-[#c9d1d9]')}
              style={t && !isDir ? { color: t.color } : undefined}
            >
              {e.name}
            </span>
            {!isDir && e.size !== undefined && (
              <span className="ml-auto shrink-0 text-[10px] text-faint opacity-0 group-hover:opacity-100">
                {e.size < 1024 ? `${e.size} B` : `${Math.round(e.size / 1024)} KB`}
              </span>
            )}
            {t && <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', !isDir && e.size !== undefined && 'ml-1')} style={{ background: t.color }} />}
          </div>
          {isDir && open && renderEntries(wsId, path, depth + 1)}
        </div>
      )
    })
  }

  if (!state || workspaces.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader title="资源管理器" />
        <EmptyState title="还没有工作区" hint="在设置里添加一个文件夹，它就会出现在这里，也能通过 MCP 交给 AI" />
      </div>
    )
  }

  const editingDir = editing ? (editing.kind === 'rename' ? parentOf(editing.target) : editing.target) : '.'
  const editingLabel =
    editing?.kind === 'file'
      ? `在 ${editingDir} 下新建文件`
      : editing?.kind === 'dir'
        ? `在 ${editingDir} 下新建文件夹`
        : editing
          ? `重命名 ${baseName(editing.target)}`
          : ''

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="资源管理器">
        <IconButton title="新建文件" onClick={() => startCreate(state.activeWorkspaceId ?? workspaces[0].id, '.', 'file')}>
          <FilePlus size={13} />
        </IconButton>
        <IconButton title="新建文件夹" onClick={() => startCreate(state.activeWorkspaceId ?? workspaces[0].id, '.', 'dir')}>
          <FolderPlus size={13} />
        </IconButton>
        <IconButton title="全部折叠" onClick={collapseAll}>
          <ChevronsDownUp size={13} />
        </IconButton>
        <IconButton title="刷新" onClick={reloadAll}>
          <RefreshCw size={13} />
        </IconButton>
      </PanelHeader>

      {(editing || confirmDel || err) && (
        <div className="shrink-0 border-b border-line bg-panel px-2 py-2">
          {editing && (
            <>
              <div className="mb-1 text-[11px] text-faint">{editingLabel}</div>
              <div className="flex items-center gap-1">
                <Input
                  autoFocus
                  value={editing.value}
                  placeholder={editing.kind === 'rename' ? '新的名字或路径' : '例如 src/新文件.ts'}
                  onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitEditing()
                    if (e.key === 'Escape') setEditing(null)
                  }}
                  className="h-7 text-xs"
                />
                <Button size="sm" variant="primary" onClick={() => void commitEditing()}>
                  确定
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                  取消
                </Button>
              </div>
            </>
          )}
          {confirmDel && (
            <>
              <div className="mb-1 text-[11px] text-faint">删除 {confirmDel.path}（进回收站）</div>
              <div className="flex gap-1">
                <Button size="sm" variant="danger" onClick={() => void doDelete()}>
                  删除
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDel(null)}>
                  取消
                </Button>
              </div>
            </>
          )}
          {err && (
            <div className="mt-1 flex items-start gap-1 text-[11px] leading-relaxed text-bad">
              <span className="min-w-0 break-all">{err}</span>
              <button className="ml-auto shrink-0 cursor-pointer text-faint hover:text-fg" onClick={() => setErr(undefined)}>
                关掉
              </button>
            </div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto pb-4">
        {workspaces.map((ws) => {
          const k = nodeKey(ws.id, '.')
          const open = expanded.has(k)
          const list = children[k]
          return (
            <div key={ws.id}>
              <div
                className={cx(
                  'group flex h-[26px] cursor-pointer items-center gap-1 border-b border-line/60 pr-2 text-[12px] hover:bg-hover',
                  state.activeWorkspaceId === ws.id && 'bg-accent/10'
                )}
                style={{ paddingLeft: 4 }}
                onClick={() => toggle(ws.id, '.')}
                onContextMenu={(e) => openMenu(e, ws.id, '.', true, true)}
                title={ws.root}
              >
                <ChevronRight size={13} className={cx('shrink-0 text-faint transition-transform', open && 'rotate-90')} />
                <FileIcon name={ws.name} isDir open={open} root size={15} />
                <span className={cx('truncate font-medium', ws.exists ? 'text-fg' : 'text-faint line-through')}>{ws.name}</span>
                <span className="ml-auto max-w-[45%] shrink-0 truncate text-[10px] text-faint">{ws.root}</span>
              </div>
              {open &&
                (ws.exists === false ? (
                  <div className="px-3 py-1.5 text-[11px] text-faint">这个目录已经不在了</div>
                ) : list && list.length === 0 ? (
                  <div className="px-3 py-1.5 text-[11px] text-faint">空目录</div>
                ) : (
                  renderEntries(ws.id, '.', 1)
                ))}
            </div>
          )
        })}
      </div>

      {ctx.menu}
    </div>
  )
}
