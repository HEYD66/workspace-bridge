// 群聊：侧栏频道列表 + 成员列表，主区消息流和输入框（.team/chat-contract.md「界面」）
import { ArrowDown, ArrowUp, AtSign, Check, ChevronDown, ChevronRight, Copy, Crown, FileDiff, FolderOpen, ImagePlus, ListTodo, Loader2, Lock, MessageSquare, MessagesSquare, Quote as QuoteIcon, Reply, TextSelect, UserMinus, UserPlus, UserRound, Users, UsersRound, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { ImageViewer, imageMenu, MessageImages, PendingImages } from '../components/ChatImages'
import { useContextMenu, type MenuEntry } from '../components/ContextMenu'
import { MemberStatusDot, MemberStatusLine } from '../components/MemberStatusBadge'
import { describeMemberStatus, isBusy, MEMBER_STATUS_META, memberStatusOf } from '../lib/memberStatus'
import { headerStatus, lastHeaders, liveActivity, useLiveEvents, type LiveView } from '../lib/liveActivity'
import { changeCards, useWorkspaceSteps, type ChangeCard } from '../lib/changeCards'
import {
  buildSendInput,
  canSend,
  chatImageApi,
  checkImages,
  droppedFiles,
  getPendingImages,
  IMAGE_ACCEPT,
  imagesLabel,
  MAX_IMAGES,
  messageImages,
  pastedFiles,
  setPendingImages,
  toPending,
  uploadAll,
  usePendingImages,
  type ChatAttachment
} from '../lib/chatImages'
import type { Agent, BridgeState, GroupMessage, MemberStatus, Role, WorkspaceView } from '../../../core/types'
import { Avatar, Badge, Button, ConfirmButton, cx, EmptyState, IconButton, PanelHeader, Segmented } from '../components/ui'
import { clockTime, errText, toolLabel } from '../lib/format'
import {
  addMessages,
  appendToDraft,
  applyMention,
  audienceLabel,
  buildRows,
  canAccess,
  channelFullName,
  channelInfo,
  channelsOf,
  involves,
  leadOf,
  loadLatest,
  loadOlder,
  PAGE,
  trimToLatest,
  LOBBY,
  markGroupChatRead,
  MAX_TEXT,
  memberName,
  mentionOptions,
  mentionQuery,
  mentionsUser,
  mentionText,
  modeLine,
  privateLabel,
  pruneCleared,
  quoteBlock,
  senderOf,
  sendGroupChat,
  setDraft,
  setGroupChatLead,
  setGroupChatParticipants,
  setGroupChatSubs,
  setMemberFilter,
  setModeError,
  snippet,
  partsOf,
  subsOf,
  subsToSave,
  teamRole,
  useDraft,
  useGroupMessages,
  useMemberFilter,
  useModeError,
  USER_COLOR,
  type MentionOption,
  type TeamRole
} from '../lib/groupChat'
import { MARKDOWN_CLASS, renderMarkdown } from '../lib/markdown'
import { navigate } from '../lib/nav'
import { noHover } from '../lib/phone'
import { showChanges } from '../lib/rightPanel'
import { channelWorkspaceId } from '../lib/groupChat'
import { editWorkspaceMembers } from '../lib/workspaceDialog'

function isOnline(state: BridgeState, agentId: string): boolean {
  return state.presence.some((p) => p.agentId === agentId && p.sessions > 0)
}

function focusComposer(): void {
  requestAnimationFrame(() => document.getElementById('group-composer')?.focus())
}

/** 私聊都在大厅：切到大厅，把私聊对象填进大厅的草稿 */
function startPrivate(agentId: string): void {
  setDraft(LOBBY, { to: agentId })
  navigate({ section: 'group', id: LOBBY })
  focusComposer()
}

/** 在某个频道的输入框末尾 @ 一个 AI */
function mentionInto(channel: string, name: string): void {
  appendToDraft(channel, mentionText(name))
  focusComposer()
}

function copyText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text)
}

/**
 * 成员的右键菜单：@他、私聊、只看他的消息、复制名字（和行上的按钮做同样的事）；设为 / 取消这个频道的主脑；
 * 「分工明确」时另有 加入 / 移出子代理（team：这个 AI 现在的角色，和改名单要用的现有子代理、候选人）
 */
function memberMenu(
  a: Agent,
  channel: string,
  filtering: boolean,
  team: { role: TeamRole; subs: string[]; candidates: string[] } | undefined,
  parts?: { ids: string[]; all: string[] }
): MenuEntry[] {
  const isLead = team?.role === 'lead'
  // 灵感激荡：加入 / 移出讨论（最后一个参与的不能移出）
  const partEntry: MenuEntry[] = !parts
    ? []
    : parts.ids.includes(a.id)
      ? [
          {
            id: 'part',
            label: '移出讨论（这个频道的消息它收不到）',
            icon: <UserMinus size={13} />,
            disabled: parts.ids.length <= 1 ? '至少留一个 AI 参与' : false,
            run: () => setGroupChatParticipants(channel, subsToSave(parts.ids.filter((id) => id !== a.id), parts.all))
          }
        ]
      : [{ id: 'part', label: '加入讨论', icon: <UserPlus size={13} />, run: () => setGroupChatParticipants(channel, subsToSave([...parts.ids, a.id], parts.all)) }]
  const subEntry: MenuEntry[] =
    team?.role === 'sub'
      ? [{ id: 'sub', label: '移出子代理（这次分工不用它）', icon: <UserMinus size={13} />, run: () => setGroupChatSubs(channel, subsToSave(team.subs.filter((id) => id !== a.id), team.candidates)) }]
      : team?.role === 'out'
        ? [{ id: 'sub', label: '加入子代理', icon: <UserPlus size={13} />, run: () => setGroupChatSubs(channel, subsToSave([...team.subs, a.id], team.candidates)) }]
        : []
  return [
    { id: 'at', label: `@${a.name}`, icon: <AtSign size={13} />, run: () => mentionInto(channel, a.name) },
    { id: 'dm', label: '私聊（在大厅）', icon: <Lock size={13} />, run: () => startPrivate(a.id) },
    '-',
    filtering
      ? { id: 'filter', label: '看全部消息', icon: <UsersRound size={13} />, run: () => setMemberFilter(undefined) }
      : { id: 'filter', label: '只看他的消息', icon: <UserRound size={13} />, run: () => setMemberFilter(a.id) },
    { id: 'copy-name', label: '复制名字', icon: <Copy size={13} />, run: () => copyText(a.name) },
    '-',
    isLead
      ? { id: 'lead', label: '取消主脑（改回灵感激荡）', icon: <Crown size={13} />, run: () => setGroupChatLead(channel, null) }
      : { id: 'lead', label: '设为主脑（分工明确）', icon: <Crown size={13} />, run: () => setGroupChatLead(channel, a.id) },
    ...subEntry,
    ...partEntry
  ]
}

/** 消息的右键菜单：回复、引用、复制、@发言人、私聊。selected：右键时在这条消息里选中的文字；
 *  image：右键点在哪张图上（有就先列「查看大图 / 复制图片 / 另存为」） */
function messageMenu(m: GroupMessage, agents: Agent[], selected: string, image?: { att: ChatAttachment; open: (a: ChatAttachment) => void }): MenuEntry[] {
  const s = senderOf(m, agents)
  const ch = m.channel || LOBBY
  const isAgent = m.from.kind === 'agent'
  const notAgent = '这是你自己发的'
  return [
    ...(image ? [...imageMenu(image.att, image.open), '-' as const] : []),
    { id: 'reply', label: '回复', icon: <Reply size={13} />, run: () => replyTo(m) },
    {
      id: 'quote',
      label: '引用到输入框',
      icon: <QuoteIcon size={13} />,
      run: () => {
        // 引用私聊时接着私聊对方，和「回复」一样
        appendToDraft(ch, quoteBlock(selected || m.text, s.name), m.to ? { to: isAgent ? m.from.id : m.to } : {})
        focusComposer()
      }
    },
    '-',
    { id: 'copy-sel', label: '复制选中的文字', icon: <TextSelect size={13} />, disabled: selected ? false : '先在这条消息里选中一段文字', run: () => copyText(selected) },
    { id: 'copy', label: '复制整条消息', icon: <Copy size={13} />, disabled: m.text ? false : '这条消息没有文字', run: () => copyText(m.text) },
    '-',
    { id: 'at', label: `@${s.name}`, icon: <AtSign size={13} />, disabled: isAgent ? false : notAgent, run: () => mentionInto(ch, s.name) },
    { id: 'dm', label: `私聊给 ${s.name}`, icon: <Lock size={13} />, disabled: isAgent ? false : notAgent, run: () => startPrivate(m.from.id) },
    { id: 'filter', label: `只看 ${s.name} 的消息`, icon: <UserRound size={13} />, disabled: isAgent ? false : notAgent, run: () => setMemberFilter(m.from.id) }
  ]
}

