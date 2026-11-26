// 群聊实测：真实 Electron 构建 + 两个 MCP 客户端。用户在界面发消息、AI 互相 @、chat_wait 实时等回复、未读角标
// 频道规则（.team/chat-contract.md 的 v2）：群聊页默认开当前工作区的频道，AI 不带 channel 发的消息也进这个频道；私聊都在大厅；未读按频道分开算
// 用法：npm run build 后 npx tsx scripts/group-live.ts（截图存 .e2e-out/group-live/）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const require = createRequire(import.meta.url)
const electronPath: string = require('electron')
const outDir = path.resolve('.e2e-out', 'group-live')
fs.mkdirSync(outDir, { recursive: true })
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-group-'))
const ws = path.join(base, 'ws')
const data = path.join(base, 'data')
const userData = path.join(base, 'ud')
for (const d of [ws, data, userData]) fs.mkdirSync(d, { recursive: true })
const PORT = 38768
const CDP = 39223
const agents = [
  { id: 'a-maya', name: 'Maya', color: '#60a5fa', tier: 'auto', token: 'wb_group_maya_000000000000', createdAt: Date.now() },
  { id: 'a-arena', name: 'Arena', color: '#f472b6', tier: 'read-only', token: 'wb_group_arena_00000000000', createdAt: Date.now() }
]
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ workspaceRoot: ws, host: '127.0.0.1', port: PORT, agents }))

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
  return {
    errors,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eval: async (expr: string): Promise<any> => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value,
    shot: async (file: string) => {
      const r = await call('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(outDir, file), Buffer.from(r.result.data, 'base64'))
    },
    // 往输入框里打字并按 Enter（走 React 受控输入 + 键盘事件，和用户操作一样）
    type: async (text: string) => {
      await call('Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector('main textarea'); el.focus(); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`
      })
      await sleep(150)
      await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    }
  }
}

