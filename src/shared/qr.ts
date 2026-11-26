/*
 * 二维码生成（只给「远端查看」的链接用）：字节模式、纠错等级 M、版本 1–10（最多 213 个字节），不引第三方库。
 * 返回的是黑白格子，画图由界面自己做。做法按 ISO/IEC 18004：数据码字 → 分块算 Reed-Solomon 纠错码 → 交错 →
 * 画功能图形 → 蛇形填数据 → 8 种掩码里挑罚分最低的 → 写格式信息。
 */

/** 版本 1–10、纠错等级 M：[每块纠错码字数, 第一组块数, 第一组每块数据码字数, 第二组块数, 第二组每块数据码字数] */
const BLOCKS: readonly (readonly [number, number, number, number, number])[] = [
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44]
]
/** 对齐图形的中心坐标 */
const ALIGN: readonly (readonly number[])[] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]

/** 这个等级下最多能放多少个字节 */
export const QR_MAX_BYTES = 213

// GF(256)，本原多项式 x^8+x^4+x^3+x^2+1
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}
const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])

/** 生成多项式的系数（最高次项的 1 省略） */
function rsGenerator(degree: number): number[] {
  const g = new Array<number>(degree).fill(0)
  g[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      g[j] = mul(g[j], root)
      if (j + 1 < degree) g[j] ^= g[j + 1]
    }
    root = mul(root, 2)
  }
  return g
}

function rsRemainder(data: readonly number[], gen: readonly number[]): number[] {
  const r = new Array<number>(gen.length).fill(0)
  for (const b of data) {
    const factor = b ^ (r.shift() as number)
    r.push(0)
    for (let i = 0; i < gen.length; i++) r[i] ^= mul(gen[i], factor)
  }
  return r
}

function dataCapacity(version: number): number {
  const [, g1, d1, g2, d2] = BLOCKS[version - 1]
  return g1 * d1 + g2 * d2
}

/** 文字转成 UTF-8 字节（不依赖 TextEncoder，主进程和网页都能用） */
function utf8(text: string): number[] {
  const out: number[] = []
  for (const ch of text) {
    const c = ch.codePointAt(0) as number
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

/** 全部码字：数据加填充，分块算纠错码，再按规范交错 */
function codewords(bytes: readonly number[], version: number): number[] {
  const capacity = dataCapacity(version)
  const bits: number[] = []
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  put(0b0100, 4) // 字节模式
  put(bytes.length, version < 10 ? 8 : 16)
  for (const b of bytes) put(b, 8)
  put(0, Math.min(4, capacity * 8 - bits.length)) // 结束符
  while (bits.length % 8) bits.push(0)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0))
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad)

  const [ecLen, g1, d1, g2, d2] = BLOCKS[version - 1]
  const gen = rsGenerator(ecLen)
  const blocks: { data: number[]; ec: number[] }[] = []
  let at = 0
  for (let i = 0; i < g1 + g2; i++) {
    const len = i < g1 ? d1 : d2
    const part = data.slice(at, at + len)
    at += len
    blocks.push({ data: part, ec: rsRemainder(part, gen) })
  }
  const out: number[] = []
  for (let i = 0; i < Math.max(d1, d2); i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i])
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i])
  return out
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
]

