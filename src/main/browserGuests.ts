// 右栏里的网页标签（界面上的 <webview>）在主进程这边要做的事：
// 开新窗口变新标签、快捷键、指纹、CDP 的现状、让 AI 开关标签。
// 做法照 arena-core（千面 Facet）；指纹、出口地区、WebRTC 那几个文件是原样搬过来的，在 src/main/facet/（见那里的 README.md）。
// 环境这一块（11-15 用户拿 ipip.la 的伪装检测一测，60 分）跟 Facet 的实例对齐：
// WebRTC 不走代理的 UDP 禁掉、权限照 Facet 的白名单、DNS 预取关掉、时区和语言跟出口 IP 走、可以指定代理。
// 下载、弹窗、网址仍然不拦；网页拿不到工作台的 preload（那里面是读写文件、开终端的接口）。
import { app, screen, session, webContents, type BrowserWindow, type Session, type WebContents } from 'electron'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BROWSER_PARTITION,
  browsableUrl,
  cleanUserAgent,
  fingerprintDetails,
  fingerprintSummary,
  guestShortcut,
  normalizeProxy,
  parseBrowserPrefs,
  pickCdpPort,
  type BrowserInfo,
  type BrowserPrefs,
  type BrowserTabInfo,
  type ExitRegion,
  type FingerprintEnv
} from '../shared/browser'
import type { BrowserStatus } from '../shared/api'

// ========== Facet 的指纹模块（CommonJS，构建时原样拷到 out/main/facet/） ==========

interface FacetFingerprint {
  preset(id: string, base?: FingerprintEnv, seed?: string, options?: { screen?: boolean }): FingerprintEnv
  /** 注入网页的脚本全文；指纹没开返回 null */
  script(env: FingerprintEnv): string | null
  generatedMetadata(env: FingerprintEnv, native: NativeInfo): Record<string, unknown> | null
  /** UA 是自己定的时候：品牌、版本照 UA 里的 Chrome 版本来 */
  customMetadata(env: FingerprintEnv, native: NativeInfo): Record<string, unknown> | null
  generatedUserAgent(): string
}
interface FacetWebrtc {
  POLICY: string
  /** 设不上会抛错 */
  applyWebRTCPolicy(wc: WebContents): void
}
interface ProbeResult {
  ip: string
  countryCode: string
  country: string
  timezone: string
  provider?: string
}
interface FacetIpServices {
  PROVIDERS: { id: string; name: string; url: string }[]
  IPLookup: new (opts?: { providers?: { id: string; name: string; url: string }[]; interval?: number; ttl?: number; timeout?: number }) => {
    lookup(key: unknown, fetch: (url: string, signal: AbortSignal) => Promise<Response>, signal: AbortSignal, opts?: { force?: boolean; requireLocale?: boolean }): Promise<ProbeResult>
  }
}
interface FacetExitLocale {
  /** 出口查询的结果 → 那个国家的时区和常用语言；信息不全会抛错 */
  fromProbe(result: ProbeResult): { ip: string; countryCode: string; country: string; timezone: string; language: string }
}
interface FacetCatalog {
  ID: string
  setDisplayProvider(fn: () => { width: number; height: number; scaleFactor: number } | null): void
  setTouchProvider(fn: () => number): void
}
interface FacetContexts {
  installContextEnvironment(wc: WebContents, opts: { source: string | null; applyNative: (sessionId?: string, type?: string) => Promise<void> }): Promise<unknown>
  contextEnvironmentState(wc: WebContents): unknown
}
interface FacetServiceWorker {
  installServiceWorkerEnvironment(wc: WebContents, source: string | null, nativeKey: string): Promise<void>
}
/** 这台电脑真实的 navigator.platform 和 UA-CH（从工作台自己的界面里取，同一个 Chromium） */
interface NativeInfo {
  platform: string
  metadata: Record<string, unknown> | null
  touch: number
}

