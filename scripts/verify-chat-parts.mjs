// Brainstorm mode with hand-picked participants (the user picks which AIs take part), checked on an isolated instance of a built candidate.
// Usage (repo root, ELECTRON_RUN_AS_NODE unset): node scripts/verify-chat-parts.mjs <out dir> [screenshot dir]
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vcpt-'))
const ws = path.join(base, 'ws'), home = path.join(base, 'home'), data = path.join(base, 'data'), ud = path.join(base, 'ud')
for (const d of [ws, home, data, ud]) fs.mkdirSync(d, { recursive: true })
const WSID = 'w_vcs00000'
/** the workspace channel id; read from chat_channels (the app may assign its own workspace id) */
let CH = `ws:${WSID}`
const TOKENS = { a: 'wb_vcs_aaaaaaaaaaaaaaaaaaaaaa', b: 'wb_vcs_bbbbbbbbbbbbbbbbbbbbbb', c: 'wb_vcs_cccccccccccccccccccccc', d: 'wb_vcs_dddddddddddddddddddddd' }
let appPid

async function connect(token, port) {
  const c = new Client({ name: 'vcpt', version: '1' })
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
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ workspaces: [{ id: WSID, name: 'parts-demo', root: ws }], activeWorkspaceId: WSID, host: '127.0.0.1', port: PORT, roles: [],
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
  CH = chans.find((c) => c.name === 'parts-demo')?.id ?? CH
  console.log(`channel ${CH}\n`)
  const modeOf = async (x) => (await x.call('chat_channels')).data.find((c) => c.id === CH)
  const lead = () => desk.ev(`window.bridge.getState().then((s) => s.chat.channels.find((c) => c.id === ${JSON.stringify(CH)})?.leadId ?? null)`)
  const body = () => desk.ev(`document.body.innerText`)
  const clickSeg = (label) => desk.ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true })()`)
  // open the group chat page (it opens on the active workspace's channel)
  await desk.ev(`(localStorage.setItem('wb.nav.section', 'group'), location.reload(), 1)`)
  let page = ''
  for (let i = 0; i < 60; i++) { await sleep(500); page = await body().catch(() => ''); if (typeof page === 'string' && page.includes('灵感激荡')) break }

  const J = JSON.stringify
  const info = () => desk.ev(`window.bridge.getState().then((s) => { const c = s.chat.channels.find((c) => c.id === ${J(CH)}); return { lead: c?.leadId ?? null, subs: c?.subIds ?? null, parts: c?.partIds ?? null } })`)
  const drain = async () => { for (const x of ALL) await x.call('whoami') }
  const picker = (attr = 'data-part-picker') => desk.ev(`(() => { const b = document.querySelector('[${attr}]'); return b ? { text: b.innerText.replace(/\\s+/g, ' ').trim(), disabled: b.disabled } : null })()`)
  const openPicker = (attr = 'data-part-picker') => desk.ev(`(() => { const b = document.querySelector('[${attr}]'); if (!b || b.disabled) return false; if (!document.querySelector('[data-sub-list]')) b.click(); return true })()`)
  const options = () => desk.ev(`[...document.querySelectorAll('[data-sub-option]')].map((o) => ({ id: o.getAttribute('data-sub-option'), on: o.getAttribute('aria-checked') === 'true', text: o.innerText.replace(/\\s+/g, ' ').trim() }))`)
  const toggle = (id) => desk.ev(`(() => { const o = document.querySelector('[data-sub-option="${id}"]'); if (!o) return false; o.click(); return true })()`)
  const listBtn = (label) => desk.ev(`(() => { const b = [...document.querySelectorAll('[data-sub-list] button')].find((x) => x.innerText.trim() === ${J(label)}); return b ? { disabled: b.disabled } : null })()`)
  const inList = (label) => desk.ev(`(() => { const b = [...document.querySelectorAll('[data-sub-list] button')].find((x) => x.innerText.trim() === ${J(label)}); if (!b || b.disabled) return false; b.click(); return true })()`)
  const pickLead = (id) => desk.ev(`(() => { const s = document.querySelector('select[aria-label="主脑"]'); if (!s) return false; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${J(id)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
  const texts = async (x) => ((await x.call('chat_read', { channel: CH, after: 0, limit: 50, mark_read: false })).data.messages ?? []).map((m) => m.text)
  const rightClick = async (name) => {
    const find = `[...document.querySelectorAll('div.cursor-pointer')].find((x) => x.offsetParent !== null && x.innerText.split('\\n').map((t) => t.trim()).includes(${J(name)}))`
    if (!(await desk.ev(`(() => { const r = ${find}; if (!r) return false; r.scrollIntoView({ block: 'nearest' }); return true })()`))) return false
    await sleep(500)
    const ok = await desk.ev(`(() => { const r = ${find}; if (!r) return false; const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(b.left + 60), clientY: Math.round(b.top + b.height / 2) })); return true })()`)
    await sleep(300)
    return ok
  }
  const menuItems = () => desk.ev(`[...document.querySelectorAll('[role=menuitem]')].map((x) => ({ text: x.innerText.trim(), off: x.getAttribute('aria-disabled') === 'true' }))`)
  const clickMenu = (start) => desk.ev(`(() => { const m = [...document.querySelectorAll('[role=menuitem]')].find((x) => x.innerText.trim().startsWith(${J(start)})); if (!m) return false; m.click(); return true })()`)
  const closeMenu = async () => { await desk.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await desk.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(200) }
  const teams = () => JSON.parse(fs.readFileSync(path.join(data, 'chat', 'teams.json'), 'utf8'))
  const modes = () => { try { return JSON.parse(fs.readFileSync(path.join(data, 'chat', 'modes.json'), 'utf8')) } catch { return {} } }

  // ===== 1. pick who takes part =====
  const p0 = await picker()
  check('1 brainstorm header has a 参与 picker that says all 4', p0 && !p0.disabled && p0.text.includes('参与') && p0.text.includes('全部 4') && (await picker('data-sub-picker')) === null, p0)
  await openPicker()
  await sleep(300)
  const o1 = await options()
  check('1 the picker lists all four AIs, ticked', o1.length === 4 && o1.every((o) => o.on) && ['Alice', 'Bob', 'Carol', 'Dave'].every((n) => o1.some((o) => o.text.includes(n))), o1)
  await inList('全不选')
  await sleep(200)
  const none = await listBtn('确定')
  check('1 with nobody ticked 确定 is off (at least one AI has to take part)', none && none.disabled === true, none)
  await toggle('a-1'); await toggle('a-2')
  await sleep(200)
  await shot('parts-picker.png')
  await drain()
  const ok1 = await inList('确定')
  await sleep(800)
  const i1 = await info()
  check('1 ticking Alice and Bob and confirming: participants = Alice, Bob; still brainstorm', ok1 && i1.lead === null && i1.subs === null && J(i1.parts) === '["a-1","a-2"]', i1)
  const na = await A.call('chat_channels'), nc = await C.call('chat_channels')
  check('1 Alice is told who takes part; Carol is told she was not picked', na.notices.includes('用户挑了参与讨论的 AI：Alice、Bob（有你）') && nc.notices.includes('没有选你'), [na.notices, nc.notices])
  const ca = na.data.find((c) => c.id === CH), cc0 = nc.data.find((c) => c.id === CH)
  check('1 chat_channels: mode brainstorm, participants Alice / Bob, you_participate true / false', ca?.mode === 'brainstorm' && J(ca.participants) === '["Alice","Bob"]' && ca.you_participate === true && cc0?.you_participate === false, [ca, cc0])
  check('1 teams.json holds the list; modes.json has no entry for the channel', J(teams()[CH]) === '["a-1","a-2"]' && modes()[CH] === undefined, [teams(), modes()])
  page = await body()
  const p1 = await picker()
  const faces = await desk.ev(`(() => { const f = document.querySelector('[data-chat-members]'); return f ? { n: f.children.length, title: f.getAttribute('title') } : null })()`)
  const chip = await desk.ev(`document.querySelector('[data-audience]')?.innerText.trim() ?? null`)
  check('1 UI: the picker says 2/4, the header says only Alice and Bob take part, the member list tags the others 未参与', p1.text.includes('2/4') && page.includes('只有 Alice、Bob 参与') && (page.match(/未参与/g) ?? []).length === 2, [p1, page.slice(0, 600)])
  check('1 UI: the header shows 2 faces; the line under the composer says 2 个 AI 参与', faces?.n === 2 && faces.title.includes('参与这个会话的 AI') && typeof chip === 'string' && chip.includes('2 个 AI 参与'), [faces, chip])
  await shot('parts-picked.png')

  // ===== 2. who reaches whom =====
  await drain()
  const s1 = await A.call('chat_send', { channel: CH, text: '@所有人 先定首页方案' })
  const rb = await texts(B), rc = await texts(C)
  const uc = (await C.call('chat_channels')).data.find((c) => c.id === CH)
  check('2 a participant\'s message: Bob reads it, Carol does not, and it is not in her unread count or notices', !s1.isError && s1.data.only_visible_to === undefined && rb.includes('@所有人 先定首页方案') && rc.length === 0 && uc.unread === 0 && (await C.call('whoami')).notices === '', [s1.data, rb, rc, uc])
  const s2 = await A.call('chat_send', { channel: CH, text: '@Bob @Dave 对一下接口' })
  check('2 a participant @-ing an outsider: the result says Dave did not get it; Dave has no notice', typeof s2.data.note === 'string' && s2.data.note.includes('Dave 没有参与这个频道的讨论') && (await D.call('whoami')).notices === '' && (await texts(D)).length === 0, s2.data)
  const s3 = await C.call('chat_send', { channel: CH, text: '@Alice 我也有个想法' })
  check('2 an outsider\'s message: only the user sees it, and she is told so', !s3.isError && J(s3.data.only_visible_to) === '["Carol","用户"]' && s3.data.note.includes('没有选你') && !(await texts(A)).includes('@Alice 我也有个想法') && (await A.call('whoami')).notices === '', s3.data)
  await desk.ev(`window.bridge.sendGroupChat({ channel: ${J(CH)}, text: '大家各说一个方案' }).then(() => 1)`)
  await desk.ev(`window.bridge.sendGroupChat({ channel: ${J(CH)}, text: '@Dave 这个仓库你先别动' }).then(() => 1)`)
  await sleep(400)
  const nd2 = await D.call('whoami'), rd2 = await texts(D), ra2 = await texts(A)
  check('2 the user: a plain message reaches the participants only; naming Dave reaches Dave (that one message)', ra2.includes('大家各说一个方案') && ra2.includes('@Dave 这个仓库你先别动') && nd2.notices.includes('这个仓库你先别动') && !nd2.notices.includes('大家各说一个方案') && J(rd2) === '["@Dave 这个仓库你先别动"]', [ra2, rd2, nd2.notices])
  await sleep(500)
  page = await body()
  check('2 the user sees everything in the window, Carol\'s message marked as only for you', ['先定首页方案', '对一下接口', '我也有个想法', '大家各说一个方案', '这个仓库你先别动'].every((t) => page.includes(t)) && page.includes('只发给你'), page.slice(0, 900))
  await shot('parts-messages.png')

  // ===== 3. add / remove from the member list =====
  const rc0 = await rightClick('Carol')
  const m3 = await menuItems()
  check('3 right-clicking Carol (not taking part) offers 加入讨论', rc0 && m3.some((x) => x.text.startsWith('加入讨论')) && !m3.some((x) => x.text.startsWith('移出讨论')), m3)
  await drain()
  await clickMenu('加入讨论')
  await sleep(800)
  const i3 = await info()
  const nc3 = await C.call('whoami')
  const rc3 = await texts(C)
  check('3 加入讨论: Carol is a participant, is told so, and can now read what was said before', J(i3.parts) === '["a-1","a-2","a-3"]' && nc3.notices.includes('用户把你加进了讨论') && rc3.includes('@所有人 先定首页方案') && rc3.includes('大家各说一个方案'), [i3, nc3.notices, rc3])
  check('3 Alice is told the list changed; Dave (still outside) hears nothing', (await A.call('whoami')).notices.includes('参与讨论的 AI 变了，现在是：Alice、Bob、Carol') && (await D.call('whoami')).notices === '')
  await rightClick('Bob')
  const m3b = await menuItems()
  check('3 right-clicking Bob (taking part) offers 移出讨论', m3b.some((x) => x.text.startsWith('移出讨论') && !x.off), m3b)
  await clickMenu('移出讨论')
  await sleep(800)
  const i3b = await info()
  check('3 移出讨论: Bob is out, is told, and no longer reads the discussion (his own message aside)', J(i3b.parts) === '["a-1","a-3"]' && (await B.call('whoami')).notices.includes('没有选你') && !(await texts(B)).includes('大家各说一个方案'), i3b)

  // ===== 4. the list follows the work mode =====
  await clickSeg('分工明确')
  await sleep(400)
  await pickLead('a-1')
  await sleep(400)
  const p4 = await picker('data-sub-picker')
  check('4 switching to 分工明确 with Alice as lead: the sub-agent picker starts from the participants (Carol only, 1/3)', p4 && p4.text.includes('1/3') && (await picker()) === null, p4)
  await clickSeg('开始')
  await sleep(800)
  const i4 = await info()
  check('4 开始: lead Alice, sub-agent Carol, no participant list', i4.lead === 'a-1' && J(i4.subs) === '["a-3"]' && i4.parts === null, i4)
  await drain()
  await clickSeg('灵感激荡')
  await sleep(800)
  const i4b = await info()
  const nb4 = await B.call('whoami'), nc4 = await C.call('whoami')
  check('4 back to 灵感激荡: the lead and the sub-agent are the participants; Carol is told who takes part, Bob that he is still out', i4b.lead === null && i4b.subs === null && J([...(i4b.parts ?? [])].sort()) === '["a-1","a-3"]' && nc4.notices.includes('参与讨论的还是用户挑的这几个') && nb4.notices.includes('没有你'), [i4b, nb4.notices, nc4.notices])

  // ===== 5. everyone again =====
  await openPicker()
  await sleep(300)
  await inList('全选')
  await sleep(200)
  await drain()
  await inList('确定')
  await sleep(800)
  const i5 = await info()
  const nd5 = await D.call('whoami')
  const rd5 = await texts(D)
  check('5 ticking everyone stores "not picky": no list, the picker says 全部 4', i5.parts === null && teams()[CH] === undefined && (await picker()).text.includes('全部 4'), [i5, teams()])
  check('5 Dave is told he is back and reads the whole discussion, except what Carol said to the user alone', nd5.notices.includes('你回到讨论里了') && rd5.includes('@所有人 先定首页方案') && rd5.includes('大家各说一个方案') && !rd5.includes('@Alice 我也有个想法'), [nd5.notices, rd5])
  page = await body()
  check('5 UI: no 未参与 tags, the composer says 全员可见', !page.includes('未参与') && ((await desk.ev(`document.querySelector('[data-audience]')?.innerText.trim() ?? ''`)) ?? '').includes('全员可见'), page.slice(0, 400))
  const bad = await desk.ev(`window.bridge.setGroupChatParticipants(${J(CH)}, []).then(() => 'ok', (e) => String(e.message ?? e))`)
  const bad2 = await desk.ev(`window.bridge.setGroupChatParticipants(${J(CH)}, ['no-such-ai']).then(() => 'ok', (e) => String(e.message ?? e))`)
  check('5 an empty list and an unknown AI are refused', typeof bad === 'string' && bad.includes('至少选一个') && typeof bad2 === 'string' && bad2.includes('不存在') && (await info()).parts === null, [bad, bad2])
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
