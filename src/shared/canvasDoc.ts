// 画布上「用户自己摆的东西」：卡片位置、便签、收纳了哪些、团队模板、镜头位置。每个项目一份。
// 卡片本身（哪些 AI、什么状态、哪些线）不存，每次从工作台的数据现算（canvasModel.ts）。
// 这个文件是纯计算，界面和主进程共用：applyCanvasOps 把一串改动应用到一份文档上，得到新文档。

/** 「总画布」那一份的 id：所有项目画在一张图上时，卡片位置和镜头存在这一份里。别的（便签、接力线、模板、收纳、看过的交付）按项目存 */
export const CANVAS_ALL = 'all'

export const CANVAS_LIMITS = {
  /** 记位置的卡片数上限 */
  nodes: 2000,
  notes: 200,
  noteText: 2000,
  templates: 30,
  templateMembers: 50,
  relays: 100,
  /** 画布上的终端、网页、文件卡片一共最多几张 */
  widgets: 60,
  widgetText: 2000,
  /** 记多少条「看过的交付」，多了丢最早的 */
  acks: 500,
  name: 80,
  /** 一次最多带几条改动 */
  ops: 500
} as const

export const CANVAS_ZOOM_MIN = 0.1
export const CANVAS_ZOOM_MAX = 4

/** 一张卡片摆在哪（画布坐标）。键是卡片 id：AI 是成员 id，用户是 'user'，便签是便签 id，框是框 id */
export interface CanvasNodeLayout {
  x: number
  y: number
  /** 用户调过大小才有 */
  w?: number
  h?: number
  /** 钉住：一键整理时不动它 */
  pinned?: boolean
}

export interface CanvasNote {
  /** n_ 开头 */
  id: string
  text: string
  /** 颜色名或 #rrggbb，界面自己解释 */
  color?: string
  /** 谁贴的：成员 id，用户是 'user' */
  by: string
  byName: string
  /** 贴在谁的卡片旁边（成员 id）：便签自己没有位置时，界面把它摆在这张卡片边上 */
  near?: string
  createdAt: number
  updatedAt: number
}

/** 团队模板：一个主脑带哪些子代理，存下来以后一键套用 */
export interface CanvasTemplate {
  /** tp_ 开头 */
  id: string
  name: string
  leadId?: string
  memberIds: string[]
  createdAt: number
}

/** 接力线：from 做完一条任务，工作台自动把结果转告 to，让它接着做 */
export interface CanvasRelay {
  /** r_ 开头 */
  id: string
  from: string
  to: string
  createdAt: number
}

/** 画布上的一张工具卡片：终端、网页、文件。位置和大小记在 nodes 里（键是它的 id） */
export interface CanvasWidget {
  /** wd_ 开头 */
  id: string
  kind: CanvasWidgetKind
  /** 属于哪个项目：终端在它的目录里开，文件的路径相对它 */
  workspaceId: string
  /** file：相对工作区的路径；terminal：在哪个目录开（可以没有，就是工作区根目录） */
  path?: string
  /** web：网址 */
  url?: string
  title?: string
  /** terminal：现在连着的那个终端的 id。终端关了、工作台重启以后它就失效了，界面发现找不到就重新开一个再记上 */
  termId?: string
  createdAt: number
}

export type CanvasWidgetKind = 'terminal' | 'web' | 'file'
const WIDGET_KINDS: readonly CanvasWidgetKind[] = ['terminal', 'web', 'file']

export interface CanvasViewport {
  x: number
  y: number
  zoom: number
}

export interface CanvasDoc {
  /** 每改一次加 1；界面拿它判断手里的是不是最新的 */
  version: number
  nodes: Record<string, CanvasNodeLayout>
  notes: CanvasNote[]
  /** 收纳起来的卡片 id（不显示，可以放回来） */
  archived: string[]
  templates: CanvasTemplate[]
  relays: CanvasRelay[]
  widgets: CanvasWidget[]
  /** 用户看过的交付：任务编号 → 看的时间。任务在这之后又有改动就又算没看过 */
  acks: Record<string, number>
  /** 「全部看过」的时间：这之前做完的都算看过 */
  ackAll?: number
  viewport?: CanvasViewport
}

