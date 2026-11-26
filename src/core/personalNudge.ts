/**
 * T-13：提醒 AI 给自己的身份留一条置顶的个人记忆（MCP 群 #304～#307 arena-005 和 arena-006 合成的方案）。
 *
 * 换了会话、或别的 AI 顶替这个身份时，开场说明里只带「置顶的」个人记忆全文；工作目录、分支、分工这些只属于一个身份的东西，
 * 不写在那里，接手的人就得自己去翻共享记忆和交接文档。以前说明里只讲了个人记忆是什么，没讲什么时候该写，所以没人写。
 *
 * 两个时机提醒，都只是提醒、不是强制：
 *  - 开场说明：这个身份干过活（有改动、命令或占着的文件），但没有置顶的个人记忆时，多一节；有了就不出现。
 *    第一次连进来的身份没有目录和分工，没东西可写，不提醒（免得写一条空话）。
 *  - 交付任务（task_update 设 review / done）：没有置顶的就提醒写；有的话提醒「目录或分工变了就改」。
 * 提醒里带草稿，只带工作台确实知道的两样：最近跑命令的目录、手上没做完的任务。负责哪些文件工作台猜不准，留给 AI 自己写。
 */
import { stamp } from './resumeBrief'
import type { MemoryItem, TaskItem } from './types'

/** 草稿里最多列几个目录、几条任务 */
export const NUDGE_MAX_DIRS = 3
export const NUDGE_MAX_TASKS = 5

const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 比较目录用的写法：/ 分隔、去掉结尾的 /、Git Bash 的 /d/xxx 当成 d:/xxx、不分大小写。
 * 同一个目录在 cd /d/Projects/x、D:\Projects\x、D:/Projects/x 里写法不一样，要认成一个
 */
export function dirKey(dir: string): string {
  let s = dir.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  const bash = /^\/([a-zA-Z])(\/|$)/.exec(s)
  if (bash) s = `${bash[1]}:/${s.slice(bash[0].length)}`.replace(/\/$/, '')
  return s.toLowerCase()
}

/** 完整路径：盘符开头、/ 或 \\ 开头、~ 开头。src、sub 这种相对的写进草稿，接手的人不知道是哪个项目的 */
export function isAbsoluteDir(dir: string): boolean {
  return /^(?:[a-zA-Z]:(?:[\\/]|$)|[\\/]|~)/.test(dir.trim())
}

/** 按顺序（新的在前）去重，写法不同的同一个目录只留第一次出现的那个写法；空的、相对路径跳过 */
export function recentDirs(dirs: (string | undefined | null)[], max = NUDGE_MAX_DIRS): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of dirs) {
    if (!d || !d.trim() || !isAbsoluteDir(d)) continue
    const key = dirKey(d)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(d.trim())
    if (out.length >= max) break
  }
  return out
}

