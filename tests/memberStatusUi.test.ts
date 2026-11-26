// T-23：AI 细分状态界面的纯逻辑（标签、颜色、说明、悬停详情、任务卡提醒、能力检测）
import { describe, expect, it } from 'vitest'
import {
  assigneeAlert,
  describeMemberStatus,
  formatDuration,
  isBusy,
  MEMBER_STATUS_META,
  memberStatusOf,
  statusText,
  type MemberStatus
} from '../src/renderer/src/lib/memberStatus'

const NOW = 1_800_000_000_000
const min = 60_000
const st = (p: Partial<MemberStatus> & Pick<MemberStatus, 'status'>): MemberStatus => ({ sessions: 1, ...p })

describe('memberStatusOf 能力检测', () => {
  it('工作台没有 memberStatus 时返回 undefined，调用方照原来显示', () => {
    expect(memberStatusOf({}, 'a')).toBeUndefined()
    expect(memberStatusOf({ memberStatus: {} }, 'a')).toBeUndefined()
    expect(memberStatusOf({ memberStatus: { a: st({ status: 'idle' }) } }, undefined)).toBeUndefined()
  })
  it('有就取出来', () => {
    const s = st({ status: 'waiting' })
    expect(memberStatusOf({ memberStatus: { a: s } }, 'a')).toBe(s)
  })
})

describe('formatDuration', () => {
  it('秒、分钟、小时、天', () => {
    expect(formatDuration(-5)).toBe('0 秒')
    expect(formatDuration(42_000)).toBe('42 秒')
    expect(formatDuration(3 * min + 59_000)).toBe('3 分钟')
    expect(formatDuration(60 * min)).toBe('1 小时')
    expect(formatDuration(65 * min)).toBe('1 小时 5 分钟')
    expect(formatDuration(50 * 60 * min)).toBe('2 天')
  })
})

describe('7 种状态的标签和颜色', () => {
  it('每种都有中文标签、颜色和说明，颜色互不相同', () => {
    const kinds = ['working', 'command', 'waiting', 'idle', 'stale', 'offline', 'paused'] as const
    expect(kinds.map((k) => MEMBER_STATUS_META[k].label)).toEqual(['工作中', '执行命令', '等待消息', '空闲', '可能卡住', '离线', '已暂停'])
    expect(new Set(kinds.map((k) => MEMBER_STATUS_META[k].color)).size).toBe(7)
    for (const k of kinds) expect(MEMBER_STATUS_META[k].hint).not.toBe('')
  })
  it('working / command 算忙', () => {
    expect(isBusy(st({ status: 'working' }))).toBe(true)
    expect(isBusy(st({ status: 'command' }))).toBe(true)
    expect(isBusy(st({ status: 'waiting' }))).toBe(false)
    expect(isBusy(st({ status: 'stale' }))).toBe(false)
  })
})

describe('statusText', () => {
  it('working：调用中、刚调完、没有工具名', () => {
    expect(statusText(st({ status: 'working', tool: 'read_file', calling: true }))).toBe('正在读取')
    expect(statusText(st({ status: 'working', tool: 'read_file', calling: false }))).toBe('工作中（刚调完读取）')
    expect(statusText(st({ status: 'working', tool: 'some_new_tool', calling: true }))).toBe('正在some_new_tool')
    expect(statusText(st({ status: 'working' }))).toBe('工作中')
  })
  it('command：前台带工具名，后台带个数', () => {
    expect(statusText(st({ status: 'command', tool: 'run_command', calling: true }))).toMatch(/^执行命令（正在.+）$/)
    expect(statusText(st({ status: 'command', tool: 'run_command', calling: false }))).toMatch(/^执行命令（刚调完.+）$/)
    expect(statusText(st({ status: 'command', background: true, commands: 2 }))).toBe('执行命令（后台 2 个）')
    expect(statusText(st({ status: 'command' }))).toBe('执行命令')
  })
  it('stale 带多久没动静，其余就是标签', () => {
    expect(statusText(st({ status: 'stale', lastSeen: NOW - 12 * min }), NOW)).toBe('可能卡住（12 分钟没有动静）')
    expect(statusText(st({ status: 'stale' }), NOW)).toBe('可能卡住')
    expect(statusText(st({ status: 'waiting' }))).toBe('等待消息')
    expect(statusText(st({ status: 'idle' }))).toBe('空闲')
    expect(statusText(st({ status: 'offline', sessions: 0 }))).toBe('离线')
    expect(statusText(st({ status: 'paused' }))).toBe('已暂停')
  })
})

