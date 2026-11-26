import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { decode, isBinary } from './encoding'
import { JsonStore } from './jsonStore'
import { isDeniedName } from './pathGuard'
import type { SkillDetail, SkillInfo, SkillInput, SkillScope, SkillStatus } from './types'

/**
 * 技能库（SKILL.md 格式，兼容 Claude Skills）。
 *
 * 目录：
 *   项目级 <工作区>/.bridge/skills/<name>/SKILL.md（同名时优先）
 *   用户级 <userDir>/<name>/SKILL.md（默认 ~/.workspace-bridge/skills）
 *
 * 状态（停用标记、来源、使用次数）不放在技能目录里，放在应用数据目录（AI 碰不到）：
 *   项目级 → projectStateFile；用户级 → userStateFile（跨工作区共用）
 *
 * 规则（2026-11-12 起，用户决定去掉审阅）：
 * - 技能目录里只要有合法的 SKILL.md 就是 enabled，AI 马上能用；不用用户启用，文件之后被改也不会停用。
 * - 只有用户在工作台手动停用的才是 disabled（停用标记记在状态文件里），再点启用就恢复。
 * - 含符号链接、缺 SKILL.md、名字不合法、超过 MAX_SKILL_BYTES 或 MAX_SKILL_FILES 的技能是 invalid，用不了。
 * - AI 只能看到和加载 enabled 且没被同名项目级技能遮住的技能。
 * - install_skill 只能写项目级，写入后直接 enabled，origin=agent。
 * - 用户可以在工作台导入现成的技能包（文件夹或 zip，扫描在 skillImport.ts），项目级、用户级都行，写入后直接 enabled。
 * - 技能脚本（scripts/）工作台自己不运行；AI 有 run_command，load_skill 会告诉它技能目录在哪，要跑由它自己跑。
 */

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const MAX_SKILL_FILES = 1000
export const MAX_SKILL_BYTES = 20 * 1024 * 1024
/** read_skill_resource 一次最多返回的字节数 */
export const MAX_RESOURCE_BYTES = 256 * 1024
/** install_skill 写入的总字节数上限 */
export const MAX_INSTALL_BYTES = 256 * 1024
/** install_skill 最多附带的文件数 */
export const MAX_INSTALL_FILES = 50

/** Claude Skills 的 description 上限 */
const MAX_DESCRIPTION = 1024
/** 没有 description 时从正文取的摘要长度 */
const FALLBACK_DESCRIPTION = 200
/** 解析 description 只读 SKILL.md 开头这么多，避免每次扫描都读整个大文件 */
const HEAD_BYTES = 64 * 1024

export const NAME_RULE = '技能名只能用小写字母、数字、- 和 _，以字母或数字开头，最长 64 个字符'
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i

export interface SkillStoreOptions {
  /** <工作区>/.bridge/skills；没有工作区时为空 */
  projectDir?: string
  userDir: string
  projectStateFile?: string
  userStateFile: string
  /** 删除技能时移进这里（和文件工具共用回收站） */
  trashDir: string
  /** 状态或技能内容变了（界面刷新用） */
  onChange?: () => void
  /**
   * 多个 SkillStore（每个工作区一个）共用的用户级状态。JsonStore 会缓存内容，
   * 各自打开同一个文件会互相覆盖，所以多工作区时由调用方建一个传进来（createSkillStateStore）
   */
  sharedUserState?: SkillStateStore
}

/** 给 AI 看的技能摘要（list_skills） */
export interface SkillSummary {
  name: string
  description: string
  scope: SkillScope
  /** 附带文件（不含 SKILL.md），read_skill_resource 用 */
  resources: string[]
  hasScripts: boolean
}

export interface InstallSkillInput {
  name: string
  description: string
  body: string
  /** 附带文本文件，路径相对技能目录 */
  files?: { path: string; content: string }[]
}

/** 业务错误：code 会原样返回给 AI，例如 SKILL_NOT_FOUND、SKILL_NOT_ENABLED、SKILL_EXISTS、INVALID_SKILL */
export class SkillError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(`${code}: ${message}`)
  }
}

// ---------- 状态文件 ----------

export interface SkillState {
  /** false 且 reviewed=true：用户手动停用了。其他情况都算启用 */
  enabled: boolean
  enabledAt?: number
  origin: 'user' | 'agent' | 'found'
  installedBy?: string
  /**
   * 用户在工作台启用或停用过。旧版本里 AI 提交的技能是 enabled=false、reviewed=false（等用户审阅），
   * 现在不用审阅了，所以只有 reviewed=true 的 enabled=false 才当作「用户停用」
   */
  reviewed?: boolean
  usage: { loads: number; reads: number; lastUsedAt?: number }
}

/** 按技能名存（目录名就是名字，同一个范围里不会重复） */
export interface StateFile {
  skills: Record<string, SkillState>
}

export type SkillStateStore = JsonStore<StateFile>

const emptyState = (): StateFile => ({ skills: {} })

/** 用户级技能状态：整个应用只开一个，传给每个 SkillStore 的 sharedUserState */
export function createSkillStateStore(file: string): SkillStateStore {
  return new JsonStore(file, emptyState)
}

