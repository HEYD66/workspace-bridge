// 技能库（SkillStore）单元测试：扫描、frontmatter、默认生效 / 手动停用、AI 侧读取和写入。
// 每个用例一个干净的临时目录：工作区、用户级技能目录、应用数据目录分开放，和 bridge.ts 的布局一致
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_INSTALL_BYTES,
  MAX_RESOURCE_BYTES,
  MAX_SKILL_FILES,
  SkillError,
  SkillStore,
  parseSkillMd,
  type SkillStoreOptions
} from '../src/core/skills'

let base: string
let projectDir: string
let userDir: string
let dataDir: string
let outside: string
let changes: number

/** 这台机器能不能建 junction（受限环境下可能没权限），不能就跳过链接相关用例 */
const canJunction = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-link-'))
  try {
    fs.mkdirSync(path.join(d, 't'))
    fs.symlinkSync(path.join(d, 't'), path.join(d, 'l'), 'junction')
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(d, { recursive: true, force: true })
  }
})()

function opts(withProject = true): SkillStoreOptions {
  return {
    ...(withProject ? { projectDir, projectStateFile: path.join(dataDir, 'workspaces', 'abc', 'skills.json') } : {}),
    userDir,
    userStateFile: path.join(dataDir, 'user-skills.json'),
    trashDir: path.join(dataDir, 'trash'),
    onChange: () => changes++
  }
}

const store = (withProject = true) => new SkillStore(opts(withProject))

/** 在技能根目录下写一个技能的文件 */
function put(root: string, name: string, files: Record<string, string | Buffer>): string {
  const dir = path.join(root, name)
  for (const [rel, data] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, data)
  }
  return dir
}

const md = (description: string, body = '正文') => `---\nname: x\ndescription: ${description}\n---\n\n${body}\n`

/** 成功返回 OK，SkillError 返回错误码 */
function code(fn: () => unknown): string {
  try {
    fn()
    return 'OK'
  } catch (e) {
    return e instanceof SkillError ? e.code : `非 SkillError：${String(e)}`
  }
}

const info = (s: SkillStore, id: string) => s.list().find((x) => x.id === id)!

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-skills-'))
  projectDir = path.join(base, 'ws', '.bridge', 'skills')
  userDir = path.join(base, 'user-skills')
  dataDir = path.join(base, 'data')
  outside = path.join(base, 'outside')
  fs.mkdirSync(path.join(base, 'ws'))
  fs.mkdirSync(outside)
  changes = 0
})

afterEach(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }))

describe('frontmatter 解析', () => {
  it('兼容 BOM、CRLF 和双引号', () => {
    const r = parseSkillMd('\uFEFF---\r\nname: pdf\r\ndescription: "处理: PDF \\"表单\\""\r\n---\r\n\r\n# 标题\r\n正文\r\n')
    expect(r.meta.name).toBe('pdf')
    expect(r.description).toBe('处理: PDF "表单"')
    expect(r.body).toContain('# 标题')
  })

  it('单引号和不加引号的带冒号值', () => {
    expect(parseSkillMd("---\ndescription: 'It''s fine'\n---\n").description).toBe("It's fine")
    expect(parseSkillMd('---\ndescription: 用法: 先读 README\n---\n').description).toBe('用法: 先读 README')
  })

  it('没有 description 时取正文第一行非标题文字，截到 200 字', () => {
    expect(parseSkillMd('---\nname: a\n---\n\n# 标题\n\n第一段文字\n第二行\n').description).toBe('第一段文字')
    expect(parseSkillMd('# 只有标题\n\n没有 frontmatter 的正文').description).toBe('没有 frontmatter 的正文')
    const long = '字'.repeat(300)
    expect(parseSkillMd(`---\nname: a\n---\n${long}`).description).toBe('字'.repeat(200))
  })

  it('扫描时从 SKILL.md 文件读出 description', () => {
    put(projectDir, 'crlf', { 'SKILL.md': '\uFEFF---\r\nname: crlf\r\ndescription: Windows 记事本保存的\r\n---\r\n' })
    expect(info(store(), 'project:crlf').description).toBe('Windows 记事本保存的')
  })
})

