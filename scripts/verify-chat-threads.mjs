// Conversations (Codex-style): several chats per project - create, rename, archive / restore, delete; clear the main chat. Checked on an isolated instance.
// Usage (repo root, ELECTRON_RUN_AS_NODE unset): node scripts/verify-chat-threads.mjs <out dir> [screenshot dir]
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vct-'))
const wsA = path.join(base, 'alpha'), wsB = path.join(base, 'beta'), home = path.join(base, 'home'), data = path.join(base, 'data'), ud = path.join(base, 'ud')
for (const d of [wsA, wsB, home, data, ud]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(wsA, 'keep.txt'), 'line one\n')
const TOKENS = { a: 'wb_vct_aaaaaaaaaaaaaaaaaaaaaa', b: 'wb_vct_bbbbbbbbbbbbbbbbbbbbbb' }
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
  const st0 = await desk.ev(`window.bridge.getState().then((s) => ({ active: s.activeWorkspaceId, ws: s.workspaces.map((w) => [w.id, w.name, w.kind ?? null]), ch: s.chat.channels.map((c) => [c.id, c.name]) }))`)
  const ALPHA = st0.ws.find((w) => w[1] === 'alpha-proj')[0], BETA = st0.ws.find((w) => w[1] === 'beta-proj')[0]
  const CH = `ws:${ALPHA}`
  console.log(`alpha ${ALPHA} beta ${BETA} active ${st0.active}\n`)
  const active = () => desk.ev(`window.bridge.getState().then((s) => s.activeWorkspaceId)`)
  const side = () => desk.ev(`document.querySelector('aside')?.innerText ?? ''`)
  const mainText = () => desk.ev(`document.querySelector('main')?.innerText ?? ''`)
  // click the first visible row in a side panel that contains the label (other panels stay mounted but hidden, so skip those)
  const clickSide = (label, nth = 0) => desk.ev(`(() => { const rows = [...document.querySelectorAll('aside div.cursor-pointer')].filter((x) => x.offsetParent !== null && x.innerText.includes(${JSON.stringify(label)})); const r = rows[${nth}]; if (!r) return false; r.click(); return true })()`)

  const chans = () => desk.ev(`window.bridge.getState().then((s) => s.chat.channels.map((c) => ({ id: c.id, name: c.name, ws: c.workspaceId ?? null, title: c.thread?.title ?? null, archived: c.thread?.archived === true, lastTs: c.lastTs, floor: c.floor ?? 0, unread: c.unread })))`)
  const threadsOf = async (ws) => (await chans()).filter((c) => c.title !== null && c.ws === ws)
  const rowJs = (label) => `[...document.querySelectorAll('aside div.cursor-pointer')].filter((x) => x.offsetParent !== null && x.innerText.includes(${JSON.stringify(label)}))[0]`
  const ctxOn = (label) => desk.ev(`(() => { const r = ${rowJs(label)}; if (!r) return false; const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 5 })); return true })()`)
  const menuItems = () => desk.ev(`[...document.querySelectorAll('[role=menuitem]')].map((x) => x.innerText.trim())`)
  const clickMenu = (start) => desk.ev(`(() => { const m = [...document.querySelectorAll('[role=menuitem]')].find((x) => x.innerText.trim().startsWith(${JSON.stringify(start)})); if (!m) return false; m.click(); return true })()`)
  const typeInto = (aria, value) => desk.ev(`(() => { const i = document.querySelector('aside input[aria-label=${JSON.stringify(aria)}]'); if (!i) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`)
  const clickBtn = (title) => desk.ev(`(() => { const b = document.querySelector('aside button[title=${JSON.stringify(title)}]'); if (!b) return false; b.click(); return true })()`)
  const waitFor = async (fn, tries = 30, gap = 300) => { let v; for (let i = 0; i < tries; i++) { v = await fn(); if (v) return v; await sleep(gap) } return v }
  const idsOf = async (x) => { const r = await x.call('chat_channels'); return Array.isArray(r.data) ? r.data : [] }
  const findDeleted = () => { const out = []; const walk = (d, depth) => { if (depth > 4) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name === 'deleted') out.push(...fs.readdirSync(p).map((n) => path.join(p, n))); else walk(p, depth + 1) } } }; walk(data, 0); return out }

  // ===== 1. home sidebar: new conversation in a project that is not the active one =====
  await desk.ev(`(localStorage.setItem('wb.nav.section', 'overview'), localStorage.removeItem('wb.projects.expanded'), location.reload(), 1)`)
  let s = ''
  for (let i = 0; i < 60; i++) { await sleep(500); s = await side().catch(() => ''); if (typeof s === 'string' && s.includes('alpha-proj') && s.includes('最近')) break }
  check('1 the sidebar starts with 新会话 above 新任务', typeof s === 'string' && s.includes('新会话') && s.indexOf('新会话') < s.indexOf('新任务'), s)
  check('1 no conversations yet: only the built-in channels', (await chans()).every((c) => c.title === null), await chans())
  const b1 = await clickBtn('在「alpha-proj」里开一个会话')
  await sleep(300)
  const t1 = await typeInto('新会话的标题', '登录改版')
  const made = await waitFor(async () => (await threadsOf(ALPHA))[0])
  check('1 the hover button on the project row opens an input; Enter creates the conversation in alpha', b1 === true && t1 === true && made?.title === '登录改版' && made.id.startsWith(`ws:${ALPHA}.c_`) && made.name === 'alpha-proj / 登录改版', [b1, t1, made])
  const TH = made?.id
  s = await side()
  const proj = () => s.slice(s.indexOf('alpha-proj'), s.indexOf('beta-proj'))
  check('1 it is listed under alpha (after 群聊), not under beta', proj().includes('登录改版') && proj().indexOf('群聊') < proj().indexOf('登录改版') && !s.slice(s.indexOf('beta-proj'), s.indexOf('最近')).includes('登录改版'), s)
  let m = await waitFor(async () => { const x = await mainText(); return x.includes('alpha-proj / 登录改版') ? x : '' })
  check('1 it opens in the main area right away, with a composer', typeof m === 'string' && m.includes('alpha-proj / 登录改版') && m.includes('另开的会话') && (await desk.ev(`!!document.querySelector('main textarea')`)), String(m).slice(0, 300))
  check('1 the active workspace did not change (still beta)', (await active()) === BETA, await active())
  check('1 最近 lists the new conversation by its title, with the project name, although it has no message yet', /登录改版\s*alpha-proj/.test(s.slice(s.indexOf('最近'))), s.slice(s.indexOf('最近')))

  // ===== 2. the conversation is a real channel for the AIs =====
  const la = await idsOf(A)
  const mine = la.find((c) => c.id === TH)
  check('2 Alice sees it in chat_channels with its title; the main channel has no conversation field', mine?.conversation === '登录改版' && mine.workspace_id === ALPHA && la.find((c) => c.id === `ws:${ALPHA}`)?.conversation === undefined, la)
  const sa = await A.call('chat_send', { channel: TH, text: 'Alice 在会话里说的' })
  const sb = await B.call('chat_send', { channel: '登录改版', text: 'Bob 用标题发的' })
  await desk.ev(`window.bridge.sendGroupChat({ channel: ${JSON.stringify(TH)}, text: '用户在会话里说的' })`)
  const wb = await B.call('whoami')
  check('2 both AIs can post (by id and by title); the user\'s message reaches Bob as a notice naming the conversation', !sa.isError && !sb.isError && wb.notices.includes('用户在会话里说的') && wb.notices.includes('登录改版') && wb.notices.includes(`channel=${TH}`), [sa.raw, sb.raw, wb.notices])
  m = await waitFor(async () => { const x = await mainText(); return x.includes('Bob 用标题发的') && x.includes('用户在会话里说的') ? x : '' })
  check('2 all three messages show in the conversation', typeof m === 'string' && m.includes('Alice 在会话里说的'), String(m).slice(0, 400))
  const rm = await A.call('chat_read', { channel: `ws:${ALPHA}` })
  check('2 none of it leaked into the project\'s main chat', !rm.raw.includes('会话里说的') && !rm.raw.includes('Bob 用标题发的'), rm.raw.slice(0, 300))
  await shot('threads-open.png')

  // ===== 3. empty title: the button on a project row creates one there with a generated name =====
  // (the 新会话 row at the top now opens the 新会话 page; that is covered by verify-chat-page.mjs)
  await clickBtn('在「beta-proj」里开一个会话')
  await sleep(300)
  const t3 = await typeInto('新会话的标题', '')
  const auto = await waitFor(async () => (await threadsOf(BETA))[0])
  check('3 the 新会话 button on the beta row + Enter on an empty title: a conversation in beta named 新会话 <date>', t3 === true && /^新会话 \d{1,2}-\d{1,2} \d{2}:\d{2}$/.test(auto?.title ?? ''), [t3, auto])

  // ===== 4. rename from the context menu =====
  const c4 = await ctxOn('登录改版')
  await sleep(250)
  const items4 = await menuItems()
  check('4 right-click on a conversation: 改名 / 归档 / 删除会话', c4 === true && items4.some((x) => x.startsWith('改名')) && items4.some((x) => x.startsWith('归档')) && items4.some((x) => x.startsWith('删除会话')), items4)
  await clickMenu('改名')
  await sleep(300)
  const pre = await desk.ev(`document.querySelector('aside input[aria-label="会话的标题"]')?.value ?? null`)
  const t4 = await typeInto('会话的标题', '登录页第二版')
  const renamed = await waitFor(async () => (await threadsOf(ALPHA)).find((c) => c.title === '登录页第二版'))
  check('4 改名 turns the row into an input holding the old title; Enter saves', pre === '登录改版' && t4 === true && renamed?.id === TH, [pre, t4, await threadsOf(ALPHA)])
  check('4 Alice sees the new name; the id is unchanged', (await idsOf(A)).find((c) => c.id === TH)?.conversation === '登录页第二版')

  // ===== 5. archive / restore =====
  // section 3 left the beta conversation open; go back to the alpha one so the main area shows what gets archived
  await clickSide('登录页第二版')
  await waitFor(async () => (await mainText()).includes('alpha-proj / 登录页第二版'))
  await ctxOn('登录页第二版')
  await sleep(250)
  await clickMenu('归档')
  const arch = await waitFor(async () => (await threadsOf(ALPHA)).find((c) => c.id === TH && c.archived))
  await sleep(400)
  s = await side()
  check('5 归档: flagged in the state; the row leaves the project and a line 已归档的会话 1 个 appears', !!arch && !proj().includes('登录页第二版') && proj().includes('已归档的会话 1 个'), proj())
  check('5 it also leaves 最近', !s.slice(s.indexOf('最近')).includes('登录页第二版'), s.slice(s.indexOf('最近')))
  const sa5 = await A.call('chat_send', { channel: TH, text: '归档后还想说' })
  check('5 Alice no longer sees it and cannot post into it', !(await idsOf(A)).some((c) => c.id === TH) && sa5.isError && sa5.raw.includes('归档'), sa5.raw)
  m = await mainText()
  check('5 still open for the user: messages readable, composer replaced by the 已归档 bar', m.includes('Alice 在会话里说的') && m.includes('这个会话已归档，不能发言') && !(await desk.ev(`!!document.querySelector('main textarea')`)), m.slice(-300))
  await shot('threads-archived.png')
  await clickSide('已归档的会话 1 个')
  await sleep(300)
  s = await side()
  check('5 clicking the line lists the archived conversation again, marked 已归档', proj().includes('登录页第二版') && proj().includes('已归档'), proj())
  await desk.ev(`(() => { const b = [...document.querySelectorAll('main button')].find((x) => x.innerText.trim() === '恢复会话'); if (!b) return false; b.click(); return true })()`)
  const back = await waitFor(async () => (await threadsOf(ALPHA)).find((c) => c.id === TH && !c.archived))
  const sa6 = await A.call('chat_send', { channel: TH, text: '恢复后说的' })
  check('5 恢复会话 brings it back: Alice sees it and can post again; the composer is back', !!back && (await idsOf(A)).some((c) => c.id === TH) && !sa6.isError && (await waitFor(() => desk.ev(`!!document.querySelector('main textarea')`))), [back, sa6.raw])

  // ===== 6. delete (asks twice) =====
  await ctxOn('登录页第二版')
  await sleep(250)
  await clickMenu('删除会话')
  await sleep(300)
  const items6 = await menuItems()
  check('6 删除会话 asks once more first; nothing is deleted yet', items6.some((x) => x.includes('再点一次确认')) && (await threadsOf(ALPHA)).some((c) => c.id === TH), items6)
  await clickMenu('里面的消息一起删掉')
  const gone = await waitFor(async () => !(await chans()).some((c) => c.id === TH))
  await sleep(500)
  s = await side(); m = await mainText()
  check('6 confirmed: the conversation is gone from the state and the sidebar; the main area falls back to the overview', gone === true && !s.includes('登录页第二版') && !m.includes('Alice 在会话里说的'), [gone, s.slice(0, 300)])
  const sa7 = await A.call('chat_send', { channel: TH, text: '删掉后还想说' })
  check('6 Alice: not listed, posting fails, and the message did not land in the main chat', !(await idsOf(A)).some((c) => c.id === TH) && sa7.isError && !(await A.call('chat_read', { channel: `ws:${ALPHA}` })).raw.includes('删掉后还想说'), sa7.raw)
  const del = findDeleted()
  const delFiles = del.flatMap((d) => fs.readdirSync(d).map((n) => path.join(d, n)))
  check('6 the message file was moved to chat/deleted/, not destroyed', del.length === 1 && delFiles.some((f) => fs.readFileSync(f, 'utf8').includes('Alice 在会话里说的')), [del, delFiles])

  // ===== 7. the main chat cannot be deleted, only cleared =====
  await B.call('chat_send', { channel: `ws:${ALPHA}`, text: '主群聊里的旧消息' })
  await clickSide('群聊')
  m = await waitFor(async () => { const x = await mainText(); return x.includes('主群聊里的旧消息') ? x : '' })
  await ctxOn('群聊')
  await sleep(250)
  const items7 = await menuItems()
  check('7 right-click on 群聊: 改名 and 清空消息 only (no archive or delete)', typeof m === 'string' && m.includes('主群聊里的旧消息') && items7.length === 2 && items7[0].startsWith('改名') && items7[1].startsWith('清空消息'), items7)
  await clickMenu('清空消息')
  await sleep(300)
  await clickMenu('这里的消息全部清掉')
  const cleared = await waitFor(async () => (await chans()).find((c) => c.id === `ws:${ALPHA}` && c.floor > 0 && c.lastTs === 0))
  m = await waitFor(async () => { const x = await mainText(); return x.includes('主群聊里的旧消息') ? '' : x })
  check('7 清空消息 (asked twice): the channel stays, its messages are gone from the page', !!cleared && typeof m === 'string' && m.length > 0 && m.includes('alpha-proj'), [cleared, String(m).slice(0, 200)])
  const after = await desk.ev(`window.bridge.sendGroupChat({ channel: ${JSON.stringify(`ws:${ALPHA}`)}, text: '清空后的第一条' }).then((x) => x.seq)`)
  m = await waitFor(async () => { const x = await mainText(); return x.includes('清空后的第一条') ? x : '' })
  check('7 it keeps working: the next message shows, numbered after the cleared ones; Bob reads only the new one', typeof m === 'string' && m.includes('清空后的第一条') && after === cleared.floor + 1 && !(await B.call('chat_read', { channel: `ws:${ALPHA}` })).raw.includes('主群聊里的旧消息'), [after, cleared])
  check('7 the cleared file is in chat/deleted/ too', findDeleted().length === 2, findDeleted())

  // ===== 7b. the main chat of a project can be given a name (workbench only; the AIs keep seeing the project name) =====
  const mainOf = async () => (await desk.ev(`window.bridge.getState().then((s) => s.chat.channels.filter((c) => c.id === ${JSON.stringify(CH)}).map((c) => ({ name: c.name, title: c.title ?? null }))[0])`))
  const aliceBefore = (await idsOf(A)).find((c) => c.id === CH)
  await ctxOn('群聊')
  await sleep(250)
  await clickMenu('改名')
  await sleep(300)
  const pre7 = await desk.ev(`document.querySelector('aside input[aria-label="群聊的名字"]')?.value ?? null`)
  const t7 = await typeInto('群聊的名字', '日常闲聊')
  const named7 = await waitFor(async () => { const x = await mainOf(); return x?.title === '日常闲聊' ? x : null })
  s = await side()
  m = await waitFor(async () => { const x = await mainText(); return x.includes('alpha-proj / 日常闲聊') ? x : '' })
  check('7b 改名 on 群聊 turns the row into an empty input; Enter saves: the row and the page header show the new name, the channel name itself is unchanged', pre7 === '' && t7 === true && named7?.name === 'alpha-proj' && typeof s === 'string' && s.includes('日常闲聊') && typeof m === 'string' && m.includes('alpha-proj / 日常闲聊'), [pre7, t7, named7, String(m).slice(0, 120)])
  const aliceAfter = (await idsOf(A)).find((c) => c.id === CH)
  check('7b Alice still sees the channel exactly as before (name = project name) and can post to it by project name', JSON.stringify(aliceAfter) === JSON.stringify(aliceBefore) && aliceAfter?.name === 'alpha-proj' && (await A.call('chat_send', { channel: 'alpha-proj', text: '用项目名发' })).isError === false, [aliceBefore, aliceAfter])
  await shot('threads-main-renamed.png')
  await ctxOn('日常闲聊')
  await sleep(250)
  const items7b = await menuItems()
  await clickMenu('恢复叫')
  const reset7 = await waitFor(async () => { const x = await mainOf(); return x && x.title === null ? x : null })
  s = await side()
  check('7b a named main chat offers 改名 / 恢复叫「群聊」 / 清空消息; 恢复 puts 群聊 back', items7b.length === 3 && items7b[0].startsWith('改名') && items7b[1].startsWith('恢复叫') && items7b[2].startsWith('清空消息') && !!reset7 && typeof s === 'string' && !s.includes('日常闲聊'), [items7b, reset7])
  await ctxOn('大厅')
  await sleep(250)
  const lobbyItem = await desk.ev(`(() => { const x = document.querySelector('[role=menuitem]'); return x ? [x.innerText.trim(), x.getAttribute('aria-disabled')] : null })()`)
  check('7 the lobby offers only 清空消息 (greyed out while it is empty), no 改名', Array.isArray(lobbyItem) && lobbyItem[0].startsWith('清空消息') && lobbyItem[1] === 'true' && (await menuItems()).length === 1, lobbyItem)
  await desk.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })

  // ===== 8. the group page lists conversations too; reload keeps everything =====
  await desk.ev(`(localStorage.setItem('wb.nav.section', 'group'), location.reload(), 1)`)
  for (let i = 0; i < 40; i++) { await sleep(500); s = await side().catch(() => ''); if (typeof s === 'string' && s.includes('beta-proj /')) break }
  check('8 the group page lists the remaining conversation as 「beta-proj / 新会话 …」 and not the deleted one', typeof s === 'string' && s.includes(`beta-proj / ${auto?.title}`) && !s.includes('登录页第二版'), String(s).slice(0, 400))
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
