// OAuth 2.1 授权服务测试：元数据、动态注册、授权页、配对批准、令牌交换与轮换、吊销、持久化。
// 每个用例一个临时目录和一个最小 HTTP 服务器，时间用 now 注入
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OAuthServer } from '../src/core/oauth'

const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect'
const MIN = 60 * 1000
const HOUR = 60 * MIN

interface Ctx {
  oauth: OAuthServer
  base: string
  file: string
}

interface Tokens {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
}

let dir: string
let clock: number
let agents: Set<string>
let pendingChanges: number
let ctx: Ctx
const cleanups: (() => Promise<void>)[] = []

/** 起一个最小 HTTP 服务器：OAuth 路由交给 handle，返回 false 时写 404 */
async function start(file = path.join(dir, 'oauth.json')): Promise<Ctx> {
  const oauth = new OAuthServer({
    file,
    agentExists: (id) => agents.has(id),
    onPendingChange: () => {
      pendingChanges++
    },
    now: () => clock
  })
  let base = ''
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', base)
    oauth.handle(req, res, url, base).then(
      (handled) => {
        if (!handled) {
          res.writeHead(404)
          res.end('not found')
        }
      },
      (err) => {
        res.writeHead(500)
        res.end(String(err))
      }
    )
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  cleanups.push(async () => {
    oauth.close()
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  })
  return { oauth, base, file }
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-oauth-'))
  clock = 1_800_000_000_000
  agents = new Set(['a1', 'a2'])
  pendingChanges = 0
  ctx = await start()
})

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---- 工具函数 ----

function get(p: string, c = ctx) {
  return fetch(c.base + p, { redirect: 'manual' })
}

