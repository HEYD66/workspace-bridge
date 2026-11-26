// ripgrep 后端：和 JS 引擎结果一致、过滤（.git / 数据目录 / junction；凭据文件不再过滤）、超时、取消、找不到 rg 时退回 bridge。
// 本机没有 rg 时整组跳过（退回测试除外）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FileTools } from '../src/core/fileTools'
import { PathGuard } from '../src/core/pathGuard'
import { findRipgrep, jsRegexToRg, ripgrepHasPcre2, runRipgrep, setRipgrepPath } from '../src/core/ripgrep'
import { SearchService } from '../src/core/search'
import type { SearchOptions } from '../src/core/types'

const RG = findRipgrep()
const PCRE2 = RG ? ripgrepHasPcre2(RG) : false
const savedEnv = process.env.WB_RG_PATH

let base: string
let root: string
let dataDir: string
let outside: string
let canJunction = false

const write = (rel: string, data: string | Buffer, at = root): void => {
  fs.mkdirSync(path.dirname(path.join(at, rel)), { recursive: true })
  fs.writeFileSync(path.join(at, rel), data)
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rg-'))
  root = path.join(base, 'ws')
  dataDir = path.join(root, '.appdata')
  outside = path.join(base, 'outside')
  write('src/a.ts', 'const mcpServer = 1\nfunction foo() { return mcpServer }\n// MCPSERVER upper\nfooBar foo_bar foo\n')
  write('src/b.js', 'x x x\n'.repeat(5) + 'tail\n')
  write('src/sub/deep.ts', 'import { mcpServer } from "../a"\nmcpServerX()\n')
  write('lib/c.min.js', 'mcpServer()')
  write('docs/readme.md', 'mcpServer in docs\n\nline3\nline4 mcpServer\nlast')
  write('docs/zh.md', '中文 mcpServer 中文 mcpServer\n')
  write('docs/crlf.txt', 'foo\r\nbar mcpServer\r\nbaz\r\n')
  write('many.txt', 'hit hit\n'.repeat(30))
  write('node_modules/x/i.js', 'mcpServer')
  write('ignored/i.ts', 'mcpServer')
  write('.gitignore', 'ignored/\n')
  write('big.log', 'mcpServer\n' + 'a'.repeat(2 * 1024 * 1024 + 10))
  write('bin.dll', 'mcpServer')
  // 凭据和受保护目录
  write('.env', 'TOKEN=mcpServer')
  write('conf/server.pem', 'mcpServer')
  write('.ssh/config', 'mcpServer')
  write('.git/config', 'mcpServer')
  write('.appdata/token.txt', 'mcpServer')
  // 工作区外，经 junction 进来
  write('secret.txt', 'mcpServer outside', outside)
  try {
    fs.symlinkSync(outside, path.join(root, 'escape'), 'junction')
    canJunction = true
  } catch {
    canJunction = false
  }
})

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
  if (savedEnv === undefined) delete process.env.WB_RG_PATH
  else process.env.WB_RG_PATH = savedEnv
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.WB_RG_PATH
  else process.env.WB_RG_PATH = savedEnv
  setRipgrepPath(undefined)
})

const withEngine = async <T>(engine: 'ripgrep' | 'bridge', fn: () => Promise<T>): Promise<T> => {
  if (engine === 'bridge') process.env.WB_RG_PATH = 'none'
  else if (RG) process.env.WB_RG_PATH = RG
  try {
    return await fn()
  } finally {
    if (savedEnv === undefined) delete process.env.WB_RG_PATH
    else process.env.WB_RG_PATH = savedEnv
  }
}

const svc = (): SearchService => new SearchService({ dataDir, roots: () => [{ id: 'w', root }] })
const tools = (): FileTools => new FileTools(new PathGuard(root, [dataDir]), path.join(base, 'trash'))

const wb = async (engine: 'ripgrep' | 'bridge', o: Partial<SearchOptions>) => {
  const r = await withEngine(engine, () => svc().search({ query: 'mcpServer', ...o } as SearchOptions))
  const { durationMs: _d, ...rest } = r
  return rest
}

