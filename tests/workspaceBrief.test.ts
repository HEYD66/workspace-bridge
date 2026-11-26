// 优化第 10 条：开工简报（T-17）
import { describe, expect, it } from 'vitest'
import { buildWorkspaceBrief, BRIEF_SECTIONS, type BriefInput } from '../src/core/workspaceBrief'
import type { GroupMessage, MemoryItem, TaskItem } from '../src/core/types'
import type { ClaimSummary } from '../src/core/fileClaims'
import { ToolError } from '../src/core/fileTools'

const NOW = new Date(2026, 10, 13, 20, 40).getTime()
const MIN = 60_000
const ME = { id: 'a_me', name: '玛雅02' }
const names = { a_me: '玛雅02', a_boss: 'arena-003', a_x: 'codex001' }

function mem(id: string, title: string, content = '', extra: Partial<MemoryItem> = {}): MemoryItem {
  return { id, scope: 'shared', title, content, tags: [], pinned: false, createdBy: 'user', createdByName: '用户', updatedBy: 'user', updatedByName: '用户', createdAt: NOW, updatedAt: NOW, ...extra }
}

let seqTask = 0
function task(ref: string, extra: Partial<TaskItem> = {}): TaskItem {
  seqTask++
  return { id: `t_${ref}`, ref, title: `${ref} 标题`, description: `${ref} 说明`, status: 'todo', priority: 'normal', createdBy: 'a_boss', createdByName: 'arena-003', createdAt: NOW, updatedAt: NOW - seqTask * MIN, history: [], ...extra }
}

function msg(seq: number, text: string, extra: Partial<GroupMessage> = {}): GroupMessage {
  return { id: `m_${seq}`, seq, channel: 'ws:w_1', ts: NOW - (100 - seq) * MIN, from: { kind: 'agent', id: 'a_x', name: 'codex001' }, text, mentions: [], ...extra }
}

function claims(): ClaimSummary {
  return {
    claims: [
      { id: 'fc_1', agentId: 'a_x', agentName: 'codex001', task: 'T-12', paths: ['src/core/screenshot.ts'], kind: 'explicit', since: NOW - 10 * MIN, expiresAt: NOW + 20 * MIN },
      { id: 'fc_2', agentId: 'a_me', agentName: '玛雅02', task: null, paths: ['src/core/workspaceBrief.ts'], kind: 'implicit', since: NOW, expiresAt: NOW + 10 * MIN }
    ],
    byAgent: { codex001: ['src/core/screenshot.ts'], 玛雅02: ['src/core/workspaceBrief.ts'] }
  }
}

function input(extra: Partial<BriefInput> = {}): BriefInput {
  return {
    me: ME,
    workspace: { id: 'w_1', name: '整台电脑' },
    now: NOW,
    names,
    pinned: [mem('mem_rule', '协作规范', '只 commit 自己的文件\n不 push', { pinned: true })],
    memories: [mem('mem_rule', '协作规范', '', { pinned: true }), mem('mem_a', '打包步骤', '', { updatedAt: NOW - MIN }), mem('mem_b', '我的笔记', '', { scope: 'private', ownerId: 'a_me', updatedAt: NOW })],
    tasks: [
      task('T-17', { assigneeId: 'a_me', status: 'in_progress', priority: 'high' }),
      task('T-20', { assigneeId: 'a_me', status: 'todo' }),
      task('T-18', { assigneeId: 'a_x', status: 'review', createdBy: 'a_me', result: '改好了，测试全过' }),
      task('T-12', { assigneeId: 'a_x', status: 'review' }),
      task('T-15', { status: 'todo' }),
      task('T-9', { assigneeId: 'a_x', status: 'done' })
    ],
    messages: [msg(98, '@玛雅02 T-17 派给你了', { mentions: ['a_me'], from: { kind: 'agent', id: 'a_boss', name: 'arena-003' } }), msg(97, '第二批候选先不切换'), msg(99, '收到', { kind: 'receipt' })],
    unread: 2,
    claims: claims(),
    unclaimed: ['src/main/index.ts'],
    ...extra
  }
}