const facetRequire = createRequire(import.meta.url)
let facetDirCache: string | undefined
/** out/main/facet：这段代码被打进 out/main/index.js 或它旁边的 chunk 里，两种都找得到 */
function facetDir(): string {
  if (facetDirCache) return facetDirCache
  const here = path.dirname(fileURLToPath(import.meta.url))
  const found = [path.join(here, 'facet'), path.join(here, '..', 'facet')].find((d) => fs.existsSync(path.join(d, 'fingerprint.cjs')))
  if (!found) throw new Error('指纹模块没有随构建拷过来（out/main/facet）')
  facetDirCache = found
  return found
}
const facetLoad = <T>(file: string): T => facetRequire(path.join(facetDir(), file)) as T
const facet = {
  get fingerprint(): FacetFingerprint {
    return facetLoad<FacetFingerprint>('fingerprint.cjs')
  },
  get catalog(): FacetCatalog {
    return facetLoad<FacetCatalog>('fingerprint-catalog.cjs')
  },
  get contexts(): FacetContexts {
    return facetLoad<FacetContexts>('environment-contexts.cjs')
  },
  get serviceWorker(): FacetServiceWorker {
    return facetLoad<FacetServiceWorker>('environment-service-worker.cjs')
  },
  get webrtc(): FacetWebrtc {
    return facetLoad<FacetWebrtc>('webrtc-policy.cjs')
  },
  get ipServices(): FacetIpServices {
    return facetLoad<FacetIpServices>('ip-services.cjs')
  },
  get exitLocale(): FacetExitLocale {
    return facetLoad<FacetExitLocale>('exit-locale.cjs')
  }
}

// ========== 设置（<数据目录>/browser.json） ==========

let prefsFile = ''
let prefs: BrowserPrefs | undefined

/** 启动最早的时候（app ready 之前）就要读：CDP 的开关要在那时定 */
export function loadBrowserPrefs(dataDir: string): BrowserPrefs {
  prefsFile = path.join(dataDir, 'browser.json')
  let raw: unknown = null
  try {
    raw = JSON.parse(fs.readFileSync(prefsFile, 'utf8'))
  } catch {
    // 第一次运行没有这个文件
  }
  prefs = parseBrowserPrefs(raw)
  return prefs
}

function savePrefs(): void {
  if (!prefs || !prefsFile) return
  try {
    fs.mkdirSync(path.dirname(prefsFile), { recursive: true })
    // 先写临时文件再改名：别人（或者崩溃后的自己）不会读到写了一半的文件
    const tmp = `${prefsFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2))
    fs.renameSync(tmp, prefsFile)
  } catch {
    // 存不了：这次运行里照样有效
  }
}

// ========== CDP ==========

export interface CdpState {
  source: 'cmdline' | 'env' | 'prefs' | 'off'
  /** 这次启动开在哪个端口；没开是 undefined */
  port?: number
  note?: string
}
let cdp: CdpState = { source: 'off' }

const portFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })

/**
 * 默认把 Chromium 的远程调试端口打开（只监听 127.0.0.1）。必须在 app ready 之前调完：
 * 开关是进程启动参数，ready 之后再加不起作用。
 */
export async function setupCdp(dataDir: string): Promise<CdpState> {
  const p = loadBrowserPrefs(dataDir)
  disableDnsPrefetch()
  const cmdline = app.commandLine.hasSwitch('remote-debugging-port') ? app.commandLine.getSwitchValue('remote-debugging-port') : undefined
  const picked = await pickCdpPort({ cmdline, env: process.env.WB_CDP_PORT, prefs: p.cdp, isFree: portFree })
  if (picked.port && picked.source !== 'cmdline') app.commandLine.appendSwitch('remote-debugging-port', String(picked.port))
  cdp = picked
  return cdp
}

/**
 * 关掉 DNS 预取（照 Facet 的 browser-network-policy.cjs）：网页里的链接、<link rel=dns-prefetch> 会让 Chromium
 * 绕过代理、直接用本机的 DNS 去查域名，检测站就看到真实所在地的 DNS 了。这是 Blink 的启动参数，也要在 app ready 之前加
 */
function disableDnsPrefetch(): void {
  const settings = app.commandLine
    .getSwitchValue('blink-settings')
    .split(',')
    .filter((v) => v && !v.startsWith('dnsPrefetchingEnabled='))
  settings.push('dnsPrefetchingEnabled=false')
  app.commandLine.appendSwitch('blink-settings', settings.join(','))
}

const cdpHttp = (): string | undefined => (cdp.port ? `http://127.0.0.1:${cdp.port}` : undefined)

/** 端口上是不是真有 CDP 在答（而且是这个工作台的：列表里有工作台自己的界面） */
async function cdpAlive(): Promise<boolean> {
  const base = cdpHttp()
  if (!base) return false
  try {
    const res = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(1500) })
    const list = (await res.json()) as { url?: string }[]
    return Array.isArray(list) && list.some((t) => typeof t.url === 'string' && (t.url.startsWith('app://') || t.url === process.env.ELECTRON_RENDERER_URL))
  } catch {
    return false
  }
}

