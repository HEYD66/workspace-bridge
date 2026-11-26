// T-21：群聊图片界面的纯逻辑（校验、粘贴拖放、发送参数、显示、取图缓存）
import { describe, expect, it, vi } from 'vitest'
import {
  buildSendInput,
  canSend,
  chatImageApi,
  checkImages,
  dataUrlToBlob,
  droppedFiles,
  formatBytes,
  getPendingImages,
  imageActions,
  imagesLabel,
  loadChatImage,
  MAX_IMAGE_BYTES,
  messageImages,
  mimeOf,
  pastedFiles,
  peekChatImage,
  readAsDataUrl,
  setPendingImages,
  thumbBox,
  toPending,
  uploadAll,
  type ChatAttachment,
  type ChatImageApi,
  type PendingImage
} from '../src/renderer/src/lib/chatImages'
import type { GroupMessage } from '../src/core/types'

const f = (name: string, type: string, size: number) => ({ name, type, size })
const att = (id: string, extra: Partial<ChatAttachment> = {}): ChatAttachment => ({ id, kind: 'image', name: `${id}.png`, mime: 'image/png', size: 10, width: 100, height: 50, ...extra })
const msg = (extra: Record<string, unknown> = {}) => ({ id: 'm1', seq: 1, ts: 1, channel: 'ws', from: { kind: 'agent', id: 'a' }, text: '', mentions: [], ...extra }) as unknown as GroupMessage
const item = (kind: string, type: string, file: File | null = null) => ({ kind, type, getAsFile: () => file })

describe('chatImageApi 能力检测', () => {
  it('两个方法都在才算能传图', () => {
    expect(chatImageApi(undefined)).toBeNull()
    expect(chatImageApi({ uploadChatImage: () => 0 })).toBeNull()
    const b = { uploadChatImage: async () => att('x'), chatImage: async () => 'data:image/png;base64,' }
    expect(chatImageApi(b)).toBe(b)
  })
})

describe('checkImages 本地校验', () => {
  it('收下四种格式，没有 type 时按扩展名认', () => {
    const r = checkImages([f('a.png', 'image/png', 1), f('b.JPG', '', 2), f('c.webp', 'image/webp', 3)], 0)
    expect(r.ok.map((x) => x.name)).toEqual(['a.png', 'b.JPG', 'c.webp'])
    expect(r.errors).toEqual([])
    expect(mimeOf(f('b.JPG', '', 2))).toBe('image/jpeg')
  })
  it('格式不对、超过 5 MB、空文件各报一条', () => {
    const r = checkImages([f('x.svg', 'image/svg+xml', 5), f('big.png', 'image/png', MAX_IMAGE_BYTES + 1), f('e.png', 'image/png', 0)], 0)
    expect(r.ok).toEqual([])
    expect(r.errors).toHaveLength(3)
    expect(r.errors[0]).toContain('不是 PNG')
    expect(r.errors[1]).toContain('5.0 MB')
    expect(r.errors[2]).toContain('空文件')
  })
  it('刚好 5 MB 可以', () => {
    expect(checkImages([f('a.png', 'image/png', MAX_IMAGE_BYTES)], 0).ok).toHaveLength(1)
  })
  it('最多 4 张，算上已选的，多出的合并报一条', () => {
    const many = [1, 2, 3, 4].map((i) => f(`${i}.png`, 'image/png', 1))
    const r = checkImages(many, 2)
    expect(r.ok.map((x) => x.name)).toEqual(['1.png', '2.png'])
    expect(r.errors).toEqual(['一条消息最多 4 张图片，多出的 2 张没加上'])
  })
})

describe('粘贴和拖放', () => {
  const png = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })
  it('拖进来的只取文件', () => {
    expect(droppedFiles({ items: [item('string', 'text/uri-list'), item('file', 'image/png', png)] })).toEqual([png])
    expect(droppedFiles({ files: [png] })).toEqual([png])
    expect(droppedFiles(null)).toEqual([])
  })
  it('纯截图粘贴成图片', () => {
    expect(pastedFiles({ items: [item('file', 'image/png', png)] })).toEqual([png])
  })
  it('剪贴板里有纯文字时当成粘贴文字（表格复制会顺带截图）', () => {
    expect(pastedFiles({ items: [item('string', 'text/plain'), item('file', 'image/png', png)] })).toEqual([])
  })
  it('只有文字时不拦', () => {
    expect(pastedFiles({ items: [item('string', 'text/plain')] })).toEqual([])
  })
})