/** dirs 里没在这段文字中出现过的（按 dirKey 比，正文里的路径也先换成同样的写法） */
export function dirsMissingFrom(text: string, dirs: string[]): string[] {
  const flat = text.replace(/\\/g, '/').replace(/(^|[\s`'"(（：:，,])\/([a-zA-Z])\//g, '$1$2:/').toLowerCase()
  // 后面紧跟着字母数字、-、_ 的不算（D:/Projects/app 不能因为正文里有 D:/Projects/app-wt-xxx 就算写了）
  const has = (key: string): boolean => {
    for (let i = flat.indexOf(key); i >= 0; i = flat.indexOf(key, i + 1)) {
      if (!/[\w-]/.test(flat.charAt(i + key.length))) return true
    }
    return false
  }
  return dirs.filter((d) => !has(dirKey(d)))
}

export interface NudgeTask {
  ref: string
  status: string
  title: string
}

/** 手上没做完的任务（分给这个 AI、不是 done 的），最近动过的在前 */
export function openTasksOf(tasks: TaskItem[], agentId: string): NudgeTask[] {
  return tasks
    .filter((t) => t.assigneeId === agentId && t.status !== 'done')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((t) => ({ ref: t.ref, status: t.status, title: t.title }))
}

/** 这个 AI 自己的个人记忆（全局记忆库里 scope=private、属于它的，没归档的），新改的在前 */
export function personalMemoriesOf(all: MemoryItem[], agentId: string): MemoryItem[] {
  return all.filter((m) => m.scope === 'private' && m.ownerId === agentId && !m.archivedAt).sort((a, b) => b.updatedAt - a.updatedAt)
}

export interface NudgeDraft {
  /** 最近跑命令的目录，新的在前 */
  dirs: string[]
  /** 手上没做完的任务 */
  tasks: NudgeTask[]
  /** 任务属于哪个工作区（多个工作区时写上） */
  where?: string
}

function draftLines(d: NudgeDraft): string[] {
  const dirs = d.dirs.slice(0, NUDGE_MAX_DIRS)
  const tasks = d.tasks.slice(0, NUDGE_MAX_TASKS)
  const more = d.tasks.length - tasks.length
  return [
    `- 最近跑命令的目录：${dirs.length ? dirs.join('、') : '工作台没有记录'}`,
    `- 手上没做完的任务${d.where ?? ''}：${tasks.length ? tasks.map((t) => `${t.ref} [${t.status}] ${oneLine(t.title, 50)}`).join('；') + (more > 0 ? `；还有 ${more} 条` : '') : '没有'}`
  ]
}

function unpinnedLine(unpinned: MemoryItem[]): string | undefined {
  if (!unpinned.length) return undefined
  const shown = unpinned.slice(0, 3).map((m) => `${m.id}「${oneLine(m.title, 40)}」`)
  return `你有 ${unpinned.length} 条个人记忆没置顶：${shown.join('、')}${unpinned.length > shown.length ? ' 等' : ''}。要是写的就是这些，改成置顶就行（memory_save 带它的 id 和原来的标题、正文，加 pinned=true）。`
}

export interface OpeningNudgeInput extends NudgeDraft {
  /** 这个身份干过活：有改动、命令或占着的文件（只在群里说过话不算） */
  worked: boolean
  /** 已经有置顶的个人记忆（或这个项目里置顶的私有记忆） */
  hasPinned: boolean
  /** 没置顶的个人记忆 */
  unpinned: MemoryItem[]
}

/** 开场说明里的提醒一节；不该提醒（没干过活、已经有置顶的）返回 undefined */
export function describePersonalNudge(o: OpeningNudgeInput): string | undefined {
  if (!o.worked || o.hasPinned) return undefined
  const lines = [
    '\n## 给这个身份留一条置顶的个人记忆',
    '这个身份干过活，但还没有置顶的个人记忆。换了会话、或别的 AI 顶替这个身份时，开场说明里只带置顶的个人记忆全文，工作目录、分支、分工这些不写下来，接手的人就得自己去翻。',
    '核对后存一条：memory_save scope=personal pinned=true，写工作目录、分支、你负责哪些文件、手上没做完的。下面是工作台按记录拼的草稿，只有目录和任务，负责哪些文件要你自己写：',
    ...draftLines(o)
  ]
  const un = unpinnedLine(o.unpinned)
  if (un) lines.push(un)
  lines.push('这是提醒，不是指令：确实没什么要留的就不用管。')
  return lines.join('\n')
}

export interface TaskNudgeInput extends NudgeDraft {
  /** 置顶的个人记忆（新改的在前）；没有就是空 */
  pinned: MemoryItem[]
  unpinned: MemoryItem[]
  now: number
}

/** 交付任务时结果里的一句提醒（personal_memory_hint） */
export function personalMemoryHint(o: TaskNudgeInput): string {
  const top = o.pinned[0]
  if (!top) {
    const un = unpinnedLine(o.unpinned)
    return [
      '你还没有置顶的个人记忆，换了会话或别人顶替这个身份时，工作目录和分工要从头翻。趁现在信息最全，核对后存一条：memory_save scope=personal pinned=true，写工作目录、分支、负责哪些文件、手上没做完的。草稿（负责哪些文件要你自己写）：',
      ...draftLines(o),
      ...(un ? [un] : [])
    ].join('\n')
  }
  const missing = dirsMissingFrom(`${top.title}\n${top.content}`, o.dirs.slice(0, NUDGE_MAX_DIRS))
  return [
    `你的置顶个人记忆 ${top.id}「${oneLine(top.title, 40)}」最后更新在 ${stamp(top.updatedAt, o.now)}。这次换了目录、分支或分工的话顺手改一下（memory_save id=${top.id}）；没变就不用管。`,
    ...(missing.length ? [`最近跑命令的目录里 ${missing.join('、')} 没写在里面。`] : [])
  ].join('\n')
}
