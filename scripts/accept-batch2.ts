// 第 2 批隔离验收脚本（T-24）：起一个隔离的工作台实例，把第 2 批的功能挨个自动测一遍，每项输出 PASS / FAIL / SKIP，最后一张汇总表。
//
// 用法（在 MCP 仓库根目录跑）：
//   npx tsx scripts/accept-batch2.ts --out <候选的 out 目录> [--keep]
//   例：npx tsx scripts/accept-batch2.ts --out _smoke_out/batch1-b68203d-arena002/out
//   --out   候选构建的 out 目录（里面有 main/index.js），默认 ./out
//   --keep  跑完不删临时数据目录（路径会打印出来，方便翻 config、任务、聊天数据）
//
// 隔离：临时数据目录（WB_DATA_DIR / WB_USER_SKILLS_DIR / WB_MACHINE_ROOT / --user-data-dir 都指向它）、随机空闲端口、不开隧道。
// 不碰正在运行的工作台和 cloudflared，跑完只结束自己起的那个 Electron 进程树。
//
// 判定：每项先真跑一遍，过了就 PASS；没过时，如果候选里还没有这项功能（工具不在 tools/list 里，或工具没有对应参数），记 SKIP 并写原因；
// 功能在却没过才是 FAIL。所以在第 1 批候选上跑，第 1 批已有的应该 PASS，第 2 批的应该 SKIP；某一项抛异常只记这一项 FAIL，脚本照样跑完。
// 退出码：有 FAIL 是 1，否则 0（SKIP 不算失败）。
//
// 检查项：
//   1. T-5/T-11  task 和 id 两种写法都认；不认识的参数给【参数提示】、task_get 写错键名报 INVALID_ARGS；read_file raw=true 读出原文
//   2. T-7       派任务唤醒 chat_wait（woken_by=notice）；confirm + ack 以后通知不再出现；读者名不合法返回 INVALID_READER
//   3. T-10      memory 带版本保存，版本对不上返回 CONFLICT 和 current
//   4. T-9       SDK 报错返回干净的 JSON；run_command 里的 ! 和反斜杠原样传过去
//   5. T-15      state 里有 memberStatus，成员调用工具后变成 working
//   6. T-16/T-17 两个 AI 改同一个文件出现【占用提醒】；workspace_brief 返回 7 节
//   7. T-12      screenshot 带 actions 会点击、等待并返回 diagnostics；不合法的 actions 被拒绝
//   8. T-27/第12条 任务允许范围外写文件给【范围提醒】（只提醒不拦）；交审 attach_commands 附【命令证据】且令牌脱敏；task_question 问、答、关
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const argv = process.argv.slice(2)
const outArg = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'out'
const KEEP = argv.includes('--keep')
const OUT = path.resolve(outArg ?? 'out')
const require = createRequire(import.meta.url)
const electronPath: string = require('electron')

type Verdict = 'PASS' | 'FAIL' | 'SKIP'
const results: { item: string; name: string; verdict: Verdict; note: string }[] = []
function record(item: string, name: string, verdict: Verdict, note = ''): void {
  results.push({ item, name, verdict, note })
  console.log(`${verdict}  [${item}] ${name}${note ? `\n      ${note.slice(0, 900)}` : ''}`)
}
/** 跑过就 PASS；没过时 feature=false（候选里还没有）记 SKIP，否则 FAIL */
function judge(item: string, name: string, ok: boolean, feature: boolean, skipWhy: string, detail?: unknown): void {
  if (ok) record(item, name, 'PASS')
  else if (!feature) record(item, name, 'SKIP', skipWhy)
  else record(item, name, 'FAIL', detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail))
}
/** 一项抛异常只记这一项 */
async function section(item: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    record(item, '这一节抛了异常', 'FAIL', (e as Error).stack ?? String(e))
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-accept-b2-'))
const wsA = path.join(base, 'ws-a')
const home = path.join(base, 'home')
const data = path.join(base, 'data')
const userData = path.join(base, 'ud')
for (const d of [wsA, home, data, userData]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(wsA, 'crlf.txt'), 'one\r\ntwo\r\n')
fs.writeFileSync(path.join(wsA, 'shared.txt'), 'v0\n')
fs.writeFileSync(
  path.join(wsA, 'page.html'),
  '<!doctype html><html><body><button id="b" style="width:200px;height:80px" onclick="console.warn(\'accept-clicked\');this.textContent=\'done\'">go</button></body></html>'
)
const TOKEN_A = 'wb_accept_b2_aaaaaaaaaaaaaaaa'
const TOKEN_B = 'wb_accept_b2_bbbbbbbbbbbbbbbb'
const TOKEN_C = 'wb_accept_b2_cccccccccccccccc'
const NAME_B = '验收乙'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
interface R {
  isError: boolean
  blocks: string[]
  data: Any
  ms: number
}
let URL_MCP = ''
async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 'accept-batch2', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(URL_MCP), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  return c
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<R> {
  const t = Date.now()
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 150_000 })
  const blocks = (r.content as { type: string; text?: string }[]).filter((p) => p.type === 'text').map((p) => p.text ?? '')
  let parsed: unknown = blocks[0]
  try {
    parsed = JSON.parse(blocks[0])
  } catch {
    // 纯文本结果
  }
  return { isError: Boolean(r.isError), blocks, data: parsed, ms: Date.now() - t }
}
const code = (r: R): string => (r.isError ? (r.data && typeof r.data === 'object' ? String(r.data.error) : 'NOT_JSON') : 'OK')
/** 结果里所有字符串值（不经 JSON 转义，查反斜杠用） */
function strings(v: unknown, acc: string[] = []): string[] {
  if (typeof v === 'string') acc.push(v)
  else if (Array.isArray(v)) v.forEach((x) => strings(x, acc))
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, acc))
  return acc
}