function postJson(p: string, body: unknown, c = ctx) {
  return fetch(c.base + p, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

function postForm(p: string, params: Record<string, string>, c = ctx) {
  return fetch(c.base + p, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  })
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

async function registerClient(meta: Record<string, unknown> = {}): Promise<string> {
  const res = await postJson('/register', { client_name: 'Test App', redirect_uris: [REDIRECT], ...meta })
  expect(res.status).toBe(201)
  return ((await res.json()) as { client_id: string }).client_id
}

function authorize(params: Record<string, string>) {
  return get('/authorize?' + new URLSearchParams(params).toString())
}

function authParams(clientId: string, challenge: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...extra
  }
}

/** 打开授权页，从页面脚本里取出请求 id 和 browserKey */
async function startAuth(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const res = await authorize(authParams(clientId, challenge, extra))
  expect(res.status).toBe(200)
  const html = await res.text()
  const m = /var cfg = (\{.*?\});/.exec(html)
  expect(m).not.toBeNull()
  const cfg = JSON.parse(m![1]) as { id: string; k: string }
  return { res, html, id: cfg.id, k: cfg.k }
}

async function poll(id: string, k: string) {
  const res = await get(`/authorize/status?id=${encodeURIComponent(id)}&k=${encodeURIComponent(k)}`)
  return { status: res.status, body: (await res.json()) as { status?: string; redirect?: string; error?: string } }
}

/** 注册 → 授权页 → 主人批准 → 读取跳转地址里的授权码 */
async function approvedCode(agentId = 'a1', clientId?: string) {
  const cid = clientId ?? (await registerClient())
  const { verifier, challenge } = pkce()
  const page = await startAuth(cid, challenge, { state: 'st' })
  ctx.oauth.approve(page.id, agentId)
  const s = await poll(page.id, page.k)
  const code = new URL(s.body.redirect!).searchParams.get('code')!
  return { clientId: cid, verifier, code }
}

function exchangeCode(a: { clientId: string; verifier: string; code: string }, override: Record<string, string> = {}) {
  return postForm('/token', {
    grant_type: 'authorization_code',
    code: a.code,
    redirect_uri: REDIRECT,
    client_id: a.clientId,
    code_verifier: a.verifier,
    ...override
  })
}

function refreshWith(clientId: string, refresh: string, c = ctx) {
  return postForm('/token', { grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }, c)
}

/** 完整流程，返回签发的 token */
async function fullFlow(agentId = 'a1', clientId?: string) {
  const a = await approvedCode(agentId, clientId)
  const res = await exchangeCode(a)
  expect(res.status).toBe(200)
  const t = (await res.json()) as Tokens
  return { ...a, access: t.access_token, refresh: t.refresh_token }
}

// ---- 用例 ----

describe('元数据与 CORS', () => {
  it('受保护资源元数据（两个路径）', async () => {
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await get(p)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      expect(await res.json()).toEqual({
        resource: `${ctx.base}/mcp`,
        authorization_servers: [ctx.base],
        bearer_methods_supported: ['header']
      })
    }
    expect(ctx.oauth.resourceMetadataUrl(ctx.base)).toBe(`${ctx.base}/.well-known/oauth-protected-resource`)
  })

  it('授权服务器元数据（两个路径）', async () => {
    for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp']) {
      const res = await get(p)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      const m = (await res.json()) as Record<string, unknown>
      expect(m.issuer).toBe(ctx.base)
      expect(m.authorization_endpoint).toBe(`${ctx.base}/authorize`)
      expect(m.token_endpoint).toBe(`${ctx.base}/token`)
      expect(m.registration_endpoint).toBe(`${ctx.base}/register`)
      expect(m.response_types_supported).toEqual(['code'])
      expect(m.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
      expect(m.code_challenge_methods_supported).toEqual(['S256'])
      expect(m.token_endpoint_auth_methods_supported).toEqual(['none'])
    }
  })

  it('CORS 预检返回 204', async () => {
    for (const p of ['/token', '/register', '/.well-known/oauth-authorization-server']) {
      const res = await fetch(ctx.base + p, {
        method: 'OPTIONS',
        headers: { Origin: 'https://inspector.example', 'Access-Control-Request-Method': 'POST' }
      })
      expect(res.status).toBe(204)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      const allowed = res.headers.get('access-control-allow-headers') ?? ''
      for (const h of ['Content-Type', 'Authorization', 'MCP-Protocol-Version']) expect(allowed).toContain(h)
    }
  })

  it('授权页和状态接口不开放 CORS', async () => {
    const res = await get('/authorize/status?id=x&k=y')
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('非 OAuth 路径不处理', async () => {
    for (const p of ['/mcp', '/', '/authorize/', '/.well-known/other', '/__proto__']) {
      const res = await get(p)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('not found')
    }
  })

  it('方法不对返回 405', async () => {
    expect((await postJson('/.well-known/oauth-authorization-server', {})).status).toBe(405)
    expect((await get('/token')).status).toBe(405)
    expect((await get('/register')).status).toBe(405)
  })
})

describe('动态客户端注册', () => {
  it('合法的 https 回调', async () => {
    const res = await postJson('/register', { client_name: 'ChatGPT', redirect_uris: [REDIRECT] })
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const b = (await res.json()) as Record<string, unknown>
    expect(typeof b.client_id).toBe('string')
    expect(b.client_id_issued_at).toBe(Math.floor(clock / 1000))
    expect(b.client_name).toBe('ChatGPT')
    expect(b.redirect_uris).toEqual([REDIRECT])
    expect(b.grant_types).toEqual(['authorization_code', 'refresh_token'])
    expect(b.response_types).toEqual(['code'])
    expect(b.token_endpoint_auth_method).toBe('none')
  })

  it('本机 http 回调和自定义 scheme 允许', async () => {
    const uris = ['http://localhost:6274/oauth/callback', 'http://127.0.0.1:33418/cb', 'http://[::1]:9000/cb', 'cursor://anysphere.cursor-retrieval/oauth/callback']
    const res = await postJson('/register', { redirect_uris: uris })
    expect(res.status).toBe(201)
    const b = (await res.json()) as { redirect_uris: string[]; client_name: string }
    expect(b.redirect_uris).toEqual(uris)
    expect(b.client_name).toBe('未命名客户端')
  })

  it('拒绝非本机 http、危险 scheme、fragment', async () => {
    for (const uri of [
      'http://evil.example/cb',
      'http://192.168.1.5:8765/cb',
      'http://localhost.evil.example/cb',
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      'https://app.example/cb#frag',
      'not a url',
      ''
    ]) {
      const res = await postJson('/register', { redirect_uris: [uri] })
      expect(res.status, uri).toBe(400)
      expect(await errorOf(res)).toBe('invalid_redirect_uri')
    }
  })

  it('redirect_uris 缺失、空数组、超过 10 个被拒', async () => {
    for (const body of [{}, { redirect_uris: [] }, { redirect_uris: REDIRECT }, { redirect_uris: Array.from({ length: 11 }, (_, i) => `${REDIRECT}/${i}`) }]) {
      const res = await postJson('/register', body)
      expect(res.status).toBe(400)
      expect(await errorOf(res)).toBe('invalid_redirect_uri')
    }
  })

  it('请求体不是 JSON 对象被拒', async () => {
    for (const body of ['not json', '[1,2]', 'null']) {
      const res = await postJson('/register', body)
      expect(res.status).toBe(400)
      expect(await errorOf(res)).toBe('invalid_client_metadata')
    }
  })

  it('client_name 截断到 60 字并去掉控制字符', async () => {
    const res = await postJson('/register', { client_name: '名'.repeat(80), redirect_uris: [REDIRECT] })
    expect(((await res.json()) as { client_name: string }).client_name).toBe('名'.repeat(60))
    const res2 = await postJson('/register', { client_name: 'Ev\u202eil\u0000 App', redirect_uris: [REDIRECT] })
    expect(((await res2.json()) as { client_name: string }).client_name).toBe('Evil App')
  })

  it('请求体超过 64KB 返回 413', async () => {
    const res = await postJson('/register', { client_name: 'x'.repeat(70 * 1024), redirect_uris: [REDIRECT] })
    expect(res.status).toBe(413)
  })

  it('客户端满 100 个时淘汰最久未完成授权的', async () => {
    const authed = await fullFlow('a1') // 有 grant，不能被淘汰
    const ids: string[] = []
    for (let i = 0; i < 99; i++) {
      clock += 1
      ids.push(await registerClient())
    }
    clock += 1
    const extra = await registerClient() // 第 101 个：淘汰 ids[0]
    const { challenge } = pkce()
    expect((await authorize(authParams(ids[0], challenge))).status).toBe(400)
    expect((await authorize(authParams(ids[1], challenge))).status).toBe(200)
    expect((await authorize(authParams(extra, challenge))).status).toBe(200)
    expect(ctx.oauth.verifyAccessToken(authed.access)).toBe('a1')
    expect((await refreshWith(authed.clientId, authed.refresh)).status).toBe(200)
  })

  it('100 个客户端都已授权时拒绝注册', { timeout: 60_000 }, async () => {
    for (let i = 0; i < 100; i++) {
      clock += 1
      await fullFlow('a1')
    }
    const res = await postJson('/register', { redirect_uris: [REDIRECT] })
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe('invalid_client_metadata')
  })
})

describe('授权页', () => {
  it('未知客户端返回 400 且不跳转', async () => {
    const res = await authorize(authParams('wbc_nope', pkce().challenge))
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    expect(await res.text()).toContain('未知的客户端')
    expect(ctx.oauth.listPending()).toHaveLength(0)
  })

  it('回调地址不匹配返回 400 且不跳转', async () => {
    const cid = await registerClient()
    for (const uri of [`${REDIRECT}/x`, 'https://evil.example/cb', REDIRECT + '?a=1', '']) {
      const res = await authorize(authParams(cid, pkce().challenge, { redirect_uri: uri }))
      expect(res.status, uri).toBe(400)
      expect(res.headers.get('location')).toBeNull()
    }
    // 缺 redirect_uri 也不行
    const p = authParams(cid, pkce().challenge)
    delete p.redirect_uri
    const res = await authorize(p)
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    expect(ctx.oauth.listPending()).toHaveLength(0)
  })

  it('其他参数错误显示错误页', async () => {
    const cid = await registerClient()
    const { challenge } = pkce()
    const cases: Record<string, string>[] = [
      { ...authParams(cid, challenge), response_type: 'token' },
      { ...authParams(cid, challenge), code_challenge_method: 'plain' },
      { ...authParams(cid, challenge), code_challenge: 'short' }
    ]
    const noChallenge = authParams(cid, challenge)
    delete noChallenge.code_challenge
    cases.push(noChallenge)
    const noMethod = authParams(cid, challenge)
    delete noMethod.code_challenge_method
    cases.push(noMethod)
    for (const c of cases) {
      const res = await authorize(c)
      expect(res.status).toBe(400)
      expect(res.headers.get('location')).toBeNull()
      expect(res.headers.get('content-type')).toMatch(/text\/html/)
    }
    expect(ctx.oauth.listPending()).toHaveLength(0)
  })

  it('合法请求生成待批准项，页面含配对码和安全头', async () => {
    const cid = await registerClient()
    const { res, html, id } = await startAuth(cid, pkce().challenge, { scope: 'mcp', resource: `${ctx.base}/mcp` })
    const list = ctx.oauth.listPending()
    expect(list).toHaveLength(1)
    const p = list[0]
    expect(p.id).toBe(id)
    expect(p.pairCode).toMatch(/^\d{4}$/)
    expect(p.clientId).toBe(cid)
    expect(p.clientName).toBe('Test App')
    expect(p.redirectHost).toBe('chatgpt.com')
    expect(p.createdAt).toBe(clock)
    expect(p.expiresAt).toBe(clock + 10 * MIN)
    expect(pendingChanges).toBe(1)

    expect(html).toContain(p.pairCode)
    expect(html).toContain('请在这台电脑的 Workspace Bridge 里核对配对码并批准')
    expect(html).toContain('chatgpt.com')
    const csp = res.headers.get('content-security-policy') ?? ''
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1]
    expect(nonce).toBeTruthy()
    expect(html).toContain(`<script nonce="${nonce}">`)
    for (const d of ["default-src 'none'", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) {
      expect(csp).toContain(d)
    }
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('cache-control')).toBe('no-store')
    // 页面上没有表单或同意按钮：批准只能在桌面应用里做
    expect(html).not.toMatch(/<form|<button/i)
  })

  it('客户端名做 HTML 转义', async () => {
    const cid = await registerClient({ client_name: '<script>alert(1)</script>' })
    const { html } = await startAuth(cid, pkce().challenge)
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html.match(/<script/g)).toHaveLength(1)
    expect(ctx.oauth.listPending()[0].clientName).toBe('<script>alert(1)</script>')
  })

  it('待批准请求 10 分钟后过期', async () => {
    const cid = await registerClient()
    const { id, k } = await startAuth(cid, pkce().challenge)
    clock += 10 * MIN - 1
    expect(ctx.oauth.listPending()).toHaveLength(1)
    clock += 1
    const before = pendingChanges
    expect(ctx.oauth.listPending()).toHaveLength(0)
    expect(pendingChanges).toBe(before + 1)
    expect((await poll(id, k)).body).toEqual({ status: 'expired' })
    expect(() => ctx.oauth.approve(id, 'a1')).toThrow(/过期/)
  })

  it('同时最多 10 个待批准请求', async () => {
    const cid = await registerClient()
    const ids: string[] = []
    for (let i = 0; i < 10; i++) ids.push((await startAuth(cid, pkce().challenge)).id)
    expect(new Set(ctx.oauth.listPending().map((p) => p.pairCode)).size).toBe(10)
    const res = await authorize(authParams(cid, pkce().challenge))
    expect(res.status).toBe(429)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    // 处理掉一个就能再发起
    ctx.oauth.deny(ids[0])
    expect((await authorize(authParams(cid, pkce().challenge))).status).toBe(200)
  })
})

