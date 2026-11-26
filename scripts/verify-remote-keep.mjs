// Remote view, 「重启后保留」 (keep across restarts): end-to-end check on an isolated instance of a built candidate.
// Usage (repo root, ELECTRON_RUN_AS_NODE unset): node scripts/verify-remote-keep.mjs <out dir> [screenshot dir] [--no-tunnel]
// Isolated: temp data dir, random ports. The instance is closed the same way the live switch closes the workbench (a close request to the
// main window, not a forced kill) and started again on the same data dir. The last part opens a real Cloudflare quick tunnel to the isolated
// instance for about a minute (pass --no-tunnel to skip). Kills only its own Electron trees and its own cloudflared (by pid).
import { spawn } from 'node:child_process'
import dns from 'node:dns'
import fs from 'node:fs'
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
const hide = (s) => String(s ?? '').replace(/\/rv\/[\w-]+/g, '/rv/<hidden>').replace(/wb_rv=[\w-]+/g, 'wb_rv=<hidden>')

async function cdp(port, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(3000) })).json()).find((t) => t.type === 'page')
      if (page) {
        const sock = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((r) => sock.addEventListener('open', r, { once: true }))
        let id = 0; const pending = new Map()
        sock.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) pending.get(m.id)(m) })
        const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, (m) => resolve(m.result ?? m.error)); sock.send(JSON.stringify({ id: i, method, params })) })
        const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r?.exceptionDetails ? { __error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text } : r?.result?.value }
        return { send, ev, close: () => { try { sock.close() } catch { /* gone */ } } }
      }
    } catch { /* not yet */ }
    await sleep(250)
  }
  return null
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vrk-'))
const ws = path.join(base, 'ws'), home = path.join(base, 'home'), data = path.join(base, 'data'), ud = path.join(base, 'ud')
for (const d of [ws, home, data, ud]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(ws, 'hello.txt'), 'hello keep\n')
const prefFile = path.join(data, 'remote-view.json')
const keptFile = path.join(data, 'remote-view-kept.json')
const tunnelRec = path.join(data, 'remote-tunnel', 'tunnel-kept.json')
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const kill = new Set()
let PORT, CDP

/** Start the isolated instance on the shared data dir and wait until the window answers. */
async function launch() {
  const { ELECTRON_RUN_AS_NODE: _d, ELECTRON_RENDERER_URL: _r, ...env } = process.env
  const app = spawn(electronPath, [path.join(OUT, 'main', 'index.js'), `--remote-debugging-port=${CDP}`, `--user-data-dir=${ud}`], {
    cwd: process.cwd(),
    // LAN mode would listen on 0.0.0.0 and make Windows Firewall ask; here it listens on loopback and reports loopback as 'the LAN address'
    env: { ...env, WB_DATA_DIR: data, WB_USER_SKILLS_DIR: path.join(home, 'skills'), WB_MACHINE_ROOT: home, WB_REMOTE_LAN_HOST: '127.0.0.1', WB_REMOTE_LAN_ADDRS: '127.0.0.1' },
    stdio: 'ignore'
  })
  kill.add(app.pid)
  const exited = new Promise((r) => app.once('exit', r))
  let up = false
  for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(3000) })).ok } catch { await sleep(250) } }
  if (!up) throw new Error('isolated instance did not come up')
  // The debugging port is the same on every start. If a process kept from the previous run still held it (inherited handle), this is where it shows.
  const desk = await cdp(CDP, 40)
  if (!desk) throw new Error('the debugging port of the restarted instance does not answer (is a kept process still holding the port of the previous run?)')
  await sleep(1500)
  return { app, desk, exited }
}

/** Close it the way the live switch does: ask the main window to close (WM_CLOSE), never force. Returns whether it left on its own. */
async function closeGracefully(inst) {
  inst.desk.close()
  spawn('taskkill', ['/PID', String(inst.app.pid)], { stdio: 'ignore' })
  const left = await Promise.race([inst.exited.then(() => true), sleep(25000).then(() => false)])
  if (left) kill.delete(inst.app.pid)
  // the ports must be free again before the next start
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); await sleep(250) } catch { break } }
  await sleep(800)
  return left
}

