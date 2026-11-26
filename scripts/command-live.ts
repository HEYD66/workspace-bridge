// ⚠ 已过时（2026-11-12 权限精简）：审批弹层、ask 档、命令执行开关都去掉了，本脚本的第 1、2 节和 4b / 4c 会失败。
// 第 3 节（全部停下 / 恢复）和 4a（直接执行）仍然有效；要再用先把审批相关的步骤删掉。
// 命令执行与审批的端到端验证：启动真实 Electron 构建（out/），MCP 客户端调 run_command 等工具，
// 通过 CDP 在界面上点审批、「全部停下」「恢复 AI」，每步截图到 .e2e-out/command-live/
// 用法：先 npm run build，再 npx tsx scripts/command-live.ts
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const require = createRequire(import.meta.url)
const electronPath: string = require('electron')
const outDir = path.resolve('.e2e-out', 'command-live')
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cmd-live-'))
const ws = path.join(base, 'ws')
const data = path.join(base, 'data')
const userData = path.join(base, 'electron-user-data')
fs.mkdirSync(ws, { recursive: true })
fs.mkdirSync(data)
fs.writeFileSync(path.join(ws, 'README.md'), '# command live\n')

const PORT = 28765
const CDP = 29222
const now = Date.now()
const agents = [
  { id: 'a-ask', name: 'AskBot', color: '#60a5fa', tier: 'ask', token: 'wb_cmd_ask', createdAt: now, execAllowed: true },
  { id: 'a-auto', name: 'AutoBot', color: '#f472b6', tier: 'auto', token: 'wb_cmd_auto', createdAt: now, execAllowed: true },
  { id: 'a-noexec', name: 'NoExecBot', color: '#34d399', tier: 'auto', token: 'wb_cmd_noexec', createdAt: now }
]
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ workspaceRoot: ws, host: '127.0.0.1', port: PORT, agents }))

function withoutRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _drop, ...rest } = env
  return rest
}

const app = spawn(electronPath, ['.', `--remote-debugging-port=${CDP}`, `--user-data-dir=${userData}`], {
  cwd: process.cwd(),
  env: { ...withoutRunAsNode(process.env), WB_DATA_DIR: data, WB_USER_SKILLS_DIR: path.join(base, 'user-skills'), ELECTRON_RENDERER_URL: '' },
  stdio: 'ignore'
})
console.log(`Electron PID ${app.pid}`)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail?: unknown): void {
  const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail)
  results.push({ name, ok, detail: d?.slice(0, 600) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && d ? `\n      ${d.slice(0, 600)}` : ''}`)
}

async function waitFor(url: string, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url)
      if (r.ok) return r
    } catch {}
    await sleep(250)
  }
  throw new Error('等待超时：' + url)
}

async function mcp(token: string, name: string) {
  const c = new Client({ name, version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  return c
}

/** 工具结果第一段文本按 JSON 解析；isError 时是 { error, message } */
function parse(r: any): any {
  const t = r?.content?.[0]?.text ?? ''
  try {
    return { isError: !!r.isError, ...JSON.parse(t) }
  } catch {
    return { isError: !!r.isError, raw: t }
  }
}
const call = async (c: Client, name: string, args: Record<string, unknown>) =>
  parse(await c.callTool({ name, arguments: args }, undefined, { timeout: 180_000 }))

/** 极简 CDP 客户端（Node 自带 WebSocket） */
async function cdp() {
  const targets = (await (await waitFor(`http://127.0.0.1:${CDP}/json`)).json()) as any[]
  const page = targets.find((t) => t.type === 'page')
  const sock = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => sock.addEventListener('open', r, { once: true }))
  let id = 0
  const pending = new Map<number, (v: any) => void>()
  const errors: string[] = []
  sock.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data))
    if (m.id && pending.has(m.id)) pending.get(m.id)!(m)
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text)
  })
  const send = (method: string, params: any = {}) =>
    new Promise<any>((resolve) => {
      const i = ++id
      pending.set(i, resolve)
      sock.send(JSON.stringify({ id: i, method, params }))
    })
  await send('Runtime.enable')
  return {
    errors,
    eval: async (expr: string) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value,
    shot: async (file: string) => {
      const r = await send('Page.captureScreenshot', { format: 'png' })
      if (r.result?.data) fs.writeFileSync(path.join(outDir, file), Buffer.from(r.result.data, 'base64'))
    },
    close: () => sock.close()
  }
}
type Ui = Awaited<ReturnType<typeof cdp>>

