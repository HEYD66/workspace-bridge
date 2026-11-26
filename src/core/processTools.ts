// 进程和端口工具：列出进程（含 TCP 监听端口）、结束进程。不依赖 Electron。
// 系统命令通过 opts.exec 注入，单测用假的 exec；默认实现用 child_process.execFile。
import { execFile } from 'node:child_process'
import path from 'node:path'

export const DEFAULT_LIST_LIMIT = 50
export const MAX_LIST_LIMIT = 200
export const MAX_COMMAND_LINE = 300
/** Windows 上 PowerShell 查询的超时 */
export const PS_TIMEOUT_MS = 10_000
/** 其他平台 SIGTERM 之后等多久再 SIGKILL */
export const KILL_GRACE_MS = 1500

export class ProcessError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message)
  }
}

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
  /** 命令不存在、超时等没有跑起来或被杀掉的情况 */
  error?: string
}

export type ExecFn = (file: string, args: string[], opts: { timeoutMs: number }) => Promise<ExecResult>

export interface ProcessToolOptions {
  exec?: ExecFn
  platform?: NodeJS.Platform
  /** 当前进程（工作台本身），默认 process.pid；它和所有祖先都受保护 */
  selfPid?: number
  /** 调用方额外保护的 pid（工作台自己的子进程树） */
  protectedPids?: readonly number[]
  /** 其他平台发信号；默认 process.kill */
  signal?: (pid: number, sig: NodeJS.Signals) => void
  /** 进程是否还在；默认 process.kill(pid, 0) */
  isAlive?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
}

/** 内部快照：command_line 不截断 */
export interface ProcInfo {
  pid: number
  ppid: number
  name: string
  command_line: string
  listening_ports: number[]
}

export interface Snapshot {
  procs: ProcInfo[]
  /** 拿不到端口信息（lsof 不存在等）时为 false，此时 listening_ports 都是空的 */
  portsAvailable: boolean
}

export const defaultExec: ExecFn = (file, args, { timeoutMs }) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null
      if (!e) return resolve({ code: 0, stdout, stderr })
      const code = typeof e.code === 'number' ? e.code : null
      // 退出码非 0 只是普通结果；命令不存在或超时才算 error
      const error = code === null ? (e.killed ? `超时（${timeoutMs} ms）` : e.message) : undefined
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '', error })
    })
  })

/**
 * Windows：一次 PowerShell 同时取进程和监听端口，输出 JSON。
 * Get-NetTCPConnection 不可用时 ports 为 null，调用方退回 netstat -ano
 */
export const WINDOWS_PS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$procs = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; cmd = [string]$_.CommandLine } })',
  '$ports = $null',
  'try { $ports = @(Get-NetTCPConnection -State Listen | ForEach-Object { [pscustomobject]@{ pid = [int]$_.OwningProcess; port = [int]$_.LocalPort } }) } catch { $ports = $null }',
  "[pscustomobject]@{ procs = $procs; ports = $ports } | ConvertTo-Json -Compress -Depth 4"
].join('\n')

export function powershellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

const toArray = <T>(v: T | T[] | null | undefined): T[] => {
  if (v == null) return []
  if (Array.isArray(v)) return v
  // Windows PowerShell 5.1 有时把数组序列化成 { value: [...], Count: n }
  const wrapped = (v as { value?: unknown }).value
  return Array.isArray(wrapped) ? (wrapped as T[]) : [v]
}

