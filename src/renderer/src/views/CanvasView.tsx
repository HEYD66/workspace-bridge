// 画布页：所有项目和里面的 AI 画在一张可以拖动、缩放的图上。
// 数据拼装和摆放在 lib/canvasBoard.ts（纯计算），记住的位置和侧栏共用的状态在 lib/canvasStore.ts。
// 画布底座是自己写的（不用画布库），做法学自 Cate：平移缩放只改一层的 transform，不让 React 重画。
import { AppWindow, Archive, ArchiveRestore, CheckCheck, Columns3, Crown, ListPlus, StickyNote, UserPlus, Eye, EyeOff, FolderGit2, HelpCircle, LayoutGrid, Locate, Map as MapIcon, Maximize, MessageSquare, Minus, Plus, Search, Undo2, User, UsersRound, X } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { ActivityEvent, BridgeState, TaskItem, TaskStatus } from '../../../core/types'
import { findNodeInDirection, type Direction } from '../../../shared/canvas/geometry'
import { panelConnectionCurve, panelConnectionCurvePath } from '../../../shared/canvas/connections'
import { isMouseWheel } from '../../../shared/canvas/wheelIntent'
import { planJoinTeam } from '../../../shared/canvasActions'
import { CANVAS_ALL, emptyCanvasDoc, type CanvasNote, type CanvasRelay, type CanvasWidget, type CanvasWidgetKind } from '../../../shared/canvasDoc'
import { buildCanvasModel, CANVAS_USER_ID, type CanvasAttention, type CanvasCardState } from '../../../shared/canvasModel'
import { useContextMenu, type MenuEntry } from '../components/ContextMenu'
import { Avatar, cx } from '../components/ui'
import { agentOfKey, buildBoard, CARD_H, CARD_W, cardKey, frameKey, layoutBoard, tidyGroup, type Board, type BoardCard, type BoardGroup, type BoardLayout, type BoardLine, type Box, type XY } from '../lib/canvasBoard'
import { blankMenu, cardMenu, frameMenu, hitOf, lineMenu, noteMenu, openTaskMenu, widgetMenu, type CanvasHit, type FrameMenuActions, type FrameMenuInfo } from '../lib/canvasMenu'
import { canvasOp, focusOnCanvas, forgetPositions, getCanvasSaved, matchesQuery, patchPositions, replacePositions, saveCamera, setCanvasFlag, setCanvasQuery, setCanvasSelected, useCanvasSaved, useCanvasUi, type Camera } from '../lib/canvasStore'
import { errText, STATUS_META, timeAgo, toolLabel } from '../lib/format'
import { appendToDraft, LOBBY, mentionText, sendGroupChat, setDraft } from '../lib/groupChat'
import { openFile } from '../lib/editorStore'
import { describeMemberStatus } from '../lib/memberStatus'
import { navigate } from '../lib/nav'
import { homeId } from '../lib/projects'
import { AgentChanges } from './canvas/AgentChanges'
import { type AgentKind, useAgentKinds } from './canvas/agentKinds'
import { AssignDialog } from './canvas/AssignDialog'
import { BoardLanes } from './canvas/BoardLanes'
import { NewAgentDialog } from './canvas/NewAgentDialog'
import { WidgetCard } from './canvas/WidgetCard'
import { NoteCard } from './canvas/NoteCard'
import { TeamMenu } from './canvas/TeamMenu'
import { CanvasComposer } from './canvas/CanvasComposer'

interface Props {
  state: BridgeState
  events: ActivityEvent[]
  tasksByWs: Record<string, TaskItem[]>
  /** 画布页现在藏着（用户在看别的页）：页面不卸，小窗里的网页和没保存的字都留着；镜头跟随先停 */
  hidden?: boolean
}

const ZOOM_MIN = 0.2
const ZOOM_MAX = 2
/** 鼠标按下到松开挪了不到这么多像素算点击，不算拖动 */
const CLICK_SLACK = 4
const MAP_W = 184
const MAP_H = 116
/** 右边详情面板占的宽度（面板本身加两边的空）；飞到某张卡片时把它让出来 */
const PANEL_INSET = 312
const NOTE_W = 200
const NOTE_H = 132
/** 小窗（终端、网页、文件）一开始多大、最小最大能拉到多大 */
const WIDGET_SIZE: Record<CanvasWidgetKind, { w: number; h: number }> = { terminal: { w: 560, h: 340 }, web: { w: 640, h: 440 }, file: { w: 480, h: 360 } }
const WIDGET_MIN = { w: 260, h: 160 }
const WIDGET_MAX = { w: 1600, h: 1200 }
const WIDGET_KIND: Record<CanvasWidgetKind, string> = { terminal: '终端', web: '网页', file: '文件' }
/** 卡片、空框以外的东西（便签）一开始摆在旁边时，一张比一张错开这么多 */
const STAGGER = 18
const headBtn = 'inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-faint hover:bg-hover hover:text-fg group-data-[lod=far]/cv:hidden'
const LINK_HANDLE = 'absolute top-1/2 -right-2.5 z-[1] flex h-5 w-5 -translate-y-1/2 cursor-crosshair items-center justify-center rounded-full border border-line bg-panel text-faint opacity-0 transition-opacity hover:border-accent hover:text-accent [[data-cv-card]:hover_&]:opacity-100 [[data-selected]_&]:opacity-100 group-data-[lod=far]/cv:hidden'
const LINK_TITLE = '按住拖出一条线。拖到另一个 AI 上：派一件活给它，或者连一条接力线；拖到别的项目的框上：把它加进那个项目的分工'

/** 拉线之后要弹的「派活 / 接力」：在哪个项目、从谁到谁、是不是一条已有的任务 */
interface AssignReq {
  ws: string
  fromId: string
  toId: string
  taskRef?: string
}

export const CARD_STATE: Record<CanvasCardState, { label: string; color: string }> = {
  working: { label: '工作中', color: '#58a6ff' },
  waiting: { label: '等消息', color: '#3fb950' },
  idle: { label: '空闲', color: '#8b949e' },
  stuck: { label: '可能卡住', color: '#d29922' },
  offline: { label: '离线', color: '#484f58' },
  paused: { label: '已暂停', color: '#db6d28' }
}

const LINE_COLOR: Record<TaskStatus, string> = { blocked: '#f85149', review: '#d29922', in_progress: '#58a6ff', todo: '#8b949e', done: '#3fb950' }
const TEAM_LINE = '#5a5a5a'
const RELAY_LINE = '#a371f7'
/** 等用户处理的三种事，各怎么说 */
const ATTENTION: Record<CanvasAttention['kind'], string> = { question: '有问题等你回答', review: '交上来等你验收', delivered: '做完了，等你看一眼' }
/** 框的颜色，按项目顺序轮着用 */
const FRAME_HUES = ['#58a6ff', '#a371f7', '#3fb950', '#db6d28', '#d29922', '#f778ba', '#39c5cf']
const GROUP_KIND: Record<BoardGroup['kind'], string> = { team: '分工明确', brainstorm: '灵感激荡', lobby: '还没进项目' }

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

const hits = (a: Box, b: Box, gap = 0): boolean => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap

/** 想放在 want 这儿；被别的东西占了，就一圈一圈往外找最近的空地方（找不到就还放在 want） */
function freeSpot(want: XY, size: { w: number; h: number }, taken: readonly Box[], gap = 12): XY {
  const free = (p: XY): boolean => !taken.some((t) => hits({ x: p.x, y: p.y, w: size.w, h: size.h }, t, gap))
  if (free(want)) return want
  const step = 40
  for (let r = 1; r <= 30; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const p = { x: want.x + dx * step, y: want.y + dy * step }
        if (free(p)) return p
      }
    }
  }
  return want
}

function unionBox(boxes: (Box | null | undefined)[]): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const b of boxes) {
    if (!b) continue
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.w)
    y1 = Math.max(y1, b.y + b.h)
  }
  return x1 >= x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
}

export function useBoard({ state, events, tasksByWs }: Props, hideOffline: boolean): Board {
  const { docs } = useCanvasSaved()
  const now = useNow()
  const archived = docs[CANVAS_ALL]?.archived
  return useMemo(
    () => buildBoard({ agents: state.agents, roles: state.roles, memberStatus: state.memberStatus, workspaces: state.workspaces, channels: state.chat?.channels, tasksByWs, events, hideOffline, docs, now, archived }),
    [state.agents, state.roles, state.memberStatus, state.workspaces, state.chat?.channels, tasksByWs, events, hideOffline, docs, now, archived]
  )
}

