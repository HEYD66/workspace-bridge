import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TunnelManager } from '../src/core/tunnel'

// 「关闭应用时保留隧道」：保留方式启动、脱离、接管、对不上时清理

const URL_ = 'https://keep-test-abc.trycloudflare.com'
const dirs: string[] = []
const pids: number[] = []

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(d)
  return d
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitDead(pid: number, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return !alive(pid)
}

/** 假 cloudflared：打出临时地址和连上的日志，然后一直挂着 */
function fakePrefix(): string[] {
  const script = path.join(tmp('wb-fake-cf-'), 'fake-cloudflared.js')
  fs.writeFileSync(
    script,
    [
      "console.error('2026-11-01T08:18:03Z INF Requesting new quick Tunnel on trycloudflare.com...')",
      `console.error('2026-11-01T08:18:04Z INF |  ${URL_}  |')`,
      "console.error('2026-11-01T08:18:05Z INF Registered tunnel connection connIndex=0 protocol=http2')",
      'setInterval(() => {}, 1000)'
    ].join('\n')
  )
  return [script]
}

const manager = (prefixArgs: string[]) => new TunnelManager({ bin: process.execPath, prefixArgs, readyTimeoutMs: 15_000 })
const recordOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'tunnel-kept.json'), 'utf8'))

afterEach(async () => {
  for (const p of pids.splice(0)) {
    if (alive(p)) {
      try {
        process.kill(p)
      } catch {
        // 忽略
      }
      await waitDead(p)
    }
  }
  // 刚结束的进程外面那层 cmd、conhost 要再过几百毫秒才退、才放开目录和日志文件，这时删会报 EPERM；
  // rmSync 自带的 maxRetries 对这个错不重试（实测），所以自己等：最多 5 秒。真有没收掉的进程占着，5 秒后照样报错
  for (const d of dirs.splice(0)) {
    const end = Date.now() + 5000
    for (;;) {
      try {
        fs.rmSync(d, { recursive: true, force: true })
        break
      } catch (e) {
        if (Date.now() > end) throw e
        await new Promise((r) => setTimeout(r, 150))
      }
    }
  }
})

