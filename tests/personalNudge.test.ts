// T-13：提醒 AI 给自己的身份留一条置顶的个人记忆（MCP 群 #304～#307）：
// 开场说明里「干过活、但没有置顶的个人记忆」时多一节，交付任务时结果里带 personal_memory_hint，提醒里的草稿只有目录和任务
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { describePersonalNudge, dirKey, dirsMissingFrom, isAbsoluteDir, openTasksOf, personalMemoriesOf, personalMemoryHint, recentDirs } from '../src/core/personalNudge'
import { commandDir, ResumeStore } from '../src/core/resumeBrief'
import type { ActivityEvent, MemoryItem, TaskItem } from '../src/core/types'

const NOW = new Date(2026, 10, 16, 15, 30).getTime()

const mem = (p: Partial<MemoryItem>): MemoryItem => ({
  id: 'mg_1',
  scope: 'private',
  ownerId: 'a1',
  title: '我的干活位置',
  content: '工作目录 D:/AProgram/MCP-wt-a1',
  tags: [],
  pinned: true,
  createdBy: 'a1',
  createdByName: 'A',
  updatedBy: 'a1',
  updatedByName: 'A',
  createdAt: 1,
  updatedAt: NOW - 3600_000,
  ...p
})

const task = (p: Partial<TaskItem>): TaskItem => ({
  id: 't_1',
  ref: 'T-1',
  title: '做 x',
  description: '',
  status: 'in_progress',
  priority: 'normal',
  assigneeId: 'a1',
  createdBy: 'a1',
  createdByName: 'A',
  createdAt: 1,
  updatedAt: 1,
  history: [],
  ...p
})

