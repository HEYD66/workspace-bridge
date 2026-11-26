import { describe, expect, it } from 'vitest'
import type { ActivityEvent, PendingAuthorization } from '../src/core/types'
import { buildBoard, cardKey, type BoardInput } from '../src/renderer/src/lib/canvasBoard'
import { fileConflicts, WRITE_WINDOW_MS, type ClaimLike } from '../src/renderer/src/lib/canvasConflicts'

const NOW = 10_000_000
const MIN = 60_000
const claim = (agentId: string, paths: string[], patch: Partial<ClaimLike> = {}): ClaimLike => ({ agentId, agentName: agentId.toUpperCase(), paths, task: null, kind: 'explicit', since: NOW - 5 * MIN, expiresAt: NOW + 25 * MIN, ...patch })
let n = 0
const write = (agentId: string, ws: string, path: string, ts: number, patch: Partial<ActivityEvent> = {}): ActivityEvent => ({ id: `e${++n}`, ts, agentId, agentName: agentId.toUpperCase(), agentColor: '#fff', tool: 'write_file', args: {}, status: 'ok', path, workspaceId: ws, ...patch })

describe('fileConflicts：哪几个 AI 正在改或占着同一个文件', () => {
  it('两人登记同一个文件：给出文件、两边是谁、从什么时候撞上（第二个人开始的时间）', () => {
    const out = fileConflicts({ claimsByWs: { w1: [claim('a', ['src/x.ts'], { since: NOW - 9 * MIN, task: 'T-1' }), claim('b', ['src/x.ts'], { since: NOW - 2 * MIN, kind: 'implicit' })] }, now: NOW })
    expect(out).toEqual([
      {
        id: 'w1|src/x.ts',
        workspaceId: 'w1',
        path: 'src/x.ts',
        since: NOW - 2 * MIN,
        holders: [
          { agentId: 'a', agentName: 'A', since: NOW - 9 * MIN, until: NOW + 25 * MIN, via: 'claim', kind: 'explicit', task: 'T-1' },
          { agentId: 'b', agentName: 'B', since: NOW - 2 * MIN, until: NOW + 25 * MIN, via: 'claim', kind: 'implicit', task: null }
        ]
      }
    ])
  })

  it('过期的登记、同一个人、不同工作区都不算撞上', () => {
    expect(fileConflicts({ claimsByWs: { w1: [claim('a', ['x.ts']), claim('b', ['x.ts'], { expiresAt: NOW })] }, now: NOW })).toEqual([])
    expect(fileConflicts({ claimsByWs: { w1: [claim('a', ['x.ts']), claim('a', ['x.ts'], { task: 'T-2' })] }, now: NOW })).toEqual([])
    expect(fileConflicts({ claimsByWs: { w1: [claim('a', ['x.ts'])], w2: [claim('b', ['x.ts'])] }, now: NOW })).toEqual([])
  })

  it('目录和 glob 登记：取具体的那个文件；两个不同的 glob 不算；Windows 不分大小写、反斜杠也认', () => {
    const dir = fileConflicts({ claimsByWs: { w1: [claim('a', ['src/lib']), claim('b', ['src/lib/a.ts'])] }, now: NOW })
    expect(dir.map((c) => c.path)).toEqual(['src/lib/a.ts'])
    const glob = fileConflicts({ claimsByWs: { w1: [claim('a', ['src/**/*.ts']), claim('b', ['SRC\\core\\b.ts'])] }, now: NOW })
    expect(glob.map((c) => c.path)).toEqual(['SRC/core/b.ts'])
    expect(fileConflicts({ claimsByWs: { w1: [claim('a', ['src/*.ts']), claim('b', ['src/**'])] }, now: NOW })).toEqual([])
    expect(fileConflicts({ claimsByWs: { w1: [claim('a', ['src/*.ts']), claim('b', ['src/*.ts'])] }, now: NOW }).map((c) => c.path)).toEqual(['src/*.ts'])
    expect(fileConflicts({ claimsByWs: { w1: [claim('a', ['A.ts']), claim('b', ['a.ts'])] }, now: NOW, caseInsensitive: false })).toEqual([])
    expect(fileConflicts({ claimsByWs: { w1: [claim('a', ['src/lib']), claim('b', ['src/library.ts'])] }, now: NOW })).toEqual([])
  })

  it(`改动记录：${WRITE_WINDOW_MS / MIN} 分钟内写过就算正在改；读、失败的、太早的不算；同一人多次写从第一次算起`, () => {
    const events = [
      write('a', 'w1', 'src/x.ts', NOW - 8 * MIN),
      write('a', 'w1', 'src/x.ts', NOW - 1 * MIN, { tool: 'edit_file' }),
      write('b', 'w1', 'src/x.ts', NOW - 3 * MIN, { tool: 'apply_patch' }),
      write('c', 'w1', 'src/x.ts', NOW - 2 * MIN, { tool: 'read_file' }),
      write('d', 'w1', 'src/x.ts', NOW - 2 * MIN, { status: 'error' }),
      write('e', 'w1', 'src/x.ts', NOW - 11 * MIN)
    ]
    const out = fileConflicts({ events, now: NOW })
    expect(out).toHaveLength(1)
    expect(out[0].holders).toEqual([
      { agentId: 'a', agentName: 'A', since: NOW - 8 * MIN, until: NOW - 1 * MIN + WRITE_WINDOW_MS, via: 'write' },
      { agentId: 'b', agentName: 'B', since: NOW - 3 * MIN, until: NOW - 3 * MIN + WRITE_WINDOW_MS, via: 'write' }
    ])
    expect(out[0].since).toBe(NOW - 3 * MIN)
  })

  it('同一个人既登记又写过：并成一条，用登记的种类和任务，时间取最早；三个人撞同一个文件一条里列三个', () => {
    const out = fileConflicts({
      claimsByWs: { w1: [claim('a', ['x.ts'], { since: NOW - 4 * MIN, task: 'T-9' }), claim('c', ['x.ts'], { since: NOW - 1 * MIN })] },
      events: [write('a', 'w1', './x.ts', NOW - 6 * MIN), write('b', 'w1', 'x.ts', NOW - 2 * MIN)],
      now: NOW
    })
    expect(out).toHaveLength(1)
    expect(out[0].holders.map((h) => [h.agentId, h.since, h.via, h.task])).toEqual([
      ['a', NOW - 6 * MIN, 'claim', 'T-9'],
      ['b', NOW - 2 * MIN, 'write', undefined],
      ['c', NOW - 1 * MIN, 'claim', null]
    ])
    expect(out[0].since).toBe(NOW - 2 * MIN)
  })
})

