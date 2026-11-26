// 检查点与回滚：AI 每次 write_file / edit_file / apply_patch / move / delete 之前，先把会被改到的文件
// 旧内容存进 bridge 自己的数据目录（<工作区数据目录>/checkpoints），按会话、任务分组。
// 改坏了可以只把这一组文件退回去；恢复前逐个比对 version，别人后来又改过就报冲突，一个都不写。
// 不碰项目自己的 .git：内容按 SHA-256 存成 blobs/<hash>，索引是 index.json。
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createTwoFilesPatch } from 'diff'
import { ToolError, versionOf } from './fileTools'

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'
/** 单个文件超过这个大小不存快照（记进 skipped，回滚时说明恢复不了） */
const MAX_FILE_BYTES = 20 * 1024 * 1024
/** 一次操作（比如删整个目录）最多存多少个文件、多少字节 */
const MAX_STEP_FILES = 5000
const MAX_STEP_BYTES = 200 * 1024 * 1024
/** 保留策略：最多 2000 个检查点、14 天，快照总大小 1 GB，超了从最旧的删 */
const MAX_STEPS = 2000
const MAX_AGE_MS = 14 * 24 * 3600 * 1000
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024
/** 汇总时超过这个大小的文件不出 diff，只给状态 */
const MAX_DIFF_FILE_BYTES = 2 * 1024 * 1024

export interface CheckpointFile {
  /** 工作区相对路径 */
  path: string
  /** 改之前内容的 blob（完整 SHA-256）；null = 改之前不存在 */
  before: string | null
  /** 改之前的 version（和 read_file 的 version 同一算法）；null = 不存在 */
  beforeVersion: string | null
  /** 改完之后的 version；null = 改完之后不存在 */
  after: string | null
  /** 已经被哪个回滚检查点退回 */
  rolledBackBy?: string
}

export interface CheckpointStep {
  id: string
  seq: number
  ts: number
  agentId: string
  agentName: string
  /** 会话分组：一个 MCP 连接一个 */
  session: string
  /** 写入时这个 AI 正在做的任务（进行中的那个），没有就是 null */
  task: string | null
  /**
   * task 是别的工作区的任务时才有（经「整台电脑」改文件，而任务在某个项目里）：那个工作区的 id 和任务在那边的编号。
   * 这时 task 写成「项目名/T-3」，和这个工作区自己的 T-3 分得开
   */
  taskWs?: string
  taskRef?: string
  tool: string
  kind: 'edit' | 'rollback'
  files: CheckpointFile[]
  /** 这次操作前不存在、可能被它新建出来的目录；回滚时删掉其中变空的 */
  newDirs: string[]
  /** 没存快照的文件（太大、链接、超过单次上限），回滚时恢复不了 */
  skipped: { path: string; reason: string }[]
}

interface IndexFile {
  version: 1
  seq: number
  steps: CheckpointStep[]
}

export interface CheckpointMeta {
  agentId: string
  agentName: string
  session: string
  task: string | null
  /** 见 CheckpointStep 的同名字段 */
  taskWs?: string
  taskRef?: string
  tool: string
  kind?: 'edit' | 'rollback'
}

export interface Selector {
  /** 只看这个 AI 的检查点；不传 = 所有 AI */
  agentId?: string
  /** 会话 id */
  session?: string
  /** 任务编号（如 T-3） */
  task?: string
  /** 从这个检查点开始（含）到同一会话最新的 */
  fromStep?: string
  /** 和 fromStep 一起用：只要 fromStep 这一步，不连带后面的 */
  onlyStep?: boolean
}

export interface RollbackConflict {
  path: string
  reason: 'modified_after' | 'changed_between' | 'touched_by_other' | 'touched_later' | 'snapshot_missing' | 'not_a_file'
  detail: string
  expected_version?: string | null
  current_version?: string | null
}

type Resolve = (input: string) => { abs: string; rel: string }

interface PendingEntry {
  path: string
  before: string | null
  beforeVersion: string | null
}

/** 改文件前拍下的快照；操作成功后 commit，失败就丢掉（blob 之后被回收） */
export class PendingCheckpoint {
  constructor(
    readonly meta: CheckpointMeta,
    readonly targets: { abs: string; rel: string }[],
    readonly entries: Map<string, PendingEntry>,
    readonly newDirs: string[],
    readonly skipped: { path: string; reason: string }[]
  ) {}
}

const keyOf = (rel: string): string => (CASE_INSENSITIVE_FS ? rel.toLowerCase() : rel)

/** a 是不是 b 本身或在 b 下面（都是 / 分隔、已经过 keyOf） */
const underKey = (a: string, b: string): boolean => a === b || a.startsWith(b.endsWith('/') ? b : b + '/')

/**
 * 改完后扫到一个没快照的文件：是不是因为它（或它在别的目标下的对应位置）当初被跳过了。
 * move 时源和目标是两个 target：源下的大文件 / 超出 5000 个的部分在 begin 时按源路径记进 skipped，
 * commit 时却在目标路径扫到。不认出来就会被当成「原来不存在」，回滚时把它移进回收站，源位置又没东西可恢复
 */
