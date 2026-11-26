// 不开界面直接跑 MCP 服务，用于调试和 MCP Inspector 验收
// 用法：npm run headless -- --workspace D:/某目录 [--workspace D:/另一个目录] [--machine] [--port 8765] [--data ./.bridge-data]
// 多个 --workspace 都会加入，第一个设为当前；不传时用配置里已有的工作区
// 「整台电脑」是内置工作区，始终在；--machine 表示不加目录工作区也照样启动（AI 只用整台电脑）
import './threadpool'
import path from 'node:path'
import { Bridge } from './bridge'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function args(name: string): string[] {
  const out: string[] = []
  process.argv.forEach((v, i) => {
    if (v === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1])
  })
  return out
}

const dataDir = path.resolve(arg('data') ?? '.bridge-data')
const bridge = new Bridge({
  dataDir,
  workspaceRoots: args('workspace'),
  port: arg('port') ? Number(arg('port')) : undefined
})

if (bridge.config.get().workspaces.length === 0 && !process.argv.includes('--machine')) {
  console.error('请用 --workspace 指定工作区目录，或加 --machine 只用整台电脑')
  process.exit(1)
}
if (bridge.config.get().agents.length === 0) bridge.createAgent('Default')

bridge.on('event', (ev) => {
  if (ev.status === 'running') return
  const mark = ev.status === 'ok' ? '✓' : '✗'
  console.log(`${new Date(ev.ts).toLocaleTimeString()} ${mark} [${ev.agentName}] ${ev.tool} ${ev.path ?? ''} ${ev.summary ?? ev.error ?? ''}`)
})

await bridge.start()
const state = bridge.getState()
if (!state.running) {
  console.error(state.error)
  process.exit(1)
}
for (const w of state.workspaces) {
  console.log(`工作区：${w.name}  ${w.root}${w.id === state.activeWorkspaceId ? '（当前）' : ''}${w.exists ? '' : '（目录不存在）'}`)
}
for (const a of state.agents) {
  const info = bridge.connectionInfo(a.id)
  console.log(`\n[${a.name}]\n${info.prompt}`)
}

process.on('SIGINT', async () => {
  await bridge.stop()
  process.exit(0)
})