/** 右键时选中的文字：只算落在 el 里的 */
function selectionIn(el: Element): string {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.anchorNode || !sel.focusNode) return ''
  if (!el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) return ''
  return sel.toString().trim()
}

// ========== 侧栏：频道 + 成员 ==========

/** channel：当前频道（已经按 resolveChannel 定好）；onSelect 切频道 */
export function GroupMembers({ state, channel, onSelect }: { state: BridgeState; channel: string; onSelect: (ch: string) => void }) {
  const selected = useMemberFilter()
  const agents = state.agents
    .filter((a) => canAccess(a, channel, state.workspaces ?? []))
    .sort((a, b) => Number(isOnline(state, b.id)) - Number(isOnline(state, a.id)))
  const online = agents.filter((a) => isOnline(state, a.id)).length
  const lead = leadOf(state, channel)
  const subs = subsOf(state, channel, agents)
  const candidates = lead ? agents.filter((a) => a.id !== lead.id).map((a) => a.id) : []
  const parts = partsOf(state, channel, agents)
  const allIds = agents.map((a) => a.id)
  const ctx = useContextMenu()
  return (
    <div className="flex h-full flex-col overflow-auto pb-4">
      {ctx.menu}
      <PanelHeader title="频道" />
      {/* 归档的会话不列（正在看的那个除外） */}
      {channelsOf(state)
        .filter((c) => !c.thread?.archived || c.id === channel)
        .map((c) => (
        <MemberRow
          key={c.id}
          name={c.thread?.archived ? `${c.name}（已归档）` : channelFullName(c)}
          selected={c.id === channel}
          onClick={() => {
            // 换频道时清掉成员过滤，不然新频道里可能一条都看不到
            if (c.id !== channel) setMemberFilter(undefined)
            onSelect(c.id)
          }}
          icon={c.id === LOBBY ? <MessagesSquare size={15} className="text-muted" /> : <Users size={15} className="text-muted" />}
          badge={c.unread > 0 ? <span className={cx('min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-semibold', c.mentions ? 'bg-bad text-white' : 'bg-accent text-[#0d1117]')}>{c.unread > 99 ? '99+' : c.unread}</span> : undefined}
          bold={c.unread > 0}
          sub={modeLine(state, c.id)}
        />
      ))}

      <div className="mt-2">
        <PanelHeader title={`成员 · ${online}/${agents.length} 在线`} />
      </div>
      <MemberRow name="全部消息" selected={!selected} onClick={() => setMemberFilter(undefined)} icon={<UsersRound size={15} className="text-muted" />} />
      {agents.length === 0 && (
        <div className="px-3 py-2 text-xs leading-relaxed text-muted">{state.agents.length ? '没有能访问这个工作区的 AI。' : '还没有 AI。在团队页新建 AI 后，它们连上来就能在群里说话。'}</div>
      )}
      {agents.map((a) => {
        const p = state.presence.find((x) => x.agentId === a.id)
        const on = isOnline(state, a.id)
        // T-23：工作台给了细分状态就用它，没有就照原来显示
        const ms = memberStatusOf(state, a.id)
        const role = teamRole(state, channel, a.id)
        // 灵感激荡时挑过人、而它不在里面
        const away = !!parts?.picked && !parts.ids.includes(a.id)
        return (
          <MemberRow
            key={a.id}
            name={a.name}
            dim={role === 'out' || away}
            selected={selected === a.id}
            onClick={() => setMemberFilter(selected === a.id ? undefined : a.id)}
            onContextMenu={(e) =>
              ctx.open(e, memberMenu(a, channel, selected === a.id, role && subs ? { role, subs: subs.ids, candidates } : undefined, parts ? { ids: parts.ids, all: allIds } : undefined))
            }
            tag={role === 'lead' ? <LeadTag /> : role === 'sub' ? <SubTag /> : role === 'out' ? <OutTag /> : away ? <OutTag talk /> : undefined}
            icon={<Avatar name={a.name} color={a.color} size={22} active={ms ? isBusy(ms) : !!p?.currentTool} />}
            sub={
              ms ? (
                <MemberStatusLine status={ms} />
              ) : on ? (
                p?.currentTool ? <span className="text-accent">正在{toolLabel(p.currentTool)}</span> : <span>在线{p?.clientName ? ` · ${p.clientName}` : ''}</span>
              ) : (
                <span>离线</span>
              )
            }
            dot={ms ? undefined : on ? 'bg-ok' : 'bg-line'}
            badge={ms ? <MemberStatusDot status={ms} size={6} /> : undefined}
            action={
              <IconButton
                title={`私聊给 ${a.name}（在大厅）`}
                data-hover-reveal
                className="opacity-0 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation()
                  startPrivate(a.id)
                }}
              >
                <Lock size={12} />
              </IconButton>
            }
          />
        )
      })}
    </div>
  )
}

/** 主脑标记（成员列表、消息流里用） */
function LeadTag() {
  return (
    <span title="这个频道的主脑：其他 AI 只和它联系，活由它派" className="inline-flex shrink-0 items-center gap-0.5 rounded bg-warn/15 px-1 text-[10px] leading-4 text-warn">
      <Crown size={9} />
      主脑
    </span>
  )
}

/** 子代理标记（成员列表里用） */
function SubTag() {
  return (
    <span title="这次分工的子代理：只和主脑联系，主脑给它派活" className="shrink-0 rounded bg-accent/10 px-1 text-[10px] leading-4 text-accent">
      子代理
    </span>
  )
}

/** 没选进这次分工的成员 */
function OutTag({ talk }: { talk?: boolean }) {
  return (
    <span title={talk ? '这次讨论没有选它：这个频道的消息它收不到，它在这里发的只有你看到；你点名它照样送到。右键可以加入讨论' : '这次分工没有选它：主脑 @ 不到它、不能给它派活；它在这里发的只有你看到。右键可以加入子代理'} className="shrink-0 rounded bg-line/40 px-1 text-[10px] leading-4 text-faint">
      未参与
    </span>
  )
}

