import { AlertCircle, ChevronRight, FileSearch, Loader2 } from 'lucide-react'
import { useState, type MouseEvent } from 'react'
import type { ActivityEvent } from '../../../shared/api'
import { clockTime, FILE_WRITE_TOOLS, toolLabel } from '../lib/format'
import { DiffView, diffStats } from './DiffView'
import { Avatar, cx, IconButton } from './ui'

/** 这些工具的 path 是一个文件，可以在编辑区打开（move 的 path 是目标位置） */
const OPENABLE_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'move'])

/** 这条事件能不能在编辑区打开 */
export function canOpenEvent(ev: ActivityEvent): boolean {
  return !!ev.path && ev.path !== '.' && OPENABLE_TOOLS.has(ev.tool)
}

/** AI 用 install_skill 写入技能成功的那条：可以从这里直接去技能页看它。返回技能名，不是这种事件返回 undefined */
export function installedSkillName(ev: ActivityEvent): string | undefined {
  if (ev.tool !== 'install_skill' || ev.status !== 'ok') return undefined
  const name = ev.args?.name
  return typeof name === 'string' && name ? name : undefined
}

/**
 * 活动流里的一条：谁 · 做了什么 · 在哪；可展开看 diff / 错误 / 参数。
 * onOpenFile：点路径或「在编辑区打开」时调用，第二个参数是整条事件（带 workspaceId）。
 * workspaceName：多个工作区时显示在路径前面。
 * onOpenSkill：这条是 AI 写入技能时，显示一个去技能页的按钮。
 */
export function EventItem({
  ev,
  onOpenFile,
  workspaceName,
  onOpenSkill
}: {
  ev: ActivityEvent
  onOpenFile?: (path: string, ev: ActivityEvent) => void
  workspaceName?: string
  onOpenSkill?: (name: string, ev: ActivityEvent) => void
}) {
  const [open, setOpen] = useState(false)
  const isWrite = FILE_WRITE_TOOLS.has(ev.tool)
  const stats = ev.diff ? diffStats(ev.diff) : null
  const target = ev.path && ev.path !== '.' ? ev.path : ev.tool === 'list_dir' ? '根目录' : undefined
  const openable = !!onOpenFile && canOpenEvent(ev)
  const openIt = (e: MouseEvent) => {
    e.stopPropagation()
    onOpenFile?.(ev.path!, ev)
  }
  const skillName = onOpenSkill ? installedSkillName(ev) : undefined

  return (
    <div className={cx('flash-in border-b border-line-soft', ev.status === 'error' && 'bg-bad/[0.04]')}>
      <div className="group flex cursor-pointer items-start gap-2 px-3 py-2 hover:bg-hover/60" onClick={() => setOpen(!open)}>
        <Avatar name={ev.agentName} color={ev.agentColor} size={18} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs">
            <span className="font-medium" style={{ color: ev.agentColor }}>
              {ev.agentName}
            </span>
            <span className={cx(isWrite ? 'text-warn' : 'text-muted')}>{toolLabel(ev.tool)}</span>
            {stats && (
              <span className="font-mono text-[11px]">
                <span className="text-ok">+{stats.added}</span> <span className="text-bad">-{stats.removed}</span>
              </span>
            )}
            <span className="ml-auto shrink-0 text-[11px] text-faint tabular-nums">{clockTime(ev.ts)}</span>
          </div>
          {(target || workspaceName) && (
            <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px]">
              {workspaceName && <span className="max-w-[40%] shrink-0 truncate text-faint">{workspaceName}</span>}
              {workspaceName && target && <span className="shrink-0 text-faint">·</span>}
              {target &&
                (openable ? (
                  <button title="在编辑区打开" onClick={openIt} className="min-w-0 cursor-pointer truncate text-left font-mono text-muted hover:text-accent hover:underline">
                    {target}
                  </button>
                ) : (
                  <span className="min-w-0 truncate font-mono text-muted">{target}</span>
                ))}
            </div>
          )}
          {ev.status === 'error' && (
            <div className="mt-0.5 flex items-start gap-1 text-[11px] text-bad">
              <AlertCircle size={11} className="mt-0.5 shrink-0" />
              <span className={cx(!open && 'line-clamp-2')}>{ev.error}</span>
            </div>
          )}
          {/* 还在跑的调用一般没有摘要；有的话（活动列表把连着的「等消息」合成一条时写的）也照样显示 */}
          {(ev.status === 'ok' || ev.status === 'running') && ev.summary && !target?.includes(ev.summary) && <div data-event-summary className="mt-0.5 truncate text-[11px] text-faint">{ev.summary}</div>}
          {skillName && (
            <button
              title="这个技能已经生效。在技能页可以看它的内容，也可以停用或删除"
              onClick={(e) => {
                e.stopPropagation()
                onOpenSkill?.(skillName, ev)
              }}
              className="mt-1 inline-flex h-5 cursor-pointer items-center rounded border border-line px-1.5 text-[11px] text-muted hover:bg-hover hover:text-fg"
            >
              在技能页打开
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center">
          {ev.status === 'running' && <Loader2 size={13} className="animate-spin text-accent" />}
          {openable && ev.tool !== 'read_file' && (
            <IconButton title="在编辑区打开" className="opacity-0 group-hover:opacity-100" onClick={openIt}>
              <FileSearch size={13} />
            </IconButton>
          )}
          <ChevronRight size={13} className={cx('text-faint transition-transform', open && 'rotate-90')} />
        </div>
      </div>
      {open && (
        <div className="space-y-2 px-3 pb-3 pl-[34px]">
          {ev.diff && <DiffView diff={ev.diff} maxHeight={320} />}
          <pre className="selectable max-h-48 overflow-auto rounded-md border border-line-soft bg-canvas px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted">
            {JSON.stringify(ev.args, null, 2)}
          </pre>
          {ev.durationMs !== undefined && <div className="text-[11px] text-faint">耗时 {ev.durationMs}ms</div>}
        </div>
      )}
    </div>
  )
}
