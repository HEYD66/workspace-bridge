// 公网冒烟：起真实 Bridge + cloudflared Quick Tunnel，全部经 https://<随机>.trycloudflare.com 验证：
// 401 发现 → OAuth 元数据 → 完整授权码流程（PKCE S256，桌面批准）→ MCP 调用 → 静态 token 路径 → GET 405 → 停止与清理。
// 用法：npx tsx scripts/tunnel-smoke.ts
// 进度打到 stderr，最终 JSON 结果打到 stdout；全部检查通过退出码 0，否则 1。
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { Bridge } from '../src/core/bridge'
import type { Agent } from '../src/core/types'

const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect'
const CLIENT_NAME = 'ChatGPT'
const AGENT_NAME = 'Web-GPT'
const STATE = 'st-smoke-' + crypto.randomBytes(4).toString('hex')
const ACCEPT = 'application/json, text/event-stream'
/** 公网请求重试：只对网络错误和 5xx（含 Cloudflare 的 530）重试 */
const RETRY_MAX = 20
const RETRY_DELAY_MS = 1500
/** 单次请求超时，超时算网络错误参与重试 */
const ATTEMPT_TIMEOUT_MS = 20_000
/** 公网预热：隧道刚 running 时本机 DNS/代理可能还解析不到新域名，先等 /health 连通再做正式检查 */
const WARMUP_MAX_MS = 120_000
const WARMUP_INTERVAL_MS = 2000
/** 整个脚本的看门狗：超时就清理并以非零退出，防止卡死后 cloudflared 留在后台 */
const WATCHDOG_MS = 8 * 60_000
const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'tunnel-smoke-raw', version: '1.0.0' } }
})

// ---- 结果收集 ----

const CHECK_NAMES = [
  'bridgeRunning',
  'tunnelRunning',
  'publicUrlHttps',
  'publicReachable',
  'unauthorized401',
  'resourceMetadataInHeader',
  'protectedResourceMetadata',
  'authServerMetadata',
  'register201',
  'authorizePage200',
  'pendingMatchesPage',
  'pendingClearedAfterApprove',
  'approvedRedirect',
  'tokenExchange',
  'grantRecorded',
  'oauthWhoami',
  'oauthReadFile',
  'staticPathRejected',
  'get405',
  'linkPathAccepted',
  'linkNoOAuthDiscovery',
  'tunnelOffAfterStop',
  'cloudflaredExited',
  'otherCloudflaredUntouched',
  'tempDirRemoved'
] as const
type CheckName = (typeof CHECK_NAMES)[number]

const checks = Object.fromEntries(CHECK_NAMES.map((n) => [n, false])) as Record<CheckName, boolean>
/** 失败检查或失败步骤 → 详情（请求、状态码、响应体原样） */
const failures: Record<string, string> = {}
const timings: Record<string, number> = {}
interface RetryNote {
  step: string
  request: string
  attempt: number
  reason: string
}
const retryLog: RetryNote[] = []
let currentStep = 'init'
const t0 = performance.now()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function log(msg: string): void {
  process.stderr.write(`[${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}\n`)
}

/** 记一项检查；失败时把详情存下来，不抛错（同一步后面的检查还能继续） */
function check(name: CheckName, ok: boolean, detail?: string): boolean {
  checks[name] = ok
  if (ok) log(`  通过 ${name}`)
  else {
    failures[name] = detail ?? '(无详情)'
    log(`  失败 ${name}${detail ? '\n' + indent(detail) : ''}`)
  }
  return ok
}

/** 前置条件不满足时中断当前步骤 */
function must(ok: unknown, msg: string): asserts ok {
  if (!ok) throw new Error(msg)
}

function indent(s: string): string {
  return s
    .split('\n')
    .map((l) => '      ' + l)
    .join('\n')
}

function errText(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const cause = (e as { cause?: unknown }).cause
  const c = cause instanceof Error ? ` (cause: ${(cause as { code?: string }).code ?? ''} ${cause.message})` : ''
  return `${e.name}: ${e.message}${c}`
}

