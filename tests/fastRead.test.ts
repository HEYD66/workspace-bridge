import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isBinaryExt, readSearchable } from '../src/core/fastRead'
import { SearchService } from '../src/core/search'

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-fastread-'))
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('isBinaryExt', () => {
  it('认常见二进制扩展名，大小写不敏感', () => {
    expect(isBinaryExt('a.dll')).toBe(true)
    expect(isBinaryExt('Pic.PNG')).toBe(true)
    expect(isBinaryExt('m.pyc')).toBe(true)
  })
  it('文本文件、没扩展名、点开头的文件都不算', () => {
    expect(isBinaryExt('a.ts')).toBe(false)
    expect(isBinaryExt('a.svg')).toBe(false)
    expect(isBinaryExt('Makefile')).toBe(false)
    expect(isBinaryExt('.png')).toBe(false)
  })
})

describe('readSearchable', () => {
  it('文本文件原样读回（含 UTF-8 中文）', async () => {
    const f = path.join(dir, 't.txt')
    fs.writeFileSync(f, '你好 world\n')
    const buf = await readSearchable(f, 1024)
    expect(Buffer.isBuffer(buf) && buf.toString('utf8')).toBe('你好 world\n')
  })
  it('超过上限返回 large，空文件、二进制、目录、不存在返回 null', async () => {
    const big = path.join(dir, 'big.txt')
    fs.writeFileSync(big, 'x'.repeat(2000))
    expect(await readSearchable(big, 1000)).toBe('large')
    const empty = path.join(dir, 'empty.txt')
    fs.writeFileSync(empty, '')
    expect(await readSearchable(empty, 1000)).toBeNull()
    const bin = path.join(dir, 'b.txt')
    fs.writeFileSync(bin, Buffer.from([0x41, 0x00, 0x42]))
    expect(await readSearchable(bin, 1000)).toBeNull()
    expect(await readSearchable(dir, 1000)).toBeNull()
    expect(await readSearchable(path.join(dir, 'nope.txt'), 1000)).toBeNull()
  })
  it('比 8KB 大的文本完整读回', async () => {
    const f = path.join(dir, 'long.txt')
    const s = 'line\n'.repeat(10000) + 'END'
    fs.writeFileSync(f, s)
    const buf = await readSearchable(f, 1024 * 1024)
    expect(Buffer.isBuffer(buf) && buf.toString('utf8')).toBe(s)
  })
})

describe('工作台搜索跳过二进制扩展名', () => {
  it('内容里有关键词的 .dll 不出现在结果里，同名关键词的 .ts 能搜到；结果按路径排序', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-fastread-ws-'))
    try {
      fs.writeFileSync(path.join(ws, 'lib.dll'), 'needle_xyz text only')
      for (const n of ['c.ts', 'a.ts', 'b.ts']) fs.writeFileSync(path.join(ws, n), 'const needle_xyz = 1\n')
      const svc = new SearchService({ dataDir: path.join(ws, '.no-data'), roots: () => [{ id: 'w', root: ws }] })
      const r = await svc.search({ query: 'needle_xyz' } as never)
      expect(r.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'c.ts'])
      expect(r.truncated).toBe(false)
    } finally {
      fs.rmSync(ws, { recursive: true, force: true })
    }
  })
})
