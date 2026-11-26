// 画布上的右键菜单：这里只拼菜单项（文字、哪些灰掉和为什么），真正的动作由 CanvasView 传进来，方便单测。
// 菜单里都是画布上本来就有的功能，只是多一个入口；做法和 lib/menus.ts 一样。
import { createElement } from 'react'
import { AppWindow, Archive, FileCode2, LayoutGrid, ListPlus, Maximize, MessageSquare, PanelRight, Pencil, Settings2, Square, StickyNote, Trash2, Undo2, UserPlus, UsersRound, X, type LucideIcon } from 'lucide-react'
import type { MenuEntry } from './contextMenu'

const ic = (C: LucideIcon) => createElement(C, { size: 13 })

/** 名字太长时截短，菜单不被撑得很宽 */
const short = (s: string, max = 14): string => (s.length > max ? `${s.slice(0, max)}…` : s)

// ───── AI 卡片 ─────

export interface CardMenuInfo {
  name: string
  /** 有项目可以建任务（一个项目都没有时派不了活） */
  canAssign: boolean
  /** 现在连着（没连着的叫停不了） */
  online: boolean
}

export interface CardMenuActions {
  /** 选中它，右边出面板（说话、看它改了什么） */
  panel: () => void
  /** 去群聊，输入框里先 @ 上它 */
  chat: () => void
  assign: () => void
  /** 在它旁边贴一张便签 */
  note: () => void
  settings: () => void
  /** 取消它在跑的命令、断开它的连接 */
  stop: () => void | Promise<void>
  archive: () => void
}

export function cardMenu(t: CardMenuInfo, a: CardMenuActions): MenuEntry[] {
  return [
    { id: 'panel', label: '和它说话、看它改了什么', icon: ic(PanelRight), run: a.panel },
    { id: 'chat', label: '去群聊里 @ 它', icon: ic(MessageSquare), hint: '双击', run: a.chat },
    { id: 'assign', label: '派一件活给它…', icon: ic(ListPlus), disabled: t.canAssign ? false : '先在首页添加一个项目，才能派活', run: a.assign },
    { id: 'note', label: '在它旁边贴便签', icon: ic(StickyNote), run: a.note },
    '-',
    { id: 'settings', label: '它的设置', icon: ic(Settings2), run: a.settings },
    { id: 'archive', label: '收纳（先不画这张卡片）', icon: ic(Archive), run: a.archive },
    '-',
    {
      id: 'stop',
      label: '叫停…',
      icon: ic(Square),
      danger: true,
      disabled: t.online ? false : '它现在没连着，没有可以停的',
      confirm: `再点一次：叫停 ${short(t.name)}（取消它在跑的命令、断开连接）`,
      run: a.stop
    }
  ]
}

// ───── 空白处 ─────

export interface BlankMenuInfo {
  /** 刚做过一键整理，可以撤销 */
  canUndo: boolean
  /** 点在哪个项目的框里（框里的空白处）；不在框里就没有 */
  frame?: FrameMenuInfo
}

export interface BlankMenuActions {
  note: () => void
  widget: () => void
  newAgent: () => void
  fit: () => void
  arrange: () => void
  undo: () => void
}

/** 空白处右键。点在某个框里的空白处时，后面接上这个框的几项 */
export function blankMenu(t: BlankMenuInfo, a: BlankMenuActions, f?: FrameMenuActions): MenuEntry[] {
  const out: MenuEntry[] = [
    { id: 'note', label: '在这里贴便签', icon: ic(StickyNote), run: a.note },
    { id: 'widget', label: '在这里开小窗（终端、网页、文件）…', icon: ic(AppWindow), run: a.widget },
    { id: 'new-agent', label: '新建一个 AI…', icon: ic(UserPlus), run: a.newAgent },
    '-',
    { id: 'fit', label: '全部放进屏幕', icon: ic(Maximize), hint: '0', run: a.fit },
    { id: 'arrange', label: '一键整理', icon: ic(LayoutGrid), run: a.arrange }
  ]
  if (t.canUndo) out.push({ id: 'undo', label: '撤销刚才的整理', icon: ic(Undo2), run: a.undo })
  if (t.frame && f) out.push('-', ...frameMenu(t.frame, f))
  return out
}

// ───── 项目的框 ─────

export interface FrameMenuInfo {
  title: string
  /** 框里有几张卡片 */
  cards: number
  /** 是一个真的项目（「没在项目里」那个框没有分工） */
  hasTeam: boolean
  hasChat: boolean
}

export interface FrameMenuActions {
  select: () => void
  tidy: () => void
  team: () => void
  chat: () => void
  show: () => void
}

