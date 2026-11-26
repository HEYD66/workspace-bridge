import { Check, ListTodo, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Agent, BridgeState, TaskItem, TaskStatus } from '../../../shared/api'
import { MemberStatusDot } from '../components/MemberStatusBadge'
import { TaskScopeAndQuestions } from '../components/TaskQuestions'
import { Avatar, Badge, Button, ConfirmButton, cx, EmptyState, Field, IconButton, Input, PanelHeader, Segmented, TextArea } from '../components/ui'
import { WorkspaceTag } from '../components/WorkspaceSwitcher'
import { errText, PRIORITY_LABELS, STATUS_META, STATUS_ORDER, timeAgo } from '../lib/format'
import { taskThreadOf } from '../lib/groupChat'
import { assigneeAlert, memberStatusOf } from '../lib/memberStatus'
import { TaskThreadPane } from './GroupChatView'
import { canSwitchTaskScope, type TaskScope } from './TaskBoard'

const agentOf = (state: BridgeState, id?: string): Agent | undefined => state.agents.find((a) => a.id === id)

/** 任务的线里有你没看的话（AI 说的，自动记的事件不算）：一个小数字 */
export function ThreadUnread({ state, taskId, workspaceId }: { state: BridgeState; taskId: string; workspaceId?: string }) {
  const c = taskThreadOf(state, taskId, workspaceId)
  if (!c || c.unread <= 0) return null
  return (
    <span
      title={`这条任务的线里有 ${c.unread} 条没看的消息`}
      className={cx('min-w-4 shrink-0 rounded-full px-1 text-center text-[10px] leading-4 font-semibold', c.mentions ? 'bg-bad text-white' : 'bg-accent text-[#0d1117]')}
    >
      {c.unread}
    </span>
  )
}

/**
 * 任务的线：这条任务自己的会话。派活、认领、交付、审查自动记在里面，AI 改了哪些文件挂在它那条消息下面；
 * 在这里说的话只有这条任务的执行者、派活的人、创建者看得到。老任务第一次打开时现开（之前的记录还在下面的「记录」里）
 */
function TaskThreadSection({ state, task, workspaceId }: { state: BridgeState; task: TaskItem; workspaceId?: string }) {
  const [channel, setChannel] = useState<string>()
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setChannel(undefined)
    setError('')
    window.bridge.taskThread(task.id, workspaceId).then(
      (c) => live && setChannel(c.id),
      (e) => live && setError(errText(e))
    )
    return () => {
      live = false
    }
  }, [task.id, workspaceId])
  const info = channel ? state.chat?.taskThreads?.find((c) => c.id === channel) : undefined
  const names = (info?.task?.memberIds ?? []).map((id) => agentOf(state, id)?.name).filter((n): n is string => !!n)
  return (
    <div data-task-thread={task.ref}>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="shrink-0 text-xs font-medium text-muted">任务的线</span>
        <span className="min-w-0 truncate text-[11px] text-faint">
          派活、交付、审查自动记在这里 · {names.length ? `${names.join('、')} 和你在里面` : '现在只有你在里面，派给谁谁就进来'}
        </span>
      </div>
      <div className="h-[460px] overflow-hidden rounded-lg border border-line bg-canvas">
        {channel && info ? <TaskThreadPane state={state} channel={channel} /> : <div className="p-4 text-xs text-muted">{error ? `打不开这条线：${error}` : '加载中…'}</div>}
      </div>
    </div>
  )
}

/** 列表里的执行者头像：工作台给了细分状态时带一个状态点，可能卡住 / 离线且任务没完成时前面加一个提醒（T-23） */
function AssigneeAvatar({ state, agent, status }: { state: BridgeState; agent: Agent; status: TaskStatus }) {
  const ms = memberStatusOf(state, agent.id)
  const alert = assigneeAlert(ms, status)
  return (
    <span className="flex shrink-0 items-center gap-1">
      {alert && <span className="text-[11px] text-warn" title={alert}>!</span>}
      <Avatar name={agent.name} color={agent.color} size={16} />
      {ms && <MemberStatusDot status={ms} size={6} />}
    </span>
  )
}