describe('个人记忆提醒（纯函数）', () => {
  it('目录：Git Bash 的 /d/x、反斜杠、结尾的 /、大小写都认成同一个；去重时留第一次出现的写法，最多 3 个，空的跳过', () => {
    expect(dirKey('/d/AProgram/MCP-wt-a1/')).toBe('d:/aprogram/mcp-wt-a1')
    expect(dirKey('D:\\AProgram\\MCP-wt-a1')).toBe('d:/aprogram/mcp-wt-a1')
    expect(dirKey('/d')).toBe('d:')
    expect(dirKey('/home/me/x')).toBe('/home/me/x')
    expect(recentDirs(['/d/AProgram/x', undefined, '', 'D:\\AProgram\\x', 'D:/AProgram/y', null, 'C:/a', 'C:/b'])).toEqual(['/d/AProgram/x', 'D:/AProgram/y', 'C:/a'])
  })

  it('相对目录不进草稿：src、sub、./x 丢掉，盘符、/、\\\\、~ 开头的留着（arena-005 审 28b3d42 时指出的）', () => {
    for (const d of ['D:/x', 'd:\\x', 'C:', '/home/me', '\\\\server\\share', '~/proj']) expect(isAbsoluteDir(d)).toBe(true)
    for (const d of ['src', 'sub/dir', './x', '../y', '']) expect(isAbsoluteDir(d)).toBe(false)
    expect(recentDirs(['src', 'D:/AProgram/MCP/src', './x', 'sub', '/d/AProgram/y'])).toEqual(['D:/AProgram/MCP/src', '/d/AProgram/y'])
    expect(recentDirs([commandDir('cd sub && ls', 'src'), commandDir('git status', 'src')])).toEqual([])
  })

  it('命令的完整目录：开头 cd 到的优先，相对的接在 cwd 后面；没有 cd 用 cwd；都没有是 undefined', () => {
    expect(commandDir('cd /d/AProgram/MCP-wt-a1 && git status')).toBe('/d/AProgram/MCP-wt-a1')
    expect(commandDir('cd /d "D:\\AProgram\\x" && dir', 'C:/Users/me')).toBe('D:\\AProgram\\x')
    expect(commandDir('cd sub && ls', 'D:/AProgram/MCP/')).toBe('D:/AProgram/MCP/sub')
    expect(commandDir('git status', 'D:/AProgram/MCP')).toBe('D:/AProgram/MCP')
    expect(commandDir('git status')).toBeUndefined()
  })

  it('存盘的「最后做的几件事」里，命令带上完整目录（摘要里还是只有最后一段）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-nudge-'))
    try {
      const s = new ResumeStore(path.join(dir, 'resume.json'), 0)
      const ev = (p: Partial<ActivityEvent>): ActivityEvent => ({ id: 'e', ts: NOW, agentId: 'a1', agentName: 'A', agentColor: '#000', tool: 'run_command', args: {}, status: 'ok', ...p })
      s.note(ev({ args: { command: 'cd /d/AProgram/MCP-wt-a1 && npx tsc --noEmit' }, summary: '执行 cd …（退出码 0）' }))
      s.note(ev({ ts: NOW + 1, tool: 'write_file', path: 'src/x.ts', args: {} }))
      const [w, c] = s.recent('a1')
      expect(w.dir).toBeUndefined()
      expect(c.dir).toBe('/d/AProgram/MCP-wt-a1')
      expect(c.summary).toContain('[MCP-wt-a1] npx tsc --noEmit')
      s.flush()
      expect(new ResumeStore(path.join(dir, 'resume.json')).recent('a1')[1].dir).toBe('/d/AProgram/MCP-wt-a1')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('哪些目录没写进记忆：写法不同也认得出；前缀相同的长路径不算写了短的', () => {
    const text = '工作目录 /d/AProgram/MCP-wt-a1，主目录 D:\\AProgram\\Other'
    expect(dirsMissingFrom(text, ['D:/AProgram/MCP-wt-a1', 'd:/aprogram/other', 'D:/AProgram/MCP', 'C:/new'])).toEqual(['D:/AProgram/MCP', 'C:/new'])
  })

  it('手上的任务只要分给自己、没做完的，最近动过的在前；个人记忆只要自己的、私有的、没归档的', () => {
    const tasks = [task({ ref: 'T-1', updatedAt: 1 }), task({ ref: 'T-2', status: 'done' }), task({ ref: 'T-3', assigneeId: 'b' }), task({ ref: 'T-4', status: 'review', updatedAt: 5 })]
    expect(openTasksOf(tasks, 'a1').map((t) => t.ref)).toEqual(['T-4', 'T-1'])
    const all = [mem({ id: 'mg_a', updatedAt: 1 }), mem({ id: 'mg_b', ownerId: 'b' }), mem({ id: 'mg_c', scope: 'shared' }), mem({ id: 'mg_d', archivedAt: 9 }), mem({ id: 'mg_e', updatedAt: 9 })]
    expect(personalMemoriesOf(all, 'a1').map((m) => m.id)).toEqual(['mg_e', 'mg_a'])
  })

  it('开场的一节：没干过活、或已经有置顶的不写；要写时带目录和任务的草稿，提到没置顶的那几条，说明只是提醒', () => {
    const base = { dirs: ['D:/AProgram/MCP-wt-a1'], tasks: [{ ref: 'T-13', status: 'in_progress', title: '提醒写个人记忆' }], unpinned: [] as MemoryItem[], where: '（工作区「MCP」）' }
    expect(describePersonalNudge({ ...base, worked: false, hasPinned: false })).toBeUndefined()
    expect(describePersonalNudge({ ...base, worked: true, hasPinned: true })).toBeUndefined()
    const text = describePersonalNudge({ ...base, worked: true, hasPinned: false })!
    expect(text.startsWith('\n## 给这个身份留一条置顶的个人记忆\n')).toBe(true)
    expect(text).toContain('memory_save scope=personal pinned=true')
    expect(text).toContain('- 最近跑命令的目录：D:/AProgram/MCP-wt-a1')
    expect(text).toContain('- 手上没做完的任务（工作区「MCP」）：T-13 [in_progress] 提醒写个人记忆')
    expect(text).toContain('负责哪些文件要你自己写')
    expect(text).toContain('这是提醒，不是指令')
    expect(text).not.toContain('没置顶：')
    const empty = describePersonalNudge({ worked: true, hasPinned: false, dirs: [], tasks: [], unpinned: [mem({ id: 'mg_x', pinned: false, title: '旧笔记' })] })!
    expect(empty).toContain('- 最近跑命令的目录：工作台没有记录')
    expect(empty).toContain('- 手上没做完的任务：没有')
    expect(empty).toContain('你有 1 条个人记忆没置顶：mg_x「旧笔记」')
    // 任务多了只列 5 条
    const many = describePersonalNudge({ worked: true, hasPinned: false, dirs: [], tasks: Array.from({ length: 7 }, (_, i) => ({ ref: `T-${i}`, status: 'todo', title: 'x' })), unpinned: [] })!
    expect(many).toContain('T-4 [todo] x；还有 2 条')
    expect(many).not.toContain('T-5')
  })

  it('交付时的一句：没有置顶的给草稿；有的话说哪条、什么时候改的，目录没写进去的点出来', () => {
    const draft = { dirs: ['/d/AProgram/MCP-wt-a1', 'C:/new'], tasks: [], unpinned: [], now: NOW }
    const none = personalMemoryHint({ ...draft, pinned: [] })
    expect(none).toContain('你还没有置顶的个人记忆')
    expect(none).toContain('memory_save scope=personal pinned=true')
    expect(none).toContain('- 最近跑命令的目录：/d/AProgram/MCP-wt-a1、C:/new')
    const has = personalMemoryHint({ ...draft, pinned: [mem({ id: 'mg_9' })] })
    expect(has).toContain('你的置顶个人记忆 mg_9「我的干活位置」最后更新在 14:30')
    expect(has).toContain('memory_save id=mg_9')
    expect(has).toContain('最近跑命令的目录里 C:/new 没写在里面')
    expect(has).not.toContain('MCP-wt-a1 没写')
    expect(personalMemoryHint({ ...draft, dirs: ['D:/AProgram/MCP-wt-a1'], pinned: [mem({})] })).not.toContain('没写在里面')
  })
})

