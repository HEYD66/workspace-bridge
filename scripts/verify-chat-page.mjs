// The Codex-like conversation page (step 2): 新会话 as the home page, message and composer style, 概览 under 更多,
// project menu / pin / hover card / all conversations / archive all / remove, and the window without a system title bar.
// Usage (repo root, ELECTRON_RUN_AS_NODE unset): node scripts/verify-chat-page.mjs <out dir> [screenshot dir]
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vcp-'))
const wsA = path.join(base, 'alpha'), wsB = path.join(base, 'beta'), home = path.join(base, 'home'), data = path.join(base, 'data'), ud = path.join(base, 'ud')
for (const d of [wsA, wsB, home, data, ud]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(wsA, 'keep.txt'), 'line one\n')
const TOKENS = { a: 'wb_vcp_aaaaaaaaaaaaaaaaaaaaaa', b: 'wb_vcp_bbbbbbbbbbbbbbbbbbbbbb' }
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
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ workspaces: [{ id: 'w_aaaa0001', name: 'alpha-proj', root: wsA }, { id: 'w_bbbb0002', name: 'beta-proj', root: wsB }], activeWorkspaceId: 'w_bbbb0002', host: '127.0.0.1', port: PORT, roles: [{ id: 'r-dev', name: '开发', description: '写代码' }],
    agents: [{ id: 'a-1', name: 'Alice', color: '#60a5fa', token: TOKENS.a, createdAt: Date.now(), roleId: 'r-dev' }, { id: 'a-2', name: 'Bob', color: '#f472b6', token: TOKENS.b, createdAt: Date.now() }] }))
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


  const J = JSON.stringify
  const waitFor = async (fn, tries = 30, gap = 200) => { let v; for (let i = 0; i < tries; i++) { v = await fn(); if (v) return v; await sleep(gap) } return v }
  const st0 = await desk.ev(`window.bridge.getState().then((s) => ({ active: s.activeWorkspaceId, ws: s.workspaces.map((w) => [w.id, w.name, w.kind ?? null]) }))`)
  const ALPHA = st0.ws.find((w) => w[1] === 'alpha-proj')[0], BETA = st0.ws.find((w) => w[1] === 'beta-proj')[0]
  const side = () => desk.ev(`[...document.querySelectorAll('aside')].find((x) => x.offsetParent !== null)?.innerText ?? ''`)
  const mainText = () => desk.ev(`document.querySelector('main')?.innerText ?? ''`)
  const threads = () => desk.ev(`window.bridge.getState().then((s) => s.chat.channels.filter((c) => c.thread).map((c) => ({ id: c.id, ws: c.workspaceId, title: c.thread.title, archived: c.thread.archived === true })))`)
  const newPage = () => desk.ev(`document.querySelector('[data-new-chat]')?.getAttribute('data-new-chat') ?? null`)
  const clickSide = (label) => desk.ev(`(() => { const r = [...document.querySelectorAll('aside div.cursor-pointer')].filter((x) => x.offsetParent !== null && x.innerText.trim().startsWith(${J(label)}))[0]; if (!r) return false; r.click(); return true })()`)
  const clickBtn = (title) => desk.ev(`(() => { const b = [...document.querySelectorAll('aside button')].find((x) => x.offsetParent !== null && x.getAttribute('title') === ${J(title)}); if (!b) return false; const r = b.getBoundingClientRect(); b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 4 })); return true })()`)
  const menuItems = () => desk.ev(`[...document.querySelectorAll('[role=menuitem]')].map((x) => x.innerText.trim())`)
  const clickMenu = (start) => desk.ev(`(() => { const m = [...document.querySelectorAll('[role=menuitem]')].find((x) => x.innerText.trim().startsWith(${J(start)})); if (!m) return false; m.click(); return true })()`)
  const typeMsg = (value) => desk.ev(`(() => { const i = document.getElementById('group-composer'); if (!i) return false; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(i, ${J(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  const clickSend = () => desk.ev(`(() => { const b = document.querySelector('[data-composer] button[aria-label="发送"]'); if (!b || b.disabled) return false; b.click(); return true })()`)
  const rowBox = (label) => desk.ev(`(() => { const r = [...document.querySelectorAll('aside div.cursor-pointer')].filter((x) => x.offsetParent !== null && x.innerText.trim().startsWith(${J(label)}))[0]; if (!r) return null; r.scrollIntoView({ block: 'nearest' }); const b = r.getBoundingClientRect(); return { x: Math.round(b.left + 40), y: Math.round(b.top + b.height / 2) } })()`)
  const move = (x, y) => desk.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  const card = () => desk.ev(`(() => { const c = document.querySelector('[data-project-card]'); return c ? { id: c.getAttribute('data-project-card'), text: c.innerText } : null })()`)

  await desk.ev(`(localStorage.setItem('wb.nav.section', 'overview'), localStorage.removeItem('wb.projects.expanded'), localStorage.removeItem('wb.projects.pinned'), localStorage.removeItem('wb.projects.view'), location.reload(), 1)`)
  await waitFor(async () => (await newPage().catch(() => null)) !== null, 80, 250)
  await sleep(600)

  // ===== 1. the 新会话 page is the home page =====
  const m1 = await mainText(), s1 = await side()
  check('1 opening the app: the main area is the 新会话 page for the active workspace (beta), with a composer', (await newPage()) === BETA && m1.includes('想让 AI 们在') && m1.includes('beta-proj') && m1.includes('2 个 AI 能看到这个会话') && (await desk.ev(`!!document.querySelector('[data-new-chat] #group-composer')`)) === true, m1.slice(0, 300))
  check('1 the sidebar starts with 新会话 / 新任务 / 大厅 / 概览 (概览 moved here from the old 更多 menu)', s1.indexOf('新会话') >= 0 && s1.indexOf('新会话') < s1.indexOf('新任务') && s1.indexOf('新任务') < s1.indexOf('大厅') && s1.indexOf('大厅') < s1.indexOf('概览') && s1.indexOf('概览') < s1.indexOf('项目'), s1.slice(0, 200))
  await shot('chat-page-new.png')
  await desk.ev(`document.querySelector('[data-new-chat] h1 button')?.click()`)
  const opts = await waitFor(() => desk.ev(`(() => { const l = document.querySelector('[data-new-chat] [role=listbox]'); return l ? [...l.querySelectorAll('[role=option]')].map((x) => x.innerText.trim()) : null })()`))
  check('1 clicking the project name lists every project', Array.isArray(opts) && ['alpha-proj', 'beta-proj', '整台电脑'].every((x) => opts.includes(x)), opts)
  await desk.ev(`[...document.querySelectorAll('[data-new-chat] [role=option]')].find((x) => x.innerText.trim() === 'alpha-proj')?.click()`)
  const picked = await waitFor(async () => (await newPage()) === ALPHA)
  check('1 picking alpha switches the page to alpha; nothing is created yet and the active workspace stays beta', picked === true && (await threads()).length === 0 && (await desk.ev(`window.bridge.getState().then((s) => s.activeWorkspaceId)`)) === BETA, [await newPage(), await threads()])
  const dis0 = await desk.ev(`document.querySelector('[data-composer] button[aria-label="发送"]')?.disabled`)
  await typeMsg('@Alice 把登录页改成新样式\n第二行是细节')
  await sleep(200)
  const sent = await clickSend()
  const th = await waitFor(async () => (await threads()).find((c) => c.ws === ALPHA))
  check('1 the send button is off while empty; sending the first message creates a conversation in alpha titled from its first line (without the @)', dis0 === true && sent === true && th?.title === '把登录页改成新样式', [dis0, sent, th])
  const m1b = await waitFor(async () => { const x = await mainText(); return x.includes('alpha-proj / 把登录页改成新样式') && x.includes('第二行是细节') ? x : '' })
  check('1 the new conversation opens with the message in it; the 新会话 page is gone', !!m1b && (await newPage()) === null, String(await mainText()).slice(0, 300))
  const ra = await A.call('chat_read', { channel: th?.id })
  const got = ra.data?.messages?.[0]
  check('1 Alice receives it in that conversation, mentioned', got?.text === '@Alice 把登录页改成新样式\n第二行是细节' && JSON.stringify(got?.mentions) === '["a-1"]', ra.raw.slice(0, 400))
  check('1 exactly one conversation was created', (await threads()).length === 1, await threads())

  // ===== 2. how messages and the composer look =====
  await A.call('chat_send', { channel: th?.id, text: 'Alice 的回复：我来改' })
  await B.call('chat_send', { channel: th?.id, text: 'Bob 也说一句' })
  const items = await waitFor(async () => { const v = await desk.ev(`[...document.querySelectorAll('main [id^="gm-"]')].map((el) => { const bubble = el.querySelector('.rounded-2xl'); const r = el.getBoundingClientRect(), b = bubble?.getBoundingClientRect(); return { mine: el.hasAttribute('data-chat-mine'), text: el.innerText.replace(/\\n+/g, ' | '), align: getComputedStyle(el).alignItems, bubbleBg: bubble ? getComputedStyle(bubble).backgroundColor : null, gapRight: b ? Math.round(r.right - b.right) : null, gapLeft: b ? Math.round(b.left - r.left) : null } })`); return v.length === 3 ? v : null })
  check('2 your own message: right-aligned in a rounded block, without your name', items?.[0]?.mine === true && items[0].align === 'flex-end' && items[0].bubbleBg === 'rgb(36, 36, 36)' && items[0].gapRight <= 12 && items[0].gapLeft > 100 && !items[0].text.includes('你 |'), items?.[0])
  check('2 an AI message: flat, with a small line of name, role and time above it (Alice 开发), then what it is doing now; Bob has no role', items?.[1]?.mine === false && /Alice \| 开发 \| \d{1,2}:\d{2} \| (?:[^|]+ \| )?Alice 的回复：我来改/.test(items[1].text) && items[1].bubbleBg === null && /Bob \| \d{1,2}:\d{2} \| (?:[^|]+ \| )?Bob 也说一句/.test(items[2].text), items?.slice(1))
  const comp = await desk.ev(`(() => { const c = document.querySelector('main [data-composer]'); const block = c.querySelector('textarea').parentElement; const cs = getComputedStyle(block); return { radius: cs.borderTopLeftRadius, bg: cs.backgroundColor, topBorder: getComputedStyle(c).borderTopWidth, chip: c.querySelector('[data-audience]')?.innerText.trim(), buttons: [...c.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')), sendInside: block.contains(c.querySelector('button[aria-label="发送"]')) } })()`)
  check('2 the composer is one rounded block holding the text, 发图片, 私聊, who receives it, and the send button', comp.radius === '16px' && comp.bg === 'rgb(36, 36, 36)' && comp.topBorder === '0px' && comp.chip === '灵感激荡 · 全员可见' && comp.buttons.includes('发图片') && comp.buttons.includes('私聊给…') && comp.sendInside === true, comp)
  const head = await desk.ev(`document.querySelector('main [data-chat-header]')?.innerText.replace(/\\n+/g, ' | ') ?? null`)
  check('2 the header keeps the title, the explanation line and the work-mode switch', typeof head === 'string' && head.includes('alpha-proj / 把登录页改成新样式') && head.includes('2 个 AI') && head.includes('灵感激荡') && head.includes('分工明确'), head)
  await shot('chat-page-thread.png')
  await desk.ev(`window.bridge.setGroupChatLead(${J(th?.id)}, 'a-1')`)
  const chip2 = await waitFor(async () => { const t = await desk.ev(`document.querySelector('main [data-audience]')?.innerText.trim()`); return t === '分工明确 · 发给主脑 Alice' ? t : null })
  await desk.ev(`window.bridge.setGroupChatLead(${J(th?.id)}, null)`)
  const chip3 = await waitFor(async () => { const t = await desk.ev(`document.querySelector('main [data-audience]')?.innerText.trim()`); return t === '灵感激荡 · 全员可见' ? t : null })
  check('2 the line under the text follows the work mode', !!chip2 && !!chip3, [chip2, chip3])
  // typing and Enter still send
  await typeMsg('用回车发的')
  await desk.ev(`document.getElementById('group-composer').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`)
  const viaEnter = await waitFor(async () => (await mainText()).includes('用回车发的') && (await desk.ev(`document.getElementById('group-composer').value`)) === '')
  check('2 Enter sends and empties the box', viaEnter === true, String(await mainText()).slice(-200))

  // ===== 3. 概览 is a row in the home sidebar; 新会话 in the sidebar comes back to the page =====
  await clickSide('概览')
  const ov = await waitFor(async () => { const x = await mainText(); return x.includes('概览') && x.includes('在线 AI') ? x : '' })
  const railNow = await desk.ev(`document.querySelector('nav[aria-label="页面"] button[aria-current="page"]')?.getAttribute('aria-label')`)
  check('3 概览 in the sidebar shows the overview page; 首页 stays the current rail icon', !!ov && String(railNow).startsWith('首页'), [String(ov).slice(0, 120), railNow])
  await clickSide('新会话')
  const back = await waitFor(async () => (await newPage()) !== null)
  await sleep(200)
  const focus = await desk.ev(`document.activeElement?.id ?? null`)
  check('3 新会话 in the sidebar opens the 新会话 page with the cursor in the box', back === true && focus === 'group-composer', [back, focus])

  // ===== 4. projects: the … menu, pin, the hover card, all conversations, archive all, remove =====
  const order = async () => { const s = await side(); return [s.indexOf('alpha-proj'), s.indexOf('beta-proj')] }
  const o0 = await order()
  const dots = await clickBtn('「beta-proj」的更多操作')
  const mi = await waitFor(async () => { const v = await menuItems(); return v.length ? v : null })
  check('4 the … button on a project row opens its menu: 置顶 / 新会话 / … / 归档全部会话 / 移除项目', dots === true && Array.isArray(mi) && ['置顶', '新会话', '新任务', '设为当前工作区', '在资源管理器中显示', '归档全部会话', '移除项目'].every((x) => mi.some((y) => y.startsWith(x))), mi)
  await clickMenu('置顶')
  const o1 = await waitFor(async () => { const o = await order(); return o[1] < o[0] ? o : null })
  const pinnedLs = await desk.ev(`localStorage.getItem('wb.projects.pinned')`)
  check('4 置顶 moves beta above alpha and is remembered', o0[0] < o0[1] && !!o1 && pinnedLs === J([BETA]), [o0, o1, pinnedLs])
  await desk.ev(`(location.reload(), 1)`)
  await waitFor(async () => (await newPage().catch(() => null)) !== null, 80, 250)
  await sleep(500)
  const o2 = await order()
  check('4 after a reload beta is still on top', o2[1] >= 0 && o2[1] < o2[0], o2)
  await clickBtn('「beta-proj」的更多操作'); await waitFor(async () => (await menuItems()).length > 0)
  const mi2 = await menuItems()
  await clickMenu('取消置顶')
  const o3 = await waitFor(async () => { const o = await order(); return o[0] < o[1] ? o : null })
  check('4 the menu now offers 取消置顶, which puts the order back', mi2.some((x) => x.startsWith('取消置顶')) && !!o3, [mi2, o3])

  // hover card (real mouse movement through CDP)
  const rb = await rowBox('alpha-proj')
  await move(rb.x, rb.y - 1); await move(rb.x, rb.y)
  const c1 = await waitFor(card, 20, 150)
  check('4 resting on the alpha row shows a card: name, conversations and open tasks, the folder, 设为当前工作区', c1?.id === ALPHA && c1.text.includes('alpha-proj') && c1.text.includes('2 个会话 · 0 个任务没做完') && c1.text.toLowerCase().includes(wsA.toLowerCase().slice(3, 20)) && c1.text.includes('设为当前工作区'), c1)
  await shot('chat-page-card.png')
  await desk.ev(`[...document.querySelectorAll('[data-project-card] button')].find((b) => b.innerText.includes('设为当前工作区'))?.click()`)
  const act = await waitFor(async () => (await desk.ev(`window.bridge.getState().then((s) => s.activeWorkspaceId)`)) === ALPHA)
  check('4 设为当前工作区 on the card works and closes it', act === true && (await card()) === null, [act, await card()])
  await desk.ev(`window.bridge.setActiveWorkspace(${J(BETA)})`)
  const rb2 = await rowBox('beta-proj')
  await move(rb2.x, rb2.y - 1); await move(rb2.x, rb2.y)
  const c2 = await waitFor(card, 20, 150)
  await move(900, 500)
  const gone = await waitFor(async () => (await card()) === null, 20, 150)
  check('4 the card of the active project says so; moving away closes it', c2?.id === BETA && c2.text.includes('当前工作区') && gone === true, [c2, gone])

  // all conversations
  await desk.ev(`document.querySelector('aside button[data-projects-view]').click()`)
  const flat = await waitFor(async () => { const s = await side(); return s.includes('全部会话') && !s.includes('最近') ? s : '' })
  const flatLs = await desk.ev(`localStorage.getItem('wb.projects.view')`)
  check('4 clicking 项目 switches the sidebar to 全部会话: every conversation by time with its project, no project rows, no 最近', !!flat && flat.includes('把登录页改成新样式') && /群聊\s*alpha-proj/.test(flat) && /群聊\s*beta-proj/.test(flat) && flatLs === '"chats"', [String(flat), flatLs])
  await shot('chat-page-flat.png')
  await clickSide('把登录页改成新样式')
  const openFlat = await waitFor(async () => (await mainText()).includes('alpha-proj / 把登录页改成新样式'))
  check('4 a row in 全部会话 opens that conversation', openFlat === true, String(await mainText()).slice(0, 120))
  await desk.ev(`document.querySelector('aside button[data-projects-view]').click()`)
  const grouped = await waitFor(async () => { const s = await side(); return s.includes('最近') && s.includes('项目') ? s : '' })
  check('4 clicking again goes back to projects', !!grouped && (await desk.ev(`localStorage.getItem('wb.projects.view')`)) === '"projects"', String(grouped).slice(0, 200))

  // archive all
  await desk.ev(`window.bridge.newGroupChatThread(${J(ALPHA)}, '第二个会话')`)
  await waitFor(async () => (await threads()).length === 2)
  await clickBtn('「alpha-proj」的更多操作'); await waitFor(async () => (await menuItems()).length > 0)
  await clickMenu('归档全部会话')
  const confirm1 = await waitFor(async () => (await menuItems()).find((x) => x.startsWith('再点一次')))
  const still = (await threads()).filter((c) => c.archived).length
  await clickMenu('再点一次')
  const arch = await waitFor(async () => { const t = await threads(); return t.length === 2 && t.every((c) => c.archived) ? t : null })
  check('4 归档全部会话 asks once more (naming the count), then archives both conversations of alpha', typeof confirm1 === 'string' && confirm1.includes('2 个会话') && still === 0 && !!arch, [confirm1, still, await threads()])
  const la = await A.call('chat_channels')
  check('4 Alice no longer sees them', Array.isArray(la.data) && !la.data.some((c) => String(c.id).includes('.c_')), la.raw.slice(0, 300))
  await clickBtn('「整台电脑」的更多操作'); await waitFor(async () => (await menuItems()).length > 0)
  const machineRemove = await desk.ev(`(() => { const m = [...document.querySelectorAll('[role=menuitem]')].find((x) => x.innerText.trim().startsWith('移除项目')); return m ? { disabled: m.getAttribute('aria-disabled'), title: m.getAttribute('title') } : null })()`)
  await desk.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(200)
  check('4 整台电脑 cannot be removed', machineRemove?.disabled === 'true', machineRemove)

  // remove a project
  if ((await menuItems()).length) { await desk.ev(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`); await sleep(200) }
  await clickBtn('「alpha-proj」的更多操作'); await waitFor(async () => (await menuItems()).some((x) => x.startsWith('移除项目')))
  await clickMenu('移除项目')
  const confirm2 = await waitFor(async () => (await menuItems()).find((x) => x.startsWith('再点一次')))
  const before = await desk.ev(`window.bridge.getState().then((s) => s.workspaces.map((w) => w.id))`)
  await clickMenu('再点一次')
  const after = await waitFor(async () => { const w = await desk.ev(`window.bridge.getState().then((s) => s.workspaces.map((w) => w.id))`); return w.includes(ALPHA) ? null : w })
  check('4 移除项目 asks once more, then takes alpha off the list; its folder and file are untouched', typeof confirm2 === 'string' && before.includes(ALPHA) && !!after && fs.readFileSync(path.join(wsA, 'keep.txt'), 'utf8') === 'line one\n' && !(await side()).includes('alpha-proj'), [confirm2, before, after])

  // ===== 5. no system title bar =====
  const tb = await desk.ev(`(() => { const h = document.querySelector('header'); const cs = getComputedStyle(h); const btn = h.querySelector('button'); const wco = navigator.windowControlsOverlay; const rect = wco?.getTitlebarAreaRect?.(); return { overlay: wco?.visible ?? null, areaW: rect ? Math.round(rect.width) : null, areaH: rect ? Math.round(rect.height) : null, vw: window.innerWidth, padRight: parseFloat(cs.paddingRight), region: cs.getPropertyValue('-webkit-app-region') || cs.webkitAppRegion || null, btnRegion: getComputedStyle(btn).getPropertyValue('-webkit-app-region') || getComputedStyle(btn).webkitAppRegion || null, pillsRegion: getComputedStyle(document.querySelector('[data-status-pills]')).getPropertyValue('-webkit-app-region') || null, frame: window.outerHeight - window.innerHeight, stopRight: Math.round([...h.querySelectorAll('button')].find((x) => x.innerText.includes('全部停下')).getBoundingClientRect().right), headerH: Math.round(h.getBoundingClientRect().height) } })()`)
  check('5 the system title bar is gone: the window controls sit over the top bar, which is as tall as they are', tb.overlay === true && tb.areaH === tb.headerH && tb.areaW < tb.vw && tb.frame < 20, tb)
  check('5 the top bar leaves room for them: 全部停下 ends left of the window controls', tb.padRight > 100 && tb.stopRight <= tb.areaW, tb)
  check('5 the top bar drags the window; its buttons and the status pills do not', tb.region === 'drag' && tb.btnRegion === 'no-drag' && tb.pillsRegion === 'no-drag', tb)
  await shot('chat-page-end.png')

  // ===== 6. a narrow sidebar still shows the whole project name =====
  await move(900, 500)
  await desk.ev(`(localStorage.setItem('wb.layout.sideWidth', '200'), location.reload(), 1)`)
  await waitFor(async () => (await newPage().catch(() => null)) !== null, 80, 250)
  await sleep(600)
  const names = () => desk.ev(`(() => { const out = {}; for (const a of document.querySelectorAll('aside [data-project-actions]')) { if (a.offsetParent === null) continue; const row = a.closest('div.cursor-pointer'); const n = row?.querySelector('span.truncate'); if (!n) continue; const o = n.closest('div.truncate'); out[n.innerText.trim()] = { cut: n.scrollWidth > n.clientWidth || (!!o && o.scrollWidth > o.clientWidth), nameW: Math.round(n.getBoundingClientRect().width), actionsW: Math.round(a.getBoundingClientRect().width) } } return { side: Math.round(document.querySelector('aside').getBoundingClientRect().width), rows: out } })()`)
  const narrow = await names()
  const rowsN = Object.values(narrow.rows)
  check('6 with the sidebar dragged narrow, every project name is shown whole and the row buttons take no room', narrow.side <= 230 && rowsN.length >= 2 && rowsN.every((r) => !r.cut && r.nameW > 30 && r.actionsW === 0), narrow)
  const hb = await rowBox('beta-proj')
  await move(hb.x, hb.y); await sleep(250)
  const hovered = await names()
  check('6 pointing at a row brings its three buttons out', hovered.rows['beta-proj']?.actionsW >= 72, [hovered, hb, await desk.ev(`(() => { const e = document.elementFromPoint(${hb.x}, ${hb.y}); return e ? { tag: e.tagName, text: (e.closest('div.cursor-pointer') ?? e).innerText.slice(0, 40), fixed: !!e.closest('.fixed') } : null })()`)])
  await shot('chat-page-narrow.png')
  await move(900, 500)
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
