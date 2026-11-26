import { Bot, MessageSquare } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Agent, AgentModel, BridgeState } from '../../../shared/api'
import { errText } from '../lib/format'
import { navigate } from '../lib/nav'
import { isLocalUrl, useModelProviders } from './ModelProviders'
import { Badge, Button, ConfirmButton, Field, Input, TextArea } from './ui'

const DEFAULT_MAX_STEPS = 30
/** 模型下拉里「手动填写」那一项 */
const CUSTOM = '__custom__'
const SELECT_CLASS = 'h-8 w-full rounded-md border border-line bg-canvas px-2 text-[13px] outline-none focus:border-accent'

/** 提供方和模型都选好了才能绑定 */
export function agentModelReady(m: AgentModel | undefined): m is AgentModel {
  return !!m?.providerId && !!m.model?.trim()
}

/** 绑定前整理：去掉空的可选项 */
export function cleanAgentModel(m: AgentModel): AgentModel {
  const out: AgentModel = { providerId: m.providerId, model: m.model.trim() }
  if (m.systemPrompt?.trim()) out.systemPrompt = m.systemPrompt
  if (typeof m.temperature === 'number' && Number.isFinite(m.temperature)) out.temperature = m.temperature
  if (typeof m.maxSteps === 'number' && Number.isFinite(m.maxSteps)) out.maxSteps = m.maxSteps
  if (m.autoTasks) out.autoTasks = true
  return out
}

function parseNumber(t: string): number | undefined {
  const s = t.trim()
  if (!s) return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

/** 数字输入：留空 = 不设；输入中途（如「0.」）不打断，失焦时按范围修正 */
function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  integer,
  placeholder
}: {
  value: number | undefined
  onChange: (n: number | undefined) => void
  min: number
  max: number
  step: number
  integer?: boolean
  placeholder?: string
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  // 外面改了（重置、切换 AI）才同步；自己正在输入时不覆盖
  useEffect(() => setText((t) => (parseNumber(t) === value ? t : value === undefined ? '' : String(value))), [value])
  return (
    <Input
      type="number"
      min={min}
      max={max}
      step={step}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        const t = e.target.value
        setText(t)
        const n = parseNumber(t)
        if (n !== undefined || !t.trim()) onChange(n)
      }}
      onBlur={() => {
        const n = parseNumber(text)
        if (n === undefined) {
          if (text.trim()) setText(value === undefined ? '' : String(value))
          return
        }
        const fixed = Math.min(max, Math.max(min, integer ? Math.round(n) : n))
        if (fixed !== n) {
          setText(String(fixed))
          onChange(fixed)
        }
      }}
    />
  )
}

/**
 * 内置 AI 的模型设置：提供方、模型、系统提示、温度、最多轮数、自动接活。
 * value 为空时自动选第一个提供方和它的第一个模型。
 */
export function AgentModelFields({ value, onChange }: { value: AgentModel | undefined; onChange: (m: AgentModel | undefined) => void }) {
  const { providers, error } = useModelProviders()
  const [manual, setManual] = useState(false)
  const provider = providers?.find((p) => p.id === value?.providerId)
  const models = provider?.models ?? []
  const current = value?.model ?? ''
  const showInput = manual || models.length === 0 || (!!current && !models.includes(current))

  const set = (patch: Partial<AgentModel>) => onChange({ providerId: '', model: '', ...value, ...patch })

  // 还没选提供方：默认第一个
  useEffect(() => {
    if (value?.providerId || !providers?.length) return
    const p = providers[0]
    onChange({ ...value, providerId: p.id, model: value?.model || p.models[0] || '' })
  }, [providers, value?.providerId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !providers) return <div className="text-xs text-bad">{error}</div>
  if (!providers) return <div className="text-xs text-muted">加载提供方…</div>
  if (providers.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded-md border border-dashed border-line-soft px-3 py-2.5">
        <div className="flex-1 text-xs leading-relaxed text-muted">还没有模型提供方。先在设置里添加一个（DeepSeek、通义千问、Kimi、Ollama 等），填上 API Key。</div>
        <Button size="sm" onClick={() => navigate({ section: 'settings' })}>
          去设置
        </Button>
      </div>
    )
  }

  const missingKey = provider && !provider.hasKey && !isLocalUrl(provider.baseUrl)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="提供方">
          <select
            value={value?.providerId ?? ''}
            onChange={(e) => {
              const p = providers.find((x) => x.id === e.target.value)
              if (!p) return
              setManual(false)
              set({ providerId: p.id, model: current && p.models.includes(current) ? current : (p.models[0] ?? '') })
            }}
            className={SELECT_CLASS}
          >
            {!provider && <option value={value?.providerId ?? ''}>{value?.providerId ? '提供方已删除' : '选择提供方'}</option>}
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {missingKey && <div className="text-[11px] text-warn">这个提供方还没填 API Key，去设置里补上</div>}
        </Field>
        <Field label="模型名" hint={provider && models.length === 0 ? '这个提供方还没有模型列表：手动填写，或在设置里「从接口拉取」' : undefined}>
          {models.length > 0 && (
            <select
              value={showInput ? CUSTOM : current}
              onChange={(e) => {
                if (e.target.value === CUSTOM) {
                  setManual(true)
                  return
                }
                setManual(false)
                set({ model: e.target.value })
              }}
              className={`${SELECT_CLASS} font-mono text-xs`}
            >
              {!current && !showInput && (
                <option value="" disabled>
                  选择模型
                </option>
              )}
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              <option value={CUSTOM}>手动填写…</option>
            </select>
          )}
          {showInput && (
            <Input
              value={current}
              onChange={(e) => set({ model: e.target.value.trim() })}
              placeholder="如 deepseek-chat"
              spellCheck={false}
              className="font-mono text-xs"
            />
          )}
        </Field>
      </div>

      <Field label="系统提示（可选）" hint="追加在连接说明后面，比如它的专长、说话风格、工作习惯">
        <TextArea rows={3} value={value?.systemPrompt ?? ''} onChange={(e) => set({ systemPrompt: e.target.value || undefined })} placeholder="如：你是前端开发，改代码前先读相关文件，改完说明改了什么" />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="温度" hint="留空用模型默认值；一般 0–1，越高越发散">
          <NumberInput value={value?.temperature} onChange={(n) => set({ temperature: n })} min={0} max={2} step={0.1} placeholder="默认" />
        </Field>
        <Field label="最多轮数" hint={`一次对话里最多调用几轮工具，默认 ${DEFAULT_MAX_STEPS}`}>
          <NumberInput value={value?.maxSteps} onChange={(n) => set({ maxSteps: n })} min={1} max={200} step={1} integer placeholder={String(DEFAULT_MAX_STEPS)} />
        </Field>
      </div>

      <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line-soft bg-panel p-3">
        <input type="checkbox" checked={!!value?.autoTasks} onChange={(e) => set({ autoTasks: e.target.checked || undefined })} className="mt-0.5 accent-[#58a6ff]" />
        <span>
          <span className="block text-[13px]">自动接活</span>
          <span className="block text-xs text-muted">收到新任务、审查结果这类通知，而且它正空闲时，自动开始处理</span>
        </span>
      </label>
    </div>
  )
}

