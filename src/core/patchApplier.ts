// apply_patch：Codex 风格的多文件补丁。照 ShunCode runtime/mcp-server.js 里 src/apply-patch.ts 的做法移植：
// 解析 → 预检（路径、权限、版本、hunk 匹配）→ 按路径加锁后再预检一次 → 全部暂存到临时文件 →
// 逐个落盘（每个文件单独原子）→ 任何一步失败就把已写的文件按相反顺序回滚。
// 多文件之间不是整体原子：回滚之前别的进程有可能看到一半的状态，结果里如实写明。
// 与 ShunCode 的不同：版本号用本项目 read_file 的 16 位版本（也接受 sha256:完整哈希）；
// 删除的文件进回收站而不是直接 unlink；非 UTF-8 文件按原编码写回。
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import type { Stats } from 'node:fs'
import path from 'node:path'
import { createTwoFilesPatch } from 'diff'
import { decode, encode, isBinary, type TextEncoding } from './encoding'
import { MAX_READ_BYTES, ToolError, versionOf } from './fileTools'
import { PathError, type ResolvedPath } from './pathGuard'

export const PATCH_LIMITS = {
  /** 补丁文本最大字节数 */
  maxPatchBytes: 256 * 1024,
  /** 一个补丁最多几个文件操作 */
  maxOperations: 50,
  /** 单个文件最大字节数（和 read_file 一致） */
  maxFileBytes: MAX_READ_BYTES,
  /** 返回给 AI 的 diff 最大字节数 */
  maxDiffBytes: 64 * 1024
}
export type PatchLimits = typeof PATCH_LIMITS

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'
/** rename 碰到 EPERM/EBUSY（Windows 上杀毒、索引、编辑器占着文件）时的重试间隔 */
const RENAME_RETRY_MS = [50, 100, 200]

export type PatchAction = 'add' | 'update' | 'delete' | 'move'

export interface PatchEnv {
  /** 路径守卫：越界、敏感文件时抛 PathError */
  resolve: (input: string) => ResolvedPath
  /** 回收站目录，和 delete 工具共用同一种格式 */
  trashDir: string
}

export interface PatchFsOps {
  rename: (from: string, to: string) => Promise<void>
}

export interface ApplyPatchOptions {
  /** 路径 → read_file 返回的 version（或 sha256:完整哈希） */
  expectedVersions?: Record<string, string>
  limits?: Partial<PatchLimits>
  /** 测试用：每个文件落盘前调用，抛错即模拟中途失败 */
  beforeCommit?: (step: { index: number; action: PatchAction; path: string }) => void | Promise<void>
  /** 测试用：替换底层文件操作 */
  fsOps?: Partial<PatchFsOps>
}

export interface PatchFileResult {
  action: PatchAction
  path: string
  destination_path?: string
  old_version: string | null
  new_version: string | null
  additions: number
  deletions: number
  /** 这个文件是否通过原子替换落盘（重试后仍被占用时会退回直接覆盖写） */
  atomic: boolean
  trash_id?: string
}

export interface ApplyPatchResult {
  status: 'success'
  files: PatchFileResult[]
  summary: { files_changed: number; additions: number; deletions: number }
  diff: string
  diff_truncated: boolean
  commit_strategy: 'staged_atomic_per_file'
  multi_file_atomic: false
  /** 所有文件都是原子落盘 */
  atomic: boolean
}

// ---------------------------------------------------------------- 解析

interface Hunk {
  header: string
  oldLines: string[]
  newLines: string[]
  additions: number
  deletions: number
  endOfFile: boolean
}

type Operation =
  | { action: 'add'; path: string; lines: string[] }
  | { action: 'delete'; path: string }
  | { action: 'update'; path: string; moveTo?: string; hunks: Hunk[] }

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const ADD = '*** Add File: '
const DELETE = '*** Delete File: '
const UPDATE = '*** Update File: '
const MOVE = '*** Move to: '
const EOF_MARK = '*** End of File'