describe('扫描', () => {
  it('目录不存在时没有技能，也不创建目录', () => {
    expect(store().list()).toEqual([])
    expect(fs.existsSync(projectDir)).toBe(false)
    expect(fs.existsSync(userDir)).toBe(false)
  })

  it('一级子目录是技能：文件清单排序、scripts、默认状态', () => {
    put(projectDir, 'demo', { 'SKILL.md': md('演示'), 'scripts/run.py': 'print(1)', 'ref/b.md': 'b', 'a.md': 'a' })
    put(userDir, 'mine', { 'SKILL.md': md('用户级') })
    fs.writeFileSync(path.join(projectDir, 'loose.txt'), '根目录下的文件不是技能')
    const list = store().list()
    expect(list.map((x) => x.id)).toEqual(['project:demo', 'user:mine'])
    const demo = list[0]
    expect(demo.files).toEqual(['SKILL.md', 'a.md', 'ref/b.md', 'scripts/run.py'])
    expect(demo.hasScripts).toBe(true)
    // 放进目录就是生效的，不用审阅
    expect(demo.status).toBe('enabled')
    expect(demo.origin).toBe('found')
    expect(demo.usage).toEqual({ loads: 0, reads: 0 })
    expect(list[1].hasScripts).toBe(false)
  })

  it('没有工作区时只有用户级技能', () => {
    put(projectDir, 'p', { 'SKILL.md': md('项目级') })
    put(userDir, 'u', { 'SKILL.md': md('用户级') })
    expect(store(false).list().map((x) => x.id)).toEqual(['user:u'])
  })
})

