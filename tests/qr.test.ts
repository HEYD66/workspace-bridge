import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encodeQr, QR_MAX_BYTES, qrSvgPath } from '../src/shared/qr'

const fingerprint = (text: string): string =>
  createHash('sha256')
    .update(
      encodeQr(text)
        .modules.map((r) => r.map((c) => (c ? '1' : '0')).join(''))
        .join('\n')
    )
    .digest('hex')
    .slice(0, 16)

describe('二维码生成', () => {
  // 这些指纹对应的图都用独立的解码库（jsQR）扫过，读出来和原文一致；这里防的是以后改坏
  it.each([
    ['A', 1, 'bc9009ae87ca68f1'],
    ['hello', 1, '52a7aa67e7296ede'],
    ['https://example.com/', 2, 'b495295b351150d7'],
    ['http://127.0.0.1:51303/rv/0123456789abcdef0123456789abcdef', 4, 'cd036dc268018b24'],
    ['https://abcd-efgh-ijkl-mnop.trycloudflare.com/rv/0123456789abcdef0123456789abcdef', 5, 'e56d96a6091cc7cd'],
    ['中文也可以 ✓', 2, '73992dc73b9b6048'],
    ['z'.repeat(107), 7, 'e9c1d6a0a0e12313'],
    ['q'.repeat(123), 8, 'fb7c3f262814ce22'],
    ['w'.repeat(153), 9, '8d7fb348ad0a27aa'],
    ['e'.repeat(213), 10, '86a52f91d0a7602b']
  ])('%s', (text, version, hash) => {
    const qr = encodeQr(text)
    expect(qr.version).toBe(version)
    expect(qr.size).toBe(version * 4 + 17)
    expect(fingerprint(text)).toBe(hash)
  })

  it('按长度选最小的版本，装不下就报错', () => {
    expect(encodeQr('x'.repeat(14)).version).toBe(1)
    expect(encodeQr('x'.repeat(15)).version).toBe(2)
    expect(encodeQr('y'.repeat(106)).version).toBe(6)
    expect(encodeQr('e'.repeat(181)).version).toBe(10)
    expect(() => encodeQr('e'.repeat(QR_MAX_BYTES + 1))).toThrow(/放不下/)
  })

  it('三个角是定位图形，右下角不是', () => {
    const { modules: m, size } = encodeQr('https://example.com/')
    const finder = (ox: number, oy: number) => {
      for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 7; x++) {
          const d = Math.max(Math.abs(x - 3), Math.abs(y - 3))
          if (m[oy + y][ox + x] !== (d !== 2)) return false
        }
      }
      return true
    }
    expect(finder(0, 0)).toBe(true)
    expect(finder(size - 7, 0)).toBe(true)
    expect(finder(0, size - 7)).toBe(true)
    expect(finder(size - 7, size - 7)).toBe(false)
  })

  it('格式信息里写的掩码号就是实际用的那个', () => {
    for (const text of ['A', 'hello', 'q'.repeat(123)]) {
      const qr = encodeQr(text)
      // 左上角那份格式信息的高 5 位：纠错等级（M=00）加掩码号，先异或回去
      const cells: [number, number][] = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]]
      let f = 0
      cells.forEach(([x, y], i) => {
        if (qr.modules[y][x]) f |= 1 << i
      })
      f ^= 0x5412
      expect(f >> 13).toBe(0)
      expect((f >> 10) & 7).toBe(qr.mask)
    }
  })

  it('SVG 路径：黑格数对得上，四周留了空白', () => {
    const qr = encodeQr('hello')
    const { d, total } = qrSvgPath(qr, 4)
    expect(total).toBe(qr.size + 8)
    const dark = qr.modules.flat().filter(Boolean).length
    const drawn = [...d.matchAll(/h(\d+)v1/g)].reduce((n, x) => n + Number(x[1]), 0)
    expect(drawn).toBe(dark)
    expect(d.startsWith('M4 4h7v1h-7z')).toBe(true)
  })
})
