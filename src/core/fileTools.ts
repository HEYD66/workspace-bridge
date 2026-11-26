import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createTwoFilesPatch } from 'diff'
import { decode, encode, isBinary, type TextEncoding } from './encoding'
import { isBinaryExt, readSearchable } from './fastRead'
import { PathError, type PathGuard } from './pathGuard'
import { findRipgrep, guardExcludeArgs, jsRegexToRg, ripgrepHasPcre2, runRipgrep, type RgFile } from './ripgrep'
import type { PatchEnv } from './patchApplier'

export const MAX_READ_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_LINES = 2000
/** 单次回包的字节预算：超了按行截断，告诉 AI 从哪一行接着读（照 ShunCode 的 256 KB） */
const MAX_REPLY_BYTES = 256 * 1024
/** 单行太长（压缩过的 js、一整行 json）时切一段，剩下的建议用 search */
const MAX_REPLY_LINE_CHARS = 4000
/** read_files：一次最多几个文件、每个最多几行、总共多少字节 */
const MAX_BATCH_FILES = 20
const MAX_BATCH_LINES = 400
const MAX_BATCH_TOTAL_BYTES = 256 * 1024
const MAX_DIFF_CHARS = 200_000
/** search 内容搜索时同时在读的文件数（主进程的 libuv 线程池是 16，见 threadpool.ts） */
const SEARCH_READ_AHEAD = 16
const SKIP_DIRS = new Set(['node_modules', '.venv', '__pycache__', 'dist', 'out', 'build', '.next', 'target'])
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

export class ToolError extends Error {
  constructor(readonly code: string, message: string, readonly data?: Record<string, unknown>) {
    super(`${code}: ${message}`)
  }
}

/** 文件版本 = 内容 SHA-256 前 16 位；AI 写入时带上它，别人先改过就冲突 */
export function versionOf(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
}

/** 写入类操作的结果，附带给工作台展示的 diff */
export interface WriteResult {
  path: string
  version: string
  created: boolean
  bytes: number
  diff?: string
}

function makeDiff(rel: string, before: string, after: string): string | undefined {
  if (before.length + after.length > MAX_DIFF_CHARS * 4) return undefined
  const d = createTwoFilesPatch('a/' + rel, 'b/' + rel, before, after, '', '', { context: 3 })
  return d.length > MAX_DIFF_CHARS ? d.slice(0, MAX_DIFF_CHARS) + '\n…（diff 过长已截断）' : d
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++
  return n
}

/** 简单 glob：** 跨目录，* 不跨目录；不含 / 的模式只匹配文件名 */
export function globMatcher(glob: string): (rel: string) => boolean {
  const re = new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\/?/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\u0000/g, '.*') +
      '$',
    'i'
  )
  const nameOnly = !glob.includes('/')
  return (rel) => re.test(nameOnly ? rel.slice(rel.lastIndexOf('/') + 1) : rel)
}

interface TextFile {
  abs: string
  rel: string
  buf: Buffer
  text: string
  encoding: TextEncoding
  eol: '\n' | '\r\n'
  version: string
}

/**
 * 按行拆分文本。以换行结尾的文件，末尾那个空串不算一行（"a\nb\n" 是 2 行，不是 3 行），
 * 否则行数、bytes 都会多算，search 的 context_after 里也会多出一个空行
 */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** search 工具的返回值（两个引擎一样，只有 engine 不同） */
export interface SearchToolResult {
  engine: 'ripgrep' | 'bridge'
  results: {
    path: string
    line?: number
    text?: string
    context_before?: string[]
    context_after?: string[]
  }[]
  totalMatches: number
  truncated: boolean
  truncated_reason?: string
  skipped_large_files?: number
  skipped_large_paths?: string[]
  skipped_large_note?: string
  scannedFiles: number
  durationMs: number
}

export class FileTools {
  constructor(
    private readonly guard: PathGuard,
    private readonly trashDir: string
  ) {}

  /** 规范化成工作区相对路径（用于职位的可写路径检查），越界时抛错 */
  relOf(input: string): string {
    return this.guard.resolve(input).rel
  }

  /** apply_patch 用：和其他文件工具同一个路径守卫、同一个回收站 */
  get patchEnv(): PatchEnv {
    return { resolve: (input) => this.guard.resolve(input), trashDir: this.trashDir }
  }

  /** get_diagnostics / lsp 用：同一个路径守卫，只用来判断能不能读 */
  get pathGuard(): PathGuard {
    return this.guard
  }

  /** read_image 用：路径规则和 read_file 一样；超过 maxBytes 只给大小，不读内容 */
  async readBinary(input: string, maxBytes: number): Promise<{ path: string; size: number; data: Buffer | null }> {
    const { abs, rel } = this.guard.resolve(input)
    const st = await this.statOrNull(abs)
    if (!st) throw new ToolError('NOT_FOUND', `${rel} 不存在`)
    if (!st.isFile()) throw new ToolError('NOT_A_FILE', `${rel} 不是文件`)
    if (st.size > maxBytes) return { path: rel, size: st.size, data: null }
    return { path: rel, size: st.size, data: await fsp.readFile(abs) }
  }

