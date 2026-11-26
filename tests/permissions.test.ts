// 权限精简（2026-11-12）：接入的 AI 都是完全权限（全部工具、能写、能执行、不用审批、凭据文件放开），旧配置迁移；
// 保留的保护（工作区外、数据目录、全部停下）、日志脱敏、隧道下的路径令牌。
// 真实 Bridge + 真实 MCP 客户端，每个用例一个干净的数据目录和工作区
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { ConfigStore, LEGACY_CONFIG_COPY, MACHINE_WORKSPACE_ID } from '../src/core/config'
import { PATH_TOKEN_REJECTED_MESSAGE } from '../src/core/httpServer'
import { redactText, REDACTED } from '../src/core/redact'
import type { Agent } from '../src/core/types'
import { TOOL_NAMES } from '../src/shared/tools'

let base: string
let root: string
let bridge: Bridge
let url: string
const clients: Client[] = []

interface Result {
  isError: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
}

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 'permissions-test', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  clients.push(c)
  return c
}

async function join(name: string, roleId?: string): Promise<{ agent: Agent; c: Client }> {
  const agent = bridge.createAgent(name, roleId)
  return { agent, c: await connect(agent.token) }
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const r = await c.callTool({ name, arguments: args })
  const body = (r.content as { type: string; text: string }[]).map((p) => p.text).find((t) => !t.startsWith('【通知】')) ?? ''
  let data: unknown = body
  try {
    data = JSON.parse(body)
  } catch {
    // 不是 JSON 就保留原文
  }
  return { isError: Boolean(r.isError), data }
}

const code = (r: Result): string => (r.isError ? (typeof r.data === 'object' ? r.data.error : 'SDK_ERROR') : 'OK')
const toolNames = async (c: Client): Promise<string[]> => (await c.listTools()).tools.map((t) => t.name).sort()

/** 发一个 initialize 请求，Host 和其他请求头可以自己定（fetch 不让改 Host） */
function initRequest(pathname: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const port = new URL(url).port
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '1.0.0' } }
  })
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
          ...headers
        }
      },
      (res) => {
        if (res.statusCode !== 401) {
          // 成功的是 SSE 流，只要状态码
          resolve({ status: res.statusCode ?? 0, body: '' })
          res.destroy()
          return
        }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (d) => (body += d))
        res.on('end', () => resolve({ status: 401, body }))
      }
    )
    req.on('error', reject)
    req.end(payload)
  })
}

/** 测试里假装隧道开着：直接改 Bridge 内部的隧道状态，不真的起 cloudflared */
function fakeTunnel(state: 'running' | 'stopped', hostname = 'perm-test.trycloudflare.com'): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = bridge as any
  b.tunnelSt = { ...b.tunnelSt, mode: 'quick', state, hostname: state === 'running' ? hostname : undefined }
}

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-perm-'))
  root = path.join(base, 'ws')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const a = 1\n')
  bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'user-skills') })
  await bridge.start()
  url = bridge.getState().mcpUrl
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  fakeTunnel('stopped')
  await bridge.stop()
  // Windows 上强制结束 bash 是异步的，执行过命令的用例里工作区目录会被占用一小会儿：等一下再重试
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
      break
    } catch (err) {
      if (i >= 15) throw err
      await new Promise((r) => setTimeout(r, 200))
    }
  }
})

