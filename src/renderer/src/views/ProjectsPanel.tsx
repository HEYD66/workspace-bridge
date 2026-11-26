// 首页侧栏（照 Codex）：项目列表常驻，每个项目（工作区）下面挂它的群聊、另开的会话和没做完的任务；下面是跨项目的「最近」
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Copy,
  Ellipsis,
  Eraser,
  Folder,
  FolderOpen,
  LayoutDashboard,
  MessageSquare,
  MessageSquarePlus,
  MessagesSquare,
  Monitor,
  Pencil,
  Pin,
  PinOff,
  Plus,
  SquarePen,
  Star,
  Trash2,
  Users,
  X
} from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { BridgeState, GroupChannelInfo, TaskItem } from '../../../core/types'
import { useContextMenu, type MenuEntry } from '../components/ContextMenu'
import { Avatar, cx, IconButton, PanelHeader } from '../components/ui'
import { focusNewChat } from '../lib/newChat'
import { errText, STATUS_META, timeAgo } from '../lib/format'
import { addWorkspaceFlow } from '../lib/workspaceDialog'
import { channelLabel, LOBBY, modeLine, newThread, taskThreadOf } from '../lib/groupChat'
import {
  allChats,
  projectRows,
  recentItems,
  sameTarget as same,
  setExpanded,
  setPinned,
  setProjectsView,
  useExpanded,
  usePinned,
  useProjectsView,
  type HomeTarget,
  type ProjectRow,
  type RecentItem
} from '../lib/projects'

/** 一个项目下面先显示这么多个任务，多的点「还有 n 个」展开 */
const TASKS_SHOWN = 6
/** 一个项目下面先列这么多个会话（最近有消息的在前），多的收在「还有 N 个会话」里 */
const THREADS_SHOWN = 6