// ========== 指纹 ==========

let native: NativeInfo | undefined
let providersSet = false

function setProviders(win: BrowserWindow | null): void {
  if (providersSet) return
  providersSet = true
  // 屏幕从设备库里挑的时候要知道这台电脑的缩放比例：跨站 iframe 报的是真实的 DPR，对不上就露馅
  facet.catalog.setDisplayProvider(() => {
    const d = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay()
    return { ...d.size, scaleFactor: d.scaleFactor }
  })
  // 触摸点数 Chromium 是从系统取的，改不了：照实报
  facet.catalog.setTouchProvider(() => native?.touch ?? 0)
}

async function readNative(win: BrowserWindow | null): Promise<NativeInfo> {
  if (native) return native
  let got: NativeInfo = { platform: process.platform === 'win32' ? 'Win32' : '', metadata: null, touch: 0 }
  if (win && !win.isDestroyed()) {
    try {
      got = (await win.webContents.executeJavaScript(
        `(async () => ({ platform: navigator.platform, touch: navigator.maxTouchPoints || 0, metadata: navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'wow64']) : null }))()`
      )) as NativeInfo
    } catch {
      // 取不到就不带 UA-CH 的细节
    }
  }
  native = got
  return got
}

/** 现在用的那套指纹；还没有就生成一套存下来。种子固定，所以重开应用、换标签都是同一套 */
function currentEnv(win: BrowserWindow | null, regenerate = false): FingerprintEnv {
  if (!prefs) throw new Error('浏览器设置还没读')
  setProviders(win)
  if (!prefs.fingerprint.env || regenerate) {
    // 设备库里随机挑一台「真实存在的搭配」：显卡、屏幕、CPU 线程数、内存互相对得上
    prefs.fingerprint.env = facet.fingerprint.preset(facet.catalog.ID, {}, undefined)
    savePrefs()
  }
  return prefs.fingerprint.env
}

/** 网页标签用的 UA：去掉 Electron 字样的原生 UA。指纹开没开都用它 */
function plainUserAgent(): string {
  return process.platform === 'win32' ? facet.fingerprint.generatedUserAgent() : cleanUserAgent(app.userAgentFallback)
}

// 同一个网页进程里时区 / 语言已经是这个值时 Chromium 会报 already in effect，不算错（照 Facet）
async function shared(p: Promise<unknown>): Promise<void> {
  try {
    await p
  } catch (e) {
    if (!/already in effect/i.test(String((e as Error)?.message))) throw e
  }
}

/**
 * 给一个网页装上环境（照 Facet 的 environment.cjs applyEnvironment；视口那一步没搬）：
 * UA / UA-CH、时区、语言（region 有就用它的），指纹开着再加 CPU 线程数和注入脚本。iframe、Worker、Service Worker 同一套
 */
