import { Briefcase, Check, Circle, Eye, EyeOff, HardDrive, KeyRound, Link2, Plus, Trash2, Users } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Agent, AgentModel, BridgeState, ConnectionInfo, OAuthGrantInfo, Role } from '../../../shared/api'
import { AgentModelCard, AgentModelFields } from '../components/AgentModel'
import { ConnectGuide } from '../components/ConnectGuide'
import { MemberStatusLine } from '../components/MemberStatusBadge'
import { Avatar, Badge, Button, ConfirmButton, CopyButton, cx, EmptyState, Field, IconButton, Input, PanelHeader, Segmented, TextArea } from '../components/ui'
import { errText, timeAgo, toolLabel } from '../lib/format'
import { isBusy, memberStatusOf } from '../lib/memberStatus'
import { navigate } from '../lib/nav'

export type TeamSel = { kind: 'agent' | 'role'; id: string } | { kind: 'new-agent' | 'new-role' }

export function TeamList({ state, selected, onSelect }: { state: BridgeState; selected?: TeamSel; onSelect: (s: TeamSel) => void }) {
  const online = new Map(state.presence.map((p) => [p.agentId, p]))
  const isSel = (kind: string, id: string) => selected && 'id' in selected && selected.kind === kind && selected.id === id
  return (
    <div className="flex h-full flex-col overflow-auto pb-4">
      <PanelHeader title="AI 成员">
        <IconButton title="新建接入身份" onClick={() => onSelect({ kind: 'new-agent' })}>
          <Plus size={14} />
        </IconButton>
      </PanelHeader>
      {state.agents.length === 0 && <div className="px-3 pb-2 text-xs text-muted">还没有接入身份</div>}
      {state.agents.map((a) => {
        const p = online.get(a.id)
        const role = state.roles.find((r) => r.id === a.roleId)
        // T-23：工作台给了细分状态就用它，没有就照原来显示
        const ms = memberStatusOf(state, a.id)
        return (
          <div
            key={a.id}
            onClick={() => onSelect({ kind: 'agent', id: a.id })}
            className={cx('mx-1.5 flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-hover', isSel('agent', a.id) && 'bg-accent/15')}
          >
            <Avatar name={a.name} color={a.color} size={22} active={ms ? isBusy(ms) : !!p} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px]">{a.name}</div>
              <div className="truncate text-[11px] text-muted">
                {ms ? <MemberStatusLine status={ms} dot /> : p?.currentTool ? <span className="text-accent">正在{toolLabel(p.currentTool)}…</span> : `${role?.name ?? '无职位'} · ${p ? '在线' : '离线'}`}
              </div>
            </div>
          </div>
        )
      })}
      <div className="mt-3">
        <PanelHeader title="职位">
          <IconButton title="新建职位" onClick={() => onSelect({ kind: 'new-role' })}>
            <Plus size={14} />
          </IconButton>
        </PanelHeader>
      </div>
      {state.roles.map((r) => {
        const n = state.agents.filter((a) => a.roleId === r.id).length
        return (
          <div
            key={r.id}
            onClick={() => onSelect({ kind: 'role', id: r.id })}
            className={cx('mx-1.5 flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-hover', isSel('role', r.id) && 'bg-accent/15')}
          >
            <Briefcase size={14} className="text-faint" />
            <span className="flex-1 truncate text-[13px]">{r.name}</span>
            {n > 0 && <span className="text-[11px] text-faint">{n}</span>}
          </div>
        )
      })}
    </div>
  )
}

function RoleSelect({ state, value, onChange }: { state: BridgeState; value?: string; onChange: (id: string) => void }) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} className="h-8 w-full rounded-md border border-line bg-canvas px-2 text-[13px] outline-none focus:border-accent">
      <option value="">无职位</option>
      {state.roles.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </select>
  )
}

// ========== 整台电脑 ==========

/**
 * 每个 AI 唯一的权限开关：能不能用「整台电脑」。
 * 你添加的工作区所有 AI 都能用，不用设置；整台电脑默认关，要用的自己打开
 */