function invalid(message: string, line?: number): ToolError {
  return new ToolError('INVALID_PATCH', line ? `第 ${line} 行：${message}` : message, line ? { line } : undefined)
}

function headerPath(line: string, prefix: string, lineNo: number): string {
  const p = line.slice(prefix.length).trim()
  if (!p) throw invalid(`${prefix.trim()} 后面缺少路径`, lineNo)
  return p
}

export function parsePatch(patch: string, limits: PatchLimits = PATCH_LIMITS): Operation[] {
  if (typeof patch !== 'string' || patch.trim() === '') throw invalid('补丁不能为空')
  if (Buffer.byteLength(patch, 'utf8') > limits.maxPatchBytes) {
    throw new ToolError('TOO_LARGE', `补丁超过 ${Math.round(limits.maxPatchBytes / 1024)} KB，请拆成几次`)
  }
  const lines = patch.replace(/\r\n?/g, '\n').split('\n')
  let start = 0
  while (start < lines.length && lines[start].trim() === '') start++
  let end = lines.length - 1
  while (end >= 0 && lines[end].trim() === '') end--
  if (start > end || lines[start].trim() !== BEGIN) throw invalid(`补丁必须以 ${BEGIN} 开头`, start + 1)
  if (lines[end].trim() !== END) throw invalid(`补丁必须以 ${END} 结尾`, end + 1)

  const ops: Operation[] = []
  const isHeader = (l: string): boolean =>
    l.startsWith(ADD) || l.startsWith(DELETE) || l.startsWith(UPDATE) || l.trim() === END
  let i = start + 1
  while (i < end) {
    const line = lines[i]
    const lineNo = i + 1
    if (line.trim() === '') {
      i++
      continue
    }
    if (line.startsWith(ADD)) {
      const p = headerPath(line, ADD, lineNo)
      const body: string[] = []
      i++
      while (i < end && !isHeader(lines[i])) {
        const l = lines[i]
        if (l.startsWith('+')) body.push(l.slice(1))
        else if (l === '' && i + 1 <= end && isHeaderOrEnd(lines, i + 1, end)) {
          // 文件段之间的空行，忽略
        } else throw invalid('Add File 的内容行必须以 + 开头', i + 1)
        i++
      }
      ops.push({ action: 'add', path: p, lines: body })
    } else if (line.startsWith(DELETE)) {
      ops.push({ action: 'delete', path: headerPath(line, DELETE, lineNo) })
      i++
    } else if (line.startsWith(UPDATE)) {
      const p = headerPath(line, UPDATE, lineNo)
      i++
      let moveTo: string | undefined
      if (i < end && lines[i].startsWith(MOVE)) {
        moveTo = headerPath(lines[i], MOVE, i + 1)
        i++
      }
      const hunks: Hunk[] = []
      let cur: Hunk | null = null
      const newHunk = (header: string): Hunk => {
        const h: Hunk = { header, oldLines: [], newLines: [], additions: 0, deletions: 0, endOfFile: false }
        hunks.push(h)
        return h
      }
      while (i < end && !isHeader(lines[i])) {
        const l = lines[i]
        if (l.startsWith('@@')) {
          cur = newHunk(l.slice(2).trim())
        } else if (l.trim() === EOF_MARK) {
          if (!cur) throw invalid(`${EOF_MARK} 必须跟在某个 @@ 块里`, i + 1)
          cur.endOfFile = true
        } else if (l.startsWith('*** ')) {
          throw invalid(`不认识的指令：${l}`, i + 1)
        } else {
          if (cur?.endOfFile) throw invalid(`${EOF_MARK} 之后不能再有内容行`, i + 1)
          const h: Hunk = cur ?? (cur = newHunk(''))
          const tag = l[0]
          const text = l.slice(1)
          if (tag === ' ' || l === '') {
            // 完全空的行当作空上下文行（模型常把前导空格吃掉）
            h.oldLines.push(text)
            h.newLines.push(text)
          } else if (tag === '-') {
            h.oldLines.push(text)
            h.deletions++
          } else if (tag === '+') {
            h.newLines.push(text)
            h.additions++
          } else {
            throw invalid('@@ 块里的行必须以空格、- 或 + 开头', i + 1)
          }
        }
        i++
      }
      for (const h of hunks) {
        if (h.additions === 0 && h.deletions === 0) throw invalid(`${p} 有一个 @@ 块没有任何 + 或 - 行`)
      }
      if (hunks.length === 0 && !moveTo) throw invalid(`${p} 没有任何改动块`, lineNo)
      ops.push({ action: 'update', path: p, moveTo, hunks })
    } else {
      throw invalid(`应该是 *** Add File: / *** Update File: / *** Delete File:，实际是：${line.slice(0, 80)}`, lineNo)
    }
    if (ops.length > limits.maxOperations) {
      throw new ToolError('TOO_LARGE', `一个补丁最多 ${limits.maxOperations} 个文件操作，请拆成几次`)
    }
  }
  if (ops.length === 0) throw invalid('补丁里没有任何文件操作')
  return ops
}

