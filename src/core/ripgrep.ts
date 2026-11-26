// ripgrep 后端：工作台搜索（search.ts）和 MCP 的 search 工具（fileTools.ts）共用。
// 找不到 rg、rg 不支持某个写法、或 rg 启动/解析失败时，调用方退回自己的 JS 引擎（engine: 'bridge'）。
//
// 和 JS 引擎的已知差异（都在 README「测试」一节提过）：
// - 编码：rg 只认 UTF-8 和带 BOM 的 UTF-8/UTF-16。GB18030 文件按原始字节搜，ASCII 关键词照样能搜到，
//   中文字面量搜不到。不处理。
// - gitignore：JS 引擎只读工作区根目录的 .gitignore（MCP 侧完全不读）；rg 按完整的 ignore 规则来
//   （各层 .gitignore、.ignore、.git/info/exclude、全局 excludesFile），更准，保持 rg 的行为。
// - 二进制：JS 只看前 8KB 有没有 NUL；rg 在任意位置遇到 NUL 就停止搜这个文件。
// - 只有 \r 的老式换行：工作台 JS 把它当换行，rg 不当。
// 安全过滤不依赖这些：rg 返回的每个路径都会再过一遍 PathGuard.isAllowedResult。
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { decode } from './encoding'
import { binaryExtGlob } from './fastRead'
import type { PathGuard } from './pathGuard'

const IS_WIN = process.platform === 'win32'
const EXE = IS_WIN ? 'rg.exe' : 'rg'

// ========== 找 rg ==========

let cached: { path: string | null } | undefined
const pcre2Cache = new Map<string, boolean>()

/** 测试用：注入 rg 路径（null = 当作没有 rg），传 undefined 清掉缓存重新查找 */
export function setRipgrepPath(p: string | null | undefined): void {
  cached = p === undefined ? undefined : { path: p }
  pcre2Cache.clear()
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name))
  } catch {
    return []
  }
}

function candidates(): string[] {
  const out: string[] = []
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir.trim()) out.push(path.join(dir.trim().replace(/^"|"$/g, ''), EXE))
  }
  if (!IS_WIN) return out
  const local = process.env.LOCALAPPDATA
  if (local) {
    const pkgs = path.join(local, 'Microsoft', 'WinGet', 'Packages')
    for (const pkg of subdirs(pkgs)) {
      if (!path.basename(pkg).toLowerCase().startsWith('burntsushi.ripgrep')) continue
      for (const ver of subdirs(pkg)) out.push(path.join(ver, EXE))
    }
    out.push(path.join(local, 'Microsoft', 'WinGet', 'Links', EXE))
  }
  const vscodeRoots = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft VS Code'),
    local && path.join(local, 'Programs', 'Microsoft VS Code')
  ].filter((x): x is string => !!x)
  for (const r of vscodeRoots) {
    for (const nm of ['node_modules', 'node_modules.asar.unpacked']) {
      out.push(path.join(r, 'resources', 'app', nm, '@vscode', 'ripgrep', 'bin', EXE))
    }
  }
  return out
}

/**
 * 找本机的 rg：环境变量 WB_RG_PATH（none/off 表示禁用）→ PATH → winget 安装目录 → VS Code 自带的 rg。
 * 环境变量每次都看（测试可以随时切换），其余结果缓存。
 */
export function findRipgrep(): string | null {
  const env = process.env.WB_RG_PATH?.trim()
  if (env) {
    if (/^(none|off|false|0)$/i.test(env)) return null
    return isFile(env) ? path.resolve(env) : null
  }
  if (cached) return cached.path
  const found = candidates().find(isFile) ?? null
  cached = { path: found }
  return found
}

/** 这个 rg 编译时带没带 PCRE2（后行断言、反向引用要用） */
export function ripgrepHasPcre2(rgPath: string): boolean {
  const hit = pcre2Cache.get(rgPath)
  if (hit !== undefined) return hit
  let ok = false
  try {
    ok = spawnSync(rgPath, ['--pcre2-version'], { timeout: 5000, windowsHide: true, stdio: 'ignore' }).status === 0
  } catch {
    ok = false
  }
  pcre2Cache.set(rgPath, ok)
  return ok
}

// ========== 正则翻译 ==========

const W = '0-9A-Za-z_'

class Unsupported extends Error {}
class NeedPcre2 extends Error {}

