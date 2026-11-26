// 优化第 2 条：群聊传图片。图片按内容哈希存在 Bridge 数据目录（chat/attachments）下，消息里只放元信息（ChatAttachment）。
// 只收 png / jpeg / gif / webp（能直接给 AI 看的四种）；svg 可能带脚本，不收。格式靠文件头识别，不信文件名和调用方给的 mime。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ToolError } from './fileTools'
import { sniffImage, VIEWABLE, type ImageFormat } from './imageInfo'

/** 单张图片最大字节数 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
/** 一条消息最多带几张 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 4
/** 文件名最长字数 */
const MAX_NAME_CHARS = 100

const EXT: Partial<Record<ImageFormat, string>> = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp' }
const ID_RE = /^att_[0-9a-f]{24}$/

/** 消息里带的一张图片（只有元信息；图片本身用 id 取） */
export interface ChatAttachment {
  id: string
  kind: 'image'
  /** 显示用的文件名（已清理：去掉路径和控制字符） */
  name: string
  mime: string
  size: number
  width: number | null
  height: number | null
}

/** 清理显示用的文件名：只留最后一段，去掉控制字符，限长；空的按格式起个名字 */
export function cleanAttachmentName(name: unknown, ext: string): string {
  const base = String(name ?? '')
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  const out = base.length > MAX_NAME_CHARS ? base.slice(0, MAX_NAME_CHARS) : base
  return out || `image.${ext}`
}

/**
 * 解析调用方给的 base64：可以是 data URL（data:image/png;base64,...），也可以是纯 base64。
 * 先按长度挡掉明显超限的，免得解码一个巨大的字符串
 */
