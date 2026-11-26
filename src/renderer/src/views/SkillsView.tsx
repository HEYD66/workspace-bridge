import { ArrowLeftRight, Check, Download, FileArchive, FileText, FolderOpen, Loader2, Pencil, Plus, Power, PowerOff, RotateCcw, Sparkles, Trash2, TriangleAlert } from 'lucide-react'
import { Component, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { BridgeState, SkillDetail, SkillImportPreview, SkillImportResult, SkillInfo, SkillInput } from '../../../shared/api'
import { useContextMenu } from '../components/ContextMenu'
import { Badge, Button, Card, ConfirmButton, cx, EmptyState, Field, Input, PanelHeader, TextArea } from '../components/ui'
import { WorkspaceTag } from '../components/WorkspaceSwitcher'
import { errText, formatBytes, timeAgo } from '../lib/format'
import { skillMenu } from '../lib/menus'
import { navigate } from '../lib/nav'
import { setSkillWorkspace, skillWorkspaceOptions } from '../lib/skillScope'

type Scope = SkillInfo['scope']

/** 和后端 SKILL_NAME_RE 一致：小写字母或数字开头，后面可以有 - 和 _，最长 64（skills.ts 依赖 Node，界面不能直接引入） */
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

const SCOPE_LABEL: Record<Scope, string> = { project: '项目', user: '用户' }

type WorkspaceItem = BridgeState['workspaces'][number]

/** 技能页正在看的工作区：viewing 是别的工作区的 id；不给就是工作台的当前工作区 */
function viewedWorkspace(state: BridgeState, viewing?: string): WorkspaceItem | undefined {
  return (state.workspaces ?? []).find((w) => w.id === (viewing ?? state.activeWorkspaceId))
}

/** 哪些 AI 能加载：用户级和目录工作区的项目级是所有 AI；整台电脑里的项目级只有开了「整台电脑」的 AI */
function whoCanLoad(scope: Scope, ws: WorkspaceItem | undefined): string {
  return scope === 'project' && ws?.kind === 'machine' ? '在团队页开了「整台电脑」的 AI' : '所有 AI'
}

const GROUPS: { label: string; color: string; match: (s: SkillInfo) => boolean }[] = [
  { label: '生效中', color: '#3fb950', match: (s) => s.status === 'enabled' },
  { label: '已停用', color: '#8b949e', match: (s) => s.status === 'disabled' },
  { label: '无法使用', color: '#f85149', match: (s) => s.status === 'invalid' }
]

/** 项目级在前（同名优先），再按名字 */
const byScopeName = (a: SkillInfo, b: SkillInfo): number => (a.scope === b.scope ? 0 : a.scope === 'project' ? -1 : 1) || a.name.localeCompare(b.name)

function statusMeta(s: SkillInfo): { label: string; color: string } {
  switch (s.status) {
    case 'enabled':
      return s.origin === 'agent' ? { label: 'AI 写入 · 生效中', color: '#a371f7' } : { label: '生效中', color: '#3fb950' }
    case 'disabled':
      return { label: '已停用', color: '#8b949e' }
    default:
      return { label: '无法使用', color: '#f85149' }
  }
}

function originText(s: SkillInfo): string {
  if (s.origin === 'agent') return `${s.installedBy ?? 'AI'} 用 install_skill 写入`
  if (s.origin === 'found') return '直接放进技能目录的，不是在工作台或用 install_skill 写入'
  return '你在工作台创建或导入'
}

const fullTime = (ts: number): string => new Date(ts).toLocaleString('zh-CN', { hour12: false })

/** 去掉 SKILL.md 开头的 frontmatter（--- 到 ---），剩下的是正文 */
function stripFrontmatter(content: string): string {
  const m = content.match(/^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/)
  return (m ? content.slice(m[0].length) : content).replace(/^(?:[ \t]*\r?\n)+/, '')
}

/** 技能页里任何渲染错误都只影响这一块，不让整个窗口白屏 */
class SkillBoundary extends Component<{ children: ReactNode; resetKey?: unknown }, { error?: string }> {
  state: { error?: string } = {}
  static getDerivedStateFromError(e: unknown) {
    return { error: errText(e) }
  }
  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: undefined })
  }
  render() {
    if (this.state.error) return <div className="p-4 text-xs leading-relaxed text-bad">技能页显示出错：{this.state.error}</div>
    return this.props.children
  }
}

function SkillTags({ skill }: { skill: SkillInfo }) {
  const st = statusMeta(skill)
  return (
    <>
      <Badge color={skill.scope === 'project' ? '#58a6ff' : undefined}>{SCOPE_LABEL[skill.scope]}</Badge>
      <Badge color={st.color}>{st.label}</Badge>
      {skill.shadowed && <Badge color="#8b949e">被同名项目技能遮住</Badge>}
      {skill.hasScripts && <Badge>含脚本</Badge>}
    </>
  )
}

/** 技能放在哪两个目录 */
function SkillPlaces() {
  return (
    <div className="space-y-1.5 text-left text-xs leading-relaxed text-muted">
      <div>
        项目级：<code className="selectable font-mono text-fg">{'<工作区>/.bridge/skills/<名字>/SKILL.md'}</code>（只在这个工作区可用，同名时优先）
      </div>
      <div>
        用户级：<code className="selectable font-mono text-fg">{'~/.workspace-bridge/skills/<名字>/SKILL.md'}</code>（所有工作区共用）
      </div>
    </div>
  )
}

// ========== 左栏：技能列表 ==========

