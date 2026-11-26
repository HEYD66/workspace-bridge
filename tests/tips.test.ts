import { describe, expect, it } from 'vitest'
import { placeTip, pointerMoved, TIP_SCOPE, tipText } from '../src/renderer/src/lib/tips'

describe('即时说明：放在哪', () => {
  const view = { width: 1000, height: 600 }
  const tip = { width: 120, height: 24 }

  it('默认在按钮正下方居中', () => {
    const p = placeTip({ left: 400, top: 10, width: 24, height: 24 }, tip, view)
    expect(p).toEqual({ left: 352, top: 40, above: false })
  })

  it('靠右的按钮：说明不出窗口右边', () => {
    const p = placeTip({ left: 980, top: 10, width: 16, height: 24 }, tip, view)
    expect(p.left).toBe(1000 - 120 - 6)
    expect(p.above).toBe(false)
  })

  it('靠左的按钮：说明不出窗口左边', () => {
    const p = placeTip({ left: 0, top: 10, width: 16, height: 24 }, tip, view)
    expect(p.left).toBe(6)
  })

  it('下面放不下就放上面', () => {
    const p = placeTip({ left: 400, top: 570, width: 24, height: 24 }, tip, view)
    expect(p).toEqual({ left: 352, top: 570 - 6 - 24, above: true })
  })

  it('上面下面都放不下：还是放下面（不会算出负的位置）', () => {
    const p = placeTip({ left: 400, top: 5, width: 24, height: 24 }, { width: 120, height: 590 }, view)
    expect(p.above).toBe(false)
    expect(p.top).toBe(35)
  })

  it('说明比窗口还宽：贴着左边', () => {
    const p = placeTip({ left: 50, top: 10, width: 24, height: 24 }, { width: 1200, height: 24 }, view)
    expect(p.left).toBe(6)
  })
})

describe('即时说明：什么时候出', () => {
  it('第一次看到鼠标不算动了', () => {
    expect(pointerMoved(null, { x: 10, y: 10 })).toBe(false)
  })

  it('位置和上次一样不算动了（窗口出现在不动的鼠标下面）', () => {
    expect(pointerMoved({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(false)
  })

  it('位置变了才算', () => {
    expect(pointerMoved({ x: 10, y: 10 }, { x: 11, y: 10 })).toBe(true)
    expect(pointerMoved({ x: 10, y: 10 }, { x: 10, y: 9 })).toBe(true)
  })

  it('空的说明不显示，前后空白去掉，多行的留着', () => {
    expect(tipText(null)).toBeNull()
    expect(tipText(undefined)).toBeNull()
    expect(tipText('')).toBeNull()
    expect(tipText('   ')).toBeNull()
    expect(tipText(' 收起右栏 ')).toBe('收起右栏')
    expect(tipText('标题\nhttp://example.com')).toBe('标题\nhttp://example.com')
  })

  it('只管顶栏和右栏', () => {
    expect(TIP_SCOPE).toContain('header.app-titlebar')
    expect(TIP_SCOPE).toContain('[data-right-panel]')
  })
})
