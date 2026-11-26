// 模型提供方：OpenAI 兼容的 /chat/completions 和 Anthropic 的 /v1/messages，流式请求和解析。
// 不 import electron：fetch 由主进程注入（Electron net.fetch，跟随系统代理）
import crypto from 'node:crypto'
import type { ProviderKind } from '../types'

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface ProviderConn {
  kind: ProviderKind
  /** 已规范化：不带末尾的 /；openai 不带 /chat/completions，anthropic 不带 /v1 */
  baseUrl: string
  apiKey?: string
}

export interface ToolDef {
  name: string
  description: string
  /** JSON Schema（MCP 工具的 inputSchema） */
  parameters: Record<string, unknown>
}

export interface ConvToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/** 和提供方无关的对话记录，由 runner 从 ChatMessage 转出来，这里再转成各家的格式 */
export type ConvItem =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; reasoning?: string; toolCalls: ConvToolCall[] }
  | { role: 'tool'; callId: string; text: string; isError: boolean }

export interface ChatRequest {
  model: string
  system: string
  items: ConvItem[]
  tools: ToolDef[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export interface StreamHandlers {
  onText?: (delta: string) => void
  onReasoning?: (delta: string) => void
  /** 模型开始调用一个工具（参数还没收完），界面先显示一张卡片 */
  onToolCall?: (name: string) => void
  /** 每收到一段数据都调用（包括工具参数分片、心跳）：runner 用来判断连接是不是卡住了 */
  onActivity?: () => void
}

export interface ParsedToolCall extends ConvToolCall {
  /** 参数不是合法 JSON 对象：不执行，把这句话当结果回给模型让它重来 */
  argsError?: string
}

export interface ChatResult {
  text: string
  reasoning: string
  toolCalls: ParsedToolCall[]
  usage: { input: number; output: number }
  /** openai 的 finish_reason / anthropic 的 stop_reason */
  stopReason?: string
}

/** 提供方或网络的错误；message 里带提供方的原话，直接给用户看 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

const ANTHROPIC_VERSION = '2023-06-01'
const ANTHROPIC_MAX_TOKENS = 8192
const MAX_ERROR_CHARS = 2000

// ---------- 小工具：解析不可信的 JSON ----------

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** 用户常把完整接口地址粘进来（…/v1/messages、…/chat/completions），这里统一去掉 */
export function normalizeBaseUrl(kind: ProviderKind, raw: string): string {
  let u = raw.trim().replace(/\/+$/, '')
  u = kind === 'anthropic' ? u.replace(/\/v1(?:\/messages)?$/i, '') : u.replace(/\/chat\/completions$/i, '')
  let parsed: URL
  try {
    parsed = new URL(u)
  } catch {
    throw new Error('接口地址不是合法的网址')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('接口地址要以 http:// 或 https:// 开头')
  return u.replace(/\/+$/, '')
}

function headers(conn: ProviderConn, stream: boolean, json: boolean): Record<string, string> {
  const h: Record<string, string> = { accept: stream ? 'text/event-stream' : 'application/json' }
  if (json) h['content-type'] = 'application/json'
  if (conn.kind === 'anthropic') {
    h['anthropic-version'] = ANTHROPIC_VERSION
    if (conn.apiKey) h['x-api-key'] = conn.apiKey
  } else if (conn.apiKey) {
    // Ollama 等本地服务不需要 key，不传也行
    h.authorization = `Bearer ${conn.apiKey}`
  }
  return h
}

// ---------- 请求和错误 ----------

function describeNetError(e: unknown): string {
  const err = e as Error & { cause?: unknown }
  const cause = err.cause instanceof Error ? err.cause.message : typeof err.cause === 'string' ? err.cause : ''
  return [err.message, cause].filter(Boolean).join('：') || String(e)
}

function pickMessage(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim()
  const o = obj(v)
  for (const k of ['message', 'msg', 'detail']) {
    const m = o[k]
    if (typeof m === 'string' && m.trim()) return m.trim()
  }
  return undefined
}

/** 尽量取出提供方的原话：{ error: { message } }、{ error: '…' }、{ message }；都不是就给原文 */
function errorDetail(body: string): string {
  const text = body.trim()
  try {
    const j = obj(JSON.parse(text))
    const m = pickMessage(j.error) ?? pickMessage(j)
    if (m) return m
  } catch {
    // 不是 JSON，用原文
  }
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text
}

async function httpError(res: Response): Promise<ProviderError> {
  const body = await res.text().catch(() => '')
  return new ProviderError(`提供方返回 ${res.status}：${errorDetail(body) || res.statusText || '请求失败'}`, res.status)
}

async function request(fetchFn: FetchLike, url: string, init: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetchFn(url, init)
  } catch (e) {
    // 用户按了停止：原样抛出，调用方按中止处理
    if (init.signal?.aborted) throw e
    throw new ProviderError(`网络请求失败：${describeNetError(e)}`)
  }
  if (!res.ok) throw await httpError(res)
  return res
}

/** 逐个产出 SSE 事件的 data（多行 data 按规范用换行拼起来）；event: 行用不上，两家的事件类型都在 JSON 里 */
async function* sseData(res: Response): AsyncGenerator<string> {
  if (!res.body) throw new ProviderError('提供方没有返回内容')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let data: string[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line === '') {
          if (data.length) yield data.join('\n')
          data = []
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''))
        }
      }
      if (done) break
    }
    if (buf.startsWith('data:')) data.push(buf.slice(5).trim())
    if (data.length) yield data.join('\n')
  } finally {
    // 提前结束（出错、中止）时关掉连接
    void reader.cancel().catch(() => {})
  }
}

