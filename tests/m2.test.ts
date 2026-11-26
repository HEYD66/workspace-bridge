// M2 集成测试：局域网开关与 Host 白名单、/mcp 的 401 与 OAuth 发现、CORS、JSON 响应、
// 完整 OAuth 授权流程（批准、拒绝、吊销、重启保留）。
// 真实 Bridge + 真实 MCP SDK 客户端，每个用例一个干净的数据目录和工作区
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import type { Agent } from '../src/core/types'

const LAN_IP = '192.168.50.7'
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect'
const CLIENT_NAME = 'ChatGPT'
const STATE = 'st-m2'
const ACCEPT = 'application/json, text/event-stream'
const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'm2-raw', version: '1.0.0' } }
})

let base: string
let root: string
let bridge: Bridge
const clients: Client[] = []

function newBridge(): Bridge {
  return new Bridge({
    dataDir: path.join(base, 'data'),
    workspaceRoot: root,
    port: 0,
    // 测试只监听本机，避免 Windows 防火墙弹窗；局域网 IP 用固定值
    lanListenHost: '127.0.0.1',
    lanAddresses: () => [LAN_IP]
  })
}

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-m2-'))
  root = path.join(base, 'ws')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'README.md'), '# m2\n')
  bridge = newBridge()
  // 这组用例测的是 OAuth 模式（默认是链接直连）
  bridge.setAuthMode('oauth')
  await bridge.start()
})

afterEach(async () => {
  await closeClients()
  await bridge.stop()
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

// ---- 地址：切换局域网、重启后端口会变（port: 0），所以每次现取 ----

const port = () => bridge.getState().port
const mcpUrl = () => bridge.getState().mcpUrl
/** 本机根地址，如 http://127.0.0.1:12345 */
const baseUrl = () => new URL(mcpUrl()).origin

// ---- HTTP 工具 ----

interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

/** 用 node:http 连 127.0.0.1，但 Host 头自己定：fetch 不允许改 Host，测白名单只能这样 */
function rawRequest(opts: { host: string; path?: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: port(),
        path: opts.path ?? '/mcp',
        method: opts.method ?? 'POST',
        headers: { Host: opts.host, 'Content-Type': 'application/json', Accept: ACCEPT, ...opts.headers },
        // 不复用连接：服务会重启、换端口
        agent: false
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end(opts.body ?? INIT)
  })
}

/** 向 /mcp 发一次 initialize，返回状态码（响应体读完，不让连接挂着）；token 为 undefined 时不带 Authorization 头 */
async function initStatus(token: string | undefined, url = mcpUrl()): Promise<number> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: ACCEPT }
  if (token !== undefined) headers.Authorization = `Bearer ${token}`
  const res = await fetch(url, { method: 'POST', headers, body: INIT })
  await res.text()
  return res.status
}

async function closeClients(): Promise<void> {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
}

/** 真实 SDK 客户端，用 Bearer 头连接 */
async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 'm2-test', version: '1.0.0' })
  clients.push(c)
  await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl()), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  return c
}

/** 连上后调 whoami，返回服务端认定的 AI 名字 */
async function whoami(token: string): Promise<string> {
  const c = await connect(token)
  const r = await c.callTool({ name: 'whoami', arguments: {} })
  expect(r.isError).toBeFalsy()
  return (JSON.parse((r.content as { type: string; text: string }[])[0].text) as { agent: string }).agent
}

// ---- OAuth 工具（从 tests/oauth.test.ts 复制并按 Bridge 改写） ----

interface Tokens {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
}

interface AuthStart {
  clientId: string
  verifier: string
  /** 待批准请求 id */
  id: string
  /** browserKey，轮询状态时要带 */
  k: string
  /** 授权页上显示的配对码 */
  pairCode: string
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

function postForm(p: string, params: Record<string, string>) {
  return fetch(baseUrl() + p, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  })
}

async function registerClient(): Promise<string> {
  const res = await fetch(baseUrl() + '/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: CLIENT_NAME, redirect_uris: [REDIRECT] })
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { client_id: string }).client_id
}