describe('接入的 AI 都是完全权限', () => {
  it('新身份没有档位、执行开关、限额这些字段；整台电脑默认关', () => {
    const a = bridge.createAgent('A')
    for (const k of ['tier', 'execAllowed', 'limits', 'workspaceIds', 'machineAccess']) expect(a, k).not.toHaveProperty(k)
    expect(bridge.config.addAgent('B')).not.toHaveProperty('machineAccess')
    expect(bridge.createAgent('C', undefined, true).machineAccess).toBe(true)
    // 状态里也不再有全局停用工具
    expect(bridge.getState()).not.toHaveProperty('disabledTools')
  })

  it('刚接入就能读、写、删、执行命令、结束自己的命令，全程没有审批', async () => {
    const a = await join('Alice')
    const names = await toolNames(a.c)
    expect(names).toEqual([...TOOL_NAMES].sort())
    for (const n of ['run_command', 'send_command_input', 'kill_process', 'delete', 'apply_patch', 'install_skill']) expect(names).toContain(n)

    expect(code(await call(a.c, 'read_file', { path: 'src/app.ts' }))).toBe('OK')
    expect(code(await call(a.c, 'write_file', { path: 'x.txt', content: 'x' }))).toBe('OK')
    expect(code(await call(a.c, 'write_file', { path: 'x.txt', content: 'y', overwrite: true }))).toBe('OK')
    expect(code(await call(a.c, 'delete', { path: 'x.txt' }))).toBe('OK')
    expect(fs.existsSync(path.join(root, 'x.txt'))).toBe(false)

    const r = await call(a.c, 'run_command', { command: 'echo exec-ok', timeout_ms: 20000 })
    expect(code(r)).toBe('OK')
    expect(JSON.stringify(r.data)).toContain('exec-ok')

    const me = (await call(a.c, 'whoami')).data
    expect(me.permissions).toContain('完全权限')
    for (const k of ['tier', 'unavailableReasons', 'unavailableTools', 'approvalRequired', 'reasonMeaning']) expect(me, k).not.toHaveProperty(k)
    // 活动流里没有一条是等审批或被拒的
    expect(bridge.recentEvents().filter((e) => e.agentName === 'Alice' && e.status !== 'ok')).toEqual([])
  }, 40000)

  it('凭据文件和 .git 内部对文件工具放开：能读能写；搜索和列目录不进 .git', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=needle-1\n')
    fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true })
    fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n\tneedle-in-git = true\n')
    fs.mkdirSync(path.join(root, '.ssh'))
    fs.writeFileSync(path.join(root, '.ssh', 'id_rsa'), 'PRIVATE needle-key\n')
    const a = await join('Alice')

    expect((await call(a.c, 'read_file', { path: '.env' })).data).toContain('SECRET=needle-1')
    expect((await call(a.c, 'read_file', { path: '.git/config' })).data).toContain('needle-in-git')
    expect((await call(a.c, 'read_file', { path: '.ssh/id_rsa' })).data).toContain('PRIVATE needle-key')
    expect(code(await call(a.c, 'write_file', { path: '.env', content: 'SECRET=2\n', overwrite: true }))).toBe('OK')
    expect(code(await call(a.c, 'write_file', { path: '.git/hooks/pre-commit', content: '#!/bin/sh\n' }))).toBe('OK')
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('SECRET=2\n')
    expect(fs.existsSync(path.join(root, '.git', 'hooks', 'pre-commit'))).toBe(true)

    // 搜索能搜到 .ssh 里的，但不进 .git（里面是对象文件，只会是噪音）
    const s = JSON.stringify((await call(a.c, 'search', { query: 'needle' })).data)
    expect(s).toContain('id_rsa')
    expect(s).not.toContain('needle-in-git')
    // 目录列表里看得到 .env
    expect(JSON.stringify((await call(a.c, 'list_dir')).data)).toContain('.env')
  })

  it('保留的保护：工作区外读写不了，本应用数据目录读不了（里面有全部 AI 的连接密钥）', async () => {
    const a = await join('Alice')
    const cfg = path.join(base, 'data', 'config.json').split(path.sep).join('/')
    expect(code(await call(a.c, 'read_file', { path: cfg }))).not.toBe('OK')
    expect(code(await call(a.c, 'read_file', { path: '../data/config.json' }))).not.toBe('OK')
    expect(code(await call(a.c, 'write_file', { path: '../outside.txt', content: 'x' }))).toBe('OUTSIDE_WORKSPACE')
    expect(fs.existsSync(path.join(base, 'outside.txt'))).toBe(false)

    // 开了整台电脑也读不了数据目录
    const m = bridge.createAgent('Machine', undefined, true)
    const mc = await connect(m.token)
    const r = await call(mc, 'read_file', { workspace: '整台电脑', path: cfg })
    expect(code(r)).toBe('PROTECTED')
    expect(JSON.stringify(r.data)).not.toContain(m.token)
  })

  it('全部停下：所有 AI 的调用返回 PAUSED，恢复后照常', async () => {
    const a = await join('Alice')
    bridge.setPaused(true)
    expect(code(await call(a.c, 'write_file', { path: 'x.txt', content: 'x' }))).toBe('PAUSED')
    expect(code(await call(a.c, 'run_command', { command: 'echo hi' }))).toBe('PAUSED')
    expect(fs.existsSync(path.join(root, 'x.txt'))).toBe(false)
    bridge.setPaused(false)
    expect(code(await call(a.c, 'write_file', { path: 'x.txt', content: 'x' }))).toBe('OK')
  })
})

