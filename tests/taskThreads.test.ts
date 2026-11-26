// 任务的线：每条任务自带一个会话，派活、交付、审查自动记在里面（.team/chat-contract.md v6）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { ChatStore, MAX_THREADS_PER_WORKSPACE, type ChatMember, type ChatSender } from '../src/core/chat'
import { entriesAfter, historyMarker, taskEventText, taskThreadChannel, taskThreadMembers, taskThreadTitle } from '../src/core/taskThread'
import { buildRows, channelInfo, channelsOf, chatTotals, taskThreadOf } from '../src/renderer/src/lib/groupChat'
import type { Agent, BridgeState, GroupChannelInfo, GroupMessage, TaskHistory } from '../src/core/types'

let base: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-task-threads-'))
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

const h = (ts: number, action: string, note?: string): TaskHistory => ({ ts, actorId: 'user', actorName: '用户', action, ...(note ? { note } : {}) })

describe('任务的线：纯函数', () => {
  it('频道 id 由任务 id 算出来，是合法的会话 id，和用户开的会话不撞', () => {
    expect(taskThreadChannel('w_demo', 't_0123456789')).toBe('ws:w_demo.c_t0123456789')
    expect(taskThreadChannel('w_demo', 't_0123456789')).toBe(taskThreadChannel('w_demo', 't_0123456789'))
    expect(taskThreadChannel('w_demo', 'weird id')).toBeUndefined()
    expect(taskThreadChannel('bad ws!', 't_0123456789')).toBeUndefined()
  })

  it('标题是「编号 任务标题」，太长截断到 60 字以内', () => {
    expect(taskThreadTitle('T-3', ' 修\n登录页 ')).toBe('T-3 修 登录页')
    const long = taskThreadTitle('T-12', 'x'.repeat(200))
    expect(long.length).toBe(60)
    expect(long.endsWith('…')).toBe(true)
  })

  it('成员：执行者、派活的人、创建者里的 AI，去重；用户和不存在的身份不算', () => {
    const isAgent = (id: string): boolean => id.startsWith('a_')
    expect(taskThreadMembers({ assigneeId: 'a_bob', managedBy: 'a_alice', createdBy: 'a_alice' }, isAgent)).toEqual(['a_alice', 'a_bob'])
    expect(taskThreadMembers({ assigneeId: 'a_bob', managedBy: 'user', createdBy: 'user' }, isAgent)).toEqual(['a_bob'])
    expect(taskThreadMembers({ assigneeId: undefined, managedBy: undefined, createdBy: 'user' }, isAgent)).toEqual([])
  })

  it('记到哪了：按时间戳比，同一毫秒的两条也分得清；记录被截短不影响', () => {
    const hist = [h(10, 'created'), h(20, 'claimed'), h(20, 'updated'), h(30, 'status → review')]
    expect(historyMarker([])).toBeUndefined()
    expect(historyMarker(hist)).toEqual({ ts: 30, n: 1 })
    expect(historyMarker(hist.slice(0, 3))).toEqual({ ts: 20, n: 2 })
    expect(entriesAfter(hist, undefined)).toHaveLength(4)
    expect(entriesAfter(hist, { ts: 10, n: 1 }).map((x) => x.action)).toEqual(['claimed', 'updated', 'status → review'])
    // 同一毫秒里先记了一条，后面又来一条
    expect(entriesAfter(hist, { ts: 20, n: 1 }).map((x) => x.action)).toEqual(['updated', 'status → review'])
    expect(entriesAfter(hist, { ts: 30, n: 1 })).toEqual([])
    // 老记录被截掉了（只留最近 100 条）：照样只给后面的
    expect(entriesAfter(hist.slice(2), { ts: 20, n: 2 }).map((x) => x.action)).toEqual(['status → review'])
  })

  it('任务记录变成事件：说人话，交付时带完整的交付说明', () => {
    const t = { ref: 'T-3', title: '修登录页', description: '把按钮对齐', result: '完整的交付说明：改了 a.ts' }
    expect(taskEventText(h(1, 'created', '指派给 Bob'), t, true)).toBe('创建了任务 T-3「修登录页」（指派给 Bob）\n\n把按钮对齐')
    expect(taskEventText(h(1, 'created'), t, false)).toBe('创建了任务 T-3「修登录页」')
    expect(taskEventText(h(1, 'claimed'), t)).toBe('认领了这个任务')
    expect(taskEventText(h(1, 'assigned', '→ Bob'), t)).toBe('把任务派给了 Bob')
    expect(taskEventText(h(1, 'assigned', '取消指派'), t)).toContain('待认领')
    expect(taskEventText(h(1, 'status → in_progress'), t)).toBe('把状态改成了「进行中」')
    expect(taskEventText(h(1, 'status → review', '备注里只有开头'), t, true)).toBe('做完了，提交审查\n\n完整的交付说明：改了 a.ts')
    // 不是最后一条了（后面又有别的记录）：用记录里留的那段
    expect(taskEventText(h(1, 'status → review', '备注里只有开头'), t, false)).toBe('做完了，提交审查\n\n备注里只有开头')
    expect(taskEventText(h(1, 'status → done（用户的任务不用审查，直接完成）'), t, true)).toContain('不用审查')
    expect(taskEventText(h(1, 'review: accepted', '不错'), t)).toBe('审查通过，任务完成\n\n不错')
    expect(taskEventText(h(1, 'review: rejected', '按钮还歪'), t)).toBe('审查没通过，退回重做\n\n按钮还歪')
    expect(taskEventText(h(1, 'edited', '改了标题、说明'), t)).toBe('改了任务的标题、说明')
    expect(taskEventText(h(1, 'question_added', 'q1：用哪个库'), t)).toContain('用哪个库')
    expect(taskEventText(h(1, 'something new', 'x'), t)).toBe('something new\n\nx')
  })
})