const agent = (id: string) => ({ id, name: id.toUpperCase(), color: '#fff' })
const base = (patch: Partial<BoardInput> = {}): BoardInput => ({ agents: ['a', 'b', 'c'].map(agent), workspaces: [{ id: 'w1', name: 'one' }], tasksByWs: {}, now: NOW, ...patch })
const pending = (id: string, patch: Partial<PendingAuthorization> = {}): PendingAuthorization => ({ id, pairCode: '1234', clientId: `c_${id}`, clientName: 'ChatGPT', redirectHost: 'chatgpt.com', createdAt: NOW - MIN, expiresAt: NOW + 9 * MIN, ...patch })

describe('buildBoard：撞车和 OAuth 进画布数据', () => {
  it('conflicts 带两边卡片的 key；没画出来的人去掉，剩不到两个就不算', () => {
    const events = [write('a', 'w1', 'x.ts', NOW - MIN), write('b', 'w1', 'x.ts', NOW - 2 * MIN), write('c', 'w1', 'y.ts', NOW - MIN)]
    const board = buildBoard(base({ events, fileClaims: { w1: [claim('c', ['x.ts'], { since: NOW - 3 * MIN })] } }))
    expect(board.conflicts).toHaveLength(1)
    expect(board.conflicts[0].path).toBe('x.ts')
    expect(board.conflicts[0].keys).toEqual([cardKey('c', 'w1'), cardKey('b', 'w1'), cardKey('a', 'w1')])
    const hidden = buildBoard(base({ events, fileClaims: { w1: [claim('c', ['x.ts'])] }, archived: ['a', 'b'] }))
    expect(hidden.conflicts).toEqual([])
    const two = buildBoard(base({ events, archived: ['c'] }))
    expect(two.conflicts[0].keys).toEqual([cardKey('b', 'w1'), cardKey('a', 'w1')])
    expect(two.conflicts[0].since).toBe(NOW - MIN)
  })

  it('没给 now 不算撞车；什么都没有时是空数组', () => {
    expect(buildBoard(base({ now: undefined, events: [write('a', 'w1', 'x.ts', NOW), write('b', 'w1', 'x.ts', NOW)] })).conflicts).toEqual([])
    const empty = buildBoard(base())
    expect(empty.conflicts).toEqual([])
    expect(empty.oauth).toEqual([])
  })

  it('OAuth 待同意进「等你」：过期的去掉、早的在前、算进 totals.attention，有它就画用户卡片', () => {
    const board = buildBoard(base({ oauthPending: [pending('p2', { createdAt: NOW - 30_000 }), pending('p1', { createdAt: NOW - 2 * MIN, clientName: 'Claude', redirectHost: 'claude.ai', pairCode: '0042' }), pending('old', { expiresAt: NOW })] }))
    expect(board.oauth).toEqual([
      { id: 'p1', clientName: 'Claude', redirectHost: 'claude.ai', pairCode: '0042', since: NOW - 2 * MIN, expiresAt: NOW + 9 * MIN },
      { id: 'p2', clientName: 'ChatGPT', redirectHost: 'chatgpt.com', pairCode: '1234', since: NOW - 30_000, expiresAt: NOW + 9 * MIN }
    ])
    expect(board.totals.attention).toBe(2)
    expect(board.cards.some((c) => c.kind === 'user')).toBe(true)
    const none = buildBoard(base({ oauthPending: [pending('old', { expiresAt: NOW - 1 })] }))
    expect(none.totals.attention).toBe(0)
    expect(none.cards.some((c) => c.kind === 'user')).toBe(false)
  })
})
