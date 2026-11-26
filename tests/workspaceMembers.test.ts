// 工作区成员：加工作区时选哪些 AI 能用，没选的看不到、读写不了、进不了群聊，整台电脑的绝对路径和命令也进不去。
// 真实 Bridge + 真实 MCP 客户端
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import type { Agent } from '../src/core/types'

let base: string
let root: string
let dataDir: string
/** 只给部分 AI 用的工作区（base/outer/secret） */
let secret: string
let bridge: Bridge
let url: string
const clients: Client[] = []

interface Result {
  isError: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
}

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 'members-test', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  clients.push(c)
  return c
}

async function join(name: string, machine = false): Promise<{ agent: Agent; c: Client }> {
  const agent = bridge.createAgent(name, undefined, machine)
  return { agent, c: await connect(agent.token) }
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const r = await c.callTool({ name, arguments: args })
  const text = (r.content as { type: string; text: string }[])[0].text
  let data: unknown = text
  try {
    data = JSON.parse(text)
  } catch {
    // 纯文本结果
  }
  return { isError: Boolean(r.isError), data }
}

const code = (r: Result): string => (r.isError ? (typeof r.data === 'object' ? r.data.error : 'SDK_ERROR') : 'OK')
const sid = (c: Client): string => (c as unknown as { _transport: StreamableHTTPClientTransport })._transport.sessionId!
const sessionIds = (a: Agent): string[] => bridge.listAgentSessions(a.id).map((s) => s.id)
const machineId = (): string => bridge.getState().workspaces!.find((w) => w.kind === 'machine')!.id

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mem-'))
  root = path.join(base, 'ws')
  dataDir = path.join(base, 'data')
  secret = path.join(base, 'outer', 'secret')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(path.join(secret, 'inner'), { recursive: true })
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n')
  fs.writeFileSync(path.join(secret, 's.txt'), 'secret\n')
  fs.writeFileSync(path.join(secret, 'inner', 'i.txt'), 'inner\n')
  bridge = new Bridge({ dataDir, workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'user-skills') })
  await bridge.start()
  url = bridge.getState().mcpUrl
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  await bridge.stop()
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

describe('加工作区时选哪些 AI 能用', () => {
  it('没选的 AI 看不到、读不了、进不了群聊，也不会因为加了工作区被断开；选了的照常用', async () => {
    const a = await join('Alice')
    const b = await join('Bob')
    const bSid = sid(b.c)
    const ws = await bridge.addWorkspace(secret, { members: [a.agent.id] })
    expect(ws.members).toEqual([a.agent.id])
    // Bob 不在名单里：会话没被关
    expect(sessionIds(b.agent)).toContain(bSid)

    const bl = await call(b.c, 'list_workspaces')
    expect(JSON.stringify(bl.data)).not.toContain(ws.id)
    const br = await call(b.c, 'read_file', { path: 's.txt', workspace: 'secret' })
    expect(code(br)).toBe('WORKSPACE_FORBIDDEN')
    expect(JSON.stringify(br.data)).toContain('成员')
    const bc = await call(b.c, 'chat_channels')
    expect(JSON.stringify(bc.data)).not.toContain(ws.id)

    // Alice 在名单里：会话被关后自动接上，能读、能看到频道
    const ar = await call(a.c, 'read_file', { path: 's.txt', workspace: 'secret' })
    expect(code(ar)).toBe('OK')
    const ac = await call(a.c, 'chat_channels')
    expect(JSON.stringify(ac.data)).toContain(ws.id)
  })

  it('名单里有不存在的 AI 就不加', async () => {
    await expect(bridge.addWorkspace(secret, { members: ['nobody'] })).rejects.toThrow(/不存在的 AI/)
    expect(bridge.getState().workspaces!.some((w) => w.root === secret)).toBe(false)
  })

  it('不给 members 还是老行为：所有 AI 都能用', async () => {
    const b = await join('Bob')
    const ws = await bridge.addWorkspace(secret)
    expect(ws.members).toBeUndefined()
    expect(code(await call(b.c, 'read_file', { path: 's.txt', workspace: 'secret' }))).toBe('OK')
  })
})

