/**
 * 命令执行（run_command / get_command_output / send_command_input / cancel_command）。
 *
 * 照 ShunCode 的 ide-tool-broker.ts（TerminalCommandManager + ManagedCommandPseudoterminal）移植：
 * - 持久终端池：每个身份（owner）有自己的 bash 终端，按「身份 + cwd」复用空闲终端，
 *   cd、export 在命令之间保留；每个身份最多留 4 个空闲终端，空闲 2 小时回收；
 * - 私有提示符协议：PS1 / PROMPT_COMMAND 打出 OSC 633 标记（序号、退出码、PIPESTATUS、cwd），
 *   退出码只认「这条命令写入之后」渲染的提示符（序号闸门）；
 * - 回显闸门：PTY 会把键入的命令回显出来，闸门把回显吞掉、只留真正的输出；
 *   多行 / 非 ASCII / 超长命令先写进临时脚本，脚本第一句打「开始」标记，标记之前的都丢弃；
 * - 输出按绝对字节偏移记录，只保留最近 2 MB，读到被丢弃的部分时 output_lost=true；
 * - 前台等待超时不杀进程，只返回 running；结束后先等一个冲刷窗口把尾部输出排空再取快照；
 * - command_id 是随机能力串，只对发起它的身份可见；
 * - 取消：先 Ctrl-C，宽限期后仍在跑就强制结束（Windows 用 taskkill /T /F 结束整棵进程树）。
 *
 * 没有审批、没有执行开关、没有限流：接入的 AI 都能直接执行命令（用户 2026-11-12 的决定）。
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IDisposable, IPty } from 'node-pty'
import type { PathFence } from './pathGuard'
import { REGEX_BUDGET_MS, RegexSandbox } from './safeRegex'

type PtyModule = typeof import('node-pty')

// ===== 常量 =====

/** 每条命令保留的输出上限（字节），超出的从头部丢弃 */
export const MAX_CAPTURED_OUTPUT_BYTES = 2 * 1024 * 1024
/** 每个身份最多保留的空闲终端数 */
export const MAX_IDLE_TERMINALS = 4
/** 全部终端（忙 + 闲）的上限，也就是全局同时运行命令数的上限；满了先回收最久没用的空闲终端 */
export const MAX_TERMINAL_SLOTS = 32
/** 每个身份同时运行的命令上限（F3-7） */
export const MAX_RUNNING_PER_OWNER = 8
/** 审计记录里命令原文最多保留的字符数 */
export const MAX_AUDIT_COMMAND_CHARS = 2048
/** 空闲终端多久没用就关掉 */
export const TERMINAL_IDLE_TTL_MS = 2 * 60 * 60 * 1000
/** 每个身份保留多少条已结束命令的记录（供 get_command_output 读） */
export const MAX_FINISHED_COMMANDS_PER_OWNER = 32
/** 前台默认等多久。很多 MCP 客户端自己的超时只有 30～60 秒：等得比它久，客户端会在拿到 command_id 之前就超时，命令成了没人管的 */
export const DEFAULT_TIMEOUT_MS = 30_000
export const MIN_TIMEOUT_MS = 1_000
export const MAX_TIMEOUT_MS = 120_000
export const DEFAULT_OUTPUT_BYTES = 32 * 1024
export const MAX_OUTPUT_BYTES = 128 * 1024
/** 超过这个长度的命令走临时脚本 */
export const MAX_INLINE_COMMAND_CHARS = 1024
/** 提示符标记之后再等这么久收尾，接住晚到的尾部输出 */
const PTY_EXIT_DATA_FLUSH_MS = 80
/** 回显一直没认出来就放行 */
const COMMAND_ECHO_TIMEOUT_MS = 2_000
/** 走脚本桥接（有开始标记）时，闸门最多等开始标记这么久，再放行暂存内容 */
const MARKER_WAIT_MS = 15_000
/** 找回显时最多跳过多少噪声字符 */
const MAX_ECHO_HUNT_BYTES = 8_192
/** 闸门关着时最多暂存多少字符 */
const MAX_GATE_HELD_CHARS = 1024 * 1024
/** 终端启动后等第一个提示符的时间 */
const READY_TIMEOUT_MS = 20_000
/** 后台命令启动后等一下，带回最开始的输出 */
const BACKGROUND_STARTUP_MS = 300
/** 取消时 Ctrl-C 之后的宽限期 */
const CANCEL_GRACE_MS = 1_500
/** 强制结束后等收尾的时间 */
const FORCE_SETTLE_MS = 3_000

const COMMAND_ID_RE = /^cmd_[0-9a-f]{48}$/

export class CommandError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message)
  }
}

// ===== 提示符协议（照 managed-bash-protocol.ts） =====

export interface ManagedPromptSnapshot {
  sequence: number
  exitCode: number
  cwdBase64: string
  pipelineExitCodes?: number[]
}

function safeInteger(text: string): number | undefined {
  if (!/^-?\d+$/.test(text)) return undefined
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : undefined
}

/** 只当数据解析，绝不执行 Bash 声明，也不接受残缺的列表 */
export function parseBashPipelineSnapshot(text: string, declaration = false): number[] | undefined {
  if (!declaration) {
    if (text === '') return []
    if (!/^\d+(?:,\d+)*$/.test(text)) return undefined
    const values = text.split(',').map(Number)
    return values.every((v) => Number.isSafeInteger(v) && v <= 255) ? values : undefined
  }
  const match = /^declare -a PIPESTATUS=\((.*)\)$/.exec(text)
  if (!match) return undefined
  if (match[1] === '') return []
  const values: number[] = []
  for (const field of match[1].split(' ')) {
    const item = /^\[(\d+)\]="(\d+)"$/.exec(field)
    if (!item || Number(item[1]) !== values.length) return undefined
    const value = Number(item[2])
    if (!Number.isSafeInteger(value) || value > 255) return undefined
    values.push(value)
  }
  return values
}

/** W2 是 Windows 格式（5 段）；POSIX 用 3 / 4 段 */
export function parseManagedPrompt(payload: string): ManagedPromptSnapshot | undefined {
  const fields = payload.split(';')
  const modern = fields[0] === 'W2'
  if (modern ? fields.length !== 5 : fields.length !== 3 && fields.length !== 4) return undefined
  const [sequenceText, exitCodeText] = modern ? fields.slice(1, 3) : fields
  const sequence = safeInteger(sequenceText)
  const exitCode = safeInteger(exitCodeText)
  if (sequence === undefined || sequence < 0 || exitCode === undefined) return undefined
  const pipeline = modern ? fields[3] : fields.length === 4 ? fields[3] : undefined
  return {
    sequence,
    exitCode,
    cwdBase64: modern ? fields[4] : fields.length === 4 ? fields[2] : fields[2],
    pipelineExitCodes: pipeline === undefined ? undefined : parseBashPipelineSnapshot(pipeline, modern)
  }
}

function assertToken(token: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(token)) throw new Error('Invalid managed terminal protocol token.')
}

/** Windows（Git Bash / ConPTY）：一次性引导后 exec 成交互式 bash，PS1 里带 W2 标记 */
export function windowsManagedBashProtocol(token: string): { args: string[]; env: Record<string, string> } {
  assertToken(token)
  const bootstrap = [
    // 保留 ISIG 和 ECHO，只关掉额外的规范输入缓冲（否则 MSYS 的定时 read 可能报 EOF）。
    // stty 缺失或拿不到 tty 时不能直接退出：有些环境（精简版 Git、测试 worker、CI）
    // 的 PATH 里没有 stty.exe，而 AI 跑的一次性命令根本不需要逐字符输入，
    // 真退出了会让整个 run_command 变成 SHELL_EXITED。
    "stty -icanon min 1 time 0 2>/dev/null || true",
    // 非交互 bash 会清掉 PS1，先放在私有变量里带过去
    'export PS1="$WSB_MANAGED_PS1"',
    'unset WSB_MANAGED_PS1',
    // 自动化命令不应触发交互式历史展开：例如双引号里的 !! 必须保留为字面量。
    'exec "$BASH" --noprofile --norc -i +H'
  ].join('; ')
  const prompt = [
    `\\[\\e]633;ShunCode;${token};W2;`,
    '$((__wsb_seq=${__wsb_seq:-0}+1));$?;',
    // 在任何命令替换之前读父 shell 的 PIPESTATUS；@A 给出与 IFS 无关的数字数组声明
    '${PIPESTATUS[*]@A};',
    "$(printf '%s' \"$PWD\" | base64 | tr -d '\\r\\n')",
    '\\a\\]$ '
  ].join('')
  return {
    args: ['--noprofile', '--norc', '-c', bootstrap],
    env: { PROMPT_COMMAND: '', WSB_MANAGED_PS1: prompt }
  }
}

/**
 * POSIX：直接起交互式 bash，导出的 PS1 里带同样的 W2 标记。
 * （实测 bash 5.3 在 PROMPT_COMMAND 里读不到 PIPESTATUS，所以和 Windows 一样在 PS1 展开时读。）
 */
export function posixManagedBashProtocol(token: string): { args: string[]; env: Record<string, string> } {
  const prompt = windowsManagedBashProtocol(token).env.WSB_MANAGED_PS1
  return {
    args: ['--noprofile', '--norc', '-i', '+H'],
    env: { PROMPT_COMMAND: '', PS1: prompt, PS2: '> ' }
  }
}

// ===== 路径与 shell =====

/** bash 报的 /d/foo 这类 MSYS 路径转回 Windows 路径 */
export function normalizeManagedTerminalCwd(cwd: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return cwd
  const msys = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(cwd)
  if (msys) return path.win32.normalize(`${msys[1].toUpperCase()}:\\${(msys[2] ?? '').replace(/\//g, '\\')}`)
  if (/^[a-zA-Z]:[\\/]/.test(cwd)) return path.win32.normalize(cwd)
  return cwd
}

/** 不传用工作区根；相对路径按工作区解析；绝对路径可以在工作区外 */
export function resolveCommandCwd(root: string, cwd: string | undefined, platform: NodeJS.Platform = process.platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix
  if (!cwd || !cwd.trim()) return root
  const raw = normalizeManagedTerminalCwd(cwd.trim(), platform)
  return p.isAbsolute(raw) ? p.normalize(raw) : p.resolve(root, raw)
}

export function sameCwd(a: string | undefined, b: string | undefined, platform: NodeJS.Platform = process.platform): boolean {
  if (!a || !b) return false
  const p = platform === 'win32' ? path.win32 : path.posix
  const norm = (s: string) => {
    const n = p.normalize(s).replace(/[\\/]+$/, '')
    return platform === 'win32' ? n.toLowerCase() : n
  }
  return norm(a) === norm(b)
}

// ===== F3-8：审计记录写进活动日志 =====

/** EventLog 里这里用到的部分（结构类型，测试里可以传假的） */
export interface CommandAuditLog<E> {
  start(e: {
    agentId: string
    agentName: string
    agentColor: string
    tool: string
    args: Record<string, unknown>
    workspaceId?: string
  }): E
  finish(ev: E, patch: { status?: 'ok' | 'error'; summary?: string }): unknown
}

/**
 * 把一条命令审计记录写成一条 tool=command_audit 的活动事件：EventLog 会自动脱敏、追加到当天的审计 jsonl。
 * 退出码 0 且正常结束记 ok，其余（非 0、取消、终止）记 error。
 */
