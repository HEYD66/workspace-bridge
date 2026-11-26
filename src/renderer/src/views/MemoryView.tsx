import { Archive, ArchiveRestore, Brain, Globe, History, ListTodo, Lock, Pin, Plus, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { GLOBAL_MEMORY_PREFIX, type BridgeState, type MemoryItem } from '../../../shared/api'
import { useContextMenu } from '../components/ContextMenu'
import { Avatar, Badge, Button, ConfirmButton, cx, EmptyState, Field, IconButton, Input, PanelHeader, Segmented, Switch, TextArea } from '../components/ui'
import { WorkspaceTag } from '../components/WorkspaceSwitcher'
import { errText, timeAgo } from '../lib/format'
import { memoryMenu } from '../lib/menus'

type Scope = 'all' | 'global' | 'shared' | 'private' | 'archived'

/** 全局记忆库里的（不属于任何项目）：shared 是所有项目的 AI 都能看的，private 是跟着某个 AI 跨项目的个人笔记 */
const isGlobal = (m: { id: string }): boolean => m.id.startsWith(GLOBAL_MEMORY_PREFIX)

/** 多少天没人用也没人改会自动归档（和 src/core/memory.ts 的 MEMORY_ARCHIVE_DAYS 是同一个数） */
const ARCHIVE_DAYS = 60

export function MemoryList({
  state,
  memories,
  selected,
  onSelect
}: {
  state: BridgeState
  memories: MemoryItem[]
  selected?: string
  onSelect: (id: string) => void
}) {
  const [q, setQ] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [error, setError] = useState('')
  const ctx = useContextMenu()

  /** 记忆卡右键（T-13）：置顶就是按原样保存一遍、只翻 pinned */
  const openMenu = (e: React.MouseEvent, m: MemoryItem): void => {
    const attempt = (p: Promise<unknown>): void => {
      setError('')
      p.catch((err) => setError(errText(err)))
    }
    ctx.open(
      e,
      memoryMenu(m, {
        edit: () => onSelect(m.id),
        copyContent: () => void window.bridge.copy(m.content),
        copyTitle: () => void window.bridge.copy(m.title),
        togglePin: () => attempt(window.bridge.saveMemory({ id: m.id, title: m.title, content: m.content, tags: m.tags, pinned: !m.pinned })),
        toggleArchive: () => attempt(window.bridge.archiveMemory(m.id, !m.archivedAt)),
        remove: () => attempt(window.bridge.deleteMemory(m.id))
      })
    )
  }

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return memories
      // 归档的只在「归档」那一栏里；别的栏都不显示它们
      .filter((m) => (scope === 'archived' ? Boolean(m.archivedAt) : !m.archivedAt))
      .filter((m) => scope === 'all' || scope === 'archived' || (scope === 'global' ? isGlobal(m) : !isGlobal(m) && m.scope === scope))
      .filter((m) => !needle || `${m.title} ${m.content} ${m.tags.join(' ')}`.toLowerCase().includes(needle))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
  }, [memories, q, scope])
  const archivedCount = useMemo(() => memories.filter((m) => m.archivedAt).length, [memories])

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="记忆">
        <WorkspaceTag state={state} />
        <IconButton title="新建共享记忆" onClick={() => onSelect('new')}>
          <Plus size={14} />
        </IconButton>
      </PanelHeader>
      <div className="space-y-2 px-3 pb-2">
        <div className="relative">
          <Search size={13} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
          <Input placeholder="搜索标题、内容、标签" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
        </div>
        <Segmented
          value={scope}
          onChange={setScope}
          options={[
            { value: 'all', label: '全部' },
            { value: 'global', label: '全局' },
            { value: 'shared', label: '共享' },
            { value: 'private', label: 'AI 私有' },
            { value: 'archived', label: archivedCount ? `归档 ${archivedCount}` : '归档' }
          ]}
        />
      </div>
      {error && <div className="px-3 pb-2 text-xs text-bad">{error}</div>}
      <div className="flex-1 overflow-auto pb-4">
        {list.length === 0 && (
          <EmptyState
            icon={<Brain size={24} />}
            title={scope === 'archived' ? '没有归档的记忆' : memories.length ? '没有匹配的记忆' : '还没有记忆'}
            hint={scope === 'archived' ? `${ARCHIVE_DAYS} 天没人用也没人改的记忆会自动放到这里；再被 AI 读到或改到会自己回去` : 'AI 用 memory_save 记下项目约定和进度，新对话能接着用'}
          />
        )}
        {list.map((m) => {
          const owner = m.ownerId ? state.agents.find((a) => a.id === m.ownerId) : undefined
          return (
            <div
              key={m.id}
              data-memory-row={m.id}
              data-memory-archived={m.archivedAt ? 'true' : undefined}
              onClick={() => onSelect(m.id)}
              onContextMenu={(e) => openMenu(e, m)}
              className={cx('mx-1.5 cursor-pointer rounded px-2 py-2 hover:bg-hover', selected === m.id && 'bg-accent/15')}
            >
              <div className="flex items-center gap-1.5">
                {m.pinned && <Pin size={11} className="shrink-0 text-warn" />}
                {isGlobal(m) && <Globe size={11} className="shrink-0 text-accent" />}
                {m.scope === 'private' && <Lock size={11} className="shrink-0 text-faint" />}
                <span className="truncate text-[13px] text-fg">{m.title}</span>
                {m.taskRef && <span className="shrink-0 rounded bg-hover px-1 text-[10px] text-muted">{m.taskRef}</span>}
              </div>
              <div className="mt-0.5 line-clamp-2 text-xs text-muted">{m.content}</div>
              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-faint">
                {owner && <Avatar name={owner.name} color={owner.color} size={12} />}
                <span>{m.updatedByName}</span>
                <span>· {timeAgo(m.updatedAt)}</span>
                {m.useCount ? <span title={m.lastUsedAt ? `AI 最近一次用到：${timeAgo(m.lastUsedAt)}` : undefined}>· 用过 {m.useCount} 次</span> : null}
              </div>
            </div>
          )
        })}
      </div>
      {ctx.menu}
    </div>
  )
}