describe('默认生效与手动停用', () => {
  beforeEach(() => {
    put(projectDir, 'demo', {
      'SKILL.md': md('演示'),
      'ref.md': '第一版\n',
      'gone.md': '会被删掉\n',
      'img.bin': Buffer.from([1, 0, 2, 3]),
      'big.txt': 'a'.repeat(300 * 1024)
    })
  })

  it('放进目录就生效：AI 直接能看到、能加载；不留快照、不写状态', () => {
    const s = store()
    expect(info(s, 'project:demo').status).toBe('enabled')
    expect(s.available()).toEqual([
      { name: 'demo', description: '演示', scope: 'project', resources: ['big.txt', 'gone.md', 'img.bin', 'ref.md'], hasScripts: false }
    ])
    expect(changes).toBe(0)
    expect(fs.existsSync(path.join(dataDir, 'skill-pins'))).toBe(false)
    expect(s.load('demo').content).toContain('正文')
  })

  it('改、加、删文件：照样生效，AI 读到的是磁盘上现在的内容', () => {
    const s = store()
    expect(s.readResource('demo', 'ref.md').content).toBe('第一版\n')
    fs.writeFileSync(path.join(projectDir, 'demo', 'ref.md'), '第二版\n')
    fs.writeFileSync(path.join(projectDir, 'demo', 'new.md'), '新加的\n')
    fs.rmSync(path.join(projectDir, 'demo', 'gone.md'))
    const r = info(s, 'project:demo')
    expect(r.status).toBe('enabled')
    expect(r).not.toHaveProperty('changedFiles')
    expect(r.files).toEqual(['SKILL.md', 'big.txt', 'img.bin', 'new.md', 'ref.md'])
    expect(s.available().map((x) => x.name)).toEqual(['demo'])
    expect(s.readResource('demo', 'ref.md').content).toBe('第二版\n')
    expect(s.readResource('demo', 'new.md').content).toBe('新加的\n')
    expect(code(() => s.readResource('demo', 'gone.md'))).toBe('RESOURCE_NOT_FOUND')
  })

  it('停用后是 disabled，AI 看不到也加载不了；之后改文件还是 disabled；重新启用恢复', () => {
    const s = store()
    const r = s.setEnabled('project:demo', false)
    expect(r.status).toBe('disabled')
    expect(r.enabledAt).toBeUndefined()
    expect(changes).toBeGreaterThan(0)
    expect(s.available()).toEqual([])
    expect(code(() => s.load('demo'))).toBe('SKILL_NOT_ENABLED')
    expect(code(() => s.readResource('demo', 'ref.md'))).toBe('SKILL_NOT_ENABLED')
    fs.writeFileSync(path.join(projectDir, 'demo', 'ref.md'), '停用后改的\n')
    expect(info(s, 'project:demo').status).toBe('disabled')

    const on = s.setEnabled('project:demo', true)
    expect(on.status).toBe('enabled')
    expect(on.enabledAt).toBeGreaterThan(0)
    expect(s.readResource('demo', 'ref.md').content).toBe('停用后改的\n')
  })

  it('旧数据：升级前「待审阅」「已改动」的技能读进来都是生效的，只有用户手动停用过的还是停用', () => {
    put(projectDir, 'pending', { 'SKILL.md': md('AI 提交、没审阅过') })
    put(projectDir, 'changed', { 'SKILL.md': md('启用后被改过') })
    put(projectDir, 'off', { 'SKILL.md': md('用户停用的') })
    const file = path.join(dataDir, 'workspaces', 'abc', 'skills.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify({
        skills: {
          pending: { enabled: false, origin: 'agent', installedBy: 'Alice' },
          changed: { enabled: true, reviewed: true, origin: 'found', enabledAt: 1, hashes: { 'SKILL.md': 'deadbeef' } },
          off: { enabled: false, reviewed: true, origin: 'found' }
        }
      })
    )
    const s = store()
    expect(info(s, 'project:pending')).toMatchObject({ status: 'enabled', origin: 'agent', installedBy: 'Alice' })
    expect(info(s, 'project:changed').status).toBe('enabled')
    expect(info(s, 'project:off').status).toBe('disabled')
    expect(s.available().map((x) => x.name)).toEqual(['changed', 'demo', 'pending'])
    expect(s.load('pending').content).toContain('正文')
  })
})
describe('invalid', () => {
  it('缺 SKILL.md、名字不合法 → invalid，AI 看不到，加载报 INVALID_SKILL', () => {
    put(projectDir, 'nomd', { 'README.md': '没有 SKILL.md' })
    put(projectDir, 'Bad_Name', { 'SKILL.md': md('名字有大写') })
    const s = store()
    const nomd = info(s, 'project:nomd')
    expect(nomd.status).toBe('invalid')
    expect(nomd.problem).toContain('SKILL.md')
    const bad = info(s, 'project:Bad_Name')
    expect(bad.status).toBe('invalid')
    expect(bad.problem).toContain('名字')
    expect(code(() => s.setEnabled('project:nomd', true))).toBe('INVALID_SKILL')
    expect(code(() => s.setEnabled('project:Bad_Name', true))).toBe('INVALID_SKILL')
    expect(code(() => s.load('nomd'))).toBe('INVALID_SKILL')
    expect(s.available()).toEqual([])
  })

  it(`文件超过 ${MAX_SKILL_FILES} 个 → invalid`, () => {
    const files: Record<string, string> = { 'SKILL.md': md('文件太多') }
    for (let i = 0; i < MAX_SKILL_FILES; i++) files[`f/${i}.txt`] = ''
    put(projectDir, 'many', files)
    const r = info(store(), 'project:many')
    expect(r.status).toBe('invalid')
    expect(r.problem).toContain(String(MAX_SKILL_FILES))
  })

  it.skipIf(!canJunction)('技能目录里有 junction → invalid', () => {
    const dir = put(projectDir, 'linked', { 'SKILL.md': md('里面有链接') })
    fs.writeFileSync(path.join(outside, 'secret.txt'), '工作区外的文件')
    fs.symlinkSync(outside, path.join(dir, 'escape'), 'junction')
    const s = store()
    const r = info(s, 'project:linked')
    expect(r.status).toBe('invalid')
    expect(r.problem).toContain('escape')
    expect(code(() => s.setEnabled('project:linked', true))).toBe('INVALID_SKILL')
  })

  it.skipIf(!canJunction)('原来好好的、之后被换进 junction → invalid，AI 读不到', () => {
    const dir = put(projectDir, 'later', { 'SKILL.md': md('后来加了链接'), 'ref.md': 'ok' })
    const s = store()
    expect(s.load('later').content).toContain('正文')
    fs.symlinkSync(outside, path.join(dir, 'escape'), 'junction')
    expect(info(s, 'project:later').status).toBe('invalid')
    expect(code(() => s.load('later'))).toBe('INVALID_SKILL')
    expect(code(() => s.readResource('later', 'ref.md'))).toBe('INVALID_SKILL')
  })

  it.skipIf(!canJunction)('技能目录本身是 junction → invalid', () => {
    put(outside, 'real', { 'SKILL.md': md('真身在工作区外') })
    fs.mkdirSync(projectDir, { recursive: true })
    fs.symlinkSync(path.join(outside, 'real'), path.join(projectDir, 'alias'), 'junction')
    const s = store()
    const r = info(s, 'project:alias')
    expect(r.status).toBe('invalid')
    expect(r.files).toEqual([])
    expect(code(() => s.setEnabled('project:alias', true))).toBe('INVALID_SKILL')
  })

  it.skipIf(!canJunction)('.bridge 是 junction 时项目级技能一律不读，也不往里写', () => {
    put(path.join(outside, 'skills'), 'evil', { 'SKILL.md': md('指到工作区外') })
    fs.symlinkSync(outside, path.join(base, 'ws', '.bridge'), 'junction')
    const s = store()
    expect(s.list()).toEqual([])
    expect(code(() => s.load('evil'))).toBe('SKILL_NOT_FOUND')
    expect(code(() => s.install({ name: 'new-one', description: 'x', body: 'y' }, { id: 'a1', name: 'Alice' }))).toBe('INVALID_PATH')
    expect(code(() => s.save({ scope: 'project', name: 'new-two', description: 'x', body: 'y' }))).toBe('INVALID_PATH')
    expect(fs.existsSync(path.join(outside, 'skills', 'new-one'))).toBe(false)
    expect(fs.existsSync(path.join(outside, 'skills', 'new-two'))).toBe(false)
  })
})