interface SkillListProps {
  state: BridgeState
  /** 正在看的工作区的技能 */
  skills: SkillInfo[]
  /** 刚换了要看的工作区，列表还没到 */
  loading?: boolean
  error?: string
  selected?: string
  onSelect: (id: string) => void
  onRetry: () => void
  /** 正在看别的工作区时是它的 id；看当前工作区时不给 */
  viewing?: string
}

export function SkillList(props: SkillListProps) {
  return (
    <SkillBoundary resetKey={props.skills}>
      <SkillListInner {...props} />
    </SkillBoundary>
  )
}

function SkillListInner({ state, skills, loading, error, selected, onSelect, onRetry, viewing }: SkillListProps) {
  const groups = useMemo(() => GROUPS.map((g) => ({ ...g, items: skills.filter(g.match).sort(byScopeName) })), [skills])
  const options = useMemo(() => skillWorkspaceOptions(state), [state])
  const viewed = viewedWorkspace(state, viewing)
  // 能选的不止一个，或者没有当前工作区（这时只能靠它去看整台电脑的）才显示下拉框
  const showPicker = options.length > 1 || (!state.activeWorkspaceId && options.length > 0)
  const [menuError, setMenuError] = useState('')
  const ctx = useContextMenu()

  /** 技能右键（T-13）：改完用 onRetry 重新拉列表 */
  const openMenu = (e: React.MouseEvent, s: SkillInfo): void => {
    const attempt = (fn: () => Promise<unknown>): void => {
      setMenuError('')
      fn().then(onRetry, (err) => setMenuError(errText(err)))
    }
    ctx.open(
      e,
      skillMenu(s, {
        open: () => onSelect(s.id),
        setEnabled: (on) => attempt(() => window.bridge.setSkillEnabled(s.id, on, viewing)),
        openDir: () => void window.bridge.openSkillDir(s.id, viewing).catch((err) => setMenuError(errText(err))),
        copyName: () => void window.bridge.copy(s.name),
        remove: () =>
          attempt(async () => {
            await window.bridge.deleteSkill(s.id, viewing)
            if (selected === s.id) navigate({ section: 'skills', id: undefined })
          })
      })
    )
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="技能">
        {!showPicker && <WorkspaceTag state={state} />}
        <Button size="sm" variant="ghost" title="导入现成的技能包：文件夹，或 .zip / .skill 文件" onClick={() => onSelect('import')}>
          <Download size={13} /> 导入
        </Button>
        <Button size="sm" variant="ghost" title="新建技能" onClick={() => onSelect('new')}>
          <Plus size={13} /> 新建
        </Button>
      </PanelHeader>
      {showPicker && (
        <div className="space-y-1 px-3 pb-2">
          <select
            aria-label="看哪个工作区的技能"
            title="看哪个工作区的技能。只换技能页显示的内容，工作台的当前工作区不变"
            value={viewing ?? state.activeWorkspaceId ?? ''}
            onChange={(e) => {
              setSkillWorkspace(e.target.value || undefined)
              // 项目级技能各工作区不通用，选中的作废
              navigate({ section: 'skills', id: undefined })
            }}
            className="h-7 w-full rounded-md border border-line bg-canvas px-2 text-xs text-fg outline-none focus:border-accent"
          >
            {!state.activeWorkspaceId && <option value="">没有工作区（只有用户级技能）</option>}
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
                {o.current ? '（当前工作区）' : ''}
              </option>
            ))}
          </select>
          {viewing && viewed && (
            <div className="text-[11px] leading-relaxed text-faint">
              正在看「{viewed.name}」的技能{viewed.kind === 'machine' ? '（工作台切不到整台电脑，它的技能在这里看）' : ''}。工作台的当前工作区没有变
            </div>
          )}
        </div>
      )}
      {error && (
        <div className="mx-3 mb-2 space-y-1.5 rounded-md border border-bad/40 bg-bad/10 px-2.5 py-2 text-[11px] leading-relaxed text-bad">
          <div>
            技能列表加载失败{skills.length ? '，下面是上次的结果' : ''}：{error}
          </div>
          <Button size="sm" onClick={onRetry}>
            <RotateCcw size={11} /> 重试
          </Button>
        </div>
      )}
      {!state.workspaceRoot && !viewing && <div className="px-3 pb-2 text-[11px] text-faint">没选工作区，只显示用户级技能</div>}
      {menuError && <div className="px-3 pb-2 text-xs text-bad">{menuError}</div>}
      <div className="flex-1 overflow-auto pb-4">
        {skills.length === 0 && !error && !loading && (
          <EmptyState
            icon={<Sparkles size={24} />}
            title={viewing && viewed ? `「${viewed.name}」里还没有技能` : '还没有技能'}
            hint={showPicker ? '项目级技能按工作区分开放，用上面的下拉框可以看别的工作区的。也可以点「新建」自己写，或点「导入」导入现成的技能包' : '点上面的「新建」自己写、点「导入」导入现成的技能包，或者让 AI 用 install_skill 写入'}
          />
        )}
        {groups.map(
          (g) =>
            g.items.length > 0 && (
              <div key={g.label} className="mt-1">
                <div className="flex items-center gap-1.5 px-3 py-1 text-[11px] font-medium text-muted">
                  <span className="h-2 w-2 rounded-full" style={{ background: g.color }} />
                  {g.label}
                  <span className="text-faint">{g.items.length}</span>
                </div>
                {g.items.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => onSelect(s.id)}
                    onContextMenu={(e) => openMenu(e, s)}
                    className={cx('mx-1.5 cursor-pointer rounded px-2 py-2 hover:bg-hover', selected === s.id && 'bg-accent/15', s.shadowed && 'opacity-70')}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg">{s.name}</span>
                      <span className="shrink-0 text-[11px] text-faint" title={`AI 加载过 ${s.usage?.loads ?? 0} 次`}>
                        {s.usage?.loads ?? 0} 次
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted">{s.description || '（没有描述）'}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <SkillTags skill={s} />
                      {s.origin === 'agent' && <span className="text-[11px] text-faint">来自 {s.installedBy ?? '未知 AI'}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )
        )}
      </div>
      {ctx.menu}
    </div>
  )
}