function MemberRow({
  name,
  tag,
  sub,
  icon,
  dot,
  action,
  badge,
  bold,
  dim,
  selected,
  onClick,
  onContextMenu
}: {
  name: string
  /** 名字后面的小标记 */
  tag?: ReactNode
  /** 整行调淡（这次分工没选它） */
  dim?: boolean
  sub?: ReactNode
  icon: ReactNode
  dot?: string
  action?: ReactNode
  badge?: ReactNode
  bold?: boolean
  selected: boolean
  onClick: () => void
  onContextMenu?: (e: MouseEvent) => void
}) {
  return (
    <div onClick={onClick} onContextMenu={onContextMenu} className={cx('group mx-1.5 flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-hover', selected && 'bg-accent/15')}>
      <span className={cx('flex w-[22px] shrink-0 justify-center', dim && 'opacity-50')}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className={cx('truncate text-[13px]', bold && 'font-semibold', dim && 'text-muted')}>{name}</span>
          {tag}
        </div>
        {sub && <div className="truncate text-[11px] text-muted">{sub}</div>}
      </div>
      {action}
      {badge}
      {dot && <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', dot)} />}
    </div>
  )
}

// ========== 主区 ==========

/** channel：当前频道（已经按 resolveChannel 定好）。换频道时整块重新挂载，滚动位置、已读游标都从头算 */
export function GroupMain({ state, channel }: { state: BridgeState; channel: string }) {
  return <ChannelPane key={channel} state={state} channel={channel} />
}

/** 任务详情里嵌的那条线：只有消息流和输入框，没有频道头和干活方式开关 */
export function TaskThreadPane({ state, channel }: { state: BridgeState; channel: string }) {
  return <ChannelPane key={channel} state={state} channel={channel} embedded />
}

function ChannelPane({ state, channel, embedded }: { state: BridgeState; channel: string; embedded?: boolean }) {
  // 侧栏的「只看某个成员」是给群聊页用的，嵌在任务详情里时不跟着过滤
  const memberFilter = useMemberFilter()
  const memberId = embedded ? undefined : memberFilter
  const { messages, loaded, loading, error, hasMore } = useGroupMessages(channel)
  const info = channelInfo(state, channel)
  const lobby = channel === LOBBY
  const archived = info?.thread?.archived === true
  // 频道清空过：缓存里清掉的那些消息丢掉
  useEffect(() => pruneCleared(channel, info?.floor), [channel, info?.floor])
  const workspaces = state.workspaces ?? []
  // 任务的线：里面只有这条任务的执行者、派活的人、创建者
  const taskMembers = info?.task?.memberIds
  const members = state.agents.filter((a) => (taskMembers ? taskMembers.includes(a.id) : canAccess(a, channel, workspaces)))
  const shown = useMemo(() => (memberId ? messages.filter((m) => involves(m, memberId)) : messages), [messages, memberId])
  const rows = useMemo(() => buildRows(shown), [shown])
  // 每个 AI 最近一段话的开头：名字后面挂它现在的状态
  const headers = useMemo(() => lastHeaders(rows.flatMap((r) => (r.kind === 'msg' ? [{ m: r.m, first: r.first }] : []))), [rows])
  // 你发完话到 AI 回话之间：参与的 AI 现在在干什么，摆在消息流最下面
  const liveEvents = useLiveEvents()
  const live = liveActivity({ messages, members, status: state.memberStatus, events: liveEvents, now: Date.now(), leadId: info?.leadId, partIds: info?.partIds })
  const liveKey = `${live.rows.map((r) => `${r.agentId}:${r.text}:${r.stepCount}`).join('|')}#${live.offline.length}`
  // 留在两次调用之间的那一行：到点了还没有新动作就重算一次，把它撤掉
  const [, relive] = useState(0)
  useEffect(() => {
    if (live.until === undefined) return
    const t = setTimeout(() => relive((n) => n + 1), Math.max(0, live.until - Date.now()) + 50)
    return () => clearTimeout(t)
  }, [live.until])
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages])
  // 改动卡片：工作区频道里，AI 每条消息下面挂它这一段改了哪些文件（大厅不属于哪个工作区，没有）
  const cardWs = lobby ? undefined : info?.workspaceId
  const steps = useWorkspaceSteps(cardWs)
  const cards = useMemo(() => changeCards(messages, steps), [messages, steps])
  const lastSeq = messages[messages.length - 1]?.seq ?? 0

  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  /** 用户离开底部时看到的最后一条；之后来的算「新消息」 */
  const [seenSeq, setSeenSeq] = useState(0)
  const marked = useRef(0)
  const prevHeight = useRef<number | undefined>(undefined)
  const [flash, setFlash] = useState<string>()
  /** 正在看大图的那张 */
  const [viewing, setViewing] = useState<ChatAttachment>()
  const closeViewer = useCallback(() => setViewing(undefined), [])
  const ctx = useContextMenu()

  // 在底部时跟着新消息滚；加载更早的消息后保持原来看到的位置
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (prevHeight.current !== undefined) {
      el.scrollTop += el.scrollHeight - prevHeight.current
      prevHeight.current = undefined
    } else if (stick.current) el.scrollTop = el.scrollHeight
  }, [rows])

  // 最下面那几行「他在干什么」变了，人在底部的话也跟着滚
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [liveKey])

  // 切换成员过滤后回到底部
  useLayoutEffect(() => {
    stick.current = true
    setAtBottom(true)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [memberId])

  useEffect(() => {
    if (atBottom) setSeenSeq(lastSeq)
  }, [atBottom, lastSeq])

  // 在底部、看的是全部消息、窗口可见时标记已读
  useEffect(() => {
    const mark = () => {
      if (!atBottom || memberId || document.hidden || lastSeq <= marked.current) return
      marked.current = lastSeq
      void markGroupChatRead(channel, lastSeq).catch(() => {
        marked.current = 0
      })
    }
    mark()
    document.addEventListener('visibilitychange', mark)
    return () => document.removeEventListener('visibilitychange', mark)
  }, [atBottom, memberId, lastSeq, channel])

  const newCount = atBottom ? 0 : shown.filter((m) => m.seq > seenSeq && m.from.kind !== 'user').length

  const toBottom = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    stick.current = true
    setAtBottom(true)
  }

  // 滚到顶自动加载时 onScroll 会连着触发好几次，只认第一次，免得后一次把要恢复的位置清掉
  const loadingOlder = useRef(false)
  const older = async () => {
    if (loadingOlder.current) return
    loadingOlder.current = true
    prevHeight.current = scrollRef.current?.scrollHeight
    try {
      if (!(await loadOlder(channel))) prevHeight.current = undefined
    } finally {
      loadingOlder.current = false
    }
  }

  // 停在底部、看的是全部消息时，页面上只留最新 PAGE 条；更早的收起，往上翻再加载（用户 #117）
  useEffect(() => {
    if (atBottom && !memberId && messages.length > PAGE) trimToLatest(channel)
  }, [atBottom, memberId, messages.length, channel])

  const jumpTo = (id: string) => {
    const el = document.getElementById(`gm-${id}`)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setFlash(id)
    setTimeout(() => setFlash((f) => (f === id ? undefined : f)), 1500)
  }
  const filterAgent = memberId ? state.agents.find((a) => a.id === memberId) : undefined
  const online = members.filter((a) => isOnline(state, a.id)).length
  const title = info ? channelFullName(info) : lobby ? '大厅' : channel
  const lead = leadOf(state, channel)
  const subs = subsOf(state, channel, members)
  // 挑过子代理：说明里列出是谁（多了只列前几个）
  const subNames = subs?.picked ? subs.ids.map((id) => memberName(id, state.agents)) : undefined
  const subText = subNames ? (subNames.length ? `子代理 ${subNames.slice(0, 4).join('、')}${subNames.length > 4 ? ` 等 ${subNames.length} 个` : ''}` : '没有子代理') : undefined
  // 灵感激荡时挑过参与的 AI：说明里列出是谁
  const parts = partsOf(state, channel, members)
  const partNames = parts?.picked ? parts.ids.map((id) => memberName(id, state.agents)) : undefined
  // 会话头上的头像：挑过参与的 AI 就只摆他们
  const faces = parts?.picked ? members.filter((a) => parts.ids.includes(a.id)) : members
  const partText = partNames ? `灵感激荡：只有 ${partNames.slice(0, 4).join('、')}${partNames.length > 4 ? ` 等 ${partNames.length} 个` : ''} 参与，别的 AI 收不到这里的消息（你点名的除外）` : undefined
  const modeError = useModeError()

  return (
    <div className="flex h-full min-h-0 flex-col" {...(embedded ? { 'data-task-thread-pane': channel } : {})}>
      {!embedded && (
      <div data-chat-header className="flex shrink-0 items-center gap-3 px-5 pt-3 pb-2">
        {lobby ? <MessagesSquare size={17} className="shrink-0 text-muted" /> : info?.thread ? <MessageSquare size={17} className="shrink-0 text-muted" /> : <Users size={17} className="shrink-0 text-muted" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-semibold">{title}</span>
            {memberId && (
              <Badge color={filterAgent?.color}>
                只看 {memberName(memberId, state.agents)}
                <button title="看全部消息" aria-label="看全部消息" className="cursor-pointer" onClick={() => setMemberFilter(undefined)}>
                  <X size={10} />
                </button>
              </Badge>
            )}
          </div>
          <div className="truncate text-[11px] text-faint">
            {lead
              ? subText
                ? `分工明确：主脑 ${lead.name}，${subText}；子代理只和主脑 ${lead.name} 联系${lobby ? '' : '，活由主脑派'}；你不 @ 就只发给主脑`
                : `分工明确：其他 AI 只和主脑 ${lead.name} 联系${lobby ? '' : '，活由主脑派'}；你不 @ 就只发给主脑`
              : partText && !archived
                ? partText
                : lobby
                ? '所有 AI 都在 · 私聊也在这里'
                : archived
                  ? '这个会话已归档：AI 看不到它，消息都留着'
                  : info?.thread
                    ? '这个工作区里另开的会话，只有能访问这个工作区的 AI 能看到'
                    : '这个工作区的频道，只有能访问它的 AI 能看到'}{' '}
            · {members.length} 个 AI，{online} 个在线
          </div>
        </div>
        {/* 谁在这个会话里：头像叠在一起，最多 6 个 */}
        {faces.length > 0 && (
          <div data-chat-members className="flex shrink-0 items-center -space-x-1" title={`${parts?.picked ? '参与这个会话的 AI' : '能看到这个会话的 AI'}：${faces.map((a) => `${a.name}${isOnline(state, a.id) ? '' : '（离线）'}`).join('、')}`}>
            {faces.slice(0, 6).map((a) => (
              <Avatar key={a.id} name={a.name} color={a.color} size={20} />
            ))}
            {faces.length > 6 && <span className="pl-2 text-[11px] text-faint">+{faces.length - 6}</span>}
          </div>
        )}
        {!archived && <ModeSwitch state={state} channel={channel} members={members} lead={lead} />}
      </div>
      )}
      {modeError && !embedded && (
        <div className="shrink-0 px-4">
          <ErrorLine text={`切换干活方式失败：${modeError}`} />
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget
            const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            stick.current = bottom
            if (bottom !== atBottom) setAtBottom(bottom)
            // 滚到顶附近自动加载更早的（按钮留着当后备）。同时也在底部时不加载：内容只比窗口高一点时，
            // 加载完又因为在底部被收回 100 条，会来回反复
            if (!bottom && el.scrollTop < 80 && hasMore && !memberId && !loading && loaded) void older()
          }}
          className="absolute inset-0 overflow-auto"
        >
          <div data-chat-column className="mx-auto max-w-[1280px] px-6 py-4">
            {hasMore && !memberId && (
              <div className="pb-3 text-center">
                <Button size="sm" variant="ghost" disabled={loading} onClick={() => void older()}>
                  {loading && <Loader2 size={12} className="animate-spin" />} 加载更早的消息
                </Button>
              </div>
            )}
            {!loaded && (error ? <ErrorLine text={`读取群聊失败：${error}`} onRetry={() => void loadLatest(channel)} /> : <div className="py-6 text-center text-xs text-muted">加载中…</div>)}
            {loaded && error && <ErrorLine text={error} />}
            {loaded && shown.length === 0 && (
              <EmptyState
                icon={<MessagesSquare size={28} />}
                title={memberId ? `还没有和「${memberName(memberId, state.agents)}」相关的消息` : info?.task ? '这条线里还没有东西' : `「${title}」里还没有消息`}
                hint={
                  info?.task
                    ? '派活、认领、交付、审查会自动记在这里。你在这里说的话，这条任务的执行者和派活的人能看到；别的 AI 看不到。'
                    : lead
                    ? `现在是「分工明确」：你发的消息不 @ 就只有主脑 ${lead.name} 收到，@名字 再加上谁，@所有人 ${subs?.picked ? '主脑和子代理都看到' : '全员都看到'}。${subs?.picked ? '子代理' : '其他 AI'} 发的只有主脑和你看得到。`
                    : lobby
                    ? '大厅里发的消息所有 AI 都能看到；用 @名字 点名，或者「私聊给…」只发给一个 AI。'
                    : '这里发的消息只有能访问这个工作区的 AI 能看到；用 @名字 点名。私聊在大厅里。'
                }
              />
            )}
            {ctx.menu}
            {rows.map((r) =>
              r.kind === 'day' ? (
                <DayDivider key={r.key} label={r.label} />
              ) : (
                <MessageItem
                  key={r.key}
                  m={r.m}
                  first={r.first}
                  agents={state.agents}
                  roles={state.roles}
                  wsTag={lobby ? workspaceTag(r.m.workspaceId, workspaces) : undefined}
                  quoted={r.m.replyTo ? (byId.get(r.m.replyTo) ?? null) : undefined}
                  flash={flash === r.m.id}
                  onJump={jumpTo}
                  onOpenImage={setViewing}
                  live={headers.has(r.m.id) ? memberStatusOf(state, headers.get(r.m.id)) : undefined}
                  card={cardWs && cards.get(r.m.id) ? { data: cards.get(r.m.id) as ChangeCard, workspaceId: cardWs } : undefined}
                  onContextMenu={(e) => {
                    const id = (e.target as Element).closest?.('[data-att-id]')?.getAttribute('data-att-id')
                    const att = id ? messageImages(r.m).find((a) => a.id === id) : undefined
                    ctx.open(e, messageMenu(r.m, state.agents, selectionIn(e.currentTarget), att && { att, open: setViewing }))
                  }}
                />
              )
            )}
            {loaded && !memberId && <LiveStrip view={live} />}
          </div>
        </div>
        {newCount > 0 && (
          <button
            onClick={toBottom}
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 cursor-pointer items-center gap-1 rounded-full bg-accent px-3 py-1 text-xs font-medium text-[#111111] shadow-lg hover:opacity-90"
          >
            {newCount} 条新消息 <ArrowDown size={12} />
          </button>
        )}
      </div>
      {viewing && <ImageViewer att={viewing} onClose={closeViewer} onContextMenu={(e) => ctx.open(e, imageMenu(viewing, setViewing, true))} />}

      {archived ? (
        <ArchivedBar channel={channel} />
      ) : (
        <Composer
          state={state}
          channel={channel}
          members={members}
          onSent={(m) => {
            addMessages([m])
            toBottom()
          }}
        />
      )}
    </div>
  )
}

/** 「已经 12 秒」：自己每秒走一下，不带着整个消息流重画 */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const s = Math.max(0, Math.floor((now - since) / 1000))
  return <span className="shrink-0 text-faint tabular-nums">{s < 60 ? `${s} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`}</span>
}

