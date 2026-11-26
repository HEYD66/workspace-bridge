import { Cloud, Folder, FolderOpen, FolderPlus, Loader2, Pencil, Play, Plug, ShieldCheck, Square, TriangleAlert, UsersRound } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { BridgeState, TunnelSettingsPatch, TunnelState, WorkspaceView } from '../../../shared/api'
import { ProvidersCard } from '../components/ModelProviders'
import { BackupCard, DiagnosticsCard } from '../components/BackupCard'
import { RemoteViewCard } from '../components/RemoteViewCard'
import { TrashCard } from '../components/TrashCard'
import { Badge, Button, Card, ConfirmButton, CopyButton, cx, Field, IconButton, Input, Segmented, Switch } from '../components/ui'
import { errText } from '../lib/format'
import { addWorkspaceFlow, editWorkspaceMembers } from '../lib/workspaceDialog'

/** 没有工作区或还没有 AI 时，编辑区显示的引导 */
export function Welcome({ state, onNewAgent }: { state: BridgeState; onNewAgent: () => void }) {
  const [addError, setAddError] = useState('')
  // 内置的整台电脑不算「添加的工作区」
  const workspaces = (state.workspaces ?? []).filter((w) => w.kind !== 'machine')
  const hasWs = workspaces.length > 0
  const add = async () => {
    setAddError('')
    try {
      await addWorkspaceFlow()
    } catch (e) {
      setAddError(errText(e))
    }
  }
  const steps: { done: boolean; title: string; hint: string; action: ReactNode }[] = [
    {
      done: hasWs,
      title: '添加工作区',
      hint: hasWs
        ? `已添加 ${workspaces.map((w) => w.name).join('、')}。还可以再加，顶栏切换当前工作区。`
        : 'AI 只能看到你添加的文件夹，可以加多个。建议先用测试目录，不要选整个磁盘或用户主目录。',
      action: (
        <Button variant={hasWs ? 'default' : 'primary'} onClick={() => void add()}>
          <FolderPlus size={14} /> {hasWs ? '再加一个' : '添加文件夹'}
        </Button>
      )
    },
    {
      done: state.agents.length > 0,
      title: '创建 AI',
      hint: '外部 AI 用 token 接入（Claude、ChatGPT、Cursor 等）；也可以填模型的 API Key 建内置 AI，直接在这里对话。每个 AI 可以分配职位和能访问的工作区。',
      action: (
        <Button variant={state.agents.length ? 'default' : 'primary'} onClick={onNewAgent} disabled={!hasWs}>
          <Plug size={14} /> 新建
        </Button>
      )
    },
    {
      done: state.presence.length > 0,
      title: '把接入说明贴给外部 AI',
      hint: '在成员详情里点「复制接入说明」，粘贴到支持 MCP（Streamable HTTP）的客户端。ChatGPT、Claude.ai 等网页 AI 要先在设置里开公网隧道。内置 AI 不用这一步。',
      action: <CopyButton size="md" text={state.urls.local} label="复制地址" />
    }
  ]
  return (
    <div className="mx-auto max-w-xl space-y-6 p-10">
      <div>
        <h1 className="text-xl font-semibold">Workspace Bridge</h1>
        <p className="mt-1 text-[13px] text-muted">把本机工作区通过 MCP 开放给 AI，多个 AI 分职位协作，每一步都在这里实时显示。</p>
      </div>
      <div className="space-y-2">
        {steps.map((s, i) => (
          <Card key={i} className="flex items-center gap-4 p-4">
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${s.done ? 'bg-ok/20 text-ok' : 'bg-hover text-muted'}`}
            >
              {s.done ? '✓' : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{s.title}</div>
              <div className="mt-0.5 text-xs leading-relaxed text-muted">{s.hint}</div>
            </div>
            {s.action}
          </Card>
        ))}
      </div>
    </div>
  )
}

const CODE_CLASS = 'selectable h-8 min-w-0 flex-1 truncate rounded-md border border-line-soft bg-canvas px-2.5 font-mono text-xs leading-8'

const WINGET_CMD = 'winget install --id Cloudflare.cloudflared'

const TUNNEL_STATUS: Record<TunnelState['status'], { label: string; color?: string }> = {
  off: { label: '未开启' },
  starting: { label: '启动中', color: '#d29922' },
  running: { label: '运行中', color: '#3fb950' },
  error: { label: '出错', color: '#f85149' }
}

const MODE_LABELS: Record<TunnelState['mode'], string> = { quick: '临时地址', named: '自己的域名' }

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-4 border-b border-line-soft py-4 last:border-0">
      <div className="pt-1.5 text-[13px] text-muted">{label}</div>
      <div>
        {children}
        {hint && <div className="mt-1.5 text-xs leading-relaxed text-faint">{hint}</div>}
      </div>
    </div>
  )
}

/** 一行地址 + 复制按钮 */
function UrlLine({ url }: { url: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className={CODE_CLASS}>{url}</code>
      <CopyButton size="md" text={url} />
    </div>
  )
}

/** 标题 + 说明在左，胶囊开关在右 */
function Check({ checked, disabled, onChange, title, children }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; title: string; children?: ReactNode }) {
  return (
    <label className={cx('flex items-start gap-3', disabled ? 'cursor-default' : 'cursor-pointer')}>
      <span className={cx('min-w-0 flex-1', disabled && 'opacity-60')}>
        <span className="block text-[13px] text-fg">{title}</span>
        {children && <span className="block text-xs leading-relaxed text-muted">{children}</span>}
      </span>
      <Switch aria-label={title} checked={checked} disabled={disabled} onChange={onChange} />
    </label>
  )
}

function Busy({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted">
      <Loader2 size={12} className="animate-spin" /> {children}
    </div>
  )
}

/** 异步操作：同一时间只跑一个，记下是哪个在忙、哪个出错 */
function useAction() {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<{ key: string; text: string }>()
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setError(undefined)
    try {
      await fn()
    } catch (e) {
      setError({ key, text: errText(e) })
    } finally {
      setBusy('')
    }
  }
  const errorOf = (key: string) => (error?.key === key ? error.text : '')
  return { busy, run, error: error?.text ?? '', errorOf }
}

/** 用户可能粘贴带 https:// 或路径的地址，只留域名 */
function cleanHostname(s: string): string {
  return s
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase()
}

/** 允许直接粘贴整条安装命令：token 是命令的最后一段 */
function cleanToken(s: string): string {
  return s.trim().split(/\s+/).pop() ?? ''
}

export function SettingsView({ state }: { state: BridgeState }) {
  const [port, setPort] = useState(String(state.port))
  const { busy, run, errorOf } = useAction()
  useEffect(() => setPort(String(state.port)), [state.port])

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <h2 className="text-base font-semibold">设置</h2>
      <WorkspacesCard state={state} />
      <Card className="px-5">
        <Row label="本机地址" hint="本机上的 AI 客户端用这个地址；网页 AI 用下面的公网隧道。">
          <UrlLine url={state.urls.local} />
        </Row>
        <Row
          label="端口"
          hint={`当前监听${state.lanEnabled ? '所有网卡' : ' 127.0.0.1，仅本机可连'}。改端口会重启 MCP 服务，所有 AI 需要重连；用自己域名的隧道，还要同步修改 Cloudflare 里的服务地址。`}
        >
          <div className="flex items-center gap-2">
            <Input type="number" value={port} onChange={(e) => setPort(e.target.value)} className="w-28" />
            <Button disabled={!!busy || port === String(state.port)} onClick={() => run('port', () => window.bridge.setPort(Number(port)))}>
              {busy === 'port' ? '重启中…' : '应用'}
            </Button>
            {errorOf('port') && <span className="text-xs text-bad">{errorOf('port')}</span>}
          </div>
        </Row>
        <Row label="局域网">
          <div className="space-y-2 pt-1.5">
            <Check checked={state.lanEnabled} disabled={!!busy} onChange={(v) => run('lan', () => window.bridge.setLanEnabled(v))} title="允许同一网络的设备连接">
              开启后监听所有网卡，同一网络里的电脑、手机都能连。切换会重启 MCP 服务，所有 AI 需要重连。Windows 防火墙可能弹窗，选「专用网络」。只在家里、公司这类可信网络里开。
            </Check>
            {busy === 'lan' && <Busy>正在重启 MCP 服务…</Busy>}
            {errorOf('lan') && <div className="text-xs text-bad">{errorOf('lan')}</div>}
            {state.lanEnabled && (
              <div className="space-y-2 pt-1">
                {state.urls.lan.length ? (
                  <>
                    <div className="text-xs text-muted">同一网络的设备用下面的地址接入，同样需要 token：</div>
                    {state.urls.lan.map((u) => (
                      <UrlLine key={u} url={u} />
                    ))}
                  </>
                ) : (
                  <div className="text-xs text-warn">没找到局域网 IPv4 地址，确认这台电脑已经连上网络。</div>
                )}
              </div>
            )}
          </div>
        </Row>
        <Row label="系统通知">
          <div className="pt-1.5">
            <Check checked={state.notifyAttention} disabled={!!busy} onChange={(v) => run('notify', () => window.bridge.setNotifyAttention(v))} title="有事等你时弹系统通知">
              AI 提了问题、交活等你验收、做完交付了，或者手上有活却很久没动静时，弹一条系统通知，点一下打开画布。你正看着工作台时不弹，同一件事只弹一次。
            </Check>
          </div>
        </Row>
      </Card>
      <TunnelCard state={state} />
      <RemoteViewCard />
      <ProvidersCard state={state} />
      <TrashCard state={state} />
      <BackupCard />
      <DiagnosticsCard />
      <Card className="p-5">
        <div className="mb-3 flex items-center gap-2 text-[13px] font-medium">
          <ShieldCheck size={15} className="text-ok" /> 现在的规则
        </div>
        <div className="mb-1.5 text-xs font-medium text-fg">接入的 AI 能做什么</div>
        <ul className="mb-3 space-y-1.5 text-xs leading-relaxed text-muted">
          <li>· 每个接入的 AI 都是完全权限：全部工具都能用，读写文件、执行命令、结束进程都是直接做，不用你批准</li>
          <li>· 工作区只有两种：你在上面添加的工作区（加的时候选哪些 AI 能用，之后在工作区那一行的「成员」里改），和「整台电脑」（本机任意盘；每个 AI 在团队页单独开，默认关）</li>
          <li>· 工作区没给某个 AI 用时，它看不到这个工作区、进不了它的群聊；开了整台电脑也不能用绝对路径读写那个目录，命令不能在里面执行、不能在命令里写它的路径（命令只是按文字拦，不是沙箱）</li>
          <li>· 文件工具和命令行一致：.env、密钥文件、.git 内部都能读写</li>
          <li>· 能执行命令就等于能做这台电脑上你这个账户能做的事，包括工作区以外。只把连接地址给你信得过的 AI，开了公网隧道更要注意</li>
        </ul>
        <div className="mb-1.5 text-xs font-medium text-fg">仍然保留的</div>
        <ul className="space-y-1.5 text-xs leading-relaxed text-muted">
          <li>· 顶栏的「全部停下」：所有 AI 的调用立刻暂停，正在跑的命令取消</li>
          <li>· 团队页可以吊销某个 AI 或更换它的 token，换完旧地址立刻失效</li>
          <li>· 本应用的数据目录（里面有各个 AI 的 token）文件工具和命令都不能碰；不能结束工作台自己的进程</li>
          <li>· 写入必须带版本号，别人改过会返回冲突，不会静默覆盖</li>
          <li>· 删除进回收站（上面的「回收站」里能恢复），不会真正删除；AI 改过的文件有检查点可以回滚。AI 也能恢复和清空回收站，清空后恢复不了</li>
          <li>· 整台电脑：不能整盘删除、移动、搜索</li>
          <li>· 只接受本机、已开启的局域网地址和隧道域名作为 Host，防 DNS rebinding</li>
          <li>· MCP 接口拒绝浏览器跨站请求，防 CSRF</li>
          <li>· AI 用的隧道和局域网只能访问 MCP 和 OAuth 接口，碰不到管理界面</li>
          <li>
            · 管理界面平时只走应用内部通信，不经过网络。只有打开上面的「远端查看」时，才会另开一个带口令的入口给你自己的手机 / 平板用；拿到那个链接的人能做你在这个窗口里能做的所有事（包括终端），关掉后立刻失效
          </li>
          <li>· 认证方式选了 OAuth 时，网页 AI 第一次连接要你在桌面核对配对码（只是确认让不让它连进来，连上之后同样是完全权限）</li>
          <li>· 吊销或更换 token 时，这个 AI 的 OAuth 授权一并失效</li>
          <li>· 每次调用写入审计日志（数据目录 audit/）</li>
        </ul>
      </Card>
    </div>
  )
}

/** 工作区列表：添加、改名、移出、设为当前、在资源管理器打开 */
function WorkspacesCard({ state }: { state: BridgeState }) {
  // 整台电脑是内置的，不用添加，也不在这里列；每个 AI 能不能用它在团队页勾
  const list = (state.workspaces ?? []).filter((w) => w.kind !== 'machine')
  const { busy, run, errorOf } = useAction()
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <Folder size={15} className="text-accent" />
        <span className="text-[13px] font-medium">工作区</span>
        <Badge>{list.length} 个</Badge>
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" disabled={!!busy} onClick={() => void run('add', () => addWorkspaceFlow())}>
            <FolderPlus size={13} /> 添加文件夹
          </Button>
        </div>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">
每个工作区可以只给选中的 AI 用（加的时候选，之后点「成员」改）；以前加的工作区是所有 AI 都能用。要让某个 AI 用整台电脑（本机任意盘），到团队页给它单独打开。任务、记忆、技能按工作区分开保存，界面显示「当前」那个的。增删工作区、改成员时，受影响的 AI 会断开重连。
      </p>
      {errorOf('add') && <div className="mt-2 text-xs text-bad">{errorOf('add')}</div>}
      {list.length === 0 ? (
        <div className="mt-3 rounded-md border border-dashed border-line-soft px-3 py-4 text-center text-xs text-muted">还没有工作区，点「添加文件夹」选一个目录</div>
      ) : (
        <div className="mt-3 divide-y divide-line-soft rounded-md border border-line-soft bg-canvas">
          {list.map((w) => (
            <WorkspaceRow key={w.id} state={state} ws={w} />
          ))}
        </div>
      )}
    </Card>
  )
}

function WorkspaceRow({ state, ws }: { state: BridgeState; ws: WorkspaceView }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(ws.name)
  const { busy, run, error } = useAction()
  useEffect(() => setName(ws.name), [ws.name])
  const active = ws.id === state.activeWorkspaceId

  // Enter 保存后输入框失焦还会再触发一次，用 ref 挡住重复提交
  const saving = useRef(false)
  const saveName = () => {
    if (saving.current) return
    const n = name.trim()
    if (!n || n === ws.name) {
      setName(ws.name)
      setEditing(false)
      return
    }
    saving.current = true
    void run('rename', async () => {
      try {
        await window.bridge.renameWorkspace(ws.id, n)
        setEditing(false)
      } finally {
        saving.current = false
      }
    })
  }

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-2">
        {!ws.exists ? (
          <TriangleAlert size={14} className="shrink-0 text-warn" />
        ) : (
          <Folder size={14} className={cx('shrink-0', active ? 'text-accent' : 'text-faint')} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            {editing ? (
              <Input
                autoFocus
                value={name}
                disabled={busy === 'rename'}
                onChange={(e) => setName(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveName()
                  if (e.key === 'Escape') {
                    setName(ws.name)
                    setEditing(false)
                  }
                }}
                className="h-6 w-48 px-1.5 text-[13px]"
              />
            ) : (
              <>
                <span className="truncate text-[13px] font-medium">{ws.name}</span>
                <IconButton title="改名（AI 用名字或 id 指定工作区）" onClick={() => setEditing(true)} className="h-5 w-5">
                  <Pencil size={11} />
                </IconButton>
              </>
            )}
            {active && <Badge color="#58a6ff">当前</Badge>}
            {!ws.exists && <Badge color="#d29922">目录不存在</Badge>}
            <Badge>{ws.members ? `${state.agents.filter((a) => ws.members!.includes(a.id)).length} 个 AI` : '所有 AI'}</Badge>
          </div>
          <div className="selectable mt-0.5 truncate font-mono text-[11px] text-faint" title={ws.root}>
            {ws.root}
          </div>
        </div>
        {!active && (
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run('active', () => window.bridge.setActiveWorkspace(ws.id))}>
            设为当前
          </Button>
        )}
        <IconButton title="成员：哪些 AI 能用这个工作区" onClick={() => editWorkspaceMembers(ws.id)}>
          <UsersRound size={13} />
        </IconButton>
        <IconButton title="在资源管理器中打开" disabled={!ws.exists} onClick={() => void run('open', () => window.bridge.openWorkspace(ws.id))}>
          <FolderOpen size={13} />
        </IconButton>
        <ConfirmButton confirmText="确认移出？" onConfirm={() => void run('remove', () => window.bridge.removeWorkspace(ws.id))}>
          移出
        </ConfirmButton>
      </div>
      {error && <div className="mt-1.5 pl-6 text-xs text-bad">{error}</div>}
    </div>
  )
}

/** 公网隧道（cloudflared） */
function TunnelCard({ state }: { state: BridgeState }) {
  const { tunnel, tunnelSettings: ts } = state
  const { busy, run, error } = useAction()
  const [hostname, setHostname] = useState(ts.hostname ?? '')
  const [token, setToken] = useState('')
  useEffect(() => setHostname(ts.hostname ?? ''), [ts.hostname])

  const status = TUNNEL_STATUS[tunnel.status]
  const active = tunnel.status === 'running' || tunnel.status === 'starting'
  const noBinary = !tunnel.cloudflaredPath
  const missingNamed = ts.mode === 'named' && (!ts.hostname || !ts.hasToken)
  const dirty = cleanHostname(hostname) !== (ts.hostname ?? '') || cleanToken(token) !== ''
  const serviceUrl = `http://127.0.0.1:${state.port}`
  const keepHint =
    ts.keepOnExit && active && !tunnel.kept
      ? '当前隧道是在打开这个开关之前启动的：停止后再启动一次，关闭应用时才会保留。'
      : '关闭应用后 cloudflared 留在后台，地址不变，下次打开应用自动接上。应用没开时 AI 连不上；要彻底关掉，先点「停止」再退出。'

  const save = () =>
    run('save', async () => {
      const h = cleanHostname(hostname)
      const t = cleanToken(token)
      const patch: TunnelSettingsPatch = { hostname: h }
      // token 留空表示不改，不能传空字符串（那是清除）
      if (t) patch.token = t
      await window.bridge.setTunnelSettings(patch)
      setHostname(h)
      setToken('')
    })

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <Cloud size={15} className="text-accent" />
        <span className="text-[13px] font-medium">公网隧道</span>
        <Badge color={status.color}>
          {tunnel.status === 'starting' && <Loader2 size={10} className="animate-spin" />}
          {status.label}
        </Badge>
        <div className="flex-1" />
        {active ? (
          <Button disabled={!!busy} onClick={() => run('stop', () => window.bridge.stopTunnel())}>
            <Square size={13} /> {busy === 'stop' ? '停止中…' : '停止'}
          </Button>
        ) : (
          <Button variant="primary" disabled={!!busy || noBinary || missingNamed} onClick={() => run('start', () => window.bridge.startTunnel())}>
            {busy === 'start' ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} {busy === 'start' ? '启动中…' : '启动'}
          </Button>
        )}
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">用 Cloudflare 的 cloudflared 把 MCP 服务开到公网，ChatGPT、Claude.ai 这类网页 AI 才能连上。</p>

      {tunnel.status === 'error' && tunnel.error && <div className="selectable mt-3 rounded-md border border-bad/40 bg-bad/10 p-3 text-xs leading-relaxed text-bad">{tunnel.error}</div>}
      {error && <div className="mt-3 text-xs text-bad">{error}</div>}

      {noBinary && (
        <div className="mt-4 space-y-2 rounded-md border border-warn/40 bg-warn/10 p-3">
          <div className="text-xs leading-relaxed text-fg">没找到 cloudflared。在 PowerShell 里运行下面的命令安装，装完重启本应用：</div>
          <div className="flex items-center gap-2">
            <code className={CODE_CLASS}>{WINGET_CMD}</code>
            <CopyButton size="md" text={WINGET_CMD} />
          </div>
        </div>
      )}

      {tunnel.status === 'running' && state.urls.public && (
        <div className="mt-4 space-y-2 rounded-md border border-ok/30 bg-ok/5 p-3">
          <div className="text-xs font-medium text-fg">公网 MCP 地址</div>
          <UrlLine url={state.urls.public} />
          {state.authMode === 'link' ? (
            <p className="text-xs leading-relaxed text-muted">
              当前是「链接直连」：到「成员」里点开某个 AI，复制它的<strong>带 token 的公网链接</strong>（形如 {state.urls.public}/wb_…），在 Sesame / ChatGPT / Claude.ai
              添加自定义应用或连接器时整条填进去，认证选「无」或不填，有链接就能连，不会弹登录卡片。链接等同密码，不要公开。
            </p>
          ) : (
            <p className="text-xs leading-relaxed text-muted">
              在 ChatGPT / Claude.ai 添加连接器时填这个地址，认证选 OAuth。浏览器会显示 4 位配对码，本应用会弹窗请你核对后批准。OAuth 模式下经公网不接受带 token 的链接。
            </p>
          )}
        </div>
      )}

      <div className="mt-5 space-y-4">
        <Field label="网页 AI 认证">
          <Segmented
            value={state.authMode}
            options={[
              { value: 'link', label: '链接直连', title: '和 ShunCode 一样：地址里带 token 就能连，不走 OAuth 登录' },
              { value: 'oauth', label: 'OAuth', title: '网页 AI 走 OAuth，需要在桌面核对配对码并批准' }
            ]}
            onChange={(mode) => !busy && mode !== state.authMode && run('auth', () => window.bridge.setAuthMode(mode))}
          />
          <div className="text-xs leading-relaxed text-muted">
            {state.authMode === 'link'
              ? '链接直连：不暴露 OAuth 端点，客户端不会弹登录卡片。token 是 192 位随机数，泄露了到「成员」里更换 token 即可让旧链接失效。'
              : 'OAuth：公网只能用 OAuth 或 Bearer 请求头连接，每个网页连接都要你在桌面批准。'}
            切换立即生效，不用重启服务。
          </div>
        </Field>

        <Field label="模式">
          <Segmented
            value={ts.mode}
            options={[
              { value: 'quick', label: MODE_LABELS.quick, title: '临时 trycloudflare.com 地址，不需要账号' },
              { value: 'named', label: MODE_LABELS.named, title: '固定域名，需要 Cloudflare 账号和托管在 Cloudflare 的域名' }
            ]}
            // Segmented 没有 disabled，忙的时候直接忽略点击
            onChange={(mode) => !busy && mode !== ts.mode && run('mode', () => window.bridge.setTunnelSettings({ mode }))}
          />
          {/* 运行中允许切换，但只改设置；正在跑的隧道还是旧模式，要重启才换 */}
          {active && tunnel.mode !== ts.mode && (
            <div className="text-xs leading-relaxed text-warn">隧道正按「{MODE_LABELS[tunnel.mode]}」运行，停止后重新启动才会换成新模式。</div>
          )}
        </Field>

        {ts.mode === 'quick' ? (
          <p className="text-xs leading-relaxed text-muted">
            每次启动会得到一个临时的 <code className="font-mono">https://xxx.trycloudflare.com</code> 地址，不需要 Cloudflare 账号。地址每次启动都会变，变了要在 AI
            那边重新添加连接器。Cloudflare 说明它只用于测试：最多 200 个并发请求，没有可用性保证。
          </p>
        ) : (
          <div className="space-y-4">
            <Field label="域名" hint="只填域名，如 mcp.example.com，不带 https:// 和路径。">
              <Input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="mcp.example.com" spellCheck={false} />
            </Field>
            <Field label="Tunnel token">
              <div className="flex items-center gap-2">
                <Input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={ts.hasToken ? '已保存，留空不修改' : '粘贴 token，或整条安装命令'}
                  autoComplete="off"
                  spellCheck={false}
                />
                {ts.hasToken && (
                  <ConfirmButton size="md" confirmText="确认清除？" onConfirm={() => void run('clear', () => window.bridge.setTunnelSettings({ token: '' }))}>
                    清除
                  </ConfirmButton>
                )}
              </div>
            </Field>
            <div className="flex items-center gap-3">
              <Button disabled={!!busy || !dirty} onClick={save}>
                {busy === 'save' ? '保存中…' : '保存'}
              </Button>
              {active && <span className="text-xs text-muted">隧道运行中，改了域名或 token 要停止再启动才生效。</span>}
            </div>
            {missingNamed && <div className="text-xs text-warn">先保存域名和 tunnel token，才能启动隧道。</div>}
            <ol className="list-decimal space-y-1.5 pl-4 text-xs leading-relaxed text-muted">
              <li>
                打开 Cloudflare 控制台 → Zero Trust → Networks → Tunnels（新版控制台在 Networking → Tunnels），创建一个 Cloudflared 类型的隧道。
              </li>
              <li>页面给出的安装命令里，eyJ 开头的那一长串就是 token，复制到上面。本应用会自己运行 cloudflared，不需要执行那条命令。</li>
              <li>
                在隧道里添加 Published application 路由（旧版叫 Public Hostname）：域名填上面那个，服务地址填
                <span className="mx-1 inline-flex items-center gap-1 align-middle">
                  <code className="selectable rounded bg-canvas px-1.5 py-0.5 font-mono">{serviceUrl}</code>
                  <CopyButton text={serviceUrl} label="" />
                </span>
                。改了本应用的端口，这里也要跟着改。
              </li>
            </ol>
          </div>
        )}

        <Check checked={ts.autoStart} disabled={!!busy} onChange={(v) => run('autoStart', () => window.bridge.setTunnelSettings({ autoStart: v }))} title="启动应用时自动开隧道">
          {ts.mode === 'quick' ? '临时地址每次启动都会变，自动开了也要在 AI 那边重新添加连接器。' : undefined}
        </Check>
        <Check checked={!!ts.keepOnExit} disabled={!!busy} onChange={(v) => run('keepOnExit', () => window.bridge.setTunnelSettings({ keepOnExit: v }))} title="关闭应用时保留隧道">
          {keepHint}
        </Check>
      </div>
    </Card>
  )
}