/** 解析 WINDOWS_PS_SCRIPT 的输出；ports 为 null 表示 Get-NetTCPConnection 不可用 */
export function parseWindowsJson(stdout: string): { procs: Omit<ProcInfo, 'listening_ports'>[]; ports: Array<{ pid: number; port: number }> | null } {
  const start = stdout.indexOf('{')
  if (start < 0) throw new ProcessError('PROCESS_QUERY_FAILED', 'PowerShell 没有输出 JSON')
  const raw = JSON.parse(stdout.slice(start)) as { procs?: unknown; ports?: unknown }
  type P = { pid?: unknown; ppid?: unknown; name?: unknown; cmd?: unknown }
  const procs = toArray(raw.procs as P | P[] | null)
    .filter((p) => Number.isInteger(p?.pid))
    .map((p) => ({ pid: Number(p.pid), ppid: Number.isInteger(p.ppid) ? Number(p.ppid) : 0, name: String(p.name ?? ''), command_line: String(p.cmd ?? '') }))
  const ports =
    raw.ports == null
      ? null
      : toArray(raw.ports as { pid?: unknown; port?: unknown } | Array<{ pid?: unknown; port?: unknown }>)
          .filter((x) => Number.isInteger(x?.pid) && Number.isInteger(x?.port))
          .map((x) => ({ pid: Number(x.pid), port: Number(x.port) }))
  return { procs, ports }
}
/** 本地地址的端口：0.0.0.0:5173、[::]:5173、*:5173、127.0.0.1.5173（BSD 风格不处理） */
function portOf(addr: string): number | undefined {
  const i = addr.lastIndexOf(':')
  if (i < 0) return undefined
  const n = Number(addr.slice(i + 1))
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined
}

/**
 * 解析 netstat -ano 的 TCP 监听行。状态列可能是本地化的文字，
 * 所以 LISTEN 开头或远端地址端口为 0（监听行的特征）都算监听
 */
export function parseNetstat(stdout: string): Array<{ pid: number; port: number }> {
  const out: Array<{ pid: number; port: number }> = []
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5 || !/^TCP/i.test(cols[0])) continue
    const [, local, remote, state, pidText] = cols
    const listening = /^LISTEN/i.test(state) || /:0$/.test(remote)
    const pid = Number(pidText)
    const port = portOf(local)
    if (listening && Number.isInteger(pid) && port !== undefined) out.push({ pid, port })
  }
  return out
}

/** 解析 ps -eo pid,ppid,comm,args（comm 里不含空格时可靠；macOS 的 comm 是完整路径，取文件名） */
export function parsePs(stdout: string): Omit<ProcInfo, 'listening_ports'>[] {
  const out: Omit<ProcInfo, 'listening_ports'>[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line)
    if (!m) continue
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), name: path.posix.basename(m[3]), command_line: m[4].trim() })
  }
  return out
}

/** 解析 lsof -iTCP -sTCP:LISTEN -nP 的默认表格输出（第 2 列 PID，NAME 列形如 *:5173 (LISTEN)） */
export function parseLsof(stdout: string): Array<{ pid: number; port: number }> {
  const out: Array<{ pid: number; port: number }> = []
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 9 || cols[0] === 'COMMAND') continue
    const pid = Number(cols[1])
    const nameCol = cols.find((c, i) => i >= 8 && c.includes(':')) ?? ''
    const port = portOf(nameCol.replace(/->.*$/, ''))
    if (Number.isInteger(pid) && port !== undefined) out.push({ pid, port })
  }
  return out
}

function attachPorts(procs: Omit<ProcInfo, 'listening_ports'>[], ports: Array<{ pid: number; port: number }>): ProcInfo[] {
  const byPid = new Map<number, Set<number>>()
  for (const { pid, port } of ports) {
    let s = byPid.get(pid)
    if (!s) byPid.set(pid, (s = new Set()))
    s.add(port)
  }
  return procs.map((p) => ({ ...p, listening_ports: [...(byPid.get(p.pid) ?? [])].sort((a, b) => a - b) }))
}