export function writeCommandAudit<E>(log: CommandAuditLog<E>, rec: CommandAuditRecord, agent?: { name?: string; color?: string }): void {
  const ev = log.start({
    agentId: rec.owner,
    agentName: agent?.name ?? rec.owner,
    agentColor: agent?.color ?? '#888888',
    tool: 'command_audit',
    args: { ...rec },
    ...(rec.workspace_id ? { workspaceId: rec.workspace_id } : {})
  })
  const statusText = { completed: '已结束', cancelled: '已取消', terminated: '被终止', running: '运行中' }[rec.status] ?? rec.status
  log.finish(ev, {
    status: rec.status === 'completed' && rec.exit_code === 0 ? 'ok' : 'error',
    summary: `命令${statusText}，退出码 ${rec.exit_code ?? '无'}，用时 ${rec.duration_ms} 毫秒，输出 ${rec.output_bytes} 字节${rec.cwd_outside_workspace ? '，工作目录在工作区外' : ''}`
  })
}

// ===== F2-7 / F3-4：受保护目录和敏感文件 =====

function cwdPathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix
}

function pathKey(p: string, platform: NodeJS.Platform): string {
  const n = cwdPathApi(platform).normalize(p).replace(/[\\/]+$/, '')
  return platform === 'win32' ? n.toLowerCase() : n
}

/** child 是否在 parent 里（含相等）；Windows 不分大小写 */
export function isPathInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = cwdPathApi(platform)
  const rel = p.relative(pathKey(parent, platform), pathKey(child, platform))
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel))
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return p
  }
}

/**
 * cwd 落在受保护目录里就返回原因，否则 undefined。受保护：
 * - 在 protectedDirs 里（工作台自己的数据目录，存着令牌和配置）
 * .git、.env 这类不再拦（和 ShunCode 一样），命令可以在里面执行。
 * 原路径和解析符号链接后的真实路径都查。
 */
export function protectedCwdReason(cwd: string, protectedDirs: readonly string[] = [], platform: NodeJS.Platform = process.platform): string | undefined {
  const candidates = [cwd]
  const real = realpathOrSelf(cwd)
  if (real !== cwd) candidates.push(real)
  for (const c of candidates) {
    for (const d of protectedDirs) {
      if (isPathInside(c, d, platform) || isPathInside(c, realpathOrSelf(d), platform)) return '工作目录在工作台的数据目录里'
    }
  }
  return undefined
}

/**
 * 命令文本里出现工作台数据目录（存着令牌）就返回命中的目录。
 * .env、私钥、.git 等文件名不拦。
 * 只是文本匹配，挡不住故意拼接的写法（所以结果里写明 sandbox: false）。
 */
export function protectedCommandHit(command: string, protectedDirs: readonly string[] = [], platform: NodeJS.Platform = process.platform): string | undefined {
  const hay = platform === 'win32' ? command.toLowerCase().replace(/\\/g, '/') : command
  for (const d of protectedDirs) {
    const variants = new Set<string>()
    for (const v of [d, realpathOrSelf(d)]) {
      const n = cwdPathApi(platform).normalize(v).replace(/[\\/]+$/, '')
      if (platform === 'win32') {
        const fwd = n.replace(/\\/g, '/').toLowerCase()
        variants.add(fwd)
        const m = /^([a-z]):\/(.*)$/.exec(fwd)
        if (m) variants.add(`/${m[1]}/${m[2]}`)
      } else {
        variants.add(n)
      }
    }
    for (const v of variants) if (v.length > 1 && hay.includes(v)) return d
  }
  return undefined
}

/** 多行、含非 ASCII 或超长的命令先写进临时脚本 */
export function needsScriptBridge(command: string): boolean {
  return /\r|\n/.test(command) || /[^\x00-\x7F]/.test(command) || command.length > MAX_INLINE_COMMAND_CHARS
}

/** 写临时 .sh：LF 换行；开始标记和正文同一行，出错行号不偏移 */
export function writeTempScript(dir: string, commandId: string, command: string, startMarker?: string): string {
  const scriptPath = path.join(dir, `wsb-run-${commandId}.sh`)
  const prefix = startMarker ? `${startMarker}; ` : ''
  fs.writeFileSync(scriptPath, `${prefix}${command.replace(/\r\n?/g, '\n')}\n`, { mode: 0o700 })
  return scriptPath
}

/** 脚本总在子 shell 里跑，里面的 exit 不会把持久终端带走；子 shell 的退出码就是提示符报的退出码 */
export function tempScriptCommand(scriptPath: string, platform: NodeJS.Platform = process.platform): string {
  const p = platform === 'win32' ? scriptPath.replace(/\\/g, '/') : scriptPath
  return `bash '${p.replace(/'/g, `'\\''`)}'`
}

// ===== 命令级环境变量和 PowerShell =====

export type CommandShell = 'bash' | 'powershell'
export const MAX_COMMAND_ENV_KEYS = 50
export const MAX_COMMAND_ENV_VALUE_BYTES = 32 * 1024
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
/** wait_for 正则的最大长度 */
export const MAX_WAIT_PATTERN_CHARS = 500
/** wait_for 只在最近这么多字节的输出里匹配，防 ReDoS */
export const WAIT_MATCH_WINDOW_BYTES = 64 * 1024
/** list_commands 里 command 截到多少字 */
export const LIST_COMMAND_CHARS = 200
export const MAX_MATCHED_TEXT_CHARS = 200

/** 校验 env 参数：最多 50 个键，键名是合法的变量名，值是字符串且不超过 32 KB */
export function validateCommandEnv(env: unknown): Record<string, string> | undefined {
  if (env === undefined || env === null) return undefined
  if (typeof env !== 'object' || Array.isArray(env)) throw new CommandError('INVALID_ARGUMENT', 'env 必须是「变量名 → 字符串值」的对象')
  const entries = Object.entries(env as Record<string, unknown>)
  if (entries.length > MAX_COMMAND_ENV_KEYS) throw new CommandError('INVALID_ARGUMENT', `env 最多 ${MAX_COMMAND_ENV_KEYS} 个变量，这次有 ${entries.length} 个`)
  const out: Record<string, string> = {}
  for (const [k, v] of entries) {
    if (!ENV_KEY_RE.test(k)) throw new CommandError('INVALID_ARGUMENT', `env 的变量名不合法：${k.slice(0, 80)}（只能用字母、数字、下划线，不能以数字开头）`)
    if (typeof v !== 'string') throw new CommandError('INVALID_ARGUMENT', `env.${k} 的值必须是字符串`)
    if (Buffer.byteLength(v, 'utf8') > MAX_COMMAND_ENV_VALUE_BYTES) throw new CommandError('INVALID_ARGUMENT', `env.${k} 的值超过 ${MAX_COMMAND_ENV_VALUE_BYTES / 1024} KB`)
    out[k] = v
  }
  return entries.length ? out : undefined
}

/** bash 的 ANSI-C 引用：$'...'，换行、引号、反斜杠、控制字符都转义，值原样进变量 */
export function bashQuoteValue(value: string): string {
  let s = ''
  for (const ch of value) {
    const c = ch.codePointAt(0)!
    if (ch === '\\') s += '\\\\'
    else if (ch === "'") s += "\\'"
    else if (ch === '\n') s += '\\n'
    else if (ch === '\r') s += '\\r'
    else if (ch === '\t') s += '\\t'
    else if (c < 0x20 || c === 0x7f) s += `\\x${c.toString(16).padStart(2, '0')}`
    else s += ch
  }
  return `$'${s}'`
}

/** bash 里设环境变量的一句（同一行，不让脚本行号偏移）；没有 env 时返回空串 */
export function bashEnvPrefix(env: Record<string, string> | undefined): string {
  if (!env || !Object.keys(env).length) return ''
  return `export ${Object.entries(env).map(([k, v]) => `${k}=${bashQuoteValue(v)}`).join(' ')}; `
}

/**
 * PowerShell 里设环境变量的一句：值用 base64 传，免得单引号、弯引号（PowerShell 也当引号）、
 * 换行等字符被解释
 */
export function powershellEnvPrefix(env: Record<string, string> | undefined): string {
  if (!env || !Object.keys(env).length) return ''
  return Object.entries(env)
    .map(([k, v]) => `$env:${k} = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(v, 'utf8').toString('base64')}')); `)
    .join('')
}

/**
 * 找 PowerShell：先 pwsh（PowerShell 7），找不到再用 Windows PowerShell 5 的 powershell.exe。
 * 非 Windows 只找 pwsh
 */
