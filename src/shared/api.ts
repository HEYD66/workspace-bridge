// 预加载脚本暴露给界面的接口（window.bridge）。只放类型，不能引入 Node 模块
import type {
  ActivityEvent,
  Agent,
  AuthMode,
  BridgeState,
  MemoryItem,
  Role,
  TaskItem,
  TaskStatus,
  OAuthGrantInfo,
  PendingAuthorization,
  SkillDetail,
  SkillInfo,
  SkillInput,
  TrashEntry,
  TunnelConfig,
  TunnelState,
  // ===== 多工作区（ws-core） =====
  FileContent,
  WorkspaceInfo,
  WorkspaceView,
  // ===== 内置 AI（mcp-layer） =====
  AgentModel,
  ChatMessage,
  ChatSession,
  ChatToolCall,
  ModelProviderView,
  ProviderInput,
  ProviderKind,
  // ===== 搜索（ui-skills） =====
  FileListEntry,
  SearchFileResult,
  SearchMatch,
  SearchOptions,
  SearchResult,
  // ===== 终端（skills-core） =====
  TerminalInfo,
  // ===== 群聊 =====
  GroupChannelInfo,
  GroupChatState,
  GroupMessage,
  // ===== 改动与检查点 =====
  CheckpointConflictView,
  CheckpointFileView,
  CheckpointListResult,
  CheckpointRollbackResult,
  CheckpointSessionView,
  CheckpointStepView,
  CheckpointSummaryFile,
  CheckpointSummaryResult
} from '../core/types'
import type { Overview } from '../core/overview'
import type { AuditPage, AuditQuery, AuditStats } from '../core/auditReader'
import type { ChatAttachment } from '../core/chatAttachments'
import type { UserCommandItem, UserCommandOutput } from '../core/commandRunner'
import type { ConnectTestResult } from '../core/connectTest'
import type { ImportPreview } from '../core/backup'
import type { SkillImportItem, SkillImportOptions, SkillImportPreview, SkillImportResult } from '../core/skillImport'
import type { ScheduleAction, ScheduleInput, ScheduleItem, ScheduleResult, ScheduleSpec } from '../core/scheduler'

export type { ScheduleAction, ScheduleInput, ScheduleItem, ScheduleResult, ScheduleSpec }

/** 导入完成：backupFile 是导入前自动备份的 config.json；regenerated 是重新生成了 token 的 AI（要重新配置连接） */
export interface ImportResult {
  backupFile: string | null
  regenerated: { id: string; name: string }[]
  llm: { added: string[]; updated: string[]; needKey: string[]; bindings: number; dropped: number } | null
}

export type { ImportPreview }
export type { TrashEntry }
export type { SkillImportItem, SkillImportOptions, SkillImportPreview, SkillImportResult }
import type { PlaygroundCallResult, PlaygroundTool } from '../core/playground'
import type { ConnectWhich } from './connectGuide'
import type { CanvasDoc, CanvasOp } from './canvasDoc'
import type { CanvasUndoResult, CanvasUndoState } from './canvasUndo'

export type { PlaygroundCallResult, PlaygroundTool }

export type { ConnectTestResult, ConnectWhich }

/** 工作台「AI 命令」页的一条：带上 AI 名字和颜色 */
export type AiCommandItem = UserCommandItem & { owner_name: string; owner_color?: string }
export type AiCommandOutput = UserCommandOutput & { owner_name: string }

export interface ConnectionInfo {
  /** 本机地址 */
  url: string
  urlWithToken: string
  token: string
  /** 局域网开着时的地址（带 /mcp） */
  lanUrls: string[]
  /** 隧道运行中时的公网地址（带 /mcp），网页 AI 走 OAuth 时只填这个地址 */
  publicUrl?: string
  /** 隧道运行中时带 token 的公网链接（/mcp/<token>）：链接直连模式下网页 AI 填这个，有链接就能连 */
  publicUrlWithToken?: string
  /** 当前网页 AI 认证方式 */
  authMode: AuthMode
  /** 工作台自带的 stdio 桥的绝对路径（只会 stdio 的客户端用 node 跑它）；没写出来时没有 */
  stdioBridge?: string
  prompt: string
}

/** 隧道设置的修改；token 传空字符串表示清除，不传表示不改 */
export interface TunnelSettingsPatch {
  mode?: TunnelConfig['mode']
  hostname?: string
  token?: string
  autoStart?: boolean
  keepOnExit?: boolean
}

export interface DirEntry {
  name: string
  type: 'dir' | 'file' | 'link'
  size?: number
  mtime?: number
}

export interface MemoryInput {
  id?: string
  title: string
  content: string
  tags?: string[]
  pinned?: boolean
  /** 新建时：放进全局记忆库（所有项目的 AI 都能看，会进每个 AI 的开场说明）。更新时不用传，看 id */
  global?: boolean
}

