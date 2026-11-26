import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { testConnection, testMcpUrl } from '../src/core/connectTest'
import { clientSnippets, connectTargets, pickTarget, SERVER_KEY, type ConnectSource } from '../src/shared/connectGuide'

const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz'
const src = (over: Partial<ConnectSource> = {}): ConnectSource => ({
  url: 'http://127.0.0.1:7777/mcp',
  token: TOKEN,
  lanUrls: [],
  authMode: 'link',
  ...over
})

describe('接入向导：地址', () => {
  it('只有本机；局域网、公网开着才出现', () => {
    expect(connectTargets(src()).map((t) => t.which)).toEqual(['local'])
    const all = connectTargets(src({ lanUrls: ['http://192.168.1.5:7777/mcp', 'http://10.0.0.2:7777/mcp'], publicUrl: 'https://x.trycloudflare.com/mcp' }))
    expect(all.map((t) => t.which)).toEqual(['local', 'lan', 'public'])
    // 局域网只取第一个 IP
    expect(all[1].baseUrl).toBe('http://192.168.1.5:7777/mcp')
  })

  it('链接模式：三个地址都用路径令牌，不带请求头', () => {
    const all = connectTargets(src({ lanUrls: ['http://192.168.1.5:7777/mcp'], publicUrl: 'https://x.trycloudflare.com/mcp' }))
    for (const t of all) {
      expect(t.url).toBe(`${t.baseUrl}/${TOKEN}`)
      expect(t.bearer).toBeUndefined()
    }
  })

  it('OAuth 模式：本机用路径令牌；局域网、公网用 Bearer 请求头（隧道开着时路径令牌会被拒）', () => {
    const s = src({ authMode: 'oauth', lanUrls: ['http://192.168.1.5:7777/mcp'], publicUrl: 'https://x.trycloudflare.com/mcp' })
    expect(pickTarget(s, 'local')?.url).toBe(`http://127.0.0.1:7777/mcp/${TOKEN}`)
    expect(pickTarget(s, 'local')?.bearer).toBeUndefined()
    expect(pickTarget(s, 'lan')).toMatchObject({ url: 'http://192.168.1.5:7777/mcp', bearer: TOKEN })
    expect(pickTarget(s, 'public')).toMatchObject({ url: 'https://x.trycloudflare.com/mcp', bearer: TOKEN })
  })
})