/** 注册客户端 → 打开授权页（PKCE S256），从页面脚本取请求 id 和 browserKey，从页面取配对码 */
async function beginAuth(): Promise<AuthStart> {
  const clientId = await registerClient()
  const { verifier, challenge } = pkce()
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: STATE
  })
  const res = await fetch(`${baseUrl()}/authorize?${q}`, { redirect: 'manual' })
  expect(res.status).toBe(200)
  const html = await res.text()
  const cfg = /var cfg = (\{.*?\});/.exec(html)
  expect(cfg).not.toBeNull()
  const { id, k } = JSON.parse(cfg![1]) as { id: string; k: string }
  const code = /<div id="code" class="code">([^<]+)<\/div>/.exec(html)
  expect(code).not.toBeNull()
  return { clientId, verifier, id, k, pairCode: code![1] }
}

async function pollStatus(id: string, k: string) {
  const res = await fetch(`${baseUrl()}/authorize/status?id=${encodeURIComponent(id)}&k=${encodeURIComponent(k)}`)
  return { status: res.status, body: (await res.json()) as { status?: string; redirect?: string; error?: string } }
}

/** 像授权页脚本那样轮询，直到不再是 pending（最多约 2 秒） */
async function pollUntilDone(id: string, k: string) {
  for (let i = 0; i < 40; i++) {
    const s = await pollStatus(id, k)
    expect(s.status).toBe(200)
    if (s.body.status !== 'pending') return s
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('授权状态一直是 pending')
}

/** 用授权码换 token，返回 access token */
async function exchange(a: AuthStart, code: string): Promise<string> {
  const res = await postForm('/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: a.clientId,
    code_verifier: a.verifier
  })
  expect(res.status).toBe(200)
  const t = (await res.json()) as Tokens
  expect(t.token_type).toBe('Bearer')
  expect(t.access_token.startsWith('wbat_')).toBe(true)
  return t.access_token
}

/** 完整流程：注册 → 授权页 → 桌面批准 → 轮询拿授权码 → 换 token */
async function oauthAccess(agent: Agent): Promise<string> {
  const a = await beginAuth()
  bridge.approveOAuth(a.id, agent.id)
  const s = await pollUntilDone(a.id, a.k)
  expect(s.body.status).toBe('approved')
  return exchange(a, new URL(s.body.redirect!).searchParams.get('code')!)
}

// ---- 用例 ----

describe('局域网开关与 Host 白名单', () => {
  it('局域网关闭时，Host 为局域网 IP 的请求返回 421', async () => {
    const s = bridge.getState()
    expect(s.lanEnabled).toBe(false)
    expect(s.urls.local).toBe(s.mcpUrl)
    expect(s.urls.lan).toEqual([])
    expect((await rawRequest({ host: `${LAN_IP}:${s.port}` })).status).toBe(421)
    // 本机 Host 不受影响：无 token → 401
    expect((await rawRequest({ host: `127.0.0.1:${s.port}` })).status).toBe(401)
  })

  it('开启后放行局域网 IP，其他 Host 仍是 421；关掉后恢复 421', async () => {
    await bridge.setLanEnabled(true)
    const on = bridge.getState()
    expect(on.lanEnabled).toBe(true)
    expect(on.urls.lan).toEqual([`http://${LAN_IP}:${on.port}/mcp`])

    const lan = await rawRequest({ host: `${LAN_IP}:${on.port}` })
    expect(lan.status).toBe(401)
    // 局域网访问时 baseUrl 取自 Host 头
    expect(lan.headers['www-authenticate']).toContain(`resource_metadata="http://${LAN_IP}:${on.port}/.well-known/oauth-protected-resource"`)
    expect((await rawRequest({ host: `evil.example:${on.port}` })).status).toBe(421)
    expect((await rawRequest({ host: `127.0.0.1:${on.port}` })).status).toBe(401)

    await bridge.setLanEnabled(false)
    const off = bridge.getState()
    expect(off.lanEnabled).toBe(false)
    expect(off.urls.lan).toEqual([])
    expect((await rawRequest({ host: `${LAN_IP}:${off.port}` })).status).toBe(421)
  })
})