async function cdpEval(port: number): Promise<((expr: string) => Promise<Any>) | null> {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Any[]
      const page = targets.find((t) => t.type === 'page')
      if (page) {
        const sock = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((r) => sock.addEventListener('open', r, { once: true }))
        let id = 0
        const pending = new Map<number, (v: Any) => void>()
        sock.addEventListener('message', (e) => {
          const m = JSON.parse(String(e.data))
          if (m.id && pending.has(m.id)) pending.get(m.id)!(m)
        })
        return (expr: string) =>
          new Promise<Any>((resolve) => {
            const i = ++id
            pending.set(i, (m) => resolve(m.result?.result?.value))
            sock.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
          })
      }
    } catch {
      // 还没起来
    }
    await sleep(250)
  }
  return null
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(OUT, 'main', 'index.js'))) throw new Error(`--out 目录里没有 main/index.js：${OUT}`)
  const PORT = await freePort()
  const CDP = await freePort()
  URL_MCP = `http://127.0.0.1:${PORT}/mcp`
  fs.writeFileSync(
    path.join(data, 'config.json'),
    JSON.stringify({
      workspaces: [{ id: 'w_acc0000a', name: '验收', root: wsA }],
      activeWorkspaceId: 'w_acc0000a',
      host: '127.0.0.1',
      port: PORT,
      roles: [],
      agents: [
        { id: 'a-1', name: '验收甲', color: '#60a5fa', token: TOKEN_A, createdAt: Date.now() },
        { id: 'a-2', name: NAME_B, color: '#f472b6', token: TOKEN_B, createdAt: Date.now() },
        { id: 'a-3', name: '验收丙', color: '#34d399', token: TOKEN_C, createdAt: Date.now() }
      ]
    })
  )
  console.log(`候选：${OUT}\n数据目录：${base}\n端口：${PORT}（CDP ${CDP}）\n`)
  const { ELECTRON_RUN_AS_NODE: _drop, ...env } = process.env
  const app = spawn(electronPath, [path.join(OUT, 'main', 'index.js'), `--remote-debugging-port=${CDP}`, `--user-data-dir=${userData}`], {
    cwd: process.cwd(),
    env: { ...env, WB_DATA_DIR: data, WB_USER_SKILLS_DIR: path.join(base, 'user-skills'), WB_MACHINE_ROOT: home, ELECTRON_RENDERER_URL: '' },
    stdio: 'ignore'
  })
  appPid = app.pid
  let up = false
  for (let i = 0; i < 120 && !up; i++) {
    try {
      up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok
    } catch {
      await sleep(250)
    }
  }
  if (!up) throw new Error('隔离实例 30 秒内没起来（/health 不通）')
  const ui = await cdpEval(CDP)

  const A = await connect(TOKEN_A)
  const B = await connect(TOKEN_B)
  const tools = (await A.listTools()).tools
  const tool = (n: string) => tools.find((t) => t.name === n)
  const has = (n: string) => Boolean(tool(n))
  const prop = (n: string, p: string) => Boolean((tool(n)?.inputSchema.properties as Record<string, unknown> | undefined)?.[p])
  console.log(`tools/list：${tools.length} 个\n`)

  // ===== 1. T-5 / T-11 =====
  await section('1 T-5/T-11', async () => {
    const idAlias = prop('task_get', 'id')
    const t = await call(A, 'task_create', { title: '验收：别名' })
    const byId = await call(A, 'task_get', { id: t.data.id })
    const byTask = await call(A, 'task_get', { task: t.data.ref })
    judge('1 T-5/T-11', 'task_get 用 task 和 id 两种写法都能查到同一个任务', code(byId) === 'OK' && byId.data.ref === t.data.ref && code(byTask) === 'OK', idAlias, 'task_get 没有 id 参数（T-5 未进）', [byId.data, byTask.data])
    const clash = await call(A, 'task_get', { task: t.data.ref, id: 'T-999' })
    judge('1 T-5/T-11', 'task 和 id 给了不同的值：INVALID_ARGS', code(clash) === 'INVALID_ARGS', idAlias, 'task_get 没有 id 参数（T-5 未进）', clash.data)
    const w = await call(A, 'whoami', { legacy_flag: true })
    const hinted = code(w) === 'OK' && w.blocks.some((b) => b.includes('【参数提示】') && b.includes('legacy_flag'))
    judge('1 T-5/T-11', '不认识的参数（whoami legacy_flag）：结果照常，另给【参数提示】', hinted, idAlias, '没有【参数提示】且 task_get 没有 id 参数（T-5 未进）', w.blocks)
    const bad = await call(A, 'task_get', { task_id: t.data.ref })
    judge('1 T-5/T-11', 'task_get 写错键名 task_id：报 INVALID_ARGS 并提示 task_id', code(bad) === 'INVALID_ARGS' && bad.blocks.some((b) => b.includes('task_id')), idAlias, 'task_get 没有 id 参数（T-5 未进）', bad.blocks)
    const raw = await call(A, 'read_file', { path: 'crlf.txt', raw: true })
    const rawOk = code(raw) === 'OK' && typeof raw.data === 'object' && strings(raw.data).includes('one\r\ntwo\r\n')
    judge('1 T-5/T-11', 'read_file raw=true 读出原文（保留 CRLF 和末尾换行）', rawOk, prop('read_file', 'raw'), 'read_file 没有 raw 参数（第 2 批接线未进）', raw.blocks)
  })

  // ===== 2. T-7 =====
  await section('2 T-7', async () => {
    const confirm = prop('chat_wait', 'confirm') || prop('chat_read', 'confirm')
    await call(B, 'chat_read', {}) // 清掉开头的未读
    const waiting = call(B, 'chat_wait', { timeout_ms: 20_000 })
    await sleep(1500)
    await call(A, 'task_create', { title: '验收：唤醒 chat_wait', assigneeId: NAME_B })
    const w = await waiting
    judge('2 T-7', `派任务唤醒对方的 chat_wait（woken_by=notice，等了 ${Math.round(w.ms / 1000)} 秒）`, code(w) === 'OK' && w.data?.woken_by === 'notice' && w.ms < 15_000, confirm, 'chat_wait 没有唤醒（woken_by），也没有 confirm 参数（T-7 未接线）', { ms: w.ms, data: w.data })

    if (!confirm) {
      record('2 T-7', 'confirm + ack 以后通知不再出现', 'SKIP', 'chat_read / chat_wait 没有 confirm 参数（T-7 未接线）')
    } else {
      const title = '验收：确认后不再通知'
      await call(A, 'task_create', { title, assigneeId: NAME_B })
      const r1 = await call(B, 'chat_read', { confirm: true })
      const ack = r1.data?.next_ack
      const r2 = await call(B, 'chat_read', { ack })
      const after = await call(B, 'whoami')
      const gone = !after.blocks.join('\n').includes(title)
      judge('2 T-7', 'confirm 拿到 next_ack，带 ack 读过以后这条派活通知不再出现', code(r1) === 'OK' && ack !== undefined && code(r2) === 'OK' && gone, true, '', { r1: r1.blocks, r2: r2.blocks, after: after.blocks })
    }

    const res = await fetch(`${URL_MCP}?reader=${encodeURIComponent('bad!name')}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN_C}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'accept-reader', version: '1' } } })
    })
    const text = await res.text()
    judge('2 T-7', '读者名不合法（?reader=bad!name）：握手返回 400 INVALID_READER', res.status === 400 && text.includes('INVALID_READER'), res.status !== 200 || confirm, `握手照常成功（HTTP ${res.status}），候选不认 ?reader=（T-7 未进）`, { status: res.status, body: text.slice(0, 400) })
  })

  // ===== 3. T-10 =====
  await section('3 T-10', async () => {
    const ver = prop('memory_save', 'expected_version')
    if (!has('memory_save')) return record('3 T-10', 'memory 版本号', 'SKIP', 'tools/list 里没有 memory_save')
    const m = await call(A, 'memory_save', { title: '验收记忆', content: 'v1' })
    const id = m.data?.id
    const up = await call(B, 'memory_save', { id, title: '验收记忆', content: 'v2', expected_version: 1 })
    judge('3 T-10', '新建是 version 1，带对的 expected_version 保存变成 version 2', m.data?.version === 1 && code(up) === 'OK' && up.data?.version === 2, ver, 'memory_save 没有 expected_version 参数（T-10 未进）', [m.data, up.data])
    const stale = await call(A, 'memory_save', { id, title: '验收记忆', content: '旧版本覆盖', expected_version: 1 })
    judge('3 T-10', '拿旧版本保存：CONFLICT，带回 current（version 2）', code(stale) === 'CONFLICT' && stale.data?.current?.version === 2, ver, 'memory_save 没有 expected_version 参数（T-10 未进）', stale.data)
  })

  // ===== 4. T-9 =====
  await section('4 T-9', async () => {
    const mark = (tool('run_command')?.description ?? '').includes('+H')
    const why = 'run_command 说明里没有 +H（T-9 接线未进）'
    const miss = await call(A, 'read_file', {})
    let clean = false
    try {
      const j = JSON.parse(miss.blocks[0])
      clean = miss.isError && j.error === 'INVALID_ARGS' && typeof j.message === 'string'
    } catch {
      clean = false
    }
    judge('4 T-9', '缺参数的 SDK 报错返回干净的 JSON { error: INVALID_ARGS, message }', clean, mark, why, miss.blocks)
    const r = await call(A, 'run_command', { command: `echo "bang!ok"; printf '%s\\n' 'C:\\acc\\x'` })
    const all = strings(r.data).join('\n')
    judge('4 T-9', 'run_command 里的 ! 和反斜杠原样传过去', code(r) === 'OK' && all.includes('bang!ok') && all.includes('C:\\acc\\x'), mark, why, r.data)
  })

  // ===== 5. T-15 =====
  await section('5 T-15', async () => {
    if (!ui) return record('5 T-15', 'memberStatus', 'FAIL', `连不上隔离实例的 CDP（端口 ${CDP}），读不到 state`)
    const st0 = await ui(`window.bridge.getState().then((s) => s.memberStatus ?? null)`)
    if (!st0) return record('5 T-15', 'state 里有 memberStatus', 'SKIP', 'getState() 没有 memberStatus（T-15 未进）')
    record('5 T-15', 'state 里有 memberStatus，没连过的成员也有', st0['a-3'] ? 'PASS' : 'FAIL', st0['a-3'] ? '' : JSON.stringify(st0))
    await call(A, 'whoami')
    const st1 = await ui(`window.bridge.getState().then((s) => s.memberStatus ?? null)`)
    const s = st1?.['a-1']?.status
    judge('5 T-15', `成员调用工具后状态变成 working（现在是 ${s}）`, s === 'working', true, '', st1?.['a-1'])
  })

  // ===== 6. T-16 / T-17 =====
  await section('6 T-16/T-17', async () => {
    const claimTool = tools.some((t) => t.name !== 'task_claim' && /claim/.test(t.name)) || (tool('write_file')?.description ?? '').includes('占用')
    await call(A, 'write_file', { path: 'shared.txt', content: 'A 改的\n', overwrite: true })
    const wb = await call(B, 'write_file', { path: 'shared.txt', content: 'B 也改\n', overwrite: true })
    judge('6 T-16/T-17', '两个 AI 先后改同一个文件：后改的结果里有【占用提醒】', wb.blocks.some((b) => b.includes('【占用提醒】')), claimTool, '写文件结果没有【占用提醒】，tools/list 里也没有占用登记工具（T-16 未接线）', wb.blocks)
    if (!has('workspace_brief')) return record('6 T-16/T-17', 'workspace_brief 返回 7 节', 'SKIP', 'tools/list 里没有 workspace_brief（T-17 未接线）')
    const br = await call(A, 'workspace_brief')
    const want = ['rules', 'my_tasks', 'open_tasks', 'messages', 'claims', 'unclaimed', 'memories']
    const got = Object.keys(br.data?.sections ?? {})
    judge('6 T-16/T-17', `workspace_brief 返回 7 节（实际 ${got.length} 节）`, code(br) === 'OK' && want.every((k) => got.includes(k)), true, '', br.blocks[0]?.slice(0, 600))
  })

  // ===== 7. T-12 =====
  await section('7 T-12', async () => {
    if (!prop('screenshot', 'actions')) {
      record('7 T-12', 'screenshot 带 actions 点击、等待并返回 diagnostics', 'SKIP', 'screenshot 没有 actions 参数（T-12 未接线）')
      record('7 T-12', '不合法的 actions 被拒绝', 'SKIP', 'screenshot 没有 actions 参数（T-12 未接线）')
      return
    }
    const ok = await call(A, 'screenshot', { target: 'page', path: 'page.html', include_image: false, wait_ms: 500, diagnostics: true, actions: [{ type: 'click', selector: '#b' }, { type: 'wait', ms: 300 }] })
    const all = ok.blocks.join('\n')
    judge('7 T-12', 'screenshot 带 actions：点了按钮（console 里有 accept-clicked），返回 diagnostics', code(ok) === 'OK' && all.includes('diagnostics') && all.includes('accept-clicked'), true, '', ok.blocks)
    const bad = await call(A, 'screenshot', { target: 'page', path: 'page.html', include_image: false, actions: [{ type: 'explode' }] })
    judge('7 T-12', '不合法的 actions（type=explode）被拒绝', bad.isError, true, '', bad.blocks)
  })

  // ===== 8. T-27 / 第 12 条 =====
  await section('8 T-27', async () => {
    const I = '8 T-27'
    const scopeFeat = prop('task_create', 'allowed_paths')
    const cmdFeat = prop('task_update', 'attach_commands')
    const qFeat = has('task_question')
    if (!scopeFeat && !cmdFeat && !qFeat) {
      for (const n of ['范围外写文件给【范围提醒】', '交审附【命令证据】', 'task_question 问、答、关']) record(I, n, 'SKIP', 'task_create 没有 allowed_paths、task_update 没有 attach_commands、也没有 task_question（第 12 条未接线）')
      return
    }
    const C = await connect(TOKEN_C)
    try {
      // 验收丙手上只有这一个进行中的任务，范围检查按它来
      const t = await call(A, 'task_create', { title: '验收：第 12 条', assigneeId: '验收丙', ...(scopeFeat ? { allowed_paths: ['src/**'] } : {}) })
      const key = t.data.ref
      const st = await call(C, 'task_update', { task: key, status: 'in_progress' })
      if (code(st) !== 'OK') throw new Error(`验收丙开工失败：${st.blocks.join(' ')}`)

      // 范围
      const got = await call(C, 'task_get', { task: key })
      const outW = await call(C, 'write_file', { path: 'outside-scope.txt', content: 'x\n' })
      const inW = await call(C, 'write_file', { path: 'src/in-scope.txt', content: 'y\n' })
      const warned = code(outW) === 'OK' && outW.blocks.some((b) => b.includes('【范围提醒】') && b.includes('outside-scope.txt')) && fs.existsSync(path.join(wsA, 'outside-scope.txt'))
      judge(I, '任务设了 allowed_paths=src/**：写到范围外照常写入，结果里有【范围提醒】', warned, scopeFeat, 'task_create 没有 allowed_paths 参数', outW.blocks)
      judge(I, '写范围内的文件：没有【范围提醒】', code(inW) === 'OK' && !inW.blocks.some((b) => b.includes('【范围提醒】')), scopeFeat, 'task_create 没有 allowed_paths 参数', inW.blocks)
      judge(I, 'task_get 带出 allowedPaths', JSON.stringify(got.data?.allowedPaths) === JSON.stringify(['src/**']), scopeFeat, 'task_create 没有 allowed_paths 参数', got.data)
      const bad = await call(C, 'task_update', { task: key, allowed_paths: ['**'] })
      judge(I, '执行者自己扩大范围：FORBIDDEN', code(bad) === 'FORBIDDEN', scopeFeat, 'task_update 没有 allowed_paths 参数', bad.blocks)

      // 待决定问题
      if (!qFeat) {
        record(I, 'task_question 问、答、关', 'SKIP', 'tools/list 里没有 task_question')
      } else {
        const ask = await call(C, 'task_question', { task: key, action: 'ask', text: '验收：用方案甲还是乙？', options: ['甲', '乙'] })
        const qid = ask.data?.question?.id
        judge(I, `执行者提问：拿到问题编号（${qid}），状态 open`, code(ask) === 'OK' && Boolean(qid) && ask.data?.question?.status === 'open', true, '', ask.blocks)
        const selfAns = await call(C, 'task_question', { task: key, action: 'answer', question_id: qid, answer: '甲' })
        judge(I, '执行者自己回答：FORBIDDEN', code(selfAns) === 'FORBIDDEN', true, '', selfAns.blocks)
        const noQid = await call(A, 'task_question', { task: key, action: 'answer', answer: '甲' })
        judge(I, 'answer 不传 question_id：INVALID_ARGS', code(noQid) === 'INVALID_ARGS', true, '', noQid.blocks)
        const ans = await call(A, 'task_question', { task: key, action: 'answer', question_id: qid, answer: '甲' })
        judge(I, '创建者回答：成功，答案是「甲」', code(ans) === 'OK' && ans.data?.question?.answer === '甲' && ans.data?.question?.status !== 'open', true, '', ans.blocks)
        const ask2 = await call(C, 'task_question', { task: key, action: 'ask', text: '验收：这个问题会被关掉' })
        const q2 = ask2.data?.question?.id
        const close = await call(C, 'task_question', { task: key, action: 'close', question_id: q2, note: '不用决定了' })
        judge(I, '提问的人关掉自己的问题：状态 closed', code(close) === 'OK' && close.data?.question?.status === 'closed', true, '', close.blocks)
        const again = await call(A, 'task_question', { task: key, action: 'answer', question_id: q2, answer: '晚了' })
        judge(I, '已关闭的问题再回答：INVALID_STATE', code(again) === 'INVALID_STATE', true, '', again.blocks)
        const view = await call(A, 'task_get', { task: key })
        const qs = String(view.data?.questions ?? '')
        judge(I, 'task_get 里有【待决定问题】，两题的答案和关闭都看得到', qs.includes('【待决定问题】') && qs.includes('甲') && qs.includes('已关闭') && qs.includes('不用决定了'), true, '', qs)
      }

      // 命令证据（放最后：交审后任务就不在 in_progress 了）
      const run = await call(C, 'run_command', { command: `echo acc-evidence-ok ${TOKEN_A}` })
      const rv = await call(C, 'task_update', { task: key, status: 'review', result: '验收交付', ...(cmdFeat ? { attach_commands: true } : {}) })
      const res = String((await call(A, 'task_get', { task: key })).data?.result ?? '')
      judge(I, '交审带 attach_commands：result 后面附【命令证据】，有命令和真实输出', code(run) === 'OK' && code(rv) === 'OK' && res.includes('【命令证据】') && res.includes('acc-evidence-ok'), cmdFeat, 'task_update 没有 attach_commands 参数', res.slice(0, 900))
      judge(I, '命令证据里的令牌已脱敏（看不到 TOKEN_A 原值）', res.includes('acc-evidence-ok') && !res.includes(TOKEN_A), cmdFeat, 'task_update 没有 attach_commands 参数', res.slice(0, 900))
    } finally {
      await C.close().catch(() => undefined)
    }
  })

  await A.close().catch(() => undefined)
  await B.close().catch(() => undefined)
}

let appPid: number | undefined
main()
  .catch((e) => record('启动', '脚本没能跑起来', 'FAIL', (e as Error).stack ?? String(e)))
  .finally(async () => {
    if (appPid) spawn('taskkill', ['/PID', String(appPid), '/T', '/F'], { stdio: 'ignore' })
    await sleep(2000)
    if (KEEP) console.log(`\n--keep：数据目录留着 ${base}`)
    else fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
    const n = (v: Verdict) => results.filter((r) => r.verdict === v).length
    console.log('\n==== 汇总 ====')
    console.log('结果 | 检查项 | 内容 | 原因')
    for (const r of results) console.log(`${r.verdict} | ${r.item} | ${r.name} | ${r.verdict === 'PASS' ? '' : r.note.split('\n')[0].slice(0, 120)}`)
    console.log(`\nPASS ${n('PASS')}，FAIL ${n('FAIL')}，SKIP ${n('SKIP')}，共 ${results.length} 项`)
    process.exit(n('FAIL') > 0 ? 1 : 0)
  })