function skippedCovers(p: { targets: { rel: string }[]; skipped: { path: string }[] }, rel: string): boolean {
  if (p.skipped.length === 0) return false
  const k = keyOf(rel)
  const candidates = [k]
  for (const t of p.targets) {
    const tk = keyOf(t.rel)
    if (!underKey(k, tk)) continue
    const suffix = k.slice(tk.length)
    for (const o of p.targets) if (o !== t) candidates.push(keyOf(o.rel) + suffix)
  }
  return p.skipped.some((s) => {
    const sk = keyOf(s.path)
    return candidates.some((c) => underKey(c, sk))
  })
}
const joinRel = (rel: string, name: string): string => (rel === '.' || rel === '' ? name : `${rel}/${name}`)
const sha256 = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex')

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/** 去掉 BOM，按 UTF-8 解码（只用于出 diff） */
function textOf(buf: Buffer): string {
  const s = buf.toString('utf8')
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

async function statOrNull(abs: string): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(abs)
  } catch {
    return null
  }
}

export class CheckpointStore {
  private index: IndexFile | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private commitsSinceGc = 0
  /** 有新检查点或回滚标记变了时调用（工作台刷新用） */
  private onChange?: () => void
  /** 每个检查点里每个文件的增删行数：检查点内容不会变，算过就记住（key = 检查点 id + 路径） */
  private statCache = new Map<string, { additions: number; deletions: number; binary?: boolean; too_large?: boolean }>()

  constructor(
    private readonly dir: string,
    private readonly resolve: Resolve,
    private readonly trashDir: string,
    private readonly now: () => number = Date.now
  ) {}

  /** 设置变化回调（commit、回滚之后调用；回调抛错不影响检查点） */
  setOnChange(fn: (() => void) | undefined): void {
    this.onChange = fn
  }

  private changed(): void {
    try {
      this.onChange?.()
    } catch {
      // 只是通知界面
    }
  }

  /** 全部检查点（按时间顺序，含回滚检查点），只读 */
  allSteps(): readonly CheckpointStep[] {
    return this.load().steps
  }

  /**
   * 一个检查点里每个文件这一步的增删行数（不是净改动）。
   * 改之前的内容用这一步的快照；改之后的内容找后面检查点里同一文件、改之前版本等于这一步 after 的快照，找不到就看磁盘上现在是不是这个版本。
   * 都找不到（之后又被改过、快照被清理）时 unknown=true
   */
  async stepStats(step: CheckpointStep): Promise<{ path: string; additions: number; deletions: number; binary?: boolean; too_large?: boolean; unknown?: boolean }[]> {
    const out: { path: string; additions: number; deletions: number; binary?: boolean; too_large?: boolean; unknown?: boolean }[] = []
    const all = this.load().steps
    for (const f of step.files) {
      const ck = `${step.id}\n${f.path}`
      const hit = this.statCache.get(ck)
      if (hit) {
        out.push({ path: f.path, ...hit })
        continue
      }
      const beforeBuf = f.before ? await this.getBlob(f.before) : null
      let afterBuf: Buffer | null = null
      let known = true
      if (f.after !== null) {
        const k = keyOf(f.path)
        const later = all.find((s) => s.seq > step.seq && s.files.some((x) => keyOf(x.path) === k && x.beforeVersion === f.after && x.before))
        const lf = later?.files.find((x) => keyOf(x.path) === k && x.beforeVersion === f.after && x.before)
        if (lf?.before) afterBuf = await this.getBlob(lf.before)
        if (!afterBuf) {
          try {
            const abs = this.resolve(f.path).abs
            const st = await statOrNull(abs)
            const buf = st?.isFile() ? await fsp.readFile(abs) : null
            if (buf && versionOf(buf) === f.after) afterBuf = buf
          } catch {
            // 路径已经不合法：按不知道处理
          }
        }
        if (!afterBuf) known = false
      }
      if ((f.before && !beforeBuf) || !known) {
        out.push({ path: f.path, additions: 0, deletions: 0, unknown: true })
        continue
      }
      let r: { additions: number; deletions: number; binary?: boolean; too_large?: boolean }
      if ((beforeBuf?.length ?? 0) > MAX_DIFF_FILE_BYTES || (afterBuf?.length ?? 0) > MAX_DIFF_FILE_BYTES) r = { additions: 0, deletions: 0, too_large: true }
      else if ((beforeBuf && isBinary(beforeBuf)) || (afterBuf && isBinary(afterBuf))) r = { additions: 0, deletions: 0, binary: true }
      else r = countLines(createTwoFilesPatch('a', 'b', beforeBuf ? textOf(beforeBuf) : '', afterBuf ? textOf(afterBuf) : '', '', '', { context: 0 }))
      this.statCache.set(ck, r)
      out.push({ path: f.path, ...r })
    }
    return out
  }

  private get blobDir(): string {
    return path.join(this.dir, 'blobs')
  }

  private get indexPath(): string {
    return path.join(this.dir, 'index.json')
  }

