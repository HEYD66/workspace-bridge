import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/*
 * cloudflared 隧道：把本机 MCP 服务（http://127.0.0.1:<port>）开到公网，给网页版 AI 连接。
 * - quick：免账号的 https://<随机>.trycloudflare.com，每次启动地址都变；
 * - named：用户自己的域名。公网主机名到本机端口的映射在 Cloudflare 面板里配，这里只负责跑 cloudflared。
 * token 只经环境变量 TUNNEL_TOKEN 传给 cloudflared（命令行参数在进程列表里谁都能看到），日志里出现一律替换成 [token]。
 * 就绪只认 cloudflared 打印的 "Registered tunnel connection"：在这之前 quick 地址可能已经分配，但还连不通。
 * 「关闭应用时保留」：进程脱离本应用启动、输出写日志文件，应用退出时不结束它，记录写在 tunnel-kept.json；
 * 下次启动核对进程、模式、端口、域名都对得上就接管，地址不变。
 */

export type TunnelMode = 'off' | 'quick' | 'named'

export interface TunnelStatus {
  mode: TunnelMode
  state: 'off' | 'starting' | 'running' | 'error'
  /** 公网地址，如 https://xxx.trycloudflare.com 或 https://<named hostname>；running 时一定有 */
  url?: string
  /** 公网 hostname（url 的 host 部分），给 httpServer 的 Host 白名单用 */
  hostname?: string
  error?: string
  /** 找到的 cloudflared 路径；找不到为 undefined */
  binary?: string
  /** 最近 80 行 cloudflared 输出，token 已替换成 [token] */
  log: string[]
  startedAt?: number
  /** 以保留方式运行：应用退出时可以不结束它，下次启动接管 */
  kept?: boolean
}

export type TunnelStartConfig = ({ mode: 'quick'; port: number } | { mode: 'named'; port: number; hostname: string; token: string }) & {
  /** 给了就以保留方式启动：进程脱离本应用，输出写到这个目录下的日志文件，记录也存这里 */
  keepDir?: string
  /**
   * 只在保留方式、Windows 上有用：启动时不让 cloudflared 继承本应用的句柄（做法见 launchIsolated）。
   * 不这样的话，应用开着的监听端口（Electron 的调试端口等）会被留下来的 cloudflared 一直占着，下次启动的应用开不了同一个端口。
   * 这条路走不通时退回普通的启动方式
   */
  isolate?: boolean
}

/** 接管时要求对得上的设置 */
export interface AdoptWant {
  mode: 'quick' | 'named'
  port: number
  /** named 模式的域名 */
  hostname?: string
  /** named 模式的 token：日志里出现要替换掉 */
  token?: string
}

export interface TunnelOptions {
  /** cloudflared 可执行文件；不给就用 findCloudflared() */
  bin?: string
  /** 测试用：插在 bin 和 cloudflared 参数之间（例如 bin=process.execPath, prefixArgs=[假脚本路径]） */
  prefixArgs?: string[]
  /** 等待隧道就绪的超时，默认 45 秒 */
  readyTimeoutMs?: number
  onChange?: (s: TunnelStatus) => void
}

const DEFAULT_READY_TIMEOUT_MS = 45_000
/** kill 之后最多等这么久；还没退出就强杀并不再等它 */
const KILL_TIMEOUT_MS = 5_000
/** exit 之后等 stdout/stderr 收尾的时间：最后几行常常就是退出原因 */
const CLOSE_GRACE_MS = 500
const MAX_LOG_LINES = 80
const MAX_LINE_CHARS = 2000
/** 一行超过这么长还没换行就整段丢弃：防止撑爆内存，也避免把 token 切成两半漏掉替换 */
const MAX_PENDING_CHARS = 1024 * 1024
/** 只有日志变化时合并通知：cloudflared 启动时几十行输出不必触发几十次界面刷新 */
const LOG_NOTIFY_MS = 300
const MAX_DETAIL_CHARS = 300
const TOKEN_MASK = '[token]'
const KEPT_RECORD = 'tunnel-kept.json'
const KEPT_LOG = 'cloudflared.log'
/** 保留方式运行时读日志文件、检查接管来的进程还在不在的间隔 */
const KEPT_POLL_MS = 300
/** 接管时从日志末尾补读这么多，界面上能看到最近的输出 */
const KEPT_BACKLOG_BYTES = 16 * 1024
const QUICK_TMP_PREFIX = 'wb-cloudflared-'

/*
 * Quick Tunnel 专用配置文件。~/.cloudflared/config.yml 存在时 cloudflared 2026.9.1 照样建 Quick Tunnel，
 * 但会套用里面的 ingress（实测请求全按 config.yml 转发，返回 404）；用 --config 指向这个文件就不再读默认配置（已实测）。
 * 不用空文件：cloudflared 会报 "Configuration file ... was empty"。
 */
const QUICK_CONFIG_NAME = 'config.yml'
const QUICK_CONFIG = 'no-autoupdate: true\n'
/**
 * 固定走 HTTP/2（TCP 443），不走默认可能选上的 QUIC（UDP 7844）。
 * 本机开 TUN 模式代理或网络限 UDP 时，QUIC 连接会断断续续，表现为进程还在、公网却 530 / 502
 */
const PROTOCOL_ARGS = ['--protocol', 'http2']

