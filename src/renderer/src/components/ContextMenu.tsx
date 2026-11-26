// 通用右键菜单：useContextMenu() 拿到 open 和 menu，onContextMenu 里调 open(e, 菜单项)，把 menu 放进渲染结果。
// 键盘：上下键选、Home/End 到头尾、Enter/空格执行、Esc 关闭（确认中先取消确认）、Tab 关闭。
// 点外面、窗口失焦、改窗口大小、滚动都会关掉；关掉后焦点回到打开前的地方。
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { clampPosition, disabledReason, edgeIndex, isAction, moveIndex, pressAction, tidyEntries, type MenuAction, type MenuEntry } from '../lib/contextMenu'
import { cx } from './ui'

export type { MenuAction, MenuEntry }

interface OpenState {
  x: number
  y: number
  entries: MenuEntry[]
  /** 是不是键盘打开的（ContextMenu 键 / Shift+F10）：是的话默认选中第一项 */
  keyboard: boolean
  /** 打开前的焦点，关掉后还回去 */
  restore: HTMLElement | null
}

/** 能拿到坐标的事件：React 的鼠标事件或原生事件都行 */
interface PointerLike {
  clientX: number
  clientY: number
  currentTarget?: EventTarget | null
  target?: EventTarget | null
  preventDefault?: () => void
  stopPropagation?: () => void
}

export function useContextMenu(): {
  open: (e: PointerLike, entries: MenuEntry[]) => void
  close: () => void
  menu: ReactNode
} {
  const [state, setState] = useState<OpenState | null>(null)

  const open = useCallback((e: PointerLike, entries: MenuEntry[]) => {
    e.preventDefault?.()
    // 里层先处理，免得外层也弹一个
    e.stopPropagation?.()
    const list = tidyEntries(entries)
    if (!list.some(isAction)) return
    let { clientX: x, clientY: y } = e
    // 键盘打开时 Chromium 给的坐标是 0,0：改成贴着触发元素的左下角
    const keyboard = x === 0 && y === 0
    if (keyboard) {
      const el = (e.currentTarget ?? e.target) as Element | null
      const r = el && 'getBoundingClientRect' in el ? el.getBoundingClientRect() : undefined
      if (r) {
        x = r.left + 8
        y = r.top + Math.min(r.height, 24)
      }
    }
    const active = document.activeElement
    setState((cur) => ({ x, y, entries: list, keyboard, restore: cur?.restore ?? (active instanceof HTMLElement ? active : null) }))
  }, [])

  const close = useCallback(() => setState(null), [])

  const menu = state ? <MenuView key={`${state.x},${state.y},${state.entries.length}`} state={state} onClose={close} /> : null
  return { open, close, menu }
}

function MenuView({ state, onClose }: { state: OpenState; onClose: () => void }) {
  const { entries } = state
  const ref = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(() => (state.keyboard ? edgeIndex(entries, 'first') : -1))
  const [confirming, setConfirming] = useState<string>()
  const [pos, setPos] = useState<{ left: number; top: number }>()

  // 量出菜单大小再定位置，不超出窗口边；确认文字变长时也重新量
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos(clampPosition(state.x, state.y, r.width, r.height, window.innerWidth, window.innerHeight))
  }, [state.x, state.y, confirming])

  // 位置定下来就拿焦点，键盘才能用（定位之前菜单是 visibility:hidden，那时候拿不到焦点，Esc 和方向键就都不灵）
  const placed = pos !== undefined
  useEffect(() => {
    if (placed) ref.current?.focus({ preventScroll: true })
  }, [placed])

  // 关掉时把焦点还回去
  useEffect(() => {
    const restore = state.restore
    return () => {
      if (restore && document.contains(restore)) restore.focus({ preventScroll: true })
    }
  }, [state.restore])

  // 点外面、失焦、改窗口大小、外面滚动都关
  useEffect(() => {
    const inside = (t: EventTarget | null) => t instanceof Node && !!ref.current?.contains(t)
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) onClose()
    }
    const onScroll = (e: Event) => {
      if (!inside(e.target)) onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [onClose])

  const press = (a: MenuAction) => {
    const what = pressAction(a, confirming)
    if (what === 'ignore') return
    if (what === 'confirm') {
      setConfirming(a.id)
      return
    }
    onClose()
    void Promise.resolve()
      .then(a.run)
      .catch((err) => console.error(`菜单项「${a.label}」出错`, err))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const move = (i: number) => {
      e.preventDefault()
      if (i >= 0) setActive(i)
      // 换了项就不再确认上一项
      setConfirming(undefined)
    }
    switch (e.key) {
      case 'ArrowDown':
        return move(moveIndex(entries, active, 1))
      case 'ArrowUp':
        return move(moveIndex(entries, active, -1))
      case 'Home':
        return move(edgeIndex(entries, 'first'))
      case 'End':
        return move(edgeIndex(entries, 'last'))
      case 'Enter':
      case ' ': {
        e.preventDefault()
        const a = entries[active]
        if (isAction(a)) press(a)
        return
      }
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        if (confirming) setConfirming(undefined)
        else onClose()
        return
      case 'Tab':
        e.preventDefault()
        onClose()
        return
    }
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[100] max-h-[calc(100vh-8px)] min-w-[180px] overflow-y-auto rounded-md border border-line bg-panel py-1 text-[12.5px] shadow-xl outline-none"
      style={pos ? { left: pos.left, top: pos.top } : { left: state.x, top: state.y, visibility: 'hidden' }}
    >
      {entries.map((e, i) =>
        e === '-' ? (
          <div key={`sep-${i}`} role="separator" className="my-1 h-px bg-line" />
        ) : (
          <Item key={e.id} a={e} active={i === active} confirming={confirming === e.id} onHover={() => setActive(i)} onPress={() => press(e)} />
        )
      )}
    </div>,
    document.body
  )
}

function Item({ a, active, confirming, onHover, onPress }: { a: MenuAction; active: boolean; confirming: boolean; onHover: () => void; onPress: () => void }) {
  const off = !!a.disabled
  return (
    <div
      role="menuitem"
      aria-disabled={off || undefined}
      title={disabledReason(a)}
      onMouseEnter={onHover}
      onClick={(e) => {
        e.stopPropagation()
        onPress()
      }}
      className={cx(
        'flex items-center gap-2 px-3 py-1 select-none',
        off ? 'cursor-default text-faint opacity-60' : 'cursor-pointer',
        !off && (confirming ? 'bg-bad/20 text-bad' : a.danger ? 'text-bad' : 'text-fg'),
        !off && active && !confirming && 'bg-hover'
      )}
    >
      <span className="flex w-[14px] shrink-0 justify-center text-faint">{a.icon}</span>
      <span className="flex-1 truncate">{confirming ? (a.confirm ?? a.label) : a.label}</span>
      {a.hint && !confirming && <span className="ml-4 shrink-0 text-[11px] text-faint">{a.hint}</span>}
    </div>
  )
}
