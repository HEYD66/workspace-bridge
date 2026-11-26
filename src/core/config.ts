import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { normalizeMembers } from './accessScope'
import { PRESET_ROLES } from './roles'
import type { Agent, AuthMode, BridgeConfig, Role, TunnelConfig, WorkspaceInfo } from './types'

export const AGENT_COLORS = ['#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#f87171', '#22d3ee', '#fb923c']

const DEFAULT_CONFIG: BridgeConfig = {
  workspaces: [],
  host: '127.0.0.1',
  port: 8765,
  agents: [],
  roles: [],
  lanEnabled: false,
  tunnel: { mode: 'quick', autoStart: false },
  authMode: 'link'
}

const WORKSPACE_ID_RE = /^w_[0-9a-f]{8}$/
const MAX_WORKSPACE_NAME = 40

/** 旧配置或手改坏的 tunnel 字段：缺什么补什么，类型不对就丢掉 */
function normalizeTunnel(raw: unknown): TunnelConfig {
  const t = raw && typeof raw === 'object' ? (raw as Partial<TunnelConfig>) : {}
  return {
    mode: t.mode === 'named' ? 'named' : 'quick',
    ...(typeof t.hostname === 'string' && t.hostname.trim() ? { hostname: t.hostname.trim() } : {}),
    ...(typeof t.token === 'string' && t.token.trim() ? { token: t.token.trim() } : {}),
    autoStart: t.autoStart === true,
    ...(t.keepOnExit === true ? { keepOnExit: true } : {})
  }
}

export function newToken(): string {
  return 'wb_' + crypto.randomBytes(24).toString('base64url')
}

/** 路径比较键：Windows 不区分大小写 */
export function workspaceKey(root: string): string {
  return path.resolve(root).toLowerCase()
}

/** 工作区 id 由去重键算出：移出列表再加回同一路径，id 不变，任务、记忆、群聊频道照样对得上 */
function idForKey(key: string): string {
  return 'w_' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 8)
}

/** 「整台电脑」的 id 种子，也是它数据目录的哈希种子（和旧版第一个「整台机器」相同，旧配置里的勾选、检查点照样有效） */
export const MACHINE_DATA_SEED = 'machine:'
/** 「整台电脑」固定的 id：内置、不存进工作区列表，每个 AI 的「能访问的工作区」里都能直接勾 */
export const MACHINE_WORKSPACE_ID = idForKey(MACHINE_DATA_SEED)
/** 「整台电脑」的名字 */
export const MACHINE_WORKSPACE_NAME = '整台电脑'

function cleanName(name: string): string {
  return name.replace(/[\r\n\t]/g, ' ').trim().slice(0, MAX_WORKSPACE_NAME)
}

/** 名字大小写不敏感唯一，重名加 -2、-3… */
function uniqueName(base: string, taken: WorkspaceInfo[]): string {
  const b = cleanName(base) || 'workspace'
  const used = new Set(taken.map((w) => w.name.toLowerCase()))
  if (!used.has(b.toLowerCase())) return b
  for (let i = 2; ; i++) {
    const n = `${b.slice(0, MAX_WORKSPACE_NAME - String(i).length - 1)}-${i}`
    if (!used.has(n.toLowerCase())) return n
  }
}

function uniqueId(key: string, taken: WorkspaceInfo[]): string {
  const ids = new Set(taken.map((w) => w.id))
  const id = idForKey(key)
  if (!ids.has(id)) return id
  // 两个路径哈希撞了（几乎不会发生）：退回随机 id
  for (;;) {
    const r = 'w_' + crypto.randomBytes(4).toString('hex')
    if (!ids.has(r)) return r
  }
}

/**
 * 读配置时整理工作区列表：旧版的 workspaceRoot 迁移成一个工作区；
 * 去掉路径重复、字段不对的条目，补齐 id 和名字。
 * 旧版手动添加的「整台机器」条目不再放进列表（整台电脑改成内置的了），它们的 id 记在 legacyMachineIds 里，
 * 读 AI 的 workspaceIds 时换成内置整台电脑的 id
 */
