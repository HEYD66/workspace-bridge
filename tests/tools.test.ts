// 工具和技能工具集成测试：接入的 AI 全部工具都能用（没有全局停用、没有职位白名单）、技能的列出 / 加载 / 附带文件 / 提交。
// 真实 Bridge + 真实 MCP 客户端，每个用例一个干净的数据目录、工作区和用户级技能目录（不碰 ~/.workspace-bridge）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import type { Agent } from '../src/core/types'
import { TOOL_NAMES } from '../src/shared/tools'

const SKILL_TOOLS = ['list_skills', 'load_skill', 'read_skill_resource', 'install_skill']

let base: string
let root: string
let bridge: Bridge
let url: string
const clients: Client[] = []

interface Member {
  agent: Agent
  c: Client
}

interface Result {
  isError: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
}

async function connect(token: string, to = url): Promise<Client> {
  const c = new Client({ name: 'tools-test', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(to), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  clients.push(c)
  return c
}

async function join(name: string, roleId?: string): Promise<Member> {
  const agent = bridge.createAgent(name, roleId)
  return { agent, c: await connect(agent.token) }
}

/** 调用工具：正文按 JSON 解析（不是 JSON 就保留原文），【通知】部分丢掉 */
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const r = await c.callTool({ name, arguments: args })
  const body = (r.content as { type: string; text: string }[]).map((p) => p.text).find((t) => !t.startsWith('【通知】')) ?? ''
  let data: unknown = body
  try {
    data = JSON.parse(body)
  } catch {
    // load_skill、read_skill_resource 返回纯文本
  }
  return { isError: Boolean(r.isError), data }
}

/** 成功返回 OK，失败返回错误码（SDK 层的错误不是 JSON，返回 SDK_ERROR） */
const code = (r: Result): string => (r.isError ? (typeof r.data === 'object' ? r.data.error : 'SDK_ERROR') : 'OK')
const toolNames = async (c: Client): Promise<string[]> => (await c.listTools()).tools.map((t) => t.name).sort()
const sorted = (names: string[]) => [...names].sort()

function writeSkill(dir: string, name: string, description: string, body: string, extra: Record<string, string> = {}): void {
  const skillDir = path.join(dir, name)
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`)
  for (const [rel, content] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(skillDir, rel)), { recursive: true })
    fs.writeFileSync(path.join(skillDir, rel), content)
  }
}

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-tools-'))
  root = path.join(base, 'ws')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const a = 1\n')
  bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'user-skills') })
  await bridge.start()
  url = bridge.getState().mcpUrl
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  await bridge.stop()
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

describe('工具都能用', () => {
  it('全部工具都注册，包括技能工具和命令执行；whoami 写明完全权限', async () => {
    const a = await join('Alice')
    const names = await toolNames(a.c)
    expect(names).toEqual(sorted(TOOL_NAMES))
    expect(names).toEqual(expect.arrayContaining(SKILL_TOOLS))
    const me = (await call(a.c, 'whoami')).data
    expect(me.tools).toEqual(TOOL_NAMES)
    expect(me.permissions).toContain('完全权限')
    expect(me.machineAccess).toBe(false)
    // 去掉的字段不再返回
    expect(me).not.toHaveProperty('tier')
    expect(me).not.toHaveProperty('unavailableTools')
    expect(a.c.getInstructions()).not.toContain('## 不可用的工具')
  })

  it('有职位的 AI 也是全部工具：职位只剩名字和职责说明', async () => {
    // 旧版的职位权限字段传进来也不生效
    const legacy = { name: '读者', description: '只负责读代码', fileAccess: 'read', allowedTools: ['read_file'], writablePaths: ['docs'] }
    const role = await bridge.saveRole(legacy)
    expect(role).toEqual({ id: role.id, name: '读者', description: '只负责读代码' })
    const r = await join('Reader', role.id)
    expect(await toolNames(r.c)).toEqual(sorted(TOOL_NAMES))
    expect((await call(r.c, 'whoami')).data.role).toEqual({ name: '读者', duties: '只负责读代码' })
    expect(code(await call(r.c, 'write_file', { path: 'src/new.ts', content: 'x\n' }))).toBe('OK')
    expect(fs.readFileSync(path.join(root, 'src', 'new.ts'), 'utf8')).toBe('x\n')
    expect(r.c.getInstructions()).toContain('只负责读代码')
  })

  it('旧配置里的全局停用工具读入时丢掉：工具照常能用', async () => {
    await bridge.stop()
    const file = path.join(base, 'data', 'config.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    raw.disabledTools = ['write_file', 'run_command']
    fs.writeFileSync(file, JSON.stringify(raw))
    bridge = new Bridge({ dataDir: path.join(base, 'data'), port: 0, userSkillsDir: path.join(base, 'user-skills') })
    await bridge.start()
    url = bridge.getState().mcpUrl
    expect(bridge.config.get()).not.toHaveProperty('disabledTools')
    const a = await join('Alice')
    expect(await toolNames(a.c)).toEqual(sorted(TOOL_NAMES))
    expect(code(await call(a.c, 'write_file', { path: 'x.txt', content: 'x' }))).toBe('OK')
  })

  it('全部停下：所有调用返回 PAUSED，恢复后照常', async () => {
    const a = await join('Alice')
    bridge.setPaused(true)
    expect(code(await call(a.c, 'write_file', { path: 'x.txt', content: 'x' }))).toBe('PAUSED')
    expect(code(await call(a.c, 'list_dir'))).toBe('PAUSED')
    expect(fs.existsSync(path.join(root, 'x.txt'))).toBe(false)
    bridge.setPaused(false)
    expect(code(await call(a.c, 'write_file', { path: 'x.txt', content: 'x' }))).toBe('OK')
  })
})

describe('技能', () => {
  const skillsDir = () => path.join(root, '.bridge', 'skills')

  it('项目级技能：放进目录就能用，不用审阅；加载、读附带文件、越界被拒；文件被改也照常能用', async () => {
    writeSkill(skillsDir(), 'demo', '演示技能', '# Demo\n按步骤做：先读 reference.md\n', { 'reference.md': '参考资料第一行\n' })
    const a = await join('Alice')

    let list = (await call(a.c, 'list_skills')).data
    expect(list).not.toHaveProperty('pendingReview')
    expect(list.skills).toEqual([{ name: 'demo', description: '演示技能', scope: 'project', resources: ['reference.md'], hasScripts: false }])
    expect(bridge.listSkills().find((s) => s.id === 'project:demo')?.status).toBe('enabled')

    const loaded = await call(a.c, 'load_skill', { name: 'demo' })
    expect(loaded.isError).toBe(false)
    expect(loaded.data).toContain('# Demo')
    expect(loaded.data).toContain('附带文件：reference.md，用 read_skill_resource 读取')
    expect(loaded.data).not.toContain('脚本运行还没开放')

    const res = await call(a.c, 'read_skill_resource', { name: 'demo', file: 'reference.md' })
    expect(res.isError).toBe(false)
    expect(res.data).toContain('参考资料第一行')
    for (const file of ['../x.md', '../../src/app.ts', 'SKILL.md/../../demo2/a.md']) {
      expect((await call(a.c, 'read_skill_resource', { name: 'demo', file })).isError, file).toBe(true)
    }

    // 活动流：技能工具不把 file 当工作区路径
    const ev = bridge.recentEvents().find((e) => e.tool === 'read_skill_resource' && e.status === 'ok')
    expect(ev?.path).toBeUndefined()
    expect(bridge.recentEvents().find((e) => e.tool === 'load_skill' && e.status === 'ok')?.summary).toBe('加载技能 demo')

    // 新连接的说明里列出可用技能
    const c2 = await connect(a.agent.token)
    expect(c2.getInstructions()).toContain('## 可用技能（用 load_skill 加载）\n- demo：演示技能')

    // AI 用文件工具改了 SKILL.md：不再自动停用，加载到的是新内容
    const w = await call(a.c, 'write_file', { path: '.bridge/skills/demo/SKILL.md', content: '---\nname: demo\ndescription: 演示技能\n---\n# 被改了\n', overwrite: true })
    expect(w.isError).toBe(false)
    const again = await call(a.c, 'load_skill', { name: 'demo' })
    expect(again.isError).toBe(false)
    expect(again.data).toContain('# 被改了')
    list = (await call(a.c, 'list_skills')).data
    expect(list.skills.map((s: { name: string }) => s.name)).toEqual(['demo'])
  })

  it('用户停用的技能 AI 看不到也加载不了，重新启用后恢复', async () => {
    writeSkill(skillsDir(), 'demo', '演示技能', '# Demo\n')
    const a = await join('Alice')
    expect(bridge.setSkillEnabled('project:demo', false).status).toBe('disabled')
    expect((await call(a.c, 'list_skills')).data.skills).toEqual([])
    expect(code(await call(a.c, 'load_skill', { name: 'demo' }))).toBe('SKILL_NOT_ENABLED')
    expect(bridge.setSkillEnabled('project:demo', true).status).toBe('enabled')
    expect(code(await call(a.c, 'load_skill', { name: 'demo' }))).toBe('OK')
  })

  it('带 scripts/ 的技能加载时告诉 AI 技能目录在哪，脚本用 run_command 跑', async () => {
    writeSkill(skillsDir(), 'tool-kit', '带脚本的技能', '# Kit\n运行 scripts/run.sh\n', { 'scripts/run.sh': 'echo hi\n' })
    const a = await join('Alice')
    const loaded = await call(a.c, 'load_skill', { name: 'tool-kit' })
    expect(loaded.data).toContain(`技能目录在 ${path.join(skillsDir(), 'tool-kit').replace(/\\/g, '/')}，需要时用 run_command 运行`)
    expect((await call(a.c, 'list_skills')).data.skills[0].hasScripts).toBe(true)
  })

  it('install_skill：写入后直接生效，马上能列出和加载；有职位的 AI 也能提交', async () => {
    const a = await join('Alice')
    const r = await call(a.c, 'install_skill', {
      name: 'review-checklist',
      description: '代码审查清单',
      body: '# 审查清单\n逐条检查\n',
      files: [{ path: 'checklist.md', content: '- [ ] 类型\n' }]
    })
    expect(r.isError).toBe(false)
    expect(r.data.message).toContain('直接生效')
    expect(fs.existsSync(path.join(skillsDir(), 'review-checklist', 'SKILL.md'))).toBe(true)
    expect(fs.readFileSync(path.join(skillsDir(), 'review-checklist', 'checklist.md'), 'utf8')).toBe('- [ ] 类型\n')

    const list = (await call(a.c, 'list_skills')).data
    expect(list.skills.map((s: { name: string }) => s.name)).toEqual(['review-checklist'])
    expect((await call(a.c, 'load_skill', { name: 'review-checklist' })).data).toContain('# 审查清单')
    expect(bridge.listSkills().find((s) => s.id === 'project:review-checklist')).toMatchObject({ status: 'enabled', origin: 'agent' })
    expect(bridge.recentEvents().find((e) => e.tool === 'install_skill' && e.status === 'ok')?.path).toBe('.bridge/skills/review-checklist/SKILL.md')

    expect(code(await call(a.c, 'install_skill', { name: 'review-checklist', description: 'x', body: 'x' }))).toBe('SKILL_EXISTS')
    // 名字不合法在参数校验阶段就被拒
    expect((await call(a.c, 'install_skill', { name: '../evil', description: 'x', body: 'x' })).isError).toBe(true)
    expect(fs.existsSync(path.join(root, '.bridge', 'evil'))).toBe(false)

    // 以前被职位挡住的（测试、经理）现在都能提交
    const t = await join('Tester', 'tester')
    expect(code(await call(t.c, 'install_skill', { name: 't-skill', description: 'x', body: 'x' }))).toBe('OK')
    const boss = await join('Boss', 'manager')
    expect(code(await call(boss.c, 'install_skill', { name: 'b-skill', description: 'x', body: 'x' }))).toBe('OK')
    expect(code(await call(boss.c, 'load_skill', { name: 't-skill' }))).toBe('OK')
  })

  it('没有工作区：用户级技能照常可用，install_skill 返回 NO_WORKSPACE', async () => {
    const userDir = path.join(base, 'user-skills2')
    writeSkill(userDir, 'global-style', '全局写作风格', '# 风格\n')
    const b2 = new Bridge({ dataDir: path.join(base, 'data2'), port: 0, userSkillsDir: userDir })
    await b2.start()
    try {
      const agent = b2.createAgent('Solo')
      const c = await connect(agent.token, b2.getState().mcpUrl)
      expect(c.getInstructions()).toContain('- global-style：全局写作风格')
      const list = (await call(c, 'list_skills')).data
      expect(list.skills.map((s: { name: string; scope: string }) => `${s.scope}:${s.name}`)).toEqual(['user:global-style'])
      expect((await call(c, 'load_skill', { name: 'global-style' })).data).toContain('# 风格')
      expect(code(await call(c, 'install_skill', { name: 'x-skill', description: 'x', body: 'x' }))).toBe('NO_WORKSPACE')
      expect(code(await call(c, 'list_dir'))).toBe('NO_WORKSPACE')
    } finally {
      for (const c of clients.splice(0)) await c.close().catch(() => {})
      await b2.stop()
    }
  })

  it('连接说明里的技能清单有上限，超出提示用 list_skills', async () => {
    for (let i = 0; i < 35; i++) {
      const name = `s${String(i).padStart(2, '0')}`
      writeSkill(skillsDir(), name, `第 ${i} 个技能`, `# ${name}\n`)
    }
    const a = await join('Alice')
    const ins = a.c.getInstructions() ?? ''
    const section = ins.slice(ins.indexOf('## 可用技能'))
    expect(section.match(/^- s\d\d：/gm)?.length).toBe(30)
    expect(section).toContain('还有 5 个技能，用 list_skills 查看全部')
    expect((await call(a.c, 'list_skills')).data.skills).toHaveLength(35)
  })
})
