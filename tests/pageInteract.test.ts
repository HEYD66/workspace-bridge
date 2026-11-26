import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { validatePageActions } from '../src/core/pageInteract'
import { findBrowser, SystemScreenshotBackend } from '../src/core/screenshot'

describe('页面动作参数', () => {
  it('限制动作数、等待预算与互斥点击目标', () => {
    expect(() => validatePageActions([{ type: 'click', selector: '#a' }, { type: 'scroll', dy: 100 }, { type: 'wait', ms: 0 }])).not.toThrow()
    for (const actions of [
      Array.from({ length: 21 }, () => ({ type: 'wait', ms: 0 })),
      [{ type: 'wait', ms: 5001 }],
      Array.from({ length: 3 }, () => ({ type: 'wait', ms: 4000 })),
      [{ type: 'click', x: -1, y: 0 }],
      [{ type: 'click', selector: '#a', x: 1, y: 1 }],
      [{ type: 'click', selector: '' }],
      [{ type: 'scroll', dy: Infinity }],
      [{ type: 'unknown' }]
    ]) expect(() => validatePageActions(actions as never)).toThrow()
  })
})

const browser = findBrowser(process.env, fs.existsSync)
/**
 * 起真实浏览器的测试的限时。全量测试刚开始时几十个测试文件一起启动，机器最忙，
 * 这时启动浏览器加上结束后扫进程清理（最多 30 秒）要一分钟上下，45 秒不够
 */
const REAL_BROWSER_TIMEOUT_MS = 120_000

