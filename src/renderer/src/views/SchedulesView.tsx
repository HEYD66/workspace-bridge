// 定时任务：每 N 分钟 / 每天几点（可选周几）/ 一次，到点往群聊发消息、派任务，或者给内置 AI 发消息。
// 每个工作区有自己的列表（任务记着所属工作区）；到点了不管当前开着哪个工作区都会跑
import { CalendarClock, Play, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { BridgeState, ScheduleAction, ScheduleItem, ScheduleSpec } from '../../../shared/api'
import { Badge, Button, ConfirmButton, EmptyState, Field, Input, PanelHeader, Segmented, TextArea, cx } from '../components/ui'
import { errText, timeAgo } from '../lib/format'

// ===== 数据：侧栏和主区共用一份，收到 'schedules' 变化时重新拉 =====

let items: ScheduleItem[] = []
let loadError = ''
let loaded = false
const listeners = new Set<() => void>()
let snapshot = { items, loadError, loaded }
let unsub: (() => void) | null = null

function emit(): void {
  snapshot = { items, loadError, loaded }
  for (const l of listeners) l()
}

function reload(): void {
  window.bridge
    .listSchedules()
    .then((r) => {
      items = r
      loadError = ''
      loaded = true
      emit()
    })
    .catch((e) => {
      loadError = errText(e)
      loaded = true
      emit()
    })
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  if (!unsub) {
    unsub = window.bridge.onChanged((kind) => {
      if (kind === 'schedules') reload()
    })
    reload()
  }
  return () => {
    listeners.delete(l)
    if (!listeners.size && unsub) {
      unsub()
      unsub = null
    }
  }
}

export function useSchedules(): { items: ScheduleItem[]; loadError: string; loaded: boolean; reload: () => void } {
  const s = useSyncExternalStore(subscribe, () => snapshot)
  return { ...s, reload }
}

// ===== 按工作区分列表 =====

type Owned = Pick<ScheduleItem, 'workspaceId'>
type WorkspaceScope = { activeWorkspaceId?: string; workspaces: { id: string; kind?: string }[] }

/** 找不到所属工作区：分工作区之前建的、工作区已被移出列表的，或者归在整台电脑上的（工作台切不到整台电脑，等于没有列表能显示它） */
export function isStray(s: Owned, scope: WorkspaceScope): boolean {
  const ws = s.workspaceId ? scope.workspaces.find((w) => w.id === s.workspaceId) : undefined
  return !ws || ws.kind === 'machine'
}

/** 当前工作区的列表：属于它的，加上找不到所属工作区的。后一种每个工作区都显示，免得有任务没人看得见却一直在跑 */
export function schedulesInWorkspace<T extends Owned>(list: T[], scope: WorkspaceScope): T[] {
  return list.filter((s) => isStray(s, scope) || s.workspaceId === scope.activeWorkspaceId)
}

/** 保存时要不要改所属工作区：新建的和找不到所属工作区的归当前工作区；已有归属的不动；当前不是目录工作区（没有，或是整台电脑）时不归 */
export function ownerForSave(item: Owned | undefined, scope: WorkspaceScope): string | undefined {
  if (item && !isStray(item, scope)) return undefined
  const active = scope.workspaces.find((w) => w.id === scope.activeWorkspaceId)
  return active && active.kind !== 'machine' ? active.id : undefined
}

// ===== 显示 =====

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

export function describeSpec(spec: ScheduleSpec): string {
  if (spec.kind === 'every') return spec.minutes % 60 === 0 ? `每 ${spec.minutes / 60} 小时` : `每 ${spec.minutes} 分钟`
  if (spec.kind === 'once') return `${new Date(spec.at).toLocaleString('zh-CN', { hour12: false })} 一次`
  const days = spec.weekdays?.length ? `每周${[...spec.weekdays].sort().map((d) => WEEK[d]).join('、')}` : '每天'
  return `${days} ${spec.time}`
}

function describeAction(a: ScheduleAction, state: BridgeState): string {
  const agent = (id: string | undefined) => (id ? (state.agents.find((x) => x.id === id)?.name ?? '已吊销的 AI') : '')
  if (a.kind === 'chat') {
    const ch = state.chat?.channels.find((c) => c.id === a.channel)?.name ?? a.channel
    return `群聊·${ch}${a.mention?.length ? ` @${a.mention.map(agent).join(' @')}` : ''}`
  }
  if (a.kind === 'task') {
    const ws = state.workspaces.find((w) => w.id === a.workspaceId)?.name ?? '已移出的工作区'
    return `任务板·${ws}${a.assigneeId ? ` → ${agent(a.assigneeId)}` : ''}`
  }
  return `内置 AI·${agent(a.agentId)}`
}

function when(ts: number | null): string {
  if (ts === null) return '不会再运行'
  const d = new Date(ts)
  const today = new Date().toDateString() === d.toDateString()
  const t = d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
  return today ? `今天 ${t}` : `${d.getMonth() + 1}/${d.getDate()} ${t}`
}

const RESULT_COLOR = { ok: '#3fb950', error: '#f85149', skipped: '#d29922' } as const
const RESULT_TEXT = { ok: '成功', error: '失败', skipped: '跳过' } as const

function ResultBadge({ r }: { r: ScheduleItem['lastResult'] }) {
  if (!r) return <span className="text-[11px] text-faint">还没运行过</span>
  return (
    <span className="text-[11px]" style={{ color: RESULT_COLOR[r.status] }} title={r.message}>
      {RESULT_TEXT[r.status]}
      {r.catchup ? '（补跑）' : r.manual ? '（立即运行）' : ''} · {timeAgo(r.at)}
    </span>
  )
}

/** 开关：点了直接保存 enabled */
function Toggle({ item }: { item: ScheduleItem }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      role="switch"
      aria-checked={item.enabled}
      title={item.enabled ? '已启用，点击停用' : '已停用，点击启用'}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation()
        setBusy(true)
        window.bridge
          .saveSchedule({ id: item.id, name: item.name, schedule: item.schedule, action: item.action, enabled: !item.enabled })
          .catch((err) => alert(errText(err)))
          .finally(() => setBusy(false))
      }}
      className={cx('relative h-4 w-7 shrink-0 cursor-pointer rounded-full transition-colors', item.enabled ? 'bg-ok/70' : 'bg-hover')}
    >
      <span className={cx('absolute top-0.5 h-3 w-3 rounded-full bg-fg transition-all', item.enabled ? 'left-3.5' : 'left-0.5')} />
    </button>
  )
}

