// File tabs of the right panel when the file itself moves or disappears, and closing the window with unsaved changes. Checked on an isolated instance.
// Usage (repo root, ELECTRON_RUN_AS_NODE unset): node scripts/verify-right-files.mjs <out dir> [screenshot dir]
// Isolated: temp data dir, random ports, no tunnel. Kills only the Electron tree it started.
import { spawn, spawnSync } from 'node:child_process'
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
const J = JSON.stringify
const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

async function attach(port, tries = 80) {
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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vrf-'))
const wsA = path.join(base, 'alpha'), home = path.join(base, 'home'), data = path.join(base, 'data'), ud = path.join(base, 'ud')
for (const d of [wsA, home, data, ud, path.join(wsA, 'docs')]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(wsA, 'moveme.txt'), 'first line\n')
fs.writeFileSync(path.join(wsA, 'docs', 'inner.txt'), 'inner line\n')
fs.writeFileSync(path.join(wsA, 'doomed.txt'), 'doomed line\n')
const TOKEN = 'wb_vrf_aaaaaaaaaaaaaaaaaaaaaa'
let appPid

async function main() {
  const PORT = await freePort(), CDP = await freePort()
  fs.writeFileSync(path.join(data, 'config.json'), J({ workspaces: [{ id: 'w_aaaa0001', name: 'alpha-proj', root: wsA }], activeWorkspaceId: 'w_aaaa0001', host: '127.0.0.1', port: PORT, roles: [], agents: [{ id: 'a-1', name: 'Alice', color: '#60a5fa', token: TOKEN, createdAt: Date.now() }] }))
  const { ELECTRON_RUN_AS_NODE: _d, ...env } = process.env
  const app = spawn(electronPath, [path.join(OUT, 'main', 'index.js'), `--remote-debugging-port=${CDP}`, `--user-data-dir=${ud}`], { cwd: process.cwd(), env: { ...env, WB_DATA_DIR: data, WB_USER_SKILLS_DIR: path.join(base, 'skills'), WB_MACHINE_ROOT: home, ELECTRON_ENABLE_LOGGING: '0' }, stdio: 'ignore' })
  appPid = app.pid
  let up = false
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok } catch { await sleep(250) } }
  if (!up) throw new Error('isolated instance did not come up')
  console.log(`candidate ${OUT}\n`)
  const desk = await attach(CDP)
  if (!desk) throw new Error('no CDP page in the desktop window')
  const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const s = await desk.send('Page.captureScreenshot', { format: 'png' }); if (s?.data) fs.writeFileSync(path.join(SHOTS, name), Buffer.from(s.data, 'base64')) }
  const waitFor = async (fn, ok = (v) => !!v, tries = 40, gap = 250) => { let v; for (let i = 0; i < tries; i++) { v = await Promise.resolve(fn()).catch(() => undefined); if (ok(v)) break; await sleep(gap) } return v }
  await waitFor(() => desk.ev(`!!document.querySelector('[data-right-panel]')`), (v) => v === true, 80)

  const mcp = new Client({ name: 'vrf', version: '1' })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }))
  const call = async (name, args = {}) => { const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 60000 }); const body = (r.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).find((t) => !t.startsWith('【通知】')) ?? ''; return { isError: Boolean(r.isError), raw: body } }
  await call('whoami')

  const tabs = () => desk.ev(`[...document.querySelectorAll('[data-right-panel] [role=tab]')].map((x) => ({ kind: x.getAttribute('data-right-tab'), id: x.getAttribute('data-tab-id'), text: x.innerText.trim().split('\\n')[0], sel: x.getAttribute('aria-selected') === 'true', dot: !!x.querySelector('[data-tab-unsaved]') }))`)
  const sel = async () => (await tabs()).find((t) => t.sel)
  const click = (css) => desk.ev(`(() => { const b = document.querySelector(${J(css)}); if (!b) return false; b.click(); return true })()`)
  const key = async (k, code, vk, modifiers = 0, text) => { await desk.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) }); await desk.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers }) }
  const fileText = () => desk.ev(`document.querySelector('[data-right-file] .view-lines')?.innerText?.replace(/\\u00a0/g, ' ') ?? null`)
  const fileState = () => desk.ev(`(() => { const f = document.querySelector('[data-right-file]'); if (!f) return null; const n = f.querySelector('[data-right-file-notice]'); return { path: f.getAttribute('data-right-file'), dirty: f.hasAttribute('data-right-file-dirty'), notice: n?.innerText ?? '', gone: n?.getAttribute('data-right-file-notice') === 'gone' } })()`)
  const typeInFile = async (text) => { const r = await desk.ev(`(() => { const v = document.querySelector('[data-right-file] .view-lines').getBoundingClientRect(); return { x: Math.round(v.left + 40), y: Math.round(v.top + 10) } })()`); for (const type of ['mousePressed', 'mouseReleased']) await desk.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 }); await sleep(200); for (const ch of text) await key(ch, 'Key' + ch.toUpperCase(), ch.toUpperCase().charCodeAt(0), 0, ch) }
  // the editor of a tab that was just opened or brought to the front may not take the click yet: type again until the file is marked as not saved
  const typeDirty = async (text) => { let st; for (let i = 0; i < 5 && !st?.dirty; i++) { await sleep(300); await typeInFile(text); st = await waitFor(fileState, (v) => v?.dirty === true, 8) } return st }
  // open a file in a tab of the right panel through the new-tab page and the Ctrl+P picker
  const openRight = async (name, expectText) => {
    await click('[data-right-new]'); await sleep(250)
    await click('[data-newtab-tool="files"]')
    await waitFor(() => desk.ev(`!!document.querySelector('input[placeholder^="按文件名搜索"]')`), (v) => v === true, 20)
    await desk.ev(`(() => { const i = document.querySelector('input[placeholder^="按文件名搜索"]'); i.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${J(name)}); i.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`)
    await waitFor(() => desk.ev(`[...document.querySelectorAll('[role=dialog][aria-label="快速打开"] [data-row]')].some((r) => r.innerText.includes(${J(name)}))`), (v) => v === true, 40)
    await key('Enter', 'Enter', 13)
    return waitFor(async () => ({ sel: await sel(), st: await fileState(), text: await fileText() }), (v) => v?.sel?.kind === 'file' && typeof v.text === 'string' && v.text.includes(expectText), 60)
  }

  // ===== 1. an AI renames a file that is open with unsaved changes: the tab follows, nothing typed is lost =====
  const o1 = await openRight('moveme.txt', 'first line')
  const tabId = o1?.sel?.id
  await typeDirty('zq')
  const edited = await waitFor(async () => ({ st: await fileState(), text: await fileText() }), (v) => v?.st?.dirty === true && String(v.text).includes('zq'), 20)
  check('1 seed: moveme.txt open in the right panel with something typed and not saved', o1?.st?.path === 'moveme.txt' && edited?.st?.dirty === true, [o1, edited])
  const mv = await call('move', { from: 'moveme.txt', to: 'renamed.txt' })
  const followed = await waitFor(async () => ({ st: await fileState(), sel: await sel(), text: await fileText() }), (v) => v?.st?.path === 'renamed.txt' && v.sel?.text === 'renamed.txt', 40)
  check('1 an AI renames the file: the same tab now carries the new name and path, what was typed is still there and still marked as not saved, no reload from disk', !mv.isError && followed?.sel?.id === tabId && followed.sel.text === 'renamed.txt' && followed.sel.dot === true && followed.st.path === 'renamed.txt' && followed.st.dirty === true && String(followed.text).includes('zq') && followed.st.notice === '', [mv.raw.slice(0, 200), followed])
  await shot('right-file-renamed.png')
  await click('[data-right-file-save]')
  const saved = await waitFor(async () => ({ st: await fileState(), disk: fs.existsSync(path.join(wsA, 'renamed.txt')) ? fs.readFileSync(path.join(wsA, 'renamed.txt'), 'utf8') : null }), (v) => v?.st?.dirty === false && String(v.disk).includes('zq'), 40)
  check('1 保存 after the rename writes to the new path (no conflict notice), and the old path is not created again', saved?.st?.dirty === false && saved.st.notice === '' && String(saved.disk).includes('zq') && String(saved.disk).includes('first') && !fs.existsSync(path.join(wsA, 'moveme.txt')), saved)

  // ===== 2. the directory of an open file is moved: the tab follows too =====
  const o2 = await openRight('inner.txt', 'inner line')
  const mv2 = await call('move', { from: 'docs', to: 'notes' })
  const followed2 = await waitFor(async () => ({ sel: await sel(), st: await fileState(), text: await fileText(), stored: await desk.ev(`JSON.parse(localStorage.getItem('wb.layout.rightTabs') ?? 'null')?.tabs?.filter((t) => t.kind === 'file').map((t) => t.path)`) }), (v) => v?.st?.path === 'notes/inner.txt', 40)
  check('2 an AI moves the directory an open file is in: the tab follows to the new path (also in what is remembered for the next start), content still shown', o2?.st?.path === 'docs/inner.txt' && !mv2.isError && followed2?.st?.path === 'notes/inner.txt' && String(followed2.text).includes('inner line') && J(followed2.stored) === J(['renamed.txt', 'notes/inner.txt']), [o2?.st, mv2.raw.slice(0, 200), followed2])

  // ===== 3. an open file is deleted: the tab stays and says so; 存回去 creates the file again; 关掉标签 closes without asking =====
  const o3 = await openRight('doomed.txt', 'doomed line')
  await typeDirty('k')
  const del = await call('delete', { path: 'doomed.txt' })
  const gone = await waitFor(async () => ({ sel: await sel(), st: await fileState(), text: await fileText() }), (v) => v?.st?.gone === true, 40)
  check('3 an AI deletes an open file with unsaved changes: the tab is not closed, a notice says the file was deleted and that the unsaved changes are still here', o3?.st?.path === 'doomed.txt' && !del.isError && !fs.existsSync(path.join(wsA, 'doomed.txt')) && gone?.sel?.kind === 'file' && gone.st.gone === true && gone.st.notice.includes('已经被删掉了') && gone.st.notice.includes('没保存的改动还在') && String(gone.text).includes('k') && String(gone.text).includes('line'), [del.raw.slice(0, 200), gone])
  await shot('right-file-gone.png')
  await click('[data-right-file-recreate]')
  const back = await waitFor(async () => ({ st: await fileState(), disk: fs.existsSync(path.join(wsA, 'doomed.txt')) ? fs.readFileSync(path.join(wsA, 'doomed.txt'), 'utf8') : null }), (v) => typeof v?.disk === 'string' && v.st?.gone === false, 40)
  check('3 存回去 writes the file again with what is in the editor, and the notice goes away', typeof back?.disk === 'string' && back.disk.includes('line') && back.disk.includes('k') && back.disk !== 'doomed line\n' && back.st.gone === false && back.st.dirty === false && back.st.notice === '', back)
  const del2 = await call('delete', { path: 'doomed.txt' })
  const gone2 = await waitFor(fileState, (v) => v?.gone === true, 40)
  const before = (await tabs()).filter((t) => t.kind === 'file').length
  await click('[data-right-file-close-gone]')
  const after = await waitFor(async () => (await tabs()).filter((t) => t.kind === 'file').length, (v) => v === before - 1, 20)
  check('3 deleted again with nothing unsaved: the notice says the content shown is from before; 关掉标签 closes that tab at once', !del2.isError && gone2?.gone === true && gone2.notice.includes('删掉之前的内容') && after === before - 1, [gone2, before, after])

  // ===== 4. closing the window with unsaved changes asks first =====
  await desk.ev(`(() => { const b = [...document.querySelectorAll('[data-right-panel] [role=tab][data-right-tab=file]')].find((x) => x.innerText.includes('renamed.txt')); b?.click(); return !!b })()`)
  await waitFor(fileState, (v) => v?.path === 'renamed.txt', 20)
  const dirtyNow = await typeDirty('u')
  const flag = await waitFor(() => desk.ev(`document.documentElement.getAttribute('data-unsaved-files')`), (v) => v === '1', 20)
  check('4 the page says how many files have unsaved changes (data-unsaved-files on <html>; the live switch reads it before it closes the old window)', flag === '1', flag)
  await sleep(600)
  spawnSync('taskkill', ['/PID', String(appPid)], { stdio: 'ignore' })
  await sleep(5000)
  const stillThere = { alive: pidAlive(appPid), health: await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false), page: await Promise.race([fileState(), sleep(3000).then(() => 'no answer')]) }
  check('4 asking the window to close (the way the live switch and Alt+F4 do) while a file has unsaved changes does not close it: the workbench keeps running and the unsaved text is still in the editor', dirtyNow?.dirty === true && stillThere.alive === true && stillThere.health === true && stillThere.page?.dirty === true, [dirtyNow, stillThere])
  await mcp.close().catch(() => undefined)
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
