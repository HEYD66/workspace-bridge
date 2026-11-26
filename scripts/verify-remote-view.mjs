// Remote view (step 4): end-to-end check on an isolated instance of a built candidate.
// Usage (repo root, ELECTRON_RUN_AS_NODE unset): node scripts/verify-remote-view.mjs <out dir> [screenshot dir] [--no-tunnel]
// Isolated: temp data dir, random ports. The last part opens a real Cloudflare quick tunnel to the isolated instance for under a minute (pass --no-tunnel to skip). Kills only the Electron tree and the headless browser it started.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import dns from 'node:dns'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const OUT = path.resolve(process.argv[2] ?? 'out')
const NO_TUNNEL = process.argv.includes('--no-tunnel')
const SHOTS = path.resolve(process.argv.slice(3).find((a) => !a.startsWith('--')) ?? '_smoke_out/arena-sbx')
const electronPath = createRequire(import.meta.url)('electron')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
let pass = 0, fail = 0
const check = (name, ok, detail) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n      ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 900)}`) }

async function cdp(port, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page')
      if (page) {
        const sock = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((r) => sock.addEventListener('open', r, { once: true }))
        let id = 0; const pending = new Map()
        sock.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) pending.get(m.id)(m) })
        const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, (m) => resolve(m.result ?? m.error)); sock.send(JSON.stringify({ id: i, method, params })) })
        const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r?.exceptionDetails ? { __error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text } : r?.result?.value }
        return { send, ev }
      }
    } catch { /* not yet */ }
    await sleep(250)
  }
  return null
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vrv-'))
const ws = path.join(base, 'ws'), home = path.join(base, 'home'), data = path.join(base, 'data'), ud = path.join(base, 'ud')
for (const d of [ws, home, data, ud]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(ws, 'hello.txt'), 'hello remote\n')
const kill = []
async function main() {
  const PORT = await freePort(), CDP = await freePort(), BCDP = await freePort()
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ workspaces: [{ id: 'w_rvtest00', name: 'rv-demo-space', root: ws }], activeWorkspaceId: 'w_rvtest00', host: '127.0.0.1', port: PORT, roles: [],
    agents: [{ id: 'a-1', name: 'probeA', color: '#60a5fa', token: 'wb_vrv_aaaaaaaaaaaaaaaaaaaaaaaa', createdAt: Date.now() }] }))
  const { ELECTRON_RUN_AS_NODE: _d, ...env } = process.env
  const app = spawn(electronPath, [path.join(OUT, 'main', 'index.js'), `--remote-debugging-port=${CDP}`, `--user-data-dir=${ud}`], { cwd: process.cwd(), env: { ...env, WB_DATA_DIR: data, WB_USER_SKILLS_DIR: path.join(base, 'skills'), WB_MACHINE_ROOT: home, ELECTRON_RENDERER_URL: '',
    // LAN mode would listen on 0.0.0.0 and make Windows Firewall ask; here it listens on loopback and reports loopback as 'the LAN address'
    WB_REMOTE_LAN_HOST: '127.0.0.1', WB_REMOTE_LAN_ADDRS: '127.0.0.1' }, stdio: 'ignore' })
  kill.push(app.pid)
  let up = false
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok } catch { await sleep(250) } }
  if (!up) throw new Error('isolated instance did not come up')
  const desk = await cdp(CDP)
  if (!desk) throw new Error('no CDP page in the desktop window')
  await sleep(1500)
  console.log(`candidate ${OUT}\n`)

  // ===== desktop window still works through the refactored preload =====
  const st0 = await desk.ev(`window.bridge.getState().then(s => ({ ws: s.workspaces.map(w => w.name), isRemote: window.bridge.isRemote, text: document.body.innerText.length }))`)
  check('desktop window: preload API works (getState), isRemote=false, UI rendered', st0?.ws?.includes('rv-demo-space') && st0.isRemote === false && st0.text > 100, st0)
  const off = await desk.ev(`window.bridge.remoteViewStatus()`)
  check('remote view is off by default', off?.state === 'off' && !off.localUrl, off)
  await desk.ev(`(window.__rv = [], window.bridge.onRemoteView(s => window.__rv.push(s)), 1)`)

  // ===== the button on the icon rail, and LAN access =====
  {
  const rail = await desk.ev(`[...document.querySelectorAll('nav[aria-label="页面"] button')].map((b) => b.getAttribute('aria-label'))`)
  check('rail: a 远端查看 button sits right above 设置 (the last two buttons), marked off', Array.isArray(rail) && rail[rail.length - 2] === '远端查看' && rail[rail.length - 1] === '设置' && (await desk.ev(`document.querySelector('[data-remote-button]')?.getAttribute('data-remote-button')`)) === 'off', rail)
  await desk.ev(`document.querySelector('[data-remote-button]').click()`); await sleep(400)
  const pop0 = await desk.ev(`(() => { const p = document.querySelector('[data-remote-popover]'); if (!p) return null; const r = p.getBoundingClientRect(); return { text: p.innerText, left: r.left, bottom: r.bottom, top: r.top, vh: window.innerHeight, tunnel: p.querySelector('[data-remote-opt="tunnel"]')?.getAttribute('aria-checked') === 'true', kinds: [...p.querySelectorAll('[data-remote-opt]')].map((e) => { const r = e.getBoundingClientRect(); return { tag: e.tagName, role: e.getAttribute('role'), w: Math.round(r.width), h: Math.round(r.height), radius: parseFloat(getComputedStyle(e).borderRadius), opacity: getComputedStyle(e).opacity } }), boxes: p.querySelectorAll('input[type=checkbox]').length, tunnelDisabled: p.querySelector('[data-remote-opt="tunnel"]')?.disabled, lan: p.querySelector('[data-remote-opt="lan"]')?.getAttribute('aria-checked') === 'true' }})()`)
  check('rail button opens the remote-view panel next to it, inside the window: off, 开启 button, 公网链接 ticked (and locked, it is the only one), 局域网 not ticked', pop0 && pop0.text.includes('远端查看') && pop0.text.includes('已关闭') && pop0.text.includes('开启') && pop0.text.includes('局域网') && pop0.left > 50 && pop0.top >= 0 && pop0.bottom <= pop0.vh && pop0.tunnel === true && pop0.tunnelDisabled === true && pop0.lan === false, pop0)
  check('the two choices are capsule switches (role=switch, wider than tall, fully rounded ends, the locked one not dimmed), no checkbox left in the panel', pop0 && pop0.boxes === 0 && pop0.kinds.length === 2 && pop0.kinds.every((k) => k.tag === 'BUTTON' && k.role === 'switch' && k.w >= k.h * 1.5 && k.radius >= k.h / 2 && k.opacity === '1'), pop0?.kinds)
  check('status while off carries the remembered choice: public yes, LAN no', off?.tunnel === true && off?.lan === false, off)
  await desk.ev(`document.querySelector('[data-remote-popover] [data-remote-opt="lan"]').click()`); await sleep(500)
  const p1 = await desk.ev(`window.bridge.remoteViewStatus()`)
  const prefFile = path.join(data, 'remote-view.json')
  check('ticking 局域网 while off only remembers it (still off, nothing listening); saved in remote-view.json', p1?.state === 'off' && p1.lan === true && p1.tunnel === true && !p1.localUrl && fs.existsSync(prefFile) && JSON.parse(fs.readFileSync(prefFile, 'utf8')).lan === true, [p1, fs.existsSync(prefFile)])
  // public off for this part: no tunnel is started, so nothing here depends on the network
  const p2 = await desk.ev(`window.bridge.remoteViewSetOptions({ tunnel: false })`)
  check('unticking 公网链接 leaves LAN only', p2?.state === 'off' && p2.lan === true && p2.tunnel === false, p2)
  const none = await desk.ev(`window.bridge.remoteViewSetOptions({ lan: false }).then(() => 'accepted', (e) => String(e))`)
  check('turning both off is refused with a readable reason; the setting is unchanged', typeof none === 'string' && none.includes('至少留一个') && (await desk.ev(`window.bridge.remoteViewStatus()`)).lan === true, none)
  await desk.ev(`[...document.querySelectorAll('[data-remote-popover] button')].find((b) => b.innerText.includes('开启')).click()`)
  let lanOn
  for (let i = 0; i < 20; i++) { await sleep(300); lanOn = await desk.ev(`window.bridge.remoteViewStatus()`); if (lanOn?.state === 'on') break }
  check('开启 in the panel with LAN only: on at once (no public address to wait for), one LAN link with the same passcode as the local link, no public link', lanOn?.state === 'on' && lanOn.lan === true && lanOn.tunnel === false && !lanOn.link && Array.isArray(lanOn.lanUrls) && lanOn.lanUrls.length === 1 && /^http:\/\/127\.0\.0\.1:\d+\/rv\/[\w-]{32}$/.test(lanOn.lanUrls[0]) && new URL(lanOn.lanUrls[0]).pathname === new URL(lanOn.localUrl).pathname, { ...lanOn, lanUrls: lanOn?.lanUrls?.length, localUrl: Boolean(lanOn?.localUrl) })
  const lanEnt = await fetch(lanOn.lanUrls[0], { redirect: 'manual' })
  const lanSc = lanEnt.headers.get('set-cookie') ?? ''
  const lanCookie = lanSc.split(';')[0]
  check('the LAN link works like the other links: 302 with an HttpOnly session cookie (not Secure: plain http)', lanEnt.status === 302 && lanCookie.startsWith('wb_rv=') && /;\s*HttpOnly/i.test(lanSc) && !/;\s*Secure/i.test(lanSc), [lanEnt.status, lanSc.replace(/=[^;]+/, '=…')])
  const lanOrigin = new URL(lanOn.lanUrls[0]).origin
  const lanCall = (channel, args) => fetch(lanOrigin + '/rv-api/invoke', { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-remote': '1', cookie: lanCookie }, body: JSON.stringify({ channel, args }) }).then((r) => r.json())
  const lanState = await lanCall('bridge:getState', [])
  check('over the LAN link the real state comes back', lanState.ok && lanState.result.workspaces.some((w) => w.name === 'rv-demo-space'), lanState.ok)
  const lanOpt = await lanCall('remote:options', [{ lan: false, tunnel: true }])
  check('a remote page cannot change how the view is reachable (refused, nothing changed)', lanOpt.ok === false && lanOpt.error.includes('REMOTE_UNAVAILABLE') && (await desk.ev(`window.bridge.remoteViewStatus()`)).lan === true, lanOpt)
  await sleep(400)
  const pop1 = await desk.ev(`(() => { const p = document.querySelector('[data-remote-popover]'); const l = p?.querySelector('[data-remote-lan]'); return p ? { badge: p.innerText.includes('已开启'), connecting: p.innerText.includes('正在申请公网地址'), lan: l?.innerText ?? null, qr: !!p.querySelector('svg[role=img]'), lanDisabled: p.querySelector('[data-remote-opt="lan"]')?.disabled, button: document.querySelector('[data-remote-button]')?.getAttribute('data-remote-button') } : null })()`)
  const lanSecret = new URL(lanOn.lanUrls[0]).pathname.split('/').pop()
  check('panel while on: 已开启 (not "waiting for a public address"), the LAN link with its passcode hidden, no QR until asked; the rail button shows it is on', pop1 && pop1.badge && !pop1.connecting && pop1.lan?.includes('局域网链接') && pop1.lan.includes('/rv/••••') && !pop1.lan.includes(lanSecret) && pop1.qr === false && pop1.lanDisabled === true && pop1.button === 'on', { ...pop1, lan: pop1?.lan?.replace(lanSecret, '<secret>') })
  await desk.ev(`document.querySelector('[data-remote-lan] button[title="显示完整链接和二维码"]').click()`); await sleep(400)
  const pop2 = await desk.ev(`(() => { const l = document.querySelector('[data-remote-popover] [data-remote-lan]'); return { full: l.innerText.includes(${JSON.stringify(lanSecret)}), qr: l.querySelector('svg[role=img]')?.getAttribute('viewBox') ?? null } })()`)
  check('the eye button shows the full LAN link and its QR code', pop2?.full === true && /^0 0 \d+ \d+$/.test(pop2.qr ?? ''), pop2)
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); const sh = await desk.send('Page.captureScreenshot', { format: 'png' }); if (sh?.data) fs.writeFileSync(path.join(SHOTS, 'remote-lan-panel.png'), Buffer.from(sh.data, 'base64')) }
  // back to public + LAN: the listening address stays, the passcode changes (the view is reopened), then put everything back for the rest of the script
  await desk.ev(`window.bridge.remoteViewStop()`)
  for (let i = 0; i < 20; i++) { await sleep(300); if ((await desk.ev(`window.bridge.remoteViewStatus()`))?.state === 'off') break }
  const lanDead = await fetch(lanOn.lanUrls[0], { redirect: 'manual' }).then((r) => r.status, () => 'refused')
  check('关闭: the LAN link is dead (port closed)', lanDead === 'refused', lanDead)
  await desk.ev(`window.bridge.remoteViewSetOptions({ tunnel: true })`)
  const back = await desk.ev(`window.bridge.remoteViewSetOptions({ lan: false })`)
  check('settings put back: public yes, LAN no, still off', back?.state === 'off' && back.tunnel === true && back.lan === false && JSON.parse(fs.readFileSync(prefFile, 'utf8')).lan === false, back)
  const plain = await desk.ev(`window.bridge.remoteViewStart({ tunnel: false })`)
  check('with LAN off a start has no LAN links at all (only this PC can reach it)', plain?.state === 'on' && plain.lan === false && plain.lanUrls === undefined, { state: plain?.state, lan: plain?.lan, lanUrls: plain?.lanUrls })
  const flip = await desk.ev(`window.bridge.remoteViewSetOptions({ lan: true })`)
  check('ticking 局域网 while it is on reopens it at once: LAN link present, new passcode, the earlier link refused', flip?.state !== 'off' && flip.lan === true && flip.lanUrls?.length === 1 && new URL(flip.localUrl).pathname !== new URL(plain.localUrl).pathname && (await fetch(plain.localUrl, { redirect: 'manual' }).then((r) => r.status, () => 'refused')) !== 302, { state: flip?.state, lan: flip?.lan, n: flip?.lanUrls?.length })
  await desk.ev(`window.bridge.remoteViewStop()`)
  for (let i = 0; i < 30; i++) { await sleep(300); if ((await desk.ev(`window.bridge.remoteViewStatus()`))?.state === 'off') break }
  await desk.ev(`window.bridge.remoteViewSetOptions({ lan: false })`)
  await desk.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`); await sleep(300)
  check('Escape closes the panel; everything is off again', (await desk.ev(`!!document.querySelector('[data-remote-popover]')`)) === false && (await desk.ev(`window.bridge.remoteViewStatus()`))?.state === 'off')
  await desk.ev(`(window.__rv.length = 0, 1)`)
  }
  const on = await desk.ev(`window.bridge.remoteViewStart({ tunnel: false })`)
  check('remoteViewStart: on, with a local link that carries a passcode', on?.state === 'on' && /^http:\/\/127\.0\.0\.1:\d+\/rv\/[\w-]{32}$/.test(on.localUrl ?? '') && on.visits === 0, on)
  const origin = new URL(on.localUrl).origin
  check('remote port is a different port from the MCP port', new URL(on.localUrl).port !== String(PORT), on.localUrl)

  // ===== raw HTTP client =====
  check('no cookie: page 403, API 401', (await fetch(origin + '/')).status === 403 && (await fetch(origin + '/rv-api/events?after=-1')).status === 401)
  check('MCP port does not serve the remote entry', (await fetch(`http://127.0.0.1:${PORT}${new URL(on.localUrl).pathname}`)).status === 404)
  const ent = await fetch(on.localUrl, { redirect: 'manual' })
  const cookie = (ent.headers.get('set-cookie') ?? '').split(';')[0]
  check('entry link: 302 to / with a session cookie', ent.status === 302 && cookie.startsWith('wb_rv='), [ent.status, cookie.slice(0, 8)])
  const H = { 'content-type': 'application/json', 'x-wb-remote': '1', cookie }
  const inv = async (channel, args = [], undef) => (await fetch(origin + '/rv-api/invoke', { method: 'POST', headers: H, body: JSON.stringify({ channel, args, undef }) })).json()
  const html = await (await fetch(origin + '/', { headers: { cookie } })).text()
  const asset = html.match(/src="\.\/(assets\/[^"]+\.js)"/)?.[1]
  const js = asset ? await fetch(origin + '/' + asset, { headers: { cookie } }) : null
  check('with cookie: index.html and its script are served', html.includes('<div id="root">') && js?.status === 200 && (js.headers.get('content-type') ?? '').includes('javascript'), [html.slice(0, 80), asset, js?.status])
  const st = await inv('bridge:getState')
  check('invoke bridge:getState over HTTP returns the real state', st.ok && st.result.workspaces.some((w) => w.name === 'rv-demo-space'), st)
  const WS = st.result.activeWorkspaceId // the app re-issues workspace ids that are not in its own format
  const rd = await inv('files:read', [WS, 'hello.txt'])
  check('invoke files:read returns file content', rd.ok && JSON.stringify(rd.result).includes('hello remote'), rd)
  const local = await inv('workspace:add')
  check('a channel that pops a dialog on the PC is refused for remote callers (no dialog opened)', local.ok === false && local.error.includes('REMOTE_UNAVAILABLE'), local)
  const none = await inv('no:such')
  check('unknown channel: clean error', none.ok === false && none.error.includes('No handler registered'), none)
  const vis = await desk.ev(`window.bridge.remoteViewStatus().then(s => ({ s, pushed: window.__rv.map(x => x.visits) }))`)
  check('visit counter is 1 and the desktop window was told', vis?.s?.visits === 1 && vis.pushed.includes(1), vis)

  // terminal round trip: create, type, read the echo back through long polling
  const first = await (await fetch(origin + '/rv-api/events?after=-1', { headers: { cookie } })).json()
  const term = await inv('terminal:create', [{ workspaceId: WS, cols: 100, rows: 30 }])
  const termId = term.result?.id ?? term.result
  await sleep(1500)
  await fetch(origin + '/rv-api/send', { method: 'POST', headers: H, body: JSON.stringify({ channel: 'terminal:write', args: [termId, 'echo rv-$((40+2))-ok\r'] }) })
  let after = first.last, seen = '', channels = new Set()
  for (let i = 0; term.ok && i < 4 && !seen.includes('rv-42-ok'); i++) {
    const r = await (await fetch(origin + `/rv-api/events?after=${after}`, { headers: { cookie } })).json()
    for (const e of r.events) { channels.add(e.channel); if (e.channel === 'terminal:data' && e.args[0].id === termId) seen += e.args[0].data }
    after = r.last
  }
  check('terminal: typed a command over HTTP and got its output back by long polling', term.ok && seen.includes('rv-42-ok'), [term, seen.slice(-200), [...channels]])
  await inv('terminal:kill', [termId])

  // ===== a real browser opens the link =====
  const browser = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe')].find((p) => fs.existsSync(p))
  if (!browser) check('a browser is installed for the real-page check', false, 'no Edge / Chrome found')
  else {
    const b = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${BCDP}`, `--user-data-dir=${path.join(base, 'browser')}`, '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' })
    kill.push(b.pid)
    const page = await cdp(BCDP)
    if (!page) throw new Error('headless browser did not expose a page')
    await page.send('Page.enable'); await page.send('Runtime.enable')
    await page.send('Page.navigate', { url: on.localUrl })
    let ui = null
    for (let i = 0; i < 40; i++) {
      await sleep(500)
      ui = await page.ev(`({ url: location.href, remote: !!(window.bridge && window.bridge.isRemote), cls: document.documentElement.classList.contains('remote'), text: document.body ? document.body.innerText : '', vp: document.querySelector('meta[name=viewport]')?.content })`)
      if (ui?.remote && ui.text.includes('rv-demo-space')) break
    }
    check('browser: the link lands on / (passcode no longer in the address bar)', ui?.url === origin + '/', ui?.url)
    check('browser: window.bridge exists with isRemote=true and the real UI rendered (workspace name visible)', ui?.remote === true && ui.cls === true && ui.text.includes('rv-demo-space'), { ...ui, text: ui?.text?.slice(0, 300) })
    const shot = await page.send('Page.captureScreenshot', { format: 'png' })
    if (shot?.data) fs.writeFileSync(path.join(SHOTS, 'remote-view-browser.png'), Buffer.from(shot.data, 'base64'))
    // browser -> backend -> desktop
    await page.ev(`(window.__chat = [], window.bridge.onChanged((k, p) => window.__chat.push([k, p && p.text])), 1)`)
    const sent = await page.ev(`window.bridge.sendGroupChat({ channel: 'general', text: 'hello from the browser' }).then(m => m && (m.id || m.seq || true))`)
    await sleep(800)
    const deskChat = await desk.ev(`window.bridge.listGroupChat({ channel: 'general' }).then(r => JSON.stringify(r).includes('hello from the browser'))`)
    check('browser sends a group chat message; the desktop window sees it', Boolean(sent) && !sent.__error && deskChat === true, [sent, deskChat])
    // desktop -> backend -> browser (push over long polling)
    await desk.ev(`window.bridge.sendGroupChat({ channel: 'general', text: 'hello from the desktop' })`)
    let got = null
    for (let i = 0; i < 20; i++) { await sleep(300); got = await page.ev(`window.__chat`); if (JSON.stringify(got).includes('hello from the desktop')) break }
    check('desktop sends a message; the browser gets the push (chat event with the text)', JSON.stringify(got).includes('hello from the desktop'), got)
    const dlg = await page.ev(`window.bridge.addWorkspace().then(() => 'opened', e => String(e.message))`)
    check('browser: a PC-only action fails with a readable message in the same format as Electron IPC errors', typeof dlg === 'string' && dlg.startsWith("Error invoking remote method 'workspace:add':") && dlg.includes('只能在电脑上'), dlg)
    // phone-sized viewport
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 })
    await page.send('Page.reload'); await sleep(4000)
    const phone = await page.ev(`({ vp: document.querySelector('meta[name=viewport]')?.content, w: window.innerWidth, ok: document.body.innerText.includes('rv-demo-space'), shell: document.querySelector('[data-phone-shell]')?.getAttribute('data-phone-shell') ?? null, tabs: [...document.querySelectorAll('[data-phone-tabs] [data-phone-tab]')].map((b) => b.innerText.trim().split('\\n').pop()), rail: !!document.querySelector('aside'), overflow: document.documentElement.scrollWidth > window.innerWidth })`)
    check('phone-sized screen: the remote page switches to the phone layout by itself (laid out at the phone width, one column, four tabs at the bottom) and still shows the workspace', phone?.vp === 'width=device-width, initial-scale=1, viewport-fit=cover' && phone.w === 390 && phone.ok === true && phone.shell === 'main' && JSON.stringify(phone.tabs) === JSON.stringify(['会话', '任务', '活动', '更多']) && phone.rail === false && phone.overflow === false, phone)
    // the desktop look can still be chosen on a phone: then the page is drawn 1100 wide and scaled down, as before
    await page.ev(`(localStorage.setItem('wb.layout.phone', '0'), 1)`)
    await page.send('Page.reload'); await sleep(4000)
    const deskLook = await page.ev(`({ vp: document.querySelector('meta[name=viewport]')?.content, ok: document.body.innerText.includes('rv-demo-space'), shell: !!document.querySelector('[data-phone-shell]'), back: document.querySelector('[data-phone-return]')?.innerText.trim() ?? null })`)
    check('phone-sized screen, desktop look chosen: viewport set to the 1100 layout width, the desktop UI renders, and a button offers the phone layout again', deskLook?.vp === 'width=1100' && deskLook.ok === true && deskLook.shell === false && String(deskLook.back).includes('用手机版'), deskLook)
    await page.ev(`(localStorage.removeItem('wb.layout.phone'), 1)`)
    const shot2 = await page.send('Page.captureScreenshot', { format: 'png' })
    if (shot2?.data) fs.writeFileSync(path.join(SHOTS, 'remote-view-phone.png'), Buffer.from(shot2.data, 'base64'))
    // close from the desktop: the open page is cut off
    const stopped = await desk.ev(`window.bridge.remoteViewStop()`)
    await sleep(2500)
    const after2 = await page.ev(`({ overlay: document.body.innerText.includes('远端查看已经关掉'), call: 0 })`)
    const dead = await fetch(origin + '/', { headers: { cookie } }).then((r) => r.status, () => 'refused')
    const offNow = await desk.ev(`window.bridge.remoteViewStatus()`)
    check('stop from the desktop: status off, port closed, old cookie useless', stopped?.state === 'off' && offNow?.state === 'off' && dead === 'refused', [stopped, offNow, dead])
    check('the page that was open shows the "closed" notice', after2?.overlay === true, after2)
    const again = await desk.ev(`window.bridge.remoteViewStart({ tunnel: false })`)
    const oldEntry = await fetch(new URL(new URL(on.localUrl).pathname, new URL(again.localUrl).origin), { redirect: 'manual' }).then((r) => r.status, () => 'refused')
    check('start again: new passcode, the old link does not work', again?.state === 'on' && again.localUrl !== on.localUrl && oldEntry === 403, [again?.state, oldEntry])
  }

  // ===== switch panel and status bar in the desktop window =====
  const bar = await desk.ev(`(() => { const b = [...document.querySelectorAll('header button')].find(x => x.innerText.includes('远端')); if (!b) return null; const t = b.innerText; b.click(); return t })()`)
  check('status bar shows the remote-view indicator while it is on', typeof bar === 'string' && bar.includes('远端查看中'), bar)
  await sleep(800)
  const card = await desk.ev(`(() => { const h = [...document.querySelectorAll('span')].find(x => x.innerText === '远端查看'); const c = h && h.closest('.rounded-lg'); return c ? c.innerText : null })()`)
  check('clicking the indicator opens settings; the card shows state, visit count and the PC-only note', typeof card === 'string' && card.includes('已开启') && card.includes('用链接打开过') && card.includes('拿到链接的人就能操作这台电脑') && card.includes('关闭'), card)
  // settings page is open here: its on/off options are capsule switches too
  const sw = await desk.ev(`(async () => { const row = (t) => [...document.querySelectorAll('label')].find((l) => l.offsetParent !== null && l.innerText.includes(t)); const names = ['允许同一网络的设备连接', '启动应用时自动开隧道', '关闭应用时保留隧道', '包含 AI 的 token']; const kinds = names.map((t) => { const l = row(t); const s = l?.querySelector('[role=switch]'); const r = s?.getBoundingClientRect(); return { t, found: !!l, sw: !!s && s.tagName === 'BUTTON' && r.width >= r.height * 1.5, box: l ? l.querySelectorAll('input[type=checkbox]').length : -1 } }); const auto = () => row('启动应用时自动开隧道').querySelector('[role=switch]'); const wait = () => new Promise((r) => setTimeout(r, 900)); const a0 = auto().getAttribute('aria-checked'); auto().click(); await wait(); const a1 = auto().getAttribute('aria-checked'); const s1 = (await window.bridge.getState()).tunnelSettings.autoStart; row('启动应用时自动开隧道').querySelector('span').click(); await wait(); const a2 = auto().getAttribute('aria-checked'); const s2 = (await window.bridge.getState()).tunnelSettings.autoStart; const tok = () => row('包含 AI 的 token').querySelector('[role=switch]'); const t0 = tok().getAttribute('aria-checked'); tok().click(); await new Promise((r) => setTimeout(r, 300)); const t1 = tok().getAttribute('aria-checked'); tok().click(); row('启动应用时自动开隧道').scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 400)); return { kinds, a0, a1, s1, a2, s2, t0, t1 } })()`)
  check('settings page: the four on/off options are capsule switches, no checkbox left in those rows', sw?.kinds?.length === 4 && sw.kinds.every((k) => k.found && k.sw && k.box === 0), sw?.kinds)
  check('settings page: clicking a switch saves the setting (自动开隧道 off → on in the state), clicking its text switches it back; 包含 token flips too', sw && sw.a0 === 'false' && sw.a1 === 'true' && sw.s1 === true && sw.a2 === 'false' && sw.s2 === false && sw.t0 !== sw.t1, sw && { ...sw, kinds: undefined })
  if (SHOTS) { const sh = await desk.send('Page.captureScreenshot', { format: 'png' }); if (sh?.data) fs.writeFileSync(path.join(SHOTS, 'settings-switches.png'), Buffer.from(sh.data, 'base64')) }
  await desk.ev(`window.bridge.remoteViewStop()`); await sleep(1200)
  const barOff = await desk.ev(`({ bar: [...document.querySelectorAll('header button')].some(x => x.innerText.includes('远端')), card: [...document.querySelectorAll('span')].find(x => x.innerText === '远端查看')?.closest('.rounded-lg')?.innerText ?? '' })`)
  check('after stop: indicator gone, card says off and offers the start button', barOff?.bar === false && barOff.card.includes('已关闭') && barOff.card.includes('开启'), barOff)

  // ===== real public tunnel =====
  if (NO_TUNNEL) { console.log('SKIP  real tunnel (--no-tunnel)'); return }
  const c0 = await desk.ev(`(() => { const c = [...document.querySelectorAll('span')].find(x => x.innerText === '远端查看').closest('.rounded-lg'); [...c.querySelectorAll('button')].find(b => b.innerText.includes('开启')).click(); return 1 })()`)
  await sleep(700)
  const s1 = await desk.ev(`window.bridge.remoteViewStatus()`)
  check('start button in the card: returns at once in "connecting" with the local link already usable', c0 === 1 && (s1?.state === 'connecting' || s1?.state === 'on') && Boolean(s1.localUrl), s1)
  let pub = s1
  for (let i = 0; i < 70 && pub?.state === 'connecting'; i++) { await sleep(1000); pub = await desk.ev(`window.bridge.remoteViewStatus()`) }
  check('public address arrives: state on, link is https://<name>.trycloudflare.com/rv/<passcode> with the same passcode as the local link', pub?.state === 'on' && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/rv\/[\w-]{32}$/.test(pub.link ?? '') && new URL(pub.link).pathname === new URL(pub.localUrl).pathname, { state: pub?.state, error: pub?.error, link: (pub?.link ?? '').replace(/\/rv\/.*/, '/rv/<hidden>') })
  if (pub?.state === 'on') {
    const po = new URL(pub.link).origin
    // A brand-new trycloudflare name takes a few seconds to exist in DNS. Asking the system resolver too early gets "no such name",
    // and resolvers upstream remember that answer far longer than the 40 s this script retries for (seen as ERR ENOTFOUND on every try).
    // So first wait until a public resolver knows the name (asked directly, which leaves the system's cache alone), then make the first request.
    const pubDns = new dns.promises.Resolver({ timeout: 2000, tries: 1 })
    pubDns.setServers(['1.1.1.1', '8.8.8.8'])
    let dnsWait = 0, dnsSeen = false
    for (; dnsWait < 40 && !dnsSeen; dnsWait++) { try { dnsSeen = (await pubDns.resolve4(new URL(pub.link).hostname)).length > 0 } catch { /* not there yet */ } if (!dnsSeen) await sleep(2000) }
    console.log(`      (tunnel name ${dnsSeen ? 'in public DNS' : 'NOT in public DNS'} after ${dnsWait} tries)`)
    await sleep(1500)
    let pe = null
    for (let i = 0; i < 20; i++) { try { pe = await fetch(pub.link, { redirect: 'manual' }); if (pe.status === 302) break } catch (e) { pe = { status: 'ERR ' + (e.cause?.code ?? e.message), headers: new Headers() } } await sleep(2000) }
    const sc = pe.headers.get('set-cookie') ?? ''
    const pc = sc.split(';')[0]
    check('through the tunnel: entry link answers 302 and the cookie is marked Secure and HttpOnly', pe.status === 302 && pc.startsWith('wb_rv=') && /;\s*Secure/i.test(sc) && /;\s*HttpOnly/i.test(sc), [pe.status, sc.replace(/wb_rv=[^;]+/, 'wb_rv=<hidden>')])
    const PH = { 'content-type': 'application/json', 'x-wb-remote': '1', cookie: pc }
    const call = async (headers) => { const r = await fetch(po + '/rv-api/invoke', { method: 'POST', headers, body: JSON.stringify({ channel: 'bridge:getState', args: [] }) }); return [r.status, await r.json().catch(() => null)] }
    const good = await call({ ...PH, origin: po })
    check('through the tunnel: a call with the page\'s own Origin works', good[0] === 200 && good[1]?.ok === true && good[1].result.workspaces.some((w) => w.name === 'rv-demo-space'), [good[0], good[1]?.ok, good[1]?.error])
    const evil = await call({ ...PH, origin: 'https://evil.example' })
    const noHdr = await call({ 'content-type': 'application/json', cookie: pc, origin: po })
    const noCookie = await call({ 'content-type': 'application/json', 'x-wb-remote': '1', origin: po })
    check('through the tunnel: another site\'s Origin 403, missing custom header 403, no cookie 401', evil[0] === 403 && noHdr[0] === 403 && noCookie[0] === 401, [evil[0], noHdr[0], noCookie[0]])
    const page = await fetch(po + '/', { headers: { cookie: pc } })
    check('through the tunnel: the page itself is served', page.status === 200 && (await page.text()).includes('<div id="root">'), page.status)
    // panel: masked by default, eye shows the full link and a QR code
    await sleep(600)
    const masked = await desk.ev(`(() => { const c = [...document.querySelectorAll('span')].find(x => x.innerText === '远端查看').closest('.rounded-lg'); return { text: c.innerText, qr: !!c.querySelector('svg[role=img]') } })()`)
    const secret = new URL(pub.link).pathname.slice(4)
    check('panel: link shown with the passcode hidden and no QR code until asked', masked?.text.includes('trycloudflare.com/rv/••••') && !masked.text.includes(secret) && masked.qr === false, { ...masked, text: masked?.text?.replace(secret, '<LEAK>').slice(0, 400) })
    const shown = await desk.ev(`(async () => { const c = [...document.querySelectorAll('span')].find(x => x.innerText === '远端查看').closest('.rounded-lg'); c.querySelector('button[title^="显示完整链接"]').click(); await new Promise(r => setTimeout(r, 400)); const q = c.querySelector('svg[role=img]'); c.scrollIntoView({ block: 'center' }); return { full: c.innerText.includes(${JSON.stringify(secret)}), qr: q ? q.getAttribute('viewBox') : null, path: q ? q.querySelector('path').getAttribute('d').length : 0, bar: [...document.querySelectorAll('header button')].find(x => x.innerText.includes('远端'))?.innerText } })()`)
    check('panel: the eye button shows the full link and a QR code; status bar shows it is on with the visit count', shown?.full === true && /^0 0 \d+ \d+$/.test(shown.qr ?? '') && shown.path > 500 && (shown.bar ?? '').includes('远端查看中') && shown.bar.includes('打开过'), shown)
    await sleep(500)
    const ds = await desk.send('Page.captureScreenshot', { format: 'png' })
    if (ds?.data) fs.writeFileSync(path.join(SHOTS, 'remote-view-panel.png'), Buffer.from(ds.data, 'base64'))
    // QR in the screenshot would be a live credential: stop right away so it is dead before anyone reads the file
    const oldLink = pub.link
    const renewed = await desk.ev(`window.bridge.remoteViewStart({ renew: true, tunnel: false })`)
    await sleep(6000)
    const deadPub = await fetch(oldLink, { redirect: 'manual' }).then((r) => r.status, (e) => 'ERR ' + (e.cause?.code ?? e.message))
    check('change link: the old public link is dead (tunnel gone) and the passcode is new', renewed?.state === 'on' && !renewed.link && new URL(renewed.localUrl).pathname !== new URL(oldLink).pathname && deadPub !== 302 && deadPub !== 200, [renewed?.state, deadPub])
    await desk.ev(`window.bridge.remoteViewStop()`); await sleep(800)
  }
  const fin = await desk.ev(`window.bridge.remoteViewStatus()`)
  check('final state: off', fin?.state === 'off', fin)
}
main()
  .catch((e) => check('script ran', false, e.stack ?? String(e)))
  .finally(async () => {
    for (const pid of kill) if (pid) spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    await sleep(2500)
    try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* leftover temp */ }
    console.log(`\nPASS ${pass}, FAIL ${fail}`)
    process.exit(fail ? 1 : 0)
  })