const members: ChatMember[] = [
  { id: 'a_alice', name: 'Alice' },
  { id: 'a_bob', name: 'Bob' }
]
const ALICE: ChatSender = { kind: 'agent', id: 'a_alice', name: 'Alice' }
const store = (): ChatStore => new ChatStore({ dir: path.join(base, 'chat'), members: () => members })

describe('ChatStore：任务的线', () => {
  const task = { id: 't_00000000aa', ref: 'T-1', title: '修登录页' }

  it('开线：只开一次，带着任务和成员；标题、成员变了跟着改；重启后还在', () => {
    const s = store()
    const r = s.ensureTaskThread('w_demo', task, ['a_bob'])
    expect(r).toEqual({ id: 'ws:w_demo.c_t00000000aa', created: true, changed: true })
    expect(s.ensureTaskThread('w_demo', task, ['a_bob'])).toMatchObject({ created: false, changed: false })
    expect(s.thread(r!.id)).toMatchObject({ title: 'T-1 修登录页', task: { id: task.id, ref: 'T-1', members: ['a_bob'] } })
    expect(s.ensureTaskThread('w_demo', { ...task, title: '修登录页和注册页' }, ['a_bob', 'a_alice'])).toMatchObject({ created: false, changed: true })
    const again = store()
    expect(again.thread(r!.id)).toMatchObject({ title: 'T-1 修登录页和注册页', task: { members: ['a_alice', 'a_bob'] } })
    expect(again.threads('w_demo')).toHaveLength(1)
  })

  it('记到哪了能存下来；开线时给的位置也存着', () => {
    const s = store()
    const r = s.ensureTaskThread('w_demo', task, [], { ts: 5, n: 1 })!
    expect(s.thread(r.id)?.task?.posted).toEqual({ ts: 5, n: 1 })
    s.setTaskPosted(r.id, { ts: 9, n: 2 })
    expect(store().thread(r.id)?.task?.posted).toEqual({ ts: 9, n: 2 })
  })

  it('任务的线不占「一个项目最多多少个会话」的名额', () => {
    const s = store()
    for (let i = 0; i < 5; i++) s.ensureTaskThread('w_demo', { id: `t_${String(i).padStart(10, '0')}`, ref: `T-${i}`, title: 'x' }, [])
    for (let i = 0; i < MAX_THREADS_PER_WORKSPACE; i++) s.createThread('w_demo', `会话 ${i}`)
    expect(() => s.createThread('w_demo', '多出来的')).toThrow(/最多/)
    expect(s.threads('w_demo')).toHaveLength(MAX_THREADS_PER_WORKSPACE + 5)
  })

  it('退回过旧版本：这条线的任务信息被丢了、还被归档了，再要它时按 id 认回来（不新开、消息还在、归档去掉）', () => {
    const s = store()
    const r = s.ensureTaskThread('w_demo', task, ['a_bob'])!
    s.postEvent(r.id, ALICE, '认领了这个任务')
    // 旧版本存回去的样子：只剩标题、时间、归档
    const file = path.join(base, 'chat', 'threads.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    raw.threads[r.id] = { title: '被用户改过名', createdAt: raw.threads[r.id].createdAt, archived: true }
    fs.writeFileSync(file, JSON.stringify(raw))
    const again = store()
    expect(again.thread(r.id)).toMatchObject({ title: '被用户改过名', archived: true })
    expect(again.thread(r.id)?.task).toBeUndefined()
    expect(again.ensureTaskThread('w_demo', task, ['a_alice'], { ts: 7, n: 1 })).toEqual({ id: r.id, created: false, changed: true })
    const t = again.thread(r.id)!
    expect(t).toMatchObject({ title: 'T-1 修登录页', task: { id: task.id, ref: 'T-1', members: ['a_alice'], posted: { ts: 7, n: 1 } } })
    expect(t.archived).toBeUndefined()
    expect(again.list({ channel: r.id, viewer: 'user' }).map((m) => m.text)).toEqual(['认领了这个任务'])
  })

  it('事件：记在频道里读得到，但对谁都不算未读、不叫醒；后面说的话照常算', async () => {
    const s = store()
    const r = s.ensureTaskThread('w_demo', task, ['a_alice', 'a_bob'])!
    let woke = false
    const waiting = s.wait('a_bob', { channels: [r.id], afterSeq: 0, timeoutMs: 80 }).then((m) => {
      woke = m.length > 0
    })
    const e = s.postEvent(r.id, ALICE, '认领了这个任务')!
    expect(e).toMatchObject({ kind: 'event', seq: 1, mentions: [], channel: r.id })
    await waiting
    expect(woke).toBe(false)
    expect(s.unread('a_bob', r.id)).toEqual({ unread: 0, mentions: 0 })
    expect(s.unread('user', r.id)).toEqual({ unread: 0, mentions: 0 })
    expect(s.list({ channel: r.id, viewer: 'a_bob' }).map((m) => m.text)).toEqual(['认领了这个任务'])
    // 正文里写了 @ 也不算点名；空的不记
    expect(s.postEvent(r.id, ALICE, '提了问题：@Bob 看一下')!.mentions).toEqual([])
    expect(s.postEvent(r.id, ALICE, '   ')).toBeUndefined()
    s.send(ALICE, { text: '我说一句' }, r.id)
    expect(s.unread('a_bob', r.id).unread).toBe(1)
    expect(store().list({ channel: r.id, viewer: 'user' }).map((m) => m.kind)).toEqual(['event', 'event', undefined])
  })
})

// ---------- 经过 Bridge 和 MCP ----------

let url = ''
const clients: Client[] = []

interface Result {
  isError: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  raw: string
  notices: string
}

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 'task-threads-test', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
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
  return { isError: Boolean(r.isError), data, raw: body, notices: parts.filter((t) => t.startsWith('【通知】')).join('\n') }
}

