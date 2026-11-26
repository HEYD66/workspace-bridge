// 工具试用台：选一个 AI 身份，手动调它能用的 MCP 工具，看原样返回。
// 调用走主进程里真实的 MCP 客户端（core/playground.ts），鉴权、审计都和外部 AI 一样
import { FlaskConical, History, Loader2, Play, RefreshCw, Search } from 'lucide-react'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Agent, BridgeState, PlaygroundCallResult, PlaygroundTool } from '../../../shared/api'
import { Badge, Button, CopyButton, cx, EmptyState, IconButton, PanelHeader, Segmented } from '../components/ui'
import { clockTime, errText } from '../lib/format'
import { navigate } from '../lib/nav'
import { argsToValues, defaultValues, prettyText, schemaToFields, valuesToArgs, type FormField, type FormValues } from '../lib/schemaForm'

// ========== 共享状态：选中的 AI 和它的工具列表（侧栏和主区共用） ==========

const AGENT_KEY = 'wb.playground.agent'

interface Store {
  agentId?: string
  tools?: PlaygroundTool[]
  loading: boolean
  error?: string
}

let store: Store = { agentId: readAgent(), loading: false }
const listeners = new Set<() => void>()
let seq = 0

function readAgent(): string | undefined {
  try {
    return localStorage.getItem(AGENT_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function set(patch: Partial<Store>): void {
  store = { ...store, ...patch }
  for (const l of listeners) l()
}

function useStore(): Store {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => store,
    () => store
  )
}

/** 侧栏和主区都会触发加载：同一个 key 正在拉就不再发 */
let inflightKey: string | undefined

async function loadTools(agentId: string, key?: string): Promise<void> {
  if (key && key === inflightKey) return
  inflightKey = key
  const n = ++seq
  set({ loading: true, error: undefined })
  try {
    const tools = await window.bridge.playgroundTools(agentId)
    if (n === seq) set({ tools: [...tools].sort((a, b) => a.name.localeCompare(b.name)), loading: false })
  } catch (e) {
    if (n === seq) set({ tools: undefined, loading: false, error: errText(e) })
  }
}

function selectAgent(agentId: string): void {
  if (agentId === store.agentId) return
  try {
    localStorage.setItem(AGENT_KEY, agentId)
  } catch {
    // 忽略
  }
  set({ agentId, tools: undefined })
  navigate({ section: 'playground', id: undefined })
}

/** 选中的 AI 还在就用它，否则第一个 */
function currentAgent(state: BridgeState, s: Store): Agent | undefined {
  return state.agents.find((a) => a.id === s.agentId) ?? state.agents[0]
}

/** 换了 AI、换了 token、开关了整台电脑（会断开重连）：重新拉一次工具列表 */
function agentKey(a: Agent | undefined): string {
  return a ? [a.id, a.token, a.machineAccess ? 1 : 0].join('|') : ''
}

/** 拿到当前 AI，并在它（或影响工具的设置）变化时重新拉工具列表 */
function usePlayground(state: BridgeState) {
  const s = useStore()
  const agent = currentAgent(state, s)
  const key = agentKey(agent)
  useEffect(() => {
    if (agent) void loadTools(agent.id, key)
    else set({ tools: undefined, error: undefined })
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return { ...s, agent }
}

// ========== 最近调用（每个 AI × 工具 10 条，localStorage） ==========

const HISTORY_KEY = 'wb.playground.history'
const HISTORY_MAX = 10
/** 单条参数太大就不记（比如整份文件内容），免得把 localStorage 撑满 */
const HISTORY_ARGS_MAX = 20_000

interface HistoryItem {
  ts: number
  args: Record<string, unknown>
  ok?: boolean
}

function readHistory(): Record<string, HistoryItem[]> {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

function historyOf(agentId: string, tool: string): HistoryItem[] {
  return readHistory()[`${agentId}|${tool}`] ?? []
}

function pushHistory(agentId: string, tool: string, item: HistoryItem): void {
  if (JSON.stringify(item.args).length > HISTORY_ARGS_MAX) return
  const all = readHistory()
  const k = `${agentId}|${tool}`
  const same = JSON.stringify(item.args)
  all[k] = [item, ...(all[k] ?? []).filter((h) => JSON.stringify(h.args) !== same)].slice(0, HISTORY_MAX)
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(all))
  } catch {
    // 满了就不记
  }
}

// ========== 侧栏 ==========

function ToolMark({ t }: { t: PlaygroundTool }) {
  const a = t.annotations
  if (a?.destructiveHint) return <Badge color="#f85149">危险</Badge>
  if (a?.readOnlyHint) return <Badge>只读</Badge>
  return <Badge color="#d29922">可写</Badge>
}

const selectCls = 'h-7 w-full rounded border border-line bg-canvas px-1.5 text-xs text-fg outline-none focus:border-accent'
export function PlaygroundSide({ state, selected }: { state: BridgeState; selected?: string }) {
  const { agent, tools, loading, error } = usePlayground(state)
  const [q, setQ] = useState('')
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase()
    return (tools ?? []).filter((t) => !k || t.name.toLowerCase().includes(k) || (t.description ?? '').toLowerCase().includes(k))
  }, [tools, q])

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="工具试用">
        {agent && (
          <IconButton title="重新拉工具列表" onClick={() => void loadTools(agent.id)}>
            <RefreshCw size={13} className={cx(loading && 'animate-spin')} />
          </IconButton>
        )}
      </PanelHeader>
      <div className="space-y-2 px-3 pb-2">
        {state.agents.length === 0 ? (
          <div className="text-xs leading-relaxed text-muted">还没有 AI。先在团队页新建一个，再回来试它的工具。</div>
        ) : (
          <>
            <select className={selectCls} value={agent?.id ?? ''} onChange={(e) => selectAgent(e.target.value)} title="以这个 AI 的身份调用">
              {state.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <div className="flex h-7 items-center gap-1.5 rounded border border-line bg-canvas px-1.5 focus-within:border-accent">
              <Search size={12} className="shrink-0 text-faint" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜工具名或说明" className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-faint" />
            </div>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-4">
        {error && <div className="px-3 py-1 text-xs break-words text-bad">拉工具列表失败：{error}</div>}
        {loading && !tools && <div className="px-3 py-1 text-xs text-muted">连接中…</div>}
        {tools && shown.length === 0 && <div className="px-3 py-1 text-xs text-muted">{tools.length ? '没有匹配的工具' : '这个 AI 现在没有可用的工具'}</div>}
        {tools && shown.length > 0 && <div className="px-3 pb-1 text-[11px] text-faint">{q ? `${shown.length} / ${tools.length}` : `${tools.length} 个工具`}</div>}
        {shown.map((t) => (
          <div
            key={t.name}
            onClick={() => navigate({ section: 'playground', id: t.name })}
            title={t.description}
            className={cx('mx-1.5 flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-hover', selected === t.name && 'bg-accent/15')}
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{t.name}</span>
            <ToolMark t={t} />
          </div>
        ))}
      </div>
    </div>
  )
}
// ========== 主区 ==========

export function PlaygroundMain({ state, toolName }: { state: BridgeState; toolName?: string }) {
  const { agent, tools, loading } = usePlayground(state)
  const tool = toolName ? tools?.find((t) => t.name === toolName) : undefined
  if (!agent) {
    return (
      <EmptyState
        icon={<FlaskConical size={28} />}
        title="还没有 AI"
        hint="工具试用台以某个 AI 的身份调用工具。先在团队页新建一个 AI。"
        action={<Button onClick={() => navigate({ section: 'team', id: 'new' })}>新建 AI</Button>}
      />
    )
  }
  if (!tool) {
    if (toolName && loading) return <div className="p-6 text-xs text-muted">连接中…</div>
    return (
      <EmptyState
        icon={<FlaskConical size={28} />}
        title={toolName && tools ? `「${agent.name}」现在不能用 ${toolName}` : '选一个工具'}
        hint="以选中 AI 的身份真实调用，和外部 AI 走同一条路，调用会记进审计日志和实时活动。这里的调用是真的会执行（写文件、跑命令都会生效）。用来排查「AI 说调不了某个工具」，或者看参数该怎么写。"
      />
    )
  }
  // 换 AI 或换工具时整块重置
  return <ToolPanel key={`${agent.id}|${tool.name}`} agent={agent} tool={tool} />
}

type Mode = 'form' | 'raw'

function ToolPanel({ agent, tool }: { agent: Agent; tool: PlaygroundTool }) {
  const fields = useMemo(() => schemaToFields(tool.inputSchema), [tool.inputSchema])
  // 没有参数或 schema 装不进表单时，默认原始 JSON
  const [mode, setMode] = useState<Mode>(fields.length ? 'form' : 'raw')
  const [values, setValues] = useState<FormValues>(() => defaultValues(fields))
  const [raw, setRaw] = useState(() => JSON.stringify(safeArgs(fields, defaultValues(fields)), null, 2))
  const [formError, setFormError] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<PlaygroundCallResult>()
  const [history, setHistory] = useState(() => historyOf(agent.id, tool.name))
  const [showHistory, setShowHistory] = useState(false)

  const currentArgs = (): Record<string, unknown> => {
    if (mode === 'form') return valuesToArgs(fields, values)
    const v = raw.trim() ? JSON.parse(raw) : {}
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('参数要是一个 JSON 对象')
    return v as Record<string, unknown>
  }

  const switchMode = (next: Mode) => {
    if (next === mode) return
    setFormError('')
    try {
      if (next === 'raw') setRaw(JSON.stringify(valuesToArgs(fields, values), null, 2))
      else setValues(argsToValues(fields, currentArgs()))
    } catch (e) {
      // 表单没填完也能切到原始 JSON：带上已经填好的
      if (next === 'raw') setRaw(JSON.stringify(safeArgs(fields, values), null, 2))
      else {
        setFormError(`切不回表单：${errText(e)}`)
        return
      }
    }
    setMode(next)
  }

  const fill = (h: HistoryItem) => {
    setValues(argsToValues(fields, h.args))
    setRaw(JSON.stringify(h.args, null, 2))
    setFormError('')
    setShowHistory(false)
  }

  async function call() {
    let args: Record<string, unknown>
    try {
      args = currentArgs()
    } catch (e) {
      setFormError(errText(e))
      return
    }
    setFormError('')
    setRunning(true)
    setResult(undefined)
    try {
      const r = await window.bridge.playgroundCall(agent.id, tool.name, args)
      setResult(r)
      pushHistory(agent.id, tool.name, { ts: Date.now(), args, ok: !r.isError })
    } catch (e) {
      setResult({ isError: true, content: [], durationMs: 0, protocolError: errText(e) })
    } finally {
      setRunning(false)
      setHistory(historyOf(agent.id, tool.name))
    }
  }
  const a = tool.annotations
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[15px] font-semibold">{tool.name}</span>
          <ToolMark t={tool} />
          {a?.idempotentHint && <Badge>幂等</Badge>}
          {a?.openWorldHint && <Badge>访问外部</Badge>}
          <span className="flex-1" />
          <span className="text-xs text-muted">
            身份：{agent.name}
          </span>
        </div>
        {tool.description && <div className="selectable text-xs leading-relaxed whitespace-pre-wrap text-muted">{tool.description}</div>}
      </div>

      <div className="space-y-3 rounded-lg border border-line-soft bg-panel p-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted">参数</span>
          <span className="flex-1" />
          {history.length > 0 && (
            <div className="relative">
              <Button size="sm" variant="ghost" onClick={() => setShowHistory((v) => !v)} title="最近 10 次调用的参数，点一下回填">
                <History size={12} /> 最近调用（{history.length}）
              </Button>
              {showHistory && (
                <div className="absolute top-full right-0 z-20 mt-1 max-h-72 w-96 overflow-auto rounded-md border border-line bg-raised py-1 shadow-lg">
                  {history.map((h) => (
                    <button key={h.ts} onClick={() => fill(h)} className="flex w-full cursor-pointer items-start gap-2 px-2.5 py-1.5 text-left hover:bg-hover">
                      <span className={cx('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', h.ok === false ? 'bg-bad' : 'bg-ok')} />
                      <span className="shrink-0 text-[11px] text-faint">{clockTime(h.ts)}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">{JSON.stringify(h.args)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {fields.length > 0 && (
            <Segmented<Mode>
              value={mode}
              onChange={switchMode}
              options={[
                { value: 'form', label: '表单' },
                { value: 'raw', label: '原始 JSON' }
              ]}
            />
          )}
        </div>

        {mode === 'form' ? (
          <div className="space-y-3">
            {fields.map((f) => (
              <FieldInput key={f.name} f={f} value={values[f.name] ?? ''} onChange={(v) => setValues((cur) => ({ ...cur, [f.name]: v }))} />
            ))}
          </div>
        ) : (
          <div className="space-y-1">
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              spellCheck={false}
              rows={Math.min(18, Math.max(4, raw.split('\n').length + 1))}
              className="w-full resize-y rounded-md border border-line bg-canvas p-2.5 font-mono text-[12px] leading-normal text-fg outline-none focus:border-accent"
            />
            {fields.length === 0 && <div className="text-[11px] text-faint">这个工具没有参数，或者参数结构表单装不下，直接写 JSON。</div>}
          </div>
        )}

        {formError && <div className="text-xs break-words text-bad">{formError}</div>}
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={() => void call()} disabled={running}>
            {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} 调用
          </Button>
          {running && <span className="text-xs text-muted">等待返回…</span>}
        </div>
      </div>

      {result && <ResultView r={result} />}
    </div>
  )
}

/** 表单 → 参数，跳过填得不对的项（切到原始 JSON 时用，免得已经填的丢了） */
function safeArgs(fields: FormField[], values: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    try {
      Object.assign(out, valuesToArgs([{ ...f, required: false }], values))
    } catch {
      // 跳过
    }
  }
  return out
}
const inputCls = 'w-full rounded-md border border-line bg-canvas px-2.5 text-[13px] text-fg outline-none placeholder:text-faint focus:border-accent'

const KIND_HINT: Partial<Record<FormField['kind'], string>> = {
  lines: '一行一项',
  json: 'JSON',
  integer: '整数',
  number: '数字'
}

function FieldInput({ f, value, onChange }: { f: FormField; value: string; onChange: (v: string) => void }) {
  const hint = f.kind === 'lines' && f.itemKind && f.itemKind !== 'string' ? `一行一项（${f.itemKind}）` : KIND_HINT[f.kind]
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-xs text-fg">{f.name}</span>
        {f.required && (
          <span className="text-bad" title="必填">
            *
          </span>
        )}
        {hint && <span className="text-[11px] text-faint">{hint}</span>}
      </div>
      {f.kind === 'boolean' ? (
        <select className={cx(inputCls, 'h-8')} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{f.required ? '请选择' : '不传'}</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : f.kind === 'enum' ? (
        <select className={cx(inputCls, 'h-8 font-mono')} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{f.required ? '请选择' : '不传'}</option>
          {(f.options ?? []).map((o, i) => (
            <option key={i} value={String(i)}>
              {typeof o === 'string' ? o : JSON.stringify(o)}
            </option>
          ))}
        </select>
      ) : f.kind === 'text' || f.kind === 'lines' || f.kind === 'json' ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          rows={Math.min(12, Math.max(3, value.split('\n').length + 1))}
          className={cx(inputCls, 'resize-y py-1.5 leading-normal', f.kind !== 'text' && 'font-mono text-[12px]')}
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode={f.kind === 'number' || f.kind === 'integer' ? 'decimal' : undefined}
          className={cx(inputCls, 'h-8', f.kind !== 'string' && 'font-mono')}
        />
      )}
      {f.description && <div className="text-[11px] leading-relaxed whitespace-pre-wrap text-faint">{f.description}</div>}
    </div>
  )
}

// ========== 结果 ==========

interface ContentPart {
  type?: string
  text?: string
  data?: string
  mimeType?: string
}

function ResultView({ r }: { r: PlaygroundCallResult }) {
  const parts = r.content as ContentPart[]
  const rawJson = JSON.stringify({ isError: r.isError, content: r.content, ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}) }, null, 2)
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted">结果</span>
        {r.protocolError ? <Badge color="#f85149">调用失败</Badge> : r.isError ? <Badge color="#f85149">isError</Badge> : <Badge color="#3fb950">成功</Badge>}
        <span className="text-xs text-faint">{r.durationMs} ms</span>
        <span className="flex-1" />
        <CopyButton text={rawJson} label="复制原始结果" />
      </div>
      {r.protocolError && <div className="text-xs text-muted">协议层的错误（工具不存在、参数没通过校验、连不上），不是工具自己返回的。</div>}
      {parts.length === 0 && <div className="text-xs text-muted">content 是空的</div>}
      {parts.map((p, i) => (
        <Part key={i} p={p} bad={r.isError} />
      ))}
    </div>
  )
}

function Part({ p, bad }: { p: ContentPart; bad: boolean }) {
  const box = cx('selectable max-h-[480px] overflow-auto rounded-md border bg-canvas p-3 font-mono text-[12px] leading-normal break-words whitespace-pre-wrap', bad ? 'border-bad/40 text-[#ffa198]' : 'border-line-soft text-[#c9d1d9]')
  if (p.type === 'text' && typeof p.text === 'string') {
    const pretty = prettyText(p.text)
    return (
      <div className="space-y-1">
        <div className="text-[11px] text-faint">text{pretty.json ? ' · JSON 已格式化' : ''}</div>
        <pre className={box}>{pretty.text}</pre>
      </div>
    )
  }
  if (p.type === 'image' && typeof p.data === 'string') {
    const mime = /^image\/(png|jpeg|gif|webp)$/.test(p.mimeType ?? '') ? p.mimeType : 'image/png'
    return (
      <div className="space-y-1">
        <div className="text-[11px] text-faint">image · {p.mimeType ?? '未知类型'}</div>
        <img src={`data:${mime};base64,${p.data}`} alt="工具返回的图片" className="max-w-full rounded-md border border-line-soft" />
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <div className="text-[11px] text-faint">{p.type ?? '未知类型'}</div>
      <pre className={box}>{JSON.stringify(p, null, 2)}</pre>
    </div>
  )
}
