// Codex-style UI step 3: the right panel (变更 / 任务 / 活动) with diff and file preview. Checked on an isolated instance.
// Usage (repo root, ELECTRON_RUN_AS_NODE unset): node scripts/verify-right-panel.mjs <out dir> [screenshot dir]
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vrp-'))
const wsA = path.join(base, 'alpha'), wsB = path.join(base, 'beta'), home = path.join(base, 'home'), data = path.join(base, 'data'), ud = path.join(base, 'ud')
for (const d of [wsA, wsB, home, data, ud]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(wsA, 'keep.txt'), 'line one\n')
const TOKENS = { a: 'wb_vrp_aaaaaaaaaaaaaaaaaaaaaa', b: 'wb_vrp_bbbbbbbbbbbbbbbbbbbbbb' }
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

  const J = JSON.stringify
  const waitFor = async (fn, ok, tries = 30, gap = 300) => { let v; for (let i = 0; i < tries; i++) { v = await fn().catch(() => undefined); if (ok(v)) break; await sleep(gap) } return v }
  const panel = () => desk.ev(`document.querySelector('[data-right-panel]')?.innerText ?? null`)
  const tabSel = () => desk.ev(`document.querySelector('[data-right-tab][aria-selected="true"]')?.getAttribute('data-right-tab') ?? null`)
  const clickTab = (id) => desk.ev(`(() => { const b = document.querySelector('[data-right-tab="${id}"]'); if (!b) return false; b.click(); return true })()`)
  const scope = () => desk.ev(`document.querySelector('[data-right-scope]')?.innerText.trim() ?? null`)
  const groups = () => desk.ev(`[...document.querySelectorAll('[data-right-change]')].filter((x) => !x.closest('[data-right-pinned]')).map((x) => x.innerText)`)
  // click inside the change block (outside the pinned one) whose text contains `who`: its header (no label) or a button with that label
  const inGroup = (who, label) => desk.ev(`(() => { const g = [...document.querySelectorAll('[data-right-change]')].find((x) => !x.closest('[data-right-pinned]') && x.innerText.includes(${J(who)})); if (!g) return false; const b = ${label ? `[...g.querySelectorAll('button')].find((x) => x.innerText.trim() === ${J(label)})` : `g.querySelector('button')`}; if (!b) return false; b.click(); return true })()`)
  const clickFile = (name) => desk.ev(`(() => { const r = [...document.querySelectorAll('[data-right-file-row]')].find((x) => x.getAttribute('data-right-file-row').endsWith(${J(name)})); const b = r?.querySelector('button'); if (!b) return false; b.click(); return true })()`)
  const section = () => desk.ev(`localStorage.getItem('wb.nav.section')`)
  const goHome = async (expanded) => {
    await desk.ev(`(localStorage.setItem('wb.nav.section', 'overview'), ${expanded ? `localStorage.setItem('wb.projects.expanded', ${J(J(expanded))})` : `localStorage.removeItem('wb.projects.expanded')`}, location.reload(), 1)`)
    return waitFor(side, (v) => typeof v === 'string' && v.includes('alpha-proj') && v.includes('最近'), 60, 500)
  }

  // ----- seed: Bob works in alpha (not the active workspace), Alice in beta; tasks in both -----
  const w1 = await B.call('write_file', { workspace: 'alpha-proj', path: 'src/new-a.ts', content: 'export const a = 1\nexport const b = 2\nexport const c = 3\n' })
  const w2 = await B.call('edit_file', { workspace: 'alpha-proj', path: 'keep.txt', edits: [{ old_string: 'line one', new_string: 'line 1\nline two\nline three' }] })
  const m1 = await B.call('chat_send', { channel: CH, text: '登录模块写好了，两处改动' })
  const w3 = await A.call('write_file', { workspace: 'beta-proj', path: 'b.txt', content: 'beta one\nbeta two\n' })
  check('seed: Bob writes one new file and edits one in alpha and says so; Alice writes one file in beta', !w1.isError && !w2.isError && !m1.isError && !w3.isError, [w1.raw, w2.raw, m1.raw, w3.raw])
  const t1 = await A.call('task_create', { workspace: 'alpha-proj', title: '做登录页', assigneeId: 'Bob' })
  const t2 = await A.call('task_create', { workspace: 'alpha-proj', title: '写测试' })
  const t3 = await A.call('task_create', { workspace: 'alpha-proj', title: '定接口' })
  const t4 = await A.call('task_create', { workspace: 'beta-proj', title: '整理文档' })
  const u1 = await B.call('task_update', { task: t1.data?.ref, workspace: ALPHA, status: 'in_progress' })
  const u3 = await A.call('task_update', { task: t3.data?.ref, workspace: ALPHA, status: 'done', result: '接口定好了' })
  check('seed: alpha has one task in progress, one todo, one done; beta has one todo', [t1, t2, t3, t4, u1, u3].every((x) => !x.isError), [t1.raw, t2.raw, t3.raw, t4.raw, u1.raw, u3.raw].map((x) => String(x).slice(0, 120)))
  await sleep(600)

  // ===== 1. the panel and its three tabs =====
  await goHome()
  const tabs = await desk.ev(`[...document.querySelectorAll('[data-right-panel] [role=tab]')].map((x) => x.getAttribute('data-right-tab'))`)
  const tabText = await desk.ev(`document.querySelector('[data-right-panel] [role=tablist]')?.innerText ?? ''`)
  check('1 the right panel has three tabs in this order: 变更, 任务, 活动', J(tabs) === J(['changes', 'tasks', 'activity']) && ['变更', '任务', '活动'].every((x) => tabText.includes(x)), [tabs, tabText])
  let p = await panel()
  check('1 on a fresh profile it opens on 活动, which is the old live-activity list (filters, search box, the calls made so far)', (await tabSel()) === 'activity' && ['全部', '改文件', '协作', '失败', 'Alice', 'Bob'].every((x) => p.includes(x)) && (await desk.ev(`!!document.querySelector('[data-right-panel] input[placeholder^="搜索路径"]')`)) && (await scope()) === null, p.slice(0, 400))
  check('1 the top-bar button is now called 收起右栏', await desk.ev(`!!document.querySelector('header button[title="收起右栏"]') || [...document.querySelectorAll('button[title="收起右栏"]')].some((b) => !b.closest('[data-right-panel]'))`))

  // ===== 2. 任务 follows the project you are looking at =====
  await clickTab('tasks')
  p = await waitFor(panel, (v) => typeof v === 'string' && v.includes('整理文档'))
  check('2 nothing selected on the home page: 任务 shows the active workspace (beta) and only its task', (await scope()) === 'beta-proj' && p.includes('整理文档') && !p.includes('做登录页') && !p.includes('写测试'), [await scope(), p])
  await clickSide('alpha-proj')
  await sleep(400)
  await clickSide('群聊')
  await waitFor(mainText, (v) => typeof v === 'string' && v.includes('登录模块写好了'))
  p = await waitFor(panel, (v) => typeof v === 'string' && v.includes('做登录页'))
  check('2 opening the alpha conversation switches the panel to alpha without changing the active workspace', (await scope()) === 'alpha-proj' && (await active()) === BETA && !p.includes('整理文档'), [await scope(), await active(), p])
  check('2 open tasks are listed with the one in progress first, its assignee and status; the done one is folded under 已完成 1; the tab shows the count 2', p.indexOf('做登录页') >= 0 && p.indexOf('做登录页') < p.indexOf('写测试') && p.includes('进行中') && p.includes('Bob') && p.includes('待办') && p.includes('没人领') && p.includes('已完成 1') && !p.includes('定接口') && (await desk.ev(`document.querySelector('[data-right-tab="tasks"]').innerText`)).includes('2'), p)
  await desk.ev(`document.querySelector('[data-right-done]')?.click()`)
  await sleep(300)
  check('2 clicking 已完成 1 unfolds the done task', (await panel()).includes('定接口'), await panel())
  await shot('right-tasks.png')
  await desk.ev(`[...document.querySelectorAll('[data-right-task]')].find((x) => x.innerText.includes('做登录页'))?.click()`)
  let m = await waitFor(mainText, (v) => typeof v === 'string' && v.includes('做登录页') && !v.includes('登录模块写好了'))
  check('2 clicking a task opens it in the main area (still the home page); the panel stays on alpha', m.includes('做登录页') && !m.includes('登录模块写好了') && (await section()) === 'overview' && (await scope()) === 'alpha-proj' && (await active()) === BETA, [m.slice(0, 200), await section(), await scope()])

  // ===== 3. 变更: who changed what, the diff and the whole file =====
  await clickSide('群聊')
  await waitFor(mainText, (v) => typeof v === 'string' && v.includes('登录模块写好了'))
  await clickTab('changes')
  let g = await waitFor(groups, (v) => Array.isArray(v) && v.length > 0)
  check('3 变更 lists one change for alpha: Bob, 2 个文件 +6 -1; beta\'s file is not there; folded at first', g.length === 1 && g[0].includes('Bob') && g[0].includes('2 个文件') && /\+6\s*-1/.test(g[0]) && !g[0].includes('keep.txt') && !(await panel()).includes('b.txt') && (await scope()) === 'alpha-proj', g)
  await inGroup('Bob')
  g = await waitFor(groups, (v) => Array.isArray(v) && v[0]?.includes('keep.txt'))
  check('3 unfolding it lists both files with their line counts, the new one marked 新建, plus 撤销 and 在改动页打开', g[0].includes('new-a.ts') && g[0].includes('keep.txt') && g[0].includes('新建') && g[0].includes('撤销') && g[0].includes('在改动页打开') && !(await desk.ev(`!!document.querySelector('[data-right-diff]')`)), g)
  await clickFile('keep.txt')
  let d = await waitFor(() => desk.ev(`document.querySelector('[data-right-diff]')?.innerText ?? ''`), (v) => typeof v === 'string' && v.includes('line two'))
  check('3 clicking a file shows its diff right there: the old line removed, the new lines added', d.includes('line one') && d.includes('line 1') && d.includes('line two') && d.includes('line three'), d)
  await shot('right-changes.png')
  await desk.ev(`document.querySelector('[data-right-mode="file"]')?.click()`)
  let pv = await waitFor(() => desk.ev(`document.querySelector('[data-right-preview]')?.innerText ?? ''`), (v) => typeof v === 'string' && v.includes('line three'))
  check('3 全文 shows the file as it is now (read-only), not the old line; the diff is hidden meanwhile', pv.includes('line 1') && pv.includes('line three') && !pv.includes('line one') && !(await desk.ev(`!!document.querySelector('[data-right-diff]')`)), pv)
  await shot('right-preview.png')
  await clickFile('keep.txt')
  await sleep(300)
  check('3 clicking the file again folds it', !(await desk.ev(`!!document.querySelector('[data-right-preview]') || !!document.querySelector('[data-right-diff]')`)))

  // ===== 4. the list follows what the AIs do =====
  const w4 = await B.call('write_file', { workspace: 'alpha-proj', path: 'src/third.ts', content: 'export const third = 3\n' })
  g = await waitFor(groups, (v) => Array.isArray(v) && v[0]?.includes('3 个文件'))
  check('4 Bob changes one more file a moment later: it joins the same change (still one row, now 3 个文件, +7 -1) without a reload, and the row stays unfolded', !w4.isError && g.length === 1 && g[0].includes('third.ts') && /\+7\s*-1/.test(g[0]), g)
  const w5 = await A.call('write_file', { workspace: 'alpha-proj', path: 'notes.md', content: 'note a\nnote b\n' })
  g = await waitFor(groups, (v) => Array.isArray(v) && v.length === 2)
  check('4 Alice changes a file in alpha: a second row appears above Bob\'s', !w5.isError && g.length === 2 && g[0].includes('Alice') && g[0].includes('1 个文件') && g[1].includes('Bob'), g)
  await clickSide('新会话')
  g = await waitFor(groups, (v) => Array.isArray(v) && v.length === 1 && v[0].includes('Alice'))
  check('4 back on the 新会话 page the panel shows beta again: only Alice\'s b.txt change', (await scope()) === 'beta-proj' && g.length === 1 && g[0].includes('Alice') && /\+2\s*-0/.test(g[0]), [await scope(), g])

  // ===== 5. 查看变更 on a chat card opens the panel on that change =====
  await clickSide('群聊')
  await waitFor(mainText, (v) => typeof v === 'string' && v.includes('已编辑'))
  await clickTab('activity')
  await desk.ev(`document.querySelector('[data-right-panel] button[title="收起右栏"]')?.click()`)
  await sleep(400)
  check('5 the panel can be folded away (the button in its corner)', (await panel()) === null && (await desk.ev(`!!document.querySelector('button[title^="展开右栏"]')`)))
  const mainW0 = await desk.ev(`document.querySelector('main').getBoundingClientRect().width`)
  await desk.ev(`(() => { const b = [...document.querySelectorAll('[data-change-card] button')].find((x) => x.innerText.trim() === '查看变更'); if (!b) return false; b.click(); return true })()`)
  let pin = await waitFor(() => desk.ev(`document.querySelector('[data-right-pinned]')?.innerText ?? ''`), (v) => typeof v === 'string' && v.includes('export const a = 1'))
  check('5 查看变更 unfolds the panel on 变更 with 这条消息的改动 on top: the two files of that message (not the later third.ts), first file\'s diff already open', (await tabSel()) === 'changes' && pin.includes('这条消息的改动') && pin.includes('new-a.ts') && pin.includes('keep.txt') && !pin.includes('third.ts') && /\+6\s*-1/.test(pin) && pin.includes('export const a = 1'), pin)
  const w = await desk.ev(`({ panel: document.querySelector('[data-right-panel]').getBoundingClientRect().width, main: document.querySelector('main').getBoundingClientRect().width, over: document.documentElement.scrollWidth - window.innerWidth })`)
  check('5 the conversation stays open next to it, the active workspace is unchanged, the panel is wide enough to read a diff (>= 455) and the main area keeps at least 320', (await section()) === 'overview' && (await active()) === BETA && (await mainText()).includes('登录模块写好了') && w.panel >= 455 && w.main >= 320 && w.over <= 0, [await section(), await active(), w, mainW0])
  await shot('right-card.png')
  await desk.ev(`document.querySelector('[data-right-pinned] button[title="不看这条了"]')?.click()`)
  await sleep(300)
  check('5 the × takes 这条消息的改动 away; the recent list stays', !(await desk.ev(`!!document.querySelector('[data-right-pinned]')`)) && (await groups()).length === 2, await groups())

  // ===== 6. 撤销 from the panel =====
  await inGroup('Alice')
  await waitFor(groups, (v) => Array.isArray(v) && v[0]?.includes('notes.md'))
  await inGroup('Alice', '撤销')
  await sleep(300)
  check('6 撤销 asks once more before doing anything (file untouched)', fs.existsSync(path.join(wsA, 'notes.md')) && (await groups())[0].includes('确认撤销这些改动'), await groups())
  await inGroup('Alice', '确认撤销这些改动')
  g = await waitFor(groups, (v) => Array.isArray(v) && v.some((x) => x.includes('Alice') && /(^|\n)已撤销(\n|$)/.test(x) && !/(^|\n)撤销(\n|$)/.test(x)))
  check('6 confirmed: the new file is gone from disk, the row says 已撤销 and no longer offers 撤销; Bob\'s files are untouched', !fs.existsSync(path.join(wsA, 'notes.md')) && fs.existsSync(path.join(wsA, 'src', 'third.ts')) && g.some((x) => x.includes('Alice') && /(^|\n)已撤销(\n|$)/.test(x) && !/(^|\n)撤销(\n|$)/.test(x)), g)

  // ===== 7. remembered tab, narrow window, 整台电脑, the full page =====
  const st1 = await desk.ev(`window.bridge.getState().then((s) => s.workspaces.find((w) => w.kind === 'machine')?.id ?? null)`)
  await goHome([st1])
  check('7 after a reload the panel is still on 变更 (remembered)', (await tabSel()) === 'changes' && (await scope()) === 'beta-proj', [await tabSel(), await scope()])
  await clickSide('群聊')
  await sleep(600)
  p = await panel()
  check('7 the 整台电脑 conversation: the panel says 整台电脑, has no changes and no 改动页 link (that page cannot show it)', (await scope()) === '整台电脑' && p.includes('还没有改动') && !p.includes('改动页'), [await scope(), p])
  await desk.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false })
  await sleep(700)
  const nw = await desk.ev(`({ panel: document.querySelector('[data-right-panel]')?.getBoundingClientRect().width ?? 0, main: document.querySelector('main').getBoundingClientRect().width, over: document.documentElement.scrollWidth - window.innerWidth, win: window.innerWidth })`)
  check('7 in a 1000 px window the panel shrinks instead of pushing the page: main >= 300, panel >= 260, nothing overflows', nw.win === 1000 && nw.main >= 300 && nw.panel >= 260 && nw.over <= 0, nw)
  await shot('right-narrow.png')
  await desk.ev(`(localStorage.setItem('wb.layout.activityWidth', '340'), 1)`)
  await goHome([ALPHA])
  await clickSide('群聊')
  await waitFor(mainText, (v) => typeof v === 'string' && v.includes('已编辑'))
  await desk.ev(`(() => { const b = [...document.querySelectorAll('[data-change-card] button')].find((x) => x.innerText.trim() === '查看变更'); if (!b) return false; b.click(); return true })()`)
  await waitFor(() => desk.ev(`document.querySelector('[data-right-pinned]')?.innerText ?? ''`), (v) => typeof v === 'string' && v.includes('new-a.ts'))
  await sleep(400)
  const nw2 = await desk.ev(`({ panel: document.querySelector('[data-right-panel]')?.getBoundingClientRect().width ?? 0, main: document.querySelector('main').getBoundingClientRect().width, win: window.innerWidth })`)
  check('7 in that narrow window 查看变更 does not widen the panel at the conversation\'s expense (panel stays about 340, main >= 300)', nw2.win === 1000 && nw2.panel <= 345 && nw2.panel >= 260 && nw2.main >= 300, nw2)
  await desk.send('Emulation.clearDeviceMetricsOverride')
  await goHome([ALPHA])
  await clickSide('群聊')
  await waitFor(groups, (v) => Array.isArray(v) && v.length === 2)
  await inGroup('Bob')
  await waitFor(groups, (v) => Array.isArray(v) && v.some((x) => x.includes('在改动页打开')))
  await inGroup('Bob', '在改动页打开')
  await waitFor(section, (v) => v === 'changes')
  await sleep(800)
  m = await mainText()
  check('7 在改动页打开 switches to alpha (an explicit action) and opens the full changes page on that step; the panel is still there', (await section()) === 'changes' && (await active()) === ALPHA && (m.includes('third.ts') || m.includes('keep.txt')) && (await panel()) !== null, [await section(), await active(), m.slice(0, 300)])
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
