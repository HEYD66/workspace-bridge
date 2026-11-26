// 控制台页面实测：真实 Electron 构建 + MCP 客户端产生数据，检查概览、AI 命令、审计日志、群聊频道几页
// 用法：npm run build 后 npx tsx scripts/console-live.ts（截图存 .e2e-out/console-live/）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const require = createRequire(import.meta.url)
const electronPath: string = require('electron')
const outDir = path.resolve('.e2e-out', 'console-live')
fs.mkdirSync(outDir, { recursive: true })
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-console-'))
const wsA = path.join(base, 'proj-alpha')
const wsB = path.join(base, 'proj-beta')
const data = path.join(base, 'data')
const userData = path.join(base, 'ud')
for (const d of [wsA, wsB, data, userData]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(wsA, 'a.ts'), 'export const a = 1\n')
fs.writeFileSync(path.join(wsB, 'b.ts'), 'export const b = 2\n')
const PORT = 38769
const CDP = 39224
const ALPHA = 'w_a1a1a1a1'
const BETA = 'w_b2b2b2b2'
const agents = [
  { id: 'a-maya', name: 'Maya', color: '#60a5fa', token: 'wb_console_maya_0000000000', createdAt: Date.now() },
  // 权限精简后用户添加的工作区每个 AI 都能用，BetaOnly 只是名字
  { id: 'a-beta', name: 'BetaOnly', color: '#f472b6', token: 'wb_console_beta_0000000000', createdAt: Date.now() }
]
fs.writeFileSync(
  path.join(data, 'config.json'),
  JSON.stringify({
    workspaces: [
      { id: ALPHA, name: 'proj-alpha', root: wsA },
      { id: BETA, name: 'proj-beta', root: wsB }
    ],
    activeWorkspaceId: ALPHA,
    host: '127.0.0.1',
    port: PORT,
    agents
  })
)

const results: { name: string; ok: boolean }[] = []
function check(name: string, ok: boolean, detail?: unknown): void {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `\n      ${JSON.stringify(detail).slice(0, 600)}` : ''}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const { ELECTRON_RUN_AS_NODE: _drop, ...env } = process.env
const app = spawn(electronPath, ['.', `--remote-debugging-port=${CDP}`, `--user-data-dir=${userData}`], {
  cwd: process.cwd(),
  env: { ...env, WB_DATA_DIR: data, WB_USER_SKILLS_DIR: path.join(base, 'skills'), ELECTRON_RENDERER_URL: '' },
  stdio: 'ignore'
})

async function waitFor(url: string, tries = 80): Promise<Response> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url)
      if (r.ok) return r
    } catch {
      // 还没起来
    }
    await sleep(250)
  }
  throw new Error('等待超时：' + url)
}
async function mcp(token: string, name: string): Promise<Client> {
  const c = new Client({ name, version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp/${token}`)))
  return c
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const textOf = (r: any): string => (r.content as { text: string }[]).map((p) => p.text).join('\n')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bodyOf = (r: any): any => {
  const t = (r.content as { text: string }[]).map((p) => p.text).find((x) => !x.startsWith('【通知】')) ?? ''
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}

async function cdp() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const targets = (await (await waitFor(`http://127.0.0.1:${CDP}/json`)).json()) as any[]
  const page = targets.find((t) => t.type === 'page')
  const sock = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => sock.addEventListener('open', r, { once: true }))
  let id = 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pending = new Map<number, (v: any) => void>()
  const errors: string[] = []
  sock.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data))
    if (m.id && pending.has(m.id)) pending.get(m.id)!(m)
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text)
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (method: string, params: any = {}) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new Promise<any>((resolve) => {
      const i = ++id
      pending.set(i, resolve)
      sock.send(JSON.stringify({ id: i, method, params }))
    })
  await call('Runtime.enable')
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  return {
    errors,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eval: async (expr: string): Promise<any> => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value,
    shot: async (file: string) => {
      const r = await call('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(outDir, file), Buffer.from(r.result.data, 'base64'))
    }
  }
}

