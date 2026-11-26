// 右栏「活动」按群聊看：只列这个群聊里的 AI（参与讨论的 / 主脑和子代理 / 任务里的 / 工作区成员）
import { describe, expect, it } from 'vitest'
import { canAccess, channelAgents } from '../src/renderer/src/lib/groupChat'
import { panelChannel } from '../src/renderer/src/lib/rightPanel'
import type { Agent, BridgeState, GroupChannelInfo, WorkspaceView } from '../src/core/types'

const agent = (id: string, machineAccess = false): Agent =>
  ({ id, name: id, color: '#fff', token: 't', createdAt: 0, ...(machineAccess ? { machineAccess: true } : {}) }) as Agent
const A = agent('a')
const B = agent('b')
const C = agent('c')

const ch = (id: string, extra: Partial<GroupChannelInfo> = {}): GroupChannelInfo => ({ id, name: id, unread: 0, mentions: 0, lastTs: 0, ...extra })

function stateOf(channels: GroupChannelInfo[], workspaces: Partial<WorkspaceView>[] = [{ id: 'w1', name: 'w1', root: '/w1', exists: true }], taskThreads: GroupChannelInfo[] = []): BridgeState {
  return {
    agents: [A, B, C],
    workspaces: workspaces as WorkspaceView[],
    activeWorkspaceId: 'w1',
    chat: { channels: [ch('general'), ...channels], taskThreads, unread: 0, mentions: 0 }
  } as unknown as BridgeState
}

const ids = (list: Agent[]): string[] => list.map((a) => a.id)

describe('channelAgents', () => {
  it('灵感激荡：没挑过是全部，挑过是参与的', () => {
    expect(ids(channelAgents(stateOf([ch('ws:w1')]), 'ws:w1'))).toEqual(['a', 'b', 'c'])
    expect(ids(channelAgents(stateOf([ch('ws:w1', { partIds: ['c', 'a'] })]), 'ws:w1'))).toEqual(['a', 'c'])
  })

  it('分工明确：主脑加子代理；没挑子代理是全部', () => {
    expect(ids(channelAgents(stateOf([ch('ws:w1', { leadId: 'b', subIds: ['c'] })]), 'ws:w1'))).toEqual(['b', 'c'])
    expect(ids(channelAgents(stateOf([ch('ws:w1', { leadId: 'b' })]), 'ws:w1'))).toEqual(['a', 'b', 'c'])
  })

  it('任务的线：任务里的 AI', () => {
    const t = ch('ws:w1.c_t1', { workspaceId: 'w1', thread: { title: 'T-1', createdAt: 0 }, task: { id: 't1', ref: 'T-1', memberIds: ['b'] } })
    expect(ids(channelAgents(stateOf([ch('ws:w1')], undefined, [t]), 'ws:w1.c_t1'))).toEqual(['b'])
  })

  it('工作区设了成员：名单外的 AI 不在这个群聊里', () => {
    const s = stateOf([ch('ws:w1')], [{ id: 'w1', name: 'w1', root: '/w1', exists: true, members: ['a'] }])
    expect(ids(channelAgents(s, 'ws:w1'))).toEqual(['a'])
    expect(canAccess(B, 'ws:w1', s.workspaces!)).toBe(false)
    expect(canAccess(B, 'general', s.workspaces!)).toBe(true)
  })
})

describe('panelChannel', () => {
  it('群聊页看选中的频道；首页开着会话看它；别的页面看项目的主群聊', () => {
    const s = stateOf([ch('ws:w1', { workspaceId: 'w1' }), ch('ws:w1.c_x', { workspaceId: 'w1', thread: { title: 'x', createdAt: 0 } })])
    expect(panelChannel(s, { section: 'group', navId: 'ws:w1.c_x' })).toBe('ws:w1.c_x')
    expect(panelChannel(s, { section: 'overview', home: { kind: 'channel', channel: 'ws:w1.c_x' } })).toBe('ws:w1.c_x')
    expect(panelChannel(s, { section: 'tasks' })).toBe('ws:w1')
  })
})
