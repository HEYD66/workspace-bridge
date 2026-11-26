// 看板：和画布是同一批 AI，换一种摆法——按「现在什么情况」分成几列，一眼看出谁在等你、谁在干、谁闲着。
// 点一行由外面决定做什么（一般是切回画布并把镜头移到那张卡片）。
import { useMemo } from 'react'
import type { CanvasCardState } from '../../../../shared/canvasModel'
import { cx } from '../../components/ui'

/** 看板要的一张卡片：画布的 BoardCard 直接传进来就行，多出来的项不碍事 */
export interface LaneCard {
  key: string
  kind: 'agent' | 'user'
  name: string
  role?: string
  state: CanvasCardState
  lead?: boolean
  attention: readonly { kind: string; taskRef: string; taskTitle: string; text?: string }[]
  tasks: readonly { ref: string; title: string; status: string }[]
  tool?: string
  /** 它在哪个项目（画布上那个框的名字） */
  groupName?: string
  color?: string
}

export interface BoardLanesProps {
  cards: readonly LaneCard[]
  selected?: readonly string[]
  onPick(key: string): void
  /** 双击一行（一般是打开和它的对话） */
  onOpen?(key: string): void
}

type LaneId = 'attention' | CanvasCardState

const LANES: { id: LaneId; label: string; hint: string; color: string }[] = [
  { id: 'attention', label: '等你', hint: '有问题等你回答，或者交了活你还没看', color: '#d29922' },
  { id: 'working', label: '在干活', hint: '正在调工具', color: '#58a6ff' },
  { id: 'waiting', label: '等回复', hint: '在等群里的消息，有人说话它就会动', color: '#3fb950' },
  { id: 'idle', label: '空闲', hint: '连着，但现在没在做事', color: '#8b949e' },
  { id: 'stuck', label: '可能卡住了', hint: '手上有活，却很久没动静', color: '#f85149' },
  { id: 'paused', label: '暂停中', hint: '工作台整体暂停了', color: '#a371f7' },
  { id: 'offline', label: '没连着', hint: '现在不在线', color: '#5a5a5a' }
]

const ATTENTION_LABEL: Record<string, string> = { question: '有问题等你答', review: '等你验收', delivered: '交了活，你还没看', blocked: '被卡住了' }

export function laneOf(card: LaneCard): LaneId {
  return card.attention.length > 0 ? 'attention' : card.state
}

export function BoardLanes({ cards, selected, onPick, onOpen }: BoardLanesProps) {
  const lanes = useMemo(() => {
    const agents = cards.filter((c) => c.kind === 'agent')
    return LANES.map((l) => ({
      ...l,
      cards: agents.filter((c) => laneOf(c) === l.id).sort((a, b) => Number(!!b.lead) - Number(!!a.lead) || a.name.localeCompare(b.name, 'zh-CN'))
    }))
  }, [cards])
  const picked = useMemo(() => new Set(selected ?? []), [selected])
  const total = lanes.reduce((n, l) => n + l.cards.length, 0)
  // 没人的列收窄成一条，把地方让给有人的；「等你」「在干活」一直留着
  const shown = lanes.filter((l) => l.cards.length > 0 || l.id === 'attention' || l.id === 'working')

  if (total === 0) return <div className="flex h-full w-full items-center justify-center text-xs text-muted">还没有 AI。先新建一个，它就会出现在这里。</div>

  return (
    <div data-canvas-part="lanes" data-cv-nodrag data-cv-scroll className="flex h-full w-full gap-3 overflow-x-auto p-3 text-xs text-fg">
      {shown.map((l) => (
        <section key={l.id} data-lane={l.id} className="flex max-w-md min-w-44 flex-1 basis-0 flex-col rounded-lg border border-line bg-panel">
          <header className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2" title={l.hint}>
            <span className="h-2 w-2 rounded-full" style={{ background: l.color }} />
            <span className="font-medium">{l.label}</span>
            <span className="text-muted">{l.cards.length}</span>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-1.5" data-cv-scroll>
            {l.cards.length === 0 && <div className="px-1 py-2 text-muted">{l.id === 'attention' ? '没有等你的事。' : '现在没有。'}</div>}
            {l.cards.map((c) => {
              const first = c.attention[0]
              const task = c.tasks[0]
              return (
                <button
                  key={c.key}
                  type="button"
                  data-lane-card={c.key}
                  onClick={() => onPick(c.key)}
                  onDoubleClick={() => onOpen?.(c.key)}
                  className={cx('flex cursor-pointer flex-col gap-0.5 rounded-md border bg-raised px-2 py-1.5 text-left hover:bg-hover', picked.has(c.key) ? 'border-accent' : 'border-line')}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: c.color ?? l.color }} />
                    <span className="min-w-0 flex-1 truncate font-medium" title={c.name}>
                      {c.name}
                    </span>
                    {c.lead && <span className="shrink-0 text-accent">主脑</span>}
                  </span>
                  {(c.groupName || c.role) && <span className="truncate text-muted">{[c.groupName, c.role].filter(Boolean).join(' · ')}</span>}
                  {first && (
                    <span className="truncate text-warn" title={first.text ?? first.taskTitle}>
                      {ATTENTION_LABEL[first.kind] ?? first.kind}：{first.taskRef} {first.taskTitle}
                      {c.attention.length > 1 ? `（共 ${c.attention.length} 件）` : ''}
                    </span>
                  )}
                  {task ? (
                    <span className="truncate" title={`${task.ref} ${task.title}`}>
                      {task.ref} {task.title}
                      {c.tasks.length > 1 ? `（手上 ${c.tasks.length} 件）` : ''}
                    </span>
                  ) : (
                    !first && <span className="text-muted">手上没有任务</span>
                  )}
                  {c.state === 'working' && c.tool && <span className="truncate text-muted">正在用 {c.tool}</span>}
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

export default BoardLanes
