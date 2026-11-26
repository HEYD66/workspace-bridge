import fs from 'node:fs'
import path from 'node:path'

/**
 * 凭据类文件名。接入的 AI 能读写它们（和它能执行的命令一致，用户 2026-11-12 决定放开）；
 * 这份清单现在只用来挡技能包里夹带凭据文件（见 skills.ts）
 */
const DENY_NAME_PATTERNS = [
  '.env', '.env.*', '*.env', '*.pem', '*.key', '*.pfx', '*.p12', '*.jks', '*.keystore',
  'id_rsa', 'id_rsa.*', 'id_dsa', 'id_dsa.*', 'id_ecdsa', 'id_ecdsa.*', 'id_ed25519', 'id_ed25519.*',
  '.npmrc', '.pypirc', '.git-credentials', '.netrc', '_netrc',
  'secrets.json', 'secrets.yml', 'secrets.yaml', 'credentials.json'
]

/** 凭据目录名，用途同上 */
const DENY_DIRS = new Set(['.git', '.ssh', '.aws', '.gnupg'])

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$|clock\$)(\..*)?$/i

const IS_WIN = process.platform === 'win32'

/**
 * 整台电脑模式下，遍历（搜索、找文件、文件清单）默认不进的目录：系统目录和缓存堆。
 * 只在遍历「经过」它们时跳过；把它们直接当搜索起点照常搜，读写单个文件也不受影响
 */
const MACHINE_SKIP_TOP_WIN = new Set([
  'windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin', 'system volume information',
  'recovery', '$winreagent', '$windows.~bt', '$windows.~ws', '$sysreset', 'perflogs', 'config.msi', 'msocache'
])
const MACHINE_SKIP_TOP_POSIX = new Set(['proc', 'sys', 'dev', 'run', 'snap', 'boot', 'lost+found', 'usr', 'var', 'private', 'system', 'library', 'cores'])
/** 任何层级都跳过：用户目录下的 AppData 里是几十万个缓存文件 */
const MACHINE_SKIP_ANY = new Set(['appdata', '$recycle.bin', 'system volume information'])

let drivesCache: { at: number; list: string[] } | null = null

/** 本机现在能访问的盘（Windows：C:/、D:/…；其他系统只有 /），缓存 30 秒 */
export function listDrives(): string[] {
  if (!IS_WIN) return ['/']
  if (drivesCache && Date.now() - drivesCache.at < 30_000) return drivesCache.list
  const list: string[] = []
  for (let c = 65; c <= 90; c++) {
    const d = `${String.fromCharCode(c)}:\\`
    try {
      if (fs.statSync(d).isDirectory()) list.push(`${String.fromCharCode(c)}:/`)
    } catch {
      // 没有这个盘，或光驱里没盘
    }
  }
  drivesCache = { at: Date.now(), list }
  return list
}

/** 是不是某个盘的根目录（C:\、/） */
export function isDriveRoot(abs: string): boolean {
  const p = path.resolve(abs)
  return path.parse(p).root === p
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp('^' + escaped + '$', 'i')
}

const DENY_NAME_RES = DENY_NAME_PATTERNS.map(globToRegExp)

export class PathError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
  }
}

/** 是不是凭据类的文件名或目录名。只给技能包检查用，文件工具不再按它拒绝 */
export function isDeniedName(name: string): boolean {
  if (DENY_DIRS.has(name.toLowerCase())) return true
  return DENY_NAME_RES.some((re) => re.test(name))
}

/** 用户自己（工作台）也不能碰的：.git 内部（hooks 能执行代码，改坏了仓库就坏了） */
export function isUserDeniedName(name: string): boolean {
  return name.toLowerCase() === '.git'
}

