// MCP 工具目录：主进程（注册）和界面（工具列表、试用页）共用。不能引入 Node 模块

export type ToolGroup = 'team' | 'file-read' | 'code' | 'screen' | 'file-write' | 'checkpoint' | 'command' | 'plan' | 'memory' | 'chat' | 'task' | 'skill' | 'browser'

export interface ToolMeta {
  name: string
  group: ToolGroup
  /** 界面上显示的一句话说明 */
  label: string
}

export const TOOL_GROUPS: { id: ToolGroup; label: string }[] = [
  { id: 'team', label: '身份与团队' },
  { id: 'file-read', label: '文件读取' },
  { id: 'code', label: '代码诊断' },
  { id: 'screen', label: '截图' },
  { id: 'file-write', label: '文件修改' },
  { id: 'checkpoint', label: '检查点与回滚' },
  { id: 'command', label: '命令执行' },
  { id: 'plan', label: '计划与进度' },
  { id: 'memory', label: '记忆' },
  { id: 'chat', label: '群聊' },
  { id: 'task', label: '任务' },
  { id: 'skill', label: '技能' },
  { id: 'browser', label: '内置浏览器' }
]

export const TOOL_CATALOG: ToolMeta[] = [
  { name: 'whoami', group: 'team', label: '查看自己的身份、职位和能用的工作区' },
  { name: 'team_list', group: 'team', label: '查看团队成员和在线状态' },
  { name: 'canvas_read', group: 'team', label: '看画布：AI 卡片、团队框、派活的线、便签' },
  { name: 'canvas_note', group: 'team', label: '在画布上贴、改、删便签' },
  { name: 'list_workspaces', group: 'team', label: '查看能访问的工作区' },
  { name: 'wait_for_resume', group: 'team', label: '「全部停下」期间等用户恢复' },
  { name: 'workspace_brief', group: 'team', label: '查看任务、消息和文件占用的开工简报' },
  { name: 'claim_files', group: 'team', label: '登记准备修改的文件' },
  { name: 'release_files', group: 'team', label: '释放文件占用登记' },
  { name: 'list_file_claims', group: 'team', label: '查看文件占用登记' },

  { name: 'list_dir', group: 'file-read', label: '列出目录' },
  { name: 'read_file', group: 'file-read', label: '读取文件' },
  { name: 'read_files', group: 'file-read', label: '一次读多个文件' },
  { name: 'search', group: 'file-read', label: '搜索内容（带上下文行）' },
  { name: 'find_files', group: 'file-read', label: '按文件名或 glob 找文件' },
  { name: 'file_info', group: 'file-read', label: '查看文件信息' },
  { name: 'read_image', group: 'file-read', label: '看图片（尺寸信息 + 图片内容）' },

  { name: 'screenshot', group: 'screen', label: '截窗口或本地网页看界面' },

  { name: 'get_diagnostics', group: 'code', label: '检查 TS/JS 的类型错误和警告' },
  { name: 'lsp', group: 'code', label: 'TS/JS 语义导航：跳转定义、找引用、看类型' },

  { name: 'write_file', group: 'file-write', label: '写入整个文件' },
  { name: 'edit_file', group: 'file-write', label: '按字符串替换修改文件' },
  { name: 'apply_patch', group: 'file-write', label: '用补丁一次修改、新增、删除多个文件' },
  { name: 'mkdir', group: 'file-write', label: '创建目录' },
  { name: 'move', group: 'file-write', label: '移动或重命名' },
  { name: 'delete', group: 'file-write', label: '删除（进回收站）' },
  { name: 'trash_list', group: 'file-write', label: '查看回收站' },
  { name: 'trash_restore', group: 'file-write', label: '从回收站恢复到原位置' },
  { name: 'trash_empty', group: 'file-write', label: '彻底删除回收站里的东西（恢复不了）' },

  { name: 'checkpoint_list', group: 'checkpoint', label: '查看自己改文件前自动存下的检查点' },
  { name: 'changes_summary', group: 'checkpoint', label: '汇总改动：改了哪些文件、增删行数和 diff' },
  { name: 'change_trail', group: 'checkpoint', label: '留痕清单：按任务编号看谁改了哪些文件' },
  { name: 'checkpoint_rollback', group: 'checkpoint', label: '把自己的改动退回到检查点（有冲突就不写）' },

  { name: 'run_command', group: 'command', label: '执行 bash / PowerShell 命令（Windows 上 bash 是 Git Bash）' },
  { name: 'get_command_output', group: 'command', label: '读取命令的输出和状态（可等待输出）' },
  { name: 'list_commands', group: 'command', label: '列出自己发起的命令' },
  { name: 'send_command_input', group: 'command', label: '给运行中的命令写输入' },
  { name: 'cancel_command', group: 'command', label: '取消运行中的命令' },
  { name: 'list_processes', group: 'command', label: '列出本机进程和监听端口' },
  { name: 'kill_process', group: 'command', label: '结束本机进程（按 pid 或端口）' },

  { name: 'set_todos', group: 'plan', label: '设置待办清单' },
  { name: 'update_plan', group: 'plan', label: '更新计划（Codex 风格）' },
  { name: 'report_progress', group: 'plan', label: '报告当前进度' },

  { name: 'memory_search', group: 'memory', label: '搜索记忆' },
  { name: 'memory_read', group: 'memory', label: '读取一条记忆全文' },
  { name: 'memory_save', group: 'memory', label: '新建或修改记忆' },
  { name: 'memory_delete', group: 'memory', label: '删除记忆' },

  { name: 'chat_send', group: 'chat', label: '在群聊里发消息、@ 成员或私聊' },
  { name: 'chat_read', group: 'chat', label: '读群聊消息' },
  { name: 'chat_wait', group: 'chat', label: '等群聊新消息（最长 60 秒）' },
  { name: 'chat_channels', group: 'chat', label: '查看能用的群聊频道和未读数' },
  { name: 'chat_image', group: 'chat', label: '查看群聊消息里的图片' },

  { name: 'task_list', group: 'task', label: '查看任务列表' },
  { name: 'task_get', group: 'task', label: '查看任务详情' },
  { name: 'task_create', group: 'task', label: '新建任务' },
  { name: 'task_claim', group: 'task', label: '认领任务' },
  { name: 'task_update', group: 'task', label: '更新任务状态和结果' },
  { name: 'task_review', group: 'task', label: '审查别人提交的任务' },
  { name: 'task_assign', group: 'task', label: '把任务派给别人' },
  { name: 'task_delete', group: 'task', label: '删除任务（连同子任务）' },
  { name: 'task_question', group: 'task', label: '任务里的待决定问题：提问、回答、关闭' },

  { name: 'list_skills', group: 'skill', label: '查看可用技能' },
  { name: 'load_skill', group: 'skill', label: '加载技能说明（SKILL.md）' },
  { name: 'read_skill_resource', group: 'skill', label: '读取技能附带的文件' },
  { name: 'install_skill', group: 'skill', label: '写入新技能（写入后直接生效）' },

  { name: 'browser_info', group: 'browser', label: '内置浏览器的现状和用法（CDP 地址、开着的标签）' },
  { name: 'browser_open', group: 'browser', label: '在右栏的内置浏览器里打开网页' },
  { name: 'browser_close', group: 'browser', label: '关掉内置浏览器里的一个标签' }
]

/** 全部工具名。接入的 AI 都能用全部工具，没有停用和白名单 */
export const TOOL_NAMES: string[] = TOOL_CATALOG.map((t) => t.name)

/** 改文件前会自动存检查点的工具 */
export const CHECKPOINTED_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'apply_patch', 'move', 'delete'])
