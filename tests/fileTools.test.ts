import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import iconv from 'iconv-lite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileTools, globMatcher } from '../src/core/fileTools'
import { PathGuard } from '../src/core/pathGuard'

let base: string
let root: string
let trash: string
let t: FileTools

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ft-'))
  root = path.join(base, 'ws')
  trash = path.join(base, 'trash')
  fs.mkdirSync(root)
  t = new FileTools(new PathGuard(root), trash)
})

afterEach(() => fs.rmSync(base, { recursive: true, force: true }))

const write = (rel: string, data: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), data)
}
const raw = (rel: string) => fs.readFileSync(path.join(root, rel))

describe('读写与版本', () => {
  it('新建文件无需版本，覆盖已有文件必须带版本', async () => {
    const r = await t.writeFile('a/b.txt', 'hello')
    expect(r.created).toBe(true)
    await expect(t.writeFile('a/b.txt', 'x')).rejects.toThrow(/VERSION_REQUIRED/)
    const read = await t.readFile('a/b.txt')
    expect(read.version).toBe(r.version)
    const r2 = await t.writeFile('a/b.txt', 'world', read.version)
    expect(raw('a/b.txt').toString()).toBe('world')
    expect(r2.diff).toContain('-hello')
    expect(r2.diff).toContain('+world')
  })

  it('版本过期返回 CONFLICT', async () => {
    write('f.txt', 'v1')
    const { version } = await t.readFile('f.txt')
    write('f.txt', 'v2-by-someone-else')
    await expect(t.writeFile('f.txt', 'mine', version)).rejects.toThrow(/CONFLICT/)
    await expect(t.editFile('f.txt', [{ old_string: 'v2', new_string: 'v3' }], version)).rejects.toThrow(/CONFLICT/)
  })

  it('分段读取', async () => {
    write('long.txt', Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n'))
    const r = await t.readFile('long.txt', 3, 2)
    expect(r.content).toBe('line3\nline4')
    expect(r.truncated).toBe(true)
    expect(r.totalLines).toBe(10)
  })

  it('以换行结尾的文件不多算一行；offset 超出末尾明确报错', async () => {
    write('nl.txt', 'a\nb\nc\n')
    const r = await t.readFile('nl.txt')
    expect(r.totalLines).toBe(3)
    expect(r.content).toBe('a\nb\nc')
    expect(r.truncated).toBe(false)
    write('crlf.txt', 'a\r\nb\r\n')
    expect((await t.readFile('crlf.txt')).totalLines).toBe(2)
    await expect(t.readFile('nl.txt', 4)).rejects.toThrow(/INVALID_ARGS|超出文件末尾/)
    await expect(t.readFile('nl.txt', 70000)).rejects.toThrow(/一共 3 行/)
    expect((await t.readFile('nl.txt', 3)).content).toBe('c')
    // 空文件 offset=1 仍然正常
    write('empty.txt', '')
    expect((await t.readFile('empty.txt')).content).toBe('')
  })

  it('可选行号使用文件里的真实行号，保留空行、缩进和 CRLF 元信息', async () => {
    write('numbered.txt', 'first\r\n\r\n  中文\r\nlast\r\n')
    const plain = await t.readFile('numbered.txt', 2, 2)
    const numbered = await t.readFile('numbered.txt', 2, 2, { lineNumbers: true })
    expect(numbered.content).toBe('2\t\n3\t  中文')
    expect(numbered).toMatchObject({ startLine: 2, endLine: 3, totalLines: 4, nextStartLine: 4, hasMore: true, eol: 'CRLF', version: plain.version })
    expect(await t.readFile('numbered.txt', 2, 2, { lineNumbers: false })).toEqual(plain)
    expect((await t.readFile('numbered.txt', numbered.nextStartLine, 2, { lineNumbers: true })).content).toBe('4\tlast')
    expect(raw('numbered.txt').toString()).toBe('first\r\n\r\n  中文\r\nlast\r\n')
  })

  it('空文件不凭空加行号，但文件中的空行会编号', async () => {
    write('empty.txt', '')
    expect(await t.readFile('empty.txt', 1, 10, { lineNumbers: true })).toEqual(await t.readFile('empty.txt'))
    write('blank.txt', '\n\n')
    expect((await t.readFile('blank.txt', 1, 10, { lineNumbers: true })).content).toBe('1\t\n2\t')
  })

  it('行号计入字节上限，分页继续读取不漏行', async () => {
    write('budget.txt', ('x'.repeat(1023) + '\n').repeat(300))
    const plain = await t.readFile('budget.txt', 1, 300)
    const numbered = await t.readFile('budget.txt', 1, 300, { lineNumbers: true })
    expect(numbered.bytes).toBeLessThanOrEqual(256 * 1024)
    expect(numbered.bytes).toBe(Buffer.byteLength(numbered.content, 'utf8') + 1)
    expect(numbered.endLine).toBeLessThan(plain.endLine)
    expect(numbered.hasMore).toBe(true)
    const next = await t.readFile('budget.txt', numbered.nextStartLine, 300, { lineNumbers: true })
    expect(next.startLine).toBe(numbered.endLine + 1)
    expect(next.endLine).toBe(300)
    expect(next.hasMore).toBe(false)
    expect(next.content.startsWith(`${next.startLine}\tx`)).toBe(true)
  })

  it('超长行截断后仍显示原行号和继续读取位置', async () => {
    write('clipped.txt', 'head\n' + 'x'.repeat(100_000) + '\ntail')
    const numbered = await t.readFile('clipped.txt', 2, 1, { lineNumbers: true })
    expect(numbered.content.startsWith('2\tx')).toBe(true)
    expect(numbered.content).toContain('字符没显示')
    expect(numbered).toMatchObject({ longLinesClipped: true, startLine: 2, endLine: 2, nextStartLine: 3 })
  })

  it.each(['', '\n', '\r\n', 'a', 'a\n', 'a\r\n', 'a\r\n\r\nb\n尾\r', 'a\n\n'])('raw 原样保留文本 %j，默认结果不变', async (text) => {
    write('raw.txt', text)
    const plain = await t.readFile('raw.txt')
    const result = await t.readFile('raw.txt', 1, 100, { raw: true })
    expect(result.content).toBe(text)
    expect(result.bytes).toBe(Buffer.byteLength(text))
    expect(result.version).toBe(plain.version)
    expect(result.totalLines).toBe(plain.totalLines)
    expect(result.longLinesClipped).toBeUndefined()
    expect(await t.readFile('raw.txt', 1, 2000, { raw: false })).toEqual(plain)
    expect(raw('raw.txt').toString()).toBe(text)
  })

  it('raw 分页拼接还原混合换行，末行没有换行不补写', async () => {
    const text = 'one\r\n\r\n三\nfour'
    write('raw.txt', text)
    const first = await t.readFile('raw.txt', 1, 2, { raw: true })
    const next = await t.readFile('raw.txt', first.nextStartLine, 2, { raw: true })
    expect(first.content).toBe('one\r\n\r\n')
    expect(next.content).toBe('三\nfour')
    expect(first.content + next.content).toBe(text)
    expect(next).toMatchObject({ startLine: 3, endLine: 4, hasMore: false })
    await expect(t.readFile('raw.txt', 5, 2, { raw: true })).rejects.toThrow(/超出文件末尾/)
    await expect(t.readFile('raw.txt', 1, 2, { raw: true, lineNumbers: true })).rejects.toThrow(/不能同时/)
  })

  it('raw 字节预算计入 CRLF 和多字节文本，不裁剪或漏掉长行', async () => {
    const text = ('中'.repeat(40000) + '\r\n').repeat(3)
    write('raw.txt', text)
    const first = await t.readFile('raw.txt', 1, 100, { raw: true })
    expect(first.bytes).toBe(240004)
    expect(first).toMatchObject({ endLine: 2, hasMore: true, nextStartLine: 3 })
    const last = await t.readFile('raw.txt', first.nextStartLine, 100, { raw: true })
    expect(first.content + last.content).toBe(text)
    expect(last.longLinesClipped).toBeUndefined()
    write('huge-line.txt', 'x'.repeat(256 * 1024) + '\n')
    await expect(t.readFile('huge-line.txt', 1, 1, { raw: true })).rejects.toThrow(/原文模式/)
    expect((await t.readFile('huge-line.txt')).longLinesClipped).toBe(true)
  })

  it('raw 返回解码后的文本，BOM 与编码仍由元信息表达', async () => {
    write('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中\r\n')]))
    const result = await t.readFile('bom.txt', 1, 100, { raw: true })
    expect(result).toMatchObject({ encoding: 'utf8-bom', eol: 'CRLF', content: '中\r\n', bytes: 5 })
  })

  it('search：最后一行的 context_after 不再多出空行；超大文件列出被跳过的路径', async () => {
    write('s.txt', 'x\nneedle\n')
    write('big.log', 'y'.repeat(2 * 1024 * 1024 + 10))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = await t.search({ query: 'needle', contextLines: 2 })
    const hit = r.results.find((e: { path: string }) => e.path.endsWith('s.txt'))
    expect(hit.context_before).toEqual(['x'])
    expect(hit.context_after).toBeUndefined()
    expect(r.skipped_large_files).toBe(1)
    expect(r.skipped_large_paths).toEqual(['big.log'])
  })

  it('search：path 指到单个文件时只搜这一个文件（两种引擎结果一样）；文件名搜索也认；不存在的路径是 0 条', async () => {
    write('src/a.ts', 'const needle = 1\nother\nneedle again\n')
    write('src/b.ts', 'needle in b\n')
    write('src/sub/a.ts', 'needle deep\n')
    const saved = process.env.WB_RG_PATH
    try {
      for (const engine of ['default', 'bridge']) {
        if (engine === 'bridge') process.env.WB_RG_PATH = 'none'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r: any = await t.search({ query: 'needle', path: 'src/a.ts' })
        expect({ engine, hits: r.results.map((e: { path: string; line: number }) => `${e.path}:${e.line}`) }).toEqual({ engine, hits: ['src/a.ts:1', 'src/a.ts:3'] })
        if (engine === 'bridge') expect(r.engine).toBe('bridge')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx: any = await t.search({ query: 'other', path: 'src/a.ts', contextLines: 1 })
        expect(ctx.results).toMatchObject([{ path: 'src/a.ts', line: 2, context_before: ['const needle = 1'], context_after: ['needle again'] }])
        // 目录照旧
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dir: any = await t.search({ query: 'needle', path: 'src' })
        expect(new Set(dir.results.map((e: { path: string }) => e.path))).toEqual(new Set(['src/a.ts', 'src/b.ts', 'src/sub/a.ts']))
        expect((await t.search({ query: 'needle', path: 'src/none.ts' })).results).toEqual([])
      }
    } finally {
      if (saved === undefined) delete process.env.WB_RG_PATH
      else process.env.WB_RG_PATH = saved
    }
    expect((await t.search({ query: 'a', path: 'src/a.ts', mode: 'name' })).results).toEqual([{ path: 'src/a.ts' }])
  })

  it('拒绝二进制文件', async () => {
    write('img.bin', Buffer.from([0x89, 0x50, 0x00, 0x01]))
    await expect(t.readFile('img.bin')).rejects.toThrow(/BINARY_FILE/)
  })
})

