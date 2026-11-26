// 内置 AI 的总入口：提供方和模型绑定的增删改、对话会话（内存 + 落盘）、停止、自动接活。
// 主进程只和这里打交道；不 import electron，fetch 和加密由主进程注入
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Bridge } from '../bridge'
import type { AgentModel, BridgeState, ChatMessage, ChatSession, ModelProviderView, ProviderInput } from '../types'
import { listModels, streamChat, type FetchLike, type ProviderConn } from './providers'
import { runChat, type RunOutcome } from './runner'
import { ChatFiles, LlmStore, type SecretBox } from './store'

/** 内置 AI 需要的宿主能力；由 bridgeHost() 从 Bridge 取，这样这里不依赖 Bridge 的内部 */
export interface LlmHost {
  /** 和 HTTP 会话一样的 MCP 服务（急停、活动流都生效） */
  createAgentServer(agentId: string): McpServer
  agentExists(agentId: string): boolean
  isPaused(): boolean
  /** 有新任务、审查结果等通知；返回取消订阅 */
  onNotice(cb: (agentId: string, text: string) => void): () => void
  /** 急停、吊销等状态变化；返回取消订阅 */
  onStateChange(cb: () => void): () => void
  /** 这些 AI 的 MCP 服务要重建（工作区、职位、工具开关、token 变了，就是外部 AI 会被断开的那些时候）；返回取消订阅 */
  onReset(cb: (agentIds: string[]) => void): () => void
}

export function bridgeHost(bridge: Bridge): LlmHost {
  // 'state' 事件很频繁，急停状态从事件里缓存，不每次调 getState()
  let paused = bridge.getState().paused
  const onState = (s: BridgeState) => {
    paused = s.paused
  }
  bridge.on('state', onState)
  return {
    createAgentServer: (id) => bridge.createAgentServer(id),
    agentExists: (id) => !!bridge.config.getAgent(id),
    isPaused: () => paused,
    onNotice: (cb) => {
      bridge.on('notice', cb)
      return () => bridge.off('notice', cb)
    },
    onStateChange: (cb) => {
      bridge.on('state', cb)
      return () => bridge.off('state', cb)
    },
    onReset: (cb) => {
      // 参数来自 ws-core 的 'reset' 事件；不是数组时按「全部重建」处理，宁可多建一次
      const listener = (ids: unknown) => cb(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : ['*'])
      bridge.on('reset', listener)
      return () => bridge.off('reset', listener)
    }
  }
}

export interface LlmServiceOptions {
  dataDir: string
  host: LlmHost
  /** Electron 的 net.fetch（跟随系统代理）；headless 时用全局 fetch */
  fetch: FetchLike
  /** Electron safeStorage；不传时 apiKey 明文存 */
  secrets?: SecretBox
}

/** 推给界面的节流间隔：流式输出每个字都推会把 IPC 打满 */
const PUSH_MS = 50
const MAX_INPUT_CHARS = 100_000
/** 对话文件里最多留多少条消息，超出从最早的一轮开始丢（上下文本来也放不下） */
const MAX_SAVED_MESSAGES = 500
const LIST_MODELS_TIMEOUT_MS = 30_000
/** 思考模型首字可能很慢 */
const TEST_TIMEOUT_MS = 60_000
/** 两个开了自动接活的 AI 互相派活、退回可能来回循环：10 分钟内最多自动开始 12 次 */
const AUTO_WINDOW_MS = 10 * 60_000
const MAX_AUTO_RUNS = 12
const MAX_PENDING_NOTICES = 20

interface Live {
  session: ChatSession
  abort?: AbortController
  run?: Promise<void>
  /** stopChat、急停、删提供方时写上原因，runner 被中止时显示它 */
  stopReason?: string
  timer?: ReturnType<typeof setTimeout>
  /** 正在跑时收到的通知，跑完再处理 */
  pending: string[]
  autoRuns: number[]
  /** 自动接活被限流后只提示一次 */
  autoLimited: boolean
  /** 跑的时候收到 'reset'：下一轮开始前重建 MCP 服务 */
  reset: boolean
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)) || '未知错误'