function freshState(origin: SkillState['origin']): SkillState {
  return { enabled: true, origin, usage: { loads: 0, reads: 0 } }
}

/** 旧状态文件里的锁定哈希不再使用，写回时顺手去掉 */
function withoutLegacy(s: SkillState): SkillState {
  const { hashes: _hashes, ...rest } = s as SkillState & { hashes?: unknown }
  return rest
}

// ---------- 扫描结果 ----------

export interface ScannedFile {
  rel: string
  abs: string
  size: number
}

interface Scanned {
  scope: SkillScope
  name: string
  dir: string
  files: ScannedFile[]
  hasScripts: boolean
  problem?: string
  description: string
}

interface Resolved {
  sc: Scanned
  st?: SkillState
  status: SkillStatus
  shadowed: boolean
}

// ---------- 工具函数 ----------

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

function samePath(a: string, b: string): boolean {
  return CASE_INSENSITIVE_FS ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** 目录的真实路径不等于「父目录真实路径 + 自己的名字」，说明它是链接（或指到别处的挂载点） */
function realMismatch(abs: string, parentReal: string): { real?: string; link: boolean } {
  try {
    const real = fs.realpathSync.native(abs)
    return { real, link: !samePath(real, path.join(parentReal, path.basename(abs))) }
  } catch {
    // 悬空的 junction 解析不了，按链接处理
    return { link: true }
  }
}

/**
 * 是不是符号链接或 junction。不能只看 lstat：实测 Node v24.18 在 Windows 上把 junction 报成普通目录，
 * 所以目录再比一次真实路径
 */
function isLink(p: string): boolean {
  let st: fs.Stats
  try {
    st = fs.lstatSync(p)
  } catch {
    return false
  }
  if (st.isSymbolicLink()) return true
  if (!st.isDirectory()) return false
  try {
    return realMismatch(p, fs.realpathSync.native(path.dirname(p))).link
  } catch {
    return true
  }
}

/** 移动整个目录。两边不在同一个盘时 rename 会失败（EXDEV），改为复制后删除；复制到一半出错就把半成品清掉，原目录不动 */
async function moveDir(from: string, to: string): Promise<void> {
  try {
    await fsp.rename(from, to)
    return
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
  }
  try {
    await fsp.cp(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })
  } catch (e) {
    await fsp.rm(to, { recursive: true, force: true }).catch(() => undefined)
    throw e
  }
  await fsp.rm(from, { recursive: true, force: true })
}

function readHead(abs: string, n: number): Buffer {
  const fd = fs.openSync(abs, 'r')
  try {
    const buf = Buffer.alloc(n)
    const got = fs.readSync(fd, buf, 0, n, 0)
    return buf.subarray(0, got)
  } finally {
    fs.closeSync(fd)
  }
}