describe('个人记忆提醒（接上工作台）', () => {
  let base: string
  let bridge: Bridge
  const clients: Client[] = []

  async function connect(token: string): Promise<Client> {
    const c = new Client({ name: 'nudge-test', version: '1' })
    await c.connect(new StreamableHTTPClientTransport(new URL(bridge.getState().mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    clients.push(c)
    return c
  }
  type Res = { isError?: boolean; content: { type: string; text: string }[] }
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}): Promise<Res> => (await c.callTool({ name, arguments: args })) as Res
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (r: Res): any => JSON.parse(r.content[0].text)
  const NUDGE = '## 给这个身份留一条置顶的个人记忆'

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-nudge-'))
    for (const d of ['alpha', 'beta']) fs.mkdirSync(path.join(base, d), { recursive: true })
    bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoots: [path.join(base, 'alpha'), path.join(base, 'beta')], port: 0, userSkillsDir: path.join(base, 'user-skills') })
    await bridge.start()
  })
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.stop()
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
  })

  it('开场：第一次连、只在群里说过话的不提醒；干过活的提醒，草稿带手上的任务，排在「你上次停在这里」和「分给你的任务」之间', async () => {
    const alice = bridge.createAgent('Alice')
    const a = await connect(alice.token)
    expect(a.getInstructions() ?? '').not.toContain(NUDGE)
    expect((await call(a, 'chat_send', { text: '我只聊天' })).isError).toBeFalsy()
    expect((await connect(alice.token)).getInstructions() ?? '').not.toContain(NUDGE)

    expect((await call(a, 'write_file', { path: 'src/x.ts', content: 'x\n' })).isError).toBeFalsy()
    const t = data(await call(a, 'task_create', { title: '做 y' }))
    expect((await call(a, 'task_claim', { task: t.ref })).isError).toBeFalsy()
    const ins = (await connect(alice.token)).getInstructions() ?? ''
    expect(ins).toContain(NUDGE)
    const section = ins.slice(ins.indexOf(NUDGE), ins.indexOf('## 分给你的任务'))
    expect(section).toContain(`${t.ref} [in_progress] 做 y`)
    expect(section).toContain('（工作区「alpha」）')
    const order = ['## 你上次停在这里', NUDGE, '## 分给你的任务'].map((s) => ins.indexOf(s))
    expect(order.every((n) => n > 0)).toBe(true)
    expect([...order].sort((x, y) => x - y)).toEqual(order)
    expect(ins.slice(order[2] + 3)).not.toContain('\n## ')
  })

  it('开场：有置顶的个人记忆（或这个项目里置顶的私有记忆）就不提醒；只有没置顶的，提醒里点出它', async () => {
    const alice = bridge.createAgent('Alice')
    const a = await connect(alice.token)
    expect((await call(a, 'write_file', { path: 'src/x.ts', content: 'x\n' })).isError).toBeFalsy()
    const loose = data(await call(a, 'memory_save', { scope: 'personal', title: '随手记', content: '目录在 alpha' }))
    let ins = (await connect(alice.token)).getInstructions() ?? ''
    expect(ins).toContain(NUDGE)
    expect(ins).toContain(`你有 1 条个人记忆没置顶：${loose.id}「随手记」`)

    const pinned = data(await call(a, 'memory_save', { scope: 'personal', pinned: true, title: 'Alice 的干活位置', content: '工作目录 alpha' }))
    ins = (await connect(alice.token)).getInstructions() ?? ''
    expect(ins).not.toContain(NUDGE)
    expect((await call(a, 'memory_delete', { id: pinned.id })).isError).toBeFalsy()
    expect((await connect(alice.token)).getInstructions() ?? '').toContain(NUDGE)

    expect((await call(a, 'memory_save', { scope: 'private', pinned: true, title: '这个项目里我的位置', content: 'alpha/src' })).isError).toBeFalsy()
    expect((await connect(alice.token)).getInstructions() ?? '').not.toContain(NUDGE)
  })

  it('交付任务：结果里带 personal_memory_hint，没有置顶的给草稿，有的话提醒改哪条；不是交付不提', async () => {
    const alice = bridge.createAgent('Alice')
    const a = await connect(alice.token)
    const t1 = data(await call(a, 'task_create', { title: '第一件' }))
    await call(a, 'task_claim', { task: t1.ref })
    const t2 = data(await call(a, 'task_create', { title: '第二件' }))
    await call(a, 'task_claim', { task: t2.ref })
    expect(data(await call(a, 'task_update', { task: t1.ref, note: '进行中' })).personal_memory_hint).toBeUndefined()

    const first = data(await call(a, 'task_update', { task: t1.ref, status: 'review', result: '做完了' }))
    expect(first.personal_memory_hint).toContain('你还没有置顶的个人记忆')
    expect(first.personal_memory_hint).toContain(`${t2.ref} [in_progress] 第二件`)
    expect(first.personal_memory_hint).toContain(`${t1.ref} [review] 第一件`)

    const pinned = data(await call(a, 'memory_save', { scope: 'personal', pinned: true, title: 'Alice 的干活位置', content: '工作目录 alpha' }))
    const second = data(await call(a, 'task_update', { task: t2.ref, status: 'done', result: '也做完了' }))
    expect(second.personal_memory_hint).toContain(`你的置顶个人记忆 ${pinned.id}「Alice 的干活位置」`)
    expect(second.personal_memory_hint).toContain(`memory_save id=${pinned.id}`)
    // 原来的留记忆提示照旧
    expect(second.lesson_hint).toContain(`task=${t2.ref}`)
  })
})