describe('状态轮询与批准', () => {
  it('browserKey 不对返回 404', async () => {
    const cid = await registerClient()
    const { id, k } = await startAuth(cid, pkce().challenge)
    expect((await poll(id, 'wrong')).status).toBe(404)
    expect((await poll(id, k.slice(0, -1))).status).toBe(404)
    expect((await poll(id, '')).status).toBe(404)
    expect((await poll('pa_nope', k)).status).toBe(404)
    expect((await get(`/authorize/status?id=${id}`)).status).toBe(404)
  })

  it('批准后返回带 code 和 state 的跳转地址', async () => {
    const redirect = 'https://claude.ai/api/mcp/auth_callback?x=1'
    const cid = await registerClient({ redirect_uris: [redirect] })
    const state = 'a b&c=d/é'
    const { id, k } = await startAuth(cid, pkce().challenge, { redirect_uri: redirect, state })
    expect((await poll(id, k)).body).toEqual({ status: 'pending' })

    expect(() => ctx.oauth.approve(id, 'ghost')).toThrow(/AI 身份/)
    expect((await poll(id, k)).body).toEqual({ status: 'pending' })
    const before = pendingChanges
    ctx.oauth.approve(id, 'a1')
    expect(pendingChanges).toBe(before + 1)
    expect(ctx.oauth.listPending()).toHaveLength(0)

    const s = await poll(id, k)
    expect(s.body.status).toBe('approved')
    const u = new URL(s.body.redirect!)
    expect(u.origin + u.pathname).toBe('https://claude.ai/api/mcp/auth_callback')
    expect(u.searchParams.get('x')).toBe('1')
    expect(u.searchParams.get('state')).toBe(state)
    expect(u.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // 结果可以重复读取
    expect((await poll(id, k)).body.redirect).toBe(s.body.redirect)
    // 不能重复批准或在批准后拒绝
    expect(() => ctx.oauth.approve(id, 'a2')).toThrow()
    ctx.oauth.deny(id)
    expect((await poll(id, k)).body.status).toBe('approved')
  })

  it('不带 state 时跳转地址里也没有 state', async () => {
    const cid = await registerClient()
    const { id, k } = await startAuth(cid, pkce().challenge)
    ctx.oauth.approve(id, 'a1')
    const u = new URL((await poll(id, k)).body.redirect!)
    expect(u.searchParams.has('state')).toBe(false)
    expect(u.searchParams.has('code')).toBe(true)
  })

  it('拒绝后返回 access_denied', async () => {
    const cid = await registerClient()
    const { id, k } = await startAuth(cid, pkce().challenge, { state: 'xyz' })
    const before = pendingChanges
    ctx.oauth.deny(id)
    expect(pendingChanges).toBe(before + 1)
    const s = await poll(id, k)
    expect(s.body.status).toBe('denied')
    const u = new URL(s.body.redirect!)
    expect(u.origin + u.pathname).toBe(REDIRECT)
    expect(u.searchParams.get('error')).toBe('access_denied')
    expect(u.searchParams.get('state')).toBe('xyz')
    expect(u.searchParams.has('code')).toBe(false)
    expect(() => ctx.oauth.approve(id, 'a1')).toThrow()
  })

  it('批准不存在的请求报错', () => {
    expect(() => ctx.oauth.approve('pa_nope', 'a1')).toThrow(/不存在/)
    expect(() => ctx.oauth.deny('pa_nope')).not.toThrow()
  })
})

describe('令牌交换', () => {
  it('正确的 code_verifier 换到 token', async () => {
    const a = await approvedCode('a1')
    const res = await exchangeCode(a)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const t = (await res.json()) as Tokens
    expect(t.token_type).toBe('Bearer')
    expect(t.expires_in).toBe(28800)
    expect(t.access_token).toMatch(/^wbat_[A-Za-z0-9_-]{43}$/)
    expect(t.refresh_token).toMatch(/^wbrt_[A-Za-z0-9_-]{43}$/)
    expect(ctx.oauth.verifyAccessToken(t.access_token)).toBe('a1')
    expect(ctx.oauth.verifyAccessToken(t.refresh_token)).toBeUndefined()
    expect(ctx.oauth.verifyAccessToken('wbat_nope')).toBeUndefined()

    const grants = ctx.oauth.listGrants()
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({ agentId: 'a1', clientId: a.clientId, clientName: 'Test App', createdAt: clock })
  })

  it('也接受 JSON 请求体', async () => {
    const a = await approvedCode('a2')
    const res = await postJson('/token', {
      grant_type: 'authorization_code',
      code: a.code,
      redirect_uri: REDIRECT,
      client_id: a.clientId,
      code_verifier: a.verifier
    })
    expect(res.status).toBe(200)
    expect(ctx.oauth.verifyAccessToken(((await res.json()) as Tokens).access_token)).toBe('a2')
  })

  it('错误的 verifier、redirect_uri、client_id 被拒，之后正确请求仍可用', async () => {
    const a = await approvedCode('a1')
    const other = await registerClient()
    const wrongVerifier = await exchangeCode(a, { code_verifier: pkce().verifier })
    expect(wrongVerifier.status).toBe(400)
    expect(await errorOf(wrongVerifier)).toBe('invalid_grant')

    const shortVerifier = await exchangeCode(a, { code_verifier: 'abc' })
    expect(shortVerifier.status).toBe(400)
    expect(await errorOf(shortVerifier)).toBe('invalid_request')

    const wrongRedirect = await exchangeCode(a, { redirect_uri: 'https://chatgpt.com/other' })
    expect(wrongRedirect.status).toBe(400)
    expect(await errorOf(wrongRedirect)).toBe('invalid_grant')

    const wrongClient = await exchangeCode(a, { client_id: other })
    expect(wrongClient.status).toBe(400)
    expect(await errorOf(wrongClient)).toBe('invalid_grant')

    const unknownClient = await exchangeCode(a, { client_id: 'wbc_nope' })
    expect(unknownClient.status).toBe(400)
    expect(await errorOf(unknownClient)).toBe('invalid_client')

    const wrongCode = await exchangeCode(a, { code: 'nope' })
    expect(await errorOf(wrongCode)).toBe('invalid_grant')

    expect(ctx.oauth.listGrants()).toHaveLength(0)
    expect((await exchangeCode(a)).status).toBe(200)
  })

  it('授权码重放被拒，并吊销已签发的授权', async () => {
    const a = await approvedCode('a1')
    const first = (await (await exchangeCode(a)).json()) as Tokens
    expect(ctx.oauth.verifyAccessToken(first.access_token)).toBe('a1')
    const replay = await exchangeCode(a)
    expect(replay.status).toBe(400)
    expect(await errorOf(replay)).toBe('invalid_grant')
    expect(ctx.oauth.verifyAccessToken(first.access_token)).toBeUndefined()
    expect(ctx.oauth.listGrants()).toHaveLength(0)
    expect((await refreshWith(a.clientId, first.refresh_token)).status).toBe(400)
  })

  it('授权码 5 分钟后过期', async () => {
    const a = await approvedCode('a1')
    clock += 5 * MIN
    const res = await exchangeCode(a)
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe('invalid_grant')
  })

  it('批准后、换 token 前身份被吊销，授权码失效', async () => {
    const a = await approvedCode('a1')
    agents.delete('a1')
    const res = await exchangeCode(a)
    expect(await errorOf(res)).toBe('invalid_grant')
  })

  it('参数错误', async () => {
    const r1 = await postForm('/token', { grant_type: 'password', username: 'x' })
    expect(r1.status).toBe(400)
    expect(await errorOf(r1)).toBe('unsupported_grant_type')
    const r2 = await postForm('/token', {})
    expect(await errorOf(r2)).toBe('invalid_request')
    const r3 = await postForm('/token', { grant_type: 'authorization_code', code: 'x' })
    expect(await errorOf(r3)).toBe('invalid_request')
    const r4 = await fetch(ctx.base + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&grant_type=authorization_code'
    })
    expect(await errorOf(r4)).toBe('invalid_request')
  })
})

