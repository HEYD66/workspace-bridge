// screenshot 工具：纯逻辑（挑窗口、本地网址校验、浏览器参数、助手输出解析、临时静态服务）
// + 真实 Bridge / MCP 客户端的集成测试（截图实现换成假的，不真的起 PowerShell 和浏览器）
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import {
  browserArgs,
  findBrowser,
  normalizeLocalUrl,
  parseHelperOutput,
  pickWindow,
  withWorkspaceServer,
  type PageQuery,
  type ScreenshotBackend,
  type WindowInfo,
  type WindowQuery
} from '../src/core/screenshot'
import { TOOL_NAMES } from '../src/shared/tools'

// 1×1 的 PNG
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

const win = (over: Partial<WindowInfo>): WindowInfo => ({
  hwnd: 1,
  title: 'Untitled',
  process: 'notepad',
  pid: 100,
  x: 0,
  y: 0,
  width: 800,
  height: 600,
  minimized: false,
  ...over
})

/** 断言抛出指定错误码的 ToolError，返回错误对象 */
function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return (e as { code?: string }).code ?? 'NO_CODE'
  }
  return 'NO_THROW'
}

describe('pickWindow', () => {
  const wins = [
    win({ hwnd: 1, title: 'arena桌面端 - 小窗', process: 'Arena', width: 400, height: 300 }),
    win({ hwnd: 2, title: 'Arena桌面端', process: 'Arena', width: 1600, height: 900 }),
    win({ hwnd: 3, title: 'arena桌面端（最小化）', process: 'Arena', width: 160, height: 28, minimized: true }),
    win({ hwnd: 4, title: 'Visual Studio Code', process: 'Code' })
  ]

  it('标题包含、不区分大小写，多个匹配取最大的、跳过最小化的', () => {
    const r = pickWindow(wins, { title: 'ARENA桌面端' })
    expect(r.chosen.hwnd).toBe(2)
    expect(r.others.map((w) => w.hwnd).sort()).toEqual([1, 3])
  })

  it('进程名完全匹配，.exe 可带可不带；和标题同时给时两个都要满足', () => {
    expect(pickWindow(wins, { processName: 'code.exe' }).chosen.hwnd).toBe(4)
    expect(pickWindow(wins, { processName: 'arena', title: '小窗' }).chosen.hwnd).toBe(1)
    expect(codeOf(() => pickWindow(wins, { processName: 'arena', title: 'Visual' }))).toBe('WINDOW_NOT_FOUND')
    // 进程名不做包含匹配
    expect(codeOf(() => pickWindow(wins, { processName: 'aren' }))).toBe('WINDOW_NOT_FOUND')
  })

  it('找不到时附上可见窗口；只剩最小化的报 WINDOW_MINIMIZED；两个条件都没给报 INVALID_ARGS', () => {
    try {
      pickWindow(wins, { title: '不存在的窗口' })
      expect.unreachable()
    } catch (e) {
      const err = e as { code: string; data?: { visible_windows: { title: string }[] } }
      expect(err.code).toBe('WINDOW_NOT_FOUND')
      expect(err.data?.visible_windows.map((w) => w.title)).toContain('Visual Studio Code')
    }
    expect(codeOf(() => pickWindow(wins, { title: '最小化' }))).toBe('WINDOW_MINIMIZED')
    expect(codeOf(() => pickWindow(wins, {}))).toBe('INVALID_ARGS')
    expect(codeOf(() => pickWindow(wins, { title: '   ' }))).toBe('INVALID_ARGS')
  })
})

describe('normalizeLocalUrl', () => {
  it('允许 localhost / 127.x / [::1] / *.localhost 的 http(s)', () => {
    expect(normalizeLocalUrl('http://localhost:5173')).toBe('http://localhost:5173/')
    expect(normalizeLocalUrl(' https://127.0.0.1:8443/a?b=1 ')).toBe('https://127.0.0.1:8443/a?b=1')
    expect(normalizeLocalUrl('http://127.1.2.3/')).toBe('http://127.1.2.3/')
    expect(normalizeLocalUrl('http://[::1]:3000/x')).toBe('http://[::1]:3000/x')
    expect(normalizeLocalUrl('http://app.localhost:3000/')).toBe('http://app.localhost:3000/')
  })

  it('拒绝外网、局域网、file:、javascript:、带账号密码的地址和乱写的地址', () => {
    expect(codeOf(() => normalizeLocalUrl('https://example.com/'))).toBe('URL_NOT_LOCAL')
    expect(codeOf(() => normalizeLocalUrl('http://192.168.1.2:3000/'))).toBe('URL_NOT_LOCAL')
    expect(codeOf(() => normalizeLocalUrl('http://localhost.evil.com/'))).toBe('URL_NOT_LOCAL')
    expect(codeOf(() => normalizeLocalUrl('http://127.0.0.1.nip.io/'))).toBe('URL_NOT_LOCAL')
    expect(codeOf(() => normalizeLocalUrl('file:///C:/secret.html'))).toBe('URL_NOT_LOCAL')
    expect(codeOf(() => normalizeLocalUrl('javascript:alert(1)'))).toBe('URL_NOT_LOCAL')
    expect(codeOf(() => normalizeLocalUrl('http://user:pw@localhost/'))).toBe('INVALID_ARGS')
    expect(codeOf(() => normalizeLocalUrl('not a url'))).toBe('INVALID_ARGS')
  })
})