describe('经过 Bridge 和 MCP：任务的线', () => {
  let bridge: Bridge
  let a: { agent: Agent; c: Client }
  let b: { agent: Agent; c: Client }
  let wsId: string
  let main: string
  const opts = (): ConstructorParameters<typeof Bridge>[0] => ({ dataDir: path.join(base, 'data'), workspaceRoot: path.join(base, 'ws'), port: 0, userSkillsDir: path.join(base, 'skills') })

  beforeEach(async () => {
    fs.mkdirSync(path.join(base, 'ws'), { recursive: true })
    bridge = new Bridge(opts())
    await bridge.start()
    url = bridge.getState().mcpUrl
    const mk = async (name: string): Promise<{ agent: Agent; c: Client }> => {
      const agent = bridge.createAgent(name)
      return { agent, c: await connect(agent.token) }
    }
    a = await mk('Alice')
    b = await mk('Bob')
    wsId = bridge.getState().activeWorkspaceId!
    main = `ws:${wsId}`
  })

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.stop()
  })

  const lines = (): GroupChannelInfo[] => bridge.getState().chat.taskThreads ?? []
  const lineOf = (taskId: string): GroupChannelInfo => {
    const c = lines().find((x) => x.task?.id === taskId)
    if (!c) throw new Error(`任务 ${taskId} 没有线`)
    return c
  }
  const texts = (channel: string): string[] => bridge.listChat({ channel }).map((m) => m.text)
  const chan = async (x: { c: Client }): Promise<{ id: string; task?: string; unread: number }[]> => (await call(x.c, 'chat_channels')).data

  it('用户派活：任务一建就有它的线，派活那条记在里面；只有执行者看得到，不进频道列表、不算群聊未读', async () => {
    const t = bridge.createTask({ title: '修登录页', description: '把按钮对齐', assigneeId: a.agent.id })
    const line = lineOf(t.id)
    expect(line.id).toBe(`${main}.c_t${t.id.slice(2)}`)
    expect(line).toMatchObject({ workspaceId: wsId, thread: { title: 'T-1 修登录页' }, task: { id: t.id, ref: 'T-1', memberIds: [a.agent.id] }, unread: 0 })
    expect(bridge.getState().chat.channels.some((c) => c.id === line.id)).toBe(false)
    expect(bridge.getState().chat.unread).toBe(0)
    const msgs = bridge.listChat({ channel: line.id })
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ kind: 'event', from: { kind: 'user' } })
    expect(msgs[0].text).toBe('创建了任务 T-1「修登录页」（指派给 Alice）\n\n把按钮对齐')
    expect(texts(main)).toEqual([])
    // Alice 的频道里有它（带 task），事件不算未读；Bob 没有
    const mine = (await chan(a)).find((c) => c.id === line.id)
    expect(mine).toMatchObject({ task: 'T-1', unread: 0, mode: 'brainstorm' })
    expect((await chan(b)).some((c) => c.id === line.id)).toBe(false)
    // task_get 带 chat_channel
    expect((await call(a.c, 'task_get', { task: 'T-1' })).data.chat_channel).toBe(line.id)
  })

  it('AI 在线里说话：用任务编号、id 都行；用户看到未读（只算说的话），主群聊不长；不在里面的 AI 进不来', async () => {
    const t = bridge.createTask({ title: '修登录页', assigneeId: a.agent.id })
    const line = lineOf(t.id)
    const s1 = await call(a.c, 'chat_send', { channel: 'T-1', text: '按钮对齐要不要连注册页一起改？' })
    expect(s1.isError).toBe(false)
    expect(s1.data.channel).toBe(line.id)
    const s2 = await call(a.c, 'chat_send', { channel: line.id, text: '先按只改登录页做' })
    expect(s2.isError).toBe(false)
    expect(texts(line.id).slice(1)).toEqual(['按钮对齐要不要连注册页一起改？', '先按只改登录页做'])
    expect(lineOf(t.id).unread).toBe(2)
    expect(bridge.getState().chat.unread).toBe(0)
    expect(texts(main)).toEqual([])
    for (const channel of ['T-1', line.id]) {
      const bad = await call(b.c, 'chat_send', { channel, text: '我也说一句' })
      expect(bad.isError).toBe(true)
      expect(bad.raw).toContain('CHANNEL_FORBIDDEN')
      expect((await call(b.c, 'chat_read', { channel })).isError).toBe(true)
    }
    expect(texts(line.id)).toHaveLength(3)
    // 没有这条任务
    expect((await call(a.c, 'chat_send', { channel: 'T-99', text: 'x' })).raw).toContain('NOT_FOUND')
  })

  it('用户在线里说话：执行者收到带全文的通知，别的 AI 不知道；读这条线时事件也读得到', async () => {
    const t = bridge.createTask({ title: '修登录页', assigneeId: a.agent.id })
    const line = lineOf(t.id)
    await call(a.c, 'whoami')
    await call(b.c, 'whoami')
    bridge.sendChat({ channel: line.id, text: '注册页先别动' })
    const wa = await call(a.c, 'whoami')
    expect(wa.notices).toContain('注册页先别动')
    expect(wa.notices).toContain('T-1 修登录页')
    const wb = await call(b.c, 'whoami')
    expect(wb.notices).not.toContain('注册页先别动')
    expect((await chan(a)).find((c) => c.id === line.id)?.unread).toBe(1)
    const read = await call(a.c, 'chat_read', { channel: 'T-1' })
    expect(read.raw).toContain('创建了任务 T-1')
    expect(read.raw).toContain('"event": true')
    expect(read.raw).toContain('注册页先别动')
  })

  it('AI 派给 AI：两个都在线里；认领、交付（带完整说明）、审查一条条记下来', async () => {
    const made = await call(a.c, 'task_create', { title: '写接口文档', description: '覆盖全部接口', assigneeId: 'Bob' })
    expect(made.isError).toBe(false)
    const line = lineOf(made.data.id)
    expect(made.data.chat_channel).toBe(line.id)
    expect(line.task?.memberIds.slice().sort()).toEqual([a.agent.id, b.agent.id].sort())
    expect((await chan(b)).find((c) => c.id === line.id)).toMatchObject({ task: 'T-1', unread: 0 })
    await call(b.c, 'task_update', { task: 'T-1', status: 'in_progress' })
    const long = `接口文档写完了。${'细节'.repeat(1200)}结尾`
    const done = await call(b.c, 'task_update', { task: 'T-1', status: 'review', result: long })
    expect(done.isError).toBe(false)
    const ok = await call(a.c, 'task_review', { task: 'T-1', decision: 'accept', note: '可以' })
    expect(ok.isError).toBe(false)
    const msgs = bridge.listChat({ channel: line.id })
    expect(msgs.every((m) => m.kind === 'event')).toBe(true)
    expect(msgs.map((m) => [m.from.name, m.text.split('\n')[0]])).toEqual([
      ['Alice', '创建了任务 T-1「写接口文档」（指派给 Bob）'],
      ['Bob', '把状态改成了「进行中」'],
      ['Bob', '做完了，提交审查'],
      ['Alice', '审查通过，任务完成']
    ])
    // 记录里的备注只留 2000 字，线里是完整的
    expect(msgs[2].text.endsWith('结尾')).toBe(true)
    expect(msgs[3].text).toBe('审查通过，任务完成\n\n可以')
    // 事件不算未读
    expect(lineOf(made.data.id).unread).toBe(0)
    expect((await chan(a)).find((c) => c.id === line.id)?.unread).toBe(0)
  })

  it('改派、改标题、删任务：线里的人、标题跟着变，删了线也没了（消息文件挪进 deleted/）', async () => {
    const t = bridge.createTask({ title: '修登录页', assigneeId: a.agent.id })
    const line = lineOf(t.id)
    bridge.assignTask(t.id, b.agent.id)
    expect(lineOf(t.id).task?.memberIds).toEqual([b.agent.id])
    expect((await chan(a)).some((c) => c.id === line.id)).toBe(false)
    expect((await chan(b)).some((c) => c.id === line.id)).toBe(true)
    expect(texts(line.id).at(-1)).toBe('把任务派给了 Bob')
    bridge.editTask(t.id, { title: '修登录页和注册页' })
    expect(lineOf(t.id).thread?.title).toBe('T-1 修登录页和注册页')
    expect(texts(line.id).at(-1)).toBe('改了任务的标题')
    // 线跟着任务走：不能单独改名、归档、删
    expect(() => bridge.renameChatThread(line.id, '别的名字')).toThrow(/任务 T-1 的线/)
    expect(() => bridge.archiveChatThread(line.id, true)).toThrow(/任务 T-1 的线/)
    expect(() => bridge.deleteChatChannel(line.id)).toThrow(/任务 T-1 的线/)
    bridge.deleteTask(t.id)
    expect(lines()).toEqual([])
    expect((await call(b.c, 'chat_send', { channel: line.id, text: 'x' })).isError).toBe(true)
    const gone = fs.readdirSync(path.join(base, 'data', 'chat', 'deleted'))
    expect(gone.some((d) => d.includes(`c_t${t.id.slice(2)}`))).toBe(true)
  })

  it('没派给谁的任务：线里只有用户；谁认领谁进来', async () => {
    const t = bridge.createTask({ title: '谁有空谁做' })
    expect(lineOf(t.id).task?.memberIds).toEqual([])
    expect((await chan(a)).some((c) => c.task === 'T-1')).toBe(false)
    expect((await call(a.c, 'task_claim', { task: 'T-1' })).isError).toBe(false)
    expect(lineOf(t.id).task?.memberIds).toEqual([a.agent.id])
    expect((await chan(a)).some((c) => c.task === 'T-1')).toBe(true)
    expect(texts(lineOf(t.id).id).at(-1)).toBe('认领了这个任务')
  })

  it('老任务（升级前就有的）：不补记以前的记录；有新动静或用户打开时才开线，只记之后的', async () => {
    const t1 = bridge.createTask({ title: '老任务一', assigneeId: a.agent.id })
    const t2 = bridge.createTask({ title: '老任务二', assigneeId: a.agent.id })
    const t3 = bridge.createTask({ title: '老任务三', assigneeId: a.agent.id })
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.stop()
    // 模拟升级前的数据：任务在，线一条都没有
    fs.rmSync(path.join(base, 'data', 'chat'), { recursive: true, force: true })
    bridge = new Bridge(opts())
    await bridge.start()
    url = bridge.getState().mcpUrl
    expect(bridge.listTasks().map((t) => t.title)).toEqual(['老任务一', '老任务二', '老任务三'])
    expect(lines()).toEqual([])
    // 用户打开任务一：现开，里面是空的
    const opened = bridge.taskChatThread(t1.id)
    expect(opened).toMatchObject({ task: { id: t1.id, ref: 'T-1', memberIds: [a.agent.id] }, unread: 0 })
    expect(texts(opened.id)).toEqual([])
    expect(bridge.taskChatThread(t1.id).id).toBe(opened.id)
    bridge.setTaskStatus(t1.id, 'blocked', '等设计稿')
    expect(texts(opened.id)).toEqual(['把状态改成了「卡住了」\n\n等设计稿'])
    // 任务二没人打开过：有了新动静才开，只有新的那条
    expect(lines().some((c) => c.task?.id === t2.id)).toBe(false)
    bridge.setTaskStatus(t2.id, 'in_progress')
    expect(texts(lineOf(t2.id).id)).toEqual(['把状态改成了「进行中」'])
    // AI 用编号找老任务的线也行（重连后）
    const c = await connect(a.agent.token)
    expect((await call(c, 'chat_send', { channel: 'T-2', text: '接着做' })).isError).toBe(false)
    // 任务三一直没动静：不在里面的 AI 看详情不会把线开出来，也拿不到 chat_channel；执行者一看详情就现开，拿到 chat_channel
    const cb = await connect(b.agent.token)
    expect((await call(cb, 'task_get', { task: 'T-3' })).data).not.toHaveProperty('chat_channel')
    expect(lines().some((x) => x.task?.id === t3.id)).toBe(false)
    const got = (await call(c, 'task_get', { task: 'T-3' })).data as { chat_channel?: string }
    expect(got.chat_channel).toBe(lineOf(t3.id).id)
    expect(texts(got.chat_channel as string)).toEqual([])
    expect((await call(cb, 'chat_read', { channel: got.chat_channel })).raw).toContain('CHANNEL_FORBIDDEN')
    expect(() => bridge.taskChatThread('t_nope000000')).toThrow()
  })

  it('退回旧版本再升回来：被旧版本弄成普通会话的线，打开工作区时认回来，别的 AI 又进不去了；定时任务不能往线里发', async () => {
    const t = bridge.createTask({ title: '修登录页', assigneeId: a.agent.id })
    const line = lineOf(t.id)
    bridge.sendChat({ channel: line.id, text: '线里的一句话' })
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.stop()
    const file = path.join(base, 'data', 'chat', 'threads.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const id of Object.keys(raw.threads)) raw.threads[id] = { title: raw.threads[id].title, createdAt: raw.threads[id].createdAt, archived: true }
    fs.writeFileSync(file, JSON.stringify(raw))
    bridge = new Bridge(opts())
    await bridge.start()
    url = bridge.getState().mcpUrl
    // 工作区还没被谁用到，Bob 先来读：这时就得已经进不去了
    const early = await connect(b.agent.token)
    expect((await call(early, 'chat_read', { channel: line.id })).raw).toContain('CHANNEL_FORBIDDEN')
    expect(JSON.stringify((await call(early, 'chat_channels')).data)).not.toContain(line.id)
    const back = lineOf(t.id)
    expect(back).toMatchObject({ id: line.id, task: { id: t.id, ref: 'T-1', memberIds: [a.agent.id] } })
    expect(back.thread?.archived).toBeUndefined()
    expect(bridge.getState().chat.channels.some((c) => c.id === line.id)).toBe(false)
    expect(texts(line.id)).toEqual(['创建了任务 T-1「修登录页」（指派给 Alice）', '线里的一句话'])
    const cb = await connect(b.agent.token)
    expect((await call(cb, 'chat_read', { channel: line.id })).raw).toContain('CHANNEL_FORBIDDEN')
    // 认回来之后新的记录接着记，以前的不重复
    bridge.setTaskStatus(t.id, 'in_progress')
    expect(texts(line.id)).toEqual(['创建了任务 T-1「修登录页」（指派给 Alice）', '线里的一句话', '把状态改成了「进行中」'])
    expect(() => bridge.saveSchedule({ name: '往线里发', schedule: { kind: 'daily', time: '09:00' }, action: { kind: 'chat', channel: line.id, text: 'x' }, enabled: true } as never)).toThrow(/任务 T-1 的线/)
  })
})

