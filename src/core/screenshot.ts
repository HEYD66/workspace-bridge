// screenshot 工具：截桌面窗口（Windows，PowerShell + user32/PrintWindow）或本地网页（无头 Edge / Chrome），
// 存成 PNG 给 AI 看界面。不依赖 Electron，headless 模式下也能用；测试通过 ScreenshotBackend 注入假实现。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { ToolError } from './fileTools'
import { interactPage, type PageAction, type PageDiagnostics } from './pageInteract'

export interface WindowInfo {
  /** 窗口句柄，只在 Bridge 内部用来二次定位，不返回给 AI */
  hwnd: number
  title: string
  /** 进程名，不带 .exe */
  process: string
  pid: number
  x: number
  y: number
  width: number
  height: number
  minimized: boolean
}

export interface WindowQuery {
  /** 标题包含（不区分大小写） */
  title?: string
  /** 进程名完全相同（不区分大小写，.exe 可带可不带） */
  processName?: string
  /** 截图宽度超过它就等比缩小；0 表示不缩 */
  maxWidth: number
}

export interface WindowShot {
  png: Buffer
  window: WindowInfo
  /** 输出图相对窗口实际像素的缩放比例（1 = 没缩） */
  scale: number
  /** print_window：窗口自己画出来的，被遮挡也完整；screen：退回到屏幕截取，被遮挡的部分会是上面的窗口 */
  method: 'print_window' | 'screen'
  /** 也匹配上、但没被选中的窗口 */
  otherMatches: WindowInfo[]
}

export interface PageQuery {
  url: string
  width: number
  height: number
  /** 等页面加载、脚本跑完的时间（浏览器的 virtual time budget） */
  waitMs: number
  /** 设备像素比，默认 1 */
  scale: number
  /** 仅隔离本机网页支持；省略时使用原有截图路径 */
  actions?: PageAction[]
  diagnostics?: boolean
  signal?: AbortSignal
}

export interface PageShot {
  png: Buffer
  /** 用的浏览器可执行文件 */
  browser: string
  diagnostics?: PageDiagnostics
}

export interface ScreenshotBackend {
  listWindows(): Promise<WindowInfo[]>
  captureWindow(q: WindowQuery): Promise<WindowShot>
  capturePage(q: PageQuery): Promise<PageShot>
}

// ---------- 纯逻辑（有单元测试） ----------

const normProcess = (s: string): string => s.trim().toLowerCase().replace(/\.exe$/, '')

/**
 * 按标题 / 进程名挑窗口：都给时两个条件都要满足；优先没最小化的，再挑面积最大的。
 * 找不到抛 WINDOW_NOT_FOUND（附上当前可见窗口，方便 AI 换条件）；只剩最小化的抛 WINDOW_MINIMIZED
 */
