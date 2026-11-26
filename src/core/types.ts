// 核心类型定义（主进程、渲染层共用，不能引入 Node 模块；import type 编译后会被擦除，可以用）
import type { OAuthGrantInfo, PendingAuthorization } from './oauth'
import type { ClaimSummary } from './fileClaims'
import type { TaskQuestion } from './taskScope'
import type { ChatAttachment } from './chatAttachments'

export type { OAuthGrantInfo, PendingAuthorization }
export type { TaskQuestion }

/**
 * 一个接入的 AI 身份，每个身份一个独立 token。
 * 接入的 AI 都有完全权限：全部工具、可读写、可执行命令、不用审批，能用用户添加的全部工作区。
 * 唯一的开关是「整台电脑」（machineAccess）。旧配置里的档位、命令执行开关、调用限额、工作区勾选读入时丢弃
 */
export interface Agent {
  id: string
  name: string
  color: string
  token: string
  createdAt: number
  /** 职位；只是下发给 AI 的职责说明，不限制它能做什么 */
  roleId?: string
  /** 能用「整台电脑」工作区（本机任意盘的绝对路径）；不设 = 不能，只能用用户添加的工作区 */
  machineAccess?: boolean
}

/** 职位：一个名字加一段职责说明，连接时下发给 AI。不带任何权限 */
export interface Role {
  id: string
  name: string
  /** 连接时下发给 AI 的职责说明 */
  description: string
  builtin?: boolean
}

// ===== 多工作区（ws-core） =====
export interface WorkspaceInfo {
  /** w_ + 8 位十六进制 */
  id: string
  /** 默认取目录名，大小写不敏感唯一 */
  name: string
  /** 绝对路径；整台电脑是相对路径的起点（用户主目录） */
  root: string
  /**
   * 不写 = 普通目录工作区。
   * 'machine' = 内置的「整台电脑」（固定 id，不存进配置的工作区列表）：除了 root 下的相对路径，
   * 还能用本机任意盘的绝对路径（D:/xxx），凭据黑名单（.env、.ssh、.git 等）和本应用数据目录仍然碰不到
   */
  kind?: 'machine'
  /**
   * 能用这个工作区的 AI（成员 id）。不写 = 所有 AI 都能用（老工作区、导入的备份）；
   * 写了只有名单里的能看到它、读写它、进它的群聊，开了整台电脑的也不能用绝对路径进来。整台电脑不用这个字段
   */
  members?: string[]
}

export interface WorkspaceView extends WorkspaceInfo {
  /** 目录现在是否存在 */
  exists: boolean
}

/** 工作台打开的文件（readFile 的结果） */
export interface FileContent {
  workspaceId: string
  path: string
  /** 文本内容；二进制或太大时没有 */
  content?: string
  /** 和 MCP read_file 的 version 一致，保存时回传防覆盖 */
  version?: string
  size: number
  encoding?: string
  eol?: 'lf' | 'crlf'
  binary?: boolean
  /** 超过 5 MB */
  tooLarge?: boolean
  error?: string
}

export interface BridgeConfig {
  // ===== 多工作区（ws-core） =====
  workspaces: WorkspaceInfo[]
  /** 界面的当前工作区 */
  activeWorkspaceId?: string
  host: string
  port: number
  agents: Agent[]
  roles: Role[]
  /** 局域网开关，默认关 */
  lanEnabled: boolean
  tunnel: TunnelConfig
  /** 有事等用户时弹系统通知；不写就是开，false 关 */
  notifyAttention?: boolean
  /**
   * 网页 AI 的认证方式：
   * - link（默认）：和 ShunCode 一样，地址里带不可猜的 token（/mcp/<token>）就能连，不走 OAuth，
   *   也不暴露 OAuth 发现端点，Sesame 这类客户端添加后直接可用，不弹登录卡片
   * - oauth：公网走 OAuth + 桌面批准，经隧道不接受路径令牌
   */
  authMode?: AuthMode
}

export type AuthMode = 'link' | 'oauth'