describe('refresh token 轮换', () => {
  it('轮换签发新 token，旧 refresh 重放吊销整个授权', async () => {
    const f = await fullFlow('a1')
    clock += HOUR
    const res = await refreshWith(f.clientId, f.refresh)
    expect(res.status).toBe(200)
    const t2 = (await res.json()) as Tokens
    expect(t2.access_token).not.toBe(f.access)
    expect(t2.refresh_token).not.toBe(f.refresh)
    expect(t2.expires_in).toBe(28800)
    expect(ctx.oauth.verifyAccessToken(t2.access_token)).toBe('a1')
    // 设计选择：轮换后旧 access 立即失效
    expect(ctx.oauth.verifyAccessToken(f.access)).toBeUndefined()

    // 新 refresh 继续可用
    const res3 = await refreshWith(f.clientId, t2.refresh_token)
    expect(res3.status).toBe(200)
    const t3 = (await res3.json()) as Tokens

    // 重放上一个 refresh（t2 的）→ 整个授权作废
    const replay = await refreshWith(f.clientId, t2.refresh_token)
    expect(replay.status).toBe(400)
    expect(await errorOf(replay)).toBe('invalid_grant')
    expect(ctx.oauth.verifyAccessToken(t3.access_token)).toBeUndefined()
    expect((await refreshWith(f.clientId, t3.refresh_token)).status).toBe(400)
    expect(ctx.oauth.listGrants()).toHaveLength(0)
  })

  it('refresh token 和客户端不匹配被拒，授权不受影响', async () => {
    const f = await fullFlow('a1')
    const other = await registerClient()
    const res = await refreshWith(other, f.refresh)
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe('invalid_grant')
    expect(ctx.oauth.verifyAccessToken(f.access)).toBe('a1')
    expect((await refreshWith(f.clientId, f.refresh)).status).toBe(200)
  })

  it('refresh token 30 天后过期', async () => {
    const f = await fullFlow('a1')
    clock += 30 * 24 * HOUR
    const res = await refreshWith(f.clientId, f.refresh)
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe('invalid_grant')
  })
})

