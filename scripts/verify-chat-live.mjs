// The conversation page, live: the message column uses the width it has; rail button descriptions appear at once;
// between your message and the reply the conversation shows what the AIs are doing; the latest message of each AI carries its current state.
// Usage (repo root, ELECTRON_RUN_AS_NODE unset): node scripts/verify-chat-live.mjs <out dir> [screenshot dir]
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vcl-'))
const wsA = path.join(base, 'alpha'), wsB = path.join(base, 'beta'), home = path.join(base, 'home'), data = path.join(base, 'data'), ud = path.join(base, 'ud')
for (const d of [wsA, wsB, home, data, ud]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(wsA, 'keep.txt'), 'line one\n')
const TOKENS = { a: 'wb_vcl_aaaaaaaaaaaaaaaaaaaaaa', b: 'wb_vcl_bbbbbbbbbbbbbbbbbbbbbb', c: 'wb_vcl_cccccccccccccccccccccc' }
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
  // three AIs: Alice and Bob connect, Carol never does (she is the one who is "not online")
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ workspaces: [{ id: 'w_aaaa0001', name: 'alpha-proj', root: wsA }], activeWorkspaceId: 'w_aaaa0001', host: '127.0.0.1', port: PORT, roles: [],
    agents: [{ id: 'a-1', name: 'Alice', color: '#60a5fa', token: TOKENS.a, createdAt: Date.now() }, { id: 'a-2', name: 'Bob', color: '#f472b6', token: TOKENS.b, createdAt: Date.now() }, { id: 'a-3', name: 'Carol', color: '#34d399', token: TOKENS.c, createdAt: Date.now() }] }))
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
  const typeMsg = (value) => desk.ev(`(() => { const i = document.getElementById('group-composer'); if (!i) return false; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(i, ${J(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  const say = async (text) => { await typeMsg(text); await desk.ev(`document.getElementById('group-composer').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`); return waitFor(async () => (await desk.ev(`document.querySelector('main')?.innerText ?? ''`)).includes(text)) }
  const move = (x, y) => desk.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  // the rows at the bottom of the conversation: who, what kind of state, the text, the steps line, whether it spins, whether a duration is shown
  const live = () => desk.ev(`(() => { const s = document.querySelector('main [data-chat-live]'); if (!s) return null; return { rows: [...s.querySelectorAll('[data-live-agent]')].map((r) => ({ id: r.getAttribute('data-live-agent'), kind: r.getAttribute('data-live-kind'), text: r.querySelector('[data-live-text]')?.innerText ?? '', steps: r.querySelector('[data-live-steps]')?.innerText ?? '', spin: !!r.querySelector('svg.animate-spin'), secs: /秒|分/.test(r.innerText.replace(r.querySelector('[data-live-text]')?.innerText ?? '', '')) })), offline: s.querySelector('[data-live-offline]')?.innerText ?? '' } })()`)
  const row = async (id) => (await live())?.rows.find((r) => r.id === id)

  // open the project's group chat on the home page
  await desk.ev(`(localStorage.setItem('wb.nav.section', 'overview'), localStorage.setItem('wb.projects.expanded', ${J(J(['w_aaaa0001']))}), localStorage.setItem('wb.layout.activityOpen', 'false'), location.reload(), 1)`)
  await waitFor(async () => (await desk.ev(`!!document.querySelector('nav[aria-label="页面"]')`).catch(() => false)) === true, 80, 250)
  await sleep(800)
  await desk.ev(`(() => { const r = [...document.querySelectorAll('aside div.cursor-pointer')].find((x) => x.offsetParent !== null && x.innerText.trim().startsWith('群聊')); r?.click(); return !!r })()`)
  await waitFor(() => desk.ev(`!!document.getElementById('group-composer') && !!document.querySelector('main [data-chat-header]')`), 40, 250)

  // ===== 1. the conversation uses the width it has =====
  await B.call('chat_send', { channel: CH, text: 'Bob 先说一句，看看排在哪' })
  await waitFor(async () => (await desk.ev(`document.querySelector('main')?.innerText ?? ''`)).includes('Bob 先说一句'))
  const w = await desk.ev(`(() => { const main = document.querySelector('main').getBoundingClientRect(); const col = document.querySelector('main [data-chat-column]').getBoundingClientRect(); const box = document.querySelector('main [data-composer] > div').getBoundingClientRect(); const first = [...document.querySelectorAll('main [id^="gm-"]')].find((x) => x.innerText.includes('Bob 先说一句')).getBoundingClientRect(); return { main: Math.round(main.width), col: Math.round(col.width), box: Math.round(box.width), gapLeft: Math.round(first.left - main.left), gapRight: Math.round(main.right - first.right) } })()`)
  check('1 the message column and the box you type in are as wide as the page (up to 1280): no big empty strip left of the messages', w.col >= Math.min(w.main, 1280) - 2 && w.box >= Math.min(w.main, 1280) - 60 && w.gapLeft <= 40 && w.gapRight <= 40 && w.main > 900, w)

  // ===== 2. the descriptions of the rail buttons come up at once =====
  const noTitle = await desk.ev(`[...document.querySelectorAll('nav[aria-label="页面"] button')].every((b) => !b.hasAttribute('title') && (b.getAttribute('data-tip') ?? '').length > 0)`)
  const tb = await desk.ev(`(() => { const b = [...document.querySelectorAll('nav[aria-label="页面"] button')].find((x) => x.getAttribute('aria-label') === '任务').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } })()`)
  await move(tb.x, tb.y)
  const t0 = Date.now()
  const tip = await waitFor(() => desk.ev(`(() => { const t = document.querySelector('[data-rail-tip]'); if (!t) return null; const r = t.getBoundingClientRect(); return { text: t.innerText, left: Math.round(r.left), mid: Math.round(r.top + r.height / 2) } })()`), 20, 50)
  const took = Date.now() - t0
  check('2 pointing at a rail button shows its description right next to it within a fraction of a second (it used to be the browser tooltip, a full second)', noTitle === true && tip?.text === '任务' && took < 600 && tip.left >= 56 && Math.abs(tip.mid - tb.y) <= 3, [noTitle, tip, took, tb])
  await shot('chat-live-tip.png')
  await move(700, 400)
  const tipGone = await waitFor(async () => (await desk.ev(`!document.querySelector('[data-rail-tip]')`)) === true, 20, 50)
  check('2 it goes away when the pointer leaves the rail', tipGone === true)

  // ===== 3. between your message and the reply, the conversation shows what the AIs are doing =====
  check('3 before you say anything there is nothing at the bottom', (await live()) === null)
  await say('帮我看看 keep.txt 里写了什么')
  const l1 = await waitFor(async () => { const v = await live(); return v && v.rows.length === 2 ? v : null }, 40, 250)
  check('3 after you send, Alice and Bob (connected) each get a line saying what state they are in, with how long; Carol, who is not connected, is named as not online', !!l1 && l1.rows.map((r) => r.id).sort().join() === 'a-1,a-2' && l1.rows.every((r) => r.text.length > 0 && r.secs) && l1.offline.includes('Carol') && l1.offline.includes('不在线'), l1)
  await B.call('read_file', { workspace: 'alpha-proj', path: 'keep.txt' })
  const l2 = await waitFor(async () => { const r = await row('a-2'); return r && r.steps.includes('keep.txt') ? r : null }, 40, 250)
  check('3 Bob reads a file: his line lists it as a step of this round', !!l2 && l2.steps.includes('已做 1 步') && l2.steps.includes('读取'), l2 ?? (await live()))
  // a command that takes a few seconds: while it runs the line says so and spins
  const running = B.call('run_command', { workspace: 'alpha-proj', command: 'sleep 6 && echo done-sleeping' })
  const l3 = await waitFor(async () => { const r = await row('a-2'); return r && r.text.startsWith('正在') && r.text.includes('sleep 6') ? r : null }, 40, 200)
  check('3 while Bob runs a command his line says 正在执行命令 with the command, spins and counts the seconds; he is listed first', !!l3 && l3.text.startsWith('正在执行命令') && l3.spin === true && l3.secs === true && (await live())?.rows[0]?.id === 'a-2', l3 ?? (await live()))
  await shot('chat-live.png')
  const ran = await running
  const l4 = await waitFor(async () => { const r = await row('a-2'); return r && !r.text.startsWith('正在执行命令') && r.steps.includes('已做 2 步') ? r : null }, 60, 250)
  check('3 when the command ends the line stops spinning and the command is in the steps', !ran.isError && !!l4 && l4.steps.includes('执行命令') && l4.steps.includes('sleep 6'), l4 ?? (await live()))
  await B.call('chat_send', { channel: CH, text: 'keep.txt 里只有一行：line one' })
  const l5 = await waitFor(async () => { const v = await live(); return v && !v.rows.some((r) => r.id === 'a-2') ? v : null }, 60, 250)
  check('3 once Bob has answered, his line is gone; Alice, who has not answered, is still listed', !!l5 && l5.rows.length === 1 && l5.rows[0].id === 'a-1' && l5.offline.includes('Carol'), l5 ?? (await live()))

  // ===== 4. next to the name on his latest message: what he is doing now =====
  const chips = await waitFor(async () => { const c = await desk.ev(`[...document.querySelectorAll('main [id^="gm-"]')].map((m) => ({ text: m.innerText.split('\\n').slice(0, 6).join(' '), chip: m.querySelector('[data-live-status]') ? { kind: m.querySelector('[data-live-status]').getAttribute('data-live-status'), text: m.querySelector('[data-live-status]').innerText } : null }))`); return c.some((x) => x.chip) ? c : null }, 40, 250)
  const withChip = (chips ?? []).filter((x) => x.chip)
  check('4 the header of Bob\'s latest message carries his current state (and only that one message does: his earlier one has none)', withChip.length === 1 && withChip[0].text.includes('keep.txt 里只有一行') && withChip[0].chip.text.length > 0 && ['working', 'waiting', 'idle', 'command'].includes(withChip[0].chip.kind), chips)
  // Alice answers too: nothing is left to wait for except Carol
  await A.call('chat_send', { channel: CH, text: 'Alice 也看了，没别的' })
  const l6 = await waitFor(async () => { const v = await live(); return v && v.rows.length === 0 ? v : null }, 60, 250)
  check('4 when everyone who is online has answered, only the line about Carol being offline is left', !!l6 && l6.offline.includes('Carol'), l6 ?? (await live()))
  const chips2 = await desk.ev(`[...document.querySelectorAll('main [id^="gm-"]')].filter((m) => m.querySelector('[data-live-status]')).map((m) => m.innerText.split('\\n').slice(0, 6).join(' '))`)
  check('4 now Alice\'s and Bob\'s latest messages each carry a state', chips2.length === 2 && chips2.some((t) => t.includes('Alice 也看了')) && chips2.some((t) => t.includes('keep.txt 里只有一行')), chips2)
  await shot('chat-live-end.png')

  // ===== 4b. an AI that keeps working, call after call: its line stays between the calls (it used to come and go with every call, and the messages above jerked up and down) =====
  await desk.ev(`(() => { window.__samples = []; const last = () => { const m = [...document.querySelectorAll('main [id^="gm-"]')].pop(); return m ? Math.round(m.getBoundingClientRect().top) : null }; window.__sampler = setInterval(() => window.__samples.push({ row: !!document.querySelector('main [data-live-agent="a-2"]'), top: last() }), 50); return 1 })()`)
  for (let i = 0; i < 4; i++) { await B.call('read_file', { workspace: 'alpha-proj', path: 'keep.txt' }); await sleep(700) }
  await sleep(300)
  const between = await row('a-2')
  const samples = await desk.ev(`(clearInterval(window.__sampler), window.__samples)`)
  const firstOn = samples.findIndex((x) => x.row)
  const seen = firstOn < 0 ? [] : samples.slice(firstOn)
  const flips = seen.filter((x, i) => i > 0 && x.row !== seen[i - 1].row).length
  const tops = [...new Set(seen.slice(8).map((x) => x.top))]
  check('4b Bob has answered and keeps working (four calls, pauses between them): his line comes up once and stays the whole time, saying 刚做完 between the calls; the messages above do not jump', firstOn >= 0 && seen.length >= 30 && flips === 0 && tops.length === 1 && !!between && between.text.startsWith('刚做完') && between.spin === false, { firstOn, n: seen.length, flips, tops, between })
  await B.call('chat_send', { channel: CH, text: 'Bob：又看了几遍，还是那一行' })
  const l6b = await waitFor(async () => { const v = await live(); return v && !v.rows.some((r) => r.id === 'a-2') ? v : null }, 40, 150)
  check('4b as soon as he says something the line is gone', !!l6b, l6b ?? (await live()))

  // ===== 5. picked participants: only they are waited for =====
  await desk.ev(`window.bridge.setGroupChatParticipants(${J(CH)}, ['a-1'])`)
  await sleep(500)
  await say('只问 Alice 一个人')
  const l7 = await waitFor(async () => { const v = await live(); return v && v.rows.length === 1 ? v : null }, 40, 250)
  check('5 with only Alice picked to take part, only Alice is listed after you send; Bob and Carol are not mentioned', !!l7 && l7.rows[0].id === 'a-1' && l7.offline === '', l7 ?? (await live()))
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
