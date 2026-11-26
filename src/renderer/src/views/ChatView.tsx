import { Bell, Bot, Brain, Check, ChevronRight, Eraser, Loader2, Plus, Send, Settings2, Square, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Agent, AgentModel, BridgeState, ChatMessage, ChatSession, ChatToolCall, ModelProviderView } from '../../../shared/api'
import { TOOL_CATALOG } from '../../../shared/tools'
import { isLocalUrl, useModelProviders } from '../components/ModelProviders'
import { Avatar, Badge, Button, ConfirmButton, CopyButton, cx, EmptyState, IconButton, PanelHeader } from '../components/ui'
import { clockTime, errText, toolLabel } from '../lib/format'
import { MARKDOWN_CLASS, renderMarkdown } from '../lib/markdown'
import { navigate } from '../lib/nav'

// ========== 对话缓存：所有界面共用一份，onChat 推送时更新 ==========

const sessions = new Map<string, ChatSession>()
const loadErrors = new Map<string, string>()
/** 每个 AI 收到过几次推送：拉取期间来过推送，拉取结果就是旧的，丢掉 */
const pushCount = new Map<string, number>()
const loading = new Set<string>()
const listeners = new Set<() => void>()
let version = 0
let unsubscribe: (() => void) | undefined

function emit(): void {
  version++
  for (const l of listeners) l()
}

/** 只订阅一次，一直不退订：切走再切回来缓存还是新的 */
function ensureSubscribed(): void {
  if (unsubscribe) return
  unsubscribe = window.bridge.onChat((s) => {
    sessions.set(s.agentId, s)
    pushCount.set(s.agentId, (pushCount.get(s.agentId) ?? 0) + 1)
    loadErrors.delete(s.agentId)
    emit()
  })
}

function subscribe(l: () => void): () => void {
  ensureSubscribed()
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

async function loadChat(agentId: string, force = false): Promise<void> {
  ensureSubscribed()
  if (loading.has(agentId) || (!force && sessions.has(agentId))) return
  loading.add(agentId)
  const before = pushCount.get(agentId) ?? 0
  try {
    const s = await window.bridge.getChat(agentId)
    if ((pushCount.get(agentId) ?? 0) === before) sessions.set(agentId, s)
    loadErrors.delete(agentId)
  } catch (e) {
    loadErrors.set(agentId, errText(e))
  } finally {
    loading.delete(agentId)
    emit()
  }
}

function useChatStore(): void {
  useSyncExternalStore(subscribe, () => version)
}

/** 正在运行的内置 AI 的 id（状态栏用）。挂载后开始收推送；对话列表打开过时会先拉一遍所有内置 AI 的状态 */
export function useRunningChats(): string[] {
  useChatStore()
  return [...sessions.values()].filter((s) => s.status === 'running').map((s) => s.agentId)
}

/** 输入框里没发出去的草稿，切换 AI 时留着 */
const drafts = new Map<string, string>()

// ========== 小工具 ==========

const NOTICE_PREFIX = '【通知】'

function lastMessage(s: ChatSession | undefined): ChatMessage | undefined {
  return s?.messages[s.messages.length - 1]
}

/** 正在执行的工具（列表里显示「正在读取…」）；参数还在生成的占位卡片可能还没有名字 */
function runningTool(s: ChatSession | undefined): string | undefined {
  if (s?.status !== 'running') return undefined
  return lastMessage(s)?.toolCalls?.find((c) => c.status === 'running' && c.name)?.name
}

function workspaceText(state: BridgeState, agent: Agent): string {
  const base = state.workspaceName ? `全部工作区，默认当前的「${state.workspaceName}」` : '全部工作区'
  return agent.machineAccess ? `${base}；能用整台电脑` : base
}

/** 工具卡片标题旁边显示的主要参数 */
function argsSummary(args: Record<string, unknown> | undefined): string {
  for (const k of ['path', 'from', 'query', 'pattern', 'title', 'name', 'id', 'workspace']) {
    const v = args?.[k]
    if (typeof v === 'string' && v.trim()) return v.length > 80 ? v.slice(0, 80) + '…' : v
  }
  return ''
}

const MAX_BLOCK = 20_000

function formatTokens(n: number): string {
  return n.toLocaleString('en-US')
}

function Busy({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted">
      <Loader2 size={12} className="animate-spin" /> {children}
    </div>
  )
}

function ErrorBox({ children }: { children: ReactNode }) {
  return <div className="selectable rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs leading-relaxed break-words whitespace-pre-wrap text-bad">{children}</div>
}

/** runner 写进 error 的停止原因：用户自己停的，不算出错，用灰色显示 */
const STOP_REASONS = new Set(['已停止', '用户按了全部停下'])

function isStopReason(text: string | undefined): boolean {
  return !!text && STOP_REASONS.has(text.trim())
}

/** 真的出错了（用户自己停下的不算） */
function sessionFailed(s: ChatSession | undefined): boolean {
  return s?.status === 'error' && !isStopReason(s.error)
}

function MessageError({ text }: { text: string }) {
  if (isStopReason(text)) {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs text-faint">
        <Square size={10} /> {text}
      </div>
    )
  }
  return <ErrorBox>{text}</ErrorBox>
}

