// 工作台的全文搜索和快速打开文件清单（用户自己用，不给 AI）。不依赖 Electron，main 注入工作区列表和数据目录
import type { Dirent } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { decode } from './encoding'
import { isBinaryExt, readSearchable } from './fastRead'
import { PathGuard } from './pathGuard'
import {
  PCRE2_NOT_WORD_AFTER,
  PCRE2_NOT_WORD_BEFORE,
  RG_ASCII_WORD_BOUNDARY,
  escapeRgLiteral,
  findRipgrep,
  guardExcludeArgs,
  jsRegexToRg,
  ripgrepHasPcre2,
  runRipgrep,
  type RgFile
} from './ripgrep'
import type {
  FileListEntry,
  SearchFileResult,
  SearchMatch,
  SearchOptions,
  SearchResult
} from './types'

/** 能搜的工作区：调用方只传目录存在的 */
export interface SearchRoot {
  id: string
  root: string
  /** 整台电脑：「全部工作区」搜索和快速打开不包含它，要单独选它才搜（从起始目录或给定子目录搜） */
  machine?: boolean
}

export interface SearchServiceOptions {
  /** 应用数据目录（里面有 token），搜索和列文件都跳过 */
  dataDir: string
  roots: () => SearchRoot[]
}

const DEFAULT_MAX_RESULTS = 2000
const MAX_RESULTS_CAP = 20000
const MAX_PER_FILE = 100
/** context_lines 的上限：再多就不是「看一眼上下文」了，直接去读文件 */
const MAX_CONTEXT_LINES = 5
/** find_files 默认和上限（照 ShunCode） */
const DEFAULT_FIND_RESULTS = 100
const MAX_FIND_RESULTS = 500
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_LIST_FILES = 50000
/** 一次搜索最多看多少个文件，防止超大目录占满内存 */
const MAX_SCAN_FILES = 200000
const TIMEOUT_MS = 15000
/** 同时读几个文件。主进程启动时把 libuv 线程池调到了 16（见 threadpool.ts），这里和它对齐 */
const CONCURRENCY = 16
const MAX_QUERY = 2000
const MAX_PATTERNS = 50
const MAX_GITIGNORE_RULES = 2000
/** 很长的行（压缩过的代码）只截取匹配附近一段给界面 */
const MAX_LINE_TEXT = 500
const LINE_CONTEXT_BEFORE = 80

// 除了明显的构建产物，还排掉各种虚拟环境和包缓存：这些目录动辄几万个文件，
// 一旦被扫进来，大工作区里搜索会先在它们身上耗尽超时，真正的项目文件反而搜不到
const DEFAULT_EXCLUDES = [
  'node_modules',
  '.git',
  'out',
  'dist',
  'build',
  '.next',
  'coverage',
  '.e2e-out',
  '*.min.js',
  // Python
  '.venv',
  'venv',
  '__pycache__',
  'site-packages',
  '*.egg-info',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  // 其他生态的依赖和构建缓存
  'target',
  'Pods',
  '.turbo',
  '.nuxt',
  '.svelte-kit',
  'vendor',
  '.cache'
]

// ========== glob ==========

interface GlobRule {
  re: RegExp
  /** 含 / 的规则按工作区相对路径整段匹配，否则匹配任意一层的名字 */
  anchored: boolean
  /** 以 / 结尾：只匹配目录 */
  dirOnly: boolean
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** ** 跨目录，* 和 ? 不跨目录，支持 {a,b} 和 [abc] */
function globSource(g: string): string {
  let out = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++
        // "**/" 匹配零到多层目录；单独的 "**" 匹配任意内容
        if (g[i + 1] === '/') {
          i++
          out += '(?:[^/]*/)*'
        } else out += '.*'
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else if (c === '{') {
      const end = g.indexOf('}', i)
      if (end === -1) {
        out += '\\{'
        continue
      }
      out += '(?:' + g.slice(i + 1, end).split(',').map(globSource).join('|') + ')'
      i = end
    } else if (c === '[') {
      const end = g.indexOf(']', i + 1)
      if (end === -1) {
        out += '\\['
        continue
      }
      let body = g.slice(i + 1, end)
      if (body.startsWith('!')) body = '^' + body.slice(1)
      out += '[' + body.replace(/\\/g, '\\\\') + ']'
      i = end
    } else out += escapeRe(c)
  }
  return out
}

