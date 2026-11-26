import crypto from 'node:crypto'
import type http from 'node:http'
import { JsonStore } from './jsonStore'

/*
 * 给网页版 AI（ChatGPT 连接器、Claude.ai 自定义连接器）用的 OAuth 2.1 授权服务：
 * PKCE（只支持 S256）+ 动态客户端注册（RFC 7591）+ 元数据发现（RFC 8414 / RFC 9728）。
 *
 * 安全模型：服务经隧道暴露在公网，任何人都能访问这些路由，所以
 * - 授权只能由电脑主人在桌面应用里批准（approve），浏览器页面只显示配对码、轮询状态，没有任何「同意」按钮；
 * - 轮询状态要带只发给这个浏览器的 browserKey，别人拿到请求 id 也读不到授权码；
 * - token 只存 SHA-256 哈希；refresh token 每次轮换，旧的被重放就吊销整个授权；授权码被重放也吊销已签发的授权；
 * - AI 身份被吊销后（agentExists 返回 false）它的 OAuth token 立即失效。
 * 待批准请求和授权码只在内存，重启即失效；客户端和授权（grant）持久化。
 */

export interface PendingAuthorization {
  /** 待批准请求 id（随机） */
  id: string
  /** 4 位数字配对码，浏览器页和桌面弹窗都显示 */
  pairCode: string
  clientId: string
  /** 注册时的 client_name，没有就用 '未命名客户端' */
  clientName: string
  /** redirect_uri 的 host（给主人判断来源，如 chatgpt.com） */
  redirectHost: string
  createdAt: number
  /** 创建后 10 分钟 */
  expiresAt: number
}

export interface OAuthGrantInfo {
  id: string
  agentId: string
  clientId: string
  clientName: string
  createdAt: number
  lastUsedAt: number
}

export interface OAuthOptions {
  /** 持久化文件（只存 token 的 SHA-256 哈希，不存明文） */
  file: string
  /** 批准时校验、验证 token 时校验：AI 身份被吊销后它的 OAuth token 立即失效 */
  agentExists: (agentId: string) => boolean
  /** 待批准列表变化（新增、批准、拒绝、过期）时调用，用于刷新界面、弹通知 */
  onPendingChange?: () => void
  now?: () => number
}

const PENDING_TTL_MS = 10 * 60 * 1000
const CODE_TTL_MS = 5 * 60 * 1000
const ACCESS_TTL_S = 8 * 60 * 60
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 已处理/已过期的请求再留一会儿，页面重试时读到「已过期」而不是 404 */
const STATUS_GRACE_MS = 5 * 60 * 1000
const MAX_PENDING = 10
const MAX_CLIENTS = 100
const MAX_REDIRECT_URIS = 10
const MAX_REDIRECT_URI_LEN = 2000
const MAX_STATE_LEN = 2048
const MAX_NAME_CHARS = 60
const MAX_BODY_BYTES = 64 * 1024
const POLL_MS = 1500
const SWEEP_INTERVAL_MS = 30 * 1000
/** lastUsedAt 只在内存更新，定时器每隔这么久最多落盘一次，close 时也会落盘 */
const FLUSH_INTERVAL_MS = 5 * 60 * 1000
const DEFAULT_CLIENT_NAME = '未命名客户端'

const ACCESS_PREFIX = 'wbat_'
const REFRESH_PREFIX = 'wbrt_'

interface StoredClient {
  id: string
  name: string
  redirectUris: string[]
  createdAt: number
}

interface StoredGrant {
  id: string
  agentId: string
  clientId: string
  /** access token 的 SHA-256（hex）；明文只在签发时返回一次 */
  accessHash: string
  accessExpiresAt: number
  refreshHash: string
  refreshExpiresAt: number
  /** 上一个 refresh token 的哈希：它再次出现说明 refresh token 泄露被重放，整个授权作废 */
  prevRefreshHash?: string
  createdAt: number
  lastUsedAt: number
}

interface OAuthData {
  clients: StoredClient[]
  grants: StoredGrant[]
}

type PendingStatus = 'pending' | 'approved' | 'denied' | 'expired'

interface PendingRecord extends PendingAuthorization {
  /** 只发给发起授权的浏览器，轮询状态时必须带上 */
  browserKey: string
  redirectUri: string
  codeChallenge: string
  state?: string
  status: PendingStatus
  /** approved/denied 后要跳转的地址（含授权码或错误） */
  redirect?: string
  /** approved/denied 的结果保留到这个时间，便于页面重试读取 */
  keepUntil: number
}

interface AuthCode {
  clientId: string
  redirectUri: string
  codeChallenge: string
  agentId: string
  expiresAt: number
  used: boolean
  /** 用这个授权码签发的 grant；授权码被重放时吊销它 */
  grantId?: string
}

