import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type * as TS from 'typescript'
import { ToolError } from './fileTools'
import type { PathGuard } from './pathGuard'

// get_diagnostics / lsp：Bridge 没有 VS Code，这里直接用 TypeScript 自带的语言服务（和 VS Code 的 TS/JS 支持是同一个引擎）。
// 只支持 TS / JS。安全上：
// - 只加载 Bridge 自己带的 typescript，绝不加载工作区 node_modules 里的（那是 AI 能写的代码，加载就等于绕过命令权限执行代码）。
// - 语言服务读文件走同一个路径守卫：工作区内按 read_file 的规则（敏感文件、受保护目录读不到），
//   工作区外只放行 TypeScript 自带的 lib 和 node_modules 里的声明，其他一律当作不存在。

type Ts = typeof TS
export type Severity = 'error' | 'warning' | 'information' | 'hint'

export const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i
/** 目录扫描跳过的目录（以点开头的目录另外统一跳过） */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'coverage'])
/** 同时缓存的语言服务个数，超出按最久没用的释放 */
const MAX_PROJECTS = 8
/** 目录级诊断最多扫多少个文件、最长多久 */
const MAX_SCAN_FILES = 3000
const DIAG_BUDGET_MS = 45_000
/** 配置文件和文件列表多久重新读一次 */
const REPARSE_MS = 1500

let tsCache: Ts | null | undefined
let tsError = ''
export function loadTypeScript(): Ts | null {
  if (tsCache !== undefined) return tsCache
  try {
    tsCache = createRequire(import.meta.url)('typescript') as Ts
  } catch (e) {
    tsCache = null
    tsError = (e as Error).message
  }
  return tsCache
}

function requireTs(): Ts {
  const ts = loadTypeScript()
  if (!ts) throw new ToolError('NO_LANGUAGE_SERVICE', `Bridge 没找到内置的 TypeScript 语言服务（${tsError}）。可以先用 run_command 跑 npx tsc --noEmit 代替。`)
  return ts
}

interface Project {
  key: string
  /** tsconfig / jsconfig 的绝对路径；推断项目没有 */
  configPath?: string
  source: 'tsconfig' | 'jsconfig' | 'inferred'
  dir: string
  options: TS.CompilerOptions
  fileNames: string[]
  refs?: readonly TS.ProjectReference[]
  errors: TS.Diagnostic[]
  service: TS.LanguageService
  parsedAt: number
  warm: boolean
}

export interface Loc {
  path: string
  external?: true
  line: number
  column: number
  end_line: number
  end_column: number
  preview?: string
}

export interface DiagItem {
  path: string
  line: number | null
  column: number | null
  end_line?: number
  end_column?: number
  severity: Severity
  code: string
  message: string
  source: 'ts'
}

const instances = new Map<string, CodeIntel>()
/** 每个工作区根目录一个实例（缓存语言服务） */
export function codeIntelFor(guard: PathGuard): CodeIntel {
  // 整台电脑的起始目录可能和某个普通工作区相同，两者的访问范围不同，分开缓存
  const key = (guard.machine ? 'machine:' : '') + guard.root
  let ci = instances.get(key)
  if (!ci) {
    ci = new CodeIntel(guard)
    instances.set(key, ci)
  } else {
    ci.guard = guard
  }
  return ci
}

export class CodeIntel {
  private readonly ts: Ts
  private readonly registry: TS.DocumentRegistry
  private readonly projects = new Map<string, Project>()
  private readonly access = new Map<string, string | null>()
  private readonly libDir: string

  constructor(public guard: PathGuard) {
    this.ts = requireTs()
    this.registry = this.ts.createDocumentRegistry(this.ts.sys.useCaseSensitiveFileNames)
    this.libDir = path.dirname(this.ts.getDefaultLibFilePath({}))
  }

  get engine(): string {
    return `TypeScript ${this.ts.version}（Bridge 内置语言服务）`
  }

  // ---------- 访问控制 ----------

