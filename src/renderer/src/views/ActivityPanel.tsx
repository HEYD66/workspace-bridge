import { Activity, PanelRightClose, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ActivityEvent, BridgeState } from '../../../shared/api'
import { EventItem } from '../components/EventItem'
import { Avatar, Button, cx, EmptyState, IconButton, Segmented } from '../components/ui'
import { FILE_WRITE_TOOLS, MEMORY_TOOLS, TASK_TOOLS } from '../lib/format'
import { channelAgents, channelInfo, channelLabel } from '../lib/groupChat'
import { foldWaits } from '../lib/liveActivity'
import { formatDuration } from '../lib/memberStatus'
import { navigate } from '../lib/nav'
import { setSkillWorkspace } from '../lib/skillScope'
import { channelWorkspaceId } from '../lib/groupChat'
import { editWorkspaceMembers } from '../lib/workspaceDialog'

type Kind = 'all' | 'write' | 'collab' | 'error'
/** 看哪些 AI：chat 只看当前群聊里的，all 所有 AI */
type Scope = 'chat' | 'all'

const SCOPE_KEY = 'wb.activity.scope'
function loadScope(): Scope {
  try {
    return localStorage.getItem(SCOPE_KEY) === 'all' ? 'all' : 'chat'
  } catch {
    return 'chat'
  }
}

