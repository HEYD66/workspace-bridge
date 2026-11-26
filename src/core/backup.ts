// 设置备份与恢复：config.json（工作区、AI 身份和 token、职位、隧道）+ 内置 AI 的提供方（不含 API Key）+ 用户级技能清单，
// 打成一个 JSON 文件。导入时不信任文件内容：逐字段校验，坏的丢掉并记下来；合并后再走 ConfigStore 的规范化。
// API Key 一律不导出（safeStorage 的密文换台电脑解不开，明文更不能出去），导入后要用户重新填。
import fs from 'node:fs'
import path from 'node:path'
import { MACHINE_WORKSPACE_ID, newToken, newWorkspaceEntry, uniqueWorkspaceName, workspaceKey } from './config'
import type { Agent, BridgeConfig, Role, TunnelConfig, WorkspaceInfo } from './types'

export const BACKUP_FORMAT = 'workspace-bridge-backup'
export const BACKUP_VERSION = 1
/** 不含 token 的导出里，token 换成这个；导入时这些身份重新生成 token */
export const TOKEN_PLACEHOLDER = '<token-removed>'
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024
/** dataDir/backups 里最多留几份导入前的 config.json */
export const MAX_CONFIG_BACKUPS = 10

const TOKEN_RE = /^wb_[A-Za-z0-9_-]{20,100}$/
const ID_RE = /^[\w-]{1,100}$/
const COLOR_RE = /^#[0-9a-fA-F]{6}$/

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 内置 AI 的备份接口（main 里由 LlmService 提供；没有时不导出、不导入这部分） */
export interface LlmBackupHost {
  exportForBackup(): { providers: unknown[]; agents: Record<string, unknown> }
  importFromBackup(input: { providers?: unknown; agents?: unknown }): { added: string[]; updated: string[]; needKey: string[]; bindings: number; dropped: number }
}

export interface BackupFile {
  /** 文件开头的提醒：含 token 时要像密码一样保管 */
  warning: string
  format: typeof BACKUP_FORMAT
  version: number
  exportedAt: string
  appVersion: string
  includesTokens: boolean
  config: {
    workspaces: { id: string; name: string; root: string }[]
    agents: Agent[]
    roles: Role[]
    tunnel: TunnelConfig
  }
  /** 内置 AI：提供方（不含 API Key）和模型绑定 */
  llm?: { providers: unknown[]; agents: Record<string, unknown> }
  /** 用户级技能清单（只是清单，技能文件本身不在备份里） */
  userSkills: { name: string; description: string; status: string }[]
}

/** 导出：includeTokens=false 时 AI 的 token 和隧道 token 都换成占位符 */
export function buildBackup(opts: {
  config: BridgeConfig
  llm?: LlmBackupHost
  userSkills: { name: string; description: string; status: string }[]
  includeTokens: boolean
  appVersion: string
  now?: number
}): BackupFile {
  const c = opts.config
  const tok = (t: string | undefined): string | undefined => (t === undefined ? undefined : opts.includeTokens ? t : TOKEN_PLACEHOLDER)
  const tunnel: TunnelConfig = { ...c.tunnel }
  if (tunnel.token) tunnel.token = tok(tunnel.token)
  return {
    warning: opts.includeTokens
      ? '这个文件含有 AI 的 token 和隧道 token，拿到它就能以这些 AI 的身份访问你的电脑。请像密码一样保管，不要发给别人或上传到网盘、聊天里。API Key 不在里面。'
      : '这个文件不含 token：导入后这些 AI 会重新生成 token，要把新的连接地址重新填到各个 AI 客户端里。API Key 不在里面。',
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date(opts.now ?? Date.now()).toISOString(),
    appVersion: opts.appVersion,
    includesTokens: opts.includeTokens,
    config: {
      workspaces: c.workspaces.map((w) => ({ id: w.id, name: w.name, root: w.root })),
      agents: c.agents.map((a) => ({ ...a, token: tok(a.token)! })),
      roles: structuredClone(c.roles),
      tunnel
    },
    ...(opts.llm ? { llm: opts.llm.exportForBackup() } : {}),
    userSkills: opts.userSkills.map((s) => ({ name: s.name, description: s.description, status: s.status }))
  }
}

/** 文件里校验过的内容；token 为 null 表示占位符（要重新生成） */
export interface SanitizedBackup {
  exportedAt: string
  appVersion: string
  includesTokens: boolean
  workspaces: { id: string; name: string; root: string }[]
  agents: (Omit<Agent, 'token'> & { token: string | null })[]
  roles: Role[]
  tunnel?: TunnelConfig & { keepLocalToken?: boolean }
  llm?: { providers?: unknown; agents?: unknown }
  userSkills: { name: string; description: string; status: string }[]
  /** 被丢掉的条目和原因 */
  dropped: string[]
}