describe('编码与换行', () => {
  it('GBK 文件读出正确中文，编辑后仍是 GBK', async () => {
    write('gbk.txt', iconv.encode('你好，世界\n第二行', 'gbk'))
    const r = await t.readFile('gbk.txt')
    expect(r.encoding).toBe('gb18030')
    expect(r.content).toBe('你好，世界\n第二行')
    await t.editFile('gbk.txt', [{ old_string: '世界', new_string: '工作区' }])
    expect(iconv.decode(raw('gbk.txt'), 'gbk')).toBe('你好，工作区\n第二行')
  })

  it('保留 UTF-8 BOM 和 CRLF', async () => {
    write('crlf.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\nc', 'utf8')]))
    // AI 给的 old_string 通常是 LF，跨行也要能匹配
    await t.editFile('crlf.txt', [{ old_string: 'a\nb', new_string: 'A\nB' }])
    const out = raw('crlf.txt')
    expect([...out.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(out.subarray(3).toString()).toBe('A\r\nB\r\nc')
  })
})

describe('edit_file', () => {
  it('不唯一时报 AMBIGUOUS，replace_all 可全部替换', async () => {
    write('x.ts', 'foo foo bar')
    await expect(t.editFile('x.ts', [{ old_string: 'foo', new_string: 'baz' }])).rejects.toThrow(/AMBIGUOUS/)
    const r = await t.editFile('x.ts', [{ old_string: 'foo', new_string: 'baz', replace_all: true }])
    expect(r.replacements).toBe(2)
    expect(raw('x.ts').toString()).toBe('baz baz bar')
  })

  it('任一处失败则整体不写入', async () => {
    write('y.ts', 'one two')
    await expect(
      t.editFile('y.ts', [
        { old_string: 'one', new_string: '1' },
        { old_string: 'missing', new_string: '?' }
      ])
    ).rejects.toThrow(/NOT_FOUND/)
    expect(raw('y.ts').toString()).toBe('one two')
  })

  it('new_string 中的 $ 不被当作替换模式', async () => {
    write('z.ts', 'price')
    await t.editFile('z.ts', [{ old_string: 'price', new_string: "$& $1 $$" }])
    expect(raw('z.ts').toString()).toBe('$& $1 $$')
  })
})

