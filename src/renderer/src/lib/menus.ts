// T-13：各处右键菜单的菜单项。这里只拼菜单项（文字、哪些灰掉和为什么），真正的动作由调用方传进来，方便单测。
import { createElement } from 'react'
import {
  Archive,
  ArchiveRestore,
  AtSign,
  ClipboardCopy,
  Copy,
  Eye,
  FilePlus,
  FolderOpen,
  FolderPlus,
  ListChecks,
  Pencil,
  Pin,
  PinOff,
  Power,
  PowerOff,
  RefreshCw,
  Settings2,
  UsersRound,
  Trash2,
  UserPlus,
  X,
  type LucideIcon
} from 'lucide-react'
import type { TaskStatus } from '../../../shared/api'
import type { MenuEntry } from './contextMenu'
import { STATUS_META, STATUS_ORDER } from './format'

const ic = (C: LucideIcon) => createElement(C, { size: 13 })

/** 工作区根目录 + 相对路径（/ 分隔）拼成绝对路径，分隔符跟根目录走 */
export function joinRoot(root: string, rel: string): string {
  const sep = root.includes('\\') ? '\\' : '/'
  const tail = rel.replace(/^\.\/?/, '').replace(/^[\\/]+/, '')
  if (!tail) return root
  return root.replace(/[\\/]+$/, '') + sep + tail.split(/[\\/]/).join(sep)
}

// ───── 资源管理器 ─────

export interface ExplorerActions {
  newFile: () => void
  newDir: () => void
  rename: () => void
  remove: () => void
  reveal: () => void
  copyPath: () => void
  copyRelPath: () => void
  refresh: () => void
}

/** 文件树右键：目录（含根）能新建；根不能改名、删除；删除走原来的确认弹窗，所以这里不再二次确认 */
export function explorerMenu(t: { isDir: boolean; isRoot: boolean }, a: ExplorerActions): MenuEntry[] {
  const out: MenuEntry[] = []
  if (t.isDir || t.isRoot) {
    out.push({ id: 'new-file', label: '新建文件', icon: ic(FilePlus), run: a.newFile })
    out.push({ id: 'new-dir', label: '新建文件夹', icon: ic(FolderPlus), run: a.newDir }, '-')
  }
  if (!t.isRoot) {
    out.push({ id: 'rename', label: '重命名', icon: ic(Pencil), run: a.rename })
    out.push({ id: 'delete', label: '删除…', icon: ic(Trash2), danger: true, run: a.remove }, '-')
  }
  out.push({ id: 'reveal', label: '在系统资源管理器中显示', icon: ic(FolderOpen), run: a.reveal })
  out.push({ id: 'copy-path', label: '复制路径', icon: ic(Copy), run: a.copyPath })
  out.push({ id: 'copy-rel', label: '复制相对路径', icon: ic(Copy), run: a.copyRelPath })
  out.push('-', { id: 'refresh', label: '刷新', icon: ic(RefreshCw), run: a.refresh })
  return out
}

// ───── 任务卡 ─────

export interface TaskMenuTask {
  ref: string
  status: TaskStatus
  assigneeId?: string | null
}

export interface TaskActions {
  open: () => void
  setStatus: (s: TaskStatus) => void
  assign: (agentId: string | null) => void
  copyRef: () => void
  copyTitle: () => void
  mention: (name: string) => void
  remove: () => void
}

/** 任务卡右键：看详情、指派 / 改回待认领、改状态、复制编号、@负责人、删除（要点两次） */
export function taskMenu(t: TaskMenuTask, agents: { id: string; name: string }[], a: TaskActions): MenuEntry[] {
  const out: MenuEntry[] = [{ id: 'open', label: '查看详情', icon: ic(Eye), run: a.open }, '-']
  for (const ag of agents) {
    out.push({
      id: `assign:${ag.id}`,
      label: `指派给 ${ag.name}`,
      icon: ic(UserPlus),
      disabled: ag.id === t.assigneeId ? '已经是负责人' : undefined,
      run: () => a.assign(ag.id)
    })
  }
  out.push({
    id: 'unassign',
    label: '改回待认领',
    icon: ic(UserPlus),
    disabled: t.assigneeId ? undefined : '现在就没有负责人',
    run: () => a.assign(null)
  })
  out.push('-')
  for (const s of STATUS_ORDER) {
    out.push({
      id: `status:${s}`,
      label: `改成「${STATUS_META[s].label}」`,
      icon: ic(ListChecks),
      disabled: s === t.status ? '现在就是这个状态' : undefined,
      run: () => a.setStatus(s)
    })
  }
  const owner = t.assigneeId ? agents.find((x) => x.id === t.assigneeId) : undefined
  out.push(
    '-',
    { id: 'copy-ref', label: '复制编号', icon: ic(Copy), hint: t.ref, run: a.copyRef },
    { id: 'copy-title', label: '复制标题', icon: ic(Copy), run: a.copyTitle },
    {
      id: 'mention',
      label: owner ? `在群聊 @${owner.name}` : '在群聊 @负责人',
      icon: ic(AtSign),
      disabled: !t.assigneeId ? '还没有负责人' : !owner ? '负责人已经不在团队里' : undefined,
      run: () => owner && a.mention(owner.name)
    },
    '-',
    { id: 'delete', label: '删除任务', icon: ic(Trash2), danger: true, confirm: '再点一次删除', run: a.remove }
  )
  return out
}

// ───── 工作区 ─────

export interface WorkspaceActions {
  switchTo: () => void
  reveal: () => void
  copyPath: () => void
  manage: () => void
  /** 选哪些 AI 能用这个工作区 */
  members: () => void
  remove: () => void
}

