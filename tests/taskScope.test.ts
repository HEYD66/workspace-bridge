// 优化第 12 条核心：任务范围提醒、命令证据、等人决定的问题（T-20）
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  addQuestion,
  answerQuestion,
  canAnswerQuestion,
  checkTaskScope,
  closeQuestion,
  formatCommandEvidence,
  formatQuestions,
  normalizeAllowedPaths,
  normalizeScopePath,
  openQuestions,
  resolveScopeTask,
  MAX_OPEN_QUESTIONS,
  type CommandRecord,
  type ScopeTask,
  type TaskQuestion
} from '../src/core/taskScope'
import { ToolError } from '../src/core/fileTools'

const ROOT = path.resolve('/tmp/ws-scope')
const WS = { root: ROOT, caseInsensitive: false }

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return e instanceof ToolError ? e.code : 'OTHER'
  }
  return 'NONE'
}

function task(over: Partial<ScopeTask> = {}): ScopeTask {
  return { id: 't_1', ref: 'T-20', status: 'in_progress', assigneeId: 'a', allowedPaths: ['src/core/taskScope.ts', 'tests/**/*.test.ts'], ...over }
}

describe('任务范围：路径统一', () => {
  it('相对路径、反斜杠、末尾 / 都统一成相对根目录的 / 分隔；根本身是 **', () => {
    expect(normalizeScopePath('src\\core\\a.ts', WS)).toBe('src/core/a.ts')
    expect(normalizeScopePath('./src/core/', WS)).toBe('src/core')
    expect(normalizeScopePath(path.join(ROOT, 'docs', 'x.md'), WS)).toBe('docs/x.md')
    expect(normalizeScopePath('.', WS)).toBe('**')
    expect(normalizeScopePath('src/**/*.ts', WS)).toBe('src/**/*.ts')
  })

  it('越出工作区、空路径、整台电脑下的相对路径报错', () => {
    expect(code(() => normalizeScopePath('../other/a.ts', WS))).toBe('OUTSIDE_WORKSPACE')
    expect(code(() => normalizeScopePath('  ', WS))).toBe('INVALID_ARGS')
    expect(code(() => normalizeScopePath('src/a.ts', { root: ROOT, machine: true }))).toBe('INVALID_ARGS')
  })

  it('allowedPaths：去重（不分大小写时按小写）、空数组和不传都是不限范围、类型和数量校验', () => {
    expect(normalizeAllowedPaths(['src/A.ts', 'src\\A.ts', 'src/a.ts'], WS)).toEqual(['src/A.ts', 'src/a.ts'])
    expect(normalizeAllowedPaths(['src/A.ts', 'src/a.ts'], { root: ROOT, caseInsensitive: true })).toEqual(['src/A.ts'])
    expect(normalizeAllowedPaths([], WS)).toBeUndefined()
    expect(normalizeAllowedPaths(undefined, WS)).toBeUndefined()
    expect(code(() => normalizeAllowedPaths('src', WS))).toBe('INVALID_ARGS')
    expect(code(() => normalizeAllowedPaths([1], WS))).toBe('INVALID_ARGS')
    expect(code(() => normalizeAllowedPaths(Array.from({ length: 51 }, (_, i) => `f${i}`), WS))).toBe('LIMIT')
    expect(code(() => normalizeAllowedPaths(['../x'], WS))).toBe('OUTSIDE_WORKSPACE')
  })
})

describe('任务范围：确定当前任务', () => {
  const tasks: ScopeTask[] = [task(), task({ id: 't_2', ref: 'T-21', status: 'todo' }), task({ id: 't_3', ref: 'T-22', assigneeId: 'b' })]

  it('没带 task：手上恰好一个 in_progress 才算，多个或没有都不检查', () => {
    expect(resolveScopeTask(tasks, 'a')?.ref).toBe('T-20')
    expect(resolveScopeTask(tasks, 'c')).toBeNull()
    expect(resolveScopeTask([...tasks, task({ id: 't_4', ref: 'T-23' })], 'a')).toBeNull()
  })

  it('显式带 task：id 或编号（不分大小写）都认，不管状态和执行者；不存在报 NOT_FOUND', () => {
    expect(resolveScopeTask(tasks, 'c', 't-21')?.id).toBe('t_2')
    expect(resolveScopeTask(tasks, 'c', 't_3')?.ref).toBe('T-22')
    expect(code(() => resolveScopeTask(tasks, 'a', 'T-99'))).toBe('NOT_FOUND')
    expect(resolveScopeTask(tasks, 'a', '  ')?.ref).toBe('T-20')
  })
})

