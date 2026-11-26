// 右栏网页标签里主进程和界面都要用的几样小东西（不依赖 Electron，测试里也直接用）

/** 网页标签用的会话分区：和工作台自己、和系统浏览器都分开；persist = 重开应用后登录状态还在 */
export const BROWSER_PARTITION = 'persist:wb-browser'

/**
 * 能在网页标签里打开的地址：http、https、file 和 about:blank。别的（javascript:、data:、chrome: 之类）不认。
 * 返回规整后的地址；不认的返回 undefined
 */
export function browsableUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  if (v === 'about:blank') return v
  if (!v || v.length > 4096) return undefined
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:' ? u.href : undefined
  } catch {
    return undefined
  }
}

export type BrowserKey = 'address' | 'new' | 'close'

/**
 * 网页有焦点时按下的键（Electron before-input-event 的 input）：
 * 'address' / 'new' / 'close' 要转给工作台的界面（Ctrl+L / Ctrl+T / Ctrl+W），
 * 'devtools'（F12、Ctrl+Shift+I）和 'reload'（F5、Ctrl+R）主进程自己办，别的不管（undefined）。
 * 按键的分法照 arena-core（千面 Facet）的 browser-tabs.cjs
 */
export function guestShortcut(input: { type: string; key: string; control?: boolean; meta?: boolean; alt?: boolean; shift?: boolean; isAutoRepeat?: boolean }): BrowserKey | 'devtools' | 'reload' | undefined {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return undefined
  if (input.key === 'F12') return 'devtools'
  if (input.key === 'F5') return 'reload'
  if (!(input.control || input.meta) || input.alt) return undefined
  const key = input.key.toLowerCase()
  if (key === 'r') return 'reload'
  if (input.shift) return key === 'i' ? 'devtools' : undefined
  if (key === 'l') return 'address'
  if (key === 't') return 'new'
  if (key === 'w') return 'close'
  return undefined
}

// ========== 指纹和 CDP 的设置（<数据目录>/browser.json） ==========

/** CDP（Chrome DevTools Protocol）默认开在这个端口；被占用就往后找 CDP_PORT_TRIES 个 */
export const DEFAULT_CDP_PORT = 9333
export const CDP_PORT_TRIES = 10

/** 一套指纹：就是 Facet 的 preset() 给出来的「环境」，原样存着（字段见 src/main/facet/fingerprint.cjs） */
export interface FingerprintEnv {
  /** CPU 线程数 */
  cpu?: number
  fingerprint?: {
    enabled?: boolean
    seed?: string
    template?: string
    screenWidth?: number
    screenHeight?: number
    availHeight?: number
    memory?: number
    touch?: number
    colorDepth?: number
    vendor?: string
    renderer?: string
    hardware?: boolean
    webgl?: boolean
    canvas?: boolean
    audio?: boolean
    rects?: boolean
  }
  [key: string]: unknown
}

/** 出口地区：网页实际从哪个 IP 出去、那个 IP 在哪国、当地时区、当地常用语言（照 Facet 的 exit-locale.cjs） */
export interface ExitRegion {
  ip: string
  countryCode: string
  country: string
  timezone: string
  language: string
  /** 查到的时间（毫秒） */
  at: number
}

export interface BrowserPrefs {
  cdp: { enabled: boolean; port: number }
  /** env 第一次用到时生成，之后不变（每次都变的指纹比不伪装更显眼），直到用户点「换一套」 */
  fingerprint: { enabled: boolean; env?: FingerprintEnv }
  /** 时区和语言跟出口 IP 走：last 是上次查到的（重开应用先用它，过期了再查） */
  region: { enabled: boolean; last?: ExitRegion }
  /** 网页标签走哪条路：'' 跟系统代理，'direct' 直连，或者 http / https / socks4 / socks5 代理地址 */
  proxy: string
}