/** 跑一步，记耗时；异常记到 failures，返回是否没抛错 */
async function step(name: string, fn: () => Promise<void>): Promise<boolean> {
  const s = performance.now()
  currentStep = name
  log(`[步骤] ${name}`)
  try {
    await fn()
    return true
  } catch (e) {
    failures[`step:${name}`] = errText(e)
    log(`  步骤中断 ${name}: ${errText(e)}`)
    return false
  } finally {
    timings[name] = Math.round(performance.now() - s)
  }
}

// ---- 脱敏：token 不出现在输出里 ----

function maskUrl(u: string): string {
  return u.replace(/\/mcp\/([^/?#]+)/, (_m, t: string) => `/mcp/${t.slice(0, 6)}…`)
}
function redactTokens(body: string): string {
  return body.replace(/"(access_token|refresh_token)"\s*:\s*"([^"]{0,6})[^"]*"/g, '"$1":"$2…"')
}

// ---- 带重试的 fetch（也注入给 MCP SDK 的 transport） ----

function requestLabel(input: string | URL, init?: RequestInit): string {
  return `${init?.method ?? 'GET'} ${maskUrl(String(input))}`
}

async function retryFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const label = requestLabel(input, init)
  for (let attempt = 1; ; attempt++) {
    const timeout = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    try {
      const res = await fetch(input, { ...init, signal })
      if (res.status >= 500 && attempt < RETRY_MAX) {
        const body = await res.text().catch(() => '')
        const ray = res.headers.get('cf-ray')
        retryLog.push({ step: currentStep, request: label, attempt, reason: `HTTP ${res.status}${ray ? ` cf-ray=${ray}` : ''} ${body.slice(0, 120).replace(/\s+/g, ' ')}` })
        log(`  重试 ${label} 第 ${attempt} 次：HTTP ${res.status}`)
        await sleep(RETRY_DELAY_MS)
        continue
      }
      return res
    } catch (e) {
      // 调用方自己中止的（SDK 关闭连接）不重试
      if (init?.signal?.aborted) throw e
      retryLog.push({ step: currentStep, request: label, attempt, reason: errText(e) })
      log(`  重试 ${label} 第 ${attempt} 次：${errText(e)}`)
      if (attempt >= RETRY_MAX) throw e
      await sleep(RETRY_DELAY_MS)
    }
  }
}

interface Hit {
  request: string
  status: number
  headers: Record<string, string>
  body: string
}

/** 发请求并把响应读完，留下可原样汇报的请求/状态码/响应体 */
async function hit(url: string, init?: RequestInit): Promise<Hit> {
  const res = await retryFetch(url, init)
  const body = await res.text()
  return { request: requestLabel(url, init), status: res.status, headers: Object.fromEntries(res.headers), body }
}

function dump(h: Hit, extra = ''): string {
  const body = redactTokens(h.body)
  return `${extra ? extra + '\n' : ''}${h.request} → ${h.status}\n响应头: ${JSON.stringify(h.headers)}\n响应体: ${body.length > 4000 ? body.slice(0, 4000) + '…(截断)' : body}`
}

function parseJson<T = Record<string, unknown>>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T
  } catch {
    return undefined
  }
}

// ---- cloudflared 进程（只观察，不杀任何进程） ----

/** 当前所有 cloudflared.exe 的 PID；非 Windows 或 tasklist 失败返回 undefined */
function cloudflaredPids(): Set<number> | undefined {
  if (process.platform !== 'win32') return undefined
  const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe')
  const r = spawnSync(exe, ['/FI', 'IMAGENAME eq cloudflared.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  if (r.status !== 0 || typeof r.stdout !== 'string') return undefined
  const out = new Set<number>()
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^"cloudflared\.exe","(\d+)"/i.exec(line.trim())
    if (m) out.add(Number(m[1]))
  }
  return out
}

// ---- MCP 客户端 ----

const clients: Client[] = []

async function connect(url: string, headers?: Record<string, string>): Promise<Client> {
  const c = new Client({ name: 'tunnel-smoke', version: '1.0.0' })
  clients.push(c)
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: retryFetch, ...(headers ? { requestInit: { headers } } : {}) }))
  return c
}

