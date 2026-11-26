// 换了会话的 AI 连上来时能拿到什么（用户 #69：对照 arena-006 的接入经历改记忆系统）：
// 开场说明里的「这个项目的资料」「你上次停在这里」，memory_search 搜不到时的提示，chat_read 的 from，交付任务时的留记忆提示
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bridge } from '../src/core/bridge'
import { ago, commandGist, commandWhere, describeProject, describeResume, findHandoffDocs, KEEP_CHANGES, KEEP_COMMANDS, looseSharedMemories, maskSecrets, pickResumeEvents, ResumeStore, stamp, trimResume } from '../src/core/resumeBrief'
import type { ActivityEvent, MemoryItem } from '../src/core/types'

const at = (y: number, mo: number, d: number, h: number, mi: number): number => new Date(y, mo - 1, d, h, mi).getTime()
const NOW = at(2026, 11, 15, 23, 50)

const mem = (p: Partial<MemoryItem>): MemoryItem => ({
  id: 'm_1',
  scope: 'shared',
  title: 't',
  content: 'c',
  tags: [],
  pinned: false,
  createdBy: 'a',
  createdByName: 'A',
  updatedBy: 'a',
  updatedByName: 'A',
  createdAt: 1,
  updatedAt: 1,
  ...p
})

const ev = (p: Partial<ActivityEvent>): ActivityEvent => ({ id: 'e', ts: NOW, agentId: 'a1', agentName: 'A', agentColor: '#000', tool: 'write_file', args: {}, status: 'ok', ...p })

