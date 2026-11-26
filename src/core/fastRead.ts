// 全文搜索共用的读文件：工作台搜索（search.ts）和 MCP 的 search 工具（fileTools.ts）
import fsp from 'node:fs/promises'
import { isBinary } from './encoding'

/** 这些扩展名基本都是二进制：内容搜索直接跳过，连文件都不打开 */
const BINARY_EXTS = new Set(
  (
    'dll exe pdb lib obj o a so dylib node pyd pyc pyo class jar war ' +
    'png jpg jpeg gif bmp ico webp tif tiff psd avif heic ' +
    'mp3 mp4 m4a wav flac ogg webm mkv mov avi wmv ' +
    'zip 7z rar gz tgz bz2 xz zst tar cab msi iso dmg ' +
    'woff woff2 ttf otf eot pdf doc docx xls xlsx ppt pptx ' +
    // dat、db、bin、ldb 这类有时是文本，不放进来：交给开头 8KB 的 NUL 检测
    'qm sqlite sqlite3 pak asar wasm onnx pt pth safetensors ckpt npy npz'
  ).split(' ')
)

/** 给 ripgrep 的排除规则用：--glob=!*.{dll,exe,...} */
export function binaryExtGlob(): string {
  return `*.{${[...BINARY_EXTS].join(',')}}`
}

export function isBinaryExt(name: string): boolean {
  const i = name.lastIndexOf('.')
  return i > 0 && BINARY_EXTS.has(name.slice(i + 1).toLowerCase())
}

/**
 * 读一个准备搜内容的文件。返回文本的原始字节；'large' 表示超过 maxBytes；null 表示读不了、是空文件、不是普通文件或是二进制。
 * 文件 IO 走 libuv 线程池，瓶颈在操作次数：open、fstat、按大小一次读完、close，一共 4 次（stat + readFile 要 5 次以上）。
 * 读取期间文件变大的话只读 fstat 时的那么多。
 */
export async function readSearchable(abs: string, maxBytes: number): Promise<Buffer | 'large' | null> {
  let fh: Awaited<ReturnType<typeof fsp.open>> | undefined
  try {
    fh = await fsp.open(abs, 'r')
    const st = await fh.stat()
    if (!st.isFile()) return null
    if (st.size > maxBytes) return 'large'
    if (st.size === 0) return null
    const space = Buffer.allocUnsafe(st.size)
    // 一次通常就读完；短读时接着读，读到 0 字节（文件变小了）为止
    let got = 0
    while (got < space.length) {
      const { bytesRead } = await fh.read(space, got, space.length - got, got)
      if (bytesRead === 0) break
      got += bytesRead
    }
    const buf = space.subarray(0, got)
    return isBinary(buf) ? null : buf
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}
