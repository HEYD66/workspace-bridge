// Codex-style home: project list with chats and tasks, 'recent', and change cards in group chat. Checked on an isolated instance.
// Usage (repo root, ELECTRON_RUN_AS_NODE unset): node scripts/verify-home-projects.mjs <out dir> [screenshot dir]
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vhp-'))
const wsA = path.join(base, 'alpha'), wsB = path.join(base, 'beta'), home = path.join(base, 'home'), data = path.join(base, 'data'), ud = path.join(base, 'ud')
for (const d of [wsA, wsB, home, data, ud]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(wsA, 'keep.txt'), 'line one\n')
const TOKENS = { a: 'wb_vhp_aaaaaaaaaaaaaaaaaaaaaa', b: 'wb_vhp_bbbbbbbbbbbbbbbbbbbbbb' }
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

  // ----- seed: Bob works in alpha (not the active workspace) -----
  const w1 = await B.call('write_file', { workspace: 'alpha-proj', path: 'src/new-a.ts', content: 'export const a = 1\nexport const b = 2\nexport const c = 3\n' })
  const w2 = await B.call('edit_file', { workspace: 'alpha-proj', path: 'keep.txt', edits: [{ old_string: 'line one', new_string: 'line 1\nline two\nline three' }] })
  check('seed: Bob writes one new file and edits one in alpha', !w1.isError && !w2.isError, [w1.raw, w2.raw])
  const m1 = await B.call('chat_send', { channel: CH, text: '登录模块写好了，两处改动' })
  const t1 = await A.call('task_create', { workspace: 'alpha-proj', title: '做登录页', assigneeId: 'Bob' })
  const t2 = await A.call('task_create', { workspace: 'beta-proj', title: '整理文档' })
  check('seed: a chat message in alpha, one task in alpha, one in beta', !m1.isError && !t1.isError && !t2.isError, [m1.raw, t1.raw, t2.raw])
  await sleep(600)

  // ===== 1. home sidebar =====
  await desk.ev(`(localStorage.setItem('wb.nav.section', 'overview'), localStorage.removeItem('wb.projects.expanded'), location.reload(), 1)`)
  let s = ''
  for (let i = 0; i < 60; i++) { await sleep(500); s = await side().catch(() => ''); if (typeof s === 'string' && s.includes('alpha-proj') && s.includes('最近')) break }
  check('1 home sidebar lists 新会话 / 新任务 / 大厅 / 概览, every project (both folders and 整台电脑) and 最近', ['新会话', '新任务', '大厅', '概览', '项目', 'alpha-proj', 'beta-proj', '整台电脑', '最近'].every((x) => s.includes(x)), s)
  check('1 the active workspace is marked 当前 on beta only', /beta-proj\s*当前/.test(s) && !/alpha-proj\s*当前/.test(s), s)
  check('1 最近 lists the tasks and the alpha chat across projects, with project names', s.includes('做登录页') && s.includes('整理文档') && /群聊\s*alpha-proj/.test(s.slice(s.indexOf('最近'))), s.slice(s.indexOf('最近')))
  const m0 = await mainText()
  check('1 with nothing selected the main area is the 新会话 page for the active workspace', typeof m0 === 'string' && m0.includes('想让 AI 们在') && m0.includes('beta-proj') && !m0.includes('登录模块写好了'), String(m0).slice(0, 300))

  // ===== 2. expand a project, open its chat: sidebar stays, change card shows =====
  await clickSide('alpha-proj')
  await sleep(400)
  s = await side()
  const proj = s.slice(s.indexOf('alpha-proj'), s.indexOf('beta-proj'))
  check('2 clicking the project row expands it: its 群聊 and its open task under it; remembered in localStorage', proj.includes('群聊') && proj.includes('做登录页') && !proj.includes('整理文档') && String(await desk.ev(`localStorage.getItem('wb.projects.expanded')`)).includes(ALPHA), proj)
  await clickSide('群聊')
  let m = ''
  for (let i = 0; i < 20; i++) { await sleep(400); m = await mainText(); if (m.includes('登录模块写好了') && m.includes('已编辑')) break }
  check('2 clicking 群聊 opens the alpha channel in the main area', m.includes('登录模块写好了') && m.includes('alpha-proj'), m.slice(0, 400))
  check('2 the project list is still there next to the conversation', (await side()).includes('项目') && (await side()).includes('beta-proj'))
  const card = await desk.ev(`document.querySelector('[data-change-card]')?.innerText ?? null`)
  check('2 change card under Bob\'s message: 已编辑 2 个文件, +6 -1, both paths, 撤销 and 查看变更', typeof card === 'string' && card.includes('已编辑 2 个文件') && card.includes('+6') && card.includes('-1') && card.includes('src/new-a.ts') && card.includes('keep.txt') && card.includes('新建') && card.includes('撤销') && card.includes('查看变更'), card)
  check('2 none of this changed the active workspace (still beta)', (await active()) === BETA, await active())
  await shot('home-chat-card.png')

  // ===== 3. a task as a thread; new task from the sidebar =====
  await clickSide('做登录页')
  await sleep(700)
  m = await mainText()
  const titleOf = () => desk.ev(`[...document.querySelectorAll('main input, main textarea')].map((i) => i.value).join(' | ')`)
  check('3 clicking the task under the project opens its detail in the main area, labelled with the project (not 整台电脑)', (await titleOf()).includes('做登录页') && m.includes('alpha-proj') && !m.includes('整台电脑') && !m.includes('登录模块写好了'), [await titleOf(), m.slice(0, 300)])
  await desk.ev(`(() => { const b = document.querySelector('aside button[title="在「alpha-proj」里建一个任务"]'); if (!b) return false; b.click(); return true })()`)
  await sleep(300)
  const typed = await desk.ev(`(() => { const i = document.querySelector('aside input[aria-label="新任务的标题"]'); if (!i) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '从首页建的任务'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`)
  await sleep(900)
  const tl = await A.call('task_list', { workspace: 'alpha-proj' })
  const tb = await A.call('task_list', { workspace: 'beta-proj' })
  check('3 the + on the project row creates the task in alpha (not in the active workspace beta)', typed === true && tl.raw.includes('从首页建的任务') && !tb.raw.includes('从首页建的任务'), [typed, tl.raw.slice(0, 300)])
  m = await mainText(); s = await side()
  check('3 the new task opens in the main area and appears under the project', (await titleOf()).includes('从首页建的任务') && s.slice(s.indexOf('alpha-proj'), s.indexOf('beta-proj')).includes('从首页建的任务'), m.slice(0, 200))
  await shot('home-task.png')

  // ===== 4. undo from the card =====
  await clickSide('群聊')
  for (let i = 0; i < 20; i++) { await sleep(300); if (await desk.ev(`!!document.querySelector('[data-change-card]')`)) break }
  const click = (label) => desk.ev(`(() => { const b = [...document.querySelectorAll('[data-change-card] button')].find((x) => x.innerText.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true })()`)
  const c1 = await click('撤销')
  await sleep(300)
  check('4 撤销 asks once more before doing anything (files untouched)', c1 === true && fs.existsSync(path.join(wsA, 'src', 'new-a.ts')) && (await desk.ev(`document.querySelector('[data-change-card]').innerText`)).includes('确认撤销这些改动'))
  const c2 = await click('确认撤销这些改动')
  let cardAfter = ''
  for (let i = 0; i < 20; i++) { await sleep(400); cardAfter = await desk.ev(`document.querySelector('[data-change-card]')?.innerText ?? ''`); if (cardAfter.includes('已撤销')) break }
  const keep = fs.readFileSync(path.join(wsA, 'keep.txt'), 'utf8')
  check('4 confirmed: the new file is gone, the edited file is back to its old content', c2 === true && !fs.existsSync(path.join(wsA, 'src', 'new-a.ts')) && keep.replace(/\r/g, '') === 'line one\n', { exists: fs.existsSync(path.join(wsA, 'src', 'new-a.ts')), keep })
  check('4 the card now says 已撤销 and no longer offers 撤销', cardAfter.includes('已撤销') && !(await desk.ev(`[...document.querySelectorAll('[data-change-card] button')].some((x) => x.innerText.trim() === '撤销')`)), cardAfter)

  // ===== 5. 查看变更 opens the right panel on this change; the full changes page is one more click =====
  await click('查看变更')
  let pin = ''
  for (let i = 0; i < 25; i++) { await sleep(300); pin = await desk.ev(`document.querySelector('[data-right-pinned]')?.innerText ?? ''`); if (pin.includes('keep.txt')) break }
  let sec = await desk.ev(`localStorage.getItem('wb.nav.section')`)
  check('5 查看变更 shows this change in the right panel; the conversation stays open and the active workspace does not change', sec !== 'changes' && (await active()) === BETA && pin.includes('keep.txt') && pin.includes('new-a.ts') && pin.includes('已撤销') && (await mainText()).includes('登录模块写好了'), [sec, await active(), pin.slice(0, 300)])
  await desk.ev(`(() => { const b = [...document.querySelectorAll('[data-right-pinned] button')].find((x) => x.innerText.trim() === '在改动页打开'); if (!b) return false; b.click(); return true })()`)
  for (let i = 0; i < 20; i++) { await sleep(300); sec = await desk.ev(`localStorage.getItem('wb.nav.section')`); if (sec === 'changes') break }
  await sleep(800)
  m = await mainText()
  check('5 在改动页打开 switches to alpha (an explicit action) and opens the changes page on that step', sec === 'changes' && (await active()) === ALPHA && (m.includes('keep.txt') || m.includes('new-a.ts')), [sec, await active(), m.slice(0, 300)])

  // ===== 5b. 留痕: the changes page lists who changed which files, grouped by task =====
  {
    const opened = await desk.ev(`(async () => { const b = document.querySelector('[data-trail-open]'); if (!b) return null; b.click(); for (let i = 0; i < 30; i++) { await new Promise((z) => setTimeout(z, 200)); if (document.querySelector('[data-trail-entry]')) break } const d = document.querySelector('[data-trail-dialog]'); return d ? { text: d.innerText, entries: [...d.querySelectorAll('[data-trail-entry]')].map((e) => e.getAttribute('data-trail-entry')), files: [...d.querySelectorAll('[data-trail-file]')].map((e) => e.getAttribute('data-trail-file')), copy: !!d.querySelector('[data-trail-copy]') } : null })()`)
    check('5b the 留痕 button on the changes page opens the list: who changed which files, taken from the change records (no marks in the code), with a copy-as-text button', opened && opened.text.includes('留痕清单') && opened.text.includes('Bob') && opened.entries.length >= 1 && opened.files.length >= 1 && opened.files.some((f) => f.includes('keep.txt') || f.includes('new-a.ts')) && opened.copy === true, opened)
    const closed = await desk.ev(`(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await new Promise((z) => setTimeout(z, 300)); return !document.querySelector('[data-trail-dialog]') })()`)
    check('5b Esc closes it', closed === true, closed)
  }

  // ===== 5c. memory page: older versions can be restored, archived memories move to their own tab =====
  {
    const s1 = await B.call('memory_save', { workspace: 'alpha-proj', title: '提交信息的写法', content: '提交信息用中文，第一行不超过五十个字，写清楚改了什么和为什么改' })
    const s3 = await A.call('memory_save', { workspace: 'alpha-proj', title: '提交信息怎么写', content: '提交信息用中文，第一行不超过五十个字，写清楚改了什么和为什么改' })
    const s2 = await B.call('memory_save', { workspace: 'alpha-proj', id: s1.data?.id, title: '提交信息的写法', content: '第二版：Bob 把别的内容写进来了' })
    await A.call('memory_read', { workspace: 'alpha-proj', id: s1.data?.id })
    check('5c seed: a memory saved and then changed keeps its first version; saving a near-copy is allowed but comes back with a hint naming the similar one; the source is filled in automatically', !s1.isError && s2.data?.version === 2 && JSON.stringify(s2.data?.older_versions) === '[1]' && s3.data?.similar?.[0]?.id === s1.data?.id && /Bob.*工作台自动填/.test(s1.data?.source ?? ''), [s1.raw.slice(0, 200), s2.raw.slice(0, 200), s3.raw.slice(0, 300)])
    const MID = s1.data?.id
    await desk.ev(`(localStorage.setItem('wb.nav.section', 'memory'), location.reload(), 1)`)
    let row = false
    for (let i = 0; i < 40 && !row; i++) { await sleep(500); row = await desk.ev(`!!document.querySelector('[data-memory-row="${MID}"]')`).catch(() => false) }
    const page = await desk.ev(`(async () => { const wait = (ms) => new Promise((z) => setTimeout(z, ms)); const r = document.querySelector('[data-memory-row="${MID}"]'); if (!r) return null; const rowText = r.innerText; r.click(); for (let i = 0; i < 20 && !document.querySelector('[data-memory-history]'); i++) await wait(200); const h = document.querySelector('[data-memory-history]'); return { rowText, history: h?.innerText ?? null, revs: [...document.querySelectorAll('[data-memory-rev]')].map((x) => x.getAttribute('data-memory-rev')), body: document.querySelector('main textarea')?.value ?? null, usage: document.querySelector('[data-memory-usage]')?.innerText ?? null } })()`)
    check('5c the memory page shows the earlier version under the editor, and how often AIs used it', page && page.revs.join() === '1' && page.history.includes('现在是第 2 版') && page.body.includes('第二版') && /用到过 1 次/.test(page.usage ?? '') && page.rowText.includes('用过 1 次'), page)
    const restored = await desk.ev(`(async () => { const wait = (ms) => new Promise((z) => setTimeout(z, ms)); const b = document.querySelector('[data-memory-restore="1"] button'); if (!b) return null; b.click(); await wait(200); const armed = b.innerText.trim(); b.click(); for (let i = 0; i < 25; i++) { await wait(200); if ((document.querySelector('main textarea')?.value ?? '').includes('五十个字')) break } return { armed, body: document.querySelector('main textarea')?.value ?? null, history: document.querySelector('[data-memory-history]')?.innerText ?? '', revs: [...document.querySelectorAll('[data-memory-rev]')].map((x) => x.getAttribute('data-memory-rev')) } })()`)
    check('5c 恢复这一版 (asks once more) puts the first version back as a new version, and the replaced one stays in the list', restored && restored.armed === '确认恢复？' && restored.body.includes('五十个字') && restored.history.includes('现在是第 3 版') && restored.revs.join() === '2,1', restored)
    const archived = await desk.ev(`(async () => { const wait = (ms) => new Promise((z) => setTimeout(z, ms)); const b = document.querySelector('[data-memory-archive]'); if (!b) return null; b.click(); for (let i = 0; i < 20 && document.querySelector('[data-memory-row="${MID}"]'); i++) await wait(200); const goneFromAll = !document.querySelector('[data-memory-row="${MID}"]'); const tab = [...document.querySelectorAll('aside button')].find((x) => x.offsetParent !== null && x.innerText.trim().startsWith('归档')); const tabText = tab?.innerText.trim() ?? null; tab?.click(); await wait(400); const r = document.querySelector('[data-memory-row="${MID}"]'); return { goneFromAll, tabText, inTab: r?.getAttribute('data-memory-archived') ?? null, button: document.querySelector('[data-memory-archive]')?.innerText.trim() ?? null } })()`)
    const viaTool = await B.call('memory_search', { workspace: 'alpha-proj' })
    check('5c 归档 takes it out of the list (and out of what AIs get when they list memories) and into the 归档 tab; the button now offers 取消归档', archived && archived.goneFromAll === true && archived.tabText === '归档 1' && archived.inTab === 'true' && archived.button === '取消归档' && Array.isArray(viaTool.data) && !viaTool.data.some((x) => x.id === MID), [archived, viaTool.raw.slice(0, 200)])
  }

  // ===== 6. older surfaces still work =====
  await desk.ev(`(localStorage.setItem('wb.nav.section', 'group'), location.reload(), 1)`)
  for (let i = 0; i < 40; i++) { await sleep(500); m = await mainText().catch(() => ''); if (typeof m === 'string' && m.includes('灵感激荡')) break }
  check('6 the group chat page still works and shows the card there too, marked 已撤销', m.includes('登录模块写好了') && m.includes('已编辑') && m.includes('已撤销'), String(m).slice(0, 300))
  const lobbyHasCard = await desk.ev(`(async () => { const r = [...document.querySelectorAll('aside div.cursor-pointer')].find((x) => x.innerText.trim().startsWith('大厅')); r?.click(); await new Promise((z) => setTimeout(z, 800)); return !!document.querySelector('[data-change-card]') })()`)
  check('6 the lobby has no change cards (it belongs to no project)', lobbyHasCard === false, lobbyHasCard)
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
