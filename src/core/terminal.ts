import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IDisposable, IPty } from 'node-pty'
import type { TerminalInfo } from './types'

/**
 * 内嵌终端（用户自己的终端，不对 AI 开放）。不依赖 Electron，主进程创建并接 IPC。
 *
 * - node-pty 是原生模块，按需动态加载：加载失败只让 create 报错，主进程照常运行。
 * - 输出攒 16 ms 再发给界面，避免 `npm install` 这类大量输出把 IPC 塞满。
 * - 每个终端留最近 200 KB 已发出的输出，界面刷新后用它恢复屏幕。
 */

/** 输出合并的间隔 */
const FLUSH_MS = 16
/** 每个终端保留的输出（按字符数算，近似 200 KB） */
const MAX_BUFFER = 200 * 1024
/** 防止误操作开出一堆进程 */
const MAX_TERMINALS = 20
/** 单次写入的上限（粘贴大段文字也够用） */
const MAX_WRITE = 8 * 1024 * 1024

export interface TerminalWorkspace {
  id: string
  name: string
  root: string
}

export interface TerminalManagerOptions {
  /** 按 id 找工作区；不传 id 时返回当前工作区；找不到返回 undefined */
  findWorkspace: (id?: string) => TerminalWorkspace | undefined
  onData: (id: string, data: string) => void
  onExit: (id: string, exitCode: number) => void
}

export interface TerminalCreateOptions {
  workspaceId?: string
  /** 绝对路径，或相对工作区根目录（文件树「在终端打开」用） */
  cwd?: string
  shell?: string
  cols?: number
  rows?: number
}

type PtyModule = typeof import('node-pty')

let ptyLoad: Promise<PtyModule> | undefined

/** 原生模块加载失败是永久性的（没装好或 ABI 不兼容），缓存结果，不反复尝试 */
export function loadPty(): Promise<PtyModule> {
  ptyLoad ??= import('node-pty').then((m) => {
    // CommonJS 模块经 ESM 动态导入时，导出可能挂在 default 上
    const mod = ((m as unknown as { default?: PtyModule }).default ?? m) as PtyModule
    if (typeof mod.spawn !== 'function') throw new Error('模块里没有 spawn')
    return mod
  })
  return ptyLoad
}

let defaultShellCache: string | undefined

/** Windows：PATH 里有 pwsh.exe 用它，否则 powershell.exe；其他系统：$SHELL 或 bash */
function defaultShell(): string {
  if (defaultShellCache) return defaultShellCache
  if (process.platform === 'win32') {
    // Windows 上环境变量名不区分大小写，常见的是 Path
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path')
    const dirs = (key ? process.env[key] ?? '' : '').split(path.delimiter).filter(Boolean)
    const pwsh = dirs.map((d) => path.join(d.replace(/^"|"$/g, ''), 'pwsh.exe')).find((p) => fs.existsSync(p))
    defaultShellCache = pwsh ?? 'powershell.exe'
  } else {
    defaultShellCache = process.env.SHELL || '/bin/bash'
  }
  return defaultShellCache
}

function shellArgs(shell: string): string[] {
  const base = path.basename(shell).toLowerCase()
  // PowerShell 默认先打一段版权横幅，终端里没用
  if (base === 'pwsh.exe' || base === 'pwsh' || base === 'powershell.exe' || base === 'powershell') return ['-NoLogo']
  // macOS 的终端习惯用登录 shell，才会读 ~/.zprofile
  if (process.platform === 'darwin') return ['-l']
  return []
}

function terminalEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  // 留着它的话，在终端里运行 electron 或 code 会被当成普通 Node 进程
  delete env.ELECTRON_RUN_AS_NODE
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  return env
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function clampSize(v: unknown, fallback: number, max: number): number {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n >= 2 ? Math.min(n, max) : fallback
}

interface Term {
  info: TerminalInfo
  pty: IPty
  subs: IDisposable[]
  /** 已发给界面的输出（最近 MAX_BUFFER 字符） */
  buffer: string
  /** 还没发出去的输出 */
  pending: string
  timer?: ReturnType<typeof setTimeout>
}

export class TerminalManager {
  private readonly terms = new Map<string, Term>()

  constructor(private readonly opts: TerminalManagerOptions) {}

  /** 用户在工作台底部开的终端的 pid（AI 的 kill_process 不能结束它们） */
  pids(): number[] {
    return [...this.terms.values()].map((t) => t.info.pid).filter((p): p is number => typeof p === 'number')
  }

