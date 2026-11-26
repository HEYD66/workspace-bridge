// 回收站：<trash>/<id>/<被删的东西> + manifest.json。
// 往里放的有四处（文件工具的 delete / move 覆盖、apply_patch、检查点回滚、技能删除和覆盖），格式一样；
// 这里只管看、恢复、彻底删除。整个 Bridge 共用一个回收站，不分工作区
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ToolError } from './fileTools'
import type { TrashItem } from './types'

/** 回收站条目的 id：毫秒时间戳 + 6 位十六进制。只认这个格式，别的名字一律不碰 */
const TRASH_ID = /^\d{10,16}-[0-9a-f]{6}$/
const MANIFEST = 'manifest.json'
/** 算大小时最多数这么多个文件，再多就只给下限（删掉的 node_modules 可能有几十万个文件） */
const SIZE_WALK_LIMIT = 20_000

interface Manifest {
  originalPath?: unknown
  absPath?: unknown
  deletedAt?: unknown
  reason?: unknown
  skill?: unknown
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 这一项原来的绝对位置；老版本删的东西没记（只有工作区相对路径）时返回 undefined */
export function trashOrigin(item: Pick<TrashItem, 'absPath' | 'originalPath'>): string | undefined {
  if (item.absPath) return item.absPath
  return path.isAbsolute(item.originalPath) ? item.originalPath : undefined
}

/** origin 落在哪个工作区里：先在普通工作区里找（嵌套时取最里面的），找不到再用「整台电脑」（列表里有才算） */
export function trashHome<T extends { root: string; kind?: 'machine' }>(origin: string, workspaces: T[]): T | undefined {
  const dirs = workspaces.filter((w) => w.kind !== 'machine' && isInside(origin, w.root)).sort((a, b) => b.root.length - a.root.length)
  return dirs[0] ?? workspaces.find((w) => w.kind === 'machine')
}

export class TrashStore {
  /** 条目放进去之后内容不变，大小算过就记住 */
  private sizes = new Map<string, { bytes: number; files: number; capped: boolean }>()

  /** onChange：恢复或彻底删除之后调用（工作台刷新用）；恢复时带上那一项 */
  constructor(
    private readonly dir: string,
    private readonly onChange?: (restored?: TrashItem) => void
  ) {}

  private changed(restored?: TrashItem): void {
    try {
      this.onChange?.(restored)
    } catch {
      // 回调出错不影响回收站操作
    }
  }

  private holder(id: string): string {
    if (!TRASH_ID.test(id)) throw new ToolError('INVALID_ARGS', `${id} 不是回收站条目的 id（先用 trash_list 查）`)
    return path.join(this.dir, id)
  }

  private async measure(id: string, target: string): Promise<{ bytes: number; files: number; capped: boolean }> {
    const hit = this.sizes.get(id)
    if (hit) return hit
    let bytes = 0
    let files = 0
    let capped = false
    const stack = [target]
    while (stack.length) {
      const cur = stack.pop()!
      let st
      try {
        st = await fsp.lstat(cur)
      } catch {
        continue
      }
      // 链接不跟进去：只算链接本身
      if (st.isDirectory() && !st.isSymbolicLink()) {
        let names: string[] = []
        try {
          names = await fsp.readdir(cur)
        } catch {
          // 读不了的目录跳过
        }
        for (const n of names) stack.push(path.join(cur, n))
      } else {
        bytes += st.size
        files++
        if (files >= SIZE_WALK_LIMIT) {
          capped = stack.length > 0
          break
        }
      }
    }
    const r = { bytes, files, capped }
    this.sizes.set(id, r)
    return r
  }

