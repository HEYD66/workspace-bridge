// 类 Codex 界面第 3 步：右栏。三页：变更（这个项目最近改了什么，点文件看差异或全文）、任务、活动
// 11-15 起右栏是可开可关的标签页（lib/rightTabs.ts）：这三页是默认开着的工具页，「+」出新标签页，还能开网页标签（views/BrowserTab.tsx）
import { Activity, ChevronDown, ChevronRight, ExternalLink, FileDiff, FileText, FolderOpen, GitCompare, Globe, ListTodo, Loader2, Monitor, PanelRightClose, Plus, SquareTerminal, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityEvent } from '../../../shared/api'
import type { BridgeState, CheckpointSummaryResult, FileContent, TaskItem, WorkspaceView } from '../../../core/types'
import { DiffView } from '../components/DiffView'
import { Avatar, Badge, Button, ConfirmButton, cx, EmptyState, IconButton } from '../components/ui'
import { useWorkspaceSteps, type ChangeCardFile } from '../lib/changeCards'
import { openFile } from '../lib/editorStore'
import { errText, STATUS_META, timeAgo } from '../lib/format'
import { navigate } from '../lib/nav'
import { homeId } from '../lib/projects'
import { changeGroups, clearChangeFocus, focusGroup, panelTasks, previewLines, useChangeFocus, type ChangeGroup } from '../lib/rightPanel'
import { activate, activeTab, addNewTab, closeTab, fileTabKey, navigateTab, newTabId, newTabToTool, patchBrowserTab, tabTitle, updatePanelTabs, usePanelTabs, type PanelTab } from '../lib/rightTabs'
import { closeFileTab, useRightFiles } from '../lib/rightFiles'
import { closeTerminal, createTerminal, useTerminals } from '../lib/terminals'
import { ActivityPanel } from './ActivityPanel'
import { BrowserTabView, NewTabPage } from './BrowserTab'
import { RightFiles } from './FileTab'
import { moveTerminalToRight, TerminalTabView } from './TerminalView'

const TAB_ICON = { changes: FileDiff, tasks: ListTodo, activity: Activity } as const

