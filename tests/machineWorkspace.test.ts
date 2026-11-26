// 内置的「整台电脑」工作区：PathGuard 的整机模式、配置里始终有它（固定 id、不存进工作区列表、兼容旧版「整台机器」条目）、
// FileTools 的扫描限制，以及真实 Bridge + MCP 客户端走一遍（开了整台电脑的 AI 能跨目录读写、没开的不能、搜索限制、检查点回滚）。
// 为了不碰真实的用户主目录，整台电脑的起点（machineRoot）和「工作区外的目录」都建在临时目录里
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { ConfigStore, MACHINE_WORKSPACE_ID, MACHINE_WORKSPACE_NAME } from '../src/core/config'
import { FileTools } from '../src/core/fileTools'
import { isDriveRoot, listDrives, PathError, PathGuard } from '../src/core/pathGuard'

let base: string
/** 整机工作区的起始目录 */
let start: string
/** 起始目录以外的另一个目录（模拟别的盘 / 别的项目） */
let other: string
/** 本应用数据目录 */
let data: string

const slash = (p: string): string => p.split(path.sep).join('/')
const codeOf = (fn: () => unknown): string => {
  try {
    fn()
    return 'OK'
  } catch (e) {
    return e instanceof PathError ? e.code : String(e)
  }
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-machine-')))
  start = path.join(base, 'home')
  other = path.join(base, 'other')
  data = path.join(base, 'data')
  for (const d of [start, other, data, path.join(other, 'proj', 'src'), path.join(other, 'AppData', 'Local')]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(start, 'notes.md'), 'home notes\n')
  fs.writeFileSync(path.join(other, 'proj', 'src', 'app.ts'), 'export const a = 1 // needle\n')
  fs.writeFileSync(path.join(other, 'proj', '.env'), 'SECRET=1\n')
  fs.writeFileSync(path.join(other, 'AppData', 'Local', 'cache.ts'), 'needle in cache\n')
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

describe('PathGuard 整机模式', () => {
  it('相对路径从起始目录算，绝对路径可以落在起始目录外，返回的 rel 是 / 分隔的绝对路径', () => {
    const g = new PathGuard(start, [data], { machine: true })
    expect(g.machine).toBe(true)
    expect(g.resolve('notes.md')).toEqual({ abs: path.join(start, 'notes.md'), rel: 'notes.md' })
    const app = path.join(other, 'proj', 'src', 'app.ts')
    expect(g.resolve(app)).toEqual({ abs: app, rel: slash(app) })
    expect(g.resolve(slash(app)).abs).toBe(app)
    expect(g.toRel(app)).toBe(slash(app))
    expect(g.toRel(path.join(start, 'a', 'b.md'))).toBe('a/b.md')
    // 往上走出起始目录也行
    expect(g.resolve('../other/proj/src/app.ts').abs).toBe(app)
  })

  it('凭据文件名和 .git 内部不再拦；本应用数据目录在整机模式下照样拦', () => {
    const g = new PathGuard(start, [data], { machine: true })
    expect(codeOf(() => g.resolve(path.join(other, 'proj', '.env')))).toBe('OK')
    expect(codeOf(() => g.resolve(path.join(other, '.git', 'config')))).toBe('OK')
    expect(codeOf(() => g.resolve(path.join(other, '.ssh', 'id_rsa')))).toBe('OK')
    expect(codeOf(() => g.resolve(path.join(data, 'config.json')))).toBe('PROTECTED')
    expect(codeOf(() => g.resolve(`${slash(other)}/x.txt:stream`))).toBe('INVALID_PATH')
  })

  it('普通工作区不受影响：起始目录外照样越界', () => {
    const g = new PathGuard(start, [data])
    expect(g.machine).toBe(false)
    expect(codeOf(() => g.resolve(path.join(other, 'proj', 'src', 'app.ts')))).toBe('OUTSIDE_WORKSPACE')
    expect(codeOf(() => g.resolve('../other/x.txt'))).toBe('OUTSIDE_WORKSPACE')
    expect(g.isMachineSkipDir(path.join(other, 'AppData'))).toBe(false)
  })

  it('能列出本机的盘，能认出盘根，遍历时跳过 AppData 和盘根下的系统目录', () => {
    const drives = listDrives()
    expect(drives.length).toBeGreaterThan(0)
    for (const d of drives) expect(isDriveRoot(d)).toBe(true)
    expect(isDriveRoot(start)).toBe(false)
    const g = new PathGuard(start, [data], { machine: true })
    expect(g.isMachineSkipDir(path.join(other, 'AppData'))).toBe(true)
    expect(g.isMachineSkipDir(path.join(other, 'proj'))).toBe(false)
    const driveRoot = path.parse(start).root
    const sys = process.platform === 'win32' ? 'Windows' : 'proc'
    expect(g.isMachineSkipDir(path.join(driveRoot, sys))).toBe(true)
    // 不在盘根下的同名目录不跳过
    expect(g.isMachineSkipDir(path.join(other, sys))).toBe(false)
    if (process.platform === 'win32') {
      // "D:" 这种不带斜杠的写法按盘根算
      const letter = drives[0].slice(0, 2)
      expect(g.resolve(letter).abs).toBe(path.resolve(`${letter}\\`))
      expect(g.resolve(letter).rel).toBe(`${letter}/`)
    }
  })
})

describe('配置里的整台电脑', () => {
  it('不用添加就有：固定 id、名字「整台电脑」、起点是 machineRoot；不进工作区列表，也不会成为当前工作区', () => {
    const cfg = new ConfigStore(path.join(data, 'cfg'), undefined, start)
    const m = cfg.machineWorkspace()
    expect(m).toEqual({ id: MACHINE_WORKSPACE_ID, name: MACHINE_WORKSPACE_NAME, root: start, kind: 'machine' })
    expect(MACHINE_WORKSPACE_NAME).toBe('整台电脑')
    expect(cfg.get().workspaces).toHaveLength(0)
    expect(cfg.allWorkspaces()).toEqual([m])
    expect(cfg.activeWorkspace()).toBeUndefined()
    // 按 id、名字都能找到
    expect(cfg.getWorkspace(MACHINE_WORKSPACE_ID)).toEqual(m)
    expect(cfg.findWorkspace('整台电脑')).toEqual(m)
    // 起点目录同时作为普通工作区加入：两个都在，id 不同，当前工作区是普通的那个
    const folder = cfg.addWorkspace(start)
    expect(folder.workspace.kind).toBeUndefined()
    expect(folder.workspace.id).not.toBe(MACHINE_WORKSPACE_ID)
    expect(cfg.allWorkspaces().map((w) => w.id)).toEqual([folder.workspace.id, MACHINE_WORKSPACE_ID])
    expect(cfg.activeWorkspace()?.id).toBe(folder.workspace.id)
    // AI 的整台电脑开关：默认没有这个字段（关），打开后存盘、重新读取还在，关掉后字段删掉
    expect(cfg.addAgent('Plain')).not.toHaveProperty('machineAccess')
    const agent = cfg.addAgent('M', undefined, true)
    expect(agent.machineAccess).toBe(true)
    expect(agent).not.toHaveProperty('workspaceIds')
    const again = new ConfigStore(path.join(data, 'cfg'), undefined, start)
    expect(again.getAgent(agent.id)?.machineAccess).toBe(true)
    expect(again.updateAgent(agent.id, { machineAccess: false })).not.toHaveProperty('machineAccess')
    expect(again.get().workspaces.map((w) => w.id)).toEqual([folder.workspace.id])
  })

  it('兼容旧配置：之前手动加的「整台机器」条目不报错、不丢别的工作区；AI 勾过整台电脑（含旧 id）的开关保持打开，没勾过的是关', () => {
    const dir = path.join(data, 'legacy')
    const cfg = new ConfigStore(dir, undefined, start)
    const proj = cfg.addWorkspace(other).workspace
    const agent = cfg.addAgent('Old')
    const plain = cfg.addAgent('OnlyProj')
    const builtin = cfg.addAgent('Builtin')
    // 模拟上一版写进 config.json 的三个整台机器（一个没写起始目录），其中一个是当前工作区，两个被 AI 勾着
    const raw = JSON.parse(fs.readFileSync(cfg.file, 'utf8'))
    raw.workspaces.push(
      { id: 'w_1111aaaa', name: '整台机器', root: start, kind: 'machine' },
      { id: 'w_2222bbbb', name: '整台机器 2', root: other, kind: 'machine' },
      { id: 'w_3333cccc', name: '整台机器 3', kind: 'machine' }
    )
    raw.activeWorkspaceId = 'w_2222bbbb'
    const legacy: Record<string, object> = {
      [agent.id]: { tier: 'auto', execAllowed: true, workspaceIds: ['w_2222bbbb', proj.id, 'w_1111aaaa'] },
      [plain.id]: { tier: 'read-only', limits: { perMinute: 5 }, workspaceIds: [proj.id] },
      [builtin.id]: { tier: 'ask', workspaceIds: [MACHINE_WORKSPACE_ID] }
    }
    raw.agents = raw.agents.map((a: { id: string }) => ({ ...a, ...legacy[a.id] }))
    fs.writeFileSync(cfg.file, JSON.stringify(raw))

    const loaded = new ConfigStore(dir, undefined, start)
    expect(loaded.get().workspaces).toEqual([proj])
    expect(loaded.activeWorkspace()?.id).toBe(proj.id)
    expect(loaded.getAgent(agent.id)?.machineAccess).toBe(true)
    expect(loaded.getAgent(builtin.id)?.machineAccess).toBe(true)
    expect(loaded.getAgent(plain.id)).not.toHaveProperty('machineAccess')
    // 已经去掉的字段读入时丢掉
    for (const a of loaded.get().agents) {
      for (const k of ['tier', 'execAllowed', 'limits', 'workspaceIds']) expect(a, `${a.name}.${k}`).not.toHaveProperty(k)
    }
    expect(loaded.allWorkspaces().filter((w) => w.kind === 'machine')).toHaveLength(1)
  })
})

describe('FileTools 整机模式', () => {
  it('能读写起始目录外的文件；不能整盘搜索、不能删除或移动盘根；遍历跳过 AppData', async () => {
    const files = new FileTools(new PathGuard(start, [data], { machine: true }), path.join(data, 'trash'))
    const target = path.join(other, 'proj', 'src', 'new.ts')
    await files.writeFile(slash(target), 'export const b = 2\n')
    expect(fs.readFileSync(target, 'utf8')).toBe('export const b = 2\n')

    const found = await files.findFiles({ pattern: '*.ts', path: slash(other) })
    const paths = JSON.stringify(found)
    expect(paths).toContain(`${slash(other)}/proj/src/app.ts`)
    expect(paths).not.toContain('cache.ts')
    // 直接把 AppData 当起点照常搜
    expect(JSON.stringify(await files.findFiles({ pattern: '*.ts', path: slash(path.join(other, 'AppData')) }))).toContain('cache.ts')

    const driveRoot = slash(path.parse(start).root)
    await expect(files.findFiles({ pattern: '*.ts', path: driveRoot })).rejects.toThrow(/整个盘/)
    await expect(files.search({ query: 'needle', path: driveRoot } as Parameters<FileTools['search']>[0])).rejects.toThrow(/整个盘/)
    await expect(files.delete(driveRoot)).rejects.toThrow(/根目录/)
    await expect(files.move(driveRoot, slash(path.join(other, 'x')))).rejects.toThrow(/根目录/)

    // 删除起始目录外的文件：进回收站
    await files.delete(slash(target))
    expect(fs.existsSync(target)).toBe(false)
  })

  it('数据目录的上级目录不能移动、删除，也不能当 move 的覆盖目标（否则 token 会被带出保护范围）', async () => {
    // 数据目录放在 base/appdata/bridge 下，模拟 %APPDATA%/workspace-bridge/bridge
    const nested = path.join(base, 'appdata', 'bridge')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(nested, 'config.json'), '{"token":"secret"}')
    const files = new FileTools(new PathGuard(start, [nested], { machine: true }), path.join(data, 'trash'))
    const parent = slash(path.join(base, 'appdata'))
    await expect(files.move(parent, slash(path.join(other, 'stolen')))).rejects.toMatchObject({ code: 'PROTECTED' })
    await expect(files.delete(parent)).rejects.toMatchObject({ code: 'PROTECTED' })
    // 普通目录覆盖到数据目录的上级
    fs.mkdirSync(path.join(other, 'junk'))
    await expect(files.move(slash(path.join(other, 'junk')), parent, undefined, true)).rejects.toMatchObject({ code: 'PROTECTED' })
    expect(fs.readFileSync(path.join(nested, 'config.json'), 'utf8')).toContain('secret')
    // 旁边的普通目录照常能挪
    await files.move(slash(path.join(other, 'junk')), slash(path.join(other, 'junk2')))
    expect(fs.existsSync(path.join(other, 'junk2'))).toBe(true)
  })

  it('经 junction 指向盘根的目录也算盘根：不能整盘搜索、删除、移动', async () => {
    if (process.platform !== 'win32') return
    const link = path.join(base, 'dj')
    fs.symlinkSync(path.parse(base).root, link, 'junction')
    try {
      const files = new FileTools(new PathGuard(start, [data], { machine: true }), path.join(data, 'trash'))
      await expect(files.search({ query: 'needle', path: slash(link) } as Parameters<FileTools['search']>[0])).rejects.toThrow(/整个盘/)
      await expect(files.findFiles({ pattern: '*.ts', path: slash(link) })).rejects.toThrow(/整个盘/)
      await expect(files.delete(slash(link))).rejects.toThrow(/根目录/)
    } finally {
      fs.rmdirSync(link)
    }
  })
})