function compileGlob(raw: string, fromGitignore = false): GlobRule | null {
  let g = raw.trim()
  // 界面里输入的规则允许 Windows 反斜杠；.gitignore 里反斜杠是转义，只处理 \# 和 \!
  if (!fromGitignore) g = g.replace(/\\/g, '/')
  else if (/^\\[#!]/.test(g)) g = g.slice(1)
  g = g.replace(/^\.\//, '')
  const dirOnly = g.endsWith('/')
  g = g.replace(/\/+$/, '')
  const anchored = g.includes('/')
  g = g.replace(/^\/+/, '')
  if (!g) return null
  return { re: new RegExp('^' + globSource(g) + '$', 'i'), anchored, dirOnly }
}

/** 逗号分隔的规则（中文逗号也行） */
function parseGlobs(input: string, label: string): GlobRule[] {
  const parts = input
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_PATTERNS)
  const rules: GlobRule[] = []
  for (const p of parts) {
    try {
      const r = compileGlob(p)
      if (r) rules.push(r)
    } catch {
      throw new Error(`「${label}」里的规则写法有误：${p}`)
    }
  }
  return rules
}

const DEFAULT_RULES = DEFAULT_EXCLUDES.map((g) => compileGlob(g)).filter((r): r is GlobRule => r !== null)

/** 遍历时判断一个条目本身（父目录已经判断过） */
function hitsEntry(rules: GlobRule[], rel: string, name: string, isDir: boolean): boolean {
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue
    if (r.re.test(r.anchored ? rel : name)) return true
  }
  return false
}

/** 包含规则：文件本身或它所在的任一层目录命中都算（填 src 就是 src 目录下的全部文件） */
function hitsPath(rules: GlobRule[], rel: string): boolean {
  const segs = rel.split('/')
  for (const r of rules) {
    for (let i = 0; i < segs.length; i++) {
      const isDir = i < segs.length - 1
      if (r.dirOnly && !isDir) continue
      if (r.re.test(r.anchored ? segs.slice(0, i + 1).join('/') : segs[i])) return true
    }
  }
  return false
}

// ========== 遍历 ==========

interface WalkCtx {
  guard: PathGuard
  excludes: GlobRule[]
  stopped: () => boolean
  /** 全文搜索用：二进制扩展名的文件不列出（快速打开要列全，不设） */
  skipBinaryExts?: boolean
}

const byName = (a: Dirent, b: Dirent): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/** 先列本层文件再进子目录；跳过符号链接（含 junction）、.git、应用数据目录和排除规则命中的 */
async function* walk(dirAbs: string, dirRel: string, ctx: WalkCtx): AsyncGenerator<{ abs: string; rel: string }> {
  if (ctx.stopped()) return
  let dirents: Dirent[]
  try {
    dirents = await fsp.readdir(dirAbs, { withFileTypes: true })
  } catch {
    return
  }
  dirents.sort(byName)
  const subdirs: { abs: string; rel: string }[] = []
  for (const d of dirents) {
    if (ctx.stopped()) return
    if (d.isSymbolicLink()) continue
    const abs = path.join(dirAbs, d.name)
    if (ctx.guard.isTraverseSkip(abs)) continue
    const rel = dirRel ? `${dirRel}/${d.name}` : d.name
    if (d.isDirectory()) {
      if (!hitsEntry(ctx.excludes, rel, d.name, true) && !ctx.guard.isMachineSkipDir(abs)) subdirs.push({ abs, rel })
    } else if (d.isFile() && !(ctx.skipBinaryExts && isBinaryExt(d.name)) && !hitsEntry(ctx.excludes, rel, d.name, false)) {
      yield { abs, rel }
    }
  }
  for (const s of subdirs) yield* walk(s.abs, s.rel, ctx)
}

// ========== 匹配 ==========

interface Normalized {
  query: string
  workspaceId?: string
  /** 搜索起点目录（工作区相对），空表示根目录 */
  path: string
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
  include: string
  exclude: string
  contextLines: number
  maxMatchesPerFile: number
  maxResults: number
}

/** 工具层可以传数组，界面传逗号分隔的字符串；统一成字符串交给 parseGlobs */
function joinGlobs(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).join(',')
  return ''
}