describe('整台电脑和命令也进不去', () => {
  it('绝对路径读写被拒、列上级目录时看不到它、删上级目录被拒；套在里面的开放工作区照常', async () => {
    const b = await join('Bob', true)
    await bridge.addWorkspace(secret, { members: [] })
    const m = machineId()
    const r = await call(b.c, 'read_file', { path: path.join(secret, 's.txt'), workspace: m })
    expect(code(r)).toBe('WORKSPACE_FORBIDDEN')
    const w = await call(b.c, 'write_file', { path: path.join(secret, 'new.txt'), content: 'x', workspace: m })
    expect(code(w)).toBe('WORKSPACE_FORBIDDEN')
    expect(fs.existsSync(path.join(secret, 'new.txt'))).toBe(false)
    const l = await call(b.c, 'list_dir', { path: path.join(base, 'outer'), workspace: m })
    expect(code(l)).toBe('OK')
    expect(JSON.stringify(l.data)).not.toContain('secret')
    const d = await call(b.c, 'delete', { path: path.join(base, 'outer'), workspace: m })
    expect(code(d)).toBe('WORKSPACE_FORBIDDEN')
    expect(fs.existsSync(secret)).toBe(true)

    // 里面套着一个所有 AI 都能用的工作区：那个目录里照常能读
    await bridge.addWorkspace(path.join(secret, 'inner'))
    expect(code(await call(b.c, 'read_file', { path: path.join(secret, 'inner', 'i.txt'), workspace: m }))).toBe('OK')
    expect(code(await call(b.c, 'read_file', { path: path.join(secret, 's.txt'), workspace: m }))).toBe('WORKSPACE_FORBIDDEN')
  })

  it('名单里的 AI 用整台电脑的绝对路径照常能进', async () => {
    const a = await join('Alice', true)
    await bridge.addWorkspace(secret, { members: [a.agent.id] })
    expect(code(await call(a.c, 'read_file', { path: path.join(secret, 's.txt'), workspace: machineId() }))).toBe('OK')
  })

  it('命令：cwd 在里面、命令里写了它的路径，都被拒', async () => {
    const b = await join('Bob', true)
    await bridge.addWorkspace(secret, { members: [] })
    const m = machineId()
    const r1 = await call(b.c, 'run_command', { command: 'echo hi', cwd: secret, workspace: m })
    expect(code(r1)).toBe('WORKSPACE_FORBIDDEN')
    const r2 = await call(b.c, 'run_command', { command: `cat "${path.join(secret, 's.txt')}"`, workspace: m })
    expect(code(r2)).toBe('WORKSPACE_FORBIDDEN')
  })
})

describe('改成员', () => {
  it('能不能用变了的 AI 重新握手，没变的不断开；null 回到所有 AI；名单存进配置', async () => {
    const a = await join('Alice')
    const b = await join('Bob')
    const c = await join('Carol')
    const ws = await bridge.addWorkspace(secret, { members: [a.agent.id] })
    const aSid = sid(a.c)
    await call(a.c, 'whoami')
    const bSid = sid(b.c)
    const cSid = sid(c.c)

    await bridge.setWorkspaceMembers(ws.id, [a.agent.id, b.agent.id])
    expect(sessionIds(c.agent)).toContain(cSid)
    expect(sessionIds(a.agent)).toContain(aSid)
    expect(sessionIds(b.agent)).not.toContain(bSid)
    // Bob 拿旧会话接着调：自动接上，能用了
    expect(code(await call(b.c, 'read_file', { path: 's.txt', workspace: 'secret' }))).toBe('OK')
    expect(code(await call(c.c, 'read_file', { path: 's.txt', workspace: 'secret' }))).toBe('WORKSPACE_FORBIDDEN')

    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')) as { workspaces: { id: string; members?: string[] }[] }
    expect(saved.workspaces.find((w) => w.id === ws.id)?.members?.sort()).toEqual([a.agent.id, b.agent.id].sort())

    await bridge.setWorkspaceMembers(ws.id, null)
    expect(bridge.getState().workspaces!.find((w) => w.id === ws.id)?.members).toBeUndefined()
    expect(code(await call(c.c, 'read_file', { path: 's.txt', workspace: 'secret' }))).toBe('OK')
  })

  it('吊销的 AI 从名单里去掉；整台电脑不能设成员', async () => {
    const a = await join('Alice')
    const b = await join('Bob')
    const ws = await bridge.addWorkspace(secret, { members: [a.agent.id, b.agent.id] })
    await bridge.removeAgent(b.agent.id)
    expect(bridge.getState().workspaces!.find((w) => w.id === ws.id)?.members).toEqual([a.agent.id])
    await expect(bridge.setWorkspaceMembers(machineId(), [a.agent.id])).rejects.toThrow(/工作区不存在/)
  })
})