/** 记忆：shared 所有 AI 可见；private 只有 ownerId 那个 AI 可见（用户在工作台都能看） */
export interface MemoryItem {
  id: string
  scope: 'shared' | 'private'
  /** private 时为所属 AI；shared 时为空 */
  ownerId?: string
  title: string
  content: string
  tags: string[]
  /** 置顶的记忆会在 AI 连接时随说明一起下发 */
  pinned: boolean
  createdBy: string
  createdByName: string
  updatedBy: string
  updatedByName: string
  createdAt: number
  updatedAt: number
  /** 挂在哪条任务上（任务编号，如 T-12）；认领这条任务时会自动带回来 */
  taskRef?: string
  /** 这条记忆是从哪来的（哪个会话、哪条任务的交付、是不是私聊），写给人看的一句话 */
  source?: string
  /** 最近一次被用到的时间：AI 读了它、搜到了它、认领任务时自动带上了它。只是列全部、进开场说明不算。老数据没有 */
  lastUsedAt?: number
  /** 一共被用到过几次（同一条 10 分钟内只算一次） */
  useCount?: number
  /** 归档时间：长期没人用也没人改的自动归档。归档的不进开场说明、不自动带给认领任务的人，搜索时排在最后并标出来；自动归档的再被读到或改到就回来（只是搜索时沾了边不算），用户手动归档的见 archivedBy */
  archivedAt?: number
  /** 是用户在工作台手动归档的：这样的不会自己回来（AI 读它、改它、搜到它都不算），只有用户点「取消归档」才回来。自动归档的没有这个字段 */
  archivedBy?: 'user'
  /** 以前的版本（旧的在前，最多留 MEMORY_HISTORY_MAX 版）：标题、正文、标签变了才记一版 */
  history?: MemoryRevision[]
  /** 版本号：新建是 1，每次更新加 1。老数据没有这个字段，按第 1 版算（memoryVersion）。memory_save 带 expected_version 时用它防止后写的覆盖先写的 */
  version?: number
}

/** 记忆以前的一版 */
export interface MemoryRevision {
  version: number
  title: string
  content: string
  tags: string[]
  updatedBy: string
  updatedByName: string
  updatedAt: number
}

export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done' | 'blocked'

export interface TaskHistory {
  ts: number
  actorId: string
  actorName: string
  action: string
  note?: string
  /** edited 时记下改了哪些字段（旧值 → 新值）；老记录没有这个字段 */
  changes?: TaskFieldChange[]
}

/** 任务一次编辑里的一个字段。值太长时截断，truncated=true */
export interface TaskFieldChange {
  field: 'title' | 'description' | 'priority' | 'allowedPaths'
  from: string
  to: string
  truncated?: boolean
}

export interface TaskItem {
  id: string
  /** 短编号，方便 AI 和人引用，如 T-12 */
  ref: string
  title: string
  description: string
  status: TaskStatus
  priority: 'low' | 'normal' | 'high'
  assigneeId?: string
  createdBy: string
  createdByName: string
  /** 派活的经理（或用户 'user'）；设置后完成必须经过审查 */
  managedBy?: string
  parentId?: string
  /** 交付说明 / 审查意见 */
  result?: string
  createdAt: number
  updatedAt: number
  history: TaskHistory[]
  /** 允许改的范围（glob，规则同文件占用登记）；没有就是不限。老数据没有这个字段 */
  allowedPaths?: string[]
  /** 等人决定的问题；老数据没有这个字段 */
  questions?: TaskQuestion[]
}

export type EventStatus = 'running' | 'ok' | 'error'

/** 一次工具调用，工作台活动流的一条 */
export interface ActivityEvent {
  id: string
  ts: number
  agentId: string
  agentName: string
  agentColor: string
  tool: string
  /** 已截断、脱敏的参数 */
  args: Record<string, unknown>
  status: EventStatus
  durationMs?: number
  /** 主要涉及的文件（工作区相对路径） */
  path?: string
  summary?: string
  error?: string
  /** 写入类操作的 unified diff */
  diff?: string
  // ===== 多工作区（ws-core） =====
  /** 操作所在的工作区；和工作区无关的工具（whoami、team_list 等）没有 */
  workspaceId?: string
}