const REGISTERED_RE = /Registered tunnel connection/
/** 要求地址后面不跟路径或更多域名段（句末的点可以）：cloudflared 申请失败时的报错里有 https://api.trycloudflare.com/tunnel */
const QUICK_URL_RE = /https:\/\/([a-z0-9][a-z0-9-]*)\.trycloudflare\.com(?!\.?[\w/-])/i
/** cloudflared 日志行：2026-11-01T08:18:03Z INF 正文 */
const LOG_LINE_RE = /^(?:\d{4}-\d\d-\d\dT\S+\s+)?(?:(DBG|INF|WRN|ERR|FTL)\s+)?(.*)$/
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** 已知报错对应的处理建议，按顺序取第一个命中的 */
const HINTS: [RegExp, string][] = [
  [/token is not valid|invalid token/i, 'tunnel token 无效，请检查是否完整复制、是否属于这个隧道'],
  [/failed to request quick tunnel|api\.trycloudflare\.com/i, '申请临时地址失败：可能连不上 trycloudflare.com，或短时间内申请太多次被限流，稍后再试'],
  [/failed to dial to edge|port 7844/i, '连不上 Cloudflare 网络：请检查网络，或防火墙、代理是否拦截了出站 7844 端口（UDP 和 TCP）']
]

type State = Omit<TunnelStatus, 'binary'>

/** 保留下来的隧道进程 */
interface KeptRecord {
  pid: number
  mode: 'quick' | 'named'
  port: number
  url: string
  /** 启动它的程序：核对 pid 没被系统分给别的进程 */
  binary: string
  startedAt: number
  tmpDir?: string
}

interface Run {
  /** 本应用启动的进程；接管来的没有 */
  child?: ChildProcess
  pid?: number
  mode: 'quick' | 'named'
  port: number
  hostname?: string
  token?: string
  /** 保留方式运行：输出在日志文件里，按间隔读 */
  kept?: { dir: string; logFile: string; pos: number; decoder: StringDecoder; binary: string; skipPartial: boolean; timer?: NodeJS.Timeout }
  /** quick 模式的临时配置目录，进程结束后删掉 */
  tmpDir?: string
  startedAt: number
  url?: string
  registered: boolean
  /** 到过 running：之后退出算「断开」而不是「启动失败」 */
  wasRunning: boolean
  /** stop() 或新的 start() 要求结束：退出后回到 off，不算错误 */
  stopping: boolean
  /** 超时等内部原因主动杀进程：退出后用它作为错误 */
  failReason?: string
  exited: boolean
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  spawnError?: Error
  finalized: boolean
  pending: { out: string; err: string }
  readyTimer?: NodeJS.Timeout
  closeTimer?: NodeJS.Timeout
  killTimer?: NodeJS.Timeout
  /** 结束 start() 的 promise，只生效一次 */
  settle: (s: TunnelStatus) => void
  /** 进程结束、状态已更新后 resolve */
  done: Promise<void>
  markDone: () => void
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function readdir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function removeDir(dir: string | undefined): void {
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
}

function windowsCandidates(): string[] {
  const env = process.env
  const pf = env.ProgramFiles ?? 'C:\\Program Files'
  const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const local = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  const list = [
    path.join(pf, 'cloudflared', 'cloudflared.exe'),
    path.join(pf86, 'cloudflared', 'cloudflared.exe'),
    path.join(local, 'cloudflared', 'cloudflared.exe'),
    path.join(local, 'Programs', 'cloudflared', 'cloudflared.exe'),
    path.join(local, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
    path.join(pf, 'WinGet', 'Links', 'cloudflared.exe')
  ]
  // winget 便携版装在 Packages\Cloudflare.cloudflared_<来源>\ 下，文件名可能带平台后缀
  for (const root of [path.join(local, 'Microsoft', 'WinGet', 'Packages'), path.join(pf, 'WinGet', 'Packages')]) {
    for (const pkg of readdir(root)) {
      if (!/^Cloudflare\.cloudflared_/i.test(pkg)) continue
      for (const f of readdir(path.join(root, pkg))) if (/^cloudflared.*\.exe$/i.test(f)) list.push(path.join(root, pkg, f))
    }
  }
  return list
}

/** 依次查：PATH（where / which）、Windows 常见安装位置（Program Files、Program Files (x86)、%LOCALAPPDATA%、winget 包目录） */
export function findCloudflared(): string | undefined {
  const win = process.platform === 'win32'
  // where 用绝对路径、$PATH: 前缀：不在当前目录里找，防止被同名文件劫持
  const r = win
    ? spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe'), ['$PATH:cloudflared'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3000
      })
    : spawnSync('which', ['cloudflared'], { encoding: 'utf8', timeout: 3000 })
  if (r.status === 0 && r.stdout) {
    for (const line of r.stdout.split(/\r?\n/)) {
      const p = line.trim()
      // Windows 上只要 .exe：npm 装的 cloudflared.cmd 之类的包装脚本不能不经 shell 直接 spawn
      if (p && (!win || /\.exe$/i.test(p)) && isFile(p)) return p
    }
  }
  const fallback = win ? windowsCandidates() : ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared']
  return fallback.find(isFile)
}

