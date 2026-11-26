import { execFile, spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ToolError } from './fileTools'

/**
 * Windows 上清理隔离浏览器子进程的限时：要起一个 PowerShell 扫全部进程。
 * 机器忙的时候（比如同时在跑很多测试、构建）光启动 PowerShell 就要好几秒，原来的 10 秒不够：
 * 全量测试刚开始、几十个测试文件一起启动的那一阵，实测每次都超时，图已经截好了却报 CLEANUP_FAILED
 */
const CLEANUP_TIMEOUT_MS = 30_000

export type PageAction =
  | { type: 'click'; selector?: string; x?: number; y?: number }
  | { type: 'scroll'; dx?: number; dy: number }
  | { type: 'wait'; ms: number }

export interface PageDiagnostics {
  console: string[]
  exceptions: string[]
  network: string[]
  truncated: boolean
}

export function validatePageActions(actions: PageAction[] = []): void {
  if (!Array.isArray(actions) || actions.length > 20) throw new ToolError('INVALID_ARGS', 'actions 最多 20 步')
  let waiting = 0
  for (const a of actions) {
    if (!a || typeof a !== 'object') throw new ToolError('INVALID_ARGS', '动作必须是对象')
    if (a.type === 'click') {
      if (a.selector !== undefined) {
        if (typeof a.selector !== 'string' || !a.selector.trim() || a.selector.length > 500 || a.x !== undefined || a.y !== undefined) throw new ToolError('INVALID_ARGS', 'click 的 selector 与坐标二选一')
      } else if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || a.x! < 0 || a.y! < 0) throw new ToolError('INVALID_ARGS', 'click 需要有效坐标或 selector')
    } else if (a.type === 'scroll') {
      if (!Number.isFinite(a.dy) || Math.abs(a.dy) > 100000 || (a.dx !== undefined && (!Number.isFinite(a.dx) || Math.abs(a.dx) > 100000))) throw new ToolError('INVALID_ARGS', 'scroll 位移无效')
    } else if (a.type === 'wait') {
      if (!Number.isFinite(a.ms) || a.ms < 0 || a.ms > 5000) throw new ToolError('INVALID_ARGS', 'wait.ms 需在 0 到 5000 之间')
      waiting += a.ms
    } else throw new ToolError('INVALID_ARGS', '未知页面动作')
  }
  if (waiting > 10000) throw new ToolError('INVALID_ARGS', '动作等待合计最多 10000ms')
}

type Message = { id?: number; method?: string; params?: any; result?: any; error?: { message: string } }
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 只连接本次新建浏览器的页面；没有接入用户浏览器的接口。 */
class Cdp {
  private id = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  onEvent: (method: string, params: any) => void = () => {}
  constructor(private socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      let msg: Message
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        clearTimeout(p.timer); this.pending.delete(msg.id)
        if (msg.error) p.reject(new ToolError('PAGE_ACTION_FAILED', msg.error.message))
        else p.resolve(msg.result)
      } else if (msg.method) this.onEvent(msg.method, msg.params ?? {})
    })
    socket.addEventListener('close', () => this.rejectAll())
    socket.addEventListener('error', () => this.rejectAll())
  }
  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new ToolError('TIMEOUT', '页面调试连接超时')) }, 5000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new ToolError('SCREENSHOT_FAILED', '页面调试连接失败')) }, { once: true })
    })
    return new Cdp(socket)
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) { reject(new ToolError('SCREENSHOT_FAILED', '页面调试连接已关闭')); return }
      const id = ++this.id
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ToolError('TIMEOUT', method + ' 超时')) }, 5000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.socket.send(JSON.stringify({ id, method, params })) } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e) }
    })
  }
  private rejectAll(): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new ToolError('SCREENSHOT_FAILED', '页面调试连接已关闭')) }
    this.pending.clear()
  }
  close(): void { this.rejectAll(); this.socket.close() }
}