export interface PathGuardOptions {
  /**
   * user：工作台里用户自己操作（文件页、全局搜索）。.git 内部和应用数据目录拒绝。
   * agent（默认）：给接入的 AI 用。只拒绝应用数据目录；凭据文件、.git 内部都能读写（和它能执行的命令一致）
   */
  mode?: 'agent' | 'user'
  /**
   * 整台电脑：相对路径照旧从根目录（用户主目录）算起，
   * 另外接受本机任意盘的绝对路径（D:/xxx）。数据目录保护照常生效
   */
  machine?: boolean
  /** 按当前调用的 AI 另外拦的目录（没对它开放的工作区），见 PathFence。只给 AI 用的守卫配，工作台自己的不配 */
  fence?: PathFence
}

/**
 * 按 AI 拦目录：成员名单里没有这个 AI 的工作区，它从别的工作区（含整台电脑的绝对路径）也进不去。
 * 实现方按「现在是谁在调用」现算，路径都是真实路径（已解析链接）
 */
export interface PathFence {
  /** 这个路径被拦就返回拦住它的工作区名字，没拦返回 undefined */
  blocked(abs: string): string | undefined
  /** 现在拦着的全部目录（挪动、删除它们的上级目录前查） */
  roots(): readonly { root: string; name: string }[]
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 对已存在的部分做 realpath，不存在的部分原样拼回，防止符号链接 / junction 逃逸 */
function realpathUpTo(target: string): string {
  let cur = target
  const rest: string[] = []
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur)
      return rest.length ? path.join(real, ...rest.reverse()) : real
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return target
      rest.push(path.basename(cur))
      cur = parent
    }
  }
}

export interface ResolvedPath {
  abs: string
  /** 工作区相对路径，统一用 / 分隔，根目录为 '.'；整机模式下根目录以外的是绝对路径（D:/xxx） */
  rel: string
}

export class PathGuard {
  readonly root: string
  /** 整台电脑模式（见 PathGuardOptions.machine） */
  readonly machine: boolean
  private readonly protectedDirs: string[]
  private readonly denied: (name: string) => boolean
  private readonly fence: PathFence | undefined

  /**
   * @param root 工作区根目录
   * @param protectedDirs 额外禁止访问的目录（如应用数据目录，里面有 token）
   */
  constructor(root: string, protectedDirs: string[] = [], opts: PathGuardOptions = {}) {
    this.root = realpathUpTo(path.resolve(root))
    this.protectedDirs = protectedDirs.map((d) => realpathUpTo(path.resolve(d)))
    this.denied = opts.mode === 'user' ? isUserDeniedName : () => false
    this.machine = opts.machine === true
    this.fence = opts.fence
  }

  /** 把 AI 给的路径解析为工作区内的绝对路径，越界或命中黑名单时抛 PathError */
  resolve(input: string): ResolvedPath {
    if (typeof input !== 'string') throw new PathError('INVALID_PATH', '路径必须是字符串')
    if (input.includes('\0')) throw new PathError('INVALID_PATH', '路径包含 NUL 字符')

    let p = input.trim().replace(/\\/g, '/')
    if (this.machine && /^[a-zA-Z]:(?!\/)/.test(p)) {
      // "D:"、"D:foo" 在 Windows 上是「D 盘的当前目录」，含义不定，按盘根算
      p = `${p.slice(0, 2)}/${p.slice(2)}`
    }
    // 没有盘符的 "/foo" 视为工作区相对路径，网页 AI 常这样写；整机模式在非 Windows 上 "/foo" 就是绝对路径
    if (!/^[a-zA-Z]:/.test(p) && !(this.machine && !IS_WIN)) p = p.replace(/^\/+/, '')
    if (p === '') p = '.'

    const abs = path.resolve(this.root, p)
    // 盘符之后的冒号是 NTFS 备用数据流（file.txt:secret），一律拒绝
    if (abs.slice(2).includes(':')) throw new PathError('INVALID_PATH', '不支持带冒号的路径')
    if (this.machine && abs.startsWith('\\\\')) throw new PathError('INVALID_PATH', '整台电脑只包括本机的盘，不支持网络路径')
    if (!this.machine && !isInside(abs, this.root)) throw new PathError('OUTSIDE_WORKSPACE', `${input} 不在工作区内`)

    this.checkSegments(this.segmentsOf(abs), input)

    // 符号链接可能指到工作区外，用真实路径再查一遍
    const real = realpathUpTo(abs)
    if (!this.machine && !isInside(real, this.root)) throw new PathError('OUTSIDE_WORKSPACE', `${input} 经链接指向工作区外`)
    // 指向 \\server\share 的符号链接也算网络路径
    if (this.machine && real.startsWith('\\\\')) throw new PathError('INVALID_PATH', `${input} 经链接指向网络路径，整台电脑不支持`)
    if (real !== abs) this.checkSegments(this.segmentsOf(real), input)

    if (this.protectedDirs.some((d) => isInside(real, d))) {
      throw new PathError('PROTECTED', `${input} 是本应用的数据目录，不允许访问`)
    }
    const fenced = this.fence ? (this.fence.blocked(real) ?? (real !== abs ? this.fence.blocked(abs) : undefined)) : undefined
    if (fenced) throw new PathError('WORKSPACE_FORBIDDEN', `${input} 在工作区「${fenced}」里，这个工作区没有对你开放`)
    return { abs, rel: this.toRel(abs) }
  }

