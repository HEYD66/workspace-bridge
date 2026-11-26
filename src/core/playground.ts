// 工具试用台：在主进程里用某个 AI 的 token 连本机 MCP 地址，手动列工具、调工具。
// 走的是真实的 HTTP 鉴权，审计和活动流也由服务端照常记录，和外部 AI 调用完全一样
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { pickTarget, type ConnectSource } from '../shared/connectGuide'

export interface PlaygroundTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; title?: string }
}

export interface PlaygroundCallResult {
  isError: boolean
  /** 服务端返回的 content，原样 */
  content: unknown[]
  structuredContent?: unknown
  durationMs: number
  /** 协议层的错误（工具不存在、参数校验没过、连不上），不是工具自己返回的 isError */
  protocolError?: string
}

export interface PlaygroundOptions {
  /** 取某个 AI 的接入信息；AI 不存在时抛错（bridge.connectionInfo 就是这样） */
  connectionInfo: (agentId: string) => ConnectSource
  /** 空闲多久关掉客户端，默认 5 分钟 */
  idleMs?: number
  /** 单次调用最长等多久，默认 10 分钟 */
  callTimeoutMs?: number
}

interface Entry {
  token: string
  client: Client
  transport: StreamableHTTPClientTransport
  timer?: NodeJS.Timeout
}

export const PLAYGROUND_CLIENT_NAME = 'workspace-bridge-playground'
const IDLE_MS = 5 * 60_000
const CALL_TIMEOUT_MS = 10 * 60_000

/**
 * 会话没了（服务重启、过期被清掉）或根本没连上：请求肯定没执行，丢掉客户端重连再试一次是安全的。
 * 连接中途断开（ECONNRESET 等）不重试：写操作可能已经执行过了
 */
function isConnectionLost(e: unknown): boolean {
  if (e instanceof StreamableHTTPError) return e.code === 404 || e.code === 400
  const err = e as { message?: string; cause?: { code?: string } }
  if (err?.cause?.code === 'ECONNREFUSED') return true
  return /not connected|ECONNREFUSED|会话不存在|会话已被关闭|Mcp-Session-Id/i.test(err?.message ?? '')
}

export class Playground {
  private readonly entries = new Map<string, Entry>()
  private readonly pending = new Map<string, Promise<Entry>>()
  private readonly idleMs: number
  private readonly callTimeoutMs: number

  constructor(private readonly opts: PlaygroundOptions) {
    this.idleMs = opts.idleMs ?? IDLE_MS
    this.callTimeoutMs = opts.callTimeoutMs ?? CALL_TIMEOUT_MS
  }

  async listTools(agentId: string): Promise<PlaygroundTool[]> {
    return this.withClient(agentId, async (c) => {
      const out: PlaygroundTool[] = []
      let cursor: string | undefined
      do {
        const r = await c.listTools(cursor ? { cursor } : undefined)
        for (const t of r.tools) {
          out.push({
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            inputSchema: t.inputSchema as Record<string, unknown>,
            ...(t.annotations ? { annotations: t.annotations } : {})
          })
        }
        cursor = r.nextCursor
      } while (cursor)
      return out
    })
  }

  async callTool(agentId: string, name: string, args: Record<string, unknown>): Promise<PlaygroundCallResult> {
    const started = Date.now()
    try {
      const r = await this.withClient(agentId, (c) =>
        c.callTool({ name, arguments: args ?? {} }, undefined, { timeout: this.callTimeoutMs, resetTimeoutOnProgress: true })
      )
      return {
        isError: Boolean(r.isError),
        content: Array.isArray(r.content) ? r.content : [],
        ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}),
        durationMs: Date.now() - started
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      return { isError: true, content: [{ type: 'text', text: msg }], durationMs: Date.now() - started, protocolError: msg }
    }
  }

  /** 关掉某个 AI 的客户端（吊销、换 token 后） */
  async disconnect(agentId: string): Promise<void> {
    const e = this.entries.get(agentId)
    this.entries.delete(agentId)
    if (e) await this.closeEntry(e)
  }

  async dispose(): Promise<void> {
    const all = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(all.map((e) => this.closeEntry(e)))
  }

  /** 测试用：现在缓存着几个客户端 */
  get size(): number {
    return this.entries.size
  }

  // 断线（会话过期、服务重启）时丢掉客户端重连一次
  private async withClient<T>(agentId: string, fn: (c: Client) => Promise<T>): Promise<T> {
    let entry = await this.entry(agentId)
    try {
      return await fn(entry.client)
    } catch (e) {
      if (!isConnectionLost(e)) throw e
      if (this.entries.get(agentId) === entry) this.entries.delete(agentId)
      void this.closeEntry(entry)
      entry = await this.entry(agentId)
      return await fn(entry.client)
    } finally {
      this.touch(agentId)
    }
  }

  private async entry(agentId: string): Promise<Entry> {
    // 每次都重新取接入信息：AI 被吊销会在这里抛错，换了 token 就换客户端
    const info = this.opts.connectionInfo(agentId)
    const cur = this.entries.get(agentId)
    if (cur && cur.token === info.token) return cur
    if (cur) {
      this.entries.delete(agentId)
      void this.closeEntry(cur)
    }
    const key = `${agentId}\n${info.token}`
    const inflight = this.pending.get(key)
    if (inflight) return inflight
    const p = this.connect(info).then(
      (e) => {
        this.pending.delete(key)
        this.entries.set(agentId, e)
        return e
      },
      (err) => {
        this.pending.delete(key)
        throw err
      }
    )
    this.pending.set(key, p)
    return p
  }

  private async connect(info: ConnectSource): Promise<Entry> {
    const t = pickTarget(info, 'local')!
    const transport = new StreamableHTTPClientTransport(
      new URL(t.url),
      t.bearer ? { requestInit: { headers: { Authorization: `Bearer ${t.bearer}` } } } : undefined
    )
    const client = new Client({ name: PLAYGROUND_CLIENT_NAME, version: '1.0.0' })
    await client.connect(transport)
    return { token: info.token, client, transport }
  }

  private touch(agentId: string): void {
    const e = this.entries.get(agentId)
    if (!e) return
    if (e.timer) clearTimeout(e.timer)
    e.timer = setTimeout(() => {
      if (this.entries.get(agentId) === e) this.entries.delete(agentId)
      void this.closeEntry(e)
    }, this.idleMs)
    e.timer.unref?.()
  }

  /** 先 DELETE 结束服务端会话，再关客户端，不留脏会话 */
  private async closeEntry(e: Entry): Promise<void> {
    if (e.timer) clearTimeout(e.timer)
    await e.transport.terminateSession().catch(() => undefined)
    await e.client.close().catch(() => undefined)
  }
}
