// 画布卡片详情里的「它改了什么」：这个 AI 最近一次连接里改了哪些文件、各增删几行；
// 可以去「改动」页细看，可以撤销（先预演给用户看会动哪些文件，确认了才真撤），可以叫停这个 AI。
import { useCallback, useEffect, useState } from 'react'
import type { BridgeState, CheckpointRollbackResult, CheckpointSessionView, CheckpointSummaryResult } from '../../../../core/types'
import { Button, cx } from '../../components/ui'
import { navigate } from '../../lib/nav'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const ACTION_LABEL: Record<string, string> = { restore: '恢复成改之前的内容', recreate: '把删掉的建回来', delete: '把新建的移进回收站' }
const STATUS_LABEL: Record<string, string> = { added: '新建', modified: '修改', deleted: '删除' }

export interface AgentChangesProps {
  state: BridgeState
  agentId: string
  /** 看哪个项目里的改动 */
  workspaceId: string
  /** 叫停、撤销之后叫一声（画布可以刷新） */
  onChanged?: () => void
}

export function AgentChanges({ state, agentId, workspaceId, onChanged }: AgentChangesProps) {
  const agent = state.agents.find((a) => a.id === agentId)
  const online = (state.memberStatus?.[agentId]?.status ?? 'offline') !== 'offline'
  const [session, setSession] = useState<CheckpointSessionView | null>(null)
  const [older, setOlder] = useState(0)
  const [summary, setSummary] = useState<CheckpointSummaryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [plan, setPlan] = useState<CheckpointRollbackResult | null>(null)
  const [note, setNote] = useState('')
  const [stopAsk, setStopAsk] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const list = await window.bridge.listCheckpoints({ workspaceId, agentId, limit: 200 })
      const latest = list.sessions.find((s) => s.agentId === agentId) ?? null
      setSession(latest)
      setOlder(Math.max(0, list.sessions.filter((s) => s.agentId === agentId).length - 1))
      setSummary(latest ? await window.bridge.checkpointSummary({ workspaceId, session: latest.session }) : null)
    } catch (e) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
  }, [workspaceId, agentId])

  useEffect(() => {
    setPlan(null)
    setNote('')
    setStopAsk(false)
    void load()
  }, [load])

  // 它又改了文件，或者有人回滚了：重新拉
  useEffect(() => window.bridge.onChanged((kind) => kind === 'checkpoints' && void load()), [load])

  const openChanges = async () => {
    if (!session) return
    try {
      if (state.activeWorkspaceId !== workspaceId) await window.bridge.setActiveWorkspace(workspaceId)
      navigate({ section: 'changes', id: `session:${session.session}` })
    } catch (e) {
      setError(errText(e))
    }
  }

  const preview = async () => {
    if (!session) return
    setBusy(true)
    setError('')
    setNote('')
    try {
      setPlan(await window.bridge.rollbackCheckpoints({ workspaceId, session: session.session, dryRun: true }))
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const undo = async () => {
    if (!session) return
    setBusy(true)
    try {
      const r = await window.bridge.rollbackCheckpoints({ workspaceId, session: session.session })
      if (r.status === 'done') {
        setPlan(null)
        setNote(`已撤销 ${r.files.length} 个文件${r.checkpoint ? `。这次撤销存成了检查点 ${r.checkpoint}，后悔了可以在「改动」页再退回去` : ''}`)
        onChanged?.()
        void load()
      } else setPlan(r)
    } catch (e) {
      setError(errText(e))
      setPlan(null)
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    setBusy(true)
    setError('')
    try {
      // 先取消它名下还在跑的命令，再断开它的连接
      const cmds = await window.bridge.listAiCommands()
      const mine = cmds.commands.filter((c) => c.owner === agentId && c.status === 'running')
      for (const c of mine) await window.bridge.cancelAiCommand(c.command_id).catch(() => {})
      const n = await window.bridge.disconnectAgent(agentId)
      setNote(`已叫停：断开了 ${n} 条连接${mine.length ? `，取消了 ${mine.length} 条在跑的命令` : ''}。它的身份还在，它那边重新连接就能回来。`)
      setStopAsk(false)
      onChanged?.()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const files = summary?.files ?? []
  const totals = summary?.totals
  const name = agent?.name ?? '这个 AI'

  return (
    <div className="flex flex-col gap-2 text-xs text-fg" data-canvas-part="agent-changes">
      <div className="flex items-center gap-2">
        <span className="font-medium">它改了什么</span>
        {totals && files.length > 0 && (
          <span className="text-muted">
            {totals.files} 个文件 <span className="text-ok">+{totals.additions}</span> <span className="text-bad">−{totals.deletions}</span>
          </span>
        )}
        <span className="flex-1" />
        {session && (
          <Button size="sm" variant="ghost" onClick={() => void openChanges()} title="去「改动」页看每一步和完整的对比">
            去改动页
          </Button>
        )}
      </div>

      {loading && !summary && <div className="text-muted">正在读…</div>}
      {!loading && !session && <div className="text-muted">{name} 在这个项目里还没有改过文件。</div>}
      {session && files.length === 0 && !loading && <div className="text-muted">最近这次连接里的改动加起来等于没改（改了又改回去了，或者已经撤销）。</div>}

      {files.length > 0 && (
        <ul className="max-h-40 overflow-auto rounded border border-line bg-panel">
          {files.map((f) => (
            <li key={f.path} className="flex items-center gap-2 border-b border-line/60 px-2 py-1 last:border-b-0" title={f.path}>
              <span className={cx('shrink-0', f.status === 'added' ? 'text-ok' : f.status === 'deleted' ? 'text-bad' : 'text-muted')}>{STATUS_LABEL[f.status] ?? f.status}</span>
              <span className="min-w-0 flex-1 truncate font-mono" dir="rtl">
                <bdi>{f.path}</bdi>
              </span>
              {f.binary ? (
                <span className="shrink-0 text-muted">二进制</span>
              ) : (
                <span className="shrink-0 tabular-nums">
                  <span className="text-ok">+{f.additions}</span> <span className="text-bad">−{f.deletions}</span>
                </span>
              )}
              {f.changed_outside && (
                <span className="shrink-0 text-warn" title="这个文件后来又被别的途径（命令、编辑器）改过，撤销时可能冲突">
                  后来又动过
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {session && (
        <div className="text-muted">
          这是它最近一次连接（{new Date(session.firstTs).toLocaleString()} 起）里的改动{session.tasks.length ? `，挂在 ${session.tasks.join('、')} 上` : ''}。
          {older > 0 ? `更早还有 ${older} 次，在改动页里。` : ''}
        </div>
      )}

      {plan && (
        <div className="rounded border border-line bg-raised p-2" data-canvas-part="undo-plan">
          {plan.status === 'dry_run' && (
            <>
              <div className="mb-1 font-medium">撤销会动这 {plan.files.length} 个文件：</div>
              <ul className="max-h-32 overflow-auto">
                {plan.files.map((f) => (
                  <li key={f.path} className="flex gap-2 py-0.5">
                    <span className="min-w-0 flex-1 truncate font-mono" title={f.path}>
                      {f.path}
                    </span>
                    <span className="shrink-0 text-muted">{ACTION_LABEL[f.action] ?? f.action}</span>
                  </li>
                ))}
              </ul>
              {plan.skipped.length > 0 && <div className="mt-1 text-muted">有 {plan.skipped.length} 个不会动：{plan.skipped.map((s) => `${s.path}（${s.reason}）`).join('；')}</div>}
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="danger" disabled={busy || plan.files.length === 0} onClick={() => void undo()}>
                  确认撤销
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPlan(null)}>
                  不撤了
                </Button>
              </div>
            </>
          )}
          {plan.status === 'conflict' && (
            <>
              <div className="mb-1 font-medium text-warn">撤不了：{plan.message}</div>
              <ul className="max-h-32 overflow-auto">
                {plan.conflicts.map((c) => (
                  <li key={c.path} className="py-0.5">
                    <span className="font-mono">{c.path}</span> <span className="text-muted">{c.detail}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => void openChanges()}>
                  去改动页一个个处理
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPlan(null)}>
                  关掉
                </Button>
              </div>
            </>
          )}
          {plan.status === 'nothing' && (
            <div className="flex items-center gap-2">
              <span className="flex-1 text-muted">{plan.message}</span>
              <Button size="sm" variant="ghost" onClick={() => setPlan(null)}>
                关掉
              </Button>
            </div>
          )}
        </div>
      )}

      {note && <div className="rounded border border-line bg-raised px-2 py-1 text-muted">{note}</div>}
      {error && <div className="text-bad">{error}</div>}

      {stopAsk ? (
        <div className="flex items-center gap-2 rounded border border-line bg-raised p-2">
          <span className="flex-1">叫停 {name}：取消它在跑的命令，断开它的连接。它已经改了的文件不会动。</span>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void stop()}>
            确认叫停
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setStopAsk(false)}>
            算了
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" variant="danger" disabled={busy || !session || files.length === 0 || !!plan} onClick={() => void preview()} title="先看会动哪些文件，确认了才真的撤">
            撤销它的改动…
          </Button>
          <Button size="sm" variant="danger" disabled={busy || !online} onClick={() => setStopAsk(true)} title={online ? '取消它在跑的命令，断开它的连接' : '它现在没连着'}>
            叫停
          </Button>
        </div>
      )}
    </div>
  )
}

export default AgentChanges