function normalizeWorkspaces(raw: Record<string, unknown>): { workspaces: WorkspaceInfo[]; activeWorkspaceId?: string; legacyMachineIds: Set<string> } {
  const list: WorkspaceInfo[] = []
  const seen = new Set<string>()
  const legacyMachineIds = new Set<string>()
  const src: unknown[] = Array.isArray(raw.workspaces)
    ? raw.workspaces
    : typeof raw.workspaceRoot === 'string' && raw.workspaceRoot.trim()
      ? [{ root: raw.workspaceRoot }]
      : []
  for (const item of src) {
    const w = item && typeof item === 'object' ? (item as Partial<WorkspaceInfo>) : {}
    if ((w as { kind?: unknown }).kind === 'machine') {
      if (typeof w.id === 'string') legacyMachineIds.add(w.id)
      continue
    }
    if (typeof w.root !== 'string' || !w.root.trim()) continue
    const root = path.resolve(w.root)
    const key = workspaceKey(root)
    if (seen.has(key)) continue
    seen.add(key)
    const id =
      typeof w.id === 'string' && WORKSPACE_ID_RE.test(w.id) && w.id !== MACHINE_WORKSPACE_ID && !list.some((x) => x.id === w.id) ? w.id : uniqueId(key, list)
    const name = typeof w.name === 'string' && w.name.trim() ? uniqueName(w.name, list) : uniqueName(path.basename(root), list)
    const members = normalizeMembers((w as { members?: unknown }).members)
    list.push({ id, name, root, ...(members ? { members } : {}) })
  }
  const wanted = typeof raw.activeWorkspaceId === 'string' ? raw.activeWorkspaceId : undefined
  const active = list.find((w) => w.id === wanted)?.id ?? list[0]?.id
  return { workspaces: list, ...(active ? { activeWorkspaceId: active } : {}), legacyMachineIds }
}

/** 旧配置的 workspaceIds：去重、只留字符串（现在只用来看里面有没有整台电脑） */
function normalizeWorkspaceIds(ids: unknown): string[] | undefined {
  if (!Array.isArray(ids)) return undefined
  const out = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))]
  return out.length ? out : undefined
}

/** 读 config.json 时的规范化（导入备份也走这里）：旧字段迁移、缺的补上、类型不对的丢掉 */
export function normalizeConfig(raw: Record<string, unknown>): BridgeConfig {
  // 已去掉的设置读入时丢掉，下次保存就不再写：exec（旧版的命令执行总开关）、disabledTools（全局停用工具）
  const { workspaceRoot: _old, workspaces: _w, activeWorkspaceId: _a, exec: _exec, disabledTools: _disabled, ...rest } = raw
  const ws = normalizeWorkspaces(raw)
  return {
    ...DEFAULT_CONFIG,
    ...(rest as Partial<BridgeConfig>),
    workspaces: ws.workspaces,
    ...(ws.activeWorkspaceId ? { activeWorkspaceId: ws.activeWorkspaceId } : {}),
    agents: Array.isArray(raw.agents) ? raw.agents.map((a: LegacyAgent) => normalizeAgent(a, ws.legacyMachineIds)) : [],
    // 旧版配置没有 roles 字段：补上预设职位
    roles: Array.isArray(raw.roles) ? raw.roles.map(normalizeRole) : structuredClone(PRESET_ROLES),
    lanEnabled: raw.lanEnabled === true,
    tunnel: normalizeTunnel(raw.tunnel),
    // 只有显式写 oauth 才走 OAuth；缺省和其他值都是带 token 的链接直连
    authMode: raw.authMode === 'oauth' ? 'oauth' : 'link'
  }
}

