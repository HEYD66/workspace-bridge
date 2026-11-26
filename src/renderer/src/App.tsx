import {
  Activity,
  Brain,
  CalendarClock,
  ChevronLeft,
  Ellipsis,
  Files,
  Folder,
  GitCompare,
  Globe,
  Home,
  ListTodo,
  Loader2,
  MessagesSquare,
  TerminalSquare,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Pause,
  Play,
  FlaskConical,
  ScrollText,
  Search,
  Settings,
  Smartphone,
  Sparkles,
  Users,
  UsersRound,
  Wifi,
  Workflow
} from 'lucide-react'
import { Fragment, useEffect, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type ReactNode, type SetStateAction } from 'react'
import { CommandPalette, type PaletteItem } from './components/CommandPalette'
import type { ActivityEvent } from '../../shared/api'
import { OAuthApproval } from './components/OAuthApproval'
import { REMOTE_VIEW_LABEL, RemoteViewCard, useRemoteView } from './components/RemoteViewCard'
import { QuickOpen } from './components/QuickOpen'
import { Avatar, cx } from './components/ui'
import { activeWorkspace, WorkspaceSwitcher } from './components/WorkspaceSwitcher'
import { openFile } from './lib/editorStore'
import { toolLabel } from './lib/format'
import { clearNavIds, navigate, SECTIONS, useNav, type Section } from './lib/nav'
import { focusOnCanvas } from './lib/canvasStore'
import { cardKey } from './lib/canvasBoard'
import { isSettingsSection, RAIL_DIVIDER_AFTER, railSections, SETTINGS_GROUPS, splitLabel } from './lib/shell'
import { applyViewport, isPhoneScreen, isPhoneSection, PHONE_KEY, PHONE_MORE, phoneShell, phoneTab, viewportContent, wantsPhoneLayout, type PhoneView } from './lib/phone'
import { useBridge } from './lib/useBridge'
import { RightPanel } from './views/RightPanel'
import { ChatList, ChatMain, useRunningChats } from './views/ChatView'
import { EditorArea, ExplorerPanel } from './views/FilesView'
import { GroupMain, GroupMembers } from './views/GroupChatView'
import { ActivityPanel } from './views/ActivityPanel'
import { CommandDetail, CommandList, useAiCommands } from './views/CommandsView'
import { channelFullName, chatTotals, resolveChannel } from './lib/groupChat'
import { MemoryEditor, MemoryList } from './views/MemoryView'
import { SearchPanel } from './views/SearchView'
import { NewChatView } from './views/NewChatView'
import { OverviewView } from './views/OverviewView'
import { CanvasRoster, CanvasView } from './views/CanvasView'
import { ProjectsPanel } from './views/ProjectsPanel'
import { homeId, parseHomeId, useAllTasks } from './lib/projects'
import { onShowChanges, panelChannel, panelWorkspaceId, setRightTab } from './lib/rightPanel'
import { closeTab, newTabId, onRightPanelRequest, openBrowserTab, updatePanelTabs, usePanelTabs } from './lib/rightTabs'
import { AuditView } from './views/AuditView'
import { PlaygroundMain, PlaygroundSide } from './views/PlaygroundView'
import { SettingsView, Welcome } from './views/SettingsView'
import { setSkillWorkspace } from './lib/skillScope'
import { SkillList, SkillMain, SkillsHome } from './views/SkillsView'
import { TaskDetail, TaskList } from './views/TasksView'
import { TaskBoard, taskBoardWorkspace, type TaskScope } from './views/TaskBoard'
import { AgentDetail, NewAgent, RoleEditor, TeamEmpty, TeamList, type TeamSel } from './views/TeamView'
import { onTerminalShowRequest, TerminalPanel } from './views/TerminalView'
import { ChangesList, ChangesMain } from './views/ChangesView'
import { ScheduleList, ScheduleMain } from './views/SchedulesView'
import { WorkspaceMembersDialog } from './components/WorkspaceMembersDialog'

const NAV: { id: Exclude<Section, 'settings'>; label: string; icon: typeof Files }[] = [
  { id: 'overview', label: '首页（项目、最近、概览）', icon: Home },
  { id: 'canvas', label: '画布（所有项目和 AI 画在一张图上）', icon: Workflow },
  { id: 'files', label: '文件（Ctrl+Shift+E）', icon: Files },
  { id: 'search', label: '搜索（Ctrl+Shift+F）', icon: Search },
  { id: 'chat', label: '对话', icon: MessagesSquare },
  { id: 'group', label: '群聊', icon: UsersRound },
  { id: 'commands', label: 'AI 命令', icon: TerminalSquare },
  { id: 'changes', label: '改动', icon: GitCompare },
  { id: 'tasks', label: '任务', icon: ListTodo },
  { id: 'schedules', label: '定时任务', icon: CalendarClock },
  { id: 'memory', label: '记忆', icon: Brain },
  { id: 'skills', label: '技能', icon: Sparkles },
  { id: 'playground', label: '工具试用', icon: FlaskConical },
  { id: 'audit', label: '审计日志', icon: ScrollText },
  { id: 'team', label: '团队与职位', icon: Users }
]

/** 图标栏宽度加右边留的 8 像素，算拖动上限用 */
const ACTIVITY_BAR = 64
/** 主区至少留这么宽 */
const MIN_MAIN = 320

const SIDE_DEFAULT = 264
const ACTIVITY_DEFAULT = 340
/** 右栏看差异最好有这么宽 */
const DIFF_WIDTH = 460
/** 为了看差异把右栏撑宽时，会话那一栏至少留这么宽 */
const CHAT_KEEP = 560
const PANEL_DEFAULT = 260

// ========== 导航 id ↔ 团队页选中 ==========

/** team 分区的 id：agentId、`role:<roleId>`；`new` 新建 AI，`role:new` 新建职位 */
function teamSelOf(id: string | undefined): TeamSel | undefined {
  if (!id) return undefined
  if (id === 'new') return { kind: 'new-agent' }
  if (id === 'role:new') return { kind: 'new-role' }
  if (id.startsWith('role:')) return { kind: 'role', id: id.slice(5) }
  return { kind: 'agent', id }
}

function teamIdOf(sel: TeamSel): string {
  if (!('id' in sel)) return sel.kind === 'new-agent' ? 'new' : 'role:new'
  return sel.kind === 'role' ? `role:${sel.id}` : sel.id
}

// ========== 布局：记在 localStorage 里的尺寸和开关 ==========

function useStored<T extends number | boolean>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw !== null) {
        const v: unknown = JSON.parse(raw)
        if (typeof v === typeof initial && (typeof v !== 'number' || Number.isFinite(v))) return v as T
      }
    } catch {
      // 读不到就用默认值
    }
    return initial
  })
  // 拖动时每帧都在变，停下来再写
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        // 忽略
      }
    }, 200)
    return () => clearTimeout(t)
  }, [key, value])
  return [value, setValue]
}

/**
 * 分隔条：拖动调整相邻区域的大小，双击还原默认值。
 * axis x 是竖条（左右拖），y 是横条（上下拖）；invert 表示往左 / 往上拖时变大（右侧栏、底部面板）。
 */
