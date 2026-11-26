// 画布的「撤销上一步」：只撤用户自己做的改动，不整份退回（画布 AI 也会改，整份退回会把 AI 这段时间改的一起抹掉）。
// 做法：用户每改一次，比较改之前和改之后，记下哪几样东西从什么变成了什么（卡片位置、便签、收纳、接力线、小窗、模板）。
// 撤销时一样一样放回去；某一样现在已经不是「改之后」的样子了（AI 或别的什么又动过），就不硬撤，告诉用户哪几样没撤。
// 视角、「看过了」不记；终端重新连上（小窗的 termId 变了）不算改动。
// 纯计算：存哪些步、怎么合并、怎么放回去都在这里，CanvasStore 只负责调用。
import { CANVAS_LIMITS, type CanvasDoc, type CanvasNodeLayout, type CanvasNote, type CanvasRelay, type CanvasTemplate, type CanvasWidget } from './canvasDoc'

/** 最多记几步 */
export const CANVAS_UNDO_STEPS = 30
/** 隔这么久以内连着来的改动合成一步：拖一张卡片会分好几次发位置；删便签和忘掉它的位置是前后两次调用 */
export const CANVAS_UNDO_MERGE_MS = 1000

type Kind = 'node' | 'note' | 'archived' | 'relay' | 'widget' | 'template'

type ValueOf<K extends Kind> = K extends 'node'
  ? CanvasNodeLayout
  : K extends 'note'
    ? CanvasNote
    : K extends 'archived'
      ? true
      : K extends 'relay'
        ? CanvasRelay
        : K extends 'widget'
          ? CanvasWidget
          : CanvasTemplate

/** 一样东西的变化：before / after 没有就是「那时候不存在」 */
export interface UndoChange<K extends Kind = Kind> {
  kind: K
  id: string
  before?: ValueOf<K>
  after?: ValueOf<K>
  /** 便签、接力线、小窗、模板在列表里的位置（改之前），放回去时尽量放回原位，叠放顺序不乱 */
  index?: number
}

export interface UndoStep {
  /** 第一次改动的时间 */
  at: number
  /** 最近一次并进来的时间 */
  lastAt: number
  /** 工作区 id（或 CANVAS_ALL）→ 这一步在这份画布上改了什么，键是 `${kind}:${id}` */
  parts: Map<string, Map<string, UndoChange>>
}

export interface CanvasUndoState {
  canUndo: boolean
  /** 下一次撤销撤的是什么，给用户看的一句话 */
  label?: string
  /** 一共还能撤几步 */
  count: number
}

export interface CanvasUndoResult {
  /** done：全撤了；partial：撤了一部分，有的被改过没撤；conflict：全被改过，什么都没动（这一步也扔掉）；empty：没有能撤的 */
  status: 'done' | 'partial' | 'conflict' | 'empty'
  label?: string
  /** 给用户看的一句话 */
  message: string
  /** 没撤的那几样 */
  skipped: string[]
  state: CanvasUndoState
}

// ---------- 比较 ----------

/** 键排好序再转 JSON：{a,b} 和 {b,a} 算一样 */
function canon(v: unknown): string {
  if (v === undefined) return 'undefined'
  return JSON.stringify(v, (_k, x: unknown) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return x
    const o = x as Record<string, unknown>
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]))
  })
}

/** 小窗比较时不看 termId：终端关了重开，界面会自己换一个，不算用户改的 */
function comparable(kind: Kind, v: unknown): unknown {
  if (kind !== 'widget' || !v) return v
  const { termId: _t, ...rest } = v as CanvasWidget
  return rest
}

const same = (kind: Kind, a: unknown, b: unknown): boolean => canon(comparable(kind, a)) === canon(comparable(kind, b))

interface Listed {
  id: string
}

function byId<T extends Listed>(list: readonly T[]): Map<string, { v: T; i: number }> {
  return new Map(list.map((v, i) => [v.id, { v, i }]))
}

