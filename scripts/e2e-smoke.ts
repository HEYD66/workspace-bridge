// ⚠ 部分过时（2026-11-12 权限精简）：只读档位、OAuth 批准框里选档位、设置页的停用工具都去掉了，涉及这些的步骤会失败。
// 端到端冒烟：启动真实 Electron 应用，两个 MCP 客户端模拟两个 AI 协作改文件，通过 CDP 截图检查界面
// 用法：npx tsx scripts/e2e-smoke.ts <输出目录>
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const require = createRequire(import.meta.url)
const electronPath: string = require('electron')
const outDir = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'wb-e2e-out-')))
fs.mkdirSync(outDir, { recursive: true })

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-e2e-'))
const ws = path.join(base, '示例项目')
const data = path.join(base, 'data')
fs.mkdirSync(path.join(ws, 'src'), { recursive: true })
fs.mkdirSync(data)
fs.writeFileSync(path.join(ws, 'README.md'), '# 示例项目\n\n用于演示多 AI 协作。\n')
fs.writeFileSync(path.join(ws, 'src', 'app.ts'), 'export function greet(name: string) {\n  return "Hello " + name\n}\n')
fs.writeFileSync(path.join(ws, '.env'), 'API_KEY=secret')

const PORT = 18765
const CDP = 19222
const agents = [
  { id: 'a-claude', name: 'Claude', color: '#60a5fa', tier: 'auto', token: 'wb_e2e_claude', createdAt: Date.now() },
  { id: 'a-gpt', name: 'ChatGPT', color: '#f472b6', tier: 'auto', token: 'wb_e2e_gpt', createdAt: Date.now(), roleId: 'developer' },
  { id: 'a-view', name: '只读助手', color: '#34d399', tier: 'read-only', token: 'wb_e2e_view', createdAt: Date.now() }
]
// 第 4 步要走 OAuth 流程，默认的链接直连模式不提供 OAuth 端点，所以这里显式用 oauth 模式
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ workspaceRoot: ws, host: '127.0.0.1', port: PORT, agents, authMode: 'oauth' }))

function withoutRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _drop, ...rest } = env
  return rest
}

const app = spawn(electronPath, ['.', `--remote-debugging-port=${CDP}`], {
  cwd: process.cwd(),
  // 用户级技能目录指到临时目录，不碰真实的 ~/.workspace-bridge/skills；
  // 从别的 Electron 应用（如终端宿主）继承来的 ELECTRON_RUN_AS_NODE 会让 Electron 以纯 Node 启动，去掉
  env: { ...withoutRunAsNode(process.env), WB_DATA_DIR: data, WB_USER_SKILLS_DIR: path.join(base, 'user-skills'), ELECTRON_RENDERER_URL: '' },
  stdio: 'inherit'
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(url: string, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url)
      if (r.ok) return r
    } catch {}
    await sleep(250)
  }
  throw new Error('等待超时：' + url)
}

async function mcp(token: string, name: string) {
  const c = new Client({ name, version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  return c
}
const txt = (r: any) => r.content[0].text as string
/** 含末尾【通知】在内的全部文本 */
const all = (r: any) => r.content.map((c: any) => c.text).join('\n') as string
const ver = (r: any) => txt(r).match(/version: (\w+)/)![1]

/** 极简 CDP 客户端（Node 24 自带 WebSocket） */
async function cdp() {
  const targets = (await (await waitFor(`http://127.0.0.1:${CDP}/json`)).json()) as any[]
  const page = targets.find((t) => t.type === 'page')
  const sock = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => sock.addEventListener('open', r, { once: true }))
  let id = 0
  const pending = new Map<number, (v: any) => void>()
  // 收集页面里未捕获的异常和 console.error，用来发现界面运行时错误
  const errors: string[] = []
  sock.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data))
    if (m.id && pending.has(m.id)) pending.get(m.id)!(m)
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text)
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a: any) => a.value ?? a.description).join(' '))
  })
  const call = (method: string, params: any = {}) =>
    new Promise<any>((resolve) => {
      const i = ++id
      pending.set(i, resolve)
      sock.send(JSON.stringify({ id: i, method, params }))
    })
  await call('Runtime.enable')
  return {
    errors,
    eval: async (expr: string) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value,
    shot: async (file: string) => {
      const r = await call('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(outDir, file), Buffer.from(r.result.data, 'base64'))
    },
    close: () => sock.close()
  }
}

