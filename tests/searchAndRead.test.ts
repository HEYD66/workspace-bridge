// F5：search 的 smart-case / 上下文行 / 每文件上限 / include-exclude，find_files，read_file 的字节预算，read_files 批量
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileTools } from '../src/core/fileTools'
import { PathGuard } from '../src/core/pathGuard'

let base: string
let root: string
let t: FileTools

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-f5-'))
  root = path.join(base, 'ws')
  fs.mkdirSync(root)
  t = new FileTools(new PathGuard(root), path.join(base, 'trash'))
})

afterEach(() => fs.rmSync(base, { recursive: true, force: true }))

const write = (rel: string, data: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), data)
}

describe('search：smart-case', () => {
  it('不传 case_sensitive 时，模式里有大写就区分大小写', async () => {
    write('a.txt', 'Foo\nfoo\nFOO\n')
    const upper = await t.search({ query: 'Foo' })
    expect(upper.results.map((r) => r.line)).toEqual([1])
    const lower = await t.search({ query: 'foo' })
    expect(lower.results.map((r) => r.line)).toEqual([1, 2, 3])
    // 明确传 false 时即使有大写也不区分
    const forced = await t.search({ query: 'Foo', caseSensitive: false })
    expect(forced.results.map((r) => r.line)).toEqual([1, 2, 3])
  })
})

describe('search：上限和截断原因', () => {
  it('max_matches_per_file 卡住单个文件，并给出 truncated_reason', async () => {
    write('many.txt', Array.from({ length: 5 }, () => 'x').join('\n'))
    const r = await t.search({ query: 'x', maxMatchesPerFile: 2 })
    expect(r.results).toHaveLength(2)
    expect(r.truncated).toBe(true)
    expect(r.truncated_reason).toBe('max_matches_per_file')
  })

  it('max_results 卡住总数', async () => {
    write('many.txt', Array.from({ length: 10 }, () => 'x').join('\n'))
    const r = await t.search({ query: 'x', maxResults: 3 })
    expect(r.results).toHaveLength(3)
    expect(r.truncated_reason).toBe('max_results')
  })

  it('默认单文件只给 20 处', async () => {
    write('many.txt', Array.from({ length: 30 }, () => 'x').join('\n'))
    const r = await t.search({ query: 'x' })
    expect(r.results).toHaveLength(20)
    expect(r.truncated_reason).toBe('max_matches_per_file')
  })
})

describe('search：上下文行', () => {
  it('context_lines 带回前后原文，边界不外溢', async () => {
    write('c.txt', 'zero\none\nneedle\nthree\nfour\n')
    const r = await t.search({ query: 'needle', contextLines: 1 })
    expect(r.results).toHaveLength(1)
    expect(r.results[0].context_before).toEqual(['one'])
    expect(r.results[0].context_after).toEqual(['three'])

    const top = await t.search({ query: 'zero', contextLines: 2 })
    expect(top.results[0].context_before).toBeUndefined()
    expect(top.results[0].context_after).toEqual(['one', 'needle'])
  })

  it('context_lines 超过 5 会被夹到 5', async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `l${i}`)
    lines[6] = 'needle'
    write('d.txt', lines.join('\n'))
    const r = await t.search({ query: 'needle', contextLines: 99 })
    expect(r.results[0].context_before).toHaveLength(5)
    expect(r.results[0].context_after).toHaveLength(5)
  })
})

describe('search：include / exclude', () => {
  it('数组形式的 include 只留匹配的文件，exclude 排掉', async () => {
    write('a.ts', 'needle\n')
    write('b.md', 'needle\n')
    write('c.min.js', 'needle\n')
    const onlyTs = await t.search({ query: 'needle', include: ['*.ts'] })
    expect(onlyTs.results.map((r) => r.path)).toEqual(['a.ts'])

    const noJs = await t.search({ query: 'needle', exclude: ['*.min.js'] })
    expect(noJs.results.map((r) => r.path).sort()).toEqual(['a.ts', 'b.md'])
  })
})

