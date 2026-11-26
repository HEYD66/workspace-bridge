// 画布的存储：每个项目一份 CanvasDoc，全部存在数据目录下的一个 canvas.json 里。
// 改动先进内存、马上生效，隔一小会儿再一起写盘（拖卡片时一秒里会来很多次改动）；退出时 flush 补写。
// 用户自己的改动另外记一份「怎么改回去」（canvasUndo.ts），给「撤销上一步」用；只在内存里，重启就清空。
import fs from 'node:fs'
import path from 'node:path'
import { applyCanvasOps, emptyCanvasDoc, sanitizeCanvasDoc, type CanvasActor, type CanvasDoc, type CanvasOp } from '../shared/canvasDoc'
import { CanvasUndoHistory, describeStep, revertCanvasPart, type CanvasUndoResult, type CanvasUndoState } from '../shared/canvasUndo'

const CANVAS_FILE_VERSION = 1
/** 用户的 actor id（和 chat.ts 的 CHAT_USER 一样）：只有它的改动能撤销 */
const USER_ACTOR = 'user'

export class CanvasStore {
  private docs = new Map<string, CanvasDoc>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private dirty = false
  private readonly history = new CanvasUndoHistory()

  constructor(
    readonly file: string,
    /** 有变化时叫一声（参数是项目的工作区 id） */
    private readonly onChange: (workspaceId: string) => void = () => {},
    private readonly delayMs = 800
  ) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown; workspaces?: unknown } | null
      if (raw && typeof raw === 'object' && raw.version === CANVAS_FILE_VERSION && raw.workspaces && typeof raw.workspaces === 'object') {
        for (const [id, doc] of Object.entries(raw.workspaces as Record<string, unknown>)) this.docs.set(id, sanitizeCanvasDoc(doc))
      }
    } catch {
      /* 没有这个文件，或者坏了：从空的开始 */
    }
  }

  /** 这个项目的画布；从没动过就是空的 */
  get(workspaceId: string): CanvasDoc {
    return this.docs.get(workspaceId) ?? emptyCanvasDoc()
  }

  /** 应用一串改动，返回新的文档。有一条不合规整串不做，抛 CanvasOpError。没有实际变化就不写盘、不通知 */
  update(workspaceId: string, ops: readonly CanvasOp[], actor: CanvasActor, now: number = Date.now()): CanvasDoc {
    const before = this.get(workspaceId)
    const after = applyCanvasOps(before, ops, actor, now)
    if (after === before) return before
    if (actor.id === USER_ACTOR) this.history.record(workspaceId, before, after, now)
    this.docs.set(workspaceId, after)
    this.schedule()
    this.onChange(workspaceId)
    return after
  }

  /** 现在能不能撤、撤的是什么 */
  undoState(): CanvasUndoState {
    return this.history.state()
  }

  /**
   * 撤销用户最近的一步。只放回「现在还是用户改完那样」的东西；之后被 AI（或别的）又改过的不硬撤，列在 skipped 里。
   * 这一步撤完（不管撤成多少）就不留了，下次撤更早的
   */
  undo(): CanvasUndoResult {
    const step = this.history.pop()
    if (!step) return { status: 'empty', message: '没有能撤销的了', skipped: [], state: this.history.state() }
    const label = describeStep(step)
    let restored = 0
    const skipped: string[] = []
    for (const [workspaceId, part] of step.parts) {
      const before = this.get(workspaceId)
      const r = revertCanvasPart(before, part)
      restored += r.restored
      skipped.push(...r.skipped)
      if (r.doc === before) continue
      this.docs.set(workspaceId, r.doc)
      this.schedule()
      this.onChange(workspaceId)
    }
    const state = this.history.state()
    const list = (n: number): string => skipped.slice(0, n).join('、') + (skipped.length > n ? ` 等 ${skipped.length} 样` : '')
    if (skipped.length === 0) return { status: 'done', label, message: `撤销了：${label}`, skipped, state }
    if (restored > 0) return { status: 'partial', label, message: `撤销了一部分：${label}。没撤的：${list(3)}`, skipped, state }
    return { status: 'conflict', label, message: `没法撤销「${label}」：${list(3)}。再撤一次就是更早的那一步`, skipped, state }
  }

  /** 项目删掉了：它的画布也不要了 */
  forget(workspaceId: string): void {
    this.history.forget(workspaceId)
    if (!this.docs.delete(workspaceId)) return
    this.schedule()
  }

  workspaceIds(): string[] {
    return [...this.docs.keys()]
  }

  private schedule(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), this.delayMs)
    this.timer.unref?.()
  }

  /** 马上写盘（退出前调）。写不进去不抛错：位置丢了可以再摆 */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.dirty) return
    this.dirty = false
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: CANVAS_FILE_VERSION, workspaces: Object.fromEntries(this.docs) }))
      fs.renameSync(tmp, this.file)
    } catch {
      this.dirty = true
    }
  }
}
