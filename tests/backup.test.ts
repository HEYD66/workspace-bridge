// 设置备份与恢复、诊断报告：导出、导入预览、应用、导入前自动备份和轮转、不含 token 的导出和重新生成、坏数据丢弃、诊断报告不含 token
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { backupConfigFile, parseBackup, TOKEN_PLACEHOLDER } from '../src/core/backup'
import { MACHINE_WORKSPACE_ID } from '../src/core/config'
import { LlmStore } from '../src/core/llm/store'

let base: string
let bridges: Bridge[] = []

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-backup-'))
  bridges = []
})

afterEach(async () => {
  for (const b of bridges) await b.stop()
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

const API_KEY = 'sk-test-SECRET-api-key-1234567890'

/** 一台「电脑」：自己的数据目录，带内置 AI 的提供方存储（Key 明文存，好验证它不会被导出） */
function machine(name: string, opts: { start?: boolean } = {}) {
  const dataDir = path.join(base, name, 'data')
  const bridge = new Bridge({
    dataDir,
    port: 0,
    userSkillsDir: path.join(base, name, 'skills'),
    machineRoot: path.join(base, name, 'home'),
    appVersion: '9.9.9-test',
    findTools: () => ({ rg: '/usr/bin/rg', cloudflared: null, gitBash: 'C:/Git/bin/bash.exe', pwsh: null })
  })
  bridges.push(bridge)
  const llm = new LlmStore(path.join(dataDir, 'llm.json'), undefined)
  bridge.setLlmBackup({
    exportForBackup: () => llm.exportForBackup(),
    importFromBackup: (input) => llm.importFromBackup(input, (id) => !!bridge.config.getAgent(id))
  })
  if (opts.start) void bridge.start()
  return { bridge, llm, dataDir }
}

function dir(rel: string): string {
  const p = path.join(base, rel)
  fs.mkdirSync(p, { recursive: true })
  return p
}

/** 源电脑：两个工作区、一个自定义职位、三个 AI（Alice 开了整台电脑、Bob 有职位）、隧道 token、提供方 */
async function source() {
  const m = machine('src')
  const { bridge, llm } = m
  const wa = await bridge.addWorkspace(dir('proj-a'))
  const wb = await bridge.addWorkspace(dir('proj-b'))
  const role = await bridge.saveRole({ name: '审查员', description: '只看不改' })
  const alice = bridge.createAgent('Alice', undefined, true)
  const bob = bridge.createAgent('Bob', role.id)
  const carol = bridge.createAgent('Carol')
  bridge.config.updateTunnel({ mode: 'named', hostname: 'mcp.example.com', token: 'cf-tunnel-SECRET-token-abcdef123456' })
  const p = llm.saveProvider({ name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: API_KEY, models: ['deepseek-chat'] })
  llm.setAgentModel(alice.id, { providerId: p.id, model: 'deepseek-chat' })
  return { ...m, wa, wb, role, alice: bridge.config.getAgent(alice.id)!, bob, carol, provider: p }
}

describe('导出', () => {
  it('含 token：文件开头有提醒，带工作区、AI 和 token（含整台电脑开关）、职位、隧道、提供方（不含 API Key）、技能清单', async () => {
    const s = await source()
    const text = s.bridge.exportBackup({ includeTokens: true })
    const json = JSON.parse(text)
    expect(Object.keys(json)[0]).toBe('warning')
    expect(json.warning).toContain('像密码一样保管')
    expect(json).toMatchObject({ format: 'workspace-bridge-backup', version: 1, includesTokens: true, appVersion: '9.9.9-test' })
    expect(json.config.workspaces.map((w: { name: string }) => w.name)).toEqual(['proj-a', 'proj-b'])
    expect(json.config.agents.find((a: { name: string }) => a.name === 'Alice')).toMatchObject({ token: s.alice.token, machineAccess: true })
    expect(json.config.agents.find((a: { name: string }) => a.name === 'Carol')).not.toHaveProperty('machineAccess')
    // 已经去掉的设置不再导出
    for (const k of ['"tier"', '"execAllowed"', '"workspaceIds"', '"disabledTools"', '"fileAccess"', '"allowedTools"']) expect(text, k).not.toContain(k)
    expect(json.config.roles.some((r: { name: string }) => r.name === '审查员')).toBe(true)
    expect(json.config.tunnel).toMatchObject({ mode: 'named', hostname: 'mcp.example.com', token: 'cf-tunnel-SECRET-token-abcdef123456' })
    expect(json.llm.providers).toEqual([expect.objectContaining({ name: 'DeepSeek', hasKey: true })])
    expect(json.llm.agents[s.alice.id]).toMatchObject({ model: 'deepseek-chat' })
    expect(Array.isArray(json.userSkills)).toBe(true)
    // API Key 永远不导出（明文、密文都不带）
    expect(text).not.toContain(API_KEY)
    expect(text).not.toContain('"apiKey"')
  })

  it('不含 token：AI token 和隧道 token 都换成占位符', async () => {
    const s = await source()
    const text = s.bridge.exportBackup({ includeTokens: false })
    const json = JSON.parse(text)
    expect(json.includesTokens).toBe(false)
    expect(json.warning).toContain('不含 token')
    for (const a of s.bridge.config.get().agents) expect(text).not.toContain(a.token)
    expect(text).not.toContain('cf-tunnel-SECRET')
    expect(json.config.agents.every((a: { token: string }) => a.token === TOKEN_PLACEHOLDER)).toBe(true)
    expect(json.config.tunnel.token).toBe(TOKEN_PLACEHOLDER)
  })
})

describe('导入', () => {
  it('预览：列出新增的工作区、AI、职位，目录不存在的标出来；预览不改配置', async () => {
    const s = await source()
    const text = s.bridge.exportBackup({ includeTokens: true })
    // 目标电脑上 proj-b 的目录不存在
    fs.rmSync(path.join(base, 'proj-b'), { recursive: true })
    const t = machine('dst')
    const before = JSON.stringify(t.bridge.config.get())
    const p = t.bridge.previewImport(text)
    expect(p.importId).toMatch(/^[0-9a-f]{16}$/)
    expect(p.workspaces.map((w) => [w.name, w.action, w.exists])).toEqual([
      ['proj-a', 'add', true],
      ['proj-b', 'add', false]
    ])
    expect(p.agents.map((a) => [a.name, a.action, a.machineAccess, a.tokenRegenerated])).toEqual([
      ['Alice', 'add', true, false],
      ['Bob', 'add', false, false],
      ['Carol', 'add', false, false]
    ])
    // 导入会让一个 AI 能用整台电脑：预览里写明
    expect(p.warnings.some((w) => w.includes('Alice') && w.includes('整台电脑'))).toBe(true)
    expect(p).not.toHaveProperty('disabledTools')
    expect(p.roles.find((r) => r.name === '审查员')?.action).toBe('add')
    expect(p.tunnel).toBe(true)
    expect(p.llm?.providers).toEqual([{ name: 'DeepSeek', action: 'add' }])
    expect(p.warnings.some((w) => w.includes('API Key'))).toBe(true)
    // 预览里没有 token
    expect(JSON.stringify(p)).not.toContain(s.alice.token)
    expect(JSON.stringify(t.bridge.config.get())).toBe(before)
  })

  it('应用：导入后工作区、AI（token、整台电脑开关、职位）、隧道、提供方都对上，并重启 MCP 服务', async () => {
    const s = await source()
    const text = s.bridge.exportBackup({ includeTokens: true })
    const t = machine('dst')
    await t.bridge.start()
    const resets: unknown[] = []
    t.bridge.on('reset', (ids) => resets.push(ids))
    const { importId } = t.bridge.previewImport(text)
    const r = await t.bridge.applyImport(importId)
    expect(r.regenerated).toEqual([])
    const cfg = t.bridge.config.get()
    const ws = Object.fromEntries(cfg.workspaces.map((w) => [w.name, w]))
    expect(Object.keys(ws)).toEqual(['proj-a', 'proj-b'])
    const alice = cfg.agents.find((a) => a.name === 'Alice')!
    expect(alice).toMatchObject({ id: s.alice.id, token: s.alice.token, machineAccess: true })
    expect(cfg.agents.find((a) => a.name === 'Carol')).not.toHaveProperty('machineAccess')
    const bob = cfg.agents.find((a) => a.name === 'Bob')!
    expect(t.bridge.config.getRole(bob.roleId)?.name).toBe('审查员')
    expect(cfg.tunnel).toMatchObject({ mode: 'named', hostname: 'mcp.example.com', token: 'cf-tunnel-SECRET-token-abcdef123456' })
    expect(cfg).not.toHaveProperty('disabledTools')
    // 提供方进来了但没有 Key；Alice 的模型绑定跟着进来
    expect(t.llm.listProviders()).toEqual([expect.objectContaining({ name: 'DeepSeek', hasKey: false })])
    expect(r.llm).toMatchObject({ added: ['DeepSeek'], needKey: ['DeepSeek'], bindings: 1 })
    expect(t.llm.getAgentModel(alice.id)?.model).toBe('deepseek-chat')
    expect(resets).toContainEqual(['*'])
    expect(t.bridge.getState().running).toBe(true)
    // 同一个 importId 不能用两次
    await expect(t.bridge.applyImport(importId)).rejects.toThrow('过期')
  })

  it('导入到已有配置：按路径和 id 合并，已有的覆盖、本机独有的保留；已有提供方保留本机 Key', async () => {
    const s = await source()
    const text = s.bridge.exportBackup({ includeTokens: true })
    // 源电脑自己再导入一次（改过名、关了整台电脑），已有的应该被覆盖回去
    await s.bridge.updateAgent(s.alice.id, { machineAccess: false })
    s.bridge.renameWorkspace(s.wa.id, '改过的名字')
    const extra = s.bridge.createAgent('本机独有')
    const p = s.bridge.previewImport(text)
    expect(p.workspaces.find((w) => w.root === s.wa.root)?.action).toBe('update')
    expect(p.agents.find((a) => a.name === 'Alice')?.action).toBe('update')
    await s.bridge.applyImport(p.importId)
    expect(s.bridge.config.getAgent(s.alice.id)?.machineAccess).toBe(true)
    expect(s.bridge.config.getWorkspace(s.wa.id)?.name).toBe('proj-a')
    expect(s.bridge.config.getAgent(extra.id)).toBeDefined()
    expect(s.bridge.config.get().workspaces).toHaveLength(2)
    expect(s.llm.listProviders()[0].hasKey).toBe(true)
  })

  it('不含 token 的备份：新 AI 重新生成 token，本机已有的 AI 保留本机 token，隧道 token 保留本机的', async () => {
    const s = await source()
    const text = s.bridge.exportBackup({ includeTokens: false })
    const t = machine('dst')
    const p = t.bridge.previewImport(text)
    expect(p.agents.every((a) => a.tokenRegenerated)).toBe(true)
    const r = await t.bridge.applyImport(p.importId)
    expect(r.regenerated.map((x) => x.name).sort()).toEqual(['Alice', 'Bob', 'Carol'])
    const tokens = t.bridge.config.get().agents.map((a) => a.token)
    expect(new Set(tokens).size).toBe(3)
    for (const tok of tokens) {
      expect(tok).toMatch(/^wb_/)
      expect(tok).not.toBe(TOKEN_PLACEHOLDER)
      expect([s.alice.token, s.bob.token, s.carol.token]).not.toContain(tok)
    }
    // 目标电脑原来没有隧道 token：不会把占位符写进去
    expect(t.bridge.config.get().tunnel.token).toBeUndefined()

    // 源电脑自己导入：已有 AI 保留 token，隧道 token 保留
    const p2 = s.bridge.previewImport(text)
    expect(p2.agents.some((a) => a.tokenRegenerated)).toBe(false)
    await s.bridge.applyImport(p2.importId)
    expect(s.bridge.config.getAgent(s.alice.id)?.token).toBe(s.alice.token)
    expect(s.bridge.config.get().tunnel.token).toBe('cf-tunnel-SECRET-token-abcdef123456')
  })

  it('导入前自动备份 config.json，最多留 10 份', async () => {
    const s = await source()
    const text = s.bridge.exportBackup({ includeTokens: true })
    const cfgBefore = fs.readFileSync(path.join(s.dataDir, 'config.json'), 'utf8')
    const r = await s.bridge.applyImport(s.bridge.previewImport(text).importId)
    expect(r.backupFile && fs.readFileSync(r.backupFile, 'utf8')).toBe(cfgBefore)
    expect(path.dirname(r.backupFile!)).toBe(path.join(s.dataDir, 'backups'))
    // 轮转：再备份 12 次，只剩最新的 10 份，最新的那份在
    let last = ''
    for (let i = 0; i < 12; i++) last = backupConfigFile(s.dataDir, Date.UTC(2030, 0, 1, 0, 0, i))!
    const files = fs.readdirSync(path.join(s.dataDir, 'backups'))
    expect(files).toHaveLength(10)
    expect(files).toContain(path.basename(last))
    expect(files).not.toContain(path.basename(r.backupFile!))
  })

  it('坏数据被丢掉：不是备份文件、相对路径、根目录、坏 id、找不到的职位都不会原样进来；旧备份里的档位、限定工作区、停用工具被忽略', async () => {
    const t = machine('dst')
    expect(() => t.bridge.previewImport('not json')).toThrow('JSON')
    expect(() => t.bridge.previewImport(JSON.stringify({ format: 'other' }))).toThrow('不是 Workspace Bridge')
    expect(() => t.bridge.previewImport(JSON.stringify({ format: 'workspace-bridge-backup', version: 99 }))).toThrow('版本')
    const good = dir('good')
    const bad = {
      format: 'workspace-bridge-backup',
      version: 1,
      includesTokens: true,
      config: {
        workspaces: [{ root: 'relative/path' }, { root: path.parse(base).root }, { root: good, name: 'ok', id: 'w_12345678' }, 'garbage'],
        roles: [{ id: '../evil', name: 'x' }, { id: 'r_ok', name: '好职位', fileAccess: 'everything', allowedTools: 'all' }],
        agents: [
          { id: 'a1', name: '档位乱写', tier: 'god', token: 'wb_' + 'x'.repeat(32), execAllowed: 'yes', machineAccess: 'yes', color: 'red' },
          { id: 'a2', name: '职位不在', tier: 'auto', roleId: 'r_missing', token: 'not-a-token' },
          { id: '', name: '没 id' },
          { id: 'a3', name: '工作区不在', tier: 'auto', token: 'wb_' + 'y'.repeat(32), workspaceIds: ['w_ffffffff'] },
          { id: 'a4', name: '旧备份勾过整台电脑', tier: 'read-only', token: 'wb_' + 'z'.repeat(32), workspaceIds: ['w_12345678', MACHINE_WORKSPACE_ID] },
          { id: 'a1', name: '重复 id' }
        ],
        tunnel: { mode: 'named', hostname: 'not a host!', token: 'has space' },
        disabledTools: ['delete', 'no_such_tool', 'whoami']
      },
      llm: { providers: [{ id: 'p1', name: 'bad', kind: 'weird', baseUrl: 'x' }], agents: { a1: { providerId: 'p1', model: 'm' } } }
    }
    const p = t.bridge.previewImport(JSON.stringify(bad))
    expect(p.workspaces.map((w) => w.name)).toEqual(['ok'])
    expect(p.dropped.length).toBeGreaterThanOrEqual(5)
    const r = await t.bridge.applyImport(p.importId)
    expect(r.regenerated.map((x) => x.name)).toEqual(['职位不在'])
    const cfg = t.bridge.config.get()
    expect(cfg.workspaces.map((w) => w.root)).toEqual([path.resolve(good)])
    const role = cfg.roles.find((x) => x.id === 'r_ok')!
    // 职位只留名字和职责说明
    expect(role).toEqual({ id: 'r_ok', name: '好职位', description: '' })
    expect(cfg.roles.some((x) => x.id === '../evil')).toBe(false)
    const a1 = cfg.agents.find((a) => a.id === 'a1')!
    expect(a1).toMatchObject({ name: '档位乱写', color: '#60a5fa' })
    // 整台电脑只认严格的 true
    for (const k of ['tier', 'execAllowed', 'machineAccess']) expect(a1, k).not.toHaveProperty(k)
    // 职位找不到：取消职位（职位只是职责说明，不影响权限）
    const a2 = cfg.agents.find((a) => a.id === 'a2')!
    expect(a2.roleId).toBeUndefined()
    expect(a2.token).toMatch(/^wb_/)
    // 旧备份的工作区勾选不再使用；勾过整台电脑的开关打开
    const a3 = cfg.agents.find((a) => a.id === 'a3')!
    for (const k of ['workspaceIds', 'machineAccess']) expect(a3, k).not.toHaveProperty(k)
    const a4 = cfg.agents.find((a) => a.id === 'a4')!
    expect(a4.machineAccess).toBe(true)
    expect(a4).not.toHaveProperty('workspaceIds')
    expect(p.agents.find((a) => a.id === 'a4')?.machineAccess).toBe(true)
    expect(cfg.agents.filter((a) => a.id === 'a1')).toHaveLength(1)
    expect(cfg.tunnel.hostname).toBeUndefined()
    expect(cfg.tunnel.token).toBeUndefined()
    expect(cfg).not.toHaveProperty('disabledTools')
    expect(t.llm.listProviders()).toEqual([])
    expect(r.llm?.dropped).toBe(2)
    expect(p.warnings.some((w) => w.includes('r_missing'))).toBe(true)
  })

  it('parseBackup 拒绝超过 10 MB 的文件', () => {
    expect(() => parseBackup('x'.repeat(10 * 1024 * 1024 + 1))).toThrow('太大')
  })
})

describe('诊断报告', () => {
  it('有各节内容，不含任何 token 和 API Key（包括错误信息和参数里的）', async () => {
    const s = await source()
    await s.bridge.start()
    // 造一条参数和错误信息里都带 token 的错误事件
    const ev = s.bridge.log.start({ agentId: s.alice.id, agentName: 'Alice', agentColor: '#fff', tool: 'read_file', args: { path: 'x', note: s.bob.token, auth: `Bearer ${s.carol.token}` } })
    s.bridge.log.finish(ev, { status: 'error', error: `NOT_FOUND: 文件不存在 ${s.alice.token}` })
    const md = s.bridge.diagnosticsReport()
    for (const h of ['# Workspace Bridge 诊断报告', '## 版本和环境', '## MCP 服务', '## 外部程序', '## 工作区', '## AI', '## 最近 24 小时', '## 最近的错误']) {
      expect(md).toContain(h)
    }
    expect(md).toContain('9.9.9-test')
    expect(md).toContain(process.versions.node)
    expect(md).toContain('/usr/bin/rg')
    expect(md).toContain('C:/Git/bin/bash.exe')
    expect(md).toContain('proj-a')
    expect(md).toContain('所有 AI 都是完全权限')
    expect(md).toMatch(/\| Alice \| 无 \| 否 \| 开 \| 3 \|/)
    expect(md).toMatch(/\| Bob \| 审查员 \| 否 \| 关 \| 2 \|/)
    expect(md).toContain('| read_file | NOT_FOUND |')
    expect(md).toContain('运行中')
    for (const a of s.bridge.config.get().agents) expect(md).not.toContain(a.token)
    expect(md).not.toContain('cf-tunnel-SECRET')
    expect(md).not.toContain(API_KEY)
    expect(md).not.toMatch(/wb_[A-Za-z0-9_-]{20,}/)
  })

  it('没有工作区、AI 和错误时也能生成；目录不存在的工作区标出来', async () => {
    const t = machine('empty')
    const ws = await t.bridge.addWorkspace(dir('gone'))
    fs.rmSync(ws.root, { recursive: true })
    const md = t.bridge.diagnosticsReport()
    expect(md).toContain('**不存在**')
    expect(md).toContain('## 最近的错误（0）')
    expect(md).toContain('没有运行')
  })
})