describe('同名遮住', () => {
  it('用户级和项目级同名时用户级被遮住，AI 看不到，也不回退', () => {
    put(projectDir, 'dup', { 'SKILL.md': md('项目级版本') })
    put(userDir, 'dup', { 'SKILL.md': md('用户级版本') })
    put(userDir, 'solo', { 'SKILL.md': md('只有用户级') })
    const s = store()
    expect(info(s, 'user:dup').shadowed).toBe(true)
    expect(info(s, 'user:dup').status).toBe('enabled')
    expect(info(s, 'project:dup').shadowed).toBeUndefined()
    expect(info(s, 'user:solo').shadowed).toBeUndefined()
    expect(s.available().map((x) => `${x.scope}:${x.name}`)).toEqual(['project:dup', 'user:solo'])
    expect(s.load('dup').content).toContain('项目级版本')
    expect(s.load('solo').skill.scope).toBe('user')

    // 项目级那个被停用：AI 拿不到任何一个 dup，不回退到被遮住的用户级
    s.setEnabled('project:dup', false)
    expect(s.available().map((x) => `${x.scope}:${x.name}`)).toEqual(['user:solo'])
    expect(code(() => s.load('dup'))).toBe('SKILL_NOT_ENABLED')
  })
})

describe('AI 读取', () => {
  beforeEach(() => {
    put(projectDir, 'kit', {
      'SKILL.md': md('工具箱', '读 ref/guide.md'),
      'ref/guide.md': '指南\n',
      '.env': 'TOKEN=secret',
      'id_rsa': 'key',
      'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]),
      'huge.md': 'x'.repeat(MAX_RESOURCE_BYTES + 1000)
    })
  })

  it('load 的错误码', () => {
    const s = store()
    expect(code(() => s.load('nope'))).toBe('SKILL_NOT_FOUND')
    expect(code(() => s.load(''))).toBe('SKILL_NOT_FOUND')
    expect(code(() => s.load('../kit'))).toBe('SKILL_NOT_FOUND')
    const r = s.load('kit')
    expect(r.content).toBe(md('工具箱', '读 ref/guide.md'))
    expect(r.skill.resources).toEqual(['huge.md', 'logo.png', 'ref/guide.md'])
  })

  it('readResource 规范路径，越界、冒号、凭据文件名拒绝', () => {
    const s = store()
    for (const p of ['ref/guide.md', './ref/guide.md', '/ref/guide.md', 'ref\\guide.md', 'ref/./guide.md']) {
      expect(s.readResource('kit', p)).toEqual({ path: 'ref/guide.md', content: '指南\n', size: 7, binary: false, truncated: false })
    }
    for (const p of ['../kit/SKILL.md', 'ref/../../x', '..\\x', 'C:/Windows/win.ini', 'C:\\x', 'ref.md:secret', 'a\0b', '.env', 'id_rsa', 'ref/.env', '']) {
      expect(code(() => s.readResource('kit', p)), p).toBe('INVALID_PATH')
    }
    expect(code(() => s.readResource('kit', 'ref/missing.md'))).toBe('RESOURCE_NOT_FOUND')
    expect(code(() => s.readResource('kit', 'ref'))).toBe('RESOURCE_NOT_FOUND')
    expect(code(() => s.readResource('nope', 'x.md'))).toBe('SKILL_NOT_FOUND')
  })

  it('后来加进目录的文件马上能读', () => {
    const s = store()
    expect(code(() => s.readResource('kit', 'later.md'))).toBe('RESOURCE_NOT_FOUND')
    fs.writeFileSync(path.join(projectDir, 'kit', 'later.md'), '后加的')
    expect(s.readResource('kit', 'later.md').content).toBe('后加的')
  })

  it('二进制只给大小，超长文本截断', () => {
    const s = store()
    expect(s.readResource('kit', 'logo.png')).toEqual({ path: 'logo.png', size: 8, binary: true, truncated: false })
    const big = s.readResource('kit', 'huge.md')
    expect(big.truncated).toBe(true)
    expect(big.size).toBe(MAX_RESOURCE_BYTES + 1000)
    expect(big.content!.length).toBe(MAX_RESOURCE_BYTES)
  })

  it('记录使用次数（直接放进目录、没有状态记录的技能也记）', () => {
    const s = store()
    const before = changes
    s.load('kit')
    s.load('kit')
    s.readResource('kit', 'ref/guide.md')
    const u = info(s, 'project:kit').usage
    expect(u.loads).toBe(2)
    expect(u.reads).toBe(1)
    expect(u.lastUsedAt).toBeGreaterThan(0)
    expect(changes).toBe(before + 3)
    // 失败的调用不计数
    expect(code(() => s.readResource('kit', 'nope.md'))).toBe('RESOURCE_NOT_FOUND')
    expect(info(s, 'project:kit').usage.reads).toBe(1)
  })
})