/** 改之前和改之后比，哪几样东西变了 */
export function diffCanvasDocs(before: CanvasDoc, after: CanvasDoc): UndoChange[] {
  const out: UndoChange[] = []
  const nodeIds = new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)])
  for (const id of nodeIds) {
    const b = before.nodes[id]
    const a = after.nodes[id]
    if (!same('node', b, a)) out.push({ kind: 'node', id, ...(b ? { before: { ...b } } : {}), ...(a ? { after: { ...a } } : {}) })
  }
  const lists: [Kind, readonly Listed[], readonly Listed[]][] = [
    ['note', before.notes, after.notes],
    ['relay', before.relays, after.relays],
    ['widget', before.widgets, after.widgets],
    ['template', before.templates, after.templates]
  ]
  for (const [kind, bl, al] of lists) {
    const bm = byId(bl)
    const am = byId(al)
    for (const id of new Set([...bm.keys(), ...am.keys()])) {
      const b = bm.get(id)
      const a = am.get(id)
      if (same(kind, b?.v, a?.v)) continue
      out.push({ kind, id, ...(b ? { before: structuredClone(b.v), index: b.i } : {}), ...(a ? { after: structuredClone(a.v) } : {}) } as UndoChange)
    }
  }
  const ba = new Set(before.archived)
  const aa = new Set(after.archived)
  for (const id of new Set([...ba, ...aa])) {
    if (ba.has(id) === aa.has(id)) continue
    out.push({ kind: 'archived', id, ...(ba.has(id) ? { before: true as const } : {}), ...(aa.has(id) ? { after: true as const } : {}) })
  }
  return out
}

// ---------- 记步 ----------

/** 只是给还没有位置的东西摆了个位置（新卡片自动排版、新便签 / 小窗摆位置）：不单独算一步 */
const onlyPlacement = (changes: readonly UndoChange[]): boolean => changes.every((c) => c.kind === 'node' && c.before === undefined)

export class CanvasUndoHistory {
  private steps: UndoStep[] = []

  constructor(
    private readonly maxSteps = CANVAS_UNDO_STEPS,
    private readonly mergeMs = CANVAS_UNDO_MERGE_MS
  ) {}

  /** 用户改了一次 workspaceId 那份画布 */
  record(workspaceId: string, before: CanvasDoc, after: CanvasDoc, now: number): void {
    const changes = diffCanvasDocs(before, after)
    if (changes.length === 0) return
    const top = this.steps[this.steps.length - 1]
    const recent = !!top && Math.abs(now - top.lastAt) <= this.mergeMs
    if (!recent && onlyPlacement(changes)) return
    const step: UndoStep = recent ? top : { at: now, lastAt: now, parts: new Map() }
    if (!recent) this.steps.push(step)
    step.lastAt = Math.max(step.lastAt, now)
    let part = step.parts.get(workspaceId)
    if (!part) {
      part = new Map()
      step.parts.set(workspaceId, part)
    }
    for (const c of changes) {
      const key = `${c.kind}:${c.id}`
      const had = part.get(key)
      if (!had) {
        part.set(key, c)
        continue
      }
      // 同一样东西这一步里改了好几次：留最早的「改之前」，换成最新的「改之后」
      if (c.after === undefined) delete had.after
      else had.after = c.after
      if (same(had.kind, had.before, had.after)) part.delete(key)
    }
    if (part.size === 0) step.parts.delete(workspaceId)
    if (step.parts.size === 0) this.steps.pop()
    while (this.steps.length > this.maxSteps) this.steps.shift()
  }

  /** 项目删掉了：记的步里关于它的都不要了 */
  forget(workspaceId: string): void {
    for (const s of this.steps) s.parts.delete(workspaceId)
    this.steps = this.steps.filter((s) => s.parts.size > 0)
  }

  state(): CanvasUndoState {
    const top = this.steps[this.steps.length - 1]
    return top ? { canUndo: true, label: describeStep(top), count: this.steps.length } : { canUndo: false, count: 0 }
  }

  /** 拿走最近一步（撤销时用；撤成撤不成这一步都不留了） */
  pop(): UndoStep | undefined {
    return this.steps.pop()
  }

  clear(): void {
    this.steps = []
  }
}

// ---------- 说明 ----------

