// 改动与检查点：AI 改文件前自动存的检查点，按会话 / AI 看净改动和 diff，以用户身份回滚（先预演再确认）
import { FileDiff, GitCompare, ListChecks, RotateCcw, TriangleAlert, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type {
  CheckpointListResult,
  CheckpointRollbackResult,
  CheckpointSessionView,
  CheckpointStepView,
  CheckpointSummaryFile,
  CheckpointSummaryResult
} from '../../../shared/api'
import type { BridgeState } from '../../../core/types'
import { DiffView } from '../components/DiffView'
import { Avatar, Badge, Button, EmptyState, PanelHeader, cx } from '../components/ui'
import { clockTime, errText, timeAgo, toolLabel } from '../lib/format'
import { TrailDialog } from './TrailDialog'

// ===== 列表数据：侧栏和主区共用一份（切 AI 筛选、收到 'checkpoints' 变化时重新拉） =====

interface ListState {
  workspaceId?: string
  agentId: string
  data: CheckpointListResult | null
  error: string
  loading: boolean
}

let listState: ListState = { agentId: '', data: null, error: '', loading: false }
const listeners = new Set<() => void>()
let reqSeq = 0

function setList(patch: Partial<ListState>): void {
  listState = { ...listState, ...patch }
  for (const l of listeners) l()
}

function reloadList(): void {
  const ws = listState.workspaceId
  if (!ws) return
  const my = ++reqSeq
  setList({ loading: true })
  window.bridge
    .listCheckpoints({ workspaceId: ws, agentId: listState.agentId || undefined })
    .then((data) => {
      if (my === reqSeq) setList({ data, error: '', loading: false })
    })
    .catch((e) => {
      if (my === reqSeq) setList({ error: errText(e), loading: false })
    })
}

let unsubChanged: (() => void) | null = null
let reloadTimer: ReturnType<typeof setTimeout> | undefined

function subscribe(l: () => void): () => void {
  listeners.add(l)
  if (!unsubChanged) {
    unsubChanged = window.bridge.onChanged((kind) => {
      if (kind !== 'checkpoints') return
      // 推送本身已节流；这里再合并一下，避免主区和侧栏同时刷新时连拉两次
      clearTimeout(reloadTimer)
      reloadTimer = setTimeout(reloadList, 150)
    })
  }
  return () => {
    listeners.delete(l)
    if (!listeners.size && unsubChanged) {
      unsubChanged()
      unsubChanged = null
    }
  }
}

/** 当前工作区的检查点列表；工作区换了自动重新拉 */
function useCheckpoints(workspaceId: string | undefined): ListState & { setAgent: (id: string) => void; reload: () => void } {
  const st = useSyncExternalStore(subscribe, () => listState)
  useEffect(() => {
    if (workspaceId && workspaceId !== listState.workspaceId) {
      setList({ workspaceId, data: null, error: '', agentId: '' })
      reloadList()
    } else if (workspaceId && !listState.data && !listState.loading) reloadList()
  }, [workspaceId])
  const setAgent = useCallback((agentId: string) => {
    setList({ agentId })
    reloadList()
  }, [])
  return { ...st, setAgent, reload: reloadList }
}

// ===== 选中：nav id 是 'step:<检查点 id>' 或 'session:<会话 id>' =====

export type ChangeSel = { kind: 'step'; id: string } | { kind: 'session'; id: string }

export function changeSelOf(id: string | undefined): ChangeSel | undefined {
  if (!id) return undefined
  if (id.startsWith('step:')) return { kind: 'step', id: id.slice(5) }
  if (id.startsWith('session:')) return { kind: 'session', id: id.slice(8) }
  return undefined
}

const selKey = (s: ChangeSel): string => `${s.kind}:${s.id}`

const CHANGE_MARK = { added: 'A', modified: 'M', deleted: 'D' } as const
const CHANGE_COLOR = { added: '#3fb950', modified: '#d29922', deleted: '#f85149' } as const

function colorOf(state: BridgeState, agentId: string, given?: string): string {
  return given ?? state.agents.find((a) => a.id === agentId)?.color ?? '#8b949e'
}

function Stat({ a, d }: { a: number; d: number }) {
  return (
    <span className="shrink-0 font-mono text-[11px]">
      <span className="text-ok">+{a}</span> <span className="text-bad">-{d}</span>
    </span>
  )
}

/** 会话 id 很长（s-20261106...-abc123），列表里只显示开始时间 */
function sessionTitle(s: CheckpointSessionView): string {
  if (s.session === 'user') return '你在工作台的回滚'
  const d = new Date(s.firstTs)
  const today = new Date().toDateString() === d.toDateString()
  return `${today ? '' : `${d.getMonth() + 1}/${d.getDate()} `}${clockTime(s.firstTs)} 起的会话`
}

// ===== 侧栏 =====

export function ChangesList({ state, selected, onSelect }: { state: BridgeState; selected?: string; onSelect: (id: string) => void }) {
  const ws = state.activeWorkspaceId
  const { data, error, agentId, setAgent, loading } = useCheckpoints(ws)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [trail, setTrail] = useState(false)
  if (!ws) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader title="改动" />
        <EmptyState icon={<GitCompare size={24} />} title="还没有工作区" hint="先在左上角添加一个工作区，AI 改它的文件时会自动存检查点" />
      </div>
    )
  }
  const toggle = (s: string) =>
    setCollapsed((c) => {
      const n = new Set(c)
      if (n.has(s)) n.delete(s)
      else n.add(s)
      return n
    })
  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="改动">
        {loading && <span className="text-[11px] text-faint">刷新中…</span>}
        <button
          type="button"
          data-trail-open
          title="留痕清单：按任务编号看谁改了哪些文件"
          onClick={() => setTrail(true)}
          className="inline-flex h-6 cursor-pointer items-center gap-1 rounded px-1.5 text-[11.5px] text-muted hover:bg-hover hover:text-fg"
        >
          <ListChecks size={12} />
          留痕
        </button>
      </PanelHeader>
      {trail && <TrailDialog workspaceId={ws} workspaceName={state.workspaces?.find((w) => w.id === ws)?.name ?? ws} onClose={() => setTrail(false)} />}
      <div className="px-2.5 pb-2">
        <select value={agentId} onChange={(e) => setAgent(e.target.value)} className="w-full rounded border border-line bg-canvas px-1.5 py-1 text-xs text-fg">
          <option value="">全部 AI</option>
          {(data?.agents ?? []).map((a) => (
            <option key={a.agentId} value={a.agentId}>
              {a.agentName}（{a.steps}）
            </option>
          ))}
        </select>
      </div>
      {error && <div className="px-3 pb-2 text-xs text-bad">{error}</div>}
      <div className="flex-1 overflow-auto pb-2">
        {data && data.sessions.length === 0 && (
          <EmptyState
            icon={<GitCompare size={24} />}
            title={agentId ? '这个 AI 没有检查点' : '还没有检查点'}
            hint="AI 用 write_file / edit_file / apply_patch / move / delete 改文件前，会自动把旧内容存成检查点"
          />
        )}
        {data?.sessions.map((s) => {
          const open = !collapsed.has(s.session)
          const sessSel = selected === `session:${s.session}`
          const files = new Set(s.steps.flatMap((x) => x.files.map((f) => f.path))).size
          return (
            <div key={s.session} className="mb-1">
              <div
                className={cx('mx-1.5 flex cursor-pointer items-center gap-1.5 rounded px-2 py-1.5 hover:bg-hover', sessSel && 'bg-accent/15')}
                onClick={() => onSelect(`session:${s.session}`)}
              >
                <button
                  className="w-3 shrink-0 cursor-pointer text-[10px] text-faint"
                  title={open ? '收起' : '展开'}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggle(s.session)
                  }}
                >
                  {open ? '▾' : '▸'}
                </button>
                <Avatar name={s.agentName} color={colorOf(state, s.agentId, s.agentColor)} size={16} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-fg">{s.agentName}</div>
                  <div className="truncate text-[11px] text-faint" title={s.session}>
                    {sessionTitle(s)} · {s.steps.length} 步 · {files} 个文件
                  </div>
                </div>
              </div>
              {open &&
                s.steps.map((st) => (
                  <StepRow key={st.id} step={st} selected={selected === `step:${st.id}`} onClick={() => onSelect(`step:${st.id}`)} />
                ))}
            </div>
          )
        })}
        {data?.truncated && <div className="px-3 py-2 text-[11px] text-faint">只显示最新的 {data.sessions.reduce((n, s) => n + s.steps.length, 0)} 个，共 {data.total} 个</div>}
      </div>
    </div>
  )
}

