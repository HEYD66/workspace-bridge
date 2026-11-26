// 压工具说明（每次连接都要整份发给 AI 的东西变小，工具怎么用不变）：
// workspace 参数不再每个工具带一遍同样的说明、工具列表里没有 $schema、开场说明里每次都不一样的三段挪到最后
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { slimToolList } from '../src/core/mcpServer'

describe('slimToolList', () => {
  it('只去掉每个工具参数定义最外层的 $schema，别的原样', () => {
    const inner = { type: 'object', properties: { $schema: { type: 'string' } } }
    const r = slimToolList({
      tools: [
        { name: 'a', description: 'd', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { x: inner } } },
        { name: 'b', inputSchema: { type: 'object' } },
        { name: 'c' }
      ],
      nextCursor: 'n'
    })
    expect(r).toEqual({
      tools: [{ name: 'a', description: 'd', inputSchema: { type: 'object', properties: { x: inner } } }, { name: 'b', inputSchema: { type: 'object' } }, { name: 'c' }],
      nextCursor: 'n'
    })
  })

  it('结果不是预期的样子就原样返回', () => {
    expect(slimToolList(undefined)).toBeUndefined()
    expect(slimToolList({ tools: 'x' })).toEqual({ tools: 'x' })
    expect(slimToolList({})).toEqual({})
  })
})

describe('连上以后拿到的工具列表和开场说明', () => {
  let base: string
  let bridge: Bridge
  const clients: Client[] = []

  async function connect(token: string): Promise<Client> {
    const c = new Client({ name: 'tool-size-test', version: '1' })
    await c.connect(new StreamableHTTPClientTransport(new URL(bridge.getState().mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    clients.push(c)
    return c
  }

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-size-'))
    for (const d of ['alpha', 'beta']) fs.mkdirSync(path.join(base, d), { recursive: true })
    bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoots: [path.join(base, 'alpha'), path.join(base, 'beta')], port: 0, userSkillsDir: path.join(base, 'user-skills') })
    await bridge.start()
  })
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.stop()
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
  })

  it('工具列表：没有 $schema；workspace 参数还在、还是可选的字符串，只是不再每个工具带一遍说明；别的参数的说明都还在', async () => {
    const alice = bridge.createAgent('Alice')
    const tools = (await (await connect(alice.token)).listTools()).tools
    expect(tools.length).toBeGreaterThan(50)
    expect(tools.filter((t) => '$schema' in t.inputSchema)).toEqual([])
    for (const t of tools) expect(t.inputSchema.type).toBe('object')
    const withWs = tools.filter((t) => t.inputSchema.properties?.workspace)
    expect(withWs.length).toBeGreaterThan(35)
    for (const t of withWs) {
      expect(t.inputSchema.properties!.workspace).toEqual({ type: 'string', maxLength: 200 })
      expect(t.inputSchema.required ?? []).not.toContain('workspace')
    }
    const read = tools.find((t) => t.name === 'read_file')!
    expect((read.inputSchema.properties!.path as { description?: string }).description).toBeTruthy()
    expect(read.inputSchema.required).toContain('path')
    // 任务工具的两个写法都还认
    const claim = tools.find((t) => t.name === 'task_claim')!
    expect(Object.keys(claim.inputSchema.properties!)).toEqual(expect.arrayContaining(['task', 'id']))
  })

  it('不带说明以后 workspace 参数照样管用：指定别的工作区写文件，文件落在那个工作区里', async () => {
    const alice = bridge.createAgent('Alice')
    const c = await connect(alice.token)
    const r = await c.callTool({ name: 'write_file', arguments: { workspace: 'beta', path: 'note.txt', content: 'hi' } })
    expect(r.isError).toBeFalsy()
    expect(fs.readFileSync(path.join(base, 'beta', 'note.txt'), 'utf8')).toBe('hi')
    expect(fs.existsSync(path.join(base, 'alpha', 'note.txt'))).toBe(false)
  })

  it('开场说明：讲了 workspace 参数怎么用；全局记忆、置顶记忆、分给你的任务排在最后（在工作区和技能的后面），任务是最后一段', async () => {
    const alice = bridge.createAgent('Alice')
    const a = await connect(alice.token)
    const save = async (args: Record<string, unknown>): Promise<void> => {
      const r = await a.callTool({ name: 'memory_save', arguments: args })
      expect(r.isError).toBeFalsy()
    }
    await save({ scope: 'global', title: '用户的习惯', content: '回答用中文' })
    await save({ scope: 'private', title: '我的笔记', content: '做到第三步了', pinned: true })
    const t = await a.callTool({ name: 'task_create', arguments: { title: '修登录页' } })
    expect(t.isError).toBeFalsy()
    const ref = JSON.parse((t.content as { text: string }[])[0].text).ref as string
    expect((await a.callTool({ name: 'task_claim', arguments: { task: ref } })).isError).toBeFalsy()

    const ins = (await connect(alice.token)).getInstructions() ?? ''
    expect(ins).toContain('工具的 workspace 参数：填工作区的名字或 id')
    const at = (s: string): number => ins.indexOf(s)
    const order = [at('## 你的身份'), at('你能访问 2 个工作区'), at('## 全局记忆'), at('## 置顶记忆'), at('## 分给你的任务')]
    expect({ missing: order.map((n, i) => (n < 0 ? i : -1)).filter((i) => i >= 0), heads: ins.split('\n').filter((l) => l.startsWith('## ')) }).toMatchObject({ missing: [] })
    expect([...order].sort((x, y) => x - y)).toEqual(order)
    expect(ins.slice(at('## 分给你的任务'))).toContain('修登录页')
    // 任务后面没有别的段落
    expect(ins.slice(at('## 分给你的任务') + 3)).not.toContain('\n## ')
  })
})
