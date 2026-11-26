// The built-in browser: fingerprint, time zone and language following the exit IP, WebRTC and permissions, proxy setting, CDP on by default,
// and what AIs are told (browser_info / browser_open / browser_close). Checked on isolated instances.
// The exit IP lookup is pointed at this script's own server (WB_EXIT_PROBE_URL), so nothing here depends on the outside network.
// Usage (repo root, ELECTRON_RUN_AS_NODE unset): node scripts/verify-browser-fp.mjs <out dir> [screenshot dir]
// Isolated: temp data dirs, random ports, no tunnel. Pages come from a small local server it starts itself. Kills only the Electron trees it started.
// Three launches: (1) CDP port from WB_CDP_PORT, everything about the fingerprint and the tools; (2) the port from browser.json is taken -> the next one; (3) CDP switched off.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const OUT = path.resolve(process.argv[2] ?? 'out')
const SHOTS = process.argv[3] ? path.resolve(process.argv[3]) : null
const electronPath = createRequire(import.meta.url)('electron')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const listenOn = (port) => new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(null)); s.listen(port, '127.0.0.1', () => resolve(s)) })
const freePort = async () => { const s = await listenOn(0); const p = s.address().port; await new Promise((r) => s.close(r)); return p }
// two free ports next to each other. Picked at random below the range the system hands out by itself (49152 and up): there the port after a free one is often the next one somebody else gets, and a busy machine found no pair in 50 tries (twice in the full runs of batch 33 and 34)
const freePair = async (not) => { for (let i = 0; i < 300; i++) { const p = 20000 + Math.floor(Math.random() * 25000); if (p === not || p + 1 === not) continue; const a = await listenOn(p), b = await listenOn(p + 1); for (const s of [a, b]) if (s) await new Promise((r) => s.close(r)); if (a && b) return p } throw new Error('no two free ports in a row') }
let pass = 0, fail = 0
const check = (name, ok, detail) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n      ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1100)}`) }
const J = JSON.stringify
const TOKEN = 'wb_vbf_aaaaaaaaaaaaaaaaaaaaaa'

async function attach(port, pick, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(pick)
      if (t) {
        const sock = new WebSocket(t.webSocketDebuggerUrl)
        await new Promise((r, rej) => { sock.addEventListener('open', r, { once: true }); sock.addEventListener('error', rej, { once: true }) })
        let id = 0; const pending = new Map()
        sock.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) pending.get(m.id)(m) })
        const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, (m) => resolve(m.result ?? m.error)); sock.send(J({ id: n, method, params })) })
        const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r?.exceptionDetails ? { __error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text } : r?.result?.value }
        return { send, ev, close: () => sock.close(), target: t }
      }
    } catch { /* not yet */ }
    await sleep(250)
  }
  return null
}

async function mcp(port) {
  const c = new Client({ name: 'vbf', version: '1' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }))
  const call = async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 60000 })
    const body = (r.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).find((t) => !t.startsWith('【通知】')) ?? ''
    let d; try { d = JSON.parse(body) } catch { d = body }
    return { isError: Boolean(r.isError), data: d }
  }
  return { call, instructions: c.getInstructions() ?? '', close: () => c.close() }
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vbf-'))
const pids = []
let site, proxySrv
const requests = []
let geoHits = 0

// one isolated instance. extraEnv: e.g. { WB_CDP_PORT }. browserJson: written to <data>/browser.json before the start. No --remote-debugging-port on the command line.
async function launch(name, extraEnv = {}, browserJson, fixedPort) {
  const dir = path.join(base, name), ws = path.join(dir, 'alpha'), home = path.join(dir, 'home'), data = path.join(dir, 'data'), ud = path.join(dir, 'ud')
  for (const d of [ws, home, data, ud]) fs.mkdirSync(d, { recursive: true })
  const port = fixedPort ?? (await freePort())
  fs.writeFileSync(path.join(data, 'config.json'), J({ workspaces: [{ id: 'w_aaaa0001', name: 'alpha-proj', root: ws }], activeWorkspaceId: 'w_aaaa0001', host: '127.0.0.1', port, roles: [], agents: [{ id: 'a-1', name: 'Alice', color: '#60a5fa', token: TOKEN, createdAt: Date.now() }] }))
  if (browserJson) fs.writeFileSync(path.join(data, 'browser.json'), J(browserJson))
  const { ELECTRON_RUN_AS_NODE: _d, WB_CDP_PORT: _c, WB_EXIT_PROBE_URL: _e, ...env } = process.env
  const app = spawn(electronPath, [path.join(OUT, 'main', 'index.js'), `--user-data-dir=${ud}`], { cwd: process.cwd(), env: { ...env, WB_DATA_DIR: data, WB_USER_SKILLS_DIR: path.join(dir, 'skills'), WB_MACHINE_ROOT: home, ELECTRON_RENDERER_URL: '', WB_EXIT_PROBE_URL: 'off', ...extraEnv }, stdio: 'ignore' })
  pids.push(app.pid)
  let up = false
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${port}/health`)).ok } catch { /* not listening yet */ } if (!up) await sleep(250) }
  if (!up) throw new Error(`isolated instance "${name}" did not come up`)
  return { port, data, pid: app.pid, kill: async () => { spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); await sleep(1500) } }
}