export const defaultBrowserPrefs = (): BrowserPrefs => ({ cdp: { enabled: true, port: DEFAULT_CDP_PORT }, fingerprint: { enabled: true }, region: { enabled: true }, proxy: '' })

/**
 * 代理设置规整一下：空 = 跟系统；direct = 直连；主机:端口 当 http 代理；带协议的只认 http、https、socks4、socks5。
 * 不认的返回 undefined
 */
export function normalizeProxy(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  if (!v || v.toLowerCase() === 'system') return ''
  if (v.toLowerCase() === 'direct') return 'direct'
  const m = /^(?:(https?|socks4|socks5):\/\/)?(\[[0-9a-f:]+\]|[a-z0-9.-]+):(\d{1,5})\/?$/i.exec(v)
  if (!m) return undefined
  const port = Number(m[3])
  if (port < 1 || port > 65535) return undefined
  return `${(m[1] ?? 'http').toLowerCase()}://${m[2].toLowerCase()}:${port}`
}

function parseRegion(raw: unknown): ExitRegion | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const str = (k: string): string => (typeof r[k] === 'string' ? (r[k] as string) : '')
  if (!str('ip') || !/^[A-Z]{2}$/.test(str('countryCode')) || !str('timezone') || !str('language') || typeof r.at !== 'number') return undefined
  return { ip: str('ip'), countryCode: str('countryCode'), country: str('country'), timezone: str('timezone'), language: str('language'), at: r.at }
}

const validPort = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1024 && v <= 65535

/** 读回存着的设置：缺的、坏的用默认值（CDP 开、指纹开） */
export function parseBrowserPrefs(raw: unknown): BrowserPrefs {
  const d = defaultBrowserPrefs()
  if (!raw || typeof raw !== 'object') return d
  const o = raw as { cdp?: { enabled?: unknown; port?: unknown }; fingerprint?: { enabled?: unknown; env?: unknown }; region?: { enabled?: unknown; last?: unknown }; proxy?: unknown }
  if (o.region && typeof o.region === 'object') {
    if (typeof o.region.enabled === 'boolean') d.region.enabled = o.region.enabled
    const last = parseRegion(o.region.last)
    if (last) d.region.last = last
  }
  d.proxy = normalizeProxy(o.proxy) ?? ''
  if (o.cdp && typeof o.cdp === 'object') {
    if (typeof o.cdp.enabled === 'boolean') d.cdp.enabled = o.cdp.enabled
    if (validPort(o.cdp.port)) d.cdp.port = o.cdp.port
  }
  if (o.fingerprint && typeof o.fingerprint === 'object') {
    if (typeof o.fingerprint.enabled === 'boolean') d.fingerprint.enabled = o.fingerprint.enabled
    const env = o.fingerprint.env as FingerprintEnv | undefined
    // 没有种子的不算一套指纹，下次重新生成
    if (env && typeof env === 'object' && env.fingerprint && typeof env.fingerprint === 'object' && typeof env.fingerprint.seed === 'string' && env.fingerprint.seed) d.fingerprint.env = env
  }
  return d
}

/**
 * 这次启动 CDP 开在哪个端口。按顺序：
 * 命令行已经带了 --remote-debugging-port（验收脚本、开发时）→ 用它的，不动；
 * 环境变量 WB_CDP_PORT：off / 0 是不开，数字是只用这个端口；
 * 设置里关了 → 不开；否则从设置的端口起找第一个没被占用的。
 */
