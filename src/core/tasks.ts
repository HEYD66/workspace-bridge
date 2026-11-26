import crypto from 'node:crypto'
import { ToolError } from './fileTools'
import { JsonStore } from './jsonStore'
import type { Actor } from './memory'
import { addQuestion as addQ, answerQuestion as answerQ, closeQuestion as closeQ, normalizeAllowedPaths, type ScopeOptions, type TaskQuestion } from './taskScope'
import type { TaskFieldChange, TaskItem, TaskStatus } from './types'

/** 操作任务的人：用户或某个 AI。没有职位权限之分，每个 AI 都能派活、改任务、审查别人的交付 */
export type TaskActor = Actor

export interface TaskDeps {
  /** AI 名字；不存在返回 undefined */
  nameOf: (agentId: string) => string | undefined
  /** 给某个 AI 留一条提示，它下次调用工具时会看到 */
  notify: (agentId: string, text: string) => void
  /** 工作区根目录和是不是整台电脑，用来规范化 allowedPaths；不给时不能设置 allowedPaths */
  scope?: () => ScopeOptions
}

/** 任务允许范围的输入：字符串数组；空数组或 null 表示清掉范围 */
export type AllowedPathsInput = string[] | null

const clip = (s: string, n = 100) => (s.length > n ? `${s.slice(0, n)}…` : s)

const STATUSES: TaskStatus[] = ['todo', 'in_progress', 'review', 'done', 'blocked']

/** 编辑历史里每个旧值、新值最多记多少字，超了截断 */
export const EDIT_HISTORY_VALUE_CHARS = 300

const FIELD_NAMES: Record<TaskFieldChange['field'], string> = { title: '标题', description: '说明', priority: '优先级', allowedPaths: '允许范围' }

function fieldChange(field: TaskFieldChange['field'], from: string, to: string): TaskFieldChange {
  const max = EDIT_HISTORY_VALUE_CHARS
  const truncated = from.length > max || to.length > max
  const cut = (s: string) => (s.length > max ? `${s.slice(0, max)}…（截断，原文 ${s.length} 字）` : s)
  return truncated ? { field, from: cut(from), to: cut(to), truncated: true } : { field, from, to }
}

/**
 * 任务板。把任务派给别人时记下 managedBy（派活的人）。
 * - 派活的是另一个 AI：执行者只能提交到 review，由派活的 AI 审查通过才算 done。
 * - 派活的是用户（或任务是用户建的、没人派）：不用等用户审查，执行者做完直接 done；提交 review 也直接记成 done。
 */
export class TaskStore {
  private store: JsonStore<{ seq: number; tasks: TaskItem[] }>

  constructor(
    file: string,
    private readonly deps: TaskDeps,
    onChange?: () => void
  ) {
    this.store = new JsonStore(file, () => ({ seq: 0, tasks: [] }), onChange)
  }

  all(): TaskItem[] {
    return this.store.get().tasks
  }

  private find(tasks: TaskItem[], key: string): TaskItem {
    const k = key.trim()
    const n = /^(t-)?\d+$/i.test(k) ? `T-${k.replace(/^t-/i, '')}` : null
    const t = tasks.find((x) => x.id === k || x.ref === n)
    if (!t) throw new ToolError('NOT_FOUND', `任务 ${key} 不存在`)
    return t
  }

  get(key: string): TaskItem {
    return this.find(this.store.get().tasks, key)
  }