describe('/mcp 认证、OAuth 发现与传输', () => {
  it('无 token 返回 401，WWW-Authenticate 指向受保护资源元数据', async () => {
    const res = await fetch(mcpUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: ACCEPT }, body: INIT })
    await res.text()
    expect(res.status).toBe(401)
    const www = res.headers.get('www-authenticate') ?? ''
    expect(www).toMatch(/^Bearer /)
    const metaUrl = `${baseUrl()}/.well-known/oauth-protected-resource`
    expect(www).toContain(`resource_metadata="${metaUrl}"`)

    // 顺着元数据地址能找到资源和授权服务器
    const meta = (await (await fetch(metaUrl)).json()) as { resource: string; authorization_servers: string[] }
    expect(meta.resource).toBe(mcpUrl())
    expect(meta.authorization_servers).toEqual([baseUrl()])

    // 伪造的 OAuth 前缀 token 同样 401
    expect(await initStatus('wbat_bogus')).toBe(401)
  })

  it('OAuth 元数据接受浏览器跨站请求（CORS），/mcp 带 Origin 仍是 403', async () => {
    const res = await fetch(`${baseUrl()}/.well-known/oauth-authorization-server`, { headers: { Origin: 'https://chatgpt.com' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const m = (await res.json()) as { issuer: string; token_endpoint: string }
    expect(m.issuer).toBe(baseUrl())
    expect(m.token_endpoint).toBe(`${baseUrl()}/token`)

    const agent = bridge.createAgent('Alice')
    const mcp = await fetch(mcpUrl(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${agent.token}`, Origin: 'https://chatgpt.com', 'Content-Type': 'application/json', Accept: ACCEPT },
      body: INIT
    })
    await mcp.text()
    expect(mcp.status).toBe(403)
  })

  it('GET /mcp 返回 405，POST 的响应是 JSON 而不是 SSE', async () => {
    const agent = bridge.createAgent('Alice')
    const auth = { Authorization: `Bearer ${agent.token}` }

    const get = await fetch(mcpUrl(), { headers: { ...auth, Accept: 'text/event-stream' } })
    await get.text()
    expect(get.status).toBe(405)

    const post = await fetch(mcpUrl(), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Accept: ACCEPT }, body: INIT })
    expect(post.status).toBe(200)
    expect(post.headers.get('content-type')).toMatch(/^application\/json/)
    const body = (await post.json()) as { result?: { serverInfo?: unknown } }
    expect(body.result?.serverInfo).toBeDefined()
    const sid = post.headers.get('mcp-session-id')
    expect(sid).toBeTruthy()

    // SDK 客户端握手后会带 session id 试着开 SSE 流，这里也必须是 405
    const getWithSession = await fetch(mcpUrl(), {
      headers: { ...auth, Accept: 'text/event-stream', 'Mcp-Session-Id': sid!, 'Mcp-Protocol-Version': LATEST_PROTOCOL_VERSION }
    })
    await getWithSession.text()
    expect(getWithSession.status).toBe(405)
  })
})

describe('OAuth 授权流程', () => {
  it('注册 → 授权页 → 桌面批准 → 换 token → 用 access token 调用 MCP', async () => {
    const agent = bridge.createAgent('GPT-Alice')
    expect(bridge.getState().oauthPending).toEqual([])

    const a = await beginAuth()
    const pending = bridge.getState().oauthPending
    expect(pending).toHaveLength(1)
    expect(pending[0].id).toBe(a.id)
    expect(pending[0].pairCode).toMatch(/^\d{4}$/)
    // 桌面弹窗里的配对码和浏览器页上显示的一致
    expect(pending[0].pairCode).toBe(a.pairCode)
    expect(pending[0].clientName).toBe(CLIENT_NAME)
    expect(pending[0].redirectHost).toBe('chatgpt.com')
    expect((await pollStatus(a.id, a.k)).body.status).toBe('pending')

    bridge.approveOAuth(a.id, agent.id)
    expect(bridge.getState().oauthPending).toEqual([])
    const s = await pollUntilDone(a.id, a.k)
    expect(s.body.status).toBe('approved')
    const redirect = new URL(s.body.redirect!)
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT)
    expect(redirect.searchParams.get('state')).toBe(STATE)

    const access = await exchange(a, redirect.searchParams.get('code')!)
    expect(await whoami(access)).toBe('GPT-Alice')

    const grants = bridge.listOAuthGrants()
    expect(grants).toHaveLength(1)
    expect(grants[0].agentId).toBe(agent.id)
    expect(grants[0].clientName).toBe(CLIENT_NAME)

    // 路径 token 只接受静态 token（不带 Authorization 头，否则头会优先于路径）
    expect(await initStatus(undefined, `${mcpUrl()}/${access}`)).toBe(401)
    expect(await initStatus(undefined, `${mcpUrl()}/${agent.token}`)).toBe(200)
  })

  it('桌面拒绝后浏览器读到 denied，待批准列表清空', async () => {
    const a = await beginAuth()
    expect(bridge.getState().oauthPending).toHaveLength(1)

    bridge.denyOAuth(a.id)
    expect(bridge.getState().oauthPending).toEqual([])
    const s = await pollUntilDone(a.id, a.k)
    expect(s.body.status).toBe('denied')
    const redirect = new URL(s.body.redirect!)
    expect(redirect.searchParams.get('error')).toBe('access_denied')
    expect(redirect.searchParams.get('state')).toBe(STATE)
    expect(redirect.searchParams.get('code')).toBeNull()
    expect(bridge.listOAuthGrants()).toEqual([])
  })

  it('吊销授权、更换 token、吊销身份后，access token 立即失效', async () => {
    const agent = bridge.createAgent('Alice')

    // 单独吊销一个授权
    const t1 = await oauthAccess(agent)
    expect(await initStatus(t1)).toBe(200)
    const g1 = bridge.listOAuthGrants().find((g) => g.agentId === agent.id)
    expect(g1).toBeDefined()
    bridge.revokeOAuthGrant(g1!.id)
    expect(bridge.listOAuthGrants()).toEqual([])
    expect(await initStatus(t1)).toBe(401)

    // 更换静态 token：这个 AI 的 OAuth 授权一并作废，旧静态 token 失效，新静态 token 可用
    const oldToken = agent.token
    const t2 = await oauthAccess(agent)
    expect(await initStatus(t2)).toBe(200)
    const rotated = await bridge.rotateToken(agent.id)
    expect(rotated.token).not.toBe(oldToken)
    expect(await initStatus(t2)).toBe(401)
    expect(await initStatus(oldToken)).toBe(401)
    expect(bridge.listOAuthGrants()).toEqual([])
    expect(await whoami(rotated.token)).toBe('Alice')

    // 吊销身份
    const t3 = await oauthAccess(agent)
    expect(await whoami(t3)).toBe('Alice')
    await closeClients()
    await bridge.removeAgent(agent.id)
    expect(await initStatus(t3)).toBe(401)
    expect(bridge.listOAuthGrants()).toEqual([])
  })

  it('重启后 OAuth 授权仍然有效', async () => {
    const agent = bridge.createAgent('Alice')
    const access = await oauthAccess(agent)
    expect(await whoami(access)).toBe('Alice')

    // 同一个 Bridge 停止再启动（端口会变，地址现取）
    await closeClients()
    await bridge.stop()
    await bridge.start()
    expect(bridge.getState().running).toBe(true)
    expect(await whoami(access)).toBe('Alice')

    // 模拟应用重启：同一数据目录新建 Bridge，授权从磁盘恢复
    await closeClients()
    await bridge.stop()
    bridge = newBridge()
    await bridge.start()
    expect(await whoami(access)).toBe('Alice')
    expect(bridge.listOAuthGrants().map((g) => g.agentId)).toEqual([agent.id])
  })
})