// ========== 中间：没选技能时 ==========

export function SkillsHome({
  state,
  skills,
  loading,
  error,
  viewing
}: {
  state: BridgeState
  skills: SkillInfo[]
  loading?: boolean
  error?: string
  viewing?: string
}) {
  const viewed = viewedWorkspace(state, viewing)
  if (skills.length === 0 && error) return <EmptyState icon={<TriangleAlert size={28} />} title="技能列表加载失败" hint={error} />
  if (loading) {
    return (
      <div className="flex justify-center py-14 text-muted">
        <Loader2 size={18} className="animate-spin" />
      </div>
    )
  }
  if (skills.length === 0) {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-3 px-6 py-14 text-center">
        <Sparkles size={28} className="text-faint" />
        <div className="text-[13px] text-fg">{viewing && viewed ? `「${viewed.name}」里还没有技能` : '还没有技能'}</div>
        <div className="text-xs leading-relaxed text-muted">技能是一份写给 AI 的操作说明（SKILL.md），AI 按描述决定什么时候加载。技能放在这两个目录：</div>
        <SkillPlaces />
        <div className="text-xs leading-relaxed text-muted">
          点左栏的「新建」自己写、点「导入」导入现成的技能包（文件夹或 zip），或者让 AI 用 install_skill 写入。技能放进去就生效，不用你启用；不想要的可以在这里停用或删除。AI 写的技能在它自己的工作区里，用左栏的下拉框可以看别的工作区的。
        </div>
      </div>
    )
  }
  return (
    <EmptyState
      icon={<Sparkles size={28} />}
      title="选择左侧的技能查看详情"
      hint="技能放进来就生效，AI 写入的也一样，不用你启用；不想要的可以停用或删除"
    />
  )
}

// ========== 中间：详情 / 编辑 / 新建 ==========

interface SkillMainProps {
  state: BridgeState
  skills: SkillInfo[]
  id: string
  onSelect: (id?: string) => void
  onChanged: () => void
  /** 正在看别的工作区的技能时是它的 id，每个操作都要带上（项目级技能的 id 只在一个工作区里唯一）；看当前工作区时不给 */
  workspaceId?: string
}

export function SkillMain(props: SkillMainProps) {
  return (
    <SkillBoundary resetKey={props.skills}>
      <SkillMainInner {...props} />
    </SkillBoundary>
  )
}

function SkillMainInner({ state, skills, id, onSelect, onChanged, workspaceId }: SkillMainProps) {
  if (id === 'import') return <SkillImporter state={state} skills={skills} workspaceId={workspaceId} onChanged={onChanged} onOpen={onSelect} />
  if (id === 'new')
    return <SkillEditor state={state} skills={skills} workspaceId={workspaceId} onSaved={(s) => (onChanged(), onSelect(s.id))} onCancel={() => onSelect(undefined)} />
  return (
    <SkillDetailPane
      state={state}
      skills={skills}
      id={id}
      workspaceId={workspaceId}
      onDeleted={() => (onChanged(), onSelect(undefined))}
      onMoved={(s) => (onChanged(), onSelect(s.id))}
      onChanged={onChanged}
    />
  )
}

function ReviewCard({ tone, title, children }: { tone: 'warn' | 'bad' | 'plain'; title: ReactNode; children: ReactNode }) {
  return (
    <div
      className={cx(
        'space-y-3 rounded-lg border p-4',
        tone === 'warn' && 'border-warn/40 bg-warn/[0.06]',
        tone === 'bad' && 'border-bad/40 bg-bad/[0.06]',
        tone === 'plain' && 'border-line bg-panel'
      )}
    >
      <div className={cx('text-[13px] font-medium', tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : 'text-fg')}>{title}</div>
      {children}
    </div>
  )
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      <div className="w-16 shrink-0 pt-0.5 text-xs text-faint">{label}</div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-[13px] text-fg">{children}</div>
    </div>
  )
}