const mcp = async (engine: 'ripgrep' | 'bridge', o: Partial<Parameters<FileTools['search']>[0]>) => {
  const r = await withEngine(engine, () => tools().search({ query: 'mcpServer', ...o }))
  const { durationMs: _d, scannedFiles: _s, ...rest } = r
  // JS 引擎按 readdir 顺序，rg 按路径排：比较时统一排序
  rest.results = [...rest.results].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : (a.line ?? 0) - (b.line ?? 0)))
  rest.skipped_large_paths = rest.skipped_large_paths && [...rest.skipped_large_paths].sort()
  return rest
}

describe.skipIf(!RG)('工作台搜索：ripgrep 和 JS 引擎结果一致', () => {
  const cases: [string, Partial<SearchOptions>][] = [
    ['字面', {}],
    ['字面 + 区分大小写', { caseSensitive: true }],
    ['大写字面不区分大小写', { query: 'MCPSERVER' }],
    ['全字', { wholeWord: true }],
    ['全字 foo', { query: 'foo', wholeWord: true }],
    ['正则', { query: 'mcp\\w+\\(?', regex: true }],
    ['正则 + 全字', { query: 'foo\\w*', regex: true, wholeWord: true }],
    ['正则 \\p{Script=Han}', { query: '\\p{Script=Han}+', regex: true }],
    ['正则 锚点', { query: '^bar', regex: true }],
    ['正则 $ 和 CRLF', { query: 'Server$', regex: true }],
    ['include', { include: '*.ts' }],
    ['include 目录', { include: 'docs' }],
    ['exclude', { exclude: 'src, *.md' }],
    ['exclude 含 /', { exclude: 'src/sub' }],
    ['上下文', { contextLines: 2 }],
    ['单文件上限', { query: 'hit', maxMatchesPerFile: 3 }],
    ['单文件上限 + 上下文', { query: 'x', maxMatchesPerFile: 4, contextLines: 1 }],
    ['结果上限', { query: 'hit', maxResults: 7 }],
    ['子目录', { path: 'src' }]
  ]
  for (const [name, o] of cases) {
    it(name, async () => {
      const a = await wb('ripgrep', o)
      const b = await wb('bridge', o)
      expect(a.engine).toBe('ripgrep')
      expect(b.engine).toBe('bridge')
      expect({ ...a, engine: undefined }).toEqual({ ...b, engine: undefined })
    })
  }
  it.skipIf(!PCRE2)('后行断言走 --pcre2', async () => {
    const a = await wb('ripgrep', { query: '(?<=return )mcp\\w+', regex: true })
    const b = await wb('bridge', { query: '(?<=return )mcp\\w+', regex: true })
    expect(a.engine).toBe('ripgrep')
    expect({ ...a, engine: undefined }).toEqual({ ...b, engine: undefined })
    expect(a.totalMatches).toBe(1)
  })
  it('超过 2MB 的文件跳过并计数', async () => {
    const a = await wb('ripgrep', {})
    expect(a.skippedLargeFiles).toBe(1)
  })
  it('中文行里的列号按 UTF-16 算', async () => {
    const a = await wb('ripgrep', { include: 'zh.md' })
    expect(a.files[0].matches[0].ranges).toEqual([
      [3, 12],
      [16, 25]
    ])
  })
})

describe.skipIf(!RG)('MCP search：ripgrep 和 JS 引擎结果一致', () => {
  // JS 引擎不看 .gitignore，rg 看：比较时把 ignored/ 排掉
  const ex = ['ignored/**']
  const cases: [string, Partial<Parameters<FileTools['search']>[0]>][] = [
    ['字面 smart-case（小写）', { query: 'mcpserver' }],
    ['字面 smart-case（有大写）', {}],
    ['强制不区分大小写', { caseSensitive: false }],
    ['正则', { query: 'mcp\\w+', regex: true }],
    ['正则 CRLF', { query: 'Server$', regex: true }],
    ['include', { include: ['*.ts'] }],
    ['glob', { glob: 'src/**' }],
    ['exclude', { exclude: ['*.md', 'lib/**'] }],
    ['上下文', { contextLines: 2 }],
    ['单文件上限', { query: 'hit', maxMatchesPerFile: 3 }],
    ['结果上限', { query: 'x', maxResults: 3, path: 'src' }],
    ['子目录', { path: 'docs' }]
  ]
  for (const [name, o] of cases) {
    it(name, async () => {
      const opts = { ...o, exclude: [...(o.exclude ?? []), ...ex] }
      const a = await mcp('ripgrep', opts)
      const b = await mcp('bridge', opts)
      expect(a.engine).toBe('ripgrep')
      expect(b.engine).toBe('bridge')
      expect({ ...a, engine: undefined }).toEqual({ ...b, engine: undefined })
    })
  }
  it('rg 按 .gitignore 跳过（JS 引擎不看，已知差异）', async () => {
    const a = await mcp('ripgrep', {})
    expect(a.results.some((r) => r.path.startsWith('ignored/'))).toBe(false)
  })
})