/** 画布上存的东西改不成时，用一句话告诉用户 */
function tell(e: unknown): void {
  window.alert(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
}

const act = (id: string, ops: Parameters<typeof canvasOp>[1]): void => void canvasOp(id, ops).catch(tell)

/** 叫停一个 AI：先取消它名下还在跑的命令，再断开它的连接（和卡片面板里的「叫停」做的是同一件事，见 canvas/AgentChanges.tsx） */
async function stopAgent(agentId: string): Promise<string> {
  const cmds = await window.bridge.listAiCommands()
  const mine = cmds.commands.filter((c) => c.owner === agentId && c.status === 'running')
  for (const c of mine) await window.bridge.cancelAiCommand(c.command_id).catch(() => {})
  const n = await window.bridge.disconnectAgent(agentId)
  return `断开了 ${n} 条连接${mine.length ? `，取消了 ${mine.length} 条在跑的命令` : ''}。它的身份还在，它那边重新连接就能回来`
}

/** 每半分钟动一下，让「已经 3 分钟」这类字自己往前走 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  return now
}

// ========== 跳到别的页面 ==========

/** 打开这张卡片所在项目的群聊，输入框里先 @ 上它；不在项目里的去大厅私聊 */
function openChat(card: BoardCard, board: Board): void {
  if (card.kind === 'user') return
  const group = board.groups.find((g) => g.id === card.groupId)
  if (group?.channel) {
    appendToDraft(group.channel, `@${card.name} `)
    navigate({ section: 'overview', id: homeId({ kind: 'channel', channel: group.channel }) })
  } else {
    setDraft(LOBBY, { to: card.id })
    navigate({ section: 'overview', id: homeId({ kind: 'channel', channel: LOBBY }) })
  }
  requestAnimationFrame(() => document.getElementById('group-composer')?.focus())
}

function openTask(tasksByWs: Record<string, TaskItem[]>, workspaceId: string, ref: string): void {
  const task = (tasksByWs[workspaceId] ?? []).find((t) => t.ref === ref)
  if (task) navigate({ section: 'overview', id: homeId({ kind: 'task', workspaceId, taskId: task.id }) })
  else navigate({ section: 'tasks' })
}

// ========== 卡片 ==========

interface CardViewProps {
  card: BoardCard
  x: number
  y: number
  selected: boolean
  dim: boolean
  statusLine: string
  statusTitle?: string
  /** 背后是哪种 AI（模型名，或者客户端的名字） */
  kind?: AgentKind
  now: number
  onChat: (card: BoardCard) => void
}

const CardView = memo(function CardView({ card, x, y, selected, dim, statusLine, statusTitle, kind, now, onChat }: CardViewProps) {
  const meta = CARD_STATE[card.state]
  const style: CSSProperties = { left: x, top: y, width: CARD_W, height: CARD_H }
  const waiting = card.attention.length
  const work = card.tasks[0]
  return (
    <div
      data-cv-card={card.key}
      data-state={card.state}
      data-attention={waiting || undefined}
      data-selected={selected || undefined}
      style={style}
      className={cx(
        'absolute flex cursor-pointer flex-col rounded-xl border bg-raised px-3 pt-2.5 pb-2 text-left shadow-[0_2px_10px_rgba(0,0,0,0.35)] transition-[opacity,box-shadow,border-color] select-none',
        card.state === 'working' ? 'border-accent/60' : card.state === 'stuck' ? 'border-dashed border-warn/70' : 'border-line',
        waiting > 0 && 'shadow-[0_0_0_3px_rgba(210,153,34,0.28),0_2px_10px_rgba(0,0,0,0.35)]',
        selected && 'outline-2 outline-offset-2 outline-accent',
        card.state === 'offline' && !dim && 'opacity-60',
        dim && 'opacity-20'
      )}
    >
      <span data-cv-link={card.key} title={LINK_TITLE} className={LINK_HANDLE}>
        <Plus size={11} />
      </span>
      <div className="flex min-w-0 items-center gap-2">
        <Avatar name={card.name} color={card.color ?? '#8b949e'} size={28} active={card.state === 'working'} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1">
            <span className="truncate text-[13px] font-semibold text-fg group-data-[lod=far]/cv:text-[19px]">{card.name}</span>
            {card.lead && (
              <span title="这个项目的主脑" className="shrink-0 text-warn">
                <Crown size={13} />
              </span>
            )}
          </div>
          <div className="truncate text-[11px] text-faint group-data-[lod=far]/cv:hidden">
            {kind && (
              <span data-cv-kind={kind.kind} title={kind.title} className="text-muted">
                {kind.label} ·{' '}
              </span>
            )}
            {card.role ?? '没有职位'}
          </div>
        </div>
        <span data-cv-state title={statusTitle} className="flex shrink-0 items-center gap-1 rounded-full bg-canvas px-1.5 py-0.5 text-[11px]" style={{ color: meta.color }}>
          <i className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />
          {meta.label}
        </span>
      </div>
      <div className="mt-2 min-w-0 group-data-[lod=far]/cv:hidden">
        <div data-cv-line className="truncate text-xs" style={{ color: card.state === 'idle' || card.state === 'offline' ? undefined : meta.color }}>
          <span className={card.state === 'idle' || card.state === 'offline' ? 'text-muted' : undefined}>{statusLine}</span>
        </div>
        <div data-cv-work className="mt-0.5 truncate text-xs text-muted">
          {work ? (
            <>
              <span className="text-fg">{work.ref}</span> {work.title}
              {card.tasks.length > 1 && <span className="text-faint"> 等 {card.tasks.length} 个</span>}
            </>
          ) : card.last ? (
            <span className={card.last.failed ? 'text-bad' : undefined}>
              {toolLabel(card.last.tool)}
              {card.last.text ? ` ${card.last.text}` : ''} · {timeAgo(card.last.ts, now)}
            </span>
          ) : (
            <span className="text-faint">手上没有任务</span>
          )}
        </div>
      </div>
      <div className="mt-auto flex items-center gap-1.5 group-data-[lod=far]/cv:hidden">
        {waiting > 0 && (
          <span data-cv-wait className="flex items-center gap-1 rounded-md bg-warn/15 px-1.5 py-0.5 text-[11px] font-medium text-warn" title={card.attention.map((a) => `${ATTENTION[a.kind]}：${a.taskRef} ${a.taskTitle}`).join('\n')}>
            等你 {waiting} 件
          </span>
        )}
        {!!card.commands && <span className="rounded-md bg-canvas px-1.5 py-0.5 text-[11px] text-muted">命令 {card.commands}</span>}
        <span className="flex-1" />
        <button data-cv-chat title="和它说话（也可以双击卡片）" aria-label={`和 ${card.name} 说话`} onClick={() => onChat(card)} className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg">
          <MessageSquare size={14} />
        </button>
      </div>
    </div>
  )
})

function UserCard({ x, y, w, h, waiting, selected }: { x: number; y: number; w: number; h: number; waiting: number; selected: boolean }) {
  return (
    <div
      data-cv-card={CANVAS_USER_ID}
      data-selected={selected || undefined}
      style={{ left: x, top: y, width: w, height: h }}
      className={cx('absolute flex cursor-pointer items-center gap-2 rounded-full border border-line bg-raised px-3 shadow-[0_2px_10px_rgba(0,0,0,0.35)] select-none', selected && 'outline-2 outline-offset-2 outline-accent')}
    >
      <span data-cv-link={CANVAS_USER_ID} title="按住拖到一个 AI 上：派一件活给它" className={LINK_HANDLE}>
        <Plus size={11} />
      </span>
      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/20 text-accent">
        <User size={16} />
      </span>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-fg">你</div>
        <div className={cx('truncate text-[11px] group-data-[lod=far]/cv:hidden', waiting ? 'text-warn' : 'text-faint')}>{waiting ? `${waiting} 件事等你` : '派出去的活'}</div>
      </div>
    </div>
  )
}

// ========== 线 ==========

interface LineGeo {
  line: BoardLine
  d: string
  mid: XY
  color: string
}

const toRect = (b: Box): { origin: XY; size: { width: number; height: number } } => ({ origin: { x: b.x, y: b.y }, size: { width: b.w, height: b.h } })

function lineGeometry(lines: BoardLine[], cards: Record<string, Box>): LineGeo[] {
  const out: LineGeo[] = []
  const drawn = new Set<string>()
  for (const line of lines) {
    const a = cards[line.from]
    const b = cards[line.to]
    if (!a || !b) continue
    // 两个方向各有一条线时，后画的那条往旁边让一点，不叠在一起
    const back = drawn.has(`${line.to}|${line.from}`)
    drawn.add(`${line.from}|${line.to}`)
    let curve = panelConnectionCurve(toRect(a), toRect(b))
    if (!curve) continue
    if (back) {
      const last = curve.segments[curve.segments.length - 1]?.end ?? curve.start
      const dx = last.x - curve.start.x
      const dy = last.y - curve.start.y
      const len = Math.hypot(dx, dy) || 1
      curve = panelConnectionCurve(toRect(a), toRect(b), undefined, undefined, { x: curve.midpoint.x - (dy / len) * 26, y: curve.midpoint.y + (dx / len) * 26 }) ?? curve
    }
    out.push({ line, d: panelConnectionCurvePath(curve), mid: curve.midpoint, color: line.kind === 'team' ? TEAM_LINE : line.kind === 'relay' ? RELAY_LINE : LINE_COLOR[line.state ?? 'todo'] })
  }
  return out
}

// ========== 主区 ==========

type Gesture =
  | { kind: 'pan'; sx: number; sy: number; cx: number; cy: number; moved: boolean; background: boolean }
  | { kind: 'move'; sx: number; sy: number; keys: string[]; base: Record<string, XY>; click?: { key?: string; group?: string; toggle: boolean }; moved: boolean; late?: number; frames0?: Record<string, Box> }
  | { kind: 'link'; sx: number; sy: number; from: string; task?: string; at: XY; moved: boolean }
  | { kind: 'size'; sx: number; sy: number; id: string; x: number; y: number; w: number; h: number; moved: boolean }
  | { kind: 'marquee'; sx: number; sy: number; moved: boolean }

export function CanvasView(props: Props) {
  const { loaded } = useCanvasSaved()
  // 记过的位置读回来之前不摆卡片：不然会按「都是新的」重排一遍，把记过的盖掉
  if (!loaded) return <div data-canvas-loading className="flex h-full items-center justify-center text-xs text-faint">正在打开画布…</div>
  return <CanvasBoard {...props} />
}

function CanvasBoard(props: Props) {
  const { state, events, tasksByWs, hidden } = props
  const saved = useCanvasSaved()
  const ui = useCanvasUi()
  const now = useNow()
  const board = useBoard(props, !!saved.hideOffline)
  const [drag, setDrag] = useState<Record<string, XY> | null>(null)
  const [anchor, setAnchor] = useState<string>()
  const [selLine, setSelLine] = useState<string>()
  const [marquee, setMarquee] = useState<Box | null>(null)
  const [undo, setUndo] = useState<Record<string, XY> | null>(null)
  const [help, setHelp] = useState(false)
  const [shelfOpen, setShelfOpen] = useState(false)
  const [link, setLink] = useState<{ from: XY; to: XY } | null>(null)
  const [assign, setAssign] = useState<AssignReq | null>(null)
  const [teamMenu, setTeamMenu] = useState<string | null>(null)
  const [freshNote, setFreshNote] = useState<string>()
  const [toast, setToast] = useState<string>()
  const kinds = useAgentKinds(state)
  /** 要填进某张卡片面板输入框里的一句话（把文件拖到卡片上时） */
  const [fill, setFill] = useState<{ key: string; text: string; seq: number }>()
  const [lanes, setLanes] = useState(false)
  const [newAgent, setNewAgent] = useState(false)
  const [adding, setAdding] = useState(false)
  /** 右键「在这里开小窗」：小窗放在哪一点、默认哪个项目。从工具条上点开时没有 */
  const [addAt, setAddAt] = useState<{ at: XY; ws?: string }>()
  const ctx = useContextMenu()
  const [resize, setResize] = useState<{ id: string; w: number; h: number } | null>(null)
  const touches = useRef(new Map<number, XY>())
  const pinch = useRef<{ d: number; mx: number; my: number; cam: Camera } | null>(null)
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(undefined), 5000)
    return () => clearTimeout(t)
  }, [toast])

  const hostRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const zoomRef = useRef<HTMLSpanElement>(null)
  const mapViewRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const cam = useRef<Camera>(saved.cam ?? { x: 0, y: 0, z: 1 })
  const placed = useRef(!!saved.cam)
  const gesture = useRef<Gesture | null>(null)
  const space = useRef(false)
  const fly = useRef(0)
  const followPause = useRef(0)
  const lastFollow = useRef<{ key: string; at: number }>({ key: '', at: 0 })
  /** 上一次点的卡片和时间：同一张卡片连点两下算双击（鼠标被画布接管着，浏览器自己的双击事件到不了卡片） */
  const lastClick = useRef<{ key: string; at: number }>({ key: '', at: 0 })

  // 新框一行排多宽：照画面的宽度定，第一次打开和一键整理之后全部放进屏幕时字还看得清
  const [shelf, setShelf] = useState<number>()
  const measureShelf = useCallback(() => setShelf(clamp(Math.round((hostRef.current?.clientWidth ?? 1100) / 0.72), 900, 2600)), [])
  useLayoutEffect(measureShelf, [measureShelf])

  /** 拖着一张 AI 卡片、鼠标进了另一个项目的框：那个框的 id。这时框都不动，卡片浮在上面，松手就加进那个项目 */
  const [dropInto, setDropInto] = useState<string | null>(null)
  const pos = useMemo(() => (drag && !dropInto ? { ...saved.pos, ...drag } : saved.pos), [saved.pos, drag, dropInto])
  const layout = useMemo(() => layoutBoard(board, pos, anchor, { shelfWidth: shelf }), [board, pos, anchor, shelf])
  const layoutRef = useRef<BoardLayout>(layout)
  layoutRef.current = layout
  /** 右边被详情面板挡住的宽度；画面太窄时面板反正盖住大半，不让 */
  const inset = useRef(0)
  const boardRef = useRef(board)
  boardRef.current = board

  // 新定下来的位置记住；拖动中不记（松手时一起记）。连着记了几轮还没稳下来就停，免得没完没了
  const settle = useRef(0)
  useEffect(() => {
    if (drag || shelf === undefined) return
    if (Object.keys(layout.fresh).length === 0) {
      settle.current = 0
      return
    }
    if (settle.current >= 4) return
    settle.current++
    patchPositions(layout.fresh)
  }, [layout, drag, shelf])

  const byKey = useMemo(() => new Map(board.cards.map((c) => [c.key, c])), [board.cards])
  const selected = useMemo(() => ui.selected.filter((k) => byKey.has(k)), [ui.selected, byKey])
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const lines = useMemo(() => lineGeometry(board.lines, layout.cards), [board.lines, layout.cards])
  const groupOf = useCallback((key: string) => boardRef.current.cards.find((c) => c.key === key)?.groupId, [])

  // 便签：项目里的（AI 贴的、用户贴在某张卡片旁边的）和不属于哪个项目的。拖过的照记的位置放，没拖过的摆在它说的那张卡片或它的项目旁边
  const notes = useMemo(() => {
    const out: { note: CanvasNote; doc: string; box: Box }[] = []
    // 没拖过的便签不盖住框、「你」和别的便签
    const taken: Box[] = [...Object.values(layout.frames), ...(layout.cards.user ? [layout.cards.user] : [])]
    for (const d of Object.values(saved.docs)) for (const n of d.notes ?? []) if (pos[n.id]) taken.push({ x: pos[n.id].x, y: pos[n.id].y, w: NOTE_W, h: NOTE_H })
    for (const [doc, d] of Object.entries(saved.docs)) {
      for (const note of d.notes ?? []) {
        let at = pos[note.id]
        if (!at) {
          const card = note.near ? board.cards.find((c) => c.id === note.near) : undefined
          const r = card ? layout.cards[card.key] : undefined
          const f = layout.frames[doc]
          // 说了贴在谁旁边：放在那张卡片所在的框的右边、和卡片一样高；那儿有东西就找最近的空地方
          const cf = card?.groupId ? layout.frames[card.groupId] : undefined
          const want = r
            ? { x: (cf ? cf.x + cf.w : r.x + r.w) + 16, y: r.y }
            : f
              ? { x: f.x + f.w + 16, y: f.y }
              : { x: layout.bounds?.x ?? 0, y: (layout.bounds ? layout.bounds.y + layout.bounds.h : 0) + 48 }
          at = freeSpot(want, { w: NOTE_W, h: NOTE_H }, taken)
          taken.push({ x: at.x, y: at.y, w: NOTE_W, h: NOTE_H })
        }
        out.push({ note, doc, box: { x: at.x, y: at.y, w: NOTE_W, h: NOTE_H } })
      }
    }
    return out
  }, [saved.docs, pos, board.cards, layout])
  const notesRef = useRef(notes)
  notesRef.current = notes
  // 小窗（终端、网页、文件）：存在总画布那一份里；大小记在位置旁边
  const allDoc = saved.docs[CANVAS_ALL]
  const widgets = useMemo(() => {
    const out: { widget: CanvasWidget; box: Box }[] = []
    let n = 0
    for (const widget of allDoc?.widgets ?? []) {
      const node = allDoc?.nodes[widget.id]
      const size = resize?.id === widget.id ? resize : { w: node?.w ?? WIDGET_SIZE[widget.kind].w, h: node?.h ?? WIDGET_SIZE[widget.kind].h }
      const at = pos[widget.id] ?? { x: (layout.bounds ? layout.bounds.x + layout.bounds.w : 0) + 60 + n * STAGGER * 2, y: (layout.bounds?.y ?? 0) + n++ * STAGGER * 2 }
      out.push({ widget, box: { x: at.x, y: at.y, w: size.w, h: size.h } })
    }
    return out
  }, [allDoc, pos, layout.bounds, resize])
  // 拉完大小、工作台记下来以后，用记下来的
  useEffect(() => setResize(null), [allDoc])
  /** 卡片和框以外、画布上占地方、能拖的东西（便签、小窗）：id 对外框 */
  const movable = useRef(new Map<string, Box>())
  movable.current = new Map([...notes.map((n) => [n.note.id, n.box] as const), ...widgets.map((w) => [w.widget.id, w.box] as const)])
  const extraRef = useRef<Box[]>([])
  extraRef.current = [...movable.current.values()]

  // ----- 镜头 -----
  const mapGeo = useMemo(() => {
    // 便签和小窗也算进小地图的范围
    const b = unionBox([layout.bounds, ...notes.map((n) => n.box), ...widgets.map((w) => w.box)])
    if (!b) return null
    const s = Math.min((MAP_W - 12) / Math.max(b.w, 1), (MAP_H - 12) / Math.max(b.h, 1))
    return { s, ox: (MAP_W - b.w * s) / 2 - b.x * s, oy: (MAP_H - b.h * s) / 2 - b.y * s }
  }, [layout.bounds, notes, widgets])
  const mapGeoRef = useRef(mapGeo)
  mapGeoRef.current = mapGeo

  const [zoomNow, setZoomNow] = useState(1)
  const apply = useCallback((store = true) => {
    const host = hostRef.current
    const world = worldRef.current
    if (!host || !world) return
    const c = cam.current
    world.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.z})`
    let grid = 24 * c.z
    while (grid < 14) grid *= 2
    host.style.backgroundSize = `${grid}px ${grid}px`
    host.style.backgroundPosition = `${c.x}px ${c.y}px`
    host.dataset.lod = c.z < 0.5 ? 'far' : 'near'
    // 小窗要知道现在缩放到多少（太小时不接鼠标）；按 5% 一档记，免得每一帧都重画
    setZoomNow(Math.round(c.z * 20) / 20)
    if (zoomRef.current) zoomRef.current.textContent = `${Math.round(c.z * 100)}%`
    const m = mapGeoRef.current
    const v = mapViewRef.current
    if (m && v) {
      v.style.left = `${(-c.x / c.z) * m.s + m.ox}px`
      v.style.top = `${(-c.y / c.z) * m.s + m.oy}px`
      v.style.width = `${(host.clientWidth / c.z) * m.s}px`
      v.style.height = `${(host.clientHeight / c.z) * m.s}px`
    }
    if (store) saveCamera({ ...c })
  }, [])

  const stopFly = useCallback(() => {
    if (fly.current) cancelAnimationFrame(fly.current)
    fly.current = 0
  }, [])

  const flyTo = useCallback(
    (to: Camera) => {
      stopFly()
      const from = { ...cam.current }
      const t0 = performance.now()
      const step = (t: number): void => {
        const k = clamp((t - t0) / 260, 0, 1)
        const e = 1 - Math.pow(1 - k, 3)
        cam.current = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, z: from.z + (to.z - from.z) * e }
        apply(k === 1)
        fly.current = k < 1 ? requestAnimationFrame(step) : 0
      }
      fly.current = requestAnimationFrame(step)
    },
    [apply, stopFly]
  )

  /** safe：窗口边上不能用的几条（顶上的总数、底下的工具栏、左下角的小地图），算镜头时让开 */
  const cameraFor = useCallback((box: Box, zoom?: number, pad = 64, safe: { top?: number; bottom?: number; left?: number } = {}): Camera => {
    const host = hostRef.current
    const full = host?.clientWidth ?? 800
    const left = safe.left ?? 0
    const top = safe.top ?? 0
    const w = Math.max(80, (full >= 760 ? full - inset.current : full) - left)
    const h = Math.max(80, (host?.clientHeight ?? 600) - top - (safe.bottom ?? 0))
    const z = clamp(zoom ?? Math.min(Math.max(w - pad * 2, 40) / Math.max(box.w, 1), Math.max(h - pad * 2, 40) / Math.max(box.h, 1), 1), ZOOM_MIN, ZOOM_MAX)
    return { x: left + w / 2 - (box.x + box.w / 2) * z, y: top + h / 2 - (box.y + box.h / 2) * z, z }
  }, [])

  const fitAll = useCallback(
    (animate = true) => {
      // 卡片和框之外，便签、小窗也要放进来
      const b = unionBox([layoutRef.current.bounds, ...extraRef.current])
      if (!b) return
      // 顶上那排总数、底下的工具栏、左下角的小地图都不能压着东西：量出它们占的地方，让开
      const host = hostRef.current
      const part = (sel: string): { w: number; h: number } | undefined => {
        const el = host?.querySelector<HTMLElement>(sel)
        return el ? { w: el.offsetWidth, h: el.offsetHeight } : undefined
      }
      const top = (part('[data-cv-totals]')?.h ?? 28) + 16
      const bottom = (part('[data-cv-tools]')?.h ?? 36) + 16
      const map = part('[data-cv-map]')
      let to = cameraFor(b, undefined, 28, { top, bottom })
      if (map) {
        // 小地图在左下角：要么底下多让一条，要么左边让一条，哪种画得大用哪种
        const under = cameraFor(b, undefined, 28, { top, bottom: Math.max(bottom, map.h + 16) })
        const beside = cameraFor(b, undefined, 28, { top, bottom, left: map.w + 12 })
        to = beside.z > under.z ? beside : under
      }
      if (animate) flyTo(to)
      else {
        cam.current = to
        apply()
      }
    },
    [apply, cameraFor, flyTo]
  )

  const showCard = useCallback(
    (key: string) => {
      const box = layoutRef.current.cards[key]
      if (!box) return
      const z = cam.current.z
      flyTo(cameraFor(box, z < 0.6 || z > 1.4 ? 1 : z))
    },
    [cameraFor, flyTo]
  )

  const zoomAt = useCallback(
    (px: number, py: number, z: number) => {
      const c = cam.current
      const nz = clamp(z, ZOOM_MIN, ZOOM_MAX)
      cam.current = { x: px - ((px - c.x) * nz) / c.z, y: py - ((py - c.y) * nz) / c.z, z: nz }
      apply()
    },
    [apply]
  )

  const zoomStep = useCallback(
    (factor: number) => {
      const host = hostRef.current
      if (!host) return
      stopFly()
      const c = cam.current
      const w = host.clientWidth / 2
      const h = host.clientHeight / 2
      const nz = clamp(c.z * factor, ZOOM_MIN, ZOOM_MAX)
      flyTo({ x: w - ((w - c.x) * nz) / c.z, y: h - ((h - c.y) * nz) / c.z, z: nz })
    },
    [flyTo, stopFly]
  )

  // 第一次打开（没记过镜头）：等有了内容，把所有东西放进屏幕
  useLayoutEffect(() => {
    if (!placed.current && shelf !== undefined && layout.bounds && hostRef.current && hostRef.current.clientWidth > 0) {
      placed.current = true
      fitAll(false)
    } else apply(false)
  }, [layout.bounds, mapGeo, shelf, apply, fitAll])

  useEffect(() => stopFly, [stopFly])

  // 滚轮：鼠标滚轮和 Ctrl + 滚轮（触控板捏合）缩放，朝着鼠标的位置；触控板两指滑动是平移。面板里能滚的列表照常滚
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onWheel = (e: WheelEvent): void => {
      const target = e.target as HTMLElement | null
      const zoomKey = e.ctrlKey || e.metaKey
      if (!zoomKey && target?.closest('[data-cv-scroll]')) return
      e.preventDefault()
      stopFly()
      followPause.current = Date.now() + 8000
      const r = host.getBoundingClientRect()
      const wheel = isMouseWheel({ deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, wheelDeltaY: (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY })
      if (zoomKey || wheel) {
        let dy = e.deltaY
        if (e.deltaMode === 1) dy *= 33
        else if (e.deltaMode === 2) dy *= 400
        // 捏合给的数很小，滚轮一格是 100 左右
        const k = zoomKey && Math.abs(dy) < 40 ? 0.01 : 0.0016
        zoomAt(e.clientX - r.left, e.clientY - r.top, cam.current.z * Math.exp(-dy * k))
      } else {
        cam.current = { ...cam.current, x: cam.current.x - e.deltaX, y: cam.current.y - e.deltaY }
        apply()
      }
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => host.removeEventListener('wheel', onWheel)
  }, [apply, stopFly, zoomAt])

  // 窗口大小变了，小地图上的取景框跟着变
  useEffect(() => {
    const host = hostRef.current
    if (!host || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => apply(false))
    ro.observe(host)
    return () => ro.disconnect()
  }, [apply])

  // 侧栏点了某个 AI 或某个项目：飞过去
  const focusN = ui.focus?.n
  useEffect(() => {
    const f = ui.focus
    if (!f) return
    if (f.kind === 'card') showCard(f.id)
    else {
      const box = layoutRef.current.frames[f.id]
      if (box) flyTo(cameraFor(box))
    }
    // 只在请求号变的时候跑
  }, [focusN])

  // 镜头跟随：有 AI 开始调工具，就把镜头移到它的卡片上；你自己动过镜头之后先停几秒
  useEffect(() => {
    if (!saved.follow || hidden) return
    let newest: ActivityEvent | undefined
    for (const e of events) if (e.status === 'running' && e.tool !== 'chat_wait' && (!newest || e.ts > newest.ts)) newest = e
    if (!newest) return
    const card = boardRef.current.cards.find((c) => c.kind === 'agent' && c.id === newest!.agentId)
    const t = Date.now()
    if (!card || t < followPause.current || gesture.current) return
    // 用户正在画布上打字（卡片面板、便签、小窗里），镜头不动
    const focus = document.activeElement
    if (focus instanceof HTMLElement && hostRef.current?.contains(focus) && (focus.tagName === 'TEXTAREA' || focus.tagName === 'INPUT' || focus.isContentEditable)) return
    if (lastFollow.current.key === card.key || t - lastFollow.current.at < 2500) return
    lastFollow.current = { key: card.key, at: t }
    showCard(card.key)
  }, [events, saved.follow, hidden, showCard])

  // ----- 鼠标 -----
  const toCanvas = useCallback((clientX: number, clientY: number): XY => {
    const r = hostRef.current!.getBoundingClientRect()
    const c = cam.current
    return { x: (clientX - r.left - c.x) / c.z, y: (clientY - r.top - c.y) / c.z }
  }, [])

  /** 把一个 AI 加进另一个项目的分工：那个项目还没有主脑就让它当，有了就当子代理 */
  const joinTeam = (card: BoardCard, group: BoardGroup): void => {
    const ch = state.chat?.channels.find((c) => c.id === group.channel)
    const plan = planJoinTeam({ leadId: ch?.leadId, subIds: ch?.subIds }, state.agents.map((a) => a.id), card.id)
    if (plan.kind === 'none') {
      setToast(`没有加：${plan.reason}`)
      return
    }
    window.bridge
      .setGroupChatLead(group.channel!, plan.leadId ?? null, plan.subIds)
      .then(() => setToast(plan.leadId === card.id ? `「${group.title}」还没有主脑，${card.name} 现在是主脑。要改：点框标题上的「分工」` : `${card.name} 已经加进「${group.title}」的分工。要改：点框标题上的「分工」`))
      .catch(tell)
  }

  /**
   * 贴一张便签。near：贴在这张 AI 卡片旁边（它在项目里就记在它的项目里）；at：贴在画布上的这一点（右键点的地方）；
   * 都不给：选中了一张 AI 卡片就贴在它旁边，不然贴在画面中间。没指定地方时不盖住框和别的便签、小窗
   */
  const addNote = (near?: BoardCard, at?: XY): void => {
    const sel = near ?? (at ? undefined : selected.length === 1 ? byKey.get(selected[0]) : undefined)
    const ws = sel?.kind === 'agent' ? board.groups.find((x) => x.id === sel.groupId)?.workspaceId : undefined
    const doc = ws ?? CANVAS_ALL
    const before = new Set((saved.docs[doc]?.notes ?? []).map((n) => n.id))
    canvasOp(doc, [{ op: 'addNote', text: '新便签', ...(ws && sel ? { near: sel.id } : {}) }])
      .then((d) => {
        const made = d.notes.find((n) => !before.has(n.id))
        if (!made) return
        setFreshNote(made.id)
        // 记在项目里、说了贴在谁旁边的：位置由上面的 notes 自己算
        if (ws || !hostRef.current) return
        if (at) {
          patchPositions({ [made.id]: { x: Math.round(at.x - NOTE_W / 2), y: Math.round(at.y - NOTE_H / 2) } })
          return
        }
        const L = layoutRef.current
        const by = near ? L.cards[near.key] : undefined
        const c = viewCentre()
        const want = by ? { x: by.x + by.w + 16, y: by.y } : { x: Math.round(c.x - NOTE_W / 2), y: Math.round(c.y - NOTE_H / 2) }
        patchPositions({ [made.id]: freeSpot(want, { w: NOTE_W, h: NOTE_H }, [...Object.values(L.frames), ...Object.values(L.cards), ...movable.current.values()]) })
      })
      .catch(tell)
  }

  /** 画面中间（让开右边的面板）对应画布上的哪一点 */
  const viewCentre = (): XY => {
    const host = hostRef.current
    if (!host) return { x: 0, y: 0 }
    const r = host.getBoundingClientRect()
    return toCanvas(r.left + (r.width - inset.current) / 2, r.top + r.height / 2)
  }

  /** 放一个小窗（终端、网页、文件）；at 不给就放在画面中间 */
  const addWidget = (kind: CanvasWidgetKind, workspaceId: string, value: string, at?: XY): void => {
    const size = WIDGET_SIZE[kind]
    const c = at ?? viewCentre()
    // 不盖住框和别的便签、小窗：画面中间有东西就挪到最近的空地方
    const spot = freeSpot({ x: Math.round(c.x - size.w / 2), y: Math.round(c.y - size.h / 2) }, size, [...Object.values(layoutRef.current.frames), ...(layoutRef.current.cards.user ? [layoutRef.current.cards.user] : []), ...movable.current.values()], 20)
    const before = new Set((getCanvasSaved().docs[CANVAS_ALL]?.widgets ?? []).map((w) => w.id))
    canvasOp(CANVAS_ALL, [{ op: 'addWidget', kind, workspaceId, ...(kind === 'web' ? { url: value } : value ? { path: value } : {}) }])
      .then((d) => {
        const made = (d.widgets ?? []).find((w) => !before.has(w.id))
        if (made) {
          patchPositions({ [made.id]: spot })
          requestAnimationFrame(() => flyTo(cameraFor({ x: spot.x - 40, y: spot.y - 40, w: size.w + 80, h: size.h + 80 }, Math.max(cam.current.z, 0.6))))
        }
      })
      .catch(tell)
  }

  /** 从电脑上拖文件进来：拖到一个 AI 上是让它看这个文件，拖到空白处是把文件开成一个小窗 */
  const onDropFiles = (e: React.DragEvent<HTMLDivElement>): void => {
    const files = [...e.dataTransfer.files]
    if (files.length === 0) return
    e.preventDefault()
    const paths = files.map((f) => window.wbLocal?.pathOfFile(f) ?? '').filter(Boolean)
    if (paths.length === 0) {
      setToast('拿不到这个文件在电脑上的位置（手机上、浏览器里看的时候不能拖文件）')
      return
    }
    const B = boardRef.current
    const to = B.cards.find((c) => c.key === (e.target as HTMLElement).closest<HTMLElement>('[data-cv-card]')?.dataset.cvCard)
    if (to && to.kind === 'agent') {
      // 留在画布上：打开这张卡片的面板，把这句话填进输入框（不自动发）
      setSelLine(undefined)
      setCanvasSelected([to.key])
      setFill((f) => ({ key: to.key, text: `看一下${paths.length > 1 ? '这几个文件' : '这个文件'}：${paths.join('、')} `, seq: (f?.seq ?? 0) + 1 }))
      return
    }
    // 空白处：在哪个项目的文件夹里，就开成那个项目的文件小窗
    const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
    const at = toCanvas(e.clientX, e.clientY)
    let opened = 0
    for (const raw of paths.slice(0, 4)) {
      const p = norm(raw)
      const ws = state.workspaces.filter((w) => w.kind !== 'machine').find((w) => p.toLowerCase().startsWith(norm(w.root).toLowerCase() + '/'))
      if (!ws) continue
      addWidget('file', ws.id, p.slice(norm(ws.root).length + 1), { x: at.x + opened * 36, y: at.y + opened * 36 })
      opened++
    }
    if (opened === 0) setToast('这个文件不在任何一个项目的文件夹里，开不成小窗。拖到一个 AI 的卡片上，可以让它看这个文件')
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 && e.button !== 1) return
    const target = e.target as HTMLElement
    if (target.closest('[data-cv-ui]')) return
    const host = hostRef.current
    if (!host) return
    host.focus({ preventScroll: true })
    const cardEl = target.closest<HTMLElement>('[data-cv-card]')
    const headEl = target.closest<HTMLElement>('[data-cv-frame-head]')
    const noteEl = target.closest<HTMLElement>('[data-cv-note]')
    const linkEl = target.closest<HTMLElement>('[data-cv-link], [data-cv-task]')
    // 手机上两根手指：缩放和平移，手上正在做的事放下
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touches.current.size === 2) {
        const [p, q] = [...touches.current.values()]
        const r = host.getBoundingClientRect()
        gesture.current = null
        setDrag(null)
        setMarquee(null)
        setLink(null)
        stopFly()
        pinch.current = { d: Math.hypot(p.x - q.x, p.y - q.y) || 1, mx: (p.x + q.x) / 2 - r.left, my: (p.y + q.y) / 2 - r.top, cam: { ...cam.current } }
        return
      }
    }
    // 画布上的按钮（卡片上的、框标题上的、线上的标签）：让它自己响应点击，不当成拖动
    if (target.closest('button, a, input, textarea, select, [data-cv-nodrag]')) return
    stopFly()
    setHelp(false)
    const toggle = e.shiftKey || e.ctrlKey || e.metaKey
    const L = layoutRef.current
    const B = boardRef.current
    const sizeEl = target.closest<HTMLElement>('[data-cv-resize]')
    if (sizeEl && e.button === 0) {
      // 拉小窗右下角：改大小
      const id = sizeEl.dataset.cvResize!
      const at = movable.current.get(id)
      if (!at) return
      gesture.current = { kind: 'size', sx: e.clientX, sy: e.clientY, id, x: at.x, y: at.y, w: at.w, h: at.h, moved: false }
      host.setPointerCapture(e.pointerId)
      e.preventDefault()
      return
    }
    if (linkEl && e.button === 0) {
      // 从卡片边上的小圆点拉线，或者拖一条没人接的任务
      const task = linkEl.dataset.cvTask
      gesture.current = { kind: 'link', sx: e.clientX, sy: e.clientY, from: task ? CANVAS_USER_ID : linkEl.dataset.cvLink!, task, at: toCanvas(e.clientX, e.clientY), moved: false }
      host.setPointerCapture(e.pointerId)
      e.preventDefault()
      return
    }
    if (noteEl && e.button === 0 && !space.current) {
      const id = noteEl.dataset.cvNote!
      const at = movable.current.get(id)
      if (!at) return
      // 不马上抢指针：便签自己的双击改字要收得到，真拖起来了再抢
      gesture.current = { kind: 'move', sx: e.clientX, sy: e.clientY, keys: [id], base: { [id]: { x: at.x, y: at.y } }, moved: false, late: e.pointerId }
      return
    }
    if (e.button === 1 || space.current || (!cardEl && !headEl && !e.shiftKey)) {
      gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, cx: cam.current.x, cy: cam.current.y, moved: false, background: !cardEl && !headEl }
    } else if (cardEl) {
      const key = cardEl.dataset.cvCard!
      const keys = selectedSet.has(key) && !toggle ? selected : [key]
      const base: Record<string, XY> = {}
      for (const k of keys) if (L.cards[k]) base[k] = { x: L.cards[k].x, y: L.cards[k].y }
      gesture.current = { kind: 'move', sx: e.clientX, sy: e.clientY, keys, base, click: { key, toggle }, moved: false, frames0: keys.length === 1 ? { ...L.frames } : undefined }
      setAnchor(groupOf(key))
    } else if (headEl) {
      const id = headEl.dataset.cvFrameHead!
      const group = B.groups.find((g) => g.id === id)
      const base: Record<string, XY> = {}
      if (group && group.cardKeys.length > 0) {
        for (const k of group.cardKeys) if (L.cards[k]) base[k] = { x: L.cards[k].x, y: L.cards[k].y }
      } else if (L.frames[id]) {
        base[frameKey(id)] = { x: L.frames[id].x, y: L.frames[id].y }
      }
      gesture.current = { kind: 'move', sx: e.clientX, sy: e.clientY, keys: Object.keys(base), base, click: { group: id, toggle }, moved: false }
      setAnchor(id)
    } else {
      gesture.current = { kind: 'marquee', sx: e.clientX, sy: e.clientY, moved: false }
    }
    host.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (pinch.current && touches.current.has(e.pointerId)) {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const [p, q] = [...touches.current.values()]
      const host = hostRef.current
      if (!q || !host) return
      const r = host.getBoundingClientRect()
      const P = pinch.current
      const z = clamp(P.cam.z * (Math.hypot(p.x - q.x, p.y - q.y) / P.d), ZOOM_MIN, ZOOM_MAX)
      // 两指中间那一点下面的东西不动
      cam.current = { z, x: (p.x + q.x) / 2 - r.left - (P.mx - P.cam.x) * (z / P.cam.z), y: (p.y + q.y) / 2 - r.top - (P.my - P.cam.y) * (z / P.cam.z) }
      followPause.current = Date.now() + 8000
      apply()
      return
    }
    const g = gesture.current
    if (!g) return
    const dx = e.clientX - g.sx
    const dy = e.clientY - g.sy
    if (!g.moved && Math.hypot(dx, dy) < CLICK_SLACK) return
    if (!g.moved) {
      g.moved = true
      if (hostRef.current) hostRef.current.dataset.gesture = g.kind
      if (g.kind === 'move' && g.late !== undefined) hostRef.current?.setPointerCapture(g.late)
    }
    if (g.kind === 'pan') {
      followPause.current = Date.now() + 8000
      cam.current = { ...cam.current, x: g.cx + dx, y: g.cy + dy }
      apply()
    } else if (g.kind === 'move') {
      const z = cam.current.z
      const next: Record<string, XY> = {}
      for (const k of g.keys) next[k] = { x: Math.round(g.base[k].x + dx / z), y: Math.round(g.base[k].y + dy / z) }
      setDrag(next)
      // 只拖一张 AI 卡片时：鼠标进了别的项目的框（按开始拖时框的位置算），就把那个框亮起来
      if (g.frames0) {
        const B = boardRef.current
        const only = B.cards.find((c) => c.key === g.keys[0])
        const at = toCanvas(e.clientX, e.clientY)
        const into = only?.kind === 'agent' ? B.groups.find((x) => { const f = g.frames0![x.id]; return !!f && !!x.channel && x.id !== only.groupId && at.x >= f.x && at.x <= f.x + f.w && at.y >= f.y && at.y <= f.y + f.h }) : undefined
        setDropInto(into?.id ?? null)
      }
    } else if (g.kind === 'link') {
      setLink({ from: g.at, to: toCanvas(e.clientX, e.clientY) })
    } else if (g.kind === 'size') {
      const z = cam.current.z
      setResize({ id: g.id, w: Math.round(clamp(g.w + dx / z, WIDGET_MIN.w, WIDGET_MAX.w)), h: Math.round(clamp(g.h + dy / z, WIDGET_MIN.h, WIDGET_MAX.h)) })
    } else {
      const a = toCanvas(g.sx, g.sy)
      const b = toCanvas(e.clientX, e.clientY)
      setMarquee({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) })
    }
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    touches.current.delete(e.pointerId)
    if (pinch.current) {
      if (touches.current.size < 2) pinch.current = null
      return
    }
    const g = gesture.current
    if (!g) return
    gesture.current = null
    const host = hostRef.current
    if (host) {
      delete host.dataset.gesture
      if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId)
    }
    if (g.kind === 'pan') {
      if (!g.moved && g.background) {
        setCanvasSelected([])
        setSelLine(undefined)
      }
    } else if (g.kind === 'move') {
      if (g.moved) {
        const z = cam.current.z
        const dx = e.clientX - g.sx
        const dy = e.clientY - g.sy
        const next: Record<string, XY> = {}
        for (const k of g.keys) next[k] = { x: Math.round(g.base[k].x + dx / z), y: Math.round(g.base[k].y + dy / z) }
        // 把一张 AI 卡片拖进另一个项目的框里松手：加进那个项目的分工（卡片会自己排进那个框，原来记的位置不要了）
        const B = boardRef.current
        const only = g.keys.length === 1 ? B.cards.find((c) => c.key === g.keys[0]) : undefined
        const at = toCanvas(e.clientX, e.clientY)
        const into = only?.kind === 'agent' && g.frames0 ? B.groups.find((x) => { const f = g.frames0![x.id]; return !!f && !!x.channel && x.id !== only.groupId && at.x >= f.x && at.x <= f.x + f.w && at.y >= f.y && at.y <= f.y + f.h }) : undefined
        setDropInto(null)
        if (only && into) {
          setDrag(null)
          joinTeam(only, into)
        } else {
          patchPositions(next)
          setDrag(null)
        }
      } else if (g.click?.key) {
        const key = g.click.key
        const t = Date.now()
        const twice = !g.click.toggle && lastClick.current.key === key && t - lastClick.current.at < 400
        lastClick.current = { key: twice ? '' : key, at: t }
        setSelLine(undefined)
        if (g.click.toggle) setCanvasSelected(selectedSet.has(key) ? selected.filter((k) => k !== key) : [...selected, key])
        else setCanvasSelected([key])
        const card = boardRef.current.cards.find((c) => c.key === key)
        if (twice && card) openChat(card, boardRef.current)
      } else if (g.click?.group) {
        // 点框的标题：选中框里所有卡片
        const group = boardRef.current.groups.find((x) => x.id === g.click!.group)
        if (group) {
          setSelLine(undefined)
          setCanvasSelected(g.click.toggle ? [...new Set([...selected, ...group.cardKeys])] : group.cardKeys)
        }
      }
    } else if (g.kind === 'size') {
      if (g.moved) {
        const z = cam.current.z
        const w = Math.round(clamp(g.w + (e.clientX - g.sx) / z, WIDGET_MIN.w, WIDGET_MAX.w))
        const h = Math.round(clamp(g.h + (e.clientY - g.sy) / z, WIDGET_MIN.h, WIDGET_MAX.h))
        setResize({ id: g.id, w, h })
        act(CANVAS_ALL, [{ op: 'move', nodes: [{ id: g.id, x: g.x, y: g.y, w, h }] }])
      }
    } else if (g.kind === 'link') {
      setLink(null)
      const B = boardRef.current
      if (!g.moved) {
        // 没拖：点的是一条没人接的任务，打开它
        if (g.task) openTask(tasksByWs, g.task.split('|')[0], g.task.split('|')[1])
        return
      }
      const under = document.elementFromPoint(e.clientX, e.clientY)
      const to = B.cards.find((c) => c.key === under?.closest<HTMLElement>('[data-cv-card]')?.dataset.cvCard)
      const from = B.cards.find((c) => c.key === g.from)
      if (to && to.kind === 'agent' && to.key !== g.from) {
        const wsOf = (c?: BoardCard): string | undefined => (c?.groupId && B.models[c.groupId] ? c.groupId : undefined)
        const ws = g.task ? g.task.split('|')[0] : (wsOf(to) ?? wsOf(from) ?? B.groups.find((x) => x.workspaceId)?.workspaceId)
        if (ws) setAssign({ ws, fromId: g.from === CANVAS_USER_ID ? CANVAS_USER_ID : (agentOfKey(g.from) ?? g.from), toId: to.id, taskRef: g.task?.split('|')[1] })
        else setToast('先在首页添加一个项目，才能派活')
      } else if (!to && !g.task && from?.kind === 'agent') {
        // 拉到别的项目的框上：加进那个项目的分工
        const group = B.groups.find((x) => x.id === under?.closest<HTMLElement>('[data-cv-frame]')?.dataset.cvFrame)
        if (group?.workspaceId && group.channel && group.id !== from.groupId) joinTeam(from, group)
      }
    } else {
      const box = marquee
      setMarquee(null)
      if (g.moved && box) {
        const L = layoutRef.current
        const hit = boardRef.current.cards.filter((c) => {
          const r = L.cards[c.key]
          return r && r.x < box.x + box.w && box.x < r.x + r.w && r.y < box.y + box.h && box.y < r.y + r.h
        })
        setSelLine(undefined)
        setCanvasSelected(hit.map((c) => c.key))
      }
    }
  }

  // ----- 键盘 -----
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const el = e.target as HTMLElement
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return
    const mod = e.ctrlKey || e.metaKey
    if (e.key === ' ') {
      space.current = true
      e.preventDefault()
    } else if (e.key === 'Escape') {
      setCanvasSelected([])
      setSelLine(undefined)
      setHelp(false)
    } else if ((mod && e.key.toLowerCase() === 'f') || e.key === '/') {
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      setCanvasSelected(board.cards.filter((c) => c.kind === 'agent').map((c) => c.key))
    } else if (e.key === '0') fitAll()
    else if (e.key === '1') zoomStep(1 / cam.current.z)
    else if (e.key === '=' || e.key === '+') zoomStep(1.25)
    else if (e.key === '-') zoomStep(0.8)
    else if (e.key === 'Enter' && selected.length === 1) {
      const card = byKey.get(selected[0])
      if (card) openChat(card, board)
    } else if (e.key.startsWith('Arrow')) {
      e.preventDefault()
      const dir = e.key.slice(5).toLowerCase() as Direction
      if (selected.length === 0) {
        const d = { left: [80, 0], right: [-80, 0], up: [0, 80], down: [0, -80] }[dir]
        stopFly()
        cam.current = { ...cam.current, x: cam.current.x + d[0], y: cam.current.y + d[1] }
        apply()
        return
      }
      const from = layout.cards[selected[selected.length - 1]]
      if (!from) return
      const nodes = board.cards.filter((c) => layout.cards[c.key]).map((c) => ({ id: c.key, rect: toRect(layout.cards[c.key]) }))
      const next = findNodeInDirection(nodes, { x: from.x + from.w / 2, y: from.y + from.h / 2 }, dir, selected[selected.length - 1])
      if (next) {
        setCanvasSelected([next.id])
        setSelLine(undefined)
        showCard(next.id)
      }
    }
  }

  const onKeyUp = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === ' ') space.current = false
  }

  // ----- 工具条上的动作 -----
  const arrange = (): void => {
    setUndo(getCanvasSaved().pos)
    measureShelf()
    replacePositions({})
    setAnchor(undefined)
    requestAnimationFrame(() => requestAnimationFrame(() => fitAll()))
  }
  const undoArrange = (): void => {
    if (!undo) return
    replacePositions(undo)
    setUndo(null)
    requestAnimationFrame(() => requestAnimationFrame(() => fitAll()))
  }
  const tidy = (group: BoardGroup): void => {
    const frame = layout.frames[group.id]
    if (!frame || group.cardKeys.length === 0) return
    setAnchor(group.id)
    patchPositions(tidyGroup(group, frame))
  }
  // ----- 右键 -----
  const frameInfo = (g: BoardGroup): FrameMenuInfo => ({ title: g.title, cards: g.cardKeys.length, hasTeam: !!g.workspaceId, hasChat: !!g.channel })
  const frameActs = (g: BoardGroup): FrameMenuActions => ({
    select: () => {
      setSelLine(undefined)
      setCanvasSelected(g.cardKeys)
    },
    tidy: () => tidy(g),
    team: () => setTeamMenu(g.workspaceId ?? null),
    chat: () => {
      if (g.channel) navigate({ section: 'overview', id: homeId({ kind: 'channel', channel: g.channel }) })
    },
    show: () => {
      const box = layoutRef.current.frames[g.id]
      if (box) flyTo(cameraFor(box))
    }
  })
  /** 空白处的菜单；frameId 是点在哪个框里的空白处（没有就是框外面） */
  const blankEntries = (at: XY, frameId?: string): MenuEntry[] => {
    const g = frameId ? boardRef.current.groups.find((x) => x.id === frameId) : undefined
    return blankMenu(
      { canUndo: !!undo, frame: g ? frameInfo(g) : undefined },
      {
        note: () => addNote(undefined, at),
        widget: () => {
          setAddAt({ at, ws: g?.workspaceId })
          setAdding(true)
        },
        newAgent: () => setNewAgent(true),
        fit: () => fitAll(),
        arrange,
        undo: undoArrange
      },
      g ? frameActs(g) : undefined
    )
  }
  /** 右键点到的东西对应的菜单。菜单里都是画布上本来就有的功能，只是多一个入口 */
  const menuFor = (hit: CanvasHit, at: XY): MenuEntry[] => {
    const B = boardRef.current
    if (hit.kind === 'card') {
      const card = B.cards.find((c) => c.key === hit.key)
      // 「你」那张卡片没有自己的菜单，当成空白处
      if (!card || card.kind !== 'agent') return blankEntries(at)
      const ws = B.groups.find((g) => g.id === card.groupId)?.workspaceId ?? B.groups.find((g) => g.workspaceId)?.workspaceId
      return cardMenu(
        { name: card.name, canAssign: !!ws, online: card.state !== 'offline' },
        {
          panel: () => {
            setSelLine(undefined)
            setCanvasSelected([card.key])
            // 面板出来以后，光标放进它的输入框
            requestAnimationFrame(() => requestAnimationFrame(() => hostRef.current?.querySelector<HTMLTextAreaElement>('[data-cv-talk] textarea')?.focus()))
          },
          chat: () => openChat(card, boardRef.current),
          assign: () => {
            if (ws) setAssign({ ws, fromId: CANVAS_USER_ID, toId: card.id })
          },
          note: () => addNote(card),
          settings: () => navigate({ section: 'team', id: card.id }),
          stop: () =>
            stopAgent(card.id)
              .then((s) => setToast(`已叫停 ${card.name}：${s}`))
              .catch((err) => setToast(`没能叫停 ${card.name}：${errText(err)}`)),
          archive: () => {
            act(CANVAS_ALL, [{ op: 'archive', ids: [card.id] }])
            setCanvasSelected(selected.filter((k) => k !== card.key))
          }
        }
      )
    }
    if (hit.kind === 'frame') {
      const g = B.groups.find((x) => x.id === hit.id)
      return g ? frameMenu(frameInfo(g), frameActs(g)) : blankEntries(at)
    }
    if (hit.kind === 'note') {
      const n = notesRef.current.find((x) => x.note.id === hit.id)
      if (!n) return []
      return noteMenu({
        // 便签自己管改字（双击就是改字）：替用户双击一下
        edit: () => hostRef.current?.querySelector(`[data-cv-note="${CSS.escape(hit.id)}"]`)?.firstElementChild?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
        remove: () => {
          act(n.doc, [{ op: 'removeNote', id: hit.id }])
          forgetPositions([hit.id])
        }
      })
    }
    if (hit.kind === 'widget') {
      const w = (getCanvasSaved().docs[CANVAS_ALL]?.widgets ?? []).find((x) => x.id === hit.id)
      if (!w) return []
      return widgetMenu(
        { kind: w.kind },
        {
          show: () => {
            const box = movable.current.get(w.id)
            if (box) flyTo(cameraFor({ x: box.x - 40, y: box.y - 40, w: box.w + 80, h: box.h + 80 }))
          },
          openFile: () => {
            if (w.path) openFile({ workspaceId: w.workspaceId, path: w.path })
          },
          remove: () => act(CANVAS_ALL, [{ op: 'removeWidget', id: w.id }])
        }
      )
    }
    if (hit.kind === 'line') {
      const l = B.lines.find((x) => x.id === hit.id)
      if (!l || l.kind === 'team') return []
      return lineMenu(
        { kind: l.kind, canRemove: !!(l.workspaceId && l.relayId) },
        {
          open: () => {
            setCanvasSelected([])
            setSelLine(l.id)
          },
          remove: () => {
            if (l.workspaceId && l.relayId) act(l.workspaceId, [{ op: 'removeRelay', id: l.relayId }])
            setSelLine(undefined)
          }
        }
      )
    }
    if (hit.kind === 'task') {
      const [ws, ref] = hit.task.split('|')
      return openTaskMenu({ ref }, { open: () => openTask(tasksByWs, ws, ref) })
    }
    return hit.kind === 'blank' ? blankEntries(at, hit.frame) : []
  }

  /** 右键（手机上是长按；键盘上是菜单键或 Shift+F10）：点到什么就弹什么的菜单 */
  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const host = hostRef.current
    if (!host) return
    // 键盘打开的没有鼠标位置：选中了一张 AI 卡片就是它的菜单，弹在卡片上；不然是空白处的菜单
    const keyboard = e.clientX === 0 && e.clientY === 0
    let hit = hitOf(e.target as HTMLElement)
    let x = e.clientX
    let y = e.clientY
    if (keyboard) {
      if ((e.target as HTMLElement) !== host) return
      const r = host.getBoundingClientRect()
      const box = selected.length === 1 ? layoutRef.current.cards[selected[0]] : undefined
      const c = cam.current
      hit = box ? { kind: 'card', key: selected[0] } : { kind: 'blank' }
      x = box ? r.left + c.x + (box.x + box.w / 2) * c.z : r.left + (r.width - inset.current) / 2
      y = box ? r.top + c.y + (box.y + box.h / 2) * c.z : r.top + r.height / 2
    }
    // 不归画布管的地方（面板、正在打字的地方、小窗里面）：不拦，让它自己处理
    if (hit.kind === 'none') return
    e.preventDefault()
    // 手上正在做的事放下：长按弹出菜单之后再松手，不能又算成点了一下或拖了一下
    gesture.current = null
    delete host.dataset.gesture
    setDrag(null)
    setMarquee(null)
    setLink(null)
    setDropInto(null)
    stopFly()
    setHelp(false)
    const entries = menuFor(hit, toCanvas(x, y))
    if (entries.length > 0) ctx.open({ clientX: x, clientY: y, currentTarget: host }, entries)
  }

  const cycle = useRef<Record<string, number>>({})
  const jumpTo = (name: string, keys: string[]): void => {
    if (keys.length === 0) return
    const i = (cycle.current[name] ?? -1) + 1
    cycle.current[name] = i
    const key = keys[i % keys.length]
    setSelLine(undefined)
    setCanvasSelected([key])
    showCard(key)
  }

  const onChat = useCallback((card: BoardCard) => openChat(card, boardRef.current), [])
  const query = ui.query.trim()
  const matches = useMemo(() => new Set(board.cards.filter((c) => c.kind === 'agent' && matchesQuery(query, [c.name, c.role, ...c.tasks.map((t) => `${t.ref} ${t.title}`)])).map((c) => c.key)), [board.cards, query])
  const waitingKeys = board.cards.filter((c) => c.attention.length > 0).map((c) => c.key)
  const stuckKeys = board.cards.filter((c) => c.state === 'stuck').map((c) => c.key)
  const workingKeys = board.cards.filter((c) => c.state === 'working').map((c) => c.key)
  const line = selLine ? board.lines.find((l) => l.id === selLine) : undefined
  // 做完交上来、用户还没看的活（每个项目各记各的）
  const delivered = board.cards.flatMap((c) => c.attention.filter((a) => a.kind === 'delivered'))
  const ackAll = (): void => {
    for (const ws of new Set(delivered.map((a) => a.workspaceId))) act(ws, [{ op: 'ackAllTasks' }])
  }
  inset.current = selected.length > 0 || line ? PANEL_INSET : 0
  // 提示条能用的那一段：左边让开小地图，右边让开面板（或「放小窗」的小表单）；窗口太窄就只留边
  const toastRow = ((): { left: number; right: number } => {
    const full = hostRef.current?.clientWidth ?? 800
    const left = !saved.noMap && !lanes && mapGeo ? MAP_W + 24 : 12
    const right = (selected.length > 0 || line || adding ? PANEL_INSET : 0) + 12
    return full - left - right >= 240 ? { left, right } : { left: 12, right: 12 }
  })()
  const empty = board.cards.length === 0 && board.groups.length === 0

  return (
    <>
    <div
      ref={hostRef}
      data-canvas
      data-lod="near"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={(e) => {
        // 拖到一半被系统打断（来电、切窗口）：这次不算，东西回到原处
        gesture.current = null
        touches.current.delete(e.pointerId)
        pinch.current = null
        setDrag(null)
        setAnchor(undefined)
        setMarquee(null)
        setLink(null)
        setResize(null)
        setDropInto(null)
        e.currentTarget.removeAttribute('data-gesture')
      }}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onContextMenu={onContextMenu}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={onDropFiles}
      className="group/cv relative h-full w-full touch-none overflow-hidden bg-canvas outline-none data-[gesture=pan]:cursor-grabbing"
      style={{ backgroundImage: 'radial-gradient(circle, #2c2c2c 1px, transparent 1.2px)' }}
    >
      <style>{'@keyframes cv-flow { to { stroke-dashoffset: -28; } } .cv-flow { animation: cv-flow 1.1s linear infinite; }'}</style>

      <div ref={worldRef} data-cv-world className="absolute top-0 left-0 origin-top-left">
        {board.groups.map((g, i) => {
          const f = layout.frames[g.id]
          if (!f) return null
          const hue = g.kind === 'lobby' ? '#707070' : FRAME_HUES[i % FRAME_HUES.length]
          return (
            <div key={g.id} data-cv-frame={g.id} data-kind={g.kind} data-cv-drop={dropInto === g.id ? '' : undefined} style={{ left: f.x, top: f.y, width: f.w, height: f.h, borderColor: dropInto === g.id ? hue : `${hue}55`, background: dropInto === g.id ? `${hue}26` : `${hue}0d` }} className={cx('absolute rounded-2xl border', dropInto === g.id && 'border-2 border-dashed')}>
              <div data-cv-frame-head={g.id} className="flex h-11 cursor-grab items-center gap-2 px-4 select-none" title="拖这里移动整个框；点一下选中里面所有卡片">
                <span style={{ color: hue }} className="shrink-0">
                  {g.kind === 'lobby' ? <UsersRound size={15} /> : <FolderGit2 size={15} />}
                </span>
                <span className="truncate text-sm font-semibold text-fg group-data-[lod=far]/cv:text-xl">{g.title}</span>
                <span className="shrink-0 text-[11px] text-faint group-data-[lod=far]/cv:hidden">
                  {GROUP_KIND[g.kind]} · {g.cardKeys.length} 个 AI
                </span>
                {g.working > 0 && <span className="shrink-0 text-[11px] text-accent group-data-[lod=far]/cv:hidden">工作中 {g.working}</span>}
                {g.attention > 0 && <span className="shrink-0 rounded bg-warn/15 px-1.5 text-[11px] font-medium text-warn">等你 {g.attention}</span>}
                <span className="flex-1" />
                {g.workspaceId && (
                  <button data-cv-team-btn={g.workspaceId} title="分工：谁当主脑、带哪些子代理、团队模板" aria-label="分工" onClick={() => setTeamMenu(teamMenu === g.workspaceId ? null : g.workspaceId!)} className={headBtn}>
                    <UsersRound size={13} />
                  </button>
                )}
                {g.cardKeys.length > 1 && (
                  <button data-cv-tidy title="把这个框里的卡片排整齐" aria-label="排整齐" onClick={() => tidy(g)} className="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-faint hover:bg-hover hover:text-fg group-data-[lod=far]/cv:hidden">
                    <LayoutGrid size={13} />
                  </button>
                )}
                {g.channel && (
                  <button
                    data-cv-open-chat
                    title="打开这个项目的群聊"
                    aria-label="打开这个项目的群聊"
                    onClick={() => navigate({ section: 'overview', id: homeId({ kind: 'channel', channel: g.channel! }) })}
                    className="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-faint hover:bg-hover hover:text-fg group-data-[lod=far]/cv:hidden"
                  >
                    <MessageSquare size={13} />
                  </button>
                )}
              </div>
              {g.cardKeys.length === 0 && <div className="px-4 text-xs text-faint">这个项目里现在没有 AI 在干活</div>}
              {g.openTasks.length > 0 && (
                <div data-cv-open-tasks className="absolute top-full left-1 mt-1.5 flex max-w-full items-center gap-1 overflow-hidden text-[11px] select-none group-data-[lod=far]/cv:hidden">
                  <span className="shrink-0 text-faint">没人接：</span>
                  {g.openTasks.slice(0, 4).map((t) => (
                    <div key={t.id} data-cv-task={`${g.workspaceId}|${t.ref}`} title={`${t.ref} ${t.title}\n点一下打开；按住拖到一个 AI 的卡片上：交给它`} className="max-w-44 shrink-0 cursor-grab truncate rounded-md border border-line bg-raised px-1.5 py-0.5 text-muted hover:border-accent hover:text-fg">
                      {t.ref} {t.title}
                    </div>
                  ))}
                  {g.openTasks.length > 4 && <span className="shrink-0 text-faint">+{g.openTasks.length - 4}</span>}
                </div>
              )}
            </div>
          )
        })}

        <svg data-cv-lines className="pointer-events-none absolute top-0 left-0 overflow-visible" width="1" height="1">
          <defs>
            {[TEAM_LINE, RELAY_LINE, ...Object.values(LINE_COLOR)].map((c) => (
              <marker key={c} id={`cv-arrow-${c.slice(1)}`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                <path d="M 0 1 L 9 5 L 0 9 z" fill={c} />
              </marker>
            ))}
          </defs>
          {lines.map(({ line: l, d, color }) => {
            const faded = !!query && !(matches.has(l.from) || matches.has(l.to))
            const on = selLine === l.id || selectedSet.has(l.from) || selectedSet.has(l.to)
            return (
              <path
                key={l.id}
                data-cv-line-id={l.id}
                data-kind={l.kind}
                data-state={l.state}
                d={d}
                fill="none"
                stroke={color}
                strokeWidth={l.kind === 'team' ? 1.5 : on ? 3 : 2}
                strokeDasharray={l.kind === 'team' ? '3 7' : l.kind === 'relay' ? '14 6 2 6' : l.state === 'in_progress' ? '9 5' : undefined}
                strokeLinecap="round"
                markerEnd={`url(#cv-arrow-${color.slice(1)})`}
                opacity={faded ? 0.15 : l.kind === 'team' && !on ? 0.7 : 1}
                className={l.kind === 'task' && l.state === 'in_progress' ? 'cv-flow' : undefined}
              />
            )
          })}
          {link && <path data-cv-linking d={`M ${link.from.x} ${link.from.y} L ${link.to.x} ${link.to.y}`} fill="none" stroke="#58a6ff" strokeWidth={2} strokeDasharray="6 5" strokeLinecap="round" markerEnd="url(#cv-arrow-58a6ff)" />}
        </svg>

        {board.cards.map((c) => {
          const r = layout.cards[c.key]
          if (!r) return null
          if (c.kind === 'user') return <UserCard key={c.key} x={r.x} y={r.y} w={r.w} h={r.h} waiting={board.totals.attention} selected={selectedSet.has(c.key)} />
          const st = state.memberStatus?.[c.id]
          const view = st ? describeMemberStatus(st, now) : undefined
          // 正拖向别的项目的框：框不动，这张卡片浮在鼠标下面
          const fl = dropInto ? drag?.[c.key] : undefined
          return <CardView key={c.key} card={c} x={fl ? fl.x : r.x} y={fl ? fl.y : r.y} selected={selectedSet.has(c.key)} dim={!!query && !matches.has(c.key)} statusLine={view?.line ?? CARD_STATE[c.state].label} statusTitle={view?.title} kind={c.kind === 'agent' ? kinds[c.id] : undefined} now={now} onChat={onChat} />
        })}

        {lines.map(({ line: l, mid, color }) =>
          l.kind === 'task' && l.tasks?.length ? (
            <button
              key={l.id}
              data-cv-line-label={l.id}
              title={l.tasks.map((t) => `${t.ref} ${t.title}（${STATUS_META[t.status].label}）`).join('\n')}
              onClick={() => {
                setCanvasSelected([])
                setSelLine(l.id)
              }}
              style={{ left: mid.x, top: mid.y, borderColor: color, color }}
              className={cx('absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full border bg-canvas px-2 py-0.5 text-[11px] font-medium whitespace-nowrap select-none group-data-[lod=far]/cv:hidden', selLine === l.id && 'outline-2 outline-offset-1 outline-accent', !!query && !(matches.has(l.from) || matches.has(l.to)) && 'opacity-20')}
            >
              {l.tasks[0].ref}
              {l.tasks.length > 1 ? ` +${l.tasks.length - 1}` : ''}
            </button>
          ) : l.kind === 'relay' ? (
            <button
              key={l.id}
              data-cv-line-label={l.id}
              title="接力线：前一个做完一条任务，工作台自动把结果转告后一个。点一下看详情或删掉"
              onClick={() => {
                setCanvasSelected([])
                setSelLine(l.id)
              }}
              style={{ left: mid.x, top: mid.y, borderColor: color, color }}
              className={cx('absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full border bg-canvas px-2 py-0.5 text-[11px] font-medium whitespace-nowrap select-none group-data-[lod=far]/cv:hidden', selLine === l.id && 'ring-2 ring-accent/60')}
            >
              接力
            </button>
          ) : null
        )}

        {widgets.map(({ widget, box }) => (
          <div key={widget.id} data-cv-note={widget.id} data-cv-widget={widget.kind} style={{ left: box.x, top: box.y, width: box.w, height: box.h }} className="absolute cursor-grab">
            <WidgetCard
              state={state}
              widget={widget}
              zoom={zoomNow}
              onRemove={() => act(CANVAS_ALL, [{ op: 'removeWidget', id: widget.id }])}
              onEdit={(patch) => act(CANVAS_ALL, [{ op: 'editWidget', id: widget.id, ...patch }])}
              onOpenFile={(workspaceId, path) => openFile({ workspaceId, path })}
            />
            <div data-cv-resize={widget.id} title="拖这里改大小" className="absolute right-0 bottom-0 h-4 w-4 cursor-nwse-resize rounded-br-md border-r-2 border-b-2 border-line hover:border-accent" />
          </div>
        ))}

        {notes.map(({ note, doc, box }) => (
          <div key={note.id} data-cv-note={note.id} style={{ left: box.x, top: box.y, width: box.w, height: box.h }} className="absolute cursor-grab group-data-[gesture=move]/cv:cursor-grabbing">
            <NoteCard
              note={note}
              startEditing={freshNote === note.id}
              onEdit={(patch) => act(doc, [{ op: 'editNote', id: note.id, ...patch }])}
              onRemove={() => {
                act(doc, [{ op: 'removeNote', id: note.id }])
                forgetPositions([note.id])
              }}
            />
          </div>
        ))}

        {marquee && <div className="pointer-events-none absolute rounded border border-accent bg-accent/10" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
      </div>

      {empty && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-faint">还没有项目和 AI。先在首页添加一个项目，或者到「团队与职位」里新建一个 AI。</div>
      )}

      {/* 左上角：总数和搜索 */}
      <div data-cv-ui data-cv-totals className="absolute top-3 left-3 flex max-w-[calc(100%-24px)] flex-wrap items-center gap-1.5 text-xs">
        <Pill title="画布上的 AI 一共多少个">{board.totals.agents} 个 AI</Pill>
        <Pill tone="accent" on={board.totals.working > 0} title="正在调工具或跑命令的；点一下轮流看" onClick={() => jumpTo('working', workingKeys)}>
          工作中 {board.totals.working}
        </Pill>
        <Pill tone="warn" strong on={board.totals.attention > 0} title="要你回答的问题、做完交上来等你看的活；点一下轮流看" onClick={() => jumpTo('waiting', waitingKeys)}>
          等你 {board.totals.attention}
        </Pill>
        <Pill tone="warn" on={board.totals.stuck > 0} title="连着但很久没动静的；点一下轮流看" onClick={() => jumpTo('stuck', stuckKeys)}>
          可能卡住 {board.totals.stuck}
        </Pill>
        <Pill title="没连着的">离线 {board.totals.offline}</Pill>
        {delivered.length > 0 && (
          <button data-cv-ack-all onClick={ackAll} title="做完交上来、你还没看的活有这么多条。点一下：都算看过了，不再提醒" className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border border-line bg-panel/95 px-2.5 text-muted hover:bg-hover hover:text-fg">
            <CheckCheck size={13} /> 全部看过（{delivered.length}）
          </button>
        )}
        {board.archived.length > 0 && (
          <button data-cv-shelf-btn aria-pressed={shelfOpen} onClick={() => setShelfOpen((v) => !v)} title="收起来不画的 AI；点一下看名单，可以放回来" className={cx('inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border px-2.5 hover:bg-hover hover:text-fg', shelfOpen ? 'border-accent bg-accent/15 text-fg' : 'border-line bg-panel/95 text-muted')}>
            <Archive size={13} /> 收纳 {board.archived.length}
          </button>
        )}
        <label className="ml-1 flex h-7 items-center gap-1.5 rounded-full border border-line bg-panel/95 px-2.5 text-muted focus-within:border-accent">
          <Search size={13} />
          <input
            ref={searchRef}
            data-cv-search
            value={ui.query}
            onChange={(e) => setCanvasQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') jumpTo(`q:${query}`, [...matches])
              else if (e.key === 'Escape') {
                setCanvasQuery('')
                hostRef.current?.focus()
              }
            }}
            placeholder="找 AI 或任务（/）"
            className="w-36 bg-transparent text-xs text-fg outline-none placeholder:text-faint"
          />
          {query && <span className="shrink-0 text-faint">{matches.size} 个</span>}
        </label>
      </div>

      {shelfOpen && board.archived.length > 0 && (
        <div data-cv-ui data-cv-shelf data-cv-scroll className="absolute top-12 left-3 max-h-[60%] w-60 overflow-y-auto rounded-xl border border-line bg-panel/97 p-2 text-xs shadow-[0_8px_30px_rgba(0,0,0,0.45)]">
          <div className="px-1 pb-1 text-faint">收起来的 AI 不画在画布上；它有事等你时会自己出来</div>
          {board.archived.map((a) => (
            <div key={a.id} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-hover">
              <Avatar name={a.name} color={a.color ?? '#8b949e'} size={18} />
              <span className="min-w-0 flex-1 truncate text-fg">{a.name}</span>
              <button data-cv-unarchive={a.id} onClick={() => act(CANVAS_ALL, [{ op: 'unarchive', ids: [a.id] }])} className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border border-line px-1.5 text-muted hover:bg-hover hover:text-fg">
                <ArchiveRestore size={12} /> 放回来
              </button>
            </div>
          ))}
        </div>
      )}

      {teamMenu && (
        <div data-cv-ui data-cv-team-menu data-cv-scroll className="absolute top-12 left-3 z-10 max-h-[calc(100%-120px)] overflow-y-auto">
          <TeamMenu state={state} workspaceId={teamMenu} doc={saved.docs[teamMenu] ?? emptyCanvasDoc()} onClose={() => setTeamMenu(null)} />
        </div>
      )}

      {assign && <AssignHost state={state} events={events} tasksByWs={tasksByWs} req={assign} relays={saved.docs[assign.ws]?.relays ?? []} onClose={() => setAssign(null)} />}

      {lanes && (
        <div data-cv-ui data-cv-lanes className="absolute inset-x-0 top-12 bottom-14 z-[5] bg-canvas">
          <BoardLanes
            cards={board.cards.map((c) => ({ key: c.key, kind: c.kind, name: c.name, role: c.role, state: c.state, lead: c.lead, color: c.color, attention: c.attention, tasks: c.tasks.map((t) => ({ ...t, status: 'in_progress' })), groupName: board.groups.find((g) => g.id === c.groupId)?.title }))}
            selected={selected}
            onPick={(k) => {
              setLanes(false)
              setSelLine(undefined)
              setCanvasSelected([k])
              showCard(k)
            }}
            onOpen={(k) => {
              const c = byKey.get(k)
              if (c) openChat(c, board)
            }}
          />
        </div>
      )}

      {newAgent && (
        <div
          data-cv-ui
          data-cv-new-agent
          className="absolute inset-0 z-20 flex items-center justify-center bg-black/45"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setNewAgent(false)
          }}
        >
          <NewAgentDialog
            state={state}
            onClose={() => setNewAgent(false)}
            onCreated={(a) => {
              setToast(`${a.name} 建好了，在「没在项目里」那个框里。从它卡片右边的小圆点拉线到一个项目的框上，就把它加进那个项目`)
              focusOnCanvas('card', cardKey(a.id, 'lobby'))
            }}
          />
        </div>
      )}

      {adding && (
        <AddWidget
          workspaces={state.workspaces}
          initial={addAt?.ws ?? (selected.length === 1 ? board.groups.find((g) => g.id === byKey.get(selected[0])?.groupId)?.workspaceId : undefined) ?? state.activeWorkspaceId}
          onAdd={(kind, ws, value) => {
            setAdding(false)
            setLanes(false)
            addWidget(kind, ws, value, addAt?.at)
          }}
          onClose={() => setAdding(false)}
        />
      )}

      {toast && (
        // 提示条放在底下、小地图和右边面板之间：不盖项目框的标题，也不盖卡片面板
        <div data-cv-ui data-cv-toast-row className="pointer-events-none absolute bottom-16 z-10 flex justify-center" style={toastRow}>
          <div data-cv-toast onClick={() => setToast(undefined)} className="pointer-events-auto max-w-full cursor-pointer rounded-lg border border-line bg-panel/97 px-3 py-2 text-xs text-fg shadow-[0_8px_30px_rgba(0,0,0,0.45)]">
            {toast}
          </div>
        </div>
      )}

      {/* 右边：选中的卡片或线的详情 */}
      {(selected.length > 0 || line) && (
        <div data-cv-ui data-cv-inspector data-cv-scroll className="absolute top-3 right-3 max-h-[calc(100%-76px)] w-72 overflow-y-auto rounded-xl border border-line bg-panel/97 p-3 text-xs shadow-[0_8px_30px_rgba(0,0,0,0.45)]">
          {line?.kind === 'relay' ? (
            <RelayDetail line={line} byKey={byKey} workspaces={state.workspaces} onClose={() => setSelLine(undefined)} onShow={(k) => { setSelLine(undefined); setCanvasSelected([k]); showCard(k) }} />
          ) : line ? (
            <LineDetail line={line} byKey={byKey} workspaces={state.workspaces} onOpenTask={(ws, ref) => openTask(tasksByWs, ws, ref)} onClose={() => setSelLine(undefined)} onShow={(k) => { setSelLine(undefined); setCanvasSelected([k]); showCard(k) }} />
          ) : selected.length === 1 && byKey.get(selected[0])?.kind === 'agent' ? (
            <CardDetail card={byKey.get(selected[0])!} fill={fill?.key === selected[0] ? fill : undefined} board={board} state={state} now={now} kind={kinds[byKey.get(selected[0])!.id]} taskIdOf={(ws, ref) => (tasksByWs[ws] ?? []).find((t) => t.ref === ref)?.id} onAssign={(ws, toId) => setAssign({ ws, fromId: CANVAS_USER_ID, toId })} onOpenTask={(ws, ref) => openTask(tasksByWs, ws, ref)} onLine={(id) => { setCanvasSelected([]); setSelLine(id) }} onClose={() => setCanvasSelected([])} />
          ) : (
            <ManyDetail keys={selected} byKey={byKey} groups={board.groups} total={board.totals.attention} onShow={(k) => { setCanvasSelected([k]); showCard(k) }} onClose={() => setCanvasSelected([])} />
          )}
        </div>
      )}

      {/* 左下角：小地图 */}
      {!saved.noMap && !lanes && mapGeo && (
        <div
          data-cv-ui
          data-cv-map
          title="小地图：点一下或拖动，镜头就移过去"
          className="absolute bottom-3 left-3 cursor-crosshair overflow-hidden rounded-lg border border-line bg-panel/95"
          style={{ width: MAP_W, height: MAP_H }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            moveByMap(e, mapGeo, hostRef.current, cam, apply, stopFly)
          }}
          onPointerMove={(e) => {
            if (e.buttons & 1) moveByMap(e, mapGeo, hostRef.current, cam, apply, stopFly)
          }}
        >
          {board.groups.map((g, i) => {
            const f = layout.frames[g.id]
            return f ? <div key={g.id} className="absolute rounded-sm border" style={{ left: f.x * mapGeo.s + mapGeo.ox, top: f.y * mapGeo.s + mapGeo.oy, width: f.w * mapGeo.s, height: f.h * mapGeo.s, borderColor: g.kind === 'lobby' ? '#555' : `${FRAME_HUES[i % FRAME_HUES.length]}88` }} /> : null
          })}
          {board.cards.map((c) => {
            const r = layout.cards[c.key]
            return r ? <div key={c.key} className="absolute rounded-[1px]" style={{ left: r.x * mapGeo.s + mapGeo.ox, top: r.y * mapGeo.s + mapGeo.oy, width: Math.max(2, r.w * mapGeo.s), height: Math.max(2, r.h * mapGeo.s), background: c.attention.length ? '#d29922' : c.kind === 'user' ? '#58a6ff' : CARD_STATE[c.state].color }} /> : null
          })}
          {notes.map(({ note, box }) => (
            <div key={note.id} data-cv-map-note className="absolute rounded-[1px] bg-[#d29922]/70" style={{ left: box.x * mapGeo.s + mapGeo.ox, top: box.y * mapGeo.s + mapGeo.oy, width: Math.max(2, box.w * mapGeo.s), height: Math.max(2, box.h * mapGeo.s) }} />
          ))}
          {widgets.map(({ widget, box }) => (
            <div key={widget.id} data-cv-map-widget className="absolute rounded-[1px] border border-fg/50 bg-fg/10" style={{ left: box.x * mapGeo.s + mapGeo.ox, top: box.y * mapGeo.s + mapGeo.oy, width: Math.max(3, box.w * mapGeo.s), height: Math.max(3, box.h * mapGeo.s) }} />
          ))}
          <div ref={mapViewRef} className="pointer-events-none absolute rounded-sm border border-fg/70 bg-fg/5" />
        </div>
      )}

      {/* 右下角：缩放和几个开关 */}
      <div data-cv-ui data-cv-tools className="absolute right-3 bottom-3 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center justify-end gap-0.5 rounded-lg border border-line bg-panel/95 p-1 text-muted">
        <Tool title="缩小（-）" onClick={() => zoomStep(0.8)}>
          <Minus size={14} />
        </Tool>
        <button data-cv-zoom title="回到 100%（1）" onClick={() => zoomStep(1 / cam.current.z)} className="h-7 w-12 cursor-pointer rounded-md text-center text-xs tabular-nums hover:bg-hover hover:text-fg">
          <span ref={zoomRef}>100%</span>
        </button>
        <Tool title="放大（+）" onClick={() => zoomStep(1.25)}>
          <Plus size={14} />
        </Tool>
        <Sep />
        <Tool title="全部放进屏幕（0）" name="fit" onClick={() => fitAll()}>
          <Maximize size={14} />
        </Tool>
        <Tool title="一键整理：所有卡片和框重新排整齐（可以撤销）" name="arrange" onClick={arrange}>
          <LayoutGrid size={14} />
        </Tool>
        {undo && (
          <Tool title="撤销刚才的整理" name="undo" onClick={undoArrange}>
            <Undo2 size={14} />
          </Tool>
        )}
        <Tool title="贴一张便签（先选中一张卡片，就贴在它旁边）" name="note" onClick={() => addNote()}>
          <StickyNote size={14} />
        </Tool>
        <Tool title="放一个小窗：终端、网页，或者一个文件" name="widget" on={adding} onClick={() => {
          setAddAt(undefined)
          setAdding((v) => !v)
        }}>
          <AppWindow size={14} />
        </Tool>
        <Tool title="新建一个 AI" name="new-agent" onClick={() => setNewAgent(true)}>
          <UserPlus size={14} />
        </Tool>
        <Tool title={lanes ? '现在是看板（按状态分列）。点一下回到画布' : '换成看板看：所有 AI 按状态分成几列'} name="lanes" on={lanes} onClick={() => setLanes((v) => !v)}>
          <Columns3 size={14} />
        </Tool>
        <Sep />
        <Tool title={saved.follow ? '镜头跟随：开着。哪个 AI 开始干活，镜头就移到它那里（点一下关掉）' : '镜头跟随：关着。点一下打开，哪个 AI 开始干活，镜头就移到它那里'} name="follow" on={!!saved.follow} onClick={() => setCanvasFlag('follow', !saved.follow)}>
          <Locate size={14} />
        </Tool>
        <Tool title={saved.hideOffline ? '离线的 AI 现在不画（点一下画出来）' : '离线的 AI 现在也画着（点一下不画）'} name="offline" on={!!saved.hideOffline} onClick={() => setCanvasFlag('hideOffline', !saved.hideOffline)}>
          {saved.hideOffline ? <EyeOff size={14} /> : <Eye size={14} />}
        </Tool>
        <Tool title={saved.noMap ? '显示小地图' : '收起小地图'} name="map" on={!saved.noMap} onClick={() => setCanvasFlag('noMap', !saved.noMap)}>
          <MapIcon size={14} />
        </Tool>
        <Tool title="怎么用" name="help" on={help} onClick={() => setHelp((v) => !v)}>
          <HelpCircle size={14} />
        </Tool>
      </div>

      {help && (
        <div data-cv-ui data-cv-help className="absolute right-3 bottom-14 w-72 rounded-xl border border-line bg-panel/97 p-3 text-xs leading-5 text-muted shadow-[0_8px_30px_rgba(0,0,0,0.45)]">
          <div className="mb-1 font-semibold text-fg">画布怎么用</div>
          <div>拖空白处：移动画面（按住空格拖也行）</div>
          <div>滚轮：缩放；触控板两指滑动：移动画面</div>
          <div>点卡片：选中，右边出详情，可以直接在那里和它说话、看它改了什么；双击：去群聊</div>
          <div>拖卡片、拖框的标题：挪位置，位置会记住</div>
          <div>卡片右边的小圆点：按住拖到另一个 AI 上，派活或者连接力线；拖到别的项目的框上，加进那个项目的分工</div>
          <div>框下面「没人接」的任务：拖到一个 AI 上，交给它</div>
          <div>框标题上的小人：分工和团队模板；右下角的便签：贴一张便签</div>
          <div>把 AI 的卡片拖进另一个项目的框里松手：加进那个项目的分工</div>
          <div>右下角：小窗（终端、网页、文件，拖标题挪、拖右下角改大小）、新建 AI、看板</div>
          <div>从电脑上拖文件进来：拖到 AI 上让它看，拖到空白处开成文件小窗</div>
          <div>手机上：一根手指拖，两根手指缩放</div>
          <div>右键（手机上长按）：卡片、框、便签、小窗、空白处各有一个菜单</div>
          <div>按住 Shift 拖空白处：框选多张卡片，右边可以一句话发给它们</div>
          <div>方向键：换到旁边的卡片；回车：和它说话</div>
          <div>/ 或 Ctrl+F：搜索；0：全部放进屏幕；1：100%</div>
          <div className="mt-1 text-faint">线：虚线是主脑带的子代理，实线是派的活（蓝色在做，黄色等验收，红色受阻），紫色点划线是接力</div>
        </div>
      )}
    </div>
    {/* 右键菜单放在画布外面：它是画在 body 上的，但 React 的事件会顺着这里往上冒，放在里面的话在菜单上按键、点鼠标都会被画布当成自己的 */}
    {ctx.menu}
    </>
  )
}