/** cloudflared 默认会读的配置文件（只在建不了临时配置时用来提示） */
function findDefaultConfig(): string | undefined {
  const home = os.homedir()
  const dirs = [path.join(home, '.cloudflared'), path.join(home, '.cloudflare-warp'), path.join(home, 'cloudflare-warp')]
  if (process.platform !== 'win32') dirs.push('/etc/cloudflared', '/usr/local/etc/cloudflared')
  for (const d of dirs) {
    for (const f of ['config.yml', 'config.yaml']) if (isFile(path.join(d, f))) return path.join(d, f)
  }
  return undefined
}

function makeQuickConfigDir(): string | undefined {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), QUICK_TMP_PREFIX))
    fs.writeFileSync(path.join(dir, QUICK_CONFIG_NAME), QUICK_CONFIG, { mode: 0o600 })
    return dir
  } catch {
    return undefined
  }
}

/** 合法域名（只含字母数字、连字符和点，至少两段）返回小写形式；带协议、端口、路径、IP 都不行 */
function normalizeHostname(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const h = v.trim().toLowerCase()
  if (!h || h.length > 253) return undefined
  const labels = h.split('.')
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return undefined
  // 末段纯数字是 IP
  if (/^\d+$/.test(labels[labels.length - 1])) return undefined
  return h
}

function installHint(): string {
  const how =
    process.platform === 'win32'
      ? '在终端运行 winget install --id Cloudflare.cloudflared'
      : process.platform === 'darwin'
        ? '在终端运行 brew install cloudflared'
        : '按 Cloudflare 官方文档安装 cloudflared'
  return `没有找到 cloudflared。请先安装：${how}，装好后再开启隧道`
}

/** 子进程环境：不继承外面的 TUNNEL_TOKEN（Windows 环境变量名不分大小写） */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (k.toUpperCase() !== 'TUNNEL_TOKEN') env[k] = v
  return env
}

/**
 * 清空并打开日志文件。上一个以 launchIsolated 启动的 cloudflared 刚被结束时，中间那层 cmd 还要一小会儿才退出，
 * 这期间文件被它占着（EBUSY）：等一等再试，最多 3 秒
 */