describe.skipIf(!RG)('ripgrep 安全过滤', () => {
  it('MCP：凭据文件、.ssh 能搜到；.git、数据目录、junction 指到外面的搜不到', async () => {
    const r = await mcp('ripgrep', {})
    const paths = r.results.map((x) => x.path)
    expect(r.engine).toBe('ripgrep')
    expect(paths).toContain('src/a.ts')
    expect(paths).toEqual(expect.arrayContaining(['.env', 'conf/server.pem', '.ssh/config']))
    for (const p of paths) {
      expect(p).not.toMatch(/^(\.git\/|\.appdata\/|escape\/)/)
      expect(p).not.toMatch(/node_modules|\.dll$/)
    }
    expect(JSON.stringify(r)).not.toContain('outside')
  })
  it('工作台（用户档位）：.env 能搜到（和 JS 引擎一致），.git 和数据目录搜不到', async () => {
    const r = await wb('ripgrep', {})
    const paths = r.files.map((f) => f.path)
    expect(paths).toContain('.env')
    expect(paths.some((p) => p.startsWith('.git/') || p.startsWith('.appdata/') || p.startsWith('escape/'))).toBe(false)
  })
  it('isAllowedResult：凭据文件名放行；数据目录、junction 逃逸照样拒', () => {
    const g = new PathGuard(root, [dataDir])
    expect(g.isAllowedResult(path.join(root, 'src', 'a.ts'))).toBe(true)
    expect(g.isAllowedResult(path.join(root, '.env'))).toBe(true)
    expect(g.isAllowedResult(path.join(root, 'conf', 'server.pem'))).toBe(true)
    expect(g.isAllowedResult(path.join(root, '.ssh', 'config'))).toBe(true)
    expect(g.isAllowedResult(path.join(root, '.appdata', 'token.txt'))).toBe(false)
    expect(g.isAllowedResult(path.join(outside, 'secret.txt'))).toBe(false)
    if (canJunction) expect(g.isAllowedResult(path.join(root, 'escape', 'secret.txt'))).toBe(false)
  })
  it('rg 被强制跟随链接时 junction 里的结果也被丢掉', async () => {
    // canJunction 在 beforeAll 里才知道，不能用 skipIf
    if (!canJunction) return
    // 模拟 rg 返回了 junction 里的路径：直接跑 rg -L，再按 search 的规则过 guard
    const g = new PathGuard(root, [dataDir])
    const seen: string[] = []
    await runRipgrep({
      rgPath: RG!,
      cwd: root,
      args: ['-L', '--fixed-strings', '--regexp', 'outside', '--', '.'],
      timeoutMs: 10_000,
      onFile: (f) => void seen.push(f.rel)
    })
    expect(seen).toContain('escape/secret.txt')
    expect(seen.filter((p) => g.isAllowedResult(path.join(root, p)))).toEqual([])
  })
  it('整机模式：AppData 目录不进', async () => {
    write('proj/AppData/Local/x.txt', 'mcpServer', base)
    write('proj/ok.txt', 'mcpServer', base)
    try {
      const t = new FileTools(new PathGuard(base, [dataDir], { machine: true }), path.join(base, 'trash'))
      const a = await withEngine('ripgrep', () => t.search({ query: 'mcpServer', path: 'proj' }))
      const b = await withEngine('bridge', () => t.search({ query: 'mcpServer', path: 'proj' }))
      expect(a.engine).toBe('ripgrep')
      expect(a.results.map((x) => x.path)).toEqual(['proj/ok.txt'])
      expect(b.results.map((x) => x.path)).toEqual(['proj/ok.txt'])
    } finally {
      fs.rmSync(path.join(base, 'proj'), { recursive: true, force: true })
    }
  })
})