/** 消息流最下面：你发完话到 AI 回话之间，参与的 AI 现在在干什么（lib/liveActivity.ts） */
function LiveStrip({ view }: { view: LiveView }) {
  if (!view.rows.length && !view.offline.length) return null
  const off = view.offline
  return (
    <div data-chat-live className="mt-4 space-y-2 px-2">
      {view.rows.map((r) => (
        <div key={r.agentId} data-live-agent={r.agentId} data-live-kind={r.kind} className="flex items-start gap-1.5 text-xs">
          <Avatar name={r.name} color={r.color} size={18} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 font-medium" style={{ color: r.color }}>
                {r.name}
              </span>
              {r.busy ? <Loader2 size={11} className="shrink-0 animate-spin text-accent" /> : <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', r.kind === 'stale' ? 'bg-warn' : r.kind === 'waiting' ? 'bg-ok' : 'bg-muted')} />}
              <span data-live-text className={cx('min-w-0 truncate', r.kind === 'stale' ? 'text-warn' : 'text-muted')}>
                {r.text}
              </span>
              {r.since !== undefined && <Elapsed since={r.since} />}
            </div>
            {r.stepCount > 0 && (
              <div data-live-steps className="truncate text-[11px] text-faint">
                这一轮已做 {r.stepCount} 步：{r.stepCount > r.steps.length ? '…、' : ''}
                {r.steps.join('、')}
              </div>
            )}
          </div>
        </div>
      ))}
      {view.more > 0 && <div className="pl-6 text-[11px] text-faint">还有 {view.more} 个 AI 在干活</div>}
      {off.length > 0 && (
        <div data-live-offline className="pl-6 text-[11px] text-faint">
          {off.slice(0, 3).join('、')}
          {off.length > 3 ? ` 等 ${off.length} 个` : ''} 不在线，上线后才会看到这句话
        </div>
      )}
    </div>
  )
}

/** 归档的会话不能发言：输入框的位置换成一行说明和「恢复」 */
function ArchivedBar({ channel }: { channel: string }) {
  const [err, setErr] = useState('')
  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-line px-4 py-3 text-xs text-muted">
      <span className="min-w-0 flex-1">这个会话已归档，不能发言。恢复后 AI 能重新看到它。{err && <span className="ml-2 text-bad">{err}</span>}</span>
      <Button size="sm" onClick={() => void window.bridge.archiveGroupChatThread(channel, false).then(() => setErr(''), (e) => setErr(errText(e)))}>
        恢复会话
      </Button>
    </div>
  )
}

/**
 * 干活方式开关：灵感激荡（都在群里说）/ 分工明确（选一个 AI 当主脑，再挑子代理）。
 * 点「分工明确」后先选主脑、挑子代理（默认全选），点「开始」才生效；
 * 已经是分工明确时，换主脑立即生效，改子代理在选择器里点「确定」生效
 */