async function applyEnvironment(wc: WebContents, win: BrowserWindow | null, region: ExitRegion | undefined): Promise<boolean> {
  const fpOn = prefs?.fingerprint.enabled === true
  const base: FingerprintEnv = fpOn ? currentEnv(win) : {}
  const nat = await readNative(win)
  const userAgent = plainUserAgent()
  const language = region?.language ?? ''
  const timezone = region?.timezone ?? ''
  // UA 每次按当前 Chromium 版本现算（存着的会随升级过时）；缩放不动
  const env: FingerprintEnv = { ...base, userAgent, platform: 'Win32', language, timezone, scale: 0, fingerprint: { ...base.fingerprint, enabled: fpOn } }
  const metadata = facet.fingerprint.generatedMetadata(env, nat) ?? facet.fingerprint.customMetadata(env, nat) ?? nat.metadata
  const source = facet.fingerprint.script(env)
  const key = JSON.stringify([userAgent, 'Win32', language, timezone, fpOn ? env.cpu : 0, metadata])
  await facet.serviceWorker.installServiceWorkerEnvironment(wc, source, key)
  if (source) {
    await wc.debugger.sendCommand('Page.enable')
    await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source, runImmediately: true })
  }
  const applyNative = async (sessionId?: string): Promise<void> => {
    const send = (method: string, params: Record<string, unknown>): Promise<unknown> => wc.debugger.sendCommand(method, params, sessionId)
    await send('Emulation.setUserAgentOverride', { userAgent, platform: 'Win32', ...(language ? { acceptLanguage: language } : {}), ...(metadata ? { userAgentMetadata: metadata } : {}) })
    if (timezone) await shared(send('Emulation.setTimezoneOverride', { timezoneId: timezone }))
    if (language) await shared(send('Emulation.setLocaleOverride', { locale: language }))
    if (fpOn && env.cpu) await send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: env.cpu })
  }
  await applyNative()
  // 页面里的 iframe 和 Worker 也要是同一套
  await facet.contexts.installContextEnvironment(wc, { source, applyNative })
  return fpOn
}

// ========== 网络：代理、权限、出口地区 ==========

const browserSession = (): Session => session.fromPartition(BROWSER_PARTITION)

/** 网页标签走哪条路：跟系统代理、直连，或者指定的代理（比如 Facet 的节点端口） */
async function applyProxy(): Promise<void> {
  const ses = browserSession()
  const proxy = prefs?.proxy ?? ''
  if (!proxy) await ses.setProxy({ mode: 'system' })
  else if (proxy === 'direct') await ses.setProxy({ mode: 'direct' })
  else await ses.setProxy({ mode: 'fixed_servers', proxyRules: proxy })
  await ses.closeAllConnections()
}

/** 现在一个普通的 https 请求会怎么走：'DIRECT' 或者 'PROXY 主机:端口' */
async function currentRoute(): Promise<string> {
  try {
    return await browserSession().resolveProxy('https://www.example.com/')
  } catch {
    return ''
  }
}

/**
 * 权限照 Facet 的白名单：网页复制、读用户拖进来或选中的文件可以，别的（通知、摄像头、麦克风、定位、读剪贴板…）一律拒绝。
 * 不设的话 Electron 什么都答应：WebRTC 会因此把本机各网卡的真实地址报出去，Notification.permission 也是 granted，都是破绽
 */
function installPermissionPolicy(): void {
  const ses = browserSession()
  const permitted = (permission: string, details?: { fileAccessType?: string }): boolean => permission === 'clipboard-sanitized-write' || (permission === 'fileSystem' && details?.fileAccessType === 'readable')
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => cb(permitted(permission, details as { fileAccessType?: string })))
  ses.setPermissionCheckHandler((_wc, permission, _origin, details) => permitted(permission, details as { fileAccessType?: string }))
}

/** 出口地区多久重查一次 */
const REGION_TTL = 10 * 60_000
/** 第一次查不到时最多让网页等这么久 */
const REGION_WAIT = 6000
let regionProbe: Promise<ExitRegion | undefined> | undefined
let regionError = ''
let regionFailedAt = 0
let ipLookup: InstanceType<FacetIpServices['IPLookup']> | undefined

