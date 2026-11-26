// cloudflared 隧道管理测试：用 node 跑一个假 cloudflared 脚本（bin=process.execPath, prefixArgs=[脚本, 临时目录]）模拟各种输出，不连网。
// 假脚本启动时把自己的 pid、收到的参数和 TUNNEL_TOKEN 记到临时目录，用来核对参数、确认进程已退出
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TunnelManager, findCloudflared, type TunnelOptions, type TunnelStatus } from '../src/core/tunnel'

// 输出格式照 cloudflared 2026.9.1 的真实输出（地址在边框表格里，Registered 单独一行，都写在 stderr）
const FAKE = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const dir = process.argv[2]
const args = process.argv.slice(3)
const behavior = fs.readFileSync(path.join(dir, 'behavior'), 'utf8').trim()
const runs = path.join(dir, 'runs')
fs.mkdirSync(runs, { recursive: true })
const rec = path.join(runs, process.pid + '.json')
fs.writeFileSync(rec + '.tmp', JSON.stringify({ pid: process.pid, behavior, args, token: process.env.TUNNEL_TOKEN ?? null }))
fs.renameSync(rec + '.tmp', rec)

const ts = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')
const log = (level, msg) => process.stderr.write(ts() + ' ' + level + ' ' + msg + '\n')
const BORDER = '+' + '-'.repeat(92) + '+'
const printUrl = () => {
  log('INF', BORDER)
  log('INF', '|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |')
  log('INF', '|  https://ties-mins-welding-lawsuit.trycloudflare.com                                       |')
  log('INF', BORDER)
}
const REGISTERED = 'Registered tunnel connection connIndex=0 connection=c42c8baf-a6aa-4a0a-a1b6-18713230a21b event=0 ip=198.18.0.9 location=lax11 protocol=quic'

// 像真的 cloudflared 一样一直运行，直到被杀
setInterval(() => {}, 1000)

