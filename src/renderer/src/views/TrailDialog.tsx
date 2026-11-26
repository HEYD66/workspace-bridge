// 留痕清单：按任务编号看谁改了哪些文件。从检查点现算（lib 在 src/shared/changeTrail.ts，和 AI 用的 change_trail 工具是同一份算法）
import { ClipboardCopy, Loader2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { buildTrail, trailMarkdown, type TrailEntry } from '../../../shared/changeTrail'
import { Button, cx } from '../components/ui'
import { errText } from '../lib/format'

/** 一次最多拿这么多步检查点来算 */
const MAX_STEPS = 1000

const when = (ts: number): string => {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function TrailDialog({ workspaceId, workspaceName, onClose }: { workspaceId: string; workspaceName: string; onClose: () => void }) {
  const [entries, setEntries] = useState<TrailEntry[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no')

  useEffect(() => {
    let alive = true
    // elsewhere：AI 经「整台电脑」改、挂在这个项目任务上的改动存在那边，一起要过来
    Promise.all([window.bridge.listCheckpoints({ workspaceId, limit: MAX_STEPS, elsewhere: true }), window.bridge.listTasks(workspaceId).catch(() => [])]).then(
      ([list, tasks]) => {
        if (!alive) return
        const steps = [...list.sessions.flatMap((s) => s.steps), ...(list.elsewhere ?? [])]
        setEntries(buildTrail(steps, new Map(tasks.map((t) => [t.ref.toUpperCase(), { title: t.title, status: t.status }]))))
        setTruncated(list.truncated)
      },
      (e) => alive && setError(errText(e))
    )
    return () => {
      alive = false
    }
  }, [workspaceId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const markdown = useMemo(() => (entries ? trailMarkdown(entries, { heading: `${workspaceName} 改动留痕` }) : ''), [entries, workspaceName])

  const copy = (): void => {
    const done = (ok: boolean): void => setCopied(ok ? 'yes' : 'failed')
    try {
      navigator.clipboard.writeText(markdown).then(
        () => done(true),
        () => done(false)
      )
    } catch {
      done(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[8vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="留痕清单"
        data-trail-dialog
        className="flex max-h-[80vh] w-[720px] max-w-full flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-2xl shadow-black/50"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line-soft px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] text-fg">留痕清单 · {workspaceName}</div>
            <div className="mt-0.5 text-xs leading-relaxed text-muted">每条任务谁改了哪些文件。AI 改文件前工作台都会记一笔，这张清单是从这些记录里现算的，不用在代码里做标记。</div>
          </div>
          <Button size="sm" data-trail-copy disabled={!entries} onClick={copy}>
            <ClipboardCopy size={12} />
            {copied === 'yes' ? '已复制' : '复制成文字'}
          </Button>
          <button type="button" aria-label="关闭" title="关闭" onClick={onClose} className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted hover:bg-hover hover:text-fg">
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {error && <div className="text-xs text-bad">拿不到改动记录：{error}</div>}
          {!entries && !error && (
            <div className="flex items-center gap-2 text-xs text-muted">
              <Loader2 size={13} className="animate-spin" />
              正在整理…
            </div>
          )}
          {copied === 'failed' && (
            <div className="mb-3">
              <div className="mb-1 text-xs text-warn">这里写不了剪贴板，下面的文字可以手动选中复制：</div>
              <textarea readOnly value={markdown} className="h-40 w-full rounded border border-line bg-canvas p-2 font-mono text-[11px] text-fg" onFocus={(e) => e.currentTarget.select()} />
            </div>
          )}
          {entries?.length === 0 && <div className="text-xs text-muted">这个项目还没有改动记录。AI 用写文件、改文件这些工具改过东西之后，这里就有了。</div>}
          {truncated && <div className="mb-3 text-xs text-warn">改动太多，这里只算了最近 {MAX_STEPS} 步。</div>}
          {entries?.map((e) => (
            <div key={e.task ?? ''} data-trail-entry={e.task ?? 'none'} className="mb-4">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className={cx('text-[13px]', e.task ? 'text-fg' : 'text-muted')}>
                  {e.task ? (
                    <>
                      <span className="font-mono text-accent">{e.task}</span> {e.title ?? '（任务已经删了）'}
                    </>
                  ) : (
                    '没挂任务的改动'
                  )}
                </span>
                {e.status && <span className="rounded bg-hover px-1 text-[10px] text-muted">{e.status}</span>}
                <span className="text-[11px] text-faint">
                  {when(e.firstTs)}
                  {e.lastTs !== e.firstTs && ` ～ ${when(e.lastTs)}`}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-muted">{e.agents.map((a) => `${a.name}（${a.edits} 次，${a.files} 个文件）`).join('、')}</div>
              <div className="mt-1.5 rounded border border-line-soft">
                {e.files.map((f) => (
                  <div key={f.path} data-trail-file={f.path} className="flex items-baseline gap-2 border-b border-line-soft px-2 py-1 text-xs last:border-b-0">
                    <span className={cx('min-w-0 flex-1 truncate font-mono text-[11.5px]', f.undone ? 'text-faint line-through' : 'text-fg')} title={f.path}>
                      {f.path}
                    </span>
                    <span className="shrink-0 text-faint">
                      {f.by.join('、')}
                      {f.edits > 1 && ` · ${f.edits} 次`}
                      {f.undone && ' · 已撤销'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