class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {}
  ) {
    super(message)
  }
}

type RouteName = 'protected-resource' | 'auth-server' | 'register' | 'token' | 'authorize' | 'status'

// 用 Map 而不是对象字面量，避免 '__proto__' 之类的路径命中原型链
const ROUTES = new Map<string, RouteName>([
  ['/.well-known/oauth-protected-resource', 'protected-resource'],
  ['/.well-known/oauth-protected-resource/mcp', 'protected-resource'],
  ['/.well-known/oauth-authorization-server', 'auth-server'],
  ['/.well-known/oauth-authorization-server/mcp', 'auth-server'],
  ['/register', 'register'],
  ['/token', 'token'],
  ['/authorize', 'authorize'],
  ['/authorize/status', 'status']
])

/** 这些端点不依赖 cookie、靠 PKCE 保护，浏览器端客户端（如 MCP Inspector）需要 CORS */
const CORS_ROUTES = new Set<RouteName>(['protected-resource', 'auth-server', 'register', 'token'])
const CORS: Record<string, string> = { 'Access-Control-Allow-Origin': '*' }
const CORS_PREFLIGHT: Record<string, string> = {
  ...CORS,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
  'Access-Control-Max-Age': '86400'
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const BLOCKED_SCHEMES = new Set(['javascript', 'data', 'file', 'vbscript', 'blob', 'about', 'filesystem', 'view-source'])
/** PKCE 允许的字符集（RFC 7636），code_verifier 和 code_challenge 共用 */
const PKCE_RE = /^[A-Za-z0-9\-._~]{43,128}$/
/** 控制字符、零宽字符、双向文本控制符：从客户端名里去掉，防止在桌面弹窗里伪装显示 */
// eslint-disable-next-line no-control-regex
const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

const sha256Hex = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const randomToken = (bytes: number) => crypto.randomBytes(bytes).toString('base64url')

/** 定长比较：先各自哈希成 32 字节再 timingSafeEqual，长度不同也不泄露时序 */
function safeEqual(a: string, b: string): boolean {
  const da = crypto.createHash('sha256').update(a).digest()
  const db = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(da, db)
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}

/** 放进 <script> 的 JSON：转义 < 和行分隔符，防止提前闭合 script 标签 */
function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

/** 往回调地址上加参数；用 URL 对象处理，回调地址原有的查询参数保留 */
function withParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v)
  return u.toString()
}

/** 校验一个回调地址：https 任意主机；http 只允许本机；自定义 scheme 允许；危险 scheme 和 fragment 拒绝 */
function checkRedirectUri(v: unknown): string {
  const bad = (msg: string) => new OAuthError(400, 'invalid_redirect_uri', msg)
  if (typeof v !== 'string' || !v) throw bad('redirect_uris 里每一项都必须是非空字符串')
  if (v.length > MAX_REDIRECT_URI_LEN) throw bad(`回调地址不能超过 ${MAX_REDIRECT_URI_LEN} 个字符`)
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(v)) throw bad('回调地址不能包含空白或控制字符')
  if (v.includes('#')) throw bad('回调地址不能包含 fragment（#）')
  let u: URL
  try {
    u = new URL(v)
  } catch {
    throw bad('回调地址不是合法的 URL')
  }
  const scheme = u.protocol.slice(0, -1).toLowerCase()
  if (scheme === 'https') {
    if (!u.hostname) throw bad('https 回调地址缺少主机名')
    return v
  }
  if (scheme === 'http') {
    if (!LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) {
      throw bad('http 回调只允许本机地址（localhost、127.0.0.1、[::1]），其他地址请用 https')
    }
    return v
  }
  if (BLOCKED_SCHEMES.has(scheme)) throw bad(`不允许使用 ${scheme}: 作为回调地址`)
  return v
}

function cleanClientName(v: unknown): string {
  if (typeof v !== 'string') return DEFAULT_CLIENT_NAME
  const s = v.replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim()
  // 按码点截断，避免把 emoji 等代理对切成半个
  return s ? Array.from(s).slice(0, MAX_NAME_CHARS).join('').trim() : DEFAULT_CLIENT_NAME
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  })
  res.end(JSON.stringify(body))
}

function sendHtml(res: http.ServerResponse, status: number, html: string, nonce: string) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(html)
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const tooLarge = () => new OAuthError(413, 'invalid_request', `请求体过大（上限 ${limit / 1024}KB）`, { Connection: 'close' })
  if (Number(req.headers['content-length']) > limit) return Promise.reject(tooLarge())
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on('data', (c: Buffer) => {
      if (failed) return
      size += c.length
      if (size > limit) {
        failed = true
        reject(tooLarge())
      } else chunks.push(c)
    })
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

