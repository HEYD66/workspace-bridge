// 导入现成的技能包：扫描文件夹 / zip（skillImport.ts、zipReader.ts）、写入（SkillStore.importPackage）、
// 工作台的两步接口（Bridge.previewSkillImport / applySkillImport）。每个用例一个干净的临时目录
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { MACHINE_WORKSPACE_ID } from '../src/core/config'
import { importSkillName, scanSkillSource } from '../src/core/skillImport'
import { SkillError, SkillStore } from '../src/core/skills'
import { readZip, ZipError } from '../src/core/zipReader'

let base: string
let src: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-skillimport-'))
  src = path.join(base, 'src')
  fs.mkdirSync(src)
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

/** 在 root 下写一批文件（相对路径 → 内容） */
function put(root: string, files: Record<string, string | Buffer>): string {
  for (const [rel, data] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, data)
  }
  return root
}

const md = (name: string | undefined, description: string, body = '正文') => `---\n${name === undefined ? '' : `name: ${name}\n`}description: ${description}\n---\n\n${body}\n`

interface ZipFile {
  name: string
  data: string | Buffer
  /** 不压缩 */
  store?: boolean
  /** Unix 符号链接 */
  symlink?: boolean
  /** 目录里写的解压后大小（造假用） */
  fakeSize?: number
}