async function openLogFile(file: string): Promise<number> {
  for (let i = 0; ; i++) {
    try {
      return fs.openSync(file, 'w', 0o600)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (i >= 30 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw err
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}

const LAUNCH_FILE = 'cloudflared-launch.cmd'
const LAUNCH_TIMEOUT_MS = 20_000

/**
 * Windows 上启动一个不继承本进程句柄的 cloudflared，输出追加到 logFile，返回它的 pid；走不通返回 undefined。
 *
 * Node 的 spawn 在 Windows 上总是让子进程继承本进程里所有「可继承」的句柄，Electron（Chromium）自己开的监听端口也在里面。
 * 保留下来的 cloudflared 比应用活得久，那些端口就一直被它占着：应用重启后同一个调试端口开不出来（实测）。
 * 所以绕一道：先启动 PowerShell，由它的 Start-Process（走 ShellExecute，不继承句柄）启动 cmd 跑一个启动脚本，
 * 脚本把输出重定向到日志文件再启动 cloudflared。PowerShell 自己继承到的句柄随它退出就没了。
 * token 不写进脚本：它在环境变量里，一路传下去。
 */
async function launchIsolated(binary: string, args: string[], logFile: string, dir: string, env: NodeJS.ProcessEnv): Promise<number | undefined> {
  if (process.platform !== 'win32') return undefined
  // 批处理里引号、换行没法可靠地转义，有就不走这条路
  if ([binary, logFile, ...args].some((s) => /["\r\n]/.test(s))) return undefined
  const q = (s: string): string => `"${s.replace(/%/g, '%%')}"`
  const launchFile = path.join(dir, LAUNCH_FILE)
  try {
    // chcp 65001：脚本按 UTF-8 读，路径里有中文也不会坏
    fs.writeFileSync(launchFile, ['@echo off', 'chcp 65001 >nul', `${[binary, ...args].map(q).join(' ')} >> ${q(logFile)} 2>&1`, ''].join('\r\n'), { mode: 0o600 })
  } catch {
    return undefined
  }
  // 脚本里不出现双引号（用 [char]34 拼），整段再用 -EncodedCommand 传，避开命令行转义
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$q = [char]34',
    "$p = Start-Process -FilePath $env:ComSpec -ArgumentList ('/d /c ' + $q + $q + $env:WB_CF_LAUNCH + $q + $q) -WindowStyle Hidden -PassThru",
    // 先把 cmd 的 pid 报出去：万一这段脚本卡住被外面超时结束，外面还能凭它把 cmd 和它底下的进程收掉
    "[Console]::Out.WriteLine('WBCMD=' + $p.Id); [Console]::Out.Flush()",
    '$n = $env:WB_CF_NAME',
    // 在 cmd 底下按程序名找 cloudflared，找到就报它的 pid；10 秒还没有就算失败。
    // 不能「除了 conhost 的第一个」：脚本里的 chcp 也会短暂地当一会儿 cmd 的子进程，撞上就报错了 pid
    '$sw = [Diagnostics.Stopwatch]::StartNew()',
    'while ($sw.ElapsedMilliseconds -lt 10000) {',
    "  $c = Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $p.Id) | Where-Object { $_.Name -ieq $n -or $_.Name -ieq ($n + '.exe') } | Select-Object -First 1",
    "  if ($c) { Write-Output ('WBPID=' + $c.ProcessId); exit 0 }",
    '  if ($p.HasExited) { break }',
    '  Start-Sleep -Milliseconds 150',
    '}',
    // 没找到：把 cmd 连同它底下的进程结束掉，别留下半截的（调用方会退回普通方式再启动一个）
    'if (-not $p.HasExited) { & taskkill.exe /PID $p.Id /T /F 2>$null | Out-Null }',
    "Write-Output 'WBPID=0'"
  ].join('\n')
  const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise<number | undefined>((resolve) => {
    let out = ''
    let done = false
    const finish = (pid: number | undefined): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(pid)
    }
    let helper: ChildProcess
    try {
      // 这一步不能加 detached：从 Electron 里那样启动的 PowerShell 什么都不输出（实测），拿不到 pid。
      // 不加也没关系：应用退出时被连带结束的只有 PowerShell 自己（它早就退了），它启动的 cmd / cloudflared 不在那个作业对象里（实测留得住）
      helper = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        env: { ...env, WB_CF_LAUNCH: launchFile, WB_CF_NAME: path.basename(binary) },
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
      })
    } catch {
      return resolve(undefined)
    }
    const timer = setTimeout(() => {
      try {
        helper.kill()
      } catch {
        // 忽略
      }
      // 结束的只是 PowerShell；它启动的 cmd 和 cloudflared 不在它的进程树里，得另外收掉，
      // 不然留下的 cmd 一直占着日志文件，之后每次启动都失败
      killLaunchCmd(Number(/WBCMD=(\d+)/.exec(out)?.[1] ?? 0))
      finish(undefined)
    }, LAUNCH_TIMEOUT_MS)
    helper.stdout?.setEncoding('utf8')
    helper.stdout?.on('data', (s: string) => (out += s))
    helper.on('error', () => finish(undefined))
    helper.on('close', () => {
      const pid = Number(/WBPID=(\d+)/.exec(out)?.[1] ?? 0)
      finish(pid > 0 ? pid : undefined)
    })
  })
}

/** 把启动脚本那层 cmd 连同它底下的进程结束掉。先核对这个 pid 现在确实是 cmd，不是的话什么都不动 */
function killLaunchCmd(pid: number): void {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return
  try {
    if (!sameProgram(pid, process.env.ComSpec ?? 'cmd.exe')) return
    spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' })
  } catch {
    // 收不掉也不影响这次的结果
  }
}

function parseQuickUrl(line: string): string | undefined {
  const m = QUICK_URL_RE.exec(line)
  const sub = m?.[1].toLowerCase()
  return sub && sub !== 'api' ? `https://${sub}.trycloudflare.com` : undefined
}

function clip(s: string): string {
  return s.length > MAX_DETAIL_CHARS ? `${s.slice(0, MAX_DETAIL_CHARS)}…` : s
}

/** 最后一条有用的输出：优先 ERR/FTL，跳过表格边框和 "See '... --help'" */
function lastUsefulLine(log: string[]): string | undefined {
  let fallback: string | undefined
  for (let i = log.length - 1; i >= 0; i--) {
    const [, level, rest = ''] = LOG_LINE_RE.exec(log[i]) ?? []
    const text = rest.trim()
    if (!text || /^[+|]/.test(text) || /^See '.*--help'/.test(text)) continue
    if (level === 'ERR' || level === 'FTL') return clip(text)
    fallback ??= text
  }
  return fallback && clip(fallback)
}

function describe(head: string, log: string[]): string {
  const joined = log.join('\n')
  const hint = HINTS.find(([re]) => re.test(joined))?.[1]
  const last = lastUsefulLine(log)
  return [head, hint, last && `最后输出：${last}`].filter(Boolean).join('。')
}

/** Windows 上 -1 会以 4294967295 报出来 */
function signedCode(code: number): number {
  return code > 0x7fffffff ? code - 0x100000000 : code
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function killPid(pid: number | undefined, signal?: NodeJS.Signals): void {
  if (!pid) return
  try {
    process.kill(pid, signal)
  } catch {
    // 已经没了
  }
}

/** pid 对应的进程是不是当初启动的那个程序：pid 可能已经被系统分给别的进程，不能误杀 */
function sameProgram(pid: number, binary: string): boolean {
  const want = path.basename(binary).toLowerCase()
  if (process.platform === 'win32') {
    const r = spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    })
    // "cloudflared.exe","1234","Console","1","20,000 K"
    const m = /^"([^"]+)","(\d+)"/m.exec(r.stdout ?? '')
    return !!m && Number(m[2]) === pid && m[1].toLowerCase() === want
  }
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 5000 })
  const comm = (r.stdout ?? '').trim()
  return !!comm && path.basename(comm).toLowerCase() === want
}

function writeKeptRecord(dir: string, rec: KeptRecord): void {
  try {
    fs.writeFileSync(path.join(dir, KEPT_RECORD), JSON.stringify(rec), { mode: 0o600 })
  } catch {
    // 记录写不进去只是下次不能接管
  }
}

function removeKeptRecord(dir: string): void {
  try {
    fs.rmSync(path.join(dir, KEPT_RECORD), { force: true })
  } catch {
    // 忽略
  }
}

