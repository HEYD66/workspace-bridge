// 留痕：从检查点自动整理出「任务编号 → 谁改了哪些文件」的清单。
// AI 每次改文件前工作台都会存检查点（带是谁、哪条任务、改了哪些文件），所以不用在代码里每处改动前后加标记，
// 清单从这些记录里现算。服务端（change_trail 工具）和界面（改动页的「留痕」）用的是同一份算法

/** 一步改动（检查点）里和留痕有关的那几项 */
export interface TrailStep {
  ts: number
  agentName: string
  /** 任务编号（如 T-12）；改的时候没有进行中的任务就是 null */
  task: string | null
  kind: 'edit' | 'rollback'
  files: { path: string; rolledBackBy?: string }[]
}

export interface TrailFile {
  path: string
  /** 谁改过，按第一次改的先后 */
  by: string[]
  /** 改了几次 */
  edits: number
  lastTs: number
  /** 这个文件在这条任务里的改动全部被撤销了 */
  undone?: boolean
}

export interface TrailEntry {
  /** 任务编号；null = 没挂在任何任务上的改动 */
  task: string | null
  title?: string
  status?: string
  firstTs: number
  lastTs: number
  /** 谁参与了，各改了几次、几个文件 */
  agents: { name: string; edits: number; files: number }[]
  /** 改过的文件，按路径排 */
  files: TrailFile[]
}

/**
 * 把检查点整理成留痕清单：一条任务一项（最近动过的在前），没挂任务的改动合成最后一项。
 * 回滚那一步本身不算改动；被撤销的那次改动还列着，全部被撤销的文件标 undone。
 * tasks：任务编号（大小写不论）→ 标题和状态，有就带上
 */
export function buildTrail(steps: readonly TrailStep[], tasks?: ReadonlyMap<string, { title: string; status?: string }>): TrailEntry[] {
  interface Acc {
    entry: TrailEntry
    files: Map<string, TrailFile & { live: number }>
    agents: Map<string, { name: string; edits: number; paths: Set<string> }>
  }
  const byTask = new Map<string, Acc>()
  for (const s of [...steps].sort((a, b) => a.ts - b.ts)) {
    if (s.kind !== 'edit' || !s.files.length) continue
    const key = s.task ? s.task.toUpperCase() : ''
    let acc = byTask.get(key)
    if (!acc) {
      const info = s.task ? (tasks?.get(key) ?? tasks?.get(s.task)) : undefined
      acc = {
        entry: { task: s.task ? key : null, ...(info ? { title: info.title, ...(info.status ? { status: info.status } : {}) } : {}), firstTs: s.ts, lastTs: s.ts, agents: [], files: [] },
        files: new Map(),
        agents: new Map()
      }
      byTask.set(key, acc)
    }
    acc.entry.lastTs = Math.max(acc.entry.lastTs, s.ts)
    const who = acc.agents.get(s.agentName) ?? { name: s.agentName, edits: 0, paths: new Set<string>() }
    who.edits++
    acc.agents.set(s.agentName, who)
    for (const f of s.files) {
      who.paths.add(f.path)
      const cur = acc.files.get(f.path) ?? { path: f.path, by: [], edits: 0, lastTs: s.ts, live: 0 }
      if (!cur.by.includes(s.agentName)) cur.by.push(s.agentName)
      cur.edits++
      cur.lastTs = Math.max(cur.lastTs, s.ts)
      if (!f.rolledBackBy) cur.live++
      acc.files.set(f.path, cur)
    }
  }
  const out: TrailEntry[] = []
  for (const acc of byTask.values()) {
    acc.entry.agents = [...acc.agents.values()].map((a) => ({ name: a.name, edits: a.edits, files: a.paths.size })).sort((a, b) => b.edits - a.edits || (a.name < b.name ? -1 : 1))
    acc.entry.files = [...acc.files.values()]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map(({ live, ...f }) => (live === 0 ? { ...f, undone: true } : f))
    out.push(acc.entry)
  }
  // 有编号的在前、最近动过的在前；没挂任务的放最后
  return out.sort((a, b) => Number(a.task === null) - Number(b.task === null) || b.lastTs - a.lastTs)
}

const day = (ts: number): string => {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 清单写成能直接贴进文档的 Markdown：每条任务一节，「做什么 + 编号」在标题里，下面是谁改了哪些文件。每节最多列 maxFiles 个文件 */
export function trailMarkdown(entries: readonly TrailEntry[], opts: { heading?: string; maxFiles?: number } = {}): string {
  const max = opts.maxFiles ?? 40
  const lines: string[] = [`# ${opts.heading ?? '改动留痕'}`, '', '按任务编号列出谁改了哪些文件。由工作台从改动记录自动生成，不用在代码里做标记。', '']
  if (!entries.length) lines.push('还没有改动记录。')
  for (const e of entries) {
    lines.push(`## ${e.task ? `${e.task}${e.title ? ` ${e.title}` : ''}` : '没挂任务的改动'}${e.status ? `（${e.status}）` : ''}`)
    lines.push(`- 时间：${day(e.firstTs)}${e.lastTs !== e.firstTs ? ` ～ ${day(e.lastTs)}` : ''}`)
    lines.push(`- 谁改的：${e.agents.map((a) => `${a.name}（${a.edits} 次，${a.files} 个文件）`).join('、')}`)
    lines.push(`- 文件（${e.files.length} 个）：`)
    for (const f of e.files.slice(0, max)) lines.push(`  - \`${f.path}\` — ${f.by.join('、')}${f.edits > 1 ? `，${f.edits} 次` : ''}${f.undone ? '，已撤销' : ''}`)
    if (e.files.length > max) lines.push(`  - （还有 ${e.files.length - max} 个）`)
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}
