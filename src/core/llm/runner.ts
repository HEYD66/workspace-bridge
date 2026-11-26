// 内置 AI 的执行循环：在进程内连一个 MCP 客户端，让模型用和外部 AI 完全相同的工具干活
// （急停、活动流都由 MCP 服务那一侧生效，这里不重复判断）
import crypto from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentModel, ChatMessage, ChatSession, ChatToolCall } from '../types'
import { ProviderError, streamChat, type ConvItem, type FetchLike, type ProviderConn, type ToolDef } from './providers'

export const DEFAULT_MAX_STEPS = 30
/** 单个工具结果放进上下文的上限，大文件让模型分段读 */
const MAX_TOOL_RESULT_CHARS = 20 * 1024
/** 上下文总长度（字符数，粗略对应 128K token 模型的安全范围），超出先丢最早的轮次 */
const MAX_CONTEXT_CHARS = 150_000
/** 当前这一轮自己都太长时，最近这几个工具结果保留原文，更早的换成一句话 */
const KEEP_RECENT_RESULTS = 6
/** 流式回复多久没有任何数据算卡死；本地模型加载、思考模型首字都可能很慢，给宽一点 */
const STALL_MS = 3 * 60_000
/** 单次工具调用的超时（SDK 默认 60 秒，大目录搜索可能更久） */
const TOOL_TIMEOUT_MS = 10 * 60_000
const CLIENT_NAME = 'workspace-bridge-builtin'
const CLIENT_VERSION = '0.4.0'

export interface RunDeps {
  fetch: FetchLike
  conn: ProviderConn
  model: AgentModel
  createServer: () => McpServer
  /** 每次调用模型前检查，返回原因就停下（吊销、全部停下）；被中止时也用它说明原因 */
  shouldStop: () => string | undefined
  /** 流式进度（节流由调用方做） */
  onProgress: () => void
  /** 一轮（一次模型回复 + 它要的工具调用）结束，调用方落盘 */
  onStep: () => void
  /** 取走「需要重建 MCP 服务」标记（bridge 'reset'：工作区、职位、工具开关等变了） */
  takeReset: () => boolean
}

export type RunOutcome = { kind: 'done' } | { kind: 'stopped' } | { kind: 'error'; message: string }

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)) || '未知错误'

function newAssistant(): ChatMessage {
  return { id: crypto.randomUUID(), role: 'assistant', content: '', ts: Date.now() }
}

/** 截断超长文本；【通知】部分（MCP 服务附在结果末尾）单独保留，不然大文件会把新任务通知挤掉 */
function clipResult(parts: string[]): string {
  const notices = parts.filter((p) => p.startsWith('【通知】'))
  const body = parts.filter((p) => !p.startsWith('【通知】')).join('\n\n')
  const clipped =
    body.length > MAX_TOOL_RESULT_CHARS
      ? `${body.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[结果太长，后面还有 ${body.length - MAX_TOOL_RESULT_CHARS} 字没有放进来；文件请用 read_file 的 offset/limit 分段读]`
      : body
  return [clipped, ...notices].filter(Boolean).join('\n\n')
}

/** CallToolResult 转成给模型看的文本（结构来自 SDK，按不可信数据解析） */
function resultText(r: unknown): { text: string; isError: boolean } {
  const o = obj(r)
  const content = Array.isArray(o.content) ? o.content : []
  const parts = content.map((raw) => {
    const p = obj(raw)
    if (p.type === 'text') return str(p.text)
    if (p.type === 'image') return `[图片 ${str(p.mimeType)}]`
    if (p.type === 'resource') {
      const res = obj(p.resource)
      return str(res.text) || `[资源 ${str(res.uri)}]`
    }
    if (p.type === 'resource_link') return `[链接 ${str(p.uri)}]`
    return `[${str(p.type) || '未知内容'}]`
  })
  return { text: clipResult(parts), isError: o.isError === true }
}

/** MCP 工具 → 模型的函数定义；inputSchema 原样用，只去掉个别兼容服务不认的 $schema */
function toToolDef(t: { name: string; title?: string; description?: string; inputSchema: unknown }): ToolDef {
  const parameters = { ...obj(t.inputSchema) }
  delete parameters.$schema
  return { name: t.name, description: t.description ?? t.title ?? '', parameters: { type: 'object', properties: {}, ...parameters } }
}

function buildSystem(instructions: string | undefined, extra: string | undefined): string {
  const parts = [instructions?.trim() || '你连接的是 Workspace Bridge。']
  // 外部 AI 的说明默认对方在别的聊天界面里；内置 AI 的对话就在工作台，补一句让它知道用户能直接看到
  parts.push(
    '\n## 对话方式\n你是用户在 Workspace Bridge 工作台里直接对话的内置 AI。用户的消息就是用户本人的指示；以【通知】开头的是系统转来的消息。用上面的工具干活，做完用中文简要说明结果。'
  )
  if (extra?.trim()) parts.push(`\n## 用户给你的额外说明\n${extra.trim()}`)
  return parts.join('\n')
}

// ---------- 上下文 ----------