export function frameMenu(t: FrameMenuInfo, a: FrameMenuActions): MenuEntry[] {
  const name = short(t.title, 10)
  const out: MenuEntry[] = [
    { id: 'frame-show', label: `把「${name}」放进屏幕`, icon: ic(Maximize), run: a.show },
    { id: 'frame-select', label: '选中里面所有 AI', icon: ic(UsersRound), disabled: t.cards > 0 ? false : '这个框里没有 AI', run: a.select },
    { id: 'frame-tidy', label: '把里面的卡片排整齐', icon: ic(LayoutGrid), disabled: t.cards > 1 ? false : '不到两张卡片，不用排', run: a.tidy }
  ]
  if (t.hasTeam) out.push({ id: 'frame-team', label: '分工（主脑、子代理、团队模板）…', icon: ic(UsersRound), run: a.team })
  if (t.hasChat) out.push({ id: 'frame-chat', label: '打开这个项目的群聊', icon: ic(MessageSquare), run: a.chat })
  return out
}

// ───── 便签、小窗、线 ─────

export function noteMenu(a: { edit: () => void; remove: () => void }): MenuEntry[] {
  return [
    { id: 'note-edit', label: '改字', icon: ic(Pencil), hint: '双击', run: a.edit },
    '-',
    { id: 'note-remove', label: '删掉这张便签', icon: ic(Trash2), danger: true, confirm: '再点一次：删掉这张便签', run: a.remove }
  ]
}

export function widgetMenu(t: { kind: 'terminal' | 'web' | 'file' }, a: { show: () => void; openFile: () => void; remove: () => void }): MenuEntry[] {
  const out: MenuEntry[] = [{ id: 'widget-show', label: '把它放进屏幕', icon: ic(Maximize), run: a.show }]
  if (t.kind === 'file') out.push({ id: 'widget-open', label: '在编辑器里打开', icon: ic(FileCode2), run: a.openFile })
  out.push(
    '-',
    t.kind === 'terminal'
      ? { id: 'widget-remove', label: '从画布上拿掉（终端不关）', icon: ic(X), danger: true, confirm: '再点一次：从画布上拿掉', run: a.remove }
      : { id: 'widget-remove', label: '关掉这个小窗', icon: ic(X), danger: true, confirm: t.kind === 'file' ? '再点一次：关掉（里面没保存的字会丢）' : '再点一次：关掉这个小窗', run: a.remove }
  )
  return out
}

/** 线上的标签：派活的线只能看；接力线可以删 */
export function lineMenu(t: { kind: 'task' | 'relay'; canRemove: boolean }, a: { open: () => void; remove: () => void }): MenuEntry[] {
  const out: MenuEntry[] = [{ id: 'line-open', label: t.kind === 'relay' ? '看这条接力线' : '看这条线上的任务', icon: ic(PanelRight), run: a.open }]
  if (t.kind === 'relay' && t.canRemove) out.push('-', { id: 'line-remove', label: '删掉这条接力线', icon: ic(Trash2), danger: true, confirm: '再点一次：删掉这条接力线', run: a.remove })
  return out
}

// ───── 点到的是什么 ─────

export type CanvasHit =
  | { kind: 'none' }
  | { kind: 'blank'; frame?: string }
  | { kind: 'card'; key: string }
  | { kind: 'frame'; id: string }
  | { kind: 'note'; id: string }
  | { kind: 'widget'; id: string }
  | { kind: 'line'; id: string }
  | { kind: 'task'; task: string }

/** 只用到 closest 的元素（真元素，或者测试里的假元素） */
export interface HitTarget {
  closest(selector: string): { dataset: Record<string, string | undefined> } | null
}

/**
 * 右键点到了画布上的什么。'none' 是不归画布管的地方：浮在上面的面板和按钮条（data-cv-ui）、
 * 正在打字的地方、小窗的内容区（终端有自己的右键粘贴，网页有自己的菜单）——这些地方不弹画布的菜单。
 */
export function hitOf(target: HitTarget | null | undefined): CanvasHit {
  if (!target) return { kind: 'none' }
  if (target.closest('[data-cv-ui]')) return { kind: 'none' }
  const label = target.closest('[data-cv-line-label]')
  if (label) return { kind: 'line', id: label.dataset.cvLineLabel ?? '' }
  if (target.closest('input, textarea, select, webview, [contenteditable="true"], [data-cv-nodrag]')) return { kind: 'none' }
  const widget = target.closest('[data-cv-widget]')
  if (widget) return { kind: 'widget', id: widget.dataset.cvNote ?? '' }
  const note = target.closest('[data-cv-note]')
  if (note) return { kind: 'note', id: note.dataset.cvNote ?? '' }
  const task = target.closest('[data-cv-task]')
  if (task) return { kind: 'task', task: task.dataset.cvTask ?? '' }
  const card = target.closest('[data-cv-card]')
  if (card) return { kind: 'card', key: card.dataset.cvCard ?? '' }
  const head = target.closest('[data-cv-frame-head]')
  if (head) return { kind: 'frame', id: head.dataset.cvFrameHead ?? '' }
  const frame = target.closest('[data-cv-frame]')
  return frame ? { kind: 'blank', frame: frame.dataset.cvFrame } : { kind: 'blank' }
}

/** 框下面「没人接」的任务条 */
export function openTaskMenu(t: { ref: string }, a: { open: () => void }): MenuEntry[] {
  return [{ id: 'task-open', label: `打开任务 ${t.ref}`, icon: ic(PanelRight), run: a.open }]
}
