// 通用右键菜单的纯逻辑：菜单项、键盘移动、贴着窗口边放、危险操作二次确认（组件在 components/ContextMenu.tsx）
import type { ReactNode } from 'react'

export interface MenuAction {
  id: string
  label: string
  icon?: ReactNode
  /** 不适用时变灰（不隐藏）；写成字符串就是变灰的原因，鼠标停上去能看到 */
  disabled?: boolean | string
  /** 危险操作：红字 */
  danger?: boolean
  /** 二次确认：第一次点只把这一项换成这段文字，再点一次才执行 */
  confirm?: string
  /** 右侧的提示，比如快捷键 */
  hint?: string
  run: () => void | Promise<void>
}

/** '-' 是分隔线 */
export type MenuEntry = MenuAction | '-'

export const isAction = (e: MenuEntry | undefined): e is MenuAction => !!e && e !== '-'

export const isEnabled = (e: MenuEntry | undefined): e is MenuAction => isAction(e) && !e.disabled

/** 变灰的原因（没写原因返回 undefined） */
export function disabledReason(a: MenuAction): string | undefined {
  return typeof a.disabled === 'string' ? a.disabled : undefined
}

/** 去掉开头、结尾和连着的分隔线 */
export function tidyEntries(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = []
  for (const e of entries) {
    if (e === '-' && (out.length === 0 || out[out.length - 1] === '-')) continue
    out.push(e)
  }
  while (out[out.length - 1] === '-') out.pop()
  return out
}

/** 上下键：从 from 往 dir 方向找下一个能点的项，到头绕回来；分隔线和变灰的跳过。一个能点的都没有返回 -1 */
export function moveIndex(entries: MenuEntry[], from: number, dir: 1 | -1): number {
  const n = entries.length
  if (n === 0) return -1
  // from 是 -1（还没选）时，往下从第一项开始找，往上从最后一项开始找
  let i = from < 0 ? (dir === 1 ? -1 : n) : from
  for (let step = 0; step < n; step++) {
    i = (((i + dir) % n) + n) % n
    if (isEnabled(entries[i])) return i
  }
  return -1
}

/** Home / End：第一个或最后一个能点的项 */
export function edgeIndex(entries: MenuEntry[], which: 'first' | 'last'): number {
  return which === 'first' ? moveIndex(entries, -1, 1) : moveIndex(entries, -1, -1)
}

/**
 * 菜单放在哪：默认左上角在鼠标处；右边放不下就翻到鼠标左边，下面放不下就翻到上面；
 * 翻过去还放不下（菜单比窗口还大）就贴着窗口边，左上角永远在窗口里
 */
export function clampPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewWidth: number,
  viewHeight: number,
  margin = 4
): { left: number; top: number } {
  const place = (p: number, size: number, view: number) => {
    let v = p + size + margin > view ? p - size : p
    v = Math.min(v, view - size - margin)
    return Math.max(margin, v)
  }
  return { left: place(x, width, viewWidth), top: place(y, height, viewHeight) }
}

/**
 * 按下一项（点击或 Enter）该做什么：
 * - ignore：变灰的项，什么都不做，菜单也不关
 * - confirm：要二次确认、还没确认过，把这一项换成确认文字
 * - run：关菜单并执行
 */
export function pressAction(a: MenuAction, confirming: string | undefined): 'ignore' | 'confirm' | 'run' {
  if (a.disabled) return 'ignore'
  if (a.confirm && confirming !== a.id) return 'confirm'
  return 'run'
}