/** IPC 进来的参数不可信：只取认识的字段，类型不对的当没传 */
function normalize(input: unknown): Normalized {
  const x = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const int = (v: unknown, def: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : def
  return {
    query: str(x.query),
    workspaceId: str(x.workspaceId) || undefined,
    path: str(x.path),
    regex: x.regex === true,
    caseSensitive: x.caseSensitive === true,
    wholeWord: x.wholeWord === true,
    include: joinGlobs(x.include),
    exclude: joinGlobs(x.exclude),
    contextLines: int(x.contextLines, 0, 0, MAX_CONTEXT_LINES),
    maxMatchesPerFile: int(x.maxMatchesPerFile, MAX_PER_FILE, 1, MAX_PER_FILE),
    maxResults: int(x.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_CAP)
  }
}

function buildMatcher(o: Normalized): RegExp {
  if (o.query.length > MAX_QUERY) throw new Error(`搜索内容太长，最多 ${MAX_QUERY} 个字符`)
  let src = o.regex ? o.query : escapeRe(o.query)
  if (o.wholeWord) {
    // 字面搜索只在首尾是单词字符时加边界，这样搜 ".foo" 也能命中 "a.foo"
    if (o.regex) src = `(?<!\\w)(?:${src})(?!\\w)`
    else src = (/^\w/.test(o.query) ? '(?<!\\w)' : '') + src + (/\w$/.test(o.query) ? '(?!\\w)' : '')
  }
  const flags = 'g' + (o.caseSensitive ? '' : 'i')
  if (!o.regex) return new RegExp(src, flags)
  // 先按 Unicode 模式编译（支持 \p{Han} 这类写法），不行再按普通模式
  try {
    return new RegExp(src, flags + 'u')
  } catch {
    // 换普通模式再试
  }
  try {
    return new RegExp(src, flags)
  } catch (e) {
    throw new Error(`正则写法有误：${(e as Error).message}`)
  }
}

function toMatch(line: number, text: string, ranges: [number, number][]): SearchMatch {
  if (text.length <= MAX_LINE_TEXT) return { line, text, ranges }
  const start = Math.max(0, ranges[0][0] - LINE_CONTEXT_BEFORE)
  return { line, text: text.slice(start, start + MAX_LINE_TEXT), ranges, textStart: start }
}

interface FileHits {
  matches: SearchMatch[]
  count: number
  capped: boolean
}

/** 上下文行也按同一套长度上限截断，免得一行几万字符把回包撑爆 */
const clipLine = (s: string): string => (s.length <= MAX_LINE_TEXT ? s : s.slice(0, MAX_LINE_TEXT))

/** 给每处匹配挂上前后几行原文 */
function withContext(matches: SearchMatch[], lines: string[], n: number): SearchMatch[] {
  if (n <= 0) return matches
  return matches.map((m) => {
    const before: string[] = []
    const after: string[] = []
    for (let i = Math.max(1, m.line - n); i < m.line; i++) before.push(clipLine(lines[i - 1] ?? ''))
    for (let i = m.line + 1; i <= Math.min(lines.length, m.line + n); i++) after.push(clipLine(lines[i - 1] ?? ''))
    return {
      ...m,
      ...(before.length ? { contextBefore: before } : {}),
      ...(after.length ? { contextAfter: after } : {})
    }
  })
}

/**
 * 逐行匹配。读文件之后全是同步代码，所以多个并发任务共用一个带 g 的正则不会互相干扰。
 * 返回 'skipped' 表示文件超过大小上限被跳过（上层要统计出来告诉 AI），
 * 返回 null 表示不是文本或者读不了，安静跳过。
 */
async function scanFile(
  abs: string,
  re: RegExp,
  literal: boolean,
  o: { maxPerFile: number; contextLines: number }
): Promise<FileHits | 'skipped' | null> {
  const buf = await readSearchable(abs, MAX_FILE_BYTES)
  if (buf === 'large') return 'skipped'
  if (!buf) return null
  const text = decode(buf).text
  // 字面搜索先整篇查一次，没有就不用拆行
  if (literal) {
    re.lastIndex = 0
    if (!re.test(text)) return null
  }
  const lines = text.split(/\r\n|\r|\n/)
  const matches: SearchMatch[] = []
  let count = 0
  let capped = false
  for (let i = 0; i < lines.length && !capped; i++) {
    const line = lines[i]
    let ranges: [number, number][] | undefined
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) {
      const s = m.index
      const e = s + m[0].length
      if (e === s) {
        // 空匹配（如 a*）不算，往后挪一格防止死循环
        re.lastIndex = s + 1
        if (re.lastIndex > line.length) break
        continue
      }
      if (count >= o.maxPerFile) {
        capped = true
        break
      }
      ranges ??= []
      ranges.push([s, e])
      count++
    }
    if (ranges) matches.push(toMatch(i + 1, line, ranges))
  }
  return count ? { matches: withContext(matches, lines, o.contextLines), count, capped } : null
}