function isHeaderOrEnd(lines: string[], from: number, end: number): boolean {
  let j = from
  while (j < end && lines[j].trim() === '') j++
  if (j >= end) return true
  const l = lines[j]
  return l.startsWith(ADD) || l.startsWith(DELETE) || l.startsWith(UPDATE)
}

// ---------------------------------------------------------------- 应用 hunk

interface Snapshot {
  bytes: Buffer
  lines: string[]
  endsWithNewline: boolean
  eol: '\n' | '\r\n'
  encoding: TextEncoding
  version: string
  fullHash: string
  mode: number
}

function snapshotOf(bytes: Buffer, st: Stats, rel: string, limits: PatchLimits): Snapshot {
  if (bytes.length > limits.maxFileBytes) {
    throw new ToolError('TOO_LARGE', `${rel} 超过 ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB，不能用补丁修改`, { path: rel })
  }
  if (isBinary(bytes)) throw new ToolError('BINARY_FILE', `${rel} 是二进制文件，不能用补丁修改`, { path: rel })
  const { text, encoding, eol } = decode(bytes)
  const normalized = text.replace(/\r\n?/g, '\n')
  const endsWithNewline = normalized.endsWith('\n')
  const body = endsWithNewline ? normalized.slice(0, -1) : normalized
  return {
    bytes,
    lines: body === '' && !endsWithNewline ? [] : body.split('\n'),
    endsWithNewline,
    eol,
    encoding,
    version: versionOf(bytes),
    fullHash: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'),
    mode: st.mode & 0o777
  }
}

function joinText(lines: string[], endsWithNewline: boolean): string {
  return lines.length === 0 ? '' : lines.join('\n') + (endsWithNewline ? '\n' : '')
}

function encodeText(lines: string[], snap: Snapshot): Buffer {
  let text = joinText(lines, snap.endsWithNewline)
  if (snap.eol === '\r\n') text = text.replace(/\n/g, '\r\n')
  return encode(text, snap.encoding)
}

function findAll(lines: string[], needle: string[], from: number, eq: (a: string, b: string) => boolean): number[] {
  const hits: number[] = []
  for (let i = from; i + needle.length <= lines.length; i++) {
    let ok = true
    for (let j = 0; j < needle.length; j++) {
      if (!eq(lines[i + j], needle[j])) {
        ok = false
        break
      }
    }
    if (ok) hits.push(i)
  }
  return hits
}

const exact = (a: string, b: string): boolean => a === b
const looseEnd = (a: string, b: string): boolean => a.trimEnd() === b.trimEnd()

