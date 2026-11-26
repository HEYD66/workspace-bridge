import zlib from 'node:zlib'
import { decode } from './encoding'

/**
 * 只读的最小 zip 解析（导入技能包用）：读中央目录，支持「不压缩」和 deflate 两种方式。
 * 不支持 zip64、加密、分卷。解压出来的大小以中央目录里写的为准，实际解出来不一样就报错（防 zip 炸弹）。
 * 这里不做路径检查：条目名原样返回（只把反斜杠换成 /），越界、绝对路径由调用方判断。
 */

export class ZipError extends Error {}

export interface ZipEntry {
  /** 条目名，/ 分隔；目录条目（以 / 结尾）不返回 */
  name: string
  /** 解压后的字节数 */
  size: number
  /** Unix 下打包的符号链接（内容是链接目标） */
  symlink: boolean
  read(): Buffer
}

export interface ZipLimits {
  maxEntries: number
  /** 全部条目解压后的总字节数上限 */
  maxTotalBytes: number
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 5000, maxTotalBytes: 100 * 1024 * 1024 }

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

export function readZip(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  // 结尾记录固定 22 字节，后面可以跟最长 65535 字节的注释：从后往前找签名
  let eocd = -1
  for (let i = buf.length - 22, stop = Math.max(0, buf.length - 22 - 0xffff); i >= stop; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ZipError('不是 zip 文件（找不到结尾记录）')
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('不支持 zip64（文件太大或条目太多）')
  if (count > limits.maxEntries) throw new ZipError(`zip 里有 ${count} 个条目，超过 ${limits.maxEntries} 个上限`)

  const out: ZipEntry[] = []
  let total = 0
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('zip 的目录损坏')
    const madeBy = buf.readUInt16LE(p + 4)
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const extAttr = buf.readUInt32LE(p + 38)
    const localOffset = buf.readUInt32LE(p + 42)
    if (p + 46 + nameLen > buf.length) throw new ZipError('zip 的目录损坏')
    const nameBuf = buf.subarray(p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen

    // 第 11 位：名字是 UTF-8；没有这一位的多半是系统默认编码（中文 Windows 上是 GBK），交给编码识别
    const name = (flags & 0x800 ? nameBuf.toString('utf8') : decode(Buffer.from(nameBuf)).text).replace(/\\/g, '/')
    if (name.endsWith('/')) continue
    if (flags & 0x1) throw new ZipError(`zip 是加密的，读不了：${name}`)
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError('不支持 zip64（文件太大）')
    if (method !== 0 && method !== 8) throw new ZipError(`不支持的压缩方式（${method}）：${name}`)
    total += size
    if (total > limits.maxTotalBytes) throw new ZipError(`zip 解压后超过 ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB`)

    // 高字节 3 = Unix 打的包，这时外部属性的高 16 位是文件类型和权限
    const symlink = madeBy >>> 8 === 3 && ((extAttr >>> 16) & 0o170000) === 0o120000
    out.push({
      name,
      size,
      symlink,
      read: () => {
        if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new ZipError(`zip 损坏：${name}`)
        const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
        if (start + compSize > buf.length) throw new ZipError(`zip 损坏：${name}`)
        const raw = buf.subarray(start, start + compSize)
        let data: Buffer
        if (method === 0) {
          data = Buffer.from(raw)
        } else {
          try {
            // 最多解出目录里写的那么多字节，实际更多就抛错
            data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) })
          } catch {
            throw new ZipError(`解压失败：${name}`)
          }
        }
        if (data.length !== size) throw new ZipError(`解压出来的大小和 zip 里写的不一样：${name}`)
        if (typeof zlib.crc32 === 'function' && zlib.crc32(data) >>> 0 !== crc) throw new ZipError(`校验不通过，zip 可能损坏：${name}`)
        return data
      }
    })
  }
  return out
}