/** 手写一个最小的 zip（测试用）：本地头 + 数据、中央目录、结尾记录 */
function makeZip(files: ZipFile[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8')
    const name = Buffer.from(f.name, 'utf8')
    const method = f.store ? 0 : 8
    const comp = f.store ? raw : zlib.deflateRawSync(raw)
    const crc = zlib.crc32(raw) >>> 0
    const size = f.fakeSize ?? raw.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, comp)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(f.symlink ? (3 << 8) | 20 : 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(comp.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(f.symlink ? (0o120777 << 16) >>> 0 : 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + comp.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

function writeZip(name: string, files: ZipFile[]): string {
  const file = path.join(base, name)
  fs.writeFileSync(file, makeZip(files))
  return file
}

/** SkillError 的错误码；没抛错返回 OK */
function code(fn: () => unknown): string {
  try {
    fn()
    return 'OK'
  } catch (e) {
    return e instanceof SkillError ? e.code : `非 SkillError：${String(e)}`
  }
}

describe('zip 解析', () => {
  it('读出压缩和不压缩的条目，跳过目录条目，内容一致', () => {
    const zip = makeZip([
      { name: 'a/', data: '', store: true },
      { name: 'a/SKILL.md', data: '你好 skill\n'.repeat(50) },
      { name: 'a/raw.bin', data: Buffer.from([0, 1, 2, 255]), store: true }
    ])
    const entries = readZip(zip)
    expect(entries.map((e) => [e.name, e.size, e.symlink])).toEqual([
      ['a/SKILL.md', Buffer.byteLength('你好 skill\n'.repeat(50)), false],
      ['a/raw.bin', 4, false]
    ])
    expect(entries[0].read().toString('utf8')).toBe('你好 skill\n'.repeat(50))
    expect([...entries[1].read()]).toEqual([0, 1, 2, 255])
  })

  it('不是 zip、目录里写的大小是假的（zip 炸弹）、超过上限都报错', () => {
    expect(() => readZip(Buffer.from('不是压缩包'))).toThrow(ZipError)
    // 实际 4000 字节，目录里只写 10：解压时发现不对
    const bomb = readZip(makeZip([{ name: 'big.txt', data: 'x'.repeat(4000), fakeSize: 10 }]))
    expect(() => bomb[0].read()).toThrow(ZipError)
    const two = makeZip([
      { name: 'a.txt', data: 'x'.repeat(600) },
      { name: 'b.txt', data: 'x'.repeat(600) }
    ])
    expect(() => readZip(two, { maxEntries: 1, maxTotalBytes: 1e9 })).toThrow(/条目/)
    expect(() => readZip(two, { maxEntries: 10, maxTotalBytes: 1000 })).toThrow(/超过/)
  })

  it('内容被改坏：校验不通过', () => {
    const zip = makeZip([{ name: 'a.txt', data: 'hello world', store: true }])
    zip[30 + 'a.txt'.length] ^= 0xff
    expect(() => readZip(zip)[0].read()).toThrow(/校验/)
  })
})

describe('导入后的名字', () => {
  it('SKILL.md 里的 name 合法就用它，否则用目录名，再不行转成小写连字符', () => {
    expect(importSkillName('code-review', 'whatever')).toBe('code-review')
    expect(importSkillName('PDF Tools', 'pdf-tools')).toBe('pdf-tools')
    expect(importSkillName('PDF Tools', '我的技能')).toBe('pdf-tools')
    expect(importSkillName(undefined, 'My_Skill v2')).toBe('my_skill-v2')
    expect(importSkillName(undefined, '我的技能')).toBeUndefined()
    expect(importSkillName('', '---')).toBeUndefined()
  })
})

describe('扫描文件夹', () => {
  it('选中的文件夹本身就是一个技能：名字、描述、文件、脚本；.git 和 node_modules 不算', () => {
    const dir = put(path.join(src, 'code-review'), {
      'SKILL.md': md('code-review', '审查代码时用'),
      'reference.md': '参考',
      'scripts/run.sh': 'echo hi',
      '.git/config': '[core]',
      'node_modules/x/index.js': 'x',
      '.DS_Store': 'x'
    })
    const scan = scanSkillSource(dir)
    expect(scan.kind).toBe('folder')
    expect(scan.packages).toHaveLength(1)
    const p = scan.packages[0]
    expect({ key: p.key, name: p.name, description: p.description, hasScripts: p.hasScripts, problem: p.problem }).toEqual({
      key: '.',
      name: 'code-review',
      description: '审查代码时用',
      hasScripts: true,
      problem: undefined
    })
    expect(p.files.map((f) => f.rel)).toEqual(['SKILL.md', 'reference.md', 'scripts/run.sh'])
    expect(p.bytes).toBe(p.files.reduce((n, f) => n + f.size, 0))
  })

  it('选中装着多个技能的文件夹：每个含 SKILL.md 的目录是一个，按名字排；找到技能后不往它里面找；太深的找不到', () => {
    put(path.join(src, 'b-skill'), { 'SKILL.md': md('b-skill', 'B'), 'nested/SKILL.md': md('inner', '里面的不单算') })
    put(path.join(src, 'group', 'a-skill'), { 'SKILL.md': md(undefined, 'A') })
    put(path.join(src, 'not-a-skill'), { 'README.md': 'x' })
    put(path.join(src, '1', '2', '3', '4', 'too-deep'), { 'SKILL.md': md('too-deep', '第 5 层') })
    put(path.join(src, '1', '2', '3', 'deep-ok'), { 'SKILL.md': md('deep-ok', '第 4 层') })
    const scan = scanSkillSource(src)
    expect(scan.packages.map((p) => [p.name, p.key])).toEqual([
      ['a-skill', 'group/a-skill'],
      ['b-skill', 'b-skill'],
      ['deep-ok', '1/2/3/deep-ok']
    ])
    expect(scan.packages[1].files.map((f) => f.rel)).toEqual(['SKILL.md', 'nested/SKILL.md'])
  })

  it('名字定不出来、和另一个重名的标出问题；一个 SKILL.md 都没有就报错', () => {
    put(path.join(src, '我的技能'), { 'SKILL.md': md(undefined, '中文目录名') })
    put(path.join(src, 'one'), { 'SKILL.md': md('same', '第一个') })
    put(path.join(src, 'two'), { 'SKILL.md': md('same', '第二个') })
    const scan = scanSkillSource(src)
    const by = Object.fromEntries(scan.packages.map((p) => [p.key, p]))
    expect(by['我的技能'].problem).toMatch(/定不出合法的名字/)
    expect(by['one'].problem).toBeUndefined()
    expect(by['two'].problem).toMatch(/重名/)

    // 重名时留目录名和技能名一样的那个，不是它的备份目录（哪怕备份目录按字母排在前面）
    const dup = path.join(base, 'dup')
    put(path.join(dup, '.viz-backup'), { 'SKILL.md': md('viz', '备份') })
    put(path.join(dup, 'viz'), { 'SKILL.md': md('viz', '正主') })
    expect(scanSkillSource(dup).packages.map((p) => [p.key, !!p.problem])).toEqual([
      ['viz', false],
      ['.viz-backup', true]
    ])

    const empty = path.join(base, 'empty')
    fs.mkdirSync(empty)
    expect(code(() => scanSkillSource(empty))).toBe('INVALID_SKILL')
    expect(code(() => scanSkillSource(path.join(base, 'nope')))).toBe('INVALID_PATH')
    fs.writeFileSync(path.join(base, 'a.txt'), 'x')
    expect(code(() => scanSkillSource(path.join(base, 'a.txt')))).toBe('INVALID_SKILL')
  })
})

describe('扫描 zip', () => {
  it('SKILL.md 在最外层：整个包是一个技能，目录名用不上时用文件名', () => {
    const file = writeZip('My Skill.zip', [
      { name: 'SKILL.md', data: md(undefined, '最外层') },
      { name: 'docs/ref.md', data: '参考' },
      { name: '__MACOSX/._SKILL.md', data: 'x' }
    ])
    const scan = scanSkillSource(file)
    expect(scan.kind).toBe('zip')
    expect(scan.packages.map((p) => [p.key, p.name, p.description, p.files.map((f) => f.rel)])).toEqual([['.', 'my-skill', '最外层', ['SKILL.md', 'docs/ref.md']]])
  })

  it('打包的是文件夹：每个含 SKILL.md 的目录是一个技能；.skill 后缀也认；反斜杠路径也认', () => {
    const file = writeZip('pack.skill', [
      { name: 'skills/alpha/SKILL.md', data: md('alpha', 'A') },
      { name: 'skills/alpha/scripts/x.py', data: 'print(1)' },
      { name: 'skills\\beta\\skill.md', data: md('beta', 'B') },
      { name: 'README.md', data: '不属于任何技能' }
    ])
    const scan = scanSkillSource(file)
    expect(scan.packages.map((p) => [p.key, p.name, p.hasScripts, p.files.map((f) => f.rel)])).toEqual([
      ['skills/alpha', 'alpha', true, ['SKILL.md', 'scripts/x.py']],
      ['skills/beta', 'beta', false, ['SKILL.md']]
    ])
  })

  it('越出目录的路径整个拒绝；有符号链接的技能标出问题；不是 zip 报错；没有 SKILL.md 报错', () => {
    expect(code(() => scanSkillSource(writeZip('slip.zip', [{ name: 'a/SKILL.md', data: md('a', 'x') }, { name: 'a/../../evil.txt', data: 'x' }])))).toBe('INVALID_PATH')
    const link = scanSkillSource(writeZip('link.zip', [{ name: 'a/SKILL.md', data: md('a', 'x') }, { name: 'a/passwd', data: '/etc/passwd', symlink: true, store: true }]))
    expect(link.packages[0].problem).toMatch(/符号链接/)
    fs.writeFileSync(path.join(base, 'fake.zip'), '不是压缩包')
    expect(code(() => scanSkillSource(path.join(base, 'fake.zip')))).toBe('INVALID_SKILL')
    expect(code(() => scanSkillSource(writeZip('none.zip', [{ name: 'README.md', data: 'x' }])))).toBe('INVALID_SKILL')
  })
})

describe('写入技能库（SkillStore.importPackage）', () => {
  let projectDir: string
  let userDir: string
  let dataDir: string
  let changes: number
  const store = (withProject = true) =>
    new SkillStore({
      ...(withProject ? { projectDir, projectStateFile: path.join(dataDir, 'workspaces', 'abc', 'skills.json') } : {}),
      userDir,
      userStateFile: path.join(dataDir, 'user-skills.json'),
      trashDir: path.join(dataDir, 'trash'),
      onChange: () => changes++
    })

  beforeEach(() => {
    projectDir = path.join(base, 'ws', '.bridge', 'skills')
    userDir = path.join(base, 'user-skills')
    dataDir = path.join(base, 'data')
    fs.mkdirSync(path.join(base, 'ws'))
    changes = 0
  })

  it('项目级：文件原样复制，直接生效，来源是用户，AI 马上能加载', async () => {
    put(path.join(src, 'kit'), { 'SKILL.md': md('kit', '工具包', '# Kit'), 'data/blob.bin': Buffer.from([0, 255, 1]), 'scripts/run.sh': 'echo hi' })
    const [pkg] = scanSkillSource(path.join(src, 'kit')).packages
    const s = store()
    const r = await s.importPackage('project', pkg)
    expect(r.replaced).toBe(false)
    expect(r.skill).toMatchObject({ id: 'project:kit', status: 'enabled', origin: 'user', hasScripts: true, description: '工具包' })
    expect(r.skill.files).toEqual(['SKILL.md', 'data/blob.bin', 'scripts/run.sh'])
    expect([...fs.readFileSync(path.join(projectDir, 'kit', 'data', 'blob.bin'))]).toEqual([0, 255, 1])
    expect(changes).toBeGreaterThan(0)
    expect(s.available().map((a) => a.name)).toEqual(['kit'])
    expect(s.load('kit').content).toContain('# Kit')
  })

  it('用户级：没有工作区也能导入；项目级没有工作区时拒绝', async () => {
    put(path.join(src, 'kit'), { 'SKILL.md': md('kit', '工具包') })
    const [pkg] = scanSkillSource(path.join(src, 'kit')).packages
    const s = store(false)
    await expect(s.importPackage('project', pkg)).rejects.toThrow(/NO_WORKSPACE/)
    const r = await s.importPackage('user', pkg)
    expect(r.skill.id).toBe('user:kit')
    expect(fs.existsSync(path.join(userDir, 'kit', 'SKILL.md'))).toBe(true)
  })

  it('同名已存在：不覆盖时拒绝、原来的不动；覆盖时旧的进回收站，新的生效（之前停用的也恢复生效）', async () => {
    const s = store()
    s.save({ scope: 'project', name: 'kit', description: '旧的', body: '旧正文' })
    s.setEnabled('project:kit', false)
    put(path.join(src, 'kit'), { 'SKILL.md': md('kit', '新的', '新正文'), 'extra.md': 'x' })
    const [pkg] = scanSkillSource(path.join(src, 'kit')).packages

    await expect(s.importPackage('project', pkg)).rejects.toThrow(/SKILL_EXISTS/)
    expect(s.get('project:kit').content).toContain('旧正文')

    const r = await s.importPackage('project', pkg, { overwrite: true })
    expect(r.replaced).toBe(true)
    expect(r.skill).toMatchObject({ status: 'enabled', description: '新的' })
    expect(s.get('project:kit').content).toContain('新正文')
    const trash = fs.readdirSync(path.join(dataDir, 'trash'))
    expect(trash).toHaveLength(1)
    expect(fs.readFileSync(path.join(dataDir, 'trash', trash[0], 'kit', 'SKILL.md'), 'utf8')).toContain('旧正文')
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'trash', trash[0], 'manifest.json'), 'utf8'))).toMatchObject({ originalPath: '.bridge/skills/kit', skill: 'project:kit' })
  })

  it('从 zip 导入：内容一致；凭据类文件名也照样复制（这是用户自己导入的）', async () => {
    const file = writeZip('kit.zip', [
      { name: 'kit/SKILL.md', data: md('kit', '压缩包里的') },
      { name: 'kit/.env.example', data: 'KEY=' },
      { name: 'kit/assets/logo.bin', data: Buffer.from([9, 8, 7]), store: true }
    ])
    const [pkg] = scanSkillSource(file).packages
    const s = store()
    const r = await s.importPackage('project', pkg)
    expect(r.skill.files).toEqual(['.env.example', 'SKILL.md', 'assets/logo.bin'])
    expect([...fs.readFileSync(path.join(projectDir, 'kit', 'assets', 'logo.bin'))]).toEqual([9, 8, 7])
  })

  it('名字不合法、没有 SKILL.md、路径越界：拒绝，不留半成品', async () => {
    const s = store()
    const file = (rel: string, text = 'x') => ({ rel, read: () => Buffer.from(text) })
    await expect(s.importPackage('project', { name: 'Bad Name', files: [file('SKILL.md')] })).rejects.toThrow(/INVALID_SKILL/)
    await expect(s.importPackage('project', { name: 'ok', files: [file('README.md')] })).rejects.toThrow(/缺少 SKILL.md/)
    await expect(s.importPackage('project', { name: 'ok', files: [file('SKILL.md'), file('../evil.txt')] })).rejects.toThrow(/INVALID_PATH/)
    await expect(s.importPackage('project', { name: 'ok', files: [file('SKILL.md'), file('a'), file('a/b')] })).rejects.toThrow(/INVALID_PATH/)
    expect(s.list()).toEqual([])
    expect(fs.existsSync(path.join(base, 'evil.txt'))).toBe(false)
  })
})