  /** 同一个工作区的检查点读写排队执行，避免两个 AI 同时改索引 */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  private load(): IndexFile {
    if (this.index) return this.index
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as IndexFile
      if (raw && raw.version === 1 && Array.isArray(raw.steps)) this.index = raw
    } catch {
      // 没有索引或损坏：从空开始（blob 还在，只是不再被引用，之后回收）
    }
    if (!this.index) this.index = { version: 1, seq: 0, steps: [] }
    return this.index
  }

  private async save(): Promise<void> {
    const idx = this.load()
    await fsp.mkdir(this.dir, { recursive: true })
    const tmp = `${this.indexPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(idx))
    try {
      await fsp.rename(tmp, this.indexPath)
    } catch (e) {
      await fsp.rm(tmp, { force: true })
      if ((e as NodeJS.ErrnoException).code === 'EPERM') await fsp.writeFile(this.indexPath, JSON.stringify(idx))
      else throw e
    }
  }

  private async putBlob(buf: Buffer): Promise<string> {
    const hash = sha256(buf)
    const p = path.join(this.blobDir, hash.slice(0, 2), hash)
    if (!fs.existsSync(p)) {
      await fsp.mkdir(path.dirname(p), { recursive: true })
      const tmp = `${p}.${crypto.randomBytes(4).toString('hex')}.tmp`
      await fsp.writeFile(tmp, buf)
      await fsp.rename(tmp, p).catch(async (e) => {
        await fsp.rm(tmp, { force: true })
        if (!fs.existsSync(p)) throw e
      })
    }
    return hash
  }

  private async getBlob(hash: string): Promise<Buffer | null> {
    try {
      const buf = await fsp.readFile(path.join(this.blobDir, hash.slice(0, 2), hash))
      return sha256(buf) === hash ? buf : null
    } catch {
      return null
    }
  }

  /** 当前磁盘上的 version：不存在 null，不是普通文件 'not-a-file' */
  private async currentVersion(abs: string): Promise<string | null> {
    const st = await statOrNull(abs)
    if (!st) return null
    if (!st.isFile()) return 'not-a-file'
    return versionOf(await fsp.readFile(abs))
  }

  /** 把目标（文件或目录）下的所有普通文件列出来；链接不跟随 */
  private async walk(
    abs: string,
    rel: string,
    out: { abs: string; rel: string; size: number }[],
    skipped: { path: string; reason: string }[]
  ): Promise<void> {
    const st = await statOrNull(abs)
    if (!st) return
    if (st.isSymbolicLink()) {
      skipped.push({ path: rel, reason: '符号链接 / junction，不存快照' })
      return
    }
    if (st.isFile()) {
      if (out.length >= MAX_STEP_FILES) {
        skipped.push({ path: rel, reason: `单次操作超过 ${MAX_STEP_FILES} 个文件` })
        return
      }
      out.push({ abs, rel, size: st.size })
      return
    }
    if (!st.isDirectory()) return
    // 已经存满了就不再往下走：整台电脑模式下删 / 移一个大目录时，不能为了记「跳过了哪些」把整棵树扫一遍
    if (out.length >= MAX_STEP_FILES) {
      skipped.push({ path: rel, reason: `单次操作超过 ${MAX_STEP_FILES} 个文件，这个目录没存快照` })
      return
    }
    let names: string[]
    try {
      names = await fsp.readdir(abs)
    } catch {
      skipped.push({ path: rel, reason: '目录读不了' })
      return
    }
    for (const name of names) {
      if (out.length >= MAX_STEP_FILES) {
        skipped.push({ path: rel, reason: `单次操作超过 ${MAX_STEP_FILES} 个文件，目录里其余内容没存快照` })
        break
      }
      const childRel = joinRel(rel, name)
      // 路径守卫不让 AI 碰的（.env、密钥、.git 等）不存快照，回滚时也不会去动它们
      try {
        this.resolve(childRel)
      } catch {
        skipped.push({ path: childRel, reason: '受保护的路径，不存快照' })
        continue
      }
      await this.walk(path.join(abs, name), childRel, out, skipped)
    }
  }

  /**
   * 改文件前调用：inputs 是工具参数里的路径（文件或目录）。
   * 解析失败的路径直接跳过——工具自己会报同样的路径错误
   */
  async begin(meta: CheckpointMeta, inputs: string[]): Promise<PendingCheckpoint> {
    const targets: { abs: string; rel: string }[] = []
    const seen = new Set<string>()
    for (const input of inputs) {
      let r: { abs: string; rel: string }
      try {
        r = this.resolve(input)
      } catch {
        continue
      }
      if (r.rel === '.' || r.rel === '' || seen.has(keyOf(r.rel))) continue
      seen.add(keyOf(r.rel))
      targets.push(r)
    }
    const entries = new Map<string, PendingEntry>()
    const skipped: { path: string; reason: string }[] = []
    const newDirs: string[] = []
    const files: { abs: string; rel: string; size: number }[] = []
    for (const t of targets) {
      await this.walk(t.abs, t.rel, files, skipped)
      // 记下目标本身和它不存在的上级目录：操作可能会新建它们，回滚时删掉变空的
      const parts = t.rel.split('/')
      for (let i = parts.length; i >= 1; i--) {
        const rel = parts.slice(0, i).join('/')
        const abs = this.resolve(rel).abs
        if (await statOrNull(abs)) break
        newDirs.push(rel)
      }
    }
    let bytes = 0
    for (const f of files) {
      const k = keyOf(f.rel)
      if (entries.has(k)) continue
      if (f.size > MAX_FILE_BYTES) {
        skipped.push({ path: f.rel, reason: `${f.size} 字节，超过单文件 ${MAX_FILE_BYTES} 字节的快照上限` })
        continue
      }
      if (bytes + f.size > MAX_STEP_BYTES) {
        skipped.push({ path: f.rel, reason: `单次操作快照超过 ${MAX_STEP_BYTES} 字节` })
        continue
      }
      let buf: Buffer
      try {
        buf = await fsp.readFile(f.abs)
      } catch {
        skipped.push({ path: f.rel, reason: '读不了（可能被占用）' })
        continue
      }
      bytes += buf.length
      entries.set(k, { path: f.rel, before: await this.putBlob(buf), beforeVersion: versionOf(buf) })
    }
    // 不存在的目标也登记成「改之前不存在」，新建的文件回滚时会被删掉
    // 例外：move 的源被跳过了（大文件等），目标就不登记，否则回滚时会把搬过去的文件当成新建的扔进回收站
    for (const t of targets) {
      const k = keyOf(t.rel)
      if (entries.has(k) || (await statOrNull(t.abs))) continue
      if (skippedCovers({ targets, skipped }, t.rel)) continue
      entries.set(k, { path: t.rel, before: null, beforeVersion: null })
    }
    return new PendingCheckpoint(meta, targets, entries, newDirs, skipped)
  }

  /** 操作成功后调用：记下每个文件改完之后的 version；什么都没变就不记 */
  async commit(p: PendingCheckpoint): Promise<CheckpointStep | null> {
    const files: CheckpointFile[] = []
    const done = new Set<string>()
    // 操作之后再扫一遍目标：move 到新目录、apply_patch 新建的文件都在这里出现
    const now: { abs: string; rel: string; size: number }[] = []
    const ignore: { path: string; reason: string }[] = []
    for (const t of p.targets) await this.walk(t.abs, t.rel, now, ignore)
    for (const f of now) {
      const k = keyOf(f.rel)
      if (done.has(k)) continue
      done.add(k)
      const e = p.entries.get(k)
      if (!e && skippedCovers(p, f.rel)) continue
      const after = await this.currentVersion(f.abs)
      files.push({ path: e?.path ?? f.rel, before: e?.before ?? null, beforeVersion: e?.beforeVersion ?? null, after })
    }
    for (const [k, e] of p.entries) {
      if (done.has(k)) continue
      done.add(k)
      let after: string | null = null
      try {
        after = await this.currentVersion(this.resolve(e.path).abs)
      } catch {
        after = null
      }
      // 原来不存在、现在成了目录（比如 move 到新目录）：里面的文件上面已经逐个记了
      if (after === 'not-a-file' && e.before === null) continue
      files.push({ path: e.path, before: e.before, beforeVersion: e.beforeVersion, after })
    }
    const changed = files.filter((f) => f.beforeVersion !== f.after)
    if (changed.length === 0 && p.skipped.length === 0) return null
    return this.serial(async () => {
      const idx = this.load()
      idx.seq += 1
      const step: CheckpointStep = {
        id: `cp-${idx.seq}`,
        seq: idx.seq,
        ts: this.now(),
        agentId: p.meta.agentId,
        agentName: p.meta.agentName,
        session: p.meta.session,
        task: p.meta.task,
        ...(p.meta.taskWs && p.meta.taskRef ? { taskWs: p.meta.taskWs, taskRef: p.meta.taskRef } : {}),
        tool: p.meta.tool,
        kind: p.meta.kind ?? 'edit',
        files: changed,
        newDirs: p.newDirs,
        skipped: p.skipped
      }
      idx.steps.push(step)
      const pruned = this.prune(idx)
      await this.save()
      if (pruned || ++this.commitsSinceGc >= 50) {
        this.commitsSinceGc = 0
        await this.gc(idx)
      }
      this.changed()
      return step
    })
  }

  /** 按数量、时间清理旧检查点，返回是否删了 */
  private prune(idx: IndexFile): boolean {
    const before = idx.steps.length
    const cutoff = this.now() - MAX_AGE_MS
    idx.steps = idx.steps.filter((s) => s.ts >= cutoff)
    if (idx.steps.length > MAX_STEPS) idx.steps = idx.steps.slice(idx.steps.length - MAX_STEPS)
    return idx.steps.length !== before
  }

  /** 回收不再被引用的 blob；总大小超过上限时从最旧的检查点开始删 */
  private async gc(idx: IndexFile): Promise<void> {
    const sizes = new Map<string, number>()
    let dirs: string[] = []
    try {
      dirs = await fsp.readdir(this.blobDir)
    } catch {
      return
    }
    for (const d of dirs) {
      let names: string[] = []
      try {
        names = await fsp.readdir(path.join(this.blobDir, d))
      } catch {
        continue
      }
      for (const n of names) {
        const st = await statOrNull(path.join(this.blobDir, d, n))
        if (st?.isFile()) sizes.set(n, st.size)
      }
    }
    const refs = (): Set<string> => new Set(idx.steps.flatMap((s) => s.files.map((f) => f.before).filter((b): b is string => !!b)))
    let live = refs()
    let total = [...live].reduce((n, h) => n + (sizes.get(h) ?? 0), 0)
    let trimmed = false
    while (total > MAX_TOTAL_BYTES && idx.steps.length > 1) {
      idx.steps.shift()
      live = refs()
      total = [...live].reduce((n, h) => n + (sizes.get(h) ?? 0), 0)
      trimmed = true
    }
    if (trimmed) await this.save()
    // 只删超过 10 分钟的孤儿，避免删掉正在进行的操作刚存的快照
    const old = this.now() - 10 * 60 * 1000
    for (const n of sizes.keys()) {
      if (live.has(n)) continue
      const p = path.join(this.blobDir, n.slice(0, 2), n)
      const st = await statOrNull(p)
      if (st && st.mtimeMs < old) await fsp.rm(p, { force: true }).catch(() => {})
    }
  }

  /** 按条件选检查点，按时间顺序 */
  select(sel: Selector): CheckpointStep[] {
    const steps = this.load().steps
    if (sel.fromStep) {
      const s = steps.find((x) => x.id === sel.fromStep)
      if (!s) throw new ToolError('NOT_FOUND', `检查点 ${sel.fromStep} 不存在（可能已被清理）`)
      if (sel.agentId && s.agentId !== sel.agentId) throw new ToolError('FORBIDDEN', `检查点 ${s.id} 不是你的，只能回滚自己的改动`)
      // onlyStep：只这一步；后面的步骤改过同一个文件时 plan() 会报冲突
      if (sel.onlyStep) return [s]
      return steps.filter((x) => x.session === s.session && x.agentId === s.agentId && x.seq >= s.seq)
    }
    return steps.filter(
      (x) =>
        x.kind === 'edit' &&
        (!sel.agentId || x.agentId === sel.agentId) &&
        (!sel.session || x.session === sel.session) &&
        (!sel.task || (x.task ?? '').toLowerCase() === sel.task.toLowerCase())
    )
  }

  /** 列出检查点：按会话分组，新的在前 */
  list(sel: Selector, currentSession: string, limit = 50) {
    const steps = this.select({ ...sel, fromStep: undefined }).concat(
      this.load().steps.filter(
        (x) =>
          x.kind === 'rollback' &&
          (!sel.agentId || x.agentId === sel.agentId) &&
          (!sel.session || x.session === sel.session) &&
          (!sel.task || (x.task ?? '').toLowerCase() === sel.task.toLowerCase())
      )
    )
    steps.sort((a, b) => b.seq - a.seq)
    const shown = steps.slice(0, limit)
    const groups = new Map<string, ReturnType<typeof stepView>[]>()
    for (const s of shown) {
      const g = groups.get(s.session) ?? []
      g.push(stepView(s))
      groups.set(s.session, g)
    }
    return {
      current_session: currentSession,
      total: steps.length,
      truncated: steps.length > shown.length,
      sessions: [...groups.entries()].map(([session, list]) => ({
        session,
        current: session === currentSession,
        agent: list[0].agent,
        tasks: [...new Set(list.map((x) => x.task).filter(Boolean))],
        checkpoints: list
      }))
    }
  }

  /** 回滚计划：每个文件要恢复成什么、现在应该是什么版本；顺便找冲突 */
  private async plan(steps: CheckpointStep[], onlyPaths?: Set<string>) {
    const ids = new Set(steps.map((s) => s.id))
    const byKey = new Map<string, { step: CheckpointStep; file: CheckpointFile }[]>()
    for (const step of steps) {
      for (const file of step.files) {
        if (file.rolledBackBy) continue
        const k = keyOf(file.path)
        if (onlyPaths && !onlyPaths.has(k)) continue
        const list = byKey.get(k) ?? []
        list.push({ step, file })
        byKey.set(k, list)
      }
    }
    const all = this.load().steps
    const items: { path: string; restore: string | null; restoreVersion: string | null; expected: string | null; entries: { step: CheckpointStep; file: CheckpointFile }[] }[] = []
    const conflicts: RollbackConflict[] = []
    for (const [k, selected] of byKey) {
      const first = selected[0]
      const p = first.file.path
      // 这个文件从 first 起的全部经过，按先后：不管选没选中、退没退过、是修改还是回滚
      const history: { step: CheckpointStep; file: CheckpointFile }[] = []
      for (const s of all) {
        if (s.seq < first.step.seq) continue
        for (const f of s.files) if (keyOf(f.path) === k) history.push({ step: s, file: f })
      }
      /**
       * first 之后的一次回滚，退掉的又全是 first 之后的步骤：它和被它退掉的那几步合起来等于没动过，
       * 不算「后来又改过」，也不用再退它（退它 = 重做那几步，那就不是「退回 first 之前」了）。
       * 没有这一条的话，一个文件退过一次后，更早的那一步就再也退不了。
       * 找不到它退掉了谁（比如被清理了）就不算，按原来的办法当成一次普通的改动。
       * 前提（arena-006 审查时点出来的）：一次回滚只能退掉一个文件最后面连着的几步，中间夹着没退的会报冲突（下面的 other），
       * 所以「回滚 + 被它退掉的几步」总是正好抵消。以后要是放宽这条（允许跳着退），这里要跟着改
       */
      const cancelsOut = (e: { step: CheckpointStep; file: CheckpointFile }): boolean => {
        if (e.step.kind !== 'rollback' || e.file.rolledBackBy || e.step.seq <= first.step.seq) return false
        let undone = 0
        for (const s of all) {
          for (const f of s.files) {
            if (f.rolledBackBy !== e.step.id || keyOf(f.path) !== k) continue
            if (s.seq <= first.step.seq) return false
            undone++
          }
        }
        return undone > 0
      }
      const entries = selected.filter((e) => !cancelsOut(e))
      const last = history.length > 0 ? history[history.length - 1] : entries[entries.length - 1]
      let bad = false
      for (let i = 1; i < entries.length; i++) {
        if (entries[i].file.beforeVersion !== entries[i - 1].file.after) {
          conflicts.push({
            path: p,
            reason: 'changed_between',
            detail: `${entries[i - 1].step.id} 和 ${entries[i].step.id} 之间这个文件被别的途径改过（比如命令或编辑器），回滚会把那部分也冲掉`,
            expected_version: entries[i - 1].file.after,
            current_version: entries[i].file.beforeVersion
          })
          bad = true
          break
        }
      }
      if (bad) continue
      const other = history.find((h) => !ids.has(h.step.id) && h.step.seq > first.step.seq && !h.file.rolledBackBy && !cancelsOut(h))?.step
      if (other) {
        // 同一个 AI 后面的步骤（只退单独一步时会遇到）和别人的改动分开说
        const mine = other.agentId === first.step.agentId
        conflicts.push({
          path: p,
          reason: mine ? 'touched_later' : 'touched_by_other',
          detail: mine
            ? `${other.agentName} 后来在 ${other.id}（${other.tool}）又改过这个文件，只退前面的会把后面的改动一起冲掉。把后面的步骤一起回滚（不要 only_step），或用 paths 跳过这个文件`
            : `${other.agentName} 在 ${other.id}（${other.tool}）也改过这个文件，回滚会覆盖别人的改动`
        })
        continue
      }
      // 上面只核了要退的那几步之间；中间夹着已经退掉的步骤和回滚时，整条经过也要接得上，
      // 接不上就是那中间被别的途径改过，退回去会把那部分冲掉
      for (let i = 1; i < history.length; i++) {
        if (history[i].file.beforeVersion !== history[i - 1].file.after) {
          conflicts.push({
            path: p,
            reason: 'changed_between',
            detail: `${history[i - 1].step.id} 和 ${history[i].step.id} 之间这个文件被别的途径改过（比如命令或编辑器），回滚会把那部分也冲掉`,
            expected_version: history[i - 1].file.after,
            current_version: history[i].file.beforeVersion
          })
          bad = true
          break
        }
      }
      if (bad) continue
      let abs: string
      try {
        abs = this.resolve(p).abs
      } catch (e) {
        conflicts.push({ path: p, reason: 'not_a_file', detail: (e as Error).message })
        continue
      }
      const current = await this.currentVersion(abs)
      if (current === 'not-a-file') {
        conflicts.push({ path: p, reason: 'not_a_file', detail: '现在这个位置不是普通文件' })
        continue
      }
      if (current !== last.file.after) {
        conflicts.push({
          path: p,
          reason: 'modified_after',
          detail: last.file.after === null ? '检查点之后这个文件又被建出来了' : current === null ? '检查点之后这个文件被删了' : '检查点之后这个文件又被改过',
          expected_version: last.file.after,
          current_version: current
        })
        continue
      }
      if (first.file.before && !(await this.getBlob(first.file.before))) {
        conflicts.push({ path: p, reason: 'snapshot_missing', detail: '快照文件丢失或损坏，恢复不了' })
        continue
      }
      items.push({ path: p, restore: first.file.before, restoreVersion: first.file.beforeVersion, expected: last.file.after, entries })
    }
    const skipped = steps.flatMap((s) => s.skipped.map((x) => ({ ...x, checkpoint: s.id })))
    return { items, conflicts, skipped }
  }

  private async trash(abs: string, rel: string): Promise<void> {
    const id = `${this.now()}-${crypto.randomBytes(3).toString('hex')}`
    const dir = path.join(this.trashDir, id)
    await fsp.mkdir(dir, { recursive: true })
    const target = path.join(dir, path.basename(abs))
    try {
      await fsp.rename(abs, target)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
      await fsp.cp(abs, target, { recursive: true, verbatimSymlinks: true })
      await fsp.rm(abs, { recursive: true, force: true })
    }
    await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ originalPath: rel, absPath: abs, deletedAt: this.now(), reason: 'checkpoint_rollback' }))
  }

  private async writeAtomic(abs: string, data: Buffer): Promise<void> {
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    const tmp = `${abs}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    await fsp.writeFile(tmp, data)
    try {
      await fsp.rename(tmp, abs)
    } catch (e) {
      await fsp.rm(tmp, { force: true })
      if ((e as NodeJS.ErrnoException).code === 'EPERM') await fsp.writeFile(abs, data)
      else throw e
    }
  }

  /** 把一个文件恢复成 blob 的内容；blob 为 null 表示恢复成「不存在」（移进回收站） */
  private async restoreOne(rel: string, blob: string | null): Promise<'restored' | 'removed' | 'unchanged'> {
    const { abs } = this.resolve(rel)
    if (blob === null) {
      if (!(await statOrNull(abs))) return 'unchanged'
      await this.trash(abs, rel)
      return 'removed'
    }
    const data = await this.getBlob(blob)
    if (!data) throw new ToolError('SNAPSHOT_MISSING', `${rel} 的快照丢失或损坏`)
    await this.writeAtomic(abs, data)
    return 'restored'
  }

  /**
   * 回滚：steps 里还没退回的文件恢复成第一次改之前的样子。
   * 有任何冲突就一个都不写，抛 CONFLICT（data.conflicts 列出每个文件的原因）
   */
  async rollback(
    meta: CheckpointMeta,
    steps: CheckpointStep[],
    opts: { paths?: string[]; dryRun?: boolean } = {}
  ) {
    let only: Set<string> | undefined
    if (opts.paths && opts.paths.length > 0) {
      only = new Set<string>()
      for (const p of opts.paths) only.add(keyOf(this.resolve(p).rel))
    }
    const { items, conflicts, skipped } = await this.plan(steps, only)
    const stepIds = [...new Set(items.map((i) => i.entries.map((e) => e.step.id)).flat())]
    const preview = items.map((i) => ({
      path: i.path,
      action: i.restore === null ? 'delete' : i.expected === null ? 'recreate' : 'restore',
      restore_version: i.restoreVersion,
      current_version: i.expected
    }))
    if (items.length === 0 && conflicts.length === 0) {
      throw new ToolError('NOTHING_TO_ROLLBACK', '没有可以回滚的改动（可能已经回滚过，或这个范围里没有改文件）', { skipped })
    }
    if (conflicts.length > 0) {
      throw new ToolError('CONFLICT', `${conflicts.length} 个文件有冲突，什么都没恢复。可以先处理冲突，或只传 paths 回滚没冲突的文件`, {
        conflicts,
        restorable: items.map((i) => i.path),
        skipped
      })
    }
    if (opts.dryRun) return { dry_run: true, files: preview, checkpoints: stepIds, skipped }

    const pending = await this.begin({ ...meta, kind: 'rollback' }, items.map((i) => i.path))
    const done: string[] = []
    const results: { path: string; action: string }[] = []
    try {
      for (const it of items) {
        const r = await this.restoreOne(it.path, it.restore)
        done.push(it.path)
        results.push({ path: it.path, action: r === 'removed' ? 'deleted' : it.expected === null ? 'recreated' : r })
      }
    } catch (e) {
      // 中途失败：已经恢复的文件按刚拍的快照退回去，不留半截状态
      for (const rel of done) {
        const pe = pending.entries.get(keyOf(rel))
        await this.restoreOne(rel, pe?.before ?? null).catch(() => {})
      }
      throw e
    }
    // 回滚删掉新建文件后，当初被一起建出来、现在空了的目录也删掉（从最深的开始）
    const rolledSteps = new Set(stepIds)
    const dirs = [...new Set(steps.filter((s) => rolledSteps.has(s.id)).flatMap((s) => s.newDirs))].sort(
      (a, b) => b.split('/').length - a.split('/').length
    )
    for (const d of dirs) {
      try {
        const { abs } = this.resolve(d)
        const st = await statOrNull(abs)
        if (st?.isDirectory() && (await fsp.readdir(abs)).length === 0) await fsp.rmdir(abs)
      } catch {
        // 不空或删不了就留着
      }
    }
    const step = await this.commit(pending)
    await this.serial(async () => {
      const mark = step?.id ?? `rollback-${this.now()}`
      for (const it of items) {
        for (const e of it.entries) {
          e.file.rolledBackBy = mark
          // 回滚的是一次回滚（= 重做）：把那次回滚标记过的文件放回「未回滚」
          if (e.step.kind === 'rollback') {
            for (const s of this.load().steps) {
              for (const f of s.files) if (f.rolledBackBy === e.step.id && keyOf(f.path) === keyOf(it.path)) delete f.rolledBackBy
            }
          }
        }
      }
      await this.save()
    })
    this.changed()
    return { checkpoint: step?.id ?? null, files: results, rolled_back_checkpoints: stepIds, skipped }
  }

  /**
   * 改动汇总：选中检查点里还没回滚的文件，从「第一次改之前」到「现在磁盘上」的净变化 + 合并好的 diff
   */
  async summary(steps: CheckpointStep[], opts: { maxDiffBytes?: number; title?: string; perFileDiffBytes?: number } = {}) {
    const maxDiff = opts.maxDiffBytes ?? 60000
    /** 给了就在每个文件上带它自己的 diff（工作台用），超过这个字节数截断 */
    const perFile = opts.perFileDiffBytes
    const byKey = new Map<string, { step: CheckpointStep; file: CheckpointFile }[]>()
    for (const step of steps) {
      if (step.kind !== 'edit') continue
      for (const file of step.files) {
        if (file.rolledBackBy) continue
        const k = keyOf(file.path)
        const list = byKey.get(k) ?? []
        list.push({ step, file })
        byKey.set(k, list)
      }
    }
    const files: {
      path: string
      status: 'added' | 'modified' | 'deleted'
      additions: number
      deletions: number
      binary?: boolean
      too_large?: boolean
      changed_outside?: boolean
      checkpoints: string[]
      diff?: string
      diff_truncated?: boolean
    }[] = []
    const attach = (item: (typeof files)[number], d: string): void => {
      if (perFile === undefined) return
      if (Buffer.byteLength(d) > perFile) {
        item.diff = Buffer.from(d).subarray(0, perFile).toString('utf8').replace(/\uFFFD*$/, '') + '\n…（diff 太长已截断）\n'
        item.diff_truncated = true
      } else item.diff = d
    }
    let unchanged = 0
    const diffs: string[] = []
    const keys = [...byKey.keys()].sort((a, b) => a.localeCompare(b))
    for (const k of keys) {
      const entries = byKey.get(k)!
      const first = entries[0]
      const last = entries[entries.length - 1]
      const rel = first.file.path
      let abs: string
      try {
        abs = this.resolve(rel).abs
      } catch {
        continue
      }
      const st = await statOrNull(abs)
      const nowBuf = st?.isFile() ? await fsp.readFile(abs) : null
      const nowVersion = nowBuf ? versionOf(nowBuf) : null
      if (nowVersion === first.file.beforeVersion) {
        unchanged++
        continue
      }
      const beforeBuf = first.file.before ? await this.getBlob(first.file.before) : null
      const status = first.file.beforeVersion === null ? 'added' : nowBuf === null ? 'deleted' : 'modified'
      const item: (typeof files)[number] = { path: rel, status, additions: 0, deletions: 0, checkpoints: entries.map((e) => e.step.id) }
      if (nowVersion !== last.file.after) item.changed_outside = true
      const big = (beforeBuf?.length ?? 0) > MAX_DIFF_FILE_BYTES || (nowBuf?.length ?? 0) > MAX_DIFF_FILE_BYTES
      const binary = (beforeBuf && isBinary(beforeBuf)) || (nowBuf && isBinary(nowBuf))
      if (first.file.before && !beforeBuf) {
        item.too_large = true
        diffs.push(`diff --bridge a/${rel} b/${rel}\n（快照丢失，无法出 diff）\n`)
        attach(item, '')
      } else if (big) {
        item.too_large = true
        diffs.push(`diff --bridge a/${rel} b/${rel}\n（文件超过 ${MAX_DIFF_FILE_BYTES} 字节，不出 diff）\n`)
        attach(item, '')
      } else if (binary) {
        item.binary = true
        diffs.push(`diff --bridge a/${rel} b/${rel}\nBinary files differ\n`)
        attach(item, '')
      } else {
        const a = beforeBuf ? textOf(beforeBuf) : ''
        const b = nowBuf ? textOf(nowBuf) : ''
        const d = createTwoFilesPatch(status === 'added' ? '/dev/null' : `a/${rel}`, status === 'deleted' ? '/dev/null' : `b/${rel}`, a, b, '', '', { context: 3 })
        const n = countLines(d)
        item.additions = n.additions
        item.deletions = n.deletions
        const clean = d.replace(/^=+\n/m, '')
        diffs.push(clean)
        attach(item, clean)
      }
      files.push(item)
    }
    let diff = diffs.join('\n')
    const truncated = Buffer.byteLength(diff) > maxDiff
    if (truncated) diff = Buffer.from(diff).subarray(0, maxDiff).toString('utf8').replace(/\uFFFD*$/, '') + '\n…（diff 太长已截断，调大 max_diff_bytes 或按 paths 分开看）\n'
    const adds = files.reduce((n, f) => n + f.additions, 0)
    const dels = files.reduce((n, f) => n + f.deletions, 0)
    const mark = { added: 'A', modified: 'M', deleted: 'D' } as const
    const lines = files.map(
      (f) =>
        `- ${mark[f.status]} ${f.path}` +
        (f.binary ? '（二进制）' : f.too_large ? '（太大，无 diff）' : ` (+${f.additions} -${f.deletions})`) +
        (f.changed_outside ? '（检查点之后被别的途径改过）' : '')
    )
    const review_text =
      files.length === 0
        ? '改动汇总：没有净改动。'
        : [`改动汇总${opts.title ? `（${opts.title}）` : ''}：${files.length} 个文件，+${adds} -${dels}`, ...lines].join('\n')
    return {
      files,
      totals: { files: files.length, additions: adds, deletions: dels, unchanged_after_edits: unchanged, checkpoints: steps.filter((s) => s.kind === 'edit').length },
      diff,
      diff_truncated: truncated,
      review_text
    }
  }
}

/** unified diff 里的增删行数（不算 +++ / --- 文件头） */
function countLines(d: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of d.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return { additions, deletions }
}

function stepView(s: CheckpointStep) {
  const rolled = s.files.filter((f) => f.rolledBackBy).length
  return {
    id: s.id,
    time: new Date(s.ts).toISOString(),
    agent: s.agentName,
    tool: s.tool,
    kind: s.kind,
    task: s.task,
    files: s.files.slice(0, 20).map((f) => ({
      path: f.path,
      change: f.beforeVersion === null ? 'added' : f.after === null ? 'deleted' : 'modified'
    })),
    more_files: Math.max(0, s.files.length - 20),
    rolled_back: rolled === 0 ? 'none' : rolled === s.files.length ? 'all' : 'partial',
    ...(s.skipped.length > 0 ? { not_snapshotted: s.skipped.slice(0, 10) } : {})
  }
}