/** 按顺序匹配每个 hunk：先精确匹配，找不到再忽略行尾空白；必须唯一 */
export function applyHunks(rel: string, original: string[], hunks: Hunk[]): string[] {
  const replacements: { at: number; remove: number; insert: string[] }[] = []
  let cursor = 0
  hunks.forEach((h, n) => {
    const label = `${rel} 的第 ${n + 1} 个 @@ 块`
    let from = cursor
    // @@ 后面的文字（如函数名）当定位提示：在光标之后唯一出现时从那一行开始找
    if (h.header && !/^-\d+(,\d+)? \+\d+(,\d+)? @@/.test(h.header)) {
      const anchors = findAll(original, [h.header], cursor, (a, b) => a.trim() === b.trim())
      if (anchors.length === 1) from = anchors[0]
    }
    let at: number
    if (h.oldLines.length === 0) {
      at = h.endOfFile || from === cursor ? original.length : from + 1
    } else {
      let hits = findAll(original, h.oldLines, from, exact)
      if (hits.length === 0) hits = findAll(original, h.oldLines, from, looseEnd)
      if (h.endOfFile) hits = hits.filter((x) => x + h.oldLines.length === original.length)
      if (hits.length === 0) {
        throw new ToolError('HUNK_NOT_FOUND', `${label}在文件里找不到对应的上下文，请重新 read_file 后再生成补丁`, {
          path: rel,
          hunk: n + 1,
          first_line: h.oldLines[0]
        })
      }
      if (hits.length > 1) {
        throw new ToolError('AMBIGUOUS_HUNK', `${label}的上下文在文件里出现了 ${hits.length} 次，请多带几行上下文或在 @@ 后写上所在的函数名`, {
          path: rel,
          hunk: n + 1,
          lines: hits.map((x) => x + 1)
        })
      }
      at = hits[0]
    }
    replacements.push({ at, remove: h.oldLines.length, insert: h.newLines })
    cursor = at + h.oldLines.length
  })
  const out = original.slice()
  for (const r of replacements.reverse()) out.splice(r.at, r.remove, ...r.insert)
  return out
}

// ---------------------------------------------------------------- 预检

interface Plan {
  index: number
  action: PatchAction
  srcRel?: string
  srcAbs?: string
  destRel?: string
  destAbs?: string
  old?: Snapshot
  newBytes?: Buffer
  oldText: string
  newText: string
  additions: number
  deletions: number
}

const idOf = (p: string): string => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p)

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code
}