async function main(): Promise<void> {
  await waitFor(`http://127.0.0.1:${PORT}/health`)
  const ui = await cdp()
  await sleep(1500)
  const maya = await mcp(agents[0].token, 'maya')
  const arena = await mcp(agents[1].token, 'arena')

  const tools = (await maya.listTools()).tools.map((t) => t.name)
  check('MCP 里有 chat_send / chat_read / chat_wait / chat_channels', ['chat_send', 'chat_read', 'chat_wait', 'chat_channels'].every((n) => tools.includes(n)), tools)

  // 当前工作区的频道和大厅
  const LOBBY = 'general'
  const init = await ui.eval(`window.bridge.getState().then(s => ({ active: s.activeWorkspaceId, channels: s.chat.channels }))`)
  const wsChannel = `ws:${init?.active}`
  type Channel = { id: string; name: string; unread: number }
  const channelNames = ((init?.channels ?? []) as Channel[]).map((c) => c.id)
  check('频道列表里有大厅和当前工作区的频道', channelNames.includes(LOBBY) && channelNames.includes(wsChannel), init)
  const unreadOf = (st: { channels?: Channel[] } | undefined, id: string): number | undefined => st?.channels?.find((c) => c.id === id)?.unread
  // 点侧栏里的频道（按名字找那一行）
  const openChannel = (name: string): Promise<boolean> =>
    ui.eval(`(() => { const el = [...document.querySelectorAll('div.truncate')].find((d) => d.textContent.trim() === ${JSON.stringify(name)}); const row = el?.closest('.cursor-pointer'); row?.click(); return !!row })()`)

  // 1. 打开群聊页
  const navOk = await ui.eval(`(() => { const b = document.querySelector('nav button[title="群聊"]'); b?.click(); return !!b })()`)
  await sleep(600)
  check('活动栏有「群聊」并能打开', navOk === true)
  await ui.shot('01-empty.png')

  // 2. 用户在界面里发消息 @Maya：群聊页默认开的是当前工作区的频道，消息进这个频道，不进大厅
  await ui.type('@Maya 帮我看下 README 要不要改')
  await sleep(600)
  const msgs1 = await ui.eval(`window.bridge.listGroupChat({ channel: ${JSON.stringify(wsChannel)} })`)
  check('界面发出的消息进了当前工作区的频道（from=user）', Array.isArray(msgs1) && msgs1.some((m: { from: { kind: string }; text: string }) => m.from.kind === 'user' && m.text.includes('README')), msgs1)
  const lobby1 = await ui.eval(`window.bridge.listGroupChat({})`)
  check('大厅里没有这条消息', Array.isArray(lobby1) && lobby1.length === 0, lobby1)
  check('输入框发完清空', (await ui.eval(`document.querySelector('main textarea').value`)) === '')

  // 3. Maya 下一次工具调用带【通知】
  const who = await maya.callTool({ name: 'whoami', arguments: {} })
  check('Maya 的下一个工具结果里带【通知】群聊消息', textOf(who).includes('【通知】') && textOf(who).includes('README'), textOf(who).slice(-400))

  // 4. Arena 也能发，@Maya；Maya 在 chat_wait 里实时收到
  // 通知只是预览，不算已读：先 chat_read 把已有的读掉，chat_wait 才是在等新消息
  await maya.callTool({ name: 'chat_read', arguments: {} })
  const t0 = Date.now()
  const waitP = maya.callTool({ name: 'chat_wait', arguments: { timeout_ms: 20000 } })
  await sleep(800)
  const sent = await arena.callTool({ name: 'chat_send', arguments: { text: '@Maya 我在看 docs，你改 README 吧' } })
  check('Arena 能发群消息，不带 channel 时进当前工作区的频道', !sent.isError && bodyOf(sent)?.channel === wsChannel, bodyOf(sent))
  const waited = bodyOf(await waitP)
  const ms = Date.now() - t0
  check(`Maya 的 chat_wait 挂着等，Arena 发出后立刻返回（共 ${ms} ms，其中先等了 800 ms）`, ms >= 700 && ms < 5000 && JSON.stringify(waited).includes('你改 README 吧'), waited)

  // 5. Maya 回复（引用）+ 私聊 Arena
  const lastId = (waited?.messages ?? []).slice(-1)[0]?.id
  const rep = await maya.callTool({ name: 'chat_send', arguments: { text: '好的，我来改 README', reply_to: lastId } })
  check('chat_send 带 reply_to', !rep.isError, bodyOf(rep))
  const dm = await maya.callTool({ name: 'chat_send', arguments: { text: '悄悄话：docs 里第 3 节过时了', to: 'Arena' } })
  check('chat_send 私聊，存在大厅', !dm.isError && bodyOf(dm)?.channel === LOBBY, bodyOf(dm))
  const arenaRead = bodyOf(await arena.callTool({ name: 'chat_read', arguments: {} }))
  check('Arena 读到私聊', JSON.stringify(arenaRead).includes('悄悄话'), arenaRead)

  // 6. 界面：消息都显示出来、私聊有标记、角标
  await ui.eval(`(() => { const b = document.querySelector('nav button[title="文件（Ctrl+Shift+E）"]'); b?.click() })()`)
  await sleep(300)
  await arena.callTool({ name: 'chat_send', arguments: { text: '@所有人 今天的进度大家同步一下' } })
  await sleep(800)
  const badge = await ui.eval(`(() => { const b = document.querySelector('nav button[title="群聊"]'); return b ? b.textContent.trim() : null })()`)
  check(`不在群聊页时活动栏有未读角标（${badge}）`, !!badge && /\d/.test(badge), badge)
  const st = await ui.eval(`window.bridge.getState().then(s => s.chat)`)
  check('BridgeState.chat 有未读和 @ 数', !!st && st.unread >= 1, st)
  await ui.eval(`document.querySelector('nav button[title="群聊"]')?.click()`)
  await sleep(1000)
  const page = await ui.eval(`document.querySelector('main')?.innerText ?? ''`)
  check('工作区频道显示了各方的消息', ['README', '你改 README 吧', '好的，我来改 README', '同步一下'].every((s) => page.includes(s)), page.slice(0, 500))
  check('工作区频道里没有私聊（私聊在大厅）', !page.includes('悄悄话'), page.slice(0, 800))
  await ui.shot('02-conversation.png')
  await sleep(800)
  const st2 = await ui.eval(`window.bridge.getState().then(s => s.chat)`)
  check('看到工作区频道的底部后，这个频道的未读清零；大厅的私聊还是未读', unreadOf(st2, wsChannel) === 0 && (unreadOf(st2, LOBBY) ?? 0) >= 1, st2)

  // 6b. 切到大厅：能看到 AI 之间的私聊，看完后全部未读清零
  check('侧栏能切到大厅', (await openChannel('大厅')) === true)
  await sleep(1000)
  const lobbyPage = await ui.eval(`document.querySelector('main')?.innerText ?? ''`)
  check('用户在大厅能看到 AI 之间的私聊，并带私聊标记', lobbyPage.includes('悄悄话') && lobbyPage.includes('私聊'), lobbyPage.slice(0, 800))
  await ui.shot('02b-lobby.png')
  await sleep(800)
  const st3 = await ui.eval(`window.bridge.getState().then(s => s.chat)`)
  check('看完大厅后全部未读清零', st3?.unread === 0, st3)

  // 7. @ 弹出成员列表
  await ui.eval(`(() => { const el = document.querySelector('main textarea'); el.focus(); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(el, '@'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await sleep(400)
  const popup = await ui.eval(`document.querySelector('main')?.innerText ?? ''`)
  check('输入 @ 弹出成员列表（所有人 / Maya / Arena）', popup.includes('所有人') && popup.includes('Maya') && popup.includes('Arena'))
  await ui.shot('03-mention-popup.png')

  // 8. 全部停下时 AI 发不了
  await ui.eval(`window.bridge.setPaused ? window.bridge.setPaused(true) : window.bridge.pause?.()`)
  await sleep(300)
  const paused = await maya.callTool({ name: 'chat_send', arguments: { text: 'x' } })
  check('全部停下时 chat_send 返回 PAUSED', paused.isError === true && textOf(paused).includes('PAUSED'), textOf(paused).slice(0, 200))
  await ui.eval(`window.bridge.setPaused ? window.bridge.setPaused(false) : window.bridge.resume?.()`)

  check('界面没有未捕获异常', ui.errors.length === 0, ui.errors)
  await maya.close()
  await arena.close()
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