describe('Bridge + MCP：整台电脑', () => {
  let bridge: Bridge
  const clients: Client[] = []
  let proj: string

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
  const code = (r: Result): string => (r.isError ? (typeof r.data === 'object' ? r.data.error : 'SDK_ERROR') : 'OK')

  beforeEach(async () => {
    proj = path.join(base, 'project')
    fs.mkdirSync(proj)
    fs.writeFileSync(path.join(proj, 'README.md'), '# project\n')
    bridge = new Bridge({ dataDir: data, workspaceRoot: proj, machineRoot: start, port: 0, userSkillsDir: path.join(base, 'user-skills') })
    await bridge.start()
  })

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.stop()
  })

  /** machine = 团队页的「允许用整台电脑」开关，默认关 */
  async function join(machine = false): Promise<Client> {
    const agent = bridge.createAgent('Machine', undefined, machine)
    const c = new Client({ name: 'machine-test', version: '1.0.0' })
    await c.connect(new StreamableHTTPClientTransport(new URL(bridge.getState().mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${agent.token}` } } }))
    clients.push(c)
    return c
  }

  const items = (r: Result) => (Array.isArray(r.data) ? r.data : r.data.workspaces) as { id: string; name: string; kind?: string; drives?: string[]; root: string; default: boolean }[]
  const projId = (): string => (bridge.getState().workspaces ?? []).find((w) => !w.kind)!.id

  it('不用添加就在工作区列表最后，不是当前工作区；开了它的 AI 在 list_workspaces 里看到 kind 和盘', async () => {
    const ws = bridge.getState().workspaces ?? []
    expect(ws.map((w) => w.kind ?? 'dir')).toEqual(['dir', 'machine'])
    expect(ws[1]).toMatchObject({ id: MACHINE_WORKSPACE_ID, name: '整台电脑', root: start, exists: true })
    expect(bridge.config.get().activeWorkspaceId).not.toBe(MACHINE_WORKSPACE_ID)
    const c = await join(true)
    const list = await call(c, 'list_workspaces')
    expect(code(list)).toBe('OK')
    const m = items(list).find((w) => w.kind === 'machine')!
    expect(m.name).toBe('整台电脑')
    expect(m.root).toBe(start)
    expect(m.default).toBe(false)
    expect(m.drives!.length).toBeGreaterThan(0)
    expect(items(list).find((w) => !w.kind)!.default).toBe(true)
  })

  it('开了「整台电脑」的 AI：用绝对路径读写别的目录（凭据文件也能读），数据目录照样拦，搜索不能整盘，改动能回滚', async () => {
    const c = await join(true)
    expect(items(await call(c, 'list_workspaces')).map((w) => w.id)).toEqual([projId(), MACHINE_WORKSPACE_ID])
    expect((await call(c, 'whoami')).data.machineAccess).toBe(true)
    const W = { workspace: '整台电脑' }
    const app = slash(path.join(other, 'proj', 'src', 'app.ts'))
    expect((await call(c, 'read_file', { ...W, path: app })).text).toContain('needle')
    // 按 id 指定也行；相对路径从起点（用户主目录）算
    expect((await call(c, 'read_file', { workspace: MACHINE_WORKSPACE_ID, path: 'notes.md' })).text).toContain('home notes')
    expect((await call(c, 'read_file', { ...W, path: slash(path.join(other, 'proj', '.env')) })).text).toContain('SECRET=1')
    expect(code(await call(c, 'read_file', { ...W, path: slash(path.join(data, 'config.json')) }))).not.toBe('OK')
    // 普通工作区（默认）不受影响
    expect(code(await call(c, 'read_file', { path: app }))).toBe('OUTSIDE_WORKSPACE')

    const s = await call(c, 'search', { ...W, query: 'needle', path: slash(other) })
    expect(code(s)).toBe('OK')
    expect(s.text).toContain('app.ts')
    expect(s.text).not.toContain('cache.ts')
    expect(code(await call(c, 'search', { ...W, query: 'needle', path: slash(path.parse(start).root) }))).toBe('INVALID_ARGS')

    expect(code(await call(c, 'write_file', { ...W, path: app, content: 'changed\n', overwrite: true }))).toBe('OK')
    expect(fs.readFileSync(path.join(other, 'proj', 'src', 'app.ts'), 'utf8')).toBe('changed\n')
    const created = path.join(other, 'proj', 'src', 'created.ts')
    expect(code(await call(c, 'write_file', { ...W, path: slash(created), content: 'new file\n' }))).toBe('OK')
    expect(fs.readFileSync(created, 'utf8')).toBe('new file\n')
    const rb = await call(c, 'checkpoint_rollback', W)
    expect(code(rb)).toBe('OK')
    expect(fs.readFileSync(path.join(other, 'proj', 'src', 'app.ts'), 'utf8')).toBe('export const a = 1 // needle\n')
  })

  it('开了整台电脑、但一个工作区都没添加：默认工作区就是整台电脑，不传 workspace 也能用绝对路径读写', async () => {
    await bridge.removeWorkspace(projId())
    const c = await join(true)
    const list = items(await call(c, 'list_workspaces'))
    expect(list.map((w) => [w.id, w.default])).toEqual([[MACHINE_WORKSPACE_ID, true]])
    const target = path.join(other, 'only-machine.txt')
    expect(code(await call(c, 'write_file', { path: slash(target), content: 'hi\n' }))).toBe('OK')
    expect(fs.readFileSync(target, 'utf8')).toBe('hi\n')
    expect((await call(c, 'read_file', { path: slash(path.join(proj, 'README.md')) })).text).toContain('# project')
  })

  it('开关一拨就生效，连接不断：打开后同一个连接马上能用整台电脑并收到通知；关掉后马上又不能用', async () => {
    const agent = bridge.createAgent('Toggle')
    const connect = async (): Promise<Client> => {
      const c = new Client({ name: 'machine-test', version: '1.0.0' })
      await c.connect(new StreamableHTTPClientTransport(new URL(bridge.getState().mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${agent.token}` } } }))
      clients.push(c)
      return c
    }
    const app = slash(path.join(other, 'proj', 'src', 'app.ts'))
    const c1 = await connect()
    expect((await call(c1, 'whoami')).data.machineAccess).toBe(false)
    const denied = await call(c1, 'read_file', { workspace: '整台电脑', path: app })
    expect(code(denied)).toBe('WORKSPACE_FORBIDDEN')
    expect(denied.data.message).toContain('允许用整台电脑')

    await bridge.updateAgent(agent.id, { machineAccess: true })
    expect(bridge.config.getAgent(agent.id)?.machineAccess).toBe(true)
    // 同一个连接：不用重连，下一次调用就带着通知，并且已经能用
    const raw = await c1.callTool({ name: 'whoami', arguments: {} })
    const blocks = (raw.content as { text: string }[]).map((p) => p.text)
    expect(JSON.parse(blocks[0]).machineAccess).toBe(true)
    expect(blocks[1]).toContain('【通知】')
    expect(blocks[1]).toContain('用户给你打开了「整台电脑」')
    expect(items(await call(c1, 'list_workspaces')).map((w) => w.id)).toEqual([projId(), MACHINE_WORKSPACE_ID])
    expect((await call(c1, 'read_file', { workspace: '整台电脑', path: app })).text).toContain('needle')
    // 新连接也一样
    const c2 = await connect()
    expect((await call(c2, 'whoami')).data.machineAccess).toBe(true)

    await bridge.updateAgent(agent.id, { machineAccess: false })
    expect(bridge.config.getAgent(agent.id)).not.toHaveProperty('machineAccess')
    const off = await c1.callTool({ name: 'read_file', arguments: { workspace: '整台电脑', path: app } })
    const offBlocks = (off.content as { text: string }[]).map((p) => p.text)
    expect(JSON.parse(offBlocks[0]).error).toBe('WORKSPACE_FORBIDDEN')
    expect(offBlocks[1]).toContain('用户关掉了你的「整台电脑」')
    expect(items(await call(c1, 'list_workspaces')).map((w) => w.id)).toEqual([projId()])
    expect(code(await call(c2, 'read_file', { workspace: '整台电脑', path: app }))).toBe('WORKSPACE_FORBIDDEN')
    // 默认工作区照常能用
    expect((await call(c1, 'read_file', { path: 'README.md' })).text).toContain('# project')
    // 改名字不动开关，连接也不断，也不发通知
    await bridge.updateAgent(agent.id, { name: 'Renamed' })
    const renamed = await c1.callTool({ name: 'whoami', arguments: {} })
    expect((renamed.content as { text: string }[]).map((p) => p.text).filter((t) => t.includes('整台电脑」'))).toHaveLength(0)
  })

  it('没开「整台电脑」的 AI（默认）：列表里没有它，指定它会被拒，工作区外的绝对路径读写不了；添加的工作区全都能用', async () => {
    const secondDir = path.join(base, 'second')
    fs.mkdirSync(secondDir)
    fs.writeFileSync(path.join(secondDir, 'a.txt'), 'second ws\n')
    const second = await bridge.addWorkspace(secondDir)
    const c = await join()
    expect(items(await call(c, 'list_workspaces')).map((w) => w.id)).toEqual([projId(), second.id])
    expect((await call(c, 'read_file', { workspace: second.id, path: 'a.txt' })).text).toContain('second ws')
    expect((await call(c, 'read_file', { workspace: projId(), path: 'README.md' })).text).toContain('# project')
    const app = slash(path.join(other, 'proj', 'src', 'app.ts'))
    expect(code(await call(c, 'read_file', { workspace: '整台电脑', path: app }))).toBe('WORKSPACE_FORBIDDEN')
    expect(code(await call(c, 'read_file', { workspace: MACHINE_WORKSPACE_ID, path: app }))).toBe('WORKSPACE_FORBIDDEN')
    expect(code(await call(c, 'read_file', { path: app }))).toBe('OUTSIDE_WORKSPACE')
    const target = path.join(other, 'nope.txt')
    expect(code(await call(c, 'write_file', { path: slash(target), content: 'x\n' }))).toBe('OUTSIDE_WORKSPACE')
    expect(code(await call(c, 'write_file', { workspace: '整台电脑', path: slash(target), content: 'x\n' }))).toBe('WORKSPACE_FORBIDDEN')
    expect(fs.existsSync(target)).toBe(false)
  })
})