function StepRow({ step, selected, onClick }: { step: CheckpointStepView; selected: boolean; onClick: () => void }) {
  const first = step.files[0]?.path ?? step.skipped[0]?.path ?? ''
  return (
    <div onClick={onClick} className={cx('mr-1.5 ml-6 cursor-pointer rounded px-2 py-1 hover:bg-hover', selected && 'bg-accent/15', step.rolledBack === 'all' && 'opacity-55')}>
      <div className="flex items-center gap-1.5 text-[11px]">
        {step.kind === 'rollback' ? <Undo2 size={11} className="shrink-0 text-warn" /> : <FileDiff size={11} className="shrink-0 text-faint" />}
        <span className="truncate text-muted">{toolLabel(step.tool)}</span>
        <span className="shrink-0 text-faint">{step.id}</span>
        <span className="ml-auto shrink-0 text-faint">{timeAgo(step.ts)}</span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg" title={step.files.map((f) => f.path).join('\n')}>
          {first}
          {step.files.length > 1 && <span className="text-faint"> 等 {step.files.length} 个</span>}
        </span>
        {step.rolledBack !== 'none' && <span className="shrink-0 text-[10px] text-warn">{step.rolledBack === 'all' ? '已回滚' : '部分回滚'}</span>}
        <Stat a={step.additions} d={step.deletions} />
      </div>
    </div>
  )
}