  /**
   * screenshot 的 save_path 用：只新建，不覆盖已有文件（不用版本号也不会冲掉别人的改动）。
   * 路径规则和 write_file 一样
   */
  async writeNewBinary(input: string, data: Buffer): Promise<{ path: string; size: number }> {
    const { abs, rel } = this.guard.resolve(input)
    if (rel === '.') throw new ToolError('INVALID_ARGS', '文件名不能为空')
    if (await this.statOrNull(abs)) throw new ToolError('ALREADY_EXISTS', `${rel} 已存在，换一个文件名`)
    await this.atomicWrite(abs, data)
    return { path: rel, size: data.length }
  }

  // ---------- 工作台（用户自己）用 ----------

  /** 绝对路径（「在资源管理器中显示」用），越界时抛错 */
  absOf(input: string): string {
    return this.guard.resolve(input).abs
  }

  /** 整个读进来（最多 5 MB）给编辑器；二进制、太大的只给大小和标记。version 和 read_file 一致 */
  async readWhole(input: string): Promise<{
    path: string
    size: number
    content?: string
    version?: string
    encoding?: string
    eol?: 'lf' | 'crlf'
    binary?: boolean
    tooLarge?: boolean
  }> {
    const { abs, rel } = this.guard.resolve(input)
    const st = await this.statOrNull(abs)
    if (!st) throw new ToolError('NOT_FOUND', `${rel} 不存在`)
    if (!st.isFile()) throw new ToolError('NOT_A_FILE', `${rel} 不是文件`)
    if (st.size > MAX_READ_BYTES) return { path: rel, size: st.size, tooLarge: true }
    const buf = await fsp.readFile(abs)
    const version = versionOf(buf)
    if (isBinary(buf)) return { path: rel, size: buf.length, version, binary: true }
    const { text, encoding, eol } = decode(buf)
    return { path: rel, size: buf.length, content: text, version, encoding, eol: eol === '\r\n' ? 'crlf' : 'lf' }
  }