describe('install', () => {
  const by = { id: 'a1', name: 'Alice' }

  it('写进项目级，直接生效：AI 马上能列出、加载；用户可以停用', () => {
    const s = store()
    const r = s.install({ name: 'gen', description: '生成: 报告', body: '# 生成\n步骤', files: [{ path: 'ref/a.md', content: 'A' }] }, by)
    expect(r).toMatchObject({ id: 'project:gen', status: 'enabled', origin: 'agent', installedBy: 'Alice', files: ['SKILL.md', 'ref/a.md'] })
    expect(r.enabledAt).toBeGreaterThan(0)
    expect(r.description).toBe('生成: 报告')
    expect(changes).toBeGreaterThan(0)
    expect(fs.readFileSync(path.join(projectDir, 'gen', 'SKILL.md'), 'utf8')).toBe('---\nname: gen\ndescription: "生成: 报告"\n---\n\n# 生成\n步骤')
    expect(s.available().map((x) => x.name)).toEqual(['gen'])
    expect(s.load('gen').content).toContain('步骤')
    expect(s.readResource('gen', 'ref/a.md').content).toBe('A')
    // 用户停用后 AI 用不了，来源不变
    expect(s.setEnabled('project:gen', false)).toMatchObject({ status: 'disabled', origin: 'agent', installedBy: 'Alice' })
    expect(code(() => s.load('gen'))).toBe('SKILL_NOT_ENABLED')
  })

  it('同名、名字不合法、路径不合法、超限、没有工作区都被拒，不留半成品', () => {
    const s = store()
    put(projectDir, 'taken', { 'SKILL.md': md('已有') })
    const ok = { name: 'fine', description: 'd', body: 'b' }
    expect(code(() => s.install({ ...ok, name: 'taken' }, by))).toBe('SKILL_EXISTS')
    expect(code(() => s.install({ ...ok, name: 'Bad Name' }, by))).toBe('INVALID_SKILL')
    expect(code(() => s.install({ ...ok, name: '../up' }, by))).toBe('INVALID_SKILL')
    expect(code(() => s.install({ ...ok, description: '  ' }, by))).toBe('INVALID_SKILL')
    expect(code(() => s.install({ ...ok, files: [{ path: 'SKILL.md', content: 'x' }] }, by))).toBe('INVALID_PATH')
    expect(code(() => s.install({ ...ok, files: [{ path: 'skill.md', content: 'x' }] }, by))).toBe('INVALID_PATH')
    expect(code(() => s.install({ ...ok, files: [{ path: '../evil.md', content: 'x' }] }, by))).toBe('INVALID_PATH')
    expect(code(() => s.install({ ...ok, files: [{ path: '.env', content: 'x' }] }, by))).toBe('INVALID_PATH')
    expect(code(() => s.install({ ...ok, files: [{ path: 'C:/x.md', content: 'x' }] }, by))).toBe('INVALID_PATH')
    const many = Array.from({ length: 51 }, (_, i) => ({ path: `f${i}.md`, content: '' }))
    expect(code(() => s.install({ ...ok, files: many }, by))).toBe('TOO_LARGE')
    expect(code(() => s.install({ ...ok, body: 'x'.repeat(MAX_INSTALL_BYTES) }, by))).toBe('TOO_LARGE')
    expect(code(() => s.install({ ...ok, files: [{ path: 'a.md', content: 'x'.repeat(MAX_INSTALL_BYTES) }] }, by))).toBe('TOO_LARGE')
    expect(fs.readdirSync(projectDir)).toEqual(['taken'])
    expect(fs.existsSync(path.join(projectDir, '..', 'evil.md'))).toBe(false)
    expect(code(() => store(false).install(ok, by))).toBe('NO_WORKSPACE')
  })
})