/** 旧配置里的 AI 身份：还带着已经去掉的档位、命令执行开关、调用限额、工作区勾选 */
type LegacyAgent = Agent & { tier?: unknown; execAllowed?: unknown; limits?: unknown; workspaceIds?: unknown }

/**
 * 权限精简后一个身份只剩「整台电脑」一个开关，其余旧字段丢掉。
 * 迁移：旧配置里在「能访问的工作区」勾过整台电脑（含旧版手动添加的「整台机器」）的，开关保持打开；没勾过的是关
 */
function normalizeAgent(a: LegacyAgent, legacyMachineIds: Set<string>): Agent {
  const { tier: _tier, execAllowed: _exec, limits: _limits, workspaceIds: _ids, machineAccess: _m, ...agent } = a
  const ticked = (normalizeWorkspaceIds(a.workspaceIds) ?? []).some((id) => id === MACHINE_WORKSPACE_ID || legacyMachineIds.has(id))
  return a.machineAccess === true || ticked ? { ...agent, machineAccess: true } : agent
}

/** 第一次读到权限精简前的配置时，原样留的那份副本的文件名（在数据目录里） */
export const LEGACY_CONFIG_COPY = 'config.before-simplify.json'

/** 配置里有没有权限精简时去掉的字段 */
function hasLegacyPermissionFields(raw: Record<string, unknown>): boolean {
  const has = (o: unknown, keys: string[]): boolean => !!o && typeof o === 'object' && keys.some((k) => k in (o as object))
  if (has(raw, ['disabledTools', 'exec'])) return true
  if (Array.isArray(raw.agents) && raw.agents.some((a) => has(a, ['tier', 'execAllowed', 'limits', 'workspaceIds']))) return true
  return Array.isArray(raw.roles) && raw.roles.some((r) => has(r, ['fileAccess', 'writablePaths', 'allowedTools', 'canManage']))
}

/** 职位只留名字和职责说明；旧配置里的文件权限、可写目录、能否派活、工具白名单丢掉 */
function normalizeRole(r: Role): Role {
  return { id: String(r.id), name: String(r.name ?? ''), description: String(r.description ?? ''), ...(r.builtin === true ? { builtin: true } : {}) }
}

/** 备份恢复时加工作区用：和加工作区时一样由路径算 id、名字去重 */
export function newWorkspaceEntry(root: string, name: string | undefined, taken: WorkspaceInfo[]): WorkspaceInfo {
  const abs = path.resolve(root)
  return { id: uniqueId(workspaceKey(abs), taken), name: uniqueName(name?.trim() ? name : path.basename(abs), taken), root: abs }
}

/** 改名去重（备份恢复用） */
export function uniqueWorkspaceName(base: string, taken: WorkspaceInfo[]): string {
  return uniqueName(base, taken)
}

/** 「整台电脑」工作区：root 是相对路径的起点（用户主目录） */
export function machineWorkspaceInfo(root: string = os.homedir()): WorkspaceInfo {
  return { id: MACHINE_WORKSPACE_ID, name: MACHINE_WORKSPACE_NAME, root: path.resolve(root), kind: 'machine' }
}

/**
 * 配置存在数据目录的 config.json；token 明文保存，所以数据目录本身被路径守卫保护。
 * 「整台电脑」是内置工作区，不存进 workspaces：按 id、名字查找时都认它
 */
export class ConfigStore {
  readonly file: string
  private data: BridgeConfig
  private readonly machine: WorkspaceInfo

  constructor(
    readonly dataDir: string,
    private readonly onChange?: () => void,
    /** 整台电脑相对路径的起点，默认用户主目录（测试用临时目录） */
    machineRoot?: string
  ) {
    fs.mkdirSync(dataDir, { recursive: true })
    this.file = path.join(dataDir, 'config.json')
    this.machine = machineWorkspaceInfo(machineRoot)
    this.data = this.load()
  }

