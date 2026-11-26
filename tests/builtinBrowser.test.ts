// 内置浏览器：指纹和 CDP 的设置、讲给 AI 听的说明、MCP 的 browser_* 工具、从 Facet 搬来的指纹模块
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import type { BrowserHost } from '../src/core/mcpServer'
import {
  browserBrief,
  browserUsage,
  CDP_PORT_TRIES,
  cleanUserAgent,
  DEFAULT_CDP_PORT,
  defaultBrowserPrefs,
  fingerprintDetails,
  fingerprintSummary,
  gpuName,
  normalizeProxy,
  parseBrowserPrefs,
  pickCdpPort,
  type BrowserInfo,
  type FingerprintEnv
} from '../src/shared/browser'
import { TOOL_NAMES } from '../src/shared/tools'

const req = createRequire(import.meta.url)
const FACET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/main/facet')

const ENV: FingerprintEnv = {
  cpu: 12,
  fingerprint: {
    enabled: true,
    seed: 'abc123',
    template: 'library-v1',
    hardware: true,
    webgl: true,
    canvas: true,
    audio: true,
    rects: false,
    screenWidth: 1920,
    screenHeight: 1080,
    availHeight: 1032,
    memory: 16,
    touch: 0,
    colorDepth: 24,
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)'
  }
}

describe('设置', () => {
  it('默认：CDP 开在 9333，指纹开着、还没生成，时区语言跟出口 IP 走，代理跟系统', () => {
    expect(defaultBrowserPrefs()).toEqual({ cdp: { enabled: true, port: DEFAULT_CDP_PORT }, fingerprint: { enabled: true }, region: { enabled: true }, proxy: '' })
    expect(DEFAULT_CDP_PORT).toBe(9333)
    for (const raw of [null, undefined, 'x', 7, []]) expect(parseBrowserPrefs(raw)).toEqual(defaultBrowserPrefs())
  })

  it('parseBrowserPrefs：开关和端口照存的来，坏的用默认；没有种子的指纹不算', () => {
    expect(parseBrowserPrefs({ cdp: { enabled: false, port: 9400 }, fingerprint: { enabled: false, env: ENV } })).toEqual({ cdp: { enabled: false, port: 9400 }, fingerprint: { enabled: false, env: ENV }, region: { enabled: true }, proxy: '' })
    expect(parseBrowserPrefs({ cdp: { enabled: 'no', port: 80 } }).cdp).toEqual({ enabled: true, port: DEFAULT_CDP_PORT })
    expect(parseBrowserPrefs({ cdp: { port: 70000 } }).cdp.port).toBe(DEFAULT_CDP_PORT)
    expect(parseBrowserPrefs({ cdp: { port: 9333.5 } }).cdp.port).toBe(DEFAULT_CDP_PORT)
    expect(parseBrowserPrefs({ fingerprint: { env: { cpu: 8 } } }).fingerprint.env).toBeUndefined()
    expect(parseBrowserPrefs({ fingerprint: { env: { fingerprint: { seed: '' } } } }).fingerprint.env).toBeUndefined()
    expect(parseBrowserPrefs({ fingerprint: { enabled: true, env: ENV } }).fingerprint.env).toBe(ENV)
  })
})