switch (behavior) {
  case 'quick-ok':
    log('INF', 'Requesting new quick Tunnel on trycloudflare.com...')
    setTimeout(printUrl, 50)
    setTimeout(() => log('INF', REGISTERED), 150)
    break
  case 'url-only':
    printUrl()
    break
  case 'spam':
    printUrl()
    for (let i = 0; i < 200; i++) log('INF', 'filler line ' + i)
    log('INF', REGISTERED)
    break
  case 'named-ok':
    log('INF', 'Starting tunnel tunnelID=6ff42ae2-765d-4adf-8112-31c55c1551ef token=' + process.env.TUNNEL_TOKEN)
    setTimeout(() => log('INF', REGISTERED), 100)
    break
  case 'exit1':
    log('INF', 'Requesting new quick Tunnel on trycloudflare.com...')
    setTimeout(() => {
      log('ERR', 'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com: no such host')
      process.stderr.write("See 'cloudflared tunnel --help'.\n", () => process.exit(1))
    }, 50)
    break
  case 'hang':
    break
}
`

const QUICK_URL = 'https://ties-mins-welding-lawsuit.trycloudflare.com'
const TOKEN = 'eyJhIjoiZmFrZS1hY2NvdW50IiwidCI6ImZha2UtdHVubmVsIiwicyI6ImZha2Utc2VjcmV0In0='

interface RunRecord {
  pid: number
  behavior: string
  args: string[]
  token: string | null
}

let dir: string
let managers: TunnelManager[] = []

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function setBehavior(b: string): void {
  fs.writeFileSync(path.join(dir, 'behavior'), b)
}

function records(): RunRecord[] {
  const runs = path.join(dir, 'runs')
  if (!fs.existsSync(runs)) return []
  return fs
    .readdirSync(runs)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(runs, f), 'utf8')) as RunRecord)
}

/** 等第 n 个假进程启动并登记好 */
async function waitForRun(n = 1): Promise<RunRecord[]> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const r = records()
    if (r.length >= n) return r
    await sleep(20)
  }
  throw new Error('假 cloudflared 没有启动')
}

/** 连续相同的状态只留一个（只有日志变化时也会通知） */
function dedupe(states: string[]): string[] {
  return states.filter((s, i) => s !== states[i - 1])
}

function setup(behavior: string, opts: TunnelOptions = {}) {
  setBehavior(behavior)
  const changes: TunnelStatus[] = []
  const m = new TunnelManager({
    bin: process.execPath,
    prefixArgs: [path.join(dir, 'fake-cloudflared.cjs'), dir],
    readyTimeoutMs: 8000,
    onChange: (s) => changes.push(s),
    ...opts
  })
  managers.push(m)
  return { m, changes, states: () => dedupe(changes.map((s) => s.state)) }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-tunnel-'))
  fs.writeFileSync(path.join(dir, 'fake-cloudflared.cjs'), FAKE)
})

afterEach(async () => {
  // 先查残留再清理：用例自己没把进程收拾干净就算失败
  const alive = records()
    .map((r) => r.pid)
    .filter(isAlive)
  for (const pid of alive) {
    try {
      process.kill(pid)
    } catch {
      // 已经退出
    }
  }
  for (const m of managers.splice(0)) await m.stop()
  fs.rmSync(dir, { recursive: true, force: true })
  expect(alive, '用例结束时还有残留的 cloudflared 进程').toEqual([])
})

describe('TunnelManager', { timeout: 20_000 }, () => {
  it('quick：先拿到地址、再看到 Registered 才算 running；stop 后进程退出、状态回 off', async () => {
    const { m, states } = setup('quick-ok')
    const s = await m.start({ mode: 'quick', port: 4567 })
    expect(s).toMatchObject({
      mode: 'quick',
      state: 'running',
      url: QUICK_URL,
      hostname: 'ties-mins-welding-lawsuit.trycloudflare.com',
      binary: process.execPath
    })
    expect(s.error).toBeUndefined()
    expect(s.startedAt).toBeTypeOf('number')
    expect(s.log.some((l) => l.includes('Registered tunnel connection'))).toBe(true)

    const [run] = records()
    expect(run.args.slice(0, 2)).toEqual(['tunnel', '--no-autoupdate'])
    expect(run.args[run.args.indexOf('--protocol') + 1]).toBe('http2')
    expect(run.args[run.args.indexOf('--url') + 1]).toBe('http://127.0.0.1:4567')
    expect(run.token).toBeNull()
    // quick 用自己的临时配置，不读 ~/.cloudflared/config.yml
    const cfg = run.args[run.args.indexOf('--config') + 1]
    expect(fs.existsSync(cfg)).toBe(true)
    expect(isAlive(run.pid)).toBe(true)
    expect(m.status()).toMatchObject({ state: 'running', url: QUICK_URL })

    await m.stop()
    expect(m.status()).toMatchObject({ mode: 'off', state: 'off' })
    expect(m.status().url).toBeUndefined()
    expect(isAlive(run.pid)).toBe(false)
    expect(fs.existsSync(cfg)).toBe(false)
    expect(states()).toEqual(['starting', 'running', 'off'])
  })

  it('只打印地址不打印 Registered：超时变 error，进程被杀掉', async () => {
    const { m, states } = setup('url-only', { readyTimeoutMs: 1500 })
    const s = await m.start({ mode: 'quick', port: 4567 })
    expect(s.state).toBe('error')
    expect(s.error).toContain(`已拿到地址 ${QUICK_URL}，但等了 1.5 秒隧道还没连上 Cloudflare`)
    expect(s.url).toBeUndefined()
    const [run] = records()
    expect(isAlive(run.pid)).toBe(false)
    expect(states()).toEqual(['starting', 'error'])
    await m.stop()
    expect(m.status().state).toBe('off')
  })

  it('日志只保留最近 80 行', async () => {
    const { m } = setup('spam')
    const s = await m.start({ mode: 'quick', port: 4567 })
    expect(s.state).toBe('running')
    expect(s.log).toHaveLength(80)
    expect(s.log[s.log.length - 1]).toContain('Registered tunnel connection')
    await m.stop()
  })

  it('named：token 只经环境变量传，不在参数里；日志里的 token 被替换成 [token]', async () => {
    const { m, changes } = setup('named-ok')
    const s = await m.start({ mode: 'named', port: 4567, hostname: 'MCP.Example.com', token: TOKEN })
    expect(s).toMatchObject({ mode: 'named', state: 'running', url: 'https://mcp.example.com', hostname: 'mcp.example.com' })

    const [run] = records()
    expect(run.args).toEqual(['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run'])
    expect(run.args.join(' ')).not.toContain(TOKEN)
    expect(run.token).toBe(TOKEN)
    expect(s.log.some((l) => l.includes('token=[token]'))).toBe(true)
    expect(JSON.stringify(m.status())).not.toContain(TOKEN)
    expect(JSON.stringify(changes)).not.toContain(TOKEN)

    await m.stop()
    expect(isAlive(run.pid)).toBe(false)
  })

  it('named：hostname 不合法或没有 token 时直接 error，不启动进程', async () => {
    const { m } = setup('named-ok')
    const bad = [
      'https://mcp.example.com',
      'mcp.example.com/mcp',
      'mcp.example.com:443',
      'localhost',
      '127.0.0.1',
      'mcp example.com',
      '-bad.example.com',
      'mcp..example.com',
      'mcp.example.com\nx',
      ''
    ]
    for (const hostname of bad) {
      const s = await m.start({ mode: 'named', port: 4567, hostname, token: TOKEN })
      expect(s.state, hostname).toBe('error')
      expect(s.error, hostname).toContain('域名不合法')
    }
    const s = await m.start({ mode: 'named', port: 4567, hostname: 'mcp.example.com', token: '  ' })
    expect(s.state).toBe('error')
    expect(s.error).toContain('tunnel token')
    expect(records()).toEqual([])
  })

  it('进程启动后自己退出（exit 1）：error，带最后一条有用的输出', async () => {
    const { m, states } = setup('exit1')
    const s = await m.start({ mode: 'quick', port: 4567 })
    expect(s.state).toBe('error')
    expect(s.error).toContain('cloudflared 启动失败（退出码 1）')
    expect(s.error).toContain('最后输出：failed to request quick Tunnel')
    expect(s.error).toContain('申请临时地址失败')
    expect(s.url).toBeUndefined()
    const [run] = records()
    expect(isAlive(run.pid)).toBe(false)
    expect(states()).toEqual(['starting', 'error'])
    await m.stop()
  })

  it('starting 阶段 stop：start 以 off 结束，进程退出；重复 stop 不报错', async () => {
    const { m, states } = setup('hang')
    const pending = m.start({ mode: 'quick', port: 4567 })
    const [run] = await waitForRun()
    expect(m.status().state).toBe('starting')
    expect(isAlive(run.pid)).toBe(true)

    await m.stop()
    expect((await pending).state).toBe('off')
    expect(m.status()).toMatchObject({ mode: 'off', state: 'off' })
    expect(isAlive(run.pid)).toBe(false)

    await m.stop()
    await m.stop()
    expect(states()).toEqual(['starting', 'off'])
  })

  it('没启动过就 stop：不报错、不触发 onChange', async () => {
    const { m, changes } = setup('hang')
    await m.stop()
    await m.stop()
    expect(changes).toEqual([])
    expect(m.status()).toMatchObject({ mode: 'off', state: 'off', log: [] })
  })

  it('starting 时再 start：旧的那次以 off 结束、旧进程被结束，只留新进程', async () => {
    const { m } = setup('hang')
    const first = m.start({ mode: 'quick', port: 4567 })
    const [a] = await waitForRun()

    setBehavior('quick-ok')
    const second = m.start({ mode: 'quick', port: 4568 })
    expect((await first).state).toBe('off')
    const s = await second
    expect(s).toMatchObject({ state: 'running', url: QUICK_URL })
    expect(isAlive(a.pid)).toBe(false)

    const b = records().find((r) => r.pid !== a.pid)!
    expect(b.args[b.args.indexOf('--url') + 1]).toBe('http://127.0.0.1:4568')
    expect(isAlive(b.pid)).toBe(true)
    await m.stop()
    expect(isAlive(b.pid)).toBe(false)
  })

  it('running 时再 start：先停掉旧进程再启动', async () => {
    const { m, states } = setup('quick-ok')
    expect((await m.start({ mode: 'quick', port: 4567 })).state).toBe('running')
    const [a] = records()

    const s = await m.start({ mode: 'named', port: 4567, hostname: 'mcp.example.com', token: TOKEN })
    expect(s).toMatchObject({ mode: 'named', state: 'running', url: 'https://mcp.example.com' })
    expect(isAlive(a.pid)).toBe(false)
    const b = records().find((r) => r.pid !== a.pid)!
    expect(isAlive(b.pid)).toBe(true)
    expect(states()).toEqual(['starting', 'running', 'off', 'starting', 'running'])
    await m.stop()
    expect(isAlive(b.pid)).toBe(false)
  })

  it('bin 不存在：不 spawn，直接 error 并提示安装方法', async () => {
    const changes: TunnelStatus[] = []
    const m = new TunnelManager({ bin: path.join(dir, 'no-such-cloudflared.exe'), onChange: (s) => changes.push(s) })
    managers.push(m)
    expect(m.status().binary).toBeUndefined()

    const s = await m.start({ mode: 'quick', port: 4567 })
    expect(s.state).toBe('error')
    expect(s.binary).toBeUndefined()
    expect(s.error).toContain('没有找到 cloudflared')
    if (process.platform === 'win32') expect(s.error).toContain('winget install --id Cloudflare.cloudflared')
    expect(changes.map((c) => c.state)).toEqual(['error'])
    expect(records()).toEqual([])
  })

  it('findCloudflared 找到的一定是存在的文件', () => {
    const p = findCloudflared()
    if (p) expect(fs.statSync(p).isFile()).toBe(true)
  })
})
