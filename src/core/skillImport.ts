import fs from 'node:fs'
import path from 'node:path'
import { decode } from './encoding'
import { MAX_SKILL_BYTES, MAX_SKILL_FILES, NAME_RULE, parseSkillMd, SKILL_NAME_RE, SkillError, walkSkillDir } from './skills'
import { readZip, ZipError } from './zipReader'

/**
 * 导入现成的技能包：用户在工作台选一个文件夹，或一个 .zip / .skill 文件，这里找出里面的技能（含 SKILL.md 的目录）。
 *
 * - 文件夹本身有 SKILL.md：它就是一个技能。
 * - 没有：往下找，最多 MAX_DEPTH 层，每个含 SKILL.md 的目录是一个技能（选 ~/.claude/skills 这种装着很多技能的文件夹就一次全找出来）。
 *   找到技能后不再往它里面找。
 * - zip：SKILL.md 在最外层，整个包是一个技能；否则每个含 SKILL.md 的目录是一个技能。
 *
 * 只扫描、不写入：写入由 SkillStore.importPackage 做。
 */

/** zip 文件本身的大小上限 */
export const MAX_IMPORT_ZIP_BYTES = 50 * 1024 * 1024
/** 一次最多找出这么多个技能 */
export const MAX_IMPORT_PACKAGES = 200
/** 文件夹里往下找 SKILL.md 的层数（选中的文件夹是第 0 层） */
const MAX_DEPTH = 4
/** 找技能时最多看这么多个目录，免得选了整个盘一直扫 */
const MAX_DIRS = 5000
/** 不属于技能内容的东西：找技能时不进去，导入时不复制 */
const SKIP_NAMES: ReadonlySet<string> = new Set(['.git', 'node_modules', '__MACOSX', '.DS_Store', 'Thumbs.db'])

export interface SkillPackageFile {
  /** 技能目录内的相对路径，/ 分隔 */
  rel: string
  size: number
  read: () => Buffer
}

export interface SkillPackage {
  /** 在这次选的来源里的位置（相对路径，来源本身是 "."），确认导入时用它指定要哪几个 */
  key: string
  /** 导入后的技能名（也是目录名）；定不出合法名字时是原来的目录名，problem 里有说明 */
  name: string
  description: string
  files: SkillPackageFile[]
  bytes: number
  hasScripts: boolean
  /** 有这个字段就导入不了 */
  problem?: string
}

export interface SkillSourceScan {
  kind: 'folder' | 'zip'
  packages: SkillPackage[]
}

/** 给界面的预览：一个技能一行 */
export interface SkillImportItem {
  key: string
  name: string
  description: string
  files: number
  bytes: number
  hasScripts: boolean
  problem?: string
}

export interface SkillImportPreview {
  importId: string
  /** 用户选的文件夹或文件的绝对路径 */
  source: string
  kind: 'folder' | 'zip'
  items: SkillImportItem[]
}

export interface SkillImportOptions {
  scope: 'project' | 'user'
  /** 同名技能已存在时：true 把旧的移进回收站再导入；false 跳过，结果里是 exists */
  overwrite?: boolean
  /** 只导入这些（SkillImportItem.key）；不给就是全部能导入的 */
  keys?: string[]
}

export interface SkillImportResult {
  results: {
    key: string
    name: string
    /** imported 新导入；replaced 覆盖了同名的；exists 同名已存在、没有覆盖；failed 导入不了 */
    status: 'imported' | 'replaced' | 'exists' | 'failed'
    /** 导入成功时的技能 id */
    id?: string
    problem?: string
  }[]
}

function slug(s: string | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 64)
}

/**
 * 导入后叫什么：SKILL.md 里写的 name 合法就用它，否则用目录名，再不行把它们转成小写连字符的写法。
 * 都不行返回 undefined（比如目录名全是中文、SKILL.md 里也没写 name）
 */
export function importSkillName(metaName: string | undefined, folder: string): string | undefined {
  return [metaName?.trim(), folder, slug(metaName), slug(folder)].find((c): c is string => !!c && SKILL_NAME_RE.test(c))
}