  private load(): BridgeConfig {
    try {
      const text = fs.readFileSync(this.file, 'utf8')
      const raw = JSON.parse(text)
      this.keepLegacyCopy(raw, text)
      return normalizeConfig(raw)
    } catch {
      return { ...structuredClone(DEFAULT_CONFIG), roles: structuredClone(PRESET_ROLES) }
    }
  }

  /**
   * 权限精简前的配置（档位、命令执行开关、限额、工作区勾选、停用工具、职位权限）读进来就丢了，下次保存不再写回。
   * 所以第一次读到旧格式时原样留一份在数据目录里，想退回旧版本时能找回当时每个 AI 的设置。只留一次，不覆盖
   */
  private keepLegacyCopy(raw: Record<string, unknown>, text: string): void {
    if (!hasLegacyPermissionFields(raw)) return
    const copy = path.join(this.dataDir, LEGACY_CONFIG_COPY)
    try {
      if (!fs.existsSync(copy)) fs.writeFileSync(copy, text, 'utf8')
    } catch {
      // 留不下副本不影响启动
    }
  }

  /**
   * 整体换成导入的配置（备份恢复用）：和读 config.json 走同一套规范化，再保存。
   * 调用方（backup.ts）先把文件内容逐字段校验、合并成完整配置
   */
  importConfig(next: BridgeConfig): BridgeConfig {
    const norm = normalizeConfig(JSON.parse(JSON.stringify(next)))
    // 不在导入范围内的设置保持本机的（端口、局域网、认证方式）
    return this.update({ ...norm, host: this.data.host, port: this.data.port, lanEnabled: this.data.lanEnabled, authMode: this.data.authMode })
  }

  /** 改隧道设置；token 传空字符串表示清除，不传表示不改 */
  updateTunnel(patch: { mode?: TunnelConfig['mode']; hostname?: string; token?: string; autoStart?: boolean; keepOnExit?: boolean }): TunnelConfig {
    const cur = this.data.tunnel
    const next: TunnelConfig = { ...cur }
    if (patch.mode !== undefined) next.mode = patch.mode === 'named' ? 'named' : 'quick'
    if (patch.hostname !== undefined) {
      const h = patch.hostname.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()
      if (h && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) throw new Error('域名格式不对，例如 mcp.example.com')
      if (h) next.hostname = h
      else delete next.hostname
    }
    if (patch.token !== undefined) {
      const t = patch.token.trim()
      if (t) next.token = t
      else delete next.token
    }
    if (patch.autoStart !== undefined) next.autoStart = patch.autoStart === true
    if (patch.keepOnExit !== undefined) {
      if (patch.keepOnExit === true) next.keepOnExit = true
      else delete next.keepOnExit
    }
    this.update({ tunnel: next })
    return next
  }

  get(): BridgeConfig {
    return this.data
  }

  update(patch: Partial<BridgeConfig>): BridgeConfig {
    this.data = { ...this.data, ...patch }
    if (!this.data.activeWorkspaceId) delete this.data.activeWorkspaceId
    // 先写临时文件再改名，避免写一半断电损坏配置
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
    this.onChange?.()
    return this.data
  }

  // ===== 工作区 =====

  /** 内置的「整台电脑」工作区 */
  machineWorkspace(): WorkspaceInfo {
    return this.machine
  }

  /** 全部工作区：添加的目录工作区，最后是内置的整台电脑 */
  allWorkspaces(): WorkspaceInfo[] {
    return [...this.data.workspaces, this.machine]
  }

  /** 按 id 或名字找（名字大小写不敏感，id 优先；包括整台电脑） */
  findWorkspace(key: string | undefined): WorkspaceInfo | undefined {
    if (!key) return undefined
    const k = key.trim()
    const list = this.allWorkspaces()
    return list.find((w) => w.id === k) ?? list.find((w) => w.name.toLowerCase() === k.toLowerCase())
  }

  /** 按 id 找（包括整台电脑） */
  getWorkspace(id: string | undefined): WorkspaceInfo | undefined {
    if (!id) return undefined
    return id === this.machine.id ? this.machine : this.data.workspaces.find((w) => w.id === id)
  }