/** 读记录；格式不对返回 undefined。tmpDir 只认本模块在系统临时目录建的那种，免得手改的记录让我们删别的目录 */
function readKeptRecord(dir: string): KeptRecord | undefined {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, KEPT_RECORD), 'utf8')) as Partial<KeptRecord> | null
    if (!r || typeof r !== 'object') return undefined
    const { pid, mode, port, url, binary, startedAt, tmpDir } = r
    if (!Number.isInteger(pid) || (pid as number) <= 0) return undefined
    if (mode !== 'quick' && mode !== 'named') return undefined
    if (!Number.isInteger(port) || typeof url !== 'string' || !/^https:\/\//.test(url) || typeof binary !== 'string' || !binary) return undefined
    if (typeof startedAt !== 'number') return undefined
    new URL(url)
    const safeTmp =
      typeof tmpDir === 'string' && path.dirname(path.resolve(tmpDir)) === path.resolve(os.tmpdir()) && path.basename(tmpDir).startsWith(QUICK_TMP_PREFIX)
    return { pid: pid as number, mode, port: port as number, url, binary, startedAt, ...(safeTmp ? { tmpDir } : {}) }
  } catch {
    return undefined
  }
}

export class TunnelManager {
  private st: State = { mode: 'off', state: 'off', log: [] }
  private run: Run | null = null
  /** 每次 start/stop 加一：等旧进程退出期间又来了新调用，旧调用就放弃 */
  private gen = 0
  /** 正在走「不继承句柄」的启动（launchIsolated）时有值，有结果后 resolve；这期间 this.run 还是空的 */
  private launching: Promise<void> | undefined
  /** null 表示还没找过 */
  private binary: string | undefined | null = null
  private logTimer: NodeJS.Timeout | null = null

  constructor(private readonly opts: TunnelOptions = {}) {}

  /** 正在跑的 cloudflared 的 pid（kill_process 要保护它，结束了公网入口就断了） */
  pid(): number | undefined {
    return this.run?.pid
  }

  status(): TunnelStatus {
    if (this.binary === null) this.binary = this.lookupBinary()
    return { ...this.st, binary: this.binary, log: [...this.st.log] }
  }

  /** 已在运行时先停掉旧进程再启动。等到 running 或 error（含超时）才 resolve，不 reject */
  async start(cfg: TunnelStartConfig): Promise<TunnelStatus> {
    const gen = ++this.gen
    await this.endRun()
    // 上一次 start 还在走「不继承句柄」的启动（那期间还没有登记进程）：等它有了结果再往下，免得两个进程写同一个日志
    await this.launching
    if (gen !== this.gen) return { mode: 'off', state: 'off', binary: this.binary ?? undefined, log: [] }
    // 每次都重新找：用户可能刚装好 cloudflared
    this.binary = this.lookupBinary()
    const fail = (error: string) => {
      this.setState({ mode: cfg.mode, state: 'error', error }, [])
      return this.status()
    }

    if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) return fail(`本机端口不合法：${cfg.port}`)
    let hostname: string | undefined
    let token: string | undefined
    if (cfg.mode === 'named') {
      hostname = normalizeHostname(cfg.hostname)
      if (!hostname) return fail('域名不合法：只填主机名，如 mcp.example.com，不要带 https://、端口或路径')
      token = typeof cfg.token === 'string' ? cfg.token.trim() : ''
      if (!token) return fail('还没有填写 tunnel token')
      if (/\s/.test(token)) return fail('tunnel token 里不能有空白；如果复制的是整条命令，只粘贴 --token 后面那一段')
    }
    if (!this.binary) return fail(installHint())

    const env = childEnv()
    let args: string[]
    let tmpDir: string | undefined
    if (cfg.mode === 'quick') {
      tmpDir = makeQuickConfigDir()
      if (!tmpDir) {
        const userConfig = findDefaultConfig()
        if (userConfig) {
          return fail(`检测到 ${userConfig}：有这个文件时 cloudflared 的 Quick Tunnel 会按里面的配置转发，而临时配置又创建失败。请把它改名或移走后重试，或改用 named 模式`)
        }
      }
      const configArgs = tmpDir ? ['--config', path.join(tmpDir, QUICK_CONFIG_NAME)] : []
      args = ['tunnel', '--no-autoupdate', ...PROTOCOL_ARGS, ...configArgs, '--url', `http://127.0.0.1:${cfg.port}`]
    } else {
      env.TUNNEL_TOKEN = token
      args = ['tunnel', '--no-autoupdate', ...PROTOCOL_ARGS, 'run']
    }