describe('读文件和 data URL', () => {
  it('readAsDataUrl 和 dataUrlToBlob 来回一致', async () => {
    const bytes = new Uint8Array(70000).map((_, i) => i % 251)
    const url = await readAsDataUrl(new Blob([bytes]), 'image/png')
    expect(url.startsWith('data:image/png;base64,')).toBe(true)
    const back = dataUrlToBlob(url)
    expect(back.type).toBe('image/png')
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(bytes)
  })
  it('dataUrlToBlob 不认别的字符串', () => {
    expect(() => dataUrlToBlob('http://x/a.png')).toThrow()
  })
  it('toPending 没名字时补一个，key 不重复', async () => {
    const a = await toPending(new File([new Uint8Array([1, 2])], '', { type: 'image/jpeg' }))
    const b = await toPending(new File([new Uint8Array([1])], 'b.png', { type: 'image/png' }))
    expect(a.name).toBe('图片.jpg')
    expect(a.size).toBe(2)
    expect(a.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(a.key).not.toBe(b.key)
  })
  it('formatBytes', () => {
    expect(formatBytes(500)).toBe('500 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

describe('发送', () => {
  it('有文字或有图就能发', () => {
    expect(canSend('  ', 0)).toBe(false)
    expect(canSend('hi', 0)).toBe(true)
    expect(canSend('', 1)).toBe(true)
  })
  it('没有图片时参数和以前一样，有图片才带 attachments', () => {
    const base = { channel: 'ws', text: 'hi', replyTo: 'm0' }
    expect(buildSendInput(base, [])).toEqual(base)
    expect('attachments' in buildSendInput(base, [])).toBe(false)
    expect(buildSendInput(base, [att('a')])).toEqual({ ...base, attachments: [att('a')] })
  })
  it('uploadAll 按顺序上传，失败时报是哪张', async () => {
    const p = (name: string): PendingImage => ({ key: name, name, mime: 'image/png', size: 1, dataUrl: 'data:image/png;base64,AA==' })
    const calls: string[] = []
    const api: ChatImageApi = {
      uploadChatImage: async (_d, name) => {
        calls.push(name)
        if (name === 'bad.png') throw new Error('磁盘满了')
        return att(name)
      },
      chatImage: async () => ''
    }
    expect((await uploadAll(api, [p('a.png'), p('b.png')])).map((x) => x.id)).toEqual(['a.png', 'b.png'])
    await expect(uploadAll(api, [p('c.png'), p('bad.png'), p('d.png')])).rejects.toThrow('「bad.png」上传失败：磁盘满了')
    expect(calls).toEqual(['a.png', 'b.png', 'c.png', 'bad.png'])
  })
})

describe('显示', () => {
  it('messageImages 只取合法的图片附件，没有字段当空', () => {
    expect(messageImages(msg())).toEqual([])
    expect(messageImages(msg({ attachments: 'x' }))).toEqual([])
    expect(messageImages(msg({ attachments: [att('a'), null, { kind: 'file', id: 'f' }, { kind: 'image' }] }))).toEqual([att('a')])
  })
  it('imagesLabel', () => {
    expect(imagesLabel(0)).toBe('')
    expect(imagesLabel(1)).toBe('[图片]')
    expect(imagesLabel(3)).toBe('[图片×3]')
  })
  it('thumbBox 等比缩进框里，小图不放大，没宽高给固定框', () => {
    expect(thumbBox(1200, 600)).toEqual({ width: 240, height: 120 })
    expect(thumbBox(400, 900)).toEqual({ width: 80, height: 180 })
    expect(thumbBox(50, 40)).toEqual({ width: 50, height: 40 })
    expect(thumbBox(null, null)).toEqual({ width: 160, height: 120 })
    expect(thumbBox(10000, 10)).toEqual({ width: 240, height: 24 })
  })
  it('imageActions：没取到图全灰，剪贴板不支持只灰复制', () => {
    const none = imageActions(undefined, true)
    expect(none.open && none.copy && none.save).toBeTruthy()
    expect(imageActions('data:image/png;base64,', true)).toEqual({ open: false, copy: false, save: false })
    const noClip = imageActions('data:image/png;base64,', false)
    expect(noClip.copy).toBeTruthy()
    expect(noClip.save).toBe(false)
  })
})

describe('待发送图片按频道分开', () => {
  it('切频道不串，清空后是同一个空数组', () => {
    const p: PendingImage = { key: 'k', name: 'a.png', mime: 'image/png', size: 1, dataUrl: 'data:image/png;base64,AA==' }
    setPendingImages('ws1', [p])
    expect(getPendingImages('ws1')).toEqual([p])
    expect(getPendingImages('ws2')).toEqual([])
    setPendingImages('ws1', [])
    expect(getPendingImages('ws1')).toBe(getPendingImages('ws2'))
  })
})

describe('loadChatImage 取图缓存', () => {
  it('同一张只取一次，取到后 peek 能同步拿到', async () => {
    const chatImage = vi.fn(async () => 'data:image/png;base64,AA==')
    const api: ChatImageApi = { uploadChatImage: async () => att('x'), chatImage }
    expect(peekChatImage('c1')).toBeUndefined()
    const [a, b] = await Promise.all([loadChatImage(api, 'c1'), loadChatImage(api, 'c1')])
    expect(a).toBe(b)
    expect(chatImage).toHaveBeenCalledTimes(1)
    expect(peekChatImage('c1')).toBe(a)
  })
  it('取失败或返回的不是图片就报错，下次重取', async () => {
    let n = 0
    const api: ChatImageApi = { uploadChatImage: async () => att('x'), chatImage: async () => (++n === 1 ? 'data:text/html,<b>' : 'data:image/gif;base64,R0lG') }
    await expect(loadChatImage(api, 'c2')).rejects.toThrow('图片已失效')
    expect(peekChatImage('c2')).toBeUndefined()
    await new Promise((r) => setTimeout(r, 0))
    await expect(loadChatImage(api, 'c2')).resolves.toBe('data:image/gif;base64,R0lG')
  })
  it('没接口时直接失败', async () => {
    await expect(loadChatImage(null, 'c3')).rejects.toThrow('还没接上')
  })
})