/** 全局记忆库里的记忆 id 以它开头（和 src/core/mcpServer.ts 的 GLOBAL_MEMORY_PREFIX 是同一个值） */
export const GLOBAL_MEMORY_PREFIX = 'mg_'

export interface TaskInput {
  title: string
  description?: string
  priority?: TaskItem['priority']
  assigneeId?: string
}

// 'providers'：模型提供方或 AI 的模型绑定变了（内置 AI，mcp-layer）
// 'chat'：群聊新消息，onChanged 的第二个参数是那条 GroupMessage
// 'commands'：AI 的命令有新建、新输出或结束（最多每 500ms 一次），界面重新拉 listAiCommands
// 'checkpoints'：有新检查点或回滚（同一工作区最多每 300ms 一次），改动页重新拉 listCheckpoints
// 'schedules'：定时任务保存、删除、运行过（下次时间、上次结果变了），定时任务页重新拉 listSchedules
// 'trash'：从回收站恢复或彻底删除过东西，设置页的回收站重新拉 listTrash（新删进去的不发，打开或点刷新时拉）
// 'canvas'：画布上存的东西变了（位置、便签、收纳、接力线……，用户或 AI 改的都算），画布页重新拉 canvasAll
export type ChangeKind = 'memory' | 'tasks' | 'skills' | 'providers' | 'chat' | 'commands' | 'checkpoints' | 'schedules' | 'trash' | 'canvas'

/** 群聊列表的查询条件：按 seq 升序返回；只给 before 或都不给时取最新的 limit 条（默认 50，最多 500） */
export interface GroupChatListOptions {
  /** 'general'（默认，大厅）或 'ws:<工作区 id>' */
  channel?: string
  after?: number
  before?: number
  limit?: number
  query?: string
}

export interface GroupChatSendInput {
  /** 'general'（默认，大厅）或 'ws:<工作区 id>'；带 to 的私聊只能在大厅 */
  channel?: string
  text: string
  /** 私聊对象：AI 的 id 或名字 */
  to?: string
  /** 引用的消息 id */
  replyTo?: string
  attachments?: ChatAttachment[]
}

/** 远端查看（用手机 / 平板的浏览器打开工作台）的状态 */
export interface RemoteViewStatus {
  /** connecting：本机入口已经开了，公网地址还在申请；error：公网地址没申请下来（本机入口还开着） */
  state: 'off' | 'connecting' | 'on' | 'error'
  /** 本机地址上的入口链接（带口令），只有这台电脑自己能打开 */
  localUrl?: string
  /** 公网入口链接（带口令），隧道连上以后才有 */
  link?: string
  /** 要不要公网链接。关着的时候是下次开启的设置，开着的时候是这一次的 */
  tunnel?: boolean
  /** 局域网里的设备能不能直接进。关着的时候是下次开启的设置，开着的时候是这一次的 */
  lan?: boolean
  /** 局域网入口链接（带口令，http），每个网卡地址一条；开着而且 lan 为真时才有，可能是空的（没连网） */
  lanUrls?: string[]
  /** 「重启后保留」开没开：工作台重启后自己接着开，链接和已经打开的页面照旧能用 */
  keep?: boolean
  /** 这一次是工作台重启后接着上次开的 */
  resumed?: boolean
  /** state=error 时的原因 */
  error?: string
  startedAt?: number
  /** 这次开启以来用链接进来过几次 */
  visits: number
  lastVisitAt?: number
}

export interface BridgeApi {
  getState(): Promise<BridgeState>
  getEvents(): Promise<ActivityEvent[]>
  setPaused(paused: boolean): Promise<void>
  // ===== 多工作区（ws-core） =====
  /** 弹目录选择框，加入并设为当前；取消返回 null。同一路径已在列表里时只设为当前 */
  addWorkspace(): Promise<BridgeState | null>
  /** 旧名字，等同 addWorkspace */
  chooseWorkspace(): Promise<BridgeState | null>
  /** 只弹目录选择框，不加入；取消返回 null。选完再用 addWorkspaceAt 带上成员名单加入 */
  pickWorkspaceFolder(): Promise<string | null>
  /** 加入这个目录并设为当前。members：只有这些 AI 能用；null = 所有 AI 都能用（包括以后新加的） */
  addWorkspaceAt(root: string, members: string[] | null): Promise<BridgeState>
  /** 改工作区能用的 AI：null = 所有 AI 都能用（包括以后新加的）。能不能用变了的 AI 会重新握手 */
  setWorkspaceMembers(id: string, members: string[] | null): Promise<BridgeState>
  /** 只移出列表，不删文件（数据目录保留，再加回同一路径数据还在） */
  removeWorkspace(id: string): Promise<BridgeState>
  renameWorkspace(id: string, name: string): Promise<BridgeState>
  setActiveWorkspace(id: string): Promise<BridgeState>
  /** 资源管理器打开，不传用当前工作区 */
  openWorkspace(id?: string): Promise<void>
  setPort(port: number): Promise<BridgeState>
  /** 开关局域网（会重启 MCP 服务，所有 AI 重连） */
  setLanEnabled(enabled: boolean): Promise<BridgeState>
  /** 网页 AI 认证方式：link = 带 token 的链接直连，oauth = OAuth + 桌面批准（不用重启服务） */
  setAuthMode(mode: AuthMode): Promise<BridgeState>
  /** 有事等用户时弹不弹系统通知 */
  setNotifyAttention(on: boolean): Promise<BridgeState>