describe('find_files', () => {
  it('glob 和文件名子串都能用', async () => {
    write('a.ts', 'x')
    write('sub/b.ts', 'x')
    write('sub/c.md', 'x')
    const glob = await t.findFiles({ pattern: '*.ts' })
    expect(glob.files.map((f) => f.path).sort()).toEqual(['a.ts', 'sub/b.ts'])

    const needle = await t.findFiles({ pattern: 'b' })
    expect(needle.files.map((f) => f.path)).toEqual(['sub/b.ts'])
  })

  it('max_results 卡住并标 truncated', async () => {
    for (let i = 0; i < 5; i++) write(`f${i}.txt`, 'x')
    const r = await t.findFiles({ pattern: '*.txt', maxResults: 2 })
    expect(r.files).toHaveLength(2)
    expect(r.truncated).toBe(true)
    expect(r.truncated_reason).toBe('max_results')
  })

  it('只走目录不返回目录本身，带 size 和 mtime', async () => {
    write('sub/a.ts', 'hello')
    const r = await t.findFiles({ pattern: '*' })
    expect(r.files.map((f) => f.path)).toEqual(['sub/a.ts'])
    expect(r.files[0].size).toBe(5)
    expect(typeof r.files[0].mtime).toBe('string')
  })
})

describe('read_file：字节预算', () => {
  it('超过 256 KB 按行截断，给 next_start_line 和 has_more', async () => {
    const line = 'x'.repeat(200)
    write('big.txt', Array.from({ length: 4000 }, () => line).join('\n'))
    const r = await t.readFile('big.txt')
    expect(r.bytes).toBeLessThanOrEqual(256 * 1024)
    expect(r.hasMore).toBe(true)
    expect(r.nextStartLine).toBe(r.endLine + 1)
    expect(r.endLine).toBeLessThan(r.totalLines)
  })

  it('接着读能把后面的内容读回来，最后一页 has_more=false', async () => {
    const line = 'x'.repeat(200)
    write('big.txt', Array.from({ length: 4000 }, () => line).join('\n'))
    const first = await t.readFile('big.txt')
    const second = await t.readFile('big.txt', first.nextStartLine!, 50)
    expect(second.startLine).toBe(first.endLine + 1)
    expect(second.content.startsWith('x')).toBe(true)

    const tail = await t.readFile('big.txt', 3990, 100)
    expect(tail.hasMore).toBe(false)
    expect(tail.nextStartLine).toBeUndefined()
  })

  it('超长行切一段并标注', async () => {
    write('long.txt', 'y'.repeat(5000))
    const r = await t.readFile('long.txt')
    expect(r.longLinesClipped).toBe(true)
    expect(r.content).toContain('这一行还有')
    expect(r.content.length).toBeLessThan(5000)
  })

  it('普通小文件行为不变', async () => {
    write('small.txt', 'a\nb\nc')
    const r = await t.readFile('small.txt')
    expect(r.content).toBe('a\nb\nc')
    expect(r.hasMore).toBe(false)
    expect(r.totalLines).toBe(3)
  })
})

describe('read_files：批量读', () => {
  it('读回多个文件，读不了的进 errors', async () => {
    write('a.txt', 'AAA')
    write('b.txt', 'BBB')
    const r = await t.readFiles(['a.txt', 'missing.txt', 'b.txt'])
    expect(r.files.map((f) => f.path)).toEqual(['a.txt', 'b.txt'])
    expect(r.files[0].content).toBe('AAA')
    expect(r.errors.map((e) => e.path)).toEqual(['missing.txt'])
    expect(r.errors[0].code).toBe('NOT_FOUND')
    expect(r.skipped).toBe(0)
  })

  it('超过 20 个只读前 20 个，其余算 skipped', async () => {
    for (let i = 0; i < 25; i++) write(`f${i}.txt`, 'x')
    const paths = Array.from({ length: 25 }, (_, i) => `f${i}.txt`)
    const r = await t.readFiles(paths)
    expect(r.files).toHaveLength(20)
    expect(r.skipped).toBe(5)
  })

  it('总字节预算用完后标 budgetExhausted', async () => {
    // 每个文件约 60 KB（300 行 × 200 字符），5 个就超过 256 KB 的总预算；
    // 行不能超过 4000 字符，否则会先被超长行截断，测不到预算这条路径
    const line = 'z'.repeat(200)
    for (let i = 0; i < 5; i++) write(`g${i}.txt`, Array.from({ length: 300 }, () => line).join('\n'))
    const r = await t.readFiles(['g0.txt', 'g1.txt', 'g2.txt', 'g3.txt', 'g4.txt'])
    expect(r.budgetExhausted).toBe(true)
    expect(r.files.length).toBeLessThan(5)
    expect(r.totalBytes).toBeLessThanOrEqual(256 * 1024)
    expect(r.skipped).toBeGreaterThan(0)
  })
})