function textOf(r: unknown): string {
  const content = (r as { content?: { type: string; text?: string }[] }).content
  return content?.[0]?.text ?? ''
}

function isError(r: unknown): boolean {
  return !!(r as { isError?: boolean }).isError
}

async function whoamiName(c: Client): Promise<{ name?: string; raw: string; isError: boolean }> {
  const r = await c.callTool({ name: 'whoami', arguments: {} })
  const raw = textOf(r)
  return { name: parseJson<{ agent?: string }>(raw)?.agent, raw, isError: isError(r) }
}

// ---- 主流程 ----

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-tunnel-smoke-'))
const root = path.join(base, 'ws')
const dataDir = path.join(base, 'data')
const README = `# 公网冒烟\n\n经 Cloudflare Quick Tunnel 读取的测试文件。\nmarker: ${crypto.randomBytes(6).toString('hex')}\n`

let bridge: Bridge | undefined
let bridgeStopped = false
let agent: Agent | undefined
let localUrl: string | undefined
let publicMcp: string | undefined
let accessToken: string | undefined
let get405TokenKind: 'oauth' | 'static' | undefined
let cloudflaredPath: string | undefined
let pidsBefore: Set<number> | undefined
let ourPids: number[] = []
/** 隧道是否进入过 running（决定停止后是否必须识别到本脚本的 cloudflared 进程） */
let tunnelWasRunning = false
let tunnelErrorInfo: { error?: string; logTail?: string[] } | undefined

/** 隧道失败时取 cloudflared 最近几行输出帮助诊断（TunnelManager 是 Bridge 的私有成员，这里只读） */
function tunnelLogTail(): string[] | undefined {
  try {
    const t = (bridge as unknown as { tunnel?: { status(): { log: string[] } } }).tunnel
    return t?.status().log.slice(-25)
  } catch {
    return undefined
  }
}

