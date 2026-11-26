// T-23：AI 细分状态的小零件（圆点、标签、任务卡提醒）。逻辑在 lib/memberStatus.ts。
import { AlertTriangle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { TaskStatus } from '../../../core/types'
import { assigneeAlert, describeMemberStatus, type MemberStatus } from '../lib/memberStatus'
import { cx } from './ui'

/** 持续时间要跟着走：每 30 秒刷新一次 */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

/** 小圆点，悬停看详情 */
export function MemberStatusDot({ status, size = 8, className }: { status: MemberStatus; size?: number; className?: string }) {
  const v = describeMemberStatus(status, useNow())
  return (
    <span
      className={cx('inline-block shrink-0 rounded-full', v.kind === 'working' && status.calling !== false && 'pulse-dot', className)}
      style={{ width: size, height: size, background: v.color }}
      title={v.title}
      aria-label={v.label}
    />
  )
}

/** （可选圆点 +）一句话说明 + 持续时间（成员列表的第二行），悬停看详情。行尾已经有 MemberStatusDot 时不带圆点 */
export function MemberStatusLine({ status, dot, className }: { status: MemberStatus; dot?: boolean; className?: string }) {
  const v = describeMemberStatus(status, useNow())
  return (
    <span className={cx('inline-flex max-w-full min-w-0 items-center gap-1', className)} title={v.title}>
      {dot && <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: v.color }} />}
      <span className="truncate" style={v.kind === 'idle' || v.kind === 'offline' ? undefined : { color: v.color }}>
        {v.line}
      </span>
    </span>
  )
}

/** 任务卡上的提醒：执行者可能卡住或离线时显示，否则什么都不渲染 */
export function AssigneeAlert({ status, taskStatus }: { status?: MemberStatus; taskStatus: TaskStatus }) {
  const now = useNow()
  const text = assigneeAlert(status, taskStatus, now)
  if (!text || !status) return null
  return (
    <div className="mt-1.5 flex items-center gap-1 rounded bg-warn/10 px-1.5 py-0.5 text-[11px] text-warn" title={describeMemberStatus(status, now).title}>
      <AlertTriangle size={11} className="shrink-0" />
      <span className="truncate">{text}</span>
    </div>
  )
}