function parseJson(data: string): Obj | undefined {
  try {
    return obj(JSON.parse(data))
  } catch {
    // 个别服务会夹杂非 JSON 的心跳行，跳过
    return undefined
  }
}

function finishCall(c: { id: string; name: string; args: string }): ParsedToolCall {
  // 少数兼容服务不给 id：自己生成一个，回传工具结果时对得上就行
  const id = c.id || `call_${crypto.randomBytes(6).toString('hex')}`
  const raw = c.args.trim()
  if (!raw) return { id, name: c.name, args: {} }
  try {
    const v: unknown = JSON.parse(raw)
    if (v && typeof v === 'object' && !Array.isArray(v)) return { id, name: c.name, args: v as Obj }
  } catch {
    // 下面统一报
  }
  return { id, name: c.name, args: {}, argsError: `参数不是合法的 JSON 对象，没有执行。收到的参数：${raw.slice(0, 500)}` }
}

// ---------- OpenAI 兼容 ----------

function openaiMessages(system: string, items: ConvItem[]): Obj[] {
  const out: Obj[] = []
  if (system) out.push({ role: 'system', content: system })
  for (const it of items) {
    if (it.role === 'user') {
      out.push({ role: 'user', content: it.text })
    } else if (it.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: it.callId, content: it.text || '（没有输出）' })
    } else {
      const m: Obj = { role: 'assistant', content: it.text || (it.toolCalls.length ? null : '') }
      // DeepSeek、Kimi 的思考模式在工具调用循环里要求回传 reasoning_content；runner 只给当前这一轮带上
      if (it.reasoning) m.reasoning_content = it.reasoning
      if (it.toolCalls.length) {
        m.tool_calls = it.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }))
      }
      out.push(m)
    }
  }
  return out
}