/** 取一次全部进程和监听端口 */
export async function takeSnapshot(opts: ProcessToolOptions = {}): Promise<Snapshot> {
  const exec = opts.exec ?? defaultExec
  const platform = opts.platform ?? process.platform
  if (platform === 'win32') {
    const r = await exec('powershell', powershellArgs(WINDOWS_PS_SCRIPT), { timeoutMs: PS_TIMEOUT_MS })
    if (r.error || r.code !== 0) {
      throw new ProcessError('PROCESS_QUERY_FAILED', `查询进程失败：${r.error ?? (r.stderr.trim() || `退出码 ${r.code}`)}`)
    }
    const { procs, ports } = parseWindowsJson(r.stdout)
    if (ports) return { procs: attachPorts(procs, ports), portsAvailable: true }
    const ns = await exec('netstat', ['-ano'], { timeoutMs: PS_TIMEOUT_MS })
    if (ns.error || ns.code !== 0) return { procs: attachPorts(procs, []), portsAvailable: false }
    return { procs: attachPorts(procs, parseNetstat(ns.stdout)), portsAvailable: true }
  }
  const ps = await exec('ps', ['-eo', 'pid,ppid,comm,args'], { timeoutMs: PS_TIMEOUT_MS })
  if (ps.error || ps.code !== 0) {
    throw new ProcessError('PROCESS_QUERY_FAILED', `查询进程失败：${ps.error ?? (ps.stderr.trim() || `退出码 ${ps.code}`)}`)
  }
  const procs = parsePs(ps.stdout)
  const ls = await exec('lsof', ['-iTCP', '-sTCP:LISTEN', '-nP'], { timeoutMs: PS_TIMEOUT_MS })
  // lsof 不存在：不填端口。没有任何监听时 lsof 也返回 1 且没有输出，这时端口信息仍然算可用
  if (ls.error) return { procs: attachPorts(procs, []), portsAvailable: false }
  return { procs: attachPorts(procs, parseLsof(ls.stdout)), portsAvailable: true }
}
const truncate = (s: string, max = MAX_COMMAND_LINE): string => (s.length > max ? `${s.slice(0, max)}…` : s)

function checkPort(port: unknown): number {
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) throw new ProcessError('INVALID_ARGUMENT', 'port 要是 1 到 65535 的整数')
  return port as number
}

export interface ListInput {
  name?: string
  port?: number
  limit?: number
}

export interface ListResult {
  processes: ProcInfo[]
  /** 过滤后一共多少个（可能大于返回的条数） */
  total: number
  truncated: boolean
  /** 拿不到端口信息时为 false，listening_ports 都是空的，port 过滤不会有结果 */
  ports_available: boolean
}

export async function listProcesses(input: ListInput = {}, opts: ProcessToolOptions = {}): Promise<ListResult> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_LIST_LIMIT), 1), MAX_LIST_LIMIT)
  const port = input.port === undefined ? undefined : checkPort(input.port)
  const needle = input.name?.trim().toLowerCase()
  const snap = await takeSnapshot(opts)
  const matched = snap.procs
    .filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.command_line.toLowerCase().includes(needle))
    .filter((p) => port === undefined || p.listening_ports.includes(port))
    .sort((a, b) => a.pid - b.pid)
  return {
    processes: matched.slice(0, limit).map((p) => ({ ...p, command_line: truncate(p.command_line) })),
    total: matched.length,
    truncated: matched.length > limit,
    ports_available: snap.portsAvailable
  }
}

/** 系统关键进程名（不分大小写，比较时去掉 .exe） */
export const PROTECTED_NAMES: ReadonlySet<string> = new Set(
  ['csrss', 'wininit', 'winlogon', 'services', 'lsass', 'smss', 'svchost', 'explorer', 'dwm', 'System', 'Registry', 'MsMpEng', 'init', 'systemd', 'launchd'].map((n) => n.toLowerCase())
)

const baseName = (name: string): string => name.toLowerCase().replace(/\.exe$/, '')

/** 受保护的 pid → 原因。名字规则另外按进程名判断 */
export function protectedPidMap(procs: readonly ProcInfo[], opts: ProcessToolOptions = {}): Map<number, string> {
  const platform = opts.platform ?? process.platform
  const self = opts.selfPid ?? process.pid
  const m = new Map<number, string>([
    [0, '系统进程'],
    [4, '系统进程']
  ])
  if (platform !== 'win32') m.set(1, '系统 init 进程')
  for (const pid of opts.protectedPids ?? []) if (!m.has(pid)) m.set(pid, '工作台自己的进程')
  // 当前进程和它的所有祖先（沿 ppid 往上；pid 复用可能成环，记已走过的）
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const seen = new Set<number>()
  let cur: number | undefined = self
  while (cur !== undefined && cur > 0 && !seen.has(cur)) {
    if (!m.has(cur) || m.get(cur) === '工作台自己的进程') m.set(cur, seen.size === 0 ? '工作台本身' : '工作台的上级进程')
    seen.add(cur)
    cur = byPid.get(cur)?.ppid
  }
  return m
}