const status = (desk) => desk.ev(`window.bridge.remoteViewStatus()`)
const openPanel = async (desk) => { await desk.ev(`(() => { if (!document.querySelector('[data-remote-popover]')) document.querySelector('[data-remote-button]').click(); return 1 })()`); await sleep(500) }
const getState = async (origin, cookie) => { try { const r = await fetch(origin + '/rv-api/invoke', { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-remote': '1', cookie }, body: JSON.stringify({ channel: 'bridge:getState', args: [] }) }); return [r.status, (await r.json().catch(() => null))?.result?.workspaces?.map((w) => w.name)] } catch (e) { return ['ERR ' + (e.cause?.code ?? e.message)] } }
const get = async (url, cookie) => { for (let i = 0; i < 2; i++) { try { return (await fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} })).status } catch (e) { if (i) return 'ERR ' + (e.cause?.code ?? e.message) } } }

async function main() {
  PORT = await freePort(); CDP = await freePort()
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ workspaces: [{ id: 'w_rktest00', name: 'rk-demo-space', root: ws }], activeWorkspaceId: 'w_rktest00', host: '127.0.0.1', port: PORT, roles: [],
    agents: [{ id: 'a-1', name: 'probeA', color: '#60a5fa', token: 'wb_vrk_aaaaaaaaaaaaaaaaaaaaaaaa', createdAt: Date.now() }] }))
  console.log(`candidate ${OUT}\n`)

  // ===== 1. the switch: off by default, in the panel, remembered =====
  let inst = await launch()
  let desk = inst.desk
  const off = await status(desk)
  check('1 fresh instance: remote view off, 重启后保留 off, nothing saved', off?.state === 'off' && off.keep === false && !fs.existsSync(keptFile), off)
  await openPanel(desk)
  const sw0 = await desk.ev(`(() => { const p = document.querySelector('[data-remote-popover]'); const s = p?.querySelector('[data-remote-keep]'); if (!s) return null; const r = s.getBoundingClientRect(); return { role: s.getAttribute('role'), on: s.getAttribute('aria-checked'), label: s.getAttribute('aria-label'), disabled: s.disabled, w: Math.round(r.width), h: Math.round(r.height), text: p.innerText, opts: p.querySelectorAll('[data-remote-opt]').length } })()`)
  check('1 the panel has a third capsule switch 「重启后保留」, off, usable, with what it means and the caution about the saved passcode', sw0 && sw0.role === 'switch' && sw0.on === 'false' && sw0.label === '重启后保留' && sw0.disabled === false && sw0.w >= sw0.h * 1.5 && sw0.opts === 2 && sw0.text.includes('重启后保留') && sw0.text.includes('口令会存在这台电脑上') && sw0.text.includes('照旧能用'), sw0)
  // LAN only for the first parts: no outside network involved
  await desk.ev(`window.bridge.remoteViewSetOptions({ lan: true }).then(() => window.bridge.remoteViewSetOptions({ tunnel: false }))`)
  await desk.ev(`document.querySelector('[data-remote-popover] [data-remote-keep]').click()`); await sleep(600)
  const on1 = await status(desk)
  const swOn = await desk.ev(`document.querySelector('[data-remote-popover] [data-remote-keep]')?.getAttribute('aria-checked')`)
  check('1 clicking it while off: switch on, status says keep, saved in remote-view.json; still off and still nothing in the kept record', on1?.keep === true && on1.state === 'off' && swOn === 'true' && readJson(prefFile)?.keep === true && readJson(prefFile)?.lan === true && !fs.existsSync(keptFile), [on1, readJson(prefFile)])

  // ===== 2. open it, a phone comes in, the record follows =====
  const st = await desk.ev(`window.bridge.remoteViewStart({})`)
  await sleep(500)
  const link = st?.lanUrls?.[0]
  const origin = link ? new URL(link).origin : ''
  const rec1 = readJson(keptFile)
  check('2 opened (LAN only): on, and the kept record holds this port and this passcode, no device yet', st?.state === 'on' && st.keep === true && !st.resumed && Boolean(link) && rec1?.port === Number(new URL(link).port) && link.endsWith('/rv/' + rec1.passcode) && rec1.sessions.length === 0 && rec1.lan === true && rec1.tunnel === false, { st: hide(JSON.stringify(st)), rec: rec1 && { ...rec1, passcode: '<hidden>', sessions: rec1.sessions.length } })
  const entry = await fetch(link, { redirect: 'manual' })
  const cookie = (entry.headers.get('set-cookie') ?? '').split(';')[0]
  await sleep(400)
  const rec2 = readJson(keptFile)
  const gs1 = await getState(origin, cookie)
  check('2 a device enters with the link: it works, and its cookie is added to the record', entry.status === 302 && cookie.startsWith('wb_rv=') && rec2?.sessions?.length === 1 && rec2.sessions[0] === cookie.split('=')[1] && gs1[0] === 200 && gs1[1]?.includes('rk-demo-space'), [entry.status, rec2?.sessions?.length, gs1])
  const startedAt = st?.startedAt

  // ===== 3. the workbench restarts: same link, the open page keeps working, nobody touched anything =====
  const left1 = await closeGracefully(inst)
  const rec3 = readJson(keptFile)
  check('3 closing the workbench (a normal close, like the live switch does): it leaves on its own and the record stays', left1 === true && rec3?.passcode === rec2?.passcode && rec3?.sessions?.length === 1, [left1, rec3 && rec3.sessions.length])
  check('3 while it is down the link does not answer', String(await get(link)).startsWith('ERR'), await get(link))
  inst = await launch(); desk = inst.desk
  const back = await status(desk)
  check('3 after the restart remote view is on again by itself: same LAN link (same port, same passcode), marked as resumed, same opening time', back?.state === 'on' && back.keep === true && back.resumed === true && back.lanUrls?.[0] === link && back.startedAt === startedAt && back.lan === true && back.tunnel === false, hide(JSON.stringify(back)))
  const page = await get(origin + '/', cookie)
  const gs2 = await getState(origin, cookie)
  check('3 the page that was open before the restart still works with its old cookie (page 200, a call answers)', page === 200 && gs2[0] === 200 && gs2[1]?.includes('rk-demo-space'), [page, gs2])
  const ev = await fetch(origin + '/rv-api/events?after=3', { headers: { cookie } }).then((r) => r.json(), () => null)
  check('3 its old push position is answered with "reload the page" (so it takes the state of the new process), not with silence', ev?.ok === true && ev.reset === true, ev)
  check('3 the same link lets a new device in; a wrong passcode is refused', (await get(link)) === 302 && (await get(origin + '/rv/' + 'z'.repeat(32))) === 403, [await get(link)])
  await openPanel(desk)
  const card = await desk.ev(`(() => { const p = document.querySelector('[data-remote-popover]'); return { text: p?.innerText ?? '', keep: p?.querySelector('[data-remote-keep]')?.getAttribute('aria-checked') } })()`)
  check('3 the panel shows it: 已开启, the switch on, 「工作台重启后接着开的」', card.text.includes('已开启') && card.keep === 'true' && card.text.includes('工作台重启后接着开的'), card.text.slice(0, 400))
  try { fs.mkdirSync(SHOTS, { recursive: true }); const shot = await desk.send('Page.captureScreenshot', { format: 'png' }); if (shot?.data) fs.writeFileSync(path.join(SHOTS, 'remote-keep-panel.png'), Buffer.from(shot.data, 'base64')) } catch { /* screenshot is optional */ }

  // ===== 4. changing the link, and closing it, end the kept link =====
  const renewed = await desk.ev(`window.bridge.remoteViewStart({ renew: true })`)
  await sleep(500)
  const link2 = renewed?.lanUrls?.[0]
  const rec4 = readJson(keptFile)
  check('4 换链接: new passcode, the old link and the old cookie are dead, the record now holds the new one and no devices', Boolean(link2) && link2 !== link && (await get(link)) !== 302 && (await get(new URL(link2).origin + '/', cookie)) === 403 && link2.endsWith('/rv/' + rec4?.passcode) && rec4.sessions.length === 0 && !renewed.resumed, [hide(link2), rec4 && rec4.sessions.length])
  await desk.ev(`window.bridge.remoteViewStop()`); await sleep(900)
  check('4 关闭: off, and the record is deleted (the switch itself stays on)', (await status(desk))?.state === 'off' && (await status(desk))?.keep === true && !fs.existsSync(keptFile), await status(desk))
  const left2 = await closeGracefully(inst)
  inst = await launch(); desk = inst.desk
  const stay = await status(desk)
  check('4 after a restart it stays off: what the user closed does not come back', left2 === true && stay?.state === 'off' && stay.keep === true && String(await get(link2)).startsWith('ERR'), [left2, stay])

  // ===== 5. with the switch off nothing is kept =====
  await desk.ev(`window.bridge.remoteViewSetOptions({ keep: false })`)
  const st5 = await desk.ev(`window.bridge.remoteViewStart({})`)
  await sleep(500)
  const link5 = st5?.lanUrls?.[0]
  check('5 switch off, then open: on, nothing written to the record', st5?.state === 'on' && st5.keep === false && Boolean(link5) && !fs.existsSync(keptFile) && readJson(prefFile)?.keep === undefined, [hide(JSON.stringify(st5)), readJson(prefFile)])
  const st5b = await desk.ev(`window.bridge.remoteViewSetOptions({ keep: true })`)
  await sleep(400)
  check('5 turning the switch on while it is open: the link does not change and the record is written right away', st5b?.keep === true && st5b.lanUrls?.[0] === link5 && link5.endsWith('/rv/' + readJson(keptFile)?.passcode), hide(JSON.stringify(st5b)))
  const st5c = await desk.ev(`window.bridge.remoteViewSetOptions({ keep: false })`)
  await sleep(400)
  check('5 turning it off again while open: still open on the same link, the record is deleted', st5c?.state === 'on' && st5c.keep === false && st5c.lanUrls?.[0] === link5 && !fs.existsSync(keptFile), hide(JSON.stringify(st5c)))
  const left3 = await closeGracefully(inst)
  inst = await launch(); desk = inst.desk
  const off5 = await status(desk)
  check('5 restart with the switch off: remote view is off, as before this feature', left3 === true && off5?.state === 'off' && off5.keep === false && String(await get(link5)).startsWith('ERR'), [left3, off5])

  // ===== 6. the public link survives the restart too (real Cloudflare quick tunnel) =====
  if (NO_TUNNEL) { console.log('SKIP  real tunnel (--no-tunnel)'); await closeGracefully(inst); return }
  await desk.ev(`window.bridge.remoteViewSetOptions({ keep: true, tunnel: true })`)
  let pub = await desk.ev(`window.bridge.remoteViewStart({})`)
  for (let i = 0; i < 70 && pub?.state === 'connecting'; i++) { await sleep(1000); pub = await status(desk) }
  const trec = readJson(tunnelRec)
  if (trec?.pid) kill.add(trec.pid)
  check('6 opened with a public link and the switch on: link arrives, and the tunnel process is recorded as kept (its own folder, not the one of the AI tunnel)', pub?.state === 'on' && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/rv\/[\w-]{32}$/.test(pub.link ?? '') && Number.isInteger(trec?.pid) && pidAlive(trec.pid) && trec.url === new URL(pub.link).origin && !fs.existsSync(path.join(data, 'tunnel-kept.json')), { state: pub?.state, error: pub?.error, link: hide(pub?.link), trec: trec && { pid: trec.pid, port: trec.port } })
  if (pub?.state !== 'on' || !trec?.pid) { await desk.ev(`window.bridge.remoteViewStop()`); await sleep(1500); await closeGracefully(inst); return }
  // A brand-new trycloudflare name takes a few seconds to exist in DNS; ask a public resolver first so the system cache does not remember "no such name".
  const pubDns = new dns.promises.Resolver({ timeout: 2000, tries: 1 })
  pubDns.setServers(['1.1.1.1', '8.8.8.8'])
  let dnsSeen = false
  for (let i = 0; i < 40 && !dnsSeen; i++) { try { dnsSeen = (await pubDns.resolve4(new URL(pub.link).hostname)).length > 0 } catch { /* not there yet */ } if (!dnsSeen) await sleep(2000) }
  await sleep(1500)
  let pe = null
  for (let i = 0; i < 20; i++) { try { pe = await fetch(pub.link, { redirect: 'manual' }); if (pe.status === 302) break } catch (e) { pe = { status: 'ERR ' + (e.cause?.code ?? e.message), headers: new Headers() } } await sleep(2000) }
  const pcookie = (pe.headers.get('set-cookie') ?? '').split(';')[0]
  const po = new URL(pub.link).origin
  check('6 through the public link before the restart: entry 302, a call answers', pe.status === 302 && (await getState(po, pcookie))[0] === 200, [pe.status, dnsSeen])
  const left4 = await closeGracefully(inst)
  check('6 closing the workbench leaves the tunnel process running and its record in place', left4 === true && pidAlive(trec.pid) && readJson(tunnelRec)?.pid === trec.pid, [left4, pidAlive(trec.pid)])
  inst = await launch(); desk = inst.desk
  let back6 = await status(desk)
  for (let i = 0; i < 20 && back6?.state === 'connecting'; i++) { await sleep(500); back6 = await status(desk) }
  check('6 the restarted workbench could open its own ports again: the kept tunnel process holds none of them (debugging port answers)', (await fetch(`http://127.0.0.1:${CDP}/json/version`, { signal: AbortSignal.timeout(3000) }).then((r) => r.status, () => 0)) === 200, CDP)
  check('6 after the restart: on by itself with the very same public link, the same tunnel process taken over (no new address requested)', back6?.state === 'on' && back6.link === pub.link && back6.resumed === true && readJson(tunnelRec)?.pid === trec.pid && pidAlive(trec.pid), { state: back6?.state, same: back6?.link === pub.link, pid: readJson(tunnelRec)?.pid === trec.pid })
  let after = null
  for (let i = 0; i < 10; i++) { after = await getState(po, pcookie); if (after[0] === 200) break; await sleep(1500) }
  check('6 through the public link after the restart: the old cookie still works and the link still lets a device in', after?.[0] === 200 && after[1]?.includes('rk-demo-space') && (await get(pub.link)) === 302, after)
  await desk.ev(`window.bridge.remoteViewStop()`); await sleep(2500)
  check('6 关闭 ends it for real: off, the kept tunnel process is gone, both records deleted', (await status(desk))?.state === 'off' && !pidAlive(trec.pid) && !fs.existsSync(tunnelRec) && !fs.existsSync(keptFile), [pidAlive(trec.pid), fs.existsSync(tunnelRec), fs.existsSync(keptFile)])

  // ===== 7. the tunnel the AIs use, kept on exit, is started the same way: it must not hold the workbench's ports either =====
  const aiRec = path.join(data, 'tunnel-kept.json')
  const tun = (s) => s?.tunnel ?? {}
  await desk.ev(`window.bridge.setTunnelSettings({ mode: 'quick', keepOnExit: true }).then(() => 1)`)
  let ai = tun(await desk.ev(`window.bridge.startTunnel()`))
  for (let i = 0; i < 70 && ai.status !== 'running' && ai.status !== 'error'; i++) { await sleep(1000); ai = tun(await desk.ev(`window.bridge.getState()`)) }
  const arec = readJson(aiRec)
  if (arec?.pid) kill.add(arec.pid)
  check('7 AI tunnel with 关闭应用时保留: running, kept, its process recorded', ai.status === 'running' && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(ai.url ?? '') && ai.kept === true && Number.isInteger(arec?.pid) && pidAlive(arec.pid), { status: ai.status, error: ai.error, kept: ai.kept, pid: arec?.pid })
  if (ai.status === 'running' && arec?.pid) {
    const left5 = await closeGracefully(inst)
    check('7 closing the workbench leaves that tunnel process running', left5 === true && pidAlive(arec.pid), [left5, pidAlive(arec.pid)])
    inst = await launch(); desk = inst.desk
    const ai2 = tun(await desk.ev(`window.bridge.getState()`))
    check('7 after the restart: the debugging port answers (launch got through), same public address, same process taken over', ai2.status === 'running' && ai2.url === ai.url && ai2.kept === true && readJson(aiRec)?.pid === arec.pid && (await fetch(`http://127.0.0.1:${CDP}/json/version`, { signal: AbortSignal.timeout(3000) }).then((r) => r.status, () => 0)) === 200, { status: ai2.status, same: ai2.url === ai.url, kept: ai2.kept })
    await desk.ev(`window.bridge.stopTunnel().then(() => 1)`); await sleep(1500)
    check('7 stopping it ends the process and deletes the record', !pidAlive(arec.pid) && !fs.existsSync(aiRec), [pidAlive(arec.pid), fs.existsSync(aiRec)])
  }
  await closeGracefully(inst)
}
main()
  .catch((e) => check('script ran', false, e.stack ?? String(e)))
  .finally(async () => {
    for (const f of [tunnelRec, path.join(data, 'tunnel-kept.json')]) { const t = readJson(f); if (t?.pid) kill.add(t.pid) }
    for (const pid of kill) if (pid && pidAlive(pid)) spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    await sleep(2500)
    try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* leftover temp */ }
    console.log(`\nPASS ${pass}, FAIL ${fail}`)
    process.exit(fail ? 1 : 0)
  })