/** workspaceId 有值 = 在看「整台电脑」的任务板：没开「整台电脑」的 AI 看不到这里的任务，选项里标出来 */
function AssigneeSelect({ state, value, onChange, workspaceId }: { state: BridgeState; value?: string; onChange: (id: string) => void; workspaceId?: string }) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-full rounded-md border border-line bg-canvas px-2 text-[13px] text-fg outline-none focus:border-accent"
    >
      <option value="">待认领（不指定）</option>
      {state.agents.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
          {a.roleId ? ` · ${state.roles.find((r) => r.id === a.roleId)?.name ?? ''}` : ''}
          {workspaceId && !a.machineAccess ? '（没开整台电脑，看不到）' : ''}
        </option>
      ))}
    </select>
  )
}

interface TaskListProps {
  state: BridgeState
  tasks: TaskItem[]
  selected?: string
  onSelect: (id: string) => void
  /** 在看「整台电脑」的任务板时是它的 id；看当前工作区时不给 */
  workspaceId?: string
  scope: TaskScope
  onScope: (s: TaskScope) => void
  /** 另一个任务板上没完成的任务数，显示在切换按钮上 */
  machineOpen: number
}

export function TaskList({ state, tasks, selected, onSelect, workspaceId, scope, onScope, machineOpen }: TaskListProps) {
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [assignee, setAssignee] = useState('')
  const [error, setError] = useState('')
  const [showDone, setShowDone] = useState(false)

  async function create() {
    setError('')
    try {
      const t = await window.bridge.createTask({ title: title.trim(), assigneeId: assignee || undefined }, workspaceId)
      setTitle('')
      setAssignee('')
      setCreating(false)
      onSelect(t.id)
    } catch (e) {
      setError(errText(e))
    }
  }

  const groups = STATUS_ORDER.filter((s) => s !== 'done' || showDone).map((s) => ({ s, items: tasks.filter((t) => t.status === s) }))
  const doneCount = tasks.filter((t) => t.status === 'done').length

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="任务">
        {workspaceId ? <Badge>整台电脑</Badge> : <WorkspaceTag state={state} />}
        <IconButton title={workspaceId ? '在「整台电脑」的任务板上新建任务' : '新建任务'} onClick={() => setCreating(!creating)}>
          <Plus size={14} />
        </IconButton>
      </PanelHeader>
      {canSwitchTaskScope(state) && (
        <div className="px-3 pb-2">
          <Segmented<TaskScope>
            value={scope}
            onChange={(s) => {
              setCreating(false)
              onScope(s)
            }}
            options={[
              { value: 'active', label: '当前工作区', title: `工作区「${state.workspaceName ?? ''}」的任务板` },
              {
                value: 'machine',
                label: machineOpen > 0 ? `整台电脑 ${machineOpen}` : '整台电脑',
                title: '「整台电脑」的任务板：定时任务派到整台电脑的、开了「整台电脑」的 AI 在那里建的任务都在这'
              }
            ]}
          />
        </div>
      )}
      {creating && (
        <div className="space-y-2 border-b border-line-soft px-3 pb-3">
          <Input autoFocus placeholder="任务标题" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && title.trim() && create()} />
          <AssigneeSelect state={state} value={assignee} onChange={setAssignee} workspaceId={workspaceId} />
          {error && <div className="text-[11px] text-bad">{error}</div>}
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
              取消
            </Button>
            <Button size="sm" variant="primary" disabled={!title.trim()} onClick={create}>
              创建
            </Button>
          </div>
        </div>
      )}
      <div className="flex-1 overflow-auto pb-4">
        {tasks.length === 0 && !creating && (
          <EmptyState
            icon={<ListTodo size={24} />}
            title="还没有任务"
            hint={workspaceId ? '这是「整台电脑」的任务板。只有在团队页开了「整台电脑」的 AI 才看得到这里的任务' : '你可以在这里派活，AI 也能用 task_create 互相派活。你派的任务 AI 做完直接算完成，不用你点通过'}
          />
        )}
        {groups.map(
          ({ s, items }) =>
            items.length > 0 && (
              <div key={s} className="mt-1">
                <div className="flex items-center gap-1.5 px-3 py-1 text-[11px] font-medium text-muted">
                  <span className="h-2 w-2 rounded-full" style={{ background: STATUS_META[s].color }} />
                  {STATUS_META[s].label}
                  <span className="text-faint">{items.length}</span>
                </div>
                {items.map((t) => {
                  const a = agentOf(state, t.assigneeId)
                  return (
                    <div
                      key={t.id}
                      onClick={() => onSelect(t.id)}
                      className={cx('mx-1.5 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1.5 hover:bg-hover', selected === t.id && 'bg-accent/15')}
                    >
                      <span className="w-9 shrink-0 font-mono text-[11px] text-faint">{t.ref}</span>
                      <span className={cx('min-w-0 flex-1 truncate', t.status === 'done' && 'text-muted line-through')}>{t.title}</span>
                      {t.priority === 'high' && <span className="text-[11px] text-bad">!</span>}
                      <ThreadUnread state={state} taskId={t.id} workspaceId={workspaceId ?? state.activeWorkspaceId} />
                      {a ? <AssigneeAvatar state={state} agent={a} status={t.status} /> : <span className="h-4 w-4 shrink-0 rounded-full border border-dashed border-line" />}
                    </div>
                  )
                })}
              </div>
            )
        )}
        {doneCount > 0 && (
          <button className="mt-2 w-full cursor-pointer px-3 py-1 text-left text-[11px] text-faint hover:text-muted" onClick={() => setShowDone(!showDone)}>
            {showDone ? '隐藏' : '显示'}已完成（{doneCount}）
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * workspaceId：任务不在当前工作区的任务板上时是那个工作区的 id，每个操作都要带上（各任务板各编各的号）。
 * 任务页只在看「整台电脑」时传；首页的项目列表里看哪个工作区的任务都传，这时另外用 machine 说明是不是「整台电脑」、用 project 显示项目名
 */
export function TaskDetail({
  state,
  task,
  onDeleted,
  workspaceId,
  machine,
  project
}: {
  state: BridgeState
  task: TaskItem
  onDeleted: () => void
  workspaceId?: string
  /** 是不是「整台电脑」的任务板；不传时按老规矩：给了 workspaceId 就是 */
  machine?: boolean
  /** 项目（工作区）名，显示在编号旁边 */
  project?: string
}) {
  const ws = workspaceId
  const isMachine = machine ?? !!workspaceId
  const [title, setTitle] = useState(task.title)
  const [desc, setDesc] = useState(task.description)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    setTitle(task.title)
    setDesc(task.description)
    setNote('')
    setError('')
  }, [task.id, task.title, task.description])

  const run = (fn: () => Promise<unknown>) => async () => {
    setError('')
    try {
      await fn()
      setNote('')
    } catch (e) {
      setError(errText(e))
    }
  }
  const dirty = title !== task.title || desc !== task.description
  const assignee = agentOf(state, task.assigneeId)
  // 你派的任务不用你点通过，AI 做完直接完成；AI 派给 AI 的由派活的 AI 审查
  const reviewer = task.managedBy === 'user' ? undefined : agentOf(state, task.managedBy)?.name

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-faint">{task.ref}</span>
        {isMachine ? <Badge>整台电脑</Badge> : project && <Badge>{project}</Badge>}
        <Badge color={STATUS_META[task.status].color}>{STATUS_META[task.status].label}</Badge>
        <span className="text-xs text-faint">
          {task.createdByName} 创建于 {timeAgo(task.createdAt)}
          {reviewer && ` · 由 ${reviewer} 审查`}
        </span>
        <div className="ml-auto">
          <ConfirmButton confirmText="确认删除？" onConfirm={run(async () => (await window.bridge.deleteTask(task.id, ws), onDeleted()))}>
            <Trash2 size={12} /> 删除
          </ConfirmButton>
        </div>
      </div>

      <Input value={title} onChange={(e) => setTitle(e.target.value)} className="h-10 border-transparent bg-transparent px-0 text-lg font-semibold hover:border-line focus:px-2.5" />

      {task.status === 'review' && (
        <div className="space-y-2.5 rounded-lg border border-warn/40 bg-warn/[0.06] p-4">
          <div className="text-[13px] font-medium text-warn">
            {assignee?.name ?? '执行者'} 提交了审查{reviewer ? `，等 ${reviewer} 处理；你也可以直接处理` : ''}
          </div>
          {task.result && <div className="selectable text-[13px] leading-relaxed whitespace-pre-wrap text-fg">{task.result}</div>}
          <TextArea rows={2} placeholder="审查意见（退回时写清楚要改什么）" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex gap-2">
            <Button variant="primary" onClick={run(() => window.bridge.reviewTask(task.id, 'accept', note || undefined, ws))}>
              <Check size={14} /> 通过
            </Button>
            <Button variant="danger" onClick={run(() => window.bridge.reviewTask(task.id, 'reject', note || undefined, ws))}>
              <X size={14} /> 退回
            </Button>
          </div>
        </div>
      )}

      <TaskScopeAndQuestions task={task} workspaceId={ws} />

      <div className="grid grid-cols-3 gap-4">
        <Field label="执行者">
          <AssigneeSelect state={state} value={task.assigneeId} workspaceId={isMachine ? ws : undefined} onChange={(id) => void run(() => window.bridge.assignTask(task.id, id || null, ws))()} />
        </Field>
        <Field label="状态">
          <select
            value={task.status}
            onChange={(e) => void run(() => window.bridge.setTaskStatus(task.id, e.target.value as TaskStatus, undefined, ws))()}
            className="h-8 w-full rounded-md border border-line bg-canvas px-2 text-[13px] outline-none focus:border-accent"
          >
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {STATUS_META[s].label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="优先级">
          <select
            value={task.priority}
            onChange={(e) => void run(() => window.bridge.editTask(task.id, { priority: e.target.value as TaskItem['priority'] }, ws))()}
            className="h-8 w-full rounded-md border border-line bg-canvas px-2 text-[13px] outline-none focus:border-accent"
          >
            {(['high', 'normal', 'low'] as const).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="说明">
        <TextArea rows={6} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="要做什么、验收标准" />
      </Field>
      {dirty && (
        <div className="flex gap-2">
          <Button variant="primary" onClick={run(() => window.bridge.editTask(task.id, { title, description: desc }, ws))}>
            保存
          </Button>
          <Button variant="ghost" onClick={() => (setTitle(task.title), setDesc(task.description))}>
            还原
          </Button>
        </div>
      )}
      {error && <div className="text-xs text-bad">{error}</div>}

      {task.result && task.status !== 'review' && (
        <Field label="交付说明">
          <div className="selectable rounded-md border border-line-soft bg-panel p-3 text-[13px] leading-relaxed whitespace-pre-wrap">{task.result}</div>
        </Field>
      )}

      <TaskThreadSection state={state} task={task} workspaceId={ws} />

      <div>
        <div className="mb-2 text-xs font-medium text-muted">记录</div>
        <div className="space-y-1.5 border-l border-line pl-4">
          {task.history
            .slice()
            .reverse()
            .map((h, i) => (
              <div key={i} className="text-xs">
                <span className="text-fg">{h.actorName}</span> <span className="text-muted">{h.action}</span>
                <span className="ml-2 text-faint">{timeAgo(h.ts)}</span>
                {h.note && <div className="selectable mt-0.5 whitespace-pre-wrap text-muted">{h.note}</div>}
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}