describe.skipIf(!RG)('runRipgrep：超时和取消会杀掉 rg', () => {
  const repo = path.resolve(__dirname, '..')
  it('超时', async () => {
    const t0 = Date.now()
    const r = await runRipgrep({ rgPath: RG!, cwd: repo, args: ['--no-ignore', '--regexp', 'zz_never_matches_zz', '--', '.'], timeoutMs: 1, onFile: () => {} })
    expect(r.status).toBe('timeout')
    expect(Date.now() - t0).toBeLessThan(5000)
  })
  it('AbortSignal', async () => {
    const ac = new AbortController()
    const p = runRipgrep({ rgPath: RG!, cwd: repo, args: ['--no-ignore', '--regexp', 'zz_never_matches_zz', '--', '.'], timeoutMs: 30_000, signal: ac.signal, onFile: () => {} })
    setTimeout(() => ac.abort(), 5)
    expect((await p).status).toBe('aborted')
  })
  it('够了就提前结束', async () => {
    let n = 0
    const r = await runRipgrep({ rgPath: RG!, cwd: root, args: ['--fixed-strings', '--regexp', 'mcpServer', '--', '.'], timeoutMs: 10_000, onFile: () => ++n >= 1 })
    expect(r.status).toBe('stopped')
    expect(n).toBe(1)
  })
  it('工作台：新的一次搜索取消上一次', async () => {
    const s = svc()
    const r = await withEngine('ripgrep', async () => {
      const first = s.search({ query: 'mcpServer' } as SearchOptions)
      await s.search({ query: 'foo' } as SearchOptions)
      return first
    })
    expect(r.engine).toBe('ripgrep')
    expect(r.truncatedReason).toBe('canceled')
  })
})

describe('找不到 rg 或 rg 不支持时退回 JS 引擎', () => {
  it('WB_RG_PATH=none', async () => {
    expect((await wb('bridge', {})).engine).toBe('bridge')
    expect((await mcp('bridge', {})).engine).toBe('bridge')
  })
  it('注入 null（当作没装）', async () => {
    delete process.env.WB_RG_PATH
    setRipgrepPath(null)
    expect(findRipgrep()).toBeNull()
    const r = await tools().search({ query: 'mcpServer' })
    expect(r.engine).toBe('bridge')
    expect(r.results.length).toBeGreaterThan(0)
  })
  it('WB_RG_PATH 指向不存在的文件', async () => {
    process.env.WB_RG_PATH = path.join(base, 'nope', 'rg.exe')
    expect(findRipgrep()).toBeNull()
  })
  it.skipIf(!RG)('翻译不了的正则走 JS 引擎', async () => {
    const r = await wb('ripgrep', { query: '[\\W]mcp', regex: true })
    expect(r.engine).toBe('bridge')
  })
  it.skipIf(!RG)('能匹配空串的正则走 JS 引擎', async () => {
    const r = await wb('ripgrep', { query: 'z*', regex: true, maxResults: 5 })
    expect(r.engine).toBe('bridge')
  })
})

describe('jsRegexToRg', () => {
  it('ASCII 的 \\w \\d \\b', () => {
    expect(jsRegexToRg('\\w+\\d\\b', false)).toEqual({ pattern: '[0-9A-Za-z_]+[0-9](?-u:\\b)', pcre2: false })
  })
  it('后行断言、反向引用要 PCRE2', () => {
    expect(jsRegexToRg('(?<=a)b', false)).toMatchObject({ pcre2: true })
    expect(jsRegexToRg('(a)\\1', false)).toMatchObject({ pcre2: true })
  })
  it('不支持的写法', () => {
    expect(jsRegexToRg('[\\W]', false)).toHaveProperty('unsupported')
    expect(jsRegexToRg('\\p{Han}', false)).toHaveProperty('unsupported')
    expect(jsRegexToRg('\\p{Han}', true)).toEqual({ pattern: '\\p{Han}', pcre2: false })
  })
})
