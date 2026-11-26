import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import iconv from 'iconv-lite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { versionOf } from '../src/core/fileTools'
import { PathGuard } from '../src/core/pathGuard'
import { applyPatch, parsePatch, type PatchEnv } from '../src/core/patchApplier'

let base: string
let root: string
let trash: string
let env: PatchEnv

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-patch-'))
  root = path.join(base, 'ws')
  trash = path.join(base, 'trash')
  fs.mkdirSync(root)
  const guard = new PathGuard(root)
  env = { resolve: (p) => guard.resolve(p), trashDir: trash }
})

afterEach(() => fs.rmSync(base, { recursive: true, force: true }))

const write = (rel: string, data: string | Buffer): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), data)
}
const raw = (rel: string): Buffer => fs.readFileSync(path.join(root, rel))
const text = (rel: string): string => raw(rel).toString('utf8')
const exists = (rel: string): boolean => fs.existsSync(path.join(root, rel))
const P = (...lines: string[]): string => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')

/** 工作区里所有文件（含临时文件）及其内容，用来断言「什么都没变」 */
function tree(): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name)
      const rel = path.relative(root, abs).split(path.sep).join('/')
      if (e.isDirectory()) {
        out[rel + '/'] = ''
        walk(abs)
      } else out[rel] = fs.readFileSync(abs).toString('hex')
    }
  }
  walk(root)
  return out
}

const errOf = async (p: Promise<unknown>): Promise<{ code: string; message: string; data?: Record<string, unknown> }> => {
  try {
    await p
  } catch (e) {
    return e as { code: string; message: string; data?: Record<string, unknown> }
  }
  throw new Error('应该抛错')
}

describe('解析', () => {
  it('拒绝格式不对的补丁', () => {
    expect(() => parsePatch('')).toThrow(/INVALID_PATCH/)
    expect(() => parsePatch('*** Update File: a\n@@\n-x\n+y\n*** End Patch')).toThrow(/Begin Patch/)
    expect(() => parsePatch('*** Begin Patch\n*** Update File: a\n@@\n-x\n+y')).toThrow(/End Patch/)
    expect(() => parsePatch(P('*** Frobnicate File: a'))).toThrow(/INVALID_PATCH/)
    expect(() => parsePatch(P('*** Update File: a'))).toThrow(/没有任何改动块/)
    expect(() => parsePatch(P('*** Update File: a', '@@', ' only context'))).toThrow(/没有任何 \+ 或 -/)
    expect(() => parsePatch(P('*** Add File: a', 'no plus'))).toThrow(/必须以 \+ 开头/)
    expect(() => parsePatch(P())).toThrow(/没有任何文件操作/)
  })

  it('容忍 CRLF、前后空行和省略 @@ 的第一个块', () => {
    const ops = parsePatch('\r\n*** Begin Patch\r\n*** Update File: a.txt\r\n-x\r\n+y\r\n*** End Patch\r\n\r\n')
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ action: 'update', path: 'a.txt' })
  })

  it('操作数和补丁大小有上限', async () => {
    const many = P(...Array.from({ length: 3 }, (_, i) => [`*** Add File: f${i}.txt`, '+x']).flat())
    expect((await errOf(applyPatch(env, many, { limits: { maxOperations: 2 } }))).code).toBe('TOO_LARGE')
    expect((await errOf(applyPatch(env, many, { limits: { maxPatchBytes: 10 } }))).code).toBe('TOO_LARGE')
    expect(tree()).toEqual({})
  })
})

