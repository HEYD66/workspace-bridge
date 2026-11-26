// 实测开发用终端工具（list_commands、wait_for、shell=powershell、env、list_processes、kill_process）
// 起一个独立的 headless 实例（临时数据目录、端口 38767、auto 档 + 开命令执行），用 MCP 客户端调一遍，结束后清掉
// 用法：npx tsx scripts/devtools-live.ts
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const PORT = 38767
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-devtools-'))
const data = path.join(tmp, 'data')
const ws = path.join(tmp, 'ws')
fs.mkdirSync(data)
fs.mkdirSync(ws)
const token = 'wb_devtools_live_token_0123456789abcdef'
fs.writeFileSync(
  path.join(data, 'config.json'),
  JSON.stringify({ workspaceRoot: ws, host: '127.0.0.1', port: PORT, agents: [{ id: 'a-dev', name: 'Dev', token, tier: 'auto', execAllowed: true, createdAt: Date.now() }] })
)

const results: { name: string; ok: boolean }[] = []
function check(name: string, ok: boolean, detail?: unknown): void {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `\n      ${JSON.stringify(detail).slice(0, 600)}` : ''}`)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<{ code: string; data: any }> {
  const r = await c.callTool({ name, arguments: args })
  const body = (r.content as { type: string; text: string }[]).map((p) => p.text).find((t) => !t.startsWith('【通知】')) ?? ''
  let parsed: unknown = body
  try {
    parsed = JSON.parse(body)
  } catch {
    // 纯文本
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { code: r.isError ? ((parsed as any)?.error ?? 'SDK_ERROR') : 'OK', data: parsed }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const server = spawn(process.execPath, [path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/core/headless.ts', '--data', data, '--port', String(PORT)], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, WB_USER_SKILLS_DIR: path.join(tmp, 'skills') }
})
let serverLog = ''
server.stdout.on('data', (d) => (serverLog += d))
server.stderr.on('data', (d) => (serverLog += d))

async function main(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break
    } catch {
      // 还没起来
    }
    await sleep(500)
  }
  const c = new Client({ name: 'devtools-live', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp/${token}`)))
  try {
    const tools = (await c.listTools()).tools.map((t) => t.name)
    check('工具列表里有 list_commands / list_processes / kill_process', ['list_commands', 'list_processes', 'kill_process'].every((n) => tools.includes(n)), tools)

    // env + bash
    const e = await call(c, 'run_command', { command: 'echo "v=$WB_X"', env: { WB_X: "a'b\"c 中文" } })
    check('bash：env 生效（引号、中文原样）', e.code === 'OK' && String(e.data?.output ?? '').includes(`v=a'b"c 中文`), e.data)
    const e2 = await call(c, 'run_command', { command: 'echo "after=${WB_X:-none}"' })
    check('bash：env 不残留到下一条命令', String(e2.data?.output ?? '').includes('after=none'), e2.data)

    // powershell
    const p = await call(c, 'run_command', { command: '$PSVersionTable.PSVersion.Major; "ps=" + $env:WB_Y; Get-Location | Select-Object -ExpandProperty Path', shell: 'powershell', env: { WB_Y: '你好' } })
    check('powershell：能跑、env 生效、中文输出正常', p.code === 'OK' && String(p.data?.output ?? '').includes('ps=你好'), p.data)
    const pe = await call(c, 'run_command', { command: 'exit 3', shell: 'powershell' })
    check('powershell：退出码传回来', pe.data?.exit_code === 3, pe.data)

    // 后台开发服务器 + wait_for + list_processes + list_commands + kill_process
    const srv = await call(c, 'run_command', {
      command: `node -e "const s=require('http').createServer((q,r)=>r.end('ok'));s.listen(0,()=>{setTimeout(()=>console.log('ready on '+s.address().port),800)})"`,
      background: true
    })
    const id = srv.data?.command_id
    check('后台起一个开发服务器', srv.code === 'OK' && !!id, srv.data)
    const t0 = Date.now()
    const w = await call(c, 'get_command_output', { command_id: id, wait_for: 'ready on \\d+', wait_ms: 15000 })
    const port = Number(String(w.data?.matched_text ?? '').match(/\d+/)?.[0])
    check(`wait_for 等到 "ready on"（${Date.now() - t0} ms，端口 ${port}）`, w.data?.wait_result === 'matched' && port > 0, w.data)
    const lc = await call(c, 'list_commands', { status: 'running' })
    check('list_commands 能找回这个后台命令', (lc.data?.commands ?? []).some((x: { command_id: string }) => x.command_id === id), lc.data)
    const lp = await call(c, 'list_processes', { port })
    const procs = lp.data?.processes ?? []
    check(`list_processes 按端口 ${port} 找到 node`, procs.length >= 1 && /node/i.test(procs[0]?.name ?? ''), lp.data)
    const kill = await call(c, 'kill_process', { port })
    check('kill_process 按端口结束它', kill.code === 'OK' && (kill.data?.killed ?? []).length >= 1, kill.data)
    const after = await call(c, 'list_processes', { port })
    check('结束后端口上没有进程了', (after.data?.processes ?? []).length === 0, after.data)
    const ex = await call(c, 'get_command_output', { command_id: id, wait_ms: 5000 })
    check('后台命令随之结束', ex.data?.status !== 'running', ex.data)

    // 保护
    const self = await call(c, 'kill_process', { pid: server.pid })
    check('不能结束工作台自己（headless 主进程）', self.code === 'PROTECTED_PROCESS', self)
    const sys = await call(c, 'kill_process', { pid: 4 })
    check('不能结束系统进程（pid 4）', sys.code === 'PROTECTED_PROCESS', sys)
    const both = await call(c, 'kill_process', { pid: 1234, port: 80 })
    check('pid 和 port 同时给被拒', both.code !== 'OK', both)

    // 超时
    const slow = await call(c, 'run_command', { command: 'sleep 30', background: true })
    const to = await call(c, 'get_command_output', { command_id: slow.data?.command_id, wait_for: 'never-appears', wait_ms: 1500 })
    check('wait_for 等不到时按 wait_ms 超时返回', to.data?.wait_result === 'timeout', to.data)
    await call(c, 'cancel_command', { command_id: slow.data?.command_id })
  } finally {
    await c.close().catch(() => {})
  }
}

main()
  .catch((e) => check('脚本异常', false, (e as Error).stack ?? String(e)))
  .finally(async () => {
    if (server.pid) spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
    await sleep(1500)
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    const failed = results.filter((r) => !r.ok).length
    if (failed) console.log('\n--- headless 日志（末尾）---\n' + serverLog.slice(-2000))
    console.log(`\n${results.length - failed} 项通过，${failed} 项失败`)
    process.exit(failed > 0 ? 1 : 0)
  })
