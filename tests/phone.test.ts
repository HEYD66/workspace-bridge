import { describe, expect, it } from 'vitest'
import { SECTIONS } from '../src/renderer/src/lib/nav'
import { DESKTOP_WIDTH, isPhoneScreen, isPhoneSection, noHover, PHONE_MORE, PHONE_SECTIONS, phoneShell, phoneTab, wantsPhoneLayout, viewportContent } from '../src/renderer/src/lib/phone'

describe('手机版', () => {
  it('没有鼠标悬停的地方（手机版外壳里）：点一下消息才出按钮；电脑版里不算', () => {
    const inShell = { closest: (sel: string) => (sel === '[data-phone-shell]' ? {} : null) } as unknown as Element
    const onDesktop = { closest: () => null } as unknown as Element
    expect(noHover(inShell)).toBe(true)
    expect(noHover(onDesktop)).toBe(false)
  })

  it('从远端打开、屏幕短边不超过 760 才算手机；电脑上的窗口、平板都不算', () => {
    expect(isPhoneScreen({ remote: true, screenW: 412, screenH: 915 })).toBe(true)
    expect(isPhoneScreen({ remote: true, screenW: 915, screenH: 412 })).toBe(true)
    expect(isPhoneScreen({ remote: true, screenW: 820, screenH: 1180 })).toBe(false)
    expect(isPhoneScreen({ remote: false, screenW: 412, screenH: 915 })).toBe(false)
    expect(isPhoneScreen({ remote: true, screenW: 760, screenH: 1000 })).toBe(true)
  })

  it('手动指定的优先：1 一定手机版，0 一定电脑版，别的值当没指定', () => {
    const phone = { remote: true, screenW: 412, screenH: 915 }
    const desk = { remote: false, screenW: 1920, screenH: 1080 }
    expect(wantsPhoneLayout({ ...desk, override: '1' })).toBe(true)
    expect(wantsPhoneLayout({ ...phone, override: '0' })).toBe(false)
    expect(wantsPhoneLayout({ ...phone, override: null })).toBe(true)
    expect(wantsPhoneLayout({ ...desk, override: null })).toBe(false)
    expect(wantsPhoneLayout({ ...phone, override: 'x' })).toBe(true)
  })

  it('排过的页面：会话、任务、对话、改动、AI 命令、定时任务；「更多」里列的都是真有的页面，不含会话和任务', () => {
    expect(PHONE_SECTIONS).toEqual(['overview', 'tasks', 'chat', 'changes', 'commands', 'schedules'])
    for (const s of [...PHONE_SECTIONS, ...PHONE_MORE]) expect(SECTIONS).toContain(s)
    expect(PHONE_MORE).not.toContain('overview')
    expect(PHONE_MORE).not.toContain('tasks')
    expect(new Set(PHONE_MORE).size).toBe(PHONE_MORE.length)
    expect(isPhoneSection('chat')).toBe(true)
    expect(isPhoneSection('settings')).toBe(false)
  })

  it('画哪个外壳：手机上看排过的页面、活动、更多、右栏那一页是手机版；点进没排过的页面是电脑版；不是手机永远电脑版', () => {
    expect(phoneShell(true, 'overview', 'main')).toBe(true)
    expect(phoneShell(true, 'schedules', 'main')).toBe(true)
    expect(phoneShell(true, 'settings', 'main')).toBe(false)
    expect(phoneShell(true, 'settings', 'more')).toBe(true)
    expect(phoneShell(true, 'files', 'activity')).toBe(true)
    expect(phoneShell(true, 'overview', 'panel')).toBe(true)
    expect(phoneShell(false, 'overview', 'main')).toBe(false)
    expect(phoneShell(false, 'overview', 'more')).toBe(false)
  })

  it('底部哪个标签亮：活动和更多看的是手机版自己的页；会话、任务看分区；别的页面算在「更多」里', () => {
    expect(phoneTab('overview', 'main')).toBe('chats')
    expect(phoneTab('overview', 'panel')).toBe('chats')
    expect(phoneTab('tasks', 'main')).toBe('tasks')
    expect(phoneTab('tasks', 'activity')).toBe('activity')
    expect(phoneTab('overview', 'more')).toBe('more')
    expect(phoneTab('chat', 'main')).toBe('more')
    expect(phoneTab('commands', 'main')).toBe('more')
  })

  it('viewport：手机版按手机宽度；远端的小屏看电脑版按 1100 画再缩小；电脑上的窗口和够宽的屏幕按实际宽度', () => {
    expect(viewportContent({ shell: true, remote: true, screenW: 412 })).toBe('width=device-width, initial-scale=1, viewport-fit=cover')
    expect(viewportContent({ shell: false, remote: true, screenW: 412 })).toBe(`width=${DESKTOP_WIDTH}`)
    expect(viewportContent({ shell: false, remote: true, screenW: 820 })).toBe('width=1100')
    expect(viewportContent({ shell: false, remote: true, screenW: 1280 })).toBe('width=device-width, initial-scale=1')
    expect(viewportContent({ shell: false, remote: false, screenW: 412 })).toBe('width=device-width, initial-scale=1')
  })
})