const clip = (s: string, n = 12): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}…` : one
}

function noteName(n: CanvasNote | undefined): string {
  return n ? `便签「${clip(n.text)}」` : '便签'
}

function widgetName(w: CanvasWidget | undefined): string {
  if (!w) return '小窗'
  const name = w.title || (w.path ? w.path.split(/[\\/]/).filter(Boolean).pop() : undefined) || w.url || (w.kind === 'terminal' ? '终端' : undefined)
  return name ? `小窗「${clip(name, 20)}」` : '小窗'
}

function changeName(c: UndoChange): string {
  const v = (c.after ?? c.before) as never
  switch (c.kind) {
    case 'note':
      return noteName(v)
    case 'widget':
      return widgetName(v)
    case 'relay':
      return '接力线'
    case 'template':
      return `模板「${clip((v as CanvasTemplate | undefined)?.name ?? '')}」`
    case 'archived':
      return '收纳'
    default:
      return '卡片位置'
  }
}

/** 一步说成一句话，比如「删掉便签「买菜」」「挪动 3 张卡片」「关掉小窗「README.md」，删掉接力线」 */
export function describeStep(step: UndoStep): string {
  const all = [...step.parts.values()].flatMap((p) => [...p.values()])
  // 跟着便签、小窗一起出现 / 消失的位置不单说
  const owned = new Set(all.filter((c) => (c.kind === 'note' || c.kind === 'widget') && (c.before === undefined) !== (c.after === undefined)).map((c) => c.id))
  const phrases: string[] = []
  const say = (list: UndoChange[], one: (c: UndoChange) => string, many: (n: number) => string): void => {
    if (list.length === 1) phrases.push(one(list[0]))
    else if (list.length > 1) phrases.push(many(list.length))
  }
  const of = (kind: Kind, how: 'add' | 'remove' | 'edit'): UndoChange[] =>
    all.filter((c) => c.kind === kind && (how === 'add' ? c.before === undefined : how === 'remove' ? c.after === undefined : c.before !== undefined && c.after !== undefined))
  say(of('note', 'remove'), (c) => `删掉${noteName(c.before as CanvasNote)}`, (n) => `删掉 ${n} 张便签`)
  say(of('widget', 'remove'), (c) => `关掉${widgetName(c.before as CanvasWidget)}`, (n) => `关掉 ${n} 个小窗`)
  say(of('relay', 'remove'), () => '删掉接力线', (n) => `删掉 ${n} 条接力线`)
  say(of('template', 'remove'), (c) => `删掉${changeName(c)}`, (n) => `删掉 ${n} 个模板`)
  say(of('note', 'add'), (c) => `贴${noteName(c.after as CanvasNote)}`, (n) => `贴了 ${n} 张便签`)
  say(of('widget', 'add'), (c) => `开${widgetName(c.after as CanvasWidget)}`, (n) => `开了 ${n} 个小窗`)
  say(of('relay', 'add'), () => '连接力线', (n) => `连了 ${n} 条接力线`)
  say(of('template', 'add'), (c) => `存${changeName(c)}`, (n) => `存了 ${n} 个模板`)
  say(of('note', 'edit'), (c) => `改${noteName(c.before as CanvasNote)}`, (n) => `改了 ${n} 张便签`)
  say(of('widget', 'edit'), (c) => `改${widgetName(c.before as CanvasWidget)}`, (n) => `改了 ${n} 个小窗`)
  say(of('template', 'edit'), (c) => `改${changeName(c)}`, (n) => `改了 ${n} 个模板`)
  const archived = all.filter((c) => c.kind === 'archived')
  const put = archived.filter((c) => c.after !== undefined).length
  const back = archived.length - put
  if (put > 0) phrases.push(put === 1 ? '收纳 1 张卡片' : `收纳 ${put} 张卡片`)
  if (back > 0) phrases.push(back === 1 ? '放回 1 张卡片' : `放回 ${back} 张卡片`)
  const moved = new Set(all.filter((c) => c.kind === 'node' && !owned.has(c.id)).map((c) => c.id)).size
  if (moved > 0) phrases.push(`挪动 ${moved} 张卡片`)
  if (phrases.length === 0) return '上一步'
  return phrases.length > 2 ? `${phrases.slice(0, 2).join('，')}等` : phrases.join('，')
}

// ---------- 放回去 ----------

function currentOf(doc: CanvasDoc, c: UndoChange): unknown {
  switch (c.kind) {
    case 'node':
      return doc.nodes[c.id]
    case 'archived':
      return doc.archived.includes(c.id) ? true : undefined
    case 'note':
      return doc.notes.find((x) => x.id === c.id)
    case 'relay':
      return doc.relays.find((x) => x.id === c.id)
    case 'widget':
      return doc.widgets.find((x) => x.id === c.id)
    case 'template':
      return doc.templates.find((x) => x.id === c.id)
  }
}

function putBack<T extends Listed>(list: T[], id: string, value: T | undefined, index: number | undefined, keep?: (cur: T, value: T) => T): void {
  const at = list.findIndex((x) => x.id === id)
  if (value === undefined) {
    if (at >= 0) list.splice(at, 1)
    return
  }
  const copy = structuredClone(value)
  if (at >= 0) list[at] = keep ? keep(list[at], copy) : copy
  else list.splice(Math.min(index ?? list.length, list.length), 0, copy)
}

/** 放回去会超上限、或者会和现有的东西重复：返回原因；能放就返回 undefined */
function blocked(doc: CanvasDoc, c: UndoChange): string | undefined {
  if (c.before === undefined || currentOf(doc, c) !== undefined) return undefined
  switch (c.kind) {
    case 'note':
      return doc.notes.length >= CANVAS_LIMITS.notes ? `便签已经有 ${CANVAS_LIMITS.notes} 张了` : undefined
    case 'widget':
      return doc.widgets.length >= CANVAS_LIMITS.widgets ? `小窗已经有 ${CANVAS_LIMITS.widgets} 个了` : undefined
    case 'template':
      return doc.templates.length >= CANVAS_LIMITS.templates ? `模板已经有 ${CANVAS_LIMITS.templates} 个了` : undefined
    case 'relay': {
      const r = c.before as CanvasRelay
      if (doc.relays.some((x) => x.from === r.from && x.to === r.to)) return '已经有一条一样的线'
      return doc.relays.length >= CANVAS_LIMITS.relays ? `接力线已经有 ${CANVAS_LIMITS.relays} 条了` : undefined
    }
    case 'node':
      return Object.keys(doc.nodes).length >= CANVAS_LIMITS.nodes ? '记位置的卡片太多了' : undefined
    default:
      return undefined
  }
}

/**
 * 把一份画布上这一步的改动放回去。只放「现在还是改之后的样子」的那几样，别的记进 skipped。
 * 返回新文档（有变化时 version 加 1；一样都没放回去就原样返回传进来的那份）
 */
export function revertCanvasPart(doc: CanvasDoc, part: Map<string, UndoChange>): { doc: CanvasDoc; restored: number; skipped: string[] } {
  const next: CanvasDoc = structuredClone(doc)
  let restored = 0
  const skipped: string[] = []
  for (const c of part.values()) {
    if (!same(c.kind, currentOf(next, c), c.after)) {
      skipped.push(`${changeName(c)}（之后又被改过）`)
      continue
    }
    const why = blocked(next, c)
    if (why) {
      skipped.push(`${changeName(c)}（${why}）`)
      continue
    }
    switch (c.kind) {
      case 'node':
        if (c.before) next.nodes[c.id] = { ...(c.before as CanvasNodeLayout) }
        else delete next.nodes[c.id]
        break
      case 'archived':
        next.archived = next.archived.filter((x) => x !== c.id)
        if (c.before) next.archived.push(c.id)
        break
      case 'note':
        putBack(next.notes, c.id, c.before as CanvasNote | undefined, c.index)
        break
      case 'relay':
        putBack(next.relays, c.id, c.before as CanvasRelay | undefined, c.index)
        break
      case 'widget':
        // 小窗还在、只是改了别的：终端连着的那个照旧用现在的
        putBack(next.widgets, c.id, c.before as CanvasWidget | undefined, c.index, (cur, v) => {
          const { termId: _t, ...rest } = v
          return { ...rest, ...(cur.termId ? { termId: cur.termId } : {}) }
        })
        break
      case 'template':
        putBack(next.templates, c.id, c.before as CanvasTemplate | undefined, c.index)
        break
    }
    restored++
  }
  if (restored === 0) return { doc, restored, skipped }
  next.version = doc.version + 1
  return { doc: next, restored, skipped }
}
