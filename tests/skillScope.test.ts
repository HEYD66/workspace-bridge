// 技能页看哪个工作区的技能、下拉框里能选哪些工作区（界面用的纯函数）
import { beforeEach, describe, expect, it } from 'vitest'
import { getSkillWorkspace, setSkillWorkspace, skillViewWorkspace, skillWorkspaceOptions } from '../src/renderer/src/lib/skillScope'

const A = { id: 'w_a', name: '甲', exists: true }
const B = { id: 'w_b', name: '乙', exists: true }
const GONE = { id: 'w_gone', name: '丢了', exists: false }
const MACHINE = { id: 'w_machine', name: '整台电脑', kind: 'machine', exists: true }
const state = { activeWorkspaceId: 'w_a', workspaces: [A, B, GONE, MACHINE] }

beforeEach(() => setSkillWorkspace(undefined))

describe('技能页看哪个工作区', () => {
  it('没选、或选的就是当前工作区：看当前工作区（接口不用带工作区）', () => {
    expect(skillViewWorkspace(undefined, state)).toBeUndefined()
    expect(skillViewWorkspace('w_a', state)).toBeUndefined()
  })

  it('选了别的工作区或整台电脑：带上它的 id，当前工作区不变', () => {
    expect(skillViewWorkspace('w_b', state)).toBe('w_b')
    expect(skillViewWorkspace('w_machine', state)).toBe('w_machine')
  })

  it('选的工作区被移出了、或目录不在了：退回当前工作区', () => {
    expect(skillViewWorkspace('w_removed', state)).toBeUndefined()
    expect(skillViewWorkspace('w_gone', state)).toBeUndefined()
  })

  it('一个目录工作区都没有时也能选整台电脑（装在那里的技能照样能看、能停用）', () => {
    expect(skillViewWorkspace('w_machine', { activeWorkspaceId: undefined, workspaces: [MACHINE] })).toBe('w_machine')
  })

  it('选择记在组件外面：活动面板的「在技能页打开」和技能页用的是同一个', () => {
    setSkillWorkspace('w_machine')
    expect(getSkillWorkspace()).toBe('w_machine')
    setSkillWorkspace('')
    expect(getSkillWorkspace()).toBeUndefined()
  })
})

describe('可选的工作区', () => {
  it('列出目录还在的工作区，标出当前的和整台电脑；没有待审阅数（技能不用审阅了）', () => {
    expect(skillWorkspaceOptions(state)).toEqual([
      { id: 'w_a', name: '甲', current: true, machine: false },
      { id: 'w_b', name: '乙', current: false, machine: false },
      { id: 'w_machine', name: '整台电脑', current: false, machine: true }
    ])
  })
})