  private async read(id: string): Promise<TrashItem | null> {
    const holder = path.join(this.dir, id)
    let names: string[]
    try {
      names = await fsp.readdir(holder)
    } catch {
      return null
    }
    const name = names.find((n) => n !== MANIFEST)
    // 只剩清单、东西已经不在的空壳不算
    if (!name) return null
    let m: Manifest = {}
    try {
      m = JSON.parse(await fsp.readFile(path.join(holder, MANIFEST), 'utf8')) as Manifest
    } catch {
      // 清单丢了或坏了：只知道名字，时间从 id 里取
    }
    const target = path.join(holder, name)
    let isDir = false
    try {
      const st = await fsp.lstat(target)
      isDir = st.isDirectory() && !st.isSymbolicLink()
    } catch {
      return null
    }
    const size = await this.measure(id, target)
    const item: TrashItem = {
      id,
      name,
      originalPath: typeof m.originalPath === 'string' && m.originalPath ? m.originalPath : name,
      deletedAt: typeof m.deletedAt === 'number' ? m.deletedAt : Number(id.split('-')[0]),
      kind: isDir ? 'dir' : 'file',
      bytes: size.bytes,
      files: size.files,
      source: typeof m.skill === 'string' ? 'skill' : m.reason === 'checkpoint_rollback' ? 'rollback' : 'delete'
    }
    if (typeof m.absPath === 'string' && path.isAbsolute(m.absPath)) item.absPath = m.absPath
    if (size.capped) item.sizeCapped = true
    if (typeof m.skill === 'string') item.skill = m.skill
    return item
  }

  /** 全部条目，最近删的在前 */
  async list(): Promise<TrashItem[]> {
    let ids: string[]
    try {
      ids = (await fsp.readdir(this.dir)).filter((n) => TRASH_ID.test(n))
    } catch {
      return []
    }
    const items = (await Promise.all(ids.map((id) => this.read(id)))).filter((x): x is TrashItem => x !== null)
    return items.sort((a, b) => b.deletedAt - a.deletedAt || (a.id < b.id ? 1 : -1))
  }

  async get(id: string): Promise<TrashItem> {
    this.holder(id)
    const item = await this.read(id)
    if (!item) throw new ToolError('NOT_FOUND', `回收站里没有 ${id}（可能已经恢复或清掉了）`)
    return item
  }

  /** 放回 dest（绝对路径，调用方已经过路径守卫）。那里已经有东西就不动，抛 ALREADY_EXISTS */
  async restore(id: string, dest: string): Promise<TrashItem> {
    const item = await this.get(id)
    const holder = this.holder(id)
    const from = path.join(holder, item.name)
    const exists = await fsp.lstat(dest).then(
      () => true,
      () => false
    )
    if (exists) throw new ToolError('ALREADY_EXISTS', `${dest} 那里已经有东西了，先把它挪走或改名再恢复`)
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    try {
      await fsp.rename(from, dest)
    } catch (e) {
      // 回收站和原位置不在同一个盘
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
      await fsp.cp(from, dest, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })
      await fsp.rm(from, { recursive: true, force: true })
    }
    await fsp.rm(holder, { recursive: true, force: true })
    this.sizes.delete(id)
    this.changed(item)
    return item
  }

  /**
   * 彻底删除，恢复不了。ids 不传 = 全部；olderThan 只删这个时间点之前删的。
   * 删不掉的（文件被占用）留着，记在 failed 里
   */
  async purge(opts: { ids?: string[]; olderThan?: number } = {}): Promise<{ removed: number; bytes: number; failed: string[] }> {
    if (opts.ids) for (const id of opts.ids) this.holder(id)
    let items = await this.list()
    if (opts.ids) {
      const want = new Set(opts.ids)
      items = items.filter((x) => want.has(x.id))
    }
    if (opts.olderThan !== undefined) items = items.filter((x) => x.deletedAt < opts.olderThan!)
    let removed = 0
    let bytes = 0
    const failed: string[] = []
    for (const it of items) {
      try {
        await fsp.rm(path.join(this.dir, it.id), { recursive: true, force: true, maxRetries: 2 })
        this.sizes.delete(it.id)
        removed++
        bytes += it.bytes
      } catch {
        failed.push(it.id)
      }
    }
    // 没指定条目的清空顺手带走空壳（只剩清单的目录）
    if (!opts.ids && opts.olderThan === undefined) {
      const rest = await fsp.readdir(this.dir).catch(() => [] as string[])
      for (const n of rest) {
        if (!TRASH_ID.test(n) || failed.includes(n)) continue
        await fsp.rm(path.join(this.dir, n), { recursive: true, force: true }).catch(() => {})
      }
    }
    if (removed) this.changed()
    return { removed, bytes, failed }
  }
}