describe('buildWorkspaceBrief 内容和顺序', () => {
  it('七节按固定顺序出现，文本和 JSON 一致', () => {
    const { text, json } = buildWorkspaceBrief(input())
    expect(text.startsWith('# 开工简报 · 整台电脑（玛雅02，11-13 20:40）')).toBe(true)
    const heads = text.split('\n').filter((l) => l.startsWith('## '))
    expect(heads).toEqual([
      '## 置顶规范（1 条）',
      '## 我手上的任务和等我审的（我的 2，待我审 1）',
      '## 其他没结的任务（2）',
      '## 最近消息（未读 2，共 2 条）',
      '## 文件占用（2）',
      '## 谁也没登记的改动（1）',
      '## 记忆索引（2）'
    ])
    expect(Object.keys(json.sections)).toEqual([...BRIEF_SECTIONS])
    expect(json.chars).toBe(text.length)
    expect(json.truncated).toBe(false)
    expect(json.workspace).toEqual({ id: 'w_1', name: '整台电脑' })
  })

  it('置顶规范列全文；记忆索引只列标题和 id，不重复置顶的', () => {
    const { text, json } = buildWorkspaceBrief(input())
    expect(text).toContain('### 协作规范 [mem_rule]\n只 commit 自己的文件\n不 push')
    expect(json.sections.rules!.items).toEqual([{ id: 'mem_rule', title: '协作规范', scope: 'shared', content: '只 commit 自己的文件\n不 push' }])
    expect(text).toContain('- [mem_b]（私有） 我的笔记\n- [mem_a] 打包步骤')
    expect(json.sections.memories!.items.map((m) => m.id)).toEqual(['mem_b', 'mem_a'])
  })

  it('我的任务按状态和优先级排，待我审的跟在后面；其他任务只列编号、标题、负责人、状态；done 不列', () => {
    const { text, json } = buildWorkspaceBrief(input())
    expect(text).toContain('- T-17 [进行中·高] T-17 标题 — T-17 说明\n- T-20 [待办] T-20 标题 — T-20 说明\n- 待我审 T-18 [待审] T-18 标题（执行：codex001） — 改好了，测试全过')
    expect(json.sections.my_tasks!.items.map((t) => [t.ref, t.role])).toEqual([['T-17', 'assignee'], ['T-20', 'assignee'], ['T-18', 'reviewer']])
    expect(text).toContain('- T-12 [待审] — codex001 — T-12 标题\n- T-15 [待办] — 没人领 — T-15 标题')
    expect(text).not.toContain('T-9')
  })

  it('消息按 seq 排、跳过回执，标出 @我；占用表写到几点；未登记改动列路径', () => {
    const { text, json } = buildWorkspaceBrief(input())
    expect(text).toContain('- 20:37 codex001：第二批候选先不切换\n- 20:38 arena-003 @我：@玛雅02 T-17 派给你了')
    expect(text).not.toContain('收到')
    expect(json.sections.messages!.unread).toBe(2)
    expect(text).toContain('- codex001：src/core/screenshot.ts（登记，T-12，到 21:00）\n- 玛雅02（我）：src/core/workspaceBrief.ts（刚改过，到 20:50）')
    expect(text).toContain('## 谁也没登记的改动（1）\n- src/main/index.ts')
  })

  it('没数据的节写明原因：没传占用数据、没传 git status、没有任务', () => {
    const { text, json } = buildWorkspaceBrief({ me: ME, now: NOW })
    expect(text.startsWith('# 开工简报（玛雅02，11-13 20:40）')).toBe(true)
    expect(text).toContain('## 文件占用\n（没有占用数据）')
    expect(text).toContain('## 谁也没登记的改动\n（没传 git status，未检查）')
    expect(text).toContain('（手上没有任务）')
    expect(json.sections.unclaimed).toMatchObject({ total: 0, shown: 0, note: '没传 git status，未检查' })
    expect(json.workspace).toBeNull()
    const empty = buildWorkspaceBrief({ me: ME, now: NOW, unclaimed: [] })
    expect(empty.text).toContain('## 谁也没登记的改动（0）\n（没有）')
  })

  it('sections 只取部分，顺序仍按固定顺序；不认识的报错；max_chars 越界报错', () => {
    const { text, json } = buildWorkspaceBrief(input(), { sections: ['memories', 'rules'] })
    expect(Object.keys(json.sections)).toEqual(['rules', 'memories'])
    expect(text.indexOf('## 置顶规范')).toBeLessThan(text.indexOf('## 记忆索引'))
    expect(text).not.toContain('## 最近消息')
    const err = (fn: () => unknown) => {
      try {
        fn()
      } catch (e) {
        return e instanceof ToolError ? e.code : 'other'
      }
      return 'none'
    }
    expect(err(() => buildWorkspaceBrief(input(), { sections: ['rules', 'nope'] }))).toBe('INVALID_ARGS')
    expect(err(() => buildWorkspaceBrief(input(), { maxChars: 999 }))).toBe('INVALID_ARGS')
    expect(err(() => buildWorkspaceBrief(input(), { maxChars: 30001 }))).toBe('INVALID_ARGS')
  })
})

