// 优化第 7 条：文件占用登记（T-16）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileClaimStore, globToRegExp, formatClaimWarning, type ClaimHolder } from '../src/core/fileClaims'
import { ToolError } from '../src/core/fileTools'

const A: ClaimHolder = { agentId: 'a_a', agentName: 'Alice', session: 's_a' }
const B: ClaimHolder = { agentId: 'a_b', agentName: 'Bob', session: 's_b' }
const MIN = 60_000

let base: string
let root: string
let file: string
let clock: number
const now = () => clock

function make(opts: Partial<ConstructorParameters<typeof FileClaimStore>[1]> = {}): FileClaimStore {
  return new FileClaimStore(file, { root, caseInsensitive: true, now, ...opts })
}

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof ToolError) return e.code
    throw e
  }
  throw new Error('没有抛错')
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-claims-'))
  root = path.join(base, 'ws')
  fs.mkdirSync(root)
  file = path.join(base, 'data', 'file-claims.json')
  clock = new Date(2026, 10, 13, 20, 0, 0).getTime()
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

describe('globToRegExp', () => {
  it('* 和 ? 不跨目录，** 跨任意级', () => {
    expect(globToRegExp('src/*.ts', false).test('src/a.ts')).toBe(true)
    expect(globToRegExp('src/*.ts', false).test('src/core/a.ts')).toBe(false)
    expect(globToRegExp('src/?.ts', false).test('src/a.ts')).toBe(true)
    expect(globToRegExp('src/?.ts', false).test('src/ab.ts')).toBe(false)
    expect(globToRegExp('src/**/*.ts', false).test('src/a.ts')).toBe(true)
    expect(globToRegExp('src/**/*.ts', false).test('src/core/deep/a.ts')).toBe(true)
    expect(globToRegExp('src/**', false).test('src/core/a.ts')).toBe(true)
    expect(globToRegExp('src/**', false).test('tests/a.ts')).toBe(false)
  })

  it('不带 glob 的路径同时覆盖它下面的文件，但不匹配同名前缀', () => {
    const re = globToRegExp('src/core', false)
    expect(re.test('src/core')).toBe(true)
    expect(re.test('src/core/tasks.ts')).toBe(true)
    expect(re.test('src/core2/x.ts')).toBe(false)
  })

  it('正则特殊字符按字面匹配；大小写按开关', () => {
    expect(globToRegExp('a+b(1).ts', false).test('a+b(1).ts')).toBe(true)
    expect(globToRegExp('a.ts', false).test('aXts')).toBe(false)
    expect(globToRegExp('Src/A.ts', true).test('src/a.TS')).toBe(true)
    expect(globToRegExp('Src/A.ts', false).test('src/a.ts')).toBe(false)
  })
})

describe('normalize', () => {
  it('反斜杠、./、末尾 / 统一；工作区内的绝对路径转成相对', () => {
    const s = make()
    expect(s.normalize('src\\core\\tasks.ts')).toBe('src/core/tasks.ts')
    expect(s.normalize('./src/core/')).toBe('src/core')
    expect(s.normalize(path.join(root, 'src', 'a.ts'))).toBe('src/a.ts')
    expect(s.normalize('src\\**\\*.ts')).toBe('src/**/*.ts')
  })

  it('.. 越出工作区直接拒绝', () => {
    const s = make()
    expect(code(() => s.normalize('../other/a.ts'))).toBe('OUTSIDE_WORKSPACE')
    expect(code(() => s.normalize('src/../../a.ts'))).toBe('OUTSIDE_WORKSPACE')
    expect(code(() => s.normalize(path.join(base, 'elsewhere.ts')))).toBe('OUTSIDE_WORKSPACE')
    expect(s.normalize('src/../a.ts')).toBe('a.ts')
  })

  it('一次占整个工作区（**、**/*、.）拒绝，具体目录下的 ** 可以', () => {
    const s = make()
    for (const p of ['**', '**/*', '**/**', '.', './', '**\\*']) expect(code(() => s.normalize(p))).toBe('CLAIM_TOO_BROAD')
    expect(s.normalize('src/**')).toBe('src/**')
    expect(s.normalize('**/*.ts')).toBe('**/*.ts')
    expect(code(() => s.normalize(''))).toBe('INVALID_ARGS')
  })

  it('机器工作区存绝对路径，整盘拒绝，相对路径拒绝', () => {
    const s = make({ machine: true })
    const abs = path.join(base, 'x', 'a.ts')
    expect(s.normalize(abs)).toBe(abs.replace(/\\/g, '/'))
    expect(code(() => s.normalize('rel/a.ts'))).toBe('INVALID_ARGS')
    if (process.platform === 'win32') {
      expect(code(() => s.normalize('D:\\**'))).toBe('CLAIM_TOO_BROAD')
      expect(code(() => s.normalize('D:\\'))).toBe('CLAIM_TOO_BROAD')
      expect(s.normalize('D:\\AProgram\\**')).toBe('D:/AProgram/**')
    } else {
      expect(code(() => s.normalize('/**'))).toBe('CLAIM_TOO_BROAD')
    }
  })
})