export function pickWindow(windows: WindowInfo[], q: { title?: string; processName?: string }): { chosen: WindowInfo; others: WindowInfo[] } {
  const title = q.title?.trim().toLowerCase()
  const proc = q.processName ? normProcess(q.processName) : undefined
  if (!title && !proc) throw new ToolError('INVALID_ARGS', '截窗口要给 window_title 或 process_name（可以先用 target=list_windows 看有哪些窗口）')
  const matches = windows.filter((w) => (!title || w.title.toLowerCase().includes(title)) && (!proc || normProcess(w.process) === proc))
  if (!matches.length) {
    throw new ToolError('WINDOW_NOT_FOUND', `没有找到${title ? `标题包含「${q.title}」` : ''}${title && proc ? '、' : ''}${proc ? `进程名为 ${proc}` : ''}的窗口`, {
      visible_windows: windows.slice(0, 30).map((w) => ({ title: w.title, process: w.process, minimized: w.minimized }))
    })
  }
  const usable = matches.filter((w) => !w.minimized && w.width > 0 && w.height > 0)
  if (!usable.length) {
    throw new ToolError('WINDOW_MINIMIZED', `匹配的窗口「${matches[0].title}」是最小化的，截不到内容；请用户把它还原后再截`)
  }
  const chosen = [...usable].sort((a, b) => b.width * b.height - a.width * a.height)[0]
  return { chosen, others: matches.filter((w) => w !== chosen) }
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/** 只允许本机网页：http(s) + localhost / 127.x / ::1。返回规范化后的地址 */
export function normalizeLocalUrl(input: string): string {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    throw new ToolError('INVALID_ARGS', `不是合法的网址：${input}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ToolError('URL_NOT_LOCAL', `只能截 http / https 的本地网页；工作区里的 HTML 文件请用 path 参数`)
  }
  if (!isLoopbackHost(u.hostname)) {
    throw new ToolError('URL_NOT_LOCAL', `只能截本机网页（localhost、127.0.0.1、[::1]），${u.hostname} 不行`)
  }
  if (u.username || u.password) throw new ToolError('INVALID_ARGS', '网址里不能带用户名或密码')
  return u.href
}

/** 无头浏览器截图的命令行参数（不经过 shell，网址放最后） */
export function browserArgs(o: { url: string; out: string; profileDir: string; width: number; height: number; waitMs: number; scale: number }): string[] {
  return [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--run-all-compositor-stages-before-draw',
    // 独立的临时配置目录：不会把请求交给用户已经开着的浏览器，也不碰用户的浏览器数据
    `--user-data-dir=${o.profileDir}`,
    `--window-size=${o.width},${o.height}`,
    `--force-device-scale-factor=${o.scale}`,
    `--virtual-time-budget=${o.waitMs}`,
    `--screenshot=${o.out}`,
    o.url
  ]
}

/** 找无头截图用的浏览器：WB_SCREENSHOT_BROWSER 优先，然后 Edge、Chrome、Chromium 的常见位置 */
export function findBrowser(env: NodeJS.ProcessEnv, exists: (p: string) => boolean, platform: NodeJS.Platform = process.platform): string | null {
  const candidates: string[] = []
  if (env.WB_SCREENSHOT_BROWSER) candidates.push(env.WB_SCREENSHOT_BROWSER)
  if (platform === 'win32') {
    const pf = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter((x): x is string => Boolean(x))
    for (const base of pf) candidates.push(path.win32.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    for (const base of pf) candidates.push(path.win32.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    )
  } else {
    candidates.push('/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium')
  }
  return candidates.find((p) => exists(p)) ?? null
}

/** PowerShell 助手的输出：最后一个 WBSHOT: 后面是 JSON；ok=false 转成 ToolError */
export function parseHelperOutput(stdout: string, stderr: string): Record<string, unknown> {
  const i = stdout.lastIndexOf('WBSHOT:')
  if (i < 0) {
    const tail = (stderr || stdout).trim().slice(-600)
    throw new ToolError('SCREENSHOT_FAILED', `截图助手没有返回结果${tail ? `：${tail}` : ''}`)
  }
  let r: Record<string, unknown>
  try {
    r = JSON.parse(stdout.slice(i + 7).trim()) as Record<string, unknown>
  } catch {
    throw new ToolError('SCREENSHOT_FAILED', '截图助手返回的结果解析不了')
  }
  if (r.ok !== true) {
    const code = typeof r.error === 'string' ? r.error : 'SCREENSHOT_FAILED'
    const msg: Record<string, string> = {
      WINDOW_GONE: '窗口已经关掉了，请重新截',
      WINDOW_MINIMIZED: '窗口是最小化的，截不到内容；请用户把它还原后再截',
      WINDOW_EMPTY: '窗口没有大小，截不到内容'
    }
    throw new ToolError(code, msg[code] ?? `截图失败：${String(r.message ?? '未知原因')}`)
  }
  return r
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
}

/**
 * 截工作区里的 HTML 文件时，不用 file://（页面能用 file:/// 引用工作区外的图片，等于绕过路径限制），
 * 而是临时起一个只监听 127.0.0.1 的静态服务，每个请求都走 read 回调（read_file 同一套路径守卫），
 * http 页面也加载不了 file:// 资源。fn 结束后服务关掉
 */
export async function withWorkspaceServer<T>(
  read: (rel: string) => Promise<Buffer>,
  entryRel: string,
  fn: (url: string) => Promise<T>
): Promise<T> {
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405).end()
          return
        }
        let rel = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname).replace(/^\/+/, '')
        if (rel === '' || rel.endsWith('/')) rel += 'index.html'
        const data = await read(rel)
        res.writeHead(200, { 'Content-Type': MIME[path.extname(rel).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
        res.end(req.method === 'HEAD' ? undefined : data)
      } catch {
        // 越界、受保护、不存在一律 404，不把原因暴露给页面
        if (!res.headersSent) res.writeHead(404)
        res.end()
      }
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  try {
    const { port } = server.address() as AddressInfo
    const encoded = entryRel
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/')
    return await fn(`http://127.0.0.1:${port}/${encoded}`)
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

// ---------- 跑外部进程 ----------

interface ProcResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    // Edge 会起一堆子进程，只杀父进程会留下孤儿
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {})
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已经退出
    }
  }
}