  async create(input: TerminalCreateOptions = {}): Promise<TerminalInfo> {
    if (this.terms.size >= MAX_TERMINALS) throw new Error(`最多同时开 ${MAX_TERMINALS} 个终端，先关掉几个`)
    let pty: PtyModule
    try {
      pty = await loadPty()
    } catch (e) {
      throw new Error(`终端组件 node-pty 加载失败（${(e as Error)?.message ?? e}）。可能没装好或和当前 Electron 版本不兼容，重新运行 npm install 试试`)
    }

    const { cwd, workspace } = this.resolveCwd(input)
    const shell = typeof input.shell === 'string' && input.shell.trim() ? input.shell.trim() : defaultShell()
    if (shell.length > 1024 || shell.includes('\0')) throw new Error('shell 路径不合法')
    const cols = clampSize(input.cols, 80, 1000)
    const rows = clampSize(input.rows, 24, 500)

    let proc: IPty
    try {
      proc = pty.spawn(shell, shellArgs(shell), { name: 'xterm-256color', cols, rows, cwd, env: terminalEnv() })
    } catch (e) {
      throw new Error(`启动 ${shell} 失败：${(e as Error)?.message ?? e}`)
    }

    const id = `t_${crypto.randomBytes(4).toString('hex')}`
    const shellName = path.basename(shell).replace(/\.exe$/i, '')
    const info: TerminalInfo = {
      id,
      title: `${shellName} · ${workspace?.name ?? (path.basename(cwd) || cwd)}`,
      cwd,
      shell,
      pid: proc.pid,
      ...(workspace ? { workspaceId: workspace.id } : {})
    }
    const t: Term = { info, pty: proc, subs: [], buffer: '', pending: '' }
    t.subs.push(
      proc.onData((data) => this.queue(t, data)),
      proc.onExit(({ exitCode }) => {
        // 先把最后一段输出发出去，界面上「已退出」才会出现在输出后面
        this.flush(t)
        t.info.exitCode = exitCode
        if (this.terms.get(id) === t) this.opts.onExit(id, exitCode)
      })
    )
    this.terms.set(id, t)
    return { ...info }
  }

  list(): TerminalInfo[] {
    return [...this.terms.values()].map((t) => ({ ...t.info }))
  }

  write(id: string, data: string): void {
    const t = this.terms.get(id)
    if (!t || t.info.exitCode !== undefined || typeof data !== 'string' || !data || data.length > MAX_WRITE) return
    try {
      t.pty.write(data)
    } catch {
      // 进程刚退出，退出事件马上会到
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terms.get(id)
    if (!t || t.info.exitCode !== undefined) return
    const c = clampSize(cols, 0, 1000)
    const r = clampSize(rows, 0, 500)
    if (!c || !r) return
    try {
      t.pty.resize(c, r)
    } catch {
      // 进程已退出时 resize 会抛错，忽略
    }
  }

  /** 关闭标签：结束进程（还在运行的话）并忘掉这个终端 */
  kill(id: string): void {
    const t = this.terms.get(id)
    if (!t) return
    this.terms.delete(id)
    this.stop(t)
  }

  /** 最近的输出（只含已经发给界面的部分，界面恢复时不会和随后到达的数据重复） */
  buffer(id: string): string {
    return this.terms.get(id)?.buffer ?? ''
  }

  /** 应用退出时调用：同步结束全部进程，不等退出事件 */
  killAll(): void {
    const all = [...this.terms.values()]
    this.terms.clear()
    for (const t of all) this.stop(t)
  }

  private resolveCwd(input: TerminalCreateOptions): { cwd: string; workspace?: TerminalWorkspace } {
    const wsId = typeof input.workspaceId === 'string' && input.workspaceId ? input.workspaceId : undefined
    const rel = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : undefined
    if (rel?.includes('\0')) throw new Error('目录不合法')
    const workspace = this.opts.findWorkspace(wsId)
    if (wsId && !workspace) throw new Error('找不到这个工作区，可能已经移出列表')

    if (wsId || rel) {
      // 明确指定了位置：目录不存在就报错，不悄悄换到别处
      const cwd = path.resolve(workspace?.root ?? os.homedir(), rel ?? '.')
      if (!isDir(cwd)) throw new Error(`目录不存在：${cwd}`)
      return { cwd, workspace }
    }
    // 默认用当前工作区；它的目录没了就退回用户主目录
    if (workspace && isDir(workspace.root)) return { cwd: path.resolve(workspace.root), workspace }
    return { cwd: os.homedir() }
  }

  private queue(t: Term, data: string): void {
    t.pending += data
    t.timer ??= setTimeout(() => this.flush(t), FLUSH_MS)
  }

  private flush(t: Term): void {
    if (t.timer) clearTimeout(t.timer)
    t.timer = undefined
    if (!t.pending) return
    const data = t.pending
    t.pending = ''
    t.buffer += data
    if (t.buffer.length > MAX_BUFFER * 1.25) {
      // 从换行处截，尽量不把半个转义序列留在开头
      const cut = t.buffer.length - MAX_BUFFER
      const nl = t.buffer.indexOf('\n', cut)
      t.buffer = t.buffer.slice(nl >= 0 && nl - cut < 4096 ? nl + 1 : cut)
    }
    if (this.terms.get(t.info.id) === t) this.opts.onData(t.info.id, data)
  }

  private stop(t: Term): void {
    if (t.timer) clearTimeout(t.timer)
    t.timer = undefined
    for (const s of t.subs) s.dispose()
    t.subs = []
    if (t.info.exitCode !== undefined) return
    try {
      t.pty.kill()
    } catch {
      // 已经退出
    }
  }
}
