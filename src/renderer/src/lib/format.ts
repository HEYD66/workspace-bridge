import type { TaskItem, TaskStatus } from '../../../shared/api'

export const TOOL_LABELS: Record<string, string> = {
  whoami: '确认身份',
  list_dir: '查看目录',
  read_file: '读取',
  read_files: '批量读取',
  write_file: '写入',
  edit_file: '编辑',
  apply_patch: '补丁',
  search: '搜索',
  find_files: '找文件',
  file_info: '查看信息',
  mkdir: '建目录',
  move: '移动',
  delete: '删除',
  trash_list: '查看回收站',
  trash_restore: '从回收站恢复',
  trash_empty: '清回收站',
  change_trail: '看留痕清单',
  memory_search: '搜索记忆',
  memory_read: '读记忆',
  memory_save: '存记忆',
  memory_delete: '删记忆',
  task_list: '查看任务',
  task_get: '任务详情',
  task_create: '建任务',
  task_claim: '认领任务',
  task_update: '更新任务',
  task_review: '审查任务',
  task_assign: '分配任务',
  task_delete: '删任务',
  task_question: '待决定问题',
  wait_for_resume: '等恢复',
  chat_image: '查看群聊图片',
  workspace_brief: '读取开工简报',
  claim_files: '登记文件占用',
  release_files: '释放文件占用',
  list_file_claims: '查看文件占用',
  team_list: '查看团队',
  list_workspaces: '查看工作区',
  list_skills: '查看技能',
  load_skill: '加载技能',
  read_skill_resource: '读技能文件',
  install_skill: '写入技能',
  browser_info: '查看内置浏览器',
  browser_open: '打开网页',
  browser_close: '关闭网页标签',
  run_command: '执行命令',
  get_command_output: '读命令输出',
  list_commands: '列出命令',
  send_command_input: '命令输入',
  cancel_command: '取消命令'
}

/** 会改动工作区文件的工具 */
export const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch', 'mkdir', 'move', 'delete', 'trash_restore'])
export const MEMORY_TOOLS = new Set(['memory_search', 'memory_read', 'memory_save', 'memory_delete'])
export const TASK_TOOLS = new Set(['task_list', 'task_get', 'task_create', 'task_claim', 'task_update', 'task_review', 'task_assign', 'task_delete', 'task_question'])

export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool
}

export const STATUS_META: Record<TaskStatus, { label: string; color: string }> = {
  todo: { label: '待办', color: '#8b949e' },
  in_progress: { label: '进行中', color: '#58a6ff' },
  review: { label: '待审查', color: '#d29922' },
  blocked: { label: '受阻', color: '#f85149' },
  done: { label: '完成', color: '#3fb950' }
}

export const STATUS_ORDER: TaskStatus[] = ['in_progress', 'review', 'blocked', 'todo', 'done']

export const PRIORITY_LABELS: Record<TaskItem['priority'], string> = { high: '高', normal: '中', low: '低' }

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 5) return '刚刚'
  if (s < 60) return `${s} 秒前`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} 小时前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

export function initials(name: string): string {
  const t = name.trim()
  if (!t) return '?'
  // 中日韩文字取第一个字，其他取首字母（最多两个单词）
  if (/[㐀-鿿가-힯぀-ヿ]/.test(t[0])) return t[0]
  return t
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('')
}

/** 把错误信息里 Electron 加的前缀去掉 */
export function errText(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
