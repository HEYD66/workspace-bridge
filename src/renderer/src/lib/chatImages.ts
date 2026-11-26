// T-21（优化第 2 条的界面）：群聊传图片的界面逻辑。纯函数（校验、读文件、拼发送参数）和图片小接口在这里，零件在 components/ChatImages.tsx。
// 接口按 T-19 结果 B.4 约定：uploadChatImage(dataUrl, name) 返回 ChatAttachment，chatImage(id) 返回 data URL，sendGroupChat 多一个 attachments。
// IPC 已接上；保留能力检测，以兼容旧版 preload。
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ChatAttachment } from '../../../core/chatAttachments'
import type { GroupMessage } from '../../../core/types'
import type { BridgeApi, GroupChatSendInput } from '../../../shared/api'

export type { ChatAttachment }

/** 和 core/chatAttachments 的上限一致（那边存的时候还会再核一次） */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_IMAGES = 4
export const IMAGE_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
/** 选图片对话框的 accept */
export const IMAGE_ACCEPT = IMAGE_MIMES.join(',')

const EXT_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

// ========== 接口（能力检测） ==========

export type ChatImageApi = Pick<BridgeApi, 'uploadChatImage' | 'chatImage'>

/** bridge 上两个方法都在才算能传图；IPC 接好以前返回 null（界面据此不显示图片按钮） */
export function chatImageApi(bridge: unknown = typeof window === 'undefined' ? undefined : window.bridge): ChatImageApi | null {
  const b = bridge as Partial<ChatImageApi> | undefined
  if (!b || typeof b.uploadChatImage !== 'function' || typeof b.chatImage !== 'function') return null
  return b as ChatImageApi
}

// ========== 选图、校验、读文件 ==========

/** 输入框里待发送的一张图（发送时才上传） */
export interface PendingImage {
  key: string
  name: string
  mime: string
  size: number
  dataUrl: string
}

export interface FileLike {
  name: string
  type: string
  size: number
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 文件的 mime：浏览器没给时按扩展名猜 */
export function mimeOf(f: FileLike): string {
  if (f.type) return f.type.toLowerCase()
  const ext = /\.([a-z0-9]+)$/i.exec(f.name)?.[1]?.toLowerCase()
  return (ext && EXT_MIME[ext]) || ''
}

/** 本地先查格式、大小、张数。existing：输入框里已经有几张。返回收下的和每条提示 */
export function checkImages<T extends FileLike>(files: readonly T[], existing: number): { ok: T[]; errors: string[] } {
  const ok: T[] = []
  const errors: string[] = []
  let over = 0
  for (const f of files) {
    const name = f.name || '图片'
    if (!IMAGE_MIMES.includes(mimeOf(f))) errors.push(`「${name}」不是 PNG、JPEG、GIF 或 WebP 图片`)
    else if (f.size > MAX_IMAGE_BYTES) errors.push(`「${name}」有 ${formatBytes(f.size)}，单张最大 5 MB`)
    else if (f.size <= 0) errors.push(`「${name}」是空文件`)
    else if (existing + ok.length >= MAX_IMAGES) over++
    else ok.push(f)
  }
  if (over) errors.push(`一条消息最多 ${MAX_IMAGES} 张图片，多出的 ${over} 张没加上`)
  return { ok, errors }
}

interface ItemLike {
  kind: string
  type: string
  getAsFile(): File | null
}
interface TransferLike {
  items?: ArrayLike<ItemLike> | null
  files?: ArrayLike<File> | null
}

/** 拖进来的文件（格式交给 checkImages 提示） */
export function droppedFiles(dt: TransferLike | null | undefined): File[] {
  if (!dt) return []
  if (dt.items && dt.items.length) {
    const out: File[] = []
    for (const it of Array.from(dt.items)) {
      if (it.kind !== 'file') continue
      const f = it.getAsFile()
      if (f) out.push(f)
    }
    return out
  }
  return dt.files ? Array.from(dt.files) : []
}

/** 粘贴进来的文件。剪贴板里同时有纯文字时（比如从表格复制，会顺带一张截图）当成粘贴文字，返回空 */
export function pastedFiles(dt: TransferLike | null | undefined): File[] {
  if (!dt?.items) return droppedFiles(dt)
  const items = Array.from(dt.items)
  if (items.some((it) => it.kind === 'string' && it.type === 'text/plain')) return []
  return droppedFiles(dt)
}

/** 读成 data URL（不依赖 FileReader，测试里也能跑） */
export async function readAsDataUrl(blob: Blob, mime: string = blob.type): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${mime || 'application/octet-stream'};base64,${btoa(bin)}`
}

let pendingSeq = 0

export async function toPending(file: File): Promise<PendingImage> {
  const mime = mimeOf(file)
  const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1] || 'png'
  return { key: `img-${Date.now().toString(36)}-${++pendingSeq}`, name: file.name || `图片.${ext}`, mime, size: file.size, dataUrl: await readAsDataUrl(file, mime) }
}

/** data URL 转回 Blob（复制、另存为用） */
export function dataUrlToBlob(url: string): Blob {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url)
  if (!m) throw new Error('不是 data URL')
  const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3])
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return new Blob([bytes], { type: m[1] || 'application/octet-stream' })
}

// ========== 发送 ==========

/** 有文字或有图片就能发（只有图片也行） */
export function canSend(text: string, images: number): boolean {
  return text.trim().length > 0 || images > 0
}

export type ImageSendInput = GroupChatSendInput & { channel: string; attachments?: ChatAttachment[] }

/** 拼 sendGroupChat 的参数：没有图片时和原来一模一样（不带 attachments 字段） */
export function buildSendInput(base: GroupChatSendInput & { channel: string }, attachments: readonly ChatAttachment[]): ImageSendInput {
  return attachments.length ? { ...base, attachments: [...attachments] } : { ...base }
}

/** 按顺序上传；哪张失败就报哪张 */
export async function uploadAll(api: ChatImageApi, list: readonly PendingImage[]): Promise<ChatAttachment[]> {
  const out: ChatAttachment[] = []
  for (const p of list) {
    try {
      out.push(await api.uploadChatImage(p.dataUrl, p.name))
    } catch (e) {
      throw new Error(`「${p.name}」上传失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return out
}