describe('save（工作台编辑）', () => {
  it('新建直接启用，origin=user，description 带冒号和引号也能读回', () => {
    const s = store()
    const desc = '用法: 先读 "README" #1'
    const r = s.save({ scope: 'user', name: 'note', description: `${desc}\n第二行`, body: '正文' })
    expect(r).toMatchObject({ id: 'user:note', status: 'enabled', origin: 'user', description: `${desc} 第二行` })
    expect(fs.readFileSync(path.join(userDir, 'note', 'SKILL.md'), 'utf8')).toBe(`---\nname: note\ndescription: ${JSON.stringify(`${desc} 第二行`)}\n---\n\n正文`)
    expect(s.available().map((x) => x.name)).toEqual(['note'])
    // 普通描述不加引号
    s.save({ scope: 'project', name: 'plain', description: '普通描述', body: '' })
    expect(fs.readFileSync(path.join(projectDir, 'plain', 'SKILL.md'), 'utf8')).toBe('---\nname: plain\ndescription: 普通描述\n---\n\n')
  })

  it('改已有的技能：内容换成新的，启用 / 停用状态不变；别人再改也照样生效', () => {
    const s = store()
    s.save({ scope: 'project', name: 'doc', description: 'v1', body: '第一版' })
    const r = s.save({ scope: 'project', name: 'doc', description: 'v2', body: '第二版' })
    expect(r.status).toBe('enabled')
    expect(r.description).toBe('v2')
    expect(s.load('doc').content).toContain('第二版')
    fs.appendFileSync(path.join(projectDir, 'doc', 'SKILL.md'), '\nAI 加的一行')
    expect(info(s, 'project:doc').status).toBe('enabled')
    expect(s.load('doc').content).toContain('AI 加的一行')

    put(projectDir, 'found', { 'SKILL.md': md('外部放进来的') })
    expect(s.save({ scope: 'project', name: 'found', description: '用户改过', body: 'x' }).status).toBe('enabled')
    s.setEnabled('project:found', false)
    expect(s.save({ scope: 'project', name: 'found', description: '又改', body: 'y' }).status).toBe('disabled')
  })

  it('参数校验', () => {
    const s = store()
    expect(code(() => s.save({ scope: 'user', name: 'Bad', description: 'd', body: '' }))).toBe('INVALID_SKILL')
    expect(code(() => s.save({ scope: 'user', name: 'ok', description: ' \n ', body: '' }))).toBe('INVALID_SKILL')
    expect(code(() => store(false).save({ scope: 'project', name: 'ok', description: 'd', body: '' }))).toBe('NO_WORKSPACE')
    expect(s.save({ scope: 'user', name: 'long', description: 'x'.repeat(2000), body: '' }).description).toHaveLength(1024)
  })
})

describe('remove', () => {
  it('整个目录进回收站，状态清掉', async () => {
    const s = store()
    s.save({ scope: 'project', name: 'old', description: '要删的', body: 'x' })
    put(projectDir, 'old', { 'ref/a.md': 'A' })
    await s.remove('project:old')
    expect(fs.existsSync(path.join(projectDir, 'old'))).toBe(false)
    const trash = path.join(dataDir, 'trash')
    const [holder] = fs.readdirSync(trash)
    expect(fs.readFileSync(path.join(trash, holder, 'old', 'ref', 'a.md'), 'utf8')).toBe('A')
    expect(JSON.parse(fs.readFileSync(path.join(trash, holder, 'manifest.json'), 'utf8'))).toMatchObject({ originalPath: '.bridge/skills/old', skill: 'project:old' })
    expect(s.list()).toEqual([])
    // 同名再放进来是全新的技能
    put(projectDir, 'old', { 'SKILL.md': md('重新放进来') })
    expect(info(s, 'project:old')).toMatchObject({ status: 'enabled', origin: 'found', usage: { loads: 0, reads: 0 } })
    await expect(s.remove('project:nope')).rejects.toThrow(/SKILL_NOT_FOUND/)
  })
})

describe('get 和 id', () => {
  it('返回 SKILL.md 全文和绝对路径；找不到抛 SKILL_NOT_FOUND', () => {
    put(userDir, 'g', { 'SKILL.md': md('详情') })
    const s = store()
    const d = s.get('user:g')
    expect(d.content).toBe(md('详情'))
    expect(d.dir).toBe(path.join(userDir, 'g'))
    expect(path.isAbsolute(d.dir)).toBe(true)
    for (const id of ['user:none', 'project:g', 'g', 'other:g', 'user:../g', '']) {
      expect(code(() => s.get(id)), id).toBe('SKILL_NOT_FOUND')
    }
    expect(code(() => s.setEnabled('user:none', true))).toBe('SKILL_NOT_FOUND')
  })
})