describe('地区和代理', () => {
  const last = { ip: '203.0.113.7', countryCode: 'US', country: 'United States', timezone: 'America/Chicago', language: 'en-US', at: 1_700_000_000_000 }

  it('parseBrowserPrefs：地区的开关和上次查到的出口照存的来；出口信息不全的不要', () => {
    expect(parseBrowserPrefs({ region: { enabled: false, last } }).region).toEqual({ enabled: false, last })
    expect(parseBrowserPrefs({ region: { last: { ...last, extra: 1 } } }).region).toEqual({ enabled: true, last })
    for (const bad of [{ ...last, ip: '' }, { ...last, countryCode: 'usa' }, { ...last, timezone: '' }, { ...last, language: undefined }, { ...last, at: 'now' }, 'x', null]) expect(parseBrowserPrefs({ region: { last: bad } }).region.last).toBeUndefined()
    expect(parseBrowserPrefs({ region: { enabled: 'yes' } }).region.enabled).toBe(true)
  })

  it('normalizeProxy：空 / system 跟系统，direct 直连，主机:端口 当 http 代理，带协议的只认 http、https、socks4、socks5', () => {
    expect(normalizeProxy('')).toBe('')
    expect(normalizeProxy('  ')).toBe('')
    expect(normalizeProxy('System')).toBe('')
    expect(normalizeProxy(' Direct ')).toBe('direct')
    expect(normalizeProxy('127.0.0.1:7897')).toBe('http://127.0.0.1:7897')
    expect(normalizeProxy('HTTP://Proxy.Example:8080/')).toBe('http://proxy.example:8080')
    expect(normalizeProxy('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080')
    expect(normalizeProxy('socks4://10.0.0.2:1080')).toBe('socks4://10.0.0.2:1080')
    expect(normalizeProxy('https://p.example:443')).toBe('https://p.example:443')
    expect(normalizeProxy('[::1]:8080')).toBe('http://[::1]:8080')
    for (const bad of ['not a proxy', 'ftp://x:21', '127.0.0.1', 'http://x', 'x:0', 'x:70000', 'http://user:pw@x:80', 'http://x:80/path', 7, null, undefined]) expect(normalizeProxy(bad)).toBeUndefined()
  })

  it('parseBrowserPrefs：代理地址规整后存；不认的当没填', () => {
    expect(parseBrowserPrefs({ proxy: '127.0.0.1:7897' }).proxy).toBe('http://127.0.0.1:7897')
    expect(parseBrowserPrefs({ proxy: 'direct' }).proxy).toBe('direct')
    expect(parseBrowserPrefs({ proxy: 'whatever' }).proxy).toBe('')
    expect(parseBrowserPrefs({ proxy: 5 }).proxy).toBe('')
  })

  it('Facet 的 exit-locale：出口在哪国，就用那国的时区和常用语言；信息不全就报错', () => {
    const exit = req(path.join(FACET, 'exit-locale.cjs'))
    expect(exit.fromProbe({ ip: '203.0.113.7', countryCode: 'us', country: 'United States', timezone: 'America/Chicago' })).toMatchObject({ ip: '203.0.113.7', countryCode: 'US', timezone: 'America/Chicago', language: 'en-US' })
    expect(exit.fromProbe({ ip: '203.0.113.7', countryCode: 'JP', timezone: 'Asia/Tokyo' }).language).toBe('ja-JP')
    expect(exit.fromProbe({ ip: '203.0.113.7', countryCode: 'DE', timezone: 'Europe/Berlin' }).language).toBe('de-DE')
    expect(exit.fromProbe({ ip: '203.0.113.7', countryCode: 'HK', timezone: 'Asia/Hong_Kong' }).language).toBe('zh-HK')
    expect(() => exit.fromProbe({ ip: '203.0.113.7', countryCode: 'US' })).toThrow()
    expect(() => exit.fromProbe({ ip: 'nope', countryCode: 'US', timezone: 'America/Chicago' })).toThrow()
    expect(() => exit.fromProbe({ ip: '203.0.113.7', countryCode: 'ZZ', timezone: 'America/Chicago' })).toThrow()
  })

  it('Facet 的 ip-services：照顺序问查询服务，第一个答不了就问下一个；WebRTC 策略是不走代理的 UDP 不发', async () => {
    const { IPLookup } = req(path.join(FACET, 'ip-services.cjs'))
    const asked: string[] = []
    const lookup = new IPLookup({ providers: [{ id: 'ipsb', name: 'A', url: 'https://a.example/geo' }, { id: 'ipsb', name: 'B', url: 'https://b.example/geo' }], interval: 0 })
    const fetcher = async (url: string): Promise<Response> => {
      asked.push(url)
      if (url.startsWith('https://a.')) return new Response('nope', { status: 500 })
      return new Response(JSON.stringify({ ip: '203.0.113.7', country_code: 'US', country: 'United States', timezone: 'America/Chicago' }), { status: 200 })
    }
    const r = await lookup.lookup('k', fetcher, AbortSignal.timeout(5000), { force: true, requireLocale: true })
    expect(asked).toEqual(['https://a.example/geo', 'https://b.example/geo'])
    expect(r).toMatchObject({ ip: '203.0.113.7', countryCode: 'US', country: 'United States', timezone: 'America/Chicago' })
    expect(req(path.join(FACET, 'webrtc-policy.cjs')).POLICY).toBe('disable_non_proxied_udp')
  })
})

describe('CDP 端口', () => {
  const prefs = { enabled: true, port: 9333 }
  const free = (busy: number[] = []) => async (p: number) => !busy.includes(p)

  it('命令行已经带了端口：用它的，别的都不看', async () => {
    expect(await pickCdpPort({ cmdline: '51234', env: 'off', prefs: { enabled: false, port: 9333 }, isFree: free() })).toEqual({ source: 'cmdline', port: 51234 })
    expect(await pickCdpPort({ cmdline: '0', prefs, isFree: free() })).toEqual({ source: 'cmdline', note: '端口由命令行指定' })
  })

  it('环境变量 WB_CDP_PORT：off / 0 不开，数字就用这个端口；乱写的当没写', async () => {
    for (const env of ['off', '0', 'OFF', 'false']) expect((await pickCdpPort({ env, prefs, isFree: free() })).source).toBe('off')
    expect(await pickCdpPort({ env: ' 9555 ', prefs: { enabled: false, port: 9333 }, isFree: free([9555]) })).toEqual({ source: 'env', port: 9555 })
    expect(await pickCdpPort({ env: 'abc', prefs, isFree: free() })).toEqual({ source: 'prefs', port: 9333 })
    expect(await pickCdpPort({ env: '80', prefs, isFree: free() })).toEqual({ source: 'prefs', port: 9333 })
  })

  it('设置里关了就不开；开着就从设置的端口起找第一个没被占的，换了端口要说一声', async () => {
    expect(await pickCdpPort({ prefs: { enabled: false, port: 9333 }, isFree: free() })).toEqual({ source: 'off' })
    expect(await pickCdpPort({ prefs, isFree: free() })).toEqual({ source: 'prefs', port: 9333 })
    expect(await pickCdpPort({ prefs, isFree: free([9333, 9334]) })).toEqual({ source: 'prefs', port: 9335, note: '9333 被别的程序占着，这次用 9335' })
    const all = Array.from({ length: CDP_PORT_TRIES }, (_, i) => 9333 + i)
    const none = await pickCdpPort({ prefs, isFree: free(all) })
    expect(none.source).toBe('off')
    expect(none.port).toBeUndefined()
    expect(none.note).toContain('9333–9342 都被占着')
  })
})

describe('指纹的说明', () => {
  it('cleanUserAgent：去掉应用名和 Electron/版本，别的不动', () => {
    const raw = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) workspace-bridge/0.1.0 Chrome/140.0.7339.41 Electron/45.2.1 Safari/537.36'
    expect(cleanUserAgent(raw)).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.41 Safari/537.36')
    const plain = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
    expect(cleanUserAgent(plain)).toBe(plain)
  })

  it('gpuName / fingerprintDetails / fingerprintSummary', () => {
    expect(gpuName(ENV.fingerprint?.renderer)).toBe('NVIDIA GeForce RTX 3060')
    expect(gpuName('ANGLE (Intel, Intel(R) UHD Graphics (0x00009BC4) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('Intel(R) UHD Graphics')
    expect(gpuName('Something Else')).toBe('Something Else')
    expect(gpuName(undefined)).toBe('')
    expect(fingerprintDetails(ENV)).toEqual([
      { label: '显卡', value: 'NVIDIA GeForce RTX 3060' },
      { label: '屏幕', value: '1920×1080' },
      { label: 'CPU', value: '12 线程' },
      { label: '内存', value: '16 GB' },
      { label: '加噪', value: 'Canvas、音频' }
    ])
    expect(fingerprintSummary(ENV)).toBe('NVIDIA GeForce RTX 3060 · 1920×1080 · 12 线程 · 16 GB')
    expect(fingerprintDetails(undefined)).toEqual([])
    // 没开「硬件」那一项时不报屏幕和内存
    expect(fingerprintSummary({ cpu: 8, fingerprint: { ...ENV.fingerprint, hardware: false } })).toBe('NVIDIA GeForce RTX 3060 · 8 线程')
  })
})

describe('讲给 AI 听的', () => {
  const info: BrowserInfo = { cdp: 'http://127.0.0.1:9333', tabs: [], fingerprint: { enabled: true, summary: 'NVIDIA GeForce RTX 3060 · 1920×1080 · 12 线程 · 16 GB' } }

  it('握手说明里的一小节：有这个东西、地址、先调哪个工具', () => {
    const on = browserBrief('http://127.0.0.1:9333')
    expect(on).toContain('## 内置浏览器')
    expect(on).toContain('http://127.0.0.1:9333')
    for (const t of ['browser_info', 'browser_open', 'browser_close']) expect(on).toContain(t)
    expect(browserBrief(undefined)).toContain('CDP 这次没开')
  })

  it('browser_info 的用法：地址、三步、该注意的几条、一个能直接跑的例子', () => {
    const u = browserUsage(info)
    for (const s of ['http://127.0.0.1:9333/json/list', 'type 是 "webview"', 'browser_open', 'browser_close', 'app://bundle', 'Target.createTarget', 'suppress_origin=True', 'defaultViewport: null', '指纹开着（NVIDIA GeForce RTX 3060', 'run_command', 'webSocketDebuggerUrl']) expect(u).toContain(s)
    const off = browserUsage({ tabs: [], cdpNote: '设置里关着', fingerprint: { enabled: false } })
    expect(off).toContain('CDP 这次没开（设置里关着）')
    expect(off).toContain('指纹没开')
    expect(off).not.toContain('指纹开着')
    // 时区和语言：跟出口走时写明是哪国、什么时区和语言；没有就说是这台电脑真实的
    expect(off).toContain('时区和语言是这台电脑真实的')
    const withRegion = browserUsage({ ...info, region: { country: 'United States', timezone: 'America/Chicago', language: 'en-US' } })
    expect(withRegion).toContain('出口在 United States，网页看到的时区是 America/Chicago、语言是 en-US')
    expect(withRegion).toContain('setTimezoneOverride')
    for (const u2 of [u, off, withRegion]) expect(u2).toContain('WebRTC 不走代理的 UDP 是禁掉的')
  })
})

describe('从 Facet 搬来的指纹模块', () => {
  it('十二个文件都在，README 写着来历', () => {
    for (const f of ['webrtc-policy.cjs', 'ip-services.cjs', 'network-error.cjs', 'exit-locale.cjs', 'fingerprint.cjs', 'fingerprint-catalog.cjs', 'fingerprint-catalog.json', 'fingerprint-inject.js', 'gpu-identity.cjs', 'environment-contexts.cjs', 'environment-target-readiness.cjs', 'environment-service-worker.cjs']) expect(fs.existsSync(path.join(FACET, f)), f).toBe(true)
    expect(fs.readFileSync(path.join(FACET, 'README.md'), 'utf8')).toContain('arena-core')
  })

  it('同一个种子生成同一套，换种子就换一套；生成的东西我们的说明读得懂', () => {
    const fp = req(path.join(FACET, 'fingerprint.cjs'))
    const catalog = req(path.join(FACET, 'fingerprint-catalog.cjs'))
    const a = fp.preset(catalog.ID, {}, 'seed-one') as FingerprintEnv
    const b = fp.preset(catalog.ID, {}, 'seed-one') as FingerprintEnv
    expect(b).toEqual(a)
    expect(a.fingerprint).toMatchObject({ enabled: true, seed: 'seed-one', template: catalog.ID, hardware: true, webgl: true, canvas: true, audio: true })
    expect(a.fingerprint?.renderer).toMatch(/^ANGLE \(/)
    expect(a.cpu).toBeGreaterThan(0)
    const d = fingerprintDetails(a)
    expect(d.map((x) => x.label)).toEqual(['显卡', '屏幕', 'CPU', '内存', '加噪'])
    expect(d[0].value).not.toContain('ANGLE')
    // 存下来再读回去还是这一套
    expect(parseBrowserPrefs(JSON.parse(JSON.stringify({ fingerprint: { enabled: true, env: a } }))).fingerprint.env).toEqual(a)
    const seeds = ['s1', 's2', 's3', 's4', 's5', 's6']
    expect(new Set(seeds.map((s) => fingerprintSummary(fp.preset(catalog.ID, {}, s)))).size).toBeGreaterThan(1)
  })

  it('注入脚本：带着这一套的数值；UA 是不带 Electron 字样的 Chrome', () => {
    const fp = req(path.join(FACET, 'fingerprint.cjs'))
    const ua = fp.generatedUserAgent() as string
    expect(ua).toMatch(/^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/[\d.]+ Safari\/537\.36$/)
    const src = fp.script({ ...ENV, userAgent: ua, platform: 'Win32', language: '', scale: 0 }) as string
    expect(src).toContain('"WebGlRenderer":"ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)"')
    expect(src).toContain('"ScreenWidth":1920')
    expect(src).toContain('"DeviceMemory":16')
    expect(src).toContain('"WorkerCPU":12')
    // 语言和缩放没让它改
    expect(src).toContain('"WorkerLanguage":""')
    expect(src).toContain('"DevicePixelRatio":0')
    expect(src).not.toContain('/*__FACET_FP_PAYLOAD__*/null')
    expect(fp.script({ ...ENV, fingerprint: { ...ENV.fingerprint, enabled: false } })).toBeNull()
  })
})

describe('MCP 的 browser_* 工具', () => {
  let base: string
  let bridge: Bridge
  const clients: Client[] = []
  let started = false

  async function start(browser?: BrowserHost): Promise<Client> {
    started = true
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-browser-'))
    const root = path.join(base, 'ws')
    fs.mkdirSync(root, { recursive: true })
    bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'user-skills'), ...(browser ? { browser } : {}) })
    await bridge.start()
    const agent = bridge.createAgent('Alice')
    const c = new Client({ name: 'browser-test', version: '1.0.0' })
    await c.connect(new StreamableHTTPClientTransport(new URL(bridge.getState().mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${agent.token}` } } }))
    clients.push(c)
    return c
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; data: any }> {
    const r = await c.callTool({ name, arguments: args })
    const body = (r.content as { type: string; text: string }[]).map((p) => p.text).find((t) => !t.startsWith('【通知】')) ?? ''
    let data: unknown = body
    try {
      data = JSON.parse(body)
    } catch {
      // 不是 JSON 就留原文
    }
    return { isError: Boolean(r.isError), data }
  }

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    if (!started) return
    started = false
    await bridge.stop()
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
  })

  it('三个工具都在工具目录里', () => {
    for (const t of ['browser_info', 'browser_open', 'browser_close']) expect(TOOL_NAMES).toContain(t)
  })

  it('没有界面的工作台：握手说明里不提内置浏览器，三个工具都答 UNAVAILABLE', async () => {
    const c = await start()
    expect(c.getInstructions()).not.toContain('## 内置浏览器')
    for (const [name, args] of [['browser_info', {}], ['browser_open', { url: 'https://a.example/' }], ['browser_close', { tab: 't_x' }]] as const) {
      const r = await call(c, name, args)
      expect(r.isError).toBe(true)
      expect(r.data.error).toBe('UNAVAILABLE')
    }
  })

  it('有内置浏览器：握手说明带 CDP 地址；browser_info 给现状和用法；browser_open / browser_close 转给主进程', async () => {
    const opened: { url: string; focus?: boolean }[] = []
    const closed: string[] = []
    const tab = { tab: 't_ai1', target: 'TARGET1', url: 'https://a.example/', title: 'A', ws: 'ws://127.0.0.1:9333/devtools/page/TARGET1' }
    const host: BrowserHost = {
      brief: () => ({ cdp: 'http://127.0.0.1:9333' }),
      info: async () => ({ cdp: 'http://127.0.0.1:9333', tabs: [tab], fingerprint: { enabled: true, summary: 'NVIDIA GeForce RTX 3060 · 1920×1080 · 12 线程 · 16 GB' } }),
      open: async (url, opts) => {
        if (url.startsWith('ftp:')) throw new Error('只能打开 http、https、file 地址')
        opened.push({ url, focus: opts.focus })
        return { ...tab, url }
      },
      close: (id) => {
        if (id !== 't_ai1') return false
        closed.push(id)
        return true
      }
    }
    const c = await start(host)
    const ins = c.getInstructions() ?? ''
    expect(ins).toContain('## 内置浏览器')
    expect(ins).toContain('CDP 开在 http://127.0.0.1:9333')

    const info = await call(c, 'browser_info')
    expect(info.isError).toBe(false)
    expect(info.data.cdp).toBe('http://127.0.0.1:9333')
    expect(info.data.tabs).toEqual([tab])
    expect(info.data.fingerprint.enabled).toBe(true)
    expect(info.data.usage).toContain('http://127.0.0.1:9333/json/list')

    const o = await call(c, 'browser_open', { url: 'https://b.example/x' })
    expect(o.isError).toBe(false)
    expect(o.data).toMatchObject({ tab: 't_ai1', url: 'https://b.example/x', ws: tab.ws })
    expect(o.data.hint).toContain('browser_close')
    await call(c, 'browser_open', { url: 'https://c.example/', focus: false })
    expect(opened).toEqual([{ url: 'https://b.example/x', focus: true }, { url: 'https://c.example/', focus: false }])
    const bad = await call(c, 'browser_open', { url: 'ftp://x/' })
    expect(bad.isError).toBe(true)
    expect(bad.data.error).toBe('BROWSER_OPEN_FAILED')
    expect(bad.data.message).toContain('只能打开')

    expect((await call(c, 'browser_close', { tab: 't_ai1' })).data).toEqual({ closed: 't_ai1' })
    const gone = await call(c, 'browser_close', { tab: 't_nope' })
    expect(gone.isError).toBe(true)
    expect(gone.data.error).toBe('NOT_FOUND')
    expect(closed).toEqual(['t_ai1'])
  })

  it('CDP 没开：握手说明和 browser_info 都照实说', async () => {
    const host: BrowserHost = { brief: () => ({}), info: async () => ({ tabs: [], cdpNote: '设置里关着', fingerprint: { enabled: false } }), open: async () => ({ tab: 't', url: 'https://a.example/', title: '' }), close: () => false }
    const c = await start(host)
    expect(c.getInstructions()).toContain('CDP 这次没开')
    const info = await call(c, 'browser_info')
    expect(info.data.cdp).toBeNull()
    expect(info.data.cdp_note).toBe('设置里关着')
    expect(info.data.usage).toContain('CDP 这次没开（设置里关着）')
    const o = await call(c, 'browser_open', { url: 'https://a.example/' })
    expect(o.data.hint).toContain('CDP 没开')
  })
})