async function run(): Promise<void> {
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'README.md'), README)

  // 1. 起 Bridge、建 AI 身份、开隧道
  const started = await step('startBridge', async () => {
    bridge = new Bridge({ dataDir, workspaceRoot: root, port: 0 })
    // 先测 OAuth 模式，最后切到默认的链接直连模式再测一遍
    bridge.setAuthMode('oauth')
    await bridge.start()
    const st = bridge.getState()
    localUrl = st.urls.local
    check('bridgeRunning', st.running, `running=false, error=${st.error ?? ''}`)
    must(st.running, `MCP 服务没有运行：${st.error ?? ''}`)
    agent = bridge.createAgent(AGENT_NAME)
    log(`  本机 ${st.urls.local}，AI 身份 ${agent.name}（${agent.id}）`)
  })
  if (!started || !bridge || !agent) return
  const b = bridge
  const me = agent

  const tunnelOk = await step('startTunnel', async () => {
    pidsBefore = cloudflaredPids()
    log(`  启动前已有 cloudflared PID: ${pidsBefore ? [...pidsBefore].join(', ') || '(无)' : '(无法获取)'}`)
    await b.startTunnel()
    const st = b.getState()
    cloudflaredPath = st.tunnel.cloudflaredPath
    if (st.tunnel.status !== 'running') {
      tunnelErrorInfo = { error: st.tunnel.error, logTail: tunnelLogTail() }
      log(`  隧道状态 ${st.tunnel.status}，错误：${st.tunnel.error ?? '(无)'}`)
      for (const l of tunnelErrorInfo.logTail ?? []) log(`    cloudflared> ${l}`)
    }
    check('tunnelRunning', st.tunnel.status === 'running', `status=${st.tunnel.status}, error=${st.tunnel.error ?? ''}`)
    must(st.tunnel.status === 'running' && st.urls.public, '隧道没有进入 running')
    tunnelWasRunning = true
    publicMcp = st.urls.public
    check('publicUrlHttps', /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/mcp$/.test(publicMcp), `urls.public=${publicMcp}`)
    log(`  公网地址 ${publicMcp}`)
    const after = cloudflaredPids()
    if (after && pidsBefore) ourPids = [...after].filter((p) => !pidsBefore!.has(p))
    log(`  本脚本启动的 cloudflared PID: ${ourPids.join(', ') || '(未识别)'}`)
  })
  if (!tunnelOk || !publicMcp) return
  const pub = publicMcp
  const pubBase = new URL(pub).origin

  // 1b. 公网预热：轮询 /health（无需认证）直到连通。网络错误和 5xx/530 说明地址还没生效，继续等；
  // 其他非 200（如 421 Host 不被允许）是实现问题，立即失败并原样记录
  const warm = await step('publicWarmup', async () => {
    const healthUrl = `${pubBase}/health`
    const deadline = performance.now() + WARMUP_MAX_MS
    for (let attempt = 1; ; attempt++) {
      let reason: string
      try {
        const res = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) })
        const body = await res.text()
        if (res.status === 200 && parseJson<{ ok?: boolean }>(body)?.ok === true) {
          check('publicReachable', true)
          log(`  公网连通：第 ${attempt} 次尝试`)
          return
        }
        if (res.status < 500) {
          const h: Hit = { request: `GET ${healthUrl}`, status: res.status, headers: Object.fromEntries(res.headers), body }
          check('publicReachable', false, dump(h, '期望 200 {"ok":true}'))
          throw new Error(`公网 /health 返回 ${res.status}`)
        }
        reason = `HTTP ${res.status}${res.headers.get('cf-ray') ? ` cf-ray=${res.headers.get('cf-ray')}` : ''} ${body.slice(0, 120).replace(/\s+/g, ' ')}`
      } catch (e) {
        if (checks.publicReachable === false && failures.publicReachable) throw e
        reason = errText(e)
      }
      retryLog.push({ step: currentStep, request: `GET ${healthUrl}`, attempt, reason })
      log(`  预热 GET /health 第 ${attempt} 次未通：${reason}`)
      if (performance.now() + WARMUP_INTERVAL_MS > deadline) {
        check('publicReachable', false, `${WARMUP_MAX_MS / 1000} 秒内公网 /health 一直不通，最后一次：${reason}`)
        throw new Error('公网地址一直不通')
      }
      await sleep(WARMUP_INTERVAL_MS)
    }
  })
  if (!warm) return

  // 2. 无 token → 401，WWW-Authenticate 指向 https 隧道上的受保护资源元数据
  const expectedPrm = `${pubBase}/.well-known/oauth-protected-resource`
  let prmUrl = expectedPrm
  await step('unauthorized', async () => {
    const h = await hit(pub, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: ACCEPT }, body: INIT })
    check('unauthorized401', h.status === 401, dump(h))
    const www = h.headers['www-authenticate'] ?? ''
    const m = /resource_metadata="([^"]+)"/.exec(www)
    if (m) prmUrl = m[1]
    check('resourceMetadataInHeader', m?.[1] === expectedPrm, dump(h, `期望 resource_metadata="${expectedPrm}"`))
  })

  // 3. 元数据：按 401 给的地址取受保护资源元数据，再按其中的授权服务器取 AS 元数据
  const endpoints = { authorize: `${pubBase}/authorize`, token: `${pubBase}/token`, register: `${pubBase}/register` }
  await step('metadata', async () => {
    const pr = await hit(prmUrl)
    const prj = parseJson<{ resource?: string; authorization_servers?: string[] }>(pr.body)
    const asBase = prj?.authorization_servers?.[0]
    check(
      'protectedResourceMetadata',
      pr.status === 200 && prj?.resource === pub && prj.authorization_servers?.length === 1 && asBase === pubBase,
      dump(pr, `期望 resource=${pub}，authorization_servers=["${pubBase}"]`)
    )
    const as = await hit(`${asBase ?? pubBase}/.well-known/oauth-authorization-server`)
    const asj = parseJson<{
      issuer?: string
      authorization_endpoint?: string
      token_endpoint?: string
      registration_endpoint?: string
      code_challenge_methods_supported?: string[]
    }>(as.body)
    check(
      'authServerMetadata',
      as.status === 200 &&
        asj?.issuer === pubBase &&
        asj.token_endpoint === `${pubBase}/token` &&
        asj.authorization_endpoint === `${pubBase}/authorize` &&
        asj.registration_endpoint === `${pubBase}/register` &&
        !!asj.code_challenge_methods_supported?.includes('S256'),
      dump(as, `期望 issuer=${pubBase}，各端点都在 ${pubBase} 下，支持 S256`)
    )
    // 后面像真实客户端一样用元数据里的端点（必须是 https 隧道地址才采用）
    if (asj?.authorization_endpoint?.startsWith(pubBase)) endpoints.authorize = asj.authorization_endpoint
    if (asj?.token_endpoint?.startsWith(pubBase)) endpoints.token = asj.token_endpoint
    if (asj?.registration_endpoint?.startsWith(pubBase)) endpoints.register = asj.registration_endpoint
  })

  // 4. 完整 OAuth：注册 → 授权页 → 桌面批准 → 轮询拿授权码 → 换 token
  await step('oauthFlow', async () => {
    const reg = await hit(endpoints.register, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: CLIENT_NAME, redirect_uris: [REDIRECT] })
    })
    const clientId = parseJson<{ client_id?: string }>(reg.body)?.client_id
    check('register201', reg.status === 201 && !!clientId, dump(reg))
    must(clientId, '注册失败，拿不到 client_id')

    const verifier = crypto.randomBytes(32).toString('base64url')
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: STATE
    })
    const az = await hit(`${endpoints.authorize}?${q}`, { redirect: 'manual' })
    const cfgM = /var cfg = (\{.*?\});/.exec(az.body)
    const cfg = cfgM ? parseJson<{ id?: string; k?: string }>(cfgM[1]) : undefined
    const codeM = /<div id="code" class="code">([^<]+)<\/div>/.exec(az.body)
    const pairCode = codeM?.[1]
    check('authorizePage200', az.status === 200 && !!cfg?.id && !!cfg.k && !!pairCode, dump(az, '期望 200，页面含 var cfg = {...} 和配对码'))
    must(cfg?.id && cfg.k && pairCode, '授权页里找不到请求 id / browserKey / 配对码')
    const { id, k } = cfg as { id: string; k: string }

    const pendingList = b.getState().oauthPending
    const pending = pendingList.find((p) => p.id === id)
    check(
      'pendingMatchesPage',
      !!pending && /^\d{4}$/.test(pairCode) && pending.pairCode === pairCode && pending.clientName === CLIENT_NAME && pending.redirectHost === 'chatgpt.com',
      `页面 id=${id} 配对码=${pairCode}；oauthPending=${JSON.stringify(pendingList)}`
    )
    must(pending, '桌面端待批准列表里没有这条请求')
    log(`  配对码 ${pairCode}（页面与桌面一致），批准给 ${me.name}`)

    b.approveOAuth(id, me.id)
    check('pendingClearedAfterApprove', !b.getState().oauthPending.some((p) => p.id === id), JSON.stringify(b.getState().oauthPending))

    // 像授权页脚本那样轮询状态（经公网）
    const statusUrl = `${pubBase}/authorize/status?id=${encodeURIComponent(id)}&k=${encodeURIComponent(k)}`
    let s: Hit | undefined
    let sj: { status?: string; redirect?: string } | undefined
    for (let i = 0; i < 20; i++) {
      s = await hit(statusUrl)
      sj = parseJson(s.body)
      if (s.status !== 200 || sj?.status !== 'pending') break
      await sleep(500)
    }
    let redirect: URL | undefined
    try {
      redirect = sj?.redirect ? new URL(sj.redirect) : undefined
    } catch {
      redirect = undefined
    }
    const authCode = redirect?.searchParams.get('code') ?? undefined
    check(
      'approvedRedirect',
      s?.status === 200 &&
        sj?.status === 'approved' &&
        !!redirect &&
        `${redirect.origin}${redirect.pathname}` === REDIRECT &&
        redirect.searchParams.get('state') === STATE &&
        !!authCode,
      s ? dump(s, `期望 status=approved，redirect 指向 ${REDIRECT}，state=${STATE}，带 code`) : '没有轮询结果'
    )
    must(authCode, '拿不到授权码')

    const tk = await hit(endpoints.token, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: authCode, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }).toString()
    })
    const tj = parseJson<{ access_token?: string; refresh_token?: string; token_type?: string; expires_in?: number }>(tk.body)
    check(
      'tokenExchange',
      tk.status === 200 &&
        tj?.token_type === 'Bearer' &&
        !!tj.access_token?.startsWith('wbat_') &&
        typeof tj.refresh_token === 'string' &&
        typeof tj.expires_in === 'number' &&
        tj.expires_in > 0,
      dump(tk, '期望 200，token_type=Bearer，access_token 以 wbat_ 开头')
    )
    const at = tj?.access_token
    must(at?.startsWith('wbat_'), '没换到 access token')
    accessToken = at

    const grants = b.listOAuthGrants()
    check('grantRecorded', grants.some((g) => g.agentId === me.id && g.clientId === clientId), JSON.stringify(grants))
  })

  // 5. 真实 MCP SDK 客户端，Bearer access token 连公网 /mcp
  await step('mcpOAuth', async () => {
    must(accessToken, '没有 access token（OAuth 步骤失败），跳过')
    const c = await connect(pub, { Authorization: `Bearer ${accessToken}` })
    const who = await whoamiName(c)
    check('oauthWhoami', !who.isError && who.name === AGENT_NAME, `期望 agent=${AGENT_NAME}，whoami 返回：${who.raw}`)
    const rf = await c.callTool({ name: 'read_file', arguments: { path: 'README.md' } })
    const text = textOf(rf)
    const sep = text.indexOf('\n---\n')
    const content = sep >= 0 ? text.slice(sep + 5) : ''
    check('oauthReadFile', !isError(rf) && content === README, `期望内容 ${JSON.stringify(README)}，read_file 返回：${text}`)
  })

  // 6. OAuth 模式下静态 token 走路径：<公网>/mcp/<token>，不带 Authorization 头 → 隧道开着时必须 401
  await step('mcpStaticPath', async () => {
    const h = await hit(`${pub}/${me.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tunnel-smoke', version: '1.0.0' } }
      })
    })
    check('staticPathRejected', h.status === 401, dump(h, '期望 401：公网隧道下不接受路径令牌'))
  })

  // 7. GET /mcp（带 token）→ 405：不提供 SSE 流
  await step('get405', async () => {
    get405TokenKind = accessToken ? 'oauth' : 'static'
    const h = await hit(pub, { headers: { Authorization: `Bearer ${accessToken ?? me.token}`, Accept: 'text/event-stream' } })
    check('get405', h.status === 405, dump(h, `用 ${get405TokenKind} token`))
  })

  // 8. 切到链接直连（默认模式，和 ShunCode 一样）：带 token 的公网链接直接能连，OAuth 发现端点 404
  await step('linkMode', async () => {
    bridge!.setAuthMode('link')
    const h = await hit(`${pub}/${me.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tunnel-smoke', version: '1.0.0' } }
      })
    })
    check('linkPathAccepted', h.status === 200, dump(h, '期望 200：链接直连模式下公网接受路径令牌'))
    const wk = await hit(`${pubBase}/.well-known/oauth-protected-resource`)
    check('linkNoOAuthDiscovery', wk.status === 404, dump(wk, '期望 404：链接直连模式不暴露 OAuth 元数据'))
  })
}