/** 某个 AI 当前的在线情况 */
export interface Presence {
  agentId: string
  sessions: number
  lastSeen: number
  clientName?: string
  currentTool?: string
  /** 细分状态（和 BridgeState.memberStatus 里同一份） */
  status?: MemberStatus
}

/**
 * 成员的细分状态：
 * - working  正在调用工具（或刚调完不到 20 秒，还在连续干活）
 * - command  正在跑命令：前台 run_command 在途，或者没在调工具但有后台命令还在跑（background=true）
 * - waiting  主连接在 chat_wait 里等消息
 * - idle     连着，没有动作
 * - stale    连着，但超过 10 分钟没有任何请求，也不在等消息：可能掉线了，或者这一轮已经结束
 * - offline  没有主连接
 * - paused   工作台按了暂停
 */
export type MemberStatusKind = 'working' | 'command' | 'waiting' | 'idle' | 'stale' | 'offline' | 'paused'

export interface MemberStatus {
  status: MemberStatusKind
  /** 进入这个状态的时间（毫秒时间戳）。不知道时没有，比如启动以来没连过的 offline */
  since?: number
  /** working / command：正在调的工具，或者刚调完的那个 */
  tool?: string
  /** working / command：这一刻真有调用在途；false 表示刚调完，还在连续干活的窗口里 */
  calling?: boolean
  /** command：true 表示是后台命令在跑，AI 本身没在调工具 */
  background?: boolean
  /** 手上进行中的任务（最多 5 个） */
  tasks?: { ref: string; title: string; workspaceId: string }[]
  /** 名下还在跑的后台命令数 */
  commands?: number
  /** 会话数（含副连接） */
  sessions: number
  /** 连着的副连接的读者名 */
  readers?: string[]
  /** 主连接最后一次请求的时间 */
  lastSeen?: number
}

/** 公网隧道设置（cloudflared） */
export interface TunnelConfig {
  /** quick：临时 trycloudflare.com 地址，每次启动都变；named：自己的域名，需要 Cloudflare 账号 */
  mode: 'quick' | 'named'
  /** named 模式的公网域名，如 mcp.example.com */
  hostname?: string
  /** named 模式的 tunnel token（cloudflared tunnel run --token）。只存在 config.json，不发给界面 */
  token?: string
  /** 启动应用时自动开隧道 */
  autoStart: boolean
  /** 关闭应用时保留隧道：cloudflared 留在后台，下次启动接管，地址不变 */
  keepOnExit?: boolean
}

export interface TunnelState {
  status: 'off' | 'starting' | 'running' | 'error'
  mode: TunnelConfig['mode']
  /** 运行中的公网根地址，如 https://xxx.trycloudflare.com（不含 /mcp） */
  url?: string
  error?: string
  /** 本机找到的 cloudflared 路径；没找到为空 */
  cloudflaredPath?: string
  /** 正在运行的隧道是以保留方式启动的：关闭应用时能留下 */
  kept?: boolean
}

/** 界面能看到的隧道设置：token 只告诉有没有 */
export interface TunnelSettings {
  mode: TunnelConfig['mode']
  hostname?: string
  hasToken: boolean
  autoStart: boolean
  keepOnExit?: boolean
}