/** 调用方提供 loopback URL 校验，避免和 screenshot 模块产生运行时循环依赖。 */
export async function interactPage(o: {
  browser: string; dir: string; env: NodeJS.ProcessEnv; url: string
  width: number; height: number; scale: number; waitMs: number
  actions?: PageAction[]; diagnostics?: boolean; signal?: AbortSignal
  localUrl: (url: string) => string
}): Promise<{ png: Buffer; diagnostics?: PageDiagnostics }> {
  validatePageActions(o.actions)
  const localUrl = (input: string) => {
    const safe = o.localUrl(input)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(safe).hostname.toLowerCase())) throw new ToolError('URL_NOT_LOCAL', '页面操作只支持 localhost、127.0.0.1、::1')
    return safe
  }
  if (!Number.isFinite(o.waitMs) || o.waitMs < 0 || o.waitMs > 10000) throw new ToolError('INVALID_ARGS', '页面等待时间需在 0 到 10000ms 之间')
  const url = localUrl(o.url)
  if (o.signal?.aborted) throw new ToolError('CANCELLED', '页面操作已取消')
  const profile = path.join(o.dir, 'profile')
  const proc = spawn(o.browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-component-update',
    '--mute-audio', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + profile, 'about:blank'
  ], { env: o.env, stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' })
  let spawnError: Error | undefined
  proc.on('error', (e) => { spawnError = e })
  let cdp: Cdp | undefined
  let timedOut = false
  let cancelled = false
  const onAbort = () => { cancelled = true; cdp?.close() }
  o.signal?.addEventListener('abort', onAbort, { once: true })
  const check = () => {
    if (cancelled || o.signal?.aborted) throw new ToolError('CANCELLED', '页面操作已取消')
    if (timedOut) throw new ToolError('TIMEOUT', '页面操作超时')
    if (spawnError) throw spawnError
  }
  const wait = async (ms: number) => { for (let left = ms; left > 0; left -= 50) { check(); await delay(Math.min(left, 50)) }; check() }
  const deadline = setTimeout(() => { timedOut = true; cdp?.close() }, 30000 + o.waitMs)
  const result: PageDiagnostics = { console: [], exceptions: [], network: [], truncated: false }
  const add = (kind: 'console' | 'exceptions' | 'network', text: string) => {
    if (!o.diagnostics) return
    if (result[kind].length >= 20) { result.truncated = true; return }
    if (text.length > 500) result.truncated = true
    result[kind].push(text.slice(0, 500))
  }
  let asyncError: Error | undefined
  const requests = new Map<string, string>()
  let loaded = false
  let primaryError: unknown
  try {
    let port = 0
    for (let i = 0; i < 100; i++) {
      check()
      if (proc.exitCode !== null) throw new ToolError('SCREENSHOT_FAILED', '浏览器提前退出')
      const active = await fsp.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')
      port = Number(active.split('\n')[0])
      if (port > 0 && port < 65536) break
      await wait(100)
    }
    if (!port) throw new ToolError('TIMEOUT', '浏览器启动超时')
    const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(5000) })).json() as { type: string; webSocketDebuggerUrl: string }[]
    const target = targets.find((t) => t.type === 'page')
    if (!target) throw new ToolError('SCREENSHOT_FAILED', '找不到隔离页面')
    cdp = await Cdp.connect(target.webSocketDebuggerUrl)
    const client = cdp
    cdp.onEvent = (method, p) => {
      if (method === 'Target.attachedToTarget') {
        void client.send('Target.closeTarget', { targetId: p.targetInfo.targetId }).catch((e) => { asyncError = e })
      }
      if (method === 'Inspector.targetCrashed') { asyncError = new ToolError('SCREENSHOT_FAILED', '隔离页面已崩溃'); client.close() }
      if (method === 'Page.loadEventFired') loaded = true
      if (method === 'Runtime.consoleAPICalled' && ['warning', 'error'].includes(p.type)) add('console', p.type + ': ' + (p.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(' '))
      if (method === 'Runtime.exceptionThrown') add('exceptions', p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'JavaScript error')
      if (method === 'Network.requestWillBeSent') {
        if (requests.size >= 200) requests.delete(requests.keys().next().value!)
        requests.set(p.requestId, String(p.request?.url ?? '').slice(0, 500))
      }
      if (method === 'Network.loadingFailed') { add('network', (requests.get(p.requestId) ?? '') + ': ' + p.errorText); requests.delete(p.requestId) }
      if (method === 'Network.responseReceived' && p.response?.status >= 400) add('network', p.response.url + ': HTTP ' + p.response.status)
      if (method === 'Network.loadingFinished') requests.delete(p.requestId)
      if (method === 'Fetch.requestPaused') {
        let allowed = false
        try { localUrl(p.request.url); allowed = true } catch { /* forbid remote / file resources */ }
        void client.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId: p.requestId } : { requestId: p.requestId, errorReason: 'BlockedByClient' })
          .catch((e) => { asyncError = e })
      }
    }
    check()
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Inspector.enable')
    await cdp.send('Network.enable')
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
    await cdp.send('Page.setWebLifecycleState', { state: 'active' })
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: o.width, height: o.height, deviceScaleFactor: o.scale, mobile: false })
    // 仅工具专有页面：禁止新窗口入口，页面脚本无法拿到真实浏览器会话。
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.open = () => null; document.addEventListener("click", e => { const a=e.target.closest?.("a[target]"); if(a) a.target="_self"; }, true)' })
    const nav = await cdp.send('Page.navigate', { url })
    if (nav.errorText) throw new ToolError('SCREENSHOT_FAILED', nav.errorText)
    for (let i = 0; i < 100 && !loaded; i++) { if (asyncError) throw asyncError; await wait(50) }
    if (!loaded) throw new ToolError('TIMEOUT', '页面加载超时')
    await wait(o.waitMs)
    for (const action of o.actions ?? []) {
      check()
      if (asyncError) throw asyncError
      if (action.type === 'wait') { await wait(action.ms); continue }
      if (action.type === 'scroll') {
        await cdp.send('Runtime.evaluate', { expression: 'window.scrollBy(' + JSON.stringify(action.dx ?? 0) + ',' + JSON.stringify(action.dy) + ')' })
      } else {
        let x = action.x, y = action.y
        if (action.selector !== undefined) {
          const expression = '(() => { const e=document.querySelector(' + JSON.stringify(action.selector) + '); if(!e) return null; e.scrollIntoView({block:"center",inline:"center"}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}; })()'
          const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true })
          if (r.exceptionDetails) throw new ToolError('INVALID_ARGS', 'selector 无效')
          const rect = r.result?.value
          if (!rect || rect.w <= 0 || rect.h <= 0) throw new ToolError('PAGE_ACTION_FAILED', '找不到可点击的元素')
          x = rect.x; y = rect.y
        }
        if (x! >= o.width || y! >= o.height || x! < 0 || y! < 0) throw new ToolError('INVALID_ARGS', '点击坐标超出视口')
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      }
      await wait(50)
    }
    if (asyncError) throw asyncError
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    check()
    return { png: Buffer.from(shot.data, 'base64'), ...(o.diagnostics ? { diagnostics: result } : {}) }
  } catch (e) {
    try { check() } catch (stateError) { e = stateError }
    primaryError = e
    throw e
  } finally {
    try {
    clearTimeout(deadline)
    o.signal?.removeEventListener('abort', onAbort)
    if (cdp) { await cdp.send('Browser.close').catch(() => {}); cdp.close() }
    for (let i = 0; i < 20 && proc.exitCode === null && proc.signalCode === null; i++) await delay(50)
    // 父进程已退出不代表子进程也退出。Chromium 子进程携带本次独有的 profile 路径；
    // Windows 再扫描这个路径，POSIX 则清理本次独立进程组，绝不按浏览器名称全杀。
    if (process.platform === 'win32') {
      const literal = profile.replace(/'/g, "''")
      // 扫到就杀、杀完再扫，直到扫不到为止（最多 20 秒）。只杀一遍不够：taskkill 是异步的，
      // 机器忙的时候刚被杀的进程过几秒才消失，浏览器也可能在第一遍扫完之后才又起了子进程。
      // 到点还剩的话把进程名和 PID 打出来，报错里能看到是谁
      const scan = "@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.Name -ne 'powershell.exe' -and $_.CommandLine.Contains($needle) })"
      const script = "$needle='" + literal + "'; $until=(Get-Date).AddSeconds(20); do { $left=" + scan + "; if(!$left.Count){exit 0}; foreach($p in $left){ & taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null }; Start-Sleep -Milliseconds 400 } while((Get-Date) -lt $until); $left=" + scan + "; if(!$left.Count){exit 0}; Write-Output (($left | ForEach-Object { $_.Name + '#' + $_.ProcessId }) -join ','); exit 1"
      await new Promise<void>((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: CLEANUP_TIMEOUT_MS }, (error, stdout) => {
        if (!error) return resolve()
        // 说清是哪一种：机器忙、清理脚本没跑完，还是真的有进程杀不掉
        const why = error.killed ? `清理脚本 ${CLEANUP_TIMEOUT_MS / 1000} 秒内没跑完` : `还有进程没结束（${String(stdout).trim().slice(0, 200) || '未知'}）`
        reject(new ToolError('CLEANUP_FAILED', `隔离浏览器子进程清理失败：${why}`))
      }))
    } else if (proc.pid) {
      try { process.kill(-proc.pid, 'SIGKILL') } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e
      }
    }
    for (let i = 0; i < 40 && proc.exitCode === null && proc.signalCode === null; i++) await delay(50)
    } catch (cleanupError) {
      if (primaryError instanceof Error) throw new ToolError(primaryError instanceof ToolError ? primaryError.code : 'SCREENSHOT_FAILED', primaryError.message.replace(/^\w+: /, ''), { cleanup_error: String(cleanupError) })
      throw cleanupError
    }
  }
}
