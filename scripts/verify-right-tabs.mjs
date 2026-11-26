// The right panel as closable tabs with a new-tab page and web-page tabs (<webview>). Checked on an isolated instance.
// Usage (repo root, ELECTRON_RUN_AS_NODE unset): node scripts/verify-right-tabs.mjs <out dir> [screenshot dir]
// Isolated: temp data dir, random ports, no tunnel. The pages it opens come from a small local server it starts itself. Kills only the Electron tree it started.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const OUT = path.resolve(process.argv[2] ?? 'out')
const SHOTS = process.argv[3] ? path.resolve(process.argv[3]) : null
const electronPath = createRequire(import.meta.url)('electron')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
let pass = 0, fail = 0
const check = (name, ok, detail) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n      ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 900)}`) }
const J = JSON.stringify

// one CDP connection to the first target that `pick` accepts (the workbench window is the only target of type "page"; web-page tabs are type "webview")
async function attach(port, pick, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(pick)
      if (t) {
        const sock = new WebSocket(t.webSocketDebuggerUrl)
        await new Promise((r, rej) => { sock.addEventListener('open', r, { once: true }); sock.addEventListener('error', rej, { once: true }) })
        let id = 0; const pending = new Map()
        sock.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) pending.get(m.id)(m) })
        const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, (m) => resolve(m.result ?? m.error)); sock.send(J({ id: n, method, params })) })
        const ev = async (expr, userGesture = false) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture }); return r?.exceptionDetails ? { __error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text } : r?.result?.value }
        return { send, ev, close: () => sock.close(), target: t }
      }
    } catch { /* not yet */ }
    await sleep(250)
  }
  return null
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vrt-'))
const wsA = path.join(base, 'alpha'), home = path.join(base, 'home'), data = path.join(base, 'data'), ud = path.join(base, 'ud')
for (const d of [wsA, home, data, ud]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(wsA, 'keep.txt'), 'line one\n')
let appPid, site

async function main() {
  const PORT = await freePort(), CDP = await freePort(), DEAD = await freePort()
  // ----- the pages to open: a tiny local site -----
  const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}<script>window.__born = String(Date.now()) + Math.random()</script></body></html>`
  site = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (u.pathname === '/') { res.setHeader('set-cookie', 'seen=1; Max-Age=3600; Path=/'); res.end(page('Fixture Home', '<a id="next" href="/two">two</a> <a id="pop" href="/pop" target="_blank">pop</a>')) }
    else if (u.pathname === '/two') res.end(page('Fixture Two', '<a id="home" href="/">home</a>'))
    else if (u.pathname === '/pop') res.end(page('Fixture Pop', ''))
    else { res.statusCode = 404; res.end(page('Not Found', '')) }
  })
  await new Promise((r) => site.listen(0, '127.0.0.1', r))
  const SITE = `http://127.0.0.1:${site.address().port}`

  fs.writeFileSync(path.join(data, 'config.json'), J({ workspaces: [{ id: 'w_aaaa0001', name: 'alpha-proj', root: wsA }], activeWorkspaceId: 'w_aaaa0001', host: '127.0.0.1', port: PORT, roles: [], agents: [] }))
  const { ELECTRON_RUN_AS_NODE: _d, ...env } = process.env
  const app = spawn(electronPath, [path.join(OUT, 'main', 'index.js'), `--remote-debugging-port=${CDP}`, `--user-data-dir=${ud}`], { cwd: process.cwd(), env: { ...env, WB_DATA_DIR: data, WB_USER_SKILLS_DIR: path.join(base, 'skills'), WB_MACHINE_ROOT: home, ELECTRON_RENDERER_URL: '', WB_EXIT_PROBE_URL: 'off' }, stdio: 'ignore' })
  appPid = app.pid
  let up = false
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok } catch { await sleep(250) } }
  if (!up) throw new Error('isolated instance did not come up')
  console.log(`candidate ${OUT}\nsite ${SITE}\n`)
  const desk = await attach(CDP, (t) => t.type === 'page')
  if (!desk) throw new Error('no CDP page in the desktop window')
  const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const s = await desk.send('Page.captureScreenshot', { format: 'png' }); if (s?.data) fs.writeFileSync(path.join(SHOTS, name), Buffer.from(s.data, 'base64')) }
  const waitFor = async (fn, ok = (v) => !!v, tries = 40, gap = 250) => { let v; for (let i = 0; i < tries; i++) { v = await fn().catch(() => undefined); if (ok(v)) break; await sleep(gap) } return v }
  await waitFor(() => desk.ev(`!!document.querySelector('[data-right-panel]')`), (v) => v === true, 80)

  // helpers on the workbench page
  const tabs = () => desk.ev(`[...document.querySelectorAll('[data-right-panel] [role=tab]')].map((x) => ({ kind: x.getAttribute('data-right-tab'), id: x.getAttribute('data-tab-id'), text: x.innerText.trim().split('\\n')[0], sel: x.getAttribute('aria-selected') === 'true' }))`)
  const kinds = async () => (await tabs()).map((t) => t.kind)
  const sel = async () => (await tabs()).find((t) => t.sel)
  const click = (css) => desk.ev(`(() => { const b = document.querySelector(${J(css)}); if (!b) return false; b.click(); return true })()`)
  const clickTab = (kind, nth = 0) => desk.ev(`(() => { const b = [...document.querySelectorAll('[data-right-panel] [role=tab][data-right-tab=${J(kind).slice(1, -1)}]')][${nth}]; if (!b) return false; b.click(); return true })()`)
  const closeTab = (id) => desk.ev(`(() => { const b = document.querySelector('[data-right-panel] [role=tab][data-tab-id=${J(id).slice(1, -1)}] [data-tab-close]'); if (!b) return false; b.click(); return true })()`)
  // type into the address bar of the visible tab and press Enter
  const go = (text) => desk.ev(`(() => { const i = [...document.querySelectorAll('[data-right-panel] input[data-browser-address]')].find((x) => getComputedStyle(x).visibility !== 'hidden' && x.offsetParent !== null); if (!i) return false; i.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${J(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`)
  const address = () => desk.ev(`(() => { const i = [...document.querySelectorAll('[data-right-panel] input[data-browser-address]')].find((x) => getComputedStyle(x).visibility !== 'hidden' && x.offsetParent !== null); return i ? i.value : null })()`)
  const views = () => desk.ev(`document.querySelectorAll('webview[data-browser-view]').length`)
  const stored = () => desk.ev(`JSON.parse(localStorage.getItem('wb.layout.rightTabs') ?? 'null')`)
  const navBtn = (title) => desk.ev(`(() => { const b = [...document.querySelectorAll('[data-browser-tab] button[title=${J(title)}]')].find((x) => getComputedStyle(x).visibility !== 'hidden' && x.offsetParent !== null); return b ? { disabled: b.disabled } : null })()`)
  const clickNav = (title) => desk.ev(`(() => { const b = [...document.querySelectorAll('[data-browser-tab] button[title=${J(title)}]')].find((x) => getComputedStyle(x).visibility !== 'hidden' && x.offsetParent !== null); if (!b || b.disabled) return false; b.click(); return true })()`)
  // run something inside a web-page tab (found by the address it is on)
  const inGuest = async (urlPart, expr, userGesture = false) => { const g = await attach(CDP, (t) => t.type === 'webview' && t.url === urlPart, 20); if (!g) return { __error: 'no web-page target for ' + urlPart }; try { return await g.ev(expr, userGesture) } finally { g.close() } }
  // press a key inside a web-page tab. Through the <webview> element: keys sent over CDP are marked "skip if unhandled" and never reach Electron's before-input-event
  const guestKey = (url, keyCode, modifiers) => desk.ev(`(() => { const w = [...document.querySelectorAll('webview[data-browser-view]')].find((x) => x.getURL() === ${J(url)}); if (!w) return false; w.sendInputEvent({ type: 'keyDown', keyCode: ${J(keyCode)}, modifiers: ${J(modifiers)} }); w.sendInputEvent({ type: 'keyUp', keyCode: ${J(keyCode)}, modifiers: ${J(modifiers)} }); return true })()`)

  // ===== 1. the tab strip =====
  let t = await tabs()
  check('1 a fresh profile starts with the three tool tabs (变更, 任务, 活动), on 活动; there is a 新标签页 button and each tab has a close button', J(t.map((x) => x.kind)) === J(['changes', 'tasks', 'activity']) && t[2].sel && (await desk.ev(`!!document.querySelector('[data-right-panel] [data-right-new]') && document.querySelectorAll('[data-right-panel] [role=tab] [data-tab-close]').length === 3`)), t)

  // ===== 2. the new-tab page =====
  await click('[data-right-new]'); await sleep(300)
  t = await tabs()
  const nt = await desk.ev(`(() => { const p = document.querySelector('[data-right-newtab]'); if (!p) return null; return { tools: [...p.querySelectorAll('[data-newtab-tool]')].map((x) => x.getAttribute('data-newtab-tool')), text: p.innerText, focused: document.activeElement?.hasAttribute('data-browser-address') === true, placeholder: p.querySelector('input[data-browser-address]')?.placeholder } })()`)
  check('2 「+」 opens a new-tab page as a fourth tab: address bar (focused), the tools 变更 / 终端 / 文件 / 任务 / 活动 with their shortcuts (终端 has none: Ctrl+` is the bottom panel, this one opens a tab), and an empty 最近打开', t.length === 4 && t[3].kind === 'newtab' && t[3].sel && t[3].text === '新标签页' && nt && J(nt.tools) === J(['changes', 'terminal', 'files', 'tasks', 'activity']) && nt.focused && nt.placeholder === '搜索或输入网址' && ['工具', 'Ctrl+Shift+G', 'Ctrl+P', '最近打开', '还没有打开过网页'].every((x) => nt.text.includes(x)) && !nt.text.includes('Ctrl+`'), [t, nt])
  await click('[data-right-new]'); await sleep(200)
  check('2 pressing 「+」 again does not add a second new-tab page', (await kinds()).filter((k) => k === 'newtab').length === 1)
  await shot('right-tabs-newtab.png')
  await click('[data-newtab-tool="tasks"]'); await sleep(300)
  t = await tabs()
  check('2 clicking a tool on the new-tab page goes to that tool tab and the new-tab page closes itself', J(t.map((x) => x.kind)) === J(['changes', 'tasks', 'activity']) && t[1].sel, t)

  // ===== 3. closing and reopening a tool tab =====
  await closeTab('tasks'); await sleep(250)
  t = await tabs()
  check('3 closing 任务 removes it and moves to the tab on its right', J(t.map((x) => x.kind)) === J(['changes', 'activity']) && t[1].sel, t)
  await click('[data-right-new]'); await sleep(250); await click('[data-newtab-tool="tasks"]'); await sleep(300)
  t = await tabs()
  check('3 reopening it from the new-tab page puts it back between 变更 and 活动', J(t.map((x) => x.kind)) === J(['changes', 'tasks', 'activity']) && t[1].sel, t)
  await closeTab('changes'); await closeTab('tasks'); await closeTab('activity'); await sleep(300)
  t = await tabs()
  check('3 closing every tab leaves a new-tab page, never an empty panel', t.length === 1 && t[0].kind === 'newtab' && t[0].sel && (await desk.ev(`!!document.querySelector('[data-right-newtab]')`)), t)
  for (const id of ['changes', 'tasks', 'activity']) { if (!(await desk.ev(`!!document.querySelector('[data-right-newtab]')`))) { await click('[data-right-new]'); await sleep(200) } await click(`[data-newtab-tool="${id}"]`); await sleep(250) }
  check('3 all three are back in the usual order', J(await kinds()) === J(['changes', 'tasks', 'activity']), await tabs())

  // ===== 4. 终端 on the new-tab page: a terminal as a tab of the right panel; the same terminal can sit in the bottom panel or here =====
  const bottomShown = () => desk.ev(`(() => { const p = document.querySelector('[data-terminal-panel]'); return !!p && p.offsetParent !== null })()`)
  const termText = (where) => desk.ev(`(() => { const r = document.querySelector(${J(where)} + ' [data-terminal-view] .xterm-rows'); return r ? r.innerText : null })()`)
  const termView = (where) => desk.ev(`document.querySelector(${J(where)} + ' [data-terminal-view]')?.getAttribute('data-terminal-view') ?? null`)
  const liveTerms = () => desk.ev(`window.bridge.terminalList().then((l) => l.map((t) => t.id))`)
  await click('[data-right-new]'); await sleep(250)
  const newId = (await sel())?.id
  await click('[data-newtab-tool="terminal"]')
  const termTab = await waitFor(sel, (v) => v?.kind === 'terminal', 40)
  const termId = await waitFor(() => termView('[data-right-terminal]'), (v) => !!v, 40)
  const drawn = await waitFor(() => desk.ev(`(() => { const x = document.querySelector('[data-right-terminal] [data-terminal-view] .xterm'); const r = x?.getBoundingClientRect(); return !!r && r.width > 100 && r.height > 100 })()`), (v) => v === true, 40)
  const cwdShown = await desk.ev(`document.querySelector('[data-right-terminal] [data-terminal-cwd]')?.innerText ?? ''`)
  const dirOf = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  check('4 终端 on the new-tab page turns that tab into a terminal (same place, not the bottom panel), named after the directory it is in, and the terminal is drawn there', termTab?.kind === 'terminal' && termTab.id === newId && !!termId && drawn === true && !!cwdShown && termTab.text === dirOf(cwdShown) && (await bottomShown()) === false && J(await liveTerms()) === J([termId]), [termTab, newId, termId, drawn, cwdShown, await bottomShown(), await liveTerms()])
  await desk.ev(`window.bridge.terminalWrite(${J(termId)}, 'echo right-tab-' + 'works\\r')`)
  const ranText = await waitFor(() => termText('[data-right-terminal]'), (v) => typeof v === 'string' && v.includes('right-tab-works'), 80)
  check('4 what you run in it shows up there', typeof ranText === 'string' && ranText.includes('right-tab-works'), String(ranText).slice(-300))
  await shot('right-terminal.png')
  await clickTab('tasks'); await sleep(300)
  await clickTab('terminal')
  const backText = await waitFor(() => termText('[data-right-terminal]'), (v) => typeof v === 'string' && v.includes('right-tab-works'), 20)
  check('4 going to another tab and back: the terminal still shows what was there', typeof backText === 'string' && backText.includes('right-tab-works'), String(backText).slice(-200))
  await click('[data-right-terminal] [data-terminal-to-bottom]')
  const moved = await waitFor(async () => ({ shown: await bottomShown(), view: await termView('[data-terminal-panel]'), text: await termText('[data-terminal-panel]'), kinds: await kinds(), tabs: await desk.ev(`[...document.querySelectorAll('[data-terminal-panel] [data-terminal-tab]')].map((x) => x.getAttribute('data-terminal-tab'))`) }), (v) => v?.shown === true && v.view === termId && typeof v.text === 'string' && v.text.includes('right-tab-works'), 40)
  check('4 移到底部面板 moves that very terminal to the bottom panel (its tab on the right is gone, what was on it is still there, nothing was restarted)', moved?.shown === true && moved.view === termId && String(moved.text).includes('right-tab-works') && !moved.kinds.includes('terminal') && J(moved.tabs) === J([termId]) && J(await liveTerms()) === J([termId]), [moved, await liveTerms()])
  await shot('right-terminal-bottom.png')
  await click('[data-terminal-panel] [data-terminal-to-right]')
  const again = await waitFor(async () => ({ sel: await sel(), view: await termView('[data-right-terminal]'), text: await termText('[data-right-terminal]'), shown: await bottomShown() }), (v) => v?.sel?.kind === 'terminal' && v.view === termId && typeof v.text === 'string' && v.text.includes('right-tab-works') && v.shown === false, 40)
  check('4 the button in the bottom panel moves it back to the right as a tab; the bottom panel, now empty, closes and no extra terminal is started', again?.sel?.kind === 'terminal' && again.view === termId && String(again.text).includes('right-tab-works') && again.shown === false && J(await liveTerms()) === J([termId]), [again, await liveTerms()])
  await desk.ev(`location.reload()`)
  await waitFor(() => desk.ev(`!!document.querySelector('[data-right-panel]')`).catch(() => false), (v) => v === true, 80)
  const restored = await waitFor(async () => ({ sel: await sel(), view: await termView('[data-right-terminal]'), text: await termText('[data-right-terminal]') }), (v) => v?.sel?.kind === 'terminal' && v.view === termId && typeof v.text === 'string' && v.text.includes('right-tab-works'), 60)
  check('4 after reloading the workbench the terminal tab is still there with what was on it', restored?.sel?.kind === 'terminal' && restored.view === termId && String(restored.text).includes('right-tab-works'), restored)
  await closeTab(restored?.sel?.id ?? '')
  const closed = await waitFor(async () => ({ kinds: await kinds(), live: await liveTerms() }), (v) => !!v && !v.kinds.includes('terminal') && v.live.length === 0, 40)
  check('4 closing the tab closes that terminal', !!closed && !closed.kinds.includes('terminal') && closed.live.length === 0 && (await bottomShown()) === false, [closed, await bottomShown()])
  // ===== 4f. 文件 on the new-tab page: pick a file with the Ctrl+P picker, read and edit it in a tab of the right panel =====
  const key = async (k, code, vk, modifiers = 0, text) => { await desk.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) }); await desk.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers }) }
  const esc = async () => { await key('Escape', 'Escape', 27); await sleep(300) }
  const quickTarget = () => waitFor(() => desk.ev(`document.querySelector('[data-quick-open-target]')?.getAttribute('data-quick-open-target') ?? null`), (v) => !!v, 40)
  const section = () => desk.ev(`localStorage.getItem('wb.nav.section')`)
  const fileText = () => desk.ev(`document.querySelector('[data-right-file] .view-lines')?.innerText?.replace(/\\u00a0/g, ' ') ?? null`)
  const fileState = () => desk.ev(`(() => { const f = document.querySelector('[data-right-file]'); if (!f) return null; return { path: f.getAttribute('data-right-file'), dirty: f.hasAttribute('data-right-file-dirty'), canSave: !f.querySelector('[data-right-file-save]').disabled, dot: !!document.querySelector('[data-right-panel] [role=tab][aria-selected=true] [data-tab-unsaved]'), notice: f.querySelector('[data-right-file-notice]')?.innerText ?? '', confirm: !!f.querySelector('[data-right-file-confirm]') } })()`)
  const typeInFile = async (text) => { const r = await desk.ev(`(() => { const v = document.querySelector('[data-right-file] .view-lines').getBoundingClientRect(); return { x: Math.round(v.left + 40), y: Math.round(v.top + 10) } })()`); for (const type of ['mousePressed', 'mouseReleased']) await desk.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 }); await sleep(200); for (const ch of text) await key(ch, 'Key' + ch.toUpperCase(), ch.toUpperCase().charCodeAt(0), 0, ch) }
  const keepFile = path.join(wsA, 'keep.txt')
  const sectionBefore = await section()
  await click('[data-right-new]'); await sleep(250)
  const fileTabId = (await sel())?.id
  await click('[data-newtab-tool="files"]')
  const quick = await waitFor(() => desk.ev(`!!document.querySelector('input[placeholder^="按文件名搜索"]')`), (v) => v === true, 20)
  const where = await quickTarget()
  check('4f 文件 on the new-tab page opens 快速打开 (the Ctrl+P picker), which says Enter opens the file in the right panel', quick === true && where === 'right', [quick, where])
  await desk.ev(`(() => { const i = document.querySelector('input[placeholder^="按文件名搜索"]'); i.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'keep'); i.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`)
  await waitFor(() => desk.ev(`[...document.querySelectorAll('[role=dialog][aria-label="快速打开"] [data-row]')].some((r) => r.innerText.includes('keep.txt'))`), (v) => v === true, 40)
  await key('Enter', 'Enter', 13)
  const opened = await waitFor(async () => ({ sel: await sel(), st: await fileState(), text: await fileText(), section: await section() }), (v) => v?.sel?.kind === 'file' && typeof v.text === 'string' && v.text.includes('line one'), 60)
  check('4f picking keep.txt turns that tab into a file tab named after the file, with its content in an editor; the page you were on stays (no jump to the 文件 page)', opened?.sel?.kind === 'file' && opened.sel.id === fileTabId && opened.sel.text === 'keep.txt' && opened.st?.path === 'keep.txt' && String(opened.text).includes('line one') && opened.st.dirty === false && opened.st.canSave === false && opened.section === sectionBefore, [opened, fileTabId, sectionBefore])
  await typeInFile('zq')
  const edited = await waitFor(async () => ({ st: await fileState(), text: await fileText() }), (v) => v?.st?.dirty === true && String(v.text).includes('zq'), 20)
  check('4f typing in it marks the file as not saved (a dot on the tab, 保存 becomes available); nothing is written yet', edited?.st?.dirty === true && edited.st.dot === true && edited.st.canSave === true && String(edited.text).includes('zq') && fs.readFileSync(keepFile, 'utf8') === 'line one\n', [edited, fs.readFileSync(keepFile, 'utf8')])
  await shot('right-file.png')
  await clickTab('tasks'); await sleep(300)
  await clickTab('file')
  const kept = await waitFor(async () => ({ st: await fileState(), text: await fileText() }), (v) => v?.st?.path === 'keep.txt', 20)
  check('4f going to another tab and back keeps what you typed, still not saved', kept?.st?.dirty === true && String(kept.text).includes('zq'), kept)
  await closeTab(fileTabId)
  const asked = await waitFor(fileState, (v) => v?.confirm === true, 20)
  await desk.ev(`[...document.querySelectorAll('[data-right-file-confirm] button')].find((b) => b.innerText.trim() === '取消')?.click()`); await sleep(250)
  const afterCancel = { st: await fileState(), kinds: await kinds() }
  check('4f closing the tab with unsaved changes asks first (保存后关闭 / 不保存 / 取消); 取消 leaves everything as it was', asked?.confirm === true && afterCancel.st?.confirm === false && afterCancel.st.dirty === true && afterCancel.kinds.includes('file'), [asked, afterCancel])
  await click('[data-right-file-save]')
  const saved = await waitFor(async () => ({ st: await fileState(), disk: fs.readFileSync(keepFile, 'utf8') }), (v) => v?.st?.dirty === false && v.disk.includes('zq'), 40)
  check('4f 保存 writes the file and clears the mark', saved?.st?.dirty === false && saved.st.dot === false && saved.disk.includes('zq') && saved.disk.includes('one'), saved)
  await typeInFile('x'); await sleep(1500)
  const own = await fileState()
  check('4f typing again right after saving: your own save is not reported as 被外部改过', own?.dirty === true && own.notice === '', own)
  await key('s', 'KeyS', 83, 2)
  const ctrlS = await waitFor(async () => ({ st: await fileState(), disk: fs.readFileSync(keepFile, 'utf8') }), (v) => v?.st?.dirty === false && v.disk.includes('x'), 40)
  check('4f Ctrl+S with the cursor in the file saves it', ctrlS?.st?.dirty === false && ctrlS.disk.includes('x') && ctrlS.disk.includes('zq'), ctrlS)
  fs.writeFileSync(keepFile, 'changed outside\n')
  await typeInFile('w'); await sleep(200)
  await click('[data-right-file-save]')
  const clash = await waitFor(fileState, (v) => String(v?.notice).includes('磁盘上的内容已经变了'), 40)
  check('4f if the file changed on disk in the meantime, 保存 does not overwrite it: it says so and offers 重新读取 / 仍然覆盖', String(clash?.notice).includes('磁盘上的内容已经变了') && fs.readFileSync(keepFile, 'utf8') === 'changed outside\n', [clash, fs.readFileSync(keepFile, 'utf8')])
  await desk.ev(`[...document.querySelectorAll('[data-right-file-notice] button')].find((b) => b.innerText.trim() === '重新读取')?.click()`)
  const reread = await waitFor(async () => ({ st: await fileState(), text: await fileText() }), (v) => typeof v?.text === 'string' && v.text.includes('changed outside') && v.st?.dirty === false, 40)
  check('4f 重新读取 shows what is on disk now', String(reread?.text).includes('changed outside') && reread?.st?.dirty === false && reread.st.notice === '', reread)
  await click('[data-right-file-open]')
  const inEditor = await waitFor(async () => ({ section: await section(), tab: await desk.ev(`[...document.querySelectorAll('main [title="keep.txt"]')].some((x) => x.offsetParent !== null)`), right: (await sel())?.kind }), (v) => v?.section === 'files' && v.tab === true, 40)
  check('4f 在编辑器里打开 goes to the 文件 page with that file open in the full editor; the file tab on the right stays', inEditor?.section === 'files' && inEditor.tab === true && inEditor.right === 'file', inEditor)
  await desk.ev(`document.body.focus()`); await key('p', 'KeyP', 80, 2)
  const onFilesPage = await quickTarget(); await esc()
  await desk.ev(`document.querySelector('nav[aria-label="页面"] button')?.click()`)
  await waitFor(section, (v) => v !== 'files', 20)
  await key('p', 'KeyP', 80, 2)
  const onOtherPage = await quickTarget(); await esc()
  check('4f Ctrl+P on the 文件 page opens files in the full editor as before; on any other page it opens them in the right panel', onFilesPage === 'editor' && onOtherPage === 'right', [onFilesPage, onOtherPage, await section()])
  await closeTab(fileTabId)
  const fileGone = await waitFor(kinds, (v) => Array.isArray(v) && !v.includes('file'), 20)
  check('4f a file tab with nothing unsaved closes at once', Array.isArray(fileGone) && !fileGone.includes('file') && !(await desk.ev(`!!document.querySelector('[data-right-file-confirm]')`)), fileGone)
  await click('[data-right-new]'); await sleep(250)

  // ===== 5. a web page in a tab =====
  check('5 before any page is opened there is no web-page element in the window', (await views()) === 0)
  const typed = await go(SITE.replace('http://', '') + '/')
  const home1 = await waitFor(() => sel(), (v) => v?.kind === 'browser' && v.text === 'Fixture Home', 60)
  const born1 = await inGuest(SITE + '/', 'window.__born')
  check('5 typing host:port in the new-tab page and pressing Enter turns that tab into a web page: http:// is added, the page loads, the tab takes the page title', typed === true && home1?.kind === 'browser' && home1.text === 'Fixture Home' && (await address()) === SITE + '/' && (await views()) === 1 && typeof born1 === 'string', [typed, home1, await address(), born1])
  const probe = await inGuest(SITE + '/', `({ bridge: typeof window.bridge, require: typeof require, process: typeof process, title: document.title, cookie: document.cookie })`)
  check('5 the page is an ordinary web page: it cannot see the workbench API (no window.bridge, no require, no process) and can keep cookies', probe?.bridge === 'undefined' && probe.require === 'undefined' && probe.process === 'undefined' && probe.title === 'Fixture Home' && probe.cookie.includes('seen=1'), probe)
  const st5 = await stored()
  check('5 the tab is remembered with its address', st5?.tabs?.some((x) => x.kind === 'browser' && x.url === SITE + '/' && x.title === 'Fixture Home') && st5.active === home1?.id, st5)
  await shot('right-tabs-browser.png')

  // ===== 6. links, back, forward =====
  const back0 = await navBtn('后退')
  await inGuest(SITE + '/', `document.getElementById('next').click()`, true)
  const two = await waitFor(() => sel(), (v) => v?.text === 'Fixture Two', 40)
  const back1 = await waitFor(() => navBtn('后退'), (v) => v && v.disabled === false, 20)
  check('6 following a link inside the page updates the address bar and the tab title; 后退 becomes available', two?.text === 'Fixture Two' && (await address()) === SITE + '/two' && back0?.disabled === true && back1?.disabled === false && (await navBtn('前进'))?.disabled === true, [two, await address(), back0, back1])
  await clickNav('后退')
  const backHome = await waitFor(() => sel(), (v) => v?.text === 'Fixture Home', 40)
  const fwd = await waitFor(() => navBtn('前进'), (v) => v && v.disabled === false, 20)
  check('6 后退 goes back to the first page, then 前进 is available', backHome?.text === 'Fixture Home' && (await address()) === SITE + '/' && fwd?.disabled === false, [backHome, await address(), fwd])
  await go(SITE + '/two')
  const typedTwo = await waitFor(() => sel(), (v) => v?.text === 'Fixture Two', 40)
  check('6 typing a new address in the same tab navigates it (no extra tab)', typedTwo?.text === 'Fixture Two' && (await kinds()).filter((k) => k === 'browser').length === 1 && typedTwo.id === home1?.id, [typedTwo, await kinds()])
  await clickNav('后退'); await waitFor(() => sel(), (v) => v?.text === 'Fixture Home', 40)

  // ===== 7. a link that wants a new window opens a new tab =====
  await inGuest(SITE + '/', `document.getElementById('pop').click()`, true)
  const pop = await waitFor(() => tabs(), (v) => v?.some((x) => x.text === 'Fixture Pop'), 40)
  const iHome = pop.findIndex((x) => x.id === home1?.id), iPop = pop.findIndex((x) => x.text === 'Fixture Pop')
  check('7 a target=_blank link opens a second web-page tab right after the one it came from and moves to it; no new window', iPop === iHome + 1 && pop[iPop].sel && pop[iPop].kind === 'browser' && (await views()) === 2 && (await address()) === SITE + '/pop', pop)

  // ===== 8. pages stay alive while you look at something else =====
  const bornA = await inGuest(SITE + '/pop', 'window.__born')
  await clickTab('activity'); await sleep(400)
  const hidden = await desk.ev(`[...document.querySelectorAll('webview[data-browser-view]')].map((w) => getComputedStyle(w.closest('.absolute')).visibility)`)
  check('8 moving to 活动 hides both pages without removing them', (await sel())?.kind === 'activity' && (await views()) === 2 && J(hidden) === J(['hidden', 'hidden']) && (await desk.ev(`!!document.querySelector('[data-right-panel] input[placeholder^="搜索路径"]')`)), [await sel(), hidden])
  await clickTab('browser', 1); await sleep(400)
  const bornB = await inGuest(SITE + '/pop', 'window.__born')
  check('8 coming back shows the same page, not a reloaded one', typeof bornA === 'string' && bornA === bornB && (await sel())?.text === 'Fixture Pop', [bornA, bornB])
  await click('[data-right-panel] button[title="收起右栏"]'); await sleep(500)
  const collapsed = await desk.ev(`(() => { const a = document.querySelector('aside[data-right-collapsed]'); return a ? { width: a.getBoundingClientRect().width, vis: getComputedStyle(a).visibility, views: a.querySelectorAll('webview[data-browser-view]').length } : null })()`)
  const bornC = await inGuest(SITE + '/pop', 'window.__born')
  check('8 collapsing the right panel keeps the pages (zero width, hidden, still loaded)', collapsed && collapsed.width === 0 && collapsed.vis === 'hidden' && collapsed.views === 2 && bornC === bornA, [collapsed, bornC])
  await desk.ev(`[...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') ?? '').startsWith('展开右栏'))?.click()`); await sleep(500)
  const bornD = await inGuest(SITE + '/pop', 'window.__born')
  check('8 expanding it again shows the same page', (await desk.ev(`!document.querySelector('aside[data-right-collapsed]') && document.querySelector('[data-right-panel]')?.getBoundingClientRect().width > 200`)) === true && bornD === bornA && (await sel())?.text === 'Fixture Pop', [bornD])

  // ===== 9. shortcuts =====
  await desk.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', code: 'KeyG', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))`); await sleep(300)
  check('9 Ctrl+Shift+G goes to 变更', (await sel())?.kind === 'changes', await sel())
  await clickTab('browser', 1); await sleep(300)
  const k1 = await guestKey(SITE + '/pop', 'L', ['control'])
  const focused = await waitFor(() => desk.ev(`document.activeElement?.hasAttribute('data-browser-address') === true && document.activeElement.value`), (v) => typeof v === 'string', 12)
  check('9 Ctrl+L pressed inside the page puts the cursor in that tab\'s address bar', k1 === true && focused === SITE + '/pop', [k1, focused])
  const k2 = await guestKey(SITE + '/pop', 'W', ['control'])
  const afterW = await waitFor(() => tabs(), (v) => v && !v.some((x) => x.text === 'Fixture Pop'), 12)
  check('9 Ctrl+W pressed inside the page closes that tab', k2 === true && !afterW.some((x) => x.text === 'Fixture Pop') && (await views()) === 1, afterW)

  // ===== 10. a page that cannot be reached =====
  await click('[data-right-new]'); await sleep(250)
  await go(`127.0.0.1:${DEAD}`)
  const err = await waitFor(() => desk.ev(`(() => { const e = [...document.querySelectorAll('[data-browser-error]')].find((x) => getComputedStyle(x).visibility !== 'hidden' && x.offsetParent !== null); return e ? e.innerText : null })()`), (v) => typeof v === 'string', 40)
  check('10 an address nobody answers shows 页面加载失败 with the reason and a 重试 button, and keeps the address in the bar', typeof err === 'string' && err.includes('页面加载失败') && err.includes('ERR_CONNECTION_REFUSED') && err.includes('重试') && (await address()) === `http://127.0.0.1:${DEAD}/`, [err, await address()])
  const deadId = (await sel())?.id
  await closeTab(deadId); await sleep(300)

  // ===== 11. searching, and what the address bar refuses =====
  await click('[data-right-new]'); await sleep(250)
  await go('javascript:alert(1)')
  const searchTab = await waitFor(() => stored(), (v) => v?.tabs?.some((x) => x.kind === 'browser' && x.url.startsWith('https://www.bing.com/search?q=')), 20)
  check('11 something that is not an address (here "javascript:alert(1)") is sent to the search engine as text, not run', !!searchTab?.tabs?.some((x) => x.url === 'https://www.bing.com/search?q=' + encodeURIComponent('javascript:alert(1)')), searchTab)
  await closeTab((await sel())?.id); await sleep(300)

  // ===== 12. after a restart of the page everything is back =====
  const before = await stored()
  await desk.ev(`(location.reload(), 1)`)
  await waitFor(() => desk.ev(`!!document.querySelector('[data-right-panel]')`), (v) => v === true, 80)
  const back = await waitFor(() => tabs(), (v) => v?.some((x) => x.kind === 'browser' && x.text === 'Fixture Home'), 60)
  const born2 = await waitFor(() => inGuest(SITE + '/', 'window.__born'), (v) => typeof v === 'string', 40)
  check('12 after reloading the workbench the same tabs are there and the web page loads again from its remembered address', J(back.map((x) => x.id)) === J(before.tabs.map((x) => x.id)) && back.find((x) => x.sel)?.id === before.active && typeof born2 === 'string' && born2 !== born1 && (await views()) === 1, [back, before])
  await click('[data-right-new]'); await sleep(300)
  const recent = await desk.ev(`[...document.querySelectorAll('[data-newtab-recent]')].map((x) => [x.getAttribute('data-newtab-recent'), x.innerText.trim().split('\\n')[0]])`)
  check('12 最近打开 on the new-tab page lists the pages that were opened, newest first, with their titles; the unreachable one is not there', recent.length >= 3 && recent.some((r) => r[0] === SITE + '/' && r[1].includes('Fixture Home')) && recent.some((r) => r[0] === SITE + '/pop') && !recent.some((r) => r[0].includes(String(DEAD))), recent)
  await shot('right-tabs-recent.png')
  await click(`[data-newtab-recent="${SITE}/two"]`)
  const fromRecent = await waitFor(() => sel(), (v) => v?.text === 'Fixture Two', 40)
  check('12 clicking an entry opens it in that tab', fromRecent?.kind === 'browser' && (await address()) === SITE + '/two', fromRecent)

  // ===== 13. clearing the browsing data =====
  const c1 = await inGuest(SITE + '/two', 'document.cookie')
  const cleared = await desk.ev(`window.bridge.clearBrowserData().then(() => 'ok', (e) => String(e))`)
  const c2 = await inGuest(SITE + '/two', 'document.cookie')
  check('13 清除浏览数据 removes the cookies the pages had set', typeof c1 === 'string' && c1.includes('seen=1') && cleared === 'ok' && c2 === '', [c1, cleared, c2])
  const menu = await desk.ev(`(async () => { const b = [...document.querySelectorAll('[data-browser-tab] button[title="更多"]')].find((x) => getComputedStyle(x).visibility !== 'hidden' && x.offsetParent !== null); b?.click(); await new Promise((r) => setTimeout(r, 250)); const items = [...document.querySelectorAll('[data-browser-menu]')].map((x) => x.getAttribute('data-browser-menu')); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return items })()`)
  check('13 the 「更多」 menu of a web-page tab: 在系统浏览器里打开 / 复制地址 / 开发者工具 / 指纹和 CDP 设置 / 清除浏览数据', J(menu) === J(['external', 'copy', 'devtools', 'settings', 'clear']), menu)

  // ===== 14. the rest of the window still works =====
  const st = await desk.ev(`window.bridge.getState().then((s) => s.workspaces.map((w) => w.name))`)
  check('14 the workbench page itself was never navigated away (its API still answers)', Array.isArray(st) && st.includes('alpha-proj') && (await desk.ev(`location.href`)).startsWith('app://'), st)
}
main()
  .catch((e) => check('script ran', false, e.stack ?? String(e)))
  .finally(async () => {
    try { site?.close() } catch { /* already closed */ }
    if (appPid) spawn('taskkill', ['/PID', String(appPid), '/T', '/F'], { stdio: 'ignore' })
    await sleep(2000)
    try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* leftover temp */ }
    console.log(`\nPASS ${pass}, FAIL ${fail}`)
    process.exit(fail ? 1 : 0)
  })