const STYLE = `*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:#0b0d12;color:#e6e9ef;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{width:100%;max-width:440px;background:#151922;border:1px solid #262c38;border-radius:16px;padding:32px 28px;box-shadow:0 20px 60px rgba(0,0,0,.45)}
.brand{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#7c8799;margin-bottom:6px}
h1{font-size:20px;margin:0 0 18px;font-weight:600}
h1.bad{color:#f87171}
p{margin:0 0 14px}
.meta{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0 0 22px;padding:14px 16px;background:#0f1218;border:1px solid #222834;border-radius:10px}
.meta dt{color:#7c8799}
.meta dd{margin:0;word-break:break-all;font-weight:500}
.label{text-align:center;color:#7c8799;font-size:13px}
.code{text-align:center;font:700 64px/1.1 ui-monospace,"SF Mono",Consolas,monospace;letter-spacing:.25em;padding-left:.25em;margin:6px 0 14px;color:#fff;font-variant-numeric:tabular-nums}
.code.dim{opacity:.3;text-decoration:line-through}
.hint{text-align:center;margin:0 0 20px}
.status{display:flex;align-items:center;justify-content:center;gap:8px;padding:10px;border-radius:10px;background:#0f1218;color:#a9b2c3;font-size:14px}
.status.ok{color:#4ade80}
.status.bad{color:#f87171}
.dot{width:8px;height:8px;border-radius:50%;background:currentColor;animation:pulse 1.2s ease-in-out infinite}
.status.ok .dot,.status.bad .dot{animation:none}
@keyframes pulse{0%,100%{opacity:.25}50%{opacity:1}}
.foot{margin:18px 0 0;font-size:12px;color:#6b7587;text-align:center}`

function htmlDoc(title: string, body: string, script?: { nonce: string; code: string }): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · Workspace Bridge</title>
<style>${STYLE}</style>
</head>
<body>
${body}
${script ? `<script nonce="${script.nonce}">${script.code}</script>` : ''}
</body>
</html>`
}

/** 授权等待页：只显示信息和配对码，轮询状态；没有任何「同意」操作，批准只能在桌面应用里做 */
function authorizePage(p: PendingRecord, nonce: string): string {
  const cfg = scriptJson({ id: p.id, k: p.browserKey, interval: POLL_MS })
  const name = escapeHtml(p.clientName)
  const body = `<main class="card">
