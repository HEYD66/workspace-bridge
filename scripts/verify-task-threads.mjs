// One task, one line: every task carries its own conversation; dispatch, delivery and review are recorded in it, and it is readable and writable from the task page.
// Usage (repo root, ELECTRON_RUN_AS_NODE unset): node scripts/verify-task-threads.mjs <out dir> [screenshot dir]
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vtt-'))
const wsA = path.join(base, 'alpha'), wsB = path.join(base, 'beta'), home = path.join(base, 'home'), data = path.join(base, 'data'), ud = path.join(base, 'ud')
for (const d of [wsA, wsB, home, data, ud]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(wsA, 'keep.txt'), 'line one\n')
const TOKENS = { a: 'wb_vtt_aaaaaaaaaaaaaaaaaaaaaa', b: 'wb_vtt_bbbbbbbbbbbbbbbbbbbbbb' }
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

  const st0 = await desk.ev(`window.bridge.getState().then((s) => ({ active: s.activeWorkspaceId, ws: s.workspaces.map((w) => [w.id, w.name]) }))`)
  const ALPHA = st0.ws.find((w) => w[1] === 'alpha-proj')[0], BETA = st0.ws.find((w) => w[1] === 'beta-proj')[0]
  console.log(`alpha ${ALPHA} beta ${BETA} active ${st0.active}\n`)
  const side = () => desk.ev(`document.querySelector('aside')?.innerText ?? ''`)
  const mainText = () => desk.ev(`document.querySelector('main')?.innerText ?? ''`)
  const waitFor = async (fn, tries = 30, gap = 300) => { let v; for (let i = 0; i < tries; i++) { v = await fn(); if (v) return v; await sleep(gap) } return v }
  const lines = () => desk.ev(`window.bridge.getState().then((s) => (s.chat.taskThreads ?? []).map((c) => ({ id: c.id, ws: c.workspaceId ?? null, title: c.thread?.title ?? null, task: c.task ?? null, unread: c.unread })))`)
  const chat = () => desk.ev(`window.bridge.getState().then((s) => ({ ids: s.chat.channels.map((c) => c.id), unread: s.chat.unread }))`)
  const msgs = (channel) => desk.ev(`window.bridge.listGroupChat({ channel: ${JSON.stringify(channel)}, limit: 200 }).then((l) => l.map((m) => ({ kind: m.kind ?? null, from: m.from.name, text: m.text })))`)
  const pane = () => desk.ev(`(() => { const p = [...document.querySelectorAll('main [data-task-thread-pane]')].find((x) => x.offsetParent !== null); return p ? { channel: p.getAttribute('data-task-thread-pane'), text: p.innerText, events: p.querySelectorAll('[data-chat-event]').length, cards: p.querySelectorAll('[data-change-card]').length, composer: !!p.querySelector('textarea') } : null })()`)
  const rowJs = (label) => `[...document.querySelectorAll('aside div.cursor-pointer')].filter((x) => x.offsetParent !== null && x.innerText.includes(${JSON.stringify(label)}))[0]`
  const clickSide = (label) => desk.ev(`(() => { const r = ${rowJs(label)}; if (!r) return false; r.scrollIntoView({ block: 'center' }); r.click(); return true })()`)
  const idsOf = async (x) => { const r = await x.call('chat_channels'); return Array.isArray(r.data) ? r.data : [] }
  const findDeleted = () => { const out = []; const walk = (d, depth) => { if (depth > 4) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name === 'deleted') out.push(...fs.readdirSync(p)); else walk(p, depth + 1) } } }; walk(data, 0); return out }

  // ===== 1. the user hands out a task in a project that is not the active one =====
  const t1 = await desk.ev(`window.bridge.createTask({ title: '修登录页', description: '把按钮对齐', assigneeId: 'a-1' }, ${JSON.stringify(ALPHA)}).then((t) => ({ id: t.id, ref: t.ref }))`)
  const l1 = await waitFor(async () => (await lines()).find((c) => c.task?.id === t1.id))
  check('1 the new task has its own line right away: id derived from the task, title「T-1 修登录页」, only Alice inside', l1?.id === `ws:${ALPHA}.c_t${String(t1.id).slice(2)}` && l1.title === 'T-1 修登录页' && JSON.stringify(l1.task?.memberIds) === '["a-1"]' && l1.ws === ALPHA, [t1, l1])
  const LINE = l1?.id
  const c1 = await chat()
  check('1 it is not in the channel list and adds nothing to the chat badge', !c1.ids.includes(LINE) && c1.unread === 0, c1)
  let ms = await msgs(LINE)
  check('1 the dispatch is recorded as an event from the user, with the description', ms.length === 1 && ms[0].kind === 'event' && ms[0].text === '创建了任务 T-1「修登录页」（指派给 Alice）\n\n把按钮对齐', ms)
  const la = await idsOf(A), lb = await idsOf(B)
  check('1 Alice sees the line in chat_channels (task T-1, nothing unread); Bob does not', la.find((c) => c.id === LINE)?.task === 'T-1' && la.find((c) => c.id === LINE)?.unread === 0 && !lb.some((c) => c.id === LINE), [la.map((c) => c.id), lb.map((c) => c.id)])
  const g1 = await A.call('task_get', { task: 'T-1', workspace: ALPHA })
  check('1 task_get gives Alice the chat_channel of the task', g1.data?.chat_channel === LINE, g1.raw.slice(0, 300))

  // ===== 2. Alice works: status, an edit, a question in the line, delivery =====
  const u1 = await A.call('task_update', { task: 'T-1', workspace: ALPHA, status: 'in_progress' })
  const e1 = await A.call('edit_file', { workspace: ALPHA, path: 'keep.txt', edits: [{ old_string: 'line one', new_string: 'line two' }] })
  const s1 = await A.call('chat_send', { channel: 'T-1', text: 'Alice 在任务的线里问：注册页要不要一起改？' })
  check('2 Alice can post into the line by task number', !u1.isError && !e1.isError && !s1.isError && s1.data?.channel === LINE, [u1.raw.slice(0, 200), e1.raw.slice(0, 200), s1.raw.slice(0, 200)])
  const l2 = await waitFor(async () => { const x = (await lines()).find((c) => c.id === LINE); return x?.unread === 1 ? x : null })
  const c2 = await chat()
  check('2 the user has 1 unread in the line (the message, not the events); the chat badge stays 0', l2?.unread === 1 && c2.unread === 0, [l2, c2])
  const fb = await B.call('chat_send', { channel: LINE, text: 'Bob 想插一句' })
  const rb = await B.call('chat_read', { channel: LINE })
  check('2 Bob is not on the task: he can neither post into the line nor read it', fb.isError && fb.raw.includes('CHANNEL_FORBIDDEN') && rb.isError, [fb.raw.slice(0, 200), rb.raw.slice(0, 200)])

  // ===== 3. the task page shows the line =====
  // alpha is not the active project, so it starts folded: unfold it
  await desk.ev(`(localStorage.setItem('wb.nav.section', 'overview'), localStorage.setItem('wb.projects.expanded', ${JSON.stringify(JSON.stringify([ALPHA]))}), location.reload(), 1)`)
  let s = ''
  for (let i = 0; i < 60; i++) { await sleep(500); s = await side().catch(() => ''); if (typeof s === 'string' && s.includes('alpha-proj') && s.includes('修登录页')) break }
  const alphaPart = String(s).slice(String(s).indexOf('alpha-proj'), String(s).indexOf('beta-proj'))
  check('3 the sidebar lists the task once (no extra conversation row for its line) with the unread count on it', alphaPart.split('修登录页').length === 2 && /修登录页\s*1/.test(alphaPart), alphaPart)
  const k3 = await clickSide('修登录页')
  const p3 = await waitFor(async () => { const p = await pane(); return p && p.text.includes('注册页要不要一起改') ? p : null })
  check('3 clicking the task opens its page with the line inside: events, Alice\'s message and a composer', k3 === true && p3?.channel === LINE && p3.events >= 2 && p3.text.includes('创建了任务 T-1') && p3.text.includes('把状态改成了「进行中」') && p3.composer === true, p3)
  check('3 Alice\'s message carries the change card for the file she edited', p3?.cards >= 1 && p3.text.includes('已编辑 1 个文件'), p3?.text?.slice(0, 600))
  const m3 = await mainText()
  check('3 the page says who is in the line', typeof m3 === 'string' && m3.includes('任务的线') && m3.includes('Alice 和你在里面'), String(m3).slice(0, 500))
  const l3 = await waitFor(async () => { const x = (await lines()).find((c) => c.id === LINE); return x?.unread === 0 ? x : null })
  check('3 opening it marks the line as read', l3?.unread === 0, l3)

  // ===== 4. the user answers in the line; Alice is told, Bob is not =====
  await A.call('whoami'); await B.call('whoami')
  await desk.ev(`window.bridge.sendGroupChat({ channel: ${JSON.stringify(LINE)}, text: '用户在线里回：注册页先别动' })`)
  const wa = await A.call('whoami'), wb = await B.call('whoami')
  check('4 Alice gets the user\'s words as a notice naming the task; Bob gets nothing', wa.notices.includes('注册页先别动') && wa.notices.includes('T-1 修登录页') && !wb.notices.includes('注册页先别动'), [wa.notices.slice(0, 300), wb.notices.slice(0, 200)])
  const d1 = await A.call('task_update', { task: 'T-1', workspace: ALPHA, status: 'done', result: '登录页按钮对齐了，只改了 keep.txt' })
  const p4 = await waitFor(async () => { const p = await pane(); return p && p.text.includes('只改了 keep.txt') ? p : null })
  check('4 the delivery shows up in the open page with its text, after the user\'s message', !d1.isError && p4 && p4.text.includes('注册页先别动') && p4.text.indexOf('注册页先别动') < p4.text.indexOf('只改了 keep.txt') && (p4.text.includes('做完了') || p4.text.includes('已完成')), p4?.text?.slice(0, 800))
  await shot('task-thread.png')
  const rd = await A.call('chat_read', { channel: LINE })
  check('4 Alice reads the line: events are marked as such', rd.raw.includes('"event": true') && rd.raw.includes('注册页先别动'), rd.raw.slice(0, 400))
  const main4 = await A.call('chat_read', { channel: `ws:${ALPHA}` })
  check('4 nothing of this went into the project\'s main chat', !main4.raw.includes('注册页') && !main4.raw.includes('创建了任务'), main4.raw.slice(0, 300))

  // ===== 5. one AI hands work to another: both are in the line; review is recorded =====
  const mk = await A.call('task_create', { workspace: ALPHA, title: '写接口文档', description: '覆盖全部接口', assigneeId: 'Bob' })
  const L2 = mk.data?.chat_channel
  const l5 = (await lines()).find((c) => c.id === L2)
  check('5 Alice creates a task for Bob: the result carries chat_channel; Alice and Bob are both inside', !mk.isError && typeof L2 === 'string' && JSON.stringify([...(l5?.task?.memberIds ?? [])].sort()) === '["a-1","a-2"]', [mk.raw.slice(0, 300), l5])
  const b1 = await B.call('task_update', { task: mk.data?.ref, workspace: ALPHA, status: 'review', result: '文档写好了，在 docs/api.md' })
  const say = await B.call('chat_send', { channel: L2, text: 'Bob：有两个接口没有示例' })
  const ra = await A.call('task_review', { task: mk.data?.ref, workspace: ALPHA, decision: 'reject', note: '把示例补上' })
  ms = await msgs(L2)
  check('5 creation, delivery, Bob\'s remark and the rejection are in the line in order', !b1.isError && !say.isError && !ra.isError && JSON.stringify(ms.map((m) => [m.from, m.kind, m.text.split('\n')[0]])) === JSON.stringify([['Alice', 'event', `创建了任务 ${mk.data?.ref}「写接口文档」（指派给 Bob）`], ['Bob', 'event', '做完了，提交审查'], ['Bob', null, 'Bob：有两个接口没有示例'], ['Alice', 'event', '审查没通过，退回重做']]), ms)
  const ua = (await idsOf(A)).find((c) => c.id === L2)
  check('5 for Alice only Bob\'s remark counts as unread, the events do not', ua?.unread === 1, ua)

  // ===== 6. the line follows the task: reassign, rename, delete =====
  await desk.ev(`window.bridge.assignTask(${JSON.stringify(t1.id)}, 'a-2', ${JSON.stringify(ALPHA)})`)
  await desk.ev(`window.bridge.editTask(${JSON.stringify(t1.id)}, { title: '修登录页和注册页' }, ${JSON.stringify(ALPHA)})`)
  const l6 = await waitFor(async () => { const x = (await lines()).find((c) => c.id === LINE); return x?.title === 'T-1 修登录页和注册页' ? x : null })
  const a6 = await idsOf(A), b6 = await idsOf(B)
  check('6 reassigned to Bob and renamed: the line is renamed, Bob is in and Alice is out', l6 && JSON.stringify(l6.task?.memberIds) === '["a-2"]' && !a6.some((c) => c.id === LINE) && b6.some((c) => c.id === LINE), [l6, a6.map((c) => c.id), b6.map((c) => c.id)])
  const r6 = await desk.ev(`Promise.all([window.bridge.renameGroupChatThread(${JSON.stringify(LINE)}, 'x').then(() => 'ok', (e) => String(e.message ?? e)), window.bridge.deleteGroupChannel(${JSON.stringify(LINE)}).then(() => 'ok', (e) => String(e.message ?? e))])`)
  check('6 the line cannot be renamed or deleted on its own', Array.isArray(r6) && r6.every((x) => x.includes('的线')), r6)
  await desk.ev(`window.bridge.deleteTask(${JSON.stringify(t1.id)}, ${JSON.stringify(ALPHA)})`)
  const gone = await waitFor(async () => !(await lines()).some((c) => c.id === LINE))
  const after = await B.call('chat_send', { channel: LINE, text: '任务删了还能发吗' })
  check('6 deleting the task removes its line; its messages are moved to chat/deleted/, the other line stays', gone === true && after.isError && findDeleted().some((d) => d.includes(`c_t${String(t1.id).slice(2)}`)) && (await lines()).some((c) => c.id === L2), [after.raw.slice(0, 200), findDeleted(), await lines()])

  // ===== 7. many conversations in one project: the sidebar folds them =====
  for (let i = 1; i <= 9; i++) await desk.ev(`window.bridge.newGroupChatThread(${JSON.stringify(ALPHA)}, ${JSON.stringify('批量会话 ' + i)})`)
  await desk.ev(`(localStorage.setItem('wb.nav.section', 'overview'), localStorage.setItem('wb.projects.expanded', ${JSON.stringify(JSON.stringify([ALPHA]))}), location.reload(), 1)`)
  for (let i = 0; i < 60; i++) { await sleep(500); s = await side().catch(() => ''); if (typeof s === 'string' && s.includes('alpha-proj') && s.includes('批量会话')) break }
  // rows under the project only: the rows in 最近 carry a second line (project name and time)
  const count = () => desk.ev(`[...document.querySelectorAll('aside div.cursor-pointer')].filter((x) => x.offsetParent !== null && /^批量会话 \\d+$/.test(x.innerText.trim())).length`)
  const n7 = await count()
  check('7 nine conversations: six are listed, the rest sit behind「还有 3 个会话」', n7 === 6 && String(s).includes('还有 3 个会话'), [n7, String(s).slice(0, 500)])
  await clickSide('还有 3 个会话')
  await sleep(400)
  s = await side()
  check('7 one click shows all nine, with「收起会话」to fold them again', (await count()) === 9 && String(s).includes('收起会话'), [await count(), String(s).slice(0, 500)])
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