async function lstatOrNull(abs: string): Promise<Stats | null> {
  try {
    return await fsp.lstat(abs)
  } catch (e) {
    if (errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR') return null
    throw e
  }
}

function versionMatches(expected: string, snap: Snapshot): boolean {
  return expected.startsWith('sha256:') ? expected.toLowerCase() === snap.fullHash : expected === snap.version
}

async function preflight(
  ops: Operation[],
  env: PatchEnv,
  opts: ApplyPatchOptions,
  limits: PatchLimits
): Promise<{ plans: Plan[]; lockKeys: string[] }> {
  const expected = new Map<string, string>()
  for (const [k, v] of Object.entries(opts.expectedVersions ?? {})) {
    if (typeof v !== 'string' || v.trim() === '') throw new ToolError('INVALID_ARGS', `expected_versions 里 ${k} 的版本不能为空`)
    const id = idOf(env.resolve(k).rel)
    const prev = expected.get(id)
    if (prev !== undefined && prev !== v.trim()) throw new ToolError('INVALID_ARGS', `expected_versions 里 ${k} 给了两个不同的版本`)
    expected.set(id, v.trim())
  }

  const claimed = new Map<string, string>()
  const lockKeys: string[] = []
  const claim = (r: ResolvedPath, display: string): void => {
    if (r.rel === '.') throw invalid(`不能对工作区根目录操作：${display}`)
    const id = idOf(r.rel)
    if (claimed.has(id)) throw invalid(`同一个补丁里 ${r.rel} 出现了不止一次，请合并成一段`)
    claimed.set(id, r.rel)
    lockKeys.push(idOf(r.abs))
  }
  const readExisting = async (r: ResolvedPath): Promise<Snapshot> => {
    const st = await lstatOrNull(r.abs)
    if (!st) throw new ToolError('NOT_FOUND', `${r.rel} 不存在`, { path: r.rel })
    if (!st.isFile()) throw new ToolError('NOT_A_FILE', `${r.rel} 不是普通文件`, { path: r.rel })
    if (st.size > limits.maxFileBytes) {
      throw new ToolError('TOO_LARGE', `${r.rel} 超过 ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB，不能用补丁修改`, { path: r.rel })
    }
    const snap = snapshotOf(await fsp.readFile(r.abs), st, r.rel, limits)
    const exp = expected.get(idOf(r.rel))
    if (exp !== undefined && !versionMatches(exp, snap)) {
      throw new ToolError('CONFLICT', `${r.rel} 在你读取之后被改过，请重新 read_file 后再生成补丁，整个补丁未执行`, {
        path: r.rel,
        current_version: snap.version,
        expected_version: exp
      })
    }
    return snap
  }
  const mustNotExist = async (r: ResolvedPath): Promise<void> => {
    if (await lstatOrNull(r.abs)) throw new ToolError('ALREADY_EXISTS', `${r.rel} 已经存在`, { path: r.rel })
  }

  const plans: Plan[] = []
  for (const [index, op] of ops.entries()) {
    if (op.action === 'add') {
      const dst = env.resolve(op.path)
      claim(dst, op.path)
      await mustNotExist(dst)
      const newText = joinText(op.lines, true)
      const newBytes = Buffer.from(newText, 'utf8')
      if (newBytes.length > limits.maxFileBytes) throw new ToolError('TOO_LARGE', `${dst.rel} 的内容太大`, { path: dst.rel })
      plans.push({ index, action: 'add', destRel: dst.rel, destAbs: dst.abs, newBytes, oldText: '', newText, additions: op.lines.length, deletions: 0 })
      continue
    }
    const src = env.resolve(op.path)
    claim(src, op.path)
    if (op.action === 'delete') {
      const old = await readExisting(src)
      const oldText = joinText(old.lines, old.endsWithNewline)
      plans.push({ index, action: 'delete', srcRel: src.rel, srcAbs: src.abs, old, oldText, newText: '', additions: 0, deletions: old.lines.length })
      continue
    }
    const old = await readExisting(src)
    const lines = op.hunks.length ? applyHunks(src.rel, old.lines, op.hunks) : old.lines
    const newBytes = encodeText(lines, old)
    const plan: Plan = {
      index,
      action: 'update',
      srcRel: src.rel,
      srcAbs: src.abs,
      old,
      newBytes,
      oldText: joinText(old.lines, old.endsWithNewline),
      newText: joinText(lines, old.endsWithNewline),
      additions: op.hunks.reduce((s, h) => s + h.additions, 0),
      deletions: op.hunks.reduce((s, h) => s + h.deletions, 0)
    }
    if (op.moveTo) {
      const dst = env.resolve(op.moveTo)
      claim(dst, op.moveTo)
      await mustNotExist(dst)
      plan.action = 'move'
      plan.destRel = dst.rel
      plan.destAbs = dst.abs
    }
    plans.push(plan)
  }
  // 「新建 a」和「新建 a/b」这种一个当文件、一个当目录的冲突
  for (const rel of claimed.values()) {
    const parts = rel.split('/')
    for (let k = 1; k < parts.length; k++) {
      const parent = parts.slice(0, k).join('/')
      if (claimed.has(idOf(parent))) throw invalid(`${parent} 在同一个补丁里既被当成文件又被当成 ${rel} 的目录`)
    }
  }
  return { plans, lockKeys }
}

// ---------------------------------------------------------------- 锁

/** 按绝对路径串行化并发的 apply_patch（不同 AI 同时改同一个文件） */
const pathLocks = new Map<string, Promise<void>>()

async function withLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const sorted = [...new Set(keys)].sort()
  const releases: (() => void)[] = []
  try {
    for (const key of sorted) {
      const prev = pathLocks.get(key) ?? Promise.resolve()
      let release!: () => void
      const mine = new Promise<void>((r) => (release = r))
      const tail = prev.then(() => mine)
      pathLocks.set(key, tail)
      releases.push(() => {
        release()
        if (pathLocks.get(key) === tail) pathLocks.delete(key)
      })
      await prev
    }
    return await fn()
  } finally {
    for (const r of releases.reverse()) r()
  }
}