/** sendChat 的上限（mcp-layer 那边超过会抛错），界面先拦一下 */
const MAX_INPUT = 100_000

/** 模型还在流式输出工具参数时，runner 先放 id 为 pending-N 的占位卡片，参数收完换成真实调用 */
function isPendingCall(c: ChatToolCall): boolean {
  return c.id.startsWith('pending-')
}

const newBuiltin = () => navigate({ section: 'team', id: 'new' })
const toSettings = () => navigate({ section: 'settings' })

// ========== 侧栏：内置 AI 列表 ==========

const DOT: Record<ChatSession['status'], { cls: string; title: string }> = {
  running: { cls: 'pulse-dot bg-accent', title: '运行中' },
  error: { cls: 'bg-bad', title: '出错' },
  idle: { cls: 'bg-line', title: '空闲' }
}

export function ChatList({ state, selected, onSelect }: { state: BridgeState; selected?: string; onSelect: (id: string) => void }) {
  const { providers, agentModels, error } = useModelProviders()
  useChatStore()
  const builtin = state.agents.filter((a) => agentModels?.[a.id])
  const idsKey = builtin.map((a) => a.id).join(',')
  // 列表要显示每个 AI 的状态，先把对话都拉一遍（之后靠推送）
  useEffect(() => {
    for (const a of builtin) void loadChat(a.id)
  }, [idsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full flex-col overflow-auto pb-4">
      <PanelHeader title="内置 AI">
        <IconButton title="新建内置 AI" onClick={newBuiltin}>
          <Plus size={14} />
        </IconButton>
      </PanelHeader>
      {!agentModels && (error ? <div className="px-3 pb-2 text-xs text-bad">{error}</div> : <div className="px-3 pb-2 text-xs text-muted">加载中…</div>)}
      {agentModels && builtin.length === 0 && (
        <div className="space-y-2 px-3 pb-2">
          <div className="text-xs leading-relaxed text-muted">
            {providers?.length === 0 ? '先在设置里添加模型提供方（填 API Key），再新建内置 AI。' : '还没有内置 AI。新建 AI 时类型选「内置 AI」，或在 AI 详情里给它绑定模型。'}
          </div>
          {providers?.length === 0 ? (
            <Button size="sm" onClick={toSettings}>
              去设置
            </Button>
          ) : (
            <Button size="sm" onClick={newBuiltin}>
              <Plus size={12} /> 新建内置 AI
            </Button>
          )}
        </div>
      )}
      {builtin.map((a) => {
        const s = sessions.get(a.id)
        const status: ChatSession['status'] = s?.status === 'running' ? 'running' : sessionFailed(s) ? 'error' : 'idle'
        const tool = runningTool(s)
        const dot = DOT[status]
        return (
          <div
            key={a.id}
            onClick={() => onSelect(a.id)}
            className={cx('mx-1.5 flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-hover', selected === a.id && 'bg-accent/15')}
          >
            <Avatar name={a.name} color={a.color} size={22} active={status === 'running'} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px]">{a.name}</div>
              <div className="truncate text-[11px] text-muted">
                {status === 'running' ? (
                  <span className="text-accent">{tool ? `正在${toolLabel(tool)}…` : '思考中…'}</span>
                ) : status === 'error' ? (
                  <span className="text-bad">出错了</span>
                ) : (
                  <span className="font-mono">{agentModels?.[a.id]?.model}</span>
                )}
              </div>
            </div>
            <span title={dot.title} className={cx('h-1.5 w-1.5 shrink-0 rounded-full', dot.cls)} />
          </div>
        )
      })}
    </div>
  )
}