  /** 只在添加的目录工作区里按 id 找 */
  private listedWorkspace(id: string): WorkspaceInfo | undefined {
    return this.data.workspaces.find((w) => w.id === id)
  }

  /** 当前工作区：activeWorkspaceId 指的那个，失效时取第一个目录工作区 */
  activeWorkspace(): WorkspaceInfo | undefined {
    return this.getWorkspace(this.data.activeWorkspaceId) ?? this.data.workspaces[0]
  }

  /**
   * 加入工作区（不检查目录，调用方检查）；同一路径已在列表里时返回已有的那个（成员名单不动）。
   * members 不给 = 所有 AI 都能用；给了（可以是空数组）只有名单里的能用
   */
  addWorkspace(root: string, members?: string[]): { workspace: WorkspaceInfo; added: boolean } {
    const abs = path.resolve(root)
    const existing = this.data.workspaces.find((w) => workspaceKey(w.root) === workspaceKey(abs))
    if (existing) return { workspace: existing, added: false }
    const list = this.data.workspaces
    const m = normalizeMembers(members)
    const ws: WorkspaceInfo = { id: uniqueId(workspaceKey(abs), [...list, this.machine]), name: uniqueName(path.basename(abs), list), root: abs, ...(m ? { members: m } : {}) }
    this.update({ workspaces: [...list, ws] })
    return { workspace: ws, added: true }
  }

  /** 改工作区的成员名单：undefined = 所有 AI 都能用。整台电脑不能改（它按每个 AI 的开关） */
  setWorkspaceMembers(id: string, members: string[] | undefined): WorkspaceInfo {
    const ws = this.listedWorkspace(id)
    if (!ws) throw new Error('工作区不存在')
    const m = normalizeMembers(members)
    const { members: _old, ...rest } = ws
    const next: WorkspaceInfo = m ? { ...rest, members: m } : rest
    this.update({ workspaces: this.data.workspaces.map((w) => (w.id === id ? next : w)) })
    return next
  }

  /** 只移出列表。加回同一路径时 id 相同，它的数据（任务、记忆、检查点）照旧 */
  removeWorkspace(id: string): void {
    if (!this.listedWorkspace(id)) throw new Error('工作区不存在')
    const workspaces = this.data.workspaces.filter((w) => w.id !== id)
    const active = this.data.activeWorkspaceId === id ? workspaces[0]?.id : this.data.activeWorkspaceId
    this.update({ workspaces, activeWorkspaceId: active })
  }

  renameWorkspace(id: string, name: string): WorkspaceInfo {
    const ws = this.listedWorkspace(id)
    if (!ws) throw new Error('工作区不存在')
    const n = cleanName(name)
    if (!n) throw new Error('名字不能为空')
    // AI 用名字或 id 指定工作区，名字不能长得像别人的 id
    if (WORKSPACE_ID_RE.test(n.toLowerCase()) && n !== ws.id) throw new Error('名字不能用 w_ 加 8 位十六进制的格式')
    if (this.data.workspaces.some((w) => w.id !== id && w.name.toLowerCase() === n.toLowerCase())) throw new Error(`已有叫「${n}」的工作区`)
    const next = { ...ws, name: n }
    this.update({ workspaces: this.data.workspaces.map((w) => (w.id === id ? next : w)) })
    return next
  }

  setActiveWorkspace(id: string): void {
    if (!this.getWorkspace(id)) throw new Error('工作区不存在')
    this.update({ activeWorkspaceId: id })
  }

  // ===== AI 身份 =====

  getAgent(id: string): Agent | undefined {
    return this.data.agents.find((a) => a.id === id)
  }