function moveByMap(e: ReactPointerEvent<HTMLDivElement>, m: { s: number; ox: number; oy: number }, host: HTMLDivElement | null, cam: { current: Camera }, apply: () => void, stopFly: () => void): void {
  if (!host) return
  stopFly()
  const r = e.currentTarget.getBoundingClientRect()
  const x = (e.clientX - r.left - m.ox) / m.s
  const y = (e.clientY - r.top - m.oy) / m.s
  const z = cam.current.z
  cam.current = { x: host.clientWidth / 2 - x * z, y: host.clientHeight / 2 - y * z, z }
  apply()
}

function Pill({ children, title, tone, on = true, strong, onClick }: { children: ReactNode; title: string; tone?: 'accent' | 'warn'; on?: boolean; strong?: boolean; onClick?: () => void }) {
  const cls = cx(
    'inline-flex h-7 items-center rounded-full border px-2.5 whitespace-nowrap',
    !on || !tone ? 'border-line bg-panel/95 text-muted' : tone === 'accent' ? 'border-accent/40 bg-panel/95 text-accent' : strong ? 'border-warn/60 bg-warn/20 font-semibold text-warn' : 'border-warn/40 bg-panel/95 text-warn',
    onClick && on && 'cursor-pointer hover:brightness-125'
  )
  return onClick && on ? (
    <button title={title} onClick={onClick} className={cls}>
      {children}
    </button>
  ) : (
    <span title={title} className={cls}>
      {children}
    </span>
  )
}

