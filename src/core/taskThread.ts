// 任务的线：每条任务自带一个群聊会话（约定 .team/chat-contract.md v6）。
// 派活、认领、交付、审查这些事自动记进去，执行者、派活的人和用户在里面说和这条任务有关的话。
// 这里只有纯函数：频道 id、标题、谁在里面、任务记录怎么变成一条事件
import type { TaskHistory, TaskItem } from './types'

/** 已经记进线里的最后一条任务记录：时间戳，和这个时间戳上已经记了几条（同一毫秒里可能有两条） */
export interface TaskPosted {
  ts: number
  n: number
}

/** 任务的线的标题最多这么多字（和会话标题一样） */
const TITLE_MAX = 60

/**
 * 任务的线的频道 id：'ws:<工作区 id>.c_t<任务 id 去掉 t_>'，由任务 id 直接算出来，所以一条任务只会有一条线。
 * 用户另开的会话是 'c_' 加 10 位十六进制，不会和它撞。任务 id 不是 't_<字母数字>' 的（不该有）返回 undefined
 */
export function taskThreadChannel(workspaceId: string, taskId: string): string | undefined {
  const m = /^t_([a-z0-9]{5,19})$/.exec(taskId)
  if (!m || !/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId)) return undefined
  return `ws:${workspaceId}.c_t${m[1]}`
}

/** 线的标题：「T-12 任务标题」，太长截断 */
export function taskThreadTitle(ref: string, title: string): string {
  const t = `${ref} ${title}`.replace(/\s+/g, ' ').trim()
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t
}

/** 谁在这条线里：执行者、派活的人、创建者（只算 AI；用户总在）。isAgent 用来去掉用户、定时任务和已吊销的身份 */
export function taskThreadMembers(t: Pick<TaskItem, 'assigneeId' | 'managedBy' | 'createdBy'>, isAgent: (id: string) => boolean): string[] {
  return [...new Set([t.assigneeId, t.managedBy, t.createdBy].filter((id): id is string => !!id && isAgent(id)))].sort()
}

/** 任务记录现在记到哪了；没有记录返回 undefined */
export function historyMarker(history: TaskHistory[]): TaskPosted | undefined {
  const last = history[history.length - 1]
  if (!last) return undefined
  let n = 0
  for (let i = history.length - 1; i >= 0 && history[i].ts === last.ts; i--) n++
  return { ts: last.ts, n }
}

/** marker 之后新添的记录；没有 marker 就是全部。任务记录只留最近 100 条，所以按时间戳比，不按下标 */
export function entriesAfter(history: TaskHistory[], marker: TaskPosted | undefined): TaskHistory[] {
  if (!marker) return history.slice()
  const out: TaskHistory[] = []
  let same = 0
  for (const h of history) {
    if (h.ts > marker.ts) out.push(h)
    else if (h.ts === marker.ts && ++same > marker.n) out.push(h)
  }
  return out
}

const STATUS_LABEL: Record<string, string> = { todo: '待办', in_progress: '进行中', review: '待审查', done: '已完成', blocked: '卡住了' }

/** 事件正文最多带这么多字的说明 / 交付内容 */
export const TASK_EVENT_BODY_CHARS = 6000

const withBody = (head: string, body: string | undefined): string => {
  const b = body?.trim()
  if (!b) return head
  return `${head}\n\n${b.length > TASK_EVENT_BODY_CHARS ? `${b.slice(0, TASK_EVENT_BODY_CHARS)}\n…（太长，后面的在任务详情里）` : b}`
}

/**
 * 一条任务记录在线里显示成什么。latest：这条是不是任务现在的最后一条记录——
 * 是的话交付时带上完整的交付说明（记录里的备注只留了前 2000 字）
 */
export function taskEventText(h: TaskHistory, t: Pick<TaskItem, 'ref' | 'title' | 'description' | 'result'>, latest = false): string {
  const a = h.action
  if (a === 'created') return withBody(`创建了任务 ${t.ref}「${t.title}」${h.note ? `（${h.note}）` : ''}`, latest ? t.description : undefined)
  if (a === 'claimed') return '认领了这个任务'
  if (a === 'assigned') return h.note === '取消指派' ? '取消了指派，任务回到待认领' : `把任务派给了 ${h.note?.replace(/^→\s*/, '') ?? '别人'}`
  if (a === 'review: accepted') return withBody('审查通过，任务完成', h.note)
  if (a === 'review: rejected') return withBody('审查没通过，退回重做', h.note)
  if (a.startsWith('status → ')) {
    const rest = a.slice('status → '.length)
    const status = rest.split('（')[0]
    const auto = rest.includes('直接完成')
    const body = latest && (status === 'review' || status === 'done') && t.result ? t.result : h.note
    if (status === 'review') return withBody('做完了，提交审查', body)
    if (status === 'done') return withBody(auto ? '做完了（用户派的任务不用审查，直接完成）' : '把任务标成了已完成', body)
    return withBody(`把状态改成了「${STATUS_LABEL[status] ?? status}」`, body)
  }
  if (a === 'updated') return withBody('更新了任务', h.note)
  if (a === 'edited') return h.note ? `${h.note.replace(/^改了/, '改了任务的')}` : '改了任务'
  if (a === 'question_added') return withBody('提了一个要人决定的问题', h.note)
  if (a === 'question_answered') return withBody('回答了问题', h.note)
  if (a === 'question_closed') return withBody('关掉了问题', h.note)
  if (a === 'unassigned') return h.note ? `任务退回待认领：${h.note}` : '任务退回待认领'
  if (a === 'reviewer changed') return h.note ?? '换了审查的人'
  return withBody(a, h.note)
}