// ---------------------------------------------------------------- 落盘与回滚

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function tempPathFor(target: string): string {
  const rand = crypto.randomBytes(6).toString('hex')
  return path.join(path.dirname(target), `.${path.basename(target)}.bridge-${process.pid}-${rand}.tmp`)
}

/** 写到目标旁边的临时文件并 fsync，保证之后的 rename/link 在同一个卷上 */
async function stage(target: string, bytes: Buffer, mode?: number): Promise<string> {
  const tmp = tempPathFor(target)
  const h = await fsp.open(tmp, 'wx', mode)
  try {
    await h.writeFile(bytes)
    await h.sync()
  } catch (e) {
    await h.close().catch(() => {})
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
  await h.close()
  return tmp
}

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** 用临时文件原子替换已有文件；被占用时重试，仍不行就直接覆盖写（返回 false 表示非原子） */
async function replaceFile(tmp: string, target: string, bytes: Buffer, ops: PatchFsOps): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await ops.rename(tmp, target)
      return true
    } catch (e) {
      if (!BUSY.has(errCode(e) ?? '')) throw e
      if (attempt >= RENAME_RETRY_MS.length) {
        await fsp.writeFile(target, bytes)
        await fsp.rm(tmp, { force: true }).catch(() => {})
        return false
      }
      await sleep(RENAME_RETRY_MS[attempt])
    }
  }
}

/** 新建文件不覆盖：硬链接在目标已存在时会 EEXIST；文件系统不支持硬链接时退回 wx 写 */
async function installNew(tmp: string, target: string, bytes: Buffer): Promise<boolean> {
  try {
    await fsp.link(tmp, target)
    await fsp.rm(tmp, { force: true }).catch(() => {})
    return true
  } catch (e) {
    if (errCode(e) === 'EEXIST' || errCode(e) === 'ENOENT') throw e
    await fsp.writeFile(target, bytes, { flag: 'wx' })
    await fsp.rm(tmp, { force: true }).catch(() => {})
    return false
  }
}

/** 和 FileTools.delete 同一种回收站格式：<trash>/<id>/<文件名> + manifest.json */
async function moveToTrash(trashDir: string, abs: string, rel: string): Promise<{ id: string; dir: string; file: string }> {
  const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
  const dir = path.join(trashDir, id)
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, path.basename(abs))
  try {
    await fsp.rename(abs, file)
  } catch (e) {
    if (errCode(e) !== 'EXDEV') {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
      throw e
    }
    await fsp.copyFile(abs, file)
    await fsp.unlink(abs)
  }
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ originalPath: rel, absPath: abs, deletedAt: Date.now() }))
  return { id, dir, file }
}

/** 逐级创建缺失的父目录，记下新建了哪些，失败时只删这些 */
async function ensureDir(dir: string, created: string[]): Promise<void> {
  const missing: string[] = []
  let cur = dir
  for (;;) {
    const st = await lstatOrNull(cur)
    if (st) {
      if (!st.isDirectory()) throw new ToolError('NOT_A_DIRECTORY', `${cur} 不是目录`)
      break
    }
    missing.push(cur)
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  for (const d of missing.reverse()) {
    try {
      await fsp.mkdir(d)
      created.push(d)
    } catch (e) {
      if (errCode(e) !== 'EEXIST') throw e
    }
  }
}

/** 落盘前再确认源文件没被别人改过（预检之后、加锁之外的写入，比如用户在编辑器里保存） */
async function assertUnchanged(plan: Plan): Promise<void> {
  if (!plan.srcAbs || !plan.old) return
  let now: Buffer
  try {
    now = await fsp.readFile(plan.srcAbs)
  } catch (e) {
    if (errCode(e) === 'ENOENT') throw new ToolError('CONFLICT', `${plan.srcRel} 在补丁执行过程中被删除`, { path: plan.srcRel })
    throw e
  }
  if (!now.equals(plan.old.bytes)) {
    throw new ToolError('CONFLICT', `${plan.srcRel} 在补丁执行过程中被修改`, {
      path: plan.srcRel,
      current_version: versionOf(now)
    })
  }
}

interface Done {
  plan: Plan
  atomic: boolean
  trash?: { id: string; dir: string; file: string }
}

async function restoreBytes(abs: string, bytes: Buffer, mode: number | undefined, ops: PatchFsOps): Promise<void> {
  const tmp = await stage(abs, bytes, mode)
  try {
    if (await lstatOrNull(abs)) await replaceFile(tmp, abs, bytes, ops)
    else await installNew(tmp, abs, bytes)
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {})
  }
}

