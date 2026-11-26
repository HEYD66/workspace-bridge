// The phone layout: one column at a time, tabs at the bottom, list -> detail -> back, 全部停下 always there,
// pages not laid out for phones keep the desktop look (drawn 1100 wide, scaled down) with a big button back.
// Checked on an isolated instance whose window is made to look like a 390 x 844 phone; the layout is forced with wb.layout.phone = 1
// (on a real phone it switches on by itself when the page is opened through the remote link on a small screen).
// Usage (repo root, ELECTRON_RUN_AS_NODE unset): node scripts/verify-phone.mjs <out dir> [screenshot dir]
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vph-'))
const wsA = path.join(base, 'alpha'), wsB = path.join(base, 'beta'), home = path.join(base, 'home'), data = path.join(base, 'data'), ud = path.join(base, 'ud')
for (const d of [wsA, wsB, home, data, ud]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(wsA, 'keep.txt'), 'line one\n')
const TOKENS = { a: 'wb_vph_aaaaaaaaaaaaaaaaaaaaaa', b: 'wb_vph_bbbbbbbbbbbbbbbbbbbbbb', c: 'wb_vph_cccccccccccccccccccccc' }
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
  const J = JSON.stringify
  const waitFor = async (fn, tries = 30, gap = 200) => { let v; for (let i = 0; i < tries; i++) { v = await fn(); if (v) return v; await sleep(gap) } return v }
  const PORT = await freePort(), CDP = await freePort()
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ workspaces: [{ id: 'w_aaaa0001', name: 'alpha-proj', root: wsA }], activeWorkspaceId: 'w_aaaa0001', host: '127.0.0.1', port: PORT, roles: [],
    agents: [{ id: 'a-1', name: 'Alice', color: '#60a5fa', token: TOKENS.a, createdAt: Date.now() }, { id: 'a-2', name: 'Bob', color: '#f472b6', token: TOKENS.b, createdAt: Date.now() }] }))
  const { ELECTRON_RUN_AS_NODE: _d, ...env } = process.env
  const app = spawn(electronPath, [path.join(OUT, 'main', 'index.js'), `--remote-debugging-port=${CDP}`, `--user-data-dir=${ud}`], { cwd: process.cwd(), env: { ...env, WB_DATA_DIR: data, WB_USER_SKILLS_DIR: path.join(base, 'skills'), WB_MACHINE_ROOT: home, ELECTRON_RENDERER_URL: '', WB_EXIT_PROBE_URL: 'off' }, stdio: 'ignore' })
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
  const CH = 'ws:w_aaaa0001'
  await B.call('chat_send', { channel: CH, text: 'Bob 说：登录页我来改' })
  const t1 = await A.call('task_create', { workspace: 'alpha-proj', title: '做登录页', assigneeId: 'Bob' })
  await sleep(500)
  const shell = () => desk.ev(`document.querySelector('[data-phone-shell]')?.getAttribute('data-phone-shell') ?? null`)
  const tabs = () => desk.ev(`[...document.querySelectorAll('[data-phone-tabs] [data-phone-tab]')].map((b) => ({ id: b.getAttribute('data-phone-tab'), text: b.innerText.trim().split('\\n').pop(), on: b.getAttribute('aria-current') === 'page', h: Math.round(b.getBoundingClientRect().height) }))`)
  const tap = (css) => desk.ev(`(() => { const b = document.querySelector(${J(css)}); if (!b) return false; b.click(); return true })()`)
  const tapRow = (label) => desk.ev(`(() => { const r = [...document.querySelectorAll('[data-phone-list] div.cursor-pointer')].find((x) => x.offsetParent !== null && x.innerText.trim().startsWith(${J(label)})); if (!r) return false; r.click(); return true })()`)
  const fits = () => desk.ev(`({ vw: window.innerWidth, doc: document.documentElement.scrollWidth, shell: Math.round(document.querySelector('[data-phone-shell]')?.getBoundingClientRect().width ?? 0), shellH: Math.round(document.querySelector('[data-phone-shell]')?.getBoundingClientRect().height ?? 0), vh: window.innerHeight })`)
  const viewport = () => desk.ev(`document.querySelector('meta[name="viewport"]')?.content ?? null`)
  const text = (css) => desk.ev(`document.querySelector(${J(css)})?.innerText ?? ''`)

  // ===== 0. the desktop window is not a phone =====
  await waitFor(() => desk.ev(`!!document.querySelector('nav[aria-label="页面"]')`), 80, 250)
  check('0 the ordinary desktop window keeps the desktop layout: no phone shell, the icon rail is there, no "back to phone" button', (await shell()) === null && (await desk.ev(`document.querySelectorAll('nav[aria-label="页面"] button').length`)) === 11 && (await desk.ev(`!document.querySelector('[data-phone-return]')`)) === true)

  // ===== 1. the phone shell (forced here with wb.layout.phone = 1, on a 390 x 844 screen) =====
  await desk.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await desk.ev(`(localStorage.setItem('wb.layout.phone', '1'), localStorage.setItem('wb.nav.section', 'overview'), localStorage.setItem('wb.projects.expanded', ${J(J(['w_aaaa0001']))}), location.reload(), 1)`)
  await waitFor(async () => (await shell().catch(() => null)) !== null, 80, 250)
  await sleep(700)
  const t = await tabs()
  const f1 = await fits()
  check('1 one column: no icon rail, no side-by-side panels; four tabs at the bottom (会话, 任务, 活动, 更多), 会话 is on, each at least 44 px tall', (await shell()) === 'main' && J(t.map((x) => x.text)) === J(['会话', '任务', '活动', '更多']) && t[0].on && t.every((x) => x.h >= 44) && (await desk.ev(`document.querySelectorAll('aside').length`)) === 0, [await shell(), t])
  check('1 the page is laid out at the phone width and fills the screen: nothing sticks out sideways', f1.vw === 390 && f1.doc <= 390 && f1.shell === 390 && Math.abs(f1.shellH - f1.vh) <= 1 && (await viewport()) === 'width=device-width, initial-scale=1, viewport-fit=cover', [f1, await viewport()])
  const top = await desk.ev(`({ online: document.querySelector('[data-phone-online]')?.innerText.trim(), stop: document.querySelector('[data-phone-stop]')?.innerText.trim(), list: document.querySelector('[data-phone-list]')?.innerText ?? '' })`)
  check('1 the top bar has how many AIs are online and 全部停下; the list is the home list (新会话, 新任务, 大厅, the project and its 群聊)', top.online === '2 / 2 在线' && top.stop === '全部停下' && ['新会话', '新任务', '大厅', 'alpha-proj', '群聊'].every((x) => top.list.includes(x)), top)
  const rows = await desk.ev(`[...document.querySelectorAll('[data-phone-list] div.cursor-pointer')].filter((x) => x.offsetParent !== null).map((x) => Math.round(x.getBoundingClientRect().height))`)
  check('1 every row of the list is at least 44 px tall (finger-sized)', rows.length >= 5 && rows.every((h) => h >= 44), rows)
  // buttons that only appeared under a hovering mouse (Tailwind's hover / group-hover do nothing on a device that cannot hover)
  const acts = await desk.ev(`(() => { const vis = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.9 && r.width >= 30 && r.height >= 30 }; const pa = [...document.querySelectorAll('[data-phone-list] [data-project-actions]')].find((x) => x.offsetParent !== null); return { actions: pa ? { opacity: getComputedStyle(pa).opacity, buttons: [...pa.querySelectorAll('button')].map(vis) } : null, more: [...document.querySelectorAll('[data-phone-list] [data-row-more]')].filter((x) => x.offsetParent !== null).map(vis), archive: [...document.querySelectorAll('[data-phone-list] [data-thread-archive]')].filter((b) => getComputedStyle(b).display !== 'none').length, lost: [...document.querySelectorAll('[data-phone-list] div.cursor-pointer')].filter((x) => x.offsetParent !== null && x.scrollWidth > x.clientWidth + 1).length } })()`)
  check('1 buttons that needed a hovering mouse are there without one: the project row shows its three buttons, rows that have a right-click menu get a … button, all finger-sized, no row is pushed wider than the screen', acts?.actions?.opacity === '1' && acts.actions.buttons.length === 3 && acts.actions.buttons.every(Boolean) && acts.more.length >= 2 && acts.more.every(Boolean) && acts.archive === 0 && acts.lost === 0, acts)
  await desk.ev(`(() => { const r = [...document.querySelectorAll('[data-phone-list] div.cursor-pointer')].find((x) => x.offsetParent !== null && x.innerText.trim().startsWith('群聊')); const b = r?.querySelector('[data-row-more]'); b?.click(); return !!b })()`)
  const menu = await waitFor(() => desk.ev(`(() => { const m = document.querySelector('[role="menu"]'); return m ? { text: m.innerText, rows: [...m.querySelectorAll('[role="menuitem"]')].map((x) => Math.round(x.getBoundingClientRect().height)) } : null })()`))
  check('1 tapping … on the 群聊 row opens the menu a right-click would (清空消息 is in it), its rows are finger-sized, and the conversation itself is not opened', !!menu && menu.text.includes('清空消息') && menu.rows.every((h) => h >= 40) && (await shell()) === 'main', [menu, await shell()])
  await desk.ev(`document.querySelector('[role="menu"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
  await waitFor(() => desk.ev(`!document.querySelector('[role="menu"]')`))
  await shot('phone-list.png')

  // ===== 2. into a conversation and back =====
  await tapRow('群聊')
  const inChat = await waitFor(async () => (await shell()) === 'detail' && (await desk.ev(`!!document.getElementById('group-composer')`)))
  const c = await desk.ev(`(() => { const col = document.querySelector('[data-chat-column]').getBoundingClientRect(); const box = document.querySelector('[data-composer]').getBoundingClientRect(); return { col: Math.round(col.width), boxBottom: Math.round(box.bottom), vh: window.innerHeight, tabs: !!document.querySelector('[data-phone-tabs]'), back: !!document.querySelector('[data-phone-back-button]'), panel: !!document.querySelector('[data-phone-panel]'), stop: !!document.querySelector('[data-phone-stop]'), font: getComputedStyle(document.getElementById('group-composer')).fontSize, msg: document.querySelector('[data-phone-detail]').innerText.includes('Bob 说：登录页我来改') } })()`)
  const f2 = await fits()
  check('2 tapping the project\'s 群聊 opens it full-screen: the message is there, 返回 at the top left, 变更 · 任务 at the top right, 全部停下 still there, the bottom tabs are gone', inChat === true && c.msg && c.back && c.panel && c.stop && !c.tabs, c)
  check('2 the conversation fits the phone: the column is as wide as the screen, the box you type in sits at the bottom edge, its text is 16 px (so iPhones do not zoom in), nothing sticks out sideways', c.col === 390 && c.vh - c.boxBottom <= 2 && c.font === '16px' && f2.doc <= 390, [c, f2])
  await shot('phone-chat.png')
  await desk.ev(`(() => { const i = document.getElementById('group-composer'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(i, '手机上发的一句'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return 1 })()`)
  const sent = await waitFor(async () => (await text('[data-phone-detail]')).includes('手机上发的一句'))
  const live = await waitFor(() => desk.ev(`!!document.querySelector('[data-phone-detail] [data-chat-live]')`))
  check('2 you can send from there, and the lines saying what the AIs are doing show up under it', sent === true && live === true)
  // 回复 / 私聊 on a message used to need a hovering mouse: now a tap on the message brings them up
  const openTools = `[...document.querySelectorAll('[data-phone-detail] [data-msg-tools]')].filter((x) => getComputedStyle(x).display !== 'none')`
  const toolsBefore = await desk.ev(`${openTools}.length`)
  await desk.ev(`(() => { const m = [...document.querySelectorAll('[data-phone-detail] [id^="gm-"]')].find((x) => x.innerText.includes('Bob 说')); m?.click(); return !!m })()`)
  const tools = await waitFor(() => desk.ev(`(() => { const t = ${openTools}; return t.length === 1 ? [...t[0].querySelectorAll('button')].map((b) => ({ label: b.getAttribute('aria-label'), w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) })) : null })()`))
  check('2 tapping a message brings up 回复 and 私聊 for that message only, finger-sized', toolsBefore === 0 && Array.isArray(tools) && tools[0]?.label === '回复' && tools.some((b) => String(b.label).startsWith('私聊给')) && tools.every((b) => b.w >= 32 && b.h >= 32), [toolsBefore, tools])
  await desk.ev(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
  const toolsAway = await waitFor(async () => (await desk.ev(`${openTools}.length`)) === 0)
  await desk.ev(`(() => { const m = [...document.querySelectorAll('[data-phone-detail] [id^="gm-"]')].find((x) => x.innerText.includes('Bob 说')); m?.click(); return !!m })()`)
  await waitFor(async () => (await desk.ev(`${openTools}.length`)) === 1)
  await desk.ev(`${openTools}[0]?.querySelector('button[aria-label="回复"]')?.click()`)
  const replying = await waitFor(() => desk.ev(`${openTools}.length === 0 && (document.querySelector('[data-composer]')?.innerText ?? '').includes('回复 Bob')`))
  check('2 touching anywhere else puts them away; 回复 starts a reply to that message (shown above the box you type in) and puts them away too', toolsAway === true && replying === true, [toolsAway, replying])
  await desk.ev(`document.querySelector('[data-composer] button[aria-label="取消引用"]')?.click()`); await sleep(200)
  await tap('[data-phone-panel]')
  const panel = await waitFor(async () => (await shell()) === 'panel' && (await desk.ev(`!!document.querySelector('[data-right-panel]')`)))
  const panelText = await text('[data-right-panel]')
  check('2 变更 · 任务 opens the right panel as a page of its own (变更, 任务, 活动), with 返回', panel === true && ['变更', '任务', '活动'].every((x) => panelText.includes(x)) && (await desk.ev(`!!document.querySelector('[data-phone-back-button]')`)), panelText.slice(0, 200))
  await tap('[data-phone-back-button]')
  const backToChat = await waitFor(async () => (await shell()) === 'detail')
  await tap('[data-phone-back-button]')
  const backToList = await waitFor(async () => (await shell()) === 'main' && (await desk.ev(`!!document.querySelector('[data-phone-tabs]')`)))
  check('2 返回 goes back one step each time: from the panel to the conversation, from the conversation to the list (tabs are back)', backToChat === true && backToList === true)

  // ===== 3. 任务 =====
  await tap('[data-phone-tab="tasks"]')
  const taskList = await waitFor(async () => { const x = await text('[data-phone-list]'); return x.includes('做登录页') ? x : '' })
  check('3 the 任务 tab shows the task list (not the wide board)', !!taskList && (await tabs())[1].on && (await fits()).doc <= 390, [String(taskList).slice(0, 120), await tabs()])
  await tapRow('T-1') || await desk.ev(`(() => { const r = [...document.querySelectorAll('[data-phone-list] .cursor-pointer')].find((x) => x.offsetParent !== null && x.innerText.includes('做登录页')); r?.click(); return !!r })()`)
  const taskDetail = await waitFor(async () => (await shell()) === 'detail' && (await text('[data-phone-detail]')).includes('做登录页'))
  check('3 tapping a task opens it full-screen with 返回', taskDetail === true && (await desk.ev(`!!document.querySelector('[data-phone-back-button]')`)) && (await fits()).doc <= 390, [await shell(), (await text('[data-phone-detail]')).slice(0, 100), await fits()])
  await shot('phone-task.png')
  await tap('[data-phone-back-button]'); await sleep(300)

  // ===== 4. 活动 =====
  await tap('[data-phone-tab="activity"]')
  const act = await waitFor(async () => { const x = await text('[data-phone-shell]'); return (await shell()) === 'activity' && x.includes('Alice') && x.includes('Bob') ? x : '' })
  check('4 the 活动 tab is the activity list on its own page (filters, what Alice and Bob did)', !!act && ['全部', '改文件', '协作', '失败'].every((x) => act.includes(x)) && (await tabs())[2].on && (await fits()).doc <= 390, String(act).slice(0, 200))
  await shot('phone-activity.png')

  // ===== 5. 全部停下 =====
  await tap('[data-phone-stop]')
  const paused = await waitFor(async () => (await text('[data-phone-stop]')).trim() === '恢复 AI' && (await desk.ev(`window.bridge.getState().then((s) => s.paused)`)) === true)
  await tap('[data-phone-stop]')
  const resumed = await waitFor(async () => (await text('[data-phone-stop]')).trim() === '全部停下' && (await desk.ev(`window.bridge.getState().then((s) => s.paused)`)) === false)
  check('5 全部停下 pauses every AI from the phone and turns into 恢复 AI; tapping that resumes', paused === true && resumed === true, [paused, resumed])

  // ===== 6. 更多, and pages that keep the desktop look =====
  await tap('[data-phone-tab="more"]')
  const more = await waitFor(() => desk.ev(`(() => { const m = document.querySelector('[data-phone-more]'); if (!m) return null; return [...m.querySelectorAll('[data-phone-more-item]')].map((b) => [b.getAttribute('data-phone-more-item'), b.innerText.includes('电脑版样子'), Math.round(b.getBoundingClientRect().height)]) })()`))
  check('6 更多 lists the other pages; 对话, 改动, AI 命令, 定时任务 are phone pages, the rest are marked 电脑版样子; rows are finger-sized', J(more.map((x) => x[0])) === J(['canvas', 'chat', 'changes', 'commands', 'schedules', 'files', 'search', 'settings', 'team', 'memory', 'skills', 'playground', 'audit']) && J(more.filter((x) => !x[1]).map((x) => x[0])) === J(['chat', 'changes', 'commands', 'schedules']) && more.every((x) => x[2] >= 44), more)
  await shot('phone-more.png')
  await tap('[data-phone-more-item="schedules"]')
  const sched = await waitFor(async () => (await shell()) === 'main' && (await desk.ev(`localStorage.getItem('wb.nav.section')`)) === 'schedules')
  check('6 定时任务 opens as a phone page (its list), with 更多 still the lit tab', sched === true && (await tabs())[3].on && (await fits()).doc <= 390, [await shell(), await tabs(), await fits()])
  await tap('[data-phone-tab="more"]'); await waitFor(() => desk.ev(`!!document.querySelector('[data-phone-more]')`))
  await tap('[data-phone-more-item="settings"]')
  const desktop = await waitFor(async () => (await shell()) === null && (await desk.ev(`!!document.querySelector('nav[aria-label="页面"]') && !!document.querySelector('[data-phone-return]')`)))
  check('6 设置 opens with the desktop look: the page is drawn 1100 wide and scaled down, and a big 回手机版 button floats over it', desktop === true && (await viewport()) === 'width=1100' && (await text('[data-phone-return]')).includes('回手机版') && (await desk.ev(`document.querySelector('[data-phone-return]').getBoundingClientRect().height`)) >= 80, [await shell(), await viewport()])
  await tap('[data-phone-return]')
  const again = await waitFor(async () => (await shell()) === 'more')
  check('6 回手机版 returns to the phone layout', again === true && (await viewport()) === 'width=device-width, initial-scale=1, viewport-fit=cover', [await shell(), await viewport()])

  // ===== 7. choosing the desktop look for everything, and coming back =====
  await tap('[data-phone-desktop]')
  const forced = await waitFor(async () => (await desk.ev(`localStorage.getItem('wb.layout.phone')`).catch(() => null)) === '0' && (await shell().catch(() => 'x')) === null && (await desk.ev(`!!document.querySelector('nav[aria-label="页面"]')`).catch(() => false)) === true, 60, 250)
  check('7 整个界面都用电脑版样子 switches the whole thing to the desktop layout and remembers it', forced === true, [await desk.ev(`localStorage.getItem('wb.layout.phone')`), await shell()])
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
