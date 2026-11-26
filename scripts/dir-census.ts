// 统计目录下每个二级子目录的文件数和字节数（排查搜索慢在哪）：npx tsx scripts/dir-census.ts <目录> [--searchable]
// --searchable：只算全文搜索真正会打开的文件（不在默认排除目录、不是二进制扩展名、不超过 2MB）
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.argv[2] ?? '.')
const searchable = process.argv.includes('--searchable')
const SKIP = new Set(
  searchable
    ? 'node_modules .git out dist build .next coverage .e2e-out .venv venv __pycache__ site-packages .pytest_cache .mypy_cache .ruff_cache target Pods .turbo .nuxt .svelte-kit vendor .cache'.split(' ')
    : ['node_modules', '.git']
)
const BIN = new Set(
  'dll exe pdb lib obj o a so dylib node pyd pyc pyo class jar war png jpg jpeg gif bmp ico webp tif tiff psd avif heic mp3 mp4 m4a wav flac ogg webm mkv mov avi wmv zip 7z rar gz tgz bz2 xz zst tar cab msi iso dmg woff woff2 ttf otf eot pdf doc docx xls xlsx ppt pptx qm db sqlite sqlite3 ldb bin dat pak asar wasm onnx pt pth safetensors ckpt npy npz'.split(' ')
)
type S = { files: number; bytes: number }
const stats = new Map<string, S>()
const exts = new Map<string, S>()
function add(m: Map<string, S>, k: string, b: number): void {
  const s = m.get(k) ?? { files: 0, bytes: 0 }
  s.files++
  s.bytes += b
  m.set(k, s)
}
function walk(dir: string, rel: string): void {
  let ents: fs.Dirent[]
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of ents) {
    if (SKIP.has(e.name) || e.isSymbolicLink()) continue
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) walk(path.join(dir, e.name), r)
    else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase()
      if (searchable && BIN.has(ext.slice(1))) continue
      let b = 0
      try {
        b = fs.statSync(path.join(dir, e.name)).size
      } catch {}
      if (searchable && b > 2 * 1024 * 1024) continue
      const parts = r.split('/')
      add(stats, parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length > 1 ? parts[0] : '.', b)
      add(exts, ext || '(none)', b)
    }
  }
}
walk(root, '')
const top = (m: Map<string, S>) => [...m].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 15)
let tf = 0
let tb = 0
for (const s of stats.values()) (tf += s.files), (tb += s.bytes)
console.log(`总计 ${tf} 个文件，${(tb / 1048576).toFixed(1)} MB${searchable ? '（搜索会打开的）' : '（不含 node_modules/.git）'}`)
for (const [k, s] of top(stats)) console.log(`${String(s.files).padStart(7)}  ${(s.bytes / 1048576).toFixed(1).padStart(8)} MB  ${k}`)
console.log('--- 按扩展名')
for (const [k, s] of top(exts)) console.log(`${String(s.files).padStart(7)}  ${(s.bytes / 1048576).toFixed(1).padStart(8)} MB  ${k}`)