function MachineSwitch({ state, on, onChange, disabled }: { state: BridgeState; on: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  const machine = (state.workspaces ?? []).find((w) => w.kind === 'machine')
  const dirs = (state.workspaces ?? []).filter((w) => w.kind !== 'machine')
  return (
    <div className="space-y-2">
      <label className={cx('flex items-start gap-2.5 rounded-md border bg-panel p-3', on ? 'border-warn/50' : 'border-line-soft', disabled ? 'opacity-60' : 'cursor-pointer')}>
        <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 shrink-0 cursor-pointer accent-[#d29922]" />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-[13px]">
            <HardDrive size={13} className={on ? 'text-warn' : 'text-faint'} /> 允许用整台电脑
            {on && <Badge color="#d29922">已开</Badge>}
          </span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted">
            打开后它能按绝对路径（如 D:/xxx）读写本机任意盘的文件{machine ? `，相对路径从 ${machine.root} 算起` : ''}。不开也能用下面这些你添加的工作区。
          </span>
        </span>
      </label>
      <div className="text-[11px] leading-relaxed text-faint">
        {dirs.length
          ? `你添加的工作区它都能用：${dirs.map((w) => w.name).join('、')}。默认是它连接那一刻的当前工作区，用 workspace 参数可以切到别的。`
          : '还没有添加工作区，先到设置里添加。'}
      </div>
    </div>
  )
}

// ========== 新建 AI ==========

type AgentKind = 'external' | 'builtin'

const KIND_OPTIONS: { value: AgentKind; label: string; title: string }[] = [
  { value: 'external', label: '外部 AI（token 接入）', title: 'Claude、ChatGPT、Cursor 等客户端用 token 通过 MCP 接入' },
  { value: 'builtin', label: '内置 AI（用 API Key 的模型）', title: '本应用直接调模型，在「对话」里聊天、派活' }
]

const KIND_HINTS: Record<AgentKind, string> = {
  external: '每个 AI 一个身份：独立 token，活动记录里用颜色区分，可以单独吊销。接入后是完全权限：全部工具都能用，读写文件、执行命令都不用你批准。',
  builtin: '本应用用你的 API Key 直接调模型，它用和外部 AI 一样的工具干活，同样是完全权限。建好后在「对话」里和它聊。'
}

export function NewAgent({ state, onCreated }: { state: BridgeState; onCreated: (id: string) => void }) {
  const [kind, setKind] = useState<AgentKind>('external')
  const [name, setName] = useState('')
  const [roleId, setRoleId] = useState('')
  // 整台电脑默认关，要用的自己打开
  const [machine, setMachine] = useState(false)
  const [model, setModel] = useState<AgentModel>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // 身份建好了但模型没绑上：重试时只绑模型，不再建一个同名身份
  const [createdId, setCreatedId] = useState<string>()
  const builtin = kind === 'builtin'
  const modelMissing = builtin && (!model?.providerId || !model.model?.trim())

  async function create() {
    setBusy(true)
    setError('')
    try {
      const id = createdId ?? (await window.bridge.createAgent(name.trim(), roleId || undefined, machine)).id
      setCreatedId(id)
      if (builtin && model) {
        await window.bridge.setAgentModel(id, model)
        // 团队页先记住它，再切到对话
        onCreated(id)
        navigate({ section: 'chat', id })
      } else {
        onCreated(id)
      }
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <div>
        <h2 className="text-base font-semibold">新建 AI</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">{KIND_HINTS[kind]}</p>
      </div>
      {!createdId && (
        <Field label="类型">
          <Segmented value={kind} onChange={setKind} options={KIND_OPTIONS} />
        </Field>
      )}
      <Field label="名字">
        <Input
          autoFocus
          value={name}
          disabled={!!createdId}
          onChange={(e) => setName(e.target.value)}
          placeholder={builtin ? '如 DeepSeek 助手、代码审查员' : '如 Claude、ChatGPT、局域网笔记本'}
        />
      </Field>
      {!createdId && (
        <>
          <Field label="职位" hint="可以不选。职位只是发给 AI 的一段职责说明，不限制它能做什么">
            <RoleSelect state={state} value={roleId} onChange={setRoleId} />
          </Field>
          <Field label="整台电脑">
            <MachineSwitch state={state} on={machine} onChange={setMachine} />
          </Field>
        </>
      )}
      {builtin && (
        <Field label="模型">
          <AgentModelFields value={model} onChange={setModel} />
        </Field>
      )}
      {createdId && (
        <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">
          身份「{name.trim()}」已经建好，但模型没绑上。改好后点「绑定模型」重试，或先去详情页再绑。
        </div>
      )}
      {error && <div className="text-xs text-bad">{error}</div>}
      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={busy || !name.trim() || modelMissing} onClick={() => void create()}>
          <Plus size={14} /> {busy ? '创建中…' : createdId ? '绑定模型' : '创建'}
        </Button>
        {createdId && (
          <Button variant="ghost" onClick={() => onCreated(createdId)}>
            去详情页
          </Button>
        )}
        {!busy && modelMissing && name.trim() && <span className="text-xs text-faint">先选好提供方和模型</span>}
      </div>
    </div>
  )
}

function mask(token: string): string {
  return token.slice(0, 6) + '•'.repeat(14) + token.slice(-4)
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex h-8 items-center gap-2 rounded-md border border-line-soft bg-canvas pr-1 pl-2.5 font-mono text-xs text-[#c9d1d9]">
      <span className="w-12 shrink-0 font-sans text-faint">{label}</span>
      {children}
    </div>
  )
}


/** 授权码换 token（真正生成授权）时主进程不推送状态，详情页开着时定时刷新，顺便更新「最近使用」 */
const GRANTS_POLL_MS = 10_000

function fullTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** 这个 AI 当前的 MCP 连接：每个客户端会话一条，可以单条断开或全部断开（token 不变，客户端能重连） */
function AgentSessions({ agentId, sessions }: { agentId: string; sessions: number }) {
  const [list, setList] = useState<{ id: string; clientName?: string; createdAt: number; lastSeen: number }[]>([])
  const [error, setError] = useState('')
  const reload = useCallback(() => {
    window.bridge
      .listAgentSessions(agentId)
      .then(setList)
      .catch((e) => setError(errText(e)))
  }, [agentId])
  // 在线会话数变了（BridgeState 推送）就重新拉
  useEffect(reload, [reload, sessions])
  if (list.length === 0) return null
  const drop = async (sessionId?: string) => {
    setError('')
    try {
      await window.bridge.disconnectAgent(agentId, sessionId)
      reload()
    } catch (e) {
      setError(errText(e))
    }
  }
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-muted">
        当前连接 <span className="text-faint">{list.length}</span>
        {list.length > 1 && (
          <button className="ml-auto cursor-pointer text-faint hover:text-bad" onClick={() => void drop()}>
            全部断开
          </button>
        )}
      </div>
      <div className="divide-y divide-line-soft rounded-md border border-line-soft bg-canvas">
        {list.map((s) => (
          <div key={s.id} className="flex items-center gap-2.5 py-1.5 pr-1.5 pl-2.5 text-xs">
            <Circle size={8} className="shrink-0 fill-ok text-ok" />
            <span className="min-w-0 flex-1 truncate text-fg">{s.clientName ?? '未知客户端'}</span>
            <span className="text-faint">连上 {timeAgo(s.createdAt)} · 最近 {timeAgo(s.lastSeen)}</span>
            <Button size="sm" variant="ghost" onClick={() => void drop(s.id)}>
              断开
            </Button>
          </div>
        ))}
      </div>
      <div className="text-[11px] text-faint">断开只结束这次会话，token 不变，客户端下次调用会重新握手。要彻底拦住它，用下面的「更换 token」或「吊销」。</div>
      {error && <div className="text-xs text-bad">{error}</div>}
    </section>
  )
}

export function AgentDetail({ state, agent, onRemoved }: { state: BridgeState; agent: Agent; onRemoved: () => void }) {
  const [name, setName] = useState(agent.name)
  const [reveal, setReveal] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState<ConnectionInfo>()
  const [grants, setGrants] = useState<OAuthGrantInfo[]>()
  const [grantsError, setGrantsError] = useState('')
  useEffect(() => {
    setName(agent.name)
    setReveal(false)
    setError('')
    setGrantsError('')
  }, [agent.id, agent.name])
  const p = state.presence.find((x) => x.agentId === agent.id)

  // 地址、认证方式或 token 变了就重新取连接信息
  const urlsKey = [state.authMode, state.urls.local, ...(state.urls.lan ?? []), state.urls.public ?? ''].join('\n')
  useEffect(() => {
    let alive = true
    window.bridge.connectionInfo(agent.id).then(
      (i) => alive && setInfo(i),
      () => alive && setInfo(undefined)
    )
    return () => {
      alive = false
    }
  }, [agent.id, agent.token, urlsKey])
  // 切换 AI 或更换 token 后，旧结果不再显示
  const conn = info && info.token === agent.token ? info : undefined

  // 只用最后一次请求的结果，避免慢的旧请求覆盖新结果
  const grantsSeq = useRef(0)
  const reloadGrants = useCallback(async () => {
    const n = ++grantsSeq.current
    try {
      const list = await window.bridge.listOAuthGrants()
      if (n !== grantsSeq.current) return
      setGrants(list)
      setGrantsError('')
    } catch (e) {
      if (n === grantsSeq.current) setGrantsError(errText(e))
    }
  }, [])
  const pendingKey = (state.oauthPending ?? []).map((x) => x.id).join(',')
  const agentsKey = state.agents.map((a) => `${a.id}:${a.token}`).join(',')
  useEffect(() => {
    void reloadGrants()
  }, [reloadGrants, agent.id, pendingKey, agentsKey])
  useEffect(() => {
    const t = setInterval(() => void reloadGrants(), GRANTS_POLL_MS)
    return () => clearInterval(t)
  }, [reloadGrants])
  const myGrants = grants?.filter((g) => g.agentId === agent.id).sort((a, b) => b.createdAt - a.createdAt)
  const revokeGrant = (id: string) => async () => {
    setGrantsError('')
    try {
      await window.bridge.revokeOAuthGrant(id)
    } catch (e) {
      setGrantsError(errText(e))
    }
    await reloadGrants()
  }
  const run = (fn: () => Promise<unknown>) => async () => {
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(errText(e))
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Avatar name={agent.name} color={agent.color} size={40} active={!!p} />
        <div className="min-w-0 flex-1">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== agent.name && void run(() => window.bridge.updateAgent(agent.id, { name }))()}
            className="h-8 border-transparent bg-transparent px-0 text-base font-semibold hover:border-line focus:px-2.5"
          />
          <div className="text-xs text-muted">
            {p ? `在线 · ${p.clientName ?? '未知客户端'} · ${p.sessions} 个会话 · ${timeAgo(p.lastSeen)}活动` : `离线 · 创建于 ${timeAgo(agent.createdAt)}`}
          </div>
        </div>
      </div>

      <section className="space-y-2">
        <div className="text-xs font-medium text-muted">接入</div>
        {/* 地址三选一、各客户端的配置片段、测试连接；地址行（含局域网、公网）在向导里 */}
        {conn ? (
          <ConnectGuide agentId={agent.id} info={conn} reveal={reveal} />
        ) : (
          <Row label="本机">
            <span className="selectable flex-1 truncate">{state.mcpUrl}</span>
            <CopyButton text={state.mcpUrl} label="" />
          </Row>
        )}
        <Row label="Token">
          <span className="selectable flex-1 truncate">{reveal ? agent.token : mask(agent.token)}</span>
          <IconButton title={reveal ? '隐藏' : '显示'} onClick={() => setReveal(!reveal)}>
            {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
          </IconButton>
          <CopyButton text={agent.token} label="" />
        </Row>
        <div className="flex items-center gap-2 pt-1">
          <CopyButton size="md" label="复制接入说明" text={async () => (await window.bridge.connectionInfo(agent.id)).prompt} />
          <span className="text-xs text-faint">含地址、token 和不支持请求头时的写法，直接贴给 AI 客户端</span>
        </div>
      </section>

      <AgentSessions agentId={agent.id} sessions={p?.sessions ?? 0} />

      <section className="space-y-2">
        <div className="text-xs font-medium text-muted">网页连接（OAuth）</div>
        {myGrants && myGrants.length > 0 && (
          <div className="divide-y divide-line-soft rounded-md border border-line-soft bg-canvas">
            {myGrants.map((g) => (
              <div key={g.id} className="flex items-center gap-2.5 py-1.5 pr-1.5 pl-2.5">
                <Link2 size={14} className="shrink-0 text-faint" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]">{g.clientName}</div>
                  <div className="truncate text-[11px] text-faint">
                    授权于 {fullTime(g.createdAt)} · 最近使用 {timeAgo(g.lastUsedAt)}
                  </div>
                </div>
                <ConfirmButton confirmText="确认撤销？" onConfirm={revokeGrant(g.id)}>
                  撤销
                </ConfirmButton>
              </div>
            ))}
          </div>
        )}
        {myGrants && myGrants.length === 0 && (
          <div className="rounded-md border border-dashed border-line-soft px-3 py-2.5 text-xs leading-relaxed text-muted">
            {state.authMode === 'link' ? (
              <>
                当前是「链接直连」，网页 AI 不走 OAuth：在 Sesame / ChatGPT / Claude.ai 添加时直接填
                {conn?.publicUrlWithToken ? '上面的「公网链接」' : '带 token 的公网链接（先在设置里开启公网隧道）'}即可。需要 OAuth 时到设置 → 公网隧道里切换。
              </>
            ) : (
              <>
                还没有网页 AI 通过 OAuth 连接到这个身份。在 ChatGPT / Claude.ai 添加连接器时，地址填
                {conn?.publicUrl ? '上面的公网地址' : '公网地址（先在设置里开启公网隧道）'}，认证选 OAuth；桌面上弹出确认框时，绑定身份选「{agent.name}」。
              </>
            )}
          </div>
        )}
        {grantsError && <div className="text-xs text-bad">{grantsError}</div>}
      </section>

      <section className="space-y-4">
        <div className="rounded-md border border-line-soft bg-panel px-3 py-2.5 text-xs leading-relaxed text-muted">
          <span className="text-fg">完全权限</span>：全部工具都能用，读写文件、执行命令、结束进程都是直接做，不用你批准。要拦住它，用顶栏的「全部停下」，或者下面的「更换 token」「吊销」。
        </div>
        <Field label="整台电脑" hint="开关后这个 AI 会断开重连一次">
          <MachineSwitch state={state} on={agent.machineAccess === true} onChange={(on) => void run(() => window.bridge.updateAgent(agent.id, { machineAccess: on }))()} />
        </Field>
        <Field label="职位" hint="职位只是发给 AI 的一段职责说明，不限制它能做什么；换职位不会断开连接">
          <RoleSelect state={state} value={agent.roleId} onChange={(id) => void run(() => window.bridge.updateAgent(agent.id, { roleId: id }))()} />
        </Field>
      </section>

      <AgentModelCard state={state} agent={agent} />

      {error && <div className="text-xs text-bad">{error}</div>}

      <section className="flex gap-2 border-t border-line-soft pt-4">
        <ConfirmButton size="md" confirmText="确认更换？旧 token 立刻失效" onConfirm={run(() => window.bridge.rotateToken(agent.id))}>
          <KeyRound size={13} /> 更换 token
        </ConfirmButton>
        <ConfirmButton
          size="md"
          confirmText="确认吊销？"
          onConfirm={run(async () => {
            await window.bridge.removeAgent(agent.id)
            onRemoved()
          })}
        >
          <Trash2 size={13} /> 吊销
        </ConfirmButton>
        <span className="self-center text-xs leading-relaxed text-faint">
          吊销后它负责的未完成任务退回待认领，私有记忆一并删除。吊销或更换 token 时，这个 AI 的 OAuth 授权会一并失效
        </span>
      </section>
    </div>
  )
}

export function RoleEditor({ state, role, onSaved, onRemoved }: { state: BridgeState; role?: Role; onSaved: (id: string) => void; onRemoved: () => void }) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    setName(role?.name ?? '')
    setDesc(role?.description ?? '')
    setError('')
  }, [role?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const holders = role ? state.agents.filter((a) => a.roleId === role.id) : []

  async function save() {
    setError('')
    try {
      const r = await window.bridge.saveRole({ id: role?.id, name, description: desc })
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
      onSaved(r.id)
    } catch (e) {
      setError(errText(e))
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <div className="flex items-center gap-2">
        <Briefcase size={16} className="text-faint" />
        <h2 className="text-base font-semibold">{role ? role.name : '新建职位'}</h2>
        {role?.builtin && <Badge>预设</Badge>}
        {holders.length > 0 && (
          <div className="flex -space-x-1">
            {holders.map((a) => (
              <Avatar key={a.id} name={a.name} color={a.color} size={18} />
            ))}
          </div>
        )}
        {role && (
          <div className="ml-auto">
            <ConfirmButton confirmText="确认删除？" onConfirm={async () => (await window.bridge.removeRole(role.id), onRemoved())}>
              <Trash2 size={12} /> 删除
            </ConfirmButton>
          </div>
        )}
      </div>
      <Field label="名称">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 前端开发" />
      </Field>
      <Field label="职责说明" hint="AI 连接时随说明一起收到，写清楚它该做什么、不该做什么。这只是给 AI 的说明，不是限制：职位不影响它能用的工具和权限">
        <TextArea rows={8} value={desc} onChange={(e) => setDesc(e.target.value)} />
      </Field>
      {error && <div className="text-xs text-bad">{error}</div>}
      <Button variant="primary" disabled={!name.trim()} onClick={save}>
        {saved ? <Check size={14} /> : null}
        {saved ? '已保存' : role ? '保存' : '创建'}
      </Button>
      {role && holders.length > 0 && <div className="text-xs text-faint">保存后担任这个职位的 AI 会收到一条通知，让它重新看职责说明；连接不断</div>}
    </div>
  )
}

export function TeamEmpty() {
  return <EmptyState icon={<Users size={28} />} title="选择一个 AI 或职位" hint="左侧列出所有接入身份和职位" />
}

