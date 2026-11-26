// 画布：工作台这边的 canvasGet / canvasUpdate / canvasModel，和 AI 用的 canvas_read / canvas_note
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'

describe('画布', () => {
  let base: string
  let bridge: Bridge
  let wsId: string
  const clients: Client[] = []

  async function connect(token: string): Promise<Client> {
    const c = new Client({ name: 'canvas-test', version: '1' })
    await c.connect(new StreamableHTTPClientTransport(new URL(bridge.getState().mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    clients.push(c)
    return c
  }
  const data = (r: unknown): Record<string, any> => {
    const text = (r as { content: { type: string; text: string }[] }).content.find((c) => c.type === 'text')!.text
    return JSON.parse(text)
  }

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-canvas-tools-'))
    fs.mkdirSync(path.join(base, 'alpha'), { recursive: true })
    bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoots: [path.join(base, 'alpha')], port: 0, userSkillsDir: path.join(base, 'user-skills') })
    await bridge.start()
    wsId = bridge.getState().workspaces[0].id
  })
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.stop()
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
  })

  it('工作台改画布：发 changed(canvas, 工作区 id)；停掉再开还在', async () => {
    const seen: unknown[][] = []
    bridge.on('changed', (...args: unknown[]) => {
      if (args[0] === 'canvas') seen.push(args)
    })
    const doc = bridge.canvasUpdate(wsId, [{ op: 'move', nodes: [{ id: 'x', x: 10, y: 20 }] }, { op: 'viewport', x: 1, y: 2, zoom: 1.5 }])
    expect(doc.version).toBe(1)
    expect(seen).toEqual([['canvas', wsId]])
    expect(bridge.canvasGet(wsId).nodes).toEqual({ x: { x: 10, y: 20 } })
    expect(() => bridge.canvasUpdate('w_nope', [])).toThrow(/不存在/)
    // 总画布那一份：不是工作区也能存；canvasAll 一次给全
    bridge.canvasUpdate('all', [{ op: 'move', nodes: [{ id: `a1@${wsId}`, x: 5, y: 6 }] }])
    expect(seen[1]).toEqual(['canvas', 'all'])
    const every = bridge.canvasAll()
    // 内置的「整台电脑」也有一份
    expect(Object.keys(every)).toEqual(expect.arrayContaining([wsId, 'all']))
    expect(every.all.nodes).toEqual({ [`a1@${wsId}`]: { x: 5, y: 6 } })
    expect(every[wsId].nodes).toEqual({ x: { x: 10, y: 20 } })
    await bridge.stop()
    const again = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoots: [path.join(base, 'alpha')], port: 0, userSkillsDir: path.join(base, 'user-skills') })
    expect(again.canvasGet(wsId).viewport).toEqual({ x: 1, y: 2, zoom: 1.5 })
  })

  it('canvasModel：连着的 AI 有卡片和状态，主脑和子代理有框和线', async () => {
    const alice = bridge.createAgent('Alice')
    const bob = bridge.createAgent('Bob')
    await connect(alice.token)
    bridge.setChatLead(`ws:${wsId}`, alice.id)
    const m = bridge.canvasModel(wsId)
    expect(m.cards.map((c) => c.name).sort()).toEqual(['Alice', 'Bob'])
    expect(m.cards.find((c) => c.id === alice.id)).toMatchObject({ lead: true })
    expect(m.cards.find((c) => c.id === alice.id)!.state).not.toBe('offline')
    expect(m.cards.find((c) => c.id === bob.id)!.state).toBe('offline')
    expect(m.frames).toHaveLength(1)
    expect(m.frames[0]).toMatchObject({ kind: 'team', leadId: alice.id, cardIds: [alice.id, bob.id] })
    expect(m.lines.map((l) => l.id)).toEqual([`team:${alice.id}>${bob.id}`])
  })

  it('AI 贴便签、改、删，canvas_read 看得到；贴在某人卡片旁边', async () => {
    const alice = bridge.createAgent('Alice')
    const bob = bridge.createAgent('Bob')
    const c = await connect(alice.token)

    const made = data(await c.callTool({ name: 'canvas_note', arguments: { text: '这块我在改，先别动', near: 'Bob', color: 'yellow' } }))
    expect(made.id).toMatch(/^n_/)
    const doc = bridge.canvasGet(wsId)
    expect(doc.notes[0]).toMatchObject({ id: made.id, text: '这块我在改，先别动', by: alice.id, byName: 'Alice', color: 'yellow', near: bob.id })

    const read = data(await c.callTool({ name: 'canvas_read', arguments: {} }))
    expect(read.totals.agents).toBe(2)
    expect(read.cards.map((x: { name: string }) => x.name).sort()).toEqual(['Alice', 'Bob'])
    expect(read.notes).toEqual([{ id: made.id, text: '这块我在改，先别动', by: 'Alice', color: 'yellow' }])

    await c.callTool({ name: 'canvas_note', arguments: { id: made.id, text: '改完了' } })
    expect(bridge.canvasGet(wsId).notes[0].text).toBe('改完了')
    await c.callTool({ name: 'canvas_note', arguments: { id: made.id, delete: true } })
    expect(bridge.canvasGet(wsId).notes).toEqual([])
  })

  it('接力线：Alice 做完任务，线那头的 Bob 收到通知，带着交付说明；画布模型里有这条线', async () => {
    const alice = bridge.createAgent('Alice')
    const bob = bridge.createAgent('Bob')
    const ca = await connect(alice.token)
    const cb = await connect(bob.token)
    const doc = bridge.canvasUpdate(wsId, [{ op: 'addRelay', from: alice.id, to: bob.id }])
    expect(bridge.canvasModel(wsId).lines).toContainEqual({ id: `relay:${doc.relays[0].id}`, kind: 'relay', from: alice.id, to: bob.id, relayId: doc.relays[0].id })

    const made = data(await ca.callTool({ name: 'task_create', arguments: { title: '写登录页', assigneeId: 'Alice' } }))
    const ref = made.ref as string
    await ca.callTool({ name: 'task_claim', arguments: { task: ref } })
    const text = (r: unknown): string => (r as { content: { type: string; text: string }[] }).content.map((c) => c.text).join('\n')
    // 还没做完：Bob 没有接力通知
    expect(text(await cb.callTool({ name: 'whoami', arguments: {} }))).not.toContain('[接力]')
    await ca.callTool({ name: 'task_update', arguments: { task: ref, status: 'done', result: '登录页写好了，在 src/Login.tsx' } })
    expect(bridge.listTasks(wsId).find((t) => t.ref === ref)?.status).toBe('done')
    const got = text(await cb.callTool({ name: 'whoami', arguments: {} }))
    expect(got).toContain(`[接力] Alice 做完了 ${ref}「写登录页」`)
    expect(got).toContain('登录页写好了，在 src/Login.tsx')
    // 做完的交付用户还没看：算等你；看过就不算了
    expect(bridge.canvasModel(wsId).cards.find((c) => c.id === alice.id)!.attention).toMatchObject([{ kind: 'delivered', taskRef: ref }])
    bridge.canvasUpdate(wsId, [{ op: 'ackTasks', refs: [ref] }], undefined)
    await new Promise((r) => setTimeout(r, 5))
    expect(bridge.canvasModel(wsId).totals.attention).toBe(0)
    // 只通知一次
    expect(text(await cb.callTool({ name: 'whoami', arguments: {} }))).not.toContain('[接力]')
  })

  it('canvas_note 的错：没内容、便签不存在、成员不存在', async () => {
    const c = await connect(bridge.createAgent('Alice').token)
    for (const args of [{}, { text: '  ' }, { id: 'n_none', text: 'x' }, { id: 'n_none', delete: true }, { delete: true }, { text: 'x', near: '没这个人' }]) {
      const r = await c.callTool({ name: 'canvas_note', arguments: args })
      expect(r.isError, JSON.stringify(args)).toBe(true)
    }
    expect(bridge.canvasGet(wsId).notes).toEqual([])
  })
})
