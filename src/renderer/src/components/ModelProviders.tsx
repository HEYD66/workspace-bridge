import { Check, ChevronRight, Cpu, Download, Loader2, Plus, X, Zap } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentModel, BridgeState, ModelProviderView, ProviderInput, ProviderKind } from '../../../shared/api'
import { errText } from '../lib/format'
import { Badge, Button, Card, ConfirmButton, cx, Field, Input, Segmented } from './ui'

/** 提供方列表和 AI 的模型绑定；提供方或绑定变了（onChanged('providers')）自动重新拉 */
export function useModelProviders() {
  const [providers, setProviders] = useState<ModelProviderView[]>()
  const [agentModels, setAgentModels] = useState<Record<string, AgentModel>>()
  const [error, setError] = useState('')
  // 只认最后一次请求的结果
  const seq = useRef(0)
  const reload = useCallback(async () => {
    const n = ++seq.current
    try {
      const [p, m] = await Promise.all([window.bridge.listProviders(), window.bridge.listAgentModels()])
      if (n !== seq.current) return
      setProviders(p)
      setAgentModels(m)
      setError('')
    } catch (e) {
      if (n === seq.current) setError(errText(e))
    }
  }, [])
  useEffect(() => {
    void reload()
    return window.bridge.onChanged((kind) => {
      if (kind === 'providers') void reload()
    })
  }, [reload])
  return { providers, agentModels, error, reload }
}