/** 掩码罚分：四条规则加起来，越低越容易扫 */
function penalty(m: readonly boolean[][]): number {
  const n = m.length
  let score = 0
  // 规则一：同色连续 5 格以上；规则三：出现和定位图形一样的 1:1:3:1:1 条纹
  const line = (get: (i: number) => boolean) => {
    let run = 1
    for (let i = 1; i <= n; i++) {
      if (i < n && get(i) === get(i - 1)) run++
      else {
        if (run >= 5) score += run - 2
        run = 1
      }
    }
    for (let i = 0; i + 11 <= n; i++) {
      const s = (k: number) => get(i + k)
      const core = (o: number) => s(o) && !s(o + 1) && s(o + 2) && s(o + 3) && s(o + 4) && !s(o + 5) && s(o + 6)
      if (core(0) && !s(7) && !s(8) && !s(9) && !s(10)) score += 40
      if (core(4) && !s(0) && !s(1) && !s(2) && !s(3)) score += 40
    }
  }
  for (let y = 0; y < n; y++) line((i) => m[y][i])
  for (let x = 0; x < n; x++) line((i) => m[i][x])
  // 规则二：2×2 同色块
  for (let y = 0; y + 1 < n; y++) for (let x = 0; x + 1 < n; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3
  // 规则四：黑格比例离 50% 越远罚得越多
  let dark = 0
  for (const row of m) for (const c of row) if (c) dark++
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10
  return score
}

export interface QrCode {
  version: number
  /** 边长（格） */
  size: number
  /** 用的是哪个掩码（0–7） */
  mask: number
  /** modules[y][x] 为 true 表示黑格；不含四周的空白边 */
  modules: boolean[][]
}

/** 生成二维码。超过 QR_MAX_BYTES 个字节抛错 */
export function encodeQr(text: string): QrCode {
  const bytes = utf8(text)
  let version = 0
  for (let v = 1; v <= 10 && !version; v++) if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= dataCapacity(v) * 8) version = v
  if (!version) throw new Error(`内容太长，二维码放不下（${bytes.length} 字节，最多 ${QR_MAX_BYTES}）`)
  const size = version * 4 + 17
  const dark: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const fixed: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const set = (x: number, y: number, v: boolean) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    dark[y][x] = v
    fixed[y][x] = true
  }

  // 定位图形（三个角）连同一圈白边
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4]
  ]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        set(cx + dx, cy + dy, d !== 2 && d !== 4)
      }
    }
  }
  // 对齐图形（和定位图形重叠的三个位置不画）
  const centers = ALIGN[version - 1]
  const last = centers.length - 1
  centers.forEach((cy, i) =>
    centers.forEach((cx, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    })
  )
  // 时序图形
  for (let i = 8; i < size - 8; i++) {
    set(i, 6, i % 2 === 0)
    set(6, i, i % 2 === 0)
  }

  const bit = (value: number, i: number): boolean => ((value >>> i) & 1) === 1
  /** 格式信息：纠错等级 M（00）加掩码号，BCH(15,5)，再异或 0x5412 */
  const drawFormat = (mask: number) => {
    let rem = mask
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const f = ((mask << 10) | rem) ^ 0x5412
    for (let i = 0; i <= 5; i++) set(8, i, bit(f, i))
    set(8, 7, bit(f, 6))
    set(8, 8, bit(f, 7))
    set(7, 8, bit(f, 8))
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(f, i))
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(f, i))
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(f, i))
    set(8, size - 8, true) // 固定的一个黑格
  }
  drawFormat(0) // 先占位，选好掩码再重画
  // 版本信息（版本 7 以上才有）：BCH(18,6)
  if (version >= 7) {
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const v = (version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      set(a, b, bit(v, i))
      set(b, a, bit(v, i))
    }
  }

  // 数据从右下角开始，两列一组蛇形往上往下走，跳过功能图形和第 6 列
  const cw = codewords(bytes, version)
  let k = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let step = 0; step < size; step++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - step : step
        if (fixed[y][x]) continue
        // 码字用完后剩下的几格（余位）留白
        dark[y][x] = k < cw.length * 8 && bit(cw[k >>> 3], 7 - (k & 7))
        k++
      }
    }
  }

  let best: { mask: number; score: number; modules: boolean[][] } | undefined
  for (let mask = 0; mask < 8; mask++) {
    drawFormat(mask)
    const modules = dark.map((row, y) => row.map((v, x) => (fixed[y][x] ? v : v !== MASKS[mask](x, y))))
    const score = penalty(modules)
    if (!best || score < best.score) best = { mask, score, modules }
  }
  const chosen = best as { mask: number; score: number; modules: boolean[][] }
  return { version, size, mask: chosen.mask, modules: chosen.modules }
}

/** 画成一条 SVG 路径（每个黑格一个 1×1 的方块，quiet 是四周留白的格数），viewBox 用 `0 0 total total` */
export function qrSvgPath(qr: QrCode, quiet = 4): { d: string; total: number } {
  const parts: string[] = []
  qr.modules.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      if (!row[x]) {
        x++
        continue
      }
      let end = x
      while (end < row.length && row[end]) end++
      parts.push(`M${x + quiet} ${y + quiet}h${end - x}v1h-${end - x}z`)
      x = end
    }
  })
  return { d: parts.join(''), total: qr.size + quiet * 2 }
}