function Tool({ children, title, name, on, onClick }: { children: ReactNode; title: string; name?: string; on?: boolean; onClick: () => void }) {
  return (
    <button data-cv-tool={name} aria-pressed={on === undefined ? undefined : on} title={title} aria-label={title} onClick={onClick} className={cx('inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md hover:bg-hover hover:text-fg', on && 'bg-accent/15 text-accent')}>
      {children}
    </button>
  )
}

const Sep = (): ReactNode => <span className="mx-0.5 h-4 w-px bg-line" />

// ========== 右边的详情 ==========

/** 卡片面板里直接回答 AI 提的问题，不用跳去任务页 */
/**
 * 交上来的活，在面板里直接办：
 * - 做完了、等你看一眼（delivered）：「看过了」，或者「退回」加一句话。用户派的活 AI 一交就算完成（不经过「待审」），
 *   所以退回 = 把任务改回「进行中」，再在项目群里 @ 它说一声（改状态本身不会通知它）
 * - 待审（review，少见：用户自己把任务设成待审时）：「通过」或「退回」
 */
function ReviewBox({ kind, taskId, taskRef, workspaceId, agentName, onAck }: { kind: 'review' | 'delivered'; taskId?: string; taskRef: string; workspaceId: string; agentName: string; onAck: () => void }) {
  const [open, setOpen] = useState(kind === 'review')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const said = note.trim()
  const run = (job: () => Promise<unknown>): void => {
    if (busy) return
    setBusy(true)
    setError('')
    job()
      .then(() => setNote(''))
      .catch((e) => setError(errText(e)))
      .finally(() => setBusy(false))
  }
  const sendBack = (): void => {
    if (!taskId) return
    if (!said) {
      setError('退回要写一句为什么，对方才知道改什么')
      return
    }
    run(async () => {
      if (kind === 'review') {
        await window.bridge.reviewTask(taskId, 'reject', said, workspaceId)
        return
      }
      await window.bridge.setTaskStatus(taskId, 'in_progress', said, workspaceId)
      try {
        await sendGroupChat({ channel: `ws:${workspaceId}`, text: `${mentionText(agentName)}${taskRef} 退回，请接着改：${said}` })
      } catch (e) {
        throw new Error(`任务已经改回「进行中」，但没能在群里告诉 ${agentName}：${errText(e)}。请自己跟它说一声`)
      }
    })
  }
  const btn = 'inline-flex h-6 items-center gap-1 rounded-md border px-1.5'
  return (
    <div data-cv-review={taskRef} data-kind={kind} className="mx-2 mb-1.5">
      {open && taskId && (
        <textarea
          value={note}
          rows={2}
          autoFocus={kind === 'delivered'}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder={kind === 'review' ? '说一句（通过可以不写，退回要写）' : '哪里不行、要改什么'}
          className="mb-1 w-full resize-none rounded-md border border-line bg-canvas px-2 py-1 text-fg outline-none placeholder:text-faint focus:border-accent"
        />
      )}
      <div className="flex flex-wrap items-center gap-1">
        {kind === 'delivered' && !open && (
          <button data-cv-ack={taskRef} onClick={onAck} className={cx(btn, 'cursor-pointer border-line text-muted hover:bg-hover hover:text-fg')}>
            <CheckCheck size={12} /> 看过了
          </button>
        )}
        {kind === 'review' && taskId && (
          <button data-cv-review-accept disabled={busy} onClick={() => run(() => window.bridge.reviewTask(taskId, 'accept', said || undefined, workspaceId))} className={cx(btn, busy ? 'cursor-not-allowed border-line text-faint' : 'cursor-pointer border-ok/50 text-ok hover:bg-ok/10')}>
            <CheckCheck size={12} /> 通过
          </button>
        )}
        {taskId && !open && (
          <button data-cv-review-open onClick={() => setOpen(true)} title="把这件活退回去接着改：写一句哪里不行" className={cx(btn, 'cursor-pointer border-line text-muted hover:bg-hover hover:text-fg')}>
            退回…
          </button>
        )}
        {taskId && open && (
          <button data-cv-review-reject disabled={busy} onClick={sendBack} className={cx(btn, busy ? 'cursor-not-allowed border-line text-faint' : 'cursor-pointer border-bad/50 text-bad hover:bg-bad/10')}>
            {kind === 'review' ? '退回' : `退回给 ${agentName}`}
          </button>
        )}
        {kind === 'delivered' && open && (
          <button
            data-cv-review-cancel
            disabled={busy}
            onClick={() => {
              setOpen(false)
              setError('')
            }}
            className={cx(btn, 'cursor-pointer border-line text-muted hover:bg-hover hover:text-fg')}
          >
            算了
          </button>
        )}
      </div>
      {error && <div className="mt-1 text-bad">{error}</div>}
    </div>
  )
}

