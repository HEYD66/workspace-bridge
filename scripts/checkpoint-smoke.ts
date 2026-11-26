// 检查点实测：用这个 worktree 的构建（out/）在 18767 端口起一个独立的工作台实例（临时数据目录、临时工作区），
// 两个 MCP 客户端走一遍「改文件 → 汇总 → 回滚 → 制造冲突 → 提交审查附改动」。不碰正在运行的 8765 和真实数据。
// 用法（先 npm run build）：npx tsx scripts/checkpoint-smoke.ts
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const require = createRequire(import.meta.url)
const electronPath: string = require('electron')

const PORT = Number(process.env.CKPT_PORT ?? 18767)
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ckpt-smoke-'))
const ws = path.join(base, 'ws')
const data = path.join(base, 'data')
fs.mkdirSync(path.join(ws, 'src'), { recursive: true })
fs.mkdirSync(path.join(ws, 'docs'), { recursive: true })
fs.mkdirSync(data)
fs.writeFileSync(path.join(ws, 'src', 'app.ts'), 'export const a = 1\n')
fs.writeFileSync(path.join(ws, 'docs', 'old.md'), 'old\n')

const agents = [
  { id: 'a-alice', name: 'Alice', color: '#60a5fa', tier: 'auto', token: 'wb_ckpt_alice', createdAt: Date.now() },
  { id: 'a-bob', name: 'Bob', color: '#f472b6', tier: 'auto', token: 'wb_ckpt_bob', createdAt: Date.now() }
]
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ workspaceRoot: ws, host: '127.0.0.1', port: PORT, agents }))

function withoutRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _drop, ...rest } = env
  return rest
}