/** 8. 停止 Bridge，确认隧道 off、本脚本起的 cloudflared 退出、别的 cloudflared 还在；无论前面成败都会执行 */
async function stopAndVerify(): Promise<void> {
  await step('stop', async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    if (!bridge || bridgeStopped) return
    bridgeStopped = true
    await bridge.stop()
    const st = bridge.getState()
    check('tunnelOffAfterStop', st.tunnel.status === 'off', JSON.stringify(st.tunnel))
    if (!pidsBefore) {
      check('cloudflaredExited', false, '无法用 tasklist 获取 cloudflared 进程列表')
      check('otherCloudflaredUntouched', false, '无法用 tasklist 获取 cloudflared 进程列表')
      return
    }
    let now = cloudflaredPids()
    for (let i = 0; i < 10 && now && ourPids.some((p) => now!.has(p)); i++) {
      await sleep(300)
      now = cloudflaredPids()
    }
    const remaining = now ? [...now] : []
    // 停止后不能多出启动前没有的 cloudflared；隧道 running 过时还要求确实识别到了本脚本那一个进程。
    // 隧道启动失败时 cloudflared 在拍快照前就已退出，ourPids 为空是正常的
    const leftover = remaining.filter((p) => !pidsBefore!.has(p))
    check(
      'cloudflaredExited',
      !!now && leftover.length === 0 && (ourPids.length === 1 || !tunnelWasRunning),
      `本脚本启动的 PID=${JSON.stringify(ourPids)}，隧道曾 running=${tunnelWasRunning}，停止后多出的 cloudflared PID=${JSON.stringify(leftover)}，全部=${JSON.stringify(remaining)}`
    )
    check(
      'otherCloudflaredUntouched',
      !!now && [...pidsBefore].every((p) => now!.has(p)),
      `启动前已有 PID=${JSON.stringify([...pidsBefore])}，停止后 PID=${JSON.stringify(remaining)}`
    )
  })
}