const DIALOG = `document.querySelector('[role=dialog][aria-labelledby=tool-approval-title]')`
/** 等审批弹层出现，返回标题 + 正文 */
async function waitDialog(ui: Ui, ms = 15_000): Promise<string | null> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const t = (await ui.eval(`(() => { const d = ${DIALOG}; return d ? d.innerText : null })()`)) as string | null
    if (t) return t
    await sleep(150)
  }
  return null
}
/** 在审批弹层里点文字完全匹配的按钮；等按钮解锁（弹出后锁 1 秒） */
async function clickDialog(ui: Ui, label: string, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const r = await ui.eval(
      `(() => { const d = ${DIALOG}; if (!d) return 'nodialog'; const b = [...d.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!b) return 'nobutton'; if (b.disabled) return 'disabled'; b.click(); return 'ok' })()`
    )
    if (r === 'ok') return true
    await sleep(150)
  }
  return false
}
const dialogGone = async (ui: Ui, ms = 5_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!(await ui.eval(`!!${DIALOG}`))) return true
    await sleep(100)
  }
  return false
}
/** 点顶栏文字完全匹配的按钮（「全部停下」「恢复 AI」） */
const clickHeader = (ui: Ui, label: string) =>
  ui.eval(`(() => { const b = [...document.querySelectorAll('header button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); b?.click(); return !!b })()`) as Promise<boolean>

