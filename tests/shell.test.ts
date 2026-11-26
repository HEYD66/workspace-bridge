import { describe, expect, it } from 'vitest'
import { SECTIONS } from '../src/renderer/src/lib/nav'
import { isSettingsSection, RAIL_DIVIDER_AFTER, RAIL_SECTIONS, railSections, SETTINGS_GROUPS, SETTINGS_SECTIONS, splitLabel } from '../src/renderer/src/lib/shell'

describe('外壳：图标栏和齿轮菜单', () => {
  it('每个分区都有地方去：图标栏、齿轮菜单，只有单独的「群聊」页两边都不在；不重', () => {
    const all = [...RAIL_SECTIONS, ...SETTINGS_SECTIONS]
    expect(new Set(all).size).toBe(all.length)
    expect([...all, 'group'].sort()).toEqual([...SECTIONS].sort())
  })

  it('图标栏：原来的三个，然后是从「更多」里拿出来的五个干活用的页面，中间一条线', () => {
    expect(RAIL_SECTIONS).toEqual(['overview', 'canvas', 'tasks', 'schedules', 'chat', 'files', 'search', 'changes', 'commands'])
    expect(RAIL_DIVIDER_AFTER).toBe('schedules')
    expect(RAIL_SECTIONS).toContain(RAIL_DIVIDER_AFTER)
  })

  it('齿轮菜单：设置在最上面，然后是团队、记忆、技能，再是工具试用、审计日志', () => {
    expect(SETTINGS_GROUPS).toEqual([['settings'], ['team', 'memory', 'skills'], ['playground', 'audit']])
    expect(SETTINGS_SECTIONS).toEqual(['settings', 'team', 'memory', 'skills', 'playground', 'audit'])
    for (const s of SETTINGS_SECTIONS) expect(isSettingsSection(s)).toBe(true)
    for (const s of RAIL_SECTIONS) expect(isSettingsSection(s)).toBe(false)
    expect(isSettingsSection('group')).toBe(false)
  })

  it('正在看栏上的页面或齿轮菜单里的页面，图标栏不变；看单独的「群聊」页时把它临时加在后面', () => {
    expect(railSections('overview')).toEqual([...RAIL_SECTIONS])
    expect(railSections('commands')).toEqual([...RAIL_SECTIONS])
    expect(railSections('settings')).toEqual([...RAIL_SECTIONS])
    expect(railSections('audit')).toEqual([...RAIL_SECTIONS])
    expect(railSections('group')).toEqual([...RAIL_SECTIONS, 'group'])
  })

  it('标签里的括号说明拆成右边的小字', () => {
    expect(splitLabel('文件（Ctrl+Shift+E）')).toEqual({ text: '文件', hint: 'Ctrl+Shift+E' })
    expect(splitLabel('群聊')).toEqual({ text: '群聊' })
    expect(splitLabel('首页（项目、最近、概览）')).toEqual({ text: '首页', hint: '项目、最近、概览' })
  })
})