async function main(): Promise<void> {
  await waitFor(`http://127.0.0.1:${PORT}/health`)
  const ui = await cdp()
  await sleep(1500)

  const maya = await mcp(agents[0].token, 'maya-client')
  const beta = await mcp(agents[1].token, 'beta-client')

  // 产生一些调用：成功、出错、命令
  await maya.callTool({ name: 'read_file', arguments: { path: 'a.ts' } })
  await maya.callTool({ name: 'read_file', arguments: { path: 'nope.ts' } })
  await maya.callTool({ name: 'search', arguments: { query: 'export' } })
  const bg = bodyOf(await maya.callTool({ name: 'run_command', arguments: { command: 'for i in 1 2 3 4 5 6; do echo tick-$i; sleep 1; done', background: true } }))
  check('Maya 起了一条后台命令', !!bg?.command_id, bg)

  // —— 概览 ——
  const navTo = (title: string) => ui.eval(`(() => { const b = document.querySelector('nav button[title=${JSON.stringify(title)}]'); b?.click(); return !!b })()`)
  check('活动栏有「概览」', await navTo('概览'))
  await sleep(1500)
  const ov = await ui.eval(`window.bridge.getOverview(true)`)
  check(`概览数据：Maya 在线、24 小时调用 ${ov?.totals?.calls24h} 次、有错误`, ov?.agents?.find((a: { id: string; online: boolean }) => a.id === 'a-maya')?.online === true && ov.totals.calls24h >= 3 && ov.totals.errors24h >= 1, ov?.totals)
  check('概览数据：运行中命令 ≥ 1', ov?.runningCommands >= 1, ov?.runningCommands)
  const ovText = await ui.eval(`document.querySelector('main')?.innerText ?? ''`)
  check('概览页显示了 AI 表格（Maya / BetaOnly）', ovText.includes('Maya') && ovText.includes('BetaOnly'), ovText.slice(0, 400))
  await ui.shot('01-overview.png')

  // —— AI 命令 ——
  check('活动栏有「AI 命令」', await navTo('AI 命令'))
  await sleep(800)
  const sideText = await ui.eval(`document.querySelector('aside')?.innerText ?? ''`)
  check('AI 命令列表里有这条命令', sideText.includes('tick-'), sideText.slice(0, 300))
  await ui.eval(`(() => { const el = [...document.querySelectorAll('aside div')].find(d => d.textContent.includes('for i in') && d.className.includes('cursor-pointer')); el?.click(); return !!el })()`)
  await sleep(2500)
  // 详情页有两个 pre：上面是命令原文，最后一个是输出
  const out1 = await ui.eval(`(() => { const p = [...document.querySelectorAll('main pre')]; return p[p.length - 1]?.innerText ?? '' })()`)
  check('选中后能看到实时输出（tick-1 …）', /tick-\d/.test(out1), out1.slice(0, 200))
  await ui.shot('02-commands.png')
  const stopped = await ui.eval(`(() => { const b = [...document.querySelectorAll('main button')].find(b => b.textContent.includes('停止')); b?.click(); return !!b })()`)
  check('点「停止」按钮', stopped)
  await sleep(2500)
  const list2 = await ui.eval(`window.bridge.listAiCommands()`)
  const st = list2?.commands?.find((c: { command_id: string }) => c.command_id === bg?.command_id)?.status
  check(`停止后命令状态不是 running（${st}）`, !!st && st !== 'running', st)

  // —— 审计日志 ——
  await sleep(500)
  check('活动栏有「审计日志」', await navTo('审计日志'))
  await sleep(1500)
  const auditText = await ui.eval(`document.querySelector('main')?.innerText ?? ''`)
  check('审计页列出了 read_file / search / run_command', ['read_file', 'search', 'run_command'].every((t) => auditText.includes(t)), auditText.slice(0, 500))
  const q = await ui.eval(`window.bridge.queryAudit({ status: 'error', from: Date.now() - 3600000 })`)
  check('按状态筛出错误（读不存在的文件）', (q?.rows ?? []).some((r: { tool: string; status: string }) => r.tool === 'read_file' && r.status === 'error'), q?.rows?.slice(0, 3))
  await ui.shot('03-audit.png')

  // —— 群聊频道 ——
  const chs = bodyOf(await maya.callTool({ name: 'chat_channels', arguments: {} }))
  const mayaCh = JSON.stringify(chs)
  check('Maya 看得到大厅和两个工作区频道', mayaCh.includes('general') && mayaCh.includes('proj-alpha') && mayaCh.includes('proj-beta'), chs)
  const betaChs = JSON.stringify(bodyOf(await beta.callTool({ name: 'chat_channels', arguments: {} })))
  check('BetaOnly 也看得到两个工作区频道（用户添加的工作区每个 AI 都能用）', betaChs.includes('proj-beta') && betaChs.includes('proj-alpha'), betaChs)
  const machineCh = await beta.callTool({ name: 'chat_send', arguments: { channel: '整台电脑', text: '偷看' } })
  check('BetaOnly 没开整台电脑：往整台电脑的频道发消息被拒', machineCh.isError === true, textOf(machineCh).slice(0, 200))
  await maya.callTool({ name: 'chat_send', arguments: { channel: 'proj-alpha', text: 'alpha 频道的进度：a.ts 读完了' } })
  await beta.callTool({ name: 'chat_send', arguments: { channel: 'proj-beta', text: 'beta 这边也开工了' } })
  await sleep(600)
  check('活动栏有「群聊」', await navTo('群聊'))
  await sleep(1000)
  const groupSide = await ui.eval(`document.querySelector('aside')?.innerText ?? ''`)
  check('群聊侧栏列出大厅和两个工作区频道', groupSide.includes('大厅') && groupSide.includes('proj-alpha') && groupSide.includes('proj-beta'), groupSide.slice(0, 300))
  await ui.eval(`(() => { const el = [...document.querySelectorAll('aside *')].find(e => e.children.length === 0 && e.textContent.trim() === 'proj-alpha'); el?.click(); return !!el })()`)
  await sleep(800)
  const alphaText = await ui.eval(`document.querySelector('main')?.innerText ?? ''`)
  check('proj-alpha 频道显示 Maya 的消息，不显示 beta 的', alphaText.includes('a.ts 读完了') && !alphaText.includes('beta 这边也开工了'), alphaText.slice(0, 300))
  await ui.shot('04-group-channels.png')

  // —— 改动（检查点）——
  await maya.callTool({ name: 'write_file', arguments: { path: 'a.ts', content: 'export const a = 42\n', overwrite: true } })
  await sleep(600)
  check('活动栏有「改动」', await navTo('改动'))
  await sleep(1000)
  const cps = await ui.eval(`window.bridge.listCheckpoints({})`)
  check('listCheckpoints 里有 Maya 刚才改的 a.ts', JSON.stringify(cps).includes('a.ts'), JSON.stringify(cps).slice(0, 300))
  const changesSide = await ui.eval(`document.querySelector('aside')?.innerText ?? ''`)
  check('改动页侧栏列出了 Maya 的会话', changesSide.includes('Maya'), changesSide.slice(0, 300))
  const dry = await ui.eval(`window.bridge.rollbackCheckpoints({ dryRun: true, session: ${JSON.stringify(cps?.sessions?.[0]?.session ?? '')} })`)
  check('dryRun 预演回滚', !!dry && JSON.stringify(dry).includes('a.ts'), dry)
  const rb = await ui.eval(`window.bridge.rollbackCheckpoints({ session: ${JSON.stringify(cps?.sessions?.[0]?.session ?? '')} })`)
  check('用户回滚整个会话后 a.ts 恢复原样', fs.readFileSync(path.join(wsA, 'a.ts'), 'utf8') === 'export const a = 1\n', rb)
  await ui.shot('05-changes.png')

  // —— 接入向导：测试连接 ——
  const conn = await ui.eval(`window.bridge.testConnection('a-maya', 'local')`)
  check(`接入向导「测试连接」本机成功（${conn?.durationMs} ms）`, conn?.ok === true, conn)
  await sleep(300)
  const sess = await ui.eval(`window.bridge.listAgentSessions('a-maya')`)
  check('测试连接不留脏会话（只剩 Maya 自己这一个客户端）', Array.isArray(sess) && sess.length === 1, sess)

  // —— 工具试用 ——
  const pt = await ui.eval(`window.bridge.playgroundTools('a-beta')`)
  check('工具试用：列出 BetaOnly 的工具', Array.isArray(pt) && pt.some((t: { name: string }) => t.name === 'whoami'), pt?.length)
  const pc = await ui.eval(`window.bridge.playgroundCall('a-beta', 'whoami', {})`)
  check('工具试用：以 BetaOnly 身份调 whoami', !pc?.isError && JSON.stringify(pc).includes('BetaOnly'), JSON.stringify(pc).slice(0, 200))
  check('活动栏有「工具试用」', await navTo('工具试用'))
  await sleep(600)
  await ui.shot('06-playground.png')

  // —— 命令面板 ——
  await ui.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true }))`)
  await sleep(400)
  const pal = await ui.eval(`document.querySelector('[role=dialog][aria-label="命令面板"]')?.innerText ?? ''`)
  check('Ctrl+Shift+P 打开命令面板，列出页面和操作', pal.includes('打开：概览') && pal.includes('全部停下'), pal.slice(0, 300))
  await ui.shot('07-palette.png')
  await ui.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

  // —— 成员当前连接：断开 ——
  const dropped = await ui.eval(`window.bridge.disconnectAgent('a-beta')`)
  check('断开 BetaOnly 的连接', dropped >= 1, dropped)
  const again = await beta.callTool({ name: 'whoami', arguments: {} }).then(() => 'ok', (e: Error) => e.message)
  check('断开后旧会话不能再用（客户端需要重新握手）', again !== 'ok', again)

  check('界面没有未捕获异常', ui.errors.length === 0, ui.errors)
  await maya.close()
  await beta.close().catch(() => {})
}

main()
  .catch((e) => check('脚本异常', false, (e as Error).stack ?? String(e)))
  .finally(async () => {
    if (app.pid) spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
    await sleep(2000)
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
    const failed = results.filter((r) => !r.ok).length
    console.log(`\n${results.length - failed} 项通过，${failed} 项失败；截图在 ${outDir}`)
    process.exit(failed > 0 ? 1 : 0)
  })
