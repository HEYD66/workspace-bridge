import crypto from 'node:crypto'
import { ToolError } from './fileTools'

// AI 自己维护的待办清单 / 计划和当前进度（set_todos、update_plan、report_progress）。
// 只存在内存里、按身份分开：Bridge 重启后清空，和 ShunCode 的「当前任务卡片」一样是过程状态，不是持久的任务（持久的用 task_*）。

export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export type PlanLifecycle = 'running' | 'completed' | 'blocked' | 'cancelled'

export interface TodoItem {
  id: string
  title: string
  status: TodoStatus
}

export interface ProgressEntry {
  message: string
  phase?: string
  percent?: number
  todoId?: string
  at: number
}

export interface PlanTask {
  taskId: string
  agentId: string
  revision: number
  lifecycle: PlanLifecycle
  todos: TodoItem[]
  explanation?: string
  progress?: ProgressEntry
  createdAt: number
  updatedAt: number
}

export interface SetTodosInput {
  todos: TodoItem[]
  mode?: 'replace' | 'patch'
  newTask?: boolean
  taskId?: string
  expectedRevision?: number
  lifecycle?: PlanLifecycle
  explanation?: string
}

export interface ProgressInput {
  message: string
  phase?: string
  percent?: number
  todoId?: string
  taskId?: string
}

/** 每个身份最多留几份清单（最旧的先丢） */
export const MAX_TASKS_PER_AGENT = 20
export const MAX_TODOS = 24

export class PlanStore {
  /** agentId → 清单，最后一个是当前清单 */
  private readonly byAgent = new Map<string, PlanTask[]>()

  /** 当前清单：最近更新、还没结束的那一份 */
  current(agentId: string): PlanTask | undefined {
    const list = this.byAgent.get(agentId) ?? []
    return list[list.length - 1]
  }

  get(agentId: string, taskId: string): PlanTask | undefined {
    return (this.byAgent.get(agentId) ?? []).find((t) => t.taskId === taskId)
  }

  list(agentId: string): PlanTask[] {
    return [...(this.byAgent.get(agentId) ?? [])]
  }

  setTodos(agentId: string, input: SetTodosInput): { task: PlanTask | null; cleared: boolean } {
    const mode = input.mode ?? 'replace'
    if (input.newTask && (input.taskId || input.expectedRevision !== undefined)) {
      throw new ToolError('INVALID_ARGS', 'new_task=true 时不能同时传 task_id 或 expected_revision')
    }
    if (mode === 'patch' && input.expectedRevision === undefined) {
      throw new ToolError('INVALID_ARGS', 'mode=patch 必须传 expected_revision（上次返回的 task_revision）')
    }
    if (input.taskId && input.expectedRevision === undefined) {
      throw new ToolError('INVALID_ARGS', '传了 task_id 就要同时传 expected_revision（上次返回的 task_revision）')
    }
    if (input.todos.length > MAX_TODOS) throw new ToolError('INVALID_ARGS', `最多 ${MAX_TODOS} 项`)
    checkIds(input.todos)

    let task: PlanTask | undefined
    if (input.newTask) {
      task = undefined
    } else if (input.taskId) {
      task = this.get(agentId, input.taskId)
      if (!task) throw new ToolError('TASK_NOT_FOUND', `没有 task_id=${input.taskId} 的清单（Bridge 重启后会清空），用 new_task=true 新建`)
    } else {
      task = this.current(agentId)
      // 上一份已经结束：没指明 task_id 时视为开始新的一份
      if (task && task.lifecycle !== 'running' && input.expectedRevision === undefined) task = undefined
    }
    if (input.expectedRevision !== undefined) {
      if (!task) throw new ToolError('TASK_NOT_FOUND', '没有可以续写的清单，用 new_task=true 新建')
      if (task.revision !== input.expectedRevision) {
        throw new ToolError('STALE_REVISION', `清单已经更新到第 ${task.revision} 版，你传的是第 ${input.expectedRevision} 版；用最新的 todos 和 expected_revision 再发一次`, {
          task_id: task.taskId,
          task_revision: task.revision,
          todos: task.todos
        })
      }
    }

    // 空清单 + replace：只清掉这一份
    if (mode === 'replace' && input.todos.length === 0 && !input.lifecycle) {
      if (task) this.remove(agentId, task.taskId)
      return { task: null, cleared: true }
    }

    let todos: TodoItem[]
    if (mode === 'patch' && task) {
      todos = task.todos.map((t) => ({ ...t }))
      for (const t of input.todos) {
        const i = todos.findIndex((x) => x.id === t.id)
        if (i >= 0) todos[i] = { ...t }
        else todos.push({ ...t })
      }
      if (todos.length > MAX_TODOS) throw new ToolError('INVALID_ARGS', `合并后超过 ${MAX_TODOS} 项`)
    } else {
      todos = input.todos.map((t) => ({ ...t }))
    }
    const doing = todos.filter((t) => t.status === 'in_progress')
    if (doing.length > 1) {
      throw new ToolError('INVALID_ARGS', `同时只能有一项 in_progress，现在有 ${doing.length} 项：${doing.map((t) => t.id).join('、')}`)
    }
    const lifecycle = input.lifecycle ?? task?.lifecycle ?? 'running'
    if (lifecycle === 'completed' && todos.some((t) => t.status !== 'completed')) {
      const left = todos.filter((t) => t.status !== 'completed').map((t) => t.id)
      throw new ToolError('INVALID_ARGS', `lifecycle=completed 要求每一项都是 completed，还没完成：${left.join('、')}；没做完请用 blocked 或 cancelled`)
    }

    const now = Date.now()
    if (!task) {
      task = { taskId: newTaskId(), agentId, revision: 0, lifecycle, todos: [], createdAt: now, updatedAt: now }
      this.push(agentId, task)
    } else {
      // 挪到末尾，成为当前清单
      this.remove(agentId, task.taskId)
      this.push(agentId, task)
    }
    task.todos = todos
    task.lifecycle = lifecycle
    if (input.explanation !== undefined) task.explanation = input.explanation
    task.revision += 1
    task.updatedAt = now
    return { task, cleared: false }
  }

