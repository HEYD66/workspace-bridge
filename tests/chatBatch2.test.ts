// 优化.txt 第 4、5、11 条（T-7）：任务通知能叫醒等消息的；先确认再算已读；副连接（代理）的已读分开记；回执降噪
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { CHAT_RECEIPT_CHARS, ChatStore, chatDelivers, chatReaderKey, type ChatMember, type ChatNoticeHooks, type ChatSender } from '../src/core/chat'
import { ToolError } from '../src/core/fileTools'
import type { Agent } from '../src/core/types'

let base: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-chat-b2-'))
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

const members: ChatMember[] = [
  { id: 'a_alice', name: 'Alice' },
  { id: 'a_bob', name: 'Bob' },
  { id: 'a_cc', name: 'Claude Code' }
]
const ALICE: ChatSender = { kind: 'agent', id: 'a_alice', name: 'Alice' }
const BOB: ChatSender = { kind: 'agent', id: 'a_bob', name: 'Bob' }
const CC: ChatSender = { kind: 'agent', id: 'a_cc', name: 'Claude Code' }
const BOB_PROXY: ChatSender = { ...BOB, via: 'proxy' }
/** Bob 的副连接（代理） */
const PROXY = chatReaderKey('a_bob', 'proxy')

const store = (notices?: ChatNoticeHooks): ChatStore => new ChatStore({ dir: path.join(base, 'chat'), members: () => members, ...(notices ? { notices } : {}) })

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
    return 'OK'
  } catch (e) {
    return e instanceof ToolError ? e.code : String(e)
  }
}
const texts = (r: { messages: { text: string }[] }): string[] => r.messages.map((m) => m.text)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('已读位置按读者分开（第 11 条）', () => {
  it('读者键：主连接就是成员 id，副连接是「id#读者名」；名字不合法的当主连接', () => {
    expect(chatReaderKey('a_bob')).toBe('a_bob')
    expect(chatReaderKey('a_bob', 'proxy')).toBe('a_bob#proxy')
    expect(chatReaderKey('a_bob', '')).toBe('a_bob')
    expect(chatReaderKey('a_bob', 'has space')).toBe('a_bob')
    expect(chatReaderKey('a_bob', 'x'.repeat(25))).toBe('a_bob')
  })

  it('副连接读了，主连接的未读不动', () => {
    const s = store()
    s.send(ALICE, { text: '一' })
    s.send(ALICE, { text: '@Bob 二' })
    expect(texts(s.read(PROXY))).toEqual(['一', '@Bob 二'])
    expect(s.cursor(PROXY)).toBe(2)
    expect(s.cursor('a_bob')).toBe(0)
    expect(s.unread('a_bob')).toEqual({ unread: 2, mentions: 1 })
    // 本人照样读得到，副连接不会再读到
    expect(texts(s.read('a_bob'))).toEqual(['一', '@Bob 二'])
    expect(texts(s.read(PROXY))).toEqual([])
  })

  it('主连接读过的，副连接也算读过；副连接第一次用就从主连接的位置起步', () => {
    const s = store()
    s.send(ALICE, { text: '一' })
    s.send(ALICE, { text: '二' })
    s.read('a_bob')
    expect(s.cursor(PROXY)).toBe(2)
    expect(s.unread(PROXY).unread).toBe(0)
    s.send(ALICE, { text: '三' })
    expect(texts(s.read(PROXY))).toEqual(['三'])
    // 之后主连接再往前读，副连接跟着算读过（代理不用再处理本人看过的）
    s.send(ALICE, { text: '四' })
    s.read('a_bob')
    expect(texts(s.read(PROXY))).toEqual([])
    expect(s.cursor(PROXY)).toBe(4)
  })

  it('两个副连接各记各的', () => {
    const s = store()
    s.send(ALICE, { text: '一' })
    const other = chatReaderKey('a_bob', 'phone')
    s.read(PROXY)
    expect(s.cursor(PROXY)).toBe(1)
    expect(s.cursor(other)).toBe(0)
    expect(texts(s.read(other))).toEqual(['一'])
  })

  it('读者名不改变身份：别人的私聊照样看不到，点名照成员算', () => {
    const s = store()
    s.send(ALICE, { text: '给 CC 的悄悄话', to: 'Claude Code' })
    s.send(ALICE, { text: '给 Bob 的悄悄话', to: 'Bob' })
    expect(texts(s.read(PROXY))).toEqual(['给 Bob 的悄悄话'])
    expect(s.unread(PROXY)).toEqual({ unread: 0, mentions: 0 })
    s.send(ALICE, { text: '@Bob 看这个' })
    expect(s.unread(PROXY)).toEqual({ unread: 1, mentions: 1 })
  })

  it('已读位置存进 cursors.json 的「id#读者名」键，重开还在；吊销成员时一起清掉', () => {
    const s = store()
    s.send(ALICE, { text: '一' })
    s.read(PROXY)
    s.send(ALICE, { text: '二' })
    s.read('a_cc')
    const file = path.join(base, 'chat', 'cursors.json')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ 'a_bob#proxy': { general: 1 }, a_cc: { general: 2 } })
    const again = store()
    expect(again.cursor(PROXY)).toBe(1)
    expect(again.cursor('a_bob')).toBe(0)
    again.removeMember('a_bob')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a_cc: { general: 2 } })
    expect(again.cursor(PROXY)).toBe(0)
  })

  it('从副连接发的消息带 via；本人下次读能看到代理替它说了什么，副连接读不到本人发的', () => {
    const s = store()
    const m = s.send(BOB_PROXY, { text: '代理：Bob 不在，稍后回' })
    expect(m.from).toEqual({ kind: 'agent', id: 'a_bob', name: 'Bob', via: 'proxy' })
    // 副连接自己发的，自己不会再读到
    expect(texts(s.read(PROXY))).toEqual([])
    expect(s.unread(PROXY).unread).toBe(0)
    expect(texts(s.read('a_bob'))).toEqual(['代理：Bob 不在，稍后回'])
    s.send(BOB, { text: '我回来了' })
    expect(texts(s.read(PROXY))).toEqual([])
    expect(s.unread(PROXY).unread).toBe(0)
    // 普通消息的 from 上没有 via；不合法的读者名不存
    expect('via' in s.send(BOB, { text: '普通' }).from).toBe(false)
    expect('via' in s.send({ ...BOB, via: 'bad name!' }, { text: '乱写的' }).from).toBe(false)
  })
})