export type CanvasOp =
  /** 摆一张或几张卡片：给了的项覆盖，没给的保留；w / h / pinned 传 null 是去掉 */
  | { op: 'move'; nodes: { id: string; x: number; y: number; w?: number | null; h?: number | null; pinned?: boolean | null }[] }
  /** 忘掉一张卡片的位置（下次按自动排版放） */
  | { op: 'forget'; ids: string[] }
  /** 贴便签；x / y 给了就同时记位置。id 不给就自动起 */
  | { op: 'addNote'; id?: string; text: string; color?: string; x?: number; y?: number; near?: string }
  | { op: 'editNote'; id: string; text?: string; color?: string | null }
  | { op: 'removeNote'; id: string }
  | { op: 'archive'; ids: string[] }
  | { op: 'unarchive'; ids: string[] }
  | { op: 'viewport'; x: number; y: number; zoom: number }
  | { op: 'saveTemplate'; id?: string; name: string; leadId?: string; memberIds: string[] }
  | { op: 'removeTemplate'; id: string }
  /** 连一条接力线（两头都要是 AI，界面负责检查）；同样的线已经有了就不重复加 */
  | { op: 'addRelay'; from: string; to: string }
  | { op: 'removeRelay'; id: string }
  /** 放一张终端 / 网页 / 文件卡片；x / y（和 w / h）给了就同时记位置。file 要带 path，web 要带 url */
  | { op: 'addWidget'; id?: string; kind: CanvasWidgetKind; workspaceId: string; path?: string; url?: string; title?: string; termId?: string; x?: number; y?: number; w?: number; h?: number }
  /** 改一张工具卡片：给了的项覆盖，传 null 是去掉 */
  | { op: 'editWidget'; id: string; path?: string | null; url?: string | null; title?: string | null; termId?: string | null }
  /** 拿掉一张工具卡片（它的位置一起忘掉） */
  | { op: 'removeWidget'; id: string }
  /** 用户看过这几条任务的交付了（refs 是任务编号，如 T-12） */
  | { op: 'ackTasks'; refs: string[] }
  /** 全部看过：到现在为止做完的都不再提醒 */
  | { op: 'ackAllTasks' }

export interface CanvasActor {
  id: string
  name: string
}

export class CanvasOpError extends Error {}

