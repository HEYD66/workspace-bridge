// 从一张卡片拉线到另一张以后弹出来的框：选「派一件活」还是「以后自动接力」。
// 不能做的那一项不藏起来，把原因写在上面。
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { BridgeState, TaskItem } from '../../../../core/types'
import { planAssign, planRelay } from '../../../../shared/canvasActions'
import type { CanvasRelay } from '../../../../shared/canvasDoc'
import { CANVAS_USER_ID, type CanvasModel } from '../../../../shared/canvasModel'
import { Button, cx } from '../../components/ui'
import { canvasUpdate, errText } from './canvasApi'

export interface AssignDialogProps {
  state: BridgeState
  model: CanvasModel
  relays: CanvasRelay[]
  workspaceId: string
  /** 线从哪张卡片拉出来：AI 的 id，用户是 'user' */
  fromId: string
  toId: string
  /** 拖的是一张任务卡片：这条任务的编号 */
  taskRef?: string
  onClose(): void
  /** 做成了（派了活或者连了接力线）之后叫一声 */
  onDone?(what: { kind: 'task'; task: TaskItem } | { kind: 'relay' }): void
}

type Mode = 'task' | 'relay'

const PRIORITIES: { value: TaskItem['priority']; label: string }[] = [
  { value: 'low', label: '不急' },
  { value: 'normal', label: '普通' },
  { value: 'high', label: '要紧' }
]