const clickText = (t: string) => `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(t)})); b?.click(); return !!b })()`

try {
  await waitFor(`http://127.0.0.1:${PORT}/health`)
  const ui = await cdp()
  await sleep(800)

  const claude = await mcp('wb_e2e_claude', 'claude-ai')
  const gpt = await mcp('wb_e2e_gpt', 'chatgpt-connector')
  const viewer = await mcp('wb_e2e_view', 'viewer')

  await claude.callTool({ name: 'whoami', arguments: {} })
  await claude.callTool({ name: 'list_dir', arguments: { path: '.' } })
  const r1 = await claude.callTool({ name: 'read_file', arguments: { path: 'src/app.ts' } })
  const r2 = await gpt.callTool({ name: 'read_file', arguments: { path: 'src/app.ts' } })
  await claude.callTool({
    name: 'edit_file',
    arguments: { path: 'src/app.ts', expected_version: ver(r1), edits: [{ old_string: 'return "Hello " + name', new_string: 'return `你好，${name}！`' }] }
  })
  const conflict = await gpt.callTool({ name: 'write_file', arguments: { path: 'src/app.ts', content: '// overwritten', expected_version: ver(r2) } })
  await gpt.callTool({ name: 'read_file', arguments: { path: '.env' } })
  await gpt.callTool({ name: 'write_file', arguments: { path: 'docs/设计说明.md', content: '# 设计说明\n\n- 多 AI 协作\n- 技能库\n' } })
  await gpt.callTool({ name: 'search', arguments: { query: '你好' } })
  await viewer.callTool({ name: 'write_file', arguments: { path: 'x.txt', content: 'x' } })

  // 记忆：Claude 写共享记忆，ChatGPT 能搜到
  await claude.callTool({ name: 'memory_save', arguments: { title: '问候语约定', content: '界面文案统一用中文，问候语格式：你好，名字！', tags: ['约定'] } })
  const memHit = txt(await gpt.callTool({ name: 'memory_search', arguments: { query: '问候语' } }))
  await claude.callTool({ name: 'memory_save', arguments: { scope: 'private', title: 'Claude 的笔记', content: '下一步检查 docs' } })
  const gptSeesPrivate = txt(await gpt.callTool({ name: 'memory_search', arguments: { query: 'Claude 的笔记' } })).includes('下一步检查')

  // 任务：Claude（无职位，可派活）派给 ChatGPT（开发），ChatGPT 提交审查，Claude 通过
  const created = txt(await claude.callTool({ name: 'task_create', arguments: { title: '补充 README 的使用说明', description: '写清楚怎么启动', assigneeId: 'ChatGPT' } }))
  const ref = created.match(/T-\d+/)?.[0] ?? ''
  const gptTasks = txt(await gpt.callTool({ name: 'task_list', arguments: { assignee: 'me' } }))
  await gpt.callTool({ name: 'task_update', arguments: { task: ref, status: 'in_progress' } })
  await gpt.callTool({ name: 'task_update', arguments: { task: ref, status: 'review', result: '已在 README 增加启动步骤' } })
  const review = await claude.callTool({ name: 'task_review', arguments: { task: ref, decision: 'accept', note: '可以' } })
  const taskDone = txt(await claude.callTool({ name: 'task_get', arguments: { task: ref } }))
  // 开发职位改 docs 以外的文件不受限；测试一下只读 AI 不能写记忆以外的东西已在上面覆盖
  const teamText = txt(await gpt.callTool({ name: 'team_list', arguments: {} }))
  const assigneeNone = await gpt.callTool({ name: 'task_list', arguments: { assignee: 'none' } })

  const checks = {
    conflictDetected: txt(conflict).includes('CONFLICT'),
    fileKeptClaudeEdit: fs.readFileSync(path.join(ws, 'src/app.ts'), 'utf8').includes('你好'),
    gptFileCreated: fs.existsSync(path.join(ws, 'docs/设计说明.md')),
    viewerBlocked: !fs.existsSync(path.join(ws, 'x.txt')),
    sharedMemoryVisible: memHit.includes('问候语约定'),
    privateMemoryHidden: !gptSeesPrivate,
    taskRef: ref,
    taskAssignedToGpt: gptTasks.includes(ref),
    reviewOk: !review.isError,
    taskDone: /"status":\s*"done"/.test(taskDone),
    assigneeNoneOk: !assigneeNone.isError,
    teamSummary: teamText.slice(0, 120)
  }
  const nav = (label: string) => ui.eval(`(() => { const b = document.querySelector('nav button[title=${JSON.stringify(label)}]'); b?.click(); return !!b })()`)
  // 只在左侧列表里找文字完全相同的叶子元素（右侧活动面板里也有同名文字）
  const clickSide = (t: string) =>
    ui.eval(`(() => { const el = [...document.querySelectorAll('aside:first-of-type *')].find(e => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(t)}); el?.click(); return !!el })()`)
  // 编辑区一直挂在 main 里（隐藏时也在），它也有「保存」按钮，所以只认看得见的按钮
  const clickMain = (t: string) =>
    ui.eval(`(() => { const b = [...document.querySelectorAll('main button')].find(b => b.offsetParent !== null && b.textContent.trim() === ${JSON.stringify(t)}); b?.click(); return !!b })()`)
  // React 受控输入：用原生 setter 改值，再派发 input / change 事件
  const fill = (selector: string, value: string) =>
    ui.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); return true })()`)
  await sleep(600)

  const navOk: Record<string, boolean> = {}
  navOk.files = await nav('文件（Ctrl+Shift+E）')
  await sleep(400)
  // ChatGPT 新建了 docs/设计说明.md，根目录下应出现 docs
  const treeShowsNewDir = await ui.eval(`[...document.querySelectorAll('aside:first-of-type span')].some(s => s.textContent.trim() === 'docs')`)
  await clickSide('src')
  await sleep(300)
  await clickSide('app.ts')
  await sleep(600)
  await ui.shot('1-files.png')

  navOk.tasks = await nav('任务')
  await sleep(500)
  await ui.shot('2-tasks.png')

  navOk.memory = await nav('记忆')
  await sleep(500)
  await ui.shot('3-memory.png')

  navOk.team = await nav('团队与职位')
  await sleep(400)
  const teamClick = await clickSide('Claude')
  await sleep(400)
  await ui.shot('4-team.png')

  navOk.settings = await nav('设置')
  await sleep(400)
  // 正数表示文件夹按钮超出卡片右边缘的像素
  const settingsOverflowPx = await ui.eval(
    `(() => { const b = document.querySelector('main button[title="在资源管理器中打开"]'); const card = b?.closest('.rounded-lg'); if (!b || !card) return null; return Math.round(b.getBoundingClientRect().right - card.getBoundingClientRect().right) })()`
  )
  await ui.shot('5-settings.png')

  // —— 以下步骤全部在界面上操作 ——
  const ui2: Record<string, unknown> = {}

  // 1. 界面新建接入身份，再用接入说明里的带 token 地址连上（不点复制按钮，避免覆盖剪贴板）
  await nav('团队与职位')
  await sleep(300)
  await ui.eval(`document.querySelector('button[title="新建接入身份"]')?.click()`)
  await sleep(300)
  await fill('main input', 'Gemini')
  await sleep(100)
  ui2.createClicked = await clickMain('创建')
  await sleep(700)
  await ui.shot('7-new-agent.png')
  const gemini = await ui.eval(`window.bridge.getState().then(s => s.agents.find(a => a.name === 'Gemini') ?? null)`)
  ui2.agentCreated = !!gemini
  if (gemini) {
    const info = await ui.eval(`window.bridge.connectionInfo(${JSON.stringify(gemini.id)})`)
    ui2.promptHasToken = info.prompt.includes(gemini.token)
    const c = new Client({ name: 'gemini-web', version: '1.0.0' })
    await c.connect(new StreamableHTTPClientTransport(new URL(info.urlWithToken)))
    ui2.connectViaTokenUrl = all(await c.callTool({ name: 'whoami', arguments: {} })).includes('Gemini')
    await c.close()
  }

  // 2. 界面派任务给 ChatGPT → ChatGPT 提交审查 → 界面点「通过」
  await nav('任务')
  await sleep(300)
  await ui.eval(`document.querySelector('button[title="新建任务"]')?.click()`)
  await sleep(200)
  await fill('aside:first-of-type input[placeholder="任务标题"]', '整理 docs 目录')
  await fill('aside:first-of-type select', 'a-gpt')
  await sleep(100)
  await ui.eval(`(() => { const b = [...document.querySelectorAll('aside:first-of-type button')].find(b => b.textContent.trim() === '创建'); b?.click(); return !!b })()`)
  await sleep(500)
  const uiTask = await ui.eval(`window.bridge.listTasks().then(ts => ts.find(t => t.title === '整理 docs 目录') ?? null)`)
  ui2.taskCreated = !!uiTask && uiTask.assigneeId === 'a-gpt' && uiTask.managedBy === 'user'
  if (uiTask) {
    await gpt.callTool({ name: 'task_update', arguments: { task: uiTask.ref, status: 'in_progress' } })
    await gpt.callTool({ name: 'task_update', arguments: { task: uiTask.ref, status: 'review', result: 'docs 下只保留设计说明.md' } })
    await sleep(500)
    await ui.shot('8-task-review.png')
    ui2.reviewClicked = await clickMain('通过')
    await sleep(400)
    const after = all(await gpt.callTool({ name: 'task_get', arguments: { task: uiTask.ref } }))
    ui2.uiReviewDone = /"status":\s*"done"/.test(after)
    ui2.gptGotNotice = after.includes('【通知】')
  }

  // 3. 界面编辑并置顶共享记忆 → AI 搜到新内容，新会话的说明里带上置顶记忆
  await nav('记忆')
  await sleep(300)
  ui2.memoryClicked = await clickSide('问候语约定')
  await sleep(300)
  // 编辑区（Monaco）一直挂着，有隐藏的 textarea，所以只认记忆编辑器自己的控件
  await fill('main textarea[rows="14"]', '界面文案统一用中文。问候语格式：你好，名字！（工作台修改）')
  await ui.eval(`[...document.querySelectorAll('main label')].find(l => l.textContent.includes('置顶'))?.querySelector('input[type=checkbox]')?.click()`)
  await sleep(100)
  ui2.memorySaveClicked = await clickMain('保存')
  await sleep(400)
  await ui.shot('9-memory-edit.png')
  ui2.aiSeesEdit = all(await gpt.callTool({ name: 'memory_search', arguments: { query: '问候语' } })).includes('工作台修改')
  const gpt2 = await mcp('wb_e2e_gpt', 'chatgpt-second-session')
  ui2.pinnedInInstructions = (gpt2.getInstructions() ?? '').includes('工作台修改')
  await gpt2.close()

  // 4. 网页 AI 走 OAuth：注册 → 授权页 → 桌面弹窗核对配对码、选身份、点「批准」→ 换 token → 调用 MCP
  const B = `http://127.0.0.1:${PORT}`
  const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect'
  const reg = (await (
    await fetch(`${B}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'ChatGPT Web', redirect_uris: [REDIRECT] }) })
  ).json()) as { client_id: string }
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'e2e' })
  const html = await (await fetch(`${B}/authorize?${q}`)).text()
  const { id: reqId, k } = JSON.parse(/var cfg = (\{.*?\});/.exec(html)![1]) as { id: string; k: string }
  const pagePair = /<div id="code" class="code">([^<]+)<\/div>/.exec(html)?.[1] ?? '??'
  await sleep(600)
  ui2.popupShown = await ui.eval(`!!document.querySelector('[role=dialog]')`)
  ui2.popupPairMatches = ((await ui.eval(`document.querySelector('[role=dialog]')?.innerText ?? ''`)) as string).includes(pagePair)
  // 默认「新建身份」，档位默认选中「只读」
  ui2.popupDefaultTier = await ui.eval(
    `[...document.querySelectorAll('[role=dialog] button')].find(b => b.classList.contains('bg-hover'))?.textContent.trim() ?? null`
  )
  // 批准按钮出现后锁 1 秒
  await sleep(1100)
  await fill('[role=dialog] select', 'a-gpt')
  await sleep(150)
  await ui.shot('10-oauth-approval.png')
  ui2.approveClicked = await ui.eval(
    `(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === '批准'); if (!b || b.disabled) return false; b.click(); return true })()`
  )
  await sleep(500)
  const st = (await (await fetch(`${B}/authorize/status?id=${encodeURIComponent(reqId)}&k=${encodeURIComponent(k)}`)).json()) as { status: string; redirect?: string }
  ui2.oauthApproved = st.status === 'approved'
  if (st.redirect) {
    const code = new URL(st.redirect).searchParams.get('code')!
    const tok = (await (
      await fetch(`${B}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier }).toString()
      })
    ).json()) as { access_token: string }
    const oc = await mcp(tok.access_token, 'chatgpt-oauth')
    ui2.oauthWhoami = (JSON.parse(txt(await oc.callTool({ name: 'whoami', arguments: {} }))) as { agent: string }).agent
    await oc.close()
  }
  ui2.popupClosed = !(await ui.eval(`!!document.querySelector('[role=dialog]')`))
  // 团队页里 ChatGPT 的「网页连接」列出这个授权
  await nav('团队与职位')
  await sleep(300)
  await clickSide('ChatGPT')
  await sleep(800)
  ui2.grantListed = ((await ui.eval(`document.querySelector('main')?.innerText ?? ''`)) as string).includes('ChatGPT Web')
  await ui.shot('11-oauth-grant.png')

  // 5. 技能：AI 用 install_skill 提交 → 启用前 AI 看不到 → 界面「技能」页点「启用」→ AI 能列出、加载、读附带文件
  const inst = await claude.callTool({
    name: 'install_skill',
    arguments: {
      name: 'e2e-review',
      description: '审查代码时按这个清单逐项检查',
      body: '# 审查清单\n\n1. 先跑测试\n2. 看边界条件\n',
      files: [{ path: 'checklist.md', content: '- [ ] 测试\n- [ ] 边界\n' }]
    }
  })
  ui2.skillInstalled = !inst.isError
  ui2.skillFileOnDisk = fs.existsSync(path.join(ws, '.bridge', 'skills', 'e2e-review', 'SKILL.md'))
  ui2.skillHiddenBeforeEnable = !txt(await gpt.callTool({ name: 'list_skills', arguments: {} })).includes('e2e-review')
  await sleep(600)
  ui2.skillNavBadge = await ui.eval(`document.querySelector('nav button[title="技能"]')?.innerText.trim() ?? null`)
  navOk.skills = await nav('技能')
  await sleep(400)
  ui2.skillListed = await clickSide('e2e-review')
  await sleep(600)
  ui2.skillPendingShown = ((await ui.eval(`document.querySelector('main')?.innerText ?? ''`)) as string).includes('等你审阅')
  await ui.shot('12-skill-review.png')
  ui2.skillEnableClicked = await clickMain('启用')
  await sleep(700)
  ui2.skillVisibleAfterEnable = txt(await gpt.callTool({ name: 'list_skills', arguments: {} })).includes('e2e-review')
  ui2.skillLoaded = txt(await gpt.callTool({ name: 'load_skill', arguments: { name: 'e2e-review' } })).includes('审查清单')
  ui2.skillResource = txt(await gpt.callTool({ name: 'read_skill_resource', arguments: { name: 'e2e-review', file: 'checklist.md' } })).includes('边界')
  await ui.shot('13-skill-enabled.png')

  await ui.eval(clickText('全部停下'))
  await sleep(300)
  const paused = txt(await claude.callTool({ name: 'list_dir', arguments: {} })).includes('PAUSED')
  await ui.shot('6-paused.png')
  await ui.eval(clickText('恢复 AI'))
  await sleep(300)

  // 6. 工具开关：设置里取消 memory_delete → 点「保存」再点「确认保存？」→ 所有会话断开，新会话的工具列表里没有它
  //    （保存会断开上面所有 AI 的会话，所以放在最后）
  await nav('设置')
  await sleep(400)
  const inToolsCard = (body: string) =>
    ui.eval(`(() => { const p = [...document.querySelectorAll('main p')].find(p => p.textContent.includes('停用的工具对所有 AI 隐藏'));
      const card = p?.closest('.rounded-lg'); if (!card) return false; ${body} })()`)
  ui2.toolUnchecked = await inToolsCard(
    `const l = [...card.querySelectorAll('label')].find(l => l.innerText.includes('memory_delete')); const cb = l?.querySelector('input[type=checkbox]'); if (!cb) return false; cb.click(); return true`
  )
  await sleep(200)
  const clickCardButton = (t: string) =>
    inToolsCard(`const b = [...card.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(t)}); if (!b) return false; b.click(); return true`)
  ui2.toolSaveClicked = await clickCardButton('保存')
  await sleep(150)
  ui2.toolConfirmClicked = await clickCardButton('确认保存？')
  await sleep(800)
  ui2.disabledSaved = ((await ui.eval(`window.bridge.getState().then(s => s.disabledTools)`)) as string[]).includes('memory_delete')
  await ui.shot('14-tools.png')
  const claude2 = await mcp('wb_e2e_claude', 'claude-after-tools')
  const names = (await claude2.listTools()).tools.map((t) => t.name)
  ui2.toolHiddenFromList = !names.includes('memory_delete') && names.includes('memory_save') && names.includes('list_skills')
  ui2.instructionsMentionDisabled = (claude2.getInstructions() ?? '').includes('memory_delete')
  const who = JSON.parse(txt(await claude2.callTool({ name: 'whoami', arguments: {} }))) as { unavailableTools?: string[] }
  ui2.whoamiUnavailable = who.unavailableTools ?? null
  await claude2.close()

  // 7. 职位白名单：打开「审查」职位切到「自定义」（不保存）；AI 详情显示可用工具
  await nav('团队与职位')
  await sleep(300)
  ui2.roleClicked = await clickSide('审查')
  await sleep(300)
  ui2.roleCustomClicked = await clickMain('自定义')
  await sleep(300)
  ui2.rolePickerShown = ((await ui.eval(`document.querySelector('main')?.innerText ?? ''`)) as string).includes('已选')
  await ui.shot('15-role-tools.png')
  await clickSide('Claude')
  await sleep(400)
  const agentText = (await ui.eval(`document.querySelector('main')?.innerText ?? ''`)) as string
  ui2.agentToolsShown = agentText.includes('可用工具') && agentText.includes('个工具不可用')
  await ui.shot('16-agent-tools.png')

  const domText: string = await ui.eval('document.body.innerText')
  console.log(JSON.stringify({ ...checks, navOk, treeShowsNewDir, teamClick, settingsOverflowPx, ui: ui2, pausedFromUi: paused, uiShowsAgents: domText.includes('Claude') && domText.includes('ChatGPT'), errors: ui.errors, outDir }, null, 2))
  // 第 6 步保存工具开关时这些会话已被服务端断开，关闭失败不影响结果
  for (const c of [claude, gpt, viewer]) await c.close().catch(() => {})
  ui.close()
} finally {
  app.kill()
  await sleep(500)
  fs.rmSync(base, { recursive: true, force: true })
}