  list(actor: Actor, opts: { status?: TaskStatus; assignee?: string; limit?: number } = {}): TaskItem[] {
    const who = opts.assignee === 'me' ? actor.id : opts.assignee
    return this.store
      .get()
      .tasks.filter((t) => !opts.status || t.status === opts.status)
      .filter((t) => !who || (who === 'none' ? !t.assigneeId : t.assigneeId === who))
      .sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || b.updatedAt - a.updatedAt)
      .slice(0, opts.limit ?? 100)
  }

  private checkAssignee(id: string | undefined): void {
    if (id && !this.deps.nameOf(id)) throw new ToolError('NOT_FOUND', `AI ${id} 不存在，用 team_list 查看可用成员`)
  }

  private log(t: TaskItem, actor: Actor, action: string, note?: string): void {
    t.updatedAt = Date.now()
    t.history.push({ ts: t.updatedAt, actorId: actor.id, actorName: actor.name, action, note: note?.slice(0, 2000) })
    if (t.history.length > 100) t.history.splice(0, t.history.length - 100)
  }

  private notify(agentId: string | undefined, actor: Actor, text: string): void {
    if (agentId && agentId !== actor.id && agentId !== 'user') this.deps.notify(agentId, text)
  }

  /** 规范化 allowedPaths；空数组和 null 返回 undefined（不限范围） */
  private normPaths(list: AllowedPathsInput): string[] | undefined {
    if (list === null) return undefined
    const scope = this.deps.scope?.()
    if (!scope) throw new ToolError('INVALID_STATE', '这个任务板没有工作区范围信息，不能设置 allowedPaths')
    return normalizeAllowedPaths(list, scope)
  }

  create(
    actor: TaskActor,
    input: { title: string; description?: string; priority?: TaskItem['priority']; assigneeId?: string; parentId?: string; allowedPaths?: AllowedPathsInput }
  ): TaskItem {
    const title = input.title?.trim()
    if (!title) throw new ToolError('INVALID_ARGS', 'title 不能为空')
    this.checkAssignee(input.assigneeId)
    const allowedPaths = input.allowedPaths === undefined ? undefined : this.normPaths(input.allowedPaths)
    const delegating = input.assigneeId && input.assigneeId !== actor.id
    let task!: TaskItem
    this.store.mutate((d) => {
      if (input.parentId) this.find(d.tasks, input.parentId)
      d.seq += 1
      const now = Date.now()
      task = {
        id: 't_' + crypto.randomBytes(5).toString('hex'),
        ref: `T-${d.seq}`,
        title: title.slice(0, 200),
        description: (input.description ?? '').slice(0, 8000),
        status: 'todo',
        priority: input.priority ?? 'normal',
        assigneeId: input.assigneeId,
        createdBy: actor.id,
        createdByName: actor.name,
        managedBy: delegating ? actor.id : undefined,
        parentId: input.parentId ? this.find(d.tasks, input.parentId).id : undefined,
        createdAt: now,
        updatedAt: now,
        history: [],
        ...(allowedPaths ? { allowedPaths } : {})
      }
      const notes = [input.assigneeId ? `指派给 ${this.deps.nameOf(input.assigneeId)}` : '', allowedPaths ? `允许范围：${allowedPaths.join('、')}` : ''].filter(Boolean)
      this.log(task, actor, 'created', notes.length ? notes.join('；') : undefined)
      d.tasks.push(task)
    })
    this.notify(task.assigneeId, actor, `${actor.name} 给你派了任务 ${task.ref}「${task.title}」，用 task_get 查看详情`)
    return task
  }

  claim(actor: TaskActor, key: string): TaskItem {
    let task!: TaskItem
    this.store.mutate((d) => {
      task = this.find(d.tasks, key)
      if (task.assigneeId && task.assigneeId !== actor.id) {
        throw new ToolError('ALREADY_ASSIGNED', `${task.ref} 已由 ${this.deps.nameOf(task.assigneeId) ?? task.assigneeId} 负责`)
      }
      if (task.status === 'done') throw new ToolError('INVALID_STATE', `${task.ref} 已完成`)
      task.assigneeId = actor.id
      if (task.status === 'todo') task.status = 'in_progress'
      this.log(task, actor, 'claimed')
    })
    return task
  }

  private applyUpdate(
    task: TaskItem,
    actor: TaskActor,
    input: { status?: TaskStatus; result?: string; note?: string }
  ): { notifyTarget?: string; notifyText: string } {
    let notifyTarget: string | undefined
    let notifyText = ''
    // 审查人：派活的人；没人派时是创建者。审查人是用户时不用审查
    const reviewer = task.managedBy
    const userReviews = (reviewer ?? task.createdBy) === 'user'
    if (input.status === 'done' && reviewer && reviewer !== 'user' && reviewer !== actor.id && actor.kind !== 'user') {
      throw new ToolError('REVIEW_REQUIRED', `${task.ref} 由 ${this.deps.nameOf(reviewer) ?? reviewer} 派发，需要审查：请把 status 设为 review，并在 result 写交付说明`)
    }
    // 工具说明写的是「提交审查时 result 必填」：AI 提交审查必须带交付说明（这次传或之前已经写过）
    if (input.status === 'review' && task.status !== 'review' && actor.kind !== 'user' && !(input.result ?? task.result ?? '').trim()) {
      throw new ToolError('INVALID_ARGS', `提交 ${task.ref} 审查时必须在 result 写交付说明（做了什么、结果在哪、怎么验证）`)
    }
    // AI 把用户的任务提交审查：没有人要点「通过」，直接算完成
    const status: TaskStatus | undefined = input.status === 'review' && userReviews && actor.kind !== 'user' ? 'done' : input.status
    if (input.result !== undefined) task.result = input.result.slice(0, 8000)
    if (status && status !== task.status) {
      task.status = status
      if (status === 'review' || status === 'blocked') {
        notifyTarget = reviewer ?? task.createdBy
        notifyText = `${actor.name} 把 ${task.ref}「${task.title}」${status === 'review' ? '提交审查，请用 task_review 处理' : '标记为受阻'}${input.note ? `：${input.note}` : ''}`
      }
    }
    const autoDone = status === 'done' && input.status === 'review'
    this.log(task, actor, status ? `status → ${status}${autoDone ? '（用户的任务不用审查，直接完成）' : ''}` : 'updated', input.note ?? input.result)
    return { notifyTarget, notifyText }
  }

  update(actor: TaskActor, key: string, input: { status?: TaskStatus; result?: string; note?: string }): TaskItem {
    let task!: TaskItem
    let notifyTarget: string | undefined
    let notifyText = ''
    this.store.mutate((d) => {
      task = this.find(d.tasks, key)
      ;({ notifyTarget, notifyText } = this.applyUpdate(task, actor, input))
    })
    this.notify(notifyTarget, actor, notifyText)
    return task
  }

  review(actor: TaskActor, key: string, decision: 'accept' | 'reject', note?: string): TaskItem {
    let task!: TaskItem
    this.store.mutate((d) => {
      task = this.find(d.tasks, key)
      if (task.status !== 'review') throw new ToolError('INVALID_STATE', `${task.ref} 当前状态是 ${task.status}，不在审查中`)
      // 唯一的限制：不能审查自己的交付。没人派给你、自己建自己做的任务直接设为 done，不用审查
      if (task.assigneeId === actor.id && actor.kind !== 'user') {
        throw new ToolError('FORBIDDEN', task.managedBy ? '不能审查自己的交付' : `${task.ref} 不是别人派给你的，没有审查人：直接用 task_update 把 status 设为 done`)
      }
      task.status = decision === 'accept' ? 'done' : 'in_progress'
      this.log(task, actor, decision === 'accept' ? 'review: accepted' : 'review: rejected', note)
    })
    this.notify(
      task.assigneeId,
      actor,
      decision === 'accept' ? `${actor.name} 通过了 ${task.ref}「${task.title}」` : `${actor.name} 退回了 ${task.ref}「${task.title}」：${note ?? '请查看任务记录'}`
    )
    return task
  }

  assign(actor: TaskActor, key: string, assigneeId: string | undefined): TaskItem {
    this.checkAssignee(assigneeId)
    let task!: TaskItem
    this.store.mutate((d) => {
      task = this.find(d.tasks, key)
      task.assigneeId = assigneeId
      task.managedBy = assigneeId ? actor.id : task.managedBy
      if (task.status === 'done') task.status = 'todo'
      this.log(task, actor, 'assigned', assigneeId ? `→ ${this.deps.nameOf(assigneeId)}` : '取消指派')
    })
    this.notify(assigneeId, actor, `${actor.name} 把任务 ${task.ref}「${task.title}」交给了你，用 task_get 查看详情`)
    return task
  }

  /**
   * 改标题、说明、优先级。
   * 标题和说明只有用户（工作台）、任务创建者、派活的人（managedBy）能改；其他 AI（包括执行者）改会报 FORBIDDEN，
   * 执行者有补充写进 result 或 note。优先级谁都能改。
   * 历史记一条 edited，changes 里是真正变了的字段的旧值和新值；什么都没变就不记。
   */
  private applyEdit(
    task: TaskItem,
    actor: TaskActor,
    input: { title?: string; description?: string; priority?: TaskItem['priority']; allowedPaths?: AllowedPathsInput }
  ): void {
    const next = {
      title: input.title === undefined ? undefined : input.title.trim().slice(0, 200),
      description: input.description === undefined ? undefined : input.description.slice(0, 8000)
    }
    if (next.title !== undefined && !next.title) throw new ToolError('INVALID_ARGS', 'title 不能为空')
    const touchesText = (next.title !== undefined && next.title !== task.title) || (next.description !== undefined && next.description !== task.description)
    if (touchesText && !this.canEditText(actor, task)) {
      throw new ToolError(
        'FORBIDDEN',
        `${task.ref} 的标题和说明只有创建者 ${task.createdByName}${task.managedBy && task.managedBy !== task.createdBy ? `、派活的 ${this.deps.nameOf(task.managedBy) ?? task.managedBy}` : ''} 或用户能改；补充内容请写进 result 或 note`
      )
    }
    const changes: TaskFieldChange[] = []
    if (next.title !== undefined && next.title !== task.title) {
      changes.push(fieldChange('title', task.title, next.title))
      task.title = next.title
    }
    if (next.description !== undefined && next.description !== task.description) {
      changes.push(fieldChange('description', task.description, next.description))
      task.description = next.description
    }
    if (input.priority && input.priority !== task.priority) {
      changes.push(fieldChange('priority', task.priority, input.priority))
      task.priority = input.priority
    }
    // 允许范围和标题、说明一样，只有用户、创建者、派活的人能改：执行者不能自己放宽范围
    if (input.allowedPaths !== undefined) {
      const nextPaths = this.normPaths(input.allowedPaths)
      const show = (p: string[] | undefined) => (p?.length ? p.join('\n') : '（不限）')
      if (show(nextPaths) !== show(task.allowedPaths)) {
        if (!this.canEditText(actor, task)) {
          throw new ToolError('FORBIDDEN', `${task.ref} 的允许范围只有创建者、派活的人或用户能改；需要扩大范围请用问题或 note 说明`)
        }
        changes.push(fieldChange('allowedPaths', show(task.allowedPaths), show(nextPaths)))
        if (nextPaths) task.allowedPaths = nextPaths
        else delete task.allowedPaths
      }
    }
    if (!changes.length) return
    this.log(task, actor, 'edited', `改了${changes.map((c) => FIELD_NAMES[c.field]).join('、')}`)
    task.history[task.history.length - 1].changes = changes
  }

  edit(actor: TaskActor, key: string, input: { title?: string; description?: string; priority?: TaskItem['priority']; allowedPaths?: AllowedPathsInput }): TaskItem {
    let task!: TaskItem
    this.store.mutate((d) => {
      task = this.find(d.tasks, key)
      this.applyEdit(task, actor, input)
    })
    return task
  }

  /** 在同一次持久化事务里先后应用编辑和状态/结果更新，任一步失败整体回滚，不留半截改动 */
  editAndUpdate(
    actor: TaskActor,
    key: string,
    input: {
      title?: string
      description?: string
      priority?: TaskItem['priority']
      allowedPaths?: AllowedPathsInput
      status?: TaskStatus
      result?: string
      note?: string
    }
  ): TaskItem {
    const hasEdit = input.title !== undefined || input.description !== undefined || input.priority !== undefined || input.allowedPaths !== undefined
    const hasUpdate = input.status !== undefined || input.result !== undefined || input.note !== undefined
    let task!: TaskItem
    let notifyTarget: string | undefined
    let notifyText = ''
    this.store.mutate((d) => {
      task = this.find(d.tasks, key)
      if (hasEdit) {
        this.applyEdit(task, actor, { title: input.title, description: input.description, priority: input.priority, allowedPaths: input.allowedPaths })
      }
      if (hasUpdate || !hasEdit) {
        ;({ notifyTarget, notifyText } = this.applyUpdate(task, actor, { status: input.status, result: input.result, note: input.note }))
      }
    })
    this.notify(notifyTarget, actor, notifyText)
    return task
  }

  private qActor(actor: Actor): { id: string; name: string } {
    return { id: actor.kind === 'user' ? 'user' : actor.id, name: actor.name }
  }

  /**
   * 提一个等人决定的问题（谁都能提，一般是执行者）。历史记 question_added；
   * 通知派活的人和创建者（是 AI 时），用户那边的提示由接线方做
   */
  addQuestion(actor: TaskActor, key: string, input: { text: unknown; options?: unknown }): { task: TaskItem; question: TaskQuestion } {
    let task!: TaskItem
    let question!: TaskQuestion
    this.store.mutate((d) => {
      task = this.find(d.tasks, key)
      const r = addQ(task.questions, this.qActor(actor), input)
      question = r.question
      task.questions = r.questions
      this.log(task, actor, 'question_added', `${question.id}：${question.text}`)
    })
    for (const id of new Set([task.managedBy, task.createdBy])) {
      this.notify(id, actor, `${actor.name} 在 ${task.ref}「${task.title}」提了问题 ${question.id}，等你决定：${clip(question.text)}（用 task_get 查看）`)
    }
    return { task, question }
  }

  /** 回答问题：只有用户、创建者、派活的人能答（canAnswerQuestion）。历史记 question_answered；通知提问的人和执行者 */
  answerQuestion(actor: TaskActor, key: string, questionId: string, answer: unknown): { task: TaskItem; question: TaskQuestion } {
    let task!: TaskItem
    let question!: TaskQuestion
    this.store.mutate((d) => {
      task = this.find(d.tasks, key)
      const r = answerQ(task.questions, task, this.qActor(actor), questionId, answer)
      question = r.question
      task.questions = r.questions
      this.log(task, actor, 'question_answered', `${question.id} → ${question.answer}`)
    })
    for (const id of new Set([question.askedBy, task.assigneeId])) {
      this.notify(id, actor, `${actor.name} 回答了 ${task.ref}「${task.title}」的问题 ${question.id}：${clip(question.answer ?? '')}`)
    }
    return { task, question }
  }

  /** 关掉问题（不用再决定）：提问的人和能回答的人能关。历史记 question_closed；通知提问的人和执行者 */
  closeQuestion(actor: TaskActor, key: string, questionId: string, note?: unknown): { task: TaskItem; question: TaskQuestion } {
    let task!: TaskItem
    let question!: TaskQuestion
    this.store.mutate((d) => {
      task = this.find(d.tasks, key)
      const r = closeQ(task.questions, task, this.qActor(actor), questionId, note)
      question = r.question
      task.questions = r.questions
      this.log(task, actor, 'question_closed', `${question.id}${question.closeNote ? `：${question.closeNote}` : ''}`)
    })
    for (const id of new Set([question.askedBy, task.assigneeId])) {
      this.notify(id, actor, `${actor.name} 关掉了 ${task.ref}「${task.title}」的问题 ${question.id}${question.closeNote ? `：${clip(question.closeNote)}` : ''}`)
    }
    return { task, question }
  }

  /** 能不能改标题和说明：用户、创建者、派活的人 */
  private canEditText(actor: TaskActor, task: TaskItem): boolean {
    return actor.kind === 'user' || actor.id === task.createdBy || (!!task.managedBy && actor.id === task.managedBy)
  }

  /**
   * 删除任务，子任务一起删，恢复不了。用户（工作台）和 AI（task_delete）都能删任何任务。
   * 给了 actor 时，被删任务里还没做完的，通知它的执行者别再做了
   */
  remove(key: string, actor?: Actor): { ref: string; title: string; subtasks: number } {
    let out = { ref: '', title: '', subtasks: 0 }
    const gone: TaskItem[] = []
    this.store.mutate((d) => {
      const t = this.find(d.tasks, key)
      gone.push(...d.tasks.filter((x) => x.id === t.id || x.parentId === t.id))
      d.tasks = d.tasks.filter((x) => x.id !== t.id && x.parentId !== t.id)
      out = { ref: t.ref, title: t.title, subtasks: gone.length - 1 }
    })
    if (actor) {
      for (const t of gone) {
        if (t.status !== 'done') this.notify(t.assigneeId, actor, `${actor.name} 删除了任务 ${t.ref}「${t.title}」，不用再做了`)
      }
    }
    return out
  }

  /** 吊销 AI 时：它负责的未完成任务退回待认领；它派出去的未完成任务改由用户审查 */
  unassignAgent(agentId: string): number {
    let n = 0
    const actor: Actor = { id: 'user', name: '用户', kind: 'user' }
    this.store.mutate((d) => {
      for (const t of d.tasks) {
        if (t.status === 'done') continue
        let changed = false
        if (t.assigneeId === agentId) {
          t.assigneeId = undefined
          t.status = 'todo'
          this.log(t, actor, 'unassigned', '执行者已被吊销')
          changed = true
        }
        if (t.managedBy === agentId) {
          t.managedBy = 'user'
          this.log(t, actor, 'reviewer changed', '派活的 AI 已被吊销，改由用户审查')
          changed = true
        }
        if (changed) n++
      }
    })
    return n
  }
}
