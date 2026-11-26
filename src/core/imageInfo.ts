// read_image 用：只靠文件头识别格式和尺寸，不依赖第三方库

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'ico' | 'svg'

export interface ImageMeta {
  format: ImageFormat
  mime: string
  width: number | null
  height: number | null
}

export const IMAGE_MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml'
}

/** 能作为 MCP 图片内容直接给 AI 看的格式（主流模型都支持这四种） */
export const VIEWABLE: ReadonlySet<ImageFormat> = new Set(['png', 'jpeg', 'gif', 'webp'])

export const EXT_FORMAT: Record<string, ImageFormat> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  jfif: 'jpeg',
  gif: 'gif',
  webp: 'webp',
  bmp: 'bmp',
  ico: 'ico',
  svg: 'svg'
}

export function sniffImage(buf: Buffer): ImageMeta | null {
  const meta = (format: ImageFormat, width: number | null, height: number | null): ImageMeta => ({
    format,
    mime: IMAGE_MIME[format],
    width: width && width > 0 ? width : null,
    height: height && height > 0 ? height : null
  })
  const n = buf.length
  // PNG
  if (n >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return meta('png', buf.readUInt32BE(16), buf.readUInt32BE(20))
  }
  // GIF
  if (n >= 10 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')) {
    return meta('gif', buf.readUInt16LE(6), buf.readUInt16LE(8))
  }
  // JPEG
  if (n >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    const size = jpegSize(buf)
    return meta('jpeg', size?.width ?? null, size?.height ?? null)
  }
  // WebP
  if (n >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16)
    if (chunk === 'VP8 ') return meta('webp', buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff)
    if (chunk === 'VP8L') {
      const b0 = buf[21]
      const b1 = buf[22]
      const b2 = buf[23]
      const b3 = buf[24]
      return meta('webp', 1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)))
    }
    if (chunk === 'VP8X') return meta('webp', 1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3))
    return meta('webp', null, null)
  }
  // BMP
  if (n >= 26 && buf.toString('ascii', 0, 2) === 'BM') {
    return meta('bmp', Math.abs(buf.readInt32LE(18)), Math.abs(buf.readInt32LE(22)))
  }
  // ICO：取最大的那一张
  if (n >= 22 && buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1) {
    const count = buf.readUInt16LE(4)
    if (count > 0 && n >= 6 + count * 16) {
      let w = 0
      let h = 0
      for (let i = 0; i < count; i++) {
        const ew = buf[6 + i * 16] || 256
        const eh = buf[7 + i * 16] || 256
        if (ew * eh > w * h) {
          w = ew
          h = eh
        }
      }
      return meta('ico', w, h)
    }
  }
  // SVG（文本）
  const head = buf.subarray(0, Math.min(n, 8192)).toString('utf8').replace(/^\uFEFF/, '')
  const tag = /<svg\b[^>]*>/i.exec(head)
  if (tag && /^\s*(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg\b/i.test(head)) {
    const size = svgSize(tag[0])
    return meta('svg', size.width, size.height)
  }
  return null
}

function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]
    if (marker === 0xff) {
      i++
      continue
    }
    // 没有长度字段的标记
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null
    const len = buf.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    i += 2 + len
  }
  return null
}

function svgSize(tag: string): { width: number | null; height: number | null } {
  const attr = (name: string): string | undefined => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1]
  const num = (v: string | undefined): number | null => {
    if (!v) return null
    const m = /^\s*([\d.]+)\s*(px)?\s*$/i.exec(v)
    return m ? Math.round(parseFloat(m[1])) : null
  }
  let width = num(attr('width'))
  let height = num(attr('height'))
  if (width === null || height === null) {
    const vb = attr('viewBox')
      ?.trim()
      .split(/[\s,]+/)
      .map(Number)
    if (vb && vb.length === 4 && vb.every((x) => Number.isFinite(x))) {
      width ??= Math.round(vb[2])
      height ??= Math.round(vb[3])
    }
  }
  return { width, height }
}

/** 16:9 这种约分后的比例；约不成小整数就给小数 */
export function aspectRatio(width: number | null, height: number | null): string | null {
  if (!width || !height) return null
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const g = gcd(width, height)
  const w = width / g
  const h = height / g
  if (w <= 50 && h <= 50) return `${w}:${h}`
  return `${(width / height).toFixed(3)}:1`
}