export interface BridgeState {
  running: boolean
  error?: string
  paused: boolean
  // ===== 多工作区（ws-core） =====
  workspaces: WorkspaceView[]
  activeWorkspaceId?: string
  /** 当前工作区的根目录（兼容旧界面），没有时为空字符串 */
  workspaceRoot: string
  /** 当前工作区的名字（兼容旧界面），没有时为空字符串 */
  workspaceName: string
  host: string
  port: number
  /** 本机地址，等于 urls.local */
  mcpUrl: string
  agents: Agent[]
  roles: Role[]
  presence: Presence[]
  /** 每个成员（含离线的）的细分状态，键是成员 id */
  memberStatus?: Record<string, MemberStatus>
  /** 局域网开关：开时监听 0.0.0.0，关时只监听 127.0.0.1 */
  lanEnabled: boolean
  /** 网页 AI 认证方式：link = 带 token 的链接直连（默认），oauth = OAuth + 桌面批准 */
  authMode: AuthMode
  /** 有事等用户时弹系统通知（设置里的开关） */
  notifyAttention: boolean
  /** 各入口的 MCP 地址（都带 /mcp） */
  urls: {
    local: string
    /** 局域网开着时，每个局域网 IPv4 一个 */
    lan: string[]
    /** 隧道运行中时的 https 地址 */
    public?: string
  }
  tunnel: TunnelState
  tunnelSettings: TunnelSettings
  /** 等你在桌面批准的 OAuth 授权请求（网页 AI 连接时产生） */
  oauthPending: PendingAuthorization[]
  /** 已打开的工作区现在的文件占用登记，键是工作区 id，没有登记的不放（画布算「两个 AI 改同一个文件」用） */
  fileClaims?: Record<string, ClaimSummary['claims']>
  /** 群聊里用户自己的未读数 */
  chat: GroupChatState
}

// ========== 群聊 ==========
// 约定（.team/chat-contract.md）里叫 ChatMessage / ChatState，和内置 AI 对话的 ChatMessage 重名，这里改叫 GroupMessage / GroupChatState

export interface GroupMessage {
  /** m_<时间戳36进制>_<随机>，同一频道内按时间递增 */
  id: string
  /** 频道内从 1 开始递增，已读游标记这个数 */
  seq: number
  /** 'general'（大厅，私聊都在这里）或 'ws:<工作区 id>' */
  channel: string
  ts: number
  /** via：从副连接（握手时报了读者名的，比如代理脚本）发的，值是读者名；只用来显示，不是身份也不是权限 */
  from: { kind: 'user' | 'agent'; id: string; name: string; color?: string; via?: string }
  /** 私聊对象 agent id（或 'user'）；不填表示发到群里 */
  to?: string
  /** 最长 8000 字，Markdown */
  text: string
  /** 解析出的 agent id；@你 记成 'user'，@所有人 记成 '*' */
  mentions: string[]
  /** 引用的消息 id */
  replyTo?: string
  /** 发送时所在的工作区（只做展示） */
  workspaceId?: string
  /** 图片附件（只有元信息，图片本身按 id 取）。带了图片的消息 text 可以是空的 */
  attachments?: ChatAttachment[]
  /**
   * 'receipt'：回执（「收到」一类），只送给 mentions 里的人和私聊对象，对其他人不叫醒、不通知、不计未读；普通消息没有这个字段。
   * 'event'：任务的线里自动记的一件事（派活、认领、交付、审查……），from 是做这件事的人；对谁都不叫醒、不通知、不计未读，读这个频道时能看到
   */
  kind?: 'receipt' | 'event'
  /**
   * 频道是「分工明确」时发的消息才有：除了发的人和用户，只有这里列的成员（agent id）能看到。
   * 发的时候就定下来，之后频道改回「灵感激荡」也不变；频道当前的主脑总能看到（换了主脑，新主脑接着看得到）。
   * 没有这个字段的消息照原来的规则，频道里的人都能看到
   */
  audience?: string[]
}

/**
 * 一个群聊频道：大厅（id 'general'）、某个工作区的主群聊（id 'ws:<工作区 id>'），
 * 或用户在工作区里另开的会话（id 'ws:<工作区 id>.c_<会话 id>'）
 */