describe('browserArgs / findBrowser', () => {
  it('无头参数：独立配置目录、视口、等待时间、输出文件，网址放最后', () => {
    const args = browserArgs({ url: 'http://localhost:5173/', out: 'C:\\t\\p.png', profileDir: 'C:\\t\\profile', width: 1280, height: 800, waitMs: 1500, scale: 2 })
    expect(args[0]).toBe('--headless=new')
    expect(args).toContain('--user-data-dir=C:\\t\\profile')
    expect(args).toContain('--window-size=1280,800')
    expect(args).toContain('--force-device-scale-factor=2')
    expect(args).toContain('--virtual-time-budget=1500')
    expect(args).toContain('--screenshot=C:\\t\\p.png')
    expect(args[args.length - 1]).toBe('http://localhost:5173/')
  })

  it('WB_SCREENSHOT_BROWSER 优先；Windows 上先找 Edge 再找 Chrome；都没有返回 null', () => {
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    const env = { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files' }
    expect(findBrowser({ ...env, WB_SCREENSHOT_BROWSER: 'D:\\b.exe' }, () => true, 'win32')).toBe('D:\\b.exe')
    expect(findBrowser(env, (p) => p === edge || p === chrome, 'win32')).toBe(edge)
    expect(findBrowser(env, (p) => p === chrome, 'win32')).toBe(chrome)
    expect(findBrowser(env, () => false, 'win32')).toBeNull()
    expect(findBrowser({}, (p) => p === '/usr/bin/chromium', 'linux')).toBe('/usr/bin/chromium')
  })
})

describe('parseHelperOutput', () => {
  it('取最后一个 WBSHOT: 后面的 JSON；ok=false 转成对应错误码', () => {
    expect(parseHelperOutput('noise\nWBSHOT:{"ok":true,"windows":[]}', '')).toEqual({ ok: true, windows: [] })
    expect(codeOf(() => parseHelperOutput('WBSHOT:{"ok":false,"error":"WINDOW_GONE","message":"x"}', ''))).toBe('WINDOW_GONE')
    expect(codeOf(() => parseHelperOutput('WBSHOT:{"ok":false,"error":"HELPER_FAILED","message":"boom"}', ''))).toBe('HELPER_FAILED')
    expect(codeOf(() => parseHelperOutput('', 'Add-Type : compile error'))).toBe('SCREENSHOT_FAILED')
    expect(codeOf(() => parseHelperOutput('WBSHOT:{broken', ''))).toBe('SCREENSHOT_FAILED')
  })
})

describe('withWorkspaceServer', () => {
  const get = (url: string): Promise<{ status: number; type?: string; body: string }> =>
    new Promise((resolve, reject) => {
      http
        .get(url, (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (d: string) => (body += d))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body }))
        })
        .on('error', reject)
    })

  it('每个请求都走 read 回调；读不了一律 404；目录给 index.html；结束后关掉服务', async () => {
    const files: Record<string, string> = { 'web/index.html': '<h1>hi</h1>', 'web/app.css': 'h1{}', 'web/中文.html': '<p>zh</p>' }
    const asked: string[] = []
    const read = async (rel: string) => {
      asked.push(rel)
      if (!(rel in files)) throw new Error('nope')
      return Buffer.from(files[rel])
    }
    let entryUrl = ''
    const out = await withWorkspaceServer(read, 'web/中文.html', async (u) => {
      entryUrl = u
      expect(u).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/web\/%E4%B8%AD%E6%96%87\.html$/)
      const origin = new URL(u).origin
      const page = await get(u)
      expect(page).toMatchObject({ status: 200, body: '<p>zh</p>' })
      expect(page.type).toContain('text/html')
      expect((await get(`${origin}/web/app.css`)).type).toContain('text/css')
      expect((await get(`${origin}/web/`)).body).toBe('<h1>hi</h1>')
      expect((await get(`${origin}/web/../../secret.txt`)).status).toBe(404)
      expect((await get(`${origin}/missing.js`)).status).toBe(404)
      return 'done'
    })
    expect(out).toBe('done')
    expect(asked).toContain('web/index.html')
    // URL 规范化后 ../ 被吃掉，回调看到的是 secret.txt，由回调（路径守卫）决定能不能读
    expect(asked).toContain('secret.txt')
    await expect(get(entryUrl)).rejects.toThrow()
  })
})

