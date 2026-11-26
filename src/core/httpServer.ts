import http from 'node:http'
import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest, LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { OAuthServer } from './oauth'
import type { Agent } from './types'

const MAX_BODY_BYTES = 16 * 1024 * 1024
const SESSION_IDLE_MS = 30 * 60 * 1000
/** 工作台发出的会话 id 都是 crypto.randomUUID()；自动接上只认这个格式 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface SessionInfo {
  id: string
  agentId: string
  clientName?: string
  createdAt: number
  lastSeen: number
  /** 副连接握手时报的读者名（?reader= 或 X-WB-Reader）；没报的是主连接 */
  reader?: string
}

/** 读者名：字母、数字、- 和 _，最长 24。和 chat.ts 的 CHAT_READER_RE 一致 */
const READER_RE = /^[A-Za-z0-9_-]{1,24}$/

interface Session extends SessionInfo {
  transport: StreamableHTTPServerTransport
  server: McpServer
}

/** 关掉的会话留个底：谁的、为什么关、能不能自动接上 */
interface ClosedSession {
  agentId: string
  reason?: string
  clientName?: string
  /** false：用户在工作台手动断开的，不自动接上 */
  revivable: boolean
}

/** SDK 内部的 Web 标准传输层：只用它的 handleRequest 在服务端补一次握手 */
interface WebTransportLike {
  handleRequest(req: Request, opts?: { parsedBody?: unknown }): Promise<Response>
}