/** 读文件并逐字段校验；格式不对直接抛错，单个坏条目丢掉并记进 dropped */
export function parseBackup(text: string): SanitizedBackup {
  if (Buffer.byteLength(text) > MAX_BACKUP_BYTES) throw new Error('备份文件太大（超过 10 MB），不像是本应用导出的')
  let raw: Obj
  try {
    raw = obj(JSON.parse(text.replace(/^\uFEFF/, '')))
  } catch {
    throw new Error('备份文件不是有效的 JSON')
  }
  if (raw.format !== BACKUP_FORMAT) throw new Error('不是 Workspace Bridge 的备份文件')
  if (typeof raw.version !== 'number' || raw.version > BACKUP_VERSION) throw new Error('备份文件的版本比这个应用新，请先升级应用')
  const cfg = obj(raw.config)
  const dropped: string[] = []

  const workspaces: SanitizedBackup['workspaces'] = []
  for (const item of arr(cfg.workspaces)) {
    const w = obj(item)
    const root = str(w.root).trim()
    if (!root || (!path.isAbsolute(root) && !path.win32.isAbsolute(root)) || root.length > 1000 || /[\0\r\n]/.test(root)) {
      dropped.push(`工作区「${str(w.name) || root || '?'}」：路径不是绝对路径`)
      continue
    }
    if (path.parse(path.resolve(root)).root === path.resolve(root)) {
      dropped.push(`工作区「${root}」：不能把整个磁盘根目录作为工作区`)
      continue
    }
    if (workspaces.some((x) => workspaceKey(x.root) === workspaceKey(root))) continue
    workspaces.push({ id: ID_RE.test(str(w.id)) ? str(w.id) : '', name: str(w.name).replace(/[\r\n\t]/g, ' ').trim().slice(0, 40), root })
  }

  const roles: Role[] = []
  for (const item of arr(cfg.roles)) {
    const r = obj(item)
    const id = str(r.id)
    const name = str(r.name).trim().slice(0, 30)
    if (!ID_RE.test(id) || !name || roles.some((x) => x.id === id)) {
      dropped.push(`职位「${name || id || '?'}」：id 或名字不合法`)
      continue
    }
    // 旧备份里职位的文件权限、可写目录、工具白名单不再使用，直接忽略
    roles.push({ id, name, description: str(r.description).slice(0, 4000) })
  }

  const agents: SanitizedBackup['agents'] = []
  for (const item of arr(cfg.agents)) {
    const a = obj(item)
    const id = str(a.id)
    const name = str(a.name).trim().slice(0, 40)
    if (!ID_RE.test(id) || !name || agents.some((x) => x.id === id)) {
      dropped.push(`AI「${name || id || '?'}」：id 或名字不合法`)
      continue
    }
    const tokenRaw = str(a.token)
    const token = TOKEN_RE.test(tokenRaw) ? tokenRaw : null
    if (!token && tokenRaw !== TOKEN_PLACEHOLDER) dropped.push(`AI「${name}」的 token 格式不对，导入时重新生成`)
    // 旧备份（档位、命令执行开关、工作区勾选）：档位和开关忽略；勾过「整台电脑」的算开了整台电脑
    const machineAccess = a.machineAccess === true || arr(a.workspaceIds).includes(MACHINE_WORKSPACE_ID)
    agents.push({
      id,
      name,
      color: COLOR_RE.test(str(a.color)) ? str(a.color) : '#60a5fa',
      token,
      createdAt: typeof a.createdAt === 'number' && Number.isFinite(a.createdAt) ? a.createdAt : Date.now(),
      ...(ID_RE.test(str(a.roleId)) ? { roleId: str(a.roleId) } : {}),
      ...(machineAccess ? { machineAccess: true } : {})
    })
  }

  let tunnel: SanitizedBackup['tunnel']
  if (cfg.tunnel && typeof cfg.tunnel === 'object') {
    const t = obj(cfg.tunnel)
    const tok = str(t.token).trim()
    const hostname = str(t.hostname).trim().toLowerCase()
    tunnel = {
      mode: t.mode === 'named' ? 'named' : 'quick',
      ...(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname) ? { hostname } : {}),
      ...(tok && tok !== TOKEN_PLACEHOLDER && tok.length <= 4000 && !/\s/.test(tok) ? { token: tok } : {}),
      ...(tok === TOKEN_PLACEHOLDER ? { keepLocalToken: true } : {}),
      autoStart: t.autoStart === true,
      ...(t.keepOnExit === true ? { keepOnExit: true } : {})
    }
  }

  const userSkills = arr(raw.userSkills)
    .map((s) => obj(s))
    .filter((s) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(str(s.name)))
    .map((s) => ({ name: str(s.name), description: str(s.description).slice(0, 500), status: str(s.status).slice(0, 20) }))
    .slice(0, 500)

  const llm = raw.llm && typeof raw.llm === 'object' ? { providers: obj(raw.llm).providers, agents: obj(raw.llm).agents } : undefined
  return {
    exportedAt: str(raw.exportedAt).slice(0, 40),
    appVersion: str(raw.appVersion).slice(0, 40),
    includesTokens: raw.includesTokens === true,
    workspaces,
    agents,
    roles,
    ...(tunnel ? { tunnel } : {}),
    ...(llm ? { llm } : {}),
    userSkills,
    dropped
  }
}