/** 超时自己中止；外面看到的是一句中文，不是 AbortError */
async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  try {
    return await fn(ac.signal)
  } catch (e) {
    if (ac.signal.aborted) throw new Error(`${ms / 1000} 秒内没有响应，检查地址、网络或代理`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 太长时从某一条用户消息处切开，保证留下的都是完整的轮次 */
function trimHistory(s: ChatSession): void {
  if (s.messages.length <= MAX_SAVED_MESSAGES) return
  let cut = s.messages.length - MAX_SAVED_MESSAGES
  while (cut < s.messages.length && s.messages[cut].role !== 'user') cut++
  s.messages = s.messages.slice(cut)
}

/**
 * 事件：'chat' (ChatSession) —— 对话有进度（流式时约 50 ms 一次）；
 * 'changed' ('providers') —— 提供方或模型绑定变了。
 * 'chat' 的参数是活的对象，监听方要立刻用掉（主进程通过 IPC 发出去时会复制），不要留着引用
 */
export class LlmService extends EventEmitter {
  private readonly store: LlmStore
  private readonly chats: ChatFiles
  private readonly live = new Map<string, Live>()
  private readonly forgetting = new Set<string>()
  private readonly unsubscribe: (() => void)[] = []
  private closed = false

  constructor(private readonly opts: LlmServiceOptions) {
    super()
    this.store = new LlmStore(path.join(opts.dataDir, 'llm.json'), opts.secrets, () => this.emit('changed', 'providers'))
    this.chats = new ChatFiles(path.join(opts.dataDir, 'chats'))
    this.unsubscribe.push(
      opts.host.onNotice((id, text) => this.onNotice(id, text)),
      opts.host.onStateChange(() => this.onHostState()),
      opts.host.onReset((ids) => this.onReset(ids))
    )
    // 应用没开着时不会吊销 AI，但配置文件可能被手改过：启动时清一次
    this.onHostState()
  }

  // ---------- 提供方 ----------

  listProviders(): ModelProviderView[] {
    return this.store.listProviders()
  }

  saveProvider(input: ProviderInput): ModelProviderView {
    return this.store.saveProvider(input)
  }

  /** 用到它的 AI 解除绑定，正在跑的停下 */
  async removeProvider(id: string): Promise<void> {
    const affected = Object.entries(this.store.agentModels())
      .filter(([, m]) => m.providerId === id)
      .map(([agentId]) => agentId)
    await Promise.all(affected.map((agentId) => this.stop(agentId, '模型提供方已被删除')))
    this.store.removeProvider(id)
  }

  private connOf(providerId: string): ProviderConn {
    const p = this.store.getProvider(providerId)
    if (!p) throw new Error('模型提供方不存在，可能已被删除')
    return { kind: p.kind, baseUrl: p.baseUrl, apiKey: this.store.apiKeyOf(p) }
  }

  async fetchProviderModels(id: string): Promise<string[]> {
    const conn = this.connOf(id)
    return withTimeout(LIST_MODELS_TIMEOUT_MS, (signal) => listModels(this.opts.fetch, conn, signal))
  }

  /** 发一句很短的话试连；不抛错，失败时 message 是提供方的原话 */
  async testProvider(id: string, model: string): Promise<{ ok: boolean; message: string; latencyMs: number }> {
    const t0 = Date.now()
    try {
      const conn = this.connOf(id)
      const m = String(model ?? '').trim()
      if (!m) throw new Error('请先填写模型名')
      const r = await withTimeout(TEST_TIMEOUT_MS, (signal) =>
        streamChat(this.opts.fetch, conn, {
          model: m,
          system: '',
          items: [{ role: 'user', text: '你好，请只回复一个字：好' }],
          tools: [],
          signal,
          // anthropic 必须给 max_tokens；openai 不给，新版 OpenAI 模型不认 max_tokens 这个参数
          ...(conn.kind === 'anthropic' ? { maxTokens: 64 } : {})
        })
      )
      const reply = r.text.trim() || (r.reasoning.trim() ? '（只返回了推理过程）' : '（没有文字回复）')
      return { ok: true, message: `连上了，回复：${reply.slice(0, 80)}`, latencyMs: Date.now() - t0 }
    } catch (e) {
      return { ok: false, message: errorText(e), latencyMs: Date.now() - t0 }
    }
  }

  // ---------- 备份恢复（不含 API Key） ----------

  exportForBackup(): ReturnType<LlmStore['exportForBackup']> {
    return this.store.exportForBackup()
  }

  importFromBackup(input: { providers?: unknown; agents?: unknown }): ReturnType<LlmStore['importFromBackup']> {
    return this.store.importFromBackup(input, (id) => this.opts.host.agentExists(id))
  }

  // ---------- 模型绑定 ----------

  /** 已吊销的 AI 不在里面 */
  listAgentModels(): Record<string, AgentModel> {
    const out: Record<string, AgentModel> = {}
    for (const [id, m] of Object.entries(this.store.agentModels())) if (this.opts.host.agentExists(id)) out[id] = m
    return out
  }

  getAgentModel(agentId: string): AgentModel | null {
    return this.opts.host.agentExists(agentId) ? (this.store.getAgentModel(agentId) ?? null) : null
  }

  /** null 解除绑定（正在跑的停下）；改模型时正在跑的这次用旧设置跑完，下一次生效 */
  async setAgentModel(agentId: string, model: AgentModel | null): Promise<void> {
    if (!this.opts.host.agentExists(agentId)) throw new Error('AI 不存在，可能已被吊销')
    if (model === null) await this.stop(agentId, '模型绑定已解除')
    this.store.setAgentModel(agentId, model)
  }

  // ---------- 对话 ----------

  private liveOf(agentId: string): Live {
    let l = this.live.get(agentId)
    if (!l) {
      if (!ChatFiles.validId(agentId)) throw new Error('AI id 不合法')
      const saved = this.chats.load(agentId)
      l = {
        session: { agentId, status: 'idle', messages: saved.messages, ...(saved.usage ? { usage: saved.usage } : {}) },
        pending: [],
        autoRuns: [],
        autoLimited: false,
        reset: false
      }
      this.live.set(agentId, l)
    }
    return l
  }

  getChat(agentId: string): ChatSession {
    return this.liveOf(agentId).session
  }

  /** 立刻返回，后台执行；开不了头（没绑模型、Key 解不开、正在跑）时抛错，界面把输入还给用户 */
  sendChat(agentId: string, text: string): void {
    const t = String(text ?? '').trim()
    if (!t) throw new Error('消息不能为空')
    if (t.length > MAX_INPUT_CHARS) throw new Error(`消息太长（最多 ${MAX_INPUT_CHARS} 字），大段内容请放进文件让它读`)
    if (!this.opts.host.agentExists(agentId)) throw new Error('AI 不存在，可能已被吊销')
    const live = this.liveOf(agentId)
    if (live.abort) throw new Error('它还在回复，先停下或等它做完')
    this.start(agentId, live, t)
  }

  async stopChat(agentId: string): Promise<void> {
    await this.stop(agentId, '已停止')
  }

  async clearChat(agentId: string): Promise<void> {
    await this.stop(agentId, '已停止')
    const live = this.liveOf(agentId)
    live.session.messages = []
    live.session.status = 'idle'
    delete live.session.error
    delete live.session.usage
    live.pending = []
    this.chats.remove(agentId)
    this.push(live, true)
  }

  /** 应用退出前调用：停下所有对话并落盘 */
  async close(): Promise<void> {
    this.closed = true
    for (const off of this.unsubscribe.splice(0)) off()
    await Promise.all([...this.live.keys()].map((id) => this.stop(id, '应用已退出，对话停下了')))
    for (const l of this.live.values()) clearTimeout(l.timer)
  }

  // ---------- 内部 ----------

  private stopReasonOf(agentId: string, live: Live): string | undefined {
    if (live.stopReason) return live.stopReason
    if (this.opts.host.isPaused()) return '用户按了全部停下'
    if (!this.opts.host.agentExists(agentId)) return '这个 AI 已被吊销'
    if (!this.store.getAgentModel(agentId)) return '模型绑定已解除'
    return undefined
  }

  private async stop(agentId: string, reason: string): Promise<void> {
    const live = this.live.get(agentId)
    if (!live?.abort) return
    live.stopReason = reason
    live.pending = []
    live.abort.abort()
    await live.run
  }

  /** 推给界面：流式进度节流，开始和结束立刻推 */
  private push(live: Live, now = false): void {
    if (now) {
      clearTimeout(live.timer)
      live.timer = undefined
      this.emit('chat', live.session)
      return
    }
    if (live.timer) return
    live.timer = setTimeout(() => {
      live.timer = undefined
      this.emit('chat', live.session)
    }, PUSH_MS)
  }

  private save(agentId: string, live: Live): void {
    // 吊销后不再写回，免得 forget 删掉的文件又出现
    if (this.forgetting.has(agentId) || !this.opts.host.agentExists(agentId)) return
    try {
      this.chats.save(agentId, { messages: live.session.messages, ...(live.session.usage ? { usage: live.session.usage } : {}) })
    } catch {
      // 磁盘满等：对话还在内存里，下一轮再试
    }
  }

  private start(agentId: string, live: Live, text: string): void {
    const model = this.store.getAgentModel(agentId)
    if (!model) throw new Error('这个 AI 还没有绑定模型')
    // Key 解不开、提供方被删时在这里抛错，不留下一条孤零零的用户消息
    const conn = this.connOf(model.providerId)
    trimHistory(live.session)
    const msg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: text, ts: Date.now() }
    live.session.messages.push(msg)
    live.session.status = 'running'
    delete live.session.error
    const ac = new AbortController()
    live.abort = ac
    live.stopReason = undefined
    this.save(agentId, live)
    this.push(live, true)
    live.run = this.execute(agentId, live, model, conn, ac)
  }

  private async execute(agentId: string, live: Live, model: AgentModel, conn: ProviderConn, ac: AbortController): Promise<void> {
    let outcome: RunOutcome
    try {
      outcome = await runChat(
        live.session,
        {
          fetch: this.opts.fetch,
          conn,
          model,
          createServer: () => this.opts.host.createAgentServer(agentId),
          shouldStop: () => this.stopReasonOf(agentId, live),
          takeReset: () => {
            const r = live.reset
            live.reset = false
            return r
          },
          onProgress: () => this.push(live),
          onStep: () => this.save(agentId, live)
        },
        ac.signal
      )
    } catch (e) {
      // runChat 自己不抛错，这里兜底
      outcome = { kind: 'error', message: errorText(e) }
    }
    live.abort = undefined
    live.run = undefined
    live.session.status = outcome.kind === 'error' ? 'error' : 'idle'
    if (outcome.kind === 'error') live.session.error = outcome.message
    this.save(agentId, live)
    this.push(live, true)

    // 跑的时候来的通知：正常做完才接着处理；用户停下或出错就不自动重来
    const pending = live.pending.splice(0)
    if (outcome.kind === 'done' && pending.length) this.autoStart(agentId, live, pending)
  }

  private onNotice(agentId: string, text: string): void {
    if (this.closed || this.opts.host.isPaused()) return
    if (!this.store.getAgentModel(agentId)?.autoTasks || !this.opts.host.agentExists(agentId)) return
    const live = this.liveOf(agentId)
    if (live.abort) {
      // 正在跑：通知也会附在它下一个工具结果的【通知】里，这里留一份，防止它在那之前就做完了
      live.pending.push(text)
      if (live.pending.length > MAX_PENDING_NOTICES) live.pending.splice(0, live.pending.length - MAX_PENDING_NOTICES)
      return
    }
    this.autoStart(agentId, live, [text])
  }

  private autoStart(agentId: string, live: Live, notices: string[]): void {
    if (this.closed || this.opts.host.isPaused() || !this.store.getAgentModel(agentId)?.autoTasks) return
    const now = Date.now()
    live.autoRuns = live.autoRuns.filter((t) => now - t < AUTO_WINDOW_MS)
    if (live.autoRuns.length >= MAX_AUTO_RUNS) {
      if (!live.autoLimited) {
        live.autoLimited = true
        live.session.messages.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: '',
          error: `10 分钟内已经自动接活 ${MAX_AUTO_RUNS} 次，先不自动开始了（可能是几个 AI 在来回派活）。新通知会在你下次发消息后它调用工具时看到`,
          ts: now
        })
        this.save(agentId, live)
        this.push(live, true)
      }
      return
    }
    live.autoRuns.push(now)
    live.autoLimited = false
    // 界面按【通知】开头识别成通知条（和 ui-tools 约定）
    const text = `【通知】\n${notices.map((n) => `- ${n}`).join('\n')}\n请处理。`
    try {
      this.start(agentId, live, text)
    } catch (e) {
      // 提供方被删、Key 解不开：记一条错误，用户打开对话就能看到
      live.session.messages.push({ id: crypto.randomUUID(), role: 'assistant', content: '', error: `自动接活没能开始：${errorText(e)}`, ts: now })
      live.session.status = 'error'
      live.session.error = errorText(e)
      this.save(agentId, live)
      this.push(live, true)
    }
  }

  /** 只标记正在跑的：空闲的 AI 下次开始对话本来就会新建 MCP 服务 */
  private onReset(agentIds: string[]): void {
    const all = agentIds.includes('*')
    for (const [id, l] of this.live) if (l.abort && (all || agentIds.includes(id))) l.reset = true
  }

  /** 急停时停下所有对话；AI 被吊销时停下并删掉它的绑定和对话 */
  private onHostState(): void {
    if (this.closed) return
    if (this.opts.host.isPaused()) {
      for (const [id, l] of this.live) if (l.abort) void this.stop(id, '用户按了全部停下')
    }
    const gone = new Set<string>()
    for (const id of Object.keys(this.store.agentModels())) if (!this.opts.host.agentExists(id)) gone.add(id)
    for (const id of this.live.keys()) if (!this.opts.host.agentExists(id)) gone.add(id)
    for (const id of gone) void this.forget(id)
  }

  private async forget(agentId: string): Promise<void> {
    if (this.forgetting.has(agentId)) return
    this.forgetting.add(agentId)
    try {
      await this.stop(agentId, '这个 AI 已被吊销')
      const l = this.live.get(agentId)
      if (l) clearTimeout(l.timer)
      this.live.delete(agentId)
      if (ChatFiles.validId(agentId)) this.chats.remove(agentId)
      if (this.store.getAgentModel(agentId)) this.store.setAgentModel(agentId, null)
    } catch {
      // 删文件失败不影响别的 AI
    } finally {
      this.forgetting.delete(agentId)
    }
  }
}