describe('先确认再算已读（第 5 条）', () => {
  it('不带 confirm：读完就算已读，结果里没有 next_ack（和原来一样）', () => {
    const s = store()
    s.send(ALICE, { text: '一' })
    const r = s.read('a_bob')
    expect(Object.keys(r).sort()).toEqual(['last_seq', 'messages', 'unread_left'])
    expect(s.cursor('a_bob')).toBe(1)
  })

  it('confirm=true：已读位置不动，带 next_ack；不确认就原样再给一遍，确认了才往前走', () => {
    const s = store()
    s.send(ALICE, { text: '一' })
    s.send(ALICE, { text: '二' })
    const r1 = s.read('a_bob', { confirm: true })
    expect(texts(r1)).toEqual(['一', '二'])
    expect(r1.next_ack).toEqual({ general: 2 })
    expect(r1.unread_left).toBe(2)
    expect(s.cursor('a_bob')).toBe(0)
    // 回复丢了：调用方没拿到 next_ack，下次不带 ack，同一批再来一遍
    const r2 = s.read('a_bob', { confirm: true })
    expect(texts(r2)).toEqual(['一', '二'])
    // 这回收到了，带上 ack
    s.send(ALICE, { text: '三' })
    const r3 = s.read('a_bob', { confirm: true, ack: r2.next_ack })
    expect(texts(r3)).toEqual(['三'])
    expect(r3.next_ack).toEqual({ general: 3 })
    expect(s.cursor('a_bob')).toBe(2)
    const r4 = s.read('a_bob', { confirm: true, ack: r3.next_ack })
    expect(texts(r4)).toEqual([])
    expect(r4.next_ack).toEqual({})
    expect(s.cursor('a_bob')).toBe(3)
  })

  it('confirm=true 时 mark_read 不起作用；翻历史、搜索时 next_ack 是空的', () => {
    const s = store()
    s.send(ALICE, { text: '苹果' })
    s.send(ALICE, { text: '香蕉' })
    expect(s.read('a_bob', { confirm: true, markRead: true }).next_ack).toEqual({ general: 2 })
    expect(s.read('a_bob', { confirm: true, markRead: false }).next_ack).toEqual({ general: 2 })
    expect(s.cursor('a_bob')).toBe(0)
    expect(s.read('a_bob', { confirm: true, query: '苹果' }).next_ack).toEqual({})
    expect(s.read('a_bob', { confirm: true, before: 2, channels: ['general'] }).next_ack).toEqual({})
  })

  it('没取满时 next_ack 只到取到的那条；多个频道分别记', () => {
    const s = store()
    const ws = 'ws:w1'
    for (const t of ['一', '二', '三']) s.send(ALICE, { text: t })
    s.send(ALICE, { text: '工作区里的' }, ws)
    const r = s.read('a_bob', { confirm: true, limit: 2, channels: ['general', ws] })
    expect(texts(r)).toEqual(['一', '二'])
    expect(r.next_ack).toEqual({ general: 2 })
    const r2 = s.read('a_bob', { confirm: true, ack: r.next_ack, channels: ['general', ws] })
    expect(texts(r2)).toEqual(['三', '工作区里的'])
    expect(r2.next_ack).toEqual({ general: 3, [ws]: 1 })
  })

  it('ack 只进不退；超过最新序号按最新算；不在范围里的频道忽略', () => {
    const s = store()
    const ws = 'ws:w1'
    for (const t of ['一', '二', '三']) s.send(ALICE, { text: t })
    s.send(ALICE, { text: '工作区里的' }, ws)
    expect(s.ack('a_bob', { general: 2 })).toEqual({ general: 2 })
    expect(s.ack('a_bob', { general: 1 })).toEqual({ general: 2 })
    expect(s.ack('a_bob', { general: 999 })).toEqual({ general: 3 })
    expect(s.cursor('a_bob')).toBe(3)
    // 调用方给了「它能看到的频道」，别的频道不认；没建过的频道也不会因为 ack 被建出来
    expect(s.ack('a_bob', { [ws]: 1 }, { channels: ['general'] })).toEqual({})
    expect(s.cursor('a_bob', ws)).toBe(0)
    expect(s.ack('a_bob', { 'ws:nope': 5 })).toEqual({})
    expect(fs.existsSync(path.join(base, 'chat', 'ws_nope.jsonl'))).toBe(false)
    expect(s.ack('a_bob', { 'not a channel': 5, [ws]: 1 })).toEqual({ [ws]: 1 })
    expect(s.ack('a_bob', undefined)).toEqual({})
  })

  it('ack 格式不对报 INVALID_ARGS，已读位置不动', () => {
    const s = store()
    s.send(ALICE, { text: '一' })
    for (const bad of ['general=1', 3, [1], { general: '1' }, { general: -1 }, { general: 1.5 }]) {
      expect(codeOf(() => s.ack('a_bob', bad))).toBe('INVALID_ARGS')
      expect(codeOf(() => s.read('a_bob', { ack: bad }))).toBe('INVALID_ARGS')
    }
    expect(s.cursor('a_bob')).toBe(0)
  })

  it('副连接的 ack 只动它自己的已读位置', () => {
    const s = store()
    s.send(ALICE, { text: '一' })
    const r = s.read(PROXY, { confirm: true })
    expect(r.next_ack).toEqual({ general: 1 })
    s.ack(PROXY, r.next_ack)
    expect(s.cursor(PROXY)).toBe(1)
    expect(s.cursor('a_bob')).toBe(0)
  })
})