describe('工作台的两步接口（Bridge）', () => {
  let bridge: Bridge
  let projA: string
  let projB: string
  let idB: string

  beforeEach(async () => {
    projA = path.join(base, 'proj-a')
    projB = path.join(base, 'proj-b')
    const home = path.join(base, 'home')
    for (const d of [projA, projB, home]) fs.mkdirSync(d, { recursive: true })
    bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoots: [projA, projB], machineRoot: home, port: 0, userSkillsDir: path.join(base, 'user-skills'), scheduler: { timers: false } })
    await bridge.start()
    const st = bridge.getState()
    idB = st.workspaces.find((w) => w.kind !== 'machine' && w.id !== st.activeWorkspaceId)!.id
  })

  afterEach(async () => {
    await bridge.stop()
  })

  function threeSkills(): void {
    put(path.join(src, 'alpha'), { 'SKILL.md': md('alpha', 'A'), 'ref.md': 'r' })
    put(path.join(src, 'beta'), { 'SKILL.md': md('beta', 'B') })
    put(path.join(src, '坏的'), { 'SKILL.md': md(undefined, '名字不行') })
  }

  it('预览不写东西；确认后导入到当前工作区，坏的那个记成失败，别的不受影响', async () => {
    threeSkills()
    const pre = bridge.previewSkillImport(src)
    expect(pre.kind).toBe('folder')
    expect(pre.source).toBe(src)
    expect(pre.items.map((i) => [i.name, i.files, !!i.problem])).toEqual([
      ['alpha', 2, false],
      ['beta', 1, false],
      ['坏的', 1, true]
    ])
    expect(bridge.listSkills()).toEqual([])

    const r = await bridge.applySkillImport(pre.importId, { scope: 'project' })
    expect(r.results.map((x) => [x.name, x.status, x.id])).toEqual([
      ['alpha', 'imported', 'project:alpha'],
      ['beta', 'imported', 'project:beta'],
      ['坏的', 'failed', undefined]
    ])
    expect(bridge.listSkills().map((s) => [s.id, s.status, s.origin])).toEqual([
      ['project:alpha', 'enabled', 'user'],
      ['project:beta', 'enabled', 'user']
    ])
    expect(fs.existsSync(path.join(projA, '.bridge', 'skills', 'alpha', 'ref.md'))).toBe(true)
  })

  it('只导入选中的；同名的不覆盖时是 exists，带 overwrite 再来一次变成 replaced', async () => {
    threeSkills()
    const pre = bridge.previewSkillImport(src)
    const first = await bridge.applySkillImport(pre.importId, { scope: 'project', keys: ['alpha'] })
    expect(first.results.map((x) => [x.name, x.status])).toEqual([['alpha', 'imported']])

    const second = await bridge.applySkillImport(pre.importId, { scope: 'project', keys: ['alpha', 'beta'] })
    expect(second.results.map((x) => [x.name, x.status])).toEqual([
      ['alpha', 'exists'],
      ['beta', 'imported']
    ])
    const third = await bridge.applySkillImport(pre.importId, { scope: 'project', keys: ['alpha'], overwrite: true })
    expect(third.results.map((x) => [x.name, x.status])).toEqual([['alpha', 'replaced']])

    // 预览之后来源里的技能被删了：记成失败，不是悄悄跳过
    fs.rmSync(path.join(src, 'beta'), { recursive: true })
    const fourth = await bridge.applySkillImport(pre.importId, { scope: 'user', keys: ['alpha', 'beta'] })
    expect(fourth.results.map((x) => [x.name, x.status])).toEqual([
      ['alpha', 'imported'],
      ['beta', 'failed']
    ])
    expect(fourth.results[1].problem).toMatch(/找不到/)
  })

  it('导入到别的工作区、整台电脑、用户级', async () => {
    threeSkills()
    const pre = bridge.previewSkillImport(src)
    await bridge.applySkillImport(pre.importId, { scope: 'project', keys: ['alpha'] }, idB)
    expect(fs.existsSync(path.join(projB, '.bridge', 'skills', 'alpha', 'SKILL.md'))).toBe(true)
    expect(bridge.listSkills()).toEqual([])
    expect(bridge.listSkills(idB).map((s) => s.id)).toEqual(['project:alpha'])

    await bridge.applySkillImport(pre.importId, { scope: 'project', keys: ['beta'] }, MACHINE_WORKSPACE_ID)
    expect(fs.existsSync(path.join(base, 'home', '.bridge', 'skills', 'beta', 'SKILL.md'))).toBe(true)

    await bridge.applySkillImport(pre.importId, { scope: 'user', keys: ['beta'] })
    expect(fs.existsSync(path.join(base, 'user-skills', 'beta', 'SKILL.md'))).toBe(true)
    // 用户级的在每个工作区都看得到
    expect(bridge.listSkills(idB).map((s) => s.id)).toEqual(['project:alpha', 'user:beta'])
  })

  it('导入后可以改范围：项目级 ↔ 用户级，别的工作区里的也行', async () => {
    threeSkills()
    const pre = bridge.previewSkillImport(src)
    await bridge.applySkillImport(pre.importId, { scope: 'project', keys: ['alpha'] })
    const moved = await bridge.changeSkillScope('project:alpha', 'user')
    expect(moved).toMatchObject({ id: 'user:alpha', status: 'enabled', origin: 'user' })
    expect(fs.existsSync(path.join(projA, '.bridge', 'skills', 'alpha'))).toBe(false)
    expect(fs.existsSync(path.join(base, 'user-skills', 'alpha', 'ref.md'))).toBe(true)

    // 改回项目级时指定别的工作区：进的是那个工作区
    const back = await bridge.changeSkillScope('user:alpha', 'project', idB)
    expect(back.id).toBe('project:alpha')
    expect(fs.existsSync(path.join(projB, '.bridge', 'skills', 'alpha', 'ref.md'))).toBe(true)
    expect(bridge.listSkills()).toEqual([])
    expect(bridge.listSkills(idB).map((s) => s.id)).toEqual(['project:alpha'])
  })

  it('指定别的项目：项目 A 的技能直接挪到项目 B、整台电脑；用户级挪进指定的项目；目标有同名的拒绝', async () => {
    threeSkills()
    const pre = bridge.previewSkillImport(src)
    await bridge.applySkillImport(pre.importId, { scope: 'project', keys: ['alpha', 'beta'] })

    // 当前工作区（A）→ B
    const toB = await bridge.changeSkillScope('project:alpha', 'project', undefined, idB)
    expect(toB).toMatchObject({ id: 'project:alpha', status: 'enabled' })
    expect(fs.existsSync(path.join(projA, '.bridge', 'skills', 'alpha'))).toBe(false)
    expect(fs.existsSync(path.join(projB, '.bridge', 'skills', 'alpha', 'ref.md'))).toBe(true)
    expect(bridge.listSkills().map((s) => s.id)).toEqual(['project:beta'])
    expect(bridge.listSkills(idB).map((s) => s.id)).toEqual(['project:alpha'])

    // B → 整台电脑（技能在 B 里，所以要说清它现在在哪个工作区）
    await bridge.changeSkillScope('project:alpha', 'project', idB, MACHINE_WORKSPACE_ID)
    expect(fs.existsSync(path.join(base, 'home', '.bridge', 'skills', 'alpha', 'SKILL.md'))).toBe(true)
    expect(bridge.listSkills(idB)).toEqual([])

    // 用户级 → 指定 B
    await bridge.changeSkillScope('project:beta', 'user')
    await bridge.changeSkillScope('user:beta', 'project', undefined, idB)
    expect(fs.existsSync(path.join(projB, '.bridge', 'skills', 'beta', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(base, 'user-skills', 'beta'))).toBe(false)

    // 目标有同名的：拒绝，原地不动
    await bridge.applySkillImport(pre.importId, { scope: 'project', keys: ['beta'] })
    await expect(bridge.changeSkillScope('project:beta', 'project', undefined, idB)).rejects.toThrow(/SKILL_EXISTS|已经有叫 beta/)
    expect(fs.existsSync(path.join(projA, '.bridge', 'skills', 'beta', 'SKILL.md'))).toBe(true)
    // 目标工作区不存在
    await expect(bridge.changeSkillScope('project:beta', 'project', undefined, 'w_nope')).rejects.toThrow(/工作区不存在/)
    expect(fs.existsSync(path.join(projA, '.bridge', 'skills', 'beta', 'SKILL.md'))).toBe(true)
  })

  it('zip 也走同一套；importId 不对、范围不对时报错', async () => {
    const file = writeZip('pack.zip', [{ name: 'gamma/SKILL.md', data: md('gamma', 'G') }])
    const pre = bridge.previewSkillImport(file)
    expect(pre.kind).toBe('zip')
    const r = await bridge.applySkillImport(pre.importId, { scope: 'project' })
    expect(r.results.map((x) => [x.name, x.status])).toEqual([['gamma', 'imported']])
    await expect(bridge.applySkillImport('nope', { scope: 'project' })).rejects.toThrow(/过期/)
    await expect(bridge.applySkillImport(pre.importId, { scope: 'everywhere' as 'user' })).rejects.toThrow(/范围/)
  })
})