function AnswerBox({ taskId, questionId, workspaceId }: { taskId?: string; questionId: string; workspaceId: string }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!taskId) return null
  const ok = text.trim().length > 0 && !busy
  const send = (): void => {
    if (!ok) return
    setBusy(true)
    setError('')
    window.bridge
      .answerTaskQuestion(taskId, questionId, text.trim(), workspaceId)
      .then(() => setText(''))
      .catch((e) => setError(errText(e)))
      .finally(() => setBusy(false))
  }
  return (
    <div data-cv-answer={questionId} className="mx-2 mb-1.5">
      <div className="flex items-end gap-1">
        <textarea
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          placeholder="在这里直接回答（回车发出）"
          className="min-h-7 flex-1 resize-none rounded-md border border-line bg-canvas px-2 py-1 text-fg outline-none placeholder:text-faint focus:border-accent"
        />
        <button data-cv-answer-send disabled={!ok} onClick={send} className={cx('h-7 shrink-0 rounded-md px-2 font-medium', ok ? 'cursor-pointer bg-accent/90 text-[#0d1117] hover:bg-accent' : 'cursor-not-allowed bg-raised text-faint')}>
          回答
        </button>
      </div>
      {error && <div className="mt-1 text-bad">{error}</div>}
    </div>
  )
}

