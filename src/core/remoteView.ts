import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'

/**
 * 远端查看：把工作台界面开给手机 / 平板的浏览器。
 *
 * - 默认只监听 127.0.0.1 的一个随机端口，对外靠隧道；和 AI 用的 MCP 端口分开，开关它不影响 AI 的链接
 * - 用户勾了「局域网」时监听所有网卡（start('0.0.0.0')），同一个 Wi‑Fi / 路由器下的设备用 http://<这台电脑的地址>:端口 直接进，不经过外网。
 *   口令、cookie、Origin 核对和经隧道进来时一样；只是 http 不加密，cookie 也就不带 Secure
 * - 入口是 /rv/<口令>：口令对了发一个只在这次开启期间有效的 cookie，再跳到 /；之后的请求只认 cookie
 * - 界面文件原样提供；界面调后端走 POST /rv-api/invoke 和 /rv-api/send，后端推送走 GET /rv-api/events 长轮询
 *   （临时隧道会把事件流攒着不发，长轮询每次都是一个完整的响应，不受影响）
 * - 关掉（stop）以后口令和 cookie 一起作废，再开是新的口令
 * - 「重启后保留」（RemotePrefs.keep）：开着的时候把端口、口令和已经进来的设备记在数据目录的 remote-view-kept.json 里，
 *   工作台下次启动时 start(host, 记录) 原样接着开，手机上的链接和已经打开的页面照旧能用；用户点关闭或换链接时记录一起删掉
 *
 * 这个文件不依赖 Electron，调用哪个后端函数由 invoke / send 两个回调决定。
 */

/** 界面资源的 MIME，缺的类型按二进制处理就够用 */
export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
}

const COOKIE = 'wb_rv'
/** 请求体上限：群聊图片是 base64 放在 JSON 里传的 */
const MAX_BODY_BYTES = 32 * 1024 * 1024
/** 推送缓冲：最多留这么多条、这么多字节，浏览器断线几秒再连上不丢事件；超出就让浏览器整页重新取状态 */
const MAX_EVENTS = 2000
const MAX_EVENT_BYTES = 8 * 1024 * 1024
/** 长轮询一次最多挂多久（毫秒）。隧道一般 100 秒断空闲连接，留足余量 */
const POLL_WAIT_MS = 25_000

export interface RemoteViewOptions {
  /** 界面文件所在目录（构建产物里的 renderer） */
  staticRoot: string
  /** 调一个有返回值的后端通道；通道不存在或不允许时抛错 */
  invoke(channel: string, args: unknown[]): unknown
  /** 调一个没有返回值的后端通道（终端打字、改大小） */
  send(channel: string, args: unknown[]): void
  /** 默认 127.0.0.1 */
  host?: string
  /** 默认 0（系统挑一个空闲端口） */
  port?: number
  /** 有人用口令进来时调用（界面上的「打开过几次」要跟着变） */
  onVisit?: () => void
  /** 测试用：长轮询最长等待，默认 25 秒 */
  pollWaitMs?: number
}

export interface RemoteViewInfo {
  running: boolean
  port?: number
  /** 监听的地址：127.0.0.1（只有本机和隧道进得来）或 0.0.0.0（局域网也进得来） */
  host?: string
  /** 入口路径 /rv/<口令>，前面拼上隧道地址或 http://127.0.0.1:端口 就是完整链接 */
  entryPath?: string
  startedAt?: number
  /** 这次开启以来用口令进来过几次 */
  visits: number
  lastVisitAt?: number
}

interface PushEvent {
  seq: number
  channel: string
  args: unknown[]
  bytes: number
}

/** 远端查看怎么开：记在数据目录的 remote-view.json 里，下次开启还按这个来 */
export interface RemotePrefs {
  /** 申请公网地址（Cloudflare 临时隧道） */
  tunnel: boolean
  /** 同一个局域网里的设备可以直接进 */
  lan: boolean
  /** 重启后保留：工作台重启以后自己接着开，链接不变。没开时不写这一项 */
  keep?: boolean
}

export const DEFAULT_REMOTE_PREFS: RemotePrefs = { tunnel: true, lan: false }

/** 读不到、格式不对都按默认（公网开、局域网关）；两个都关没有意义，也按默认 */
export function readRemotePrefs(file: string): RemotePrefs {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RemotePrefs> | null
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_REMOTE_PREFS }
    const keep = raw.keep === true ? { keep: true } : {}
    const prefs: RemotePrefs = { tunnel: raw.tunnel !== false, lan: raw.lan === true, ...keep }
    return prefs.tunnel || prefs.lan ? prefs : { ...DEFAULT_REMOTE_PREFS, ...keep }
  } catch {
    return { ...DEFAULT_REMOTE_PREFS }
  }
}