describe('令牌失效', () => {
  it('access token 8 小时后过期，refresh 仍可续期', async () => {
    const f = await fullFlow('a1')
    clock += 8 * HOUR - 1
    expect(ctx.oauth.verifyAccessToken(f.access)).toBe('a1')
    clock += 1
    expect(ctx.oauth.verifyAccessToken(f.access)).toBeUndefined()
    const res = await refreshWith(f.clientId, f.refresh)
    expect(res.status).toBe(200)
    expect(ctx.oauth.verifyAccessToken(((await res.json()) as Tokens).access_token)).toBe('a1')
  })

  it('AI 身份不存在时 token 失效', async () => {
    const f = await fullFlow('a1')
    agents.delete('a1')
    expect(ctx.oauth.verifyAccessToken(f.access)).toBeUndefined()
    const res = await refreshWith(f.clientId, f.refresh)
    expect(await errorOf(res)).toBe('invalid_grant')
  })

  it('revokeAgent 吊销某个 AI 的全部授权', async () => {
    const f1 = await fullFlow('a1')
    const f2 = await fullFlow('a1')
    const g = await fullFlow('a2')
    expect(ctx.oauth.revokeAgent('a1')).toBe(2)
    expect(ctx.oauth.verifyAccessToken(f1.access)).toBeUndefined()
    expect(ctx.oauth.verifyAccessToken(f2.access)).toBeUndefined()
    expect(ctx.oauth.verifyAccessToken(g.access)).toBe('a2')
    expect((await refreshWith(f1.clientId, f1.refresh)).status).toBe(400)
    expect(ctx.oauth.revokeAgent('a1')).toBe(0)
  })

  it('revokeAgent 也作废已批准未兑换的授权码', async () => {
    const a = await approvedCode('a1')
    ctx.oauth.revokeAgent('a1')
    expect(await errorOf(await exchangeCode(a))).toBe('invalid_grant')
  })

  it('revokeGrant 吊销单个授权', async () => {
    const f1 = await fullFlow('a1')
    const f2 = await fullFlow('a1')
    const g1 = ctx.oauth.listGrants().find((g) => g.clientId === f1.clientId)!
    ctx.oauth.revokeGrant(g1.id)
    expect(ctx.oauth.verifyAccessToken(f1.access)).toBeUndefined()
    expect(ctx.oauth.verifyAccessToken(f2.access)).toBe('a1')
    expect(ctx.oauth.listGrants()).toHaveLength(1)
    expect(() => ctx.oauth.revokeGrant('og_nope')).not.toThrow()
  })

  it('verifyAccessToken 更新 lastUsedAt（只在内存）', async () => {
    const f = await fullFlow('a1')
    const created = clock
    const before = fs.readFileSync(ctx.file, 'utf8')
    clock += MIN
    expect(ctx.oauth.verifyAccessToken(f.access)).toBe('a1')
    expect(ctx.oauth.listGrants()[0].lastUsedAt).toBe(created + MIN)
    expect(fs.readFileSync(ctx.file, 'utf8')).toBe(before)
  })
})