function buildPackage(key: string, folder: string, files: SkillPackageFile[], problem?: string): SkillPackage {
  const md = files.find((f) => f.rel.toLowerCase() === 'skill.md')
  let description = ''
  let metaName: string | undefined
  let p = problem
  if (md) {
    md.rel = 'SKILL.md'
    try {
      const parsed = parseSkillMd(decode(md.read()).text)
      description = parsed.description
      metaName = parsed.meta.name
    } catch (e) {
      p ??= `SKILL.md 读不了：${e instanceof Error ? e.message : String(e)}`
    }
  } else {
    p ??= '缺少 SKILL.md'
  }
  const bytes = files.reduce((n, f) => n + f.size, 0)
  if (files.length > MAX_SKILL_FILES) p ??= `文件超过 ${MAX_SKILL_FILES} 个`
  if (bytes > MAX_SKILL_BYTES) p ??= `总大小超过 ${MAX_SKILL_BYTES / 1024 / 1024} MB`
  const name = importSkillName(metaName, folder)
  if (!name) p ??= `定不出合法的名字：SKILL.md 里没有写合法的 name，目录名「${folder}」也不合法。${NAME_RULE}`
  return {
    key,
    name: name ?? folder,
    description,
    files,
    bytes,
    hasScripts: files.some((f) => f.rel.startsWith('scripts/')),
    ...(p ? { problem: p } : {})
  }
}

// ---------- 文件夹 ----------

function hasSkillMd(entries: fs.Dirent[]): boolean {
  return entries.some((e) => e.isFile() && e.name.toLowerCase() === 'skill.md')
}

/** 含 SKILL.md 的目录；找到后不再往里找。按广度优先，所以离选中的文件夹近的先找到 */
function findSkillDirs(src: string): string[] {
  const roots: string[] = []
  const queue: { dir: string; depth: number }[] = [{ dir: src, depth: 0 }]
  let seen = 0
  while (queue.length && roots.length < MAX_IMPORT_PACKAGES && seen < MAX_DIRS) {
    const { dir, depth } = queue.shift()!
    seen++
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    if (hasSkillMd(entries)) {
      roots.push(dir)
      continue
    }
    if (depth >= MAX_DEPTH) continue
    for (const e of entries) {
      // 不跟符号链接和 junction 走（Dirent 把 junction 报成链接）
      if (e.isDirectory() && !e.isSymbolicLink() && !SKIP_NAMES.has(e.name)) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 })
    }
  }
  return roots
}

function scanFolder(src: string): SkillPackage[] {
  return findSkillDirs(src).map((dir) => {
    const w = walkSkillDir(dir, SKIP_NAMES)
    const files: SkillPackageFile[] = w.files.map((f) => ({
      rel: f.rel,
      size: f.size,
      read: () => {
        // 扫描之后被换成链接：不跟着读到别处
        if (fs.lstatSync(f.abs).isSymbolicLink()) throw new SkillError('INVALID_PATH', `${f.rel} 是符号链接`)
        return fs.readFileSync(f.abs)
      }
    }))
    const key = path.relative(src, dir).replace(/\\/g, '/') || '.'
    return buildPackage(key, path.basename(dir), files, w.problem)
  })
}

// ---------- zip ----------