  setTunnelSettings(patch: TunnelSettingsPatch): Promise<BridgeState>
  startTunnel(): Promise<BridgeState>
  stopTunnel(): Promise<BridgeState>

  /** 把待批准的 OAuth 请求绑定到某个 AI 身份 */
  approveOAuth(pendingId: string, agentId: string): Promise<void>
  denyOAuth(pendingId: string): Promise<void>
  listOAuthGrants(): Promise<OAuthGrantInfo[]>
  revokeOAuthGrant(grantId: string): Promise<void>

  // ===== 工作台文件读写（ws-core） =====
  // 路径都是工作区相对路径（/ 分隔）。用户能看能改 .env 这类文件，.git 内部和应用数据目录照样隐藏、拒绝。
  // 每次操作以「你」记进活动流（agentId 'user'）。
  listDir(workspaceId: string, path: string): Promise<DirEntry[]>
  /** 最多 5 MB 全文；二进制、太大的只给 size 和标记 */
  readFile(workspaceId: string, path: string): Promise<FileContent>
  /** 版本不符时抛错，message 以 'CONFLICT' 开头；新文件不传 expectedVersion */
  saveFile(workspaceId: string, path: string, content: string, expectedVersion?: string): Promise<{ version: string }>
  /** 已存在时报错 */
  createFile(workspaceId: string, path: string): Promise<void>
  createDir(workspaceId: string, path: string): Promise<void>
  /** 同一工作区内改名 / 移动；目标已存在时报错 */
  renamePath(workspaceId: string, from: string, to: string): Promise<void>
  /** 进回收站 */
  deletePath(workspaceId: string, path: string): Promise<void>
  /** 资源管理器里选中 */
  revealPath(workspaceId: string, path: string): Promise<void>

  /** 新接入的 AI 是完全权限，能用你添加的全部工作区；machineAccess=true 才能用「整台电脑」（默认不能） */
  createAgent(name: string, roleId?: string, machineAccess?: boolean): Promise<Agent>
  /** 开关 machineAccess（整台电脑）会断开这个 AI 的会话让它重连；换职位不断开 */
  updateAgent(id: string, patch: Partial<Pick<Agent, 'name' | 'color' | 'roleId' | 'machineAccess'>>): Promise<Agent>
  rotateToken(id: string): Promise<Agent>
  /** 这个 AI 当前的连接（每个客户端会话一条），新的在前 */
  listAgentSessions(id: string): Promise<{ id: string; clientName?: string; createdAt: number; lastSeen: number }[]>
  /** 断开连接（不传 sessionId 断开全部）；token 不变，客户端可以重连。返回断开了几条 */
  disconnectAgent(id: string, sessionId?: string): Promise<number>
  removeAgent(id: string): Promise<void>
  connectionInfo(id: string): Promise<ConnectionInfo>
  /** 把「命令（stdio 桥）」接入写成配置文件（mcpServers 格式，本机地址），返回文件路径；给按路径导入的客户端用 */
  exportClientConfig(id: string): Promise<{ path: string }>
  /** 接入向导「测试连接」：用这个 AI 的 token 对选中的地址发 initialize，再关掉会话；不抛错，失败看 ok 和 error */
  testConnection(agentId: string, which: ConnectWhich): Promise<ConnectTestResult>
  /** 工具试用台：工具列表（真连一次本机 MCP 地址拿 tools/list） */
  playgroundTools(agentId: string): Promise<PlaygroundTool[]>
  /** 工具试用台：以这个 AI 的身份调一个工具，content 原样返回；不抛错，协议错误放在 protocolError */
  playgroundCall(agentId: string, name: string, args: Record<string, unknown>): Promise<PlaygroundCallResult>

  saveRole(input: Partial<Role> & { name: string }): Promise<Role>
  removeRole(id: string): Promise<void>