  /** 新身份一接入就有完全权限；machineAccess 不给 = 不能用整台电脑 */
  addAgent(name: string, roleId?: string, machineAccess?: boolean): Agent {
    if (roleId && !this.getRole(roleId)) throw new Error('职位不存在')
    const used = new Set(this.data.agents.map((a) => a.color))
    const color = AGENT_COLORS.find((c) => !used.has(c)) ?? AGENT_COLORS[this.data.agents.length % AGENT_COLORS.length]
    const agent: Agent = {
      id: crypto.randomUUID(),
      name: name.trim().slice(0, 40) || 'AI',
      color,
      token: newToken(),
      createdAt: Date.now(),
      ...(roleId ? { roleId } : {}),
      ...(machineAccess === true ? { machineAccess: true } : {})
    }
    this.update({ agents: [...this.data.agents, agent] })
    return agent
  }

  /** roleId 传空字符串表示取消职位 */
  updateAgent(id: string, patch: Partial<Pick<Agent, 'name' | 'color' | 'roleId' | 'machineAccess'>>): Agent {
    const agent = this.getAgent(id)
    if (!agent) throw new Error('AI 不存在')
    if (patch.roleId && !this.getRole(patch.roleId)) throw new Error('职位不存在')
    const next: Agent = { ...agent }
    if (patch.name !== undefined) next.name = patch.name.trim().slice(0, 40) || agent.name
    if (typeof patch.color === 'string' && patch.color) next.color = patch.color
    if (patch.roleId !== undefined) {
      if (patch.roleId) next.roleId = patch.roleId
      else delete next.roleId
    }
    if (patch.machineAccess !== undefined) {
      if (patch.machineAccess === true) next.machineAccess = true
      else delete next.machineAccess
    }
    this.update({ agents: this.data.agents.map((a) => (a.id === id ? next : a)) })
    return next
  }

  rotateToken(id: string): Agent {
    const agent = this.getAgent(id)
    if (!agent) throw new Error('AI 不存在')
    const next = { ...agent, token: newToken() }
    this.update({ agents: this.data.agents.map((a) => (a.id === id ? next : a)) })
    return next
  }

  removeAgent(id: string): void {
    // 顺手从各工作区的成员名单里去掉它（名单还在，只是少了这个人）
    const workspaces = this.data.workspaces.map((w) => (w.members?.includes(id) ? { ...w, members: w.members.filter((m) => m !== id) } : w))
    this.update({ agents: this.data.agents.filter((a) => a.id !== id), workspaces })
  }

  getRole(id: string | undefined): Role | undefined {
    return id ? this.data.roles.find((r) => r.id === id) : undefined
  }

  /** 新建（无 id）或更新职位 */
  saveRole(input: Partial<Role> & { name: string }): Role {
    const name = input.name.trim()
    if (!name) throw new Error('职位名称不能为空')
    const existing = input.id ? this.getRole(input.id) : undefined
    if (input.id && !existing) throw new Error('职位不存在')
    const role: Role = {
      id: existing?.id ?? 'r_' + crypto.randomBytes(4).toString('hex'),
      name: name.slice(0, 30),
      description: (input.description ?? existing?.description ?? '').slice(0, 4000),
      ...(existing?.builtin ? { builtin: true } : {})
    }
    const roles = existing ? this.data.roles.map((r) => (r.id === role.id ? role : r)) : [...this.data.roles, role]
    this.update({ roles })
    return role
  }

  /** 网页 AI 认证方式 */
  authMode(): AuthMode {
    return this.data.authMode === 'oauth' ? 'oauth' : 'link'
  }

  setAuthMode(mode: AuthMode): void {
    this.update({ authMode: mode === 'oauth' ? 'oauth' : 'link' })
  }

  /** 删除职位，原来担任这个职位的 AI 变成无职位 */
  removeRole(id: string): void {
    this.update({
      roles: this.data.roles.filter((r) => r.id !== id),
      agents: this.data.agents.map((a) => {
        if (a.roleId !== id) return a
        const { roleId: _r, ...rest } = a
        return rest
      })
    })
  }
}
