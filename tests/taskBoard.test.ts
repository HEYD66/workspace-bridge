import { describe, expect, it } from 'vitest'
import type { TaskItem } from '../src/core/types'
import { BOARD_COLUMNS, boardOrder, canSwitchTaskScope, taskBoardWorkspace } from '../src/renderer/src/views/TaskBoard'

const t = (id: string, priority: TaskItem['priority'], updatedAt: number) => ({ id, priority, updatedAt }) as TaskItem

describe('任务看板', () => {
  it('五个状态列都有，按生命周期从左到右', () => {
    expect(BOARD_COLUMNS).toEqual(['todo', 'in_progress', 'blocked', 'review', 'done'])
  })
  it('列内排序：高优先在前，同优先级新的在前', () => {
    const list = [t('a', 'low', 5), t('b', 'normal', 1), t('c', 'high', 2), t('d', 'normal', 9)].sort(boardOrder)
    expect(list.map((x) => x.id)).toEqual(['c', 'd', 'b', 'a'])
  })
})

describe('任务页看哪个任务板（当前工作区 / 整台电脑）', () => {
  const A = { id: 'w_a' }
  const MACHINE = { id: 'w_machine', kind: 'machine' }
  const st = (activeWorkspaceId: string | undefined, workspaces: { id: string; kind?: string }[] = [A, MACHINE]) => ({ activeWorkspaceId, workspaces })

  it('默认看当前工作区（不用指定工作区）；选了整台电脑才带上它的 id', () => {
    expect(taskBoardWorkspace('active', st('w_a'))).toBeUndefined()
    expect(taskBoardWorkspace('machine', st('w_a'))).toBe('w_machine')
    expect(canSwitchTaskScope(st('w_a'))).toBe(true)
  })

  it('一个目录工作区都没有：只有整台电脑的任务板可看，不显示切换', () => {
    expect(taskBoardWorkspace('active', st(undefined, [MACHINE]))).toBe('w_machine')
    expect(taskBoardWorkspace('machine', st(undefined, [MACHINE]))).toBe('w_machine')
    expect(canSwitchTaskScope(st(undefined, [MACHINE]))).toBe(false)
  })

  it('当前工作区已经是整台电脑：就按当前工作区看，不重复指定，也不显示切换', () => {
    expect(taskBoardWorkspace('machine', st('w_machine'))).toBeUndefined()
    expect(taskBoardWorkspace('active', st('w_machine'))).toBeUndefined()
    expect(canSwitchTaskScope(st('w_machine'))).toBe(false)
  })

  it('列表里没有整台电脑：只能看当前工作区', () => {
    expect(taskBoardWorkspace('machine', st('w_a', [A]))).toBeUndefined()
    expect(canSwitchTaskScope(st('w_a', [A]))).toBe(false)
  })
})