const hex = (cp: number): string => `\\x{${cp.toString(16)}}`

/** 字面量转成 rg 正则（Rust regex 和 PCRE2 都认的转义） */
export function escapeRgLiteral(s: string): string {
  return s.replace(/[\\.+*?()|[\]{}^$#&\-~]/g, '\\$&')
}

/** JS 里 \w \b 只认 ASCII，rg 默认按 Unicode：都换成显式的 ASCII 写法 */
export const RG_ASCII_WORD_BOUNDARY = '(?-u:\\b)'
export const PCRE2_NOT_WORD_BEFORE = `(?<![${W}])`
export const PCRE2_NOT_WORD_AFTER = `(?![${W}])`

export type RgRegex = { pattern: string; pcre2: boolean } | { unsupported: string }

/**
 * 把 JS 正则源码翻译成 rg 能用、语义一致的写法。
 * 先按 rg 默认引擎（Rust regex）翻译；遇到后行断言、前瞻、反向引用就改用 PCRE2（pcre2=true）。
 * 翻不了的（\D \W 这类在 Unicode 下含义不同的、写法太偏的）返回 unsupported，调用方退回 JS 引擎。
 * unicode：JS 是否按 u 模式编译（只有 u 模式下 \p{..} 和 \u{..} 才有意义）。
 */
export function jsRegexToRg(src: string, unicode: boolean): RgRegex {
  try {
    return { pattern: translate(src, unicode, false), pcre2: false }
  } catch (e) {
    if (!(e instanceof NeedPcre2)) return { unsupported: (e as Error).message }
  }
  try {
    return { pattern: translate(src, unicode, true), pcre2: true }
  } catch (e) {
    return { unsupported: (e as Error).message }
  }
}

function translate(src: string, unicode: boolean, pcre2: boolean): string {
  const groups = (src.match(/\((?!\?)|\(\?<(?![=!])/g) ?? []).length
  let out = ''
  let i = 0
  const need = (): void => {
    if (!pcre2) throw new NeedPcre2('pcre2')
  }
  /** 处理 \ 开头的转义（i 指向反斜杠），inClass：在 [...] 里面 */
  const escape = (inClass: boolean): string => {
    const c = src[i + 1]
    if (c === undefined) throw new Unsupported('结尾的反斜杠')
    i += 2
    switch (c) {
      case 'd':
        return inClass ? '0-9' : '[0-9]'
      case 'w':
        return inClass ? W : `[${W}]`
      case 's':
        return '\\s'
      case 'S':
        if (inClass) throw new Unsupported('[\\S]')
        return '\\S'
      case 'D':
        if (inClass) throw new Unsupported('[\\D]')
        return '[^0-9]'
      case 'W':
        if (inClass) throw new Unsupported('[\\W]')
        return `[^${W}]`
      case 'b':
        if (inClass) return '\\x{8}'
        return pcre2 ? `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))` : RG_ASCII_WORD_BOUNDARY
      case 'B':
        if (inClass) throw new Unsupported('[\\B]')
        return pcre2 ? `(?:(?<=[${W}])(?=[${W}])|(?<![${W}])(?![${W}]))` : '(?-u:\\B)'
      case 'n':
      case 'r':
      case 't':
      case 'f':
        return '\\' + c
      case 'v':
        return '\\x{b}'
      case '0':
        if (/[0-9]/.test(src[i] ?? '')) throw new Unsupported('八进制转义')
        return '\\x{0}'
      case 'x': {
        const m = /^[0-9a-fA-F]{2}/.exec(src.slice(i))
        if (!m) throw new Unsupported('\\x')
        i += 2
        return hex(parseInt(m[0], 16))
      }
      case 'u': {
        let cp: number
        const braced = unicode ? /^\{([0-9a-fA-F]{1,6})\}/.exec(src.slice(i)) : null
        if (braced) {
          cp = parseInt(braced[1], 16)
          i += braced[0].length
        } else {
          const m = /^[0-9a-fA-F]{4}/.exec(src.slice(i))
          if (!m) throw new Unsupported('\\u')
          cp = parseInt(m[0], 16)
          i += 4
        }
        if (cp >= 0xd800 && cp <= 0xdfff) throw new Unsupported('代理对')
        return hex(cp)
      }
      case 'p':
      case 'P': {
        if (!unicode) throw new Unsupported('非 Unicode 模式的 \\p')
        const m = /^\{([A-Za-z_]+)(?:=([A-Za-z_]+))?\}/.exec(src.slice(i))
        if (!m) throw new Unsupported('\\p')
        i += m[0].length
        // PCRE2 不认 Script=Han / sc=Han 的写法，只认 \p{Han}
        const name = m[2] && /^(Script|sc|Script_Extensions|scx)$/.test(m[1]) ? m[2] : m[2] ? null : m[1]
        if (!name) throw new Unsupported('\\p{..=..}')
        return `\\${c}{${name}}`
      }
      case 'k': {
        if (inClass) throw new Unsupported('[\\k]')
        const m = /^<([A-Za-z_][A-Za-z0-9_]*)>/.exec(src.slice(i))
        if (!m) throw new Unsupported('\\k')
        need()
        i += m[0].length
        return `\\k<${m[1]}>`
      }
      default:
        if (/[1-9]/.test(c)) {
          if (inClass) throw new Unsupported('类里的数字转义')
          const m = /^[0-9]*/.exec(src.slice(i))!
          const n = parseInt(c + m[0], 10)
          if (n > groups) throw new Unsupported('反向引用编号超过分组数')
          need()
          i += m[0].length
          return `(?:\\${n})`
        }
        if (/[A-Za-z0-9]/.test(c)) throw new Unsupported(`\\${c}`)
        // 其他标点：JS 里就是字面量
        return literalChar(c, inClass)
    }
  }
  const literalChar = (ch: string, inClass: boolean): string => {
    if (/[A-Za-z0-9_ ]/.test(ch) || ch.charCodeAt(0) > 0x7f) return ch
    if (/[\\.+*?()|[\]{}^$#&\-~]/.test(ch)) return '\\' + ch
    if (inClass || /[<>`'"=!%@,;:/]/.test(ch)) return ch
    return hex(ch.charCodeAt(0))
  }
  for (; i < src.length; ) {
    const c = src[i]
    if (c === '\\') {
      out += escape(false)
      continue
    }
    if (c === '[') {
      i++
      let body = '['
      if (src[i] === '^') {
        body += '^'
        i++
      }
      if (src[i] === ']') throw new Unsupported('空字符类')
      for (;;) {
        if (i >= src.length) throw new Unsupported('字符类没有闭合')
        const d = src[i]
        if (d === ']') {
          i++
          break
        }
        if (d === '\\') {
          body += escape(true)
          continue
        }
        if (d === '-') {
          // 首尾的 - 是字面量；中间的是范围，原样保留
          const first = body === '[' || body === '[^'
          const last = src[i + 1] === ']'
          body += first || last ? '\\-' : '-'
          i++
          continue
        }
        body += literalChar(d, true)
        i++
      }
      out += body + ']'
      continue
    }
    if (c === '(') {
      if (src[i + 1] !== '?') {
        out += '('
        i++
        continue
      }
      const rest = src.slice(i + 2)
      if (rest.startsWith(':')) {
        out += '(?:'
        i += 3
      } else if (rest.startsWith('=') || rest.startsWith('!')) {
        need()
        out += '(?' + rest[0]
        i += 3
      } else if (rest.startsWith('<=') || rest.startsWith('<!')) {
        need()
        out += '(?' + rest.slice(0, 2)
        i += 4
      } else {
        const m = /^<([A-Za-z_][A-Za-z0-9_]*)>/.exec(rest)
        if (!m) throw new Unsupported('分组写法')
        out += `(?<${m[1]}>`
        i += 2 + m[0].length
      }
      continue
    }
    if (c === '{') {
      const m = /^\{\d+(,\d*)?\}/.exec(src.slice(i))
      if (m && out && !/[|(]$/.test(out)) {
        // 量词（后面跟 ? 的惰性写法由下一轮原样输出）
        out += m[0]
        i += m[0].length
        continue
      }
      out += '\\{'
      i++
      continue
    }
    if (c === '}' || c === ']') {
      out += '\\' + c
      i++
      continue
    }
    if (')|^$.*+?'.includes(c)) {
      out += c
      i++
      continue
    }
    const cp = src.codePointAt(i)!
    const ch = String.fromCodePoint(cp)
    out += literalChar(ch, false)
    i += ch.length
  }
  return out
}

// ========== glob ==========

/** rg 的 glob 在 Windows 上不认反斜杠转义：特殊字符放进 [] 里 */
export function escapeGlob(s: string): string {
  return s.replace(/[*?[\]{}!]/g, (c) => (c === '!' ? '[!]' : `[${c}]`)).replace(/\\/g, '/')
}

/**
 * 给 rg 的排除参数（不区分大小写）：.git、应用数据目录、二进制扩展名、
 * 整机模式下任何层级都跳过的目录（AppData 之类），再加调用方给的名字。
 * 只是让 rg 别去读它们；结果还会逐条过 guard.isAllowedResult 和调用方自己的排除规则
 */
export function guardExcludeArgs(guard: PathGuard, startAbs: string, extraNames: string[] = []): string[] {
  const out: string[] = []
  for (const g of guard.denyGlobs()) out.push(`--iglob=!${g}`)
  // 搜索不进 .git（--hidden 会让 rg 进去；里面是对象文件，搜出来只是噪音）
  out.push('--iglob=!.git')
  for (const d of guard.protectedRoots) {
    const rel = path.relative(startAbs, d)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) out.push(`--iglob=!/${escapeGlob(rel)}`)
  }
  for (const n of extraNames) out.push(`--iglob=!${n}`)
  out.push(`--iglob=!${binaryExtGlob()}`)
  if (guard.machine) {
    for (const n of ['AppData', '$Recycle.Bin', 'System Volume Information']) out.push(`--iglob=!${escapeGlob(n)}/`)
  }
  return out
}

// ========== 运行 ==========

export interface RgLine {
  line: number
  /** 去掉行尾换行后的文本 */
  text: string
  /** 匹配区间，UTF-16 列号 [起, 止)；上下文行为空 */
  ranges: [number, number][]
}

export interface RgFile {
  /** rg 给的路径（相对 cwd，统一成 /，去掉开头的 ./） */
  rel: string
  /** 按行号排好的匹配行 */
  matches: RgLine[]
  /** 上下文行，键是行号 */
  context: Map<number, string>
  /** 最后一行（匹配或上下文）以换行结尾：说明后面可能还有行，也可能文件以换行结尾 */
  lastLineHasEol: boolean
}

export interface RunRipgrepOptions {
  rgPath: string
  cwd: string
  args: string[]
  /** 解析完一个文件就回调；返回 true 表示够了，杀掉 rg 提前结束 */
  onFile: (f: RgFile) => boolean | void
  /** 超过大小上限被跳过的文件（来自 --debug 的输出，需要调用方传 --debug） */
  onSkippedLarge?: (rel: string) => void
  timeoutMs: number
  signal?: AbortSignal
}

export interface RunRipgrepResult {
  status: 'done' | 'stopped' | 'timeout' | 'aborted' | 'failed'
  /** rg 汇总里的已搜文件数（提前结束时没有） */
  searched?: number
  error?: string
}

function killTree(p: ChildProcess): void {
  if (p.exitCode !== null || p.signalCode !== null) return
  if (IS_WIN && p.pid) {
    try {
      // 只杀自己启动的这个 rg（和它的子进程）
      spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => p.kill())
      return
    } catch {
      // 退回 kill
    }
  }
  p.kill('SIGKILL')
}

const utf8 = new TextDecoder('utf-8')

function dataText(d: { text?: string; bytes?: string } | undefined): { text: string; bytes?: Buffer } {
  if (!d) return { text: '' }
  if (typeof d.text === 'string') return { text: d.text }
  const bytes = Buffer.from(d.bytes ?? '', 'base64')
  // 不是 UTF-8 的行（GB18030 之类）：按 JS 引擎的规则解码
  return { text: decode(bytes).text, bytes }
}

const stripEol = (s: string): string => s.replace(/\r?\n$/, '')

/** rg 给的是 UTF-8 字节偏移，换成 UTF-16 列号 */
function toRanges(line: { text: string; bytes?: Buffer }, subs: { start: number; end: number }[]): [number, number][] {
  if (!subs.length) return []
  const buf = line.bytes ?? Buffer.from(line.text, 'utf8')
  const asText = (b: Buffer): string => (line.bytes ? decode(b).text : utf8.decode(b))
  const out: [number, number][] = []
  let lastByte = 0
  let lastCol = 0
  for (const s of subs) {
    const start = lastCol + asText(buf.subarray(lastByte, s.start)).length
    const end = start + asText(buf.subarray(s.start, s.end)).length
    out.push([start, end])
    lastByte = s.end
    lastCol = end
  }
  return out
}

const cleanRel = (p: string): string => p.replace(/\\/g, '/').replace(/^(\.\/)+/, '')

/**
 * 跑一次 rg --json，按行解析输出流。不经过 shell，参数原样传数组。
 * 超时、AbortSignal、或 onFile 说够了时杀掉 rg（Windows 上 taskkill /T /F）。
 */
export function runRipgrep(opts: RunRipgrepOptions): Promise<RunRipgrepResult> {
  return new Promise((resolve) => {
    let status: RunRipgrepResult['status'] | undefined
    let searched: number | undefined
    let stderr = ''
    let parseError: string | undefined
    let p: ChildProcess
    try {
      p = spawn(opts.rgPath, ['--json', ...opts.args], {
        cwd: opts.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (e) {
      resolve({ status: 'failed', error: (e as Error).message })
      return
    }
    const stop = (why: RunRipgrepResult['status']): void => {
      if (status) return
      status = why
      killTree(p)
    }
    const timer = setTimeout(() => stop('timeout'), Math.max(0, opts.timeoutMs))
    const onAbort = (): void => stop('aborted')
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })

    let cur: RgFile | null = null
    const handle = (line: string): void => {
      if (status || !line) return
      let msg: { type: string; data: any }
      try {
        msg = JSON.parse(line)
      } catch {
        parseError = '无法解析 rg 输出'
        stop('failed')
        return
      }
      const d = msg.data
      switch (msg.type) {
        case 'begin':
          cur = { rel: cleanRel(dataText(d.path).text), matches: [], context: new Map(), lastLineHasEol: false }
          break
        case 'match':
        case 'context': {
          if (!cur) break
          const raw = dataText(d.lines)
          const hasEol = /\n$/.test(raw.text)
          const text = stripEol(raw.text)
          const no = d.line_number as number
          if (typeof no !== 'number') break
          if (msg.type === 'match') {
            const subs = (d.submatches ?? []) as { start: number; end: number }[]
            cur.matches.push({ line: no, text, ranges: toRanges(raw, subs) })
          } else cur.context.set(no, text)
          cur.lastLineHasEol = hasEol
          break
        }
        case 'end':
          if (cur) {
            const f = cur
            cur = null
            if (opts.onFile(f)) stop('stopped')
          }
          break
        case 'summary':
          searched = d?.stats?.searches
          break
      }
    }
    let buf = ''
    p.stdout!.setEncoding('utf8')
    p.stdout!.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        handle(buf.slice(0, nl).replace(/\r$/, ''))
        buf = buf.slice(nl + 1)
      }
    })
    let errBuf = ''
    p.stderr!.setEncoding('utf8')
    p.stderr!.on('data', (chunk: string) => {
      errBuf += chunk
      let nl: number
      while ((nl = errBuf.indexOf('\n')) !== -1) {
        const l = errBuf.slice(0, nl).replace(/\r$/, '')
        errBuf = errBuf.slice(nl + 1)
        const big = /^rg: DEBUG\|ignore::walk\|.*?: ignoring (.+): \d+ bytes$/.exec(l)
        if (big) {
          if (!status) opts.onSkippedLarge?.(cleanRel(big[1]))
        } else if (!l.startsWith('rg: DEBUG|') && stderr.length < 4000) stderr += l + '\n'
      }
    })
    let settled = false
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (buf && !status) handle(buf.replace(/\r$/, ''))
      // 0 有结果，1 没结果，2 有错误：有汇总说明只是个别文件读不了（权限之类），照常算完成
      if (!status) status = code === 0 || code === 1 || (code === 2 && searched !== undefined) ? 'done' : 'failed'
      resolve({
        status,
        ...(searched !== undefined ? { searched } : {}),
        ...(status === 'failed' ? { error: parseError ?? (stderr.trim() || `rg 退出码 ${code}`) } : {})
      })
    }
    p.on('error', (e) => {
      if (!status) {
        status = 'failed'
        parseError = e.message
      }
      // 没启动起来时不一定有 close 事件
      if (p.pid === undefined) finish(null)
    })
    p.on('close', (code) => finish(code))
  })
}