export interface GroupChannelInfo {
  id: string
  /** 大厅叫「大厅」；工作区主群聊取工作区当前的名字；会话是「工作区名 / 会话标题」 */
  name: string
  /** 工作区的主群聊和会话才有 */
  workspaceId?: string
  /** 另开的会话才有：标题、创建时间、是不是归档了（归档的 AI 看不到、不能发言） */
  thread?: { title: string; createdAt: number; archived?: boolean }
  /** 工作区的主群聊、用户给它起过名字才有。只是工作台界面上的名字：name 不变，AI 那边看到的还是工作区名 */
  title?: string
  /**
   * 任务的线才有（它同时带 thread）：是哪条任务的、谁在里面（执行者、派活的人、创建者里的 AI；用户总在）。
   * 任务的线不在 GroupChatState.channels 里，在 taskThreads 里
   */
  task?: { id: string; ref: string; memberIds: string[] }
  /** 清空过：这个序号及之前的消息已经清掉了（界面据此丢掉缓存里的旧消息） */
  floor?: number
  /** 看的人的未读数（state.chat 里是用户的） */
  unread: number
  mentions: number
  /** 最后一条消息的时间，没有消息为 0 */
  lastTs: number
  /** 这个频道的干活方式：有主脑（agent id）就是「分工明确」，没有这个字段是「灵感激荡」 */
  leadId?: string
  /** 「分工明确」时用户选的子代理（agent id）。没有这个字段是没选过：能进这个频道的 AI 里主脑以外的都算子代理 */
  subIds?: string[]
  /** 「灵感激荡」时用户选的参与讨论的 AI（agent id）。没有这个字段是没选过：能进这个频道的 AI 都参与 */
  partIds?: string[]
}

/** 用户自己的群聊未读数：unread / mentions 是各频道之和 */
export interface GroupChatState {
  unread: number
  mentions: number
  channels: GroupChannelInfo[]
  /** 任务的线（每条任务自带的会话）。不算进 unread / mentions，也不在 channels 里；一条都没有时不带这个字段 */
  taskThreads?: GroupChannelInfo[]
}

// ========== 改动与检查点（工作台） ==========

/** 检查点里一个文件这一步的改动 */
export interface CheckpointFileView {
  /** 工作区相对路径（/ 分隔），以检查点里记录的为准 */
  path: string
  change: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
  binary?: boolean
  too_large?: boolean
  /** 改之后的内容找不到了（之后又被改过且没有快照），行数不准 */
  unknown?: boolean
  /** 已经被哪个回滚检查点退回 */
  rolledBackBy?: string
}

export interface CheckpointStepView {
  id: string
  seq: number
  ts: number
  agentId: string
  agentName: string
  /** 已吊销或是用户时没有 */
  agentColor?: string
  session: string
  task: string | null
  tool: string
  /** rollback = 这一步本身是一次回滚 */
  kind: 'edit' | 'rollback'
  files: CheckpointFileView[]
  additions: number
  deletions: number
  rolledBack: 'none' | 'partial' | 'all'
  /** 没存快照、回滚恢复不了的文件 */
  skipped: { path: string; reason: string }[]
}

export interface CheckpointSessionView {
  session: string
  agentId: string
  agentName: string
  agentColor?: string
  /** 最早、最晚一步的时间 */
  firstTs: number
  lastTs: number
  tasks: string[]
  /** 新的在前 */
  steps: CheckpointStepView[]
}

export interface CheckpointListResult {
  workspaceId: string
  /** 新的会话在前 */
  sessions: CheckpointSessionView[]
  /** 符合条件的检查点总数（limit 之前） */
  total: number
  truncated: boolean
  /** 筛选用：有检查点的 AI（不受 agentId 筛选和 limit 影响） */
  agents: { agentId: string; agentName: string; agentColor?: string; steps: number }[]
  /**
   * 只在要了 elsewhere 时给：别的工作区里挂在这个工作区任务上的改动（经「整台电脑」改的，存在那边的检查点里），
   * 整理成留痕清单能直接用的样子——task 是这个工作区的任务编号，路径是绝对路径。没有就不带这一项
   */
  elsewhere?: { ts: number; agentName: string; task: string | null; kind: 'edit' | 'rollback'; files: { path: string; rolledBackBy?: string }[] }[]
}

export interface CheckpointSummaryFile {
  path: string
  status: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
  binary?: boolean
  too_large?: boolean
  /** 检查点之后被别的途径（命令、编辑器）改过 */
  changed_outside?: boolean
  /** 涉及的检查点 id */
  checkpoints: string[]
  /** 这个文件的 unified diff（二进制、太大时为空字符串） */
  diff: string
  diff_truncated?: boolean
}

