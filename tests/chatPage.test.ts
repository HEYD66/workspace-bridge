// 类 Codex 界面第 2 步：「新会话」页、置顶、全部会话 用到的纯函数
import { describe, expect, it } from 'vitest'
import { newChatKey } from '../src/renderer/src/lib/newChat'
import { allChats, homeId, parseHomeId, projectRows, sameTarget, threadTitleFrom } from '../src/renderer/src/lib/projects'
import type { BridgeState } from '../src/core/types'

const T0 = 1_700_000_000_000
const state = (): BridgeState =>
  ({
    activeWorkspaceId: 'w_b',
    workspaces: [
      { id: 'w_m', name: '整台电脑', root: 'C:/', kind: 'machine', exists: true },
      { id: 'w_a', name: 'alpha', root: 'D:/alpha', exists: true },
      { id: 'w_b', name: 'beta', root: 'D:/beta', exists: true },
      { id: 'w_c', name: 'gamma', root: 'D:/gamma', exists: true }
    ],
    agents: [],
    chat: {
      unread: 3,
      mentions: 0,
      channels: [
        { id: 'general', name: '大厅', unread: 1, mentions: 0, lastTs: T0 + 50 },
        { id: 'ws:w_a', name: 'alpha', workspaceId: 'w_a', unread: 2, mentions: 0, lastTs: T0 + 300 },
        { id: 'ws:w_b', name: 'beta', workspaceId: 'w_b', unread: 0, mentions: 0, lastTs: 0 },
        { id: 'ws:w_a.c_1', name: 'alpha / 登录改版', workspaceId: 'w_a', thread: { title: '登录改版', createdAt: T0 + 400 }, unread: 0, mentions: 0, lastTs: 0 },
        { id: 'ws:w_a.c_2', name: 'alpha / 旧的', workspaceId: 'w_a', thread: { title: '旧的', createdAt: T0 + 10, archived: true }, unread: 0, mentions: 0, lastTs: T0 + 900 }
      ]
    }
  }) as unknown as BridgeState

describe('首页：概览成了首页里的一页', () => {
  it('概览的 id 来回转；什么都没有是「新会话」页', () => {
    expect(homeId({ kind: 'overview' })).toBe('overview')
    expect(parseHomeId('overview')).toEqual({ kind: 'overview' })
    expect(parseHomeId(undefined)).toBeUndefined()
    expect(parseHomeId('overview2')).toBeUndefined()
  })

  it('比较两个目标', () => {
    expect(sameTarget({ kind: 'overview' }, { kind: 'overview' })).toBe(true)
    expect(sameTarget(undefined, { kind: 'overview' })).toBe(false)
    expect(sameTarget({ kind: 'channel', channel: 'a' }, { kind: 'channel', channel: 'a' })).toBe(true)
    expect(sameTarget({ kind: 'channel', channel: 'a' }, { kind: 'channel', channel: 'b' })).toBe(false)
    expect(sameTarget({ kind: 'channel', channel: 'a' }, { kind: 'overview' })).toBe(false)
    expect(sameTarget({ kind: 'task', workspaceId: 'w', taskId: 't' }, { kind: 'task', workspaceId: 'w', taskId: 't' })).toBe(true)
    expect(sameTarget({ kind: 'task', workspaceId: 'w', taskId: 't' }, { kind: 'task', workspaceId: 'w2', taskId: 't' })).toBe(false)
  })
})

describe('置顶的项目', () => {
  it('不置顶：目录按列表顺序，「整台电脑」最后', () => {
    expect(projectRows(state(), {}).map((p) => p.ws.id)).toEqual(['w_a', 'w_b', 'w_c', 'w_m'])
  })

  it('置顶的排最前，它们之间还是原来的顺序；「整台电脑」也能置顶', () => {
    expect(projectRows(state(), {}, new Set(['w_c'])).map((p) => p.ws.id)).toEqual(['w_c', 'w_a', 'w_b', 'w_m'])
    expect(projectRows(state(), {}, new Set(['w_m', 'w_b'])).map((p) => p.ws.id)).toEqual(['w_b', 'w_m', 'w_a', 'w_c'])
    // 置顶了一个已经移出列表的项目：不碍事
    expect(projectRows(state(), {}, new Set(['w_gone'])).map((p) => p.ws.id)).toEqual(['w_a', 'w_b', 'w_c', 'w_m'])
  })
})

describe('侧栏切到「全部会话」', () => {
  it('不分项目按时间列；归档的不列；还没消息的会话按创建时间，没消息的主群聊排最后', () => {
    const list = allChats(state())
    expect(list.map((r) => r.key)).toEqual(['ch:ws:w_a.c_1', 'ch:ws:w_a', 'ch:general', 'ch:ws:w_b'])
    expect(list.map((r) => r.title)).toEqual(['登录改版', '群聊', '大厅', '群聊'])
    expect(list.map((r) => r.project)).toEqual(['alpha', 'alpha', undefined, 'beta'])
    expect(list[1].unread).toBe(2)
    expect(list[3].ts).toBe(0)
  })

  it('任务的线不列；没有群聊数据时是空的', () => {
    const s = state()
    s.chat?.channels.push({ id: 'ws:w_a.c_t9', name: 'alpha / T-9', workspaceId: 'w_a', thread: { title: 'T-9 任务', createdAt: T0 }, task: { id: 't_9', ref: 'T-9', memberIds: [] }, unread: 0, mentions: 0, lastTs: T0 + 999 })
    expect(allChats(s).some((r) => r.key === 'ch:ws:w_a.c_t9')).toBe(false)
    expect(allChats({ agents: [] } as unknown as BridgeState)).toEqual([])
  })
})

describe('「新会话」页：标题取消息的开头', () => {
  it('取第一行有字的；去掉开头的 @名字、井号、引用、列表记号；空白并成一个', () => {
    expect(threadTitleFrom('把登录页改成新样式')).toBe('把登录页改成新样式')
    expect(threadTitleFrom('\n\n  第二行才有字  \n第三行')).toBe('第二行才有字')
    expect(threadTitleFrom('@Alice @Bob 看一下   登录页')).toBe('看一下 登录页')
    expect(threadTitleFrom('## 计划\n- 一')).toBe('计划')
    expect(threadTitleFrom('> 引用的话')).toBe('引用的话')
    expect(threadTitleFrom('- 第一条')).toBe('第一条')
  })

  it('超过 30 个字截断加省略号；按字算，不把表情切成两半', () => {
    const long = '一二三四五六七八九十'.repeat(4)
    const t = threadTitleFrom(long) as string
    expect([...t].length).toBe(30)
    expect(t.endsWith('…')).toBe(true)
    expect(threadTitleFrom('十'.repeat(30))).toBe('十'.repeat(30))
    const emoji = threadTitleFrom('😀'.repeat(40)) as string
    expect([...emoji].length).toBe(30)
    expect(emoji.startsWith('😀'.repeat(29))).toBe(true)
  })

  it('取不出来（空的、只有 @、只有记号）返回 undefined，由主进程起名', () => {
    expect(threadTitleFrom('')).toBeUndefined()
    expect(threadTitleFrom('  \n \n')).toBeUndefined()
    expect(threadTitleFrom('@Alice')).toBeUndefined()
    expect(threadTitleFrom('###')).toBeUndefined()
  })

  it('草稿放在假频道 id 上，每个项目一份，不会和真的频道撞', () => {
    expect(newChatKey('w_a')).toBe('new:w_a')
    expect(newChatKey('w_a')).not.toBe(newChatKey('w_b'))
    expect(newChatKey('w_a').startsWith('ws:')).toBe(false)
  })
})