function Row({
  icon,
  title,
  sub,
  right,
  selected,
  bold,
  indent,
  onClick,
  onContextMenu,
  onHover,
  tip,
  more = true
}: {
  icon: ReactNode
  title: ReactNode
  sub?: ReactNode
  right?: ReactNode
  selected?: boolean
  bold?: boolean
  indent?: boolean
  onClick: () => void
  onContextMenu?: (e: MouseEvent) => void
  /** 鼠标停上来 / 移开（项目行用它弹卡片）；进来时给这一行的元素，好算卡片放哪 */
  onHover?: (el: Element | null) => void
  tip?: string
  /** 有右键菜单的行，手机版里多一个「…」按钮打开同一个菜单（手机上没有右键）；自己已经有「…」的行传 false */
  more?: boolean
}) {
  return (
    <div
      title={tip}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseEnter={onHover ? (e) => onHover(e.currentTarget) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
      className={cx('group mx-1.5 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-hover', indent && 'pl-7', selected && 'bg-hover')}
    >
      <span className="flex w-4 shrink-0 justify-center text-muted">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className={cx('truncate text-[13px]', bold && 'font-semibold')}>{title}</div>
        {sub && <div className="truncate text-[11px] text-muted">{sub}</div>}
      </div>
      {onContextMenu && more && (
        // 平时不显示，只在手机版外壳里显示（index.css 的 [data-row-more]）
        <IconButton
          title="更多操作"
          data-row-more
          className="hidden"
          onClick={(e) => {
            e.stopPropagation()
            onContextMenu(e)
          }}
        >
          <Ellipsis size={13} />
        </IconButton>
      )}
      {right}
    </div>
  )
}

function Count({ n, tone }: { n: number; tone: 'accent' | 'bad' | 'warn' }) {
  if (n <= 0) return null
  return (
    <span
      className={cx(
        'min-w-4 shrink-0 rounded-full px-1 text-center text-[10px] leading-4 font-semibold',
        tone === 'bad' ? 'bg-bad text-white' : tone === 'warn' ? 'bg-warn/25 text-warn' : 'bg-accent text-[#0d1117]'
      )}
    >
      {n > 99 ? '99+' : n}
    </span>
  )
}

const StatusDot = ({ status }: { status: TaskItem['status'] }) => <span title={STATUS_META[status].label} className="h-2 w-2 rounded-full" style={{ background: STATUS_META[status].color }} />

/**
 * selected：主区正在看的（没有 = 「新会话」页）；onSelect(undefined) 回「新会话」页。
 * 点项目里的东西不切换「当前工作区」（文件、终端、AI 的默认工作区都跟着它，不能随手改），要切用右键「设为当前工作区」
 */
export function ProjectsPanel({
  state,
  tasksByWs,
  selected,
  onSelect
}: {
  state: BridgeState
  tasksByWs: Record<string, TaskItem[]>
  selected: HomeTarget | undefined
  onSelect: (t: HomeTarget | undefined) => void
}) {
  const expanded = useExpanded()
  const ctx = useContextMenu()
  const [error, setError] = useState('')
  /** 正在给哪个项目建任务 */
  const [creating, setCreating] = useState<string>()
  /** 正在给哪个项目开会话 */
  const [chatting, setChatting] = useState<string>()
  /** 正在改名的会话或主群聊（频道 id） */
  const [renaming, setRenaming] = useState<string>()
  /** 归档的会话也列出来的项目 */
  const [showArchived, setShowArchived] = useState<ReadonlySet<string>>(new Set())
  /** 任务全部列出来的项目 */
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(new Set())
  /** 展开了全部会话的项目 */
  const [showThreads, setShowThreads] = useState<ReadonlySet<string>>(new Set())
  const pinned = usePinned()
  const view = useProjectsView()
  const rows = projectRows(state, tasksByWs, pinned)
  const recent = recentItems(state, tasksByWs)
  /** 鼠标停在哪个项目上弹出的卡片：项目 id 和放的位置 */
  const [card, setCard] = useState<{ id: string; top: number; left: number }>()
  const cardTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(cardTimer.current), [])
  /** 停半秒才弹；移开后留一小会儿，好让鼠标移到卡片上 */
  const hoverProject = (id: string, el: Element | null) => {
    clearTimeout(cardTimer.current)
    if (!el) {
      cardTimer.current = setTimeout(() => setCard(undefined), 200)
      return
    }
    const r = el.getBoundingClientRect()
    cardTimer.current = setTimeout(() => setCard({ id, top: Math.max(8, Math.min(r.top, window.innerHeight - 190)), left: r.right + 8 }), 500)
  }
  const closeCard = () => {
    clearTimeout(cardTimer.current)
    setCard(undefined)
  }
  const lobby = (state.chat?.channels ?? []).find((c) => c.id === LOBBY)

  const run = (fn: () => Promise<unknown>) => {
    setError('')
    void fn().catch((e) => setError(errText(e)))
  }
  const startCreate = (wsId: string) => {
    setExpanded(wsId, true)
    setChatting(undefined)
    setCreating(wsId)
  }
  const startChat = (wsId: string) => {
    setExpanded(wsId, true)
    setCreating(undefined)
    setChatting(wsId)
  }
  /** 标题留空由主进程起名（新会话 月-日 时:分） */
  const createChat = (wsId: string, title: string) =>
    run(async () => {
      const id = await newThread(wsId, title || undefined)
      setChatting(undefined)
      onSelect({ kind: 'channel', channel: id })
    })
  const rename = (channel: string, title: string) =>
    run(async () => {
      await window.bridge.renameGroupChatThread(channel, title)
      setRenaming(undefined)
    })
  const toggle = (set: (fn: (s: ReadonlySet<string>) => ReadonlySet<string>) => void, id: string) =>
    set((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  /** 菜单项要弹出输入框的：等菜单关掉、焦点还回去之后再弹，不然输入框一出来就失焦被取消 */
  const later = (fn: () => void): void => {
    setTimeout(fn, 0)
  }
  /** 开始改名：按项目分组时输入框出在项目里那一行上，所以先把项目展开 */
  const startRename = (c: GroupChannelInfo): void => {
    if (c.workspaceId) setExpanded(c.workspaceId, true)
    setRenaming(c.id)
  }
  /** 改名用的输入框：会话必须有标题；主群聊留空是恢复叫「群聊」 */
  const renameInput = (c: GroupChannelInfo) =>
    c.thread ? (
      <InlineInput key={c.id} label="会话的标题" placeholder="会话标题，回车保存，Esc 取消" initial={c.thread.title} onCancel={() => setRenaming(undefined)} onSubmit={(t) => rename(c.id, t)} />
    ) : (
      <InlineInput key={c.id} label="群聊的名字" placeholder="给这个群聊起个名字，回车保存；留空恢复叫「群聊」" initial={c.title} allowEmpty onCancel={() => setRenaming(undefined)} onSubmit={(t) => rename(c.id, t)} />
    )

  /** 另开的会话：改名、归档、删除；归档的：恢复、删除 */
  const threadMenu = (c: GroupChannelInfo): MenuEntry[] => {
    const del: MenuEntry = {
      id: 'delete',
      label: '删除会话',
      icon: <Trash2 size={13} />,
      danger: true,
      confirm: '里面的消息一起删掉，再点一次确认',
      run: () => run(() => window.bridge.deleteGroupChannel(c.id))
    }
    if (c.thread?.archived) return [{ id: 'restore', label: '恢复会话', icon: <ArchiveRestore size={13} />, run: () => run(() => window.bridge.archiveGroupChatThread(c.id, false)) }, '-', del]
    return [
      { id: 'rename', label: '改名', icon: <Pencil size={13} />, run: () => later(() => startRename(c)) },
      { id: 'archive', label: '归档（AI 不再看到，消息留着）', icon: <Archive size={13} />, run: () => run(() => window.bridge.archiveGroupChatThread(c.id, true)) },
      '-',
      del
    ]
  }
  /** 主群聊、大厅：删不掉，只能清空。项目的主群聊还能起名字（大厅不能） */
  const mainMenu = (id: string, c: GroupChannelInfo | undefined): MenuEntry[] => [
    ...(c && id !== LOBBY
      ? ([
          { id: 'rename', label: '改名', icon: <Pencil size={13} />, run: () => later(() => startRename(c)) },
          ...(c.title ? [{ id: 'reset-name', label: '恢复叫「群聊」', icon: <Users size={13} />, run: () => rename(c.id, '') }] : []),
          '-'
        ] as MenuEntry[])
      : []),
    {
      id: 'clear',
      label: '清空消息',
      icon: <Eraser size={13} />,
      danger: true,
      disabled: c?.lastTs ? false : '还没有消息',
      confirm: '这里的消息全部清掉，再点一次确认',
      run: () => run(() => window.bridge.deleteGroupChannel(id))
    }
  ]
  const channelMenu = (id: string): MenuEntry[] => {
    const c = (state.chat?.channels ?? []).find((x) => x.id === id)
    return c?.thread ? threadMenu(c) : mainMenu(id, c)
  }
  const create = (wsId: string, title: string) =>
    run(async () => {
      const t = await window.bridge.createTask({ title }, wsId)
      setCreating(undefined)
      onSelect({ kind: 'task', workspaceId: wsId, taskId: t.id })
    })

  const projectMenu = (p: ProjectRow): MenuEntry[] => [
    pinned.has(p.ws.id)
      ? { id: 'unpin', label: '取消置顶', icon: <PinOff size={13} />, run: () => setPinned(p.ws.id, false) }
      : { id: 'pin', label: '置顶', icon: <Pin size={13} />, run: () => setPinned(p.ws.id, true) },
    '-',
    { id: 'new-chat', label: '新会话', icon: <MessageSquarePlus size={13} />, run: () => later(() => startChat(p.ws.id)) },
    { id: 'new', label: '新任务', icon: <SquarePen size={13} />, run: () => later(() => startCreate(p.ws.id)) },
    { id: 'chat', label: '打开群聊', icon: <Users size={13} />, run: () => onSelect({ kind: 'channel', channel: p.channel?.id ?? `ws:${p.ws.id}` }) },
    '-',
    {
      id: 'active',
      label: '设为当前工作区',
      icon: <Star size={13} />,
      disabled: p.ws.kind === 'machine' ? '「整台电脑」不能设为当前工作区' : p.active ? '已经是当前工作区' : false,
      run: () => run(() => window.bridge.setActiveWorkspace(p.ws.id))
    },
    { id: 'reveal', label: '在资源管理器中显示', icon: <FolderOpen size={13} />, run: () => run(() => window.bridge.openWorkspace(p.ws.id)) },
    { id: 'copy', label: '复制路径', icon: <Copy size={13} />, run: () => run(() => window.bridge.copy(p.ws.root)) },
    '-',
    {
      id: 'archive-all',
      label: '归档全部会话',
      icon: <Archive size={13} />,
      disabled: p.threads.length ? false : '这个项目里没有另开的会话',
      confirm: `再点一次：归档 ${p.threads.length} 个会话（AI 不再看到，消息留着，可以恢复）`,
      run: () =>
        run(async () => {
          // 一个一个来：主进程每次都要重写会话列表
          for (const c of p.threads) await window.bridge.archiveGroupChatThread(c.id, true)
        })
    },
    {
      id: 'remove',
      label: '移除项目',
      icon: <X size={13} />,
      danger: true,
      disabled: p.ws.kind === 'machine' ? '「整台电脑」是内置的，不能移除' : false,
      confirm: '再点一次：把它移出列表（文件夹里的东西不动）',
      run: () => run(() => window.bridge.removeWorkspace(p.ws.id))
    }
  ]

  /** 一行会话 / 任务（「最近」和「全部会话」共用） */
  const itemRow = (r: RecentItem) => {
    const ch = r.target.kind === 'channel' ? r.target.channel : undefined
    const editing = view === 'chats' && ch !== undefined && renaming === ch ? (state.chat?.channels ?? []).find((x) => x.id === ch) : undefined
    if (editing) return renameInput(editing)
    return (
    <Row
      key={r.key}
      icon={
        r.status ? (
          <StatusDot status={r.status} />
        ) : r.target.kind === 'channel' && r.target.channel === LOBBY ? (
          <MessagesSquare size={14} />
        ) : r.target.kind === 'channel' && r.target.channel.includes('.') ? (
          <MessageSquare size={14} />
        ) : (
          <Users size={14} />
        )
      }
      title={r.title}
      onContextMenu={r.target.kind === 'channel' ? ((ch) => (e: MouseEvent) => ctx.open(e, channelMenu(ch)))(r.target.channel) : undefined}
      sub={`${r.project ? `${r.project} · ` : ''}${r.ts ? timeAgo(r.ts) : '还没有消息'}`}
      bold={(r.unread ?? 0) > 0}
      selected={same(selected, r.target)}
      onClick={() => onSelect(r.target)}
      right={<Count n={r.unread ?? 0} tone="accent" />}
    />
    )
  }
  const cardRow = card ? rows.find((p) => p.ws.id === card.id) : undefined

  const active = rows.find((p) => p.active)

  return (
    <div className="flex h-full flex-col overflow-auto pb-4">
      {ctx.menu}
      <div className="pt-2">
        <Row
          icon={<MessageSquarePlus size={15} />}
          title="新会话"
          tip="打开「新会话」页：选项目，直接说要做什么"
          selected={!selected}
          onClick={() => {
            onSelect(undefined)
            focusNewChat()
          }}
        />
        <Row
          icon={<SquarePen size={15} />}
          title="新任务"
          tip={active ? `在当前工作区「${active.ws.name}」里建一个任务` : '先添加一个工作区'}
          onClick={() => (active ? startCreate(active.ws.id) : run(() => addWorkspaceFlow()))}
        />
        <Row
          icon={<MessagesSquare size={15} />}
          title="大厅"
          bold={(lobby?.unread ?? 0) > 0}
          selected={same(selected, { kind: 'channel', channel: LOBBY })}
          onClick={() => onSelect({ kind: 'channel', channel: LOBBY })}
          onContextMenu={(e) => ctx.open(e, mainMenu(LOBBY, lobby))}
          right={<Count n={lobby?.unread ?? 0} tone={lobby?.mentions ? 'bad' : 'accent'} />}
        />
        {/* 概览以前收在图标栏的「更多」里；它是首页里的一页，放在这里 */}
        <Row
          icon={<LayoutDashboard size={15} />}
          title="概览"
          tip="谁在线、调用量、各项目的任务"
          selected={same(selected, { kind: 'overview' })}
          onClick={() => onSelect({ kind: 'overview' })}
        />
      </div>

      <div className="mt-2 flex h-9 shrink-0 items-center justify-between px-3">
        <button
          data-projects-view={view}
          title={view === 'projects' ? '现在按项目分组。点一下改成不分项目、按时间列全部会话' : '现在按时间列全部会话。点一下改回按项目分组'}
          aria-label="切换侧栏：按项目 / 全部会话"
          onClick={() => setProjectsView(view === 'projects' ? 'chats' : 'projects')}
          className="-ml-1 flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[11px] font-semibold tracking-wider text-muted hover:bg-hover hover:text-fg"
        >
          {view === 'projects' ? '项目' : '全部会话'}
          <ChevronDown size={12} />
        </button>
        <IconButton title="添加工作区（选一个文件夹，再选哪些 AI 能用）" onClick={() => run(() => addWorkspaceFlow())}>
          <Plus size={14} />
        </IconButton>
      </div>
      {error && <div className="mx-3 mb-1 rounded border border-bad/40 bg-bad/10 px-2 py-1 text-[11px] text-bad">{error}</div>}
      {rows.length === 0 && <div className="px-3 py-2 text-xs leading-relaxed text-muted">还没有工作区。点右上角的 + 选一个文件夹。</div>}
      {view === 'chats' && allChats(state).map(itemRow)}
      {cardRow && card && (
        <div
          data-project-card={cardRow.ws.id}
          style={{ top: card.top, left: card.left }}
          onMouseEnter={() => clearTimeout(cardTimer.current)}
          onMouseLeave={() => hoverProject(cardRow.ws.id, null)}
          className="fixed z-40 w-72 rounded-xl border border-line bg-raised p-3 text-[13px] shadow-2xl"
        >
          <div className="flex items-center gap-2">
            {cardRow.ws.kind === 'machine' ? <Monitor size={15} className="shrink-0 text-muted" /> : <Folder size={15} className="shrink-0 text-muted" />}
            <span className="min-w-0 flex-1 truncate font-medium">{cardRow.ws.name}</span>
            <IconButton title={pinned.has(cardRow.ws.id) ? '取消置顶' : '置顶'} className={cx(pinned.has(cardRow.ws.id) && 'text-accent')} onClick={() => setPinned(cardRow.ws.id, !pinned.has(cardRow.ws.id))}>
              {pinned.has(cardRow.ws.id) ? <PinOff size={13} /> : <Pin size={13} />}
            </IconButton>
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-muted">
            <MessageSquare size={13} className="shrink-0" />
            {cardRow.threads.length + (cardRow.channel ? 1 : 0)} 个会话 · {cardRow.open.length} 个任务没做完
          </div>
          <div className="mt-2 flex items-start gap-2 border-t border-line pt-2 text-muted">
            <FolderOpen size={13} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-all">{cardRow.ws.root}</span>
          </div>
          <div className="mt-2 border-t border-line pt-2 text-muted">
            {cardRow.active ? (
              <span className="flex items-center gap-2">
                <Star size={13} className="shrink-0 text-accent" /> 当前工作区：文件、终端、改动页跟着它
              </span>
            ) : cardRow.ws.kind === 'machine' ? (
              <span className="flex items-center gap-2">
                <Monitor size={13} className="shrink-0" /> 内置的「整台电脑」：打开了这个开关的 AI 才能用
              </span>
            ) : (
              <button
                className="flex cursor-pointer items-center gap-2 hover:text-fg"
                onClick={() => {
                  closeCard()
                  run(() => window.bridge.setActiveWorkspace(cardRow.ws.id))
                }}
              >
                <Star size={13} className="shrink-0" /> 设为当前工作区
              </button>
            )}
          </div>
        </div>
      )}
      {view === 'projects' && rows.map((p) => {
        const open = expanded.has(p.ws.id)
        const machine = p.ws.kind === 'machine'
        const channel: HomeTarget = { kind: 'channel', channel: p.channel?.id ?? `ws:${p.ws.id}` }
        const all = showAll.has(p.ws.id)
        const tasks = all ? p.open : p.open.slice(0, TASKS_SHOWN)
        const unread = p.channel?.unread ?? 0
        const archivedShown = showArchived.has(p.ws.id)
        const threadRow = (c: GroupChannelInfo) => {
          const target: HomeTarget = { kind: 'channel', channel: c.id }
          if (renaming === c.id) return renameInput(c)
          return (
            <Row
              key={c.id}
              indent
              icon={c.thread?.archived ? <Archive size={14} /> : <MessageSquare size={14} />}
              title={<span className={cx(c.thread?.archived && 'text-muted')}>{c.thread?.title}</span>}
              sub={c.thread?.archived ? '已归档' : modeLine(state, c.id)}
              tip={c.thread?.archived ? `${c.thread.title} · 已归档：AI 看不到，右键可以恢复或删除` : `${c.thread?.title} · 右键可以改名、归档、删除`}
              bold={!c.thread?.archived && c.unread > 0}
              selected={same(selected, target)}
              onClick={() => onSelect(target)}
              onContextMenu={(e) => ctx.open(e, threadMenu(c))}
              right={
                c.thread?.archived ? undefined : (
                  <>
                    <IconButton
                      title="归档这个会话（AI 不再看到，消息留着）"
                      data-thread-archive
                      className="opacity-0 group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation()
                        run(() => window.bridge.archiveGroupChatThread(c.id, true))
                      }}
                    >
                      <Archive size={12} />
                    </IconButton>
                    <Count n={c.unread} tone={c.mentions ? 'bad' : 'accent'} />
                  </>
                )
              }
            />
          )
        }
        return (
          <div key={p.ws.id}>
            <Row
              icon={machine ? <Monitor size={15} /> : open ? <FolderOpen size={15} /> : <Folder size={15} />}
              title={
                <span className="flex items-center gap-1.5">
                  <span className="truncate">{p.ws.name}</span>
                  {pinned.has(p.ws.id) && <Pin size={11} className="shrink-0 text-faint" aria-label="已置顶" />}
                  {p.active && (
                    <span className="shrink-0 rounded bg-accent/15 px-1 text-[10px] leading-4 font-normal text-accent">
                      当前
                    </span>
                  )}
                </span>
              }
              bold={p.unread > 0}
              more={false}
              onHover={(el) => hoverProject(p.ws.id, el)}
              onClick={() => {
                closeCard()
                setExpanded(p.ws.id, !open)
              }}
              onContextMenu={(e) => {
                closeCard()
                ctx.open(e, projectMenu(p))
              }}
              right={
                <>
                  {/* 三个按钮平时不占地方（侧栏拖窄了名字也看得全），鼠标移上来或键盘走到时才展开 */}
                  <span
                    data-project-actions
                    className="flex w-0 shrink-0 items-center gap-1 overflow-hidden opacity-0 group-hover:w-auto group-hover:overflow-visible group-hover:opacity-100 focus-within:w-auto focus-within:overflow-visible focus-within:opacity-100"
                  >
                  <IconButton
                    title={`「${p.ws.name}」的更多操作`}
                    onClick={(e) => {
                      e.stopPropagation()
                      closeCard()
                      ctx.open(e, projectMenu(p))
                    }}
                  >
                    <Ellipsis size={13} />
                  </IconButton>
                  <IconButton
                    title={`在「${p.ws.name}」里开一个会话`}
                    onClick={(e) => {
                      e.stopPropagation()
                      startChat(p.ws.id)
                    }}
                  >
                    <MessageSquarePlus size={12} />
                  </IconButton>
                  <IconButton
                    title={`在「${p.ws.name}」里建一个任务`}
                    onClick={(e) => {
                      e.stopPropagation()
                      startCreate(p.ws.id)
                    }}
                  >
                    <SquarePen size={12} />
                  </IconButton>
                  </span>
                  {/* 收起时把里面的未读、待审查数露在外面 */}
                  {!open && <Count n={p.unread} tone={p.mentions ? 'bad' : 'accent'} />}
                  {!open && <Count n={p.review} tone="warn" />}
                  <span className="shrink-0 text-faint">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
                </>
              }
            />
            {open && (
              <div>
                {p.channel && renaming === p.channel.id ? (
                  renameInput(p.channel)
                ) : (
                  <Row
                    indent
                    icon={<Users size={14} />}
                    title={p.channel ? channelLabel(p.channel) : '群聊'}
                    sub={p.channel ? modeLine(state, p.channel.id) : undefined}
                    tip={p.channel ? `${channelLabel(p.channel)} · 这个项目的主群聊：删不掉，右键可以改名、清空消息` : undefined}
                    bold={unread > 0}
                    selected={same(selected, channel)}
                    onClick={() => onSelect(channel)}
                    onContextMenu={(e) => ctx.open(e, mainMenu(channel.channel, p.channel))}
                    right={<Count n={unread} tone={p.channel?.mentions ? 'bad' : 'accent'} />}
                  />
                )}
                {chatting === p.ws.id && (
                  <InlineInput label="新会话的标题" placeholder="会话标题（可以不填），回车创建，Esc 取消" allowEmpty onCancel={() => setChatting(undefined)} onSubmit={(title) => createChat(p.ws.id, title)} />
                )}
                {(() => {
                  const allThreads = showThreads.has(p.ws.id)
                  // 正在看的那个会话就算排在后面也留在外面，不然选中的行会不见
                  const shownThreads = allThreads ? p.threads : p.threads.filter((c, i) => i < THREADS_SHOWN || same(selected, { kind: 'channel', channel: c.id }))
                  return (
                    <>
                      {shownThreads.map(threadRow)}
                      {p.threads.length > THREADS_SHOWN && (
                        <div className="mx-1.5 cursor-pointer rounded py-1 pl-[52px] text-[11px] text-muted hover:bg-hover hover:text-fg" onClick={() => toggle(setShowThreads, p.ws.id)}>
                          {allThreads ? '收起会话' : `还有 ${p.threads.length - shownThreads.length} 个会话`}
                        </div>
                      )}
                    </>
                  )
                })()}
                {creating === p.ws.id && <InlineInput label="新任务的标题" placeholder="任务标题，回车创建，Esc 取消" onCancel={() => setCreating(undefined)} onSubmit={(title) => create(p.ws.id, title)} />}
                {tasks.map((t) => {
                  const target: HomeTarget = { kind: 'task', workspaceId: p.ws.id, taskId: t.id }
                  const who = t.assigneeId ? state.agents.find((a) => a.id === t.assigneeId) : undefined
                  return (
                    <Row
                      key={t.id}
                      indent
                      icon={<StatusDot status={t.status} />}
                      title={
                        <>
                          <span className="text-muted">{t.ref}</span> {t.title}
                        </>
                      }
                      tip={`${t.ref} ${t.title} · ${STATUS_META[t.status].label}${who ? ` · ${who.name}` : ''}`}
                      selected={same(selected, target)}
                      onClick={() => onSelect(target)}
                      bold={(taskThreadOf(state, t.id, p.ws.id)?.unread ?? 0) > 0}
                      right={
                        <>
                          <Count n={taskThreadOf(state, t.id, p.ws.id)?.unread ?? 0} tone={taskThreadOf(state, t.id, p.ws.id)?.mentions ? 'bad' : 'accent'} />
                          {who ? <Avatar name={who.name} color={who.color} size={16} /> : null}
                        </>
                      }
                    />
                  )
                })}
                {p.open.length > TASKS_SHOWN && (
                  <div
                    className="mx-1.5 cursor-pointer rounded py-1 pl-[52px] text-[11px] text-muted hover:bg-hover hover:text-fg"
                    onClick={() => toggle(setShowAll, p.ws.id)}
                  >
                    {all ? '收起' : `还有 ${p.open.length - TASKS_SHOWN} 个没做完的`}
                  </div>
                )}
                {p.open.length === 0 && creating !== p.ws.id && <div className="py-1 pl-[52px] text-[11px] text-faint">没有进行中的任务</div>}
                {p.archived.length > 0 && (
                  <div className="mx-1.5 cursor-pointer rounded py-1 pl-[52px] text-[11px] text-muted hover:bg-hover hover:text-fg" onClick={() => toggle(setShowArchived, p.ws.id)}>
                    {archivedShown ? '收起已归档的会话' : `已归档的会话 ${p.archived.length} 个`}
                  </div>
                )}
                {archivedShown && p.archived.map(threadRow)}
              </div>
            )}
          </div>
        )
      })}

      {view === 'projects' && (
        <>
          <div className="mt-2">
            <PanelHeader title="最近" />
          </div>
          {recent.length === 0 && <div className="px-3 py-1 text-xs text-muted">还没有动静。</div>}
          {recent.map(itemRow)}
        </>
      )}
    </div>
  )
}

/** 侧栏里就地输入一行：新任务、新会话的标题，会话改名。allowEmpty：空着回车也算（由调用方起名） */
function InlineInput({
  label,
  placeholder,
  initial = '',
  allowEmpty,
  onSubmit,
  onCancel
}: {
  label: string
  placeholder: string
  initial?: string
  allowEmpty?: boolean
  onSubmit: (title: string) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState(initial)
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && (allowEmpty || title.trim())) onSubmit(title.trim())
    else if (e.key === 'Escape') onCancel()
  }
  return (
    <div className="mx-1.5 py-1 pr-2 pl-7">
      <input
        autoFocus
        aria-label={label}
        value={title}
        maxLength={60}
        onChange={(e) => setTitle(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={onKey}
        onBlur={() => {
          // 没改过就点到别处：算取消
          if (!title.trim() || title === initial) onCancel()
        }}
        placeholder={placeholder}
        className="h-7 w-full rounded border border-accent/60 bg-canvas px-2 text-[13px] text-fg outline-none placeholder:text-faint"
      />
    </div>
  )
}