export function MemoryEditor({ state, memory, onSaved, onDeleted }: { state: BridgeState; memory?: MemoryItem; onSaved: (id: string) => void; onDeleted: () => void }) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState('')
  const [pinned, setPinned] = useState(false)
  /** 新建时：放进全局记忆库 */
  const [global, setGlobal] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    setTitle(memory?.title ?? '')
    setContent(memory?.content ?? '')
    setTags(memory?.tags.join(', ') ?? '')
    setPinned(memory?.pinned ?? false)
    setError('')
  }, [memory?.id, memory?.updatedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  const owner = memory?.ownerId ? state.agents.find((a) => a.id === memory.ownerId) : undefined
  const dirty = !memory || title !== memory.title || content !== memory.content || tags !== memory.tags.join(', ') || pinned !== memory.pinned

  async function save() {
    setError('')
    try {
      const m = await window.bridge.saveMemory({
        id: memory?.id,
        title,
        content,
        tags: tags.split(/[,，\s]+/).filter(Boolean),
        pinned,
        ...(!memory && global ? { global: true } : {})
      })
      onSaved(m.id)
    } catch (e) {
      setError(errText(e))
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <div className="flex items-center gap-2">
        {memory ? (
          <>
            <Badge color={memory.scope === 'shared' ? '#58a6ff' : '#a371f7'}>
              {isGlobal(memory)
                ? memory.scope === 'shared'
                  ? '全局 · 所有项目的 AI 可见'
                  : `个人 · 仅 ${owner?.name ?? '已吊销的 AI'} 可见，跨项目`
                : memory.scope === 'shared'
                  ? '共享 · 这个项目的 AI 可见'
                  : `私有 · 仅 ${owner?.name ?? '已吊销的 AI'} 可见`}
            </Badge>
            {memory.taskRef && (
              <span className="inline-flex items-center gap-1 text-xs text-muted" title="挂在这条任务上：谁认领这条任务都会自动收到它">
                <ListTodo size={12} /> {memory.taskRef}
              </span>
            )}
            <span className="text-xs text-faint">
              {memory.createdByName} 创建 · {memory.updatedByName} {timeAgo(memory.updatedAt)}更新
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button
                data-memory-archive
                title={memory.archivedAt ? '放回去：AI 又能在开场说明和认领任务时收到它' : '归档：不再主动发给 AI，搜索时排在最后。你手动归档的不会自己回来，要点「取消归档」'}
                onClick={() => {
                  setError('')
                  window.bridge.archiveMemory(memory.id, !memory.archivedAt).catch((e) => setError(errText(e)))
                }}
              >
                {memory.archivedAt ? <ArchiveRestore size={12} /> : <Archive size={12} />} {memory.archivedAt ? '取消归档' : '归档'}
              </Button>
              <ConfirmButton confirmText="确认删除？" onConfirm={async () => (await window.bridge.deleteMemory(memory.id), onDeleted())}>
                <Trash2 size={12} /> 删除
              </ConfirmButton>
            </div>
          </>
        ) : (
          <>
            <Badge color="#58a6ff">{global ? '新建全局记忆' : '新建共享记忆'}</Badge>
            <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-muted" title="全局记忆不属于任何项目：所有项目的 AI 都能看到，而且每个 AI 一连上就会收到。适合放你的偏好和通用规范">
              全局（所有项目）
              <Switch data-memory-global aria-label="全局" checked={global} onChange={setGlobal} />
            </label>
          </>
        )}
      </div>
      {memory?.source && <div className="-mt-3 text-xs text-faint">来源：{memory.source}</div>}
      {memory && (memory.archivedAt || memory.useCount) ? (
        <div className="-mt-3 text-xs text-faint" data-memory-usage>
          {memory.archivedAt ? `已归档（${timeAgo(memory.archivedAt)}，${memory.archivedBy === 'user' ? '你手动归档的，不会自己回来' : '太久没人用自动归档的，AI 再读到或改到它会自己回来'}）：不再主动发给 AI。` : ''}
          {memory.useCount ? `AI 用到过 ${memory.useCount} 次${memory.lastUsedAt ? `，最近一次 ${timeAgo(memory.lastUsedAt)}` : ''}` : '还没有 AI 用到过'}
        </div>
      ) : null}
      <Field label="标题">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：代码风格约定、当前进度、部署方式" />
      </Field>
      <Field label="内容" hint={`${content.length} / 8000 字`}>
        <TextArea rows={14} value={content} onChange={(e) => setContent(e.target.value)} className="font-mono text-[12.5px]" />
      </Field>
      <Field label="标签" hint="逗号或空格分隔">
        <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="约定, 进度" />
      </Field>
      <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line-soft bg-panel p-3">
        <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} className="mt-0.5 accent-[#58a6ff]" />
        <span>
          <span className="block text-[13px] text-fg">置顶</span>
          <span className="block text-xs leading-relaxed text-muted">
            {(memory ? isGlobal(memory) && memory.scope === 'shared' : global)
              ? '全局记忆不用置顶：每个 AI 连接时都会收到（合计约 1500 字以内，新的在前）'
              : memory?.scope === 'private'
                ? '这个 AI 连接时会自动收到这条笔记'
                : 'AI 连接时会随说明一起收到。共享记忆的置顶只有你能设，防止某个 AI 往所有 AI 的提示里塞内容'}
          </span>
        </span>
      </label>
      {error && <div className="text-xs text-bad">{error}</div>}
      <Button variant="primary" disabled={!title.trim() || !dirty} onClick={save}>
        {memory ? '保存' : '创建'}
      </Button>
      {memory?.history?.length ? <MemoryHistory memory={memory} onError={setError} /> : null}
    </div>
  )
}