function ModeSwitch({ state, channel, members, lead }: { state: BridgeState; channel: string; members: Agent[]; lead: Agent | undefined }) {
  const [choosing, setChoosing] = useState(false)
  const [busy, setBusy] = useState(false)
  // 还没生效时先记在这里：选中的主脑、勾中的子代理（undefined 是没动过，算全选）
  const [pendLead, setPendLead] = useState('')
  const [pendSubs, setPendSubs] = useState<string[] | undefined>(undefined)
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
      setChoosing(false)
      setPendLead('')
      setPendSubs(undefined)
    } finally {
      setBusy(false)
    }
  }
  const leadMode = !!lead || choosing
  const leadId = lead?.id ?? pendLead
  const candidates = members.filter((a) => a.id !== leadId)
  const candidateIds = candidates.map((a) => a.id)
  const current = subsOf(state, channel, members)
  // 灵感激荡时参与讨论的 AI
  const parts = partsOf(state, channel, members)
  const memberIds = members.map((a) => a.id)
  // 这个频道所在的工作区（不是整台电脑）：能在这里直接改哪些 AI 能用它
  const membersWsId = channelWorkspaceId(channel)
  const membersWs = membersWsId ? (state.workspaces ?? []).find((w) => w.id === membersWsId) : undefined
  const canEditMembers = !!membersWs && membersWs.kind !== 'machine'
  // 选择器里现在勾着的（还没开始分工时：没动过就照参与讨论的名单，没挑过是全选）
  const checked = lead ? (current?.ids ?? []) : (pendSubs ?? (parts?.picked ? parts.ids : candidateIds)).filter((id) => id !== pendLead)
  return (
    <div className="flex shrink-0 items-center gap-2">
      {leadMode && (
        <label className="flex items-center gap-1 text-[11px] text-muted">
          <Crown size={12} className="text-warn" />
          主脑
          <select
            aria-label="主脑"
            disabled={busy}
            value={leadId}
            onChange={(e) => {
              const id = e.target.value
              if (!id) return
              if (lead) void run(() => setGroupChatLead(channel, id))
              else setPendLead(id)
            }}
            className={cx('h-6 max-w-36 cursor-pointer rounded border bg-canvas px-1 text-xs text-fg outline-none', leadId ? 'border-line' : 'border-warn')}
          >
            {!leadId && <option value="">选一个 AI…</option>}
            {members.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {isOnline(state, a.id) ? '' : '（离线）'}
              </option>
            ))}
          </select>
        </label>
      )}
      {leadMode && (
        <SubPicker
          state={state}
          candidates={candidates}
          checked={checked}
          disabled={busy || !leadId}
          pending={!lead}
          onApply={(ids) => {
            if (lead) void run(() => setGroupChatSubs(channel, subsToSave(ids, candidateIds)))
            else setPendSubs(ids)
          }}
        />
      )}
      {!leadMode && members.length > 0 && (
        <SubPicker
          kind="parts"
          state={state}
          candidates={members}
          checked={parts?.ids ?? memberIds}
          disabled={busy}
          pending={false}
          onApply={(ids) => void run(() => setGroupChatParticipants(channel, subsToSave(ids, memberIds)))}
        />
      )}
      {choosing && !lead && (
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !pendLead}
          title={pendLead ? '按选好的主脑和子代理开始分工' : '先选一个主脑'}
          onClick={() => void run(() => setGroupChatLead(channel, pendLead, subsToSave(checked, candidateIds)))}
        >
          开始
        </Button>
      )}
      {canEditMembers && (
        <Button
          size="sm"
          variant={members.length === 0 ? 'primary' : 'ghost'}
          data-workspace-members-button
          title="哪些 AI 能用这个工作区（也决定谁在这个群聊里）"
          onClick={() => editWorkspaceMembers(membersWs!.id)}
        >
          <UserPlus size={12} /> {members.length === 0 ? '添加 AI' : '成员'}
        </Button>
      )}
      <Segmented
        value={leadMode ? 'lead' : 'brainstorm'}
        options={[
          { value: 'brainstorm', label: '灵感激荡', title: '参与的 AI 在这个频道里一起讨论，每条消息他们都看得到；谁参与在左边的「参与」里挑，不挑就是都参与' },
          { value: 'lead', label: '分工明确', title: '选一个 AI 当主脑、再挑子代理：子代理只和主脑联系，活由主脑派' }
        ]}
        onChange={(v) => {
          if (busy) return
          if (v === 'brainstorm') {
            setChoosing(false)
            setPendLead('')
            setPendSubs(undefined)
            setModeError(undefined)
            if (lead) void run(() => setGroupChatLead(channel, null))
          } else if (!lead) {
            if (members.length) setChoosing(true)
            else setModeError('这个频道里还没有 AI，没法指定主脑')
          }
        }}
      />
    </div>
  )
}

/**
 * 子代理选择器：按钮上写现在几个，点开是一张可以勾的名单，点「确定」才交出去。
 * pending：分工还没开始（点了确定只是先记下，等「开始」）
 */