export function decodeImageBase64(input: unknown): Buffer {
  if (typeof input !== 'string' || !input) throw new ToolError('INVALID_ARGS', '图片内容要是 base64 字符串或 data URL')
  const m = /^data:([^;,]*)(;base64)?,/i.exec(input)
  if (m && !m[2]) throw new ToolError('INVALID_ARGS', 'data URL 要是 base64 编码的')
  const b64 = (m ? input.slice(m[0].length) : input).replace(/\s+/g, '')
  if (b64.length > Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 4) {
    throw new ToolError('TOO_LARGE', `图片不能超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`)
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new ToolError('INVALID_ARGS', '图片内容不是合法的 base64')
  return Buffer.from(b64, 'base64')
}

export class ChatAttachmentStore {
  constructor(private readonly dir: string) {}

  private fileOf(id: string, ext: string): string {
    return path.join(this.dir, `${id}.${ext}`)
  }

  /** 找到这个 id 的文件；id 格式不对（防路径穿越）或不存在返回 undefined */
  private locate(id: string): string | undefined {
    if (typeof id !== 'string' || !ID_RE.test(id)) return undefined
    for (const ext of Object.values(EXT)) {
      const f = this.fileOf(id, ext!)
      if (fs.existsSync(f)) return f
    }
    return undefined
  }

  /**
   * 存一张图片，返回消息里要带的元信息。同样内容只存一份（id 是内容的 SHA-256 前 24 位）。
   * 不是 png / jpeg / gif / webp、空文件、超过大小上限都报错
   */
  save(data: Buffer, name?: string): ChatAttachment {
    if (!Buffer.isBuffer(data) || data.length === 0) throw new ToolError('INVALID_ARGS', '图片是空的')
    if (data.length > MAX_ATTACHMENT_BYTES) throw new ToolError('TOO_LARGE', `图片不能超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB（这张 ${(data.length / 1024 / 1024).toFixed(1)} MB）`)
    const meta = sniffImage(data)
    const ext = meta && VIEWABLE.has(meta.format) ? EXT[meta.format] : undefined
    if (!meta || !ext) throw new ToolError('UNSUPPORTED', '只支持 png、jpeg、gif、webp 图片')
    const id = 'att_' + crypto.createHash('sha256').update(data).digest('hex').slice(0, 24)
    const file = this.fileOf(id, ext)
    if (!fs.existsSync(file)) {
      fs.mkdirSync(this.dir, { recursive: true })
      // 先写临时文件再改名，进程中途退出也不会留下半张图
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
      fs.writeFileSync(tmp, data)
      fs.renameSync(tmp, file)
    } else {
      // 同样内容以前存过：刷新修改时间，免得刚上传、还没发出去就被 gc 当成旧的孤儿删掉
      const t = new Date()
      try {
        fs.utimesSync(file, t, t)
      } catch {
        // 刷新失败不影响这次使用；最坏情况是 gc 清掉后发送时报 NOT_FOUND，重新上传即可
      }
    }
    return { id, kind: 'image', name: cleanAttachmentName(name, ext), mime: meta.mime, size: data.length, width: meta.width, height: meta.height }
  }

  has(id: string): boolean {
    return this.locate(id) !== undefined
  }

  /** 取图片内容；不存在报 NOT_FOUND。读出来再识别一次格式，磁盘上的文件被换掉也不会当成图片发出去 */
  read(id: string): { data: Buffer; mime: string; size: number; width: number | null; height: number | null } {
    const f = this.locate(id)
    if (!f) throw new ToolError('NOT_FOUND', `图片 ${String(id).slice(0, 40)} 不存在（可能已被清理）`)
    const data = fs.readFileSync(f)
    const meta = sniffImage(data)
    if (!meta || !VIEWABLE.has(meta.format)) throw new ToolError('NOT_FOUND', `图片 ${id} 已损坏`)
    return { data, mime: meta.mime, size: data.length, width: meta.width, height: meta.height }
  }

  /**
   * 发消息时核对调用方带的附件：最多 MAX_ATTACHMENTS_PER_MESSAGE 张，每张都要已经存过；
   * 元信息以磁盘上的为准（调用方给的 mime、尺寸不信），只沿用它给的 name。同一张重复带只算一次
   */
  resolve(list: unknown): ChatAttachment[] {
    if (list === undefined || list === null) return []
    if (!Array.isArray(list)) throw new ToolError('INVALID_ARGS', 'attachments 要是数组')
    const seen = new Set<string>()
    const out: ChatAttachment[] = []
    for (const item of list) {
      const id = typeof item === 'string' ? item : (item as { id?: unknown } | null)?.id
      if (typeof id !== 'string') throw new ToolError('INVALID_ARGS', '每个附件要带 id')
      if (seen.has(id)) continue
      seen.add(id)
      const r = this.read(id)
      const ext = r.mime === 'image/jpeg' ? 'jpg' : r.mime.split('/')[1]
      const name = typeof item === 'object' && item ? (item as { name?: unknown }).name : undefined
      out.push({ id, kind: 'image', name: cleanAttachmentName(name, ext), mime: r.mime, size: r.size, width: r.width, height: r.height })
    }
    if (out.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new ToolError('INVALID_ARGS', `一条消息最多带 ${MAX_ATTACHMENTS_PER_MESSAGE} 张图片`)
    return out
  }

  /**
   * 清理：删掉没有任何消息引用、而且比 olderThanMs 更早存进来的图片（上传了没发出去的、消息已归档删掉的）。
   * 返回删了几个文件。referenced 由调用方从现存消息里收集
   */
  gc(referenced: ReadonlySet<string>, olderThanMs: number, now = Date.now()): number {
    if (!fs.existsSync(this.dir)) return 0
    let n = 0
    for (const f of fs.readdirSync(this.dir)) {
      const full = path.join(this.dir, f)
      const m = /^(att_[0-9a-f]{24})\.(png|jpg|gif|webp)$/.exec(f)
      // 中途退出留下的临时文件，过了期限也清掉
      const stale = (p: string) => {
        try {
          return now - fs.statSync(p).mtimeMs > olderThanMs
        } catch {
          return false
        }
      }
      if (m ? !referenced.has(m[1]) && stale(full) : f.endsWith('.tmp') && stale(full)) {
        try {
          fs.unlinkSync(full)
          n++
        } catch {
          // 正在被读之类的，下次再清
        }
      }
    }
    return n
  }
}

/** 通知、纯文本摘要里代替图片的文字，比如「[图片×2]」 */
export function attachmentsLabel(list: readonly ChatAttachment[] | undefined): string {
  return list && list.length ? `[图片×${list.length}]` : ''
}