async function streamOpenAI(fetchFn: FetchLike, conn: ProviderConn, req: ChatRequest, h: StreamHandlers): Promise<ChatResult> {
  const body: Obj = {
    model: req.model,
    messages: openaiMessages(req.system, req.items),
    stream: true,
    stream_options: { include_usage: true }
  }
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
  }
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.maxTokens) body.max_tokens = req.maxTokens
  const res = await request(fetchFn, `${conn.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(conn, true, true),
    body: JSON.stringify(body),
    signal: req.signal
  })

  const out: ChatResult = { text: '', reasoning: '', toolCalls: [], usage: { input: 0, output: 0 } }
  const calls = new Map<number, { id: string; name: string; args: string }>()

  const readUsage = (u: unknown) => {
    const o = obj(u)
    if ('prompt_tokens' in o || 'completion_tokens' in o) out.usage = { input: num(o.prompt_tokens), output: num(o.completion_tokens) }
  }
  /** positional：非流式回复里 tool_calls 没有 index，按位置算 */
  const applyDelta = (d: Obj, positional: boolean) => {
    const text = str(d.content)
    if (text) {
      out.text += text
      h.onText?.(text)
    }
    // DeepSeek、通义、硅基流动叫 reasoning_content；OpenRouter、Ollama 叫 reasoning
    const r = str(d.reasoning_content) || str(d.reasoning)
    if (r) {
      out.reasoning += r
      h.onReasoning?.(r)
    }
    const tcs = Array.isArray(d.tool_calls) ? d.tool_calls : []
    tcs.forEach((raw, pos) => {
      const tc = obj(raw)
      const id = str(tc.id)
      let idx: number
      if (positional) idx = pos
      else if (typeof tc.index === 'number') idx = tc.index
      else {
        // 不带 index 的实现：按 id 找，找不到算新的；连 id 也没有就接在上一个后面
        const found = [...calls.entries()].find(([, c]) => id && c.id === id)
        idx = found ? found[0] : id || !calls.size ? calls.size : Math.max(...calls.keys())
      }
      let c = calls.get(idx)
      if (!c) {
        c = { id: '', name: '', args: '' }
        calls.set(idx, c)
      }
      if (id && !c.id) c.id = id
      const fn = obj(tc.function)
      const name = str(fn.name)
      // 有的服务每个分片都重复完整的名字，只取第一次
      if (name && !c.name) {
        c.name = name
        h.onToolCall?.(name)
      }
      if (typeof fn.arguments === 'string') c.args += fn.arguments
      else if (fn.arguments && typeof fn.arguments === 'object') c.args = JSON.stringify(fn.arguments)
    })
  }

  if ((res.headers.get('content-type') ?? '').includes('application/json')) {
    // 不支持流式、直接回整段 JSON 的服务
    const j = obj(await res.json().catch(() => ({})))
    if (j.error) throw new ProviderError(`提供方返回错误：${pickMessage(j.error) ?? JSON.stringify(j.error)}`)
    const choice = obj(Array.isArray(j.choices) ? j.choices[0] : undefined)
    applyDelta(obj(choice.message), true)
    readUsage(j.usage)
    out.stopReason = str(choice.finish_reason) || undefined
  } else {
    for await (const data of sseData(res)) {
      h.onActivity?.()
      if (data.trim() === '[DONE]') break
      const chunk = parseJson(data)
      if (!chunk) continue
      // OpenRouter 等会在流中间发 { error }（例如上游超时）
      if (chunk.error) throw new ProviderError(`提供方返回错误：${pickMessage(chunk.error) ?? JSON.stringify(chunk.error)}`)
      if (chunk.usage) readUsage(chunk.usage)
      const choice = obj(Array.isArray(chunk.choices) ? chunk.choices[0] : undefined)
      // Kimi 把 usage 放在 choice 里
      if (choice.usage) readUsage(choice.usage)
      applyDelta(obj(choice.delta), false)
      if (str(choice.finish_reason)) out.stopReason = str(choice.finish_reason)
    }
  }

  out.toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => c)
    .filter((c) => c.name)
    .map(finishCall)
  return out
}

// ---------- Anthropic ----------

type AnthropicMessage = { role: 'user' | 'assistant'; content: Obj[] }

/** tool_use 的 id 只能是字母、数字、_、-；换过提供方时旧对话里可能有别家的 id（如 Kimi 的 functions.x:0） */
const anthropicId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_')

function anthropicMessages(items: ConvItem[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  const push = (role: AnthropicMessage['role'], blocks: Obj[]) => {
    if (!blocks.length) return
    const last = out[out.length - 1]
    // 要求 user / assistant 交替：相邻同角色的合并（工具结果和紧跟的用户消息合成一条，工具结果在前）
    if (last?.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  for (const it of items) {
    if (it.role === 'user') {
      push('user', it.text ? [{ type: 'text', text: it.text }] : [])
    } else if (it.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: anthropicId(it.callId), content: it.text || '（没有输出）', ...(it.isError ? { is_error: true } : {}) }])
    } else {
      push('assistant', [
        ...(it.text ? [{ type: 'text', text: it.text }] : []),
        ...it.toolCalls.map((c) => ({ type: 'tool_use', id: anthropicId(c.id), name: c.name, input: c.args }))
      ])
    }
  }
  return out
}

async function streamAnthropic(fetchFn: FetchLike, conn: ProviderConn, req: ChatRequest, h: StreamHandlers): Promise<ChatResult> {
  const body: Obj = {
    model: req.model,
    max_tokens: req.maxTokens ?? ANTHROPIC_MAX_TOKENS,
    messages: anthropicMessages(req.items),
    stream: true
  }
  if (req.system) body.system = req.system
  if (req.tools.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  // Claude 的温度范围是 0-1
  if (req.temperature !== undefined) body.temperature = Math.min(1, Math.max(0, req.temperature))
  const res = await request(fetchFn, `${conn.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: headers(conn, true, true),
    body: JSON.stringify(body),
    signal: req.signal
  })

  const out: ChatResult = { text: '', reasoning: '', toolCalls: [], usage: { input: 0, output: 0 } }
  const blocks = new Map<number, { type: string; id: string; name: string; json: string }>()
  for await (const data of sseData(res)) {
    h.onActivity?.()
    const ev = parseJson(data)
    if (!ev) continue
    const index = num(ev.index)
    switch (ev.type) {
      case 'message_start': {
        const u = obj(obj(ev.message).usage)
        // 命中缓存的部分也算输入
        out.usage.input = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens)
        out.usage.output = num(u.output_tokens)
        break
      }
      case 'content_block_start': {
        const b = obj(ev.content_block)
        const type = str(b.type)
        blocks.set(index, { type, id: str(b.id), name: str(b.name), json: '' })
        if (type === 'tool_use' && str(b.name)) h.onToolCall?.(str(b.name))
        if (type === 'text' && str(b.text)) {
          out.text += str(b.text)
          h.onText?.(str(b.text))
        }
        break
      }
      case 'content_block_delta': {
        const d = obj(ev.delta)
        if (d.type === 'text_delta' && str(d.text)) {
          out.text += str(d.text)
          h.onText?.(str(d.text))
        } else if (d.type === 'input_json_delta') {
          const b = blocks.get(index)
          if (b) b.json += str(d.partial_json)
        } else if (d.type === 'thinking_delta' && str(d.thinking)) {
          // 没有开启 extended thinking，正常不会出现；出现了只显示，不回传（回传要带签名）
          out.reasoning += str(d.thinking)
          h.onReasoning?.(str(d.thinking))
        }
        break
      }
      case 'message_delta': {
        const stop = str(obj(ev.delta).stop_reason)
        if (stop) out.stopReason = stop
        const u = obj(ev.usage)
        if ('output_tokens' in u) out.usage.output = num(u.output_tokens)
        break
      }
      case 'error': {
        const err = obj(ev.error)
        throw new ProviderError(`提供方返回错误：${pickMessage(err) ?? data}${str(err.type) ? `（${str(err.type)}）` : ''}`)
      }
    }
  }
  out.toolCalls = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => b)
    .filter((b) => b.type === 'tool_use' && b.name)
    .map((b) => finishCall({ id: b.id, name: b.name, args: b.json }))
  return out
}