export function RightPanel({
  state,
  events,
  workspaceId,
  channel,
  tasks,
  onOpenFile,
  onClose,
  onFiles
}: {
  state: BridgeState
  events: ActivityEvent[]
  /** 「变更」「任务」看哪个项目（正在看的会话所在的项目，没有就是当前工作区） */
  workspaceId?: string
  /** 「活动」按群聊看时看哪个群聊（正在看的会话 / 群聊，没有就是那个项目的主群聊） */
  channel?: string
  /** 那个项目的任务 */
  tasks: TaskItem[]
  onOpenFile: (path: string, ev: ActivityEvent) => void
  onClose: () => void
  /** 新标签页上点了「文件」：打开「快速打开」（Ctrl+P），选中的文件开成右栏的文件标签 */
  onFiles: () => void
}) {
  const panel = usePanelTabs()
  const cur = activeTab(panel)
  const curLabel = tabTitle(cur)
  const ws = (state.workspaces ?? []).find((w) => w.id === workspaceId)
  const open = useMemo(() => tasks.filter((t) => t.status !== 'done').length, [tasks])
  /** 每开一次新标签页加一：让它的地址栏拿到焦点 */
  const [newSeq, setNewSeq] = useState(1)
  const strip = useRef<HTMLDivElement>(null)

  const addTab = (): void => {
    updatePanelTabs((s) => addNewTab(s, newTabId()))
    setNewSeq((n) => n + 1)
  }
  const termError = useTerminals().error
  const dirtyFiles = useRightFiles().dirty
  const fileTabs = useMemo(() => panel.tabs.filter((t): t is Extract<PanelTab, { kind: 'file' }> => t.kind === 'file'), [panel.tabs])
  /** 关标签。终端标签：连那个终端一起关掉（要留着它就用「移到底部面板」）；文件标签：有没保存的改动先问 */
  const close = (id: string): void => {
    const t = panel.tabs.find((x) => x.id === id)
    if (t?.kind === 'terminal') void closeTerminal(t.termId)
    else if (t?.kind === 'file') closeFileTab(id)
    else updatePanelTabs((s) => closeTab(s, id, newTabId()))
  }
  /** 新标签页上点了「终端」：在右栏正在看的那个项目的目录里开一个终端，这个新标签页就地变成它的标签 */
  const newTerminal = async (replaceId: string): Promise<void> => {
    const info = await createTerminal({ workspaceId })
    if (info) moveTerminalToRight(info, replaceId)
  }

  // 正在看的标签滚进标签条里看得见的地方
  useEffect(() => {
    strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    // 标题是网页加载完才有的，变长了要再滚一次
  }, [panel.active, panel.tabs.length, curLabel])

  return (
    <div data-right-panel className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-line-soft pr-2 pl-2">
        <div ref={strip} role="tablist" aria-label="右栏" className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
          {panel.tabs.map((t) => {
            const Icon = t.kind === 'tool' ? TAB_ICON[t.id] : t.kind === 'browser' ? Globe : t.kind === 'terminal' ? SquareTerminal : t.kind === 'file' ? FileText : Plus
            const unsaved = t.kind === 'file' && dirtyFiles.has(fileTabKey(t))
            const selected = t.id === cur.id
            const label = tabTitle(t)
            return (
              <div
                key={t.id}
                role="tab"
                tabIndex={0}
                aria-selected={selected}
                data-right-tab={t.kind === 'tool' ? t.id : t.kind}
                data-tab-id={t.id}
                title={t.kind === 'browser' ? `${label}\n${t.url}` : t.kind === 'terminal' ? `终端：${t.cwd}` : t.kind === 'file' ? `${t.path}${unsaved ? '\n有没保存的改动' : ''}` : label}
                onClick={() => updatePanelTabs((s) => activate(s, t.id))}
                onAuxClick={(e) => {
                  // 鼠标中键关标签
                  if (e.button === 1) close(t.id)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    updatePanelTabs((s) => activate(s, t.id))
                  }
                }}
                className={cx(
                  'group flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md pr-1 pl-2.5 text-[12.5px] select-none',
                  selected ? 'bg-hover font-medium text-fg' : 'text-muted hover:text-fg'
                )}
              >
                <Icon size={13} className="shrink-0" />
                <span className={cx('truncate', t.kind === 'browser' || t.kind === 'terminal' || t.kind === 'file' ? 'max-w-[120px]' : '')}>{label}</span>
                {unsaved && <span data-tab-unsaved className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#e3b341]" />}
                {t.kind === 'tool' && t.id === 'tasks' && open > 0 && <span className="rounded-full bg-raised px-1.5 text-[10px] leading-4 text-muted">{open}</span>}
                <button
                  type="button"
                  aria-label={`关闭标签：${label}`}
                  title="关闭标签"
                  data-tab-close
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation()
                    close(t.id)
                  }}
                  className={cx(
                    'inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-faint hover:bg-raised hover:text-fg',
                    selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                  )}
                >
                  <X size={11} />
                </button>
              </div>
            )
          })}
        </div>
        <IconButton title="新标签页" data-right-new onClick={addTab}>
          <Plus size={14} />
        </IconButton>
        <span className="ml-auto" />
        <IconButton title="收起右栏" onClick={onClose}>
          <PanelRightClose size={14} />
        </IconButton>
      </div>
      {cur.kind === 'tool' && cur.id !== 'activity' && (
        <div data-right-scope className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line-soft px-3 text-[11.5px] text-muted" title={ws?.root}>
          {ws?.kind === 'machine' ? <Monitor size={12} className="shrink-0" /> : <FolderOpen size={12} className="shrink-0" />}
          <span className="min-w-0 truncate">{ws ? ws.name : '没有打开项目'}</span>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {cur.kind === 'tool' && cur.id === 'activity' && <ActivityPanel bare state={state} events={events} channel={channel} onOpenFile={onOpenFile} onClose={onClose} />}
        {cur.kind === 'tool' && cur.id === 'changes' && <ChangesTab state={state} ws={ws} />}
        {cur.kind === 'tool' && cur.id === 'tasks' && <TasksTab state={state} ws={ws} tasks={tasks} />}
        {cur.kind === 'newtab' && (
          <NewTabPage
            key={cur.id}
            focusSeq={newSeq}
            onGo={(url) => updatePanelTabs((s) => navigateTab(s, cur.id, url))}
            onTool={(tool) => updatePanelTabs((s) => newTabToTool(s, cur.id, tool))}
            onTerminal={() => void newTerminal(cur.id)}
            onFiles={onFiles}
          />
        )}
        {cur.kind === 'newtab' && termError && (
          <div data-right-terminal-error className="absolute inset-x-0 bottom-0 border-t border-line-soft bg-panel px-3 py-2 text-xs text-bad">
            终端没开成：{termError}
          </div>
        )}
        {/* 终端标签：一个终端一个标签。终端的界面在 lib/terminals.ts 里，翻走再翻回来内容还在 */}
        {cur.kind === 'terminal' && <TerminalTabView key={cur.termId} termId={cur.termId} cwd={cur.cwd} active />}
        {/* 文件标签：有文件标签就一直挂着（翻到别的标签时藏起来），没保存的改动、光标都留着 */}
        {fileTabs.length > 0 && <RightFiles state={state} events={events} tabs={fileTabs} activeId={cur.kind === 'file' ? cur.id : undefined} />}
        {/* 网页标签一直挂着：翻到别的标签再回来，网页还是原来那一页。不显示的用 visibility 藏（display:none 会让 <webview> 重新加载） */}
        {panel.tabs.map((t) =>
          t.kind === 'browser' ? (
            <div key={t.id} className="absolute inset-0 bg-panel" style={t.id === cur.id ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}>
              <BrowserTabView
                id={t.id}
                url={t.url}
                active={t.id === cur.id}
                onChange={(patch) => updatePanelTabs((s) => patchBrowserTab(s, t.id, patch))}
                onNewTab={addTab}
                onClose={() => close(t.id)}
              />
            </div>
          ) : null
        )}
      </div>
    </div>
  )
}