export function emptyCanvasDoc(): CanvasDoc {
  return { version: 0, nodes: {}, notes: [], archived: [], templates: [], relays: [], widgets: [], acks: {} }
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const str = (v: unknown): v is string => typeof v === 'string'
const idOk = (v: unknown): v is string => str(v) && v.length > 0 && v.length <= 200

function randomId(prefix: string, taken: (id: string) => boolean): string {
  for (;;) {
    const id = `${prefix}${Math.random().toString(36).slice(2, 10)}`
    if (!taken(id)) return id
  }
}

function fail(message: string): never {
  throw new CanvasOpError(message)
}

/**
 * 把一串改动应用到文档上，返回新文档（不动传进来的那份）。有一条不合规就整串都不做，抛 CanvasOpError。
 * 一条都没带来变化时原样返回传进来的那份（version 不加）。
 */
export function applyCanvasOps(doc: CanvasDoc, ops: readonly CanvasOp[], actor: CanvasActor, now: number): CanvasDoc {
  if (!Array.isArray(ops)) fail('改动要是一个数组')
  if (ops.length > CANVAS_LIMITS.ops) fail(`一次最多 ${CANVAS_LIMITS.ops} 条改动`)
  const next: CanvasDoc = {
    version: doc.version,
    nodes: { ...doc.nodes },
    notes: doc.notes.map((n) => ({ ...n })),
    archived: [...doc.archived],
    templates: doc.templates.map((t) => ({ ...t, memberIds: [...t.memberIds] })),
    relays: doc.relays.map((r) => ({ ...r })),
    widgets: doc.widgets.map((w) => ({ ...w })),
    acks: { ...doc.acks },
    ...(doc.ackAll !== undefined ? { ackAll: doc.ackAll } : {}),
    ...(doc.viewport ? { viewport: { ...doc.viewport } } : {})
  }
  for (const op of ops) {
    if (!op || typeof op !== 'object') fail('改动的格式不对')
    switch (op.op) {
      case 'move': {
        if (!Array.isArray(op.nodes)) fail('move 要带 nodes 数组')
        for (const n of op.nodes) {
          if (!n || !idOk(n.id) || !fin(n.x) || !fin(n.y)) fail('move 的每一项要有 id 和数字的 x、y')
          const prev = next.nodes[n.id]
          const item: CanvasNodeLayout = { ...prev, x: n.x, y: n.y }
          for (const key of ['w', 'h'] as const) {
            const v = n[key]
            if (v === null) delete item[key]
            else if (v !== undefined) {
              if (!fin(v) || v <= 0) fail(`move 的 ${key} 要是正数`)
              item[key] = v
            }
          }
          if (n.pinned === null || n.pinned === false) delete item.pinned
          else if (n.pinned === true) item.pinned = true
          next.nodes[n.id] = item
        }
        if (Object.keys(next.nodes).length > CANVAS_LIMITS.nodes) fail(`最多记 ${CANVAS_LIMITS.nodes} 张卡片的位置`)
        break
      }
      case 'forget': {
        if (!Array.isArray(op.ids)) fail('forget 要带 ids 数组')
        for (const id of op.ids) delete next.nodes[id]
        break
      }
      case 'addNote': {
        if (!str(op.text) || !op.text.trim()) fail('便签不能是空的')
        if (op.text.length > CANVAS_LIMITS.noteText) fail(`便签最长 ${CANVAS_LIMITS.noteText} 字`)
        if (next.notes.length >= CANVAS_LIMITS.notes) fail(`便签最多 ${CANVAS_LIMITS.notes} 张，先删掉一些`)
        if (op.id !== undefined && (!idOk(op.id) || !op.id.startsWith('n_'))) fail('便签 id 要以 n_ 开头')
        if (op.id !== undefined && next.notes.some((n) => n.id === op.id)) fail(`便签 ${op.id} 已经有了`)
        const id = op.id ?? randomId('n_', (x) => next.notes.some((n) => n.id === x))
        next.notes.push({ id, text: op.text, ...(str(op.color) && op.color ? { color: op.color.slice(0, 30) } : {}), by: actor.id, byName: actor.name, ...(idOk(op.near) ? { near: op.near } : {}), createdAt: now, updatedAt: now })
        if (fin(op.x) && fin(op.y)) next.nodes[id] = { x: op.x, y: op.y }
        break
      }
      case 'editNote': {
        const note = next.notes.find((n) => n.id === op.id)
        if (!note) fail(`没有便签 ${String(op.id)}`)
        if (op.text !== undefined) {
          if (!str(op.text) || !op.text.trim()) fail('便签不能是空的')
          if (op.text.length > CANVAS_LIMITS.noteText) fail(`便签最长 ${CANVAS_LIMITS.noteText} 字`)
          note.text = op.text
        }
        if (op.color === null) delete note.color
        else if (str(op.color) && op.color) note.color = op.color.slice(0, 30)
        note.updatedAt = now
        break
      }
      case 'removeNote': {
        const at = next.notes.findIndex((n) => n.id === op.id)
        if (at < 0) fail(`没有便签 ${String(op.id)}`)
        next.notes.splice(at, 1)
        delete next.nodes[op.id]
        next.archived = next.archived.filter((id) => id !== op.id)
        break
      }
      case 'archive': {
        if (!Array.isArray(op.ids) || !op.ids.every(idOk)) fail('archive 要带 ids 数组')
        for (const id of op.ids) if (!next.archived.includes(id)) next.archived.push(id)
        if (next.archived.length > CANVAS_LIMITS.nodes) fail('收纳的卡片太多了')
        break
      }
      case 'unarchive': {
        if (!Array.isArray(op.ids)) fail('unarchive 要带 ids 数组')
        const drop = new Set(op.ids)
        next.archived = next.archived.filter((id) => !drop.has(id))
        break
      }
      case 'viewport': {
        if (!fin(op.x) || !fin(op.y) || !fin(op.zoom) || op.zoom <= 0) fail('viewport 要有数字的 x、y 和正数的 zoom')
        next.viewport = { x: op.x, y: op.y, zoom: Math.min(CANVAS_ZOOM_MAX, Math.max(CANVAS_ZOOM_MIN, op.zoom)) }
        break
      }
      case 'saveTemplate': {
        const name = str(op.name) ? op.name.trim() : ''
        if (!name) fail('模板要有名字')
        if (name.length > CANVAS_LIMITS.name) fail(`模板名最长 ${CANVAS_LIMITS.name} 字`)
        if (!Array.isArray(op.memberIds) || !op.memberIds.every(idOk)) fail('模板要带 memberIds 数组')
        if (op.memberIds.length > CANVAS_LIMITS.templateMembers) fail(`一个模板最多 ${CANVAS_LIMITS.templateMembers} 个成员`)
        if (op.leadId !== undefined && !idOk(op.leadId)) fail('leadId 不对')
        // 主脑不重复算进成员里；成员去重
        const memberIds = [...new Set<string>(op.memberIds as string[])].filter((id) => id !== op.leadId)
        const body = { name, ...(op.leadId ? { leadId: op.leadId } : {}), memberIds }
        if (op.id !== undefined) {
          const at = next.templates.findIndex((t) => t.id === op.id)
          if (at < 0) fail(`没有模板 ${String(op.id)}`)
          next.templates[at] = { id: op.id, ...body, createdAt: next.templates[at].createdAt }
        } else {
          if (next.templates.length >= CANVAS_LIMITS.templates) fail(`模板最多 ${CANVAS_LIMITS.templates} 个，先删掉一些`)
          next.templates.push({ id: randomId('tp_', (x) => next.templates.some((t) => t.id === x)), ...body, createdAt: now })
        }
        break
      }
      case 'addWidget': {
        if (!WIDGET_KINDS.includes(op.kind)) fail('kind 要是 terminal、web、file 之一')
        if (!idOk(op.workspaceId)) fail('要带 workspaceId')
        if (next.widgets.length >= CANVAS_LIMITS.widgets) fail(`终端、网页、文件卡片一共最多 ${CANVAS_LIMITS.widgets} 张，先关掉一些`)
        if (op.id !== undefined && (!idOk(op.id) || !op.id.startsWith('wd_'))) fail('卡片 id 要以 wd_ 开头')
        if (op.id !== undefined && next.widgets.some((w) => w.id === op.id)) fail(`卡片 ${op.id} 已经有了`)
        const text = (v: unknown, what: string): string | undefined => {
          if (v === undefined) return undefined
          if (!str(v) || v.length > CANVAS_LIMITS.widgetText) fail(`${what} 不对`)
          return v.trim() || undefined
        }
        const path = text(op.path, 'path')
        const url = text(op.url, 'url')
        const title = text(op.title, 'title')
        const termId = text(op.termId, 'termId')
        if (op.kind === 'file' && !path) fail('文件卡片要带 path')
        if (op.kind === 'web' && !url) fail('网页卡片要带 url')
        const id = op.id ?? randomId('wd_', (x) => next.widgets.some((w) => w.id === x))
        next.widgets.push({ id, kind: op.kind, workspaceId: op.workspaceId, ...(path ? { path } : {}), ...(url ? { url } : {}), ...(title ? { title: title.slice(0, CANVAS_LIMITS.name) } : {}), ...(termId ? { termId } : {}), createdAt: now })
        if (fin(op.x) && fin(op.y)) next.nodes[id] = { x: op.x, y: op.y, ...(fin(op.w) && op.w > 0 ? { w: op.w } : {}), ...(fin(op.h) && op.h > 0 ? { h: op.h } : {}) }
        break
      }
      case 'editWidget': {
        const widget = next.widgets.find((w) => w.id === op.id)
        if (!widget) fail(`没有卡片 ${String(op.id)}`)
        for (const key of ['path', 'url', 'title', 'termId'] as const) {
          const v = op[key]
          if (v === undefined) continue
          if (v === null || (str(v) && !v.trim())) delete widget[key]
          else if (str(v) && v.length <= CANVAS_LIMITS.widgetText) widget[key] = key === 'title' ? v.trim().slice(0, CANVAS_LIMITS.name) : v.trim()
          else fail(`${key} 不对`)
        }
        if (widget.kind === 'file' && !widget.path) fail('文件卡片不能没有 path')
        if (widget.kind === 'web' && !widget.url) fail('网页卡片不能没有 url')
        break
      }
      case 'removeWidget': {
        const at = next.widgets.findIndex((w) => w.id === op.id)
        if (at < 0) fail(`没有卡片 ${String(op.id)}`)
        next.widgets.splice(at, 1)
        delete next.nodes[op.id]
        break
      }
      case 'removeTemplate': {
        const at = next.templates.findIndex((t) => t.id === op.id)
        if (at < 0) fail(`没有模板 ${String(op.id)}`)
        next.templates.splice(at, 1)
        break
      }
      case 'addRelay': {
        if (!idOk(op.from) || !idOk(op.to)) fail('接力线要有 from 和 to')
        if (op.from === op.to) fail('接力线不能连到自己')
        if (next.relays.some((r) => r.from === op.from && r.to === op.to)) break
        if (next.relays.length >= CANVAS_LIMITS.relays) fail(`接力线最多 ${CANVAS_LIMITS.relays} 条，先删掉一些`)
        next.relays.push({ id: randomId('r_', (x) => next.relays.some((r) => r.id === x)), from: op.from, to: op.to, createdAt: now })
        break
      }
      case 'removeRelay': {
        const at = next.relays.findIndex((r) => r.id === op.id)
        if (at < 0) fail(`没有接力线 ${String(op.id)}`)
        next.relays.splice(at, 1)
        break
      }
      case 'ackTasks': {
        if (!Array.isArray(op.refs) || !op.refs.every(idOk)) fail('ackTasks 要带 refs 数组')
        for (const ref of op.refs) next.acks[ref] = now
        const keys = Object.keys(next.acks)
        if (keys.length > CANVAS_LIMITS.acks) {
          // 丢最早看的那些
          keys.sort((a, b) => next.acks[a] - next.acks[b])
          for (const k of keys.slice(0, keys.length - CANVAS_LIMITS.acks)) delete next.acks[k]
        }
        break
      }
      case 'ackAllTasks': {
        next.ackAll = now
        next.acks = {}
        break
      }
      default:
        fail(`不认识的改动：${String((op as { op?: unknown }).op)}`)
    }
  }
  if (sameDoc(doc, next)) return doc
  next.version = doc.version + 1
  return next
}

function sameDoc(a: CanvasDoc, b: CanvasDoc): boolean {
  return JSON.stringify({ ...a, version: 0 }) === JSON.stringify({ ...b, version: 0 })
}

/** 从磁盘读回来的东西洗一遍：格式不对的项丢掉，整个不对就给空的 */
export function sanitizeCanvasDoc(raw: unknown): CanvasDoc {
  const doc = emptyCanvasDoc()
  if (!raw || typeof raw !== 'object') return doc
  const r = raw as Record<string, unknown>
  if (fin(r.version) && r.version >= 0) doc.version = Math.floor(r.version)
  if (r.nodes && typeof r.nodes === 'object' && !Array.isArray(r.nodes)) {
    for (const [id, v] of Object.entries(r.nodes as Record<string, unknown>)) {
      const n = v as Partial<CanvasNodeLayout> | null
      if (!n || !idOk(id) || !fin(n.x) || !fin(n.y)) continue
      doc.nodes[id] = { x: n.x, y: n.y, ...(fin(n.w) && n.w > 0 ? { w: n.w } : {}), ...(fin(n.h) && n.h > 0 ? { h: n.h } : {}), ...(n.pinned === true ? { pinned: true } : {}) }
    }
  }
  if (Array.isArray(r.notes)) {
    for (const v of r.notes as Partial<CanvasNote>[]) {
      if (!v || !idOk(v.id) || !str(v.text) || !str(v.by) || doc.notes.some((n) => n.id === v.id)) continue
      const createdAt = fin(v.createdAt) ? v.createdAt : 0
      doc.notes.push({ id: v.id, text: v.text.slice(0, CANVAS_LIMITS.noteText), ...(str(v.color) && v.color ? { color: v.color } : {}), by: v.by, byName: str(v.byName) ? v.byName : v.by, ...(idOk(v.near) ? { near: v.near } : {}), createdAt, updatedAt: fin(v.updatedAt) ? v.updatedAt : createdAt })
    }
  }
  if (Array.isArray(r.archived)) doc.archived = [...new Set((r.archived as unknown[]).filter(idOk))]
  if (Array.isArray(r.templates)) {
    for (const v of r.templates as Partial<CanvasTemplate>[]) {
      if (!v || !idOk(v.id) || !str(v.name) || !Array.isArray(v.memberIds) || doc.templates.some((t) => t.id === v.id)) continue
      doc.templates.push({ id: v.id, name: v.name, ...(idOk(v.leadId) ? { leadId: v.leadId } : {}), memberIds: v.memberIds.filter(idOk), createdAt: fin(v.createdAt) ? v.createdAt : 0 })
    }
  }
  if (Array.isArray(r.relays)) {
    for (const v of r.relays as Partial<CanvasRelay>[]) {
      if (!v || !idOk(v.id) || !idOk(v.from) || !idOk(v.to) || v.from === v.to || doc.relays.some((x) => x.id === v.id)) continue
      doc.relays.push({ id: v.id, from: v.from, to: v.to, createdAt: fin(v.createdAt) ? v.createdAt : 0 })
    }
  }
  if (Array.isArray(r.widgets)) {
    for (const v of r.widgets as Partial<CanvasWidget>[]) {
      if (!v || !idOk(v.id) || !WIDGET_KINDS.includes(v.kind as CanvasWidgetKind) || !idOk(v.workspaceId) || doc.widgets.some((w) => w.id === v.id)) continue
      if ((v.kind === 'file' && !str(v.path)) || (v.kind === 'web' && !str(v.url)) || doc.widgets.length >= CANVAS_LIMITS.widgets) continue
      doc.widgets.push({ id: v.id, kind: v.kind as CanvasWidgetKind, workspaceId: v.workspaceId, ...(str(v.path) && v.path ? { path: v.path } : {}), ...(str(v.url) && v.url ? { url: v.url } : {}), ...(str(v.title) && v.title ? { title: v.title } : {}), ...(str(v.termId) && v.termId ? { termId: v.termId } : {}), createdAt: fin(v.createdAt) ? v.createdAt : 0 })
    }
  }
  if (r.acks && typeof r.acks === 'object' && !Array.isArray(r.acks)) {
    for (const [ref, at] of Object.entries(r.acks as Record<string, unknown>)) if (idOk(ref) && fin(at)) doc.acks[ref] = at
  }
  if (fin(r.ackAll)) doc.ackAll = r.ackAll
  const vp = r.viewport as Partial<CanvasViewport> | undefined
  if (vp && fin(vp.x) && fin(vp.y) && fin(vp.zoom) && vp.zoom > 0) doc.viewport = { x: vp.x, y: vp.y, zoom: vp.zoom }
  return doc
}