describe('等消息：receive（第 4、5 条）', () => {
  it('等到头没有消息：timed_out=true，没有 woken_by', async () => {
    const s = store()
    const r = await s.receive('a_bob', { channels: ['general'], timeoutMs: 30 })
    expect(r.timed_out).toBe(true)
    expect(r.woken_by).toBeUndefined()
    expect(r.messages).toEqual([])
    expect('next_ack' in r).toBe(false)
  })

  it('有新消息：woken_by=message，默认读完算已读', async () => {
    const s = store()
    const p = s.receive('a_bob', { channels: ['general'], timeoutMs: 2000 })
    s.send(ALICE, { text: '来了' })
    const r = await p
    expect(texts(r)).toEqual(['来了'])
    expect(r.woken_by).toBe('message')
    expect(r.timed_out).toBeUndefined()
    expect(s.cursor('a_bob')).toBe(1)
  })

  it('confirm=true：等到的消息不算已读，下次不带 ack 立刻再给一遍；带了 ack 才接着等', async () => {
    const s = store()
    s.send(ALICE, { text: '一' })
    const r1 = await s.receive('a_bob', { channels: ['general'], timeoutMs: 2000, confirm: true })
    expect(texts(r1)).toEqual(['一'])
    expect(r1.next_ack).toEqual({ general: 1 })
    expect(s.cursor('a_bob')).toBe(0)
    const r2 = await s.receive('a_bob', { channels: ['general'], timeoutMs: 2000, confirm: true })
    expect(texts(r2)).toEqual(['一'])
    const r3 = await s.receive('a_bob', { channels: ['general'], timeoutMs: 30, confirm: true, ack: r2.next_ack })
    expect(r3.timed_out).toBe(true)
    expect(r3.next_ack).toEqual({})
    expect(s.cursor('a_bob')).toBe(1)
  })

  it('连接已经断了（signal abort）：不标已读，消息留着下次再给', async () => {
    const s = store()
    const ac = new AbortController()
    const p = s.receive('a_bob', { channels: ['general'], timeoutMs: 2000, signal: ac.signal })
    await sleep(10)
    s.send(CC, { text: '给不在的人' }, 'ws:other')
    ac.abort()
    const gone = await p
    expect(gone.undelivered).toBe(true)
    s.send(ALICE, { text: '断线之后到的' })
    // 断线时已经到了的消息也一样：结果送不出去就不算读过
    const ac2 = new AbortController()
    ac2.abort()
    const r = await s.receive('a_bob', { channels: ['general'], timeoutMs: 2000, signal: ac2.signal })
    expect(r.undelivered).toBe(true)
    expect(r.woken_by).toBeUndefined()
    expect(s.cursor('a_bob')).toBe(0)
    expect(texts(await s.receive('a_bob', { channels: ['general'], timeoutMs: 2000 }))).toEqual(['断线之后到的'])
  })

  it('deliverable 返回 false（暂停、吊销）：不标已读，带 undelivered；确认模式下也不留 next_ack', async () => {
    const s = store()
    s.send(ALICE, { text: '一' })
    const r = await s.receive('a_bob', { channels: ['general'], timeoutMs: 2000, confirm: true, deliverable: () => false })
    expect(r.undelivered).toBe(true)
    expect('next_ack' in r).toBe(false)
    expect(s.cursor('a_bob')).toBe(0)
    const ok = await s.receive('a_bob', { channels: ['general'], timeoutMs: 2000, deliverable: () => true })
    expect(texts(ok)).toEqual(['一'])
    expect(s.cursor('a_bob')).toBe(1)
  })

  it('mentions_only：别的消息不叫醒；点名的才叫醒', async () => {
    const s = store()
    const p = s.receive('a_bob', { channels: ['general'], timeoutMs: 150, mentionsOnly: true })
    s.send(ALICE, { text: '闲聊' })
    await sleep(20)
    expect(s.waiting('a_bob')).toBe(1)
    s.send(ALICE, { text: '@Bob 找你' })
    const r = await p
    expect(texts(r)).toEqual(['@Bob 找你'])
    expect(r.woken_by).toBe('message')
  })

  it('waiting(成员) 只数这个成员正在等的调用，副连接也算', async () => {
    const s = store()
    const p1 = s.receive('a_bob', { channels: ['general'], timeoutMs: 60 })
    const p2 = s.receive(PROXY, { channels: ['general'], timeoutMs: 60 })
    const p3 = s.receive('a_cc', { channels: ['general'], timeoutMs: 60 })
    expect(s.waiting()).toBe(3)
    expect(s.waiting('a_bob')).toBe(2)
    expect(s.waiting('a_alice')).toBe(0)
    await Promise.all([p1, p2, p3])
    expect(s.waiting()).toBe(0)
  })
})

