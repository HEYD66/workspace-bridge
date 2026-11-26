// 即时说明：鼠标移到按钮上马上出来（系统自带的 title 提示要等一秒左右）。
// 纯逻辑在这里（tests/tips.test.ts），界面在 components/InstantTips.tsx

/** 哪些地方的说明要马上出来：顶栏和右栏。别处还是系统自带的 title */
export const TIP_SCOPE = 'header.app-titlebar, [data-right-panel]'

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** 说明放哪：默认在按钮正下方居中；下面放不下就放上面；左右不出窗口 */
export function placeTip(anchor: Box, tip: { width: number; height: number }, view: { width: number; height: number }, gap = 6, margin = 6): { left: number; top: number; above: boolean } {
  const maxLeft = Math.max(margin, view.width - tip.width - margin)
  const left = Math.min(Math.max(margin, anchor.left + anchor.width / 2 - tip.width / 2), maxLeft)
  const below = anchor.top + anchor.height + gap
  const aboveTop = anchor.top - gap - tip.height
  const above = below + tip.height + margin > view.height && aboveTop >= margin
  return { left: Math.round(left), top: Math.round(above ? aboveTop : below), above }
}

export interface Point {
  x: number
  y: number
}

/**
 * 鼠标是不是真的动了。窗口出现在一动不动的鼠标下面时，浏览器也会补发「移上来」的事件，位置和上一次一样；
 * 这种不算，不出说明、也不去动按钮的 title（验收脚本按 title 找按钮，鼠标碰巧停在测试窗口上不能影响它）。
 * 第一次看到鼠标（还没有上一个位置）也不算
 */
export function pointerMoved(prev: Point | null, cur: Point): boolean {
  return prev !== null && (prev.x !== cur.x || prev.y !== cur.y)
}

/** 说明文字：前后空白去掉；空的不显示 */
export function tipText(title: string | null | undefined): string | null {
  const t = (title ?? '').trim()
  return t ? t : null
}
