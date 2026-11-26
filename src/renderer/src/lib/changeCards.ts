// 群聊里的「改动卡片」（照 Codex 每轮结束的「已编辑 N 个文件 +a -b」）：
// AI 在工作区频道里每发一条消息，把它从上一条消息到这一条之间改的文件汇总成一张卡片挂在这条消息下面
import { useEffect, useState } from 'react'
import type { CheckpointStepView, GroupMessage } from '../../../core/types'

/** 找不到同一个 AI 的上一条消息时，最多往前算这么久的改动 */
export const CARD_WINDOW_MS = 2 * 60 * 60 * 1000

export interface ChangeCardFile {
  path: string
  change: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
}

export interface ChangeCard {
  /** 涉及的检查点，旧的在前 */
  stepIds: string[]
  files: ChangeCardFile[]
  additions: number
  deletions: number
  /** 这些检查点有没有被退回过：none 都没有，all 全退回了，partial 退了一部分 */
  rolledBack: 'none' | 'partial' | 'all'
}

/** 几步检查点（旧的在前）改过的文件合在一起：同一个文件的增减行数相加 */
export function mergeStepFiles(steps: CheckpointStepView[]): ChangeCardFile[] {
  const files = new Map<string, ChangeCardFile>()
  for (const s of steps) {
    for (const f of s.files) {
      const prev = files.get(f.path)
      if (!prev) files.set(f.path, { path: f.path, change: f.change, additions: f.additions, deletions: f.deletions })
      else {
        prev.additions += f.additions
        prev.deletions += f.deletions
        // 先新建后修改还是「新建」；之后删掉了就算「删除」
        if (f.change === 'deleted') prev.change = 'deleted'
        else if (prev.change === 'deleted') prev.change = f.change
      }
    }
  }
  return [...files.values()]
}

/**
 * 每条 AI 消息对应的改动卡片（没有改动的消息不在结果里）。
 * 归属规则：检查点是这个 AI 做的、是改文件（不是回滚）、时间在「它在这个列表里的上一条消息」之后到这条消息为止；
 * 没有上一条时最多往前算 CARD_WINDOW_MS。messages 要按时间从旧到新。私聊和用户的消息没有卡片
 */
export function changeCards(messages: GroupMessage[], steps: CheckpointStepView[]): Map<string, ChangeCard> {
  const out = new Map<string, ChangeCard>()
  if (!steps.length) return out
  const byAgent = new Map<string, CheckpointStepView[]>()
  for (const s of steps) {
    if (s.kind !== 'edit') continue
    const list = byAgent.get(s.agentId)
    if (list) list.push(s)
    else byAgent.set(s.agentId, [s])
  }
  for (const list of byAgent.values()) list.sort((a, b) => a.ts - b.ts)
  const lastTs = new Map<string, number>()
  for (const m of messages) {
    if (m.from.kind !== 'agent' || m.to) continue
    const from = Math.max(lastTs.get(m.from.id) ?? 0, m.ts - CARD_WINDOW_MS)
    lastTs.set(m.from.id, m.ts)
    const mine = (byAgent.get(m.from.id) ?? []).filter((s) => s.ts > from && s.ts <= m.ts)
    if (!mine.length) continue
    const list = mergeStepFiles(mine)
    if (!list.length) continue
    const done = mine.filter((s) => s.rolledBack === 'all').length
    out.set(m.id, {
      stepIds: mine.map((s) => s.id),
      files: list,
      additions: list.reduce((n, f) => n + f.additions, 0),
      deletions: list.reduce((n, f) => n + f.deletions, 0),
      rolledBack: done === mine.length ? 'all' : done > 0 || mine.some((s) => s.rolledBack === 'partial') ? 'partial' : 'none'
    })
  }
  return out
}

/** 一个工作区最近的检查点（各会话摊平）；有新检查点或回滚时重拉。workspaceId 没有（大厅）时返回空 */
export function useWorkspaceSteps(workspaceId: string | undefined): CheckpointStepView[] {
  const [steps, setSteps] = useState<CheckpointStepView[]>([])
  useEffect(() => {
    if (!workspaceId) {
      setSteps([])
      return
    }
    let dead = false
    let seq = 0
    const load = async () => {
      const mine = ++seq
      try {
        const r = await window.bridge.listCheckpoints({ workspaceId, limit: 400 })
        if (!dead && mine === seq) setSteps(r.sessions.flatMap((s) => s.steps))
      } catch {
        // 旧版主进程或工作区刚被移除：不显示卡片
        if (!dead && mine === seq) setSteps([])
      }
    }
    void load()
    const off = window.bridge.onChanged((kind) => {
      if (kind === 'checkpoints') void load()
    })
    return () => {
      dead = true
      off()
    }
  }, [workspaceId])
  return steps
}