describe('登记与提醒', () => {
  it('别人写已登记的文件：warn 模式不拦，给【占用提醒】；自己写不算冲突', () => {
    const s = make()
    s.claim(A, ['src/core/tasks.ts'], { task: 'T-13' })
    const g = s.gate(B.agentId, ['SRC\\Core\\Tasks.ts'])
    expect(g.blocked).toBe(false)
    expect(g.hits).toHaveLength(1)
    expect(g.hits[0]).toMatchObject({ agentName: 'Alice', task: 'T-13', kind: 'explicit' })
    expect(s.gate(B.agentId, ['src/core/tasks.ts']).text).toBe('【占用提醒】src/core/tasks.ts 已被 Alice 登记（T-13，20:00 起，到 20:30），这次写入照常完成；要接着改请先在群里跟对方说一声。')
    expect(s.gate(A.agentId, ['src/core/tasks.ts']).text).toBeNull()
    expect(s.gate(B.agentId, ['src/core/other.ts']).text).toBeNull()
  })

  it('glob 和目录登记覆盖下面的文件', () => {
    const s = make()
    s.claim(A, ['src/renderer/**/*.tsx', 'docs'])
    expect(s.check(B.agentId, ['src/renderer/src/views/A.tsx'])).toHaveLength(1)
    expect(s.check(B.agentId, ['docs/design.md'])).toHaveLength(1)
    expect(s.check(B.agentId, ['src/renderer/src/lib/a.ts'])).toHaveLength(0)
  })

  it('block 模式只拦主动登记，自动登记永远只提醒；off 模式什么都不说', () => {
    const s = make({ mode: 'block' })
    s.claim(A, ['a.ts'], { task: 'T-1' })
    s.touch(A, ['b.ts'])
    const g1 = s.gate(B.agentId, ['a.ts'])
    expect(g1.blocked).toBe(true)
    expect(g1.text).toContain('这次没有写入')
    const g2 = s.gate(B.agentId, ['b.ts'])
    expect(g2.blocked).toBe(false)
    expect(g2.text).toContain('Alice 刚改过（写文件自动登记')
    expect(g2.text).toContain('照常完成')
    s.mode = 'off'
    expect(s.gate(B.agentId, ['a.ts'])).toEqual({ blocked: false, hits: [], text: null })
  })

  it('同一任务的主动登记合并续约；ttl 超出 1–240 拒绝；重叠的登记只提示', () => {
    const s = make()
    const first = s.claim(A, ['a.ts'], { task: 'T-1' }).claim
    clock += 20 * MIN
    const second = s.claim(A, ['b.ts', 'A.TS'], { task: 'T-1', ttlMinutes: 60 }).claim
    expect(second.id).toBe(first.id)
    expect(second.paths).toEqual(['a.ts', 'b.ts'])
    expect(second.expiresAt).toBe(clock + 60 * MIN)
    expect(code(() => s.claim(A, ['c.ts'], { ttlMinutes: 0 }))).toBe('INVALID_ARGS')
    expect(code(() => s.claim(A, ['c.ts'], { ttlMinutes: 241 }))).toBe('INVALID_ARGS')
    expect(code(() => s.claim(A, []))).toBe('INVALID_ARGS')
    const r = s.claim(B, ['*.ts'])
    expect(r.overlaps.map((h) => h.pattern).sort()).toEqual(['a.ts', 'b.ts'])
    expect(s.summary().claims).toHaveLength(2)
  })

  it('写文件自动登记 10 分钟，并给本人的主动登记续约', () => {
    const s = make()
    s.claim(A, ['src/**'], { task: 'T-1' })
    clock += 25 * MIN
    s.touch(A, ['src/x.ts', '../outside.ts'], 'T-1')
    const sum = s.summary()
    const exp = sum.claims.find((c) => c.kind === 'explicit')!
    const imp = sum.claims.find((c) => c.kind === 'implicit')!
    expect(exp.expiresAt).toBe(clock + 30 * MIN)
    expect(imp.paths).toEqual(['src/x.ts'])
    expect(imp.expiresAt).toBe(clock + 10 * MIN)
    clock += 11 * MIN
    expect(s.summary().claims.map((c) => c.kind)).toEqual(['explicit'])
  })
})

describe('自动登记按路径各自过期', () => {
  it('先写 A，11 分钟后写 B：A 已释放，只剩 B', () => {
    const s = make()
    s.touch(A, ['a.ts'])
    clock += 11 * MIN
    s.touch(A, ['b.ts'])
    expect(s.check(B.agentId, ['a.ts'])).toEqual([])
    expect(s.check(B.agentId, ['b.ts'])).toHaveLength(1)
    expect(s.summary().byAgent).toEqual({ Alice: ['b.ts'] })
  })

  it('只续这次写到的路径；重复写同一文件不增加记录', () => {
    const s = make()
    s.touch(A, ['a.ts', 'b.ts'])
    clock += 6 * MIN
    s.touch(A, ['A.TS'], 'T-9')
    const imp = s.summary().claims
    expect(imp).toHaveLength(2)
    expect(imp.find((c) => c.paths[0] === 'a.ts')).toMatchObject({ task: 'T-9', expiresAt: clock + 10 * MIN })
    expect(imp.find((c) => c.paths[0] === 'b.ts')!.expiresAt).toBe(clock + 4 * MIN)
    clock += 5 * MIN
    expect(s.summary().byAgent).toEqual({ Alice: ['a.ts'] })
  })
})

