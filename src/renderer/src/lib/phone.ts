// 手机版：用手机从远端链接打开时，一次只看一栏，导航放到底部。纯逻辑在这里（tests/phone.test.ts），界面在 App.tsx
import type { Section } from './nav'

/** 手动指定：'1' 一定用手机版（验收脚本用），'0' 一定用电脑版（在「更多」里选的），没有就自动判断 */
export const PHONE_KEY = 'wb.layout.phone'
/** 屏幕短边不超过这么多（CSS 像素）才算手机；平板还是电脑版 */
export const PHONE_MAX = 760
/** 电脑版排版要的宽度：手机 / 平板上看电脑版时，按这个宽度画再整体缩小 */
export const DESKTOP_WIDTH = 1100

/** 这块屏幕是不是手机（从远端链接打开、屏幕够小） */
export function isPhoneScreen(env: { remote: boolean; screenW: number; screenH: number }): boolean {
  return env.remote && Math.min(env.screenW, env.screenH) <= PHONE_MAX
}

/** 现在用不用手机版：手动指定的优先，否则看屏幕 */
export function wantsPhoneLayout(env: { remote: boolean; screenW: number; screenH: number; override: string | null }): boolean {
  if (env.override === '1') return true
  if (env.override === '0') return false
  return isPhoneScreen(env)
}

/**
 * 这个元素现在是不是在「没有鼠标悬停」的环境里：手机版外壳里，或者设备本身不支持悬停（平板、手机上看电脑版）。
 * 靠悬停才出来的东西，在这种环境里要换成点一下出来
 */
export function noHover(el: Element): boolean {
  if (el.closest('[data-phone-shell]')) return true
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(hover: none)').matches
}

/** 手机版里的四个底部标签 */
export type PhoneTab = 'chats' | 'tasks' | 'activity' | 'more'
/** 手机版正在看什么：main 是某个页面（列表或点进去的内容），其余是手机版自己的页 */
export type PhoneView = 'main' | 'activity' | 'more' | 'panel'

/** 手机版排过的页面：左边的列表和右边的内容各占一屏，点进去、返回 */
export const PHONE_SECTIONS: readonly Section[] = ['overview', 'tasks', 'chat', 'changes', 'commands', 'schedules']
/** 「更多」里列的页面，按这个顺序；不在 PHONE_SECTIONS 里的点进去是电脑版样子 */
export const PHONE_MORE: readonly Section[] = ['canvas', 'chat', 'changes', 'commands', 'schedules', 'files', 'search', 'settings', 'team', 'memory', 'skills', 'playground', 'audit']

export const isPhoneSection = (s: Section): boolean => PHONE_SECTIONS.includes(s)

/** 这一刻画手机版的外壳，还是电脑版的（手机上点进没排过的页面时是后者） */
export function phoneShell(phone: boolean, section: Section, view: PhoneView): boolean {
  return phone && (view !== 'main' || isPhoneSection(section))
}

/** 底部哪个标签亮着 */
export function phoneTab(section: Section, view: PhoneView): PhoneTab {
  if (view === 'activity') return 'activity'
  if (view === 'more') return 'more'
  if (section === 'tasks') return 'tasks'
  if (section === 'overview') return 'chats'
  return 'more'
}

/**
 * 页面的 viewport 声明。手机版：按手机宽度排；从远端打开、屏幕比电脑版要的宽度窄（手机上看电脑版、平板）：
 * 按电脑版的宽度画再整体缩小——不声明的话手机浏览器也是这么干的，只是宽度由它定；其余（电脑上的窗口、够宽的屏幕）：按实际宽度
 */
export function viewportContent(o: { shell: boolean; remote: boolean; screenW: number }): string {
  if (o.shell) return 'width=device-width, initial-scale=1, viewport-fit=cover'
  if (o.remote && o.screenW < DESKTOP_WIDTH) return `width=${DESKTOP_WIDTH}`
  return 'width=device-width, initial-scale=1'
}

/** 把 viewport 声明写到页面上（没有就建一个） */
export function applyViewport(content: string): void {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.name = 'viewport'
    document.head.appendChild(meta)
  }
  if (meta.content !== content) meta.content = content
}