/** 临时文件 + rename：目标是符号链接时替换链接本身，不会顺着链接写到别处 */
function writeAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, data, { flag: 'wx' })
  try {
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

/** 解码文本，超过 max 字节时按 UTF-8 截断（不切坏多字节字符） */
function toText(buf: Buffer, max: number): { text: string; truncated: boolean } {
  const text = decode(buf).text
  const utf8 = Buffer.from(text, 'utf8')
  if (utf8.length <= max) return { text, truncated: false }
  return { text: utf8.subarray(0, max).toString('utf8').replace(/\uFFFD+$/, ''), truncated: true }
}

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return String(JSON.parse(v))
    } catch {
      return v.slice(1, -1).replace(/\\(["\\])/g, '$1')
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  return v
}

/** 只认顶层的 key: value，够取 name / description；嵌套结构（metadata: 下面的缩进行）忽略 */
function parseMeta(lines: string[]): Record<string, string> {
  const meta: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+)[ \t]*:(.*)$/.exec(lines[i])
    if (!m) continue
    let value = m[2].trim()
    if (/^[|>][-+]?$/.test(value)) {
      // YAML 块标量（description: >），后面缩进的行都是值
      const parts: string[] = []
      while (i + 1 < lines.length && (/^[ \t]/.test(lines[i + 1]) || lines[i + 1].trim() === '')) parts.push(lines[++i].trim())
      value = parts.filter(Boolean).join(' ')
    } else if (value.startsWith('"') || value.startsWith("'")) {
      value = unquote(value)
    } else {
      // 和 YAML 一致：空白后的 # 是注释
      value = value.startsWith('#') ? '' : value.replace(/\s+#.*$/, '')
      // 普通标量可以折到下一行（缩进续行）
      while (value && i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) value += ' ' + lines[++i].trim()
    }
    meta[m[1]] = value
  }
  return meta
}

/** 解析 SKILL.md：frontmatter（--- 之间的 key: value）和 description；兼容 BOM、CRLF */
export function parseSkillMd(raw: string): { meta: Record<string, string>; body: string; description: string } {
  const lines = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  let meta: Record<string, string> = {}
  let bodyStart = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
    if (end > 0) {
      meta = parseMeta(lines.slice(1, end))
      bodyStart = end + 1
    }
  }
  const bodyLines = lines.slice(bodyStart)
  let description = (meta.description ?? '').trim()
  if (!description) {
    const first = bodyLines.map((l) => l.trim()).find((l) => l && !l.startsWith('#') && !/^[-=*_]{3,}$/.test(l))
    description = [...(first ?? '')].slice(0, FALLBACK_DESCRIPTION).join('')
  }
  return { meta, body: bodyLines.join('\n'), description }
}

/** 写 frontmatter 时，可能被 YAML（或我们自己的解析器）误读的值加双引号 */
function yamlScalar(s: string): string {
  return /[:#'"\\]/.test(s) || /^[-?,[\]{}&*!|>%@`\s]/.test(s) || /\s$/.test(s) ? JSON.stringify(s) : s
}

function skillMd(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${yamlScalar(description)}\n---\n\n${body}`
}

function normDescription(d: unknown): string {
  if (typeof d !== 'string') return ''
  return [...d.replace(/[\r\n]+/g, ' ').trim()].slice(0, MAX_DESCRIPTION).join('').trim()
}

/**
 * 技能内相对路径：反斜杠转 /、去掉开头的 ./ 和 /；越界、带冒号、凭据类文件名一律拒绝。
 * allowDenied：用户自己导入技能包时不拦凭据类文件名（AI 写入和读取仍然拦）
 */
function normalizeRel(input: unknown, allowDenied = false): string {
  if (typeof input !== 'string' || input.includes('\0')) throw new SkillError('INVALID_PATH', '路径必须是不含 NUL 的字符串')
  let p = input.replace(/\\/g, '/')
  for (;;) {
    if (p.startsWith('./')) p = p.slice(2)
    else if (p.startsWith('/')) p = p.slice(1)
    else break
  }
  // 冒号同时挡住盘符（C:/）和 NTFS 备用数据流（a.md:secret）
  if (p.includes(':') || path.isAbsolute(p) || path.win32.isAbsolute(p)) throw new SkillError('INVALID_PATH', `不支持绝对路径或带冒号的路径：${input}`)
  const segs = p.split('/').filter((s) => s !== '' && s !== '.')
  if (!segs.length) throw new SkillError('INVALID_PATH', '路径为空')
  for (const s of segs) {
    if (s === '..') throw new SkillError('INVALID_PATH', `路径不能越出技能目录：${input}`)
    // Windows 会静默去掉结尾的点和空格（".env." 实际打开 ".env"）
    if (/[. ]$/.test(s)) throw new SkillError('INVALID_PATH', `路径段不能以点或空格结尾：${s}`)
    if (WINDOWS_RESERVED.test(s) || /[<>"|?*\x00-\x1f]/.test(s)) throw new SkillError('INVALID_PATH', `不支持的文件名：${s}`)
    if (!allowDenied && isDeniedName(s)) throw new SkillError('INVALID_PATH', `${s} 属于受保护的凭据或系统文件`)
  }
  return segs.join('/')
}

function parseId(id: unknown): { scope: SkillScope; name: string } {
  const s = typeof id === 'string' ? id : ''
  const i = s.indexOf(':')
  const scope = s.slice(0, i)
  if (i < 0 || (scope !== 'project' && scope !== 'user')) throw new SkillError('SKILL_NOT_FOUND', `技能 ${s} 不存在`)
  return { scope, name: s.slice(i + 1) }
}

/**
 * lstat 递归遍历（不跟随链接）；遇到链接或超限就停，免得在可疑目录里继续走。
 * skipNames：叫这些名字的文件和目录整个跳过（导入技能包时跳过 .git、node_modules 之类）
 */
export function walkSkillDir(dir: string, skipNames?: ReadonlySet<string>): { files: ScannedFile[]; hasScripts: boolean; problem?: string } {
  const files: ScannedFile[] = []
  let hasScripts = false
  let bytes = 0
  let rootReal: string
  try {
    rootReal = fs.realpathSync.native(dir)
  } catch {
    return { files, hasScripts, problem: '技能目录读不了' }
  }
  const stack = [{ rel: '', real: rootReal }]
  while (stack.length) {
    const { rel, real } = stack.pop()!
    const abs = rel ? path.join(dir, ...rel.split('/')) : dir
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      return { files, hasScripts, problem: `读不了目录 ${rel || '.'}` }
    }
    for (const ent of entries) {
      const n = ent.name
      if (skipNames?.has(n)) continue
      const r = rel ? `${rel}/${n}` : n
      const a = path.join(abs, n)
      const linkProblem = { files, hasScripts, problem: `技能目录里有符号链接或 junction：${r}` }
      let st: fs.Stats
      try {
        st = fs.lstatSync(a)
      } catch {
        return { files, hasScripts, problem: `读不了 ${r}` }
      }
      // 三种信号都看：不同 Node 版本对 junction 的报告不一致（v24.18 的 lstat 报成普通目录，Dirent 却报成链接）
      if (ent.isSymbolicLink() || st.isSymbolicLink()) return linkProblem
      if (st.isDirectory()) {
        const m = realMismatch(a, real)
        if (m.link || !m.real) return linkProblem
        if (!rel && n === 'scripts') hasScripts = true
        stack.push({ rel: r, real: m.real })
      } else if (st.isFile()) {
        files.push({ rel: r, abs: a, size: st.size })
        bytes += st.size
        if (files.length > MAX_SKILL_FILES) return { files, hasScripts, problem: `文件超过 ${MAX_SKILL_FILES} 个` }
        if (bytes > MAX_SKILL_BYTES) return { files, hasScripts, problem: `总大小超过 ${MAX_SKILL_BYTES / 1024 / 1024} MB` }
      } else {
        return { files, hasScripts, problem: `不支持的文件类型：${r}` }
      }
    }
  }
  files.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0))
  return { files, hasScripts }
}

export class SkillStore {
  private readonly states: { project?: JsonStore<StateFile>; user: JsonStore<StateFile> }

  constructor(readonly opts: SkillStoreOptions) {
    if (opts.projectDir && !opts.projectStateFile) throw new Error('项目级技能需要 projectStateFile')
    // 不把 onChange 交给 JsonStore：一次操作可能既写文件又写状态，统一在操作结束时通知一次
    this.states = {
      user: opts.sharedUserState ?? new JsonStore(opts.userStateFile, emptyState),
      ...(opts.projectDir && opts.projectStateFile ? { project: new JsonStore(opts.projectStateFile, emptyState) } : {})
    }
  }

  // ---------- 工作台 ----------

  /** 全部技能（项目级在前），每次调用都重新扫描目录 */
  list(): SkillInfo[] {
    return this.scanAll().map((r) => this.toInfo(r))
  }

  get(id: string): SkillDetail {
    const r = this.byId(id)
    let content = ''
    const md = r.sc.files.find((f) => f.rel === 'SKILL.md')
    if (md) {
      try {
        const t = toText(fs.readFileSync(md.abs), MAX_RESOURCE_BYTES)
        content = t.truncated ? `${t.text}\n\n…（SKILL.md 太长，后面已截断）` : t.text
      } catch {
        // 刚被删掉，按空内容显示
      }
    }
    return { ...this.toInfo(r), content, dir: r.sc.dir }
  }

  /** 用户手动停用 / 重新启用；文件都保留 */
  setEnabled(id: string, enabled: boolean): SkillInfo {
    const r = this.byId(id)
    const { scope, name } = r.sc
    if (enabled && r.status === 'invalid') throw new SkillError('INVALID_SKILL', `技能无效，不能启用：${r.sc.problem}`)
    this.stateOf(scope).mutate((d) => {
      const s: SkillState = { ...withoutLegacy(d.skills[name] ?? freshState('found')), enabled, reviewed: true }
      if (enabled) s.enabledAt = Date.now()
      else delete s.enabledAt
      d.skills[name] = s
    })
    this.changed()
    return this.toInfo(this.byId(id))
  }

  /**
   * 工作台新建或修改 SKILL.md（frontmatter 由 name 和 description 生成）。
   * 新建 → 直接启用；改已有的 → 启用 / 停用状态不变
   */
  save(input: SkillInput): SkillInfo {
    const scope = input?.scope
    if (scope !== 'project' && scope !== 'user') throw new SkillError('INVALID_SKILL', '技能范围只能是 project 或 user')
    if (scope === 'project' && !this.opts.projectDir) throw new SkillError('NO_WORKSPACE', '没有打开工作区，不能保存项目级技能')
    const name = input.name
    if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) throw new SkillError('INVALID_SKILL', NAME_RULE)
    const description = normDescription(input.description)
    if (!description) throw new SkillError('INVALID_SKILL', '描述不能为空')
    const md = skillMd(name, description, typeof input.body === 'string' ? input.body : '')
    const id = `${scope}:${name}`
    const root = this.writableRoot(scope)
    const dir = path.join(root, name)

    if (!lexists(dir)) {
      fs.mkdirSync(dir)
      writeAtomic(path.join(dir, 'SKILL.md'), md)
      this.stateOf(scope).mutate((d) => {
        d.skills[name] = { ...freshState('user'), enabledAt: Date.now(), reviewed: true }
      })
      this.changed()
      return this.toInfo(this.byId(id))
    }

    // Windows 不区分大小写：已有 Foo 目录时 foo 会写进它
    if (!this.entries(scope).has(name)) throw new SkillError('SKILL_EXISTS', `已有大小写不同的同名目录，不能保存 ${name}`)
    if (isLink(dir)) throw new SkillError('INVALID_SKILL', '技能目录是符号链接或 junction，不能写入')
    writeAtomic(path.join(dir, 'SKILL.md'), md)
    this.changed()
    return this.toInfo(this.byId(id))
  }

  /** 整个技能目录移进回收站，并清掉它的状态 */
  async remove(id: string): Promise<void> {
    const { scope, name } = parseId(id)
    const dir = this.entries(scope).get(name)
    if (!dir) throw new SkillError('SKILL_NOT_FOUND', `技能 ${id} 不存在`)
    await this.moveToTrash(scope, name, dir)
    this.stateOf(scope).mutate((d) => {
      delete d.skills[name]
    })
    this.changed()
  }

  /**
   * 把技能挪个地方：项目级 ↔ 用户级，或者挪到另一个工作区的项目级。整个目录移过去，启用 / 停用、来源、使用次数都跟着走。
   * dest 是目标工作区的技能库（to 是 project 时用它的项目级目录）；不给就是这个技能库自己的工作区。
   * 目标位置已有同名的 → SKILL_EXISTS（不覆盖，让用户自己先处理那一个）
   */
  async changeScope(id: string, to: SkillScope, dest: SkillStore = this): Promise<SkillInfo> {
    if (to !== 'project' && to !== 'user') throw new SkillError('INVALID_SKILL', '技能范围只能是 project 或 user')
    const { scope: from, name } = parseId(id)
    const dir = this.entries(from).get(name)
    if (!dir) throw new SkillError('SKILL_NOT_FOUND', `技能 ${id} 不存在`)
    if (to === 'project' && !dest.opts.projectDir) throw new SkillError('NO_WORKSPACE', '没有打开工作区，不能改成项目级技能')
    // 已经在那儿了：什么都不动
    if (from === to && (to === 'user' || dest === this || (!!this.opts.projectDir && samePath(dest.opts.projectDir!, this.opts.projectDir)))) return this.toInfo(this.byId(id))
    if (!SKILL_NAME_RE.test(name)) throw new SkillError('INVALID_SKILL', `名字不合法，不能移动：${NAME_RULE}`)
    // 链接目录可能指到别处，不跟着挪
    if (isLink(dir)) throw new SkillError('INVALID_SKILL', '技能目录是符号链接或 junction，不能移动')
    const root = dest.writableRoot(to)
    const target = path.join(root, name)
    const clash = [...dest.entries(to).keys()].find((n) => n.toLowerCase() === name.toLowerCase())
    if (clash || lexists(target)) throw new SkillError('SKILL_EXISTS', `那里已经有叫 ${clash ?? name} 的${to === 'project' ? '项目' : '用户'}技能，先把那一个删掉或挪走`)
    await moveDir(dir, target)
    const st = this.states[from]?.get().skills[name]
    this.stateOf(from).mutate((d) => {
      delete d.skills[name]
    })
    if (st) {
      dest.stateOf(to).mutate((d) => {
        d.skills[name] = withoutLegacy(st)
      })
    }
    this.changed()
    if (dest !== this) dest.changed()
    return dest.toInfo(dest.byId(`${to}:${name}`))
  }

  /**
   * 导入现成的技能包（用户在工作台选的文件夹或 zip，由 skillImport.ts 扫描出来）。写入后直接启用，来源记成用户。
   * 同名已存在：overwrite 时把旧的整个移进回收站再写；否则 SKILL_EXISTS
   */
  async importPackage(
    scope: SkillScope,
    pkg: { name: string; files: { rel: string; read: () => Buffer }[] },
    opts: { overwrite?: boolean } = {}
  ): Promise<{ skill: SkillInfo; replaced: boolean }> {
    if (scope !== 'project' && scope !== 'user') throw new SkillError('INVALID_SKILL', '技能范围只能是 project 或 user')
    if (scope === 'project' && !this.opts.projectDir) throw new SkillError('NO_WORKSPACE', '没有打开工作区，不能导入成项目级技能')
    const name = pkg?.name
    if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) throw new SkillError('INVALID_SKILL', NAME_RULE)
    if (!Array.isArray(pkg.files)) throw new SkillError('INVALID_SKILL', '技能包里没有文件')
    if (pkg.files.length > MAX_SKILL_FILES) throw new SkillError('TOO_LARGE', `文件超过 ${MAX_SKILL_FILES} 个`)

    // 先把内容全部读进来再动磁盘：读不了、超限都在这一步报错，不会留半成品，也不会白白把旧技能移走
    const taken = new Set<string>()
    const planned: { rel: string; data: Buffer }[] = []
    let total = 0
    for (const f of pkg.files) {
      let rel = normalizeRel(f?.rel, true)
      const key = rel.toLowerCase()
      // 大小写写错的 skill.md 也认，落盘时改成标准名字
      if (key === 'skill.md') rel = 'SKILL.md'
      if (taken.has(key)) throw new SkillError('INVALID_PATH', `重复的路径：${rel}`)
      taken.add(key)
      const data = f.read()
      total += data.length
      if (total > MAX_SKILL_BYTES) throw new SkillError('TOO_LARGE', `总大小超过 ${MAX_SKILL_BYTES / 1024 / 1024} MB`)
      planned.push({ rel, data })
    }
    if (!taken.has('skill.md')) throw new SkillError('INVALID_SKILL', '缺少 SKILL.md')
    for (const p of planned) {
      const segs = p.rel.toLowerCase().split('/')
      for (let i = 1; i < segs.length; i++) {
        if (taken.has(segs.slice(0, i).join('/'))) throw new SkillError('INVALID_PATH', `${p.rel} 和另一个文件路径冲突`)
      }
    }

    const root = this.writableRoot(scope)
    const dir = path.join(root, name)
    // Windows 不区分大小写：已有 Foo 时 foo 会写进它，所以按小写找同名
    const existing = [...this.entries(scope)].find(([n]) => n.toLowerCase() === name.toLowerCase())
    let replaced = false
    if (existing || lexists(dir)) {
      if (!opts.overwrite) throw new SkillError('SKILL_EXISTS', `已有叫 ${existing?.[0] ?? name} 的${scope === 'project' ? '项目' : '用户'}技能`)
      await this.moveToTrash(scope, existing?.[0] ?? name, existing?.[1] ?? dir)
      replaced = true
    }
    fs.mkdirSync(dir)
    try {
      for (const p of planned) {
        const abs = path.join(dir, ...p.rel.split('/'))
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, p.data, { flag: 'wx' })
      }
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true })
      throw e
    }
    this.stateOf(scope).mutate((d) => {
      if (existing && existing[0] !== name) delete d.skills[existing[0]]
      d.skills[name] = { ...freshState('user'), enabledAt: Date.now(), reviewed: true }
    })
    this.changed()
    return { skill: this.toInfo(this.byId(`${scope}:${name}`)), replaced }
  }

  // ---------- AI（mcpServer 调用） ----------

  /** enabled 且没被遮住的技能 */
  available(): SkillSummary[] {
    return this.scanAll()
      .filter((r) => r.status === 'enabled' && !r.shadowed)
      .map((r) => this.summary(r))
  }

  /** 按名字加载（项目级优先）；返回 SKILL.md 全文和技能目录的绝对路径，记一次 loads */
  load(name: string): { skill: SkillSummary; content: string; dir: string } {
    const r = this.forAgent(name)
    const t = toText(this.readFile(r, 'SKILL.md'), MAX_RESOURCE_BYTES)
    this.bump(r, 'loads')
    return { skill: this.summary(r), content: t.truncated ? `${t.text}\n\n…（SKILL.md 太长，后面已截断）` : t.text, dir: r.sc.dir }
  }

  /** 读技能目录里的附带文件；路径不能越出技能目录，凭据类文件名拒绝；记一次 reads */
  readResource(name: string, rel: string): { path: string; content?: string; size: number; binary: boolean; truncated: boolean } {
    const p = normalizeRel(rel)
    const r = this.forAgent(name)
    const buf = this.readFile(r, p)
    this.bump(r, 'reads')
    if (isBinary(buf)) return { path: p, size: buf.length, binary: true, truncated: false }
    const t = toText(buf, MAX_RESOURCE_BYTES)
    return { path: p, content: t.text, size: buf.length, binary: false, truncated: t.truncated }
  }

  /** AI 写入新的项目级技能，写入后直接启用；同名已存在返回 SKILL_EXISTS */
  install(input: InstallSkillInput, by: { id: string; name: string }): SkillInfo {
    const projectDir = this.opts.projectDir
    if (!projectDir) throw new SkillError('NO_WORKSPACE', '没有打开工作区，技能只能装到工作区的 .bridge/skills 里')
    const name = input?.name
    if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) throw new SkillError('INVALID_SKILL', NAME_RULE)
    const unsafe = this.projectRootUnsafe()
    if (unsafe) throw new SkillError('INVALID_PATH', `${unsafe}，拒绝写入`)
    if (lexists(path.join(projectDir, name))) throw new SkillError('SKILL_EXISTS', `项目里已有技能 ${name}，换个名字或让用户在工作台处理`)
    const description = normDescription(input.description)
    if (!description) throw new SkillError('INVALID_SKILL', '描述不能为空')

    const files = input.files ?? []
    if (!Array.isArray(files)) throw new SkillError('INVALID_SKILL', 'files 必须是数组')
    if (files.length > MAX_INSTALL_FILES) throw new SkillError('TOO_LARGE', `附带文件最多 ${MAX_INSTALL_FILES} 个`)
    const md = skillMd(name, description, typeof input.body === 'string' ? input.body : '')
    let total = Buffer.byteLength(md)
    // 按小写比较：Windows 上 a.md 和 A.md 是同一个文件，skill.md 会覆盖 SKILL.md
    const taken = new Set(['skill.md'])
    const planned: { rel: string; content: string }[] = []
    for (const f of files) {
      const rel = normalizeRel(f?.path)
      const key = rel.toLowerCase()
      if (key === 'skill.md') throw new SkillError('INVALID_PATH', 'SKILL.md 由 name、description、body 生成，不能放在 files 里')
      if (taken.has(key)) throw new SkillError('INVALID_PATH', `重复的路径：${rel}`)
      if (typeof f.content !== 'string') throw new SkillError('INVALID_SKILL', `${rel} 的内容必须是字符串`)
      taken.add(key)
      planned.push({ rel, content: f.content })
      total += Buffer.byteLength(f.content)
    }
    // a 和 a/b 不能同时出现（一个既是文件又是目录）
    for (const p of planned) {
      const segs = p.rel.toLowerCase().split('/')
      for (let i = 1; i < segs.length; i++) {
        if (taken.has(segs.slice(0, i).join('/'))) throw new SkillError('INVALID_PATH', `${p.rel} 和另一个文件路径冲突`)
      }
    }
    if (total > MAX_INSTALL_BYTES) throw new SkillError('TOO_LARGE', `技能共 ${total} 字节，超过 ${MAX_INSTALL_BYTES} 字节上限`)

    const dir = path.join(this.writableRoot('project'), name)
    try {
      fs.mkdirSync(dir)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new SkillError('SKILL_EXISTS', `项目里已有技能 ${name}`)
      throw e
    }
    try {
      fs.writeFileSync(path.join(dir, 'SKILL.md'), md, { flag: 'wx' })
      for (const p of planned) {
        const abs = path.join(dir, ...p.rel.split('/'))
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, p.content, { flag: 'wx' })
      }
    } catch (e) {
      // 写一半失败不留半成品
      fs.rmSync(dir, { recursive: true, force: true })
      throw e
    }
    this.stateOf('project').mutate((d) => {
      d.skills[name] = { ...freshState('agent'), installedBy: by.name, enabledAt: Date.now() }
    })
    this.changed()
    return this.toInfo(this.byId(`project:${name}`))
  }

  // ---------- 内部 ----------

  private changed(): void {
    this.opts.onChange?.()
  }

  /** 整个技能目录移进回收站（和文件工具共用），留一份 manifest 说明原来在哪 */
  private async moveToTrash(scope: SkillScope, name: string, dir: string): Promise<void> {
    const holder = path.join(this.opts.trashDir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`)
    await fsp.mkdir(holder, { recursive: true })
    await moveDir(dir, path.join(holder, name))
    // originalPath 和文件工具一致：项目级用工作区相对路径
    const originalPath = scope === 'project' ? `.bridge/skills/${name}` : dir
    await fsp.writeFile(path.join(holder, 'manifest.json'), JSON.stringify({ originalPath, absPath: dir, skill: `${scope}:${name}`, deletedAt: Date.now() }))
  }

  private stateOf(scope: SkillScope): JsonStore<StateFile> {
    const s = scope === 'project' ? this.states.project : this.states.user
    if (!s) throw new SkillError('NO_WORKSPACE', '没有打开工作区')
    return s
  }

  /** .bridge 或 .bridge/skills 本身是符号链接时可能指到工作区外，项目级技能一律不读不写 */
  private projectRootUnsafe(): string | undefined {
    const dir = this.opts.projectDir
    if (!dir) return undefined
    for (const p of [path.dirname(dir), dir]) {
      if (isLink(p)) return `${p} 是符号链接或 junction`
    }
    return undefined
  }

  /** 要写入的技能根目录；需要时创建（扫描时不创建） */
  private writableRoot(scope: SkillScope): string {
    const root = scope === 'project' ? this.opts.projectDir : this.opts.userDir
    if (!root) throw new SkillError('NO_WORKSPACE', '没有打开工作区')
    const check = () => {
      const bad = scope === 'project' ? this.projectRootUnsafe() : undefined
      if (bad) throw new SkillError('INVALID_PATH', `${bad}，拒绝写入`)
    }
    check()
    fs.mkdirSync(root, { recursive: true })
    check()
    return root
  }

  /** 技能根目录下的一级子目录（含指向别处的链接，扫描时判 invalid）：名字 → 绝对路径 */
  private entries(scope: SkillScope): Map<string, string> {
    const out = new Map<string, string>()
    const root = scope === 'project' ? this.opts.projectDir : this.opts.userDir
    if (!root || (scope === 'project' && this.projectRootUnsafe())) return out
    let names: string[]
    try {
      if (!fs.statSync(root).isDirectory()) return out
      names = fs.readdirSync(root).sort()
    } catch {
      return out
    }
    for (const n of names) {
      const abs = path.join(root, n)
      try {
        const st = fs.lstatSync(abs)
        if (st.isDirectory() || st.isSymbolicLink()) out.set(n, abs)
      } catch {
        // 扫描途中被删
      }
    }
    return out
  }

  private scan(scope: SkillScope, name: string, dir: string): Scanned {
    const sc: Scanned = { scope, name, dir, files: [], hasScripts: false, description: '' }
    let st: fs.Stats
    try {
      st = fs.lstatSync(dir)
    } catch {
      sc.problem = '技能目录读不了'
      return sc
    }
    // 不进链接目录：它可能指到工作区外
    if (st.isSymbolicLink() || isLink(dir)) {
      sc.problem = '技能目录本身是符号链接或 junction'
      return sc
    }
    if (!st.isDirectory()) {
      sc.problem = '不是目录'
      return sc
    }
    const w = walkSkillDir(dir)
    sc.files = w.files
    sc.hasScripts = w.hasScripts
    const md = sc.files.find((f) => f.rel === 'SKILL.md')
    if (!SKILL_NAME_RE.test(name)) sc.problem = `名字不合法：${NAME_RULE}`
    else if (w.problem) sc.problem = w.problem
    else if (!md) sc.problem = '缺少 SKILL.md'

    if (md) {
      try {
        const head = readHead(md.abs, HEAD_BYTES)
        // 只读了开头时按 UTF-8 解，避免截断处的半个字符让编码识别误判成 GBK
        sc.description = parseSkillMd(head.length < md.size ? head.toString('utf8') : decode(head).text).description
      } catch {
        // 读不了就没有描述
      }
    }
    return sc
  }

  private resolve(sc: Scanned, shadowed: boolean): Resolved {
    const st = this.states[sc.scope]?.get().skills[sc.name]
    if (sc.problem) return { sc, st, status: 'invalid', shadowed }
    // 只有用户手动停用的才算停用；没有状态记录的（直接放进目录的）、AI 提交的都是启用
    const off = st?.enabled === false && st.reviewed === true
    return { sc, st, status: off ? 'disabled' : 'enabled', shadowed }
  }

  private scanAll(): Resolved[] {
    const project = this.entries('project')
    const out: Resolved[] = []
    for (const [name, dir] of project) out.push(this.resolve(this.scan('project', name, dir), false))
    for (const [name, dir] of this.entries('user')) out.push(this.resolve(this.scan('user', name, dir), project.has(name)))
    return out
  }

  private byId(id: string): Resolved {
    const { scope, name } = parseId(id)
    // 只按目录列表精确匹配，名字里带 ../ 也走不出根目录
    const dir = this.entries(scope).get(name)
    if (!dir) throw new SkillError('SKILL_NOT_FOUND', `技能 ${id} 不存在`)
    return this.resolve(this.scan(scope, name, dir), scope === 'user' && this.entries('project').has(name))
  }

  /** AI 按名字找技能：项目级同名目录存在就只看它（不回退到被遮住的用户级），并检查状态 */
  private forAgent(name: string): Resolved {
    if (typeof name !== 'string' || !name) throw new SkillError('SKILL_NOT_FOUND', '缺少技能名')
    const pdir = this.entries('project').get(name)
    let r: Resolved
    if (pdir) r = this.resolve(this.scan('project', name, pdir), false)
    else {
      const udir = this.entries('user').get(name)
      if (!udir) throw new SkillError('SKILL_NOT_FOUND', `没有技能 ${name}，先用 list_skills 查看可用的技能`)
      r = this.resolve(this.scan('user', name, udir), false)
    }
    if (r.status === 'invalid') throw new SkillError('INVALID_SKILL', `技能 ${name} 无效：${r.sc.problem}`)
    if (r.status !== 'enabled') throw new SkillError('SKILL_NOT_ENABLED', `技能 ${name} 被用户停用了`)
    return r
  }

  /** 读扫描清单里的文件（清单里没有链接，也不会越出技能目录） */
  private readFile(r: Resolved, rel: string): Buffer {
    const f = r.sc.files.find((x) => x.rel === rel)
    if (!f) throw new SkillError('RESOURCE_NOT_FOUND', `技能 ${r.sc.name} 里没有 ${rel}`)
    try {
      // 扫描和读取之间文件被换成链接：不跟着链接读到技能目录外面
      if (fs.lstatSync(f.abs).isSymbolicLink()) throw new Error('link')
      return fs.readFileSync(f.abs)
    } catch {
      throw new SkillError('RESOURCE_NOT_FOUND', `${rel} 刚被改动或删除，读不了`)
    }
  }

  private bump(r: Resolved, kind: 'loads' | 'reads'): void {
    this.stateOf(r.sc.scope).mutate((d) => {
      // 直接放进目录的技能没有状态记录，第一次用到时补一条
      const s = (d.skills[r.sc.name] ??= freshState('found'))
      const u = s.usage ?? { loads: 0, reads: 0 }
      s.usage = { ...u, [kind]: (u[kind] ?? 0) + 1, lastUsedAt: Date.now() }
    })
    this.changed()
  }

  private summary(r: Resolved): SkillSummary {
    return {
      name: r.sc.name,
      description: r.sc.description,
      scope: r.sc.scope,
      // 凭据类文件名 read_skill_resource 一定拒绝，干脆不列给 AI
      resources: r.sc.files.map((f) => f.rel).filter((f) => f !== 'SKILL.md' && !f.split('/').some(isDeniedName)),
      hasScripts: r.sc.hasScripts
    }
  }

  private toInfo(r: Resolved): SkillInfo {
    const { sc, st } = r
    const usage = st?.usage
    return {
      id: `${sc.scope}:${sc.name}`,
      name: sc.name,
      scope: sc.scope,
      description: sc.description,
      status: r.status,
      ...(sc.problem ? { problem: sc.problem } : {}),
      hasScripts: sc.hasScripts,
      files: sc.files.map((f) => f.rel),
      origin: st?.origin ?? 'found',
      ...(st?.installedBy ? { installedBy: st.installedBy } : {}),
      ...(r.shadowed ? { shadowed: true } : {}),
      usage: { loads: usage?.loads ?? 0, reads: usage?.reads ?? 0, ...(usage?.lastUsedAt ? { lastUsedAt: usage.lastUsedAt } : {}) },
      ...(r.status === 'enabled' && st?.enabledAt ? { enabledAt: st.enabledAt } : {})
    }
  }
}
