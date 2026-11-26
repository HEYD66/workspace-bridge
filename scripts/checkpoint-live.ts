// 在真实运行的工作台（默认 127.0.0.1:8765，真实数据目录）上实测三个检查点工具。
// 只在工作区里的 _mcp_ckpt_live_tmp/ 下建文件，最后回滚掉（新建的进回收站、空目录清掉）。
// 用法：npx tsx scripts/checkpoint-live.ts [AI 名字片段]
import fs from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const dataDir = process.env.WB_DATA_DIR || path.join(process.env.APPDATA ?? '', 'workspace-bridge', 'bridge')
const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'))
const port = Number(cfg.port ?? 8765)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const agents: any[] = cfg.agents ?? []
const want = (process.argv[2] ?? '').toLowerCase()
const agent =
  agents.find((a) => want && String(a.name).toLowerCase().includes(want)) ??
  agents.find((a) => a.token)
if (!agent) throw new Error('config.json 里没有带 token 的 AI')
console.log(`实例 127.0.0.1:${port}，身份 ${agent.name}`)

const results: { name: string; ok: boolean }[] = []
function check(name: string, ok: boolean, detail?: unknown): void {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `\n      ${JSON.stringify(detail).slice(0, 800)}` : ''}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function connect(): Promise<Client> {
  const deadline = Date.now() + 60_000
  for (;;) {
    const c = new Client({ name: 'checkpoint-live', version: '1.0.0' })
    try {
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${agent.token}`)))
      return c
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`60 秒内连不上 ${port}：${(e as Error).message}`)
      await sleep(1000)
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

const DIR = '_mcp_ckpt_live_tmp'

async function main(): Promise<void> {
  const c = await connect()
  try {
    const names = (await c.listTools()).tools.map((t) => t.name)
    check('真实实例上三个检查点工具已注册', ['checkpoint_list', 'changes_summary', 'checkpoint_rollback'].every((n) => names.includes(n)), names)

    const w = await call(c, 'write_file', { path: `${DIR}/a.txt`, content: 'one\n' })
    check('write_file 新建测试文件', w.code === 'OK', w.data)
    const p = await call(c, 'apply_patch', { patch: ['*** Begin Patch', `*** Update File: ${DIR}/a.txt`, '@@', '-one', '+two', `*** Add File: ${DIR}/b.txt`, '+b', '*** End Patch'].join('\n') })
    check('apply_patch 改 + 增', p.code === 'OK', p.data)

    const list = await call(c, 'checkpoint_list')
    const cps = list.data?.sessions?.[0]?.checkpoints ?? []
    check('checkpoint_list：本次连接 2 个检查点', list.code === 'OK' && cps.length === 2, list.data)

    const sum = await call(c, 'changes_summary')
    const files = (sum.data?.files ?? []).map((f: { status: string; path: string }) => `${f.status}:${f.path}`)
    check('changes_summary：2 个新增文件、带 diff', sum.code === 'OK' && files.join(',') === `added:${DIR}/a.txt,added:${DIR}/b.txt` && String(sum.data?.diff).includes('+two'), sum.data)
    if (sum.data?.review_text) console.log(`\n--- review_text ---\n${sum.data.review_text}\n-------------------\n`)

    const dry = await call(c, 'checkpoint_rollback', { dry_run: true })
    check('checkpoint_rollback dry_run：2 个文件', dry.code === 'OK' && dry.data?.files?.length === 2, dry.data)
    const stillThere = await call(c, 'read_file', { path: `${DIR}/a.txt` })
    check('dry_run 后文件没动', stillThere.code === 'OK' && JSON.stringify(stillThere.data).includes('two'), stillThere.data)

    const rb = await call(c, 'checkpoint_rollback')
    check('checkpoint_rollback 真回滚成功', rb.code === 'OK', rb.data)
    const gone = await call(c, 'file_info', { path: DIR })
    check('回滚后测试目录已清掉', gone.code !== 'OK' || gone.data?.exists === false, gone.data)
    const after = await call(c, 'changes_summary')
    check('回滚后汇总为 0 个文件', after.data?.totals?.files === 0, after.data?.totals)
    check('再回滚：NOTHING_TO_ROLLBACK', (await call(c, 'checkpoint_rollback')).code === 'NOTHING_TO_ROLLBACK')
  } finally {
    await c.close().catch(() => {})
  }
}

main()
  .catch((e) => check('脚本异常', false, (e as Error).stack ?? String(e)))
  .finally(() => {
    const failed = results.filter((r) => !r.ok).length
    console.log(`\n${results.length - failed} 项通过，${failed} 项失败`)
    process.exit(failed > 0 ? 1 : 0)
  })