/** 测试、离线环境：WB_EXIT_PROBE_URL=off 不查；设成一个地址就只问它（返回 ip.sb 那种格式） */
const regionOn = (): boolean => prefs?.region.enabled === true && process.env.WB_EXIT_PROBE_URL?.trim().toLowerCase() !== 'off'

/** 分区级的 UA 和 Accept-Language：网页还没加载时的请求、Service Worker 发的请求都带它 */
function applySessionIdentity(): void {
  const region = regionOn() ? prefs?.region.last : undefined
  // 不跟出口走时要把语言明确设回系统的：setUserAgent 不带第二个参数不会把之前设的语言清掉
  const locale = app.getLocale()
  const system = locale.includes('-') ? `${locale},${locale.split('-')[0]}` : locale
  browserSession().setUserAgent(plainUserAgent(), region ? region.language : system)
}

/** 经网页标签自己那条路（同一个代理）去问出口 IP 在哪国、什么时区（照 Facet 的 ip-services.cjs + exit-locale.cjs） */
function probeRegion(): Promise<ExitRegion | undefined> {
  if (regionProbe) return regionProbe
  const run = async (): Promise<ExitRegion | undefined> => {
    try {
      if (!ipLookup) {
        const custom = process.env.WB_EXIT_PROBE_URL?.trim()
        ipLookup = new facet.ipServices.IPLookup(custom ? { providers: [{ id: 'ipsb', name: '指定的查询地址', url: custom }], interval: 0 } : {})
      }
      const ses = browserSession()
      const result = await ipLookup.lookup('browser', (url, signal) => ses.fetch(url, { signal, cache: 'no-store', credentials: 'omit' }), AbortSignal.timeout(25_000), { force: true, requireLocale: true })
      const loc = facet.exitLocale.fromProbe(result)
      const region: ExitRegion = { ip: loc.ip, countryCode: loc.countryCode, country: loc.country, timezone: loc.timezone, language: loc.language, at: Date.now() }
      if (prefs) {
        prefs.region.last = region
        savePrefs()
      }
      regionError = ''
      regionFailedAt = 0
      applySessionIdentity()
      return region
    } catch (e) {
      const detail = (e as { safeDiagnostic?: string })?.safeDiagnostic
      regionError = `${e instanceof Error ? e.message : String(e)}${detail ? `（${detail}）` : ''}`
      regionFailedAt = Date.now()
      return undefined
    } finally {
      regionProbe = undefined
    }
  }
  regionProbe = run()
  return regionProbe
}

/** 新开一个网页标签时用哪个地区：没过期用存着的；过期了先用旧的、后台重查；从没查到过就等一下 */
async function regionForTab(): Promise<ExitRegion | undefined> {
  if (!regionOn()) return undefined
  const last = prefs?.region.last
  if (last && Date.now() - last.at < REGION_TTL) return last
  // 刚失败过就别让每个新标签都再等一遍
  if (!last && regionFailedAt && Date.now() - regionFailedAt < 60_000) return undefined
  const p = probeRegion()
  if (last) return last
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), REGION_WAIT))])
}

// ========== 网页标签的登记 ==========

interface Guest {
  wc: WebContents
  /** 右栏里那个标签的 id（界面在 browser:prepare 里报上来） */
  tabId?: string
  targetId?: string
  fingerprint: boolean
  ready?: Promise<PrepareResult>
}
/** fingerprint：指纹装没装；region：这个标签用的时区和语言（没有就是系统的）；note：不碍事但要说一声的；error：环境没装上（网页不自己打开） */
export interface PrepareResult {
  fingerprint: boolean
  region?: { country: string; timezone: string; language: string }
  note?: string
  error?: string
}
const guests = new Map<number, Guest>()
/** AI 用 browser_open 开的标签：等界面把网页挂上来 */
const waiting = new Map<string, (g: Guest) => void>()
let host: BrowserWindow | null = null
let notifyHost: (channel: 'browser:open' | 'browser:key' | 'browser:close', payload: unknown) => void = () => undefined