export interface CheckpointSummaryResult {
  workspaceId: string
  files: CheckpointSummaryFile[]
  totals: { files: number; additions: number; deletions: number; unchanged_after_edits: number; checkpoints: number }
  review_text: string
}

export interface CheckpointConflictView {
  path: string
  reason: 'modified_after' | 'changed_between' | 'touched_by_other' | 'snapshot_missing' | 'not_a_file'
  detail: string
  expected_version?: string | null
  current_version?: string | null
}

/** 回滚结果：冲突不抛错，带着详情返回 */
export type CheckpointRollbackResult =
  | {
      status: 'dry_run'
      /** restore = 恢复旧内容，recreate = 被删的建回来，delete = 新建的移进回收站 */
      files: { path: string; action: 'restore' | 'recreate' | 'delete' }[]
      checkpoints: string[]
      skipped: { path: string; reason: string; checkpoint: string }[]
    }
  | {
      status: 'done'
      /** 这次回滚本身存成的检查点（可以再退回去） */
      checkpoint: string | null
      files: { path: string; action: string }[]
      rolledBackCheckpoints: string[]
      skipped: { path: string; reason: string; checkpoint: string }[]
    }
  | {
      status: 'conflict'
      message: string
      conflicts: CheckpointConflictView[]
      /** 没冲突、可以单独回滚的文件 */
      restorable: string[]
      skipped: { path: string; reason: string; checkpoint: string }[]
    }
  | { status: 'nothing'; message: string }

// ========== 技能库 ==========

/** project：<工作区>/.bridge/skills/<name>/；user：用户级目录（默认 ~/.workspace-bridge/skills/<name>/） */
export type SkillScope = 'project' | 'user'

/** enabled：AI 能用（放进目录就是，不用审阅）；disabled：用户手动停用了；invalid：缺 SKILL.md、含符号链接或太大，用不了 */
/** 回收站里的一项（删除、覆盖、回滚掉的文件或目录，删掉的技能）。整个工作台共用一个回收站 */
export interface TrashItem {
  /** 条目 id：毫秒时间戳-6 位十六进制 */
  id: string
  /** 文件名 / 目录名 */
  name: string
  /** 删的时候记下的路径：工作区相对路径（用户级技能是绝对路径） */
  originalPath: string
  /** 原来的绝对位置；老版本删的没有记 */
  absPath?: string
  deletedAt: number
  kind: 'file' | 'dir'
  bytes: number
  files: number
  /** 文件太多，bytes / files 只数了一部分（实际更大） */
  sizeCapped?: boolean
  /** delete = 删除或被覆盖；rollback = 回滚时移走的新建文件；skill = 删掉或被覆盖的技能 */
  source: 'delete' | 'rollback' | 'skill'
  /** source=skill 时：范围:名字 */
  skill?: string
}

/** 工作台看到的回收站条目：带上原来属于哪个工作区、能不能直接放回原位 */
export interface TrashEntry extends TrashItem {
  /** 放回原位会落在哪（绝对路径）；没有 = 老条目，恢复时放进指定的工作区 */
  restoreTo?: string
  workspaceId?: string
  workspaceName?: string
}

export type SkillStatus = 'enabled' | 'disabled' | 'invalid'

export interface SkillInfo {
  /** `${scope}:${name}` */
  id: string
  name: string
  scope: SkillScope
  /** SKILL.md frontmatter 的 description */
  description: string
  status: SkillStatus
  /** invalid 的原因 */
  problem?: string
  /** 技能目录里有 scripts/（AI 可以用 run_command 运行） */
  hasScripts: boolean
  /** 技能目录内的相对路径（/ 分隔），含 SKILL.md */
  files: string[]
  /** 谁放进来的：agent 表示 AI 用 install_skill 写入 */
  origin: 'user' | 'agent' | 'found'
  /** origin=agent 时写入它的 AI 名字 */
  installedBy?: string
  /** 用户级技能和项目级技能同名时，项目级优先，用户级这条被遮住 */
  shadowed?: boolean
  usage: { loads: number; reads: number; lastUsedAt?: number }
  enabledAt?: number
}

export interface SkillDetail extends SkillInfo {
  /** SKILL.md 全文（含 frontmatter） */
  content: string
  /** 技能目录的绝对路径 */
  dir: string
}


