// 即时说明层：整个应用挂一个（main.tsx）。鼠标移到 TIP_SCOPE（顶栏、右栏）里带 title 的东西上，马上在旁边显示说明。
// 做法：悬停期间把那个元素的 title 临时换成空（系统那个慢的提示就不出了），移开后原样放回去；
// React 在悬停期间改了 title（比如「收起」变「展开」）会被盯到，放回去的是新的。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { placeTip, pointerMoved, TIP_SCOPE, tipText, type Point } from '../lib/tips'

interface Held {
  el: Element
  /** 悬停前（或悬停期间 React 新写的）title；null = 现在没有 title */
  saved: string | null
  obs: MutationObserver
}

export function InstantTips() {
  const [shown, setShown] = useState<{ el: Element; text: string } | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let held: Held | null = null
    let last: Point | null = null
    /** 点过之后先不显示，等鼠标移开再移回来（和系统提示一样） */
    let quiet = false

    const release = (): void => {
      const h = held
      if (!h) return
      held = null
      quiet = false
      h.obs.disconnect()
      // 还是我们换上去的空 title：放回原来的；React 中途去掉了 title 的就不放
      if (h.el.getAttribute('title') === '' && h.saved !== null) h.el.setAttribute('title', h.saved)
      else if (h.el.getAttribute('title') === '' && h.saved === null) h.el.removeAttribute('title')
      setShown(null)
      setPos(null)
    }

    const take = (el: Element): void => {
      if (held?.el === el) return
      release()
      const text = tipText(el.getAttribute('title'))
      if (!text) return
      const obs = new MutationObserver(() => {
        if (held?.el !== el) return
        const now = el.getAttribute('title')
        if (now === '') return // 我们自己换的
        held.saved = now
        const next = tipText(now)
        if (now !== null) el.setAttribute('title', '')
        if (next && !quiet) setShown({ el, text: next })
        else setShown(null)
      })
      held = { el, saved: el.getAttribute('title'), obs }
      el.setAttribute('title', '')
      obs.observe(el, { attributes: true, attributeFilter: ['title'] })
      setShown({ el, text })
    }

    const candidate = (target: EventTarget | null): Element | null => {
      if (!(target instanceof Element)) return null
      const el = target.closest('[title]')
      return el && el.closest(TIP_SCOPE) ? el : null
    }

    const onPointer = (e: PointerEvent): void => {
      if (e.pointerType && e.pointerType !== 'mouse') return
      const cur = { x: e.screenX, y: e.screenY }
      const moved = pointerMoved(last, cur)
      last = cur
      if (held && !held.el.isConnected) release()
      const el = candidate(e.target)
      if (!el) return release()
      if (held?.el === el) return
      // 鼠标没真的动（窗口出现在不动的鼠标下面）：不出说明，也不碰 title
      if (moved) take(el)
    }
    const onOut = (e: PointerEvent): void => {
      // 移出了窗口，或者移进了内嵌的网页：之后收不到「移上来」，这里就收起
      if (!e.relatedTarget) release()
    }
    const hush = (): void => {
      if (!held) return
      quiet = true
      setShown(null)
    }
    const drop = (): void => release()

    document.addEventListener('pointerover', onPointer, true)
    document.addEventListener('pointermove', onPointer, true)
    document.addEventListener('pointerout', onOut, true)
    document.addEventListener('pointerdown', hush, true)
    document.addEventListener('keydown', hush, true)
    document.addEventListener('scroll', drop, true)
    window.addEventListener('blur', drop)
    return () => {
      release()
      document.removeEventListener('pointerover', onPointer, true)
      document.removeEventListener('pointermove', onPointer, true)
      document.removeEventListener('pointerout', onOut, true)
      document.removeEventListener('pointerdown', hush, true)
      document.removeEventListener('keydown', hush, true)
      document.removeEventListener('scroll', drop, true)
      window.removeEventListener('blur', drop)
    }
  }, [])

  // 先不可见地画出来量大小，再放到位置上
  useLayoutEffect(() => {
    if (!shown || !box.current) return
    const a = shown.el.getBoundingClientRect()
    const b = box.current.getBoundingClientRect()
    const p = placeTip({ left: a.left, top: a.top, width: a.width, height: a.height }, { width: b.width, height: b.height }, { width: window.innerWidth, height: window.innerHeight })
    setPos({ left: p.left, top: p.top })
  }, [shown])

  if (!shown) return null
  return createPortal(
    <div
      ref={box}
      role="tooltip"
      data-instant-tip
      className="pointer-events-none fixed z-[200] max-w-[320px] rounded-md border border-line bg-raised px-2 py-1 text-[11.5px] leading-snug break-words whitespace-pre-line text-fg shadow-lg"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {shown.text}
    </div>,
    document.body
  )
}