function DetailHead({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="mb-2 flex items-start gap-2">
      <div className="min-w-0 flex-1">{children}</div>
      <button title="关掉（Esc）" aria-label="关掉" onClick={onClose} className="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-faint hover:bg-hover hover:text-fg">
        <X size={14} />
      </button>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-3">
      <div className="mb-1 text-[11px] font-medium text-faint">{title}</div>
      {children}
    </div>
  )
}

const rowBtn = 'block w-full cursor-pointer rounded-md px-2 py-1 text-left hover:bg-hover'

function CardDetail({ card, fill, board, state, now, kind, taskIdOf, onAssign, onOpenTask, onLine, onClose }: { card: BoardCard; fill?: { text: string; seq: number }; board: Board; state: BridgeState; now: number; kind?: AgentKind; taskIdOf: (ws: string, ref: string) => string | undefined; onAssign: (ws: string, toId: string) => void; onOpenTask: (ws: string, ref: string) => void; onLine: (id: string) => void; onClose: () => void }) {
  const st = state.memberStatus?.[card.id]
  const view = st ? describeMemberStatus(st, now) : undefined
  const meta = CARD_STATE[card.state]
  const group = board.groups.find((g) => g.id === card.groupId)
  const wsName = (id: string): string => state.workspaces.find((w) => w.id === id)?.name ?? id
  const name = (key: string): string => (key === CANVAS_USER_ID ? '你' : (board.cards.find((c) => c.key === key)?.name ?? agentOfKey(key) ?? key))
  const touching = board.lines.filter((l) => l.kind === 'task' && (l.from === card.key || l.to === card.key))
  // 派活建在哪个项目里：它自己的项目；没进项目的，用第一个项目
  const assignWs = group?.workspaceId ?? board.groups.find((g) => g.workspaceId)?.workspaceId
  return (
    <div data-cv-detail="card">
      <DetailHead onClose={onClose}>
        <div className="flex items-center gap-2">
          <Avatar name={card.name} color={card.color ?? '#8b949e'} size={32} active={card.state === 'working'} />
          <div className="min-w-0">
            <div className="flex items-center gap-1 text-sm font-semibold text-fg">
              <span className="truncate">{card.name}</span>
              {card.lead && <Crown size={13} className="shrink-0 text-warn" />}
            </div>
            <div className="truncate text-faint">
              {card.role ?? '没有职位'} · {group?.title ?? '没在项目里'}
              {card.lead ? ' · 主脑' : ''}
            </div>
            {kind && (
              <div data-cv-detail-kind className="truncate text-faint" title={kind.title}>
                {kind.kind === 'builtin' ? '内置 AI' : '外部 AI'}
                {kind.label !== '外部 AI' ? ` · ${kind.label}` : '（还不知道是哪一种，它连上一次就知道了）'}
              </div>
            )}
          </div>
        </div>
      </DetailHead>
      <div className="rounded-md bg-canvas px-2 py-1.5" title={view?.title}>
        <span style={{ color: meta.color }}>● {meta.label}</span>
        <span className="ml-2 text-muted">{view?.line ?? ''}</span>
      </div>
      <div className="mt-2 flex gap-1.5">
        <button data-cv-detail-chat onClick={() => openChat(card, board)} className="inline-flex h-7 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-accent/90 font-medium text-[#0d1117] hover:bg-accent">
          <MessageSquare size={13} /> 和它说话
        </button>
        {assignWs && (
          <button data-cv-detail-assign onClick={() => onAssign(assignWs, card.id)} className="inline-flex h-7 cursor-pointer items-center justify-center gap-1 rounded-md border border-line px-2 text-muted hover:bg-hover hover:text-fg" title="派一件活给它（建一条任务，交给它做）">
            <ListPlus size={13} /> 派活
          </button>
        )}
        <button onClick={() => navigate({ section: 'team', id: card.id })} className="inline-flex h-7 cursor-pointer items-center justify-center rounded-md border border-line px-2.5 text-muted hover:bg-hover hover:text-fg" title="到「团队与职位」里看它的设置">
          设置
        </button>
        <button
          data-cv-archive
          onClick={() => {
            act(CANVAS_ALL, [{ op: 'archive', ids: [card.id] }])
            onClose()
          }}
          className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-line text-muted hover:bg-hover hover:text-fg"
          title="收纳：先不画这张卡片（左上角「收纳」里能放回来；它有事等你时会自己出来）"
          aria-label="收纳"
        >
          <Archive size={13} />
        </button>
      </div>

      <div data-cv-talk className="mt-2">
        <CanvasComposer channel={group?.channel ?? LOBBY} targets={[{ id: card.id, name: card.name, state: card.state }]} initialText={fill?.text} initialSeq={fill?.seq} />
      </div>

      {card.attention.length > 0 && (
        <Section title={`等你处理（${card.attention.length}）`}>
          {card.attention.map((a, i) => (
            <div key={i} className={cx('mb-1 rounded-md border', a.kind === 'delivered' ? 'border-ok/30 bg-ok/5' : 'border-warn/40 bg-warn/10')}>
              <button
                data-cv-attention={a.kind}
                onClick={() => {
                  if (a.kind === 'delivered') act(a.workspaceId, [{ op: 'ackTasks', refs: [a.taskRef] }])
                  onOpenTask(a.workspaceId, a.taskRef)
                }}
                className={cx('block w-full cursor-pointer rounded-md px-2 py-1.5 text-left', a.kind === 'delivered' ? 'hover:bg-ok/10' : 'hover:bg-warn/20')}
                title={a.kind === 'delivered' ? '点一下去这条任务里看交付（算看过了）' : '点一下去这条任务里处理'}
              >
                <div className={cx('font-medium', a.kind === 'delivered' ? 'text-ok' : 'text-warn')}>
                  {ATTENTION[a.kind]} · {timeAgo(a.since, now)}
                </div>
                <div className="mt-0.5 text-fg">
                  {a.taskRef} {a.taskTitle}
                </div>
                {a.text && <div className="mt-0.5 line-clamp-4 whitespace-pre-wrap text-muted">{a.text}</div>}
              </button>
              {a.kind === 'question' && a.questionId && <AnswerBox taskId={taskIdOf(a.workspaceId, a.taskRef)} questionId={a.questionId} workspaceId={a.workspaceId} />}
              {(a.kind === 'review' || a.kind === 'delivered') && (
                <ReviewBox key={`${a.kind}:${a.taskRef}`} kind={a.kind} taskId={taskIdOf(a.workspaceId, a.taskRef)} taskRef={a.taskRef} workspaceId={a.workspaceId} agentName={card.name} onAck={() => act(a.workspaceId, [{ op: 'ackTasks', refs: [a.taskRef] }])} />
              )}
            </div>
          ))}
        </Section>
      )}

      <Section title={`手上进行中的任务（${card.tasks.length}）`}>
        {card.tasks.length === 0 && <div className="px-2 text-faint">没有</div>}
        {card.tasks.map((t) => (
          <button key={`${t.workspaceId}:${t.ref}`} onClick={() => onOpenTask(t.workspaceId, t.ref)} className={rowBtn}>
            <span className="text-fg">{t.ref}</span> <span className="text-muted">{t.title}</span>
            {t.workspaceId !== card.groupId && <span className="text-faint">（{wsName(t.workspaceId)}）</span>}
          </button>
        ))}
      </Section>

      {touching.length > 0 && (
        <Section title="派活的线">
          {touching.map((l) => (
            <button key={l.id} onClick={() => onLine(l.id)} className={rowBtn}>
              <span className="text-fg">
                {name(l.from)} → {name(l.to)}
              </span>
              <span className="ml-1" style={{ color: LINE_COLOR[l.state ?? 'todo'] }}>
                {l.tasks?.length ?? 0} 个任务 · {STATUS_META[l.state ?? 'todo'].label}
              </span>
            </button>
          ))}
        </Section>
      )}

      {group?.workspaceId && (
        <div data-cv-changes className="mt-3">
          <AgentChanges state={state} agentId={card.id} workspaceId={group.workspaceId} />
        </div>
      )}

      <Section title="最后做的一件事">
        {card.last ? (
          <div className={cx('px-2', card.last.failed ? 'text-bad' : 'text-muted')}>
            {toolLabel(card.last.tool)}
            {card.last.text ? ` ${card.last.text}` : ''}
            {card.last.failed ? '（失败）' : ''} · {timeAgo(card.last.ts, now)}
          </div>
        ) : (
          <div className="px-2 text-faint">这次打开工作台以来还没有记录</div>
        )}
      </Section>
    </div>
  )
}