describe.skipIf(!browser)('隔离真实网页', () => {
  let root: string
  let server: http.Server
  afterEach(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())) }
    if (root) {
      if (process.platform === 'win32') {
        const script = "$n=@(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*" + root.replace(/'/g, "''") + "*' }).Count; Write-Output $n"
        const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true })
        expect(stdout.trim(), '隔离浏览器不应留下进程').toBe('0')
      }
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })
  async function fixture() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-page-test-'))
    server = http.createServer((req, res) => {
      if (req.url === '/hang') return
      if (req.url === '/noise') { res.end('<script>for(let i=0;i<30;i++)console.warn("x".repeat(600));fetch("http://example.com/blocked").catch(()=>{});</script>'); return }
      if (req.url === '/missing') { res.writeHead(404); res.end('no'); return }
      res.setHeader('Content-Type', 'text/html')
      res.end('<body style="height:3000px"><button id="go" onclick="console.error(\'clicked\');document.body.style.background=\'red\'">Go</button><script>console.warn("loaded");fetch("/missing");setTimeout(()=>{throw Error("fixture exception")},20);window.addEventListener("scroll",()=>console.warn("scrolled:"+scrollY));</script>')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    return { backend: new SystemScreenshotBackend({ tmpRoot: root }), query: { url: 'http://127.0.0.1:' + port, width: 800, height: 600, scale: 1, waitMs: 100 } }
  }
  it('点击、滚动、截图及诊断，结束删除隔离 profile', async () => {
    const { backend, query } = await fixture()
    const shot = await backend.capturePage({ ...query, actions: [{ type: 'click', x: 20, y: 20 }, { type: 'click', selector: '#go' }, { type: 'scroll', dy: 500 }, { type: 'wait', ms: 100 }], diagnostics: true })
    expect(shot.png.subarray(1, 4).toString()).toBe('PNG')
    expect(shot.diagnostics?.console.filter((s) => s.includes('clicked')).length).toBe(2)
    expect(shot.png.readUInt32BE(16)).toBe(800)
    expect(shot.png.readUInt32BE(20)).toBe(600)
    expect(shot.diagnostics?.console.join(' ')).toContain('scrolled:500')
    expect(shot.diagnostics?.exceptions.join(' ')).toContain('fixture exception')
    expect(shot.diagnostics?.network.join(' ')).toContain('404')
    expect(await fsp.readdir(root)).toEqual([])
  }, REAL_BROWSER_TIMEOUT_MS)
  it('取消操作与无效 selector 均清理隔离 profile', async () => {
    const { backend, query } = await fixture()
    await expect(backend.capturePage({ ...query, actions: [{ type: 'click', selector: '[' }] })).rejects.toThrow(/selector/)
    const controller = new AbortController()
    const pending = backend.capturePage({ ...query, actions: [{ type: 'wait', ms: 5000 }], signal: controller.signal })
    setTimeout(() => controller.abort(), 700)
    await expect(pending).rejects.toThrow(/取消/)
    expect(await fsp.readdir(root)).toEqual([])
  }, REAL_BROWSER_TIMEOUT_MS)
  it('诊断条数和字数受限，非本机请求被阻止', async () => {
    const { backend, query } = await fixture()
    const shot = await backend.capturePage({ ...query, url: query.url + '/noise', diagnostics: true, waitMs: 300 })
    expect(shot.diagnostics?.console.length).toBe(20)
    expect(shot.diagnostics?.console.every((s) => s.length <= 500)).toBe(true)
    expect(shot.diagnostics?.truncated).toBe(true)
    expect(shot.diagnostics?.network.join(' ')).toMatch(/ERR_BLOCKED_BY_CLIENT/)
  }, REAL_BROWSER_TIMEOUT_MS)
  it('加载超时也退出浏览器并删除 profile', async () => {
    const { backend, query } = await fixture()
    await expect(backend.capturePage({ ...query, url: query.url + '/hang', diagnostics: true })).rejects.toThrow(/超时/)
    expect(await fsp.readdir(root)).toEqual([])
  }, REAL_BROWSER_TIMEOUT_MS)
  it('页面崩溃时关闭本次浏览器进程并删除 profile', async () => {
    const { backend, query } = await fixture()
    const pending = backend.capturePage({ ...query, actions: [{ type: 'wait', ms: 5000 }] })
    const outcome = pending.then(() => 'resolved', (e: Error) => e.message)
    let active = ''
    for (let i = 0; i < 100 && !active; i++) {
      const dirs = await fsp.readdir(root)
      if (dirs[0]) active = await fsp.readFile(path.join(root, dirs[0], 'profile', 'DevToolsActivePort'), 'utf8').catch(() => '')
      if (!active) await new Promise((r) => setTimeout(r, 50))
    }
    expect(active).not.toBe('')
    let target: { webSocketDebuggerUrl: string } | undefined
    for (let i = 0; i < 60 && !target; i++) {
      const targets = await (await fetch('http://127.0.0.1:' + active.split('\n')[0] + '/json/list')).json() as { type: string; url: string; webSocketDebuggerUrl: string }[]
      target = targets.find((t) => t.type === 'page' && t.url.startsWith(query.url))
      if (!target) await new Promise((r) => setTimeout(r, 50))
    }
    expect(target).toBeDefined()
    const socket = new WebSocket(target!.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', reject, { once: true }) })
    await new Promise((r) => setTimeout(r, 500))
    socket.send(JSON.stringify({ id: 1, method: 'Page.crash' }))
    expect(await outcome).toMatch(/崩溃|连接已关闭|超时/)
    socket.close()
    expect(await fsp.readdir(root)).toEqual([])
  }, REAL_BROWSER_TIMEOUT_MS)
  it.skipIf(process.platform !== 'win32')('浏览器主进程被结束后仍清理遗留子进程', async () => {
    const { backend, query } = await fixture()
    const outcome = backend.capturePage({ ...query, actions: [{ type: 'wait', ms: 5000 }] }).then(() => 'resolved', (e: Error) => e.message)
    for (let i = 0; i < 100; i++) {
      if ((await fsp.readdir(root)).length) break
      await new Promise((r) => setTimeout(r, 50))
    }
    await new Promise((r) => setTimeout(r, 1500))
    const script = "$p=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like '*" + root.replace(/'/g, "''") + "*' -and $_.CommandLine -notlike '*--type=*' }; if(!$p){throw 'missing test browser'}; foreach($b in $p){Stop-Process -Id $b.ProcessId -Force}"
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true })
    expect(await outcome).not.toBe('resolved')
    expect(await fsp.readdir(root)).toEqual([])
  }, REAL_BROWSER_TIMEOUT_MS)
  it('清理失败不覆盖原始取消错误码', async () => {
    const { backend, query } = await fixture()
    const controller = new AbortController()
    controller.abort()
    const remove = vi.spyOn(fsp, 'rm').mockRejectedValueOnce(new Error('synthetic cleanup failure'))
    try {
      await expect(backend.capturePage({ ...query, actions: [], signal: controller.signal })).rejects.toMatchObject({
        code: 'CANCELLED', data: { cleanup_error: expect.stringContaining('synthetic cleanup failure') }
      })
    } finally { remove.mockRestore() }
  })
  it('新模式拒绝非指定 loopback 地址', async () => {
    const { backend, query } = await fixture()
    for (const url of ['http://127.0.0.2/', 'http://app.localhost/', 'http://192.168.1.2/']) {
      await expect(backend.capturePage({ ...query, url, diagnostics: true })).rejects.toThrow()
    }
    expect(await fsp.readdir(root)).toEqual([])
  })
})