/**
 * 一轮 = 一条用户消息和它后面的回复、工具调用。
 * reasoning 只给最后一轮带上：DeepSeek / Kimi 的思考模式在工具循环里要求回传，更早轮次的回传反而可能报错
 */
function toItems(turn: ChatMessage[], withReasoning: boolean): ConvItem[] {
  const items: ConvItem[] = []
  for (const m of turn) {
    if (m.role === 'user') {
      items.push({ role: 'user', text: m.content })
      continue
    }
    const calls = m.toolCalls ?? []
    // 出错、停止时留下的空回复不放进上下文
    if (!m.content && !calls.length) continue
    items.push({
      role: 'assistant',
      text: m.content,
      ...(withReasoning && m.reasoning ? { reasoning: m.reasoning } : {}),
      toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args }))
    })
    // 两家接口都要求每个工具调用都有对应结果，停止时没执行的也补一句
    for (const c of calls) items.push({ role: 'tool', callId: c.id, text: c.result ?? '（没有执行）', isError: c.status !== 'ok' })
  }
  return items
}

function itemSize(it: ConvItem): number {
  if (it.role === 'assistant') return it.text.length + (it.reasoning?.length ?? 0) + JSON.stringify(it.toolCalls).length
  return it.text.length
}

const OMITTED = '（较早的工具结果已省略，需要时重新调用）'

/** 历史太长时丢最早的轮次；最后一轮总是保留，它自己太长就把较早的工具结果换成一句话 */
export function buildContext(messages: ChatMessage[]): { items: ConvItem[]; dropped: number } {
  const turns: ChatMessage[][] = []
  for (const m of messages) {
    if (m.role === 'user') turns.push([m])
    // 第一条用户消息之前的回复（文件被手改过）没法放进上下文，丢掉
    else if (turns.length) turns[turns.length - 1].push(m)
  }
  if (!turns.length) return { items: [], dropped: 0 }
  const converted = turns.map((t, i) => toItems(t, i === turns.length - 1))
  const sizeOf = (items: ConvItem[]) => items.reduce((n, it) => n + itemSize(it), 0)

  let total = 0
  let start = converted.length
  while (start > 0) {
    const s = sizeOf(converted[start - 1])
    if (start < converted.length && total + s > MAX_CONTEXT_CHARS) break
    total += s
    start--
  }
  const items = converted.slice(start).flat()
  if (total > MAX_CONTEXT_CHARS) {
    const tools = items.filter((it): it is Extract<ConvItem, { role: 'tool' }> => it.role === 'tool')
    for (const it of tools.slice(0, Math.max(0, tools.length - KEEP_RECENT_RESULTS))) {
      if (total <= MAX_CONTEXT_CHARS) break
      if (it.text.length <= OMITTED.length) continue
      total -= it.text.length - OMITTED.length
      it.text = OMITTED
    }
  }
  return { items, dropped: start }
}

// ---------- 卡死检测 ----------

/** 外层中止（用户按停止）原样传下去；流式回复太久没有数据时自己中止，报成提供方错误 */
async function withStallGuard<T>(outer: AbortSignal, fn: (signal: AbortSignal, touch: () => void) => Promise<T>): Promise<T> {
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  if (outer.aborted) ac.abort()
  else outer.addEventListener('abort', onAbort, { once: true })
  let stalled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const touch = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = true
      ac.abort()
    }, STALL_MS)
  }
  touch()
  try {
    return await fn(ac.signal, touch)
  } catch (e) {
    if (stalled && !outer.aborted) throw new ProviderError(`模型超过 ${STALL_MS / 60_000} 分钟没有任何输出，已断开。可以回复「继续」重试`)
    throw e
  } finally {
    clearTimeout(timer)
    outer.removeEventListener('abort', onAbort)
  }
}

// ---------- 执行 ----------

interface Mcp {
  client: Client
  server: McpServer
  tools: ToolDef[]
  system: string
}

/** 在进程内连一个 MCP 客户端；工具列表和说明在握手时定下，和外部 AI 一样 */
async function openMcp(deps: RunDeps, signal: AbortSignal): Promise<Mcp> {
  const server = deps.createServer()
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION })
  try {
    await client.connect(clientSide)
    const tools = (await client.listTools(undefined, { signal })).tools.map(toToolDef)
    return { client, server, tools, system: buildSystem(client.getInstructions(), deps.model.systemPrompt) }
  } catch (e) {
    await closeMcp({ client, server })
    throw e
  }
}

async function closeMcp(m: Pick<Mcp, 'client' | 'server'> | undefined): Promise<void> {
  await m?.client.close().catch(() => {})
  await m?.server.close().catch(() => {})
}

/**
 * 跑一次对话：最后一条用户消息已经在 session.messages 里。
 * 直接改 session（追加回复、累计用量），不改 status，由调用方根据返回值设置。不抛错。
 */