function Splitter({
  axis,
  value,
  min,
  max,
  defaultValue,
  invert,
  onChange
}: {
  axis: 'x' | 'y'
  value: number
  min: number
  /** 拖动那一刻再算，跟着窗口大小变 */
  max: () => number
  defaultValue: number
  invert?: boolean
  onChange: (n: number) => void
}) {
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ pos: number; value: number } | null>(null)
  const bodyClass = axis === 'x' ? 'resizing-x' : 'resizing-y'
  const clamp = (n: number) => Math.round(Math.min(Math.max(n, min), Math.max(min, max())))

  useEffect(() => () => document.body.classList.remove(bodyClass), [bodyClass])

  const pos = (e: ReactPointerEvent) => (axis === 'x' ? e.clientX : e.clientY)
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    setDragging(false)
    document.body.classList.remove(bodyClass)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  return (
    <div className={cx('relative z-20 shrink-0', axis === 'x' ? 'w-0' : 'h-0')}>
      <div
        role="separator"
        aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
        aria-label="拖动调整大小，双击还原"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { pos: pos(e), value }
          setDragging(true)
          document.body.classList.add(bodyClass)
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          const d = (pos(e) - drag.current.pos) * (invert ? -1 : 1)
          onChange(clamp(drag.current.value + d))
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onDoubleClick={() => onChange(clamp(defaultValue))}
        className={cx(
          'absolute transition-colors',
          axis === 'x' ? 'inset-y-0 -left-0.5 w-1 cursor-col-resize' : 'inset-x-0 -top-0.5 h-1 cursor-row-resize',
          dragging ? 'bg-accent' : 'hover:bg-accent/60 hover:delay-150'
        )}
      />
    </div>
  )
}

/** 活动栏图标右上角的计数 */
function CountBadge({ n, tone = 'warn' }: { n: number; tone?: 'warn' | 'accent' | 'bad' }) {
  if (n <= 0) return null
  return (
    <span
      className={cx(
        'absolute top-1 right-1 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-semibold',
        tone === 'warn' ? 'bg-warn text-[#0d1117]' : tone === 'accent' ? 'bg-accent text-[#0d1117]' : 'bg-bad text-white'
      )}
    >
      {n > 99 ? '99+' : n}
    </span>
  )
}

const railButton = (on: boolean): string =>
  cx('relative flex h-[38px] w-[38px] cursor-pointer items-center justify-center rounded-[10px]', on ? 'bg-hover text-fg' : 'text-muted hover:bg-hover/60 hover:text-fg')

function LayoutToggle({ title, on, onClick, children }: { title: string; on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      title={title}
      aria-label={title}
      aria-pressed={on}
      onClick={onClick}
      className={cx('flex h-7 w-7 cursor-pointer items-center justify-center rounded-md hover:bg-hover', on ? 'text-fg' : 'text-faint hover:text-fg')}
    >
      {children}
    </button>
  )
}

