// 工具试用台：真实 Bridge + HTTP。Playground 在主进程里用 AI 的 token 连本机地址，走真实的鉴权和档位
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { Playground, PLAYGROUND_CLIENT_NAME } from '../src/core/playground'

let base: string
let root: string
let bridge: Bridge
let pg: Playground

const textOf = (content: unknown[]): string =>
  (content as { type: string; text?: string }[])
    .filter((p) => p.type === 'text' && !p.text?.startsWith('【通知】'))
    .map((p) => p.text ?? '')
    .join('\n')

const json = (content: unknown[]) => JSON.parse(textOf(content))
const sessionsOf = (agentId: string) => bridge.getState().presence.find((p) => p.agentId === agentId)?.sessions ?? 0

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-playground-'))
  root = path.join(base, 'ws')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'hello.txt'), 'hello playground\n')
  bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'skills') })
  await bridge.start()
  pg = new Playground({ connectionInfo: (id) => bridge.connectionInfo(id) })
})

afterEach(async () => {
  await pg.dispose()
  await bridge.stop()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('Playground（真实 Bridge + HTTP）', () => {
  it('列工具：带 name、description、inputSchema、annotations；同一个 AI 只建一个会话', async () => {
    const a = bridge.createAgent('Alice')
    const tools = await pg.listTools(a.id)
    const names = tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['whoami', 'read_file', 'write_file']))
    const read = tools.find((t) => t.name === 'read_file')!
    expect(read.description).toBeTruthy()
    expect(read.inputSchema).toMatchObject({ type: 'object', properties: { path: expect.anything() } })
    expect(read.annotations?.readOnlyHint).toBe(true)
    expect(tools.find((t) => t.name === 'write_file')!.annotations?.readOnlyHint).toBe(false)

    await pg.listTools(a.id)
    expect(pg.size).toBe(1)
    expect(sessionsOf(a.id)).toBe(1)
    expect(bridge.getState().presence.find((p) => p.agentId === a.id)?.clientName).toBe(PLAYGROUND_CLIENT_NAME)
  })

  it('whoami：以选中 AI 的身份调用，content 原样返回，带耗时', async () => {
    const a = bridge.createAgent('Alice')
    const r = await pg.callTool(a.id, 'whoami', {})
    expect(r.isError).toBe(false)
    expect(r.protocolError).toBeUndefined()
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(r.content)).toBe(true)
    expect(JSON.stringify(json(r.content))).toContain('Alice')
  })

  it('read_file：读到工作区里的文件', async () => {
    const a = bridge.createAgent('Bob')
    const r = await pg.callTool(a.id, 'read_file', { path: 'hello.txt' })
    expect(r.isError).toBe(false)
    expect(textOf(r.content)).toContain('hello playground')
  })

  it('write_file：以选中 AI 的身份直接写入（没有只读档位、不用审批）', async () => {
    const a = bridge.createAgent('Carol')
    const r = await pg.callTool(a.id, 'write_file', { path: 'x.txt', content: 'x' })
    expect(r.isError).toBe(false)
    expect(r.protocolError).toBeUndefined()
    expect(fs.readFileSync(path.join(root, 'x.txt'), 'utf8')).toBe('x')
  })

  it('全部停下时调 write_file：服务端拒绝（PAUSED），文件没被写', async () => {
    const a = bridge.createAgent('Paused')
    bridge.setPaused(true)
    const r = await pg.callTool(a.id, 'write_file', { path: 'p.txt', content: 'x' })
    bridge.setPaused(false)
    expect(r.isError).toBe(true)
    expect(r.protocolError).toBeUndefined()
    expect(json(r.content).error).toBe('PAUSED')
    expect(fs.existsSync(path.join(root, 'p.txt'))).toBe(false)
  })

  it('工具不存在、参数没通过校验：返回 isError 和 protocolError，不抛错', async () => {
    const a = bridge.createAgent('Dave')
    const missing = await pg.callTool(a.id, 'no_such_tool', {})
    expect(missing.isError).toBe(true)
    const bad = await pg.callTool(a.id, 'read_file', { path: 123 })
    expect(bad.isError).toBe(true)
    expect(textOf(bad.content)).not.toBe('')
  })

  it('断开后能重连：服务端会话没了（被 DELETE），下一次调用自动重新 initialize', async () => {
    const a = bridge.createAgent('Eve')
    expect((await pg.callTool(a.id, 'whoami', {})).isError).toBe(false)
    // 在客户端不知道的情况下把服务端会话删掉
    const entry = (pg as unknown as { entries: Map<string, { transport: { sessionId?: string } }> }).entries.get(a.id)!
    const sid = entry.transport.sessionId!
    const res = await fetch(bridge.getState().mcpUrl, { method: 'DELETE', headers: { Authorization: `Bearer ${a.token}`, 'Mcp-Session-Id': sid } })
    expect(res.ok).toBe(true)
    expect(sessionsOf(a.id)).toBe(0)

    const r = await pg.callTool(a.id, 'whoami', {})
    expect(r.isError).toBe(false)
    expect(sessionsOf(a.id)).toBe(1)
    const now = (pg as unknown as { entries: Map<string, { transport: { sessionId?: string } }> }).entries.get(a.id)!
    expect(now.transport.sessionId).not.toBe(sid)
  })

  it('disconnect 关掉会话；换 token 后自动换客户端；吊销的 AI 用不了', async () => {
    const a = bridge.createAgent('Frank')
    await pg.listTools(a.id)
    await pg.disconnect(a.id)
    expect(pg.size).toBe(0)
    expect(sessionsOf(a.id)).toBe(0)

    await pg.listTools(a.id)
    bridge.rotateToken(a.id)
    expect((await pg.callTool(a.id, 'whoami', {})).isError).toBe(false)
    expect(pg.size).toBe(1)

    bridge.removeAgent(a.id)
    await expect(pg.listTools(a.id)).rejects.toThrow()
    const r = await pg.callTool(a.id, 'whoami', {})
    expect(r).toMatchObject({ isError: true })
    expect(r.protocolError).toBeTruthy()
  })

  it('空闲超时后关掉客户端和服务端会话', async () => {
    const quick = new Playground({ connectionInfo: (id) => bridge.connectionInfo(id), idleMs: 50 })
    const a = bridge.createAgent('Grace')
    await quick.listTools(a.id)
    expect(quick.size).toBe(1)
    await new Promise((r) => setTimeout(r, 300))
    expect(quick.size).toBe(0)
    expect(sessionsOf(a.id)).toBe(0)
    await quick.dispose()
  })
})