describe('多文件成功路径', () => {
  it('一次完成新建、修改、删除、移动，删除进回收站', async () => {
    write('src/a.ts', 'one\ntwo\nthree\n')
    write('src/old.ts', 'keep\nme\n')
    write('gone.txt', 'bye\n')
    const r = await applyPatch(
      env,
      P(
        '*** Add File: new/dir/n.ts',
        '+hello',
        '+world',
        '*** Update File: src/a.ts',
        '@@',
        ' one',
        '-two',
        '+TWO',
        ' three',
        '*** Delete File: gone.txt',
        '*** Update File: src/old.ts',
        '*** Move to: src/moved.ts',
        '@@',
        ' keep',
        '-me',
        '+you'
      )
    )
    expect(text('new/dir/n.ts')).toBe('hello\nworld\n')
    expect(text('src/a.ts')).toBe('one\nTWO\nthree\n')
    expect(exists('gone.txt')).toBe(false)
    expect(exists('src/old.ts')).toBe(false)
    expect(text('src/moved.ts')).toBe('keep\nyou\n')

    expect(r.status).toBe('success')
    expect(r.multi_file_atomic).toBe(false)
    expect(r.commit_strategy).toBe('staged_atomic_per_file')
    expect(r.atomic).toBe(true)
    expect(r.summary).toEqual({ files_changed: 4, additions: 4, deletions: 3 })
    expect(r.files.map((f) => f.action)).toEqual(['add', 'update', 'delete', 'move'])
    const upd = r.files[1]
    expect(upd.new_version).toBe(versionOf(raw('src/a.ts')))
    expect(r.files[3]).toMatchObject({ path: 'src/old.ts', destination_path: 'src/moved.ts' })
    expect(r.diff).toContain('+++ b/new/dir/n.ts')
    expect(r.diff).toContain('-two')
    expect(r.diff).toContain('+TWO')
    expect(r.diff).toContain('+++ /dev/null')

    const del = r.files[2]
    expect(del.trash_id).toBeTruthy()
    const tdir = path.join(trash, del.trash_id!)
    expect(fs.readFileSync(path.join(tdir, 'gone.txt'), 'utf8')).toBe('bye\n')
    expect(JSON.parse(fs.readFileSync(path.join(tdir, 'manifest.json'), 'utf8')).originalPath).toBe('gone.txt')
    // 没有留下临时文件
    expect(Object.keys(tree()).filter((k) => k.includes('.bridge-'))).toEqual([])
  })

  it('只改名不改内容，空文件也能新建', async () => {
    write('a.txt', 'same\n')
    await applyPatch(env, P('*** Update File: a.txt', '*** Move to: b/c.txt', '*** Add File: empty.txt'))
    expect(text('b/c.txt')).toBe('same\n')
    expect(exists('a.txt')).toBe(false)
    expect(text('empty.txt')).toBe('')
  })

  it('保留 CRLF、BOM、GB18030 编码和末尾无换行', async () => {
    write('crlf.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\nc\r\n')]))
    write('gbk.txt', iconv.encode('你好\n世界', 'gb18030'))
    await applyPatch(
      env,
      P('*** Update File: crlf.txt', '@@', ' a', '-b', '+B', '*** Update File: gbk.txt', '@@', ' 你好', '-世界', '+天下')
    )
    expect(raw('crlf.txt')).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nB\r\nc\r\n')]))
    expect(raw('gbk.txt')).toEqual(iconv.encode('你好\n天下', 'gb18030'))
  })

  it('End of File 锚定到文件末尾，@@ 后的函数名帮助消歧义，容忍行尾空白', async () => {
    write('a.ts', 'function f() {\n  return 1\n}\nfunction g() {\n  return 1\n}\nx   \n')
    await applyPatch(
      env,
      P('*** Update File: a.ts', '@@ function g() {', '-  return 1', '+  return 2', '@@', '-x', '+y', '*** End of File')
    )
    expect(text('a.ts')).toBe('function f() {\n  return 1\n}\nfunction g() {\n  return 2\n}\ny\n')
  })

  it('接受 read_file 的 16 位版本和 sha256:完整哈希', async () => {
    write('a.txt', 'x\n')
    write('b.txt', 'y\n')
    const full = 'sha256:' + crypto.createHash('sha256').update(raw('b.txt')).digest('hex')
    await applyPatch(env, P('*** Update File: a.txt', '-x', '+X', '*** Update File: b.txt', '-y', '+Y'), {
      expectedVersions: { 'a.txt': versionOf(raw('a.txt')), './b.txt': full }
    })
    expect(text('a.txt') + text('b.txt')).toBe('X\nY\n')
  })
})