export async function runChat(session: ChatSession, deps: RunDeps, signal: AbortSignal): Promise<RunOutcome> {
  let mcp: Mcp | undefined
  let current: ChatMessage | undefined

  const annotate = (message: string) => {
    if (!current) {
      current = newAssistant()
      session.messages.push(current)
    }
    current.error = message
  }

  try {
    mcp = await openMcp(deps, signal)
    const maxSteps = deps.model.maxSteps ?? DEFAULT_MAX_STEPS

    for (let round = 0; ; round++) {
      const reason = deps.shouldStop()
      if (reason) {
        annotate(reason)
        return { kind: 'stopped' }
      }
      // 配置变了：外部 AI 会被断开重连，这里在两轮之间重建，拿新的工具列表、说明和默认工作区。
      // 一轮之内仍用旧服务
      if (deps.takeReset()) {
        await closeMcp(mcp)
        mcp = undefined
        mcp = await openMcp(deps, signal)
      }
      // 下面的回调里 TS 不保留 mcp 的非空收窄，取一个局部常量
      const live = mcp
      const { items, dropped } = buildContext(session.messages)
      const system = dropped ? `${live.system}\n\n（更早的 ${dropped} 轮对话太长，已从上下文里省略）` : live.system

      const msg = newAssistant()
      current = msg
      session.messages.push(msg)
      deps.onProgress()

      const result = await withStallGuard(signal, (reqSignal, touch) =>
        streamChat(
          deps.fetch,
          deps.conn,
          { model: deps.model.model, system, items, tools: live.tools, temperature: deps.model.temperature, signal: reqSignal },
          {
            onText: (d) => {
              msg.content += d
              deps.onProgress()
            },
            onReasoning: (d) => {
              msg.reasoning = (msg.reasoning ?? '') + d
              deps.onProgress()
            },
            // 参数还在流式输出时先显示一张卡片，收完后整体替换
            onToolCall: (name) => {
              const list = (msg.toolCalls ??= [])
              list.push({ id: `pending-${list.length}`, name, args: {}, status: 'running' })
              deps.onProgress()
            },
            onActivity: touch
          }
        )
      )

      msg.content = result.text
      if (result.reasoning) msg.reasoning = result.reasoning
      else delete msg.reasoning
      const u = session.usage ?? { input: 0, output: 0 }
      session.usage = { input: u.input + result.usage.input, output: u.output + result.usage.output }

      if (!result.toolCalls.length) {
        delete msg.toolCalls
        deps.onStep()
        return { kind: 'done' }
      }

      const calls = result.toolCalls.map((c): ChatToolCall => ({ id: c.id, name: c.name, args: c.args, status: 'running' }))
      msg.toolCalls = calls
      deps.onProgress()
      for (const [i, c] of result.toolCalls.entries()) {
        const tc = calls[i]
        if (signal.aborted) break
        if (c.argsError) {
          tc.status = 'error'
          tc.result = c.argsError
          continue
        }
        try {
          const r: unknown = await live.client.callTool({ name: c.name, arguments: c.args }, undefined, {
            signal,
            timeout: TOOL_TIMEOUT_MS,
            resetTimeoutOnProgress: true
          })
          const { text, isError } = resultText(r)
          tc.result = text
          tc.status = isError ? 'error' : 'ok'
        } catch (e) {
          tc.status = 'error'
          if (signal.aborted) {
            // 服务端不会因为客户端放弃而回滚，这一步可能已经生效
            tc.result = '用户按了停止；这一步可能已经执行了一部分，结果未知'
            throw e
          }
          // 超时、连接断开等：告诉模型这一步失败了，让它自己决定怎么办
          tc.result = `工具调用失败：${errorText(e)}`
        }
        deps.onProgress()
      }
      deps.onStep()
      if (signal.aborted) throw new Error('aborted')

      if (round + 1 >= maxSteps) {
        msg.error = `已经连续调用了 ${maxSteps} 轮工具，先停下了。回复「继续」可以让它接着做，也可以在模型设置里调高「最多轮数」`
        return { kind: 'done' }
      }
    }
  } catch (e) {
    if (signal.aborted) {
      if (current) {
        // 参数还没收完的占位卡片没有对应的调用，去掉；收完但没轮到的标成没执行
        const kept = (current.toolCalls ?? []).filter((c) => !c.id.startsWith('pending-'))
        for (const c of kept) {
          if (c.status !== 'running') continue
          c.status = 'error'
          c.result = '用户按了停止，没有执行'
        }
        if (kept.length) current.toolCalls = kept
        else delete current.toolCalls
      }
      annotate(deps.shouldStop() ?? '已停止')
      return { kind: 'stopped' }
    }
    // 提供方的原话（401、余额不足等）在 ProviderError.message 里，原样给用户看
    const message = errorText(e)
    if (current) {
      for (const c of current.toolCalls ?? []) {
        if (c.status === 'running') {
          c.status = 'error'
          c.result ??= '没有执行'
        }
      }
      current.toolCalls = current.toolCalls?.filter((c) => !c.id.startsWith('pending-'))
      if (!current.toolCalls?.length) delete current.toolCalls
    }
    annotate(message)
    return { kind: 'error', message }
  } finally {
    await closeMcp(mcp)
  }
}