// ========== 主区 ==========

export function ChatMain({ state, agentId }: { state: BridgeState; agentId?: string }) {
  const { providers, agentModels, error } = useModelProviders()

  if (!agentId || agentId === 'new') {
    if (providers?.length === 0) {
      return (
        <EmptyState
          icon={<Bot size={28} />}
          title="先添加模型提供方"
          hint="内置 AI 用你的 API Key 直接调用模型（DeepSeek、通义千问、Kimi、Ollama 等）。先在设置里添加一个提供方，再新建内置 AI。"
          action={<Button onClick={toSettings}>去设置</Button>}
        />
      )
    }
    const hasBuiltin = !!agentModels && state.agents.some((a) => agentModels[a.id])
    return (
      <EmptyState
        icon={<Bot size={28} />}
        title={agentId === 'new' || !hasBuiltin ? '新建内置 AI' : '选择一个内置 AI'}
        hint={
          agentId === 'new' || !hasBuiltin
            ? '在团队页新建 AI，类型选「内置 AI」并选好模型；建好后会回到这里打开对话。'
            : '左侧列出绑定了模型的 AI。它们和外部 AI 用同一套工具干活，每一步都会出现在实时活动里。'
        }
        action={
          <Button variant={agentId === 'new' || !hasBuiltin ? 'primary' : 'default'} onClick={newBuiltin}>
            <Plus size={14} /> 新建内置 AI
          </Button>
        }
      />
    )
  }

  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return <EmptyState icon={<Bot size={28} />} title="这个 AI 不存在或已被吊销" hint="从左侧选一个内置 AI。" />
  if (!agentModels) return <div className="p-6 text-xs">{error ? <span className="text-bad">{error}</span> : <span className="text-muted">加载中…</span>}</div>
  const model = agentModels[agent.id]
  if (!model) {
    return (
      <EmptyState
        icon={<Bot size={28} />}
        title={`「${agent.name}」还没有绑定模型`}
        hint="在团队页的 AI 详情里绑定模型后，就能在这里和它对话。"
        action={<Button onClick={() => navigate({ section: 'team', id: agent.id })}>去绑定</Button>}
      />
    )
  }
  return <ChatPane key={agent.id} state={state} agent={agent} model={model} provider={providers?.find((p) => p.id === model.providerId)} providersLoaded={!!providers} />
}

const SUGGESTIONS = ['看看当前工作区里有什么，简单介绍一下这个项目', '列出还没完成的任务', '查一下共享记忆里记了什么']