describe('预检失败时一个文件都不写', () => {
  beforeEach(() => {
    write('a.txt', 'a1\na2\n')
    write('b.txt', 'dup\nmid\ndup\n')
  })
  const goodA = ['*** Update File: a.txt', '-a1', '+A1']

  it('hunk 找不到', async () => {
    const before = tree()
    const e = await errOf(applyPatch(env, P(...goodA, '*** Add File: c.txt', '+c', '*** Update File: b.txt', '-nope', '+x')))
    expect(e.code).toBe('HUNK_NOT_FOUND')
    expect(e.data).toMatchObject({ path: 'b.txt', hunk: 1 })
    expect(tree()).toEqual(before)
  })

  it('hunk 不唯一', async () => {
    const before = tree()
    const e = await errOf(applyPatch(env, P(...goodA, '*** Update File: b.txt', '-dup', '+x')))
    expect(e.code).toBe('AMBIGUOUS_HUNK')
    expect(e.data?.lines).toEqual([1, 3])
    expect(tree()).toEqual(before)
  })

  it('版本不对', async () => {
    const before = tree()
    const e = await errOf(applyPatch(env, P(...goodA), { expectedVersions: { 'a.txt': '0000000000000000' } }))
    expect(e.code).toBe('CONFLICT')
    expect(e.data?.current_version).toBe(versionOf(raw('a.txt')))
    expect(tree()).toEqual(before)
  })

  it('越界路径', async () => {
    const before = tree()
    expect((await errOf(applyPatch(env, P(...goodA, '*** Add File: ../escape.txt', '+x')))).code).toBe('OUTSIDE_WORKSPACE')
    expect(tree()).toEqual(before)
    expect(fs.existsSync(path.join(base, 'escape.txt'))).toBe(false)
  })

  it('凭据文件名和 .git 内部不再拦：补丁照常写入', async () => {
    await applyPatch(env, P('*** Add File: .env', '+x', '*** Add File: .git/hooks/pre-commit', '+y'))
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('x\n')
    expect(fs.readFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), 'utf8')).toBe('y\n')
  })

  it('新建已存在、移动到已存在、同一文件出现两次、文件与目录冲突、修改不存在的文件', async () => {
    const before = tree()
    expect((await errOf(applyPatch(env, P(...goodA, '*** Add File: b.txt', '+x')))).code).toBe('ALREADY_EXISTS')
    expect((await errOf(applyPatch(env, P('*** Update File: a.txt', '*** Move to: b.txt')))).code).toBe('ALREADY_EXISTS')
    expect((await errOf(applyPatch(env, P(...goodA, '*** Delete File: ./a.txt')))).code).toBe('INVALID_PATCH')
    expect((await errOf(applyPatch(env, P('*** Add File: d', '+x', '*** Add File: d/e', '+y')))).code).toBe('INVALID_PATCH')
    expect((await errOf(applyPatch(env, P('*** Update File: missing.txt', '-x', '+y')))).code).toBe('NOT_FOUND')
    expect((await errOf(applyPatch(env, P('*** Delete File: .')))).code).toBe('INVALID_PATCH')
    expect(tree()).toEqual(before)
  })

  it('二进制和超大文件', async () => {
    write('bin.dat', Buffer.from([1, 0, 2, 3]))
    write('big.txt', 'x'.repeat(100) + '\n')
    const before = tree()
    expect((await errOf(applyPatch(env, P('*** Delete File: bin.dat')))).code).toBe('BINARY_FILE')
    expect((await errOf(applyPatch(env, P('*** Delete File: big.txt'), { limits: { maxFileBytes: 50 } }))).code).toBe('TOO_LARGE')
    expect(tree()).toEqual(before)
  })
})