// ========== 变更 ==========

function ChangesTab({ state, ws }: { state: BridgeState; ws?: WorkspaceView }) {
  const focus = useChangeFocus()
  // 点了聊天里的「查看变更」：看那张卡片所在的项目（一般就是右栏正在看的这个）
  const wsId = focus?.workspaceId ?? ws?.id
  const steps = useWorkspaceSteps(wsId)
  const groups = useMemo(() => changeGroups(steps), [steps])
  const pinned = useMemo(() => (focus ? focusGroup(steps, focus.stepIds) : undefined), [steps, focus])
  const canPage = (state.workspaces ?? []).find((w) => w.id === wsId)?.kind !== 'machine'
  const top = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focus) top.current?.scrollTo({ top: 0 })
  }, [focus?.seq]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!wsId) return <EmptyState icon={<GitCompare size={24} />} title="没有打开项目" hint="打开一个项目后，AI 在里面改的文件会列在这里" />
  return (
    <div ref={top} className="h-full overflow-auto">
      {focus && (
        <div data-right-pinned className="border-b border-line">
          <div className="flex h-8 items-center gap-2 px-3 text-[11.5px] font-medium text-fg">
            这条消息的改动
            <span className="ml-auto" />
            <IconButton title="不看这条了" onClick={clearChangeFocus}>
              <X size={13} />
            </IconButton>
          </div>
          {pinned ? (
            <ChangeBlock key={`f${focus.seq}`} state={state} workspaceId={wsId} group={pinned} startOpen canPage={canPage} />
          ) : (
            <div className="px-3 pb-3 text-xs text-muted">{steps.length ? '这次改动太早，记录里已经找不到了。' : '加载中…'}</div>
          )}
        </div>
      )}
      {groups.length === 0 ? (
        !focus && <EmptyState icon={<GitCompare size={24} />} title="还没有改动" hint="AI 在这个项目里改了文件，会按「谁、什么时候、改了哪些文件」列在这里，点开能看差异" />
      ) : (
        <>
          <div className="flex h-8 items-center px-3 text-[11px] font-semibold tracking-wider text-faint uppercase">
            最近的改动
            <span className="ml-auto" />
            {canPage && (
              <button
                className="cursor-pointer text-[11px] font-normal tracking-normal text-muted normal-case hover:text-fg"
                title="到「改动」页：按检查点逐步看、只回滚选中的文件"
                onClick={() => void openChangesPage(wsId)}
              >
                改动页
              </button>
            )}
          </div>
          {groups.map((g) => (
            // key 用第一步：AI 接着改、这次改动多了一步时，已经展开的不会被收回去
            <ChangeBlock key={g.stepIds[0]} state={state} workspaceId={wsId} group={g} canPage={canPage} />
          ))}
        </>
      )}
    </div>
  )
}