  /** 新建空文件（父目录自动创建）；已存在时报错 */
  async createFile(input: string): Promise<{ path: string }> {
    const { abs, rel } = this.guard.resolve(input)
    if (rel === '.') throw new ToolError('INVALID_ARGS', '文件名不能为空')
    if (await this.statOrNull(abs)) throw new ToolError('ALREADY_EXISTS', `${rel} 已存在`)
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, '', { flag: 'wx' })
    return { path: rel }
  }

  /** 新建目录；已存在时报错（AI 的 mkdir 已存在不算错） */
  async createDir(input: string): Promise<{ path: string }> {
    const { abs, rel } = this.guard.resolve(input)
    if (rel === '.') throw new ToolError('INVALID_ARGS', '目录名不能为空')
    if (await this.statOrNull(abs)) throw new ToolError('ALREADY_EXISTS', `${rel} 已存在`)
    await fsp.mkdir(abs, { recursive: true })
    return { path: rel }
  }

  private async statOrNull(abs: string): Promise<fs.Stats | null> {
    try {
      return await fsp.stat(abs)
    } catch {
      return null
    }
  }

  private async loadText(input: string): Promise<TextFile> {
    const { abs, rel } = this.guard.resolve(input)
    const st = await this.statOrNull(abs)
    if (!st) throw new ToolError('NOT_FOUND', `${rel} 不存在`)
    if (!st.isFile()) throw new ToolError('NOT_A_FILE', `${rel} 不是文件`)
    if (st.size > MAX_READ_BYTES) throw new ToolError('TOO_LARGE', `${rel} 有 ${st.size} 字节，超过 ${MAX_READ_BYTES} 上限`)
    const buf = await fsp.readFile(abs)
    if (isBinary(buf)) throw new ToolError('BINARY_FILE', `${rel} 是二进制文件，不能按文本处理`, { bytes: st.size })
    const { text, encoding, eol } = decode(buf)
    return { abs, rel, buf, text, encoding, eol, version: versionOf(buf) }
  }

  private checkVersion(file: { rel: string; version: string; text?: string }, expected?: string): void {
    if (expected && expected !== file.version) {
      throw new ToolError('CONFLICT', `${file.rel} 在你读取之后被修改过，请重新 read_file 后再改`, {
        current_version: file.version,
        expected_version: expected
      })
    }
  }

  /** 原子写：临时文件 + rename，避免其他程序读到写了一半的文件 */
  private async atomicWrite(abs: string, data: Buffer): Promise<void> {
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    const tmp = `${abs}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    await fsp.writeFile(tmp, data)
    try {
      await fsp.rename(tmp, abs)
    } catch (e) {
      await fsp.rm(tmp, { force: true })
      // Windows 上目标被编辑器占用时 rename 会 EPERM，退回直接覆盖写
      if ((e as NodeJS.ErrnoException).code === 'EPERM') await fsp.writeFile(abs, data)
      else throw e
    }
  }

  async listDir(input = '.', limit = 1000) {
    const { abs, rel } = this.guard.resolve(input)
    const st = await this.statOrNull(abs)
    if (!st) throw new ToolError('NOT_FOUND', `${rel} 不存在`)
    if (!st.isDirectory()) throw new ToolError('NOT_A_DIRECTORY', `${rel} 不是目录`)
    const dirents = await fsp.readdir(abs, { withFileTypes: true })
    const entries: { name: string; type: 'dir' | 'file' | 'link'; size?: number; mtime?: number }[] = []
    let truncated = false
    for (const d of dirents) {
      const childAbs = path.join(abs, d.name)
      if (this.guard.isHidden(childAbs)) continue
      if (entries.length >= limit) {
        truncated = true
        break
      }
      const type = d.isSymbolicLink() ? 'link' : d.isDirectory() ? 'dir' : 'file'
      const cst = type === 'file' ? await this.statOrNull(childAbs) : null
      entries.push({ name: d.name, type, size: cst?.size, mtime: cst ? Math.round(cst.mtimeMs) : undefined })
    }
    entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)
    return { path: rel, entries, truncated }
  }

  async readFile(input: string, offset = 1, limit = DEFAULT_MAX_LINES, options: { lineNumbers?: boolean; raw?: boolean } = {}) {
    if (options.raw && options.lineNumbers) throw new ToolError('INVALID_ARGS', 'raw 和 line_numbers 不能同时开启')
    const f = await this.loadText(input)
    // 原文模式保留每行实际的结束符（也支持混合 LF / CRLF），不把文件末尾换行算成额外一行。
    const lines = options.raw ? f.text.split(/(?<=\n)/) : splitLines(f.text)
    const start = Math.max(1, Math.floor(offset))
    // 起始行超出文件末尾时明确报错，不再返回「lines: 70000-69999」这种看不懂的空结果
    if (start > Math.max(1, lines.length)) {
      throw new ToolError('INVALID_ARGS', `offset=${start} 超出文件末尾：${f.rel} 一共 ${lines.length} 行`)
    }
    const want = lines.slice(start - 1, start - 1 + Math.max(1, Math.floor(limit)))
    // 逐行累加字节：既要守回包上限，又不能把一行从中间切断。
    // 至少给一行，否则超长首行会变成永远读不到的死循环
    const picked: string[] = []
    let bytes = 0
    let clipped = false
    for (const line of want) {
      let out = line
      if (!options.raw && out.length > MAX_REPLY_LINE_CHARS) {
        const rest = line.length - MAX_REPLY_LINE_CHARS
        out = `${line.slice(0, MAX_REPLY_LINE_CHARS)}…（这一行还有 ${rest} 个字符没显示，建议改用 search 定位）`
        clipped = true
      }
      // 行号只是显示前缀；空文件不凭空产生一行，前缀也计入回包预算。
      if (options.lineNumbers && f.text.length > 0) out = `${start + picked.length}\t${out}`
      const n = Buffer.byteLength(out, 'utf8') + (options.raw ? 0 : 1)
      // 原文不插入裁剪提示；无法整行装入一页时明确报错，避免把失真的内容当原文写回。
      if (options.raw && picked.length === 0 && n > MAX_REPLY_BYTES) {
        throw new ToolError('TOO_LARGE', `第 ${start} 行超过原文模式的 ${MAX_REPLY_BYTES} 字节上限，请关闭 raw 或用 search 定位`)
      }
      if (picked.length > 0 && bytes + n > MAX_REPLY_BYTES) break
      picked.push(out)
      bytes += n
    }
    const end = start + picked.length - 1
    const hasMore = end < lines.length
    return {
      path: f.rel,
      version: f.version,
      encoding: f.encoding,
      eol: f.eol === '\r\n' ? 'CRLF' : 'LF',
      totalLines: lines.length,
      startLine: start,
      endLine: end,
      truncated: hasMore,
      hasMore,
      nextStartLine: hasMore ? end + 1 : undefined,
      bytes,
      longLinesClipped: clipped || undefined,
      content: picked.join(options.raw ? '' : '\n')
    }
  }

  /**
   * 一次读多个文件：AI 经常要同时看几个文件，一个个调 read_file 太费轮次。
   * 单文件和总量都有预算，超预算的跳过并在结果里说明，不让回包无限大。
   */
  async readFiles(inputs: string[], opts: { maxFiles?: number; maxLines?: number } = {}) {
    const maxFiles = Math.min(Math.max(1, Math.floor(opts.maxFiles ?? MAX_BATCH_FILES)), MAX_BATCH_FILES)
    const maxLines = Math.min(Math.max(1, Math.floor(opts.maxLines ?? MAX_BATCH_LINES)), DEFAULT_MAX_LINES)
    const files: Awaited<ReturnType<FileTools['readFile']>>[] = []
    const errors: { path: string; code: string; message: string }[] = []
    let totalBytes = 0
    let budgetExhausted = false
    for (const raw of inputs.slice(0, maxFiles)) {
      const remaining = MAX_BATCH_TOTAL_BYTES - totalBytes
      if (remaining <= 0) {
        budgetExhausted = true
        break
      }
      try {
        const r = await this.readFile(raw, 1, maxLines)
        if (r.bytes > remaining) {
          budgetExhausted = true
          break
        }
        totalBytes += r.bytes
        files.push(r)
      } catch (e) {
        const code = e instanceof ToolError || e instanceof PathError ? e.code : 'INTERNAL'
        errors.push({ path: String(raw), code, message: String((e as Error)?.message ?? e) })
      }
    }
    const handled = files.length + errors.length
    return {
      files,
      errors,
      /** 没读的个数：超出 maxFiles 或总预算用完了 */
      skipped: Math.max(0, inputs.length - handled),
      budgetExhausted,
      totalBytes
    }
  }

  /**
   * 写整个文件。已存在的文件必须带 expected_version 或 overwrite=true，防止覆盖别人的改动。
   * 已存在文件保持原编码和换行符。
   */
  async writeFile(input: string, content: string, expectedVersion?: string, overwrite = false): Promise<WriteResult> {
    const { abs, rel } = this.guard.resolve(input)
    const st = await this.statOrNull(abs)
    if (st?.isDirectory()) throw new ToolError('NOT_A_FILE', `${rel} 是目录`)
    if (st) {
      const f = await this.loadText(input)
      if (!expectedVersion && !overwrite) {
        throw new ToolError('VERSION_REQUIRED', `${rel} 已存在。先 read_file 拿到 version 再传 expected_version，或确认要覆盖时传 overwrite=true`, {
          current_version: f.version
        })
      }
      this.checkVersion(f, expectedVersion)
      const normalized = f.eol === '\r\n' ? content.replace(/\r?\n/g, '\r\n') : content
      const data = encode(normalized, f.encoding)
      await this.atomicWrite(abs, data)
      return { path: rel, version: versionOf(data), created: false, bytes: data.length, diff: makeDiff(rel, f.text, normalized) }
    }
    const data = Buffer.from(content, 'utf8')
    await this.atomicWrite(abs, data)
    return { path: rel, version: versionOf(data), created: true, bytes: data.length, diff: makeDiff(rel, '', content) }
  }

  /** 精确字符串替换；old_string 必须唯一匹配（replace_all 除外），按顺序依次应用 */
  async editFile(
    input: string,
    edits: { old_string: string; new_string: string; replace_all?: boolean }[],
    expectedVersion?: string
  ): Promise<WriteResult & { replacements: number }> {
    if (!edits.length) throw new ToolError('INVALID_ARGS', 'edits 不能为空')
    const f = await this.loadText(input)
    this.checkVersion(f, expectedVersion)
    // 内部统一用 LF 匹配，写回时恢复 CRLF
    let text = f.text.replace(/\r\n/g, '\n')
    let replacements = 0
    edits.forEach((e, i) => {
      const oldStr = e.old_string.replace(/\r\n/g, '\n')
      const newStr = e.new_string.replace(/\r\n/g, '\n')
      if (oldStr === '') throw new ToolError('INVALID_ARGS', `第 ${i + 1} 处 old_string 为空`)
      if (oldStr === newStr) throw new ToolError('INVALID_ARGS', `第 ${i + 1} 处 old_string 与 new_string 相同`)
      const n = countOccurrences(text, oldStr)
      if (n === 0) throw new ToolError('NOT_FOUND', `第 ${i + 1} 处 old_string 在 ${f.rel} 中找不到，请重新读取文件确认原文`)
      if (n > 1 && !e.replace_all) {
        throw new ToolError('AMBIGUOUS', `第 ${i + 1} 处 old_string 匹配到 ${n} 处，请加长上下文使其唯一，或设 replace_all=true`)
      }
      text = e.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr)
      replacements += e.replace_all ? n : 1
    })
    const out = f.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text
    const data = encode(out, f.encoding)
    await this.atomicWrite(f.abs, data)
    return {
      path: f.rel,
      version: versionOf(data),
      created: false,
      bytes: data.length,
      replacements,
      diff: makeDiff(f.rel, f.text, out)
    }
  }

  /** 遍历工作区（跳过受保护项、符号链接和常见依赖目录） */
  private async *walk(dirAbs: string, deadline: number): AsyncGenerator<{ abs: string; rel: string; isDir: boolean }> {
    let dirents: fs.Dirent[]
    try {
      dirents = await fsp.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of dirents) {
      if (Date.now() > deadline) return
      const abs = path.join(dirAbs, d.name)
      if (d.isSymbolicLink() || this.guard.isTraverseSkip(abs)) continue
      const rel = this.guard.toRel(abs)
      if (d.isDirectory()) {
        yield { abs, rel, isDir: true }
        // 整台电脑：系统目录、AppData 这类不往里走（直接把它们当起点时照常搜）
        if (!SKIP_DIRS.has(d.name) && !this.guard.isMachineSkipDir(abs)) yield* this.walk(abs, deadline)
      } else if (d.isFile()) {
        yield { abs, rel, isDir: false }
      }
    }
  }

  /** 搜索 / 找文件的起点：整台电脑不许一次扫整个盘 */
  private scanBase(input: string | undefined) {
    const base = this.guard.resolve(input ?? '.')
    if (this.guard.machine && this.guard.isDriveRoot(base.abs)) {
      throw new ToolError('INVALID_ARGS', `整台电脑模式下不能直接搜整个盘（${base.rel}），path 请给一个具体目录，比如 ${base.rel.replace(/\/?$/, '/')}某个项目`)
    }
    return base
  }

  async search(opts: {
    query: string
    path?: string
    mode?: 'content' | 'name'
    regex?: boolean
    caseSensitive?: boolean
    glob?: string
    include?: string[]
    exclude?: string[]
    contextLines?: number
    maxMatchesPerFile?: number
    maxResults?: number
  }): Promise<SearchToolResult> {
    const started = Date.now()
    const { query, mode = 'content', regex = false } = opts
    if (!query) throw new ToolError('INVALID_ARGS', 'query 不能为空')
    if (regex && query.length > 500) throw new ToolError('INVALID_ARGS', '正则过长')
    // 不传 case_sensitive 时按 smart-case：模式里有大写就区分大小写（照 ShunCode）
    const caseSensitive = opts.caseSensitive === true || (opts.caseSensitive === undefined && /[A-Z]/.test(query))
    let re: RegExp
    try {
      re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? '' : 'i')
    } catch (e) {
      throw new ToolError('INVALID_ARGS', `正则无效：${(e as Error).message}`)
    }
    const maxResults = Math.min(500, Math.max(1, Math.floor(opts.maxResults ?? 100)))
    const maxPerFile = Math.min(100, Math.max(1, Math.floor(opts.maxMatchesPerFile ?? 20)))
    const contextLines = Math.min(5, Math.max(0, Math.floor(opts.contextLines ?? 0)))
    const includeGlobs = [...(opts.glob ? [opts.glob] : []), ...(opts.include ?? [])].filter(Boolean)
    const include = includeGlobs.flatMap((g) => g.split(',').map((x) => x.trim()).filter(Boolean)).map(globMatcher)
    const exclude = (opts.exclude ?? []).flatMap((g) => g.split(',').map((x) => x.trim()).filter(Boolean)).map(globMatcher)
    let base = this.scanBase(opts.path)
    const deadline = started + 10_000
    // path 指到单个文件：只搜这一个。起点换成它所在的目录（ripgrep 的工作目录、遍历的起点都得是目录），结果里的路径写法不变
    let only: { abs: string; rel: string; isDir: boolean } | undefined
    try {
      if ((await fsp.stat(base.abs)).isFile()) {
        only = { abs: base.abs, rel: this.guard.toRel(base.abs), isDir: false }
        const dir = path.dirname(base.abs)
        base = { ...base, abs: dir, rel: this.guard.toRel(dir) }
      }
    } catch {
      /* 路径不存在：照旧往下走，结果是 0 条 */
    }
    if (mode === 'content') {
      const viaRg = await this.searchWithRipgrep({ query, regex, caseSensitive, maxResults, maxPerFile, contextLines, include, exclude, base, deadline, started, target: only ? path.basename(only.abs) : undefined })
      if (viaRg) return viaRg
    }
    const results: SearchToolResult['results'] = []
    let scanned = 0
    let skippedLarge = 0
    const skippedLargePaths: string[] = []
    let hitFileCap = false
    // 内容搜索时提前读后面的文件（最多 SEARCH_READ_AHEAD 个同时在读），但仍按遍历顺序逐个处理，结果顺序和串行时一样
    const pending: { rel: string; read: Promise<Buffer | 'large' | null> }[] = []
    const one = only
    const walker = (one
      ? (async function* (): AsyncGenerator<{ abs: string; rel: string; isDir: boolean }> {
          yield one
        })()
      : this.walk(base.abs, deadline))[Symbol.asyncIterator]()
    let walkDone = false
    const fill = async (): Promise<void> => {
      while (!walkDone && pending.length < SEARCH_READ_AHEAD) {
        const next = await walker.next()
        if (next.done) {
          walkDone = true
          return
        }
        const e = next.value
        if (exclude.some((m) => m(e.rel))) continue
        if (include.length && !include.some((m) => m(e.rel))) continue
        if (mode === 'name') {
          if (re.test(e.rel.slice(e.rel.lastIndexOf('/') + 1))) results.push({ path: e.rel + (e.isDir ? '/' : '') })
          if (results.length >= maxResults) walkDone = true
          continue
        }
        if (e.isDir || isBinaryExt(e.rel)) continue
        const read = readSearchable(e.abs, 2 * 1024 * 1024)
        read.catch(() => {})
        pending.push({ rel: e.rel, read })
      }
    }
    for (;;) {
      if (results.length >= maxResults) break
      await fill()
      const item = pending.shift()
      if (!item) break
      const e = { rel: item.rel }
      const buf = await item.read
      if (buf === 'large') {
        skippedLarge++
        if (skippedLargePaths.length < 20) skippedLargePaths.push(e.rel)
        continue
      }
      if (!buf) continue
      scanned++
      const text = decode(buf).text
      // 字面搜索先整篇查一次，绝大多数文件不含关键词，不用拆行（正则可能带 ^ $，只能逐行）
      if (!regex && !re.test(text)) continue
      const lines = splitLines(text)
      let inFile = 0
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= maxResults) break
        re.lastIndex = 0
        if (!re.test(lines[i])) continue
        if (inFile >= maxPerFile) {
          hitFileCap = true
          break
        }
        inFile++
        const entry: (typeof results)[number] = { path: e.rel, line: i + 1, text: lines[i].slice(0, 300) }
        if (contextLines > 0) {
          const before = lines.slice(Math.max(0, i - contextLines), i).map((s) => s.slice(0, 300))
          const after = lines.slice(i + 1, i + 1 + contextLines).map((s) => s.slice(0, 300))
          if (before.length) entry.context_before = before
          if (after.length) entry.context_after = after
        }
        results.push(entry)
      }
    }
    // 提前停下时关掉遍历；已经发出去的读取各自结束，结果不要了
    await walker.return?.(undefined)
    const timedOut = Date.now() > deadline
    const hitResultCap = results.length >= maxResults
    const truncatedReason = timedOut ? 'timeout' : hitResultCap ? 'max_results' : hitFileCap ? 'max_matches_per_file' : undefined
    return {
      engine: 'bridge',
      results,
      totalMatches: results.length,
      truncated: !!truncatedReason,
      ...(truncatedReason ? { truncated_reason: truncatedReason } : {}),
      ...(skippedLarge
        ? {
            skipped_large_files: skippedLarge,
            skipped_large_paths: skippedLargePaths,
            skipped_large_note: '超过 2 MB 的文件不搜内容；需要的话用 read_file 加 offset 分段读，或用 run_command 里的 grep'
          }
        : {}),
      scannedFiles: scanned,
      durationMs: Date.now() - started
    }
  }

  /**
   * search 的 ripgrep 后端（只做内容搜索）。返回 null 表示这次用不了 rg，走上面的 JS 引擎。
   * 安全：凭据、.git、数据目录、SKIP_DIRS、二进制扩展名先用 --glob 排掉不让 rg 读；
   * 每个结果再过 guard.isAllowedResult（逐段检查 + realpath，junction 指到工作区外的丢掉）。
   * 顺序：按路径排（rg 的 --sort path 会变成单线程，9.5 万文件从 4 秒变 37 秒，所以在这里排）。
   * gitignore 用 rg 的完整规则（JS 引擎不看 gitignore），编码差异见 ripgrep.ts 开头
   */
  private async searchWithRipgrep(o: {
    query: string
    regex: boolean
    caseSensitive: boolean
    maxResults: number
    maxPerFile: number
    contextLines: number
    include: ((rel: string) => boolean)[]
    exclude: ((rel: string) => boolean)[]
    base: { abs: string; rel: string }
    deadline: number
    started: number
    /** 只搜起点目录下的这一个文件（文件名）；不给就搜整个目录 */
    target?: string
  }): Promise<SearchToolResult | null> {
    const rgPath = findRipgrep()
    if (!rgPath) return null
    if (/[\r\n]/.test(o.query)) return null
    let pattern = o.query
    let pcre2 = false
    if (o.regex) {
      const t = jsRegexToRg(o.query, false)
      if ('unsupported' in t) return null
      pattern = t.pattern
      pcre2 = t.pcre2
      if (pcre2 && !ripgrepHasPcre2(rgPath)) return null
    }
    const args = [
      '--debug',
      '--no-config',
      '--hidden',
      '--no-require-git',
      '--crlf',
      '--max-filesize',
      '2M',
      '--max-count',
      String(o.maxPerFile + 1),
      o.caseSensitive ? '--case-sensitive' : '--ignore-case',
      ...(o.contextLines ? ['--context', String(o.contextLines)] : []),
      ...(o.regex ? [] : ['--fixed-strings']),
      ...(pcre2 ? ['--pcre2'] : []),
      // SKIP_DIRS 在 JS 遍历里区分大小写，这里也用 --glob（不是 --iglob）
      ...[...SKIP_DIRS].map((d) => `--glob=!${d}/`),
      ...guardExcludeArgs(this.guard, o.base.abs),
      '--regexp',
      pattern,
      '--',
      o.target ?? '.'
    ]
    const realCache = new Map<string, string>()
    const toRel = (rgRel: string): string | null => {
      const abs = path.resolve(o.base.abs, rgRel)
      if (!this.guard.isAllowedResult(abs, o.base.abs, realCache)) return null
      const rel = this.guard.toRel(abs)
      // 起点以下的目录不能是 SKIP_DIRS（rg 已经排过，这里兜底）
      const parts = path.relative(o.base.abs, abs).split(path.sep)
      if (parts.slice(0, -1).some((s) => SKIP_DIRS.has(s))) return null
      if (o.exclude.some((m) => m(rel))) return null
      if (o.include.length && !o.include.some((m) => m(rel))) return null
      if (isBinaryExt(rel)) return null
      return rel
    }
    const files: { rel: string; f: RgFile }[] = []
    const large: string[] = []
    let lines = 0
    let seen = 0
    const r = await runRipgrep({
      rgPath,
      cwd: o.base.abs,
      args,
      timeoutMs: o.deadline - Date.now(),
      onSkippedLarge: (p) => {
        const rel = toRel(p)
        if (rel !== null) large.push(rel)
      },
      onFile: (f) => {
        seen++
        const rel = toRel(f.rel)
        if (rel === null) return
        files.push({ rel, f })
        lines += Math.min(f.matches.length, o.maxPerFile)
        // 多收一些再排序截断，结果基本按路径稳定；匹配特别多时只在这批里排
        return lines >= o.maxResults * 4
      }
    })
    if (r.status === 'failed' && !files.length) return null
    files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    const results: SearchToolResult['results'] = []
    let hitFileCap = false
    for (const { rel, f } of files) {
      if (results.length >= o.maxResults) break
      const text = new Map<number, string>(f.context)
      for (const m of f.matches) text.set(m.line, m.text)
      let inFile = 0
      for (const m of f.matches) {
        if (results.length >= o.maxResults) break
        if (inFile >= o.maxPerFile) {
          hitFileCap = true
          break
        }
        inFile++
        const entry: SearchToolResult['results'][number] = { path: rel, line: m.line, text: m.text.slice(0, 300) }
        if (o.contextLines > 0) {
          const before: string[] = []
          const after: string[] = []
          for (let i = Math.max(1, m.line - o.contextLines); i < m.line; i++) {
            const t = text.get(i)
            if (t !== undefined) before.push(t.slice(0, 300))
          }
          for (let i = m.line + 1; i <= m.line + o.contextLines; i++) {
            const t = text.get(i)
            if (t === undefined) break
            after.push(t.slice(0, 300))
          }
          if (before.length) entry.context_before = before
          if (after.length) entry.context_after = after
        }
        results.push(entry)
      }
    }
    const timedOut = r.status === 'timeout'
    const hitResultCap = results.length >= o.maxResults
    const truncatedReason = timedOut ? 'timeout' : hitResultCap ? 'max_results' : hitFileCap ? 'max_matches_per_file' : undefined
    large.sort()
    return {
      engine: 'ripgrep',
      results,
      totalMatches: results.length,
      truncated: !!truncatedReason,
      ...(truncatedReason ? { truncated_reason: truncatedReason } : {}),
      ...(large.length
        ? {
            skipped_large_files: large.length,
            skipped_large_paths: large.slice(0, 20),
            skipped_large_note: '超过 2 MB 的文件不搜内容；需要的话用 read_file 加 offset 分段读，或用 run_command 里的 grep'
          }
        : {}),
      scannedFiles: r.searched ?? seen,
      durationMs: Date.now() - o.started
    }
  }

  /**
   * 按文件名 / glob 找文件（find_files）。只走目录不读内容，比全文搜索快得多。
   * pattern 里有 * ? [ 就当 glob，否则当文件名子串。
   */
  async findFiles(opts: { pattern?: string; path?: string; include?: string[]; exclude?: string[]; maxResults?: number }) {
    const started = Date.now()
    const max = Math.min(500, Math.max(1, Math.floor(opts.maxResults ?? 100)))
    const base = this.scanBase(opts.path)
    const raw = (opts.pattern ?? '').trim()
    const globLike = /[*?[\]]/.test(raw)
    const match = globLike ? globMatcher(raw) : null
    const needle = raw.toLowerCase()
    const include = (opts.include ?? []).flatMap((g) => g.split(',')).map((x) => x.trim()).filter(Boolean).map(globMatcher)
    const exclude = (opts.exclude ?? []).flatMap((g) => g.split(',')).map((x) => x.trim()).filter(Boolean).map(globMatcher)
    const files: { path: string; size: number; mtime: string }[] = []
    const deadline = started + 10_000
    for await (const e of this.walk(base.abs, deadline)) {
      if (e.isDir) continue
      if (exclude.some((m) => m(e.rel))) continue
      if (include.length && !include.some((m) => m(e.rel))) continue
      const name = e.rel.slice(e.rel.lastIndexOf('/') + 1)
      const ok = match ? match(e.rel) : !needle || name.toLowerCase().includes(needle)
      if (!ok) continue
      const st = await this.statOrNull(e.abs)
      files.push({ path: e.rel, size: st?.size ?? 0, mtime: st ? new Date(st.mtimeMs).toISOString() : '' })
      if (files.length >= max) break
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const truncatedReason = files.length >= max ? 'max_results' : Date.now() > deadline ? 'timeout' : undefined
    return {
      files,
      count: files.length,
      truncated: !!truncatedReason,
      ...(truncatedReason ? { truncated_reason: truncatedReason } : {}),
      durationMs: Date.now() - started
    }
  }

  async fileInfo(input: string) {
    const { abs, rel } = this.guard.resolve(input)
    const st = await this.statOrNull(abs)
    if (!st) return { path: rel, exists: false }
    const info: Record<string, unknown> = {
      path: rel,
      exists: true,
      type: st.isDirectory() ? 'dir' : 'file',
      size: st.size,
      mtime: new Date(st.mtimeMs).toISOString()
    }
    if (st.isFile() && st.size <= MAX_READ_BYTES) {
      const buf = await fsp.readFile(abs)
      info.version = versionOf(buf)
      info.binary = isBinary(buf)
      if (!info.binary) info.encoding = decode(buf).encoding
    }
    return info
  }

  async mkdir(input: string) {
    const { abs, rel } = this.guard.resolve(input)
    await fsp.mkdir(abs, { recursive: true })
    return { path: rel, created: true }
  }

  async move(from: string, to: string, expectedVersion?: string, overwrite = false) {
    const src = this.guard.resolve(from)
    const dst = this.guard.resolve(to)
    if (src.rel === '.' || this.guard.isDriveRoot(src.abs)) throw new ToolError('INVALID_ARGS', '不能移动工作区根目录')
    if (this.guard.isDriveRoot(dst.abs)) throw new ToolError('INVALID_ARGS', '目标不能是整个盘的根目录')
    // 数据目录（有 token）的上级目录不能挪：挪走后 token 就不在保护范围里了；覆盖目标同理
    if (this.guard.containsProtected(src.abs)) throw new ToolError('PROTECTED', `${src.rel} 里面有本应用的数据目录，不能移动`)
    if (this.guard.containsProtected(dst.abs)) throw new ToolError('PROTECTED', `${dst.rel} 里面有本应用的数据目录，不能覆盖`)
    // 没对你开放的工作区也一样：挪走它的上级目录等于把它整个带走
    const fencedSrc = this.guard.containsFenced(src.abs)
    if (fencedSrc) throw new ToolError('WORKSPACE_FORBIDDEN', `${src.rel} 里面有工作区「${fencedSrc}」，它没有对你开放，不能移动`)
    const fencedDst = this.guard.containsFenced(dst.abs)
    if (fencedDst) throw new ToolError('WORKSPACE_FORBIDDEN', `${dst.rel} 里面有工作区「${fencedDst}」，它没有对你开放，不能覆盖`)
    const st = await this.statOrNull(src.abs)
    if (!st) throw new ToolError('NOT_FOUND', `${src.rel} 不存在`)
    if (expectedVersion && st.isFile()) this.checkVersion({ rel: src.rel, version: versionOf(await fsp.readFile(src.abs)) }, expectedVersion)
    // Windows / macOS 只改大小写（a.ts → A.ts）时目标就是来源自己，不能当成已存在，更不能把它扔进回收站
    const sameFile = CASE_INSENSITIVE_FS && src.abs !== dst.abs && src.abs.toLowerCase() === dst.abs.toLowerCase()
    const dstSt = sameFile ? null : await this.statOrNull(dst.abs)
    if (dstSt && !overwrite) throw new ToolError('ALREADY_EXISTS', `${dst.rel} 已存在，确认覆盖请传 overwrite=true`)
    if (dstSt) await this.moveToTrash(dst.abs, dst.rel)
    await fsp.mkdir(path.dirname(dst.abs), { recursive: true })
    try {
      await fsp.rename(src.abs, dst.abs)
    } catch (e) {
      // 整台电脑模式下可能跨盘移动（C: → D:），rename 不能跨盘，改为复制后删除
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
      try {
        await fsp.cp(src.abs, dst.abs, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })
      } catch (cpErr) {
        // 复制到一半失败：源还完整，删掉目标的半截副本，下次重试不会撞上「已存在」。
        // 目标已存在（检查之后别的进程建的）时不删，那不是这次复制出来的
        const code = (cpErr as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'ERR_FS_CP_EEXIST') await fsp.rm(dst.abs, { recursive: true, force: true }).catch(() => {})
        throw cpErr
      }
      try {
        await fsp.rm(src.abs, { recursive: true, force: true })
      } catch (rmErr) {
        // 复制已完整，删源时有文件被占用：数据都在目标里，按成功返回并说明，让调用方照常记检查点
        return { from: src.rel, to: dst.rel, warning: `已复制到目标，但来源没删干净（${(rmErr as Error).message}），来源里可能还剩部分文件` }
      }
    }
    return { from: src.rel, to: dst.rel }
  }

  /** 删除 = 移进回收站，可以在工作台恢复 */
  async delete(input: string, expectedVersion?: string) {
    const { abs, rel } = this.guard.resolve(input)
    if (rel === '.' || this.guard.isDriveRoot(abs)) throw new ToolError('INVALID_ARGS', '不能删除工作区根目录')
    if (this.guard.containsProtected(abs)) throw new ToolError('PROTECTED', `${rel} 里面有本应用的数据目录，不能删除`)
    const fenced = this.guard.containsFenced(abs)
    if (fenced) throw new ToolError('WORKSPACE_FORBIDDEN', `${rel} 里面有工作区「${fenced}」，它没有对你开放，不能删除`)
    const st = await this.statOrNull(abs)
    if (!st) throw new ToolError('NOT_FOUND', `${rel} 不存在`)
    if (expectedVersion && st.isFile()) this.checkVersion({ rel, version: versionOf(await fsp.readFile(abs)) }, expectedVersion)
    const trashId = await this.moveToTrash(abs, rel)
    return { path: rel, trashId, recoverable: true }
  }

  private async moveToTrash(abs: string, rel: string): Promise<string> {
    const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
    const dir = path.join(this.trashDir, id)
    await fsp.mkdir(dir, { recursive: true })
    const target = path.join(dir, path.basename(abs))
    try {
      await fsp.rename(abs, target)
    } catch (e) {
      // 工作区和回收站不在同一个盘时 rename 失败，改为复制后删除
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
      // verbatimSymlinks：链接原样复制，不顺着 junction 把工作区外的内容拷进回收站
      await fsp.cp(abs, target, { recursive: true, verbatimSymlinks: true })
      await fsp.rm(abs, { recursive: true, force: true })
    }
    // absPath：回收站是所有工作区共用的，恢复时靠它知道原来在哪
    await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ originalPath: rel, absPath: abs, deletedAt: Date.now() }))
    return id
  }
}

export { PathError }
