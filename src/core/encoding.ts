import iconv from 'iconv-lite'

export type TextEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'gb18030'

export interface DecodedText {
  text: string
  encoding: TextEncoding
  eol: '\n' | '\r\n'
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true })

/** 前 8KB 里有 NUL 字节就当二进制（UTF-16 有 BOM 时例外） */
export function isBinary(buf: Buffer): boolean {
  if (hasUtf16Bom(buf)) return false
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

function hasUtf16Bom(buf: Buffer): boolean {
  return buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))
}

/** 识别编码并解码：BOM → 严格 UTF-8 → GB18030（GBK 超集，中文 Windows 老文件常见） */
export function decode(buf: Buffer): DecodedText {
  let text: string
  let encoding: TextEncoding
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    text = buf.subarray(3).toString('utf8')
    encoding = 'utf8-bom'
  } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.subarray(2).toString('utf16le')
    encoding = 'utf16le'
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    text = iconv.decode(buf.subarray(2), 'utf16be')
    encoding = 'utf16be'
  } else {
    try {
      text = utf8Strict.decode(buf)
      encoding = 'utf8'
    } catch {
      text = iconv.decode(buf, 'gb18030')
      encoding = 'gb18030'
    }
  }
  return { text, encoding, eol: text.includes('\r\n') ? '\r\n' : '\n' }
}

/** 按原编码写回，保持 BOM */
export function encode(text: string, encoding: TextEncoding): Buffer {
  switch (encoding) {
    case 'utf8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    case 'utf16be':
      return Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(text, 'utf16be')])
    case 'gb18030':
      return iconv.encode(text, 'gb18030')
    default:
      return Buffer.from(text, 'utf8')
  }
}
