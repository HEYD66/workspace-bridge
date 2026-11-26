// screenshot 工具实测：进程内起一个临时 Bridge（端口 18767，临时数据目录、临时工作区），用真的 PowerShell / 无头浏览器截图，
// 截图另存到 ./_smoke_out/ 方便用 read_image 看。不碰正在运行的工作台（8765）和它的数据目录。
// 用法（在仓库根目录）：npx tsx scripts/screenshot-smoke.ts [窗口标题，默认 arena]
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Bridge } from '../src/core/bridge'

const windowTitle = process.argv[2] ?? 'arena'
const port = Number(process.env.SMOKE_PORT ?? 18767)
const outDir = path.resolve('_smoke_out')

async function main(): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-shot-smoke-'))
  const root = path.join(base, 'ws')
  fs.mkdirSync(path.join(root, 'web'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'web', 'index.html'),
    [
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="app.css"></head><body>',
      '<h1>工作区 HTML 截图 OK</h1><p class="note">样式来自 app.css，图标来自 logo.svg</p><img src="logo.svg" width="96" height="96">',
      // 工作区外的文件：经临时 http 服务打开时浏览器应拒绝加载（截图里不该出现这张图）
      '<img src="file:///C:/Windows/Web/Screen/img100.jpg" width="96" height="96" alt="外部图片（不该显示）">',
      '<script>document.body.insertAdjacentHTML("beforeend", "<p id=js>脚本已执行</p>")</script>',
      '</body></html>'
    ].join('\n')
  )
  fs.writeFileSync(path.join(root, 'web', 'app.css'), 'body{font-family:sans-serif;background:#f3f6ff;margin:24px}h1{color:#2a4dd0}.note{color:#555}#js{color:#0a0;font-weight:bold}')
  fs.writeFileSync(
    path.join(root, 'web', 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="16" fill="#2a4dd0"/><circle cx="48" cy="48" r="24" fill="#fff"/></svg>'
  )

  // 一个本地网页，用来测 url 方式
  const site = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><meta charset="utf-8"><body style="background:#fff4e0;font:24px sans-serif"><h1>本地 URL 截图 OK</h1></body>')
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()))
  const siteUrl = `http://localhost:${(site.address() as AddressInfo).port}/`

  const bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoots: [root], port, userSkillsDir: path.join(base, 'user-skills') })
  await bridge.start()
  const client = new Client({ name: 'screenshot-smoke', version: '1.0.0' })
  const results: Record<string, unknown>[] = []
  try {
    const agent = bridge.createAgent('截图实测')
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bridge.getState().mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${agent.token}` } } })
    )
    const listed = (await client.listTools()).tools.map((t) => t.name)
    results.push({ step: 'tools/list 里有 screenshot', ok: listed.includes('screenshot') })

    const steps: [string, Record<string, unknown>][] = [
      ['列窗口', { target: 'list_windows' }],
      [`截窗口「${windowTitle}」`, { target: 'window', window_title: windowTitle, save_path: 'shots/window.png' }],
      ['截工作区 HTML', { target: 'page', path: 'web/index.html', width: 800, height: 600, save_path: 'shots/page-file.png' }],
      ['截本地 URL（2 倍像素）', { target: 'page', url: siteUrl, width: 640, height: 360, device_scale: 2, save_path: 'shots/page-url.png' }],
      ['外网地址应被拒', { target: 'page', url: 'https://example.com/' }],
      ['不存在的窗口应报 WINDOW_NOT_FOUND', { target: 'window', window_title: '不存在的窗口-zzz' }]
    ]
    for (const [step, args] of steps) {
      const t0 = Date.now()
      const r = await client.callTool({ name: 'screenshot', arguments: args })
      const parts = r.content as { type: string; text?: string; data?: string }[]
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n')
      let data: unknown = text
      try {
        data = JSON.parse(text)
      } catch {
        // 保留原文
      }
      if (step === '列窗口' && data && typeof data === 'object') {
        const d = data as { count: number; windows: unknown[] }
        data = { count: d.count, first_10: d.windows.slice(0, 10) }
      }
      results.push({ step, ms: Date.now() - t0, isError: Boolean(r.isError), images: parts.filter((p) => p.type === 'image').length, data })
    }

    fs.rmSync(outDir, { recursive: true, force: true })
    fs.mkdirSync(outDir, { recursive: true })
    const shotDir = path.join(root, 'shots')
    for (const f of fs.existsSync(shotDir) ? fs.readdirSync(shotDir) : []) fs.copyFileSync(path.join(shotDir, f), path.join(outDir, f))
    results.push({ step: '截图另存到', dir: outDir, files: fs.readdirSync(outDir) })
  } finally {
    await client.close().catch(() => {})
    await bridge.stop()
    await new Promise<void>((r) => site.close(() => r()))
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  console.log(JSON.stringify(results, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
