// 在画布上新建一个 AI 的小弹窗：流程和「团队」页的新建一样（先建身份，内置 AI 再绑模型），只是摆得紧一些。
// 外部 AI 建好以后怎么接入（token、配置）还是在团队页看，这里只给一个过去的按钮。
import { useState } from 'react'
import type { Agent, AgentModel, BridgeState } from '../../../../shared/api'
import { AgentModelFields } from '../../components/AgentModel'
import { Button, cx } from '../../components/ui'
import { navigate } from '../../lib/nav'
import { errText } from './canvasApi'

export interface NewAgentDialogProps {
  state: BridgeState
  onClose(): void
  /** 身份建好了（内置 AI 是模型也绑好了）就叫；画布可以把镜头移到新卡片上 */
  onCreated(agent: Agent): void
}

type Kind = 'external' | 'builtin'

const KIND_HINT: Record<Kind, string> = {
  external: 'Claude、ChatGPT、Cursor 这类客户端，用一个 token 接进来。建好后去团队页看接入方法。',
  builtin: '工作台用你的 API Key 直接调模型，建好就能在画布上给它派活、在「对话」里和它聊。'
}

export function NewAgentDialog({ state, onClose, onCreated }: NewAgentDialogProps) {
  const [kind, setKind] = useState<Kind>('external')
  const [name, setName] = useState('')
  const [roleId, setRoleId] = useState('')
  // 整台电脑默认关，要用的自己打开
  const [machine, setMachine] = useState(false)
  const [model, setModel] = useState<AgentModel>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // 身份建好了但模型没绑上：重试时只绑模型，不再建一个同名身份
  const [created, setCreated] = useState<Agent>()
  const [done, setDone] = useState(false)

  const builtin = kind === 'builtin'
  const modelMissing = builtin && (!model?.providerId || !model.model?.trim())
  const taken = !created && state.agents.some((a) => a.name.trim() === name.trim() && name.trim() !== '')

  const create = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const agent = created ?? (await window.bridge.createAgent(name.trim(), roleId || undefined, machine))
      setCreated(agent)
      if (builtin && model) await window.bridge.setAgentModel(agent.id, model)
      setDone(true)
      onCreated(agent)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const field = 'h-7 w-full rounded-md border border-line bg-canvas px-2 text-xs text-fg outline-none placeholder:text-muted focus:border-accent disabled:opacity-50'

  return (
    <div
      data-canvas-part="new-agent"
      data-cv-nodrag
      className="flex max-h-[80vh] w-96 flex-col gap-2 overflow-y-auto rounded-xl border border-line bg-panel p-3 text-xs text-fg shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onClose()
      }}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <div className="flex items-center">
        <span className="flex-1 font-medium">新建一个 AI</span>
        <button type="button" className="cursor-pointer text-muted hover:text-fg" onClick={onClose} aria-label="关掉">
          ✕
        </button>
      </div>

      {done && created ? (
        <>
          <div className="leading-5">
            「{created.name}」建好了，画布上已经有它的卡片。
            {builtin ? '现在就可以从你的卡片拉一条线给它派活。' : '它还没连进来：去团队页复制接入配置，贴到那个 AI 的客户端里，它连上以后卡片会亮起来。'}
          </div>
          <div className="flex justify-end gap-2">
            {builtin ? (
              <Button size="sm" onClick={() => navigate({ section: 'chat', id: created.id })}>
                去和它对话
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={() => navigate({ section: 'team', id: created.id })}>
                去团队页看怎么接入
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onClose}>
              留在画布
            </Button>
          </div>
        </>
      ) : (
        <>
          {!created && (
            <div className="flex gap-2">
              {(['external', 'builtin'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={cx('flex-1 cursor-pointer rounded-md border px-2 py-1.5 text-left', kind === k ? 'border-accent bg-accent/10 text-fg' : 'border-line text-muted hover:text-fg')}
                >
                  {k === 'external' ? '外部 AI（token 接入）' : '内置 AI（用 API Key）'}
                </button>
              ))}
            </div>
          )}
          <div className="leading-5 text-muted">{KIND_HINT[kind]} 接入后是完全权限：读写文件、执行命令都不用你批准。</div>

          <label className="flex flex-col gap-1">
            <span className="text-muted">名字</span>
            <input autoFocus value={name} disabled={!!created} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder={builtin ? '如 DeepSeek 助手、代码审查员' : '如 Claude、ChatGPT'} className={field} />
          </label>
          {taken && <div className="text-warn">已经有一个叫这个名字的 AI 了，换一个好分清。</div>}

          {!created && (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-muted">职位（可以不选，只是发给它的一段职责说明）</span>
                <select value={roleId} onChange={(e) => setRoleId(e.target.value)} className={field}>
                  <option value="">无职位</option>
                  {state.roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={cx('flex cursor-pointer items-start gap-2 rounded-md border p-2', machine ? 'border-warn/50' : 'border-line')}>
                <input type="checkbox" checked={machine} onChange={(e) => setMachine(e.target.checked)} className="mt-0.5 shrink-0 cursor-pointer" />
                <span className="leading-5">
                  允许用整台电脑
                  <span className="block text-muted">打开后它能按绝对路径读写本机任意盘的文件。不开也能用你添加的所有项目。</span>
                </span>
              </label>
            </>
          )}

          {builtin && (
            <div className="flex flex-col gap-1">
              <span className="text-muted">模型</span>
              <AgentModelFields value={model} onChange={setModel} />
            </div>
          )}
          {created && <div className="rounded-md border border-warn/40 bg-warn/10 px-2 py-1.5 leading-5 text-warn">身份「{created.name}」已经建好，但模型没绑上。改好后点「绑定模型」重试。</div>}
          {error && <div className="text-bad">没成功：{error}</div>}

          <div className="flex items-center justify-end gap-2">
            {!busy && modelMissing && name.trim() && <span className="flex-1 text-muted">先选好提供方和模型</span>}
            <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button size="sm" variant="primary" disabled={busy || !name.trim() || modelMissing} onClick={() => void create()}>
              {busy ? '创建中…' : created ? '绑定模型' : '创建'}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

export default NewAgentDialog