function scanZip(file: string): SkillPackage[] {
  const st = fs.statSync(file)
  if (st.size > MAX_IMPORT_ZIP_BYTES) throw new SkillError('TOO_LARGE', `文件有 ${Math.round(st.size / 1024 / 1024)} MB，超过 ${MAX_IMPORT_ZIP_BYTES / 1024 / 1024} MB 上限`)
  let entries
  try {
    entries = readZip(fs.readFileSync(file))
  } catch (e) {
    if (e instanceof ZipError) throw new SkillError('INVALID_SKILL', e.message)
    throw e
  }
  const items: { segs: string[]; size: number; symlink: boolean; read: () => Buffer }[] = []
  for (const e of entries) {
    const segs = e.name.split('/').filter((s) => s !== '' && s !== '.')
    // 越出压缩包的路径：整个包都不可信
    if (segs.includes('..') || /^[a-zA-Z]:/.test(segs[0] ?? '')) throw new SkillError('INVALID_PATH', `压缩包里有越出目录的路径：${e.name}`)
    if (!segs.length || segs.some((s) => SKIP_NAMES.has(s))) continue
    items.push({ segs, size: e.size, symlink: e.symlink, read: e.read })
  }
  // 含 SKILL.md 的目录，短的在前；在另一个技能目录里面的不单算（它是那个技能的附带文件）
  const dirs = items
    .filter((i) => i.segs[i.segs.length - 1].toLowerCase() === 'skill.md')
    .map((i) => i.segs.slice(0, -1))
    .sort((a, b) => a.length - b.length)
  const roots: string[][] = []
  for (const d of dirs) {
    if (!roots.some((r) => r.length <= d.length && r.every((s, i) => s === d[i]))) roots.push(d)
  }
  const fallback = path.basename(file).replace(/\.(zip|skill)$/i, '')
  return roots.slice(0, MAX_IMPORT_PACKAGES).map((root) => {
    const inside = items.filter((i) => i.segs.length > root.length && root.every((s, k) => s === i.segs[k]))
    const link = inside.find((i) => i.symlink)
    const files: SkillPackageFile[] = inside.map((i) => ({ rel: i.segs.slice(root.length).join('/'), size: i.size, read: i.read }))
    return buildPackage(root.join('/') || '.', root[root.length - 1] ?? fallback, files, link ? `压缩包里有符号链接：${link.segs.join('/')}` : undefined)
  })
}

/** 扫描用户选的文件夹或 zip；一个技能都没找到时抛 INVALID_SKILL */
export function scanSkillSource(src: string): SkillSourceScan {
  let st: fs.Stats
  try {
    st = fs.statSync(src)
  } catch {
    throw new SkillError('INVALID_PATH', `读不了 ${src}`)
  }
  let kind: SkillSourceScan['kind']
  let packages: SkillPackage[]
  if (st.isDirectory()) {
    kind = 'folder'
    packages = scanFolder(src)
    if (!packages.length) throw new SkillError('INVALID_SKILL', `这个文件夹和它下面 ${MAX_DEPTH} 层以内都没有找到 SKILL.md`)
  } else if (st.isFile() && /\.(zip|skill)$/i.test(src)) {
    kind = 'zip'
    packages = scanZip(src)
    if (!packages.length) throw new SkillError('INVALID_SKILL', '压缩包里没有找到 SKILL.md')
  } else {
    throw new SkillError('INVALID_SKILL', '只能导入文件夹，或 .zip、.skill 文件')
  }
  // 按码位排，不随系统语言变（中文系统下 localeCompare 会把汉字排到字母前面）
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  // 重名时目录名就是技能名的排前面（比如 visualize 和它的备份目录 .visualize-backup 都叫 visualize，要的是前一个），再是路径短的
  const exact = (p: SkillPackage): number => (p.key.split('/').pop() === p.name ? 0 : 1)
  packages.sort((a, b) => cmp(a.name, b.name) || exact(a) - exact(b) || a.key.length - b.key.length || cmp(a.key, b.key))
  // 同一次里重名的只留第一个能导入
  const seen = new Set<string>()
  for (const p of packages) {
    if (p.problem) continue
    const k = p.name.toLowerCase()
    if (seen.has(k)) p.problem = `和这次选的另一个技能重名（${p.name}）`
    else seen.add(k)
  }
  return { kind, packages }
}

export function toImportItem(p: SkillPackage): SkillImportItem {
  return {
    key: p.key,
    name: p.name,
    description: p.description,
    files: p.files.length,
    bytes: p.bytes,
    hasScripts: p.hasScripts,
    ...(p.problem ? { problem: p.problem } : {})
  }
}