const app = spawn(electronPath, ['.'], {
  cwd: process.cwd(),
  env: { ...withoutRunAsNode(process.env), WB_DATA_DIR: data, WB_USER_SKILLS_DIR: path.join(base, 'user-skills'), ELECTRON_RENDERER_URL: '' },
  stdio: 'ignore'
})

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail?: unknown): void {
  results.push({ name, ok, detail: detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const clients: Client[] = []

async function connect(token: string): Promise<Client> {
  const deadline = Date.now() + 60_000
  for (;;) {
    const c = new Client({ name: 'checkpoint-smoke', version: '1.0.0' })
    try {
      // 默认的「链接直连」模式：token 放在地址里
      await c.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp/${token}`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
      )
      clients.push(c)
      return c
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`60 秒内连不上 ${PORT}：${(e as Error).message}`)
      await sleep(500)
    }
  }
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

const P = (...lines: string[]) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')
const text = (rel: string) => fs.readFileSync(path.join(ws, rel), 'utf8')
const exists = (rel: string) => fs.existsSync(path.join(ws, rel))

async function main(): Promise<void> {
  const alice = await connect('wb_ckpt_alice')
  const bob = await connect('wb_ckpt_bob')

  const names = (await alice.listTools()).tools.map((t) => t.name)
  check('三个检查点工具已注册', ['checkpoint_list', 'changes_summary', 'checkpoint_rollback'].every((n) => names.includes(n)), names)

  // 1. 改文件：一个补丁改、增、删，再 write_file 新建一个
  const multi = P('*** Update File: src/app.ts', '@@', '-export const a = 1', '+export const a = 2', '*** Add File: src/new.ts', '+export const b = 1', '*** Delete File: docs/old.md')
  check('apply_patch 改 / 增 / 删', (await call(alice, 'apply_patch', { patch: multi })).code === 'OK')
  check('write_file 新建 notes/x.md', (await call(alice, 'write_file', { path: 'notes/x.md', content: 'x\n' })).code === 'OK')

  const list = await call(alice, 'checkpoint_list')
  check('checkpoint_list：当前会话 2 个检查点', list.code === 'OK' && list.data.sessions?.[0]?.checkpoints?.length === 2, list.data)

  // 2. 汇总
  const sum = await call(alice, 'changes_summary')
  const files = (sum.data.files ?? []).map((f: { status: string; path: string }) => `${f.status}:${f.path}`)
  check(
    'changes_summary：4 个文件、状态正确、带 diff',
    sum.code === 'OK' && files.join(',') === 'deleted:docs/old.md,added:notes/x.md,modified:src/app.ts,added:src/new.ts' && String(sum.data.diff).includes('+export const a = 2'),
    sum.data
  )
  console.log(`\n--- review_text ---\n${sum.data.review_text}\n-------------------\n`)
  check('检查点没写进工作区', fs.readdirSync(ws).sort().join(',') === 'docs,notes,src', fs.readdirSync(ws))
  const wsData = path.join(data, 'workspaces')
  const ckptDirs = fs.existsSync(wsData) ? fs.readdirSync(wsData).filter((d) => fs.existsSync(path.join(wsData, d, 'checkpoints', 'index.json'))) : []
  check('检查点存在 Bridge 数据目录里（workspaces/<id>/checkpoints/index.json）', ckptDirs.length === 1, fs.existsSync(wsData) ? fs.readdirSync(wsData) : 'workspaces 目录不存在')

  // 3. 回滚
  const dry = await call(alice, 'checkpoint_rollback', { dry_run: true })
  check('dry_run：4 个文件，磁盘不变', dry.code === 'OK' && dry.data.files?.length === 4 && text('src/app.ts') === 'export const a = 2\n', dry.data)
  const rb = await call(alice, 'checkpoint_rollback')
  check(
    '回滚：改过的恢复、删掉的建回来、新建的进回收站、空目录清掉',
    rb.code === 'OK' && text('src/app.ts') === 'export const a = 1\n' && text('docs/old.md') === 'old\n' && !exists('src/new.ts') && !exists('notes'),
    rb.data
  )
  const after = await call(alice, 'changes_summary')
  check('回滚后汇总为 0 个文件', after.data.totals?.files === 0, after.data.totals)
  check('再回滚：NOTHING_TO_ROLLBACK', (await call(alice, 'checkpoint_rollback')).code === 'NOTHING_TO_ROLLBACK')

  // 4. 冲突：检查点之后文件被编辑器改了
  await call(alice, 'apply_patch', { patch: multi })
  fs.writeFileSync(path.join(ws, 'src', 'app.ts'), 'export const a = 99\n')
  const c1 = await call(alice, 'checkpoint_rollback')
  check(
    '外部改过：CONFLICT（modified_after），一个文件都不写',
    c1.code === 'CONFLICT' && c1.data.conflicts?.[0]?.reason === 'modified_after' && exists('src/new.ts') && !exists('docs/old.md'),
    c1.data
  )
  const part = await call(alice, 'checkpoint_rollback', { paths: ['src/new.ts', 'docs/old.md'] })
  check('paths 只回滚没冲突的两个', part.code === 'OK' && !exists('src/new.ts') && text('docs/old.md') === 'old\n' && text('src/app.ts') === 'export const a = 99\n', part.data)

  // 5. 冲突：另一个 AI 后来也改了同一个文件
  await call(alice, 'apply_patch', { patch: P('*** Update File: docs/old.md', '@@', '-old', '+alice') })
  await call(bob, 'apply_patch', { patch: P('*** Update File: docs/old.md', '@@', '-alice', '+bob') })
  const c2 = await call(alice, 'checkpoint_rollback', { paths: ['docs/old.md'] })
  check('别的 AI 改过：CONFLICT（touched_by_other），文件不动', c2.code === 'CONFLICT' && c2.data.conflicts?.[0]?.reason === 'touched_by_other' && text('docs/old.md') === 'bob\n', c2.data)
  const bobStep = (await call(bob, 'checkpoint_list')).data.sessions?.[0]?.checkpoints?.[0]?.id
  check('不能回滚别人的检查点：FORBIDDEN', (await call(alice, 'checkpoint_rollback', { step: bobStep })).code === 'FORBIDDEN')

  // 6. 提交审查附改动
  const t = await call(alice, 'task_create', { title: '检查点实测任务' })
  const ref = t.data.ref
  await call(alice, 'task_claim', { task: ref })
  await call(alice, 'apply_patch', { patch: P('*** Update File: src/app.ts', '@@', '-export const a = 99', '+export const a = 3') })
  const byTask = await call(alice, 'changes_summary', { task: ref })
  check('按任务汇总：1 个文件', byTask.data.totals?.files === 1, byTask.data)
  const rv = await call(alice, 'task_update', { task: ref, status: 'review', result: '实测：a 改成 3', attach_changes: true })
  const resultText = String(rv.data?.result ?? JSON.stringify(rv.data))
  check('task_update attach_changes：交付说明后面附了汇总和 diff', rv.code === 'OK' && resultText.includes('src/app.ts') && resultText.includes('```diff'), rv.data)
  console.log(`\n--- 附了改动的交付说明 ---\n${resultText}\n-------------------------\n`)
}

function stopApp(): void {
  if (app.pid === undefined || app.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
  else app.kill()
}

main()
  .catch((e) => check('脚本异常', false, (e as Error).stack ?? String(e)))
  .finally(async () => {
    for (const c of clients) await c.close().catch(() => {})
    stopApp()
    await sleep(1500)
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    const failed = results.filter((r) => !r.ok).length
    console.log(`\n${results.length - failed} 项通过，${failed} 项失败；临时目录 ${base} ${fs.existsSync(base) ? '没删干净' : '已删除'}`)
    process.exit(failed > 0 ? 1 : 0)
  })