// ========== 显示 ==========

/** 消息里的图片（GroupMessage.attachments 由 T-18 接线加上，之前一律当没有） */
export function messageImages(m: GroupMessage): ChatAttachment[] {
  const list = m.attachments
  if (!Array.isArray(list)) return []
  return list.filter((a): a is ChatAttachment => !!a && typeof a === 'object' && (a as ChatAttachment).kind === 'image' && typeof (a as ChatAttachment).id === 'string')
}

/** 只有图片没有文字的消息，在引用、回复条里显示成这个 */
export function imagesLabel(n: number): string {
  return n <= 0 ? '' : n === 1 ? '[图片]' : `[图片×${n}]`
}

/** 缩略图占位大小：按原图宽高等比缩进 maxW×maxH，加载完不跳；没有宽高时给个固定框 */
export function thumbBox(width: number | null | undefined, height: number | null | undefined, maxW = 240, maxH = 180): { width: number; height: number } {
  if (!width || !height || width <= 0 || height <= 0) return { width: Math.min(160, maxW), height: Math.min(120, maxH) }
  const k = Math.min(1, maxW / width, maxH / height)
  return { width: Math.max(24, Math.round(width * k)), height: Math.max(24, Math.round(height * k)) }
}

/** 右键「查看大图 / 复制图片 / 另存为」能不能用；false 能用，字符串是变灰的原因 */
export function imageActions(url: string | undefined, clipboardOk: boolean): { open: false | string; copy: false | string; save: false | string } {
  if (!url) {
    const why = '图片还没加载出来，或者已经失效'
    return { open: why, copy: why, save: why }
  }
  return { open: false, copy: clipboardOk ? false : '这里不支持往剪贴板写图片', save: false }
}

// ========== 待发送的图片（每个频道一份，切频道不丢） ==========

const NONE: PendingImage[] = []
const pending = new Map<string, PendingImage[]>()
const pendingListeners = new Set<() => void>()

export function getPendingImages(ch: string): PendingImage[] {
  return pending.get(ch) ?? NONE
}

export function setPendingImages(ch: string, list: PendingImage[]): void {
  if (list.length) pending.set(ch, list)
  else pending.delete(ch)
  for (const l of pendingListeners) l()
}

function subscribePending(l: () => void): () => void {
  pendingListeners.add(l)
  return () => {
    pendingListeners.delete(l)
  }
}

export function usePendingImages(ch: string): PendingImage[] {
  return useSyncExternalStore(subscribePending, () => getPendingImages(ch), () => getPendingImages(ch))
}

// ========== 取图（带缓存） ==========

/** 最多缓存几张（每张最大 5 MB，别无限涨） */
const CACHE_MAX = 60
const cache = new Map<string, Promise<string>>()
const loaded = new Map<string, string>()

/** 已经取到的图片（右键菜单同步判断用） */
export function peekChatImage(id: string): string | undefined {
  return loaded.get(id)
}

export function loadChatImage(api: ChatImageApi | null, id: string): Promise<string> {
  if (!api) return Promise.reject(new Error('图片接口还没接上'))
  let p = cache.get(id)
  if (!p) {
    p = api.chatImage(id).then((url) => {
      if (typeof url !== 'string' || !url.startsWith('data:image/')) throw new Error('图片已失效')
      loaded.set(id, url)
      return url
    })
    cache.set(id, p)
    p.catch(() => cache.delete(id))
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value as string
      cache.delete(oldest)
      loaded.delete(oldest)
    }
  }
  return p
}

export type ImageState = { status: 'loading' } | { status: 'ok'; url: string } | { status: 'error' }

export function useChatImage(id: string): ImageState {
  const [state, setState] = useState<ImageState>(() => {
    const url = loaded.get(id)
    return url ? { status: 'ok', url } : { status: 'loading' }
  })
  useEffect(() => {
    let alive = true
    const url = loaded.get(id)
    if (url) {
      setState({ status: 'ok', url })
      return
    }
    setState({ status: 'loading' })
    loadChatImage(chatImageApi(), id).then(
      (u) => alive && setState({ status: 'ok', url: u }),
      () => alive && setState({ status: 'error' })
    )
    return () => {
      alive = false
    }
  }, [id])
  return state
}