/** 假的通知队列：记下被调了什么 */
function fakeNotices(): ChatNoticeHooks & { queue: Map<string, number>; held: string[]; acked: [string, number][] } {
  const queue = new Map<string, number>()
  const held: string[] = []
  const acked: [string, number][] = []
  return {
    queue,
    held,
    acked,
    pending: (id) => (queue.get(id) ?? 0) > 0,
    mark: (id) => queue.get(id) ?? 0,
    ack: (id, n) => void acked.push([id, n]),
    hold: (id) => void held.push(id)
  }
}

describe('任务通知叫醒等消息的（第 4 条）', () => {
  it('nudge：正在 receive 里等的主连接立刻返回，woken_by=notice，messages 是空的，不算超时', async () => {
    const n = fakeNotices()
    const s = store(n)
    const t0 = Date.now()
    const p = s.receive('a_bob', { channels: ['general'], timeoutMs: 5000 })
    await sleep(10)
    n.queue.set('a_bob', 1)
    expect(s.nudge('a_bob')).toBe(1)
    const r = await p
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(r.woken_by).toBe('notice')
    expect(r.timed_out).toBeUndefined()
    expect(r.messages).toEqual([])
  })

  it('调用时已经有没带走的通知：不等，立即返回', async () => {
    const n = fakeNotices()
    n.queue.set('a_bob', 3)
    const s = store(n)
    const t0 = Date.now()
    const r = await s.receive('a_bob', { channels: ['general'], timeoutMs: 5000 })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(r.woken_by).toBe('notice')
  })

  it('有通知又有新消息：woken_by 记 message，消息照常带回', async () => {
    const n = fakeNotices()
    n.queue.set('a_bob', 1)
    const s = store(n)
    s.send(ALICE, { text: '一' })
    const r = await s.receive('a_bob', { channels: ['general'], timeoutMs: 5000 })
    expect(r.woken_by).toBe('message')
    expect(texts(r)).toEqual(['一'])
  })

  it('mentions_only 的等待也会被通知叫醒', async () => {
    const n = fakeNotices()
    const s = store(n)
    const p = s.receive('a_bob', { channels: ['general'], timeoutMs: 5000, mentionsOnly: true })
    await sleep(10)
    s.nudge('a_bob')
    expect((await p).woken_by).toBe('notice')
  })

  it('不叫别人，不叫副连接；副连接调用时有通知也照常等', async () => {
    const n = fakeNotices()
    n.queue.set('a_bob', 1)
    const s = store(n)
    const proxy = s.receive(PROXY, { channels: ['general'], timeoutMs: 80 })
    const cc = s.receive('a_cc', { channels: ['general'], timeoutMs: 80 })
    await sleep(10)
    expect(s.waiting()).toBe(2)
    expect(s.nudge('a_bob')).toBe(0)
    expect((await proxy).timed_out).toBe(true)
    expect((await cc).timed_out).toBe(true)
  })

  it('副连接就算自己要求被叫醒（waitEx nudge=true），通知也不叫它', async () => {
    const s = store(fakeNotices())
    const p = s.waitEx(PROXY, { channels: ['general'], timeoutMs: 80, nudge: true })
    const main = s.waitEx('a_bob', { channels: ['general'], timeoutMs: 5000, nudge: true })
    await sleep(10)
    expect(s.nudge('a_bob')).toBe(1)
    expect(await main).toEqual({ messages: [], nudged: true })
    expect(await p).toEqual({ messages: [], nudged: false })
  })

  it('老的 wait() 不理会 nudge（没接新参数的调用方行为不变）', async () => {
    const s = store(fakeNotices())
    const t0 = Date.now()
    const p = s.wait('a_bob', { channels: ['general'], timeoutMs: 80 })
    await sleep(10)
    expect(s.nudge('a_bob')).toBe(0)
    expect(await p).toEqual([])
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70)
  })

  it('确认模式：next_ack 里带 _notices（通知编号），并告诉队列先留着；ack 回来时转给队列', async () => {
    const n = fakeNotices()
    n.queue.set('a_bob', 7)
    const s = store(n)
    s.send(ALICE, { text: '一' })
    const r = await s.receive('a_bob', { channels: ['general'], timeoutMs: 5000, confirm: true })
    expect(r.next_ack).toEqual({ general: 1, _notices: 7 })
    expect(n.held).toEqual(['a_bob'])
    n.queue.delete('a_bob')
    const r2 = await s.receive('a_bob', { channels: ['general'], timeoutMs: 20, confirm: true, ack: r.next_ack })
    expect(n.acked).toEqual([['a_bob', 7]])
    expect(r2.next_ack).toEqual({})
    // 不带 confirm 的不留、不带编号
    n.queue.set('a_bob', 8)
    const r3 = await s.receive('a_bob', { channels: ['general'], timeoutMs: 20 })
    expect('next_ack' in r3).toBe(false)
    expect(n.held).toEqual(['a_bob', 'a_bob'])
  })

  it('副连接的确认模式不碰通知：next_ack 里没有 _notices，ack 里带了也不转', async () => {
    const n = fakeNotices()
    n.queue.set('a_bob', 7)
    const s = store(n)
    s.send(ALICE, { text: '一' })
    const r = s.read(PROXY, { confirm: true })
    expect(r.next_ack).toEqual({ general: 1 })
    s.ack(PROXY, { general: 1, _notices: 7 })
    expect(n.held).toEqual([])
    expect(n.acked).toEqual([])
  })
})