/** 「放一个小窗」的小表单：哪一种、哪个项目、网址或者文件路径 */
function AddWidget({ workspaces, initial, onAdd, onClose }: { workspaces: BridgeState['workspaces']; initial?: string; onAdd: (kind: CanvasWidgetKind, workspaceId: string, value: string) => void; onClose: () => void }) {
  const [kind, setKind] = useState<CanvasWidgetKind>('terminal')
  const [ws, setWs] = useState(() => (workspaces.some((w) => w.id === initial) ? initial! : (workspaces[0]?.id ?? '')))
  const [value, setValue] = useState('')
  const v = value.trim()
  const url = kind === 'web' ? (/^[a-z]+:\/\//i.test(v) ? v : v ? `http://${v}` : '') : v
  const ok = !!ws && (kind === 'terminal' || !!v)
  const submit = (): void => {
    if (ok) onAdd(kind, ws, kind === 'web' ? url : v.replace(/\\/g, '/'))
  }
  return (
    <div data-cv-ui data-cv-add-widget className="absolute right-3 bottom-14 z-10 w-72 rounded-xl border border-line bg-panel/97 p-3 text-xs shadow-[0_8px_30px_rgba(0,0,0,0.45)]">
      <div className="mb-2 flex items-center">
        <span className="font-semibold text-fg">放一个小窗</span>
        <button onClick={onClose} aria-label="关闭" className="ml-auto inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-faint hover:bg-hover hover:text-fg">
          <X size={13} />
        </button>
      </div>
      <div className="mb-2 flex gap-1">
        {(Object.keys(WIDGET_KIND) as CanvasWidgetKind[]).map((k) => (
          <button key={k} data-cv-widget-kind={k} aria-pressed={kind === k} onClick={() => setKind(k)} className={cx('h-7 flex-1 cursor-pointer rounded-md border', kind === k ? 'border-accent bg-accent/15 text-fg' : 'border-line text-muted hover:bg-hover hover:text-fg')}>
            {WIDGET_KIND[k]}
          </button>
        ))}
      </div>
      <label className="mb-2 block">
        <span className="mb-1 block text-faint">{kind === 'terminal' ? '在哪个项目的文件夹里开' : kind === 'file' ? '哪个项目的文件' : '记在哪个项目名下'}</span>
        <select value={ws} onChange={(e) => setWs(e.target.value)} className="h-7 w-full rounded-md border border-line bg-canvas px-1.5 text-fg outline-none focus:border-accent">
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      {kind !== 'terminal' && (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') submit()
            else if (e.key === 'Escape') onClose()
          }}
          placeholder={kind === 'web' ? '网址，比如 localhost:5173' : '文件路径（从项目文件夹算起），比如 src/App.tsx'}
          className="mb-2 h-7 w-full rounded-md border border-line bg-canvas px-2 text-fg outline-none placeholder:text-faint focus:border-accent"
        />
      )}
      <button data-cv-widget-add disabled={!ok} onClick={submit} className={cx('h-7 w-full rounded-md font-medium', ok ? 'cursor-pointer bg-accent/90 text-[#0d1117] hover:bg-accent' : 'cursor-not-allowed bg-raised text-faint')}>
        放到画布上
      </button>
      {kind === 'file' && <div className="mt-1.5 text-faint">也可以直接把文件从电脑上拖到画布的空白处</div>}
    </div>
  )
}