describe('界面：任务的线', () => {
  const ch = (over: Partial<GroupChannelInfo>): GroupChannelInfo => ({ id: 'x', name: 'x', unread: 0, mentions: 0, lastTs: 0, ...over })
  const line = ch({ id: 'ws:w_a.c_t0000000001', name: 'alpha / T-1 修登录页', workspaceId: 'w_a', unread: 3, mentions: 1, thread: { title: 'T-1 修登录页', createdAt: 1 }, task: { id: 't_0000000001', ref: 'T-1', memberIds: ['a_1'] } })
  const state = {
    activeWorkspaceId: 'w_a',
    workspaces: [{ id: 'w_a', name: 'alpha', root: 'D:/alpha', exists: true }],
    agents: [],
    chat: { unread: 1, mentions: 0, channels: [ch({ id: 'general', name: '大厅' }), ch({ id: 'ws:w_a', name: 'alpha', workspaceId: 'w_a', unread: 1 })], taskThreads: [line] }
  } as unknown as BridgeState

  it('不在频道列表里、不算进群聊角标；按 id、按任务都找得到', () => {
    expect(channelsOf(state).map((c) => c.id)).toEqual(['general', 'ws:w_a'])
    expect(chatTotals(state)).toEqual({ unread: 1, mentions: 0 })
    expect(channelInfo(state, line.id)).toBe(line)
    expect(channelInfo(state, 'ws:w_a')?.name).toBe('alpha')
    expect(channelInfo(state, 'ws:w_a.c_nope')).toBeUndefined()
    expect(taskThreadOf(state, 't_0000000001', 'w_a')).toBe(line)
    expect(taskThreadOf(state, 't_0000000001')).toBe(line)
    expect(taskThreadOf(state, 't_0000000001', 'w_other')).toBeUndefined()
    expect(taskThreadOf({ ...state, chat: { ...state.chat, taskThreads: undefined } } as BridgeState, 't_0000000001')).toBeUndefined()
  })

  it('消息流：事件和说的话不并成一组', () => {
    const m = (seq: number, kind?: 'event'): GroupMessage => ({ id: `m${seq}`, seq, channel: line.id, ts: 1_700_000_000_000 + seq * 1000, from: { kind: 'agent', id: 'a_1', name: 'A' }, text: 'x', mentions: [], ...(kind ? { kind } : {}) })
    const rows = buildRows([m(1, 'event'), m(2), m(3), m(4, 'event')]).filter((r) => r.kind === 'msg')
    expect(rows.map((r) => (r.kind === 'msg' ? r.first : null))).toEqual([true, true, false, true])
  })
})