/** 以前的版本：新的在前。点开看那一版的内容，「恢复这一版」把标题、正文、标签换回去（算一次新的修改，现在这版也会留在这里） */
function MemoryHistory({ memory, onError }: { memory: MemoryItem; onError: (text: string) => void }) {
  const [open, setOpen] = useState<number | null>(null)
  const revs = [...(memory.history ?? [])].reverse()
  return (
    <div data-memory-history className="space-y-1.5 border-t border-line-soft pt-4">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <History size={12} /> 以前的版本（{revs.length}）· 现在是第 {memory.version ?? 1} 版
      </div>
      {revs.map((r) => (
        <div key={r.version} data-memory-rev={r.version} className="rounded-md border border-line-soft bg-panel">
          <div className="flex items-center gap-2 px-3 py-2">
            <button type="button" className="min-w-0 flex-1 truncate text-left text-[13px] text-fg hover:underline" onClick={() => setOpen(open === r.version ? null : r.version)}>
              第 {r.version} 版 · {r.title}
            </button>
            <span className="shrink-0 text-[11px] text-faint">
              {r.updatedByName} · {timeAgo(r.updatedAt)}
            </span>
            <span data-memory-restore={r.version}>
            <ConfirmButton
              confirmText="确认恢复？"
              onConfirm={async () => {
                onError('')
                try {
                  await window.bridge.restoreMemory(memory.id, r.version)
                  setOpen(null)
                } catch (e) {
                  onError(errText(e))
                }
              }}
            >
              恢复这一版
            </ConfirmButton>
            </span>
          </div>
          {open === r.version && (
            <pre data-memory-rev-body className="max-h-64 overflow-auto border-t border-line-soft px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-muted">
              {r.content || '（空）'}
              {r.tags.length ? `\n\n标签：${r.tags.join(', ')}` : ''}
            </pre>
          )}
        </div>
      ))}
    </div>
  )
}
