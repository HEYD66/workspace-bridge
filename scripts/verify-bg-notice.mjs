// Step 6: a command that went to the background tells its owner when it ends. Checked on an isolated instance of a built candidate.
// Usage (repo root, ELECTRON_RUN_AS_NODE unset): node scripts/verify-bg-notice.mjs <out dir>
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
const electronPath = createRequire(import.meta.url)('electron')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
let pass = 0, fail = 0
const check = (name, ok, detail) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n      ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1200)}`) }

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-vbg-'))
const ws = path.join(base, 'ws'), home = path.join(base, 'home'), data = path.join(base, 'data'), ud = path.join(base, 'ud')
for (const d of [ws, home, data, ud]) fs.mkdirSync(d, { recursive: true })
const TOKEN_A = 'wb_vbg_aaaaaaaaaaaaaaaaaaaaaa', TOKEN_B = 'wb_vbg_bbbbbbbbbbbbbbbbbbbbbb'
let appPid
async function connect(token, port) {
  const c = new Client({ name: 'vbg', version: '1' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  const call = async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 150000 })
    const parts = (r.content ?? []).filter((p) => p.type === 'text').map((p) => p.text)
    const body = parts.find((t) => !t.startsWith('【通知】')) ?? ''
    let data; try { data = JSON.parse(body) } catch { data = body }
    return { isError: Boolean(r.isError), data, notices: parts.filter((t) => t.startsWith('【通知】')).join('\n') }
  }
  return { call, close: () => c.close() }
}
async function main() {
  const PORT = await freePort()
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ workspaces: [{ id: 'w_vbg00000', name: 'vbg', root: ws }], activeWorkspaceId: 'w_vbg00000', host: '127.0.0.1', port: PORT, roles: [],
    agents: [{ id: 'a-1', name: 'probeA', color: '#60a5fa', token: TOKEN_A, createdAt: Date.now() }, { id: 'a-2', name: 'probeB', color: '#f472b6', token: TOKEN_B, createdAt: Date.now() }] }))
  const { ELECTRON_RUN_AS_NODE: _d, ...env } = process.env
  const app = spawn(electronPath, [path.join(OUT, 'main', 'index.js'), `--user-data-dir=${ud}`], { cwd: process.cwd(), env: { ...env, WB_DATA_DIR: data, WB_USER_SKILLS_DIR: path.join(base, 'skills'), WB_MACHINE_ROOT: home, ELECTRON_RENDERER_URL: '' }, stdio: 'ignore' })
  appPid = app.pid
  let up = false
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok } catch { await sleep(250) } }
  if (!up) throw new Error('isolated instance did not come up')
  console.log(`candidate ${OUT}\n`)
  const A = await connect(TOKEN_A, PORT), B = await connect(TOKEN_B, PORT)
  await A.call('whoami'); await B.call('whoami')

  // 1. background command ends while its owner sits in chat_wait: the wait returns early with the notice
  const bg = await A.call('run_command', { command: 'sleep 4; echo bg-one-done', background: true })
  check('run_command background=true returns at once with status=running', bg.data?.status === 'running' && typeof bg.data.command_id === 'string', bg)
  const t0 = Date.now()
  const w = await A.call('chat_wait', { timeout_ms: 60000 })
  const took = Date.now() - t0
  check('chat_wait is woken by the command ending (well before its 60 s timeout), woken_by=notice', took < 30000 && w.data?.woken_by === 'notice', { took, data: w.data, notices: w.notices })
  check('the notice names the command, exit code 0 and the command_id to read the output with', w.notices.includes('[后台命令]') && w.notices.includes('退出码 0') && w.notices.includes('sleep 4; echo bg-one-done') && w.notices.includes(bg.data.command_id), w.notices)
  const out = await A.call('get_command_output', { command_id: bg.data.command_id })
  check('the output is there under that command_id; the notice is not repeated', out.data?.status === 'completed' && String(out.data.output).includes('bg-one-done') && !out.notices.includes(bg.data.command_id), [out.data?.status, out.notices])

  // 2. foreground command that outlives timeout_ms and fails later: notice rides on the owner's next tool result
  const fg = await A.call('run_command', { command: 'sleep 3; (exit 7)', timeout_ms: 1000 })
  check('foreground command past timeout_ms: status=running, still alive', fg.data?.status === 'running', fg.data)
  await sleep(4500)
  const next = await A.call('whoami')
  check('after it fails, the next tool result carries the notice with exit code 7 (failed)', next.notices.includes('[后台命令]') && next.notices.includes('退出码 7（失败）') && next.notices.includes(fg.data.command_id), next.notices)

  // 3. no notice when the result already went back through a call
  const quick = await A.call('run_command', { command: 'echo quick-fg' })
  const watched = await A.call('run_command', { command: 'sleep 2; echo watched', background: true })
  const got = await A.call('get_command_output', { command_id: watched.data.command_id, wait_ms: 20000, wait_for: 'never-matches-zzz' })
  const cancelMe = await A.call('run_command', { command: 'sleep 60', background: true })
  const cancelled = await A.call('cancel_command', { command_id: cancelMe.data.command_id })
  await sleep(1500)
  const quiet = await A.call('whoami')
  check('no notice for: a foreground command that finished in time, one whose end get_command_output was waiting for, one the AI cancelled itself', quick.data?.status === 'completed' && got.data?.wait_result === 'exited' && !cancelled.isError && !quiet.notices.includes('[后台命令]') && !got.notices.includes('[后台命令]') && !cancelled.notices.includes('[后台命令]'), { quick: quick.data?.status, got: got.data?.wait_result, cancelled: cancelled.data, notices: [quiet.notices, got.notices, cancelled.notices] })

  // 4. only the owner is told
  const bOnly = await B.call('run_command', { command: 'sleep 2; echo from-b', background: true })
  await sleep(3500)
  const aSees = await A.call('whoami'), bSees = await B.call('whoami')
  check('the notice goes to the AI that started the command and to nobody else', bSees.notices.includes(bOnly.data.command_id) && !aSees.notices.includes('[后台命令]'), { a: aSees.notices, b: bSees.notices })

  await A.close(); await B.close()
}
main()
  .catch((e) => check('script ran', false, e.stack ?? String(e)))
  .finally(async () => {
    if (appPid) spawn('taskkill', ['/PID', String(appPid), '/T', '/F'], { stdio: 'ignore' })
    await sleep(2500)
    try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* leftover temp */ }
    console.log(`\nPASS ${pass}, FAIL ${fail}`)
    process.exit(fail ? 1 : 0)
  })