export async function pickCdpPort(opts: { cmdline?: string; env?: string; prefs: BrowserPrefs['cdp']; isFree: (port: number) => Promise<boolean> }): Promise<{ source: 'cmdline' | 'env' | 'prefs' | 'off'; port?: number; note?: string }> {
  if (opts.cmdline !== undefined) {
    const p = Number(opts.cmdline)
    return { source: 'cmdline', ...(Number.isInteger(p) && p > 0 ? { port: p } : { note: '端口由命令行指定' }) }
  }
  const env = opts.env?.trim().toLowerCase()
  if (env) {
    if (env === 'off' || env === '0' || env === 'false') return { source: 'off', note: '环境变量 WB_CDP_PORT 关掉了 CDP' }
    const p = Number(env)
    if (validPort(p)) return { source: 'env', port: p }
  }
  if (!opts.prefs.enabled) return { source: 'off' }
  for (let i = 0; i < CDP_PORT_TRIES; i++) {
    const p = opts.prefs.port + i
    if (p > 65535) break
    if (await opts.isFree(p)) return { source: 'prefs', port: p, ...(i ? { note: `${opts.prefs.port} 被别的程序占着，这次用 ${p}` } : {}) }
  }
  return { source: 'off', note: `${opts.prefs.port}–${opts.prefs.port + CDP_PORT_TRIES - 1} 都被占着，这次没开 CDP` }
}

/** Electron 默认的 UA 里有应用名和 Electron/版本，不少网站认出来就不给用：去掉这两段，其余不动（照 Facet 的 environment.cjs） */
export function cleanUserAgent(value: string): string {
  return String(value || '')
    .replace(/\s+Electron\/[^\s]+/gi, '')
    .replace(/(\(KHTML, like Gecko\))\s+(?!Chrome\/)[^\s/]+\/[^\s]+(?=\s+Chrome\/)/, '$1')
    .trim()
}