describe('回执降噪（第 11 条）', () => {
  it('回执只送给它回复的那条的作者：作者被叫醒、算未读；别人不叫醒、不算未读，但读的时候能读到', async () => {
    const s = store()
    const ask = s.send(ALICE, { text: '@Bob 帮我看下登录接口' })
    s.read('a_bob')
    s.read('a_cc')
    const alice = s.receive('a_alice', { channels: ['general'], timeoutMs: 2000 })
    const t0 = Date.now()
    let ccTook = 0
    const cc = s.receive('a_cc', { channels: ['general'], timeoutMs: 120 }).then((r) => {
      ccTook = Date.now() - t0
      return r
    })
    const m = s.send(BOB, { text: '收到', replyTo: ask.id, receipt: true })
    expect(m.kind).toBe('receipt')
    expect(m.mentions).toEqual(['a_alice'])
    const ra = await alice
    expect(ra.woken_by).toBe('message')
    expect(texts(ra)).toEqual(['收到'])
    // CC 没被叫醒，等到头；到头时把这条回执顺带带回去，仍然算超时，之后不再重复
    const rc = await cc
    expect(ccTook).toBeGreaterThanOrEqual(100)
    expect(rc.timed_out).toBe(true)
    expect(rc.messages.map((x) => [x.text, x.kind])).toEqual([['收到', 'receipt']])
    expect(s.cursor('a_cc')).toBe(2)
    expect(chatDelivers(m, 'a_alice')).toBe(true)
    expect(chatDelivers(m, 'a_cc')).toBe(false)
  })

  it('调用时已经躺着一条给别人的回执：不会因此立刻返回，照常等到头', async () => {
    const s = store()
    const ask = s.send(ALICE, { text: '谁有空' })
    s.read('a_cc')
    s.send(BOB, { text: '收到', replyTo: ask.id, receipt: true })
    const t0 = Date.now()
    const r = await s.receive('a_cc', { channels: ['general'], timeoutMs: 120 })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100)
    expect(r.timed_out).toBe(true)
    expect(texts(r)).toEqual(['收到'])
  })

  it('给别人的回执不计未读；后面来了普通消息，一起读到', () => {
    const s = store()
    const ask = s.send(ALICE, { text: '谁有空' })
    s.read('a_cc')
    s.send(BOB, { text: '收到', replyTo: ask.seq, receipt: true })
    expect(s.unread('a_cc')).toEqual({ unread: 0, mentions: 0 })
    expect(s.unread('a_alice')).toEqual({ unread: 1, mentions: 1 })
    expect(s.unreadAll('a_cc', ['general']).unread).toBe(0)
    s.send(BOB, { text: '我来做' })
    expect(s.unread('a_cc').unread).toBe(1)
    expect(texts(s.read('a_cc'))).toEqual(['收到', '我来做'])
  })

  it('回执里 @所有人 不算数；正文里点名的成员也收得到', () => {
    const s = store()
    const m = s.send(BOB, { text: '@所有人 @Claude Code 收到', receipt: true })
    expect(m.mentions).toEqual(['a_cc'])
    expect(chatDelivers(m, 'a_cc')).toBe(true)
    expect(chatDelivers(m, 'a_alice')).toBe(false)
  })

  it('回执没有收的人（没引用、没点名、不是私聊，或者引用的是自己的消息）报 INVALID_ARGS', () => {
    const s = store()
    const own = s.send(BOB, { text: '我自己说的' })
    expect(codeOf(() => s.send(BOB, { text: '收到', receipt: true }))).toBe('INVALID_ARGS')
    expect(codeOf(() => s.send(BOB, { text: '@所有人 收到', receipt: true }))).toBe('INVALID_ARGS')
    expect(codeOf(() => s.send(BOB, { text: '收到', replyTo: own.id, receipt: true }))).toBe('INVALID_ARGS')
    // 私聊的回执有收的人
    const p = s.send(BOB, { text: '收到', to: 'Alice', receipt: true })
    expect(p.kind).toBe('receipt')
    expect(chatDelivers(p, 'a_alice')).toBe(true)
    expect(s.lastSeq()).toBe(2)
  })

  it(`回执最多 ${CHAT_RECEIPT_CHARS} 字，超了报 TOO_LARGE`, () => {
    const s = store()
    const ask = s.send(ALICE, { text: '问一下' })
    expect(codeOf(() => s.send(BOB, { text: '好'.repeat(CHAT_RECEIPT_CHARS), replyTo: ask.id, receipt: true }))).toBe('OK')
    expect(codeOf(() => s.send(BOB, { text: '好'.repeat(CHAT_RECEIPT_CHARS + 1), replyTo: ask.id, receipt: true }))).toBe('TOO_LARGE')
  })

  it('普通消息没有 kind 字段；receipt 只认 true', () => {
    const s = store()
    const ask = s.send(ALICE, { text: '问一下' })
    expect('kind' in ask).toBe(false)
    expect('kind' in s.send(BOB, { text: '普通回复', replyTo: ask.id, receipt: false })).toBe(false)
    expect('kind' in s.send(BOB, { text: '普通回复', replyTo: ask.id, receipt: 'yes' as unknown as boolean })).toBe(false)
  })

  it('回复用户的回执记给用户（用户的未读角标照常算），别的 AI 不算', () => {
    const s = store()
    const ask = s.send({ kind: 'user', id: 'user', name: '你' }, { text: '在吗' })
    s.read('a_cc')
    const m = s.send(BOB, { text: '在', replyTo: ask.id, receipt: true })
    expect(m.mentions).toEqual(['user'])
    expect(s.unread('user').unread).toBe(1)
    expect(s.unread('a_cc').unread).toBe(0)
  })
})