describe('旧配置迁移', () => {
  it('档位、执行开关、限额、工作区勾选、全局停用工具、职位权限读入时丢掉；勾过整台电脑的开关保持打开；保存后文件里也没有了', () => {
    const dir = path.join(base, 'old-config')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'config.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        exec: { enabled: false },
        disabledTools: ['delete', 'run_command'],
        workspaces: [{ id: 'w_aaaa1111', name: 'ws', root }],
        agents: [
          { id: 'a1', name: 'ReadOnly', token: 't'.repeat(32), tier: 'read-only', color: '#000', createdAt: 1 },
          { id: 'a2', name: 'Ask', token: 'u'.repeat(32), tier: 'ask', color: '#000', createdAt: 2, execAllowed: true, limits: { perMinute: 3 }, workspaceIds: ['w_aaaa1111'] },
          { id: 'a3', name: 'Machine', token: 'v'.repeat(32), tier: 'auto', color: '#000', createdAt: 3, roleId: 'r1', workspaceIds: ['w_aaaa1111', MACHINE_WORKSPACE_ID] }
        ],
        roles: [{ id: 'r1', name: '审阅', description: '只看不改', fileAccess: 'read', writablePaths: ['docs'], canManage: true, allowedTools: ['read_file'] }]
      })
    )
    const original = fs.readFileSync(file, 'utf8')
    const old = new ConfigStore(dir)
    const cfg = old.get()
    expect(cfg).not.toHaveProperty('exec')
    expect(cfg).not.toHaveProperty('disabledTools')
    expect(cfg.agents.map((a) => [a.name, a.machineAccess === true])).toEqual([
      ['ReadOnly', false],
      ['Ask', false],
      ['Machine', true]
    ])
    for (const a of cfg.agents) for (const k of ['tier', 'execAllowed', 'limits', 'workspaceIds']) expect(a, `${a.name}.${k}`).not.toHaveProperty(k)
    // 令牌、职位不变：升级后不用重新接入
    expect(old.getAgent('a2')?.token).toBe('u'.repeat(32))
    expect(old.getAgent('a3')?.roleId).toBe('r1')
    expect(cfg.roles).toEqual([{ id: 'r1', name: '审阅', description: '只看不改' }])

    // 随便保存一次，文件里的旧字段就没了
    old.updateAgent('a1', { name: 'Renamed' })
    const saved = fs.readFileSync(file, 'utf8')
    for (const k of ['"tier"', '"execAllowed"', '"limits"', '"workspaceIds"', '"disabledTools"', '"exec"', '"fileAccess"', '"allowedTools"', '"canManage"', '"writablePaths"']) {
      expect(saved, k).not.toContain(k)
    }
    expect(JSON.parse(saved).agents.find((a: { id: string }) => a.id === 'a3').machineAccess).toBe(true)

    // 旧格式的原文留了一份在数据目录里（想退回旧版本时能找回每个 AI 当时的设置）；再启动不覆盖
    const copy = path.join(dir, LEGACY_CONFIG_COPY)
    expect(fs.readFileSync(copy, 'utf8')).toBe(original)
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(saved), disabledTools: ['x'] }))
    new ConfigStore(dir)
    expect(fs.readFileSync(copy, 'utf8')).toBe(original)
  })

  it('新格式的配置不留副本', () => {
    const dir = path.join(base, 'new-config')
    const store = new ConfigStore(dir)
    store.addAgent('A', undefined, true)
    new ConfigStore(dir)
    expect(fs.existsSync(path.join(dir, LEGACY_CONFIG_COPY))).toBe(false)
  })

  it('以前只读的身份升级后直接能写、能执行', async () => {
    await bridge.stop()
    const file = path.join(base, 'data', 'config.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const token = 'w'.repeat(40)
    raw.agents = [{ id: 'old1', name: 'OldViewer', token, tier: 'read-only', color: '#000', createdAt: 1 }]
    fs.writeFileSync(file, JSON.stringify(raw))
    bridge = new Bridge({ dataDir: path.join(base, 'data'), port: 0, userSkillsDir: path.join(base, 'user-skills') })
    await bridge.start()
    url = bridge.getState().mcpUrl
    const c = await connect(token)
    expect(code(await call(c, 'write_file', { path: 'x.txt', content: 'x' }))).toBe('OK')
    const r = await call(c, 'run_command', { command: 'echo upgraded-ok', timeout_ms: 20000 })
    expect(code(r)).toBe('OK')
    expect(JSON.stringify(r.data)).toContain('upgraded-ok')
  }, 40000)
})

