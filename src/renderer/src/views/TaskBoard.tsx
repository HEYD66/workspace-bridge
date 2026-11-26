// 任务看板：没选中任务时主区显示。按状态分列，拖卡片到别的列改状态（用户身份，和详情页的状态按钮同一个接口）
import { ListTodo } from 'lucide-react'
import { useState, type DragEvent } from 'react'
import type { BridgeState, TaskItem, TaskStatus } from '../../../shared/api'
import { useContextMenu } from '../components/ContextMenu'
import { AssigneeAlert, MemberStatusDot } from '../components/MemberStatusBadge'
import { Avatar, EmptyState, cx } from '../components/ui'
import { errText, PRIORITY_LABELS, STATUS_META, timeAgo } from '../lib/format'
import { appendToDraft, LOBBY, mentionText, wsChannel } from '../lib/groupChat'
import { memberStatusOf } from '../lib/memberStatus'
import { taskMenu } from '../lib/menus'
import { navigate } from '../lib/nav'

/** 看板列的顺序：从左到右是一件事的生命周期 */
export const BOARD_COLUMNS: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'review', 'done']

/** 一列里的排序：高优先在前，同优先级按最近更新 */
export function boardOrder(a: TaskItem, b: TaskItem): number {
  const p = { high: 0, normal: 1, low: 2 } as const
  return p[a.priority] - p[b.priority] || b.updatedAt - a.updatedAt
}

/** 任务页看哪个任务板：当前工作区的，还是「整台电脑」的 */
export type TaskScope = 'active' | 'machine'

/**
 * 任务页现在看的任务板属于哪个工作区。返回 undefined 是当前工作区；返回 id 是「整台电脑」的（调接口时要带上它）。
 * 工作台切不到整台电脑，所以它的任务板只能这样看。一个目录工作区都没有时，只有整台电脑的任务板可看。
 */
export function taskBoardWorkspace(scope: TaskScope, state: { activeWorkspaceId?: string; workspaces: { id: string; kind?: string }[] }): string | undefined {
  const machine = state.workspaces.find((w) => w.kind === 'machine')
  if (!machine) return undefined
  const active = state.workspaces.find((w) => w.id === state.activeWorkspaceId)
  // 当前工作区已经是整台电脑（界面做不到，脚本直接调接口可以）：就是当前工作区
  if (active?.kind === 'machine') return undefined
  if (!active) return machine.id
  return scope === 'machine' ? machine.id : undefined
}

/** 任务页要不要显示「当前工作区 / 整台电脑」的切换：两个任务板都有的时候才显示 */
export function canSwitchTaskScope(state: { activeWorkspaceId?: string; workspaces: { id: string; kind?: string }[] }): boolean {
  const active = state.workspaces.find((w) => w.id === state.activeWorkspaceId)
  return !!active && active.kind !== 'machine' && state.workspaces.some((w) => w.kind === 'machine')
}

