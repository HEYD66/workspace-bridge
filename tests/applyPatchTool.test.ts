// apply_patch 工具的集成测试：注册、有职位也不受限、版本冲突、路径守卫（凭据文件名不再拦）。
// 真实 Bridge + 真实 MCP 客户端；补丁引擎本身（解析、匹配、回滚）的细节在 patchApplier.test.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import type { Agent } from '../src/core/types'
import { TOOL_CATALOG } from '../src/shared/tools'

let base: string
let root: string
let bridge: Bridge
let url: string
const clients: Client[] = []

interface Result {
  isError: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
}

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 'apply-patch-test', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  clients.push(c)
  return c
}

async function join(name: string, roleId?: string): Promise<{ agent: Agent; c: Client }> {
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
    // read_file 返回纯文本
  }
  return { isError: Boolean(r.isError), data }
}

const code = (r: Result): string => (r.isError ? (typeof r.data === 'object' ? r.data.error : 'SDK_ERROR') : 'OK')
const toolNames = async (c: Client): Promise<string[]> => (await c.listTools()).tools.map((t) => t.name)
const P = (...lines: string[]): string => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')
const text = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')
const exists = (rel: string): boolean => fs.existsSync(path.join(root, rel))

async function versionOf(c: Client, rel: string): Promise<string> {
  const r = await call(c, 'read_file', { path: rel })
  return String(r.data).match(/version: (\S+)/)![1]
}

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-patch-'))
  root = path.join(base, 'ws')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const a = 1\n')
  fs.writeFileSync(path.join(root, 'docs', 'old.md'), 'old\n')
  bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'user-skills') })
  await bridge.start()
  url = bridge.getState().mcpUrl
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  await bridge.stop()
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

const MULTI = P(
  '*** Update File: src/app.ts',
  '@@',
  '-export const a = 1',
  '+export const a = 2',
  '*** Add File: src/new.ts',
  '+export const b = 1',
  '*** Delete File: docs/old.md'
)

describe('apply_patch 工具', () => {
  it('登记在文件修改组', () => {
    expect(TOOL_CATALOG.find((t) => t.name === 'apply_patch')?.group).toBe('file-write')
  })

  it('一次改、增、删三个文件；结果写明不是整体原子，删除进回收站', async () => {
    const a = await join('Alice')
    expect(await toolNames(a.c)).toContain('apply_patch')
    const v = await versionOf(a.c, 'src/app.ts')
    const r = await call(a.c, 'apply_patch', { patch: MULTI, expected_versions: { 'src/app.ts': v } })
    expect(code(r)).toBe('OK')
    expect(r.data.status).toBe('success')
    expect(r.data.multi_file_atomic).toBe(false)
    expect(r.data.summary.files_changed).toBe(3)
    expect(r.data.files.map((f: { action: string }) => f.action).sort()).toEqual(['add', 'delete', 'update'])
    expect(r.data.files.find((f: { action: string }) => f.action === 'delete').trash_id).toBeTruthy()
    expect(text('src/app.ts')).toBe('export const a = 2\n')
    expect(text('src/new.ts')).toBe('export const b = 1\n')
    expect(exists('docs/old.md')).toBe(false)
    // 新版本号和 read_file 一致，可以接着用
    expect(r.data.files.find((f: { path: string }) => f.path === 'src/app.ts').new_version).toBe(await versionOf(a.c, 'src/app.ts'))
  })

  it('expected_versions 不对：CONFLICT，整个补丁一个文件都不写', async () => {
    const a = await join('Alice')
    const r = await call(a.c, 'apply_patch', { patch: MULTI, expected_versions: { 'src/app.ts': '0000000000000000' } })
    expect(code(r)).toBe('CONFLICT')
    expect(text('src/app.ts')).toBe('export const a = 1\n')
    expect(exists('src/new.ts')).toBe(false)
    expect(exists('docs/old.md')).toBe(true)
  })

  it('有职位的 AI 也能改任何目录：职位不再限制文件权限和可写目录', async () => {
    for (const roleId of ['manager', 'tester']) {
      const w = await join(`W-${roleId}`, roleId)
      const patch = P(`*** Add File: src/${roleId}.ts`, '+x', `*** Add File: docs/${roleId}.md`, '+y')
      expect(code(await call(w.c, 'apply_patch', { patch })), roleId).toBe('OK')
      expect(text(`src/${roleId}.ts`)).toBe('x\n')
      expect(text(`docs/${roleId}.md`)).toBe('y\n')
    }
  })

  it('越出工作区被路径守卫拒绝，同一补丁里的其他文件也不写', async () => {
    const a = await join('Alice')
    const outside = P('*** Add File: src/ok.ts', '+ok', '*** Add File: ../outside.txt', '+x')
    expect(code(await call(a.c, 'apply_patch', { patch: outside }))).not.toBe('OK')
    expect(fs.existsSync(path.join(base, 'outside.txt'))).toBe(false)
    expect(exists('src/ok.ts')).toBe(false)
  })

  it('凭据文件名不再拦：补丁能写 .env', async () => {
    const a = await join('Alice')
    const env = P('*** Add File: src/ok.ts', '+ok', '*** Add File: .env', '+SECRET=1')
    expect(code(await call(a.c, 'apply_patch', { patch: env }))).toBe('OK')
    expect(text('.env')).toBe('SECRET=1\n')
    expect(text('src/ok.ts')).toBe('ok\n')
  })

  it('补丁格式错误：INVALID_PATCH', async () => {
    const a = await join('Alice')
    expect(code(await call(a.c, 'apply_patch', { patch: '*** Begin Patch\n*** Frobnicate File: a\n*** End Patch' }))).toBe('INVALID_PATCH')
  })
})
