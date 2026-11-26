// The canvas page (画布), step 1 "能看": every project is a frame, every AI one card, lines for dispatched work, what waits for the user stands out,
// pan / zoom / drag with remembered positions, a roster in the sidebar, search, minimap, arrange with undo, a click opens the chat.
// Usage (repo root, ELECTRON_RUN_AS_NODE unset): node scripts/verify-canvas.mjs <out dir> [screenshot dir]
// Isolated: temp data dir, random port, no tunnel. Kills only the Electron tree it started.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const OUT = path.resolve(process.argv[2] ?? 'out')
const SHOTS = process.argv[3] ? path.resolve(process.argv[3]) : null
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vcv-'))
const wsA = path.join(base, 'alpha'), wsB = path.join(base, 'beta'), home = path.join(base, 'home'), data = path.join(base, 'data'), ud = path.join(base, 'ud')
for (const d of [wsA, wsB, home, data, ud]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(wsA, 'keep.txt'), 'line one\n')
const TOKENS = { a: 'wb_vcv_aaaaaaaaaaaaaaaaaaaaaa', b: 'wb_vcv_bbbbbbbbbbbbbbbbbbbbbb' }
let appPid

async function connect(token, port) {
  const c = new Client({ name: 'vcm', version: '1' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  const call = async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 60000 })
    const parts = (r.content ?? []).filter((p) => p.type === 'text').map((p) => p.text)
    const body = parts.find((t) => !t.startsWith('【通知】')) ?? ''
    let d; try { d = JSON.parse(body) } catch { d = body }
    return { isError: Boolean(r.isError), data: d, raw: body, notices: parts.filter((t) => t.startsWith('【通知】')).join('\n') }
  }
  return { call, close: () => c.close() }
}