    const startedAt = Date.now()
    // 保留方式：输出直接写日志文件（应用退出后没人读管道），进程脱离本应用
    let kept: { dir: string; logFile: string } | undefined
    let logFd: number | undefined
    if (cfg.keepDir) {
      const logFile = path.join(cfg.keepDir, KEPT_LOG)
      try {
        fs.mkdirSync(cfg.keepDir, { recursive: true })
        logFd = await openLogFile(logFile)
      } catch (err) {
        removeDir(tmpDir)
        return gen === this.gen ? fail(`无法创建隧道日志文件 ${logFile}：${(err as Error).message}`) : { mode: 'off', state: 'off', binary: this.binary, log: [] }
      }
      // 等文件的这会儿又有了新的 start() / stop()：这一次不启动了
      if (gen !== this.gen) {
        fs.closeSync(logFd)
        removeDir(tmpDir)
        return { mode: 'off', state: 'off', binary: this.binary, log: [] }
      }
      kept = { dir: cfg.keepDir, logFile }
      // 旧记录作废：新进程连上之前，下次启动不能去接管别的进程
      removeKeptRecord(cfg.keepDir)
    }
    const binary = this.binary
    const fullArgs = [...(this.opts.prefixArgs ?? []), ...args]
    let child: ChildProcess | undefined
    /** 走「不继承句柄」启动时拿到的 pid；这样启动的进程和接管来的一样没有 child，靠轮询知道它还在不在 */
    let isolatedPid: number | undefined
    if (kept && logFd !== undefined && cfg.isolate && process.platform === 'win32') {
      // 日志文件上面已经清空了，这条路由启动脚本自己往里追加
      fs.closeSync(logFd)
      logFd = undefined
      this.setState({ mode: cfg.mode, state: 'starting', startedAt }, [])
      let finished!: () => void
      this.launching = new Promise<void>((r) => (finished = r))
      try {
        isolatedPid = await launchIsolated(binary, fullArgs, kept.logFile, kept.dir, env)
      } finally {
        this.launching = undefined
        finished()
      }
      // 等的这会儿又有了新的 start() / stop()：这个进程不要了
      if (gen !== this.gen) {
        // 先核对这个 pid 还是我们启动的那个程序，免得它已经退了、pid 被系统分给了别的进程
        if (isolatedPid && sameProgram(isolatedPid, binary)) killPid(isolatedPid)
        removeDir(tmpDir)
        return { mode: 'off', state: 'off', binary, log: [] }
      }
      if (isolatedPid === undefined) {
        // 走不通：退回普通的启动方式
        try {
          logFd = await openLogFile(kept.logFile)
        } catch (err) {
          removeDir(tmpDir)
          return gen === this.gen ? fail(`无法创建隧道日志文件 ${kept.logFile}：${(err as Error).message}`) : { mode: 'off', state: 'off', binary, log: [] }
        }
        if (gen !== this.gen) {
          fs.closeSync(logFd)
          removeDir(tmpDir)
          return { mode: 'off', state: 'off', binary, log: [] }
        }
      }
    }
    if (isolatedPid === undefined) {
      // detached：Windows 上不进 libuv 给子进程建的作业对象，应用退出时不会被连带结束
      const spawnOpts: SpawnOptions =
        logFd !== undefined
          ? { env, stdio: ['ignore', logFd, logFd], detached: true, windowsHide: true }
          : { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
      try {
        child = spawn(binary, fullArgs, spawnOpts)
      } catch (err) {
        removeDir(tmpDir)
        return fail(`无法启动 cloudflared：${(err as Error).message}`)
      } finally {
        if (logFd !== undefined) fs.closeSync(logFd)
      }
    }

    return new Promise<TunnelStatus>((resolve) => {
      let settled = false
      let markDone!: () => void
      const run: Run = {
        ...(child ? { child } : {}),
        pid: child ? child.pid : isolatedPid,
        mode: cfg.mode,
        port: cfg.port,
        hostname,
        token,
        tmpDir,
        startedAt,
        ...(kept ? { kept: { ...kept, pos: 0, decoder: new StringDecoder('utf8'), binary, skipPartial: false } } : {}),
        registered: false,
        wasRunning: false,
        stopping: false,
        exited: false,
        finalized: false,
        pending: { out: '', err: '' },
        settle: (s) => {
          if (settled) return
          settled = true
          resolve(s)
        },
        done: new Promise<void>((r) => (markDone = r)),
        markDone: () => markDone()
      }
      this.run = run

      if (child) {
        const c = child
        if (c.stdout && c.stderr) {
          c.stdout.setEncoding('utf8')
          c.stderr.setEncoding('utf8')
          c.stdout.on('data', (s: string) => this.onOutput(run, 'out', s))
          c.stderr.on('data', (s: string) => this.onOutput(run, 'err', s))
        }
        c.on('error', (err) => {
          // kill 失败也会触发 error；只有根本没启动起来（没有 pid）才算结束
          if (c.pid !== undefined) return
          run.spawnError = err
          run.exited = true
          this.finalize(run)
        })
        c.on('exit', (code, signal) => {
          run.exited = true
          run.exitCode = code
          run.signal = signal
          // 正常紧接着会收到 close；万一输出管道被别的进程占着不关，也不能一直等
          run.closeTimer = setTimeout(() => this.finalize(run), CLOSE_GRACE_MS)
        })
        c.on('close', () => this.finalize(run))
      }
      if (run.kept) this.watchKept(run)

      const timeoutMs = this.opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
      run.readyTimer = setTimeout(() => {
        run.failReason = this.timeoutMessage(run, timeoutMs)
        this.kill(run)
      }, timeoutMs)
      // 登记好进程再通知：onChange 里同步调用 stop()/start() 也能找到并结束它
      this.setState({ mode: cfg.mode, state: 'starting', startedAt }, [])
    })
  }

  /** 结束 cloudflared 进程，等它退出；状态回到 off */
  async stop(): Promise<void> {
    ++this.gen
    await this.endRun()
    if (this.st.state !== 'off') this.setState({ mode: 'off', state: 'off' })
  }