async function rollback(done: Done[], ops: PatchFsOps): Promise<string[]> {
  const failures: string[] = []
  for (const d of done.slice().reverse()) {
    const { plan } = d
    try {
      if (plan.action === 'update') {
        await restoreBytes(plan.srcAbs!, plan.old!.bytes, plan.old!.mode, ops)
      } else if (plan.action === 'add') {
        await fsp.rm(plan.destAbs!, { force: true })
      } else if (plan.action === 'move') {
        if (!(await lstatOrNull(plan.srcAbs!))) await restoreBytes(plan.srcAbs!, plan.old!.bytes, plan.old!.mode, ops)
        await fsp.rm(plan.destAbs!, { force: true })
      } else if (plan.action === 'delete' && d.trash) {
        if (!(await lstatOrNull(plan.srcAbs!))) {
          try {
            await fsp.rename(d.trash.file, plan.srcAbs!)
          } catch {
            await restoreBytes(plan.srcAbs!, plan.old!.bytes, plan.old!.mode, ops)
          }
        }
        await fsp.rm(d.trash.dir, { recursive: true, force: true }).catch(() => {})
      }
    } catch (e) {
      failures.push(`${plan.srcRel ?? plan.destRel}（${(e as Error).message}）`)
    }
  }
  return failures
}

