// 用户 #117：群聊只显示最新 100 条，往上翻再加载更早的
import { describe, expect, it } from 'vitest'
import type { GroupMessage } from '../src/core/types'
import { keepLatest, PAGE } from '../src/renderer/src/lib/groupChat'

const msgs = (n: number, from = 1): GroupMessage[] =>
  Array.from({ length: n }, (_, i) => ({ id: `m_${from + i}`, seq: from + i, channel: 'general', ts: 0, from: { id: 'a', name: 'A', kind: 'agent' }, text: `#${from + i}`, mentions: [] }) as unknown as GroupMessage)

describe('群聊只留最新一页', () => {
  it('一页是 100 条', () => {
    expect(PAGE).toBe(100)
  })

  it('不超过一页时原样返回，不算收起', () => {
    const list = msgs(100)
    const r = keepLatest(list)
    expect(r.trimmed).toBe(false)
    expect(r.messages).toBe(list)
  })

  it('超过时只留最新的 100 条，从前面收起', () => {
    const r = keepLatest(msgs(250))
    expect(r.trimmed).toBe(true)
    expect(r.messages).toHaveLength(100)
    expect(r.messages[0].seq).toBe(151)
    expect(r.messages.at(-1)!.seq).toBe(250)
  })

  it('可以指定条数；条数不合理时不收', () => {
    expect(keepLatest(msgs(10), 3).messages.map((m) => m.seq)).toEqual([8, 9, 10])
    expect(keepLatest(msgs(10), 0).trimmed).toBe(false)
  })
})