export interface HttpServerOptions {
  host: string
  port: number
  agents: () => Agent[]
  /** 为某个 AI 新建一个 MCP 会话；session.reader 是副连接报的读者名 */
  /** session.id 握手完成后才填上（建服务端时会话 id 还没生成），用的时候现取 */
  createServer: (agentId: string, session?: { reader?: string; id?: string }) => McpServer
  onSessionsChanged?: () => void
  /** 除本机外额外允许的 Host 头（局域网 IP、隧道域名），不带端口 */
  extraAllowedHosts?: () => string[]
  /** 隧道域名：经 cloudflared 进来的请求对外是 https，元数据里的地址要用 https */
  publicHosts?: () => string[]
  /**
   * 公网隧道是否开着（启动中或运行中）。开着时 /mcp/<token> 路径令牌只接受本机地址直连，
   * 经隧道（隧道域名、带 Cloudflare 转发头）或局域网进来的一律 401，只能用 Bearer 头或 OAuth
   */
  tunnelActive?: () => boolean
  /** OAuth 授权服务；不给就只接受静态 token */
  oauth?: OAuthServer
  /**
   * 链接直连模式（和 ShunCode 一样「有链接就行」）：返回 true 时
   * - 不提供任何 OAuth 端点（/.well-known/* 返回 404），401 也不带 resource_metadata，
   *   客户端探测不到 OAuth，就不会弹登录卡片
   * - /mcp/<token> 路径令牌在本机、局域网、公网隧道都接受（token 是 192 位随机数，不可猜）
   * - 不接受 OAuth access token
   * 不给或返回 false 时保持原来的 OAuth 行为
   */
  linkMode?: () => boolean
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest()

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1']

export const PATH_TOKEN_REJECTED_MESSAGE =
  '公网隧道开着时不接受写在地址路径里的 token（/mcp/<token>），请改用 Authorization: Bearer 请求头或 OAuth；本机地址（127.0.0.1、localhost）直连不受影响'

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

function rpcError(res: http.ServerResponse, status: number, message: string, headers?: Record<string, string>, data?: Record<string, unknown>) {
  sendJson(res, status, { jsonrpc: '2.0', error: { code: -32000, message, ...(data ? { data } : {}) }, id: null }, headers)
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export class McpHttpServer {
  private server: http.Server | null = null
  private sessions = new Map<string, Session>()
  /** 最近被工作台关掉的会话：手动断开的再用旧会话请求时告诉它为什么；其余的自动接上，并且不许别的身份接走 */
  private closedSessions = new Map<string, ClosedSession>()
  /** 正在自动接上的会话：同一个旧 id 并发来几个请求只重建一次 */
  private reviving = new Map<string, Promise<boolean>>()
  private sweepTimer: NodeJS.Timeout | null = null

  constructor(private readonly opts: HttpServerOptions) {}

  get port(): number {
    return (this.server?.address() as AddressInfo | null)?.port ?? this.opts.port
  }

  listSessions(): SessionInfo[] {
    return [...this.sessions.values()].map(({ transport: _t, server: _s, ...info }) => info)
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) rpcError(res, (err as { status?: number }).status ?? 500, (err as Error).message)
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.opts.port, this.opts.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    this.sweepTimer = setInterval(() => this.sweepIdle(), 60_000)
    this.sweepTimer.unref()
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    await this.closeSessions(() => true)
    const s = this.server
    this.server = null
    if (s) {
      s.closeAllConnections()
      await new Promise<void>((r) => s.close(() => r()))
    }
  }

  /**
   * 吊销身份、增删工作区、空闲超时、用户断开时调用。
   * revivable（默认 true）的会话，客户端拿旧 id 再来请求时服务端原地用同一个 id 重建（见 revive），
   * 不会重新握手的客户端也接得上；revivable=false 的收到 404（带 reason 说明原因），只能重新握手
   */
  async closeSessions(filter: (s: SessionInfo) => boolean, reason?: string, opts: { revivable?: boolean } = {}): Promise<void> {
    const targets = [...this.sessions.values()].filter(filter)
    for (const s of targets) {
      this.sessions.delete(s.id)
      this.closedSessions.delete(s.id)
      this.closedSessions.set(s.id, {
        agentId: s.agentId,
        ...(reason ? { reason } : {}),
        ...(s.clientName ? { clientName: s.clientName } : {}),
        revivable: opts.revivable !== false
      })
      // 只留最近 500 个
      while (this.closedSessions.size > 500) this.closedSessions.delete(this.closedSessions.keys().next().value!)
      await s.transport.close().catch(() => {})
      await s.server.close().catch(() => {})
    }
    if (targets.length) this.opts.onSessionsChanged?.()
  }

  private sweepIdle(): void {
    const cutoff = Date.now() - SESSION_IDLE_MS
    void this.closeSessions((s) => s.lastSeen < cutoff, `超过 ${SESSION_IDLE_MS / 60_000} 分钟没有请求`)
  }

  /** 返回不带端口的小写主机名；不在白名单里返回 undefined */
  private allowedHostname(hostHeader: string | undefined): string | undefined {
    if (!hostHeader) return undefined
    const host = hostHeader.trim().toLowerCase()
    const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.replace(/:\d+$/, '')
    if (LOOPBACK_HOSTS.includes(name)) return name
    return (this.opts.extraAllowedHosts?.() ?? []).some((h) => h.toLowerCase() === name) ? name : undefined
  }

  /**
   * 这个请求能不能用路径令牌：经隧道域名进来的永远不能；隧道开着时，带 Cloudflare 转发头的、
   * 或 Host 不是本机的（局域网）也不能。令牌写在 URL 里会进 Cloudflare 和各级代理的访问日志
   */
  private pathTokenBlocked(req: http.IncomingMessage, hostname: string): boolean {
    if (this.linkMode()) return false
    if ((this.opts.publicHosts?.() ?? []).some((h) => h.toLowerCase() === hostname)) return true
    if (!this.opts.tunnelActive?.()) return false
    if (req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['cf-visitor']) return true
    return !LOOPBACK_HOSTS.includes(hostname)
  }

  private linkMode(): boolean {
    return this.opts.linkMode?.() === true
  }

  /** 当前生效的 OAuth 服务：链接直连模式下视为没有 */
  private activeOAuth(): OAuthServer | undefined {
    return this.linkMode() ? undefined : this.opts.oauth
  }

  /** Bearer 头或 /mcp/<token> 路径。路径只接受静态 token：OAuth token 不该出现在 URL 和日志里 */
  private authenticate(req: http.IncomingMessage, pathToken: string | undefined): Agent | undefined {
    const auth = req.headers.authorization
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined
    // 用哈希后定长比较，避免时序泄露
    const agents = this.opts.agents()
    const matchStatic = (t: string | undefined) => {
      if (!t) return undefined
      const digest = sha(t)
      return agents.find((a) => crypto.timingSafeEqual(sha(a.token), digest))
    }
    // 路径令牌优先：链接里的 token 才是这个连接的身份。有的客户端会顺手带一个无关的 Authorization 头
    // （比如之前 OAuth 留下的旧 token），不能因此把带对了 token 的链接判成 401
    const byStatic = matchStatic(pathToken) ?? matchStatic(bearer)
    const oauth = this.activeOAuth()
    if (byStatic || !bearer || !oauth) return byStatic
    const id = oauth.verifyAccessToken(bearer)
    return id ? agents.find((a) => a.id === id) : undefined
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 防 DNS rebinding：Host 必须是本机，或已开启的局域网地址、隧道域名
    const hostname = this.allowedHostname(req.headers.host)
    if (!hostname) return rpcError(res, 421, 'Host 不被允许')
    // 对外地址取自（已校验的）Host 头：本机、局域网、隧道进来的客户端各自拿到能访问的地址
    const scheme = (this.opts.publicHosts?.() ?? []).some((h) => h.toLowerCase() === hostname) ? 'https' : 'http'
    const baseUrl = `${scheme}://${req.headers.host!.trim().toLowerCase()}`

    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true, name: 'workspace-bridge' })

