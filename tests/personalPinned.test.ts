// T-14：置顶的个人记忆单独一节带进开场说明。以前和全局记忆共用 1500 字，全局记忆一长就被挤掉，
// 只剩一句「还有 1 条，用 memory_search scope=global 查看」（个人记忆在 scope=global 里也查不到）。第 44 批上线后 arena-006 重连发现
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { PERSONAL_MEMORY_BUDGET } from '../src/core/mcpServer'

describe('置顶的个人记忆在开场说明里', () => {
  let base: string
  let bridge: Bridge
  const clients: Client[] = []

  async function connect(token: string): Promise<Client> {
    const c = new Client({ name: 'pinned-test', version: '1' })
    await c.connect(new StreamableHTTPClientTransport(new URL(bridge.getState().mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    clients.push(c)
    return c
  }
  type Res = { isError?: boolean; content: { type: string; text: string }[] }
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}): Promise<Res> => (await c.callTool({ name, arguments: args })) as Res
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (r: Res): any => JSON.parse(r.content[0].text)
  const SECTION = '## 你的置顶个人记忆'
  const sectionOf = (ins: string, title: string): string => {
    const i = ins.indexOf(title)
    if (i < 0) return ''
    const j = ins.indexOf('\n## ', i + 3)
    return ins.slice(i, j < 0 ? undefined : j)
  }

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pinned-'))
    for (const d of ['alpha', 'beta']) fs.mkdirSync(path.join(base, d), { recursive: true })
    bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoots: [path.join(base, 'alpha'), path.join(base, 'beta')], port: 0, userSkillsDir: path.join(base, 'user-skills') })
    await bridge.start()
  })
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.stop()
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
  })

  it('全局记忆写满了，置顶的个人记忆照样全文带上，单独一节；全局那节的「还有几条」只算全局的；别人看不到', async () => {
    const alice = bridge.createAgent('Alice')
    const bob = bridge.createAgent('Bob')
    const a = await connect(alice.token)
    for (let i = 0; i < 5; i++) expect((await call(a, 'memory_save', { scope: 'global', title: `规范 ${i}`, content: '字'.repeat(500) })).isError).toBeFalsy()
    const body = '工作目录 D:/AProgram/MCP-wt-alice，分支 feat/x-alice，负责 src/core/x.ts'
    const p = data(await call(a, 'memory_save', { scope: 'personal', pinned: true, title: 'Alice 的干活位置', content: body }))
    expect((await call(a, 'memory_save', { scope: 'personal', title: '没置顶的笔记', content: '不该出现' })).isError).toBeFalsy()

    const ins = (await connect(alice.token)).getInstructions() ?? ''
    const mine = sectionOf(ins, SECTION)
    expect(mine).toContain('### Alice 的干活位置（个人）')
    expect(mine).toContain(body)
    expect(mine).not.toContain('没置顶的笔记')
    expect(mine).not.toContain('还有')
    // 全局那节还是 1500 字上限，挤不下的只报全局的条数，个人记忆不在里面
    const global = sectionOf(ins, '## 全局记忆')
    expect(global).toMatch(/还有 \d 条，用 memory_search scope=global 查看/)
    expect(global).not.toContain('Alice 的干活位置')
    // 位置：全局记忆之后、分给你的任务之前（任务仍然是最后一段）
    expect(ins.indexOf('## 全局记忆')).toBeLessThan(ins.indexOf(SECTION))
    // 置顶了就不再提醒写（T-13 的那一节）
    expect(ins).not.toContain('## 给这个身份留一条置顶的个人记忆')

    const insBob = (await connect(bob.token)).getInstructions() ?? ''
    expect(insBob).not.toContain(SECTION)
    expect(insBob).not.toContain(p.id)
    expect(insBob).not.toContain('Alice 的干活位置')
  })

  it('太长：第一条超了带开头并给 memory_read 的 id；放不下的后几条报个数，查看提示是 scope=personal', async () => {
    const alice = bridge.createAgent('Alice')
    const a = await connect(alice.token)
    const long = data(await call(a, 'memory_save', { scope: 'personal', pinned: true, title: '很长的笔记', content: `开头${'长'.repeat(5000)}结尾` }))
    let mine = sectionOf((await connect(alice.token)).getInstructions() ?? '', SECTION)
    expect(mine).toContain('### 很长的笔记（个人）\n开头长长')
    expect(mine).not.toContain('结尾')
    expect(mine).toContain(`全文用 memory_read ${long.id} 看`)
    expect(mine.length).toBeLessThan(PERSONAL_MEMORY_BUDGET + 200)

    // 再置顶一条短的：新的排前面，长的那条放不下，报个数
    await new Promise((r) => setTimeout(r, 5))
    expect((await call(a, 'memory_save', { scope: 'personal', pinned: true, title: '短的', content: '工作目录 alpha' })).isError).toBeFalsy()
    mine = sectionOf((await connect(alice.token)).getInstructions() ?? '', SECTION)
    expect(mine).toContain('### 短的（个人）\n工作目录 alpha')
    expect(mine).toContain('还有 1 条置顶个人记忆没放下，用 memory_search scope=personal 查看')
    expect(mine).not.toContain('开头长长')
  })
})