// ---------- 经过 Bridge ----------

let bridge: Bridge
let url: string
const clients: Client[] = []

interface Result {
  isError: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  notices: string
}

async function connect(token: string, opts: { query?: string; headers?: Record<string, string> } = {}): Promise<Client> {
  const c = new Client({ name: 'chat-b2-test', version: '1.0.0' })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(url + (opts.query ?? '')), { requestInit: { headers: { Authorization: `Bearer ${token}`, ...(opts.headers ?? {}) } } })
  )
  clients.push(c)
  return c
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const r = await c.callTool({ name, arguments: args })
  const parts = (r.content as { type: string; text: string }[]).map((p) => p.text)
  const body = parts.find((t) => !t.startsWith('【通知】')) ?? ''
  let data: unknown = body
  try {
    data = JSON.parse(body)
  } catch {
    // 纯文本
  }
  return { isError: Boolean(r.isError), data, notices: parts.filter((t) => t.startsWith('【通知】')).join('\n') }
}

const wsChannel = (): string => `ws:${bridge.getState().activeWorkspaceId}`
const noticeLines = (r: Result): string[] =>
  r.notices
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2))
const sender = (a: Agent, via?: string): ChatSender => ({ kind: 'agent', id: a.id, name: a.name, ...(via ? { via } : {}) })