let cleaning: Promise<void> | undefined
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    await stopAndVerify()
    await step('cleanup', async () => {
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      check('tempDirRemoved', !fs.existsSync(base), `临时目录仍在：${base}`)
    })
  })()
  return cleaning
}

function report(): number {
  const ok = CHECK_NAMES.every((n) => checks[n])
  const byStep: Record<string, number> = {}
  for (const r of retryLog) byStep[r.step] = (byStep[r.step] ?? 0) + 1
  timings.total = Math.round(performance.now() - t0)
  const result = {
    ok,
    publicUrl: publicMcp ?? null,
    localUrl: localUrl ?? null,
    checks,
    timingsMs: timings,
    retries: { total: retryLog.length, byStep, details: retryLog },
    failures,
    tunnel: {
      cloudflaredPath: cloudflaredPath ?? null,
      pidsBefore: pidsBefore ? [...pidsBefore] : null,
      ourPids,
      ...(tunnelErrorInfo ? { error: tunnelErrorInfo.error ?? null, logTail: tunnelErrorInfo.logTail ?? null } : {})
    },
    get405TokenKind: get405TokenKind ?? null
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  log(ok ? '全部检查通过' : `未通过：${CHECK_NAMES.filter((n) => !checks[n]).join(', ')}`)
  return ok ? 0 : 1
}

// Ctrl-C 和看门狗：都先清理（停 Bridge 会结束本脚本起的 cloudflared），再输出结果退出
process.on('SIGINT', () => {
  log('收到 Ctrl-C，清理中')
  void cleanup().finally(() => process.exit(report() || 130))
})
setTimeout(() => {
  log(`超过 ${WATCHDOG_MS / 1000} 秒未结束，清理后退出`)
  failures.watchdog = `脚本运行超过 ${WATCHDOG_MS / 1000} 秒，卡在步骤 ${currentStep}`
  void cleanup().finally(() => process.exit(report() || 1))
}, WATCHDOG_MS).unref()

try {
  await run()
} catch (e) {
  failures.unexpected = errText(e)
  log(`意外错误：${errText(e)}`)
} finally {
  await cleanup()
}
process.exit(report())