/** 到「改动」页看：那一页只能看当前工作区的，所以先把它切成当前工作区 */
async function openChangesPage(workspaceId: string, stepId?: string): Promise<void> {
  const st = await window.bridge.getState()
  if (st.activeWorkspaceId !== workspaceId) {
    await window.bridge.setActiveWorkspace(workspaceId)
    // 换当前工作区会清掉改动页的选中，等它清完再跳
    await new Promise((r) => setTimeout(r, 300))
  }
  navigate({ section: 'changes', id: stepId ? `step:${stepId}` : undefined })
}

const CHANGE_TEXT = { added: '新建', modified: '', deleted: '删除' } as const

/** 一次改动：一行摘要，点开是文件列表；再点文件看差异或全文 */
function ChangeBlock({ state, workspaceId, group, startOpen, canPage }: { state: BridgeState; workspaceId: string; group: ChangeGroup; startOpen?: boolean; canPage: boolean }) {
  const [open, setOpen] = useState(!!startOpen)
  // 从聊天点过来的那一条：直接把第一个文件的差异摊开
  const [file, setFile] = useState<string | undefined>(startOpen ? group.files[0]?.path : undefined)
  const [summary, setSummary] = useState<CheckpointSummaryResult>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string }>()
  const key = group.stepIds.join(',')
  // 展开了才去算净改动；这次改动又多了一步、或被撤销了，重新算
  useEffect(() => {
    if (!open) return
    let live = true
    window.bridge
      .checkpointSummary({ workspaceId, stepIds: group.stepIds })
      .then((s) => {
        if (!live) return
        setSummary(s)
        setError('')
      })
      .catch((e) => live && setError(errText(e)))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId, key, group.rolledBack])

  const undo = async () => {
    setBusy(true)
    setNote(undefined)
    try {
      const r = await window.bridge.rollbackCheckpoints({ workspaceId, stepIds: group.stepIds })
      if (r.status === 'done') setNote({ ok: true, text: `已撤销 ${r.files.length} 个文件` })
      else if (r.status === 'nothing') setNote({ ok: false, text: r.message })
      else setNote({ ok: false, text: `没有撤销：这些文件之后又被改过${canPage ? '，到改动页里处理' : ''}` })
    } catch (e) {
      setNote({ ok: false, text: errText(e) })
    } finally {
      setBusy(false)
    }
  }
  const color = group.agentColor ?? state.agents.find((a) => a.id === group.agentId)?.color ?? '#8b949e'
  return (
    <div data-right-change={group.id} className="border-b border-line-soft">
      <button className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-hover/60" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={12} className="shrink-0 text-faint" /> : <ChevronRight size={12} className="shrink-0 text-faint" />}
        <Avatar name={group.agentName} color={color} size={18} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[12.5px] text-fg">
            <span className="min-w-0 truncate">{group.agentName}</span>
            <span className="shrink-0 text-[11px] text-faint">{timeAgo(group.lastTs)}</span>
          </span>
          <span className="flex items-center gap-1.5 text-[11.5px] text-muted">
            <span className="shrink-0">{group.files.length} 个文件</span>
            <span className="shrink-0 font-mono text-ok">+{group.additions}</span>
            <span className="shrink-0 font-mono text-bad">-{group.deletions}</span>
            {group.rolledBack !== 'none' && <Badge className="px-1.5 text-[10px]">{group.rolledBack === 'all' ? '已撤销' : '部分已撤销'}</Badge>}
          </span>
        </span>
      </button>
      {open && (
        <div className="pb-2">
          {group.files.map((f) => (
            <FileEntry
              key={f.path}
              f={f}
              workspaceId={workspaceId}
              open={file === f.path}
              onToggle={() => setFile((cur) => (cur === f.path ? undefined : f.path))}
              summary={summary}
              error={error}
            />
          ))}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 px-3">
            {group.rolledBack !== 'all' &&
              (busy ? (
                <Loader2 size={13} className="animate-spin text-muted" />
              ) : (
                <ConfirmButton confirmText="确认撤销这些改动" onConfirm={() => void undo()}>
                  撤销
                </ConfirmButton>
              ))}
            {canPage && (
              <Button size="sm" variant="ghost" onClick={() => void openChangesPage(workspaceId, group.id)}>
                在改动页打开
              </Button>
            )}
          </div>
          {note && <div className={cx('mt-1.5 px-3 text-[11.5px]', note.ok ? 'text-ok' : 'text-warn')}>{note.text}</div>}
        </div>
      )}
    </div>
  )
}

