// Two ways of working in group chat (brainstorm / one lead), checked on an isolated instance of a built candidate.
// Usage (repo root, ELECTRON_RUN_AS_NODE unset): node scripts/verify-chat-modes.mjs <out dir> [screenshot dir]
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vcm-'))
const ws = path.join(base, 'ws'), home = path.join(base, 'home'), data = path.join(base, 'data'), ud = path.join(base, 'ud')
for (const d of [ws, home, data, ud]) fs.mkdirSync(d, { recursive: true })
const WSID = 'w_vcm00000'
/** the workspace channel id; read from chat_channels (the app may assign its own workspace id) */
let CH = `ws:${WSID}`
const TOKENS = { a: 'wb_vcm_aaaaaaaaaaaaaaaaaaaaaa', b: 'wb_vcm_bbbbbbbbbbbbbbbbbbbbbb', c: 'wb_vcm_cccccccccccccccccccccc' }
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
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ workspaces: [{ id: WSID, name: 'modes-demo', root: ws }], activeWorkspaceId: WSID, host: '127.0.0.1', port: PORT, roles: [],
    agents: [{ id: 'a-1', name: 'Alice', color: '#60a5fa', token: TOKENS.a, createdAt: Date.now() }, { id: 'a-2', name: 'Bob', color: '#f472b6', token: TOKENS.b, createdAt: Date.now() }, { id: 'a-3', name: 'Carol', color: '#34d399', token: TOKENS.c, createdAt: Date.now() }] }))
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
  const A = await connect(TOKENS.a, PORT), B = await connect(TOKENS.b, PORT), C = await connect(TOKENS.c, PORT)
  for (const x of [A, B, C]) await x.call('whoami')
  const chans = (await A.call('chat_channels')).data
  CH = chans.find((c) => c.name === 'modes-demo')?.id ?? CH
  console.log(`channel ${CH}\n`)
  const modeOf = async (x) => (await x.call('chat_channels')).data.find((c) => c.id === CH)
  const lead = () => desk.ev(`window.bridge.getState().then((s) => s.chat.channels.find((c) => c.id === ${JSON.stringify(CH)})?.leadId ?? null)`)
  const body = () => desk.ev(`document.body.innerText`)
  const clickSeg = (label) => desk.ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true })()`)

  // open the group chat page (it opens on the active workspace's channel)
  await desk.ev(`(localStorage.setItem('wb.nav.section', 'group'), location.reload(), 1)`)
  let page = ''
  for (let i = 0; i < 60; i++) { await sleep(500); page = await body().catch(() => ''); if (typeof page === 'string' && page.includes('灵感激荡')) break }

  // ===== 1. default: brainstorm =====
  check('1 group chat header has the switch 灵感激荡 / 分工明确', typeof page === 'string' && page.includes('灵感激荡') && page.includes('分工明确'), String(page).slice(0, 400))
  const m0 = await modeOf(B)
  check('1 default mode over MCP is brainstorm, no lead in state', m0?.mode === 'brainstorm' && (await lead()) === null, m0)
  const open0 = await B.call('chat_send', { channel: CH, text: '大家好，我是 Bob' })
  const c0 = await C.call('chat_read', { channel: CH })
  check('1 brainstorm: a message from Bob has no visibility limit and Carol reads it', !open0.isError && open0.data.only_visible_to === undefined && c0.data.messages.some((m) => m.text.includes('我是 Bob')), [open0.data, c0.data])
  await A.call('chat_read', { channel: CH })

  // ===== 2. switch to lead mode in the UI =====
  await clickSeg('分工明确')
  await sleep(400)
  const sel0 = await desk.ev(`(() => { const s = document.querySelector('select[aria-label="主脑"]'); return s ? { value: s.value, options: [...s.options].map((o) => o.innerText) } : null })()`)
  check('2 clicking 分工明确 shows the lead picker with the three AIs; nothing is switched yet', sel0 && sel0.value === '' && ['Alice', 'Bob', 'Carol'].every((n) => sel0.options.some((o) => o.startsWith(n))) && (await lead()) === null && (await modeOf(B)).mode === 'brainstorm', sel0)
  await desk.ev(`(() => { const s = document.querySelector('select[aria-label="主脑"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'a-1'); s.dispatchEvent(new Event('change', { bubbles: true })); return 1 })()`)
  await sleep(400)
  check('2 picking Alice in the dropdown does not switch yet (waits for 开始)', (await lead()) === null, await lead())
  await clickSeg('开始')
  await sleep(800)
  check('2 clicking 开始 sets Alice as lead; sub-agents were left at "all", so no list is stored', (await lead()) === 'a-1' && (await desk.ev(`window.bridge.getState().then((s) => s.chat.channels.find((c) => c.id === ${JSON.stringify(CH)})?.subIds ?? null)`)) === null, await lead())
  const na = await A.call('chat_channels'), nb = await B.call('chat_channels'), nc = await C.call('chat_channels')
  check('2 Alice is told she is the lead', na.notices.includes('[干活方式]') && na.notices.includes('你是主脑'), na.notices)
  check('2 Bob and Carol are told who the lead is and to talk only to her', [nb, nc].every((n) => n.notices.includes('主脑是 Alice') && n.notices.includes('只和主脑联系')), [nb.notices, nc.notices])
  const ma = na.data.find((c) => c.id === CH), mb = nb.data.find((c) => c.id === CH)
  check('2 chat_channels: mode=lead, lead=Alice, you_are_lead true for Alice and false for Bob; lobby stays brainstorm', ma?.mode === 'lead' && ma.lead === 'Alice' && ma.you_are_lead === true && mb?.you_are_lead === false && nb.data.find((c) => c.id === 'general')?.mode === 'brainstorm', [ma, mb])
  const who = await B.call('whoami'), team = await C.call('team_list')
  check('2 whoami.collaboration and team_list.lead_of show it', who.data.collaboration?.[0]?.lead === 'Alice' && team.data.find((m) => m.name === 'Alice')?.lead_of?.length === 1, [who.data.collaboration, team.data])
  page = await body()
  check('2 UI: member list marks Alice as 主脑, header explains the mode', page.includes('主脑') && page.includes('其他 AI 只和主脑 Alice 联系'), page.slice(0, 600))
  check('2 the mode is saved in chat/modes.json', JSON.parse(fs.readFileSync(path.join(data, 'chat', 'modes.json'), 'utf8'))[CH] === 'a-1', fs.readdirSync(path.join(data, 'chat')))

  // ===== 3. who sees what =====
  const s1 = await B.call('chat_send', { channel: CH, text: '@Carol 登录页做完了，你接着测' })
  check('3 Bob (not lead) sends: result says only the lead and the user see it; mention of Carol is dropped', !s1.isError && String(s1.data.note).includes('只有主脑 Alice 和用户能看到') && JSON.stringify(s1.data.mentions) === '["a-1"]', s1.data)
  const rc1 = await C.call('chat_read', { channel: CH })
  check('3 Carol gets nothing: no message, no notice', rc1.data.messages.length === 0 && rc1.notices === '', rc1)
  const ra1 = await A.call('chat_read', { channel: CH })
  check('3 Alice (lead) is notified and reads it', ra1.data.messages.some((m) => m.text.includes('登录页做完了')), ra1)
  const s2 = await A.call('chat_send', { channel: CH, text: '@Carol 你来测登录页' })
  const rb2 = await B.call('chat_read', { channel: CH }), rc2 = await C.call('chat_read', { channel: CH })
  check('3 lead @Carol: Carol reads it, Bob does not', !s2.isError && rc2.data.messages.some((m) => m.text.includes('你来测登录页')) && rb2.data.messages.length === 0, [rb2.data, rc2.data])
  const s3 = await A.call('chat_send', { channel: CH, text: '@所有人 三点前交' })
  const rb3 = await B.call('chat_read', { channel: CH }), rc3 = await C.call('chat_read', { channel: CH })
  check('3 lead @所有人: everyone reads it', !s3.isError && s3.data.only_visible_to === undefined && [rb3, rc3].every((r) => r.data.messages.some((m) => m.text.includes('三点前交'))), [rb3.data, rc3.data])
  await desk.ev(`window.bridge.sendGroupChat({ channel: ${JSON.stringify(CH)}, text: '把首页改成深色' }).then(() => 1)`)
  await sleep(500)
  const ua = await A.call('whoami'), ub = await B.call('whoami')
  check('3 the user writes without @: only the lead is notified (full text)', ua.notices.includes('把首页改成深色') && ub.notices === '', [ua.notices, ub.notices])
  const dm = await B.call('chat_send', { to: 'Carol', text: '悄悄说' })
  check('3 lobby is still brainstorm, so a private message Bob -> Carol is allowed there', !dm.isError, dm.raw)
  await sleep(600)
  page = await body()
  check('3 UI shows every message to the user, with scope labels (只发给 Alice / 只发给 Carol)', page.includes('登录页做完了') && page.includes('你来测登录页') && page.includes('把首页改成深色') && page.includes('只发给 Alice') && page.includes('只发给 Carol'), page.slice(0, 900))
  await shot('modes-lead.png')

  // ===== 4. handing out work =====
  const t1 = await B.call('task_create', { title: '测登录页', assigneeId: 'Carol' })
  check('4 Bob cannot assign a task to Carol (FORBIDDEN, names the lead)', t1.isError && t1.raw.includes('FORBIDDEN') && t1.raw.includes('主脑 Alice'), t1.raw)
  const t2 = await B.call('task_create', { title: '我自己的活', assigneeId: 'me' }), t3 = await B.call('task_create', { title: '没人负责的活' })
  check('4 Bob can still create a task for himself or an unassigned one', !t2.isError && !t3.isError, [t2.raw, t3.raw])
  const t4 = await B.call('task_assign', { id: t3.data.id, assigneeId: 'Carol' })
  check('4 Bob cannot task_assign to Carol either', t4.isError && t4.raw.includes('FORBIDDEN'), t4.raw)
  const t5 = await A.call('task_create', { title: '测登录页', assigneeId: 'Carol' }), t6 = await A.call('task_assign', { id: t3.data.id, assigneeId: 'Bob' })
  check('4 the lead can: task_create for Carol, task_assign to Bob', !t5.isError && !t6.isError, [t5.raw, t6.raw])
  for (const x of [A, B, C]) await x.call('chat_read', { channel: CH })

  // ===== 5. change the lead, then back to brainstorm =====
  await desk.ev(`window.bridge.setGroupChatLead(${JSON.stringify(CH)}, 'a-3').then(() => 1)`)
  await sleep(500)
  const nc5 = await C.call('chat_channels')
  check('5 changing the lead to Carol: she is told, and now reads what Bob sent to the old lead', (await lead()) === 'a-3' && nc5.notices.includes('你是主脑') && (await C.call('chat_read', { channel: CH, query: '登录页做完了' })).data.messages.length === 1, nc5.notices)
  const bad = await desk.ev(`window.bridge.setGroupChatLead(${JSON.stringify(CH)}, 'no-such-ai').then(() => 'ok', (e) => String(e.message ?? e))`)
  check('5 an unknown AI is refused and the lead does not change', typeof bad === 'string' && bad.includes('不存在') && (await lead()) === 'a-3', bad)
  for (const x of [A, B, C]) await x.call('whoami')
  await clickSeg('灵感激荡')
  await sleep(800)
  const nb6 = await B.call('chat_channels')
  check('5 clicking 灵感激荡: no lead in state, AIs are told, mode=brainstorm', (await lead()) === null && nb6.notices.includes('改回「灵感激荡」') && nb6.data.find((c) => c.id === CH)?.mode === 'brainstorm', nb6)
  const s6 = await B.call('chat_send', { channel: CH, text: '大家看看这个方案' })
  const ra6 = await A.call('chat_read', { channel: CH })
  check('5 back in brainstorm: Bob\'s message is for everyone; Alice (no longer lead) reads it', s6.data.only_visible_to === undefined && ra6.data.messages.some((m) => m.text.includes('大家看看这个方案')), [s6.data, ra6.data])
  const t7 = await B.call('task_create', { title: '再测一次', assigneeId: 'Carol' })
  check('5 back in brainstorm: Bob can assign to Carol again', !t7.isError, t7.raw)
  check('5 modes.json no longer lists the channel', JSON.parse(fs.readFileSync(path.join(data, 'chat', 'modes.json'), 'utf8'))[CH] === undefined)
  page = await body()
  check('5 UI: header back to the brainstorm text, old scoped messages keep their labels', !page.includes('其他 AI 只和主脑') && page.includes('只发给 Alice'), page.slice(0, 600))
  await shot('modes-brainstorm.png')
  for (const x of [A, B, C]) await x.close().catch(() => undefined)
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
