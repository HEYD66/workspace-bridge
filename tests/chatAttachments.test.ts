// 优化第 2 条：群聊传图片的存储
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { attachmentsLabel, ChatAttachmentStore, cleanAttachmentName, decodeImageBase64, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from '../src/core/chatAttachments'
import { ToolError } from '../src/core/fileTools'

/** 最小的 PNG 头：签名 + IHDR（宽 w 高 h），后面补点字节让内容不同 */
function png(w: number, h: number, salt = 0): Buffer {
  const b = Buffer.alloc(40)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  b.writeUInt32BE(salt, 36)
  return b
}
const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.from([3, 0, 2, 0]), Buffer.alloc(10)])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

let dir: string
let store: ChatAttachmentStore

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-att-'))
  store = new ChatAttachmentStore(path.join(dir, 'attachments'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
})

function caught(fn: () => unknown): ToolError {
  try {
    fn()
  } catch (e) {
    if (e instanceof ToolError) return e
    throw e
  }
  throw new Error('应该抛错，但没有')
}

describe('存图片', () => {
  it('按文件头识别格式和尺寸，返回元信息；同样内容只存一份', () => {
    const a = store.save(png(640, 480), 'shot.png')
    expect(a).toMatchObject({ kind: 'image', name: 'shot.png', mime: 'image/png', width: 640, height: 480, size: 40 })
    expect(a.id).toMatch(/^att_[0-9a-f]{24}$/)
    const again = store.save(png(640, 480), '另一个名字.png')
    expect(again.id).toBe(a.id)
    expect(again.name).toBe('另一个名字.png')
    expect(fs.readdirSync(path.join(dir, 'attachments'))).toHaveLength(1)
    expect(store.save(GIF).mime).toBe('image/gif')
  })

  it('不信文件名：名字写 .jpg 的 png 照样按 png 存', () => {
    const a = store.save(png(1, 1), 'fake.jpg')
    expect(a.mime).toBe('image/png')
    expect(fs.existsSync(path.join(dir, 'attachments', `${a.id}.png`))).toBe(true)
  })

  it('svg、不是图片、空文件、超过上限都拒绝', () => {
    expect(caught(() => store.save(SVG, 'x.svg')).code).toBe('UNSUPPORTED')
    expect(caught(() => store.save(Buffer.from('hello'))).code).toBe('UNSUPPORTED')
    expect(caught(() => store.save(Buffer.alloc(0))).code).toBe('INVALID_ARGS')
    const big = Buffer.concat([png(1, 1), Buffer.alloc(MAX_ATTACHMENT_BYTES)])
    expect(caught(() => store.save(big)).code).toBe('TOO_LARGE')
    expect(fs.existsSync(path.join(dir, 'attachments')) ? fs.readdirSync(path.join(dir, 'attachments')) : []).toHaveLength(0)
  })

  it('文件名只留最后一段、去掉控制字符、限长，空的给默认名', () => {
    expect(cleanAttachmentName('C:\\Users\\me\\a.png', 'png')).toBe('a.png')
    expect(cleanAttachmentName('../../etc/passwd', 'png')).toBe('passwd')
    expect(cleanAttachmentName('a\u0000b\nc.png', 'png')).toBe('abc.png')
    expect(cleanAttachmentName('', 'jpg')).toBe('image.jpg')
    expect(cleanAttachmentName(undefined, 'gif')).toBe('image.gif')
    expect(cleanAttachmentName('x'.repeat(300), 'png')).toHaveLength(100)
  })
})

describe('取图片', () => {
  it('按 id 读回原内容和格式', () => {
    const a = store.save(png(2, 3))
    const r = store.read(a.id)
    expect(r.data.equals(png(2, 3))).toBe(true)
    expect(r).toMatchObject({ mime: 'image/png', width: 2, height: 3 })
    expect(store.has(a.id)).toBe(true)
  })

  it('id 格式不对（路径穿越之类）或不存在都报 NOT_FOUND', () => {
    for (const bad of ['../config.json', 'att_../../x', 'att_' + '0'.repeat(24), '', 'ATT_' + 'a'.repeat(24)]) {
      expect(caught(() => store.read(bad)).code).toBe('NOT_FOUND')
      expect(store.has(bad)).toBe(false)
    }
  })

  it('磁盘上的文件被换成别的东西：不当图片发出去', () => {
    const a = store.save(png(1, 1))
    fs.writeFileSync(path.join(dir, 'attachments', `${a.id}.png`), SVG)
    expect(caught(() => store.read(a.id)).code).toBe('NOT_FOUND')
  })
})