describe('日志脱敏', () => {
  it('redactText：已知令牌、Bearer、/mcp/<令牌>、token= 和 JSON 里的 token 都换掉', () => {
    const secret = 'S3cretTokenValue_0123456789'
    const s = `x ${secret} y; Authorization: Bearer abcdefgh.ijkl-123; url http://h:1/mcp/zzzzzzzzzzzz?x=1; a?access_token=qwertyuiop&b; {"token": "asdfghjklzxc"}`
    const out = redactText(s, [secret])
    expect(out).not.toContain(secret)
    expect(out).not.toContain('abcdefgh.ijkl-123')
    expect(out).not.toContain('zzzzzzzzzzzz')
    expect(out).not.toContain('qwertyuiop')
    expect(out).not.toContain('asdfghjklzxc')
    expect(out).toContain(`Bearer ${REDACTED}`)
    expect(out).toContain(`/mcp/${REDACTED}?x=1`)
    // 短值和普通文字不动
    expect(redactText('token=abc mcp/x Bearer', ['short'])).toBe('token=abc mcp/x Bearer')
    // light 只换已知令牌和 Bearer
    expect(redactText(`/mcp/zzzzzzzzzzzz ${secret}`, [secret], { mode: 'light' })).toBe(`/mcp/zzzzzzzzzzzz ${REDACTED}`)
  })

  it('活动流和审计文件里不出现令牌原值、Bearer 值和路径令牌', async () => {
    const a = await join('Alice')
    const b = bridge.createAgent('Bob')
    const content = `别人的令牌 ${b.token}\nAuthorization: Bearer zyxwvutsrq9876\n地址 http://127.0.0.1:1/mcp/${a.agent.token}\n`
    expect(code(await call(a.c, 'write_file', { path: 'notes.txt', content }))).toBe('OK')
    // 报错信息里带上令牌（文件不存在，错误里有路径）
    expect(code(await call(a.c, 'read_file', { path: `missing-${b.token}.txt` }))).not.toBe('OK')
    // 文件本身照写，不受脱敏影响
    expect(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8')).toBe(content)

    const recent = JSON.stringify(bridge.recentEvents())
    for (const leak of [a.agent.token, b.token, 'zyxwvutsrq9876']) expect(recent).not.toContain(leak)
    expect(recent).toContain(REDACTED)

    const auditDir = path.join(base, 'data', 'audit')
    let audit = ''
    for (let i = 0; i < 40; i++) {
      audit = fs.existsSync(auditDir)
        ? fs
            .readdirSync(auditDir)
            .map((f) => fs.readFileSync(path.join(auditDir, f), 'utf8'))
            .join('')
        : ''
      if (audit.includes('notes.txt') && audit.includes('missing-')) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(audit).toContain('notes.txt')
    expect(audit).toContain('missing-')
    for (const leak of [a.agent.token, b.token, 'zyxwvutsrq9876']) expect(audit).not.toContain(leak)
  })
})

describe('OAuth 模式：隧道开着时拒绝路径令牌', () => {
  it('隧道没开：本机路径令牌照常可用', async () => {
    bridge.setAuthMode('oauth')
    const agent = bridge.createAgent('Path')
    const port = new URL(url).port
    expect((await initRequest(`/mcp/${agent.token}`, { Host: `127.0.0.1:${port}` })).status).toBe(200)
  })

  it('隧道开着：经隧道域名或带 Cloudflare 头的路径令牌 401，Bearer 照常；本机直连路径令牌仍可用', async () => {
    bridge.setAuthMode('oauth')
    const agent = bridge.createAgent('Path')
    const port = new URL(url).port
    fakeTunnel('running')

    const viaTunnel = await initRequest(`/mcp/${agent.token}`, { Host: 'perm-test.trycloudflare.com' })
    expect(viaTunnel.status).toBe(401)
    expect(viaTunnel.body).toContain(PATH_TOKEN_REJECTED_MESSAGE)
    // 同时带了 Bearer 也拒：令牌已经在 URL 里了
    expect((await initRequest(`/mcp/${agent.token}`, { Host: 'perm-test.trycloudflare.com', Authorization: `Bearer ${agent.token}` })).status).toBe(401)
    // cloudflared 转发到本机的请求带 cf-* 头
    expect((await initRequest(`/mcp/${agent.token}`, { Host: `127.0.0.1:${port}`, 'cf-connecting-ip': '203.0.113.9' })).status).toBe(401)

    // Bearer 头经隧道照常
    expect((await initRequest('/mcp', { Host: 'perm-test.trycloudflare.com', Authorization: `Bearer ${agent.token}` })).status).toBe(200)
    // 本机直连路径令牌仍可用
    expect((await initRequest(`/mcp/${agent.token}`, { Host: `127.0.0.1:${port}` })).status).toBe(200)
    // 错的令牌还是普通 401
    const bad = await initRequest('/mcp/not-a-real-token-123456', { Host: `127.0.0.1:${port}` })
    expect(bad.status).toBe(401)
    expect(bad.body).not.toContain(PATH_TOKEN_REJECTED_MESSAGE)
  })
})

describe('链接直连模式（默认，和 ShunCode 一样有链接就行）', () => {
  it('默认就是 link 模式', () => {
    expect(bridge.getState().authMode).toBe('link')
  })

  it('隧道开着：经隧道域名、带 Cloudflare 头的路径令牌都能连；错 token 仍 401', async () => {
    const agent = bridge.createAgent('Link')
    const port = new URL(url).port
    fakeTunnel('running')

    expect((await initRequest(`/mcp/${agent.token}`, { Host: 'perm-test.trycloudflare.com' })).status).toBe(200)
    expect((await initRequest(`/mcp/${agent.token}`, { Host: `127.0.0.1:${port}`, 'cf-connecting-ip': '203.0.113.9', 'cf-ray': 'x' })).status).toBe(200)
    // 带了无关（失效）的 Bearer 头也不影响：链接里的 token 优先
    expect((await initRequest(`/mcp/${agent.token}`, { Host: 'perm-test.trycloudflare.com', Authorization: 'Bearer wbat_stale' })).status).toBe(200)

    const bad = await initRequest('/mcp/wb_not-a-real-token-123456', { Host: 'perm-test.trycloudflare.com' })
    expect(bad.status).toBe(401)
    expect(bad.body).not.toContain(PATH_TOKEN_REJECTED_MESSAGE)
    // 不带 token 也 401，而且 401 里不指向 OAuth 元数据
    const none = await initRequest('/mcp', { Host: 'perm-test.trycloudflare.com' })
    expect(none.status).toBe(401)
  })

  it('不暴露 OAuth 发现端点：/.well-known/* 和 /register 都是 404，401 不带 resource_metadata', async () => {
    const origin = new URL(url).origin
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/.well-known/openid-configuration', '/authorize']) {
      const r = await fetch(`${origin}${p}`)
      await r.text()
      expect(r.status, p).toBe(404)
    }
    const reg = await fetch(`${origin}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    await reg.text()
    expect(reg.status).toBe(404)
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    await res.text()
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate') ?? '').not.toContain('resource_metadata')
  })

  it('切到 OAuth 立即生效，切回 link 也立即生效', async () => {
    const origin = new URL(url).origin
    bridge.setAuthMode('oauth')
    expect(bridge.getState().authMode).toBe('oauth')
    const on = await fetch(`${origin}/.well-known/oauth-authorization-server`)
    await on.text()
    expect(on.status).toBe(200)
    bridge.setAuthMode('link')
    const off = await fetch(`${origin}/.well-known/oauth-authorization-server`)
    await off.text()
    expect(off.status).toBe(404)
  })

  it('connectionInfo 给出带 token 的公网链接', async () => {
    const agent = bridge.createAgent('Link')
    fakeTunnel('running')
    const info = bridge.connectionInfo(agent.id)
    expect(info.authMode).toBe('link')
    if (info.publicUrl) {
      expect(info.publicUrlWithToken).toBe(`${info.publicUrl}/${agent.token}`)
      expect(info.prompt).toContain(info.publicUrlWithToken)
    }
    expect(info.prompt).toContain(info.urlWithToken)
  })
})