  /** 要逐段检查的路径段：根目录内取相对部分；整机模式下根目录外取盘符之后的全部 */
  private segmentsOf(abs: string): string[] {
    if (isInside(abs, this.root)) return path.relative(this.root, abs).split(path.sep).filter(Boolean)
    return abs.slice(path.parse(abs).root.length).split(path.sep).filter(Boolean)
  }

  /** 一个路径段有什么问题；没问题返回 null */
  private segmentProblem(seg: string): 'trailing' | 'reserved' | 'denied' | null {
    // Windows 会静默去掉结尾的点和空格（".env." 实际打开 ".env"）
    if (/[. ]$/.test(seg) && seg !== '.' && seg !== '..') return 'trailing'
    if (WINDOWS_RESERVED.test(seg)) return 'reserved'
    if (this.denied(seg)) return 'denied'
    return null
  }

  private checkSegments(segs: string[], input: string): void {
    for (const seg of segs) {
      const p = this.segmentProblem(seg)
      if (p === 'trailing') throw new PathError('INVALID_PATH', `路径段不能以点或空格结尾：${seg}`)
      if (p === 'reserved') throw new PathError('INVALID_PATH', `Windows 保留名：${seg}`)
      if (p === 'denied') throw new PathError('SENSITIVE_FILE', `${input} 在 .git 内部，工作台里不能直接操作`)
    }
  }

  /**
   * 给外部搜索程序（ripgrep）的排除规则（不区分大小写的 glob）：遍历时不进 .git（里面是对象文件，搜出来只是噪音）。
   * 只是让 rg 别去读它们；结果仍要逐条过 isAllowedResult
   */
  denyGlobs(): string[] {
    return ['.git']
  }

  /** 受保护目录（应用数据目录） */
  get protectedRoots(): readonly string[] {
    return this.protectedDirs
  }