describe('任务范围：检查写入', () => {
  it('都在范围内：不提醒；glob 和目录写法都认', () => {
    const r = checkTaskScope(task({ allowedPaths: ['src/core/taskScope.ts', 'tests/**/*.test.ts', 'docs'] }), ['src/core/taskScope.ts', 'tests/a/b/x.test.ts', 'docs/sub/readme.md'], WS)
    expect(r).toEqual({ task: 'T-20', checked: true, outside: [], blocked: false, text: null })
  })

  it('范围外：warn 照常写、给【范围提醒】；越出工作区的也算范围外；重复路径只报一次', () => {
    const r = checkTaskScope(task(), ['src/core/tasks.ts', 'src\\core\\tasks.ts', 'tests/x.test.ts', '../evil.ts'], WS)
    expect(r.checked).toBe(true)
    expect(r.blocked).toBe(false)
    expect(r.outside).toEqual(['src/core/tasks.ts', '../evil.ts'])
    expect(r.text).toContain('【范围提醒】')
    expect(r.text).toContain('src/core/tasks.ts、../evil.ts 不在 T-20 允许改的范围内')
    expect(r.text).toContain('这次写入照常完成')
  })

  it('block 模式才拦；off、没确定任务、任务没设范围都不检查', () => {
    const b = checkTaskScope(task(), ['src/main/index.ts'], { ...WS, mode: 'block' })
    expect(b.blocked).toBe(true)
    expect(b.text).toContain('这次没有写入')
    expect(checkTaskScope(task(), ['src/main/index.ts'], { ...WS, mode: 'off' }).checked).toBe(false)
    expect(checkTaskScope(null, ['src/main/index.ts'], WS)).toEqual({ task: null, checked: false, outside: [], blocked: false, text: null })
    expect(checkTaskScope(task({ allowedPaths: undefined }), ['x'], WS).checked).toBe(false)
  })

  it('大小写：不分大小写时 SRC/ 也算范围内；提醒里范围太长只列前 5 个', () => {
    const ci = { root: ROOT, caseInsensitive: true }
    expect(checkTaskScope(task(), ['SRC/Core/TaskScope.ts'], ci).outside).toEqual([])
    expect(checkTaskScope(task(), ['SRC/Core/TaskScope.ts'], WS).outside).toEqual(['SRC/Core/TaskScope.ts'])
    const many = task({ allowedPaths: Array.from({ length: 7 }, (_, i) => `d${i}`) })
    expect(checkTaskScope(many, ['x.ts'], WS).text).toContain('d0、d1、d2、d3、d4 等 7 个')
  })

  it('整台电脑：用绝对路径比，相对路径算范围外', () => {
    const m = { root: ROOT, machine: true, caseInsensitive: true }
    const base = path.resolve('/proj/mcp').replace(/\\/g, '/')
    const allowed = normalizeAllowedPaths([`${base}/src/**/*.ts`], m)!
    const t = task({ allowedPaths: allowed })
    expect(checkTaskScope(t, [`${base}/src/core/a.ts`], m).outside).toEqual([])
    expect(checkTaskScope(t, [`${base}/docs/a.md`, 'src/a.ts'], m).outside).toEqual([`${base}/docs/a.md`, 'src/a.ts'])
  })
})