    // OAuth 路由要给浏览器用（授权页、CORS），放在 Origin 检查之前；安全靠 PKCE 和桌面批准
    // 链接直连模式下不挂 OAuth 路由：/.well-known/* 走到下面的 404，客户端就不会走 OAuth
    const oauth = this.activeOAuth()
    if (oauth && (await oauth.handle(req, res, url, baseUrl))) return

    // AI 客户端从服务端发请求，不带 Origin；带 Origin 说明是浏览器页面，一律拒绝防 CSRF
    if (req.headers.origin) return rpcError(res, 403, '不接受浏览器跨站请求')

    const m = url.pathname.match(/^\/mcp(?:\/([^/]+))?\/?$/)
    if (!m) return sendJson(res, 404, { error: 'not found' })

    const www = oauth
      ? `Bearer realm="workspace-bridge", resource_metadata="${oauth.resourceMetadataUrl(baseUrl)}"`
      : 'Bearer realm="workspace-bridge"'
    // 地址里带了令牌就拒，哪怕同时带了 Bearer 头：令牌已经出现在 URL 里了
    if (m[1] && this.pathTokenBlocked(req, hostname)) {
      return rpcError(res, 401, PATH_TOKEN_REJECTED_MESSAGE, { 'WWW-Authenticate': www })
    }

    const agent = this.authenticate(req, m[1])
    if (!agent) {
      return rpcError(res, 401, '缺少或无效的访问 token', { 'WWW-Authenticate': www })
    }

    // 不提供 SSE 推送流：Cloudflare Quick Tunnel 不支持 SSE，所有响应都走 JSON
    if (req.method === 'GET') return rpcError(res, 405, '不支持 SSE 推送流，请只用 POST', { Allow: 'POST, DELETE' })