export function writeRemotePrefs(file: string, prefs: RemotePrefs): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ tunnel: prefs.tunnel, lan: prefs.lan, ...(prefs.keep ? { keep: true } : {}) }, null, 2))
  } catch {
    // 存不了就只在这次打开期间有效
  }
}

/** 接着上次开：端口、口令、已经进来的设备（cookie）都用原来的 */
export interface RemoteResume {
  port: number
  passcode: string
  sessions: string[]
  startedAt: number
}

/** 「重启后保留」开着时记下来的东西（remote-view-kept.json）。里面有口令，和 config.json 一样只该这台电脑的用户读得到 */
export interface RemoteKeptRecord extends RemoteResume {
  /** 当时开着哪几种访问方式 */
  tunnel: boolean
  lan: boolean
}

/** 记录里最多留这么多台设备的 cookie（最近进来的） */
export const MAX_KEPT_SESSIONS = 50
const SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/

/** 没有记录、读不了、哪一项不对都当没有 */
export function readRemoteKept(file: string): RemoteKeptRecord | undefined {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RemoteKeptRecord> | null
    if (!r || typeof r !== 'object') return undefined
    if (!Number.isInteger(r.port) || r.port! <= 0 || r.port! > 65535) return undefined
    if (typeof r.passcode !== 'string' || !SECRET_RE.test(r.passcode)) return undefined
    const sessions = Array.isArray(r.sessions) ? r.sessions.filter((s): s is string => typeof s === 'string' && SECRET_RE.test(s)).slice(-MAX_KEPT_SESSIONS) : []
    const tunnel = r.tunnel !== false
    const lan = r.lan === true
    if (!tunnel && !lan) return undefined
    return { port: r.port!, passcode: r.passcode, sessions, startedAt: typeof r.startedAt === 'number' && Number.isFinite(r.startedAt) ? r.startedAt : Date.now(), tunnel, lan }
  } catch {
    return undefined
  }
}

export function writeRemoteKept(file: string, rec: RemoteKeptRecord): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ ...rec, sessions: rec.sessions.slice(-MAX_KEPT_SESSIONS) }), { mode: 0o600 })
  } catch {
    // 存不了：这次重启后就得重新开
  }
}

export function removeRemoteKept(file: string): void {
  try {
    fs.rmSync(file, { force: true })
  } catch {
    // 忽略
  }
}

/** 常见的家用 / 办公室内网段排前面：192.168、10、172.16–31，其余的在后 */
function lanRank(ip: string): number {
  if (ip.startsWith('192.168.')) return 0
  if (ip.startsWith('10.')) return 1
  const m = ip.match(/^172\.(\d+)\./)
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return 2
  return 3
}

/**
 * 这台电脑在局域网里的 IPv4 地址（不要回环、169.254 链路本地）。
 * 装了虚拟机、WSL、VPN 的电脑会有好几个，哪个是 Wi‑Fi 的这里分不出来，都列出来让人挑
 */
export function lanAddresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out: string[] = []
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address)
    }
  }
  const uniq = [...new Set(out)]
  return uniq.map((ip, i) => ({ ip, i })).sort((x, y) => lanRank(x.ip) - lanRank(y.ip) || x.i - y.i).map((x) => x.ip)
}

function safeEqual(a: string, b: string): boolean {
  const x = crypto.createHash('sha256').update(a).digest()
  const y = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(x, y)
}