describe('命令证据', () => {
  const T0 = new Date(2026, 10, 13, 21, 5, 7).getTime()
  const rec = (over: Partial<CommandRecord> = {}): CommandRecord => ({ command: 'npx vitest run tests/taskScope.test.ts', exitCode: 0, startedAt: T0, durationMs: 6700, output: ' ✓ tests/taskScope.test.ts (20 tests)\n Tests  20 passed (20)\n', ...over })

  it('每条写命令、退出码、用时、开始时间、目录和输出结尾；没有记录返回空串', () => {
    expect(formatCommandEvidence([])).toBe('')
    const s = formatCommandEvidence([rec({ cwd: 'D:/AProgram/MCP' })])
    expect(s.startsWith('【命令证据】共 1 条命令；')).toBe(true)
    expect(s).toContain('1. `npx vitest run tests/taskScope.test.ts`（退出码 0，6.7 秒，21:05:07，在 D:/AProgram/MCP）')
    expect(s).toContain('```\n ✓ tests/taskScope.test.ts (20 tests)\n Tests  20 passed (20)\n```')
  })

  it('argv 带空格的参数加引号；超时、取消、没退出码、没输出、用 endedAt 算用时；stdout/stderr 分开给也行', () => {
    const s = formatCommandEvidence([
      rec({ command: ['git', 'commit', '-m', 'feat: a b'], output: '' }),
      rec({ timedOut: true, exitCode: null, durationMs: undefined, endedAt: T0 + 250 }),
      rec({ cancelled: true, exitCode: null }),
      rec({ exitCode: null, output: undefined, stdout: 'out line', stderr: 'err line' })
    ])
    expect(s).toContain('1. `git commit -m "feat: a b"`（退出码 0')
    expect(s).toContain('（没有输出）')
    expect(s).toContain('（超时被结束，250 毫秒，')
    expect(s).toContain('（已取消，')
    expect(s).toContain('（没有退出码，')
    expect(s).toContain('out line\n[stderr]\nerr line')
  })

  it('脱敏：命令和输出里的已知令牌、Bearer、/mcp/<令牌>、token= 都换掉；颜色码和 \\r 进度条去掉', () => {
    const secret = 'sk_live_1234567890abcdef'
    const s = formatCommandEvidence(
      [
        rec({
          command: `curl -H "Authorization: Bearer abcdefgh12345678" https://x.trycloudflare.com/mcp/Dc9OTXylx_TYKCMK?token=${secret}`,
          output: `\u001b[32mok\u001b[0m ${secret}\nprogress 10%\rprogress 100%\n`
        })
      ],
      { secrets: [secret] }
    )
    expect(s).not.toContain(secret)
    expect(s).not.toContain('abcdefgh12345678')
    expect(s).not.toContain('Dc9OTXylx_TYKCMK')
    expect(s).toContain('[REDACTED]')
    expect(s).not.toContain('\u001b')
    expect(s).toContain('ok [REDACTED]\nprogress 100%')
    expect(s).not.toContain('progress 10%')
  })

  it('单条输出只留结尾，尽量从整行开始，并写明省略了多少字', () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
    const s = formatCommandEvidence([rec({ output: long })], { tailChars: 100 })
    expect(s).toMatch(/…（前面省略 \d+ 字）\nline \d+\n/)
    expect(s).toContain('line 199\n```')
    expect(s).not.toContain('line 0\n')
  })

  it('总字数不超过 maxChars：先压输出，还不够就省略最早的命令；只列最近 maxCommands 条', () => {
    const big = 'x'.repeat(5000)
    const recs = Array.from({ length: 12 }, (_, i) => rec({ command: `cmd ${i}`, output: big }))
    const s = formatCommandEvidence(recs, { maxChars: 1500 })
    expect(s.length).toBeLessThanOrEqual(1500)
    expect(s).toContain('共 12 条命令，只列最近')
    expect(s).toContain('`cmd 11`')
    expect(s).not.toContain('`cmd 0`')
    const few = formatCommandEvidence(recs.slice(0, 5), { maxCommands: 2, maxChars: 20000 })
    expect(few).toContain('共 5 条命令，只列最近 2 条')
    expect(few).toContain('4. `cmd 3`')
    expect(few).toContain('5. `cmd 4`')
    expect(formatCommandEvidence([rec({ output: big })], { maxChars: 10 }).length).toBeLessThanOrEqual(600)
  })

  it('输出里有 ``` 时围栏加长，命令里有反引号时用双反引号', () => {
    const s = formatCommandEvidence([rec({ command: 'echo `date`', output: 'a\n```\nb' })])
    expect(s).toContain('`` echo `date` ``')
    expect(s).toContain('````\na\n```\nb\n````')
  })
})