  reportProgress(agentId: string, input: ProgressInput): { task: PlanTask | null; todoId: string | null; link: 'explicit' | 'auto' | 'none' } {
    let task: PlanTask | undefined
    if (input.taskId) {
      task = this.get(agentId, input.taskId)
      if (!task) throw new ToolError('TASK_NOT_FOUND', `没有 task_id=${input.taskId} 的清单`)
    } else {
      task = this.current(agentId)
    }
    let todoId: string | null = null
    let link: 'explicit' | 'auto' | 'none' = 'none'
    if (input.todoId) {
      if (!task || !task.todos.some((t) => t.id === input.todoId)) {
        throw new ToolError('TODO_NOT_FOUND', `当前清单里没有 id=${input.todoId} 的项${task ? `，现有：${task.todos.map((t) => t.id).join('、') || '（空）'}` : '（还没有清单，先 set_todos）'}`)
      }
      todoId = input.todoId
      link = 'explicit'
    } else if (task) {
      const doing = task.todos.filter((t) => t.status === 'in_progress')
      if (doing.length === 1) {
        todoId = doing[0].id
        link = 'auto'
      }
    }
    const entry: ProgressEntry = { message: input.message, at: Date.now() }
    if (input.phase) entry.phase = input.phase
    if (input.percent !== undefined) entry.percent = input.percent
    if (todoId) entry.todoId = todoId
    if (task) {
      task.progress = entry
      task.updatedAt = entry.at
    }
    return { task: task ?? null, todoId, link }
  }

  /** 身份被删除时清掉 */
  dropAgent(agentId: string): void {
    this.byAgent.delete(agentId)
  }

  private push(agentId: string, task: PlanTask): void {
    const list = this.byAgent.get(agentId) ?? []
    list.push(task)
    while (list.length > MAX_TASKS_PER_AGENT) list.shift()
    this.byAgent.set(agentId, list)
  }

  private remove(agentId: string, taskId: string): void {
    const list = this.byAgent.get(agentId)
    if (!list) return
    const i = list.findIndex((t) => t.taskId === taskId)
    if (i >= 0) list.splice(i, 1)
  }
}

function checkIds(todos: TodoItem[]): void {
  const seen = new Set<string>()
  for (const t of todos) {
    if (seen.has(t.id)) throw new ToolError('INVALID_ARGS', `todo id 重复：${t.id}`)
    seen.add(t.id)
  }
}

function newTaskId(): string {
  return 'plan_' + crypto.randomBytes(6).toString('hex')
}

/** 把 update_plan 的 [{step,status}] 转成带 id 的 todos：同名步骤沿用原来的 id，新步骤分配新 id */
export function planToTodos(plan: { step: string; status: TodoStatus }[], existing: TodoItem[] | undefined): TodoItem[] {
  const pool = new Map<string, string[]>()
  for (const t of existing ?? []) {
    const ids = pool.get(t.title) ?? []
    ids.push(t.id)
    pool.set(t.title, ids)
  }
  const used = new Set<string>()
  let n = 1
  const fresh = (): string => {
    const taken = new Set([...(existing ?? []).map((t) => t.id), ...used])
    while (taken.has(`step-${n}`)) n++
    return `step-${n++}`
  }
  return plan.map((p) => {
    const reuse = pool.get(p.step)?.shift()
    const id = reuse && !used.has(reuse) ? reuse : fresh()
    used.add(id)
    return { id, title: p.step, status: p.status }
  })
}

/** 给 AI 看的清单视图 */
export function planView(task: PlanTask): Record<string, unknown> {
  const done = task.todos.filter((t) => t.status === 'completed').length
  const doing = task.todos.find((t) => t.status === 'in_progress')
  return {
    task_id: task.taskId,
    task_revision: task.revision,
    lifecycle: task.lifecycle,
    completed: `${done}/${task.todos.length}`,
    in_progress: doing ? doing.id : null,
    todos: task.todos,
    ...(task.explanation ? { explanation: task.explanation } : {}),
    ...(task.progress
      ? {
          progress: {
            message: task.progress.message,
            phase: task.progress.phase ?? null,
            percent: task.progress.percent ?? null,
            todo_id: task.progress.todoId ?? null,
            at: new Date(task.progress.at).toISOString()
          }
        }
      : {})
  }
}

/** 活动记录里的一句话 */
export function planSummary(task: PlanTask): string {
  const done = task.todos.filter((t) => t.status === 'completed').length
  const doing = task.todos.find((t) => t.status === 'in_progress')
  const state = task.lifecycle === 'running' ? '' : `（${({ completed: '已完成', blocked: '受阻', cancelled: '已取消' } as const)[task.lifecycle]}）`
  return `清单 ${done}/${task.todos.length} 完成${doing ? `，进行中：${doing.title}` : ''}${state}`
}