/** 这个进程为什么受保护；不受保护返回 undefined */
export function protectionReason(p: Pick<ProcInfo, 'pid' | 'name'>, pidMap: ReadonlyMap<number, string>): string | undefined {
  const byPid = pidMap.get(p.pid)
  if (byPid) return byPid
  if (PROTECTED_NAMES.has(baseName(p.name))) return '系统关键进程'
  return undefined
}

/** pid 的全部后代（不含自己） */
export function descendantsOf(pid: number, procs: readonly ProcInfo[]): number[] {
  const children = new Map<number, number[]>()
  for (const p of procs) {
    if (p.pid === p.ppid) continue
    const list = children.get(p.ppid)
    if (list) list.push(p.pid)
    else children.set(p.ppid, [p.pid])
  }
  const out: number[] = []
  const seen = new Set([pid])
  const queue = [pid]
  while (queue.length) {
    for (const c of children.get(queue.shift() as number) ?? []) {
      if (seen.has(c)) continue
      seen.add(c)
      out.push(c)
      queue.push(c)
    }
  }
  return out
}
export interface KillInput {
  pid?: number
  port?: number
  /** 连子进程一起结束（默认 true） */
  tree?: boolean
}

export interface KillTarget {
  pid: number
  name: string
  listening_ports: number[]
}

export interface KillPlan {
  /** 要结束的进程（给 port 时是监听它的进程） */
  targets: KillTarget[]
  /** tree=true 时会一起结束的后代进程数 */
  descendants: number
  tree: boolean
  port?: number
  not_found?: boolean
}

export interface KillResult {
  killed: Array<{ pid: number; name: string }>
  not_found?: boolean
  /** 发了信号但还在的进程（权限不够等） */
  failed?: Array<{ pid: number; name: string; error: string }>
}

/** 校验参数、找出目标、检查保护名单；不结束任何进程。受保护时抛 PROTECTED_PROCESS */
export async function planKill(input: KillInput, opts: ProcessToolOptions = {}): Promise<KillPlan & { victims: ProcInfo[]; snapshot: Snapshot }> {
  const hasPid = input.pid !== undefined && input.pid !== null
  const hasPort = input.port !== undefined && input.port !== null
  if (hasPid === hasPort) throw new ProcessError('INVALID_ARGUMENT', 'pid 和 port 必须且只能给一个')
  if (hasPid && (!Number.isInteger(input.pid) || (input.pid as number) < 0)) throw new ProcessError('INVALID_ARGUMENT', 'pid 要是非负整数')
  const port = hasPort ? checkPort(input.port) : undefined
  const tree = input.tree !== false
  const snapshot = await takeSnapshot(opts)
  const { procs } = snapshot
  const pidMap = protectedPidMap(procs, opts)

  if (hasPid) {
    const reason = pidMap.get(input.pid as number)
    if (reason) throw new ProcessError('PROTECTED_PROCESS', `pid ${input.pid} 是${reason}，不能结束`)
  } else if (!snapshot.portsAvailable) {
    throw new ProcessError('PORTS_UNAVAILABLE', '这台电脑上拿不到端口信息（没有 Get-NetTCPConnection / netstat / lsof），请改用 pid')
  }
  const targets = hasPid ? procs.filter((p) => p.pid === input.pid) : procs.filter((p) => p.listening_ports.includes(port as number))
  if (targets.length === 0) return { targets: [], descendants: 0, tree, port, not_found: true, victims: [], snapshot }

  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const targetPids = new Set(targets.map((t) => t.pid))
  const victimPids = new Set(targetPids)
  if (tree) for (const t of targets) for (const d of descendantsOf(t.pid, procs)) victimPids.add(d)
  const victims = [...victimPids].map((pid) => byPid.get(pid)).filter((p): p is ProcInfo => !!p)
  for (const v of victims) {
    const reason = protectionReason(v, pidMap)
    if (!reason) continue
    const who = `${v.name || '进程'}（pid ${v.pid}）`
    if (targetPids.has(v.pid)) throw new ProcessError('PROTECTED_PROCESS', `${who}是${reason}，不能结束`)
    throw new ProcessError('PROTECTED_PROCESS', `要结束的进程树里有${reason} ${who}，整棵树不能结束；只结束目标进程本身请传 tree=false`)
  }
  return {
    targets: targets.map((t) => ({ pid: t.pid, name: t.name, listening_ports: t.listening_ports })),
    descendants: victims.length - targets.length,
    tree,
    port,
    victims,
    snapshot
  }
}