function readCookie(req: http.IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return undefined
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('BODY_TOO_LARGE'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const BASE_HEADERS = {
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow'
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function sendPage(res: http.ServerResponse, status: number, message: string): void {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Workspace Bridge</title></head><body style="margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#0d1117;color:#c9d1d9;font:16px system-ui,sans-serif"><p style="padding:24px;text-align:center">${message}</p></body></html>`
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

export class RemoteViewServer {
  private server: http.Server | undefined
  private sockets = new Set<Socket>()
  private passcode = ''
  private sessions = new Set<string>()
  private port: number | undefined
  private host: string | undefined
  private startedAt: number | undefined
  private visits = 0
  private lastVisitAt: number | undefined
  private events: PushEvent[] = []
  private eventBytes = 0
  private seq = 0
  /** 缓冲里已经丢掉的最后一条的序号；浏览器的位置比它还旧就得整页重新取状态 */
  private dropped = 0
  private waiters = new Set<() => void>()

  constructor(private readonly opts: RemoteViewOptions) {}

  info(): RemoteViewInfo {
    if (!this.server) return { running: false, visits: 0 }
    return { running: true, port: this.port, host: this.host, entryPath: `/rv/${this.passcode}`, startedAt: this.startedAt, visits: this.visits, lastVisitAt: this.lastVisitAt }
  }

  /**
   * 开启：新口令、新端口。已经开着就原样返回（监听地址不会跟着变，要换先 stop）。
   * host 不给时用构造时的（默认 127.0.0.1）；要让局域网里的设备进来给 '0.0.0.0'。
   * resume：接着上次开（工作台重启后）。口令和已经发出去的 cookie 照旧有效；端口尽量用原来的，被别的程序占了就换一个
   * （换了端口，局域网链接和公网地址就跟着变了，口令不变）
   */
  async start(host?: string, resume?: RemoteResume): Promise<RemoteViewInfo> {
    if (this.server) return this.info()
    const listenHost = host ?? this.opts.host ?? '127.0.0.1'
    const listen = async (port: number): Promise<http.Server> => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch(() => {
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'INTERNAL' })
          else res.end()
        })
      })
      server.on('connection', (s) => {
        this.sockets.add(s)
        s.on('close', () => this.sockets.delete(s))
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, listenHost, () => {
          server.off('error', reject)
          resolve()
        })
      })
      return server
    }
    let server: http.Server
    if (resume) {
      try {
        server = await listen(resume.port)
      } catch {
        server = await listen(this.opts.port ?? 0)
      }
    } else server = await listen(this.opts.port ?? 0)
    // 等监听的这会儿另一处已经开好了：用那一个
    if (this.server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      return this.info()
    }
    this.server = server
    this.port = (server.address() as AddressInfo).port
    this.host = listenHost
    this.passcode = resume ? resume.passcode : crypto.randomBytes(24).toString('base64url')
    this.sessions = new Set(resume ? resume.sessions : [])
    this.startedAt = resume ? resume.startedAt : Date.now()
    this.visits = 0
    this.lastVisitAt = undefined
    if (resume) {
      // 重启前就开着的页面手里的推送位置是上一个进程的编号：从一个比以前都大的数重新编，它们一来就会被告知整页重新取状态
      this.seq = Math.max(this.seq, Date.now())
      this.dropped = this.seq
    }
    return this.info()
  }

  /** 现在开着的话，下次接着开要用的东西（给「重启后保留」存盘）；没开是 undefined */
  resumeState(): RemoteResume | undefined {
    if (!this.server || this.port === undefined) return undefined
    return { port: this.port, passcode: this.passcode, sessions: [...this.sessions].slice(-MAX_KEPT_SESSIONS), startedAt: this.startedAt ?? Date.now() }
  }

  /** 关掉：口令和已经发出去的 cookie 立刻作废，挂着的长轮询马上结束 */
  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined
    this.port = undefined
    this.host = undefined
    this.passcode = ''
    this.sessions.clear()
    this.events = []
    this.eventBytes = 0
    this.dropped = this.seq
    for (const w of [...this.waiters]) w()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      for (const s of this.sockets) s.destroy()
    })
  }

  /** 后端推给界面的每一条消息都过这里；没开的时候什么都不做 */
  broadcast(channel: string, args: unknown[]): void {
    if (!this.server || this.sessions.size === 0) return
    let bytes: number
    try {
      bytes = JSON.stringify(args).length
    } catch {
      return
    }
    this.events.push({ seq: ++this.seq, channel, args, bytes })
    this.eventBytes += bytes
    while (this.events.length > MAX_EVENTS || (this.eventBytes > MAX_EVENT_BYTES && this.events.length > 1)) {
      const old = this.events.shift()!
      this.eventBytes -= old.bytes
      this.dropped = old.seq
    }
    for (const w of [...this.waiters]) w()
  }

  private authed(req: http.IncomingMessage): boolean {
    const c = readCookie(req, COOKIE)
    return Boolean(c) && this.sessions.has(c!)
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const p = url.pathname

    // 入口：口令换 cookie
    const entry = p.match(/^\/rv\/([^/]+)\/?$/)
    if (entry) {
      if (req.method !== 'GET' || !this.passcode || !safeEqual(entry[1], this.passcode)) return sendPage(res, 403, '这个链接不对或者已经失效了。请在电脑上的工作台里重新打开「远端查看」，用新的链接。')
      const sid = crypto.randomBytes(24).toString('base64url')
      this.sessions.add(sid)
      this.visits++
      this.lastVisitAt = Date.now()
      this.opts.onVisit?.()
      const secure = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https'
      res.writeHead(302, { ...BASE_HEADERS, 'set-cookie': `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`, location: '/', 'cache-control': 'no-store' })
      res.end()
      return
    }

    if (p.startsWith('/rv-api/')) {
      if (!this.authed(req)) return sendJson(res, 401, { ok: false, error: 'REMOTE_CLOSED' })
      if (p === '/rv-api/events' && req.method === 'GET') return this.poll(req, res, url)
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' })
      // 别的网站没法给跨站请求加自定义头，也过不了 Origin 核对
      if (req.headers['x-wb-remote'] !== '1' || !this.sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'FORBIDDEN' })
      let body: { channel?: unknown; args?: unknown; undef?: unknown }
      try {
        body = JSON.parse(await readBody(req))
      } catch (e) {
        return sendJson(res, (e as Error).message === 'BODY_TOO_LARGE' ? 413 : 400, { ok: false, error: 'BAD_REQUEST' })
      }
      if (typeof body?.channel !== 'string' || !Array.isArray(body.args)) return sendJson(res, 400, { ok: false, error: 'BAD_REQUEST' })
      // JSON 里没有 undefined：界面那头把「没传」的参数位置记在 undef 里，这里还原，免得后端把 null 当成有意传的值
      const args = [...(body.args as unknown[])]
      if (Array.isArray(body.undef)) for (const i of body.undef) if (Number.isInteger(i) && i >= 0 && i < args.length) args[i as number] = undefined
      if (p === '/rv-api/send') {
        try {
          this.opts.send(body.channel, args)
        } catch {
          // 和本机窗口一样，发出去就不管了
        }
        return sendJson(res, 200, { ok: true })
      }
      if (p === '/rv-api/invoke') {
        try {
          const result = await this.opts.invoke(body.channel, args)
          return sendJson(res, 200, result === undefined ? { ok: true } : { ok: true, result })
        } catch (e) {
          return sendJson(res, 200, { ok: false, error: String(e) })
        }
      }
      return sendJson(res, 404, { ok: false, error: 'NOT_FOUND' })
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return sendPage(res, 405, '不支持这个请求。')
    if (!this.authed(req)) return sendPage(res, 403, '请用电脑上工作台「远端查看」里的链接或二维码打开。链接关掉或换过以后，旧的就不能用了。')
    return this.serveStatic(req, res, p)
  }

  /** 带了 Origin 就必须和访问的主机一致（经隧道时主机名在 x-forwarded-host 或 host 里） */
  private sameOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin
    if (!origin) return true
    let host: string
    try {
      host = new URL(origin).host
    } catch {
      return false
    }
    const hosts = [req.headers.host, ...String(req.headers['x-forwarded-host'] ?? '').split(',')].map((h) => String(h ?? '').trim().toLowerCase()).filter(Boolean)
    return hosts.includes(host.toLowerCase())
  }

  private poll(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const afterRaw = Number(url.searchParams.get('after'))
    // 第一次来（after 不是数或是负数）：只告诉它现在的位置，从这里往后收
    if (!Number.isFinite(afterRaw) || afterRaw < 0) return sendJson(res, 200, { ok: true, events: [], last: this.seq })
    const after = Math.floor(afterRaw)
    const reply = (): boolean => {
      // 位置比缓冲里最旧的还旧（中间丢过），或者比现在还新（工作台重开过）：让界面整页重新取状态
      if (after < this.dropped || after > this.seq) {
        sendJson(res, 200, { ok: true, reset: true, events: [], last: this.seq })
        return true
      }
      const list = this.events.filter((e) => e.seq > after)
      if (list.length === 0) return false
      sendJson(res, 200, { ok: true, events: list.map((e) => ({ seq: e.seq, channel: e.channel, args: e.args })), last: this.seq })
      return true
    }
    if (reply()) return
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      this.waiters.delete(wake)
      if (res.writableEnded || res.destroyed) return
      if (!this.server) return sendJson(res, 401, { ok: false, error: 'REMOTE_CLOSED' })
      if (!reply()) sendJson(res, 200, { ok: true, events: [], last: this.seq })
    }
    const wake = (): void => finish()
    const timer = setTimeout(finish, this.opts.pollWaitMs ?? POLL_WAIT_MS)
    this.waiters.add(wake)
    req.on('close', () => {
      done = true
      clearTimeout(timer)
      this.waiters.delete(wake)
    })
  }

  private async serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
    const root = path.resolve(this.opts.staticRoot)
    let rel: string
    try {
      rel = decodeURIComponent(pathname).replace(/^\/+/, '')
    } catch {
      return sendPage(res, 400, '地址不对。')
    }
    if (!rel) rel = 'index.html'
    const file = path.resolve(root, rel)
    // 挡住 ../ 这类跳出界面目录去读别的文件
    if (file !== root && !file.startsWith(root + path.sep)) return sendPage(res, 403, '不能访问这个地址。')
    let data: Buffer
    try {
      data = await fsp.readFile(file)
    } catch {
      return sendPage(res, 404, '没有这个页面。')
    }
    const isHtml = path.extname(file).toLowerCase() === '.html'
    res.writeHead(200, {
      ...BASE_HEADERS,
      'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      // 带哈希的资源文件名每次构建都不同，可以放心缓存；页面本身不缓存
      'cache-control': isHtml ? 'no-store' : 'private, max-age=86400'
    })
    res.end(req.method === 'HEAD' ? undefined : data)
  }
}