function ChatPane({
  state,
  agent,
  model,
  provider,
  providersLoaded
}: {
  state: BridgeState
  agent: Agent
  model: AgentModel
  provider?: ModelProviderView
  providersLoaded: boolean
}) {
  useChatStore()
  useEffect(() => {
    void loadChat(agent.id)
  }, [agent.id])
  const session = sessions.get(agent.id)
  const loadError = loadErrors.get(agent.id)
  const messages = session?.messages ?? []
  const running = session?.status === 'running'
  const last = messages[messages.length - 1]

  const [text, setText] = useState(() => drafts.get(agent.id) ?? '')
  const [sending, setSending] = useState(false)
  const [actionError, setActionError] = useState('')
  useEffect(() => {
    if (text) drafts.set(agent.id, text)
    else drafts.delete(agent.id)
  }, [agent.id, text])

  // 输入框跟着内容长高，最高 200px
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  // 停在底部时跟着新内容滚动；用户往上翻了就不打扰
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [session])

  async function send(raw: string) {
    const t = raw.trim()
    if (!t || running || sending) return
    if (t.length > MAX_INPUT) {
      setActionError(`消息太长了（${t.length.toLocaleString('en-US')} 字），最多 ${MAX_INPUT.toLocaleString('en-US')} 字。长内容可以先存成工作区里的文件，再让它去读。`)
      return
    }
    setSending(true)
    setActionError('')
    stick.current = true
    setText('')
    try {
      await window.bridge.sendChat(agent.id, t)
    } catch (e) {
      setActionError(errText(e))
      setText((cur) => cur || raw)
    } finally {
      setSending(false)
    }
  }

  async function act(fn: () => Promise<unknown>) {
    setActionError('')
    try {
      await fn()
    } catch (e) {
      setActionError(errText(e))
    }
  }

  const role = state.roles.find((r) => r.id === agent.roleId)
  const providerName = provider?.name ?? (providersLoaded ? '提供方已删除' : '')
  const meta = [providerName, role ? `职位：${role.name}` : '', workspaceText(state, agent)].filter(Boolean)
  const missingKey = provider && !provider.hasKey && !isLocalUrl(provider.baseUrl)
  const sessionError = session?.status === 'error' && session.error && !messages.some((m) => m.error === session.error) ? session.error : ''
  const usage = session?.usage && (session.usage.input || session.usage.output) ? session.usage : undefined

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2.5">
        <Avatar name={agent.name} color={agent.color} size={28} active={running} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium">{agent.name}</span>
            <span className="truncate font-mono text-xs text-muted">{model.model}</span>
            {running && (
              <Badge color="#58a6ff">
                <Loader2 size={10} className="animate-spin" /> 运行中
              </Badge>
            )}
            {sessionFailed(session) && <Badge color="#f85149">出错</Badge>}
          </div>
          <div className="truncate text-[11px] text-faint">{meta.join(' · ')}</div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => navigate({ section: 'team', id: agent.id })} title="在团队页修改模型、职位和「整台电脑」开关">
          <Settings2 size={12} /> 设置
        </Button>
        {messages.length > 0 && (
          <ConfirmButton
            confirmText="确认清空？"
            onConfirm={() =>
              void act(async () => {
                await window.bridge.clearChat(agent.id)
                await loadChat(agent.id, true)
              })
            }
          >
            <Eraser size={12} /> 清空
          </ConfirmButton>
        )}
      </div>

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
        className="min-h-0 flex-1 overflow-auto"
      >
        <div className="mx-auto max-w-3xl space-y-5 px-4 py-5">
          {(missingKey || state.paused) && (
            <div className="space-y-1.5">
              {missingKey && (
                <div className="flex items-center gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                  <span className="flex-1">提供方「{provider.name}」还没填 API Key，发消息会失败。</span>
                  <Button size="sm" onClick={toSettings}>
                    去设置
                  </Button>
                </div>
              )}
              {state.paused && <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">所有 AI 已停下，恢复前它调用工具会被拒绝。</div>}
            </div>
          )}

          {!session && (loadError ? <ErrorBox>读取对话失败：{loadError}</ErrorBox> : <Busy>加载对话…</Busy>)}

          {session && messages.length === 0 && (
            <div className="space-y-3 py-6 text-center">
              <div className="text-[13px] text-fg">和「{agent.name}」对话</div>
              <div className="mx-auto max-w-md text-xs leading-relaxed text-muted">它用和外部 AI 一样的工具读写工作区、记忆和任务，每一步都会出现在右侧的实时活动里。</div>
              <div className="flex flex-wrap justify-center gap-1.5 pt-1">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      setText(s)
                      inputRef.current?.focus()
                    }}
                    className="cursor-pointer rounded-full border border-line-soft bg-panel px-3 py-1 text-xs text-muted hover:border-line hover:text-fg"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) =>
            m.role === 'user' ? (
              <UserMessage key={m.id} m={m} />
            ) : (
              <AssistantMessage key={m.id} agent={agent} m={m} live={running && i === messages.length - 1} />
            )
          )}

          {/* 已经发出去、模型还没开始回 */}
          {(running || sending) && last?.role !== 'assistant' && (
            <div className="flex gap-2.5">
              <Avatar name={agent.name} color={agent.color} size={22} />
              <div className="pt-0.5">
                <Busy>思考中…</Busy>
              </div>
            </div>
          )}

          {sessionError && <MessageError text={sessionError} />}
        </div>
      </div>

      <div className="shrink-0 border-t border-line bg-panel px-4 py-3">
        <div className="mx-auto max-w-3xl">
          {actionError && <div className="mb-2 text-xs text-bad">{actionError}</div>}
          <div className="flex items-end gap-2 rounded-lg border border-line bg-canvas p-2 focus-within:border-accent">
            <textarea
              ref={inputRef}
              autoFocus
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send(text)
                }
              }}
              placeholder={running ? '它正在干活，可以先写下一条…' : `给「${agent.name}」发消息`}
              className="max-h-[200px] min-h-[24px] flex-1 resize-none bg-transparent px-1 py-0.5 text-[13px] leading-relaxed text-fg outline-none placeholder:text-faint"
            />
            {running ? (
              <Button onClick={() => void act(() => window.bridge.stopChat(agent.id))} title="停下当前这一轮">
                <Square size={12} /> 停止
              </Button>
            ) : (
              <Button variant="primary" disabled={!text.trim() || sending} onClick={() => void send(text)}>
                {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} 发送
              </Button>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-3 text-[11px] text-faint">
            <span>Enter 发送，Shift+Enter 换行</span>
            <span className="flex-1" />
            {usage && (
              <span>
                已用 tokens：输入 {formatTokens(usage.input)} · 输出 {formatTokens(usage.output)}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ========== 消息 ==========

function UserMessage({ m }: { m: ChatMessage }) {
  // 自动接活时 runner 代发的通知
  if (m.content.startsWith(NOTICE_PREFIX)) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-line-soft bg-panel px-3 py-2" title={clockTime(m.ts)}>
        <Bell size={13} className="mt-0.5 shrink-0 text-warn" />
        <div className="selectable min-w-0 flex-1 text-xs leading-relaxed break-words whitespace-pre-wrap text-muted">{m.content}</div>
      </div>
    )
  }
  return (
    <div className="flex justify-end">
      <div
        title={clockTime(m.ts)}
        className="selectable max-w-[85%] rounded-lg rounded-br-sm border border-line-soft bg-raised px-3 py-2 text-[13px] leading-relaxed break-words whitespace-pre-wrap text-fg"
      >
        {m.content}
      </div>
    </div>
  )
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className={MARKDOWN_CLASS} dangerouslySetInnerHTML={{ __html: html }} />
}

function AssistantMessage({ agent, m, live }: { agent: Agent; m: ChatMessage; live: boolean }) {
  const calls = m.toolCalls ?? []
  const toolRunning = calls.some((c) => c.status === 'running')
  // 正在等模型输出（还没有正文，也没有工具在跑）
  const waiting = live && !m.content && !toolRunning
  return (
    <div className="group flex gap-2.5">
      <Avatar name={agent.name} color={agent.color} size={22} />
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        {m.reasoning && <Reasoning text={m.reasoning} live={waiting && !calls.length} />}
        {m.content && <Markdown text={m.content} />}
        {calls.length > 0 && (
          <div className="space-y-1.5">
            {calls.map((c) => (
              <ToolCard key={c.id} call={c} />
            ))}
          </div>
        )}
        {waiting && !m.reasoning && <Busy>思考中…</Busy>}
        {m.error && <MessageError text={m.error} />}
        {!live && (
          <div className="flex h-6 items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
            {m.content && <CopyButton text={m.content} />}
            <span className="text-[11px] text-faint">{clockTime(m.ts)}</span>
          </div>
        )}
      </div>
    </div>
  )
}

/** 推理过程：默认折叠 */
function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted hover:text-fg">
        <ChevronRight size={12} className={cx('transition-transform', open && 'rotate-90')} />
        {live ? <Loader2 size={12} className="animate-spin" /> : <Brain size={12} />}
        {live ? '思考中…' : '思考过程'}
        <span className="text-faint">{text.length} 字</span>
      </button>
      {open && (
        <div className="selectable mt-1.5 max-h-80 overflow-auto border-l-2 border-line pl-3 text-xs leading-relaxed break-words whitespace-pre-wrap text-muted">{text}</div>
      )}
    </div>
  )
}