describe('经过 Bridge：通知叫醒、通知等确认、回执、副连接', () => {
  let a: { agent: Agent; c: Client }
  let b: { agent: Agent; c: Client }
  let cc: { agent: Agent; c: Client }
  let events: { agentId: string; text: string }[]

  beforeEach(async () => {
    const root = path.join(base, 'ws')
    fs.mkdirSync(root, { recursive: true })
    bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoot: root, port: 0, userSkillsDir: path.join(base, 'skills') })
    await bridge.start()
    url = bridge.getState().mcpUrl
    events = []
    bridge.on('notice', (agentId: string, text: string) => events.push({ agentId, text }))
    const aa = bridge.createAgent('Alice')
    const bb = bridge.createAgent('Bob')
    const c3 = bridge.createAgent('Carol')
    a = { agent: aa, c: await connect(aa.token) }
    b = { agent: bb, c: await connect(bb.token) }
    cc = { agent: c3, c: await connect(c3.token) }
  })

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.stop()
  })

  it('派任务会叫醒正在等消息的人；通知正文跟着它下一次工具结果回去', async () => {
    const t0 = Date.now()
    const p = bridge.chat.receive(a.agent.id, { channels: [wsChannel()], timeoutMs: 8000 })
    await sleep(20)
    expect(bridge.chat.waiting(a.agent.id)).toBe(1)
    bridge.createTask({ title: '修登录', assigneeId: a.agent.id })
    const r = await p
    expect(Date.now() - t0).toBeLessThan(4000)
    expect(r.woken_by).toBe('notice')
    expect(r.messages).toEqual([])
    const lines = noticeLines(await call(a.c, 'whoami'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('修登录')
    // 带走了就没有了；没有通知时照常等到头
    expect((await call(a.c, 'whoami')).notices).toBe('')
    expect((await bridge.chat.receive(a.agent.id, { channels: [wsChannel()], timeoutMs: 30 })).timed_out).toBe(true)
  })

  it('通知先到、后调用：不等，立即返回；别人的等待不受影响', async () => {
    bridge.createTask({ title: '任务甲', assigneeId: a.agent.id })
    const other = bridge.chat.receive(b.agent.id, { channels: [wsChannel()], timeoutMs: 60 })
    const t0 = Date.now()
    const r = await bridge.chat.receive(a.agent.id, { channels: [wsChannel()], timeoutMs: 8000 })
    expect(Date.now() - t0).toBeLessThan(4000)
    expect(r.woken_by).toBe('notice')
    expect((await other).timed_out).toBe(true)
  })

  it('现在的边界（不带 confirm）：通知随工具结果带走就删，这次回复要是丢了，通知不会再发', async () => {
    bridge.createTask({ title: '任务甲', assigneeId: a.agent.id })
    await bridge.chat.receive(a.agent.id, { channels: [wsChannel()], timeoutMs: 1000 })
    expect(noticeLines(await call(a.c, 'whoami'))).toHaveLength(1)
    expect((await call(a.c, 'whoami')).notices).toBe('')
    expect((await call(a.c, 'whoami')).notices).toBe('')
  })

  it('确认模式：通知带出去以后先留着，ack 里的 _notices 到了才删', async () => {
    bridge.createTask({ title: '任务甲', assigneeId: a.agent.id })
    const r = await bridge.chat.receive(a.agent.id, { channels: [wsChannel()], timeoutMs: 1000, confirm: true })
    expect(r.woken_by).toBe('notice')
    expect(r.next_ack).toEqual({ _notices: 1 })
    // 这次调用的结果带走通知（mcpServer 在工具结果末尾取通知；这里用下一个工具调用代替）
    const first = noticeLines(await call(a.c, 'whoami'))
    expect(first).toHaveLength(1)
    expect(first[0]).toContain('任务甲')
    // 还没确认：再等会立即返回（通知还在）
    const again = await bridge.chat.receive(a.agent.id, { channels: [wsChannel()], timeoutMs: 8000, confirm: true })
    expect(again.woken_by).toBe('notice')
    expect(again.next_ack).toEqual({ _notices: 1 })
    // 确认：通知删掉，之后的结果里不再带
    bridge.chat.ack(a.agent.id, again.next_ack)
    expect((await call(a.c, 'whoami')).notices).toBe('')
    expect((await bridge.chat.receive(a.agent.id, { channels: [wsChannel()], timeoutMs: 30, confirm: true })).timed_out).toBe(true)
  })

  it('确认模式：没等到 ack 的通知下次重发一遍并注明，不会丢；ack 之后新来的通知不受影响', async () => {
    bridge.createTask({ title: '任务甲', assigneeId: a.agent.id })
    const r = await bridge.chat.receive(a.agent.id, { channels: [wsChannel()], timeoutMs: 1000, confirm: true })
    expect(noticeLines(await call(a.c, 'whoami'))).toHaveLength(1)
    // 假设上面那次回复丢了：调用方没有 next_ack，下一个工具结果里通知再来一遍
    const resent = noticeLines(await call(a.c, 'whoami'))
    expect(resent).toHaveLength(1)
    expect(resent[0]).toContain('重发')
    expect(resent[0]).toContain('任务甲')
    // 平常的取法取走就删
    expect((await call(a.c, 'whoami')).notices).toBe('')
    // 迟到的 ack 不会删掉后来的通知：编号比它大的、还没带出去的都留着
    bridge.createTask({ title: '任务乙', assigneeId: a.agent.id })
    bridge.chat.ack(a.agent.id, r.next_ack)
    bridge.chat.ack(a.agent.id, { _notices: 99 })
    const later = noticeLines(await call(a.c, 'whoami'))
    expect(later).toHaveLength(1)
    expect(later[0]).toContain('任务乙')
    expect(later[0]).not.toContain('重发')
  })

  it('确认模式：ack 只删编号不超过它的通知，后面带出去过的那条还留着', async () => {
    bridge.createTask({ title: '任务甲', assigneeId: a.agent.id })
    bridge.createTask({ title: '任务乙', assigneeId: a.agent.id })
    const r = await bridge.chat.receive(a.agent.id, { channels: [wsChannel()], timeoutMs: 1000, confirm: true })
    expect(r.next_ack).toEqual({ _notices: 2 })
    expect(noticeLines(await call(a.c, 'whoami'))).toHaveLength(2)
    // 只确认到第 1 条
    bridge.chat.ack(a.agent.id, { _notices: 1 })
    const rest = noticeLines(await call(a.c, 'whoami'))
    expect(rest).toHaveLength(1)
    expect(rest[0]).toContain('任务乙')
    expect(rest[0]).toContain('重发')
  })

  it('回执：只有被回复的人收到通知；别人没有通知也没有「N 条未读」；不触发内置 AI 自动接活', async () => {
    const ask = await call(a.c, 'chat_send', { text: '谁来看下登录接口' })
    await call(b.c, 'chat_read')
    await call(cc.c, 'chat_read')
    await call(a.c, 'whoami')
    events.length = 0
    const m = bridge.chat.send(sender(b.agent), { text: '收到，我来', replyTo: ask.data.id, receipt: true }, wsChannel())
    expect(m.kind).toBe('receipt')
    expect(m.mentions).toEqual([a.agent.id])
    expect(events).toEqual([])
    const mine = noticeLines(await call(a.c, 'whoami'))
    expect(mine).toHaveLength(1)
    expect(mine[0]).toContain('成员 Bob 说：「收到，我来」')
    expect((await call(cc.c, 'whoami')).notices).toBe('')
    // Carol 读的时候能读到这条回执
    const read = await call(cc.c, 'chat_read')
    expect(read.data.messages.map((x: { text: string }) => x.text)).toEqual(['收到，我来'])
    // 对照：同样内容的普通消息，Carol 会收到「有未读」的提示
    bridge.chat.send(sender(b.agent), { text: '普通的一句' }, wsChannel())
    expect(noticeLines(await call(cc.c, 'whoami'))).toEqual(['[群聊] 有 1 条未读（ws），用 chat_read 看'])
  })

  it('用户身份发的回执也一样：平时用户在群里说话人人有全文通知，回执只给被回复的人', async () => {
    const ask = await call(a.c, 'chat_send', { text: '请用户确认一下' })
    await call(b.c, 'chat_read')
    await call(cc.c, 'chat_read')
    await call(a.c, 'whoami')
    bridge.chat.send({ kind: 'user', id: 'user', name: '你' }, { text: '看到了', replyTo: ask.data.id, receipt: true }, wsChannel())
    expect(noticeLines(await call(a.c, 'whoami'))).toHaveLength(1)
    expect((await call(b.c, 'whoami')).notices).toBe('')
    expect((await call(cc.c, 'whoami')).notices).toBe('')
    // 对照：用户的普通消息人人有通知
    bridge.chat.send({ kind: 'user', id: 'user', name: '你' }, { text: '大家辛苦' }, wsChannel())
    expect(noticeLines(await call(cc.c, 'whoami'))).toHaveLength(1)
  })

  it('副连接：握手时报读者名（地址上的 ?reader= 或请求头），会话里看得到；身份还是同一个', async () => {
    const byQuery = await connect(b.agent.token, { query: '?reader=proxy' })
    const byHeader = await connect(b.agent.token, { headers: { 'X-WB-Reader': 'phone_2' } })
    const readers = bridge
      .listAgentSessions(b.agent.id)
      .map((s) => s.reader ?? '(主)')
      .sort()
    expect(readers).toEqual(['(主)', 'phone_2', 'proxy'])
    expect((await call(byQuery, 'whoami')).data.agentId).toBe(b.agent.id)
    expect((await call(byHeader, 'whoami')).data.agentId).toBe(b.agent.id)
  })

  it('副连接不带走【通知】：任务通知和群聊通知都留给主连接', async () => {
    const proxy = await connect(b.agent.token, { query: '?reader=proxy' })
    bridge.createTask({ title: '给 Bob 的任务', assigneeId: b.agent.id })
    await call(a.c, 'chat_send', { text: '@Bob 看一下' })
    expect((await call(proxy, 'whoami')).notices).toBe('')
    expect((await call(proxy, 'chat_channels')).notices).toBe('')
    const lines = noticeLines(await call(b.c, 'whoami'))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('给 Bob 的任务')
    expect(lines[1]).toContain('@Bob 看一下')
  })

  it('读者名写错了握手就失败（400，INVALID_READER），不会悄悄当成主连接', async () => {
    const before = bridge.listAgentSessions(b.agent.id).length
    for (const bad of ['?reader=has%20space', '?reader=' + 'x'.repeat(25), '?reader=%E4%BB%A3%E7%90%86']) {
      const res = await fetch(url + bad, {
        method: 'POST',
        headers: { Authorization: `Bearer ${b.agent.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: { message: string; data?: { code?: string } } }
      expect(body.error.data?.code).toBe('INVALID_READER')
      expect(body.error.message).toContain('读者名')
    }
    expect(bridge.listAgentSessions(b.agent.id).length).toBe(before)
    // 空的读者名等于没写
    await connect(b.agent.token, { query: '?reader=' })
    expect(bridge.listAgentSessions(b.agent.id).every((s) => s.reader === undefined)).toBe(true)
  })

  it('副连接读群聊（按读者键）不动本人的未读；任务通知不叫醒副连接的等待', async () => {
    await call(a.c, 'chat_send', { text: '@Bob 第一件事' })
    const proxyKey = chatReaderKey(b.agent.id, 'proxy')
    const got = await bridge.chat.receive(proxyKey, { channels: [wsChannel()], timeoutMs: 1000 })
    expect(got.messages.map((m) => m.text)).toEqual(['@Bob 第一件事'])
    // 代理替它回了一句回执
    bridge.chat.send(sender(b.agent, 'proxy'), { text: 'Bob 稍后回', replyTo: got.messages[0].id, receipt: true }, wsChannel())
    // 本人上线：那条 @ 它的消息还是未读，还能看到代理说了什么
    const mine = await call(b.c, 'chat_read')
    expect(mine.data.messages.map((m: { text: string }) => m.text)).toEqual(['@Bob 第一件事', 'Bob 稍后回'])
    // 派给 Bob 的任务不叫醒副连接
    const waiting = bridge.chat.receive(proxyKey, { channels: [wsChannel()], timeoutMs: 80 })
    await sleep(10)
    bridge.createTask({ title: '给 Bob 的任务', assigneeId: b.agent.id })
    expect((await waiting).timed_out).toBe(true)
  })
})