  /**
   * 技能库：项目级 + 用户级，项目级同名优先。
   * 下面每个方法最后的 workspaceId：不给是当前工作区；给了是那个工作区的技能库（技能页看别的工作区、整台电脑的技能时用）。
   * 项目级技能的 id 只在一个工作区里唯一，所以看别的工作区时每个操作都要带上它
   */
  listSkills(workspaceId?: string): Promise<SkillInfo[]>
  getSkill(id: string, workspaceId?: string): Promise<SkillDetail>
  /** 手动停用 / 重新启用；停用不删文件。技能默认就是启用的（AI 提交的也是） */
  setSkillEnabled(id: string, enabled: boolean, workspaceId?: string): Promise<SkillInfo>
  /** 新建或修改 SKILL.md：新建直接启用；改已有的不改变启用 / 停用状态 */
  saveSkill(input: SkillInput, workspaceId?: string): Promise<SkillInfo>
  /** 删除技能目录（进回收站） */
  /**
   * 把技能挪个地方（整个目录移过去，状态跟着走）：改成用户级，或挪进某个工作区的项目级。
   * workspaceId 是技能现在所在的工作区；targetWorkspaceId 是 scope 为 project 时要挪进的工作区（不给就是 workspaceId 那个）。
   * 目标位置有同名的会报错。返回挪过去之后的技能（id 可能变了；挪到别的工作区后要带那个工作区的 id 才读得到）
   */
  setSkillScope(id: string, scope: 'project' | 'user', workspaceId?: string, targetWorkspaceId?: string): Promise<SkillInfo>
  deleteSkill(id: string, workspaceId?: string): Promise<void>
  /** 在系统文件管理器里打开技能目录 */
  openSkillDir(id: string, workspaceId?: string): Promise<void>
  /**
   * 导入现成的技能包，第一步：弹系统对话框选一个文件夹（folder）或一个 .zip / .skill 文件（zip），返回里面找到的技能。
   * 文件夹本身有 SKILL.md 就是一个技能；没有就往下找，可以一次选中装着多个技能的文件夹。取消返回 null，不写任何东西
   */
  pickSkillImport(kind: 'folder' | 'zip'): Promise<SkillImportPreview | null>
  /** 第二步：确认导入。项目级导入到 workspaceId 那个工作区（不给是当前工作区）；同名已存在又没选覆盖的，结果里是 exists */
  applySkillImport(importId: string, opts: SkillImportOptions, workspaceId?: string): Promise<SkillImportResult>

  listMemories(): Promise<MemoryItem[]>
  saveMemory(input: MemoryInput): Promise<MemoryItem>
  deleteMemory(id: string): Promise<void>
  /** 恢复到以前的某一版 */
  restoreMemory(id: string, version: number): Promise<MemoryItem>
  /** 归档 / 取消归档 */
  archiveMemory(id: string, archived: boolean): Promise<MemoryItem>

  // 任务：最后的 workspaceId 不给是当前工作区；任务页看「整台电脑」的任务板时给它的 id（工作台切不到整台电脑）
  listTasks(workspaceId?: string): Promise<TaskItem[]>
  createTask(input: TaskInput, workspaceId?: string): Promise<TaskItem>
  editTask(id: string, input: Partial<Omit<TaskInput, 'assigneeId'>>, workspaceId?: string): Promise<TaskItem>
  setTaskStatus(id: string, status: TaskStatus, note?: string, workspaceId?: string): Promise<TaskItem>
  assignTask(id: string, assigneeId: string | null, workspaceId?: string): Promise<TaskItem>
  reviewTask(id: string, decision: 'accept' | 'reject', note?: string, workspaceId?: string): Promise<TaskItem>
  deleteTask(id: string, workspaceId?: string): Promise<void>
  /**
   * 任务的线（IPC task:thread）：这条任务自己的会话，派活、交付、审查自动记在里面。
   * 老任务第一次要时现开。返回它的频道信息，之后照普通频道读写（sendGroupChat / 读消息都用它的 id）
   */
  taskThread(id: string, workspaceId?: string): Promise<GroupChannelInfo>
  /** 第 12 条：用户回答 / 关闭任务里的待决定问题 */
  answerTaskQuestion(id: string, questionId: string, answer: string, workspaceId?: string): Promise<TaskItem>
  closeTaskQuestion(id: string, questionId: string, note?: string, workspaceId?: string): Promise<TaskItem>

  // ===== 回收站：所有工作区共用一个（AI 和你删除、覆盖的文件，回滚时移走的新建文件，删掉的技能） =====
  listTrash(): Promise<TrashEntry[]>
  /** 放回原位置，那里已经有东西时报错不覆盖。老版本删的没记原位置，放进 workspaceId（不给 = 当前工作区）里原来的相对路径 */
  restoreTrash(id: string, workspaceId?: string): Promise<{ path: string; workspaceId?: string }>
  /** 彻底删除，恢复不了。ids 不给 = 清空 */
  purgeTrash(ids?: string[]): Promise<{ removed: number; bytes: number; failed: string[] }>