// ===== 侧栏 =====

export function ScheduleList({ state, selected, onSelect }: { state: BridgeState; selected?: string; onSelect: (id: string) => void }) {
  const { items: all, loadError, loaded } = useSchedules()
  const list = schedulesInWorkspace(all, state)
  const elsewhere = all.length - list.length
  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="定时任务">
        <Button size="sm" variant="ghost" onClick={() => onSelect('new')} title="新建定时任务">
          <Plus size={13} /> 新建
        </Button>
      </PanelHeader>
      {state.workspaceName && (
        <div className="truncate px-3 pb-1.5 text-[11px] text-faint" title="每个工作区有自己的定时任务；切换工作区看别的。到点了不管开着哪个工作区都会运行">
          「{state.workspaceName}」的定时任务{elsewhere > 0 ? `，其他工作区还有 ${elsewhere} 个` : ''}
        </div>
      )}
      {state.paused && <div className="mx-2.5 mb-2 rounded bg-warn/15 px-2 py-1 text-[11px] text-warn">已「全部停下」：到点的任务不会跑，记成跳过</div>}
      {loadError && <div className="px-3 pb-2 text-xs text-bad">{loadError}</div>}
      <div className="flex-1 overflow-auto pb-2">
        {loaded && list.length === 0 && (
          <EmptyState
            icon={<CalendarClock size={24} />}
            title="还没有定时任务"
            hint="比如「每天 9 点在群里 @Maya 汇报进度」「每 30 分钟派一个检查构建的任务」"
            action={
              <Button size="sm" onClick={() => onSelect('new')}>
                <Plus size={13} /> 新建定时任务
              </Button>
            }
          />
        )}
        {list.map((s) => (
          <div
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={cx('mx-1.5 cursor-pointer rounded px-2 py-1.5 hover:bg-hover', selected === s.id && 'bg-accent/15', !s.enabled && 'opacity-60')}
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{s.name}</span>
              <Toggle item={s} />
            </div>
            <div className="mt-0.5 truncate text-[11px] text-muted">
              {describeSpec(s.schedule)} · {describeAction(s.action, state)}
            </div>
            {isStray(s, state) && <div className="mt-0.5 truncate text-[11px] text-warn">不属于任何工作区，所以每个工作区都显示</div>}
            <div className="mt-0.5 flex items-center gap-2 text-[11px]">
              <span className="text-faint">下次 {s.enabled ? when(s.nextRunAt) : '（已停用）'}</span>
              <span className="ml-auto">
                <ResultBadge r={s.lastResult} />
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ===== 编辑器 =====

/** datetime-local 的值（本机时间，到分钟） */
function toLocalInput(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

const selectCls = 'h-8 w-full rounded-md border border-line bg-canvas px-2 text-[13px] text-fg'

export function ScheduleMain({ state, id, onSelect }: { state: BridgeState; id?: string; onSelect: (id: string | undefined) => void }) {
  const { items: all, loaded } = useSchedules()
  // 只在当前工作区的列表里找：切到别的工作区后，原来选中的那个不该还开着
  const list = schedulesInWorkspace(all, state)
  if (!id) {
    return (
      <EmptyState
        icon={<CalendarClock size={28} />}
        title={list.length ? '在左边选一个定时任务，或者新建一个' : '这个工作区还没有定时任务'}
        hint="到点往群聊发消息（可以 @ AI，它会收到通知，内置 AI 会自动接活）、在任务板上派任务，或者直接给内置 AI 发一条消息。每个工作区有自己的定时任务，到点了不管开着哪个工作区都会运行。时间按这台电脑的时区算；电脑睡眠、工作台关着时错过的，下次打开只补跑最近一次"
        action={
          <Button onClick={() => onSelect('new')}>
            <Plus size={14} /> 新建定时任务
          </Button>
        }
      />
    )
  }
  const item = id === 'new' ? undefined : list.find((x) => x.id === id)
  if (id !== 'new' && !item) {
    if (!loaded) return null
    const other = all.find((x) => x.id === id)
    const where = other && state.workspaces.find((w) => w.id === other.workspaceId)?.name
    return <EmptyState icon={<CalendarClock size={28} />} title={other ? `这个定时任务在工作区「${where ?? '别的工作区'}」里` : '这个定时任务不存在了'} hint={other ? '切到那个工作区再看' : undefined} />
  }
  // 换了选中的任务、或者切了工作区就重新挂载，表单从头开始（新建时默认的频道和工作区跟着当前工作区）
  return <ScheduleEditor key={`${id}:${state.activeWorkspaceId ?? ''}`} state={state} item={item} onSaved={(s) => onSelect(s.id)} onDeleted={() => onSelect(undefined)} />
}

function ScheduleEditor({ state, item, onSaved, onDeleted }: { state: BridgeState; item?: ScheduleItem; onSaved: (s: ScheduleItem) => void; onDeleted: () => void }) {
  const agents = state.agents
  const workspaces = state.workspaces
  // 新建的归当前工作区；找不到所属工作区的旧任务，保存时也归到当前工作区
  const stray = !!item && isStray(item, state)
  const owner = ownerForSave(item, state)
  // 归档的会话发不进去，不让选；这个任务正在用的那个留着，看得出它指向哪
  const usedChannel = item?.action.kind === 'chat' ? item.action.channel : undefined
  const channels = (state.chat?.channels ?? [{ id: 'general', name: '大厅', unread: 0, mentions: 0, lastTs: 0 }]).filter((c) => !c.thread?.archived || c.id === usedChannel)
  const sp = item?.schedule
  const ac = item?.action

  // 任务里存的频道、工作区、AI 可能已经不在了（工作区被移出、AI 被吊销）。下拉框对不在选项里的值会显示成第一项，
  // 看着没问题、一保存却报错。所以打开时就换成有效的默认值，并告诉用户换了哪些
  const [init] = useState(() => {
    const lost: string[] = []
    const hasAgent = (aid: string) => agents.some((a) => a.id === aid)
    const defaultChannel = state.activeWorkspaceId && channels.some((c) => c.id === `ws:${state.activeWorkspaceId}`) ? `ws:${state.activeWorkspaceId}` : 'general'
    let channel = defaultChannel
    let mention: string[] = []
    if (ac?.kind === 'chat') {
      if (channels.some((c) => c.id === ac.channel)) channel = ac.channel
      else lost.push('频道')
      mention = (ac.mention ?? []).filter(hasAgent)
      if (mention.length !== (ac.mention ?? []).length) lost.push('@ 的 AI')
    }
    let wsId = state.activeWorkspaceId ?? workspaces[0]?.id ?? ''
    let assignee = ''
    if (ac?.kind === 'task') {
      if (workspaces.some((w) => w.id === ac.workspaceId)) wsId = ac.workspaceId
      else lost.push('工作区')
      if (ac.assigneeId && hasAgent(ac.assigneeId)) assignee = ac.assigneeId
      else if (ac.assigneeId) lost.push('执行的 AI')
    }
    let builtinAgent = ''
    if (ac?.kind === 'builtin') {
      if (hasAgent(ac.agentId)) builtinAgent = ac.agentId
      else lost.push('内置 AI')
    }
    return { channel, mention, wsId, assignee, builtinAgent, lost }
  })

  const [name, setName] = useState(item?.name ?? '')
  const [enabled, setEnabled] = useState(item?.enabled ?? true)
  // 编辑页开着时在侧栏点了开关：跟着变，不然这里一保存又把它改回去
  const savedEnabled = item?.enabled
  useEffect(() => {
    if (savedEnabled !== undefined) setEnabled(savedEnabled)
  }, [savedEnabled])
  const [kind, setKind] = useState<ScheduleSpec['kind']>(sp?.kind ?? 'daily')
  const [minutes, setMinutes] = useState(String(sp?.kind === 'every' ? sp.minutes : 30))
  const [time, setTime] = useState(sp?.kind === 'daily' ? sp.time : '09:00')
  const [weekdays, setWeekdays] = useState<number[]>(sp?.kind === 'daily' ? (sp.weekdays ?? []) : [])
  const [onceAt, setOnceAt] = useState(sp?.kind === 'once' ? toLocalInput(Date.parse(sp.at)) : toLocalInput(Date.now() + 3600_000))

  const [akind, setAkind] = useState<ScheduleAction['kind']>(ac?.kind ?? 'chat')
  const [channel, setChannel] = useState(init.channel)
  const [text, setText] = useState(ac?.kind === 'chat' ? ac.text : '')
  const [mention, setMention] = useState<string[]>(init.mention)
  const [wsId, setWsId] = useState(init.wsId)
  const [title, setTitle] = useState(ac?.kind === 'task' ? ac.title : '')
  const [desc, setDesc] = useState(ac?.kind === 'task' ? ac.description : '')
  const [assignee, setAssignee] = useState(init.assignee)
  const [builtinAgent, setBuiltinAgent] = useState(init.builtinAgent)
  const [prompt, setPrompt] = useState(ac?.kind === 'builtin' ? ac.prompt : '')

  const [bound, setBound] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  useEffect(() => {
    window.bridge
      .listAgentModels()
      .then((m) => setBound(new Set(Object.keys(m))))
      .catch(() => {})
  }, [])

  const build = useCallback(() => {
    const schedule: ScheduleSpec =
      kind === 'every'
        ? { kind, minutes: Number(minutes) }
        : kind === 'daily'
          ? { kind, time, ...(weekdays.length ? { weekdays } : {}) }
          : { kind, at: new Date(onceAt).toISOString() }
    const action: ScheduleAction =
      akind === 'chat'
        ? { kind: 'chat', channel, text, ...(mention.length ? { mention } : {}) }
        : akind === 'task'
          ? { kind: 'task', workspaceId: wsId, title, description: desc, ...(assignee ? { assigneeId: assignee } : {}) }
          : { kind: 'builtin', agentId: builtinAgent, prompt }
    return { ...(item ? { id: item.id } : {}), ...(owner ? { workspaceId: owner } : {}), name, enabled, schedule, action }
  }, [kind, minutes, time, weekdays, onceAt, akind, channel, text, mention, wsId, title, desc, assignee, builtinAgent, prompt, item, owner, name, enabled])

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key)
    setError('')
    setNote('')
    try {
      await fn()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy('')
    }
  }
  const save = () =>
    act('save', async () => {
      if (kind === 'once' && !Number.isFinite(Date.parse(onceAt))) throw new Error('请填写运行时间')
      const s = await window.bridge.saveSchedule(build())
      setNote('已保存')
      onSaved(s)
    })
  const runNow = () =>
    act('run', async () => {
      if (!item) return
      const r = await window.bridge.runScheduleNow(item.id)
      const res = r.lastResult
      if (res?.status === 'error') setError(`运行失败：${res.message}`)
      else setNote(`已运行：${res?.message ?? ''}`)
    })
  const remove = () =>
    act('delete', async () => {
      if (!item) return
      await window.bridge.deleteSchedule(item.id)
      onDeleted()
    })

  const toggleDay = (d: number) => setWeekdays((w) => (w.includes(d) ? w.filter((x) => x !== d) : [...w, d].sort()))
  const toggleMention = (aid: string) => setMention((m) => (m.includes(aid) ? m.filter((x) => x !== aid) : [...m, aid]))

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <div className="flex items-center gap-2">
        <CalendarClock size={18} className="text-accent" />
        <h2 className="text-base font-semibold">{item ? '编辑定时任务' : '新建定时任务'}</h2>
        {item && (
          <span className="ml-auto flex items-center gap-2">
            <ResultBadge r={item.lastResult} />
          </span>
        )}
      </div>
      {item && (
        <div className="rounded-md border border-line bg-panel px-3 py-2 text-xs text-muted">
          下次运行：{item.enabled ? when(item.nextRunAt) : '已停用'}
          {item.lastResult && <div className="mt-0.5 break-all">上次结果：{item.lastResult.message}</div>}
        </div>
      )}
      {stray && (
        <div className="rounded-md bg-warn/15 px-3 py-2 text-xs text-warn">
          这个任务不属于任何工作区（原来的工作区被移出了，或者它是分工作区之前建的），所以每个工作区都显示它。
          {owner && state.workspaceName ? `点「保存」后它归到当前工作区「${state.workspaceName}」。` : ''}
        </div>
      )}
      {init.lost.length > 0 && (
        <div className="rounded-md bg-warn/15 px-3 py-2 text-xs text-warn">
          这个任务原来选的{init.lost.join('、')}已经不在了（工作区被移出，或 AI 被吊销），下面已经换成默认值。请检查一遍再保存。
        </div>
      )}

      <Field label="名字">
        <Input value={name} maxLength={60} placeholder="例如：每天早上汇报进度" onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field label="频率" hint="按这台电脑的时区算。电脑睡眠或工作台关着时错过的，只补跑最近一次；「全部停下」时到点的不跑">
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: 'every', label: '每 N 分钟' },
            { value: 'daily', label: '每天几点' },
            { value: 'once', label: '一次' }
          ]}
        />
        {kind === 'every' && (
          <div className="flex items-center gap-2 text-[13px]">
            每 <Input type="number" min={1} max={10080} value={minutes} onChange={(e) => setMinutes(e.target.value)} className="w-24" /> 分钟
          </div>
        )}
        {kind === 'daily' && (
          <div className="space-y-2">
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-32" />
            <div className="flex flex-wrap items-center gap-1">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <button
                  key={d}
                  onClick={() => toggleDay(d)}
                  className={cx('h-7 w-8 cursor-pointer rounded border text-xs', weekdays.includes(d) ? 'border-accent bg-accent/20 text-fg' : 'border-line text-muted hover:text-fg')}
                >
                  {WEEK[d]}
                </button>
              ))}
              <span className="ml-2 text-[11px] text-faint">{weekdays.length ? '' : '不选 = 每天'}</span>
            </div>
          </div>
        )}
        {kind === 'once' && <Input type="datetime-local" value={onceAt} onChange={(e) => setOnceAt(e.target.value)} className="w-56" />}
      </Field>

      <Field label="到点做什么">
        <Segmented
          value={akind}
          onChange={setAkind}
          options={[
            { value: 'chat', label: '在群聊发消息' },
            { value: 'task', label: '派一个任务' },
            { value: 'builtin', label: '给内置 AI 发消息' }
          ]}
        />
      </Field>

      {akind === 'chat' && (
        <>
          <Field label="频道">
            <select className={selectCls} value={channel} onChange={(e) => setChannel(e.target.value)}>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="@ 哪些 AI" hint="被 @ 的 AI 下次调用工具时会看到这条消息；内置 AI 会自动开始处理">
            <div className="flex flex-wrap gap-1.5">
              {agents.length === 0 && <span className="text-xs text-faint">还没有 AI</span>}
              {agents.map((a) => (
                <button
                  key={a.id}
                  onClick={() => toggleMention(a.id)}
                  className={cx('h-7 cursor-pointer rounded-full border px-2.5 text-xs', mention.includes(a.id) ? 'border-accent bg-accent/20 text-fg' : 'border-line text-muted hover:text-fg')}
                >
                  @{a.name}
                </button>
              ))}
            </div>
          </Field>
          <Field label="消息">
            <TextArea rows={4} value={text} maxLength={4000} placeholder="例如：请汇报一下昨天的进度和今天的计划" onChange={(e) => setText(e.target.value)} />
          </Field>
        </>
      )}

      {akind === 'task' && (
        <>
          <Field label="派到哪个工作区的任务板" hint={workspaces.find((w) => w.id === wsId)?.kind === 'machine' ? '「整台电脑」的任务板：只有在团队页勾了「整台电脑」的 AI 才看得到。你自己到任务页，在左侧上方点「整台电脑」就能看到这些任务' : undefined}>
            <select className={selectCls} value={wsId} onChange={(e) => setWsId(e.target.value)}>
              {workspaces.length === 0 && <option value="">（先添加工作区）</option>}
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {w.exists ? '' : '（目录不存在）'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="派给">
            <select className={selectCls} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">不指定（谁都能认领）</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="任务标题">
            <Input value={title} maxLength={200} placeholder="例如：检查一次构建" onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="任务说明">
            <TextArea rows={4} value={desc} maxLength={8000} placeholder="例如：跑 npm run build，有错就修，修完把任务提交审查" onChange={(e) => setDesc(e.target.value)} />
          </Field>
        </>
      )}

      {akind === 'builtin' && (
        <>
          <Field label="内置 AI" hint="要先在对话页或团队页给它绑定模型；它正在回复时这次会失败">
            <select className={selectCls} value={builtinAgent} onChange={(e) => setBuiltinAgent(e.target.value)}>
              <option value="">选择 AI</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {bound.has(a.id) ? '' : '（没绑模型）'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="要发的消息">
            <TextArea rows={5} value={prompt} maxLength={20000} placeholder="例如：看看任务板上有没有分给你的新任务，有就开始做" onChange={(e) => setPrompt(e.target.value)} />
          </Field>
        </>
      )}

      <label className="flex cursor-pointer items-center gap-2 text-[13px]">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> 启用
      </label>

      {error && <div className="text-xs text-bad">{error}</div>}
      {note && <div className="text-xs text-ok">{note}</div>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={!!busy} onClick={() => void save()}>
          {busy === 'save' ? '保存中…' : '保存'}
        </Button>
        {item && (
          <Button disabled={!!busy || state.paused} title={state.paused ? '已「全部停下」，先恢复' : '马上运行一次，不影响下次计划时间'} onClick={() => void runNow()}>
            <Play size={13} />
            {busy === 'run' ? '运行中…' : '立即运行'}
          </Button>
        )}
        {item && (
          <span className="ml-auto">
            <ConfirmButton confirmText="确认删除？" onConfirm={() => void remove()}>
              <Trash2 size={12} /> 删除
            </ConfirmButton>
          </span>
        )}
      </div>
      {item && <Badge className="mt-1">id {item.id}</Badge>}
    </div>
  )
}
