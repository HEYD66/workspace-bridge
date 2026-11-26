// 项目框标题上的菜单：这个项目的 AI 怎么配合（分工明确 / 灵感激荡）、谁当主脑、谁是子代理，
// 以及把现在的分工存成模板、套用模板、删模板。
import { useMemo, useState } from 'react'
import type { BridgeState } from '../../../../core/types'
import { currentSubs, planApplyTemplate, planSetLead, templateFromTeam, type TeamPlan } from '../../../../shared/canvasActions'
import type { CanvasDoc, CanvasTemplate } from '../../../../shared/canvasDoc'
import { Button, cx } from '../../components/ui'
import { canAccess, channelInfo, wsChannel } from '../../lib/groupChat'
import { canvasUpdate, errText } from './canvasApi'

export interface TeamMenuProps {
  state: BridgeState
  workspaceId: string
  /** 这个项目的画布文档（模板存在里面） */
  doc: CanvasDoc
  onClose(): void
}

export function TeamMenu({ state, workspaceId, doc, onClose }: TeamMenuProps) {
  const channel = wsChannel(workspaceId)
  const info = channelInfo(state, channel)
  const members = useMemo(() => state.agents.filter((a) => canAccess(a, channel, state.workspaces)), [state.agents, state.workspaces, channel])
  const ids = useMemo(() => members.map((a) => a.id), [members])
  const leadId = info?.leadId && ids.includes(info.leadId) ? info.leadId : undefined
  const team = useMemo(() => ({ leadId, ...(info?.subIds ? { subIds: info.subIds } : {}) }), [leadId, info?.subIds])
  const subs = useMemo(() => new Set(currentSubs(team, ids)), [team, ids])
  const nameOf = (id: string): string => state.agents.find((a) => a.id === id)?.name ?? '（不在了的 AI）'

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [tplName, setTplName] = useState('')
  const [askRemove, setAskRemove] = useState<string>()

  const run = async (fn: () => Promise<unknown>, done?: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    setNote('')
    try {
      await fn()
      if (done) setNote(done)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const applyPlan = (plan: TeamPlan, done?: string): void => {
    if (plan.kind === 'none') {
      setError(plan.reason)
      return
    }
    void run(() => window.bridge.setGroupChatLead(channel, plan.leadId ?? null, plan.leadId ? plan.subIds : undefined), done)
  }

  const toggleSub = (id: string): void => {
    if (!leadId) return
    const next = new Set(subs)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    const others = ids.filter((x) => x !== leadId)
    const picked = others.filter((x) => next.has(x))
    // 全勾上 = 不挑（以后新来的 AI 也算）
    void run(() => window.bridge.setGroupChatSubs(channel, picked.length === others.length ? null : picked))
  }

  const saveTemplate = (): void => {
    const name = tplName.trim()
    if (!name || !leadId) return
    const t = templateFromTeam(team, ids)
    void run(async () => {
      await canvasUpdate(workspaceId, [{ op: 'saveTemplate', name, ...(t.leadId ? { leadId: t.leadId } : {}), memberIds: t.memberIds }])
      setTplName('')
    }, `存好了：「${name}」`)
  }

  const applyTemplate = (t: CanvasTemplate): void => {
    const plan = planApplyTemplate(t, ids)
    const gone = plan.missing.length ? `（模板里有 ${plan.missing.length} 个 AI 已经不在，跳过了）` : ''
    applyPlan(plan, `已套用「${t.name}」${gone}`)
  }

  const describe = (t: CanvasTemplate): string => `主脑 ${t.leadId ? nameOf(t.leadId) : '没有'}${t.memberIds.length ? `，带 ${t.memberIds.map(nameOf).join('、')}` : '，一个人干'}`

  return (
    <div
      data-canvas-part="team-menu"
      data-cv-nodrag
      className="flex max-h-[70vh] w-72 flex-col gap-2 overflow-y-auto rounded-xl border border-line bg-panel p-3 text-xs text-fg shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onClose()
      }}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <div className="flex items-center">
        <span className="flex-1 font-medium">这个项目的 AI 怎么配合</span>
        <button type="button" className="cursor-pointer text-muted hover:text-fg" onClick={onClose} aria-label="关掉">
          ✕
        </button>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || members.length === 0}
          onClick={() => !leadId && members[0] && applyPlan(planSetLead(team, ids, members[0].id))}
          className={cx('flex-1 cursor-pointer rounded-md border px-2 py-1.5 text-left', leadId ? 'border-accent bg-accent/10' : 'border-line text-muted hover:text-fg')}
          title="一个主脑拆活、派活、验收，别的 AI 当子代理干活"
        >
          分工明确
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => leadId && applyPlan({ kind: 'set', leadId: undefined, subIds: null })}
          className={cx('flex-1 cursor-pointer rounded-md border px-2 py-1.5 text-left', !leadId ? 'border-accent bg-accent/10' : 'border-line text-muted hover:text-fg')}
          title="没有主脑，大家在群里一起讨论"
        >
          灵感激荡
        </button>
      </div>

      {members.length === 0 ? (
        <div className="text-muted">还没有能进这个项目的 AI。</div>
      ) : (
        <ul className="flex flex-col rounded border border-line">
          {members.map((a) => {
            const isLead = a.id === leadId
            return (
              <li key={a.id} className="flex items-center gap-2 border-b border-line/60 px-2 py-1 last:border-b-0">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: a.color }} />
                <span className="min-w-0 flex-1 truncate" title={a.name}>
                  {a.name}
                </span>
                {isLead ? (
                  <span className="shrink-0 text-accent">主脑</span>
                ) : (
                  <>
                    {leadId && (
                      <label className="flex shrink-0 cursor-pointer items-center gap-1 text-muted" title="勾上：算这个团队的子代理，主脑可以给它派活">
                        <input type="checkbox" checked={subs.has(a.id)} disabled={busy} onChange={() => toggleSub(a.id)} />
                        子代理
                      </label>
                    )}
                    <button type="button" disabled={busy} className="shrink-0 cursor-pointer text-muted hover:text-fg disabled:opacity-40" onClick={() => applyPlan(planSetLead(team, ids, a.id))}>
                      {leadId ? '换它当主脑' : '让它当主脑'}
                    </button>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <div className="mt-1 font-medium">团队模板</div>
      {doc.templates.length === 0 && <div className="text-muted">还没有模板。把现在的分工存一份，下次一键套用。</div>}
      {doc.templates.map((t) => (
        <div key={t.id} className="flex items-center gap-2 rounded border border-line px-2 py-1">
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium" title={t.name}>
              {t.name}
            </div>
            <div className="truncate text-muted" title={describe(t)}>
              {describe(t)}
            </div>
          </div>
          {askRemove === t.id ? (
            <>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(() => canvasUpdate(workspaceId, [{ op: 'removeTemplate', id: t.id }]).then(() => setAskRemove(undefined)), `删掉了「${t.name}」`)}>
                确认删
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAskRemove(undefined)}>
                不删
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" disabled={busy} onClick={() => applyTemplate(t)}>
                套用
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAskRemove(t.id)}>
                删
              </Button>
            </>
          )}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <input
          value={tplName}
          maxLength={40}
          onChange={(e) => setTplName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && saveTemplate()}
          placeholder={leadId ? '给现在的分工起个名字' : '先选一个主脑，才有分工可存'}
          disabled={!leadId}
          className="h-6 min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 text-xs text-fg outline-none placeholder:text-muted focus:border-accent disabled:opacity-50"
        />
        <Button size="sm" disabled={busy || !leadId || !tplName.trim()} onClick={saveTemplate}>
          存成模板
        </Button>
      </div>

      {note && <div className="text-muted">{note}</div>}
      {error && <div className="text-bad">{error}</div>}
    </div>
  )
}

export default TeamMenu