describe('开场说明里的两段（纯函数）', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-resume-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('交接文档：只认根目录里那几个名字，不分大小写，空文件和同名目录不算，目录读不了返回空', () => {
    fs.writeFileSync(path.join(dir, 'handoff.md'), '# 交接')
    fs.writeFileSync(path.join(dir, 'README.md'), 'x')
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '')
    fs.mkdirSync(path.join(dir, 'PROJECT.md'))
    fs.writeFileSync(path.join(dir, 'notes.md'), 'x')
    // 有交接文档时不提 README
    expect(findHandoffDocs(dir).map((d) => d.name)).toEqual(['handoff.md'])
    expect(findHandoffDocs(path.join(dir, 'nope'))).toEqual([])
    // 只有 README：提一句，但不当交接文档
    fs.rmSync(path.join(dir, 'handoff.md'))
    const only = findHandoffDocs(dir)
    expect(only).toMatchObject([{ name: 'README.md', fallback: true }])
    const text = describeProject({ where: '', docs: only, memories: [], now: NOW })!
    expect(text).toContain('根目录没有交接文档，只有 README.md')
    expect(text).toContain('需要了解项目时再看')
    expect(text).not.toContain('开工前先用 read_file 读')
  })

  it('时间：同一天只写几点几分，别的日子带月日；多久以前说人话', () => {
    expect(stamp(at(2026, 11, 15, 9, 5), NOW)).toBe('09:05')
    expect(stamp(at(2026, 11, 14, 22, 45), NOW)).toBe('11-14 22:45')
    expect(ago(NOW - 30_000, NOW)).toBe('刚才')
    expect(ago(NOW - 12 * 60_000, NOW)).toBe('12 分钟前')
    expect(ago(NOW - 5 * 3600_000, NOW)).toBe('5 小时前')
    expect(ago(NOW - 3 * 86400_000, NOW)).toBe('3 天前')
  })

  it('没置顶的共享记忆：置顶的、私有的、归档的不列；只给 id 和标题，不给正文；多了说还有几条', () => {
    const all = [
      mem({ id: 'm_a', title: '接手先看这些', content: '正文不该出现', updatedAt: 5, updatedByName: 'arena-005' }),
      mem({ id: 'm_b', title: '置顶的', pinned: true }),
      mem({ id: 'm_c', title: '私有的', scope: 'private', ownerId: 'a1' }),
      mem({ id: 'm_d', title: '归档的', archivedAt: 9 }),
      ...Array.from({ length: 9 }, (_, i) => mem({ id: `m_x${i}`, title: `第 ${i} 条\n换行也压成一行`, updatedAt: 1 }))
    ]
    const loose = looseSharedMemories(all)
    expect(loose.map((m) => m.id)).toEqual(['m_a', ...Array.from({ length: 9 }, (_, i) => `m_x${i}`)])
    const text = describeProject({ where: '', docs: [{ name: 'HANDOFF.md', mtime: at(2026, 11, 15, 23, 40), size: 41_000 }], memories: loose, now: NOW })!
    expect(text).toContain('## 这个项目的资料')
    expect(text).toContain('HANDOFF.md（23:40 改过，40 KB）')
    expect(text).toContain('有 10 条共享记忆没有置顶')
    expect(text).toContain('  - m_a 接手先看这些（arena-005 写的）')
    expect(text).toContain('第 0 条 换行也压成一行')
    expect(text).toContain('还有 2 条')
    expect(text).not.toContain('正文不该出现')
    expect(text).not.toContain('置顶的')
    expect(describeProject({ where: '', docs: [], memories: [], now: NOW })).toBeUndefined()
  })

  it('最后做的几件事：只挑自己的、做完的、算「做了事」的工具，新的在前；连着改同一个文件只留一条；失败的标出来', () => {
    const events = [
      ev({ ts: 1, tool: 'write_file', path: 'a.ts', summary: '写入 a.ts' }),
      ev({ ts: 2, tool: 'read_file', path: 'a.ts' }),
      ev({ ts: 3, tool: 'write_file', path: 'b.ts', agentId: 'other' }),
      ev({ ts: 4, tool: 'edit_file', path: 'c.ts' }),
      ev({ ts: 5, tool: 'edit_file', path: 'c.ts' }),
      ev({ ts: 6, tool: 'run_command', summary: 'npm test', status: 'error' }),
      ev({ ts: 7, tool: 'run_command', status: 'running' }),
      ev({ ts: 8, tool: 'chat_wait' })
    ]
    expect(pickResumeEvents(events, 'a1').map((e) => `${e.ts}:${e.tool}:${e.path ?? ''}:${e.failed ? 'x' : ''}`)).toEqual(['6:run_command::x', '5:edit_file:c.ts:', '1:write_file:a.ts:'])
    expect(pickResumeEvents(events, 'a1', 1)).toHaveLength(1)
    expect(pickResumeEvents(events, 'nobody')).toEqual([])
  })

  it('摘要里手写的密钥再遮一道：XXX_KEY=值、password: 值、带引号的；普通的等号不动', () => {
    expect(maskSecrets('OPENAI_API_KEY=sk-abcdef123456 node run.js')).toBe('OPENAI_API_KEY=[已遮住] node run.js')
    expect(maskSecrets('curl -u me --password: "hunter2222" x')).toBe('curl -u me --password: [已遮住] x')
    expect(maskSecrets("set DB_PASSWD='p@ssw0rd!' && go")).toBe('set DB_PASSWD=[已遮住] && go')
    expect(maskSecrets('NODE_ENV=production npm run build --port=8765')).toBe('NODE_ENV=production npm run build --port=8765')
    const text = describeResume({ now: NOW, claims: [], running: 0, said: [], recent: [{ ts: NOW, tool: 'run_command', summary: 'MY_SECRET=abcd1234efgh npm test' }] })!
    expect(text).toContain('MY_SECRET=[已遮住] npm test')
    expect(text).not.toContain('abcd1234efgh')
  })

  it('最后做的几件事存盘：只收做完的、算做了事的；连着改同一个文件只留一条；每个身份最多留 12 条；重新打开还在；坏文件当空的', () => {
    const file = path.join(dir, 'data', 'resume.json')
    const s = new ResumeStore(file, 10_000)
    s.note(ev({ ts: 1, tool: 'write_file', path: 'a.ts', summary: '写入 a.ts', workspaceId: 'w1' }))
    s.note(ev({ ts: 2, tool: 'write_file', path: 'a.ts', status: 'running' }))
    s.note(ev({ ts: 3, tool: 'read_file', path: 'a.ts' }))
    s.note(ev({ ts: 4, tool: 'edit_file', path: 'c.ts' }))
    s.note(ev({ ts: 5, tool: 'edit_file', path: 'c.ts', status: 'error' }))
    s.note(ev({ ts: 6, tool: 'run_command', summary: 'API_KEY=abcdef123456 npm test', agentId: 'b2' }))
    expect(s.recent('a1')).toEqual([
      { ts: 5, tool: 'edit_file', path: 'c.ts', failed: true, times: 2 },
      { ts: 1, tool: 'write_file', path: 'a.ts', summary: '写入 a.ts', workspace: 'w1' }
    ])
    expect(s.recent('b2')).toEqual([{ ts: 6, tool: 'run_command', summary: 'API_KEY=[已遮住] npm test' }])
    expect(s.recent('nobody')).toEqual([])
    // 还没到写盘的时候：文件还不在；flush 以后在，而且里面没有密钥
    expect(fs.existsSync(file)).toBe(false)
    s.flush()
    expect(fs.readFileSync(file, 'utf8')).not.toContain('abcdef123456')
    const again = new ResumeStore(file)
    expect(again.recent('a1')).toEqual(s.recent('a1'))
    // 命令和改动分开算名额：跑了 20 条命令，只留最新 6 条，之前改的两个文件还在
    for (let i = 0; i < 20; i++) again.note(ev({ ts: 100 + i, tool: 'run_command', summary: `第 ${i} 条` }))
    expect(again.recent('a1').filter((e) => e.tool === 'run_command')).toHaveLength(KEEP_COMMANDS)
    expect(again.recent('a1')[0].summary).toBe('第 19 条')
    expect(again.recent('a1').filter((e) => e.tool !== 'run_command').map((e) => e.path)).toEqual(['c.ts', 'a.ts'])
    // 反过来改了很多文件，命令也不会被挤掉
    for (let i = 0; i < 30; i++) again.note(ev({ ts: 200 + i, tool: 'write_file', path: `f${i}.ts` }))
    expect(again.recent('a1').filter((e) => e.tool !== 'run_command')).toHaveLength(KEEP_CHANGES)
    expect(again.recent('a1').filter((e) => e.tool === 'run_command')).toHaveLength(KEEP_COMMANDS)
    expect(again.recent('a1').map((e) => e.ts)).toEqual([...again.recent('a1').map((e) => e.ts)].sort((x, y) => y - x))
    again.forget('a1')
    expect(new ResumeStore(file).recent('a1')).toEqual([])
    expect(new ResumeStore(file).recent('b2')).toHaveLength(1)
    fs.writeFileSync(file, '{ 坏的')
    expect(new ResumeStore(file).recent('b2')).toEqual([])
    fs.writeFileSync(file, JSON.stringify({ version: 2, agents: { b2: 'x', c3: [{ ts: 'bad' }, null, { ts: 9, tool: 'move' }] } }))
    expect(new ResumeStore(file).recent('b2')).toEqual([])
    expect(new ResumeStore(file).recent('c3')).toEqual([{ ts: 9, tool: 'move' }])
    // 第 36 批的旧写法（没有 version，身份直接在最外层）：不认
    fs.writeFileSync(file, JSON.stringify({ c3: [{ ts: 9, tool: 'move' }] }))
    expect(new ResumeStore(file).recent('c3')).toEqual([])
  })

  it('第一次用时从审计文件补最近几天的：只补比启动后新记的更旧的；已经有存盘文件就不补；坏行跳过', async () => {
    const audit = path.join(dir, 'audit')
    fs.mkdirSync(audit)
    const line = (p: Partial<ActivityEvent>): string => JSON.stringify(ev(p))
    fs.writeFileSync(path.join(audit, '2026-11-14.jsonl'), [line({ ts: 10, tool: 'write_file', path: 'old.ts' }), '{ 坏行 "tool":"write_file"', line({ ts: 11, tool: 'read_file', path: 'r.ts' })].join('\n') + '\n')
    fs.writeFileSync(path.join(audit, '2026-11-15.jsonl'), [line({ ts: 20, tool: 'run_command', summary: 'npm test' }), line({ ts: 21, tool: 'edit_file', path: 'b.ts', agentId: 'b2' }), line({ ts: 60, tool: 'move', path: 'late.ts' })].join('\n') + '\n')
    fs.writeFileSync(path.join(audit, 'notes.txt'), line({ ts: 30, tool: 'delete', path: 'x' }))
    const file = path.join(dir, 'resume.json')
    const s = new ResumeStore(file, 10_000)
    // 启动后已经记了一条（ts=50）：审计里更晚的那条（ts=60，其实就是它自己那一类）不重复补，只补更旧的
    s.note(ev({ ts: 50, tool: 'write_file', path: 'new.ts' }))
    expect(await s.seedFromAudit(audit)).toBe(2)
    expect(s.recent('a1').map((e) => `${e.ts}:${e.tool}`)).toEqual(['50:write_file', '20:run_command', '10:write_file'])
    expect(s.recent('b2').map((e) => `${e.ts}:${e.tool}`)).toEqual(['21:edit_file'])
    expect(s.agentIds().sort()).toEqual(['a1', 'b2'])
    expect(fs.existsSync(file)).toBe(true)
    // 第二次打开：文件已经在了，不再补
    const again = new ResumeStore(file)
    fs.appendFileSync(path.join(audit, '2026-11-15.jsonl'), line({ ts: 70, tool: 'delete', path: 'z.ts' }) + '\n')
    expect(await again.seedFromAudit(audit)).toBe(0)
    expect(again.recent('a1')).toHaveLength(3)
    expect(await new ResumeStore(path.join(dir, 'other.json')).seedFromAudit(path.join(dir, 'no-audit'))).toBe(0)
    // 旧写法的存盘文件：当成第一次用，从审计重新补（旧文件里改动可能已经被命令挤掉了）
    const oldFile = path.join(dir, 'old.json')
    fs.writeFileSync(oldFile, JSON.stringify({ a1: [{ ts: 65, tool: 'run_command', summary: '旧的' }] }))
    const upgraded = new ResumeStore(oldFile)
    expect(await upgraded.seedFromAudit(audit)).toBe(2)
    expect(upgraded.recent('a1').map((e) => `${e.ts}:${e.tool}`)).toEqual(['70:delete', '60:move', '20:run_command', '10:write_file'])
    expect(JSON.parse(fs.readFileSync(oldFile, 'utf8')).version).toBe(2)
  })

  it('命令的一句话：去掉开头的括号和 cd，把真正的命令露出来；存盘时用它换掉活动记录里被 cd 占满的摘要，结果留着', () => {
    expect(commandGist('(cd /d/AProgram/MCP && node _smoke_out/arena-sbx/live-check.mjs a b) > out.txt 2>&1')).toBe('node _smoke_out/arena-sbx/live-check.mjs a b) > out.txt 2>&1')
    expect(commandGist('cd /d "D:\\A Program\\MCP" && npx vitest run')).toBe('npx vitest run')
    expect(commandGist("cd 'my dir'; cd sub && git status")).toBe('git status')
    expect(commandGist('git show c418f60 --stat')).toBe('git show c418f60 --stat')
    expect(commandGist('cdrom --eject')).toBe('cdrom --eject')
    const s = new ResumeStore(path.join(dir, 'gist.json'), 10_000)
    s.note(ev({ ts: 1, tool: 'run_command', args: { command: '(cd /d/AProgram/MCP && MY_TOKEN=abcd1234efgh npm run typecheck 2>&1 | tail -3)' }, summary: '执行 (cd /d/AProgram/MCP && MY_TOK…（退出码 0）' }))
    s.note(ev({ ts: 2, tool: 'run_command', args: { command: 'sleep 3; echo ok' }, summary: '执行 sleep 3; echo ok（仍在运行）' }))
    s.note(ev({ ts: 3, tool: 'run_command', args: {}, summary: '执行 没有参数的（退出码 1）', status: 'error' }))
    s.note(ev({ ts: 4, tool: 'run_command', args: { command: 'git reset --hard', cwd: 'D:\\AProgram\\MCP-wt-arena006\\' }, summary: '执行 git reset --hard（退出码 0）' }))
    expect(s.recent('a1').map((e) => e.summary)).toEqual([
      '[MCP-wt-arena006] git reset --hard（退出码 0）',
      '执行 没有参数的（退出码 1）',
      'sleep 3; echo ok（仍在运行）',
      '[MCP] MY_TOKEN=[已遮住] npm run typecheck 2>&1 | tail -3)（退出码 0）'
    ])
    // 去掉 cd 以后还看得出在哪跑的：只给目录的最后一段；命令里的 cd 比调用时给的 cwd 优先
    expect(commandWhere('cd /d "D:\\A Program\\MCP" && npx vitest run')).toBe('MCP')
    expect(commandWhere("cd 'my dir'; cd sub/deep/ && git status", 'D:/else')).toBe('deep')
    expect(commandWhere('git status', '/home/me/proj')).toBe('proj')
    expect(commandWhere('git status')).toBeUndefined()
  })

  it('同一个文件连着改只占一个名额，中间隔着命令也算；换了文件或换了工具才另起一条', () => {
    const s = new ResumeStore(path.join(dir, 'collapse.json'), 10_000)
    s.note(ev({ ts: 1, tool: 'edit_file', path: 'a.ts' }))
    s.note(ev({ ts: 2, tool: 'run_command', summary: 'npm test（退出码 1）' }))
    s.note(ev({ ts: 3, tool: 'edit_file', path: 'a.ts' }))
    s.note(ev({ ts: 4, tool: 'run_command', summary: 'npm test（退出码 0）' }))
    s.note(ev({ ts: 5, tool: 'edit_file', path: 'a.ts', summary: '第三次' }))
    expect(s.recent('a1').map((e) => `${e.ts}:${e.tool}`)).toEqual(['5:edit_file', '4:run_command', '2:run_command'])
    // 合并后的摘要是最后一次的，另外记着一共几次，开场里写出来
    expect(s.recent('a1')[0].times).toBe(3)
    expect(describeResume({ now: 10_000, recent: s.recent('a1'), said: [], claims: [], running: 0 })!).toContain('第三次（连着 3 次，这是最后一次）')
    // 命令很长时截的是命令，结尾的退出码留着，开场里也看得到
    s.note(ev({ ts: 4.5, tool: 'run_command', args: { command: `cd /d/AProgram/MCP && npx vitest run ${'tests/aVeryLongName.test.ts '.repeat(8)}` }, summary: '执行 cd /d/AProgram/MCP && npx…（退出码 1）' }))
    const long = s.recent('a1').find((e) => e.ts === 4.5)!
    expect(long.summary).toMatch(/^\[MCP\] npx vitest run tests\/aVeryLongName.*…（退出码 1）$/)
    expect(long.summary!.length).toBeLessThanOrEqual(130)
    expect(describeResume({ now: 10_000, recent: s.recent('a1'), said: [], claims: [], running: 0 })!).toContain('…（退出码 1）')
    s.note(ev({ ts: 6, tool: 'edit_file', path: 'b.ts' }))
    s.note(ev({ ts: 7, tool: 'edit_file', path: 'a.ts' }))
    s.note(ev({ ts: 8, tool: 'write_file', path: 'a.ts' }))
    expect(s.recent('a1').filter((e) => e.tool !== 'run_command').map((e) => `${e.ts}:${e.tool}:${e.path}:${e.times ?? 1}`)).toEqual(['8:write_file:a.ts:1', '7:edit_file:a.ts:1', '6:edit_file:b.ts:1', '5:edit_file:a.ts:3'])
  })

  it('名额：改动最多 10 条、命令最多 6 条，各算各的，顺序不变', () => {
    const mixed = Array.from({ length: 40 }, (_, i) => ({ ts: 100 - i, tool: i % 2 ? 'run_command' : 'edit_file', path: i % 2 ? undefined : `f${i}.ts` }))
    const kept = trimResume(mixed)
    expect(kept.filter((e) => e.tool === 'run_command')).toHaveLength(KEEP_COMMANDS)
    expect(kept.filter((e) => e.tool === 'edit_file')).toHaveLength(KEEP_CHANGES)
    expect(kept.map((e) => e.ts)).toEqual([...kept.map((e) => e.ts)].sort((x, y) => y - x))
    expect(kept[0].ts).toBe(100)
  })

  it('开场里改动和命令分开列：改动给 5 条、命令给 2 条，多的说还有几条没列；只有命令时不出现改动那一行', () => {
    const recent = [
      ...Array.from({ length: 4 }, (_, i) => ({ ts: NOW - i * 60_000, tool: 'run_command', summary: `git show ${i}（退出码 0）` })),
      ...Array.from({ length: 7 }, (_, i) => ({ ts: NOW - (10 + i) * 60_000, tool: 'edit_file', path: `src/f${i}.ts`, summary: '改了 3 行' }))
    ]
    const text = describeResume({ now: NOW, claims: [], running: 0, said: [], recent })!
    const iChanges = text.indexOf('- 最后改动的（文件、任务、记忆；新的在前，更早的 2 条没列）：')
    const iCommands = text.indexOf('- 最后跑的命令（新的在前，更早的 2 条没列）：')
    expect(iChanges).toBeGreaterThan(0)
    expect(iCommands).toBeGreaterThan(iChanges)
    expect(text.slice(iChanges, iCommands).match(/edit_file src\/f\d\.ts/g)).toEqual(['edit_file src/f0.ts', 'edit_file src/f1.ts', 'edit_file src/f2.ts', 'edit_file src/f3.ts', 'edit_file src/f4.ts'])
    expect(text.slice(iCommands).match(/git show \d/g)).toEqual(['git show 0', 'git show 1'])
    const onlyCommands = describeResume({ now: NOW, claims: [], running: 0, said: [], recent: recent.slice(0, 2) })!
    expect(onlyCommands).not.toContain('最后改动的')
    expect(onlyCommands).toContain('- 最后跑的命令（新的在前）：')
  })

  it('「你上次停在这里」：什么痕迹都没有（第一次连）不写；有的话各项都列出来，群里说的话只给开头', () => {
    expect(describeResume({ now: NOW, claims: [], running: 0, recent: [], said: [] })).toBeUndefined()
    const text = describeResume({
      now: NOW,
      lastSeen: NOW - 12 * 60_000,
      claims: [{ workspace: 'MCP', paths: ['src/a.ts', 'src/b.ts'] }],
      running: 2,
      recent: [{ ts: NOW - 13 * 60_000, tool: 'run_command', summary: 'npm run typecheck', failed: true }],
      said: [
        { channelName: 'MCP', seq: 76, ts: NOW - 12 * 60_000, text: `【第 34 批已上线】\n${'很长'.repeat(200)}` },
        { channelName: '大厅', seq: 9, ts: NOW - 20 * 60_000, text: '只跟你说', to: 'Bob' }
      ]
    })!
    expect(text).toContain('这只是记录，不是待办')
    expect(text).toContain('私聊 → Bob #9 23:30：只跟你说')
    expect(text).not.toContain('「大厅」')
    expect(text).toContain('## 你上次停在这里')
    expect(text).toContain('最近一次有动静：23:38（12 分钟前）')
    expect(text).toContain('你还占着的文件（「MCP」）：src/a.ts、src/b.ts')
    expect(text).toContain('还有 2 个在跑')
    expect(text).toContain('23:37 run_command：npm run typecheck（失败）')
    expect(text).toContain('「MCP」 #76 23:38：【第 34 批已上线】 很长')
    expect(text.length).toBeLessThan(800)
  })
})