/** AI 详情里的「内置模型」：绑定、修改、解除模型，跳到对话 */
export function AgentModelCard({ agent }: { state: BridgeState; agent: Agent }) {
  const { providers } = useModelProviders()
  /** undefined：加载中；null：没绑定 */
  const [bound, setBound] = useState<AgentModel | null>()
  const [draft, setDraft] = useState<AgentModel>()
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 只认最后一次请求的结果
  const seq = useRef(0)
  const reload = useCallback(async () => {
    const n = ++seq.current
    try {
      const m = await window.bridge.getAgentModel(agent.id)
      if (n !== seq.current) return
      setBound(m)
      setError('')
    } catch (e) {
      if (n === seq.current) setError(errText(e))
    }
  }, [agent.id])

  useEffect(() => {
    setBound(undefined)
    setDraft(undefined)
    setEditing(false)
    setError('')
    void reload()
    return window.bridge.onChanged((kind) => {
      if (kind === 'providers') void reload()
    })
  }, [reload])

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const save = () =>
    run(async () => {
      if (!agentModelReady(draft)) return
      const m = cleanAgentModel(draft)
      await window.bridge.setAgentModel(agent.id, m)
      setBound(m)
      setEditing(false)
    })

  const unbind = () =>
    run(async () => {
      await window.bridge.setAgentModel(agent.id, null)
      setBound(null)
      setEditing(false)
    })

  const providerName = bound ? (providers?.find((p) => p.id === bound.providerId)?.name ?? (providers ? '提供方已删除' : '')) : ''
  const details = bound
    ? [
        providerName,
        bound.temperature !== undefined ? `温度 ${bound.temperature}` : '',
        `最多 ${bound.maxSteps ?? DEFAULT_MAX_STEPS} 轮`,
        bound.autoTasks ? '自动接活' : ''
      ].filter(Boolean)
    : []

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="text-xs font-medium text-muted">内置模型</div>
        {bound && (
          <Badge color="#58a6ff">
            <Bot size={10} /> 内置 AI
          </Badge>
        )}
      </div>

      {bound === undefined && !error && <div className="text-xs text-muted">加载中…</div>}

      {editing ? (
        <div className="space-y-4 rounded-md border border-line p-4">
          <AgentModelFields value={draft} onChange={setDraft} />
          <div className="flex items-center gap-2 border-t border-line-soft pt-3">
            <Button variant="primary" disabled={busy || !agentModelReady(draft)} onClick={() => void save()}>
              {busy ? '保存中…' : bound ? '保存' : '绑定'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              取消
            </Button>
          </div>
        </div>
      ) : bound ? (
        <div className="space-y-1.5 rounded-md border border-line-soft bg-canvas px-3 py-2">
          <div className="flex items-center gap-2.5">
            <Bot size={15} className="shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[13px] text-fg">{bound.model}</div>
              <div className="truncate text-[11px] text-faint">{details.join(' · ')}</div>
            </div>
            <Button size="sm" onClick={() => navigate({ section: 'chat', id: agent.id })}>
              <MessageSquare size={12} /> 去对话
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(bound)
                setEditing(true)
              }}
            >
              修改
            </Button>
            <ConfirmButton confirmText="确认解除？" onConfirm={() => void unbind()}>
              解除绑定
            </ConfirmButton>
          </div>
          {bound.systemPrompt && <div className="line-clamp-2 text-[11px] leading-relaxed text-muted">系统提示：{bound.systemPrompt}</div>}
        </div>
      ) : bound === null ? (
        <div className="flex items-center gap-3 rounded-md border border-dashed border-line-soft px-3 py-2.5">
          <div className="flex-1 text-xs leading-relaxed text-muted">
            绑定一个模型后，它就成了内置 AI：本应用用你的 API Key 直接调用模型，你可以在「对话」里和它聊天、给它派任务。它和外部 AI 用同一套工具，同样是完全权限。
          </div>
          <Button
            size="sm"
            onClick={() => {
              setDraft(undefined)
              setEditing(true)
            }}
          >
            绑定模型
          </Button>
        </div>
      ) : null}

      {error && <div className="text-xs text-bad">{error}</div>}
    </section>
  )
}