describe('持久化', () => {
  it('新建 SkillStore 实例后状态、使用次数都在', () => {
    put(projectDir, 'keep', { 'SKILL.md': md('持久'), 'ref.md': '原文\n' })
    put(projectDir, 'off', { 'SKILL.md': md('停用的') })
    const s1 = store()
    s1.load('keep')
    s1.setEnabled('project:off', false)
    s1.install({ name: 'agent-made', description: 'AI 写的', body: 'x' }, { id: 'a1', name: 'Bob' })

    const s2 = store()
    expect(info(s2, 'project:keep')).toMatchObject({ status: 'enabled', usage: { loads: 1, reads: 0 } })
    expect(info(s2, 'project:off').status).toBe('disabled')
    expect(info(s2, 'project:agent-made')).toMatchObject({ status: 'enabled', origin: 'agent', installedBy: 'Bob' })
  })
})

describe('改范围（项目级 ↔ 用户级）', () => {
  /** SkillError 的错误码（异步版） */
  async function acode(p: Promise<unknown>): Promise<string> {
    try {
      await p
      return 'OK'
    } catch (e) {
      return e instanceof SkillError ? e.code : `非 SkillError：${String(e)}`
    }
  }

  it('项目级改成用户级：整个目录移过去，id 变了，文件、停用状态、来源、使用次数都跟着走', async () => {
    const s = store()
    s.install({ name: 'mover', description: 'AI 写的', body: '正文', files: [{ path: 'scripts/run.sh', content: 'echo hi' }] }, { id: 'a1', name: 'Bob' })
    s.load('mover')
    s.setEnabled('project:mover', false)
    const before = changes

    const r = await s.changeScope('project:mover', 'user')
    expect(r).toMatchObject({ id: 'user:mover', scope: 'user', status: 'disabled', origin: 'agent', installedBy: 'Bob', hasScripts: true, usage: { loads: 1 } })
    expect(fs.existsSync(path.join(projectDir, 'mover'))).toBe(false)
    expect(fs.readFileSync(path.join(userDir, 'mover', 'scripts', 'run.sh'), 'utf8')).toBe('echo hi')
    expect(s.list().map((x) => x.id)).toEqual(['user:mover'])
    expect(changes).toBeGreaterThan(before)
    // 原来那个范围的状态记录清掉了：之后再建同名的项目技能是全新的
    s.save({ scope: 'project', name: 'mover', description: '新的', body: 'x' })
    expect(info(s, 'project:mover')).toMatchObject({ status: 'enabled', origin: 'user', usage: { loads: 0 } })
    // 换一个实例读，状态还在
    expect(info(store(), 'user:mover')).toMatchObject({ status: 'disabled', origin: 'agent' })
  })

  it('用户级改成项目级：生效中的继续生效，AI 照样能加载；直接放进目录的（没有状态记录）也能挪', async () => {
    put(userDir, 'found-one', { 'SKILL.md': md('直接放进来的', '# 内容'), 'ref.md': 'r' })
    const s = store()
    const r = await s.changeScope('user:found-one', 'project')
    expect(r).toMatchObject({ id: 'project:found-one', status: 'enabled', origin: 'found' })
    expect(fs.existsSync(path.join(userDir, 'found-one'))).toBe(false)
    expect(fs.existsSync(path.join(projectDir, 'found-one', 'ref.md'))).toBe(true)
    expect(s.load('found-one').content).toContain('# 内容')
    // 改成它本来的范围：什么都不动
    expect((await s.changeScope('project:found-one', 'project')).id).toBe('project:found-one')
  })

  it('目标范围里有同名的（大小写不同也算）：拒绝，两边都不动', async () => {
    put(projectDir, 'same', { 'SKILL.md': md('项目的') })
    put(userDir, 'same', { 'SKILL.md': md('用户的') })
    put(projectDir, 'other', { 'SKILL.md': md('另一个') })
    put(userDir, 'OTHER', { 'SKILL.md': md('大小写不同') })
    const s = store()
    expect(await acode(s.changeScope('project:same', 'user'))).toBe('SKILL_EXISTS')
    expect(await acode(s.changeScope('user:same', 'project'))).toBe('SKILL_EXISTS')
    expect(await acode(s.changeScope('project:other', 'user'))).toBe('SKILL_EXISTS')
    expect(fs.readFileSync(path.join(projectDir, 'same', 'SKILL.md'), 'utf8')).toBe(md('项目的'))
    expect(fs.readFileSync(path.join(userDir, 'same', 'SKILL.md'), 'utf8')).toBe(md('用户的'))
    expect(fs.existsSync(path.join(projectDir, 'other', 'SKILL.md'))).toBe(true)
  })

  it('没有工作区不能改成项目级；不存在的、范围写错的、名字不合法的都拒绝', async () => {
    put(userDir, 'u', { 'SKILL.md': md('用户的') })
    put(projectDir, 'Bad_Name', { 'SKILL.md': md('名字不合法') })
    expect(await acode(store(false).changeScope('user:u', 'project'))).toBe('NO_WORKSPACE')
    const s = store()
    expect(await acode(s.changeScope('user:none', 'project'))).toBe('SKILL_NOT_FOUND')
    expect(await acode(s.changeScope('user:../u', 'project'))).toBe('SKILL_NOT_FOUND')
    expect(await acode(s.changeScope('user:u', 'everywhere' as 'user'))).toBe('INVALID_SKILL')
    expect(await acode(s.changeScope('project:Bad_Name', 'user'))).toBe('INVALID_SKILL')
    expect(fs.existsSync(path.join(userDir, 'u', 'SKILL.md'))).toBe(true)
  })

  it('挪到另一个工作区的项目级：目录、状态跟过去；那边有同名的拒绝；挪到自己所在的工作区什么都不动', async () => {
    const otherDir = path.join(base, 'ws2', '.bridge', 'skills')
    fs.mkdirSync(path.join(base, 'ws2'))
    const a = store()
    const b = new SkillStore({ ...opts(), projectDir: otherDir, projectStateFile: path.join(dataDir, 'workspaces', 'def', 'skills.json') })
    a.install({ name: 'hop', description: 'AI 写的', body: '正文', files: [{ path: 'ref.md', content: 'r' }] }, { id: 'a1', name: 'Bob' })
    a.load('hop')
    put(projectDir, 'busy', { 'SKILL.md': md('A 里的') })
    put(otherDir, 'busy', { 'SKILL.md': md('B 里的') })
    put(userDir, 'shared', { 'SKILL.md': md('用户级的') })

    // 项目 A → 项目 B
    const r = await a.changeScope('project:hop', 'project', b)
    expect(r).toMatchObject({ id: 'project:hop', scope: 'project', status: 'enabled', origin: 'agent', installedBy: 'Bob', usage: { loads: 1 } })
    expect(fs.existsSync(path.join(projectDir, 'hop'))).toBe(false)
    expect(fs.readFileSync(path.join(otherDir, 'hop', 'ref.md'), 'utf8')).toBe('r')
    expect(a.list().some((x) => x.name === 'hop')).toBe(false)
    expect(info(b, 'project:hop')).toMatchObject({ origin: 'agent', usage: { loads: 1 } })
    expect(b.load('hop').content).toContain('正文')

    // 那边有同名的：拒绝，两边都不动
    expect(await acode(a.changeScope('project:busy', 'project', b))).toBe('SKILL_EXISTS')
    expect(fs.readFileSync(path.join(projectDir, 'busy', 'SKILL.md'), 'utf8')).toBe(md('A 里的'))
    expect(fs.readFileSync(path.join(otherDir, 'busy', 'SKILL.md'), 'utf8')).toBe(md('B 里的'))

    // 用户级 → 指定工作区的项目级：进的是 B，不是 A
    const u = await a.changeScope('user:shared', 'project', b)
    expect(u.id).toBe('project:shared')
    expect(fs.existsSync(path.join(otherDir, 'shared', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(projectDir, 'shared'))).toBe(false)

    // 目标就是它现在所在的工作区（换一个指向同一目录的实例也算）：什么都不动
    expect((await b.changeScope('project:hop', 'project', new SkillStore({ ...opts(), projectDir: otherDir, projectStateFile: path.join(dataDir, 'workspaces', 'def', 'skills.json') }))).id).toBe('project:hop')
    expect(fs.existsSync(path.join(otherDir, 'hop', 'ref.md'))).toBe(true)
    // 目标工作区的技能库没有项目级目录：拒绝
    expect(await acode(b.changeScope('project:hop', 'project', store(false)))).toBe('NO_WORKSPACE')
  })

  it.skipIf(!canJunction)('技能目录是 junction：不跟着挪', async () => {
    put(outside, 'real', { 'SKILL.md': md('在外面') })
    fs.mkdirSync(projectDir, { recursive: true })
    fs.symlinkSync(path.join(outside, 'real'), path.join(projectDir, 'linked'), 'junction')
    const s = store()
    expect(await acode(s.changeScope('project:linked', 'user'))).toBe('INVALID_SKILL')
    expect(fs.existsSync(path.join(outside, 'real', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(userDir, 'linked'))).toBe(false)
  })
})