/** 拉线之后的「派活 / 接力」弹窗：现算一份包含所有 AI 的项目模型给它（画布上那份只有牵涉到的 AI） */
function AssignHost({ state, events, tasksByWs, req, relays, onClose }: Props & { req: AssignReq; relays: CanvasRelay[]; onClose: () => void }) {
  const model = useMemo(
    () =>
      buildCanvasModel({
        agents: state.agents,
        roles: state.roles,
        memberStatus: state.memberStatus,
        workspaceId: req.ws,
        tasks: tasksByWs[req.ws] ?? [],
        channel: state.chat?.channels.find((c) => c.id === `ws:${req.ws}`),
        events,
        relays,
        memberIds: state.agents.map((a) => a.id)
      }),
    [state.agents, state.roles, state.memberStatus, state.chat?.channels, tasksByWs, events, relays, req.ws]
  )
  return (
    <div
      data-cv-ui
      data-cv-assign
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/45"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <AssignDialog state={state} model={model} relays={relays} workspaceId={req.ws} fromId={req.fromId} toId={req.toId} taskRef={req.taskRef} onClose={onClose} onDone={onClose} />
    </div>
  )
}

function RelayDetail({ line, byKey, workspaces, onClose, onShow }: { line: BoardLine; byKey: Map<string, BoardCard>; workspaces: BridgeState['workspaces']; onClose: () => void; onShow: (key: string) => void }) {
  const name = (key: string): string => byKey.get(key)?.name ?? key
  return (
    <div data-cv-detail="relay">
      <DetailHead onClose={onClose}>
        <div className="text-sm font-semibold text-fg">
          <button className="cursor-pointer hover:underline" onClick={() => onShow(line.from)}>
            {name(line.from)}
          </button>
          <span className="mx-1 text-faint">做完自动转告</span>
          <button className="cursor-pointer hover:underline" onClick={() => onShow(line.to)}>
            {name(line.to)}
          </button>
        </div>
        <div className="text-faint">接力线 · {workspaces.find((w) => w.id === line.workspaceId)?.name ?? line.workspaceId}</div>
      </DetailHead>
      <div className="px-1 leading-5 text-muted">
        {name(line.from)} 在这个项目里每做完一条任务，工作台自动给 {name(line.to)} 发一条通知，带上交付说明，让它接着做。
      </div>
      {line.workspaceId && line.relayId && (
        <button
          data-cv-relay-remove
          onClick={() => {
            act(line.workspaceId!, [{ op: 'removeRelay', id: line.relayId! }])
            onClose()
          }}
          className="mt-2 inline-flex h-7 cursor-pointer items-center rounded-md border border-bad/40 px-2.5 text-bad hover:bg-bad/10"
        >
          删掉这条接力线
        </button>
      )}
    </div>
  )
}

function LineDetail({ line, byKey, workspaces, onOpenTask, onClose, onShow }: { line: BoardLine; byKey: Map<string, BoardCard>; workspaces: BridgeState['workspaces']; onOpenTask: (ws: string, ref: string) => void; onClose: () => void; onShow: (key: string) => void }) {
  const name = (key: string): string => byKey.get(key)?.name ?? key
  return (
    <div data-cv-detail="line">
      <DetailHead onClose={onClose}>
        <div className="text-sm font-semibold text-fg">
          <button className="cursor-pointer hover:underline" onClick={() => onShow(line.from)}>
            {name(line.from)}
          </button>
          <span className="mx-1 text-faint">派给</span>
          <button className="cursor-pointer hover:underline" onClick={() => onShow(line.to)}>
            {name(line.to)}
          </button>
        </div>
        <div className="text-faint">{line.tasks?.length ?? 0} 个没做完的任务</div>
      </DetailHead>
      {(line.tasks ?? []).map((t) => (
        <button key={`${t.workspaceId}:${t.ref}`} onClick={() => onOpenTask(t.workspaceId, t.ref)} className={rowBtn}>
          <span className="mr-1.5 rounded px-1 py-px text-[11px]" style={{ color: LINE_COLOR[t.status], background: `${LINE_COLOR[t.status]}22` }}>
            {STATUS_META[t.status].label}
          </span>
          <span className="text-fg">{t.ref}</span> <span className="text-muted">{t.title}</span>
          <span className="text-faint">（{workspaces.find((w) => w.id === t.workspaceId)?.name ?? t.workspaceId}）</span>
        </button>
      ))}
    </div>
  )
}

function ManyDetail({ keys, byKey, groups, total, onShow, onClose }: { keys: string[]; byKey: Map<string, BoardCard>; groups: BoardGroup[]; total: number; onShow: (key: string) => void; onClose: () => void }) {
  const onlyUser = keys.length === 1 && keys[0] === CANVAS_USER_ID
  const agents = keys.map((k) => byKey.get(k)).filter((c): c is BoardCard => !!c && c.kind === 'agent')
  // 都在一个项目里：发到那个项目的群；跨了项目：发到大厅，谁都看得到
  const groupIds = new Set(agents.map((c) => c.groupId))
  const channel = groupIds.size === 1 ? (groups.find((g) => g.id === agents[0]?.groupId)?.channel ?? LOBBY) : LOBBY
  return (
    <div data-cv-detail="many">
      <DetailHead onClose={onClose}>
        <div className="text-sm font-semibold text-fg">{onlyUser ? '你' : `选中了 ${keys.length} 张卡片`}</div>
        <div className="text-faint">{onlyUser ? (total ? `现在有 ${total} 件事等你处理，卡片上有黄色的「等你」` : '从你这里连出去的线，是你派出去还没做完的活') : '拖其中一张可以一起挪'}</div>
      </DetailHead>
      {!onlyUser &&
        keys.map((k) => {
          const c = byKey.get(k)
          if (!c) return null
          return (
            <button key={k} onClick={() => onShow(k)} className={cx(rowBtn, 'flex items-center gap-2')}>
              <i className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: CARD_STATE[c.state].color }} />
              <span className="truncate text-fg">{c.name}</span>
              <span className="ml-auto shrink-0 text-faint">{CARD_STATE[c.state].label}</span>
            </button>
          )
        })}
      {!onlyUser && agents.length > 0 && (
        <div data-cv-talk className="mt-2">
          <div className="mb-1 px-1 text-faint">{groupIds.size === 1 ? '一句话发给这几个（发在它们项目的群里）' : '一句话发给这几个（它们不在一个项目里，发在大厅）'}</div>
          <CanvasComposer channel={channel} targets={agents.map((c) => ({ id: c.id, name: c.name, state: c.state }))} />
        </div>
      )}
    </div>
  )
}

// ========== 侧栏：AI 名单 ==========

export function CanvasRoster(props: Props) {
  const saved = useCanvasSaved()
  const ui = useCanvasUi()
  const board = useBoard(props, !!saved.hideOffline)
  const byKey = useMemo(() => new Map(board.cards.map((c) => [c.key, c])), [board.cards])
  const query = ui.query.trim()
  const sel = new Set(ui.selected)
  return (
    <div data-cv-roster className="flex h-full flex-col">
      <div className="shrink-0 px-3 pt-3 pb-2">
        <div className="mb-2 text-xs font-semibold text-fg">画布上的 AI</div>
        <label className="flex h-7 items-center gap-1.5 rounded-md border border-line bg-canvas px-2 text-muted focus-within:border-accent">
          <Search size={13} />
          <input value={ui.query} onChange={(e) => setCanvasQuery(e.target.value)} placeholder="找 AI 或任务" className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-faint" />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {board.groups.map((g) => {
          const rows = g.cardKeys.map((k) => byKey.get(k)).filter((c): c is BoardCard => !!c && matchesQuery(query, [c.name, c.role, ...c.tasks.map((t) => `${t.ref} ${t.title}`)]))
          if (query && rows.length === 0) return null
          return (
            <div key={g.id} className="mt-1.5">
              <button data-cv-roster-group={g.id} onClick={() => focusOnCanvas('group', g.id)} title="点一下，镜头移到这个框" className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] font-medium text-faint hover:bg-hover hover:text-fg">
                {g.kind === 'lobby' ? <UsersRound size={12} /> : <FolderGit2 size={12} />}
                <span className="truncate">{g.title}</span>
                <span className="ml-auto shrink-0">{g.cardKeys.length}</span>
              </button>
              {rows.length === 0 && <div className="px-6 py-0.5 text-[11px] text-faint">没有 AI</div>}
              {rows.map((c) => (
                <button
                  key={c.key}
                  data-cv-roster-row={c.key}
                  onClick={() => focusOnCanvas('card', c.key)}
                  title="点一下，镜头移到这张卡片"
                  className={cx('flex w-full cursor-pointer items-center gap-2 rounded-md py-1 pr-1.5 pl-5 text-left text-xs hover:bg-hover', sel.has(c.key) && 'bg-hover')}
                >
                  <i className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: CARD_STATE[c.state].color }} />
                  <span className={cx('truncate', c.state === 'offline' ? 'text-muted' : 'text-fg')}>{c.name}</span>
                  {c.lead && <Crown size={11} className="shrink-0 text-warn" />}
                  {c.attention.length > 0 ? <span className="ml-auto shrink-0 rounded bg-warn/15 px-1 text-[11px] font-medium text-warn">等你 {c.attention.length}</span> : <span className="ml-auto shrink-0 text-[11px] text-faint">{CARD_STATE[c.state].label}</span>}
                </button>
              ))}
            </div>
          )
        })}
        {board.groups.length === 0 && <div className="px-3 py-2 text-xs text-faint">还没有项目和 AI</div>}
      </div>
    </div>
  )
}