async function commit(plans: Plan[], env: PatchEnv, opts: ApplyPatchOptions): Promise<Done[]> {
  const ops: PatchFsOps = { rename: (a, b) => fsp.rename(a, b), ...opts.fsOps }
  const createdDirs: string[] = []
  const staged = new Map<Plan, string>()
  const done: Done[] = []
  try {
    for (const p of plans) if (p.destAbs) await ensureDir(path.dirname(p.destAbs), createdDirs)
    for (const p of plans) {
      if (!p.newBytes) continue
      const target = p.action === 'update' ? p.srcAbs! : p.destAbs!
      staged.set(p, await stage(target, p.newBytes, p.old?.mode))
    }
    for (const p of plans) {
      await opts.beforeCommit?.({ index: p.index, action: p.action, path: (p.srcRel ?? p.destRel)! })
      await assertUnchanged(p)
      const tmp = staged.get(p)
      let atomic = true
      let trash: Done['trash']
      if (p.action === 'update') {
        atomic = await replaceFile(tmp!, p.srcAbs!, p.newBytes!, ops)
      } else if (p.action === 'add') {
        atomic = await installNew(tmp!, p.destAbs!, p.newBytes!)
      } else if (p.action === 'move') {
        atomic = await installNew(tmp!, p.destAbs!, p.newBytes!)
        try {
          await fsp.unlink(p.srcAbs!)
        } catch (e) {
          await fsp.rm(p.destAbs!, { force: true }).catch(() => {})
          throw e
        }
      } else {
        trash = await moveToTrash(env.trashDir, p.srcAbs!, p.srcRel!)
      }
      staged.delete(p)
      done.push({ plan: p, atomic, trash })
    }
    return done
  } catch (e) {
    const failures = await rollback(done, ops)
    for (const tmp of staged.values()) await fsp.rm(tmp, { force: true }).catch(() => {})
    staged.clear()
    for (const d of createdDirs.reverse()) await fsp.rmdir(d).catch(() => {})
    const err = toToolError(e)
    const code = (err as ToolError).code ?? 'IO_ERROR'
    const msg = err.message.replace(/^[A-Z_]+: /, '')
    if (failures.length) {
      throw new ToolError('ROLLBACK_FAILED', `补丁写入失败（${msg}），回滚也没有完全成功，请人工检查：${failures.join('；')}`, {
        cause: code,
        rollback_failures: failures
      })
    }
    const data = err instanceof ToolError ? err.data : undefined
    throw new ToolError(code, done.length ? `${msg}（已写入的 ${done.length} 个文件已回滚，所有文件保持原样）` : `${msg}（没有文件被修改）`, {
      ...data,
      rolled_back_files: done.length
    })
  } finally {
    for (const tmp of staged.values()) await fsp.rm(tmp, { force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------- 入口

function toToolError(e: unknown): Error {
  if (e instanceof ToolError || e instanceof PathError) return e
  const code = errCode(e)
  const msg = (e as Error)?.message ?? String(e)
  if (code === 'ENOENT') return new ToolError('NOT_FOUND', msg)
  if (code === 'EEXIST') return new ToolError('ALREADY_EXISTS', msg)
  if (code === 'ENOTDIR') return new ToolError('NOT_A_DIRECTORY', msg)
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') return new ToolError('PERMISSION_DENIED', msg)
  return new ToolError('IO_ERROR', msg)
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return { text, truncated: false }
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return { text: buf.subarray(0, end).toString('utf8') + '\n…（diff 太长，已截断）\n', truncated: true }
}

function diffOf(p: Plan): string {
  const oldName = p.action === 'add' ? '/dev/null' : `a/${p.srcRel}`
  const newName = p.action === 'delete' ? '/dev/null' : `b/${p.destRel ?? p.srcRel}`
  const d = createTwoFilesPatch(oldName, newName, p.oldText, p.newText, undefined, undefined, { context: 3 })
  // createTwoFilesPatch 开头有一行 ====，去掉和 git 的格式对齐
  return d.replace(/^=+\n/, '')
}

/** 应用一个 Codex 风格补丁。任何文件预检不过都不会写入；写入中途失败会回滚已写的文件 */
export async function applyPatch(env: PatchEnv, patch: string, opts: ApplyPatchOptions = {}): Promise<ApplyPatchResult> {
  const limits: PatchLimits = { ...PATCH_LIMITS, ...opts.limits }
  try {
    const ops = parsePatch(patch, limits)
    const first = await preflight(ops, env, opts, limits)
    return await withLocks(first.lockKeys, async () => {
      // 加锁前后路径可能变了（符号链接被换、文件被别人改），锁内再做一次完整预检
      const { plans, lockKeys } = await preflight(ops, env, opts, limits)
      const held = new Set(first.lockKeys)
      if (lockKeys.some((k) => !held.has(k))) {
        throw new ToolError('PATH_CHANGED', '加锁期间补丁涉及的路径发生了变化，请重试，整个补丁未执行')
      }
      const diff = truncateUtf8(plans.map(diffOf).join(''), limits.maxDiffBytes)
      const done = await commit(plans, env, opts)
      const files: PatchFileResult[] = done.map(({ plan: p, atomic, trash }) => ({
        action: p.action,
        path: (p.srcRel ?? p.destRel)!,
        ...(p.action === 'move' ? { destination_path: p.destRel } : {}),
        old_version: p.old?.version ?? null,
        new_version: p.newBytes ? versionOf(p.newBytes) : null,
        additions: p.additions,
        deletions: p.deletions,
        atomic,
        ...(trash ? { trash_id: trash.id } : {})
      }))
      return {
        status: 'success' as const,
        files,
        summary: {
          files_changed: files.length,
          additions: files.reduce((s, f) => s + f.additions, 0),
          deletions: files.reduce((s, f) => s + f.deletions, 0)
        },
        diff: diff.text,
        diff_truncated: diff.truncated,
        commit_strategy: 'staged_atomic_per_file' as const,
        multi_file_atomic: false as const,
        atomic: files.every((f) => f.atomic)
      }
    })
  } catch (e) {
    throw toToolError(e)
  }
}