export type ImportAction = 'add' | 'update' | 'same'

/** 导入预览：会新增 / 覆盖哪些工作区、AI、职位（不含 token） */
export interface ImportPreview {
  exportedAt: string
  appVersion: string
  includesTokens: boolean
  workspaces: { name: string; root: string; action: ImportAction; exists: boolean }[]
  agents: { id: string; name: string; action: 'add' | 'update'; machineAccess: boolean; tokenRegenerated: boolean }[]
  roles: { id: string; name: string; action: 'add' | 'update' }[]
  /** 会覆盖本机的隧道设置 */
  tunnel: boolean
  llm: { providers: { name: string; action: 'add' | 'update' }[]; bindings: number } | null
  /** 备份里有、这台电脑上没有的用户级技能（技能文件不在备份里，要自己拷过来） */
  missingSkills: string[]
  dropped: string[]
  warnings: string[]
}

export interface ImportPlan {
  preview: ImportPreview
  next: BridgeConfig
  /** 重新生成了 token 的 AI（新加的且备份里没有 token，或 token 和本机别的 AI 撞了） */
  regenerated: string[]
  /** token 变了的已有 AI（它的旧连接、OAuth 授权要作废） */
  tokenChanged: string[]
}

/**
 * 把备份合并进当前配置（不删本机已有、备份里没有的东西）：
 * - 工作区按路径匹配：已有的用备份里的名字，新的按路径算 id；目录不存在的照样加，预览里标出来
 * - 职位、AI 按 id 匹配，已有的覆盖、新的追加（包括「整台电脑」开关）
 * - 备份里没有 token 的已有 AI 保留本机 token；新 AI 重新生成
 * - 隧道设置：备份里有就覆盖；隧道 token 是占位符时保留本机的
 */