export function findPowerShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync
): string | undefined {
  if (platform === 'win32') {
    const w = path.win32
    const dirs = (env.Path ?? env.PATH ?? '').split(';').filter(Boolean)
    const pwsh: string[] = dirs.map((d) => w.join(d, 'pwsh.exe'))
    for (const base of [env.ProgramFiles, env.ProgramW6432]) if (base) pwsh.push(w.join(base, 'PowerShell', '7', 'pwsh.exe'))
    if (env.LOCALAPPDATA) pwsh.push(w.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'))
    const found = pwsh.find((c) => exists(c))
    if (found) return found
    const legacy: string[] = []
    const sysRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR
    if (sysRoot) legacy.push(w.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
    legacy.push(...dirs.map((d) => w.join(d, 'powershell.exe')))
    return legacy.find((c) => exists(c))
  }
  const candidates = (env.PATH ?? '').split(':').filter(Boolean).map((d) => path.posix.join(d, 'pwsh'))
  candidates.push('/usr/bin/pwsh', '/usr/local/bin/pwsh', '/opt/microsoft/powershell/7/pwsh', '/snap/bin/pwsh', '/opt/homebrew/bin/pwsh')
  return candidates.find((c) => exists(c))
}

/**
 * 写临时 .ps1：带 BOM 的 UTF-8（Windows PowerShell 5 没有 BOM 会按 ANSI 读中文）。
 * 第一行先把控制台输出改成 UTF-8、设好 env，和正文同一行，出错行号不偏移
 */
export function writeTempPowerShellScript(dir: string, commandId: string, command: string, env?: Record<string, string>): string {
  const scriptPath = path.join(dir, `wsb-run-${commandId}.ps1`)
  const prefix = `try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }; ${powershellEnvPrefix(env)}`
  const body = command.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n')
  fs.writeFileSync(scriptPath, `\uFEFF${prefix}${body}\r\n`, { mode: 0o700 })
  return scriptPath
}

/** 在 bash 里调 PowerShell 执行 .ps1 的一句（Windows 路径换成正斜杠，Git Bash 和 PowerShell 都认） */
export function powershellInvocation(exe: string, scriptPath: string, platform: NodeJS.Platform = process.platform): string {
  const fix = (p: string) => (platform === 'win32' ? p.replace(/\\/g, '/') : p)
  const q = (p: string) => `'${fix(p).replace(/'/g, `'\\''`)}'`
  return `${q(exe)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${q(scriptPath)}`
}

export interface ShellSpec {
  file: string
  args: string[]
  env: Record<string, string>
  kind: 'windows-bash' | 'posix-bash'
}

/**
 * F2-6：子进程只拿这些环境变量（Windows 上不分大小写）。
 * 保证 Git Bash、git、node/npm 能正常工作；令牌、API key、代理账号等一律不传。
 */
export const ENV_ALLOWLIST: readonly string[] = [
  // 通用
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ', 'TMPDIR', 'TEMP', 'TMP',
  // Windows 系统
  'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'OS', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN',
  'COMPUTERNAME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ALLUSERSPROFILE', 'PUBLIC', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'DRIVERDATA',
  // Git Bash / MSYS
  'MSYSTEM', 'MSYS', 'MSYS2_PATH_TYPE'
]

/** 照 ShunCode：不把外层终端的集成标记、提示符设置漏进来；F2-6：只传白名单里的变量 */
export function managedProcessEnvironment(base: NodeJS.ProcessEnv = process.env, extraAllow: readonly string[] = []): Record<string, string> {
  const allow = new Set([...ENV_ALLOWLIST, ...extraAllow].map((k) => k.toUpperCase()))
  // Windows 的环境变量名不分大小写，但 JS 对象分：process.env 里可能同时有 Path 和 PATH
  // （vitest 的 worker 就是这样）。原样交给 CreateProcess 时后写的会盖掉先写的，
  // 于是 withGitPath 加到 Path 上的 Git 目录会被一个没加过的 PATH 覆盖掉，
  // bash 里就找不到 stty / base64，整个 run_command 直接 SHELL_EXITED。
  // 所以按大写键去重：键名保留第一次见到的写法，值用最后一个（和 Windows 的覆盖顺序一致）。
  const picked = new Map<string, [string, string]>()
  for (const [key, value] of Object.entries(base)) {
    if (typeof value !== 'string') continue
    const upper = key.toUpperCase()
    if (!allow.has(upper)) continue
    const prev = picked.get(upper)
    picked.set(upper, [prev ? prev[0] : key, value])
  }
  const env = Object.fromEntries(picked.values())
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.WORKSPACE_BRIDGE_TERMINAL = '1'
  env.HISTFILE = ''
  if (!env.LANG) env.LANG = 'C.UTF-8'
  return env
}

/** 找 Git for Windows 的 bash.exe（不用 System32 里的 WSL bash） */
export function findWindowsBash(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  const w = path.win32
  const candidates: string[] = []
  if (env.WORKSPACE_BRIDGE_BASH) candidates.push(env.WORKSPACE_BRIDGE_BASH)
  for (const base of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']]) {
    if (base) candidates.push(w.join(base, 'Git', 'bin', 'bash.exe'))
  }
  if (env.LOCALAPPDATA) candidates.push(w.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'))
  const pathValue = env.Path ?? env.PATH ?? ''
  for (const dir of pathValue.split(';').filter(Boolean)) {
    if (exists(w.join(dir, 'git.exe'))) {
      // ...\Git\cmd\git.exe、...\Git\bin\git.exe、...\Git\mingw64\bin\git.exe
      const up = /[\\/]mingw64[\\/]bin[\\/]?$/i.test(dir) ? w.resolve(dir, '..', '..') : w.resolve(dir, '..')
      candidates.push(w.join(up, 'bin', 'bash.exe'))
    }
  }
  for (const dir of pathValue.split(';').filter(Boolean)) {
    if (/[\\/]system32[\\/]?$/i.test(dir) || /[\\/]WindowsApps[\\/]?$/i.test(dir)) continue
    candidates.push(w.join(dir, 'bash.exe'))
  }
  return candidates.find((c) => exists(c))
}

/** Git 根目录的 usr/bin、mingw64/bin、bin 加到 PATH 前面（--noprofile 不会读 /etc/profile） */
export function withGitPath(bashExe: string, existingPath: string): string {
  const w = path.win32
  const binDir = w.dirname(bashExe)
  const root = /[\\/]usr[\\/]bin$/i.test(binDir) ? w.resolve(binDir, '..', '..') : w.resolve(binDir, '..')
  const additions = [w.join(root, 'usr', 'bin'), w.join(root, 'mingw64', 'bin'), w.join(root, 'bin')]
  return [...additions, existingPath].filter(Boolean).join(';')
}

export function managedShellSpec(token: string, platform: NodeJS.Platform = process.platform, base: NodeJS.ProcessEnv = process.env, extraEnvAllow: readonly string[] = []): ShellSpec {
  const env = managedProcessEnvironment(base, extraEnvAllow)
  if (platform === 'win32') {
    const bash = findWindowsBash(base)
    if (!bash) throw new CommandError('SHELL_NOT_FOUND', '找不到 Git Bash（bash.exe）。请安装 Git for Windows，或设置环境变量 WORKSPACE_BRIDGE_BASH 指向 bash.exe')
    const protocol = windowsManagedBashProtocol(token)
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path'
    env[pathKey] = withGitPath(bash, env[pathKey] ?? '')
    // 让 bash 留在 spawn 时的目录，不跳回 HOME
    env.CHERE_INVOKING = '1'
    env.MSYS2_PATH_TYPE = env.MSYS2_PATH_TYPE ?? 'inherit'
    return { file: bash, args: protocol.args, env: { ...env, ...protocol.env }, kind: 'windows-bash' }
  }
  const file = fs.existsSync('/bin/bash') ? '/bin/bash' : fs.existsSync('/usr/bin/bash') ? '/usr/bin/bash' : ''
  if (!file) throw new CommandError('SHELL_NOT_FOUND', '找不到 /bin/bash')
  const protocol = posixManagedBashProtocol(token)
  return { file, args: protocol.args, env: { ...env, ...protocol.env }, kind: 'posix-bash' }
}

// ===== ANSI 处理 =====

/** data[index] 开头的 ANSI 序列长度；不完整的序列吞到结尾 */
export function ansiEscapeLength(data: string, index: number): number {
  if (data[index] !== '\x1b') return 0
  const next = data[index + 1]
  if (next === undefined) return 1
  if (next === '[') {
    let i = index + 2
    while (i < data.length) {
      const c = data.charCodeAt(i)
      if (c >= 0x40 && c <= 0x7e) return i - index + 1
      i++
    }
    return data.length - index
  }
  if (next === ']' || next === 'P' || next === '_' || next === '^') {
    let i = index + 2
    while (i < data.length) {
      if (data[i] === '\x07') return i - index + 1
      if (data[i] === '\x1b' && data[i + 1] === '\\') return i - index + 2
      i++
    }
    return data.length - index
  }
  if (next === '(' || next === ')' || next === '#' || next === '%') return Math.min(3, data.length - index)
  return 2
}

/** 提示符：bash 的 "$ "、续行 "> "、PowerShell 的 "PS ...> "；-1 表示 PS 行在后面的块里继续 */
export function promptTextLength(data: string, index: number): number {
  if (data.startsWith('$ ', index)) return 2
  if (data.startsWith('> ', index)) return 2
  if (data.startsWith('PS ', index)) {
    let i = index + 3
    while (i < data.length && data[i] !== '\r' && data[i] !== '\n') {
      if (data[i] === '>') return i - index + 1 + (data[i + 1] === ' ' ? 1 : 0)
      i++
    }
    return i >= data.length ? -1 : 0
  }
  return 0
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P_^][^\x1b]*\x1b\\|\x1b[()#%][\s\S]|\x1b[@-Z\\-_=>]/g
// eslint-disable-next-line no-control-regex
const PARTIAL_ANSI_SUFFIX_RE = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*|\][^\x07]*\x1b|[P_^][^\x1b]*(?:\x1b)?|[()#%])?$/

/** 去掉 ANSI，\r\n 归一成 \n，单独的 \r 和 BEL 去掉；返回 [干净文本, 没收完的尾巴] */
export function stripAnsi(text: string): [string, string] {
  const partial = PARTIAL_ANSI_SUFFIX_RE.exec(text)
  let tail = ''
  if (partial && partial[0]) {
    tail = text.slice(partial.index)
    text = text.slice(0, partial.index)
  }
  // \r 留到下一块再判断是不是 \r\n
  if (text.endsWith('\r')) {
    tail = '\r' + tail
    text = text.slice(0, -1)
  }
  const clean = text
    .replace(ANSI_RE, '')
    .replace(/\r+\n/g, '\n')
    .replace(/[\r\x07]/g, '')
  return [clean, tail]
}

// ===== 输出缓冲：绝对偏移，保留最近 N 字节 =====

export interface OutputSlice {
  text: string
  offset: number
  nextOffset: number
  lost: boolean
  hasMore: boolean
  totalBytes: number
}

export class OutputBuffer {
  private chunks: Buffer[] = []
  /** 已保留部分的起始绝对偏移（之前的已丢弃） */
  private base = 0
  /** 写入的总字节数（= 末尾的绝对偏移） */
  private total = 0

  constructor(private readonly maxBytes = MAX_CAPTURED_OUTPUT_BYTES) {}

  get totalBytes(): number {
    return this.total
  }

  get droppedBytes(): number {
    return this.base
  }

  append(text: string): void {
    if (!text) return
    const buf = Buffer.from(text, 'utf8')
    this.chunks.push(buf)
    this.total += buf.length
    let excess = this.total - this.base - this.maxBytes
    while (excess > 0 && this.chunks.length) {
      const first = this.chunks[0]
      if (first.length <= excess) {
        this.chunks.shift()
        this.base += first.length
        excess -= first.length
      } else {
        this.chunks[0] = first.subarray(excess)
        this.base += excess
        excess = 0
      }
    }
  }

  read(offset: number, maxBytes: number): OutputSlice {
    const lost = offset < this.base
    let start = Math.min(Math.max(offset, this.base), this.total)
    const all = Buffer.concat(this.chunks)
    let rel = start - this.base
    // 落在多字节字符中间就往后挪到字符边界
    while (rel < all.length && (all[rel] & 0xc0) === 0x80) rel++
    start = this.base + rel
    let endRel = Math.min(all.length, rel + Math.max(1, maxBytes))
    if (endRel < all.length) {
      let cut = endRel
      while (cut > rel && (all[cut] & 0xc0) === 0x80) cut--
      if (cut > rel) endRel = cut
    }
    return {
      text: all.subarray(rel, endRel).toString('utf8'),
      offset: start,
      nextOffset: this.base + endRel,
      lost,
      hasMore: this.base + endRel < this.total,
      totalBytes: this.total
    }
  }
}

// ===== 一个持久终端（照 ManagedCommandPseudoterminal，去掉 VS Code 显示部分） =====

type GateOutcome = 'pending' | 'echo-matched' | 'start-marker' | 'released-mismatch' | 'released-timeout' | 'released-finish' | 'released-exit'

interface ActiveCommand {
  sequence: number
  seqAtStart: number
  started: boolean
  finishing: boolean
  finishExitCode?: number
  finishPipelineExitCodes?: number[]
  finishTimer?: ReturnType<typeof setTimeout>
  onOutput: (text: string) => void
  onExit: (exitCode: number | null, pipelineExitCodes: number[] | undefined, info: { terminated: boolean }) => void
}

export interface PtyHostOptions {
  pty: PtyModule
  shell: ShellSpec
  cwd: string
  platform?: NodeJS.Platform
  /** 强制结束整棵进程树（Windows 默认 taskkill /PID pid /T /F） */
  killTree?: (pid: number) => void
  readyTimeoutMs?: number
  echoTimeoutMs?: number
  flushMs?: number
}

export function defaultKillTree(platform: NodeJS.Platform = process.platform): (pid: number) => void {
  return (pid: number) => {
    if (!pid) return
    if (platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // 已经没了
        }
      }
    }
  }
}

export class ManagedTerminal {
  readonly protocolToken = randomBytes(12).toString('hex')
  private readonly markerPrefix: string
  private activePty: IPty | undefined
  private subs: IDisposable[] = []
  private pending = ''
  private ready = false
  private exited = false
  private disposed = false
  private readyPromise: Promise<void> | undefined
  private readyResolver: (() => void) | undefined
  private readyRejecter: ((e: Error) => void) | undefined
  private lastPromptSequence = 0
  private nextCommandSequence = 1
  private currentCwdValue: string
  private activeCommand: ActiveCommand | undefined
  // 回显闸门
  private echoGateActive = false
  private echoExpectation = ''
  private echoMatchIndex = 0
  private echoHuntBytesRemaining = 0
  private echoHuntingPromptLine = false
  private echoMatched = false
  private markerPromised = false
  private markerHold = false
  private continuationPromptSeen = false
  private echoTimeoutTimer: ReturnType<typeof setTimeout> | undefined
  private gateHeld: string[] = []
  private gateHeldBytes = 0
  private lastGateOutcomeValue: GateOutcome = 'pending'
  private readonly platform: NodeJS.Platform
  private readonly killTree: (pid: number) => void
  /** 终端进程退出时通知池子 */
  onClose: ((exitCode: number | null) => void) | undefined

  constructor(private readonly opts: PtyHostOptions) {
    this.platform = opts.platform ?? process.platform
    this.killTree = opts.killTree ?? defaultKillTree(this.platform)
    this.currentCwdValue = opts.cwd
    this.markerPrefix = `\x1b]633;ShunCode;${this.protocolToken};`
  }

  get currentCwd(): string {
    return this.currentCwdValue
  }

  get isReady(): boolean {
    return this.ready && !this.exited && !this.disposed
  }

  get isBusy(): boolean {
    return this.activeCommand !== undefined
  }

  get pid(): number | undefined {
    return this.activePty?.pid
  }

  get lastGateOutcome(): GateOutcome {
    return this.lastGateOutcomeValue
  }

  /** 启动 bash，等第一个提示符标记 */
  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolver = resolve
      this.readyRejecter = reject
    })
    const shell = { ...this.opts.shell, args: [...this.opts.shell.args] }
    // 协议里写死的 token 要和这个终端的一致
    const protocol = shell.kind === 'windows-bash' ? windowsManagedBashProtocol(this.protocolToken) : posixManagedBashProtocol(this.protocolToken)
    shell.args = protocol.args
    shell.env = { ...shell.env, ...protocol.env }
    try {
      this.activePty = this.opts.pty.spawn(shell.file, shell.args, {
        name: this.platform === 'win32' ? 'cmd' : 'xterm-256color',
        cols: 200,
        rows: 50,
        cwd: this.opts.cwd,
        env: shell.env
      })
    } catch (e) {
      this.readyRejecter?.(new CommandError('SPAWN_FAILED', `启动终端失败：${(e as Error).message}`))
      this.readyResolver = undefined
      this.readyRejecter = undefined
      return this.readyPromise
    }
    this.subs.push(this.activePty.onData((d) => this.onPtyData(d)))
    this.subs.push(this.activePty.onExit((e) => this.onPtyExit(e.exitCode)))
    const timer = setTimeout(() => {
      if (this.ready) return
      this.readyRejecter?.(new CommandError('SHELL_START_TIMEOUT', '终端启动超时，没有等到提示符'))
      this.readyResolver = undefined
      this.readyRejecter = undefined
      this.dispose()
    }, this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS)
    timer.unref?.()
    return this.readyPromise.finally(() => clearTimeout(timer))
  }

  /** 下一条 run() 是桥接脚本：脚本第一句打这个开始标记，之前的全部当回显丢弃 */
  scriptStartMarkerStatement(): string {
    this.markerPromised = true
    return `printf '\\033]633;ShunCode;${this.protocolToken};S;${this.nextCommandSequence}\\007'`
  }

  run(command: string, onOutput: ActiveCommand['onOutput'], onExit: ActiveCommand['onExit']): void {
    if (!this.isReady || !this.activePty) throw new CommandError('TERMINAL_UNAVAILABLE', '终端不可用')
    if (this.activeCommand) throw new CommandError('TERMINAL_BUSY', '终端正在执行其他命令')
    const sequence = this.nextCommandSequence++
    this.activeCommand = { sequence, seqAtStart: this.lastPromptSequence, started: false, finishing: false, onOutput, onExit }
    this.lastGateOutcomeValue = 'pending'
    this.continuationPromptSeen = false
    this.echoMatched = false
    this.gateHeld = []
    this.gateHeldBytes = 0
    this.echoGateActive = true
    this.echoExpectation = command
    this.echoMatchIndex = 0
    this.echoHuntBytesRemaining = MAX_ECHO_HUNT_BYTES
    this.echoHuntingPromptLine = false
    this.markerHold = this.markerPromised
    this.markerPromised = false
    this.armEchoTimeout()
    this.activePty.write(`${command}\r`)
  }

  /** 给正在跑的程序写输入（send_command_input） */
  write(data: string): void {
    if (!this.activePty || this.exited) throw new CommandError('TERMINAL_UNAVAILABLE', '终端已经退出')
    this.activePty.write(data)
  }

  /** Ctrl-C */
  interrupt(): void {
    if (!this.activePty || this.exited) return
    this.activePty.write('\x03')
  }

  private abortCurrentInput(): void {
    this.interrupt()
  }

  /** 强制结束：Windows 先 taskkill /T /F 整棵树，再关 PTY */
  terminateActiveProcess(): void {
    const activePty = this.activePty
    if (!activePty) return
    try {
      this.killTree(activePty.pid)
    } catch {
      // 尽力而为
    }
    try {
      activePty.kill()
    } catch {
      // PTY 可能已经没了
    }
  }

  // ----- 数据流 -----

  private onPtyData(chunk: string): void {
    if (this.disposed) return
    const data = this.pending + chunk
    this.pending = ''
    const prefix = this.markerPrefix
    let i = 0
    while (i < data.length) {
      const start = data.indexOf(prefix, i)
      if (start < 0) {
        // 结尾可能是半个标记前缀，留到下一块
        let keep = 0
        for (let n = Math.min(prefix.length - 1, data.length - i); n > 0; n--) {
          if (prefix.startsWith(data.slice(data.length - n))) {
            keep = n
            break
          }
        }
        this.handleText(data.slice(i, data.length - keep))
        this.pending = data.slice(data.length - keep)
        return
      }
      this.handleText(data.slice(i, start))
      const bel = data.indexOf('\x07', start + prefix.length)
      if (bel < 0) {
        const rest = data.slice(start)
        if (rest.length > 8192) this.handleText(rest)
        else this.pending = rest
        return
      }
      this.handleProtocolMarker(data.slice(start + prefix.length, bel))
      i = bel + 1
    }
  }

  private handleText(text: string): void {
    if (!text || !this.ready) return
    const active = this.activeCommand
    if (!active) return
    if (this.echoGateActive) {
      if (this.markerHold) {
        this.holdGated(text)
        return
      }
      const released = this.consumeCommandEcho(text)
      if (released === null) {
        this.holdGated(text)
        return
      }
      this.holdGated(text.slice(0, text.length - released.length))
      this.closeGate(this.echoMatched ? 'echo-matched' : 'released-mismatch')
      active.started = true
      text = released
      if (!text) return
    }
    const out = active.finishing ? this.stripPromptText(text) : text
    if (out) active.onOutput(out)
  }

  private closeGate(outcome: GateOutcome): void {
    this.echoGateActive = false
    this.markerHold = false
    if (this.echoTimeoutTimer) {
      clearTimeout(this.echoTimeoutTimer)
      this.echoTimeoutTimer = undefined
    }
    this.settleGateHeld(outcome)
    this.resetEchoGate()
  }

  /**
   * 回显闸门（照 ShunCode consumeCommandEcho）：跳过已知噪声（提示符、空白、ANSI、退格），
   * 宽松匹配回显文本（\r 重绘从头再来、退格撤销一个已匹配字符）；整段回显之后只吞换行和重绘噪声，
   * 任何普通字符都放行。返回 null 表示还在回显里，闸门继续关着。
   */
  private consumeCommandEcho(data: string): string | null {
    const expectation = this.echoExpectation
    let index = 0
    while (index < data.length) {
      const ch = data[index]
      if (this.echoMatchIndex === 0 || this.echoMatchIndex >= expectation.length) {
        if (ch === '\r' || ch === '\n') {
          if (this.echoMatchIndex >= expectation.length) break
          index++
          continue
        }
      }
      const ansi = ansiEscapeLength(data, index)
      if (ansi > 0) {
        index += ansi
        continue
      }
      if (ch === '\b') {
        index++
        if (this.echoMatchIndex > 0) this.echoMatchIndex--
        continue
      }
      if (this.echoMatchIndex === 0) {
        if (this.echoHuntBytesRemaining <= 0) {
          this.resetEchoGate()
          return data.slice(index)
        }
        this.echoHuntBytesRemaining--
        if (ch === ' ' || ch === '\t' || ch === '\u0007') {
          index++
          continue
        }
        if (this.echoHuntingPromptLine) {
          let cursor = index
          while (cursor < data.length && data[cursor] !== '\r' && data[cursor] !== '\n') cursor++
          if (cursor < data.length) this.echoHuntingPromptLine = false
          index = cursor
          continue
        }
        if (data.startsWith('>>', index) || (data.startsWith('> ', index) && expectation[0] !== '>')) this.continuationPromptSeen = true
        // 命令本身就以 "$ " / "> " 开头时不能把它当提示符跳过
        const promptLength = expectation.startsWith(data.slice(index, index + 2)) ? 0 : promptTextLength(data, index)
        if (promptLength === -1) {
          this.echoHuntingPromptLine = true
          return null
        }
        if (promptLength > 0) {
          index += promptLength
          continue
        }
        if (ch !== expectation[0]) {
          // 不是回显也不是噪声：回显已经过去了或根本没渲染
          this.resetEchoGate()
          return data.slice(index)
        }
        this.echoMatchIndex++
        index++
        continue
      }
      // 匹配回显文本中途：\r 表示整行从第 0 列重绘；\n 是终端折行
      if (ch === '\r') {
        if (data[index + 1] === '\n') {
          index += 2
          continue
        }
        this.echoMatchIndex = 0
        index++
        continue
      }
      if (ch === '\n') {
        index++
        continue
      }
      if (ch !== expectation[this.echoMatchIndex]) {
        // 假锚点：从不匹配处重新找
        this.echoMatchIndex = 0
        continue
      }
      this.echoMatchIndex++
      index++
    }

    if (this.echoMatchIndex >= expectation.length) {
      // 整段回显已吞掉；只再吞行尾的换行和重绘噪声，普通字符就是真输出
      while (index < data.length) {
        const ch = data[index]
        if (ch === '\r' || ch === '\n') {
          index++
          continue
        }
        const ansi = ansiEscapeLength(data, index)
        if (ansi > 0) {
          index += ansi
          continue
        }
        if (ch === '\b') {
          index++
          continue
        }
        break
      }
      this.echoMatched = true
      return data.slice(index)
    }
    return null
  }

  private holdGated(data: string): void {
    if (!data) return
    this.gateHeld.push(data)
    this.gateHeldBytes += data.length
    while (this.gateHeldBytes > MAX_GATE_HELD_CHARS && this.gateHeld.length > 1) {
      this.gateHeldBytes -= this.gateHeld.shift()!.length
    }
  }

  /** echo-matched / start-marker：暂存的是回显，丢掉；其他情况放回输出，回显认不出来也不会把结果变成空的 */
  private settleGateHeld(outcome: GateOutcome): void {
    const held = this.gateHeld.join('')
    this.gateHeld = []
    this.gateHeldBytes = 0
    if (this.lastGateOutcomeValue === 'pending') this.lastGateOutcomeValue = outcome
    if (outcome === 'echo-matched' || outcome === 'start-marker' || !held) return
    const active = this.activeCommand
    if (!active) return
    const text = active.finishing ? this.stripPromptText(held) : held
    if (text) active.onOutput(text)
  }

  private resetEchoGate(): void {
    this.echoExpectation = ''
    this.echoMatchIndex = 0
    this.echoGateActive = false
    this.echoHuntBytesRemaining = 0
    this.echoHuntingPromptLine = false
    this.markerHold = false
  }

  private armEchoTimeout(extended = false): void {
    if (this.echoTimeoutTimer) clearTimeout(this.echoTimeoutTimer)
    const base = this.opts.echoTimeoutMs ?? COMMAND_ECHO_TIMEOUT_MS
    this.echoTimeoutTimer = setTimeout(() => {
      this.echoTimeoutTimer = undefined
      if (!this.echoGateActive) return
      // 走脚本桥接时正文前有开始标记：机器忙、bash 起得慢时 2 秒内可能还没到。
      // 这时闸门里暂存的只会是 `bash '...sh'` 这行回显，提前放出来就混进了输出；再多等一段（最多 MARKER_WAIT_MS）
      if (this.markerHold && !extended) {
        this.armEchoTimeout(true)
        return
      }
      if (!this.echoGateActive) return
      this.echoGateActive = false
      this.settleGateHeld('released-timeout')
      this.resetEchoGate()
      const active = this.activeCommand
      if (active && !active.started) active.started = true
      // 闸门关着时出现了续行提示符：shell 在等更多输入（引号没闭合），直接中止，别挂到超时
      if (active && !active.finishing && this.continuationPromptSeen) this.abortCurrentInput()
    }, extended ? Math.max(base, MARKER_WAIT_MS - base) : base)
  }

  private handleProtocolMarker(payload: string): void {
    if (payload.startsWith('S;')) {
      const sequence = Number.parseInt(payload.slice(2), 10)
      if (this.activeCommand?.sequence === sequence) {
        this.activeCommand.started = true
        // 正文开始了：闸门里暂存的都是开始之前的回显 / 重绘，丢掉
        if (this.echoGateActive) this.closeGate('start-marker')
      }
      return
    }
    const snapshot = parseManagedPrompt(payload)
    if (!snapshot) return
    const { sequence, exitCode, cwdBase64 } = snapshot
    if (sequence > this.lastPromptSequence) this.lastPromptSequence = sequence
    if (cwdBase64) {
      try {
        const cwd = Buffer.from(cwdBase64, 'base64').toString('utf8')
        if (cwd) this.currentCwdValue = normalizeManagedTerminalCwd(cwd, this.platform)
      } catch {
        // 编码不了就保留上一次的 cwd
      }
    }
    if (!this.ready) {
      this.ready = true
      this.readyResolver?.()
      this.readyResolver = undefined
      this.readyRejecter = undefined
      return
    }
    const active = this.activeCommand
    if (!active || active.finishing) return
    // 序号闸门：只有这条命令写入之后渲染的提示符才能结束它
    if (sequence <= active.seqAtStart) return
    active.finishing = true
    active.finishExitCode = exitCode
    active.finishPipelineExitCodes = snapshot.pipelineExitCodes
    // 留一个短的冲刷窗口接住晚到的尾部输出
    active.finishTimer = setTimeout(() => this.finishCommand(active, false), this.opts.flushMs ?? PTY_EXIT_DATA_FLUSH_MS)
  }

  private finishCommand(command: ActiveCommand, terminated: boolean): void {
    if (this.activeCommand === command && this.echoGateActive) this.settleGateHeld(terminated ? 'released-exit' : 'released-finish')
    this.resetEchoGate()
    if (command.finishTimer) {
      clearTimeout(command.finishTimer)
      command.finishTimer = undefined
    }
    if (this.echoTimeoutTimer) {
      clearTimeout(this.echoTimeoutTimer)
      this.echoTimeoutTimer = undefined
    }
    if (this.activeCommand !== command) return
    this.activeCommand = undefined
    this.continuationPromptSeen = false
    command.onExit(command.finishExitCode ?? null, command.finishPipelineExitCodes, { terminated })
  }

  private stripPromptText(text: string): string {
    // readline 会在提示符前插入 \e[?2004h 这类控制序列，允许它们夹在行首和提示符之间
    // eslint-disable-next-line no-control-regex
    return text.replace(/(^|[\r\n])((?:\x1b\[[0-?]*[ -/]*[@-~])*)PS [^\r\n]*?>/g, '$1$2').replace(/(^|[\r\n])((?:\x1b\[[0-?]*[ -/]*[@-~])*)\$ /g, '$1$2')
  }

  private onPtyExit(exitCode: number | undefined): void {
    if (this.exited) return
    this.exited = true
    if (this.pending) {
      this.handleText(this.pending)
      this.pending = ''
    }
    if (!this.ready) {
      this.readyRejecter?.(new CommandError('SHELL_EXITED', `终端启动后立即退出（退出码 ${exitCode ?? '未知'}）`))
      this.readyResolver = undefined
      this.readyRejecter = undefined
    }
    const active = this.activeCommand
    if (active) {
      if (!active.finishing) active.finishExitCode = exitCode ?? undefined
      this.finishCommand(active, !active.finishing)
    }
    this.disposeSubscriptions()
    this.onClose?.(exitCode ?? null)
  }

  private disposeSubscriptions(): void {
    for (const s of this.subs) {
      try {
        s.dispose()
      } catch {
        // ignore
      }
    }
    this.subs = []
  }

  dispose(): void {
    if (this.disposed) return
    const active = this.activeCommand
    this.terminateActiveProcess()
    if (active && !this.exited) {
      this.exited = true
      this.finishCommand(active, true)
    }
    this.disposed = true
    if (this.echoTimeoutTimer) clearTimeout(this.echoTimeoutTimer)
    this.echoTimeoutTimer = undefined
    this.gateHeld = []
    this.gateHeldBytes = 0
    this.resetEchoGate()
    this.activeCommand = undefined
    this.disposeSubscriptions()
    this.activePty = undefined
    if (!this.ready) {
      this.readyRejecter?.(new CommandError('SHELL_EXITED', '终端已关闭'))
      this.readyResolver = undefined
      this.readyRejecter = undefined
    }
  }
}

// ===== 终端池 + 命令状态（照 TerminalCommandManager） =====

export type CommandStatus = 'running' | 'completed' | 'cancelled' | 'terminated'

interface Slot {
  id: string
  owner: string
  term: ManagedTerminal
  busy: boolean
  lastUsed: number
  idleTimer?: ReturnType<typeof setTimeout>
  closed: boolean
}

interface CommandState {
  id: string
  owner: string
  command: string
  cwd: string
  workspaceRoot: string
  meta: CommandRunMeta
  audited: boolean
  background: boolean
  /** run_command 已经返回了而它还在跑（background=true，或前台等到 timeout_ms）：发起人手里只有 status=running */
  detached: boolean
  status: CommandStatus
  exitCode: number | null
  pipelineExitCodes?: number[]
  startedAt: number
  endedAt?: number
  slotId: string
  tempScriptPath?: string
  /** powershell 时的临时 .ps1（外面还有一层调 PowerShell 的 .sh，在 tempScriptPath） */
  tempPs1Path?: string
  shell: CommandShell
  output: OutputBuffer
  ansiTail: string
  cancelRequested: boolean
  done: Promise<void>
  resolveDone: () => void
  /** get_command_output 的等待者：有新输出、结束、取消、记录被丢弃时都叫一遍，让它们重新检查 */
  waiters: Set<() => void>
}

export interface RunCommandInput {
  command: string
  cwd?: string
  timeout_ms?: number
  background?: boolean
  max_output_bytes?: number
  /** 默认 bash；powershell 写临时 .ps1 后在 bash 终端里用 pwsh / powershell.exe 执行 */
  shell?: CommandShell
  /** 只对这一条命令生效的环境变量 */
  env?: Record<string, string>
}

export interface GetOutputOptions {
  offset?: number
  max_bytes?: number
  /** 最多等多少毫秒（0～MAX_TIMEOUT_MS，默认 0 不等） */
  wait_ms?: number
  /** 等到新输出匹配这个正则（最长 500 字） */
  wait_for?: string
  /** 调用方断开连接时中止等待 */
  signal?: AbortSignal
}

export type WaitResult = 'matched' | 'exited' | 'new_output' | 'timeout'

/** 用户在工作台看所有 AI 的命令：多一个 owner（agent id） */
export interface UserCommandItem extends CommandListItem {
  owner: string
}

/** 用户读任意 AI 的命令输出：快照加上完整命令和发起者 */
export interface UserCommandOutput extends CommandSnapshot {
  owner: string
  command: string
  shell: CommandShell
  started_at: string
}

/** listAll 最多返回多少条已结束的命令（运行中的全部返回） */
export const MAX_USER_LIST_COMMANDS = 200
/** getOutputForUser 默认一次读多少字节 */
export const USER_OUTPUT_BYTES = 256 * 1024

export interface CommandListItem {
  command_id: string
  command: string
  cwd: string
  shell: CommandShell
  status: CommandStatus
  exit_code: number | null
  started_at: string
  duration_ms: number
  background: boolean
  output_bytes: number
}

/** run 的附加信息，只进审计记录 */
export interface CommandRunMeta {
  workspaceId?: string
  /** 审计记录里的字段，现在总是 not_required（审批已经去掉；保留字段是为了旧审计记录能照常读） */
  approval?: 'approved' | 'not_required'
}

/** 最近完成的命令记录，供任务交付时生成命令证据；只存在内存里。 */
export interface CommandRecord {
  agentId: string
  command: string
  cwd: string
  exitCode: number | null
  startedAt: number
  endedAt: number
  durationMs: number
  output: string
}

/** 每个身份最多保留多少条命令证据记录。 */
export const MAX_COMMAND_RECORDS_PER_AGENT = 50
/** 每条命令证据最多保留多少字符的输出尾部。 */
export const MAX_COMMAND_RECORD_OUTPUT_CHARS = 4_000
/** recentRecords 默认返回多少条。 */
export const DEFAULT_COMMAND_RECORD_LIMIT = 8

/** F3-8：每条命令结束时一条审计记录（不含输出内容） */
export interface CommandAuditRecord {
  command_id: string
  owner: string
  workspace_id?: string
  workspace_root: string
  cwd: string
  cwd_outside_workspace: boolean
  /** 最多 MAX_AUDIT_COMMAND_CHARS 个字符 */
  command: string
  command_truncated: boolean
  approval: 'approved' | 'not_required'
  status: CommandStatus
  exit_code: number | null
  started_at: number
  ended_at: number
  duration_ms: number
  output_bytes: number
  background: boolean
  /**
   * 结束时没有调用在等它的结果：run_command 早就带着 status=running 返回了，也没有 get_command_output 正带着 wait_ms / wait_for 等。
   * 这种要主动告诉发起人（Bridge 往它的【通知】里放一条），不然它只能自己轮询
   */
  unattended: boolean
}

export interface CommandSnapshot {
  command_id: string
  status: CommandStatus
  exit_code: number | null
  pipeline_exit_codes?: number[]
  cwd: string
  /** cwd 不在工作区里 */
  cwd_outside_workspace: boolean
  /** F3-10：命令以工作台进程的用户权限运行，没有沙箱 */
  sandbox: false
  background: boolean
  elapsed_ms: number
  output: string
  offset: number
  next_offset: number
  output_lost: boolean
  has_more: boolean
  total_output_bytes: number
  /** 只在 get_command_output 带 wait_ms / wait_for 时有：这次等待为什么返回 */
  wait_result?: WaitResult
  /** wait_result=matched 时匹配到的文本（截到 200 字） */
  matched_text?: string
  message?: string
}

export interface CommandRunnerOptions {
  /** 默认用 terminal.ts 的 loadPty */
  loadPty?: () => Promise<PtyModule>
  /** 默认 managedShellSpec */
  shellSpec?: () => ShellSpec
  platform?: NodeJS.Platform
  killTree?: (pid: number) => void
  tempDir?: string
  maxCapturedBytes?: number
  maxIdleTerminals?: number
  maxSlots?: number
  /** 每个身份同时运行的命令上限，默认 MAX_RUNNING_PER_OWNER */
  maxRunningPerOwner?: number
  /** 受保护目录（工作台数据目录）：cwd 不能在里面，命令文本也不能提到 */
  protectedDirs?: string[]
  /**
   * 按身份拦的目录（没对这个 AI 开放的工作区）：cwd 不能在里面，命令文本、env 也不能提到它们的路径。
   * 和数据目录一样只是文本匹配，挡不住故意拼接的写法
   */
  fenceFor?: (owner: string) => PathFence | undefined
  /** 白名单之外还要传给子进程的环境变量名 */
  extraEnvAllow?: string[]
  /** 默认 findPowerShell(platform)；测试里换成假的 */
  findPowerShell?: () => string | undefined
  /** 每条命令结束时调用一次（审计）；抛错会被吞掉 */
  onAudit?: (rec: CommandAuditRecord) => void
  /** 命令新建、有新输出、结束、记录被丢弃时调用（界面刷新用，调用方自己节流）；抛错会被吞掉 */
  onChange?: () => void
  idleTtlMs?: number
  maxFinishedPerOwner?: number
  readyTimeoutMs?: number
  echoTimeoutMs?: number
  flushMs?: number
  cancelGraceMs?: number
  backgroundStartupMs?: number
}

export function createCommandId(): string {
  return `cmd_${randomBytes(24).toString('hex')}`
}

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms)
    t.unref?.()
  })

/** 编译 wait_for：最长 500 字，编译失败报 INVALID_ARGUMENT；用 m 标志，^ $ 按行匹配 */
export function compileWaitPattern(src: unknown): RegExp | undefined {
  if (src === undefined || src === null) return undefined
  if (typeof src !== 'string') throw new CommandError('INVALID_ARGUMENT', 'wait_for 必须是正则表达式字符串')
  if (src.length > MAX_WAIT_PATTERN_CHARS) throw new CommandError('INVALID_ARGUMENT', `wait_for 最长 ${MAX_WAIT_PATTERN_CHARS} 字`)
  try {
    return new RegExp(src, 'm')
  } catch (e) {
    throw new CommandError('INVALID_ARGUMENT', `wait_for 不是合法的正则表达式：${e instanceof Error ? e.message : String(e)}`)
  }
}

function clamp(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def
  return Math.min(max, Math.max(min, n))
}

export class CommandRunner {
  private readonly slots = new Map<string, Slot>()
  private readonly states = new Map<string, CommandState>()
  private readonly records = new Map<string, CommandRecord[]>()
  private slotSeq = 0
  /** owner → 正在创建中的终端数（并发上限要算上，否则同时来的调用都能挤过去） */
  private readonly pending = new Map<string, number>()
  private disposed = false
  private readonly platform: NodeJS.Platform
  /** wait_for 的正则在这里跑（worker 线程，超时就杀），不在主进程里回溯 */
  private readonly regex = new RegexSandbox()

  constructor(private readonly opts: CommandRunnerOptions = {}) {
    this.platform = opts.platform ?? process.platform
  }

  private get maxIdle(): number {
    return this.opts.maxIdleTerminals ?? MAX_IDLE_TERMINALS
  }

  /** 调试 / 测试用：当前终端数 */
  terminalCount(owner?: string): { total: number; idle: number } {
    const list = [...this.slots.values()].filter((s) => !s.closed && (!owner || s.owner === owner))
    return { total: list.length, idle: list.filter((s) => !s.busy).length }
  }

  async run(owner: string, workspaceRoot: string, input: RunCommandInput, meta: CommandRunMeta = {}): Promise<CommandSnapshot> {
    const { command, explicitCwd, shell, env, pwshExe } = this.validateRun(workspaceRoot, input)
    this.assertFence(owner, explicitCwd, [command, ...Object.values(env ?? {})])
    const background = input.background === true
    const timeoutMs = clamp(input.timeout_ms, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const maxBytes = clamp(input.max_output_bytes, DEFAULT_OUTPUT_BYTES, 1, MAX_OUTPUT_BYTES)

    const slot = await this.acquireSlot(owner, explicitCwd, workspaceRoot)
    const id = createCommandId()
    let resolveDone!: () => void
    const done = new Promise<void>((r) => (resolveDone = r))
    const state: CommandState = {
      id,
      owner,
      command,
      cwd: slot.term.currentCwd,
      workspaceRoot,
      meta,
      audited: false,
      background,
      detached: false,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      slotId: slot.id,
      shell,
      output: new OutputBuffer(this.opts.maxCapturedBytes ?? MAX_CAPTURED_OUTPUT_BYTES),
      ansiTail: '',
      cancelRequested: false,
      done,
      resolveDone,
      waiters: new Set()
    }
    this.states.set(id, state)
    this.notifyChange()
    let execCommand = command
    try {
      const tempDir = this.opts.tempDir ?? os.tmpdir()
      if (shell === 'powershell') {
        // .ps1 里设 env；外面一层 .sh 只负责打开始标记、调 PowerShell，在子 shell 里跑，不碰复用的终端
        state.tempPs1Path = writeTempPowerShellScript(tempDir, id, command, env)
        const invoke = powershellInvocation(pwshExe!, state.tempPs1Path, this.platform)
        state.tempScriptPath = writeTempScript(tempDir, id, invoke, slot.term.scriptStartMarkerStatement())
        execCommand = tempScriptCommand(state.tempScriptPath, this.platform)
      } else if (env || needsScriptBridge(command)) {
        // 有 env 时一律走临时脚本（子 shell），export 不会留在复用的终端里
        state.tempScriptPath = writeTempScript(tempDir, id, `${bashEnvPrefix(env)}${command}`, slot.term.scriptStartMarkerStatement())
        execCommand = tempScriptCommand(state.tempScriptPath, this.platform)
      }
      slot.term.run(
        execCommand,
        (text) => this.appendOutput(state, text),
        (exitCode, pipes, info) => this.finishState(state, slot, exitCode, pipes, info.terminated)
      )
    } catch (e) {
      this.states.delete(id)
      this.removeTempScript(state)
      this.closeSlot(slot)
      this.notifyChange()
      throw e
    }

    const waitMs = background ? Math.min(timeoutMs, this.opts.backgroundStartupMs ?? BACKGROUND_STARTUP_MS) : timeoutMs
    await Promise.race([done, sleep(waitMs)])
    if (state.status === 'running') state.detached = true
    return this.snapshot(state, 0, maxBytes)
  }

  /** 最近完成的命令，按开始时间倒序；只返回这个 agent 自己的记录。 */
  recentRecords(agentId: string, opts: { limit?: number; since?: number } = {}): CommandRecord[] {
    const limit = clamp(opts.limit, DEFAULT_COMMAND_RECORD_LIMIT, 1, MAX_COMMAND_RECORDS_PER_AGENT)
    const since = typeof opts.since === 'number' && Number.isFinite(opts.since) ? opts.since : undefined
    return (this.records.get(agentId) ?? [])
      .filter((r) => since === undefined || r.startedAt >= since)
      .slice()
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map((r) => ({ ...r }))
  }

  /**
   * 读输出；带 wait_ms / wait_for 时先等：新输出匹配 wait_for、命令结束、超时，满足任一就返回。
   * 只给 wait_ms 不给 wait_for 时，有新输出或命令结束就返回。
   * 命令被取消、全部停下、身份被释放、调用方断开（signal）都会马上叫醒等待，不会挂住
   */
  async getOutput(owner: string, commandId: string, optsOrOffset: GetOutputOptions | number = {}, legacyMaxBytes?: number): Promise<CommandSnapshot> {
    // 兼容老的 (offset, maxBytes) 位置参数
    const opts: GetOutputOptions = typeof optsOrOffset === 'number' ? { offset: optsOrOffset, max_bytes: legacyMaxBytes } : optsOrOffset
    const state = this.requireState(owner, commandId)
    const offset = clamp(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    const maxBytes = clamp(opts.max_bytes, DEFAULT_OUTPUT_BYTES, 1, MAX_OUTPUT_BYTES)
    const waitMs = clamp(opts.wait_ms, 0, 0, MAX_TIMEOUT_MS)
    const pattern = compileWaitPattern(opts.wait_for)
    const waiting = waitMs > 0 || opts.wait_for !== undefined
    if (!waiting) return this.snapshot(state, offset, maxBytes)

    type Outcome = { result: WaitResult; matched?: string }
    /**
     * 检查一次返回条件；都不满足时返回 undefined。
     * wait_for 是 AI 给的正则，可能灾难性回溯：不在主进程里跑，交给 RegexSandbox（worker 线程，超时就杀），
     * 超时当成参数错误报回去，主进程始终不卡
     */
    const check = async (): Promise<Outcome | undefined> => {
      if (pattern) {
        const total = state.output.totalBytes
        const from = Math.max(offset, state.output.droppedBytes, total - WAIT_MATCH_WINDOW_BYTES)
        if (total > from) {
          const r = await this.regex.exec(pattern.source, pattern.flags, state.output.read(from, WAIT_MATCH_WINDOW_BYTES).text)
          if ('timedOut' in r) throw new CommandError('INVALID_ARGUMENT', `wait_for 正则在 ${REGEX_BUDGET_MS} 毫秒内没跑完（多半是 (a+)+ 这类嵌套量词导致的回溯爆炸），请换成更简单的写法或直接写要等的文字`)
          if ('error' in r) throw new CommandError('INVALID_ARGUMENT', `wait_for 匹配出错：${r.error}`)
          if (r.match !== null) return { result: 'matched', matched: r.match.slice(0, MAX_MATCHED_TEXT_CHARS) }
        }
      }
      if (state.status !== 'running' || state.cancelRequested) return { result: 'exited' }
      if (!pattern && state.output.totalBytes > offset) return { result: 'new_output' }
      return undefined
    }

    let outcome: Outcome | undefined
    if (waitMs <= 0 || opts.signal?.aborted || this.disposed) outcome = await check()
    else {
      // 先挂上 waiter 再做第一次检查：检查是异步的，期间到的输出也要能叫醒
      outcome = await new Promise<Outcome>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let done = false
        // 输出一块一块到，每块都 wake 一次：同时只跑一个检查，期间又来的合并成跑完后再检查一次，两次检查至少隔 100ms
        let running = false
        let again = false
        let lastAt = 0
        const finish = (o: Outcome) => {
          if (done) return
          done = true
          if (timer) clearTimeout(timer)
          state.waiters.delete(wake)
          opts.signal?.removeEventListener('abort', onAbort)
          resolve(o)
        }
        const fail = (e: unknown) => {
          if (done) return
          done = true
          if (timer) clearTimeout(timer)
          state.waiters.delete(wake)
          opts.signal?.removeEventListener('abort', onAbort)
          reject(e)
        }
        const runCheck = async (): Promise<void> => {
          if (done) return
          if (running) {
            again = true
            return
          }
          running = true
          try {
            const gap = pattern ? 100 - (Date.now() - lastAt) : 0
            if (gap > 0) await sleep(gap)
            lastAt = Date.now()
            const o = await check()
            if (o) finish(o)
            // 记录被丢弃（releaseOwner / dispose）后不会再有输出了
            else if (!this.states.has(state.id) || this.disposed) finish({ result: 'exited' })
          } catch (e) {
            fail(e)
          } finally {
            running = false
            if (again && !done) {
              again = false
              void runCheck()
            }
          }
        }
        const wake = () => void runCheck()
        const settleWith = (fallback: Outcome) => {
          check().then((o) => finish(o ?? fallback), fail)
        }
        const onAbort = () => settleWith({ result: 'timeout' })
        timer = setTimeout(() => settleWith({ result: 'timeout' }), waitMs)
        timer.unref?.()
        state.waiters.add(wake)
        opts.signal?.addEventListener('abort', onAbort, { once: true })
        void runCheck()
      })
    }
    outcome ??= { result: 'timeout' }
    const snap = this.snapshot(state, offset, maxBytes)
    snap.wait_result = outcome.result
    if (outcome.matched !== undefined) snap.matched_text = outcome.matched
    return snap
  }

  /** 调用者自己的命令，最新的排前面；看不到别人的 */
  listCommands(owner: string, opts: { status?: 'running' | 'all'; limit?: number } = {}): { commands: CommandListItem[]; total: number } {
    const status = opts.status ?? 'all'
    if (status !== 'running' && status !== 'all') throw new CommandError('INVALID_ARGUMENT', "status 只能是 'running' 或 'all'")
    const limit = clamp(opts.limit, 20, 1, 100)
    const now = Date.now()
    // Map 保持插入顺序，同一毫秒发起的按插入顺序倒排
    const mine = [...this.states.values()]
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.owner === owner && (status === 'all' || s.status === 'running'))
      .sort((a, b) => b.s.startedAt - a.s.startedAt || b.i - a.i)
      .map(({ s }) => s)
    const commands = mine.slice(0, limit).map((s) => ({
      command_id: s.id,
      command: s.command.slice(0, LIST_COMMAND_CHARS),
      cwd: s.cwd,
      shell: s.shell,
      status: s.status,
      exit_code: s.exitCode,
      started_at: new Date(s.startedAt).toISOString(),
      duration_ms: (s.endedAt ?? now) - s.startedAt,
      background: s.background,
      output_bytes: s.output.totalBytes
    }))
    return { commands, total: mine.length }
  }

  async sendInput(owner: string, commandId: string, input: string, appendNewline = true): Promise<{ command_id: string; bytes_sent: number; status: CommandStatus }> {
    const { state, slot } = this.validateInput(owner, commandId, input)
    const data = appendNewline ? `${input}\r` : input
    slot.term.write(data)
    return { command_id: state.id, bytes_sent: Buffer.byteLength(data, 'utf8'), status: state.status }
  }

  /**
   * 只校验不执行：命令文本、cwd 会被 run 拒绝时抛同样的错。不占终端、不建记录、不算并发上限。
   * 原来是给审批前预检用的，审批去掉后只有测试在用
   */
  precheckRun(workspaceRoot: string, input: RunCommandInput): void {
    this.validateRun(workspaceRoot, input)
  }

  /** 只校验不发送：命令不存在、不属于这个身份、已经结束或输入里有受保护名字时抛和 sendInput 同样的错（现在只有测试在用） */
  precheckInput(owner: string, commandId: string, input: string): void {
    this.validateInput(owner, commandId, input)
  }

  /** 先 Ctrl-C；宽限期后还在跑且 force!==false，就强制结束整棵进程树并关掉这个终端 */
  async cancel(owner: string, commandId: string, force = true): Promise<CommandSnapshot & { interrupted: boolean; forced: boolean; already_finished: boolean }> {
    const state = this.requireState(owner, commandId)
    if (state.status !== 'running') {
      return { ...this.snapshot(state, 0, DEFAULT_OUTPUT_BYTES), interrupted: false, forced: false, already_finished: true }
    }
    state.cancelRequested = true
    this.wakeWaiters(state)
    const slot = this.slots.get(state.slotId)
    slot?.term.interrupt()
    await Promise.race([state.done, sleep(this.opts.cancelGraceMs ?? CANCEL_GRACE_MS)])
    let forced = false
    if (state.status === 'running' && force) {
      forced = true
      if (slot) this.closeSlot(slot)
      await Promise.race([state.done, sleep(FORCE_SETTLE_MS)])
      if (state.status === 'running') this.finishState(state, undefined, null, undefined, true)
    }
    const snap = this.snapshot(state, 0, DEFAULT_OUTPUT_BYTES)
    if (state.status === 'running') snap.message = '已发送 Ctrl-C，命令还在运行；可以用 force=true 再取消一次强制结束'
    return { ...snap, interrupted: true, forced, already_finished: false }
  }

  /** 身份被吊销 / 删除 / 换令牌时：关掉它的全部终端，丢弃它的命令记录 */
  releaseOwner(owner: string): void {
    for (const slot of [...this.slots.values()]) {
      if (slot.owner === owner) this.closeSlot(slot)
    }
    for (const state of [...this.states.values()]) {
      if (state.owner !== owner) continue
      if (state.status === 'running') {
        state.cancelRequested = true
        this.finishState(state, undefined, null, undefined, true)
      }
      this.removeTempScript(state)
      this.states.delete(state.id)
      this.wakeWaiters(state)
    }
    this.notifyChange()
  }

  // ----- 用户（工作台界面）：能看、能停任何 AI 的命令 -----

  /** 所有 AI 的命令：运行中的全部排前面，其余按开始时间倒排，已结束的最多 MAX_USER_LIST_COMMANDS 条 */
  listAll(): { commands: UserCommandItem[]; running: number; total: number } {
    const now = Date.now()
    const all = [...this.states.values()].map((s, i) => ({ s, i }))
    const byNewest = (a: { s: CommandState; i: number }, b: { s: CommandState; i: number }) => b.s.startedAt - a.s.startedAt || b.i - a.i
    const running = all.filter(({ s }) => s.status === 'running').sort(byNewest)
    const finished = all.filter(({ s }) => s.status !== 'running').sort(byNewest)
    const commands = [...running, ...finished.slice(0, MAX_USER_LIST_COMMANDS)].map(({ s }) => ({
      owner: s.owner,
      command_id: s.id,
      command: s.command.slice(0, LIST_COMMAND_CHARS),
      cwd: s.cwd,
      shell: s.shell,
      status: s.status,
      exit_code: s.exitCode,
      started_at: new Date(s.startedAt).toISOString(),
      duration_ms: (s.endedAt ?? now) - s.startedAt,
      background: s.background,
      output_bytes: s.output.totalBytes
    }))
    return { commands, running: running.length, total: all.length }
  }

  /** 用户读任何 AI 的命令输出（不等待）；offset 是绝对字节偏移 */
  getOutputForUser(commandId: string, offset = 0, maxBytes = USER_OUTPUT_BYTES): UserCommandOutput {
    const state = this.states.get(commandId)
    if (!state) throw new CommandError('COMMAND_NOT_FOUND', '找不到这条命令（可能已过期）')
    const snap = this.snapshot(state, clamp(offset, 0, 0, Number.MAX_SAFE_INTEGER), clamp(maxBytes, USER_OUTPUT_BYTES, 1, MAX_CAPTURED_OUTPUT_BYTES))
    delete snap.message
    return { ...snap, owner: state.owner, command: state.command, shell: state.shell, started_at: new Date(state.startedAt).toISOString() }
  }

  /** 用户取消任何 AI 的命令：和 cancel_command force=true 一样（Ctrl-C，宽限期后强制结束） */
  async cancelForUser(commandId: string): Promise<CommandSnapshot & { owner: string; interrupted: boolean; forced: boolean; already_finished: boolean }> {
    const state = this.states.get(commandId)
    if (!state) throw new CommandError('COMMAND_NOT_FOUND', '找不到这条命令（可能已过期）')
    const r = await this.cancel(state.owner, commandId, true)
    return { ...r, owner: state.owner }
  }

  dispose(): void {
    if (this.disposed) return
    const owners = new Set([...this.slots.values()].map((s) => s.owner).concat([...this.states.values()].map((s) => s.owner)))
    for (const owner of owners) this.releaseOwner(owner)
    this.regex.dispose()
    this.disposed = true
  }

  /**
   * 「全部停下」：取消所有身份正在跑的命令（先 Ctrl-C，宽限期后强制结束），
   * 命令记录保留，AI 之后仍能用 get_command_output 读到结束前的输出。返回取消了几条
   */
  async cancelAllRunning(): Promise<number> {
    const running = [...this.states.values()].filter((s) => s.status === 'running')
    await Promise.all(running.map((s) => this.cancel(s.owner, s.id, true).catch(() => undefined)))
    return running.length
  }

  // ----- 内部 -----

  /** run 和 precheckRun 共用的参数校验：返回命令文本和解析后的 cwd（没传 cwd 时 undefined） */
  private validateRun(
    workspaceRoot: string,
    input: RunCommandInput
  ): { command: string; explicitCwd: string | undefined; shell: CommandShell; env: Record<string, string> | undefined; pwshExe?: string } {
    if (this.disposed) throw new CommandError('UNAVAILABLE', '命令执行已关闭')
    const command = typeof input.command === 'string' ? input.command : ''
    if (!command.trim()) throw new CommandError('INVALID_ARGUMENT', 'command 不能为空')
    const shell = input.shell ?? 'bash'
    if (shell !== 'bash' && shell !== 'powershell') throw new CommandError('INVALID_ARGUMENT', "shell 只能是 'bash' 或 'powershell'")
    const env = validateCommandEnv(input.env)
    // 命令正文（bash 和 PowerShell 脚本一样）、env 的值都要查数据目录
    this.assertCommandAllowed(command)
    if (env) for (const v of Object.values(env)) this.assertCommandAllowed(v)
    let pwshExe: string | undefined
    if (shell === 'powershell') {
      pwshExe = (this.opts.findPowerShell ?? (() => findPowerShell(this.platform)))()
      if (!pwshExe) {
        throw new CommandError(
          'SHELL_NOT_FOUND',
          this.platform === 'win32'
            ? '找不到 PowerShell（pwsh.exe 和 powershell.exe 都没找到），请改用 shell=bash'
            : '这台电脑上找不到 pwsh（PowerShell 7）。非 Windows 平台需要先安装 PowerShell，或改用 shell=bash'
        )
      }
    }
    const explicitCwd = input.cwd && input.cwd.trim() ? resolveCommandCwd(workspaceRoot, input.cwd, this.platform) : undefined
    if (explicitCwd) {
      let isDir = false
      try {
        isDir = fs.statSync(explicitCwd).isDirectory()
      } catch {
        isDir = false
      }
      if (!isDir) throw new CommandError('CWD_NOT_FOUND', `工作目录不存在或不是目录：${explicitCwd}`)
      const reason = protectedCwdReason(explicitCwd, this.opts.protectedDirs, this.platform)
      if (reason) throw new CommandError('PROTECTED', `${reason}，不能在这里执行命令：${explicitCwd}`)
    }
    return { command, explicitCwd, shell, env, pwshExe }
  }

  /** sendInput 和 precheckInput 共用的校验 */
  private validateInput(owner: string, commandId: string, input: string): { state: CommandState; slot: Slot } {
    const state = this.requireState(owner, commandId)
    if (state.status !== 'running') throw new CommandError('COMMAND_NOT_RUNNING', `命令已经结束（${state.status}），不能再写输入`)
    const slot = this.slots.get(state.slotId)
    if (!slot || slot.closed) throw new CommandError('COMMAND_NOT_RUNNING', '命令所在的终端已经关闭')
    this.assertCommandAllowed(typeof input === 'string' ? input : '')
    this.assertFence(owner, undefined, [typeof input === 'string' ? input : ''])
    return { state, slot }
  }

  private assertCommandAllowed(text: string): void {
    const hit = protectedCommandHit(text, this.opts.protectedDirs, this.platform)
    if (hit) {
      throw new CommandError(
        'PROTECTED',
        `命令里提到了工作台的数据目录（${hit}）：里面存着令牌和配置，不允许用命令读写`
      )
    }
  }

  /** cwd 在这个身份不能进的工作区里，或命令文本提到了那里的路径，就拒绝 */
  private assertFence(owner: string, cwd: string | undefined, texts: string[]): void {
    const fence = this.opts.fenceFor?.(owner)
    if (!fence) return
    if (cwd) {
      const name = fence.blocked(realpathOrSelf(cwd)) ?? fence.blocked(cwd)
      if (name) throw new CommandError('WORKSPACE_FORBIDDEN', `工作目录在工作区「${name}」里，这个工作区没有对你开放：${cwd}`)
    }
    const roots = fence.roots()
    if (!roots.length) return
    for (const t of texts) {
      const hit = protectedCommandHit(t, roots.map((f) => f.root), this.platform)
      if (hit) {
        const name = roots.find((f) => f.root === hit)?.name ?? hit
        throw new CommandError('WORKSPACE_FORBIDDEN', `命令里提到了工作区「${name}」的目录，这个工作区没有对你开放`)
      }
    }
  }

  /** 这个终端现在的目录是不是在这个身份不能进的工作区里 */
  private fencedCwd(owner: string, cwd: string): boolean {
    const fence = this.opts.fenceFor?.(owner)
    return !!fence && !!(fence.blocked(realpathOrSelf(cwd)) ?? fence.blocked(cwd))
  }

  private runningCount(owner?: string): number {
    return [...this.slots.values()].filter((s) => !s.closed && s.busy && (!owner || s.owner === owner)).length
  }

  private requireState(owner: string, commandId: string): CommandState {
    const id = typeof commandId === 'string' ? commandId.trim() : ''
    const state = COMMAND_ID_RE.test(id) ? this.states.get(id) : undefined
    // 不存在和不属于你返回同一个错误，不泄露别人的命令是否存在
    if (!state || state.owner !== owner) throw new CommandError('COMMAND_NOT_FOUND', '找不到这个 command_id（可能已过期，或不是你发起的命令）')
    return state
  }

  /** 照 ShunCode：给了 cwd 就找 cwd 相同的空闲终端；没给就用最近用过的空闲终端（接着它的 cwd） */
  private async acquireSlot(owner: string, cwd: string | undefined, root: string): Promise<Slot> {
    this.expireIdleSlots()
    const idle = [...this.slots.values()]
      .filter((s) => s.owner === owner && !s.busy && !s.closed && s.term.isReady)
      .sort((a, b) => b.lastUsed - a.lastUsed)
    const maxRunning = this.opts.maxRunningPerOwner ?? MAX_RUNNING_PER_OWNER
    const ownerRunning = this.runningCount(owner) + (this.pending.get(owner) ?? 0)
    if (ownerRunning >= maxRunning) {
      throw new CommandError('TOO_MANY_COMMANDS', `你同时运行的命令已经有 ${maxRunning} 条（上限），请等其中一条结束，或用 cancel_command 取消`)
    }
    // 没给 cwd 时接着用的终端，如果之前 cd 进了受保护目录就不再复用
    const usable = idle.filter((s) => !protectedCwdReason(s.term.currentCwd, this.opts.protectedDirs, this.platform) && !this.fencedCwd(owner, s.term.currentCwd))
    const reuse = cwd ? usable.find((s) => sameCwd(s.term.currentCwd, cwd, this.platform)) : usable[0]
    if (reuse) {
      this.markBusy(reuse)
      return reuse
    }
    this.reclaimForNewSlot()
    this.pending.set(owner, (this.pending.get(owner) ?? 0) + 1)
    let slot: Slot
    try {
      slot = await this.createSlot(owner, cwd ?? root)
    } finally {
      const n = (this.pending.get(owner) ?? 1) - 1
      if (n > 0) this.pending.set(owner, n)
      else this.pending.delete(owner)
    }
    this.markBusy(slot)
    return slot
  }

  private markBusy(slot: Slot): void {
    if (slot.idleTimer) clearTimeout(slot.idleTimer)
    slot.idleTimer = undefined
    slot.busy = true
    slot.lastUsed = Date.now()
  }

  /** 总数到上限时回收最久没用的空闲终端；全都在忙就报错 */
  private reclaimForNewSlot(): void {
    const max = this.opts.maxSlots ?? MAX_TERMINAL_SLOTS
    const live = [...this.slots.values()].filter((s) => !s.closed)
    const pendingTotal = [...this.pending.values()].reduce((a, b) => a + b, 0)
    if (live.length + pendingTotal < max) return
    const victim = live.filter((s) => !s.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0]
    if (!victim) throw new CommandError('TOO_MANY_COMMANDS', `同时运行的命令太多（最多 ${max} 个终端），请等其他命令结束或用 cancel_command 取消`)
    this.closeSlot(victim)
  }

  private async createSlot(owner: string, cwd: string): Promise<Slot> {
    const pty = await (this.opts.loadPty ?? defaultLoadPty)()
    const shell = (this.opts.shellSpec ?? (() => managedShellSpec('x', this.platform, process.env, this.opts.extraEnvAllow)))()
    const term = new ManagedTerminal({
      pty,
      shell,
      cwd,
      platform: this.platform,
      killTree: this.opts.killTree,
      readyTimeoutMs: this.opts.readyTimeoutMs,
      echoTimeoutMs: this.opts.echoTimeoutMs,
      flushMs: this.opts.flushMs
    })
    const slot: Slot = { id: `t${++this.slotSeq}`, owner, term, busy: false, lastUsed: Date.now(), closed: false }
    this.slots.set(slot.id, slot)
    term.onClose = () => this.onSlotClosed(slot)
    try {
      await term.start()
    } catch (e) {
      this.closeSlot(slot)
      throw e
    }
    return slot
  }

  private onSlotClosed(slot: Slot): void {
    slot.closed = true
    if (slot.idleTimer) clearTimeout(slot.idleTimer)
    slot.idleTimer = undefined
    this.slots.delete(slot.id)
  }

  private closeSlot(slot: Slot): void {
    if (slot.closed) return
    slot.closed = true
    if (slot.idleTimer) clearTimeout(slot.idleTimer)
    slot.idleTimer = undefined
    this.slots.delete(slot.id)
    slot.term.dispose()
  }

  private expireIdleSlots(): void {
    const ttl = this.opts.idleTtlMs ?? TERMINAL_IDLE_TTL_MS
    const now = Date.now()
    for (const slot of [...this.slots.values()]) {
      if (!slot.busy && !slot.closed && now - slot.lastUsed >= ttl) this.closeSlot(slot)
    }
  }

  /** 命令结束后终端回到空闲；同一身份超过上限就关掉最久没用的 */
  private releaseSlot(slot: Slot): void {
    if (slot.closed) return
    slot.busy = false
    slot.lastUsed = Date.now()
    if (!slot.term.isReady) {
      this.closeSlot(slot)
      return
    }
    const ttl = this.opts.idleTtlMs ?? TERMINAL_IDLE_TTL_MS
    slot.idleTimer = setTimeout(() => {
      if (!slot.busy) this.closeSlot(slot)
    }, ttl)
    slot.idleTimer.unref?.()
    const idle = [...this.slots.values()].filter((s) => s.owner === slot.owner && !s.busy && !s.closed).sort((a, b) => a.lastUsed - b.lastUsed)
    while (idle.length > this.maxIdle) this.closeSlot(idle.shift()!)
  }

  private appendOutput(state: CommandState, raw: string): void {
    const [clean, tail] = stripAnsi(state.ansiTail + raw)
    state.ansiTail = tail
    if (clean) {
      state.output.append(clean)
      this.wakeWaiters(state)
      this.notifyChange()
    }
  }

  private notifyChange(): void {
    try {
      this.opts.onChange?.()
    } catch {
      // 界面刷新出错不影响命令
    }
  }

  private wakeWaiters(state: CommandState): void {
    for (const w of [...state.waiters]) {
      try {
        w()
      } catch {
        // 单个等待者出错不影响其他
      }
    }
  }

  private finishState(state: CommandState, slot: Slot | undefined, exitCode: number | null, pipes: number[] | undefined, terminated: boolean): void {
    if (state.status !== 'running') return
    // 剩下的尾巴只可能是半个 ANSI 序列或一个 \r，都不是正文
    state.ansiTail = ''
    state.status = state.cancelRequested ? 'cancelled' : terminated ? 'terminated' : 'completed'
    state.exitCode = exitCode
    state.pipelineExitCodes = pipes
    state.endedAt = Date.now()
    this.removeTempScript(state)
    if (slot) {
      if (!slot.closed && slot.term.isReady && !terminated) state.cwd = slot.term.currentCwd
      this.releaseSlot(slot)
    }
    this.emitAudit(state)
    this.recordCommand(state)
    state.resolveDone()
    this.wakeWaiters(state)
    this.pruneStates(state.owner)
    this.notifyChange()
  }

  private recordCommand(state: CommandState): void {
    const endedAt = state.endedAt ?? Date.now()
    const total = state.output.totalBytes
    const tail = total > 0 ? state.output.read(Math.max(0, total - MAX_COMMAND_RECORD_OUTPUT_CHARS * 4), MAX_COMMAND_RECORD_OUTPUT_CHARS * 4).text.slice(-MAX_COMMAND_RECORD_OUTPUT_CHARS) : ''
    const record: CommandRecord = {
      agentId: state.owner,
      command: state.command,
      cwd: state.cwd,
      exitCode: state.exitCode,
      startedAt: state.startedAt,
      endedAt,
      durationMs: endedAt - state.startedAt,
      output: tail
    }
    const list = this.records.get(state.owner) ?? []
    list.push(record)
    list.sort((a, b) => b.startedAt - a.startedAt)
    if (list.length > MAX_COMMAND_RECORDS_PER_AGENT) list.length = MAX_COMMAND_RECORDS_PER_AGENT
    this.records.set(state.owner, list)
  }

  private emitAudit(state: CommandState): void {
    if (state.audited || !this.opts.onAudit) return
    state.audited = true
    const endedAt = state.endedAt ?? Date.now()
    const rec: CommandAuditRecord = {
      command_id: state.id,
      owner: state.owner,
      ...(state.meta.workspaceId ? { workspace_id: state.meta.workspaceId } : {}),
      workspace_root: state.workspaceRoot,
      cwd: state.cwd,
      cwd_outside_workspace: !isPathInside(state.cwd, state.workspaceRoot, this.platform),
      command: state.command.length > MAX_AUDIT_COMMAND_CHARS ? state.command.slice(0, MAX_AUDIT_COMMAND_CHARS) : state.command,
      command_truncated: state.command.length > MAX_AUDIT_COMMAND_CHARS,
      approval: state.meta.approval ?? 'not_required',
      status: state.status,
      exit_code: state.exitCode,
      started_at: state.startedAt,
      ended_at: endedAt,
      duration_ms: endedAt - state.startedAt,
      output_bytes: state.output.totalBytes,
      background: state.background,
      unattended: state.detached && state.waiters.size === 0
    }
    try {
      this.opts.onAudit(rec)
    } catch {
      // 审计写不进去不影响命令本身
    }
  }

  private removeTempScript(state: CommandState): void {
    for (const p of [state.tempScriptPath, state.tempPs1Path]) {
      if (!p) continue
      try {
        fs.rmSync(p, { force: true })
      } catch {
        // 删不掉就留在临时目录
      }
    }
    state.tempScriptPath = undefined
    state.tempPs1Path = undefined
  }

  private pruneStates(owner: string): void {
    const max = this.opts.maxFinishedPerOwner ?? MAX_FINISHED_COMMANDS_PER_OWNER
    const finished = [...this.states.values()].filter((s) => s.owner === owner && s.status !== 'running').sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
    while (finished.length > max) this.states.delete(finished.shift()!.id)
  }

  private snapshot(state: CommandState, offset: number, maxBytes: number): CommandSnapshot {
    const slice = state.output.read(offset, maxBytes)
    const snap: CommandSnapshot = {
      command_id: state.id,
      status: state.status,
      exit_code: state.exitCode,
      ...(state.pipelineExitCodes && state.pipelineExitCodes.length > 1 ? { pipeline_exit_codes: state.pipelineExitCodes } : {}),
      cwd: state.cwd,
      cwd_outside_workspace: !isPathInside(state.cwd, state.workspaceRoot, this.platform),
      sandbox: false,
      background: state.background,
      elapsed_ms: (state.endedAt ?? Date.now()) - state.startedAt,
      output: slice.text,
      offset: slice.offset,
      next_offset: slice.nextOffset,
      output_lost: slice.lost,
      has_more: slice.hasMore,
      total_output_bytes: slice.totalBytes
    }
    if (state.status === 'running') {
      snap.message = '命令仍在运行（没有被杀掉）。用 get_command_output 带 offset=next_offset 读后续输出，send_command_input 写输入，cancel_command 取消'
    } else if (slice.hasMore) {
      snap.message = '输出没读完，用 get_command_output 带 offset=next_offset 继续读'
    }
    if (slice.lost) snap.message = `${snap.message ? snap.message + '；' : ''}请求的偏移之前有 ${state.output.droppedBytes} 字节输出因超过 2 MB 上限已被丢弃`
    return snap
  }
}

async function defaultLoadPty(): Promise<PtyModule> {
  const { loadPty } = await import('./terminal')
  return loadPty()
}
