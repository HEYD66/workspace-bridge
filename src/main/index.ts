import '../core/threadpool'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, protocol, shell } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bridge } from '../core/bridge'
import { testConnection } from '../core/connectTest'
import { Playground } from '../core/playground'
import { DEFAULT_REMOTE_PREFS, lanAddresses, MIME, readRemoteKept, readRemotePrefs, RemoteViewServer, removeRemoteKept, writeRemoteKept, writeRemotePrefs, type RemoteKeptRecord, type RemotePrefs } from '../core/remoteView'
// ===== 搜索（ui-skills） =====
import { SearchService } from '../core/search'
import type { SearchOptions } from '../core/types'
// ===== 终端（skills-core） =====
import type { IpcMainEvent } from 'electron'
import { TerminalManager, type TerminalCreateOptions } from '../core/terminal'
import { TunnelManager } from '../core/tunnel'
import { browserHost, browserStatus, clearBrowserData, prepareBrowserTab, setBrowserPrefs, setupBrowserTabs, setupCdp } from './browserGuests'
import type { MemoryInput, RemoteViewStatus, TaskInput, TunnelSettingsPatch } from '../shared/api'
import type { AuditQuery } from '../core/auditReader'
import type { ScheduleInput } from '../core/scheduler'
import type { Agent, GroupMessage, Role, SkillInput, TaskStatus } from '../core/types'
import type { SkillImportOptions } from '../core/skillImport'
import { decodeImageBase64 } from '../core/chatAttachments'
import type { GroupChatSendInput } from '../shared/api'
import type { CanvasOp } from '../shared/canvasDoc'
import { AttentionTracker, attentionMessage, collectAttention } from '../shared/attentionNotify'
// ===== 内置 AI（mcp-layer） =====
import { net, safeStorage } from 'electron'
import { bridgeHost, LlmService } from '../core/llm/service'
import type { SecretBox } from '../core/llm/store'
import type { AgentModel, ProviderInput } from '../core/types'

const here = path.dirname(fileURLToPath(import.meta.url))
let win: BrowserWindow | null = null
let bridge: Bridge
let quitting = false
/** 界面报上来的：现在哪些文件有没保存的改动（「文件」页的编辑区和右栏的文件标签）。关窗口时不是空的就先问 */
let unsavedFiles: string[] = []
/** 用户已经在对话框里选了「不保存，直接关闭」 */
let closeAnyway = false
let askingClose = false
/** 现在关窗口 / 退出会丢没保存的改动，而且用户还没说「不要了」 */
const holdForUnsaved = (): boolean => unsavedFiles.length > 0 && !closeAnyway && !!win && !win.isDestroyed()
// ===== 终端（skills-core） =====
let terminals: TerminalManager | undefined
// ===== 内置 AI（mcp-layer） =====
let llm: LlmService | undefined
// ===== 远端查看 =====
let remoteView: RemoteViewServer | undefined
/** 远端查看自己的临时隧道，和 AI 用的那条分开：开关它不影响 AI 的链接。「重启后保留」开着时以保留方式启动，退出时不结束它 */
let remoteTunnel: TunnelManager | undefined
let remoteWantsTunnel = false
/** 这一次是不是工作台重启后接着上次开的（「重启后保留」） */
let remoteResumed = false
/** 把现在的端口、口令、已经进来的设备存盘（只在「重启后保留」开着时存）；退出前也要调一次 */
let remoteSaveKept: (() => void) | undefined
/** 这一次开启时局域网开没开 */
let remoteLan = false
/** 记住的访问方式（数据目录的 remote-view.json），下次点「开启」按这个来 */
let remotePrefs: RemotePrefs = { ...DEFAULT_REMOTE_PREFS }
/** 局域网开着时监听的地址和给人看的地址。测试里用环境变量换成 127.0.0.1，免得弹防火墙窗口 */
const remoteLanHost = (): string => process.env.WB_REMOTE_LAN_HOST || '0.0.0.0'
const remoteLanAddrs = (): string[] => (process.env.WB_REMOTE_LAN_ADDRS ? process.env.WB_REMOTE_LAN_ADDRS.split(',').map((x) => x.trim()).filter(Boolean) : lanAddresses())
/** 界面能调的全部通道。本机窗口经 IPC 调，远端查看的浏览器经 HTTP 调，走的是同一个函数 */
const invokers = new Map<string, (...args: unknown[]) => unknown>()
const senders = new Map<string, (...args: unknown[]) => void>()
/** 这些通道会在电脑上弹系统对话框、打开资源管理器或写电脑的剪贴板，远端的浏览器看不到也用不上 */
const LOCAL_ONLY = new Set([
  'workspace:add',
  'workspace:choose',
  'workspace:open',
  'files:reveal',
  'skill:open',
  'skill:pickImport',
  'audit:export',
  'backup:export',
  'backup:pickImport',
  'diagnostics:save',
  'clipboard:write',
  'app:unsaved',
  'browser:prepare',
  'browser:setPrefs'
])

// 便携模式和测试用独立的数据目录时，Electron 的 userData（单实例锁、缓存）也放进去，
// 这样冒烟测试能和正在运行的正式实例同时跑。必须在 requestSingleInstanceLock 之前设置
if (process.env.WB_DATA_DIR) app.setPath('userData', path.join(process.env.WB_DATA_DIR, 'electron'))

// Windows 系统通知按 AppUserModelId 投递。不设就用默认的 electron.app.Electron，
// 这个 ID 在系统设置里常被关掉，通知会被拦（第 48 批点验发现）。要在 app ready 之前设
if (process.platform === 'win32') app.setAppUserModelId('workspace-bridge.workbench')

// 界面用自定义的 app:// 协议加载，不用 file://。
// 原因：Chromium 不让从 file:// 页面里 new Worker(普通脚本地址)（file:// 的源是 null），
// 而 Monaco 的折叠、符号、配色取色、语言服务都要 worker。把 app:// 注册成
// standard + secure 之后，'self' 就是 app://bundle，worker 和 CSP 都按正常网页处理。
// 这一步必须在 app ready 之前调用
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  // 内置浏览器的 CDP 默认打开（只监听 127.0.0.1）。远程调试端口是进程启动参数，要在 app ready 之前定下来；
  // 入口模块在这里等一下（找一个没被占用的端口），ready 会等入口模块跑完
  await setupCdp(process.env.WB_DATA_DIR || path.join(app.getPath('userData'), 'bridge')).catch(() => undefined)
  app.whenReady().then(main)
}

function send(channel: string, ...payload: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...payload)
  remoteView?.broadcast(channel, payload)
}