  // ===== 内置 AI（mcp-layer） =====
  /** 模型提供方（API Key 不回传，只给 hasKey） */
  listProviders(): Promise<ModelProviderView[]>
  saveProvider(input: ProviderInput): Promise<ModelProviderView>
  /** 用到它的 AI 解除模型绑定 */
  removeProvider(id: string): Promise<void>
  /** 调提供方的 /models；失败抛错（message 是提供方的原话） */
  fetchProviderModels(id: string): Promise<string[]>
  /** 发一条很短的消息试连，不抛错 */
  testProvider(id: string, model: string): Promise<{ ok: boolean; message: string; latencyMs: number }>
  /** agentId → 模型；已吊销的 AI 不在里面 */
  listAgentModels(): Promise<Record<string, AgentModel>>
  getAgentModel(agentId: string): Promise<AgentModel | null>
  /** 传 null 解除绑定（正在跑的对话会被停下） */
  setAgentModel(agentId: string, model: AgentModel | null): Promise<void>
  getChat(agentId: string): Promise<ChatSession>
  /** 立刻返回，后台执行；进度走 onChat。这个 AI 正在跑时抛错 */
  sendChat(agentId: string, text: string): Promise<void>
  stopChat(agentId: string): Promise<void>
  /** 正在跑时先停下再清空 */
  clearChat(agentId: string): Promise<void>
  onChat(cb: (s: ChatSession) => void): () => void

  // ===== 搜索（ui-skills） =====
  /** 全文搜索：不传 workspaceId 搜全部工作区；超时或到上限时返回已有结果并标 truncated。正则无效时抛错 */
  searchFiles(opts: SearchOptions): Promise<SearchResult>
  /** 快速打开用的文件清单（最多 50000 个），不传 workspaceId 列全部工作区 */
  listAllFiles(workspaceId?: string): Promise<FileListEntry[]>

  // ===== 终端（skills-core） =====
  /** cwd：传了 workspaceId 用它的根目录（cwd 可以是相对它的路径），否则当前工作区，再否则用户主目录 */
  terminalCreate(opts?: { workspaceId?: string; cwd?: string; shell?: string; cols?: number; rows?: number }): Promise<TerminalInfo>
  terminalList(): Promise<TerminalInfo[]>
  /** 不等回复 */
  terminalWrite(id: string, data: string): void
  /** 不等回复 */
  terminalResize(id: string, cols: number, rows: number): void
  /** 结束进程并移除这个终端 */
  terminalKill(id: string): Promise<void>
  /** 最近 200 KB 输出，界面刷新后恢复屏幕 */
  terminalBuffer(id: string): Promise<string>
  onTerminalData(cb: (id: string, data: string) => void): () => void
  onTerminalExit(cb: (id: string, exitCode: number) => void): () => void

  copy(text: string): Promise<void>
  /** 告诉主进程现在哪些文件有没保存的改动（关窗口时它据此先问一句）。只有电脑上的窗口能调 */
  setUnsaved(paths: string[]): Promise<void>
  onState(cb: (s: BridgeState) => void): () => void
  onEvent(cb: (e: ActivityEvent) => void): () => void
  /** kind 为 'chat' 时 payload 是新到的 GroupMessage，其他 kind 没有 payload */
  onChanged(cb: (kind: ChangeKind, payload?: GroupMessage) => void): () => void

