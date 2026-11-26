// The Codex-like shell (step 1): a rail with three pages plus 更多 and 设置, the status bar's content moved into the top bar, sidebar and main in one rounded card.
// Usage (repo root, ELECTRON_RUN_AS_NODE unset): node scripts/verify-shell.mjs <out dir> [screenshot dir]
// Isolated: temp data dir, random port, no tunnel. Kills only the Electron tree it started.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vsh-'))
const wsA = path.join(base, 'alpha'), wsB = path.join(base, 'beta'), home = path.join(base, 'home'), data = path.join(base, 'data'), ud = path.join(base, 'ud')
for (const d of [wsA, wsB, home, data, ud]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(wsA, 'keep.txt'), 'line one\n')
const TOKENS = { a: 'wb_vsh_aaaaaaaaaaaaaaaaaaaaaa', b: 'wb_vsh_bbbbbbbbbbbbbbbbbbbbbb' }
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
  // beta is the active workspace; everything below happens in alpha, so the explicit-workspace paths are the ones tested
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ workspaces: [{ id: 'w_aaaa0001', name: 'alpha-proj', root: wsA }, { id: 'w_bbbb0002', name: 'beta-proj', root: wsB }], activeWorkspaceId: 'w_bbbb0002', host: '127.0.0.1', port: PORT, roles: [],
    agents: [{ id: 'a-1', name: 'Alice', color: '#60a5fa', token: TOKENS.a, createdAt: Date.now() }, { id: 'a-2', name: 'Bob', color: '#f472b6', token: TOKENS.b, createdAt: Date.now() }] }))
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

  const BETA = await desk.ev(`window.bridge.getState().then((s) => s.activeWorkspaceId)`)

  const J = JSON.stringify
  const waitFor = async (fn, tries = 30, gap = 200) => { let v; for (let i = 0; i < tries; i++) { v = await fn(); if (v) return v; await sleep(gap) } return v }
  const rail = () => desk.ev(`[...document.querySelectorAll('nav[aria-label="页面"] button')].map((b) => ({ label: b.getAttribute('aria-label'), current: b.getAttribute('aria-current') === 'page', badge: b.querySelector('span')?.innerText ?? null }))`)
  const clickRail = (start) => desk.ev(`(() => { const b = [...document.querySelectorAll('nav[aria-label="页面"] button')].find((x) => (x.getAttribute('aria-label') ?? '').startsWith(${J(start)})); if (!b) return false; b.click(); return true })()`)
  const menu = () => desk.ev(`(() => { const m = document.querySelector('[role=menu][aria-label="设置和管理"]'); if (!m) return null; const r = m.getBoundingClientRect(); return { items: [...m.querySelectorAll('[role=menuitem]')].map((x) => x.innerText.replace(/\\n/g, ' ').trim()), top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), vh: window.innerHeight } })()`)
  const clickMenu = (section) => desk.ev(`(() => { const b = document.querySelector('[role=menu][aria-label="设置和管理"] [data-section=${J(section)}]'); if (!b) return false; b.click(); return true })()`)
  const section = () => desk.ev(`localStorage.getItem('wb.nav.section')`)
  const pills = () => desk.ev(`document.querySelector('[data-status-pills]')?.innerText.replace(/\\n/g, ' | ') ?? null`)

  await desk.ev(`(localStorage.setItem('wb.nav.section', 'overview'), location.reload(), 1)`)
  await waitFor(async () => (await desk.ev(`!!document.querySelector('nav[aria-label="页面"]')`).catch(() => false)) === true, 80, 250)
  await sleep(800)

  // ===== 1. the shell =====
  const RAIL = ['首页', '画布', '任务', '定时任务', '对话', '文件', '搜索', '改动', 'AI 命令', '远端查看', '设置']
  const r1 = await rail()
  const divider = await desk.ev(`(() => { const nav = document.querySelector('nav[aria-label="页面"]'); const d = nav.querySelectorAll('[data-rail-divider]'); return { n: d.length, after: d[0]?.previousElementSibling?.getAttribute('aria-label') ?? null, before: d[0]?.nextElementSibling?.getAttribute('aria-label') ?? null } })()`)
  check('1 the rail has eleven buttons: 首页, 画布, 任务, 定时任务, a divider, 对话, 文件, 搜索, 改动, AI 命令, then at the bottom 远端查看 and 设置; no 更多 button; 首页 is the current one', Array.isArray(r1) && r1.length === 11 && RAIL.every((t, i) => r1[i].label.startsWith(t)) && r1[0].current && r1.filter((x) => x.current).length === 1 && !r1.some((x) => x.label === '更多页面') && divider.n === 1 && divider.after === '定时任务' && divider.before === '对话', [r1, divider])
  const look = await desk.ev(`(() => { const main = document.querySelector('main'); const card = main.closest('.rounded-xl'); const cs = (el) => getComputedStyle(el); return { footer: !!document.querySelector('footer'), shell: cs(document.querySelector('#root > div')).backgroundColor, canvas: cs(main).backgroundColor, cardRadius: card ? cs(card).borderTopLeftRadius : null, asideInCard: !!card && card.contains(document.querySelector('aside')), navInCard: !!card && card.contains(document.querySelector('nav[aria-label="页面"]')), overflowX: document.documentElement.scrollWidth > window.innerWidth } })()`)
  check('1 no status bar at the bottom; sidebar and main sit in one rounded card, the rail outside it; neutral grey colours; nothing sticks out sideways', look.footer === false && look.shell === 'rgb(17, 17, 17)' && look.canvas === 'rgb(23, 23, 23)' && look.cardRadius === '12px' && look.asideInCard && !look.navInCard && !look.overflowX, look)
  const p1 = await pills()
  check('1 the top bar carries what the status bar had: how many AIs are online (both test AIs are connected)', typeof p1 === 'string' && p1.includes('2 / 2 个 AI 在线'), p1)

  // ===== 2. the gear menu (设置和管理), and the pages on the rail =====
  await clickRail('设置')
  const m2 = await waitFor(menu)
  check('2 the gear opens a menu at the bottom left with 设置 and the five management pages, inside the window; it does not navigate by itself', m2 && m2.items.length === 6 && ['设置', '团队与职位', '记忆', '技能', '工具试用', '审计日志'].every((t, i) => m2.items[i].startsWith(t)) && m2.top >= 8 && m2.bottom <= m2.vh && m2.left > 50 && (await section()) === 'overview', [m2, await section()])
  await shot('shell-gear.png')
  await clickMenu('audit')
  const r2 = await waitFor(async () => { const r = await rail(); return r[10]?.current ? r : null })
  check('2 picking 审计日志 goes there, closes the menu, and the gear is the current rail icon (no extra icon appears)', (await section()) === 'audit' && (await menu()) === null && r2?.length === 11 && r2[10].current && !r2[0].current, [await section(), r2])
  await clickRail('设置'); await waitFor(menu)
  await desk.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  const closed = await waitFor(async () => (await menu()) === null)
  await clickRail('设置'); await waitFor(menu)
  await desk.ev(`document.querySelector('.fixed.inset-0.z-40')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  const closed2 = await waitFor(async () => (await menu()) === null)
  check('2 Esc closes the menu, so does clicking elsewhere; the page stays', closed === true && closed2 === true && (await section()) === 'audit', [closed, closed2])
  await clickRail('任务')
  const r3 = await waitFor(async () => { const r = await rail(); return r.length === 11 && r[2].current && !r[10].current ? r : null })
  check('2 back on a rail page, the gear is no longer the current one', !!r3 && (await section()) === 'tasks', r3)
  // every page opens without an error screen: the five work pages from the rail, the settings pages from the gear menu
  const opened = []
  for (const [s, label] of [['chat', '对话'], ['files', '文件'], ['search', '搜索'], ['changes', '改动'], ['commands', 'AI 命令']]) {
    await clickRail(label); await sleep(350)
    const r = await rail()
    opened.push([s, await section(), await desk.ev(`!!document.querySelector('nav[aria-label="页面"]') && !!document.querySelector('main')`), r.find((x) => x.current)?.label?.startsWith(label) === true])
  }
  check('2 对话, 文件, 搜索, 改动 and AI 命令 each open from their own rail icon, which becomes the current one', opened.every(([s, now, ok, cur]) => s === now && ok === true && cur === true), opened)
  const opened2 = []
  for (const s of ['settings', 'team', 'memory', 'skills', 'playground']) {
    await clickRail('设置'); await waitFor(menu); await clickMenu(s); await sleep(350)
    opened2.push([s, await section(), await desk.ev(`!!document.querySelector('nav[aria-label="页面"]') && !!document.querySelector('main')`), (await rail())[10]?.current === true])
  }
  check('2 设置, 团队与职位, 记忆, 技能 and 工具试用 each open from the gear menu and the shell is still there', opened2.every(([s, now, ok, cur]) => s === now && ok === true && cur === true), opened2)
  // the separate 群聊 page has no icon of its own (conversations live on 首页); when something sends you there, its icon shows up while you are on it
  await desk.ev(`(localStorage.setItem('wb.nav.section', 'group'), location.reload(), 1)`)
  await waitFor(async () => (await desk.ev(`!!document.querySelector('nav[aria-label="页面"]')`).catch(() => false)) === true, 80, 250)
  await sleep(600)
  const rg = await rail()
  check('2 on the separate 群聊 page (reached from a notification or the task board) its icon is added to the rail as the current one', rg.length === 12 && rg[9].label === '群聊' && rg[9].current, rg)
  await clickRail('首页')
  const rg2 = await waitFor(async () => { const r = await rail(); return r.length === 11 && r[0].current ? r : null })
  check('2 and it goes away again when you leave', !!rg2, await rail())
  // 概览 used to be in the 更多 menu: it is a row in the home sidebar now
  const ovRow = await desk.ev(`(() => { const r = [...document.querySelectorAll('aside div.cursor-pointer')].find((x) => x.offsetParent !== null && x.innerText.trim() === '概览'); if (!r) return false; r.click(); return true })()`)
  const ovMain = await waitFor(async () => { const x = await desk.ev(`document.querySelector('main')?.innerText ?? ''`); return x.includes('在线 AI') ? x : '' })
  check('2 概览 is a row in the home sidebar (under 大厅) and opens the overview page', ovRow === true && !!ovMain && (await rail())[0].current, [ovRow, String(ovMain).slice(0, 100)])
  await desk.ev(`(() => { const r = [...document.querySelectorAll('aside div.cursor-pointer')].find((x) => x.offsetParent !== null && x.innerText.trim() === '新会话'); r?.click(); return 1 })()`)
  await sleep(300)
  // leave 首页, so that the click on 首页 below goes there instead of folding the sidebar (clicking the current page's icon does that)
  await clickRail('任务'); await sleep(300)

  // ===== 3. badges and status =====
  await clickRail('首页')
  await A.call('chat_send', { channel: 'general', text: 'Alice 在大厅说一句' })
  const r4 = await waitFor(async () => { const r = await rail(); return r[0]?.badge === '1' ? r : null })
  check('3 an unread chat message shows as a badge on 首页 (conversations live there now)', !!r4, await rail())
  // a task one AI gives another stays in review until the giver decides (a task from the user with no reviewer AI goes straight to done)
  const mk = await A.call('task_create', { workspace: BETA, title: '待审查的任务', assigneeId: 'Bob' })
  const upd = await B.call('task_update', { task: mk.data?.ref, workspace: BETA, status: 'review', result: '做完了，请审查' })
  const p3 = await waitFor(async () => { const p = await pills(); return p && p.includes('待审查') ? p : null })
  const r5 = await rail()
  check('3 a task waiting for review shows on the 任务 icon and as a pill in the top bar', !!p3 && r5[2]?.badge === '1', [p3, r5, String(mk.raw).slice(0, 200), String(upd.raw).slice(0, 300)])
  const on = await desk.ev(`window.bridge.remoteViewStart({ tunnel: false }).then((r) => r.state)`)
  const p4 = await waitFor(async () => { const t = await desk.ev(`[...document.querySelectorAll('header button')].find((x) => x.innerText.includes('远端'))?.innerText ?? null`); return t })
  await shot('shell.png')
  await desk.ev(`window.bridge.remoteViewStop()`)
  const p5 = await waitFor(async () => (await desk.ev(`[...document.querySelectorAll('header button')].some((x) => x.innerText.includes('远端'))`)) === false)
  check('3 remote view on: its indicator is in the top bar the whole time; off: gone', on === 'on' && typeof p4 === 'string' && p5 === true, [on, p4, p5])

  // ===== 4. layout switches still work =====
  const side0 = await desk.ev(`document.querySelector('aside')?.offsetParent !== null`)
  await desk.ev(`document.querySelector('header button[aria-label^="收起侧栏"]')?.click()`)
  const side1 = await waitFor(async () => (await desk.ev(`document.querySelector('aside')?.offsetParent === null`)) === true)
  await desk.ev(`document.querySelector('header button[aria-label^="展开侧栏"]')?.click()`)
  const side2 = await waitFor(async () => (await desk.ev(`document.querySelector('aside')?.offsetParent !== null`)) === true)
  check('4 the sidebar switch (now at the left of the top bar) hides and shows the sidebar', side0 === true && side1 === true && side2 === true, [side0, side1, side2])
  await desk.ev(`document.querySelector('header button[aria-label^="打开终端"]')?.click()`)
  const term = await waitFor(async () => (await desk.ev(`!!document.querySelector('section .xterm, section [class*=xterm]') || [...document.querySelectorAll('section')].some((x) => x.offsetParent !== null && x.offsetHeight > 80)`)) === true)
  await desk.ev(`document.querySelector('header button[aria-label^="收起终端"]')?.click()`)
  check('4 the terminal switch opens the bottom panel inside the card', term === true, term)
  // a narrow window: the pills are cut, the buttons at the right stay
  await desk.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false })
  await sleep(600)
  const narrow = await desk.ev(`(() => { const stop = [...document.querySelectorAll('header button')].find((x) => x.innerText.includes('全部停下')); const r = stop?.getBoundingClientRect(); return { stopRight: r ? Math.round(r.right) : null, w: window.innerWidth, overflowX: document.documentElement.scrollWidth > window.innerWidth, mainW: Math.round(document.querySelector('main').getBoundingClientRect().width) } })()`)
  await shot('shell-narrow.png')
  await desk.send('Emulation.clearDeviceMetricsOverride')
  check('4 at 900 px wide the 全部停下 button is still inside the window and the main area keeps its room', narrow.stopRight !== null && narrow.stopRight <= narrow.w && !narrow.overflowX && narrow.mainW >= 300, narrow)

  // ===== 5. what a button is for shows at once in the top bar and the right panel (the system tooltip takes about a second) =====
  await sleep(400)
  const mouse = (x, y, type = 'mouseMoved', extra = {}) => desk.send('Input.dispatchMouseEvent', { type, x, y, button: 'none', ...extra })
  const tipNow = () => desk.ev(`(() => { const t = document.querySelector('[data-instant-tip]'); if (!t || getComputedStyle(t).visibility === 'hidden') return null; const r = t.getBoundingClientRect(); return { text: t.innerText, top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right) } })()`)
  const spot = (expr) => desk.ev(`(() => { const b = ${expr}; if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), bottom: Math.round(r.bottom), title: b.getAttribute('title'), label: b.getAttribute('aria-label') } })()`)
  const named = (b) => `(${b}.getAttribute('aria-label') ?? ${b}.getAttribute('title') ?? '')`
  const sideBtn = `[...document.querySelectorAll('header button')].find((x) => /侧栏/.test(${named('x')}))`
  const s0 = await spot(sideBtn)
  await mouse(500, 400); await sleep(100)
  await mouse(s0.x - 1, s0.y); await mouse(s0.x, s0.y)
  const tip1 = await waitFor(tipNow, 5, 40)
  const during = await desk.ev(`(() => { const b = ${sideBtn}; return { title: b.getAttribute('title'), label: b.getAttribute('aria-label') } })()`)
  check('5 moving the mouse onto a top-bar button shows what it is for at once, right under it; the slow system tooltip is off meanwhile (title emptied, the name for screen readers kept)', !!tip1 && !!s0.title && tip1.text === s0.title && tip1.top >= s0.bottom && tip1.top - s0.bottom <= 12 && tip1.left >= 0 && during.title === '' && during.label === s0.title, [s0, tip1, during])
  await shot('shell-tip.png')
  await mouse(500, 400)
  const gone = await waitFor(async () => (await tipNow()) === null, 5, 40)
  const after = await desk.ev(`(${sideBtn}).getAttribute('title')`)
  check('5 moving away takes it down and puts the title back', gone === true && after === s0.title, [gone, after])
  await mouse(s0.x - 1, s0.y); await mouse(s0.x, s0.y); await waitFor(tipNow, 5, 40)
  await mouse(s0.x, s0.y, 'mousePressed', { button: 'left', clickCount: 1 }); await mouse(s0.x, s0.y, 'mouseReleased', { button: 'left', clickCount: 1 })
  await sleep(300)
  const pressed = { tip: await tipNow(), title: await desk.ev(`(${sideBtn}).getAttribute('title')`), label: await desk.ev(`(${sideBtn}).getAttribute('aria-label')`) }
  await mouse(500, 400); await sleep(150)
  const flipped = await desk.ev(`(${sideBtn}).getAttribute('title')`)
  check('5 pressing the button takes the tip down; what the button does flips (收起 / 展开) and the title put back afterwards is the new one', pressed.tip === null && pressed.title === '' && pressed.label !== s0.title && flipped === pressed.label, [pressed, flipped])
  await desk.ev(`(${sideBtn}).click()`); await sleep(300)
  if (!(await desk.ev(`!!document.querySelector('[data-right-panel]')`))) {
    await desk.ev(`[...document.querySelectorAll('header button')].find((b) => ${named('b')}.startsWith('展开右栏'))?.click()`)
    await waitFor(() => desk.ev(`!!document.querySelector('[data-right-panel]')`))
  }
  // the panel has just been opened: its buttons can still be moving (the panel sliding in, tabs arriving). Take the button's place only once it stays put,
  // otherwise the mouse goes to where the button was and no tip can show (seen once in the batch 33 full run)
  const settled = async (expr) => { let a = await spot(expr); for (let i = 0; i < 25; i++) { await sleep(120); const b = await spot(expr); if (a && b && a.x === b.x && a.y === b.y) return b; a = b } return a }
  const n0 = await settled(`document.querySelector('[data-right-panel] [data-right-new]')`)
  await mouse(500, 400); await sleep(100)
  await mouse(n0.x - 1, n0.y); await mouse(n0.x, n0.y)
  const tip2 = await waitFor(tipNow, 5, 40)
  await mouse(500, 400); await sleep(150)
  const outside = `[...document.querySelectorAll('aside [title]')].find((x) => x.offsetParent !== null && x.getAttribute('title'))`
  const railBtn = await spot(outside)
  await mouse(railBtn.x - 1, railBtn.y); await mouse(railBtn.x, railBtn.y); await sleep(200)
  const railNow = { tip: await tipNow(), title: await desk.ev(`document.elementFromPoint(${railBtn.x}, ${railBtn.y})?.closest('[title]')?.getAttribute('title') ?? null`) }
  await mouse(500, 400)
  check('5 the same in the right panel (新标签页), kept inside the window; outside those two places nothing changes (something with a title in the sidebar keeps it under the mouse)', !!tip2 && tip2.text === '新标签页' && tip2.right <= (await desk.ev('window.innerWidth')) && railNow.tip === null && !!railBtn.title && railNow.title === railBtn.title, [n0, tip2, railBtn, railNow])
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
