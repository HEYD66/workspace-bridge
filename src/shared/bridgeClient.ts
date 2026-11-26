import type { BridgeApi } from './api'

/**
 * 界面和后端之间的传输层。本机窗口用 Electron 的 IPC（src/preload），远端查看的浏览器用 HTTP（src/renderer/src/remoteBridge.ts），
 * 两边共用下面同一张「方法名 → 通道名」的表，免得加了接口只有一边能用。
 */
export interface BridgeTransport {
  /** 调一个有返回值的通道 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke(channel: string, ...args: unknown[]): Promise<any>
  /** 发了就不管的通道（终端打字、改大小） */
  send(channel: string, ...args: unknown[]): void
  /** 订阅后端的推送，回调拿到推送的全部参数；返回取消订阅的函数 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(channel: string, cb: (...args: any[]) => void): () => void
}

/** remote：这个页面是不是用浏览器从远端链接打开的 */
export function createBridgeApi(t: BridgeTransport, remote = false): BridgeApi {
  const invoke = (channel: string, ...args: unknown[]) => t.invoke(channel, ...args)
  const subscribe = <T>(channel: string, cb: (v: T) => void): (() => void) => t.on(channel, (v: T) => cb(v))

  return {
    getState: () => invoke('bridge:getState'),
    getEvents: () => invoke('bridge:getEvents'),
    setPaused: (paused) => invoke('bridge:setPaused', paused),
    // ===== 多工作区（ws-core） =====
    addWorkspace: () => invoke('workspace:add'),
    chooseWorkspace: () => invoke('workspace:add'),
    pickWorkspaceFolder: () => invoke('workspace:pickFolder'),
    addWorkspaceAt: (root, members) => invoke('workspace:addAt', root, members),
    setWorkspaceMembers: (id, members) => invoke('workspace:setMembers', id, members),
    removeWorkspace: (id) => invoke('workspace:remove', id),
    renameWorkspace: (id, name) => invoke('workspace:rename', id, name),
    setActiveWorkspace: (id) => invoke('workspace:setActive', id),
    openWorkspace: (id) => invoke('workspace:open', id),
    setPort: (port) => invoke('settings:setPort', port),
    setLanEnabled: (enabled) => invoke('settings:setLan', enabled),
    setAuthMode: (mode) => invoke('settings:setAuthMode', mode),
    setNotifyAttention: (on) => invoke('settings:setNotifyAttention', on),

    setTunnelSettings: (patch) => invoke('tunnel:settings', patch),
    startTunnel: () => invoke('tunnel:start'),
    stopTunnel: () => invoke('tunnel:stop'),

    approveOAuth: (pendingId, agentId) => invoke('oauth:approve', pendingId, agentId),
    denyOAuth: (pendingId) => invoke('oauth:deny', pendingId),
    listOAuthGrants: () => invoke('oauth:grants'),
    revokeOAuthGrant: (grantId) => invoke('oauth:revoke', grantId),

    // ===== 工作台文件读写（ws-core） =====
    listDir: (workspaceId, path) => invoke('files:list', workspaceId, path),
    readFile: (workspaceId, path) => invoke('files:read', workspaceId, path),
    saveFile: (workspaceId, path, content, expectedVersion) => invoke('files:save', workspaceId, path, content, expectedVersion),
    createFile: (workspaceId, path) => invoke('files:createFile', workspaceId, path),
    createDir: (workspaceId, path) => invoke('files:createDir', workspaceId, path),
    renamePath: (workspaceId, from, to) => invoke('files:rename', workspaceId, from, to),
    deletePath: (workspaceId, path) => invoke('files:delete', workspaceId, path),
    revealPath: (workspaceId, path) => invoke('files:reveal', workspaceId, path),

    createAgent: (name, roleId, machineAccess) => invoke('agent:create', name, roleId, machineAccess),
    updateAgent: (id, patch) => invoke('agent:update', id, patch),
    rotateToken: (id) => invoke('agent:rotate', id),
    listAgentSessions: (id) => invoke('agent:sessions', id),
    disconnectAgent: (id, sessionId) => invoke('agent:disconnect', id, sessionId),
    removeAgent: (id) => invoke('agent:remove', id),
    connectionInfo: (id) => invoke('agent:connection', id),
    exportClientConfig: (id) => invoke('agent:exportConfig', id),
    testConnection: (agentId, which) => invoke('connect:test', agentId, which),
    playgroundTools: (agentId) => invoke('playground:tools', agentId),
    playgroundCall: (agentId, name, args) => invoke('playground:call', agentId, name, args),

    saveRole: (input) => invoke('role:save', input),
    removeRole: (id) => invoke('role:remove', id),


    listSkills: (ws) => invoke('skill:list', ws),
    getSkill: (id, ws) => invoke('skill:get', id, ws),
    setSkillEnabled: (id, enabled, ws) => invoke('skill:setEnabled', id, enabled, ws),
    saveSkill: (input, ws) => invoke('skill:save', input, ws),
    setSkillScope: (id, scope, ws, targetWs) => invoke('skill:setScope', id, scope, ws, targetWs),
    deleteSkill: (id, ws) => invoke('skill:delete', id, ws),
    openSkillDir: (id, ws) => invoke('skill:open', id, ws),
    pickSkillImport: (kind) => invoke('skill:pickImport', kind),
    applySkillImport: (importId, opts, ws) => invoke('skill:applyImport', importId, opts, ws),

    listMemories: () => invoke('memory:list'),
    saveMemory: (input) => invoke('memory:save', input),
    deleteMemory: (id) => invoke('memory:delete', id),
    restoreMemory: (id, version) => invoke('memory:restore', id, version),
    archiveMemory: (id, archived) => invoke('memory:archive', id, archived),

    listTasks: (workspaceId) => invoke('task:list', workspaceId),
    createTask: (input, workspaceId) => invoke('task:create', input, workspaceId),
    editTask: (id, input, workspaceId) => invoke('task:edit', id, input, workspaceId),
    setTaskStatus: (id, status, note, workspaceId) => invoke('task:status', id, status, note, workspaceId),
    assignTask: (id, assigneeId, workspaceId) => invoke('task:assign', id, assigneeId, workspaceId),
    reviewTask: (id, decision, note, workspaceId) => invoke('task:review', id, decision, note, workspaceId),
    deleteTask: (id, workspaceId) => invoke('task:delete', id, workspaceId),
    taskThread: (id, workspaceId) => invoke('task:thread', id, workspaceId),
    answerTaskQuestion: (id, questionId, answer, workspaceId) => invoke('task:answerQuestion', id, questionId, answer, workspaceId),
    closeTaskQuestion: (id, questionId, note, workspaceId) => invoke('task:closeQuestion', id, questionId, note, workspaceId),

    // ===== 回收站 =====
    listTrash: () => invoke('trash:list'),
    restoreTrash: (id, workspaceId) => invoke('trash:restore', id, workspaceId),
    purgeTrash: (ids) => invoke('trash:purge', ids),

    // ===== 搜索（ui-skills） =====
    searchFiles: (opts) => invoke('search:files', opts),
    listAllFiles: (workspaceId) => invoke('search:listFiles', workspaceId),

    // ===== 终端（skills-core） =====
    terminalCreate: (opts) => invoke('terminal:create', opts),
    terminalList: () => invoke('terminal:list'),
    // 打字和改大小很频繁，用 send 不等回复
    terminalWrite: (id, data) => t.send('terminal:write', id, data),
    terminalResize: (id, cols, rows) => t.send('terminal:resize', id, cols, rows),
    terminalKill: (id) => invoke('terminal:kill', id),
    terminalBuffer: (id) => invoke('terminal:buffer', id),
    onTerminalData: (cb) => subscribe<{ id: string; data: string }>('terminal:data', (v) => cb(v.id, v.data)),
    onTerminalExit: (cb) => subscribe<{ id: string; exitCode: number }>('terminal:exit', (v) => cb(v.id, v.exitCode)),

    // ===== 内置 AI（mcp-layer） =====
    listProviders: () => invoke('llm:listProviders'),
    saveProvider: (input) => invoke('llm:saveProvider', input),
    removeProvider: (id) => invoke('llm:removeProvider', id),
    fetchProviderModels: (id) => invoke('llm:fetchModels', id),
    testProvider: (id, model) => invoke('llm:testProvider', id, model),
    listAgentModels: () => invoke('llm:listAgentModels'),
    getAgentModel: (agentId) => invoke('llm:getAgentModel', agentId),
    setAgentModel: (agentId, model) => invoke('llm:setAgentModel', agentId, model),
    getChat: (agentId) => invoke('llm:getChat', agentId),
    sendChat: (agentId, text) => invoke('llm:sendChat', agentId, text),
    stopChat: (agentId) => invoke('llm:stopChat', agentId),
    clearChat: (agentId) => invoke('llm:clearChat', agentId),
    onChat: (cb) => subscribe('llm:chat', cb),

    copy: (text) => invoke('clipboard:write', text),
    setUnsaved: (paths) => invoke('app:unsaved', paths),
    onState: (cb) => subscribe('bridge:state', cb),
    onEvent: (cb) => subscribe('bridge:event', cb),
    // 第二个参数只有群聊（kind='chat'）才有
    onChanged: (cb) => t.on('bridge:changed', (kind, payload) => cb(kind, payload)),

    // ===== 群聊 =====
    listGroupChat: (opts) => invoke('chat:list', opts ?? {}),
    sendGroupChat: (input) => invoke('chat:send', input),
    uploadChatImage: (dataUrl, name) => invoke('chat:uploadImage', dataUrl, name),
    chatImage: (id) => invoke('chat:image', id),
    markGroupChatRead: (channel, seq) => invoke('chat:markRead', channel, seq),
    listGroupChannels: () => invoke('chat:channels'),
    setGroupChatLead: (channel, leadId, subIds) => invoke('chat:setLead', channel, leadId, subIds),
    setGroupChatSubs: (channel, subIds) => invoke('chat:setSubs', channel, subIds),
    setGroupChatParticipants: (channel, ids) => invoke('chat:setParticipants', channel, ids),
    newGroupChatThread: (workspaceId, title) => invoke('chat:newThread', workspaceId, title),
    renameGroupChatThread: (channel, title) => invoke('chat:renameThread', channel, title),
    archiveGroupChatThread: (channel, archived) => invoke('chat:archiveThread', channel, archived),
    deleteGroupChannel: (channel) => invoke('chat:deleteChannel', channel),

    // ===== 改动与检查点 =====
    listCheckpoints: (opts) => invoke('checkpoints:list', opts ?? {}),
    checkpointSummary: (opts) => invoke('checkpoints:summary', opts),
    rollbackCheckpoints: (opts) => invoke('checkpoints:rollback', opts),

    // ===== 画布 =====
    canvasAll: () => invoke('canvas:all'),
    canvasUpdate: (id, ops) => invoke('canvas:update', id, ops),
    canvasUndoState: () => invoke('canvas:undoState'),
    canvasUndo: () => invoke('canvas:undo'),

    // ===== 设置备份与恢复、诊断报告 =====
    exportBackup: (opts) => invoke('backup:export', opts),
    pickImportBackup: () => invoke('backup:pickImport'),
    applyImportBackup: (importId) => invoke('backup:applyImport', importId),
    diagnosticsReport: () => invoke('diagnostics:report'),
    saveDiagnostics: () => invoke('diagnostics:save'),

    // ===== 定时任务 =====
    listSchedules: () => invoke('schedules:list'),
    saveSchedule: (input) => invoke('schedules:save', input),
    deleteSchedule: (id) => invoke('schedules:delete', id),
    runScheduleNow: (id) => invoke('schedules:runNow', id),

    // ===== AI 命令监视 =====
    listAiCommands: () => invoke('commands:list'),
    aiCommandOutput: (commandId, offset) => invoke('commands:output', commandId, offset ?? 0),
    cancelAiCommand: (commandId) => invoke('commands:cancel', commandId),

    // ===== 审计日志 =====
    queryAudit: (q) => invoke('audit:query', q ?? {}),
    auditStats: (q) => invoke('audit:stats', q ?? {}),
    exportAudit: (q) => invoke('audit:export', q ?? {}),

    // ===== 概览（overview） =====
    getOverview: (force) => invoke('overview:get', force === true),
    onNavigateRequest: (cb) => subscribe('app:navigate', cb),

    // ===== 远端查看 =====
    isRemote: remote,
    remoteViewStatus: () => invoke('remote:status'),
    remoteViewStart: (opts) => invoke('remote:start', opts ?? {}),
    remoteViewSetOptions: (opts) => invoke('remote:options', opts ?? {}),
    remoteViewStop: () => invoke('remote:stop'),
    onRemoteView: (cb) => subscribe('remote:changed', cb),
    onBrowserOpen: (cb) => subscribe('browser:open', cb),
    onBrowserKey: (cb) => subscribe('browser:key', cb),
    onBrowserClose: (cb) => subscribe('browser:close', cb),
    browserStatus: () => invoke('browser:status'),
    setBrowserPrefs: (patch) => invoke('browser:setPrefs', patch ?? {}),
    prepareBrowserTab: (wcId, tabId) => invoke('browser:prepare', wcId, tabId),
    clearBrowserData: () => invoke('browser:clearData'),
    stopAll: () => invoke('bridge:stopAll')
  }
}
