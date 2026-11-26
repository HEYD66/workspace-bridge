// 全文搜索测速：npx tsx scripts/search-bench.ts [目录] [词]
// 测两套：工作台搜索（SearchService）和 MCP 的 search 工具（FileTools.search），各跑 ripgrep 和 bridge（JS）两个引擎
// 引擎靠环境变量 WB_RG_PATH 切换：none = 强制 JS 引擎；本机没有 rg 时 ripgrep 那一组也会退回 bridge（看 engine）
// 注意：脚本自己调了 libuv 线程池（和主进程一样），想看默认 4 线程就先设 UV_THREADPOOL_SIZE=4
import '../src/core/threadpool'
import os from 'node:os'
import path from 'node:path'
import { FileTools } from '../src/core/fileTools'
import { PathGuard } from '../src/core/pathGuard'
import { findRipgrep } from '../src/core/ripgrep'
import { SearchService } from '../src/core/search'

const root = path.resolve(process.argv[2] ?? '.')
const query = process.argv[3] ?? 'mcpServer'
const dataDir = path.join(os.tmpdir(), 'wb-bench-none')
const savedEnv = process.env.WB_RG_PATH
console.log(`目录 ${root}  词 ${query}  线程池 ${process.env.UV_THREADPOOL_SIZE}  rg ${findRipgrep() ?? '（没找到）'}`)

const svc = new SearchService({ dataDir, roots: () => [{ id: 'w', root }] })
const tools = new FileTools(new PathGuard(root, [dataDir]), path.join(dataDir, 'trash'))

for (const engine of ['ripgrep', 'bridge'] as const) {
  if (engine === 'bridge') process.env.WB_RG_PATH = 'none'
  else if (savedEnv === undefined) delete process.env.WB_RG_PATH
  else process.env.WB_RG_PATH = savedEnv
  for (let i = 0; i < 2; i++) {
    const r = await svc.search({ query } as never)
    console.log(
      `[${engine}] 工作台 #${i + 1} ${r.durationMs} ms  engine=${r.engine}  文件 ${r.files.length}  匹配 ${r.totalMatches}  truncated=${r.truncated}${r.truncatedReason ? ` (${r.truncatedReason})` : ''}`
    )
  }
  for (let i = 0; i < 2; i++) {
    const t = Date.now()
    const r = await tools.search({ query, maxResults: 500 })
    console.log(
      `[${engine}] MCP search #${i + 1} ${Date.now() - t} ms  engine=${r.engine}  结果 ${r.results.length}  扫描 ${r.scannedFiles}  truncated=${r.truncated}${r.truncated_reason ? ` (${r.truncated_reason})` : ''}`
    )
  }
}