describe('写入中途失败时回滚', () => {
  beforeEach(() => {
    write('u.txt', 'u1\nu2\n')
    write('d.txt', 'd\n')
    write('m.txt', 'm1\n')
    write('last.txt', 'l\n')
  })
  const patch = P(
    '*** Update File: u.txt',
    '-u1',
    '+U1',
    '*** Add File: deep/new/a.txt',
    '+a',
    '*** Delete File: d.txt',
    '*** Update File: m.txt',
    '*** Move to: moved/m.txt',
    '-m1',
    '+M1',
    '*** Update File: last.txt',
    '-l',
    '+L'
  )

  it('第 5 个文件落盘前抛错：前 4 个全部恢复，新建的目录和回收站条目也清掉', async () => {
    const before = tree()
    const e = await errOf(
      applyPatch(env, patch, {
        beforeCommit: ({ index }) => {
          if (index === 4) throw new Error('模拟磁盘满')
        }
      })
    )
    expect(e.code).toBe('IO_ERROR')
    expect(e.message).toContain('已回滚')
    expect(e.data?.rolled_back_files).toBe(4)
    expect(tree()).toEqual(before)
    expect(fs.existsSync(trash) ? fs.readdirSync(trash) : []).toEqual([])
  })

  it('落盘前发现后面的文件被别人改了：报 CONFLICT 并回滚，别人的改动保留', async () => {
    const e = await errOf(
      applyPatch(env, patch, {
        beforeCommit: ({ index }) => {
          if (index === 3) write('last.txt', 'someone else\n')
        }
      })
    )
    expect(e.code).toBe('CONFLICT')
    expect(e.data?.path).toBe('last.txt')
    expect(text('u.txt')).toBe('u1\nu2\n')
    expect(text('d.txt')).toBe('d\n')
    expect(text('m.txt')).toBe('m1\n')
    expect(exists('moved')).toBe(false)
    expect(exists('deep')).toBe(false)
    expect(text('last.txt')).toBe('someone else\n')
  })

  it('rename 被占用时重试，持续被占用就直接覆盖写并标记非原子', async () => {
    let fails = 2
    const flaky = async (a: string, b: string): Promise<void> => {
      if (fails-- > 0) throw Object.assign(new Error('busy'), { code: 'EPERM' })
      fs.renameSync(a, b)
    }
    const r1 = await applyPatch(env, P('*** Update File: u.txt', '-u1', '+X'), { fsOps: { rename: flaky } })
    expect(r1.atomic).toBe(true)
    expect(text('u.txt')).toBe('X\nu2\n')

    const locked = async (): Promise<void> => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    }
    const r2 = await applyPatch(env, P('*** Update File: u.txt', '-X', '+Y'), { fsOps: { rename: locked } })
    expect(r2.atomic).toBe(false)
    expect(r2.files[0].atomic).toBe(false)
    expect(text('u.txt')).toBe('Y\nu2\n')
    expect(Object.keys(tree()).filter((k) => k.includes('.bridge-'))).toEqual([])
  })
})

describe('并发与输出', () => {
  it('两个补丁同时改同一个文件：串行执行，后一个因版本过期报 CONFLICT', async () => {
    write('a.txt', 'x\n')
    const v = versionOf(raw('a.txt'))
    const results = await Promise.allSettled([
      applyPatch(env, P('*** Update File: a.txt', '-x', '+one'), { expectedVersions: { 'a.txt': v } }),
      applyPatch(env, P('*** Update File: a.txt', '-x', '+two'), { expectedVersions: { 'a.txt': v } })
    ])
    const ok = results.filter((r) => r.status === 'fulfilled')
    const bad = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(ok).toHaveLength(1)
    expect(bad).toHaveLength(1)
    expect(bad[0].reason.code).toBe('CONFLICT')
    expect(['one\n', 'two\n']).toContain(text('a.txt'))
  })

  it('diff 超长时按 UTF-8 字节截断，文件仍完整写入', async () => {
    const body = Array.from({ length: 200 }, (_, i) => `+中文行 ${i}`)
    const r = await applyPatch(env, P('*** Add File: big.txt', ...body), { limits: { maxDiffBytes: 500 } })
    expect(r.diff_truncated).toBe(true)
    expect(Buffer.byteLength(r.diff, 'utf8')).toBeLessThan(600)
    expect(r.diff).not.toContain('\ufffd')
    expect(text('big.txt').split('\n')).toHaveLength(201)
  })
})