  // ===== 群聊（IPC chat:list / chat:send / chat:markRead / chat:channels） =====
  /** 以用户身份看一个频道（不传 channel 是大厅）：包括 AI 之间的私聊。频道不存在时抛错 */
  listGroupChat(opts?: GroupChatListOptions): Promise<GroupMessage[]>
  /** 以用户身份发（from.id='user'，名字「你」）；文本为空、超过 8000 字、私聊对象不存在、私聊不在大厅、频道不存在时抛错 */
  sendGroupChat(input: GroupChatSendInput): Promise<GroupMessage>
  uploadChatImage(dataUrl: string, name: string): Promise<ChatAttachment>
  chatImage(id: string): Promise<string>
  /** 标记用户在这个频道读到 seq（只往前走），BridgeState.chat 随之更新 */
  markGroupChatRead(channel: string, seq: number): Promise<void>
  /** 频道列表（大厅在前，然后按工作区列表顺序），和 state.chat.channels 一样 */
  listGroupChannels(): Promise<GroupChannelInfo[]>
  /**
   * 设频道的干活方式（IPC chat:setLead）：leadId 给 AI 的 id 是「分工明确」（它当主脑，再调一次可以换人），给 null 是「灵感激荡」。
   * 结果从 BridgeState.chat.channels[].leadId 看。频道或 AI 不存在、那个 AI 进不了这个频道时抛错。
   * subIds（给了 leadId 才有用）顺便定下子代理：数组是选中的 AI，null 是「不挑，主脑以外都算」，不传是不动
   */
  setGroupChatLead(channel: string, leadId: string | null, subIds?: string[] | null): Promise<void>
  /**
   * 「分工明确」的频道选子代理（IPC chat:setSubs）：数组是选中的 AI（空数组：主脑一个人干），null 是「不挑，主脑以外都算」。
   * 结果从 BridgeState.chat.channels[].subIds 看。频道还是「灵感激荡」、名单里有不存在或进不了这个频道的 AI 时抛错
   */
  setGroupChatSubs(channel: string, subIds: string[] | null): Promise<void>
  /**
   * 「灵感激荡」的频道挑参与讨论的 AI（IPC chat:setParticipants）：数组是选中的 AI（至少一个），null 是「不挑，都参与」。
   * 结果从 BridgeState.chat.channels[].partIds 看。频道是「分工明确」、名单是空的、里面有不存在或进不了这个频道的 AI 时抛错
   */
  setGroupChatParticipants(channel: string, ids: string[] | null): Promise<void>
  /**
   * 在一个工作区里新开会话（IPC chat:newThread）：title 不给时用「新会话 月-日 时:分」。
   * 返回新频道（id 'ws:<工作区 id>.c_<会话 id>'），也会出现在 BridgeState.chat.channels 里（带 thread）
   */
  newGroupChatThread(workspaceId: string, title?: string): Promise<GroupChannelInfo>
  /**
   * 改会话的标题（IPC chat:renameThread）。项目的主群聊也能起名字（GroupChannelInfo.title，只在界面上用，
   * AI 看到的名字不变；title 给空的恢复叫「群聊」）。大厅、任务的线不能改
   */
  renameGroupChatThread(channel: string, title: string): Promise<void>
  /** 归档 / 恢复会话（IPC chat:archiveThread）：归档后 AI 看不到它、不能发言，消息都留着，用户还能看 */
  archiveGroupChatThread(channel: string, archived: boolean): Promise<void>
  /**
   * 删除会话，或清空主群聊 / 大厅的消息（IPC chat:deleteChannel）。消息文件挪进数据目录的 chat/deleted/，不直接删。
   * 返回清掉了几条
   */
  deleteGroupChannel(channel: string): Promise<number>

  // ===== 改动与检查点（IPC checkpoints:list / checkpoints:summary / checkpoints:rollback） =====
  /** workspaceId 不传用当前工作区；检查点按会话分组，新的在前（含回滚检查点）；limit 默认 200 */
  listCheckpoints(opts?: { workspaceId?: string; agentId?: string; session?: string; limit?: number; elsewhere?: boolean }): Promise<CheckpointListResult>
  /** 净改动：stepIds 优先，其次 session / task / agentId；每个文件带自己的 unified diff */
  checkpointSummary(opts: { workspaceId?: string; stepIds?: string[]; agentId?: string; session?: string; task?: string }): Promise<CheckpointSummaryResult>
  /**
   * 以用户身份回滚：stepIds 或 session 二选一，paths 只退其中几个（必须是检查点里记录的相对路径）。
   * 先用 dryRun=true 看计划；冲突不抛错，返回 status='conflict' 和冲突详情
   */
  rollbackCheckpoints(opts: { workspaceId?: string; stepIds?: string[]; session?: string; paths?: string[]; dryRun?: boolean }): Promise<CheckpointRollbackResult>

  // ===== 画布（IPC canvas:all / canvas:update / canvas:undoState / canvas:undo） =====
  /** 画布上存的东西：每个工作区一份，加上总画布那一份（键是 canvasDoc.ts 的 CANVAS_ALL）；没动过的是空的 */
  canvasAll(): Promise<Record<string, CanvasDoc>>
  /** 以用户身份改：id 是工作区 id 或 CANVAS_ALL；一串改动要么全做要么全不做，不合规时抛错。返回改完的那一份 */
  canvasUpdate(id: string, ops: CanvasOp[]): Promise<CanvasDoc>
  /** 「撤销上一步」现在能不能撤、撤的是什么。只记用户自己的改动（AI 的、视角、「看过了」不记），1 秒内连着的改动算一步，最多 30 步，重启清空 */
  canvasUndoState(): Promise<CanvasUndoState>
  /** 撤销用户最近的一步；之后被 AI 改过的东西不硬撤（status 'partial' / 'conflict'，skipped 列出来）。message 可以直接给用户看 */
  canvasUndo(): Promise<CanvasUndoResult>