describe('持久化', () => {
  it('重启后旧 token 仍然有效，文件里没有 token 明文', async () => {
    const f = await fullFlow('a1')
    clock += MIN
    expect(ctx.oauth.verifyAccessToken(f.access)).toBe('a1')
    ctx.oauth.close()

    const text = fs.readFileSync(ctx.file, 'utf8')
    expect(text).not.toContain(f.access)
    expect(text).not.toContain(f.refresh)
    expect(text).not.toContain(f.access.slice(5))
    expect(text).not.toContain(f.refresh.slice(5))
    expect(text).not.toContain(f.code)
    expect(text).toContain(crypto.createHash('sha256').update(f.access).digest('hex'))

    const restarted = await start(ctx.file)
    expect(restarted.oauth.verifyAccessToken(f.access)).toBe('a1')
    const grants = restarted.oauth.listGrants()
    expect(grants).toHaveLength(1)
    expect(grants[0].clientName).toBe('Test App')
    // close 时把内存里的 lastUsedAt 落盘了
    expect(grants[0].lastUsedAt).toBe(clock)

    const res = await refreshWith(f.clientId, f.refresh, restarted)
    expect(res.status).toBe(200)
    expect(restarted.oauth.verifyAccessToken(((await res.json()) as Tokens).access_token)).toBe('a1')
  })

  it('待批准请求和授权码重启后失效', async () => {
    const cid = await registerClient()
    const { id } = await startAuth(cid, pkce().challenge)
    const a = await approvedCode('a1', cid)
    ctx.oauth.close()
    const restarted = await start(ctx.file)
    expect(restarted.oauth.listPending()).toHaveLength(0)
    expect(() => restarted.oauth.approve(id, 'a1')).toThrow()
    const res = await postForm(
      '/token',
      { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, client_id: cid, code_verifier: a.verifier },
      restarted
    )
    expect(await errorOf(res)).toBe('invalid_grant')
    // 客户端注册是持久的
    expect((await get('/authorize?' + new URLSearchParams(authParams(cid, pkce().challenge)), restarted)).status).toBe(200)
  })
})
