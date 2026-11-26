// 在真实运行的工作台（默认 127.0.0.1:8765，真实数据目录）上实测「整台电脑」工作区。
// 只在 <主目录>/_mcp_machine_live_tmp/ 和 <另一块盘>:/_mcp_machine_live_tmp/ 下建文件，最后用检查点回滚掉，
// 脚本结束时再兜底删一次这两个目录。不碰盘根的删除 / 移动（单测覆盖，真跑风险太大）。
// 用法：npx tsx scripts/machine-live.ts [AI 名字片段]
import fs from 'node:fs'
import os from 'node:os'
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

const NAME = '_mcp_machine_live_tmp'
const cleanup: string[] = []

async function main(): Promise<void> {
  const c = new Client({ name: 'machine-live', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${agent.token}`)))
  try {
    const lw = await call(c, 'list_workspaces')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = (Array.isArray(lw.data) ? lw.data : []).find((w: any) => w.kind === 'machine')
    check('list_workspaces 里有整台电脑（kind machine、带 drives）', !!m && Array.isArray(m.drives) && m.drives.length > 0, lw.data)
    if (!m) {
      console.log('\n这个身份看不到整台电脑：要么运行中的工作台不是新构建，要么要在团队页「能访问的工作区」里勾上它。')
      return
    }
    console.log(`整台电脑 id=${m.id}，盘：${m.drives.join(' ')}，相对路径起点：${m.root}`)
    const ws = m.id

    const home = String(m.root || os.homedir()).replace(/\\/g, '/')
    const homeDrive = home.slice(0, 1).toUpperCase()
    const dirA = `${home}/${NAME}`
    const other = (m.drives as string[]).map((d) => d.slice(0, 1).toUpperCase()).find((d) => d !== homeDrive)
    const dirB = other ? `${other}:/${NAME}` : null
    cleanup.push(dirA)
    if (dirB) cleanup.push(dirB)
    for (const d of cleanup) {
      if (fs.existsSync(d)) throw new Error(`${d} 已经存在，先手动清掉再跑`)
    }

    const wA = await call(c, 'write_file', { workspace: ws, path: `${dirA}/b.txt`, content: 'machine-live home\n' })
    check(`write_file 绝对路径（${homeDrive} 盘主目录下）`, wA.code === 'OK', wA.data)
    const rRel = await call(c, 'read_file', { workspace: ws, path: `${NAME}/b.txt` })
    check('read_file 相对路径从主目录算起', rRel.code === 'OK' && JSON.stringify(rRel.data).includes('machine-live home'), rRel.data)

    if (dirB) {
      const wB = await call(c, 'write_file', { workspace: ws, path: `${dirB}/a.txt`, content: 'machine-live other drive\n' })
      check(`write_file 另一块盘（${other}:）`, wB.code === 'OK', wB.data)
      const rB = await call(c, 'read_file', { workspace: ws, path: `${dirB}/a.txt` })
      check(`read_file 另一块盘（${other}:）`, rB.code === 'OK' && JSON.stringify(rB.data).includes('other drive'), rB.data)
      const ff = await call(c, 'find_files', { workspace: ws, path: dirB, pattern: 'a.txt' })
      check('find_files 以另一块盘上的目录为起点', ff.code === 'OK' && ff.data?.count === 1, ff.data)
    } else {
      console.log('SKIP  只有一块盘，跳过跨盘读写、跨盘 move')
    }

    const s = await call(c, 'search', { workspace: ws, path: dirA, query: 'machine-live' })
    check('search 以主目录下的测试目录为起点', s.code === 'OK' && s.data?.totalMatches >= 1, s.data)
    const sRoot = await call(c, 'search', { workspace: ws, path: `${homeDrive}:/`, query: 'machine-live' })
    check(`search 以整个 ${homeDrive}: 盘为起点被拒`, sRoot.code !== 'OK', sRoot)
    const fRoot = await call(c, 'find_files', { workspace: ws, path: `${dirB ? other : homeDrive}:/`, pattern: 'a.txt' })
    check('find_files 以整个盘为起点被拒', fRoot.code !== 'OK', fRoot)

    const env = await call(c, 'write_file', { workspace: ws, path: `${dirA}/.env`, content: 'X=1\n' })
    check('写 .env 照旧被拦', env.code !== 'OK', env)
    const unc = await call(c, 'read_file', { workspace: ws, path: '//localhost/c$/Windows/win.ini' })
    check('UNC 网络路径被拒', unc.code !== 'OK', unc)
    const dataPath = dataDir.replace(/\\/g, '/') + '/config.json'
    const dd = await call(c, 'read_file', { workspace: ws, path: dataPath })
    check('读工作台数据目录（config.json）被拦', dd.code !== 'OK', dd.code)

    if (dirB) {
      const mv = await call(c, 'move', { workspace: ws, from: `${dirB}/a.txt`, to: `${dirA}/a.txt` })
      check(`跨盘 move（${other}: → ${homeDrive}:）`, mv.code === 'OK', mv.data)
      const src = await call(c, 'file_info', { workspace: ws, path: `${dirB}/a.txt` })
      check('move 后源文件不在了', src.code === 'OK' && src.data?.exists === false, src.data)
      const dst = await call(c, 'read_file', { workspace: ws, path: `${dirA}/a.txt` })
      check('move 后目标内容正确', dst.code === 'OK' && JSON.stringify(dst.data).includes('other drive'), dst.data)
    }

    const sum = await call(c, 'changes_summary', { workspace: ws })
    check('changes_summary 有改动', sum.code === 'OK' && (sum.data?.totals?.files ?? 0) >= 1, sum.data?.totals ?? sum.data)
    const rb = await call(c, 'checkpoint_rollback', { workspace: ws })
    check('checkpoint_rollback 真回滚成功', rb.code === 'OK', rb.data)
    for (const d of cleanup) {
      const gone = await call(c, 'file_info', { workspace: ws, path: `${d}/b.txt` })
      const goneA = await call(c, 'file_info', { workspace: ws, path: `${d}/a.txt` })
      check(`回滚后 ${d} 下的测试文件都不在了`, gone.data?.exists === false && goneA.data?.exists === false, [gone.data, goneA.data])
    }
    const after = await call(c, 'changes_summary', { workspace: ws })
    check('回滚后汇总为 0 个文件', after.data?.totals?.files === 0, after.data?.totals)
    check('再回滚：NOTHING_TO_ROLLBACK', (await call(c, 'checkpoint_rollback', { workspace: ws })).code === 'NOTHING_TO_ROLLBACK')
  } finally {
    await c.close().catch(() => {})
  }
}

main()
  .catch((e) => check('脚本异常', false, (e as Error).stack ?? String(e)))
  .finally(() => {
    for (const d of cleanup) {
      if (fs.existsSync(d)) {
        const left = fs.readdirSync(d)
        console.log(`兜底清理 ${d}（剩 ${left.length} 项：${left.join(', ')}）`)
        fs.rmSync(d, { recursive: true, force: true })
      }
    }
    const failed = results.filter((r) => !r.ok).length
    console.log(`\n${results.length - failed} 项通过，${failed} 项失败`)
    process.exit(failed > 0 ? 1 : 0)
  })