/** 工作台新建或修改技能（只写 SKILL.md） */
export interface SkillInput {
  scope: SkillScope
  name: string
  description: string
  /** SKILL.md 正文（不含 frontmatter，保存时由 name 和 description 生成） */
  body: string
}

// ===== 搜索（ui-skills） =====

export interface SearchOptions {
  query: string
  /** 不传搜全部工作区 */
  workspaceId?: string
  /** 搜索起点目录（工作区相对），不传为根目录 */
  path?: string
  regex?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
  /** glob，逗号分隔（如 src/**,*.ts）或数组 */
  include?: string | string[]
  exclude?: string | string[]
  /** 每处匹配前后各带几行原文，0-5，默认 0 */
  contextLines?: number
  /** 单个文件最多返回多少处匹配，默认 20，上限 100 */
  maxMatchesPerFile?: number
  maxResults?: number
}

/** line 从 1 开始；ranges 是 [起, 止) 列号，从 0 开始，UTF-16，按整行算 */
export interface SearchMatch {
  line: number
  text: string
  ranges: [number, number][]
  /** 行太长时 text 只是其中一段：text[0] 是整行的第 textStart 列；不传为 0 */
  textStart?: number
  /** context_lines 要来的上文，最后一行离本行最近 */
  contextBefore?: string[]
  /** context_lines 要来的下文，第一行离本行最近 */
  contextAfter?: string[]
}

export interface SearchFileResult {
  workspaceId: string
  path: string
  matches: SearchMatch[]
  /** 这个文件的匹配超过 max_matches_per_file，只给了前面的 */
  truncated?: boolean
}

export interface SearchResult {
  files: SearchFileResult[]
  totalMatches: number
  truncated: boolean
  /** 被截断的原因：timeout / max_results / scan_limit / max_matches_per_file / canceled */
  truncatedReason?: string
  /** 因为超过大小上限被跳过的文件数 */
  skippedLargeFiles?: number
  /** 这次用的搜索引擎：ripgrep，或者 rg 用不了时的内置 JS 引擎 bridge */
  engine?: 'ripgrep' | 'bridge'
  durationMs: number
}


export interface FileListEntry {
  workspaceId: string
  /** 工作区相对路径，/ 分隔 */
  path: string
}

// ===== 内置 AI（mcp-layer） =====

/** openai：OpenAI 兼容的 /chat/completions（DeepSeek、通义、Kimi、Ollama 等）；anthropic：/v1/messages */
export type ProviderKind = 'openai' | 'anthropic'

/** 给界面的提供方：不含 apiKey */
export interface ModelProviderView {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  hasKey: boolean
  models: string[]
}

/** apiKey：不传不改，传空字符串清除 */
export interface ProviderInput {
  id?: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey?: string
  models?: string[]
}

/** 给 AI 身份绑定的模型；绑定了就是「内置 AI」 */
export interface AgentModel {
  providerId: string
  model: string
  /** 追加在连接说明后面 */
  systemPrompt?: string
  temperature?: number
  /** 一次对话里最多调用工具的轮数，默认 30 */
  maxSteps?: number
  /** 有新任务、审查结果等通知时自动开始处理 */
  autoTasks?: boolean
}

export interface ChatToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  status: 'running' | 'ok' | 'error'
  result?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 推理过程（DeepSeek reasoning_content、Claude thinking） */
  reasoning?: string
  toolCalls?: ChatToolCall[]
  error?: string
  ts: number
}

export interface ChatSession {
  agentId: string
  status: 'idle' | 'running' | 'error'
  messages: ChatMessage[]
  error?: string
  usage?: { input: number; output: number }
}

// ===== 终端（skills-core） =====

export interface TerminalInfo {
  id: string
  /** 标签上显示的名字，例如「pwsh · my-project」 */
  title: string
  cwd: string
  shell: string
  pid: number
  /** 在某个工作区根目录打开时记下，界面按它分组 */
  workspaceId?: string
  /** 进程退出后才有 */
  exitCode?: number
}