/** 轮询命令直到不再 running */
async function waitDone(c: Client, commandId: string, ms = 30_000): Promise<any> {
  const end = Date.now() + ms
  let last: any
  while (Date.now() < end) {
    last = await call(c, 'get_command_output', { command_id: commandId })
    if (last.status !== 'running') return last
    await sleep(300)
  }
  return last
}
/** 等输出里出现某段文字 */
async function waitOutput(c: Client, commandId: string, text: string, ms = 20_000): Promise<any> {
  const end = Date.now() + ms
  let last: any
  while (Date.now() < end) {
    last = await call(c, 'get_command_output', { command_id: commandId })
    if (String(last.output ?? '').includes(text)) return last
    await sleep(300)
  }
  return last
}
let fatal: unknown
const clients: Client[] = []
try {
  await waitFor(`http://127.0.0.1:${PORT}/health`)
  const ui = await cdp()
  await sleep(1500)
  await ui.shot('00-start.png')
  const ask = await mcp('wb_cmd_ask', 'ask-ai')
  const auto = await mcp('wb_cmd_auto', 'auto-ai')
  const noexec = await mcp('wb_cmd_noexec', 'noexec-ai')
  clients.push(ask, auto, noexec)

  // ===== 1. ask 档：批准后执行、拒绝后返回 APPROVAL_REJECTED =====
  {
    const p = call(ask, 'run_command', { command: 'echo approved-$((40+2))', timeout_ms: 30_000 })
    const text = await waitDialog(ui)
    check('1a ask 档 run_command 弹出审批', !!text && text.includes('AskBot') && text.includes('echo approved'), text)
    await ui.shot('01-approval-dialog.png')
    check('1b 点「允许这一次」', await clickDialog(ui, '允许这一次'))
    const r = await p
    check('1c 批准后命令执行完成', !r.isError && r.status === 'completed' && r.exit_code === 0, r)
    await ui.shot('02-approved.png')
    const out = r.command_id ? await call(ask, 'get_command_output', { command_id: r.command_id }) : r
    check('1d get_command_output 读到输出', !out.isError && String(out.output ?? '').includes('approved-42'), out)

    const p2 = call(ask, 'run_command', { command: 'echo should-not-run', timeout_ms: 30_000 })
    const text2 = await waitDialog(ui)
    check('1e 第二次调用再次弹出审批', !!text2 && text2.includes('should-not-run'), text2)
    await ui.shot('03-approval-dialog-2.png')
    check('1f 点「拒绝」', await clickDialog(ui, '拒绝'))
    const r2 = await p2
    check('1g 拒绝后返回 APPROVAL_REJECTED', r2.isError && r2.error === 'APPROVAL_REJECTED', r2)
    check('1h 弹层关闭', await dialogGone(ui))
    await ui.shot('04-rejected.png')
  }

  // ===== 2. send_command_input 给交互命令输入；cancel_command 取消长命令 =====
  {
    const p = call(ask, 'run_command', { command: 'read -p "name? " n; echo "hello-$n"', background: true })
    await waitDialog(ui)
    await ui.shot('05-interactive-approval.png')
    const okClick = await clickDialog(ui, '允许这一次')
    const r = await p
    check('2a 交互命令批准后在后台运行', okClick && !r.isError && r.status === 'running' && !!r.command_id, r)
    if (r.command_id) {
      await waitOutput(ask, r.command_id, 'name?', 10_000)
      const pi = call(ask, 'send_command_input', { command_id: r.command_id, input: 'bridge' })
      const t = await waitDialog(ui)
      check('2b ask 档 send_command_input 弹出审批', !!t && t.includes('bridge'), t)
      await ui.shot('06-input-approval.png')
      await clickDialog(ui, '允许这一次')
      const ri = await pi
      check('2c send_command_input 成功', !ri.isError && ri.bytes_sent > 0, ri)
      const done = await waitDone(ask, r.command_id)
      check('2d 交互命令读到输入并结束', done.status === 'completed' && String(done.output ?? '').includes('hello-bridge'), done)
    }
    await ui.shot('07-interactive-done.png')

    const long = await call(auto, 'run_command', { command: 'echo long-start; sleep 300; echo long-end', background: true })
    check('2e 长命令在后台运行', !long.isError && long.status === 'running', long)
    if (long.command_id) {
      await waitOutput(auto, long.command_id, 'long-start', 10_000)
      const c = await call(auto, 'cancel_command', { command_id: long.command_id })
      check('2f cancel_command 取消长命令', !c.isError && c.status !== 'running', c)
      const after = await waitDone(auto, long.command_id, 10_000)
      check('2g 取消后状态不是 running、没有 long-end', after.status !== 'running' && !String(after.output ?? '').includes('long-end'), after)
    }
    await ui.shot('08-cancelled.png')
  }
  // ===== 3. 「全部停下」取消正在跑的命令，之后 PAUSED；「恢复 AI」后正常 =====
  {
    const long = await call(auto, 'run_command', { command: 'echo stop-start; sleep 300; echo stop-end', background: true })
    check('3a 长命令在后台运行', !long.isError && long.status === 'running', long)
    if (long.command_id) await waitOutput(auto, long.command_id, 'stop-start', 10_000)
    await ui.shot('09-before-stop.png')
    check('3b 点「全部停下」', await clickHeader(ui, '全部停下'))
    await sleep(2500)
    await ui.shot('10-stopped.png')
    const paused = await ui.eval(`window.bridge.getState().then(s => s.paused)`)
    check('3c 界面进入暂停', paused === true && (await ui.eval(`document.body.innerText.includes('恢复 AI')`)) === true, { paused })
    if (long.command_id) {
      const after = await waitDone(auto, long.command_id, 10_000)
      check('3d 正在跑的命令被取消（暂停时仍能读输出）', !after.isError && after.status !== 'running' && !String(after.output ?? '').includes('stop-end'), after)
    }
    const rp = await call(auto, 'run_command', { command: 'echo while-paused' })
    check('3e 暂停后 run_command 返回 PAUSED', rp.isError && rp.error === 'PAUSED', rp)
    const rp2 = await call(ask, 'run_command', { command: 'echo while-paused-ask' })
    check('3f 暂停后 ask 档也直接 PAUSED、不弹审批', rp2.isError && rp2.error === 'PAUSED' && !(await ui.eval(`!!${DIALOG}`)), rp2)
    check('3g 点「恢复 AI」', await clickHeader(ui, '恢复 AI'))
    await sleep(800)
    await ui.shot('11-resumed.png')
    const rr = await call(auto, 'run_command', { command: 'echo resumed-ok', timeout_ms: 30_000 })
    check('3h 恢复后命令正常执行', !rr.isError && rr.status === 'completed' && String(rr.output ?? '').includes('resumed-ok'), rr)
  }

  // ===== 4. auto 档不弹审批；没开命令执行的身份被拒 =====
  {
    const before = (await ui.eval(`window.bridge.listApprovals().then(l => l.length)`)) as number
    const p = call(auto, 'run_command', { command: 'echo auto-direct', timeout_ms: 30_000 })
    let sawDialog = false
    let settled = false
    void p.finally(() => (settled = true))
    while (!settled) {
      if (await ui.eval(`!!${DIALOG}`)) sawDialog = true
      await sleep(100)
    }
    const r = await p
    check('4a auto 档直接执行、不弹审批', !r.isError && String(r.output ?? '').includes('auto-direct') && !sawDialog && before === 0, { r, sawDialog, before })
    await ui.shot('12-auto-direct.png')
    const n = await call(noexec, 'run_command', { command: 'echo nope' })
    check('4b 没开命令执行的身份 run_command 返回 EXEC_DISABLED', n.isError && n.error === 'EXEC_DISABLED', n)
    const ni = await call(noexec, 'send_command_input', { command_id: 'c_whatever', input: 'x' })
    check('4c 没开命令执行的身份 send_command_input 也被拒', ni.isError && ni.error === 'EXEC_DISABLED', ni)
    await ui.shot('13-noexec.png')
  }

  // ===== 5. PowerShell 与 Git Bash =====
  {
    const ps = await call(auto, 'run_command', { command: `powershell.exe -NoProfile -NonInteractive -Command 'Write-Output ("ps-" + (6*7)); $PSVersionTable.PSEdition'`, timeout_ms: 60_000 })
    check('5a Windows PowerShell（powershell.exe）可用', !ps.isError && ps.exit_code === 0 && String(ps.output ?? '').includes('ps-42'), ps)
    const hasPwsh = await call(auto, 'run_command', { command: 'command -v pwsh.exe || command -v pwsh || echo NO_PWSH', timeout_ms: 30_000 })
    if (!String(hasPwsh.output ?? '').includes('NO_PWSH')) {
      const p7 = await call(auto, 'run_command', { command: `pwsh -NoProfile -NonInteractive -Command 'Write-Output ("pwsh-" + (6*7))'`, timeout_ms: 60_000 })
      check('5b PowerShell 7（pwsh）可用', !p7.isError && p7.exit_code === 0 && String(p7.output ?? '').includes('pwsh-42'), p7)
    } else console.log('SKIP  5b 本机 PATH 里没有 pwsh')
    const gb = await call(auto, 'run_command', { command: 'uname -s; echo "bash=$BASH_VERSION"; git --version', timeout_ms: 30_000 })
    const gbOut = String(gb.output ?? '')
    check('5c Git Bash 可用（MINGW/MSYS、bash、git）', !gb.isError && gb.exit_code === 0 && /MINGW|MSYS/.test(gbOut) && /bash=\d/.test(gbOut) && /git version/.test(gbOut), gb)
    const multi = await call(auto, 'run_command', { command: 'x=中文\necho "multi-$x"', timeout_ms: 30_000 })
    check('5d Git Bash 多行 + 中文脚本', !multi.isError && String(multi.output ?? '').includes('multi-中文'), multi)
    await ui.shot('14-shells.png')
  }

  check('5e 界面没有未捕获异常', ui.errors.length === 0, ui.errors)
  ui.close()
} catch (e) {
  fatal = e
  check('脚本未抛异常', false, e instanceof Error ? e.stack : String(e))
} finally {
  for (const c of clients) await c.close().catch(() => {})
  if (app.pid && process.platform === 'win32') spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
  else app.kill()
  await sleep(1000)
  try {
    fs.rmSync(base, { recursive: true, force: true })
  } catch {}
}

const failed = results.filter((r) => !r.ok)
console.log(`\n===== 汇总：${results.length - failed.length} PASS / ${failed.length} FAIL =====`)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`)
console.log(`截图：${outDir}`)
process.exit(failed.length || fatal ? 1 : 0)
