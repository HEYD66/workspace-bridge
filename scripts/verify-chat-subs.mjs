// Lead mode with hand-picked sub-agents (the user picks the lead AND the sub-agents), checked on an isolated instance of a built candidate.
// Usage (repo root, ELECTRON_RUN_AS_NODE unset): node scripts/verify-chat-subs.mjs <out dir> [screenshot dir]
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vcs-'))
const ws = path.join(base, 'ws'), home = path.join(base, 'home'), data = path.join(base, 'data'), ud = path.join(base, 'ud')
for (const d of [ws, home, data, ud]) fs.mkdirSync(d, { recursive: true })
const WSID = 'w_vcs00000'
/** the workspace channel id; read from chat_channels (the app may assign its own workspace id) */
let CH = `ws:${WSID}`
const TOKENS = { a: 'wb_vcs_aaaaaaaaaaaaaaaaaaaaaa', b: 'wb_vcs_bbbbbbbbbbbbbbbbbbbbbb', c: 'wb_vcs_cccccccccccccccccccccc', d: 'wb_vcs_dddddddddddddddddddddd' }
let appPid

async function connect(token, port) {
  const c = new Client({ name: 'vcs', version: '1' })
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
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ workspaces: [{ id: WSID, name: 'subs-demo', root: ws }], activeWorkspaceId: WSID, host: '127.0.0.1', port: PORT, roles: [],
    agents: [{ id: 'a-1', name: 'Alice', color: '#60a5fa', token: TOKENS.a, createdAt: Date.now() }, { id: 'a-2', name: 'Bob', color: '#f472b6', token: TOKENS.b, createdAt: Date.now() }, { id: 'a-3', name: 'Carol', color: '#34d399', token: TOKENS.c, createdAt: Date.now() }, { id: 'a-4', name: 'Dave', color: '#fbbf24', token: TOKENS.d, createdAt: Date.now() }] }))
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
  const A = await connect(TOKENS.a, PORT), B = await connect(TOKENS.b, PORT), C = await connect(TOKENS.c, PORT), D = await connect(TOKENS.d, PORT)
  const ALL = [A, B, C, D]
  for (const x of ALL) await x.call('whoami')
  const chans = (await A.call('chat_channels')).data
  CH = chans.find((c) => c.name === 'subs-demo')?.id ?? CH
  console.log(`channel ${CH}\n`)
  const modeOf = async (x) => (await x.call('chat_channels')).data.find((c) => c.id === CH)
  const lead = () => desk.ev(`window.bridge.getState().then((s) => s.chat.channels.find((c) => c.id === ${JSON.stringify(CH)})?.leadId ?? null)`)
  const body = () => desk.ev(`document.body.innerText`)
  const clickSeg = (label) => desk.ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true })()`)

  // open the group chat page (it opens on the active workspace's channel)
  await desk.ev(`(localStorage.setItem('wb.nav.section', 'group'), location.reload(), 1)`)
  let page = ''
  for (let i = 0; i < 60; i++) { await sleep(500); page = await body().catch(() => ''); if (typeof page === 'string' && page.includes('灵感激荡')) break }

  const info = () => desk.ev(`window.bridge.getState().then((s) => { const c = s.chat.channels.find((c) => c.id === ${JSON.stringify(CH)}); return { lead: c?.leadId ?? null, subs: c?.subIds ?? null } })`)
  const drain = async () => { for (const x of ALL) await x.call('whoami') }
  const pickLead = (id) => desk.ev(`(() => { const s = document.querySelector('select[aria-label="主脑"]'); if (!s) return false; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(id)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
  const picker = () => desk.ev(`(() => { const b = document.querySelector('[data-sub-picker]'); return b ? { text: b.innerText.replace(/\\s+/g, ' ').trim(), disabled: b.disabled } : null })()`)
  const openPicker = () => desk.ev(`(() => { const b = document.querySelector('[data-sub-picker]'); if (!b || b.disabled) return false; if (!document.querySelector('[data-sub-list]')) b.click(); return true })()`)
  const options = () => desk.ev(`[...document.querySelectorAll('[data-sub-option]')].map((o) => ({ id: o.getAttribute('data-sub-option'), on: o.getAttribute('aria-checked') === 'true', text: o.innerText.replace(/\\s+/g, ' ').trim() }))`)
  const toggle = (id) => desk.ev(`(() => { const o = document.querySelector('[data-sub-option="${id}"]'); if (!o) return false; o.click(); return true })()`)
  const inList = (label) => desk.ev(`(() => { const b = [...document.querySelectorAll('[data-sub-list] button')].find((x) => x.innerText.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true })()`)

  // ===== 1. pick the lead and the sub-agents before starting =====
  check('1 header has the switch', typeof page === 'string' && page.includes('灵感激荡') && page.includes('分工明确'), String(page).slice(0, 300))
  await clickSeg('分工明确')
  await sleep(400)
  const p0 = await picker()
  check('1 after clicking 分工明确: a 子代理 picker appears, disabled until a lead is chosen', p0 && p0.disabled === true && p0.text.includes('子代理'), p0)
  await pickLead('a-1')
  await sleep(400)
  const p1 = await picker()
  check('1 lead chosen (Alice): picker is enabled and says all 3 others; nothing is switched yet', p1 && !p1.disabled && p1.text.includes('全部 3') && (await info()).lead === null, [p1, await info()])
  await openPicker()
  await sleep(300)
  const o1 = await options()
  check('1 picker lists Bob, Carol, Dave (not the lead), all ticked', o1.length === 3 && o1.every((o) => o.on) && ['Bob', 'Carol', 'Dave'].every((n) => o1.some((o) => o.text.includes(n))) && !o1.some((o) => o.text.includes('Alice')), o1)
  await toggle('a-4')
  await sleep(200)
  await shot('subs-picker.png')
  const ok1 = await inList('选好了')
  await sleep(300)
  const p2 = await picker()
  check('1 unticking Dave and confirming: picker says 2/3; still nothing switched, no AI told', ok1 && p2.text.includes('2/3') && (await info()).lead === null && (await B.call('whoami')).notices === '', [ok1, p2, await info()])
  await clickSeg('开始')
  await sleep(800)
  const i1 = await info()
  check('1 clicking 开始: lead = Alice, sub-agents = Bob and Carol', i1.lead === 'a-1' && JSON.stringify(i1.subs) === '["a-2","a-3"]', i1)
  const na = await A.call('chat_channels'), nb = await B.call('chat_channels'), nd = await D.call('chat_channels')
  check('1 Alice is told she is the lead and who her sub-agents are', na.notices.includes('你是主脑') && na.notices.includes('子代理是：Bob、Carol'), na.notices)
  check('1 Bob (sub-agent) is told to talk only to the lead; Dave is told he was not picked', nb.notices.includes('只和主脑联系') && nd.notices.includes('这次分工没有选你') && !nd.notices.includes('只和主脑联系'), [nb.notices, nd.notices])
  const ca = na.data.find((c) => c.id === CH), cb = nb.data.find((c) => c.id === CH), cd = nd.data.find((c) => c.id === CH)
  check('1 chat_channels: your_role lead / sub / none, subs = Bob, Carol', ca?.your_role === 'lead' && cb?.your_role === 'sub' && cd?.your_role === 'none' && JSON.stringify(ca.subs) === '["Bob","Carol"]', [ca, cb, cd])
  check('1 teams.json holds the list; modes.json keeps its old format', JSON.stringify(JSON.parse(fs.readFileSync(path.join(data, 'chat', 'teams.json'), 'utf8'))[CH]) === '["a-2","a-3"]' && JSON.parse(fs.readFileSync(path.join(data, 'chat', 'modes.json'), 'utf8'))[CH] === 'a-1')
  page = await body()
  check('1 UI: header names the sub-agents; member list tags 主脑 / 子代理 / 未参与', page.includes('子代理 Bob、Carol') && page.includes('未参与') && page.includes('主脑'), page.slice(0, 700))

  // ===== 2. who reaches whom =====
  await drain()
  const s1 = await D.call('chat_send', { channel: CH, text: '@Alice 我也可以帮忙' })
  const ra1 = await A.call('chat_read', { channel: CH })
  check('2 Dave (not picked) sends: only the user sees it, he is told so; the lead gets nothing', !s1.isError && String(s1.data.note).includes('这次分工没有选你') && JSON.stringify(s1.data.only_visible_to) === '["Dave","用户"]' && ra1.data.messages.length === 0 && ra1.notices === '', [s1.data, ra1])
  const s2 = await A.call('chat_send', { channel: CH, text: '@Bob @Dave 对一下接口' })
  const rd2 = await D.call('chat_read', { channel: CH }), rb2 = await B.call('chat_read', { channel: CH })
  check('2 lead @Bob @Dave: Bob reads it, Dave does not, the lead is told Dave was not reached', String(s2.data.note).includes('Dave 不在这个频道的子代理名单里') && rb2.data.messages.some((m) => m.text.includes('对一下接口')) && rd2.data.messages.length === 0, [s2.data, rd2.data])
  const s3 = await A.call('chat_send', { channel: CH, text: '@所有人 三点前交' })
  const rc3 = await C.call('chat_read', { channel: CH }), rd3 = await D.call('chat_read', { channel: CH })
  check('2 lead @所有人: reaches the sub-agents (Carol), not Dave', JSON.stringify(s3.data.only_visible_to) === '["Alice","Bob","Carol","用户"]' && rc3.data.messages.some((m) => m.text.includes('三点前交')) && rd3.data.messages.length === 0 && rd3.notices === '', [s3.data, rc3.data, rd3])
  const s4 = await B.call('chat_send', { channel: CH, text: '接口对完了' })
  check('2 Bob (sub-agent) sends: only the lead and the user', String(s4.data.note).includes('只有主脑 Alice 和用户能看到'), s4.data)
  await desk.ev(`window.bridge.sendGroupChat({ channel: ${JSON.stringify(CH)}, text: '@Dave 这个仓库你先别动' }).then(() => 1)`)
  await sleep(400)
  const nud = await D.call('whoami'), nuc = await C.call('whoami')
  check('2 the user @Dave: Dave is notified even though he is not picked; Carol is not', nud.notices.includes('这个仓库你先别动') && nuc.notices === '', [nud.notices, nuc.notices])
  const t1 = await A.call('task_create', { title: '测登录页', assigneeId: 'Dave' })
  const t2 = await A.call('task_create', { title: '测登录页', assigneeId: 'Bob' })
  check('2 the lead cannot assign a task to Dave, can to Bob', t1.isError && t1.raw.includes('FORBIDDEN') && !t2.isError, [t1.raw, t2.raw])
  await sleep(500)
  page = await body()
  check('2 UI: Dave\'s message is marked as sent only to the user', page.includes('我也可以帮忙') && page.includes('只发给你'), page.slice(0, 900))
  await shot('subs-picked.png')

  // ===== 3. change the list while running =====
  await drain()
  await openPicker()
  await sleep(300)
  const o3 = await options()
  check('3 picker reopened: Bob and Carol ticked, Dave not', o3.find((o) => o.id === 'a-2')?.on && o3.find((o) => o.id === 'a-3')?.on && o3.find((o) => o.id === 'a-4')?.on === false, o3)
  await toggle('a-3')
  await toggle('a-4')
  await sleep(200)
  const ok3 = await inList('确定')
  await sleep(800)
  const i3 = await info()
  check('3 swap Carol for Dave and confirm: sub-agents = Bob, Dave', ok3 && i3.lead === 'a-1' && JSON.stringify(i3.subs) === '["a-2","a-4"]', i3)
  const n3a = await A.call('whoami'), n3b = await B.call('whoami'), n3c = await C.call('whoami'), n3d = await D.call('whoami')
  check('3 only the lead, Carol (removed) and Dave (added) are told; Bob is not disturbed', n3a.notices.includes('子代理名单变了') && n3a.notices.includes('Bob、Dave') && n3b.notices === '' && n3c.notices.includes('这次分工没有选你') && n3d.notices.includes('用户把你加进了子代理'), [n3a.notices, n3b.notices, n3c.notices, n3d.notices])
  const t3 = await A.call('task_create', { title: '测注册页', assigneeId: 'Dave' })
  check('3 the lead can now assign to Dave', !t3.isError, t3.raw)
  await openPicker()
  await sleep(300)
  await inList('全选')
  await sleep(200)
  await inList('确定')
  await sleep(800)
  const i3b = await info()
  check('3 ticking everyone stores "not picky" (no list): later AIs count too', i3b.lead === 'a-1' && i3b.subs === null && (await picker()).text.includes('全部 3'), [i3b, await picker()])

  // ===== 4. change the lead with a list; back to brainstorm =====
  await desk.ev(`window.bridge.setGroupChatSubs(${JSON.stringify(CH)}, ['a-4']).then(() => 1)`)
  await sleep(300)
  await pickLead('a-2')
  await sleep(800)
  const i4 = await info()
  check('4 changing the lead to Bob (dropdown, immediate): the old lead Alice stays in the team as a sub-agent', i4.lead === 'a-2' && JSON.stringify([...(i4.subs ?? [])].sort()) === '["a-1","a-4"]', i4)
  const bad = await desk.ev(`window.bridge.setGroupChatSubs(${JSON.stringify(CH)}, ['no-such-ai']).then(() => 'ok', (e) => String(e.message ?? e))`)
  check('4 an unknown AI in the list is refused, nothing changes', typeof bad === 'string' && bad.includes('不存在') && JSON.stringify([...((await info()).subs ?? [])].sort()) === '["a-1","a-4"]', bad)
  await drain()
  await clickSeg('灵感激荡')
  await sleep(800)
  const i5 = await info()
  const n5 = await C.call('chat_channels')
  const parts5 = await desk.ev(`window.bridge.getState().then((s) => s.chat.channels.find((c) => c.id === ${JSON.stringify(CH)})?.partIds ?? null)`)
  check('4 clicking 灵感激荡: no lead, sub-agent picker gone; the lead and the sub-agents stay on as the participants, and Carol (still out) is told', i5.lead === null && i5.subs === null && JSON.stringify([...(parts5 ?? [])].sort()) === '["a-1","a-2","a-4"]' && n5.notices.includes('改回「灵感激荡」') && n5.notices.includes('没有你') && (await picker()) === null, [i5, parts5, n5.notices])
  await desk.ev(`window.bridge.setGroupChatParticipants(${JSON.stringify(CH)}, null).then(() => 1)`)
  await sleep(300)
  check('4 not picking any more: no list left', JSON.parse(fs.readFileSync(path.join(data, 'chat', 'teams.json'), 'utf8'))[CH] === undefined)
  const s5 = await C.call('chat_send', { channel: CH, text: '大家看看这个方案' })
  const rd5 = await D.call('chat_read', { channel: CH })
  check('4 back in brainstorm: Carol\'s message is for everyone', s5.data.only_visible_to === undefined && rd5.data.messages.some((m) => m.text.includes('大家看看这个方案')), [s5.data, rd5.data])
  const bad2 = await desk.ev(`window.bridge.setGroupChatSubs(${JSON.stringify(CH)}, ['a-4']).then(() => 'ok', (e) => String(e.message ?? e))`)
  check('4 picking sub-agents in brainstorm is refused', typeof bad2 === 'string' && bad2.includes('先选主脑'), bad2)
  for (const x of ALL) await x.close().catch(() => undefined)
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