function guestOf(wc: WebContents): Guest {
  let g = guests.get(wc.id)
  if (!g) {
    g = { wc, fingerprint: false }
    guests.set(wc.id, g)
    const id = wc.id
    wc.once('destroyed', () => guests.delete(id))
  }
  return g
}

/** 网页开始加载之前要做完的事：WebRTC 策略、接上调试通道（拿 target id）、装环境 */
function prepare(g: Guest): Promise<PrepareResult> {
  if (!g.ready) {
    g.ready = (async (): Promise<PrepareResult> => {
      const wc = g.wc
      const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
      try {
        // 不走代理的 UDP 一律不发：WebRTC 不会把真实的公网 IP、本机网卡地址漏出去（照 Facet 的 webrtc-policy.cjs）
        facet.webrtc.applyWebRTCPolicy(wc)
      } catch (e) {
        return { fingerprint: false, error: msg(e) }
      }
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
        const info = (await wc.debugger.sendCommand('Target.getTargetInfo')) as { targetInfo?: { targetId?: string } }
        g.targetId = info.targetInfo?.targetId
      } catch (e) {
        return { fingerprint: false, error: `调试通道没接上：${msg(e)}` }
      }
      const region = await regionForTab()
      try {
        g.fingerprint = await applyEnvironment(wc, host, region)
      } catch (e) {
        return { fingerprint: false, error: msg(e) }
      }
      return {
        fingerprint: g.fingerprint,
        ...(region ? { region: { country: region.country || region.countryCode, timezone: region.timezone, language: region.language } } : {}),
        ...(regionOn() && !region ? { note: `没查到出口 IP 在哪，这个标签的时区和语言用的是系统的${regionError ? `：${regionError}` : ''}` } : {})
      }
    })()
  }
  return g.ready
}

/**
 * 在工作台的窗口上接好网页标签。
 * notify：发给这个窗口的界面——'browser:open' { url, wcId?, tabId?, focus? }（另开一个标签）、
 * 'browser:key' { wcId, key }（网页里按了 Ctrl+L / Ctrl+T / Ctrl+W）、'browser:close' { tabId }。
 * 远端页面里没有网页标签，不用发给它
 */
export function setupBrowserTabs(win: BrowserWindow, notify: (channel: 'browser:open' | 'browser:key' | 'browser:close', payload: unknown) => void): void {
  host = win
  notifyHost = notify
  win.on('closed', () => {
    if (host === win) host = null
  })
  // 这个分区里的请求（包括网页还没加载时、Service Worker 发的）都带干净的 UA；知道出口地区的话语言也跟着
  applySessionIdentity()
  installPermissionPolicy()
  void applyProxy().catch(() => undefined)
  // <webview> 挂上来之前改它的设置：不带 preload、不开 node，会话固定用网页标签自己的分区
  win.webContents.on('will-attach-webview', (_e, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    params.partition = BROWSER_PARTITION
  })
  win.webContents.on('did-attach-webview', (_e, guest) => {
    guestOf(guest)
    try {
      facet.webrtc.applyWebRTCPolicy(guest)
    } catch {
      // 这里设不上的话，加载前（prepare）还会再设一次，那次失败网页就不打开
    }
    // 网页里的 window.open、target=_blank：不弹新窗口，在右栏另开一个标签
    guest.setWindowOpenHandler(({ url }) => {
      const u = browsableUrl(url)
      if (u && u !== 'about:blank') notify('browser:open', { url: u, wcId: guest.id })
      return { action: 'deny' }
    })
    guest.on('before-input-event', (event, input) => {
      const hit = guestShortcut(input)
      if (!hit) return
      event.preventDefault()
      if (hit === 'devtools') {
        if (guest.isDevToolsOpened()) guest.closeDevTools()
        else guest.openDevTools({ mode: 'detach' })
      } else if (hit === 'reload') guest.reload()
      else notify('browser:key', { wcId: guest.id, key: hit })
    })
  })
}