describe('释放与过期', () => {
  it('租约到期自动清掉，并写回磁盘；重启加载时过期的直接清掉', () => {
    const s = make()
    s.claim(A, ['a.ts'], { ttlMinutes: 5 })
    s.claim(B, ['b.ts'], { ttlMinutes: 60 })
    clock += 6 * MIN
    const again = make()
    expect(again.summary().claims.map((c) => c.agentName)).toEqual(['Bob'])
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(onDisk.version).toBe(1)
    expect(onDisk.claims).toHaveLength(1)
  })

  it('会话断开、任务结束各自只释放自己那部分', () => {
    const s = make()
    s.claim(A, ['a.ts'], { task: 'T-1' })
    s.touch(A, ['a2.ts'])
    s.claim(B, ['b.ts'], { task: 'T-2' })
    s.claim({ ...B, session: 's_b2' }, ['c.ts'], { task: 'T-3' })
    expect(s.releaseSession('s_a')).toBe(2)
    expect(s.releaseTask('T-2')).toBe(1)
    expect(s.summary().claims.map((c) => c.paths[0])).toEqual(['c.ts'])
  })

  it('本人按路径、按 id、全部释放；不能释放别人的', () => {
    const s = make()
    const a = s.claim(A, ['a.ts', 'b.ts'], { task: 'T-1' }).claim
    const other = s.claim(B, ['z.ts']).claim
    expect(s.release(A.agentId, { paths: ['A.ts'] })).toBe(1)
    expect(s.summary().byAgent).toEqual({ Alice: ['b.ts'], Bob: ['z.ts'] })
    expect(code(() => s.release(A.agentId, { ids: [other.id] }))).toBe('NOT_OWNER')
    expect(s.release(A.agentId, { ids: [a.id] })).toBe(1)
    s.claim(A, ['c.ts'])
    s.touch(A, ['d.ts'])
    expect(s.release(A.agentId)).toBe(2)
    expect(Object.keys(s.summary().byAgent)).toEqual(['Bob'])
  })
})

describe('摘要、通知、未登记改动', () => {
  it('summary 按人汇总，ownerOf 查单个文件（含自己）', () => {
    const s = make()
    s.claim(A, ['src/core/**'], { task: 'T-1' })
    s.touch(A, ['src/core/x.ts'])
    s.claim(B, ['tests/a.test.ts'])
    expect(s.summary().byAgent).toEqual({ Alice: ['src/core/**', 'src/core/x.ts'], Bob: ['tests/a.test.ts'] })
    expect(s.ownerOf('src/core/x.ts').map((h) => h.kind).sort()).toEqual(['explicit', 'implicit'])
    expect(s.ownerOf('README.md')).toEqual([])
  })

  it('给占用人的通知同一文件 10 分钟内只推一次', () => {
    const s = make()
    s.claim(A, ['a.ts', 'b.ts'])
    const hits = s.check(B.agentId, ['a.ts', 'b.ts'])
    expect(s.ownerNotices(B, hits, 'T-16')).toEqual([{ agentId: 'a_a', text: 'Bob 写了你登记的 a.ts、b.ts（T-16）' }])
    clock += 5 * MIN
    expect(s.ownerNotices(B, s.check(B.agentId, ['a.ts']))).toEqual([])
    clock += 6 * MIN
    expect(s.ownerNotices(B, s.check(B.agentId, ['a.ts']))).toEqual([{ agentId: 'a_a', text: 'Bob 写了你登记的 a.ts' }])
  })

  it('unclaimed 挑出 git status 里谁也没登记的路径', () => {
    const s = make()
    s.claim(A, ['src/core/**'])
    s.touch(B, ['tests/x.test.ts'])
    expect(s.unclaimed(['src/core/a.ts', 'tests/x.test.ts', 'src/main/index.ts', '../out.ts'])).toEqual(['src/main/index.ts'])
  })

  it('formatClaimWarning 多条用分号连起来', () => {
    const t = new Date(2026, 10, 13, 9, 5).getTime()
    const text = formatClaimWarning([
      { path: 'a.ts', pattern: 'a.ts', claimId: 'x', agentId: 'a', agentName: 'Alice', task: null, kind: 'explicit', since: t, expiresAt: t + 30 * MIN },
      { path: 'b.ts', pattern: 'b.ts', claimId: 'y', agentId: 'b', agentName: 'Bob', task: 'T-2', kind: 'implicit', since: t, expiresAt: t + 10 * MIN }
    ])
    expect(text).toBe('【占用提醒】a.ts 已被 Alice 登记（09:05 起，到 09:35）；b.ts 已被 Bob 刚改过（写文件自动登记，T-2，09:05 起，到 09:15），这次写入照常完成；要接着改请先在群里跟对方说一声。')
  })
})