// ---------- 集成：真实 Bridge + MCP 客户端，假截图实现 ----------

class FakeShots implements ScreenshotBackend {
  windows: WindowInfo[] = [win({ hwnd: 7, title: 'arena桌面端', process: 'arena', width: 1600, height: 900 })]
  calls: string[] = []
  pages: PageQuery[] = []
  pageBodies: string[] = []
  async listWindows(): Promise<WindowInfo[]> {
    this.calls.push('list')
    return this.windows
  }
  async captureWindow(q: WindowQuery) {
    this.calls.push('window')
    const { chosen, others } = pickWindow(this.windows, q)
    return { png: PNG_1x1, window: chosen, scale: 0.5, method: 'print_window' as const, otherMatches: others }
  }
  async capturePage(q: PageQuery) {
    this.calls.push('page')
    this.pages.push(q)
    // 模拟浏览器：真的去请求一次页面，确认临时服务能把工作区文件给出去
    if (q.url.startsWith('http://127.0.0.1:')) {
      const body = await new Promise<string>((resolve, reject) => {
        http
          .get(q.url, (res) => {
            let b = ''
            res.setEncoding('utf8')
            res.on('data', (d: string) => (b += d))
            res.on('end', () => resolve(`${res.statusCode}:${b}`))
          })
          .on('error', reject)
      })
      this.pageBodies.push(body)
    }
    return { png: PNG_1x1, browser: 'fake' }
  }
}

let base: string
let root: string
let bridge: Bridge
let url: string
let shots: FakeShots
const clients: Client[] = []

interface Result {
  isError: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  images: { data: string; mimeType: string }[]
}