describe('上限和省略', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => task(`T-${100 + i}`, { assigneeId: 'a_x', status: 'todo', title: `任务${i} ${'字'.repeat(30)}` }))

  it('条数超出上限时写明省略几条、用什么看全部', () => {
    const { text, json } = buildWorkspaceBrief(input({ tasks: many(40) }), { limits: { open_tasks: { maxItems: 5, maxChars: 5000 } } })
    const sec = json.sections.open_tasks!
    expect(sec).toMatchObject({ total: 40, shown: 5, omitted: 35, more: 'task_list' })
    expect(text).toContain('（另有 35 条没列出；看全部：task_list）')
    expect(json.truncated).toBe(true)
  })

  it('字数超出一节的上限时按字数截，这一节（含省略说明）不超上限', () => {
    const { text, json } = buildWorkspaceBrief(input({ tasks: many(40) }), { sections: ['open_tasks'] })
    const body = text.split('\n\n')[1]
    expect(body.length).toBeLessThanOrEqual(1200)
    expect(json.sections.open_tasks!.omitted).toBeGreaterThan(0)
    expect(json.sections.open_tasks!.shown + json.sections.open_tasks!.omitted).toBe(40)
  })

  it('单条超长用 … 截断并在 JSON 里标 truncated', () => {
    const long = task('T-50', { assigneeId: 'a_me', description: '长'.repeat(1000) })
    const { text, json } = buildWorkspaceBrief(input({ tasks: [long] }), { sections: ['my_tasks'] })
    const line = text.split('\n').find((l) => l.startsWith('- T-50'))!
    expect(line.length).toBe(220)
    expect(line.endsWith('…')).toBe(true)
    expect(json.sections.my_tasks!.items[0]).toMatchObject({ ref: 'T-50', truncated: true })
    expect(json.truncated).toBe(true)
  })

  it('置顶规范放不下时截短一条放进去，其余写明用 memory_read 看', () => {
    const pinned = [mem('r1', '规范一', '一'.repeat(2000), { pinned: true }), mem('r2', '规范二', '二'.repeat(2000), { pinned: true }), mem('r3', '规范三', '三', { pinned: true })]
    const { text, json } = buildWorkspaceBrief(input({ pinned }), { sections: ['rules'] })
    const sec = json.sections.rules!
    expect(sec.items.map((i) => i.id)).toEqual(['r1', 'r2'])
    expect(sec.items[0].truncated).toBeUndefined()
    expect(sec.items[1].truncated).toBe(true)
    expect(sec.omitted).toBe(1)
    expect(text).toContain('（另有 1 条没列出；看全部：memory_read 传记忆 id 看全文）')
    expect(text.split('\n\n')[1].length).toBeLessThanOrEqual(3000)
  })

  it('消息保留最新的，省略更早的，并给出往前翻的 chat_read 参数', () => {
    const messages = Array.from({ length: 40 }, (_, i) => msg(i + 1, `消息${i + 1}`))
    const { text, json } = buildWorkspaceBrief(input({ messages }), { sections: ['messages'] })
    const sec = json.sections.messages!
    expect(sec.shown).toBe(15)
    expect(sec.items.map((m) => m.seq)).toEqual(Array.from({ length: 15 }, (_, i) => 26 + i))
    expect(sec.more).toBe('chat_read channel=ws:w_1 before=26')
    expect(text).toContain('（更早的 25 条没列出；看全部：chat_read channel=ws:w_1 before=26）')
  })

  it('整份默认不超过 8000 字；max_chars 调小时每节仍留标题并写明省略', () => {
    const big = input({
      pinned: Array.from({ length: 10 }, (_, i) => mem(`r${i}`, `规范${i}`, '规'.repeat(800), { pinned: true })),
      memories: Array.from({ length: 200 }, (_, i) => mem(`m${i}`, `记忆标题 ${i} ${'记'.repeat(20)}`)),
      tasks: [...many(100), ...Array.from({ length: 30 }, (_, i) => task(`T-${300 + i}`, { assigneeId: 'a_me', description: '说'.repeat(300) }))],
      messages: Array.from({ length: 100 }, (_, i) => msg(i + 1, '话'.repeat(300))),
      unclaimed: Array.from({ length: 100 }, (_, i) => `src/some/deep/path/file${i}.ts`),
      claims: {
        claims: Array.from({ length: 60 }, (_, i) => ({ id: `fc_${i}`, agentId: `a_${i}`, agentName: `agent${i}`, task: null, paths: [`src/x/file${i}.ts`], kind: 'explicit' as const, since: NOW, expiresAt: NOW + 30 * MIN })),
        byAgent: {}
      }
    })
    const full = buildWorkspaceBrief(big)
    expect(full.text.length).toBeLessThanOrEqual(8000)
    expect(full.json.truncated).toBe(true)
    for (const k of BRIEF_SECTIONS) expect(full.json.sections[k]!.omitted).toBeGreaterThan(0)

    const small = buildWorkspaceBrief(big, { maxChars: 2000 })
    expect(small.text.length).toBeLessThanOrEqual(2000)
    expect(small.text.split('\n').filter((l) => l.startsWith('## '))).toHaveLength(7)
    for (const k of BRIEF_SECTIONS) {
      const s = small.json.sections[k]!
      expect(s.shown + s.omitted).toBe(s.total)
      expect(s.more).not.toBeNull()
    }
  })
})