async function main() {
  const PORT = await freePort(), CDP = await freePort()
  const WA = 'w_aaaa0001', WB = 'w_bbbb0002'
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ workspaces: [{ id: WA, name: 'alpha-proj', root: wsA }, { id: WB, name: 'beta-proj', root: wsB }], activeWorkspaceId: WB, host: '127.0.0.1', port: PORT, roles: [],
    agents: [{ id: 'a-1', name: 'Alice', color: '#60a5fa', token: TOKENS.a, createdAt: Date.now() }, { id: 'a-2', name: 'Bob', color: '#f472b6', token: TOKENS.b, createdAt: Date.now() }, { id: 'a-3', name: 'Carol', color: '#34d399', token: 'wb_vcv_cccccccccccccccccccccc', createdAt: Date.now() }] }))
  const { ELECTRON_RUN_AS_NODE: _d, ...env } = process.env
  const app = spawn(electronPath, [path.join(OUT, 'main', 'index.js'), `--remote-debugging-port=${CDP}`, `--user-data-dir=${ud}`], { cwd: process.cwd(), env: { ...env, WB_DATA_DIR: data, WB_USER_SKILLS_DIR: path.join(base, 'skills'), WB_MACHINE_ROOT: home, ELECTRON_RENDERER_URL: '' }, stdio: 'ignore' })
  appPid = app.pid
  let up = false
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok } catch { await sleep(250) } }
  if (!up) throw new Error('isolated instance did not come up')
  console.log(`candidate ${OUT}\n`)
  const desk = await cdp(CDP)
  if (!desk) throw new Error('no CDP page in the desktop window')
  const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const s = await desk.send('Page.captureScreenshot', { format: 'png' }); if (s?.data) fs.writeFileSync(path.join(SHOTS, name), Buffer.from(s.data, 'base64')) }
  const A = await connect(TOKENS.a, PORT), B = await connect(TOKENS.b, PORT)
  for (const x of [A, B]) await x.call('whoami')

  const J = JSON.stringify
  const waitFor = async (fn, tries = 40, gap = 200) => { let v; for (let i = 0; i < tries; i++) { v = await fn(); if (v) return v; await sleep(gap) } return v }
  const section = () => desk.ev(`localStorage.getItem('wb.nav.section')`)
  const clickRail = (start) => desk.ev(`(() => { const b = [...document.querySelectorAll('nav[aria-label="页面"] button')].find((x) => (x.getAttribute('aria-label') ?? '').startsWith(${J(start)})); if (!b) return false; b.click(); return true })()`)
  const box = (sel) => desk.ev(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 } })()`)
  // textContent, not innerText: zoomed far out the small print on cards is hidden, and what is checked here is the content
  const text = (sel) => desk.ev(`document.querySelector(${J(sel)})?.textContent?.replace(/\\s+/g, ' ').trim() ?? null`)
  const cards = () => desk.ev(`[...document.querySelectorAll('[data-cv-card]')].map((e) => e.dataset.cvCard)`)
  const cam = () => desk.ev(`(() => { const w = document.querySelector('[data-cv-world]'); if (!w) return null; const m = new DOMMatrix(getComputedStyle(w).transform); return { x: Math.round(m.e), y: Math.round(m.f), z: Math.round(m.a * 1000) / 1000 } })()`)
  // positions live in the workbench (the "all" canvas document), written a moment after the mouse is released
  const savedPos = async (key) => { await sleep(450); return desk.ev(`window.bridge.canvasAll().then((d) => { const n = d.all?.nodes?.[${J(key)}]; return n ? { x: n.x, y: n.y } : null })`) }
  const mouse = (type, x, y, extra = {}) => desk.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !extra.buttons ? 'none' : 'left', ...extra })
  const dragMouse = async (x0, y0, x1, y1, mods = 0) => {
    await mouse('mouseMoved', x0, y0)
    await mouse('mousePressed', x0, y0, { buttons: 1, clickCount: 1, modifiers: mods })
    for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * i) / 6, { buttons: 1, button: 'left', modifiers: mods }); await sleep(20) }
    await mouse('mouseReleased', x1, y1, { buttons: 0, clickCount: 1, modifiers: mods })
    await sleep(250)
  }
  const click = async (x, y, n = 1) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, { buttons: 1, clickCount: n }); await mouse('mouseReleased', x, y, { buttons: 0, clickCount: n }); await sleep(120) }
  const tool = (name) => desk.ev(`(() => { const b = document.querySelector('[data-cv-tool=${name}]'); if (!b) return false; b.click(); return true })()`)
  const key = async (k, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await desk.send('Input.dispatchKeyEvent', { type, key: k, code: k, modifiers, windowsVirtualKeyCode: k === 'Enter' ? 13 : 0, ...(type === 'keyDown' && k === 'Enter' ? { text: '\r' } : {}) }) }
  // press at one point, move in steps, release at another
  const pull = async (x1, y1, x2, y2) => {
    await mouse('mouseMoved', x1, y1); await sleep(60)
    await mouse('mousePressed', x1, y1, { buttons: 1, clickCount: 1 })
    for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', x1 + ((x2 - x1) * i) / 6, y1 + ((y2 - y1) * i) / 6, { buttons: 1 }); await sleep(30) }
    await mouse('mouseReleased', x2, y2, { buttons: 0, clickCount: 1 })
  }
  const still = async (fn) => { let a = J(await fn()); for (let i = 0; i < 30; i++) { await sleep(120); const b = J(await fn()); if (a === b) return JSON.parse(b); a = b } return JSON.parse(a) }
  const overlap = (p, q) => p.x < q.x + q.w - 1 && q.x < p.x + p.w - 1 && p.y < q.y + q.h - 1 && q.y < p.y + p.h - 1
  const ALICE = `a-1@${WA}`, BOB = `a-2@${WA}`, CAROL = 'a-3@lobby'
  const card = (k) => `[data-cv-card="${k}"]`

  // Alice gives Bob a task in alpha; Bob starts it. Carol never connects.
  const mk = await A.call('task_create', { workspace: WA, title: '把登录页做出来', assigneeId: 'Bob' })
  const ref = mk.data?.ref
  const started = await B.call('task_update', { task: ref, workspace: WA, status: 'in_progress' })

  await desk.ev(`(localStorage.setItem('wb.nav.section', 'overview'), localStorage.removeItem('wb.canvas.v1'), location.reload(), 1)`)
  await waitFor(async () => (await desk.ev(`!!document.querySelector('nav[aria-label="页面"]')`).catch(() => false)) === true, 80, 250)
  await sleep(600)

  // ===== 1. the page and what is on it =====
  const went = await clickRail('画布')
  const there = await waitFor(async () => (await desk.ev(`!!document.querySelector('[data-canvas]')`)) === true)
  check('1 画布 is a page on the rail, right after 首页; clicking it opens the canvas', went === true && there === true && (await section()) === 'canvas', [went, there, await section()])
  const c1 = await waitFor(async () => { const c = await cards(); return c.length === 3 ? c : null })
  const frames1 = await desk.ev(`[...document.querySelectorAll('[data-cv-frame]')].map((f) => [f.dataset.cvFrame, f.dataset.kind, f.querySelector('[data-cv-frame-head]').textContent.replace(/\\s+/g, ' ').trim()])`)
  check('1 one card per AI and one frame per project: Alice and Bob in alpha-proj (they share a task there), beta-proj is an empty frame, Carol (never connected) is in 没在项目里', J([...(c1 ?? [])].sort()) === J([ALICE, BOB, CAROL].sort()) && frames1.length === 3 && frames1[0][0] === WA && frames1[0][2].includes('alpha-proj') && frames1[0][2].includes('2 个 AI') && frames1[1][0] === WB && frames1[1][2].includes('0 个 AI') && frames1[2][0] === 'lobby' && frames1[2][2].includes('没在项目里'), [c1, frames1, String(mk.raw).slice(0, 200), String(started.raw).slice(0, 200)])
  const bob1 = await waitFor(async () => { const t = await text(card(BOB)); return t && t.includes(ref) ? t : null })
  const carol1 = await text(card(CAROL))
  check('1 a card says who it is, its state and what it is working on: Bob shows the task he started, Carol is 离线', !!bob1 && bob1.includes('Bob') && bob1.includes('把登录页做出来') && typeof carol1 === 'string' && carol1.includes('Carol') && carol1.includes('离线'), [bob1, carol1])
  const line1 = await desk.ev(`(() => { const p = document.querySelector('[data-cv-line-id="task:a-1>a-2"]'); const l = document.querySelector('[data-cv-line-label="task:a-1>a-2"]'); return p ? { state: p.dataset.state, d: p.getAttribute('d').length, arrow: p.getAttribute('marker-end'), label: l?.innerText ?? null } : null })()`)
  check('1 the dispatched task is a line with an arrow from Alice to Bob, coloured by its state, with a label naming the task', line1 && line1.state === 'in_progress' && line1.d > 20 && /^url\(#cv-arrow-/.test(line1.arrow) && String(line1.label).includes(ref), line1)
  const totals1 = await text('[data-cv-totals]')
  check('1 the corner totals: 3 AIs, nothing waits for the user, one offline', typeof totals1 === 'string' && totals1.includes('3 个 AI') && totals1.includes('等你 0') && totals1.includes('离线 1'), totals1)
  const geo1 = await still(() => desk.ev(`(() => { const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height } }; const host = r(document.querySelector('[data-canvas]')); return { host, cards: Object.fromEntries([...document.querySelectorAll('[data-cv-card]')].map((e) => [e.dataset.cvCard, r(e)])), frames: Object.fromEntries([...document.querySelectorAll('[data-cv-frame]')].map((e) => [e.dataset.cvFrame, r(e)])) } })()`))
  const inside = (c, f) => c.x >= f.x && c.y >= f.y && c.x + c.w <= f.x + f.w + 1 && c.y + c.h <= f.y + f.h + 1
  const ck = Object.keys(geo1.cards), fk = Object.keys(geo1.frames)
  let clash = 0
  for (let i = 0; i < ck.length; i++) for (let j = i + 1; j < ck.length; j++) if (overlap(geo1.cards[ck[i]], geo1.cards[ck[j]])) clash++
  for (let i = 0; i < fk.length; i++) for (let j = i + 1; j < fk.length; j++) if (overlap(geo1.frames[fk[i]], geo1.frames[fk[j]])) clash++
  check('1 first open: everything fits in the window, cards sit inside their own frame, nothing overlaps', clash === 0 && inside(geo1.cards[ALICE], geo1.frames[WA]) && inside(geo1.cards[BOB], geo1.frames[WA]) && inside(geo1.cards[CAROL], geo1.frames.lobby) && fk.every((k) => inside(geo1.frames[k], geo1.host)), geo1)
  await shot('canvas.png')

  // ===== 2. what waits for the user =====
  const ask = await A.call('task_question', { task: ref, workspace: WA, action: 'ask', text: '登录页用邮箱还是手机号？' })
  const wait2 = await waitFor(async () => { const t = await text(`${card(ALICE)} [data-cv-wait]`); return t ? t : null })
  const totals2 = await text('[data-cv-totals]')
  const c2 = await cards()
  check('2 Alice asks a question on the task: her card gets a 等你 mark, the corner says 等你 1, and a 你 card appears', typeof wait2 === 'string' && wait2.includes('等你 1') && String(totals2).includes('等你 1') && c2.includes('user'), [wait2, totals2, c2, String(ask.raw).slice(0, 300)])
  await desk.ev(`[...document.querySelectorAll('[data-cv-totals] button')].find((b) => b.innerText.includes('等你'))?.click()`)
  const insp2 = await waitFor(async () => { const t = await text('[data-cv-inspector]'); return t && t.includes('Alice') ? t : null })
  const sel2 = await desk.ev(`[...document.querySelectorAll('[data-cv-card][data-selected]')].map((e) => e.dataset.cvCard)`)
  check('2 clicking 等你 in the corner selects that card and the panel on the right shows the question itself', !!insp2 && insp2.includes('有问题等你回答') && insp2.includes('登录页用邮箱还是手机号？') && J(sel2) === J([ALICE]), [insp2, sel2])
  await shot('canvas-waiting.png')
  await desk.ev(`document.querySelector('[data-cv-inspector] [data-cv-attention]')?.click()`)
  const nav2 = await waitFor(async () => ((await section()) === 'overview' ? await desk.ev(`document.querySelector('main')?.innerText ?? ''`) : null))
  check('2 clicking the question opens that task', typeof nav2 === 'string' && nav2.includes(ref) && nav2.includes('登录页用邮箱还是手机号？'), [await section(), String(nav2).slice(0, 200)])
  await clickRail('画布')
  await waitFor(async () => (await desk.ev(`!!document.querySelector('[data-canvas]')`)) === true)
  await sleep(400)

  // ===== 3. pan, zoom, drag; positions and the view are remembered =====
  const esc = () => desk.ev(`(document.querySelector('[data-canvas]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 1)`)
  await esc(); await sleep(200)
  await tool('fit'); await sleep(500)
  const host = await box('[data-canvas]')
  const cam0 = await still(cam)
  // a blank spot: the left edge of the canvas at mid height (the frames were fitted with a margin; the bottom has the toolbar and the map)
  const blank = { x: Math.round(host.x + 14), y: Math.round(host.cy) }
  await dragMouse(blank.x, blank.y, blank.x + 90, blank.y - 60)
  const cam1 = await cam()
  check('3 dragging the empty background moves the view by exactly that much', cam1.x - cam0.x === 90 && cam1.y - cam0.y === -60 && cam1.z === cam0.z, [cam0, cam1])
  const bobBefore = await box(card(BOB))
  await desk.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(bobBefore.cx), y: Math.round(bobBefore.cy), deltaX: 0, deltaY: -240 })
  await sleep(300)
  const cam2 = await cam()
  const bobAfter = await box(card(BOB))
  const under = await desk.ev(`(() => { const e = document.elementFromPoint(${Math.round(bobBefore.cx)}, ${Math.round(bobBefore.cy)}); return e ? [e.tagName, e.closest('[data-cv-card]')?.dataset.cvCard ?? null, !!e.closest('[data-canvas]'), !!e.closest('[data-cv-ui]')] : null })()`)
  check('3 the mouse wheel zooms towards the pointer: bigger, and the spot under the pointer stays put', cam2.z > cam1.z * 1.2 && Math.abs(bobAfter.cx - bobBefore.cx) < 2 && Math.abs(bobAfter.cy - bobBefore.cy) < 2 && bobAfter.w > bobBefore.w * 1.2, [cam1, cam2, bobBefore, bobAfter, under, host])
  const zoomLabel = await text('[data-cv-zoom]')
  check('3 the zoom shows as a percentage in the corner tools', zoomLabel === `${Math.round(cam2.z * 100)}%`, [zoomLabel, cam2])
  await tool('fit'); await sleep(500)
  const cam3 = await still(cam)
  const p0 = await savedPos(CAROL)
  const carol0 = await box(card(CAROL))
  await dragMouse(carol0.cx, carol0.cy, carol0.cx + 60, carol0.cy + 45)
  await sleep(400)
  const p1 = await savedPos(CAROL)
  const carol1b = await box(card(CAROL))
  check('3 dragging a card moves it (by the mouse distance, whatever the zoom) and the new place is saved', p0 && p1 && Math.abs(p1.x - p0.x - 60 / cam3.z) <= 1 && Math.abs(p1.y - p0.y - 45 / cam3.z) <= 1 && Math.abs(carol1b.x - carol0.x - 60) < 2 && Math.abs(carol1b.y - carol0.y - 45) < 2, [p0, p1, cam3, carol0, carol1b])
  const frameAfter = await box('[data-cv-frame="lobby"]')
  check('3 its frame follows the card', carol1b.x >= frameAfter.x && carol1b.y >= frameAfter.y && carol1b.x + carol1b.w <= frameAfter.x + frameAfter.w + 1, [carol1b, frameAfter])
  const headA = await box(`[data-cv-frame-head="${WA}"]`)
  const aliceP0 = await savedPos(ALICE), bobP0 = await savedPos(BOB)
  await dragMouse(headA.x + 200, headA.cy, headA.x + 200, headA.cy - 30)
  await sleep(400)
  const aliceP1 = await savedPos(ALICE), bobP1 = await savedPos(BOB)
  check('3 dragging a frame by its title moves every card in it together', aliceP0 && aliceP1 && Math.abs(aliceP1.y - aliceP0.y + 30 / cam3.z) <= 1 && Math.abs(bobP1.y - bobP0.y + 30 / cam3.z) <= 1 && aliceP1.x === aliceP0.x, [aliceP0, aliceP1, bobP0, bobP1])
  await dragMouse(blank.x, blank.y, blank.x - 40, blank.y - 20)
  const camBefore = await cam()
  await sleep(500)
  await desk.ev(`(location.reload(), 1)`)
  await waitFor(async () => (await desk.ev(`!!document.querySelector('[data-canvas] [data-cv-card]')`).catch(() => false)) === true, 80, 250)
  await sleep(500)
  const camAfter = await still(cam)
  const p2 = await savedPos(CAROL)
  const carol2 = await box(card(CAROL))
  check('3 after reopening the window the canvas is as it was left: same view, same card places', J(camAfter) === J(camBefore) && J(p2) === J(p1) && !!carol2 && (await section()) === 'canvas', [camBefore, camAfter, p1, p2])

  // ===== 4. select, the panel, opening the chat =====
  const bob4 = await box(card(BOB))
  await click(bob4.cx, bob4.cy)
  const insp4 = await waitFor(async () => { const t = await text('[data-cv-inspector]'); return t && t.includes('Bob') ? t : null })
  check('4 one click selects a card and the panel shows its state, its tasks and the lines it is on', !!insp4 && insp4.includes(ref) && insp4.includes('和它说话') && insp4.includes('Alice → Bob'), insp4)
  await esc()
  const gone4 = await waitFor(async () => (await desk.ev(`!document.querySelector('[data-cv-inspector]')`)) === true)
  await desk.ev(`document.querySelector('[data-cv-line-label="task:a-1>a-2"]')?.click()`)
  const insp4b = await waitFor(async () => { const t = await text('[data-cv-inspector]'); return t && t.includes('派给') ? t : null })
  check('4 Esc closes the panel; clicking the label on a line lists the tasks on that line', gone4 === true && !!insp4b && insp4b.includes('Alice') && insp4b.includes('Bob') && insp4b.includes(ref), [gone4, insp4b])
  const bob4b = await box(card(BOB))
  await esc(); await sleep(150)
  await mouse('mouseMoved', bob4b.cx, bob4b.cy)
  await mouse('mousePressed', bob4b.cx, bob4b.cy, { buttons: 1, clickCount: 1 }); await mouse('mouseReleased', bob4b.cx, bob4b.cy, { buttons: 0, clickCount: 1 })
  await sleep(80)
  await mouse('mousePressed', bob4b.cx, bob4b.cy, { buttons: 1, clickCount: 2 }); await mouse('mouseReleased', bob4b.cx, bob4b.cy, { buttons: 0, clickCount: 2 })
  const chat4 = await waitFor(async () => { const v = await desk.ev(`document.getElementById('group-composer')?.value ?? null`); return v !== null ? { v, section: await section(), title: await desk.ev(`document.querySelector('main')?.innerText.slice(0, 200) ?? ''`) } : null })
  check('4 a double click on a card opens its project chat with @它 already typed', chat4 && chat4.section === 'overview' && chat4.v.includes('@Bob') && chat4.title.includes('alpha-proj'), chat4)
  await desk.ev(`(() => { const i = document.getElementById('group-composer'); if (!i) return; const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await clickRail('画布')
  await waitFor(async () => (await desk.ev(`!!document.querySelector('[data-canvas]')`)) === true)
  await sleep(400)

  // ===== 5. the roster in the sidebar, search =====
  const roster = await desk.ev(`[...document.querySelectorAll('[data-cv-roster] [data-cv-roster-row]')].map((r) => [r.dataset.cvRosterRow, r.innerText.replace(/\\s+/g, ' ').trim()])`)
  check('5 the sidebar lists every AI under its project, with its state; the one with a question says 等你', roster.length === 3 && roster[0][0] === ALICE && roster[0][1].includes('等你 1') && roster[2][0] === CAROL && roster[2][1].includes('离线'), roster)
  await desk.ev(`document.querySelector('[data-cv-tool=fit]').click()`); await sleep(500)
  await desk.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(host.x + 40), y: Math.round(host.y + host.h - 40), deltaX: 0, deltaY: -480 })
  await sleep(300)
  await desk.ev(`document.querySelector('[data-cv-roster-row="${CAROL}"]').click()`)
  await sleep(700)
  const carol5 = await still(() => box(card(CAROL)))
  const host5 = await box('[data-canvas]')
  const sel5 = await desk.ev(`[...document.querySelectorAll('[data-cv-card][data-selected]')].map((e) => e.dataset.cvCard)`)
  const panel5 = await box('[data-cv-inspector]')
  // the panel on the right covers part of the canvas: the card lands in the middle of what is left, so the panel never hides it
  const free5 = host5.w >= 760 ? host5.w - 312 : host5.w
  check('5 clicking a name in the sidebar flies the view to that card and selects it; it lands in the middle of the part the panel does not cover', Math.abs(carol5.cx - (host5.x + free5 / 2)) < 3 && Math.abs(carol5.cy - host5.cy) < 3 && J(sel5) === J([CAROL]) && !!panel5 && (host5.w < 760 || carol5.x + carol5.w <= panel5.x), [carol5, host5, panel5, sel5])
  await desk.ev(`(() => { const i = document.querySelector('[data-cv-search]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'bob'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await sleep(300)
  const found5 = await desk.ev(`({ op: Object.fromEntries([...document.querySelectorAll('[data-cv-card]')].map((e) => [e.dataset.cvCard, Number(getComputedStyle(e).opacity)])), rows: [...document.querySelectorAll('[data-cv-roster-row]')].map((r) => r.dataset.cvRosterRow), count: document.querySelector('[data-cv-search]').parentElement.innerText.trim() })`)
  check('5 searching dims every card that does not match and filters the sidebar list', found5.op[BOB] === 1 && found5.op[ALICE] < 0.5 && found5.op[CAROL] < 0.5 && J(found5.rows) === J([BOB]) && found5.count.includes('1 个'), found5)
  await desk.ev(`(() => { const i = document.querySelector('[data-cv-search]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)

  // ===== 6. arrange with undo, hide offline, minimap, the team frame =====
  await esc(); await sleep(150)
  const before6 = await savedPos(CAROL)
  await tool('arrange'); await sleep(700)
  const tidy6 = await still(() => savedPos(CAROL))
  const undoThere = await desk.ev(`!!document.querySelector('[data-cv-tool=undo]')`)
  await tool('undo'); await sleep(600)
  const back6 = await still(() => savedPos(CAROL))
  check('6 一键整理 puts everything back in tidy rows, and 撤销 brings the hand-made layout back', before6 && tidy6 && J(tidy6) !== J(before6) && undoThere === true && J(back6) === J(before6), [before6, tidy6, undoThere, back6])
  const map6 = await desk.ev(`(() => { const m = document.querySelector('[data-cv-map]'); return m ? m.querySelectorAll('div').length : 0 })()`)
  await tool('offline'); await sleep(400)
  const hid6 = { cards: await cards(), totals: await text('[data-cv-totals]'), frames: await desk.ev(`[...document.querySelectorAll('[data-cv-frame]')].map((f) => f.dataset.cvFrame)`) }
  await tool('offline'); await sleep(300)
  check('6 the minimap draws the frames and cards; with 离线 hidden Carol and her frame are not drawn but the corner still counts her', map6 >= 7 && !hid6.cards.includes(CAROL) && hid6.cards.includes(BOB) && !hid6.frames.includes('lobby') && String(hid6.totals).includes('离线 1') && (await cards()).includes(CAROL), [map6, hid6])
  await desk.ev(`window.bridge.setGroupChatLead('ws:${WA}', 'a-1', ['a-2'])`)
  const team6 = await waitFor(async () => { const f = await desk.ev(`(() => { const f = document.querySelector('[data-cv-frame="${WA}"]'); return f ? { kind: f.dataset.kind, head: f.querySelector('[data-cv-frame-head]').textContent.replace(/\\s+/g, ' ').trim(), crown: !!document.querySelector('${card(ALICE)} [title="这个项目的主脑"]') } : null })()`); return f?.kind === 'team' ? f : null })
  check('6 when the project chat has a lead, the frame says 分工明确 and the lead card wears a crown', !!team6 && team6.head.includes('分工明确') && team6.crown === true, team6)
  await tool('fit'); await sleep(600)
  await shot('canvas-team.png')

  // ===== 7. talk from the card, what it changed, put away, a relay line, delivered work =====
  await esc(); await sleep(150)
  const bob7 = await box(card(BOB))
  await click(bob7.cx, bob7.cy); await sleep(400)
  const talk7 = await desk.ev(`(() => { const t = document.querySelector('[data-cv-inspector] [data-cv-talk] textarea'); if (!t) return false; t.focus(); return true })()`)
  await desk.send('Input.insertText', { text: '登录页先做邮箱的' })
  await sleep(150)
  await key('Enter'); await sleep(700)
  const said7 = await desk.ev(`window.bridge.listGroupChat({ channel: 'ws:${WA}', limit: 5 }).then((l) => l.map((m) => [m.from.id, m.text, m.mentions ?? []]))`)
  const mine7 = (said7 ?? []).find((m) => m[0] === 'user')
  check('7 the card panel has a box to talk to that AI: typing and Enter posts in its project chat with @它 in front', talk7 === true && !!mine7 && mine7[1].includes('登录页先做邮箱的') && mine7[1].includes('@Bob') && J(mine7[2]).includes('a-2'), [talk7, said7])
  const panel7 = await text('[data-cv-inspector]')
  check('7 the card panel also says what this AI changed in the project (nothing yet here)', typeof panel7 === 'string' && panel7.includes('它改了什么'), String(panel7).slice(0, 400))
  await shot('canvas-talk.png')

  // put Carol away and bring her back
  await esc(); await sleep(150)
  const carol7 = await box(card(CAROL))
  await click(carol7.cx, carol7.cy); await sleep(300)
  await desk.ev(`document.querySelector('[data-cv-inspector] [data-cv-archive]')?.click()`)
  const away7 = await waitFor(async () => { const c = await cards(); return c.includes(CAROL) ? null : { cards: c, totals: await text('[data-cv-totals]') } })
  await desk.ev(`document.querySelector('[data-cv-shelf-btn]')?.click()`); await sleep(250)
  const shelf7 = await text('[data-cv-shelf]')
  await desk.ev(`document.querySelector('[data-cv-unarchive="a-3"]')?.click()`)
  const back7 = await waitFor(async () => ((await cards()).includes(CAROL) ? true : null))
  check('7 收纳 takes a card off the canvas (the corner keeps counting it and lists it under 收纳); 放回来 brings it back', !!away7 && away7.totals.includes('3 个 AI') && away7.totals.includes('收纳 1') && String(shelf7).includes('Carol') && back7 === true, [away7, shelf7, back7])

  // a relay line Alice -> Bob, stored in the project
  await desk.ev(`window.bridge.canvasUpdate('${WA}', [{ op: 'addRelay', from: 'a-1', to: 'a-2' }])`)
  const relay7 = await waitFor(async () => { const l = await desk.ev(`[...document.querySelectorAll('[data-cv-line-id]')].map((p) => [p.dataset.cvLineId, p.dataset.kind, p.getAttribute('stroke-dasharray')])`); return l.some((x) => x[1] === 'relay') ? l : null })
  await desk.ev(`[...document.querySelectorAll('[data-cv-line-label]')].find((b) => b.dataset.cvLineLabel.startsWith('relay:'))?.click()`); await sleep(300)
  const relayPanel7 = await text('[data-cv-inspector]')
  await desk.ev(`document.querySelector('[data-cv-relay-remove]')?.click()`)
  const gone7 = await waitFor(async () => { const l = await desk.ev(`[...document.querySelectorAll('[data-cv-line-id]')].map((p) => p.dataset.kind)`); return l.includes('relay') ? null : true })
  check('7 a relay line is drawn in its own style, its label opens a panel that says what it does, and it can be deleted there', !!relay7 && String(relayPanel7).includes('做完自动转告') && String(relayPanel7).includes('Alice') && gone7 === true, [relay7, relayPanel7, gone7])

  // Bob makes a task for himself and finishes it: nobody else checks it, so it waits for the user to look
  const own = await B.call('task_create', { workspace: WA, title: '补上忘记密码的入口', assigneeId: 'Bob' })
  await B.call('task_update', { task: own.data?.ref, workspace: WA, status: 'in_progress' })
  const fin = await B.call('task_update', { task: own.data?.ref, workspace: WA, status: 'done', result: '入口加在登录按钮下面了' })
  const deliv7 = await waitFor(async () => { const t = await text('[data-cv-totals]'); return t && t.includes('全部看过（1）') ? t : null }, 60, 250)
  await esc(); await sleep(150)
  const bob7b = await box(card(BOB))
  await click(bob7b.cx, bob7b.cy); await sleep(400)
  const delivPanel7 = await text('[data-cv-inspector]')
  check('7 work that was finished and nobody checked shows up as 做完了，等你看一眼 on the card that did it, with what was delivered', !!deliv7 && String(delivPanel7).includes('做完了，等你看一眼') && String(delivPanel7).includes('入口加在登录按钮下面了'), [deliv7, String(delivPanel7).slice(0, 300), String(fin.text ?? '').slice(0, 200)])
  await shot('canvas-delivered.png')
  await desk.ev(`document.querySelector('[data-cv-inspector] [data-cv-ack]')?.click()`)
  const acked7 = await waitFor(async () => { const t = await text('[data-cv-totals]'); return t && !t.includes('全部看过') ? t : null })
  check('7 看过了 clears it, and it stays cleared', !!acked7 && acked7.includes('等你 1'), acked7)
  // ===== 8. draw a line to hand out work, unclaimed tasks, notes, joining another project's team =====
  await esc(); await sleep(150)
  await tool('fit'); await sleep(600)
  const tasksOf = (ws) => desk.ev(`window.bridge.listTasks('${ws}').then((l) => l.map((t) => ({ ref: t.ref, title: t.title, by: t.createdBy, to: t.assigneeId ?? null, status: t.status, d: t.description })))`)
  const hover = async (sel) => { const b = await box(sel); await mouse('mouseMoved', b.cx, b.cy); await sleep(120); return b }
  await hover(card(ALICE))
  const h8 = await box(`${card(ALICE)} [data-cv-link]`)
  const bob8 = await box(card(BOB))
  await pull(h8.cx, h8.cy, bob8.cx, bob8.cy)
  const dlg8 = await waitFor(() => desk.ev(`(() => { const d = document.querySelector('[data-cv-assign] [data-canvas-part="assign-dialog"]'); if (!d) return null; const i = d.querySelector('input[placeholder^="要它做什么"]'); if (i) i.focus(); return { text: d.textContent.replace(/\\s+/g, ' ').slice(0, 300), input: !!i } })()`), 20, 150)
  await desk.send('Input.insertText', { text: '给登录页配上图标' })
  await sleep(150)
  await key('Enter', 2)
  const made8 = await waitFor(async () => { const l = await tasksOf(WA); return l.find((t) => t.title === '给登录页配上图标') ?? null }, 30, 200)
  const closed8 = await waitFor(async () => ((await desk.ev(`!document.querySelector('[data-cv-assign]')`)) ? true : null), 20, 150)
  check('8 dragging from the dot on the edge of a card to another card opens the 派活 / 接力 dialog; a title and Ctrl+Enter makes a task for that AI', !!dlg8 && dlg8.input === true && dlg8.text.includes('Bob') && !!made8 && made8.to === 'a-2' && closed8 === true, [h8, dlg8, made8, closed8])

  // a task nobody took: it hangs under the project frame and can be dragged onto an AI
  await desk.ev(`window.bridge.createTask({ title: '写说明文档' }, '${WA}')`)
  const chip8 = await waitFor(() => box(`[data-cv-frame="${WA}"] [data-cv-task]`), 30, 200)
  const chipText8 = await text(`[data-cv-frame="${WA}"] [data-cv-open-tasks]`)
  const alice8 = await box(card(ALICE))
  if (chip8) await pull(chip8.cx, chip8.cy, alice8.cx, alice8.cy)
  const dlg8b = await waitFor(() => desk.ev(`document.querySelector('[data-cv-assign] [data-canvas-part="assign-dialog"]')?.textContent.replace(/\\s+/g, ' ').slice(0, 300) ?? null`), 20, 150)
  await desk.ev(`document.querySelector('[data-cv-assign] [data-canvas-part="assign-dialog"]')?.focus?.()`)
  await desk.ev(`(() => { const b = [...document.querySelectorAll('[data-cv-assign] button')].filter((x) => !x.disabled).pop(); if (b) b.click(); return !!b })()`)
  const given8 = await waitFor(async () => { const l = await tasksOf(WA); const t = l.find((x) => x.title === '写说明文档'); return t && t.to === 'a-1' ? t : null }, 30, 200)
  const chips8 = await waitFor(async () => ((await desk.ev(`document.querySelectorAll('[data-cv-task]').length`)) === 0 ? true : null), 20, 150)
  check('8 a task nobody took hangs under its project frame as 没人接; dragging it onto an AI hands it over and it leaves the row', !!chip8 && String(chipText8).includes('写说明文档') && !!dlg8b && !!given8 && chips8 === true, [chip8, chipText8, dlg8b, given8, chips8])

  // notes: one from the user (tool bar), one from an AI next to a card
  await esc(); await sleep(150)
  await tool('note')
  const note8 = await waitFor(() => desk.ev(`(() => { const n = document.querySelectorAll('[data-cv-note]'); return n.length === 1 ? n[0].dataset.cvNote : null })()`), 30, 150)
  await desk.ev(`document.activeElement?.blur?.()`); await sleep(200)
  const nb8 = await box(`[data-cv-note="${note8}"]`)
  await pull(nb8.x + 30, nb8.y + nb8.h - 12, nb8.x + 30 + 90, nb8.y + nb8.h - 12 - 70)
  const nb8b = await box(`[data-cv-note="${note8}"]`)
  const nSaved8 = await savedPos(note8)
  check('8 a note can be dragged like a card and its place is remembered', Math.abs(nb8b.x - nb8.x - 90) < 3 && Math.abs(nb8b.y - nb8.y + 70) < 3 && !!nSaved8, [nb8, nb8b, nSaved8])
  const ai8 = await B.call('canvas_note', { workspace: WA, text: '记得给登录页写测试', near: 'Alice' })
  const notes8 = await waitFor(async () => { const n = await desk.ev(`[...document.querySelectorAll('[data-cv-note]')].map((e) => [e.dataset.cvNote, e.textContent.replace(/\\s+/g, ' ').slice(0, 80)])`); return n.length === 2 ? n : null }, 30, 200)
  const aiNote8 = (notes8 ?? []).find((n) => n[0] !== note8)
  const aiBox8 = aiNote8 ? await box(`[data-cv-note="${aiNote8[0]}"]`) : null
  const alice8b = await box(card(ALICE))
  const frames8 = await desk.ev(`[...document.querySelectorAll('[data-cv-frame]')].map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })`)
  check('8 the note button puts a note on the canvas; a note an AI writes with canvas_note shows up by itself, near the card it names without covering any frame, with who wrote it', !!note8 && !!aiNote8 && aiNote8[1].includes('记得给登录页写测试') && aiNote8[1].includes('Bob') && !!aiBox8 && frames8.every((f) => !overlap(aiBox8, f)) && Math.hypot(aiBox8.cx - alice8b.cx, aiBox8.cy - alice8b.cy) < 900, [note8, notes8, aiBox8, alice8b, frames8, String(ai8.text ?? '').slice(0, 160)])
  await shot('canvas-notes.png')

  // pull a line from Carol (in no project) to the beta-proj frame: she joins that project's team
  await hover(card(CAROL))
  const hc8 = await box(`${card(CAROL)} [data-cv-link]`)
  const fb8 = await box(`[data-cv-frame="${WB}"]`)
  await pull(hc8.cx, hc8.cy, fb8.cx, fb8.y + fb8.h - 14)
  const joined8 = await waitFor(async () => { const c = await cards(); return c.includes(`a-3@${WB}`) ? c : null }, 30, 200)
  const lead8 = await desk.ev(`window.bridge.listGroupChannels().then((l) => { const c = l.find((x) => x.id === 'ws:${WB}'); return c ? { lead: c.leadId ?? null, subs: c.subIds ?? null } : null })`)
  const toast8 = await text('[data-cv-toast]')
  check('8 pulling a line from a card to another project frame adds that AI to the project team (it becomes the lead when there is none), says so, and the card moves into that frame', !!joined8 && lead8?.lead === 'a-3' && String(toast8).includes('Carol') && String(toast8).includes('beta-proj'), [joined8, lead8, toast8])
  await desk.ev(`document.querySelector('[data-cv-team-btn="${WB}"]')?.click()`)
  const menu8 = await waitFor(() => desk.ev(`document.querySelector('[data-cv-team-menu] [data-canvas-part="team-menu"]')?.textContent.replace(/\\s+/g, ' ').slice(0, 300) ?? null`), 20, 150)
  check('8 the little people button on a frame title opens the team menu for that project', typeof menu8 === 'string' && menu8.includes('Carol'), menu8)
  await desk.ev(`document.querySelector('[data-cv-team-btn="${WB}"]')?.click()`)
  await tool('fit'); await sleep(600)
  await shot('canvas-full.png')

  // ---------- 9. board view, new AI, and the three kinds of small windows ----------
  await key('Escape'); await sleep(150)
  await tool('lanes')
  const lanes9 = await waitFor(() => desk.ev(`(() => { const e = document.querySelector('[data-cv-lanes] [data-canvas-part="lanes"]'); if (!e) return null; return { lanes: e.querySelectorAll('[data-lane]').length, cards: [...e.querySelectorAll('[data-lane-card]')].map((c) => c.dataset.laneCard), text: e.textContent.replace(/\\s+/g, ' ').slice(0, 400) } })()`), 20, 150)
  await shot('canvas-lanes.png')
  check('9 the board button swaps the canvas for columns by state, with every AI in one of them and its project named', !!lanes9 && lanes9.lanes >= 2 && [ALICE, BOB].every((k) => lanes9.cards.includes(k)) && lanes9.cards.some((k) => k.startsWith('a-3@')) && lanes9.text.includes('alpha-proj'), lanes9)
  await desk.ev(`document.querySelector('[data-lane-card="${BOB}"]')?.click()`)
  const back9 = await waitFor(() => desk.ev(`!document.querySelector('[data-cv-lanes]') && document.querySelector('[data-cv-detail]')?.textContent.includes('Bob')`), 20, 150)
  check('9 picking an AI on the board goes back to the canvas with that card open', back9 === true, back9)
  await key('Escape'); await sleep(150)

  await tool('new-agent')
  const dlg9 = await waitFor(() => text('[data-cv-new-agent] [data-canvas-part="new-agent"]'), 20, 150)
  await shot('canvas-new-agent.png')
  check('9 the new AI button opens the create dialog on the canvas', typeof dlg9 === 'string' && dlg9.length > 20, dlg9)
  await desk.ev(`document.querySelector('[data-cv-new-agent] button[aria-label="关掉"]')?.click()`)
  await sleep(200)

  const widgets9 = () => desk.ev(`window.bridge.canvasAll().then((d) => (d.all?.widgets ?? []).map((w) => ({ id: w.id, kind: w.kind, path: w.path ?? null, url: w.url ?? null, title: w.title ?? null, termId: w.termId ?? null, node: d.all.nodes[w.id] ?? null })))`)
  const addWidget9 = async (kind, value) => {
    await tool('widget'); await sleep(200)
    await desk.ev(`document.querySelector('[data-cv-widget-kind="${kind}"]')?.click()`)
    await sleep(120)
    await desk.ev(`(() => { const s = document.querySelector('[data-cv-add-widget] select'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, ${J(WA)}); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    if (value) { await desk.ev(`document.querySelector('[data-cv-add-widget] input')?.focus()`); await desk.send('Input.insertText', { text: value }) }
    await sleep(120)
    await desk.ev(`document.querySelector('[data-cv-widget-add]')?.click()`)
    const made = await waitFor(async () => (await widgets9()).find((w) => w.kind === kind && w.node) ?? null, 30, 200)
    await sleep(800) // the view glides over to the new window
    return made
  }
  const wsel = (id) => `[data-cv-note="${id}"]`

  // a file
  const wf9 = await addWidget9('file', 'keep.txt')
  const fileText9 = wf9 && await waitFor(() => desk.ev(`document.querySelector('${wf9 ? wsel(wf9.id) : 'x'} textarea')?.value ?? null`), 20, 200)
  check('9 a file window shows what is in the file, in the project it was asked for', !!wf9 && wf9.path === 'keep.txt' && typeof fileText9 === 'string' && fileText9.includes('line one'), [wf9, fileText9])
  // drag it by the title bar, then pull its corner
  const wb9 = await box(wsel(wf9.id))
  await pull(wb9.x + wb9.w / 2, wb9.y + 8, wb9.x + wb9.w / 2 + 90, wb9.y + 8 - 50)
  const wb9b = await box(wsel(wf9.id))
  const wpos9 = await savedPos(wf9.id)
  check('9 a small window is dragged by its title bar and the place is remembered', Math.abs(wb9b.x - wb9.x - 90) < 6 && Math.abs(wb9b.y - wb9.y + 50) < 6 && !!wpos9 && Math.abs(wpos9.x - wf9.node.x) > 20, [wb9, wb9b, wpos9, wf9.node])
  await pull(wb9b.x + wb9b.w - 4, wb9b.y + wb9b.h - 4, wb9b.x + wb9b.w - 4 + 60, wb9b.y + wb9b.h - 4 + 40)
  const wb9c = await box(wsel(wf9.id))
  await sleep(500)
  const wsize9 = (await widgets9()).find((w) => w.id === wf9.id)?.node
  check('9 pulling the corner of a small window changes its size, and the size is remembered', wb9c.w > wb9b.w + 20 && wb9c.h > wb9b.h + 15 && Math.abs(wb9c.x - wb9b.x) < 2 && !!wsize9?.w && !!wsize9?.h, [wb9b, wb9c, wsize9])
  // typing in it does not trigger canvas shortcuts or move the camera
  const camT9 = await cam()
  await desk.ev(`document.querySelector('${wsel(wf9.id)} textarea')?.focus()`)
  await desk.send('Input.insertText', { text: 'f ' })
  await key('f'); await sleep(300)
  const camT9b = await cam()
  check('9 typing inside a small window stays in it (no canvas shortcut fires)', J(camT9) === J(camT9b), [camT9, camT9b])

  // a terminal
  const wt9 = await addWidget9('terminal', '')
  await sleep(400)
  await desk.ev(`[...document.querySelectorAll('${wt9 ? wsel(wt9.id) : 'x'} button')].find((b) => b.textContent.includes('开一个终端'))?.click()`)
  const term9 = wt9 && await waitFor(async () => { const w = (await widgets9()).find((x) => x.id === wt9.id); const dom = await desk.ev(`!!document.querySelector('${wsel(wt9.id)} .xterm')`); return w?.termId && dom ? w : null }, 40, 250)
  check('9 a terminal window opens a real terminal in that project and remembers which one', !!term9, [wt9, term9, wt9 && await text(wsel(wt9.id))])

  // a web page: it has to really load, and a click has to land where it is aimed at other zoom levels too
  const page9 = `<!doctype html><title>cv-web-ok</title><body style="margin:0;background:#fff;font:20px sans-serif"><div style="padding:12px">cv web page</div><script>addEventListener('click', (e) => { document.title = 'c:' + Math.round(e.clientX / innerWidth * 100) + ':' + Math.round(e.clientY / innerHeight * 100) })</script>`
  const srv9 = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(page9) })
  await new Promise((r) => srv9.listen(0, '127.0.0.1', r))
  const ww9 = await addWidget9('web', `127.0.0.1:${srv9.address().port}/`)
  const title9 = () => widgets9().then((l) => l.find((w) => w.id === ww9?.id)?.title ?? null)
  const loaded9 = ww9 && await waitFor(async () => (await title9()) === 'cv-web-ok', 50, 250)
  await tool('fit'); await sleep(700)
  await shot('canvas-widgets.png')
  const map9 = await desk.ev(`({ notes: document.querySelectorAll('[data-cv-map] [data-cv-map-note]').length, widgets: document.querySelectorAll('[data-cv-map] [data-cv-map-widget]').length })`)
  check('9 the small map also shows notes and small windows', map9.notes >= 2 && map9.widgets === 3, map9)
  check('9 a web window really loads the page (its title comes back)', loaded9 === true, [ww9, await title9()])
  const aim9 = async (label) => {
    // the page area is everything under the two bars of the window; aim at 25% / 60% of the web view itself
    // bring the whole window into the clear part of the canvas first (drag it by its title bar)
    const hostB = await box('[data-canvas]')
    const wB = await box(`${wsel(ww9.id)} [data-canvas-part="widget"]`)
    const grab = { x: Math.min(Math.max(wB.x + wB.w / 2, hostB.x + 40), hostB.x + hostB.w - 80), y: wB.y + 10 * (await cam()).z }
    await pull(grab.x, grab.y, grab.x + (hostB.x + 30 - wB.x), grab.y + (hostB.y + 60 - wB.y))
    await sleep(300)
    const r = await desk.ev(`(() => { const e = document.querySelector('${wsel(ww9.id)} webview'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height } })()`)
    if (!r) return { label, r }
    await click(r.x + r.w * 0.25, r.y + r.h * 0.6)
    const t = await waitFor(async () => { const v = await title9(); return v && v.startsWith('c:') ? v : null }, 20, 200)
    const z = (await cam()).z
    // reset the title for the next round
    await desk.ev(`document.querySelector('${wsel(ww9.id)} webview')?.executeJavaScript("document.title = 'cv-web-ok'")`)
    await waitFor(async () => (await title9()) === 'cv-web-ok', 20, 200)
    const m = /^c:(\d+):(\d+)$/.exec(t ?? '')
    return { label, z, t, r, ok: !!m && Math.abs(+m[1] - 25) <= 4 && Math.abs(+m[2] - 60) <= 4 }
  }
  const zoomTo9 = async (want) => {
    for (let i = 0; i < 12; i++) {
      const z = (await cam()).z
      if (Math.abs(z - want) < 0.02) break
      const hb = await box(`${wsel(ww9.id)} [data-canvas-part="widget"]`)
      await desk.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(hb.x + hb.w / 2), y: Math.round(hb.y + 10), deltaX: 0, deltaY: z < want ? -60 : 60, modifiers: 2 })
      await sleep(260)
    }
    return (await cam()).z
  }
  const aims9 = []
  if (loaded9) {
    await zoomTo9(1); aims9.push(await aim9('100%'))
    await zoomTo9(1.25); aims9.push(await aim9('125%')); await shot('canvas-web-125.png')
    await zoomTo9(0.75); aims9.push(await aim9('75%')); await shot('canvas-web-75.png')
  }
  check('9 a click inside the web window lands where it is aimed, also at 125% and 75% zoom', aims9.length === 3 && aims9.every((a) => a.ok), aims9)
  srv9.close()

  // taking a window off the canvas
  await desk.ev(`document.querySelector('${wsel(wf9.id)} button[aria-label="关掉"]')?.click()`)
  await sleep(150)
  await desk.ev(`[...document.querySelectorAll('${wsel(wf9.id)} button')].find((b) => b.textContent.includes('确认'))?.click()`)
  const gone9 = await waitFor(async () => !(await widgets9()).some((w) => w.id === wf9.id) && !(await box(wsel(wf9.id))), 20, 200)
  check('9 a small window can be taken off the canvas (asks once first)', gone9 === true, await widgets9())
  await tool('fit'); await sleep(500)

  // ---------- 10. what kind of AI, answering on the card, dragging a card into a frame ----------
  await key('Escape'); await sleep(150)
  await tool('fit'); await sleep(600)
  const kind10 = await desk.ev(`(() => { const e = document.querySelector('${card(ALICE)} [data-cv-kind]'); return e ? { kind: e.dataset.cvKind, text: e.textContent.trim(), title: e.title } : null })()`)
  check('10 a card says what kind of AI is behind it (for an outside AI: the client it connects with)', !!kind10 && kind10.kind === 'external' && kind10.text.length > 2 && kind10.title.length > 4, kind10)
  // answer Alice's open question right in the card panel
  const a10 = await box(card(ALICE))
  await click(a10.cx, a10.cy)
  const ans10 = await waitFor(() => box('[data-cv-detail] [data-cv-answer] textarea'), 20, 150)
  await desk.ev(`document.querySelector('[data-cv-detail] [data-cv-answer] textarea')?.focus()`)
  await desk.send('Input.insertText', { text: '用邮箱登录' })
  await sleep(150)
  await desk.ev(`document.querySelector('[data-cv-detail] [data-cv-answer-send]')?.click()`)
  const answered10 = await waitFor(() => desk.ev(`window.bridge.listTasks(${J(WA)}).then((l) => { const q = (l.find((t) => t.ref === 'T-1')?.questions ?? []).find((x) => (x.answer ?? '').includes('用邮箱登录')); return q ? { status: q.status, answer: q.answer } : null })`), 25, 200)
  const left10 = await waitFor(() => desk.ev(`!document.querySelector('[data-cv-detail] [data-cv-attention="question"]')`), 20, 200)
  check('10 a question an AI is waiting on can be answered right in the card panel; the answer reaches the task and the card stops waiting', !!ans10 && !!answered10 && left10 === true, [ans10, answered10, left10])
  await key('Escape'); await sleep(200)
  // drag Bob's card itself into the beta-proj frame
  await tool('fit'); await sleep(600)
  const b10 = await box(card(BOB))
  const f10 = await box(`[data-cv-frame="${WB}"]`)
  // press, move over the other frame, look (the frame lights up and stays where it was), then let go
  await mouse('mouseMoved', b10.cx, b10.cy); await sleep(60)
  await mouse('mousePressed', b10.cx, b10.cy, { buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', b10.cx + ((f10.cx - b10.cx) * i) / 6, b10.cy + ((f10.y + f10.h - 6 - b10.cy) * i) / 6, { buttons: 1 }); await sleep(40) }
  const lit10 = await desk.ev(`(() => { const e = document.querySelector('[data-cv-frame="${WB}"]'); const r = e.getBoundingClientRect(); return { lit: e.hasAttribute('data-cv-drop'), x: r.left, y: r.top } })()`)
  await mouse('mouseReleased', f10.cx, f10.y + f10.h - 6, { buttons: 0, clickCount: 1 })
  const toast10 = await waitFor(() => text('[data-cv-toast]'), 15, 100)
  const team10 = await waitFor(() => desk.ev(`window.bridge.listGroupChannels().then((l) => { const c = l.find((x) => x.id === 'ws:${WB}'); return c && (c.subIds ?? []).includes('a-2') ? { lead: c.leadId ?? null, subs: c.subIds } : null })`), 8, 200)
  check('10 dragging an AI card into another project frame lights that frame up without it moving away; letting go adds the AI to that project team (or says it is in it already)', lit10.lit === true && Math.abs(lit10.x - f10.x) < 2 && Math.abs(lit10.y - f10.y) < 2 && typeof toast10 === 'string' && (toast10.includes('已经在团队里') || (!!team10 && toast10.includes('Bob'))), [lit10, team10, toast10, b10, f10, await box(card(BOB)), await cards()])
  // a file dragged in from the computer: onto an AI it fills in a sentence for that AI, onto empty canvas it becomes a file window
  await key('Escape'); await sleep(200)
  await tool('fit'); await sleep(600)
  const dropFile = async (x, y) => {
    const data = { items: [], files: [path.join(wsA, 'keep.txt')], dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop']) { await desk.send('Input.dispatchDragEvent', { type, x: Math.round(x), y: Math.round(y), data }); await sleep(80) }
  }
  const a11 = await box(card(ALICE))
  await dropFile(a11.cx, a11.cy)
  const filled11 = await waitFor(() => desk.ev(`(() => { const d = document.querySelector('[data-cv-detail]'); const t = d?.querySelector('[data-cv-talk] textarea'); return d && t && t.value.includes('keep.txt') ? { who: d.textContent.includes('Alice'), value: t.value, section: localStorage.getItem('wb.nav.section') } : null })()`), 20, 150)
  check('10 a file dragged from the computer onto an AI card opens that card and fills in a sentence naming the file (nothing is sent, the canvas stays)', !!filled11 && filled11.who === true && filled11.section === 'canvas', [filled11, await text('[data-cv-toast]')])
  await key('Escape'); await sleep(200)
  const before11 = (await widgets9()).length
  const host11 = await box('[data-canvas]')
  await dropFile(host11.x + 16, host11.cy)
  const made11 = await waitFor(async () => { const l = await widgets9(); return l.length > before11 ? l.find((w) => w.kind === 'file' && w.path === 'keep.txt') ?? null : null }, 20, 200)
  check('10 a file dragged onto empty canvas becomes a file window in the project whose folder it is in', !!made11, [made11, await text('[data-cv-toast]')])
  await sleep(700)
  // leaving the canvas page and coming back: small windows keep what is in them (the page is hidden, not thrown away)
  await key('Escape'); await sleep(200)
  const fw12 = (await widgets9()).find((w) => w.kind === 'file')
  const ww12 = (await widgets9()).find((w) => w.kind === 'web')
  await desk.ev(`(() => { const t = document.querySelector('${wsel(fw12.id)} textarea'); t.focus() })()`)
  await desk.send('Input.insertText', { text: 'unsaved words ' })
  await desk.ev(`document.querySelector('${wsel(ww12.id)} webview')?.executeJavaScript("window.__kept = 'still here'")`)
  await sleep(200)
  await clickRail('任务'); await sleep(700)
  const away12 = await desk.ev(`({ section: localStorage.getItem('wb.nav.section'), shown: (() => { const e = document.querySelector('[data-canvas-keep]'); return e ? getComputedStyle(e).visibility : null })() })`)
  await clickRail('画布'); await sleep(700)
  const kept12 = await desk.ev(`(async () => ({ text: document.querySelector('${wsel(fw12.id)} textarea')?.value ?? null, web: await document.querySelector('${wsel(ww12.id)} webview')?.executeJavaScript('window.__kept').catch((e) => String(e)), shown: getComputedStyle(document.querySelector('[data-canvas-keep]')).visibility }))()`)
  check('10 going to another page and back keeps the canvas as it was: unsaved words in a file window and the loaded web page are still there', away12.section === 'tasks' && away12.shown === 'hidden' && kept12.shown === 'visible' && (kept12.text ?? '').includes('unsaved words') && kept12.web === 'still here', [away12, kept12])
  await shot('canvas-end.png')

  // ---------- 11. the right mouse button: a menu for what is under the pointer ----------
  // the cursor may still sit in a text box of a panel or a small window (they keep Escape to themselves): give the keyboard back to the canvas first
  // an open menu has the keyboard: the first Escape closes it; then the keyboard goes back to the canvas and the second Escape clears the selection
  const calm = async () => { if (await desk.ev(`!!document.querySelector('[role=menu]')`)) { await key('Escape'); await sleep(150) } await desk.ev(`(document.activeElement?.blur?.(), document.querySelector('[data-canvas]')?.focus({ preventScroll: true }), 1)`); await key('Escape'); await sleep(250) }
  await calm()
  await tool('fit'); await sleep(700)
  const rclick = async (x, y) => { await mouse('mouseMoved', x, y); await sleep(40); await mouse('mousePressed', x, y, { button: 'right', buttons: 2, clickCount: 1 }); await mouse('mouseReleased', x, y, { button: 'right', buttons: 0, clickCount: 1 }); await sleep(300) }
  const menu = () => desk.ev(`(() => { const m = document.querySelector('[role=menu]'); return m ? [...m.querySelectorAll('[role=menuitem]')].map((e) => e.textContent.trim()) : null })()`)
  const pick = async (label) => { const ok = await desk.ev(`(() => { const it = [...document.querySelectorAll('[role=menu] [role=menuitem]')].find((e) => e.textContent.includes(${J(label)})); if (!it) return false; it.click(); return true })()`); await sleep(250); return ok }
  const has = (m, ...labels) => Array.isArray(m) && labels.every((l) => m.some((x) => x.includes(l)))
  const noteIds = () => desk.ev(`[...document.querySelectorAll('[data-cv-note]:not([data-cv-widget])')].map((e) => e.dataset.cvNote)`)
  // a card
  const a13 = await box(card(ALICE))
  await rclick(a13.cx, a13.cy)
  const m13 = await menu()
  await shot('canvas-menu-card.png')
  const quiet13 = await desk.ev(`({ panel: !!document.querySelector('[data-cv-inspector]'), selected: document.querySelectorAll('[data-cv-card][data-selected]').length })`)
  const a13b = await box(card(ALICE))
  check('11 right-click on an AI card opens its menu (talk, hand out work, note, settings, put away, stop); nothing is selected or moved by the click itself', has(m13, '和它说话', '派一件活给它', '在它旁边贴便签', '收纳', '叫停') && quiet13.panel === false && quiet13.selected === 0 && Math.abs(a13b.x - a13.x) < 1 && Math.abs(a13b.y - a13.y) < 1, [m13, quiet13, a13, a13b])
  await pick('和它说话')
  const talk13 = await waitFor(() => desk.ev(`(() => { const d = document.querySelector('[data-cv-detail=card]'); const t = d?.querySelector('[data-cv-talk] textarea'); return d && t ? { who: d.textContent.includes('Alice'), focused: document.activeElement === t, menu: !!document.querySelector('[role=menu]') } : null })()`), 20, 150)
  check('11 "talk to it" from the menu opens that card panel with the cursor in its text box; the menu is gone', !!talk13 && talk13.who === true && talk13.focused === true && talk13.menu === false, talk13)
  // inside the panel the canvas menu stays away
  const insp13 = await box('[data-cv-inspector]')
  await rclick(insp13.cx, insp13.y + 14)
  const none13 = await menu()
  check('11 right-click inside the card panel does not open the canvas menu', none13 === null, none13)
  await calm()
  // empty canvas: a note exactly there
  const host13 = await box('[data-canvas]')
  const spot13 = await desk.ev(`(() => { const h = document.querySelector('[data-canvas]'); const r = h.getBoundingClientRect(); for (const fx of [0.03, 0.05, 0.08, 0.5, 0.92]) for (const fy of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2]) { const x = Math.round(r.left + r.width * fx), y = Math.round(r.top + r.height * fy); if (document.elementFromPoint(x, y) === h) return { x, y } } return null })()`)
  const before13 = await noteIds()
  await rclick(spot13.x, spot13.y)
  const m13b = await menu()
  await shot('canvas-menu-blank.png')
  await pick('在这里贴便签')
  const new13 = await waitFor(async () => { const l = await noteIds(); return l.find((id) => !before13.includes(id)) ?? null }, 25, 150)
  await sleep(500)
  const nb13 = new13 ? await box(`[data-cv-note="${new13}"]`) : null
  check('11 right-click on empty canvas offers a note, a small window, a new AI, fit and arrange; "note here" puts the note where the pointer was', has(m13b, '在这里贴便签', '在这里开小窗', '新建一个 AI', '全部放进屏幕', '一键整理') && !!nb13 && Math.abs(nb13.cx - spot13.x) < 14 && Math.abs(nb13.cy - spot13.y) < 14, [m13b, spot13, nb13, host13])
  // the note: delete asks once more
  await calm()
  await desk.ev(`document.activeElement?.blur?.()`)
  const nb13b = await box(`[data-cv-note="${new13}"]`)
  await rclick(nb13b.cx, nb13b.y + nb13b.h - 4)
  const m13c = await menu()
  await pick('删掉这张便签')
  const ask13 = await menu()
  const still13 = (await noteIds()).includes(new13)
  await pick('再点一次')
  const gone13 = await waitFor(async () => !(await noteIds()).includes(new13), 20, 150)
  check('11 right-click on a note offers edit and delete; delete asks once more in the menu before the note goes', has(m13c, '改字', '删掉这张便签') && has(ask13, '再点一次') && still13 === true && gone13 === true, [m13c, ask13, still13, gone13])
  // a small window: its title bar has the menu, its inside keeps the mouse for itself
  const fw13 = (await widgets9()).find((w) => w.kind === 'file')
  const wb13 = await box(wsel(fw13.id))
  const head13 = await desk.ev(`(() => { const e = document.querySelector('${wsel(fw13.id)}'); const r = e.getBoundingClientRect(); for (const dx of [0.3, 0.2, 0.4, 0.12]) { const x = Math.round(r.left + r.width * dx), y = Math.round(r.top + Math.max(3, Math.min(8, r.height * 0.03))); const t = document.elementFromPoint(x, y); if (t && e.contains(t) && !t.closest('[data-cv-nodrag]')) return { x, y } } return null })()`)
  await rclick(head13.x, head13.y)
  const m13d = await menu()
  await pick('把它放进屏幕')
  await sleep(700)
  const wb13b = await box(wsel(fw13.id))
  const ta13 = await box(`${wsel(fw13.id)} textarea`)
  await rclick(ta13.cx, ta13.cy)
  const none13b = await menu()
  check('11 right-click on the title bar of a small window offers show, open in the editor and close; "show" brings it up large; right-click inside the window is left to the window', has(m13d, '把它放进屏幕', '在编辑器里打开', '关掉这个小窗') && wb13b.w > wb13.w + 20 && none13b === null, [m13d, wb13, wb13b, none13b, head13])
  // a frame title: select everything in it
  await calm()
  await tool('fit'); await sleep(700)
  const fh13 = await box(`[data-cv-frame-head="${WA}"]`)
  await rclick(fh13.x + 24, fh13.cy)
  const m13e = await menu()
  await pick('选中里面所有 AI')
  const sel13 = await waitFor(() => desk.ev(`(() => { const n = document.querySelectorAll('[data-cv-frame="${WA}"] ~ [data-cv-card][data-selected], [data-cv-card][data-selected]').length; return document.querySelector('[data-cv-detail=many]') && n >= 2 ? n : null })()`), 20, 150)
  check('11 right-click on a project frame title offers show, select all, tidy, team and chat; "select all" selects its cards', has(m13e, '放进屏幕', '选中里面所有 AI', '排整齐', '分工', '群聊') && !!sel13, [m13e, sel13])
  await calm()
  // the note button no longer drops the note on top of a frame
  const before13f = await noteIds()
  await tool('note')
  const new13f = await waitFor(async () => { const l = await noteIds(); return l.find((id) => !before13f.includes(id)) ?? null }, 25, 150)
  await sleep(500)
  await calm()
  const nb13f = new13f ? await box(`[data-cv-note="${new13f}"]`) : null
  const frames13 = await desk.ev(`[...document.querySelectorAll('[data-cv-frame]')].map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })`)
  check('11 a note from the note button (nothing selected) lands on free canvas, not on top of a project frame', !!nb13f && frames13.every((f) => !overlap(nb13f, f)), [nb13f, frames13])
  // the keyboard: the menu key (or Shift+F10) on the canvas, no pointer position
  const kbMenu = () => desk.ev(`(() => { const h = document.querySelector('[data-canvas]'); h.focus({ preventScroll: true }); h.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0, button: 2 })); return 1 })()`)
  const menuBox = () => box('[role=menu]')
  await tool('fit'); await sleep(700)
  await kbMenu(); await sleep(300)
  const m13k = await menu()
  await calm()
  const a13k = await box(card(ALICE))
  await click(a13k.cx, a13k.cy)
  await sleep(400)
  const one13k = await desk.ev(`document.querySelectorAll('[data-cv-card][data-selected]').length`)
  await kbMenu(); await sleep(300)
  const m13k2 = await menu()
  const mb13k = await menuBox()
  const a13k2 = await box(card(ALICE))
  check('11 the menu key on the canvas: nothing selected gives the empty-canvas menu, one selected card gives that card menu, opened on the card', has(m13k, '在这里贴便签', '全部放进屏幕') && one13k === 1 && has(m13k2, '和它说话', '叫停') && !!mb13k && Math.abs(mb13k.x - a13k2.cx) < 40 && Math.abs(mb13k.y - a13k2.cy) < 40, [m13k, one13k, m13k2, mb13k, a13k2])
  await calm(); await calm()
  // "a small window here" opens the little form
  await tool('fit'); await sleep(700)
  const spot13w = await desk.ev(`(() => { const h = document.querySelector('[data-canvas]'); const r = h.getBoundingClientRect(); for (const fx of [0.03, 0.05, 0.08, 0.5, 0.92]) for (const fy of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2]) { const x = Math.round(r.left + r.width * fx), y = Math.round(r.top + r.height * fy); if (document.elementFromPoint(x, y) === h) return { x, y } } return null })()`)
  await rclick(spot13w.x, spot13w.y)
  await pick('在这里开小窗')
  const form13 = await waitFor(() => desk.ev(`!!document.querySelector('[data-cv-add-widget]')`), 15, 150)
  check('11 "a small window here" from the empty-canvas menu opens the small-window form', form13 === true, form13)
  await desk.ev(`(() => { const b = document.querySelector('[data-cv-tool=widget]'); if (document.querySelector('[data-cv-add-widget]') && b) b.click(); return 1 })()`)
  await calm()
  // stop: greyed for an AI that is not connected; for a connected one it asks once more, then that AI is offline
  await tool('fit'); await sleep(700)
  // Carol was never connected; by now she may sit in another frame, so find her card by name
  const c13 = await desk.ev(`(() => { const e = [...document.querySelectorAll('[data-cv-card]')].find((x) => x.textContent.includes('Carol')); if (!e) return null; const r = e.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 } })()`)
  await rclick(c13.cx, c13.cy)
  const stopOff13 = await desk.ev(`(() => { const it = [...document.querySelectorAll('[role=menu] [role=menuitem]')].find((e) => e.textContent.includes('叫停')); return it ? { off: it.getAttribute('aria-disabled') === 'true', why: it.getAttribute('title') } : null })()`)
  const focus13 = await desk.ev(`(() => { const a = document.activeElement; const m = document.querySelector('[role=menu]'); return { tag: a?.tagName, role: a?.getAttribute('role'), canvas: a?.hasAttribute('data-canvas'), vis: m ? getComputedStyle(m).visibility : null } })()`)
  // Escape, typed while the menu has the keyboard, closes it
  await key('Escape'); await sleep(250)
  const closed13 = await menu()
  await calm()
  const b13 = await box(card(BOB))
  const bobWas13 = await text(card(BOB))
  await rclick(b13.cx, b13.cy)
  await pick('叫停')
  const ask13s = await menu()
  const bobStill13 = await text(card(BOB))
  await pick('再点一次')
  const bobOff13 = await waitFor(async () => { const t = await text(card(BOB)); return t && t.includes('离线') ? t : null }, 40, 250)
  const alice13s = await text(card(ALICE))
  check('11 "stop" is greyed with a reason for an AI that is not connected; the open menu has the keyboard and Escape closes it; for a connected one it asks once more, then only that AI goes offline', !!stopOff13 && stopOff13.off === true && !!stopOff13.why && focus13.role === 'menu' && closed13 === null && !bobWas13.includes('离线') && has(ask13s, '再点一次') && !bobStill13.includes('离线') && !!bobOff13 && !alice13s.includes('离线'), [stopOff13, focus13, closed13, bobWas13, ask13s, bobOff13, alice13s])

  // ---------- 12. three old faults and review in the panel ----------
  // the notice ("stopped Bob") sits at the bottom between the minimap and the panel: not on a frame title, not on the panel
  const rects = (sel) => desk.ev(`[...document.querySelectorAll(${J(sel)})].map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })`)
  const toast14 = await waitFor(() => box('[data-cv-toast]'), 10, 100)
  const heads14 = await rects('[data-cv-frame-head]')
  const map14 = await box('[data-cv-map]'), tools14 = await box('[data-cv-tools]')
  const a14 = await box(card(ALICE))
  await click(a14.cx, a14.cy); await sleep(350)
  const toast14b = await box('[data-cv-toast]')
  const insp14 = await box('[data-cv-inspector]')
  check('12 a notice does not cover a project frame title, the minimap, the toolbar or the card panel', !!toast14 && !!toast14b && !!insp14 && heads14.length > 0 && heads14.every((h) => !overlap(toast14, h)) && !overlap(toast14, map14) && !overlap(toast14, tools14) && !overlap(toast14b, insp14) && !overlap(toast14b, map14), [toast14, toast14b, insp14, map14, tools14, heads14])
  await calm()
  // "fit everything": nothing ends up under the minimap, the toolbar or the row of totals
  await tool('fit'); await sleep(800)
  const things14 = await rects('[data-cv-card], [data-cv-frame], [data-cv-note]')
  const bars14 = [await box('[data-cv-map]'), await box('[data-cv-tools]'), await box('[data-cv-totals]')]
  const under14 = things14.filter((t) => bars14.some((b) => b && overlap(t, b)))
  check('12 "fit everything" keeps cards, frames, notes and small windows clear of the minimap, the toolbar and the totals', things14.length >= 6 && bars14.every(Boolean) && under14.length === 0, [under14, bars14, things14.length])
  await shot('canvas-fit-clear.png')
  // the board view: every column is inside the window, nothing to scroll sideways
  await tool('lanes')
  const lanes14 = await waitFor(() => desk.ev(`(() => { const e = document.querySelector('[data-cv-lanes] [data-canvas-part="lanes"]'); if (!e) return null; const r = e.getBoundingClientRect(); const cols = [...e.querySelectorAll('[data-lane]')].map((c) => c.getBoundingClientRect()); return cols.length ? { n: cols.length, right: Math.max(...cols.map((c) => c.right)), edge: r.right, scroll: e.scrollWidth, client: e.clientWidth, widths: cols.map((c) => Math.round(c.width)) } : null })()`), 20, 150)
  check('12 the board view shows all its columns inside the window (no column cut off at the right edge)', !!lanes14 && lanes14.n >= 3 && lanes14.right <= lanes14.edge + 1 && lanes14.scroll <= lanes14.client + 1, lanes14)
  await shot('canvas-lanes-fit.png')
  await tool('lanes'); await sleep(300)
  // work handed in: the user's own task is done the moment the AI hands it in, so the card says "done, have a look".
  // Right in the card panel the user can send it back with a sentence (the AI is told in the project chat) or tick it off
  const mine14 = await desk.ev(`window.bridge.createTask({ title: '写发布说明', assigneeId: 'a-1' }, '${WA}').then((t) => ({ ref: t.ref, id: t.id }))`)
  const statusOf14 = async () => (await A.call('task_get', { task: mine14.ref, workspace: WA })).data
  await A.call('task_update', { task: mine14.ref, workspace: WA, status: 'in_progress' })
  await A.call('task_update', { task: mine14.ref, workspace: WA, status: 'review', result: '发布说明写好了' })
  await calm(); await tool('fit'); await sleep(700)
  const a14b = await box(card(ALICE))
  await click(a14b.cx, a14b.cy); await sleep(400)
  const rsel = `[data-cv-detail] [data-cv-review="${mine14.ref}"]`
  const q14 = (sub) => J(`${rsel} ${sub}`)
  const rev14 = await waitFor(() => desk.ev(`document.querySelector(${J(rsel)})?.dataset.kind ?? null`), 30, 200)
  await desk.ev(`document.querySelector(${q14('[data-cv-review-open]')})?.click()`); await sleep(300)
  await desk.ev(`document.querySelector(${q14('[data-cv-review-reject]')})?.click()`); await sleep(400)
  const need14 = await text(rsel)
  const still14 = (await statusOf14())?.status
  await desk.ev(`document.querySelector(${q14('textarea')})?.focus()`)
  await desk.send('Input.insertText', { text: '少了回滚步骤' })
  await desk.ev(`document.querySelector(${q14('[data-cv-review-reject]')})?.click()`)
  const back14 = await waitFor(async () => { const t = await statusOf14(); return t && t.status === 'in_progress' ? t : null }, 30, 200)
  const gone14 = await waitFor(async () => !(await box(rsel)), 20, 150)
  const told14 = await waitFor(async () => { const r = JSON.stringify(await A.call('chat_read', { channel: `ws:${WA}` })); return r.includes('少了回滚步骤') && r.includes(mine14.ref) ? true : null }, 20, 200)
  // handed in again: tick it off
  await A.call('task_update', { task: mine14.ref, workspace: WA, status: 'review', result: '补上了回滚步骤' })
  const rev14b = await waitFor(() => box(rsel), 30, 200)
  await desk.ev(`document.querySelector(${q14('[data-cv-ack]')})?.click()`)
  const acked14 = await waitFor(async () => !(await box(rsel)), 20, 150)
  const end14 = (await statusOf14())?.status
  check('12 work an AI handed in can be sent back with a sentence right in the card panel (the task goes back to in progress and the AI is told in the project chat), or ticked off', rev14 === 'delivered' && String(need14).includes('退回要写一句') && still14 === 'done' && !!back14 && JSON.stringify(back14).includes('少了回滚步骤') && gone14 === true && told14 === true && !!rev14b && acked14 === true && end14 === 'done', [rev14, need14, still14, back14?.status, gone14, told14, rev14b, acked14, end14])
  // a task the user put into "review" by hand: accept in the panel
  await desk.ev(`window.bridge.setTaskStatus(${J(mine14.id)}, 'review', undefined, '${WA}').then(() => 1)`)
  const rev14c = await waitFor(() => desk.ev(`document.querySelector(${J(rsel)})?.dataset.kind === 'review' ? true : null`), 30, 200)
  await desk.ev(`document.querySelector(${q14('[data-cv-review-accept]')})?.click()`)
  const done14 = await waitFor(async () => { const t = await statusOf14(); return t && t.status === 'done' ? t : null }, 30, 200)
  check('12 a task waiting in review can be accepted right in the card panel', rev14c === true && !!done14, [rev14c, done14?.status])
  await calm()
  await shot('canvas-menu.png')

  const errors = await desk.ev(`document.body.innerText.includes('出错了') || document.body.innerText.includes('Something went wrong')`)
  check('6 no error screen anywhere along the way', errors === false, errors)
  for (const x of [A, B]) await x.close().catch(() => undefined)
}
main()
  .catch((e) => check('script ran', false, e.stack ?? String(e)))
  .finally(async () => {
    if (appPid) spawn('taskkill', ['/PID', String(appPid), '/T', '/F'], { stdio: 'ignore' })
    await sleep(2000)
    try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* leftover temp */ }
    console.log(`\nPASS ${pass}, FAIL ${fail}`)
    process.exit(fail ? 1 : 0)
  })

