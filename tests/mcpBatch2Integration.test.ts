import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'

let base: string
let root: string
let bridge: Bridge
const clients: Client[] = []
const transports = new Map<Client, StreamableHTTPClientTransport>()

async function connect(token: string, reader?: string): Promise<Client> {
  const c = new Client({ name: 'batch2-integration', version: '1' })
  const url = new URL(bridge.getState().mcpUrl)
  if (reader) url.searchParams.set('reader', reader)
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  await c.connect(transport)
  transports.set(c, transport)
  clients.push(c)
  return c
}

async function join(name: string) {
  const agent = bridge.createAgent(name)
  return { agent, c: await connect(agent.token) }
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await c.callTool({ name, arguments: args })
  const blocks = (r.content as { type: string; text?: string }[]).filter((p) => p.type === 'text').map((p) => p.text ?? '')
  return { error: !!r.isError, data: JSON.parse(blocks[0]), blocks }
}

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-b2-integrate-'))
  root = path.join(base, 'ws')
  fs.mkdirSync(root)
  bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'skills') })
  await bridge.start()
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  transports.clear()
  await bridge.stop()
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

describe('第 2 批 MCP 接线', () => {
  it('confirm 读消息不推进游标，重发后带 ack 才确认', async () => {
    const bob = await join('Bob')
    bridge.sendChat({ channel: 'general', text: '@Bob 收到后确认' })
    const first = await call(bob.c, 'chat_read', { channel: 'general', confirm: true })
    expect(first.data.messages).toHaveLength(1)
    expect(first.data.next_ack.general).toBeGreaterThan(0)
    const replay = await call(bob.c, 'chat_wait', { channel: 'general', timeout_ms: 0, confirm: true })
    expect(replay.data.messages[0].id).toBe(first.data.messages[0].id)
    const ack = await call(bob.c, 'chat_wait', { channel: 'general', timeout_ms: 0, confirm: true, ack: first.data.next_ack })
    expect(ack.data.messages).toEqual([])
    expect(ack.data.timed_out).toBe(true)
  })

  it('派任务叫醒 chat_wait 并返回可确认的通知', async () => {
    const alice = await join('Alice')
    const bob = await join('Bob')
    const waiting = call(bob.c, 'chat_wait', { timeout_ms: 3000, confirm: true })
    await new Promise((r) => setTimeout(r, 50))
    await call(alice.c, 'task_create', { title: '验证通知唤醒', assigneeId: bob.agent.id })
    const result = await waiting
    expect(result.data.woken_by).toBe('notice')
    expect(result.data.next_ack._notices).toBeGreaterThan(0)
    expect(result.blocks.slice(1).join('\n')).toContain('验证通知唤醒')
    const ack = await call(bob.c, 'chat_wait', { timeout_ms: 0, confirm: true, ack: result.data.next_ack })
    expect(ack.blocks.slice(1).join('\n')).not.toContain('验证通知唤醒')
  })

  it('副连接使用独立游标，发送结果和正文带 via', async () => {
    const bob = await join('Bob')
    const proxy = await connect(bob.agent.token, 'proxy')
    bridge.sendChat({ channel: 'general', text: '@Bob 测试代理已读' })
    await call(proxy, 'chat_read', { channel: 'general' })
    const channels = await call(bob.c, 'chat_channels')
    expect(channels.data.find((c: { id: string }) => c.id === 'general').unread).toBe(1)
    const sent = await call(proxy, 'chat_send', { channel: 'general', text: '代理回话' })
    expect(sent.data.via).toBe('proxy')
    const main = await call(bob.c, 'chat_read', { channel: 'general' })
    expect(main.data.messages.some((m: { via?: string }) => m.via === 'proxy')).toBe(true)
  })

  it('回执返回 receipt 并保留 reply_to', async () => {
    const alice = await join('Alice')
    const bob = await join('Bob')
    const ask = await call(alice.c, 'chat_send', { channel: 'general', text: '@Bob 帮我检查' })
    const reply = await call(bob.c, 'chat_send', { channel: 'general', text: '收到', receipt: true, reply_to: ask.data.id })
    expect(reply.data.receipt).toBe(true)
    const result = await call(alice.c, 'chat_read', { channel: 'general' })
    expect(result.data.messages[0]).toMatchObject({ receipt: true, reply_to: ask.data.id })
  })

  it('团队列表返回细分状态，派给离线成员时提示且照常创建任务', async () => {
    const alice = await join('Alice')
    const offline = bridge.createAgent('Offline')
    const team = await call(alice.c, 'team_list')
    expect(team.data.find((a: { id: string }) => a.id === offline.id)).toMatchObject({ online: false, status: 'offline' })
    const task = await call(alice.c, 'task_create', { title: '离线仍可指派', assigneeId: offline.id })
    expect(task.error).toBe(false)
    expect(task.blocks.slice(1).join('\n')).toContain('不在线')
  })

  it('MCP 可发纯图片消息并读取图片，私聊附件不会泄露给其他成员', async () => {
    const alice = await join('Alice')
    const bob = await join('Bob')
    const carol = await join('Carol')
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6yS8AAAAASUVORK5CYII=', 'base64')
    fs.writeFileSync(path.join(root, 'image.png'), png)
    const sent = await call(alice.c, 'chat_send', { channel: 'general', images: [{ path: 'image.png' }] })
    expect(sent.error).toBe(false)
    const id = sent.data.attachments[0].id
    const read = await call(bob.c, 'chat_read', { channel: 'general' })
    expect(read.data.messages[0].attachments[0].id).toBe(id)
    const image = await bob.c.callTool({ name: 'chat_image', arguments: { id } })
    expect(image.isError).toBeFalsy()
    expect(image.content).toContainEqual({ type: 'image', mimeType: 'image/png', data: png.toString('base64') })
    const other = Buffer.from(png)
    other[other.length - 1] ^= 1
    fs.writeFileSync(path.join(root, 'private.png'), other)
    const secret = await call(alice.c, 'chat_send', { to: bob.agent.id, images: [{ path: 'private.png' }] })
    const denied = await call(carol.c, 'chat_image', { id: secret.data.attachments[0].id })
    expect(denied.data.error).toBe('NOT_FOUND')
    const allowed = await bob.c.callTool({ name: 'chat_image', arguments: { id: secret.data.attachments[0].id } })
    expect(allowed.isError).toBeFalsy()
  })

  it('文件登记冲突只提醒、成功后自动登记，通知占用人且断开会话释放', async () => {
    const alice = await join('Alice')
    const bob = await join('Bob')
    const held = await call(alice.c, 'claim_files', { paths: ['shared.txt'] })
    expect(held.error).toBe(false)
    const write = await call(bob.c, 'write_file', { path: 'shared.txt', content: 'from Bob\n' })
    expect(write.error).toBe(false)
    expect(write.blocks.slice(1).join('\n')).toContain('【占用提醒】')
    expect(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8')).toBe('from Bob\n')
    const claims = await call(bob.c, 'list_file_claims')
    expect(claims.data.claims.some((c: { agentId: string; kind: string }) => c.agentId === bob.agent.id && c.kind === 'implicit')).toBe(true)
    const notice = await call(alice.c, 'whoami')
    expect(notice.blocks.slice(1).join('\n')).toContain('Bob 写了你登记的 shared.txt')
    await transports.get(alice.c)!.terminateSession()
    await alice.c.close()
    const after = await call(bob.c, 'list_file_claims')
    expect(after.data.claims.some((c: { agentId: string }) => c.agentId === alice.agent.id)).toBe(false)
    const released = await call(bob.c, 'release_files')
    expect(released.data.released).toBe(1)
  })

  it('workspace_brief 返回七节和大厅点名未读，且不会推进聊天游标或读到他人的私有记忆', async () => {
    const bob = await join('Bob')
    const alice = await join('Alice')
    await call(alice.c, 'memory_save', { scope: 'private', title: 'Alice的秘密', content: 'secret' })
    bridge.sendChat({ channel: 'general', text: '@Bob 大厅提醒' })
    bridge.sendChat({ channel: `ws:${bridge.getState().activeWorkspaceId}`, text: '@Bob 项目提醒' })
    const before = await call(bob.c, 'chat_channels')
    const brief = await call(bob.c, 'workspace_brief', { max_chars: 1000 })
    expect(brief.error).toBe(false)
    expect(Object.keys(brief.data.sections)).toHaveLength(7)
    expect(brief.data.sections.messages.lobby_mentions).toBe(1)
    expect(brief.blocks[1].length).toBeLessThanOrEqual(1000)
    expect(JSON.stringify(brief.data)).not.toContain('Alice的秘密')
    // 结果里只有自己的 id 和名字，接入令牌不能带出来（以前整个成员对象都放进了 me）
    expect(brief.data.me).toEqual({ id: bob.agent.id, name: 'Bob' })
    expect(brief.blocks.join('\n')).not.toContain(bob.agent.token)
    const after = await call(bob.c, 'chat_channels')
    expect(after.data).toEqual(before.data)
    const invalid = await call(bob.c, 'workspace_brief', { sections: ['not-a-section'] })
    expect(invalid.data.error).toBe('INVALID_ARGS')
  })
})