describe('describeMemberStatus', () => {
  it('成员列表那一行带持续时间（用 since 算）', () => {
    const v = describeMemberStatus(st({ status: 'waiting', since: NOW - 3 * min }), NOW)
    expect(v.label).toBe('等待消息')
    expect(v.duration).toBe('3 分钟')
    expect(v.line).toBe('等待消息 · 3 分钟')
    expect(v.color).toBe(MEMBER_STATUS_META.waiting.color)
    expect(v.alert).toBe(false)
  })
  it('没有 since 就不写持续时间；stale 不重复写', () => {
    expect(describeMemberStatus(st({ status: 'offline', sessions: 0 }), NOW).line).toBe('离线')
    const v = describeMemberStatus(st({ status: 'stale', since: NOW - min, lastSeen: NOW - 11 * min }), NOW)
    expect(v.line).toBe('可能卡住（11 分钟没有动静）')
    expect(v.alert).toBe(true)
  })
  it('悬停详情：工具、任务、命令、连接数、最后活动', () => {
    const v = describeMemberStatus(
      st({
        status: 'working',
        since: NOW - 2 * min,
        tool: 'read_file',
        calling: true,
        tasks: [
          { ref: 'T-23', title: '状态界面', workspaceId: 'w1' },
          { ref: 'T-5', title: '别的', workspaceId: 'w1' }
        ],
        commands: 1,
        sessions: 2,
        readers: ['codex'],
        lastSeen: NOW - 10_000
      }),
      NOW
    )
    const rows = v.title.split('\n')
    expect(rows[0]).toBe('状态：工作中（已 2 分钟）')
    expect(v.title).toContain('当前工具：读取 read_file（调用中）')
    expect(v.title).toContain('进行中的任务：T-23 状态界面；T-5 别的')
    expect(v.title).toContain('正在跑的命令：1 个')
    expect(v.title).toContain('连接数：2（副连接：codex）')
    expect(v.title).toContain('最后活动：10 秒前')
  })
  it('没有的信息不写，最后活动写没有记录', () => {
    const v = describeMemberStatus(st({ status: 'offline', sessions: 0 }), NOW)
    expect(v.title).not.toContain('当前工具')
    expect(v.title).not.toContain('进行中的任务')
    expect(v.title).not.toContain('正在跑的命令')
    expect(v.title).toContain('连接数：0')
    expect(v.title).toContain('最后活动：没有记录')
  })
})

describe('assigneeAlert 任务卡提醒', () => {
  it('stale / offline 且任务没完成才提醒', () => {
    expect(assigneeAlert(st({ status: 'stale', lastSeen: NOW - 15 * min }), 'in_progress', NOW)).toBe('执行者可能卡住：15 分钟没有动静')
    expect(assigneeAlert(st({ status: 'offline', sessions: 0, since: NOW - 2 * 60 * min }), 'review', NOW)).toBe('执行者已离线 2 小时')
    expect(assigneeAlert(st({ status: 'offline', sessions: 0 }), 'todo', NOW)).toBe('执行者离线')
    expect(assigneeAlert(st({ status: 'stale' }), 'blocked', NOW)).toBe('执行者可能卡住')
  })
  it('完成的任务、正常状态、没有状态数据都不提醒', () => {
    expect(assigneeAlert(st({ status: 'offline', sessions: 0 }), 'done', NOW)).toBeUndefined()
    expect(assigneeAlert(st({ status: 'working' }), 'in_progress', NOW)).toBeUndefined()
    expect(assigneeAlert(st({ status: 'paused' }), 'in_progress', NOW)).toBeUndefined()
    expect(assigneeAlert(undefined, 'in_progress', NOW)).toBeUndefined()
  })
})
