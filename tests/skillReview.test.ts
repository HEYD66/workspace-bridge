// AI 用 install_skill 提交的技能写在它指定的工作区里，不一定是工作台当前打开的那个（比如写进「整台电脑」，而工作台切不到整台电脑）。
// 权限精简后技能提交就生效，不用审阅；用户要能在工作台不切换当前工作区就看到别的工作区的技能，并能停用或删除。
// 整台电脑的起点（machineRoot）用临时目录，不碰真实的用户主目录
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { MACHINE_WORKSPACE_ID } from '../src/core/config'

let base: string
let bridge: Bridge
let projA: string
let projB: string
let home: string
let idA: string
let idB: string
const clients: Client[] = []

interface Result {
  isError: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  text: string
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const r = await c.callTool({ name, arguments: args })
  const body = (r.content as { type: string; text: string }[]).map((p) => p.text).find((t) => !t.startsWith('【通知】')) ?? ''
  let data: unknown = body
  try {
    data = JSON.parse(body)
  } catch {
    // 纯文本结果
  }
  return { isError: Boolean(r.isError), data, text: body }
}

﻿/** 连一个 AI；machine = 团队页的「允许用整台电脑」开关 */
async function join(name: string, machine = false): Promise<Client> {
  const agent = bridge.createAgent(name, undefined, machine)
  const c = new Client({ name: 'skill-review-test', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(bridge.getState().mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${agent.token}` } } }))
  clients.push(c)
  return c
}

const M = { workspace: MACHINE_WORKSPACE_ID }
const install = (c: Client, name: string, extra: Record<string, unknown> = {}) =>
  call(c, 'install_skill', { name, description: `${name} 的说明`, body: '## 步骤\n1. 照做', files: [{ path: 'reference.md', content: '参考' }], ...extra })

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-skillreview-'))
  projA = path.join(base, 'proj-a')
  projB = path.join(base, 'proj-b')
  home = path.join(base, 'home')
  for (const d of [projA, projB, home]) fs.mkdirSync(d, { recursive: true })
  bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoots: [projA, projB], machineRoot: home, port: 0, userSkillsDir: path.join(base, 'user-skills'), scheduler: { timers: false } })
  await bridge.start()
  const st = bridge.getState()
  idA = st.activeWorkspaceId!
  idB = st.workspaces.find((w) => w.kind !== 'machine' && w.id !== idA)!.id
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  await bridge.stop()
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

describe('AI 提交的技能不在当前工作区', () => {
  it('装到「整台电脑」的技能：直接生效；当前工作区的技能列表里没有它，指定整台电脑就能列出来', async () => {
    const ai = await join('Arena', true)
    const r = await install(ai, 'dev-flow', M)
    expect(r.isError).toBe(false)
    expect(fs.existsSync(path.join(home, '.bridge', 'skills', 'dev-flow', 'SKILL.md'))).toBe(true)

    // 项目级技能只属于它所在的工作区：当前工作区（proj-a）的列表里没有
    expect(bridge.getState().activeWorkspaceId).toBe(idA)
    expect(bridge.listSkills()).toEqual([])
    expect(bridge.listSkills(MACHINE_WORKSPACE_ID)).toEqual([
      expect.objectContaining({ id: 'project:dev-flow', status: 'enabled', origin: 'agent', installedBy: 'Arena', files: ['SKILL.md', 'reference.md'] })
    ])
  })

  it('install_skill 的返回告诉 AI 技能写进了哪个工作区、已经生效；马上能列出、加载，不用用户做任何事', async () => {
    const ai = await join('Arena', true)
    const r = await install(ai, 'dev-flow', M)
    expect(r.data.workspace).toBe('整台电脑')
    expect(r.data.message).toContain('「整台电脑」')
    expect(r.data.message).toContain('直接生效')
    const l = await call(ai, 'list_skills', M)
    expect(l.data).not.toHaveProperty('pendingReview')
    expect(l.data.skills.map((s: { name: string }) => s.name)).toEqual(['dev-flow'])
    expect((await call(ai, 'load_skill', { name: 'dev-flow', ...M })).text).toContain('1. 照做')
    // 默认工作区（proj-a）里没有这个技能
    expect((await call(ai, 'list_skills')).data.skills).toEqual([])
  })

  it('不切换当前工作区就能看别的工作区的技能、停用它；停用后 AI 用不了，重新启用恢复', async () => {
    const ai = await join('Arena', true)
    await install(ai, 'dev-flow', M)

    const d = bridge.getSkill('project:dev-flow', MACHINE_WORKSPACE_ID)
    expect(d.content).toContain('1. 照做')
    expect(d.dir).toBe(path.join(home, '.bridge', 'skills', 'dev-flow'))

    expect(bridge.setSkillEnabled('project:dev-flow', false, MACHINE_WORKSPACE_ID).status).toBe('disabled')
    expect(bridge.getState().activeWorkspaceId).toBe(idA)
    expect((await call(ai, 'list_skills', M)).data.skills).toEqual([])
    expect((await call(ai, 'load_skill', { name: 'dev-flow', ...M })).data.error).toBe('SKILL_NOT_ENABLED')

    expect(bridge.setSkillEnabled('project:dev-flow', true, MACHINE_WORKSPACE_ID).status).toBe('enabled')
    expect((await call(ai, 'load_skill', { name: 'dev-flow', ...M })).text).toContain('1. 照做')
  })

  it('不要的技能可以直接删掉（进回收站）', async () => {
    const ai = await join('Arena', true)
    await install(ai, 'dev-flow', M)
    await bridge.deleteSkill('project:dev-flow', MACHINE_WORKSPACE_ID)
    expect(fs.existsSync(path.join(home, '.bridge', 'skills', 'dev-flow'))).toBe(false)
    expect(bridge.listSkills(MACHINE_WORKSPACE_ID)).toEqual([])
    expect((await call(ai, 'list_skills', M)).data.skills).toEqual([])
  })

  it('装到另一个目录工作区的技能也一样：写进那个工作区，别的 AI 在那个工作区里也能用', async () => {
    const ai = await join('Bee')
    const r = await install(ai, 'b-only', { workspace: idB })
    expect(r.data.workspace).toBe('proj-b')
    expect(fs.existsSync(path.join(projB, '.bridge', 'skills', 'b-only', 'SKILL.md'))).toBe(true)
    expect(bridge.listSkills()).toEqual([])
    expect(bridge.listSkills(idB).map((s) => [s.id, s.status])).toEqual([['project:b-only', 'enabled']])

    const other = await join('Cat')
    expect((await call(other, 'list_skills', { workspace: 'proj-b' })).data.skills).toHaveLength(1)
    expect((await call(other, 'load_skill', { name: 'b-only', workspace: 'proj-b' })).text).toContain('1. 照做')
  })

  it('用户级技能不属于任何工作区：放进目录就在每个工作区的列表里，直接生效', async () => {
    await install(await join('Arena', true), 'm-skill', M)
    const ace = await join('Ace')
    await install(ace, 'a-skill')
    fs.mkdirSync(path.join(base, 'user-skills', 'mine'), { recursive: true })
    fs.writeFileSync(path.join(base, 'user-skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: x\n---\n\n正文')

    expect(bridge.listSkills().map((s) => [s.id, s.status])).toEqual([
      ['project:a-skill', 'enabled'],
      ['user:mine', 'enabled']
    ])
    expect(bridge.listSkills(MACHINE_WORKSPACE_ID).map((s) => s.id)).toEqual(['project:m-skill', 'user:mine'])
    expect((await call(ace, 'list_skills')).data.skills.map((s: { name: string }) => s.name)).toEqual(['a-skill', 'mine'])
  })

  it('生效后文件被改动：不再自动停用，AI 读到的是新内容', async () => {
    const ai = await join('Arena', true)
    await install(ai, 'dev-flow', M)
    fs.appendFileSync(path.join(home, '.bridge', 'skills', 'dev-flow', 'reference.md'), '\n后来加的一行')
    expect(bridge.listSkills(MACHINE_WORKSPACE_ID)[0]).toMatchObject({ id: 'project:dev-flow', status: 'enabled' })
    expect((await call(ai, 'read_skill_resource', { name: 'dev-flow', file: 'reference.md', ...M })).text).toContain('后来加的一行')
  })

  it('没开整台电脑的 AI 不能把技能装到整台电脑', async () => {
    const ai = await join('Plain')
    const r = await install(ai, 'nope', M)
    expect(r.data.error).toBe('WORKSPACE_FORBIDDEN')
    expect(fs.existsSync(path.join(home, '.bridge', 'skills', 'nope'))).toBe(false)
  })

  it('不指定工作区时操作不到别的工作区的技能；工作区不存在时报错', async () => {
    await install(await join('Arena', true), 'dev-flow', M)
    expect(() => bridge.getSkill('project:dev-flow')).toThrow('SKILL_NOT_FOUND')
    expect(() => bridge.setSkillEnabled('project:dev-flow', true)).toThrow('SKILL_NOT_FOUND')
    expect(() => bridge.listSkills('w_00000000')).toThrow('工作区不存在')
    expect(() => bridge.setSkillEnabled('project:dev-flow', true, 'w_00000000')).toThrow('工作区不存在')
    await expect(bridge.deleteSkill('project:dev-flow', 'w_00000000')).rejects.toThrow('工作区不存在')
  })

  it('在工作台给别的工作区新建项目级技能：写进那个工作区，直接启用', () => {
    const s = bridge.saveSkill({ scope: 'project', name: 'made-here', description: '我写的', body: '正文' }, MACHINE_WORKSPACE_ID)
    expect(s.status).toBe('enabled')
    expect(fs.existsSync(path.join(home, '.bridge', 'skills', 'made-here', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(projA, '.bridge', 'skills', 'made-here'))).toBe(false)
  })
})
