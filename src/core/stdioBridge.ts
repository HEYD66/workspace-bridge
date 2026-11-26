// stdio 桥：只会 stdio 的 MCP 客户端（AWS Quick 的「本地 / 导入」、Claude Desktop 等）用 `node stdio-bridge.cjs <地址>` 连工作台。
// 不依赖任何 npm 包（Node 18+ 自带 fetch），工作台每次启动写到数据目录里（AI 的文件工具和命令碰不到，不会被改成偷 token 的程序）。
// 源码用 String.raw 原样写出：里面不能出现反引号和美元符加花括号。
import fs from 'node:fs'
import path from 'node:path'

export const STDIO_BRIDGE_FILE = 'stdio-bridge.cjs'

export const STDIO_BRIDGE_SOURCE = String.raw`#!/usr/bin/env node
'use strict'
// Workspace Bridge 的 stdio 桥：只会 stdio 的 MCP 客户端用它连工作台的 Streamable HTTP。
// 工作台每次启动会重写这个文件，不要手改。
// 用法：node stdio-bridge.cjs <MCP 地址> [--token <token>]
// - 会话没了（工作台重启、空闲超时、在工作台被断开）：用原来的参数自动重新握手，再把那条请求发一次
// - 工作台暂时连不上（正在重启）：最多等 60 秒再报错
// - stdout 只写 JSON-RPC 消息，日志写 stderr
const readline = require('node:readline')

const RETRY_MS = 60000
const argv = process.argv.slice(2)
let url = ''
let token = process.env.WB_TOKEN || ''
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--token') token = argv[++i] || ''
  else if (!url) url = argv[i]
}
const log = (m) => process.stderr.write('[workspace-bridge] ' + m + '\n')
if (!url) {
  log('用法：node stdio-bridge.cjs <MCP 地址> [--token <token>]')
  process.exit(2)
}
if (typeof fetch !== 'function') {
  log('需要 Node.js 18 或更新的版本')
  process.exit(2)
}
const shownUrl = url.replace(/\/mcp\/[^/?#]+/, '/mcp/…')

let sessionId = null
let protocolVersion = null
let initMsg = null
let initializedSent = false
let ready = Promise.resolve()
let reinitP = null
let closing = false
const inflight = new Set()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
process.stdout.on('error', () => process.exit(0))
const write = (m) => process.stdout.write(JSON.stringify(m) + '\n')

function headers(sid) {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  if (sid) h['mcp-session-id'] = sid
  if (protocolVersion) h['mcp-protocol-version'] = protocolVersion
  if (token) h.authorization = 'Bearer ' + token
  return h
}

function parse(type, text) {
  if (!text.trim()) return []
  if (type.indexOf('text/event-stream') >= 0) {
    const out = []
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.indexOf('data:') === 0)
        .map((l) => l.slice(5).trim())
        .join('\n')
      if (!data) continue
      try {
        out.push(JSON.parse(data))
      } catch (e) {
        // 不是 JSON 的事件不管
      }
    }
    return out
  }
  try {
    const v = JSON.parse(text)
    return Array.isArray(v) ? v : [v]
  } catch (e) {
    return []
  }
}

// 发一条：返回状态码、收到的消息、这次用的会话 id；连不上时重试到 RETRY_MS
async function post(msg) {
  const start = Date.now()
  let wait = 500
  for (;;) {
    const sid = sessionId
    try {
      const r = await fetch(url, { method: 'POST', headers: headers(sid), body: JSON.stringify(msg) })
      const got = r.headers.get('mcp-session-id')
      if (got) sessionId = got
      const text = await r.text()
      return { status: r.status, messages: parse(r.headers.get('content-type') || '', text), sid }
    } catch (e) {
      if (closing || Date.now() - start > RETRY_MS) throw e
      await sleep(wait)
      wait = Math.min(wait * 2, 5000)
    }
  }
}

// 用客户端原来的 initialize 参数换一个新会话；并发的请求只换一次
function reinit(staleSid) {
  if (sessionId && sessionId !== staleSid) return Promise.resolve()
  if (!reinitP) {
    reinitP = (async () => {
      sessionId = null
      const r = await post({ jsonrpc: '2.0', id: 'wb-reinit-' + Date.now(), method: 'initialize', params: initMsg.params })
      const res = r.messages.find((m) => m && m.result)
      if (r.status >= 400 || !res || !sessionId) throw new Error('重新握手失败（HTTP ' + r.status + '）')
      if (res.result.protocolVersion) protocolVersion = res.result.protocolVersion
      if (initializedSent) await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
      log('会话断了，已经重新连上')
    })().finally(() => {
      reinitP = null
    })
  }
  return reinitP
}

async function handle(msg) {
  const isRequest = typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null
  try {
    let r = await post(msg)
    // 404 是「会话没了，重新握手」：不是握手本身就换个会话再发一次
    if (r.status === 404 && initMsg && msg.method !== 'initialize') {
      await reinit(r.sid)
      r = await post(msg)
    }
    if (msg.method === 'initialize') {
      const res = r.messages.find((m) => m && m.result)
      if (res && res.result.protocolVersion) protocolVersion = res.result.protocolVersion
    }
    const answered = r.messages.some((m) => m && m.id === msg.id)
    if (isRequest && r.status >= 400 && !answered) {
      // 401、404 这类错误回的 id 是 null，客户端认不出是哪条请求的，会一直等：换成这条请求的 id 回给它
      const err = r.messages.find((m) => m && m.error)
      const why = err && err.error.message ? err.error.message : '没有说明'
      write({ jsonrpc: '2.0', id: msg.id, error: { code: (err && err.error.code) || -32000, message: 'Workspace Bridge 返回 HTTP ' + r.status + '：' + why } })
    } else {
      for (const m of r.messages) write(m)
    }
  } catch (e) {
    const why = (e && e.message) || String(e)
    log('请求失败：' + why)
    if (isRequest) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: '连不上 Workspace Bridge（' + shownUrl + '）：' + why } })
  }
}

function track(p) {
  inflight.add(p)
  p.finally(() => inflight.delete(p))
}

function dispatch(msg) {
  if (!msg || typeof msg !== 'object') return
  if (msg.method === 'initialize') {
    initMsg = msg
    sessionId = null
    ready = ready.then(() => handle(msg))
    track(ready)
    return
  }
  if (msg.method === 'notifications/initialized') initializedSent = true
  // 握手完成前到的请求排在它后面；之后的请求并发（chat_wait 这类会等很久，不能挡住别的）
  track(ready.then(() => handle(msg)))
}

async function shutdown() {
  closing = true
  await Promise.race([Promise.allSettled(Array.from(inflight)), sleep(3000)])
  if (sessionId) {
    try {
      await Promise.race([fetch(url, { method: 'DELETE', headers: headers(sessionId) }), sleep(2000)])
    } catch (e) {
      // 工作台已经关了就算了
    }
  }
  process.exit(0)
}

readline
  .createInterface({ input: process.stdin })
  .on('line', (line) => {
    if (!line.trim()) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch (e) {
      log('收到的不是 JSON：' + line.slice(0, 200))
      return
    }
    if (Array.isArray(msg)) for (const m of msg) dispatch(m)
    else dispatch(msg)
  })
  .on('close', () => {
    void shutdown()
  })
`

/** 把 stdio 桥写到 dir 下（内容没变就不写），返回它的绝对路径 */
export function writeStdioBridge(dir: string): string {
  const file = path.join(dir, STDIO_BRIDGE_FILE)
  fs.mkdirSync(dir, { recursive: true })
  let current: string | undefined
  try {
    current = fs.readFileSync(file, 'utf8')
  } catch {
    current = undefined
  }
  if (current !== STDIO_BRIDGE_SOURCE) fs.writeFileSync(file, STDIO_BRIDGE_SOURCE, 'utf8')
  return file
}
