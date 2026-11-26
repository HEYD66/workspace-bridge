// 「测试连接」：用某个 AI 的 token 对选中的地址发一次 MCP initialize，再 DELETE 关掉会话，不留脏会话
import { pickTarget, type ConnectSource, type ConnectWhich } from '../shared/connectGuide'

export interface ConnectTestResult {
  ok: boolean
  /** 毫秒，从发 initialize 到收到结果 */
  ms: number
  /** 实际测的地址（不带 token） */
  url: string
  serverName?: string
  serverVersion?: string
  /** HTTP 状态码（有回应时） */
  status?: number
  error?: string
}

const PROTOCOL_VERSION = '2025-06-18'
const TIMEOUT_MS = 10_000

/** 响应可能是 JSON，也可能是 SSE（data: 行）；取第一条 JSON-RPC 消息 */
function parseRpc(text: string, contentType: string): unknown {
  if (contentType.includes('text/event-stream')) {
    for (const line of text.split(/\r?\n/)) if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim())
    throw new Error('SSE 响应里没有数据')
  }
  return JSON.parse(text)
}

/** 直接对一个地址测：url 是填进客户端的地址（可能带 /<token>），bearer 不为空时带 Authorization 头 */
export async function testMcpUrl(url: string, bearer?: string, fetchImpl: typeof fetch = fetch): Promise<ConnectTestResult> {
  const shown = url.replace(/\/mcp\/[^/?#]+/, '/mcp/<token>')
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  if (bearer) headers.Authorization = `Bearer ${bearer}`
  const started = Date.now()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      signal: ctl.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'workspace-bridge-connect-test', version: '1' } }
      })
    })
    const ms = Date.now() - started
    const text = await res.text()
    const sid = res.headers.get('mcp-session-id')
    // 先关会话，再看结果：哪怕后面解析失败也不留会话
    if (sid) {
      await fetchImpl(url, { method: 'DELETE', headers: { ...headers, 'Mcp-Session-Id': sid }, signal: ctl.signal }).catch(() => undefined)
    }
    let msg: { result?: { serverInfo?: { name?: string; version?: string } }; error?: { message?: string } } | undefined
    try {
      msg = parseRpc(text, res.headers.get('content-type') ?? '') as typeof msg
    } catch {
      msg = undefined
    }
    if (!res.ok || !msg?.result) {
      const reason = msg?.error?.message ?? (text.trim().slice(0, 200) || res.statusText)
      return { ok: false, ms, url: shown, status: res.status, error: `HTTP ${res.status}：${reason}` }
    }
    const info = msg.result.serverInfo
    return { ok: true, ms, url: shown, status: res.status, serverName: info?.name, serverVersion: info?.version }
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } }
    const reason = err.name === 'AbortError' ? `${TIMEOUT_MS / 1000} 秒内没有回应` : (err.cause?.code ?? err.cause?.message ?? err.message)
    return { ok: false, ms: Date.now() - started, url: shown, error: `连不上：${reason}` }
  } finally {
    clearTimeout(timer)
  }
}

/** 按接入向导的规则选地址（链接还是请求头）再测；这个地址现在没开时直接返回错误 */
export async function testConnection(src: ConnectSource, which: ConnectWhich, fetchImpl?: typeof fetch): Promise<ConnectTestResult> {
  const t = pickTarget(src, which)
  if (!t) {
    const why = which === 'lan' ? '局域网没有打开' : which === 'public' ? '公网隧道没有在运行' : '没有本机地址'
    return { ok: false, ms: 0, url: '', error: why }
  }
  return testMcpUrl(t.url, t.bearer, fetchImpl)
}