  /**
   * 应用退出时用：以保留方式运行中的隧道不结束，只是不再跟踪，记录留给下次启动接管。
   * 不是保留方式启动的、还没连上的返回 false，调用方照常 stop()
   */
  detach(): boolean {
    const run = this.run
    if (!run || !run.kept || run.exited || run.stopping || this.st.state !== 'running') return false
    ++this.gen
    run.finalized = true
    clearTimeout(run.readyTimer)
    clearTimeout(run.closeTimer)
    clearTimeout(run.killTimer)
    clearInterval(run.kept.timer)
    if (run.child) {
      run.child.removeAllListeners()
      run.child.on('error', () => {})
      run.child.unref()
    }
    this.run = null
    this.st = { mode: 'off', state: 'off', log: [] }
    run.settle(this.status())
    run.markDone()
    return true
  }

  /**
   * 接管上次应用退出时保留下来的隧道。没有记录、已有隧道在跑返回 false；
   * 记录对不上（进程没了、不是当初那个程序、模式 / 端口 / 域名变了）就结束旧进程、清掉记录，返回 false
   */
  adopt(keepDir: string, want: AdoptWant): boolean {
    if (this.run) return false
    const rec = readKeptRecord(keepDir)
    if (!rec) {
      removeKeptRecord(keepDir)
      return false
    }
    const alive = pidAlive(rec.pid) && sameProgram(rec.pid, rec.binary)
    const host = new URL(rec.url).hostname
    const matches =
      alive && rec.mode === want.mode && rec.port === want.port && (rec.mode === 'quick' || host === normalizeHostname(want.hostname))
    if (!matches) {
      if (alive) killPid(rec.pid)
      removeKeptRecord(keepDir)
      try {
        removeDir(rec.tmpDir)
      } catch {
        // 忽略
      }
      return false
    }

    ++this.gen
    this.binary = this.lookupBinary()
    const logFile = path.join(keepDir, KEPT_LOG)
    let pos = 0
    try {
      pos = Math.max(0, fs.statSync(logFile).size - KEPT_BACKLOG_BYTES)
    } catch {
      // 日志没了不影响接管
    }
    let markDone!: () => void
    const done = new Promise<void>((r) => (markDone = r))
    const token = rec.mode === 'named' && want.token ? want.token : undefined
    const run: Run = {
      pid: rec.pid,
      mode: rec.mode,
      port: rec.port,
      ...(rec.mode === 'named' ? { hostname: host } : {}),
      ...(token ? { token } : {}),
      tmpDir: rec.tmpDir,
      startedAt: rec.startedAt,
      url: rec.url,
      kept: { dir: keepDir, logFile, pos, decoder: new StringDecoder('utf8'), binary: rec.binary, skipPartial: pos > 0 },
      registered: true,
      wasRunning: true,
      stopping: false,
      exited: false,
      finalized: false,
      pending: { out: '', err: '' },
      settle: () => {},
      done,
      markDone: () => markDone()
    }
    this.run = run
    this.setState({ mode: rec.mode, state: 'running', url: rec.url, hostname: host, startedAt: rec.startedAt, kept: true }, [])
    this.readKept(run)
    this.watchKept(run)
    return true
  }

  private lookupBinary(): string | undefined {
    const bin = this.opts.bin ?? findCloudflared()
    return bin && isFile(bin) ? bin : undefined
  }

  private setState(next: Omit<State, 'log'>, log: string[] = this.st.log): void {
    this.st = { ...next, log }
    if (this.logTimer) {
      clearTimeout(this.logTimer)
      this.logTimer = null
    }
    this.emit()
  }

  /** 回调抛错不能打断状态机（否则 start() 会 reject、进程事件里会变成未捕获异常） */
  private emit(): void {
    try {
      this.opts.onChange?.(this.status())
    } catch {
      // 忽略：回调自己的问题
    }
  }

  private notifyLog(): void {
    if (this.logTimer || !this.opts.onChange) return
    this.logTimer = setTimeout(() => {
      this.logTimer = null
      this.emit()
    }, LOG_NOTIFY_MS)
    this.logTimer.unref()
  }

  /** 让当前进程（starting 或 running）结束，等到它退出、状态变成 off */
  private async endRun(): Promise<void> {
    const run = this.run
    if (!run) return
    run.stopping = true
    this.kill(run)
    await run.done
  }

  private kill(run: Run): void {
    if (run.exited || run.killTimer) return
    // 没有 child 的（接管来的、不继承句柄启动的）只有一个 pid：结束前先核对它还是当初那个程序
    const stillOurs = (): boolean => !!run.pid && (!run.kept || sameProgram(run.pid, run.kept.binary))
    if (run.child) run.child.kill()
    else if (stillOurs()) killPid(run.pid)
    run.killTimer = setTimeout(() => {
      if (run.child) run.child.kill('SIGKILL')
      else if (stillOurs()) killPid(run.pid, 'SIGKILL')
      this.finalize(run)
    }, KILL_TIMEOUT_MS)
  }

  /** 保留方式：按间隔读日志文件；接管来的进程没有 exit 事件，顺便查它还在不在 */
  private watchKept(run: Run): void {
    const k = run.kept
    if (!k) return
    k.timer = setInterval(() => {
      this.readKept(run)
      if (!run.child && !run.exited && !run.finalized && !pidAlive(run.pid)) {
        run.exited = true
        this.finalize(run)
      }
    }, KEPT_POLL_MS)
    k.timer.unref()
  }

