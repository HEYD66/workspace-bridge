// 工作台的任务页看「整台电脑」的任务板：工作台切不到整台电脑，所以任务相关的操作可以指定工作区。
// 不指定时还是当前工作区；两个任务板各编各的号（都有 T-1），不能串
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { MACHINE_WORKSPACE_ID } from '../src/core/config'

let base: string
let bridge: Bridge
let wsId: string
let notices: { agentId: string; text: string; workspaceId?: string }[]
let changed: (string | undefined)[]

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mboard-'))
  const root = path.join(base, 'proj')
  fs.mkdirSync(root, { recursive: true })
  bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'skills'), scheduler: { timers: false } })
  wsId = bridge.getState().activeWorkspaceId!
  notices = []
  changed = []
  bridge.on('notice', (agentId: string, text: string, workspaceId?: string) => notices.push({ agentId, text, workspaceId }))
  bridge.on('changed', (kind: string, workspaceId?: string) => kind === 'tasks' && changed.push(workspaceId))
})

afterEach(async () => {
  await bridge.stop()
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

describe('任务页看「整台电脑」的任务板', () => {
  it('不用切换当前工作区就能看、建、改、派、审、删整台电脑的任务；当前工作区的任务板不受影响', () => {
    const mine = bridge.createTask({ title: '目录里的任务' })
    const t = bridge.createTask({ title: '清理下载目录' }, MACHINE_WORKSPACE_ID)
    // 两个任务板各编各的号
    expect([mine.ref, t.ref]).toEqual(['T-1', 'T-1'])
    expect(bridge.listTasks().map((x) => x.title)).toEqual(['目录里的任务'])
    expect(bridge.listTasks(MACHINE_WORKSPACE_ID).map((x) => x.title)).toEqual(['清理下载目录'])
    expect(bridge.getState().activeWorkspaceId).toBe(wsId)
    // 界面靠这个通知刷新，带的是整台电脑的 id
    expect(changed).toContain(MACHINE_WORKSPACE_ID)

    expect(bridge.editTask(t.id, { description: '只删 30 天前的' }, MACHINE_WORKSPACE_ID).description).toBe('只删 30 天前的')
    expect(bridge.setTaskStatus(t.id, 'review', '看一下', MACHINE_WORKSPACE_ID).status).toBe('review')
    expect(bridge.reviewTask(t.id, 'reject', '还有没删的', MACHINE_WORKSPACE_ID).status).not.toBe('review')
    expect(bridge.setTaskStatus(t.id, 'blocked', undefined, MACHINE_WORKSPACE_ID).status).toBe('blocked')
    // 自始至终没动当前工作区的那个 T-1
    expect(bridge.listTasks()).toEqual([expect.objectContaining({ id: mine.id, status: 'todo', description: '' })])

    bridge.deleteTask(t.id, MACHINE_WORKSPACE_ID)
    expect(bridge.listTasks(MACHINE_WORKSPACE_ID)).toEqual([])
    expect(bridge.listTasks()).toHaveLength(1)
  })

  it('不指定工作区时找不到整台电脑的任务（不会操作到另一个任务板上）', () => {
    const t = bridge.createTask({ title: '整机的' }, MACHINE_WORKSPACE_ID)
    expect(() => bridge.setTaskStatus(t.id, 'done')).toThrow()
    expect(() => bridge.deleteTask(t.id)).toThrow()
    expect(bridge.listTasks(MACHINE_WORKSPACE_ID)).toEqual([expect.objectContaining({ id: t.id, status: 'todo' })])
  })

  it('派给开了「整台电脑」的 AI：它收到通知；没开的 AI 收不到', () => {
    const maya = bridge.createAgent('Maya', undefined, true)
    const arena = bridge.createAgent('Arena')
    const t = bridge.createTask({ title: '看一眼磁盘', assigneeId: maya.id }, MACHINE_WORKSPACE_ID)
    // 用户派的：AI 做完直接完成，不用审查
    expect(t.managedBy).toBe('user')
    expect(notices).toEqual([expect.objectContaining({ agentId: maya.id, workspaceId: MACHINE_WORKSPACE_ID, text: expect.stringContaining('看一眼磁盘') })])
    bridge.assignTask(t.id, arena.id, MACHINE_WORKSPACE_ID)
    expect(notices.filter((n) => n.agentId === arena.id)).toEqual([])
    expect(bridge.listTasks(MACHINE_WORKSPACE_ID)[0].assigneeId).toBe(arena.id)
  })

  it('工作区不存在：列表是空的，其他操作报错', () => {
    expect(bridge.listTasks('w_00000000')).toEqual([])
    expect(() => bridge.createTask({ title: 'x' }, 'w_00000000')).toThrow('工作区不存在')
    expect(() => bridge.deleteTask('whatever', 'w_00000000')).toThrow('工作区不存在')
  })
})