describe('等人决定的问题', () => {
  const info = { createdBy: 'arena-003', managedBy: 'arena-003' }
  const asker = { id: 'agent2', name: '玛雅02' }
  const user = { id: 'user', name: '用户' }
  const T = new Date(2026, 10, 13, 21, 10, 0).getTime()

  it('新增：编号 q1、q2 递增不复用，不改原数组；备选答案去重；校验文字和数量', () => {
    const a = addQuestion(undefined, asker, { text: ' 要不要拦？ ', options: ['拦', '只提醒', '拦'] }, T)
    expect(a.question).toEqual({ id: 'q1', text: '要不要拦？', options: ['拦', '只提醒'], askedBy: 'agent2', askedByName: '玛雅02', askedAt: T, status: 'open' })
    const b = addQuestion(a.questions, asker, { text: '第二个' }, T)
    expect(b.question.id).toBe('q2')
    expect(b.question.options).toBeUndefined()
    expect(a.questions).toHaveLength(1)
    const closed = closeQuestion(b.questions, info, asker, 'q2', undefined, T).questions.filter((q) => q.id !== 'q2')
    expect(addQuestion(closed, asker, { text: '第三个' }, T).question.id).toBe('q2')
    expect(addQuestion(b.questions, asker, { text: '第三个' }, T).question.id).toBe('q3')
    expect(code(() => addQuestion([], asker, { text: '  ' }))).toBe('INVALID_ARGS')
    expect(code(() => addQuestion([], asker, { text: 'x'.repeat(2001) }))).toBe('INVALID_ARGS')
    expect(code(() => addQuestion([], asker, { text: 'x', options: 'a' }))).toBe('INVALID_ARGS')
    let many: TaskQuestion[] = []
    for (let i = 0; i < MAX_OPEN_QUESTIONS; i++) many = addQuestion(many, asker, { text: `q${i}` }, T).questions
    expect(code(() => addQuestion(many, asker, { text: '太多了' }))).toBe('LIMIT')
  })

  it('谁能答：用户、创建者、派活的人；执行者自己不能答', () => {
    expect(canAnswerQuestion(info, 'user')).toBe(true)
    expect(canAnswerQuestion(info, 'arena-003')).toBe(true)
    expect(canAnswerQuestion({ createdBy: 'x', managedBy: 'm' }, 'm')).toBe(true)
    expect(canAnswerQuestion({ createdBy: 'x' }, 'agent2')).toBe(false)
    const { questions } = addQuestion([], asker, { text: '要不要拦？' }, T)
    expect(code(() => answerQuestion(questions, info, asker, 'q1', '拦'))).toBe('FORBIDDEN')
    const r = answerQuestion(questions, info, user, 'q1', ' 先只提醒 ', T + 60_000)
    expect(r.question).toMatchObject({ status: 'answered', answer: '先只提醒', answeredBy: 'user', answeredByName: '用户', answeredAt: T + 60_000 })
    expect(questions[0].status).toBe('open')
    expect(openQuestions(r.questions)).toEqual([])
    // 已答过的可以改答案
    expect(answerQuestion(r.questions, info, { id: 'arena-003', name: 'arena-003' }, 'q1', '拦').question.answer).toBe('拦')
    expect(code(() => answerQuestion(questions, info, user, 'q9', '拦'))).toBe('NOT_FOUND')
    expect(code(() => answerQuestion(questions, info, user, 'q1', ''))).toBe('INVALID_ARGS')
  })

  it('关闭：提问的人和能答的人能关，别人不行；关了不能再答、再关', () => {
    const { questions } = addQuestion([], asker, { text: '要不要拦？' }, T)
    expect(code(() => closeQuestion(questions, info, { id: 'other', name: 'other' }, 'q1'))).toBe('FORBIDDEN')
    const c = closeQuestion(questions, info, asker, 'q1', ' 不用问了 ', T)
    expect(c.question).toMatchObject({ status: 'closed', closedBy: 'agent2', closeNote: '不用问了' })
    expect(closeQuestion(questions, info, user, 'q1', '').question.closeNote).toBeUndefined()
    expect(code(() => closeQuestion(c.questions, info, user, 'q1'))).toBe('INVALID_STATE')
    expect(code(() => answerQuestion(c.questions, info, user, 'q1', '拦'))).toBe('INVALID_STATE')
  })

  it('【待决定问题】文本：默认不列已关闭的，没有可列的返回空串', () => {
    expect(formatQuestions(undefined)).toBe('')
    let qs = addQuestion([], asker, { text: '要不要拦？', options: ['拦', '只提醒'] }, T).questions
    qs = addQuestion(qs, asker, { text: '上限多少？' }, T).questions
    qs = addQuestion(qs, asker, { text: '还要吗？' }, T).questions
    qs = answerQuestion(qs, info, user, 'q2', '4000 字', T).questions
    qs = closeQuestion(qs, info, asker, 'q3', '不用了', T).questions
    const s = formatQuestions(qs)
    expect(s).toBe(
      '【待决定问题】1 个等回答\n- q1（玛雅02 问，21:10）要不要拦？\n  备选：拦 / 只提醒\n  → 等回答\n- q2（玛雅02 问，21:10）上限多少？\n  → 用户 答（21:10）：4000 字'
    )
    expect(formatQuestions(qs, { includeClosed: true })).toContain('- q3（玛雅02 问，21:10）还要吗？\n  → 已关闭（玛雅02，21:10）：不用了')
    expect(formatQuestions(answerQuestion(qs, info, user, 'q1', '拦', T).questions)).toMatch(/^【待决定问题】都已回答/)
  })
})
