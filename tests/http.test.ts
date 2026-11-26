import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import type { ActivityEvent, Agent } from '../src/core/types'

let base: string
let root: string
let bridge: Bridge
let url: string
let alice: Agent
let bob: Agent
const events: ActivityEvent[] = []

async function connect(token: string, opts: { pathToken?: boolean } = {}) {
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  const transport = opts.pathToken
    ? new StreamableHTTPClientTransport(new URL(`${url}/${token}`))
    : new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  await client.connect(transport)
  return client
}

function text(r: Awaited<ReturnType<Client['callTool']>>): string {
  return (r.content as { type: string; text: string }[])[0].text
}

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-http-'))
  root = path.join(base, 'ws')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'README.md'), '# 你好\n')
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1')
  bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoot: root, port: 0 })
  alice = bridge.createAgent('Alice')
  bob = bridge.createAgent('Bob')
  bridge.on('event', (e: ActivityEvent) => e.status !== 'running' && events.push({ ...e }))
  await bridge.start()
  url = bridge.getState().mcpUrl
})

afterAll(async () => {
  await bridge.stop()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('认证与传输', () => {
  it('无 token 返回 401', async () => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/)
  })

  it('错误 token 返回 401', async () => {
    const res = await fetch(`${url}/wb_wrong`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(401)
  })

  it('带 Origin 的浏览器请求被拒', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}`, Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: '{}'
    })
    expect(res.status).toBe(403)
  })

  it('Bearer 头和路径 token 都能连上，并返回使用说明', async () => {
    const c1 = await connect(alice.token)
    expect(c1.getInstructions()).toContain('expected_version')
    const tools = await c1.listTools()
    expect(tools.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['whoami', 'list_dir', 'read_file', 'write_file', 'edit_file', 'search', 'delete'])
    )
    const c2 = await connect(bob.token, { pathToken: true })
    expect(JSON.parse(text(await c2.callTool({ name: 'whoami', arguments: {} }))).agent).toBe('Bob')
    await c1.close()
    await c2.close()
  })

  it('会话绑定身份：拿别人的 session id 无效', async () => {
    const c = await connect(alice.token)
    const sid = (c as unknown as { _transport: StreamableHTTPClientTransport })._transport.sessionId!
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bob.token}`, 'Mcp-Session-Id': sid, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
    expect(res.status).toBe(403)
    await c.close()
  })
})

describe('工具调用', () => {
  it('读取中文文件，越界被拒；凭据文件名不再拦', async () => {
    const c = await connect(alice.token)
    expect(text(await c.callTool({ name: 'read_file', arguments: { path: 'README.md' } }))).toContain('# 你好')
    const outside = await c.callTool({ name: 'read_file', arguments: { path: '../x.txt' } })
    expect(outside.isError).toBe(true)
    expect(text(outside)).toContain('OUTSIDE_WORKSPACE')
    const env = await c.callTool({ name: 'read_file', arguments: { path: '.env' } })
    expect(env.isError).toBeFalsy()
    expect(text(env)).toContain('SECRET=1')
    await c.close()
  })

  it('两个 AI 改同一文件：后写的人拿到 CONFLICT', async () => {
    const a = await connect(alice.token)
    const b = await connect(bob.token)
    await a.callTool({ name: 'write_file', arguments: { path: 'shared.md', content: 'v0' } })
    const va = text(await a.callTool({ name: 'read_file', arguments: { path: 'shared.md' } })).match(/version: (\w+)/)![1]
    const vb = text(await b.callTool({ name: 'read_file', arguments: { path: 'shared.md' } })).match(/version: (\w+)/)![1]
    expect(va).toBe(vb)
    const okA = await a.callTool({ name: 'edit_file', arguments: { path: 'shared.md', expected_version: va, edits: [{ old_string: 'v0', new_string: 'alice' }] } })
    expect(okA.isError).toBeFalsy()
    const conflict = await b.callTool({ name: 'write_file', arguments: { path: 'shared.md', content: 'bob', expected_version: vb } })
    expect(conflict.isError).toBe(true)
    expect(text(conflict)).toContain('CONFLICT')
    expect(fs.readFileSync(path.join(root, 'shared.md'), 'utf8')).toBe('alice')
    await a.close()
    await b.close()
  })

  it('新接入的身份直接能写（没有只读档位）', async () => {
    const fresh = bridge.createAgent('Fresh')
    const c = await connect(fresh.token)
    const r = await c.callTool({ name: 'write_file', arguments: { path: 'fresh.txt', content: 'x' } })
    expect(r.isError).toBeFalsy()
    expect(fs.readFileSync(path.join(root, 'fresh.txt'), 'utf8')).toBe('x')
    await c.close()
  })

  it('急停时写不了', async () => {
    const c = await connect(alice.token)
    bridge.setPaused(true)
    const r = await c.callTool({ name: 'write_file', arguments: { path: 'nope.txt', content: 'x' } })
    bridge.setPaused(false)
    expect(text(r)).toContain('PAUSED')
    expect(fs.existsSync(path.join(root, 'nope.txt'))).toBe(false)
    await c.close()
  })

  it('急停后所有调用返回 PAUSED', async () => {
    const c = await connect(alice.token)
    bridge.setPaused(true)
    expect(text(await c.callTool({ name: 'list_dir', arguments: {} }))).toContain('PAUSED')
    bridge.setPaused(false)
    expect((await c.callTool({ name: 'list_dir', arguments: {} })).isError).toBeFalsy()
    await c.close()
  })

  it('吊销后旧会话立刻失效', async () => {
    const temp = bridge.createAgent('Temp')
    const c = await connect(temp.token)
    await bridge.removeAgent(temp.id)
    await expect(c.callTool({ name: 'whoami', arguments: {} })).rejects.toThrow()
  })

  it('活动事件带身份、diff，并写入审计日志', async () => {
    const write = events.find((e) => e.tool === 'edit_file' && e.agentName === 'Alice')
    expect(write?.status).toBe('ok')
    expect(write?.diff).toContain('+alice')
    expect(events.some((e) => e.agentName === 'Bob' && e.error?.startsWith('CONFLICT'))).toBe(true)
    await bridge.log.flush()
    const auditDir = path.join(base, 'data', 'audit')
    const lines = fs.readdirSync(auditDir).flatMap((f) => fs.readFileSync(path.join(auditDir, f), 'utf8').trim().split('\n'))
    expect(lines.length).toBeGreaterThan(5)
  })
})