export function App() {
  const { state, events, memories, tasks, machineTasks, skills, skillsLoading, skillsError, skillWs, reloadSkills } = useBridge()
  // 任务页看当前工作区的任务板，还是「整台电脑」的（工作台切不到整台电脑，只能在任务页里这样看）
  const [taskScope, setTaskScope] = useState<TaskScope>('active')
  const nav = useNav()
  const section = nav.section
  // 画布页去过一次就留着（见下面挂它的地方）
  const [canvasKept, setCanvasKept] = useState(section === 'canvas')
  useEffect(() => {
    if (section === 'canvas') setCanvasKept(true)
  }, [section])
  // 手机版（lib/phone.ts）：用手机从远端链接打开时，一次只看一栏，导航在底部。这块屏幕是不是手机，打开页面时定一次
  const [phoneEnv] = useState(() => {
    let override: string | null = null
    try {
      override = localStorage.getItem(PHONE_KEY)
    } catch {
      // 读不了就自动判断
    }
    const env = { remote: window.bridge.isRemote, screenW: window.screen.width, screenH: window.screen.height }
    return { ...env, capable: isPhoneScreen(env), phone: wantsPhoneLayout({ ...env, override }) }
  })
  const phone = phoneEnv.phone
  /** 手机版正在看哪一页；main 时看 phoneDetail：false 是列表，true 是点进去的内容 */
  const [phoneView, setPhoneView] = useState<PhoneView>('main')
  const [phoneDetail, setPhoneDetail] = useState(false)
  const inPhoneShell = phoneShell(phone, section, phoneView)
  // 手机版按手机宽度排；手机上点进没排过的页面（电脑版样子）时按电脑版的宽度画再缩小
  useEffect(() => applyViewport(viewportContent({ shell: inPhoneShell, remote: phoneEnv.remote || phone, screenW: phoneEnv.screenW })), [inPhoneShell, phone, phoneEnv.remote, phoneEnv.screenW])
  /** 手机版里点了列表里的一项：翻到内容那一屏（电脑版里两栏并排，这个状态没人看） */
  const toDetail = (): void => setPhoneDetail(true)
  /** 手机版：换到另一页，从它的列表开始 */
  const phoneGo = (to: Section | 'activity' | 'more'): void => {
    setPhoneDetail(false)
    if (to === 'activity' || to === 'more') return setPhoneView(to)
    setPhoneView('main')
    navigate({ section: to })
  }
  const setPhoneOverride = (v: '0' | null): void => {
    try {
      if (v === null) localStorage.removeItem(PHONE_KEY)
      else localStorage.setItem(PHONE_KEY, v)
    } catch {
      // 存不了就算了
    }
    location.reload()
  }
  const runningChats = useRunningChats()
  const remoteView = useRemoteView()
  // AI 命令：活动栏角标要用运行中条数，所以在顶层订阅
  const aiCommands = useAiCommands()
  // 首页的项目列表要同时看每个工作区的任务
  const tasksByWs = useAllTasks(state)

  const [sideOpen, setSideOpen] = useStored<boolean>('wb.layout.sideOpen', true)
  const [sideWidth, setSideWidth] = useStored<number>('wb.layout.sideWidth', SIDE_DEFAULT)
  const [activityOpen, setActivityOpen] = useStored<boolean>('wb.layout.activityOpen', true)
  const [activityWidth, setActivityWidth] = useStored<number>('wb.layout.activityWidth', ACTIVITY_DEFAULT)
  // 右栏里开着网页标签时，收起右栏也不把它卸掉：不然网页会被关掉，再展开要重新加载
  // 右栏收起时里面的东西要不要留着：网页标签（不然网页要重新加载）、文件标签（不然没保存的改动就丢了）
  const keepPanel = usePanelTabs().tabs.some((t) => t.kind === 'browser' || t.kind === 'file')
  // 跟踪窗口宽度：缩小窗口时压缩侧栏 / 活动面板的显示宽度
  const [winWidth, setWinWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = () => setWinWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const [panelHeight, setPanelHeight] = useStored<number>('wb.layout.panelHeight', PANEL_DEFAULT)
  // 终端面板默认收起，不记开关：免得每次启动都自动开一个 shell
  const [panelOpen, setPanelOpen] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  /** 这次「快速打开」是从右栏新标签页的「文件」点开的：选中的文件一定开在右栏 */
  const [quickRight, setQuickRight] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // 图标栏左下角的齿轮点开的菜单：设置，和管理、配置用的几个页面
  const [gearOpen, setGearOpen] = useState(false)
  useEffect(() => {
    if (!gearOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setGearOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [gearOpen])
  // 图标栏按钮的说明：鼠标一停上去就出来。浏览器自带的 title 要等一秒，这里自己画
  const [railTip, setRailTip] = useState<{ text: string; top: number } | null>(null)
  const railTipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hideRailTip = (): void => {
    clearTimeout(railTipTimer.current)
    setRailTip(null)
  }
  const showRailTip = (target: EventTarget): void => {
    const b = (target as Element).closest?.('button[data-tip]')
    clearTimeout(railTipTimer.current)
    if (!b) return setRailTip(null)
    const text = b.getAttribute('data-tip') ?? ''
    const r = b.getBoundingClientRect()
    // 稍等一下再出：鼠标只是路过时不闪
    railTipTimer.current = setTimeout(() => setRailTip({ text, top: Math.round(r.top + r.height / 2) }), 80)
  }
  // 图标栏左下角的「远端查看」按钮点开的小窗
  const [remoteOpen, setRemoteOpen] = useState(false)
  useEffect(() => {
    if (!remoteOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRemoteOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [remoteOpen])
  /** 每次 Ctrl+Shift+F 加一，搜索栏显示出来后聚焦输入框 */
  const [focusSearch, setFocusSearch] = useState(0)

  const columnRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLDivElement>(null)
  const quickOpenRef = useRef(quickOpen)
  quickOpenRef.current = quickOpen

  // 聊天里点了「查看变更」：右栏收着就展开；太窄看不了差异，撑到够看——但只用会话那一栏多出来的宽度，不把会话挤扁
  const activityOpenRef = useRef(activityOpen)
  activityOpenRef.current = activityOpen
  useEffect(
    () =>
      onShowChanges(() => {
        const mainNow = columnRef.current?.clientWidth ?? 0
        const wasOpen = activityOpenRef.current
        setActivityOpen(true)
        setActivityWidth((w) => {
          if (w >= DIFF_WIDTH) return w
          const spare = Math.max(0, mainNow - (wasOpen ? 0 : w) - CHAT_KEEP)
          return Math.min(DIFF_WIDTH, w + spare)
        })
      }),
    [setActivityOpen, setActivityWidth]
  )

  // 另开网页标签。放在这里而不是右栏里：右栏收着、里面又没有网页时它没挂着，AI 调 browser_open 就没人接了
  useEffect(() => {
    const offOpen = window.bridge.onBrowserOpen(({ url, wcId, tabId, focus, reveal }) => {
      // 网页里开新窗口（window.open、target=_blank）：排在发起的那个标签后面
      let from: string | undefined
      if (wcId) {
        for (const el of document.querySelectorAll('webview[data-browser-view]')) {
          try {
            if ((el as unknown as { getWebContentsId(): number }).getWebContentsId() === wcId) from = el.getAttribute('data-browser-view') ?? undefined
          } catch {
            // 还没准备好的网页
          }
        }
      }
      updatePanelTabs((s) => openBrowserTab(s, url, tabId || newTabId(), { afterId: from, focus: focus !== false }))
      if (reveal) setActivityOpen(true)
    })
    const offClose = window.bridge.onBrowserClose(({ tabId }) => {
      // 画布上的网页小窗（id 是 wd_ 开头）：AI 关它，就是把小窗从画布上拿掉；画布页没开着也管用
      if (tabId.startsWith('wd_')) void window.bridge.canvasUpdate('all', [{ op: 'removeWidget', id: tabId }]).catch(() => undefined)
      updatePanelTabs((s) => closeTab(s, tabId, newTabId()))
    })
    return () => {
      offOpen()
      offClose()
    }
  }, [setActivityOpen])

  // 快捷键：窗口捕获阶段处理，Monaco、终端有焦点时也生效
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.altKey || !(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      // 快速打开开着时，Ctrl+P 是它输入框里的「上一项」，不拦
      if (quickOpenRef.current && !e.shiftKey && k === 'p') return
      let hit = true
      if (!e.shiftKey && k === 'p') setQuickOpen(true)
      else if ((e.shiftKey && k === 'p') || (!e.shiftKey && k === 'k')) setPaletteOpen((v) => !v)
      else if (e.shiftKey && k === 'f') {
        navigate({ section: 'search' })
        setSideOpen(true)
        setFocusSearch((n) => n + 1)
      } else if (e.shiftKey && k === 'e') {
        navigate({ section: 'files' })
        setSideOpen(true)
      } else if (e.shiftKey && k === 'g') {
        // 右栏的「变更」（和 Codex 一样的键）
        setActivityOpen(true)
        setRightTab('changes')
      } else if (!e.shiftKey && k === 'b') setSideOpen((v) => !v)
      else if (!e.shiftKey && (k === 'j' || e.code === 'Backquote' || e.key === '`')) setPanelOpen((v) => !v)
      else hit = false
      if (hit) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [setSideOpen, setActivityOpen])

  // 搜索栏是一直挂着的，切过去时自己聚焦输入框（像 VS Code 一样全选已有内容）
  useEffect(() => {
    if (!focusSearch) return
    const input = searchRef.current?.querySelector('input')
    if (input) {
      input.focus()
      input.select()
    }
  }, [focusSearch])

  // 文件树「在终端打开」等调了 openTerminal 时，把底部面板显示出来
  useEffect(() => onTerminalShowRequest(() => setPanelOpen(true)), [])
  // 往右栏里放了东西（把终端移到右栏等）而右栏收着：展开
  useEffect(() => onRightPanelRequest(() => setActivityOpen(true)), [])
  // 主进程要求跳转（点了桌面通知）
  useEffect(
    () =>
      window.bridge.onNavigateRequest((t) => {
        if (!t || !SECTIONS.includes(t.section as Section)) return
        // 画布的 id 是「工作区id:AI id」（系统通知）：镜头飞到那张卡片并选中
        const at = t.section === 'canvas' && t.id ? t.id.indexOf(':') : -1
        if (at > 0) {
          navigate({ section: 'canvas' })
          focusOnCanvas('card', cardKey(t.id!.slice(at + 1), t.id!.slice(0, at)))
          return
        }
        navigate({ section: t.section as Section, ...(t.id ? { id: t.id } : {}) })
      }),
    []
  )

  // 换了当前工作区：任务、记忆是按工作区存的，上个工作区的选中作废
  const activeId = state?.activeWorkspaceId
  const lastActive = useRef(activeId)
  useEffect(() => {
    if (lastActive.current === activeId) return
    lastActive.current = activeId
    // 群聊清掉选中的频道，下次打开回到新工作区的频道
    clearNavIds('tasks', 'memory', 'group', 'changes')
    // 技能页如果正在看别的工作区的技能，回到跟着当前工作区
    setSkillWorkspace(undefined)
  }, [activeId])

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Loader2 className="animate-spin" />
      </div>
    )
  }

  // 内置的整台电脑不算添加的工作区
  const workspaces = (state.workspaces ?? []).filter((w) => w.kind !== 'machine')
  const hasWs = workspaces.length > 0
  const current = activeWorkspace(state)
  const editorSection = section === 'files' || section === 'search'
  // 设置页也留着侧栏（显示文件树），和别的分区保持一致，不然左边突然空一块
  const sideShown = sideOpen

  // 任务页现在看的任务板：taskWs 有值 = 「整台电脑」的（接口调用都要带上它），没值 = 当前工作区的
  const taskWs = taskBoardWorkspace(taskScope, state)
  const shownTasks = taskWs ? machineTasks : tasks
  // 当前工作区就是整台电脑时（界面做不到，脚本可以），tasks 已经是它的任务，不重复算
  const otherMachineTasks = current?.kind === 'machine' ? [] : machineTasks
  const machineOpen = otherMachineTasks.filter((t) => t.status !== 'done').length
  const activeReview = tasks.filter((t) => t.status === 'review').length
  const reviewCount = activeReview + otherMachineTasks.filter((t) => t.status === 'review').length
  // 顶栏的「某某正在…」：等消息不算在干活，不然待命的 AI 会一直挂在上面
  const running = events.filter((e) => e.status === 'running' && e.tool !== 'chat_wait')

  const id = nav.id
  const task = section === 'tasks' && id ? shownTasks.find((t) => t.id === id) : undefined
  const memory = section === 'memory' && id && id !== 'new' ? memories.find((m) => m.id === id) : undefined
  const teamSel = section === 'team' ? teamSelOf(id) : undefined
  const teamAgent = teamSel?.kind === 'agent' ? state.agents.find((a) => a.id === teamSel.id) : undefined
  const teamRole = teamSel?.kind === 'role' ? state.roles.find((r) => r.id === teamSel.id) : undefined

  // 首页主区：侧栏里点了某个频道或任务就在这里看，没点是概览。任务已经不在了（被删、工作区移除）也回概览
  const homeSel = section === 'overview' ? parseHomeId(id) : undefined
  const homeTask = homeSel?.kind === 'task' ? (tasksByWs[homeSel.workspaceId] ?? []).find((t) => t.id === homeSel.taskId) : undefined
  const homeWs = homeSel?.kind === 'task' ? (state.workspaces ?? []).find((w) => w.id === homeSel.workspaceId) : undefined
  const homeChannel = homeSel?.kind === 'channel' && (state.chat?.channels ?? []).some((c) => c.id === homeSel.channel) ? homeSel.channel : undefined

  // 右栏的「变更」「任务」看哪个项目：正在看的会话 / 任务所在的项目，别的页面是当前工作区
  const panelWs = panelWorkspaceId(state, { section, home: homeChannel || homeTask ? homeSel : undefined, navId: id })
  // 右栏「活动」按群聊看时的那个群聊
  const panelCh = panelChannel(state, { section, home: homeChannel || homeTask ? homeSel : undefined, navId: id })

  const toTeam = (teamId?: string) => navigate({ section: 'team', id: teamId })
  const newAgent = () => toTeam('new')

  // 命令面板的条目：页面、AI、频道、工作区、常用操作
  // 注意：这里在上面「state 还没到」的提前 return 之后，不能用 hook（useMemo 会让 hook 数量前后不一致，React #310）
  const paletteItems: PaletteItem[] = (() => {
    const go = (s: Section, id?: string) => () => {
      navigate({ section: s, ...(id !== undefined ? { id } : {}) })
      if (s !== 'settings') setSideOpen(true)
    }
    const items: PaletteItem[] = []
    for (const n of [...NAV, { id: 'settings' as const, label: '设置' }]) items.push({ id: `nav:${n.id}`, group: '页面', title: `打开：${n.label.replace(/（.*）$/, '')}`, keywords: n.id, run: go(n.id) })
    for (const a of state.agents) {
      items.push({ id: `agent:${a.id}`, group: 'AI', title: `${a.name} 的详情`, hint: '接入、整台电脑、职位', keywords: `team ${a.id}`, run: go('team', a.id) })
      if (!a.token) items.push({ id: `chat:${a.id}`, group: '内置 AI', title: `和 ${a.name} 对话`, run: go('chat', a.id) })
    }
    for (const c of state.chat?.channels ?? []) items.push({ id: `ch:${c.id}`, group: '群聊', title: `群聊：${channelFullName(c)}`, hint: c.unread ? `${c.unread} 条未读` : undefined, keywords: 'group chat', run: go('group', c.id) })
    for (const w of (state.workspaces ?? []).filter((x) => x.kind !== 'machine')) {
      if (w.id !== state.activeWorkspaceId)
        items.push({ id: `ws:${w.id}`, group: '工作区', title: `切换到工作区：${w.name}`, hint: w.root, keywords: 'workspace', run: () => void window.bridge.setActiveWorkspace(w.id) })
    }
    items.push(
      { id: 'act:new-agent', group: '操作', title: '新建接入身份', keywords: 'new agent token', run: () => newAgent() },
      { id: 'act:quick-open', group: '操作', title: '快速打开文件', hint: 'Ctrl+P', keywords: 'file open', run: () => setQuickOpen(true) },
      { id: 'act:terminal', group: '操作', title: '显示 / 隐藏终端', hint: 'Ctrl+`', keywords: 'terminal', run: () => setPanelOpen((v) => !v) },
      state.paused
        ? { id: 'act:resume', group: '操作', title: '恢复 AI', keywords: 'resume', run: () => window.bridge.setPaused(false) }
        : { id: 'act:stop', group: '操作', title: '全部停下（暂停所有 AI、取消命令）', keywords: 'stop pause', run: () => void window.bridge.stopAll() },
      state.tunnel?.status === 'running' || state.tunnel?.status === 'starting'
        ? { id: 'act:tunnel-stop', group: '操作', title: '关闭公网隧道', keywords: 'tunnel', run: () => void window.bridge.stopTunnel() }
        : { id: 'act:tunnel-start', group: '操作', title: '启动公网隧道', keywords: 'tunnel cloudflared', run: () => void window.bridge.startTunnel() }
    )
    return items
  })()

  /** 活动流点路径：用事件记下的工作区；旧事件没有 workspaceId 时按当前工作区 */
  const openFromEvent = (path: string, ev: ActivityEvent) => {
    const workspaceId = ev.workspaceId ?? state.activeWorkspaceId
    if (workspaceId) openFile({ workspaceId, path })
  }

  const clickNav = (s: Section) => {
    // 点当前分区的图标：收起 / 展开侧栏（和 VS Code 一样）
    if (s === section && s !== 'settings') setSideOpen((v) => !v)
    else {
      navigate({ section: s })
      if (s !== 'settings') setSideOpen(true)
    }
  }

  // 侧栏：文件树和搜索栏一直挂着（保留展开状态、搜索结果），其他分区按需渲染
  const otherSide = (() => {
    if (section === 'overview')
      return (
        <ProjectsPanel
          state={state}
          tasksByWs={tasksByWs}
          selected={homeChannel || homeTask || homeSel?.kind === 'overview' ? homeSel : undefined}
          onSelect={(t) => {
            navigate({ section: 'overview', id: t ? homeId(t) : undefined })
            toDetail()
          }}
        />
      )
    if (section === 'chat')
      return (
        <ChatList
          state={state}
          selected={id}
          onSelect={(agentId) => {
            if (agentId === 'new') return newAgent()
            navigate({ section: 'chat', id: agentId })
            toDetail()
          }}
        />
      )
    if (section === 'group') return <GroupMembers state={state} channel={resolveChannel(state, id)} onSelect={(ch) => navigate({ section: 'group', id: ch })} />
    if (section === 'commands')
      return (
        <CommandList
          state={state}
          data={aiCommands}
          selected={id}
          onSelect={(c) => {
            navigate({ section: 'commands', id: c })
            toDetail()
          }}
        />
      )
    if (section === 'changes')
      return (
        <ChangesList
          state={state}
          selected={id}
          onSelect={(c) => {
            navigate({ section: 'changes', id: c })
            toDetail()
          }}
        />
      )
    if (section === 'tasks')
      return (
        <TaskList
          state={state}
          tasks={shownTasks}
          selected={id}
          onSelect={(t) => {
            navigate({ section: 'tasks', id: t })
            toDetail()
          }}
          workspaceId={taskWs}
          scope={taskWs ? 'machine' : 'active'}
          onScope={(s) => {
            setTaskScope(s)
            // 两个任务板的任务不通用，选中的作废
            navigate({ section: 'tasks', id: undefined })
          }}
          machineOpen={machineOpen}
        />
      )
    if (section === 'schedules')
      return (
        <ScheduleList
          state={state}
          selected={id}
          onSelect={(s) => {
            navigate({ section: 'schedules', id: s })
            toDetail()
          }}
        />
      )
    if (section === 'memory') return <MemoryList state={state} memories={memories} selected={id} onSelect={(m) => navigate({ section: 'memory', id: m })} />
    if (section === 'skills')
      return (
        <SkillList
          state={state}
          skills={skills}
          loading={skillsLoading}
          error={skillsError}
          selected={id}
          onSelect={(s) => navigate({ section: 'skills', id: s })}
          onRetry={() => void reloadSkills()}
          viewing={skillWs}
        />
      )
    if (section === 'playground') return <PlaygroundSide state={state} selected={id} />
    if (section === 'team') return <TeamList state={state} selected={teamSel} onSelect={(sel) => toTeam(teamIdOf(sel))} />
    if (section === 'canvas') return <CanvasRoster state={state} events={events} tasksByWs={tasksByWs} />
    return null
  })()

  // 主区：files / search 是一直挂着的编辑区；其他分区在这里渲染
  const main = (() => {
    if (section === 'settings') return <SettingsView state={state} />
    // 画布画的是所有项目，不要求有当前工作区
    // 画布页单独挂在下面（去过一次以后只藏不卸）
    if (section === 'canvas') return null
    // 概览是 MCP 控制台首页，不要求工作区
    if (section === 'overview') {
      if (homeChannel) return <GroupMain state={state} channel={homeChannel} />
      if (homeTask && homeSel?.kind === 'task')
        return (
          <TaskDetail
            key={homeTask.id}
            state={state}
            task={homeTask}
            workspaceId={homeSel.workspaceId}
            machine={homeWs?.kind === 'machine'}
            project={homeWs?.name}
            onDeleted={() => navigate({ section: 'overview', id: undefined })}
          />
        )
      // 概览从首页侧栏的「概览」那一行进；什么都没选时是「新会话」页
      if (homeSel?.kind === 'overview') return <OverviewView />
      return <NewChatView state={state} onOpen={(channel) => navigate({ section: 'overview', id: homeId({ kind: 'channel', channel }) })} />
    }
    // 审计日志看全部工作区，不要求工作区
    if (section === 'audit') return <AuditView state={state} />
    // 工具试用台以某个 AI 的身份调用，不要求工作区（AI 自己有能访问的工作区）
    if (section === 'playground') return <PlaygroundMain state={state} toolName={id} />
    if (section === 'team') {
      if (teamSel?.kind === 'new-agent') return <NewAgent state={state} onCreated={(agentId) => toTeam(agentId)} />
      if (teamSel?.kind === 'new-role')
        return <RoleEditor key="new" state={state} onSaved={(roleId) => toTeam(`role:${roleId}`)} onRemoved={() => toTeam(undefined)} />
      if (teamAgent) return <AgentDetail state={state} agent={teamAgent} onRemoved={() => toTeam(undefined)} />
      if (teamRole) return <RoleEditor state={state} role={teamRole} onSaved={() => {}} onRemoved={() => toTeam(undefined)} />
      return <TeamEmpty />
    }
    // 对话页不要求工作区：内置 AI 的列表、新建引导都能看
    if (section === 'chat') return <ChatMain state={state} agentId={id} />
    // 群聊是全局的，不要求工作区
    if (section === 'group') return <GroupMain state={state} channel={resolveChannel(state, id)} />
    // AI 命令是全局的（命令池按 AI 分，不按工作区），不要求工作区
    if (section === 'commands') return <CommandDetail item={aiCommands.list.find((c) => c.command_id === id)} />
    // 技能页不要求工作区：没有工作区时也能看和建用户级技能。换工作区（当前工作区，或技能页单独选的工作区）时重新挂载，不留上个工作区的项目技能内容
    if (section === 'skills') {
      if (id)
        return (
          <SkillMain
            key={`${state.activeWorkspaceId ?? ''}|${skillWs ?? ''}|${id}`}
            state={state}
            skills={skills}
            id={id}
            workspaceId={skillWs}
            onSelect={(s) => navigate({ section: 'skills', id: s })}
            onChanged={() => void reloadSkills()}
          />
        )
      return <SkillsHome state={state} skills={skills} loading={skillsLoading} error={skillsError} viewing={skillWs} />
    }
    // 改动页按当前工作区看检查点；没有工作区时它自己显示提示
    if (section === 'changes') return <ChangesMain key={state.activeWorkspaceId ?? ''} state={state} selected={id} />
    // 定时任务按工作区分列表，但页面本身不要求有工作区（没有工作区时只显示不属于任何工作区的任务）
    if (section === 'schedules') return <ScheduleMain state={state} id={id} onSelect={(s) => navigate({ section: 'schedules', id: s })} />
    // 任务页在没有目录工作区时也能用：看的是「整台电脑」的任务板
    if (editorSection || (!hasWs && !(section === 'tasks' && taskWs))) return <Welcome state={state} onNewAgent={newAgent} />
    if (task) return <TaskDetail state={state} task={task} workspaceId={taskWs} onDeleted={() => navigate({ section: 'tasks', id: undefined })} />
    // 任务分区没选中具体任务：看板
    if (section === 'tasks') return <TaskBoard state={state} tasks={shownTasks} workspaceId={taskWs} />
    if (section === 'memory' && (id === 'new' || memory))
      return (
        <MemoryEditor
          key={id}
          state={state}
          memory={memory}
          onSaved={(m) => navigate({ section: 'memory', id: m })}
          onDeleted={() => navigate({ section: 'memory', id: undefined })}
        />
      )
    return <Welcome state={state} onNewAgent={newAgent} />
  })()

  const sideMax = () => window.innerWidth - ACTIVITY_BAR - MIN_MAIN - (activityOpen ? activityWidth : 0)
  const activityMax = () => window.innerWidth - ACTIVITY_BAR - MIN_MAIN - (sideShown ? sideWidth : 0)
  const panelMax = () => (columnRef.current?.clientHeight ?? window.innerHeight) - 120

  // 窗口缩小后按当前宽度压缩显示宽度（先压侧栏到 170，再压活动面板到 260），主区不被挤没；
  // 只影响显示，不改保存的宽度，窗口放大后自动恢复
  const room = Math.max(0, winWidth - ACTIVITY_BAR - MIN_MAIN)
  const wantSide = sideShown ? sideWidth : 0
  const wantActivity = activityOpen ? activityWidth : 0
  const over = Math.max(0, wantSide + wantActivity - room)
  const sideCut = sideShown ? Math.min(over, Math.max(0, sideWidth - 170)) : 0
  const activityCut = activityOpen ? Math.min(over - sideCut, Math.max(0, activityWidth - 260)) : 0
  const sideShownWidth = sideWidth - sideCut
  const activityShownWidth = activityWidth - activityCut

  // ========== 手机版的外壳 ==========
  if (inPhoneShell) {
    const tab = phoneTab(section, phoneView)
    const totals = chatTotals(state)
    // 任务页点进去要有任务才有内容；没有（刚删掉）就回到列表
    const detail = phoneView === 'main' && phoneDetail && !(section === 'tasks' && !task)
    const label = (s: Section): string => (s === 'settings' ? '设置' : splitLabel(NAV.find((n) => n.id === s)?.label ?? s).text)
    const title = phoneView === 'activity' ? '活动' : phoneView === 'more' ? '更多' : phoneView === 'panel' ? '变更和任务' : section === 'overview' ? '' : label(section)
    const back = phoneView === 'panel' || detail
    const tabs: { id: typeof tab; text: string; icon: typeof Home; n?: number; tone?: 'bad' | 'accent' }[] = [
      { id: 'chats', text: '会话', icon: Home, n: totals.unread, tone: totals.mentions ? 'bad' : 'accent' },
      { id: 'tasks', text: '任务', icon: ListTodo, n: reviewCount },
      { id: 'activity', text: '活动', icon: Activity },
      { id: 'more', text: '更多', icon: Ellipsis }
    ]
    return (
      <div data-phone-shell={detail ? 'detail' : phoneView} className="flex flex-col bg-shell" style={{ height: '100dvh' }}>
        <header className="flex h-12 shrink-0 items-center gap-2 px-3">
          {back ? (
            <button
              data-phone-back-button
              aria-label="返回"
              onClick={() => (phoneView === 'panel' ? setPhoneView('main') : setPhoneDetail(false))}
              className="-ml-1.5 flex h-10 cursor-pointer items-center gap-0.5 rounded-lg pr-2.5 pl-1 text-[15px] text-muted active:bg-hover"
            >
              <ChevronLeft size={20} /> 返回
            </button>
          ) : title ? (
            <span className="truncate text-[17px] font-semibold">{title}</span>
          ) : (
            <div className="min-w-0 overflow-hidden">
              <WorkspaceSwitcher state={state} />
            </div>
          )}
          <span className="min-w-0 flex-1" />
          {detail && section === 'overview' && homeChannel && (
            <button data-phone-panel onClick={() => setPhoneView('panel')} className="flex h-8 shrink-0 cursor-pointer items-center rounded-full border border-line px-3 text-[12.5px] text-muted active:bg-hover">
              变更 · 任务
            </button>
          )}
          {!back && (
            <span data-phone-online className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-line px-2.5 text-[12px] whitespace-nowrap text-muted">
              <span className={cx('h-1.5 w-1.5 rounded-full', state.running ? (state.paused ? 'bg-warn' : 'bg-ok') : 'bg-bad')} />
              {state.running ? `${state.presence.length} / ${state.agents.length} 在线` : '服务未运行'}
            </span>
          )}
          {/* 「全部停下」哪一页都在：手机上最要紧的就是它 */}
          <button
            data-phone-stop
            onClick={() => void (state.paused ? window.bridge.setPaused(false) : window.bridge.stopAll())}
            className={cx('flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium whitespace-nowrap', state.paused ? 'bg-ok/15 text-ok' : 'border border-line text-bad')}
          >
            {state.paused ? <Play size={12} /> : <Pause size={12} />}
            {state.paused ? '恢复 AI' : '全部停下'}
          </button>
        </header>
        {state.paused && <div className="mx-2 mb-2 shrink-0 rounded-lg border border-warn/30 bg-warn/10 px-3 py-1.5 text-xs text-warn">已暂停：所有 AI 的新工具调用都会被拒绝，直到你点「恢复 AI」。</div>}
        <div className="min-h-0 flex-1 overflow-hidden rounded-t-2xl border-t border-line bg-canvas">
          {phoneView === 'activity' && <ActivityPanel bare state={state} events={events} channel={panelCh} onOpenFile={openFromEvent} onClose={() => undefined} />}
          {phoneView === 'panel' && (
            <RightPanel
              state={state}
              events={events}
              workspaceId={panelWs}
              channel={panelCh}
              tasks={panelWs ? (tasksByWs[panelWs] ?? []) : []}
              onOpenFile={openFromEvent}
              onClose={() => setPhoneView('main')}
              onFiles={() => undefined}
            />
          )}
          {phoneView === 'more' && (
            <div data-phone-more className="h-full overflow-auto px-2 py-2">
              {PHONE_MORE.map((s) => {
                const Icon = s === 'settings' ? Settings : (NAV.find((n) => n.id === s)?.icon ?? Folder)
                const adapted = isPhoneSection(s)
                return (
                  <button
                    key={s}
                    data-phone-more-item={s}
                    onClick={() => phoneGo(s)}
                    className={cx('flex h-12 w-full cursor-pointer items-center gap-3 rounded-xl px-3 text-left text-[15px] active:bg-hover', adapted ? 'text-fg' : 'text-muted')}
                  >
                    <Icon size={18} strokeWidth={1.7} className="shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate">{label(s)}</span>
                    {!adapted && <span className="shrink-0 rounded border border-warn/40 px-1.5 text-[10.5px] text-warn">电脑版样子</span>}
                  </button>
                )
              })}
              <div className="my-2 border-t border-line-soft" />
              <button data-phone-desktop onClick={() => setPhoneOverride('0')} className="flex h-12 w-full cursor-pointer items-center gap-3 rounded-xl px-3 text-left text-[15px] text-muted active:bg-hover">
                <PanelLeft size={18} strokeWidth={1.7} className="shrink-0" />
                整个界面都用电脑版样子
              </button>
              <div className="px-3 pt-2 text-[12px] leading-relaxed text-faint">标了「电脑版样子」的页面还没按手机排，点进去和电脑上一样，要放大看。终端和内置浏览器手机上用不了。</div>
            </div>
          )}
          {phoneView === 'main' && (detail ? <div data-phone-detail className="h-full overflow-hidden">{main}</div> : <div data-phone-list className="h-full overflow-hidden bg-panel">{otherSide}</div>)}
        </div>
        {!back && (
          <nav aria-label="页面" data-phone-tabs className="flex shrink-0 border-t border-line bg-shell" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
            {tabs.map(({ id: t, text, icon: Icon, n, tone }) => (
              <button
                key={t}
                data-phone-tab={t}
                aria-current={tab === t ? 'page' : undefined}
                onClick={() => phoneGo(t === 'chats' ? 'overview' : t === 'tasks' ? 'tasks' : t)}
                className={cx('relative flex h-[58px] flex-1 cursor-pointer flex-col items-center justify-center gap-1 text-[11px]', tab === t ? 'text-fg' : 'text-muted')}
              >
                <span className={cx('relative flex h-7 w-12 items-center justify-center rounded-full', tab === t && 'bg-hover')}>
                  <Icon size={19} strokeWidth={1.7} />
                  {!!n && n > 0 && <CountBadge n={n} tone={tone} />}
                </span>
                {text}
              </button>
            ))}
          </nav>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-shell">
      {/* 顶栏：左边是侧栏开关和工作区，右边是状态（原来在最下面的状态栏里）、布局开关、全部停下 */}
      <header className="app-titlebar flex h-11 shrink-0 items-center gap-2 pl-2.5">
        <LayoutToggle title={sideOpen ? '收起侧栏（Ctrl+B）' : '展开侧栏（Ctrl+B）'} on={sideShown} onClick={() => setSideOpen((v) => !v)}>
          <PanelLeft size={16} />
        </LayoutToggle>
        <WorkspaceSwitcher state={state} />
        {/* 这一段空白是拖动窗口的地方（系统标题栏去掉了） */}
        <div data-drag-area className="h-full min-w-10 flex-1" />
        <div data-status-pills className="app-no-drag flex min-w-0 items-center justify-end gap-1.5 overflow-hidden text-[11px] whitespace-nowrap text-muted">
          {running.length > 0 && (
            <span className="flex min-w-0 items-center gap-1 text-accent">
              <Loader2 size={10} className="shrink-0 animate-spin" />
              <span className="max-w-[260px] truncate">{running.map((e) => `${e.agentName} 正在${toolLabel(e.tool)}`).join('，')}</span>
            </span>
          )}
          {runningChats.length > 0 && (
            <button
              className="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-full border border-line px-2 text-accent hover:bg-hover"
              onClick={() => navigate(runningChats.length === 1 ? { section: 'chat', id: runningChats[0] } : { section: 'chat' })}
            >
              <Loader2 size={10} className="animate-spin" />
              {runningChats.length} 个内置 AI 运行中
            </button>
          )}
          {reviewCount > 0 && (
            <button
              className="flex h-6 shrink-0 cursor-pointer items-center rounded-full border border-line px-2 text-warn hover:bg-hover"
              onClick={() => {
                // 待审查的都在「整台电脑」的任务板上时，直接切过去
                const next: TaskScope = activeReview > 0 ? 'active' : 'machine'
                if (next === taskScope) return navigate({ section: 'tasks' })
                setTaskScope(next)
                navigate({ section: 'tasks', id: undefined })
              }}
            >
              {reviewCount} 个任务待审查
            </button>
          )}
          {remoteView.state !== 'off' && (
            <button
              className={cx(
                'flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-full border border-line px-2 hover:bg-hover',
                remoteView.state === 'on' ? 'text-ok' : remoteView.state === 'error' ? 'text-bad' : 'text-warn'
              )}
              title="远端查看开着：有链接的人能在浏览器里操作这个工作台。点这里去设置里看链接或关掉"
              onClick={() => navigate({ section: 'settings' })}
            >
              <Smartphone size={11} />
              {REMOTE_VIEW_LABEL[remoteView.state]}
              {remoteView.visits > 0 && ` · 打开过 ${remoteView.visits} 次`}
            </button>
          )}
          {state.lanEnabled && (
            <span className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-line px-2 text-accent" title={state.urls.lan.join('\n') || '局域网已开启'}>
              <Wifi size={11} />
              局域网
            </span>
          )}
          {state.tunnel.status === 'running' && (
            <span className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-line px-2 text-ok" title={state.urls.public ?? state.tunnel.url ?? '公网隧道运行中'}>
              <Globe size={11} />
              公网
            </span>
          )}
          <span
            className="flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-line px-2"
            title={state.running ? `MCP 服务地址：${state.mcpUrl}` : (state.error ?? '服务未运行')}
          >
            <span className={cx('h-1.5 w-1.5 rounded-full', state.running ? (state.paused ? 'bg-warn' : 'bg-ok') : 'bg-bad')} />
            {state.running ? `${state.presence.length} / ${state.agents.length} 个 AI 在线` : (state.error ?? '服务未运行')}
          </span>
        </div>
        <div className="app-no-drag flex shrink-0 items-center gap-2">
          <div className="flex items-center -space-x-1">
            {state.agents
              .filter((a) => state.presence.some((p) => p.agentId === a.id))
              .map((a) => (
                <Avatar key={a.id} name={a.name} color={a.color} size={22} active={running.some((e) => e.agentId === a.id)} />
              ))}
          </div>
          <div className="flex items-center">
            <LayoutToggle title={panelOpen ? '收起终端（Ctrl+`）' : '打开终端（Ctrl+`）'} on={panelOpen} onClick={() => setPanelOpen((v) => !v)}>
              <PanelBottom size={15} />
            </LayoutToggle>
            <LayoutToggle title={activityOpen ? '收起右栏' : '展开右栏（变更、任务、活动）'} on={activityOpen} onClick={() => setActivityOpen((v) => !v)}>
              <PanelRight size={15} />
            </LayoutToggle>
          </div>
          <button
            // 「全部停下」= 暂停 + 取消正在跑的命令；恢复只解除暂停
            onClick={() => void (state.paused ? window.bridge.setPaused(false) : window.bridge.stopAll())}
            title={state.paused ? '恢复后 AI 可以继续调用工具' : '立刻让所有 AI 的工具调用返回「已暂停」，取消正在跑的命令'}
            className={cx(
              'flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-medium',
              state.paused ? 'bg-ok/15 text-ok hover:bg-ok/25' : 'border border-line text-bad hover:border-bad/50 hover:bg-bad/10'
            )}
          >
            {state.paused ? <Play size={12} /> : <Pause size={12} />}
            {state.paused ? '恢复 AI' : '全部停下'}
          </button>
        </div>
      </header>
      {state.paused && (
        <div className="mx-2 mb-2 shrink-0 rounded-lg border border-warn/30 bg-warn/10 px-3 py-1.5 text-xs text-warn">
          已暂停：所有 AI 的新工具调用都会被拒绝（读命令输出、取消命令除外），直到你点「恢复 AI」。
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 图标栏：干活用的页面都在这里（首页、任务、定时任务，一条线，然后是对话、文件、搜索、改动、AI 命令）；管理和配置用的在左下角的齿轮里 */}
        <nav aria-label="页面" onMouseOver={(e) => showRailTip(e.target)} onMouseLeave={hideRailTip} onMouseDown={hideRailTip} className="flex w-14 shrink-0 flex-col items-center gap-1.5 pt-0.5 pb-3">
          {railSections(section).map((s) => {
            const item = NAV.find((n) => n.id === s)
            if (!item) return null
            const Icon = item.icon
            return (
              <Fragment key={s}>
                <button data-tip={item.label} aria-label={item.label} aria-current={section === s ? 'page' : undefined} onClick={() => clickNav(s)} className={railButton(section === s)}>
                  <Icon size={19} strokeWidth={1.7} />
                  {/* 会话都在首页里，所以群聊的未读挂在首页上：有 @ 你的消息时红色，只有普通未读时蓝色 */}
                  {s === 'overview' && <CountBadge n={chatTotals(state).unread} tone={chatTotals(state).mentions ? 'bad' : 'accent'} />}
                  {s === 'chat' && <CountBadge n={runningChats.length} tone="accent" />}
                  {s === 'group' && <CountBadge n={chatTotals(state).unread} tone={chatTotals(state).mentions ? 'bad' : 'accent'} />}
                  {s === 'commands' && <CountBadge n={aiCommands.running} tone="accent" />}
                  {s === 'tasks' && <CountBadge n={reviewCount} />}
                </button>
                {s === RAIL_DIVIDER_AFTER && <span data-rail-divider className="my-0.5 h-px w-5 shrink-0 bg-line" />}
              </Fragment>
            )
          })}
          <div className="flex-1" />
          <button
            data-tip={remoteView.state === 'off' ? '远端查看：用手机 / 平板打开这个工作台（现在关着）' : `远端查看：${REMOTE_VIEW_LABEL[remoteView.state]}`}
            aria-label="远端查看"
            aria-haspopup="dialog"
            aria-expanded={remoteOpen}
            data-remote-button={remoteView.state}
            onClick={() => {
              setGearOpen(false)
              setRemoteOpen((v) => !v)
            }}
            className={railButton(remoteOpen)}
          >
            <Smartphone size={19} strokeWidth={1.7} />
            {remoteView.state !== 'off' && (
              <span className={cx('absolute top-1.5 right-1.5 h-2 w-2 rounded-full border border-shell', remoteView.state === 'on' ? 'bg-ok' : remoteView.state === 'error' ? 'bg-bad' : 'bg-warn')} />
            )}
          </button>
          <button
            data-tip="设置和管理"
            aria-label="设置"
            aria-haspopup="menu"
            aria-expanded={gearOpen}
            aria-current={isSettingsSection(section) ? 'page' : undefined}
            onClick={() => {
              setRemoteOpen(false)
              setGearOpen((v) => !v)
            }}
            className={railButton(gearOpen || isSettingsSection(section))}
          >
            <Settings size={19} strokeWidth={1.7} />
          </button>
        </nav>
        {railTip && !gearOpen && !remoteOpen && (
          <div role="tooltip" data-rail-tip style={{ left: 60, top: railTip.top }} className="pointer-events-none fixed z-[60] -translate-y-1/2 rounded-md border border-line bg-raised px-2 py-1 text-xs whitespace-nowrap text-fg shadow-lg">
            {railTip.text}
          </div>
        )}
        {remoteOpen && (
          <>
            <div className="fixed inset-0 z-40" onMouseDown={() => setRemoteOpen(false)} />
            <div
              role="dialog"
              aria-label="远端查看"
              data-remote-popover
              style={{ left: 58, bottom: 10, width: 'min(480px, calc(100vw - 70px))', maxHeight: 'calc(100vh - 64px)' }}
              className="fixed z-50 overflow-auto rounded-xl border border-line bg-raised shadow-2xl"
            >
              <RemoteViewCard className="border-0 bg-transparent" />
            </div>
          </>
        )}
        {gearOpen && (
          <>
            <div className="fixed inset-0 z-40" onMouseDown={() => setGearOpen(false)} />
            {/* 照 Codex：齿轮点开是一个贴着左下角的小菜单，设置在最上面，下面是管理和配置用的页面 */}
            <div role="menu" aria-label="设置和管理" data-gear-menu style={{ left: 58, bottom: 10 }} className="fixed z-50 w-60 rounded-xl border border-line bg-raised py-1.5 shadow-2xl">
              <div className="px-3 pt-1 pb-1.5 text-[12px] text-muted">设置和管理</div>
              {SETTINGS_GROUPS.map((group, gi) => (
                <div key={gi} className="border-t border-line-soft py-1">
                  {group.map((s) => {
                    const item = s === 'settings' ? { label: '设置', icon: Settings } : NAV.find((n) => n.id === s)
                    if (!item) return null
                    const Icon = item.icon
                    const { text, hint } = splitLabel(item.label)
                    return (
                      <button
                        key={s}
                        role="menuitem"
                        data-section={s}
                        onClick={() => {
                          setGearOpen(false)
                          navigate({ section: s })
                          if (s !== 'settings') setSideOpen(true)
                        }}
                        className={cx('flex h-8 w-full cursor-pointer items-center gap-2.5 px-3 text-left text-[13px] hover:bg-hover', section === s ? 'text-fg' : 'text-muted hover:text-fg')}
                      >
                        <Icon size={16} strokeWidth={1.7} className="shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{text}</span>
                        {hint && <span className="text-[11px] text-faint">{hint}</span>}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </>
        )}

        {/* 侧栏、主区、实时活动装在一张圆角的卡片里（照 Codex），和图标栏、窗口边缘之间留一点空 */}
        <div className="mr-2 mb-2 flex min-w-0 flex-1 overflow-hidden rounded-xl border border-line bg-canvas">
        {/* 侧栏：收起时不卸载 */}
        <aside style={{ width: sideShownWidth }} className={cx('shrink-0 overflow-hidden border-r border-line bg-panel', !sideShown && 'hidden')}>
          <div className={cx('h-full', section !== 'files' && section !== 'settings' && section !== 'audit' && 'hidden')}>
            <ExplorerPanel state={state} events={events} />
          </div>
          <div ref={searchRef} className={cx('h-full', section !== 'search' && 'hidden')}>
            <SearchPanel state={state} />
          </div>
          {otherSide}
        </aside>
        {sideShown && <Splitter axis="x" value={sideWidth} min={170} max={sideMax} defaultValue={SIDE_DEFAULT} onChange={setSideWidth} />}

        {/* 主区 + 底部终端面板 */}
        <div ref={columnRef} className="flex min-w-0 flex-1 flex-col">
          <main className="relative min-h-0 flex-1 overflow-hidden bg-canvas">
            {/* 编辑区一直挂着（有工作区时）：切到别的分区再回来，标签页、光标、滚动位置都还在 */}
            {hasWs && (
              <div className={cx('absolute inset-0', !editorSection && 'hidden')}>
                <EditorArea state={state} events={events} />
              </div>
            )}
            {/* 画布页去过一次以后一直挂着，切到别的页只是藏起来：小窗里的网页不重载，没保存的字、终端都还在。
                用 invisible 不用 hidden：<webview> 不能 display:none，而且藏着时大小不变，镜头和排版不会算错 */}
            {canvasKept && (
              <div data-canvas-keep className={cx('absolute inset-0 overflow-hidden', section !== 'canvas' && 'pointer-events-none invisible')}>
                <CanvasView state={state} events={events} tasksByWs={tasksByWs} hidden={section !== 'canvas'} />
              </div>
            )}
            {/* 对话页自己管滚动（消息区滚、输入框固定），外面不能再套 overflow-auto */}
            {(!editorSection || !hasWs) && section !== 'canvas' && <div className={cx('absolute inset-0', section === 'chat' || section === 'group' || homeChannel ? 'overflow-hidden' : 'overflow-auto')}>{main}</div>}
          </main>
          {panelOpen && <Splitter axis="y" invert value={panelHeight} min={100} max={panelMax} defaultValue={PANEL_DEFAULT} onChange={setPanelHeight} />}
          <section style={{ height: panelHeight, maxHeight: '80%' }} className={cx('shrink-0 border-t border-line bg-canvas', !panelOpen && 'hidden')}>
            <TerminalPanel state={state} visible={panelOpen} onHide={() => setPanelOpen(false)} />
          </section>
        </div>

        {/* 右栏：变更 / 任务 / 活动 */}
        {(activityOpen || keepPanel) && (
          <>
            {activityOpen && <Splitter axis="x" invert value={activityWidth} min={260} max={activityMax} defaultValue={ACTIVITY_DEFAULT} onChange={setActivityWidth} />}
            {/* 收起但里面有网页标签：宽度收成 0、藏起来，不卸载 */}
            <aside
              key="right-panel"
              data-right-collapsed={activityOpen ? undefined : ''}
              style={{ width: activityOpen ? activityShownWidth : 0 }}
              className={cx('shrink-0 overflow-hidden bg-panel', activityOpen ? 'border-l border-line' : 'invisible')}
            >
              <RightPanel
                state={state}
                events={events}
                workspaceId={panelWs}
                channel={panelCh}
                tasks={panelWs ? (tasksByWs[panelWs] ?? []) : []}
                onOpenFile={openFromEvent}
                onClose={() => setActivityOpen(false)}
                onFiles={() => {
                  setQuickRight(true)
                  setQuickOpen(true)
                }}
              />
            </aside>
          </>
        )}
      </div>
      </div>

      {/* Ctrl+P 快速打开 */}
      {/* 手机上看电脑版样子的页面：整页是按电脑宽度画再缩小的，所以这个按钮要做得很大才点得到 */}
      {(phone || phoneEnv.capable) && (
        <button
          data-phone-return
          onClick={() => (phone ? phoneGo('more') : setPhoneOverride(null))}
          className="fixed bottom-8 left-1/2 z-[70] flex h-[88px] -translate-x-1/2 cursor-pointer items-center gap-2 rounded-full bg-accent px-12 text-[32px] font-semibold whitespace-nowrap text-[#0d1117] shadow-2xl"
        >
          <ChevronLeft size={36} /> {phone ? '回手机版' : '用手机版'}
        </button>
      )}
      {/* 在「文件」「搜索」页按 Ctrl+P：开在那一页的编辑器里（和以前一样）；在别的页：开在右栏，不离开正在看的页。手机上没有并排的右栏，一律开在编辑器里 */}
      <QuickOpen
        state={state}
        open={quickOpen}
        target={quickRight || (!editorSection && !phone) ? 'right' : 'editor'}
        onClose={() => {
          setQuickOpen(false)
          setQuickRight(false)
        }}
      />
      <CommandPalette open={paletteOpen} items={paletteItems} onClose={() => setPaletteOpen(false)} />

      {/* 网页 AI 的 OAuth 授权请求（只在认证方式选了 OAuth 时有）：盖在整个应用上方，只能手动批准或拒绝 */}
      <OAuthApproval state={state} />
      {/* 加工作区时选哪些 AI 能用；设置页的工作区行上也能打开 */}
      <WorkspaceMembersDialog state={state} />
    </div>
  )
}