function runProcess(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const cap = (s: string, add: string) => (s.length > 200_000 ? s : s + add)
    child.stdout?.setEncoding('utf8').on('data', (d: string) => (stdout = cap(stdout, d)))
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr = cap(stderr, d)))
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, opts.timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

async function rmQuiet(p: string): Promise<void> {
  // 只删这次自己建的临时目录；浏览器刚退出时文件可能还被占用，多试几次
  await fsp.rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
}

// ---------- Windows 窗口截图助手（PowerShell 5.1 + Add-Type C#，只用 ASCII） ----------

const HELPER_PS1 = String.raw`$ErrorActionPreference = 'Stop'
try {
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class WbShot {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);

  static string Esc(string s) {
    StringBuilder b = new StringBuilder("\"");
    foreach (char c in (s ?? "")) {
      if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
      else if (c < 0x20 || c > 0x7e) { b.Append("\\u"); b.Append(((int)c).ToString("x4")); }
      else b.Append(c);
    }
    b.Append('"');
    return b.ToString();
  }
  static string Err(string code, string msg) { return "{\"ok\":false,\"error\":" + Esc(code) + ",\"message\":" + Esc(msg) + "}"; }
  static RECT Frame(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
    return r;
  }
  static bool Cloaked(IntPtr h) { int v; return DwmGetWindowAttribute(h, 14, out v, 4) == 0 && v != 0; }
  static string ProcName(uint pid) { try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; } }
  static string Info(IntPtr h) {
    int n = GetWindowTextLength(h);
    StringBuilder sb = new StringBuilder(n + 2);
    GetWindowText(h, sb, n + 2);
    uint pid; GetWindowThreadProcessId(h, out pid);
    RECT r = Frame(h);
    return "{\"hwnd\":" + h.ToInt64().ToString(CultureInfo.InvariantCulture) + ",\"title\":" + Esc(sb.ToString()) + ",\"process\":" + Esc(ProcName(pid))
      + ",\"pid\":" + pid + ",\"x\":" + r.L + ",\"y\":" + r.T + ",\"width\":" + (r.R - r.L) + ",\"height\":" + (r.B - r.T)
      + ",\"minimized\":" + (IsIconic(h) ? "true" : "false") + "}";
  }
  public static string List() {
    SetProcessDPIAware();
    List<string> items = new List<string>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || Cloaked(h) || GetWindowTextLength(h) == 0) return true;
      RECT r = Frame(h);
      if ((r.R - r.L <= 0 || r.B - r.T <= 0) && !IsIconic(h)) return true;
      items.Add(Info(h));
      return true;
    }, IntPtr.Zero);
    return "{\"ok\":true,\"windows\":[" + string.Join(",", items.ToArray()) + "]}";
  }
  static bool Blank(Bitmap b, int x, int y, int w, int hh) {
    int first = b.GetPixel(x + w / 2, y + hh / 2).ToArgb();
    for (int i = 1; i <= 8; i++) for (int j = 1; j <= 8; j++) {
      if (b.GetPixel(x + w * i / 9, y + hh * j / 9).ToArgb() != first) return false;
    }
    return (first & 0xFFFFFF) == 0;
  }
  public static string Capture(long hwnd, string outPath, int maxWidth) {
    SetProcessDPIAware();
    IntPtr h = new IntPtr(hwnd);
    if (!IsWindow(h)) return Err("WINDOW_GONE", "window no longer exists");
    if (IsIconic(h)) return Err("WINDOW_MINIMIZED", "window is minimized");
    RECT wr; GetWindowRect(h, out wr);
    RECT fr = Frame(h);
    int ww = wr.R - wr.L, wh = wr.B - wr.T;
    if (ww <= 0 || wh <= 0) return Err("WINDOW_EMPTY", "window has no size");
    int cx = Math.Max(0, fr.L - wr.L), cy = Math.Max(0, fr.T - wr.T);
    int cw = Math.Min(fr.R - fr.L, ww - cx), ch = Math.Min(fr.B - fr.T, wh - cy);
    if (cw <= 0 || ch <= 0) { cx = 0; cy = 0; cw = ww; ch = wh; }
    string method = "print_window";
    Bitmap shot;
    using (Bitmap full = new Bitmap(ww, wh, PixelFormat.Format32bppArgb)) {
      bool ok;
      using (Graphics g = Graphics.FromImage(full)) {
        IntPtr hdc = g.GetHdc();
        try { ok = PrintWindow(h, hdc, 2); } finally { g.ReleaseHdc(hdc); }
      }
      if (ok && !Blank(full, cx, cy, cw, ch)) {
        shot = full.Clone(new Rectangle(cx, cy, cw, ch), PixelFormat.Format32bppArgb);
      } else {
        method = "screen";
        shot = new Bitmap(cw, ch, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(shot)) { g.CopyFromScreen(fr.L, fr.T, 0, 0, new Size(cw, ch)); }
      }
    }
    double scale = 1.0;
    if (maxWidth > 0 && shot.Width > maxWidth) {
      scale = (double)maxWidth / shot.Width;
      int nh = Math.Max(1, (int)Math.Round(shot.Height * scale));
      Bitmap small = new Bitmap(maxWidth, nh, PixelFormat.Format32bppArgb);
      using (Graphics g = Graphics.FromImage(small)) {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.DrawImage(shot, 0, 0, maxWidth, nh);
      }
      shot.Dispose();
      shot = small;
    }
    int outW = shot.Width, outH = shot.Height;
    shot.Save(outPath, ImageFormat.Png);
    shot.Dispose();
    return "{\"ok\":true,\"method\":" + Esc(method) + ",\"scale\":" + scale.ToString("0.####", CultureInfo.InvariantCulture)
      + ",\"width\":" + outW + ",\"height\":" + outH + ",\"window\":" + Info(h) + "}";
  }
}
'@
  if ($env:WB_SS_MODE -eq 'list') { $r = [WbShot]::List() }
  else { $r = [WbShot]::Capture([long]$env:WB_SS_HWND, $env:WB_SS_OUT, [int]$env:WB_SS_MAXW) }
} catch {
  $m = ($_.Exception.Message -replace '[^\x20-\x7e]', '?')
  $r = '{"ok":false,"error":"HELPER_FAILED","message":' + (ConvertTo-Json $m -Compress) + '}'
}
[Console]::Out.Write('WBSHOT:' + $r)
`