async function join(name: string, roleId?: string): Promise<Client> {
  const agent = bridge.createAgent(name, roleId)
  const c = new Client({ name: 'screenshot-test', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${agent.token}` } } }))
  clients.push(c)
  return c
}

async function call(c: Client, args: Record<string, unknown>): Promise<Result> {
  const r = await c.callTool({ name: 'screenshot', arguments: args })
  const parts = r.content as { type: string; text?: string; data?: string; mimeType?: string }[]
  const body = parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').find((t) => !t.startsWith('【通知】')) ?? ''
  let data: unknown = body
  try {
    data = JSON.parse(body)
  } catch {
    // 不是 JSON 就保留原文
  }
  const images = parts.filter((p) => p.type === 'image').map((p) => ({ data: p.data ?? '', mimeType: p.mimeType ?? '' }))
  return { isError: Boolean(r.isError), data, images }
}

const code = (r: Result): string => (r.isError ? (typeof r.data === 'object' ? r.data.error : 'SDK_ERROR') : 'OK')

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-shot-test-'))
  root = path.join(base, 'ws')
  fs.mkdirSync(path.join(root, 'web'), { recursive: true })
  fs.writeFileSync(path.join(root, 'web', 'index.html'), '<h1>arena</h1>')
  fs.writeFileSync(path.join(root, 'web', 'shot.png'), 'old')
  shots = new FakeShots()
  bridge = new Bridge({
    dataDir: path.join(base, 'data'),
    workspaceRoot: root,
    port: 0,
    userSkillsDir: path.join(base, 'user-skills'),
    screenshots: shots
  })
  await bridge.start()
  url = bridge.getState().mcpUrl
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  await bridge.stop()
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

describe('screenshot 工具', () => {
  it('在工具目录里，默认职位能看到', async () => {
    expect(TOOL_NAMES).toContain('screenshot')
    const c = await join('Alice')
    expect((await c.listTools()).tools.map((t) => t.name)).toContain('screenshot')
  })

  it('截窗口：附上图片，返回窗口信息和缩放比例，不暴露窗口句柄', async () => {
    const c = await join('Alice')
    const r = await call(c, { target: 'window', window_title: 'ARENA' })
    expect(code(r)).toBe('OK')
    expect(r.data).toMatchObject({ target: 'window', format: 'png', width: 1, height: 1, scale: 0.5, method: 'print_window', image_attached: true })
    expect(r.data.window).toMatchObject({ title: 'arena桌面端', process: 'arena' })
    expect(r.data.window.hwnd).toBeUndefined()
    expect(r.images).toEqual([{ data: PNG_1x1.toString('base64'), mimeType: 'image/png' }])
  })

  it('列窗口；截窗口不给条件、找不到窗口都报错', async () => {
    const c = await join('Alice')
    const list = await call(c, { target: 'list_windows' })
    expect(list.data.count).toBe(1)
    expect(list.data.windows[0]).toEqual(expect.objectContaining({ title: 'arena桌面端' }))
    expect(list.data.windows[0].hwnd).toBeUndefined()
    expect(code(await call(c, { target: 'window' }))).toBe('INVALID_ARGS')
    expect(code(await call(c, { target: 'window', window_title: 'nope' }))).toBe('WINDOW_NOT_FOUND')
  })

  it('截网页：只允许本机地址；url 和 path 二选一；默认视口 1280×800', async () => {
    const c = await join('Alice')
    const ok = await call(c, { target: 'page', url: 'http://localhost:5173' })
    expect(code(ok)).toBe('OK')
    expect(shots.pages[0]).toMatchObject({ url: 'http://localhost:5173/', width: 1280, height: 800, waitMs: 1500, scale: 1 })
    expect(code(await call(c, { target: 'page', url: 'https://example.com' }))).toBe('URL_NOT_LOCAL')
    expect(code(await call(c, { target: 'page' }))).toBe('INVALID_ARGS')
    expect(code(await call(c, { target: 'page', url: 'http://localhost', path: 'web/index.html' }))).toBe('INVALID_ARGS')
    expect(shots.pages).toHaveLength(1)
  })

  it('截工作区里的 HTML：经临时本地服务打开，越界路径被拒', async () => {
    const c = await join('Alice')
    const r = await call(c, { target: 'page', path: 'web/index.html', width: 390, height: 844 })
    expect(code(r)).toBe('OK')
    expect(r.data.path).toBe('web/index.html')
    expect(shots.pages[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/web\/index\.html$/)
    expect(shots.pageBodies[0]).toBe('200:<h1>arena</h1>')
    expect(code(await call(c, { target: 'page', path: 'web/missing.html' }))).toBe('NOT_FOUND')
    expect((await call(c, { target: 'page', path: '../outside.html' })).isError).toBe(true)
    expect(shots.pages).toHaveLength(1)
  })

  it('save_path：存进工作区；不覆盖已有文件；必须 .png；有职位的 AI 也能存', async () => {
    const c = await join('Alice')
    const r = await call(c, { target: 'window', window_title: 'arena', save_path: 'web/new-shot.png' })
    expect(code(r)).toBe('OK')
    expect(r.data.saved_to).toBe('web/new-shot.png')
    expect(fs.readFileSync(path.join(root, 'web', 'new-shot.png')).equals(PNG_1x1)).toBe(true)

    expect(code(await call(c, { target: 'window', window_title: 'arena', save_path: 'web/shot.png' }))).toBe('ALREADY_EXISTS')
    expect(fs.readFileSync(path.join(root, 'web', 'shot.png'), 'utf8')).toBe('old')
    expect(code(await call(c, { target: 'window', window_title: 'arena', save_path: 'web/x.jpg' }))).toBe('INVALID_ARGS')
    expect((await call(c, { target: 'window', window_title: 'arena', save_path: '../x.png' })).isError).toBe(true)

    // 以前被职位挡住的（经理只读文件）现在也能存
    const boss = await join('Boss', 'manager')
    expect(code(await call(boss, { target: 'window', window_title: 'arena', save_path: 'web/boss.png' }))).toBe('OK')
    expect(fs.existsSync(path.join(root, 'web', 'boss.png'))).toBe(true)
  })

  it('include_image=false 不附图', async () => {
    const c = await join('Alice')
    const r = await call(c, { target: 'window', window_title: 'arena', include_image: false })
    expect(r.images).toHaveLength(0)
    expect(r.data.image_attached).toBe(false)
    expect(r.data.note).toBeUndefined()
  })

  it('截窗口、列窗口、截网页都不用审批，直接执行；参数不全照样报错', async () => {
    const c = await join('Fresh')
    expect(code(await call(c, { target: 'window', window_title: 'arena' }))).toBe('OK')
    expect(shots.calls).toContain('window')
    expect(code(await call(c, { target: 'list_windows' }))).toBe('OK')
    expect(shots.calls).toContain('list')
    // 用 localhost：假实现对 http://127.0.0.1: 开头的网址会真去请求（那是给工作区 HTML 临时服务准备的），3000 端口没人听就会 ECONNREFUSED
    expect(code(await call(c, { target: 'page', url: 'http://localhost:3000/' }))).toBe('OK')
    expect(code(await call(c, { target: 'window' }))).toBe('INVALID_ARGS')
    // 活动流里没有等待审批的事件
    expect(bridge.recentEvents().some((e) => /审批|批准/.test(`${e.summary ?? ''}${e.error ?? ''}`))).toBe(false)
  })
})