export function planImport(
  current: BridgeConfig,
  b: SanitizedBackup,
  opts: { isDir: (p: string) => boolean; localSkills: string[]; llmProviderIds?: string[] }
): ImportPlan {
  const warnings: string[] = []
  const workspaces: WorkspaceInfo[] = current.workspaces.map((w) => ({ ...w }))
  const wsPreview: ImportPreview['workspaces'] = []
  for (const w of b.workspaces) {
    const local = workspaces.find((x) => workspaceKey(x.root) === workspaceKey(w.root))
    let target: WorkspaceInfo
    let action: ImportAction
    if (local) {
      action = 'same'
      if (w.name && w.name !== local.name) {
        local.name = uniqueWorkspaceName(w.name, workspaces.filter((x) => x !== local))
        action = 'update'
      }
      target = local
    } else {
      target = newWorkspaceEntry(w.root, w.name, workspaces)
      workspaces.push(target)
      action = 'add'
    }
    wsPreview.push({ name: target.name, root: target.root, action, exists: opts.isDir(target.root) })
  }

  const roles: Role[] = current.roles.map((r) => ({ ...r }))
  const rolePreview: ImportPreview['roles'] = []
  for (const r of b.roles) {
    const i = roles.findIndex((x) => x.id === r.id)
    if (i >= 0) {
      // 预设职位的 builtin 标记以本机为准
      roles[i] = { ...r, ...(roles[i].builtin ? { builtin: true } : {}) }
      rolePreview.push({ id: r.id, name: r.name, action: 'update' })
    } else {
      roles.push(r)
      rolePreview.push({ id: r.id, name: r.name, action: 'add' })
    }
  }

  const agents: Agent[] = current.agents.map((a) => ({ ...a }))
  const agentPreview: ImportPreview['agents'] = []
  const regenerated: string[] = []
  const tokenChanged: string[] = []
  for (const a of b.agents) {
    const i = agents.findIndex((x) => x.id === a.id)
    const local = i >= 0 ? agents[i] : undefined
    let token = a.token ?? local?.token ?? null
    let regen = false
    if (!token || agents.some((x) => x.id !== a.id && x.token === token)) {
      if (token) warnings.push(`AI「${a.name}」的 token 和本机另一个 AI 相同，已重新生成`)
      token = newToken()
      regen = true
    }
    let roleId = a.roleId
    if (roleId && !roles.some((r) => r.id === roleId)) {
      warnings.push(`AI「${a.name}」的职位 ${roleId} 不在备份里，已取消职位`)
      roleId = undefined
    }
    const machineAccess = a.machineAccess === true
    if (machineAccess && !local?.machineAccess) warnings.push(`AI「${a.name}」导入后能用「整台电脑」（本机任意盘的文件）`)
    const next: Agent = {
      id: a.id,
      name: a.name,
      color: a.color,
      token,
      createdAt: local?.createdAt ?? a.createdAt,
      ...(roleId ? { roleId } : {}),
      ...(machineAccess ? { machineAccess: true } : {})
    }
    if (local) {
      agents[i] = next
      if (local.token !== token) tokenChanged.push(a.id)
    } else agents.push(next)
    if (regen) regenerated.push(a.id)
    agentPreview.push({ id: a.id, name: a.name, action: local ? 'update' : 'add', machineAccess, tokenRegenerated: regen })
  }

  let tunnel = current.tunnel
  if (b.tunnel) {
    const { keepLocalToken, ...t } = b.tunnel
    tunnel = { ...t, ...(keepLocalToken && current.tunnel.token ? { token: current.tunnel.token } : {}) }
  }

  const llmIds = new Set(opts.llmProviderIds ?? [])
  const llm = b.llm
    ? {
        providers: arr(b.llm.providers)
          .map((p) => obj(p))
          .filter((p) => ID_RE.test(str(p.id)))
          .map((p) => ({ name: str(p.name).slice(0, 40) || str(p.id), action: (llmIds.has(str(p.id)) ? 'update' : 'add') as 'add' | 'update' })),
        bindings: Object.keys(obj(b.llm.agents)).length
      }
    : null
  if (llm?.providers.length) warnings.push('API Key 不在备份里：新加的模型提供方要重新填 Key，已有的保留本机的 Key')

  const local = new Set(opts.localSkills)
  const next: BridgeConfig = {
    ...current,
    workspaces,
    ...(current.activeWorkspaceId || workspaces[0] ? { activeWorkspaceId: current.activeWorkspaceId ?? workspaces[0].id } : {}),
    agents,
    roles,
    tunnel
  }
  return {
    preview: {
      exportedAt: b.exportedAt,
      appVersion: b.appVersion,
      includesTokens: b.includesTokens,
      workspaces: wsPreview,
      agents: agentPreview,
      roles: rolePreview,
      tunnel: !!b.tunnel,
      llm,
      missingSkills: b.userSkills.filter((s) => !local.has(s.name)).map((s) => s.name),
      dropped: b.dropped,
      warnings
    },
    next,
    regenerated,
    tokenChanged
  }
}

/** 导入前把当前 config.json 拷进 dataDir/backups/config-<时间>.json，只留最新的 10 份；返回备份文件路径 */
export function backupConfigFile(dataDir: string, now = Date.now(), keep = MAX_CONFIG_BACKUPS): string | null {
  const src = path.join(dataDir, 'config.json')
  if (!fs.existsSync(src)) return null
  const dir = path.join(dataDir, 'backups')
  fs.mkdirSync(dir, { recursive: true })
  // 文件名按时间排序（拷贝会保留原文件的修改时间，不能按 mtime 排）：config-20261106T045612345Z-00.json
  const stamp = new Date(now).toISOString().replace(/[-:.]/g, '')
  let n = 0
  const name = (i: number): string => path.join(dir, `config-${stamp}-${String(i).padStart(2, '0')}.json`)
  while (fs.existsSync(name(n))) n++
  const file = name(n)
  fs.copyFileSync(src, file)
  const all = fs
    .readdirSync(dir)
    .filter((f) => /^config-\d{8}T\d{9}Z-\d{2,}\.json$/.test(f))
    .sort()
    .reverse()
  for (const old of all.slice(keep)) fs.rmSync(path.join(dir, old), { force: true })
  return file
}