describe('发消息时核对附件', () => {
  it('元信息以磁盘为准，只沿用调用方给的名字；重复的只算一次；也可以只给 id 字符串', () => {
    const a = store.save(png(10, 20))
    const out = store.resolve([{ id: a.id, name: 'mine.png', mime: 'text/html', width: 9999 }, a.id])
    expect(out).toEqual([{ id: a.id, kind: 'image', name: 'mine.png', mime: 'image/png', size: 40, width: 10, height: 20 }])
    expect(store.resolve([a.id])[0].name).toBe('image.png')
  })

  it('没传是空数组；不是数组、缺 id、不存在、超过张数都报错', () => {
    expect(store.resolve(undefined)).toEqual([])
    expect(store.resolve(null)).toEqual([])
    expect(caught(() => store.resolve('att_x')).code).toBe('INVALID_ARGS')
    expect(caught(() => store.resolve([{}])).code).toBe('INVALID_ARGS')
    expect(caught(() => store.resolve(['att_' + 'f'.repeat(24)])).code).toBe('NOT_FOUND')
    const many = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, i) => store.save(png(1, 1, i + 1)).id)
    expect(caught(() => store.resolve(many)).code).toBe('INVALID_ARGS')
    expect(store.resolve(many.slice(0, MAX_ATTACHMENTS_PER_MESSAGE))).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE)
  })
})

describe('base64 解码', () => {
  it('认 data URL 和纯 base64', () => {
    const b = png(4, 4)
    expect(decodeImageBase64(`data:image/png;base64,${b.toString('base64')}`).equals(b)).toBe(true)
    expect(decodeImageBase64(b.toString('base64')).equals(b)).toBe(true)
    expect(decodeImageBase64(`data:image/png;base64,${b.toString('base64').replace(/(.{10})/g, '$1\n')}`).equals(b)).toBe(true)
  })

  it('不是字符串、不是 base64 的 data URL、非法字符、明显超限都报错（超限不用解码就挡掉）', () => {
    expect(caught(() => decodeImageBase64(123)).code).toBe('INVALID_ARGS')
    expect(caught(() => decodeImageBase64('')).code).toBe('INVALID_ARGS')
    expect(caught(() => decodeImageBase64('data:image/png,abc')).code).toBe('INVALID_ARGS')
    expect(caught(() => decodeImageBase64('abc$%^')).code).toBe('INVALID_ARGS')
    expect(caught(() => decodeImageBase64('A'.repeat(Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 100))).code).toBe('TOO_LARGE')
  })
})

describe('清理', () => {
  it('只删没被引用、而且够旧的图片，以及过期的临时文件', () => {
    const keep = store.save(png(1, 1, 1))
    const orphanOld = store.save(png(1, 1, 2))
    const orphanNew = store.save(png(1, 1, 3))
    const d = path.join(dir, 'attachments')
    const old = (Date.now() - 2 * 3600_000) / 1000
    fs.utimesSync(path.join(d, `${keep.id}.png`), old, old)
    fs.utimesSync(path.join(d, `${orphanOld.id}.png`), old, old)
    fs.writeFileSync(path.join(d, 'x.png.1.abcd.tmp'), 'x')
    fs.utimesSync(path.join(d, 'x.png.1.abcd.tmp'), old, old)
    fs.writeFileSync(path.join(d, 'unrelated.txt'), 'x')
    fs.utimesSync(path.join(d, 'unrelated.txt'), old, old)

    expect(store.gc(new Set([keep.id]), 3600_000)).toBe(2)
    expect(store.has(keep.id)).toBe(true)
    expect(store.has(orphanOld.id)).toBe(false)
    expect(store.has(orphanNew.id)).toBe(true)
    expect(fs.existsSync(path.join(d, 'unrelated.txt'))).toBe(true)
  })

  it('同样内容重新上传会刷新时间，不会刚上传就被当成旧孤儿清掉（maya02 审查意见）', () => {
    const a = store.save(png(1, 1, 9))
    const f = path.join(dir, 'attachments', `${a.id}.png`)
    const old = (Date.now() - 2 * 3600_000) / 1000
    fs.utimesSync(f, old, old)
    store.save(png(1, 1, 9))
    expect(store.gc(new Set(), 3600_000)).toBe(0)
    expect(store.has(a.id)).toBe(true)
  })

  it('目录还不存在时什么都不做', () => {
    expect(new ChatAttachmentStore(path.join(dir, 'none')).gc(new Set(), 0)).toBe(0)
  })
})

describe('摘要文字', () => {
  it('[图片×N]，没有图片是空串', () => {
    expect(attachmentsLabel(undefined)).toBe('')
    expect(attachmentsLabel([])).toBe('')
    expect(attachmentsLabel([{ id: 'a', kind: 'image', name: 'a', mime: 'image/png', size: 1, width: 1, height: 1 }])).toBe('[图片×1]')
  })
})