/** 右栏：实时活动流，可按群聊、AI、类型筛选和搜索 */
export function ActivityPanel({
  state,
  events,
  channel,
  onOpenFile,
  onClose,
  bare
}: {
  state: BridgeState
  events: ActivityEvent[]
  /** 「按群聊」看的那个群聊；不给就只能看所有 AI */
  channel?: string
  /** 点带路径的事件；ev 里有 workspaceId */
  onOpenFile: (path: string, ev: ActivityEvent) => void
  onClose: () => void
  /** 装在右栏的「活动」页里：标题和收起按钮由右栏画 */
  bare?: boolean
}) {
  const [kind, setKind] = useState<Kind>('all')
  const [picked, setAgent] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [scopePref, setScopePref] = useState<Scope>(loadScope)
  const chooseScope = (s: Scope): void => {
    setScopePref(s)
    try {
      localStorage.setItem(SCOPE_KEY, s)
    } catch {
      /* 记不住就算了 */
    }
  }

  // 按群聊：只看这个群聊里的 AI（参与讨论的 / 主脑和子代理 / 任务里的）
  const info = channel ? channelInfo(state, channel) : undefined
  const scope: Scope = channel && info ? scopePref : 'all'
  const chatIds = useMemo(() => (scope === 'chat' && channel ? new Set(channelAgents(state, channel).map((a) => a.id)) : null), [scope, channel, state])
  // 换了群聊，原来点中的 AI 不在这个群里就不再按它筛
  const agent = picked && (!chatIds || chatIds.has(picked)) ? picked : null

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    // 待命的 AI 连着的「等消息超时」合成一条，不然列表被它刷满
    return foldWaits(events, { time: (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }), duration: formatDuration })
      .filter((e) => !chatIds || chatIds.has(e.agentId))
      .filter((e) => !agent || e.agentId === agent)
      .filter((e) => {
        if (kind === 'write') return FILE_WRITE_TOOLS.has(e.tool)
        if (kind === 'collab') return MEMORY_TOOLS.has(e.tool) || TASK_TOOLS.has(e.tool) || e.tool === 'team_list'
        if (kind === 'error') return e.status === 'error'
        return true
      })
      .filter((e) => !needle || `${e.tool} ${e.path ?? ''} ${e.error ?? ''} ${e.summary ?? ''}`.toLowerCase().includes(needle))
      .slice(-300)
      .reverse()
  }, [events, agent, kind, q, chatIds])

  // 活动里出现过、但身份已吊销的 AI 也要能筛（只在看所有 AI 时）
  const allChips = useMemo(() => {
    const m = new Map(state.agents.map((a) => [a.id, { id: a.id, name: a.name, color: a.color }]))
    for (const e of events) if (!m.has(e.agentId)) m.set(e.agentId, { id: e.agentId, name: e.agentName, color: e.agentColor })
    return [...m.values()]
  }, [state.agents, events])
  const chips = chatIds ? allChips.filter((a) => chatIds.has(a.id)) : allChips

  const errors = events.filter((e) => e.status === 'error').length

  // 多个工作区时，每条事件前面标上是哪个工作区；整台电脑上的事件总是标上
  const wsNames = useMemo(() => {
    const list = state.workspaces ?? []
    const dirs = list.filter((w) => w.kind !== 'machine')
    return new Map((dirs.length > 1 ? list : list.filter((w) => w.kind === 'machine')).map((w) => [w.id, w.name]))
  }, [state.workspaces])

  // AI 提交技能的那条活动：点按钮去技能页看它。技能在 AI 的工作区里（不一定是当前工作区），技能页改看那个工作区
  const openSkill = (name: string, ev: ActivityEvent) => {
    setSkillWorkspace(ev.workspaceId)
    navigate({ section: 'skills', id: `project:${name}` })
  }

  return (
    <div className="flex h-full flex-col">
      {!bare && (
        <div className="flex h-9 shrink-0 items-center gap-2 px-3 text-[11px] font-semibold tracking-wider text-muted uppercase">
          <Activity size={13} /> 实时活动
          <span className="ml-auto" />
          <IconButton title="收起" onClick={onClose}>
            <PanelRightClose size={14} />
          </IconButton>
        </div>
      )}
      <div className={cx('space-y-2 border-b border-line-soft px-3 pb-2.5', bare && 'pt-2.5')}>
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: '全部' },
            { value: 'write', label: '改文件' },
            { value: 'collab', label: '协作' },
            { value: 'error', label: errors ? `失败 ${errors}` : '失败' }
          ]}
        />
        {info && (
          <div className="flex items-center gap-1 text-[11px]" data-activity-scope={scope}>
            <button
              type="button"
              data-activity-scope-option="chat"
              title="只看这个群聊里的 AI：参与讨论的，或「分工明确」时的主脑和子代理"
              onClick={() => chooseScope('chat')}
              className={cx('h-6 min-w-0 cursor-pointer truncate rounded-md px-2', scope === 'chat' ? 'bg-hover text-fg' : 'text-muted hover:text-fg')}
            >
              按群聊「{channelLabel(info)}」· {chatIds?.size ?? channelAgents(state, channel!).length}
            </button>
            <button
              type="button"
              data-activity-scope-option="all"
              onClick={() => chooseScope('all')}
              className={cx('h-6 shrink-0 cursor-pointer rounded-md px-2', scope === 'all' ? 'bg-hover text-fg' : 'text-muted hover:text-fg')}
            >
              所有 AI · {allChips.length}
            </button>
          </div>
        )}
        {(chips.length > 1 || (chatIds && chips.length > 0)) && (
          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => setAgent(null)}
              className={cx('h-6 cursor-pointer rounded-full px-2 text-[11px]', agent === null ? 'bg-hover text-fg' : 'text-muted hover:text-fg')}
            >
              {chatIds ? '全部' : '所有 AI'}
            </button>
            {chips.map((a) => (
              <button
                key={a.id}
                onClick={() => setAgent(agent === a.id ? null : a.id)}
                className={cx('flex h-6 cursor-pointer items-center gap-1 rounded-full pr-2 pl-0.5 text-[11px]', agent === a.id ? 'bg-hover text-fg' : 'text-muted hover:text-fg')}
              >
                <Avatar name={a.name} color={a.color} size={18} />
                {a.name}
              </button>
            ))}
          </div>
        )}
        <div className="relative">
          <Search size={12} className="absolute top-1/2 left-2 -translate-y-1/2 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索路径、工具、错误"
            className="h-7 w-full rounded-md border border-line bg-canvas pr-2 pl-7 text-xs outline-none placeholder:text-faint focus:border-accent"
          />
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {list.length === 0 ? (
          <EmptyState
            icon={<Activity size={24} />}
            title={chatIds && chatIds.size === 0 ? '这个群聊里还没有 AI' : events.length ? '没有符合条件的记录' : '还没有 AI 操作'}
            hint={chatIds && chatIds.size === 0 ? '给这个工作区加 AI，或者点上面的「所有 AI」看全部' : events.length ? undefined : 'AI 连上后调用的每个工具都会实时出现在这里'}
            action={
              chatIds && chatIds.size === 0 && channel && channelWorkspaceId(channel) ? (
                <Button size="sm" variant="primary" onClick={() => editWorkspaceMembers(channelWorkspaceId(channel)!)}>
                  添加 AI
                </Button>
              ) : undefined
            }
          />
        ) : (
          list.map((ev) => (
            <EventItem
              key={ev.id}
              ev={ev}
              onOpenFile={onOpenFile}
              workspaceName={ev.workspaceId ? wsNames?.get(ev.workspaceId) : undefined}
              onOpenSkill={openSkill}
            />
          ))
        )}
      </div>
    </div>
  )
}