describe('关闭应用时保留隧道', () => {
  // Windows 上 Node 启动的子进程会继承本进程的句柄；isolate 绕开这一点（PowerShell → cmd → cloudflared）
  it.skipIf(process.platform !== 'win32')('isolate：不继承句柄的启动方式也能连上、脱离、被接管、停掉；参数里的空格和百分号原样传到', async () => {
    const keepDir = tmp('wb keep 100%-')
    const prefix = fakePrefix()
    const m1 = manager(prefix)
    const s1 = await m1.start({ mode: 'quick', port: 8765, keepDir, isolate: true })
    expect(s1).toMatchObject({ state: 'running', url: URL_, kept: true })
    const rec = recordOf(keepDir)
    pids.push(rec.pid)
    expect(rec).toMatchObject({ mode: 'quick', port: 8765, url: URL_ })
    // 记下的是 cloudflared 自己的 pid（这里是 node），不是中间那层 cmd，也不是测试进程的子进程
    expect(alive(rec.pid)).toBe(true)
    expect(m1.pid()).toBe(rec.pid)
    expect(fs.existsSync(path.join(keepDir, 'cloudflared-launch.cmd'))).toBe(true)
    // 真的是绕了一道启动的：它的父进程不是这个测试进程（普通 spawn 的话就是）
    const parent = Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${rec.pid}').ParentProcessId`], { encoding: 'utf8' }).trim())
    expect(parent).toBeGreaterThan(0)
    expect(parent).not.toBe(process.pid)
    // 按程序名找的：记下的 pid 就是那个程序（这里是 node），不会是启动脚本里一闪而过的 chcp
    const image = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${rec.pid}').Name`], { encoding: 'utf8' }).trim()
    expect(image.toLowerCase()).toBe(path.basename(process.execPath).toLowerCase())
    expect(fs.readFileSync(path.join(keepDir, 'cloudflared.log'), 'utf8')).toContain('Registered tunnel connection')

    expect(m1.detach()).toBe(true)
    await new Promise((r) => setTimeout(r, 400))
    expect(alive(rec.pid)).toBe(true)

    const m2 = manager(prefix)
    expect(m2.adopt(keepDir, { mode: 'quick', port: 8765 })).toBe(true)
    expect(m2.status()).toMatchObject({ state: 'running', url: URL_, kept: true })
    await m2.stop()
    expect(await waitDead(rec.pid)).toBe(true)
    expect(fs.existsSync(path.join(keepDir, 'tunnel-kept.json'))).toBe(false)
  }, 60_000)

  it.skipIf(process.platform !== 'win32')('isolate + 自己的域名：token 经环境变量一路传到 cloudflared，不写进启动脚本和日志', async () => {
    const keepDir = tmp('wb-keep-')
    const side = path.join(tmp('wb-fake-named-'), 'seen.txt')
    const script = path.join(path.dirname(side), 'fake-named.js')
    fs.writeFileSync(
      script,
      [
        `require('fs').writeFileSync(${JSON.stringify(side)}, (process.env.TUNNEL_TOKEN === 'tok-secret-123' ? 'TOKEN_OK ' : 'TOKEN_MISSING ') + process.argv.slice(2).join(' '))`,
        "console.error('2026-11-01T08:18:05Z INF Registered tunnel connection connIndex=0 protocol=http2')",
        'setInterval(() => {}, 1000)'
      ].join('\n')
    )
    const m = manager([script])
    const s = await m.start({ mode: 'named', port: 8765, hostname: 'mcp.example.com', token: 'tok-secret-123', keepDir, isolate: true })
    expect(`${s.state} ${s.error ?? ''}`.trim()).toBe('running')
    expect(s.url).toBe('https://mcp.example.com')
    const rec = recordOf(keepDir)
    pids.push(rec.pid)
    const seen = fs.readFileSync(side, 'utf8')
    expect(seen.startsWith('TOKEN_OK ')).toBe(true)
    expect(seen).toContain('run')
    expect(seen).not.toContain('tok-secret-123')
    expect(fs.readFileSync(path.join(keepDir, 'cloudflared-launch.cmd'), 'utf8')).not.toContain('tok-secret-123')
    expect(fs.readFileSync(path.join(keepDir, 'tunnel-kept.json'), 'utf8')).not.toContain('tok-secret-123')
    await m.stop()
    expect(await waitDead(rec.pid)).toBe(true)
  }, 60_000)

  it.skipIf(process.platform !== 'win32')('isolate：启动到一半又叫停，不留下进程；进程自己退了能发现', async () => {
    const keepDir = tmp('wb-keep-')
    const prefix = fakePrefix()
    const m = manager(prefix)
    const p = m.start({ mode: 'quick', port: 8765, keepDir, isolate: true })
    await new Promise((r) => setTimeout(r, 50))
    expect(m.status().state).toBe('starting')
    await m.stop()
    expect((await p).state).toBe('off')
    expect(m.status().state).toBe('off')
    expect(m.pid()).toBeUndefined()
    expect(fs.existsSync(path.join(keepDir, 'tunnel-kept.json'))).toBe(false)

    // 再开一次，连上以后从外面把进程结束掉：状态变成出错，记录清掉
    const s = await m.start({ mode: 'quick', port: 8765, keepDir, isolate: true })
    expect(`${s.state} ${s.error ?? ''}`.trim()).toBe('running')
    const pid = recordOf(keepDir).pid as number
    pids.push(pid)
    process.kill(pid)
    expect(await waitDead(pid)).toBe(true)
    const end = Date.now() + 5000
    while (m.status().state === 'running' && Date.now() < end) await new Promise((r) => setTimeout(r, 100))
    expect(m.status().state).toBe('error')
    expect(fs.existsSync(path.join(keepDir, 'tunnel-kept.json'))).toBe(false)
  }, 60_000)

  it('保留方式启动后能脱离、进程不结束；新的管理器接管地址不变；停止后进程和记录都清掉', async () => {
    const keepDir = tmp('wb-keep-')
    const prefix = fakePrefix()
    const m1 = manager(prefix)
    const s1 = await m1.start({ mode: 'quick', port: 8765, keepDir })
    expect(s1.state).toBe('running')
    expect(s1.url).toBe(URL_)
    expect(s1.kept).toBe(true)
    const rec = recordOf(keepDir)
    pids.push(rec.pid)
    expect(rec).toMatchObject({ mode: 'quick', port: 8765, url: URL_ })

    expect(m1.detach()).toBe(true)
    expect(m1.status().state).toBe('off')
    await new Promise((r) => setTimeout(r, 500))
    expect(alive(rec.pid)).toBe(true)
    expect(fs.existsSync(path.join(keepDir, 'tunnel-kept.json'))).toBe(true)

    const m2 = manager(prefix)
    expect(m2.adopt(keepDir, { mode: 'quick', port: 8765 })).toBe(true)
    const s2 = m2.status()
    expect(s2).toMatchObject({ mode: 'quick', state: 'running', url: URL_, kept: true })
    expect(s2.log.some((l) => l.includes('Registered tunnel connection'))).toBe(true)

    await m2.stop()
    expect(m2.status().state).toBe('off')
    expect(await waitDead(rec.pid)).toBe(true)
    expect(fs.existsSync(path.join(keepDir, 'tunnel-kept.json'))).toBe(false)
  }, 30_000)

  it('普通方式启动的不能脱离；接管时端口对不上就结束旧进程、删掉记录；没有记录什么都不做', async () => {
    const prefix = fakePrefix()
    const m0 = manager(prefix)
    const s0 = await m0.start({ mode: 'quick', port: 8765 })
    expect(s0.state).toBe('running')
    expect(s0.kept).toBeUndefined()
    expect(m0.detach()).toBe(false)
    await m0.stop()

    const keepDir = tmp('wb-keep-')
    const m1 = manager(prefix)
    expect((await m1.start({ mode: 'quick', port: 8765, keepDir })).state).toBe('running')
    const rec = recordOf(keepDir)
    pids.push(rec.pid)
    expect(m1.detach()).toBe(true)

    const m2 = manager(prefix)
    expect(m2.adopt(keepDir, { mode: 'quick', port: 9000 })).toBe(false)
    expect(m2.status().state).toBe('off')
    expect(await waitDead(rec.pid)).toBe(true)
    expect(fs.existsSync(path.join(keepDir, 'tunnel-kept.json'))).toBe(false)
    expect(m2.adopt(keepDir, { mode: 'quick', port: 8765 })).toBe(false)
  }, 30_000)

  it('接管来的进程自己退出：状态变成出错，记录清掉', async () => {
    const keepDir = tmp('wb-keep-')
    const prefix = fakePrefix()
    const m1 = manager(prefix)
    await m1.start({ mode: 'quick', port: 8765, keepDir })
    const rec = recordOf(keepDir)
    pids.push(rec.pid)
    expect(m1.detach()).toBe(true)

    const m2 = manager(prefix)
    expect(m2.adopt(keepDir, { mode: 'quick', port: 8765 })).toBe(true)
    process.kill(rec.pid)
    expect(await waitDead(rec.pid)).toBe(true)
    const end = Date.now() + 5000
    while (m2.status().state === 'running' && Date.now() < end) await new Promise((r) => setTimeout(r, 100))
    const s = m2.status()
    expect(s.state).toBe('error')
    expect(s.error).toContain('隧道已断开')
    expect(fs.existsSync(path.join(keepDir, 'tunnel-kept.json'))).toBe(false)
  }, 30_000)
})