/** 只保留前 n 处匹配 */
function trimMatches(matches: SearchMatch[], n: number): SearchMatch[] {
  const out: SearchMatch[] = []
  for (const m of matches) {
    if (n <= 0) break
    if (m.ranges.length <= n) {
      out.push(m)
      n -= m.ranges.length
    } else {
      out.push({ ...m, ranges: m.ranges.slice(0, n) })
      n = 0
    }
  }
  return out
}

const countRanges = (matches: SearchMatch[]): number => matches.reduce((n, m) => n + m.ranges.length, 0)

interface Collected {
  found: { w: number; result: SearchFileResult }[]
  truncated: boolean
  reason?: string
  skippedLarge: number
}

/** 两个引擎共用：按工作区顺序和路径排好（并发 / 多线程的完成顺序不固定），再截到上限 */
function finalize(c: Collected, maxResults: number): Omit<SearchResult, 'durationMs'> {
  const found = [...c.found].sort((a, b) => a.w - b.w || (a.result.path < b.result.path ? -1 : a.result.path > b.result.path ? 1 : 0))
  let truncated = c.truncated
  let reason = c.reason
  let left = maxResults
  const out: SearchFileResult[] = []
  for (const { result } of found) {
    if (left <= 0) {
      truncated = true
      reason ??= 'max_results'
      break
    }
    const n = countRanges(result.matches)
    if (n > left) {
      out.push({ ...result, matches: trimMatches(result.matches, left) })
      truncated = true
      reason = 'max_results'
      left = 0
    } else {
      out.push(result)
      left -= n
    }
  }
  return {
    files: out,
    totalMatches: maxResults - left,
    truncated,
    ...(reason ? { truncatedReason: reason } : {}),
    ...(c.skippedLarge ? { skippedLargeFiles: c.skippedLarge } : {})
  }
}

/**
 * 排除规则里能原样交给 rg 剪枝的：不含 /（含 / 的按工作区相对路径算，rg 的根是搜索起点，交给结果过滤）、
 * 只用普通字符和 * ?。其余的只在结果过滤里生效（结果一样，只是 rg 多读一些）
 */