export function TaskBoard({ state, tasks, workspaceId }: { state: BridgeState; tasks: TaskItem[]; workspaceId?: string }) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<TaskStatus | null>(null)
  const [error, setError] = useState('')
  const agentOf = (id?: string) => state.agents.find((a) => a.id === id)
  const ctx = useContextMenu()

  /** 出错显示在看板顶上 */
  const attempt = (p: Promise<unknown>): void => {
    setError('')
    p.catch((err) => setError(errText(err)))
  }

  /** 任务卡右键（T-13） */
  const openMenu = (e: React.MouseEvent, t: TaskItem): void => {
    const wsId = workspaceId ?? state.activeWorkspaceId
    ctx.open(
      e,
      taskMenu(t, state.agents, {
        open: () => navigate({ section: 'tasks', id: t.id }),
        setStatus: (s) => attempt(window.bridge.setTaskStatus(t.id, s, '在看板右键改状态', workspaceId)),
        assign: (agentId) => attempt(window.bridge.assignTask(t.id, agentId, workspaceId)),
        copyRef: () => void window.bridge.copy(t.ref),
        copyTitle: () => void window.bridge.copy(t.title),
        mention: (name) => {
          const ch = wsId ? wsChannel(wsId) : LOBBY
          appendToDraft(ch, `${mentionText(name)}${t.ref} `)
          navigate({ section: 'group', id: ch })
        },
        remove: () => attempt(window.bridge.deleteTask(t.id, workspaceId))
      })
    )
  }

  const drop = async (e: DragEvent, status: TaskStatus) => {
    e.preventDefault()
    setOver(null)
    const id = e.dataTransfer.getData('text/x-task-id') || dragId
    setDragId(null)
    const t = tasks.find((x) => x.id === id)
    if (!t || t.status === status) return
    setError('')
    try {
      await window.bridge.setTaskStatus(t.id, status, '在看板上拖动', workspaceId)
    } catch (err) {
      setError(errText(err))
    }
  }

  if (tasks.length === 0)
    return workspaceId ? (
      <EmptyState icon={<ListTodo size={28} />} title="「整台电脑」的任务板还没有任务" hint="在左侧点 + 派活。只有在团队页勾了「整台电脑」的 AI 才看得到这里的任务" />
    ) : (
      <EmptyState icon={<ListTodo size={28} />} title="这个工作区还没有任务" hint="在左侧点 + 派活；AI 也能用 task_create 派活，用 task_update 汇报" />
    )

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 pt-3 pb-1 text-xs text-muted">
        {workspaceId ? '「整台电脑」的任务看板' : '任务看板'} · 拖动卡片改状态，点卡片看详情
        {error && <span className="text-bad">{error}</span>}
      </div>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
        {BOARD_COLUMNS.map((s) => {
          const items = tasks.filter((t) => t.status === s).sort(boardOrder)
          const meta = STATUS_META[s]
          return (
            <div
              key={s}
              onDragOver={(e) => {
                e.preventDefault()
                if (over !== s) setOver(s)
              }}
              onDragLeave={() => over === s && setOver(null)}
              onDrop={(e) => void drop(e, s)}
              className={cx('flex w-64 shrink-0 flex-col rounded-lg border bg-panel', over === s ? 'border-accent' : 'border-line-soft')}
            >
              <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2 text-xs">
                <span className="h-2 w-2 rounded-full" style={{ background: meta.color }} />
                <span className="font-medium text-fg">{meta.label}</span>
                <span className="text-faint">{items.length}</span>
              </div>
              <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2">
                {items.map((t) => {
                  const a = agentOf(t.assigneeId)
                  const ms = a ? memberStatusOf(state, a.id) : undefined
                  return (
                    <div
                      key={t.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/x-task-id', t.id)
                        e.dataTransfer.effectAllowed = 'move'
                        setDragId(t.id)
                      }}
                      onDragEnd={() => setDragId(null)}
                      onClick={() => navigate({ section: 'tasks', id: t.id })}
                      onContextMenu={(e) => openMenu(e, t)}
                      className={cx(
                        'cursor-pointer rounded-md border border-line-soft bg-canvas px-2.5 py-2 hover:border-line',
                        dragId === t.id && 'opacity-50'
                      )}
                    >
                      <div className="flex items-center gap-1.5 text-[11px] text-faint">
                        <span className="font-mono">{t.ref}</span>
                        {t.priority !== 'normal' && (
                          <span className={t.priority === 'high' ? 'text-bad' : 'text-faint'}>{PRIORITY_LABELS[t.priority]}优先</span>
                        )}
                        <span className="ml-auto">{timeAgo(t.updatedAt)}</span>
                      </div>
                      <div className="mt-1 line-clamp-3 text-[13px] text-fg">{t.title}</div>
                      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted">
                        {a ? (
                          <>
                            <Avatar name={a.name} color={a.color} size={14} />
                            {a.name}
                            {ms && <MemberStatusDot status={ms} size={6} />}
                          </>
                        ) : (
                          <span className="text-faint">待认领</span>
                        )}
                      </div>
                      <AssigneeAlert status={ms} taskStatus={t.status} />
                    </div>
                  )
                })}
                {items.length === 0 && <div className="py-6 text-center text-[11px] text-faint">拖到这里</div>}
              </div>
            </div>
          )
        })}
      </div>
      {ctx.menu}
    </div>
  )
}