describe('接入向导：片段', () => {
  const byId = (s: ConnectSource, which: 'local' | 'lan' | 'public' = 'local') => {
    const list = clientSnippets(s, pickTarget(s, which)!)
    return Object.fromEntries(list.map((x) => [x.id, x]))
  }

  it('每个客户端都有片段和说明，路径令牌直接填进地址', () => {
    const m = byId(src())
    const url = `http://127.0.0.1:7777/mcp/${TOKEN}`
    expect(Object.keys(m)).toEqual(['claude-code', 'codex', 'cursor', 'vscode', 'windsurf', 'cline', 'claude-desktop', 'web', 'generic'])
    for (const s of Object.values(m)) expect(s.notes.length).toBeGreaterThan(0)
    expect(m['claude-code'].code).toBe(`claude mcp add --transport http ${SERVER_KEY} ${url}`)
    expect(m.codex.code).toContain(`[mcp_servers.${SERVER_KEY}]\nurl = "${url}"`)
    expect(m.codex.code).toContain('如果你的 Codex 版本不支持 url，用 mcp-remote 桥接')
    expect(JSON.parse(m.cursor.code)).toEqual({ mcpServers: { [SERVER_KEY]: { url } } })
    expect(JSON.parse(m.vscode.code)).toEqual({ servers: { [SERVER_KEY]: { type: 'http', url } } })
    expect(JSON.parse(m.windsurf.code)).toEqual({ mcpServers: { [SERVER_KEY]: { serverUrl: url } } })
    expect(JSON.parse(m.cline.code)).toEqual({ mcpServers: { [SERVER_KEY]: { type: 'streamableHttp', url } } })
    expect(JSON.parse(m['claude-desktop'].code)).toEqual({ mcpServers: { [SERVER_KEY]: { command: 'npx', args: ['-y', 'mcp-remote', url] } } })
    expect(m.generic.code).toContain(`Authorization: Bearer ${TOKEN}`)
  })

  it('请求头认证：各家片段带 Authorization，mcp-remote 经环境变量传', () => {
    const s = src({ authMode: 'oauth', lanUrls: ['http://192.168.1.5:7777/mcp'] })
    const m = byId(s, 'lan')
    const url = 'http://192.168.1.5:7777/mcp'
    const headers = { Authorization: `Bearer ${TOKEN}` }
    expect(m['claude-code'].code).toBe(`claude mcp add --transport http ${SERVER_KEY} ${url} --header "Authorization: Bearer ${TOKEN}"`)
    expect(m.codex.code).toContain(`http_headers = { Authorization = "Bearer ${TOKEN}" }`)
    expect(JSON.parse(m.cursor.code).mcpServers[SERVER_KEY]).toEqual({ url, headers })
    expect(JSON.parse(m.vscode.code).servers[SERVER_KEY]).toEqual({ type: 'http', url, headers })
    const desk = JSON.parse(m['claude-desktop'].code).mcpServers[SERVER_KEY]
    expect(desk.args).toEqual(['-y', 'mcp-remote', url, '--header', 'Authorization:${AUTH_HEADER}'])
    expect(desk.env).toEqual({ AUTH_HEADER: `Bearer ${TOKEN}` })
  })

  it('网页 AI：没有公网地址时提示开隧道；有时链接模式给带 token 的链接，OAuth 模式给不带 token 的地址', () => {
    expect(byId(src()).web).toMatchObject({ code: '' })
    expect(byId(src()).web.notes.join('')).toContain('公网隧道')
    expect(byId(src({ publicUrl: 'https://x.trycloudflare.com/mcp' })).web.code).toBe(`https://x.trycloudflare.com/mcp/${TOKEN}`)
    const oauth = byId(src({ authMode: 'oauth', publicUrl: 'https://x.trycloudflare.com/mcp' })).web
    expect(oauth.code).toBe('https://x.trycloudflare.com/mcp')
    expect(oauth.notes.join('')).toContain('OAuth')
  })
})
describe('测试连接（真实 Bridge + HTTP）', () => {
  let base: string
  let bridge: Bridge

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-connect-'))
    const root = path.join(base, 'ws')
    fs.mkdirSync(root, { recursive: true })
    bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'skills') })
    await bridge.start()
  })

  afterEach(async () => {
    await bridge.stop()
    fs.rmSync(base, { recursive: true, force: true })
  })

  const sessionsOf = (agentId: string) => bridge.getState().presence.find((p) => p.agentId === agentId)?.sessions ?? 0

  it('本机：initialize 成功，返回服务名和耗时；测完会话被关掉', async () => {
    const a = bridge.createAgent('Alice')
    const r = await testConnection(bridge.connectionInfo(a.id), 'local')
    expect(r).toMatchObject({ ok: true, status: 200, serverName: SERVER_KEY })
    expect(r.ms).toBeGreaterThanOrEqual(0)
    // 显示的地址里不带 token
    expect(r.url).toMatch(/\/mcp\/<token>$/)
    expect(r.url).not.toContain(a.token)
    expect(sessionsOf(a.id)).toBe(0)
  })

  it('OAuth 模式：本机路径令牌和 Bearer 头都能连', async () => {
    bridge.setAuthMode('oauth')
    const a = bridge.createAgent('Bob')
    const info = bridge.connectionInfo(a.id)
    expect((await testConnection(info, 'local')).ok).toBe(true)
    expect((await testMcpUrl(info.url, a.token)).ok).toBe(true)
    expect(sessionsOf(a.id)).toBe(0)
  })

  it('token 不对：401，带服务端的原话', async () => {
    const r = await testMcpUrl(bridge.getState().mcpUrl, 'not-a-real-token')
    expect(r).toMatchObject({ ok: false, status: 401 })
    expect(r.error).toContain('token')
  })

  it('局域网、公网没开：直接返回原因，不发请求', async () => {
    const a = bridge.createAgent('Carol')
    const info = bridge.connectionInfo(a.id)
    expect(await testConnection(info, 'lan')).toMatchObject({ ok: false, error: '局域网没有打开' })
    expect(await testConnection(info, 'public')).toMatchObject({ ok: false, error: '公网隧道没有在运行' })
  })

  it('地址连不上：返回「连不上」而不是抛错', async () => {
    // 先拿到一个空闲端口再关掉
    const stopped = new Bridge({ dataDir: path.join(base, 'data2'), workspaceRoot: path.join(base, 'ws'), port: 0, userSkillsDir: path.join(base, 'skills2') })
    await stopped.start()
    const url = stopped.getState().mcpUrl
    await stopped.stop()
    const r = await testMcpUrl(`${url}/whatever`)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/^连不上/)
  })
})