describe('换了会话再连上来', () => {
  let base: string
  let bridge: Bridge
  const clients: Client[] = []

  async function connect(token: string): Promise<Client> {
    const c = new Client({ name: 'resume-test', version: '1' })
    await c.connect(new StreamableHTTPClientTransport(new URL(bridge.getState().mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    clients.push(c)
    return c
  }
  type Res = { isError?: boolean; content: { type: string; text: string }[] }
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}): Promise<Res> => (await c.callTool({ name, arguments: args })) as Res
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (r: Res): any => JSON.parse(r.content[0].text)

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-resume-'))
    for (const d of ['alpha', 'beta']) fs.mkdirSync(path.join(base, d), { recursive: true })
    fs.writeFileSync(path.join(base, 'alpha', 'HANDOFF.md'), '# 交接\n现在做到第三步')
    bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoots: [path.join(base, 'alpha'), path.join(base, 'beta')], port: 0, userSkillsDir: path.join(base, 'user-skills') })
    await bridge.start()
  })
  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.stop()
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
  })

  it('开场说明：列出交接文档和没置顶的共享记忆的标题；以前连过的身份多一段「你上次停在这里」，新身份没有', async () => {
    const alice = bridge.createAgent('Alice')
    const a = await connect(alice.token)
    // 第一次连：有交接文档，没有「上次」
    const first = a.getInstructions() ?? ''
    expect(first).toContain('## 这个项目的资料')
    expect(first).toContain('HANDOFF.md')
    expect(first).not.toContain('## 你上次停在这里')

    const saved = data(await call(a, 'memory_save', { scope: 'shared', title: '上线的规矩', content: '正文只能用 memory_read 看' }))
    expect((await call(a, 'write_file', { path: 'src/x.ts', content: 'export const x = 1\n' })).isError).toBeFalsy()
    expect((await call(a, 'chat_send', { text: '我把 x.ts 写好了，下一步接着做 y' })).isError).toBeFalsy()
    const t = data(await call(a, 'task_create', { title: '做 y' }))
    expect((await call(a, 'task_claim', { task: t.ref })).isError).toBeFalsy()

    const ins = (await connect(alice.token)).getInstructions() ?? ''
    expect(ins).toContain(`  - ${saved.id} 上线的规矩（Alice 写的）`)
    expect(ins).not.toContain('正文只能用 memory_read 看')
    expect(ins).toContain('## 你上次停在这里')
    const resume = ins.slice(ins.indexOf('## 你上次停在这里'), ins.indexOf('## 分给你的任务'))
    expect(resume).toContain('最近一次有动静')
    expect(resume).toContain('write_file src/x.ts')
    expect(resume).toContain('memory_save')
    expect(resume).toContain('我把 x.ts 写好了，下一步接着做 y')
    // 顺序：资料 → 上次停在哪 → 分给你的任务（任务还是最后一段）
    const order = ['## 这个项目的资料', '## 你上次停在这里', '## 分给你的任务'].map((s) => ins.indexOf(s))
    expect(order.every((n) => n > 0)).toBe(true)
    expect([...order].sort((x, y) => x - y)).toEqual(order)
    expect(ins.slice(order[2] + 3)).not.toContain('\n## ')

    // 另一个身份：看得到项目资料（包括 Alice 存的共享记忆），没有 Alice 的「上次」
    const bob = bridge.createAgent('Bob')
    const insBob = (await connect(bob.token)).getInstructions() ?? ''
    expect(insBob).toContain(`  - ${saved.id} 上线的规矩（Alice 写的）`)
    expect(insBob).not.toContain('## 你上次停在这里')
    expect(insBob).not.toContain('我把 x.ts 写好了')
  })

  it('用户收回「整台电脑」以后，以前在那边做的事不再出现在「你上次停在这里」；私聊标成私聊', async () => {
    const alice = bridge.createAgent('Alice')
    const bob = bridge.createAgent('Bob')
    await bridge.updateAgent(alice.id, { machineAccess: true })
    const a = await connect(alice.token)
    const outside = path.join(base, 'outside-secret.txt').split(path.sep).join('/')
    expect((await call(a, 'write_file', { workspace: '整台电脑', path: outside, content: 'x' })).isError).toBeFalsy()
    expect((await call(a, 'write_file', { path: 'inside.txt', content: 'x' })).isError).toBeFalsy()
    expect((await call(a, 'chat_send', { channel: 'general', to: bob.name, text: '只跟 Bob 说的话' })).isError).toBeFalsy()
    const withMachine = (await connect(alice.token)).getInstructions() ?? ''
    expect(withMachine).toContain('outside-secret.txt')
    expect(withMachine).toContain('私聊 → Bob')
    await bridge.updateAgent(alice.id, { machineAccess: false })
    const after = (await connect(alice.token)).getInstructions() ?? ''
    expect(after).toContain('write_file inside.txt')
    expect(after).not.toContain('outside-secret.txt')
  })

  it('工作台重启以后，「最后做的几件事」还在（存盘的）；删掉的身份不留记录', async () => {
    const alice = bridge.createAgent('Alice')
    const bob = bridge.createAgent('Bob')
    const a = await connect(alice.token)
    expect((await call(a, 'write_file', { path: 'src/before-restart.ts', content: 'x' })).isError).toBeFalsy()
    const b = await connect(bob.token)
    expect((await call(b, 'write_file', { path: 'src/bob.ts', content: 'x' })).isError).toBeFalsy()
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    await bridge.removeAgent(bob.id)
    await bridge.stop()
    const file = path.join(base, 'data', 'resume.json')
    const onDisk = fs.readFileSync(file, 'utf8')
    expect(onDisk).toContain('src/before-restart.ts')
    expect(onDisk).not.toContain('src/bob.ts')
    expect(onDisk).not.toContain(alice.token)

    bridge = new Bridge({ dataDir: path.join(base, 'data'), workspaceRoots: [path.join(base, 'alpha'), path.join(base, 'beta')], port: 0, userSkillsDir: path.join(base, 'user-skills') })
    await bridge.start()
    const ins = (await connect(alice.token)).getInstructions() ?? ''
    expect(ins).toContain('## 你上次停在这里')
    expect(ins).toContain('write_file src/before-restart.ts')
    expect(ins).toContain('存盘的，工作台重启过也在')
  })

  it('占着的文件写进「你上次停在这里」', async () => {
    const alice = bridge.createAgent('Alice')
    const a = await connect(alice.token)
    const r = await call(a, 'claim_files', { paths: ['src/keep.ts'] })
    expect(r.isError).toBeFalsy()
    const ins = (await connect(alice.token)).getInstructions() ?? ''
    expect(ins).toContain('你还占着的文件（「alpha」）：src/keep.ts')
  })

  it('memory_search 一条都没有时多给一块提示：是这里本来没有，还是有但没对上；有结果时不多话', async () => {
    const alice = bridge.createAgent('Alice')
    const a = await connect(alice.token)
    const none = await call(a, 'memory_search', { query: '上线' })
    expect(data(none)).toEqual([])
    expect(none.content[1]?.text).toContain('还没有你能看到的记忆')
    expect(none.content[1]?.text).toContain('「beta」')

    await call(a, 'memory_save', { scope: 'shared', title: '上线的规矩', content: '全套检查通过才切换' })
    const miss = await call(a, 'memory_search', { query: 'zzzz-对不上的词' })
    expect(data(miss)).toEqual([])
    expect(miss.content[1]?.text).toContain('没对上')
    expect(miss.content[1]?.text).toContain('你能看到 1 条记忆')

    const hit = await call(a, 'memory_search', { query: '上线' })
    expect(data(hit)).toHaveLength(1)
    expect(hit.content.filter((c) => c.text.startsWith('【提示】'))).toEqual([])

    // 别的工作区是分开的：那边没有
    const other = await call(a, 'memory_search', { workspace: 'beta' })
    expect(data(other)).toEqual([])
    expect(other.content[1]?.text).toContain('工作区「beta」里还没有')
  })

  it('chat_read 的 from：me 是自己、user 是用户、也能写成员名字；不动已读位置；找不到的人报 NOT_FOUND', async () => {
    const alice = bridge.createAgent('Alice')
    const bob = bridge.createAgent('Bob')
    const a = await connect(alice.token)
    const b = await connect(bob.token)
    await call(a, 'chat_send', { text: 'a 的第一句' })
    await call(b, 'chat_send', { text: 'b 的一句' })
    await call(a, 'chat_send', { text: 'a 的第二句' })

    // 不给频道的 chat_send 发在默认工作区的频道里
    const mine = data(await call(a, 'chat_read', { channel: 'alpha', from: 'me' }))
    expect(mine.messages.map((m: { text: string }) => m.text)).toEqual(['a 的第一句', 'a 的第二句'])
    expect(data(await call(a, 'chat_read', { channel: 'general', from: 'me' })).messages).toEqual([])
    const last = data(await call(a, 'chat_read', { from: 'me', limit: 1 }))
    expect(last.messages.map((m: { text: string }) => m.text)).toEqual(['a 的第二句'])
    const bobs = data(await call(a, 'chat_read', { from: 'Bob' }))
    expect(bobs.messages.map((m: { text: string }) => m.text)).toEqual(['b 的一句'])
    // 上面几次都没动已读位置：正常读还能读到 Bob 那句
    const unread = data(await call(a, 'chat_read', {}))
    expect(unread.messages.map((m: { text: string }) => m.text)).toEqual(['b 的一句'])
    const bad = await call(a, 'chat_read', { from: '没有这个人' })
    expect(bad.isError).toBe(true)
    expect(data(bad).error).toBe('NOT_FOUND')
  })

  it('交付任务时没留过记忆就提示一句；带了 lesson 或已经有挂在任务上的记忆就不提', async () => {
    const alice = bridge.createAgent('Alice')
    const a = await connect(alice.token)
    const t1 = data(await call(a, 'task_create', { title: '第一件' }))
    await call(a, 'task_claim', { task: t1.ref })
    const plain = await call(a, 'task_update', { task: t1.ref, status: 'review', result: '做完了' })
    expect(plain.isError).toBeFalsy()
    expect(data(plain).lesson_hint).toContain(`task=${t1.ref}`)

    const t2 = data(await call(a, 'task_create', { title: '第二件' }))
    await call(a, 'task_claim', { task: t2.ref })
    const withLesson = data(await call(a, 'task_update', { task: t2.ref, status: 'review', result: '做完了', lesson: '端口要随机挑' }))
    expect(withLesson.lesson_memory).toBeTruthy()
    expect(withLesson.lesson_hint).toBeUndefined()

    // 只改备注不算交付：不提示
    const t3 = data(await call(a, 'task_create', { title: '第三件' }))
    await call(a, 'task_claim', { task: t3.ref })
    expect(data(await call(a, 'task_update', { task: t3.ref, note: '进行中' })).lesson_hint).toBeUndefined()
  })
})