function SubPicker({
  kind = 'subs',
  state,
  candidates,
  checked,
  disabled,
  pending,
  onApply
}: {
  /** subs：分工明确的子代理；parts：灵感激荡里参与讨论的 AI（至少留一个） */
  kind?: 'subs' | 'parts'
  state: BridgeState
  candidates: Agent[]
  checked: string[]
  disabled: boolean
  pending: boolean
  onApply: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState<string[]>(checked)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: globalThis.MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  const all = candidates.length > 0 && checked.length === candidates.length
  const dirty = sel.length !== checked.length || sel.some((id) => !checked.includes(id))
  const parts = kind === 'parts'
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label={parts ? '参与的 AI' : '子代理'}
        {...(parts ? { 'data-part-picker': '' } : { 'data-sub-picker': '' })}
        disabled={disabled}
        title={parts ? '挑哪些 AI 参与这个频道的讨论：没选中的收不到这里的消息' : disabled ? '先选主脑' : '挑哪些 AI 当子代理：没选中的不参与这次分工'}
        onClick={() => {
          setSel(checked)
          setOpen((o) => !o)
        }}
        className={cx(
          'flex h-6 cursor-pointer items-center gap-1 rounded border border-line bg-canvas px-1.5 text-xs text-fg outline-none hover:bg-hover disabled:cursor-default disabled:opacity-40',
          open && 'bg-hover'
        )}
      >
        <UsersRound size={12} className="text-accent" />
        <span className="text-[11px] text-muted">{parts ? '参与' : '子代理'}</span>
        <span>{candidates.length === 0 ? '无' : all ? `全部 ${candidates.length}` : `${checked.length}/${candidates.length}`}</span>
        <ChevronDown size={11} className="text-muted" />
      </button>
      {open && (
        <div data-sub-list className="absolute top-7 right-0 z-30 w-60 rounded-md border border-line bg-raised p-1.5 shadow-lg">
          <div className="flex items-center justify-between px-1.5 pb-1 text-[11px] text-muted">
            <span>{parts ? '勾上的参与讨论' : '勾上的是子代理'}</span>
            <span className="flex gap-2">
              <button type="button" className="cursor-pointer hover:text-fg" onClick={() => setSel(candidates.map((a) => a.id))}>
                全选
              </button>
              <button type="button" className="cursor-pointer hover:text-fg" onClick={() => setSel([])}>
                全不选
              </button>
            </span>
          </div>
          <div className="max-h-64 overflow-auto">
            {candidates.length === 0 && <div className="px-1.5 py-2 text-xs text-muted">{parts ? '这个频道里还没有 AI。' : '这个频道里除了主脑没有别的 AI。'}</div>}
            {candidates.map((a) => {
              const on = sel.includes(a.id)
              return (
                <button
                  type="button"
                  key={a.id}
                  role="checkbox"
                  aria-checked={on}
                  data-sub-option={a.id}
                  onClick={() => setSel((cur) => (cur.includes(a.id) ? cur.filter((id) => id !== a.id) : [...cur, a.id]))}
                  className="flex w-full cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-hover"
                >
                  <span className={cx('flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border', on ? 'border-accent bg-accent text-[#0d1117]' : 'border-line')}>
                    {on && <Check size={10} strokeWidth={3} />}
                  </span>
                  <Avatar name={a.name} color={a.color} size={18} />
                  <span className={cx('min-w-0 flex-1 truncate text-xs', !on && 'text-muted')}>{a.name}</span>
                  {!isOnline(state, a.id) && <span className="shrink-0 text-[10px] text-faint">离线</span>}
                </button>
              )
            })}
          </div>
          <div className="mt-1 border-t border-line px-1.5 pt-1.5 text-[11px] leading-relaxed text-faint">
            {parts
              ? '没勾的不参与：这个频道的消息它收不到，别的 AI @ 不到它，它在这里发的只有你看到；你点名它照样送到。至少留一个。全选时，以后新加进来的 AI 也参与。'
              : '没勾的不参与：主脑 @ 不到它、不能给它派活，它在这里发的只有你看到。全选时，以后新加进来的 AI 也算子代理。'}
          </div>
          <div className="mt-1.5 flex justify-end gap-1.5 px-1">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!dirty || (parts && sel.length === 0)}
              onClick={() => {
                setOpen(false)
                onApply(candidates.map((a) => a.id).filter((id) => sel.includes(id)))
              }}
            >
              {pending ? '选好了' : '确定'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** 大厅里消息旁的小工作区名；整台电脑也显示 */
function workspaceTag(workspaceId: string | undefined, workspaces: WorkspaceView[]): string | undefined {
  if (!workspaceId) return undefined
  return workspaces.find((w) => w.id === workspaceId)?.name
}

function ErrorLine({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="my-2 flex items-center gap-2 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">
      <span className="flex-1">{text}</span>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  )
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="my-3 flex items-center gap-3 text-[11px] text-faint">
      <div className="h-px flex-1 bg-line-soft" />
      {label}
      <div className="h-px flex-1 bg-line-soft" />
    </div>
  )
}
function shortTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** 回复：在这条消息所在的频道引用它；回复私聊时接着私聊对方 */
function replyTo(m: GroupMessage): void {
  const patch: { replyTo: GroupMessage; to?: string } = { replyTo: m }
  if (m.to) patch.to = m.from.kind === 'agent' ? m.from.id : m.to
  setDraft(m.channel || LOBBY, patch)
  focusComposer()
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className={MARKDOWN_CLASS} dangerouslySetInnerHTML={{ __html: html }} />
}

/** 一张卡片里先列这么多个文件 */
const CARD_FILES = 5

/**
 * 改动卡片：这条消息之前这个 AI 改了哪些文件、增减多少行；「查看变更」在右栏里摊开这次改动（不离开会话），「撤销」把这几步退回去
 */
function ChangeCardView({ card, workspaceId }: { card: ChangeCard; workspaceId: string }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string }>()
  const files = open ? card.files : card.files.slice(0, CARD_FILES)
  const view = () => {
    setNote(undefined)
    showChanges(workspaceId, card.stepIds)
  }
  const undo = async () => {
    setBusy(true)
    setNote(undefined)
    try {
      const r = await window.bridge.rollbackCheckpoints({ workspaceId, stepIds: card.stepIds })
      if (r.status === 'done') setNote({ ok: true, text: `已撤销 ${r.files.length} 个文件${r.checkpoint ? '（这次撤销也存成了检查点，可以在改动页再退回去）' : ''}` })
      else if (r.status === 'nothing') setNote({ ok: false, text: r.message })
      else setNote({ ok: false, text: '没有撤销：这些文件之后又被改过，点「查看变更」看看是哪些' })
    } catch (e) {
      setNote({ ok: false, text: errText(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div data-change-card className="mt-1.5 mb-1 max-w-xl overflow-hidden rounded-lg border border-line bg-panel text-xs">
      <div className="flex items-center gap-2 px-3 py-2">
        <FileDiff size={15} className="shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <span className="font-medium text-fg">已编辑 {card.files.length} 个文件</span>
          <span className="ml-2 text-ok">+{card.additions}</span>
          <span className="ml-1 text-bad">-{card.deletions}</span>
          {card.rolledBack !== 'none' && <span className="ml-2 rounded bg-hover px-1 text-[10px] text-muted">{card.rolledBack === 'all' ? '已撤销' : '部分已撤销'}</span>}
        </div>
        {card.rolledBack !== 'all' &&
          (busy ? (
            <Loader2 size={13} className="animate-spin text-muted" />
          ) : (
            <ConfirmButton confirmText="确认撤销这些改动" onConfirm={() => void undo()}>
              撤销
            </ConfirmButton>
          ))}
        <Button size="sm" onClick={view}>
          查看变更
        </Button>
      </div>
      <div className="border-t border-line">
        {files.map((f) => (
          <div key={f.path} className="flex items-center gap-2 px-3 py-1" title={f.path}>
            <span className={cx('min-w-0 flex-1 truncate font-mono text-[11px]', f.change === 'deleted' ? 'text-muted line-through' : 'text-fg')}>{f.path}</span>
            {f.change === 'added' && <span className="shrink-0 text-[10px] text-muted">新建</span>}
            {f.change === 'deleted' && <span className="shrink-0 text-[10px] text-muted">删除</span>}
            <span className="shrink-0 text-ok">+{f.additions}</span>
            <span className="shrink-0 text-bad">-{f.deletions}</span>
          </div>
        ))}
        {card.files.length > CARD_FILES && (
          <button className="flex w-full cursor-pointer items-center gap-1 px-3 py-1 text-[11px] text-muted hover:text-fg" onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            {open ? '收起' : `还有 ${card.files.length - CARD_FILES} 个文件`}
          </button>
        )}
      </div>
      {note && <div className={cx('border-t border-line px-3 py-1.5', note.ok ? 'text-ok' : 'text-bad')}>{note.text}</div>}
    </div>
  )
}

/** quoted：undefined 表示没有引用；null 表示引用的消息不在已加载的范围里 */
function MessageItem({
  m,
  first,
  agents,
  roles,
  wsTag,
  quoted,
  flash,
  onJump,
  onOpenImage,
  card,
  live,
  onContextMenu
}: {
  m: GroupMessage
  first: boolean
  /** 这是这个 AI 最近一段话的开头：名字后面写它现在在干什么（不在线的不写） */
  live?: MemberStatus
  /** 职位表：AI 的名字后面写它的职位 */
  roles?: Role[]
  /** 这条消息下面挂的改动卡片 */
  card?: { data: ChangeCard; workspaceId: string }
  agents: Agent[]
  /** 大厅里显示：这条消息来自哪个工作区 */
  wsTag?: string
  quoted: GroupMessage | null | undefined
  flash: boolean
  onJump: (id: string) => void
  onOpenImage: (a: ChatAttachment) => void
  onContextMenu: (e: MouseEvent<HTMLDivElement>) => void
}) {
  const s = senderOf(m, agents)
  const images = messageImages(m)
  const priv = privateLabel(m, agents)
  const scope = audienceLabel(m, agents)
  const atMe = mentionsUser(m)
  // 手机上没有「鼠标移上来」：点一下这条消息，回复 / 私聊那排按钮出来；点别处收起
  const [tapped, setTapped] = useState(false)
  useEffect(() => {
    if (!tapped) return
    const away = (e: PointerEvent) => {
      const el = document.getElementById(`gm-${m.id}`)
      if (!(e.target instanceof Node) || !el?.contains(e.target)) setTapped(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [tapped, m.id])
  const onTap = (e: MouseEvent<HTMLDivElement>) => {
    if (!noHover(e.currentTarget)) return
    // 点的是链接、按钮、图片：那是在用它们，不是在点这条消息
    if (e.target instanceof Element && e.target.closest('a, button, img, input, textarea, summary, [role="button"]')) return
    setTapped((v) => !v)
  }
  // 任务的线里自动记的事件：一行「谁 做了什么」，带的说明 / 交付内容收在下面的框里
  if (m.kind === 'event') {
    const cut = m.text.indexOf('\n\n')
    const head = cut < 0 ? m.text : m.text.slice(0, cut)
    const body = cut < 0 ? '' : m.text.slice(cut + 2)
    return (
      <div id={`gm-${m.id}`} data-chat-event onContextMenu={onContextMenu} className={cx('group relative mt-2 rounded-md px-2 py-1 transition-colors hover:bg-hover/50', flash && 'bg-accent/15')}>
        <div className="flex items-baseline gap-1.5 text-xs text-muted">
          <ListTodo size={12} className="shrink-0 self-center text-faint" />
          <span className="shrink-0 font-medium" style={{ color: m.from.kind === 'user' ? undefined : s.color }}>
            {s.name}
          </span>
          <span className="min-w-0 break-words">{head}</span>
          <span className="ml-auto shrink-0 pl-2 text-[11px] text-faint" title={clockTime(m.ts)}>
            {shortTime(m.ts)}
          </span>
        </div>
        {body && (
          <div className="mt-1 ml-[18px] rounded-md border border-line-soft bg-panel px-3 py-2">
            <Markdown text={body} />
          </div>
        )}
        {card && (
          <div className="ml-[18px]">
            <ChangeCardView card={card.data} workspaceId={card.workspaceId} />
          </div>
        )}
      </div>
    )
  }
  const mine = m.from.kind === 'user'
  const chip = live ? headerStatus(live) : undefined
  const roleId = mine ? undefined : agents.find((a) => a.id === m.from.id)?.roleId
  const role = roleId ? roles?.find((r) => r.id === roleId)?.name : undefined
  const tags = (
    <>
      {wsTag && (
        <span className="inline-flex max-w-40 items-center gap-0.5 truncate rounded bg-hover px-1 text-[10px] text-muted" title={`在工作区「${wsTag}」里发的`}>
          <FolderOpen size={9} className="shrink-0" />
          {wsTag}
        </span>
      )}
      {scope && (
        <span className="inline-flex max-w-60 items-center gap-0.5 truncate rounded bg-hover px-1 text-[10px] text-muted" title="「分工明确」时发的：只有这些成员、发的人和你看得到">
          <Crown size={9} className="shrink-0" />
          {scope}
        </span>
      )}
    </>
  )
  const privTag = priv && (
    <div className="mt-0.5 inline-flex items-center gap-1 rounded bg-accent/10 px-1.5 py-px text-[11px] text-accent">
      <Lock size={10} /> {priv}
    </div>
  )
  const tools = (
    <div data-msg-tools className={cx('absolute -top-2.5 items-center gap-0.5 rounded-md border border-line bg-panel p-0.5 shadow', tapped ? 'flex' : 'hidden group-hover:flex', mine ? 'right-2' : 'right-1')}>
      <IconButton
        title="回复"
        onClick={() => {
          setTapped(false)
          replyTo(m)
        }}
      >
        <Reply size={12} />
      </IconButton>
      {m.from.kind === 'agent' && (
        <IconButton
          title={`私聊给 ${s.name}`}
          onClick={() => {
            setTapped(false)
            startPrivate(m.from.id)
          }}
        >
          <Lock size={12} />
        </IconButton>
      )}
    </div>
  )
  // 你自己说的话：靠右，一块圆角的底，不写名字（照 Codex）
  if (mine)
    return (
      <div id={`gm-${m.id}`} data-chat-mine onClick={onTap} onContextMenu={onContextMenu} className={cx('group relative flex flex-col items-end rounded-lg px-2 transition-colors', first ? 'mt-4' : 'mt-1', flash && 'bg-accent/15')}>
        {first && (
          <div className="mb-1 flex items-center gap-2 pr-1">
            {tags}
            <span className="text-[11px] text-faint" title={clockTime(m.ts)}>
              {shortTime(m.ts)}
            </span>
          </div>
        )}
        {privTag}
        <div className="max-w-[85%] min-w-0 rounded-2xl bg-raised px-3.5 py-2">
          {quoted !== undefined && <Quote m={quoted} agents={agents} onJump={onJump} />}
          {m.text && <Markdown text={m.text} />}
          <MessageImages list={images} onOpen={onOpenImage} />
        </div>
        {card && <ChangeCardView card={card.data} workspaceId={card.workspaceId} />}
        {tools}
      </div>
    )
  // AI 说的话：平铺，上面一行小字写是谁、什么职位、几点
  return (
    <div
      id={`gm-${m.id}`}
      onClick={onTap}
      onContextMenu={onContextMenu}
      title={first ? undefined : clockTime(m.ts)}
      className={cx('group relative rounded-lg border-l-2 px-2 py-0.5 transition-colors hover:bg-hover/40', first && 'mt-4', atMe ? 'border-warn bg-warn/5' : 'border-transparent', flash && 'bg-accent/15')}
    >
      {first && (
        <div className="mb-1 flex items-center gap-1.5">
          <Avatar name={s.name} color={s.color} size={18} />
          <span className="text-xs font-medium" style={{ color: s.color }}>
            {s.name}
          </span>
          {role && <span className="text-[11px] text-faint">{role}</span>}
          <span className="text-[11px] text-faint" title={clockTime(m.ts)}>
            {shortTime(m.ts)}
          </span>
          {chip && live && (
            <span data-live-status={live.status} title={describeMemberStatus(live).title} className="inline-flex min-w-0 items-center gap-1 text-[11px]" style={{ color: chip.busy || live.status === 'stale' ? MEMBER_STATUS_META[live.status].color : undefined }}>
              {chip.busy ? <Loader2 size={10} className="shrink-0 animate-spin" /> : <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: MEMBER_STATUS_META[live.status].color }} />}
              <span className={cx('truncate', !chip.busy && live.status !== 'stale' && 'text-faint')}>{chip.text}</span>
            </span>
          )}
          {tags}
        </div>
      )}
      {privTag}
      {quoted !== undefined && <Quote m={quoted} agents={agents} onJump={onJump} />}
      {m.text && <Markdown text={m.text} />}
      <MessageImages list={images} onOpen={onOpenImage} />
      {card && <ChangeCardView card={card.data} workspaceId={card.workspaceId} />}
      {tools}
    </div>
  )
}

function Quote({ m, agents, onJump }: { m: GroupMessage | null; agents: Agent[]; onJump: (id: string) => void }) {
  if (!m) return <div className="my-1 border-l-2 border-line pl-2 text-xs text-faint">引用的消息不在已加载的范围里</div>
  const s = senderOf(m, agents)
  return (
    <button
      onClick={() => onJump(m.id)}
      title="跳到原消息"
      className="my-1 flex max-w-full cursor-pointer items-baseline gap-1.5 rounded-r border-l-2 bg-canvas/60 py-0.5 pr-2 pl-2 text-left text-xs hover:bg-canvas"
      style={{ borderColor: s.color }}
    >
      <span className="shrink-0 font-medium" style={{ color: m.from.kind === 'user' ? undefined : s.color }}>
        {s.name}
      </span>
      <span className="truncate text-muted">{snippet(m.text) || imagesLabel(messageImages(m).length)}</span>
    </button>
  )
}
// ========== 输入框 ==========

/** members：能访问这个频道的 AI（@ 列表只列他们） */
/**
 * 输入框：一整块圆角，上面打字，下面一行是图片、私聊、「发给谁」和发送（照 Codex）。
 * fresh：用在「新会话」页上。这时 channel 只是放草稿的假 id；发的时候先用 resolve 建出真的会话，再把消息发进去
 */
export function Composer({
  state,
  channel,
  members,
  onSent,
  fresh
}: {
  state: BridgeState
  channel: string
  members: Agent[]
  onSent: (m: GroupMessage) => void
  fresh?: { resolve: (text: string) => Promise<string>; placeholder: string; chip: string }
}) {
  const draft = useDraft(channel)
  const upd = (patch: Parameters<typeof setDraft>[1]) => setDraft(channel, patch)
  const lobby = channel === LOBBY
  const text = draft.text
  const [caret, setCaret] = useState(0)
  const [menuIndex, setMenuIndex] = useState(0)
  /** 按了 Esc 关掉的 @ 位置；光标离开这个 @ 后失效 */
  const [dismissed, setDismissed] = useState<number>()
  const [picking, setPicking] = useState(false)
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  /** 图片接口（IPC 没接时为 null，不显示图片按钮、不收粘贴和拖放） */
  const imgApi = useMemo(() => chatImageApi(), [])
  const images = usePendingImages(channel)
  const fileRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  /** 选 / 粘贴 / 拖进来的文件：先在本地查格式、大小、张数，再读成缩略图 */
  async function addFiles(files: File[]) {
    if (!imgApi || !files.length) return
    const { ok, errors } = checkImages(files, getPendingImages(channel).length)
    setErr(errors.join('；'))
    if (!ok.length) return
    try {
      const read = await Promise.all(ok.map(toPending))
      setPendingImages(channel, [...getPendingImages(channel), ...read].slice(0, MAX_IMAGES))
    } catch (e) {
      setErr(`读取图片失败：${errText(e)}`)
    }
  }

  const onDragOver = (e: DragEvent) => {
    if (!imgApi || sending || !e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }
  const onDrop = (e: DragEvent) => {
    if (!imgApi || sending || !e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDragging(false)
    void addFiles(droppedFiles(e.dataTransfer))
  }

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  const q = mentionQuery(text, caret)
  // 不截掉候选成员：大于 7 个 AI 时，「所有人」会占一个位置，固定 slice 会把列表末尾的在线成员隐藏掉。
  // 菜单本身可滚动，键盘上下仍然可以遍历全部候选。
  const options = q && q.start !== dismissed ? mentionOptions(members, q.query) : []
  const menuOpen = options.length > 0
  const sel = Math.min(menuIndex, options.length - 1)

  const syncCaret = () => setCaret(ref.current?.selectionStart ?? 0)

  const choose = (opt: MentionOption) => {
    if (!q) return
    const next = applyMention(text, q.start, caret, opt)
    upd({ text: next.text })
    setCaret(next.caret)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(next.caret, next.caret)
    })
  }

  async function send() {
    const t = text.trim()
    const imgs = images
    if (!canSend(t, imgs.length) || sending) return
    if (t.length > MAX_TEXT) {
      setErr(`消息太长了（${t.length.toLocaleString('en-US')} 字），最多 ${MAX_TEXT.toLocaleString('en-US')} 字。`)
      return
    }
    setSending(true)
    setErr('')
    const keep = draft
    // 私聊对象留着，方便接着聊；引用只用一次
    upd({ text: '', replyTo: undefined })
    setPendingImages(channel, [])
    try {
      // 先传图拿到附件信息，再和文字一起发；没有图片时参数和以前一样
      const attachments = imgs.length && imgApi ? await uploadAll(imgApi, imgs) : []
      const target = fresh ? await fresh.resolve(t) : channel
      onSent(await sendGroupChat(buildSendInput({ channel: target, text: t, to: lobby ? keep.to : undefined, replyTo: keep.replyTo?.id }, attachments)))
    } catch (e) {
      setErr(errText(e))
      upd({ text: keep.text, replyTo: keep.replyTo })
      setPendingImages(channel, imgs)
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (menuOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const d = e.key === 'ArrowDown' ? 1 : -1
        setMenuIndex((sel + d + options.length) % options.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        choose(options[sel])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(q?.start)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    } else if (e.key === 'Escape') {
      if (draft.replyTo) upd({ replyTo: undefined })
      else if (draft.to) upd({ to: undefined })
    }
  }
  const toAgent = draft.to ? state.agents.find((a) => a.id === draft.to) : undefined
  const reply = draft.replyTo
  const lead = fresh ? undefined : leadOf(state, channel)
  const info = fresh ? undefined : channelInfo(state, channel)
  // 这条消息谁会收到：写在输入框下面那一行里
  const audience = fresh
    ? { text: fresh.chip, tip: '发出第一条消息时建会话。新会话默认是「灵感激荡」：能访问这个项目的 AI 都看得到；建好后可以在会话上面改成「分工明确」' }
    : lobby && draft.to
      ? { text: `私聊给 ${memberName(draft.to, state.agents)}`, tip: '只有你和对方能看到' }
      : lead
        ? { text: `分工明确 · 发给主脑 ${lead.name}`, tip: `不 @ 就只有主脑收到；@名字 再加上谁，@所有人 ${info?.subIds ? '主脑和子代理都看到' : '全员都看到'}` }
        : info?.task
          ? { text: `任务 ${info.task.ref} 的线`, tip: '这条任务的执行者和派活的人能看到，别的 AI 看不到' }
          : info?.partIds
            ? { text: `灵感激荡 · ${info.partIds.length} 个 AI 参与`, tip: '只有参与讨论的 AI 能看到；你 @ 别的 AI 也会送到它那里。谁参与在会话上面的「参与」里挑' }
            : { text: '灵感激荡 · 全员可见', tip: lobby ? '所有 AI 都能看到；@名字 点名' : '能访问这个项目的 AI 都能看到；@名字 点名' }

  return (
    <div data-composer className="shrink-0 px-6 pt-1 pb-4">
      {/* 会话里和消息栏一样宽；「新会话」页上面只有一句居中的标题，输入框照旧窄一点、居中 */}
      <div className={cx('relative mx-auto', fresh ? 'max-w-3xl' : 'max-w-[1280px]')}>
        {err && <div className="mb-2 text-xs text-bad">{err}</div>}
        {(reply || (lobby && draft.to)) && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs">
            {lobby && draft.to && (
              <span className="inline-flex items-center gap-1 rounded bg-accent/10 px-1.5 py-0.5 text-accent">
                <Lock size={11} /> 私聊给 {memberName(draft.to, state.agents)}
                <IconButton title="改回发到群里" className="h-4 w-4 text-accent" onClick={() => upd({ to: undefined })}>
                  <X size={10} />
                </IconButton>
              </span>
            )}
            {reply && (
              <span className="inline-flex min-w-0 items-center gap-1 rounded bg-hover px-1.5 py-0.5 text-muted">
                <Reply size={11} className="shrink-0" /> 回复 {senderOf(reply, state.agents).name}：<span className="truncate">{snippet(reply.text, 50) || imagesLabel(messageImages(reply).length)}</span>
                <IconButton title="取消引用" className="h-4 w-4" onClick={() => upd({ replyTo: undefined })}>
                  <X size={10} />
                </IconButton>
              </span>
            )}
          </div>
        )}

        {menuOpen && (
          <div role="listbox" className="absolute bottom-full left-0 z-20 mb-1 max-h-64 w-64 overflow-y-auto rounded-md border border-line bg-raised py-1 shadow-lg">
            {options.map((o, i) => (
              <div
                key={o.id}
                role="option"
                aria-selected={i === sel}
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(o)
                }}
                onMouseEnter={() => setMenuIndex(i)}
                className={cx('flex cursor-pointer items-center gap-2 px-2.5 py-1 text-[13px]', i === sel && 'bg-accent/15')}
              >
                {o.id === '*' ? <AtSign size={16} className="text-muted" /> : <Avatar name={o.label} color={o.color ?? USER_COLOR} size={18} />}
                <span className="truncate">{o.label}</span>
                {o.id !== '*' && !isOnline(state, o.id) && <span className="ml-auto text-[11px] text-faint">离线</span>}
              </div>
            ))}
          </div>
        )}

        {picking && (
          <div className="absolute bottom-full left-0 z-20 mb-1 w-64 overflow-hidden rounded-md border border-line bg-raised py-1 shadow-lg">
            <div className="px-2.5 py-1 text-[11px] text-faint">{lobby ? '私聊给…（只有你和对方能看到）' : '私聊给…（私聊在大厅里，选了会切过去）'}</div>
            {state.agents.length === 0 && <div className="px-2.5 py-1 text-xs text-muted">还没有 AI</div>}
            {state.agents.map((a) => (
              <div
                key={a.id}
                onMouseDown={(e) => {
                  e.preventDefault()
                  setPicking(false)
                  if (lobby) {
                    upd({ to: a.id })
                    ref.current?.focus()
                  } else startPrivate(a.id)
                }}
                className={cx('flex cursor-pointer items-center gap-2 px-2.5 py-1 text-[13px] hover:bg-hover', draft.to === a.id && 'bg-accent/15')}
              >
                <Avatar name={a.name} color={a.color} size={18} />
                <span className="truncate">{a.name}</span>
                {!isOnline(state, a.id) && <span className="ml-auto text-[11px] text-faint">离线</span>}
              </div>
            ))}
          </div>
        )}

        <PendingImages images={images} disabled={sending} onRemove={(key) => setPendingImages(channel, images.filter((p) => p.key !== key))} />

        <div
          onDragOver={onDragOver}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cx('rounded-2xl border border-line bg-raised px-3 pt-2.5 pb-2 shadow-sm focus-within:border-faint', dragging && 'border-dashed border-accent bg-accent/5')}
        >
          <textarea
            id="group-composer"
            ref={ref}
            rows={1}
            value={text}
            onChange={(e) => {
              upd({ text: e.target.value })
              setCaret(e.target.selectionStart)
              setMenuIndex(0)
              setPicking(false)
            }}
            onKeyDown={onKeyDown}
            onKeyUp={syncCaret}
            onClick={syncCaret}
            onBlur={() => setPicking(false)}
            onPaste={(e) => {
              if (!imgApi || sending) return
              const files = pastedFiles(e.clipboardData)
              if (!files.length) return
              e.preventDefault()
              void addFiles(files)
            }}
            placeholder={
              fresh
                ? fresh.placeholder
                : lobby && toAgent
                ? `私聊给「${toAgent.name}」`
                : lobby && draft.to
                  ? '私聊'
                  : leadOf(state, channel)
                    ? `发给主脑「${leadOf(state, channel)?.name}」；@名字 再加上谁，@所有人 ${channelInfo(state, channel)?.subIds ? '主脑和子代理都看到' : '全员都看到'}`
                    : channelInfo(state, channel)?.task
                      ? `说给任务 ${channelInfo(state, channel)?.task?.ref} 的执行者和派活的人；@名字 点名`
                      : `发到「${channelInfo(state, channel)?.name ?? '大厅'}」，@名字 点名，@所有人 叫大家`
            }
            className="block max-h-[200px] min-h-[24px] w-full resize-none bg-transparent px-1 py-0.5 text-[13px] leading-relaxed text-fg outline-none placeholder:text-faint"
          />
          <div className="mt-1.5 flex items-center gap-1">
            {imgApi && (
              <>
                <IconButton
                  title={images.length >= MAX_IMAGES ? `一条消息最多 ${MAX_IMAGES} 张图片` : '发图片（也可以粘贴或拖进来）'}
                  aria-label="发图片"
                  disabled={sending || images.length >= MAX_IMAGES}
                  className="h-7 w-7 rounded-full disabled:cursor-default disabled:opacity-40"
                  onClick={() => fileRef.current?.click()}
                >
                  <ImagePlus size={15} />
                </IconButton>
                <input
                  ref={fileRef}
                  type="file"
                  accept={IMAGE_ACCEPT}
                  multiple
                  hidden
                  onChange={(e) => {
                    void addFiles(Array.from(e.target.files ?? []))
                    e.target.value = ''
                  }}
                />
              </>
            )}
            {!fresh && (
              <IconButton title="私聊给…" className={cx('h-7 w-7 rounded-full', lobby && draft.to && 'text-accent')} onClick={() => setPicking((v) => !v)}>
                <Lock size={14} />
              </IconButton>
            )}
            <span data-audience title={audience.tip} className="ml-1 flex min-w-0 items-center gap-1 truncate rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
              {lead ? <Crown size={11} className="shrink-0 text-warn" /> : lobby && draft.to ? <Lock size={11} className="shrink-0 text-accent" /> : null}
              <span className="truncate">{audience.text}</span>
            </span>
            <span className="flex-1" />
            <button
              title="发送（Enter）。Shift+Enter 换行，@ 选成员，Esc 取消引用 / 私聊"
              aria-label="发送"
              disabled={!canSend(text, images.length) || sending}
              onClick={() => void send()}
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-fg text-shell transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-30"
            >
              {sending ? <Loader2 size={15} className="animate-spin" /> : <ArrowUp size={16} strokeWidth={2.2} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