/** 工作区列表右键：切换、在系统资源管理器中显示、复制路径、成员、管理、移出列表（不删文件，要点两次） */
export function workspaceMenu(w: { active: boolean; exists: boolean }, a: WorkspaceActions): MenuEntry[] {
  return [
    { id: 'switch', label: '切换到这个工作区', disabled: w.active ? '已经是当前工作区' : undefined, run: a.switchTo },
    '-',
    { id: 'reveal', label: '在系统资源管理器中显示', icon: ic(FolderOpen), disabled: w.exists ? undefined : '目录已经不在了', run: a.reveal },
    { id: 'copy-path', label: '复制路径', icon: ic(Copy), run: a.copyPath },
    '-',
    { id: 'members', label: '成员（哪些 AI 能用）…', icon: ic(UsersRound), run: a.members },
    { id: 'manage', label: '管理工作区…', icon: ic(Settings2), run: a.manage },
    { id: 'remove', label: '移出列表', icon: ic(Trash2), danger: true, confirm: '只移出列表、不删文件，再点一次', run: a.remove }
  ]
}

// ───── 技能 ─────

export interface SkillActions {
  open: () => void
  setEnabled: (on: boolean) => void
  openDir: () => void
  copyName: () => void
  remove: () => void
}

/** 技能列表右键：查看、启用 / 停用（格式有问题的不能启用）、打开目录、复制名字、删除（要点两次） */
export function skillMenu(s: { status: 'enabled' | 'disabled' | 'invalid' }, a: SkillActions): MenuEntry[] {
  const on = s.status === 'enabled'
  return [
    { id: 'open', label: '查看', icon: ic(Eye), run: a.open },
    on
      ? { id: 'disable', label: '停用', icon: ic(PowerOff), run: () => a.setEnabled(false) }
      : {
          id: 'enable',
          label: '启用',
          icon: ic(Power),
          disabled: s.status === 'invalid' ? '技能格式有问题，修好才能启用' : undefined,
          run: () => a.setEnabled(true)
        },
    '-',
    { id: 'open-dir', label: '打开技能目录', icon: ic(FolderOpen), run: a.openDir },
    { id: 'copy-name', label: '复制名字', icon: ic(Copy), run: a.copyName },
    '-',
    { id: 'delete', label: '删除技能', icon: ic(Trash2), danger: true, confirm: '整个目录移进回收站，再点一次', run: a.remove }
  ]
}

// ───── 编辑器标签 ─────

export interface EditorTabActions {
  close: () => void
  closeOthers: () => void
  closeRight: () => void
  closeAll: () => void
  copyPath: () => void
  copyRelPath: () => void
  reveal: () => void
}

/** 编辑器标签右键：关闭 / 关闭其他 / 关闭右侧 / 全部关闭（有没保存的会走原来的询问）、复制路径、在系统资源管理器中显示 */
export function editorTabMenu(index: number, count: number, a: EditorTabActions): MenuEntry[] {
  return [
    { id: 'close', label: '关闭', icon: ic(X), hint: 'Ctrl+W', run: a.close },
    { id: 'close-others', label: '关闭其他', disabled: count <= 1 ? '没有别的标签' : undefined, run: a.closeOthers },
    { id: 'close-right', label: '关闭右侧', disabled: index >= count - 1 ? '右边没有标签' : undefined, run: a.closeRight },
    { id: 'close-all', label: '全部关闭', run: a.closeAll },
    '-',
    { id: 'copy-path', label: '复制路径', icon: ic(Copy), run: a.copyPath },
    { id: 'copy-rel', label: '复制相对路径', icon: ic(Copy), run: a.copyRelPath },
    { id: 'reveal', label: '在系统资源管理器中显示', icon: ic(FolderOpen), run: a.reveal }
  ]
}

/** 「关闭其他 / 关闭右侧」要关掉的标签（按顺序） */
export function tabsToClose<T>(tabs: T[], index: number, which: 'others' | 'right' | 'all'): T[] {
  if (which === 'all') return [...tabs]
  if (which === 'right') return tabs.slice(index + 1)
  return tabs.filter((_, i) => i !== index)
}

// ───── 记忆卡 ─────

export interface MemoryActions {
  edit: () => void
  copyContent: () => void
  copyTitle: () => void
  togglePin: () => void
  /** 归档 / 取消归档；不传就没有这一项 */
  toggleArchive?: () => void
  remove: () => void
}

/** 记忆卡右键：编辑、复制、置顶 / 取消置顶、删除（要点两次） */
export function memoryMenu(m: { pinned: boolean; archivedAt?: number }, a: MemoryActions): MenuEntry[] {
  return [
    { id: 'edit', label: '编辑', icon: ic(Pencil), run: a.edit },
    { id: 'copy-content', label: '复制内容', icon: ic(ClipboardCopy), run: a.copyContent },
    { id: 'copy-title', label: '复制标题', icon: ic(Copy), run: a.copyTitle },
    '-',
    m.pinned
      ? { id: 'unpin', label: '取消置顶', icon: ic(PinOff), run: a.togglePin }
      : { id: 'pin', label: '置顶', icon: ic(Pin), run: a.togglePin },
    ...(a.toggleArchive
      ? [m.archivedAt ? { id: 'unarchive', label: '取消归档', icon: ic(ArchiveRestore), run: a.toggleArchive } : { id: 'archive', label: '归档', icon: ic(Archive), run: a.toggleArchive }]
      : []),
    '-',
    { id: 'delete', label: '删除记忆', icon: ic(Trash2), danger: true, confirm: '再点一次删除', run: a.remove }
  ]
}