    let body: unknown
    if (req.method === 'POST') {
      const raw = await readBody(req)
      try {
        body = JSON.parse(raw.toString('utf8'))
      } catch {
        return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'JSON 解析失败' }, id: null })
      }
    }

    const sid = req.headers['mcp-session-id']
    const sessionId = Array.isArray(sid) ? sid[0] : sid
    if (sessionId) {
      let s = this.sessions.get(sessionId)
      if (!s) {
        const closed = this.closedSessions.get(sessionId)
        // 关掉的会话只能由原来的身份接上
        if (closed && closed.agentId !== agent.id) return rpcError(res, 403, '会话不属于这个 token')
        // 有的客户端（如 AWS Quick）收到 404 不会重新握手，之后每次调用都失败：能接上的就用同一个 id 原地重建
        if (req.method === 'POST' && !isInitializeRequest(body) && SESSION_ID_RE.test(sessionId) && (!closed || closed.revivable)) {
          const reader = this.readerOf(req, url)
          if (reader !== null && (await this.revive(sessionId, agent, reader, req, closed))) s = this.sessions.get(sessionId)
        }
      }
      if (!s) {
        // 404 是 MCP 规定的「会话没了，重新握手」；能说出原因时说清楚
        const why = this.closedSessions.get(sessionId)?.reason
        if (why) return rpcError(res, 404, `会话已被关闭：${why}。请重新 initialize`, undefined, { code: 'SESSION_CLOSED', reason: why })
        return rpcError(res, 404, '会话不存在或已过期，请重新 initialize', undefined, { code: 'SESSION_NOT_FOUND' })
      }
      // 会话绑定身份，拿别人的 session id 也用不了
      if (s.agentId !== agent.id) return rpcError(res, 403, '会话不属于这个 token')
      s.lastSeen = Date.now()
      await s.transport.handleRequest(req, res, body)
      this.opts.onSessionsChanged?.()
      return
    }

    if (req.method !== 'POST' || !isInitializeRequest(body)) {
      return rpcError(res, 400, '缺少 Mcp-Session-Id，请先发送 initialize')
    }

    // 副连接（代理脚本之类）握手时在地址上加 ?reader=名字，或带请求头 X-WB-Reader：只把已读位置和通知分开，不改身份和权限。
    // 名字写错了直接报错，不当成主连接：否则代理会悄悄把本人的消息读走
    const reader = this.readerOf(req, url)
    if (reader === null) {
      return rpcError(res, 400, '读者名（?reader= 或 X-WB-Reader）只能用字母、数字、- 和 _，最长 24 个字符；不想分开已读位置就去掉它', undefined, { code: 'INVALID_READER' })
    }
    const clientName = (body as { params?: { clientInfo?: { name?: string } } }).params?.clientInfo?.name
    const { mcp, transport } = this.openSession(agent, reader, clientName)
    await mcp.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  /** 读者名：没报返回 undefined，格式不对返回 null */
  private readerOf(req: http.IncomingMessage, url: URL): string | undefined | null {
    const hdr = req.headers['x-wb-reader']
    const readerRaw = url.searchParams.get('reader') ?? (Array.isArray(hdr) ? hdr[0] : hdr)
    const reader = readerRaw === undefined || readerRaw === null || readerRaw === '' ? undefined : String(readerRaw).trim()
    return reader !== undefined && !READER_RE.test(reader) ? null : reader
  }

  /** 新建一个会话的 MCP 服务端和传输层；fixedId 给了就用它当会话 id（自动接上时用原来的 id） */
  private openSession(agent: Agent, reader: string | undefined, clientName: string | undefined, fixedId?: string): { mcp: McpServer; transport: StreamableHTTPServerTransport } {
    const session: { reader?: string; id?: string } = reader ? { reader } : {}
    const mcp = this.opts.createServer(agent.id, session)
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => fixedId ?? crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        session.id = id
        this.closedSessions.delete(id)
        this.sessions.set(id, { id, agentId: agent.id, clientName, createdAt: Date.now(), lastSeen: Date.now(), ...(reader ? { reader } : {}), transport, server: mcp })
        this.opts.onSessionsChanged?.()
      }
    })
    transport.onclose = () => {
      const id = transport.sessionId
      // 只删自己那条：同一个 id 可能已经被自动接上的新会话占了。
      // 走到这里还在表里的，是客户端自己发 DELETE 结束的（closeSessions 会先移出表）：按协议不该再接上
      if (id && this.sessions.get(id)?.transport === transport && this.sessions.delete(id)) {
        this.closedSessions.set(id, { agentId: agent.id, revivable: false })
        while (this.closedSessions.size > 500) this.closedSessions.delete(this.closedSessions.keys().next().value!)
        this.opts.onSessionsChanged?.()
      }
    }
    return { mcp, transport }
  }

  /** 用原来的会话 id 原地重建会话：并发的同 id 请求共用一次 */
  private revive(id: string, agent: Agent, reader: string | undefined, req: http.IncomingMessage, closed?: ClosedSession): Promise<boolean> {
    const pending = this.reviving.get(id)
    if (pending) return pending
    const hdr = req.headers['mcp-protocol-version']
    const asked = Array.isArray(hdr) ? hdr[0] : hdr
    const version = asked && SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL_VERSION
    const p = this.reviveNow(id, agent, reader, version, closed?.clientName).finally(() => this.reviving.delete(id))
    this.reviving.set(id, p)
    return p
  }

  /** 在服务端替客户端补一次 initialize + initialized，之后这个 id 的请求照常处理 */
  private async reviveNow(id: string, agent: Agent, reader: string | undefined, version: string, clientName: string | undefined): Promise<boolean> {
    const { mcp, transport } = this.openSession(agent, reader, clientName, id)
    const web = (transport as unknown as { _webStandardTransport?: WebTransportLike })._webStandardTransport
    const post = async (msg: unknown, headers: Record<string, string> = {}): Promise<boolean> => {
      const r = await web!.handleRequest(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
          body: JSON.stringify(msg)
        }),
        { parsedBody: msg }
      )
      await r.text().catch(() => '')
      return r.ok
    }
    try {
      // SDK 升级改了内部结构就退回原来的 404，不硬撑
      if (typeof web?.handleRequest !== 'function') throw new Error('transport internals changed')
      await mcp.connect(transport)
      const init = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: clientName ?? 'revived', version: '0' } } }
      if (!(await post(init)) || transport.sessionId !== id) throw new Error('initialize failed')
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': id, 'mcp-protocol-version': version })
      return this.sessions.get(id)?.transport === transport
    } catch {
      await transport.close().catch(() => {})
      await mcp.close().catch(() => {})
      return false
    }
  }
}