/**
 * 界面在网页开始加载前调：wcId 是那个 <webview> 的网页，tabId 是它在右栏里的标签。
 * 等指纹装好再返回，界面这才去加载真正的地址（不然第一页看到的是真实硬件）
 */
export async function prepareBrowserTab(wcId: number, tabId: string): Promise<PrepareResult> {
  const wc = webContents.fromId(wcId)
  if (!wc || wc.isDestroyed() || wc.getType() !== 'webview' || !host || wc.hostWebContents !== host.webContents) throw new Error('这不是右栏里的网页标签')
  const g = guestOf(wc)
  if (typeof tabId === 'string' && tabId) g.tabId = tabId
  const res = await prepare(g)
  if (g.tabId) {
    waiting.get(g.tabId)?.(g)
    waiting.delete(g.tabId)
  }
  return res
}

/** 清掉网页标签的登录状态、缓存（工作台自己的数据不在这个分区里，不受影响） */
export async function clearBrowserData(): Promise<void> {
  const s = session.fromPartition(BROWSER_PARTITION)
  await s.clearStorageData()
  await s.clearCache()
}

// ========== 现状、改设置（界面用） ==========

export async function browserStatus(): Promise<BrowserStatus> {
  if (!prefs) throw new Error('浏览器设置还没读')
  const env = prefs.fingerprint.enabled ? currentEnv(host) : prefs.fingerprint.env
  const last = prefs.region.last
  return {
    cdp: {
      enabled: prefs.cdp.enabled,
      port: prefs.cdp.port,
      ...(cdp.port ? { activePort: cdp.port, url: cdpHttp() } : {}),
      ok: await cdpAlive(),
      source: cdp.source,
      ...(cdp.note ? { note: cdp.note } : {})
    },
    fingerprint: { enabled: prefs.fingerprint.enabled, summary: fingerprintSummary(env), details: fingerprintDetails(env), userAgent: plainUserAgent() },
    region: {
      enabled: prefs.region.enabled,
      ...(regionOn() && last ? { ip: last.ip, country: last.country || last.countryCode, countryCode: last.countryCode, timezone: last.timezone, language: last.language, at: last.at } : {}),
      ...(regionError ? { error: regionError } : {}),
      ...(prefs.region.enabled && !regionOn() ? { error: '环境变量 WB_EXIT_PROBE_URL 关掉了出口查询' } : {})
    },
    network: { proxy: prefs.proxy, route: await currentRoute(), webrtc: facet.webrtc.POLICY }
  }
}

/**
 * cdp：开关（重启后生效）；fingerprint：开关；regenerate：换一套指纹；region：时区语言跟不跟出口 IP 走；
 * refreshRegion：现在重查一次出口；proxy：'' 跟系统、'direct' 直连、或代理地址（改了会重查出口）。
 * 指纹、地区的改动只对之后打开的标签有效
 */
export async function setBrowserPrefs(patch: { cdp?: boolean; fingerprint?: boolean; regenerate?: boolean; region?: boolean; refreshRegion?: boolean; proxy?: string }): Promise<BrowserStatus> {
  if (!prefs) throw new Error('浏览器设置还没读')
  const p = patch && typeof patch === 'object' ? patch : {}
  if (typeof p.cdp === 'boolean') prefs.cdp.enabled = p.cdp
  if (typeof p.fingerprint === 'boolean') prefs.fingerprint.enabled = p.fingerprint
  if (p.regenerate === true) currentEnv(host, true)
  let probe = p.refreshRegion === true
  if (typeof p.region === 'boolean') {
    prefs.region.enabled = p.region
    probe = probe || p.region
  }
  if (p.proxy !== undefined) {
    const proxy = normalizeProxy(p.proxy)
    if (proxy === undefined) throw new Error('代理地址不认：留空（跟系统）、direct（直连），或 http://主机:端口、socks5://主机:端口')
    if (proxy !== prefs.proxy) {
      prefs.proxy = proxy
      // 换了路，出口也换了：旧的地区不作数
      delete prefs.region.last
      await applyProxy()
      probe = true
    }
  }
  savePrefs()
  if (probe && regionOn()) await Promise.race([probeRegion(), new Promise((r) => setTimeout(r, 12_000))])
  applySessionIdentity()
  return browserStatus()
}