/** WebGL 渲染器那一长串里的显卡名：'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 …)' → 'NVIDIA GeForce RTX 3070' */
export function gpuName(renderer: string | undefined): string {
  if (!renderer) return ''
  const m = /^ANGLE \([^,]+,\s*(.+?)(?:\s+\(0x[0-9A-Fa-f]+\))?\s+Direct3D/.exec(renderer)
  return (m ? m[1] : renderer).trim()
}

/** 一套指纹里用户看得懂的几项 */
export function fingerprintDetails(env: FingerprintEnv | undefined): { label: string; value: string }[] {
  const f = env?.fingerprint
  if (!f) return []
  const out: { label: string; value: string }[] = []
  if (f.webgl && f.renderer) out.push({ label: '显卡', value: gpuName(f.renderer) })
  if (f.hardware && f.screenWidth && f.screenHeight) out.push({ label: '屏幕', value: `${f.screenWidth}×${f.screenHeight}` })
  if (env?.cpu) out.push({ label: 'CPU', value: `${env.cpu} 线程` })
  if (f.hardware && f.memory) out.push({ label: '内存', value: `${f.memory} GB` })
  const noise = [f.canvas && 'Canvas', f.audio && '音频', f.rects && '元素尺寸'].filter(Boolean)
  if (noise.length) out.push({ label: '加噪', value: noise.join('、') })
  return out
}

export const fingerprintSummary = (env: FingerprintEnv | undefined): string =>
  fingerprintDetails(env)
    .filter((d) => d.label !== '加噪')
    .map((d) => d.value)
    .join(' · ')

// ========== 讲给 AI 听的 ==========

/** 一个网页标签（给 AI 的） */
export interface BrowserTabInfo {
  /** 右栏里这个标签的 id */
  tab: string
  /** CDP 的 target id（/json/list 里的 id） */
  target?: string
  url: string
  title: string
  /** 直接连这个标签的 WebSocket 地址；CDP 没开就没有 */
  ws?: string
  loading?: boolean
}

export interface BrowserInfo {
  /** CDP 的 HTTP 地址（http://127.0.0.1:端口）；没开是 undefined */
  cdp?: string
  /** CDP 没开、或者有要说明的（端口换了之类） */
  cdpNote?: string
  tabs: BrowserTabInfo[]
  fingerprint: { enabled: boolean; summary?: string }
  /** 网页看到的时区和语言跟着出口 IP 走时：出口在哪国、用的时区和语言 */
  region?: { country: string; timezone: string; language: string }
}

/** 握手说明里的一小节：只说有这个东西、在哪、先调哪个工具 */
export function browserBrief(cdp: string | undefined): string {
  const where = cdp ? `CDP 开在 ${cdp}（只在工作台所在的电脑上能连）` : 'CDP 这次没开'
  return `\n## 内置浏览器\n工作台右栏有一个内置浏览器（Chromium），用户看得见你在里面打开的网页。${where}。要用它：先 browser_info（现状和用法），再 browser_open 打开网页，然后用 CDP 操作，用完 browser_close。`
}

/** browser_info 里的用法说明 */
export function browserUsage(info: BrowserInfo): string {
  const cdp = info.cdp ?? 'http://127.0.0.1:<端口>'
  const lines = [
    '内置浏览器在工作台右栏，是 Electron 自带的 Chromium；每个网页标签是一个 CDP target（type 是 "webview"）。',
    info.cdp ? `CDP：${cdp}，只监听 127.0.0.1。你不在这台电脑上的话，用 run_command 在这台电脑上跑脚本去连。` : `CDP 这次没开${info.cdpNote ? `（${info.cdpNote}）` : ''}：只能用 browser_open 打开网页给用户看，没法操作。让用户在右栏「新标签页」里打开 CDP 开关并重启工作台。`,
    '',
    '怎么用：',
    '1. browser_open { url } 在右栏开一个标签，返回它的 ws 地址；已有的标签看本工具返回的 tabs，或者 GET ' + cdp + '/json/list 里 type 为 "webview" 的。',
    '2. 连那个 ws 地址发 CDP 命令：Page.navigate、Runtime.evaluate、Input.dispatchMouseEvent / dispatchKeyEvent、Page.captureScreenshot、DOM.* 都能用。',
    '3. 用完 browser_close { tab } 关掉自己开的标签。',
    '',
    '注意：',
    '- /json/list 里 type 是 "page" 的那个（地址 app://bundle/…）是工作台自己的界面，不是网页，别去导航、别关它。',
    '- 不能用 Target.createTarget 开新标签（开出来的不在右栏里），用 browser_open。',
    '- 连 WebSocket 时别带 Origin 头（Python 的 websocket-client 要 suppress_origin=True）；Node 22 自带的 WebSocket、ws、Puppeteer 的 connect({ browserURL, defaultViewport: null }) 可以直接连。',
    '- 别改视口大小（Emulation.setDeviceMetricsOverride）：网页就显示在用户的右栏里，改了会变形。Puppeteer 记得传 defaultViewport: null。',
    info.fingerprint.enabled
      ? `- 指纹开着（${info.fingerprint.summary || '已配置'}）：UA、显卡、屏幕、CPU、内存和 Canvas / 音频噪声由工作台统一设好，所有标签共用一套。别用 Emulation.setUserAgentOverride 之类去覆盖，会和这套对不上。`
      : '- 指纹没开：网页看到的是这台电脑的真实硬件信息（UA 里的 Electron 字样已去掉）。',
    info.region
      ? `- 时区和语言跟着出口 IP 走：现在出口在 ${info.region.country}，网页看到的时区是 ${info.region.timezone}、语言是 ${info.region.language}。别用 Emulation.setTimezoneOverride / setLocaleOverride 去改。`
      : '- 时区和语言是这台电脑真实的（没开「跟出口 IP 走」，或者这次没查到出口）。',
    '- WebRTC 不走代理的 UDP 是禁掉的（不漏真实 IP）；通知、摄像头、麦克风这些权限默认拒绝。登录状态所有标签共用，和系统浏览器不互通。',
    '',
    '最小例子（Node 22，在工作台所在的电脑上跑）：',
    `const tabs = (await (await fetch('${cdp}/json/list')).json()).filter((t) => t.type === 'webview')`,
    'const ws = new WebSocket(tabs[0].webSocketDebuggerUrl)',
    "ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'document.title', returnByValue: true } }))",
    'ws.onmessage = (e) => { console.log(e.data); ws.close() }'
  ]
  return lines.join('\n')
}
