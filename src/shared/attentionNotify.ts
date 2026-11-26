// 有事等用户时弹系统通知（T-19）：画布上「等你」的事（AI 提了问题、交活等验收、做完交付了还没看）
// 和「可能卡住」（连着、手上有活、很久没动静）。这里只算「这一刻有哪些事、哪些是新出来的」，
// 弹不弹、怎么弹由主进程定（src/main/index.ts 的 maybeNotifyAttention）。

import type { CanvasModel } from './canvasModel'

/** 一个项目的画布 */
export interface AttentionSource {
  workspaceId: string
  workspaceName: string
  model: CanvasModel
}

export interface AttentionNotice {
  /** 同一件事 key 不变，只弹一次靠它 */
  key: string
  kind: 'question' | 'review' | 'delivered' | 'stuck'
  workspaceId: string
  /** 画布上那张卡片：AI 的成员 id */
  cardId: string
  title: string
  body: string
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** 所有项目画布上这一刻等用户的事，早的在前。可能卡住的 AI 在几个项目里都有卡片时只算一次 */
export function collectAttention(sources: AttentionSource[]): AttentionNotice[] {
  const out: AttentionNotice[] = []
  const keys = new Set<string>()
  const add = (n: AttentionNotice): void => {
    if (keys.has(n.key)) return
    keys.add(n.key)
    out.push(n)
  }
  for (const { workspaceId, workspaceName, model } of sources) {
    for (const card of model.cards) {
      if (card.kind !== 'agent') continue
      for (const a of card.attention) {
        const task = `${a.taskRef}「${oneLine(a.taskTitle, 40)}」`
        // 等验收、做完的 key 不带时间：等着时任务加个备注不重弹；退回再交时中间会从记录里消失，照样重弹
        const base = { key: `${a.kind}:${workspaceId}:${a.taskRef}${a.questionId ? `:${a.questionId}` : ''}`, kind: a.kind, workspaceId, cardId: card.id }
        if (a.kind === 'question') add({ ...base, title: `${card.name} 在 ${workspaceName} 问你`, body: `${task}：${oneLine(a.text ?? '', 140)}` })
        else if (a.kind === 'review') add({ ...base, title: `${card.name} 交活等你验收`, body: `${workspaceName} ${task}${a.text ? `：${oneLine(a.text, 120)}` : ''}` })
        else add({ ...base, title: `${card.name} 做完了 ${a.taskRef}`, body: `${workspaceName} ${task}${a.text ? `：${oneLine(a.text, 120)}` : ''}` })
      }
      if (card.state === 'stuck' && card.tasks.length > 0) {
        const refs = card.tasks.map((t) => `${t.ref}「${oneLine(t.title, 30)}」`).join('、')
        add({ key: `stuck:${card.id}:${card.since ?? 0}`, kind: 'stuck', workspaceId, cardId: card.id, title: `${card.name} 可能卡住了`, body: `${workspaceName} 手上还挂着 ${refs}，很久没动静` })
      }
    }
  }
  return out
}

/** 记着哪些事已经弹过（或者用户看着工作台时已经出现过），只放出新出来的 */
export class AttentionTracker {
  private known: Set<string> | null = null

  /**
   * 返回这次该弹的事。第一次调用只记下已有的（启动时不翻旧账）；
   * looking=true 表示用户正看着工作台：记下来但不弹，之后也不再弹。
   * 已经不在的事（回答了、看过了）从记录里删掉
   */
  update(items: AttentionNotice[], looking: boolean): AttentionNotice[] {
    const prev = this.known
    this.known = new Set(items.map((i) => i.key))
    if (!prev || looking) return []
    return items.filter((i) => !prev.has(i.key))
  }
}

/** 几件事一起出来时并成一条通知；点开跳到第一件那张卡片 */
export function attentionMessage(fresh: AttentionNotice[]): { title: string; body: string; target: AttentionNotice } | null {
  if (fresh.length === 0) return null
  const [first] = fresh
  if (fresh.length === 1) return { title: first.title, body: first.body, target: first }
  return { title: `${fresh.length} 件事等你`, body: fresh.slice(0, 4).map((n) => n.title).join('；') + (fresh.length > 4 ? '…' : ''), target: first }
}