function FileEntry({
  f,
  workspaceId,
  open,
  onToggle,
  summary,
  error
}: {
  f: ChangeCardFile
  workspaceId: string
  open: boolean
  onToggle: () => void
  summary?: CheckpointSummaryResult
  error: string
}) {
  const [mode, setMode] = useState<'diff' | 'file'>('diff')
  const net = summary?.files.find((x) => x.path === f.path)
  const name = f.path.split('/').pop() ?? f.path
  const dir = f.path.slice(0, f.path.length - name.length)
  return (
    <div data-right-file-row={f.path}>
      <button className={cx('flex w-full cursor-pointer items-center gap-1.5 py-1 pr-3 pl-8 text-left text-[12px] hover:bg-hover/60', open && 'bg-hover/40')} title={f.path} aria-expanded={open} onClick={onToggle}>
        <span className={cx('min-w-0 flex-1 truncate font-mono text-[11.5px]', f.change === 'deleted' ? 'text-muted line-through' : 'text-fg')}>
          {name}
          {dir && <span className="ml-1.5 text-faint">{dir.replace(/\/$/, '')}</span>}
        </span>
        {CHANGE_TEXT[f.change] && <span className="shrink-0 text-[10px] text-muted">{CHANGE_TEXT[f.change]}</span>}
        <span className="shrink-0 font-mono text-[11px] text-ok">+{f.additions}</span>
        <span className="shrink-0 font-mono text-[11px] text-bad">-{f.deletions}</span>
      </button>
      {open && (
        <div className="px-3 pt-1 pb-2">
          <div className="mb-1.5 flex items-center gap-1">
            {(['diff', 'file'] as const).map((m) => (
              <button
                key={m}
                data-right-mode={m}
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={cx('h-6 cursor-pointer rounded px-2 text-[11px]', mode === m ? 'bg-hover text-fg' : 'text-muted hover:text-fg')}
              >
                {m === 'diff' ? '差异' : '全文'}
              </button>
            ))}
            <span className="ml-auto" />
            {f.change !== 'deleted' && (
              <IconButton title="在编辑器里打开（到「文件」页）" onClick={() => openFile({ workspaceId, path: f.path })}>
                <ExternalLink size={12} />
              </IconButton>
            )}
          </div>
          {mode === 'file' ? (
            <FilePreview workspaceId={workspaceId} path={f.path} />
          ) : error ? (
            <div className="text-[11.5px] text-bad">{error}</div>
          ) : !summary ? (
            <div className="text-[11.5px] text-faint">加载中…</div>
          ) : !net ? (
            <div data-right-diff className="text-[11.5px] text-muted">
              没有净改动：已经撤销，或者改完又改回了原样。
            </div>
          ) : net.binary ? (
            <div data-right-diff className="text-[11.5px] text-muted">
              二进制文件，不显示差异
            </div>
          ) : net.too_large || !net.diff ? (
            <div data-right-diff className="text-[11.5px] text-muted">
              文件太大或快照丢失，不显示差异
            </div>
          ) : (
            <div data-right-diff>
              <DiffView diff={net.diff} maxHeight={380} />
              {net.diff_truncated && <div className="mt-1 text-[11px] text-faint">差异太长，已截断</div>}
              {net.changed_outside && <div className="mt-1 text-[11px] text-warn">这个文件之后又被别的途径改过</div>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 文件现在的内容（只读）。要改到编辑器里改 */
function FilePreview({ workspaceId, path }: { workspaceId: string; path: string }) {
  const [data, setData] = useState<FileContent>()
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setData(undefined)
    setError('')
    window.bridge
      .readFile(workspaceId, path)
      .then((r) => live && setData(r))
      .catch((e) => live && setError(errText(e)))
    return () => {
      live = false
    }
  }, [workspaceId, path])
  if (error || data?.error) return <div data-right-preview className="text-[11.5px] text-muted">读不到这个文件（可能已经删了或挪走了）：{error || data?.error}</div>
  if (!data) return <div className="text-[11.5px] text-faint">加载中…</div>
  if (data.binary) return <div data-right-preview className="text-[11.5px] text-muted">二进制文件，不预览</div>
  if (data.tooLarge || data.content === undefined) return <div data-right-preview className="text-[11.5px] text-muted">文件太大，不预览</div>
  const { lines, more } = previewLines(data.content)
  return (
    <div data-right-preview className="selectable overflow-auto rounded-md border border-line bg-canvas font-mono text-[12px] leading-[1.6]" style={{ maxHeight: 380 }}>
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td className="w-10 px-2 text-right align-top text-faint select-none">{i + 1}</td>
              <td className="pr-3 break-all whitespace-pre-wrap text-fg">{l}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {more > 0 && <div className="px-3 py-2 text-xs text-muted">…还有 {more} 行，到编辑器里看</div>}
    </div>
  )
}

// ========== 任务 ==========

function TasksTab({ state, ws, tasks }: { state: BridgeState; ws?: WorkspaceView; tasks: TaskItem[] }) {
  const { open, done } = useMemo(() => panelTasks(tasks), [tasks])
  const [showDone, setShowDone] = useState(false)
  if (!ws) return <EmptyState icon={<ListTodo size={24} />} title="没有打开项目" />
  const row = (t: TaskItem) => {
    const meta = STATUS_META[t.status]
    const who = t.assigneeId ? state.agents.find((a) => a.id === t.assigneeId) : undefined
    const asks = (t.questions ?? []).filter((q) => q.status === 'open').length
    return (
      <button
        key={t.id}
        data-right-task={t.id}
        className="flex w-full cursor-pointer items-start gap-2 border-b border-line-soft px-3 py-2 text-left hover:bg-hover/60"
        title={t.title}
        onClick={() => navigate({ section: 'overview', id: homeId({ kind: 'task', workspaceId: ws.id, taskId: t.id }) })}
      >
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: meta.color }} />
        <span className="min-w-0 flex-1">
          <span className={cx('block truncate text-[12.5px]', t.status === 'done' ? 'text-muted' : 'text-fg')}>
            <span className="mr-1.5 font-mono text-[11px] text-faint">{t.ref}</span>
            {t.title}
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            <span style={{ color: meta.color }}>{meta.label}</span>
            {who ? (
              <>
                <Avatar name={who.name} color={who.color} size={14} />
                <span className="min-w-0 truncate">{who.name}</span>
              </>
            ) : (
              <span className="text-faint">没人领</span>
            )}
            {asks > 0 && <span className="shrink-0 text-warn">等你回答 {asks}</span>}
            <span className="ml-auto shrink-0 text-faint">{timeAgo(t.updatedAt)}</span>
          </span>
        </span>
      </button>
    )
  }
  return (
    <div className="h-full overflow-auto">
      {open.length === 0 && done.length === 0 ? (
        <EmptyState icon={<ListTodo size={24} />} title="这个项目还没有任务" hint="在左边点「新任务」建一个，或者让 AI 自己拆" />
      ) : (
        <>
          {open.length === 0 && <div className="px-3 py-3 text-xs text-muted">没有在做的任务。</div>}
          {open.map(row)}
          {done.length > 0 && (
            <button data-right-done className="flex h-8 w-full cursor-pointer items-center gap-1 px-3 text-[11.5px] text-muted hover:text-fg" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
              {showDone ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              已完成 {done.length}
            </button>
          )}
          {showDone && done.map(row)}
        </>
      )}
    </div>
  )
}