  // ===== 设置备份与恢复、诊断报告（IPC backup:* / diagnostics:*） =====
  /** 弹保存对话框导出；includeTokens=false 时 token 换成占位符。API Key 永远不导出 */
  exportBackup(opts: { includeTokens: boolean }): Promise<{ saved: boolean; path?: string }>
  /** 弹打开对话框选备份文件，返回预览（取消返回 null）；文件内容留在主进程 */
  pickImportBackup(): Promise<(ImportPreview & { importId: string; file: string }) | null>
  /** 确认导入：先把当前 config.json 备份到数据目录/backups，导入后重启 MCP 服务，所有 AI 要重连 */
  applyImportBackup(importId: string): Promise<ImportResult>
  /** markdown 诊断报告（不含 token 和 API Key） */
  diagnosticsReport(): Promise<string>
  /** 弹保存对话框保存诊断报告（主进程重新生成） */
  saveDiagnostics(): Promise<{ saved: boolean; path?: string }>

  // ===== 定时任务（IPC schedules:list / save / delete / runNow） =====
  listSchedules(): Promise<ScheduleItem[]>
  /** 新建（不带 id）或修改；改了频率或从停用改成启用时下次时间从现在重新算。频率、动作不合法时抛错 */
  saveSchedule(input: ScheduleInput): Promise<ScheduleItem>
  deleteSchedule(id: string): Promise<void>
  /** 立即运行一次（不影响下次计划时间）；「全部停下」时抛错。结果在返回的 lastResult 里 */
  runScheduleNow(id: string): Promise<ScheduleItem>

  // ===== AI 命令监视（IPC commands:list / commands:output / commands:cancel） =====
  /** 所有 AI 的命令：运行中的在前，再按开始时间倒排（已结束的最多 200 条）；owner_name 是 AI 名字 */
  listAiCommands(): Promise<{ commands: AiCommandItem[]; running: number; total: number }>
  /** 读某条命令的输出（从绝对字节 offset 开始，默认最多 256 KB） */
  aiCommandOutput(commandId: string, offset?: number): Promise<AiCommandOutput>
  /** 用户停止 AI 的命令（Ctrl-C，1.5 秒后强制结束），记一条活动 */
  cancelAiCommand(commandId: string): Promise<void>

  // ===== 审计日志（IPC audit:query / audit:stats / audit:export） =====
  /** 新的在前；带上一页的 nextCursor 翻下一页 */
  queryAudit(q: AuditQuery): Promise<AuditPage>
  auditStats(q: Pick<AuditQuery, 'from' | 'to' | 'agentId' | 'workspaceId'>): Promise<AuditStats>
  /** 弹保存对话框导出 CSV；用户取消时 saved=false */
  exportAudit(q: AuditQuery): Promise<{ saved: boolean; path?: string; rows: number; truncated: boolean }>

  // ===== 概览（overview） =====
  /** 概览仪表盘数据（主进程缓存 5 秒；force=true 跳过缓存） */
  getOverview(force?: boolean): Promise<Overview>
  /** 主进程要求界面跳转（点了群聊的桌面通知等）：section 是 nav 的分区名，id 是分区里的条目 */
  onNavigateRequest(cb: (target: { section: string; id?: string }) => void): () => void

  // ===== 远端查看 =====
  /** 这个页面是不是用浏览器从远端链接打开的（电脑上的窗口是 false） */
  readonly isRemote: boolean
  remoteViewStatus(): Promise<RemoteViewStatus>
  /**
   * 打开远端查看，每次打开都是新口令。马上返回，公网地址申请下来（或失败）时经 onRemoteView 通知。
   * renew=true：先关再开，旧链接立刻失效；tunnel=false：不申请公网地址，只开本机入口
   */
  remoteViewStart(opts?: { renew?: boolean; tunnel?: boolean; lan?: boolean }): Promise<RemoteViewStatus>
  /**
   * 改访问方式（公网链接 / 局域网）并记住。两个至少留一个。正开着的话马上按新的重开：口令和地址都换，旧链接失效。
   * keep = 「重启后保留」：只改它不会重开；正开着时打开它，公网地址会马上换一次（换成退出时留得住的），口令不变。
   * 只能在电脑上的窗口里改
   */
  remoteViewSetOptions(opts: { tunnel?: boolean; lan?: boolean; keep?: boolean }): Promise<RemoteViewStatus>
  /** 关掉：链接和已经打开的页面立刻失效 */
  remoteViewStop(): Promise<RemoteViewStatus>
  onRemoteView(cb: (s: RemoteViewStatus) => void): () => void