describe('目录、搜索、删除', () => {
  it('列目录不再隐藏凭据文件', async () => {
    write('.env', 'SECRET=1')
    write('src/a.ts', '')
    const r = await t.listDir('.')
    expect(r.entries.map((e) => e.name).sort()).toEqual(['.env', 'src'])
  })

  it('内容搜索能搜到凭据文件，跳过 .git 和 node_modules', async () => {
    write('src/a.ts', 'const needle = 1')
    write('.env', 'needle=secret')
    write('.git/config', 'needle in git')
    write('node_modules/pkg/index.js', 'needle')
    const r = await t.search({ query: 'needle' })
    expect(r.results.map((x) => x.path).sort()).toEqual(['.env', 'src/a.ts'])
  })

  it('glob 过滤', () => {
    expect(globMatcher('*.ts')('src/deep/a.ts')).toBe(true)
    expect(globMatcher('src/**/*.md')('src/a/b/c.md')).toBe(true)
    expect(globMatcher('src/*.md')('src/a/c.md')).toBe(false)
  })

  it('删除进回收站并记录原路径', async () => {
    write('del/me.txt', 'bye')
    const r = await t.delete('del/me.txt')
    expect(fs.existsSync(path.join(root, 'del/me.txt'))).toBe(false)
    const manifest = JSON.parse(fs.readFileSync(path.join(trash, r.trashId, 'manifest.json'), 'utf8'))
    expect(manifest.originalPath).toBe('del/me.txt')
    expect(fs.readFileSync(path.join(trash, r.trashId, 'me.txt'), 'utf8')).toBe('bye')
  })

  it('不能删除或移动工作区根目录', async () => {
    await expect(t.delete('.')).rejects.toThrow(/INVALID_ARGS/)
    await expect(t.move('.', 'x')).rejects.toThrow(/INVALID_ARGS/)
  })

  it('移动时目标存在需 overwrite', async () => {
    write('m1.txt', '1')
    write('m2.txt', '2')
    await expect(t.move('m1.txt', 'm2.txt')).rejects.toThrow(/ALREADY_EXISTS/)
    await t.move('m1.txt', 'm2.txt', undefined, true)
    expect(raw('m2.txt').toString()).toBe('1')
  })
})