/** 给审计看的一句话 */
export function describeKillPlan(plan: KillPlan): string {
  if (plan.not_found || plan.targets.length === 0) return plan.port !== undefined ? `端口 ${plan.port} 上没有监听的进程` : '没有找到这个进程'
  const list = plan.targets
    .map((t) => `${t.name || '进程'}（pid ${t.pid}${t.listening_ports.length ? `，端口 ${t.listening_ports.slice(0, 5).join('/')}` : ''}）`)
    .join('、')
  const extra = plan.descendants > 0 ? `及其 ${plan.descendants} 个子进程` : ''
  return `${list}${extra}`
}

const defaultIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitGone(pids: number[], isAlive: (pid: number) => boolean, sleep: (ms: number) => Promise<void>, ms: number): Promise<void> {
  const step = 100
  for (let waited = 0; waited < ms && pids.some(isAlive); waited += step) await sleep(step)
}
/**
 * 结束进程。pid 和 port 必须且只能给一个；tree 默认 true。
 * Windows 用 taskkill /T /F；其他平台先 SIGTERM，1.5 秒后还在就 SIGKILL
 */
export async function killProcess(input: KillInput, opts: ProcessToolOptions = {}): Promise<KillResult> {
  const plan = await planKill(input, opts)
  if (plan.not_found) return { killed: [], not_found: true }
  const exec = opts.exec ?? defaultExec
  const platform = opts.platform ?? process.platform
  const isAlive = opts.isAlive ?? defaultIsAlive
  const sleep = opts.sleep ?? defaultSleep
  const victimPids = plan.victims.map((v) => v.pid)
  const errors = new Map<number, string>()

  if (platform === 'win32') {
    for (const t of plan.targets) {
      // 前一个目标的 /T 可能已经把它连带结束了
      if (!isAlive(t.pid)) continue
      const args = ['/PID', String(t.pid), ...(plan.tree ? ['/T'] : []), '/F']
      const r = await exec('taskkill', args, { timeoutMs: PS_TIMEOUT_MS })
      if (r.error || r.code !== 0) errors.set(t.pid, (r.error ?? (r.stderr.trim() || r.stdout.trim())) || `taskkill 退出码 ${r.code}`)
    }
    await waitGone(victimPids, isAlive, sleep, KILL_GRACE_MS)
  } else {
    const signal = opts.signal ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig))
    const send = (pid: number, sig: NodeJS.Signals): void => {
      try {
        signal(pid, sig)
      } catch (e) {
        const err = e as NodeJS.ErrnoException
        if (err.code !== 'ESRCH') errors.set(pid, err.message)
      }
    }
    for (const pid of victimPids) send(pid, 'SIGTERM')
    await waitGone(victimPids, isAlive, sleep, KILL_GRACE_MS)
    const left = victimPids.filter(isAlive)
    for (const pid of left) send(pid, 'SIGKILL')
    if (left.length) await waitGone(left, isAlive, sleep, 500)
  }

  const killed: KillResult['killed'] = []
  const failed: NonNullable<KillResult['failed']> = []
  for (const v of plan.victims) {
    if (isAlive(v.pid)) failed.push({ pid: v.pid, name: v.name, error: errors.get(v.pid) ?? '发出结束信号后进程仍在运行' })
    else killed.push({ pid: v.pid, name: v.name })
  }
  return failed.length ? { killed, failed } : { killed }
}