  // ===== 右栏的网页标签（只在电脑上的窗口里有；远端页面里这几个不会收到事件） =====
  /**
   * 另开一个网页标签。两种来历：网页要开新窗口（window.open、target=_blank），wcId 是发起的那个网页，新标签排在它后面；
   * AI 调了 browser_open，tabId 是主进程定好的标签 id，focus 是翻不翻过去，reveal 是右栏收着要不要展开
   */
  onBrowserOpen(cb: (v: { url: string; wcId?: number; tabId?: string; focus?: boolean; reveal?: boolean }) => void): () => void
  /** AI 调了 browser_close：关掉这个标签 */
  onBrowserClose(cb: (v: { tabId: string }) => void): () => void
  /** 指纹和 CDP 的现状（IPC browser:status） */
  browserStatus(): Promise<BrowserStatus>
  /** 改设置：cdp 开关（重启后生效）、fingerprint 开关、regenerate 换一套指纹。指纹的改动只对之后打开的标签有效。只能在电脑上的窗口里改 */
  setBrowserPrefs(patch: { cdp?: boolean; fingerprint?: boolean; regenerate?: boolean; region?: boolean; refreshRegion?: boolean; proxy?: string }): Promise<BrowserStatus>
  /** 网页标签开始加载前调：等主进程把环境（WebRTC 策略、时区语言、指纹）装到这个网页上。error 是没装上的原因（网页先不打开）；note 是不碍事但要说一声的 */
  prepareBrowserTab(wcId: number, tabId: string): Promise<{ fingerprint: boolean; region?: { country: string; timezone: string; language: string }; note?: string; error?: string }>
  /** 网页有焦点时按了 Ctrl+L（address）/ Ctrl+T（new）/ Ctrl+W（close）：wcId 是哪个网页 */
  onBrowserKey(cb: (v: { wcId: number; key: 'address' | 'new' | 'close' }) => void): () => void
  /** 清掉网页标签的登录状态和缓存（IPC browser:clearData）；工作台自己的数据不受影响 */
  clearBrowserData(): Promise<void>
  /** 「全部停下」：暂停所有 AI、取消正在跑的命令；返回取消了几条命令 */
  stopAll(): Promise<number>
}

export type {
  ActivityEvent,
  Agent,
  AuthMode,
  BridgeState,
  MemoryItem,
  OAuthGrantInfo,
  PendingAuthorization,
  Role,
  SkillDetail,
  SkillInfo,
  SkillInput,
  TaskItem,
  TaskStatus,
  TunnelState,
  // ===== 多工作区（ws-core） =====
  FileContent,
  WorkspaceInfo,
  WorkspaceView,
  // ===== 内置 AI（mcp-layer） =====
  AgentModel,
  ChatMessage,
  ChatSession,
  ChatToolCall,
  ModelProviderView,
  ProviderInput,
  ProviderKind,
  // ===== 搜索（ui-skills） =====
  FileListEntry,
  SearchFileResult,
  SearchMatch,
  SearchOptions,
  SearchResult,
  // ===== 终端（skills-core） =====
  TerminalInfo,
  // ===== 群聊 =====
  GroupChannelInfo,
  GroupChatState,
  GroupMessage,
  // ===== 改动与检查点 =====
  CheckpointConflictView,
  CheckpointFileView,
  CheckpointListResult,
  CheckpointRollbackResult,
  CheckpointSessionView,
  CheckpointStepView,
  CheckpointSummaryFile,
  CheckpointSummaryResult
}

/** 内置浏览器（右栏的网页标签）的指纹和 CDP 现状 */
export interface BrowserStatus {
  cdp: {
    /** 设置里开没开（改了要重启才生效） */
    enabled: boolean
    /** 设置里的端口 */
    port: number
    /** 这次启动实际开在哪个端口；没开就没有 */
    activePort?: number
    /** http://127.0.0.1:端口 */
    url?: string
    /** 那个端口上现在是不是真有应答 */
    ok: boolean
    /** 这次的端口怎么定的：命令行、环境变量 WB_CDP_PORT、设置，或者没开 */
    source: 'cmdline' | 'env' | 'prefs' | 'off'
    note?: string
  }
  fingerprint: {
    enabled: boolean
    /** 一行：显卡 · 屏幕 · CPU · 内存 */
    summary: string
    details: { label: string; value: string }[]
    /** 网页看到的 UA */
    userAgent: string
  }
  /** 时区和语言跟出口 IP 走 */
  region: {
    enabled: boolean
    /** 上次查到的出口：IP、国家、网页会看到的时区和语言；没查到就都没有 */
    ip?: string
    country?: string
    countryCode?: string
    timezone?: string
    language?: string
    at?: number
    /** 最近一次没查到的原因 */
    error?: string
  }
  network: {
    /** 设置里的代理：'' 跟系统、'direct' 直连、或代理地址 */
    proxy: string
    /** 现在实际怎么走：'DIRECT' 或 'PROXY 主机:端口' */
    route: string
    /** WebRTC 的策略（固定是不走代理的 UDP 不发） */
    webrtc: string
  }
}