function SkillDetailPane({
  state,
  skills,
  id,
  onDeleted,
  onMoved,
  onChanged,
  workspaceId: ws
}: {
  state: BridgeState
  skills: SkillInfo[]
  id: string
  onDeleted: () => void
  /** 改了范围（项目级 ↔ 用户级）：技能的 id 变了，传回挪过去之后的 */
  onMoved: (s: SkillInfo) => void
  onChanged: () => void
  workspaceId?: string
}) {
  const wsView = viewedWorkspace(state, ws)
  const info = skills.find((s) => s.id === id)
  const [detail, setDetail] = useState<SkillDetail>()
  const [loadError, setLoadError] = useState('')
  const [tick, setTick] = useState(0)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  /** 「挪到」下拉框选的：'user' 是用户级，别的是工作区 id（那个工作区的项目级） */
  const [moveDest, setMoveDest] = useState('')

  // 列表每次重新拉取（技能状态或文件变了）都重新读详情，保证你看到的是最新内容
  useEffect(() => {
    let alive = true
    window.bridge.getSkill(id, ws).then(
      (d) => {
        if (!alive) return
        setDetail(d)
        setLoadError('')
      },
      (e) => alive && setLoadError(errText(e))
    )
    return () => {
      alive = false
    }
  }, [id, ws, info, tick])

  // 列表里没有、又读不到详情（被删了，或换了工作区）：不再显示上次读到的旧内容
  const view: SkillInfo | undefined = info ?? (loadError ? undefined : detail)

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy('')
    }
  }
  const refresh = () => {
    setTick((t) => t + 1)
    onChanged()
  }

  const enable = () =>
    run('enable', async () => {
      await window.bridge.setSkillEnabled(id, true, ws)
      refresh()
    })
  const disable = () =>
    run('disable', async () => {
      await window.bridge.setSkillEnabled(id, false, ws)
      refresh()
    })
  const remove = () =>
    run('delete', async () => {
      await window.bridge.deleteSkill(id, ws)
      onDeleted()
    })
  const openDir = () => run('open', () => window.bridge.openSkillDir(id, ws))
  const viewedId = ws ?? state.activeWorkspaceId
  const moveTo = (dest: string) =>
    run('move', async () => {
      const moved = dest === 'user' ? await window.bridge.setSkillScope(id, 'user', ws) : await window.bridge.setSkillScope(id, 'project', ws, dest)
      // 挪进了别的工作区：技能页跟过去看
      if (dest !== 'user' && dest !== viewedId) setSkillWorkspace(dest)
      onMoved(moved)
    })

  if (!view) {
    if (loadError) return <EmptyState icon={<TriangleAlert size={28} />} title="打不开这个技能" hint={loadError} />
    return (
      <div className="flex justify-center py-14 text-muted">
        <Loader2 size={18} className="animate-spin" />
      </div>
    )
  }

  if (editing && detail) {
    return (
      <SkillEditor
        state={state}
        skills={skills}
        detail={detail}
        workspaceId={ws}
        onSaved={() => {
          setEditing(false)
          refresh()
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }

  const files = view.files ?? []
  // 「范围」那一行：这个技能现在在哪，能挪到哪
  const projectWhere = ws && wsView ? `工作区「${wsView.name}」` : '当前工作区'
  // 能挪去的地方：用户级，和每个工作区的项目级（它现在所在的那个除外）
  const dests: { value: string; label: string }[] = [
    ...(view.scope === 'project' ? [{ value: 'user', label: '用户级（所有工作区都能用）' }] : []),
    ...skillWorkspaceOptions(state)
      .filter((o) => !(view.scope === 'project' && o.id === viewedId))
      .map((o) => ({ value: o.id, label: `项目级 ·「${o.name}」${o.current ? '（当前工作区）' : ''}` }))
  ]
  const dest = dests.some((d) => d.value === moveDest) ? moveDest : (dests.find((d) => d.value === viewedId)?.value ?? dests[0]?.value ?? '')
  // 目标就在技能页正在看的列表里时，能提前知道有没有同名的；别的工作区的由后端检查，有同名会报错
  const destScope: Scope | undefined = dest === 'user' ? 'user' : dest === viewedId ? 'project' : undefined
  const scopeClash = !!destScope && skills.some((s) => s.scope === destScope && s.name.toLowerCase() === view.name.toLowerCase())
  const loads = view.usage?.loads ?? 0
  const reads = view.usage?.reads ?? 0

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles size={16} className="shrink-0 text-accent" />
        <h1 className="selectable font-mono text-lg font-semibold text-fg">{view.name}</h1>
        {ws && wsView && view.scope === 'project' && (
          <span title={`这个技能在工作区「${wsView.name}」里（${wsView.root}），不是工作台的当前工作区`}>
            <Badge color="#d29922">{wsView.name}</Badge>
          </span>
        )}
        <SkillTags skill={view} />
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" disabled={!detail || !!busy} title={detail ? undefined : 'SKILL.md 还没读出来'} onClick={() => setEditing(true)}>
            <Pencil size={12} /> 编辑
          </Button>
          <ConfirmButton confirmText="整个技能目录会移进回收站，再点一次确认" onConfirm={() => void remove()}>
            <Trash2 size={12} /> 删除
          </ConfirmButton>
        </div>
      </div>
      <div className="selectable text-[13px] leading-relaxed text-muted">{view.description || '（SKILL.md 里没写 description，AI 不知道什么时候该用它）'}</div>
      {view.shadowed && <div className="text-xs text-warn">工作区里有同名的项目技能，项目级优先，AI 看不到这一条用户技能。</div>}

      {view.status === 'disabled' && (
        <ReviewCard tone="plain" title="你停用了这个技能：AI 看不到它">
          <div className="text-xs leading-relaxed text-muted">重新启用后{whoCanLoad(view.scope, wsView)} 都能加载这个技能的说明。</div>
          <Button variant="primary" disabled={!!busy} onClick={enable}>
            {busy === 'enable' ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />} 启用
          </Button>
        </ReviewCard>
      )}

      {view.status === 'enabled' && (
        <ReviewCard tone="plain" title={`生效中：${whoCanLoad(view.scope, wsView)} 都能加载这个技能的说明`}>
          <div className="text-xs leading-relaxed text-muted">
            {view.origin === 'agent' ? `这是 ${view.installedBy ?? '某个 AI'} 写入的，写入后直接生效，没有经过你审阅。` : ''}
            文件之后被改动也继续生效。不想让 AI 用它就点停用，或者直接删除。
          </div>
          <Button disabled={!!busy} onClick={disable}>
            {busy === 'disable' ? <Loader2 size={13} className="animate-spin" /> : <PowerOff size={13} />} 停用
          </Button>
        </ReviewCard>
      )}

      {view.status === 'invalid' && (
        <ReviewCard tone="bad" title="无法使用">
          <div className="selectable text-xs leading-relaxed text-fg">{view.problem || '原因未知'}</div>
          <div className="text-xs leading-relaxed text-muted">修好技能目录里的问题后自动生效。可以点「打开目录」去改，也可以点「编辑」重写 SKILL.md。</div>
        </ReviewCard>
      )}

      {error && <div className="text-xs text-bad">{error}</div>}

      <Card className="divide-y divide-line-soft">
        <InfoRow label="范围">
          <Badge color={view.scope === 'project' ? '#58a6ff' : undefined}>{SCOPE_LABEL[view.scope]}</Badge>
          <span className="text-xs text-faint">{view.scope === 'project' ? `只在${projectWhere}可用` : '所有工作区都能用'}</span>
          {dests.length > 0 && (
            <span className="flex w-full flex-wrap items-center gap-2">
              <span className="text-xs text-muted">挪到</span>
              <select
                aria-label="挪到哪里"
                value={dest}
                disabled={!!busy}
                onChange={(e) => setMoveDest(e.target.value)}
                className="h-7 max-w-[280px] rounded-md border border-line bg-canvas px-2 text-xs text-fg outline-none focus:border-accent"
              >
                {dests.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
              <Button size="sm" disabled={!!busy || scopeClash} title="整个技能目录移过去，启用状态、来源、使用次数都跟着走" onClick={() => void moveTo(dest)}>
                {busy === 'move' ? <Loader2 size={12} className="animate-spin" /> : <ArrowLeftRight size={12} />} 挪过去
              </Button>
              {scopeClash && <span className="text-xs text-faint">那里已经有同名的技能，挪不了</span>}
            </span>
          )}
        </InfoRow>
        {view.scope === 'project' && wsView && (
          <InfoRow label="工作区">
            <span>{wsView.name}</span>
            <span className="text-xs text-faint">{ws ? '不是工作台的当前工作区，只在技能页这样看' : '当前工作区'}</span>
          </InfoRow>
        )}
        <InfoRow label="目录">
          {detail ? <span className="selectable min-w-0 font-mono text-xs break-all text-fg">{detail.dir}</span> : <span className="text-xs text-faint">读取中…</span>}
          <Button size="sm" disabled={busy === 'open'} onClick={openDir}>
            <FolderOpen size={12} /> 打开目录
          </Button>
        </InfoRow>
        <InfoRow label="来源">{originText(view)}</InfoRow>
        {view.enabledAt && <InfoRow label="生效时间">{`${fullTime(view.enabledAt)}（${timeAgo(view.enabledAt)}）`}</InfoRow>}
        <InfoRow label="使用">
          AI 加载 {loads} 次 · 读附带文件 {reads} 次 · {view.usage?.lastUsedAt ? `最近一次 ${timeAgo(view.usage.lastUsedAt)}` : '还没用过'}
        </InfoRow>
      </Card>

      <div className="space-y-1.5">
        <div className="text-xs font-medium text-muted">文件（{files.length}）</div>
        {view.hasScripts && <div className="text-[11px] text-warn">含 scripts/ 目录：AI 加载这个技能后可以用 run_command 运行里面的脚本</div>}
        <div className="max-h-48 overflow-auto rounded-md border border-line bg-canvas py-1 font-mono text-xs">
          {files.length === 0 && <div className="px-3 py-1 text-faint">（没有文件）</div>}
          {files.map((f) => (
            <div key={f} className="flex items-center gap-2 px-3 py-0.5">
              <FileText size={11} className="shrink-0 text-faint" />
              <span className="selectable min-w-0 truncate text-fg">{f}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-xs font-medium text-muted">SKILL.md</div>
        {detail && loadError && <div className="text-[11px] text-bad">刷新失败，下面是上次读到的内容：{loadError}</div>}
        {detail ? (
          <pre className="selectable max-h-[560px] overflow-auto rounded-md border border-line bg-canvas p-3 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap text-fg">
            {detail.content || '（空文件）'}
          </pre>
        ) : loadError ? (
          <div className="text-xs text-bad">读不到 SKILL.md：{loadError}</div>
        ) : (
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <Loader2 size={12} className="animate-spin" /> 读取中…
          </div>
        )}
      </div>
    </div>
  )
}

/** 范围选择：和 Segmented 一样的外观，但项目级在没选工作区时不可选 */
function ScopePicker({ value, onChange, projectDisabled, where }: { value: Scope; onChange: (v: Scope) => void; projectDisabled: boolean; where: string }) {
  const options: { value: Scope; label: string; title: string }[] = [
    { value: 'project', label: '项目', title: projectDisabled ? '先在顶栏选工作区' : `只在${where}可用` },
    { value: 'user', label: '用户', title: '所有工作区都能用' }
  ]
  return (
    <div className="inline-flex rounded-md border border-line bg-canvas p-0.5">
      {options.map((o) => {
        const disabled = o.value === 'project' && projectDisabled
        return (
          <button
            key={o.value}
            title={o.title}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cx(
              'h-6 cursor-pointer rounded px-2.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40',
              value === o.value ? 'bg-hover text-fg' : 'text-muted hover:text-fg'
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** 新建（不传 detail）或编辑已有技能的 SKILL.md */
function SkillEditor({
  state,
  skills,
  detail,
  onSaved,
  onCancel,
  workspaceId
}: {
  state: BridgeState
  skills: SkillInfo[]
  detail?: SkillDetail
  onSaved: (s: SkillInfo) => void
  onCancel: () => void
  /** 正在看别的工作区的技能时是它的 id：项目级技能存进那个工作区 */
  workspaceId?: string
}) {
  const wsView = viewedWorkspace(state, workspaceId)
  // 项目级技能存在哪：正在看的工作区（不一定是工作台的当前工作区）
  const where = workspaceId && wsView ? `工作区「${wsView.name}」` : '当前工作区'
  const noWorkspace = !state.workspaceRoot && !workspaceId
  // 打开表单时的内容快照：判断有没有改过，以及编辑期间文件有没有被别人改
  const [original] = useState(() => ({
    content: detail?.content ?? '',
    description: detail?.description ?? '',
    body: detail ? stripFrontmatter(detail.content) : ''
  }))
  const [scope, setScope] = useState<Scope>(detail?.scope ?? (noWorkspace ? 'user' : 'project'))
  const [name, setName] = useState(detail?.name ?? '')
  const [description, setDescription] = useState(original.description)
  const [body, setBody] = useState(original.body)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const trimmed = name.trim()
  const nameOk = !!detail || NAME_RE.test(trimmed)
  const duplicate = !detail && skills.some((s) => s.scope === scope && s.name === trimmed)
  const shadows = !detail && scope === 'project' && skills.some((s) => s.scope === 'user' && s.name === trimmed)
  const needWorkspace = scope === 'project' && noWorkspace
  const dirty = !detail || description !== original.description || body !== original.body
  const editedOutside = !!detail && detail.content !== original.content
  const canSave = nameOk && !!description.trim() && !needWorkspace && !duplicate && dirty && !busy

  const saveHint = !detail
    ? `保存后直接生效，${whoCanLoad(scope, wsView)} 都能加载这个技能的说明。`
    : detail.status === 'enabled'
      ? '这个技能在生效中：保存后 AI 下次加载读到的就是新内容。'
      : ''

  async function save() {
    setBusy(true)
    setError('')
    try {
      const input: SkillInput = { scope, name: detail ? detail.name : trimmed, description: description.trim(), body }
      onSaved(await window.bridge.saveSkill(input, workspaceId))
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <div className="flex items-center gap-2">
        <Badge color="#58a6ff">{detail ? `编辑技能 ${detail.name}` : '新技能'}</Badge>
        {detail && <span className="text-xs text-faint">只改 SKILL.md，目录里的其他文件不动</span>}
      </div>
      <Field
        label="范围"
        hint={
          detail
            ? '范围在技能详情页里改（「范围」那一行的「挪到」）'
            : noWorkspace
              ? '没选工作区，只能建用户技能'
              : scope === 'project'
                ? `只在${where}可用：${workspaceId && wsView ? wsView.root : '<工作区>'}/.bridge/skills/<名字>/，和用户技能同名时优先`
                : '所有工作区都能用：~/.workspace-bridge/skills/<名字>/'
        }
      >
        {detail ? (
          <div>
            <Badge color={detail.scope === 'project' ? '#58a6ff' : undefined}>{SCOPE_LABEL[detail.scope]}</Badge>
          </div>
        ) : (
          <div>
            <ScopePicker value={scope} onChange={setScope} projectDisabled={noWorkspace} where={where} />
          </div>
        )}
      </Field>
      <Field label="名字" hint={detail ? '名字就是目录名，建好后不能改' : '小写字母、数字、- 和 _，以字母或数字开头，最长 64 个字符；也是目录名，建好后不能改'}>
        <Input value={name} disabled={!!detail} onChange={(e) => setName(e.target.value)} placeholder="如：code-review" className="font-mono disabled:opacity-60" />
        {!detail && trimmed && !nameOk && <div className="text-[11px] text-bad">名字只能用小写字母、数字、- 和 _，以字母或数字开头，最长 64 个字符</div>}
        {duplicate && <div className="text-[11px] text-bad">这个范围里已经有叫 {trimmed} 的技能了，去列表里编辑它</div>}
        {shadows && <div className="text-[11px] text-warn">有同名的用户技能，建好后项目技能优先，那条用户技能在这个工作区会被遮住</div>}
      </Field>
      <Field label="描述" hint="一句话说清楚什么时候该用它，AI 按这句话决定要不要加载">
        <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="如：审查代码改动时使用，按团队规范逐项检查" />
      </Field>
      <Field label="正文" hint="Markdown。AI 加载技能时读到的就是这部分；开头的 frontmatter 由名字和描述自动生成">
        <TextArea rows={18} value={body} onChange={(e) => setBody(e.target.value)} placeholder={'## 什么时候用\n\n## 步骤\n1. …'} className="font-mono text-[12.5px]" />
      </Field>
      {editedOutside && <div className="text-xs text-warn">SKILL.md 在你编辑时被改动过，保存会覆盖那些改动</div>}
      {needWorkspace && <div className="text-xs text-bad">项目技能要先在顶栏选工作区</div>}
      {saveHint && <div className="text-xs text-muted">{saveHint}</div>}
      {error && <div className="text-xs text-bad">{error}</div>}
      <div className="flex gap-2">
        <Button variant="primary" disabled={!canSave} onClick={save}>
          {busy && <Loader2 size={13} className="animate-spin" />}
          {detail ? '保存' : '创建'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  )
}

// ========== 中间：导入现成的技能包 ==========

type ImportStatus = SkillImportResult['results'][number]['status']

const NO_SKILLS: SkillInfo[] = []

const IMPORT_STATUS: Record<ImportStatus, { label: string; color: string }> = {
  imported: { label: '已导入', color: '#3fb950' },
  replaced: { label: '已覆盖旧的', color: '#3fb950' },
  exists: { label: '同名已存在，没有导入', color: '#d29922' },
  failed: { label: '导入失败', color: '#f85149' }
}

/** 导入现成的技能包：先选文件夹或压缩包（只读出里面有哪些技能，不写东西），你确认后才复制进技能目录 */
function SkillImporter({
  state,
  skills,
  workspaceId,
  onChanged,
  onOpen
}: {
  state: BridgeState
  skills: SkillInfo[]
  /** 正在看别的工作区的技能时是它的 id：项目级技能默认导入到那个工作区 */
  workspaceId?: string
  onChanged: () => void
  onOpen: (id?: string) => void
}) {
  const viewedId = workspaceId ?? state.activeWorkspaceId
  const wsOptions = useMemo(() => skillWorkspaceOptions(state), [state])
  // 项目级放进哪个工作区：默认是技能页正在看的那个，可以改成别的（含整台电脑）
  const [targetPick, setTargetPick] = useState<string>()
  const target = wsOptions.some((o) => o.id === targetPick) ? targetPick : wsOptions.some((o) => o.id === viewedId) ? viewedId : wsOptions[0]?.id
  const wsView = (state.workspaces ?? []).find((w) => w.id === target)
  const where = wsView ? `工作区「${wsView.name}」` : '当前工作区'
  const noWorkspace = !target
  const [preview, setPreview] = useState<SkillImportPreview>()
  const [picking, setPicking] = useState<'folder' | 'zip' | ''>('')
  const [scope, setScope] = useState<Scope>(viewedId ? 'project' : 'user')
  const [overwrite, setOverwrite] = useState(false)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<SkillImportResult>()

  const items = preview?.items ?? []
  const usable = items.filter((i) => !i.problem)
  // 目标工作区不是技能页正在看的那个时，另外拉它的技能列表，用来标「同名已存在」（拉不到也没关系，导入时后端还会查）
  const otherTarget = scope === 'project' && target && target !== viewedId ? target : undefined
  const [targetSkills, setTargetSkills] = useState<{ ws: string; list: SkillInfo[] }>()
  useEffect(() => {
    if (!otherTarget) return
    let alive = true
    window.bridge.listSkills(otherTarget).then(
      (list) => {
        if (alive) setTargetSkills({ ws: otherTarget, list })
      },
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [otherTarget, result])
  const pool = otherTarget ? (targetSkills?.ws === otherTarget ? targetSkills.list : NO_SKILLS) : skills
  /** 要导入到的地方已经有同名技能（后端按不分大小写比，这里也一样） */
  const existing = useMemo(() => new Set(pool.filter((s) => s.scope === scope).map((s) => s.name.toLowerCase())), [pool, scope])
  const exists = (name: string): boolean => existing.has(name.toLowerCase())
  const blocked = (i: (typeof items)[number]): boolean => !!i.problem || (exists(i.name) && !overwrite)
  const keys = usable.filter((i) => picked.has(i.key) && !blocked(i)).map((i) => i.key)
  const anyExists = usable.some((i) => exists(i.name))
  const needWorkspace = scope === 'project' && noWorkspace

  async function pick(kind: 'folder' | 'zip') {
    setPicking(kind)
    setError('')
    try {
      const p = await window.bridge.pickSkillImport(kind)
      // 取消选择：保留上一次选的
      if (!p) return
      setPreview(p)
      setResult(undefined)
      setOverwrite(false)
      setPicked(new Set(p.items.filter((i) => !i.problem).map((i) => i.key)))
    } catch (e) {
      setError(errText(e))
    } finally {
      setPicking('')
    }
  }

  async function apply() {
    if (!preview || !keys.length) return
    setBusy(true)
    setError('')
    try {
      const r = await window.bridge.applySkillImport(preview.importId, { scope, overwrite, keys }, scope === 'project' ? target : workspaceId)
      setResult(r)
      onChanged()
      // 只导入了一个并且成功：直接打开它
      if (r.results.length === 1 && r.results[0].id) open(r.results[0].id)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  /** 打开刚导入的技能；放进了别的工作区的，技能页先切过去看 */
  const open = (id?: string) => {
    if (id && otherTarget) setSkillWorkspace(otherTarget)
    onOpen(id)
  }

  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const pickButtons = (
    <div className="flex flex-wrap gap-2">
      <Button disabled={!!picking || busy} onClick={() => void pick('folder')}>
        {picking === 'folder' ? <Loader2 size={13} className="animate-spin" /> : <FolderOpen size={13} />} 选文件夹
      </Button>
      <Button disabled={!!picking || busy} onClick={() => void pick('zip')}>
        {picking === 'zip' ? <Loader2 size={13} className="animate-spin" /> : <FileArchive size={13} />} 选 .zip / .skill 文件
      </Button>
    </div>
  )

  if (result) {
    const done = result.results.filter((r) => r.id).length
    return (
      <div className="mx-auto max-w-3xl space-y-5 p-6">
        <div className="flex items-center gap-2">
          <Badge color="#58a6ff">导入技能包</Badge>
          <span className="text-xs text-muted">
            导入了 {done} 个{result.results.length > done ? `，${result.results.length - done} 个没有导入` : ''}
          </span>
        </div>
        <Card className="divide-y divide-line-soft">
          {result.results.map((r) => (
            <div key={r.key} className="flex items-start gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {r.id ? (
                    <button className="cursor-pointer font-mono text-[13px] text-accent hover:underline" title="打开这个技能" onClick={() => open(r.id)}>
                      {r.name}
                    </button>
                  ) : (
                    <span className="selectable font-mono text-[13px] text-fg">{r.name}</span>
                  )}
                  <Badge color={IMPORT_STATUS[r.status].color}>{IMPORT_STATUS[r.status].label}</Badge>
                </div>
                {r.problem && <div className="selectable mt-1 text-xs leading-relaxed text-muted">{r.problem}</div>}
              </div>
            </div>
          ))}
        </Card>
        {done > 0 && <div className="text-xs leading-relaxed text-muted">导入的技能放在{scope === 'project' ? `${where}的项目级` : '用户级'}，已经生效，{whoCanLoad(scope, wsView)} 都能加载。点名字可以打开查看{otherTarget ? '（技能页会切到那个工作区）' : ''}；放在哪里之后可以在技能详情的「范围」那一行改。</div>}
        <div className="flex gap-2">
          <Button
            onClick={() => {
              setResult(undefined)
              setPreview(undefined)
            }}
          >
            再导入一个
          </Button>
          <Button variant="ghost" onClick={() => onOpen(undefined)}>
            完成
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <div className="flex items-center gap-2">
        <Badge color="#58a6ff">导入技能包</Badge>
        <span className="text-xs text-faint">把现成的技能（含 SKILL.md 的文件夹）复制进技能目录</span>
      </div>

      <Field
        label="从哪里导入"
        hint={
          preview
            ? undefined
            : '文件夹：它本身是一个技能（里面有 SKILL.md），或者里面装着好几个技能，都可以。压缩包：.zip 或 .skill，最大 50 MB。这一步只是读出里面有哪些技能，不会写任何东西'
        }
      >
        {pickButtons}
        {preview && (
          <div className="selectable mt-1.5 font-mono text-xs break-all text-muted">
            {preview.kind === 'zip' ? '压缩包' : '文件夹'}：{preview.source}
          </div>
        )}
      </Field>

      {preview && (
        <>
          <Field
            label="导入到"
            hint={
              noWorkspace
                ? '没有工作区，只能导入成用户技能'
                : scope === 'project'
                  ? `只在${where}可用：${wsView ? wsView.root : '<工作区>'}/.bridge/skills/<名字>/，和用户技能同名时优先`
                  : '所有工作区都能用：~/.workspace-bridge/skills/<名字>/'
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <ScopePicker value={scope} onChange={setScope} projectDisabled={noWorkspace} where={where} />
              {scope === 'project' && wsOptions.length > 0 && (
                <select
                  aria-label="放进哪个工作区"
                  title="项目级技能放进哪个工作区。默认是技能页正在看的那个"
                  value={target ?? ''}
                  disabled={busy}
                  onChange={(e) => setTargetPick(e.target.value)}
                  className="h-7 max-w-[280px] rounded-md border border-line bg-canvas px-2 text-xs text-fg outline-none focus:border-accent"
                >
                  {wsOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                      {o.current ? '（当前工作区）' : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </Field>

          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs font-medium text-muted">
              找到 {items.length} 个技能
              {usable.length > 1 && (
                <span className="ml-auto flex gap-2 font-normal">
                  <button className="cursor-pointer text-accent hover:underline" onClick={() => setPicked(new Set(usable.map((i) => i.key)))}>
                    全选
                  </button>
                  <button className="cursor-pointer text-accent hover:underline" onClick={() => setPicked(new Set())}>
                    全不选
                  </button>
                </span>
              )}
            </div>
            <Card className="max-h-[420px] divide-y divide-line-soft overflow-auto">
              {items.map((i) => {
                const off = blocked(i)
                return (
                  <label key={i.key} className={cx('flex items-start gap-3 px-4 py-2.5', off ? 'opacity-70' : 'cursor-pointer hover:bg-hover')}>
                    <input type="checkbox" className="mt-1 accent-[#58a6ff]" disabled={off || busy} checked={!off && picked.has(i.key)} onChange={() => toggle(i.key)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="selectable font-mono text-[13px] text-fg">{i.name}</span>
                        {i.problem && <Badge color="#f85149">无法导入</Badge>}
                        {!i.problem && exists(i.name) && <Badge color="#d29922">{overwrite ? '会覆盖同名的' : '同名已存在'}</Badge>}
                        {i.hasScripts && <Badge>含脚本</Badge>}
                        <span className="ml-auto shrink-0 text-[11px] text-faint">
                          {i.files} 个文件 · {formatBytes(i.bytes)}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs leading-relaxed text-muted">{i.description || '（SKILL.md 里没写 description）'}</div>
                      {i.problem && <div className="selectable mt-0.5 text-xs leading-relaxed text-bad">{i.problem}</div>}
                      {i.key !== '.' && i.key !== i.name && <div className="mt-0.5 font-mono text-[11px] break-all text-faint">{i.key}</div>}
                    </div>
                  </label>
                )
              })}
            </Card>
          </div>

          {anyExists && (
            <label className="flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-fg">
              <input type="checkbox" className="mt-0.5 accent-[#58a6ff]" disabled={busy} checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
              <span>
                覆盖同名的技能
                <span className="text-muted">（旧的整个目录移进回收站，不会直接删掉）</span>
              </span>
            </label>
          )}

          <div className="text-xs leading-relaxed text-muted">
            导入后直接生效，{whoCanLoad(scope, wsView)} 都能加载。技能是写给 AI 的操作说明，含脚本的还能让 AI 用 run_command 运行，来路不明的技能包先看过内容再导入。
          </div>
          {needWorkspace && <div className="text-xs text-bad">项目技能要先在顶栏选工作区</div>}
        </>
      )}

      {error && <div className="selectable text-xs leading-relaxed text-bad">{error}</div>}

      <div className="flex gap-2">
        {preview && (
          <Button variant="primary" disabled={!keys.length || needWorkspace || busy} onClick={() => void apply()}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            {keys.length ? `导入 ${keys.length} 个` : '没有可导入的'}
          </Button>
        )}
        <Button variant="ghost" onClick={() => onOpen(undefined)}>
          取消
        </Button>
      </div>
    </div>
  )
}