  /** 工作区内且允许读 → 相对路径；工作区外但允许读（TS 自带 lib、node_modules）→ ''；不允许 → null */
  private check(file: string): string | null {
    const abs = path.resolve(file)
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs
    const hit = this.access.get(key)
    if (hit !== undefined) return hit
    let res: string | null
    const rel = path.relative(this.guard.root, abs)
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      try {
        res = this.guard.resolve(rel || '.').rel
        if (this.guard.isHidden(abs)) res = null
      } catch {
        res = null
      }
    } else if (isInside(this.libDir, abs) || /[\\/]node_modules[\\/]/.test(abs)) {
      res = ''
    } else if (this.guard.machine) {
      // 整台电脑：根目录外的文件按绝对路径过一遍 guard（黑名单、数据目录照样拦）
      try {
        res = this.guard.resolve(abs).rel
        if (this.guard.isHidden(abs)) res = null
      } catch {
        res = null
      }
    } else {
      res = null
    }
    if (this.access.size > 50_000) this.access.clear()
    this.access.set(key, res)
    return res
  }

  private allowed(file: string): boolean {
    return this.check(file) !== null
  }

  /** 给 AI 看的路径：工作区内是相对路径，外面的只给 typescript/lib/xxx 或 node_modules/xxx */
  private shownPath(file: string): { path: string; external?: true } {
    const r = this.check(file)
    if (r) return { path: r }
    const abs = path.resolve(file)
    if (isInside(this.libDir, abs)) return { path: 'typescript/lib/' + path.basename(abs), external: true }
    const norm = abs.replace(/\\/g, '/')
    const i = norm.lastIndexOf('/node_modules/')
    return { path: i >= 0 ? norm.slice(i + 1) : path.basename(abs), external: true }
  }

  // ---------- 项目 ----------

  private stamp(file: string): string {
    try {
      const st = fs.statSync(file)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return '0'
    }
  }

  /** p 是项目对象本身：之后改它的 options / fileNames，语言服务都能看到 */
  private makeService(p: Omit<Project, 'service'>): TS.LanguageService {
    const ts = this.ts
    const host: TS.LanguageServiceHost = {
      getCompilationSettings: () => p.options,
      getScriptFileNames: () => p.fileNames,
      getScriptVersion: (f) => this.stamp(f),
      getScriptSnapshot: (f) => {
        if (!this.allowed(f)) return undefined
        const text = ts.sys.readFile(f)
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
      },
      getCurrentDirectory: () => p.dir,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: (f) => this.allowed(f) && ts.sys.fileExists(f),
      readFile: (f, enc) => (this.allowed(f) ? ts.sys.readFile(f, enc) : undefined),
      readDirectory: (d, ext, exc, inc, depth) => ts.sys.readDirectory(d, ext, exc, inc, depth).filter((f) => this.allowed(f)),
      directoryExists: (d) => ts.sys.directoryExists(d),
      getDirectories: (d) => ts.sys.getDirectories(d),
      realpath: ts.sys.realpath ? (f) => ts.sys.realpath!(f) : undefined,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames
    }
    return ts.createLanguageService(host, this.registry)
  }

  private parseConfig(configPath: string): { options: TS.CompilerOptions; fileNames: string[]; refs?: readonly TS.ProjectReference[]; errors: TS.Diagnostic[] } {
    const ts = this.ts
    const read = ts.readConfigFile(configPath, (f) => (this.allowed(f) ? ts.sys.readFile(f) : undefined))
    if (read.error) return { options: {}, fileNames: [], errors: [read.error] }
    const host: TS.ParseConfigHost = {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      readDirectory: (d, ext, exc, inc, depth) => ts.sys.readDirectory(d, ext, exc, inc, depth).filter((f) => this.allowed(f)),
      fileExists: (f) => this.allowed(f) && ts.sys.fileExists(f),
      readFile: (f) => (this.allowed(f) ? ts.sys.readFile(f) : undefined)
    }
    const parsed = ts.parseJsonConfigFileContent(read.config, host, path.dirname(configPath), undefined, configPath)
    const refs = parsed.projectReferences
    // 解决方案式 tsconfig（files: [] + references）会报 “No inputs were found”，不算错
    const errors = parsed.errors.filter((e) => !(e.code === 18003 && refs && refs.length))
    return { options: { ...parsed.options, noEmit: true }, fileNames: parsed.fileNames, refs, errors }
  }

  private remember(p: Project): Project {
    this.projects.delete(p.key)
    this.projects.set(p.key, p)
    while (this.projects.size > MAX_PROJECTS) {
      const oldest = this.projects.keys().next().value as string
      this.projects.get(oldest)?.service.dispose()
      this.projects.delete(oldest)
    }
    return p
  }

  private configured(configPath: string): Project {
    const key = 'cfg:' + configPath.toLowerCase()
    const old = this.projects.get(key)
    if (old && Date.now() - old.parsedAt < REPARSE_MS) return this.remember(old)
    const parsed = this.parseConfig(configPath)
    if (old) {
      old.options = parsed.options
      old.fileNames = parsed.fileNames
      old.refs = parsed.refs
      old.errors = parsed.errors
      old.parsedAt = Date.now()
      return this.remember(old)
    }
    const proj = {
      key,
      configPath,
      source: /jsconfig\.json$/i.test(configPath) ? 'jsconfig' : 'tsconfig',
      dir: path.dirname(configPath),
      ...parsed,
      parsedAt: Date.now(),
      warm: false
    } as Project
    proj.service = this.makeService(proj)
    return this.remember(proj)
  }

  private inferred(fileAbs: string, baseOptions?: TS.CompilerOptions): Project {
    const ts = this.ts
    const key = 'inferred:' + (baseOptions ? 'cfg' : 'none')
    const options: TS.CompilerOptions = baseOptions
      ? { ...baseOptions, allowJs: true, noEmit: true }
      : {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          allowJs: true,
          checkJs: false,
          jsx: ts.JsxEmit.Preserve,
          esModuleInterop: true,
          resolveJsonModule: true,
          skipLibCheck: true,
          strictNullChecks: true,
          strictFunctionTypes: true,
          noEmit: true
        }
    let p = this.projects.get(key)
    if (!p) {
      const proj = { key, source: 'inferred', dir: this.guard.root, options, fileNames: [], errors: [], parsedAt: Date.now(), warm: false } as unknown as Project
      proj.service = this.makeService(proj)
      p = proj
    }
    p.options = options
    const norm = (f: string): string => path.resolve(f).toLowerCase()
    if (!p.fileNames.some((f) => norm(f) === norm(fileAbs))) {
      p.fileNames = [...p.fileNames, fileAbs].slice(-200)
    }
    return this.remember(p)
  }

  /** 从 dir 往上找 tsconfig.json / jsconfig.json，最多找到工作区根目录（整台电脑找到盘根） */
  findConfig(dir: string): string | undefined {
    let cur = path.resolve(dir)
    for (;;) {
      if (!this.guard.machine && !isInside(this.guard.root, cur)) return undefined
      for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const f = path.join(cur, name)
        if (this.allowed(f) && fs.existsSync(f)) return f
      }
      const up = path.dirname(cur)
      if (up === cur) return undefined
      cur = up
    }
  }

  /** 解决方案式配置引用的子配置（递归 3 层） */
  private subConfigs(configPath: string, depth = 0): string[] {
    if (depth > 3) return []
    const refs = this.configured(configPath).refs ?? []
    const out: string[] = []
    for (const r of refs) {
      let f = path.resolve(path.dirname(configPath), r.path)
      if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'tsconfig.json')
      if (!this.allowed(f) || !fs.existsSync(f)) continue
      out.push(f, ...this.subConfigs(f, depth + 1))
    }
    return out
  }

  private contains(p: Project, fileAbs: string): boolean {
    const want = path.resolve(fileAbs).toLowerCase()
    return p.fileNames.some((f) => path.resolve(f).toLowerCase() === want)
  }

  projectForFile(fileAbs: string): Project {
    const cfg = this.findConfig(path.dirname(fileAbs))
    if (!cfg) return this.inferred(fileAbs)
    const p = this.configured(cfg)
    if (this.contains(p, fileAbs)) return p
    for (const sub of this.subConfigs(cfg)) {
      const sp = this.configured(sub)
      if (this.contains(sp, fileAbs)) return sp
    }
    return this.inferred(fileAbs, p.options)
  }

  /** 目录（或整个工作区）对应的项目：自身或上层的配置，加上解决方案引用的子配置 */
  private projectsForDir(dirAbs: string): Project[] {
    const cfg = this.findConfig(dirAbs)
    if (!cfg) return []
    return [cfg, ...this.subConfigs(cfg)].map((c) => this.configured(c)).filter((p) => p.fileNames.length > 0)
  }

  private anchor(p: Project): { project_anchor: string; project_anchor_source: string } {
    return {
      project_anchor: p.configPath ? this.check(p.configPath) || path.basename(p.configPath) : 'inferred',
      project_anchor_source: p.source
    }
  }

  // ---------- 诊断 ----------

  private toItem(d: TS.Diagnostic, fallbackPath: string): DiagItem {
    const ts = this.ts
    const sev: Severity =
      d.category === ts.DiagnosticCategory.Error
        ? 'error'
        : d.category === ts.DiagnosticCategory.Warning
          ? 'warning'
          : d.category === ts.DiagnosticCategory.Suggestion
            ? 'hint'
            : 'information'
    const item: DiagItem = {
      path: fallbackPath,
      line: null,
      column: null,
      severity: sev,
      code: `TS${d.code}`,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      source: 'ts'
    }
    if (d.file && d.start !== undefined) {
      item.path = this.shownPath(d.file.fileName).path
      const s = d.file.getLineAndCharacterOfPosition(d.start)
      const e = d.file.getLineAndCharacterOfPosition(d.start + (d.length ?? 0))
      item.line = s.line + 1
      item.column = s.character + 1
      item.end_line = e.line + 1
      item.end_column = e.character + 1
    }
    return item
  }

  private fileDiags(p: Project, abs: string, wantHint: boolean): TS.Diagnostic[] {
    const s = p.service
    const out: TS.Diagnostic[] = [...s.getSyntacticDiagnostics(abs), ...s.getSemanticDiagnostics(abs)]
    if (wantHint) out.push(...s.getSuggestionDiagnostics(abs))
    p.warm = true
    return out
  }

  private walk(dirAbs: string, out: string[]): void {
    if (out.length >= MAX_SCAN_FILES) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= MAX_SCAN_FILES) return
      const abs = path.join(dirAbs, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        if (!this.allowed(abs)) continue
        this.walk(abs, out)
      } else if (e.isFile() && CODE_EXT.test(e.name) && !/\.d\.[mc]?ts$/i.test(e.name)) {
        if (this.allowed(abs)) out.push(abs)
      }
    }
  }

  diagnostics(scope: string | undefined, severities: Severity[] | undefined, maxResults: number): Record<string, unknown> {
    const res = this.guard.resolve(scope && scope.trim() ? scope : '.')
    let st: fs.Stats
    try {
      st = fs.statSync(res.abs)
    } catch {
      throw new ToolError('NOT_FOUND', `找不到：${res.rel}`)
    }
    const wantHint = severities?.includes('hint') ?? false
    const keep = (s: Severity): boolean => !severities || severities.length === 0 || severities.includes(s)
    const counts: Record<Severity, number> = { error: 0, warning: 0, information: 0, hint: 0 }
    const items: DiagItem[] = []
    const projects = new Map<string, Project>()
    const add = (list: DiagItem[]): void => {
      for (const it of list) {
        if (!keep(it.severity)) continue
        counts[it.severity]++
        items.push(it)
      }
    }
    const started = Date.now()
    let files: string[]
    let truncatedReason: string | undefined
    let skipped = 0

    if (st.isFile()) {
      if (!CODE_EXT.test(res.abs)) {
        return {
          supported: false,
          engine: this.engine,
          path: res.rel,
          message: '只支持 TypeScript / JavaScript（.ts .tsx .mts .cts .js .jsx .mjs .cjs）。其他语言请用 run_command 跑对应的编译器或 linter。',
          diagnostics: []
        }
      }
      files = [res.abs]
    } else {
      files = []
      this.walk(res.abs, files)
      if (files.length >= MAX_SCAN_FILES) truncatedReason = `目录里的 TS/JS 文件超过 ${MAX_SCAN_FILES} 个，只查了前 ${MAX_SCAN_FILES} 个；请缩小 path`
    }

    let checked = 0
    for (const f of files) {
      if (Date.now() - started > DIAG_BUDGET_MS) {
        truncatedReason = `超过 ${DIAG_BUDGET_MS / 1000} 秒时间预算，只查了 ${checked}/${files.length} 个文件；请缩小 path`
        break
      }
      const p = this.projectForFile(f)
      // 目录扫描时，不在任何配置里的 JS 文件不查（VS Code 也不会给它们报语义错误）
      if (!st.isFile() && p.source === 'inferred' && !/\.(ts|tsx|mts|cts)$/i.test(f)) {
        skipped++
        continue
      }
      if (!projects.has(p.key)) {
        projects.set(p.key, p)
        const cfgRel = p.configPath ? this.shownPath(p.configPath).path : '(inferred)'
        add(p.errors.map((d) => this.toItem(d, cfgRel)))
        if (!st.isFile()) add(p.service.getCompilerOptionsDiagnostics().map((d) => this.toItem(d, cfgRel)))
      }
      add(this.fileDiags(p, f, wantHint).map((d) => this.toItem(d, this.shownPath(f).path)))
      checked++
    }

    const rank: Record<Severity, number> = { error: 0, warning: 1, information: 2, hint: 3 }
    items.sort((a, b) => rank[a.severity] - rank[b.severity] || a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0))
    const returned = items.slice(0, maxResults)
    const out: Record<string, unknown> = {
      engine: this.engine,
      scope: res.rel,
      projects: [...projects.values()].map((p) => this.anchor(p).project_anchor),
      files_checked: checked,
      counts,
      returned: returned.length,
      truncated: items.length > returned.length || !!truncatedReason,
      diagnostics: returned,
      elapsed_ms: Date.now() - started
    }
    if (truncatedReason) out.truncated_reason = truncatedReason
    if (skipped) out.skipped_js_without_project = skipped
    if (!st.isFile() && files.length === 0) out.note = '这个范围里没有 TS/JS 源文件'
    if (!wantHint) out.hint_note = '默认不含 hint（建议类提示）；要看请在 severity 里加 hint'
    return out
  }

  // ---------- 语义导航 ----------

  private locate(input: string, line?: number, column?: number): { p: Project; abs: string; rel: string; pos: number; warmed: boolean } {
    const res = this.guard.resolve(input)
    if (!CODE_EXT.test(res.abs)) {
      throw new ToolError('UNSUPPORTED_LANGUAGE', `lsp 只支持 TypeScript / JavaScript 文件，${res.rel} 不是。其他语言请用 search 做文本搜索。`)
    }
    if (!fs.existsSync(res.abs) || !fs.statSync(res.abs).isFile()) throw new ToolError('NOT_FOUND', `找不到文件：${res.rel}`)
    const p = this.projectForFile(res.abs)
    const warmed = !p.warm
    const sf = p.service.getProgram()?.getSourceFile(res.abs)
    p.warm = true
    if (!sf) throw new ToolError('NOT_IN_PROJECT', `语言服务没有加载 ${res.rel}`)
    let pos = 0
    if (line !== undefined) {
      const starts = sf.getLineStarts()
      if (line > starts.length) {
        // 以换行结尾时 TS 会多算一个空的末行；报给 AI 的行数和 read_file 保持一致
        const shown = /\n$/.test(sf.text) ? starts.length - 1 : starts.length
        throw new ToolError('INVALID_POSITION', `line=${line} 超出文件末尾：${res.rel} 一共 ${shown} 行`)
      }
      const lineEnd = line < starts.length ? starts[line] : sf.text.length
      const lineText = sf.text.slice(starts[line - 1], lineEnd).replace(/\r?\n$/, '')
      const col = column ?? 1
      if (col > lineText.length + 1) throw new ToolError('INVALID_POSITION', `column=${col} 超出第 ${line} 行末尾（这一行 ${lineText.length} 个字符）`)
      pos = starts[line - 1] + col - 1
    }
    return { p, abs: res.abs, rel: res.rel, pos, warmed }
  }

  private loc(program: TS.Program | undefined, fileName: string, span: TS.TextSpan, withPreview = true): Loc {
    const shown = this.shownPath(fileName)
    const sf = program?.getSourceFile(fileName)
    const out: Loc = { path: shown.path, line: 0, column: 0, end_line: 0, end_column: 0 }
    if (shown.external) out.external = true
    if (sf) {
      const s = sf.getLineAndCharacterOfPosition(span.start)
      const e = sf.getLineAndCharacterOfPosition(span.start + span.length)
      out.line = s.line + 1
      out.column = s.character + 1
      out.end_line = e.line + 1
      out.end_column = e.character + 1
      if (withPreview) {
        const starts = sf.getLineStarts()
        const end = s.line + 1 < starts.length ? starts[s.line + 1] : sf.text.length
        out.preview = sf.text.slice(starts[s.line], end).replace(/\r?\n$/, '').trim().slice(0, 240)
      }
    }
    return out
  }

  lsp(args: {
    operation: 'workspace_symbols' | 'document_symbols' | 'definition' | 'references' | 'implementation' | 'hover'
    path?: string
    query?: string
    line?: number
    column?: number
    include_declaration?: boolean
    max_results?: number
  }): Record<string, unknown> {
    const ts = this.ts
    const op = args.operation
    const meta = (p: Project | undefined, warmed: boolean, empty: boolean): Record<string, unknown> => ({
      engine: this.engine,
      provider_state: p ? 'ready' : 'no_project',
      ...(p ? this.anchor(p) : { project_anchor: null, project_anchor_source: null }),
      warmup_performed: warmed,
      semantic_result_inconclusive: empty && (!p || p.source === 'inferred')
    })

    if (op === 'workspace_symbols') {
      if (!args.query) throw new ToolError('INVALID_ARGS', 'workspace_symbols 需要 query')
      const max = args.max_results ?? 50
      let projects: Project[]
      if (args.path) {
        const res = this.guard.resolve(args.path)
        if (!fs.existsSync(res.abs)) throw new ToolError('NOT_FOUND', `找不到：${res.rel}`)
        projects = fs.statSync(res.abs).isFile() ? [this.projectForFile(res.abs)] : this.projectsForDir(res.abs)
      } else {
        projects = this.projectsForDir(this.guard.root)
      }
      const warmed = projects.some((p) => !p.warm)
      const seen = new Set<string>()
      const symbols: Record<string, unknown>[] = []
      for (const p of projects) {
        const program = p.service.getProgram()
        p.warm = true
        for (const it of p.service.getNavigateToItems(args.query, max * 2, undefined, true)) {
          if (/[\\/]node_modules[\\/]/.test(it.fileName) || !this.check(it.fileName)) continue
          const l = this.loc(program, it.fileName, it.textSpan, false)
          const k = `${l.path}:${l.line}:${l.column}:${it.name}`
          if (seen.has(k)) continue
          seen.add(k)
          symbols.push({ name: it.name, kind: it.kind, container: it.containerName || null, match: it.matchKind, ...l })
        }
      }
      const out = symbols.slice(0, max)
      return {
        ...meta(projects[0], warmed, out.length === 0),
        ...(projects.length === 0 ? { note: '工作区（或 path 范围）里没有 tsconfig.json / jsconfig.json；传 path 指向一个源文件可以用推断项目搜索' } : {}),
        query: args.query,
        returned: out.length,
        truncated: symbols.length > out.length,
        symbols: out
      }
    }

    if (!args.path) throw new ToolError('INVALID_ARGS', `${op} 需要 path`)
    if (op !== 'document_symbols' && (args.line === undefined || args.column === undefined)) {
      throw new ToolError('INVALID_ARGS', `${op} 需要 line 和 column（都从 1 开始）`)
    }
    const at = this.locate(args.path, op === 'document_symbols' ? undefined : args.line, args.column)
    const svc = at.p.service
    const program = svc.getProgram()

    if (op === 'document_symbols') {
      const max = args.max_results ?? 300
      let count = 0
      const conv = (n: TS.NavigationTree): Record<string, unknown> | null => {
        if (count >= max) return null
        count++
        const l = this.loc(program, at.abs, n.spans[0], false)
        const kids = (n.childItems ?? []).map(conv).filter((x): x is Record<string, unknown> => x !== null)
        return {
          name: n.text,
          kind: n.kind,
          ...(n.kindModifiers ? { modifiers: n.kindModifiers } : {}),
          line: l.line,
          column: l.column,
          end_line: l.end_line,
          ...(kids.length ? { children: kids } : {})
        }
      }
      const tree = svc.getNavigationTree(at.abs)
      const symbols = (tree.childItems ?? []).map(conv).filter((x): x is Record<string, unknown> => x !== null)
      return { ...meta(at.p, at.warmed, symbols.length === 0), path: at.rel, returned: count, truncated: count >= max, symbols }
    }

    const origin = { path: at.rel, line: args.line, column: args.column }

    if (op === 'definition') {
      const r = svc.getDefinitionAndBoundSpan(at.abs, at.pos)
      const defs = (r?.definitions ?? []).slice(0, args.max_results ?? 20).map((d) => ({
        name: d.name,
        kind: d.kind,
        container: d.containerName || null,
        ...this.loc(program, d.fileName, d.textSpan)
      }))
      return {
        ...meta(at.p, at.warmed, defs.length === 0),
        origin,
        ...(r ? { origin_span: this.loc(program, at.abs, r.textSpan, false) } : {}),
        returned: defs.length,
        definitions: defs
      }
    }

    if (op === 'references') {
      const max = args.max_results ?? 100
      const includeDecl = args.include_declaration ?? true
      const refs: Record<string, unknown>[] = []
      let total = 0
      for (const sym of svc.findReferences(at.abs, at.pos) ?? []) {
        for (const r of sym.references) {
          if (!includeDecl && r.isDefinition) continue
          total++
          if (refs.length >= max) continue
          refs.push({ ...this.loc(program, r.fileName, r.textSpan), is_definition: !!r.isDefinition, is_write: !!r.isWriteAccess })
        }
      }
      return { ...meta(at.p, at.warmed, total === 0), origin, total, returned: refs.length, truncated: total > refs.length, references: refs }
    }

    if (op === 'implementation') {
      const max = args.max_results ?? 50
      const all = svc.getImplementationAtPosition(at.abs, at.pos) ?? []
      const impls = all.slice(0, max).map((i) => ({ kind: i.kind, display: ts.displayPartsToString(i.displayParts), ...this.loc(program, i.fileName, i.textSpan) }))
      return { ...meta(at.p, at.warmed, impls.length === 0), origin, total: all.length, returned: impls.length, truncated: all.length > impls.length, implementations: impls }
    }

    // hover
    const q = svc.getQuickInfoAtPosition(at.abs, at.pos)
    if (!q) return { ...meta(at.p, at.warmed, true), origin, found: false }
    return {
      ...meta(at.p, at.warmed, false),
      origin,
      found: true,
      kind: q.kind,
      ...(q.kindModifiers ? { modifiers: q.kindModifiers } : {}),
      signature: ts.displayPartsToString(q.displayParts),
      documentation: ts.displayPartsToString(q.documentation) || null,
      tags: (q.tags ?? []).map((t) => ({ name: t.name, text: ts.displayPartsToString(t.text) })),
      range: this.loc(program, at.abs, q.textSpan, false)
    }
  }
}

function isInside(root: string, p: string): boolean {
  const r = path.relative(root, p)
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
}