export function AssignDialog({ state, model, relays, workspaceId, fromId, toId, taskRef, onClose, onDone }: AssignDialogProps) {
  const nameOf = (id: string): string => (id === CANVAS_USER_ID ? '你' : (model.cards.find((c) => c.id === id)?.name ?? state.agents.find((a) => a.id === id)?.name ?? '（不在了的 AI）'))
  const assign = useMemo(() => planAssign(model, fromId, toId, taskRef), [model, fromId, toId, taskRef])
  const relay = useMemo(() => planRelay(model, relays, fromId, toId), [model, relays, fromId, toId])
  const existing = taskRef ? model.tasks.find((t) => t.ref === taskRef) : undefined
  const toCard = model.cards.find((c) => c.id === toId)
  const away = toCard && (toCard.state === 'offline' || toCard.state === 'stuck' || toCard.state === 'paused')

  const [mode, setMode] = useState<Mode>(assign.kind !== 'invalid' || taskRef ? 'task' : 'relay')
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [priority, setPriority] = useState<TaskItem['priority']>('normal')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  const fromAi = fromId !== CANVAS_USER_ID
  const canTask = assign.kind !== 'invalid' && (assign.kind === 'reassign' || title.trim().length > 0)
  const canRelay = relay.kind === 'add'

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (mode === 'task') {
        if (assign.kind === 'invalid') return
        const task =
          assign.kind === 'reassign'
            ? await window.bridge.assignTask(assign.taskRef, assign.assigneeId, workspaceId)
            : await window.bridge.createTask({ title: title.trim(), description: describe(desc, fromAi ? nameOf(fromId) : undefined), priority, assigneeId: assign.assigneeId }, workspaceId)
        onDone?.({ kind: 'task', task })
      } else {
        if (relay.kind !== 'add') return
        await canvasUpdate(workspaceId, [{ op: 'addRelay', from: relay.from, to: relay.to }])
        onDone?.({ kind: 'relay' })
      }
      onClose()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const tab = (m: Mode, label: string, ok: boolean): ReactNode => (
    <button
      type="button"
      onClick={() => setMode(m)}
      className={cx('flex-1 cursor-pointer rounded-md border px-2 py-1.5 text-left', mode === m ? 'border-accent bg-accent/10 text-fg' : 'border-line bg-panel text-muted hover:text-fg', !ok && 'opacity-60')}
    >
      {label}
    </button>
  )

  return (
    <div
      data-canvas-part="assign-dialog"
      data-cv-nodrag
      className="flex w-80 flex-col gap-2 rounded-xl border border-line bg-panel p-3 text-xs text-fg shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onClose()
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (mode === 'task' ? canTask : canRelay)) void submit()
      }}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <div className="font-medium">
        {nameOf(fromId)} → {nameOf(toId)}
      </div>
      <div className="flex gap-2">
        {tab('task', existing ? `把 ${existing.ref} 交给它` : '派一件活', assign.kind !== 'invalid')}
        {tab('relay', '以后自动接力', canRelay)}
      </div>

      {mode === 'task' &&
        (assign.kind === 'invalid' ? (
          <div className="text-warn">{assign.reason}</div>
        ) : assign.kind === 'reassign' ? (
          <div className="leading-5">
            把 <span className="font-medium">{assign.taskRef}</span>
            {existing ? `「${existing.title}」` : ''} 交给 {nameOf(toId)} 做。
            {existing?.assigneeId && existing.assigneeId !== toId ? `现在是 ${nameOf(existing.assigneeId)} 在做，会换人。` : ''}
          </div>
        ) : (
          <>
            <input
              ref={titleRef}
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="要它做什么（一句话）"
              className="h-7 rounded-md border border-line bg-canvas px-2 text-xs text-fg outline-none placeholder:text-muted focus:border-accent"
            />
            <textarea
              value={desc}
              rows={4}
              maxLength={7000}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="说明（可以不写）：做到什么算完、注意什么"
              className="resize-y rounded-md border border-line bg-canvas px-2 py-1.5 text-xs leading-5 text-fg outline-none placeholder:text-muted focus:border-accent"
            />
            <div className="flex items-center gap-1">
              <span className="text-muted">急不急：</span>
              {PRIORITIES.map((p) => (
                <button key={p.value} type="button" onClick={() => setPriority(p.value)} className={cx('cursor-pointer rounded px-1.5 py-0.5', priority === p.value ? 'bg-raised text-fg' : 'text-muted hover:text-fg')}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="leading-5 text-muted">
              {fromAi
                ? `这件活算你派的，做完交给你看。说明里会写上「来自 ${nameOf(fromId)} 那边的活」，${nameOf(toId)} 有问题会知道去问它。想让 ${nameOf(fromId)} 每次做完都自动转给 ${nameOf(toId)}，选「以后自动接力」。`
                : `会在任务页建一条任务并分给 ${nameOf(toId)}，它会收到通知。`}
            </div>
          </>
        ))}

      {mode === 'relay' &&
        (relay.kind === 'invalid' ? (
          <div className="text-warn">{relay.reason}</div>
        ) : (
          <div className="leading-5">
            连一条接力线：以后 <span className="font-medium">{nameOf(fromId)}</span> 每做完一条任务，工作台自动把它的交付说明转给 <span className="font-medium">{nameOf(toId)}</span>，让它接着做。
            <div className="text-muted">不想要了，在画布上点这条线删掉就行。</div>
          </div>
        ))}

      {away && <div className="text-warn">{nameOf(toId)} 现在收不到（{toCard.state === 'offline' ? '没连着' : toCard.state === 'stuck' ? '可能卡住了' : '暂停中'}），要等它回来才会看到。</div>}
      {error && <div className="text-bad">没成功：{error}</div>}

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button size="sm" variant="primary" disabled={busy || (mode === 'task' ? !canTask : !canRelay)} onClick={() => void submit()}>
          {busy ? '处理中…' : mode === 'relay' ? '连接力线' : assign.kind === 'reassign' ? '交给它' : '派活'}
        </Button>
      </div>
    </div>
  )
}

/** AI 的卡片拉出来的线：在说明前面注明这件活是从谁那边来的 */
function describe(desc: string, fromName: string | undefined): string {
  const body = desc.trim()
  if (!fromName) return body
  return `（来自 ${fromName} 那边的活，细节不清楚可以问它。）${body ? `\n\n${body}` : ''}`
}

export default AssignDialog