export interface ProviderPreset {
  key: string
  /** 预设列表里显示的名字 */
  label: string
  /** 新建时默认的提供方名字 */
  name: string
  kind: ProviderKind
  baseUrl: string
  models?: string[]
  keyOptional?: boolean
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { key: 'deepseek', label: 'DeepSeek', name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { key: 'qwen', label: '通义千问', name: '通义千问', kind: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { key: 'kimi', label: 'Kimi', name: 'Kimi', kind: 'openai', baseUrl: 'https://api.moonshot.cn/v1' },
  { key: 'zhipu', label: '智谱', name: '智谱', kind: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { key: 'siliconflow', label: '硅基流动', name: '硅基流动', kind: 'openai', baseUrl: 'https://api.siliconflow.cn/v1' },
  { key: 'openrouter', label: 'OpenRouter', name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1' },
  { key: 'openai', label: 'OpenAI', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1' },
  { key: 'anthropic', label: 'Anthropic', name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  { key: 'ollama', label: 'Ollama 本地', name: 'Ollama', kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', keyOptional: true },
  { key: 'custom', label: '自定义 OpenAI 兼容', name: '', kind: 'openai', baseUrl: '' }
]

const KIND_OPTIONS: { value: ProviderKind; label: string; title: string }[] = [
  { value: 'openai', label: 'OpenAI 兼容', title: 'POST /chat/completions（DeepSeek、通义、Kimi、Ollama 等）' },
  { value: 'anthropic', label: 'Anthropic', title: 'POST /v1/messages' }
]

function cleanBaseUrl(s: string): string {
  return s.trim().replace(/\/+$/, '')
}

function validBaseUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s)
}

/** 本机地址（Ollama 这类）可以不要 API Key */
export function isLocalUrl(s: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(s.trim())
}

/** 设置页：模型提供方 */
export function ProvidersCard({ state }: { state: BridgeState }) {
  const { providers, agentModels, error, reload } = useModelProviders()
  const [picking, setPicking] = useState(false)
  // key 不变编辑器就不重建：新建的保存后拿到 id，测试结果等还留着
  const [editing, setEditing] = useState<{ key: string; id?: string; preset?: ProviderPreset }>()
  const newSeq = useRef(0)
  const usersOf = (id: string) => state.agents.filter((a) => agentModels?.[a.id]?.providerId === id).map((a) => a.name)
  const editingView = editing?.id ? providers?.find((p) => p.id === editing.id) : undefined

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <Cpu size={15} className="text-accent" />
        <span className="text-[13px] font-medium">模型提供方</span>
        {providers && providers.length > 0 && <Badge>{providers.length} 个</Badge>}
        <div className="flex-1" />
        <Button
          onClick={() => {
            setPicking(true)
            setEditing(undefined)
          }}
        >
          <Plus size={14} /> 添加
        </Button>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">内置 AI 用这里的 API Key 直接调用模型，和外部 AI 用同一套工具干活。API Key 只保存在本机。</p>

      {error && <div className="mt-3 text-xs text-bad">{error}</div>}
      {!providers && !error && <div className="mt-3 text-xs text-muted">加载中…</div>}

      {providers && providers.length > 0 && (
        <div className="mt-4 divide-y divide-line-soft rounded-md border border-line-soft bg-canvas">
          {providers.map((p) => {
            const users = usersOf(p.id)
            const sel = editing?.id === p.id
            return (
              <button
                key={p.id}
                onClick={() => {
                  setPicking(false)
                  setEditing(sel ? undefined : { key: p.id, id: p.id })
                }}
                className={cx('flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left hover:bg-hover/50', sel && 'bg-accent/10')}
              >
                <ChevronRight size={13} className={cx('shrink-0 text-faint transition-transform', sel && 'rotate-90')} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] text-fg">{p.name}</span>
                    {p.kind === 'anthropic' && <Badge>Anthropic</Badge>}
                    {!p.hasKey && !isLocalUrl(p.baseUrl) && <Badge color="#d29922">没有 API Key</Badge>}
                  </div>
                  <div className="truncate font-mono text-[11px] text-faint">{p.baseUrl}</div>
                </div>
                <span className="shrink-0 text-[11px] text-faint">
                  {p.models.length} 个模型{users.length ? ` · ${users.length} 个 AI 在用` : ''}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {providers && providers.length === 0 && !picking && !editing && (
        <div className="mt-4 rounded-md border border-dashed border-line-soft px-3 py-2.5 text-xs leading-relaxed text-muted">还没有配置。点「添加」选一个模型服务商，填上 API Key。</div>
      )}

      {picking && (
        <PresetPicker
          onCancel={() => setPicking(false)}
          onPick={(preset) => {
            setPicking(false)
            setEditing({ key: `new-${++newSeq.current}`, preset })
          }}
        />
      )}

      {editing && (
        <ProviderEditor
          key={editing.key}
          initial={editingView}
          preset={editing.preset}
          users={editing.id ? usersOf(editing.id) : []}
          onSaved={(v) => {
            setEditing((e) => e && { ...e, id: v.id })
            void reload()
          }}
          onRemoved={() => {
            setEditing(undefined)
            void reload()
          }}
          onClose={() => setEditing(undefined)}
        />
      )}
    </Card>
  )
}

function PresetPicker({ onPick, onCancel }: { onPick: (p: ProviderPreset) => void; onCancel: () => void }) {
  return (
    <div className="mt-4 space-y-2">
      <div className="flex items-center">
        <div className="flex-1 text-xs font-medium text-muted">选择服务商</div>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          取消
        </Button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-1.5">
        {PROVIDER_PRESETS.map((p) => (
          <button
            key={p.key}
            onClick={() => onPick(p)}
            className="min-w-0 cursor-pointer rounded-md border border-line-soft bg-canvas px-3 py-2 text-left transition-colors hover:border-line hover:bg-hover"
          >
            <div className="truncate text-[13px] text-fg">{p.label}</div>
            <div className="truncate font-mono text-[11px] text-faint">{p.baseUrl ? p.baseUrl.replace(/^https?:\/\//, '') : '填自己的地址'}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

function ProviderEditor({
  initial,
  preset,
  users,
  onSaved,
  onRemoved,
  onClose
}: {
  initial?: ModelProviderView
  preset?: ProviderPreset
  users: string[]
  onSaved: (v: ModelProviderView) => void
  onRemoved: () => void
  onClose: () => void
}) {
  /** 最近一次保存的结果；新建还没保存时为空 */
  const [view, setView] = useState(initial)
  const [name, setName] = useState(initial?.name ?? preset?.name ?? '')
  const [kind, setKind] = useState<ProviderKind>(initial?.kind ?? preset?.kind ?? 'openai')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? preset?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<string[]>(initial?.models ?? preset?.models ?? [])
  const [modelInput, setModelInput] = useState('')
  const [testModel, setTestModel] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string }>()

  const url = cleanBaseUrl(baseUrl)
  const valid = !!name.trim() && validBaseUrl(url)
  const dirty =
    !view || name.trim() !== view.name || kind !== view.kind || url !== view.baseUrl || apiKey.trim() !== '' || models.join('\n') !== view.models.join('\n')
  const keyOptional = !!preset?.keyOptional || isLocalUrl(url)

  function apply(v: ModelProviderView) {
    setView(v)
    setName(v.name)
    setKind(v.kind)
    setBaseUrl(v.baseUrl)
    setModels(v.models)
    setApiKey('')
    onSaved(v)
  }

  /** 按当前填写的内容保存；apiKey 留空不改，over.apiKey 传空字符串是清除 */
  async function persist(over: { apiKey?: string } = {}): Promise<ModelProviderView> {
    if (!name.trim()) throw new Error('先填名字')
    if (!validBaseUrl(url)) throw new Error('地址要以 http:// 或 https:// 开头')
    const input: ProviderInput = { id: view?.id, name: name.trim(), kind, baseUrl: url, models }
    if ('apiKey' in over) input.apiKey = over.apiKey
    else if (apiKey.trim()) input.apiKey = apiKey.trim()
    const v = await window.bridge.saveProvider(input)
    apply(v)
    return v
  }

  /** 拉取和测试走已保存的配置：有改动先保存 */
  const ensureSaved = () => (view && !dirty ? Promise.resolve(view) : persist())

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key)
    setError('')
    setNotice(undefined)
    try {
      await fn()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy('')
    }
  }

  function addModels() {
    const add = modelInput
      .split(/[\s,，]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (!add.length) return
    setModels([...models, ...add.filter((m, i) => !models.includes(m) && add.indexOf(m) === i)])
    setModelInput('')
  }

  const fetchModels = () =>
    run('fetch', async () => {
      const v = await ensureSaved()
      const list = [...new Set(await window.bridge.fetchProviderModels(v.id))]
      // 接口返回的在前，手动加的保留在后面
      const merged = [...list, ...v.models.filter((m) => !list.includes(m))]
      apply(await window.bridge.saveProvider({ id: v.id, name: v.name, kind: v.kind, baseUrl: v.baseUrl, models: merged }))
      setNotice({ ok: true, text: list.length ? `拉取到 ${list.length} 个模型` : '接口没有返回模型，可以手动添加' })
    })

  const test = () =>
    run('test', async () => {
      const v = await ensureSaved()
      const m = (v.models.includes(testModel) ? testModel : '') || v.models[0]
      if (!m) throw new Error('先添加或拉取一个模型')
      const r = await window.bridge.testProvider(v.id, m)
      setNotice({ ok: r.ok, text: r.ok ? `${m} 可用，用时 ${r.latencyMs} ms${r.message ? `：${r.message}` : ''}` : r.message || '测试失败' })
    })

  return (
    <div className="mt-4 space-y-4 rounded-md border border-line p-4">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium">{view ? `编辑「${view.name}」` : `添加 ${preset?.label ?? '提供方'}`}</span>
        {users.length > 0 && <span className="truncate text-[11px] text-faint">在用：{users.join('、')}</span>}
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
        <Field label="名字">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 公司内网模型" />
        </Field>
        <Field label="地址">
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://example.com/v1" spellCheck={false} className="font-mono text-xs" />
        </Field>
      </div>

      <Field label="接口格式">
        <Segmented value={kind} onChange={setKind} options={KIND_OPTIONS} />
      </Field>

      <Field label="API Key" hint={keyOptional ? '本机的模型服务一般不需要 API Key。' : undefined}>
        <div className="flex items-center gap-2">
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={view?.hasKey ? '已保存，留空不修改' : keyOptional ? '可以留空' : '粘贴 API Key'}
            autoComplete="off"
            spellCheck={false}
          />
          {view?.hasKey && (
            <>
              <Badge color="#3fb950">
                <Check size={10} /> 已保存
              </Badge>
              <ConfirmButton size="md" confirmText="确认清除？" onConfirm={() => void run('clearKey', () => persist({ apiKey: '' }))}>
                清除
              </ConfirmButton>
            </>
          )}
        </div>
      </Field>

      <Field label="模型" hint="内置 AI 从这里选模型。可以手动添加，也可以从接口拉取。">
        {models.length > 0 && (
          <div className="flex max-h-36 flex-wrap gap-1 overflow-auto rounded-md border border-line-soft bg-canvas p-1.5">
            {models.map((m) => (
              <span key={m} className="inline-flex items-center gap-0.5 rounded bg-hover py-px pr-0.5 pl-1.5 font-mono text-[11px] text-fg">
                {m}
                <button title="移除" onClick={() => setModels(models.filter((x) => x !== m))} className="cursor-pointer rounded p-0.5 text-faint hover:text-fg">
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Input
            value={modelInput}
            onChange={(e) => setModelInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) addModels()
            }}
            placeholder="模型名，回车添加"
            spellCheck={false}
            className="font-mono text-xs"
          />
          <Button disabled={!modelInput.trim()} onClick={addModels}>
            添加
          </Button>
          <Button disabled={!!busy || !valid} onClick={fetchModels}>
            {busy === 'fetch' ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} 从接口拉取
          </Button>
          {models.length > 5 && (
            <Button variant="ghost" onClick={() => setModels([])}>
              清空
            </Button>
          )}
        </div>
      </Field>

      <div className="flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
        <Button variant="primary" disabled={!!busy || !dirty || !valid} onClick={() => void run('save', () => persist())}>
          {busy === 'save' ? '保存中…' : '保存'}
        </Button>
        {models.length > 1 && (
          <select
            value={models.includes(testModel) ? testModel : models[0]}
            onChange={(e) => setTestModel(e.target.value)}
            title="测试用的模型"
            className="h-8 max-w-48 rounded-md border border-line bg-canvas px-2 font-mono text-xs outline-none focus:border-accent"
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        )}
        <Button disabled={!!busy || !valid} onClick={test} title={dirty ? '先保存再测试' : '发一条很短的消息试连'}>
          {busy === 'test' ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />} {busy === 'test' ? '测试中…' : '测试'}
        </Button>
        <div className="flex-1" />
        {view && (
          <ConfirmButton
            size="md"
            confirmText={users.length ? `确认删除？${users.length} 个 AI 会解除绑定` : '确认删除？'}
            onConfirm={() =>
              void run('remove', async () => {
                await window.bridge.removeProvider(view.id)
                onRemoved()
              })
            }
          >
            删除
          </ConfirmButton>
        )}
        <Button variant="ghost" onClick={onClose}>
          {view && !dirty ? '收起' : '取消'}
        </Button>
      </div>

      {notice && <Line ok={notice.ok}>{notice.text}</Line>}
      {error && <Line ok={false}>{error}</Line>}
    </div>
  )
}

function Line({ ok, children }: { ok: boolean; children: ReactNode }) {
  return <div className={cx('selectable text-xs leading-relaxed break-words whitespace-pre-wrap', ok ? 'text-ok' : 'text-bad')}>{children}</div>
}
