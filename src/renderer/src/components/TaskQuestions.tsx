// 第 12 条：任务详情里的「允许改的范围」和「等人决定的问题」。用户可以直接回答或关闭问题
import { Check, HelpCircle, X } from 'lucide-react'
import { useState } from 'react'
import type { TaskItem } from '../../../shared/api'
import { Badge, Button, Input } from './ui'
import { errText, timeAgo } from '../lib/format'

type Question = NonNullable<TaskItem['questions']>[number]

export function TaskScopeAndQuestions({ task, workspaceId }: { task: TaskItem; workspaceId?: string }) {
  const paths = task.allowedPaths ?? []
  const questions = task.questions ?? []
  if (paths.length === 0 && questions.length === 0) return null
  const open = questions.filter((q) => q.status === 'open')
  const rest = questions.filter((q) => q.status !== 'open')
  return (
    <div className="space-y-3">
      {paths.length > 0 && (
        <div className="space-y-1">
          <div className="text-[12px] text-faint">允许改的范围（超出只提醒，不拦）</div>
          <div className="flex flex-wrap gap-1.5">
            {paths.map((p) => (
              <code key={p} className="selectable rounded bg-hover px-1.5 py-0.5 font-mono text-[12px] text-fg">
                {p}
              </code>
            ))}
          </div>
        </div>
      )}
      {questions.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-[12px] text-faint">
            <HelpCircle size={12} /> 等人决定的问题{open.length ? `（${open.length} 个待回答）` : ''}
          </div>
          {[...open, ...rest].map((q) => (
            <QuestionRow key={q.id} task={task} q={q} workspaceId={workspaceId} />
          ))}
        </div>
      )}
    </div>
  )
}

function QuestionRow({ task, q, workspaceId }: { task: TaskItem; q: Question; workspaceId?: string }) {
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState('')
  const run = (fn: () => Promise<unknown>) => async () => {
    setError('')
    try {
      await fn()
      setAnswer('')
    } catch (e) {
      setError(errText(e))
    }
  }
  const submit = (text: string) => run(() => window.bridge.answerTaskQuestion(task.id, q.id, text, workspaceId))
  const isOpen = q.status === 'open'
  return (
    <div className={isOpen ? 'space-y-2 rounded-lg border border-accent/40 bg-accent/[0.05] p-3' : 'space-y-1 rounded-lg border border-line p-3 opacity-80'}>
      <div className="flex items-start gap-2">
        <span className="font-mono text-[11px] text-faint">{q.id}</span>
        <span className="selectable min-w-0 flex-1 text-[13px] whitespace-pre-wrap text-fg">{q.text}</span>
        <Badge color={isOpen ? '#d29922' : undefined}>{isOpen ? '待回答' : q.status === 'answered' ? '已回答' : '已关闭'}</Badge>
      </div>
      <div className="text-[11px] text-faint">
        {q.askedByName} 提于 {timeAgo(q.askedAt)}
      </div>
      {q.status === 'answered' && q.answer && (
        <div className="selectable text-[12.5px] text-fg">
          答：{q.answer}
          <span className="ml-2 text-[11px] text-faint">— {q.answeredByName}</span>
        </div>
      )}
      {q.status === 'closed' && (
        <div className="text-[12px] text-faint">
          {q.closedByName} 关闭{q.closeNote ? `：${q.closeNote}` : ''}
        </div>
      )}
      {isOpen && (
        <>
          {q.options?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((o) => (
                <Button key={o} onClick={submit(o)}>
                  {o}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="flex gap-2">
            <Input
              value={answer}
              placeholder="写下你的决定"
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && answer.trim()) void submit(answer.trim())()
              }}
              className="h-8 flex-1"
            />
            <Button variant="primary" disabled={!answer.trim()} onClick={submit(answer.trim())}>
              <Check size={14} /> 回答
            </Button>
            <Button onClick={run(() => window.bridge.closeTaskQuestion(task.id, q.id, undefined, workspaceId))}>
              <X size={14} /> 不用决定了
            </Button>
          </div>
        </>
      )}
      {error && <div className="text-[12px] text-bad">{error}</div>}
    </div>
  )
}