function remoteStatus(): RemoteViewStatus {
  const i = remoteView?.info()
  const keep = remotePrefs.keep === true
  if (!i?.running) return { state: 'off', visits: 0, tunnel: remotePrefs.tunnel, lan: remotePrefs.lan, keep }
  const base = {
    keep,
    ...(remoteResumed ? { resumed: true } : {}),
    localUrl: `http://127.0.0.1:${i.port}${i.entryPath}`,
    startedAt: i.startedAt,
    visits: i.visits,
    lastVisitAt: i.lastVisitAt,
    tunnel: remoteWantsTunnel,
    lan: remoteLan,
    ...(remoteLan ? { lanUrls: remoteLanAddrs().map((ip) => `http://${ip}:${i.port}${i.entryPath}`) } : {})
  }
  if (!remoteWantsTunnel) return { state: 'on', ...base }
  const t = remoteTunnel?.status()
  if (t?.state === 'running' && t.url) return { state: 'on', link: `${t.url}${i.entryPath}`, ...base }
  if (t?.state === 'error') return { state: 'error', error: t.error ?? '公网地址没有申请下来', ...base }
  return { state: 'connecting', ...base }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 640,
    show: false,
    backgroundColor: '#111111',
    title: 'Workspace Bridge',
    autoHideMenuBar: true,
    // 不要系统标题栏（照 Codex）：界面的顶栏就是标题栏，可以拖；最小化 / 最大化 / 关闭三个按钮由系统画在右上角，
    // 高度和顶栏一样（44），颜色跟界面最外层的底色一样（index.css 的 shell）
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#111111', symbolColor: '#9a9a9a', height: 44 },
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // 右栏的网页标签是 <webview>（见 browserGuests.ts）
      webviewTag: true
    }
  })
  // 网页标签里开新窗口、按快捷键：只告诉电脑上的这个窗口（远端页面里没有网页标签）
  setupBrowserTabs(win, (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  })
  win.once('ready-to-show', () => win?.show())
  // 界面里不允许打开新窗口或跳转到外部页面；外部链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadURL('app://bundle/index.html')
  // 有没保存的改动：先拦下来问。上线切换、任务管理器之外的正常关闭（点叉、Alt+F4、别的程序请它关）都走这里
  win.on('close', (e) => {
    if (!holdForUnsaved() || !win) return
    e.preventDefault()
    if (askingClose) return
    askingClose = true
    const w = win
    const shown = unsavedFiles.slice(0, 8)
    void dialog
      .showMessageBox(w, {
        type: 'warning',
        title: 'Workspace Bridge',
        message: `有 ${unsavedFiles.length} 个文件的改动还没保存`,
        detail: `${shown.join('\n')}${unsavedFiles.length > shown.length ? `\n…还有 ${unsavedFiles.length - shown.length} 个` : ''}\n\n现在关闭的话，这些改动会丢。`,
        buttons: ['回去保存', '不保存，直接关闭'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      .then((r) => {
        askingClose = false
        if (r.response !== 1 || w.isDestroyed()) return
        closeAnyway = true
        w.close()
      })
      .catch(() => {
        askingClose = false
      })
  })
  win.on('closed', () => {
    win = null
    unsavedFiles = []
    closeAnyway = false
    askingClose = false
  })
}

function registerIpc(): void {
  const handle = (channel: string, fn: (...args: never[]) => unknown) => {
    invokers.set(channel, fn as (...a: unknown[]) => unknown)
    ipcMain.handle(channel, (e, ...args) => {
      // 只接受本应用窗口发来的调用
      if (!win || e.sender !== win.webContents) throw new Error('FORBIDDEN')
      return (fn as (...a: unknown[]) => unknown)(...args)
    })
  }

  handle('bridge:getState', () => bridge.getState())
  handle('app:unsaved', (paths: string[]) => {
    unsavedFiles = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string' && p.length > 0).slice(0, 200) : []
  })
  handle('bridge:getEvents', () => bridge.recentEvents())
  handle('bridge:setPaused', (paused: boolean) => bridge.setPaused(Boolean(paused)))
  handle('bridge:stopAll', () => bridge.stopAll())
  // ===== 概览（overview） =====
  handle('overview:get', (force?: boolean) => bridge.getOverview(force === true))
  // ===== 多工作区（ws-core） =====
  const pickFolder = async (): Promise<string | null> => {
    const r = await dialog.showOpenDialog(win!, { title: '选择要开放给 AI 的文件夹', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  }
  /** 成员名单：null / 不是数组 = 所有 AI 都能用；数组里只留字符串 */
  const memberList = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null)
  // 旧通道：选完直接加，没有选成员这一步。按「新工作区默认谁都不给」加，之后在设置里选
  const addWorkspace = async () => {
    const root = await pickFolder()
    if (!root) return null
    await bridge.addWorkspace(root, { members: [] })
    return bridge.getState()
  }
  handle('workspace:add', addWorkspace)
  // 旧通道名，等同 workspace:add
  handle('workspace:choose', addWorkspace)
  handle('workspace:pickFolder', pickFolder)
  handle('workspace:addAt', async (root: string, members: unknown) => {
    const m = memberList(members)
    await bridge.addWorkspace(String(root ?? ''), m === null ? {} : { members: m })
    return bridge.getState()
  })
  handle('workspace:setMembers', async (id: string, members: unknown) => {
    await bridge.setWorkspaceMembers(String(id), memberList(members))
    return bridge.getState()
  })
  handle('workspace:remove', async (id: string) => {
    await bridge.removeWorkspace(String(id))
    return bridge.getState()
  })
  handle('workspace:rename', (id: string, name: string) => {
    bridge.renameWorkspace(String(id), String(name ?? ''))
    return bridge.getState()
  })
  handle('workspace:setActive', (id: string) => {
    bridge.setActiveWorkspace(String(id))
    return bridge.getState()
  })
  handle('workspace:open', async (id?: string) => {
    const root = bridge.workspaceRoot(typeof id === 'string' && id ? id : undefined)
    if (root) await shell.openPath(root)
  })
  // ===== 多工作区结束 =====
  handle('settings:setLan', async (enabled: boolean) => {
    await bridge.setLanEnabled(enabled === true)
    return bridge.getState()
  })
  // 只有显式传 'oauth' 才切到 OAuth，其他值一律按链接直连
  handle('settings:setAuthMode', (mode: string) => {
    bridge.setAuthMode(mode === 'oauth' ? 'oauth' : 'link')
    return bridge.getState()
  })
  handle('settings:setNotifyAttention', (on: boolean) => {
    bridge.setNotifyAttention(on === true)
    return bridge.getState()
  })
  handle('tunnel:settings', (patch: TunnelSettingsPatch) => {
    // 只取已知字段，类型不对的丢掉
    const p = patch && typeof patch === 'object' ? patch : {}
    bridge.setTunnelSettings({
      ...(p.mode === 'quick' || p.mode === 'named' ? { mode: p.mode } : {}),
      ...(typeof p.hostname === 'string' ? { hostname: p.hostname } : {}),
      ...(typeof p.token === 'string' ? { token: p.token } : {}),
      ...(typeof p.autoStart === 'boolean' ? { autoStart: p.autoStart } : {}),
      ...(typeof p.keepOnExit === 'boolean' ? { keepOnExit: p.keepOnExit } : {})
    })
    return bridge.getState()
  })
  handle('tunnel:start', async () => {
    await bridge.startTunnel()
    return bridge.getState()
  })
  handle('tunnel:stop', async () => {
    await bridge.stopTunnel()
    return bridge.getState()
  })
  handle('oauth:approve', (pendingId: string, agentId: string) => bridge.approveOAuth(String(pendingId), String(agentId)))
  handle('oauth:deny', (pendingId: string) => bridge.denyOAuth(String(pendingId)))
  handle('oauth:grants', () => bridge.listOAuthGrants())
  handle('oauth:revoke', (grantId: string) => bridge.revokeOAuthGrant(String(grantId)))
  handle('settings:setPort', async (port: number) => {
    await bridge.setPort(Number(port))
    return bridge.getState()
  })

  // ===== 工作台文件读写（ws-core） =====
  const str = (v: unknown, def = '') => (typeof v === 'string' ? v : def)
  handle('files:list', (ws: string, rel: string) => bridge.listDir(str(ws), str(rel, '.')))
  handle('files:read', (ws: string, rel: string) => bridge.readFile(str(ws), str(rel)))
  handle('files:save', (ws: string, rel: string, content: string, expectedVersion?: string) =>
    bridge.saveFile(str(ws), str(rel), str(content), typeof expectedVersion === 'string' && expectedVersion ? expectedVersion : undefined)
  )
  handle('files:createFile', (ws: string, rel: string) => bridge.createFile(str(ws), str(rel)))
  handle('files:createDir', (ws: string, rel: string) => bridge.createDir(str(ws), str(rel)))
  handle('files:rename', (ws: string, from: string, to: string) => bridge.renamePath(str(ws), str(from), str(to)))
  handle('files:delete', (ws: string, rel: string) => bridge.deletePath(str(ws), str(rel)))
  handle('files:reveal', (ws: string, rel: string) => shell.showItemInFolder(bridge.resolveUserPath(str(ws), str(rel, '.'))))

  // 「整台电脑」只认严格的 true，其他值一律当作不开
  handle('agent:create', (name: string, roleId?: string, machineAccess?: boolean) =>
    bridge.createAgent(String(name), typeof roleId === 'string' && roleId ? roleId : undefined, machineAccess === true)
  )
  handle('agent:update', (id: string, patch: Partial<Pick<Agent, 'name' | 'color' | 'roleId' | 'machineAccess'>>) => {
    const src = patch && typeof patch === 'object' ? patch : {}
    // 只收认识的字段，免得界面多传的东西写进配置
    const p: Partial<Pick<Agent, 'name' | 'color' | 'roleId' | 'machineAccess'>> = {}
    if (typeof src.name === 'string') p.name = src.name
    if (typeof src.color === 'string') p.color = src.color
    if (typeof src.roleId === 'string') p.roleId = src.roleId
    if ('machineAccess' in src) p.machineAccess = src.machineAccess === true
    return bridge.updateAgent(String(id), p)
  })
  // ===== 工作台文件读写结束 =====
  handle('agent:rotate', (id: string) => bridge.rotateToken(id))
  handle('agent:sessions', (id: string) => bridge.listAgentSessions(String(id)))
  handle('agent:disconnect', (id: string, sessionId?: string) => bridge.disconnectAgent(String(id), typeof sessionId === 'string' && sessionId ? sessionId : undefined))
  handle('agent:remove', (id: string) => bridge.removeAgent(id))
  handle('agent:connection', (id: string) => bridge.connectionInfo(id))
  handle('agent:exportConfig', (id: string) => bridge.exportClientConfig(String(id)))
  // 接入向导：地址规则和界面片段一样（shared/connectGuide），which 不认识时按本机
  handle('connect:test', (id: string, which: string) =>
    testConnection(bridge.connectionInfo(String(id)), which === 'lan' || which === 'public' ? which : 'local')
  )
  // 工具试用台：用选中 AI 的 token 连本机地址，走真实鉴权；只认工作台里已有的 AI（connectionInfo 不存在就抛错）
  handle('playground:tools', (id: string) => playground().listTools(String(id)))
  handle('playground:call', (id: string, name: string, args: Record<string, unknown>) =>
    playground().callTool(String(id), String(name), args && typeof args === 'object' && !Array.isArray(args) ? args : {})
  )

  handle('role:save', (input: Partial<Role> & { name: string }) => bridge.saveRole(input))
  handle('role:remove', (id: string) => bridge.removeRole(id))

  // 最后一个参数是工作区 id：不给是当前工作区，技能页看别的工作区（含整台电脑）的技能时给它的 id
  const skillWs = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  handle('skill:list', (ws?: string) => bridge.listSkills(skillWs(ws)))
  handle('skill:get', (id: string, ws?: string) => bridge.getSkill(String(id), skillWs(ws)))
  handle('skill:setEnabled', (id: string, enabled: boolean, ws?: string) => bridge.setSkillEnabled(String(id), enabled === true, skillWs(ws)))
  handle('skill:save', (input: SkillInput, ws?: string) => {
    const i = input && typeof input === 'object' ? input : ({} as SkillInput)
    return bridge.saveSkill(
      {
        scope: i.scope === 'user' ? 'user' : 'project',
        name: String(i.name ?? ''),
        description: String(i.description ?? ''),
        body: String(i.body ?? '')
      },
      skillWs(ws)
    )
  })
  handle('skill:setScope', (id: string, scope: 'project' | 'user', ws?: string, targetWs?: string) =>
    bridge.changeSkillScope(String(id), scope === 'user' ? 'user' : 'project', skillWs(ws), skillWs(targetWs))
  )
  handle('skill:delete', (id: string, ws?: string) => bridge.deleteSkill(String(id), skillWs(ws)))
  handle('skill:open', async (id: string, ws?: string) => {
    const dir = bridge.getSkill(String(id), skillWs(ws)).dir
    await shell.openPath(dir)
  })
  // 导入现成的技能包：路径只在主进程里（界面拿到的是预览和 importId），确认时按 importId 导入
  handle('skill:pickImport', async (kind: string) => {
    const r =
      kind === 'zip'
        ? await dialog.showOpenDialog(win!, { title: '选择技能包（.zip 或 .skill）', properties: ['openFile'], filters: [{ name: '技能包', extensions: ['zip', 'skill'] }] })
        : await dialog.showOpenDialog(win!, { title: '选择技能文件夹（里面有 SKILL.md，或者装着多个技能）', properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    return bridge.previewSkillImport(r.filePaths[0])
  })
  handle('skill:applyImport', (importId: string, opts: SkillImportOptions, ws?: string) => {
    const o = opts && typeof opts === 'object' ? opts : ({} as SkillImportOptions)
    return bridge.applySkillImport(
      String(importId),
      { scope: o.scope, overwrite: o.overwrite === true, ...(Array.isArray(o.keys) ? { keys: o.keys.map(String) } : {}) },
      skillWs(ws)
    )
  })

  handle('memory:list', () => bridge.listMemories())
  handle('memory:save', (input: MemoryInput) => bridge.saveMemory(input))
  handle('memory:delete', (id: string) => bridge.deleteMemory(id))
  handle('memory:restore', (id: string, version: number) => bridge.restoreMemory(id, version))
  handle('memory:archive', (id: string, archived: boolean) => bridge.archiveMemory(id, archived))

  // 群聊：用户身份，能看到全部频道和全部私聊；channel 不传是大厅
  const optNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const optStr = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  handle('chat:list', (opts?: { channel?: string; after?: number; before?: number; limit?: number; query?: string }) =>
    bridge.listChat({
      channel: optStr(opts?.channel),
      after: optNum(opts?.after),
      before: optNum(opts?.before),
      limit: optNum(opts?.limit),
      query: optStr(opts?.query)
    })
  )
  handle('chat:send', (input: GroupChatSendInput) =>
    bridge.sendChat({ channel: optStr(input?.channel), text: str(input?.text), to: optStr(input?.to), replyTo: optStr(input?.replyTo), ...(input?.attachments !== undefined ? { attachments: input.attachments } : {}) })
  )
  handle('chat:uploadImage', (dataUrl: string, name: string) => bridge.chatAttachments.save(decodeImageBase64(dataUrl), str(name)))
  handle('chat:image', (id: string) => {
    const image = bridge.chatAttachments.read(str(id))
    return `data:${image.mime};base64,${image.data.toString('base64')}`
  })
  handle('chat:markRead', (channel: string, seq: number) => bridge.markChatRead(optStr(channel), Number(seq) || 0))
  handle('chat:channels', () => bridge.listChatChannels())
  // 子代理名单：数组（只留字符串）是选中的，null 是不挑；别的值（没传）是不动
  const subList = (v: unknown): string[] | null | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : v === null ? null : undefined)
  handle('chat:setLead', (channel: string, leadId: string | null, subIds?: unknown) => bridge.setChatLead(optStr(channel), optStr(leadId), subList(subIds)))
  handle('chat:setSubs', (channel: string, subIds: unknown) => bridge.setChatSubs(optStr(channel), subList(subIds) ?? null))
  handle('chat:setParticipants', (channel: string, ids: unknown) => bridge.setChatParticipants(optStr(channel), subList(ids) ?? null))
  // 会话：新开、改名、归档 / 恢复、删除（主群聊和大厅是清空）
  handle('chat:newThread', (workspaceId: string, title?: string) => bridge.createChatThread(str(workspaceId), optStr(title)))
  handle('chat:renameThread', (channel: string, title: string) => bridge.renameChatThread(str(channel), str(title)))
  handle('chat:archiveThread', (channel: string, archived: boolean) => bridge.archiveChatThread(str(channel), archived === true))
  handle('chat:deleteChannel', (channel: string) => bridge.deleteChatChannel(str(channel)))

  // 改动与检查点：只认工作台已知的工作区；paths 只接受检查点里记录过的相对路径（bridge 里校验）
  const strList = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 1000) : undefined
  // ===== 画布 =====
  handle('canvas:all', () => bridge.canvasAll())
  handle('canvas:update', (id: string, ops: CanvasOp[]) => bridge.canvasUpdate(String(id), Array.isArray(ops) ? ops : []))
  handle('canvas:undoState', () => bridge.canvasUndoState())
  handle('canvas:undo', () => bridge.canvasUndo())
  handle('checkpoints:list', (opts?: { workspaceId?: string; agentId?: string; session?: string; limit?: number; elsewhere?: boolean }) =>
    bridge.listCheckpoints({ workspaceId: optStr(opts?.workspaceId), agentId: optStr(opts?.agentId), session: optStr(opts?.session), limit: optNum(opts?.limit), elsewhere: opts?.elsewhere === true })
  )
  handle('checkpoints:summary', (opts?: { workspaceId?: string; stepIds?: string[]; agentId?: string; session?: string; task?: string }) =>
    bridge.checkpointSummary({
      workspaceId: optStr(opts?.workspaceId),
      stepIds: strList(opts?.stepIds),
      agentId: optStr(opts?.agentId),
      session: optStr(opts?.session),
      task: optStr(opts?.task)
    })
  )
  handle('checkpoints:rollback', (opts?: { workspaceId?: string; stepIds?: string[]; session?: string; paths?: string[]; dryRun?: boolean }) =>
    bridge.rollbackCheckpoints({
      workspaceId: optStr(opts?.workspaceId),
      stepIds: strList(opts?.stepIds),
      session: optStr(opts?.session),
      paths: strList(opts?.paths),
      dryRun: opts?.dryRun === true
    })
  )

  // AI 命令监视：用户能看、能停任何 AI 用 run_command 跑的命令
  handle('commands:list', () => bridge.listAiCommands())
  handle('commands:output', (id: string, offset?: number) => bridge.aiCommandOutput(str(id), optNum(offset)))
  handle('commands:cancel', (id: string) => bridge.cancelAiCommand(str(id)))

  // 审计日志：只读数据目录 audit/*.jsonl（已脱敏）。查询条件只取认识的字段
  const auditQ = (q: unknown): AuditQuery => {
    const x = (q && typeof q === 'object' ? q : {}) as Record<string, unknown>
    return {
      from: optNum(x.from),
      to: optNum(x.to),
      agentId: optStr(x.agentId),
      tool: optStr(x.tool),
      status: x.status === 'ok' || x.status === 'error' ? x.status : undefined,
      workspaceId: optStr(x.workspaceId),
      text: optStr(x.text),
      limit: optNum(x.limit),
      cursor: optStr(x.cursor)
    }
  }
  handle('audit:query', (q: unknown) => bridge.audit.query(auditQ(q)))
  handle('audit:stats', (q: unknown) => bridge.audit.stats(auditQ(q)))
  handle('audit:export', async (q: unknown) => {
    const r = await bridge.audit.exportCsv(auditQ(q))
    const pick = await dialog.showSaveDialog(win!, {
      title: '导出审计日志',
      defaultPath: `审计日志-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (pick.canceled || !pick.filePath) return { saved: false, rows: r.rows, truncated: r.truncated }
    await fsp.writeFile(pick.filePath, r.csv, 'utf8')
    return { saved: true, path: pick.filePath, rows: r.rows, truncated: r.truncated }
  })

  // ===== 设置备份与恢复、诊断报告 =====
  handle('backup:export', async (opts?: { includeTokens?: boolean }) => {
    const includeTokens = opts?.includeTokens === true
    const text = bridge.exportBackup({ includeTokens })
    const pick = await dialog.showSaveDialog(win!, {
      title: includeTokens ? '导出设置备份（含 token，请像密码一样保管）' : '导出设置备份（不含 token）',
      defaultPath: `workspace-bridge-备份-${new Date().toISOString().slice(0, 10)}${includeTokens ? '' : '-无token'}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (pick.canceled || !pick.filePath) return { saved: false }
    await fsp.writeFile(pick.filePath, text, 'utf8')
    return { saved: true, path: pick.filePath }
  })
  // 选文件、解析、预览；文件内容留在主进程，界面只拿到预览和 importId
  handle('backup:pickImport', async () => {
    const r = await dialog.showOpenDialog(win!, { title: '选择要导入的设置备份', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    const st = await fsp.stat(r.filePaths[0])
    if (st.size > 10 * 1024 * 1024) throw new Error('备份文件太大（超过 10 MB），不像是本应用导出的')
    return { ...bridge.previewImport(await fsp.readFile(r.filePaths[0], 'utf8')), file: r.filePaths[0] }
  })
  handle('backup:applyImport', (importId: string) => bridge.applyImport(String(importId)))
  handle('diagnostics:report', () => bridge.diagnosticsReport())
  handle('diagnostics:save', async () => {
    // 保存时在主进程重新生成，不写界面传来的文本
    const text = bridge.diagnosticsReport()
    const pick = await dialog.showSaveDialog(win!, {
      title: '保存诊断报告',
      defaultPath: `workspace-bridge-诊断-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (pick.canceled || !pick.filePath) return { saved: false }
    await fsp.writeFile(pick.filePath, text, 'utf8')
    return { saved: true, path: pick.filePath }
  })

  // ===== 定时任务 =====
  // 字段由 scheduler 逐个校验（频率、动作里的 AI / 工作区 / 频道要存在），这里只挡掉不是对象的输入
  handle('schedules:list', () => bridge.listSchedules())
  handle('schedules:save', (input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('参数不对')
    return bridge.saveSchedule(input as ScheduleInput)
  })
  handle('schedules:delete', (id: string) => bridge.deleteSchedule(String(id)))
  handle('schedules:runNow', (id: string) => bridge.runScheduleNow(String(id)))

  // 最后一个参数是工作区 id：不给是当前工作区，任务页看「整台电脑」的任务板时给它的 id
  const taskWs = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  handle('task:list', (ws?: string) => bridge.listTasks(taskWs(ws)))
  handle('task:create', (input: TaskInput, ws?: string) => bridge.createTask({ ...input, assigneeId: input.assigneeId || undefined }, taskWs(ws)))
  handle('task:edit', (id: string, input: Partial<TaskInput>, ws?: string) => bridge.editTask(id, input, taskWs(ws)))
  handle('task:status', (id: string, status: TaskStatus, note?: string, ws?: string) => bridge.setTaskStatus(id, status, note, taskWs(ws)))
  handle('task:assign', (id: string, assigneeId: string | null, ws?: string) => bridge.assignTask(id, assigneeId || undefined, taskWs(ws)))
  handle('task:review', (id: string, decision: 'accept' | 'reject', note?: string, ws?: string) => bridge.reviewTask(id, decision, note, taskWs(ws)))
  handle('task:delete', (id: string, ws?: string) => bridge.deleteTask(id, taskWs(ws)))
  // 任务的线：这条任务自己的会话（没有就现开）
  handle('task:thread', (id: string, ws?: string) => bridge.taskChatThread(str(id), taskWs(ws)))
  handle('task:answerQuestion', (id: string, questionId: string, answer: string, ws?: string) => bridge.answerTaskQuestion(id, questionId, answer, taskWs(ws)))
  handle('task:closeQuestion', (id: string, questionId: string, note?: string, ws?: string) => bridge.closeTaskQuestion(id, questionId, note, taskWs(ws)))

  // ===== 回收站 =====
  handle('trash:list', () => bridge.listTrash())
  handle('trash:restore', (id: string, ws?: string) => bridge.restoreTrash(String(id), typeof ws === 'string' && ws ? ws : undefined))
  handle('trash:purge', (ids?: string[]) => bridge.purgeTrash(Array.isArray(ids) ? ids.map(String) : undefined))

  // ===== 搜索（ui-skills） =====
  // 工作台自己的搜索：只搜目录还在的工作区；用户模式能搜到 .env，.git 和应用数据目录跳过
  const search = new SearchService({
    dataDir: bridge.config.dataDir,
    roots: () =>
      (bridge.getState().workspaces ?? [])
        .filter((w) => w.exists)
        .map((w) => ({ id: w.id, root: w.root, ...(w.kind === 'machine' ? { machine: true } : {}) }))
  })
  handle('search:files', (opts: SearchOptions) => search.search(opts))
  handle('search:listFiles', (workspaceId?: string) => search.listFiles(typeof workspaceId === 'string' ? workspaceId : undefined))

  // ===== 终端（skills-core） =====
  // 用户自己的终端，不对 AI 开放。cwd：指定了工作区用它的根目录，否则当前工作区，再否则用户主目录
  const term = new TerminalManager({
    findWorkspace: (id) => {
      const s = bridge.getState()
      const list = s.workspaces ?? []
      const w = list.find((x) => x.id === (id ?? s.activeWorkspaceId))
      return w ? { id: w.id, name: w.name, root: w.root } : undefined
    },
    onData: (id, data) => send('terminal:data', { id, data }),
    onExit: (id, exitCode) => send('terminal:exit', { id, exitCode })
  })
  terminals = term
  // 打字、改大小走 send（没有回复），同样只接受本窗口；异常吞掉，免得 Electron 弹主进程错误框
  const on = (channel: string, fn: (...args: unknown[]) => void) => {
    senders.set(channel, fn)
    ipcMain.on(channel, (e: IpcMainEvent, ...args: unknown[]) => {
      if (!win || e.sender !== win.webContents) return
      try {
        fn(...args)
      } catch {
        // 终端刚退出之类，忽略
      }
    })
  }
  handle('terminal:create', (opts?: TerminalCreateOptions) => {
    const o: Partial<TerminalCreateOptions> = opts && typeof opts === 'object' ? opts : {}
    return term.create({
      ...(typeof o.workspaceId === 'string' ? { workspaceId: o.workspaceId } : {}),
      ...(typeof o.cwd === 'string' ? { cwd: o.cwd } : {}),
      ...(typeof o.shell === 'string' ? { shell: o.shell } : {}),
      ...(typeof o.cols === 'number' ? { cols: o.cols } : {}),
      ...(typeof o.rows === 'number' ? { rows: o.rows } : {})
    })
  })
  handle('terminal:list', () => term.list())
  handle('terminal:kill', (id: string) => term.kill(String(id)))
  handle('terminal:buffer', (id: string) => term.buffer(String(id)))
  on('terminal:write', (id, data) => {
    if (typeof id === 'string' && typeof data === 'string') term.write(id, data)
  })
  on('terminal:resize', (id, cols, rows) => {
    if (typeof id === 'string') term.resize(id, Number(cols), Number(rows))
  })

  // ===== 内置 AI（mcp-layer） =====
  // apiKey 用系统加密（Windows 是 DPAPI，换电脑或换系统账号就解不开）；不可用时返回 null，store 退回明文
  const secrets: SecretBox = {
    seal: (plain) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plain).toString('base64') : null),
    open: (sealed) => safeStorage.decryptString(Buffer.from(sealed, 'base64'))
  }
  const llmSvc = new LlmService({
    dataDir: bridge.config.dataDir,
    host: bridgeHost(bridge),
    // net.fetch 走系统代理：用户开了代理也能连海外的提供方
    fetch: (url, init) => net.fetch(url, init),
    secrets
  })
  llm = llmSvc
  // 备份恢复带上内置 AI 的提供方（不含 API Key）
  bridge.setLlmBackup(llmSvc)
  // 定时任务的 builtin 动作：直接给内置 AI 发一条消息（没绑模型时 bridge 先报错，不会走到 sendChat）
  bridge.setBuiltinRunner({
    hasModel: (agentId) => llmSvc.getAgentModel(agentId) !== null,
    send: (agentId, text) => llmSvc.sendChat(agentId, text)
  })
  llmSvc.on('chat', (s) => send('llm:chat', s))
  llmSvc.on('changed', (kind) => send('bridge:changed', kind))
  const llmStr = (v: unknown) => (typeof v === 'string' ? v : '')
  handle('llm:listProviders', () => llmSvc.listProviders())
  // 字段由 store 逐个校验，这里不重复
  handle('llm:saveProvider', (input: ProviderInput) => llmSvc.saveProvider(input))
  handle('llm:removeProvider', (id: string) => llmSvc.removeProvider(llmStr(id)))
  handle('llm:fetchModels', (id: string) => llmSvc.fetchProviderModels(llmStr(id)))
  handle('llm:testProvider', (id: string, model: string) => llmSvc.testProvider(llmStr(id), llmStr(model)))
  handle('llm:listAgentModels', () => llmSvc.listAgentModels())
  handle('llm:getAgentModel', (agentId: string) => llmSvc.getAgentModel(llmStr(agentId)))
  handle('llm:setAgentModel', (agentId: string, model: AgentModel | null) => llmSvc.setAgentModel(llmStr(agentId), model))
  handle('llm:getChat', (agentId: string) => llmSvc.getChat(llmStr(agentId)))
  handle('llm:sendChat', (agentId: string, text: string) => llmSvc.sendChat(llmStr(agentId), llmStr(text)))
  handle('llm:stopChat', (agentId: string) => llmSvc.stopChat(llmStr(agentId)))
  handle('llm:clearChat', (agentId: string) => llmSvc.clearChat(llmStr(agentId)))

  handle('clipboard:write', (text: string) => clipboard.writeText(String(text)))
  // 右栏网页标签：清掉登录状态和缓存
  handle('browser:clearData', () => clearBrowserData())
  // 指纹和 CDP：现状、改设置；网页开始加载前先装好指纹
  handle('browser:status', () => browserStatus())
  handle('browser:setPrefs', (patch: { cdp?: boolean; fingerprint?: boolean; regenerate?: boolean; region?: boolean; refreshRegion?: boolean; proxy?: string }) => setBrowserPrefs(patch))
  handle('browser:prepare', (wcId: number, tabId: string) => prepareBrowserTab(Number(wcId), String(tabId ?? '')))

  // ===== 远端查看 =====
  // 用手机 / 平板的浏览器打开这个界面。和电脑上的窗口功能一样（包括终端和设置），所以默认关着，
  // 每次打开都是新口令，关掉后链接和已经打开的页面立刻失效
  const rv = new RemoteViewServer({
    staticRoot: path.resolve(here, '../renderer'),
    invoke: (channel, args) => {
      if (LOCAL_ONLY.has(channel)) throw new Error('REMOTE_UNAVAILABLE：这个操作要在电脑上弹出窗口，只能在电脑上的工作台里做')
      // 改访问方式会马上换链接，把远端自己踢掉；而且「让局域网也能进」这种事该由坐在电脑前的人决定
      if (channel === 'remote:options') throw new Error('REMOTE_UNAVAILABLE：远端查看的访问方式只能在电脑上的工作台里改')
      const fn = invokers.get(channel)
      if (!fn) throw new Error(`No handler registered for '${channel}'`)
      return fn(...args)
    },
    send: (channel, args) => senders.get(channel)?.(...args),
    onVisit: () => {
      // 新进来的设备也记下，重启后它那个页面不用重新进
      remoteSaveKept?.()
      send('remote:changed', remoteStatus())
    }
  })
  remoteView = rv
  const tun = new TunnelManager({ onChange: () => send('remote:changed', remoteStatus()) })
  remoteTunnel = tun
  handle('remote:status', () => remoteStatus())
  const prefsFile = path.join(bridge.config.dataDir, 'remote-view.json')
  remotePrefs = readRemotePrefs(prefsFile)
  // 「重启后保留」：端口、口令、已经进来的设备记在 remote-view-kept.json；留下来的隧道进程的记录和日志放 remote-tunnel 目录
  const keptFile = path.join(bridge.config.dataDir, 'remote-view-kept.json')
  const keptTunnelDir = path.join(bridge.config.dataDir, 'remote-tunnel')
  const saveKept = (): void => {
    const s = remotePrefs.keep ? rv.resumeState() : undefined
    if (s) writeRemoteKept(keptFile, { ...s, tunnel: remoteWantsTunnel, lan: remoteLan })
  }
  remoteSaveKept = saveKept
  /** 上次退出时留下来的隧道进程：端口对得上就接着用（公网地址不变），对不上就结束掉。port=0 一定对不上，只做清理 */
  const adoptTunnel = (port: number): boolean => {
    try {
      return tun.adopt(keptTunnelDir, { mode: 'quick', port })
    } catch {
      return false
    }
  }
  const startTunnel = (port: number): void => {
    if (adoptTunnel(port)) return
    // isolate：留下来的 cloudflared 不能带着这个应用的监听端口（调试端口等），不然重启后的应用开不了同一个端口
    void tun.start({ mode: 'quick', port, ...(remotePrefs.keep ? { keepDir: keptTunnelDir, isolate: true } : {}) })
  }
  /** 开启（或按新的访问方式重开）。tunnel / lan 不给就用记住的；resume = 工作台重启后接着上次开 */
  const startRemote = async (o: { renew?: boolean; tunnel?: boolean; lan?: boolean }, resume?: RemoteKeptRecord): Promise<RemoteViewStatus> => {
    const wantLan = typeof o.lan === 'boolean' ? o.lan : remotePrefs.lan
    const wantTunnel = typeof o.tunnel === 'boolean' ? o.tunnel : remotePrefs.tunnel
    const host = wantLan ? remoteLanHost() : '127.0.0.1'
    const cur = rv.info()
    // 监听的地址要变（开 / 关局域网）只能关了重开，口令也跟着换
    if (o.renew === true || (cur.running && cur.host !== host)) {
      await tun.stop()
      await rv.stop()
    }
    const fresh = !rv.info().running
    const info = await rv.start(host, resume)
    if (fresh) remoteResumed = Boolean(resume)
    remoteLan = wantLan
    remoteWantsTunnel = wantTunnel
    const ts = tun.status().state
    // 申请公网地址要十几秒，不等它：先回「连接中」，连上或失败时 onChange 再通知界面
    if (remoteWantsTunnel && ts !== 'running' && ts !== 'starting') startTunnel(info.port!)
    if (!remoteWantsTunnel) {
      if (ts !== 'off') void tun.stop()
      else adoptTunnel(0)
    }
    if (remotePrefs.keep) saveKept()
    else removeRemoteKept(keptFile)
    send('remote:changed', remoteStatus())
    return remoteStatus()
  }
  handle('remote:start', (opts?: { renew?: boolean; tunnel?: boolean; lan?: boolean }) => startRemote(opts && typeof opts === 'object' ? opts : {}))
  // 改访问方式并记住；正开着就按新的重开（旧链接失效）
  handle('remote:options', async (opts?: { tunnel?: boolean; lan?: boolean; keep?: boolean }) => {
    const o = opts && typeof opts === 'object' ? opts : {}
    const keep = typeof o.keep === 'boolean' ? o.keep : remotePrefs.keep === true
    const keepChanged = keep !== (remotePrefs.keep === true)
    const next: RemotePrefs = { tunnel: typeof o.tunnel === 'boolean' ? o.tunnel : remotePrefs.tunnel, lan: typeof o.lan === 'boolean' ? o.lan : remotePrefs.lan, ...(keep ? { keep: true } : {}) }
    if (!next.tunnel && !next.lan) throw new Error('公网链接和局域网至少留一个，不然手机进不来')
    const running = rv.info().running
    const changed = running ? next.tunnel !== remoteWantsTunnel || next.lan !== remoteLan : next.tunnel !== remotePrefs.tunnel || next.lan !== remotePrefs.lan
    remotePrefs = next
    writeRemotePrefs(prefsFile, next)
    if (running && changed) return startRemote({ renew: true, tunnel: next.tunnel, lan: next.lan })
    if (keepChanged && !keep) {
      // 关掉「重启后保留」：记录删掉；正在用的隧道这次接着用，退出时照常结束
      removeRemoteKept(keptFile)
    } else if (keepChanged && running) {
      saveKept()
      // 正在用的公网地址不是以保留方式申请的，退出时留不住：现在就换成留得住的。公网地址马上换一次，口令和局域网链接不变
      if (remoteWantsTunnel && !tun.status().kept) {
        await tun.stop()
        startTunnel(rv.info().port!)
      }
    }
    send('remote:changed', remoteStatus())
    return remoteStatus()
  })
  handle('remote:stop', () => {
    // 用户自己关的：重启后不再接着开
    removeRemoteKept(keptFile)
    // 晚一点再停：从远端页面发来的这次调用要先收到回复
    setTimeout(() => {
      void tun
        .stop()
        .then(() => rv.stop())
        .then(() => {
          // 停下来之前这一小会儿要是正好有人进来，记录又会被写一次：停稳以后再删一遍
          removeRemoteKept(keptFile)
          send('remote:changed', remoteStatus())
        })
    }, 50)
    return { state: 'off', visits: 0, tunnel: remotePrefs.tunnel, lan: remotePrefs.lan, keep: remotePrefs.keep === true } satisfies RemoteViewStatus
  })

  // 「重启后保留」：上次退出时开着，就用原来的端口和口令接着开（留下来的隧道进程还在的话公网地址也不变）
  const keptRec = remotePrefs.keep ? readRemoteKept(keptFile) : undefined
  if (keptRec) {
    void startRemote({ tunnel: keptRec.tunnel, lan: keptRec.lan }, keptRec).catch(() => undefined)
  } else {
    removeRemoteKept(keptFile)
    adoptTunnel(0)
  }
}

/** 把 out/renderer 挂到 app://bundle 上。只读，而且只认这个目录里的文件 */
function serveRenderer(): void {
  const root = path.resolve(here, '../renderer')
  protocol.handle('app', async (request) => {
    let rel = ''
    try {
      rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '')
    } catch {
      return new Response('bad request', { status: 400 })
    }
    // app://bundle/ 就是 index.html
    if (!rel) rel = 'index.html'
    const file = path.resolve(root, rel)
    // 挡住 ../ 这类跳出渲染目录去读别的文件
    if (file !== root && !file.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 })
    try {
      const data = await fsp.readFile(file)
      return new Response(data, {
        headers: { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' }
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

async function main(): Promise<void> {
  // WB_DATA_DIR 用于便携模式和测试，不设时放在系统应用数据目录
  bridge = new Bridge({
    dataDir: process.env.WB_DATA_DIR || path.join(app.getPath('userData'), 'bridge'),
    // 「整台电脑」相对路径的起点，默认用户主目录。实测脚本设成临时目录，免得把测试技能写进真实的主目录
    ...(process.env.WB_MACHINE_ROOT ? { machineRoot: process.env.WB_MACHINE_ROOT } : {}),
    // AI 的 kill_process 不能结束工作台自己的渲染 / GPU / 网络进程，以及用户在底部开的终端
    protectedPids: () => {
      const rt = remoteTunnel?.pid()
      return [...app.getAppMetrics().map((m) => m.pid), ...(terminals?.pids() ?? []), ...(rt ? [rt] : [])]
    },
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    // AI 的 browser_info / browser_open / browser_close
    browser: browserHost
  })
  bridge.on('state', (s) => send('bridge:state', s))
  bridge.on('event', (ev) => send('bridge:event', ev))
  // 群聊新消息：第二个参数是 GroupMessage；其他 kind 的第二个参数是 workspaceId，界面不用，不往外发
  bridge.on('changed', (kind, payload) => {
    if (kind === 'chat') {
      send('bridge:changed', kind, payload)
      if (payload) maybeNotifyChat(payload as GroupMessage)
    } else send('bridge:changed', kind)
    // 任务变了（提问、交活）、画布变了（看过交付）：看看有没有新的事等用户
    if (kind === 'tasks' || kind === 'canvas') scheduleAttentionCheck()
  })
  // 成员状态变了（可能卡住）会发 state
  bridge.on('state', scheduleAttentionCheck)
  registerIpc()
  serveRenderer()
  await bridge.start()
  createWindow()

  app.on('activate', () => {
    if (!win) createWindow()
  })
}

function focusWindow(): void {
  if (!win) return createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * 群聊桌面通知：窗口不在前台时，AI 在群里 @你、@所有人 或私聊你，弹一条系统通知，点开跳到那个频道。
 * 同一频道 10 秒内只弹一次（AI 连发多条时合并），避免刷屏
 */
const chatNotifyAt = new Map<string, number>()
const chatNotices = new Set<Notification>()
function maybeNotifyChat(msg: GroupMessage): void {
  if (msg.from.kind === 'user') return
  const toUser = msg.to === 'user' || msg.mentions.includes('user') || msg.mentions.includes('*')
  if (!toUser) return
  const focused = !!win && !win.isDestroyed() && win.isFocused() && win.isVisible()
  if (focused) return
  const now = Date.now()
  if (now - (chatNotifyAt.get(msg.channel) ?? 0) < 10_000) return
  chatNotifyAt.set(msg.channel, now)
  if (win && !win.isDestroyed()) win.flashFrame(true)
  if (!Notification.isSupported()) return
  const where = msg.to ? '私聊你' : msg.channel === 'general' ? '在大厅' : `在 ${bridge.listChatChannels().find((c) => c.id === msg.channel)?.name ?? '群聊'}`
  const text = msg.text.replace(/\s+/g, ' ').slice(0, 160)
  const n = new Notification({ title: `${msg.from.name} ${where}${msg.to ? '' : ' @了你'}`, body: text })
  chatNotices.add(n)
  n.on('click', () => {
    chatNotices.delete(n)
    focusWindow()
    send('app:navigate', { section: 'group', id: msg.channel })
  })
  n.on('close', () => chatNotices.delete(n))
  n.show()
}

/**
 * 有事等用户时的系统通知（T-19）：AI 提问题、交活等验收、做完交付、手上有活却可能卡住。
 * 同一件事只弹一次；用户正看着工作台时不弹（也不补弹）；设置里能关。
 * 点开跳到画布，id 是「工作区 id:卡片 id」，画布照它切项目、定位那张卡片。
 * 状态变化很密，3 秒内只算一次
 */
const attentionTracker = new AttentionTracker()
const attentionNotices = new Set<Notification>()
let attentionTimer: NodeJS.Timeout | null = null
function scheduleAttentionCheck(): void {
  if (attentionTimer) return
  attentionTimer = setTimeout(() => {
    attentionTimer = null
    try {
      maybeNotifyAttention()
    } catch {
      // 算不出来就这次不弹，不影响别的
    }
  }, 3000)
  attentionTimer.unref?.()
}
function maybeNotifyAttention(): void {
  if (!bridge || quitting) return
  const looking = !!win && !win.isDestroyed() && win.isFocused() && win.isVisible()
  // 关着开关也照样记，打开时不把旧事一起弹出来
  const msg = attentionMessage(attentionTracker.update(collectAttention(bridge.attentionSources()), looking))
  if (!msg || !bridge.attentionNotifyOn()) return
  if (win && !win.isDestroyed()) win.flashFrame(true)
  if (!Notification.isSupported()) return
  const n = new Notification({ title: msg.title, body: msg.body })
  attentionNotices.add(n)
  n.on('click', () => {
    attentionNotices.delete(n)
    focusWindow()
    send('app:navigate', { section: 'canvas', id: `${msg.target.workspaceId}:${msg.target.cardId}` })
  })
  n.on('close', () => attentionNotices.delete(n))
  n.show()
}

app.on('browser-window-focus', (_e, w) => {
  if (w === win) w.flashFrame(false)
})

// 还没有托盘：关窗口即退出，退出前停服务、落盘审计日志
app.on('window-all-closed', () => app.quit())
app.on('before-quit', (e) => {
  // 从菜单「退出」走到这里时窗口还开着：有没保存的改动就先不退，改成请窗口关闭（它会弹对话框问）。
  // 下面几个 before-quit 监听也各自看 holdForUnsaved()，这一轮什么都不停
  if (holdForUnsaved()) {
    e.preventDefault()
    win?.close()
    return
  }
  if (quitting || !bridge) return
  e.preventDefault()
  quitting = true
  bridge.stop().finally(() => app.quit())
})

// ===== 终端（skills-core） =====
// 单独挂一个监听，不改上面的退出流程；killAll 可以重复调用（上面会再触发一次 before-quit）
app.on('before-quit', () => {
  if (!holdForUnsaved()) terminals?.killAll()
})

// ===== 远端查看 =====
let remoteQuitDone = false
app.on('before-quit', () => {
  // before-quit 会来两次（第一次被上面拦下等服务停完），只处理一次
  if (remoteQuitDone || holdForUnsaved()) return
  remoteQuitDone = true
  if (remotePrefs.keep && remoteView?.info().running) {
    // 「重启后保留」：记下现在的端口、口令和已经进来的设备；隧道进程留着不结束，下次启动接着用
    remoteSaveKept?.()
    if (!remoteTunnel?.detach()) void remoteTunnel?.stop()
  } else void remoteTunnel?.stop()
  void remoteView?.stop()
})

// ===== 工具试用台 =====
let playgroundInst: Playground | undefined
function playground(): Playground {
  playgroundInst ??= new Playground({ connectionInfo: (id) => bridge.connectionInfo(id) })
  return playgroundInst
}
// 退出前结束试用台的会话；dispose 可以重复调用
app.on('before-quit', () => {
  if (!holdForUnsaved()) void playgroundInst?.dispose()
})

// ===== 内置 AI（mcp-layer） =====
// 同样单独挂一个：停下正在跑的对话，等它们把已有内容落盘再退出（不能指望比 bridge.stop 先写完）。
// 最多等 5 秒，免得某个请求卡住让应用关不掉
let llmClosing: Promise<void> | undefined
let llmClosed = false
app.on('before-quit', (e) => {
  if (!llm || llmClosed || holdForUnsaved()) return
  e.preventDefault()
  llmClosing ??= Promise.race([llm.close().catch(() => {}), new Promise<void>((r) => setTimeout(r, 5000))]).then(() => {
    llmClosed = true
    app.quit()
  })
})