// ---------- 对外 ----------

/** 流式请求一次模型回复；中止时抛出 fetch 的 AbortError，调用方看 signal.aborted 判断 */
export function streamChat(fetchFn: FetchLike, conn: ProviderConn, req: ChatRequest, h: StreamHandlers = {}): Promise<ChatResult> {
  return conn.kind === 'anthropic' ? streamAnthropic(fetchFn, conn, req, h) : streamOpenAI(fetchFn, conn, req, h)
}

/** 调提供方的模型列表接口：openai 兼容 GET /models，anthropic GET /v1/models */
export async function listModels(fetchFn: FetchLike, conn: ProviderConn, signal?: AbortSignal): Promise<string[]> {
  const url = conn.kind === 'anthropic' ? `${conn.baseUrl}/v1/models?limit=1000` : `${conn.baseUrl}/models`
  const res = await request(fetchFn, url, { method: 'GET', headers: headers(conn, false, false), signal })
  let j: unknown
  try {
    j = await res.json()
  } catch {
    throw new ProviderError('模型列表不是 JSON，这个地址可能不对')
  }
  const o = obj(j)
  const list: unknown[] = Array.isArray(o.data) ? o.data : Array.isArray(o.models) ? o.models : Array.isArray(j) ? j : []
  const ids = list.map((m) => (typeof m === 'string' ? m : str(obj(m).id) || str(obj(m).name))).filter(Boolean)
  return [...new Set(ids)].sort()
}