  /**
   * 外部搜索程序（ripgrep）返回的一个文件能不能给出去：
   * 每一段都不能被拒（保留名；用户模式下还有 .git），不在受保护目录里，
   * 真实路径（经 junction / 符号链接）不出工作区（整机模式下不指到网络路径）、不进受保护目录。
   * stopAt：遍历起点，起点以下的每一层目录还要过 isMachineSkipDir（和 JS 遍历一致）。
   * realDirCache：同一次搜索内目录真实路径的缓存（调用方每次搜索新建一个，不跨搜索复用）
   */
  isAllowedResult(abs: string, stopAt?: string, realDirCache: Map<string, string> = new Map()): boolean {
    abs = path.resolve(abs)
    if (abs.slice(2).includes(':')) return false
    if (!this.machine && !isInside(abs, this.root)) return false
    for (const seg of this.segmentsOf(abs)) if (this.segmentProblem(seg)) return false
    if (this.protectedDirs.some((d) => isInside(abs, d))) return false
    if (this.fence?.blocked(abs)) return false
    if (stopAt && this.machine) {
      const base = path.resolve(stopAt)
      for (let dir = path.dirname(abs); isInside(dir, base) && dir !== base; dir = path.dirname(dir)) {
        if (this.isMachineSkipDir(dir)) return false
      }
    }
    // 真实路径：目录按缓存算，文件本身是链接的话单独算
    const dir = path.dirname(abs)
    let realDir = realDirCache.get(dir)
    if (realDir === undefined) {
      realDir = realpathUpTo(dir)
      realDirCache.set(dir, realDir)
    }
    let real = path.join(realDir, path.basename(abs))
    try {
      if (fs.lstatSync(abs).isSymbolicLink()) real = realpathUpTo(abs)
    } catch {
      return false
    }
    if (real !== abs) {
      if (!this.machine && !isInside(real, this.root)) return false
      if (this.machine && real.startsWith('\\\\')) return false
      for (const seg of this.segmentsOf(real)) if (this.segmentProblem(seg)) return false
      if (this.fence?.blocked(real)) return false
    }
    return !this.protectedDirs.some((d) => isInside(real, d))
  }

  /** 列目录时用：这个条目要不要隐藏（应用数据目录、没对这个 AI 开放的工作区；用户模式下还有 .git） */
  isHidden(absPath: string): boolean {
    if (this.denied(path.basename(absPath))) return true
    return this.protectedDirs.some((d) => isInside(absPath, d)) || !!this.fence?.blocked(absPath)
  }

  /** 遍历（搜索、找文件、文件清单）时要不要跳过：隐藏的条目，外加 .git（噪音）。直接读写、列 .git 里的内容不受影响 */
  isTraverseSkip(absPath: string): boolean {
    return path.basename(absPath).toLowerCase() === '.git' || this.isHidden(absPath)
  }

  /** 整机模式下遍历时要不要跳过这个目录（系统目录、AppData 之类）；普通工作区永远 false */
  isMachineSkipDir(absDir: string): boolean {
    if (!this.machine) return false
    const base = path.basename(absDir).toLowerCase()
    if (MACHINE_SKIP_ANY.has(base)) return true
    const parent = path.dirname(absDir)
    if (parent === absDir || !isDriveRoot(parent)) return false
    return (IS_WIN ? MACHINE_SKIP_TOP_WIN : MACHINE_SKIP_TOP_POSIX).has(base)
  }

  /**
   * 是不是某个盘的根目录（整机模式下不能整盘删除、移动、搜索）。
   * 字面路径和真实路径都看：指向 D:\ 的 junction（C:/tmp/dj）也算盘根
   */
  isDriveRoot(abs: string): boolean {
    return isDriveRoot(abs) || isDriveRoot(realpathUpTo(abs))
  }

  /**
   * 这个路径里面有没有受保护的数据目录（本身就是它，或是它的上级）。
   * move / delete 前要查：resolve 只拦「在数据目录里面」，挪走或删掉它的上级目录会把 token 一起带出保护范围
   */
  containsProtected(abs: string): boolean {
    const real = realpathUpTo(abs)
    return this.protectedDirs.some((d) => isInside(d, abs) || isInside(d, real))
  }

  /** 这个路径里面有没有没对当前 AI 开放的工作区（本身就是，或是它的上级）：有就返回那个工作区的名字。move / delete 前查 */
  containsFenced(abs: string): string | undefined {
    if (!this.fence) return undefined
    const real = realpathUpTo(abs)
    return this.fence.roots().find((f) => isInside(f.root, abs) || isInside(f.root, real))?.name
  }

  toRel(abs: string): string {
    if (this.machine && !isInside(abs, this.root)) return abs.split(path.sep).join('/')
    const rel = path.relative(this.root, abs)
    return rel === '' ? '.' : rel.split(path.sep).join('/')
  }
}