async function main() {
  // ----- the pages to open -----
  const report = `({ ua: navigator.userAgent, platform: navigator.platform, cpu: navigator.hardwareConcurrency, mem: navigator.deviceMemory, sw: screen.width, sh: screen.height, avail: screen.availHeight, lang: navigator.language, langs: navigator.languages.join(','), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, loc: Intl.DateTimeFormat().resolvedOptions().locale, jan: new Date(2026, 0, 15).getTimezoneOffset() })`
  const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><script>window.__atLoad = ${report}</script></head><body><h1>${title}</h1>${body}</body></html>`
  site = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    requests.push({ path: u.pathname, ua: req.headers['user-agent'] ?? '', al: req.headers['accept-language'] ?? '', chua: req.headers['sec-ch-ua'] ?? '', platform: req.headers['sec-ch-ua-platform'] ?? '' })
    // what the exit-IP lookup gets back (the ip.sb format): an address in the US, Central time
    if (u.pathname === '/geo') { geoHits++; res.setHeader('content-type', 'application/json'); res.end(J({ ip: '203.0.113.7', country_code: 'US', country: 'United States', timezone: 'America/Chicago', organization: 'Fixture Net' })); return }
    if (u.pathname === '/worker.js') { res.setHeader('content-type', 'text/javascript'); res.end(`postMessage({ ua: navigator.userAgent, platform: navigator.platform, cpu: navigator.hardwareConcurrency, mem: navigator.deviceMemory, lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone })`); return }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (u.pathname === '/') res.end(page('Fixture Home', `<iframe id="f" src="http://localhost:${site.address().port}/frame" width="200" height="60"></iframe><script>addEventListener('message', (e) => { window.__frame = e.data }); const w = new Worker('/worker.js'); w.onmessage = (e) => { window.__worker = e.data }</script>`))
    else if (u.pathname === '/frame') res.end(`<!doctype html><meta charset="utf-8"><script>parent.postMessage(${report}, '*')</script>frame`)
    else if (u.pathname === '/two') res.end(page('Fixture Two', ''))
    else { res.statusCode = 404; res.end(page('Not Found', '')) }
  })
  await new Promise((r) => site.listen(0, '127.0.0.1', r))
  const SITE = `http://127.0.0.1:${site.address().port}`
  console.log(`candidate ${OUT}\nsite ${SITE}\n`)

  // ================= launch 1: the CDP port comes from WB_CDP_PORT =================
  const CDP = await freePort()
  const one = await launch('one', { WB_CDP_PORT: String(CDP), WB_EXIT_PROBE_URL: SITE + '/geo' })
  const ver = await (async () => { for (let i = 0; i < 40; i++) { try { return await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json() } catch { await sleep(250) } } return null })()
  check('1 CDP answers on the port from WB_CDP_PORT although nothing was passed on the command line (the port is set before the app is ready)', !!ver?.webSocketDebuggerUrl && /Chrome\//.test(ver.Browser ?? ''), ver)
  const desk = await attach(CDP, (t) => t.type === 'page' && t.url.startsWith('app://'))
  if (!desk) throw new Error('no CDP page for the workbench window')
  const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const s = await desk.send('Page.captureScreenshot', { format: 'png' }); if (s?.data) fs.writeFileSync(path.join(SHOTS, name), Buffer.from(s.data, 'base64')) }
  const waitFor = async (fn, ok = (v) => !!v, tries = 40, gap = 250) => { let v; for (let i = 0; i < tries; i++) { v = await fn().catch(() => undefined); if (ok(v)) break; await sleep(gap) } return v }
  await waitFor(() => desk.ev(`!!document.querySelector('[data-right-panel]')`), (v) => v === true, 80)

  const tabs = () => desk.ev(`[...document.querySelectorAll('[data-right-panel] [role=tab]')].map((x) => ({ kind: x.getAttribute('data-right-tab'), id: x.getAttribute('data-tab-id'), text: x.innerText.trim().split('\\n')[0], sel: x.getAttribute('aria-selected') === 'true' }))`)
  const sel = async () => (await tabs()).find((t) => t.sel)
  const click = (css) => desk.ev(`(() => { const b = document.querySelector(${J(css)}); if (!b) return false; b.click(); return true })()`)
  const closeTab = (id) => desk.ev(`(() => { const b = document.querySelector('[data-right-panel] [role=tab][data-tab-id=${J(id)}] [data-tab-close]'); if (!b) return false; b.click(); return true })()`)
  const go = (text) => desk.ev(`(() => { const i = [...document.querySelectorAll('[data-right-panel] input[data-browser-address]')].find((x) => getComputedStyle(x).visibility !== 'hidden' && x.offsetParent !== null); if (!i) return false; i.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${J(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`)
  const fpOf = (id) => desk.ev(`document.querySelector('[data-browser-tab=${J(id)}]')?.getAttribute('data-browser-fp') ?? null`)
  const status = () => desk.ev(`window.bridge.browserStatus()`)
  // the app may be in the middle of writing the file: read again instead of failing on half a file
  const stored = () => { for (let i = 0; ; i++) { try { return JSON.parse(fs.readFileSync(path.join(one.data, 'browser.json'), 'utf8')) } catch (e) { if (i >= 20) throw e } } }
  // run something inside the web-page tab that is on this address (the newest one if several)
  const inGuest = async (url, expr) => { const all = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).filter((t) => t.type === 'webview' && t.url === url); const t = all[0]; if (!t) return { __error: 'no web-page target for ' + url }; const g = await attach(CDP, (x) => x.id === t.id, 8); if (!g) return { __error: 'cannot attach' }; try { return await g.ev(expr) } finally { g.close() } }
  const glExpr = `(() => { try { const c = document.createElement('canvas').getContext('webgl'); const e = c.getExtension('WEBGL_debug_renderer_info'); return { vendor: c.getParameter(e.UNMASKED_VENDOR_WEBGL), renderer: c.getParameter(e.UNMASKED_RENDERER_WEBGL) } } catch (e) { return { error: String(e) } } })()`
  const uachExpr = `(async () => navigator.userAgentData ? { brands: navigator.userAgentData.brands, platform: navigator.userAgentData.platform, mobile: navigator.userAgentData.mobile, hi: await navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'platformVersion', 'architecture']) } : null)()`
  // open a fresh new-tab page, type the address, wait for the tab to carry this title; returns the tab
  const openPage = async (url, title) => { await click('[data-right-new]'); await sleep(250); await go(url); return waitFor(() => sel(), (v) => v?.kind === 'browser' && v.text === title, 60) }

  // ===== 2. on by default, one generated set =====
  const st0 = await status()
  check('2 a fresh profile has CDP on (running on that port) and the fingerprint on, with one generated set: 显卡 / 屏幕 / CPU / 内存 / 加噪', st0?.cdp?.enabled === true && st0.cdp.activePort === CDP && st0.cdp.ok === true && st0.cdp.source === 'env' && st0.cdp.url === `http://127.0.0.1:${CDP}` && st0.fingerprint?.enabled === true && J(st0.fingerprint.details.map((d) => d.label)) === J(['显卡', '屏幕', 'CPU', '内存', '加噪']) && !/Electron|workspace-bridge/i.test(st0.fingerprint.userAgent), st0)
  const env0 = stored().fingerprint?.env
  const f0 = env0?.fingerprint
  check('2 the set is saved in <data dir>/browser.json with its seed (so it is the same after a restart)', typeof f0?.seed === 'string' && f0.seed.length >= 16 && f0.enabled === true && f0.webgl === true && f0.hardware === true && f0.canvas === true && f0.audio === true && /^ANGLE \(/.test(f0.renderer ?? '') && env0.cpu > 0, env0)

  // ===== 3. the new-tab page shows both =====
  await click('[data-right-new]'); await sleep(600)
  const ui = await waitFor(() => desk.ev(`(() => { const p = document.querySelector('[data-browser-settings]'); if (!p) return null; return { text: p.innerText, fp: p.querySelector('[data-browser-fp-switch]')?.getAttribute('aria-checked'), cdp: p.querySelector('[data-browser-cdp-switch]')?.getAttribute('aria-checked'), url: p.querySelector('[data-browser-cdp-url]')?.innerText ?? null } })()`), (v) => v && v.url, 30)
  check('3 the new-tab page has a 浏览器 section: 指纹 switch (on) with the set spelled out and 换一套; CDP switch (on) with the address and 复制', ui?.fp === 'true' && ui.cdp === 'true' && ui.url === `http://127.0.0.1:${CDP}` && ['指纹', '换一套', 'CDP', '复制', 'browser_info', st0.fingerprint.details[0].value, st0.fingerprint.details[1].value].every((x) => ui.text.includes(x)), ui)
  await shot('browser-fp-settings.png')

  // ===== 4. a page sees the configured machine, from its very first script =====
  requests.length = 0
  await go(SITE.replace('http://', '') + '/')
  const home1 = await waitFor(() => sel(), (v) => v?.kind === 'browser' && v.text === 'Fixture Home', 60)
  const fpAttr = await fpOf(home1?.id)
  const at = await inGuest(SITE + '/', 'window.__atLoad')
  const want = { cpu: env0.cpu, mem: f0.memory, sw: f0.screenWidth, sh: f0.screenHeight, avail: f0.availHeight }
  check('4 the tab is marked 指纹 on, and the first script of the first page already saw the configured CPU threads, memory and screen', fpAttr === 'on' && at && at.cpu === want.cpu && at.mem === want.mem && at.sw === want.sw && at.sh === want.sh && at.avail === want.avail && at.platform === 'Win32', [fpAttr, at, want])
  check('4 the user agent is a plain Chrome one (no Electron, no app name), in the page and in the very first request the server got', at && !/Electron|workspace-bridge/i.test(at.ua) && /Chrome\/[\d.]+ Safari\/537\.36$/.test(at.ua) && requests.find((r) => r.path === '/')?.ua === at.ua && requests.every((r) => !/Electron|workspace-bridge/i.test(r.ua)), [at?.ua, requests.slice(0, 4)])
  const gl = await inGuest(SITE + '/', glExpr)
  check('4 WebGL reports the configured graphics card', gl?.renderer === f0.renderer && gl.vendor === f0.vendor, [gl, f0.renderer])
  const uach = await inGuest(SITE + '/', uachExpr)
  check('4 the UA client hints agree with the user agent: Windows, a Chromium brand with the same major version, not mobile', uach && uach.platform === 'Windows' && uach.mobile === false && uach.brands.some((b) => b.brand === 'Chromium' && at.ua.includes(`Chrome/${b.version}.`)), uach)
  const sys = await desk.ev(`({ lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, sw: screen.width, cpu: navigator.hardwareConcurrency })`)
  // ----- time zone and language follow the exit IP (the lookup said: US, America/Chicago) -----
  check('4 time zone and language follow the exit IP from the first script on: America/Chicago (360 minutes behind UTC in January), en-US for navigator and for Intl', at && at.tz === 'America/Chicago' && at.jan === 360 && at.lang === 'en-US' && at.langs.split(',')[0] === 'en-US' && at.loc === 'en-US', at)
  check('4 the very first request already says Accept-Language en-US, and the exit was looked up once', /^en-US/.test(requests.find((r) => r.path === '/')?.al ?? '') && geoHits === 1, [requests.find((r) => r.path === '/'), geoHits])
  const st4 = await status()
  check('4 the status shows where the exit is and what pages see: 203.0.113.7, United States, America/Chicago, en-US; WebRTC policy disable_non_proxied_udp', st4?.region?.enabled === true && st4.region.ip === '203.0.113.7' && st4.region.country === 'United States' && st4.region.timezone === 'America/Chicago' && st4.region.language === 'en-US' && st4.network?.webrtc === 'disable_non_proxied_udp' && st4.network.proxy === '', st4)
  check('4 the tab is marked with the region it was given', (await desk.ev(`document.querySelector('[data-browser-tab=${J(home1.id)}]')?.getAttribute('data-browser-region')`)) === 'America/Chicago · en-US')
  // ----- WebRTC and permissions -----
  const ice = await inGuest(SITE + '/', `new Promise((resolve) => { const out = []; const pc = new RTCPeerConnection(); pc.createDataChannel('x'); pc.onicecandidate = (e) => { if (e.candidate) out.push(e.candidate.candidate) }; pc.createOffer().then((o) => pc.setLocalDescription(o)); setTimeout(() => { pc.close(); resolve(out) }, 2500) })`)
  check('4 WebRTC sends nothing over UDP outside a proxy: no UDP candidates and no private or public IPv4 address in any candidate', Array.isArray(ice) && ice.every((c) => !/ udp /i.test(c) && !/\b\d{1,3}(\.\d{1,3}){3}\b/.test(c.replace(/\b(0\.0\.0\.0|127\.0\.0\.1)\b/g, ''))), ice)
  const perms = await inGuest(SITE + '/', `(async () => ({ notif: Notification.permission, cam: (await navigator.permissions.query({ name: 'camera' })).state, mic: (await navigator.permissions.query({ name: 'microphone' })).state, geo: (await navigator.permissions.query({ name: 'geolocation' })).state }))()`)
  check('4 permissions are not granted by default: notifications, camera, microphone and location are all denied', perms?.notif === 'denied' && perms.cam === 'denied' && perms.mic === 'denied' && perms.geo === 'denied', perms)
  const frame = await waitFor(() => inGuest(SITE + '/', 'window.__frame ?? null'), (v) => v && typeof v === 'object' && !v.__error, 30)
  check('4 a cross-site iframe in the page sees the same machine, time zone and language', frame && frame.cpu === want.cpu && frame.mem === want.mem && frame.sw === want.sw && frame.sh === want.sh && frame.ua === at.ua && frame.tz === 'America/Chicago' && frame.lang === 'en-US', frame)
  const worker = await waitFor(() => inGuest(SITE + '/', 'window.__worker ?? null'), (v) => v && typeof v === 'object' && !v.__error, 30)
  check('4 a Worker started by the page sees the same machine, time zone and language', worker && worker.cpu === want.cpu && worker.mem === want.mem && worker.ua === at.ua && worker.platform === 'Win32' && worker.tz === 'America/Chicago' && worker.lang === 'en-US', worker)
  const back = await desk.ev(`(() => { const b = [...document.querySelectorAll('[data-browser-tab] button[title="后退"]')].find((x) => getComputedStyle(x).visibility !== 'hidden' && x.offsetParent !== null); return b ? b.disabled : null })()`)
  check('4 后退 is not available on the first page (the blank page it waited on is not in the history)', back === true, back)
  await shot('browser-fp-page.png')

  // ===== 5. every tab is the same machine; a reload keeps it; DevTools does not knock it off =====
  const two = await openPage(SITE + '/two', 'Fixture Two')
  const at2 = await inGuest(SITE + '/two', 'window.__atLoad')
  const gl2 = await inGuest(SITE + '/two', glExpr)
  check('5 a second tab sees exactly the same machine', two?.kind === 'browser' && at2 && at2.cpu === want.cpu && at2.mem === want.mem && at2.sw === want.sw && at2.ua === at.ua && gl2?.renderer === f0.renderer, [at2, gl2])
  const dev = await desk.ev(`(async () => { const w = document.querySelector('webview[data-browser-view=${J(two.id)}]'); w.openDevTools(); await new Promise((r) => setTimeout(r, 1500)); const opened = w.isDevToolsOpened(); w.reload(); await new Promise((r) => setTimeout(r, 1500)); return opened })()`)
  const at3 = await waitFor(() => inGuest(SITE + '/two', 'window.__atLoad'), (v) => v && !v.__error && typeof v.cpu === 'number', 20)
  const gl3 = await inGuest(SITE + '/two', glExpr)
  await desk.ev(`document.querySelector('webview[data-browser-view=${J(two.id)}]').closeDevTools()`)
  check('5 with the developer tools open, a reloaded page still sees the configured machine', dev === true && at3 && at3.cpu === want.cpu && at3.mem === want.mem && at3.sw === want.sw && gl3?.renderer === f0.renderer, [dev, at3, gl3])

  // ===== 6. what AIs are told, and the three tools =====
  const ai = await mcp(one.port)
  check('6 the handshake instructions every AI gets have a 内置浏览器 section with the CDP address and the tools to start with', ai.instructions.includes('## 内置浏览器') && ai.instructions.includes(`CDP 开在 http://127.0.0.1:${CDP}`) && ['browser_info', 'browser_open', 'browser_close'].every((x) => ai.instructions.includes(x)), ai.instructions.slice(-500))
  const info = await ai.call('browser_info')
  const infoTabs = info.data?.tabs ?? []
  check('6 browser_info: the CDP address, the two open tabs with their ws addresses, the fingerprint summary, the region, and the usage text', !info.isError && info.data.usage.includes('America/Chicago') && info.data.cdp === `http://127.0.0.1:${CDP}` && infoTabs.length === 2 && infoTabs.every((t) => t.tab && t.target && t.ws === `ws://127.0.0.1:${CDP}/devtools/page/${t.target}`) && J(infoTabs.map((t) => t.url).sort()) === J([SITE + '/', SITE + '/two']) && info.data.fingerprint.enabled === true && info.data.fingerprint.summary === st0.fingerprint.summary && info.data.usage.includes(`http://127.0.0.1:${CDP}/json/list`) && info.data.usage.includes('指纹开着'), info.data)
  const viaWs = await (async () => { const t = infoTabs.find((x) => x.url === SITE + '/'); const g = await attach(CDP, (x) => x.id === t?.target, 8); if (!g) return null; try { return await g.ev('document.title') } finally { g.close() } })()
  check('6 the ws address from browser_info really is that tab (document.title through CDP)', viaWs === 'Fixture Home', viaWs)
  // close the pages, collapse the panel: browser_open must still work and bring the panel back
  await closeTab(two.id); await closeTab(home1.id); await sleep(300)
  await click('[data-right-panel] button[title="收起右栏"]'); await sleep(500)
  const gone = await desk.ev(`!document.querySelector('[data-right-panel]') || !!document.querySelector('aside[data-right-collapsed]')`)
  const opened = await ai.call('browser_open', { url: SITE + '/two' })
  const shown = await waitFor(() => sel(), (v) => v?.kind === 'browser' && v.text === 'Fixture Two', 20)
  check('6 browser_open with the right panel collapsed and no page open: the panel comes back with the new tab selected, and the tool returns after the page has loaded (title, tab id, ws address)', gone === true && !opened.isError && opened.data.title === 'Fixture Two' && opened.data.url === SITE + '/two' && /^t_ai/.test(opened.data.tab) && opened.data.ws?.startsWith(`ws://127.0.0.1:${CDP}/devtools/page/`) && shown?.id === opened.data.tab && (await desk.ev(`!document.querySelector('aside[data-right-collapsed]') && document.querySelector('[data-right-panel]')?.getBoundingClientRect().width > 200`)) === true, [gone, opened.data, shown])
  const aiPage = await (async () => { const g = await attach(CDP, (x) => x.id === opened.data?.target, 8); if (!g) return null; try { return await g.ev(`({ title: document.title, cpu: navigator.hardwareConcurrency, sw: screen.width })`) } finally { g.close() } })()
  check('6 the page an AI opened carries the fingerprint too, and is reachable through the returned ws address', aiPage?.title === 'Fixture Two' && aiPage.cpu === want.cpu && aiPage.sw === want.sw, aiPage)
  await desk.ev(`[...document.querySelectorAll('[data-right-panel] [role=tab]')].find((x) => x.getAttribute('data-right-tab') === 'activity')?.click()`); await sleep(300)
  const bg = await ai.call('browser_open', { url: SITE + '/', focus: false })
  check('6 browser_open with focus:false opens in the background: the user stays on the tab they were on', !bg.isError && bg.data.title === 'Fixture Home' && (await sel())?.kind === 'activity' && (await tabs()).some((t) => t.id === bg.data.tab), [bg.data, await tabs()])
  const bad = await ai.call('browser_open', { url: 'javascript:alert(1)' })
  check('6 browser_open refuses something that is not a web address', bad.isError && bad.data.error === 'BROWSER_OPEN_FAILED', bad.data)
  const c1 = await ai.call('browser_close', { tab: bg.data.tab })
  const afterClose = await waitFor(() => tabs(), (v) => v && !v.some((t) => t.id === bg.data.tab), 12)
  const c2 = await ai.call('browser_close', { tab: 't_nope' })
  check('6 browser_close closes that tab; an unknown id is NOT_FOUND', !c1.isError && !afterClose.some((t) => t.id === bg.data.tab) && c2.isError && c2.data.error === 'NOT_FOUND', [c1.data, afterClose, c2.data])
  await ai.close().catch(() => undefined)

  // ===== 7. 换一套 and the switch =====
  await click('[data-right-new]'); await sleep(500)
  await waitFor(() => desk.ev(`!!document.querySelector('[data-browser-fp-new]')`), (v) => v === true, 20)
  await waitFor(() => desk.ev(`!!document.querySelector('[data-browser-fp-new]:not([disabled])')`), (v) => v === true, 20)
  await click('[data-browser-fp-new]')
  const env1 = await waitFor(async () => stored().fingerprint?.env, (v) => v?.fingerprint?.seed && v.fingerprint.seed !== f0.seed, 20)
  const f1 = env1?.fingerprint
  check('7 换一套 saves a new set with a new seed', !!f1?.seed && f1.seed !== f0.seed && /^ANGLE \(/.test(f1.renderer ?? ''), env1)
  const oldPage = await inGuest(SITE + '/two', `({ cpu: navigator.hardwareConcurrency, sw: screen.width })`)
  const oldGl = await inGuest(SITE + '/two', glExpr)
  await go(SITE + '/')
  const fresh = await waitFor(() => sel(), (v) => v?.kind === 'browser' && v.text === 'Fixture Home', 60)
  const atNew = await inGuest(SITE + '/', 'window.__atLoad')
  const glNew = await inGuest(SITE + '/', glExpr)
  check('7 a tab opened afterwards sees the new set; the tab that was already open keeps the old one until it is reopened', atNew && atNew.cpu === env1.cpu && atNew.mem === f1.memory && atNew.sw === f1.screenWidth && glNew?.renderer === f1.renderer && oldPage?.cpu === want.cpu && oldPage.sw === want.sw && oldGl?.renderer === f0.renderer, [atNew, glNew, oldPage, oldGl, env1])
  await click('[data-right-new]'); await sleep(500)
  await waitFor(() => desk.ev(`!!document.querySelector('[data-browser-fp-switch]:not([disabled])')`), (v) => v === true, 20)
  await click('[data-browser-fp-switch]')
  await waitFor(async () => stored().fingerprint?.enabled, (v) => v === false, 20)
  const offText = await desk.ev(`document.querySelector('[data-browser-fp-summary]')?.innerText ?? ''`)
  requests.length = 0
  await go(SITE + '/two?off')
  const offTab = await waitFor(() => sel(), (v) => v?.kind === 'browser' && v.text === 'Fixture Two', 60)
  const atOff = await inGuest(SITE + '/two?off', 'window.__atLoad')
  check('7 with the switch off a new tab is marked off and sees the real screen and CPU of this machine; the user agent is still the plain Chrome one', stored().fingerprint.enabled === false && offText.includes('真实') && (await fpOf(offTab?.id)) === 'off' && atOff && atOff.sw === sys.sw && atOff.cpu === sys.cpu && !/Electron|workspace-bridge/i.test(atOff.ua) && requests.every((r) => !/Electron|workspace-bridge/i.test(r.ua)), [offText, atOff, sys])
  await click('[data-right-new]'); await sleep(500)
  await waitFor(() => desk.ev(`!!document.querySelector('[data-browser-fp-switch]:not([disabled])')`), (v) => v === true, 20)
  await click('[data-browser-fp-switch]')
  await waitFor(async () => stored().fingerprint?.enabled, (v) => v === true, 20)
  check('7 switching it back on keeps the same set (same seed), it does not make a new one', stored().fingerprint.enabled === true && stored().fingerprint.env.fingerprint.seed === f1.seed, stored())

  // ===== 7b. the region switch, and the proxy setting =====
  await waitFor(() => desk.ev(`!!document.querySelector('[data-browser-region-switch]:not([disabled])')`), (v) => v === true, 20)
  const regionText = await desk.ev(`document.querySelector('[data-browser-region-state]')?.innerText ?? ''`)
  check('7 the new-tab page shows the exit and what pages see (203.0.113.7, United States, America/Chicago, en-US) and how pages are routed', ['203.0.113.7', 'United States', 'America/Chicago', 'en-US'].every((x) => regionText.includes(x)) && (await desk.ev(`document.querySelector('[data-browser-network-state]')?.innerText ?? ''`)).includes('WebRTC'), regionText)
  await click('[data-browser-region-switch]')
  await waitFor(async () => stored().region?.enabled, (v) => v === false, 20)
  requests.length = 0
  await go(SITE + '/two?noregion')
  const noReg = await waitFor(() => sel(), (v) => v?.kind === 'browser' && v.text === 'Fixture Two', 60)
  const atNoReg = await inGuest(SITE + '/two?noregion', 'window.__atLoad')
  check('7 with 时区和语言跟出口 IP 走 switched off, a new tab sees this machine\'s own time zone and language', stored().region.enabled === false && atNoReg && atNoReg.tz === sys.tz && atNoReg.lang === sys.lang && !/^en-US/.test(requests.find((r) => r.path === '/two')?.al ?? 'x') === (sys.lang !== 'en-US') && noReg?.kind === 'browser', [atNoReg, sys, requests.find((r) => r.path === '/two')])
  await click('[data-right-new]'); await sleep(500)
  await waitFor(() => desk.ev(`!!document.querySelector('[data-browser-region-switch]:not([disabled])')`), (v) => v === true, 20)
  await click('[data-browser-region-switch]')
  await waitFor(async () => stored().region?.enabled === true && geoHits, (v) => v >= 2, 30)
  check('7 switching it back on looks the exit up again', stored().region.enabled === true && stored().region.last.timezone === 'America/Chicago' && geoHits >= 2, [stored().region, geoHits])
  // a tiny HTTP proxy of our own: it answers for a host name that does not exist, so the page can only load through it
  const proxied = []
  proxySrv = http.createServer((req, res) => { proxied.push(req.url); res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<!doctype html><title>Via Proxy</title>via proxy') })
  await new Promise((r) => proxySrv.listen(0, '127.0.0.1', r))
  const PX = proxySrv.address().port
  const setProxy = async (text) => { await waitFor(() => desk.ev(`!!document.querySelector('[data-browser-proxy]:not([disabled])')`), (v) => v === true, 20); await desk.ev(`(() => { const i = document.querySelector('[data-browser-proxy]'); i.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${J(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`); await sleep(200); return click('[data-browser-proxy-save]') }
  await setProxy('not a proxy')
  const badProxy = await waitFor(() => desk.ev(`document.querySelector('[data-browser-settings]')?.innerText ?? ''`), (v) => typeof v === 'string' && v.includes('代理地址不认'), 20)
  check('7 a proxy address that makes no sense is refused with a message and nothing is saved', badProxy.includes('代理地址不认') && (stored().proxy ?? '') === '', [badProxy.slice(0, 200), stored().proxy])
  await setProxy(`127.0.0.1:${PX}`)
  await waitFor(async () => stored().proxy, (v) => v === `http://127.0.0.1:${PX}`, 30)
  const stPx = await waitFor(() => status(), (v) => v?.network?.route === `PROXY 127.0.0.1:${PX}`, 20)
  check('7 host:port is saved as an http proxy and pages are routed through it', stored().proxy === `http://127.0.0.1:${PX}` && stPx?.network?.proxy === `http://127.0.0.1:${PX}` && stPx.network.route === `PROXY 127.0.0.1:${PX}`, stPx?.network)
  await waitFor(() => desk.ev(`!!document.querySelector('[data-browser-proxy]:not([disabled])')`), (v) => v === true, 40)
  await go('http://wb-proxy-check.invalid/hello')
  const viaTab = await waitFor(() => sel(), (v) => v?.kind === 'browser' && v.text === 'Via Proxy', 60)
  check('7 a page on a host name that does not exist loads, because the request went to the proxy', viaTab?.text === 'Via Proxy' && proxied.some((u) => u === 'http://wb-proxy-check.invalid/hello'), [viaTab, proxied])
  await click('[data-right-new]'); await sleep(500)
  await setProxy('direct')
  const stDirect = await waitFor(() => status(), (v) => v?.network?.route === 'DIRECT', 30)
  check('7 direct switches the proxy off for pages', stored().proxy === 'direct' && stDirect?.network?.route === 'DIRECT', stDirect?.network)
  await setProxy('')
  await waitFor(async () => stored().proxy, (v) => v === '', 30)
  check('7 an empty field goes back to following the system proxy', stored().proxy === '', stored().proxy)
  await waitFor(() => desk.ev(`!!document.querySelector('[data-browser-cdp-switch]:not([disabled])')`), (v) => v === true, 40)

  // ===== 8. the CDP switch only takes effect after a restart, and says so =====
  await waitFor(() => desk.ev(`!!document.querySelector('[data-browser-cdp-switch]:not([disabled])')`), (v) => v === true, 20)
  await click('[data-browser-cdp-switch]')
  await waitFor(async () => stored().cdp?.enabled, (v) => v === false, 20)
  const st8 = await status()
  check('8 turning the CDP switch off is saved, but this run keeps its port (it is a start-up setting)', stored().cdp.enabled === false && st8.cdp.enabled === false && st8.cdp.activePort === CDP && st8.cdp.ok === true, st8)
  await waitFor(() => desk.ev(`!!document.querySelector('[data-browser-cdp-switch]:not([disabled])')`), (v) => v === true, 20)
  await click('[data-browser-cdp-switch]')
  await waitFor(async () => stored().cdp?.enabled, (v) => v === true, 20)
  desk.close()
  await one.kill()

  // ================= launch 2: the port in browser.json is taken =================
  // the workbench's own port first, so the pair below cannot land on it
  const port2 = await freePort()
  const P = await freePair(port2)
  const blocker = await listenOn(P)
  const two2 = await launch('two', {}, { cdp: { enabled: true, port: P }, fingerprint: { enabled: true, env: env1 } }, port2)
  const desk2 = await attach(P + 1, (t) => t.type === 'page' && t.url.startsWith('app://'), 60)
  // the page target exists before the page has finished loading: wait for the workbench API to be there
  if (desk2) for (let i = 0; i < 80 && (await desk2.ev(`typeof window.bridge?.browserStatus`)) !== 'function'; i++) await sleep(250)
  const st2 = desk2 ? await desk2.ev(`window.bridge.browserStatus()`) : null
  check('9 with the configured port taken by another program, CDP comes up on the next port and says so', !!desk2 && st2?.cdp?.activePort === P + 1 && st2.cdp.ok === true && st2.cdp.source === 'prefs' && st2.cdp.port === P && (st2.cdp.note ?? '').includes(`${P} 被别的程序占着`), st2)
  const kept = JSON.parse(fs.readFileSync(path.join(two2.data, 'browser.json'), 'utf8'))
  check('9 the fingerprint set saved earlier is used as it is (same seed, same summary)', kept.fingerprint.env.fingerprint.seed === f1.seed && st2?.fingerprint?.enabled === true && st2.fingerprint.details[0].value.length > 0 && kept.cdp.port === P, [kept.fingerprint?.env?.fingerprint?.seed, st2?.fingerprint])
  desk2?.close()
  await two2.kill()
  if (blocker) await new Promise((r) => blocker.close(r))

  // ================= launch 3: CDP switched off =================
  const port3 = await freePort()
  const Q = await freePair(port3)
  const three = await launch('three', {}, { cdp: { enabled: false, port: Q } }, port3)
  await sleep(2500)
  const answers = await Promise.all([Q, Q + 1].map((p) => fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false)))
  const health = await fetch(`http://127.0.0.1:${three.port}/health`).then((r) => r.ok, () => false)
  check('10 with CDP switched off in browser.json the workbench runs and no debugging port is opened', health === true && J(answers) === J([false, false]), [health, answers])
  const ai3 = await mcp(three.port)
  const info3 = await ai3.call('browser_info')
  check('10 and AIs are told so: the handshake says CDP is off, browser_info gives no address and explains how to turn it on', ai3.instructions.includes('CDP 这次没开') && !info3.isError && info3.data.cdp === null && info3.data.cdp_note === '设置里关着' && info3.data.usage.includes('CDP 这次没开'), [ai3.instructions.slice(-200), info3.data])
  await ai3.close().catch(() => undefined)
  await three.kill()
}
main()
  .catch((e) => check('script ran', false, e.stack ?? String(e)))
  .finally(async () => {
    try { site?.close() } catch { /* already closed */ }
    try { proxySrv?.close() } catch { /* already closed */ }
    for (const pid of pids) spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    await sleep(2000)
    try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* leftover temp */ }
    console.log(`\nPASS ${pass}, FAIL ${fail}`)
    process.exit(fail ? 1 : 0)
  })