function rgNameGlobs(parts: string[]): string[] {
  return parts
    .map((s) => s.trim())
    .filter((s) => s && /^[\w.*?$@#%&+=~ -]+$/.test(s) && !s.startsWith('!'))
    .slice(0, MAX_PATTERNS + DEFAULT_EXCLUDES.length)
}

/** rg 一个文件的结果换成 JS 引擎的格式：单文件上限、长行截取、上下文都和 scanFile 一致 */
function rgFileHits(f: RgFile, maxPerFile: number, contextLines: number): FileHits {
  const matches: SearchMatch[] = []
  let count = 0
  let capped = false
  for (const m of f.matches) {
    let ranges: [number, number][] | undefined
    for (const r of m.ranges) {
      if (r[1] === r[0]) continue
      if (count >= maxPerFile) {
        capped = true
        break
      }
      ranges ??= []
      ranges.push(r)
      count++
    }
    if (ranges) matches.push(toMatch(m.line, m.text, ranges))
    if (capped) break
  }
  if (!count || contextLines <= 0) return { matches, count, capped }
  // 上下文：rg 打印的匹配行和上下文行按行号查
  const text = new Map<number, string>(f.context)
  for (const m of f.matches) text.set(m.line, m.text)
  let maxLine = 0
  for (const k of text.keys()) if (k > maxLine) maxLine = k
  // JS 按换行拆分时，以换行结尾的文件末尾多一个空行；rg 没截断时（没到单文件上限）打印到的最后一行之后就是文件尾
  const phantom = !capped && f.matches.length <= maxPerFile && f.lastLineHasEol ? maxLine + 1 : -1
  const lineAt = (n: number): string | undefined => text.get(n) ?? (n === phantom ? '' : undefined)
  return {
    count,
    capped,
    matches: matches.map((m) => {
      const before: string[] = []
      const after: string[] = []
      for (let i = Math.max(1, m.line - contextLines); i < m.line; i++) before.push(clipLine(lineAt(i) ?? ''))
      for (let i = m.line + 1; i <= m.line + contextLines; i++) {
        const t = lineAt(i)
        if (t === undefined) break
        after.push(clipLine(t))
      }
      return {
        ...m,
        ...(before.length ? { contextBefore: before } : {}),
        ...(after.length ? { contextAfter: after } : {})
      }
    })
  }
}

// ========== 服务 ==========

export class SearchService {
  /** 界面边打字边搜：新的一次开始时停掉上一次 */
  private current?: AbortController
  private readonly ignoreCache = new Map<string, { mtimeMs: number; size: number; rules: GlobRule[] }>()

  constructor(private readonly opts: SearchServiceOptions) {}

  async search(input: SearchOptions): Promise<SearchResult> {
    const started = Date.now()
    this.current?.abort()
    const ac = new AbortController()
    this.current = ac
    try {
      const o = normalize(input)
      if (!o.query) return { files: [], totalMatches: 0, truncated: false, durationMs: 0 }
      const re = buildMatcher(o)
      const includes = parseGlobs(o.include, '包含')
      const userExcludes = parseGlobs(o.exclude, '排除')
      const excludes = [...DEFAULT_RULES, ...userExcludes]
      const roots = this.pickRoots(o.workspaceId)
      const deadline = started + TIMEOUT_MS

      const viaRg = await this.searchWithRipgrep(o, re, includes, excludes, roots, deadline, ac.signal)
      if (viaRg) return { ...finalize(viaRg, o.maxResults), engine: 'ripgrep', durationMs: Date.now() - started }

      let total = 0
      let scanned = 0
      let timedOut = false
      let capped = false
      let skippedLarge = 0
      let hitFileCap = false
      const found: { w: number; result: SearchFileResult }[] = []
      const stopped = (): boolean => {
        if (ac.signal.aborted || total > o.maxResults || scanned >= MAX_SCAN_FILES) return true
        if (Date.now() > deadline) timedOut = true
        return timedOut
      }

      const self = this
      async function* files(): AsyncGenerator<{ w: number; abs: string; rel: string }> {
        for (let w = 0; w < roots.length; w++) {
          const prep = await self.prepareRoot(roots[w])
          if (!prep) continue
          // path 参数：只搜这个子目录。走 guard 解析，越界和受保护目录会在这里抛错
          const start = o.path ? prep.guard.resolve(o.path) : { abs: prep.guard.root, rel: '' }
          if (prep.guard.machine && prep.guard.isDriveRoot(start.abs)) throw new Error('整台电脑不能直接搜整个盘，请把搜索范围设成一个具体目录')
          for await (const f of walk(start.abs, start.rel, { guard: prep.guard, excludes: [...excludes, ...prep.ignore], stopped, skipBinaryExts: true })) {
            yield { w, ...f }
          }
        }
      }
      const source = files()
      const worker = async (): Promise<void> => {
        for (;;) {
          if (stopped()) return
          const next = await source.next()
          if (next.done) return
          const { w, abs, rel } = next.value
          if (includes.length && !hitsPath(includes, rel)) continue
          scanned++
          const hits = await scanFile(abs, re, !o.regex, { maxPerFile: o.maxMatchesPerFile, contextLines: o.contextLines })
          if (hits === 'skipped') {
            skippedLarge++
            continue
          }
          if (!hits) continue
          total += hits.count
          if (hits.capped) {
            capped = true
            hitFileCap = true
          }
          found.push({ w, result: { workspaceId: roots[w].id, path: rel, matches: hits.matches, ...(hits.capped ? { truncated: true } : {}) } })
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker))
      await source.return(undefined)

      const reason: string | undefined = timedOut
        ? 'timeout'
        : ac.signal.aborted
          ? 'canceled'
          : scanned >= MAX_SCAN_FILES
            ? 'scan_limit'
            : hitFileCap
              ? 'max_matches_per_file'
              : undefined
      return {
        ...finalize({ found, truncated: timedOut || capped || ac.signal.aborted || scanned >= MAX_SCAN_FILES, reason, skippedLarge }, o.maxResults),
        engine: 'bridge',
        durationMs: Date.now() - started
      }
    } finally {
      if (this.current === ac) this.current = undefined
    }
  }

  /**
   * ripgrep 后端。返回 null 表示这次用不了 rg（没装、写法不支持、启动失败），调用方走 JS 引擎。
   * 和 JS 引擎的差异见 ripgrep.ts 开头；安全上不依赖 rg：每个结果都过 guard.isAllowedResult
   */
  private async searchWithRipgrep(
    o: Normalized,
    re: RegExp,
    includes: GlobRule[],
    excludes: GlobRule[],
    roots: SearchRoot[],
    deadline: number,
    signal: AbortSignal
  ): Promise<Collected | null> {
    const rgPath = findRipgrep()
    if (!rgPath) return null
    // 能匹配空串的正则（a*）：JS 引擎不算空匹配，rg 会把每一行都算上，交给 JS
    re.lastIndex = 0
    if (re.test('')) return null
    // 查询里有换行：rg 会把它拆成多个模式，交给 JS
    if (/[\r\n]/.test(o.query)) return null
    let pattern: string
    let fixed = false
    let pcre2 = false
    if (!o.regex) {
      if (!o.wholeWord) {
        pattern = o.query
        fixed = true
      } else {
        // 和 buildMatcher 一致：首尾是单词字符才加边界。紧挨单词字符时 ASCII \b 和 (?<!\w) / (?!\w) 等价
        pattern =
          (/^\w/.test(o.query) ? RG_ASCII_WORD_BOUNDARY : '') + escapeRgLiteral(o.query) + (/\w$/.test(o.query) ? RG_ASCII_WORD_BOUNDARY : '')
      }
    } else {
      const t = jsRegexToRg(o.query, re.flags.includes('u'))
      if ('unsupported' in t) return null
      pattern = t.pattern
      pcre2 = t.pcre2
      if (o.wholeWord) {
        pattern = `${PCRE2_NOT_WORD_BEFORE}(?:${pattern})${PCRE2_NOT_WORD_AFTER}`
        pcre2 = true
      }
    }
    if (pcre2 && !ripgrepHasPcre2(rgPath)) return null

    const found: { w: number; result: SearchFileResult }[] = []
    let total = 0
    let skippedLarge = 0
    let reason: string | undefined
    let truncated = false
    for (let w = 0; w < roots.length; w++) {
      if (signal.aborted) {
        reason = 'canceled'
        truncated = true
        break
      }
      const prep = await this.prepareRoot(roots[w], false)
      if (!prep) continue
      const { guard } = prep
      const start = o.path ? guard.resolve(o.path) : { abs: guard.root, rel: '' }
      if (guard.machine && guard.isDriveRoot(start.abs)) throw new Error('整台电脑不能直接搜整个盘，请把搜索范围设成一个具体目录')
      const startRel = start.rel === '.' ? '' : start.rel
      const args = [
        '--debug',
        '--no-config',
        '--hidden',
        '--no-require-git',
        '--crlf',
        '--max-filesize',
        '2M',
        '--max-count',
        String(o.maxMatchesPerFile + 1),
        o.caseSensitive ? '--case-sensitive' : '--ignore-case',
        ...(o.contextLines ? ['--context', String(o.contextLines)] : []),
        ...(fixed ? ['--fixed-strings'] : []),
        ...(pcre2 ? ['--pcre2'] : []),
        ...guardExcludeArgs(guard, start.abs, rgNameGlobs([...DEFAULT_EXCLUDES, ...o.exclude.split(/[,，]/)])),
        '--regexp',
        pattern,
        '--',
        '.'
      ]
      const realCache = new Map<string, string>()
      const startDepth = startRel ? startRel.split('/').length : 0
      const toRel = (rgRel: string): string | null => {
        const abs = path.resolve(start.abs, rgRel)
        if (!guard.isAllowedResult(abs, start.abs, realCache)) return null
        const rel = (startRel ? `${startRel}/` : '') + rgRel
        // 和 JS 遍历一样逐层看排除规则（含 / 的规则按工作区相对路径算，rg 那边只排了不含 / 的）
        const segs = rel.split('/')
        for (let i = startDepth; i < segs.length; i++) {
          if (hitsEntry(excludes, segs.slice(0, i + 1).join('/'), segs[i], i < segs.length - 1)) return null
        }
        if (isBinaryExt(segs[segs.length - 1])) return null
        if (includes.length && !hitsPath(includes, rel)) return null
        return rel
      }
      const r = await runRipgrep({
        rgPath,
        cwd: start.abs,
        args,
        timeoutMs: deadline - Date.now(),
        signal,
        onSkippedLarge: (p) => {
          if (toRel(p) !== null) skippedLarge++
        },
        onFile: (f) => {
          const rel = toRel(f.rel)
          if (rel === null) return
          const hits = rgFileHits(f, o.maxMatchesPerFile, o.contextLines)
          if (!hits.count) return
          total += hits.count
          if (hits.capped) {
            truncated = true
            reason ??= 'max_matches_per_file'
          }
          found.push({ w, result: { workspaceId: roots[w].id, path: rel, matches: hits.matches, ...(hits.capped ? { truncated: true } : {}) } })
          // 和 JS 引擎一样：超过上限再多收一点就停，最后排序截断
          return total > o.maxResults
        }
      })
      if (r.status === 'failed') {
        // 一个结果都还没有：当作 rg 用不了，整次交给 JS 引擎
        if (!found.length) return null
        continue
      }
      if (r.status === 'timeout') {
        reason = 'timeout'
        truncated = true
        break
      }
      if (r.status === 'aborted') {
        reason = 'canceled'
        truncated = true
        break
      }
      if (r.status === 'stopped') break
    }
    // 超时、取消优先于单文件上限
    return { found, truncated, reason, skippedLarge }
  }


  /** 快速打开用：全部（或某个）工作区的文件，最多 50000 个 */
  async listFiles(workspaceId?: string): Promise<FileListEntry[]> {
    const roots = this.pickRoots(typeof workspaceId === 'string' && workspaceId ? workspaceId : undefined)
    const deadline = Date.now() + TIMEOUT_MS
    const out: FileListEntry[] = []
    const stopped = (): boolean => out.length >= MAX_LIST_FILES || Date.now() > deadline
    for (const r of roots) {
      if (stopped()) break
      const prep = await this.prepareRoot(r)
      if (!prep) continue
      for await (const f of walk(prep.guard.root, '', { guard: prep.guard, excludes: [...DEFAULT_RULES, ...prep.ignore], stopped })) {
        out.push({ workspaceId: r.id, path: f.rel })
        if (stopped()) break
      }
    }
    return out
  }

  private pickRoots(workspaceId?: string): SearchRoot[] {
    const all = this.opts.roots()
    // 不指定工作区 = 全部目录工作区；整台电脑太大，不跟着一起扫
    if (!workspaceId) return all.filter((x) => !x.machine)
    const r = all.find((x) => x.id === workspaceId)
    if (!r) throw new Error('找不到这个工作区，可能已经移出列表，或者目录不存在了')
    return [r]
  }

  /** 用户模式的 PathGuard：.env 这类自己的文件能搜到，.git 和应用数据目录跳过 */
  private async prepareRoot(r: SearchRoot, withIgnore = true): Promise<{ guard: PathGuard; ignore: GlobRule[] } | null> {
    const guard = new PathGuard(r.root, [this.opts.dataDir], { mode: 'user', machine: r.machine === true })
    // 工作区本身就是 .git 或在应用数据目录里：整个跳过
    if (guard.isHidden(guard.root)) return null
    // rg 自己按完整的 gitignore 规则处理，不需要这里的简化版
    return { guard, ignore: withIgnore ? await this.gitignore(guard.root) : [] }
  }

  /** 工作区根目录 .gitignore 的简单规则（不支持 ! 取反，子目录里的 .gitignore 不看） */
  private async gitignore(root: string): Promise<GlobRule[]> {
    const file = path.join(root, '.gitignore')
    let st: { mtimeMs: number; size: number; isFile(): boolean }
    try {
      st = await fsp.stat(file)
    } catch {
      this.ignoreCache.delete(root)
      return []
    }
    if (!st.isFile() || st.size > 1024 * 1024) return []
    const hit = this.ignoreCache.get(root)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.rules
    let text: string
    try {
      text = await fsp.readFile(file, 'utf8')
    } catch {
      return []
    }
    const rules: GlobRule[] = []
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#') || t.startsWith('!')) continue
      try {
        const r = compileGlob(t, true)
        if (r) rules.push(r)
      } catch {
        // 写法太特别的规则跳过
      }
      if (rules.length >= MAX_GITIGNORE_RULES) break
    }
    this.ignoreCache.set(root, { mtimeMs: st.mtimeMs, size: st.size, rules })
    return rules
  }
}
