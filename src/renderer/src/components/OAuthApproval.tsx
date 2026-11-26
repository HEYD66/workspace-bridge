import { Check, ShieldAlert, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { BridgeState, PendingAuthorization } from '../../../shared/api'
import { errText } from '../lib/format'
import { Button, cx, Field, Input } from './ui'

/*
 * 网页 AI（ChatGPT / Claude.ai 连接器）发起 OAuth 授权时盖在整个应用上方的批准框（只在认证方式选了 OAuth 时出现）。
 * 这是「让不让它连进来」的一次性确认，不是对它每一步操作的审批；连进来之后它就是完全权限。
 * 安全要点：
 * - 只有主人点「批准」才会批准；Esc、点遮罩都不做任何事，也没有任何自动批准；
 * - 弹窗刚出现、或切到下一个请求后，批准按钮先锁 1 秒，防止正在别处点击时误点到；
 * - 新建身份是默认选项，不按客户端自报的名字预选已有身份（名字是对方填的，不可信）；
 * - 主人要核对浏览器页上的配对码和这里一致。
 */

const NEW = '__new__'
/** 弹窗出现后批准按钮先锁这么久 */
const ARM_DELAY_MS = 1000
export function OAuthApproval({ state }: { state: BridgeState }) {
  const pending = state.oauthPending ?? []
  // 已过期、主进程还没清理掉的请求，主人点「关闭」后先在本地藏起来
  const [dismissed, setDismissed] = useState<string[]>([])
  useTick(pending.length > 0)

  const now = Date.now()
  const queue = pending.filter((p) => !dismissed.includes(p.id)).sort((a, b) => a.createdAt - b.createdAt)
  if (queue.length === 0) return null
  // 处理最早的一个；优先没过期的，全都过期时显示最早的那个（标「已过期」）
  const current = queue.find((p) => p.expiresAt > now) ?? queue[0]
  const dismiss = (id: string) => setDismissed((d) => [...d.filter((x) => pending.some((p) => p.id === x)), id])
  // 「还有 N 个」只数没过期的
  const more = queue.filter((p) => p !== current && p.expiresAt > now).length

  return <ApprovalDialog key={current.id} state={state} req={current} now={now} more={more} onDismiss={dismiss} />
}

/** 有请求时每秒重渲染一次，刷新倒计时 */
function useTick(active: boolean) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [active])
}

