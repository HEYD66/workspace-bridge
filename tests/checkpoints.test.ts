import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CheckpointStore, type CheckpointMeta } from '../src/core/checkpoints'
import { ToolError, versionOf } from '../src/core/fileTools'

let tmp: string
let root: string
let store: CheckpointStore

const resolve = (input: string) => {
  const abs = path.resolve(root, input)
  const rel = path.relative(root, abs).split(path.sep).join('/') || '.'
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ToolError('OUTSIDE_WORKSPACE', input)
  if (rel.split('/').some((seg) => seg === '.env' || seg === '.git')) throw new ToolError('DENIED', input)
  return { abs, rel }
}
const meta = (over: Partial<CheckpointMeta> = {}): CheckpointMeta => ({
  agentId: 'a1',
  agentName: '玖雅01',
  session: 's1',
  task: null,
  tool: 'write_file',
  ...over
})
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')
const write = (rel: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), s)
}
const exists = (rel: string) => fs.existsSync(path.join(root, rel))

/** 模拟一次带检查点的写操作 */
async function op(paths: string[], fn: () => void, m: Partial<CheckpointMeta> = {}) {
  const p = await store.begin(meta(m), paths)
  fn()
  return store.commit(p)
}

async function expectCode(pr: Promise<unknown>, code: string) {
  try {
    await pr
  } catch (e) {
    expect((e as ToolError).code).toBe(code)
    return e as ToolError
  }
  throw new Error(`应该报 ${code}`)
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-'))
  root = path.join(tmp, 'ws')
  fs.mkdirSync(root)
  store = new CheckpointStore(path.join(tmp, 'data', 'checkpoints'), resolve, path.join(tmp, 'trash'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('检查点记录', () => {
  it('改字、新建、删除都记下改前改后的 version', async () => {
    write('a.txt', 'one\n')
    const s1 = await op(['a.txt'], () => write('a.txt', 'two\n'))
    expect(s1?.files).toEqual([{ path: 'a.txt', before: expect.any(String), beforeVersion: versionOf(Buffer.from('one\n')), after: versionOf(Buffer.from('two\n')) }])
    const s2 = await op(['new/b.txt'], () => write('new/b.txt', 'b'))
    expect(s2?.files[0]).toMatchObject({ path: 'new/b.txt', before: null, beforeVersion: null })
    expect(s2?.newDirs).toEqual(['new/b.txt', 'new'])
    const s3 = await op(['a.txt'], () => fs.rmSync(path.join(root, 'a.txt')), { tool: 'delete' })
    expect(s3?.files[0]).toMatchObject({ path: 'a.txt', after: null })
    // 数据在 bridge 自己的目录里，工作区里没有任何新东西
    expect(fs.readdirSync(root).sort()).toEqual(['new'])
    expect(fs.existsSync(path.join(tmp, 'data', 'checkpoints', 'index.json'))).toBe(true)
  })

  it('内容没变就不记检查点', async () => {
    write('a.txt', 'same')
    expect(await op(['a.txt'], () => write('a.txt', 'same'))).toBeNull()
    expect(store.select({ session: 's1' })).toHaveLength(0)
  })

  it('目录移动：旧位置和新位置的每个文件都记下', async () => {
    write('src/x.ts', 'x')
    write('src/sub/y.ts', 'y')
    const s = await op(['src', 'lib'], () => fs.renameSync(path.join(root, 'src'), path.join(root, 'lib')), { tool: 'move' })
    const byPath = Object.fromEntries(s!.files.map((f) => [f.path, f]))
    expect(Object.keys(byPath).sort()).toEqual(['lib/sub/y.ts', 'lib/x.ts', 'src/sub/y.ts', 'src/x.ts'])
    expect(byPath['src/x.ts'].after).toBeNull()
    expect(byPath['lib/x.ts'].before).toBeNull()
  })

  it('move 一个超过快照上限的大文件：目标也不记成「原来不存在」，回滚不会把它扔进回收站', async () => {
    const big = Buffer.alloc(21 * 1024 * 1024, 0x61)
    fs.writeFileSync(path.join(root, 'big.txt'), big)
    write('dir/small.txt', 's')
    fs.writeFileSync(path.join(root, 'dir', 'huge.txt'), big)
    await op(['big.txt', 'moved.txt'], () => fs.renameSync(path.join(root, 'big.txt'), path.join(root, 'moved.txt')), { tool: 'move' })
    const s2 = await op(['dir', 'dir2'], () => fs.renameSync(path.join(root, 'dir'), path.join(root, 'dir2')), { tool: 'move' })
    expect(s2!.files.map((f) => f.path).sort()).toEqual(['dir/small.txt', 'dir2/small.txt'])
    await store.rollback(meta({ tool: 'checkpoint_rollback' }), store.select({ agentId: 'a1', session: 's1' }))
    // 大文件留在 move 之后的位置（没快照，没法搬回去），但不会从两处都消失
    expect(fs.statSync(path.join(root, 'moved.txt')).size).toBe(big.length)
    expect(fs.statSync(path.join(root, 'dir2', 'huge.txt')).size).toBe(big.length)
    expect(read('dir/small.txt')).toBe('s')
  })

  it('删目录时，路径守卫保护的文件（.env、.git）不存快照，记进 skipped', async () => {
    write('d/a.txt', 'a\n')
    write('d/.env', 'SECRET=1\n')
    write('d/.git/HEAD', 'ref\n')
    const step = await op(['d'], () => fs.rmSync(path.join(root, 'd'), { recursive: true }), { tool: 'delete' })
    expect(step!.files.map((f) => f.path)).toEqual(['d/a.txt'])
    expect(step!.skipped.map((x) => x.path).sort()).toEqual(['d/.env', 'd/.git'])
  })

  it('索引重新加载后还在（工作台重启不丢）', async () => {
    write('a.txt', '1')
    await op(['a.txt'], () => write('a.txt', '2'))
    const again = new CheckpointStore(path.join(tmp, 'data', 'checkpoints'), resolve, path.join(tmp, 'trash'))
    expect(again.select({ session: 's1' }).map((s) => s.id)).toEqual(['cp-1'])
  })
})

describe('回滚', () => {
  it('整个会话退回：改过的恢复、新建的删掉（进回收站）、删掉的建回来、空目录清掉', async () => {
    write('a.txt', 'A0')
    write('gone.txt', 'G0')
    await op(['a.txt'], () => write('a.txt', 'A1'))
    await op(['a.txt'], () => write('a.txt', 'A2'))
    await op(['deep/dir/n.txt'], () => write('deep/dir/n.txt', 'N'))
    await op(['gone.txt'], () => fs.rmSync(path.join(root, 'gone.txt')))
    const r = await store.rollback(meta({ tool: 'checkpoint_rollback' }), store.select({ agentId: 'a1', session: 's1' }))
    expect(read('a.txt')).toBe('A0')
    expect(read('gone.txt')).toBe('G0')
    expect(exists('deep')).toBe(false)
    expect('files' in r && r.files.map((f) => `${f.action}:${f.path}`).sort()).toEqual([
      'deleted:deep/dir/n.txt',
      'recreated:gone.txt',
      'restored:a.txt'
    ])
    expect(fs.readdirSync(path.join(tmp, 'trash'))).toHaveLength(1)
    // 再回滚一次：没东西可退
    await expectCode(store.rollback(meta(), store.select({ agentId: 'a1', session: 's1' })), 'NOTHING_TO_ROLLBACK')
  })

  it('只退回选中的会话，其他会话的文件不动', async () => {
    write('mine.txt', 'm0')
    write('other.txt', 'o0')
    await op(['mine.txt'], () => write('mine.txt', 'm1'))
    await op(['other.txt'], () => write('other.txt', 'o1'), { session: 's2' })
    await store.rollback(meta(), store.select({ agentId: 'a1', session: 's1' }))
    expect(read('mine.txt')).toBe('m0')
    expect(read('other.txt')).toBe('o1')
  })

  it('从某个检查点开始退：只退它和之后的', async () => {
    write('a.txt', '0')
    await op(['a.txt'], () => write('a.txt', '1'))
    const s2 = await op(['a.txt'], () => write('a.txt', '2'))
    await op(['a.txt'], () => write('a.txt', '3'))
    await store.rollback(meta(), store.select({ agentId: 'a1', fromStep: s2!.id }))
    expect(read('a.txt')).toBe('1')
  })

  it('检查点之后文件被别人改过：报 CONFLICT，一个文件都不写', async () => {
    write('a.txt', 'a0')
    write('b.txt', 'b0')
    await op(['a.txt', 'b.txt'], () => {
      write('a.txt', 'a1')
      write('b.txt', 'b1')
    }, { tool: 'apply_patch' })
    write('b.txt', 'b-human') // 人在编辑器里又改了
    const e = await expectCode(store.rollback(meta(), store.select({ agentId: 'a1', session: 's1' })), 'CONFLICT')
    expect(e.data?.conflicts).toEqual([
      expect.objectContaining({ path: 'b.txt', reason: 'modified_after', current_version: versionOf(Buffer.from('b-human')) })
    ])
    expect(e.data?.restorable).toEqual(['a.txt'])
    expect(read('a.txt')).toBe('a1')
    expect(read('b.txt')).toBe('b-human')
    // 只回滚没冲突的那个
    await store.rollback(meta(), store.select({ agentId: 'a1', session: 's1' }), { paths: ['a.txt'] })
    expect(read('a.txt')).toBe('a0')
    expect(read('b.txt')).toBe('b-human')
  })

  it('另一个 AI 后来也改过同一个文件：报 touched_by_other', async () => {
    write('a.txt', '0')
    await op(['a.txt'], () => write('a.txt', '1'))
    await op(['a.txt'], () => write('a.txt', '2'), { agentId: 'a2', agentName: '别人', session: 's9' })
    const e = await expectCode(store.rollback(meta(), store.select({ agentId: 'a1', session: 's1' })), 'CONFLICT')
    expect(e.data?.conflicts).toEqual([expect.objectContaining({ path: 'a.txt', reason: 'touched_by_other' })])
    expect(read('a.txt')).toBe('2')
  })

  it('两次修改之间被命令改过：报 changed_between', async () => {
    write('a.txt', '0')
    await op(['a.txt'], () => write('a.txt', '1'))
    write('a.txt', 'by-command')
    await op(['a.txt'], () => write('a.txt', '2'))
    const e = await expectCode(store.rollback(meta(), store.select({ agentId: 'a1', session: 's1' })), 'CONFLICT')
    expect(e.data?.conflicts).toEqual([expect.objectContaining({ reason: 'changed_between' })])
  })

  it('新建的文件被人删了又建：也算冲突', async () => {
    await op(['n.txt'], () => write('n.txt', 'ai'))
    write('n.txt', 'human')
    await expectCode(store.rollback(meta(), store.select({ agentId: 'a1', session: 's1' })), 'CONFLICT')
    expect(read('n.txt')).toBe('human')
  })

  it('dry_run 只返回计划，不动文件', async () => {
    write('a.txt', '0')
    await op(['a.txt'], () => write('a.txt', '1'))
    const r = await store.rollback(meta(), store.select({ agentId: 'a1', session: 's1' }), { dryRun: true })
    expect(r).toMatchObject({ dry_run: true, files: [{ path: 'a.txt', action: 'restore' }] })
    expect(read('a.txt')).toBe('1')
  })

  it('回滚本身也是检查点，可以再退回去（重做）', async () => {
    write('a.txt', '0')
    await op(['a.txt'], () => write('a.txt', '1'))
    const r = await store.rollback(meta({ tool: 'checkpoint_rollback' }), store.select({ agentId: 'a1', session: 's1' }))
    expect(read('a.txt')).toBe('0')
    const rb = 'checkpoint' in r ? r.checkpoint! : ''
    await store.rollback(meta({ tool: 'checkpoint_rollback' }), store.select({ agentId: 'a1', fromStep: rb }))
    expect(read('a.txt')).toBe('1')
    // 重做后原来的修改又算「未回滚」，汇总里重新出现
    const sum = await store.summary(store.select({ agentId: 'a1', session: 's1' }))
    expect(sum.files.map((f) => f.path)).toEqual(['a.txt'])
  })

  describe('一个文件退过一次以后，更早的那一步也退得了', () => {
    const rb = (r: unknown) => (r as { checkpoint: string }).checkpoint
    const roll = (steps: ReturnType<CheckpointStore['select']>, m: Partial<CheckpointMeta> = {}) =>
      store.rollback(meta({ tool: 'checkpoint_rollback', ...m }), steps)

    it('新建、修改；先退修改，再按整个会话退：新建的文件没了', async () => {
      const a = await op(['n.txt'], () => write('n.txt', '1'))
      const b = await op(['n.txt'], () => write('n.txt', '2'))
      await roll(store.select({ agentId: 'a1', fromStep: b!.id, onlyStep: true }))
      expect(read('n.txt')).toBe('1')
      const r = await roll(store.select({ agentId: 'a1', session: 's1' }))
      expect(exists('n.txt')).toBe(false)
      expect(r).toMatchObject({ rolled_back_checkpoints: [a!.id] })
      // 都退完了：再退一次是「没有可退的」，不是冲突
      await expectCode(roll(store.select({ agentId: 'a1', session: 's1' })), 'NOTHING_TO_ROLLBACK')
    })

    it('同样的经过，改成从第一步起退（选中的里面带着那次回滚）：一样退得了，那次回滚不会被当成要重做的', async () => {
      const a = await op(['n.txt'], () => write('n.txt', '1'))
      const b = await op(['n.txt'], () => write('n.txt', '2'))
      await roll(store.select({ agentId: 'a1', fromStep: b!.id, onlyStep: true }))
      const dry = await store.rollback(meta(), store.select({ agentId: 'a1', fromStep: a!.id }), { dryRun: true })
      expect(dry).toMatchObject({ files: [{ path: 'n.txt', action: 'delete' }], checkpoints: [a!.id] })
      await roll(store.select({ agentId: 'a1', fromStep: a!.id }))
      expect(exists('n.txt')).toBe(false)
      // 第二步仍然算「退过了」，汇总里不会冒出来
      expect((await store.summary(store.select({ agentId: 'a1', session: 's1' }))).files).toEqual([])
    })

    it('全退之后还能一步步重做回来', async () => {
      write('a.txt', '0')
      await op(['a.txt'], () => write('a.txt', '1'))
      const b = await op(['a.txt'], () => write('a.txt', '2'))
      const r1 = rb(await roll(store.select({ agentId: 'a1', fromStep: b!.id, onlyStep: true })))
      const r2 = rb(await roll(store.select({ agentId: 'a1', session: 's1' })))
      expect(read('a.txt')).toBe('0')
      // 先重做早的那次回滚会跳过后面那次：报冲突，不写
      await expectCode(roll(store.select({ agentId: 'a1', fromStep: r1, onlyStep: true })), 'CONFLICT')
      expect(read('a.txt')).toBe('0')
      await roll(store.select({ agentId: 'a1', fromStep: r2, onlyStep: true }))
      expect(read('a.txt')).toBe('1')
      await roll(store.select({ agentId: 'a1', fromStep: r1, onlyStep: true }))
      expect(read('a.txt')).toBe('2')
      // 两步都回来了，还能再整个退掉
      await roll(store.select({ agentId: 'a1', session: 's1' }))
      expect(read('a.txt')).toBe('0')
    })

    it('退掉一步之后文件被别的途径改过，后来又有人改又退：报 changed_between，一个字都不写', async () => {
      write('a.txt', '0')
      await op(['a.txt'], () => write('a.txt', '1'))
      const b = await op(['a.txt'], () => write('a.txt', '2'))
      await roll(store.select({ agentId: 'a1', fromStep: b!.id, onlyStep: true }))
      write('a.txt', 'by-command')
      const c = await op(['a.txt'], () => write('a.txt', '3'))
      await roll(store.select({ agentId: 'a1', fromStep: c!.id, onlyStep: true }))
      expect(read('a.txt')).toBe('by-command')
      const e = await expectCode(roll(store.select({ agentId: 'a1', session: 's1' })), 'CONFLICT')
      expect(e.data?.conflicts).toEqual([expect.objectContaining({ path: 'a.txt', reason: 'changed_between' })])
      expect(read('a.txt')).toBe('by-command')
    })

    it('退掉一步之后文件被别的途径改了、没人再动：报 modified_after', async () => {
      write('a.txt', '0')
      await op(['a.txt'], () => write('a.txt', '1'))
      const b = await op(['a.txt'], () => write('a.txt', '2'))
      await roll(store.select({ agentId: 'a1', fromStep: b!.id, onlyStep: true }))
      write('a.txt', 'by-command')
      const e = await expectCode(roll(store.select({ agentId: 'a1', session: 's1' })), 'CONFLICT')
      expect(e.data?.conflicts).toEqual([expect.objectContaining({ path: 'a.txt', reason: 'modified_after' })])
      expect(read('a.txt')).toBe('by-command')
    })

    it('别人改过又自己退掉了：不再挡我退自己的；别人没退掉的照旧挡', async () => {
      write('a.txt', '0')
      await op(['a.txt'], () => write('a.txt', '1'))
      const other = { agentId: 'a2', agentName: '别人', session: 's9' }
      const x = await op(['a.txt'], () => write('a.txt', '2'), other)
      const blocked = await expectCode(roll(store.select({ agentId: 'a1', session: 's1' })), 'CONFLICT')
      expect(blocked.data?.conflicts).toEqual([expect.objectContaining({ reason: 'touched_by_other' })])
      await roll(store.select({ agentId: 'a2', fromStep: x!.id, onlyStep: true }), other)
      expect(read('a.txt')).toBe('1')
      await roll(store.select({ agentId: 'a1', session: 's1' }))
      expect(read('a.txt')).toBe('0')
    })

    it('退过后面的、又接着改：按整个会话退，回到最初', async () => {
      write('a.txt', '0')
      await op(['a.txt'], () => write('a.txt', '1'))
      const b = await op(['a.txt'], () => write('a.txt', '2'))
      await roll(store.select({ agentId: 'a1', fromStep: b!.id, onlyStep: true }))
      await op(['a.txt'], () => write('a.txt', '3'))
      await roll(store.select({ agentId: 'a1', session: 's1' }))
      expect(read('a.txt')).toBe('0')
    })
  })

  it('不能回滚别人的检查点', async () => {
    write('a.txt', '0')
    const s = await op(['a.txt'], () => write('a.txt', '1'), { agentId: 'a2', session: 's2' })
    expect(() => store.select({ agentId: 'a1', fromStep: s!.id })).toThrow(/FORBIDDEN/)
  })

  it('二进制文件原样恢复', async () => {
    const bin = Buffer.from([0, 1, 2, 255, 0, 10])
    fs.writeFileSync(path.join(root, 'b.bin'), bin)
    await op(['b.bin'], () => fs.writeFileSync(path.join(root, 'b.bin'), Buffer.from([9])))
    await store.rollback(meta(), store.select({ agentId: 'a1', session: 's1' }))
    expect(fs.readFileSync(path.join(root, 'b.bin')).equals(bin)).toBe(true)
  })
})

describe('改动汇总', () => {
  it('合并成一份净 diff，给出状态和增删行数', async () => {
    write('a.txt', 'l1\nl2\nl3\n')
    write('d.txt', 'bye\n')
    await op(['a.txt'], () => write('a.txt', 'l1\nL2\nl3\n'))
    await op(['a.txt'], () => write('a.txt', 'l1\nL2\nl3\nl4\n'))
    await op(['n.txt'], () => write('n.txt', 'hi\n'))
    await op(['d.txt'], () => fs.rmSync(path.join(root, 'd.txt')))
    await op(['tmp.txt'], () => write('tmp.txt', 'x'))
    await op(['tmp.txt'], () => fs.rmSync(path.join(root, 'tmp.txt'))) // 建了又删，净变化为零
    const s = await store.summary(store.select({ session: 's1' }), { title: 'T-1' })
    expect(s.files.map((f) => [f.status, f.path, f.additions, f.deletions])).toEqual([
      ['modified', 'a.txt', 2, 1],
      ['deleted', 'd.txt', 0, 1],
      ['added', 'n.txt', 1, 0]
    ])
    expect(s.totals).toMatchObject({ files: 3, additions: 3, deletions: 2, unchanged_after_edits: 1 })
    expect(s.diff).toContain('--- a/a.txt')
    expect(s.diff).toContain('+L2')
    expect(s.diff).toContain('+++ /dev/null')
    expect(s.review_text.split('\n')[0]).toBe('改动汇总（T-1）：3 个文件，+3 -2')
    expect(s.review_text).toContain('- M a.txt (+2 -1)')
  })

  it('按任务筛选，并标出检查点之后被别的途径改过的文件', async () => {
    write('a.txt', '0')
    await op(['a.txt'], () => write('a.txt', '1'), { task: 'T-7' })
    await op(['b.txt'], () => write('b.txt', 'b'), { task: null })
    write('a.txt', '1-human')
    const s = await store.summary(store.select({ task: 't-7' }))
    expect(s.files).toEqual([expect.objectContaining({ path: 'a.txt', changed_outside: true })])
  })

  it('diff 太长会截断', async () => {
    await op(['big.txt'], () => write('big.txt', 'x\n'.repeat(5000)))
    const s = await store.summary(store.select({ session: 's1' }), { maxDiffBytes: 1000 })
    expect(s.diff_truncated).toBe(true)
    expect(Buffer.byteLength(s.diff)).toBeLessThan(1200)
  })

  it('list 按会话分组，新的在前', async () => {
    await op(['a.txt'], () => write('a.txt', '1'))
    await op(['b.txt'], () => write('b.txt', '1'), { session: 's2' })
    const l = store.list({ agentId: 'a1' }, 's2')
    expect(l.sessions.map((s) => [s.session, s.current])).toEqual([
      ['s2', true],
      ['s1', false]
    ])
  })
})