  private readKept(run: Run): void {
    const k = run.kept
    if (!k || run.finalized) return
    let fd: number | undefined
    try {
      fd = fs.openSync(k.logFile, 'r')
      const size = fs.fstatSync(fd).size
      // 文件被截断（重新开了一次）就从头读
      if (size < k.pos) k.pos = 0
      while (k.pos < size) {
        const buf = Buffer.alloc(Math.min(64 * 1024, size - k.pos))
        const n = fs.readSync(fd, buf, 0, buf.length, k.pos)
        if (n <= 0) break
        k.pos += n
        let text = k.decoder.write(buf.subarray(0, n))
        // 接管时从中间开始读：第一行多半不完整，丢掉
        if (k.skipPartial) {
          const i = text.indexOf('\n')
          if (i < 0) continue
          text = text.slice(i + 1)
          k.skipPartial = false
        }
        if (text) this.onOutput(run, 'out', text)
      }
    } catch {
      // 日志文件读不到不影响隧道
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd)
        } catch {
          // 忽略
        }
      }
    }
  }

  private onOutput(run: Run, key: 'out' | 'err', chunk: string): void {
    if (run.finalized) return
    const lines = (run.pending[key] + chunk).split('\n')
    let rest = lines.pop() ?? ''
    if (rest.length > MAX_PENDING_CHARS) {
      rest = ''
      lines.push('[一行输出过长，已省略]')
    }
    run.pending[key] = rest
    for (const line of lines) this.onLine(run, line)
  }

  private onLine(run: Run, raw: string): void {
    if (this.run !== run) return
    let line = raw.replace(/\s+$/, '')
    if (run.token) line = line.split(run.token).join(TOKEN_MASK)
    if (!line.trim()) return
    if (run.mode === 'quick' && !run.url) run.url = parseQuickUrl(line)
    if (REGISTERED_RE.test(line)) run.registered = true
    const log = this.st.log
    log.push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line)
    if (log.length > MAX_LOG_LINES) log.splice(0, log.length - MAX_LOG_LINES)
    if (!this.checkReady(run)) this.notifyLog()
  }

  private checkReady(run: Run): boolean {
    if (this.st.state !== 'starting' || run.stopping || run.exited || run.failReason || !run.registered) return false
    const url = run.mode === 'quick' ? run.url : `https://${run.hostname}`
    if (!url) return false
    clearTimeout(run.readyTimer)
    run.wasRunning = true
    this.setState({ mode: run.mode, state: 'running', url, hostname: new URL(url).hostname, startedAt: run.startedAt, ...(run.kept ? { kept: true } : {}) })
    if (run.kept && run.pid !== undefined) {
      writeKeptRecord(run.kept.dir, {
        pid: run.pid,
        mode: run.mode,
        port: run.port,
        url,
        binary: run.kept.binary,
        startedAt: run.startedAt,
        ...(run.tmpDir ? { tmpDir: run.tmpDir } : {})
      })
    }
    run.settle(this.status())
    return true
  }

  private finalize(run: Run): void {
    if (run.finalized) return
    // 保留方式：退出前写进文件的最后几行也读进来
    this.readKept(run)
    // 最后一段没换行的输出也算进日志（常常就是退出原因）
    for (const key of ['out', 'err'] as const) {
      const rest = run.pending[key]
      run.pending[key] = ''
      if (rest) this.onLine(run, rest)
    }
    run.finalized = true
    clearTimeout(run.readyTimer)
    clearTimeout(run.closeTimer)
    clearTimeout(run.killTimer)
    if (run.kept) {
      clearInterval(run.kept.timer)
      removeKeptRecord(run.kept.dir)
    }
    try {
      removeDir(run.tmpDir)
    } catch {
      // 临时目录删不掉不影响隧道状态
    }
    if (this.run === run) {
      this.run = null
      if (run.stopping) this.setState({ mode: 'off', state: 'off' })
      else this.setState({ mode: run.mode, state: 'error', error: run.failReason ?? this.exitMessage(run) })
    }
    run.settle(this.status())
    run.markDone()
  }

  private exitMessage(run: Run): string {
    if (run.spawnError) {
      return (run.spawnError as NodeJS.ErrnoException).code === 'ENOENT' ? installHint() : `无法启动 cloudflared：${run.spawnError.message}`
    }
    const how = typeof run.exitCode === 'number' ? `退出码 ${signedCode(run.exitCode)}` : `被信号 ${run.signal ?? '未知'} 结束`
    const head = run.wasRunning ? `隧道已断开：cloudflared 意外退出（${how}）` : `cloudflared 启动失败（${how}）`
    return describe(head, this.st.log)
  }

  private timeoutMessage(run: Run, ms: number): string {
    const s = Number((ms / 1000).toFixed(1))
    const head =
      run.mode === 'named'
        ? `等了 ${s} 秒，隧道还没连上 Cloudflare`
        : run.url
          ? `已拿到地址 ${run.url}，但等了 ${s} 秒隧道还没连上 Cloudflare`
          : `等了 ${s} 秒，还没拿到 trycloudflare 临时地址`
    return describe(head, this.st.log)
  }
}