// ===== 主区 =====

const CONFLICT_REASON: Record<string, string> = {
  modified_after: '检查点之后被改过',
  changed_between: '两次改动之间被别的途径改过',
  touched_by_other: '后来别人也改过',
  snapshot_missing: '快照丢失',
  not_a_file: '不是普通文件'
}
const ACTION_TEXT = { restore: '恢复旧内容', recreate: '建回来（之前被删了）', delete: '移进回收站（是新建的）' } as const

type RollbackReq = { stepIds?: string[]; session?: string; paths?: string[] }
interface Pending {
  title: string
  req: RollbackReq
  plan: CheckpointRollbackResult
}

export function ChangesMain({ state, selected }: { state: BridgeState; selected?: string }) {
  const ws = state.activeWorkspaceId
  const { data, reload } = useCheckpoints(ws)
  const sel = changeSelOf(selected)
  const step = sel?.kind === 'step' ? data?.sessions.flatMap((s) => s.steps).find((s) => s.id === sel.id) : undefined
  const session = data?.sessions.find((s) => s.session === (sel?.kind === 'session' ? sel.id : step?.session))
  const [summary, setSummary] = useState<CheckpointSummaryResult | null>(null)
  const [error, setError] = useState('')
  const [file, setFile] = useState<string>('')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState('')

  const key = sel ? selKey(sel) : ''
  // 选中变了：清掉文件选择；列表刷新（有新检查点）时重新算净改动
  useEffect(() => {
    setChecked(new Set())
    setFile('')
    setDone('')
  }, [key])
  useEffect(() => {
    if (!ws || !sel) {
      setSummary(null)
      return
    }
    let live = true
    window.bridge
      .checkpointSummary(sel.kind === 'step' ? { workspaceId: ws, stepIds: [sel.id] } : { workspaceId: ws, session: sel.id })
      .then((s) => {
        if (!live) return
        setSummary(s)
        setError('')
      })
      .catch((e) => live && setError(errText(e)))
    return () => {
      live = false
    }
    // data：列表刷新说明有新检查点或回滚了，净改动要重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, key, data])

  const scope: RollbackReq | undefined = sel ? (sel.kind === 'step' ? { stepIds: [sel.id] } : { session: sel.id }) : undefined
  const files = summary?.files ?? []
  const shown = files.find((f) => f.path === file) ?? files[0]

  const preview = async (title: string, req: RollbackReq) => {
    if (!ws) return
    setBusy(true)
    setError('')
    try {
      const plan = await window.bridge.rollbackCheckpoints({ workspaceId: ws, ...req, dryRun: true })
      setPending({ title, req, plan })
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const confirm = async () => {
    if (!ws || !pending) return
    setBusy(true)
    try {
      const r = await window.bridge.rollbackCheckpoints({ workspaceId: ws, ...pending.req })
      if (r.status === 'done') {
        setPending(null)
        setChecked(new Set())
        setDone(`已回滚 ${r.files.length} 个文件${r.checkpoint ? `，这次回滚存成了检查点 ${r.checkpoint}（可以再退回去）` : ''}`)
        reload()
      } else setPending({ ...pending, plan: r })
    } catch (e) {
      setError(errText(e))
      setPending(null)
    } finally {
      setBusy(false)
    }
  }

  if (!ws) return <EmptyState icon={<GitCompare size={28} />} title="还没有工作区" hint="改动页按工作区看检查点，先添加一个工作区" />
  if (!sel || (!step && !session)) {
    return (
      <EmptyState
        icon={<GitCompare size={28} />}
        title={data?.sessions.length ? '在左边选一个检查点或会话' : '还没有检查点'}
        hint="选中后可以看净改动、逐个文件看 diff，并回滚这一步、整个会话或只回滚选中的文件。回滚前会先预演，有冲突时不会写任何文件"
      />
    )
  }
  const owner = step ?? session!
  const color = colorOf(state, owner.agentId, owner.agentColor)
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <Avatar name={owner.agentName} color={color} size={22} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-fg">
            {step ? `${toolLabel(step.tool)} · ${step.id}` : sessionTitle(session!)}
            {step?.kind === 'rollback' && <Badge className="ml-2">回滚</Badge>}
            {step && step.rolledBack !== 'none' && <Badge color="#d29922" className="ml-2">{step.rolledBack === 'all' ? '已回滚' : '部分回滚'}</Badge>}
          </div>
          <div className="truncate text-[11px] text-faint">
            {owner.agentName} · {step ? new Date(step.ts).toLocaleString('zh-CN', { hour12: false }) : `${session!.steps.length} 步，最后 ${timeAgo(session!.lastTs)}`}
            {(step?.task ?? session?.tasks[0]) && ` · 任务 ${step?.task ?? session?.tasks.join('、')}`}
          </div>
        </div>
        {step && (
          <Button size="sm" disabled={busy} onClick={() => void preview(`回滚 ${step.id}`, { stepIds: [step.id] })}>
            <RotateCcw size={12} />
            回滚这一步
          </Button>
        )}
        {session && (
          <Button size="sm" disabled={busy} onClick={() => void preview('回滚整个会话', { session: session.session })}>
            <Undo2 size={12} />
            回滚整个会话
          </Button>
        )}
        <Button size="sm" disabled={busy || checked.size === 0 || !scope} onClick={() => scope && void preview(`只回滚选中的 ${checked.size} 个文件`, { ...scope, paths: [...checked] })}>
          只回滚选中的文件{checked.size ? `（${checked.size}）` : ''}
        </Button>
      </div>
      {error && <div className="border-b border-line bg-bad/10 px-4 py-2 text-xs text-bad">{error}</div>}
      {done && <div className="border-b border-line bg-ok/10 px-4 py-2 text-xs text-ok">{done}</div>}
      <div className="flex min-h-0 flex-1">
        <div className="w-72 shrink-0 overflow-auto border-r border-line py-2">
          {summary && (
            <div className="px-3 pb-2 text-[11px] text-faint">
              净改动 {summary.totals.files} 个文件 <Stat a={summary.totals.additions} d={summary.totals.deletions} />
              {summary.totals.unchanged_after_edits > 0 && <div>另有 {summary.totals.unchanged_after_edits} 个文件改完又改回原样</div>}
            </div>
          )}
          {summary && files.length === 0 && (
            <div className="px-3 text-xs text-muted">
              {step?.kind === 'rollback' ? '这一步是一次回滚。回滚它等于把那次回滚撤销（重做原来的改动）。' : '没有净改动：可能已经回滚过，或改完又改回了原样。'}
              {step && step.files.length > 0 && (
                <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-faint">
                  {step.files.map((f) => (
                    <li key={f.path}>
                      {CHANGE_MARK[f.change]} {f.path}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {files.map((f) => (
            <FileRow
              key={f.path}
              f={f}
              active={shown?.path === f.path}
              checked={checked.has(f.path)}
              onOpen={() => setFile(f.path)}
              onCheck={(v) =>
                setChecked((c) => {
                  const n = new Set(c)
                  if (v) n.add(f.path)
                  else n.delete(f.path)
                  return n
                })
              }
            />
          ))}
          {step && step.skipped.length > 0 && (
            <div className="mt-2 px-3 text-[11px] text-warn">
              {step.skipped.length} 个文件没存快照，回滚恢复不了：
              {step.skipped.slice(0, 5).map((s) => (
                <div key={s.path} className="truncate font-mono" title={s.reason}>
                  {s.path}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1 overflow-auto p-4">
          {shown ? (
            <>
              <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-[13px] text-fg">{shown.path}</span>
                <Stat a={shown.additions} d={shown.deletions} />
                {shown.changed_outside && <Badge color="#d29922">检查点之后被别的途径改过</Badge>}
              </div>
              {shown.binary ? (
                <div className="text-xs text-muted">二进制文件，不显示 diff</div>
              ) : shown.too_large ? (
                <div className="text-xs text-muted">文件太大或快照丢失，不显示 diff</div>
              ) : shown.diff ? (
                <DiffView diff={shown.diff} maxHeight={100000} />
              ) : (
                <div className="text-xs text-muted">没有 diff</div>
              )}
              {shown.diff_truncated && <div className="mt-1 text-[11px] text-faint">diff 太长，已截断</div>}
            </>
          ) : (
            !summary && !error && <div className="text-xs text-faint">加载中…</div>
          )}
        </div>
      </div>
      {pending && <RollbackDialog pending={pending} busy={busy} onCancel={() => setPending(null)} onConfirm={() => void confirm()} />}
    </div>
  )
}

function FileRow({ f, active, checked, onOpen, onCheck }: { f: CheckpointSummaryFile; active: boolean; checked: boolean; onOpen: () => void; onCheck: (v: boolean) => void }) {
  const name = f.path.split('/').pop() ?? f.path
  const dir = f.path.slice(0, f.path.length - name.length).replace(/\/$/, '')
  return (
    <div onClick={onOpen} className={cx('mx-1.5 flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 hover:bg-hover', active && 'bg-accent/15')}>
      <input
        type="checkbox"
        checked={checked}
        title="选中后可以只回滚这些文件"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onCheck(e.target.checked)}
        className="shrink-0 cursor-pointer"
      />
      <span className="w-3 shrink-0 text-center font-mono text-[11px] font-semibold" style={{ color: CHANGE_COLOR[f.status] }}>
        {CHANGE_MARK[f.status]}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px]" title={f.path}>
        <span className="text-fg">{name}</span>
        {dir && <span className="ml-1 text-faint">{dir}</span>}
      </span>
      {f.changed_outside && <TriangleAlert size={11} className="shrink-0 text-warn" />}
      {!f.binary && !f.too_large && <Stat a={f.additions} d={f.deletions} />}
    </div>
  )
}

function RollbackDialog({ pending, busy, onCancel, onConfirm }: { pending: Pending; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const p = pending.plan
  const groups = useMemo(() => {
    if (p.status !== 'dry_run') return []
    return (['restore', 'recreate', 'delete'] as const).map((a) => ({ action: a, files: p.files.filter((f) => f.action === a).map((f) => f.path) })).filter((g) => g.files.length)
  }, [p])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onMouseDown={onCancel}>
      <div className="flex max-h-[80vh] w-[560px] flex-col rounded-lg border border-line bg-panel shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="border-b border-line px-4 py-3 text-[14px] font-medium text-fg">{pending.title}</div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-[13px]">
          {p.status === 'dry_run' && (
            <>
              <div className="mb-2 text-muted">会改动下面 {p.files.length} 个文件（涉及 {p.checkpoints.join('、')}）。回滚本身也会存成检查点，之后可以再退回去。</div>
              {groups.map((g) => (
                <div key={g.action} className="mb-2">
                  <div className={cx('text-xs font-medium', g.action === 'delete' ? 'text-bad' : 'text-fg')}>
                    {ACTION_TEXT[g.action]}（{g.files.length}）
                  </div>
                  <ul className="mt-0.5 space-y-0.5 font-mono text-[12px] text-muted">
                    {g.files.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </div>
              ))}
              {p.skipped.length > 0 && <div className="text-xs text-warn">{p.skipped.length} 个文件没存快照，恢复不了：{p.skipped.map((s) => s.path).join('、')}</div>}
            </>
          )}
          {p.status === 'conflict' && (
            <>
              <div className="mb-2 flex items-center gap-1.5 text-bad">
                <TriangleAlert size={14} />
                {p.message}
              </div>
              <ul className="space-y-1.5">
                {p.conflicts.map((c) => (
                  <li key={c.path + c.reason} className="rounded border border-line bg-canvas px-2 py-1.5">
                    <div className="font-mono text-[12px] text-fg">{c.path}</div>
                    <div className="text-xs text-muted">
                      {CONFLICT_REASON[c.reason] ?? c.reason}：{c.detail}
                    </div>
                  </li>
                ))}
              </ul>
              {p.restorable.length > 0 && (
                <div className="mt-2 text-xs text-muted">没冲突、可以单独回滚的文件：在文件列表里勾选它们，再点「只回滚选中的文件」。{p.restorable.join('、')}</div>
              )}
            </>
          )}
          {p.status === 'nothing' && <div className="text-muted">{p.message}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <Button onClick={onCancel}>{p.status === 'dry_run' ? '取消' : '关闭'}</Button>
          <Button variant="danger" disabled={busy || p.status !== 'dry_run'} onClick={onConfirm}>
            {busy ? '回滚中…' : '确认回滚'}
          </Button>
        </div>
      </div>
    </div>
  )
}