const TOOL_META = new Map(TOOL_CATALOG.map((t) => [t.name, t.label]))

function ToolCard({ call }: { call: ChatToolCall }) {
  const [open, setOpen] = useState(false)
  // 占位卡片：模型还在输出参数，没什么可展开的
  if (isPendingCall(call)) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-line-soft bg-canvas px-2.5 py-1.5">
        <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
        {call.name && <span className="shrink-0 font-mono text-xs text-fg">{call.name}</span>}
        <span className="text-[11px] text-faint">正在准备参数…</span>
      </div>
    )
  }
  const summary = argsSummary(call.args)
  const short = toolLabel(call.name)
  const bad = call.status === 'error'
  return (
    <div className={cx('rounded-md border bg-canvas', bad ? 'border-bad/40' : 'border-line-soft')}>
      <button
        onClick={() => setOpen(!open)}
        title={TOOL_META.get(call.name)}
        className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-hover/50"
      >
        {call.status === 'running' ? (
          <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
        ) : bad ? (
          <X size={13} className="shrink-0 text-bad" />
        ) : (
          <Check size={13} className="shrink-0 text-ok" />
        )}
        <span className="shrink-0 font-mono text-xs text-fg">{call.name}</span>
        {short !== call.name && <span className="shrink-0 text-xs text-muted">{short}</span>}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">{summary}</span>
        <ChevronRight size={12} className={cx('shrink-0 text-faint transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-line-soft px-2.5 py-2">
          <Block title="参数" text={JSON.stringify(call.args ?? {}, null, 2)} />
          {call.result !== undefined ? <Block title={bad ? '错误' : '结果'} text={call.result} bad={bad} /> : call.status === 'running' ? <Busy>执行中…</Busy> : null}
        </div>
      )}
    </div>
  )
}

function Block({ title, text, bad }: { title: string; text: string; bad?: boolean }) {
  const cut = text.length > MAX_BLOCK
  return (
    <div className="space-y-1">
      <div className="text-[11px] text-faint">{title}</div>
      <pre
        className={cx(
          'selectable max-h-64 overflow-auto rounded border border-line-soft bg-panel p-2 font-mono text-[11px] leading-normal break-all whitespace-pre-wrap',
          bad ? 'text-bad' : 'text-[#c9d1d9]'
        )}
      >
        {cut ? text.slice(0, MAX_BLOCK) : text}
      </pre>
      {cut && <div className="text-[11px] text-faint">太长了，只显示前 {MAX_BLOCK.toLocaleString('en-US')} 个字符</div>}
    </div>
  )
}