const HELPER_TIMEOUT_MS = 30_000
const PAGE_TIMEOUT_MS = 30_000

function toWindowInfo(x: unknown): WindowInfo {
  const o = (x ?? {}) as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    hwnd: num(o.hwnd),
    title: typeof o.title === 'string' ? o.title : '',
    process: typeof o.process === 'string' ? o.process : '',
    pid: num(o.pid),
    x: num(o.x),
    y: num(o.y),
    width: num(o.width),
    height: num(o.height),
    minimized: o.minimized === true
  }
}

/** 真正截图：Windows 窗口用 PowerShell 助手，网页用无头 Edge / Chrome */
export class SystemScreenshotBackend implements ScreenshotBackend {
  constructor(private readonly opts: { env?: NodeJS.ProcessEnv; tmpRoot?: string } = {}) {}

  private async tempDir(): Promise<string> {
    return fsp.mkdtemp(path.join(this.opts.tmpRoot ?? os.tmpdir(), 'wb-shot-'))
  }

  private async helper(dir: string, env: Record<string, string>): Promise<Record<string, unknown>> {
    if (process.platform !== 'win32') throw new ToolError('UNSUPPORTED_PLATFORM', '截窗口目前只支持 Windows；网页可以用 target=page')
    const script = path.join(dir, 'wbshot.ps1')
    await fsp.writeFile(script, HELPER_PS1, 'ascii')
    let r: ProcResult
    try {
      r = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        env: { ...(this.opts.env ?? process.env), ...env },
        timeoutMs: HELPER_TIMEOUT_MS
      })
    } catch (e) {
      throw new ToolError('SCREENSHOT_FAILED', `启动 PowerShell 失败：${(e as Error).message}`)
    }
    if (r.timedOut) throw new ToolError('TIMEOUT', `截图助手 ${HELPER_TIMEOUT_MS / 1000} 秒没有完成`)
    return parseHelperOutput(r.stdout, r.stderr)
  }

  async listWindows(): Promise<WindowInfo[]> {
    const dir = await this.tempDir()
    try {
      const r = await this.helper(dir, { WB_SS_MODE: 'list' })
      return (Array.isArray(r.windows) ? r.windows : []).map(toWindowInfo)
    } finally {
      await rmQuiet(dir)
    }
  }

  async captureWindow(q: WindowQuery): Promise<WindowShot> {
    const { chosen, others } = pickWindow(await this.listWindows(), q)
    const dir = await this.tempDir()
    try {
      const out = path.join(dir, 'shot.png')
      const r = await this.helper(dir, { WB_SS_MODE: 'capture', WB_SS_HWND: String(chosen.hwnd), WB_SS_OUT: out, WB_SS_MAXW: String(q.maxWidth) })
      const png = await fsp.readFile(out)
      return {
        png,
        window: r.window ? toWindowInfo(r.window) : chosen,
        scale: typeof r.scale === 'number' ? r.scale : 1,
        method: r.method === 'screen' ? 'screen' : 'print_window',
        otherMatches: others
      }
    } finally {
      await rmQuiet(dir)
    }
  }

  async capturePage(q: PageQuery): Promise<PageShot> {
    const env = this.opts.env ?? process.env
    const browser = findBrowser(env, (p) => fs.existsSync(p))
    if (!browser) {
      throw new ToolError('BROWSER_NOT_FOUND', '没找到 Edge / Chrome，截不了网页；可以设置环境变量 WB_SCREENSHOT_BROWSER 指向浏览器可执行文件')
    }
    const dir = await this.tempDir()
    let primaryError: unknown
    try {
      if (q.actions !== undefined || q.diagnostics) {
        return { ...(await interactPage({ ...q, browser, dir, env, localUrl: normalizeLocalUrl })), browser }
      }
      const out = path.join(dir, 'page.png')
      const profileDir = path.join(dir, 'profile')
      let r: ProcResult
      try {
        r = await runProcess(browser, browserArgs({ url: q.url, out, profileDir, width: q.width, height: q.height, waitMs: q.waitMs, scale: q.scale }), {
          env,
          timeoutMs: PAGE_TIMEOUT_MS + q.waitMs
        })
      } catch (e) {
        throw new ToolError('SCREENSHOT_FAILED', `启动浏览器失败：${(e as Error).message}`)
      }
      const png = await fsp.readFile(out).catch(() => null)
      if (!png || !png.length) {
        if (r.timedOut) throw new ToolError('TIMEOUT', `浏览器 ${(PAGE_TIMEOUT_MS + q.waitMs) / 1000} 秒没有截完`)
        const tail = r.stderr.trim().split(/\r?\n/).slice(-5).join('\n')
        throw new ToolError('SCREENSHOT_FAILED', `浏览器没有生成截图（退出码 ${r.code}）${tail ? `：${tail}` : ''}`)
      }
      return { png, browser }
    } catch (e) {
      primaryError = e
      throw e
    } finally {
      if (q.actions !== undefined || q.diagnostics) {
        try {
          await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        } catch (cleanupError) {
          if (primaryError instanceof Error) throw new ToolError(primaryError instanceof ToolError ? primaryError.code : 'SCREENSHOT_FAILED', primaryError.message.replace(/^\w+: /, ''), { cleanup_error: String(cleanupError) })
          throw cleanupError
        }
      } else await rmQuiet(dir)
    }
  }
}
