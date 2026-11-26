// 定时任务页按工作区分列表的规则：哪些任务出现在当前工作区的列表里、保存时归到哪个工作区。
// 规则只在界面里，错了会有任务「哪个列表都看不见却一直在跑」
import { describe, expect, it } from 'vitest'
import { isStray, ownerForSave, schedulesInWorkspace } from '../src/renderer/src/views/SchedulesView'

const A = { id: 'w_a', kind: undefined }
const B = { id: 'w_b', kind: undefined }
const MACHINE = { id: 'w_machine', kind: 'machine' as const }
const state = (activeWorkspaceId: string | undefined, workspaces = [A, B, MACHINE]) => ({ activeWorkspaceId, workspaces })

const inA = { id: '1', workspaceId: 'w_a' }
const inB = { id: '2', workspaceId: 'w_b' }
const legacy = { id: '3' }
const removed = { id: '4', workspaceId: 'w_gone' }
const onMachine = { id: '5', workspaceId: 'w_machine' }
const all = [inA, inB, legacy, removed, onMachine]

describe('定时任务页：按工作区分列表', () => {
  it('当前工作区的列表 = 属于它的 + 找不到所属工作区的（没归属、工作区已移出、归在切不到的整台电脑上）', () => {
    expect(schedulesInWorkspace(all, state('w_a')).map((x) => x.id)).toEqual(['1', '3', '4', '5'])
    expect(schedulesInWorkspace(all, state('w_b')).map((x) => x.id)).toEqual(['2', '3', '4', '5'])
  })

  it('每个任务至少在一个能切到的工作区的列表里看得到', () => {
    const seen = new Set(['w_a', 'w_b'].flatMap((active) => schedulesInWorkspace(all, state(active)).map((x) => x.id)))
    expect([...seen].sort()).toEqual(['1', '2', '3', '4', '5'])
    // 一个目录工作区都没有（只剩整台电脑）：全都显示
    expect(schedulesInWorkspace(all, state(undefined, [MACHINE])).map((x) => x.id)).toEqual(['1', '2', '3', '4', '5'])
  })

  it('isStray：只有归在现存的目录工作区上才不算', () => {
    expect([inA, inB, legacy, removed, onMachine].map((s) => isStray(s, state('w_a')))).toEqual([false, false, true, true, true])
  })

  it('保存时归到哪：新建的和找不到所属工作区的归当前工作区；已有归属的不动；当前是整台电脑或没有工作区时不归', () => {
    expect(ownerForSave(undefined, state('w_a'))).toBe('w_a')
    expect(ownerForSave(legacy, state('w_b'))).toBe('w_b')
    expect(ownerForSave(removed, state('w_b'))).toBe('w_b')
    expect(ownerForSave(onMachine, state('w_a'))).toBe('w_a')
    expect(ownerForSave(inA, state('w_b'))).toBeUndefined()
    expect(ownerForSave(undefined, state('w_machine'))).toBeUndefined()
    expect(ownerForSave(undefined, state(undefined))).toBeUndefined()
  })
})