// ========== 给 AI 的（MCP 的 browser_info / browser_open / browser_close） ==========

const tabInfo = (g: Guest): BrowserTabInfo => ({
  tab: g.tabId ?? '',
  ...(g.targetId ? { target: g.targetId } : {}),
  url: g.wc.getURL(),
  title: g.wc.getTitle(),
  ...(g.targetId && cdp.port ? { ws: `ws://127.0.0.1:${cdp.port}/devtools/page/${g.targetId}` } : {}),
  ...(g.wc.isLoading() ? { loading: true } : {})
})

export const browserHost = {
  /** 握手说明里用：CDP 的地址（没开是 undefined） */
  brief: (): { cdp?: string } => ({ ...(cdpHttp() ? { cdp: cdpHttp() } : {}) }),

  async info(): Promise<BrowserInfo> {
    const alive = await cdpAlive()
    const env = prefs?.fingerprint.enabled ? currentEnv(host) : undefined
    return {
      ...(alive ? { cdp: cdpHttp() } : {}),
      ...(alive ? (cdp.note ? { cdpNote: cdp.note } : {}) : { cdpNote: cdp.note ?? (cdp.port ? `端口 ${cdp.port} 上没有应答` : '设置里关着') }),
      tabs: [...guests.values()].filter((g) => !g.wc.isDestroyed() && g.tabId).map(tabInfo),
      fingerprint: { enabled: prefs?.fingerprint.enabled === true, ...(env ? { summary: fingerprintSummary(env) } : {}) },
      ...(regionOn() && prefs?.region.last ? { region: { country: prefs.region.last.country || prefs.region.last.countryCode, timezone: prefs.region.last.timezone, language: prefs.region.last.language } } : {})
    }
  },

  /** 在右栏开一个网页标签，等它加载完（最多 20 秒，没完也返回，loading 为 true） */
  async open(url: string, opts: { focus?: boolean } = {}): Promise<BrowserTabInfo> {
    const u = browsableUrl(url)
    if (!u) throw new Error('只能打开 http、https、file 地址')
    if (!host || host.isDestroyed()) throw new Error('工作台的窗口没开着')
    const tabId = `t_ai${Math.random().toString(36).slice(2, 10)}`
    const attached = new Promise<Guest>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(tabId)
        reject(new Error('右栏没有把这个标签开出来（10 秒没动静）'))
      }, 10_000)
      waiting.set(tabId, (g) => {
        clearTimeout(timer)
        resolve(g)
      })
    })
    notifyHost('browser:open', { url: u, tabId, focus: opts.focus !== false, reveal: opts.focus !== false })
    const g = await attached
    // prepare 返回后界面才开始加载真正的地址：等它开始，再等它停
    await new Promise<void>((resolve) => {
      const wc = g.wc
      const done = (): void => {
        clearTimeout(timer)
        wc.removeListener('did-stop-loading', onStop)
        wc.removeListener('destroyed', done)
        resolve()
      }
      let started = false
      const onStop = (): void => {
        if (started && wc.getURL() !== 'about:blank') done()
      }
      const timer = setTimeout(done, 20_000)
      wc.once('did-start-navigation', () => (started = true))
      wc.on('did-stop-loading', onStop)
      wc.once('destroyed', done)
    })
    if (g.wc.isDestroyed()) throw new Error('这个标签刚开出来就被关掉了')
    return tabInfo(g)
  },

  /** 关一个标签（tab 是 browser_open / browser_info 给的 tab id）。返回关没关到 */
  close(tab: string): boolean {
    const g = [...guests.values()].find((x) => x.tabId === tab && !x.wc.isDestroyed())
    if (!g) return false
    notifyHost('browser:close', { tabId: tab })
    return true
  }
}