<div class="brand">Workspace Bridge</div>
<h1>授权请求</h1>
<p><b>${name}</b> 请求访问这台电脑上的工作区。</p>
<dl class="meta"><dt>客户端</dt><dd>${name}</dd><dt>来源</dt><dd>${escapeHtml(p.redirectHost)}</dd></dl>
<div class="label">配对码</div>
<div id="code" class="code">${escapeHtml(p.pairCode)}</div>
<p class="hint">请在这台电脑的 Workspace Bridge 里核对配对码并批准</p>
<div id="status" class="status"><span class="dot"></span><span id="status-text">等待批准…</span></div>
<p class="foot">这个页面无法代替你批准。如果不是你发起的，请在 Workspace Bridge 里拒绝。请求 10 分钟内有效。</p>
</main>`
  const code = `(function () {
  var cfg = ${cfg};
  var box = document.getElementById('status');
  var text = document.getElementById('status-text');
  function show(msg, cls) { text.textContent = msg; box.className = 'status ' + cls; }
  function poll() {
    fetch('/authorize/status?id=' + encodeURIComponent(cfg.id) + '&k=' + encodeURIComponent(cfg.k), { cache: 'no-store', credentials: 'omit' })
      .then(function (r) {
        if (r.status === 404) return { status: 'expired' };
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then(function (d) {
        if (d.status === 'approved') { show('已批准，正在返回应用…', 'ok'); location.replace(d.redirect); }
        else if (d.status === 'denied') { show('已拒绝', 'bad'); setTimeout(function () { location.replace(d.redirect); }, 1500); }
        else if (d.status === 'expired') { show('请求已过期，请回到 AI 应用重新连接', 'bad'); document.getElementById('code').className = 'code dim'; }
        else setTimeout(poll, cfg.interval);
      })
      .catch(function () { setTimeout(poll, cfg.interval * 2); });
  }
  setTimeout(poll, cfg.interval);
})();`
  return htmlDoc('授权请求', body, { nonce, code })
}

function errorPage(title: string, message: string): string {
  return htmlDoc(
    title,
    `<main class="card">
<div class="brand">Workspace Bridge</div>
<h1 class="bad">${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p class="foot">请回到 AI 应用重新发起连接。</p>
</main>`
  )
}

/**
 * OAuth 授权服务。调用方（httpServer）把请求交给 handle()，用 verifyAccessToken() 校验 /mcp 的 Bearer token；
 * 桌面界面用 listPending/approve/deny 处理待批准请求，用 listGrants/revokeGrant/revokeAgent 管理已授权的客户端。
 */
export class OAuthServer {
  private store: JsonStore<OAuthData>
  private readonly now: () => number
  private pending = new Map<string, PendingRecord>()
  /** 授权码哈希 → 授权码记录（只在内存） */
  private codes = new Map<string, AuthCode>()
  // 哈希 → grant 索引；每次写盘后重建（grant 数量很少）
  private byAccess = new Map<string, StoredGrant>()
  private byRefresh = new Map<string, StoredGrant>()
  private byPrevRefresh = new Map<string, StoredGrant>()
  /** grantId → 最近使用时间；只在内存更新，随下次写盘或定时落盘 */
  private lastUsed = new Map<string, number>()
  private lastUsedDirty = false
  private lastFlush: number
  private timer: NodeJS.Timeout | null

  constructor(private readonly opts: OAuthOptions) {
    this.now = opts.now ?? Date.now
    this.store = new JsonStore<OAuthData>(opts.file, () => ({ clients: [], grants: [] }))
    const d = this.store.get()
    if (!Array.isArray(d.clients) || !Array.isArray(d.grants)) {
      this.store.set({ clients: Array.isArray(d.clients) ? d.clients : [], grants: Array.isArray(d.grants) ? d.grants : [] })
    }
    this.reindex()
    this.pruneGrants()
    this.lastFlush = this.now()
    this.timer = setInterval(() => this.tick(), SWEEP_INTERVAL_MS)
    this.timer.unref()
  }

  /** 处理 OAuth 相关路由，处理了返回 true；不是 OAuth 路由返回 false（不写响应） */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, baseUrl: string): Promise<boolean> {
    const route = ROUTES.get(url.pathname)
    if (!route) return false
    const cors = CORS_ROUTES.has(route)
    try {
      this.sweep()
      if (cors && req.method === 'OPTIONS') {
        res.writeHead(204, { ...CORS_PREFLIGHT, 'Cache-Control': 'no-store' })
        res.end()
        return true
      }
      switch (route) {
        case 'protected-resource':
          requireMethod(req, 'GET')
          sendJson(
            res,
            200,
            { resource: `${baseUrl}/mcp`, authorization_servers: [baseUrl], bearer_methods_supported: ['header'] },
            CORS
          )
          break
        case 'auth-server':
          requireMethod(req, 'GET')
          sendJson(
            res,
            200,
            {
              issuer: baseUrl,
              authorization_endpoint: `${baseUrl}/authorize`,
              token_endpoint: `${baseUrl}/token`,
              registration_endpoint: `${baseUrl}/register`,
              response_types_supported: ['code'],
              grant_types_supported: ['authorization_code', 'refresh_token'],
              code_challenge_methods_supported: ['S256'],
              token_endpoint_auth_methods_supported: ['none']
            },
            CORS
          )
          break
        case 'register':
          requireMethod(req, 'POST')
          await this.register(req, res)
          break
        case 'token':
          requireMethod(req, 'POST')
          await this.token(req, res)
          break
        case 'authorize':
          this.authorize(req, res, url)
          break
        case 'status':
          requireMethod(req, 'GET')
          this.status(res, url)
          break
      }
    } catch (err) {
      const e = err instanceof OAuthError ? err : new OAuthError(500, 'server_error', '服务器内部错误')
      // 请求体过大时不再读取剩余内容，回完响应就断开
      if (e.status === 413) req.resume()
      if (!res.headersSent) {
        sendJson(res, e.status, { error: e.code, error_description: e.message }, { ...(cors ? CORS : {}), ...e.headers })
      } else if (!res.writableEnded) res.end()
    }
    return true
  }

  /** 401 响应的 WWW-Authenticate 里用 */
  resourceMetadataUrl(baseUrl: string): string {
    return `${baseUrl}/.well-known/oauth-protected-resource`
  }

  /** access token → agentId；无效、过期、身份已吊销返回 undefined。lastUsedAt 只在内存更新 */
  verifyAccessToken(token: string): string | undefined {
    if (typeof token !== 'string' || !token.startsWith(ACCESS_PREFIX)) return undefined
    const g = this.byAccess.get(sha256Hex(token))
    const now = this.now()
    if (!g || now >= g.accessExpiresAt) return undefined
    if (!this.opts.agentExists(g.agentId)) return undefined
    this.lastUsed.set(g.id, now)
    this.lastUsedDirty = true
    return g.agentId
  }

  /** 只返回未过期、未处理的，按创建时间排序 */
  listPending(): PendingAuthorization[] {
    this.sweep()
    const now = this.now()
    return [...this.pending.values()]
      .filter((p) => p.status === 'pending' && now < p.expiresAt)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ id, pairCode, clientId, clientName, redirectHost, createdAt, expiresAt }) => ({
        id,
        pairCode,
        clientId,
        clientName,
        redirectHost,
        createdAt,
        expiresAt
      }))
  }

  /** 主人在桌面应用里批准，把这个客户端绑定到某个 AI 身份 */
  approve(pendingId: string, agentId: string): void {
    this.sweep()
    const p = this.pending.get(pendingId)
    const now = this.now()
    if (!p || p.status === 'expired' || (p.status === 'pending' && now >= p.expiresAt)) {
      throw new Error('授权请求不存在或已过期')
    }
    if (p.status !== 'pending') throw new Error('这个授权请求已经处理过了')
    if (!this.opts.agentExists(agentId)) throw new Error('AI 身份不存在或已被吊销')
    if (!this.findClient(p.clientId)) throw new Error('发起授权的客户端已不存在，请让 AI 应用重新连接')
    const code = randomToken(32)
    this.codes.set(sha256Hex(code), {
      clientId: p.clientId,
      redirectUri: p.redirectUri,
      codeChallenge: p.codeChallenge,
      agentId,
      expiresAt: now + CODE_TTL_MS,
      used: false
    })
    p.status = 'approved'
    p.redirect = withParams(p.redirectUri, { code, state: p.state })
    p.keepUntil = now + CODE_TTL_MS
    this.notify()
  }

  /** 拒绝；请求不存在、已过期或已处理时什么都不做（界面上的竞争不报错） */
  deny(pendingId: string): void {
    this.sweep()
    const p = this.pending.get(pendingId)
    const now = this.now()
    if (!p || p.status !== 'pending' || now >= p.expiresAt) return
    p.status = 'denied'
    p.redirect = withParams(p.redirectUri, { error: 'access_denied', state: p.state })
    p.keepUntil = now + CODE_TTL_MS
    this.notify()
  }

  listGrants(): OAuthGrantInfo[] {
    return this.store.get().grants.map((g) => ({
      id: g.id,
      agentId: g.agentId,
      clientId: g.clientId,
      clientName: this.findClient(g.clientId)?.name ?? DEFAULT_CLIENT_NAME,
      createdAt: g.createdAt,
      lastUsedAt: Math.max(g.lastUsedAt, this.lastUsed.get(g.id) ?? 0)
    }))
  }

  /** 吊销一个授权；不存在时什么都不做 */
  revokeGrant(grantId: string): void {
    this.removeGrants((g) => g.id === grantId)
  }

  /** 吊销某个 AI 的全部 OAuth 授权（吊销身份、更换 token 时调用），返回吊销的数量 */
  revokeAgent(agentId: string): number {
    // 已批准但还没换 token 的授权码也作废
    for (const [h, c] of this.codes) if (c.agentId === agentId) this.codes.delete(h)
    return this.removeGrants((g) => g.agentId === agentId)
  }

  /** 停止定时清理器，并把内存里的 lastUsedAt 落盘 */
  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    try {
      this.flushLastUsed()
    } catch {
      // 退出时写盘失败只丢 lastUsedAt，不影响授权本身
    }
  }

  // ---- 路由 ----

  private async register(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const raw = await readBody(req, MAX_BODY_BYTES)
    let body: unknown
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      throw new OAuthError(400, 'invalid_client_metadata', '请求体必须是 JSON 对象')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new OAuthError(400, 'invalid_client_metadata', '请求体必须是 JSON 对象')
    }
    const meta = body as Record<string, unknown>
    const uris = meta.redirect_uris
    if (!Array.isArray(uris) || uris.length === 0) {
      throw new OAuthError(400, 'invalid_redirect_uri', 'redirect_uris 必须是非空数组')
    }
    if (uris.length > MAX_REDIRECT_URIS) {
      throw new OAuthError(400, 'invalid_redirect_uri', `redirect_uris 最多 ${MAX_REDIRECT_URIS} 个`)
    }
    const redirectUris = [...new Set(uris.map(checkRedirectUri))]
    const now = this.now()
    const client: StoredClient = {
      id: 'wbc_' + randomToken(16),
      name: cleanClientName(meta.client_name),
      redirectUris,
      createdAt: now
    }
    this.write((d) => {
      if (d.clients.length >= MAX_CLIENTS) {
        // 满了：淘汰最久的「没完成授权」的客户端（没有 grant，也没有进行中的授权流程）
        const busy = new Set<string>(d.grants.map((g) => g.clientId))
        for (const p of this.pending.values()) if (p.status === 'pending' || p.status === 'approved') busy.add(p.clientId)
        for (const c of this.codes.values()) if (!c.used) busy.add(c.clientId)
        const need = d.clients.length - MAX_CLIENTS + 1
        const victims = d.clients.filter((c) => !busy.has(c.id)).sort((a, b) => a.createdAt - b.createdAt)
        if (victims.length < need) {
          throw new OAuthError(400, 'invalid_client_metadata', '已注册的客户端过多，请先在 Workspace Bridge 里清理已授权的客户端')
        }
        const drop = new Set(victims.slice(0, need).map((c) => c.id))
        d.clients = d.clients.filter((c) => !drop.has(c.id))
      }
      d.clients.push(client)
    })
    sendJson(
      res,
      201,
      {
        client_id: client.id,
        client_id_issued_at: Math.floor(now / 1000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      },
      CORS
    )
  }

  private authorize(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const fail = (status: number, title: string, message: string) => sendHtml(res, status, errorPage(title, message), randomToken(16))
    if (req.method !== 'GET') return fail(405, '请求方式不支持', '授权页面只接受 GET 请求。')
    const q = url.searchParams
    // 客户端或回调地址不对时绝不跳转：回调地址未经验证，跳过去等于开放重定向
    const clientId = q.getAll('client_id')
    const client = clientId.length === 1 ? this.findClient(clientId[0]) : undefined
    if (!client) return fail(400, '未知的客户端', '这个客户端没有注册或已失效。')
    const redirect = q.getAll('redirect_uri')
    if (redirect.length !== 1 || !client.redirectUris.includes(redirect[0])) {
      return fail(400, '回调地址不匹配', 'redirect_uri 与客户端注册时提交的不一致。')
    }
    const redirectUri = redirect[0]
    for (const k of ['response_type', 'code_challenge', 'code_challenge_method', 'state']) {
      if (q.getAll(k).length > 1) return fail(400, '请求参数错误', `参数 ${k} 不能重复。`)
    }
    if (q.get('response_type') !== 'code') return fail(400, '请求参数错误', '只支持 response_type=code。')
    const challenge = q.get('code_challenge')
    if (!challenge || !PKCE_RE.test(challenge)) return fail(400, '请求参数错误', '缺少或格式错误的 code_challenge（必须使用 PKCE）。')
    if (q.get('code_challenge_method') !== 'S256') return fail(400, '请求参数错误', 'code_challenge_method 只支持 S256。')
    const state = q.get('state') ?? undefined
    if (state !== undefined && state.length > MAX_STATE_LEN) return fail(400, '请求参数错误', 'state 过长。')

    const now = this.now()
    const active = [...this.pending.values()].filter((p) => p.status === 'pending' && now < p.expiresAt)
    if (active.length >= MAX_PENDING) {
      return fail(429, '待批准的请求过多', '有太多授权请求在等待批准，请先在 Workspace Bridge 里处理，或稍后再试。')
    }
    const u = new URL(redirectUri)
    const record: PendingRecord = {
      id: 'pa_' + randomToken(12),
      pairCode: this.newPairCode(active),
      clientId: client.id,
      clientName: client.name,
      redirectHost: u.host || u.protocol,
      createdAt: now,
      expiresAt: now + PENDING_TTL_MS,
      browserKey: randomToken(32),
      redirectUri,
      codeChallenge: challenge,
      state,
      status: 'pending',
      keepUntil: now + PENDING_TTL_MS
    }
    this.pending.set(record.id, record)
    this.notify()
    const nonce = randomToken(16)
    sendHtml(res, 200, authorizePage(record, nonce), nonce)
  }

  private status(res: http.ServerResponse, url: URL): void {
    const p = this.pending.get(url.searchParams.get('id') ?? '')
    // 没有 browserKey 一律当作不存在，不透露请求是否存在
    if (!p || !safeEqual(url.searchParams.get('k') ?? '', p.browserKey)) {
      return sendJson(res, 404, { error: 'not_found' })
    }
    const s = this.statusOf(p)
    sendJson(res, 200, s === 'approved' || s === 'denied' ? { status: s, redirect: p.redirect } : { status: s })
  }

  private async token(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const p = await readParams(req)
    const grantType = p.get('grant_type')
    if (!grantType) throw new OAuthError(400, 'invalid_request', '缺少参数 grant_type')
    let issued: { access: string; refresh: string }
    if (grantType === 'authorization_code') issued = this.exchangeCode(p)
    else if (grantType === 'refresh_token') issued = this.exchangeRefresh(p)
    else throw new OAuthError(400, 'unsupported_grant_type', `不支持的 grant_type：${grantType}`)
    sendJson(
      res,
      200,
      { access_token: issued.access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: issued.refresh },
      { ...CORS, Pragma: 'no-cache' }
    )
  }

  private exchangeCode(p: Map<string, string>): { access: string; refresh: string } {
    const code = need(p, 'code')
    const redirectUri = need(p, 'redirect_uri')
    const clientId = need(p, 'client_id')
    const verifier = need(p, 'code_verifier')
    if (!this.findClient(clientId)) throw new OAuthError(400, 'invalid_client', '未知的 client_id')
    if (!PKCE_RE.test(verifier)) throw new OAuthError(400, 'invalid_request', 'code_verifier 格式错误（43–128 个字符）')

    const h = sha256Hex(code)
    const rec = this.codes.get(h)
    if (!rec || this.now() >= rec.expiresAt) {
      this.codes.delete(h)
      throw new OAuthError(400, 'invalid_grant', '授权码无效或已过期')
    }
    if (rec.used) {
      // 授权码只能用一次；再次出现说明被截获，用它签发的授权一并作废
      this.codes.delete(h)
      if (rec.grantId) this.revokeGrant(rec.grantId)
      throw new OAuthError(400, 'invalid_grant', '授权码已被使用过，已吊销用它签发的授权')
    }
    // 校验失败不作废授权码：拿不到 verifier 的人用不了它，作废反而让攻击者能打断正常流程
    if (rec.clientId !== clientId) throw new OAuthError(400, 'invalid_grant', '授权码不属于这个客户端')
    if (rec.redirectUri !== redirectUri) throw new OAuthError(400, 'invalid_grant', 'redirect_uri 与授权时不一致')
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
    if (challenge !== rec.codeChallenge) throw new OAuthError(400, 'invalid_grant', 'code_verifier 校验失败')
    if (!this.opts.agentExists(rec.agentId)) {
      this.codes.delete(h)
      throw new OAuthError(400, 'invalid_grant', '授权绑定的 AI 身份已被吊销')
    }

    rec.used = true
    const now = this.now()
    const access = ACCESS_PREFIX + randomToken(32)
    const refresh = REFRESH_PREFIX + randomToken(32)
    const grant: StoredGrant = {
      id: 'og_' + crypto.randomBytes(8).toString('hex'),
      agentId: rec.agentId,
      clientId,
      accessHash: sha256Hex(access),
      accessExpiresAt: now + ACCESS_TTL_S * 1000,
      refreshHash: sha256Hex(refresh),
      refreshExpiresAt: now + REFRESH_TTL_MS,
      createdAt: now,
      lastUsedAt: now
    }
    this.write((d) => {
      d.grants.push(grant)
    })
    rec.grantId = grant.id
    return { access, refresh }
  }

  private exchangeRefresh(p: Map<string, string>): { access: string; refresh: string } {
    const token = need(p, 'refresh_token')
    const clientId = need(p, 'client_id')
    if (!this.findClient(clientId)) throw new OAuthError(400, 'invalid_client', '未知的 client_id')
    const h = sha256Hex(token)
    const g = this.byRefresh.get(h)
    if (!g) {
      const replayed = this.byPrevRefresh.get(h)
      if (replayed) {
        // 已轮换掉的 refresh token 又出现：说明它泄露了，整个授权作废，正常客户端需要重新授权
        this.revokeGrant(replayed.id)
        throw new OAuthError(400, 'invalid_grant', 'refresh_token 已被使用过，疑似泄露，已吊销该授权')
      }
      throw new OAuthError(400, 'invalid_grant', 'refresh_token 无效')
    }
    if (g.clientId !== clientId) throw new OAuthError(400, 'invalid_grant', 'refresh_token 不属于这个客户端')
    const now = this.now()
    if (now >= g.refreshExpiresAt) {
      this.revokeGrant(g.id)
      throw new OAuthError(400, 'invalid_grant', 'refresh_token 已过期，请重新授权')
    }
    if (!this.opts.agentExists(g.agentId)) {
      this.revokeGrant(g.id)
      throw new OAuthError(400, 'invalid_grant', '授权绑定的 AI 身份已被吊销')
    }
    const access = ACCESS_PREFIX + randomToken(32)
    const refresh = REFRESH_PREFIX + randomToken(32)
    this.write((d) => {
      const x = d.grants.find((y) => y.id === g.id)
      if (!x) throw new OAuthError(400, 'invalid_grant', '授权已被吊销')
      x.prevRefreshHash = x.refreshHash
      x.refreshHash = sha256Hex(refresh)
      x.refreshExpiresAt = now + REFRESH_TTL_MS
      x.accessHash = sha256Hex(access)
      x.accessExpiresAt = now + ACCESS_TTL_S * 1000
      x.lastUsedAt = Math.max(x.lastUsedAt, now)
    })
    return { access, refresh }
  }

  // ---- 内部 ----

  private findClient(id: string): StoredClient | undefined {
    return this.store.get().clients.find((c) => c.id === id)
  }

  /** 4 位配对码，与当前其他待批准请求不重复（同时最多 10 个，循环必然结束） */
  private newPairCode(active: PendingRecord[]): string {
    const used = new Set(active.map((p) => p.pairCode))
    for (;;) {
      const c = String(crypto.randomInt(0, 10000)).padStart(4, '0')
      if (!used.has(c)) return c
    }
  }

  private statusOf(p: PendingRecord): PendingStatus {
    const now = this.now()
    if (p.status === 'pending') return now < p.expiresAt ? 'pending' : 'expired'
    if (p.status === 'expired') return 'expired'
    return now < p.keepUntil ? p.status : 'expired'
  }

  /** 清理过期的待批准请求和授权码；有待批准请求过期时通知界面 */
  private sweep(): void {
    const now = this.now()
    let changed = false
    for (const [id, p] of this.pending) {
      if (p.status === 'pending' && now >= p.expiresAt) {
        p.status = 'expired'
        changed = true
      }
      if (p.status !== 'pending' && now >= Math.max(p.expiresAt, p.keepUntil) + STATUS_GRACE_MS) this.pending.delete(id)
    }
    for (const [h, c] of this.codes) if (now >= c.expiresAt) this.codes.delete(h)
    if (changed) this.notify()
  }

  private tick(): void {
    try {
      this.sweep()
      this.pruneGrants()
      if (this.lastUsedDirty && this.now() - this.lastFlush >= FLUSH_INTERVAL_MS) this.flushLastUsed()
    } catch {
      // 定时器里的写盘失败不能让进程崩溃，下次再试
    }
  }

  /** 删除 refresh token 已过期的授权 */
  private pruneGrants(): void {
    const now = this.now()
    this.removeGrants((g) => now >= g.refreshExpiresAt)
  }

  private flushLastUsed(): void {
    if (this.lastUsedDirty) this.write(() => {})
  }

  private removeGrants(pred: (g: StoredGrant) => boolean): number {
    const n = this.store.get().grants.filter(pred).length
    if (!n) return 0
    this.write((d) => {
      d.grants = d.grants.filter((g) => !pred(g))
    })
    return n
  }

  /** 所有写盘都走这里：顺带把内存里的 lastUsedAt 合并进去，写完重建索引 */
  private write(fn: (d: OAuthData) => void): void {
    this.store.mutate((d) => {
      for (const g of d.grants) {
        const t = this.lastUsed.get(g.id)
        if (t !== undefined && t > g.lastUsedAt) g.lastUsedAt = t
      }
      fn(d)
    })
    this.lastUsedDirty = false
    this.lastFlush = this.now()
    this.reindex()
  }

  private reindex(): void {
    this.byAccess.clear()
    this.byRefresh.clear()
    this.byPrevRefresh.clear()
    const ids = new Set<string>()
    for (const g of this.store.get().grants) {
      ids.add(g.id)
      this.byAccess.set(g.accessHash, g)
      this.byRefresh.set(g.refreshHash, g)
      if (g.prevRefreshHash) this.byPrevRefresh.set(g.prevRefreshHash, g)
    }
    for (const id of this.lastUsed.keys()) if (!ids.has(id)) this.lastUsed.delete(id)
  }

  private notify(): void {
    try {
      this.opts.onPendingChange?.()
    } catch {
      // 界面回调出错不能影响授权流程
    }
  }
}

function requireMethod(req: http.IncomingMessage, method: string): void {
  if (req.method !== method) {
    throw new OAuthError(405, 'invalid_request', `只接受 ${method} 请求`, { Allow: `${method}, OPTIONS` })
  }
}

function need(p: Map<string, string>, key: string): string {
  const v = p.get(key)
  if (!v) throw new OAuthError(400, 'invalid_request', `缺少参数 ${key}`)
  return v
}

/** /token 的参数：接受 application/x-www-form-urlencoded（标准）和 JSON；表单参数不能重复（RFC 6749 3.2） */
async function readParams(req: http.IncomingMessage): Promise<Map<string, string>> {
  const raw = (await readBody(req, MAX_BODY_BYTES)).toString('utf8')
  const type = String(req.headers['content-type'] ?? '').toLowerCase()
  const out = new Map<string, string>()
  if (type.includes('application/json')) {
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      throw new OAuthError(400, 'invalid_request', '请求体不是合法的 JSON')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OAuthError(400, 'invalid_request', '请求体必须是 JSON 对象')
    for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out.set(k, v)
    return out
  }
  const sp = new URLSearchParams(raw)
  for (const k of new Set(sp.keys())) {
    const all = sp.getAll(k)
    if (all.length > 1) throw new OAuthError(400, 'invalid_request', `参数 ${k} 不能重复`)
    out.set(k, all[0])
  }
  return out
}
