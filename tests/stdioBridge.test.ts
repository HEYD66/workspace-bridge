// 「命令」和「配置文件」接入：工作台自带的 stdio 桥（数据目录里的 stdio-bridge.cjs），用真实的 stdio MCP 客户端连真实 Bridge
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { STDIO_BRIDGE_FILE, STDIO_BRIDGE_SOURCE } from '../src/core/stdioBridge'
import { clientSnippets, joinArgs, pickTarget, SERVER_KEY, stdioEntry, type ConnectSource } from '../src/shared/connectGuide'
import type { Agent } from '../src/core/types'

let base: string
let dataDir: string
let bridge: Bridge
const clients: Client[] = []

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-stdio-'))
  dataDir = path.join(base, 'data')
  const root = path.join(base, 'ws')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n')
  bridge = new Bridge({ dataDir, workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'skills') })
  await bridge.start()
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  await bridge.stop()
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

/** 照客户端的做法：起 node 跑 stdio 桥（command 换成当前的 node，免得依赖 PATH） */
async function viaStdio(args: string[]): Promise<Client> {
  const c = new Client({ name: 'stdio-test', version: '1.0.0' })
  await c.connect(new StdioClientTransport({ command: process.execPath, args, stderr: 'pipe' }))
  clients.push(c)
  return c
}

const whoami = async (c: Client): Promise<string> => {
  const r = await c.callTool({ name: 'whoami', arguments: {} })
  expect(r.isError).toBeFalsy()
  return JSON.parse((r.content as { text: string }[])[0].text).agent
}

const argsFor = (a: Agent): string[] => {
  const info = bridge.connectionInfo(a.id)
  return stdioEntry(info.stdioBridge!, pickTarget(info, 'local')!).args
}

describe('stdio 桥', () => {
  it('启动时写进数据目录，接入信息里带它的路径', () => {
    const a = bridge.createAgent('Alice')
    const info = bridge.connectionInfo(a.id)
    expect(info.stdioBridge).toBe(path.join(dataDir, STDIO_BRIDGE_FILE))
    expect(fs.readFileSync(info.stdioBridge!, 'utf8')).toBe(STDIO_BRIDGE_SOURCE)
  })

  it('stdio 客户端经它连上，调用工具；会话在工作台被断开后自己重新握手，并发的请求只开一个新会话', async () => {
    const a = bridge.createAgent('Alice')
    const c = await viaStdio(argsFor(a))
    expect(await whoami(c)).toBe('Alice')
    expect(bridge.listAgentSessions(a.id)).toHaveLength(1)

    // 手动断开不会被服务端自动接上（返回 404）：桥自己重新握手
    await bridge.disconnectAgent(a.id)
    expect(bridge.listAgentSessions(a.id)).toHaveLength(0)
    const [x, y, z] = await Promise.all([whoami(c), whoami(c), c.listTools()])
    expect([x, y]).toEqual(['Alice', 'Alice'])
    expect(z.tools.map((t) => t.name)).toContain('read_file')
    expect(bridge.listAgentSessions(a.id)).toHaveLength(1)
  })

  it('token 错了：初始化就报错，不会挂住', async () => {
    const a = bridge.createAgent('Alice')
    const args = argsFor(a)
    args[1] = args[1].replace(/\/mcp\/.+$/, '/mcp/wb_wrong_token')
    await expect(viaStdio(args)).rejects.toThrow()
  })
})

describe('配置文件', () => {
  it('保存到数据目录的 connect 里，mcpServers 格式；照文件里的参数起桥能连上；再存一次是覆盖', async () => {
    const a = bridge.createAgent('Alice 01')
    const { path: file } = bridge.exportClientConfig(a.id)
    expect(path.dirname(file)).toBe(path.join(dataDir, 'connect'))
    expect(path.basename(file)).toMatch(/^workspace-bridge-Alice_01-[0-9a-f]{6}\.json$/)
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> }
    const entry = cfg.mcpServers[SERVER_KEY]
    expect(entry.command).toBe('node')
    expect(entry.args).toEqual([path.join(dataDir, STDIO_BRIDGE_FILE), bridge.connectionInfo(a.id).urlWithToken])
    expect(await whoami(await viaStdio(entry.args))).toBe('Alice 01')
    expect(bridge.exportClientConfig(a.id).path).toBe(file)
    expect(() => bridge.exportClientConfig('nobody')).toThrow(/AI 不存在/)
  })
})

describe('接入向导的片段', () => {
  const src = (over: Partial<ConnectSource> = {}): ConnectSource => ({
    url: 'http://127.0.0.1:7777/mcp',
    token: 'wb_tok',
    lanUrls: [],
    authMode: 'link',
    stdioBridge: 'C:\\Users\\me\\AppData\\Roaming\\workspace-bridge\\bridge\\stdio-bridge.cjs',
    ...over
  })

  it('有 stdio 桥时最前面是「命令」和「配置文件」，Claude Desktop 也改用它', () => {
    const s = src()
    const list = clientSnippets(s, pickTarget(s, 'local')!)
    expect(list.slice(0, 2).map((x) => x.id)).toEqual(['command', 'config-file'])
    const cmd = list[0]
    expect(cmd.fields).toEqual([
      { label: '名称', value: SERVER_KEY },
      { label: '命令', value: 'node' },
      { label: '参数', value: `${s.stdioBridge} http://127.0.0.1:7777/mcp/wb_tok` }
    ])
    expect(JSON.parse(cmd.code).mcpServers[SERVER_KEY]).toEqual({ command: 'node', args: [s.stdioBridge, 'http://127.0.0.1:7777/mcp/wb_tok'] })
    expect(list[1].exportConfig).toBe(true)
    const desk = list.find((x) => x.id === 'claude-desktop')!
    expect(JSON.parse(desk.code).mcpServers[SERVER_KEY].command).toBe('node')
  })

  it('请求头认证的地址带 --token；路径有空格时参数加引号；没有 stdio 桥时没有这两页', () => {
    const s = src({ authMode: 'oauth', lanUrls: ['http://192.168.1.5:7777/mcp'] })
    expect(stdioEntry('x.cjs', pickTarget(s, 'lan')!).args).toEqual(['x.cjs', 'http://192.168.1.5:7777/mcp', '--token', 'wb_tok'])
    expect(joinArgs(['C:\\My Files\\b.cjs', 'http://h/mcp/t'])).toBe('"C:\\My Files\\b.cjs" http://h/mcp/t')
    const none = src({ stdioBridge: undefined })
    expect(clientSnippets(none, pickTarget(none, 'local')!).some((x) => x.id === 'command' || x.id === 'config-file')).toBe(false)
  })
})