function formatLeft(ms: number): string {
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function ApprovalDialog({
  state,
  req,
  now,
  more,
  onDismiss
}: {
  state: BridgeState
  req: PendingAuthorization
  now: number
  more: number
  onDismiss: (id: string) => void
}) {
  const [sel, setSel] = useState(NEW)
  const [name, setName] = useState(req.clientName)
  const [busy, setBusy] = useState<'approve' | 'deny'>()
  const [error, setError] = useState('')
  const [armed, setArmed] = useState(false)
  // 新建身份成功但批准失败时记住它，重试时不再重复新建
  const created = useRef<string | undefined>(undefined)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    boxRef.current?.focus()
    const t = setTimeout(() => setArmed(true), ARM_DELAY_MS)
    return () => clearTimeout(t)
  }, [])

  const left = req.expiresAt - now
  const expired = left <= 0
  // 选中的身份在弹窗打开期间被吊销了，就退回「新建身份」
  const choice = sel === NEW || sel === created.current || state.agents.some((a) => a.id === sel) ? sel : NEW
  const isNew = choice === NEW && !created.current
  const chosen = state.agents.find((a) => a.id === choice)
  const sameName = isNew ? state.agents.find((a) => a.name.trim().toLowerCase() === name.trim().toLowerCase()) : undefined

  async function approve() {
    setBusy('approve')
    setError('')
    try {
      let agentId = choice === NEW ? created.current : choice
      if (!agentId) {
        const a = await window.bridge.createAgent(name.trim())
        created.current = agentId = a.id
        setSel(a.id)
      }
      await window.bridge.approveOAuth(req.id, agentId)
      // 主进程随后推送新状态，这个请求从列表消失；先在本地藏起来，立刻切到下一个或关闭
      onDismiss(req.id)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(undefined)
    }
  }

  async function deny() {
    if (expired) return onDismiss(req.id)
    setBusy('deny')
    setError('')
    try {
      await window.bridge.denyOAuth(req.id)
      onDismiss(req.id)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    // 点遮罩、按 Esc 都什么也不做：只能点「批准」或「拒绝」
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="oauth-approval-title"
        tabIndex={-1}
        className="max-h-full w-full max-w-md overflow-auto rounded-lg border border-line bg-panel shadow-2xl outline-none"
      >
        <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
          <ShieldAlert size={16} className="text-warn" />
          <h2 id="oauth-approval-title" className="text-sm font-semibold">
            有 AI 应用请求连接
          </h2>
          {more > 0 && <span className="ml-auto text-xs text-muted">还有 {more} 个请求</span>}
        </div>

        <div className="space-y-4 px-4 py-4">
          <div className="space-y-1 text-[13px]">
            <div className="flex gap-2">
              <span className="w-10 shrink-0 text-faint">应用</span>
              <span className="selectable min-w-0 truncate font-medium">{req.clientName}</span>
            </div>
            <div className="flex gap-2">
              <span className="w-10 shrink-0 text-faint">来源</span>
              <span className="selectable min-w-0 truncate font-mono text-xs leading-5">{req.redirectHost}</span>
            </div>
          </div>

          <div className="rounded-md border border-line bg-canvas py-3 text-center">
            <div className="text-[11px] text-muted">配对码</div>
            <div className="selectable pl-[0.3em] font-mono text-4xl font-semibold tracking-[0.3em] text-fg">{req.pairCode}</div>
            <div className={cx('mt-1 text-[11px]', expired ? 'text-bad' : left < 60_000 ? 'text-warn' : 'text-faint')}>
              {expired ? '已过期' : `${formatLeft(left)} 后过期`}
            </div>
          </div>

          <p className="text-xs leading-relaxed text-warn">先核对浏览器里显示的配对码和这里一致，再批准。不一致，或者不是你刚刚发起的连接，点拒绝。</p>

          <Field
            label="绑定到身份"
            hint={
              chosen
                ? `批准后这个应用以「${chosen.name}」的身份连进来：能读写你添加的全部工作区、执行命令${chosen.machineAccess ? '，还能用整台电脑' : ''}`
                : '批准后这个应用以新身份连进来：能读写你添加的全部工作区、执行命令；「整台电脑」默认不开'
            }
          >
            <select
              value={choice}
              onChange={(e) => {
                setSel(e.target.value)
                if (e.target.value === NEW) created.current = undefined
              }}
              className="h-8 w-full rounded-md border border-line bg-canvas px-2 text-[13px] outline-none focus:border-accent"
            >
              <option value={NEW}>新建身份…</option>
              {state.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {state.roles.find((r) => r.id === a.roleId)?.name ?? '无职位'}
                  {a.machineAccess ? ' · 整台电脑' : ''}
                </option>
              ))}
            </select>
          </Field>

          {isNew && (
            <Field label="名字" hint={sameName ? `已有同名身份「${sameName.name}」，如果是同一个应用重新连接，可以在上面直接选它` : undefined}>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 ChatGPT" />
            </Field>
          )}

          {error && <div className="text-xs text-bad">{error}</div>}
        </div>

        <div className="flex justify-end gap-2 border-t border-line-soft px-4 py-3">
          <Button variant={expired ? 'default' : 'danger'} disabled={!!busy} onClick={() => void deny()}>
            <X size={14} /> {expired ? '关闭' : busy === 'deny' ? '正在拒绝…' : '拒绝'}
          </Button>
          <Button variant="primary" disabled={!armed || !!busy || expired || (isNew && !name.trim())} onClick={() => void approve()}>
            <Check size={14} /> {busy === 'approve' ? '正在批准…' : '批准'}
          </Button>
        </div>
      </div>
    </div>
  )
}
